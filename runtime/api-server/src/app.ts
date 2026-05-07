import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import yaml from "js-yaml";
import * as tar from "tar";
import yauzl from "yauzl";
import * as Sentry from "@sentry/node";

import {
  type AgentSessionRecord,
  type AppBuildRecord,
  type AppCatalogEntryRecord,
  type CronjobRecord,
  type MemoryUpdateProposalRecord,
  type OutputFolderRecord,
  type OutputRecord,
  type RuntimeNotificationRecord,
  type SessionMessageRecord,
  type SessionRuntimeStateRecord,
  type TaskProposalRecord,
  type OutputEventRecord,
  type TerminalSessionStatus,
  type TurnRequestSnapshotRecord,
  type TurnResultRecord,
  type RuntimeUserProfileRecord,
  RuntimeStateStore,
  utcNowIso,
  type WorkspaceRecord
} from "@holaboss/runtime-state-store";

import {
  type QueueWorkerLike,
  RuntimeQueueWorker,
  runtimeQueueWorkerClaimedBy,
} from "./queue-worker.js";
import {
  type DurableMemoryWorkerLike,
  RuntimeEvolveWorker,
} from "./evolve-worker.js";
import { processEvolveJob } from "./evolve.js";
import {
  processSessionCheckpointJob,
  SESSION_CHECKPOINT_JOB_TYPE,
} from "./session-checkpoint.js";
import {
  type CronWorkerLike,
  executeLocalCronjobDelivery,
  RuntimeCronWorker,
  cronjobNextRunAt
} from "./cron-worker.js";
import {
  type MainSessionEventWorkerLike,
  RuntimeMainSessionEventWorker,
} from "./main-session-event-worker.js";
import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";
import {
  type BridgeWorkerLike,
  RuntimeRemoteBridgeWorker,
  tsBridgeWorkerEnabled
} from "./bridge-worker.js";
import {
  type RecallEmbeddingBackfillWorkerLike,
  RuntimeRecallEmbeddingBackfillWorker,
} from "./recall-embedding-backfill-worker.js";
import { captureRuntimeException } from "./runtime-sentry.js";
import {
  AppLifecycleExecutorError,
  appBuildHasCompletedSetup,
  isAppHealthy,
  killPortListeners,
  type AppLifecycleExecutorLike,
  RuntimeAppLifecycleExecutor
} from "./app-lifecycle-worker.js";
import {
  FilesystemMemoryService,
  MemoryServiceError,
  type MemoryServiceLike
} from "./memory.js";
import {
  migrateLegacyWorkspaceStatePath,
  resolveMemoryFilePath,
} from "./workspace-bundle-paths.js";
import {
  FileRuntimeConfigService,
  RuntimeConfigServiceError,
  type RuntimeConfigServiceLike
} from "./runtime-config.js";
import {
  DesktopBrowserToolService,
  DesktopBrowserToolServiceError,
  type DesktopBrowserToolServiceLike
} from "./desktop-browser-tools.js";
import {
  IntegrationServiceError,
  RuntimeIntegrationService
} from "./integrations.js";
import { BrokerError, IntegrationBrokerService } from "./integration-broker.js";
import { OAuthService } from "./oauth-service.js";
import { ComposioService } from "./composio-service.js";
import {
  type RuntimeAgentToolsCreateDataTableParams,
  type RuntimeAgentToolsCreateDashboardParams,
  RuntimeAgentToolsService,
  RuntimeAgentToolsServiceError,
} from "./runtime-agent-tools.js";
import { resolveSubagentExecutionModel } from "./subagent-model.js";
import {
  capabilityToolResultModeFromHeaders,
  shapeCapabilityToolResultPayload,
} from "./tool-result-preview.js";
import {
  TerminalSessionManager,
  TerminalSessionManagerError,
  type TerminalSessionManagerLike,
} from "./terminal-session-manager.js";
import {
  appendWorkspaceApplication,
  listWorkspaceComposeShutdownTargets,
  listWorkspaceApplicationPorts,
  listWorkspaceApplications,
  parseInstalledAppRuntime,
  portsForAppIndex,
  releaseWorkspaceAppPorts,
  removeWorkspaceApplication,
  removeWorkspaceMcpRegistryEntry,
  resolveWorkspaceApp,
  resolveWorkspaceAppRuntime,
  writeWorkspaceMcpRegistryEntry,
  type ParsedInstalledApp
} from "./workspace-apps.js";
import {
  NativeRunnerExecutor,
  RunnerExecutorError,
  type RunnerExecutorLike,
} from "./runner-worker.js";
import { killChildProcess, spawnShellCommand } from "./runtime-shell.js";
import { startResolvedApplications } from "./resolved-app-bootstrap.js";
import { buildAppSetupEnv } from "./app-setup-env.js";
import { collectWorkspaceSnapshot } from "./workspace-snapshot.js";
import {
  buildMemoryUpdateProposalsFromUserInput,
  durableMemoryCandidateFromAcceptedProposal,
  runtimeUserProfileUpdateFromAcceptedProposal,
} from "./user-memory-proposals.js";
import {
  persistDurableMemoryCandidate,
  refreshMemoryIndexes,
} from "./turn-memory-writeback.js";
import { promotedWorkspaceSkillPath } from "./evolve-skill-review.js";
import { captureWorkspaceContext } from "./proactive-context.js";

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_APP_SETUP_TIMEOUT_MS = 900_000;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 36;
const TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed"]);
const DEFAULT_EXCLUDED_SESSION_OUTPUT_EVENT_TYPES = ["pi_native_event"];
export interface BuildRuntimeApiServerOptions {
  logger?: boolean;
  store?: RuntimeStateStore;
  dbPath?: string;
  workspaceRoot?: string;
  queueWorker?: QueueWorkerLike | null;
  mainSessionEventWorker?: MainSessionEventWorkerLike | null;
  durableMemoryWorker?: DurableMemoryWorkerLike | null;
  cronWorker?: CronWorkerLike | null;
  bridgeWorker?: BridgeWorkerLike | null;
  recallEmbeddingBackfillWorker?: RecallEmbeddingBackfillWorkerLike | null;
  appLifecycleExecutor?: AppLifecycleExecutorLike;
  memoryService?: MemoryServiceLike;
  runtimeConfigService?: RuntimeConfigServiceLike;
  browserToolService?: DesktopBrowserToolServiceLike;
  terminalSessionManager?: TerminalSessionManagerLike | null;
  runnerExecutor?: RunnerExecutorLike;
  enableAppHealthMonitor?: boolean;
  startAppsOnReady?: boolean;
}

function resolveQueueWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  memoryService: MemoryServiceLike,
  durableMemoryWorker: DurableMemoryWorkerLike | null
): QueueWorkerLike | null {
  if (options.queueWorker !== undefined) {
    return options.queueWorker;
  }
  return new RuntimeQueueWorker({
    store,
    logger: app.log,
    memoryService,
    wakeDurableMemoryWorker: durableMemoryWorker?.wake.bind(durableMemoryWorker) ?? null,
    claimedBy: runtimeQueueWorkerClaimedBy(),
  });
}

function resolveDurableMemoryWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  memoryService: MemoryServiceLike
): DurableMemoryWorkerLike | null {
  if (options.durableMemoryWorker !== undefined) {
    return options.durableMemoryWorker;
  }
  return new RuntimeEvolveWorker({
    store,
    logger: app.log,
    memoryService,
    executeClaimedJob: async (record) => {
      if (record.jobType === SESSION_CHECKPOINT_JOB_TYPE) {
        await processSessionCheckpointJob({
          store,
          record,
        });
        return;
      }
      await processEvolveJob({
        store,
        record,
        memoryService,
      });
    },
  });
}

function resolveCronWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  queueWorker: QueueWorkerLike | null
): CronWorkerLike | null {
  if (options.cronWorker !== undefined) {
    return options.cronWorker;
  }
  return new RuntimeCronWorker({ store, logger: app.log, queueWorker });
}

function resolveMainSessionEventWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  queueWorker: QueueWorkerLike | null
): MainSessionEventWorkerLike | null {
  if (options.mainSessionEventWorker !== undefined) {
    return options.mainSessionEventWorker;
  }
  return new RuntimeMainSessionEventWorker({
    store,
    logger: app.log,
    queueWorker,
  });
}

function resolveBridgeWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  memoryService: MemoryServiceLike
): BridgeWorkerLike | null {
  if (options.bridgeWorker !== undefined) {
    return options.bridgeWorker;
  }
  if (!tsBridgeWorkerEnabled()) {
    return null;
  }
  try {
    return new RuntimeRemoteBridgeWorker({ logger: app.log, store, memoryService });
  } catch (error) {
    app.log.warn(
      {
        event: "runtime.proactive_bridge.disabled",
        reason: error instanceof Error ? error.message : String(error)
      },
      "Remote proactive bridge disabled during startup"
    );
    return null;
  }
}

function resolveRecallEmbeddingBackfillWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  memoryService: MemoryServiceLike,
): RecallEmbeddingBackfillWorkerLike | null {
  if (options.recallEmbeddingBackfillWorker !== undefined) {
    return options.recallEmbeddingBackfillWorker;
  }
  return new RuntimeRecallEmbeddingBackfillWorker({
    store,
    logger: app.log,
    memoryService,
  });
}

type StringMap = Record<string, unknown>;

interface SessionInputAttachmentPayload {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

const SESSION_TITLE_MAX_LENGTH = 80;

function defaultWorkspaceRoot(): string | undefined {
  const sandboxRoot = (process.env.HB_SANDBOX_ROOT ?? "").trim();
  if (!sandboxRoot) {
    return undefined;
  }
  return `${sandboxRoot.replace(/\/+$/, "")}/workspace`;
}

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: StringMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

// When the runtime is bound to a specific user via HOLABOSS_USER_ID
// (managed/sandbox mode), reject mismatching owner_user_id values from
// request bodies so a caller can't write integrations under another user's
// identity. In OSS local mode (env unset) accept whatever the caller
// provides for backwards compatibility with single-user installs.
function resolveOwnerUserId(provided: unknown): { ok: true; userId: string } | { ok: false; error: string } {
  const expected = (process.env.HOLABOSS_USER_ID ?? "").trim() || null;
  const trimmed = typeof provided === "string" ? provided.trim() : "";
  if (expected) {
    if (!trimmed || trimmed === "local") {
      return { ok: true, userId: expected };
    }
    if (trimmed !== expected) {
      return { ok: false, error: "owner_user_id does not match this runtime's bound user" };
    }
    return { ok: true, userId: expected };
  }
  return { ok: true, userId: trimmed || "local" };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function normalizedSessionTitleSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function sessionTitleFromFirstUserInput(
  text: string,
  attachments: SessionInputAttachmentPayload[],
): string | null {
  if (text.trim()) {
    return normalizedSessionTitleSnippet(text);
  }
  if (attachments.length === 1) {
    return normalizedSessionTitleSnippet(attachments[0]?.name?.trim() || "Attachment");
  }
  if (attachments.length > 1) {
    const firstName = attachments[0]?.name?.trim() || "Attachment";
    return normalizedSessionTitleSnippet(`${firstName} +${attachments.length - 1} more`);
  }
  return null;
}

function optionalBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function optionalInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function appSetupTimeoutMs(): number {
  const rawValue = process.env.HB_APP_SETUP_TIMEOUT_MS ?? process.env.APP_SETUP_TIMEOUT_MS;
  if (typeof rawValue === "string" && rawValue.trim().length > 0) {
    const parsed = Number.parseInt(rawValue.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_APP_SETUP_TIMEOUT_MS;
}

function optionalDict(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function sessionMemoryPath(workspaceId: string, sessionId: string): string {
  const sanitizedSessionId =
    sessionId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session";
  return `workspace/${workspaceId}/runtime/session-memory/${sanitizedSessionId}.md`;
}

function sessionMemoryExcerpt(raw: string, maxChars = 320): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function loadSessionResumeContextForApi(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
}): { session_memory_path: string; session_memory_excerpt: string } | null {
  const relPath = sessionMemoryPath(params.workspaceId, params.sessionId);
  const targetPath = resolveMemoryFilePath({
    workspaceRoot: params.workspaceRoot,
    workspaceDir: path.join(params.workspaceRoot, params.workspaceId),
    workspaceId: params.workspaceId,
    relPath,
  });
  if (
    !fs.existsSync(targetPath) ||
    !fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile()
  ) {
    return null;
  }
  try {
    const text = fs.readFileSync(targetPath, "utf8");
    const excerpt = sessionMemoryExcerpt(text);
    if (!excerpt) {
      return null;
    }
    return {
      session_memory_path: relPath,
      session_memory_excerpt: excerpt,
    };
  } catch {
    return null;
  }
}

function requiredDict(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function capabilityWorkspaceId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  return (
    headerString(params.headers, "x-holaboss-workspace-id") ||
    optionalString(params.query?.workspace_id) ||
    optionalString(params.body?.workspace_id) ||
    ""
  );
}

function requiredCapabilityWorkspaceId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  const workspaceId = capabilityWorkspaceId(params);
  if (!workspaceId) {
    throw new Error("workspace_id is required");
  }
  return workspaceId;
}

function requireTerminalSession(params: {
  manager: TerminalSessionManagerLike | null | undefined;
  terminalId: string;
  workspaceId: string;
}) {
  if (!params.manager) {
    throw new Error("terminal session capability is not available");
  }
  const session = params.manager.getSession({
    terminalId: params.terminalId,
    workspaceId: params.workspaceId,
  });
  if (!session) {
    throw new TerminalSessionManagerError(404, "terminal_session_not_found", "terminal session not found");
  }
  return session;
}

function capabilitySessionId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  return (
    headerString(params.headers, "x-holaboss-session-id") ||
    optionalString(params.query?.session_id) ||
    optionalString(params.body?.session_id) ||
    ""
  );
}

function capabilityBrowserSpace(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): "agent" | "user" | null {
  const value =
    headerString(params.headers, "x-holaboss-browser-space") ||
    optionalString(params.query?.browser_space) ||
    optionalString(params.body?.browser_space) ||
    "";
  return value === "agent" || value === "user" ? value : null;
}

function capabilitySelectedModel(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  return (
    headerString(params.headers, "x-holaboss-selected-model") ||
    optionalString(params.query?.selected_model) ||
    optionalString(params.body?.selected_model) ||
    ""
  );
}

function capabilityInputId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  return (
    headerString(params.headers, "x-holaboss-input-id") ||
    optionalString(params.query?.input_id) ||
    optionalString(params.body?.input_id) ||
    ""
  );
}

function requiredCronjobDeliveryInput(value: unknown): {
  channel: string;
  mode?: string;
  to?: unknown;
} {
  const delivery = requiredDict(value, "delivery");
  return {
    channel: requiredString(delivery.channel, "delivery.channel"),
    mode: optionalString(delivery.mode),
    to: delivery.to
  };
}

function optionalCronjobDeliveryInput(value: unknown): {
  channel: string;
  mode?: string;
  to?: unknown;
} | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredCronjobDeliveryInput(value);
}

function parseDelegateTaskInput(value: unknown): {
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
  useUserBrowserSurface?: boolean | null;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const goal = nullableString(value.goal);
  if (!goal) {
    return null;
  }
  return {
    title: nullableString(value.title) ?? null,
    goal,
    context: nullableString(value.context) ?? null,
    tools: optionalStringList(value.tools),
    model: nullableString(value.model) ?? null,
    useUserBrowserSurface: value.use_user_browser_surface === true,
    timeoutMs:
      typeof value.timeout_ms === "number" && Number.isFinite(value.timeout_ms)
        ? Math.max(1, Math.trunc(value.timeout_ms))
        : null,
  };
}

function requiredDelegateTaskInputs(body: Record<string, unknown>): Array<{
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
  useUserBrowserSurface?: boolean | null;
}> {
  if (Array.isArray(body.tasks)) {
    const tasks = body.tasks
      .map((task) => parseDelegateTaskInput(task))
      .filter((task): task is NonNullable<typeof task> => task !== null);
    if (tasks.length > 0) {
      return tasks;
    }
  }
  const singleton = parseDelegateTaskInput(body);
  if (singleton) {
    return [singleton];
  }
  throw new Error("at least one delegated task goal is required");
}

function optionalStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function headerString(headers: Record<string, unknown>, key: string): string {
  const raw = headers[key];
  if (Array.isArray(raw)) {
    return typeof raw[0] === "string" ? raw[0].trim() : "";
  }
  return typeof raw === "string" ? raw.trim() : "";
}

function parseSessionInputAttachment(value: unknown): SessionInputAttachmentPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mimeType = typeof value.mime_type === "string" ? value.mime_type.trim() : "";
  const workspacePath = typeof value.workspace_path === "string" ? value.workspace_path.trim() : "";
  const sizeBytes = typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes) ? value.size_bytes : 0;
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
    workspace_path: workspacePath
  };
}

function requiredSessionInputAttachments(value: unknown, workspaceDir: string): SessionInputAttachmentPayload[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("attachments must be an array");
  }

  return value.map((item, index) => {
    const attachment = parseSessionInputAttachment(item);
    if (!attachment) {
      throw new Error(`attachments[${index}] is invalid`);
    }

    const fullPath = resolveWorkspaceFilePath(workspaceDir, attachment.workspace_path);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`attachment path not found: ${attachment.workspace_path}`);
    }

    const stat = fs.statSync(fullPath);
    if (attachment.kind === "folder") {
      if (!stat.isDirectory()) {
        throw new Error(`attachment folder not found: ${attachment.workspace_path}`);
      }
      return attachment;
    }

    if (!stat.isFile()) {
      throw new Error(`attachment file not found: ${attachment.workspace_path}`);
    }

    return attachment;
  });
}

function attachmentsFromInputPayload(value: unknown): SessionInputAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => parseSessionInputAttachment(item)).filter((item): item is SessionInputAttachmentPayload => Boolean(item));
}

function workspaceRecordPayload(
  workspace: WorkspaceRecord,
  workspacePath?: string | null,
  folderState?: "healthy" | "missing" | null
): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    harness: workspace.harness,
    error_message: workspace.errorMessage,
    onboarding_status: workspace.onboardingStatus,
    onboarding_session_id: workspace.onboardingSessionId,
    onboarding_completed_at: workspace.onboardingCompletedAt,
    onboarding_completion_summary: workspace.onboardingCompletionSummary,
    onboarding_requested_at: workspace.onboardingRequestedAt,
    onboarding_requested_by: workspace.onboardingRequestedBy,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    deleted_at_utc: workspace.deletedAtUtc,
    workspace_path: workspacePath ?? null,
    folder_state: folderState ?? null
  };
}

/**
 * Small per-request memoizer so LIST endpoints don't stat every workspace
 * folder repeatedly when multiple lookups hit the same id. Use:
 *   const memo = createWorkspaceFolderCache(store);
 *   memo.path(id); memo.state(id);
 */
function createWorkspaceFolderCache(store: RuntimeStateStore): {
  path: (id: string) => string | null;
  state: (id: string) => "healthy" | "missing" | null;
} {
  const paths = new Map<string, string | null>();
  const states = new Map<string, "healthy" | "missing" | null>();
  return {
    path: (id: string) => {
      if (paths.has(id)) {
        return paths.get(id) ?? null;
      }
      let value: string | null = null;
      try {
        value = store.workspaceDir(id);
      } catch {
        value = null;
      }
      paths.set(id, value);
      return value;
    },
    state: (id: string) => {
      if (states.has(id)) {
        return states.get(id) ?? null;
      }
      let value: "healthy" | "missing" | null = null;
      try {
        value = store.workspaceFolderState(id);
      } catch {
        value = null;
      }
      states.set(id, value);
      return value;
    }
  };
}

function resolveWorkspacePathForPayload(
  store: RuntimeStateStore,
  workspaceId: string
): string | null {
  try {
    return store.workspaceDir(workspaceId);
  } catch {
    return null;
  }
}

function resolveWorkspaceFolderStateForPayload(
  store: RuntimeStateStore,
  workspaceId: string
): "healthy" | "missing" | null {
  try {
    return store.workspaceFolderState(workspaceId);
  } catch {
    return null;
  }
}

function isPathWithinWorkspaceRoot(candidate: string, workspaceRoot: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(workspaceRoot);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

/**
 * Guards endpoints that are about to read or write the workspace folder.
 * Returns the workspace dir on success; sends a 409 and returns null if the
 * folder is missing. Callers: `if (!dir) return;` pattern.
 *
 * The structured 409 response lets the desktop surface "folder is missing —
 * relocate or delete" instead of raw ENOENT text from downstream fs calls.
 */
function requireHealthyWorkspaceFolder(
  store: RuntimeStateStore,
  workspaceId: string,
  reply: FastifyReply
): string | null {
  try {
    return store.assertWorkspaceFolderHealthy(workspaceId);
  } catch (error) {
    const err = error as Error & { code?: string; workspacePath?: string };
    if (err?.code === "workspace_folder_missing") {
      reply.code(409).send({
        detail: err.message,
        code: "workspace_folder_missing",
        workspace_path: err.workspacePath ?? null
      });
      return null;
    }
    reply.code(500).send({ detail: err instanceof Error ? err.message : "workspace folder check failed" });
    return null;
  }
}

function agentSessionPayload(
  record: AgentSessionRecord,
  runtimeStore?: Pick<RuntimeStateStore, "getSubagentRunByChildSession"> | null,
): Record<string, unknown> {
  const linkedSubagentRun = runtimeStore?.getSubagentRunByChildSession({
    workspaceId: record.workspaceId,
    childSessionId: record.sessionId,
  });
  const sourceType =
    linkedSubagentRun?.sourceType ??
    (record.kind === "task_proposal" || record.sourceProposalId ? "task_proposal" : null);
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    kind: record.kind,
    title: record.title,
    parent_session_id: record.parentSessionId,
    source_proposal_id: record.sourceProposalId,
    created_by: record.createdBy,
    source_type: sourceType,
    cronjob_id: linkedSubagentRun?.cronjobId ?? null,
    proposal_id: linkedSubagentRun?.proposalId ?? record.sourceProposalId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    archived_at: record.archivedAt
  };
}

function runtimeStatePayload(record: SessionRuntimeStateRecord): Record<string, unknown> {
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    status: record.status,
    current_input_id: record.currentInputId,
    current_worker_id: record.currentWorkerId,
    lease_until: record.leaseUntil,
    heartbeat_at: record.heartbeatAt,
    last_error: record.lastError,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function runtimeStateListItemPayload(params: {
  record: SessionRuntimeStateRecord;
  lastTurnResult?: TurnResultRecord | null;
  hasQueuedInputs?: boolean;
}): Record<string, unknown> {
  const hasQueuedInputs = params.hasQueuedInputs ?? false;
  return {
    ...runtimeStatePayload(params.record),
    ...effectiveSessionState(params.record, hasQueuedInputs),
    has_queued_inputs: hasQueuedInputs,
    last_turn_status: params.lastTurnResult?.status ?? null,
    last_turn_completed_at: params.lastTurnResult?.completedAt ?? null,
    last_turn_stop_reason: params.lastTurnResult?.stopReason ?? null,
  };
}

function sessionMessagePayload(record: SessionMessageRecord, metadata?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    created_at: record.createdAt,
    metadata: metadata ?? record.metadata
  };
}

function outputEventPayload(record: OutputEventRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    sequence: record.sequence,
    event_type: record.eventType,
    payload: record.payload,
    created_at: record.createdAt
  };
}

function turnResultPayload(record: TurnResultRecord): Record<string, unknown> {
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    status: record.status,
    stop_reason: record.stopReason,
    assistant_text: record.assistantText,
    tool_usage_summary: record.toolUsageSummary,
    permission_denials: record.permissionDenials,
    prompt_section_ids: record.promptSectionIds,
    capability_manifest_fingerprint: record.capabilityManifestFingerprint,
    request_snapshot_fingerprint: record.requestSnapshotFingerprint,
    prompt_cache_profile: record.promptCacheProfile,
    context_budget_decisions: record.contextBudgetDecisions,
    token_usage: record.tokenUsage,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function turnRequestSnapshotPayload(record: TurnRequestSnapshotRecord): Record<string, unknown> {
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    snapshot_kind: record.snapshotKind,
    fingerprint: record.fingerprint,
    payload: record.payload,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function runtimeUserProfilePayload(record: RuntimeUserProfileRecord | null, profileId = "default"): Record<string, unknown> {
  return {
    profile_id: record?.profileId ?? profileId,
    name: record?.name ?? null,
    name_source: record?.nameSource ?? null,
    created_at: record?.createdAt ?? null,
    updated_at: record?.updatedAt ?? null,
  };
}

function artifactTypeFromOutputRecord(record: OutputRecord): string {
  const metadataArtifactType =
    typeof record.metadata.artifact_type === "string" ? record.metadata.artifact_type.trim() : "";
  if (metadataArtifactType) {
    return metadataArtifactType;
  }
  if (record.outputType === "post") {
    return "draft";
  }
  if (record.outputType === "html") {
    return "html";
  }
  const category = typeof record.metadata.category === "string" ? record.metadata.category.trim() : "";
  if (category === "image") {
    return "image";
  }
  return "document";
}

function externalIdFromOutputRecord(record: OutputRecord): string {
  const metadataExternalId =
    typeof record.metadata.external_id === "string" ? record.metadata.external_id.trim() : "";
  if (metadataExternalId) {
    return metadataExternalId;
  }
  return record.moduleResourceId ?? record.filePath ?? record.artifactId ?? record.id;
}

function sessionArtifactPayload(record: OutputRecord): Record<string, unknown> {
  return {
    id: record.artifactId ?? record.id,
    output_id: record.id,
    session_id: record.sessionId,
    workspace_id: record.workspaceId,
    input_id: record.inputId,
    artifact_type: artifactTypeFromOutputRecord(record),
    external_id: externalIdFromOutputRecord(record),
    platform: record.platform,
    title: record.title || null,
    metadata: record.metadata,
    created_at: record.createdAt
  };
}

function outputFolderPayload(record: OutputFolderRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    name: record.name,
    position: record.position,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function outputPayload(record: OutputRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    output_type: record.outputType,
    title: record.title,
    status: record.status,
    module_id: record.moduleId,
    module_resource_id: record.moduleResourceId,
    file_path: record.filePath,
    html_content: record.htmlContent,
    session_id: record.sessionId,
    input_id: record.inputId,
    artifact_id: record.artifactId,
    folder_id: record.folderId,
    platform: record.platform,
    metadata: record.metadata,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function cronjobPayload(record: CronjobRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    initiated_by: record.initiatedBy,
    name: record.name,
    cron: record.cron,
    description: record.description,
    instruction: record.instruction,
    enabled: record.enabled,
    delivery: record.delivery,
    metadata: record.metadata,
    last_run_at: record.lastRunAt,
    next_run_at: record.nextRunAt,
    run_count: record.runCount,
    last_status: record.lastStatus,
    last_error: record.lastError,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function runtimeNotificationPayload(record: RuntimeNotificationRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    cronjob_id: record.cronjobId,
    source_type: record.sourceType,
    source_label: record.sourceLabel,
    title: record.title,
    message: record.message,
    level: record.level,
    priority: record.priority,
    state: record.state,
    metadata: record.metadata,
    read_at: record.readAt,
    dismissed_at: record.dismissedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function taskProposalPayload(record: TaskProposalRecord): Record<string, unknown> {
  return {
    proposal_id: record.proposalId,
    workspace_id: record.workspaceId,
    task_name: record.taskName,
    task_prompt: record.taskPrompt,
    task_generation_rationale: record.taskGenerationRationale,
    proposal_source: record.proposalSource,
    source_event_ids: record.sourceEventIds,
    created_at: record.createdAt,
    state: record.state,
    accepted_session_id: record.acceptedSessionId,
    accepted_input_id: record.acceptedInputId,
    accepted_at: record.acceptedAt
  };
}

function memoryUpdateProposalPayload(record: MemoryUpdateProposalRecord): Record<string, unknown> {
  return {
    proposal_id: record.proposalId,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    proposal_kind: record.proposalKind,
    target_key: record.targetKey,
    title: record.title,
    summary: record.summary,
    payload: record.payload,
    evidence: record.evidence,
    confidence: record.confidence,
    source_message_id: record.sourceMessageId,
    state: record.state,
    persisted_memory_id: record.persistedMemoryId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    accepted_at: record.acceptedAt,
    dismissed_at: record.dismissedAt,
  };
}

function resolvedWorkspaceHarness(workspace: WorkspaceRecord): string {
  const harness = (workspace.harness ?? process.env.SANDBOX_AGENT_HARNESS ?? "pi").trim();
  return harness || "pi";
}

function sessionSelectionUsesOnboarding(workspace: WorkspaceRecord): boolean {
  const onboardingSessionId = (workspace.onboardingSessionId ?? "").trim();
  if (!onboardingSessionId) {
    return false;
  }
  const onboardingStatus = (workspace.onboardingStatus ?? "").trim().toLowerCase();
  return ["pending", "awaiting_confirmation", "in_progress"].includes(onboardingStatus);
}

function inferredSessionKind(workspace: WorkspaceRecord, sessionId: string): string {
  const trimmedSessionId = sessionId.trim();
  const onboardingSessionId = (workspace.onboardingSessionId ?? "").trim();
  if (onboardingSessionId && onboardingSessionId === trimmedSessionId && sessionSelectionUsesOnboarding(workspace)) {
    return "onboarding";
  }
  return "workspace_session";
}

function isPrimaryChatSessionKind(kind: string | null | undefined): boolean {
  const normalized = (kind ?? "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "workspace_session" ||
    normalized === "main" ||
    normalized === "onboarding"
  );
}

function canInlineBackgroundUpdatesIntoSessionKind(
  kind: string | null | undefined,
): boolean {
  const normalized = (kind ?? "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "workspace_session" ||
    normalized === "main" ||
    normalized === "onboarding"
  );
}

function groupedMainSessionEventsPayload(
  events: Array<{
    eventId: string;
    eventType: string;
    deliveryBucket: string;
    status: string;
    subagentId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>,
): Record<string, unknown>[] {
  return events.map((event) => queuedMainSessionEventPromptEntry(event));
}

function preferredWorkspaceSessionId(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
}): string | null {
  const desktopBinding = params.store.getConversationBindingByConversation({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "workspace-main",
    role: "main",
  });
  if (desktopBinding) {
    const boundSession = params.store.getSession({
      workspaceId: params.workspace.id,
      sessionId: desktopBinding.sessionId,
    });
    if (boundSession && !boundSession.archivedAt && isPrimaryChatSessionKind(boundSession.kind)) {
      return boundSession.sessionId;
    }
  }

  if (sessionSelectionUsesOnboarding(params.workspace)) {
    return (params.workspace.onboardingSessionId ?? "").trim() || null;
  }

  const onboardingSessionId = (params.workspace.onboardingSessionId ?? "").trim();
  const sessions = params.store.listSessions({
    workspaceId: params.workspace.id,
    includeArchived: false,
    limit: 200,
    offset: 0,
  });
  const preferredPrimary = sessions.find((session) => {
    if (session.sessionId === onboardingSessionId) {
      return false;
    }
    return isPrimaryChatSessionKind(session.kind);
  });
  if (preferredPrimary) {
    return preferredPrimary.sessionId;
  }

  const fallback = sessions.find((session) => session.sessionId !== onboardingSessionId) ?? sessions[0] ?? null;
  return fallback?.sessionId ?? null;
}

function sanitizeLegacyHistoryFileSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "session";
}

function workspaceLegacySessionHistoryDir(
  store: RuntimeStateStore,
  workspaceId: string,
): string | null {
  try {
    const workspaceDir = store.assertWorkspaceFolderHealthy(workspaceId);
    return migrateLegacyWorkspaceStatePath({
      workspaceDir,
      relativeSegments: ["legacy-session-histories"],
      legacyRelativeSegments: [".holaboss", "legacy-session-histories"],
    });
  } catch {
    return null;
  }
}

function renderLegacySessionHistoryMarkdown(params: {
  workspace: WorkspaceRecord;
  session: AgentSessionRecord;
  messages: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  exportedAt: string;
  archivedAt: string;
}): string {
  const title = (params.session.title ?? "").trim() || params.session.sessionId;
  const lines = [
    `# ${title}`,
    "",
    `- Workspace: ${params.workspace.name.trim() || params.workspace.id}`,
    `- Session ID: ${params.session.sessionId}`,
    `- Kind: ${(params.session.kind || "workspace_session").trim() || "workspace_session"}`,
    `- Exported At: ${params.exportedAt}`,
    `- Archived At: ${params.archivedAt}`,
  ];
  if (params.outputs.length > 0) {
    lines.push("", "## Outputs", "");
    for (const output of params.outputs) {
      const outputTitle =
        (typeof output.title === "string" && output.title.trim()) ||
        (typeof output.output_type === "string" && output.output_type.trim()) ||
        "Untitled output";
      lines.push(
        `- ${outputTitle}`,
        `  - Output ID: ${String(output.id ?? "")}`,
        `  - Type: ${String(output.output_type ?? "")}`,
        `  - Status: ${String(output.status ?? "")}`,
      );
    }
  }
  lines.push("", "## Transcript", "");
  for (const message of params.messages) {
    const role = String(message.role ?? "assistant");
    const createdAt = String(message.created_at ?? "");
    lines.push(`### ${role}${createdAt ? ` · ${createdAt}` : ""}`, "");
    const text = String(message.text ?? "");
    lines.push(text || "_(empty)_", "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function upsertLegacySessionHistoryManifest(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  items: Array<Record<string, unknown>>;
}): void {
  const historyDir = workspaceLegacySessionHistoryDir(params.store, params.workspace.id);
  if (!historyDir) {
    return;
  }
  fs.mkdirSync(historyDir, { recursive: true });
  const manifestPath = path.join(historyDir, "index.json");
  let existing: Array<Record<string, unknown>> = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed)) {
        existing = parsed.filter((item): item is Record<string, unknown> => isRecord(item));
      }
    } catch {
      existing = [];
    }
  }

  const bySessionId = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    const sessionId = optionalString(item.session_id);
    if (sessionId) {
      bySessionId.set(sessionId, item);
    }
  }
  for (const item of params.items) {
    const sessionId = optionalString(item.session_id);
    if (sessionId) {
      bySessionId.set(sessionId, item);
    }
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      Array.from(bySessionId.values()).sort((left, right) => {
        const leftTime = Date.parse(optionalString(left.archived_at) ?? "") || 0;
        const rightTime = Date.parse(optionalString(right.archived_at) ?? "") || 0;
        return rightTime - leftTime;
      }),
      null,
      2,
    ),
    "utf8",
  );
}

function exportLegacySessionHistory(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  session: AgentSessionRecord;
  archivedAt: string;
}): Record<string, unknown> | null {
  const historyDir = workspaceLegacySessionHistoryDir(params.store, params.workspace.id);
  if (!historyDir) {
    return null;
  }
  fs.mkdirSync(historyDir, { recursive: true });
  const baseName = sanitizeLegacyHistoryFileSegment(params.session.sessionId);
  const jsonFileName = `${baseName}.json`;
  const markdownFileName = `${baseName}.md`;
  const jsonPath = path.join(historyDir, jsonFileName);
  const markdownPath = path.join(historyDir, markdownFileName);
  const exportedAt = utcNowIso();
  const messages = params.store
    .listSessionMessages({
      workspaceId: params.workspace.id,
      sessionId: params.session.sessionId,
      order: "asc",
      limit: 10_000,
      offset: 0,
    })
    .map((message) => {
      const inputId = message.role === "user" && message.id.startsWith("user-") ? message.id.slice(5) : "";
      const attachments = inputId
        ? attachmentsFromInputPayload(
            params.store.getInput({
              workspaceId: params.workspace.id,
              inputId,
            })?.payload.attachments
          )
        : [];
      return {
        id: message.id,
        role: message.role,
        text: message.text,
        created_at: message.createdAt,
        metadata: attachments.length > 0 ? { attachments } : {},
      };
    });
  const outputs = params.store
    .listOutputs({
      workspaceId: params.workspace.id,
      sessionId: params.session.sessionId,
      limit: 10_000,
      offset: 0,
    })
    .filter((item) => item.sessionId === params.session.sessionId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt ?? "") || 0;
      const rightTime = Date.parse(right.createdAt ?? "") || 0;
      return leftTime - rightTime;
    })
    .map((output) => ({
      id: output.id,
      title: output.title,
      output_type: output.outputType,
      status: output.status,
      created_at: output.createdAt,
      updated_at: output.updatedAt,
      metadata: output.metadata,
    }));

  const payload = {
    version: 1,
    exported_at: exportedAt,
    archived_at: params.archivedAt,
    workspace: {
      id: params.workspace.id,
      name: params.workspace.name,
    },
    session: agentSessionPayload(params.session, params.store),
    messages,
    outputs,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(
    markdownPath,
    renderLegacySessionHistoryMarkdown({
      workspace: params.workspace,
      session: params.session,
      messages,
      outputs,
      exportedAt,
      archivedAt: params.archivedAt,
    }),
    "utf8",
  );

  return {
    session_id: params.session.sessionId,
    title: params.session.title,
    kind: params.session.kind,
    archived_at: params.archivedAt,
    exported_at: exportedAt,
    message_count: messages.length,
    output_count: outputs.length,
    json_path: jsonPath,
    markdown_path: markdownPath,
  };
}

function resolveOrCreateWorkspaceMainSession(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
}): {
  session: AgentSessionRecord;
  migratedLegacySessions: Array<Record<string, unknown>>;
} {
  const preferredSessionId = preferredWorkspaceSessionId(params);
  const session =
    (preferredSessionId
      ? params.store.getSession({
          workspaceId: params.workspace.id,
          sessionId: preferredSessionId,
        })
      : null) ??
    params.store.ensureSession({
      workspaceId: params.workspace.id,
      sessionId: `main-${randomUUID()}`,
      kind: "main",
      title: params.workspace.name.trim() || "Main Session",
      createdBy: "system",
    });

  params.store.upsertConversationBinding({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "workspace-main",
    sessionId: session.sessionId,
    role: "main",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });

  const legacySessions = params.store
    .listSessions({
      workspaceId: params.workspace.id,
      includeArchived: false,
      limit: 500,
      offset: 0,
    })
    .filter(
      (candidate) =>
        candidate.sessionId !== session.sessionId &&
        isPrimaryChatSessionKind(candidate.kind),
    );

  const archivedAt = utcNowIso();
  const migratedLegacySessions = legacySessions
    .map((legacySession) => {
      const exported = exportLegacySessionHistory({
        store: params.store,
        workspace: params.workspace,
        session: legacySession,
        archivedAt,
      });
      params.store.ensureSession({
        workspaceId: params.workspace.id,
        sessionId: legacySession.sessionId,
        archivedAt,
      });
      return exported;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));

  if (migratedLegacySessions.length > 0) {
    upsertLegacySessionHistoryManifest({
      store: params.store,
      workspace: params.workspace,
      items: migratedLegacySessions,
    });
  }

  return {
    session,
    migratedLegacySessions,
  };
}

function outputTypeForArtifact(artifactType: string): string {
  switch (artifactType) {
    case "draft":
      return "post";
    case "image":
      return "file";
    case "html":
      return "html";
    case "document":
    default:
      return "document";
  }
}

function resolveOutputInputId(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
}): string | null {
  const requestedInputId = (params.inputId ?? "").trim();
  if (requestedInputId) {
    return requestedInputId;
  }
  const runtimeState = params.store.getRuntimeState({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
  return runtimeState?.currentInputId?.trim() || null;
}

function resolveQueueSessionId(
  requestedSessionId: string | undefined,
  store: RuntimeStateStore,
  workspace: WorkspaceRecord,
): string {
  if (requestedSessionId && requestedSessionId.trim()) {
    return requestedSessionId.trim();
  }
  return preferredWorkspaceSessionId({ store, workspace }) ?? randomUUID();
}

function activeUserPreferenceMemoryMatchesProposal(params: {
  entry: ReturnType<RuntimeStateStore["listMemoryEntries"]>[number];
  proposal: ReturnType<typeof buildMemoryUpdateProposalsFromUserInput>[number];
}): boolean {
  if (params.entry.scope !== "user" || params.entry.memoryType !== "preference") {
    return false;
  }
  if (params.entry.subjectKey !== params.proposal.targetKey) {
    return false;
  }
  if (params.proposal.targetKey === "response-style") {
    const style = optionalString(params.proposal.payload.style)?.toLowerCase();
    if (!style) {
      return params.entry.summary === params.proposal.summary;
    }
    return (
      params.entry.tags.some((tag) => tag.toLowerCase() === style) ||
      params.entry.summary.toLowerCase().includes(style)
    );
  }
  if (params.proposal.targetKey === "file-delivery") {
    return (
      params.entry.tags.some((tag) => ["individual-files", "no-zip"].includes(tag.toLowerCase())) ||
      params.entry.summary.toLowerCase().includes("deliver") ||
      params.entry.summary.toLowerCase().includes("zip")
    );
  }
  return params.entry.summary === params.proposal.summary;
}

function existingMemoryUpdateProposalMatches(params: {
  existing: MemoryUpdateProposalRecord;
  proposal: ReturnType<typeof buildMemoryUpdateProposalsFromUserInput>[number];
}): boolean {
  if (params.existing.proposalKind !== params.proposal.proposalKind) {
    return false;
  }
  if (params.existing.targetKey !== params.proposal.targetKey) {
    return false;
  }
  if (params.existing.summary === params.proposal.summary) {
    return true;
  }
  if (params.proposal.targetKey === "response-style") {
    return optionalString(params.existing.payload.style) === optionalString(params.proposal.payload.style);
  }
  if (params.proposal.targetKey === "file-delivery") {
    return true;
  }
  return false;
}

function createInputMemoryUpdateProposals(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  sourceMessageId: string;
  text: string;
}): MemoryUpdateProposalRecord[] {
  if (!params.text.trim()) {
    return [];
  }
  const detected = buildMemoryUpdateProposalsFromUserInput(params.text);
  if (detected.length === 0) {
    return [];
  }
  const activeMemoryEntries = params.store.listMemoryEntries({
    status: "active",
    limit: 500,
    offset: 0,
  });
  const existingProposals = params.store.listMemoryUpdateProposals({
    workspaceId: params.workspaceId,
    limit: 500,
    offset: 0,
  });
  const createdAt = utcNowIso();
  const created: MemoryUpdateProposalRecord[] = [];
  for (const proposal of detected) {
    const alreadyPersisted = activeMemoryEntries.some((entry) =>
      activeUserPreferenceMemoryMatchesProposal({ entry, proposal })
    );
    if (alreadyPersisted) {
      continue;
    }
    const alreadyProposed = existingProposals.some((existing) =>
      existingMemoryUpdateProposalMatches({ existing, proposal })
    );
    if (alreadyProposed) {
      continue;
    }
    created.push(
      params.store.createMemoryUpdateProposal({
        proposalId: randomUUID(),
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        inputId: params.inputId,
        proposalKind: proposal.proposalKind,
        targetKey: proposal.targetKey,
        title: proposal.title,
        summary: proposal.summary,
        payload: proposal.payload,
        evidence: proposal.evidence,
        confidence: proposal.confidence,
        sourceMessageId: params.sourceMessageId,
        createdAt,
        updatedAt: createdAt,
      })
    );
  }
  return created;
}

function effectiveSessionState(
  runtimeState: SessionRuntimeStateRecord | null,
  hasQueued: boolean
): {
  effective_state: string;
  runtime_status: string | null;
  current_input_id: string | null;
  heartbeat_at: string | null;
  lease_until: string | null;
} {
  const runtimeStatus = runtimeState?.status ?? null;
  let effectiveState = "IDLE";
  if (runtimeStatus && ["BUSY", "WAITING_USER", "ERROR"].includes(runtimeStatus)) {
    effectiveState = runtimeStatus;
  } else if (hasQueued) {
    effectiveState = "QUEUED";
  } else if (runtimeStatus) {
    effectiveState = runtimeStatus;
  }

  return {
    effective_state: effectiveState,
    runtime_status: runtimeStatus,
    current_input_id: runtimeState?.currentInputId ?? null,
    heartbeat_at: runtimeState?.heartbeatAt ?? null,
    lease_until: runtimeState?.leaseUntil ?? null
  };
}

function runtimeStateHasClaimedActiveInput(
  store: RuntimeStateStore,
  runtimeState: SessionRuntimeStateRecord | null,
): boolean {
  const workspaceId = runtimeState?.workspaceId?.trim() ?? "";
  const currentInputId = runtimeState?.currentInputId?.trim() ?? "";
  if (!currentInputId || !workspaceId) {
    return false;
  }
  return store.getInput({
    workspaceId,
    inputId: currentInputId,
  })?.status === "CLAIMED";
}

function runnerOutputEventPayload(record: OutputEventRecord): Record<string, unknown> {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    sequence: record.sequence,
    event_type: record.eventType,
    created_at: record.createdAt,
    timestamp: record.createdAt,
    payload: record.payload
  };
}

function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

function sseEvent(record: OutputEventRecord): string {
  const event = runnerOutputEventPayload(record);
  return [
    `event: ${record.eventType}`,
    `id: ${record.inputId}:${record.sequence}`,
    `data: ${JSON.stringify(event)}`
  ].join("\n") + "\n\n";
}

function sendError(reply: FastifyReply, statusCode: number, detail: string) {
  return reply.code(statusCode).send({ detail });
}

function resolveWorkspaceFilePath(workspaceDir: string, relativePath: string): string {
  if (!relativePath || relativePath.split("/").includes("..")) {
    throw new Error("path traversal not allowed");
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const fullPath = path.resolve(resolvedWorkspaceDir, relativePath);
  if (fullPath !== resolvedWorkspaceDir && !fullPath.startsWith(`${resolvedWorkspaceDir}${path.sep}`)) {
    throw new Error("path traversal not allowed");
  }
  return fullPath;
}

class InvalidTemplateArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTemplateArchiveError";
  }
}

function invalidTemplateArchiveMessage(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error instanceof InvalidTemplateArchiveError) {
    return error.message;
  }
  if (
    error.message === "path traversal not allowed" ||
    /invalid relative path|absolute path|invalid characters/i.test(error.message)
  ) {
    return error.message;
  }
  return null;
}

function openZipFile(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error("template extract failed"));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openZipEntryReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error(`missing zip stream for entry: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

async function extractTemplateZipArchive(zipPath: string, workspaceDir: string): Promise<number> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const zipFile = await openZipFile(zipPath);
  let filesWritten = 0;

  return await new Promise<number>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      zipFile.close();
      fn();
    };

    zipFile.on("error", (error) => {
      const message = invalidTemplateArchiveMessage(error);
      finish(() => reject(message ? new InvalidTemplateArchiveError(message) : error));
    });

    zipFile.on("entry", (entry) => {
      void (async () => {
        const validationError = yauzl.validateFileName(entry.fileName);
        if (validationError) {
          throw new InvalidTemplateArchiveError(validationError);
        }

        const normalizedPath = entry.fileName.replace(/\/+$/, "");
        if (!normalizedPath) {
          zipFile.readEntry();
          return;
        }

        const targetPath = resolveWorkspaceFilePath(resolvedWorkspaceDir, normalizedPath);
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(targetPath, { recursive: true });
          zipFile.readEntry();
          return;
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const source = await openZipEntryReadStream(zipFile, entry);
        const destination = fs.createWriteStream(targetPath, { mode: 0o644 });
        await pipeline(source, destination);

        const mode = (entry.externalFileAttributes >> 16) & 0o777;
        if (mode) {
          fs.chmodSync(targetPath, mode);
        }
        filesWritten += 1;
        zipFile.readEntry();
      })().catch((error) => {
        finish(() => reject(error));
      });
    });

    zipFile.on("end", () => {
      finish(() => resolve(filesWritten));
    });

    zipFile.readEntry();
  });
}

function appCatalogEntryToWire(record: AppCatalogEntryRecord): Record<string, unknown> {
  return {
    app_id: record.appId,
    source: record.source,
    name: record.name,
    description: record.description,
    icon: record.icon,
    category: record.category,
    tags: record.tags,
    version: record.version,
    archive_url: record.archiveUrl,
    archive_path: record.archivePath,
    target: record.target,
    cached_at: record.cachedAt,
    provider_id: record.providerId,
    credential_source: record.credentialSource,
  };
}

function sanitizeAppId(appId: string): string {
  const value = appId.trim();
  if (!value) {
    throw new Error("app_id is required");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error("app_id must not contain path separators");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("app_id contains invalid characters");
  }
  return value;
}

export function isAllowedArchivePath(p: string): boolean {
  if (!p) return false;
  const abs = path.resolve(p);
  const candidates: string[] = [];
  candidates.push(path.resolve(os.tmpdir()));
  const envOverride = process.env.HOLABOSS_APP_ARCHIVE_DIR;
  if (envOverride && envOverride.trim().length > 0) {
    candidates.push(path.resolve(envOverride.trim()));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && home.trim().length > 0) {
    candidates.push(path.resolve(home.trim(), ".holaboss", "downloads"));
  }
  for (const root of candidates) {
    if (abs === root || abs.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

export function isAllowedArchiveUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }

  const defaultPrefixes = [
    "https://github.com/holaboss-ai/holaboss-apps/releases/download/",
  ];
  const envOverride = process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
  const extraPrefixes = envOverride
    ? envOverride.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
    : [];
  const allPrefixes = [...defaultPrefixes, ...extraPrefixes];

  // http:// only allowed if explicitly in the override list
  const eligiblePrefixes = parsed.protocol === "http:" ? extraPrefixes : allPrefixes;

  // Stricter than `url.startsWith(prefix)`: re-parse each prefix and
  // compare host + pathname so an attacker can't smuggle a lookalike
  // domain like `https://github.com.attacker.com/...` past a
  // `https://github.com/...` prefix. The parsed-host comparison closes
  // the suffix-attack vector entirely.
  return eligiblePrefixes.some((prefix) => {
    let prefixUrl: URL;
    try {
      prefixUrl = new URL(prefix);
    } catch {
      return false;
    }
    if (prefixUrl.protocol !== parsed.protocol) {
      return false;
    }
    if (prefixUrl.host !== parsed.host) {
      return false;
    }
    // Ensure the path of the request URL begins with the prefix path so
    // we don't accept arbitrary paths under a matching host.
    return parsed.pathname.startsWith(prefixUrl.pathname);
  });
}

async function downloadArchiveToTemp(url: string, appId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "holaboss-app-archives");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${appId}-${Date.now()}.tar.gz`);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const fileStream = fs.createWriteStream(filePath);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) fileStream.write(value);
    }
  } finally {
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", () => resolve());
      fileStream.on("error", reject);
    });
  }
  return filePath;
}

function collectSystemStatus(workspaceRoot: string, store: RuntimeStateStore): Record<string, unknown> {
  return {
    cpu: getCpuInfo(),
    memory: getMemoryInfo(),
    disk: getDiskInfo(),
    workspaces: getWorkspaceDiskInfo(workspaceRoot, store),
    uptime_seconds: os.uptime(),
  };
}

function getCpuInfo(): Record<string, unknown> {
  const numCores = os.cpus().length || 1;
  const loadAvg = os.loadavg()[0] ?? 0;
  const usagePercent = Math.round(Math.min((loadAvg / numCores) * 100, 100) * 10) / 10;
  return { usage_percent: usagePercent, num_cores: numCores };
}

function getMemoryInfo(): Record<string, unknown> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

  // Try cgroup v2 for container-aware limits
  try {
    const cgroupCurrent = "/sys/fs/cgroup/memory.current";
    const cgroupMax = "/sys/fs/cgroup/memory.max";
    if (fs.existsSync(cgroupCurrent) && fs.existsSync(cgroupMax)) {
      const used = Number.parseInt(fs.readFileSync(cgroupCurrent, "utf8").trim(), 10);
      const maxRaw = fs.readFileSync(cgroupMax, "utf8").trim();
      const total = maxRaw === "max" ? totalBytes : Number.parseInt(maxRaw, 10);
      const pct = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      return { used_bytes: used, total_bytes: total, percent: pct };
    }
  } catch {
    // fall through to os-level stats
  }

  return { used_bytes: usedBytes, total_bytes: totalBytes, percent };
}

function getDiskInfo(): Record<string, unknown> {
  try {
    const result = spawnSync("df", ["-B1", "--output=size,used,avail", "/"], { timeout: 5000 });
    if (result.status === 0) {
      const lines = result.stdout.toString().trim().split("\n");
      if (lines.length >= 2) {
        const parts = (lines[1] ?? "").trim().split(/\s+/);
        const total = Number.parseInt(parts[0] ?? "0", 10);
        const used = Number.parseInt(parts[1] ?? "0", 10);
        const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
        return { used_bytes: used, total_bytes: total, percent };
      }
    }
  } catch {
    // fall through
  }
  return { used_bytes: 0, total_bytes: 0, percent: 0 };
}

function getWorkspaceDiskInfo(workspaceRoot: string, store: RuntimeStateStore): Record<string, unknown> {
  const byWorkspace: Record<string, number> = {};
  try {
    const workspaces = store.listWorkspaces({ includeDeleted: false });
    for (const ws of workspaces) {
      const wsDir = store.workspaceDir(ws.id);
      if (fs.existsSync(wsDir)) {
        byWorkspace[ws.id] = dirSize(wsDir);
      }
    }
  } catch {
    // best-effort
  }
  const totalBytes = Object.values(byWorkspace).reduce((sum, size) => sum + size, 0);
  return { count: Object.keys(byWorkspace).length, total_bytes: totalBytes, by_workspace: byWorkspace };
}

function dirSize(dirPath: string): number {
  let total = 0;
  try {
    const stack = [dirPath];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && !entry.isSymbolicLink()) {
          try {
            total += fs.statSync(fullPath).size;
          } catch {
            // skip inaccessible files
          }
        }
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return total;
}

function appBuildPayload(record: AppBuildRecord): Record<string, unknown> {
  return {
    workspace_id: record.workspaceId,
    app_id: record.appId,
    status: record.status,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    error: record.error,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function fallbackAppBuildStatus(entry: Record<string, unknown>): string {
  const lifecycle = isRecord(entry.lifecycle) ? entry.lifecycle : null;
  return typeof lifecycle?.setup === "string" && lifecycle.setup.trim().length > 0 ? "pending" : "stopped";
}

function resolvedAppBuildStatus(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  appId: string;
  entry?: Record<string, unknown> | null;
}): string {
  const build = params.store.getAppBuild({
    workspaceId: params.workspaceId,
    appId: params.appId
  });
  if (build?.status) {
    return build.status;
  }
  return params.entry ? fallbackAppBuildStatus(params.entry) : "unknown";
}

function blockingWorkspaceApps(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): Array<{ appId: string; status: string }> {
  return listWorkspaceApplications(params.store.workspaceDir(params.workspaceId))
    .map((entry) => {
      const appId = typeof entry.app_id === "string" ? entry.app_id : "";
      return {
        appId,
        status: appId ? resolvedAppBuildStatus({ ...params, appId, entry }) : "unknown"
      };
    })
    .filter((entry) => entry.appId.length > 0 && entry.status !== "running");
}

function blockingWorkspaceAppsMessage(entries: Array<{ appId: string; status: string }>): string {
  if (entries.some((entry) => entry.status === "failed")) {
    return `workspace apps failed to start: ${entries.map((entry) => `${entry.appId} (${entry.status})`).join(", ")}`;
  }
  if (entries.some((entry) => entry.status === "building")) {
    return `workspace apps are still building: ${entries.map((entry) => `${entry.appId} (${entry.status})`).join(", ")}`;
  }
  return `workspace apps are still starting: ${entries.map((entry) => `${entry.appId} (${entry.status})`).join(", ")}`;
}

async function runAppSetup(params: {
  store: RuntimeStateStore;
  workspaceDir: string;
  workspaceId: string;
  appId: string;
  setupCommand: string;
  logger?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
    error: (obj: Record<string, unknown>, msg?: string) => void;
  };
}): Promise<void> {
  const appDir = path.join(params.workspaceDir, "apps", params.appId);
  // Per-app log dir: <appDir>/.holaboss/logs. Survives across runtime
  // restarts; timestamped + "latest" mirror for easy tail by UI/CLI.
  const logDir = path.join(appDir, ".holaboss", "logs");
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `setup-${runTimestamp}.log`);
  const latestLogPath = path.join(logDir, "setup.latest.log");
  const eventsPath = path.join(logDir, "events.ndjson");

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort
  }

  const logHeader = [
    `=== app setup ===`,
    `workspace_id: ${params.workspaceId}`,
    `app_id:       ${params.appId}`,
    `app_dir:      ${appDir}`,
    `command:      ${params.setupCommand}`,
    `started:      ${new Date().toISOString()}`,
    `pid:          ${process.pid}`,
    `================`,
    ``,
  ].join("\n");
  try {
    fs.writeFileSync(logPath, logHeader, "utf8");
  } catch {
    // best-effort
  }
  const appendEvent = (event: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
        "utf8",
      );
    } catch {
      // best-effort
    }
  };

  params.logger?.info(
    {
      event: "app.setup.start",
      workspaceId: params.workspaceId,
      appId: params.appId,
      appDir,
      logPath,
      command: params.setupCommand,
    },
    "runAppSetup: starting",
  );
  appendEvent({
    event: "setup.start",
    app_id: params.appId,
    workspace_id: params.workspaceId,
    command: params.setupCommand,
    log_path: logPath,
  });

  params.store.upsertAppBuild({
    workspaceId: params.workspaceId,
    appId: params.appId,
    status: "building"
  });
  const setupTimeoutMs = appSetupTimeoutMs();

  try {
    const result = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve, reject) => {
      // Captures are bounded at ~256 KiB per stream for the log file but
      // only the last 4 KiB is kept in memory for the DB/error message,
      // so runaway output can't OOM the runtime.
      const MAX_CAPTURE_BYTES = 256 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(params.setupCommand, {
        cwd: appDir,
        env: buildAppSetupEnv(appDir),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        killChildProcess(child, "SIGKILL");
        resolve({ code: null, timedOut: true, stdout, stderr });
      }, setupTimeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length >= MAX_CAPTURE_BYTES) {
          return;
        }
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stdout = `${stdout}${text}`.slice(0, MAX_CAPTURE_BYTES);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderr.length >= MAX_CAPTURE_BYTES) {
          return;
        }
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderr = `${stderr}${text}`.slice(0, MAX_CAPTURE_BYTES);
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ code, timedOut: false, stdout, stderr });
      });
    });

    // Always write the full captured output to the log file so
    // debugging doesn't require re-running the setup.
    const body = [
      logHeader,
      `--- STDOUT ---`,
      result.stdout,
      ``,
      `--- STDERR ---`,
      result.stderr,
      ``,
      `--- END ---`,
      `exit_code: ${result.code ?? "null (killed)"}`,
      `timed_out: ${result.timedOut}`,
      `finished:  ${new Date().toISOString()}`,
      ``,
    ].join("\n");
    try {
      fs.writeFileSync(logPath, body, "utf8");
      fs.writeFileSync(latestLogPath, body, "utf8");
    } catch {
      // best-effort
    }

    if (result.timedOut) {
      const timeoutSeconds = Math.max(1, Math.round(setupTimeoutMs / 1000));
      const msg = `setup timed out after ${timeoutSeconds}s — see ${logPath}`;
      params.logger?.error(
        {
          event: "app.setup.timeout",
          workspaceId: params.workspaceId,
          appId: params.appId,
          logPath,
          timeoutSeconds,
          stderrTail: result.stderr.slice(-1000),
        },
        "runAppSetup: timed out",
      );
      appendEvent({
        event: "setup.timeout",
        app_id: params.appId,
        timeout_seconds: timeoutSeconds,
        log_path: logPath,
      });
      params.store.upsertAppBuild({
        workspaceId: params.workspaceId,
        appId: params.appId,
        status: "failed",
        error: msg,
      });
      return;
    }
    if ((result.code ?? 0) !== 0) {
      const errorMsg = [
        `setup exited with code ${result.code} — see ${logPath}`,
        ``,
        result.stderr.slice(-1500),
      ].join("\n");
      params.logger?.error(
        {
          event: "app.setup.failed",
          workspaceId: params.workspaceId,
          appId: params.appId,
          logPath,
          exitCode: result.code,
          stderrTail: result.stderr.slice(-2000),
          stdoutTail: result.stdout.slice(-2000),
        },
        "runAppSetup: exited non-zero",
      );
      appendEvent({
        event: "setup.failed",
        app_id: params.appId,
        exit_code: result.code,
        log_path: logPath,
      });
      params.store.upsertAppBuild({
        workspaceId: params.workspaceId,
        appId: params.appId,
        status: "failed",
        error: errorMsg.slice(0, 2000),
      });
      return;
    }
    params.logger?.info(
      {
        event: "app.setup.completed",
        workspaceId: params.workspaceId,
        appId: params.appId,
        logPath,
        stdoutBytes: result.stdout.length,
      },
      "runAppSetup: completed",
    );
    appendEvent({
      event: "setup.success",
      app_id: params.appId,
      log_path: logPath,
    });
    params.store.upsertAppBuild({
      workspaceId: params.workspaceId,
      appId: params.appId,
      status: "completed"
    });
  } catch (error) {
    const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    params.logger?.error(
      {
        event: "app.setup.exception",
        workspaceId: params.workspaceId,
        appId: params.appId,
        logPath,
        err: errMsg,
      },
      "runAppSetup: threw",
    );
    appendEvent({
      event: "setup.exception",
      app_id: params.appId,
      err: errMsg,
      log_path: logPath,
    });
    params.store.upsertAppBuild({
      workspaceId: params.workspaceId,
      appId: params.appId,
      status: "failed",
      error: `${errMsg} (see ${logPath})`.slice(0, 2000)
    });
  }
}

async function executeWorkspaceCommand(command: string, cwd: string, timeoutSeconds: number): Promise<{
  stdout: string;
  stderr: string;
  returncode: number;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawnShellCommand(spawn, command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      reject(new Error("workspace exec subprocess streams were not initialized"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChildProcess(child, "SIGKILL");
      reject(new Error("workspace exec timed out"));
    }, Math.max(1, timeoutSeconds) * 1000);

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        return;
      }
      resolve({
        stdout,
        stderr,
        returncode: code ?? 0
      });
    });
  });
}

/**
 * Kill processes that are still listening on ports allocated to deleted or
 * non-existent workspaces.  Runs once at startup to recover from unclean
 * shutdowns where the normal stopApp cleanup never ran.
 */
async function cleanupOrphanAppProcesses(
  store: RuntimeStateStore,
  log: { info: (...args: unknown[]) => void; debug: (...args: unknown[]) => void }
): Promise<void> {
  const allPorts = store.listAllAppPorts();
  if (allPorts.length === 0) {
    return;
  }

  const activeWorkspaceIds = new Set(
    store.listWorkspaces({ includeDeleted: false }).map((ws) => ws.id)
  );

  const orphanPorts: number[] = [];
  const orphanRecords: Array<{ workspaceId: string; appId: string }> = [];

  for (const record of allPorts) {
    if (!activeWorkspaceIds.has(record.workspaceId)) {
      orphanPorts.push(record.port);
      orphanRecords.push({ workspaceId: record.workspaceId, appId: record.appId });
    }
  }

  if (orphanPorts.length === 0) {
    return;
  }

  log.info(
    { orphanPorts, count: orphanPorts.length },
    "cleaning up orphan app processes from deleted workspaces"
  );

  await killPortListeners(orphanPorts);

  for (const record of orphanRecords) {
    store.deleteAppPort({ workspaceId: record.workspaceId, appId: record.appId });
  }
}

export function buildRuntimeApiServer(options: BuildRuntimeApiServerOptions = {}): FastifyInstance {
  const ownsStore = !options.store;
  const store =
    options.store ??
    new RuntimeStateStore({
      dbPath: options.dbPath,
      workspaceRoot: options.workspaceRoot ?? defaultWorkspaceRoot()
    });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });
  void app.register(websocket);
  const backgroundTasks = new Set<Promise<void>>();
  const appSetupTasks = new Map<string, Promise<void>>();
  const appEnsureRunningTasks = new Map<string, Promise<void>>();
  // Serializes /api/v1/apps/install-archive against itself for the same
  // (workspaceId, appId). Without this, two concurrent installs both pass
  // the empty-appDir check, both extract on top of each other, and both
  // race-write app.runtime.yaml producing corrupt state.
  const appInstallTasks = new Map<string, Promise<unknown>>();
  const appLifecycleExecutor = options.appLifecycleExecutor ?? new RuntimeAppLifecycleExecutor({ store });
  const memoryService = options.memoryService ?? new FilesystemMemoryService({
    workspaceRoot: store.workspaceRoot,
    resolveWorkspaceDir: (workspaceId) => store.workspaceDir(workspaceId),
  });
  const runtimeConfigService = options.runtimeConfigService ?? new FileRuntimeConfigService();
  const browserToolService = options.browserToolService ?? new DesktopBrowserToolService({ artifactStore: store });
  const terminalSessionManager =
    options.terminalSessionManager === undefined
      ? new TerminalSessionManager({
        store,
        logger: app.log,
        captureRuntimeException,
      })
      : options.terminalSessionManager;
  const integrationService = new RuntimeIntegrationService(store);
  const honoBaseUrl = process.env.HOLABOSS_AUTH_BASE_URL ?? "";
  const authCookie = process.env.HOLABOSS_AUTH_COOKIE ?? "";
  const composioService = honoBaseUrl && authCookie
    ? new ComposioService({ honoBaseUrl, authCookie })
    : null;
  const brokerService = new IntegrationBrokerService(store, composioService);
  const oauthService = new OAuthService(store);
  const runnerExecutor = options.runnerExecutor ?? new NativeRunnerExecutor();
  const durableMemoryWorker = resolveDurableMemoryWorker(options, app, store, memoryService);
  const queueWorker = resolveQueueWorker(options, app, store, memoryService, durableMemoryWorker);
  const cronWorker = resolveCronWorker(options, app, store, queueWorker);
  const mainSessionEventWorker = resolveMainSessionEventWorker(
    options,
    app,
    store,
    queueWorker,
  );
  const bridgeWorker = resolveBridgeWorker(options, app, store, memoryService);
  const recallEmbeddingBackfillWorker = resolveRecallEmbeddingBackfillWorker(options, app, store, memoryService);
  const runtimeAgentToolsService = new RuntimeAgentToolsService(store, {
    workspaceRoot: store.workspaceRoot,
    terminalSessionManager,
    queueWorker,
  });
  async function maybeShapeCapabilityToolResult(params: {
    headers: Record<string, unknown>;
    toolId: string;
    payload: unknown;
    workspaceId?: string | null;
    sessionId?: string | null;
  }): Promise<unknown> {
    return await shapeCapabilityToolResultPayload({
      mode: capabilityToolResultModeFromHeaders(params.headers),
      toolId: params.toolId,
      payload: params.payload,
      workspaceRoot: store.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      const sentryExtras = (error as { sentryExtras?: Record<string, unknown> })
        .sentryExtras;
      Sentry.captureException(error, {
        extra: {
          method: request.method,
          url: request.url,
          ...(sentryExtras ?? {}),
        },
      });
      app.log.error(error);
      reply.status(statusCode).send({ error: "Internal Server Error" });
      return;
    }

    app.log.warn(
      { err: error, method: request.method, url: request.url },
      "client error",
    );
    reply.status(statusCode).send({
      error: error.name ?? "Error",
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.validation ? { validation: error.validation } : {}),
    });
  });

  // ---------------------------------------------------------------------------
  // App liveness: ensure enabled apps are running + health monitoring
  // ---------------------------------------------------------------------------

  const HEALTH_MONITOR_INTERVAL_MS = 30_000;
  const MAX_AUTO_RESTART_ATTEMPTS = 5;
  const autoRestartAttempts = new Map<string, number>();
  let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Ensures this app's MCP tools are registered in workspace.yaml's
   * `mcp_registry`. Runs idempotently after every app start so apps
   * installed via legacy paths or stale templates get auto-healed.
   */
  function reconcileAppMcpRegistry(
    workspaceDir: string,
    appId: string,
    resolved: { ports: { mcp: number }; resolvedApp: { mcpTools: string[]; mcp: { path: string } } },
    options: { bumpStartedAt?: boolean } = {},
  ): void {
    if (resolved.resolvedApp.mcpTools.length === 0) {
      return;
    }
    try {
      writeWorkspaceMcpRegistryEntry(workspaceDir, appId, {
        mcpEnabled: true,
        mcpTools: resolved.resolvedApp.mcpTools,
        mcpPath: resolved.resolvedApp.mcp.path || "/mcp/sse",
        mcpTimeoutMs: 30000,
        mcpPort: resolved.ports.mcp,
        bumpStartedAt: options.bumpStartedAt === true,
      });
    } catch (error) {
      app.log.warn(
        { appId, err: error },
        "mcp_registry reconcile failed for app",
      );
    }
  }

  async function ensureAppRunning(workspaceId: string, appId: string): Promise<void> {
    const taskKey = `${workspaceId}:${appId}`;
    const inFlight = appEnsureRunningTasks.get(taskKey);
    if (inFlight) {
      await inFlight;
      return;
    }

    const task = (async () => {
      app.log.info(
        { event: "app.ensure_running.start", workspaceId, appId },
        "ensureAppRunning: begin",
      );
      const workspaceDir = store.workspaceDir(workspaceId);
      let resolved;
      try {
        resolved = resolveWorkspaceAppRuntime(workspaceDir, appId, {
          store,
          workspaceId,
          allocatePorts: true
        });
      } catch (error) {
        app.log.error(
          {
            event: "app.ensure_running.resolve_failed",
            workspaceId,
            appId,
            err: error instanceof Error ? error.message : String(error),
          },
          "ensureAppRunning: resolveWorkspaceAppRuntime threw",
        );
        throw error;
      }
      app.log.info(
        {
          event: "app.ensure_running.resolved",
          workspaceId,
          appId,
          appDir: resolved.appDir,
          httpPort: resolved.ports.http,
          mcpPort: resolved.ports.mcp,
        },
        "ensureAppRunning: resolved runtime",
      );

      // Already healthy — sync DB and return.
      //
      // For shell-style lifecycles (lifecycle.start or startCommand),
      // the runtime may be probing an app process it did not spawn in
      // this process lifetime, such as after the desktop runtime
      // relaunches. In that case, adopt the known ports so later stop
      // and restart flows can still clean up by listener even though we
      // do not have an in-memory child handle.
      //
      // Compose-managed apps are owned by docker, not by us, so the
      // tracking check doesn't apply there — trust isAppHealthy.
      const isShellManaged =
        Boolean(resolved.resolvedApp.lifecycle.start?.trim()) ||
        Boolean(resolved.resolvedApp.startCommand?.trim());
      const healthy = await isAppHealthy({
        resolvedApp: resolved.resolvedApp,
        httpPort: resolved.ports.http,
        mcpPort: resolved.ports.mcp
      });
      // When the executor doesn't expose isTrackingApp (e.g. test doubles)
      // fall back to trusting the health probe — preserves prior behavior.
      const tracked = appLifecycleExecutor.isTrackingApp
        ? appLifecycleExecutor.isTrackingApp({ workspaceId, appId })
        : true;
      if (healthy && (!isShellManaged || tracked)) {
        app.log.info(
          { event: "app.ensure_running.already_healthy", workspaceId, appId },
          "ensureAppRunning: already healthy, short-circuiting",
        );
        store.upsertAppBuild({ workspaceId, appId, status: "running" });
        reconcileAppMcpRegistry(workspaceDir, appId, resolved);
        return;
      }
      if (healthy && isShellManaged) {
        appLifecycleExecutor.rememberAppPorts?.({
          workspaceId,
          appId,
          httpPort: resolved.ports.http,
          mcpPort: resolved.ports.mcp,
        });
        app.log.info(
          {
            event: "app.ensure_running.healthy_untracked_reused",
            workspaceId,
            appId,
            http: resolved.ports.http,
            mcp: resolved.ports.mcp,
          },
          "ensureAppRunning: healthy app has no tracked process; reusing existing listener",
        );
        store.upsertAppBuild({ workspaceId, appId, status: "running" });
        reconcileAppMcpRegistry(workspaceDir, appId, resolved);
        return;
      }

      // Setup needed?
      const build = store.getAppBuild({ workspaceId, appId });
      const needsSetup =
        !appBuildHasCompletedSetup(build?.status) &&
        resolved.resolvedApp.lifecycle.setup.trim().length > 0;
      app.log.info(
        {
          event: "app.ensure_running.setup_gate",
          workspaceId,
          appId,
          buildStatus: build?.status ?? null,
          hasSetupCommand: resolved.resolvedApp.lifecycle.setup.trim().length > 0,
          needsSetup,
        },
        "ensureAppRunning: setup gate",
      );
      if (needsSetup) {
        await runAppSetup({
          store,
          workspaceDir,
          workspaceId,
          appId,
          setupCommand: resolved.resolvedApp.lifecycle.setup,
          logger: app.log,
        });
        const afterSetup = store.getAppBuild({ workspaceId, appId });
        if (afterSetup?.status === "failed") {
          const setupError = Object.assign(
            new Error(afterSetup.error ?? "setup failed"),
            { sentryExtras: { workspaceId, appId } },
          );
          app.log.error(
            { event: "app.ensure_running.setup_failed", workspaceId, appId, err: afterSetup.error },
            "ensureAppRunning: setup failed, aborting start",
          );
          throw setupError;
        }
      }

      // Start app process.
      app.log.info(
        { event: "app.ensure_running.start_spawn", workspaceId, appId, appDir: resolved.appDir },
        "ensureAppRunning: spawning lifecycle.start",
      );
      let result;
      try {
        result = await appLifecycleExecutor.startApp({
          appId,
          appDir: resolved.appDir,
          httpPort: resolved.ports.http,
          mcpPort: resolved.ports.mcp,
          workspaceId,
          resolvedApp: resolved.resolvedApp,
          skipSetup: true
        });
      } catch (error) {
        app.log.error(
          {
            event: "app.ensure_running.start_failed",
            workspaceId,
            appId,
            err: error instanceof Error ? error.message : String(error),
          },
          "ensureAppRunning: startApp threw",
        );
        throw error;
      }
      store.upsertAppBuild({
        workspaceId,
        appId,
        status: result.status === "started" ? "running" : result.status
      });
      app.log.info(
        { event: "app.ensure_running.started", workspaceId, appId, status: result.status },
        "ensureAppRunning: started",
      );

      // Bump started_at on the post-start path so any MCP client watching
      // workspace.yaml can drop cached SSE streams and reconnect. The
      // "already healthy" path above does NOT bump (idempotent).
      reconcileAppMcpRegistry(workspaceDir, appId, resolved, { bumpStartedAt: true });
    })();

    appEnsureRunningTasks.set(taskKey, task);
    try {
      await task;
    } finally {
      if (appEnsureRunningTasks.get(taskKey) === task) {
        appEnsureRunningTasks.delete(taskKey);
      }
    }
  }

  async function ensureAllAppsRunning(
    workspaceId: string
  ): Promise<{ apps: Array<{ app_id: string; ready: boolean; error: string | null }> }> {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return { apps: [] };
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    const entries = listWorkspaceApplications(workspaceDir);
    const validEntries = entries.filter(
      (e) => typeof e.app_id === "string" && e.app_id.length > 0
    );

    const results = await Promise.allSettled(
      validEntries.map((entry) => ensureAppRunning(workspaceId, entry.app_id as string))
    );

    return {
      apps: results.map((r, i) => ({
        app_id: validEntries[i].app_id as string,
        ready: r.status === "fulfilled",
        error:
          r.status === "rejected"
            ? (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 2000)
            : null
      }))
    };
  }

  function appUsesIntegration(resolvedApp: {
    integrations?: Array<{ key: string; provider: string }>;
  }, integrationKey: string): boolean {
    const normalizedIntegrationKey = integrationKey.trim().toLowerCase();
    if (!normalizedIntegrationKey) {
      return false;
    }
    return (resolvedApp.integrations ?? []).some((requirement) => {
      return (
        requirement.key.trim().toLowerCase() === normalizedIntegrationKey ||
        requirement.provider.trim().toLowerCase() === normalizedIntegrationKey
      );
    });
  }

  async function refreshAppsForIntegrationBinding(params: {
    workspaceId: string;
    integrationKey: string;
    targetType: "workspace" | "app" | "agent";
    targetId: string;
  }): Promise<void> {
    if (params.targetType === "agent") {
      return;
    }

    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return;
    }

    const workspaceDir = store.workspaceDir(params.workspaceId);
    const entries = listWorkspaceApplications(workspaceDir);
    for (const entry of entries) {
      const appId = typeof entry.app_id === "string" ? entry.app_id : "";
      if (!appId) {
        continue;
      }

      if (params.targetType === "app" && appId !== params.targetId) {
        continue;
      }

      const build = store.getAppBuild({ workspaceId: params.workspaceId, appId });
      if (!appBuildHasCompletedSetup(build?.status)) {
        continue;
      }

      let resolved;
      try {
        resolved = resolveWorkspaceAppRuntime(workspaceDir, appId, {
          store,
          workspaceId: params.workspaceId,
          allocatePorts: true
        });
      } catch (error) {
        app.log.warn(
          { workspaceId: params.workspaceId, appId, error: error instanceof Error ? error.message : String(error) },
          "skipping app refresh after integration binding because app runtime could not be resolved"
        );
        continue;
      }

      if (!appUsesIntegration(resolved.resolvedApp, params.integrationKey)) {
        continue;
      }

      await appLifecycleExecutor.stopApp({
        appId,
        appDir: resolved.appDir,
        workspaceId: params.workspaceId,
        resolvedApp: resolved.resolvedApp
      });
      store.upsertAppBuild({ workspaceId: params.workspaceId, appId, status: "stopped" });
      await ensureAppRunning(params.workspaceId, appId);
    }
  }

  async function stopWorkspaceApplicationsForDeletion(params: {
    workspaceId: string;
    workspaceDir: string;
  }): Promise<void> {
    // Collect all port records BEFORE any cleanup so we can force-kill as a safety net
    // even if the normal stopApp flow fails or in-memory maps are stale.
    const allocatedPorts: number[] = store
      .listAppPorts({ workspaceId: params.workspaceId })
      .map((p) => p.port);

    let entries: Array<Record<string, unknown>> = [];
    try {
      entries = listWorkspaceApplications(params.workspaceDir);
    } catch (error) {
      app.log.debug(
        {
          workspaceId: params.workspaceId,
          error: error instanceof Error ? error.message : String(error)
        },
        "best-effort app listing failed during workspace delete"
      );
    }

    for (const entry of entries) {
      const appId = typeof entry.app_id === "string" ? entry.app_id.trim() : "";
      if (!appId) {
        continue;
      }
      const configPath = typeof entry.config_path === "string" ? entry.config_path.trim() : "";
      const fallbackAppDir = path.join(
        params.workspaceDir,
        configPath ? path.dirname(configPath) : path.join("apps", appId)
      );

      try {
        const resolved = resolveWorkspaceAppRuntime(params.workspaceDir, appId, {
          store,
          workspaceId: params.workspaceId
        });
        await appLifecycleExecutor.stopApp({
          appId,
          appDir: resolved.appDir,
          workspaceId: params.workspaceId,
          resolvedApp: resolved.resolvedApp
        });
      } catch (error) {
        try {
          await appLifecycleExecutor.stopApp({
            appId,
            appDir: fallbackAppDir,
            workspaceId: params.workspaceId
          });
        } catch (fallbackError) {
          app.log.debug(
            {
              workspaceId: params.workspaceId,
              appId,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              original_error: error instanceof Error ? error.message : String(error)
            },
            "best-effort app stop failed during workspace delete"
          );
        }
      } finally {
        releaseWorkspaceAppPorts({ store, workspaceId: params.workspaceId, appId });
        store.deleteAppBuild({ workspaceId: params.workspaceId, appId });
      }
    }

    // Safety net: force-kill any process still listening on the allocated ports.
    // This handles the case where stopApp failed, in-memory maps were stale after
    // a runtime restart, or multiple workspaces had colliding appId keys.
    if (allocatedPorts.length > 0) {
      try {
        await killPortListeners(allocatedPorts);
      } catch {
        app.log.debug(
          { workspaceId: params.workspaceId, ports: allocatedPorts },
          "best-effort port kill during workspace delete"
        );
      }
    }

    for (const appPort of store.listAppPorts({ workspaceId: params.workspaceId })) {
      store.deleteAppPort({ workspaceId: params.workspaceId, appId: appPort.appId });
    }
  }

  function startHealthMonitor(): void {
    if (healthMonitorTimer) {
      return;
    }
    healthMonitorTimer = setInterval(() => {
      void runHealthMonitorCycle();
      // Reconcile orphan processes on a slower cadence (every Nth tick).
      // Doing this on every tick would be wasteful; doing it only at
      // startup means that if a workspace is deleted while the runtime
      // is running and stopWorkspaceApplicationsForDeletion misses a
      // process, we would never clean it up until the next runtime
      // restart.
      orphanCleanupTickCounter += 1;
      if (orphanCleanupTickCounter >= ORPHAN_CLEANUP_EVERY_N_TICKS) {
        orphanCleanupTickCounter = 0;
        void cleanupOrphanAppProcesses(store, app.log).catch((err) => {
          app.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "periodic orphan app process cleanup failed",
          );
        });
      }
    }, HEALTH_MONITOR_INTERVAL_MS);
  }

  // Run orphan cleanup roughly every 10 health-monitor ticks. With the
  // default 30s interval that's once every ~5 minutes — frequent enough
  // to catch leaks while still cheap.
  let orphanCleanupTickCounter = 0;
  const ORPHAN_CLEANUP_EVERY_N_TICKS = 10;

  async function runHealthMonitorCycle(): Promise<void> {
    let workspaces: WorkspaceRecord[];
    try {
      workspaces = store.listWorkspaces({ includeDeleted: false });
    } catch {
      return;
    }
    for (const ws of workspaces) {
      if (ws.status !== "active") {
        continue;
      }
      let entries: Array<Record<string, unknown>>;
      try {
        entries = listWorkspaceApplications(store.workspaceDir(ws.id));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const appId = typeof entry.app_id === "string" ? entry.app_id : "";
        if (!appId) {
          continue;
        }
        const build = store.getAppBuild({ workspaceId: ws.id, appId });
        if (!appBuildHasCompletedSetup(build?.status)) {
          continue;
        }

        let resolved;
        try {
          resolved = resolveWorkspaceAppRuntime(store.workspaceDir(ws.id), appId, {
            store,
            workspaceId: ws.id
          });
        } catch {
          continue;
        }

        let healthy = false;
        try {
          healthy = await isAppHealthy({
            resolvedApp: resolved.resolvedApp,
            httpPort: resolved.ports.http,
            mcpPort: resolved.ports.mcp
          });
        } catch {
          // treat as unhealthy
        }

        const key = `${ws.id}:${appId}`;
        if (healthy) {
          autoRestartAttempts.delete(key);
          // Persistent counter is also reset so the next runtime restart
          // starts from a clean slate when this app is currently healthy.
          if ((build?.restartAttempts ?? 0) > 0) {
            store.setAppBuildRestartAttempts({
              workspaceId: ws.id,
              appId,
              attempts: 0,
            });
          }
          if (build?.status !== "running") {
            store.upsertAppBuild({ workspaceId: ws.id, appId, status: "running" });
          }
          continue;
        }

        // Seed the in-memory counter from the persistent column so that a
        // crash-loop survives runtime restarts and eventually trips the
        // circuit breaker instead of looping forever.
        const persistedAttempts = build?.restartAttempts ?? 0;
        const previousInMemory = autoRestartAttempts.get(key) ?? persistedAttempts;
        const attempts = previousInMemory + 1;
        autoRestartAttempts.set(key, attempts);
        try {
          store.setAppBuildRestartAttempts({
            workspaceId: ws.id,
            appId,
            attempts,
          });
        } catch (err) {
          app.log.debug(
            { workspaceId: ws.id, appId, err: err instanceof Error ? err.message : String(err) },
            "health monitor: failed to persist restart_attempts",
          );
        }
        if (attempts <= MAX_AUTO_RESTART_ATTEMPTS) {
          app.log.info({ workspaceId: ws.id, appId, attempt: attempts }, "health monitor: restarting unhealthy app");
          // Stop the (possibly half-dead) tracked process and free its
          // ports BEFORE asking ensureAppRunning to start a fresh one.
          // Otherwise a zombie listener can keep the port bound and the
          // restart spawn fails immediately. Both calls are best-effort.
          void (async () => {
            try {
              await appLifecycleExecutor.stopApp({
                appId,
                appDir: resolved.appDir,
                workspaceId: ws.id,
                resolvedApp: resolved.resolvedApp,
              });
            } catch (stopErr) {
              app.log.debug(
                {
                  workspaceId: ws.id,
                  appId,
                  err: stopErr instanceof Error ? stopErr.message : String(stopErr),
                },
                "health monitor: best-effort stopApp before restart failed",
              );
            }
            try {
              await killPortListeners([resolved.ports.http, resolved.ports.mcp]);
            } catch {
              // best-effort
            }
            try {
              await ensureAppRunning(ws.id, appId);
            } catch (err) {
              Sentry.captureException(err, {
                extra: { workspaceId: ws.id, appId },
              });
              app.log.error(
                {
                  workspaceId: ws.id,
                  appId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "health monitor: restart failed",
              );
            }
          })();
        } else if (attempts === MAX_AUTO_RESTART_ATTEMPTS + 1) {
          app.log.error({ workspaceId: ws.id, appId, attempts: attempts - 1 }, "health monitor: max restart attempts exceeded");
          Sentry.captureException(new Error(`App ${appId} crashed and failed to recover after ${MAX_AUTO_RESTART_ATTEMPTS} attempts`), {
            extra: { workspaceId: ws.id, appId, attempts: attempts - 1 },
          });
          store.upsertAppBuild({
            workspaceId: ws.id,
            appId,
            status: "failed",
            error: `App crashed and failed to recover after ${MAX_AUTO_RESTART_ATTEMPTS} attempts`
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------

  app.addHook("onClose", async () => {
    if (healthMonitorTimer) {
      clearInterval(healthMonitorTimer);
      healthMonitorTimer = null;
    }
    await terminalSessionManager?.close();
    await recallEmbeddingBackfillWorker?.close();
    await bridgeWorker?.close();
    await mainSessionEventWorker?.close();
    await cronWorker?.close();
    await queueWorker?.close();
    await durableMemoryWorker?.close();
    if (ownsStore) {
      store.close();
    }
  });

  app.addHook("onReady", async () => {
    await terminalSessionManager?.start();
    await durableMemoryWorker?.start();
    await queueWorker?.start();
    await cronWorker?.start();
    await mainSessionEventWorker?.start();
    await bridgeWorker?.start();
    await recallEmbeddingBackfillWorker?.start();
    if (options.enableAppHealthMonitor !== false) {
      startHealthMonitor();
    }

    // Clean up orphan processes from deleted workspaces whose ports were
    // never properly released (e.g. runtime crashed before cleanup finished).
    try {
      await cleanupOrphanAppProcesses(store, app.log);
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, "orphan app process cleanup failed");
    }

    if (options.startAppsOnReady !== false) {
      // Kick app auto-start into the background so the runtime can
      // begin serving /healthz before any workspace app setup/startup
      // work runs. Running this inline inside onReady can delay
      // app.listen() long enough for the desktop bootstrap health check
      // to time out and kill an otherwise healthy runtime.
      setImmediate(() => {
        const workspaces = store.listWorkspaces({ includeDeleted: false });
        for (const ws of workspaces) {
          if (ws.status === "active") {
            void ensureAllAppsRunning(ws.id).catch((err) => {
              app.log.error(
                {
                  workspaceId: ws.id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "auto-start apps on ready failed",
              );
            });
          }
        }
      });
    }
  });


  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/v1/runtime/config", async (request, reply) => {
    void request;
    try {
      return await runtimeConfigService.getConfig();
    } catch (error) {
      if (error instanceof RuntimeConfigServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "runtime config failed");
    }
  });

  app.get("/api/v1/runtime/status", async (request, reply) => {
    void request;
    try {
      return await runtimeConfigService.getStatus();
    } catch (error) {
      if (error instanceof RuntimeConfigServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "runtime status failed");
    }
  });

  app.get("/api/v1/runtime/system-status", async () => {
    return collectSystemStatus(store.workspaceRoot, store);
  });

  app.put("/api/v1/runtime/config", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeConfigService.updateConfig(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof RuntimeConfigServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "runtime config update failed");
    }
  });

  app.get("/api/v1/runtime/profile", async (request, reply) => {
    void reply;
    const query = request.query as Record<string, unknown>;
    const profileId = optionalString(query.profile_id)?.trim() || "default";
    return runtimeUserProfilePayload(store.getRuntimeUserProfile({ profileId }), profileId);
  });

  app.put("/api/v1/runtime/profile", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const body = requiredDict(request.body, "body");
    const profileId = optionalString(body.profile_id)?.trim() || "default";
    const name = nullableString(body.name);
    const nameSource = nullableString(body.name_source);
    if (nameSource != null && !["manual", "agent", "auth_fallback"].includes(nameSource)) {
      return sendError(reply, 400, "name_source must be one of manual, agent, or auth_fallback");
    }
    const record = store.upsertRuntimeUserProfile({
      profileId,
      name: name ?? null,
      nameSource: (nameSource ?? null) as "manual" | "agent" | "auth_fallback" | null,
    });
    return runtimeUserProfilePayload(record);
  });

  app.post("/api/v1/runtime/profile/auth-fallback", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const body = requiredDict(request.body, "body");
    const profileId = optionalString(body.profile_id)?.trim() || "default";
    const name = requiredString(body.name, "name").trim();
    const record = store.applyRuntimeUserProfileAuthFallback({
      profileId,
      name,
    });
    return runtimeUserProfilePayload(record, profileId);
  });

  app.get("/api/v1/capabilities/browser", async (request, reply) => {
    const workspaceId = headerString(request.headers as Record<string, unknown>, "x-holaboss-workspace-id");
    const sessionId = capabilitySessionId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    const space = capabilityBrowserSpace({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    try {
      return await browserToolService.getStatus({ workspaceId, sessionId, space });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser capability status failed");
    }
  });

  app.post("/api/v1/capabilities/browser/tools/:toolId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { toolId: string };
    const toolId = requiredString(params.toolId, "toolId");
    const workspaceId = headerString(request.headers as Record<string, unknown>, "x-holaboss-workspace-id");
    const sessionId = capabilitySessionId({
      headers: request.headers as Record<string, unknown>,
      body: request.body,
    });
    const space = capabilityBrowserSpace({
      headers: request.headers as Record<string, unknown>,
      body: request.body,
    });
    const inputId =
      workspaceId && sessionId
        ? resolveOutputInputId({
            store,
            workspaceId,
            sessionId,
            inputId:
              headerString(request.headers as Record<string, unknown>, "x-holaboss-input-id") ||
              nullableString(request.body.input_id),
          })
        : null;
    try {
      const result = await browserToolService.execute(
        toolId,
        request.body,
        { workspaceId, sessionId, inputId, space },
      );
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId,
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser tool execution failed");
    }
  });

  app.get("/api/v1/terminal-sessions", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    try {
      return terminalSessionManager?.listSessions({
        workspaceId: optionalString(query.workspace_id),
        sessionId: optionalString(query.session_id),
        statuses: optionalString(query.status)
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) as TerminalSessionStatus[] | undefined,
      }) ?? [];
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session listing failed");
    }
  });

  app.post("/api/v1/terminal-sessions", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await terminalSessionManager?.createSession({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId: capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }) || null,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }) || null,
        title: nullableString(request.body.title),
        owner: optionalString(request.body.owner) === "user" ? "user" : "agent",
        cwd: nullableString(request.body.cwd),
        command: requiredString(request.body.command, "command"),
        cols: optionalInteger(request.body.cols, DEFAULT_TERMINAL_COLS),
        rows: optionalInteger(request.body.rows, DEFAULT_TERMINAL_ROWS),
        createdBy: nullableString(request.body.created_by),
        metadata: optionalDict(request.body.metadata) ?? {},
      });
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session creation failed");
    }
  });

  app.get("/api/v1/terminal-sessions/:terminalId", async (request, reply) => {
    const params = request.params as { terminalId: string };
    const query = isRecord(request.query) ? request.query : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        query,
      });
      const session = terminalSessionManager?.getSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId,
      });
      if (!session) {
        return sendError(reply, 404, "terminal session not found");
      }
      return session;
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session lookup failed");
    }
  });

  app.get("/api/v1/terminal-sessions/:terminalId/events", async (request, reply) => {
    const params = request.params as { terminalId: string };
    const query = isRecord(request.query) ? request.query : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        query,
      });
      return {
        terminal:
          terminalSessionManager?.getSession({
            terminalId: requiredString(params.terminalId, "terminalId"),
            workspaceId,
          }) ?? null,
        events:
          terminalSessionManager?.listEvents({
            workspaceId,
            terminalId: requiredString(params.terminalId, "terminalId"),
            afterSequence: optionalInteger(query.after_sequence, 0),
            limit: optionalInteger(query.limit, 0) || undefined,
          }) ?? [],
      };
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session event listing failed");
    }
  });

  app.post("/api/v1/terminal-sessions/:terminalId/input", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await terminalSessionManager?.sendInput({
        workspaceId,
        terminalId: requiredString(params.terminalId, "terminalId"),
        data: requiredString(request.body.data, "data"),
      });
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session input failed");
    }
  });

  app.post("/api/v1/terminal-sessions/:terminalId/resize", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await terminalSessionManager?.resize({
        workspaceId,
        terminalId: requiredString(params.terminalId, "terminalId"),
        cols: optionalInteger(request.body.cols, DEFAULT_TERMINAL_COLS),
        rows: optionalInteger(request.body.rows, DEFAULT_TERMINAL_ROWS),
      });
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session resize failed");
    }
  });

  app.post("/api/v1/terminal-sessions/:terminalId/signal", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await terminalSessionManager?.signal({
        workspaceId,
        terminalId: requiredString(params.terminalId, "terminalId"),
        signal: nullableString(request.body.signal),
      });
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session signal failed");
    }
  });

  app.post("/api/v1/terminal-sessions/:terminalId/close", async (request, reply) => {
    const params = request.params as { terminalId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: isRecord(request.body) ? request.body : null,
      });
      return await terminalSessionManager?.closeSession({
        workspaceId,
        terminalId: requiredString(params.terminalId, "terminalId"),
      });
    } catch (error) {
      if (error instanceof TerminalSessionManagerError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "terminal session close failed");
    }
  });

  app.register(async function terminalSessionWebsocketRoutes(fastify) {
    fastify.route({
      method: "GET",
      url: "/api/v1/terminal-sessions/:terminalId/stream",
      handler: async (_request, reply) => {
        reply.code(426).send({
          error: "Upgrade Required",
          message: "terminal session stream requires a websocket upgrade",
        });
      },
      wsHandler: (socket, request) => {
        const params = request.params as { terminalId: string };
        const query = isRecord(request.query) ? request.query : {};
        try {
          const workspaceId = requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query,
          });
          const terminal = requireTerminalSession({
            manager: terminalSessionManager,
            terminalId: requiredString(params.terminalId, "terminalId"),
            workspaceId,
          });
          const afterSequence = optionalInteger(query.after_sequence, 0);
          const snapshotSequence = terminal.lastEventSeq;
          socket.send(JSON.stringify({ type: "connected", terminal }));
          const replayEvents = (terminalSessionManager?.listEvents({
            workspaceId: terminal.workspaceId,
            terminalId: terminal.terminalId,
            afterSequence,
          }) ?? []).filter((event) => event.sequence <= snapshotSequence);
          for (const event of replayEvents) {
            socket.send(JSON.stringify({ type: "event", event }));
          }
          const unsubscribe =
            terminalSessionManager?.subscribe(terminal.terminalId, (event) => {
              if (event.sequence <= snapshotSequence) {
                return;
              }
              socket.send(JSON.stringify({ type: "event", event }));
            }) ?? (() => {});
          socket.on("close", () => {
            unsubscribe();
          });
          socket.on("error", () => {
            unsubscribe();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "terminal session stream failed";
          socket.send(JSON.stringify({ type: "error", error: message }));
          socket.close();
        }
      },
    });
  });

  app.get("/api/v1/integrations/catalog", async () => {
    return integrationService.getCatalog();
  });

  app.get("/api/v1/integrations/connections", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    try {
      return integrationService.listConnections({
        providerId: optionalString(query.provider_id),
        ownerUserId: optionalString(query.owner_user_id)
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "integration connections failed");
    }
  });

  app.post("/api/v1/integrations/connections", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const ownerCheck = resolveOwnerUserId(request.body.owner_user_id);
    if (!ownerCheck.ok) {
      return sendError(reply, 403, ownerCheck.error);
    }
    try {
      return integrationService.createConnection({
        providerId: typeof request.body.provider_id === "string" ? request.body.provider_id : "",
        ownerUserId: ownerCheck.userId,
        accountLabel: typeof request.body.account_label === "string" ? request.body.account_label : "",
        authMode: typeof request.body.auth_mode === "string" ? request.body.auth_mode : "manual_token",
        grantedScopes: Array.isArray(request.body.granted_scopes) ? request.body.granted_scopes : [],
        secretRef: typeof request.body.secret_ref === "string" ? request.body.secret_ref : undefined,
        accountExternalId: typeof request.body.account_external_id === "string" ? request.body.account_external_id : undefined
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection creation failed");
    }
  });

  app.patch("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = request.params as { connectionId: string };
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    // For identity fields we distinguish "not provided" (preserve) from
    // "null" (clear) — only forward when the key is explicitly present.
    const body = request.body as Record<string, unknown>;
    const accountHandlePresent = Object.prototype.hasOwnProperty.call(body, "account_handle");
    const accountEmailPresent = Object.prototype.hasOwnProperty.call(body, "account_email");
    const normalizeIdentity = (value: unknown): string | null => {
      if (value === null) return null;
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    };
    try {
      return integrationService.updateConnection(params.connectionId, {
        status: typeof body.status === "string" ? body.status : undefined,
        secretRef: typeof body.secret_ref === "string" ? body.secret_ref : undefined,
        accountLabel: typeof body.account_label === "string" ? body.account_label : undefined,
        grantedScopes: Array.isArray(body.granted_scopes) ? body.granted_scopes : undefined,
        ...(accountHandlePresent ? { accountHandle: normalizeIdentity(body.account_handle) } : {}),
        ...(accountEmailPresent ? { accountEmail: normalizeIdentity(body.account_email) } : {})
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection update failed");
    }
  });

  app.post("/api/v1/integrations/connections/:connectionId/merge", async (request, reply) => {
    const params = request.params as { connectionId: string };
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const removeIds = Array.isArray(request.body.remove_connection_ids)
      ? (request.body.remove_connection_ids.filter(
          (id): id is string => typeof id === "string"
        ) as string[])
      : [];
    if (removeIds.length === 0) {
      return sendError(reply, 400, "remove_connection_ids is required");
    }
    try {
      return integrationService.mergeConnections({
        keepConnectionId: params.connectionId,
        removeConnectionIds: removeIds
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection merge failed");
    }
  });

  app.delete("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = request.params as { connectionId: string };
    try {
      return integrationService.deleteConnection(params.connectionId);
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection deletion failed");
    }
  });

  app.get("/api/v1/integrations/bindings", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    try {
      return integrationService.listBindings({
        workspaceId
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "integration bindings failed");
    }
  });

  app.put("/api/v1/integrations/bindings/:workspaceId/:targetType/:targetId/:integrationKey", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as {
      workspaceId: string;
      targetType: string;
      targetId: string;
      integrationKey: string;
    };
    const connectionId = optionalString((request.body as Record<string, unknown>).connection_id);
    if (!connectionId) {
      return sendError(reply, 400, "connection_id is required");
    }
    try {
      const binding = integrationService.upsertBinding({
        workspaceId: requiredString(params.workspaceId, "workspaceId"),
        targetType: requiredString(params.targetType, "targetType"),
        targetId: requiredString(params.targetId, "targetId"),
        integrationKey: requiredString(params.integrationKey, "integrationKey"),
        connectionId,
        isDefault: optionalBoolean((request.body as Record<string, unknown>).is_default, false)
      });
      await refreshAppsForIntegrationBinding({
        workspaceId: binding.workspace_id,
        integrationKey: binding.integration_key,
        targetType: binding.target_type,
        targetId: binding.target_id
      });
      return binding;
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "integration binding save failed");
    }
  });

  app.delete("/api/v1/integrations/bindings/:bindingId", async (request, reply) => {
    const params = request.params as { bindingId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const bindingId = optionalString(params.bindingId);
    if (!bindingId) {
      return sendError(reply, 400, "bindingId is required");
    }
    try {
      return integrationService.deleteBinding(bindingId, workspaceId);
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "integration binding delete failed");
    }
  });

  app.get("/api/v1/integrations/readiness", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    const appId = optionalString(query.app_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    if (!appId) {
      return sendError(reply, 400, "app_id is required");
    }
    try {
      return integrationService.checkReadiness({ workspaceId, appId });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "integration readiness check failed");
    }
  });

  app.post("/api/v1/integrations/broker/token", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const grant = typeof request.body.grant === "string" ? request.body.grant : "";
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    if (!grant || !provider) {
      return sendError(reply, 400, "grant and provider are required");
    }
    try {
      return await brokerService.exchangeToken({ grant, provider });
    } catch (error) {
      if (error instanceof BrokerError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "broker token exchange failed");
    }
  });

  app.post("/api/v1/integrations/broker/proxy", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const grant = typeof request.body.grant === "string" ? request.body.grant : "";
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    const req = isRecord(request.body.request) ? request.body.request : null;
    if (!grant || !provider || !req) {
      return sendError(reply, 400, "grant, provider, and request are required");
    }
    const method = typeof req.method === "string" ? req.method : "GET";
    const endpoint = typeof req.endpoint === "string" ? req.endpoint : "";
    if (!endpoint) {
      return sendError(reply, 400, "request.endpoint is required");
    }
    try {
      return await brokerService.proxyProviderRequest({
        grant,
        provider,
        request: {
          method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          endpoint,
          body: req.body
        }
      });
    } catch (error) {
      if (error instanceof BrokerError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "broker proxy failed");
    }
  });
  app.get("/api/v1/integrations/oauth/configs", async () => {
    return { configs: store.listOAuthAppConfigs().map((c) => ({
      provider_id: c.providerId, client_id: c.clientId,
      client_secret: "••••••••",
      authorize_url: c.authorizeUrl, token_url: c.tokenUrl,
      scopes: c.scopes, redirect_port: c.redirectPort,
      created_at: c.createdAt, updated_at: c.updatedAt
    })) };
  });

  app.put("/api/v1/integrations/oauth/configs/:providerId", async (request, reply) => {
    const params = request.params as { providerId: string };
    if (!isRecord(request.body)) return sendError(reply, 400, "body required");
    try {
      const record = store.upsertOAuthAppConfig({
        providerId: params.providerId,
        clientId: typeof request.body.client_id === "string" ? request.body.client_id : "",
        clientSecret: typeof request.body.client_secret === "string" ? request.body.client_secret : "",
        authorizeUrl: typeof request.body.authorize_url === "string" ? request.body.authorize_url : "",
        tokenUrl: typeof request.body.token_url === "string" ? request.body.token_url : "",
        scopes: Array.isArray(request.body.scopes) ? request.body.scopes : [],
        redirectPort: typeof request.body.redirect_port === "number" ? request.body.redirect_port : undefined
      });
      return {
        provider_id: record.providerId, client_id: record.clientId,
        client_secret: "••••••••",
        authorize_url: record.authorizeUrl, token_url: record.tokenUrl,
        scopes: record.scopes, redirect_port: record.redirectPort,
        created_at: record.createdAt, updated_at: record.updatedAt
      };
    } catch (error) {
      return sendError(reply, 500, error instanceof Error ? error.message : "config save failed");
    }
  });

  app.delete("/api/v1/integrations/oauth/configs/:providerId", async (request, reply) => {
    const params = request.params as { providerId: string };
    if (!store.deleteOAuthAppConfig(params.providerId)) return sendError(reply, 404, "config not found");
    return { deleted: true };
  });

  app.post("/api/v1/integrations/oauth/authorize", async (request, reply) => {
    if (!isRecord(request.body)) return sendError(reply, 400, "body required");
    const providerId = typeof request.body.provider === "string" ? request.body.provider : "";
    const ownerUserId = typeof request.body.owner_user_id === "string" ? request.body.owner_user_id : "local";
    if (!providerId) return sendError(reply, 400, "provider is required");
    try {
      return await oauthService.startFlow(providerId, ownerUserId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "OAuth flow failed");
    }
  });

  // ---- Composio local connection creation (connect + account status handled by Hono server) ----

  app.post("/api/v1/integrations/composio/finalize", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const connectedAccountId = typeof request.body.connected_account_id === "string" ? request.body.connected_account_id : "";
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    const ownerCheck = resolveOwnerUserId(request.body.owner_user_id);
    if (!ownerCheck.ok) {
      return sendError(reply, 403, ownerCheck.error);
    }
    const ownerUserId = ownerCheck.userId;
    const accountLabel = typeof request.body.account_label === "string" ? request.body.account_label : "";
    // Provider-side identity from whoami, resolved by the caller before
    // finalize. Used by createConnection() to dedupe re-auth flows: each
    // Composio re-auth mints a new connected_account_id, but the underlying
    // identity (Twitter handle, Gmail address) stays stable, so the service
    // looks for an existing active connection on this (provider, owner,
    // identity) tuple and refreshes it in place rather than spawning a
    // duplicate row.
    const accountHandle =
      typeof request.body.account_handle === "string" && request.body.account_handle.trim().length > 0
        ? request.body.account_handle.trim()
        : null;
    const accountEmail =
      typeof request.body.account_email === "string" && request.body.account_email.trim().length > 0
        ? request.body.account_email.trim()
        : null;
    // Optional: when the caller is in a workspace context (desktop's Settings →
    // Integrations is global, but the per-app binding selector or the older
    // workspace-scoped flow may want to atomically bind this fresh account to
    // a workspace), accept workspace_id and create a default workspace binding
    // alongside the connection. The connection itself is always user-global.
    const workspaceId =
      typeof request.body.workspace_id === "string" && request.body.workspace_id.trim().length > 0
        ? request.body.workspace_id.trim()
        : null;
    if (!connectedAccountId || !provider) {
      return sendError(reply, 400, "connected_account_id and provider are required");
    }
    try {
      const label = accountLabel || `${provider} (Managed)`;
      const connection = integrationService.createConnection({
        providerId: provider,
        ownerUserId,
        accountLabel: label,
        authMode: "composio",
        grantedScopes: [],
        accountExternalId: connectedAccountId,
        accountHandle,
        accountEmail
      });
      if (workspaceId) {
        integrationService.upsertBinding({
          workspaceId,
          targetType: "workspace",
          targetId: "default",
          integrationKey: provider,
          connectionId: connection.connection_id,
          isDefault: true
        });
      }
      return connection;
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 502, error instanceof Error ? error.message : "composio finalize failed");
    }
  });
  // ---- Runtime Agent Tools (onboarding, cronjobs, media) ----

  app.get("/api/v1/capabilities/runtime-tools", async (request) => {
    const workspaceId = capabilityWorkspaceId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null
    });
    return runtimeAgentToolsService.capabilityStatus({ workspaceId });
  });

  app.get("/api/v1/capabilities/runtime-tools/onboarding/status", async (request, reply) => {
    try {
      return runtimeAgentToolsService.onboardingStatus(
        requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null
        })
      );
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime onboarding status failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/onboarding/complete", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return runtimeAgentToolsService.completeOnboarding({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body
        }),
        summary: requiredString(request.body.summary, "summary"),
        requestedBy: optionalString(request.body.requested_by)
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime onboarding completion failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/cronjobs", async (request, reply) => {
    try {
      return runtimeAgentToolsService.listCronjobs({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null
        }),
        enabledOnly: optionalBoolean(isRecord(request.query) ? request.query.enabled_only : undefined, false)
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob list failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/cronjobs", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return runtimeAgentToolsService.createCronjob({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body
        }),
        sessionId: capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          body: request.body
        }),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body
        }),
        initiatedBy: optionalString(request.body.initiated_by),
        name: optionalString(request.body.name),
        cron: requiredString(request.body.cron, "cron"),
        description: requiredString(request.body.description, "description"),
        instruction: nullableString(request.body.instruction) ?? undefined,
        enabled: optionalBoolean(request.body.enabled, true),
        delivery: optionalCronjobDeliveryInput(request.body.delivery),
        metadata: optionalDict(request.body.metadata) ?? undefined
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob create failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/cronjobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    try {
      const payload = runtimeAgentToolsService.getCronjob({
        jobId: requiredString(params.jobId, "jobId"),
        workspaceId: capabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null
        })
      });
      if (!payload) {
        return sendError(reply, 404, "cronjob not found");
      }
      return payload;
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob fetch failed");
    }
  });

  app.patch("/api/v1/capabilities/runtime-tools/cronjobs/:jobId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { jobId: string };
    try {
      return runtimeAgentToolsService.updateCronjob({
        jobId: requiredString(params.jobId, "jobId"),
        workspaceId: capabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
          body: request.body
        }),
        name: hasOwn(request.body, "name") ? nullableString(request.body.name) : undefined,
        cron: hasOwn(request.body, "cron") ? nullableString(request.body.cron) : undefined,
        description: hasOwn(request.body, "description") ? nullableString(request.body.description) : undefined,
        instruction: hasOwn(request.body, "instruction") ? nullableString(request.body.instruction) : undefined,
        enabled: hasOwn(request.body, "enabled") ? optionalBoolean(request.body.enabled, false) : undefined,
        delivery: hasOwn(request.body, "delivery") ? optionalCronjobDeliveryInput(request.body.delivery) ?? null : undefined,
        metadata: hasOwn(request.body, "metadata") ? (optionalDict(request.body.metadata) ?? {}) : undefined
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob update failed");
    }
  });

  app.delete("/api/v1/capabilities/runtime-tools/cronjobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    try {
      return runtimeAgentToolsService.deleteCronjob({
        jobId: requiredString(params.jobId, "jobId"),
        workspaceId: capabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null
        })
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob delete failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/subagents", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      if (!sessionId) {
        return sendError(reply, 400, "session_id is required");
      }
      const payload = runtimeAgentToolsService.delegateTask({
        workspaceId,
        sessionId,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        tasks: requiredDelegateTaskInputs(request.body),
      });
      return payload;
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime delegate task failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/background-tasks", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: query,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: query,
      });
      return runtimeAgentToolsService.listBackgroundTasks({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: query,
        }) || undefined,
        ownerMainSessionId: nullableString(query.owner_main_session_id) ?? undefined,
        statuses: optionalStringList(query.statuses),
        limit: hasOwn(query, "limit") ? optionalInteger(query.limit, 200) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime list background tasks failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/subagents/:subagentId", async (request, reply) => {
    const params = request.params as { subagentId: string };
    const query = isRecord(request.query) ? request.query : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: query,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: query,
      });
      return runtimeAgentToolsService.getBackgroundTask({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: query,
        }) || undefined,
        subagentId: requiredString(params.subagentId, "subagentId"),
        ownerMainSessionId: nullableString(query.owner_main_session_id) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime get subagent failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/subagents/:subagentId/cancel", async (request, reply) => {
    const params = request.params as { subagentId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: isRecord(request.body) ? request.body : null,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: isRecord(request.body) ? request.body : null,
      });
      if (!sessionId) {
        return sendError(reply, 400, "session_id is required");
      }
      return await runtimeAgentToolsService.cancelSubagent({
        workspaceId,
        sessionId,
        subagentId: requiredString(params.subagentId, "subagentId"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cancel subagent failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/subagents/:subagentId/resume", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { subagentId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      if (!sessionId) {
        return sendError(reply, 400, "session_id is required");
      }
      return runtimeAgentToolsService.resumeSubagent({
        workspaceId,
        sessionId,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        subagentId: requiredString(params.subagentId, "subagentId"),
        answer: requiredString(request.body.answer, "answer"),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        model: nullableString(request.body.model) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime resume subagent failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/subagents/:subagentId/continue", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { subagentId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      if (!sessionId) {
        return sendError(reply, 400, "session_id is required");
      }
      return runtimeAgentToolsService.continueSubagent({
        workspaceId,
        sessionId,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        subagentId: requiredString(params.subagentId, "subagentId"),
        instruction: requiredString(request.body.instruction, "instruction"),
        title: nullableString(request.body.title) ?? undefined,
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        model: nullableString(request.body.model) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime continue subagent failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/images/generate", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.generateImage({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId: capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        prompt: requiredString(request.body.prompt, "prompt"),
        filename: nullableString(request.body.filename) ?? undefined,
        size: nullableString(request.body.size) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime image generation failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/downloads", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.downloadUrl({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        url: requiredString(request.body.url, "url"),
        outputPath: nullableString(request.body.output_path) ?? undefined,
        expectedMimePrefix: nullableString(request.body.expected_mime_prefix) ?? undefined,
        overwrite: hasOwn(request.body, "overwrite")
          ? optionalBoolean(request.body.overwrite, false)
          : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime download failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/reports", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await runtimeAgentToolsService.writeReport({
        workspaceId,
        sessionId: sessionId || null,
        inputId: resolveOutputInputId({
          store,
          workspaceId,
          sessionId,
          inputId:
            capabilityInputId({
              headers: request.headers as Record<string, unknown>,
              body: request.body,
            }) || null,
        }),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        title: nullableString(request.body.title) ?? undefined,
        filename: nullableString(request.body.filename) ?? undefined,
        summary: nullableString(request.body.summary) ?? undefined,
        content: requiredString(request.body.content, "content"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime report write failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/web-search", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const workspaceId = capabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const result = await runtimeAgentToolsService.searchWeb({
        query: requiredString(request.body.query, "query"),
        numResults: hasOwn(request.body, "num_results")
          ? optionalInteger(request.body.num_results, 0) || null
          : undefined,
        maxResults: hasOwn(request.body, "max_results")
          ? optionalInteger(request.body.max_results, 0) || null
          : undefined,
        livecrawl: nullableString(request.body.livecrawl) ?? undefined,
        type: nullableString(request.body.type) ?? undefined,
        contextMaxCharacters: hasOwn(request.body, "context_max_characters")
          ? optionalInteger(request.body.context_max_characters, 0) || null
          : undefined,
        textOffset: hasOwn(request.body, "text_offset")
          ? optionalInteger(request.body.text_offset, 0) || null
          : undefined,
        textLimit: hasOwn(request.body, "text_limit")
          ? optionalInteger(request.body.text_limit, 0) || null
          : undefined,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "web_search",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime web search failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/skill", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const result = runtimeAgentToolsService.invokeSkill({
        workspaceId,
        requestedName: requiredString(request.body.name, "name"),
        args: nullableString(request.body.args) ?? undefined,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "skill",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime skill invocation failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/todo", async (request, reply) => {
    try {
      return await runtimeAgentToolsService.readTodo({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }),
        sessionId:
          capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : null,
          }) ?? "",
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime todo read failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/todo/status", async (request, reply) => {
    try {
      return await runtimeAgentToolsService.readTodoStatus({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }),
        sessionId:
          capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : null,
          }) ?? "",
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime todo status failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/todo", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.writeTodo({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId:
          capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body: request.body,
          }) ?? "",
        toolParams: request.body,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime todo write failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/todo/block", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.blockTodo({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId:
          capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body: request.body,
          }) ?? "",
        detail: requiredString(request.body.detail, "detail"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime todo block failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/scratchpad", async (request, reply) => {
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        query: isRecord(request.query) ? request.query : null,
      });
      const sessionId =
        capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }) ?? "";
      const result = await runtimeAgentToolsService.readScratchpad({
        workspaceId,
        sessionId,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "holaboss_scratchpad_read",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime scratchpad read failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/scratchpad", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.writeScratchpad({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId:
          capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body: request.body,
          }) ?? "",
        op: requiredString(request.body.op, "op") as "append" | "replace" | "clear",
        content: hasOwn(request.body, "content") ? nullableString(request.body.content) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime scratchpad write failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/workspace-instructions", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId =
        capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }) ?? "";
      const result = await runtimeAgentToolsService.updateWorkspaceInstructions({
        workspaceId,
        op: requiredString(request.body.op, "op") as
          | "read_current"
          | "append_rule"
          | "remove_rule"
          | "replace_managed_section",
        rule: hasOwn(request.body, "rule") ? nullableString(request.body.rule) : undefined,
        content: hasOwn(request.body, "content") ? nullableString(request.body.content) : undefined,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "holaboss_update_workspace_instructions",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "workspace instructions update failed",
      );
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/terminal-sessions", async (request, reply) => {
    try {
      return runtimeAgentToolsService.listTerminalSessions({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }),
        sessionId: capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session list failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.startTerminalSession({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        sessionId: capabilitySessionId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        title: nullableString(request.body.title) ?? undefined,
        cwd: nullableString(request.body.cwd) ?? undefined,
        command: requiredString(request.body.command, "command"),
        cols: hasOwn(request.body, "cols") ? optionalInteger(request.body.cols, DEFAULT_TERMINAL_COLS) : undefined,
        rows: hasOwn(request.body, "rows") ? optionalInteger(request.body.rows, DEFAULT_TERMINAL_ROWS) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session start failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId", async (request, reply) => {
    const params = request.params as { terminalId: string };
    try {
      return runtimeAgentToolsService.getTerminalSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null,
        }),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session fetch failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/read", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      const requiredWorkspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const result = runtimeAgentToolsService.readTerminalSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId: requiredWorkspaceId,
        afterSequence: hasOwn(request.body, "after_sequence")
          ? optionalInteger(request.body.after_sequence, 0)
          : undefined,
        limit: hasOwn(request.body, "limit")
          ? optionalInteger(request.body.limit, 200)
          : undefined,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "terminal_session_read",
        payload: result,
        workspaceId: requiredWorkspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session read failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/wait", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const result = await runtimeAgentToolsService.waitTerminalSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId,
        afterSequence: hasOwn(request.body, "after_sequence")
          ? optionalInteger(request.body.after_sequence, 0)
          : undefined,
        limit: hasOwn(request.body, "limit")
          ? optionalInteger(request.body.limit, 200)
          : undefined,
        timeoutMs: hasOwn(request.body, "timeout_ms")
          ? optionalInteger(request.body.timeout_ms, 15000)
          : undefined,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "terminal_session_wait",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session wait failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/input", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      return await runtimeAgentToolsService.sendTerminalSessionInput({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        data: requiredString(request.body.data, "data"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session input failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/signal", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { terminalId: string };
    try {
      return await runtimeAgentToolsService.signalTerminalSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        signal: nullableString(request.body.signal) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session signal failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/close", async (request, reply) => {
    const params = request.params as { terminalId: string };
    try {
      return await runtimeAgentToolsService.closeTerminalSession({
        terminalId: requiredString(params.terminalId, "terminalId"),
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: isRecord(request.body) ? request.body : null,
        }),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime terminal session close failed");
    }
  });

  app.get("/api/v1/background-tasks", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    try {
      return runtimeAgentToolsService.listBackgroundTasks({
        workspaceId: requiredString(query.workspace_id, "workspace_id"),
        ownerMainSessionId:
          nullableString(query.owner_main_session_id) ?? undefined,
        statuses: optionalStringList(query.statuses),
        limit: hasOwn(query, "limit")
          ? optionalInteger(query.limit, 200)
          : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "background task list failed",
      );
    }
  });

  app.get("/api/v1/background-tasks/:subagentId", async (request, reply) => {
    const params = request.params as { subagentId: string };
    const query = isRecord(request.query) ? request.query : {};
    try {
      return runtimeAgentToolsService.getBackgroundTask({
        workspaceId: requiredString(query.workspace_id, "workspace_id"),
        subagentId: requiredString(params.subagentId, "subagentId"),
        ownerMainSessionId:
          nullableString(query.owner_main_session_id) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "background task fetch failed",
      );
    }
  });

  app.post(
    "/api/v1/background-tasks/:subagentId/archive",
    async (request, reply) => {
      const params = request.params as { subagentId: string };
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        return runtimeAgentToolsService.archiveBackgroundTask({
          workspaceId: requiredString(request.body.workspace_id, "workspace_id"),
          subagentId: requiredString(params.subagentId, "subagentId"),
          ownerMainSessionId:
            nullableString(request.body.owner_main_session_id) ?? undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error
            ? error.message
            : "background task archive failed",
        );
      }
    },
  );

  app.get(
    "/api/v1/capabilities/runtime-tools/data-tables",
    async (request, reply) => {
      try {
        const query = isRecord(request.query) ? request.query : null;
        const includeSystem =
          query && typeof query.include_system === "string"
            ? query.include_system === "true" || query.include_system === "1"
            : false;
        return runtimeAgentToolsService.listDataTables({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query,
          }),
          includeSystem,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "list_data_tables failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/data-tables",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return runtimeAgentToolsService.createDataTable({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          name: requiredString(body.name, "name"),
          columns: Array.isArray(body.columns)
            ? (body.columns as unknown[] as RuntimeAgentToolsCreateDataTableParams["columns"])
            : [],
          rows: Array.isArray(body.rows)
            ? (body.rows as unknown[] as RuntimeAgentToolsCreateDataTableParams["rows"])
            : [],
          replaceExisting: body.replace_existing === true,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "create_data_table failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/dashboards",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return await runtimeAgentToolsService.createDashboard({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          name: requiredString(body.name, "name"),
          title: requiredString(body.title, "title"),
          description: nullableString(body.description) ?? undefined,
          panels: Array.isArray(body.panels)
            ? (body.panels as unknown[] as RuntimeAgentToolsCreateDashboardParams["panels"])
            : [],
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "create_dashboard failed",
        );
      }
    },
  );

  app.post("/api/v1/lifecycle/shutdown", async (request, reply) => {
    void request;
    try {
      const targets = store
        .listWorkspaces()
        .flatMap((workspace: WorkspaceRecord) => listWorkspaceComposeShutdownTargets(store.workspaceDir(workspace.id)));
      return await appLifecycleExecutor.shutdownAll({ targets });
    } catch (error) {
      if (error instanceof AppLifecycleExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "lifecycle shutdown failed");
    }
  });

  app.post("/api/v1/internal/workspaces/:workspaceId/resolved-apps/start", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string };
    try {
      return await startResolvedApplications({
        store,
        appLifecycleExecutor,
        workspaceId: requiredString(params.workspaceId, "workspaceId"),
        body: request.body
      });
    } catch (error) {
      if (error instanceof AppLifecycleExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "resolved app startup failed");
    }
  });

  app.post("/api/v1/memory/search", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await memoryService.search(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "memory search failed");
    }
  });

  app.post("/api/v1/memory/get", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await memoryService.get(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "memory get failed");
    }
  });

  app.post("/api/v1/memory/upsert", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await memoryService.upsert(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "memory upsert failed");
    }
  });

  app.post("/api/v1/memory/status", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await memoryService.status(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "memory status failed");
    }
  });

  app.post("/api/v1/memory/sync", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await memoryService.sync(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "memory sync failed");
    }
  });

  app.post("/api/v1/proactive/context/capture", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    let workspaceId = "";
    try {
      workspaceId = requiredString(request.body.workspace_id, "workspace_id");
      return {
        context: await captureWorkspaceContext({
          store,
          memoryService,
          workspaceId,
        }),
      };
    } catch (error) {
      if (workspaceId) {
        const message = error instanceof Error ? error.message : "workspace context capture failed";
        const statusCode = /\bnot found\b/i.test(message) ? 404 : 500;
        return sendError(reply, statusCode, message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "workspace_id is required");
    }
  });

  app.post("/api/v1/agent-runs", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runnerExecutor.run(requiredDict(request.body, "body"));
    } catch (error) {
      if (error instanceof RunnerExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "agent run failed");
    }
  });

  app.post("/api/v1/agent-runs/stream", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const stream = await runnerExecutor.stream(requiredDict(request.body, "body"));
      reply.header("Cache-Control", "no-cache");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.type("text/event-stream");
      return reply.send(stream);
    } catch (error) {
      if (error instanceof RunnerExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "agent run stream failed");
    }
  });

  function startBackgroundTask(task: Promise<void>): void {
    backgroundTasks.add(task);
    void task.finally(() => {
      backgroundTasks.delete(task);
    });
  }

  function queueAppSetup(params: {
    workspaceDir: string;
    workspaceId: string;
    appId: string;
    setupCommand: string;
  }): { status: "setup_started"; detail: string } {
    const taskKey = `${params.workspaceId}:${params.appId}`;
    const existingTask = appSetupTasks.get(taskKey);
    if (existingTask) {
      return {
        status: "setup_started",
        detail: "Setup already in progress"
      };
    }

    const build = store.getAppBuild({
      workspaceId: params.workspaceId,
      appId: params.appId
    });
    if (build?.status === "completed") {
      return {
        status: "setup_started",
        detail: "Setup already completed"
      };
    }

    const task = runAppSetup({
      store,
      workspaceDir: params.workspaceDir,
      workspaceId: params.workspaceId,
      appId: params.appId,
      setupCommand: params.setupCommand
    }).finally(() => {
      appSetupTasks.delete(taskKey);
    });
    appSetupTasks.set(taskKey, task);
    startBackgroundTask(task);
    return {
      status: "setup_started",
      detail: `Running: ${params.setupCommand}`
    };
  }

  app.post("/api/v1/workspaces", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }

    try {
      const created = store.createWorkspace({
        workspaceId: optionalString(request.body.workspace_id),
        name: requiredString(request.body.name, "name"),
        harness: requiredString(request.body.harness, "harness"),
        status: optionalString(request.body.status) ?? "provisioning",
        onboardingStatus: optionalString(request.body.onboarding_status) ?? "not_required",
        onboardingSessionId: nullableString(request.body.onboarding_session_id) ?? null,
        errorMessage: nullableString(request.body.error_message) ?? null,
        workspacePath: optionalString(request.body.workspace_path)
      });

      let workspace = created;
      if (
        hasOwn(request.body, "onboarding_completed_at") ||
        hasOwn(request.body, "onboarding_completion_summary") ||
        hasOwn(request.body, "onboarding_requested_at") ||
        hasOwn(request.body, "onboarding_requested_by")
      ) {
        const updateFields: Record<string, string | null | undefined> = {};
        if (hasOwn(request.body, "onboarding_completed_at")) {
          updateFields.onboardingCompletedAt = nullableString(request.body.onboarding_completed_at);
        }
        if (hasOwn(request.body, "onboarding_completion_summary")) {
          updateFields.onboardingCompletionSummary = nullableString(request.body.onboarding_completion_summary);
        }
        if (hasOwn(request.body, "onboarding_requested_at")) {
          updateFields.onboardingRequestedAt = nullableString(request.body.onboarding_requested_at);
        }
        if (hasOwn(request.body, "onboarding_requested_by")) {
          updateFields.onboardingRequestedBy = nullableString(request.body.onboarding_requested_by);
        }
        workspace = store.updateWorkspace(created.id, {
          ...updateFields
        });
      }

      return reply.send({
        workspace: workspaceRecordPayload(
          workspace,
          resolveWorkspacePathForPayload(store, workspace.id),
          resolveWorkspaceFolderStateForPayload(store, workspace.id)
        )
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "failed to create workspace");
    }
  });

  app.get("/api/v1/workspaces", async (request) => {
    const query = isRecord(request.query) ? request.query : {};
    const status = optionalString(query.status);
    const includeDeleted = optionalBoolean(query.include_deleted, false);
    const limit = Math.max(1, optionalInteger(query.limit, 50));
    const offset = Math.max(0, optionalInteger(query.offset, 0));

    let items = store.listWorkspaces({ includeDeleted });
    if (status) {
      items = items.filter((item: WorkspaceRecord) => item.status === status);
    }

    const paged = items.slice(offset, offset + limit);
    const folderCache = createWorkspaceFolderCache(store);
    return {
      items: paged.map((item: WorkspaceRecord) =>
        workspaceRecordPayload(item, folderCache.path(item.id), folderCache.state(item.id))
      ),
      total: items.length,
      limit,
      offset
    };
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspace = store.getWorkspace(params.workspaceId, {
      includeDeleted: optionalBoolean(query.include_deleted, false)
    });
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    return {
      workspace: workspaceRecordPayload(
        workspace,
        resolveWorkspacePathForPayload(store, workspace.id),
        resolveWorkspaceFolderStateForPayload(store, workspace.id)
      )
    };
  });

  app.post("/api/v1/workspaces/:workspaceId/ensure-main-session", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const result = resolveOrCreateWorkspaceMainSession({
      store,
      workspace,
    });
    return {
      session: agentSessionPayload(result.session, store),
      migrated_legacy_sessions: result.migratedLegacySessions,
      migrated_legacy_session_count: result.migratedLegacySessions.length,
    };
  });

  app.patch("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }

    const params = request.params as { workspaceId: string };
    try {
      const fields: Record<string, string | null | undefined> = {};
      if (hasOwn(request.body, "status")) {
        fields.status = nullableString(request.body.status);
      }
      if (hasOwn(request.body, "error_message")) {
        fields.errorMessage = nullableString(request.body.error_message) ?? null;
      }
      if (hasOwn(request.body, "deleted_at_utc")) {
        fields.deletedAtUtc = nullableString(request.body.deleted_at_utc);
      }
      if (hasOwn(request.body, "onboarding_status")) {
        fields.onboardingStatus = nullableString(request.body.onboarding_status);
      }
      if (hasOwn(request.body, "onboarding_session_id")) {
        fields.onboardingSessionId = nullableString(request.body.onboarding_session_id);
      }
      if (hasOwn(request.body, "onboarding_completed_at")) {
        fields.onboardingCompletedAt = nullableString(request.body.onboarding_completed_at);
      }
      if (hasOwn(request.body, "onboarding_completion_summary")) {
        fields.onboardingCompletionSummary = nullableString(request.body.onboarding_completion_summary);
      }
      if (hasOwn(request.body, "onboarding_requested_at")) {
        fields.onboardingRequestedAt = nullableString(request.body.onboarding_requested_at);
      }
      if (hasOwn(request.body, "onboarding_requested_by")) {
        fields.onboardingRequestedBy = nullableString(request.body.onboarding_requested_by);
      }

      // Workspace path relocation. This is intentionally a separate branch
      // from the normal status/onboarding updates: it needs filesystem-level
      // validation (empty-or-matching-identity target) and can fail with
      // 400 rather than 404.
      if (hasOwn(request.body, "workspace_path")) {
        const nextPath = optionalString(request.body.workspace_path) ?? "";
        if (!nextPath) {
          return sendError(reply, 400, "workspace_path must be a non-empty string");
        }
        let relocated: WorkspaceRecord;
        try {
          relocated = store.relocateWorkspace(params.workspaceId, nextPath);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "workspace relocation failed";
          // "workspace X not found" → 404, everything else → 400 (validation).
          if (/not found/.test(msg)) {
            return sendError(reply, 404, "workspace not found");
          }
          return sendError(reply, 400, msg);
        }
        // Apply any other patched fields on top of the relocated record.
        const workspace =
          Object.keys(fields).length > 0
            ? store.updateWorkspace(params.workspaceId, fields)
            : relocated;
        return {
          workspace: workspaceRecordPayload(
            workspace,
            resolveWorkspacePathForPayload(store, workspace.id),
            resolveWorkspaceFolderStateForPayload(store, workspace.id)
          )
        };
      }

      const workspace = store.updateWorkspace(params.workspaceId, fields);
      return {
        workspace: workspaceRecordPayload(
          workspace,
          resolveWorkspacePathForPayload(store, workspace.id),
          resolveWorkspaceFolderStateForPayload(store, workspace.id)
        )
      };
    } catch (error) {
      return sendError(reply, 404, error instanceof Error ? error.message.replace(/^workspace .* not found$/, "workspace not found") : "workspace not found");
    }
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const query = isRecord(request.query) ? request.query : {};
    // keep_files overrides the default wipe behavior. Unspecified → default
    // (managed path wipes; custom path keeps user files). Explicit true/false
    // forces that semantic regardless of path.
    const keepFilesRequested = hasOwn(query, "keep_files")
      ? optionalBoolean(query.keep_files, false)
      : null;
    const workspace = store.getWorkspace(params.workspaceId, { includeDeleted: true });
    if (!workspace || workspace.deletedAtUtc) {
      // Idempotent: workspace already gone or never existed — treat as success
      return {
        workspace: {
          id: params.workspaceId,
          name: workspace?.name ?? params.workspaceId,
          status: "deleted",
          harness: workspace?.harness ?? null,
          error_message: null,
          onboarding_status: workspace?.onboardingStatus ?? "not_required",
          onboarding_session_id: null,
          onboarding_completed_at: null,
          onboarding_completion_summary: null,
          onboarding_requested_at: null,
          onboarding_requested_by: null,
          created_at: workspace?.createdAt ?? null,
          updated_at: workspace?.updatedAt ?? null,
          deleted_at_utc: workspace?.deletedAtUtc ?? new Date().toISOString(),
          workspace_path: null,
          folder_state: null
        }
      };
    }
    const workspaceDir = store.workspaceDir(params.workspaceId);
    try {
      await stopWorkspaceApplicationsForDeletion({
        workspaceId: params.workspaceId,
        workspaceDir
      });
      const deletedWorkspace = store.deleteWorkspace(params.workspaceId);
      // Decide whether to wipe the folder. Three cases:
      //   keep_files=true  → never wipe; preserve the full workspace bundle
      //   keep_files=false → always wipe the whole folder
      //   unspecified      → default: managed paths wipe, custom paths keep
      const isManagedPath = isPathWithinWorkspaceRoot(workspaceDir, store.workspaceRoot);
      const shouldWipe =
        keepFilesRequested === true
          ? false
          : keepFilesRequested === false
            ? true
            : isManagedPath;
      if (shouldWipe) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      return { workspace: workspaceRecordPayload(deletedWorkspace, workspaceDir, "missing") };
    } catch (error) {
      return sendError(reply, 500, error instanceof Error ? error.message : "workspace delete failed");
    }
  });

  app.post("/api/v1/sandbox/users/:holabossUserId/workspaces/:workspaceId/exec", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { holabossUserId: string; workspaceId: string };
    void params.holabossUserId;
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const workspaceDir = store.workspaceDir(params.workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    try {
      return await executeWorkspaceCommand(
        requiredString(request.body.command, "command"),
        workspaceDir,
        optionalInteger(request.body.timeout_s, 120)
      );
    } catch (error) {
      if (error instanceof Error && error.message === "workspace exec timed out") {
        return sendError(reply, 504, "workspace exec timed out");
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "workspace exec failed");
    }
  });

  // Workspaces activated in the current runtime boot. First activation
  // per workspace per boot reads the .holaboss/state/workspace_id identity file
  // to confirm the folder on disk really belongs to this workspace. We
  // don't re-check on every write — users are free to edit AGENTS.md,
  // skills, workspace.yaml, apps, etc.
  const activatedWorkspaceIds = new Set<string>();

  app.post("/api/v1/workspaces/:workspaceId/activate", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspaceId = params.workspaceId;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const workspaceDir = store.workspaceDir(workspaceId);
    const buildPayload = (folderState: "healthy" | "missing") => ({
      workspace: workspaceRecordPayload(workspace, workspaceDir, folderState)
    });

    if (activatedWorkspaceIds.has(workspaceId)) {
      // Already activated this boot — skip the identity read.
      return reply.send(buildPayload(store.workspaceFolderState(workspaceId)));
    }

    if (store.workspaceFolderState(workspaceId) !== "healthy") {
      return reply.code(409).send({
        detail: `workspace folder is missing at ${workspaceDir}. Relocate the workspace or delete the record.`,
        code: "workspace_folder_missing",
        workspace_path: workspaceDir
      });
    }

    const identityPath = store.workspaceIdentityPath(workspaceId);
    let identityMatches = false;
    try {
      const raw = fs.readFileSync(identityPath, "utf-8").trim();
      identityMatches = raw === workspaceId;
    } catch {
      identityMatches = false;
    }
    if (!identityMatches) {
      return reply.code(409).send({
        detail: `workspace folder at ${workspaceDir} no longer looks like the original workspace. Relocate the workspace or delete the record.`,
        code: "workspace_identity_mismatch",
        workspace_path: workspaceDir
      });
    }

    activatedWorkspaceIds.add(workspaceId);
    return reply.send(buildPayload("healthy"));
  });

  app.post("/api/v1/workspaces/:workspaceId/apply-template", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string };
    const files = Array.isArray(request.body.files) ? request.body.files : [];
    const replaceExisting = optionalBoolean(request.body.replace_existing, false);
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    if (replaceExisting) {
      for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (entry.name === ".holaboss" || entry.name === "workspace.json") {
          continue;
        }
        fs.rmSync(path.join(workspaceDir, entry.name), { recursive: true, force: true });
      }
    }

    let filesWritten = 0;
    for (const item of files) {
      if (!isRecord(item)) {
        continue;
      }
      const relativePath = optionalString(item.path) ?? "";
      const contentBase64 = optionalString(item.content_base64) ?? "";
      if (!relativePath || !contentBase64) {
        continue;
      }
      let fullPath: string;
      try {
        fullPath = resolveWorkspaceFilePath(workspaceDir, relativePath);
      } catch (error) {
        return sendError(reply, 400, error instanceof Error ? error.message : "path traversal not allowed");
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(contentBase64, "base64"));
      if (optionalBoolean(item.executable, false)) {
        fs.chmodSync(fullPath, fs.statSync(fullPath).mode | 0o111);
      }
      filesWritten += 1;
    }

    return reply.send({ status: "applied", files_written: filesWritten });
  });

  app.post("/api/v1/workspaces/:workspaceId/apply-template-from-url", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string };
    const url = requiredString(request.body.url, "url");
    const replaceExisting = optionalBoolean(request.body.replace_existing, false);
    const apiKey = optionalString(request.body.api_key);
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    if (replaceExisting) {
      for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (entry.name === ".holaboss" || entry.name === "workspace.json") {
          continue;
        }
        fs.rmSync(path.join(workspaceDir, entry.name), { recursive: true, force: true });
      }
    }

    const zipPath = path.join(os.tmpdir(), `holaboss-template-${params.workspaceId}-${Date.now()}.zip`);
    try {
      const response = await fetch(url, {
        headers: apiKey ? { "X-API-Key": apiKey } : undefined
      });
      if (!response.ok) {
        return sendError(reply, 502, `template download failed with status ${response.status}`);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(zipPath, archive);

      const filesWritten = await extractTemplateZipArchive(zipPath, workspaceDir);
      return reply.send({
        status: "applied",
        files_written: Number.isFinite(filesWritten) ? filesWritten : 0
      });
    } catch (error) {
      const invalidArchiveMessage = invalidTemplateArchiveMessage(error);
      if (invalidArchiveMessage) {
        return sendError(reply, 400, invalidArchiveMessage);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "template download failed");
    } finally {
      fs.rmSync(zipPath, { force: true });
    }
  });

  app.get("/api/v1/workspaces/:workspaceId/files/*", async (request, reply) => {
    const params = request.params as { workspaceId: string; "*": string };
    const workspaceDir = store.workspaceDir(params.workspaceId);
    let fullPath: string;
    try {
      fullPath = resolveWorkspaceFilePath(workspaceDir, params["*"] ?? "");
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "path traversal not allowed");
    }
    if (!fs.existsSync(fullPath)) {
      return sendError(reply, 404, `file not found: ${params["*"]}`);
    }
    if (!fs.statSync(fullPath).isFile()) {
      return sendError(reply, 400, `not a file: ${params["*"]}`);
    }
    const raw = fs.readFileSync(fullPath);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return reply.send({
        path: params["*"],
        content,
        encoding: "utf-8"
      });
    } catch {
      return reply.send({
        path: params["*"],
        content: raw.toString("base64"),
        encoding: "base64"
      });
    }
  });

  app.put("/api/v1/workspaces/:workspaceId/files/*", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string; "*": string };
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }
    let fullPath: string;
    try {
      fullPath = resolveWorkspaceFilePath(workspaceDir, params["*"] ?? "");
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "path traversal not allowed");
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(requiredString(request.body.content_base64, "content_base64"), "base64"));
    if (optionalBoolean(request.body.executable, false)) {
      fs.chmodSync(fullPath, fs.statSync(fullPath).mode | 0o111);
    }
    return reply.send({ path: params["*"], status: "written" });
  });

  app.get("/api/v1/workspaces/:workspaceId/snapshot", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspaceDir = store.workspaceDir(params.workspaceId);
    if (!fs.existsSync(workspaceDir)) {
      return sendError(reply, 404, "workspace not found");
    }
    return reply.send({
      workspace_id: params.workspaceId,
      ...collectWorkspaceSnapshot(workspaceDir)
    });
  });

  app.get("/api/v1/workspaces/:workspaceId/export", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspaceDir = store.workspaceDir(params.workspaceId);
    if (!fs.existsSync(workspaceDir)) {
      return sendError(reply, 404, "workspace not found");
    }

    const tar = spawnSync(
      "tar",
      [
        "-czf",
        "-",
        "--exclude=node_modules",
        "--exclude=.git",
        "--exclude=dist",
        "--exclude=build",
        "--exclude=__pycache__",
        "--exclude=.venv",
        "--exclude=.hb_template_bootstrap_tmp",
        "--exclude=.hb_app_template_tmp",
        "."
      ],
      {
        cwd: workspaceDir,
        encoding: null,
        maxBuffer: 128 * 1024 * 1024
      }
    );
    if (tar.status !== 0) {
      return sendError(
        reply,
        500,
        tar.stderr instanceof Buffer ? tar.stderr.toString("utf8", 0, 2000) : "workspace export failed"
      );
    }
    reply.header("Content-Disposition", `attachment; filename=${params.workspaceId}.tar.gz`);
    return reply.type("application/gzip").send(tar.stdout);
  });

  app.get("/api/v1/apps/ports", async (request) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    let workspaceDir: string | null = null;
    if (workspaceId) {
      // Must go through the store to respect user-chosen custom workspace
      // paths — not all workspaces live under workspaceRoot/<id>.
      try {
        workspaceDir = store.workspaceDir(workspaceId);
      } catch {
        workspaceDir = null;
      }
    } else if (fs.existsSync(store.workspaceRoot)) {
      for (const entry of fs.readdirSync(store.workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = path.join(store.workspaceRoot, entry.name, "workspace.yaml");
        if (fs.existsSync(candidate)) {
          workspaceDir = path.dirname(candidate);
          break;
        }
      }
    }
    if (!workspaceDir || !fs.existsSync(path.join(workspaceDir, "workspace.yaml"))) {
      return {};
    }
    return listWorkspaceApplicationPorts(workspaceDir, {
      store,
      workspaceId: workspaceId ?? null,
      allocatePorts: true
    });
  });

  app.post("/api/v1/apps/:appId/start", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { appId: string };
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    let resolvedApp;
    try {
      resolvedApp = resolveWorkspaceAppRuntime(workspaceDir, appId, {
        store,
        workspaceId,
        allocatePorts: true
      });
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : 400;
      return sendError(reply, statusCode, error instanceof Error ? error.message : "invalid app metadata");
    }
    try {
      const holabossUserId = optionalString(request.body.holaboss_user_id);
      const build = store.getAppBuild({ workspaceId, appId });
      const needsSetup =
        !appBuildHasCompletedSetup(build?.status) &&
        resolvedApp.resolvedApp.lifecycle.setup.trim().length > 0;

      if (needsSetup) {
        store.upsertAppBuild({
          workspaceId,
          appId,
          status: "building"
        });
        void appLifecycleExecutor
          .startApp({
            appId,
            appDir: resolvedApp.appDir,
            httpPort: resolvedApp.ports.http,
            mcpPort: resolvedApp.ports.mcp,
            holabossUserId,
            resolvedApp: resolvedApp.resolvedApp,
            skipSetup: false
          })
          .then((result) => {
            store.upsertAppBuild({
              workspaceId,
              appId,
              status: result.status === "started" ? "running" : result.status
            });
          })
          .catch((error) => {
            store.upsertAppBuild({
              workspaceId,
              appId,
              status: "failed",
              error: error instanceof Error ? error.message : String(error)
            });
            app.log.error(
              {
                workspaceId,
                appId,
                error: error instanceof Error ? error.message : String(error)
              },
              "background app start failed"
            );
          });
        return {
          app_id: appId,
          status: "building",
          detail: "App start queued in background",
          ports: { http: resolvedApp.ports.http, mcp: resolvedApp.ports.mcp }
        };
      }

      const result = await appLifecycleExecutor.startApp({
        appId,
        appDir: resolvedApp.appDir,
        httpPort: resolvedApp.ports.http,
        mcpPort: resolvedApp.ports.mcp,
        holabossUserId,
        workspaceId,
        resolvedApp: resolvedApp.resolvedApp,
        skipSetup: appBuildHasCompletedSetup(build?.status)
      });
      store.upsertAppBuild({
        workspaceId,
        appId,
        status: result.status === "started" ? "running" : result.status
      });
      return result;
    } catch (error) {
      if (error instanceof AppLifecycleExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "app lifecycle start failed");
    }
  });

  app.post("/api/v1/apps/:appId/stop", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { appId: string };
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    let resolvedApp;
    try {
      resolvedApp = resolveWorkspaceAppRuntime(workspaceDir, appId, {
        store,
        workspaceId
      });
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : 400;
      return sendError(reply, statusCode, error instanceof Error ? error.message : "invalid app metadata");
    }
    try {
      const result = await appLifecycleExecutor.stopApp({
        appId,
        appDir: resolvedApp.appDir,
        workspaceId,
        resolvedApp: resolvedApp.resolvedApp
      });
      store.upsertAppBuild({
        workspaceId,
        appId,
        status: "stopped"
      });
      return result;
    } catch (error) {
      if (error instanceof AppLifecycleExecutorError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "app lifecycle stop failed");
    }
  });

  // Returns the latest setup log tail for an app. Used by the desktop
  // UI and operators to diagnose install/build failures without having
  // to ssh into the workspace directory. 404 if the app has never run
  // its lifecycle setup (e.g. pre-built archives where setup is "true").
  app.get("/api/v1/apps/:appId/setup-log", async (request, reply) => {
    const params = request.params as { appId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = requiredString(query.workspace_id, "workspace_id");
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    const appDir = path.join(workspaceDir, "apps", appId);
    const logDir = path.join(appDir, ".holaboss", "logs");
    const latest = path.join(logDir, "setup.latest.log");
    if (!fs.existsSync(latest)) {
      return sendError(reply, 404, "no setup log found for this app");
    }
    const bytes = optionalInteger(query.bytes, 32 * 1024);
    const stat = fs.statSync(latest);
    const readBytes = Math.min(Math.max(1024, bytes), 512 * 1024);
    // Read only the tail to avoid dumping multi-MB logs over IPC.
    const fd = fs.openSync(latest, "r");
    try {
      const start = Math.max(0, stat.size - readBytes);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const events: unknown[] = [];
      const eventsPath = path.join(logDir, "events.ndjson");
      if (fs.existsSync(eventsPath)) {
        const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").slice(-50);
        for (const line of lines) {
          try {
            events.push(JSON.parse(line));
          } catch {
            // ignore malformed lines
          }
        }
      }
      return {
        app_id: appId,
        workspace_id: workspaceId,
        log_path: latest,
        log_size_bytes: stat.size,
        log_tail: buf.toString("utf8"),
        recent_events: events,
      };
    } finally {
      fs.closeSync(fd);
    }
  });

  app.get("/api/v1/apps/:appId/build-status", async (request, reply) => {
    const params = request.params as { appId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = requiredString(query.workspace_id, "workspace_id");
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const entry = listWorkspaceApplications(store.workspaceDir(workspaceId)).find((candidate) => candidate.app_id === appId) ?? null;
    const record = store.getAppBuild({ workspaceId, appId });
    return record ? appBuildPayload(record) : { status: entry ? fallbackAppBuildStatus(entry) : "unknown" };
  });

  app.get("/api/v1/apps/catalog", async (request) => {
    const query = isRecord(request.query) ? request.query : {};
    const rawSource = typeof query.source === "string" ? query.source.trim() : "";
    const source =
      rawSource === "marketplace" || rawSource === "local" ? rawSource : undefined;
    const entries = store.listAppCatalogEntries(source ? { source } : undefined);
    return { entries: entries.map(appCatalogEntryToWire), count: entries.length };
  });

  app.post("/api/v1/apps/catalog/sync", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const rawSource = requiredString(request.body.source, "source");
    if (rawSource !== "marketplace" && rawSource !== "local") {
      return sendError(reply, 400, "source must be 'marketplace' or 'local'");
    }
    const source: "marketplace" | "local" = rawSource;
    const target = requiredString(request.body.target, "target");
    const entries = Array.isArray(request.body.entries) ? request.body.entries : [];

    store.clearAppCatalogSource(source);
    const now = new Date().toISOString();
    let synced = 0;
    for (const raw of entries) {
      if (!isRecord(raw)) continue;
      let appId: string;
      try {
        appId = sanitizeAppId(requiredString(raw.app_id, "app_id"));
      } catch {
        continue;
      }
      const tagsRaw = raw.tags;
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.filter((t): t is string => typeof t === "string")
        : [];
      store.upsertAppCatalogEntry({
        appId,
        source,
        name: requiredString(raw.name, "name"),
        description: typeof raw.description === "string" ? raw.description : null,
        icon: typeof raw.icon === "string" ? raw.icon : null,
        category: typeof raw.category === "string" ? raw.category : null,
        tags,
        version: typeof raw.version === "string" ? raw.version : null,
        archiveUrl: typeof raw.archive_url === "string" ? raw.archive_url : null,
        archivePath: typeof raw.archive_path === "string" ? raw.archive_path : null,
        target,
        cachedAt: now,
        providerId: typeof raw.provider_id === "string" && raw.provider_id.trim().length > 0
          ? raw.provider_id.trim()
          : null,
        credentialSource: typeof raw.credential_source === "string" && raw.credential_source.trim().length > 0
          ? raw.credential_source.trim()
          : null,
      });
      synced += 1;
    }
    return { synced, source, target };
  });

  app.get("/api/v1/apps", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = requiredString(query.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    const apps = listWorkspaceApplications(workspaceDir).map((entry) => {
      const appId = typeof entry.app_id === "string" ? entry.app_id : "";
      const build = appId ? store.getAppBuild({ workspaceId, appId }) : null;
      const status = appId ? resolvedAppBuildStatus({ store, workspaceId, appId, entry }) : "unknown";
      return {
        app_id: appId,
        config_path: typeof entry.config_path === "string" ? entry.config_path : "",
        lifecycle: isRecord(entry.lifecycle) ? entry.lifecycle : null,
        build_status: status,
        ready: status === "running",
        error: build?.status === "failed" ? (build.error ?? "unknown error") : null
      };
    });
    return {
      apps: apps.filter((entry) => entry.app_id.length > 0),
      count: apps.filter((entry) => entry.app_id.length > 0).length
    };
  });

  app.post("/api/v1/apps/ensure-running", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    try {
      return await ensureAllAppsRunning(workspaceId);
    } catch (error) {
      return sendError(reply, 500, error instanceof Error ? error.message : "failed to ensure apps running");
    }
  });

  app.post("/api/v1/apps/install-archive", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    if (!requireHealthyWorkspaceFolder(store, workspaceId, reply)) {
      return;
    }

    let appId: string;
    try {
      appId = sanitizeAppId(requiredString(request.body.app_id, "app_id"));
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    app.log.info(
      { event: "app.install_archive.begin", workspaceId, appId },
      "install-archive: request received",
    );

    // Serialize concurrent installs for the same (workspaceId, appId).
    const installKey = `${workspaceId}:${appId}`;
    const inFlightInstall = appInstallTasks.get(installKey);
    if (inFlightInstall) {
      // Another install for the same app is already running; tell the
      // caller to retry later rather than racing on the filesystem.
      return sendError(reply, 409, "app install already in progress for this id");
    }

    // Claim the install lock before ANY async work, early return, or
    // filesystem mutation. Two bugs hide in delaying this:
    //   1. Concurrent archive_url requests both pass the in-flight check
    //      above, both await downloadArchiveToTemp, and both reach
    //      extraction/registration — the download was the race window.
    //   2. Any early return taken before the try/finally leaves the lock
    //      set, pinning that (workspaceId, appId) until the runtime
    //      restarts (e.g. the "app already installed" path).
    // Every exit path below now runs through the finally that clears it.
    let installPromiseResolve!: () => void;
    const installMarker = new Promise<void>((resolve) => {
      installPromiseResolve = resolve;
    });
    appInstallTasks.set(installKey, installMarker);

    let archivePath = "";
    let cleanupTempFile = false;

    try {
      const rawArchivePath =
        typeof request.body.archive_path === "string" ? request.body.archive_path : "";
      const rawArchiveUrl =
        typeof request.body.archive_url === "string" ? request.body.archive_url : "";

      if (rawArchivePath && rawArchiveUrl) {
        return sendError(reply, 400, "provide either archive_path or archive_url, not both");
      }
      if (!rawArchivePath && !rawArchiveUrl) {
        return sendError(reply, 400, "archive_path or archive_url is required");
      }

      if (rawArchiveUrl) {
        if (!isAllowedArchiveUrl(rawArchiveUrl)) {
          app.log.warn(
            { event: "app.install_archive.url_denied", workspaceId, appId, url: rawArchiveUrl },
            "install-archive: archive_url outside allowlist",
          );
          return sendError(reply, 400, "archive_url outside allowlist");
        }
        try {
          app.log.info(
            { event: "app.install_archive.download_start", workspaceId, appId, url: rawArchiveUrl },
            "install-archive: downloading",
          );
          archivePath = await downloadArchiveToTemp(rawArchiveUrl, appId);
          cleanupTempFile = true;
          app.log.info(
            { event: "app.install_archive.download_complete", workspaceId, appId, archivePath },
            "install-archive: download complete",
          );
        } catch (error) {
          app.log.error(
            {
              event: "app.install_archive.download_failed",
              workspaceId,
              appId,
              url: rawArchiveUrl,
              err: error instanceof Error ? error.message : String(error),
            },
            "install-archive: download failed",
          );
          return sendError(
            reply,
            400,
            `archive download failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        archivePath = rawArchivePath;
        if (!isAllowedArchivePath(archivePath)) {
          return sendError(reply, 400, "archive_path outside allowed roots");
        }
        if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
          return sendError(reply, 400, "archive_path does not exist");
        }
      }

      const workspaceDir = store.workspaceDir(workspaceId);
      const appDir = path.join(workspaceDir, "apps", appId);
      if (fs.existsSync(appDir) && fs.readdirSync(appDir).length > 0) {
        return sendError(reply, 409, "app already installed — uninstall first");
      }
      fs.mkdirSync(appDir, { recursive: true });

      app.log.info(
        { event: "app.install_archive.extract_start", workspaceId, appId, appDir },
        "install-archive: extracting tarball",
      );
      try {
        await tar.x({
          file: archivePath,
          cwd: appDir,
          strict: true,
          // Defense-in-depth: drop owner uid/gid metadata via portable
          // so archives can't smuggle ownership, and reject entries
          // whose normalized path escapes appDir. We do NOT strip the
          // executable bit: prebuilt marketplace archives ship with
          // `node_modules/.bin/*` shebang scripts that need +x to run
          // (`npm run build` → `vite`), and turning them into plain
          // files would break every app that uses pnpm/vite/esbuild.
          portable: true,
          filter: (entryPath) => {
            const normalized = path.posix.normalize(entryPath);
            if (
              normalized.startsWith("/") ||
              normalized.startsWith("..") ||
              normalized.split("/").includes("..")
            ) {
              return false;
            }
            return true;
          },
        });
        app.log.info(
          { event: "app.install_archive.extract_complete", workspaceId, appId, appDir },
          "install-archive: extraction complete",
        );
      } catch (error) {
        app.log.error(
          {
            event: "app.install_archive.extract_failed",
            workspaceId,
            appId,
            appDir,
            err: error instanceof Error ? error.message : String(error),
          },
          "install-archive: tar extraction threw",
        );
        fs.rmSync(appDir, { recursive: true, force: true });
        return sendError(
          reply,
          400,
          `archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const appYamlPath = path.join(appDir, "app.runtime.yaml");
      if (!fs.existsSync(appYamlPath)) {
        app.log.error(
          { event: "app.install_archive.yaml_missing", workspaceId, appId, appYamlPath },
          "install-archive: app.runtime.yaml missing after extract",
        );
        fs.rmSync(appDir, { recursive: true, force: true });
        return sendError(reply, 400, "app.runtime.yaml not found in archive root");
      }

      // Patch app.runtime.yaml on disk before parsing:
      // 1. Rewrite app_id to match the caller's appId (archives use "{name}-module"
      //    but the catalog uses short names like "twitter", "gmail", etc.)
      // 2. For pre-built archives (.output/server/index.mjs exists), replace the
      //    setup command with "true" so ensureAppRunning skips the source build.
      {
        let yamlContent = fs.readFileSync(appYamlPath, "utf8");
        let changed = false;

        // Patch app_id to match the caller's expected id
        const appIdPatched = yamlContent.replace(
          /^(app_id:\s*).*$/m,
          `$1"${appId}"`,
        );
        if (appIdPatched !== yamlContent) {
          yamlContent = appIdPatched;
          changed = true;
        }

        // Patch setup to "true" for pre-built archives
        const isPrebuilt = fs.existsSync(path.join(appDir, ".output", "server", "index.mjs"));
        if (isPrebuilt) {
          const setupPatched = yamlContent.replace(
            /^(\s*setup:\s*).*$/m,
            '$1"true"',
          );
          if (setupPatched !== yamlContent) {
            yamlContent = setupPatched;
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(appYamlPath, yamlContent, "utf8");
        }
      }

      let parsed: ParsedInstalledApp;
      try {
        parsed = parseInstalledAppRuntime(
          fs.readFileSync(appYamlPath, "utf8"),
          appId,
          `apps/${appId}/app.runtime.yaml`,
        );
      } catch (error) {
        fs.rmSync(appDir, { recursive: true, force: true });
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "invalid app.runtime.yaml",
        );
      }

      const lifecycle: Record<string, string> = {};
      if (parsed.lifecycle.setup) lifecycle.setup = parsed.lifecycle.setup;
      if (parsed.lifecycle.start) lifecycle.start = parsed.lifecycle.start;
      if (parsed.lifecycle.stop) lifecycle.stop = parsed.lifecycle.stop;
      appendWorkspaceApplication(workspaceDir, {
        appId,
        configPath: parsed.configPath,
        lifecycle: Object.keys(lifecycle).length > 0 ? lifecycle : null,
      });

      app.log.info(
        { event: "app.install_archive.registered", workspaceId, appId, configPath: parsed.configPath },
        "install-archive: appended to workspace.yaml, handing off to ensureAppRunning",
      );
      let runResult: { ready: boolean; error: string | null; detail: string };
      try {
        await ensureAppRunning(workspaceId, appId);
        runResult = { ready: true, error: null, detail: "App installed and running" };
        app.log.info(
          { event: "app.install_archive.ensure_running_ok", workspaceId, appId },
          "install-archive: ensureAppRunning succeeded",
        );
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        runResult = { ready: false, error: message, detail: message };
        app.log.error(
          { event: "app.install_archive.ensure_running_failed", workspaceId, appId, err: message },
          "install-archive: ensureAppRunning threw",
        );
      }

      // Write the MCP registry entry now that ensureAppRunning has allocated ports.
      // Best-effort: if port lookup fails (e.g. embedded runtime flag not set), fall back to null.
      if (parsed.mcpTools.length > 0) {
        try {
          const resolvedApp = resolveWorkspaceApp(workspaceDir, appId, { store, workspaceId });
          writeWorkspaceMcpRegistryEntry(workspaceDir, appId, {
            mcpEnabled: true,
            mcpTools: parsed.mcpTools,
            mcpPath: "/mcp/sse",
            mcpTimeoutMs: 30000,
            mcpPort: resolvedApp.ports.mcp,
          });
        } catch (error) {
          app.log.warn(
            { workspaceId, appId, err: error },
            "failed to write mcp_registry entry after install-archive"
          );
        }
      }

      return {
        app_id: appId,
        status: "enabled",
        detail: runResult.detail,
        ready: runResult.ready,
        error: runResult.error,
      };
    } finally {
      if (cleanupTempFile) {
        try {
          fs.rmSync(archivePath, { force: true });
        } catch {
          /* best effort cleanup */
        }
      }
      appInstallTasks.delete(installKey);
      installPromiseResolve();
    }
  });

  // [removed] /api/v1/apps/register-existing — community apps now install via install-archive like official ones (cross-platform safety: only GitHub-release tarballs are guaranteed to be runnable on the installer's OS/arch).

  app.post("/api/v1/apps/install", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }

    let appId: string;
    try {
      appId = sanitizeAppId(requiredString(request.body.app_id, "app_id"));
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const workspaceDir = store.workspaceDir(workspaceId);
    const appDir = path.join(workspaceDir, "apps", appId);
    fs.mkdirSync(appDir, { recursive: true });

    const files = Array.isArray(request.body.files) ? request.body.files : [];
    for (const item of files) {
      if (!isRecord(item)) {
        continue;
      }
      const relativePath = requiredString(item.path, "path");
      const fullPath = resolveWorkspaceFilePath(appDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(requiredString(item.content_base64, "content_base64"), "base64"));
      if (optionalBoolean(item.executable, false)) {
        fs.chmodSync(fullPath, 0o755);
      }
    }

    const appYamlPath = path.join(appDir, "app.runtime.yaml");
    if (!fs.existsSync(appYamlPath)) {
      return sendError(reply, 400, "app.runtime.yaml not found in uploaded files");
    }

    let parsed: ParsedInstalledApp;
    try {
      parsed = parseInstalledAppRuntime(
        fs.readFileSync(appYamlPath, "utf8"),
        appId,
        `apps/${appId}/app.runtime.yaml`
      );
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app.runtime.yaml");
    }

    const lifecycle: Record<string, string> = {};
    if (parsed.lifecycle.setup) {
      lifecycle.setup = parsed.lifecycle.setup;
    }
    if (parsed.lifecycle.start) {
      lifecycle.start = parsed.lifecycle.start;
    }
    if (parsed.lifecycle.stop) {
      lifecycle.stop = parsed.lifecycle.stop;
    }
    appendWorkspaceApplication(workspaceDir, {
      appId,
      configPath: parsed.configPath,
      lifecycle: Object.keys(lifecycle).length > 0 ? lifecycle : null
    });

    // Atomic enable: setup + start in one flow.
    try {
      await ensureAppRunning(workspaceId, appId);
      return {
        app_id: appId,
        status: "enabled",
        detail: "App installed and running",
        ready: true,
        error: null
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      return {
        app_id: appId,
        status: "enabled",
        detail: message,
        ready: false,
        error: message
      };
    }
  });

  app.post("/api/v1/apps/:appId/setup", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { appId: string };
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    const appYamlPath = path.join(workspaceDir, "apps", appId, "app.runtime.yaml");
    if (!fs.existsSync(appYamlPath)) {
      return sendError(reply, 404, `app.runtime.yaml not found for ${appId}`);
    }

    let parsed: ParsedInstalledApp;
    try {
      parsed = parseInstalledAppRuntime(
        fs.readFileSync(appYamlPath, "utf8"),
        appId,
        `apps/${appId}/app.runtime.yaml`
      );
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app.runtime.yaml");
    }

    if (!parsed.lifecycle.setup) {
      return {
        app_id: appId,
        status: "no_setup_command",
        detail: "No lifecycle.setup defined",
        ports: {}
      };
    }

    const queued = queueAppSetup({
      workspaceDir,
      workspaceId,
      appId,
      setupCommand: parsed.lifecycle.setup
    });
    return {
      app_id: appId,
      status: queued.status,
      detail: queued.detail,
      ports: {}
    };
  });

  app.delete("/api/v1/apps/:appId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { appId: string };
    let appId: string;
    try {
      appId = sanitizeAppId(params.appId);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "invalid app_id");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);

    try {
      const resolvedApp = resolveWorkspaceAppRuntime(workspaceDir, appId, {
        store,
        workspaceId
      });
      await appLifecycleExecutor.stopApp({
        appId,
        appDir: resolvedApp.appDir,
        workspaceId,
        resolvedApp: resolvedApp.resolvedApp
      });
    } catch {
      app.log.debug({ workspaceId, appId }, "best-effort app stop failed during uninstall");
    }

    fs.rmSync(path.join(workspaceDir, "apps", appId), { recursive: true, force: true });
    removeWorkspaceApplication(workspaceDir, appId);
    removeWorkspaceMcpRegistryEntry(workspaceDir, appId);
    releaseWorkspaceAppPorts({ store, workspaceId, appId });
    store.deleteAppBuild({ workspaceId, appId });
    return {
      app_id: appId,
      status: "uninstalled",
      detail: "App stopped, files removed, workspace.yaml updated",
      ports: {}
    };
  });

  app.post("/api/v1/agent-sessions", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }

    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const sessionId = optionalString(request.body.session_id) ?? randomUUID();
    if (store.getSession({ workspaceId, sessionId })) {
      return sendError(reply, 409, "session_id is already in use");
    }

    const session = store.ensureSession({
      workspaceId,
      sessionId,
      kind: optionalString(request.body.kind) ?? inferredSessionKind(workspace, sessionId),
      title: nullableString(request.body.title) ?? null,
      parentSessionId: nullableString(request.body.parent_session_id) ?? null,
      createdBy: nullableString(request.body.created_by) ?? "workspace_user",
    });
    if (!store.getBinding({ workspaceId, sessionId })) {
      store.upsertBinding({
        workspaceId,
        sessionId,
        harness: resolvedWorkspaceHarness(workspace),
        harnessSessionId: sessionId,
      });
    }
    store.ensureRuntimeState({
      workspaceId,
      sessionId,
      status: "IDLE",
    });

    return {
      session: agentSessionPayload(session, store),
    };
  });

  app.post("/api/v1/agent-sessions/queue", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    if (!requireHealthyWorkspaceFolder(store, workspaceId, reply)) {
      return;
    }
    const blockingApps = blockingWorkspaceApps({ store, workspaceId });
    if (blockingApps.length > 0) {
      return sendError(reply, 409, blockingWorkspaceAppsMessage(blockingApps));
    }

    let resolvedSessionId: string;
    try {
      resolvedSessionId = resolveQueueSessionId(optionalString(request.body.session_id), store, workspace);
    } catch (error) {
      return sendError(reply, 409, error instanceof Error ? error.message : "workspace session is not configured");
    }

    const workspaceDir = store.workspaceDir(workspaceId);
    const trimmedText = (optionalString(request.body.text) ?? "").trim();
    let attachments: SessionInputAttachmentPayload[];
    try {
      attachments = requiredSessionInputAttachments(request.body.attachments, workspaceDir);
    } catch (error) {
      return sendError(reply, 422, error instanceof Error ? error.message : "attachments are invalid");
    }
    if (!trimmedText && attachments.length === 0) {
      return sendError(reply, 422, "text or attachments are required");
    }

    const existingSession = store.getSession({
      workspaceId,
      sessionId: resolvedSessionId
    });
    const inferredKind = inferredSessionKind(workspace, resolvedSessionId);
    const generatedSessionTitle = sessionTitleFromFirstUserInput(trimmedText, attachments);

    store.ensureSession({
      workspaceId,
      sessionId: resolvedSessionId,
      kind: inferredKind,
      title: existingSession?.title?.trim() ? undefined : generatedSessionTitle
    });
    if (!store.getBinding({ workspaceId, sessionId: resolvedSessionId })) {
      store.upsertBinding({
        workspaceId,
        sessionId: resolvedSessionId,
        harness: resolvedWorkspaceHarness(workspace),
        harnessSessionId: resolvedSessionId
      });
    }
    const runtimeStateBeforeQueue =
      store.getRuntimeState({
        workspaceId,
        sessionId: resolvedSessionId,
      }) ??
      store.ensureRuntimeState({
        workspaceId,
        sessionId: resolvedSessionId,
        status: "IDLE"
      });
    const pendingBackgroundUpdateEvents =
      canInlineBackgroundUpdatesIntoSessionKind(
        existingSession?.kind ?? inferredKind,
      )
        ? store.listPendingMainSessionEvents({
            workspaceId,
            ownerMainSessionId: resolvedSessionId,
            deliveryBucket: "background_update",
            limit: 200,
          })
        : [];
    const inlineBackgroundUpdateIds = pendingBackgroundUpdateEvents.map(
      (event) => event.eventId,
    );
    const record = store.enqueueInput({
      workspaceId,
      sessionId: resolvedSessionId,
      priority: optionalInteger(request.body.priority, 0),
      idempotencyKey: nullableString(request.body.idempotency_key) ?? null,
      payload: {
        text: trimmedText,
        attachments,
        image_urls: Array.isArray(request.body.image_urls) ? request.body.image_urls : [],
        model: nullableString(request.body.model) ?? null,
        thinking_value: nullableString(request.body.thinking_value) ?? null,
        context:
          inlineBackgroundUpdateIds.length > 0
            ? {
                main_session_event_ids: inlineBackgroundUpdateIds,
                delivery_bucket: "background_update",
                main_session_event_mode: "inline_user_reply",
                queued_events: groupedMainSessionEventsPayload(
                  pendingBackgroundUpdateEvents,
                ),
                attached_at: utcNowIso(),
              }
            : {}
      }
    });
    if (inlineBackgroundUpdateIds.length > 0) {
      store.markMainSessionEventsMaterialized({
        workspaceId,
        eventIds: inlineBackgroundUpdateIds,
        materializedInputId: record.inputId,
      });
    }
    createInputMemoryUpdateProposals({
      store,
      workspaceId,
      sessionId: resolvedSessionId,
      inputId: record.inputId,
      sourceMessageId: `user-${record.inputId}`,
      text: trimmedText,
    });
    if (runtimeStateHasClaimedActiveInput(store, runtimeStateBeforeQueue)) {
      store.updateRuntimeState({
        workspaceId,
        sessionId: resolvedSessionId,
        status: runtimeStateBeforeQueue?.status ?? "BUSY",
        currentInputId: runtimeStateBeforeQueue?.currentInputId ?? null,
        currentWorkerId: runtimeStateBeforeQueue?.currentWorkerId ?? null,
        leaseUntil: runtimeStateBeforeQueue?.leaseUntil ?? null,
        heartbeatAt: runtimeStateBeforeQueue?.heartbeatAt ?? null,
        lastError: runtimeStateBeforeQueue?.lastError ?? null
      });
    } else {
      store.updateRuntimeState({
        workspaceId,
        sessionId: resolvedSessionId,
        status: "QUEUED",
        currentInputId: record.inputId,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null
      });
    }
    const runtimeStateAfterQueue = store.getRuntimeState({
      workspaceId,
      sessionId: resolvedSessionId,
    });
    const queueAwareState = effectiveSessionState(runtimeStateAfterQueue, true);
    queueWorker?.wake();
    return {
      input_id: record.inputId,
      session_id: record.sessionId,
      status: record.status,
      effective_state: queueAwareState.effective_state,
      runtime_status: queueAwareState.runtime_status,
      current_input_id: queueAwareState.current_input_id,
      has_queued_inputs: true,
    };
  });

  app.post("/api/v1/agent-sessions/:sessionId/pause", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { sessionId: string };
    const workspaceId = optionalString(request.body.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    if (!queueWorker?.pauseSessionRun) {
      return sendError(reply, 409, "runtime pause is not available");
    }

    const paused = await queueWorker.pauseSessionRun({
      workspaceId,
      sessionId: params.sessionId,
    });
    if (!paused) {
      return sendError(reply, 409, "session is not currently running");
    }

    return {
      input_id: paused.inputId,
      session_id: paused.sessionId,
      status: paused.status,
    };
  });

  app.patch("/api/v1/agent-sessions/:sessionId/inputs/:inputId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { sessionId: string; inputId: string };
    const workspaceId = optionalString(request.body.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const input = store.getInput({
      workspaceId,
      inputId: params.inputId,
    });
    if (
      !input ||
      input.workspaceId !== workspaceId ||
      input.sessionId !== params.sessionId
    ) {
      return sendError(reply, 404, "queued input not found");
    }
    if (input.status !== "QUEUED") {
      return sendError(reply, 409, "queued input can no longer be edited");
    }

    const existingPayload = isRecord(input.payload) ? input.payload : {};
    const trimmedText = (optionalString(request.body.text) ?? "").trim();
    const existingAttachments = Array.isArray(existingPayload.attachments)
      ? existingPayload.attachments
      : [];
    if (!trimmedText && existingAttachments.length === 0) {
      return sendError(reply, 422, "text or attachments are required");
    }

    const updated = store.updateInput({
      workspaceId,
      inputId: params.inputId,
      fields: {
        payload: {
          ...existingPayload,
          text: trimmedText,
        },
      },
    });
    if (!updated) {
      return sendError(reply, 500, "failed to update queued input");
    }

    return {
      input_id: updated.inputId,
      session_id: updated.sessionId,
      status: updated.status,
      text: optionalString(updated.payload.text) ?? "",
      updated_at: updated.updatedAt,
    };
  });

  app.get("/api/v1/agent-sessions", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const items = store
      .listSessions({
        workspaceId,
        includeArchived: optionalBoolean(query.include_archived, false),
        limit: Math.max(1, Math.min(200, optionalInteger(query.limit, 100))),
        offset: Math.max(0, optionalInteger(query.offset, 0))
      })
      .map((item: AgentSessionRecord) => agentSessionPayload(item, store));
    return { items, count: items.length };
  });

  app.get("/api/v1/agent-sessions/:sessionId/state", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    const profileId = optionalString(query.profile_id);
    if (workspaceId && profileId && workspaceId !== profileId) {
      return sendError(reply, 422, "workspace_id and profile_id must match when both are provided");
    }
    const resolvedWorkspaceId = workspaceId ?? profileId;
    if (!resolvedWorkspaceId) {
      return sendError(reply, 422, "workspace_id or profile_id is required");
    }
    const runtimeState = store.getRuntimeState({
      sessionId: params.sessionId,
      workspaceId: resolvedWorkspaceId
    });
    const hasQueued = store.hasAvailableInputsForSession({
      sessionId: params.sessionId,
      workspaceId: resolvedWorkspaceId
    });
    return effectiveSessionState(runtimeState, hasQueued);
  });

  app.get("/api/v1/agent-sessions/by-workspace/:workspaceId/runtime-states", async (request) => {
    const params = request.params as { workspaceId: string };
    const items = store
      .listRuntimeStates(params.workspaceId)
      .map((item: SessionRuntimeStateRecord) => {
        const hasQueuedInputs = store.hasAvailableInputsForSession({
          workspaceId: params.workspaceId,
          sessionId: item.sessionId,
        });
        return runtimeStateListItemPayload({
          record: item,
          lastTurnResult:
            store.listTurnResults({
              workspaceId: params.workspaceId,
              sessionId: item.sessionId,
              limit: 1,
              offset: 0,
            })[0] ?? null,
          hasQueuedInputs,
        });
      });
    return { items, count: items.length };
  });

  app.get("/api/v1/agent-sessions/:sessionId/history", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const session = store.getSession({
      workspaceId,
      sessionId: params.sessionId,
    });
    if (!session) {
      return sendError(reply, 404, "session not found");
    }
    const binding = store.getBinding({ workspaceId, sessionId: params.sessionId });

    const limit = Math.max(1, Math.min(1000, optionalInteger(query.limit, 200)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const order = optionalString(query.order) === "desc" ? "desc" : "asc";
    const total = store.countSessionMessages({ workspaceId, sessionId: params.sessionId });
    const messages = store
      .listSessionMessages({
        workspaceId,
        sessionId: params.sessionId,
        limit,
        offset,
        order
      })
      .map((message: SessionMessageRecord) => {
        const inputId = message.role === "user" && message.id.startsWith("user-") ? message.id.slice(5) : "";
        const inputAttachments = inputId
          ? attachmentsFromInputPayload(
              store.getInput({
                workspaceId,
                inputId,
              })?.payload.attachments
            )
          : [];
        const metadata = inputAttachments.length > 0 ? { ...message.metadata, attachments: inputAttachments } : message.metadata;
        return sessionMessagePayload(message, metadata);
      });
    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      harness: binding?.harness ?? resolvedWorkspaceHarness(workspace),
      harness_session_id: binding?.harnessSessionId ?? "",
      source: "sandbox_local_storage",
      messages,
      count: messages.length,
      total,
      limit,
      offset,
      raw: null
    };
  });

  app.get("/api/v1/agent-sessions/:sessionId/turn-results", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const inputId = optionalString(query.input_id);
    const limit = Math.max(1, Math.min(1000, optionalInteger(query.limit, 200)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const total = store.countTurnResults({
      workspaceId,
      sessionId: params.sessionId,
      inputId: inputId ?? undefined,
    });
    const items = store
      .listTurnResults({
        workspaceId,
        sessionId: params.sessionId,
        inputId: inputId ?? undefined,
        limit,
        offset,
      })
      .map((item: TurnResultRecord) => turnResultPayload(item));

    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      items,
      count: items.length,
      total,
      limit,
      offset,
    };
  });

  app.get("/api/v1/agent-sessions/:sessionId/request-snapshots", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const inputId = optionalString(query.input_id);
    const limit = Math.max(1, Math.min(1000, optionalInteger(query.limit, 200)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const items = store
      .listTurnRequestSnapshots({
        workspaceId,
        sessionId: params.sessionId,
        inputId: inputId ?? undefined,
        limit,
        offset,
      })
      .map((item: TurnRequestSnapshotRecord) => turnRequestSnapshotPayload(item));

    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      items,
      count: items.length,
      limit,
      offset,
    };
  });

  app.get("/api/v1/agent-sessions/:sessionId/resume-context", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const inputId = optionalString(query.input_id) ?? "";
    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      input_id: inputId || null,
      session_resume_context: loadSessionResumeContextForApi({
        workspaceRoot: store.workspaceRoot,
        workspaceId,
        sessionId: params.sessionId,
      }),
    };
  });

  app.post("/api/v1/agent-sessions/:sessionId/artifacts", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { sessionId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const inputId = resolveOutputInputId({
      store,
      workspaceId,
      sessionId: params.sessionId,
      inputId: nullableString(request.body.input_id),
    });
    const metadata = optionalDict(request.body.metadata) ?? {};
    const artifactId = nullableString(request.body.artifact_id) ?? randomUUID();
    store.ensureRuntimeState({
      workspaceId,
      sessionId: params.sessionId,
      status: "IDLE"
    });
    const output = store.createOutput({
      workspaceId,
      outputType: outputTypeForArtifact(requiredString(request.body.artifact_type, "artifact_type")),
      title: nullableString(request.body.title) ?? "",
      status: "completed",
      moduleId: nullableString(request.body.module_id) ?? null,
      moduleResourceId:
        nullableString(request.body.module_resource_id) ?? requiredString(request.body.external_id, "external_id"),
      sessionId: params.sessionId,
      inputId,
      artifactId,
      platform: nullableString(request.body.platform) ?? null,
      metadata: {
        ...metadata,
        origin_type: "app",
        change_type: optionalString(request.body.change_type) ?? "created",
        artifact_type: requiredString(request.body.artifact_type, "artifact_type"),
        external_id: requiredString(request.body.external_id, "external_id"),
      }
    });
    return reply.send({ artifact: sessionArtifactPayload(output) });
  });

  app.get("/api/v1/agent-sessions/:sessionId/artifacts", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    const profileId = optionalString(query.profile_id);
    if (workspaceId && profileId && workspaceId !== profileId) {
      return sendError(reply, 422, "workspace_id and profile_id must match when both are provided");
    }
    const resolvedWorkspaceId = workspaceId ?? profileId;
    if (!resolvedWorkspaceId) {
      return sendError(reply, 422, "workspace_id or profile_id is required");
    }
    const items = store
      .listOutputs({
        workspaceId: resolvedWorkspaceId,
        sessionId: params.sessionId,
        limit: 500,
        offset: 0,
      })
      .filter((item) => item.sessionId === params.sessionId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt ?? "") || 0;
        const rightTime = Date.parse(right.createdAt ?? "") || 0;
        if (leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        return left.id.localeCompare(right.id);
      })
      .map((item: OutputRecord) => sessionArtifactPayload(item));
    return { items, count: items.length };
  });

  app.get("/api/v1/agent-sessions/by-workspace/:workspaceId/with-artifacts", async (request) => {
    const params = request.params as { workspaceId: string };
    const query = isRecord(request.query) ? request.query : {};
    const limit = Math.max(1, Math.min(100, optionalInteger(query.limit, 20)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const runtimeStates = store.listRuntimeStates(params.workspaceId).slice(offset, offset + limit);
    const outputs = store.listOutputs({
      workspaceId: params.workspaceId,
      limit: 1000,
      offset: 0,
    })
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt ?? "") || 0;
        const rightTime = Date.parse(right.createdAt ?? "") || 0;
        if (leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        return left.id.localeCompare(right.id);
      });
    const artifactsBySession = new Map<string, Array<Record<string, unknown>>>();
    for (const output of outputs) {
      const sessionId = output.sessionId ?? "";
      if (!sessionId) {
        continue;
      }
      const existing = artifactsBySession.get(sessionId);
      const payload = sessionArtifactPayload(output);
      if (existing) {
        existing.push(payload);
      } else {
        artifactsBySession.set(sessionId, [payload]);
      }
    }
    const items = runtimeStates.map((row) => {
      const lastTurnResult =
        store.listTurnResults({
          workspaceId: params.workspaceId,
          sessionId: row.sessionId,
          limit: 1,
          offset: 0,
        })[0] ?? null;
      const hasQueuedInputs = store.hasAvailableInputsForSession({
        workspaceId: params.workspaceId,
        sessionId: row.sessionId,
      });
      return {
        ...runtimeStateListItemPayload({
          record: row,
          lastTurnResult,
          hasQueuedInputs,
        }),
        artifacts: artifactsBySession.get(row.sessionId) ?? [],
      };
    });
    return { items, count: items.length };
  });

  app.get("/api/v1/output-folders", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    return {
      items: store.listOutputFolders({ workspaceId }).map((item: OutputFolderRecord) => outputFolderPayload(item))
    };
  });

  app.post("/api/v1/output-folders", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const folder = store.createOutputFolder({
      workspaceId: requiredString(request.body.workspace_id, "workspace_id"),
      name: requiredString(request.body.name, "name")
    });
    return { folder: outputFolderPayload(folder) };
  });

  app.get("/api/v1/output-folders/:folderId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { folderId: string };
    const folder = store.getOutputFolder({ workspaceId, folderId: params.folderId });
    if (!folder) {
      return sendError(reply, 404, "Folder not found");
    }
    return { folder: outputFolderPayload(folder) };
  });

  app.patch("/api/v1/output-folders/:folderId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { folderId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const folder = store.updateOutputFolder({
      workspaceId,
      folderId: params.folderId,
      name: nullableString(request.body.name),
      position:
        request.body.position === undefined || request.body.position === null
          ? undefined
          : optionalInteger(request.body.position, 0)
    });
    if (!folder) {
      return sendError(reply, 404, "Folder not found");
    }
    return { folder: outputFolderPayload(folder) };
  });

  app.delete("/api/v1/output-folders/:folderId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { folderId: string };
    const deleted = store.deleteOutputFolder({ workspaceId, folderId: params.folderId });
    if (!deleted) {
      return sendError(reply, 404, "Folder not found");
    }
    return { deleted: true };
  });

  app.get("/api/v1/outputs", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const items = store.listOutputs({
      workspaceId,
      outputType: optionalString(query.output_type) ?? null,
      status: optionalString(query.status) ?? null,
      platform: optionalString(query.platform) ?? null,
      folderId: optionalString(query.folder_id) ?? null,
      sessionId: optionalString(query.session_id) ?? null,
      inputId: optionalString(query.input_id) ?? null,
      limit: Math.max(1, Math.min(200, optionalInteger(query.limit, 50))),
      offset: Math.max(0, optionalInteger(query.offset, 0))
    });
    return { items: items.map((item: OutputRecord) => outputPayload(item)) };
  });

  app.get("/api/v1/outputs/counts", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    return store.getOutputCounts({ workspaceId });
  });

  app.get("/api/v1/outputs/:outputId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { outputId: string };
    const output = store.getOutput({ workspaceId, outputId: params.outputId });
    if (!output) {
      return sendError(reply, 404, "Output not found");
    }
    return { output: outputPayload(output) };
  });

  app.post("/api/v1/outputs", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const moduleId = nullableString(request.body.module_id) ?? null;
    const metadata = optionalDict(request.body.metadata) ?? {};
    if (moduleId && !metadata.origin_type) {
      metadata.origin_type = "app";
    }
    const output = store.createOutput({
      workspaceId: requiredString(request.body.workspace_id, "workspace_id"),
      outputType: requiredString(request.body.output_type, "output_type"),
      title: optionalString(request.body.title) ?? "",
      status: optionalString(request.body.status) ?? "draft",
      moduleId,
      moduleResourceId: nullableString(request.body.module_resource_id) ?? null,
      filePath: nullableString(request.body.file_path) ?? null,
      htmlContent: nullableString(request.body.html_content) ?? null,
      sessionId: nullableString(request.body.session_id) ?? null,
      inputId: nullableString(request.body.input_id) ?? null,
      artifactId: nullableString(request.body.artifact_id) ?? null,
      folderId: nullableString(request.body.folder_id) ?? null,
      platform: nullableString(request.body.platform) ?? null,
      metadata
    });
    return { output: outputPayload(output) };
  });

  app.patch("/api/v1/outputs/:outputId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { outputId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    let patchMetadata: Record<string, unknown> | undefined;
    if (hasOwn(request.body, "metadata")) {
      const incoming = optionalDict(request.body.metadata) ?? {};
      // Preserve origin_type from existing output if not provided in the patch,
      // so that app updates don't accidentally strip it.
      const existing = store.getOutput({ workspaceId, outputId: params.outputId });
      if (existing && !incoming.origin_type && existing.metadata.origin_type) {
        incoming.origin_type = existing.metadata.origin_type;
      }
      // Also preserve artifact_type and change_type
      if (existing && !incoming.artifact_type && existing.metadata.artifact_type) {
        incoming.artifact_type = existing.metadata.artifact_type;
      }
      if (existing && !incoming.change_type && existing.metadata.change_type) {
        incoming.change_type = existing.metadata.change_type;
      }
      patchMetadata = incoming;
    }
    const output = store.updateOutput({
      workspaceId,
      outputId: params.outputId,
      title: nullableString(request.body.title),
      status: nullableString(request.body.status),
      moduleResourceId: nullableString(request.body.module_resource_id),
      filePath: nullableString(request.body.file_path),
      htmlContent: nullableString(request.body.html_content),
      metadata: patchMetadata,
      folderId: nullableString(request.body.folder_id)
    });
    if (!output) {
      return sendError(reply, 404, "Output not found");
    }
    return { output: outputPayload(output) };
  });

  app.delete("/api/v1/outputs/:outputId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { outputId: string };
    const deleted = store.deleteOutput({ workspaceId, outputId: params.outputId });
    if (!deleted) {
      return sendError(reply, 404, "Output not found");
    }
    return { deleted: true };
  });

  app.get("/api/v1/notifications", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    const sourceType = optionalString(query.source_type);
    const limit = optionalInteger(query.limit, 50);
    const includeCronjobSource = optionalBoolean(
      query.include_cronjob_source,
      false,
    );
    const items = store
      .listRuntimeNotifications({
        workspaceId: workspaceId ?? null,
        sourceType,
        includeDismissed: optionalBoolean(query.include_dismissed, false),
        limit,
        excludeSourceTypes: includeCronjobSource ? [] : ["cronjob"],
      })
      .map((item) => runtimeNotificationPayload(item));
    return { items, count: items.length };
  });

  app.patch("/api/v1/notifications/:notificationId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { notificationId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const updated = store.updateRuntimeNotification({
      workspaceId,
      notificationId: requiredString(params.notificationId, "notificationId"),
      state: nullableString(request.body.state) as "unread" | "read" | "dismissed" | null | undefined
    });
    if (!updated) {
      return sendError(reply, 404, "Notification not found");
    }
    return runtimeNotificationPayload(updated);
  });

  app.get("/api/v1/cronjobs", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const jobs = store
      .listCronjobs({
        workspaceId,
        enabledOnly: optionalBoolean(query.enabled_only, false)
      })
      .map((item: CronjobRecord) => cronjobPayload(item));
    return { jobs, count: jobs.length };
  });

  app.post("/api/v1/cronjobs", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    const job = store.createCronjob({
      workspaceId,
      initiatedBy: requiredString(request.body.initiated_by, "initiated_by"),
      name: optionalString(request.body.name) ?? "",
      cron: requiredString(request.body.cron, "cron"),
      description: requiredString(request.body.description, "description"),
      instruction: optionalString(request.body.instruction) ?? requiredString(request.body.description, "description"),
      enabled: optionalBoolean(request.body.enabled, true),
      delivery: requiredDict(request.body.delivery, "delivery"),
      metadata: optionalDict(request.body.metadata) ?? {},
      nextRunAt: cronjobNextRunAt(requiredString(request.body.cron, "cron"), new Date())
    });
    return cronjobPayload(job);
  });

  app.get("/api/v1/cronjobs/:jobId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    const job = store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!job) {
      return sendError(reply, 404, "Cronjob not found");
    }
    return cronjobPayload(job);
  });

  app.post("/api/v1/cronjobs/:jobId/run", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    const job = store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!job) {
      return sendError(reply, 404, "Cronjob not found");
    }

    const now = new Date();
    try {
      const result = executeLocalCronjobDelivery(
        store,
        job,
        now,
        () => queueWorker?.wake(),
      );
      const updated = store.updateCronjob({
        workspaceId,
        jobId: job.id,
        lastRunAt: now.toISOString(),
        nextRunAt: cronjobNextRunAt(job.cron, now),
        runCount: job.runCount + 1,
        lastStatus: "success",
        lastError: null,
      });
      if (!updated) {
        return sendError(reply, 404, "Cronjob not found");
      }
      return {
        success: true,
        cronjob: cronjobPayload(updated),
        session_id: result.sessionId,
        notification_id: result.notificationId,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "cronjob run failed";
      store.updateCronjob({
        workspaceId,
        jobId: job.id,
        lastRunAt: now.toISOString(),
        nextRunAt: cronjobNextRunAt(job.cron, now),
        lastStatus: "failed",
        lastError: message,
      });
      return sendError(reply, 400, message);
    }
  });

  app.patch("/api/v1/cronjobs/:jobId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { jobId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const existing = store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!existing) {
      return sendError(reply, 404, "Cronjob not found");
    }
    if (hasOwn(request.body, "description") && request.body.description != null && optionalString(request.body.description) === undefined) {
      return sendError(reply, 400, "description is required");
    }
    if (hasOwn(request.body, "instruction") && request.body.instruction != null && optionalString(request.body.instruction) === undefined) {
      return sendError(reply, 400, "instruction is required");
    }
    const cron = nullableString(request.body.cron);
    const description = nullableString(request.body.description);
    const explicitInstruction = hasOwn(request.body, "instruction") ? nullableString(request.body.instruction) : undefined;
    const instruction =
      explicitInstruction !== undefined
        ? explicitInstruction
        : description != null && existing.instruction.trim() === existing.description.trim()
          ? description
          : undefined;
    const job = store.updateCronjob({
      workspaceId,
      jobId: params.jobId,
      name: nullableString(request.body.name),
      cron,
      description,
      instruction,
      enabled: hasOwn(request.body, "enabled") ? optionalBoolean(request.body.enabled, false) : null,
      delivery: hasOwn(request.body, "delivery") ? (optionalDict(request.body.delivery) ?? {}) : undefined,
      metadata: hasOwn(request.body, "metadata") ? (optionalDict(request.body.metadata) ?? {}) : undefined,
      nextRunAt: cron == null ? cron : cronjobNextRunAt(cron, new Date())
    });
    if (!job) {
      return sendError(reply, 404, "Cronjob not found");
    }
    return cronjobPayload(job);
  });

  app.delete("/api/v1/cronjobs/:jobId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    const deleted = store.deleteCronjob({ workspaceId, jobId: params.jobId });
    if (!deleted) {
      return sendError(reply, 404, "Cronjob not found");
    }
    return { success: true };
  });

  app.post("/api/v1/workspaces/:workspaceId/automations/import", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const { workspaceId } = params;

    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }

    const automationsPath = path.join(store.workspaceDir(workspaceId), "automations.yaml");
    if (!fs.existsSync(automationsPath)) {
      return { imported: 0, skipped: 0, jobs: [], skipped_details: [] };
    }

    let rawDoc: unknown;
    try {
      rawDoc = yaml.load(fs.readFileSync(automationsPath, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(reply, 400, `automations.yaml parse error: ${message}`);
    }

    if (!isRecord(rawDoc)) {
      return sendError(reply, 400, "automations.yaml must be a mapping at the root");
    }
    if (rawDoc.version !== 1) {
      return sendError(reply, 400, `automations.yaml version must be 1, got: ${String(rawDoc.version)}`);
    }
    if (!Array.isArray(rawDoc.automations)) {
      return sendError(reply, 400, "automations.yaml must have an 'automations' array");
    }

    const body = isRecord(request.body) ? request.body : {};
    const initiatedBy = optionalString(body.initiated_by) ?? "workspace_import";

    // Read installed app names from workspace.yaml (tolerates absence)
    const installedApps = new Set<string>(
      listWorkspaceApplications(store.workspaceDir(workspaceId))
        .map((entry) => (typeof entry.app_id === "string" ? entry.app_id : ""))
        .filter((id) => id.length >= 3)
    );

    const jobs: Record<string, unknown>[] = [];
    const skippedDetails: Record<string, unknown>[] = [];

    for (const rawEntry of rawDoc.automations) {
      if (!isRecord(rawEntry)) {
        skippedDetails.push({ reason: "invalid_entry", detail: "entry is not an object" });
        continue;
      }

      const entryCron = optionalString(rawEntry.cron);
      const entryDescription = optionalString(rawEntry.description);
      const entryDelivery = optionalDict(rawEntry.delivery);

      if (!entryCron) {
        skippedDetails.push({ reason: "missing_field", detail: "cron is required" });
        continue;
      }
      if (!entryDescription) {
        skippedDetails.push({ reason: "missing_field", detail: "description is required" });
        continue;
      }
      if (!entryDelivery || !optionalString(entryDelivery.mode) || !optionalString(entryDelivery.channel)) {
        skippedDetails.push({ reason: "missing_field", detail: "delivery must be an object with mode and channel" });
        continue;
      }

      const entryName = optionalString(rawEntry.name) ?? "";
      const entryInstruction = optionalString(rawEntry.instruction) ?? entryDescription;

      const importKey = createHash("sha1")
        .update(`${entryName}|${entryCron}|${entryInstruction}`)
        .digest("hex");

      const existingJobs = store.listCronjobs({ workspaceId });
      const existing = existingJobs.find((j) => j.metadata.import_key === importKey);

      if (existing) {
        skippedDetails.push({ import_key: importKey, reason: "already_imported", id: existing.id });
        continue;
      }

      // TODO: parse app references from instruction
      const importWarnings: string[] = [];

      const importedMeta: Record<string, unknown> = {
        ...(optionalDict(rawEntry.metadata) ?? {}),
        imported: true,
        author_recommended_enabled: rawEntry.enabled !== false,
        import_key: importKey,
        import_warnings: importWarnings,
      };

      let job: CronjobRecord;
      try {
        job = store.createCronjob({
          workspaceId,
          initiatedBy,
          name: entryName,
          cron: entryCron,
          description: entryDescription,
          instruction: entryInstruction,
          enabled: false,
          delivery: entryDelivery,
          metadata: importedMeta,
          nextRunAt: cronjobNextRunAt(entryCron, new Date()),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        skippedDetails.push({ import_key: importKey, reason: "create_failed", detail: message });
        continue;
      }

      jobs.push(cronjobPayload(job));
    }

    app.log.info(
      { event: "app.automations.import.success", outcome: "success", workspaceId, count: jobs.length, skipped: skippedDetails.length },
      "automations import complete"
    );

    return {
      imported: jobs.length,
      skipped: skippedDetails.length,
      jobs,
      skipped_details: skippedDetails,
    };
  });

  app.get("/api/v1/task-proposals", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const proposals = store.listTaskProposals({ workspaceId }).map((item: TaskProposalRecord) => taskProposalPayload(item));
    return { proposals, count: proposals.length };
  });

  app.get("/api/v1/task-proposals/unreviewed", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const proposals = store
      .listUnreviewedTaskProposals({ workspaceId })
      .map((item: TaskProposalRecord) => taskProposalPayload(item));
    return { proposals, count: proposals.length };
  });

  app.get("/api/v1/task-proposals/unreviewed/stream", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("X-Accel-Buffering", "no");
    reply.type("text/event-stream");

    const stream = Readable.from(
      (async function* () {
        const seenProposalIds = new Set(
          store.listUnreviewedTaskProposals({ workspaceId }).map((item: TaskProposalRecord) => item.proposalId)
        );
        yield sseComment("connected");
        while (true) {
          const proposals = store.listUnreviewedTaskProposals({ workspaceId });
          for (const proposal of proposals) {
            if (seenProposalIds.has(proposal.proposalId)) {
              continue;
            }
            seenProposalIds.add(proposal.proposalId);
            yield [
              "event: insert",
              `id: ${proposal.proposalId}`,
              `data: ${JSON.stringify(taskProposalPayload(proposal))}`
            ].join("\n") + "\n\n";
          }
          yield sseComment("ping");
          await sleep(1000);
        }
      })()
    );
    return reply.send(stream);
  });

  app.post("/api/v1/task-proposals", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    const proposal = store.createTaskProposal({
      proposalId: requiredString(request.body.proposal_id, "proposal_id"),
      workspaceId,
      taskName: requiredString(request.body.task_name, "task_name"),
      taskPrompt: requiredString(request.body.task_prompt, "task_prompt"),
      taskGenerationRationale: requiredString(request.body.task_generation_rationale, "task_generation_rationale"),
      proposalSource: optionalString(request.body.proposal_source) ?? "proactive",
      sourceEventIds: optionalStringList(request.body.source_event_ids),
      createdAt: requiredString(request.body.created_at, "created_at"),
      state: optionalString(request.body.state) ?? "not_reviewed"
    });
    return { proposal: taskProposalPayload(proposal) };
  });

  app.post("/api/v1/task-proposals/:proposalId/accept", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }

    const params = request.params as { proposalId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const proposal = store.getTaskProposal({ workspaceId, proposalId: params.proposalId });
    if (!proposal) {
      return sendError(reply, 404, "Task proposal not found");
    }

    const workspace = store.getWorkspace(proposal.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    if (proposal.state === "dismissed") {
      return sendError(reply, 409, "Task proposal has already been dismissed");
    }
    if (proposal.state === "accepted" && proposal.acceptedSessionId && proposal.acceptedInputId) {
      return sendError(reply, 409, "Task proposal has already been accepted");
    }

    const blockingApps = blockingWorkspaceApps({ store, workspaceId: proposal.workspaceId });
    if (blockingApps.length > 0) {
      return sendError(reply, 409, blockingWorkspaceAppsMessage(blockingApps));
    }

    const taskName = requiredString(request.body.task_name ?? proposal.taskName, "task_name");
    const taskPrompt = requiredString(request.body.task_prompt ?? proposal.taskPrompt, "task_prompt");
    const sessionId = optionalString(request.body.session_id) ?? `subagent-${randomUUID()}`;
    const parentSessionId =
      nullableString(request.body.parent_session_id) ??
      preferredWorkspaceSessionId({ store, workspace }) ??
      null;
    const priority = optionalInteger(request.body.priority, 0);
    const requestedModel = nullableString(request.body.model) ?? null;
    const effectiveModel = resolveSubagentExecutionModel({
      selectedModel: requestedModel,
    });
    const createdBy = nullableString(request.body.created_by) ?? "workspace_user";
    const subagentId = randomUUID();

    if (store.getSession({ workspaceId: proposal.workspaceId, sessionId })) {
      return sendError(reply, 409, "session_id is already in use");
    }
    if (
      parentSessionId &&
      !store.getSession({
        workspaceId: proposal.workspaceId,
        sessionId: parentSessionId,
      })
    ) {
      return sendError(reply, 404, "parent session not found");
    }

    const evolveCandidate =
      proposal.proposalSource === "evolve"
        ? store.getEvolveSkillCandidateByTaskProposalId({
            workspaceId: proposal.workspaceId,
            proposalId: proposal.proposalId,
          })
        : null;
    let evolveCandidateMarkdown: string | null = null;
    if (evolveCandidate) {
      try {
        const draft = await memoryService.get({
          workspace_id: proposal.workspaceId,
          path: evolveCandidate.skillPath,
        });
        evolveCandidateMarkdown = typeof draft.text === "string" ? draft.text : null;
      } catch {
        evolveCandidateMarkdown = null;
      }
    }

    const session = store.ensureSession({
      workspaceId: proposal.workspaceId,
      sessionId,
      kind: "subagent",
      title: taskName,
      parentSessionId,
      sourceProposalId: proposal.proposalId,
      createdBy
    });
    if (!store.getBinding({ workspaceId: proposal.workspaceId, sessionId })) {
      store.upsertBinding({
        workspaceId: proposal.workspaceId,
        sessionId,
        harness: resolvedWorkspaceHarness(workspace),
        harnessSessionId: sessionId
      });
    }
    store.ensureRuntimeState({
      workspaceId: proposal.workspaceId,
      sessionId,
      status: "QUEUED"
    });

    const record = store.enqueueInput({
      workspaceId: proposal.workspaceId,
      sessionId,
      priority,
      payload: {
        text: taskPrompt,
        attachments: [],
        image_urls: [],
        model: effectiveModel,
        context: {
          source: "task_proposal",
          source_type: "task_proposal",
          proposal_id: proposal.proposalId,
          proposal_source: proposal.proposalSource,
          subagent_id: subagentId,
          parent_session_id: parentSessionId,
          origin_main_session_id: parentSessionId,
          owner_main_session_id: parentSessionId,
          task_title: taskName,
          goal: taskPrompt,
          evolve_candidate: evolveCandidate
            ? {
                candidate_id: evolveCandidate.candidateId,
                kind: evolveCandidate.kind,
                title: evolveCandidate.title,
                summary: evolveCandidate.summary,
                slug: evolveCandidate.slug,
                skill_path: evolveCandidate.skillPath,
                target_skill_path: promotedWorkspaceSkillPath(evolveCandidate.slug),
                skill_markdown: typeof evolveCandidateMarkdown === "string" ? evolveCandidateMarkdown : null,
                task_proposal_id: evolveCandidate.taskProposalId,
              }
            : null,
        }
      }
    });
    store.createSubagentRun({
      subagentId,
      workspaceId: proposal.workspaceId,
      parentSessionId,
      parentInputId: null,
      originMainSessionId: parentSessionId ?? sessionId,
      ownerMainSessionId: parentSessionId ?? sessionId,
      childSessionId: sessionId,
      initialChildInputId: record.inputId,
      currentChildInputId: record.inputId,
      latestChildInputId: record.inputId,
      title: taskName,
      goal: taskPrompt,
      context: null,
      sourceType: "task_proposal",
      sourceId: proposal.proposalId,
      proposalId: proposal.proposalId,
      toolProfile: {
        requested_tools: ["terminal", "file", "browser", "web"],
      },
      requestedModel,
      effectiveModel,
      status: "queued",
      lastEventAt: utcNowIso(),
    });
    store.updateRuntimeState({
      workspaceId: proposal.workspaceId,
      sessionId,
      status: "QUEUED",
      currentInputId: record.inputId,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null
    });

    const updatedProposal = store.updateTaskProposal({
      workspaceId: proposal.workspaceId,
      proposalId: proposal.proposalId,
      fields: {
        taskName,
        taskPrompt,
        state: "accepted",
        acceptedSessionId: sessionId,
        acceptedInputId: record.inputId,
        acceptedAt: utcNowIso()
      }
    });
    if (evolveCandidate) {
      store.updateEvolveSkillCandidate({
        workspaceId: evolveCandidate.workspaceId,
        candidateId: evolveCandidate.candidateId,
        fields: {
          status: "accepted",
          acceptedAt: updatedProposal?.acceptedAt ?? utcNowIso(),
        }
      });
    }
    queueWorker?.wake();

    return reply.send({
      proposal: taskProposalPayload(updatedProposal ?? proposal),
      session: agentSessionPayload(session, store),
      input: {
        input_id: record.inputId,
        session_id: record.sessionId,
        status: record.status
      }
    });
  });

  app.get("/api/v1/task-proposals/:proposalId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { proposalId: string };
    const proposal = store.getTaskProposal({ workspaceId, proposalId: params.proposalId });
    if (!proposal) {
      return sendError(reply, 404, "Task proposal not found");
    }
    return { proposal: taskProposalPayload(proposal) };
  });

  app.patch("/api/v1/task-proposals/:proposalId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { proposalId: string };
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const proposal = store.updateTaskProposalState({
      workspaceId,
      proposalId: params.proposalId,
      state: requiredString(request.body.state, "state")
    });
    if (!proposal) {
      return sendError(reply, 404, "Task proposal not found");
    }
    if (proposal.proposalSource === "evolve" && proposal.state === "dismissed") {
      const candidate = store.getEvolveSkillCandidateByTaskProposalId({
        workspaceId: proposal.workspaceId,
        proposalId: proposal.proposalId,
      });
      if (candidate) {
        store.updateEvolveSkillCandidate({
          workspaceId: candidate.workspaceId,
          candidateId: candidate.candidateId,
          fields: {
            status: "dismissed",
            dismissedAt: utcNowIso(),
          }
        });
      }
    }
    return { proposal: taskProposalPayload(proposal) };
  });

  app.get("/api/v1/memory-update-proposals", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const state = optionalString(query.state) as MemoryUpdateProposalRecord["state"] | null;
    const proposals = store.listMemoryUpdateProposals({
      workspaceId,
      sessionId: optionalString(query.session_id),
      inputId: optionalString(query.input_id),
      state,
      limit: optionalInteger(query.limit, 200),
      offset: optionalInteger(query.offset, 0),
    });
    return {
      proposals: proposals.map((item) => memoryUpdateProposalPayload(item)),
      count: proposals.length,
    };
  });

  app.post("/api/v1/memory-update-proposals/:proposalId/accept", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const params = request.params as { proposalId: string };
    const workspaceId = requiredString(body.workspace_id, "workspace_id");
    const proposal = store.getMemoryUpdateProposal({ workspaceId, proposalId: params.proposalId });
    if (!proposal) {
      return sendError(reply, 404, "Memory update proposal not found");
    }
    if (proposal.state === "dismissed") {
      return sendError(reply, 409, "Memory update proposal has already been dismissed");
    }
    if (proposal.state === "accepted") {
      return sendError(reply, 409, "Memory update proposal has already been accepted");
    }

    const acceptedAt = utcNowIso();
    const summary = requiredString(body.summary ?? proposal.summary, "summary");
    let persistedMemoryId: string | null = null;

    if (proposal.proposalKind === "preference") {
      const candidate = durableMemoryCandidateFromAcceptedProposal({
        proposal,
        summary,
        acceptedAt,
      });
      if (!candidate) {
        return sendError(reply, 422, "Unsupported preference proposal");
      }
      await persistDurableMemoryCandidate({
        store,
        memoryService,
        workspaceId: proposal.workspaceId,
        sessionId: proposal.sessionId,
        inputId: proposal.inputId,
        candidate,
      });
      await refreshMemoryIndexes({
        store,
        memoryService,
        workspaceId: proposal.workspaceId,
      });
      persistedMemoryId = candidate.memoryId;
    } else if (proposal.proposalKind === "profile") {
      const profileUpdate = runtimeUserProfileUpdateFromAcceptedProposal({ proposal });
      if (!profileUpdate) {
        return sendError(reply, 422, "Unsupported profile proposal");
      }
      const profile = store.upsertRuntimeUserProfile(profileUpdate);
      persistedMemoryId = `runtime-profile:${profile.profileId}`;
    } else {
      return sendError(reply, 422, "Unsupported memory proposal kind");
    }

    const updatedProposal = store.updateMemoryUpdateProposal({
      workspaceId: proposal.workspaceId,
      proposalId: proposal.proposalId,
      fields: {
        summary,
        state: "accepted",
        persistedMemoryId,
        acceptedAt,
        dismissedAt: null,
      },
    });
    return {
      proposal: memoryUpdateProposalPayload(updatedProposal ?? proposal),
    };
  });

  app.post("/api/v1/memory-update-proposals/:proposalId/dismiss", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const workspaceId = requiredString(body.workspace_id, "workspace_id");
    const params = request.params as { proposalId: string };
    const proposal = store.getMemoryUpdateProposal({ workspaceId, proposalId: params.proposalId });
    if (!proposal) {
      return sendError(reply, 404, "Memory update proposal not found");
    }
    if (proposal.state === "accepted") {
      return sendError(reply, 409, "Memory update proposal has already been accepted");
    }
    if (proposal.state === "dismissed") {
      return sendError(reply, 409, "Memory update proposal has already been dismissed");
    }
    const updatedProposal = store.updateMemoryUpdateProposal({
      workspaceId: proposal.workspaceId,
      proposalId: proposal.proposalId,
      fields: {
        state: "dismissed",
        dismissedAt: utcNowIso(),
      },
    });
    return {
      proposal: memoryUpdateProposalPayload(updatedProposal ?? proposal),
    };
  });

  app.get("/api/v1/agent-sessions/:sessionId/outputs/events", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const inputId = optionalString(query.input_id);
    const includeHistory = optionalBoolean(query.include_history, true);
    const includeNative = optionalBoolean(query.include_native, false);
    const excludedEventTypes = includeNative ? [] : DEFAULT_EXCLUDED_SESSION_OUTPUT_EVENT_TYPES;
    let afterEventId = Math.max(0, optionalInteger(query.after_event_id, 0));
    if (!includeHistory && afterEventId <= 0) {
      afterEventId = store.latestOutputEventId({
        workspaceId,
        sessionId: params.sessionId,
        inputId,
        excludedEventTypes
      });
    }

    const items = store
      .listOutputEvents({
        workspaceId,
        sessionId: params.sessionId,
        inputId,
        includeHistory: true,
        afterEventId,
        excludedEventTypes
      })
      .map((item: OutputEventRecord) => outputEventPayload(item));
    return {
      items,
      count: items.length,
      last_event_id: items.reduce<number>(
        (maxId: number, item: Record<string, unknown>) => Math.max(maxId, Number(item.id)),
        afterEventId
      )
    };
  });

  app.get("/api/v1/agent-sessions/:sessionId/outputs/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const inputId = optionalString(query.input_id);
    const includeHistory = optionalBoolean(query.include_history, true);
    const includeNative = optionalBoolean(query.include_native, false);
    const excludedEventTypes = includeNative ? [] : DEFAULT_EXCLUDED_SESSION_OUTPUT_EVENT_TYPES;
    const stopOnTerminal = optionalBoolean(query.stop_on_terminal, true);

    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("X-Accel-Buffering", "no");
    reply.type("text/event-stream");

    const stream = Readable.from(
      (async function* () {
        let lastEventId = includeHistory
          ? 0
          : store.latestOutputEventId({
              workspaceId,
              sessionId: params.sessionId,
              inputId,
              excludedEventTypes
            });
        yield sseComment("connected");

        while (true) {
          const events = store.listOutputEvents({
            workspaceId,
            sessionId: params.sessionId,
            inputId,
            includeHistory: true,
            afterEventId: lastEventId,
            excludedEventTypes
          });

          if (events.length > 0) {
            for (const event of events) {
              lastEventId = Math.max(lastEventId, event.id);
              yield sseEvent(event);
              if (stopOnTerminal && TERMINAL_EVENT_TYPES.has(event.eventType)) {
                return;
              }
            }
            continue;
          }

          await sleep(DEFAULT_POLL_INTERVAL_MS);
        }
      })()
    );

    return reply.send(stream);
  });

  return app;
}
