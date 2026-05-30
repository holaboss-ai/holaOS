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
  AgentEvolveCandidateContext,
  AgentOperatorSurfaceMutability,
  AgentOperatorSurfaceOwner,
  AgentOperatorSurfaceContext,
  AgentOperatorSurfaceType,
  AgentPendingUserMemoryContext,
  AgentRecentRuntimeContext,
  AgentSessionAttachmentContext,
  AgentScratchpadContext,
  AgentTeammateRoutingContext,
} from "./agent-runtime-prompt.js";
import { buildTeammateRoutingRosterEntry } from "./teammate-routing.js";
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
} from "./workspace-skills.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";
import {
  normalizeHarnessId,
  requireRuntimeHarnessAdapter,
  requireRuntimeHarnessPlugin,
  type RuntimeHarnessPlugin,
} from "./harness-registry.js";
import { buildRunnerEnv } from "./runner-worker.js";
import {
  startWorkspaceMcpSidecar,
  type WorkspaceMcpSidecarCliRequest,
} from "./workspace-mcp-sidecar.js";
import type { CompiledWorkspaceRuntimePlan } from "./workspace-runtime-plan.js";
import { buildRecalledWorkspaceMemoryContext } from "./workspace-memory.js";
import { readSessionScratchpad } from "./session-scratchpad.js";
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
const WORKSPACE_ONBOARDING_IMPLEMENTING_STATE = "implementing";
const MAIN_SESSION_DEFAULT_TOOLS = [
  "read",
  "ripgrep",
  "glob",
  "list",
  "question",
  "skill",
];
const ONBOARDING_DEFAULT_TOOLS = [
  "read",
  "ripgrep",
  "glob",
  "list",
  "question",
  "skill",
];
const SUBAGENT_DEFAULT_TOOLS = [
  "read",
  "edit",
  "bash",
  "ripgrep",
  "glob",
  "list",
  "question",
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
const WORKSPACE_ONBOARDING_IMPLEMENTATION_ONLY_RUNTIME_TOOL_IDS = new Set([
  ...SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS,
  "cronjobs_list",
  "cronjobs_create",
  "cronjobs_get",
  "cronjobs_update",
  "cronjobs_delete",
  "image_generate",
  "download_url",
  "write_report",
  "terminal_sessions_list",
  "terminal_session_start",
  "terminal_session_get",
  "terminal_session_read",
  "terminal_session_wait",
  "terminal_session_send_input",
  "terminal_session_signal",
  "terminal_session_close",
  "workspace_data_list_tables",
  "workspace_data_describe_table",
  "workspace_data_sample_rows",
  "workspace_data_query",
]);
const SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS = new Set([
  "onboarding_status",
  "holaboss_create_alignment_report",
  "holaboss_create_alignment_question",
  "holaboss_create_verification_report",
  "holaboss_onboarding_complete",
  "cronjobs_list",
  "cronjobs_create",
  "cronjobs_get",
  "cronjobs_update",
  "cronjobs_delete",
  "teammates_list",
  "teammates_create",
  "teammate_skills_create",
]);
const HR_ONLY_RUNTIME_TOOL_IDS = new Set([
  "teammates_list",
  "teammates_create",
  "teammate_skills_create",
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
const MAIN_SESSION_RUNTIME_TOOL_IDS = new Set([
  "delegate_task",
  "get_task",
  "list_tasks",
  "reply_task",
  "cancel_task",
  "rerun_task",
  "update_workspace_instructions",
  "cronjobs_list",
  "cronjobs_create",
  "cronjobs_get",
  "cronjobs_update",
  "cronjobs_delete",
  "workspace_integrations_list_catalog",
  "holaboss_workspace_integrations_propose_connect",
  "holaboss_workspace_integrations_set_default_account",
]);
const ONBOARDING_SESSION_RUNTIME_TOOL_IDS = new Set([
  ...Array.from(MAIN_SESSION_RUNTIME_TOOL_IDS).filter(
    (toolId) =>
      !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
      !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId),
  ),
  "onboarding_status",
  "holaboss_onboarding_complete",
]);
const BROWSER_RETRY_REQUEST_PATTERN = /\b(?:try again|retry|do it again|again)\b/i;
const BROWSER_ACTION_REQUEST_PATTERN =
  /\b(?:browser|tab|page|site|url|open|go to|navigate|visit|click|scroll|type)\b/i;
const AVAILABLE_TOOL_FALLBACK_REQUEST_PATTERN =
  /(?:\b(?:check(?: out)?|look(?: up)?|find|get|inspect|pull|verify|show(?: me)?|what(?:'s| is| are))\b[\s\S]{0,160}\b(?:stats?|analytics?|metrics?|insights?|status|latest|current|recent|post|page|dashboard|profile|account|site|app|repo|issues?|email|inbox|doc|file)\b)|(?:\b(?:stats?|analytics?|metrics?|insights?|status|latest|current|recent|post|page|dashboard|profile|account|site|app|repo|issues?|email|inbox|doc|file)\b[\s\S]{0,160}\b(?:check(?: out)?|look(?: up)?|find|get|inspect|pull|verify|show)\b)/i;
const STALE_BROWSER_REFUSAL_PATTERN =
  /(?:browser(?:-control)?(?: capability)? (?:isn't|is not|wasn't|not) exposed|can't directly (?:operate|control) the browser|can't actually click or navigate|couldn't actually drive the browser|nothing on your tab was changed)/i;
const REPORT_STYLE_REQUEST_PATTERN =
  /\b(?:report|brief|memo|write-?up|digest|recap|meeting notes|notes doc|document)\b/i;

type BootstrapStageTimingMap = Record<string, number>;

type RuntimeExecContext = Record<string, unknown>;

export interface TsRunnerBootstrapState {
  harness: string;
  workspaceRoot: string;
  workspaceDir: string;
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

function evolveCandidateContext(
  request: TsRunnerRequest,
): AgentEvolveCandidateContext | null {
  if (!isRecord(request.context.evolve_candidate)) {
    return null;
  }
  const candidate = request.context.evolve_candidate;
  const candidateId = firstNonEmptyString(candidate.candidate_id);
  const kind = firstNonEmptyString(candidate.kind);
  const title = firstNonEmptyString(candidate.title);
  const summary = firstNonEmptyString(candidate.summary);
  const slug = firstNonEmptyString(candidate.slug);
  const skillPath = firstNonEmptyString(candidate.skill_path);
  const targetSkillPath = firstNonEmptyString(candidate.target_skill_path);
  const skillMarkdown = firstNonEmptyString(candidate.skill_markdown);
  const taskProposalId = firstNonEmptyString(candidate.task_proposal_id);
  if (!candidateId || !kind || !title || !skillPath) {
    return null;
  }
  return {
    candidate_id: candidateId,
    kind,
    title,
    summary: summary ?? null,
    slug: slug ?? null,
    skill_path: skillPath,
    target_skill_path: targetSkillPath ?? null,
    skill_markdown: skillMarkdown ?? null,
    task_proposal_id: taskProposalId ?? null,
  };
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

async function loadSessionScratchpadContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  logger?: LoggerLike;
}): Promise<AgentScratchpadContext | null> {
  try {
    const scratchpad = await readSessionScratchpad({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      includeContent: false,
    });
    if (!scratchpad.exists) {
      return null;
    }
    return {
      exists: true,
      file_path: scratchpad.file_path,
      updated_at: scratchpad.updated_at,
      size_bytes: scratchpad.size_bytes,
      preview: scratchpad.preview,
    };
  } catch (error) {
    params.logger?.warn?.(`Failed to load session scratchpad context: ${errorMessage(error)}`);
    return null;
  }
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

function hasActiveUserBrowserSurface(
  context: AgentOperatorSurfaceContext | null | undefined,
): boolean {
  for (const surface of context?.surfaces ?? []) {
    if (surface.surface_type !== "browser") {
      continue;
    }
    if (surface.owner !== "user") {
      continue;
    }
    if (surface.active === false) {
      continue;
    }
    const mutability = surface.mutability ?? null;
    if (mutability === "takeover_allowed" || mutability === "agent_owned") {
      return true;
    }
  }
  return false;
}

function loadRecentRuntimeContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  sessionKind: string | null | undefined;
  instruction: string;
  runtimeToolIds: string[];
  browserToolIds: string[];
  operatorSurfaceContext?: AgentOperatorSurfaceContext | null;
  logger?: LoggerLike;
}): AgentRecentRuntimeContext | null {
  if (!isFrontSessionKind(params.sessionKind)) {
    return null;
  }
  if (!params.runtimeToolIds.includes("delegate_task")) {
    return null;
  }

  const instruction = params.instruction.trim();
  const reportLike = REPORT_STYLE_REQUEST_PATTERN.test(instruction);
  const retryLike = BROWSER_RETRY_REQUEST_PATTERN.test(instruction);
  const browserIntentLike = BROWSER_ACTION_REQUEST_PATTERN.test(instruction);
  const availableToolFallbackLike =
    AVAILABLE_TOOL_FALLBACK_REQUEST_PATTERN.test(instruction);
  const browserRecoveryEligible =
    params.browserToolIds.length === 0 &&
    hasActiveUserBrowserSurface(params.operatorSurfaceContext);
  if (reportLike) {
    return {
      lines: [
        "The user is asking for a report-style deliverable. Keep chat as the coordination surface, not the deliverable surface.",
        "Do not paste a long report, memo, brief, recap, or document body into the conversation.",
        "Use `delegate_task` to produce the report artifact, then keep the main-session reply to a brief acknowledgement or short handoff.",
        "Only provide the full content inline if the user explicitly asks for it in chat and it will remain short.",
      ],
    };
  }
  if (availableToolFallbackLike) {
    const lines = [
      "The user is asking for a concrete check or lookup where the first-choice tool might be missing.",
      "Do not stop at a missing MCP/API/native tool. Try the best available route before saying it cannot be done.",
      "Choose the route that can actually satisfy the request: direct tool first, then delegated browser, web, terminal, or file inspection as appropriate.",
      "Only ask the user for access/context or state a limitation after viable direct and delegated routes are unavailable, blocked, or genuinely need human input.",
    ];
    if (!browserRecoveryEligible) {
      lines.push(
        "If no usable route is visible from the current context, ask one concise question for the missing access/context instead of giving a generic capability refusal.",
      );
    }
    return { lines };
  }

  if (!browserRecoveryEligible) {
    return null;
  }
  const sandboxRoot = path.dirname(params.workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  let staleBrowserRefusal = false;

  if (fs.existsSync(dbPath)) {
    const store = new RuntimeStateStore({
      workspaceRoot: params.workspaceRoot,
      sandboxRoot,
      dbPath,
    });
    try {
      const recentAssistantMessages = store.listSessionMessages({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        role: "assistant",
        order: "desc",
        limit: 6,
        offset: 0,
      });
      staleBrowserRefusal = recentAssistantMessages.some((message) =>
        STALE_BROWSER_REFUSAL_PATTERN.test(message.text),
      );
    } catch (error) {
      params.logger?.warn?.(
        `Failed to load recent runtime context workspace_id=${params.workspaceId} session_id=${params.sessionId}: ${errorMessage(error)}`,
      );
    } finally {
      store.close();
    }
  }

  if (!(browserIntentLike || (retryLike && staleBrowserRefusal))) {
    return null;
  }

  const lines = [
    "This main-session run does not currently have direct browser tools. Do not repeat a browser-control limitation as if it were the final answer.",
    "If the user's request is to operate the current browser/tab/page and direct browser tools are unavailable here, route it through `delegate_task` instead of answering with a manual browser workaround.",
    "Only surface a browser limitation if delegated subagents also cannot perform the requested browser action.",
  ];
  if (staleBrowserRefusal) {
    lines.unshift(
      "Recent turns in this session contain stale browser-capability refusals. Treat them as prior-run history, not as the answer for this run.",
    );
  }
  if (retryLike) {
    lines.unshift(
      "The user is explicitly retrying the browser request. Do not simply restate the earlier limitation.",
    );
  }
  return { lines };
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

function isFrontSessionKind(value: string | null | undefined): boolean {
  const normalized = normalizedSessionKindValue(value);
  return normalized === "main_session" || normalized === "onboarding";
}

function normalizedOnboardingStateValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requestOnboardingState(
  request: Pick<TsRunnerRequest, "context">,
): string | null {
  const state = normalizedOnboardingStateValue(request.context.onboarding_state);
  return state || null;
}

function workspaceOnboardingDelegationAllowed(params: {
  sessionKind: string | null | undefined;
  onboardingState?: string | null;
}): boolean {
  return (
    normalizedSessionKindValue(params.sessionKind) === "workspace_onboarding" &&
    normalizedOnboardingStateValue(params.onboardingState) ===
      WORKSPACE_ONBOARDING_IMPLEMENTING_STATE
  );
}

function isDelegatingFrontSessionKind(params: {
  sessionKind: string | null | undefined;
  onboardingState?: string | null;
}): boolean {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  return normalized === "main_session" || workspaceOnboardingDelegationAllowed(params);
}

function normalizedTeammateIdValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hrOnlyRuntimeToolsAllowed(params: {
  sessionKind: string | null | undefined;
  teammateId?: string | null;
}): boolean {
  return (
    normalizedSessionKindValue(params.sessionKind) === "subagent" &&
    normalizedTeammateIdValue(params.teammateId) === "hr"
  );
}

function appBuilderOnlyRuntimeToolsAllowed(params: {
  sessionKind: string | null | undefined;
  teammateId?: string | null;
}): boolean {
  return (
    normalizedSessionKindValue(params.sessionKind) === "subagent" &&
    normalizedTeammateIdValue(params.teammateId) === "app_builder"
  );
}

function defaultToolsForSessionKind(
  sessionKind: string | null | undefined,
): string[] {
  return normalizedSessionKindValue(sessionKind) === "onboarding"
    ? [...ONBOARDING_DEFAULT_TOOLS]
    : [...MAIN_SESSION_DEFAULT_TOOLS];
}

function projectBrowserToolIdsForSession(params: {
  sessionKind: string | null | undefined;
  browserToolIds: string[];
}): string[] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  if (normalized === "subagent") {
    return [...params.browserToolIds];
  }
  return [];
}

function projectRuntimeToolIdsForSession(params: {
  sessionKind: string | null | undefined;
  onboardingState?: string | null;
  runtimeToolIds: string[];
  teammateId?: string | null;
}): string[] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  const allowHrOnly = hrOnlyRuntimeToolsAllowed(params);
  const allowAppBuilderOnly = appBuilderOnlyRuntimeToolsAllowed(params);
  if (isFrontSessionKind(normalized)) {
    const allowed =
      normalized === "onboarding"
        ? ONBOARDING_SESSION_RUNTIME_TOOL_IDS
        : MAIN_SESSION_RUNTIME_TOOL_IDS;
    return params.runtimeToolIds.filter(
      (toolId) =>
        allowed.has(toolId) &&
        !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId),
    );
  }
  if (normalized === "subagent") {
    return params.runtimeToolIds.filter(
      (toolId) =>
        !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
        !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        (!APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) ||
          allowAppBuilderOnly) &&
        (!SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId) ||
          (allowHrOnly && HR_ONLY_RUNTIME_TOOL_IDS.has(toolId))),
    );
  }
  if (normalized === "workspace_onboarding") {
    const allowImplementationTools = workspaceOnboardingDelegationAllowed(params);
    return params.runtimeToolIds.filter(
      (toolId) =>
        !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        (!WORKSPACE_ONBOARDING_IMPLEMENTATION_ONLY_RUNTIME_TOOL_IDS.has(
          toolId,
        ) ||
          allowImplementationTools),
    );
  }
  return params.runtimeToolIds.filter(
    (toolId) =>
      !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
      !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
      !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
      !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId),
  );
}

function projectExtraToolIdsForSession(params: {
  harnessId: string | null | undefined;
  sessionKind: string | null | undefined;
  onboardingState?: string | null;
  extraToolIds: string[];
  teammateId?: string | null;
}): string[] {
  const normalized = normalizedSessionKindValue(params.sessionKind);
  const allowHrOnly = hrOnlyRuntimeToolsAllowed(params);
  const allowAppBuilderOnly = appBuilderOnlyRuntimeToolsAllowed(params);
  if (isFrontSessionKind(normalized)) {
    const allowed =
      normalized === "onboarding"
        ? ONBOARDING_SESSION_RUNTIME_TOOL_IDS
        : MAIN_SESSION_RUNTIME_TOOL_IDS;
    return params.extraToolIds.filter(
      (toolId) =>
        allowed.has(toolId) &&
        !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
        !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId),
    );
  }
  if (normalized === "subagent") {
    return Array.from(
      new Set([
        ...defaultExtraTools(params.harnessId),
        ...params.extraToolIds.filter(
          (toolId) =>
            !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
            !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
            (!APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) ||
              allowAppBuilderOnly) &&
            (!SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS.has(toolId) ||
              (allowHrOnly && HR_ONLY_RUNTIME_TOOL_IDS.has(toolId))),
        ),
      ]),
    );
  }
  if (normalized === "workspace_onboarding") {
    const allowImplementationTools = workspaceOnboardingDelegationAllowed(params);
    return Array.from(
      new Set([
        ...defaultExtraTools(params.harnessId),
        ...params.extraToolIds.filter(
          (toolId) =>
            !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
            !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
            !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
            (!WORKSPACE_ONBOARDING_IMPLEMENTATION_ONLY_RUNTIME_TOOL_IDS.has(
              toolId,
            ) ||
              allowImplementationTools),
        ),
      ]),
    );
  }
  return Array.from(
    new Set([
      ...defaultExtraTools(params.harnessId),
      ...params.extraToolIds.filter(
        (toolId) =>
          !SUBAGENT_ORCHESTRATION_RUNTIME_TOOL_IDS.has(toolId) &&
          !MAIN_SESSION_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
          !APP_BUILDER_ONLY_RUNTIME_TOOL_IDS.has(toolId) &&
          !HR_ONLY_RUNTIME_TOOL_IDS.has(toolId),
      ),
    ]),
  );
}

function projectResolvedMcpToolRefsForSession(params: {
  sessionKind: string | null | undefined;
  resolvedMcpToolRefs: CompiledWorkspaceRuntimePlan["resolved_mcp_tool_refs"];
}): CompiledWorkspaceRuntimePlan["resolved_mcp_tool_refs"] {
  if (isFrontSessionKind(params.sessionKind)) {
    return [];
  }
  return params.resolvedMcpToolRefs;
}

function projectResolvedMcpServerIdsForSession(params: {
  sessionKind: string | null | undefined;
  resolvedMcpServerIds: string[];
}): string[] {
  if (isFrontSessionKind(params.sessionKind)) {
    return [];
  }
  return params.resolvedMcpServerIds;
}

function explicitHolabossUserId(request: TsRunnerRequest): string | undefined {
  return (
    firstNonEmptyString(
      request.holaboss_user_id,
      request.context.holaboss_user_id,
    ) ?? undefined
  );
}

function teammateSkillContextId(
  request: TsRunnerRequest,
  options: { logger?: LoggerLike } = {},
): string | undefined {
  const workspaceRoot = managedWorkspaceRoot();
  const sandboxRoot = path.dirname(workspaceRoot);
  const dbPath = defaultHostStateDbPathForSandbox(sandboxRoot);
  if (!fs.existsSync(dbPath)) {
    return firstNonEmptyString(request.context.teammate_id) ?? undefined;
  }

  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
    dbPath,
  });
  try {
    const issueId = firstNonEmptyString(request.context.issue_id) ?? null;
    const issue =
      (issueId
        ? store.getIssue({
            workspaceId: request.workspace_id,
            issueId,
          })
        : null) ??
      store.getIssueBySessionId({
        workspaceId: request.workspace_id,
        sessionId: request.session_id,
      });
    const subagentRun =
      !issue
        ? store.getSubagentRunByChildSession({
            workspaceId: request.workspace_id,
            childSessionId: request.session_id,
          })
        : null;
    return (
      firstNonEmptyString(
        issue?.assigneeTeammateId,
        subagentRun?.teammateId,
        request.context.teammate_id,
      ) ?? undefined
    );
  } catch (error) {
    options.logger?.warn?.(
      `Failed to resolve teammate skill context workspace_id=${request.workspace_id} session_id=${request.session_id}: ${errorMessage(error)}`,
    );
    return firstNonEmptyString(request.context.teammate_id) ?? undefined;
  } finally {
    store.close();
  }
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

function loadTeammateRoutingContext(params: {
  workspaceRoot: string;
  workspaceId: string;
  logger?: LoggerLike;
}): AgentTeammateRoutingContext | null {
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
    const workspaceDir = store.workspaceDir(params.workspaceId);
    const teammates = store
      .listTeammates({ workspaceId: params.workspaceId })
      .filter((teammate) => teammate.status === "active")
      .map((teammate) =>
        buildTeammateRoutingRosterEntry(teammate, { workspaceDir }),
      );
    if (teammates.length === 0) {
      return null;
    }
    return { teammates };
  } catch (error) {
    params.logger?.warn?.(
      `Failed to load teammate routing context workspace_id=${params.workspaceId}: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    store.close();
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
  recalledMemoryContext?: AgentRecalledMemoryContext | null;
  currentUserContext?: AgentCurrentUserContext | null;
  operatorSurfaceContext?: AgentOperatorSurfaceContext | null;
  pendingUserMemoryContext?: AgentPendingUserMemoryContext | null;
  teammateRoutingContext?: AgentTeammateRoutingContext | null;
  recentRuntimeContext?: AgentRecentRuntimeContext | null;
  sessionAttachmentContext?: AgentSessionAttachmentContext | null;
  sessionScratchpadContext?: AgentScratchpadContext | null;
  evolveCandidateContext?: AgentEvolveCandidateContext | null;
}): AgentRuntimeConfigCliRequest {
  const normalizedSessionKind = normalizedSessionKindValue(
    params.request.session_kind,
  );
  const onboardingState = requestOnboardingState(params.request);
  const frontSession = isFrontSessionKind(normalizedSessionKind);
  const delegatedCapabilitySnapshotEligible =
    isDelegatingFrontSessionKind({
      sessionKind: normalizedSessionKind,
      onboardingState,
    });
  const teammateId = teammateSkillContextId(params.request) ?? null;
  const extraTools = projectExtraToolIdsForSession({
    harnessId: params.harnessId,
    sessionKind: normalizedSessionKind,
    onboardingState,
    extraToolIds: params.extraToolIds,
    teammateId,
  });
  const runtimeToolIds = projectRuntimeToolIdsForSession({
    sessionKind: normalizedSessionKind,
    onboardingState,
    runtimeToolIds: params.runtimeToolIds,
    teammateId,
  });
  const browserToolIds = projectBrowserToolIdsForSession({
    sessionKind: normalizedSessionKind,
    browserToolIds: params.browserToolIds,
  });
  const resolvedMcpToolRefs = projectResolvedMcpToolRefsForSession({
    sessionKind: normalizedSessionKind,
    resolvedMcpToolRefs: params.resolvedMcpToolRefs,
  });
  const delegatedExtraTools = delegatedCapabilitySnapshotEligible
    ? projectExtraToolIdsForSession({
        harnessId: params.harnessId,
        sessionKind: "subagent",
        extraToolIds: params.delegatedExtraToolIds ?? params.extraToolIds,
        teammateId: null,
      })
    : null;
  const delegatedRuntimeToolIds = delegatedCapabilitySnapshotEligible
    ? projectRuntimeToolIdsForSession({
        sessionKind: "subagent",
        runtimeToolIds: params.runtimeToolIds,
        teammateId: null,
      })
    : null;
  const delegatedBrowserToolIds = delegatedCapabilitySnapshotEligible
    ? projectBrowserToolIdsForSession({
        sessionKind: "subagent",
        browserToolIds: params.delegatedBrowserToolIds ?? params.browserToolIds,
      })
    : null;
  const delegatedResolvedMcpToolRefs = delegatedCapabilitySnapshotEligible
    ? projectResolvedMcpToolRefsForSession({
        sessionKind: "subagent",
        resolvedMcpToolRefs: params.resolvedMcpToolRefs,
      })
    : null;
  const resolvedMcpServerIds = projectResolvedMcpServerIdsForSession({
    sessionKind: normalizedSessionKind,
    resolvedMcpServerIds: params.resolvedMcpServerIds,
  });
  const common = {
    session_id: params.request.session_id,
    workspace_id: params.request.workspace_id,
    input_id: params.request.input_id,
    session_kind: params.request.session_kind ?? null,
    onboarding_state: onboardingState ?? undefined,
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
    recalled_memory_context: params.recalledMemoryContext ?? undefined,
    current_user_context: params.currentUserContext ?? undefined,
    operator_surface_context: params.operatorSurfaceContext ?? undefined,
    pending_user_memory_context: params.pendingUserMemoryContext ?? undefined,
    teammate_routing_context: params.teammateRoutingContext ?? undefined,
    recent_runtime_context: params.recentRuntimeContext ?? undefined,
    session_attachment_context: params.sessionAttachmentContext ?? undefined,
    evolve_candidate_context: params.evolveCandidateContext ?? undefined,
    selected_model: firstNonEmptyString(params.request.model) ?? undefined,
    default_provider_id: defaultProviderId(),
    session_mode: defaultSessionMode(),
    workspace_config_checksum: params.compiledPlan.config_checksum,
    workspace_skill_ids: [...params.workspaceSkillIds],
    workspace_skill_descriptions: { ...params.workspaceSkillDescriptions },
    workspace_command_ids: [...params.workspaceCommandIds],
    default_tools: frontSession
      ? defaultToolsForSessionKind(normalizedSessionKind)
      : [...SUBAGENT_DEFAULT_TOOLS],
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
    ...(frontSession
      ? {}
      : {
          session_scratchpad_context:
            params.sessionScratchpadContext ?? undefined,
        }),
    tool_server_id_map: { ...params.toolServerIdMap },
    resolved_mcp_tool_refs: resolvedMcpToolRefs.map((toolRef) => ({
      tool_id: toolRef.tool_id,
      server_id: toolRef.server_id,
      tool_name: toolRef.tool_name,
    })),
    resolved_mcp_server_ids: [...resolvedMcpServerIds],
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
  return {
    ...common,
    agent: {
      id: params.compiledPlan.general_config.agent.id,
      model: params.compiledPlan.general_config.agent.model,
      prompt: params.compiledPlan.general_config.agent.prompt,
      role: params.compiledPlan.general_config.agent.role,
    },
  };
}

function requestUsesUserBrowserSurface(
  request: Pick<TsRunnerRequest, "session_kind" | "context">,
): boolean {
  return request.context.use_user_browser_surface === true;
}

function browserSpaceFromOperatorSurfaceContext(
  context: AgentOperatorSurfaceContext | null | undefined,
  request: Pick<TsRunnerRequest, "session_kind" | "context">,
): "agent" | "user" | null {
  const allowUserSurface = requestUsesUserBrowserSurface(request);
  const activeSurfaceId =
    typeof context?.active_surface_id === "string"
      ? context.active_surface_id.trim()
      : "";
  if (activeSurfaceId === "browser:user") {
    return allowUserSurface ? "user" : "agent";
  }
  if (activeSurfaceId === "browser:agent") {
    return "agent";
  }
  const activeBrowserSurface =
    context?.surfaces?.find(
      (surface) => surface.active === true && surface.surface_type === "browser",
    ) ?? null;
  if (!activeBrowserSurface) {
    return null;
  }
  if (activeBrowserSurface.owner === "user") {
    return allowUserSurface ? "user" : "agent";
  }
  return "agent";
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
      sawEvent = true;
      lastSequence = Math.max(lastSequence, event.sequence);
      await params.emitEvent(event);
      if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
        terminalEmitted = true;
      }
    }
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  const normalizedStderr = [stderr.trim(), stdinError]
    .filter((value) => value.length > 0)
    .join("\n");

  return {
    exitCode,
    stderr: normalizedStderr,
    sawEvent,
    terminalEmitted,
    lastSequence,
  };
}

function defaultExecutionDeps(): TsRunnerExecutionDeps {
  return {
    bootstrapApplications: defaultBootstrapApplications,
    compilePlan: ({ workspaceId, workspaceDir }) =>
      compileWorkspaceRuntimePlanFromWorkspace({
        workspaceId,
        workspaceDir,
      }),
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
  requireRuntimeHarnessAdapter(harness);
  const workspaceRoot = managedWorkspaceRoot();
  const workspaceDir = resolveRegisteredWorkspaceDir(request.workspace_id, {
    logger,
  });
  const persistedHarnessSessionId = requestedHarnessSessionId
    ? null
    : readWorkspaceHarnessSessionId({
        workspaceDir,
        harness,
        logger,
      });

  return {
    harness,
    workspaceRoot,
    workspaceDir,
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
        onboardingState: requestOnboardingState(request),
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
    const workspaceSkills = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "resolve_workspace_skills",
      () => {
        const teammateId = teammateSkillContextId(request, { logger }) ?? null;
        return projectSessionVisibleWorkspaceSkills({
          workspaceSkills: resolveWorkspaceSkills(bootstrap.workspaceDir, {
            teammateId,
          }),
          teammateId,
        });
      },
    );
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

    const directResolvedMcpToolRefs = projectResolvedMcpToolRefsForSession({
      sessionKind: request.session_kind,
      resolvedMcpToolRefs,
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
      }),
    );
    const directMcpServers = effectiveMcpServers.filter((server) =>
      directMcpServerIds.has(server.name),
    );

    const sessionScratchpadContext = isFrontSessionKind(request.session_kind)
      ? null
      : await measureBootstrapStageAsync(
          bootstrapStageTimingsMs,
          "load_session_scratchpad_context",
          async () =>
            await loadSessionScratchpadContext({
              workspaceRoot: bootstrap.workspaceRoot,
              workspaceId: request.workspace_id,
              sessionId: request.session_id,
              logger,
            }),
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
    const recentRuntimeContext = measureBootstrapStage(
      bootstrapStageTimingsMs,
      "load_recent_runtime_context",
      () =>
        loadRecentRuntimeContext({
          workspaceRoot: bootstrap.workspaceRoot,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          sessionKind: request.session_kind,
          instruction: request.instruction,
          runtimeToolIds: [...stagedRuntimeTools.toolIds],
          browserToolIds: [...stagedBrowserTools.toolIds],
          operatorSurfaceContext,
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
            recalledMemoryContext,
            currentUserContext,
            operatorSurfaceContext,
            pendingUserMemoryContext,
            teammateRoutingContext: isDelegatingFrontSessionKind({
              sessionKind: request.session_kind,
              onboardingState: requestOnboardingState(request),
            })
              ? loadTeammateRoutingContext({
                  workspaceRoot: bootstrap.workspaceRoot,
                  workspaceId: request.workspace_id,
                  logger,
                })
              : null,
            recentRuntimeContext,
            sessionAttachmentContext,
            sessionScratchpadContext,
            evolveCandidateContext: evolveCandidateContext(request),
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
        browserSpace: browserSpaceFromOperatorSurfaceContext(
          operatorSurfaceContext,
          request,
        ),
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
      browserSpace: browserSpaceFromOperatorSurfaceContext(
        operatorSurfaceContext,
        request,
      ),
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
      timeoutSeconds: harnessPlugin.timeoutSeconds({ request }),
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
              persistHarnessSessionState,
              logger,
            });
          },
        }),
    );

    if (harnessResult.terminalEmitted) {
      return;
    }

    await relayTsRunnerEvent({
      emitEvent: options.emitEvent,
      harness: bootstrap.harness,
      workspaceDir: bootstrap.workspaceDir,
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
  const logger = options.logger ?? console;
  const requestBase64 =
    argv[0] === "--request-base64" ? (argv[1] ?? "") : (argv[0] ?? "");

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
