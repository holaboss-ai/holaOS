import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PostRunJobRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

import type { HarnessCatalogModelEntry } from "../../harnesses/src/model-routing.js";
import { resolveHarnessModelBudget } from "../../harnesses/src/model-routing.js";
import { resolveRuntimeModelClient } from "./agent-runtime-config.js";
import { buildRunnerEnv } from "./runner-worker.js";
import { captureRuntimeException } from "./runtime-sentry.js";

export const SESSION_CHECKPOINT_JOB_TYPE = "session_checkpoint";
const PI_COMPACTION_USAGE_THRESHOLD_RATIO = 0.7;
const SESSION_CHECKPOINT_WAIT_POLL_INTERVAL_MS = 100;
const DEFAULT_PRE_RUN_CONTEXT_WINDOW = 65_536;
const ESTIMATED_BYTES_PER_TOKEN = 2;

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface SessionCheckpointJobPayload {
  harness: string;
  base_harness_session_id: string;
  base_session_fingerprint: string;
  base_leaf_id: string | null;
  base_latest_compaction_id: string | null;
  context_usage: PiContextUsage;
  effective_session_tokens: number | null;
}

export interface PiCompactionCommandResult {
  compacted: boolean;
  session_file: string;
  result?: Record<string, unknown> | null;
  reason?: string | null;
  diagnostics?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

type SessionCheckpointResultOutcome =
  | "skipped_below_threshold"
  | "deferred_busy"
  | "binding_changed"
  | "session_missing"
  | "merge_guard_failed"
  | "not_compacted"
  | "merge_failed"
  | "soft_provider_422"
  | "merged"
  | "merged_without_boundary"
  | "error";

interface SessionCheckpointResultRecord {
  outcome: SessionCheckpointResultOutcome;
  recorded_at: string;
  detail?: string | null;
  reason?: string | null;
  merged?: boolean;
  boundary_written?: boolean;
  compaction?: SessionCheckpointCompactionRecord | null;
}

export interface SessionCheckpointCompactionRecord {
  session_file: string | null;
  reason: string | null;
  diagnostics: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

type ResolveRuntimeModelClientFn = typeof resolveRuntimeModelClient;

interface PiSessionBranchEntry {
  id: string;
  type?: string;
}

interface PiCompactionBranchEntry extends PiSessionBranchEntry {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

interface PiSessionManagerInstance {
  getBranch(): PiSessionBranchEntry[];
  getLeafId(): string | null;
  getEntries(): PiSessionBranchEntry[];
  getSessionFile(): string | undefined;
  buildSessionContext?(): {
    messages?: unknown[];
  };
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string | undefined;
}

interface PiSessionManagerStatic {
  open(sessionFile: string): PiSessionManagerInstance;
}

type GetLatestCompactionEntryFn = (
  branch: PiSessionBranchEntry[],
) => PiCompactionBranchEntry | null | undefined;

export interface SessionCheckpointSessionOps {
  currentLeafCheckpointState(sessionFile: string): {
    leafId: string | null;
    latestCompactionId: string | null;
  };
  canMergeCheckpointIntoLiveSession(params: {
    sessionFile: string;
    baseLeafId: string | null;
    baseLatestCompactionId: string | null;
  }): boolean;
  appendSnapshotCompactionToLiveSession(params: {
    liveSessionFile: string;
    snapshotSessionFile: string;
  }): boolean;
}

export interface PreRunSessionCompactionDecision {
  decision: "fit" | "threshold_exceeded" | "would_overflow" | "reset_required";
  reason: string | null;
  previousSelectedModel: string | null;
  targetSelectedModel: string | null;
  previousContextWindow: number | null;
  targetContextWindow: number | null;
  currentSessionTokens: number | null;
  estimatedRequestTokens: number | null;
  projectedTotalTokens: number | null;
  modelDownshift: boolean;
}

export interface ForceSessionCompactionResult {
  outcome:
    | "not_compacted"
    | "binding_changed"
    | "session_missing"
    | "merge_guard_failed"
    | "merge_failed"
    | "merged_without_boundary";
  detail?: string | null;
  reason?: string | null;
  merged: boolean;
  boundaryWritten: boolean;
  compaction: SessionCheckpointCompactionRecord | null;
  contextUsage: PiContextUsage | null;
  effectiveSessionTokens: number | null;
}

const require = createRequire(import.meta.url);
const PI_PACKAGE_ENTRY_PATH = fileURLToPath(
  import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const PI_SESSION_MANAGER_MODULE_PATH = path.join(
  path.dirname(PI_PACKAGE_ENTRY_PATH),
  "core",
  "session-manager.js",
);
const EMPTY_MODEL_CATALOG = Object.create(null) as Record<
  string,
  Record<string, HarnessCatalogModelEntry>
>;

function loadPiSessionManagerModule(): {
  SessionManager: PiSessionManagerStatic;
  getLatestCompactionEntry: GetLatestCompactionEntryFn;
} {
  return require(PI_SESSION_MANAGER_MODULE_PATH) as {
    SessionManager: PiSessionManagerStatic;
    getLatestCompactionEntry: GetLatestCompactionEntryFn;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function jsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value === undefined ? null : String(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonByteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
  } catch {
    return 0;
  }
}

function estimateJsonTokens(value: unknown): number | null {
  const bytes = jsonByteLength(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

export function maxFiniteNumber(...values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function runtimeRootDir(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function runtimeNodeBin(): string {
  return process.env.HOLABOSS_RUNTIME_NODE_BIN?.trim() || process.execPath;
}

function harnessHostEntryPath(): { entryPath: string; argsPrefix: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const runtimeRoot = runtimeRootDir();
  if (path.extname(currentFile) === ".ts") {
    return {
      entryPath: path.join(runtimeRoot, "harness-host", "src", "index.ts"),
      argsPrefix: ["--import", "tsx"],
    };
  }
  return {
    entryPath: path.join(runtimeRoot, "harness-host", "dist", "index.mjs"),
    argsPrefix: [],
  };
}

function sessionFileFingerprint(sessionFile: string): string {
  return createHash("sha256").update(fs.readFileSync(sessionFile)).digest("hex");
}

function openSessionManager(sessionFile: string): PiSessionManagerInstance {
  return loadPiSessionManagerModule().SessionManager.open(sessionFile);
}

function currentLeafCheckpointState(sessionFile: string): {
  leafId: string | null;
  latestCompactionId: string | null;
} {
  const sessionManager = openSessionManager(sessionFile);
  const branch = sessionManager.getBranch();
  return {
    leafId: sessionManager.getLeafId(),
    latestCompactionId:
      loadPiSessionManagerModule().getLatestCompactionEntry(branch)?.id ?? null,
  };
}

function checkpointSnapshotRuntimeConfig(
  snapshotPayload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return snapshotPayload && isRecord(snapshotPayload.runtime_config)
    ? snapshotPayload.runtime_config
    : null;
}

function checkpointModelProxyProvider(
  snapshotPayload: Record<string, unknown> | null | undefined,
): string | null {
  const runtimeConfig = checkpointSnapshotRuntimeConfig(snapshotPayload);
  const modelClient = runtimeConfig && isRecord(runtimeConfig.model_client)
    ? runtimeConfig.model_client
    : null;
  return nonEmptyString(modelClient?.model_proxy_provider);
}

function selectedModelParts(
  selectedModel: string | null,
): { providerId: string; modelId: string } | null {
  const normalized = nonEmptyString(selectedModel);
  if (!normalized) {
    return null;
  }
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }
  return {
    providerId: normalized.slice(0, slashIndex),
    modelId: normalized.slice(slashIndex + 1),
  };
}

function targetModelContextWindow(params: {
  snapshotPayload: Record<string, unknown> | null;
  selectedModel: string | null;
  fallbackContextWindow?: number | null;
}): number {
  const fallback = finiteNumberOrNull(params.fallbackContextWindow);
  const selectedFromSnapshot = params.snapshotPayload
    ? checkpointSelectedModel({
        snapshotPayload: params.snapshotPayload,
        harnessRequest: isRecord(params.snapshotPayload.harness_request)
          ? params.snapshotPayload.harness_request
          : {},
      })
    : null;
  const selectedParts =
    selectedFromSnapshot ??
    selectedModelParts(params.selectedModel);
  if (selectedParts) {
    const snapshotRuntimeConfig = checkpointSnapshotRuntimeConfig(
      params.snapshotPayload,
    );
    const snapshotHarnessRequest =
      params.snapshotPayload && isRecord(params.snapshotPayload.harness_request)
        ? params.snapshotPayload.harness_request
        : null;
    const runtimeModelClient =
      snapshotRuntimeConfig && isRecord(snapshotRuntimeConfig.model_client)
        ? snapshotRuntimeConfig.model_client
        : null;
    const harnessModelClient =
      snapshotHarnessRequest && isRecord(snapshotHarnessRequest.model_client)
        ? snapshotHarnessRequest.model_client
        : null;
    return resolveHarnessModelBudget(
      {
        provider_id: selectedParts.providerId,
        model_id: selectedParts.modelId,
        model_client: {
          model_proxy_provider:
            nonEmptyString(runtimeModelClient?.model_proxy_provider) ??
            nonEmptyString(harnessModelClient?.model_proxy_provider) ??
            checkpointModelProxyProvider(params.snapshotPayload) ??
            "",
          api_key: "",
          base_url:
            nonEmptyString(runtimeModelClient?.base_url) ??
            nonEmptyString(harnessModelClient?.base_url) ??
            "https://checkpoint.invalid",
          default_headers:
            Object.keys(stringRecord(runtimeModelClient?.default_headers)).length > 0
              ? stringRecord(runtimeModelClient?.default_headers)
              : stringRecord(harnessModelClient?.default_headers),
        },
      },
      {
        modelCatalog: EMPTY_MODEL_CATALOG,
        ...(fallback !== null && fallback > 0
          ? {
              fallbackBudget: {
                contextWindow: fallback,
                maxTokens: 128_000,
              },
            }
          : {}),
      },
    ).contextWindow;
  }
  return fallback !== null && fallback > 0
    ? fallback
    : DEFAULT_PRE_RUN_CONTEXT_WINDOW;
}

export function estimateSessionContextTokens(sessionFile: string): number | null {
  const sessionManager = openSessionManager(sessionFile);
  const sessionContext = sessionManager.buildSessionContext?.();
  const messages = Array.isArray(sessionContext?.messages)
    ? sessionContext.messages
    : null;
  return messages ? estimateJsonTokens(messages) : null;
}

export function effectiveSessionTokenCount(
  values: Array<number | null | undefined>,
): number | null {
  return maxFiniteNumber(...values);
}

function estimateSnapshotRequestTokens(
  snapshotPayload: Record<string, unknown> | null | undefined,
): number | null {
  if (!snapshotPayload || !isRecord(snapshotPayload.harness_request)) {
    return null;
  }
  return estimateJsonTokens(snapshotPayload.harness_request);
}

function normalizePiContextUsage(value: unknown): PiContextUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const tokens =
    typeof value.tokens === "number" && Number.isFinite(value.tokens)
      ? value.tokens
      : null;
  const contextWindow =
    typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow)
      ? value.contextWindow
      : typeof value.context_window === "number" && Number.isFinite(value.context_window)
        ? value.context_window
        : 0;
  const percent =
    typeof value.percent === "number" && Number.isFinite(value.percent)
      ? value.percent
      : null;
  if (contextWindow <= 0) {
    return null;
  }
  return {
    tokens,
    contextWindow,
    percent,
  };
}

export function effectiveSessionTokensFromContextBudgetDecisions(
  value: unknown,
): number | null {
  const decisions = isRecord(value) ? value : null;
  const preRunCompaction =
    decisions && isRecord(decisions.pre_run_compaction)
      ? decisions.pre_run_compaction
      : null;
  return effectiveSessionTokenCount([
    finiteNumberOrNull(decisions?.effective_session_tokens),
    finiteNumberOrNull(preRunCompaction?.after_session_tokens),
    finiteNumberOrNull(preRunCompaction?.before_session_tokens),
    normalizePiContextUsage(decisions?.context_usage)?.tokens,
  ]);
}

export function sessionCheckpointThresholdTokens(
  contextWindow: number,
): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.max(
    0,
    Math.floor(contextWindow * PI_COMPACTION_USAGE_THRESHOLD_RATIO),
  );
}

function recordSessionCheckpointResult(params: {
  store: RuntimeStateStore;
  record: PostRunJobRecord;
  outcome: SessionCheckpointResultOutcome;
  detail?: string | null;
  reason?: string | null;
  merged?: boolean;
  boundaryWritten?: boolean;
  compaction?: SessionCheckpointCompactionRecord | null;
}): void {
  const nextPayload = {
    ...(isRecord(params.record.payload) ? params.record.payload : {}),
    checkpoint_result: {
      outcome: params.outcome,
      recorded_at: new Date().toISOString(),
      detail: params.detail ?? null,
      reason: params.reason ?? null,
      merged:
        params.merged ??
        (params.outcome === "merged" ||
          params.outcome === "merged_without_boundary"),
      boundary_written:
        params.boundaryWritten ?? (params.outcome === "merged"),
      compaction: params.compaction ?? null,
    } satisfies SessionCheckpointResultRecord,
  };
  params.store.updatePostRunJob({
    workspaceId: params.record.workspaceId,
    jobId: params.record.jobId,
    fields: {
      payload: nextPayload,
    },
  });
}

export function shouldQueueSessionCheckpoint(
  contextUsage: PiContextUsage | null,
  effectiveSessionTokens: number | null = finiteNumberOrNull(
    contextUsage?.tokens,
  ),
): boolean {
  if (
    !contextUsage ||
    effectiveSessionTokens == null ||
    !Number.isFinite(effectiveSessionTokens) ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return false;
  }
  const thresholdTokens = sessionCheckpointThresholdTokens(
    contextUsage.contextWindow,
  );
  return thresholdTokens !== null && effectiveSessionTokens > thresholdTokens;
}

export function evaluatePreRunSessionCompaction(params: {
  liveSessionFile: string;
  snapshotPayload: Record<string, unknown> | null;
  selectedModel: string | null;
  previousSelectedModel: string | null;
  previousContextUsage: PiContextUsage | null;
  currentSessionTokensOverride?: number | null;
}): PreRunSessionCompactionDecision {
  const previousContextWindow =
    finiteNumberOrNull(params.previousContextUsage?.contextWindow) ?? null;
  const targetContextWindow = targetModelContextWindow({
    snapshotPayload: params.snapshotPayload,
    selectedModel: params.selectedModel,
    fallbackContextWindow: previousContextWindow,
  });
  const currentSessionTokens =
    finiteNumberOrNull(params.currentSessionTokensOverride) ??
    maxFiniteNumber(
      finiteNumberOrNull(params.previousContextUsage?.tokens),
      estimateSessionContextTokens(params.liveSessionFile),
    );
  const estimatedRequestTokens = estimateSnapshotRequestTokens(params.snapshotPayload);
  const projectedTotalTokens =
    currentSessionTokens !== null && estimatedRequestTokens !== null
      ? currentSessionTokens + estimatedRequestTokens
      : currentSessionTokens;
  const thresholdTokens = sessionCheckpointThresholdTokens(targetContextWindow);
  const modelDownshift =
    previousContextWindow !== null && targetContextWindow < previousContextWindow;
  let decision: PreRunSessionCompactionDecision["decision"] = "fit";
  let reason: string | null = null;
  if (
    projectedTotalTokens !== null &&
    projectedTotalTokens > targetContextWindow
  ) {
    decision = "would_overflow";
    reason = modelDownshift
      ? "model_downshift_projected_overflow"
      : "projected_overflow";
  } else if (
    thresholdTokens !== null &&
    currentSessionTokens !== null &&
    currentSessionTokens > thresholdTokens
  ) {
    decision = "threshold_exceeded";
    reason = modelDownshift
      ? "model_downshift_above_threshold"
      : "above_threshold";
  }
  return {
    decision,
    reason,
    previousSelectedModel: nonEmptyString(params.previousSelectedModel),
    targetSelectedModel: nonEmptyString(params.selectedModel),
    previousContextWindow,
    targetContextWindow,
    currentSessionTokens,
    estimatedRequestTokens,
    projectedTotalTokens,
    modelDownshift,
  };
}

export function listInFlightSessionCheckpointJobs(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): PostRunJobRecord[] {
  return params.store.listPostRunJobs({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    jobType: SESSION_CHECKPOINT_JOB_TYPE,
    statuses: ["QUEUED", "CLAIMED"],
    limit: 100,
    offset: 0,
  });
}

function abortError(): Error {
  const error = new Error("aborted while waiting for session checkpoint");
  error.name = "AbortError";
  return error;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw abortError();
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForSessionCheckpointCompletion(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  wakeWorker?: (() => void) | null;
  renewLease?: (() => void) | null;
  abortSignal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<void> {
  const pollIntervalMs = Math.max(
    10,
    params.pollIntervalMs ?? SESSION_CHECKPOINT_WAIT_POLL_INTERVAL_MS,
  );
  for (;;) {
    const pending = listInFlightSessionCheckpointJobs({
      store: params.store,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    if (pending.length === 0) {
      return;
    }
    params.wakeWorker?.();
    params.renewLease?.();
    await sleepWithAbort(pollIntervalMs, params.abortSignal);
  }
}

export function enqueueSessionCheckpointJob(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  harness: string;
  harnessSessionId: string | null;
  contextUsage: PiContextUsage | null;
  effectiveSessionTokens?: number | null;
  wakeWorker?: (() => void) | null;
  sessionOps?: SessionCheckpointSessionOps;
}): PostRunJobRecord | null {
  const harnessSessionId = nonEmptyString(params.harnessSessionId);
  if (!harnessSessionId) {
    return null;
  }
  if (!fs.existsSync(harnessSessionId)) {
    return null;
  }
  const effectiveSessionTokens = effectiveSessionTokenCount([
    params.effectiveSessionTokens,
    params.contextUsage?.tokens,
    estimateSessionContextTokens(harnessSessionId),
  ]);
  if (
    !shouldQueueSessionCheckpoint(params.contextUsage, effectiveSessionTokens)
  ) {
    return null;
  }
  const checkpointState = (
    params.sessionOps ?? defaultSessionCheckpointSessionOps
  ).currentLeafCheckpointState(harnessSessionId);
  const idempotencyKey = `${SESSION_CHECKPOINT_JOB_TYPE}:${params.sessionId}:${harnessSessionId}:${checkpointState.leafId ?? "root"}`;
  const existing = params.store.getPostRunJobByIdempotencyKey({
    workspaceId: params.workspaceId,
    idempotencyKey,
  });
  if (existing) {
    params.wakeWorker?.();
    return existing;
  }
  const record = params.store.enqueuePostRunJob({
    jobType: SESSION_CHECKPOINT_JOB_TYPE,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    priority: 10,
    idempotencyKey,
    payload: {
      harness: params.harness,
      base_harness_session_id: harnessSessionId,
      base_session_fingerprint: sessionFileFingerprint(harnessSessionId),
      base_leaf_id: checkpointState.leafId,
      base_latest_compaction_id: checkpointState.latestCompactionId,
      context_usage: params.contextUsage,
      effective_session_tokens: effectiveSessionTokens,
    },
  });
  params.wakeWorker?.();
  return record;
}

function decodeSessionCheckpointJobPayload(value: unknown): SessionCheckpointJobPayload {
  const payload = requiredRecord(value, "session checkpoint payload");
  const harness = nonEmptyString(payload.harness);
  const baseHarnessSessionId = nonEmptyString(payload.base_harness_session_id);
  const baseSessionFingerprint = nonEmptyString(payload.base_session_fingerprint);
  const baseLeafId = nonEmptyString(payload.base_leaf_id);
  const baseLatestCompactionId = nonEmptyString(payload.base_latest_compaction_id);
  const contextUsage = normalizePiContextUsage(payload.context_usage);
  const effectiveSessionTokens = effectiveSessionTokenCount([
    finiteNumberOrNull(payload.effective_session_tokens),
    contextUsage?.tokens,
  ]);
  if (!harness || !baseHarnessSessionId || !baseSessionFingerprint || !contextUsage) {
    throw new Error("session checkpoint payload is missing required fields");
  }
  return {
    harness,
    base_harness_session_id: baseHarnessSessionId,
    base_session_fingerprint: baseSessionFingerprint,
    base_leaf_id: baseLeafId,
    base_latest_compaction_id: baseLatestCompactionId,
    context_usage: contextUsage,
    effective_session_tokens: effectiveSessionTokens,
  };
}

function snapshotSessionPath(baseSessionFile: string): string {
  const extension = path.extname(baseSessionFile);
  const basename = extension
    ? path.basename(baseSessionFile, extension)
    : path.basename(baseSessionFile);
  const resolvedExtension = extension || ".jsonl";
  return path.join(
    path.dirname(baseSessionFile),
    `${basename}.checkpoint-${randomUUID()}${resolvedExtension}`,
  );
}

function writeEncodedRequestToChildStdin(
  stdin: NodeJS.WritableStream | null | undefined,
  encodedRequest: string,
  onError: (error: unknown) => void,
): void {
  if (!stdin) {
    return;
  }
  const handleError = (error: unknown) => {
    stdin.removeListener("error", handleError);
    onError(error);
  };
  stdin.once("error", handleError);
  stdin.end(encodedRequest, "utf8", () => {
    stdin.removeListener("error", handleError);
  });
}

async function runPiSessionCompaction(requestPayload: Record<string, unknown>): Promise<PiCompactionCommandResult> {
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  if (!fs.existsSync(entryPath)) {
    throw new Error(`harness-host entrypoint not found: ${entryPath}`);
  }
  const requestBase64 = Buffer.from(JSON.stringify(requestPayload), "utf8").toString("base64");
  const child = spawn(
    runtimeNodeBin(),
    [...argsPrefix, entryPath, "compact-pi-session", "--request-stdin"],
    {
      cwd: runtimeRootDir(),
      env: buildRunnerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let stdinError = "";
  writeEncodedRequestToChildStdin(child.stdin, requestBase64, (error) => {
    if (!stdinError) {
      stdinError = error instanceof Error ? error.message : String(error);
    }
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  const normalizedStderr = [stderr.trim(), stdinError]
    .filter((value) => value.length > 0)
    .join("\n");
  const responseLine = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!responseLine && exitCode !== 0) {
    throw new Error(
      normalizedStderr || `compact-pi-session exited with code ${exitCode}`,
    );
  }
  if (!responseLine) {
    throw new Error("compact-pi-session did not return a result");
  }
  const parsed = JSON.parse(responseLine) as unknown;
  const result = decodePiCompactionCommandResult(parsed);
  if (result.error) {
    const error = new Error(
      nonEmptyString(result.error.message) ??
        (normalizedStderr ||
          `compact-pi-session exited with code ${exitCode || 1}`),
    );
    error.name =
      nonEmptyString(result.error.name) ?? "PiSessionCompactionCommandError";
    Object.assign(error, {
      commandResult: result,
      exitCode,
      stderr: normalizedStderr || null,
    });
    throw error;
  }
  if (exitCode !== 0) {
    const error = new Error(
      normalizedStderr || `compact-pi-session exited with code ${exitCode}`,
    );
    Object.assign(error, {
      commandResult: result,
      exitCode,
      stderr: normalizedStderr || null,
    });
    throw error;
  }
  return result;
}

function decodePiCompactionCommandResult(value: unknown): PiCompactionCommandResult {
  const result = requiredRecord(value, "compact-pi-session response");
  return {
    compacted: Boolean(result.compacted),
    session_file: nonEmptyString(result.session_file) ?? "",
    result: isRecord(result.result) ? result.result : null,
    reason: nonEmptyString(result.reason),
    diagnostics: isRecord(result.diagnostics) ? result.diagnostics : null,
    error: isRecord(result.error) ? result.error : null,
  };
}

function summarizeCheckpointCompactionResult(
  result: PiCompactionCommandResult | null | undefined,
): SessionCheckpointCompactionRecord | null {
  if (!result) {
    return null;
  }
  const compactedResult = isRecord(result.result) ? result.result : null;
  const summary = nonEmptyString(compactedResult?.summary);
  return {
    session_file: nonEmptyString(result.session_file),
    reason: nonEmptyString(result.reason),
    diagnostics: isRecord(result.diagnostics)
      ? (jsonValue(result.diagnostics) as Record<string, unknown>)
      : null,
    result: compactedResult
      ? {
          first_kept_entry_id: nonEmptyString(compactedResult.firstKeptEntryId),
          tokens_before: finiteNumberOrNull(compactedResult.tokensBefore),
          summary_length: summary ? summary.length : null,
          summary_preview: summary ? summary.slice(0, 240) : null,
          details: jsonValue(compactedResult.details),
        }
      : null,
    error: isRecord(result.error)
      ? (jsonValue(result.error) as Record<string, unknown>)
      : null,
  };
}

function compactionResultContextUsage(
  result: PiCompactionCommandResult | null | undefined,
): PiContextUsage | null {
  const diagnostics = result && isRecord(result.diagnostics)
    ? result.diagnostics
    : null;
  return normalizePiContextUsage(diagnostics?.context_usage);
}

function compactionResultFromError(
  error: unknown,
): PiCompactionCommandResult | null {
  if (!isRecord(error) || !isRecord(error.commandResult)) {
    return null;
  }
  return decodePiCompactionCommandResult(error.commandResult);
}

function maybeDeleteFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function softCheckpointProvider422(message: string): boolean {
  if (!/\b422 status code\b/.test(message)) {
    return false;
  }
  return (
    message.includes("Summarization failed:") ||
    message.includes("Turn prefix summarization failed:")
  );
}

function isSoftCheckpointCompactionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return softCheckpointProvider422(message);
}

function canMergeCheckpointIntoLiveSession(params: {
  sessionFile: string;
  baseLeafId: string | null;
  baseLatestCompactionId: string | null;
}): boolean {
  const sessionManager = openSessionManager(params.sessionFile);
  const branch = sessionManager.getBranch();
  if (
    params.baseLeafId &&
    !branch.some((entry: PiSessionBranchEntry) => entry.id === params.baseLeafId)
  ) {
    return false;
  }
  const latestCompactionId =
    loadPiSessionManagerModule().getLatestCompactionEntry(branch)?.id ?? null;
  return latestCompactionId === (params.baseLatestCompactionId ?? null);
}

function appendSnapshotCompactionToLiveSession(params: {
  liveSessionFile: string;
  snapshotSessionFile: string;
}): boolean {
  const liveSession = openSessionManager(params.liveSessionFile);
  const snapshotSession = openSessionManager(params.snapshotSessionFile);
  const snapshotCompaction = loadPiSessionManagerModule().getLatestCompactionEntry(
    snapshotSession.getBranch(),
  );
  if (!snapshotCompaction) {
    return false;
  }
  if (
    !liveSession
      .getBranch()
      .some(
        (entry: PiSessionBranchEntry) =>
          entry.id === snapshotCompaction.firstKeptEntryId,
      )
  ) {
    return false;
  }
  liveSession.appendCompaction(
    snapshotCompaction.summary,
    snapshotCompaction.firstKeptEntryId,
    snapshotCompaction.tokensBefore,
    snapshotCompaction.details,
    snapshotCompaction.fromHook,
  );
  return true;
}

const defaultSessionCheckpointSessionOps: SessionCheckpointSessionOps = {
  currentLeafCheckpointState,
  canMergeCheckpointIntoLiveSession,
  appendSnapshotCompactionToLiveSession,
};

function checkpointSelectedModel(params: {
  snapshotPayload: Record<string, unknown>;
  harnessRequest: Record<string, unknown>;
}): { providerId: string; modelId: string; selectedModel: string } | null {
  const snapshotRuntimeConfig = isRecord(params.snapshotPayload.runtime_config)
    ? params.snapshotPayload.runtime_config
    : {};
  const providerId =
    nonEmptyString(snapshotRuntimeConfig.provider_id) ??
    nonEmptyString(params.harnessRequest.provider_id);
  const modelId =
    nonEmptyString(snapshotRuntimeConfig.model_id) ??
    nonEmptyString(params.harnessRequest.model_id);
  if (!providerId || !modelId) {
    return null;
  }
  const selectedModel =
    nonEmptyString(params.harnessRequest.model) ?? `${providerId}/${modelId}`;
  return {
    providerId,
    modelId,
    selectedModel,
  };
}

function withResolvedCheckpointModelClient(params: {
  snapshotPayload: Record<string, unknown>;
  harnessRequest: Record<string, unknown>;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  resolveRuntimeModelClientFn?: ResolveRuntimeModelClientFn;
}): Record<string, unknown> {
  const selected = checkpointSelectedModel({
    snapshotPayload: params.snapshotPayload,
    harnessRequest: params.harnessRequest,
  });
  if (!selected) {
    return params.harnessRequest;
  }
  const { providerId, modelId, selectedModel } = selected;
  const resolved = (params.resolveRuntimeModelClientFn ?? resolveRuntimeModelClient)(
    {
      selectedModel,
      defaultProviderId: providerId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      inputId: params.inputId,
    },
  );
  const snapshotModelClient = isRecord(params.harnessRequest.model_client)
    ? params.harnessRequest.model_client
    : {};
  const snapshotHeaders = stringRecord(snapshotModelClient.default_headers);
  const resolvedHeaders = stringRecord(resolved.modelClient.default_headers);
  const mergedHeaders = {
    ...snapshotHeaders,
    ...resolvedHeaders,
  };
  if (
    nonEmptyString(resolved.modelClient.api_key) &&
    ("X-API-Key" in snapshotHeaders ||
      "X-API-Key" in resolvedHeaders ||
      nonEmptyString(resolved.modelClient.base_url)?.includes("/model-proxy/"))
  ) {
    mergedHeaders["X-API-Key"] = resolved.modelClient.api_key;
  }
  return {
    ...params.harnessRequest,
    provider_id: resolved.providerId || providerId,
    model_id: resolved.modelId || modelId,
    model_client: {
      ...resolved.modelClient,
      default_headers:
        Object.keys(mergedHeaders).length > 0 ? mergedHeaders : null,
      },
  };
}

const sessionCompactionLocks = new Map<string, Promise<void>>();

async function withSessionCompactionLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = sessionCompactionLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  sessionCompactionLocks.set(
    key,
    prior.then(
      () => current,
      () => current,
    ),
  );
  await prior.catch(() => {});
  try {
    return await operation();
  } finally {
    if (releaseCurrent) {
      releaseCurrent();
    }
    if (sessionCompactionLocks.get(key) === current) {
      sessionCompactionLocks.delete(key);
    }
  }
}

function sessionCompactionLockKey(params: {
  workspaceId: string;
  sessionId: string;
}): string {
  return `${params.workspaceId}:${params.sessionId}`;
}

export async function forceCompactSessionWithSnapshotMerge(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  harnessSessionId: string;
  baseLeafId: string | null;
  baseLatestCompactionId: string | null;
  runPiSessionCompactionFn?: (
    requestPayload: Record<string, unknown>,
  ) => Promise<PiCompactionCommandResult>;
  resolveRuntimeModelClientFn?: ResolveRuntimeModelClientFn;
  sessionOps?: SessionCheckpointSessionOps;
}): Promise<ForceSessionCompactionResult> {
  return await withSessionCompactionLock(
    sessionCompactionLockKey({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    }),
    async () => {
      const sessionOps = params.sessionOps ?? defaultSessionCheckpointSessionOps;
      const snapshot = params.store.getTurnRequestSnapshot({
        workspaceId: params.workspaceId,
        inputId: params.inputId,
      });
      if (!snapshot) {
        throw new Error(`turn request snapshot not found for ${params.inputId}`);
      }
      const snapshotPayload = requiredRecord(
        snapshot.payload,
        "turn request snapshot payload",
      );
      const harnessRequest = withResolvedCheckpointModelClient({
        snapshotPayload,
        harnessRequest: requiredRecord(
          snapshotPayload.harness_request,
          "turn request snapshot harness_request",
        ),
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        inputId: params.inputId,
        resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
      });
      const liveSessionPath = params.harnessSessionId;
      const compactedSessionPath = snapshotSessionPath(liveSessionPath);
      fs.copyFileSync(liveSessionPath, compactedSessionPath);
      try {
        const result = await (params.runPiSessionCompactionFn ?? runPiSessionCompaction)(
          {
            ...harnessRequest,
            force_compaction: true,
            harness_session_id: compactedSessionPath,
            persisted_harness_session_id: compactedSessionPath,
            timeout_seconds: 0,
          },
        );
        const compaction = summarizeCheckpointCompactionResult(result);
        const contextUsage = compactionResultContextUsage(result);
        const effectiveSessionTokens = effectiveSessionTokenCount([
          contextUsage?.tokens,
        ]);
        if (!result.compacted) {
          return {
            outcome: "not_compacted",
            reason: result.reason ?? null,
            merged: false,
            boundaryWritten: false,
            compaction,
            contextUsage,
            effectiveSessionTokens,
          };
        }
        const latestHarnessSessionId =
          params.store.getBinding({
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
          })?.harnessSessionId ?? null;
        if (latestHarnessSessionId !== params.harnessSessionId) {
          return {
            outcome: "binding_changed",
            detail: "live binding changed before checkpoint merge",
            merged: false,
            boundaryWritten: false,
            compaction,
            contextUsage,
            effectiveSessionTokens,
          };
        }
        if (!fs.existsSync(liveSessionPath)) {
          return {
            outcome: "session_missing",
            detail: "live harness session file disappeared before checkpoint merge",
            merged: false,
            boundaryWritten: false,
            compaction,
            contextUsage,
            effectiveSessionTokens,
          };
        }
        if (
          !sessionOps.canMergeCheckpointIntoLiveSession({
            sessionFile: liveSessionPath,
            baseLeafId: params.baseLeafId,
            baseLatestCompactionId: params.baseLatestCompactionId,
          })
        ) {
          return {
            outcome: "merge_guard_failed",
            detail: "live session changed before checkpoint merge",
            merged: false,
            boundaryWritten: false,
            compaction,
            contextUsage,
            effectiveSessionTokens,
          };
        }
        const merged = sessionOps.appendSnapshotCompactionToLiveSession({
          liveSessionFile: liveSessionPath,
          snapshotSessionFile: result.session_file || compactedSessionPath,
        });
        if (!merged) {
          return {
            outcome: "merge_failed",
            detail:
              "snapshot compaction could not be appended to the live session branch",
            merged: false,
            boundaryWritten: false,
            compaction,
            contextUsage,
            effectiveSessionTokens,
          };
        }
        return {
          outcome: "merged_without_boundary",
          merged: true,
          boundaryWritten: false,
          compaction,
          contextUsage,
          effectiveSessionTokens,
        };
      } finally {
        maybeDeleteFile(compactedSessionPath);
      }
    },
  );
}

export async function processSessionCheckpointJob(params: {
  store: RuntimeStateStore;
  record: PostRunJobRecord;
  runPiSessionCompactionFn?: (
    requestPayload: Record<string, unknown>,
  ) => Promise<PiCompactionCommandResult>;
  resolveRuntimeModelClientFn?: ResolveRuntimeModelClientFn;
  sessionOps?: SessionCheckpointSessionOps;
  captureRuntimeExceptionFn?: typeof captureRuntimeException;
}): Promise<void> {
  if (params.record.jobType !== SESSION_CHECKPOINT_JOB_TYPE) {
    throw new Error(`unsupported session checkpoint job type: ${params.record.jobType}`);
  }
  const payload = decodeSessionCheckpointJobPayload(params.record.payload);
  const sessionOps = params.sessionOps ?? defaultSessionCheckpointSessionOps;
  if (
    !shouldQueueSessionCheckpoint(
      payload.context_usage,
      payload.effective_session_tokens,
    )
  ) {
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "skipped_below_threshold",
    });
    return;
  }

  const runtimeState = params.store.getRuntimeState({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
  });
  if (runtimeState?.status === "BUSY") {
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "deferred_busy",
    });
    throw new Error("session is busy; defer checkpoint");
  }

  const currentHarnessSessionId =
    params.store.getBinding({
      workspaceId: params.record.workspaceId,
      sessionId: params.record.sessionId,
    })?.harnessSessionId ?? null;
  if (currentHarnessSessionId !== payload.base_harness_session_id) {
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "binding_changed",
      detail: "live binding no longer matches checkpoint base session",
    });
    return;
  }
  if (!fs.existsSync(payload.base_harness_session_id)) {
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "session_missing",
      detail: "base harness session file no longer exists",
    });
    return;
  }
  if (!sessionOps.canMergeCheckpointIntoLiveSession({
    sessionFile: payload.base_harness_session_id,
    baseLeafId: payload.base_leaf_id,
    baseLatestCompactionId: payload.base_latest_compaction_id,
  })) {
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "merge_guard_failed",
      detail: "live session changed before checkpoint processing began",
    });
    return;
  }

  try {
    const compactionResult = await forceCompactSessionWithSnapshotMerge({
      store: params.store,
      workspaceId: params.record.workspaceId,
      sessionId: params.record.sessionId,
      inputId: params.record.inputId,
      harnessSessionId: payload.base_harness_session_id,
      baseLeafId: payload.base_leaf_id,
      baseLatestCompactionId: payload.base_latest_compaction_id,
      runPiSessionCompactionFn: params.runPiSessionCompactionFn,
      resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
      sessionOps,
    });
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: compactionResult.outcome,
      detail: compactionResult.detail ?? null,
      reason: compactionResult.reason ?? null,
      merged: compactionResult.merged,
      boundaryWritten: compactionResult.boundaryWritten,
      compaction: compactionResult.compaction,
    });
    return;
  } catch (error) {
    const compaction = summarizeCheckpointCompactionResult(
      compactionResultFromError(error),
    );
    (
      params.captureRuntimeExceptionFn ?? captureRuntimeException
    )({
      error,
      level: isSoftCheckpointCompactionError(error) ? "warning" : "error",
      fingerprint: [
        "runtime",
        "session_checkpoint",
        isSoftCheckpointCompactionError(error) ? "soft_provider_422" : "error",
        payload.harness,
      ],
      tags: {
        surface: "session_checkpoint",
        failure_kind: isSoftCheckpointCompactionError(error)
          ? "soft_provider_422"
          : "error",
        harness: payload.harness,
      },
      contexts: {
        session_checkpoint: {
          workspace_id: params.record.workspaceId,
          session_id: params.record.sessionId,
          input_id: params.record.inputId,
          job_id: params.record.jobId,
          harness: payload.harness,
          base_harness_session_id: payload.base_harness_session_id,
          base_leaf_id: payload.base_leaf_id,
          base_latest_compaction_id: payload.base_latest_compaction_id,
        },
      },
      extras: {
        detail: error instanceof Error ? error.message : String(error),
        context_usage: payload.context_usage,
        compaction,
      },
    });
    if (isSoftCheckpointCompactionError(error)) {
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "soft_provider_422",
        detail: error instanceof Error ? error.message : String(error),
        compaction,
      });
      return;
    }
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      compaction,
    });
    throw error;
  }
}

export { normalizePiContextUsage };
