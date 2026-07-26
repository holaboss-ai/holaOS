import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RuntimeStateStore, hostStateDbPath } from "@holaboss/runtime-state-store";

import {
  RuntimeAppLifecycleExecutor,
  type AppLifecycleExecutorLike,
} from "./app-lifecycle-worker.js";
import { bootstrapResolvedApplications } from "./resolved-app-bootstrap.js";
import {
  effectiveMcpServerPayloads,
  encodeWorkspaceMcpCatalog,
  mergePreparedMcpServerPayloads,
  mcpServerIdMap,
  mcpServerMappingMetadata,
  mcpServersUnavailableForMissingEnv,
  workspaceMcpCatalogFingerprint,
  type PreparedMcpServerPayload,
  type RunningWorkspaceMcpSidecar,
} from "./runner-prep.js";
import { compileWorkspaceRuntimePlanFromWorkspace } from "./runner-prep.js";
import {
  projectAgentRuntimeConfig,
  type AgentRuntimeConfigCliRequest,
  type AgentRuntimeConfigCliResponse,
} from "./agent-runtime-config.js";
import type {
  AgentCurrentUserContext,
  AgentOperatorSurfaceMutability,
  AgentOperatorSurfaceOwner,
  AgentOperatorSurfaceContext,
  AgentOperatorSurfaceType,
  AgentPendingUserMemoryContext,
  AgentSessionAttachmentContext,
} from "./agent-runtime-prompt.js";
import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import {
  decodeTsRunnerRequestPayload,
  fallbackEventIdentity,
  type JsonObject,
  type TsRunnerEvent,
  type TsRunnerRequest,
  validateTsRunnerRequest,
} from "./ts-runner-contracts.js";
import {
  buildTsRunnerEvent,
  buildTsRunnerFailureEvent,
  closePushEventClient,
  createPushEventClient,
  emitTsRunnerEventWithPush,
} from "./ts-runner-events.js";
import {
  clearWorkspaceHarnessSessionId,
  persistWorkspaceHarnessSessionId,
  readWorkspaceHarnessSessionId,
  workspaceDirForId,
} from "./ts-runner-session-state.js";
import {
  prepareInstructionWithQuotedWorkspaceSkills,
  projectSessionVisibleWorkspaceSkills,
  resolveWorkspaceSkills,
  type ResolvedWorkspaceSkill,
} from "./workspace-skills.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";
import {
  normalizeHarnessId,
  requireRuntimeHarnessAdapter,
  requireRuntimeHarnessPlugin,
  type RuntimeHarnessPlugin,
} from "./harness-registry.js";
import { buildRunnerEnv } from "./runner-worker.js";
import { effectiveHarnessRunTimeoutSeconds } from "./scheduled-run-timeout.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";
import {
  startWorkspaceMcpSidecar,
  type WorkspaceMcpSidecarCliRequest,
} from "./workspace-mcp-sidecar.js";
import type { CompiledWorkspaceRuntimePlan } from "./workspace-runtime-plan.js";
import { buildRecalledWorkspaceMemoryContext } from "./workspace-memory.js";
import { pendingUserMemoryContextFromProposals } from "./user-memory-proposals.js";
import { NATIVE_WEB_SEARCH_TOOL_IDS } from "../../harnesses/src/native-web-search-tools.js";

type LoggerLike = Pick<typeof console, "warn">;

const TERMINAL_EVENT_TYPES = new Set<TsRunnerEvent["event_type"]>([
  "run_completed",
  "run_failed",
]);
const HARNESS_HOST_NOT_IMPLEMENTED_EXIT_CODE = 86;
const RUNTIME_EXEC_CONTEXT_KEY = "_sandbox_runtime_exec_v1";
const DEFAULT_SESSION_MODE = "code";
const DEFAULT_PROVIDER_ID = "openai";
const WORKSPACE_MCP_READY_TIMEOUT_S = 10;
const RECALLED_MEMORY_PREFETCH_WAIT_MS = 150;
// Wall-clock budget for the harness-host child to emit its first event after
// spawn (e.g. `run_started`). If the child stays silent past this window we
// SIGKILL it and let the caller synthesize a `run_failed` rather than waiting
// for the runner-worker's 30-minute / 2-hour hard timeout. Catches cases where
// a bootstrap step inside the child (mcporter transport open, app lifecycle
// probe, etc.) blocks indefinitely.
const HARNESS_HOST_FIRST_EVENT_TIMEOUT_MS = 60_000;
const SUBAGENT_DEFAULT_TOOLS = [
  "read",
  "edit",
  "bash",
  "search",
  "find",
  "list",
  "todowrite",
  "todoread",
  "skill",
];
const SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS = new Set([
  "delegate_task",
  "get_task",
  "list_tasks",
  "reply_task",
  "cancel_task",
  "rerun_task",
]);
const SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS = new Set([] as string[]);
// Cronjobs are workspace-level persistent automations. They belong to
// the front-of-house controller (main_session), not backstage executors
// — a subagent silently minting a recurring schedule would surprise the
// user. Subagents that need a one-off action go through delegate_task
// owned by the main session. Kept in a separate set so the main_session
// filter (which also applies SUBAGENT_BLOCKED) doesn't strip them.
const SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS = new Set([
  "cronjobs_list",
  "cronjobs_get",
  "cronjobs_create",
  "cronjobs_update",
  "cronjobs_delete",
  "cronjobs_run_now",
  "capability_install",
  // Connecting an MCP server reconfigures the workspace's tool surface — a
  // front-of-house action the user initiates in the main chat, not something a
  // backstage executor should do silently. main_session keeps it.
  "mcp_connect",
  // Same posture for refreshing MCP tools — a user-facing maintenance action.
  "mcp_refresh",
  // Subagents are backstage executors that should return a result
  // (or block via reply_task) rather than pause for direct user
  // input. main_session keeps ask_user_question.
  "ask_user_question",
]);
const APP_BUILDER_ONLY_RUNTIME_TOOL_IDS = new Set([
  "workspace_apps_scaffold",
  "workspace_apps_register",
  "workspace_apps_build",
  "workspace_apps_ensure_running",
  "workspace_apps_restart",
  "workspace_apps_restart_and_wait_ready",
  "workspace_apps_wait_until_ready",
  "workspace_apps_get_status",
  "workspace_apps_get_ports",
  "workspace_apps_probe_endpoints",
]);
const MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS = new Set([
  "update_workspace_instructions",
]);
// Documentation set: the tools main_session is intended to surface. The
// main_session filter is a blocklist (APP_BUILDER_ONLY + SUBAGENT_BLOCKED),
// not an allowlist, so this set is not enforced at runtime — it pins intent
// and is referenced by the cronjob-tools-wiring test.
const MAIN_SESSION_RUNTIME_TOOL_IDS = new Set([
  "ask_user_question",
  "delegate_task",
  "get_task",
  "list_tasks",
  "reply_task",
  "cancel_task",
  "rerun_task",
  "update_workspace_instructions",
  "cronjobs_list",
  "cronjobs_get",
  "cronjobs_create",
  "cronjobs_update",
  "cronjobs_delete",
  "cronjobs_run_now",
  "capability_install",
  "workspace_integrations_list_catalog",
  "holaboss_workspace_integrations_propose_connect",
  "holaboss_workspace_integrations_set_default_account",
  "mcp_connect",
  "mcp_refresh",
]);
void MAIN_SESSION_RUNTIME_TOOL_IDS;

// ---------------------------------------------------------------------------
// Temporarily hidden runtime tools.
//
// Tool ids listed here are stripped from EVERY session's advertised tool set
// (main_session, subagents, app builder). They are NOT removed from the
// codebase — the handlers stay wired end-to-end — they are simply never
// advertised, so no agent knows about them or can invoke them. The matching
// prompt language is gated on the same availability (see agent-runtime-prompt
// `hasDelegateTaskTool`), so hiding a tool here also drops the guidance that
// would otherwise mention it. Empty this set to re-enable.
//
// Currently hides the subagent delegation family (`delegate_task` + its
// task-management siblings) while delegation is paused.
const HIDDEN_RUNTIME_TOOL_IDS = new Set<string>([
  "delegate_task",
  "get_task",
  "list_tasks",
  "reply_task",
  "cancel_task",
  "rerun_task",
]);

type BootstrapStageTimingMap = Record<string, number>;

type RuntimeExecContext = Record<string, unknown>;

export interface TsRunnerBootstrapState {
  harness: string;
  workspaceRoot: string;
  workspaceDir: string;
  /**
   * Agent's actual cwd (project_path for project sessions, the managed
   * workspace root for General, workspaceDir as fallback). Separate from
   * `workspaceDir`, which is the workspace metadata root used for
   * workspace.yaml / skills / resources.
   */
  agentCwd: string;
  runtimeExecContext: RuntimeExecContext | null;
  requestedHarnessSessionId: string | null;
  persistedHarnessSessionId: string | null;
}

export interface TsRunnerHarnessRelayResult {
  exitCode: number;
  stderr: string;
  sawEvent: boolean;
  terminalEmitted: boolean;
  lastSequence: number;
  missingEntryPath?: string | null;
  spawnError?: string | null;
  /** TTFT dissection: ms from harness spawn to its first emitted event (≈ node
   *  startup + 1.1MB bundle load + request parse + session create). */
  harnessSpawnToFirstEventMs?: number;
  /** TTFT dissection: ms from harness spawn to the first `output_delta` /
   *  `thinking_delta` (first model token). `first_token − first_event` ≈ the
   *  model-call TTFT (network + provider generation). */
  harnessSpawnToFirstTokenMs?: number;
}

export interface TsRunnerExecutionDeps {
  bootstrapApplications: (params: {
    request: TsRunnerRequest;
    workspaceRoot: string;
    workspaceDir: string;
    resolvedApplications: unknown[];
  }) => Promise<PreparedMcpServerPayload[]>;
  compilePlan: (params: {
    workspaceId: string;
    workspaceDir: string;
  }) => CompiledWorkspaceRuntimePlan;
  projectAgentRuntimeConfig: (
    request: AgentRuntimeConfigCliRequest,
  ) => AgentRuntimeConfigCliResponse;
  resolveHarnessPlugin: (harness: string) => RuntimeHarnessPlugin;
  runHarnessHost: (params: {
    harness: string;
    requestPayload: Record<string, unknown>;
    workspaceDir: string;
    emitEvent: (event: TsRunnerEvent) => Promise<void>;
    logger?: LoggerLike;
  }) => Promise<TsRunnerHarnessRelayResult>;
  startWorkspaceMcpSidecar: (
    request: WorkspaceMcpSidecarCliRequest,
  ) => Promise<RunningWorkspaceMcpSidecar | null>;
  loadRecalledMemoryContext: (params: {
    workspaceRoot: string;
    workspaceId: string;
    sessionId: string;
    inputId: string;
    request: TsRunnerRequest;
    instruction: string;
    logger?: LoggerLike;
  }) => Promise<AgentRecalledMemoryContext | null>;
  loadOperatorSurfaceContext: (params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    browserConfig: {
      desktopBrowserEnabled: boolean;
      desktopBrowserUrl: string;
      desktopBrowserAuthToken: string;
    };
    logger?: LoggerLike;
  }) => Promise<AgentOperatorSurfaceContext | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorTypeFor(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function fingerprintJsonValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSensitiveSnapshotKey(key: string): boolean {
  return /(?:api[_-]?key|auth(?:orization)?|token|secret|password)/i.test(key);
}

function sanitizeSnapshotValue(value: unknown, parentKey?: string): unknown {
  if (parentKey === "request_snapshot_fingerprint") {
    return "[self]";
  }
  if (parentKey && isSensitiveSnapshotKey(parentKey)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSnapshotValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitizedEntries = Object.entries(value).map(([key, item]) => [
    key,
    sanitizeSnapshotValue(item, key),
  ]);
  return Object.fromEntries(sanitizedEntries);
}

function turnRequestSnapshotFingerprint(
  payload: Record<string, unknown>,
): string {
  return fingerprintJsonValue(sanitizeSnapshotValue(payload));
}

function defaultHostStateDbPathForSandbox(sandboxRoot: string): string {
  return hostStateDbPath({ sandboxRoot });
}

function persistTurnRequestSnapshot(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  snapshotKind: string;
  payload: Record<string, unknown>;
  logger?: LoggerLike;
}): string | null {
  const sanitizedPayload = sanitizeSnapshotValue(params.payload) as Record<
    string,
    unknown
  >;
  const fingerprint = fingerprintJsonValue(sanitizedPayload);
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (error) {
    params.logger?.warn?.(
      `Failed to create turn request snapshot state directory workspace_id=${params.workspaceId} session_id=${params.sessionId} input_id=${params.inputId}: ${errorMessage(error)}`,
    );
    return null;
  }
  const store = new RuntimeStateStore({
    workspaceRoot: params.workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    store.upsertTurnRequestSnapshot({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      inputId: params.inputId,
      snapshotKind: params.snapshotKind,
      fingerprint,
      payload: sanitizedPayload,
    });
    return fingerprint;
  } catch (error) {
    params.logger?.warn?.(
      `Failed to persist turn request snapshot workspace_id=${params.workspaceId} session_id=${params.sessionId} input_id=${params.inputId}: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    store.close();
  }
}

function turnRequestSnapshotPayload(params: {
  request: TsRunnerRequest;
  bootstrap: TsRunnerBootstrapState;
  runtimeConfig: AgentRuntimeConfigCliResponse;
  harnessRequestPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    snapshot_kind: "harness_host_request",
    workspace_id: params.request.workspace_id,
    session_id: params.request.session_id,
    input_id: params.request.input_id,
    harness_id: params.bootstrap.harness,
    raw_instruction: params.request.instruction,
    attachments: params.request.attachments ?? [],
    image_urls: params.request.image_urls ?? [],
    runtime_config: {
      provider_id: params.runtimeConfig.provider_id,
      model_id: params.runtimeConfig.model_id,
      mode: params.runtimeConfig.mode,
      system_prompt: params.runtimeConfig.system_prompt,
      context_messages: params.runtimeConfig.context_messages ?? [],
      prompt_sections: params.runtimeConfig.prompt_sections ?? [],
      prompt_layers: params.runtimeConfig.prompt_layers ?? [],
      prompt_cache_profile: params.runtimeConfig.prompt_cache_profile ?? null,
      tools: params.runtimeConfig.tools,
      workspace_tool_ids: params.runtimeConfig.workspace_tool_ids,
      workspace_skill_ids: params.runtimeConfig.workspace_skill_ids,
      output_schema_member_id:
        params.runtimeConfig.output_schema_member_id ?? null,
      output_format: params.runtimeConfig.output_format ?? null,
      workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
      capability_manifest: params.runtimeConfig.capability_manifest ?? null,
      model_client: {
        model_proxy_provider:
          params.runtimeConfig.model_client.model_proxy_provider,
        base_url: params.runtimeConfig.model_client.base_url ?? null,
        default_headers:
          params.runtimeConfig.model_client.default_headers ?? null,
      },
    },
    harness_request: params.harnessRequestPayload,
  };
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function measureBootstrapStage<T>(
  timings: BootstrapStageTimingMap,
  stage: string,
  operation: () => T,
): T {
  const startedAtMs = Date.now();
  try {
    return operation();
  } finally {
    timings[stage] = elapsedMs(startedAtMs);
  }
}

async function measureBootstrapStageAsync<T>(
  timings: BootstrapStageTimingMap,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  try {
    return await operation();
  } finally {
    timings[stage] = elapsedMs(startedAtMs);
  }
}

function runtimeExecContextString(
  request: TsRunnerRequest,
  key: string,
): string | null {
  const value = request.context[RUNTIME_EXEC_CONTEXT_KEY];
  if (!isRecord(value)) {
    return null;
  }
  return firstNonEmptyString(value[key]);
}

function runtimeExecContextBoolean(
  request: TsRunnerRequest,
  key: string,
): boolean {
  const value = request.context[RUNTIME_EXEC_CONTEXT_KEY];
  return isRecord(value) && value[key] === true;
}

function selectedHarness(request: TsRunnerRequest): string {
  const runtimeHarness = isRecord(request.context[RUNTIME_EXEC_CONTEXT_KEY])
    ? request.context[RUNTIME_EXEC_CONTEXT_KEY].harness
    : undefined;
  return normalizeHarnessId(
    runtimeHarness ?? process.env.SANDBOX_AGENT_HARNESS,
  );
}

function runtimeRootDir(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function loadRecalledMemoryContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  request: TsRunnerRequest;
  instruction: string;
  logger?: LoggerLike;
}): Promise<AgentRecalledMemoryContext | null> {
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  const store = fs.existsSync(dbPath)
    ? new RuntimeStateStore({
        workspaceRoot: params.workspaceRoot,
        sandboxRoot,
        dbPath,
      })
    : null;
  if (!store) {
    return null;
  }
  try {
    return await buildRecalledWorkspaceMemoryContext({
      store,
      workspaceId: params.workspaceId,
      query: params.instruction,
      selectedModel: params.request.model,
      sessionId: params.sessionId,
      inputId: params.inputId,
      maxResults: 5,
    });
  } catch (error) {
    params.logger?.warn?.(
      `Failed to load recalled memory context workspace_id=${params.workspaceId}: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    store?.close();
  }
}

interface RecalledMemoryPrefetchHandle {
  promise: Promise<AgentRecalledMemoryContext | null>;
  settledAt: number | null;
}

function startRecalledMemoryContextPrefetch(params: {
  load: () => Promise<AgentRecalledMemoryContext | null>;
  logger?: LoggerLike;
}): RecalledMemoryPrefetchHandle {
  const handle: RecalledMemoryPrefetchHandle = {
    promise: Promise.resolve(null),
    settledAt: null,
  };
  handle.promise = params
    .load()
    .catch((error) => {
      params.logger?.warn?.(
        `Failed in recalled memory prefetch: ${errorMessage(error)}`,
      );
      return null;
    })
    .finally(() => {
      handle.settledAt = Date.now();
    });
  return handle;
}

async function consumeRecalledMemoryContextPrefetch(
  prefetch: RecalledMemoryPrefetchHandle,
  maxWaitMs = RECALLED_MEMORY_PREFETCH_WAIT_MS,
): Promise<AgentRecalledMemoryContext | null> {
  if (prefetch.settledAt !== null) {
    return await prefetch.promise;
  }
  const boundedWaitMs = Math.max(0, Math.trunc(maxWaitMs));
  if (boundedWaitMs === 0) {
    return null;
  }
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      prefetch.promise.then((value) => ({ ready: true as const, value })),
      new Promise<{ ready: false }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ ready: false }),
          boundedWaitMs,
        );
      }),
    ]);
    return result.ready ? result.value : null;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function loadCurrentUserContext(params: {
  workspaceRoot: string;
  logger?: LoggerLike;
}): AgentCurrentUserContext | null {
  const resolvedLocalTimezone = (() => {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
      return timezone || null;
    } catch {
      return null;
    }
  })();
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  const defaultContext: AgentCurrentUserContext = {
    profile_id: "default",
    name: null,
    timezone: resolvedLocalTimezone,
    name_source: null,
  };
  if (!fs.existsSync(dbPath)) {
    return defaultContext;
  }
  const store = new RuntimeStateStore({
    workspaceRoot: params.workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    const profile = store.getRuntimeUserProfile({ profileId: "default" });
    if (!profile) {
      return defaultContext;
    }
    return {
      profile_id: profile.profileId,
      name: profile.name,
      timezone: profile.timezone ?? resolvedLocalTimezone,
      name_source: profile.nameSource,
    };
  } catch (error) {
    params.logger?.warn?.(
      `Failed to load current user context: ${errorMessage(error)}`,
    );
    return defaultContext;
  } finally {
    store.close();
  }
}

function loadPendingUserMemoryContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  logger?: LoggerLike;
}): AgentPendingUserMemoryContext | null {
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const store = new RuntimeStateStore({
    workspaceRoot: params.workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    const proposals = store.listMemoryUpdateProposals({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      inputId: params.inputId,
      state: "pending",
      limit: 50,
      offset: 0,
    });
    return pendingUserMemoryContextFromProposals(proposals);
  } catch (error) {
    params.logger?.warn?.(
      `Failed to load pending user memory context workspace_id=${params.workspaceId} session_id=${params.sessionId} input_id=${params.inputId}: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    store.close();
  }
}

const SESSION_ATTACHMENT_CONTEXT_TURN_LIMIT = 12;
const SESSION_ATTACHMENT_CONTEXT_ATTACHMENT_LIMIT = 24;
const SESSION_ATTACHMENT_TEXT_PREVIEW_MAX_LENGTH = 240;
type SessionAttachmentContextTurn = NonNullable<
  AgentSessionAttachmentContext["turns"]
>[number];
type SessionAttachmentContextAttachment = NonNullable<
  SessionAttachmentContextTurn["attachments"]
>[number];

function parseAttachmentContextAttachment(
  value: unknown,
): SessionAttachmentContextAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const mimeType =
    typeof record.mime_type === "string" ? record.mime_type.trim() : "";
  const workspacePath =
    typeof record.workspace_path === "string"
      ? record.workspace_path.trim()
      : "";
  const sizeBytes =
    typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes)
      ? Math.max(0, Math.trunc(record.size_bytes))
      : 0;
  const kind =
    record.kind === "image"
      ? "image"
      : record.kind === "folder"
        ? "folder"
        : record.kind === "file"
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

function sessionAttachmentContextAttachments(
  params: {
    store: RuntimeStateStore;
    workspaceId: string;
    messageId: string;
    metadata: Record<string, unknown>;
  },
): SessionAttachmentContextAttachment[] {
  const metadataAttachments = Array.isArray(params.metadata.attachments)
    ? params.metadata.attachments
        .map((item) => parseAttachmentContextAttachment(item))
        .filter((item): item is SessionAttachmentContextAttachment => Boolean(item))
    : [];
  if (metadataAttachments.length > 0) {
    return metadataAttachments;
  }
  if (!params.messageId.startsWith("user-")) {
    return [];
  }
  const inputId = params.messageId.slice(5);
  if (!inputId) {
    return [];
  }
  const payloadAttachments = params.store.getInput({
    workspaceId: params.workspaceId,
    inputId,
  })?.payload.attachments;
  if (!Array.isArray(payloadAttachments)) {
    return [];
  }
  return payloadAttachments
    .map((item) => parseAttachmentContextAttachment(item))
    .filter((item): item is SessionAttachmentContextAttachment => Boolean(item));
}

function previewSessionAttachmentTurnText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SESSION_ATTACHMENT_TEXT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, SESSION_ATTACHMENT_TEXT_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function loadSessionAttachmentContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  currentInputId: string;
  logger?: LoggerLike;
}): AgentSessionAttachmentContext | null {
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const store = new RuntimeStateStore({
    workspaceRoot: params.workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    const messages = store.listSessionMessages({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      role: "user",
      order: "desc",
      limit: 100,
      offset: 0,
    });
    const excludeMessageId = `user-${params.currentInputId}`;
    const eligibleTurns = messages
      .filter((message) => message.id !== excludeMessageId)
      .map((message) => ({
        message_id: message.id,
        created_at: message.createdAt,
        text: previewSessionAttachmentTurnText(message.text),
        attachments: sessionAttachmentContextAttachments({
          store,
          workspaceId: params.workspaceId,
          messageId: message.id,
          metadata: message.metadata,
        }),
      }))
      .filter((turn) => turn.attachments.length > 0);
    const turns: NonNullable<AgentSessionAttachmentContext["turns"]> = [];
    let attachmentCount = 0;
    for (const turn of eligibleTurns) {
      const remainingAttachmentSlots =
        SESSION_ATTACHMENT_CONTEXT_ATTACHMENT_LIMIT - attachmentCount;
      if (
        remainingAttachmentSlots <= 0 ||
        turns.length >= SESSION_ATTACHMENT_CONTEXT_TURN_LIMIT
      ) {
        break;
      }
      const slicedAttachments = turn.attachments.slice(0, remainingAttachmentSlots);
      turns.push({
        ...turn,
        attachments: slicedAttachments,
      });
      attachmentCount += slicedAttachments.length;
    }
    if (turns.length === 0) {
      return null;
    }
    const totalEligibleAttachments = eligibleTurns.reduce(
      (sum, turn) => sum + turn.attachments.length,
      0,
    );
    return {
      turns: turns.reverse(),
      truncated:
        eligibleTurns.length > turns.length ||
        totalEligibleAttachments > attachmentCount,
    };
  } catch (error) {
    params.logger?.warn?.(
      `Failed to load session attachment context workspace_id=${params.workspaceId} session_id=${params.sessionId}: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    store.close();
  }
}

function normalizeRuntimeApiHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::") {
    return "127.0.0.1";
  }
  return trimmed;
}

function currentRuntimeApiUrl(): string | null {
  const configured = (process.env.SANDBOX_RUNTIME_API_URL ?? "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const portValue = (
    process.env.SANDBOX_RUNTIME_API_PORT ??
    process.env.SANDBOX_AGENT_BIND_PORT ??
    ""
  ).trim();
  if (!portValue) {
    return null;
  }
  const port = Number.parseInt(portValue, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const host = normalizeRuntimeApiHost(
    process.env.SANDBOX_RUNTIME_API_HOST ??
      process.env.SANDBOX_AGENT_BIND_HOST ??
      "127.0.0.1",
  );
  return `http://${host}:${port}`;
}

interface ComposioInlineToolRefPayload {
  name: string;
  toolkit_slug: string;
  tool_slug: string;
  connected_account_id: string;
  read_only?: boolean | null;
}

async function fetchComposioInlineToolRefs(params: {
  runtimeApiBaseUrl: string | null;
  workspaceId: string;
  sessionId: string;
  inputId: string;
}): Promise<ComposioInlineToolRefPayload[]> {
  if (!params.runtimeApiBaseUrl) return [];
  try {
    const url = `${params.runtimeApiBaseUrl}/api/v1/capabilities/composio-inline-tools?workspace_id=${encodeURIComponent(params.workspaceId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-holaboss-workspace-id": params.workspaceId,
        "x-holaboss-session-id": params.sessionId,
        "x-holaboss-input-id": params.inputId,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      tools?: Array<{
        name: string;
        toolkit_slug: string;
        tool_slug: string;
        connected_account_id: string;
        annotations?: { readOnlyHint?: boolean } | null;
      }>;
    };
    return (payload.tools ?? []).map((entry) => ({
      name: entry.name,
      toolkit_slug: entry.toolkit_slug,
      tool_slug: entry.tool_slug,
      connected_account_id: entry.connected_account_id,
      read_only: entry.annotations?.readOnlyHint ?? null,
    }));
  } catch {
    return [];
  }
}

function runtimeNodeBin(): string {
  return (
    firstNonEmptyString(
      process.env.HOLABOSS_RUNTIME_NODE_BIN,
      process.execPath,
    ) ?? process.execPath
  );
}

function workspaceMcpSandboxId(): string {
  const raw =
    process.env.SANDBOX_INSTANCE_ID ??
    process.env.SANDBOX_ID ??
    process.env.HOSTNAME ??
    os.hostname() ??
    "sandbox";
  const token = String(raw)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || "sandbox";
}

function normalizeProviderId(value: string | null): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic_native") {
    return "anthropic";
  }
  return normalized || DEFAULT_PROVIDER_ID;
}

function defaultProviderId(): string {
  try {
    const configured = resolveProductRuntimeConfig({
      requireAuth: false,
      requireUser: false,
      requireBaseUrl: false,
    }).defaultProvider;
    return normalizeProviderId(configured);
  } catch {
    return normalizeProviderId(
      process.env.HOLABOSS_DEFAULT_PROVIDER_ID ?? DEFAULT_PROVIDER_ID,
    );
  }
}

function defaultSessionMode(): string {
  return (
    firstNonEmptyString(
      process.env.HOLABOSS_SESSION_MODE,
      DEFAULT_SESSION_MODE,
    ) ?? DEFAULT_SESSION_MODE
  );
}

function defaultExtraTools(harnessId?: string | null): string[] {
  const configured = (process.env.HOLABOSS_EXTRA_TOOLS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (normalizeHarnessId(harnessId) === "pi") {
    return [...NATIVE_WEB_SEARCH_TOOL_IDS, ...configured];
  }
  return configured;
}

function normalizedSessionKindValue(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized || normalized === "workspace_session" || normalized === "main") {
    return "main_session";
  }
  if (normalized === "task_proposal") {
    return "subagent";
  }
  return normalized;
}

function agentRoleFromSessionKind(value: string | null | undefined): string {
  const normalized = normalizedSessionKindValue(value);
  switch (normalized) {
    case "main_session":
      return "main-loop";
    case "subagent":
      return "subagent";
    case "onboarding":
      return "onboarding";
    default:
      return normalized || "main-loop";
  }
}

function isDelegatingFrontSessionKind(params: {
  sessionKind: string | null | undefined;
}): boolean {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  return normalized === "main_session";
}

function projectBrowserToolIdsForSession(params: {
  sessionKind: string | null | undefined;
  browserToolIds: string[];
  appScope?: string | null;
}): string[] {
  // A HolaApp session KEEPS its browser tools, but they drive the app's OWN
  // Electron surface (the view the user is looking at) instead of the separate
  // agent-profile browser — routed via the `browser:app` space (browserSpaceForRequest)
  // and the app-surface driver in electron/main.ts. The app-scope strip still
  // removes runtime/extra/skills tools and scopes MCP to the app, so the session
  // stays app-only; only browser *use* is redirected, not taken away.
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  return [...params.browserToolIds];
}

function projectRuntimeToolIdsForSession(params: {
  sessionKind: string | null | undefined;
  runtimeToolIds: string[];
  appScope?: string | null;
}): string[] {
  // A HolaApp session gets STRICTLY that app's MCP tools — no runtime tools
  // (web_search, memory, image-gen, …).
  if (params.appScope?.trim()) {
    return [];
  }
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  if (normalized === "subagent") {
    return params.runtimeToolIds.filter(
      (toolId) =>
        !HIDDEN_RUNTIME_TOOL_IDS.has(toolId) &&
        !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
        !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        !SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId) &&
        !SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS.has(toolId),
    );
  }
  // main_session and default: full execution capability, plus orchestration
  // tools (delegate_task et al) and main-session-only tools
  // (update_workspace_instructions). Only specialized buckets get stripped.
  return params.runtimeToolIds.filter(
    (toolId) =>
      !HIDDEN_RUNTIME_TOOL_IDS.has(toolId) &&
      !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
      !SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId),
  );
}

function projectExtraToolIdsForSession(params: {
  harnessId: string | null | undefined;
  sessionKind: string | null | undefined;
  extraToolIds: string[];
  appScope?: string | null;
}): string[] {
  // A HolaApp session gets strictly the app's MCP — no extra (runtime/browser)
  // tools.
  if (params.appScope?.trim()) {
    return [];
  }
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  if (normalized === "subagent") {
    return Array.from(
      new Set([
        ...defaultExtraTools(params.harnessId),
        ...params.extraToolIds.filter(
          (toolId) =>
            !HIDDEN_RUNTIME_TOOL_IDS.has(toolId) &&
            !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
            !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
            !SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId) &&
            !SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS.has(toolId),
        ),
      ]),
    );
  }
  // main_session and default: full execution capability, plus orchestration
  // and main-session-only tools. Same baseline as projectRuntimeToolIdsForSession.
  return Array.from(
    new Set([
      ...defaultExtraTools(params.harnessId),
      ...params.extraToolIds.filter(
        (toolId) =>
          !HIDDEN_RUNTIME_TOOL_IDS.has(toolId) &&
          !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
          !SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId),
      ),
    ]),
  );
}

/**
 * The owning HolaApp id for this run, if any. Set by the executor from the
 * session's owning_app_id; when present the run is restricted to strictly that
 * app's MCP tools (see the project…ForSession helpers).
 */
function appScopeFromRequest(request: TsRunnerRequest): string | null {
  const raw = request.context?.app_scope;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function projectResolvedMcpToolRefsForSession(params: {
  sessionKind: string | null | undefined;
  resolvedMcpToolRefs: CompiledWorkspaceRuntimePlan["resolved_mcp_tool_refs"];
  appScope?: string | null;
}): CompiledWorkspaceRuntimePlan["resolved_mcp_tool_refs"] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  // A HolaApp session sees only its own app's MCP tools.
  const appScope = params.appScope?.trim();
  if (appScope) {
    return params.resolvedMcpToolRefs.filter((ref) => ref.server_id === appScope);
  }
  return params.resolvedMcpToolRefs;
}

function projectResolvedMcpServerIdsForSession(params: {
  sessionKind: string | null | undefined;
  resolvedMcpServerIds: string[];
  appScope?: string | null;
}): string[] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  // A HolaApp session connects only to its own app's MCP server.
  const appScope = params.appScope?.trim();
  if (appScope) {
    return params.resolvedMcpServerIds.filter((id) => id === appScope);
  }
  return params.resolvedMcpServerIds;
}

function projectWorkspaceSkillsForSession(params: {
  sessionKind: string | null | undefined;
  workspaceSkills: ResolvedWorkspaceSkill[];
}): ResolvedWorkspaceSkill[] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "tool_node") {
    return [];
  }
  // All session kinds (including main_session) see the full skill set —
  // see the parallel decision in projectResolvedMcpToolRefsForSession to
  // give main_session the full execution surface.
  return params.workspaceSkills;
}

function explicitHolabossUserId(request: TsRunnerRequest): string | undefined {
  return (
    firstNonEmptyString(
      request.holaboss_user_id,
      request.context.holaboss_user_id,
    ) ?? undefined
  );
}

function bootstrapStartedPayload(params: {
  request: TsRunnerRequest;
  runtimeConfig: AgentRuntimeConfigCliResponse;
  requestSnapshotFingerprint: string | null;
  harnessSupportsStructuredOutput: boolean;
  mcpServerIdMap: Readonly<Record<string, string>>;
  mcpServers: PreparedMcpServerPayload[];
  sidecar: RunningWorkspaceMcpSidecar | null;
  bootstrapStartedAt: string;
  bootstrapReadyAt: string;
  bootstrapTotalMs: number;
  bootstrapStageTimingsMs: BootstrapStageTimingMap;
}): Record<string, unknown> {
  return {
    instruction_preview: params.request.instruction.slice(0, 120),
    provider_id: params.runtimeConfig.provider_id,
    model_id: params.runtimeConfig.model_id,
    workspace_tool_ids: [...params.runtimeConfig.workspace_tool_ids],
    workspace_skill_ids: [...params.runtimeConfig.workspace_skill_ids],
    workspace_command_ids: [
      ...(params.runtimeConfig.capability_manifest?.workspace_commands ?? []),
    ],
    context_message_count: params.runtimeConfig.context_messages?.length ?? 0,
    prompt_section_ids: [
      ...(params.runtimeConfig.prompt_sections?.map((section) => section.id) ??
        []),
    ],
    prompt_cache_profile: params.runtimeConfig.prompt_cache_profile ?? null,
    capability_manifest_fingerprint:
      params.runtimeConfig.capability_manifest?.fingerprint ?? null,
    request_snapshot_fingerprint: params.requestSnapshotFingerprint,
    mcp_server_ids: params.mcpServers.map((server) => server.name),
    mcp_server_mappings: mcpServerMappingMetadata(params.mcpServerIdMap),
    workspace_mcp_sidecar_reused: Boolean(params.sidecar?.reused),
    structured_output_enabled:
      params.harnessSupportsStructuredOutput &&
      Boolean(params.runtimeConfig.output_format),
    workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
    bootstrap_started_at: params.bootstrapStartedAt,
    bootstrap_ready_at: params.bootstrapReadyAt,
    bootstrap_total_ms: params.bootstrapTotalMs,
    bootstrap_stage_timings_ms: { ...params.bootstrapStageTimingsMs },
  };
}

function currentBrowserConfig(): {
  desktopBrowserEnabled: boolean;
  desktopBrowserUrl: string;
  desktopBrowserAuthToken: string;
} {
  try {
    const config = resolveProductRuntimeConfig({
      requireAuth: false,
      requireUser: false,
      requireBaseUrl: false,
    });
    return {
      desktopBrowserEnabled: config.desktopBrowserEnabled,
      desktopBrowserUrl: config.desktopBrowserUrl,
      desktopBrowserAuthToken: config.desktopBrowserAuthToken,
    };
  } catch {
    return {
      desktopBrowserEnabled: false,
      desktopBrowserUrl: "",
      desktopBrowserAuthToken: "",
    };
  }
}

function operatorSurfaceType(value: unknown): AgentOperatorSurfaceType | null {
  return value === "browser" ||
    value === "editor" ||
    value === "terminal" ||
    value === "app_surface"
    ? value
    : null;
}

function operatorSurfaceOwner(
  value: unknown,
): AgentOperatorSurfaceOwner | null {
  return value === "user" || value === "agent" ? value : null;
}

function operatorSurfaceMutability(
  value: unknown,
): AgentOperatorSurfaceMutability | null {
  return value === "inspect_only" ||
    value === "takeover_allowed" ||
    value === "agent_owned"
    ? value
    : null;
}

function normalizeOperatorSurfaceContext(
  value: unknown,
): AgentOperatorSurfaceContext | null {
  if (!isRecord(value)) {
    return null;
  }
  const surfaces = Array.isArray(value.surfaces) ? value.surfaces : [];
  const normalizedSurfaces = surfaces.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const surfaceId = firstNonEmptyString(item.surface_id);
    const surfaceType = operatorSurfaceType(item.surface_type);
    const owner = operatorSurfaceOwner(item.owner);
    if (!surfaceId || !surfaceType || !owner) {
      return [];
    }
    return [
      {
        surface_id: surfaceId,
        surface_type: surfaceType,
        owner,
        active: typeof item.active === "boolean" ? item.active : null,
        mutability: operatorSurfaceMutability(item.mutability),
        summary: firstNonEmptyString(item.summary) ?? null,
      },
    ];
  });
  if (normalizedSurfaces.length === 0) {
    return null;
  }
  return {
    active_surface_id: firstNonEmptyString(value.active_surface_id) ?? null,
    surfaces: normalizedSurfaces,
  };
}

async function loadOperatorSurfaceContext(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  browserConfig: {
    desktopBrowserEnabled: boolean;
    desktopBrowserUrl: string;
    desktopBrowserAuthToken: string;
  };
  logger?: LoggerLike;
}): Promise<AgentOperatorSurfaceContext | null> {
  const browserUrl = params.browserConfig.desktopBrowserUrl
    .trim()
    .replace(/\/+$/, "");
  const authToken = params.browserConfig.desktopBrowserAuthToken.trim();
  if (
    !params.browserConfig.desktopBrowserEnabled ||
    !browserUrl ||
    !authToken
  ) {
    return null;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${browserUrl}/operator-surface-context`, {
      method: "GET",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-holaboss-desktop-token": authToken,
        "x-holaboss-workspace-id": params.workspaceId,
      },
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 409) {
      return null;
    }
    if (!response.ok) {
      params.logger?.warn?.(
        `Failed to load operator surface context workspace_id=${params.workspaceId} session_id=${params.sessionId} input_id=${params.inputId} status=${response.status}`,
      );
      return null;
    }
    return normalizeOperatorSurfaceContext(await response.json());
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      params.logger?.warn?.(
        `Failed to load operator surface context workspace_id=${params.workspaceId} session_id=${params.sessionId} input_id=${params.inputId}: ${errorMessage(error)}`,
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildAgentRuntimeConfigRequest(params: {
  request: TsRunnerRequest;
  harnessId: string;
  browserToolsAvailable: boolean;
  browserToolIds: string[];
  delegatedBrowserToolsAvailable?: boolean | null;
  delegatedBrowserToolIds?: string[] | null;
  runtimeToolIds: string[];
  compiledPlan: CompiledWorkspaceRuntimePlan;
  extraToolIds: string[];
  delegatedExtraToolIds?: string[] | null;
  workspaceSkillIds: string[];
  workspaceSkillDescriptions: Record<string, string>;
  workspaceCommandIds: string[];
  toolServerIdMap: Readonly<Record<string, string>>;
  resolvedMcpToolRefs: CompiledWorkspaceRuntimePlan["resolved_mcp_tool_refs"];
  resolvedMcpServerIds: string[];
  composioInlineToolRefs?: Array<{
    name: string;
    toolkit_slug: string;
    tool_slug: string;
    connected_account_id: string;
    read_only?: boolean | null;
  }> | null;
  recalledMemoryContext?: AgentRecalledMemoryContext | null;
  currentUserContext?: AgentCurrentUserContext | null;
  operatorSurfaceContext?: AgentOperatorSurfaceContext | null;
  pendingUserMemoryContext?: AgentPendingUserMemoryContext | null;
  sessionAttachmentContext?: AgentSessionAttachmentContext | null;
  /** When set, this is a HolaApp session: the agent gets STRICTLY that app's MCP
   *  tools — no runtime/browser tools, no workspace skills, no extra tools. */
  appScope?: string | null;
}): AgentRuntimeConfigCliRequest {
  const normalizedSessionKind = normalizedSessionKindValue(
    params.request.session_kind,
  );
  const isToolNodeSession = normalizedSessionKind === "tool_node";
  const delegatedCapabilitySnapshotEligible =
    // The delegated-capability snapshot is internal wiring for an actual
    // delegation (it configures the subagent's tools); its only prompt
    // consumer, `delegated_capability_availability_context`, is already off for
    // the main session, so it never leaks subagent knowledge. Leave it computed
    // even while delegation is hidden — with `delegate_task` gone the main
    // session simply never uses it.
    isDelegatingFrontSessionKind({
      sessionKind: normalizedSessionKind,
    });
  const extraTools = projectExtraToolIdsForSession({
    harnessId: params.harnessId,
    sessionKind: normalizedSessionKind,
    extraToolIds: params.extraToolIds,
    appScope: params.appScope,
  });
  const runtimeToolIds = projectRuntimeToolIdsForSession({
    sessionKind: normalizedSessionKind,
    runtimeToolIds: params.runtimeToolIds,
    appScope: params.appScope,
  });
  const browserToolIds = projectBrowserToolIdsForSession({
    sessionKind: normalizedSessionKind,
    browserToolIds: params.browserToolIds,
    appScope: params.appScope,
  });
  const resolvedMcpToolRefs = projectResolvedMcpToolRefsForSession({
    sessionKind: normalizedSessionKind,
    resolvedMcpToolRefs: params.resolvedMcpToolRefs,
    appScope: params.appScope,
  });
  const delegatedExtraTools = delegatedCapabilitySnapshotEligible
    ? projectExtraToolIdsForSession({
        harnessId: params.harnessId,
        sessionKind: "subagent",
        extraToolIds: params.delegatedExtraToolIds ?? params.extraToolIds,
        appScope: params.appScope,
      })
    : null;
  const delegatedRuntimeToolIds = delegatedCapabilitySnapshotEligible
    ? projectRuntimeToolIdsForSession({
        sessionKind: "subagent",
        runtimeToolIds: params.runtimeToolIds,
        appScope: params.appScope,
      })
    : null;
  const delegatedBrowserToolIds = delegatedCapabilitySnapshotEligible
    ? projectBrowserToolIdsForSession({
        sessionKind: "subagent",
        browserToolIds: params.delegatedBrowserToolIds ?? params.browserToolIds,
        appScope: params.appScope,
      })
    : null;
  const delegatedResolvedMcpToolRefs = delegatedCapabilitySnapshotEligible
    ? projectResolvedMcpToolRefsForSession({
        sessionKind: "subagent",
        resolvedMcpToolRefs: params.resolvedMcpToolRefs,
        appScope: params.appScope,
      })
    : null;
  const resolvedMcpServerIds = projectResolvedMcpServerIdsForSession({
    sessionKind: normalizedSessionKind,
    resolvedMcpServerIds: params.resolvedMcpServerIds,
    appScope: params.appScope,
  });
  // A HolaApp session gets strictly the app's MCP — no workspace skills.
  const workspaceSkillIds = params.appScope?.trim() ? [] : params.workspaceSkillIds;
  const workspaceSkillDescriptions = params.appScope?.trim()
    ? {}
    : params.workspaceSkillDescriptions;
  const common = {
    session_id: params.request.session_id,
    workspace_id: params.request.workspace_id,
    input_id: params.request.input_id,
    session_kind: params.request.session_kind ?? null,
    agent_role: agentRoleFromSessionKind(params.request.session_kind),
    harness_id: params.harnessId,
    browser_tools_available: params.browserToolsAvailable && browserToolIds.length > 0,
    browser_tool_ids: browserToolIds,
    runtime_tool_ids: runtimeToolIds,
    runtime_exec_model_proxy_api_key:
      runtimeExecContextString(params.request, "model_proxy_api_key") ??
      undefined,
    runtime_exec_sandbox_id:
      runtimeExecContextString(params.request, "sandbox_id") ?? undefined,
    runtime_exec_run_id:
      runtimeExecContextString(params.request, "run_id") ?? undefined,
    runtime_exec_org_id:
      runtimeExecContextString(params.request, "org_id") ?? undefined,
    recalled_memory_context: params.recalledMemoryContext ?? undefined,
    current_user_context: params.currentUserContext ?? undefined,
    operator_surface_context: params.operatorSurfaceContext ?? undefined,
    pending_user_memory_context: params.pendingUserMemoryContext ?? undefined,
    session_attachment_context: params.sessionAttachmentContext ?? undefined,
    selected_model: firstNonEmptyString(params.request.model) ?? undefined,
    default_provider_id: defaultProviderId(),
    session_mode: defaultSessionMode(),
    workspace_config_checksum: params.compiledPlan.config_checksum,
    workspace_skill_ids: isToolNodeSession ? [] : [...workspaceSkillIds],
    workspace_skill_descriptions: isToolNodeSession
      ? {}
      : { ...workspaceSkillDescriptions },
    workspace_command_ids: isToolNodeSession
      ? []
      : [...params.workspaceCommandIds],
    default_tools: isToolNodeSession ? [] : [...SUBAGENT_DEFAULT_TOOLS],
    extra_tools: extraTools,
    ...(delegatedCapabilitySnapshotEligible
        ? {
          delegated_session_kind: "subagent",
          delegated_browser_tools_available:
            (params.delegatedBrowserToolsAvailable ??
              params.browserToolsAvailable) &&
            (delegatedBrowserToolIds?.length ?? 0) > 0,
          delegated_browser_tool_ids: [...(delegatedBrowserToolIds ?? [])],
          delegated_runtime_tool_ids: [...(delegatedRuntimeToolIds ?? [])],
          delegated_workspace_command_ids: [...params.workspaceCommandIds],
          delegated_default_tools: [...SUBAGENT_DEFAULT_TOOLS],
          delegated_extra_tools: [...(delegatedExtraTools ?? [])],
        }
      : {}),
    tool_server_id_map: { ...params.toolServerIdMap },
    resolved_mcp_tool_refs: resolvedMcpToolRefs.map((toolRef) => ({
      tool_id: toolRef.tool_id,
      server_id: toolRef.server_id,
      tool_name: toolRef.tool_name,
    })),
    resolved_mcp_server_ids: [...resolvedMcpServerIds],
    composio_inline_tool_refs: (params.composioInlineToolRefs ?? []).map(
      (ref) => ({
        name: ref.name,
        toolkit_slug: ref.toolkit_slug,
        tool_slug: ref.tool_slug,
        connected_account_id: ref.connected_account_id,
        read_only: ref.read_only ?? null,
      }),
    ),
    ...(delegatedCapabilitySnapshotEligible
      ? {
          delegated_resolved_mcp_tool_refs: (
            delegatedResolvedMcpToolRefs ?? []
          ).map((toolRef) => ({
            tool_id: toolRef.tool_id,
            server_id: toolRef.server_id,
            tool_name: toolRef.tool_name,
          })),
          delegated_resolved_mcp_server_ids: [...params.resolvedMcpServerIds],
        }
      : {}),
    resolved_output_schemas: {},
  };
  const toolNodeContextFromRequest = extractToolNodeContextFromRunnerRequest(
    params.request,
    normalizedSessionKind,
  );
  const workflowOwnedSubagent =
    params.request.context.workflow_owned_subagent === true;
  return {
    ...common,
    agent: {
      id: params.compiledPlan.general_config.agent.id,
      model: params.compiledPlan.general_config.agent.model,
      prompt: params.compiledPlan.general_config.agent.prompt,
      role: params.compiledPlan.general_config.agent.role,
    },
    tool_node_context: toolNodeContextFromRequest,
    workflow_owned_subagent: workflowOwnedSubagent,
  };
}

function extractToolNodeContextFromRunnerRequest(
  request: TsRunnerRequest,
  normalizedSessionKind: string,
): AgentRuntimeConfigCliRequest["tool_node_context"] {
  if (normalizedSessionKind !== "tool_node") {
    return null;
  }
  const raw = request.context.tool_node_context;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const toolKind =
    typeof record.tool_kind === "string" ? record.tool_kind.trim() : "";
  if (!toolKind) {
    return null;
  }
  const draftPayload =
    record.draft_payload && typeof record.draft_payload === "object"
      ? (record.draft_payload as Record<string, unknown>)
      : null;
  const outputSchema =
    record.output_schema && typeof record.output_schema === "object"
      ? (record.output_schema as Record<string, unknown>)
      : null;
  const upstreamSummary =
    typeof record.upstream_summary === "string" ? record.upstream_summary : null;
  const upstreamAssistantText =
    typeof record.upstream_assistant_text === "string"
      ? record.upstream_assistant_text
      : null;
  return {
    tool_kind: toolKind,
    draft_payload: draftPayload,
    output_schema: outputSchema,
    upstream_summary: upstreamSummary,
    upstream_assistant_text: upstreamAssistantText,
  };
}

// The desktop runtime only exposes the session-owned agent browser
// (`BrowserSpaceId = "agent"`); the former user-browser surface was retired,
// so any active browser surface resolves to the agent space.
function browserSpaceFromOperatorSurfaceContext(
  context: AgentOperatorSurfaceContext | null | undefined,
): "agent" | null {
  const activeSurfaceId =
    typeof context?.active_surface_id === "string"
      ? context.active_surface_id.trim()
      : "";
  if (activeSurfaceId === "browser:agent" || activeSurfaceId === "browser:user") {
    return "agent";
  }
  const activeBrowserSurface =
    context?.surfaces?.find(
      (surface) => surface.active === true && surface.surface_type === "browser",
    ) ?? null;
  return activeBrowserSurface ? "agent" : null;
}

function terminalHarnessSessionId(event: TsRunnerEvent): string | null {
  if (event.event_type !== "run_completed") {
    return null;
  }
  return firstNonEmptyString(event.payload.harness_session_id);
}

function parseHarnessHostRunnerEvent(
  line: string,
  options: { logger?: LoggerLike } = {},
): TsRunnerEvent | null {
  const stripped = line.trim();
  if (!stripped) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    (options.logger ?? console).warn(
      `Ignoring invalid harness-host event line error=${error instanceof Error ? error.message : String(error)} line=${stripped.slice(0, 500)}`,
    );
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed.payload)) {
    (options.logger ?? console).warn(
      `Ignoring invalid harness-host event line line=${stripped.slice(0, 500)}`,
    );
    return null;
  }
  if (
    typeof parsed.session_id !== "string" ||
    typeof parsed.input_id !== "string" ||
    !Number.isInteger(parsed.sequence) ||
    typeof parsed.event_type !== "string"
  ) {
    (options.logger ?? console).warn(
      `Ignoring invalid harness-host event line line=${stripped.slice(0, 500)}`,
    );
    return null;
  }

  return {
    session_id: parsed.session_id,
    input_id: parsed.input_id,
    sequence: Number(parsed.sequence),
    event_type: parsed.event_type as TsRunnerEvent["event_type"],
    timestamp:
      typeof parsed.timestamp === "string"
        ? parsed.timestamp
        : new Date().toISOString(),
    payload: jsonObject(parsed.payload),
  };
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

function managedWorkspaceRoot(): string {
  return path.dirname(workspaceDirForId("workspace-root"));
}

function resolveRegisteredWorkspaceDir(
  workspaceId: string,
  options: { logger?: LoggerLike } = {},
): string {
  const workspaceRoot = managedWorkspaceRoot();
  const sandboxRoot = path.dirname(workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  if (!fs.existsSync(dbPath)) {
    return workspaceDirForId(workspaceId);
  }
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    return store.workspaceDir(workspaceId);
  } catch (error) {
    options.logger?.warn?.(
      `Falling back to managed workspace path for workspace_id=${workspaceId}: ${errorMessage(error)}`,
    );
    return workspaceDirForId(workspaceId);
  } finally {
    store.close();
  }
}

async function defaultBootstrapApplications(params: {
  request: TsRunnerRequest;
  workspaceRoot: string;
  workspaceDir: string;
  resolvedApplications: unknown[];
}): Promise<PreparedMcpServerPayload[]> {
  if (params.resolvedApplications.length === 0) {
    return [];
  }
  const appLifecycleExecutor: AppLifecycleExecutorLike =
    new RuntimeAppLifecycleExecutor();
  const store = new RuntimeStateStore({
    workspaceRoot: params.workspaceRoot,
    sandboxRoot: path.dirname(params.workspaceRoot),
  });
  try {
    const result = await bootstrapResolvedApplications({
      workspaceDir: params.workspaceDir,
      holabossUserId: explicitHolabossUserId(params.request),
      resolvedApplications: params.resolvedApplications,
      store,
      workspaceId: params.request.workspace_id,
      appLifecycleExecutor,
    });

    return result.applications.map(
      (application: {
        app_id: string;
        mcp_url: string;
        timeout_ms: number;
      }) => ({
        name: application.app_id,
        config: {
          type: "remote" as const,
          enabled: true,
          url: application.mcp_url,
          headers: resolvedApplicationMcpHeaders(params.request),
          timeout: application.timeout_ms,
        },
      }),
    );
  } finally {
    store.close();
  }
}

export function resolvedApplicationMcpHeaders(
  request: TsRunnerRequest,
): Record<string, string> {
  return {
    "X-Workspace-Id": request.workspace_id,
    "X-Holaboss-Workspace-Id": request.workspace_id,
    "X-Holaboss-Session-Id": request.session_id,
    "X-Holaboss-Input-Id": request.input_id,
  };
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

async function defaultRunHarnessHost(params: {
  harness: string;
  requestPayload: Record<string, unknown>;
  workspaceDir: string;
  emitEvent: (event: TsRunnerEvent) => Promise<void>;
  logger?: LoggerLike;
}): Promise<TsRunnerHarnessRelayResult> {
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  if (!fs.existsSync(entryPath)) {
    return {
      exitCode: 1,
      stderr: "",
      sawEvent: false,
      terminalEmitted: false,
      lastSequence: 0,
      missingEntryPath: entryPath,
    };
  }
  const requestBase64 = Buffer.from(
    JSON.stringify(params.requestPayload),
    "utf8",
  ).toString("base64");

  const spawnStartedAtMs = Date.now();
  let firstEventAtMs: number | null = null;
  let firstTokenAtMs: number | null = null;
  let child;
  const harnessCommand = requireRuntimeHarnessAdapter(
    params.harness,
  ).hostCommand;
  try {
    child = spawn(
      runtimeNodeBin(),
      [...argsPrefix, entryPath, harnessCommand, "--request-stdin"],
      {
        cwd: runtimeRootDir(),
        env: buildRunnerEnv(),
        // Send request payloads over stdin so Windows command-line limits do not
        // cap harness launches for larger chat contexts.
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return {
      exitCode: 1,
      stderr: "",
      sawEvent: false,
      terminalEmitted: false,
      lastSequence: 0,
      spawnError: errorMessage(error),
    };
  }

  let stdinError = "";
  writeEncodedRequestToChildStdin(child.stdin, requestBase64, (error) => {
    if (!stdinError) {
      stdinError = errorMessage(error);
    }
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let sawEvent = false;
  let terminalEmitted = false;
  let lastSequence = 0;
  let firstEventTimedOut = false;
  // Watchdog: if the child does not emit a single event within the budget, it
  // is wedged in bootstrap (e.g. an MCP transport open that never returns).
  // SIGKILL it so the for-await loop unwinds and the caller synthesizes a
  // `run_failed` event for the UI instead of leaving the user staring at
  // "Checking workspace context" for the runner-worker's hard-timeout window.
  const firstEventTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (sawEvent) {
      return;
    }
    firstEventTimedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort; if the child is already gone, the for-await loop will
      // exit on its own.
    }
  }, HARNESS_HOST_FIRST_EVENT_TIMEOUT_MS);
  const clearFirstEventTimer = () => {
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
    }
  };
  const stdout = child.stdout;
  if (stdout) {
    stdout.setEncoding("utf8");
    const lines = createInterface({
      input: stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      const event = parseHarnessHostRunnerEvent(line, {
        logger: params.logger,
      });
      if (!event) {
        continue;
      }
      if (!sawEvent) {
        clearFirstEventTimer();
      }
      if (firstEventAtMs === null) {
        firstEventAtMs = Date.now();
      }
      if (
        firstTokenAtMs === null &&
        (event.event_type === "output_delta" ||
          event.event_type === "thinking_delta")
      ) {
        firstTokenAtMs = Date.now();
      }
      sawEvent = true;
      lastSequence = Math.max(lastSequence, event.sequence);
      await params.emitEvent(event);
      if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
        terminalEmitted = true;
      }
    }
  }
  clearFirstEventTimer();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  const stderrSuffix = firstEventTimedOut
    ? `harness-host produced no events within ${HARNESS_HOST_FIRST_EVENT_TIMEOUT_MS}ms; killed`
    : "";
  const normalizedStderr = [stderr.trim(), stdinError, stderrSuffix]
    .filter((value) => value.length > 0)
    .join("\n");

  return {
    exitCode,
    stderr: normalizedStderr,
    sawEvent,
    terminalEmitted,
    lastSequence,
    harnessSpawnToFirstEventMs:
      firstEventAtMs === null ? undefined : firstEventAtMs - spawnStartedAtMs,
    harnessSpawnToFirstTokenMs:
      firstTokenAtMs === null ? undefined : firstTokenAtMs - spawnStartedAtMs,
  };
}

function defaultExecutionDeps(): TsRunnerExecutionDeps {
  return {
    bootstrapApplications: defaultBootstrapApplications,
    // Capability MCP is now registered into workspace.yaml's mcp_registry on
    // install (like apps), so the compiled plan already includes it — no
    // separate capability-MCP merge here.
    compilePlan: ({ workspaceId, workspaceDir }) =>
      compileWorkspaceRuntimePlanFromWorkspace({ workspaceId, workspaceDir }),
    projectAgentRuntimeConfig: (request) => projectAgentRuntimeConfig(request),
    resolveHarnessPlugin: (harness) => requireRuntimeHarnessPlugin(harness),
    runHarnessHost: defaultRunHarnessHost,
    loadOperatorSurfaceContext,
    loadRecalledMemoryContext,
    startWorkspaceMcpSidecar: async (request) => {
      const result = await startWorkspaceMcpSidecar(request);
      return {
        physical_server_id: request.physical_server_id,
        url: result.url,
        pid: result.pid,
        reused: result.reused,
        timeout_ms: request.timeout_ms,
      };
    },
  };
}

function synthesizeHarnessHostFailureMessage(
  result: TsRunnerHarnessRelayResult,
): string {
  if (result.missingEntryPath) {
    return `TypeScript harness host entry not found at ${result.missingEntryPath}`;
  }
  if (result.spawnError) {
    return `Failed to start TypeScript harness host: ${result.spawnError}`;
  }
  if (
    !result.sawEvent &&
    result.exitCode === HARNESS_HOST_NOT_IMPLEMENTED_EXIT_CODE
  ) {
    return result.stderr
      ? `TypeScript harness host reported unimplemented adapter: ${result.stderr}`
      : "TypeScript harness host reported unimplemented adapter";
  }

  let message =
    result.exitCode !== 0
      ? `TypeScript harness host failed with exit code ${result.exitCode}`
      : "TypeScript harness host ended before terminal event";
  if (result.stderr) {
    message = `${message}: ${result.stderr}`;
  }
  return message;
}

export function decodeTsRunnerRequest(encoded: string): TsRunnerRequest {
  return validateTsRunnerRequest(decodeTsRunnerRequestPayload(encoded));
}

export function resolveTsRunnerBootstrapState(
  request: TsRunnerRequest,
  options: { logger?: LoggerLike } = {},
): TsRunnerBootstrapState {
  const logger = options.logger ?? console;
  const runtimeExecContext = request.context[RUNTIME_EXEC_CONTEXT_KEY];
  if (runtimeExecContext !== undefined && !isRecord(runtimeExecContext)) {
    throw new Error("_sandbox_runtime_exec_v1 must be an object when provided");
  }

  const resolvedExecContext = isRecord(runtimeExecContext)
    ? runtimeExecContext
    : null;
  const requestedHarnessSessionId = firstNonEmptyString(
    resolvedExecContext?.harness_session_id,
  );
  const harness = selectedHarness(request);
  const harnessAdapter = requireRuntimeHarnessAdapter(harness);
  const workspaceRoot = managedWorkspaceRoot();
  // workspace_dir is always the workspace's metadata root. The agent's actual
  // cwd is carried separately as `agent_cwd` so the harness can load
  // workspace.yaml/skills/etc. from the workspace dir even when the agent
  // is running from a project path or the managed workspace root.
  const workspaceDir = resolveRegisteredWorkspaceDir(request.workspace_id, {
    logger,
  });
  const callerProvidedAgentCwd =
    typeof request.agent_cwd === "string" &&
    request.agent_cwd.trim().length > 0
      ? request.agent_cwd.trim()
      : null;
  const agentCwd = callerProvidedAgentCwd ?? workspaceDir;
  // `persisted_harness_session_id` is the resume pointer the host runner passes
  // to the CLI (--resume / thread resume). How we source it depends on the
  // harness's resume model:
  //
  //   - pi (resumesFromExecContextSessionId): the runner resumes from the
  //     session file in the exec-context (`harness_session_id`). Feeding the
  //     cwd-scoped workspace-file id on top would double-resume, so suppress it
  //     whenever a session is already bound. Otherwise fall back to the
  //     workspace file keyed by (workspace, harness, agentCwd).
  //
  //   - CLI harnesses (Claude Code, Codex, …): the runner ONLY reads
  //     `persisted_harness_session_id`, and the harness assigns its own opaque
  //     session id. The per-session binding (`requestedHarnessSessionId`) holds
  //     that captured real id from turn 2 onward — but on turn 1 it's just the
  //     runtime session id placeholder (=== request.session_id), which the CLI
  //     won't recognize. Resume from the binding's real id so each chat resumes
  //     its OWN conversation (cwd-keyed workspace files can't tell two chats in
  //     the same cwd apart); on turn 1, or with no binding, start fresh / fall
  //     back to the workspace file.
  const runtimeSessionId = firstNonEmptyString(request.session_id);
  let persistedHarnessSessionId: string | null;
  if (harnessAdapter.capabilities.resumesFromExecContextSessionId === true) {
    persistedHarnessSessionId = requestedHarnessSessionId
      ? null
      : readWorkspaceHarnessSessionId({
          workspaceDir,
          harness,
          agentCwd,
          logger,
        });
  } else if (requestedHarnessSessionId) {
    persistedHarnessSessionId =
      requestedHarnessSessionId !== runtimeSessionId
        ? requestedHarnessSessionId
        : null;
  } else {
    persistedHarnessSessionId = readWorkspaceHarnessSessionId({
      workspaceDir,
      harness,
      agentCwd,
      logger,
    });
  }

  return {
    harness,
    workspaceRoot,
    workspaceDir,
    agentCwd,
    runtimeExecContext: resolvedExecContext,
    requestedHarnessSessionId,
    persistedHarnessSessionId,
  };
}

export async function relayTsRunnerEvent(params: {
  emitEvent: (event: TsRunnerEvent) => Promise<void>;
  event: TsRunnerEvent;
  harness: string;
  workspaceDir: string;
  agentCwd?: string | null;
  persistHarnessSessionState?: boolean;
  logger?: LoggerLike;
}): Promise<void> {
  await params.emitEvent(params.event);
  if (params.persistHarnessSessionState === false) {
    return;
  }
  const sessionId = terminalHarnessSessionId(params.event);
  if (params.event.event_type === "run_failed") {
    clearWorkspaceHarnessSessionId({
      workspaceDir: params.workspaceDir,
      harness: params.harness,
      agentCwd: params.agentCwd,
      logger: params.logger,
    });
    return;
  }
  if (!sessionId) {
    return;
  }
  persistWorkspaceHarnessSessionId({
    workspaceDir: params.workspaceDir,
    harness: params.harness,
    sessionId,
    agentCwd: params.agentCwd,
    logger: params.logger,
  });
}

export async function executeTsRunnerRequest(
  request: TsRunnerRequest,
  options: {
    deps?: Partial<TsRunnerExecutionDeps>;
    emitEvent: (event: TsRunnerEvent) => Promise<void>;
    logger?: LoggerLike;
  },
): Promise<void> {
  const logger = options.logger ?? console;
  const deps = { ...defaultExecutionDeps(), ...options.deps };
  const bootstrap = resolveTsRunnerBootstrapState(request, { logger });
  const persistHarnessSessionState = !runtimeExecContextBoolean(
    request,
    "ephemeral_harness_session",
  );
  const harnessPlugin = deps.resolveHarnessPlugin(bootstrap.harness);
  const harnessAdapter = harnessPlugin.adapter;
  const bootstrapStartedAtMs = Date.now();
  const bootstrapStartedAt = new Date(bootstrapStartedAtMs).toISOString();
  const bootstrapStageTimingsMs: BootstrapStageTimingMap = {};
  let syntheticSequence = 0;

  await relayTsRunnerEvent({
    emitEvent: options.emitEvent,
    harness: bootstrap.harness,
    workspaceDir: bootstrap.workspaceDir,
    agentCwd: bootstrap.agentCwd,
    persistHarnessSessionState,
    logger,
    event: buildTsRunnerEvent({
      sessionId: request.session_id,
      inputId: request.input_id,
      sequence: ++syntheticSequence,
      eventType: "run_claimed",
      payload: {
        instruction_preview: request.instruction.slice(0, 120),
      },
    }),
  });

  try {
    const runnerPrepPlan = harnessAdapter.buildRunnerPrepPlan({
      request,
      bootstrap,
    });
    const browserConfig = currentBrowserConfig();
    const stagedBrowserTools = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "stage_browser_tools",
      () =>
        harnessPlugin.stageBrowserTools({
          workspaceDir: bootstrap.workspaceDir,
          sessionKind: request.session_kind,
          browserConfig,
        }),
    );
    const stagedDelegatedBrowserTools =
      isDelegatingFrontSessionKind({
        sessionKind: request.session_kind,
      })
        ? measureBootstrapStage(
            bootstrapStageTimingsMs,
            "stage_delegated_browser_tools",
            () =>
              harnessPlugin.stageBrowserTools({
                workspaceDir: bootstrap.workspaceDir,
                sessionKind: "subagent",
                browserConfig,
              }),
          )
        : null;
    const stagedRuntimeTools = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "stage_runtime_tools",
      () =>
        harnessPlugin.stageRuntimeTools({
          workspaceDir: bootstrap.workspaceDir,
        }),
    );
    const workspaceSkills = projectWorkspaceSkillsForSession({
      sessionKind: request.session_kind,
      workspaceSkills: measureBootstrapStage(
        bootstrapStageTimingsMs,
        "resolve_workspace_skills",
        () => {
          return projectSessionVisibleWorkspaceSkills({
            workspaceSkills: resolveWorkspaceSkills(bootstrap.workspaceDir),
          });
        },
      ),
    });
    const preparedInstruction = prepareInstructionWithQuotedWorkspaceSkills({
      instruction: request.instruction,
      workspaceSkills,
    });
    const stagedSkills = runnerPrepPlan.stageWorkspaceSkills
      ? measureBootstrapStage(
          bootstrapStageTimingsMs,
          "stage_workspace_skills",
          () =>
            harnessPlugin.stageSkills({
              workspaceDir: bootstrap.workspaceDir,
              runtimeRoot: runtimeRootDir(),
            }),
        )
      : { changed: false, skillIds: [] };
    const stagedCommands = runnerPrepPlan.stageWorkspaceCommands
      ? measureBootstrapStage(
          bootstrapStageTimingsMs,
          "stage_workspace_commands",
          () =>
            harnessPlugin.stageCommands({
              workspaceDir: bootstrap.workspaceDir,
            }),
        )
      : { changed: false, commandIds: [] };

    // Composio inline tools are an optional capability GET (5s timeout) that
    // only depends on the request ids — not on the compiled plan. It used to be
    // awaited serially just before the sidecar (blocking the critical path) and
    // was NOT wrapped in a stage timer, so it was the prime suspect for the
    // large "unaccounted" slice of bootstrap_total_ms. Fire it now, in parallel
    // with plan compilation / memory recall / MCP setup, and only await it where
    // its result is consumed below. `composio_inline_tools_fetch` records the
    // raw fetch time; `await_composio_inline_tools` (at the consume site) records
    // the residual block after overlap — together they make this cost visible.
    const composioInlineToolRefsStartedAtMs = Date.now();
    const composioInlineToolRefsPrefetch = fetchComposioInlineToolRefs({
      runtimeApiBaseUrl: currentRuntimeApiUrl(),
      workspaceId: request.workspace_id,
      sessionId: request.session_id,
      inputId: request.input_id,
    }).then((refs) => {
      bootstrapStageTimingsMs["composio_inline_tools_fetch"] = elapsedMs(
        composioInlineToolRefsStartedAtMs,
      );
      return refs;
    });

    const compiledPlan = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "compile_runtime_plan",
      () =>
        deps.compilePlan({
          workspaceId: request.workspace_id,
          workspaceDir: bootstrap.workspaceDir,
        }),
    );
    const recalledMemoryPrefetch = startRecalledMemoryContextPrefetch({
      load: () =>
        deps.loadRecalledMemoryContext({
          workspaceRoot: bootstrap.workspaceRoot,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          request,
          instruction: request.instruction,
          logger,
        }),
      logger,
    });
    const serverIdMap = runnerPrepPlan.prepareMcpTooling
      ? mcpServerIdMap({
          workspaceId: request.workspace_id,
          sandboxId: workspaceMcpSandboxId(),
          compiledPlan,
        })
      : {};
    const resolvedMcpToolRefs = runnerPrepPlan.prepareMcpTooling
      ? compiledPlan.resolved_mcp_tool_refs
      : [];
    const composioInlineToolRefs = await measureBootstrapStageAsync(
      bootstrapStageTimingsMs,
      "await_composio_inline_tools",
      () => composioInlineToolRefsPrefetch,
    );
    const physicalWorkspaceServerId = serverIdMap.workspace ?? "workspace";

    let sidecar: RunningWorkspaceMcpSidecar | null = null;
    if (
      runnerPrepPlan.startWorkspaceMcpSidecar &&
      compiledPlan.workspace_mcp_catalog.length > 0
    ) {
      let timeoutMs = 10000;
      for (const server of compiledPlan.resolved_mcp_servers) {
        if (server.server_id === "workspace") {
          timeoutMs = server.timeout_ms;
          break;
        }
      }
      sidecar = await measureBootstrapStageAsync(
        bootstrapStageTimingsMs,
        "start_workspace_mcp_sidecar",
        async () =>
          await deps.startWorkspaceMcpSidecar({
            workspace_dir: bootstrap.workspaceDir,
            physical_server_id: physicalWorkspaceServerId,
            expected_fingerprint: workspaceMcpCatalogFingerprint(compiledPlan),
            timeout_ms: timeoutMs,
            readiness_timeout_s: WORKSPACE_MCP_READY_TIMEOUT_S,
            catalog_json_base64: encodeWorkspaceMcpCatalog(compiledPlan),
          }),
      );
    }

    let effectiveMcpServers = runnerPrepPlan.prepareMcpTooling
      ? effectiveMcpServerPayloads({
          compiledPlan,
          sidecar,
          serverIdMap,
        })
      : [];

    // Surface servers dropped during payload prep (an unset {env:VAR} secret) the
    // same way the harness surfaces discovery failures — otherwise a capability's
    // tools vanish with no signal. This path is upstream of the harness, so the
    // harness never sees these servers and can't report them itself.
    if (runnerPrepPlan.prepareMcpTooling) {
      for (const unavailable of mcpServersUnavailableForMissingEnv(compiledPlan, serverIdMap)) {
        await relayTsRunnerEvent({
          emitEvent: options.emitEvent,
          harness: bootstrap.harness,
          workspaceDir: bootstrap.workspaceDir,
          agentCwd: bootstrap.agentCwd,
          persistHarnessSessionState,
          logger,
          event: buildTsRunnerEvent({
            sessionId: request.session_id,
            inputId: request.input_id,
            sequence: ++syntheticSequence,
            eventType: "mcp_server_unavailable",
            payload: {
              server_id: unavailable.serverId,
              reason: unavailable.reason,
              missing_tool_ids: unavailable.missingToolIds,
            },
          }),
        });
      }
    }

    // A HolaApp session restricts the whole run to strictly that app's MCP.
    const appScope = appScopeFromRequest(request);
    const directResolvedMcpToolRefs = projectResolvedMcpToolRefsForSession({
      sessionKind: request.session_kind,
      resolvedMcpToolRefs,
      appScope,
    });

    if (
      runnerPrepPlan.bootstrapResolvedApplications &&
      compiledPlan.resolved_applications.length > 0
    ) {
      effectiveMcpServers = mergePreparedMcpServerPayloads(
        effectiveMcpServers,
        await measureBootstrapStageAsync(
          bootstrapStageTimingsMs,
          "bootstrap_resolved_applications",
          async () =>
            await deps.bootstrapApplications({
              request,
              workspaceRoot: bootstrap.workspaceRoot,
              workspaceDir: bootstrap.workspaceDir,
              resolvedApplications: compiledPlan.resolved_applications,
            }),
        ),
      );
    }

    const directMcpServerIds = new Set(
      projectResolvedMcpServerIdsForSession({
        sessionKind: request.session_kind,
        resolvedMcpServerIds: effectiveMcpServers.map((server) => server.name),
        appScope,
      }),
    );
    const directMcpServers = effectiveMcpServers.filter((server) =>
      directMcpServerIds.has(server.name),
    );

    const recalledMemoryContext = await measureBootstrapStageAsync(
      bootstrapStageTimingsMs,
      "load_recalled_memory_context",
      async () =>
        await consumeRecalledMemoryContextPrefetch(recalledMemoryPrefetch),
    );
    const currentUserContext = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "load_current_user_context",
      () =>
        loadCurrentUserContext({
          workspaceRoot: bootstrap.workspaceRoot,
          logger,
        }),
    );
    const operatorSurfaceContext = await measureBootstrapStageAsync(
      bootstrapStageTimingsMs,
      "load_operator_surface_context",
      async () =>
        await deps.loadOperatorSurfaceContext({
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          browserConfig,
          logger,
        }),
    );
    const pendingUserMemoryContext = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "load_pending_user_memory_context",
      () =>
        loadPendingUserMemoryContext({
          workspaceRoot: bootstrap.workspaceRoot,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          logger,
        }),
    );
    const sessionAttachmentContext = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "load_session_attachment_context",
      () =>
        loadSessionAttachmentContext({
          workspaceRoot: bootstrap.workspaceRoot,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          currentInputId: request.input_id,
          logger,
        }),
    );
    const runtimeConfig = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "project_runtime_config",
      () =>
        deps.projectAgentRuntimeConfig(
          buildAgentRuntimeConfigRequest({
            request,
            harnessId: bootstrap.harness,
            browserToolsAvailable: stagedBrowserTools.toolIds.length > 0,
            browserToolIds: [...stagedBrowserTools.toolIds],
            delegatedBrowserToolsAvailable:
              stagedDelegatedBrowserTools?.toolIds.length
                ? true
                : false,
            delegatedBrowserToolIds: [
              ...(stagedDelegatedBrowserTools?.toolIds ?? []),
            ],
            runtimeToolIds: [...stagedRuntimeTools.toolIds],
            compiledPlan,
            extraToolIds: [
              ...stagedBrowserTools.toolIds,
              ...stagedRuntimeTools.toolIds,
            ],
            delegatedExtraToolIds: [
              ...(stagedDelegatedBrowserTools?.toolIds ?? []),
              ...stagedRuntimeTools.toolIds,
            ],
            workspaceSkillIds: workspaceSkills.map((skill) => skill.skill_id),
            workspaceSkillDescriptions: Object.fromEntries(
              workspaceSkills.map((skill) => [skill.skill_id, skill.description]),
            ),
            workspaceCommandIds: stagedCommands.commandIds,
            toolServerIdMap: serverIdMap,
            resolvedMcpToolRefs,
            resolvedMcpServerIds: effectiveMcpServers.map(
              (server) => server.name,
            ),
            composioInlineToolRefs,
            recalledMemoryContext,
            currentUserContext,
            operatorSurfaceContext,
            pendingUserMemoryContext,
            sessionAttachmentContext,
            appScope,
          }),
        ),
    );

    await measureBootstrapStageAsync(
      bootstrapStageTimingsMs,
      "prepare_harness_run",
      async () =>
        await harnessPlugin.prepareRun({
          request,
          bootstrap,
          runtimeConfig,
          stagedSkillsChanged:
            stagedSkills.changed ||
            stagedBrowserTools.changed ||
            stagedRuntimeTools.changed,
        }),
    );

    const backendBaseUrl = harnessPlugin.backendBaseUrl({
      workspaceId: request.workspace_id,
      workspaceDir: bootstrap.workspaceDir,
    });
    if (harnessAdapter.capabilities.requiresBackend && !backendBaseUrl.trim()) {
      throw new Error(
        `backend base URL was not resolved for harness '${bootstrap.harness}'`,
      );
    }

    const buildHarnessHostRequestStartedAtMs = Date.now();
    const provisionalRunStartedPayload = bootstrapStartedPayload({
      request,
      runtimeConfig,
      requestSnapshotFingerprint: null,
      harnessSupportsStructuredOutput:
        harnessAdapter.capabilities.supportsStructuredOutput,
      mcpServerIdMap: serverIdMap,
      mcpServers: directMcpServers,
      sidecar,
      bootstrapStartedAt,
      bootstrapReadyAt: bootstrapStartedAt,
      bootstrapTotalMs: 0,
      bootstrapStageTimingsMs,
    });
    const provisionalHarnessRequestPayload =
      harnessAdapter.buildHarnessHostRequest({
        request,
        bootstrap,
        runtimeConfig,
        prepared_instruction: preparedInstruction,
        browserSpace: browserSpaceFromOperatorSurfaceContext(operatorSurfaceContext),
        runtimeApiBaseUrl: currentRuntimeApiUrl(),
        workspaceSkills,
        mcpServers: directMcpServers,
        mcpToolRefs: directResolvedMcpToolRefs.map((toolRef) => ({
          tool_id: toolRef.tool_id,
          server_id: serverIdMap[toolRef.server_id] ?? toolRef.server_id,
          tool_name: toolRef.tool_name,
        })),
        runStartedPayload: provisionalRunStartedPayload,
        backendBaseUrl,
        timeoutSeconds: harnessPlugin.timeoutSeconds({ request }),
      });
    const provisionalSnapshotPayload = turnRequestSnapshotPayload({
      request,
      bootstrap,
      runtimeConfig,
      harnessRequestPayload: provisionalHarnessRequestPayload,
    });
    const requestSnapshotFingerprint = turnRequestSnapshotFingerprint(
      provisionalSnapshotPayload,
    );
    const runStartedPayload = bootstrapStartedPayload({
      request,
      runtimeConfig,
      requestSnapshotFingerprint,
      harnessSupportsStructuredOutput:
        harnessAdapter.capabilities.supportsStructuredOutput,
      mcpServerIdMap: serverIdMap,
      mcpServers: directMcpServers,
      sidecar,
      bootstrapStartedAt,
      bootstrapReadyAt: bootstrapStartedAt,
      bootstrapTotalMs: 0,
      bootstrapStageTimingsMs,
    });
    const harnessRequestPayload = harnessAdapter.buildHarnessHostRequest({
      request,
      bootstrap,
      runtimeConfig,
      prepared_instruction: preparedInstruction,
      browserSpace: browserSpaceFromOperatorSurfaceContext(operatorSurfaceContext),
      runtimeApiBaseUrl: currentRuntimeApiUrl(),
      workspaceSkills,
      mcpServers: directMcpServers,
      mcpToolRefs: directResolvedMcpToolRefs.map((toolRef) => ({
        tool_id: toolRef.tool_id,
        server_id: serverIdMap[toolRef.server_id] ?? toolRef.server_id,
        tool_name: toolRef.tool_name,
      })),
      runStartedPayload,
      backendBaseUrl,
      // Floor pi's own abort timer at the run's resolved ceiling (e.g. a
      // scheduled run's 2h) so a long automation isn't self-aborted at the
      // 30-min main-session default while the runner's hard deadline waits.
      timeoutSeconds: effectiveHarnessRunTimeoutSeconds({
        pluginTimeoutSeconds: harnessPlugin.timeoutSeconds({ request }),
        requestOverrideSeconds: request.harness_timeout_seconds,
      }),
    });
    measureBootstrapStage(
      bootstrapStageTimingsMs,
      "persist_turn_request_snapshot",
      () =>
        persistTurnRequestSnapshot({
          workspaceRoot: bootstrap.workspaceRoot,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          snapshotKind: "harness_host_request",
          payload: turnRequestSnapshotPayload({
            request,
            bootstrap,
            runtimeConfig,
            harnessRequestPayload,
          }),
          logger,
        }),
    );
    bootstrapStageTimingsMs.build_harness_host_request = elapsedMs(
      buildHarnessHostRequestStartedAtMs,
    );
    runStartedPayload.bootstrap_ready_at = new Date().toISOString();
    runStartedPayload.bootstrap_total_ms = elapsedMs(bootstrapStartedAtMs);
    runStartedPayload.bootstrap_stage_timings_ms = {
      ...bootstrapStageTimingsMs,
    };
    const harnessResult = await measureBootstrapStageAsync(
      bootstrapStageTimingsMs,
      "launch_harness_host",
      async () =>
        await deps.runHarnessHost({
          harness: bootstrap.harness,
          requestPayload: harnessRequestPayload,
          workspaceDir: bootstrap.workspaceDir,
          logger,
          emitEvent: async (event) => {
            await relayTsRunnerEvent({
              emitEvent: options.emitEvent,
              event,
              harness: bootstrap.harness,
              workspaceDir: bootstrap.workspaceDir,
              agentCwd: bootstrap.agentCwd,
              persistHarnessSessionState,
              logger,
            });
          },
        }),
    );

    // TTFT dissection — one greppable line per turn in runtime.log:
    //   bootstrap  = in-process request build (ts-runner stages)
    //   harness_load = spawn → first harness event (node start + 1.1MB bundle load)
    //   model_ttft = first event → first output/thinking delta (model network + gen)
    //   total      = bootstrap + spawn → first token
    {
      const bootstrapMs =
        typeof runStartedPayload.bootstrap_total_ms === "number"
          ? runStartedPayload.bootstrap_total_ms
          : null;
      const loadMs = harnessResult.harnessSpawnToFirstEventMs ?? null;
      const firstTokenFromSpawnMs =
        harnessResult.harnessSpawnToFirstTokenMs ?? null;
      const modelTtftMs =
        loadMs !== null && firstTokenFromSpawnMs !== null
          ? Math.max(0, firstTokenFromSpawnMs - loadMs)
          : null;
      const totalTtftMs =
        bootstrapMs !== null && firstTokenFromSpawnMs !== null
          ? bootstrapMs + firstTokenFromSpawnMs
          : null;
      logger.warn(
        `[ttft] session=${request.session_id} input=${request.input_id} ` +
          `model=${runtimeConfig.model_id} ` +
          `bootstrap_ms=${bootstrapMs ?? "n/a"} ` +
          `harness_load_ms=${loadMs ?? "n/a"} ` +
          `model_ttft_ms=${modelTtftMs ?? "n/a"} ` +
          `total_ttft_ms=${totalTtftMs ?? "n/a"}`,
      );
    }

    if (harnessResult.terminalEmitted) {
      return;
    }

    await relayTsRunnerEvent({
      emitEvent: options.emitEvent,
      harness: bootstrap.harness,
      workspaceDir: bootstrap.workspaceDir,
      agentCwd: bootstrap.agentCwd,
      persistHarnessSessionState,
      logger,
      event: buildTsRunnerFailureEvent({
        sessionId: request.session_id,
        inputId: request.input_id,
        sequence: harnessResult.sawEvent ? harnessResult.lastSequence + 1 : 1,
        errorType: "RuntimeError",
        message: synthesizeHarnessHostFailureMessage(harnessResult),
      }),
    });
  } catch (error) {
    await relayTsRunnerEvent({
      emitEvent: options.emitEvent,
      harness: bootstrap.harness,
      workspaceDir: bootstrap.workspaceDir,
      agentCwd: bootstrap.agentCwd,
      persistHarnessSessionState,
      logger,
      event: buildTsRunnerFailureEvent({
        sessionId: request.session_id,
        inputId: request.input_id,
        sequence: 2,
        errorType: errorTypeFor(error),
        message: `${bootstrap.harness} execution failed: ${errorMessage(error)}`,
      }),
    });
  }
}

export async function runTsRunnerCli(
  argv: string[],
  options: {
    deps?: Partial<TsRunnerExecutionDeps>;
    io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
    fetchImpl?: typeof fetch;
    logger?: LoggerLike;
  } = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  installBenignStdioEpipeGuard(io);
  const logger = options.logger ?? console;
  // `--request-file <path>` reads the base64 request from a temp file. The
  // runner (runner-worker) uses this so a large request never lands on the
  // command line, which Windows caps at ~32,767 chars (spawn ENAMETOOLONG).
  // `--request-base64 <b64>` (or a bare first arg) stays supported for callers
  // and tests that pass small requests inline.
  let requestBase64: string;
  if (argv[0] === "--request-file") {
    const requestFilePath = argv[1] ?? "";
    if (!requestFilePath) {
      io.stderr.write("--request-file requires a path\n");
      return 2;
    }
    try {
      requestBase64 = fs.readFileSync(requestFilePath, "utf8").trim();
    } catch (error) {
      io.stderr.write(
        `failed to read runner request file: ${errorMessage(error)}\n`,
      );
      return 2;
    }
  } else if (argv[0] === "--request-base64") {
    requestBase64 = argv[1] ?? "";
  } else {
    requestBase64 = argv[0] ?? "";
  }

  if (!requestBase64) {
    io.stderr.write("request_base64 is required\n");
    return 2;
  }

  let decodedPayload: unknown;
  let request: TsRunnerRequest;
  try {
    decodedPayload = decodeTsRunnerRequestPayload(requestBase64);
    request = validateTsRunnerRequest(decodedPayload);
  } catch (error) {
    const ids = fallbackEventIdentity(decodedPayload);
    await emitTsRunnerEventWithPush({
      io,
      event: buildTsRunnerFailureEvent({
        sessionId: ids.sessionId,
        inputId: ids.inputId,
        sequence: 1,
        errorType: errorTypeFor(error),
        message: `invalid runner request payload: ${errorMessage(error)}`,
      }),
      pushClient: null,
      fetchImpl: options.fetchImpl,
    });
    return 1;
  }

  const pushClient = createPushEventClient(request);
  try {
    await executeTsRunnerRequest(request, {
      deps: options.deps,
      logger,
      emitEvent: async (event) => {
        await emitTsRunnerEventWithPush({
          io,
          event,
          pushClient,
          fetchImpl: options.fetchImpl,
        });
      },
    });
    return 0;
  } finally {
    await closePushEventClient(pushClient);
  }
}

async function main(): Promise<void> {
  process.exitCode = await runTsRunnerCli(process.argv.slice(2));
}

// See workspace-runtime-plan.ts for why the usual import.meta.url guard
// isn't sufficient when these files are re-bundled into dist/index.mjs.
const TS_RUNNER_CLI_BASENAME = "ts-runner";
if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  path.basename(process.argv[1] ?? "", path.extname(process.argv[1] ?? "")) ===
    TS_RUNNER_CLI_BASENAME
) {
  await main();
}

export { validateTsRunnerRequest };
