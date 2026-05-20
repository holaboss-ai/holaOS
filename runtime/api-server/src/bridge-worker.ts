import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { runtimeConfigHeaders } from "./runtime-config.js";
import {
  captureRuntimeException,
  extractRuntimeFetchErrorDiagnostics,
  redactRuntimeSentryText,
  redactRuntimeSentryValue,
} from "./runtime-sentry.js";

const TS_BRIDGE_WORKER_FLAG_ENV = "HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER";
const PROACTIVE_ENABLE_REMOTE_BRIDGE_ENV = "PROACTIVE_ENABLE_REMOTE_BRIDGE";
const PROACTIVE_BRIDGE_BASE_URL_ENV = "PROACTIVE_BRIDGE_BASE_URL";
const HOLABOSS_BACKEND_BASE_URL_ENV = "HOLABOSS_BACKEND_BASE_URL";
const PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS_ENV = "PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS";
const PROACTIVE_BRIDGE_MAX_ITEMS_ENV = "PROACTIVE_BRIDGE_MAX_ITEMS";
const PROACTIVE_BRIDGE_SENTRY_TEXT_LIMIT = 400;

type LoggerLike = {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

type StringMap = Record<string, unknown>;

export interface ProactiveBridgeJob {
  job_id: string;
  job_type: string;
  workspace_id: string;
  sandbox_id?: string | null;
  created_at?: string;
  lease_expires_at?: string | null;
  payload: Record<string, unknown>;
}

export interface ProactiveBridgeJobResult {
  job_id: string;
  status: string;
  workspace_id: string;
  job_type: string;
  completed_at?: string;
  output?: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
}

type TaskProposalCreatePayload = {
  workspace_id: string;
  task_name: string;
  task_prompt: string;
  task_generation_rationale: string;
  proposal_source?: string;
  source_event_ids?: string[];
};

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envFlagEnabled(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function envFlagDisabled(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return ["0", "false", "no", "off"].includes(raw);
}

export function bridgeEnabled(): boolean {
  return envFlagEnabled(PROACTIVE_ENABLE_REMOTE_BRIDGE_ENV);
}

export function tsBridgeWorkerEnabled(): boolean {
  if (!bridgeEnabled()) {
    return false;
  }
  if (envFlagDisabled(TS_BRIDGE_WORKER_FLAG_ENV)) {
    return false;
  }
  return true;
}

export function bridgePollIntervalMs(): number {
  const raw = (process.env[PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS_ENV] ?? "").trim();
  if (!raw) {
    return 5000;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return 5000;
  }
  return Math.min(Math.max(parsed, 0.5), 300.0) * 1000;
}

export function bridgeMaxItems(): number {
  const raw = (process.env[PROACTIVE_BRIDGE_MAX_ITEMS_ENV] ?? "").trim();
  if (!raw) {
    return 10;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.min(Math.max(parsed, 1), 100);
}

function isProactiveBridgeJob(value: unknown): value is ProactiveBridgeJob {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.job_id === "string" &&
    typeof value.job_type === "string" &&
    typeof value.workspace_id === "string" &&
    isRecord(value.payload)
  );
}

function isProactiveBridgeJobResult(value: unknown): value is ProactiveBridgeJobResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.job_id === "string" &&
    typeof value.status === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.job_type === "string"
  );
}

export function proactiveBridgeHeaders(): Record<string, string> {
  const headers = runtimeConfigHeaders({ requireAuth: true, requireUser: false });
  if (!headers["X-API-Key"]) {
    throw new Error("Runtime bridge auth token is not configured");
  }
  return headers;
}

function normalizedBaseUrl(name: string): string {
  return (process.env[name] ?? "").trim().replace(/\/+$/, "");
}

function serviceBaseUrlFromHost(baseUrl: string, port: number): string {
  try {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol || "http:";
    const hostname = parsed.hostname;
    if (!hostname) {
      return "";
    }
    return `${protocol}//${hostname}:${port}`;
  } catch {
    return "";
  }
}

export function proactiveBridgeBaseUrl(): string {
  const baseUrl =
    normalizedBaseUrl(PROACTIVE_BRIDGE_BASE_URL_ENV) ||
    serviceBaseUrlFromHost(normalizedBaseUrl(HOLABOSS_BACKEND_BASE_URL_ENV), 3032);
  if (!baseUrl) {
    throw new Error("PROACTIVE_BRIDGE_BASE_URL or HOLABOSS_BACKEND_BASE_URL is required for remote proactive bridge");
  }
  return baseUrl;
}

function nowIso(): string {
  return new Date().toISOString();
}

function invalidPayloadResult(job: ProactiveBridgeJob, jobName: string): ProactiveBridgeJobResult {
  return {
    job_id: job.job_id,
    status: "failed",
    workspace_id: job.workspace_id,
    job_type: job.job_type,
    error_code: "invalid_payload",
    error_message: `${jobName} job received an invalid payload`
  };
}

function unsupportedJobResult(job: ProactiveBridgeJob): ProactiveBridgeJobResult {
  return {
    job_id: job.job_id,
    status: "unsupported",
    workspace_id: job.workspace_id,
    job_type: job.job_type,
    error_code: "unsupported_job_type",
    error_message: `Unsupported bridge job type: ${job.job_type}`
  };
}

function failedJobResult(job: ProactiveBridgeJob, errorCode: string, message: string): ProactiveBridgeJobResult {
  return {
    job_id: job.job_id,
    status: "failed",
    workspace_id: job.workspace_id,
    job_type: job.job_type,
    error_code: errorCode,
    error_message: message
  };
}

function succeededJobResult(job: ProactiveBridgeJob, output: Record<string, unknown>): ProactiveBridgeJobResult {
  return {
    job_id: job.job_id,
    status: "succeeded",
    workspace_id: job.workspace_id,
    job_type: job.job_type,
    completed_at: nowIso(),
    output
  };
}

function requiredStringField(payload: Record<string, unknown>, fieldName: string): string {
  const value = payload[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function optionalStringField(payload: Record<string, unknown>, fieldName: string): string | undefined {
  const value = payload[fieldName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBooleanField(payload: Record<string, unknown>, fieldName: string, defaultValue = false): boolean {
  const value = payload[fieldName];
  return typeof value === "boolean" ? value : defaultValue;
}

function optionalIntegerField(payload: Record<string, unknown>, fieldName: string, defaultValue: number): number {
  const value = payload[fieldName];
  return typeof value === "number" && Number.isInteger(value) ? value : defaultValue;
}

function optionalNumberField(payload: Record<string, unknown>, fieldName: string, defaultValue: number): number {
  const value = payload[fieldName];
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function optionalStringListField(payload: Record<string, unknown>, fieldName: string): string[] {
  const value = payload[fieldName];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function taskProposalPayload(payload: Record<string, unknown>): TaskProposalCreatePayload {
  return {
    workspace_id: requiredStringField(payload, "workspace_id"),
    task_name: requiredStringField(payload, "task_name"),
    task_prompt: requiredStringField(payload, "task_prompt"),
    task_generation_rationale: requiredStringField(payload, "task_generation_rationale"),
    proposal_source: optionalStringField(payload, "proposal_source"),
    source_event_ids: optionalStringListField(payload, "source_event_ids")
  };
}

export async function executeBridgeJobNatively(params: {
  job: ProactiveBridgeJob;
  store: RuntimeStateStore;
}): Promise<ProactiveBridgeJobResult> {
  const { job, store } = params;
  const workspace = store.getWorkspace(job.workspace_id);
  if (!workspace || workspace.deletedAtUtc) {
    return failedJobResult(job, "workspace_not_found", `Workspace '${job.workspace_id}' was not found`);
  }

  try {
    if (job.job_type === "task_proposal.create") {
      const payload = taskProposalPayload(job.payload);
      const proposal = store.createTaskProposal({
        proposalId: job.job_id,
        workspaceId: payload.workspace_id,
        taskName: payload.task_name,
        taskPrompt: payload.task_prompt,
        taskGenerationRationale: payload.task_generation_rationale,
        proposalSource: payload.proposal_source ?? "proactive",
        sourceEventIds: payload.source_event_ids,
        createdAt: nowIso(),
        state: "not_reviewed"
      });
      return succeededJobResult(job, { proposal_id: proposal.proposalId });
    }
  } catch (error) {
    if (error instanceof Error && /is required$/.test(error.message)) {
      return invalidPayloadResult(job, job.job_type);
    }
    return failedJobResult(job, "job_execution_failed", error instanceof Error ? error.message : String(error));
  }

  return unsupportedJobResult(job);
}

export interface BridgeWorkerLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeRemoteBridgeWorkerOptions {
  logger?: LoggerLike;
  executeJob?: (job: ProactiveBridgeJob) => Promise<ProactiveBridgeJobResult>;
  store?: RuntimeStateStore;
  captureRuntimeException?: typeof captureRuntimeException;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxItems?: number;
}

type ProactiveBridgeRequestPhase = "receive_jobs" | "report_result";

class ProactiveBridgeRequestError extends Error {
  readonly phase: ProactiveBridgeRequestPhase;
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly status: number | null;
  readonly responseBody: string | null;
  readonly responseContentType: string | null;

  constructor(params: {
    phase: ProactiveBridgeRequestPhase;
    endpoint: string;
    method: "GET" | "POST";
    status?: number | null;
    responseBody?: string | null;
    responseContentType?: string | null;
    cause?: unknown;
  }) {
    const statusLabel =
      typeof params.status === "number" ? ` with status ${params.status}` : "";
    super(`Proactive bridge request failed during ${params.phase}${statusLabel}`, {
      cause: params.cause,
    });
    this.name = "ProactiveBridgeRequestError";
    this.phase = params.phase;
    this.endpoint = params.endpoint;
    this.method = params.method;
    this.status = typeof params.status === "number" ? params.status : null;
    this.responseBody = params.responseBody ?? null;
    this.responseContentType = params.responseContentType ?? null;
  }
}

function bridgeErrorPhase(
  error: unknown,
): ProactiveBridgeRequestPhase | "execute_job" {
  return error instanceof ProactiveBridgeRequestError
    ? error.phase
    : "execute_job";
}

function bridgeResponsePreview(text: string): {
  text: string;
  truncated: boolean;
} {
  const redacted = redactRuntimeSentryText(text);
  if (redacted.length <= PROACTIVE_BRIDGE_SENTRY_TEXT_LIMIT) {
    return { text: redacted, truncated: false };
  }
  return {
    text: `${redacted.slice(0, PROACTIVE_BRIDGE_SENTRY_TEXT_LIMIT)}…`,
    truncated: true,
  };
}

function bridgeTransportErrorCode(error: unknown): string | null {
  const diagnostics = extractRuntimeFetchErrorDiagnostics(error);
  const causeCode = diagnostics?.cause;
  if (causeCode && typeof causeCode === "object" && !Array.isArray(causeCode)) {
    const code = (causeCode as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }
  const errorCode = diagnostics?.error;
  if (errorCode && typeof errorCode === "object" && !Array.isArray(errorCode)) {
    const code = (errorCode as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }
  return null;
}

export class RuntimeRemoteBridgeWorker implements BridgeWorkerLike {
  readonly #logger: LoggerLike | undefined;
  readonly #executeJob: (job: ProactiveBridgeJob) => Promise<ProactiveBridgeJobResult>;
  readonly #captureRuntimeException: typeof captureRuntimeException;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #pollIntervalMs: number;
  readonly #maxItems: number;
  readonly #headers: Record<string, string>;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;

  constructor(options: RuntimeRemoteBridgeWorkerOptions = {}) {
    this.#logger = options.logger;
    this.#executeJob =
      options.executeJob ??
      (options.store
        ? (job) => executeBridgeJobNatively({ job, store: options.store as RuntimeStateStore })
        : (() => {
            throw new Error("bridge worker requires executeJob or store");
          }));
    this.#captureRuntimeException =
      options.captureRuntimeException ?? captureRuntimeException;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? proactiveBridgeBaseUrl();
    this.#pollIntervalMs = options.pollIntervalMs ?? bridgePollIntervalMs();
    this.#maxItems = options.maxItems ?? bridgeMaxItems();
    this.#headers = proactiveBridgeHeaders();
  }

  async start(): Promise<void> {
    if (this.#task) {
      return;
    }
    this.#stopped = false;
    this.#task = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    const resolve = this.#wakeResolver;
    this.#wakeResolver = null;
    resolve?.();
    const task = this.#task;
    this.#task = null;
    await task;
  }

  async pollOnce(): Promise<number> {
    let jobs: ProactiveBridgeJob[];
    try {
      jobs = await this.#receiveJobs();
    } catch (error) {
      this.#capturePollFailure(error);
      throw error;
    }
    for (const job of jobs) {
      let result: ProactiveBridgeJobResult | null = null;
      try {
        result = await this.#executeJob(job);
        await this.#reportResult(result);
      } catch (error) {
        this.#captureJobFailure(error, job, result);
        this.#logger?.error?.("Remote proactive bridge job failed", {
          event: "runtime.proactive_bridge.job",
          outcome: "error",
          job_id: job.job_id,
          job_type: job.job_type,
          workspace_id: job.workspace_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return jobs.length;
  }

  async #receiveJobs(): Promise<ProactiveBridgeJob[]> {
    const endpoint = `${this.#baseUrl}/api/v1/proactive/bridge/jobs?limit=${this.#maxItems}`;
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "GET",
        headers: this.#headers
      });
    } catch (error) {
      throw new ProactiveBridgeRequestError({
        phase: "receive_jobs",
        endpoint,
        method: "GET",
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ProactiveBridgeRequestError({
        phase: "receive_jobs",
        endpoint,
        method: "GET",
        status: response.status,
        responseBody: await response.text().catch(() => ""),
        responseContentType: response.headers.get("content-type"),
      });
    }
    const payload = await response.json();
    const jobs = isRecord(payload) && Array.isArray(payload.jobs) ? payload.jobs : [];
    return jobs.filter(isProactiveBridgeJob);
  }

  async #reportResult(result: ProactiveBridgeJobResult): Promise<void> {
    const endpoint = `${this.#baseUrl}/api/v1/proactive/bridge/results`;
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          ...this.#headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(result)
      });
    } catch (error) {
      throw new ProactiveBridgeRequestError({
        phase: "report_result",
        endpoint,
        method: "POST",
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ProactiveBridgeRequestError({
        phase: "report_result",
        endpoint,
        method: "POST",
        status: response.status,
        responseBody: await response.text().catch(() => ""),
        responseContentType: response.headers.get("content-type"),
      });
    }
  }

  #capturePollFailure(error: unknown): void {
    const phase = bridgeErrorPhase(error);
    const bridgeError =
      error instanceof ProactiveBridgeRequestError ? error : null;
    const fetchError = extractRuntimeFetchErrorDiagnostics(error);
    const responsePreview =
      bridgeError?.responseBody && bridgeError.responseBody.length > 0
        ? bridgeResponsePreview(bridgeError.responseBody)
        : null;
    const transportErrorCode = bridgeTransportErrorCode(error);
    this.#captureRuntimeException({
      error,
      level: "error",
      fingerprint: [
        "runtime",
        "proactive_bridge",
        "poll_failure",
        phase,
        bridgeError?.status !== null && bridgeError?.status !== undefined
          ? String(bridgeError.status)
          : transportErrorCode ?? "error",
      ],
      tags: {
        surface: "proactive_bridge",
        failure_kind: "poll_failure",
        bridge_phase: phase,
        ...(typeof bridgeError?.status === "number"
          ? { http_status: bridgeError.status }
          : {}),
        ...(transportErrorCode ? { transport_error_code: transportErrorCode } : {}),
      },
      contexts: {
        proactive_bridge: {
          base_url: this.#baseUrl,
          endpoint:
            bridgeError?.endpoint ??
            `${this.#baseUrl}/api/v1/proactive/bridge/jobs?limit=${this.#maxItems}`,
          method: bridgeError?.method ?? "GET",
          poll_interval_ms: this.#pollIntervalMs,
          max_items: this.#maxItems,
        },
      },
      extras: {
        ...(responsePreview
          ? {
              response_body: responsePreview.text,
              response_body_truncated: responsePreview.truncated,
              response_content_type: bridgeError?.responseContentType ?? null,
            }
          : {}),
        ...(fetchError ? { fetch_error: redactRuntimeSentryValue(fetchError) } : {}),
      },
    });
  }

  #captureJobFailure(
    error: unknown,
    job: ProactiveBridgeJob,
    result: ProactiveBridgeJobResult | null,
  ): void {
    const phase = bridgeErrorPhase(error);
    const bridgeError =
      error instanceof ProactiveBridgeRequestError ? error : null;
    const fetchError = extractRuntimeFetchErrorDiagnostics(error);
    const responsePreview =
      bridgeError?.responseBody && bridgeError.responseBody.length > 0
        ? bridgeResponsePreview(bridgeError.responseBody)
        : null;
    const transportErrorCode = bridgeTransportErrorCode(error);
    this.#captureRuntimeException({
      error,
      level: "error",
      fingerprint: [
        "runtime",
        "proactive_bridge",
        "job_failure",
        phase,
        job.job_type,
        bridgeError?.status !== null && bridgeError?.status !== undefined
          ? String(bridgeError.status)
          : transportErrorCode ??
              (phase === "execute_job" ? "execution_error" : "error"),
      ],
      tags: {
        surface: "proactive_bridge",
        failure_kind: "job_failure",
        bridge_phase: phase,
        job_type: job.job_type,
        ...(typeof bridgeError?.status === "number"
          ? { http_status: bridgeError.status }
          : {}),
        ...(transportErrorCode ? { transport_error_code: transportErrorCode } : {}),
      },
      contexts: {
        proactive_bridge: {
          base_url: this.#baseUrl,
          endpoint: bridgeError?.endpoint ?? null,
          method: bridgeError?.method ?? null,
          poll_interval_ms: this.#pollIntervalMs,
          max_items: this.#maxItems,
        },
        proactive_bridge_job: {
          job_id: job.job_id,
          job_type: job.job_type,
          workspace_id: job.workspace_id,
          sandbox_id: job.sandbox_id ?? null,
          result_status: result?.status ?? null,
          result_error_code: result?.error_code ?? null,
          result_has_output: Boolean(result?.output),
        },
      },
      extras: {
        ...(responsePreview
          ? {
              response_body: responsePreview.text,
              response_body_truncated: responsePreview.truncated,
              response_content_type: bridgeError?.responseContentType ?? null,
            }
          : {}),
        ...(fetchError ? { fetch_error: redactRuntimeSentryValue(fetchError) } : {}),
        ...(result
          ? {
              reported_result: redactRuntimeSentryValue({
                status: result.status,
                error_code: result.error_code ?? null,
                error_message: result.error_message ?? null,
                completed_at: result.completed_at ?? null,
                has_output: Boolean(result.output),
              }),
            }
          : {}),
      },
    });
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.#logger?.error?.("Remote proactive bridge poll failed", {
          event: "runtime.proactive_bridge.poll",
          outcome: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (this.#stopped) {
        return;
      }
      await Promise.race([
        sleep(this.#pollIntervalMs),
        new Promise<void>((resolve) => {
          this.#wakeResolver = resolve;
        })
      ]);
      this.#wakeResolver = null;
    }
  }
}
