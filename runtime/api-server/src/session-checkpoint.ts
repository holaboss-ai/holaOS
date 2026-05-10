import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PostRunJobRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

import { resolveRuntimeModelClient } from "./agent-runtime-config.js";
import { buildRunnerEnv } from "./runner-worker.js";
import { captureRuntimeException } from "./runtime-sentry.js";

export const SESSION_CHECKPOINT_JOB_TYPE = "session_checkpoint";
const PI_COMPACTION_CONTEXT_RESERVE_RATIO = 0.5;
const SESSION_CHECKPOINT_WAIT_POLL_INTERVAL_MS = 100;

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
}

interface PiCompactionCommandResult {
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

interface SessionCheckpointCompactionRecord {
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

const require = createRequire(import.meta.url);
const PI_PACKAGE_ENTRY_PATH = fileURLToPath(
  import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const PI_SESSION_MANAGER_MODULE_PATH = path.join(
  path.dirname(PI_PACKAGE_ENTRY_PATH),
  "core",
  "session-manager.js",
);

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

export function shouldQueueSessionCheckpoint(contextUsage: PiContextUsage | null): boolean {
  if (
    !contextUsage ||
    contextUsage.tokens == null ||
    !Number.isFinite(contextUsage.tokens) ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return false;
  }
  const reserveTokens = Math.ceil(
    contextUsage.contextWindow * PI_COMPACTION_CONTEXT_RESERVE_RATIO,
  );
  return contextUsage.tokens > contextUsage.contextWindow - reserveTokens;
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
  wakeWorker?: (() => void) | null;
  sessionOps?: SessionCheckpointSessionOps;
}): PostRunJobRecord | null {
  const harnessSessionId = nonEmptyString(params.harnessSessionId);
  if (!harnessSessionId || !shouldQueueSessionCheckpoint(params.contextUsage)) {
    return null;
  }
  if (!fs.existsSync(harnessSessionId)) {
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

async function runPiSessionCompaction(requestPayload: Record<string, unknown>): Promise<PiCompactionCommandResult> {
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  if (!fs.existsSync(entryPath)) {
    throw new Error(`harness-host entrypoint not found: ${entryPath}`);
  }
  const requestBase64 = Buffer.from(JSON.stringify(requestPayload), "utf8").toString("base64");
  const child = spawn(
    runtimeNodeBin(),
    [...argsPrefix, entryPath, "compact-pi-session", "--request-base64", requestBase64],
    {
      cwd: runtimeRootDir(),
      env: buildRunnerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
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
  const responseLine = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!responseLine && exitCode !== 0) {
    throw new Error(stderr.trim() || `compact-pi-session exited with code ${exitCode}`);
  }
  if (!responseLine) {
    throw new Error("compact-pi-session did not return a result");
  }
  const parsed = JSON.parse(responseLine) as unknown;
  const result = decodePiCompactionCommandResult(parsed);
  if (result.error) {
    const error = new Error(
      nonEmptyString(result.error.message) ??
        (stderr.trim() || `compact-pi-session exited with code ${exitCode || 1}`),
    );
    error.name =
      nonEmptyString(result.error.name) ?? "PiSessionCompactionCommandError";
    Object.assign(error, {
      commandResult: result,
      exitCode,
      stderr: stderr.trim() || null,
    });
    throw error;
  }
  if (exitCode !== 0) {
    const error = new Error(stderr.trim() || `compact-pi-session exited with code ${exitCode}`);
    Object.assign(error, {
      commandResult: result,
      exitCode,
      stderr: stderr.trim() || null,
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
  if (!shouldQueueSessionCheckpoint(payload.context_usage)) {
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

  const snapshot = params.store.getTurnRequestSnapshot({
    workspaceId: params.record.workspaceId,
    inputId: params.record.inputId,
  });
  if (!snapshot) {
    throw new Error(`turn request snapshot not found for ${params.record.inputId}`);
  }
  const snapshotPayload = requiredRecord(snapshot.payload, "turn request snapshot payload");
  const harnessRequest = withResolvedCheckpointModelClient({
    snapshotPayload,
    harnessRequest: requiredRecord(
      snapshotPayload.harness_request,
      "turn request snapshot harness_request",
    ),
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
  });
  const liveSessionPath = payload.base_harness_session_id;
  const compactedSessionPath = snapshotSessionPath(liveSessionPath);
  fs.copyFileSync(liveSessionPath, compactedSessionPath);

  try {
    const result = await (params.runPiSessionCompactionFn ?? runPiSessionCompaction)({
      ...harnessRequest,
      harness_session_id: compactedSessionPath,
      persisted_harness_session_id: compactedSessionPath,
      timeout_seconds: 0,
    });
    const compaction = summarizeCheckpointCompactionResult(result);
    if (!result.compacted) {
      maybeDeleteFile(compactedSessionPath);
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "not_compacted",
        reason: result.reason ?? null,
        compaction,
      });
      return;
    }

    const latestHarnessSessionId =
      params.store.getBinding({
        workspaceId: params.record.workspaceId,
        sessionId: params.record.sessionId,
      })?.harnessSessionId ?? null;
    if (latestHarnessSessionId !== payload.base_harness_session_id) {
      maybeDeleteFile(compactedSessionPath);
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "binding_changed",
        detail: "live binding changed before checkpoint merge",
      });
      return;
    }
    if (!fs.existsSync(liveSessionPath)) {
      maybeDeleteFile(compactedSessionPath);
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "session_missing",
        detail: "live harness session file disappeared before checkpoint merge",
      });
      return;
    }
    if (!sessionOps.canMergeCheckpointIntoLiveSession({
      sessionFile: liveSessionPath,
      baseLeafId: payload.base_leaf_id,
      baseLatestCompactionId: payload.base_latest_compaction_id,
    })) {
      maybeDeleteFile(compactedSessionPath);
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "merge_guard_failed",
        detail: "live session changed before checkpoint merge",
      });
      return;
    }
    const merged = sessionOps.appendSnapshotCompactionToLiveSession({
      liveSessionFile: liveSessionPath,
      snapshotSessionFile: result.session_file || compactedSessionPath,
    });
    maybeDeleteFile(compactedSessionPath);
    if (!merged) {
      recordSessionCheckpointResult({
        store: params.store,
        record: params.record,
        outcome: "merge_failed",
        detail: "snapshot compaction could not be appended to the live session branch",
      });
      return;
    }
    recordSessionCheckpointResult({
      store: params.store,
      record: params.record,
      outcome: "merged_without_boundary",
      merged: true,
      boundaryWritten: false,
      compaction,
    });
  } catch (error) {
    maybeDeleteFile(compactedSessionPath);
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
