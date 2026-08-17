import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PostRunJobRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  resolveHarnessModelBudget,
  runtimeConfigModelCatalog,
} from "../../harnesses/src/model-routing.js";
import { resolveRuntimeModelClient } from "./agent-runtime-config.js";
import { buildRunnerEnv } from "./runner-worker.js";

const ESTIMATED_BYTES_PER_TOKEN = 2;

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiCompactionCommandResult {
  compacted: boolean;
  session_file: string;
  result?: Record<string, unknown> | null;
  reason?: string | null;
  diagnostics?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
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
  lastBranchEntryType(sessionFile: string): string | null;
  stripTrailingCompactionEntries(sessionFile: string): number;
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
  lastBranchEntryType: string | null;
  retryAttempted: boolean;
  strippedTrailingCompactions: number;
}

const PI_PACKAGE_ENTRY_PATH = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const PI_SESSION_MANAGER_MODULE_PATH = path.join(
  path.dirname(PI_PACKAGE_ENTRY_PATH),
  "core",
  "session-manager.js",
);
// Loaded as ESM, not via createRequire: see the note in
// claimed-input-executor.ts. pi-agent-core exposes only an `import` condition,
// and tsx's CJS resolver throws ERR_PACKAGE_PATH_NOT_EXPORTED walking to it.
const PI_SESSION_MANAGER_MODULE = (await import(
  pathToFileURL(PI_SESSION_MANAGER_MODULE_PATH).href
)) as {
  SessionManager: PiSessionManagerStatic;
  getLatestCompactionEntry: GetLatestCompactionEntryFn;
};

function loadPiSessionManagerModule(): {
  SessionManager: PiSessionManagerStatic;
  getLatestCompactionEntry: GetLatestCompactionEntryFn;
} {
  return PI_SESSION_MANAGER_MODULE;
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

// Inline base64 image payloads are counted by the model as a small, roughly
// fixed number of vision tokens (a large screenshot is ~1-2k tokens), NOT by
// their raw base64 byte length. Estimating tokens from raw JSON bytes therefore
// over-counts image-heavy sessions by ~20-30x: a session that the model bills at
// ~167k tokens (well inside a 1M window) can estimate at ~4.8M, which trips the
// pre-run overflow gate and — because text compaction can't shrink image bytes —
// escalates to a bogus "session reset required". Discount recognized image
// payloads to a flat allowance so the estimate tracks real model usage.
const INLINE_IMAGE_DATA_MIN_CHARS = 256;
const INLINE_IMAGE_TOKEN_ALLOWANCE = 2_000;

function looksLikeInlineImageData(
  holder: unknown,
  key: string,
  value: string,
): boolean {
  if (value.length <= INLINE_IMAGE_DATA_MIN_CHARS) {
    return false;
  }
  // OpenAI-style data URI (`data:image/png;base64,...`), wherever it appears.
  if (value.startsWith("data:image/")) {
    return true;
  }
  if (key !== "data" || !isRecord(holder)) {
    return false;
  }
  // Content-block shapes carrying raw base64:
  //   { type:'image', data, mimeType }            (pi / harness inline image)
  //   { type:'base64', media_type:'image/…', data } (Anthropic image.source)
  const mimeType = holder.mimeType ?? holder.media_type ?? holder.mediaType;
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) {
    return true;
  }
  const type = holder.type;
  return type === "image" || type === "base64";
}

function estimateJsonTokens(value: unknown): number | null {
  let imageCount = 0;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: unknown, key, rawValue) {
      if (
        typeof rawValue === "string" &&
        looksLikeInlineImageData(this, key, rawValue)
      ) {
        imageCount += 1;
        // Drop the base64 payload from the byte estimate; its cost is added
        // back below as a flat per-image allowance.
        return "";
      }
      return rawValue;
    });
  } catch {
    return null;
  }
  const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
  if ((!Number.isFinite(bytes) || bytes <= 0) && imageCount === 0) {
    return null;
  }
  const textTokens = Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
  return textTokens + imageCount * INLINE_IMAGE_TOKEN_ALLOWANCE;
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

export function normalizePiContextUsage(value: unknown): PiContextUsage | null {
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
  stripTrailingCompactionEntriesFromSessionFile(params.liveSessionFile);
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
  lastBranchEntryType: lastBranchEntryTypeFromSessionFile,
  stripTrailingCompactionEntries: stripTrailingCompactionEntriesFromSessionFile,
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

function stripTrailingCompactionEntriesFromSessionFile(
  sessionFile: string,
): number {
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return 0;
  }
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  let removed = 0;
  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      break;
    }
    if (!isRecord(parsed) || parsed.type !== "compaction") {
      break;
    }
    lines.pop();
    removed += 1;
  }
  if (removed <= 0) {
    return 0;
  }
  const rewritten = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  fs.writeFileSync(sessionFile, rewritten, "utf8");
  return removed;
}

function lastBranchEntryTypeFromSessionFile(sessionFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    return nonEmptyString(parsed.type);
  }
  return null;
}

async function runSnapshotCompactionWithRetry(params: {
  requestPayload: Record<string, unknown>;
  sessionFile: string;
  sessionOps: SessionCheckpointSessionOps;
  runPiSessionCompactionFn: (
    requestPayload: Record<string, unknown>,
  ) => Promise<PiCompactionCommandResult>;
}): Promise<{
  result: PiCompactionCommandResult;
  retryAttempted: boolean;
  strippedTrailingCompactions: number;
}> {
  let result = await params.runPiSessionCompactionFn(params.requestPayload);
  let retryAttempted = false;
  let strippedTrailingCompactions = 0;
  while (!result.compacted && result.reason === "already_compacted") {
    const removed = params.sessionOps.stripTrailingCompactionEntries(
      params.sessionFile,
    );
    if (removed <= 0) {
      break;
    }
    retryAttempted = true;
    strippedTrailingCompactions += removed;
    result = await params.runPiSessionCompactionFn(params.requestPayload);
  }
  return {
    result,
    retryAttempted,
    strippedTrailingCompactions,
  };
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
        const lastBranchEntryType =
          sessionOps.lastBranchEntryType(compactedSessionPath);
        const requestPayload = {
          ...harnessRequest,
          agent_role: "compaction",
          force_compaction: true,
          harness_session_id: compactedSessionPath,
          persisted_harness_session_id: compactedSessionPath,
          timeout_seconds: 0,
        };
        const {
          result,
          retryAttempted,
          strippedTrailingCompactions,
        } = await runSnapshotCompactionWithRetry({
          requestPayload,
          sessionFile: compactedSessionPath,
          sessionOps,
          runPiSessionCompactionFn:
            params.runPiSessionCompactionFn ?? runPiSessionCompaction,
        });
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
            lastBranchEntryType,
            retryAttempted,
            strippedTrailingCompactions,
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
            lastBranchEntryType,
            retryAttempted,
            strippedTrailingCompactions,
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
            lastBranchEntryType,
            retryAttempted,
            strippedTrailingCompactions,
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
            lastBranchEntryType,
            retryAttempted,
            strippedTrailingCompactions,
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
            lastBranchEntryType,
            retryAttempted,
            strippedTrailingCompactions,
          };
        }
        return {
          outcome: "merged_without_boundary",
          merged: true,
          boundaryWritten: false,
          compaction,
          contextUsage,
          effectiveSessionTokens,
          lastBranchEntryType,
          retryAttempted,
          strippedTrailingCompactions,
        };
      } finally {
        maybeDeleteFile(compactedSessionPath);
      }
    },
  );
}
