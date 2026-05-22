import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type {
  OutputRecord,
  RuntimeStateStore,
  SessionInputRecord,
  SubagentRunRecord,
  TurnResultRecord,
  WorkspaceRecord,
} from "@holaboss/runtime-state-store";
import { utcNowIso } from "@holaboss/runtime-state-store";

import {
  buildRunCompletedEvent,
  buildRunFailedEvent,
  executeRunnerRequest,
  type RunnerEvent,
} from "./runner-worker.js";
import type {
  BackendAgentRunEventRequest,
  BackendAgentRunEventType,
  BackendAgentRunStartRequest,
} from "./backend-agent-runs-contract.js";
import { resolveRuntimeModelClient } from "./agent-runtime-config.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";
import {
  normalizeHarnessId,
  resolveRuntimeHarnessAdapter,
  resolveRuntimeHarnessPlugin,
} from "./harness-registry.js";
import {
  captureRuntimeException,
  extractRuntimeFetchErrorDiagnostics,
  redactRuntimeSentryText,
  redactRuntimeSentryValue,
} from "./runtime-sentry.js";
import type { MemoryServiceLike } from "./memory.js";
import { createBackgroundTaskMemoryModelClient } from "./background-task-model.js";
import {
  evaluatePreRunSessionCompaction,
  enqueueSessionCheckpointJob,
  forceCompactSessionWithSnapshotMerge,
  normalizePiContextUsage,
  shouldQueueSessionCheckpoint,
  waitForSessionCheckpointCompletion,
  type PiCompactionCommandResult,
  type PreRunSessionCompactionDecision,
  type PiContextUsage,
  type SessionCheckpointSessionOps,
} from "./session-checkpoint.js";
import type { TurnMemoryWritebackModelContext } from "./turn-memory-writeback.js";
import { runEvolveTasks } from "./evolve-tasks.js";
import { evaluatePendingIntegrationProposals } from "./integration-proposal-gate.js";
import { promoteAcceptedSkillCandidate } from "./evolve-skill-review.js";
import {
  collectWorkspaceFileManifest,
  detectWorkspaceFileOutputs,
  type WorkspaceFileManifest,
} from "./turn-output-capture.js";
import { compactTurnSummary } from "./turn-result-summary.js";
import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";
import {
  persistWorkspaceHarnessSessionId,
  readWorkspaceHarnessSessionId,
} from "./ts-runner-session-state.js";

const ONBOARD_PROMPT_HEADER = "[Holaboss Workspace Onboarding v1]";
const RETRY_CONTINUATION_PROMPT_HEADER = "[Holaboss Retry Continuation v1]";
const RUNTIME_EXEC_CONTEXT_KEY = "_sandbox_runtime_exec_v1";
const RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY = "model_proxy_api_key";
const RUNTIME_EXEC_SANDBOX_ID_KEY = "sandbox_id";
const RUNTIME_EXEC_RUN_ID_KEY = "run_id";
const RUNTIME_EXEC_EPHEMERAL_HARNESS_SESSION_KEY =
  "ephemeral_harness_session";
const DEFAULT_CLAIM_LEASE_SECONDS = 300;
const TERMINAL_OUTPUT_EVENT_TYPES = new Set(["run_completed", "run_failed"]);
const CLAIMED_INPUT_SENTRY_TEXT_LIMIT = 1200;
const CLAIMED_INPUT_SENTRY_EVENT_PREVIEW_LIMIT = 400;
const CLAIMED_INPUT_SENTRY_ARRAY_LIMIT = 10;
const CLAIMED_INPUT_SENTRY_OBJECT_LIMIT = 20;
const CLAIMED_INPUT_SENTRY_RECENT_EVENT_LIMIT = 8;
const CLAIMED_INPUT_SENTRY_PERMISSION_DENIAL_LIMIT = 10;
const BACKEND_OUTPUT_DELTA_RELAY_FLUSH_CHARS = 1200;
const SUBAGENT_EVENT_COALESCE_WINDOW_MS = 5_000;
const SUBAGENT_EVENT_IDLE_TIMEOUT_MS = 5_000;
const MAIN_SESSION_EVENT_RETRY_BASE_DELAY_MS = 5_000;
const MAIN_SESSION_EVENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const CONTEXT_BUDGET_OBSERVABILITY_SCHEMA_VERSION = 1;
const CONTEXT_BUDGET_COMPACTION_EVENT_TYPES = new Set([
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_boundary_written",
  "compaction_end",
  "compaction_restored",
]);
const PI_PACKAGE_ENTRY_PATH = fileURLToPath(
  import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const PI_SESSION_MANAGER_MODULE_PATH = path.join(
  path.dirname(PI_PACKAGE_ENTRY_PATH),
  "core",
  "session-manager.js",
);
const PI_SESSION_DIR_RELATIVE = path.join(".holaboss", "pi-sessions");
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];
const NON_CONTEXT_OVERFLOW_PATTERNS = [
  /throttling error/i,
  /service unavailable/i,
  /rate limit/i,
  /too many requests/i,
];
const PROVIDER_TERMINATION_RECOVERY_MIN_INPUT_TOKENS = 250_000;
const PROVIDER_TERMINATION_RECOVERY_MIN_MODEL_TURNS = 24;
const PROVIDER_TERMINATION_RECOVERY_MIN_TOOL_CALLS = 12;

interface SessionInputAttachment {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

interface RuntimeBindingSentryContextInput {
  authToken: string;
  userId: string;
  sandboxId: string;
  modelProxyBaseUrl: string;
  defaultModel?: string;
  defaultProvider?: string;
}

interface PiSessionBranchEntry {
  id: string;
  type?: string;
  message?: unknown;
}

interface PiSessionManagerInstance {
  getBranch(fromId?: string): PiSessionBranchEntry[];
  getLeafId(): string | null;
  branch(branchFromId: string): void;
  resetLeaf(): void;
  appendMessage(message: Record<string, unknown>): string;
}

interface PiSessionManagerStatic {
  create(cwd: string, sessionDir?: string): PiSessionManagerInstance;
  open(sessionFile: string): PiSessionManagerInstance;
}

interface PiCompactionBranchEntry extends PiSessionBranchEntry {
  id: string;
}

type GetLatestPiCompactionEntryFn = (
  branch: PiSessionBranchEntry[],
) => PiCompactionBranchEntry | null | undefined;

interface EphemeralPiFollowupRunState {
  snapshotDir: string;
  snapshotSessionFile: string;
  liveSessionFile: string | null;
  baseLeafId: string | null;
  baseLatestCompactionId: string | null;
}

interface TurnContextBudgetTelemetry {
  modelTurns: number;
  compactionEvents: number;
  largestToolPayloadBytes: number;
  browserSnapshotBytes: number;
  screenshotBytes: number;
  browserToolCalls: number;
  browserStateReads: number;
  browserCompactStateReads: number;
  browserStandardStateReads: number;
  browserTruncatedStateReads: number;
  browserActionCalls: number;
  browserWaitCalls: number;
  browserFindCalls: number;
  browserScreenshotCalls: number;
  browserPageTextChars: number;
}

interface PreRunCompactionTelemetryRecord {
  initial_decision: PreRunSessionCompactionDecision["decision"];
  final_decision: PreRunSessionCompactionDecision["decision"];
  trigger_reason: string | null;
  previous_selected_model: string | null;
  target_selected_model: string | null;
  previous_context_window: number | null;
  target_context_window: number | null;
  before_session_tokens: number | null;
  after_session_tokens: number | null;
  estimated_request_tokens: number | null;
  projected_total_tokens: number | null;
  compaction_attempted: boolean;
  compaction_changed_branch: boolean;
  reset_required: boolean;
}

interface OverflowRecoveryTelemetryRecord {
  trigger_reason: string | null;
  initial_error_type: string | null;
  initial_error_message: string | null;
  compaction_attempted: boolean;
  compaction_changed_branch: boolean;
  retry_attempted: boolean;
  recovered: boolean;
  reset_required: boolean;
}

interface ProviderTerminationRecoveryTelemetryRecord {
  trigger_reason: string | null;
  initial_error_type: string | null;
  initial_error_message: string | null;
  initial_input_tokens: number | null;
  initial_model_turns: number | null;
  initial_tool_calls: number | null;
  compaction_attempted: boolean;
  compaction_changed_branch: boolean;
  retry_attempted: boolean;
  recovered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSessionInputAttachment(
  value: unknown,
): SessionInputAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mimeType =
    typeof value.mime_type === "string" ? value.mime_type.trim() : "";
  const workspacePath =
    typeof value.workspace_path === "string" ? value.workspace_path.trim() : "";
  const sizeBytes =
    typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes)
      ? value.size_bytes
      : 0;
  const kind =
    value.kind === "image"
      ? "image"
      : value.kind === "folder"
        ? "folder"
        : value.kind === "file"
          ? "file"
          : mimeType.startsWith("image/")
            ? "image"
            : mimeType === "inode/directory"
              ? "folder"
              : "file";
  if (!id || !name || !mimeType || !workspacePath) {
    return null;
  }
  return {
    id,
    kind,
    name,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    workspace_path: workspacePath,
  };
}

function sessionInputAttachments(value: unknown): SessionInputAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => parseSessionInputAttachment(item))
    .filter((item): item is SessionInputAttachment => Boolean(item));
}

function sessionInputImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function defaultInstructionForInputMedia(
  attachments: SessionInputAttachment[],
  imageUrls: readonly string[],
): string {
  if (attachments.length === 0) {
    if (imageUrls.length === 1) {
      return "Review the referenced image.";
    }
    if (imageUrls.length > 1) {
      return "Review the referenced images.";
    }
    return "";
  }
  if (attachments.length === 1) {
    if (imageUrls.length > 0) {
      return attachments[0].kind === "folder"
        ? "Review the attached folder and referenced images."
        : attachments[0].kind === "image"
          ? "Review the attached image and referenced images."
          : "Review the attached file and referenced images.";
    }
    return attachments[0].kind === "image"
      ? "Review the attached image."
      : attachments[0].kind === "folder"
        ? "Review the attached folder."
        : "Review the attached file.";
  }
  if (imageUrls.length > 0) {
    if (attachments.some((attachment) => attachment.kind === "folder")) {
      return "Review the attached files, folders, and referenced images.";
    }
    return "Review the attached files and referenced images.";
  }
  if (attachments.some((attachment) => attachment.kind === "image")) {
    return "Review the attached files, folders, and images.";
  }
  if (attachments.some((attachment) => attachment.kind === "folder")) {
    return "Review the attached files and folders.";
  }
  return "Review the attached files.";
}

function selectedHarness(): string {
  return normalizeHarnessId(process.env.SANDBOX_AGENT_HARNESS);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const require = createRequire(import.meta.url);

function loadPiSessionManagerModule(): {
  SessionManager: PiSessionManagerStatic;
  getLatestCompactionEntry: GetLatestPiCompactionEntryFn;
} {
  return require(PI_SESSION_MANAGER_MODULE_PATH) as {
    SessionManager: PiSessionManagerStatic;
    getLatestCompactionEntry: GetLatestPiCompactionEntryFn;
  };
}

function resolvePiLiveSessionDir(workspaceDir: string): string {
  return path.join(workspaceDir, PI_SESSION_DIR_RELATIVE);
}

function openPiSessionManager(sessionFile: string): PiSessionManagerInstance {
  return loadPiSessionManagerModule().SessionManager.open(sessionFile);
}

function createPiSessionFile(params: {
  workspaceDir: string;
  sessionDir: string;
}): string {
  fs.mkdirSync(params.sessionDir, { recursive: true });
  const sessionManager = loadPiSessionManagerModule().SessionManager.create(
    params.workspaceDir,
    params.sessionDir,
  );
  const sessionFile = nonEmptyString(
    (sessionManager as { getSessionFile?: () => string | undefined })
      .getSessionFile?.(),
  );
  if (!sessionFile) {
    throw new Error("pi session manager did not return a session file");
  }
  return sessionFile;
}

function latestPiCompactionId(branch: PiSessionBranchEntry[]): string | null {
  return loadPiSessionManagerModule().getLatestCompactionEntry(branch)?.id ?? null;
}

function currentPiSessionLeafState(sessionFile: string): {
  leafId: string | null;
  latestCompactionId: string | null;
} {
  const sessionManager = openPiSessionManager(sessionFile);
  const branch = sessionManager.getBranch();
  return {
    leafId: sessionManager.getLeafId(),
    latestCompactionId: latestPiCompactionId(branch),
  };
}

function resolveLivePiSessionFile(params: {
  workspaceDir: string;
  harnessSessionId: string | null;
}): string | null {
  const persistedSessionId = readWorkspaceHarnessSessionId({
    workspaceDir: params.workspaceDir,
    harness: "pi",
  });
  // Main-session followups must stay anchored to the current session binding.
  // The workspace-level pi pointer is only a fallback when the session binding
  // is empty or has not been materialized into a real file yet.
  for (const candidate of [params.harnessSessionId, persistedSessionId]) {
    const resolvedCandidate = nonEmptyString(candidate);
    const resolved = resolvedCandidate ? path.resolve(resolvedCandidate) : null;
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function prepareEphemeralPiFollowupRun(params: {
  workspaceDir: string;
  harnessSessionId: string | null;
}): EphemeralPiFollowupRunState {
  const liveSessionFile = resolveLivePiSessionFile({
    workspaceDir: params.workspaceDir,
    harnessSessionId: params.harnessSessionId,
  });
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-main-session-followup-"),
  );
  const snapshotSessionFile = liveSessionFile
    ? path.join(snapshotDir, path.basename(liveSessionFile))
    : createPiSessionFile({
        workspaceDir: params.workspaceDir,
        sessionDir: snapshotDir,
      });
  if (liveSessionFile) {
    fs.copyFileSync(liveSessionFile, snapshotSessionFile);
  }
  const baseState = liveSessionFile
    ? currentPiSessionLeafState(liveSessionFile)
    : {
        leafId: null,
        latestCompactionId: null,
      };
  return {
    snapshotDir,
    snapshotSessionFile,
    liveSessionFile,
    baseLeafId: baseState.leafId,
    baseLatestCompactionId: baseState.latestCompactionId,
  };
}

function isPiAssistantMessageRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && value.role === "assistant";
}

function latestPiAssistantMessageFromSessionFile(
  sessionFile: string,
): Record<string, unknown> | null {
  const branch = openPiSessionManager(sessionFile).getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "message" && isPiAssistantMessageRecord(entry.message)) {
      return entry.message;
    }
  }
  return null;
}

function assistantMessageFromPiNativeEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const nativeType = nonEmptyString(payload.native_type)?.toLowerCase();
  if (nativeType !== "message_end") {
    return null;
  }
  const nativeEvent = isRecord(payload.native_event) ? payload.native_event : null;
  if (!nativeEvent) {
    return null;
  }
  const message = nativeEvent.message;
  return isPiAssistantMessageRecord(message) ? message : null;
}

function canReanchorPiAssistantMessage(params: {
  sessionFile: string;
  baseLeafId: string | null;
  baseLatestCompactionId: string | null;
}): boolean {
  const sessionManager = openPiSessionManager(params.sessionFile);
  if (sessionManager.getLeafId() !== (params.baseLeafId ?? null)) {
    return false;
  }
  const branch = sessionManager.getBranch();
  return (
    latestPiCompactionId(branch) === (params.baseLatestCompactionId ?? null)
  );
}

function appendPiAssistantMessageAtLeaf(params: {
  sessionFile: string;
  baseLeafId: string | null;
  assistantMessage: Record<string, unknown>;
}): void {
  const sessionManager = openPiSessionManager(params.sessionFile);
  if (params.baseLeafId) {
    sessionManager.branch(params.baseLeafId);
  } else {
    sessionManager.resetLeaf();
  }
  sessionManager.appendMessage(params.assistantMessage);
}

function sanitizeEphemeralHarnessSessionPayload(params: {
  payload: Record<string, unknown>;
  liveSessionFile: string | null;
}): Record<string, unknown> {
  if (!("harness_session_id" in params.payload)) {
    return params.payload;
  }
  const nextPayload = { ...params.payload };
  if (params.liveSessionFile) {
    nextPayload.harness_session_id = params.liveSessionFile;
  } else {
    delete nextPayload.harness_session_id;
  }
  return nextPayload;
}

function claimedInputRunId(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
}): string {
  return `${params.workspaceId}:${params.sessionId}:${params.inputId}`;
}

function canMergeOutputDeltaRelayPayload(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const existingKeys = Object.keys(existing)
    .filter((key) => key !== "delta")
    .sort();
  const nextKeys = Object.keys(next)
    .filter((key) => key !== "delta")
    .sort();
  if (existingKeys.length !== nextKeys.length) {
    return false;
  }
  for (let index = 0; index < existingKeys.length; index += 1) {
    const existingKey = existingKeys[index];
    const nextKey = nextKeys[index];
    if (existingKey !== nextKey) {
      return false;
    }
    if (JSON.stringify(existing[existingKey]) !== JSON.stringify(next[nextKey])) {
      return false;
    }
  }
  return true;
}

function mergeOutputDeltaRelayPayload(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    delta: `${typeof existing.delta === "string" ? existing.delta : ""}${typeof next.delta === "string" ? next.delta : ""}`,
  };
}

function runtimeBindingSentryContext(params: {
  runtimeBinding: RuntimeBindingSentryContextInput;
  runtimeExecContext?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    user_id: nonEmptyString(params.runtimeBinding.userId),
    sandbox_id: nonEmptyString(params.runtimeBinding.sandboxId),
    model_proxy_base_url: nonEmptyString(
      params.runtimeBinding.modelProxyBaseUrl,
    ),
    default_model: nonEmptyString(params.runtimeBinding.defaultModel),
    default_provider: nonEmptyString(params.runtimeBinding.defaultProvider),
    has_auth_token: Boolean(params.runtimeBinding.authToken.trim()),
    exec_sandbox_id: params.runtimeExecContext
      ? nonEmptyString(params.runtimeExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY])
      : null,
    exec_run_id: params.runtimeExecContext
      ? nonEmptyString(params.runtimeExecContext[RUNTIME_EXEC_RUN_ID_KEY])
      : null,
    has_exec_model_proxy_api_key: params.runtimeExecContext
      ? Boolean(
          nonEmptyString(
            params.runtimeExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY],
          ),
        )
      : false,
  };
}

function backendAgentRunsEndpoint(params: {
  workspaceId: string;
  modelProxyBaseUrl: string;
  pathSuffix: "start" | "events";
}): string | null {
  const modelProxyBaseUrl = params.modelProxyBaseUrl.trim();
  if (!modelProxyBaseUrl) {
    return null;
  }
  try {
    const baseUrl = new URL(
      modelProxyBaseUrl.endsWith("/")
        ? modelProxyBaseUrl
        : `${modelProxyBaseUrl}/`,
    );
    const normalizedBasePath = baseUrl.pathname.replace(/\/+$/, "");
    const controlPlaneBasePath = normalizedBasePath.endsWith(
      "/api/v1/model-proxy",
    )
      ? normalizedBasePath.slice(0, -"/api/v1/model-proxy".length)
      : normalizedBasePath;
    baseUrl.pathname = `${controlPlaneBasePath}/api/v1/sandbox/workspaces/${encodeURIComponent(params.workspaceId)}/agent-runs/${params.pathSuffix}`;
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl.toString();
  } catch (error) {
    console.warn(
      `Failed to build backend agent-runs ${params.pathSuffix} endpoint URL`,
      error,
    );
    return null;
  }
}

async function postWorkspaceAgentRunRequest(params: {
  workspaceId: string;
  runtimeBinding: {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
  };
  pathSuffix: "start" | "events";
  body: object;
  fetchImpl?: typeof fetch;
  failureLabel: string;
  runId: string;
  captureRuntimeExceptionFn?: typeof captureRuntimeException;
}): Promise<void> {
  const authToken = params.runtimeBinding.authToken.trim();
  const userId = params.runtimeBinding.userId.trim();
  if (!authToken || !userId) {
    return;
  }

  const endpoint = backendAgentRunsEndpoint({
    workspaceId: params.workspaceId,
    modelProxyBaseUrl: params.runtimeBinding.modelProxyBaseUrl,
    pathSuffix: params.pathSuffix,
  });
  if (!endpoint) {
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": authToken,
    "X-Holaboss-User-Id": userId,
  };
  const sandboxId = params.runtimeBinding.sandboxId.trim();
  if (sandboxId) {
    headers["X-Holaboss-Sandbox-Id"] = sandboxId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const responseBody = sanitizeRuntimeSentryValue(
        await response.text().catch(() => ""),
        "response_body",
        CLAIMED_INPUT_SENTRY_EVENT_PREVIEW_LIMIT,
      );
      (params.captureRuntimeExceptionFn ?? captureRuntimeException)({
        error: new Error(
          `${params.failureLabel} failed with status ${response.status} for run ${params.runId}`,
        ),
        level: "error",
        fingerprint: [
          "runtime",
          "claimed_input",
          `backend_run_${params.pathSuffix}_registration`,
          String(response.status),
        ],
        tags: {
          surface: "claimed_input_executor",
          failure_kind: `backend_run_${params.pathSuffix}_registration`,
          backend_path: params.pathSuffix,
          http_status: response.status,
        },
        contexts: {
          agent_run_registration: {
            workspace_id: params.workspaceId,
            run_id: params.runId,
            path_suffix: params.pathSuffix,
            endpoint,
          },
          runtime_binding: runtimeBindingSentryContext({
            runtimeBinding: params.runtimeBinding,
          }),
        },
        extras: {
          request_body: sanitizeRuntimeSentryValue(params.body),
          response_body: responseBody,
          timeout_ms: 2000,
        },
      });
      console.warn(
        `${params.failureLabel} failed with status ${response.status} for run ${params.runId}`,
      );
    }
  } catch (error) {
    const fetchError = extractRuntimeFetchErrorDiagnostics(error);
    (params.captureRuntimeExceptionFn ?? captureRuntimeException)({
      error,
      level: "error",
      fingerprint: [
        "runtime",
        "claimed_input",
        `backend_run_${params.pathSuffix}_registration`,
        "fetch_error",
      ],
      tags: {
        surface: "claimed_input_executor",
        failure_kind: `backend_run_${params.pathSuffix}_registration`,
        backend_path: params.pathSuffix,
      },
      contexts: {
        agent_run_registration: {
          workspace_id: params.workspaceId,
          run_id: params.runId,
          path_suffix: params.pathSuffix,
          endpoint,
        },
        runtime_binding: runtimeBindingSentryContext({
          runtimeBinding: params.runtimeBinding,
        }),
      },
      extras: {
        request_body: sanitizeRuntimeSentryValue(params.body),
        timeout_ms: 2000,
        ...(fetchError ? { fetch_error: sanitizeRuntimeSentryValue(fetchError) } : {}),
      },
    });
    console.warn(
      `${params.failureLabel} failed for run ${params.runId}`,
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function registerWorkspaceAgentRunStarted(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  runId: string;
  selectedModel: string | null;
  runtimeBinding: {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
  };
  fetchImpl?: typeof fetch;
  captureRuntimeExceptionFn?: typeof captureRuntimeException;
}): Promise<void> {
  const requestBody: BackendAgentRunStartRequest = {
    session_id: params.sessionId,
    input_id: params.inputId,
    run_id: params.runId,
    model: params.selectedModel ?? undefined,
  };
  await postWorkspaceAgentRunRequest({
    workspaceId: params.workspaceId,
    runtimeBinding: params.runtimeBinding,
    pathSuffix: "start",
    body: requestBody,
    fetchImpl: params.fetchImpl,
    failureLabel: "Backend run-start registration",
    runId: params.runId,
    captureRuntimeExceptionFn: params.captureRuntimeExceptionFn,
  });
}

async function registerWorkspaceAgentRunEvent(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  runId: string;
  sequence: number;
  eventType: BackendAgentRunEventType;
  payload: Record<string, unknown>;
  timestamp: string;
  runtimeBinding: {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
  };
  fetchImpl?: typeof fetch;
  captureRuntimeExceptionFn?: typeof captureRuntimeException;
}): Promise<void> {
  const requestBody: BackendAgentRunEventRequest = {
    session_id: params.sessionId,
    input_id: params.inputId,
    run_id: params.runId,
    sequence: params.sequence,
    event_type: params.eventType,
    payload: params.payload,
    timestamp: params.timestamp,
  };
  await postWorkspaceAgentRunRequest({
    workspaceId: params.workspaceId,
    runtimeBinding: params.runtimeBinding,
    pathSuffix: "events",
    body: requestBody,
    fetchImpl: params.fetchImpl,
    failureLabel: "Backend run-event registration",
    runId: params.runId,
    captureRuntimeExceptionFn: params.captureRuntimeExceptionFn,
  });
}

export { registerWorkspaceAgentRunEvent, registerWorkspaceAgentRunStarted };

function writebackModelContext(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  instruction: string;
  model: unknown;
  runtimeBinding: {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
    defaultModel: string;
    defaultProvider: string;
  };
  runtimeExecContext: Record<string, unknown>;
}): TurnMemoryWritebackModelContext | null {
  const modelClient = createBackgroundTaskMemoryModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    selectedModel:
      typeof params.model === "string"
        ? params.model
        : params.runtimeBinding.defaultModel,
    defaultProviderId: params.runtimeBinding.defaultProvider,
    runtimeExecModelProxyApiKey:
      typeof params.runtimeExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY] ===
      "string"
        ? params.runtimeExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY]
        : params.runtimeBinding.authToken,
    runtimeExecSandboxId:
      typeof params.runtimeExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY] === "string"
        ? params.runtimeExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY]
        : params.runtimeBinding.sandboxId,
    runtimeExecRunId: nonEmptyString(
      params.runtimeExecContext[RUNTIME_EXEC_RUN_ID_KEY],
    ),
  });
  if (!modelClient) {
    return null;
  }
  return {
    modelClient,
    instruction: params.instruction,
  };
}

function ensureLocalBinding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  harness: string;
}): string {
  const existing = params.store.getBinding({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
  if (existing && existing.harnessSessionId.trim()) {
    return existing.harnessSessionId;
  }
  const binding = params.store.upsertBinding({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    harness: params.harness,
    harnessSessionId: params.sessionId,
  });
  return binding.harnessSessionId;
}

function snapshotSafeDefaultHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!headers) {
    return null;
  }
  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      if (!value.trim()) {
        return false;
      }
      return !/^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(
        key,
      );
    }),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function snapshotSafeHeaderRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const stringHeaders = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return snapshotSafeDefaultHeaders(stringHeaders);
}

function snapshotFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshotFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function bestEffortModelReference(params: {
  selectedModel: string | null;
  defaultProviderId: string;
}): { providerId: string; modelId: string } | null {
  const selectedModel = nonEmptyString(params.selectedModel);
  if (!selectedModel) {
    return null;
  }
  const slashIndex = selectedModel.indexOf("/");
  if (slashIndex > 0 && slashIndex < selectedModel.length - 1) {
    return {
      providerId: selectedModel.slice(0, slashIndex),
      modelId: selectedModel.slice(slashIndex + 1),
    };
  }
  const fallbackProviderId = nonEmptyString(params.defaultProviderId);
  if (!fallbackProviderId) {
    return null;
  }
  return {
    providerId: fallbackProviderId,
    modelId: selectedModel,
  };
}

function syntheticWorkspaceConfigChecksum(params: {
  workspaceId: string;
  sessionId: string;
  harness: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace_id: params.workspaceId,
        session_id: params.sessionId,
        harness_id: params.harness,
        synthetic: true,
      }),
    )
    .digest("hex");
}

function reusableTurnRequestSnapshotTemplate(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  harness: string;
}): {
  snapshotPayload: Record<string, unknown>;
  harnessRequest: Record<string, unknown>;
  runtimeConfig: Record<string, unknown> | null;
} | null {
  const snapshots = params.store.listTurnRequestSnapshots({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    limit: 100,
  });
  for (const snapshot of snapshots) {
    if (snapshot.inputId === params.inputId) {
      continue;
    }
    const payload = isRecord(snapshot.payload) ? snapshot.payload : null;
    if (!payload) {
      continue;
    }
    const harnessId = nonEmptyString(payload.harness_id);
    if (harnessId && harnessId !== params.harness) {
      continue;
    }
    const harnessRequest = isRecord(payload.harness_request)
      ? payload.harness_request
      : null;
    if (!harnessRequest) {
      continue;
    }
    if (!nonEmptyString(harnessRequest.workspace_dir)) {
      continue;
    }
    if (snapshotFiniteNumber(harnessRequest.timeout_seconds) === null) {
      continue;
    }
    if (!nonEmptyString(harnessRequest.workspace_config_checksum)) {
      continue;
    }
    if (!isRecord(harnessRequest.model_client)) {
      continue;
    }
    return {
      snapshotPayload: structuredClone(payload),
      harnessRequest: structuredClone(harnessRequest),
      runtimeConfig: isRecord(payload.runtime_config)
        ? structuredClone(payload.runtime_config)
        : null,
    };
  }
  return null;
}

function snapshotModelClientConfig(params: {
  template: Record<string, unknown> | null;
  modelProxyProvider: string | null;
  baseUrl: string | null;
  defaultHeaders: Record<string, string> | null;
}): Record<string, unknown> {
  const template = params.template;
  const templateProvider = nonEmptyString(template?.model_proxy_provider);
  const templateApiKey = nonEmptyString(template?.api_key) ?? "[redacted]";
  const templateBaseUrl = nonEmptyString(template?.base_url);
  const templateHeaders = snapshotSafeHeaderRecord(template?.default_headers);
  return {
    ...(template ?? {}),
    model_proxy_provider: params.modelProxyProvider ?? templateProvider ?? null,
    api_key: templateApiKey,
    base_url: params.baseUrl ?? templateBaseUrl ?? null,
    default_headers: params.defaultHeaders ?? templateHeaders,
  };
}

function ensureClaimedInputTurnRequestSnapshot(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  sessionKind: string;
  harness: string;
  workspaceDir: string;
  instruction: string;
  attachments: SessionInputAttachment[];
  imageUrls: string[];
  runtimeContext: Record<string, unknown>;
  selectedModel: string | null;
  harnessTimeoutSeconds: number | null;
  runtimeBinding: {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
    defaultModel: string;
    defaultProvider: string;
  };
  runtimeExecContext: Record<string, unknown>;
  resolveRuntimeModelClientFn?: typeof resolveRuntimeModelClient;
}): string | null {
  const existing = params.store.getTurnRequestSnapshot({
    workspaceId: params.record.workspaceId,
    inputId: params.record.inputId,
  });
  if (existing?.fingerprint) {
    return existing.fingerprint;
  }

  const effectiveSelectedModel =
    nonEmptyString(params.selectedModel) ??
    nonEmptyString(params.runtimeBinding.defaultModel);
  const reusableTemplate = reusableTurnRequestSnapshotTemplate({
    store: params.store,
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    harness: params.harness,
  });
  const fallbackModelReference = bestEffortModelReference({
    selectedModel: effectiveSelectedModel,
    defaultProviderId: params.runtimeBinding.defaultProvider,
  });
  const syntheticConfigChecksum = syntheticWorkspaceConfigChecksum({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    harness: params.harness,
  });

  let providerId = fallbackModelReference?.providerId ?? "";
  let modelId = fallbackModelReference?.modelId ?? "";
  let modelProxyProvider: string | null = null;
  let modelClientBaseUrl: string | null = null;
  let modelClientHeaders: Record<string, string> | null = null;

  if (effectiveSelectedModel) {
    try {
      const resolved = (
        params.resolveRuntimeModelClientFn ?? resolveRuntimeModelClient
      )({
        selectedModel: effectiveSelectedModel,
        defaultProviderId:
          nonEmptyString(params.runtimeBinding.defaultProvider) ?? providerId,
        workspaceId: params.record.workspaceId,
        sessionId: params.record.sessionId,
        inputId: params.record.inputId,
        runtimeExecModelProxyApiKey:
          typeof params.runtimeExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY] ===
          "string"
            ? params.runtimeExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY]
            : params.runtimeBinding.authToken,
        runtimeExecSandboxId:
          typeof params.runtimeExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY] ===
          "string"
            ? params.runtimeExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY]
            : params.runtimeBinding.sandboxId,
        runtimeExecRunId: nonEmptyString(
          params.runtimeExecContext[RUNTIME_EXEC_RUN_ID_KEY],
        ),
      });
      providerId = nonEmptyString(resolved.providerId) ?? providerId;
      modelId = nonEmptyString(resolved.modelId) ?? modelId;
      modelProxyProvider =
        nonEmptyString(resolved.modelProxyProvider) ??
        resolved.modelClient.model_proxy_provider;
      modelClientBaseUrl = nonEmptyString(resolved.modelClient.base_url) ?? null;
      modelClientHeaders = snapshotSafeDefaultHeaders(
        resolved.modelClient.default_headers ?? null,
      );
    } catch {
      // Keep the best-effort model reference and persist a minimal snapshot.
    }
  }

  if (!providerId || !modelId) {
    return null;
  }

  const templateHarnessRequest = reusableTemplate?.harnessRequest ?? null;
  const templateRuntimeConfig = reusableTemplate?.runtimeConfig ?? null;
  const templateModelClient = isRecord(templateHarnessRequest?.model_client)
    ? templateHarnessRequest.model_client
    : isRecord(templateRuntimeConfig?.model_client)
      ? templateRuntimeConfig.model_client
      : null;
  const templateTimeoutSeconds = snapshotFiniteNumber(
    templateHarnessRequest?.timeout_seconds,
  );
  const workspaceConfigChecksum =
    nonEmptyString(templateHarnessRequest?.workspace_config_checksum) ??
    nonEmptyString(templateRuntimeConfig?.workspace_config_checksum) ??
    syntheticConfigChecksum;
  const modelClient = snapshotModelClientConfig({
    template: templateModelClient,
    modelProxyProvider,
    baseUrl: modelClientBaseUrl,
    defaultHeaders: modelClientHeaders,
  });
  const harnessRequest: Record<string, unknown> = templateHarnessRequest
    ? {
        ...templateHarnessRequest,
        workspace_id: params.record.workspaceId,
        workspace_dir:
          nonEmptyString(templateHarnessRequest.workspace_dir) ??
          params.workspaceDir,
        session_id: params.record.sessionId,
        input_id: params.record.inputId,
        instruction: params.instruction,
        attachments: params.attachments,
        image_urls: params.imageUrls,
        thinking_value: params.record.payload.thinking_value ?? null,
        debug: false,
        provider_id: providerId,
        model_id: modelId,
        timeout_seconds:
          params.harnessTimeoutSeconds ?? templateTimeoutSeconds ?? 0,
        workspace_config_checksum: workspaceConfigChecksum,
        model_client: modelClient,
      }
    : {
        workspace_id: params.record.workspaceId,
        workspace_dir: params.workspaceDir,
        session_id: params.record.sessionId,
        browser_tools_enabled: false,
        browser_space: null,
        input_id: params.record.inputId,
        instruction: params.instruction,
        context_messages: [],
        tools: {},
        attachments: params.attachments,
        image_urls: params.imageUrls,
        thinking_value: params.record.payload.thinking_value ?? null,
        debug: false,
        harness_session_id: null,
        persisted_harness_session_id: null,
        provider_id: providerId,
        model_id: modelId,
        timeout_seconds: params.harnessTimeoutSeconds ?? 0,
        runtime_api_base_url: null,
        system_prompt: "",
        workspace_skill_dirs: [],
        mcp_servers: [],
        mcp_tool_refs: [],
        workspace_config_checksum: workspaceConfigChecksum,
        run_started_payload: null,
        model_client: modelClient,
      };
  const runtimeConfig: Record<string, unknown> = templateRuntimeConfig
    ? {
        ...templateRuntimeConfig,
        provider_id: providerId,
        model_id: modelId,
        workspace_config_checksum: workspaceConfigChecksum,
        model_client: modelClient,
      }
    : {
        provider_id: providerId,
        model_id: modelId,
        mode: null,
        system_prompt: "",
        context_messages: [],
        prompt_sections: [],
        prompt_layers: [],
        prompt_cache_profile: null,
        tools: {},
        workspace_tool_ids: [],
        workspace_skill_ids: [],
        output_schema_member_id: null,
        output_format: null,
        workspace_config_checksum: workspaceConfigChecksum,
        capability_manifest: null,
        model_client: {
          model_proxy_provider: modelProxyProvider,
          base_url: modelClientBaseUrl,
          default_headers: modelClientHeaders,
        },
      };
  const snapshotPayload: Record<string, unknown> = {
    schema_version: 1,
    snapshot_kind: "harness_host_request",
    workspace_id: params.record.workspaceId,
    session_id: params.record.sessionId,
    input_id: params.record.inputId,
    harness_id: params.harness,
    raw_instruction: params.instruction,
    attachments: params.attachments,
    image_urls: params.imageUrls,
    runtime_config: runtimeConfig,
    harness_request: harnessRequest,
  };
  const fingerprint = snapshotFingerprint(snapshotPayload);
  params.store.upsertTurnRequestSnapshot({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    snapshotKind: "harness_host_request",
    fingerprint,
    payload: snapshotPayload,
  });
  return fingerprint;
}

function buildOnboardingInstruction(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  text: string;
  attachments: SessionInputAttachment[];
  imageUrls: string[];
  workspace: WorkspaceRecord;
}): string {
  const trimmed =
    params.text.trim() ||
    defaultInstructionForInputMedia(params.attachments, params.imageUrls);
  if (!trimmed) {
    throw new Error("text, attachments, or image_urls are required");
  }
  const onboardingStatus = (params.workspace.onboardingStatus ?? "")
    .trim()
    .toLowerCase();
  const onboardingSessionId = (
    params.workspace.onboardingSessionId ?? ""
  ).trim();
  if (
    !["pending", "awaiting_confirmation"].includes(onboardingStatus) ||
    onboardingSessionId !== params.sessionId
  ) {
    return trimmed;
  }

  const onboardPath = path.join(
    params.workspaceRoot,
    params.workspaceId,
    "ONBOARD.md",
  );
  if (!fs.existsSync(onboardPath)) {
    return trimmed;
  }
  const rawOnboardPrompt = fs.readFileSync(onboardPath, "utf8").trim();
  if (!rawOnboardPrompt || trimmed.startsWith(ONBOARD_PROMPT_HEADER)) {
    return trimmed;
  }

  return [
    ONBOARD_PROMPT_HEADER,
    "- You are in onboarding mode for this workspace.",
    `- The workspace directory is ./${params.workspaceId} relative to the current working directory.`,
    `- The onboarding guide file is ./${params.workspaceId}/ONBOARD.md (absolute path: ${onboardPath}).`,
    "- Use that workspace-scoped ONBOARD.md to drive the conversation and gather required details.",
    "- ONBOARD.md content is already included below; do not re-read it unless needed.",
    `- If file reads are needed, use ./${params.workspaceId}/... paths rather than files directly under ${params.workspaceRoot}.`,
    "- Ask concise questions and collect durable facts/preferences.",
    "- Do not start regular execution work until onboarding is complete.",
    "- Relevant native onboarding tools:",
    "- `onboarding_status` reads the local onboarding status for this workspace.",
    "- `holaboss_onboarding_complete` marks onboarding complete. Required argument: `summary`. Optional argument: `requested_by`.",
    "- When all onboarding requirements are satisfied and the user confirms, call `holaboss_onboarding_complete` with a concise durable summary.",
    "",
    "[ONBOARD.md]",
    rawOnboardPrompt,
    "[/ONBOARD.md]",
    "",
    trimmed,
  ]
    .join("\n")
    .trim();
}

function queuedMainSessionEventsFromContext(
  context: Record<string, unknown> | null | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(context?.queued_events)) {
    return [];
  }
  return context.queued_events
    .filter((value): value is Record<string, unknown> => isRecord(value))
    .map((value) => queuedMainSessionEventPromptEntry(value));
}

function instructionWithInlineBackgroundUpdates(params: {
  baseInstruction: string;
  context: Record<string, unknown> | null | undefined;
}): string {
  const source = optionalString(params.context?.source)?.toLowerCase();
  if (source === "main_session_event_batch") {
    return params.baseInstruction;
  }
  const deliveryBucket = optionalString(params.context?.delivery_bucket)?.toLowerCase();
  if (deliveryBucket !== "background_update") {
    return params.baseInstruction;
  }
  const events = queuedMainSessionEventsFromContext(params.context);
  if (events.length === 0) {
    return params.baseInstruction;
  }

  return [
    params.baseInstruction,
    "",
    "[Pending Background Updates]",
    "These background task updates belong to the same main session.",
    "Answer the user's latest message first.",
    "If any of these updates are relevant, add them after your direct answer as a natural continuation.",
    "If there is only one relevant update, weave it in without a `Background updates` heading.",
    "Do not introduce the added update with stock phrases like `Quick follow-up`, `Brief update`, or `One quick update` unless the user already used that tone.",
    "Only use a separate `Background updates` section when there are multiple distinct updates or the separation is needed for clarity.",
    "If there are multiple updates, use numbered items and keep each task distinct instead of blending them into one paragraph.",
    "When a queued update includes deliverables, refer to them by title and treat them as attached artifacts or reports rather than raw file paths when possible.",
    "Do not paste long artifact bodies such as HTML, markdown, or full report content into chat. Keep those as attached deliverables and only summarize them briefly.",
    "If the updates are not directly relevant, append a brief natural continuation at the end instead of sounding like a system notification.",
    JSON.stringify(events, null, 2),
    "[/Pending Background Updates]",
  ]
    .join("\n")
    .trim();
}

function instructionWithRetryContinuationPrompt(params: {
  baseInstruction: string;
  failureMessage?: string | null;
}): string {
  if (params.baseInstruction.includes(RETRY_CONTINUATION_PROMPT_HEADER)) {
    return params.baseInstruction;
  }
  const lines = [
    params.baseInstruction,
    "",
    RETRY_CONTINUATION_PROMPT_HEADER,
    "- The previous attempt ended after partial progress and this is a continuation retry.",
    "- Do not start over from scratch.",
    "- First inspect the current workspace and session state to determine what already completed.",
    "- Reuse existing files, installs, outputs, and running state when they are still valid.",
    "- Only repeat a step if inspection shows it is missing, inconsistent, or broken.",
    "- After inspection, continue the task from the current state and finish the remaining work.",
  ];
  const failureMessage =
    typeof params.failureMessage === "string" ? params.failureMessage.trim() : "";
  if (failureMessage) {
    lines.push(`- Previous failure signal: ${failureMessage}`);
  }
  return lines.join("\n").trim();
}

function queuedForwardedDeliverablesFromContext(
  context: Record<string, unknown> | null | undefined,
): Array<{
  eventId: string | null;
  subagentId: string | null;
  deliverable: Record<string, unknown>;
}> {
  const entries: Array<{
    eventId: string | null;
    subagentId: string | null;
    deliverable: Record<string, unknown>;
  }> = [];
  for (const event of queuedMainSessionEventsFromContext(context)) {
    const payload = isRecord(event.payload) ? event.payload : null;
    if (!payload) {
      continue;
    }
    for (const key of ["forwardable_deliverables", "partial_deliverables"]) {
      const deliverables = Array.isArray(payload[key]) ? payload[key] : [];
      for (const value of deliverables) {
        if (!isRecord(value)) {
          continue;
        }
        entries.push({
          eventId: optionalString(event.event_id) ?? null,
          subagentId:
            optionalString(event.subagent_id) ??
            optionalString(payload.subagent_id) ??
            null,
          deliverable: value,
        });
      }
    }
  }
  return entries;
}

function outputTypeForForwardedDeliverable(
  deliverable: Record<string, unknown>,
): string {
  const outputType = optionalString(deliverable.output_type);
  if (outputType) {
    return outputType;
  }
  const artifactType = optionalString(deliverable.type)?.toLowerCase() ?? "";
  switch (artifactType) {
    case "image":
      return "file";
    case "html":
      return "html";
    case "draft":
      return "post";
    case "document":
    case "report":
    default:
      return "document";
  }
}

function forwardedDeliverableDedupeKey(
  deliverable: Record<string, unknown>,
): string | null {
  const artifactId = optionalString(deliverable.artifact_id);
  const outputId = optionalString(deliverable.output_id);
  const filePath = optionalString(deliverable.file_path);
  const title = optionalString(deliverable.title);
  if (artifactId) {
    return `artifact:${artifactId}`;
  }
  if (outputId) {
    return `output:${outputId}`;
  }
  if (filePath) {
    return `path:${filePath}`;
  }
  if (title) {
    return `title:${title}`;
  }
  return null;
}

function materializeQueuedBackgroundDeliverablesForTurn(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  context: Record<string, unknown> | null | undefined;
}): void {
  const deliverables = queuedForwardedDeliverablesFromContext(params.context);
  if (deliverables.length === 0) {
    return;
  }
  const existingKeys = new Set(
    params.store
      .listOutputs({
        workspaceId: params.record.workspaceId,
        sessionId: params.record.sessionId,
        inputId: params.record.inputId,
        limit: 1000,
        offset: 0,
      })
      .flatMap((output) => {
        const keys: string[] = [];
        if (output.artifactId) {
          keys.push(`artifact:${output.artifactId}`);
        }
        if (output.filePath) {
          keys.push(`path:${output.filePath}`);
        }
        if (output.title) {
          keys.push(`title:${output.title}`);
        }
        return keys;
      }),
  );
  for (const entry of deliverables) {
    const dedupeKey = forwardedDeliverableDedupeKey(entry.deliverable);
    if (dedupeKey && existingKeys.has(dedupeKey)) {
      continue;
    }
    const metadata = isRecord(entry.deliverable.metadata)
      ? entry.deliverable.metadata
      : {};
    const filePath = optionalString(entry.deliverable.file_path) ?? null;
    const title =
      optionalString(entry.deliverable.title) ??
      (filePath ? path.basename(filePath) : "Forwarded artifact");
    params.store.createOutput({
      workspaceId: params.record.workspaceId,
      outputType: outputTypeForForwardedDeliverable(entry.deliverable),
      title,
      status: optionalString(entry.deliverable.status) ?? "completed",
      moduleId: optionalString(entry.deliverable.module_id) ?? null,
      moduleResourceId:
        optionalString(entry.deliverable.module_resource_id) ?? null,
      filePath,
      sessionId: params.record.sessionId,
      inputId: params.record.inputId,
      artifactId: optionalString(entry.deliverable.artifact_id) ?? null,
      platform: optionalString(entry.deliverable.platform) ?? null,
      metadata: {
        ...metadata,
        origin_type: "forwarded_subagent",
        owner_container_type: "background_update",
        owner_container_input_id: params.record.inputId,
        owner_container_session_id: params.record.sessionId,
        change_type: optionalString(metadata.change_type) ?? "created",
        artifact_type:
          optionalString(entry.deliverable.type) ??
          optionalString(metadata.artifact_type) ??
          outputTypeForForwardedDeliverable(entry.deliverable),
        forwarded_output_id:
          optionalString(entry.deliverable.output_id) ?? null,
        source_subagent_id: entry.subagentId,
        source_event_id: entry.eventId,
      },
    });
    if (dedupeKey) {
      existingKeys.add(dedupeKey);
    }
  }
}

function createdAtForEvent(event: RunnerEvent): string | undefined {
  return typeof event.timestamp === "string" && event.timestamp.trim()
    ? event.timestamp
    : undefined;
}

function inferSessionKind(params: {
  workspace: WorkspaceRecord;
  sessionId: string;
  persistedKind?: string | null;
}): string {
  const persistedKind =
    typeof params.persistedKind === "string" ? params.persistedKind.trim() : "";
  if (persistedKind) {
    return persistedKind;
  }
  const sessionId = params.sessionId.trim();
  const onboardingSessionId = (
    params.workspace.onboardingSessionId ?? ""
  ).trim();
  const onboardingStatus = (params.workspace.onboardingStatus ?? "")
    .trim()
    .toLowerCase();
  if (
    sessionId &&
    sessionId === onboardingSessionId &&
    ["pending", "awaiting_confirmation", "in_progress"].includes(
      onboardingStatus,
    )
  ) {
    return "onboarding";
  }
  return "main_session";
}

function payloadForEvent(event: RunnerEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function truncateRuntimeSentryText(text: string, limit: number): string {
  const redacted = redactRuntimeSentryText(text);
  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, limit)}...[truncated ${redacted.length - limit} chars]`;
}

function sanitizeRuntimeSentryValue(
  value: unknown,
  keyName = "",
  textLimit = CLAIMED_INPUT_SENTRY_TEXT_LIMIT,
): unknown {
  const redacted = redactRuntimeSentryValue(value, keyName);
  if (typeof redacted === "string") {
    return truncateRuntimeSentryText(redacted, textLimit);
  }
  if (Array.isArray(redacted)) {
    const items = redacted
      .slice(0, CLAIMED_INPUT_SENTRY_ARRAY_LIMIT)
      .map((entry) => sanitizeRuntimeSentryValue(entry, "", textLimit));
    if (redacted.length > CLAIMED_INPUT_SENTRY_ARRAY_LIMIT) {
      items.push(
        `[truncated ${redacted.length - CLAIMED_INPUT_SENTRY_ARRAY_LIMIT} items]`,
      );
    }
    return items;
  }
  if (isRecord(redacted)) {
    const entries = Object.entries(redacted);
    const limitedEntries = entries
      .slice(0, CLAIMED_INPUT_SENTRY_OBJECT_LIMIT)
      .map(([key, entry]) => [
        key,
        sanitizeRuntimeSentryValue(entry, key, textLimit),
      ]);
    if (entries.length > CLAIMED_INPUT_SENTRY_OBJECT_LIMIT) {
      limitedEntries.push([
        "truncated_entries",
        entries.length - CLAIMED_INPUT_SENTRY_OBJECT_LIMIT,
      ]);
    }
    return Object.fromEntries(limitedEntries);
  }
  return redacted;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function eventTimestampOrNow(event: RunnerEvent): string {
  return createdAtForEvent(event) ?? new Date().toISOString();
}

function orderedAssistantMessageTimestamp(
  turnStartedAt: string,
  completedAt: string | null,
): string {
  const startedAtMs = Date.parse(turnStartedAt);
  const completedAtMs = Date.parse(completedAt ?? "");
  if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)) {
    return new Date(Math.max(startedAtMs + 1, completedAtMs)).toISOString();
  }
  if (Number.isFinite(startedAtMs)) {
    return new Date(startedAtMs + 1).toISOString();
  }
  if (Number.isFinite(completedAtMs)) {
    return new Date(completedAtMs).toISOString();
  }
  return new Date().toISOString();
}

function tokenUsageFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct = jsonRecord(payload.token_usage);
  if (direct) {
    return direct;
  }
  return jsonRecord(payload.usage);
}

function contextUsageFromPayload(
  payload: Record<string, unknown>,
): PiContextUsage | null {
  return normalizePiContextUsage(payload.context_usage);
}

function createTurnContextBudgetTelemetry(): TurnContextBudgetTelemetry {
  return {
    modelTurns: 0,
    compactionEvents: 0,
    largestToolPayloadBytes: 0,
    browserSnapshotBytes: 0,
    screenshotBytes: 0,
    browserToolCalls: 0,
    browserStateReads: 0,
    browserCompactStateReads: 0,
    browserStandardStateReads: 0,
    browserTruncatedStateReads: 0,
    browserActionCalls: 0,
    browserWaitCalls: 0,
    browserFindCalls: 0,
    browserScreenshotCalls: 0,
    browserPageTextChars: 0,
  };
}

function finiteNumber(value: unknown): number | null {
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

function nestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  return value && isRecord(value[key])
    ? (value[key] as Record<string, unknown>)
    : null;
}

function firstFiniteUsageNumber(
  usage: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!usage) {
    return null;
  }
  for (const key of keys) {
    const direct = finiteNumber(usage[key]);
    if (direct !== null) {
      return direct;
    }
  }
  return null;
}

function browserCapabilityPayloadFromToolResult(
  value: unknown,
): Record<string, unknown> | null {
  const resultRecord = jsonRecord(value);
  const details = nestedRecord(resultRecord, "details");
  const raw = nestedRecord(details, "raw");
  if (raw) {
    return raw;
  }
  const content = Array.isArray(resultRecord?.content) ? resultRecord.content : [];
  for (const block of content) {
    const blockRecord = jsonRecord(block);
    if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(blockRecord.text);
      const record = jsonRecord(parsed);
      if (record) {
        return record;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function browserUsageFromToolResult(
  value: unknown,
): Record<string, unknown> | null {
  return nestedRecord(nestedRecord(jsonRecord(value), "details"), "browser_usage");
}

function browserToolIdFromUsage(
  value: Record<string, unknown> | null,
): string | null {
  return typeof value?.tool_id === "string" && value.tool_id.trim()
    ? value.tool_id.trim()
    : null;
}

function browserToolCallCategory(toolId: string | null): "state" | "action" | "wait" | "find" | "screenshot" | null {
  switch (toolId) {
    case "browser_get_state":
      return "state";
    case "browser_wait":
      return "wait";
    case "browser_find":
      return "find";
    case "browser_screenshot":
      return "screenshot";
    case "browser_act":
    case "browser_click":
    case "browser_context_click":
    case "browser_type":
    case "browser_press":
    case "browser_scroll":
    case "browser_back":
    case "browser_forward":
    case "browser_reload":
    case "browser_navigate":
    case "browser_open_tab":
    case "browser_select_tab":
    case "browser_close_tab":
    case "browser_list_tabs":
    case "browser_list_downloads":
    case "browser_storage_set":
    case "browser_cookies_set":
      return "action";
    default:
      return null;
  }
}

function tokenDetailNumber(
  usage: Record<string, unknown> | null,
  detailKeys: string[],
  keys: string[],
): number | null {
  if (!usage) {
    return null;
  }
  for (const detailKey of detailKeys) {
    const detail = nestedRecord(usage, detailKey);
    const value = firstFiniteUsageNumber(detail, keys);
    if (value !== null) {
      return value;
    }
  }
  return firstFiniteUsageNumber(usage, keys);
}

function latencyMs(startedAt: string, completedAt: string | null): number | null {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt ?? "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return null;
  }
  return Math.max(0, completedMs - startedMs);
}

function contextUsagePayload(contextUsage: PiContextUsage | null): Record<string, unknown> | null {
  if (!contextUsage) {
    return null;
  }
  return {
    tokens: contextUsage.tokens,
    context_window: contextUsage.contextWindow,
    percent: contextUsage.percent,
  };
}

function latestPriorTurnCompactionContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  currentInputId: string;
}): {
  previousSelectedModel: string | null;
  previousContextUsage: PiContextUsage | null;
} {
  const recentTurns = params.store.listTurnResults({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    limit: 10,
    offset: 0,
  });
  for (const turn of recentTurns) {
    if (turn.inputId === params.currentInputId) {
      continue;
    }
    const previousInput = params.store.getInput({
      workspaceId: params.workspaceId,
      inputId: turn.inputId,
    });
    const contextBudgetDecisions = isRecord(turn.contextBudgetDecisions)
      ? turn.contextBudgetDecisions
      : null;
    return {
      previousSelectedModel:
        typeof previousInput?.payload.model === "string"
          ? previousInput.payload.model.trim() || null
          : null,
      previousContextUsage: normalizePiContextUsage(
        contextBudgetDecisions?.context_usage,
      ),
    };
  }
  return {
    previousSelectedModel: null,
    previousContextUsage: null,
  };
}

function preRunCompactionPayload(
  value: PreRunCompactionTelemetryRecord | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
  };
}

function overflowRecoveryPayload(
  value: OverflowRecoveryTelemetryRecord | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
  };
}

function providerTerminationRecoveryPayload(
  value: ProviderTerminationRecoveryTelemetryRecord | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
  };
}

function contextOverflowFailureText(payload: Record<string, unknown>): string {
  const candidates = [
    optionalString(payload.message),
    optionalString(payload.error_message),
    optionalString(payload.type),
  ].filter((value): value is string => Boolean(value));
  try {
    const serialized = JSON.stringify(payload);
    if (serialized) {
      candidates.push(serialized);
    }
  } catch {
    // Ignore serialization failures and fall back to the direct fields.
  }
  return candidates.join("\n");
}

function isContextOverflowFailurePayload(
  payload: Record<string, unknown> | null,
): boolean {
  if (!payload) {
    return false;
  }
  const text = contextOverflowFailureText(payload);
  if (!text) {
    return false;
  }
  if (NON_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

function isRecoverableProviderTerminationPayload(params: {
  payload: Record<string, unknown> | null;
  tokenUsage: Record<string, unknown> | null;
  modelTurns: number;
  toolCallCount: number;
}): boolean {
  if (!params.payload) {
    return false;
  }
  const payloadType = optionalString(params.payload.type)?.toLowerCase();
  if (payloadType !== "providererror") {
    return false;
  }
  const payloadSource = optionalString(params.payload.source)?.toLowerCase();
  if (payloadSource && payloadSource !== "pi") {
    return false;
  }
  const payloadEvent = optionalString(params.payload.event)?.toLowerCase();
  if (payloadEvent && payloadEvent !== "message_end" && payloadEvent !== "turn_end") {
    return false;
  }
  const failureMessage = optionalString(params.payload.message);
  if (!failureMessage || failureMessage.trim().toLowerCase() !== "terminated") {
    return false;
  }
  const usage =
    (isRecord(params.payload.usage) ? params.payload.usage : null) ??
    params.tokenUsage;
  const inputTokens = firstFiniteUsageNumber(usage, [
    "input_tokens",
    "prompt_tokens",
  ]);
  return (
    (inputTokens !== null &&
      inputTokens >= PROVIDER_TERMINATION_RECOVERY_MIN_INPUT_TOKENS) ||
    params.modelTurns >= PROVIDER_TERMINATION_RECOVERY_MIN_MODEL_TURNS ||
    params.toolCallCount >= PROVIDER_TERMINATION_RECOVERY_MIN_TOOL_CALLS
  );
}

function runnerEventWithSequenceOffset(
  event: RunnerEvent,
  sequenceOffset: number,
): RunnerEvent {
  if (!Number.isFinite(sequenceOffset) || sequenceOffset <= 0) {
    return event;
  }
  const baseSequence =
    typeof event.sequence === "number" && Number.isFinite(event.sequence)
      ? event.sequence
      : 0;
  return {
    ...event,
    sequence: baseSequence + sequenceOffset,
  };
}

class SessionResetRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResetRequiredError";
  }
}

function executorFailureStopReason(error: unknown): string {
  return error instanceof SessionResetRequiredError
    ? "session_reset_required"
    : "executor_error";
}

function promptCacheStableCandidate(promptCacheProfile: Record<string, unknown> | null): boolean {
  if (!promptCacheProfile) {
    return false;
  }
  if (typeof promptCacheProfile.cacheable_fingerprint === "string" && promptCacheProfile.cacheable_fingerprint) {
    return true;
  }
  return Array.isArray(promptCacheProfile.cacheable_section_ids) && promptCacheProfile.cacheable_section_ids.length > 0;
}

function turnResultStatusFromTerminalStatus(
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR",
): "completed" | "waiting_user" | "paused" | "failed" {
  if (terminalStatus === "ERROR") {
    return "failed";
  }
  if (terminalStatus === "WAITING_USER") {
    return "waiting_user";
  }
  if (terminalStatus === "PAUSED") {
    return "paused";
  }
  return "completed";
}

function updateTurnContextBudgetTelemetryFromEvent(
  telemetry: TurnContextBudgetTelemetry,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (eventType === "pi_native_event" && payload.native_type === "message_end") {
    telemetry.modelTurns += 1;
  }
  if (CONTEXT_BUDGET_COMPACTION_EVENT_TYPES.has(eventType)) {
    telemetry.compactionEvents += 1;
  }
  if (eventType !== "tool_call") {
    return;
  }

  const toolPayload =
    payload.result !== undefined && payload.result !== null
      ? payload.result
      : payload.tool_args !== undefined && payload.tool_args !== null
        ? payload.tool_args
        : payload;
  telemetry.largestToolPayloadBytes = Math.max(
    telemetry.largestToolPayloadBytes,
    jsonByteLength(toolPayload),
  );

  const toolName = optionalString(payload.tool_name)?.toLowerCase() ?? "";
  const capabilityPayload = browserCapabilityPayloadFromToolResult(payload.result);
  const browserUsage = browserUsageFromToolResult(payload.result);
  const browserToolId =
    browserToolIdFromUsage(browserUsage) ??
    (toolName.startsWith("browser_") ? toolName : null);
  const screenshotPayload =
    capabilityPayload?.screenshot ??
    (toolName === "browser_screenshot" ? capabilityPayload ?? payload.result : null);
  if (screenshotPayload !== null && screenshotPayload !== undefined) {
    telemetry.screenshotBytes += jsonByteLength(screenshotPayload);
  }
  if (capabilityPayload?.state) {
    telemetry.browserSnapshotBytes += jsonByteLength({
      page: capabilityPayload.page ?? null,
      state: capabilityPayload.state,
    });
  }
  if (browserUsage) {
    telemetry.browserToolCalls += 1;
    const category = browserToolCallCategory(browserToolId);
    const hasStateSnapshot =
      category === "state" || typeof browserUsage.detail === "string";
    if (hasStateSnapshot) {
      telemetry.browserStateReads += 1;
      if (browserUsage.detail === "compact") {
        telemetry.browserCompactStateReads += 1;
      }
      if (browserUsage.detail === "standard") {
        telemetry.browserStandardStateReads += 1;
      }
      if (browserUsage.truncated === true) {
        telemetry.browserTruncatedStateReads += 1;
      }
    }
    if (category === "action") {
      telemetry.browserActionCalls += 1;
    }
    if (category === "wait") {
      telemetry.browserWaitCalls += 1;
    }
    if (category === "find") {
      telemetry.browserFindCalls += 1;
    }
    if (category === "screenshot") {
      telemetry.browserScreenshotCalls += 1;
    }
    const pageTextChars = finiteNumber(browserUsage.page_text_chars);
    if (pageTextChars !== null) {
      telemetry.browserPageTextChars += pageTextChars;
    }
  }
}

function buildContextBudgetObservabilityPayload(params: {
  startedAt: string;
  completedAt: string | null;
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR";
  stopReason: string | null;
  tokenUsage: Record<string, unknown> | null;
  contextUsage: PiContextUsage | null;
  promptCacheProfile: Record<string, unknown> | null;
  telemetry: TurnContextBudgetTelemetry;
  toolCallCount: number;
  checkpointQueued: boolean;
  preRunCompaction?: PreRunCompactionTelemetryRecord | null;
  overflowRecovery?: OverflowRecoveryTelemetryRecord | null;
  providerTerminationRecovery?: ProviderTerminationRecoveryTelemetryRecord | null;
}): Record<string, unknown> {
  const inputTokens =
    firstFiniteUsageNumber(params.tokenUsage, ["input_tokens", "prompt_tokens"]);
  const outputTokens = firstFiniteUsageNumber(params.tokenUsage, [
    "output_tokens",
    "completion_tokens",
  ]);
  const totalTokens =
    firstFiniteUsageNumber(params.tokenUsage, ["total_tokens"]) ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cachedInputTokens = tokenDetailNumber(
    params.tokenUsage,
    ["input_tokens_details", "prompt_tokens_details"],
    ["cached_tokens"],
  ) ?? firstFiniteUsageNumber(params.tokenUsage, [
    "cache_read_input_tokens",
    "cached_input_tokens",
  ]);
  const cacheWriteInputTokens = tokenDetailNumber(
    params.tokenUsage,
    ["input_tokens_details", "prompt_tokens_details"],
    ["cache_creation_tokens", "cache_write_tokens", "cache_creation_input_tokens"],
  ) ?? firstFiniteUsageNumber(params.tokenUsage, [
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
  ]);
  const uncachedInputTokens =
    inputTokens !== null && cachedInputTokens !== null
      ? Math.max(0, inputTokens - cachedInputTokens)
      : inputTokens;
  const status = turnResultStatusFromTerminalStatus(params.terminalStatus);
  const modelTurns =
    params.telemetry.modelTurns > 0 || !params.tokenUsage
      ? params.telemetry.modelTurns
      : 1;

  return {
    schema_version: CONTEXT_BUDGET_OBSERVABILITY_SCHEMA_VERSION,
    mode: "observability_only",
    pressure_stage: null,
    lane_decisions: [],
    checkpoint_recommended: shouldQueueSessionCheckpoint(params.contextUsage),
    checkpoint_queued: params.checkpointQueued,
    prompt_cache_stable_candidate: promptCacheStableCandidate(params.promptCacheProfile),
    tool_replay_trimmed: false,
    retrieval_clipped: false,
    reason_codes: [],
    context_usage: contextUsagePayload(params.contextUsage),
    model_context_window: params.contextUsage?.contextWindow ?? null,
    ...(params.preRunCompaction
      ? { pre_run_compaction: preRunCompactionPayload(params.preRunCompaction) }
      : {}),
    ...(params.overflowRecovery
      ? { overflow_recovery: overflowRecoveryPayload(params.overflowRecovery) }
      : {}),
    ...(params.providerTerminationRecovery
      ? {
          provider_termination_recovery: providerTerminationRecoveryPayload(
            params.providerTerminationRecovery,
          ),
        }
      : {}),
    input_budget_total: null,
    metrics: {
      status,
      stop_reason: params.stopReason,
      task_success: status !== "failed",
      latency_ms: latencyMs(params.startedAt, params.completedAt),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cached_input_tokens: cachedInputTokens,
      cache_write_input_tokens: cacheWriteInputTokens,
      uncached_input_tokens: uncachedInputTokens,
      model_turns: modelTurns,
      tool_calls: params.toolCallCount,
      largest_tool_payload_bytes: params.telemetry.largestToolPayloadBytes,
      browser_snapshot_bytes: params.telemetry.browserSnapshotBytes,
      screenshot_bytes: params.telemetry.screenshotBytes,
      browser_tool_calls: params.telemetry.browserToolCalls,
      browser_state_reads: params.telemetry.browserStateReads,
      browser_compact_state_reads: params.telemetry.browserCompactStateReads,
      browser_standard_state_reads: params.telemetry.browserStandardStateReads,
      browser_truncated_state_reads: params.telemetry.browserTruncatedStateReads,
      browser_action_calls: params.telemetry.browserActionCalls,
      browser_wait_calls: params.telemetry.browserWaitCalls,
      browser_find_calls: params.telemetry.browserFindCalls,
      browser_screenshot_calls: params.telemetry.browserScreenshotCalls,
      browser_page_text_chars: params.telemetry.browserPageTextChars,
      compaction_events: params.telemetry.compactionEvents,
    },
  };
}

function buildMergedContextBudgetPayload(params: {
  startedAt: string;
  completedAt: string | null;
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR";
  stopReason: string | null;
  tokenUsage: Record<string, unknown> | null;
  contextUsage: PiContextUsage | null;
  promptCacheProfile: Record<string, unknown> | null;
  telemetry: TurnContextBudgetTelemetry;
  toolCallCount: number;
  toolReplayTrimmed: boolean;
  retrievalClipped?: boolean;
  checkpointQueued: boolean;
  preRunCompaction?: PreRunCompactionTelemetryRecord | null;
  overflowRecovery?: OverflowRecoveryTelemetryRecord | null;
  providerTerminationRecovery?: ProviderTerminationRecoveryTelemetryRecord | null;
}): Record<string, unknown> {
  return {
    ...buildContextBudgetObservabilityPayload({
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      terminalStatus: params.terminalStatus,
      stopReason: params.stopReason,
      tokenUsage: params.tokenUsage,
      contextUsage: params.contextUsage,
      promptCacheProfile: params.promptCacheProfile,
      telemetry: params.telemetry,
      toolCallCount: params.toolCallCount,
      checkpointQueued: params.checkpointQueued,
      preRunCompaction: params.preRunCompaction,
      overflowRecovery: params.overflowRecovery,
      providerTerminationRecovery: params.providerTerminationRecovery,
    }),
    ...buildContextBudgetDecisions({
      promptCacheProfile: params.promptCacheProfile,
      toolReplayTrimmed: params.toolReplayTrimmed,
      retrievalClipped: params.retrievalClipped,
      checkpointQueued: params.checkpointQueued,
    }),
  };
}

function claimLeaseUntilIso(
  leaseSeconds: number,
  nowIso = new Date().toISOString(),
): string {
  if (leaseSeconds <= 0) {
    return nowIso;
  }
  const now = new Date(nowIso);
  return new Date(now.getTime() + leaseSeconds * 1000).toISOString();
}

function latestPersistedTerminalOutputEvent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
}) {
  return params.store
    .listOutputEvents({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      inputId: params.inputId,
    })
    .filter((event) => TERMINAL_OUTPUT_EVENT_TYPES.has(event.eventType))
    .at(-1);
}

function stopReasonForTerminalEvent(params: {
  eventType: string;
  payload: Record<string, unknown>;
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR";
}): string | null {
  if (params.eventType === "run_completed") {
    const status =
      typeof params.payload.status === "string"
        ? params.payload.status.trim().toLowerCase()
        : "";
    if (status) {
      return status;
    }
    if (params.terminalStatus === "WAITING_USER") {
      return "waiting_user";
    }
    if (params.terminalStatus === "PAUSED") {
      return "paused";
    }
    return "completed";
  }
  if (params.eventType === "run_failed") {
    if (typeof params.payload.type === "string" && params.payload.type.trim()) {
      return params.payload.type.trim();
    }
    if (
      typeof params.payload.message === "string" &&
      params.payload.message.trim()
    ) {
      return params.payload.message.trim();
    }
    return "run_failed";
  }
  return null;
}

function toolReplayTrimmedFromToolResult(result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.details)) {
    return false;
  }
  const replayBudget = isRecord(result.details.replay_budget)
    ? result.details.replay_budget
    : null;
  if (!replayBudget) {
    return false;
  }
  if (replayBudget.trimmed === true) {
    return true;
  }
  return nonEmptyString(replayBudget.mode) === "reference_only";
}

function buildContextBudgetDecisions(params: {
  promptCacheProfile: Record<string, unknown> | null;
  toolReplayTrimmed: boolean;
  retrievalClipped?: boolean;
  checkpointQueued: boolean;
}): Record<string, unknown> {
  const retrievalClipped = params.retrievalClipped === true;
  return {
    pressure_stage: params.checkpointQueued
      ? "queue_checkpoint"
      : retrievalClipped
        ? "retrieval_only"
        : params.toolReplayTrimmed
          ? "trim_replay"
          : "normal",
    lane_decisions: [],
    prompt_cache_stable_candidate: promptCacheStableCandidate(
      params.promptCacheProfile,
    ),
    tool_replay_trimmed: params.toolReplayTrimmed,
    retrieval_clipped: retrievalClipped,
    checkpoint_queued: params.checkpointQueued,
  };
}

function permissionDenialFromEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (payload.error !== true) {
    return null;
  }

  const candidates = [
    typeof payload.message === "string" ? payload.message : null,
    typeof payload.result === "string" ? payload.result : null,
    typeof payload.error_message === "string" ? payload.error_message : null,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const denialText = candidates.find((value) =>
    /permission|denied|not allowed/i.test(value),
  );
  if (!denialText) {
    return null;
  }

  return {
    tool_name:
      typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
    tool_id: typeof payload.tool_id === "string" ? payload.tool_id : null,
    reason: denialText,
  };
}

function normalizedFailureKindSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

function terminalFailureKindFromPayload(
  payload: Record<string, unknown>,
): string {
  const errorType = optionalString(payload.type);
  if (errorType) {
    return `terminal_${normalizedFailureKindSegment(errorType)}`;
  }
  const stopReason = optionalString(payload.stop_reason);
  if (stopReason) {
    return `terminal_${normalizedFailureKindSegment(stopReason)}`;
  }
  return "terminal_run_failed";
}

function summarizeRunnerEventForSentry(params: {
  sequence: number;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    sequence: params.sequence,
    event_type: params.eventType,
    timestamp: params.timestamp,
  };
  if (params.eventType === "output_delta") {
    const delta = optionalString(params.payload.delta);
    summary.payload = {
      delta_chars: typeof delta === "string" ? delta.length : 0,
    };
    return summary;
  }

  const payloadSummary: Record<string, unknown> = {};
  for (const key of [
    "type",
    "status",
    "message",
    "error_message",
    "stop_reason",
    "source",
    "phase",
    "tool_name",
    "tool_id",
    "call_id",
    "harness_session_id",
  ]) {
    if (!(key in params.payload)) {
      continue;
    }
    payloadSummary[key] = sanitizeRuntimeSentryValue(
      params.payload[key],
      key,
      CLAIMED_INPUT_SENTRY_EVENT_PREVIEW_LIMIT,
    );
  }
  if (typeof params.payload.error === "boolean") {
    payloadSummary.error = params.payload.error;
  }
  if (Object.keys(payloadSummary).length === 0 && Object.keys(params.payload).length > 0) {
    payloadSummary.preview = truncateRuntimeSentryText(
      JSON.stringify(sanitizeRuntimeSentryValue(params.payload)) ?? "{}",
      CLAIMED_INPUT_SENTRY_EVENT_PREVIEW_LIMIT,
    );
  }
  if (Object.keys(payloadSummary).length > 0) {
    summary.payload = payloadSummary;
  }
  return summary;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function titleCaseWords(value: string): string {
  return value.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function cronjobNotificationPriority(
  value: unknown,
): "low" | "normal" | "high" | "critical" {
  const normalized = optionalString(value)?.toLowerCase();
  if (
    normalized === "low" ||
    normalized === "high" ||
    normalized === "critical"
  ) {
    return normalized;
  }
  return "normal";
}

function cronjobNotificationBaseTitle(job: {
  name: string;
  metadata: Record<string, unknown>;
}): string {
  const explicitTitle = optionalString(job.metadata.notification_title);
  if (explicitTitle) {
    return explicitTitle;
  }
  const name = optionalString(job.name);
  if (name) {
    return titleCaseWords(name.replace(/[_-]+/g, " ").replace(/\s+/g, " "));
  }
  return "Cronjob Run";
}

function cronjobCompletionNotificationTitle(
  turnResult: TurnResultRecord,
  baseTitle: string,
): string {
  if (turnResult.status === "failed") {
    return `${baseTitle} Failed`;
  }
  if (turnResult.status === "waiting_user") {
    return `${baseTitle} Needs Input`;
  }
  if (turnResult.status === "paused") {
    return `${baseTitle} Paused`;
  }
  return `${baseTitle} Completed`;
}

function cronjobCompletionNotificationLevel(
  turnResult: TurnResultRecord,
): "info" | "success" | "warning" | "error" {
  if (turnResult.status === "failed") {
    return "error";
  }
  if (turnResult.status === "waiting_user" || turnResult.status === "paused") {
    return "warning";
  }
  return "success";
}

function cronjobCompletionNotificationMessage(
  turnResult: TurnResultRecord,
): string {
  const summary = compactTurnSummary(turnResult);
  if (summary) {
    return summary;
  }
  if (turnResult.status === "failed") {
    return "Cronjob run failed.";
  }
  if (turnResult.status === "waiting_user") {
    return "Cronjob run is waiting for user input.";
  }
  if (turnResult.status === "paused") {
    return "Cronjob run was paused.";
  }
  return "Cronjob run completed.";
}

function cronjobContainerTitle(job: {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
}): string {
  const name = optionalString(job.name);
  if (name) {
    return titleCaseWords(name.replace(/[_-]+/g, " ").replace(/\s+/g, " "));
  }
  const description = optionalString(job.description);
  if (description) {
    return description;
  }
  return cronjobNotificationBaseTitle({
    name: job.name,
    metadata: job.metadata,
  });
}

function isCronjobMainSessionKind(kind: string | null | undefined): boolean {
  const normalized = optionalString(kind)?.toLowerCase() ?? "main_session";
  const canonical =
    normalized === "workspace_session" || normalized === "main"
      ? "main_session"
      : normalized;
  return canonical === "main_session" || canonical === "onboarding";
}

function preferredCronjobOwnerMainSessionId(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  metadata: Record<string, unknown>;
}): string | null {
  const preferredIds = [
    optionalString(params.metadata.source_session_id),
    optionalString(params.metadata.session_id),
  ].filter((value): value is string => Boolean(value));
  for (const sessionId of preferredIds) {
    const session = params.store.getSession({
      workspaceId: params.workspace.id,
      sessionId,
    });
    if (session && isCronjobMainSessionKind(session.kind)) {
      return session.sessionId;
    }
  }

  const desktopBinding = params.store.getConversationBindingByConversation({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    role: "main_session",
  });
  if (desktopBinding) {
    return desktopBinding.sessionId;
  }

  const onboardingSessionId = optionalString(params.workspace.onboardingSessionId);
  const sessions = params.store.listSessions({
    workspaceId: params.workspace.id,
    includeArchived: false,
    limit: 200,
    offset: 0,
  });
  const preferred = sessions.find((session) => {
    if (session.sessionId === onboardingSessionId) {
      return false;
    }
    return isCronjobMainSessionKind(session.kind);
  });
  if (preferred) {
    return preferred.sessionId;
  }
  return (
    sessions.find(
      (session) =>
        session.sessionId !== onboardingSessionId &&
        isCronjobMainSessionKind(session.kind),
    )?.sessionId ?? null
  );
}

function cronjobLifecycleEventType(
  turnResult: TurnResultRecord,
): "completed" | "failed" | "waiting_on_user" | "cancelled" {
  if (turnResult.status === "failed") {
    return "failed";
  }
  if (turnResult.status === "waiting_user") {
    return "waiting_on_user";
  }
  if (turnResult.status === "paused") {
    return "cancelled";
  }
  return "completed";
}

function maybeQueueCronjobCompletionFollowup(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): void {
  const context = isRecord(params.record.payload.context)
    ? params.record.payload.context
    : null;
  const source = optionalString(context?.source)?.toLowerCase();
  const cronjobId = optionalString(context?.cronjob_id);
  if (source !== "cronjob" || !cronjobId) {
    return;
  }

  const session = params.store.getSession({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
  });
  if (optionalString(session?.kind)?.toLowerCase() !== "cronjob") {
    return;
  }

  const job = params.store.getCronjob({
    workspaceId: params.record.workspaceId,
    jobId: cronjobId,
  });
  const workspace = params.store.getWorkspace(params.record.workspaceId);
  if (!job || !workspace) {
    return;
  }

  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const deliveryMode = optionalString(delivery.mode)?.toLowerCase() ?? "announce";
  if (deliveryMode === "none") {
    return;
  }

  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const ownerMainSessionId = preferredCronjobOwnerMainSessionId({
    store: params.store,
    workspace,
    metadata,
  });
  if (!ownerMainSessionId) {
    return;
  }

  const outputs = params.store.listOutputs({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    limit: 200,
    offset: 0,
  });
  const eventType = cronjobLifecycleEventType(params.turnResult);
  const summary = cronjobCompletionNotificationMessage(params.turnResult);
  const assistantText = optionalString(params.turnResult.assistantText);
  const forwardableDeliverables = subagentForwardableDeliverables(outputs);
  const deliveryChannel = optionalString(delivery.channel)?.toLowerCase() ?? null;
  const payloadTitle = cronjobContainerTitle({
    name: job.name,
    description: job.description,
    metadata,
  });
  const payload: Record<string, unknown> = {
    cronjob_id: job.id,
    source_type: "cronjob",
    cronjob_name: optionalString(job.name),
    title: payloadTitle,
    goal: optionalString(job.description) ?? payloadTitle,
    summary,
    status: eventType,
    turn_status: params.turnResult.status,
    stop_reason: params.turnResult.stopReason,
    child_session_id: params.record.sessionId,
    child_input_id: params.record.inputId,
    cronjob_schedule: optionalString(job.cron),
    cronjob_first_run: job.runCount <= 1,
    cronjob_delivery_channel: deliveryChannel,
    cronjob_delivery_mode: deliveryMode,
  };
  const instruction = optionalString(job.instruction);
  if (instruction) {
    payload.context = instruction;
  }
  if (assistantText) {
    payload.assistant_text = assistantText;
  }
  if (forwardableDeliverables.length > 0) {
    payload.forwardable_deliverables = forwardableDeliverables;
  }
  if (eventType === "waiting_on_user") {
    payload.blocking_question = assistantText ?? summary;
    if (forwardableDeliverables.length > 0) {
      payload.partial_deliverables = forwardableDeliverables;
    }
  } else if (eventType === "failed" || eventType === "cancelled") {
    payload.partial_summary = summary;
    if (forwardableDeliverables.length > 0) {
      payload.partial_deliverables = forwardableDeliverables;
    }
  }

  const completedAt =
    params.turnResult.completedAt ?? params.turnResult.updatedAt ?? utcNowIso();
  const deliveryBucket =
    eventType === "waiting_on_user" ? "waiting_on_user" : "background_update";
  params.store.enqueueMainSessionEvent({
    workspaceId: params.record.workspaceId,
    ownerMainSessionId,
    originMainSessionId: ownerMainSessionId,
    subagentId: null,
    eventType,
    deliveryBucket,
    coalesceKey: `${ownerMainSessionId}:${deliveryBucket}`,
    earliestDeliverAt: plusMillisecondsIso(
      completedAt,
      SUBAGENT_EVENT_COALESCE_WINDOW_MS,
    ),
    latestDeliverAt:
      eventType === "waiting_on_user"
        ? null
        : plusMillisecondsIso(completedAt, SUBAGENT_EVENT_IDLE_TIMEOUT_MS),
    payload,
  });
}

function maybeCreateCronjobCompletionNotification(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): void {
  const context = isRecord(params.record.payload.context)
    ? params.record.payload.context
    : null;
  const source = optionalString(context?.source)?.toLowerCase();
  const cronjobId = optionalString(context?.cronjob_id);
  if (source !== "cronjob" || !cronjobId) {
    return;
  }

  const session = params.store.getSession({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
  });
  if (optionalString(session?.kind)?.toLowerCase() !== "cronjob") {
    return;
  }

  const job = params.store.getCronjob({
    workspaceId: params.record.workspaceId,
    jobId: cronjobId,
  });
  const workspace = params.store.getWorkspace(params.record.workspaceId);
  if (!job || !workspace) {
    return;
  }

  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const baseTitle = cronjobNotificationBaseTitle({ name: job.name, metadata });
  params.store.createRuntimeNotification({
    workspaceId: params.record.workspaceId,
    cronjobId: job.id,
    sourceType: "cronjob",
    sourceLabel: workspace.name.trim() || null,
    title: cronjobCompletionNotificationTitle(params.turnResult, baseTitle),
    message: cronjobCompletionNotificationMessage(params.turnResult),
    level: cronjobCompletionNotificationLevel(params.turnResult),
    priority: cronjobNotificationPriority(metadata.notification_priority),
    metadata: {
      cronjob_id: job.id,
      cronjob_name: job.name,
      cronjob_description: job.description,
      cronjob_instruction: job.instruction,
      session_id: params.record.sessionId,
      input_id: params.record.inputId,
      turn_status: params.turnResult.status,
      stop_reason: params.turnResult.stopReason,
      delivery: job.delivery,
      cronjob_metadata: metadata,
    },
  });
}

function maybeCreateBackgroundIntegrationNotification(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): void {
  if (params.turnResult.status !== "waiting_user") {
    return;
  }
  const session = params.store.getSession({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
  });
  if (optionalString(session?.kind)?.toLowerCase() !== "subagent") {
    return;
  }
  const run = params.store.getSubagentRunByChildSession({
    workspaceId: params.record.workspaceId,
    childSessionId: params.record.sessionId,
  });
  if (!run) return;
  const blockingPayload = isRecord(run.blockingPayload) ? run.blockingPayload : null;
  const pendingList = blockingPayload && Array.isArray(blockingPayload.pending_integrations)
    ? blockingPayload.pending_integrations
    : [];
  if (pendingList.length === 0) return;
  const providers = [
    ...new Set(
      pendingList
        .map((entry) => (isRecord(entry) ? optionalString(entry.provider_id) : null))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const apps = [
    ...new Set(
      pendingList
        .map((entry) => (isRecord(entry) ? optionalString(entry.app_id) : null))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (providers.length === 0 || apps.length === 0) return;

  const workspace = params.store.getWorkspace(params.record.workspaceId);
  if (!workspace) return;
  const workspaceName = workspace.name.trim() || "Workspace";
  const providerLabel = providers.length === 1 ? providers[0] : `${providers.length} integrations`;
  const appLabel = apps.length === 1 ? apps[0] : `${apps.length} apps`;

  params.store.createRuntimeNotification({
    workspaceId: params.record.workspaceId,
    sourceType: "background_integration",
    sourceLabel: workspaceName,
    title: `${workspaceName} — Connect ${providerLabel}`,
    message: `${appLabel} needs your ${providerLabel} account to continue. Open the workspace to authorize.`,
    level: "info",
    priority: "normal",
    metadata: {
      session_id: run.ownerMainSessionId,
      subagent_id: run.subagentId,
      child_session_id: run.childSessionId,
      origin_main_session_id: run.originMainSessionId,
      owner_main_session_id: run.ownerMainSessionId,
      pending_integrations: pendingList,
      providers,
      apps,
      activation_state: "pending",
    },
  });
}

function maybeCreateMainSessionCompletionNotification(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): void {
  const session = params.store.getSession({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
  });
  if (optionalString(session?.kind)?.toLowerCase() !== "main_session") {
    return;
  }

  if (!["completed", "failed"].includes(params.turnResult.status)) {
    return;
  }

  const workspace = params.store.getWorkspace(params.record.workspaceId);
  if (!workspace) {
    return;
  }

  const workspaceName = workspace.name.trim() || "Workspace";
  const message =
    compactTurnSummary(params.turnResult) ||
    optionalString(params.turnResult.assistantText) ||
    (params.turnResult.status === "failed"
      ? "The latest reply failed."
      : "Your latest reply is ready.");
  if (!message) {
    return;
  }

  params.store.createRuntimeNotification({
    workspaceId: params.record.workspaceId,
    sourceType: "main_session",
    sourceLabel: workspaceName,
    title:
      params.turnResult.status === "failed"
        ? `${workspaceName} — Reply failed`
        : `${workspaceName} — Reply ready`,
    message,
    level: params.turnResult.status === "failed" ? "error" : "info",
    priority: "normal",
    metadata: {
      session_id: params.record.sessionId,
      input_id: params.record.inputId,
      turn_status: params.turnResult.status,
      stop_reason: params.turnResult.stopReason,
      activation_state: "dismissed",
    },
  });
}

async function maybePromoteAcceptedEvolveSkillCandidate(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
  memoryService?: MemoryServiceLike | null;
}): Promise<void> {
  if (!params.memoryService || params.turnResult.status !== "completed") {
    return;
  }
  const context = isRecord(params.record.payload.context)
    ? params.record.payload.context
    : null;
  const source = optionalString(context?.source)?.toLowerCase();
  const proposalSource = optionalString(
    context?.proposal_source,
  )?.toLowerCase();
  const evolveCandidate = isRecord(context?.evolve_candidate)
    ? context?.evolve_candidate
    : null;
  const candidateId = optionalString(evolveCandidate?.candidate_id);
  if (
    source !== "task_proposal" ||
    proposalSource !== "evolve" ||
    !candidateId
  ) {
    return;
  }
  await promoteAcceptedSkillCandidate({
    store: params.store,
    memoryService: params.memoryService,
    workspaceId: params.record.workspaceId,
    candidateId,
  });
}

type SkillInvocationSummaryEntry = {
  skillName: string;
  skillId: string | null;
  completed: boolean;
  error: boolean;
};

type SkillWideningAudit = {
  scope: string | null;
  workspaceBoundaryOverride: boolean | null;
  managedTools: Set<string>;
  grantedTools: Set<string>;
  activeGrantedTools: Set<string>;
  managedCommands: Set<string>;
  grantedCommands: Set<string>;
  activeGrantedCommands: Set<string>;
  activationCount: number;
  deniedCalls: number;
  deniedToolNames: Set<string>;
};

function summarizeSkillInvocations(
  skillInvocationsById: Map<string, SkillInvocationSummaryEntry>,
): Record<string, unknown> {
  const calls = [...skillInvocationsById.values()];
  return {
    total_calls: calls.length,
    completed_calls: calls.filter((call) => call.completed && !call.error)
      .length,
    failed_calls: calls.filter((call) => call.error).length,
    skill_names: [
      ...new Set(calls.map((call) => call.skillName).filter(Boolean)),
    ].sort((left, right) => left.localeCompare(right)),
    skill_ids: [
      ...new Set(
        calls
          .map((call) => call.skillId)
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  };
}

function createSkillWideningAudit(): SkillWideningAudit {
  return {
    scope: null,
    workspaceBoundaryOverride: null,
    managedTools: new Set<string>(),
    grantedTools: new Set<string>(),
    activeGrantedTools: new Set<string>(),
    managedCommands: new Set<string>(),
    grantedCommands: new Set<string>(),
    activeGrantedCommands: new Set<string>(),
    activationCount: 0,
    deniedCalls: 0,
    deniedToolNames: new Set<string>(),
  };
}

function skillWideningSummary(
  audit: SkillWideningAudit,
): Record<string, unknown> | null {
  if (
    audit.scope === null &&
    audit.workspaceBoundaryOverride === null &&
    audit.managedTools.size === 0 &&
    audit.grantedTools.size === 0 &&
    audit.activeGrantedTools.size === 0 &&
    audit.managedCommands.size === 0 &&
    audit.grantedCommands.size === 0 &&
    audit.activeGrantedCommands.size === 0 &&
    audit.activationCount === 0 &&
    audit.deniedCalls === 0
  ) {
    return null;
  }
  return {
    scope: audit.scope,
    workspace_boundary_override: audit.workspaceBoundaryOverride,
    managed_tools: [...audit.managedTools].sort((left, right) =>
      left.localeCompare(right),
    ),
    granted_tools: [...audit.grantedTools].sort((left, right) =>
      left.localeCompare(right),
    ),
    active_granted_tools: [...audit.activeGrantedTools].sort((left, right) =>
      left.localeCompare(right),
    ),
    managed_commands: [...audit.managedCommands].sort((left, right) =>
      left.localeCompare(right),
    ),
    granted_commands: [...audit.grantedCommands].sort((left, right) =>
      left.localeCompare(right),
    ),
    active_granted_commands: [...audit.activeGrantedCommands].sort(
      (left, right) => left.localeCompare(right),
    ),
    activation_count: audit.activationCount,
    denied_calls: audit.deniedCalls,
    denied_tool_names: [...audit.deniedToolNames].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function isSkillPolicyDeniedPayload(payload: Record<string, unknown>): boolean {
  if (payload.error !== true) {
    return false;
  }
  const candidates = [
    optionalString(payload.message),
    optionalString(payload.result),
    optionalString(payload.error_message),
  ].filter((value): value is string => Boolean(value));
  return candidates.some((value) =>
    /permission denied by skill policy/i.test(value),
  );
}

function summarizeToolCalls(
  toolCallsById: Map<
    string,
    {
      toolName: string;
      toolId: string | null;
      completed: boolean;
      error: boolean;
      browserUsage: Record<string, unknown> | null;
    }
  >,
  skillInvocationsById: Map<string, SkillInvocationSummaryEntry> = new Map(),
  wideningAudit: SkillWideningAudit | null = null,
): Record<string, unknown> {
  const calls = [...toolCallsById.values()];
  const summary: Record<string, unknown> = {
    total_calls: calls.length,
    completed_calls: calls.filter((call) => call.completed && !call.error)
      .length,
    failed_calls: calls.filter((call) => call.error).length,
    tool_names: [
      ...new Set(calls.map((call) => call.toolName).filter(Boolean)),
    ].sort((left, right) => left.localeCompare(right)),
    tool_ids: [
      ...new Set(
        calls
          .map((call) => call.toolId)
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  };
  const browserCalls = calls.filter((call) =>
    browserToolCallCategory(
      browserToolIdFromUsage(call.browserUsage) ??
        (call.toolName.toLowerCase().startsWith("browser_") ? call.toolName.toLowerCase() : call.toolId),
    ) !== null,
  );
  if (browserCalls.length > 0) {
    const compactStateReads = browserCalls.filter(
      (call) => call.browserUsage?.detail === "compact",
    ).length;
    const standardStateReads = browserCalls.filter(
      (call) => call.browserUsage?.detail === "standard",
    ).length;
    summary.browser = {
      total_calls: browserCalls.length,
      state_reads: browserCalls.filter(
        (call) =>
          browserToolCallCategory(browserToolIdFromUsage(call.browserUsage) ?? call.toolId ?? call.toolName) ===
            "state" ||
          typeof call.browserUsage?.detail === "string",
      ).length,
      compact_state_reads: compactStateReads,
      standard_state_reads: standardStateReads,
      truncated_state_reads: browserCalls.filter(
        (call) => call.browserUsage?.truncated === true,
      ).length,
      action_calls: browserCalls.filter(
        (call) =>
          browserToolCallCategory(browserToolIdFromUsage(call.browserUsage) ?? call.toolId ?? call.toolName) ===
          "action",
      ).length,
      wait_calls: browserCalls.filter(
        (call) =>
          browserToolCallCategory(browserToolIdFromUsage(call.browserUsage) ?? call.toolId ?? call.toolName) ===
          "wait",
      ).length,
      find_calls: browserCalls.filter(
        (call) =>
          browserToolCallCategory(browserToolIdFromUsage(call.browserUsage) ?? call.toolId ?? call.toolName) ===
          "find",
      ).length,
      screenshot_calls: browserCalls.filter(
        (call) =>
          browserToolCallCategory(browserToolIdFromUsage(call.browserUsage) ?? call.toolId ?? call.toolName) ===
          "screenshot",
      ).length,
      page_text_chars: browserCalls.reduce((total, call) => {
        const value = finiteNumber(call.browserUsage?.page_text_chars);
        return total + (value ?? 0);
      }, 0),
    };
  }
  if (skillInvocationsById.size > 0) {
    summary.skill_invocations = summarizeSkillInvocations(skillInvocationsById);
  }
  const widening = wideningAudit ? skillWideningSummary(wideningAudit) : null;
  if (widening) {
    summary.skill_policy_widening = widening;
  }
  return summary;
}

function plusMillisecondsIso(
  value: string | null | undefined,
  milliseconds: number,
): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + milliseconds).toISOString();
}

type SubagentPendingIntegration = {
  workspace_id: string | null;
  app_id: string;
  provider_id: string;
  credential_source: string | null;
  // Opaque whoami config emitted by the runtime; forwarded verbatim to the
  // chat UI and then to Hono's /composio/connect. Shape lives in
  // integration-types.ts (WhoamiConfig). Treated as unknown here to keep
  // this module free of Hono-specific knowledge. Omitted when the runtime
  // didn't emit a whoami descriptor — downstream consumers treat missing
  // and null identically, and omitting keeps the lifecycle payload tight.
  whoami?: Record<string, unknown>;
};

function parseSubagentPendingIntegrationsFromText(
  text: string,
  fallbackWorkspaceId?: string | null,
): SubagentPendingIntegration[] {
  if (!text.includes("pending_integrations")) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const normalizedFallbackWorkspaceId =
    typeof fallbackWorkspaceId === "string" ? fallbackWorkspaceId.trim() : "";
  const list = Array.isArray(parsed.pending_integrations) ? parsed.pending_integrations : [];
  const out: SubagentPendingIntegration[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const appId = typeof entry.app_id === "string" ? entry.app_id.trim() : "";
    const provider = typeof entry.provider_id === "string" ? entry.provider_id.trim() : "";
    const workspaceId =
      typeof entry.workspace_id === "string" && entry.workspace_id.trim()
        ? entry.workspace_id.trim()
        : normalizedFallbackWorkspaceId;
    if (!appId || !provider) continue;
    out.push({
      workspace_id: workspaceId || null,
      app_id: appId,
      provider_id: provider,
      credential_source:
        typeof entry.credential_source === "string" ? entry.credential_source : null,
      ...(isRecord(entry.whoami) ? { whoami: entry.whoami } : {}),
    });
  }
  return out;
}

const PENDING_INTEGRATION_EMITTING_TOOLS = new Set([
  "workspace_apps_install",
  "workspace_apps_ensure_running",
  "workspace_apps_restart",
  "workspace_apps_restart_and_wait_ready",
  // Also scan completion-ish tools — the agent may end its build flow on
  // any of these without ever invoking ensure_running, leaving Connect
  // buttons stranded if we only emit from the four above.
  "workspace_apps_scaffold",
  "workspace_apps_register",
  "workspace_apps_build",
  "workspace_apps_wait_until_ready",
  "workspace_apps_get_status",
]);

function subagentPendingIntegrations(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  childSessionId: string;
}): SubagentPendingIntegration[] {
  const events = params.store.listOutputEvents({
    workspaceId: params.workspaceId,
    sessionId: params.childSessionId,
    includeHistory: true,
  });
  const seen = new Set<string>();
  const out: SubagentPendingIntegration[] = [];
  for (const event of events) {
    if (event.eventType !== "tool_call") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!PENDING_INTEGRATION_EMITTING_TOOLS.has(toolName)) continue;
    if (payload.phase !== "completed" || payload.error === true) continue;
    const result = isRecord(payload.result) ? payload.result : null;
    if (!result || !Array.isArray(result.content)) continue;
    for (const part of result.content) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
      for (const integration of parseSubagentPendingIntegrationsFromText(part.text, params.workspaceId)) {
        const key = [
          integration.workspace_id?.toLowerCase() ?? "",
          integration.provider_id.toLowerCase(),
          integration.app_id.toLowerCase(),
        ].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(integration);
      }
    }
  }
  return out;
}

function subagentForwardableDeliverables(
  outputs: OutputRecord[],
): Array<Record<string, unknown>> {
  return outputs.map((output) => {
    const metadata = isRecord(output.metadata) ? output.metadata : {};
    const artifactType = optionalString(metadata.artifact_type);
    return {
      output_id: output.id,
      type: artifactType ?? output.outputType,
      output_type: output.outputType,
      title: output.title,
      status: output.status,
      module_id: output.moduleId,
      module_resource_id: output.moduleResourceId,
      file_path: output.filePath,
      artifact_id: output.artifactId,
      platform: output.platform,
      safe_to_forward: true,
      metadata,
    };
  });
}

function subagentLifecycleStatusFromTurnResult(params: {
  run: SubagentRunRecord;
  turnResult: TurnResultRecord;
  pendingIntegrationCount?: number;
}): "completed" | "failed" | "waiting_on_user" | "cancelled" | null {
  if (params.run.cancelledAt || params.run.status === "cancelled") {
    return "cancelled";
  }
  if (params.turnResult.status === "waiting_user") {
    return "waiting_on_user";
  }
  if (
    (params.pendingIntegrationCount ?? 0) === 0 &&
    inferredRecoverableUserBlockerQuestion(params.turnResult)
  ) {
    return "waiting_on_user";
  }
  if (params.turnResult.status === "failed") {
    return "failed";
  }
  if (params.turnResult.status === "completed") {
    return "completed";
  }
  if (params.turnResult.status === "paused") {
    return "cancelled";
  }
  return null;
}

function inferredRecoverableUserBlockerQuestion(
  turnResult: TurnResultRecord,
): string | null {
  if (turnResult.status !== "completed") {
    return null;
  }
  const text = [
    turnResult.assistantText,
    turnResult.stopReason,
  ]
    .map((item) => optionalString(item))
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!text) {
    return null;
  }
  const accessBlocker =
    /\b(?:logged out|not logged in|sign[- ]?in|login|authenticate|authentication|authorize|authorization|mfa|2fa|captcha|permission denied|access denied|requires? permission|missing permission|credentials?)\b/i.test(
      text,
    );
  const cannotProceed =
    /\b(?:could not|couldn't|cannot|can't|unable|blocked|need(?:s|ed)?|requires?|must|no .*accessible|not .*accessible)\b/i.test(
      text,
    );
  if (!accessBlocker || !cannotProceed) {
    return null;
  }
  if (/\b(?:logged out|not logged in|sign[- ]?in|login)\b/i.test(text)) {
    return "Please log in or complete the required access step, then tell me to continue.";
  }
  if (/\b(?:authorize|authorization|authenticate|authentication|permission|credentials?)\b/i.test(text)) {
    return "Please complete the required authorization or access step, then tell me to continue.";
  }
  return "Please complete the required user action, then tell me to continue.";
}

function subagentLifecycleSummary(params: {
  run: SubagentRunRecord;
  turnResult: TurnResultRecord;
  status: "completed" | "failed" | "waiting_on_user" | "cancelled";
}): string {
  const compactSummary = compactTurnSummary(params.turnResult);
  if (params.status === "cancelled") {
    return optionalString(params.run.summary) ?? compactSummary ?? "Cancelled.";
  }
  if (params.status === "waiting_on_user") {
    return compactSummary ?? "Waiting on user input.";
  }
  if (params.status === "failed") {
    return compactSummary ?? "Task failed.";
  }
  return compactSummary ?? "Task completed.";
}

function subagentLifecyclePayload(params: {
  store: RuntimeStateStore;
  run: SubagentRunRecord;
  turnResult: TurnResultRecord;
  status: "completed" | "failed" | "waiting_on_user" | "cancelled";
  summary: string;
  outputs: OutputRecord[];
  record: SessionInputRecord;
}): Record<string, unknown> {
  const forwardableDeliverables = subagentForwardableDeliverables(params.outputs);
  const pendingIntegrations = subagentPendingIntegrations({
    store: params.store,
    workspaceId: params.run.workspaceId,
    childSessionId: params.run.childSessionId,
  });
  const assistantText = optionalString(params.turnResult.assistantText);
  const payload: Record<string, unknown> = {
    workspace_id: params.run.workspaceId,
    subagent_id: params.run.subagentId,
    child_session_id: params.run.childSessionId,
    child_input_id: params.record.inputId,
    origin_main_session_id: params.run.originMainSessionId,
    owner_main_session_id: params.run.ownerMainSessionId,
    title: params.run.title,
    goal: params.run.goal,
    status: params.status,
    summary: params.summary,
    turn_status: params.turnResult.status,
    stop_reason: params.turnResult.stopReason,
  };
  if (params.run.context) {
    payload.context = params.run.context;
  }
  if (assistantText) {
    payload.assistant_text = assistantText;
  }
  if (forwardableDeliverables.length > 0) {
    payload.forwardable_deliverables = forwardableDeliverables;
  }
  if (pendingIntegrations.length > 0) {
    payload.pending_integrations = pendingIntegrations;
  }
  if (params.status === "waiting_on_user") {
    payload.blocking_question =
      inferredRecoverableUserBlockerQuestion(params.turnResult) ??
      assistantText ??
      params.summary;
    if (
      inferredRecoverableUserBlockerQuestion(params.turnResult) &&
      assistantText
    ) {
      payload.partial_summary = assistantText;
    }
    if (forwardableDeliverables.length > 0) {
      payload.partial_deliverables = forwardableDeliverables;
    }
  } else if (
    params.status === "failed" ||
    params.status === "cancelled"
  ) {
    payload.partial_summary = params.summary;
    if (forwardableDeliverables.length > 0) {
      payload.partial_deliverables = forwardableDeliverables;
    }
  }
  return payload;
}

function supersedePendingSubagentEvents(params: {
  store: RuntimeStateStore;
  run: SubagentRunRecord;
}): void {
  const pending = params.store
    .listPendingMainSessionEvents({
      workspaceId: params.run.workspaceId,
      ownerMainSessionId: params.run.ownerMainSessionId,
      limit: 500,
    })
    .filter((event) => event.subagentId === params.run.subagentId);
  if (pending.length === 0) {
    return;
  }
  params.store.markMainSessionEventsSuperseded({
    workspaceId: params.run.workspaceId,
    eventIds: pending.map((event) => event.eventId),
  });
}

function updateSubagentRunFromTurnResult(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): SubagentRunRecord | null {
  const run = params.store.getSubagentRunByChildSession({
    workspaceId: params.record.workspaceId,
    childSessionId: params.record.sessionId,
  });
  if (!run) {
    return null;
  }

  const pendingIntegrationCount = subagentPendingIntegrations({
    store: params.store,
    workspaceId: run.workspaceId,
    childSessionId: run.childSessionId,
  }).length;
  const status = subagentLifecycleStatusFromTurnResult({
    run,
    turnResult: params.turnResult,
    pendingIntegrationCount,
  });
  const outputs = params.store.listOutputs({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    limit: 200,
    offset: 0,
  });
  const lastEventAt =
    params.turnResult.completedAt ??
    params.turnResult.updatedAt ??
    new Date().toISOString();
  const fields: Parameters<RuntimeStateStore["updateSubagentRun"]>[0]["fields"] =
    {
      latestChildInputId: params.record.inputId,
      startedAt: run.startedAt ?? params.turnResult.startedAt,
      lastEventAt,
      latestProgressPayload: null,
    };

  if (!status) {
    return (
      params.store.updateSubagentRun({
        workspaceId: run.workspaceId,
        subagentId: run.subagentId,
        fields,
      }) ?? run
    );
  }

  const summary = subagentLifecycleSummary({
    run,
    turnResult: params.turnResult,
    status,
  });
  const payload = subagentLifecyclePayload({
    store: params.store,
    run,
    turnResult: params.turnResult,
    status,
    summary,
    outputs,
    record: params.record,
  });
  fields.status = status;
  fields.summary = summary;

  if (status === "waiting_on_user") {
    fields.currentChildInputId = params.record.inputId;
    fields.completedAt = null;
    fields.blockingPayload = payload;
    fields.resultPayload = null;
    fields.errorPayload = null;
  } else if (status === "completed") {
    fields.currentChildInputId = null;
    fields.completedAt = lastEventAt;
    fields.blockingPayload = null;
    fields.resultPayload = payload;
    fields.errorPayload = null;
    params.store.ensureSession(
      {
        workspaceId: run.workspaceId,
        sessionId: run.childSessionId,
        archivedAt: lastEventAt,
      },
      { touchExisting: false },
    );
  } else {
    fields.currentChildInputId = null;
    fields.completedAt = lastEventAt;
    fields.blockingPayload = null;
    fields.resultPayload = null;
    fields.errorPayload = payload;
    if (status === "cancelled") {
      fields.cancelledAt = run.cancelledAt ?? lastEventAt;
    }
  }

  const updated =
    params.store.updateSubagentRun({
      workspaceId: run.workspaceId,
      subagentId: run.subagentId,
      fields,
    }) ?? run;

  supersedePendingSubagentEvents({
    store: params.store,
    run: updated,
  });
  const deliveryBucket =
    status === "waiting_on_user" ? "waiting_on_user" : "background_update";
  params.store.enqueueMainSessionEvent({
    workspaceId: updated.workspaceId,
    ownerMainSessionId: updated.ownerMainSessionId,
    originMainSessionId: updated.originMainSessionId,
    subagentId: updated.subagentId,
    eventType: status,
    deliveryBucket,
    coalesceKey: `${updated.ownerMainSessionId}:${deliveryBucket}`,
    earliestDeliverAt: plusMillisecondsIso(
      lastEventAt,
      SUBAGENT_EVENT_COALESCE_WINDOW_MS,
    ),
    latestDeliverAt:
      status === "waiting_on_user"
        ? null
        : plusMillisecondsIso(lastEventAt, SUBAGENT_EVENT_IDLE_TIMEOUT_MS),
    payload,
  });
  return updated;
}

function mainSessionEventIdsFromContext(
  context: Record<string, unknown> | null | undefined,
): string[] {
  const ids = Array.isArray(context?.main_session_event_ids)
    ? context?.main_session_event_ids
    : [];
  return ids
    .map((value) => optionalString(value))
    .filter((value): value is string => Boolean(value));
}

function mainSessionEventRetryAttemptCount(
  payload: Record<string, unknown> | null | undefined,
): number {
  const retry =
    payload && isRecord(payload.delivery_retry) ? payload.delivery_retry : null;
  const rawValue = retry?.attempt_count;
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return 0;
  }
  return Math.max(0, Math.floor(rawValue));
}

function nextMainSessionEventRetryDelayMs(attemptCount: number): number {
  const normalizedAttemptCount = Math.max(1, Math.floor(attemptCount));
  const exponent = Math.max(0, normalizedAttemptCount - 1);
  return Math.min(
    MAIN_SESSION_EVENT_RETRY_MAX_DELAY_MS,
    MAIN_SESSION_EVENT_RETRY_BASE_DELAY_MS * (2 ** exponent),
  );
}

function requeueMainSessionEventForRetry(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  eventId: string;
  completedAt: string;
  stopReason: string | null;
  incrementAttemptCount: boolean;
}): void {
  const existing = params.store.getMainSessionEvent({
    workspaceId: params.workspaceId,
    eventId: params.eventId,
  });
  if (!existing) {
    return;
  }
  const basePayload = isRecord(existing.payload) ? existing.payload : {};
  const priorAttemptCount = mainSessionEventRetryAttemptCount(basePayload);
  const attemptCount = params.incrementAttemptCount
    ? priorAttemptCount + 1
    : priorAttemptCount;
  const retryDelayMs = params.incrementAttemptCount
    ? nextMainSessionEventRetryDelayMs(attemptCount)
    : 0;
  const earliestDeliverAt =
    retryDelayMs > 0
      ? plusMillisecondsIso(params.completedAt, retryDelayMs)
      : params.completedAt;
  const retryPayload: Record<string, unknown> = {
    ...basePayload,
    delivery_retry: {
      attempt_count: attemptCount,
      retry_delay_ms: retryDelayMs,
      next_retry_at: earliestDeliverAt,
      last_stop_reason: params.stopReason ?? null,
      last_attempt_at: params.completedAt,
    },
  };
  params.store.updateMainSessionEvent({
    workspaceId: params.workspaceId,
    eventId: params.eventId,
    fields: {
      status: "pending",
      payload: retryPayload,
      materializedInputId: null,
      deliveredAt: null,
      earliestDeliverAt,
    },
  });
}

function maybeFinalizeMainSessionEvents(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  turnResult: TurnResultRecord;
}): void {
  const context = isRecord(params.record.payload.context)
    ? params.record.payload.context
    : null;
  const eventIds = mainSessionEventIdsFromContext(context);
  if (eventIds.length === 0) {
    return;
  }
  const now =
    params.turnResult.completedAt ??
    params.turnResult.updatedAt ??
    new Date().toISOString();
  if (
    params.turnResult.status !== "failed" &&
    params.turnResult.status !== "paused"
  ) {
    params.store.markMainSessionEventsDelivered({
      workspaceId: params.record.workspaceId,
      eventIds,
      deliveredAt: now,
    });
    return;
  }
  for (const eventId of eventIds) {
    requeueMainSessionEventForRetry({
      store: params.store,
      workspaceId: params.record.workspaceId,
      eventId,
      completedAt: now,
      stopReason: params.turnResult.stopReason ?? null,
      incrementAttemptCount: params.turnResult.status === "failed",
    });
  }
}

function persistTurnResult(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  startedAt: string;
  completedAt: string | null;
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR";
  stopReason: string | null;
  assistantText: string;
  toolUsageSummary: Record<string, unknown>;
  permissionDenials: Array<Record<string, unknown>>;
  promptSectionIds: string[];
  capabilityManifestFingerprint: string | null;
  requestSnapshotFingerprint: string | null;
  promptCacheProfile: Record<string, unknown> | null;
  contextBudgetDecisions: Record<string, unknown> | null;
  tokenUsage: Record<string, unknown> | null;
}): TurnResultRecord {
  return params.store.upsertTurnResult({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    status: turnResultStatusFromTerminalStatus(params.terminalStatus),
    stopReason: params.stopReason,
    assistantText: params.assistantText,
    toolUsageSummary: params.toolUsageSummary,
    permissionDenials: params.permissionDenials,
    promptSectionIds: params.promptSectionIds,
    capabilityManifestFingerprint: params.capabilityManifestFingerprint,
    requestSnapshotFingerprint: params.requestSnapshotFingerprint,
    promptCacheProfile: params.promptCacheProfile,
    contextBudgetDecisions: params.contextBudgetDecisions,
    tokenUsage: params.tokenUsage,
  });
}

function appendNextOutputEvent(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  lastSequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}): number {
  const nextSequence = Math.max(0, params.lastSequence) + 1;
  params.store.appendOutputEvent({
    workspaceId: params.record.workspaceId,
    sessionId: params.record.sessionId,
    inputId: params.record.inputId,
    sequence: nextSequence,
    eventType: params.eventType,
    payload: params.payload,
    createdAt: params.createdAt,
  });
  return nextSequence;
}

function terminalStatusForCompletedPayload(
  payload: Record<string, unknown>,
  supportsWaitingUser: boolean,
): "IDLE" | "WAITING_USER" | "PAUSED" {
  const status =
    typeof payload.status === "string"
      ? payload.status.trim().toLowerCase()
      : "";
  if (status === "paused") {
    return "PAUSED";
  }
  return supportsWaitingUser && status === "waiting_user"
    ? "WAITING_USER"
    : "IDLE";
}

function backendRunStatePayload(params: {
  terminalEventType: "run_completed" | "run_failed";
  terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR";
  stopReason: string | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> | null {
  if (
    params.terminalStatus !== "WAITING_USER" &&
    params.terminalStatus !== "PAUSED"
  ) {
    return null;
  }
  const status =
    params.terminalStatus === "WAITING_USER" ? "waiting_user" : "paused";
  const message =
    optionalString(params.payload.summary) ??
    optionalString(params.payload.message) ??
    (status === "waiting_user"
      ? "Run paused waiting for user input"
      : "Run paused by user request");
  const relayPayload: Record<string, unknown> = {
    status,
    stop_reason: params.stopReason ?? status,
    source: nonEmptyString(params.payload.source) ?? "runner",
    terminal_event_type: params.terminalEventType,
  };
  if (message) {
    relayPayload.message = message;
  }
  const harnessSessionId = nonEmptyString(params.payload.harness_session_id);
  if (harnessSessionId) {
    relayPayload.harness_session_id = harnessSessionId;
  }
  return relayPayload;
}

function maybePersistHarnessSessionId(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  harness: string;
  eventType: string;
  payload: Record<string, unknown>;
  allowBindingPersistence?: boolean;
}): void {
  if (params.allowBindingPersistence === false) {
    return;
  }
  if (!["run_completed", "run_failed"].includes(params.eventType)) {
    return;
  }
  const harnessSessionId = nonEmptyString(params.payload.harness_session_id);
  if (!harnessSessionId) {
    return;
  }
  params.store.upsertBinding({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    harness: params.harness,
    harnessSessionId,
  });
}

export async function processClaimedInput(params: {
  store: RuntimeStateStore;
  record: SessionInputRecord;
  claimedBy?: string;
  leaseSeconds?: number;
  memoryService?: MemoryServiceLike | null;
  runEvolveTasksFn?: typeof runEvolveTasks;
  wakeDurableMemoryWorker?: (() => void) | null;
  onEvolveTaskError?: (taskName: string, error: unknown) => void;
  executeRunnerRequestFn?: typeof executeRunnerRequest;
  resolveProductRuntimeConfigFn?: typeof resolveProductRuntimeConfig;
  resolveRuntimeModelClientFn?: typeof resolveRuntimeModelClient;
  registerRunStartedFn?: typeof registerWorkspaceAgentRunStarted;
  relayRunEventFn?: typeof registerWorkspaceAgentRunEvent;
  enqueueSessionCheckpointJobFn?: typeof enqueueSessionCheckpointJob;
  waitForSessionCheckpointCompletionFn?: typeof waitForSessionCheckpointCompletion;
  runPiSessionCompactionFn?: (
    requestPayload: Record<string, unknown>,
  ) => Promise<PiCompactionCommandResult>;
  sessionCheckpointSessionOps?: SessionCheckpointSessionOps;
  captureRuntimeExceptionFn?: typeof captureRuntimeException;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { store, record } = params;
  const claimedBy =
    params.claimedBy ?? record.claimedBy ?? "sandbox-agent-ts-worker";
  const shouldTrackClaimOwnership = record.status === "CLAIMED";
  const leaseSeconds = params.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;
  const turnStartedAt = new Date().toISOString();
  const executionAbortController = new AbortController();
  const forwardAbortSignal = () => {
    if (executionAbortController.signal.aborted) {
      return;
    }
    const reason =
      typeof params.abortSignal?.reason === "string" &&
      params.abortSignal.reason.trim()
        ? params.abortSignal.reason.trim()
        : "aborted";
    executionAbortController.abort(reason);
  };
  if (params.abortSignal?.aborted) {
    forwardAbortSignal();
  } else {
    params.abortSignal?.addEventListener("abort", forwardAbortSignal, {
      once: true,
    });
  }
  const workspace = store.getWorkspace(record.workspaceId);
  if (!workspace) {
    store.updateInput({
      workspaceId: record.workspaceId,
      inputId: record.inputId,
      fields: {
        status: "FAILED",
        claimedBy: null,
        claimedUntil: null,
      },
    });
    store.updateRuntimeState({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      status: "ERROR",
      currentInputId: null,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: { message: "workspace not found" },
    });
    const completedAt = new Date().toISOString();
    persistTurnResult({
      store,
      record,
      startedAt: turnStartedAt,
      completedAt,
      terminalStatus: "ERROR",
      stopReason: "workspace_not_found",
      assistantText: "",
      toolUsageSummary: summarizeToolCalls(new Map()),
      permissionDenials: [],
      promptSectionIds: [],
        capabilityManifestFingerprint: null,
        requestSnapshotFingerprint: null,
        promptCacheProfile: null,
        contextBudgetDecisions: buildMergedContextBudgetPayload({
          startedAt: turnStartedAt,
          completedAt,
          terminalStatus: "ERROR",
          stopReason: "workspace_not_found",
          tokenUsage: null,
          contextUsage: null,
          promptCacheProfile: null,
          telemetry: createTurnContextBudgetTelemetry(),
          toolCallCount: 0,
          toolReplayTrimmed: false,
          checkpointQueued: false,
        }),
        tokenUsage: null,
      });
    return;
  }

  const selectedModel = nonEmptyString(record.payload.model);
  const runId = claimedInputRunId({
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    inputId: record.inputId,
  });

  const executeClaimedInput = async (): Promise<void> => {
    // Before doing any real work for this turn, hold the input if the
    // agent has open propose_connect cards that the user has not yet
    // resolved. Letting a turn run with partial integrations leads to
    // half-done work + the agent reporting "done" while the dashboard
    // still says "needs connection". Release the claim, requeue with a
    // deferred available_at so the worker doesn't spin, and emit a
    // waiting event the chat UI can render as a paused banner. The
    // input gets re-claimed when OAuth finalize wakes the queue.
    const proposalGate = evaluatePendingIntegrationProposals({
      store,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
    });
    if (proposalGate.blocked) {
      const deferUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const latestEvent = store
        .listOutputEvents({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          includeHistory: true,
        })
        .reduce((max, event) => Math.max(max, event.sequence ?? 0), 0);
      store.appendOutputEvent({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        inputId: record.inputId,
        sequence: latestEvent + 1,
        eventType: "waiting_on_pending_integrations",
        payload: {
          proposed_slugs: proposalGate.proposedSlugs,
          unresolved_slugs: proposalGate.unresolvedSlugs,
          message:
            "Waiting for the user to finish connecting required integrations.",
        },
      });
      store.updateInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
        fields: {
          status: "QUEUED",
          claimedBy: null,
          claimedUntil: null,
          availableAt: deferUntil,
        },
      });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "WAITING_ON_USER",
        currentInputId: record.inputId,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
      return;
    }

    const harness = normalizeHarnessId(workspace.harness ?? selectedHarness());
    const workspaceDir = store.workspaceDir(record.workspaceId);
    const session = store.getSession({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
    });
    const sessionKind = inferSessionKind({
      workspace,
      sessionId: record.sessionId,
      persistedKind: session?.kind,
    });
    const harnessSupportsWaitingUser =
      resolveRuntimeHarnessAdapter(harness)?.capabilities.supportsWaitingUser ??
      false;
    const harnessSessionId = ensureLocalBinding({
      store,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      harness,
    });
    let checkpointHarnessSessionId = harnessSessionId;
    let activeLeaseUntil =
      record.claimedUntil ?? claimLeaseUntilIso(leaseSeconds);
    let lastClaimRenewalAtMs = 0;
    let claimOwnershipLost = false;
    const EVENT_CLAIM_RENEWAL_MIN_INTERVAL_MS = 250;
    const claimStillOwned = () => {
      if (!shouldTrackClaimOwnership) {
        return true;
      }
      const currentRecord = store.getInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
      });
      return (
        currentRecord?.status === "CLAIMED" &&
        currentRecord.claimedBy === claimedBy
      );
    };
    const markClaimOwnershipLost = (
      source: "checkpoint" | "heartbeat" | "event",
    ) => {
      if (!shouldTrackClaimOwnership || claimOwnershipLost) {
        return false;
      }
      claimOwnershipLost = true;
      if (!executionAbortController.signal.aborted) {
        executionAbortController.abort("claim_lost");
      }
      (params.captureRuntimeExceptionFn ?? captureRuntimeException)({
        error: new Error("claimed input lost ownership during execution"),
        level: "warning",
        fingerprint: ["runtime", "claimed_input", "claim_lost", harness],
        tags: {
          surface: "claimed_input_executor",
          failure_kind: "claim_lost",
          harness,
          session_kind: sessionKind,
        },
        contexts: {
          claimed_input: {
            workspace_id: record.workspaceId,
            session_id: record.sessionId,
            input_id: record.inputId,
            run_id: runId,
            harness_session_id: checkpointHarnessSessionId,
            selected_model: selectedModel,
          },
        },
        extras: {
          source,
          claimed_by: claimedBy,
          claimed_until:
            store.getInput({
              workspaceId: record.workspaceId,
              inputId: record.inputId,
            })?.claimedUntil ?? null,
        },
      });
      return true;
    };
    const renewClaimLeaseOnly = (source: "checkpoint" | "heartbeat" | "event") => {
      const nowMs = Date.now();
      if (
        source === "event" &&
        nowMs - lastClaimRenewalAtMs < EVENT_CLAIM_RENEWAL_MIN_INTERVAL_MS
      ) {
        if (shouldTrackClaimOwnership && !claimStillOwned()) {
          markClaimOwnershipLost(source);
          return false;
        }
        return !claimOwnershipLost;
      }

      if (shouldTrackClaimOwnership) {
        const renewedClaim = store.renewInputClaim({
          workspaceId: record.workspaceId,
          inputId: record.inputId,
          claimedBy,
          leaseSeconds,
        });
        if (!renewedClaim?.claimedUntil) {
          markClaimOwnershipLost(source);
          return false;
        }
        activeLeaseUntil = renewedClaim.claimedUntil;
      }
      lastClaimRenewalAtMs = nowMs;
      return !claimOwnershipLost;
    };
    await (
      params.waitForSessionCheckpointCompletionFn ??
      waitForSessionCheckpointCompletion
    )({
      store,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      wakeWorker: params.wakeDurableMemoryWorker ?? null,
      renewLease: () => {
        renewClaimLeaseOnly("checkpoint");
      },
      abortSignal: executionAbortController.signal,
    });
    if (claimOwnershipLost || !claimStillOwned()) {
      return;
    }
    const attachments = sessionInputAttachments(record.payload.attachments);
    const imageUrls = sessionInputImageUrls(record.payload.image_urls);
    const inputContext = isRecord(record.payload.context)
      ? record.payload.context
      : null;
    const inputSource = optionalString(inputContext?.source)?.toLowerCase();

    const instruction = instructionWithInlineBackgroundUpdates({
      baseInstruction: buildOnboardingInstruction({
        workspaceRoot: store.workspaceRoot,
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        text: String(record.payload.text ?? ""),
        attachments,
        imageUrls,
        workspace,
      }),
      context: inputContext,
    });
    if (inputSource !== "main_session_event_batch") {
      store.insertSessionMessage({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        role: "user",
        text: String(record.payload.text ?? ""),
        metadata: attachments.length > 0 ? { attachments } : {},
        messageId: `user-${record.inputId}`,
        createdAt: turnStartedAt,
      });
    }

    store.updateRuntimeState({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      status: "BUSY",
      currentInputId: record.inputId,
      currentWorkerId: claimedBy,
      leaseUntil: activeLeaseUntil,
      heartbeatAt: undefined,
      lastError: null,
    });

    const runtimeContext = isRecord(record.payload.context)
      ? { ...record.payload.context }
      : {};
    const priorExecContext = isRecord(runtimeContext[RUNTIME_EXEC_CONTEXT_KEY])
      ? { ...runtimeContext[RUNTIME_EXEC_CONTEXT_KEY] }
      : {};
    let ephemeralPiFollowupRun: EphemeralPiFollowupRunState | null = null;
    let useEphemeralHarnessSession = false;
    const resolveRuntimeConfig =
      params.resolveProductRuntimeConfigFn ?? resolveProductRuntimeConfig;
    const runtimeBinding = resolveRuntimeConfig({
      requireAuth: false,
      requireUser: false,
      requireBaseUrl: false,
    });
    if (inputSource === "main_session_event_batch" && harness === "pi") {
      try {
        ephemeralPiFollowupRun = prepareEphemeralPiFollowupRun({
          workspaceDir,
          harnessSessionId,
        });
        useEphemeralHarnessSession = true;
        if (ephemeralPiFollowupRun.liveSessionFile) {
          checkpointHarnessSessionId = ephemeralPiFollowupRun.liveSessionFile;
        }
      } catch (error) {
        (params.captureRuntimeExceptionFn ?? captureRuntimeException)({
          error,
          level: "warning",
          fingerprint: [
            "runtime",
            "claimed_input",
            "followup_snapshot_prepare_failed",
            harness,
          ],
          tags: {
            surface: "claimed_input_executor",
            failure_kind: "followup_snapshot_prepare_failed",
            harness,
            session_kind: sessionKind,
          },
          contexts: {
            claimed_input: {
              workspace_id: record.workspaceId,
              session_id: record.sessionId,
              input_id: record.inputId,
              run_id: runId,
              harness_session_id: checkpointHarnessSessionId,
              selected_model: selectedModel,
            },
          },
        });
      }
    }
    if (
      typeof priorExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY] !==
        "string" &&
      runtimeBinding.authToken
    ) {
      priorExecContext[RUNTIME_EXEC_MODEL_PROXY_API_KEY_KEY] =
        runtimeBinding.authToken;
    }
    if (
      typeof priorExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY] !== "string" &&
      runtimeBinding.sandboxId
    ) {
      priorExecContext[RUNTIME_EXEC_SANDBOX_ID_KEY] = runtimeBinding.sandboxId;
    }
    if (!nonEmptyString(priorExecContext[RUNTIME_EXEC_RUN_ID_KEY])) {
      priorExecContext[RUNTIME_EXEC_RUN_ID_KEY] = runId;
    }
    priorExecContext.harness = harness;
    priorExecContext.harness_session_id =
      ephemeralPiFollowupRun?.snapshotSessionFile ?? harnessSessionId;
    if (useEphemeralHarnessSession) {
      priorExecContext[RUNTIME_EXEC_EPHEMERAL_HARNESS_SESSION_KEY] = true;
    }
    runtimeContext[RUNTIME_EXEC_CONTEXT_KEY] = priorExecContext;
    const registerRunStarted =
      params.registerRunStartedFn ?? registerWorkspaceAgentRunStarted;
    const relayRunEvent =
      params.relayRunEventFn ?? registerWorkspaceAgentRunEvent;
    const enqueueCheckpointJob =
      params.enqueueSessionCheckpointJobFn ?? enqueueSessionCheckpointJob;
    await registerRunStarted({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.inputId,
      runId,
      selectedModel,
      runtimeBinding,
      captureRuntimeExceptionFn: params.captureRuntimeExceptionFn,
    });

    const harnessTimeoutSeconds =
      resolveRuntimeHarnessPlugin(harness)?.timeoutSeconds({
        request: {
          workspace_id: record.workspaceId,
          session_id: record.sessionId,
          session_kind: sessionKind,
          input_id: record.inputId,
          instruction,
        },
      }) ?? null;
    const captureClaimedInputFailure = (
      failureKind: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) => {
      const sanitizedExtra = sanitizeRuntimeSentryValue(extra);
      const sanitizedMessage = truncateRuntimeSentryText(
        message,
        CLAIMED_INPUT_SENTRY_EVENT_PREVIEW_LIMIT,
      );
      (
        params.captureRuntimeExceptionFn ?? captureRuntimeException
      )({
        error: new Error(sanitizedMessage),
        level: "error",
        fingerprint: ["runtime", "claimed_input", failureKind, harness],
        tags: {
          surface: "claimed_input_executor",
          failure_kind: failureKind,
          harness,
          session_kind: sessionKind,
        },
        contexts: {
          claimed_input: {
            workspace_id: record.workspaceId,
            session_id: record.sessionId,
            input_id: record.inputId,
            run_id: runId,
            harness_session_id: checkpointHarnessSessionId,
            selected_model: selectedModel,
          },
          runtime_binding: runtimeBindingSentryContext({
            runtimeBinding,
            runtimeExecContext: priorExecContext,
          }),
        },
        extras: {
          last_sequence: lastSequence,
          harness_timeout_seconds: harnessTimeoutSeconds,
          tool_usage_summary: sanitizeRuntimeSentryValue(
            summarizeToolCalls(toolCallsById, skillInvocationsById, wideningAudit),
          ),
          permission_denials: sanitizeRuntimeSentryValue(
            permissionDenials.slice(0, CLAIMED_INPUT_SENTRY_PERMISSION_DENIAL_LIMIT),
          ),
          prompt_section_ids: promptSectionIds,
          capability_manifest_fingerprint: capabilityManifestFingerprint,
          request_snapshot_fingerprint: requestSnapshotFingerprint,
          prompt_cache_profile: sanitizeRuntimeSentryValue(promptCacheProfile),
          assistant_excerpt: assistantParts.length
            ? truncateRuntimeSentryText(
                assistantParts.join("").trim(),
                CLAIMED_INPUT_SENTRY_TEXT_LIMIT,
              )
            : null,
          recent_runner_events: sanitizeRuntimeSentryValue(recentRunnerEvents),
          ...(isRecord(sanitizedExtra) ? sanitizedExtra : {}),
        },
      });
    };

    const payload: Record<string, unknown> = {
      workspace_id: record.workspaceId,
      session_id: record.sessionId,
      session_kind: sessionKind,
      input_id: record.inputId,
      instruction,
      attachments,
      image_urls: imageUrls,
      context: runtimeContext,
      model: record.payload.model ?? null,
      thinking_value: record.payload.thinking_value ?? null,
      harness_timeout_seconds: harnessTimeoutSeconds,
      debug: false,
    };
    const baseRunnerInstruction = instruction;
    const synthesizedRequestSnapshotFingerprint =
      ensureClaimedInputTurnRequestSnapshot({
        store,
        record,
        sessionKind,
        harness,
        workspaceDir,
        instruction,
        attachments,
        imageUrls,
        runtimeContext,
        selectedModel,
        harnessTimeoutSeconds,
        runtimeBinding,
        runtimeExecContext: priorExecContext,
        resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
      });
    const memoryWritebackModelContext = writebackModelContext({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.inputId,
      instruction,
      model: record.payload.model ?? null,
      runtimeBinding,
      runtimeExecContext: priorExecContext,
    });

    const assistantParts: string[] = [];
    let capturedPiAssistantMessage: Record<string, unknown> | null = null;
    let syncedEphemeralLiveSessionFile: string | null = null;
    let terminalStatus: "IDLE" | "WAITING_USER" | "PAUSED" | "ERROR" = "IDLE";
    let lastError: Record<string, unknown> | null = null;
    let lastSequence = 0;
    let completedAt: string | null = null;
    let stopReason: string | null = null;
    let tokenUsage: Record<string, unknown> | null = null;
    let contextUsage: PiContextUsage | null = null;
    let promptSectionIds: string[] = [];
    let capabilityManifestFingerprint: string | null = null;
    let requestSnapshotFingerprint: string | null =
      synthesizedRequestSnapshotFingerprint;
    let promptCacheProfile: Record<string, unknown> | null = null;
    let toolReplayTrimmed = false;
    let preRunCompaction: PreRunCompactionTelemetryRecord | null = null;
    let overflowRecovery: OverflowRecoveryTelemetryRecord | null = null;
    let providerTerminationRecovery: ProviderTerminationRecoveryTelemetryRecord | null =
      null;
    const toolCallsById = new Map<
      string,
      {
        toolName: string;
        toolId: string | null;
        completed: boolean;
        error: boolean;
        browserUsage: Record<string, unknown> | null;
      }
    >();
    const skillInvocationsById = new Map<string, SkillInvocationSummaryEntry>();
    const wideningAudit = createSkillWideningAudit();
    const permissionDenials: Array<Record<string, unknown>> = [];
    const recentRunnerEvents: Array<Record<string, unknown>> = [];
    const contextBudgetTelemetry = createTurnContextBudgetTelemetry();
    let deferredTerminalEvent: {
      eventType: "run_completed" | "run_failed";
      payload: Record<string, unknown>;
      createdAt: string;
    } | null = null;
    let terminalFailureCaptured = false;
    let workspaceFileManifestBefore: WorkspaceFileManifest | null = null;
    let lastRelayedRunEventSequence = 0;
    let pendingOutputDeltaPayload: Record<string, unknown> | null = null;
    let pendingOutputDeltaSequence = 0;
    let pendingOutputDeltaTimestamp: string | null = null;

    const relayBackendRunEvent = async (relayParams: {
      eventType: BackendAgentRunEventType;
      payload: Record<string, unknown>;
      timestamp: string;
      preferredSequence: number;
    }): Promise<void> => {
      const relaySequence = Math.max(
        Math.max(0, relayParams.preferredSequence),
        lastRelayedRunEventSequence + 1,
        1,
      );
      lastRelayedRunEventSequence = relaySequence;
      await relayRunEvent({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        inputId: record.inputId,
        runId,
        sequence: relaySequence,
        eventType: relayParams.eventType,
        payload: relayParams.payload,
        timestamp: relayParams.timestamp,
        runtimeBinding,
        captureRuntimeExceptionFn: params.captureRuntimeExceptionFn,
      });
    };

    const flushPendingOutputDelta = async (): Promise<void> => {
      if (!pendingOutputDeltaPayload || !pendingOutputDeltaTimestamp) {
        pendingOutputDeltaPayload = null;
        pendingOutputDeltaSequence = 0;
        pendingOutputDeltaTimestamp = null;
        return;
      }
      await relayBackendRunEvent({
        eventType: "output_delta",
        payload: pendingOutputDeltaPayload,
        timestamp: pendingOutputDeltaTimestamp,
        preferredSequence: pendingOutputDeltaSequence,
      });
      pendingOutputDeltaPayload = null;
      pendingOutputDeltaSequence = 0;
      pendingOutputDeltaTimestamp = null;
    };

    try {
      workspaceFileManifestBefore = collectWorkspaceFileManifest(workspaceDir);
    } catch {
      workspaceFileManifestBefore = null;
    }

    const renewClaimLease = (source: "heartbeat" | "event") => {
      const nowMs = Date.now();
      if (
        source === "event" &&
        nowMs - lastClaimRenewalAtMs < EVENT_CLAIM_RENEWAL_MIN_INTERVAL_MS
      ) {
        if (shouldTrackClaimOwnership && !claimStillOwned()) {
          markClaimOwnershipLost(source);
          return false;
        }
        return !claimOwnershipLost;
      }

      if (shouldTrackClaimOwnership) {
        const renewedClaim = store.renewInputClaim({
          workspaceId: record.workspaceId,
          inputId: record.inputId,
          claimedBy,
          leaseSeconds,
        });
        if (!renewedClaim?.claimedUntil) {
          markClaimOwnershipLost(source);
          return false;
        }
        activeLeaseUntil = renewedClaim.claimedUntil;
      }
      lastClaimRenewalAtMs = nowMs;
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "BUSY",
        currentInputId: record.inputId,
        currentWorkerId: claimedBy,
        leaseUntil: activeLeaseUntil,
        lastError: null,
      });
      return !claimOwnershipLost;
    };

    try {
      const snapshotRecord = store.getTurnRequestSnapshot({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
      });
      const snapshotPayload = isRecord(snapshotRecord?.payload)
        ? snapshotRecord.payload
        : null;
      const { previousSelectedModel, previousContextUsage } =
        latestPriorTurnCompactionContext({
          store,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          currentInputId: record.inputId,
        });
      const initialPreRunDecision = evaluatePreRunSessionCompaction({
        liveSessionFile: checkpointHarnessSessionId,
        snapshotPayload,
        selectedModel,
        previousSelectedModel,
        previousContextUsage,
      });
      if (initialPreRunDecision.decision !== "fit") {
        const initialPreRunCompaction: PreRunCompactionTelemetryRecord = {
          initial_decision: initialPreRunDecision.decision,
          final_decision: initialPreRunDecision.decision,
          trigger_reason: initialPreRunDecision.reason,
          previous_selected_model: initialPreRunDecision.previousSelectedModel,
          target_selected_model: initialPreRunDecision.targetSelectedModel,
          previous_context_window: initialPreRunDecision.previousContextWindow,
          target_context_window: initialPreRunDecision.targetContextWindow,
          before_session_tokens: initialPreRunDecision.currentSessionTokens,
          after_session_tokens: null,
          estimated_request_tokens: initialPreRunDecision.estimatedRequestTokens,
          projected_total_tokens: initialPreRunDecision.projectedTotalTokens,
          compaction_attempted: Boolean(snapshotPayload),
          compaction_changed_branch: false,
          reset_required: false,
        };
        preRunCompaction = initialPreRunCompaction;
        if (!snapshotPayload) {
          if (initialPreRunDecision.decision === "would_overflow") {
            preRunCompaction = {
              ...initialPreRunCompaction,
              final_decision: "reset_required",
              reset_required: true,
            };
            throw new SessionResetRequiredError(
              `pre-run session compaction could not make the next prompt fit ${selectedModel ?? "the selected model"}; session reset required`,
            );
          }
        } else {
          const liveSessionState =
            params.sessionCheckpointSessionOps?.currentLeafCheckpointState(
              checkpointHarnessSessionId,
            ) ?? currentPiSessionLeafState(checkpointHarnessSessionId);
          const compactionResult = await forceCompactSessionWithSnapshotMerge({
            store,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            inputId: record.inputId,
            harnessSessionId: checkpointHarnessSessionId,
            baseLeafId: liveSessionState.leafId,
            baseLatestCompactionId: liveSessionState.latestCompactionId,
            runPiSessionCompactionFn: params.runPiSessionCompactionFn,
            resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
            sessionOps: params.sessionCheckpointSessionOps,
          });
          const finalPreRunDecision = evaluatePreRunSessionCompaction({
            liveSessionFile: checkpointHarnessSessionId,
            snapshotPayload,
            selectedModel,
            previousSelectedModel,
            previousContextUsage: null,
          });
          const currentPreRunCompaction =
            preRunCompaction ?? initialPreRunCompaction;
          preRunCompaction = {
            ...currentPreRunCompaction,
            final_decision: finalPreRunDecision.decision,
            after_session_tokens: finalPreRunDecision.currentSessionTokens,
            estimated_request_tokens:
              finalPreRunDecision.estimatedRequestTokens ??
              currentPreRunCompaction.estimated_request_tokens,
            projected_total_tokens:
              finalPreRunDecision.projectedTotalTokens ??
              currentPreRunCompaction.projected_total_tokens,
            compaction_changed_branch: compactionResult.merged,
          };
          if (finalPreRunDecision.decision === "would_overflow") {
            preRunCompaction = {
              ...preRunCompaction,
              final_decision: "reset_required",
              reset_required: true,
            };
            throw new SessionResetRequiredError(
              `pre-run session compaction could not make the next prompt fit ${selectedModel ?? "the selected model"}; session reset required`,
            );
          }
        }
      }
      const executeRunner =
        params.executeRunnerRequestFn ?? executeRunnerRequest;
      let terminalEventToRelay:
        | {
            eventType: "run_completed" | "run_failed";
            sequence: number;
            payload: Record<string, unknown>;
            createdAt: string;
          }
        | null = null;
      let runnerSequenceOffset = 0;
      const prepareRunnerRetry = (failureMessage?: string | null) => {
        runnerSequenceOffset = Math.max(runnerSequenceOffset, lastSequence);
        payload.instruction = instructionWithRetryContinuationPrompt({
          baseInstruction: baseRunnerInstruction,
          failureMessage,
        });
        assistantParts.length = 0;
        capturedPiAssistantMessage = null;
        terminalStatus = "IDLE";
        lastError = null;
        completedAt = null;
        stopReason = null;
        tokenUsage = null;
        contextUsage = null;
        promptSectionIds = [];
        capabilityManifestFingerprint = null;
        requestSnapshotFingerprint = null;
        promptCacheProfile = null;
        toolReplayTrimmed = false;
        deferredTerminalEvent = null;
        pendingOutputDeltaPayload = null;
        pendingOutputDeltaSequence = 0;
        pendingOutputDeltaTimestamp = null;
        toolCallsById.clear();
        skillInvocationsById.clear();
        permissionDenials.length = 0;
      };

      for (let runnerAttempt = 1; runnerAttempt <= 2; runnerAttempt += 1) {
        const execution = await executeRunner(payload, {
          signal: executionAbortController.signal,
          onHeartbeat: () => {
            renewClaimLease("heartbeat");
          },
          onEvent: async (rawEvent) => {
            if (!renewClaimLease("event")) {
              return;
            }
            const event = runnerEventWithSequenceOffset(
              rawEvent,
              runnerSequenceOffset,
            );
            const sequence =
              typeof event.sequence === "number" ? event.sequence : 0;
            lastSequence = Math.max(lastSequence, sequence);
            let eventPayload = payloadForEvent(event);
            if (useEphemeralHarnessSession) {
              eventPayload = sanitizeEphemeralHarnessSessionPayload({
                payload: eventPayload,
                liveSessionFile: ephemeralPiFollowupRun?.liveSessionFile ?? null,
              });
            }
            const eventTimestamp = eventTimestampOrNow(event);
            const eventType =
              typeof event.event_type === "string"
                ? event.event_type
                : "unknown";
            updateTurnContextBudgetTelemetryFromEvent(
              contextBudgetTelemetry,
              eventType,
              eventPayload,
            );
            recentRunnerEvents.push(
              summarizeRunnerEventForSentry({
                sequence,
                eventType,
                timestamp: eventTimestamp,
                payload: eventPayload,
              }),
            );
            if (
              recentRunnerEvents.length > CLAIMED_INPUT_SENTRY_RECENT_EVENT_LIMIT
            ) {
              recentRunnerEvents.splice(
                0,
                recentRunnerEvents.length -
                  CLAIMED_INPUT_SENTRY_RECENT_EVENT_LIMIT,
              );
            }
            const terminalHarnessSessionId = nonEmptyString(
              eventPayload.harness_session_id,
            );
            if (terminalHarnessSessionId) {
              checkpointHarnessSessionId = terminalHarnessSessionId;
            }
            if (eventType === "pi_native_event") {
              capturedPiAssistantMessage =
                assistantMessageFromPiNativeEventPayload(eventPayload) ??
                capturedPiAssistantMessage;
            }
            if (eventType === "run_completed" || eventType === "run_failed") {
              deferredTerminalEvent = {
                eventType,
                payload: eventPayload,
                createdAt: eventTimestamp,
              };
            } else {
              store.appendOutputEvent({
                workspaceId: record.workspaceId,
                sessionId: record.sessionId,
                inputId: record.inputId,
                sequence,
                eventType,
                payload: eventPayload,
                createdAt: eventTimestamp,
              });
            }
            maybePersistHarnessSessionId({
              store,
              workspaceId: record.workspaceId,
              sessionId: record.sessionId,
              harness,
              eventType,
              payload: eventPayload,
              allowBindingPersistence: !useEphemeralHarnessSession,
            });
            if (
              event.event_type === "output_delta" &&
              typeof eventPayload.delta === "string"
            ) {
              assistantParts.push(eventPayload.delta);
              if (
                pendingOutputDeltaPayload &&
                canMergeOutputDeltaRelayPayload(
                  pendingOutputDeltaPayload,
                  eventPayload,
                ) &&
                String(pendingOutputDeltaPayload.delta ?? "").length +
                  eventPayload.delta.length <=
                  BACKEND_OUTPUT_DELTA_RELAY_FLUSH_CHARS
              ) {
                pendingOutputDeltaPayload = mergeOutputDeltaRelayPayload(
                  pendingOutputDeltaPayload,
                  eventPayload,
                );
              } else {
                await flushPendingOutputDelta();
                pendingOutputDeltaPayload = { ...eventPayload };
              }
              pendingOutputDeltaSequence = Math.max(sequence, 1);
              pendingOutputDeltaTimestamp = eventTimestamp;
            }
            if (event.event_type === "run_started") {
              promptSectionIds = stringList(eventPayload.prompt_section_ids);
              capabilityManifestFingerprint =
                typeof eventPayload.capability_manifest_fingerprint ===
                  "string" && eventPayload.capability_manifest_fingerprint.trim()
                  ? eventPayload.capability_manifest_fingerprint.trim()
                  : capabilityManifestFingerprint;
              requestSnapshotFingerprint =
                typeof eventPayload.request_snapshot_fingerprint === "string" &&
                eventPayload.request_snapshot_fingerprint.trim()
                  ? eventPayload.request_snapshot_fingerprint.trim()
                  : requestSnapshotFingerprint;
              promptCacheProfile =
                jsonRecord(eventPayload.prompt_cache_profile) ??
                promptCacheProfile;
            }
            if (event.event_type === "tool_call") {
              const callId =
                typeof eventPayload.call_id === "string" &&
                eventPayload.call_id.trim()
                  ? eventPayload.call_id.trim()
                  : `sequence:${sequence}`;
              const existingCall = toolCallsById.get(callId);
              const toolName =
                typeof eventPayload.tool_name === "string" &&
                eventPayload.tool_name.trim()
                  ? eventPayload.tool_name.trim()
                  : (existingCall?.toolName ?? "unknown");
              const toolId =
                typeof eventPayload.tool_id === "string" &&
                eventPayload.tool_id.trim()
                  ? eventPayload.tool_id.trim()
                  : (existingCall?.toolId ?? null);
              const completed =
                eventPayload.phase === "completed" ||
                existingCall?.completed === true;
              const errored =
                eventPayload.error === true || existingCall?.error === true;
              const browserUsage =
                browserUsageFromToolResult(eventPayload.result) ??
                existingCall?.browserUsage ??
                null;
              toolCallsById.set(callId, {
                toolName,
                toolId,
                completed,
                error: errored,
                browserUsage,
              });
              if (eventPayload.phase === "completed") {
                toolReplayTrimmed =
                  toolReplayTrimmed ||
                  toolReplayTrimmedFromToolResult(eventPayload.result);
              }
              const denial = permissionDenialFromEventPayload(eventPayload);
              if (denial) {
                permissionDenials.push(denial);
              }
            }
            if (
              event.event_type === "skill_invocation" ||
              event.event_type === "tool_call"
            ) {
              const callId =
                typeof eventPayload.call_id === "string" &&
                eventPayload.call_id.trim()
                  ? eventPayload.call_id.trim()
                  : `sequence:${sequence}`;
              const toolName = optionalString(eventPayload.tool_name);
              const isSkillInvocation =
                event.event_type === "skill_invocation" ||
                (toolName !== null && toolName.toLowerCase() === "skill");
              if (isSkillInvocation) {
                const existingInvocation = skillInvocationsById.get(callId);
                const toolArgs = jsonRecord(eventPayload.tool_args);
                const skillName =
                  optionalString(eventPayload.skill_name) ??
                  optionalString(eventPayload.requested_name) ??
                  optionalString(toolArgs?.name) ??
                  existingInvocation?.skillName ??
                  "unknown";
                const skillId =
                  optionalString(eventPayload.skill_id) ??
                  existingInvocation?.skillId ??
                  null;
                const completed =
                  eventPayload.phase === "completed" ||
                  existingInvocation?.completed === true;
                const error =
                  eventPayload.error === true ||
                  existingInvocation?.error === true;
                skillInvocationsById.set(callId, {
                  skillName,
                  skillId,
                  completed,
                  error,
                });
              }
            }
            if (event.event_type === "skill_invocation") {
              const scope = optionalString(eventPayload.widening_scope);
              if (scope) {
                wideningAudit.scope = scope;
              }
              if (
                typeof eventPayload.workspace_boundary_override === "boolean"
              ) {
                wideningAudit.workspaceBoundaryOverride =
                  eventPayload.workspace_boundary_override;
              }
              for (const toolName of stringList(eventPayload.managed_tools)) {
                wideningAudit.managedTools.add(toolName);
              }
              const grantedTools = stringList(eventPayload.granted_tools);
              for (const toolName of grantedTools) {
                wideningAudit.grantedTools.add(toolName);
              }
              for (const toolName of stringList(
                eventPayload.active_granted_tools,
              )) {
                wideningAudit.activeGrantedTools.add(toolName);
              }
              for (const commandId of stringList(eventPayload.managed_commands)) {
                wideningAudit.managedCommands.add(commandId);
              }
              const grantedCommands = stringList(eventPayload.granted_commands);
              for (const commandId of grantedCommands) {
                wideningAudit.grantedCommands.add(commandId);
              }
              for (const commandId of stringList(
                eventPayload.active_granted_commands,
              )) {
                wideningAudit.activeGrantedCommands.add(commandId);
              }
              if (
                eventPayload.phase === "completed" &&
                (grantedTools.length > 0 || grantedCommands.length > 0)
              ) {
                wideningAudit.activationCount += 1;
              }
            }
            if (
              event.event_type === "tool_call" &&
              isSkillPolicyDeniedPayload(eventPayload)
            ) {
              wideningAudit.deniedCalls += 1;
              const toolName = optionalString(eventPayload.tool_name);
              if (toolName) {
                wideningAudit.deniedToolNames.add(toolName);
              }
            }
            if (event.event_type === "run_completed") {
              terminalStatus = terminalStatusForCompletedPayload(
                eventPayload,
                harnessSupportsWaitingUser,
              );
              completedAt = eventTimestamp;
              stopReason = stopReasonForTerminalEvent({
                eventType: "run_completed",
                payload: eventPayload,
                terminalStatus,
              });
              tokenUsage = tokenUsageFromPayload(eventPayload) ?? tokenUsage;
              contextUsage =
                contextUsageFromPayload(eventPayload) ?? contextUsage;
            }
            if (event.event_type === "run_failed") {
              terminalStatus = "ERROR";
              lastError = eventPayload;
              completedAt = eventTimestamp;
              stopReason = stopReasonForTerminalEvent({
                eventType: "run_failed",
                payload: eventPayload,
                terminalStatus,
              });
              tokenUsage = tokenUsageFromPayload(eventPayload) ?? tokenUsage;
              contextUsage =
                contextUsageFromPayload(eventPayload) ?? contextUsage;
            }
            if (event.event_type === "tool_call") {
              await flushPendingOutputDelta();
              await relayBackendRunEvent({
                eventType: "tool_call",
                payload: eventPayload,
                timestamp: eventTimestamp,
                preferredSequence: Math.max(sequence, 1),
              });
            }
            if (event.event_type === "skill_invocation") {
              await flushPendingOutputDelta();
              await relayBackendRunEvent({
                eventType: "skill_invocation",
                payload: eventPayload,
                timestamp: eventTimestamp,
                preferredSequence: Math.max(sequence, 1),
              });
            }
          },
        });
        if (claimOwnershipLost || !claimStillOwned()) {
          return;
        }
        await flushPendingOutputDelta();

        const persistedTerminalEvent = latestPersistedTerminalOutputEvent({
          store,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          inputId: record.inputId,
        });

        if (persistedTerminalEvent) {
          const persistedPayload = persistedTerminalEvent.payload;
          const terminalHarnessSessionId = nonEmptyString(
            persistedPayload.harness_session_id,
          );
          if (terminalHarnessSessionId) {
            checkpointHarnessSessionId = terminalHarnessSessionId;
          }
          deferredTerminalEvent = null;
          if (persistedTerminalEvent.eventType === "run_completed") {
            terminalStatus = terminalStatusForCompletedPayload(
              persistedPayload,
              harnessSupportsWaitingUser,
            );
            lastError = null;
            completedAt = persistedTerminalEvent.createdAt;
            stopReason = stopReasonForTerminalEvent({
              eventType: "run_completed",
              payload: persistedPayload,
              terminalStatus,
            });
            tokenUsage = tokenUsageFromPayload(persistedPayload) ?? tokenUsage;
            contextUsage =
              contextUsageFromPayload(persistedPayload) ?? contextUsage;
          } else {
            terminalStatus = "ERROR";
            lastError = persistedPayload;
            completedAt = persistedTerminalEvent.createdAt;
            stopReason = stopReasonForTerminalEvent({
              eventType: "run_failed",
              payload: persistedPayload,
              terminalStatus,
            });
            tokenUsage = tokenUsageFromPayload(persistedPayload) ?? tokenUsage;
            contextUsage =
              contextUsageFromPayload(persistedPayload) ?? contextUsage;
          }
        } else if (execution.aborted && !execution.sawTerminal) {
          if (execution.abortReason === "user_requested_pause") {
            const pausedAt = new Date().toISOString();
            const completed = buildRunCompletedEvent({
              sessionId: record.sessionId,
              inputId: record.inputId,
              sequence: lastSequence + 1,
              payload: {
                status: "paused",
                stop_reason: "paused",
                message: "Run paused by user request",
              },
            });
            const completedPayload = payloadForEvent(completed);
            lastSequence = Math.max(
              lastSequence,
              typeof completed.sequence === "number"
                ? completed.sequence
                : lastSequence + 1,
            );
            deferredTerminalEvent = {
              eventType: "run_completed",
              payload: completedPayload,
              createdAt: pausedAt,
            };
            terminalStatus = "PAUSED";
            lastError = null;
            completedAt = pausedAt;
            stopReason = stopReasonForTerminalEvent({
              eventType: "run_completed",
              payload: completedPayload,
              terminalStatus,
            });
          } else {
            const failedAt = new Date().toISOString();
            const failure = buildRunFailedEvent({
              sessionId: record.sessionId,
              inputId: record.inputId,
              sequence: lastSequence + 1,
              message:
                execution.abortReason === "claim_expired"
                  ? "claimed input lease expired before the runner emitted a terminal event"
                  : execution.stderr.trim() ||
                    (execution.abortReason
                      ? `runner aborted before terminal event: ${execution.abortReason}`
                      : "runner aborted before terminal event"),
              errorType: "RuntimeError",
            });
            const failurePayload = payloadForEvent(failure);
            lastSequence = Math.max(
              lastSequence,
              typeof failure.sequence === "number"
                ? failure.sequence
                : lastSequence + 1,
            );
            deferredTerminalEvent = {
              eventType: "run_failed",
              payload: failurePayload,
              createdAt: failedAt,
            };
            captureClaimedInputFailure(
              execution.abortReason === "claim_expired"
                ? "claim_expired"
                : "runner_aborted",
              String(
                failurePayload.message ?? "runner aborted before terminal event",
              ),
              {
                failure_source: "synthetic_terminal_event",
                terminal_status: "ERROR",
                terminal_stop_reason: stopReasonForTerminalEvent({
                  eventType: "run_failed",
                  payload: failurePayload,
                  terminalStatus: "ERROR",
                }),
                terminal_payload: sanitizeRuntimeSentryValue(failurePayload),
                abort_reason: execution.abortReason,
                return_code: execution.returnCode,
                stderr: execution.stderr,
                saw_terminal: execution.sawTerminal,
                skipped_lines: execution.skippedLines.slice(0, 5),
              },
            );
            terminalFailureCaptured = true;
            terminalStatus = "ERROR";
            lastError = failurePayload;
            completedAt = failedAt;
            stopReason = stopReasonForTerminalEvent({
              eventType: "run_failed",
              payload: failurePayload,
              terminalStatus,
            });
          }
        } else if (!execution.sawTerminal) {
          const details =
            execution.skippedLines.length > 0
              ? execution.skippedLines.slice(0, 3).join("; ")
              : "";
          const suffix = details ? ` (skipped output: ${details})` : "";
          const failure = buildRunFailedEvent({
            sessionId: record.sessionId,
            inputId: record.inputId,
            sequence: lastSequence + 1,
            message:
              execution.returnCode !== 0
                ? execution.stderr.trim() ||
                  `runner command failed with exit_code=${execution.returnCode}`
                : `runner ended before terminal event${suffix}`,
            errorType:
              execution.returnCode !== 0
                ? "RunnerCommandError"
                : "RuntimeError",
          });
          const failurePayload = payloadForEvent(failure);
          lastSequence = Math.max(
            lastSequence,
            typeof failure.sequence === "number"
              ? failure.sequence
              : lastSequence + 1,
          );
          deferredTerminalEvent = {
            eventType: "run_failed",
            payload: failurePayload,
            createdAt: new Date().toISOString(),
          };
          captureClaimedInputFailure(
            execution.returnCode !== 0
              ? execution.stderr.trim() === "runner command timed out"
                ? "runner_timeout"
                : execution.stderr.includes("became idle")
                  ? "runner_idle_timeout"
                  : "runner_command_error"
              : "runner_missing_terminal",
            String(failurePayload.message ?? "runner ended before terminal event"),
            {
              failure_source: "synthetic_terminal_event",
              terminal_status: "ERROR",
              terminal_stop_reason: stopReasonForTerminalEvent({
                eventType: "run_failed",
                payload: failurePayload,
                terminalStatus: "ERROR",
              }),
              terminal_payload: sanitizeRuntimeSentryValue(failurePayload),
              return_code: execution.returnCode,
              stderr: execution.stderr,
              saw_terminal: execution.sawTerminal,
              skipped_lines: execution.skippedLines.slice(0, 5),
            },
          );
          terminalFailureCaptured = true;
          terminalStatus = "ERROR";
          lastError = failurePayload;
          completedAt = new Date().toISOString();
          stopReason = stopReasonForTerminalEvent({
            eventType: "run_failed",
            payload: failurePayload,
            terminalStatus,
          });
        }

        terminalEventToRelay = persistedTerminalEvent
          ? {
              eventType:
                persistedTerminalEvent.eventType === "run_completed"
                  ? "run_completed"
                  : "run_failed",
              sequence: persistedTerminalEvent.sequence,
              payload: persistedTerminalEvent.payload,
              createdAt: persistedTerminalEvent.createdAt,
            }
          : deferredTerminalEvent
            ? {
                eventType: deferredTerminalEvent.eventType,
                sequence: lastSequence + 1,
                payload: deferredTerminalEvent.payload,
                createdAt: deferredTerminalEvent.createdAt,
              }
            : null;

        const terminalFailurePayload =
          terminalEventToRelay?.eventType === "run_failed"
            ? terminalEventToRelay.payload
            : null;
        if (isContextOverflowFailurePayload(terminalFailurePayload)) {
          if (runnerAttempt >= 2) {
            overflowRecovery = {
              ...(overflowRecovery ?? {
                trigger_reason: "provider_context_overflow",
                initial_error_type:
                  optionalString(terminalFailurePayload?.type) ?? null,
                initial_error_message:
                  optionalString(terminalFailurePayload?.message) ?? null,
                compaction_attempted: false,
                compaction_changed_branch: false,
                retry_attempted: true,
                recovered: false,
                reset_required: false,
              }),
              retry_attempted: true,
              recovered: false,
              reset_required: true,
            };
            throw new SessionResetRequiredError(
              `overflow recovery could not make the next prompt fit ${selectedModel ?? "the selected model"}; session reset required`,
            );
          }
          overflowRecovery = {
            trigger_reason: "provider_context_overflow",
            initial_error_type: optionalString(terminalFailurePayload?.type),
            initial_error_message: optionalString(
              terminalFailurePayload?.message,
            ),
            compaction_attempted: true,
            compaction_changed_branch: false,
            retry_attempted: false,
            recovered: false,
            reset_required: false,
          };
          const liveSessionState =
            params.sessionCheckpointSessionOps?.currentLeafCheckpointState(
              checkpointHarnessSessionId,
            ) ?? currentPiSessionLeafState(checkpointHarnessSessionId);
          const compactionResult = await forceCompactSessionWithSnapshotMerge({
            store,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            inputId: record.inputId,
            harnessSessionId: checkpointHarnessSessionId,
            baseLeafId: liveSessionState.leafId,
            baseLatestCompactionId: liveSessionState.latestCompactionId,
            runPiSessionCompactionFn: params.runPiSessionCompactionFn,
            resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
            sessionOps: params.sessionCheckpointSessionOps,
          });
          overflowRecovery = {
            ...overflowRecovery,
            compaction_changed_branch: compactionResult.merged,
            retry_attempted: compactionResult.merged,
          };
          if (!compactionResult.merged) {
            overflowRecovery = {
              ...overflowRecovery,
              reset_required: true,
            };
            throw new SessionResetRequiredError(
              `overflow recovery compaction could not make the next prompt fit ${selectedModel ?? "the selected model"}; session reset required`,
            );
          }
          prepareRunnerRetry(optionalString(terminalFailurePayload?.message));
          continue;
        }
        if (
          isRecoverableProviderTerminationPayload({
            payload: terminalFailurePayload,
            tokenUsage,
            modelTurns: contextBudgetTelemetry.modelTurns,
            toolCallCount: toolCallsById.size,
          })
        ) {
          const usage =
            (terminalFailurePayload && isRecord(terminalFailurePayload.usage)
              ? terminalFailurePayload.usage
              : null) ?? tokenUsage;
          providerTerminationRecovery = {
            ...(providerTerminationRecovery ?? {
              trigger_reason: "long_running_provider_termination",
              initial_error_type:
                optionalString(terminalFailurePayload?.type) ?? null,
              initial_error_message:
                optionalString(terminalFailurePayload?.message) ?? null,
              initial_input_tokens: firstFiniteUsageNumber(usage, [
                "input_tokens",
                "prompt_tokens",
              ]),
              initial_model_turns: contextBudgetTelemetry.modelTurns,
              initial_tool_calls: toolCallsById.size,
              compaction_attempted: true,
              compaction_changed_branch: false,
              retry_attempted: false,
              recovered: false,
            }),
          };
          if (runnerAttempt < 2) {
            const liveSessionState =
              params.sessionCheckpointSessionOps?.currentLeafCheckpointState(
                checkpointHarnessSessionId,
              ) ?? currentPiSessionLeafState(checkpointHarnessSessionId);
            const compactionResult = await forceCompactSessionWithSnapshotMerge({
              store,
              workspaceId: record.workspaceId,
              sessionId: record.sessionId,
              inputId: record.inputId,
              harnessSessionId: checkpointHarnessSessionId,
              baseLeafId: liveSessionState.leafId,
              baseLatestCompactionId: liveSessionState.latestCompactionId,
              runPiSessionCompactionFn: params.runPiSessionCompactionFn,
              resolveRuntimeModelClientFn: params.resolveRuntimeModelClientFn,
              sessionOps: params.sessionCheckpointSessionOps,
            });
            providerTerminationRecovery = {
              ...providerTerminationRecovery,
              compaction_changed_branch: compactionResult.merged,
              retry_attempted: compactionResult.merged,
            };
            if (compactionResult.merged) {
              prepareRunnerRetry(optionalString(terminalFailurePayload?.message));
              continue;
            }
          }
        }
        if (
          runnerAttempt > 1 &&
          overflowRecovery?.retry_attempted &&
          terminalEventToRelay?.eventType === "run_completed"
        ) {
          overflowRecovery = {
            ...overflowRecovery,
            recovered: true,
          };
        }
        if (
          runnerAttempt > 1 &&
          providerTerminationRecovery?.retry_attempted &&
          terminalEventToRelay?.eventType === "run_completed"
        ) {
          providerTerminationRecovery = {
            ...providerTerminationRecovery,
            recovered: true,
          };
        }
        break;
      }
      const assistantText = assistantParts.join("").trim();
      if (
        useEphemeralHarnessSession &&
        terminalStatus !== "ERROR" &&
        terminalStatus !== "PAUSED" &&
        ephemeralPiFollowupRun
      ) {
        const assistantMessage =
          capturedPiAssistantMessage ??
          latestPiAssistantMessageFromSessionFile(
            ephemeralPiFollowupRun.snapshotSessionFile,
          );
        if (assistantMessage) {
          let createdLiveSessionFile = false;
          let liveSessionFile = ephemeralPiFollowupRun.liveSessionFile;
          try {
            if (!liveSessionFile) {
              liveSessionFile = createPiSessionFile({
                workspaceDir,
                sessionDir: resolvePiLiveSessionDir(workspaceDir),
              });
              createdLiveSessionFile = true;
            }
            if (
              canReanchorPiAssistantMessage({
                sessionFile: liveSessionFile,
                baseLeafId: ephemeralPiFollowupRun.baseLeafId,
                baseLatestCompactionId:
                  ephemeralPiFollowupRun.baseLatestCompactionId,
              })
            ) {
              appendPiAssistantMessageAtLeaf({
                sessionFile: liveSessionFile,
                baseLeafId: ephemeralPiFollowupRun.baseLeafId,
                assistantMessage,
              });
              syncedEphemeralLiveSessionFile = liveSessionFile;
              checkpointHarnessSessionId = liveSessionFile;
              ephemeralPiFollowupRun.liveSessionFile = liveSessionFile;
              store.upsertBinding({
                workspaceId: record.workspaceId,
                sessionId: record.sessionId,
                harness,
                harnessSessionId: liveSessionFile,
              });
              persistWorkspaceHarnessSessionId({
                workspaceDir,
                harness,
                sessionId: liveSessionFile,
              });
            } else if (createdLiveSessionFile) {
              fs.rmSync(liveSessionFile, { force: true });
            }
          } catch (error) {
            if (createdLiveSessionFile && liveSessionFile) {
              fs.rmSync(liveSessionFile, { force: true });
            }
            (params.captureRuntimeExceptionFn ?? captureRuntimeException)({
              error,
              level: "warning",
              fingerprint: [
                "runtime",
                "claimed_input",
                "followup_live_sync_failed",
                harness,
              ],
              tags: {
                surface: "claimed_input_executor",
                failure_kind: "followup_live_sync_failed",
                harness,
                session_kind: sessionKind,
              },
              contexts: {
                claimed_input: {
                  workspace_id: record.workspaceId,
                  session_id: record.sessionId,
                  input_id: record.inputId,
                  run_id: runId,
                  harness_session_id:
                    ephemeralPiFollowupRun.liveSessionFile ??
                    checkpointHarnessSessionId,
                  selected_model: selectedModel,
                },
              },
            });
          }
        }
      }
      const toolUsageSummary = summarizeToolCalls(
        toolCallsById,
        skillInvocationsById,
        wideningAudit,
      );
      const checkpointHarness =
        store.getWorkspace(record.workspaceId)?.harness ??
        normalizeHarnessId(priorExecContext.harness) ??
        "pi";
      if (syncedEphemeralLiveSessionFile) {
        if (deferredTerminalEvent) {
          deferredTerminalEvent.payload.harness_session_id =
            syncedEphemeralLiveSessionFile;
        }
        if (terminalEventToRelay) {
          terminalEventToRelay = {
            ...terminalEventToRelay,
            payload: {
              ...terminalEventToRelay.payload,
              harness_session_id: syncedEphemeralLiveSessionFile,
            },
          };
        }
      }
      const checkpointJob = useEphemeralHarnessSession
        ? null
        : enqueueCheckpointJob({
            store,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            inputId: record.inputId,
            harness: checkpointHarness,
            harnessSessionId:
              checkpointHarnessSessionId ||
              (store.getBinding({
                workspaceId: record.workspaceId,
                sessionId: record.sessionId,
              })?.harnessSessionId ??
                null),
            contextUsage,
            wakeWorker: params.wakeDurableMemoryWorker ?? null,
          });
      const contextBudgetDecisions = buildMergedContextBudgetPayload({
        startedAt: turnStartedAt,
        completedAt: completedAt ?? new Date().toISOString(),
        terminalStatus,
        stopReason,
        tokenUsage,
        contextUsage,
        promptCacheProfile,
        telemetry: contextBudgetTelemetry,
        toolCallCount: toolCallsById.size,
        toolReplayTrimmed,
        checkpointQueued: Boolean(checkpointJob),
        preRunCompaction,
        overflowRecovery,
        providerTerminationRecovery,
      });
      if (deferredTerminalEvent) {
        deferredTerminalEvent.payload.context_budget_decisions =
          contextBudgetDecisions;
        lastSequence = appendNextOutputEvent({
          store,
          record,
          lastSequence,
          eventType: deferredTerminalEvent.eventType,
          payload: deferredTerminalEvent.payload,
          createdAt: deferredTerminalEvent.createdAt,
        });
        terminalEventToRelay = {
          eventType: deferredTerminalEvent.eventType,
          sequence: lastSequence,
          payload: deferredTerminalEvent.payload,
          createdAt: deferredTerminalEvent.createdAt,
        };
        deferredTerminalEvent = null;
      }
      if (
        terminalEventToRelay?.eventType === "run_failed" &&
        !terminalFailureCaptured
      ) {
        terminalFailureCaptured = true;
        captureClaimedInputFailure(
          terminalFailureKindFromPayload(terminalEventToRelay.payload),
          optionalString(terminalEventToRelay.payload.message) ??
            optionalString(terminalEventToRelay.payload.type) ??
            "runner emitted run_failed",
          {
            failure_source: "terminal_event",
            terminal_status: "ERROR",
            terminal_stop_reason: stopReason,
            terminal_payload: sanitizeRuntimeSentryValue(
              terminalEventToRelay.payload,
            ),
            event_sequence: terminalEventToRelay.sequence,
            event_timestamp: terminalEventToRelay.createdAt,
          },
        );
      }

      store.updateInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
        fields: {
          status:
            terminalStatus === "ERROR"
              ? "FAILED"
              : terminalStatus === "PAUSED"
                ? "PAUSED"
                : "DONE",
          claimedBy: null,
          claimedUntil: null,
        },
      });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: terminalStatus,
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError,
      });

      if (workspaceFileManifestBefore) {
        try {
          const fileOutputs = detectWorkspaceFileOutputs({
            workspaceDir,
            before: workspaceFileManifestBefore,
          });
          const existingOutputPaths = new Set(
            store
              .listOutputs({
                workspaceId: record.workspaceId,
                limit: 5000,
                offset: 0,
              })
              .map((output) => output.filePath)
              .filter(
                (filePath): filePath is string =>
                  typeof filePath === "string" && filePath.length > 0,
              ),
          );
          for (const output of fileOutputs) {
            if (existingOutputPaths.has(output.filePath)) {
              continue;
            }
            store.createOutput({
              workspaceId: record.workspaceId,
              outputType: output.outputType,
              title: output.title,
              status: "completed",
              filePath: output.filePath,
              sessionId: record.sessionId,
              inputId: record.inputId,
              metadata: output.metadata,
            });
            existingOutputPaths.add(output.filePath);
          }
        } catch {
          // Output capture is best-effort and should not fail the turn.
        }
      }
      materializeQueuedBackgroundDeliverablesForTurn({
        store,
        record,
        context: isRecord(record.payload.context) ? record.payload.context : null,
      });

      const hasPersistedOutputs =
        store.listOutputs({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          inputId: record.inputId,
          limit: 1,
          offset: 0,
        }).length > 0;
      const hasPersistedMemoryProposals =
        store.listMemoryUpdateProposals({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          inputId: record.inputId,
          limit: 1,
          offset: 0,
        }).length > 0;
      if (assistantText || hasPersistedOutputs || hasPersistedMemoryProposals) {
        store.insertSessionMessage({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          role: "assistant",
          text: assistantText,
          messageId: `assistant-${record.inputId}`,
          createdAt: orderedAssistantMessageTimestamp(
            turnStartedAt,
            completedAt,
          ),
        });
      }
      const effectiveCompletedAt = completedAt ?? new Date().toISOString();
      let turnResult = persistTurnResult({
        store,
        record,
        startedAt: turnStartedAt,
        completedAt: effectiveCompletedAt,
        terminalStatus,
        stopReason,
        assistantText,
        toolUsageSummary,
        permissionDenials,
        promptSectionIds,
        capabilityManifestFingerprint,
        requestSnapshotFingerprint,
        promptCacheProfile,
        contextBudgetDecisions,
        tokenUsage,
      });
      updateSubagentRunFromTurnResult({
        store,
        record,
        turnResult,
      });
      maybeFinalizeMainSessionEvents({
        store,
        record,
        turnResult,
      });
      try {
        await maybePromoteAcceptedEvolveSkillCandidate({
          store,
          record,
          turnResult,
          memoryService: params.memoryService,
        });
      } catch {
        // Skill promotion is best-effort and should not fail the completed turn.
      }
      if (
        terminalEventToRelay &&
        (terminalEventToRelay.eventType === "run_completed" ||
          terminalEventToRelay.eventType === "run_failed")
      ) {
        const relayPayload: Record<string, unknown> = {
          ...terminalEventToRelay.payload,
          context_budget_decisions: contextBudgetDecisions,
        };
        if (assistantText) {
          relayPayload.final_output_text = assistantText;
        }
        if (!nonEmptyString(relayPayload.source)) {
          relayPayload.source = "runner";
        }
        const runStatePayload = backendRunStatePayload({
          terminalEventType: terminalEventToRelay.eventType,
          terminalStatus,
          stopReason,
          payload: relayPayload,
        });
        if (runStatePayload) {
          await relayBackendRunEvent({
            eventType: "run_state",
            payload: runStatePayload,
            timestamp: terminalEventToRelay.createdAt,
            preferredSequence: Math.max(terminalEventToRelay.sequence, 1),
          });
        }
        await relayBackendRunEvent({
          eventType: terminalEventToRelay.eventType,
          payload: relayPayload,
          timestamp: terminalEventToRelay.createdAt,
          preferredSequence:
            Math.max(terminalEventToRelay.sequence, 1) + (runStatePayload ? 1 : 0),
        });
      }
      await (params.runEvolveTasksFn ?? runEvolveTasks)({
        store,
        record,
        turnResult,
        memoryService: params.memoryService,
        modelContext: memoryWritebackModelContext,
        wakeDurableMemoryWorker: params.wakeDurableMemoryWorker ?? null,
        onTaskError: params.onEvolveTaskError,
      });
      maybeCreateCronjobCompletionNotification({
        store,
        record,
        turnResult,
      });
      maybeCreateMainSessionCompletionNotification({
        store,
        record,
        turnResult,
      });
      maybeCreateBackgroundIntegrationNotification({
        store,
        record,
        turnResult,
      });
      maybeQueueCronjobCompletionFollowup({
        store,
        record,
        turnResult,
      });
    } catch (error) {
      if (
        claimOwnershipLost ||
        executionAbortController.signal.reason === "claim_lost" ||
        !claimStillOwned()
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const errorStopReason = executorFailureStopReason(error);
      store.updateInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
        fields: {
          status: "FAILED",
          claimedBy: null,
          claimedUntil: null,
        },
      });
      store.appendOutputEvent({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        inputId: record.inputId,
        sequence: Math.max(0, lastSequence) + 1,
        eventType: "run_failed",
        payload: {
          message,
          ...(errorStopReason === "session_reset_required" &&
          error instanceof Error &&
          error.name
            ? { error_type: error.name }
            : {}),
          context_budget_decisions: buildMergedContextBudgetPayload({
            startedAt: turnStartedAt,
            completedAt: new Date().toISOString(),
            terminalStatus: "ERROR",
            stopReason: errorStopReason,
            tokenUsage: null,
            contextUsage,
            promptCacheProfile,
            telemetry: contextBudgetTelemetry,
            toolCallCount: toolCallsById.size,
            toolReplayTrimmed,
            checkpointQueued: false,
            preRunCompaction,
            overflowRecovery,
            providerTerminationRecovery,
          }),
        },
      });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "ERROR",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError:
          errorStopReason === "session_reset_required" &&
          error instanceof Error &&
          error.name
            ? { message, error_type: error.name }
            : { message },
      });
      const errorCompletedAt = new Date().toISOString();
      const turnResult = persistTurnResult({
        store,
        record,
        startedAt: turnStartedAt,
        completedAt: errorCompletedAt,
        terminalStatus: "ERROR",
        stopReason: errorStopReason,
        assistantText: "",
        toolUsageSummary: summarizeToolCalls(new Map()),
        permissionDenials: [],
        promptSectionIds: [],
        capabilityManifestFingerprint: null,
        requestSnapshotFingerprint: null,
        promptCacheProfile: null,
        contextBudgetDecisions: buildMergedContextBudgetPayload({
          startedAt: turnStartedAt,
          completedAt: errorCompletedAt,
          terminalStatus: "ERROR",
          stopReason: errorStopReason,
          tokenUsage: null,
          contextUsage,
          promptCacheProfile,
          telemetry: contextBudgetTelemetry,
          toolCallCount: toolCallsById.size,
          toolReplayTrimmed,
          checkpointQueued: false,
          preRunCompaction,
          overflowRecovery,
          providerTerminationRecovery,
        }),
        tokenUsage: null,
      });
      updateSubagentRunFromTurnResult({
        store,
        record,
        turnResult,
      });
      maybeFinalizeMainSessionEvents({
        store,
        record,
        turnResult,
      });
      await (params.runEvolveTasksFn ?? runEvolveTasks)({
        store,
        record,
        turnResult,
        memoryService: params.memoryService,
        modelContext: memoryWritebackModelContext,
        wakeDurableMemoryWorker: params.wakeDurableMemoryWorker ?? null,
        onTaskError: params.onEvolveTaskError,
      });
      maybeCreateCronjobCompletionNotification({
        store,
        record,
        turnResult,
      });
      maybeCreateMainSessionCompletionNotification({
        store,
        record,
        turnResult,
      });
      maybeCreateBackgroundIntegrationNotification({
        store,
        record,
        turnResult,
      });
      maybeQueueCronjobCompletionFollowup({
        store,
        record,
        turnResult,
      });
    } finally {
      if (ephemeralPiFollowupRun) {
        fs.rmSync(ephemeralPiFollowupRun.snapshotDir, {
          recursive: true,
          force: true,
        });
      }
    }
  };

  try {
    return await executeClaimedInput();
  } finally {
    params.abortSignal?.removeEventListener("abort", forwardAbortSignal);
  }
}
