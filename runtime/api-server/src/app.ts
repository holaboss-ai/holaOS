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

import {
  type AgentSessionRecord,
  type AppBuildRecord,
  type AppCatalogEntryRecord,
  type CronjobRecord,
  type IssueAttachmentRecord,
  type IssueBlockedByRecord,
  type IssueRecord,
  type MemoryEntryType,
  type MemoryUpdateProposalRecord,
  type OutputFolderRecord,
  type OutputRecord,
  type RuntimeNotificationRecord,
  type SessionMessageRecord,
  type SessionRuntimeStateRecord,
  type OutputEventRecord,
  type TerminalSessionStatus,
  type TurnRequestSnapshotRecord,
  type TurnResultRecord,
  type RuntimeUserProfileRecord,
  normalizeIssueBlockedByRelation,
  RuntimeStateStore,
  utcNowIso,
  type WorkspaceProjectRecord,
  type WorkspaceRecord
} from "@holaboss/runtime-state-store";
import { recordDurableMemoryFromInput } from "./turn-memory-writeback.js";
import {
  mountRemoteApi,
  NotificationsServiceError,
  CronjobsServiceError,
  CapabilitiesServiceError,
  ChannelsServiceError,
  type OutputRecord as RemoteOutputRecord,
  type NotificationRecord as RemoteNotificationRecord,
  type CronjobRecord as RemoteCronjobRecord,
  type CapabilityCatalogEntry as RemoteCapabilityCatalogEntry,
  type ChannelConnection as RemoteChannelConnection,
  type WorkspaceCapability as RemoteWorkspaceCapability,
  type RemoteApiLogger,
  type RemoteApiContext,
} from "@holaboss/remote-api/server";
import { mountRemoteApiMcp } from "@holaboss/remote-api/mcp";
import { mountRuntimeToolsMcp } from "./runtime-tools-mcp.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";

// Org-owned sessions: the org active RIGHT NOW (from runtime-config.json, which
// the desktop keeps current on every org switch). Stamped onto a session at
// creation so all its runs bill this org regardless of later switches. Null =
// unattributed (the run falls back to the live runtime-config org).
function currentActiveOrgId(): string | null {
  return (
    resolveProductRuntimeConfig({
      requireAuth: false,
      requireUser: false,
      requireBaseUrl: false,
    }).orgId ?? null
  );
}
import {
  ChannelRuntimeManager,
  CompositeChannelConfigClient,
  EnvChannelConfigClient,
  beginDingtalkRegistration,
  beginFeishuRegistration,
  beginWechatRegistration,
  createDefaultConnectorFactory,
  pollDingtalkRegistration,
  pollFeishuRegistration,
  pollWechatRegistration,
  validateDiscordToken,
  validateQQCredentials,
  validateSlackTokens,
  validateTelegramToken,
  validateWecomCredentials,
} from "@holaboss/runtime-channel-gateway";
import { createChannelRuntimePort } from "./channels/runtime-port.js";
import {
  createDingtalkConnection,
  createDiscordConnection,
  createFeishuConnection,
  createQQConnection,
  createSlackConnection,
  createTelegramConnection,
  createWechatConnection,
  createWecomConnection,
  deleteConnection as deleteChannelConnection,
  listConnectionViews,
  setConnectionHarness as setChannelConnectionHarness,
  setConnectionModel as setChannelConnectionModel,
  type ConnectionView,
} from "./channels/connection-service.js";
import { createStoreChannelConfigClient } from "./channels/store-config-client.js";

import {
  type QueueWorkerLike,
  RuntimeQueueWorker,
  runtimeQueueWorkerClaimedBy,
} from "./queue-worker.js";
import {
  type DurableMemoryWorkerLike,
  RuntimeEvolveWorker,
} from "./evolve-worker.js";
import {
} from "./interaction-memory.js";
import {
  type CronWorkerLike,
  cronjobMetadataWithResolvedTimezone,
  RuntimeCronWorker,
  cronjobNextRunAt,
  runtimeUserTimezone,
} from "./cron-worker.js";
import {
  type MainSessionEventWorkerLike,
  RuntimeMainSessionEventWorker,
} from "./main-session-event-worker.js";
import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";
import {
  startRuntimeDbMaintenanceLoop,
  IDLE_DB_MAINTENANCE_PROGRESS,
  type DbMaintenanceProgress,
} from "./db-maintenance.js";
import {
  appendBootRecord,
  classifyBoot,
  parseBootHistory,
  phaseBudgetMs,
  phaseOverBudget,
  type BootAlarm,
  type BootRecord,
} from "./boot-telemetry.js";
import {
  type RecallEmbeddingBackfillWorkerLike,
  RuntimeRecallEmbeddingBackfillWorker,
} from "./recall-embedding-backfill-worker.js";
import { normalizeHarnessId, resolveRuntimeHarnessPlugin } from "./harness-registry.js";
import { assertPublicHttpUrl, ssrfSafeFetch } from "./ssrf-guard.js";
import { testHarnessConnectionViaHost } from "./harness-model-discovery.js";
import { pickDefaultHarness } from "./harness-availability.js";
import type { ComposioApiClientErrorInfo } from "./composio-api-client.js";
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
import { resolveMemoryFilePath } from "./workspace-bundle-paths.js";
import { resolveCanonicalWorkspaceId } from "./canonical-workspace.js";
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
import {
  buildMemoryBrowserGraph,
  buildMemoryBrowserTree,
  readMemoryBrowserNodeDetail,
  readMemoryBrowserFile,
} from "./memory-browser.js";
import {
  DECLINE_PROPOSALS_EVENT_TYPE,
  resumePendingIntegrationInputs,
} from "./integration-proposal-gate.js";
import { OAuthService } from "./oauth-service.js";
import { ComposioService } from "./composio-service.js";
import { ComposioSchemaCache, primeComposioSchemaCache } from "./composio-schema-cache.js";
import { isInStoreCatalog } from "./integration-store-catalog.js";
import { removeComposioMcpRegistryEntry } from "./composio-tool-registry.js";
import { executeComposioInlineTool } from "./composio-inline-execution.js";
import { createComposioApiClientFromEnv } from "./composio-api-client.js";
import { setRemoteComposioSource } from "./composio-remote-source.js";
import {
  type RemoteComposioSource,
  resolveActiveToolkitConnectionsRemoteFirst,
} from "./composio-toolkit-resolver.js";
import { fireCronjob } from "./cronjob-runtime.js";
import { listStoreCatalog } from "./integration-store-catalog.js";
import { WorkspaceIntegrationsService } from "./workspace-integrations.js";
import {
  parseStoredUserQuestion,
  RuntimeAgentToolsService,
  RuntimeAgentToolsServiceError,
  withCronjobAgentTimeHints,
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
  listWorkspaceMcpRegistryServers,
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
import { loadCapabilityCatalog, installCapability, uninstallCapability, setCapabilityEnabled } from "./workspace-capabilities.js";
import { clearMcpOAuthToken } from "../../harnesses/src/index.js";
import { materializeSkill } from "./workspace-skills-catalog.js";
import { importSkillFromGithub, importSkillFromUpload, previewSkillFromGithub, SkillImportError } from "./workspace-skill-import.js";
import { importPluginAsCapability } from "./import-plugin.js";
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
} from "./user-memory-proposals.js";
import {
  parseOnboardingAlignmentReport,
  sanitizeOnboardingAlignmentReport,
} from "../../../shared/onboarding-contract.js";

// Fallback wake interval for the output-event SSE stream. The stream normally
// wakes on write via store.waitForOutputEvent's in-process signal; this bounds
// worst-case latency if a signal is ever missed (e.g. an out-of-process writer)
// without busy-polling. Kept off the hot path, so it's a safety net, not the
// streaming cadence.
const STREAM_IDLE_FALLBACK_MS = 250;
// How often the boot watchdog checks the in-flight phase against its budget.
// A second is far below every budget, so the warning lands promptly, and the
// timer is unref'd and cleared at `ready` — it costs nothing after boot.
const BOOT_WATCHDOG_INTERVAL_MS = 1_000;
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
  recallEmbeddingBackfillWorker?: RecallEmbeddingBackfillWorkerLike | null;
  appLifecycleExecutor?: AppLifecycleExecutorLike;
  memoryService?: MemoryServiceLike;
  runtimeConfigService?: RuntimeConfigServiceLike;
  browserToolService?: DesktopBrowserToolServiceLike;
  terminalSessionManager?: TerminalSessionManagerLike | null;
  runnerExecutor?: RunnerExecutorLike;
  enableAppHealthMonitor?: boolean;
  startAppsOnReady?: boolean;
  /**
   * Run the background DB retention/compaction sweep on ready. Defaults to on;
   * set false for embedded/test servers that shouldn't mutate the event log.
   */
  enableDbMaintenance?: boolean;
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
    // The `session_checkpoint` post-run job was the only post_run_job type; it was
    // removed with the runtime-owned compaction layer (pi now owns compaction). No
    // post-run job types remain. See
    // docs/plans/2026-07-12-pi-native-compaction-migration.md.
    executeClaimedJob: async () => {},
  });
}

function resolveCronWorker(
  options: BuildRuntimeApiServerOptions,
  app: FastifyInstance,
  store: RuntimeStateStore,
  queueWorker: QueueWorkerLike | null,
): CronWorkerLike | null {
  if (options.cronWorker !== undefined) {
    return options.cronWorker;
  }
  return new RuntimeCronWorker({
    store,
    logger: app.log,
    queueWorker,
  });
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

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
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
  imageUrls: readonly string[] = [],
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
  if (imageUrls.length === 1) {
    return "Image input";
  }
  if (imageUrls.length > 1) {
    return normalizedSessionTitleSnippet(`${imageUrls.length} image inputs`);
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

/** Parse an optional numeric query value (string or number). Returns null when
 * absent or unparseable; downstream callers floor/validate range. */
function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
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

function optionalCapabilityActorId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string | undefined {
  return (
    headerString(params.headers, "x-holaboss-actor") ||
    optionalString(params.query?.actor) ||
    optionalString(params.body?.actor) ||
    undefined
  );
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
}): "agent" | null {
  const value =
    headerString(params.headers, "x-holaboss-browser-space") ||
    optionalString(params.query?.browser_space) ||
    optionalString(params.body?.browser_space) ||
    "";
  return value === "agent" ? value : null;
}

function capabilityBrowserProfileId(params: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): string {
  return (
    headerString(params.headers, "x-holaboss-browser-profile-id") ||
    optionalString(params.query?.browser_profile_id) ||
    optionalString(params.body?.browser_profile_id) ||
    ""
  );
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

function cronjobMetadataWithRequestDefaults(params: {
  body: Record<string, unknown>;
  existingMetadata?: Record<string, unknown> | null;
  fallbackTimezone?: string | null;
}): Record<string, unknown> {
  const metadata = hasOwn(params.body, "metadata")
    ? { ...(optionalDict(params.body.metadata) ?? {}) }
    : { ...((params.existingMetadata ?? {}) as Record<string, unknown>) };
  delete metadata.model;

  if (hasOwn(params.body, "session_id")) {
    const sourceSessionId = nullableString(params.body.session_id);
    if (sourceSessionId) {
      metadata.source_session_id = sourceSessionId;
    } else {
      delete metadata.source_session_id;
    }
  } else if (typeof metadata.source_session_id !== "string") {
    const sourceSessionId = optionalString(params.body.session_id);
    if (sourceSessionId) {
      metadata.source_session_id = sourceSessionId;
    }
  }

  return cronjobMetadataWithResolvedTimezone(metadata, params.fallbackTimezone);
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
  blockedBy?: IssueBlockedByRecord[] | null;
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const goal = nullableString(value.goal);
  if (!goal) {
    return null;
  }
  return {
    blockedBy: parseIssueBlockedByInput(value.blocked_by),
    title: nullableString(value.title) ?? null,
    goal,
    context: nullableString(value.context) ?? null,
    tools: optionalStringList(value.tools),
    model: nullableString(value.model) ?? null,
    timeoutMs:
      typeof value.timeout_ms === "number" && Number.isFinite(value.timeout_ms)
        ? Math.max(1, Math.trunc(value.timeout_ms))
        : null,
  };
}

function requiredDelegateTaskInputs(body: Record<string, unknown>): Array<{
  blockedBy?: IssueBlockedByRecord[] | null;
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
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

function parseIssueBlockedByInput(value: unknown): IssueBlockedByRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const edges: IssueBlockedByRecord[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const taskId = nullableString(item.task_id ?? item.taskId);
    if (!taskId) {
      continue;
    }
    edges.push({
      taskId,
      relation: normalizeIssueBlockedByRelation(nullableString(item.relation)) ?? "input",
      instruction: nullableString(item.instruction) ?? null,
    });
  }
  return edges;
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

function requiredSessionInputImageUrls(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("image_urls must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`image_urls[${index}] must be a string`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`image_urls[${index}] must be a non-empty string`);
    }
    return trimmed;
  });
}

function attachmentsFromInputPayload(value: unknown): SessionInputAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => parseSessionInputAttachment(item)).filter((item): item is SessionInputAttachmentPayload => Boolean(item));
}

function requiredIssueAttachments(value: unknown, workspaceDir: string): IssueAttachmentRecord[] {
  return requiredSessionInputAttachments(value, workspaceDir).map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mime_type,
    sizeBytes: attachment.size_bytes,
    workspacePath: attachment.workspace_path,
    createdAt: utcNowIso(),
  }));
}

function optionalTrimmedStringArray(
  value: unknown,
  fieldName: string,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new Error(`${fieldName}[${index}] must be a string`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function sessionMessageAttachments(
  store: RuntimeStateStore,
  workspaceId: string,
  message: SessionMessageRecord,
): SessionInputAttachmentPayload[] {
  const metadataAttachments = attachmentsFromInputPayload(message.metadata.attachments);
  if (metadataAttachments.length > 0) {
    return metadataAttachments;
  }
  const inputId = message.role === "user" && message.id.startsWith("user-") ? message.id.slice(5) : "";
  if (!inputId) {
    return [];
  }
  return attachmentsFromInputPayload(
    store.getInput({
      workspaceId,
      inputId,
    })?.payload.attachments
  );
}

function workspaceRecordPayload(
  workspace: WorkspaceRecord,
  workspacePath?: string | null,
  folderState?: "healthy" | "missing" | null,
  store?: RuntimeStateStore,
): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    harness: workspace.harness,
    error_message: workspace.errorMessage,
    onboarding_status: workspace.onboardingStatus,
    onboarding_state: workspace.onboardingState ?? null,
    onboarding_session_id: workspace.onboardingSessionId,
    alignment_question:
      store && workspace.onboardingSessionId
        ? (parseStoredUserQuestion(
            store.getSession({
              workspaceId: workspace.id,
              sessionId: workspace.onboardingSessionId,
            })?.activeUserQuestion ?? null,
          ) as unknown) ?? null
        : null,
    alignment_report: parsedWorkspaceAlignmentReportPayload(
      workspace.onboardingAlignmentReport,
    ),
    verification_report: parsedWorkspaceReportPayload(
      workspace.onboardingVerificationReport,
    ),
    onboarding_completed_at: workspace.onboardingCompletedAt,
    onboarding_completion_summary: workspace.onboardingCompletionSummary,
    onboarding_requested_at: workspace.onboardingRequestedAt,
    onboarding_requested_by: workspace.onboardingRequestedBy,
    implementation_activity: null,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    deleted_at_utc: workspace.deletedAtUtc,
    icon: workspace.icon,
    icon_color: workspace.iconColor,
    workspace_role: workspace.workspaceRole,
    source_workspace_id: workspace.sourceWorkspaceId,
    lab_purpose: workspace.labPurpose,
    lab_status: workspace.labStatus,
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

function parsedWorkspaceReportPayload(raw: string | null | undefined): unknown | null {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function parsedWorkspaceAlignmentReportPayload(
  raw: string | null | undefined,
): unknown | null {
  return parseOnboardingAlignmentReport(parsedWorkspaceReportPayload(raw));
}

function serializedWorkspaceAlignmentReport(
  value: unknown,
): string | null {
  if (value == null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("alignment_report must be an object");
  }
  return JSON.stringify(sanitizeOnboardingAlignmentReport(value));
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

function sendStructuredWorkspaceStoreError(reply: FastifyReply, error: unknown): boolean {
  const err = error as Error & { code?: string; workspacePath?: string };
  if (
    err?.code === "workspace_folder_missing" ||
    err?.code === "workspace_identity_write_failed" ||
    err?.code === "workspace_identity_write_busy"
  ) {
    reply.code(409).send({
      detail: err.message,
      code: err.code,
      workspace_path: err.workspacePath ?? null
    });
    return true;
  }
  return false;
}

/**
 * The session's *effective* model, so the desktop composer can reflect the
 * model THIS session actually runs instead of the global "last picked"
 * preference. An automation pins its model on the cronjob
 * (`metadata.selected_model`) — read that so a scheduled GLM run shows GLM even
 * between runs — while any other session follows its most recent model-bearing
 * turn. Returns null when the session has no model of its own yet, so the
 * composer keeps its global default (which seeds new chats).
 */
function resolveSessionSelectedModel(
  record: AgentSessionRecord,
  cronjobId: string | null,
  runtimeStore?: Pick<
    RuntimeStateStore,
    "getLatestInputForSession" | "getCronjob"
  > | null,
): string | null {
  if (!runtimeStore) {
    return null;
  }
  if (cronjobId && typeof runtimeStore.getCronjob === "function") {
    const cronjob = runtimeStore.getCronjob({
      workspaceId: record.workspaceId,
      jobId: cronjobId,
    });
    const pinned = cronjob?.metadata?.selected_model;
    if (typeof pinned === "string" && pinned.trim()) {
      return pinned.trim();
    }
  }
  if (typeof runtimeStore.getLatestInputForSession === "function") {
    const latest = runtimeStore.getLatestInputForSession({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      preferConfiguredModel: true,
      limit: 50,
    });
    const model = latest?.payload?.model;
    if (typeof model === "string" && model.trim()) {
      return model.trim();
    }
  }
  return null;
}

function agentSessionPayload(
  record: AgentSessionRecord,
  runtimeStore?: Pick<
    RuntimeStateStore,
    | "getSubagentRunByChildSession"
    | "getLatestInputForSession"
    | "getCronjob"
  > | null,
): Record<string, unknown> {
  const linkedSubagentRun = runtimeStore?.getSubagentRunByChildSession({
    workspaceId: record.workspaceId,
    childSessionId: record.sessionId,
  });
  const sourceType = linkedSubagentRun?.sourceType ?? null;
  const selectedModel = resolveSessionSelectedModel(
    record,
    linkedSubagentRun?.cronjobId ?? null,
    runtimeStore,
  );
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    kind: record.kind,
    title: record.title,
    parent_session_id: record.parentSessionId,
    created_by: record.createdBy,
    source_type: sourceType,
    cronjob_id: linkedSubagentRun?.cronjobId ?? null,
    proposal_id: linkedSubagentRun?.proposalId ?? null,
    project_id: record.projectId,
    harness_id: record.harnessId,
    selected_model: selectedModel,
    owning_app_id: record.owningAppId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    archived_at: record.archivedAt,
    active_user_question: parseStoredUserQuestion(record.activeUserQuestion),
  };
}

function workspaceProjectPayload(
  record: WorkspaceProjectRecord,
): Record<string, unknown> {
  return {
    workspace_id: record.workspaceId,
    project_id: record.projectId,
    name: record.name,
    project_path: record.projectPath,
    icon: record.icon,
    icon_color: record.iconColor,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
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
  store: RuntimeStateStore;
  record: SessionRuntimeStateRecord;
  lastTurnResult?: TurnResultRecord | null;
  hasQueuedInputs?: boolean;
}): Record<string, unknown> {
  const hasQueuedInputs = params.hasQueuedInputs ?? false;
  return {
    ...runtimeStatePayload(params.record),
    ...effectiveSessionState(params.store, params.record, hasQueuedInputs),
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
    project_id: record.projectId,
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
  const metadata = isRecord(record.metadata) ? { ...record.metadata } : {};
  delete metadata.model;
  return {
    id: record.id,
    workflow_id: record.id,
    workspace_id: record.workspaceId,
    initiated_by: record.initiatedBy,
    name: record.name,
    cron: record.cron,
    description: record.description,
    instruction: record.instruction,
    enabled: record.enabled,
    delivery: record.delivery,
    metadata,
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
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    cronjob_id: record.cronjobId,
    workflow_id: optionalString(metadata.workflow_id) ?? null,
    workflow_run_id: optionalString(metadata.workflow_run_id) ?? null,
    workflow_trigger_kind: optionalString(metadata.workflow_trigger_kind) ?? null,
    source_type: record.sourceType,
    source_label: record.sourceLabel,
    title: record.title,
    message: record.message,
    level: record.level,
    priority: record.priority,
    state: record.state,
    metadata,
    read_at: record.readAt,
    dismissed_at: record.dismissedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function issueAttachmentPayload(record: IssueAttachmentRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    workspace_path: record.workspacePath,
    created_at: record.createdAt,
  };
}

function issuePayload(record: IssueRecord): Record<string, unknown> {
  return {
    issue_id: record.issueId,
    workspace_id: record.workspaceId,
    issue_number: record.issueNumber,
    session_id: record.sessionId,
    blocked_by: record.blockedBy.map((edge) => ({
      task_id: edge.taskId,
      relation: edge.relation,
      instruction: edge.instruction,
    })),
    title: record.title,
    description: record.description,
    status: record.status,
    priority: record.priority,
    blocker_reason: record.blockerReason,
    attachments: record.attachments.map((attachment) => issueAttachmentPayload(attachment)),
    active_subagent_id: record.activeSubagentId,
    latest_subagent_id: record.latestSubagentId,
    created_by: record.createdBy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_at: record.completedAt,
  };
}

function issueDispatchParamsFromBody(body: Record<string, unknown>): {
  parentSessionId?: string | null;
  parentInputId?: string | null;
  originMainSessionId?: string | null;
  ownerMainSessionId?: string | null;
  priority?: number | null;
} {
  return {
    parentSessionId: nullableString(body.parent_session_id) ?? null,
    parentInputId: nullableString(body.parent_input_id) ?? null,
    originMainSessionId: nullableString(body.origin_main_session_id) ?? null,
    ownerMainSessionId: nullableString(body.owner_main_session_id) ?? null,
    priority: hasOwn(body, "dispatch_priority")
      ? (optionalInteger(body.dispatch_priority, 0) ?? null)
      : null,
  };
}

function issueHasIncompleteBlockingTasks(
  store: RuntimeStateStore,
  issue: Pick<IssueRecord, "workspaceId" | "blockedBy">,
): boolean {
  return issue.blockedBy.some((edge) => {
    const blocker = store.getIssue({
      workspaceId: issue.workspaceId,
      issueId: edge.taskId,
    });
    return !blocker || blocker.status !== "done";
  });
}

function resolvedWorkspaceHarness(workspace: WorkspaceRecord): string {
  const harness = (workspace.harness ?? process.env.SANDBOX_AGENT_HARNESS ?? "pi").trim();
  return harness || "pi";
}

/**
 * Validate a user-supplied harness id against the registered plugins.
 * Returns the canonical id on success, null if missing/unknown — the caller
 * is responsible for either falling back to a workspace default or
 * returning a 400. We do not silently coerce unknown ids so a typo in the
 * UI surfaces immediately rather than landing on the wrong harness.
 */
function validateRequestedHarnessId(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  return resolveRuntimeHarnessPlugin(raw)?.id ?? null;
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
  return "main_session";
}

function normalizedPrimaryChatSessionKind(kind: string | null | undefined): string {
  const normalized = (kind ?? "").trim().toLowerCase() || "main_session";
  if (normalized === "workspace_session" || normalized === "main") {
    return "main_session";
  }
  if (normalized === "task_proposal") {
    return "subagent";
  }
  return normalized;
}

function isPrimaryChatSessionKind(kind: string | null | undefined): boolean {
  const normalized = normalizedPrimaryChatSessionKind(kind);
  return normalized === "main_session" || normalized === "onboarding";
}

function canInlineBackgroundUpdatesIntoSessionKind(
  kind: string | null | undefined,
): boolean {
  const normalized = normalizedPrimaryChatSessionKind(kind);
  return normalized === "main_session" || normalized === "onboarding";
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
    conversationKey: "main_session",
    role: "main_session",
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

  return null;
}

function resolveOrCreateWorkspaceMainSession(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
}): {
  session: AgentSessionRecord;
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
      kind: "main_session",
      // Leave title null so the queue-input route fills it from the first
      // user message via `sessionTitleFromFirstUserInput`.
      title: null,
      createdBy: "system",
      orgId: currentActiveOrgId(),
    });

  params.store.upsertConversationBinding({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: session.sessionId,
    role: "main_session",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });

  return { session };
}

/**
 * Resolve the current desktop main session WITHOUT creating one — returns null
 * when the workspace has no primary chat yet. Lets the desktop open a lazy
 * draft (session created on the first sent message) instead of persisting an
 * empty "Untitled" row up front.
 */
function resolveWorkspaceMainSession(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
}): { session: AgentSessionRecord | null } {
  const preferredSessionId = preferredWorkspaceSessionId(params);
  const session = preferredSessionId
    ? params.store.getSession({
        workspaceId: params.workspace.id,
        sessionId: preferredSessionId,
      })
    : null;
  return { session: session ?? null };
}

function resolveSessionWorkspaceScope(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): { workspaceId: string; workspace: WorkspaceRecord } | null {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    return null;
  }
  if (
    params.store.getSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    })
  ) {
    return { workspaceId: params.workspaceId, workspace };
  }
  return { workspaceId: params.workspaceId, workspace };
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
  store: RuntimeStateStore,
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
  const claimedActiveInput = runtimeStateHasClaimedActiveInput(
    store,
    runtimeState,
  );
  let effectiveState = "IDLE";
  if (runtimeStatus && ["BUSY", "WAITING_USER", "ERROR"].includes(runtimeStatus)) {
    effectiveState = runtimeStatus;
  } else if (claimedActiveInput) {
    effectiveState = "BUSY";
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

function destructiveWriteApprovalResponse(detail: string): {
  code: "destructive_write_requires_explicit_approval";
  detail: string;
} {
  return {
    code: "destructive_write_requires_explicit_approval",
    detail
  };
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
  // Symlink containment: the lexical checks above don't stop a symlink INSIDE
  // the workspace from pointing out of it. Realpath the target (or, for a
  // file that doesn't exist yet, its nearest existing ancestor) and re-verify
  // it's still within the workspace root. Reject symlink escapes.
  const realWorkspaceDir = safeRealpath(resolvedWorkspaceDir);
  const realTarget = safeRealpath(fullPath) ?? safeRealpathNearestAncestor(fullPath);
  if (realWorkspaceDir && realTarget) {
    if (
      realTarget !== realWorkspaceDir &&
      !realTarget.startsWith(`${realWorkspaceDir}${path.sep}`)
    ) {
      throw new Error("path traversal not allowed");
    }
  }
  return fullPath;
}

/** realpathSync that returns null when the path doesn't exist / can't be read. */
function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * For a not-yet-existing path, realpath the nearest EXISTING ancestor directory
 * and re-append the remaining (non-existent) segments — so a symlinked parent
 * that escapes the workspace is still caught before a new file is created.
 */
function safeRealpathNearestAncestor(target: string): string | null {
  let current = path.dirname(target);
  const suffixSegments: string[] = [path.basename(target)];
  // Walk up until we find an existing directory (bounded by the filesystem
  // root, which always exists).
  for (let depth = 0; depth < 256; depth += 1) {
    const real = safeRealpath(current);
    if (real) {
      return path.join(real, ...suffixSegments.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    suffixSegments.push(path.basename(current));
    current = parent;
  }
  return null;
}

// outputs table can drift from disk: a user delete in Finder removes the
// file but leaves the row, so the sidebar Output tree keeps showing it.
// Reconcile by stat'ing each file-backed row at read time and dropping
// the ones whose file is gone. Inline-only outputs (no file_path) are
// left alone. Fail-open on any unexpected error so a broken stat doesn't
// hide the entire list.
function reconcileFileBackedOutputs(
  store: RuntimeStateStore,
  workspaceId: string,
  items: OutputRecord[],
): OutputRecord[] {
  if (items.length === 0) return items;
  let workspaceDir: string | null = null;
  try {
    workspaceDir = store.workspaceDir(workspaceId);
  } catch {
    return items;
  }
  if (!workspaceDir) return items;
  const kept: OutputRecord[] = [];
  for (const item of items) {
    const filePath = item.filePath?.trim();
    if (!filePath) {
      kept.push(item);
      continue;
    }
    let absolutePath: string;
    try {
      absolutePath = resolveWorkspaceFilePath(workspaceDir, filePath);
    } catch {
      kept.push(item);
      continue;
    }
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    if (stat) {
      kept.push(item);
      continue;
    }
    try {
      store.deleteOutput({ workspaceId, outputId: item.id });
    } catch {
      // best-effort — leave the row for the next reconcile pass
      kept.push(item);
    }
  }
  return kept;
}

function isPreservedWorkspaceEntryForReplaceExisting(entryName: string): boolean {
  return entryName === ".holaboss" || entryName === "workspace.json";
}

function workspaceReplaceExistingWouldDeleteEntries(workspaceDir: string): boolean {
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!isPreservedWorkspaceEntryForReplaceExisting(entry.name)) {
      return true;
    }
  }
  return false;
}

function isEffectivelyEmptyWorkspaceFileContent(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim().length === 0;
  } catch {
    return false;
  }
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

  const defaultPrefixes: string[] = [];
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

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Resolves when the background boot sequence (workers, health monitor) has
     * finished. `ready()` only covers the point at which the port binds — the
     * workers deliberately start after it so a slow one cannot delay the bind.
     */
    runtimeBootComplete: () => Promise<void>;
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

  // Single-tenant pin — workspace-removal Piece 1. One shared logger for the
  // (defensive) case where more than one source workspace exists; both ingress
  // doorways collapse to the most-recently-updated and announce it here.
  const warnAmbiguousWorkspaces = (workspaceIds: string[]): void => {
    app.log.warn(
      { workspaceIds },
      "multiple source workspaces present; pinning the most-recently-updated",
    );
  };

  // workspace-removal Piece 3: `workspaceId` is gone from the Remote API
  // contract, so the oRPC/MCP services resolve the single workspace server-side
  // instead of trusting a client-supplied id. (The REST capability surface still
  // resolves it via the onRequest header stamp below.)
  const resolveCanonicalWs = (): string =>
    resolveCanonicalWorkspaceId(store, warnAmbiguousWorkspaces);

  // Doorway 1 (REST capability surface): the server, not the caller, decides the
  // workspace. Stamp the canonical id onto every request so the ~60
  // capabilityWorkspaceId() readers — which prefer this header over any
  // query/body value — resolve to the one workspace regardless of what was sent.
  // The oRPC/MCP surface is pinned separately where the context is built below.
  // Removed in Piece 3, when the header is dropped from the protocol.
  app.addHook("onRequest", async (request) => {
    const canonicalWorkspaceId = resolveCanonicalWorkspaceId(store, warnAmbiguousWorkspaces);
    if (canonicalWorkspaceId) {
      request.headers["x-holaboss-workspace-id"] = canonicalWorkspaceId;
    }
  });

  // Security: OPTIONAL bearer-token gate. This is FAIL-OPEN by design — when
  // SANDBOX_RUNTIME_API_TOKEN is unset (the default), no auth is enforced and no
  // internal caller is affected. When ops set the env, every route except the
  // unauthenticated health/readiness probes (polled before an auth header can
  // exist) requires `Authorization: Bearer <token>`. Do NOT make this mandatory.
  const runtimeApiAuthToken = (process.env.SANDBOX_RUNTIME_API_TOKEN ?? "").trim();
  if (runtimeApiAuthToken) {
    // Health/readiness probes stay open — the desktop polls these during boot
    // before the app shell (and thus any auth header) exists.
    const AUTH_EXEMPT_PATHS = new Set<string>([
      "/healthz",
      "/runtime/db-maintenance-status",
      "/runtime/boot-status",
    ]);
    const expectedHeader = `Bearer ${runtimeApiAuthToken}`;
    app.addHook("onRequest", async (request, reply) => {
      // Strip any query string before matching the exempt list.
      const pathname = request.url.split("?", 1)[0];
      if (AUTH_EXEMPT_PATHS.has(pathname)) {
        return;
      }
      if (request.headers.authorization !== expectedHeader) {
        return sendError(reply, 401, "unauthorized");
      }
    });
  }

  // Remote API (oRPC) — mounted at /rpc alongside the REST routes below.
  const remoteApiLogger: RemoteApiLogger = {
    debug: (event, fields) => app.log.debug({ event, ...fields }, event),
    info: (event, fields) => app.log.info({ event, ...fields }, event),
    warn: (event, fields) => app.log.warn({ event, ...fields }, event),
    error: (event, fields) => app.log.error({ event, ...fields }, event),
  };
  // The contract carries camelCase; FilesystemMemoryService reads snake_case.
  const toMemoryServicePayload = (
    input: Record<string, unknown>,
  ): Record<string, unknown> => {
    const { maxResults, minScore, ...rest } = input as {
      maxResults?: number;
      minScore?: number;
    } & Record<string, unknown>;
    return {
      ...rest,
      workspace_id: resolveCanonicalWs(),
      ...(maxResults === undefined ? {} : { max_results: maxResults }),
      ...(minScore === undefined ? {} : { min_score: minScore }),
    };
  };
  // Shared base context for both Remote API bindings — oRPC at /rpc and MCP at
  // /mcp. memoryService is declared below; the factory is lazy (per request), so
  // it is resolved by the time any request arrives. One context, two transports.
  const channelGatewayHolder: { manager: ChannelRuntimeManager | null } = { manager: null };
  const toChannelWire = (view: ConnectionView): RemoteChannelConnection =>
    ({
      connection_id: view.connectionId,
      workspace_id: view.workspaceId,
      platform: view.platform,
      enabled: view.enabled,
      bot_username: view.botUsername,
      allow_from: view.allowFrom,
      require_mention: view.requireMention,
      status: view.status,
      status_detail: view.statusDetail,
      harness: view.harness,
      model: view.model,
      updated_at: view.updatedAt,
    }) as unknown as RemoteChannelConnection;
  const buildRemoteApiBaseContext = (): Omit<
    RemoteApiContext,
    "requestId" | "logger"
  > => ({
      memory: {
        search: (input) => memoryService.search(toMemoryServicePayload(input)),
        get: (input) => memoryService.get(toMemoryServicePayload(input)),
        upsert: (input) => memoryService.upsert(toMemoryServicePayload(input)),
        status: (input) => memoryService.status(toMemoryServicePayload(input)),
        sync: (input) => memoryService.sync(toMemoryServicePayload(input)),
        browseTree: (input) =>
          buildMemoryBrowserTree({
            store,
            workspaceId: resolveCanonicalWs(),
          }) as unknown as Promise<Record<string, unknown>>,
        readFile: (input) =>
          readMemoryBrowserFile({
            store,
            workspaceId: resolveCanonicalWs(),
            targetPath: input.path,
          }) as unknown as Promise<Record<string, unknown>>,
        readNodeDetail: (input) =>
          readMemoryBrowserNodeDetail({
            store,
            workspaceId: resolveCanonicalWs(),
            nodeId: input.nodeId,
            treeId: input.treeId ?? null,
          }) as unknown as Promise<Record<string, unknown>>,
        browseGraph: (input) =>
          buildMemoryBrowserGraph({
            store,
            workspaceId: resolveCanonicalWs(),
            forest: input.forest,
            treeId: input.treeId ?? null,
            maxLayers: input.maxLayers ?? null,
            maxNodes: input.maxNodes ?? null,
          }) as unknown as Promise<Record<string, unknown>>,
        clear: () => {
          const { deletedRows, deletedFiles } = store.clearWorkspaceMemory({
            workspaceId: resolveCanonicalWs(),
          });
          return { ok: true, deleted_rows: deletedRows, deleted_files: deletedFiles };
        },
      },
      outputs: {
        list: (input) => {
          const projectScope = input.projectScope ?? undefined;
          const projectFilter =
            projectScope === undefined
              ? undefined
              : projectScope === "general"
                ? null
                : projectScope;
          const items = store.listOutputs({
            workspaceId: resolveCanonicalWs(),
            projectId: projectFilter,
            outputType: input.outputType ?? null,
            status: input.status ?? null,
            platform: input.platform ?? null,
            folderId: input.folderId ?? null,
            sessionId: input.sessionId ?? null,
            inputId: input.inputId ?? null,
            limit: Math.max(1, Math.min(200, input.limit ?? 50)),
            offset: Math.max(0, input.offset ?? 0),
          });
          const reconciled = reconcileFileBackedOutputs(store, resolveCanonicalWs(), items);
          return {
            items: reconciled.map(
              (item: OutputRecord) =>
                outputPayload(item) as unknown as RemoteOutputRecord,
            ),
          };
        },
      },
      notifications: {
        list: (input) => {
          const items = store
            .listRuntimeNotifications({
              workspaceId: resolveCanonicalWs() ?? null,
              sourceType: input.sourceType ?? undefined,
              includeDismissed: input.includeDismissed ?? false,
              limit: input.limit ?? 50,
              excludeSourceTypes: input.includeCronjobSource ? [] : ["cronjob"],
            })
            .map(
              (item) =>
                runtimeNotificationPayload(item) as unknown as RemoteNotificationRecord,
            );
          return { items, count: items.length };
        },
        update: (input) => {
          const updated = store.updateRuntimeNotification({
            workspaceId: resolveCanonicalWs(),
            notificationId: input.notificationId,
            state: input.state ?? undefined,
          });
          if (!updated) {
            throw new NotificationsServiceError("NOT_FOUND");
          }
          return runtimeNotificationPayload(
            updated,
          ) as unknown as RemoteNotificationRecord;
        },
      },
      cronjobs: {
        list: (input) =>
          runtimeAgentToolsService.listCronjobs({
            workspaceId: resolveCanonicalWs(),
            enabledOnly: input.enabledOnly ?? false,
          }) as unknown as { jobs: RemoteCronjobRecord[]; count: number },
        create: (input) =>
          runtimeAgentToolsService.createCronjob({
            workspaceId: resolveCanonicalWs(),
            sessionId: input.sessionId ?? undefined,
            selectedModel: input.model ?? undefined,
            initiatedBy: input.initiatedBy,
            name: input.name ?? undefined,
            cron: input.cron,
            description: input.description,
            instruction: input.instruction ?? input.description,
            enabled: input.enabled ?? true,
            delivery: optionalCronjobDeliveryInput(input.delivery),
            metadata: input.metadata ?? undefined,
          }) as unknown as RemoteCronjobRecord,
        runNow: async (input) => {
          const outcome = await runCronjobNowOp({
            workspaceId: resolveCanonicalWs(),
            jobId: input.jobId,
            triggeredBy: input.createdBy ?? undefined,
            ownerMainSessionId: input.ownerMainSessionId ?? undefined,
          });
          if (!outcome.ok) {
            if (outcome.status === 404) {
              throw new CronjobsServiceError("NOT_FOUND", {
                message: outcome.message,
              });
            }
            throw new Error(outcome.message);
          }
          return outcome.payload as unknown as {
            success: boolean;
            cronjob: RemoteCronjobRecord;
            session_id: string | null;
            notification_id: string | null;
          };
        },
        update: (input) => {
          try {
            return runtimeAgentToolsService.updateCronjob({
              jobId: input.jobId,
              workspaceId: resolveCanonicalWs(),
              name: input.name ?? undefined,
              cron: input.cron ?? undefined,
              description: input.description ?? undefined,
              instruction: input.instruction ?? undefined,
              enabled: input.enabled,
              delivery:
                input.delivery === undefined
                  ? undefined
                  : optionalCronjobDeliveryInput(input.delivery) ?? null,
              metadata: input.metadata,
            }) as unknown as RemoteCronjobRecord;
          } catch (error) {
            if (
              error instanceof RuntimeAgentToolsServiceError &&
              error.statusCode === 404
            ) {
              throw new CronjobsServiceError("NOT_FOUND", {
                message: error.message,
              });
            }
            throw error;
          }
        },
        delete: (input) => {
          const result = runtimeAgentToolsService.deleteCronjob({
            workspaceId: resolveCanonicalWs(),
            jobId: input.jobId,
          });
          if (result.success !== true) {
            throw new CronjobsServiceError("NOT_FOUND", {
              message: "cronjob not found",
            });
          }
          return result as unknown as { success: boolean };
        },
      },
      channels: {
        list: (input) => {
          const channels = listConnectionViews(store, resolveCanonicalWs()).map(toChannelWire);
          return { channels, count: channels.length };
        },
        validate: async (input) => {
          if (input.platform === "discord") {
            const result = await validateDiscordToken(input.token);
            return {
              ok: result.ok,
              bot_username: result.username ?? null,
              error: result.error ?? null,
              invite_url: result.inviteUrl ?? null,
            };
          }
          if (input.platform === "slack") {
            const result = await validateSlackTokens(input.token, input.appToken ?? "");
            return {
              ok: result.ok,
              bot_username: result.botName ?? null,
              error: result.error ?? null,
            };
          }
          if (input.platform === "qq") {
            // QQ reuses the token fields: token = App ID, appToken = App Secret.
            const result = await validateQQCredentials(input.token, input.appToken ?? "");
            return { ok: result.ok, bot_username: null, error: result.error ?? null };
          }
          if (input.platform === "wecom") {
            // WeCom reuses the token fields: token = BotID, appToken = Secret.
            const result = await validateWecomCredentials(input.token, input.appToken ?? "");
            return { ok: result.ok, bot_username: null, error: result.error ?? null };
          }
          const result = await validateTelegramToken(input.token);
          return {
            ok: result.ok,
            bot_username: result.username ?? null,
            error: result.error ?? null,
          };
        },
        startDeviceAuth: async (input) => {
          const start =
            input.platform === "dingtalk"
              ? await beginDingtalkRegistration()
              : input.platform === "wechat"
                ? await beginWechatRegistration()
                : // Always begin on the Feishu hub; it serves Feishu + Lark tenants
                  // and the poll auto-detects which. (input.domain is legacy/ignored.)
                  await beginFeishuRegistration();
          return {
            device_code: start.deviceCode,
            qr_url: start.qrUrl,
            interval_sec: start.intervalSec,
            expires_in_sec: start.expiresInSec,
          };
        },
        pollDeviceAuth: async (input) => {
          if (input.platform === "dingtalk") {
            const result = await pollDingtalkRegistration(input.deviceCode);
            if (result.status !== "success" || !result.appId || !result.appSecret) {
              return { status: result.status, connection: null };
            }
            const connection = createDingtalkConnection(store, {
              workspaceId: resolveCanonicalWs(),
              appId: result.appId,
              appSecret: result.appSecret,
            });
            void channelGatewayHolder.manager?.refresh();
            return { status: "success", connection: toChannelWire(connection) };
          }
          if (input.platform === "wechat") {
            const result = await pollWechatRegistration(input.deviceCode);
            if (result.status !== "success" || !result.botId || !result.token) {
              return { status: result.status, connection: null };
            }
            const connection = createWechatConnection(store, {
              workspaceId: resolveCanonicalWs(),
              botId: result.botId,
              token: result.token,
              baseUrl: result.baseUrl ?? "https://ilinkai.weixin.qq.com",
              userId: result.userId,
            });
            void channelGatewayHolder.manager?.refresh();
            return { status: "success", connection: toChannelWire(connection) };
          }
          const result = await pollFeishuRegistration(input.deviceCode);
          if (result.status !== "success" || !result.appId || !result.appSecret) {
            return { status: result.status, connection: null };
          }
          const connection = createFeishuConnection(store, {
            workspaceId: resolveCanonicalWs(),
            appId: result.appId,
            appSecret: result.appSecret,
            domain: result.domain ?? "feishu",
            openId: result.openId,
          });
          void channelGatewayHolder.manager?.refresh();
          return { status: "success", connection: toChannelWire(connection) };
        },
        create: async (input) => {
          let result;
          if (input.platform === "discord") {
            result = await createDiscordConnection(store, {
              workspaceId: resolveCanonicalWs(),
              token: input.token,
              allowFrom: input.allowFrom,
              requireMention: input.requireMention,
            });
          } else if (input.platform === "slack") {
            result = await createSlackConnection(store, {
              workspaceId: resolveCanonicalWs(),
              token: input.token,
              appToken: input.appToken ?? "",
              allowFrom: input.allowFrom,
              requireMention: input.requireMention,
            });
          } else if (input.platform === "qq") {
            // QQ reuses the token fields: token = App ID, appToken = App Secret.
            result = await createQQConnection(store, {
              workspaceId: resolveCanonicalWs(),
              appId: input.token,
              appSecret: input.appToken ?? "",
              allowFrom: input.allowFrom,
            });
          } else if (input.platform === "wecom") {
            // WeCom reuses the token fields: token = BotID, appToken = Secret.
            result = await createWecomConnection(store, {
              workspaceId: resolveCanonicalWs(),
              botId: input.token,
              secret: input.appToken ?? "",
              allowFrom: input.allowFrom,
            });
          } else {
            result = await createTelegramConnection(store, {
              workspaceId: resolveCanonicalWs(),
              token: input.token,
              allowFrom: input.allowFrom,
              requireMention: input.requireMention,
            });
          }
          if (!result.ok || !result.connection) {
            throw new ChannelsServiceError("INVALID_TOKEN", {
              message: result.error ?? "Invalid bot token",
            });
          }
          void channelGatewayHolder.manager?.refresh();
          return toChannelWire(result.connection);
        },
        delete: (input) => {
          const removed = deleteChannelConnection(store, resolveCanonicalWs(), input.connectionId);
          if (!removed) {
            throw new ChannelsServiceError("NOT_FOUND", { message: "connection not found" });
          }
          void channelGatewayHolder.manager?.refresh();
          return { success: true };
        },
        setHarness: (input) => {
          const view = setChannelConnectionHarness(store, {
            workspaceId: resolveCanonicalWs(),
            connectionId: input.connectionId,
            harness: input.harness,
          });
          if (!view) {
            throw new ChannelsServiceError("NOT_FOUND", { message: "connection not found" });
          }
          // No gateway refresh needed: the harness is read fresh on every
          // inbound message (fireMessage → resolveChannelHarness), which
          // re-binds existing conversations to the new harness, so the switch
          // applies to their next message too — not just brand-new chats.
          return toChannelWire(view);
        },
        setModel: (input) => {
          const view = setChannelConnectionModel(store, {
            workspaceId: resolveCanonicalWs(),
            connectionId: input.connectionId,
            model: input.model,
          });
          if (!view) {
            throw new ChannelsServiceError("NOT_FOUND", { message: "connection not found" });
          }
          // Like setHarness: the model is read fresh on every inbound message
          // (fireMessage → resolveChannelModel), so the change applies to the
          // channel's next run — no gateway refresh needed.
          return toChannelWire(view);
        },
        listSessions: (input) => {
          const workspaceId = resolveCanonicalWs();
          const connection = store.getChannelConnection({
            workspaceId,
            connectionId: input.connectionId,
          });
          if (!connection) {
            throw new ChannelsServiceError("NOT_FOUND", { message: "connection not found" });
          }
          // conversation_bindings.channel holds the platform (set from
          // message.platform); scope precisely to THIS connection via
          // metadata.connection_id, since one platform can have several
          // connections. Active bindings only, newest-active first (the store's
          // default ordering).
          const bindings = store.listConversationBindings({
            workspaceId,
            channel: connection.platform,
            isActive: true,
            limit: 200,
          });
          const sessions = bindings
            .filter((binding) => binding.metadata?.connection_id === input.connectionId)
            .map((binding) => {
              const metadata = binding.metadata ?? {};
              const chatTitle =
                typeof metadata.chat_title === "string" && metadata.chat_title.trim()
                  ? (metadata.chat_title as string)
                  : null;
              const chatType =
                typeof metadata.chat_type === "string" ? (metadata.chat_type as string) : null;
              // Prefer human identity over the raw platform key: chat title
              // (groups), then the counterpart's user name (DMs). Null lets
              // the client render a friendly generic label instead of an id.
              const userName =
                typeof metadata.user_name === "string" && metadata.user_name.trim()
                  ? (metadata.user_name as string)
                  : null;
              return {
                session_id: binding.sessionId,
                conversation_key: binding.conversationKey,
                title: chatTitle ?? userName,
                chat_type: chatType,
                is_active: binding.isActive,
                last_active_at: binding.lastActiveAt,
              };
            });
          return { sessions, count: sessions.length };
        },
      },
      capabilities: {
        catalog: () => ({
          capabilities: loadCapabilityCatalog().map(({ sourceDir: _sourceDir, ...rest }) =>
            rest as RemoteCapabilityCatalogEntry,
          ),
        }),
        listInstalled: (input) => ({
          capabilities: store.listWorkspaceCapabilities({
            workspaceId: resolveCanonicalWs(),
          }) as unknown as RemoteWorkspaceCapability[],
        }),
        install: async (input) => {
          const capability = loadCapabilityCatalog().find((a) => a.id === input.capabilityId);
          if (!capability) {
            throw new CapabilitiesServiceError("NOT_FOUND", {
              message: "capability not found",
            });
          }
          const result = await installCapability({
            store,
            workspaceId: resolveCanonicalWs(),
            workspaceDir: store.workspaceDir(resolveCanonicalWs()),
            capability,
          });
          return result.record as unknown as RemoteWorkspaceCapability;
        },
        create: async (input) => {
          const ws = resolveCanonicalWs();
          const baseId =
            input.name
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "capability";
          const taken = new Set([
            ...loadCapabilityCatalog().map((entry) => entry.id),
            ...store
              .listWorkspaceCapabilities({ workspaceId: ws })
              .map((record) => record.capabilityId),
          ]);
          let id = baseId;
          for (let n = 2; taken.has(id); n += 1) {
            id = `${baseId}-${n}`;
          }
          const capability = {
            id,
            name: input.name.trim(),
            description: input.description?.trim() || input.name.trim(),
            ...(input.icon ? { icon: input.icon } : {}),
            skills: input.skillIds.map((ref) => ({ ref })),
            integrations: input.integrationProviders.map((provider) => ({
              provider,
              required: true,
            })),
            // Keyless MCP servers resolved from the catalog → remote servers in
            // the capability's workspace.yaml registry (installCapability attaches
            // them, namespaced by capability id).
            ...((input.mcps ?? []).length > 0
              ? {
                  mcp: {
                    servers: (input.mcps ?? []).map((m) => ({
                      id: m.id,
                      type: "remote" as const,
                      url: m.url,
                      tools: m.tools,
                    })),
                  },
                }
              : {}),
            sourceDir: store.workspaceDir(ws),
          };
          const result = await installCapability({
            store,
            workspaceId: ws,
            workspaceDir: store.workspaceDir(ws),
            capability,
          });
          return result.record as unknown as RemoteWorkspaceCapability;
        },
        importPlugin: async (input) => {
          const ws = resolveCanonicalWs();
          const result = await importPluginAsCapability({
            store,
            workspaceId: ws,
            workspaceDir: store.workspaceDir(ws),
            pluginPath: input.pluginPath,
          });
          return result.record as unknown as RemoteWorkspaceCapability;
        },
        uninstall: (input) => ({
          removed: uninstallCapability({
            store,
            workspaceId: resolveCanonicalWs(),
            workspaceDir: store.workspaceDir(resolveCanonicalWs()),
            capabilityId: input.capabilityId,
          }),
        }),
        toggle: (input) => {
          const record = setCapabilityEnabled({
            store,
            workspaceId: resolveCanonicalWs(),
            capabilityId: input.capabilityId,
            enabled: input.enabled,
          });
          if (!record) {
            throw new CapabilitiesServiceError("NOT_FOUND", {
              message: "capability not found",
            });
          }
          return record as unknown as RemoteWorkspaceCapability;
        },
      },
      skills: {
        // The skill catalog now lives in the marketplace (the single source of
        // truth), surfaced to the desktop via the directory gateway. The runtime
        // no longer hosts a catalog; it only materializes a resolved body.
        catalog: () => ({ skills: [] }),
        install: (input) => {
          const ws = resolveCanonicalWs();
          return materializeSkill({
            workspaceDir: store.workspaceDir(ws),
            skillId: input.skillId,
            content: input.content,
          });
        },
        // Shares the folder-aware path with the GitHub import, so an uploaded
        // skill gets the same frontmatter mapping (allowed-tools →
        // holaboss_granted_tools) and the same traversal/size guards.
        importUpload: async (input) => {
          const ws = resolveCanonicalWs();
          const result = await importSkillFromUpload({
            workspaceDir: store.workspaceDir(ws),
            fileName: input.fileName,
            data: Buffer.from(input.dataBase64, "base64"),
          });
          return {
            id: result.id,
            name: result.name,
            description: result.description,
            grantedTools: result.granted_tools,
            files: result.files.map((file) => file.path),
            replaced: result.replaced,
          };
        },
      },
    });
  // workspace-removal Piece 3: services resolve the single workspace directly
  // (resolveCanonicalWs), so the Piece-1 workspaceId-pin wrapper is gone — the
  // base context mounts as-is on both transports.
  mountRemoteApi(app, {
    context: buildRemoteApiBaseContext,
    logger: remoteApiLogger,
  });
  mountRemoteApiMcp(app, { context: buildRemoteApiBaseContext });
  // Exposes the Holaboss runtime-tool surface (web_search, image/video gen,
  // reports, memory, cronjobs, …) to CLI harnesses over MCP; context flows via
  // the x-holaboss-* headers the harness injects. See runtime-tools-mcp.ts.
  mountRuntimeToolsMcp(app);

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
    store,
  });
  const runtimeConfigService = options.runtimeConfigService ?? new FileRuntimeConfigService();
  const browserToolService = options.browserToolService ?? new DesktopBrowserToolService({ artifactStore: store });
  const terminalSessionManager =
    options.terminalSessionManager === undefined
      ? new TerminalSessionManager({
        store,
        logger: app.log,
      })
      : options.terminalSessionManager;
  const queueWorkerHolder: { worker: { wake: () => void } | null } = { worker: null };
  const runtimeAgentToolsHolder: {
    service: { queuePolishForCompletedBindings: (workspaceId: string) => unknown } | null;
  } = { service: null };
  function tryQueuePolishForWorkspace(workspaceId: string): void {
    const runtimeAgentTools = runtimeAgentToolsHolder.service;
    if (!runtimeAgentTools) return;
    try {
      const queued = runtimeAgentTools.queuePolishForCompletedBindings(workspaceId);
      if (Array.isArray(queued) && queued.length > 0) {
        queueWorkerHolder.worker?.wake();
      }
    } catch (error) {
      app.log.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          workspaceId,
        },
        "queuePolishForCompletedBindings failed",
      );
    }
  }

  function tryQueuePolishForAllWorkspaces(): void {
    try {
      for (const workspace of store.listWorkspaces({ includeDeleted: false })) {
        tryQueuePolishForWorkspace(workspace.id);
      }
    } catch (error) {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "iterating workspaces for polish queue failed",
      );
    }
  }

  const integrationService = new RuntimeIntegrationService(store, {
    onConnectionActive: async ({ connectionId, providerId }) => {
      try {
        const woken = await resumePendingIntegrationInputs(store);
        if (woken > 0) {
          queueWorkerHolder.worker?.wake();
        }
      } catch (error) {
        app.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "resumePendingIntegrationInputs failed",
        );
      }

      // When a connection becomes active for a dashboard app's required
      // provider, the pending_integrations gate that was deferring the
      // polish pass may have just unblocked. ensureWorkspaceAppsRunning
      // is the natural place to queue polish, but nothing calls it
      // automatically after a binding completes — the agent's session
      // is idle by then. Trigger the polish-queue logic directly for
      // every workspace; the method internally re-checks pending
      // integrations and dashboard shape per app.
      tryQueuePolishForAllWorkspaces();

    },
    onBindingCreated: ({ workspaceId }) => {
      // Binding an already-active connection to a new app does NOT
      // re-fire `onConnectionActive` (the connection's status didn't
      // change). For the common path — user previously authorized
      // GitHub, agent now builds a GitHub-shaped dashboard app, user
      // picks the existing connection in the binding picker — this is
      // the only place that can re-evaluate the polish gate.
      tryQueuePolishForWorkspace(workspaceId);
    },
  });
  // workspaceIntegrationsService initialized after composioService below.
  const honoBaseUrl = process.env.HOLABOSS_AUTH_BASE_URL ?? "";
  const authCookie = process.env.HOLABOSS_AUTH_COOKIE ?? "";
  const composioService = honoBaseUrl && authCookie
    ? new ComposioService({ honoBaseUrl, authCookie })
    : null;
  // Remote-first Composio account enumeration (Stage 2 grey rollout): the
  // agent's composio toolkits are resolved from the Hono API (single source,
  // same as web) when a bearer token is available, and fall back to the local
  // store otherwise. Null when no bearer token → pure local (current behaviour).
  const composioApiClient = createComposioApiClientFromEnv();
  const remoteComposioSource: RemoteComposioSource | null = composioApiClient
    ? {
        async listConnections() {
          const { connections } = await composioApiClient.listConnections({});
          return connections.flatMap((raw) => {
            if (!isRecord(raw)) {
              return [];
            }
            const toolkit = isRecord(raw.toolkit) ? raw.toolkit : {};
            const id = typeof raw.id === "string" ? raw.id : "";
            const slug = typeof toolkit.slug === "string" ? toolkit.slug : "";
            const status = typeof raw.status === "string" ? raw.status : "";
            const createdAt =
              typeof raw.created_at === "string"
                ? raw.created_at
                : typeof raw.createdAt === "string"
                  ? raw.createdAt
                  : "";
            if (!id || !slug) {
              return [];
            }
            return [{ id, toolkitSlug: slug, status, createdAt }];
          });
        },
      }
    : null;
  setRemoteComposioSource(remoteComposioSource);
  const workspaceIntegrationsService = new WorkspaceIntegrationsService(store);
  const composioSchemaCache = composioService
    ? new ComposioSchemaCache({
        store,
        fetchTools: (slug) => composioService.listToolkitTools(slug),
        logger: {
          info: (msg, meta) => app.log.info(meta ?? {}, String(msg)),
          warn: (msg, meta) => app.log.warn(meta ?? {}, String(msg)),
        },
      })
    : null;
  if (composioSchemaCache) {
    primeComposioSchemaCache({
      cache: composioSchemaCache,
      store,
      isInCatalog: (slug) => isInStoreCatalog(slug),
      logger: {
        info: (msg, meta) => app.log.info(meta ?? {}, String(msg)),
        warn: (msg, meta) => app.log.warn(meta ?? {}, String(msg)),
      },
    }).catch((error) => {
      app.log.warn(
        {
          event: "composio_inline.prime.crashed",
          err: error instanceof Error ? error.message : String(error),
        },
        "Composio schema cache prime threw — falling back to lazy refresh",
      );
    });
  }
  const brokerService = new IntegrationBrokerService(store, composioService);
  const oauthService = new OAuthService(store);
  const runnerExecutor = options.runnerExecutor ?? new NativeRunnerExecutor();
  const durableMemoryWorker = resolveDurableMemoryWorker(options, app, store, memoryService);
  const queueWorker = resolveQueueWorker(options, app, store, memoryService, durableMemoryWorker);
  queueWorkerHolder.worker = queueWorker;
  const runtimeAgentToolsService = new RuntimeAgentToolsService(store, {
    workspaceRoot: store.workspaceRoot,
    terminalSessionManager,
    queueWorker,
    brokerService,
    appLifecycle: {
      ensureAppRunning: async (workspaceId: string, appId: string) => {
        await ensureAppRunning(workspaceId, appId);
      },
      ensureAllAppsRunning: async (workspaceId: string) => {
        return await ensureAllAppsRunning(workspaceId);
      },
      stopApp: async (workspaceId: string, appId: string) => {
        return await stopManagedWorkspaceApp(workspaceId, appId);
      },
      installFromArchive: async ({ workspaceId, appId, archiveUrl, archivePath }) => {
        const payload: Record<string, unknown> = {
          workspace_id: workspaceId,
          app_id: appId,
        };
        if (archiveUrl) payload.archive_url = archiveUrl;
        else if (archivePath) payload.archive_path = archivePath;
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/apps/install-archive",
          payload,
        });
        const body = (() => {
          try {
            return JSON.parse(response.body) as Record<string, unknown>;
          } catch {
            return null;
          }
        })();
        if (response.statusCode >= 200 && response.statusCode < 300 && isRecord(body)) {
          return {
            ok: true,
            ready: body.ready === true,
            detail: typeof body.detail === "string" ? body.detail : "installed",
            error: typeof body.error === "string" ? body.error : null,
          };
        }
        const errorMessage =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : isRecord(body) && typeof body.message === "string"
              ? body.message
              : `install-archive returned status ${response.statusCode}`;
        return {
          ok: false,
          ready: false,
          detail: errorMessage,
          error: errorMessage,
          statusCode: response.statusCode,
        };
      },
    },
  });
  const cronWorker = resolveCronWorker(
    options,
    app,
    store,
    queueWorker,
  );
  const mainSessionEventWorker = resolveMainSessionEventWorker(
    options,
    app,
    store,
    queueWorker,
  );
  const recallEmbeddingBackfillWorker = resolveRecallEmbeddingBackfillWorker(options, app, store, memoryService);
  runtimeAgentToolsHolder.service = runtimeAgentToolsService;

  // IM channel gateway: long-polling connectors (Telegram) that turn inbound
  // messages into headless agent turns and stream the reply back. Self-gating —
  // no-ops unless a connection is configured (env vars in v1).
  const channelGatewayManager = new ChannelRuntimeManager({
    port: createChannelRuntimePort(store),
    configClient: new CompositeChannelConfigClient(
      createStoreChannelConfigClient(store),
      new EnvChannelConfigClient(),
    ),
    connectorFactory: createDefaultConnectorFactory(app.log),
    logger: app.log,
    onStatus: (event) => {
      if (!event.workspaceId) return;
      try {
        store.setChannelConnectionStatus({
          workspaceId: event.workspaceId,
          connectionId: event.connectionId,
          status: event.status,
          statusDetail: event.detail ?? null,
        });
      } catch (err) {
        app.log.warn({ err }, "channel status update failed");
      }
    },
  });
  channelGatewayHolder.manager = channelGatewayManager;

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
  // Aborted on shutdown so the background DB-retention sweep exits promptly.
  const dbMaintenanceAbort = new AbortController();
  // Live retention-sweep progress, polled by the desktop over
  // /runtime/db-maintenance-status so a heavy first-run cleanup can block the
  // boot screen with a progress bar instead of a slow, contended app.
  let dbMaintenanceProgress: DbMaintenanceProgress = IDLE_DB_MAINTENANCE_PROGRESS;

  /**
   * Boot phase, published over /runtime/boot-status.
   *
   * A boot that takes a while is not a boot that has failed, but for a user
   * those are the same picture: a spinner. The desktop had exactly one phase it
   * could see (the retention sweep) and rendered a bare splash for everything
   * else — so a runtime doing 80s of honest work looked identical to a wedged
   * one, and the supervisor treated it as wedged.
   *
   * Every phase that can plausibly exceed a second reports here, so the splash
   * can say what it is waiting for and the supervisor can tell "working" from
   * "hung" by whether the phase advances.
   */
  const bootStartedAtMs = Date.now();
  let bootCompletePromise: Promise<void> = Promise.resolve();
  let bootPhase = "starting";
  let bootPhaseStartedAtMs = bootStartedAtMs;
  let bootReady = false;
  const bootPhaseHistory: Array<{ phase: string; ms: number }> = [];
  const bootAlarms: BootAlarm[] = [];
  // Phases already warned about, so the watchdog says it once and then stops.
  const bootPhasesWarned = new Set<string>();
  const enterBootPhase = (phase: string): void => {
    const now = Date.now();
    const previous = bootPhase;
    const elapsed = now - bootPhaseStartedAtMs;
    // Timings for every phase, so a slow boot is diagnosable from the log alone
    // rather than needing a process sample.
    bootPhaseHistory.push({ phase: previous, ms: elapsed });
    app.log.info(
      { phase: previous, ms: elapsed, next: phase },
      `runtime boot: ${previous} took ${elapsed}ms`,
    );
    bootPhase = phase;
    bootPhaseStartedAtMs = now;
  };

  /**
   * Watchdog over the IN-FLIGHT phase.
   *
   * This is the part that matters. The boot that motivated all of this never
   * finished — it was SIGKILLed mid-`quick_check` on every attempt — so any
   * check that runs when boot completes would have stayed silent for precisely
   * the failure it was written to catch. Polling the current phase against its
   * budget is the only version of this alarm that fires during the incident
   * rather than after it.
   *
   * Unref'd so it can never hold the process open, and it says each phase once:
   * a warning per second for 80s buries the log it is trying to annotate.
   */
  const bootWatchdog = setInterval(() => {
    if (bootReady) {
      return;
    }
    const elapsed = Date.now() - bootPhaseStartedAtMs;
    if (bootPhasesWarned.has(bootPhase) || !phaseOverBudget(bootPhase, elapsed)) {
      return;
    }
    bootPhasesWarned.add(bootPhase);
    const budget = phaseBudgetMs(bootPhase);
    app.log.warn(
      {
        event: "runtime.boot.phase_over_budget",
        phase: bootPhase,
        elapsed_ms: elapsed,
        budget_ms: budget,
        total_elapsed_ms: Date.now() - bootStartedAtMs,
      },
      `runtime boot: still in ${bootPhase} after ${elapsed}ms (budget ${budget}ms) — this boot is slow, not necessarily stuck`,
    );
  }, BOOT_WATCHDOG_INTERVAL_MS);
  bootWatchdog.unref();

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
      const build = store.getAppBuild({ workspaceId, appId });
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
        if (build?.status !== "running") {
          app.log.warn(
            {
              event: "app.ensure_running.healthy_untracked_refused",
              workspaceId,
              appId,
              http: resolved.ports.http,
              mcp: resolved.ports.mcp,
              buildStatus: build?.status ?? null,
            },
            "ensureAppRunning: refusing to reuse untracked healthy listener without prior running state",
          );
        } else {
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
      }

      // Setup needed?
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
          app.log.error(
            { event: "app.ensure_running.setup_failed", workspaceId, appId, err: afterSetup.error },
            "ensureAppRunning: setup failed, aborting start",
          );
          throw new Error(afterSetup.error ?? "setup failed");
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

  async function stopManagedWorkspaceApp(workspaceId: string, appId: string) {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("workspace not found");
    }
    const workspaceDir = store.workspaceDir(workspaceId);
    const resolvedApp = resolveWorkspaceAppRuntime(workspaceDir, appId, {
      store,
      workspaceId,
    });
    const result = await appLifecycleExecutor.stopApp({
      appId,
      appDir: resolvedApp.appDir,
      workspaceId,
      resolvedApp: resolvedApp.resolvedApp,
    });
    store.upsertAppBuild({
      workspaceId,
      appId,
      status: "stopped",
    });
    return result;
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
    targetType: "workspace" | "app" | "agent" | "workspace_default" | "conversation_pin";
    targetId: string;
  }): Promise<void> {
    // Agent bindings + the two new account-routing target types
    // (workspace_default chooses default account per provider;
    // conversation_pin is session-scoped) don't affect per-app
    // readiness — they're routing decisions, not declarations that an
    // app's required integration just became bound.
    if (
      params.targetType === "agent" ||
      params.targetType === "workspace_default" ||
      params.targetType === "conversation_pin"
    ) {
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

      // Restart is best-effort: the binding itself has already been
      // persisted by the caller. A slow/broken app start should not be
      // surfaced to the user as "binding failed" — they'd lose the
      // mental model that the connection is now saved. Log and move on
      // so the PUT endpoint can return the binding payload cleanly; the
      // user can retry start from chat or from the apps panel.
      try {
        await appLifecycleExecutor.stopApp({
          appId,
          appDir: resolved.appDir,
          workspaceId: params.workspaceId,
          resolvedApp: resolved.resolvedApp
        });
        store.upsertAppBuild({ workspaceId: params.workspaceId, appId, status: "stopped" });
        await ensureAppRunning(params.workspaceId, appId);
      } catch (error) {
        app.log.warn(
          {
            workspaceId: params.workspaceId,
            appId,
            integrationKey: params.integrationKey,
            error: error instanceof Error ? error.message : String(error)
          },
          "app restart after integration binding refresh failed; binding is still saved"
        );
      }
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
          // The app is in workspace.yaml but has never finished initial setup.
          // onReady auto-start only covers apps present when the runtime boots,
          // so an app created mid-session (e.g. by the agent) would otherwise
          // sit unbuilt forever and never become ready. Drive its initial
          // setup+start here. ensureAppRunning dedups (appEnsureRunningTasks)
          // and runs setup itself, so skip if a build is already in flight to
          // avoid re-firing a long npm install every tick.
          //
          // A "failed" build is terminal for the monitor (explicit recovery —
          // onReady or the ensure-running route — re-attempts it); skipping it
          // here is what stops the loop. The tricky case is a config error that
          // makes ensureAppRunning throw at resolveWorkspaceAppRuntime *before*
          // runAppSetup writes any status: the build stays "pending" and would
          // be retried forever. So on failure we persist "failed" with the real
          // error, which both surfaces the cause in the Apps UI and makes the
          // next tick skip it.
          const buildStatus = (build?.status ?? "").trim().toLowerCase();
          if (buildStatus === "failed" || appEnsureRunningTasks.has(`${ws.id}:${appId}`)) {
            continue;
          }
          app.log.info(
            { workspaceId: ws.id, appId, buildStatus: build?.status ?? null },
            "health monitor: bringing up app that never completed setup",
          );
          void ensureAppRunning(ws.id, appId).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error(
              { workspaceId: ws.id, appId, err: message },
              "health monitor: initial bring-up failed",
            );
            try {
              const latest = store.getAppBuild({ workspaceId: ws.id, appId });
              if (!appBuildHasCompletedSetup(latest?.status)) {
                store.upsertAppBuild({
                  workspaceId: ws.id,
                  appId,
                  status: "failed",
                  error: message.slice(0, 2000),
                });
              }
            } catch {
              // best-effort
            }
          });
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
    dbMaintenanceAbort.abort();
    await terminalSessionManager?.close();
    await channelGatewayManager.close();
    await recallEmbeddingBackfillWorker?.close();
    await mainSessionEventWorker?.close();
    await cronWorker?.close();
    await queueWorker?.close();
    await durableMemoryWorker?.close();
    if (ownsStore) {
      store.close();
    }
  });

  app.addHook("onReady", async () => {
    // Everything below runs BEFORE app.listen() resolves, so anything awaited
    // here delays the port bind — and a runtime that has not bound is
    // indistinguishable from a dead one to the desktop's health probe, which
    // kills and respawns it. That is the livelock that bricked a 1.9GB install.
    //
    // The app auto-start below already had to be moved off this path for
    // exactly that reason; the worker starts never were. They are started in
    // the background now, in order, with each phase published so the splash can
    // say what it is waiting for instead of showing a bare spinner.
    //
    // Ordering is preserved: these ran sequentially before and some assume the
    // store is open, so they stay sequential — just off the bind path.
    // Exposed as `app.runtimeBootComplete` so a caller that genuinely needs the
    // workers running (tests, and anything that used to rely on onReady
    // awaiting them) can wait for it. "Listening" and "background boot
    // finished" are different events now, and both are worth being able to
    // await — conflating them is what put the DB open on the bind path.
    bootCompletePromise = (async () => {
      const steps: Array<[string, () => Promise<unknown> | unknown]> = [
        ["terminal_sessions", () => terminalSessionManager?.start()],
        ["durable_memory", () => durableMemoryWorker?.start()],
        ["queue_worker", () => queueWorker?.start()],
        ["cron_worker", () => cronWorker?.start()],
        ["main_session_events", () => mainSessionEventWorker?.start()],
        ["recall_embeddings", () => recallEmbeddingBackfillWorker?.start()],
        ["channel_gateway", () => channelGatewayManager.start()],
      ];
      for (const [phase, run] of steps) {
        enterBootPhase(phase);
        try {
          await run();
        } catch (err) {
          // One worker failing to start must not strand the rest — or the boot
          // phase, which would leave the splash waiting forever on a phase that
          // never advances.
          app.log.error(
            { phase, err: err instanceof Error ? err.message : String(err) },
            `runtime boot: ${phase} failed to start`,
          );
        }
      }
      if (options.enableAppHealthMonitor !== false) {
        startHealthMonitor();
      }
      enterBootPhase("ready");
      bootReady = true;
      clearInterval(bootWatchdog);
      const totalMs = Date.now() - bootStartedAtMs;
      app.log.info(
        { totalMs, phases: bootPhaseHistory },
        `runtime boot: ready in ${totalMs}ms`,
      );

      // Telemetry is strictly an observer: anything it throws would turn a
      // diagnostic into the outage it exists to diagnose, so the whole block is
      // guarded and failure is silent beyond a debug line.
      try {
        const dbTimings = store.rootRuntimeDbOpenTimings();
        const record: BootRecord = {
          total_ms: totalMs,
          phases: [...bootPhaseHistory],
          ...(dbTimings.openMs !== null
            ? { root_db_open_ms: dbTimings.openMs }
            : {}),
          ...(dbTimings.integrityCheckMs !== null
            ? { root_db_integrity_check_ms: dbTimings.integrityCheckMs }
            : {}),
          at: new Date().toISOString(),
        };
        const history = parseBootHistory(store.readBootTimingHistoryJson());
        for (const alarm of classifyBoot(record, history)) {
          bootAlarms.push(alarm);
          app.log.warn(
            {
              event: `runtime.boot.${alarm.kind}`,
              phase: alarm.phase,
              elapsed_ms: alarm.elapsed_ms,
              budget_ms: alarm.budget_ms,
              baseline_ms: alarm.baseline_ms,
              root_db_open_ms: record.root_db_open_ms,
              root_db_integrity_check_ms: record.root_db_integrity_check_ms,
            },
            `runtime boot: ${alarm.message}`,
          );
        }
        // Written last: a boot slow enough to be worth alarming about is also
        // the one whose numbers the next boot needs for its baseline.
        store.writeBootTimingHistoryJson(
          JSON.stringify(appendBootRecord(history, record)),
        );
      } catch (err) {
        app.log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "runtime boot: telemetry not recorded",
        );
      }
    })();

    // Background DB retention sweep: prune the append-only session_output_events
    // log (age + per-session cap) and, once enough is freed, request a one-time
    // data.db compaction for the next boot. Fire-and-forget with a built-in
    // start delay so it never competes with boot; fully self-guarded, so it
    // cannot crash the runtime. Skipped in test/embedded builds via option.
    //
    // Repeats on an interval rather than running once: a desktop that stays
    // open for days would otherwise never prune again after boot, which is how
    // data.db grew to multiple GB in the field. Stops on `onClose` via the
    // shared abort controller.
    if (options.enableDbMaintenance !== false) {
      void startRuntimeDbMaintenanceLoop({
        store,
        logger: {
          info: (message, meta) => app.log.info(meta ?? {}, message),
          error: (message, meta) => app.log.error(meta ?? {}, message),
        },
        signal: dbMaintenanceAbort.signal,
        onProgress: (progress) => {
          dbMaintenanceProgress = progress;
        },
      }).catch((err) => {
        app.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "db maintenance sweep failed",
        );
      });
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

  /**
   * What the runtime is doing while it starts, and how long it has been doing
   * it. Unauthed like /healthz, because the desktop polls this before the app
   * shell (and therefore any auth header) exists.
   *
   * `ready` false is NOT a failure — it means "still working". A caller
   * distinguishes a busy runtime from a hung one by whether `phase` advances,
   * which is the distinction the boolean /healthz probe cannot express.
   */
  // Resolves when the background boot sequence has finished. `app.ready()` only
  // means the port is about to bind.
  app.decorate("runtimeBootComplete", () => bootCompletePromise);

  app.get("/runtime/boot-status", async () => {
    const phaseElapsedMs = Date.now() - bootPhaseStartedAtMs;
    return {
      ready: bootReady,
      phase: bootPhase,
      phase_elapsed_ms: phaseElapsedMs,
      total_elapsed_ms: Date.now() - bootStartedAtMs,
      phases: bootPhaseHistory,
      // Lets the supervisor and the splash distinguish "slow" from "stuck"
      // without duplicating the budget table on the desktop side. The
      // supervisor already refunds attempts while the phase advances, so a slow
      // phase is not killed — this is what makes the waiting honest to the user
      // instead of a silent spinner.
      phase_budget_ms: phaseBudgetMs(bootPhase),
      phase_over_budget: !bootReady && phaseOverBudget(bootPhase, phaseElapsedMs),
      alarms: bootAlarms,
    };
  });

  // Live retention-sweep progress. Unauthed like /healthz — the desktop polls
  // it during boot (before the app shell / auth headers exist) to drive the
  // "Optimizing storage…" progress screen on a heavy first-run cleanup.
  app.get("/runtime/db-maintenance-status", async () => dbMaintenanceProgress);

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

  app.post("/api/v1/runtime/harnesses/:harness/test-connection", async (request, reply) => {
    const harnessId = normalizeHarnessId(
      (request.params as { harness?: unknown }).harness,
    );
    if (!resolveRuntimeHarnessPlugin(harnessId)) {
      return sendError(reply, 404, `unknown harness: ${harnessId}`);
    }
    try {
      return await testHarnessConnectionViaHost({ harnessId });
    } catch (error) {
      return sendError(
        reply,
        500,
        error instanceof Error ? error.message : "connection test failed",
      );
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
    const browserProfileId = capabilityBrowserProfileId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    try {
      return await browserToolService.getStatus({ workspaceId, sessionId, space, browserProfileId });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser capability status failed");
    }
  });

  app.get("/api/v1/capabilities/browser/profiles", async (request, reply) => {
    const browserProfileId = capabilityBrowserProfileId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    try {
      return await browserToolService.listProfiles({ browserProfileId });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser profiles list failed");
    }
  });

  app.post("/api/v1/capabilities/browser/profiles/launch", async (request, reply) => {
    const browserProfileId = capabilityBrowserProfileId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    try {
      return await browserToolService.launchProfile({ browserProfileId });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser profile launch failed");
    }
  });

  app.post("/api/v1/capabilities/browser/profiles/close", async (request, reply) => {
    const browserProfileId = capabilityBrowserProfileId({
      headers: request.headers as Record<string, unknown>,
      query: isRecord(request.query) ? request.query : null,
    });
    try {
      return await browserToolService.closeProfile({ browserProfileId });
    } catch (error) {
      if (error instanceof DesktopBrowserToolServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "browser profile close failed");
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
    let space: "agent" | "app" | null = capabilityBrowserSpace({
      headers: request.headers as Record<string, unknown>,
      body: request.body,
    });
    let browserProfileId = capabilityBrowserProfileId({
      headers: request.headers as Record<string, unknown>,
      body: request.body,
    });
    // HolaApp-owned sessions drive their OWN Electron app surface (the view the
    // user is looking at), not the separate agent-profile browser. Force the
    // `app` space + the owning app id as the target so the desktop routes browser
    // ops to that app's BrowserView. Overrides whatever space the harness sent.
    if (sessionId) {
      const owningApp = store.getSession({
        workspaceId: workspaceId || "root",
        sessionId,
      })?.owningAppId;
      const owningAppId =
        typeof owningApp === "string" && owningApp.trim() ? owningApp.trim() : null;
      if (owningAppId) {
        space = "app";
        browserProfileId = owningAppId;
      }
    }
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
        { workspaceId, sessionId, inputId, space, browserProfileId },
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

  // GET /integrations/store-catalog — the curated subset of Composio
  // toolkits we surface in Settings → Integrations. See PM brief
  // `docs/pm/integration-store-user-flow.md` for the scoping decision
  // (tech + marketing only; tier hero / supported).
  app.get("/api/v1/integrations/store-catalog", async () => {
    return { entries: listStoreCatalog() };
  });

  // Account-scoped view: every workspace_integration_override row in
  // one call. The account-level Integrations pane uses this to render
  // per-toolkit rows with expandable per-workspace state without
  // having to fan out one /workspaces/:id/integrations call per
  // workspace.
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
        accountExternalId: typeof request.body.account_external_id === "string" ? request.body.account_external_id : undefined,
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
      const updated = integrationService.updateConnection(params.connectionId, {
        status: typeof body.status === "string" ? body.status : undefined,
        secretRef: typeof body.secret_ref === "string" ? body.secret_ref : undefined,
        accountLabel: typeof body.account_label === "string" ? body.account_label : undefined,
        grantedScopes: Array.isArray(body.granted_scopes) ? body.granted_scopes : undefined,
        ...(accountHandlePresent ? { accountHandle: normalizeIdentity(body.account_handle) } : {}),
        ...(accountEmailPresent ? { accountEmail: normalizeIdentity(body.account_email) } : {}),
      });
      return updated;
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
      // Refresh is fire-and-forget. Apps that consume this binding need to
      // be stop+restarted to pick up the new grant — that's a stopApp +
      // ensureAppRunning + waitHealthy chain that routinely takes 30s+ for
      // cold-start vibe-coded apps. Awaiting it inside the PUT response
      // path blew past the desktop client's HTTP timeout and surfaced as
      // "Runtime request timed out" even though the binding itself was
      // already persisted. The binding row is the source of truth; refresh
      // is just a UX optimization, so let it run in the background and log
      // failures rather than couple them to the user's bind action.
      void refreshAppsForIntegrationBinding({
        workspaceId: binding.workspace_id,
        integrationKey: binding.integration_key,
        targetType: binding.target_type,
        targetId: binding.target_id
      }).catch((error) => {
        app.log.warn(
          {
            workspaceId: binding.workspace_id,
            integrationKey: binding.integration_key,
            targetType: binding.target_type,
            targetId: binding.target_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "background app refresh after integration binding failed; binding is still saved",
        );
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
      if (composioSchemaCache) {
        composioSchemaCache.refresh(provider, connectedAccountId).catch((error) => {
          app.log.warn(
            {
              event: "composio_inline.finalize.schema_prime_failed",
              provider,
              err: error instanceof Error ? error.message : String(error),
            },
            "composio finalize: schema cache prime failed",
          );
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

  // User chose "Skip" on the pending-integration wait banner: record the slugs
  // as declined so the proposal gate stops blocking this session, then resume
  // the deferred input so the paused turn continues (without those integrations).
  app.post("/api/v1/integrations/proposals/decline", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId =
      typeof request.body.workspace_id === "string"
        ? request.body.workspace_id.trim()
        : "";
    const sessionId =
      typeof request.body.session_id === "string"
        ? request.body.session_id.trim()
        : "";
    if (!workspaceId || !sessionId) {
      return sendError(reply, 400, "workspace_id and session_id are required");
    }
    const rawSlugs = Array.isArray(request.body.slugs) ? request.body.slugs : [];
    const slugs = Array.from(
      new Set(
        rawSlugs
          .filter(
            (slug): slug is string =>
              typeof slug === "string" && slug.trim().length > 0,
          )
          .map((slug) => slug.trim().toLowerCase()),
      ),
    );
    if (slugs.length === 0) {
      return sendError(reply, 400, "slugs must be a non-empty array");
    }
    try {
      const deferred = store
        .listDeferredQueuedInputs()
        .find(
          (input) =>
            input.workspaceId === workspaceId && input.sessionId === sessionId,
        );
      const events = store.listOutputEvents({
        workspaceId,
        sessionId,
        includeHistory: true,
      });
      const latestSequence = events.reduce(
        (max, event) => Math.max(max, event.sequence ?? 0),
        0,
      );
      store.appendOutputEvent({
        workspaceId,
        sessionId,
        inputId: deferred?.inputId ?? "integration-decline",
        sequence: latestSequence + 1,
        eventType: DECLINE_PROPOSALS_EVENT_TYPE,
        payload: {
          declined_slugs: slugs,
          message: "User chose to skip these integration proposals.",
        },
      });
      const woken = await resumePendingIntegrationInputs(store);
      if (woken > 0) {
        queueWorkerHolder.worker?.wake();
      }
      return { declined_slugs: slugs, resumed: woken > 0 };
    } catch (error) {
      return sendError(
        reply,
        500,
        error instanceof Error ? error.message : "decline proposals failed",
      );
    }
  });

  app.get("/api/v1/memory/browser/tree", async (request, reply) => {
    try {
      if (!isRecord(request.query)) {
        throw new Error("workspace_id is required");
      }
      const workspaceId = requiredString(
        request.query.workspace_id,
        "workspace_id",
      ).trim();
      return await buildMemoryBrowserTree({
        store,
        workspaceId,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "memory browser tree failed";
      const statusCode = detail.includes("not found") ? 404 : 400;
      return sendError(reply, statusCode, detail);
    }
  });

  app.get("/api/v1/memory/browser/file", async (request, reply) => {
    try {
      if (!isRecord(request.query)) {
        throw new Error("workspace_id and path are required");
      }
      const workspaceId = requiredString(
        request.query.workspace_id,
        "workspace_id",
      ).trim();
      const targetPath = requiredString(request.query.path, "path").trim();
      return await readMemoryBrowserFile({
        store,
        workspaceId,
        targetPath,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "memory browser file failed";
      const statusCode = detail.includes("not found") ? 404 : 400;
      return sendError(reply, statusCode, detail);
    }
  });

  app.get("/api/v1/memory/browser/node-detail", async (request, reply) => {
    try {
      if (!isRecord(request.query)) {
        throw new Error("workspace_id and node_id are required");
      }
      const workspaceId = requiredString(
        request.query.workspace_id,
        "workspace_id",
      ).trim();
      const nodeId = requiredString(request.query.node_id, "node_id").trim();
      return await readMemoryBrowserNodeDetail({
        store,
        workspaceId,
        nodeId,
        treeId: optionalString(request.query.tree_id)?.trim() || null,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "memory browser node detail failed";
      const statusCode = detail.includes("not found") ? 404 : 400;
      return sendError(reply, statusCode, detail);
    }
  });

  app.get("/api/v1/memory/browser/graph", async (request, reply) => {
    try {
      if (!isRecord(request.query)) {
        throw new Error("workspace_id and forest are required");
      }
      const workspaceId = requiredString(
        request.query.workspace_id,
        "workspace_id",
      ).trim();
      const forest = requiredString(request.query.forest, "forest").trim();
      if (forest !== "workspace") {
        throw new Error("forest must be workspace");
      }
      return await buildMemoryBrowserGraph({
        store,
        workspaceId,
        forest,
        treeId: optionalString(request.query.tree_id)?.trim() || null,
        maxLayers: hasOwn(request.query, "max_layers")
          ? optionalInteger(request.query.max_layers, 0)
          : undefined,
        maxNodes: hasOwn(request.query, "max_nodes")
          ? optionalInteger(request.query.max_nodes, 0)
          : undefined,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "memory browser graph failed";
      const statusCode = detail.includes("not found") ? 404 : 400;
      return sendError(reply, statusCode, detail);
    }
  });
  app.get("/api/v1/capabilities/composio-inline-tools", async (request, reply) => {
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        query: isRecord(request.query) ? request.query : null,
      });
      if (!composioSchemaCache || !composioService) {
        return { workspace_id: workspaceId, tools: [], unavailable: [] };
      }
      const resolved = await resolveActiveToolkitConnectionsRemoteFirst({
        store,
        workspaceId,
        remote: remoteComposioSource,
        logger: {
          warn: (msg, meta) => app.log.warn(meta ?? {}, String(msg)),
          info: (msg, meta) => app.log.info(meta ?? {}, String(msg)),
        },
      });
      const tools: Array<{
        name: string;
        description: string;
        toolkit_slug: string;
        tool_slug: string;
        connected_account_id: string;
        input_schema: Record<string, unknown>;
        annotations?: Record<string, unknown> | null;
      }> = [];
      const unavailable: Array<{ toolkit_slug: string; reason: string }> = [];
      const fetches = await Promise.allSettled(
        resolved.map(async (toolkit) => ({
          toolkit,
          entries: await composioSchemaCache.get(
            toolkit.toolkit_slug,
            toolkit.connected_account_id,
          ),
        })),
      );
      for (let i = 0; i < fetches.length; i++) {
        const settled = fetches[i]!;
        const toolkit = resolved[i]!;
        if (settled.status === "fulfilled") {
          for (const entry of settled.value.entries) {
            tools.push({
              name: entry.name,
              description: entry.description,
              toolkit_slug: entry.toolkit_slug,
              tool_slug: entry.tool_slug,
              connected_account_id: entry.connected_account_id,
              input_schema: entry.input_schema,
              annotations: entry.annotations ?? null,
            });
          }
        } else {
          const message =
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason);
          unavailable.push({
            toolkit_slug: toolkit.toolkit_slug,
            reason: message,
          });
          app.log.warn(
            {
              event: "composio_inline.list.schema_unavailable",
              workspaceId,
              toolkit: toolkit.toolkit_slug,
              err: message,
            },
            "composio-inline-tools: schema unavailable",
          );
        }
      }
      return { workspace_id: workspaceId, tools, unavailable };
    } catch (error) {
      return sendError(
        reply,
        400,
        error instanceof Error
          ? error.message
          : "composio-inline-tools list failed",
      );
    }
  });

  // The desktop pushes a rotated session cookie here.
  //
  // HOLABOSS_AUTH_COOKIE is read once, from the spawn environment, so the
  // runtime held whatever the session was when it started. Better-auth rotates
  // that cookie silently (the backend reissues it on get-session and most
  // auth-touching endpoints), and the desktop follows the rotation — its
  // authCookieHeader() stopped caching for precisely this reason. The runtime
  // did not, so every cookie-authenticated call eventually 401s: Composio
  // search, connections and proxy all fail while chat keeps working, because
  // chat authenticates with the model-proxy key instead.
  //
  // Nothing here is a new secret: it is the same session the desktop already
  // holds, transported to the process that needs it.
  app.post("/api/v1/capabilities/auth-session", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "body must be an object");
    }
    const cookie =
      typeof request.body.cookie === "string" ? request.body.cookie : "";
    if (!cookie.trim()) {
      return sendError(reply, 400, "cookie is required");
    }
    if (!composioService) {
      // Not an error: the runtime can outlive a session it never had a service
      // for, and the desktop should not have to know which services exist.
      return { updated: false, reason: "composio service not configured" };
    }
    composioService.setAuthCookie(cookie);
    return { updated: true };
  });

  app.post("/api/v1/capabilities/composio-search", async (request, reply) => {
    try {
      if (!composioService) {
        return sendError(reply, 503, "composio service not configured");
      }
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "body must be an object");
      }
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const query = (optionalString(request.body.query) ?? "").trim();
      const toolkitSlug =
        typeof request.body.toolkit_slug === "string"
          ? request.body.toolkit_slug.trim().toLowerCase()
          : "";
      if (!query && !toolkitSlug) {
        return sendError(reply, 400, "query or toolkit_slug is required");
      }
      // Scope results to the user's connected+active toolkits so every
      // returned tool is actually executable via composio_execute_tool.
      const active = await resolveActiveToolkitConnectionsRemoteFirst({
        store,
        workspaceId,
        remote: remoteComposioSource,
        logger: {
          warn: (msg, meta) => app.log.warn(meta ?? {}, String(msg)),
          info: (msg, meta) => app.log.info(meta ?? {}, String(msg)),
        },
      });
      const activeSlugs = new Set(active.map((t) => t.toolkit_slug));
      if (activeSlugs.size === 0) {
        return { workspace_id: workspaceId, tools: [] };
      }
      // No query ⇒ enumerate one toolkit's whole catalog. The agent's preloaded
      // set is a capped subset, so "what can you do with X" has to be
      // answerable from the source rather than from what's in context. Compact
      // entries only (no input schemas) — a big toolkit would otherwise dump
      // tens of KB; a follow-up query search returns the schema.
      if (!query) {
        if (!activeSlugs.has(toolkitSlug)) {
          return sendError(
            reply,
            400,
            `No active connection for toolkit '${toolkitSlug}'. Connect ${toolkitSlug} first.`,
          );
        }
        const catalog = await composioService.listToolkitTools(toolkitSlug);
        return {
          workspace_id: workspaceId,
          toolkit_slug: toolkitSlug,
          tool_count: catalog.length,
          tools: catalog.map((tool) => ({
            toolkit_slug: toolkitSlug,
            tool_slug: tool.slug,
            name: tool.name,
            description: tool.description,
          })),
          connected_toolkits: [...activeSlugs],
        };
      }
      const results = await composioService.searchTools(
        query,
        toolkitSlug || undefined,
        25,
      );
      const tools = results
        .filter((tool) => activeSlugs.has(tool.toolkit_slug))
        .map((tool) => ({
          toolkit_slug: tool.toolkit_slug,
          tool_slug: tool.slug,
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        }));
      return {
        workspace_id: workspaceId,
        tools,
        connected_toolkits: [...activeSlugs],
      };
    } catch (error) {
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "composio-search failed",
      );
    }
  });

  app.post("/api/v1/capabilities/composio-execute", async (request, reply) => {
    try {
      if (!composioService) {
        return sendError(reply, 503, "composio service not configured");
      }
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "body must be an object");
      }
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const toolkitSlug = requiredString(request.body.toolkit_slug, "toolkit_slug")
        .trim()
        .toLowerCase();
      const toolSlug = requiredString(request.body.tool_slug, "tool_slug").trim();
      // connected_account_id is optional: preloaded inline tools bind it, but
      // the composio_execute_tool meta-tool passes only the toolkit slug, so
      // resolve the active account from the toolkit when it's omitted.
      let connectedAccountId =
        typeof request.body.connected_account_id === "string"
          ? request.body.connected_account_id.trim()
          : "";
      if (!connectedAccountId) {
        const resolvedForExec = await resolveActiveToolkitConnectionsRemoteFirst(
          {
            store,
            workspaceId,
            remote: remoteComposioSource,
            logger: {
              warn: (msg, meta) => app.log.warn(meta ?? {}, String(msg)),
              info: (msg, meta) => app.log.info(meta ?? {}, String(msg)),
            },
          },
        );
        const match = resolvedForExec.find(
          (toolkit) => toolkit.toolkit_slug === toolkitSlug,
        );
        if (!match) {
          return sendError(
            reply,
            400,
            `No active connection for toolkit '${toolkitSlug}'. Connect ${toolkitSlug} first.`,
          );
        }
        connectedAccountId = match.connected_account_id;
      }
      const args = isRecord(request.body.arguments)
        ? (request.body.arguments as Record<string, unknown>)
        : {};
      const startedAt = Date.now();
      const result = await executeComposioInlineTool({
        composio: composioService,
        toolkitSlug,
        toolSlug,
        connectedAccountId,
        arguments: args,
      });
      app.log.info(
        {
          event: result.ok
            ? "composio_inline.execute.success"
            : "composio_inline.execute.failure",
          workspaceId,
          toolkitSlug,
          toolSlug,
          connectedAccountId,
          durationMs: Date.now() - startedAt,
          httpStatus: result.error?.http_status,
          code: result.error?.code,
          message: result.error?.message,
          responseBody: result.error?.response_body,
          cfRay: result.error?.cf_ray,
          originServer: result.error?.origin_server,
          authFailure: result.auth_failure ?? false,
        },
        "composio-execute",
      );
      if (result.auth_failure) {
        // Composio (remote) owns connection status — we do NOT write it. Just
        // drop this toolkit's cached schemas so the next turn re-resolves the
        // live active account from Composio (self-heals a reconnect), and log
        // it for observability / a future reconnect prompt.
        composioSchemaCache?.forget(toolkitSlug);
        app.log.warn(
          {
            event: "composio_inline.auth_failure",
            workspaceId,
            toolkitSlug,
            connectedAccountId,
            httpStatus: result.error?.http_status,
            code: result.error?.code,
          },
          "Composio connected account rejected by the provider — cache invalidated, will re-resolve from remote",
        );
      }
      return result;
    } catch (error) {
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "composio-execute failed",
      );
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

  app.post("/api/v1/capabilities/runtime-tools/ask-user-question", async (request, reply) => {
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
      return runtimeAgentToolsService.createUserQuestion({
        workspaceId,
        sessionId,
        question: requiredDict(request.body.question, "question"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime ask user question failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/ask-user-question/dismiss", async (request, reply) => {
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
      return runtimeAgentToolsService.dismissUserQuestion({
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime ask user question dismiss failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/ask-user-question/answer", async (request, reply) => {
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
      return runtimeAgentToolsService.answerUserQuestion({
        workspaceId,
        sessionId,
        model: optionalString(request.body.model),
        thinkingValue: optionalString(request.body.thinking_value),
        optionId: optionalString(request.body.option_id),
        responseText: optionalString(request.body.response_text),
        notes: nullableString(request.body.notes),
        answers:
          Array.isArray(request.body.answers)
            ? request.body.answers.map((item, index) => {
                if (!isRecord(item)) {
                  throw new Error(`answers[${index}] must be an object`);
                }
                return {
                  question_id: optionalString(item.question_id),
                  option_id: optionalString(item.option_id),
                  response_text: optionalString(item.response_text),
                  notes: nullableString(item.notes),
                };
              })
            : null,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime ask user question answer failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/cronjobs", async (request, reply) => {
    try {
      return runtimeAgentToolsService.listCronjobs({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          query: isRecord(request.query) ? request.query : null
        }),
        enabledOnly: optionalBoolean(isRecord(request.query) ? request.query.enabled_only : undefined, false),
        limit: optionalNumber(isRecord(request.query) ? request.query.limit : undefined),
        offset: optionalNumber(isRecord(request.query) ? request.query.offset : undefined),
        // Agent `cronjobs_list` tool surface — trim long instructions to save
        // the model tokens (the desktop oRPC path keeps the full payload).
        compactInstructions: true
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
      return withCronjobAgentTimeHints(runtimeAgentToolsService.createCronjob({
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
        metadata: optionalDict(request.body.metadata) ?? undefined,
        projectId: optionalString(request.body.project_id)
      }));
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
      return withCronjobAgentTimeHints(payload);
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
      return withCronjobAgentTimeHints(runtimeAgentToolsService.updateCronjob({
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
        metadata: hasOwn(request.body, "metadata") ? (optionalDict(request.body.metadata) ?? {}) : undefined,
        projectId: hasOwn(request.body, "project_id") ? nullableString(request.body.project_id) : undefined
      }));
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

  app.post("/api/v1/capabilities/runtime-tools/cronjobs/:jobId/run", async (request, reply) => {
    const params = request.params as { jobId: string };
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        query: isRecord(request.query) ? request.query : null,
        body: isRecord(request.body) ? request.body : null,
      });
      const callerSessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: isRecord(request.body) ? request.body : null,
      });
      const outcome = await runCronjobNowOp({
        workspaceId,
        jobId: requiredString(params.jobId, "jobId"),
        triggeredBy: callerSessionId,
        // Tool calls always come from a main session; route the spawned
        // run's pill to that session's chat pane (mirrors delegate_task).
        ownerMainSessionId: callerSessionId,
      });
      if (!outcome.ok) {
        return sendError(reply, outcome.status, outcome.message);
      }
      return outcome.payload;
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cronjob run failed");
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
      const delegatedTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      const hydratedTasks = delegatedTasks.map((task) => {
        const delegatedTask = isRecord(task) ? task : {};
        return runtimeAgentToolsService.getTask({
          workspaceId,
          taskId: requiredString(delegatedTask.task_id, "task_id"),
        });
      });
      return {
        tasks: hydratedTasks,
        count: hydratedTasks.length,
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime delegate task failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/tasks", async (request, reply) => {
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
      const statuses = Array.isArray(query.statuses)
        ? optionalStringList(query.statuses)
        : typeof query.statuses === "string" && query.statuses.trim()
          ? [query.statuses.trim()]
          : [];
      return runtimeAgentToolsService.listTasks({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: query,
        }) || undefined,
        statuses,
        limit: hasOwn(query, "limit") ? optionalInteger(query.limit, 200) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime list tasks failed");
    }
  });

  app.get("/api/v1/capabilities/runtime-tools/tasks/:taskId", async (request, reply) => {
    const params = request.params as { taskId: string };
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
      return runtimeAgentToolsService.getTask({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: query,
        }) || undefined,
        taskId: requiredString(params.taskId, "taskId"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime get task failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/tasks/:taskId/reply", async (request, reply) => {
    if (request.body != null && !isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { taskId: string };
    const body = isRecord(request.body) ? request.body : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body,
      });
      return runtimeAgentToolsService.replyTask({
        workspaceId,
        taskId: requiredString(params.taskId, "taskId"),
        text: requiredString(body.text, "text"),
        priority: hasOwn(body, "priority") ? optionalInteger(body.priority, 0) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime reply task failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/tasks/:taskId/cancel", async (request, reply) => {
    if (request.body != null && !isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { taskId: string };
    const body = isRecord(request.body) ? request.body : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body,
      });
      return await runtimeAgentToolsService.cancelTask({
        workspaceId,
        taskId: requiredString(params.taskId, "taskId"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime cancel task failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/tasks/:taskId/rerun", async (request, reply) => {
    if (request.body != null && !isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { taskId: string };
    const body = isRecord(request.body) ? request.body : {};
    try {
      const workspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body,
      });
      const sessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body,
      });
      return runtimeAgentToolsService.rerunTask({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body,
        }) || undefined,
        taskId: requiredString(params.taskId, "taskId"),
        model: nullableString(body.model) ?? undefined,
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body,
        }),
        priority: hasOwn(body, "priority") ? optionalInteger(body.priority, 0) : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime rerun task failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/images/generate", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const imageWorkspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const imageSessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await runtimeAgentToolsService.generateImage({
        workspaceId: imageWorkspaceId,
        sessionId: imageSessionId,
        inputId: resolveOutputInputId({
          store,
          workspaceId: imageWorkspaceId,
          sessionId: imageSessionId ?? "",
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

  app.post("/api/v1/capabilities/runtime-tools/videos/generate", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      const secondsRaw = request.body.seconds;
      const seconds =
        typeof secondsRaw === "number" && Number.isFinite(secondsRaw) ? secondsRaw : undefined;
      const videoWorkspaceId = requiredCapabilityWorkspaceId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      const videoSessionId = capabilitySessionId({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      });
      return await runtimeAgentToolsService.generateVideo({
        workspaceId: videoWorkspaceId,
        sessionId: videoSessionId,
        inputId: resolveOutputInputId({
          store,
          workspaceId: videoWorkspaceId,
          sessionId: videoSessionId ?? "",
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
        prompt: requiredString(request.body.prompt, "prompt"),
        filename: nullableString(request.body.filename) ?? undefined,
        size: nullableString(request.body.size) ?? undefined,
        seconds,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime video generation failed");
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

  app.post("/api/v1/capabilities/runtime-tools/macos-settings", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return await runtimeAgentToolsService.openMacosSettings({
        pane: nullableString(request.body.pane) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : "open macos settings failed",
      );
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

  app.post("/api/v1/capabilities/runtime-tools/send-file", async (request, reply) => {
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
      return await runtimeAgentToolsService.sendFile({
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
        path: requiredString(request.body.path, "path"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime send_file failed");
    }
  });

  app.post(
    "/api/v1/capabilities/runtime-tools/holahub-upload-image",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        });
        return await runtimeAgentToolsService.holahubUploadImage({
          workspaceId,
          path: requiredString(request.body.path, "path"),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "holahub_upload_image failed",
        );
      }
    },
  );

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

  app.post("/api/v1/capabilities/runtime-tools/memory/retrieve", async (request, reply) => {
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
      const scopeCategories = isRecord(request.body.scope) && Array.isArray(request.body.scope.categories)
        ? (() => {
            const normalized = request.body.scope.categories
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean);
            const invalid = normalized.filter((value) => value !== "workspace");
            if (invalid.length > 0) {
              throw new Error("scope.categories must contain only 'workspace'");
            }
            return normalized.includes("workspace") ? ["workspace" as const] : undefined;
          })()
        : undefined;
      const result = await runtimeAgentToolsService.retrieveMemory({
        workspaceId,
        sessionId: sessionId || null,
        inputId:
          capabilityInputId({
            headers: request.headers as Record<string, unknown>,
            body: request.body,
          }) || null,
        selectedModel: capabilitySelectedModel({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }),
        query: requiredString(request.body.query, "query"),
        intent: nullableString(request.body.intent) ?? null,
        scope: {
          categories: scopeCategories,
          treeIds: isRecord(request.body.scope) && Array.isArray(request.body.scope.tree_ids)
            ? request.body.scope.tree_ids
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
            : undefined,
        },
        retrievalPolicy: isRecord(request.body.retrieval_policy)
          ? {
              hybrid:
                typeof request.body.retrieval_policy.hybrid === "boolean"
                  ? request.body.retrieval_policy.hybrid
                  : undefined,
              include_neighbors:
                typeof request.body.retrieval_policy.include_neighbors === "boolean"
                  ? request.body.retrieval_policy.include_neighbors
                  : undefined,
              freshness_bias:
                typeof request.body.retrieval_policy.freshness_bias === "string"
                && ["low", "medium", "high"].includes(request.body.retrieval_policy.freshness_bias)
                  ? request.body.retrieval_policy.freshness_bias as "low" | "medium" | "high"
                  : undefined,
              prefer_high_signal:
                typeof request.body.retrieval_policy.prefer_high_signal === "boolean"
                  ? request.body.retrieval_policy.prefer_high_signal
                  : undefined,
              max_evidence: hasOwn(request.body.retrieval_policy, "max_evidence")
                ? optionalInteger(request.body.retrieval_policy.max_evidence, 8)
                : undefined,
            }
          : undefined,
        answerGoal: nullableString(request.body.answer_goal) ?? null,
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "memory_retrieve",
        payload: result,
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime memory retrieval failed");
    }
  });

  app.post("/api/v1/capabilities/runtime-tools/memory/remember", async (request, reply) => {
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
        }) || "";
      const inputId =
        capabilityInputId({
          headers: request.headers as Record<string, unknown>,
          body: request.body,
        }) || "";

      // Tool input mirrors ExtractedDurableMemoryCandidate — the same shape the
      // background extractor produces — so the brain's judgment flows through the
      // identical shaping + persistence path (see recordDurableMemoryFromInput; no LLM).
      const validMemoryTypes: readonly MemoryEntryType[] = [
        "fact",
        "preference",
        "identity",
        "procedure",
        "blocker",
        "reference",
      ];
      const scope =
        (nullableString(request.body.scope) ?? "workspace").trim().toLowerCase() === "user"
          ? ("user" as const)
          : ("workspace" as const);
      const requestedType = (nullableString(request.body.memory_type) ?? "").trim().toLowerCase();
      const memoryType: MemoryEntryType = validMemoryTypes.includes(requestedType as MemoryEntryType)
        ? (requestedType as MemoryEntryType)
        : scope === "user"
          ? "preference"
          : "fact";
      const title = requiredString(request.body.title, "title");
      const summary = requiredString(request.body.summary, "summary");
      const subjectKey =
        (nullableString(request.body.subject_key) ?? nullableString(request.body.subject) ?? "").trim() ||
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) ||
        "memory";
      const tags = Array.isArray(request.body.tags)
        ? request.body.tags
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const evidence = (nullableString(request.body.evidence) ?? "").trim();
      const confidence =
        typeof request.body.confidence === "number" && Number.isFinite(request.body.confidence)
          ? request.body.confidence
          : null;

      const result = await recordDurableMemoryFromInput({
        store,
        memoryService,
        workspaceId,
        sessionId,
        inputId,
        extracted: { scope, memoryType, subjectKey, title, summary, tags, evidence, confidence },
      });
      return await maybeShapeCapabilityToolResult({
        headers: request.headers as Record<string, unknown>,
        toolId: "remember",
        payload: { ok: true, ...result },
        workspaceId,
        sessionId,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "runtime memory remember failed");
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
        sessionId,
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
        toolId: "update_workspace_instructions",
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
      const workspaceId = requiredString(query.workspace_id, "workspace_id");
      const ownerMainSessionId =
        nullableString(query.owner_main_session_id) ?? undefined;
      const scope = ownerMainSessionId
        ? resolveSessionWorkspaceScope({
            store,
            workspaceId,
            sessionId: ownerMainSessionId,
          })
        : null;
      return runtimeAgentToolsService.listBackgroundTasks({
        workspaceId: scope?.workspaceId ?? workspaceId,
        ownerMainSessionId,
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
      const workspaceId = requiredString(query.workspace_id, "workspace_id");
      const ownerMainSessionId =
        nullableString(query.owner_main_session_id) ?? undefined;
      const scope = ownerMainSessionId
        ? resolveSessionWorkspaceScope({
            store,
            workspaceId,
            sessionId: ownerMainSessionId,
          })
        : null;
      return runtimeAgentToolsService.getBackgroundTask({
        workspaceId: scope?.workspaceId ?? workspaceId,
        subagentId: requiredString(params.subagentId, "subagentId"),
        ownerMainSessionId,
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
        const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
        const ownerMainSessionId =
          nullableString(request.body.owner_main_session_id) ?? undefined;
        const scope = ownerMainSessionId
          ? resolveSessionWorkspaceScope({
              store,
              workspaceId,
              sessionId: ownerMainSessionId,
            })
          : null;
        return runtimeAgentToolsService.archiveBackgroundTask({
          workspaceId: scope?.workspaceId ?? workspaceId,
          subagentId: requiredString(params.subagentId, "subagentId"),
          ownerMainSessionId,
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

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/find",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const sourceRaw = nullableString(body.source);
        const source =
          sourceRaw === "marketplace" || sourceRaw === "local" || sourceRaw === "installed" || sourceRaw === "all"
            ? sourceRaw
            : null;
        return await runtimeAgentToolsService.findWorkspaceApps({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          query: nullableString(body.query),
          source,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_find failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-integrations/catalog",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        // `await` — see the capability-install route: an un-awaited return of
        // an async call rejects past its own try, leaving this catch dead.
        return await runtimeAgentToolsService.listIntegrationCatalog({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_integrations_list_catalog failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/install",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return await runtimeAgentToolsService.installWorkspaceApp({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          appId: requiredString(body.app_id, "app_id"),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_install failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/scaffold",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return await runtimeAgentToolsService.scaffoldWorkspaceApp({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(body.app_id, "app_id"),
          name: nullableString(body.name) ?? undefined,
          overwrite: body.overwrite === true,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_scaffold failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/register",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return await runtimeAgentToolsService.registerWorkspaceApp({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(body.app_id, "app_id"),
          configPath: nullableString(body.config_path) ?? undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_register failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/ensure-running",
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      try {
        const body = request.body;
        return await runtimeAgentToolsService.ensureWorkspaceAppsRunning({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          appIds: Array.isArray(body.app_ids)
            ? body.app_ids.filter((value): value is string => typeof value === "string")
            : undefined,
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_ensure_running failed",
        );
      }
    },
  );

  // Workspace-scoped integration controls: list every account integration
  // alongside whether it's enabled / disabled / pinned in this workspace,
  // and let the desktop UI flip the override.
  // ---------------------------------------------------------------------
  // Workspace-default account selection (Layer 2 in the four-layer
  // account-resolution model). When the user has multiple accounts
  // active for the same provider, this records which one this workspace
  // prefers by default. composio-mcp host reads this on next restart to
  // pick the right tools.
  // ---------------------------------------------------------------------

  app.get(
    "/api/v1/workspaces/:workspaceId/integrations/:providerId/default-account",
    (request, _reply) => {
      const params = request.params as { workspaceId: string; providerId: string };
      const workspaceId = requiredString(params.workspaceId, "workspaceId");
      const providerId = requiredString(params.providerId, "providerId");
      return workspaceIntegrationsService.getWorkspaceDefaultAccount({
        workspaceId,
        providerId,
      });
    },
  );

  app.put(
    "/api/v1/workspaces/:workspaceId/integrations/:providerId/default-account",
    async (request, reply) => {
      const params = request.params as { workspaceId: string; providerId: string };
      const workspaceId = requiredString(params.workspaceId, "workspaceId");
      const providerId = requiredString(params.providerId, "providerId");
      const body = isRecord(request.body) ? request.body : {};
      const connectionId = optionalString(body.connection_id);
      if (!connectionId) {
        return sendError(reply, 400, "connection_id is required");
      }
      try {
        const result = workspaceIntegrationsService.setWorkspaceDefaultAccount({
          workspaceId,
          providerId,
          connectionId,
        });
        // Restart so the new default takes effect on the next agent turn.
        return result;
      } catch (error) {
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "set workspace default account failed",
        );
      }
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/integrations/:providerId/default-account",
    async (request, _reply) => {
      const params = request.params as { workspaceId: string; providerId: string };
      const workspaceId = requiredString(params.workspaceId, "workspaceId");
      const providerId = requiredString(params.providerId, "providerId");
      const result = workspaceIntegrationsService.clearWorkspaceDefaultAccount({
        workspaceId,
        providerId,
      });
      return result;
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/build",
    async (request, reply) => {
      const params = request.params as { appId: string };
      const body = isRecord(request.body) ? request.body : {};
      try {
        return await runtimeAgentToolsService.buildWorkspaceApp({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(params.appId, "appId"),
          timeoutMs: typeof body.timeout_ms === "number" ? body.timeout_ms : undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_build failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/restart",
    async (request, reply) => {
      const params = request.params as { appId: string };
      const body = isRecord(request.body) ? request.body : {};
      try {
        return await runtimeAgentToolsService.restartWorkspaceApp({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(params.appId, "appId"),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_restart failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/restart-and-wait-ready",
    async (request, reply) => {
      const params = request.params as { appId: string };
      const body = isRecord(request.body) ? request.body : {};
      try {
        return await runtimeAgentToolsService.restartAndWaitUntilWorkspaceAppReady({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(params.appId, "appId"),
          timeoutMs: typeof body.timeout_ms === "number" ? body.timeout_ms : undefined,
          pollIntervalMs:
            typeof body.poll_interval_ms === "number" ? body.poll_interval_ms : undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_restart_and_wait_ready failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/wait-until-ready",
    async (request, reply) => {
      const params = request.params as { appId: string };
      const body = isRecord(request.body) ? request.body : {};
      try {
        return await runtimeAgentToolsService.waitUntilWorkspaceAppReady({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(params.appId, "appId"),
          timeoutMs: typeof body.timeout_ms === "number" ? body.timeout_ms : undefined,
          pollIntervalMs:
            typeof body.poll_interval_ms === "number" ? body.poll_interval_ms : undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_wait_until_ready failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/probe-endpoints",
    async (request, reply) => {
      const params = request.params as { appId: string };
      const body = isRecord(request.body) ? request.body : {};
      try {
        return await runtimeAgentToolsService.probeWorkspaceAppEndpoints({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            body,
          }) || null,
          appId: requiredString(params.appId, "appId"),
          checks: Array.isArray(body.checks)
            ? body.checks.filter((value): value is string => typeof value === "string")
            : undefined,
          timeoutMs: typeof body.timeout_ms === "number" ? body.timeout_ms : undefined,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_probe_endpoints failed",
        );
      }
    },
  );

  app.get(
    "/api/v1/capabilities/runtime-tools/workspace-apps",
    async (request, reply) => {
      try {
        return runtimeAgentToolsService.getWorkspaceAppStatus({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }) || null,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_get_status failed",
        );
      }
    },
  );

  app.get(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/status",
    async (request, reply) => {
      const params = request.params as { appId: string };
      try {
        return runtimeAgentToolsService.getWorkspaceAppStatus({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }) || null,
          appId: requiredString(params.appId, "appId"),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_get_status failed",
        );
      }
    },
  );

  app.get(
    "/api/v1/capabilities/runtime-tools/workspace-apps/ports",
    async (request, reply) => {
      try {
        return runtimeAgentToolsService.getWorkspaceAppPorts({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }) || null,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_get_ports failed",
        );
      }
    },
  );

  app.get(
    "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/ports",
    async (request, reply) => {
      const params = request.params as { appId: string };
      try {
        return runtimeAgentToolsService.getWorkspaceAppPorts({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }),
          sessionId: capabilitySessionId({
            headers: request.headers as Record<string, unknown>,
            query: isRecord(request.query) ? request.query : undefined,
          }) || null,
          appId: requiredString(params.appId, "appId"),
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "workspace_apps_get_ports failed",
        );
      }
    },
  );

  app.post("/api/v1/capabilities/runtime-tools/capability-install", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      // `await`, not a bare return: installCapability is async, so without it
      // its rejections escape this try and the catch below is dead code — the
      // mapped {detail} error body silently became the generic error-handler
      // shape for every failure this route can produce.
      return await runtimeAgentToolsService.installCapability({
        workspaceId: requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body: request.body
        }),
        capabilityId: requiredString(request.body.capability_id, "capability_id"),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "capability_install failed");
    }
  });

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-integrations/propose-connect",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        return runtimeAgentToolsService.proposeIntegrationConnect({
          workspaceId: requiredCapabilityWorkspaceId({
            headers: request.headers as Record<string, unknown>,
            body,
          }),
          toolkitSlug: requiredString(body.toolkit_slug, "toolkit_slug"),
          reason:
            typeof body.reason === "string" ? body.reason : undefined,
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
            : "holaboss_workspace_integrations_propose_connect failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/workspace-integrations/set-default-account",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        const result = await workspaceIntegrationsService.setWorkspaceDefaultAccount({
          workspaceId,
          providerId: requiredString(body.provider_id, "provider_id"),
          connectionId: requiredString(body.connection_id, "connection_id"),
        });
        return {
          provider_id: requiredString(body.provider_id, "provider_id").toLowerCase(),
          connection_id: result.connection_id,
          // This note is a TOOL RESULT — it lands in the transcript on every call
          // and the model repeats it to the user, so it has to be true. There is
          // no composio-mcp host to restart (Composio is resolved inline); what
          // actually happens is the cached listing is dropped, above.
          note: "Workspace default updated. The cached integration tool listing was dropped; the new account's tools resolve from your next turn.",
        };
      } catch (error) {
        return sendError(
          reply,
          400,
          error instanceof Error
            ? error.message
            : "holaboss_workspace_integrations_set_default_account failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/mcp/connect",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        return await runtimeAgentToolsService.connectMcpServer({
          workspaceId,
          url: typeof body.url === "string" ? body.url : null,
          command: Array.isArray(body.command)
            ? body.command.filter((v): v is string => typeof v === "string")
            : null,
          name: typeof body.name === "string" ? body.name : null,
          headers: isRecord(body.headers)
            ? (body.headers as Record<string, string>)
            : null,
          env: isRecord(body.env) ? (body.env as Record<string, string>) : null,
          ownerAppId:
            typeof body.owner_app_id === "string" ? body.owner_app_id : null,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "mcp_connect failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/mcp/refresh",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        return runtimeAgentToolsService.refreshMcpTools({ workspaceId });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "mcp_refresh failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/mcp/authorize",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        return await runtimeAgentToolsService.authorizeMcpServer({
          workspaceId,
          serverId: typeof body.server_id === "string" ? body.server_id : "",
          timeoutMs:
            typeof body.timeout_ms === "number" && Number.isFinite(body.timeout_ms)
              ? body.timeout_ms
              : undefined,
          reauthorize: body.reauthorize === true,
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "mcp_authorize failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/mcp/reauthorize",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        return runtimeAgentToolsService.prepareMcpReauthorize({
          workspaceId,
          server: typeof body.server === "string" ? body.server : "",
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "mcp_reauthorize failed",
        );
      }
    },
  );

  app.post(
    "/api/v1/capabilities/runtime-tools/mcp/authorized",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      try {
        const workspaceId = requiredCapabilityWorkspaceId({
          headers: request.headers as Record<string, unknown>,
          body,
        });
        return runtimeAgentToolsService.isMcpServerAuthorized({
          workspaceId,
          serverId: typeof body.server_id === "string" ? body.server_id : "",
        });
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "mcp_authorized check failed",
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
        workspaceRecordPayload(item, folderCache.path(item.id), folderCache.state(item.id), store)
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
        resolveWorkspaceFolderStateForPayload(store, workspace.id),
        store,
      )
    };
  });

  app.post("/api/v1/workspaces/:workspaceId/ensure-main-session", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    // `create=false` resolves the current main session without creating one —
    // the desktop uses it to open a lazy draft when there's no chat yet, so no
    // empty placeholder row is persisted until the first message is sent.
    const query = isRecord(request.query) ? request.query : {};
    const create = optionalBoolean(query.create, true);
    const session = create
      ? resolveOrCreateWorkspaceMainSession({ store, workspace }).session
      : resolveWorkspaceMainSession({ store, workspace }).session;
    return {
      session: session ? agentSessionPayload(session, store) : null,
    };
  });

  app.get("/api/v1/workspaces/:workspaceId/main-sessions", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    // `?app_id=<id>` lists strictly that HolaApp's own sessions (for the app
    // session dropdown, most-recent first). Absent it, this is the workspace
    // sidebar list, which must EXCLUDE app-owned sessions entirely.
    const appId =
      optionalString((request.query as { app_id?: unknown } | undefined)?.app_id)?.trim() ||
      null;

    const activeSessionId =
      store.getConversationBindingByConversation({
        workspaceId: workspace.id,
        channel: "desktop",
        conversationKey: "main_session",
        role: "main_session",
      })?.sessionId ?? null;

    const onboardingSessionId = (workspace.onboardingSessionId ?? "").trim();
    const skipOnboarding = sessionSelectionUsesOnboarding(workspace);

    const sessions = store
      .listSessions({
        workspaceId: workspace.id,
        includeArchived: false,
        limit: 500,
        offset: 0,
        // The workspace sidebar is org-scoped. A TEAM org shows only its own
        // sessions (strict); PERSONAL is modeled as "no org" (null), so it shows
        // the null-org sessions (personal + legacy) and never a team's. The app
        // dropdown (`app_id`) stays app-scoped, unfiltered by org.
        ...(appId
          ? { owningAppId: appId }
          : {
              excludeAppOwned: true,
              ...(currentActiveOrgId()
                ? { orgId: currentActiveOrgId() }
                : { onlyUnattributedOrg: true }),
            }),
      })
      .filter((session) => {
        if (!isPrimaryChatSessionKind(session.kind)) {
          return false;
        }
        if (skipOnboarding && session.sessionId === onboardingSessionId) {
          return false;
        }
        return true;
      })
      .map((session) => ({
        ...agentSessionPayload(session, store),
        is_active: session.sessionId === activeSessionId,
      }));

    return { sessions };
  });

  // Read-only diagnostic: the raw workspace.yaml as it sits on disk. This is
  // the ground truth the runner compiles into the harness MCP/tool config, so
  // surfacing it verbatim lets the desktop's Settings → Diagnostics confirm
  // e.g. whether an installed HolaApp actually wrote its mcp_registry entry.
  app.get("/api/v1/workspaces/:workspaceId/config-yaml", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const yamlPath = path.join(store.workspaceDir(workspace.id), "workspace.yaml");
    let content = "";
    let exists = false;
    try {
      content = fs.readFileSync(yamlPath, "utf8");
      exists = true;
    } catch (error) {
      // Missing file is a valid state (returned exists:false); anything else
      // (permissions, IO) surfaces as a 500 so the UI shows the real reason.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return sendError(
          reply,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { path: yamlPath, exists, content };
  });

  // Parsed view of the workspace's connected MCP servers (mcp_registry.servers),
  // for the desktop Integrations → MCP servers section. Excludes the internal
  // `workspace` tools server.
  app.get("/api/v1/workspaces/:workspaceId/mcp-servers", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    return { servers: listWorkspaceMcpRegistryServers(store.workspaceDir(workspace.id)) };
  });

  app.delete(
    "/api/v1/workspaces/:workspaceId/mcp-servers/:serverId",
    async (request, reply) => {
      const params = request.params as { workspaceId: string; serverId: string };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const serverId = params.serverId.trim();
      if (!serverId || serverId === "workspace") {
        return sendError(reply, 400, "server id cannot be removed");
      }
      const workspaceDir = store.workspaceDir(workspace.id);
      const known = listWorkspaceMcpRegistryServers(workspaceDir).some(
        (server) => server.id === serverId,
      );
      if (!known) {
        return sendError(reply, 404, "mcp server not found");
      }
      removeWorkspaceMcpRegistryEntry(workspaceDir, serverId);
      // Uninstall wipes the saved OAuth token too (per-workspace dir + shared
      // ~/.mcporter vault) — otherwise re-adding this server later would silently
      // reuse the old account (ids are host-derived). Best-effort / no-op when
      // there was no token (e.g. a local or header-authed server).
      clearMcpOAuthToken(workspaceDir, serverId);
      return { removed: true, server_id: serverId };
    },
  );

  app.post("/api/v1/workspaces/:workspaceId/main-sessions", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = store.getWorkspace(params.workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const body = isRecord(request.body) ? request.body : {};
    const requestedTitle = optionalString(body.title)?.trim();
    const requestedProjectId = optionalString(body.project_id)?.trim() || null;
    if (requestedProjectId) {
      const project = store.getWorkspaceProject({
        workspaceId: workspace.id,
        projectId: requestedProjectId,
      });
      if (!project) {
        return sendError(reply, 404, "project not found");
      }
    }

    // Per-session harness binding: validated against the plugin registry
    // if supplied, otherwise fall back to the workspace default. Once
    // written the binding is immutable for this session.
    const rawHarnessId = optionalString(body.harness_id);
    if (rawHarnessId !== undefined && rawHarnessId !== null && !validateRequestedHarnessId(rawHarnessId)) {
      return sendError(reply, 400, `unsupported harness: ${rawHarnessId}`);
    }
    const resolvedHarnessId =
      validateRequestedHarnessId(rawHarnessId) ?? resolvedWorkspaceHarness(workspace);
    // A HolaApp session belongs to its app: it is NOT promoted to the workspace's
    // active main_session (that would hijack what the workspace resumes on
    // reload) and is listed/tracked under the app instead.
    const owningAppId = optionalString(body.app_id)?.trim() || null;

    // A HolaApp hand-off (host chat.start) with new_session:false continues the
    // app's existing chat so the conversation + attached context accumulate in
    // one place instead of spawning a fresh session per action. Reuse the app's
    // most recent non-archived chat in the current org; fall through to creating
    // one when none exists. Only an explicit new_session:false opts in — every
    // other caller (omitting it) keeps the create-a-fresh-session behavior.
    if (owningAppId && body.new_session === false) {
      const activeOrg = currentActiveOrgId();
      const existing = store
        .listSessions({
          workspaceId: workspace.id,
          owningAppId,
          includeArchived: false,
          limit: 20,
        })
        .find(
          (candidate) =>
            isPrimaryChatSessionKind(candidate.kind) &&
            (candidate.orgId ?? null) === (activeOrg ?? null),
        );
      if (existing) {
        return {
          session: {
            ...agentSessionPayload(existing, store),
            is_active: false,
          },
        };
      }
    }

    const session = store.ensureSession({
      workspaceId: workspace.id,
      sessionId: `main-${randomUUID()}`,
      kind: "main_session",
      // When the caller supplies a title use it verbatim, otherwise leave
      // it null so the queue-input route can derive a title from the first
      // user message via `sessionTitleFromFirstUserInput`.
      title: requestedTitle || null,
      projectId: requestedProjectId,
      harnessId: resolvedHarnessId,
      createdBy: "user",
      owningAppId,
      orgId: currentActiveOrgId(),
    });

    // Only a workspace session becomes the desktop's active main_session; an app
    // session stays owned by its app.
    if (!owningAppId) {
      store.upsertConversationBinding({
        workspaceId: workspace.id,
        channel: "desktop",
        conversationKey: "main_session",
        sessionId: session.sessionId,
        role: "main_session",
        isActive: true,
        metadata: {},
        lastActiveAt: utcNowIso(),
      });
    }

    return {
      session: {
        ...agentSessionPayload(session, store),
        is_active: !owningAppId,
      },
    };
  });

  app.post(
    "/api/v1/workspaces/:workspaceId/main-sessions/:sessionId/activate",
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        sessionId: string;
      };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const session = store.getSession({
        workspaceId: workspace.id,
        sessionId: params.sessionId,
      });
      if (!session) {
        return sendError(reply, 404, "session not found");
      }
      if (session.archivedAt) {
        return sendError(reply, 409, "session is archived");
      }
      if (!isPrimaryChatSessionKind(session.kind)) {
        return sendError(reply, 409, "session is not a main session");
      }

      store.upsertConversationBinding({
        workspaceId: workspace.id,
        channel: "desktop",
        conversationKey: "main_session",
        sessionId: session.sessionId,
        role: "main_session",
        isActive: true,
        metadata: {},
        lastActiveAt: utcNowIso(),
      });

      return {
        session: {
          ...agentSessionPayload(session, store),
          is_active: true,
        },
      };
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspaceId/main-sessions/:sessionId",
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        sessionId: string;
      };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const session = store.getSession({
        workspaceId: workspace.id,
        sessionId: params.sessionId,
      });
      if (!session) {
        return sendError(reply, 404, "session not found");
      }
      if (!isPrimaryChatSessionKind(session.kind)) {
        return sendError(reply, 409, "session is not a main session");
      }
      const body = isRecord(request.body) ? request.body : {};
      if (body.title === undefined) {
        return sendError(reply, 400, "title is required");
      }
      const title = optionalString(body.title)?.trim() || null;
      const next = store.renameSession({
        workspaceId: workspace.id,
        sessionId: params.sessionId,
        title,
      });
      const activeSessionId =
        store.getConversationBindingByConversation({
          workspaceId: workspace.id,
          channel: "desktop",
          conversationKey: "main_session",
          role: "main_session",
        })?.sessionId ?? null;
      return {
        session: {
          ...agentSessionPayload(next, store),
          is_active: next.sessionId === activeSessionId,
        },
      };
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/main-sessions/:sessionId",
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        sessionId: string;
      };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const session = store.getSession({
        workspaceId: workspace.id,
        sessionId: params.sessionId,
      });
      if (!session) {
        return sendError(reply, 404, "session not found");
      }
      if (!isPrimaryChatSessionKind(session.kind)) {
        return sendError(reply, 409, "session is not a main session");
      }
      store.deleteSession({
        workspaceId: workspace.id,
        sessionId: params.sessionId,
      });
      return { ok: true };
    },
  );

  // ─── Workspace projects ───────────────────────────────────────────
  // First-class entities scoped to a workspace. Each project owns its own
  // directory (independent of workspace_path); a session that binds to a
  // project runs with the project's dir as cwd.

  app.get(
    "/api/v1/workspaces/:workspaceId/projects",
    async (request, reply) => {
      const params = request.params as { workspaceId: string };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const items = store
        .listWorkspaceProjects(workspace.id)
        .map((record) => workspaceProjectPayload(record));
      return { items };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects",
    async (request, reply) => {
      const params = request.params as { workspaceId: string };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      const name = optionalString(request.body.name)?.trim();
      if (!name) {
        return sendError(reply, 400, "name is required");
      }
      const rawProjectPath = optionalString(request.body.project_path)?.trim();
      if (!rawProjectPath) {
        return sendError(reply, 400, "project_path is required");
      }
      // Renderer-side defaults can land here as `~/Holaboss/Projects/<Name>`
      // because the Electron renderer doesn't always expose process.env.HOME.
      // Expand the tilde here so we always persist a real absolute path; the
      // shell does not expand it when the runtime later passes the path as
      // a cwd, so unexpanded tildes manifest as ENOENT.
      const projectPath = expandHome(rawProjectPath);
      const createIfMissing = request.body.create_if_missing === true;
      if (createIfMissing) {
        try {
          fs.mkdirSync(projectPath, { recursive: true });
        } catch (err) {
          return sendError(
            reply,
            400,
            `failed to create project_path: ${(err as Error).message}`,
          );
        }
      } else if (!fs.existsSync(projectPath)) {
        return sendError(reply, 400, "project_path does not exist");
      }
      const project = store.createWorkspaceProject({
        workspaceId: workspace.id,
        projectId: `proj-${randomUUID()}`,
        name,
        projectPath,
        icon: optionalString(request.body.icon) ?? null,
        iconColor: optionalString(request.body.icon_color) ?? null,
      });
      return { project: workspaceProjectPayload(project) };
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspaceId/projects/:projectId",
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        projectId: string;
      };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const existing = store.getWorkspaceProject({
        workspaceId: workspace.id,
        projectId: params.projectId,
      });
      if (!existing) {
        return sendError(reply, 404, "project not found");
      }
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      const fields: Parameters<typeof store.updateWorkspaceProject>[0]["fields"] = {};
      if (request.body.name !== undefined) {
        const next = optionalString(request.body.name)?.trim();
        if (!next) {
          return sendError(reply, 400, "name must be non-empty");
        }
        fields.name = next;
      }
      if (request.body.icon !== undefined) {
        fields.icon = optionalString(request.body.icon);
      }
      if (request.body.icon_color !== undefined) {
        fields.iconColor = optionalString(request.body.icon_color);
      }
      const next = store.updateWorkspaceProject({
        workspaceId: workspace.id,
        projectId: params.projectId,
        fields,
      });
      return { project: workspaceProjectPayload(next) };
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/projects/:projectId",
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        projectId: string;
      };
      const workspace = store.getWorkspace(params.workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      const existing = store.getWorkspaceProject({
        workspaceId: workspace.id,
        projectId: params.projectId,
      });
      if (!existing) {
        return sendError(reply, 404, "project not found");
      }
      store.deleteWorkspaceProject({
        workspaceId: workspace.id,
        projectId: params.projectId,
      });
      return { ok: true };
    },
  );

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
      workspace: workspaceRecordPayload(workspace, workspaceDir, folderState, store)
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
    const allowDestructiveWrite = optionalBoolean(request.body.allow_destructive_write, false);
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    if (replaceExisting && workspaceReplaceExistingWouldDeleteEntries(workspaceDir) && !allowDestructiveWrite) {
      return reply.code(409).send(
        destructiveWriteApprovalResponse(
          "replace_existing would delete existing workspace files; retry with allow_destructive_write=true only when the user explicitly asked for that destructive change"
        )
      );
    }
    if (replaceExisting) {
      for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (isPreservedWorkspaceEntryForReplaceExisting(entry.name)) {
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
    const allowDestructiveWrite = optionalBoolean(request.body.allow_destructive_write, false);
    const apiKey = optionalString(request.body.api_key);
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    if (replaceExisting && workspaceReplaceExistingWouldDeleteEntries(workspaceDir) && !allowDestructiveWrite) {
      return reply.code(409).send(
        destructiveWriteApprovalResponse(
          "replace_existing would delete existing workspace files; retry with allow_destructive_write=true only when the user explicitly asked for that destructive change"
        )
      );
    }
    if (replaceExisting) {
      for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (isPreservedWorkspaceEntryForReplaceExisting(entry.name)) {
          continue;
        }
        fs.rmSync(path.join(workspaceDir, entry.name), { recursive: true, force: true });
      }
    }

    // SSRF: validate the caller-supplied URL before fetching it.
    try {
      await assertPublicHttpUrl(url);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "url is not allowed");
    }

    const zipPath = path.join(os.tmpdir(), `holaboss-template-${params.workspaceId}-${Date.now()}.zip`);
    try {
      // Follow redirects manually and re-validate each hop (SSRF), and only
      // forward the caller api_key while we remain on the requested origin — a
      // redirect to another host must never carry the credential.
      const response = await ssrfSafeFetch(url, {
        init: apiKey ? { headers: { "X-API-Key": apiKey } } : undefined,
        originScopedHeaders: ["x-api-key"],
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
    const allowDestructiveWrite = optionalBoolean(request.body.allow_destructive_write, false);
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
    const nextContent = Buffer.from(requiredString(request.body.content_base64, "content_base64"), "base64");
    if (!allowDestructiveWrite && fs.existsSync(fullPath)) {
      const existingStats = fs.statSync(fullPath);
      if (existingStats.isFile() && existingStats.size > 0 && isEffectivelyEmptyWorkspaceFileContent(nextContent)) {
        return reply.code(409).send(
          destructiveWriteApprovalResponse(
            `writing ${params["*"]} would clear a non-empty file; retry with allow_destructive_write=true only when the user explicitly asked for that destructive change`
          )
        );
      }
    }
    fs.writeFileSync(fullPath, nextContent);
    if (optionalBoolean(request.body.executable, false)) {
      fs.chmodSync(fullPath, fs.statSync(fullPath).mode | 0o111);
    }
    return reply.send({ path: params["*"], status: "written" });
  });

  app.post("/api/v1/workspaces/:workspaceId/skills/import-github/preview", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string };
    if (!requireHealthyWorkspaceFolder(store, params.workspaceId, reply)) {
      return;
    }
    const url = requiredString(request.body.url, "url");
    const ref = typeof request.body.ref === "string" ? request.body.ref : undefined;
    try {
      return reply.send(await previewSkillFromGithub({ url, ref }));
    } catch (error) {
      if (error instanceof SkillImportError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 502, error instanceof Error ? error.message : "skill import preview failed");
    }
  });

  app.post("/api/v1/workspaces/:workspaceId/skills/import-github", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { workspaceId: string };
    const workspaceDir = requireHealthyWorkspaceFolder(store, params.workspaceId, reply);
    if (!workspaceDir) {
      return;
    }
    const url = requiredString(request.body.url, "url");
    const ref = typeof request.body.ref === "string" ? request.body.ref : undefined;
    try {
      return reply.send(await importSkillFromGithub({ workspaceDir, url, ref }));
    } catch (error) {
      if (error instanceof SkillImportError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 502, error instanceof Error ? error.message : "skill import failed");
    }
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
      // Pull the display name straight from yaml so the desktop's app
      // catalog doesn't have to maintain a per-app hardcoded table.
      let displayName: string | null = null;
      const configPath = typeof entry.config_path === "string" ? entry.config_path : "";
      if (appId && configPath) {
        try {
          const manifestPath = path.join(workspaceDir, configPath);
          if (fs.existsSync(manifestPath)) {
            const yamlDoc = yaml.load(fs.readFileSync(manifestPath, "utf8"));
            if (isRecord(yamlDoc) && typeof yamlDoc.name === "string") {
              const trimmed = yamlDoc.name.trim();
              if (trimmed) displayName = trimmed;
            }
          }
        } catch {
          displayName = null;
        }
      }
      // Parse the app's yaml so the desktop can render a per-app Connect /
      // Bind control without having to hardcode an appId→provider map.
      // Failures (yaml unreadable, port allocation issue) leave
      // `integrations` empty rather than poisoning the list response.
      let integrations: Array<{
        key: string;
        provider: string;
        capability: string | null;
        required: boolean;
        whoami?: unknown;
      }> = [];
      if (appId) {
        try {
          const resolved = resolveWorkspaceAppRuntime(workspaceDir, appId, {
            store,
            workspaceId,
            allocatePorts: false,
          });
          integrations =
            resolved.resolvedApp.integrations?.map((integration) => ({
              key: integration.key,
              provider: integration.provider,
              capability: integration.capability,
              required: integration.required,
              // Forward whoami so the App Surface's Connect button can pass
              // it to Hono `/composio/connect` the same way the chat
              // Connect card does (Stage 4 whoami passthrough).
              ...(integration.whoami ? { whoami: integration.whoami } : {}),
            })) ?? [];
        } catch {
          integrations = [];
        }
      }
      return {
        app_id: appId,
        name: displayName,
        config_path: typeof entry.config_path === "string" ? entry.config_path : "",
        lifecycle: isRecord(entry.lifecycle) ? entry.lifecycle : null,
        build_status: status,
        ready: status === "running",
        error: build?.status === "failed" ? (build.error ?? "unknown error") : null,
        integrations
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
      try {
        removeComposioMcpRegistryEntry(store.workspaceDir(workspaceId));
      } catch {
        // best-effort migration; the inline path doesn't read workspace.yaml.
      }
      const result = await ensureAllAppsRunning(workspaceId);
      return result;
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

    // Snapshot the app's currently-allocated ports BEFORE we touch any state,
    // so we can force-kill any orphan process holding them as a safety net —
    // matches the workspace-delete path. Without this, a silently-failed
    // stopApp leaves a zombie process bound to the port, the state row gets
    // released, and the next install can hand the port to a different app
    // (state says appA@P, OS says appB@P) — exactly the misalignment that
    // makes the desktop iframe render the wrong app's UI.
    const allocatedPorts: number[] = [
      store.getAppPort({ workspaceId, appId: `${appId}__http` })?.port,
      store.getAppPort({ workspaceId, appId: `${appId}__mcp` })?.port
    ].filter((p): p is number => typeof p === "number" && p > 0);

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

    if (allocatedPorts.length > 0) {
      try {
        await killPortListeners(allocatedPorts);
      } catch {
        app.log.debug(
          { workspaceId, appId, ports: allocatedPorts },
          "best-effort port kill during app uninstall"
        );
      }
    }

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

    const rawHarnessId = optionalString(request.body.harness_id);
    if (rawHarnessId !== undefined && rawHarnessId !== null && !validateRequestedHarnessId(rawHarnessId)) {
      return sendError(reply, 400, `unsupported harness: ${rawHarnessId}`);
    }
    const resolvedHarnessId =
      validateRequestedHarnessId(rawHarnessId) ?? resolvedWorkspaceHarness(workspace);

    const session = store.ensureSession({
      workspaceId,
      sessionId,
      kind:
        canonicalAgentSessionKind(optionalString(request.body.kind)) ??
        inferredSessionKind(workspace, sessionId),
      // An explicit title wins. Otherwise derive one from the message the
      // caller is about to send, using the SAME function the queue route uses,
      // so a session is listable from birth rather than from whenever its first
      // input lands.
      //
      // The sidebar hides titleless sessions as empty placeholders, and the
      // title used to be written only by the queue route — so the row for a
      // session appeared not when it was created but whenever the send finished
      // assembling and queueing, which was seconds later. Deriving it here
      // rather than in the client keeps one implementation of the rules for
      // attachments and image-only sends.
      title:
        nullableString(request.body.title) ??
        sessionTitleFromFirstUserInput(
          optionalString(request.body.first_user_text) ?? "",
          [],
        ),
      parentSessionId: nullableString(request.body.parent_session_id) ?? null,
      projectId: nullableString(request.body.project_id) ?? null,
      harnessId: resolvedHarnessId,
      createdBy: nullableString(request.body.created_by) ?? "workspace_user",
      owningAppId: nullableString(request.body.app_id) ?? null,
      orgId: currentActiveOrgId(),
    });
    if (!store.getBinding({ workspaceId, sessionId })) {
      store.upsertBinding({
        workspaceId,
        sessionId,
        harness: resolvedHarnessId,
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

    let resolvedSessionId: string;
    try {
      resolvedSessionId = resolveQueueSessionId(optionalString(request.body.session_id), store, workspace);
    } catch (error) {
      return sendError(reply, 409, error instanceof Error ? error.message : "workspace session is not configured");
    }
    const executionWorkspaceId = workspaceId;
    const executionWorkspace = workspace;
    const blockingApps = blockingWorkspaceApps({ store, workspaceId: executionWorkspaceId });
    if (blockingApps.length > 0) {
      return sendError(reply, 409, blockingWorkspaceAppsMessage(blockingApps));
    }

    const workspaceDir = store.workspaceDir(executionWorkspaceId);
    const trimmedText = (optionalString(request.body.text) ?? "").trim();
    // Ambient context about the open HolaApp/surface. Folded into the agent's
    // turn instruction (instructionWithAppContext) but never persisted as the
    // user message — the displayed bubble stays exactly what the user typed.
    const appContextText = (
      optionalString(request.body.app_context_text) ?? ""
    ).trim();
    let attachments: SessionInputAttachmentPayload[];
    try {
      attachments = requiredSessionInputAttachments(request.body.attachments, workspaceDir);
    } catch (error) {
      return sendError(reply, 422, error instanceof Error ? error.message : "attachments are invalid");
    }
    let imageUrls: string[];
    try {
      imageUrls = requiredSessionInputImageUrls(request.body.image_urls);
    } catch (error) {
      return sendError(reply, 422, error instanceof Error ? error.message : "image_urls are invalid");
    }
    if (!trimmedText && attachments.length === 0 && imageUrls.length === 0) {
      return sendError(reply, 422, "text, attachments, or image_urls are required");
    }

    const existingSession = store.getSession({
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId
    });
    const inferredKind = existingSession?.kind ?? inferredSessionKind(executionWorkspace, resolvedSessionId);
    const linkedIssue = store.getIssueBySessionId({
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId,
    });
    if (linkedIssue) {
      try {
        const queuedIssueReply = runtimeAgentToolsService.queueIssueReply({
          workspaceId: executionWorkspaceId,
          issueId: linkedIssue.issueId,
          text: trimmedText,
          attachments,
          imageUrls,
          model: nullableString(request.body.model) ?? undefined,
          selectedThinkingValue:
            nullableString(request.body.thinking_value) ?? undefined,
          priority: optionalInteger(request.body.priority, 0),
        });
        const runtimeState = store.getRuntimeState({
          workspaceId: executionWorkspaceId,
          sessionId: resolvedSessionId,
        });
        const queueAwareState = effectiveSessionState(store, runtimeState, true);
        return {
          input_id: queuedIssueReply.input.inputId,
          session_id: queuedIssueReply.session.sessionId,
          status: queuedIssueReply.input.status,
          effective_state: queueAwareState.effective_state,
          runtime_status: queueAwareState.runtime_status,
          current_input_id: queueAwareState.current_input_id,
          has_queued_inputs: true,
        };
      } catch (error) {
        if (error instanceof RuntimeAgentToolsServiceError) {
          return sendError(reply, error.statusCode, error.message);
        }
        return sendError(
          reply,
          400,
          error instanceof Error ? error.message : "issue reply queue failed",
        );
      }
    }
    const generatedSessionTitle = sessionTitleFromFirstUserInput(trimmedText, attachments, imageUrls);

    store.ensureSession({
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId,
      kind: inferredKind,
      title: existingSession?.title?.trim() ? undefined : generatedSessionTitle,
      // Stamped only when this lazily creates a fresh session (immutable on an
      // existing one), so a first-message app draft stays owned by its HolaApp.
      owningAppId: nullableString(request.body.app_id) ?? null,
      orgId: currentActiveOrgId()
    });
    if (!store.getBinding({ workspaceId: executionWorkspaceId, sessionId: resolvedSessionId })) {
      store.upsertBinding({
        workspaceId: executionWorkspaceId,
        sessionId: resolvedSessionId,
        harness: resolvedWorkspaceHarness(executionWorkspace),
        harnessSessionId: resolvedSessionId
      });
    }
    const runtimeStateBeforeQueue =
      store.getRuntimeState({
        workspaceId: executionWorkspaceId,
        sessionId: resolvedSessionId,
      }) ??
      store.ensureRuntimeState({
        workspaceId: executionWorkspaceId,
        sessionId: resolvedSessionId,
        status: "IDLE"
      });
    const pendingBackgroundUpdateEvents =
      canInlineBackgroundUpdatesIntoSessionKind(
        existingSession?.kind ?? inferredKind,
      )
        ? store.listPendingMainSessionEvents({
            workspaceId: executionWorkspaceId,
            ownerMainSessionId: resolvedSessionId,
            deliveryBucket: "background_update",
            limit: 200,
          })
        : [];
    const inlineBackgroundUpdateIds = pendingBackgroundUpdateEvents.map(
      (event) => event.eventId,
    );
    const record = store.enqueueInput({
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId,
      priority: optionalInteger(request.body.priority, 0),
      idempotencyKey: nullableString(request.body.idempotency_key) ?? null,
      payload: {
        text: trimmedText,
        attachments,
        image_urls: imageUrls,
        model: nullableString(request.body.model) ?? null,
        thinking_value: nullableString(request.body.thinking_value) ?? null,
        context: {
          ...(appContextText ? { app_context_text: appContextText } : {}),
          ...(inlineBackgroundUpdateIds.length > 0
            ? {
                main_session_event_ids: inlineBackgroundUpdateIds,
                delivery_bucket: "background_update",
                main_session_event_mode: "inline_user_reply",
                queued_events: groupedMainSessionEventsPayload(
                  pendingBackgroundUpdateEvents,
                ),
                attached_at: utcNowIso(),
              }
            : {}),
        }
      }
    });
    if (inlineBackgroundUpdateIds.length > 0) {
      store.markMainSessionEventsMaterialized({
        workspaceId: executionWorkspaceId,
        eventIds: inlineBackgroundUpdateIds,
        materializedInputId: record.inputId,
      });
    }
    // A normal queued input supersedes any open ask_user_question — the user
    // answered by typing instead of picking an option. Clear the stored question
    // so its card doesn't linger (or reappear on reconcile) once the run resumes.
    if (existingSession?.activeUserQuestion) {
      store.setSessionActiveUserQuestion({
        workspaceId: executionWorkspaceId,
        sessionId: resolvedSessionId,
        activeUserQuestion: null,
      });
    }
    createInputMemoryUpdateProposals({
      store,
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId,
      inputId: record.inputId,
      sourceMessageId: `user-${record.inputId}`,
      text: trimmedText,
    });
    if (runtimeStateHasClaimedActiveInput(store, runtimeStateBeforeQueue)) {
      store.updateRuntimeState({
        workspaceId: executionWorkspaceId,
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
        workspaceId: executionWorkspaceId,
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
      workspaceId: executionWorkspaceId,
      sessionId: resolvedSessionId,
    });
    const queueAwareState = effectiveSessionState(store, runtimeStateAfterQueue, true);
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;

    const paused = await queueWorker.pauseSessionRun({
      workspaceId: effectiveWorkspaceId,
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

  app.patch("/api/v1/agent-sessions/:sessionId/harness", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { sessionId: string };
    const workspaceId = optionalString(request.body.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    const rawHarnessId = optionalString(request.body.harness_id);
    const resolvedHarnessId = validateRequestedHarnessId(rawHarnessId);
    if (!resolvedHarnessId) {
      return sendError(reply, 400, `unsupported harness: ${rawHarnessId ?? ""}`);
    }
    try {
      const updated = store.updateSessionHarnessId({
        workspaceId,
        sessionId: params.sessionId,
        harnessId: resolvedHarnessId,
      });
      return { session: agentSessionPayload(updated, store) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // updateSessionHarnessId throws when the session already has
      // queued inputs — the harness is immutable from that point.
      // Surface as 409 (conflict) so the client can show "you can't
      // change the harness mid-session" rather than a generic 500.
      if (/inputs already queued/.test(message)) {
        return sendError(reply, 409, message);
      }
      if (/not found/i.test(message)) {
        return sendError(reply, 404, message);
      }
      return sendError(reply, 500, message);
    }
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;

    const input = store.getInput({
      workspaceId: effectiveWorkspaceId,
      inputId: params.inputId,
    });
    if (
      !input ||
      input.workspaceId !== effectiveWorkspaceId ||
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
    const existingImageUrls = Array.isArray(existingPayload.image_urls)
      ? existingPayload.image_urls
      : [];
    if (!trimmedText && existingAttachments.length === 0 && existingImageUrls.length === 0) {
      return sendError(reply, 422, "text, attachments, or image_urls are required");
    }

    const updated = store.updateInput({
      workspaceId: effectiveWorkspaceId,
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

  app.delete("/api/v1/agent-sessions/:sessionId/inputs/:inputId", async (request, reply) => {
    const params = request.params as { sessionId: string; inputId: string };
    const query = isRecord(request.query) ? request.query : {};
    const body = isRecord(request.body) ? request.body : {};
    const workspaceId =
      optionalString(query.workspace_id) ?? optionalString(body.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;

    const input = store.getInput({
      workspaceId: effectiveWorkspaceId,
      inputId: params.inputId,
    });
    if (
      !input ||
      input.workspaceId !== effectiveWorkspaceId ||
      input.sessionId !== params.sessionId
    ) {
      return sendError(reply, 404, "queued input not found");
    }
    if (input.status !== "QUEUED") {
      return sendError(reply, 409, "queued input can no longer be cancelled");
    }

    const updated = store.updateInput({
      workspaceId: effectiveWorkspaceId,
      inputId: params.inputId,
      fields: {
        status: "CANCELLED",
      },
    });
    if (!updated) {
      return sendError(reply, 500, "failed to cancel queued input");
    }

    return {
      input_id: updated.inputId,
      session_id: updated.sessionId,
      status: updated.status,
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId: resolvedWorkspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? resolvedWorkspaceId;
    const runtimeState = store.getRuntimeState({
      sessionId: params.sessionId,
      workspaceId: effectiveWorkspaceId
    });
    const hasQueued = store.hasAvailableInputsForSession({
      sessionId: params.sessionId,
      workspaceId: effectiveWorkspaceId
    });
    return effectiveSessionState(store, runtimeState, hasQueued);
  });

  app.get("/api/v1/agent-sessions/by-workspace/:workspaceId/runtime-states", async (request) => {
    const params = request.params as { workspaceId: string };

    // Workspaces (or labs) whose folder has been moved/deleted will throw from
    // workspaceRuntimeDb. Isolate each source so a single bad bundle can't
    // turn the whole endpoint into a 500.
    const listStatesSafe = (workspaceId: string): SessionRuntimeStateRecord[] => {
      try {
        return store.listRuntimeStates(workspaceId);
      } catch (error) {
        app.log.warn(
          { err: error instanceof Error ? error.message : String(error), workspaceId },
          "by-workspace/runtime-states: listRuntimeStates failed",
        );
        return [];
      }
    };

    const states = [...listStatesSafe(params.workspaceId)];

    const items: Record<string, unknown>[] = [];
    for (const item of states) {
      try {
        const hasQueuedInputs = store.hasAvailableInputsForSession({
          workspaceId: item.workspaceId,
          sessionId: item.sessionId,
        });
        const lastTurnResult =
          store.listTurnResults({
            workspaceId: item.workspaceId,
            sessionId: item.sessionId,
            limit: 1,
            offset: 0,
          })[0] ?? null;
        items.push(
          runtimeStateListItemPayload({
            store,
            record: item,
            lastTurnResult,
            hasQueuedInputs,
          }),
        );
      } catch (error) {
        app.log.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            workspaceId: item.workspaceId,
            sessionId: item.sessionId,
          },
          "by-workspace/runtime-states: skipping runtime state due to error",
        );
      }
    }

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

    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    if (!scope) {
      return sendError(reply, 404, "workspace not found");
    }
    const effectiveWorkspaceId = scope.workspaceId;
    const effectiveWorkspace = scope.workspace;
    const session = store.getSession({
      workspaceId: effectiveWorkspaceId,
      sessionId: params.sessionId,
    });
    if (!session) {
      return sendError(reply, 404, "session not found");
    }
    const binding = store.getBinding({ workspaceId: effectiveWorkspaceId, sessionId: params.sessionId });

    const limit = Math.max(1, Math.min(1000, optionalInteger(query.limit, 200)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const order = optionalString(query.order) === "desc" ? "desc" : "asc";
    const total = store.countSessionMessages({ workspaceId: effectiveWorkspaceId, sessionId: params.sessionId });
    const messages = store
      .listSessionMessages({
        workspaceId: effectiveWorkspaceId,
        sessionId: params.sessionId,
        limit,
        offset,
        order
      })
      .map((message: SessionMessageRecord) => {
        const inputAttachments = sessionMessageAttachments(store, effectiveWorkspaceId, message);
        const metadata = inputAttachments.length > 0 ? { ...message.metadata, attachments: inputAttachments } : message.metadata;
        return sessionMessagePayload(message, metadata);
      });
    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      harness: binding?.harness ?? resolvedWorkspaceHarness(effectiveWorkspace),
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;

    const inputId = optionalString(query.input_id);
    const limit = Math.max(1, Math.min(1000, optionalInteger(query.limit, 200)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const total = store.countTurnResults({
      workspaceId: effectiveWorkspaceId,
      sessionId: params.sessionId,
      inputId: inputId ?? undefined,
    });
    const items = store
      .listTurnResults({
        workspaceId: effectiveWorkspaceId,
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

  app.get("/api/v1/workspaces/:workspaceId/turn-results", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(params.workspaceId);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }

    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }

    const sessionId = optionalString(query.session_id);
    const inputId = optionalString(query.input_id);
    const status = optionalString(query.status);
    const limit = Math.max(1, Math.min(2000, optionalInteger(query.limit, 500)));
    const offset = Math.max(0, optionalInteger(query.offset, 0));
    const order = optionalString(query.order) === "asc" ? "asc" : "desc";

    const total = store.countWorkspaceTurnResults({
      workspaceId,
      sessionId: sessionId ?? undefined,
      inputId: inputId ?? undefined,
      status: status ?? undefined,
    });
    const items = store
      .listWorkspaceTurnResults({
        workspaceId,
        sessionId: sessionId ?? undefined,
        inputId: inputId ?? undefined,
        status: status ?? undefined,
        order,
        limit,
        offset,
      })
      .map((item: TurnResultRecord) => turnResultPayload(item));

    return {
      workspace_id: workspaceId,
      session_id: sessionId ?? null,
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;
    const items = store
      .listTurnRequestSnapshots({
        workspaceId: effectiveWorkspaceId,
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;
    return {
      workspace_id: workspaceId,
      session_id: params.sessionId,
      input_id: inputId || null,
      session_resume_context: loadSessionResumeContextForApi({
        workspaceRoot: store.workspaceRoot,
        workspaceId: effectiveWorkspaceId,
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId: resolvedWorkspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? resolvedWorkspaceId;
    const items = store
      .listOutputs({
        workspaceId: effectiveWorkspaceId,
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
    const workspaceIds = [params.workspaceId];
    const runtimeStates = workspaceIds
      .flatMap((workspaceId) => store.listRuntimeStates(workspaceId))
      .slice(offset, offset + limit);
    const outputs = workspaceIds.flatMap((workspaceId) =>
      store.listOutputs({
        workspaceId,
        limit: 1000,
        offset: 0,
      }),
    )
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
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          limit: 1,
          offset: 0,
        })[0] ?? null;
      const hasQueuedInputs = store.hasAvailableInputsForSession({
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
      });
      return {
        ...runtimeStateListItemPayload({
          store,
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
    // project_scope: "general" → only General outputs; "<projectId>" → only
    // that project's outputs; omitted → all outputs in the workspace.
    const projectScope = optionalString(query.project_scope);
    const projectFilter: string | null | undefined =
      projectScope === undefined
        ? undefined
        : projectScope === "general"
          ? null
          : projectScope;
    const items = store.listOutputs({
      workspaceId,
      projectId: projectFilter,
      outputType: optionalString(query.output_type) ?? null,
      status: optionalString(query.status) ?? null,
      platform: optionalString(query.platform) ?? null,
      folderId: optionalString(query.folder_id) ?? null,
      sessionId: optionalString(query.session_id) ?? null,
      inputId: optionalString(query.input_id) ?? null,
      limit: Math.max(1, Math.min(200, optionalInteger(query.limit, 50))),
      offset: Math.max(0, optionalInteger(query.offset, 0))
    });
    const reconciled = reconcileFileBackedOutputs(store, workspaceId, items);
    return { items: reconciled.map((item: OutputRecord) => outputPayload(item)) };
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

  // Daily team activity rollup. Returns the outputs produced on a given
  // (UTC) date, grouped by the teammate or plugin that produced them.
  // Producer attribution is best-effort: metadata fields like
  // `produced_by_teammate_id` / `produced_by_plugin_id` are preferred
  // when present, falling back to the top-level `module_id`, then to a
  // synthetic "unknown" bucket so freshly-created outputs without
  // attribution still surface.
  app.get("/api/v1/workspaces/:workspaceId/activity", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspaceId = optionalString(params.workspaceId);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const query = isRecord(request.query) ? request.query : {};
    const dateParam = optionalString(query.date);
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return sendError(reply, 400, "date must be YYYY-MM-DD");
    }

    // Pull a generous slice and filter in memory by UTC calendar day —
    // SQLite's DATE() works on ISO timestamps but the surrounding
    // listOutputs call also clips to a max of 200, so we go through the
    // store-internal accessor pattern: list with the max window, then
    // filter. 1000 is generous for a single day on a single workspace.
    const allOutputs = store.listOutputs({
      workspaceId,
      limit: 1000,
      offset: 0,
    });
    const dayOutputs = allOutputs.filter((output) => {
      const createdAt = output.createdAt;
      if (!createdAt) return false;
      return createdAt.slice(0, 10) === dateParam;
    });
    dayOutputs.sort((left, right) => {
      const leftTime = Date.parse(left.createdAt ?? "") || 0;
      const rightTime = Date.parse(right.createdAt ?? "") || 0;
      return rightTime - leftTime;
    });

    type ProducerKind = "teammate" | "plugin" | "unknown";
    interface ProducerBucket {
      producer_id: string;
      producer_name: string;
      producer_kind: ProducerKind;
      count: number;
    }

    // Teammate name resolution is retired with the teammate concept; if any
    // legacy activity rows still carry a teammate id, return it untouched so
    // the response remains shape-stable for callers that haven't migrated.
    const resolveTeammateName = (_teammateId: string): string | null => null;

    // Plugin name resolution is retired with the plugin concept; legacy
    // activity rows that still carry a plugin id fall back to the id itself
    // (see the `resolvePluginName(...) ?? pluginId` call site).
    const resolvePluginName = (_pluginId: string): string | null => null;

    const stringMetadata = (
      metadata: Record<string, unknown>,
      key: string,
    ): string | null => {
      const value = metadata[key];
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const buckets = new Map<string, ProducerBucket>();
    for (const output of dayOutputs) {
      const metadata = isRecord(output.metadata) ? output.metadata : {};
      const teammateId = stringMetadata(metadata, "produced_by_teammate_id");
      const metadataPluginId = stringMetadata(metadata, "produced_by_plugin_id");
      const moduleIdFallback = (output.moduleId ?? "").trim() || null;
      const pluginId = metadataPluginId ?? moduleIdFallback;

      let kind: ProducerKind = "unknown";
      let id = "unknown";
      let name = "Unknown teammate";
      if (teammateId) {
        kind = "teammate";
        id = teammateId;
        name = resolveTeammateName(teammateId) ?? teammateId;
      } else if (pluginId) {
        kind = "plugin";
        id = pluginId;
        name = resolvePluginName(pluginId) ?? pluginId;
      }

      const bucketKey = `${kind}:${id}`;
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(bucketKey, {
          producer_id: id,
          producer_name: name,
          producer_kind: kind,
          count: 1,
        });
      }
    }

    const byProducer = Array.from(buckets.values()).sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.producer_name.localeCompare(b.producer_name);
    });

    return {
      workspace_id: workspaceId,
      date: dateParam,
      outputs: dayOutputs.map((item: OutputRecord) => outputPayload(item)),
      by_producer: byProducer,
      total: dayOutputs.length,
    };
  });

  app.post(
    "/api/v1/workspaces/:workspaceId/outputs/search",
    async (request, reply) => {
      const params = request.params as { workspaceId: string };
      const workspaceId = optionalString(params.workspaceId);
      if (!workspaceId) {
        return sendError(reply, 400, "workspace_id is required");
      }
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) {
        return sendError(reply, 404, "workspace not found");
      }
      if (!isRecord(request.body)) {
        return sendError(reply, 400, "request body must be an object");
      }
      const query = optionalString(request.body.query) ?? "";
      const limit = optionalInteger(request.body.limit, 20);
      const offset = optionalInteger(request.body.offset, 0);
      const filters = isRecord(request.body.filters) ? request.body.filters : {};
      const producerId = optionalString(filters.producer_id) ?? null;
      const dateRange = isRecord(filters.date_range) ? filters.date_range : null;
      const dateRangeStart = dateRange
        ? optionalString(dateRange.start) ?? null
        : null;
      const dateRangeEnd = dateRange
        ? optionalString(dateRange.end) ?? null
        : null;
      const { results, total } = store.searchOutputs({
        workspaceId,
        query,
        producerId,
        dateRangeStart,
        dateRangeEnd,
        limit,
        offset,
      });
      return {
        workspace_id: workspaceId,
        query,
        total,
        results: results.map((entry) => ({
          output: outputPayload(entry.output),
          snippet: entry.snippet,
        })),
      };
    },
  );

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
    try {
      return runtimeAgentToolsService.listCronjobs({
        workspaceId,
        enabledOnly: optionalBoolean(query.enabled_only, false),
        limit: optionalNumber(query.limit),
        offset: optionalNumber(query.offset),
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "cronjob list failed");
    }
  });

  app.post("/api/v1/cronjobs", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return runtimeAgentToolsService.createCronjob({
        workspaceId: requiredString(request.body.workspace_id, "workspace_id"),
        sessionId: optionalString(request.body.session_id),
        selectedModel:
          optionalString(request.body.model) ??
          optionalString(request.body.selected_model),
        initiatedBy: requiredString(request.body.initiated_by, "initiated_by"),
        name: optionalString(request.body.name),
        cron: requiredString(request.body.cron, "cron"),
        description: requiredString(request.body.description, "description"),
        instruction:
          optionalString(request.body.instruction) ??
          requiredString(request.body.description, "description"),
        enabled: optionalBoolean(request.body.enabled, true),
        delivery: optionalCronjobDeliveryInput(request.body.delivery),
        metadata: optionalDict(request.body.metadata) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "cronjob create failed");
    }
  });

  app.get("/api/v1/cronjobs/:jobId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    try {
      const payload = runtimeAgentToolsService.getCronjob({
        workspaceId,
        jobId: params.jobId,
      });
      if (!payload) {
        return sendError(reply, 404, "Cronjob not found");
      }
      return payload;
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "cronjob fetch failed");
    }
  });

  // Shared executor for "run this cronjob now" used by both the user-facing
  // REST route and the runtime-tools capability surface (cronjobs_run_now).
  // Migrates legacy cronjobs into workflows on demand, then kicks off a one-
  // off workflow execution off the cron trigger node.
  type RunCronjobNowOutcome =
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; status: number; message: string };
  async function runCronjobNowOp(args: {
    workspaceId: string;
    jobId: string;
    triggeredBy?: string | null;
    // Main session whose chat pane should receive a running pill for
    // the spawned subagent. Tool-call route uses the caller session;
    // the REST route reads it from the request body (desktop UI passes
    // the active session). When null, no pill is routed.
    ownerMainSessionId?: string | null;
  }): Promise<RunCronjobNowOutcome> {
    const workspace = store.getWorkspace(args.workspaceId);
    if (!workspace) {
      return { ok: false, status: 404, message: "Workspace not found" };
    }
    const cronjob = store.getCronjob({
      workspaceId: args.workspaceId,
      jobId: args.jobId,
    });
    if (!cronjob) {
      return { ok: false, status: 404, message: "Cronjob not found" };
    }
    try {
      const fired = fireCronjob({
        store,
        workspace,
        cronjob,
        triggeredBy: args.triggeredBy?.trim() || "cronjob_run",
      });
      const updated =
        store.updateCronjob({
          workspaceId: args.workspaceId,
          jobId: args.jobId,
          lastRunAt: utcNowIso(),
          runCount: cronjob.runCount + 1,
          lastStatus: "fired",
          lastError: null,
        }) ?? cronjob;
      return {
        ok: true,
        payload: {
          success: true,
          cronjob: cronjobPayload(updated),
          session_id: fired.sessionId,
          notification_id: null,
        },
      };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        message: error instanceof Error ? error.message : "cronjob run failed",
      };
    }
  }

  app.post("/api/v1/cronjobs/:jobId/run", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const body = isRecord(request.body) ? request.body : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    const outcome = await runCronjobNowOp({
      workspaceId,
      jobId: params.jobId,
      triggeredBy: optionalString(body.created_by),
      // Desktop UI passes the active main session id here so the
      // spawned subagent's running pill lands in that chat pane.
      ownerMainSessionId: optionalString(body.owner_main_session_id),
    });
    if (!outcome.ok) {
      return sendError(reply, outcome.status, outcome.message);
    }
    return outcome.payload;
  });

  app.patch("/api/v1/cronjobs/:jobId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const params = request.params as { jobId: string };
    try {
      return runtimeAgentToolsService.updateCronjob({
        jobId: params.jobId,
        workspaceId: requiredString(request.body.workspace_id, "workspace_id"),
        name: hasOwn(request.body, "name")
          ? nullableString(request.body.name)
          : undefined,
        cron: hasOwn(request.body, "cron")
          ? nullableString(request.body.cron)
          : undefined,
        description: hasOwn(request.body, "description")
          ? nullableString(request.body.description)
          : undefined,
        instruction: hasOwn(request.body, "instruction")
          ? nullableString(request.body.instruction)
          : undefined,
        enabled: hasOwn(request.body, "enabled")
          ? optionalBoolean(request.body.enabled, false)
          : undefined,
        delivery: hasOwn(request.body, "delivery")
          ? optionalCronjobDeliveryInput(request.body.delivery) ?? null
          : undefined,
        metadata: hasOwn(request.body, "metadata")
          ? optionalDict(request.body.metadata) ?? {}
          : undefined,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "cronjob update failed");
    }
  });

  app.delete("/api/v1/cronjobs/:jobId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const params = request.params as { jobId: string };
    try {
      const result = runtimeAgentToolsService.deleteCronjob({
        workspaceId,
        jobId: params.jobId,
      });
      if (result.success !== true) {
        return sendError(reply, 404, "Cronjob not found");
      }
      return result;
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "cronjob delete failed");
    }
  });

  app.get("/api/v1/capabilities", async (_request, reply) => {
    try {
      const toCatalogDto = (capability: ReturnType<typeof loadCapabilityCatalog>[number]) => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        category: capability.category,
        icon: capability.icon,
        skills: capability.skills,
        integrations: capability.integrations,
      });
      return reply.send({ capabilities: loadCapabilityCatalog().map(toCatalogDto) });
    } catch (error) {
      return sendError(reply, 500, error instanceof Error ? error.message : "capability catalog load failed");
    }
  });

  app.get("/api/v1/workspaces/:workspaceId/capabilities", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    return reply.send({ capabilities: store.listWorkspaceCapabilities({ workspaceId: params.workspaceId }) });
  });

  app.post<{ Body: { workspaceId?: unknown; capabilityId?: unknown } }>(
    "/api/v1/capabilities/install",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const workspaceId = optionalString(body.workspaceId);
      const capabilityId = optionalString(body.capabilityId);
      if (!workspaceId || !capabilityId) {
        return sendError(reply, 400, "workspaceId and capabilityId are required");
      }
      const capability = loadCapabilityCatalog().find((entry) => entry.id === capabilityId);
      if (!capability) {
        return reply.code(404).send({ error: "capability not found" });
      }
      // installCapability is async: without the await this replied with a
      // pending promise, which serializes to `{}` — and responded before the
      // install had actually finished.
      const result = await installCapability({
        store,
        workspaceId,
        workspaceDir: store.workspaceDir(workspaceId),
        capability,
      });
      return reply.send(result);
    },
  );

  app.post<{ Body: { workspaceId?: unknown; capabilityId?: unknown } }>(
    "/api/v1/capabilities/uninstall",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const workspaceId = optionalString(body.workspaceId);
      const capabilityId = optionalString(body.capabilityId);
      if (!workspaceId || !capabilityId) {
        return sendError(reply, 400, "workspaceId and capabilityId are required");
      }
      const removed = uninstallCapability({
        store,
        workspaceId,
        workspaceDir: store.workspaceDir(workspaceId),
        capabilityId,
      });
      return reply.send({ removed });
    },
  );

  app.post<{ Body: { workspaceId?: unknown; capabilityId?: unknown; enabled?: unknown } }>(
    "/api/v1/capabilities/toggle",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const workspaceId = optionalString(body.workspaceId);
      const capabilityId = optionalString(body.capabilityId);
      if (!workspaceId || !capabilityId) {
        return sendError(reply, 400, "workspaceId and capabilityId are required");
      }
      const record = setCapabilityEnabled({
        store,
        workspaceId,
        capabilityId,
        enabled: Boolean(body.enabled),
      });
      if (!record) {
        return reply.code(404).send({ error: "capability not found" });
      }
      return reply.send(record);
    },
  );


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

      const existing = store
        .listCronjobs({ workspaceId })
        .find((entry) => entry.metadata.import_key === importKey);

      if (existing) {
        skippedDetails.push({
          import_key: importKey,
          reason: "already_imported",
          id: existing.id,
        });
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
      try {
        const job = runtimeAgentToolsService.createCronjob({
          workspaceId,
          initiatedBy,
          name: entryName,
          cron: entryCron,
          description: entryDescription,
          instruction: entryInstruction,
          enabled: false,
          delivery: {
            channel: String(entryDelivery.channel ?? ""),
            mode: optionalString(entryDelivery.mode),
            to: entryDelivery.to,
          },
          metadata: importedMeta,
        });
        jobs.push(job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        skippedDetails.push({ import_key: importKey, reason: "create_failed", detail: message });
        continue;
      }
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

  app.get("/api/v1/issues", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    if (!requireHealthyWorkspaceFolder(store, workspaceId, reply)) {
      return;
    }
    const issues = store.listIssues({ workspaceId }).map((record) => issuePayload(record));
    return { issues, count: issues.length };
  });

  app.get("/api/v1/issues/:issueId", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    if (!requireHealthyWorkspaceFolder(store, workspaceId, reply)) {
      return;
    }
    const params = request.params as { issueId: string };
    const issue = store.getIssue({
      workspaceId,
      issueId: requiredString(params.issueId, "issueId"),
    });
    if (!issue) {
      return sendError(reply, 404, "issue not found");
    }
    return { issue: issuePayload(issue) };
  });

  app.post("/api/v1/issues", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = requireHealthyWorkspaceFolder(store, workspaceId, reply);
    if (!workspaceDir) {
      return;
    }
    try {
      let issue = store.createIssue({
        issueId: nullableString(request.body.issue_id) ?? undefined,
        workspaceId,
        sessionId: nullableString(request.body.session_id) ?? undefined,
        sourceType: nullableString(request.body.source_type) ?? null,
        blockedBy: parseIssueBlockedByInput(request.body.blocked_by),
        title: requiredString(request.body.title, "title"),
        description: nullableString(request.body.description) ?? null,
        status: requiredString(request.body.status, "status") as IssueRecord["status"],
        priority: nullableString(request.body.priority) as IssueRecord["priority"],
        blockerReason: nullableString(request.body.blocker_reason) ?? null,
        attachments: requiredIssueAttachments(request.body.attachments, workspaceDir),
        createdBy: nullableString(request.body.created_by) ?? "workspace_user",
      });
      let session = store.getSession({ workspaceId, sessionId: issue.sessionId });
      if (session && !store.getBinding({ workspaceId, sessionId: session.sessionId })) {
        store.upsertBinding({
          workspaceId,
          sessionId: session.sessionId,
          harness: resolvedWorkspaceHarness(workspace),
          harnessSessionId: session.sessionId,
        });
      }
      if (
        issue.status === "todo" &&
        !issueHasIncompleteBlockingTasks(store, issue)
      ) {
        const dispatchParams = issueDispatchParamsFromBody(request.body);
        const dispatched = runtimeAgentToolsService.dispatchIssue({
          workspaceId,
          issueId: issue.issueId,
          createdBy: issue.createdBy,
          parentSessionId: dispatchParams.parentSessionId,
          parentInputId: dispatchParams.parentInputId,
          originMainSessionId: dispatchParams.originMainSessionId,
          ownerMainSessionId: dispatchParams.ownerMainSessionId,
          priority: dispatchParams.priority,
        });
        issue = dispatched.issue;
        session = dispatched.session;
      }
      return {
        issue: issuePayload(issue),
        session: session ? agentSessionPayload(session, store) : null,
      };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "issue create failed");
    }
  });

  app.patch("/api/v1/issues/:issueId", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const body = request.body;
    const workspaceId = requiredString(body.workspace_id, "workspace_id");
    if (!store.getWorkspace(workspaceId)) {
      return sendError(reply, 404, "workspace not found");
    }
    const workspaceDir = requireHealthyWorkspaceFolder(store, workspaceId, reply);
    if (!workspaceDir) {
      return;
    }
    const params = request.params as { issueId: string };
    try {
      const existingIssue = store.getIssue({
        workspaceId,
        issueId: requiredString(params.issueId, "issueId"),
      });
      if (!existingIssue) {
        return sendError(reply, 404, "issue not found");
      }
      const mutatesExecutionState = [
        "title",
        "description",
        "status",
        "priority",
        "blocked_by",
        "blocker_reason",
        "attachments",
      ].some((key) => hasOwn(body, key));
      if (existingIssue.activeSubagentId && mutatesExecutionState) {
        return sendError(
          reply,
          409,
          "issue is currently running; stop the run before editing it",
        );
      }
      let issue = store.updateIssue({
        workspaceId,
        issueId: requiredString(params.issueId, "issueId"),
        fields: {
          sourceType: hasOwn(body, "source_type")
            ? (nullableString(body.source_type) ?? null)
            : undefined,
          title: hasOwn(body, "title") ? requiredString(body.title, "title") : undefined,
          blockedBy: hasOwn(body, "blocked_by")
            ? parseIssueBlockedByInput(body.blocked_by)
            : undefined,
          description: hasOwn(body, "description")
            ? (nullableString(body.description) ?? null)
            : undefined,
          status: hasOwn(body, "status")
            ? (requiredString(body.status, "status") as IssueRecord["status"])
            : undefined,
          priority: hasOwn(body, "priority")
            ? (nullableString(body.priority) as IssueRecord["priority"])
            : undefined,
          blockerReason: hasOwn(body, "blocker_reason")
            ? (nullableString(body.blocker_reason) ?? null)
            : undefined,
          attachments: hasOwn(body, "attachments")
            ? requiredIssueAttachments(body.attachments ?? [], workspaceDir)
            : undefined,
          activeSubagentId: hasOwn(body, "active_subagent_id")
            ? (nullableString(body.active_subagent_id) ?? null)
            : undefined,
          latestSubagentId: hasOwn(body, "latest_subagent_id")
            ? (nullableString(body.latest_subagent_id) ?? null)
            : undefined,
          completedAt: hasOwn(body, "completed_at")
            ? (nullableString(body.completed_at) ?? null)
            : undefined,
        },
      });
      if (!issue) {
        return sendError(reply, 404, "issue not found");
      }
      const shouldDispatchIssue =
        issue.status === "todo" &&
        !issue.activeSubagentId &&
        !issueHasIncompleteBlockingTasks(store, issue) &&
        (
          hasOwn(body, "blocked_by") ||
          existingIssue.status !== "todo"
        );
      if (shouldDispatchIssue) {
        const dispatchParams = issueDispatchParamsFromBody(body);
        const dispatched = runtimeAgentToolsService.dispatchIssue({
          workspaceId,
          issueId: issue.issueId,
          createdBy: issue.createdBy,
          parentSessionId: dispatchParams.parentSessionId,
          parentInputId: dispatchParams.parentInputId,
          originMainSessionId: dispatchParams.originMainSessionId,
          ownerMainSessionId: dispatchParams.ownerMainSessionId,
          priority: dispatchParams.priority,
        });
        issue = dispatched.issue;
      }
      return { issue: issuePayload(issue) };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : "issue update failed");
    }
  });

  app.post("/api/v1/issues/:issueId/stop", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const workspaceId = requiredString(request.body.workspace_id, "workspace_id");
    const params = request.params as { issueId: string };
    try {
      const issue = store.getIssue({
        workspaceId,
        issueId: requiredString(params.issueId, "issueId"),
      });
      if (!issue) {
        return sendError(reply, 404, "issue not found");
      }
      if (!nullableString(issue.activeSubagentId)) {
        return sendError(reply, 409, "issue is not currently running");
      }
      await runtimeAgentToolsService.cancelIssueRun({
        workspaceId,
        issueId: issue.issueId,
      });
      const updatedIssue = store.getIssue({
        workspaceId,
        issueId: issue.issueId,
      });
      if (!updatedIssue) {
        return sendError(reply, 404, "issue not found");
      }
      return {
        issue: issuePayload(updatedIssue),
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 400, error instanceof Error ? error.message : "issue stop failed");
    }
  });

  app.get("/api/v1/agent-sessions/:sessionId/outputs/events", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = isRecord(request.query) ? request.query : {};
    const workspaceId = optionalString(query.workspace_id);
    if (!workspaceId) {
      return sendError(reply, 400, "workspace_id is required");
    }
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;
    const inputId = optionalString(query.input_id);
    const includeHistory = optionalBoolean(query.include_history, true);
    const includeNative = optionalBoolean(query.include_native, false);
    const excludedEventTypes = includeNative ? [] : DEFAULT_EXCLUDED_SESSION_OUTPUT_EVENT_TYPES;
    let afterEventId = Math.max(0, optionalInteger(query.after_event_id, 0));
    if (!includeHistory && afterEventId <= 0) {
      afterEventId = store.latestOutputEventId({
        workspaceId: effectiveWorkspaceId,
        sessionId: params.sessionId,
        inputId,
        excludedEventTypes
      });
    }

    const items = store
      .listOutputEvents({
        workspaceId: effectiveWorkspaceId,
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
    const scope = resolveSessionWorkspaceScope({
      store,
      workspaceId,
      sessionId: params.sessionId,
    });
    const effectiveWorkspaceId = scope?.workspaceId ?? workspaceId;
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
              workspaceId: effectiveWorkspaceId,
              sessionId: params.sessionId,
              inputId,
              excludedEventTypes
            });
        yield sseComment("connected");

        while (true) {
          const events = store.listOutputEvents({
            workspaceId: effectiveWorkspaceId,
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

          // Block until the next output event for this session is written
          // (in-process signal) rather than polling on a fixed cadence. This is
          // what keeps token streaming smooth — a 50ms poll drains many tokens
          // as one burst ~20×/sec (jerky); waking on write delivers each delta
          // as it lands. STREAM_IDLE_FALLBACK_MS is the safety net for any
          // out-of-process writer whose signal never reaches us.
          await store.waitForOutputEvent({
            sessionId: params.sessionId,
            timeoutMs: STREAM_IDLE_FALLBACK_MS,
          });
        }
      })()
    );

    return reply.send(stream);
  });

  // Diagnostic route — exercises the full runtime → Hono → Composio
  // path through ComposioApiClient using the env-injected
  // HOLABOSS_AUTH_BEARER_TOKEN. Called by the IntegrationsPane debug
  // button so we can confirm desktop-side env injection + runtime SDK
  // + Hono /internal/* + bearer plugin all line up end-to-end.
  app.post("/api/v1/debug/composio-runtime-test", async (request, reply) => {
    const { createComposioApiClientFromEnv, ComposioApiClientError } =
      await import("./composio-api-client.js");
    const body = (isRecord(request.body) ? request.body : {}) as Record<
      string,
      unknown
    >;
    const providerSlug =
      typeof body.provider_slug === "string"
        ? body.provider_slug.trim().toLowerCase()
        : "gmail";
    const toolSlug =
      typeof body.tool_slug === "string"
        ? body.tool_slug.trim()
        : "GMAIL_FETCH_EMAILS";
    const actionArgs = isRecord(body.arguments)
      ? (body.arguments as Record<string, unknown>)
      : { max_results: 5 };

    const composio = createComposioApiClientFromEnv();
    if (!composio) {
      return reply.code(503).send({
        ok: false,
        stage: "client_init",
        error:
          "HOLABOSS_AUTH_BEARER_TOKEN and/or HOLABOSS_AUTH_BASE_URL not set — desktop hasn't injected the session token yet (sign in first, then restart the runtime).",
      });
    }

    // SDK's runtimeErrorFromBody only surfaces `message` when it's a string
    // (sdk/runtime-client/src/request.ts:90). The structured `error` object
    // is kept for programmatic callers; `message` is the human summary the
    // desktop logs and Error.message lands on.
    const summarize = (
      stage: string,
      info: ComposioApiClientErrorInfo | string,
    ): string => {
      if (typeof info === "string") return `${stage}: ${info}`;
      const status = info.status ?? "?";
      const slug = info.slug ? ` ${info.slug}` : "";
      const detail = info.message ?? info.code;
      return `${stage} [${status}${slug}]: ${detail}`;
    };

    let connections: Array<Record<string, unknown>> = [];
    try {
      const result = await composio.listConnections({ providerId: providerSlug });
      connections = result.connections;
    } catch (error) {
      if (error instanceof ComposioApiClientError) {
        return reply.code(error.httpStatus).send({
          ok: false,
          stage: "list_connections",
          message: summarize("list_connections", error.info),
          error: error.info,
        });
      }
      const raw = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({
        ok: false,
        stage: "list_connections",
        message: summarize("list_connections", raw),
        error: raw,
      });
    }
    if (connections.length === 0) {
      const msg = `No active ${providerSlug} connection for this user.`;
      return reply.code(404).send({
        ok: false,
        stage: "list_connections",
        message: msg,
        error: msg,
      });
    }
    const connectedAccountId = (() => {
      const candidate = connections[0];
      if (!candidate) return null;
      const id = (candidate as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    })();
    if (!connectedAccountId) {
      const msg = "Connection row missing an id field.";
      return reply.code(502).send({
        ok: false,
        stage: "list_connections",
        message: msg,
        error: msg,
      });
    }

    try {
      const result = await composio.executeAction({
        toolSlug,
        connectedAccountId,
        arguments: actionArgs,
      });
      return reply.send({
        ok: true,
        provider_slug: providerSlug,
        tool_slug: toolSlug,
        connected_account_id: connectedAccountId,
        log_id: result.logId,
        data: result.data,
      });
    } catch (error) {
      if (error instanceof ComposioApiClientError) {
        return reply.code(error.httpStatus).send({
          ok: false,
          stage: "execute_action",
          message: summarize("execute_action", error.info),
          error: error.info,
        });
      }
      const raw = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({
        ok: false,
        stage: "execute_action",
        message: summarize("execute_action", raw),
        error: raw,
      });
    }
  });

  return app;
}
function canonicalAgentSessionKind(kind: string | null | undefined): string | null {
  const normalized = (kind ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalizedPrimaryChatSessionKind(normalized);
}
