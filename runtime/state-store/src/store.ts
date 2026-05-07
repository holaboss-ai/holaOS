import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as sqliteVec from "sqlite-vec";

import { MigrationRunner, type MigrationLogEvent } from "./migrations.js";
import {
  LATEST_SEED_VERSION,
  RUNTIME_DB_MIGRATIONS,
} from "./migrations/index.js";

const HOST_STATE_DB_PATH_ENV = "HOLABOSS_HOST_STATE_DB_PATH";
const LEGACY_RUNTIME_DB_PATH_ENV = "HOLABOSS_RUNTIME_DB_PATH";
const CONTROL_PLANE_DB_PATH_ENV = "HOLABOSS_CONTROL_PLANE_DB_PATH";
const HOST_STATE_DB_FILENAME = "host-state.db";
const LEGACY_RUNTIME_DB_FILENAME = "runtime.db";
const WORKSPACE_RUNTIME_DIRNAME = ".holaboss";
const WORKSPACE_STATE_DIRNAME = "state";
const WORKSPACE_RUNTIME_DB_FILENAME = "runtime.db";
const WORKSPACE_IDENTITY_FILENAME = "workspace_id";
const LEGACY_WORKSPACE_METADATA_FILENAME = "workspace.json";
const DELETED_WORKSPACE_PATH_TOMBSTONE_PREFIX = "__deleted__";
const WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY =
  "legacy_workspace_backfill_v1_complete";
const WORKSPACE_SCOPED_LEGACY_BACKFILL_TABLES = [
  "agent_sessions",
  "agent_runtime_sessions",
  "conversation_bindings",
  "agent_session_inputs",
  "post_run_jobs",
  "main_session_event_queue",
  "session_runtime_state",
  "session_messages",
  "subagent_runs",
  "session_output_events",
  "terminal_sessions",
  "terminal_session_events",
  "turn_results",
  "turn_request_snapshots",
  "task_proposals",
  "evolve_skill_candidates",
  "memory_update_proposals",
  "memory_entries",
  "memory_embedding_index",
  "output_folders",
  "outputs",
  "app_builds",
  "app_ports",
  "cronjobs",
  "runtime_notifications",
] as const;

export interface WorkspaceRecord {
  id: string;
  name: string;
  status: string;
  harness: string | null;
  errorMessage: string | null;
  onboardingStatus: string;
  onboardingSessionId: string | null;
  onboardingCompletedAt: string | null;
  onboardingCompletionSummary: string | null;
  onboardingRequestedAt: string | null;
  onboardingRequestedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAtUtc: string | null;
}

export interface AgentSessionRecord {
  workspaceId: string;
  sessionId: string;
  kind: string;
  title: string | null;
  parentSessionId: string | null;
  sourceProposalId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SessionBindingRecord {
  workspaceId: string;
  sessionId: string;
  harness: string;
  harnessSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationBindingRecord {
  bindingId: string;
  workspaceId: string;
  channel: string;
  conversationKey: string;
  sessionId: string;
  role: string;
  isActive: boolean;
  metadata: Record<string, unknown>;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConnectionRecord {
  connectionId: string;
  providerId: string;
  ownerUserId: string;
  accountLabel: string;
  accountExternalId: string | null;
  /**
   * Stable provider-side identity (e.g. Twitter handle, Gmail address)
   * resolved from a whoami probe at connect time. Used to dedupe across
   * Composio re-auths, which mint a new `account_external_id` per flow
   * even for the same real account.
   */
  accountHandle: string | null;
  accountEmail: string | null;
  authMode: string;
  grantedScopes: string[];
  status: string;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationBindingRecord {
  bindingId: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  integrationKey: string;
  connectionId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInputRecord {
  inputId: string;
  sessionId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  availableAt: string;
  attempt: number;
  idempotencyKey: string | null;
  claimedBy: string | null;
  claimedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostRunJobRecord {
  jobId: string;
  jobType: string;
  inputId: string;
  sessionId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  availableAt: string;
  attempt: number;
  idempotencyKey: string | null;
  claimedBy: string | null;
  claimedUntil: string | null;
  lastError: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRuntimeStateRecord {
  workspaceId: string;
  sessionId: string;
  status: string;
  currentInputId: string | null;
  currentWorkerId: string | null;
  leaseUntil: string | null;
  heartbeatAt: string | null;
  lastError: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessageRecord {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface OutputEventRecord {
  id: number;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type TerminalSessionBackend = "node_pty";
export type TerminalSessionOwner = "agent" | "user";
export type TerminalSessionStatus = "starting" | "running" | "exited" | "failed" | "interrupted" | "closed";

export interface TerminalSessionRecord {
  terminalId: string;
  workspaceId: string;
  sessionId: string | null;
  inputId: string | null;
  title: string;
  backend: TerminalSessionBackend;
  owner: TerminalSessionOwner;
  status: TerminalSessionStatus;
  cwd: string;
  shell: string | null;
  command: string;
  exitCode: number | null;
  lastEventSeq: number;
  createdBy: string | null;
  createdAt: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface TerminalSessionEventRecord {
  id: number;
  terminalId: string;
  workspaceId: string;
  sessionId: string | null;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TurnResultRecord {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface TurnRequestSnapshotRecord {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  snapshotKind: string;
  fingerprint: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRunRecord {
  subagentId: string;
  workspaceId: string;
  parentSessionId: string | null;
  parentInputId: string | null;
  originMainSessionId: string;
  ownerMainSessionId: string;
  childSessionId: string;
  initialChildInputId: string | null;
  currentChildInputId: string | null;
  latestChildInputId: string | null;
  title: string | null;
  goal: string;
  context: string | null;
  sourceType: string | null;
  sourceId: string | null;
  proposalId: string | null;
  cronjobId: string | null;
  retryOfSubagentId: string | null;
  toolProfile: Record<string, unknown>;
  requestedModel: string | null;
  effectiveModel: string | null;
  status: string;
  summary: string | null;
  latestProgressPayload: Record<string, unknown> | null;
  blockingPayload: Record<string, unknown> | null;
  resultPayload: Record<string, unknown> | null;
  errorPayload: Record<string, unknown> | null;
  lastEventAt: string | null;
  ownerTransferredAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

export interface MainSessionEventQueueRecord {
  eventId: string;
  workspaceId: string;
  ownerMainSessionId: string;
  originMainSessionId: string;
  subagentId: string | null;
  eventType: string;
  deliveryBucket: string;
  status: string;
  payload: Record<string, unknown>;
  coalesceKey: string | null;
  earliestDeliverAt: string | null;
  latestDeliverAt: string | null;
  materializedInputId: string | null;
  supersededByEventId: string | null;
  deliveredAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LatestSessionInputOptions {
  workspaceId: string;
  sessionId: string;
  excludeContextSources?: string[];
  preferConfiguredModel?: boolean;
  limit?: number;
}

const SESSION_RUNTIME_STATE_STATUSES = [
  "IDLE",
  "BUSY",
  "WAITING_USER",
  "ERROR",
  "QUEUED",
  "PAUSED",
] as const;
const SESSION_RUNTIME_STATE_STATUS_SQL = SESSION_RUNTIME_STATE_STATUSES.map(
  (status) => `'${status}'`,
).join(", ");

export type RuntimeUserProfileNameSource = "manual" | "agent" | "auth_fallback";

export interface RuntimeUserProfileRecord {
  profileId: string;
  name: string | null;
  nameSource: RuntimeUserProfileNameSource | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryEntryScope = "workspace" | "session" | "user" | "ephemeral";
export type MemoryEntryType = "preference" | "identity" | "fact" | "procedure" | "blocker" | "reference";
export type MemoryVerificationPolicy = "none" | "check_before_use" | "must_reconfirm";
export type MemoryStalenessPolicy = "stable" | "time_sensitive" | "workspace_sensitive";
export type MemoryEntrySourceType = "session_message" | "assistant_turn" | "turn_result" | "permission_denial" | "manual";
export type MemoryEmbeddingScopeBucket = "workspace" | "preference" | "identity";

export interface MemoryEntryRecord {
  memoryId: string;
  workspaceId: string | null;
  sessionId: string | null;
  scope: MemoryEntryScope;
  memoryType: MemoryEntryType;
  subjectKey: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  verificationPolicy: MemoryVerificationPolicy;
  stalenessPolicy: MemoryStalenessPolicy;
  staleAfterSeconds: number | null;
  sourceTurnInputId: string | null;
  sourceMessageId: string | null;
  sourceType: MemoryEntrySourceType | null;
  observedAt: string | null;
  lastVerifiedAt: string | null;
  confidence: number | null;
  fingerprint: string;
  status: string;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbeddingIndexRecord {
  vecRowid: number;
  memoryId: string;
  path: string;
  workspaceId: string | null;
  scopeBucket: MemoryEmbeddingScopeBucket;
  memoryType: string;
  contentFingerprint: string;
  embeddingModel: string;
  embeddingDim: number;
  indexedAt: string;
  updatedAt: string;
}

export interface MemoryVectorSearchResult {
  vecRowid: number;
  distance: number;
  memoryId: string;
  path: string;
  workspaceId: string | null;
  scopeBucket: MemoryEmbeddingScopeBucket;
  memoryType: string;
}

export interface OutputFolderRecord {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: string | null;
  updatedAt: string | null;
}

function outputTypeForArtifactType(artifactType: string): string {
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

export interface OutputRecord {
  id: string;
  workspaceId: string;
  outputType: string;
  title: string;
  status: string;
  moduleId: string | null;
  moduleResourceId: string | null;
  filePath: string | null;
  htmlContent: string | null;
  sessionId: string | null;
  inputId: string | null;
  artifactId: string | null;
  folderId: string | null;
  platform: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AppBuildRecord {
  workspaceId: string;
  appId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** Cumulative auto-restart attempts since the last successful health
   *  probe. Persisted across runtime restarts so a perpetually-crashing
   *  app eventually trips the max-attempts circuit breaker instead of
   *  looping forever after every desktop relaunch. */
  restartAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppPortRecord {
  workspaceId: string;
  appId: string;
  port: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppCatalogEntryRecord {
  appId: string;
  source: "marketplace" | "local";
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  tags: string[];
  version: string | null;
  archiveUrl: string | null;
  archivePath: string | null;
  target: string;
  cachedAt: string;
  providerId: string | null;
  credentialSource: string | null;
}

export interface CronjobRecord {
  id: string;
  workspaceId: string;
  initiatedBy: string;
  name: string;
  cron: string;
  description: string;
  instruction: string;
  enabled: boolean;
  delivery: Record<string, unknown>;
  metadata: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeNotificationLevel = "info" | "success" | "warning" | "error";
export type RuntimeNotificationPriority = "low" | "normal" | "high" | "critical";
export type RuntimeNotificationState = "unread" | "read" | "dismissed";

export interface RuntimeNotificationRecord {
  id: string;
  workspaceId: string;
  cronjobId: string | null;
  sourceType: string;
  sourceLabel: string | null;
  title: string;
  message: string;
  level: RuntimeNotificationLevel;
  priority: RuntimeNotificationPriority;
  state: RuntimeNotificationState;
  metadata: Record<string, unknown>;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthAppConfigRecord {
  providerId: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskProposalRecord {
  proposalId: string;
  workspaceId: string;
  taskName: string;
  taskPrompt: string;
  taskGenerationRationale: string;
  proposalSource: TaskProposalSource;
  sourceEventIds: string[];
  createdAt: string;
  state: string;
  acceptedSessionId: string | null;
  acceptedInputId: string | null;
  acceptedAt: string | null;
}

export type TaskProposalSource = "proactive" | "evolve";

export type EvolveSkillCandidateKind = "skill_create" | "skill_patch";
export type EvolveSkillCandidateState = "draft" | "proposed" | "dismissed" | "accepted" | "promoted" | "discarded";

export interface EvolveSkillCandidateRecord {
  candidateId: string;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  taskProposalId: string | null;
  kind: EvolveSkillCandidateKind;
  status: EvolveSkillCandidateState;
  title: string;
  summary: string;
  slug: string;
  skillPath: string;
  contentFingerprint: string;
  confidence: number | null;
  evaluationNotes: string | null;
  sourceTurnInputIds: string[];
  createdAt: string;
  updatedAt: string;
  proposedAt: string | null;
  dismissedAt: string | null;
  acceptedAt: string | null;
  promotedAt: string | null;
}

export type MemoryUpdateProposalKind = "preference" | "identity" | "profile";
export type MemoryUpdateProposalState = "pending" | "accepted" | "dismissed";

export interface MemoryUpdateProposalRecord {
  proposalId: string;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  proposalKind: MemoryUpdateProposalKind;
  targetKey: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: string | null;
  confidence: number | null;
  sourceMessageId: string | null;
  state: MemoryUpdateProposalState;
  persistedMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  dismissedAt: string | null;
}

export interface CreateWorkspaceParams {
  workspaceId?: string;
  name: string;
  harness: string;
  status?: string;
  onboardingStatus?: string;
  onboardingSessionId?: string | null;
  errorMessage?: string | null;
  /**
   * Optional absolute path to use as the workspace's on-disk directory.
   * When omitted, the workspace is placed under the runtime's managed
   * workspaceRoot using the (sanitized) workspace id. When provided, the
   * path must be absolute and must point at a non-existent location or
   * an empty directory — the store refuses to clobber existing contents.
   */
  workspacePath?: string;
}

export interface RuntimeStateStoreOptions {
  hostStateDbPath?: string;
  dbPath?: string;
  controlPlaneDbPath?: string;
  workspaceRoot?: string;
  sandboxRoot?: string;
  sandboxAgentHarness?: string;
  /**
   * Optional structured log hook for schema migrations. Wire to pino/Sentry
   * in api-server; tests can pass a recorder. Receives events shaped like
   * `{event: "migrations.applied", id: 3, name: "...", durationMs: 12}`.
   */
  onMigrationEvent?: (event: MigrationLogEvent) => void;
}

type WorkspaceUpdateFields = Partial<{
  status: string | null;
  errorMessage: string | null;
  deletedAtUtc: string | null;
  onboardingStatus: string | null;
  onboardingSessionId: string | null;
  onboardingCompletedAt: string | null;
  onboardingCompletionSummary: string | null;
  onboardingRequestedAt: string | null;
  onboardingRequestedBy: string | null;
}>;

type AgentSessionUpdateFields = Partial<{
  kind: string | null;
  title: string | null;
  parentSessionId: string | null;
  sourceProposalId: string | null;
  createdBy: string | null;
  archivedAt: string | null;
}>;

type ConversationBindingUpdateFields = Partial<{
  sessionId: string;
  role: string | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  lastActiveAt: string | null;
}>;

type InputUpdateFields = Partial<{
  sessionId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  availableAt: string;
  attempt: number;
  idempotencyKey: string | null;
  claimedBy: string | null;
  claimedUntil: string | null;
}>;

type PostRunJobUpdateFields = Partial<{
  jobType: string;
  inputId: string;
  sessionId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  availableAt: string;
  attempt: number;
  idempotencyKey: string | null;
  claimedBy: string | null;
  claimedUntil: string | null;
  lastError: Record<string, unknown> | null;
}>;

type TaskProposalUpdateFields = Partial<{
  taskName: string;
  taskPrompt: string;
  taskGenerationRationale: string;
  state: string;
  acceptedSessionId: string | null;
  acceptedInputId: string | null;
  acceptedAt: string | null;
}>;

type MemoryUpdateProposalUpdateFields = Partial<{
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: string | null;
  confidence: number | null;
  state: MemoryUpdateProposalState;
  persistedMemoryId: string | null;
  acceptedAt: string | null;
  dismissedAt: string | null;
}>;

type EvolveSkillCandidateUpdateFields = Partial<{
  taskProposalId: string | null;
  status: EvolveSkillCandidateState;
  title: string;
  summary: string;
  slug: string;
  skillPath: string;
  contentFingerprint: string;
  confidence: number | null;
  evaluationNotes: string | null;
  proposedAt: string | null;
  dismissedAt: string | null;
  acceptedAt: string | null;
  promotedAt: string | null;
}>;

type SubagentRunUpdateFields = Partial<{
  parentSessionId: string | null;
  parentInputId: string | null;
  originMainSessionId: string;
  ownerMainSessionId: string;
  childSessionId: string;
  initialChildInputId: string | null;
  currentChildInputId: string | null;
  latestChildInputId: string | null;
  title: string | null;
  goal: string;
  context: string | null;
  sourceType: string | null;
  sourceId: string | null;
  proposalId: string | null;
  cronjobId: string | null;
  retryOfSubagentId: string | null;
  toolProfile: Record<string, unknown>;
  requestedModel: string | null;
  effectiveModel: string | null;
  status: string;
  summary: string | null;
  latestProgressPayload: Record<string, unknown> | null;
  blockingPayload: Record<string, unknown> | null;
  resultPayload: Record<string, unknown> | null;
  errorPayload: Record<string, unknown> | null;
  lastEventAt: string | null;
  ownerTransferredAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}>;

type MainSessionEventQueueUpdateFields = Partial<{
  ownerMainSessionId: string;
  originMainSessionId: string;
  subagentId: string | null;
  eventType: string;
  deliveryBucket: string;
  status: string;
  payload: Record<string, unknown>;
  coalesceKey: string | null;
  earliestDeliverAt: string | null;
  latestDeliverAt: string | null;
  materializedInputId: string | null;
  supersededByEventId: string | null;
  deliveredAt: string | null;
  supersededAt: string | null;
}>;

type WorkspaceRow = {
  id: string;
  workspace_path: string;
  name: string;
  status: string;
  harness: string | null;
  error_message: string | null;
  onboarding_status: string;
  onboarding_session_id: string | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at_utc: string | null;
};

const TASK_PROPOSAL_SOURCES = new Set<TaskProposalSource>(["proactive", "evolve"]);
const EVOLVE_SKILL_CANDIDATE_KINDS = new Set<EvolveSkillCandidateKind>(["skill_create", "skill_patch"]);
const EVOLVE_SKILL_CANDIDATE_STATES = new Set<EvolveSkillCandidateState>([
  "draft",
  "proposed",
  "dismissed",
  "accepted",
  "promoted",
  "discarded",
]);

function normalizeTaskProposalSource(value: string | null | undefined): TaskProposalSource {
  if (!value) {
    return "proactive";
  }
  return TASK_PROPOSAL_SOURCES.has(value as TaskProposalSource) ? (value as TaskProposalSource) : "proactive";
}

function normalizeEvolveSkillCandidateKind(value: string | null | undefined): EvolveSkillCandidateKind {
  if (!value) {
    return "skill_create";
  }
  return EVOLVE_SKILL_CANDIDATE_KINDS.has(value as EvolveSkillCandidateKind)
    ? (value as EvolveSkillCandidateKind)
    : "skill_create";
}

function normalizeEvolveSkillCandidateState(value: string | null | undefined): EvolveSkillCandidateState {
  if (!value) {
    return "draft";
  }
  return EVOLVE_SKILL_CANDIDATE_STATES.has(value as EvolveSkillCandidateState)
    ? (value as EvolveSkillCandidateState)
    : "draft";
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalise a provider-side identity string before storing it. Trims
 * whitespace, returns null on empty/missing — the dedupe finder treats
 * an empty string and `null` identically (no match), so collapsing the
 * two early avoids subtle bugs at the call sites.
 */
function normalizeIdentityValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function sanitizeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function hasExplicitHostStatePath(options: RuntimeStateStoreOptions = {}): boolean {
  return Boolean(
    (options.hostStateDbPath ?? "").trim()
      || (process.env[HOST_STATE_DB_PATH_ENV] ?? "").trim()
      || (options.dbPath ?? "").trim()
      || (process.env[LEGACY_RUNTIME_DB_PATH_ENV] ?? "").trim(),
  );
}

function defaultHostStateDbPath(options: RuntimeStateStoreOptions = {}): string {
  const sandboxRoot = options.sandboxRoot ?? path.join(os.tmpdir(), "sandbox");
  return path.join(sandboxRoot, "state", HOST_STATE_DB_FILENAME);
}

function legacyRuntimeDbPath(options: RuntimeStateStoreOptions = {}): string {
  const explicit = (options.dbPath ?? process.env[LEGACY_RUNTIME_DB_PATH_ENV] ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const sandboxRoot = options.sandboxRoot ?? path.join(os.tmpdir(), "sandbox");
  return path.join(sandboxRoot, "state", LEGACY_RUNTIME_DB_FILENAME);
}

export function hostStateDbPath(options: RuntimeStateStoreOptions = {}): string {
  const explicit = (
    options.hostStateDbPath
    ?? process.env[HOST_STATE_DB_PATH_ENV]
    ?? options.dbPath
    ?? process.env[LEGACY_RUNTIME_DB_PATH_ENV]
    ?? ""
  ).trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return defaultHostStateDbPath(options);
}

export function runtimeDbPath(options: RuntimeStateStoreOptions = {}): string {
  return hostStateDbPath(options);
}

export function controlPlaneDbPath(options: RuntimeStateStoreOptions = {}): string {
  const explicit = (options.controlPlaneDbPath ?? process.env[CONTROL_PLANE_DB_PATH_ENV] ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const resolvedHostStateDbPath = hostStateDbPath(options);
  if (hasExplicitHostStatePath(options)) {
    return path.join(path.dirname(resolvedHostStateDbPath), "control-plane.db");
  }
  return path.join(path.dirname(resolvedHostStateDbPath), "control-plane.db");
}

function workspaceRuntimeDir(workspacePath: string): string {
  return path.join(workspacePath, WORKSPACE_RUNTIME_DIRNAME);
}

function workspaceStateDir(workspacePath: string): string {
  return path.join(workspaceRuntimeDir(workspacePath), WORKSPACE_STATE_DIRNAME);
}

function workspaceRuntimeDbPathForWorkspacePath(workspacePath: string): string {
  return path.join(workspaceStateDir(workspacePath), WORKSPACE_RUNTIME_DB_FILENAME);
}

function currentWorkspaceIdentityPath(workspacePath: string): string {
  return path.join(workspaceStateDir(workspacePath), WORKSPACE_IDENTITY_FILENAME);
}

function legacyWorkspaceIdentityPath(workspacePath: string): string {
  return path.join(workspaceRuntimeDir(workspacePath), WORKSPACE_IDENTITY_FILENAME);
}

function ensureWorkspaceIdentityMigrated(workspacePath: string): string {
  const currentPath = currentWorkspaceIdentityPath(workspacePath);
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }
  const legacyPath = legacyWorkspaceIdentityPath(workspacePath);
  if (fs.existsSync(legacyPath)) {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.renameSync(legacyPath, currentPath);
    return currentPath;
  }
  return currentPath;
}

function deletedWorkspacePathTombstone(workspaceId: string, workspacePath: string): string {
  const encodedPath = Buffer.from(path.resolve(workspacePath), "utf8").toString("base64url");
  return `${DELETED_WORKSPACE_PATH_TOMBSTONE_PREFIX}/${sanitizeWorkspaceId(workspaceId)}/${Date.now()}:${encodedPath}`;
}

function decodeDeletedWorkspacePathTombstone(
  storedPath: string,
  workspaceId: string,
): string | null {
  const match = storedPath.match(
    /^__deleted__\/([^/]+)\/\d+(?::([A-Za-z0-9_-]+))?$/,
  );
  if (!match || match[1] !== sanitizeWorkspaceId(workspaceId) || !match[2]) {
    return null;
  }
  try {
    const decoded = Buffer.from(match[2], "base64url").toString("utf8").trim();
    return decoded ? path.resolve(decoded) : null;
  } catch {
    return null;
  }
}

export class RuntimeStateStore {
  readonly dbPath: string;
  readonly legacyDbPath: string;
  readonly usesImplicitHostStatePath: boolean;
  readonly controlPlaneDbPath: string;
  readonly workspaceRoot: string;
  readonly sandboxAgentHarness: string | null;
  readonly #onMigrationEvent: ((event: MigrationLogEvent) => void) | undefined;
  #db: Database.Database | null = null;
  #controlPlaneDb: Database.Database | null = null;
  #workspaceRuntimeDbs: Map<string, { dbPath: string; db: Database.Database }> = new Map();
  #vectorIndexSupported = false;
  #statementCache: Map<string, Database.Statement> = new Map();

  constructor(options: RuntimeStateStoreOptions = {}) {
    this.dbPath = hostStateDbPath(options);
    this.legacyDbPath = legacyRuntimeDbPath(options);
    this.usesImplicitHostStatePath = !hasExplicitHostStatePath(options);
    this.controlPlaneDbPath = controlPlaneDbPath(options);
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(os.tmpdir(), "workspace-root"));
    this.#onMigrationEvent = options.onMigrationEvent;
    this.sandboxAgentHarness = (options.sandboxAgentHarness ?? process.env.SANDBOX_AGENT_HARNESS ?? "").trim() || null;
  }

  close(): void {
    this.#statementCache.clear();
    this.#db?.close();
    this.#db = null;
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.#controlPlaneDb?.close();
    }
    this.#controlPlaneDb = null;
    for (const entry of this.#workspaceRuntimeDbs.values()) {
      entry.db.close();
    }
    this.#workspaceRuntimeDbs.clear();
    this.#vectorIndexSupported = false;
  }

  #cachedPrepare(sql: string): Database.Statement {
    let statement = this.#statementCache.get(sql);
    if (!statement) {
      statement = this.db().prepare(sql);
      this.#statementCache.set(sql, statement);
    }
    return statement;
  }

  supportsVectorIndex(): boolean {
    void this.db();
    return this.#vectorIndexSupported;
  }

  /**
   * Run a synchronous callback inside a SQLite transaction. better-sqlite3
   * commits when the callback returns and rolls back if it throws — used
   * by the integration service to make multi-row operations like
   * connection merges atomic.
   */
  transaction<T>(fn: () => T): T {
    return this.controlPlaneDb().transaction(fn)();
  }

  workspaceIdentityPath(workspaceId: string): string {
    return ensureWorkspaceIdentityMigrated(this.workspaceDir(workspaceId));
  }

  /**
   * Returns the *last-known* on-disk path for this workspace. For custom
   * user-chosen paths the registry is always authoritative — we do not
   * silently relocate behind the user's back. For managed paths inside
   * the runtime's workspaceRoot we still recover from renames (the legacy
   * behavior) because that root is ours to manage.
   *
   * Callers that need a usable directory must check workspaceFolderState()
   * or use assertWorkspaceFolderHealthy() — workspaceDir() will return the
   * last-known path even when the folder has been deleted, so "folder is
   * gone" stays observable instead of being masked by a fallback.
   */
  workspaceDir(workspaceId: string): string {
    this.ensureWorkspaceMetadataReady();

    const registered = this.workspacePathFromRegistry(workspaceId);
    if (registered) {
      // Auto-recover only for managed paths that got renamed under us.
      // Custom paths never auto-rewrite — user sees truth via folder_state.
      if (this.isWithinManagedRoot(registered)) {
        const exists =
          (() => {
            try {
              return fs.existsSync(registered) && fs.statSync(registered).isDirectory();
            } catch {
              return false;
            }
          })();
        if (!exists) {
          const discovered = this.discoverWorkspacePath(workspaceId);
          if (discovered) {
            this.updateWorkspacePath(workspaceId, discovered);
            return discovered;
          }
        }
      }
      return registered;
    }

    // No registered path at all (legacy / migrated row).
    const discovered = this.discoverWorkspacePath(workspaceId);
    if (discovered) {
      this.updateWorkspacePath(workspaceId, discovered);
      return discovered;
    }

    return this.defaultWorkspaceDir(workspaceId);
  }

  private isWithinManagedRoot(candidate: string): boolean {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedRoot = path.resolve(this.workspaceRoot);
    return (
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(resolvedRoot + path.sep)
    );
  }

  /**
   * Classifies the on-disk folder as "healthy" or "missing". Missing covers
   * all "can't use this folder right now" conditions (deleted, moved,
   * unmounted drive, permission revoked, replaced-by-file) — the
   * remediation in the UI is the same for all of them: relocate or remove
   * the record. Identity-file mismatch is NOT checked here; that is a
   * one-time activation check (see activateWorkspaceFolder).
   */
  workspaceFolderState(workspaceId: string): "healthy" | "missing" {
    const dir = this.workspaceDir(workspaceId);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return "healthy";
      }
    } catch {
      // Fall through — any stat error means we can't trust the folder.
    }
    return "missing";
  }

  /**
   * Throws a structured error if the workspace folder is not healthy. Use
   * this at the start of side-effecting operations (agent runs, app start,
   * template materialization, writes) to surface a clean error instead of
   * letting downstream fs calls fail with raw ENOENT.
   */
  assertWorkspaceFolderHealthy(workspaceId: string): string {
    const dir = this.workspaceDir(workspaceId);
    if (this.workspaceFolderState(workspaceId) === "healthy") {
      return dir;
    }
    const err = new Error(
      `workspace folder is missing at ${dir}. Relocate the workspace or delete the record.`,
    ) as Error & { code?: string; workspacePath?: string };
    err.code = "workspace_folder_missing";
    err.workspacePath = dir;
    throw err;
  }

  listWorkspaces(options: { includeDeleted?: boolean } = {}): WorkspaceRecord[] {
    this.ensureWorkspaceMetadataReady();
    const rows = this.controlPlaneDb()
      .prepare<[], WorkspaceRow>(`
        SELECT id, workspace_path, name, status, harness, error_message,
               onboarding_status, onboarding_session_id, onboarding_completed_at,
               onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
               created_at, updated_at, deleted_at_utc
        FROM workspaces
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `)
      .all();

    const items = rows.map((row) => this.rowToWorkspace(row));
    if (options.includeDeleted) {
      return items;
    }
    return items.filter((record) => !record.deletedAtUtc);
  }

  getWorkspace(workspaceId: string, options: { includeDeleted?: boolean } = {}): WorkspaceRecord | null {
    this.ensureWorkspaceMetadataReady();
    const row = this.controlPlaneDb()
      .prepare<[string], WorkspaceRow>(`
        SELECT id, workspace_path, name, status, harness, error_message,
               onboarding_status, onboarding_session_id, onboarding_completed_at,
               onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
               created_at, updated_at, deleted_at_utc
        FROM workspaces
        WHERE id = ?
        LIMIT 1
      `)
      .get(workspaceId);

    const record = row ? this.rowToWorkspace(row) : this.recoverMissingWorkspaceRecord(workspaceId);
    if (!record) {
      return null;
    }
    if (record.deletedAtUtc && !options.includeDeleted) {
      return null;
    }
    return record;
  }

  createWorkspace(params: CreateWorkspaceParams): WorkspaceRecord {
    this.ensureWorkspaceMetadataReady();

    const revived = this.tryReviveDeletedWorkspace(params);
    if (revived) {
      return revived;
    }

    const workspaceId = params.workspaceId ?? randomUUID();
    if (this.getWorkspace(workspaceId, { includeDeleted: true })) {
      throw new Error(`workspace ${workspaceId} already exists`);
    }

    const now = utcNowIso();
    const record: WorkspaceRecord = {
      id: workspaceId,
      name: params.name,
      status: params.status ?? "provisioning",
      harness: params.harness,
      errorMessage: params.errorMessage ?? null,
      onboardingStatus: params.onboardingStatus ?? "not_required",
      onboardingSessionId: params.onboardingSessionId ?? null,
      onboardingCompletedAt: null,
      onboardingCompletionSummary: null,
      onboardingRequestedAt: null,
      onboardingRequestedBy: null,
      createdAt: now,
      updatedAt: now,
      deletedAtUtc: null
    };

    const workspacePath = this.resolveCreateWorkspacePath(params.workspacePath, workspaceId);
    fs.mkdirSync(workspacePath, { recursive: true });
    this.writeWorkspaceIdentityFile(workspacePath, workspaceId);
    this.upsertWorkspaceRow(record, workspacePath);
    return record;
  }

  private tryReviveDeletedWorkspace(params: CreateWorkspaceParams): WorkspaceRecord | null {
    const requestedPath = params.workspacePath?.trim();
    if (!requestedPath || !path.isAbsolute(requestedPath) || !fs.existsSync(requestedPath)) {
      return null;
    }
    const stat = fs.statSync(requestedPath);
    if (!stat.isDirectory()) {
      return null;
    }
    const resolvedPath = path.resolve(requestedPath);
    const identityPath = ensureWorkspaceIdentityMigrated(resolvedPath);
    if (!fs.existsSync(identityPath)) {
      return null;
    }
    let identityWorkspaceId: string;
    try {
      identityWorkspaceId = fs.readFileSync(identityPath, "utf-8").trim();
    } catch {
      return null;
    }
    if (!identityWorkspaceId) {
      return null;
    }
    if (params.workspaceId && params.workspaceId !== identityWorkspaceId) {
      throw new Error(
        `workspacePath belongs to workspace ${identityWorkspaceId}, not requested workspace ${params.workspaceId}`,
      );
    }
    const existing = this.getWorkspace(identityWorkspaceId, { includeDeleted: true });
    if (!existing?.deletedAtUtc) {
      return null;
    }

    const workspacePath = this.validateUserChosenWorkspacePath(resolvedPath, {
      workspaceId: identityWorkspaceId,
      allowMatchingIdentity: true,
    });
    const now = utcNowIso();
    const revived: WorkspaceRecord = {
      ...existing,
      name: existing.name,
      status: params.status ?? "provisioning",
      harness: existing.harness ?? params.harness,
      errorMessage: params.errorMessage ?? null,
      updatedAt: now,
      deletedAtUtc: null,
    };
    this.writeWorkspaceIdentityFile(workspacePath, identityWorkspaceId);
    this.upsertWorkspaceRow(revived, workspacePath);
    return revived;
  }

  private resolveCreateWorkspacePath(requested: string | undefined, workspaceId: string): string {
    const trimmed = requested?.trim();
    if (!trimmed) {
      return this.defaultWorkspaceDir(workspaceId);
    }
    return this.validateUserChosenWorkspacePath(trimmed, { workspaceId, allowMatchingIdentity: false });
  }

  /**
   * Shared validator for a user-provided workspace path (create or relocate).
   * Rules: absolute, no overlap with any OTHER registered workspace, and
   * the target is either (a) non-existent, (b) empty, or (c) already holds
   * an identity file matching `workspaceId` when `allowMatchingIdentity`
   * is true (relocation of a moved folder).
   */
  private validateUserChosenWorkspacePath(
    requested: string,
    options: { workspaceId: string; allowMatchingIdentity: boolean }
  ): string {
    if (!path.isAbsolute(requested)) {
      throw new Error(`workspacePath must be absolute: ${requested}`);
    }
    const resolved = path.resolve(requested);

    // Reject the runtime's managed workspaceRoot itself (or any ancestor of
    // it). If a user registered workspaceRoot as their custom path, future
    // default-managed workspaces would be created nested inside it (at
    // workspaceRoot/<id>), and deleting the custom workspace would wipe the
    // whole managed tree along with it.
    const managedRoot = path.resolve(this.workspaceRoot);
    const sep = path.sep;
    if (resolved === managedRoot) {
      throw new Error(`workspacePath cannot be the runtime's managed workspace root: ${resolved}`);
    }
    if (managedRoot.startsWith(resolved + sep)) {
      throw new Error(`workspacePath cannot contain the runtime's managed workspace root: ${resolved}`);
    }

    // Reject placing the workspace inside another registered workspace's
    // root — that would nest two workspaces and confuse discovery.
    // Soft-deleted rows are excluded: once a workspace is removed, its
    // former path is fair game for reuse (the metadata was already
    // stripped during DELETE).
    const rows = this.controlPlaneDb()
      .prepare<[], { id: string; workspace_path: string }>(
        "SELECT id, workspace_path FROM workspaces WHERE deleted_at_utc IS NULL"
      )
      .all();
    for (const row of rows) {
      if (row.id === options.workspaceId) {
        continue;
      }
      const other = path.resolve(row.workspace_path);
      if (resolved === other) {
        throw new Error(`workspacePath already registered to another workspace: ${resolved}`);
      }
      if (resolved.startsWith(other + sep) || other.startsWith(resolved + sep)) {
        throw new Error(`workspacePath overlaps another workspace: ${resolved} vs ${other}`);
      }
    }
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new Error(`workspacePath is not a directory: ${resolved}`);
      }
      // Allow a folder that already contains this workspace's identity file
      // (relocate case — user moved the folder elsewhere on disk).
      if (options.allowMatchingIdentity) {
        const identityPath = ensureWorkspaceIdentityMigrated(resolved);
        if (fs.existsSync(identityPath)) {
          try {
            const raw = fs.readFileSync(identityPath, "utf-8").trim();
            if (raw === options.workspaceId) {
              return resolved;
            }
          } catch {
            // fall through — unreadable identity means we can't trust it
          }
        }
      }
      const entries = fs.readdirSync(resolved).filter((name) => name !== ".DS_Store");
      if (entries.length > 0) {
        throw new Error(`workspacePath must be empty, but contains ${entries.length} entries: ${resolved}`);
      }
    }
    return resolved;
  }

  /**
   * Re-point an existing workspace at a different absolute path.
   *
   * The new path must be empty/non-existent OR already contain an identity
   * file matching this workspaceId (= user moved their folder elsewhere on
   * disk and wants us to re-bind). Updates the registry row and ensures the
   * identity file is present at the new location. Does NOT copy files from
   * the old location — relocation is "re-register at a spot the user
   * already has set up".
   */
  relocateWorkspace(workspaceId: string, newPath: string): WorkspaceRecord {
    const existing = this.getWorkspace(workspaceId, { includeDeleted: false });
    if (!existing) {
      throw new Error(`workspace ${workspaceId} not found`);
    }
    const trimmed = newPath.trim();
    if (!trimmed) {
      throw new Error("workspacePath is required");
    }
    const resolved = this.validateUserChosenWorkspacePath(trimmed, {
      workspaceId,
      allowMatchingIdentity: true
    });
    fs.mkdirSync(resolved, { recursive: true });
    this.writeWorkspaceIdentityFile(resolved, workspaceId);
    this.updateWorkspacePath(workspaceId, resolved);
    const refreshed = this.getWorkspace(workspaceId, { includeDeleted: false });
    if (!refreshed) {
      throw new Error(`workspace ${workspaceId} not found after relocate`);
    }
    return refreshed;
  }

  updateWorkspace(workspaceId: string, fields: WorkspaceUpdateFields): WorkspaceRecord {
    const existing = this.getWorkspace(workspaceId, { includeDeleted: true });
    if (!existing) {
      throw new Error(`workspace ${workspaceId} not found`);
    }
    const entries = Object.entries(fields);
    if (entries.length === 0) {
      return existing;
    }

    const nonNullable = new Set<keyof WorkspaceUpdateFields>(["status", "onboardingStatus"]);
    const next: WorkspaceRecord = { ...existing };
    for (const [key, value] of entries) {
      const typedKey = key as keyof WorkspaceUpdateFields;
      if (value === null && nonNullable.has(typedKey)) {
        continue;
      }
      switch (typedKey) {
        case "status":
          next.status = value as string;
          break;
        case "errorMessage":
          next.errorMessage = value as string | null;
          break;
        case "deletedAtUtc":
          next.deletedAtUtc = value as string | null;
          break;
        case "onboardingStatus":
          next.onboardingStatus = value as string;
          break;
        case "onboardingSessionId":
          next.onboardingSessionId = value as string | null;
          break;
        case "onboardingCompletedAt":
          next.onboardingCompletedAt = value as string | null;
          break;
        case "onboardingCompletionSummary":
          next.onboardingCompletionSummary = value as string | null;
          break;
        case "onboardingRequestedAt":
          next.onboardingRequestedAt = value as string | null;
          break;
        case "onboardingRequestedBy":
          next.onboardingRequestedBy = value as string | null;
          break;
        default:
          throw new Error(`unsupported workspace update field: ${typedKey}`);
      }
    }
    next.updatedAt = utcNowIso();
    this.upsertWorkspaceRow(next, this.workspaceDir(workspaceId));
    this.writeWorkspaceIdentityFile(this.workspaceDir(workspaceId), workspaceId);
    return next;
  }

  deleteWorkspace(workspaceId: string): WorkspaceRecord {
    const preservedWorkspacePath = this.workspaceDir(workspaceId);
    const result = this.updateWorkspace(workspaceId, {
      status: "deleted",
      deletedAtUtc: utcNowIso(),
      errorMessage: null
    });
    // Release the path claim. The workspaces.workspace_path column has a
    // UNIQUE constraint, so keeping the original path on a soft-deleted row
    // would block the user from ever reusing that folder for a new
    // workspace ("remove from Holaboss but keep my files" must be
    // reversible). Stamp a tombstone that is unique per workspace id and
    // identifiable in diagnostics.
    const tombstone = deletedWorkspacePathTombstone(
      workspaceId,
      preservedWorkspacePath,
    );
    this.controlPlaneDb().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(tombstone, workspaceId);
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.db().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(tombstone, workspaceId);
    }
    return result;
  }

  ensureSession(
    params: {
      workspaceId: string;
      sessionId: string;
      kind?: string | null;
      title?: string | null;
      parentSessionId?: string | null;
      sourceProposalId?: string | null;
      createdBy?: string | null;
      archivedAt?: string | null;
    },
    options: { touchExisting?: boolean } = {}
  ): AgentSessionRecord {
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const existing = this.getSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
    const now = utcNowIso();

    if (!existing) {
      workspaceDb
        .prepare(`
          INSERT INTO agent_sessions (
              workspace_id,
              session_id,
              kind,
              title,
              parent_session_id,
              source_proposal_id,
              created_by,
              created_at,
              updated_at,
              archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          params.workspaceId,
          params.sessionId,
          this.normalizedSessionKind(params.kind),
          this.normalizedNullableText(params.title),
          this.normalizedNullableText(params.parentSessionId),
          this.normalizedNullableText(params.sourceProposalId),
          this.normalizedNullableText(params.createdBy),
          now,
          now,
          this.normalizedNullableText(params.archivedAt)
        );
      return this.requireSession({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId
      });
    }

    const updates: AgentSessionUpdateFields = {};
    if (params.kind !== undefined) {
      updates.kind = this.normalizedSessionKind(params.kind);
    }
    if (params.title !== undefined) {
      updates.title = this.normalizedNullableText(params.title);
    }
    if (params.parentSessionId !== undefined) {
      updates.parentSessionId = this.normalizedNullableText(params.parentSessionId);
    }
    if (params.sourceProposalId !== undefined) {
      updates.sourceProposalId = this.normalizedNullableText(params.sourceProposalId);
    }
    if (params.createdBy !== undefined) {
      updates.createdBy = this.normalizedNullableText(params.createdBy);
    }
    if (params.archivedAt !== undefined) {
      updates.archivedAt = this.normalizedNullableText(params.archivedAt);
    }

    if (Object.keys(updates).length > 0) {
      return this.requireUpdatedSession({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        fields: updates
      });
    }

    if (options.touchExisting === false) {
      return existing;
    }

    workspaceDb
      .prepare("UPDATE agent_sessions SET updated_at = ? WHERE workspace_id = ? AND session_id = ?")
      .run(now, params.workspaceId, params.sessionId);
    return this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
  }

  getSession(params: { workspaceId: string; sessionId: string }): AgentSessionRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(`
        SELECT *
        FROM agent_sessions
        WHERE workspace_id = ? AND session_id = ?
        LIMIT 1
      `)
      .get(params.workspaceId, params.sessionId);
    return row ? this.rowToAgentSession(row) : null;
  }

  listSessions(params: {
    workspaceId: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): AgentSessionRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, number, number, number], Record<string, unknown>>(`
        SELECT *
        FROM agent_sessions
        WHERE workspace_id = ?
          AND (? = 1 OR archived_at IS NULL)
        ORDER BY updated_at DESC, created_at DESC, session_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(
        params.workspaceId,
        params.includeArchived ? 1 : 0,
        params.limit ?? 100,
        params.offset ?? 0
      );
    return rows.map((row) => this.rowToAgentSession(row));
  }

  updateTaskProposal(params: { workspaceId: string; proposalId: string; fields: TaskProposalUpdateFields }): TaskProposalRecord | null {
    const existing = this.getTaskProposal({
      workspaceId: params.workspaceId,
      proposalId: params.proposalId,
    });
    if (!existing) {
      return null;
    }
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return existing;
    }

    const columnMap: Record<keyof TaskProposalUpdateFields, string> = {
      taskName: "task_name",
      taskPrompt: "task_prompt",
      taskGenerationRationale: "task_generation_rationale",
      state: "state",
      acceptedSessionId: "accepted_session_id",
      acceptedInputId: "accepted_input_id",
      acceptedAt: "accepted_at"
    };

    const assignments: string[] = [];
    const values: Array<string | null> = [];
    for (const [key, value] of entries) {
      const column = columnMap[key as keyof TaskProposalUpdateFields];
      if (!column) {
        throw new Error(`unsupported task proposal update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      values.push(value == null ? null : String(value));
    }
    values.push(params.proposalId);

    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`UPDATE task_proposals SET ${assignments.join(", ")} WHERE proposal_id = ?`).run(...values);
    });
    return this.getTaskProposal({
      workspaceId: params.workspaceId,
      proposalId: params.proposalId,
    });
  }

  updateMemoryUpdateProposal(params: {
    workspaceId: string;
    proposalId: string;
    fields: MemoryUpdateProposalUpdateFields;
  }): MemoryUpdateProposalRecord | null {
    const existing = this.getMemoryUpdateProposal({
      workspaceId: params.workspaceId,
      proposalId: params.proposalId,
    });
    if (!existing) {
      return null;
    }
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return existing;
    }

    const columnMap: Record<keyof MemoryUpdateProposalUpdateFields, string> = {
      title: "title",
      summary: "summary",
      payload: "payload",
      evidence: "evidence",
      confidence: "confidence",
      state: "state",
      persistedMemoryId: "persisted_memory_id",
      acceptedAt: "accepted_at",
      dismissedAt: "dismissed_at",
    };

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of entries) {
      const column = columnMap[key as keyof MemoryUpdateProposalUpdateFields];
      if (!column) {
        throw new Error(`unsupported memory update proposal field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      if (key === "payload") {
        values.push(JSON.stringify(value ?? {}));
      } else {
        values.push(value ?? null);
      }
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso(), params.proposalId);

    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`UPDATE memory_update_proposals SET ${assignments.join(", ")} WHERE proposal_id = ?`).run(...values);
    });
    return this.getMemoryUpdateProposal({
      workspaceId: params.workspaceId,
      proposalId: params.proposalId,
    });
  }

  updateEvolveSkillCandidate(params: {
    workspaceId: string;
    candidateId: string;
    fields: EvolveSkillCandidateUpdateFields;
  }): EvolveSkillCandidateRecord | null {
    const existing = this.getEvolveSkillCandidate({
      workspaceId: params.workspaceId,
      candidateId: params.candidateId,
    });
    if (!existing) {
      return null;
    }
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return existing;
    }

    const columnMap: Record<keyof EvolveSkillCandidateUpdateFields, string> = {
      taskProposalId: "task_proposal_id",
      status: "status",
      title: "title",
      summary: "summary",
      slug: "slug",
      skillPath: "skill_path",
      contentFingerprint: "content_fingerprint",
      confidence: "confidence",
      evaluationNotes: "evaluation_notes",
      proposedAt: "proposed_at",
      dismissedAt: "dismissed_at",
      acceptedAt: "accepted_at",
      promotedAt: "promoted_at",
    };

    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of entries) {
      const column = columnMap[key as keyof EvolveSkillCandidateUpdateFields];
      if (!column) {
        throw new Error(`unsupported evolve skill candidate field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      if (key === "confidence") {
        values.push(typeof value === "number" && Number.isFinite(value) ? value : null);
      } else {
        values.push(value == null ? null : String(value));
      }
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso(), params.candidateId);

    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`UPDATE evolve_skill_candidates SET ${assignments.join(", ")} WHERE candidate_id = ?`).run(...values);
    });
    return this.getEvolveSkillCandidate({
      workspaceId: params.workspaceId,
      candidateId: params.candidateId,
    });
  }

  upsertBinding(params: {
    workspaceId: string;
    sessionId: string;
    harness: string;
    harnessSessionId: string;
  }): SessionBindingRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId
      },
      { touchExisting: false }
    );
    const now = utcNowIso();
    const existingSessionBinding = this.getBinding({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const existingHarnessBinding = this.getBindingByHarnessSessionId({
      workspaceId: params.workspaceId,
      harness: params.harness,
      harnessSessionId: params.harnessSessionId,
    });
    const createdAt =
      existingHarnessBinding?.createdAt ??
      existingSessionBinding?.createdAt ??
      now;
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const transaction = workspaceDb.transaction(() => {
      workspaceDb
        .prepare(
          `
            DELETE FROM agent_runtime_sessions
            WHERE workspace_id = ? AND session_id = ?
          `,
        )
        .run(params.workspaceId, params.sessionId);
      workspaceDb
        .prepare(
          `
            DELETE FROM agent_runtime_sessions
            WHERE workspace_id = ? AND harness = ? AND harness_session_id = ?
          `,
        )
        .run(params.workspaceId, params.harness, params.harnessSessionId);
      workspaceDb
        .prepare(`
          INSERT INTO agent_runtime_sessions (
              workspace_id, session_id, harness, harness_session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          params.workspaceId,
          params.sessionId,
          params.harness,
          params.harnessSessionId,
          createdAt,
          now
        );
    });
    transaction();

    const record = this.getBinding({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
    if (!record) {
      throw new Error("failed to load session binding");
    }
    return record;
  }

  getBinding(params: { workspaceId: string; sessionId: string }): SessionBindingRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], {
        workspace_id: string;
        session_id: string;
        harness: string;
        harness_session_id: string;
        created_at: string;
        updated_at: string;
      }>(`
        SELECT workspace_id, session_id, harness, harness_session_id, created_at, updated_at
        FROM agent_runtime_sessions
        WHERE workspace_id = ? AND session_id = ?
        LIMIT 1
      `)
      .get(params.workspaceId, params.sessionId);
    if (!row) {
      return null;
    }
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      harness: row.harness,
      harnessSessionId: row.harness_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  getBindingByHarnessSessionId(params: {
    workspaceId: string;
    harness: string;
    harnessSessionId: string;
  }): SessionBindingRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<
        [string, string, string],
        {
          workspace_id: string;
          session_id: string;
          harness: string;
          harness_session_id: string;
          created_at: string;
          updated_at: string;
        }
      >(`
        SELECT workspace_id, session_id, harness, harness_session_id, created_at, updated_at
        FROM agent_runtime_sessions
        WHERE workspace_id = ? AND harness = ? AND harness_session_id = ?
        LIMIT 1
      `)
      .get(params.workspaceId, params.harness, params.harnessSessionId);
    if (!row) {
      return null;
    }
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      harness: row.harness,
      harnessSessionId: row.harness_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertConversationBinding(params: {
    bindingId?: string;
    workspaceId: string;
    channel: string;
    conversationKey: string;
    sessionId: string;
    role?: string | null;
    isActive?: boolean;
    metadata?: Record<string, unknown> | null;
    lastActiveAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): ConversationBindingRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = params.createdAt ?? now;
    const role = this.normalizedConversationBindingRole(params.role);
    const channel = this.requiredNormalizedText(params.channel, "channel");
    const conversationKey = this.requiredNormalizedText(params.conversationKey, "conversationKey");
    const bindingId = params.bindingId ?? randomUUID();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);

    workspaceDb
      .prepare(`
        INSERT INTO conversation_bindings (
            binding_id,
            workspace_id,
            channel,
            conversation_key,
            session_id,
            role,
            is_active,
            metadata,
            last_active_at,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel, conversation_key, role) DO UPDATE SET
            session_id = excluded.session_id,
            is_active = excluded.is_active,
            metadata = excluded.metadata,
            last_active_at = excluded.last_active_at,
            updated_at = excluded.updated_at
      `)
      .run(
        bindingId,
        params.workspaceId,
        channel,
        conversationKey,
        params.sessionId,
        role,
        params.isActive === false ? 0 : 1,
        JSON.stringify(params.metadata ?? {}),
        this.normalizedNullableText(params.lastActiveAt),
        createdAt,
        now
      );

    const record = this.getConversationBindingByConversation({
      workspaceId: params.workspaceId,
      channel,
      conversationKey,
      role,
    });
    if (!record) {
      throw new Error("conversation binding row not found after upsert");
    }
    return record;
  }

  getConversationBinding(params: { workspaceId: string; bindingId: string }): ConversationBindingRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM conversation_bindings WHERE binding_id = ? LIMIT 1")
      .get(params.bindingId);
    return row ? this.rowToConversationBinding(row) : null;
  }

  getConversationBindingByConversation(params: {
    workspaceId: string;
    channel: string;
    conversationKey: string;
    role?: string | null;
  }): ConversationBindingRecord | null {
    const role = params.role === undefined ? undefined : this.normalizedConversationBindingRole(params.role);
    let query = `
      SELECT *
      FROM conversation_bindings
      WHERE workspace_id = ?
        AND channel = ?
        AND conversation_key = ?
    `;
    const values: string[] = [
      params.workspaceId,
      this.requiredNormalizedText(params.channel, "channel"),
      this.requiredNormalizedText(params.conversationKey, "conversationKey"),
    ];
    if (role !== undefined) {
      query += " AND role = ?";
      values.push(role);
    }
    query += " ORDER BY is_active DESC, datetime(updated_at) DESC, created_at DESC LIMIT 1";
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as Record<string, unknown> | undefined;
    return row ? this.rowToConversationBinding(row) : null;
  }

  getConversationBindingBySession(params: {
    workspaceId: string;
    sessionId: string;
    role?: string | null;
  }): ConversationBindingRecord | null {
    const role = params.role === undefined ? undefined : this.normalizedConversationBindingRole(params.role);
    let query = `
      SELECT *
      FROM conversation_bindings
      WHERE workspace_id = ?
        AND session_id = ?
    `;
    const values: string[] = [params.workspaceId, params.sessionId];
    if (role !== undefined) {
      query += " AND role = ?";
      values.push(role);
    }
    query += " ORDER BY is_active DESC, datetime(updated_at) DESC, created_at DESC LIMIT 1";
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as Record<string, unknown> | undefined;
    return row ? this.rowToConversationBinding(row) : null;
  }

  listConversationBindings(params: {
    workspaceId: string;
    role?: string | null;
    channel?: string | null;
    isActive?: boolean | null;
    limit?: number;
    offset?: number;
  }): ConversationBindingRecord[] {
    let query = `
      SELECT *
      FROM conversation_bindings
      WHERE workspace_id = ?
    `;
    const values: Array<string | number> = [params.workspaceId];
    if (params.role !== undefined && params.role !== null) {
      query += " AND role = ?";
      values.push(this.normalizedConversationBindingRole(params.role));
    }
    if (params.channel !== undefined && params.channel !== null) {
      query += " AND channel = ?";
      values.push(this.requiredNormalizedText(params.channel, "channel"));
    }
    if (typeof params.isActive === "boolean") {
      query += " AND is_active = ?";
      values.push(params.isActive ? 1 : 0);
    }
    query += `
      ORDER BY is_active DESC, datetime(updated_at) DESC, datetime(created_at) DESC, binding_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToConversationBinding(row));
  }

  setConversationBindingActive(params: {
    workspaceId: string;
    bindingId: string;
    isActive: boolean;
  }): ConversationBindingRecord | null {
    return this.updateConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
      fields: { isActive: params.isActive },
    });
  }

  touchConversationBinding(params: {
    workspaceId: string;
    bindingId: string;
    lastActiveAt?: string | null;
  }): ConversationBindingRecord | null {
    return this.updateConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
      fields: { lastActiveAt: params.lastActiveAt ?? utcNowIso() },
    });
  }

  transferConversationBindingSession(params: {
    workspaceId: string;
    bindingId: string;
    sessionId: string;
  }): ConversationBindingRecord | null {
    const binding = this.getConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
    });
    if (!binding) {
      return null;
    }
    this.ensureSession(
      {
        workspaceId: binding.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );
    return this.updateConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
      fields: { sessionId: params.sessionId },
    });
  }

  createSubagentRun(params: {
    subagentId?: string;
    workspaceId: string;
    parentSessionId?: string | null;
    parentInputId?: string | null;
    originMainSessionId: string;
    ownerMainSessionId?: string | null;
    childSessionId: string;
    initialChildInputId?: string | null;
    currentChildInputId?: string | null;
    latestChildInputId?: string | null;
    title?: string | null;
    goal: string;
    context?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    proposalId?: string | null;
    cronjobId?: string | null;
    retryOfSubagentId?: string | null;
    toolProfile?: Record<string, unknown> | null;
    requestedModel?: string | null;
    effectiveModel?: string | null;
    status?: string;
    summary?: string | null;
    latestProgressPayload?: Record<string, unknown> | null;
    blockingPayload?: Record<string, unknown> | null;
    resultPayload?: Record<string, unknown> | null;
    errorPayload?: Record<string, unknown> | null;
    lastEventAt?: string | null;
    ownerTransferredAt?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    cancelledAt?: string | null;
    updatedAt?: string;
  }): SubagentRunRecord {
    const ownerMainSessionId = this.normalizedNullableText(params.ownerMainSessionId) ?? params.originMainSessionId;
    if (params.parentSessionId) {
      this.ensureSession(
        {
          workspaceId: params.workspaceId,
          sessionId: params.parentSessionId,
        },
        { touchExisting: false }
      );
    }
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.originMainSessionId,
      },
      { touchExisting: false }
    );
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: ownerMainSessionId,
      },
      { touchExisting: false }
    );
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.childSessionId,
        kind: "subagent",
        parentSessionId: params.parentSessionId,
        title: params.title,
      },
      { touchExisting: false }
    );

    const subagentId = params.subagentId ?? randomUUID();
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = params.createdAt ?? now;
    const initialChildInputId = this.normalizedNullableText(params.initialChildInputId);
    const currentChildInputId =
      this.normalizedNullableText(params.currentChildInputId) ?? initialChildInputId;
    const latestChildInputId =
      this.normalizedNullableText(params.latestChildInputId) ?? currentChildInputId ?? initialChildInputId;

    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    workspaceDb
      .prepare(`
        INSERT INTO subagent_runs (
            subagent_id,
            workspace_id,
            parent_session_id,
            parent_input_id,
            origin_main_session_id,
            owner_main_session_id,
            child_session_id,
            initial_child_input_id,
            current_child_input_id,
            latest_child_input_id,
            title,
            goal,
            context,
            source_type,
            source_id,
            proposal_id,
            cronjob_id,
            retry_of_subagent_id,
            tool_profile,
            requested_model,
            effective_model,
            status,
            summary,
            latest_progress_payload,
            blocking_payload,
            result_payload,
            error_payload,
            last_event_at,
            owner_transferred_at,
            created_at,
            started_at,
            completed_at,
            cancelled_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        subagentId,
        params.workspaceId,
        this.normalizedNullableText(params.parentSessionId),
        this.normalizedNullableText(params.parentInputId),
        params.originMainSessionId,
        ownerMainSessionId,
        params.childSessionId,
        initialChildInputId,
        currentChildInputId,
        latestChildInputId,
        this.normalizedNullableText(params.title),
        this.requiredNormalizedText(params.goal, "goal"),
        this.normalizedNullableText(params.context),
        this.normalizedNullableText(params.sourceType),
        this.normalizedNullableText(params.sourceId),
        this.normalizedNullableText(params.proposalId),
        this.normalizedNullableText(params.cronjobId),
        this.normalizedNullableText(params.retryOfSubagentId),
        JSON.stringify(params.toolProfile ?? {}),
        this.normalizedNullableText(params.requestedModel),
        this.normalizedNullableText(params.effectiveModel),
        this.requiredNormalizedText(params.status ?? "queued", "status"),
        this.normalizedNullableText(params.summary),
        params.latestProgressPayload == null ? null : JSON.stringify(params.latestProgressPayload),
        params.blockingPayload == null ? null : JSON.stringify(params.blockingPayload),
        params.resultPayload == null ? null : JSON.stringify(params.resultPayload),
        params.errorPayload == null ? null : JSON.stringify(params.errorPayload),
        this.normalizedNullableText(params.lastEventAt),
        this.normalizedNullableText(params.ownerTransferredAt),
        createdAt,
        this.normalizedNullableText(params.startedAt),
        this.normalizedNullableText(params.completedAt),
        this.normalizedNullableText(params.cancelledAt),
        now
      );

    const record = this.getSubagentRun({ workspaceId: params.workspaceId, subagentId });
    if (!record) {
      throw new Error("subagent run row not found after insert");
    }
    return record;
  }

  updateSubagentRun(params: {
    workspaceId: string;
    subagentId: string;
    fields: SubagentRunUpdateFields;
  }): SubagentRunRecord | null {
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return this.getSubagentRun({ workspaceId: params.workspaceId, subagentId: params.subagentId });
    }
    const existing = this.getSubagentRun({ workspaceId: params.workspaceId, subagentId: params.subagentId });
    if (!existing) {
      return null;
    }
    if (params.fields.parentSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.parentSessionId,
        },
        { touchExisting: false }
      );
    }
    if (params.fields.originMainSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.originMainSessionId,
        },
        { touchExisting: false }
      );
    }
    if (params.fields.ownerMainSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.ownerMainSessionId,
        },
        { touchExisting: false }
      );
    }
    if (params.fields.childSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.childSessionId,
          kind: "subagent",
        },
        { touchExisting: false }
      );
    }

    const columnMap: Record<keyof SubagentRunUpdateFields, string> = {
      parentSessionId: "parent_session_id",
      parentInputId: "parent_input_id",
      originMainSessionId: "origin_main_session_id",
      ownerMainSessionId: "owner_main_session_id",
      childSessionId: "child_session_id",
      initialChildInputId: "initial_child_input_id",
      currentChildInputId: "current_child_input_id",
      latestChildInputId: "latest_child_input_id",
      title: "title",
      goal: "goal",
      context: "context",
      sourceType: "source_type",
      sourceId: "source_id",
      proposalId: "proposal_id",
      cronjobId: "cronjob_id",
      retryOfSubagentId: "retry_of_subagent_id",
      toolProfile: "tool_profile",
      requestedModel: "requested_model",
      effectiveModel: "effective_model",
      status: "status",
      summary: "summary",
      latestProgressPayload: "latest_progress_payload",
      blockingPayload: "blocking_payload",
      resultPayload: "result_payload",
      errorPayload: "error_payload",
      lastEventAt: "last_event_at",
      ownerTransferredAt: "owner_transferred_at",
      startedAt: "started_at",
      completedAt: "completed_at",
      cancelledAt: "cancelled_at",
    };

    const jsonKeys = new Set<keyof SubagentRunUpdateFields>([
      "toolProfile",
      "latestProgressPayload",
      "blockingPayload",
      "resultPayload",
      "errorPayload",
    ]);
    const textKeys = new Set<keyof SubagentRunUpdateFields>([
      "parentSessionId",
      "parentInputId",
      "originMainSessionId",
      "ownerMainSessionId",
      "childSessionId",
      "initialChildInputId",
      "currentChildInputId",
      "latestChildInputId",
      "title",
      "goal",
      "context",
      "sourceType",
      "sourceId",
      "proposalId",
      "cronjobId",
      "retryOfSubagentId",
      "requestedModel",
      "effectiveModel",
      "status",
      "summary",
      "lastEventAt",
      "ownerTransferredAt",
      "startedAt",
      "completedAt",
      "cancelledAt",
    ]);

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of entries) {
      const typedKey = key as keyof SubagentRunUpdateFields;
      const column = columnMap[typedKey];
      if (!column) {
        throw new Error(`unsupported subagent run update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      if (jsonKeys.has(typedKey)) {
        values.push(value == null ? null : JSON.stringify(value));
      } else if (textKeys.has(typedKey)) {
        values.push(this.normalizedNullableText(typeof value === "string" ? value : (value as string | null | undefined)));
      } else {
        values.push(value ?? null);
      }
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso(), params.subagentId);

    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`UPDATE subagent_runs SET ${assignments.join(", ")} WHERE subagent_id = ?`)
      .run(...values);
    if (result.changes <= 0) {
      return null;
    }
    return this.getSubagentRun({ workspaceId: params.workspaceId, subagentId: params.subagentId });
  }

  getSubagentRun(params: { workspaceId: string; subagentId: string }): SubagentRunRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM subagent_runs WHERE subagent_id = ? LIMIT 1")
      .get(params.subagentId);
    return row ? this.rowToSubagentRun(row) : null;
  }

  getSubagentRunByChildSession(params: {
    workspaceId: string;
    childSessionId: string;
  }): SubagentRunRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(`
        SELECT *
        FROM subagent_runs
        WHERE workspace_id = ?
          AND child_session_id = ?
        LIMIT 1
      `)
      .get(params.workspaceId, params.childSessionId);
    return row ? this.rowToSubagentRun(row) : null;
  }

  listSubagentRunsByWorkspace(params: {
    workspaceId: string;
    status?: string | null;
    ownerMainSessionId?: string | null;
    limit?: number;
    offset?: number;
  }): SubagentRunRecord[] {
    let query = `
      SELECT *
      FROM subagent_runs
      WHERE workspace_id = ?
    `;
    const values: Array<string | number> = [params.workspaceId];
    if (params.status) {
      query += " AND status = ?";
      values.push(this.requiredNormalizedText(params.status, "status"));
    }
    if (params.ownerMainSessionId) {
      query += " AND owner_main_session_id = ?";
      values.push(params.ownerMainSessionId);
    }
    query += `
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, subagent_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSubagentRun(row));
  }

  listSubagentRunsByOwner(params: {
    workspaceId: string;
    ownerMainSessionId: string;
    status?: string | null;
    limit?: number;
    offset?: number;
  }): SubagentRunRecord[] {
    let query = `
      SELECT *
      FROM subagent_runs
      WHERE owner_main_session_id = ?
    `;
    const values: Array<string | number> = [params.ownerMainSessionId];
    if (params.status) {
      query += " AND status = ?";
      values.push(this.requiredNormalizedText(params.status, "status"));
    }
    query += `
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, subagent_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSubagentRun(row));
  }

  listSubagentRunsByOrigin(params: {
    workspaceId: string;
    originMainSessionId: string;
    status?: string | null;
    limit?: number;
    offset?: number;
  }): SubagentRunRecord[] {
    let query = `
      SELECT *
      FROM subagent_runs
      WHERE origin_main_session_id = ?
    `;
    const values: Array<string | number> = [params.originMainSessionId];
    if (params.status) {
      query += " AND status = ?";
      values.push(this.requiredNormalizedText(params.status, "status"));
    }
    query += `
      ORDER BY datetime(created_at) DESC, subagent_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSubagentRun(row));
  }

  listWaitingSubagentRuns(params: {
    workspaceId: string;
    ownerMainSessionId?: string | null;
    limit?: number;
    offset?: number;
  }): SubagentRunRecord[] {
    let query = `
      SELECT *
      FROM subagent_runs
      WHERE status = 'waiting_on_user'
    `;
    const values: Array<string | number> = [params.workspaceId];
    query += " AND workspace_id = ?";
    if (params.ownerMainSessionId) {
      query += " AND owner_main_session_id = ?";
      values.push(params.ownerMainSessionId);
    }
    query += `
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, subagent_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSubagentRun(row));
  }

  listIncompleteSubagentRuns(params: {
    workspaceId: string;
    ownerMainSessionId?: string | null;
    limit?: number;
    offset?: number;
  }): SubagentRunRecord[] {
    let query = `
      SELECT *
      FROM subagent_runs
      WHERE status NOT IN ('completed', 'failed', 'cancelled')
    `;
    const values: Array<string | number> = [params.workspaceId];
    query += " AND workspace_id = ?";
    if (params.ownerMainSessionId) {
      query += " AND owner_main_session_id = ?";
      values.push(params.ownerMainSessionId);
    }
    query += `
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, subagent_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSubagentRun(row));
  }

  transferSubagentOwnership(params: {
    workspaceId: string;
    subagentId: string;
    ownerMainSessionId: string;
    ownerTransferredAt?: string;
  }): SubagentRunRecord | null {
    const existing = this.getSubagentRun({ workspaceId: params.workspaceId, subagentId: params.subagentId });
    if (!existing) {
      return null;
    }
    this.ensureSession(
      {
        workspaceId: existing.workspaceId,
        sessionId: params.ownerMainSessionId,
      },
      { touchExisting: false }
    );
    const ownerTransferredAt = params.ownerTransferredAt ?? utcNowIso();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const transaction = workspaceDb.transaction(() => {
      const updated = this.updateSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: params.subagentId,
        fields: {
          ownerMainSessionId: params.ownerMainSessionId,
          ownerTransferredAt,
        },
      });
      if (!updated) {
        return null;
      }
      this.workspaceRuntimeDb(params.workspaceId)
        .prepare(`
          UPDATE main_session_event_queue
          SET owner_main_session_id = ?,
              updated_at = ?
          WHERE workspace_id = ?
            AND subagent_id = ?
            AND delivered_at IS NULL
            AND superseded_at IS NULL
        `)
        .run(params.ownerMainSessionId, utcNowIso(), params.workspaceId, params.subagentId);
      return this.getSubagentRun({ workspaceId: params.workspaceId, subagentId: params.subagentId });
    });
    return transaction();
  }

  appendSubagentProgress(params: {
    workspaceId: string;
    subagentId: string;
    latestProgressPayload: Record<string, unknown>;
    lastEventAt?: string | null;
  }): SubagentRunRecord | null {
    return this.updateSubagentRun({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      fields: {
        latestProgressPayload: params.latestProgressPayload,
        lastEventAt: params.lastEventAt ?? utcNowIso(),
      },
    });
  }

  enqueueMainSessionEvent(params: {
    eventId?: string;
    workspaceId: string;
    ownerMainSessionId: string;
    originMainSessionId: string;
    subagentId?: string | null;
    eventType: string;
    deliveryBucket: string;
    status?: string;
    payload?: Record<string, unknown> | null;
    coalesceKey?: string | null;
    earliestDeliverAt?: string | null;
    latestDeliverAt?: string | null;
    materializedInputId?: string | null;
    supersededByEventId?: string | null;
    deliveredAt?: string | null;
    supersededAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): MainSessionEventQueueRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.ownerMainSessionId,
      },
      { touchExisting: false }
    );
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.originMainSessionId,
      },
      { touchExisting: false }
    );
    const eventId = params.eventId ?? randomUUID();
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = params.createdAt ?? now;
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO main_session_event_queue (
            event_id,
            workspace_id,
            owner_main_session_id,
            origin_main_session_id,
            subagent_id,
            event_type,
            delivery_bucket,
            status,
            payload,
            coalesce_key,
            earliest_deliver_at,
            latest_deliver_at,
            materialized_input_id,
            superseded_by_event_id,
            delivered_at,
            superseded_at,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        params.workspaceId,
        params.ownerMainSessionId,
        params.originMainSessionId,
        this.normalizedNullableText(params.subagentId),
        this.requiredNormalizedText(params.eventType, "eventType"),
        this.requiredNormalizedText(params.deliveryBucket, "deliveryBucket"),
        this.requiredNormalizedText(params.status ?? "pending", "status"),
        JSON.stringify(params.payload ?? {}),
        this.normalizedNullableText(params.coalesceKey),
        this.normalizedNullableText(params.earliestDeliverAt),
        this.normalizedNullableText(params.latestDeliverAt),
        this.normalizedNullableText(params.materializedInputId),
        this.normalizedNullableText(params.supersededByEventId),
        this.normalizedNullableText(params.deliveredAt),
        this.normalizedNullableText(params.supersededAt),
        createdAt,
        now
      );
    const record = this.getMainSessionEvent({
      workspaceId: params.workspaceId,
      eventId,
    });
    if (!record) {
      throw new Error("main session event row not found after insert");
    }
    return record;
  }

  updateMainSessionEvent(params: {
    workspaceId: string;
    eventId: string;
    fields: MainSessionEventQueueUpdateFields;
  }): MainSessionEventQueueRecord | null {
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return this.getMainSessionEvent({
        workspaceId: params.workspaceId,
        eventId: params.eventId,
      });
    }
    const existing = this.getMainSessionEvent({
      workspaceId: params.workspaceId,
      eventId: params.eventId,
    });
    if (!existing) {
      return null;
    }
    if (params.fields.ownerMainSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.ownerMainSessionId,
        },
        { touchExisting: false }
      );
    }
    if (params.fields.originMainSessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.originMainSessionId,
        },
        { touchExisting: false }
      );
    }

    const columnMap: Record<keyof MainSessionEventQueueUpdateFields, string> = {
      ownerMainSessionId: "owner_main_session_id",
      originMainSessionId: "origin_main_session_id",
      subagentId: "subagent_id",
      eventType: "event_type",
      deliveryBucket: "delivery_bucket",
      status: "status",
      payload: "payload",
      coalesceKey: "coalesce_key",
      earliestDeliverAt: "earliest_deliver_at",
      latestDeliverAt: "latest_deliver_at",
      materializedInputId: "materialized_input_id",
      supersededByEventId: "superseded_by_event_id",
      deliveredAt: "delivered_at",
      supersededAt: "superseded_at",
    };
    const jsonKeys = new Set<keyof MainSessionEventQueueUpdateFields>(["payload"]);
    const textKeys = new Set<keyof MainSessionEventQueueUpdateFields>([
      "ownerMainSessionId",
      "originMainSessionId",
      "subagentId",
      "eventType",
      "deliveryBucket",
      "status",
      "coalesceKey",
      "earliestDeliverAt",
      "latestDeliverAt",
      "materializedInputId",
      "supersededByEventId",
      "deliveredAt",
      "supersededAt",
    ]);

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of entries) {
      const typedKey = key as keyof MainSessionEventQueueUpdateFields;
      const column = columnMap[typedKey];
      if (!column) {
        throw new Error(`unsupported main session event update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      if (jsonKeys.has(typedKey)) {
        values.push(value == null ? null : JSON.stringify(value));
      } else if (textKeys.has(typedKey)) {
        values.push(this.normalizedNullableText(typeof value === "string" ? value : (value as string | null | undefined)));
      } else {
        values.push(value ?? null);
      }
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso(), params.eventId);
    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`UPDATE main_session_event_queue SET ${assignments.join(", ")} WHERE event_id = ?`)
      .run(...values);
    if (result.changes <= 0) {
      return null;
    }
    return this.getMainSessionEvent({
      workspaceId: params.workspaceId,
      eventId: params.eventId,
    });
  }

  getMainSessionEvent(params: { workspaceId: string; eventId: string }): MainSessionEventQueueRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM main_session_event_queue WHERE event_id = ? LIMIT 1")
      .get(params.eventId);
    return row ? this.rowToMainSessionEventQueue(row) : null;
  }

  listPendingMainSessionEvents(params: {
    workspaceId: string;
    ownerMainSessionId: string;
    deliveryBucket?: string | null;
    before?: string | null;
    limit?: number;
  }): MainSessionEventQueueRecord[] {
    let query = `
      SELECT *
      FROM main_session_event_queue
      WHERE owner_main_session_id = ?
        AND status = 'pending'
        AND delivered_at IS NULL
        AND superseded_at IS NULL
    `;
    const values: Array<string | number> = [params.ownerMainSessionId];
    if (params.deliveryBucket) {
      query += " AND delivery_bucket = ?";
      values.push(this.requiredNormalizedText(params.deliveryBucket, "deliveryBucket"));
    }
    if (params.before) {
      query += " AND (earliest_deliver_at IS NULL OR datetime(earliest_deliver_at) <= datetime(?))";
      values.push(params.before);
    }
    query += `
      ORDER BY datetime(COALESCE(earliest_deliver_at, created_at)) ASC, datetime(created_at) ASC, event_id ASC
    `;
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      query += " LIMIT ?";
      values.push(Math.floor(params.limit));
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMainSessionEventQueue(row));
  }

  listPendingMainSessionEventsByWorkspace(params: {
    workspaceId: string;
    before?: string | null;
    limit?: number;
  }): MainSessionEventQueueRecord[] {
    let query = `
      SELECT *
      FROM main_session_event_queue
      WHERE workspace_id = ?
        AND status = 'pending'
        AND delivered_at IS NULL
        AND superseded_at IS NULL
    `;
    const values: Array<string | number> = [params.workspaceId];
    if (params.before) {
      query += " AND (earliest_deliver_at IS NULL OR datetime(earliest_deliver_at) <= datetime(?))";
      values.push(params.before);
    }
    query += `
      ORDER BY datetime(COALESCE(earliest_deliver_at, created_at)) ASC, datetime(created_at) ASC, event_id ASC
    `;
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      query += " LIMIT ?";
      values.push(Math.floor(params.limit));
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMainSessionEventQueue(row));
  }

  markMainSessionEventsMaterialized(params: {
    workspaceId: string;
    eventIds: string[];
    materializedInputId: string;
  }): MainSessionEventQueueRecord[] {
    if (params.eventIds.length === 0) {
      return [];
    }
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE main_session_event_queue
        SET status = 'materialized',
            materialized_input_id = ?,
            updated_at = ?
        WHERE event_id IN (${params.eventIds.map(() => "?").join(", ")})
      `)
      .run(params.materializedInputId, now, ...params.eventIds);
    return this.listMainSessionEventsByIds(params.workspaceId, params.eventIds);
  }

  markMainSessionEventsDelivered(params: {
    workspaceId: string;
    eventIds: string[];
    deliveredAt?: string;
  }): MainSessionEventQueueRecord[] {
    if (params.eventIds.length === 0) {
      return [];
    }
    const deliveredAt = params.deliveredAt ?? utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE main_session_event_queue
        SET status = 'delivered',
            delivered_at = ?,
            updated_at = ?
        WHERE event_id IN (${params.eventIds.map(() => "?").join(", ")})
      `)
      .run(deliveredAt, deliveredAt, ...params.eventIds);
    return this.listMainSessionEventsByIds(params.workspaceId, params.eventIds);
  }

  markMainSessionEventsSuperseded(params: {
    workspaceId: string;
    eventIds: string[];
    supersededByEventId?: string | null;
    supersededAt?: string;
  }): MainSessionEventQueueRecord[] {
    if (params.eventIds.length === 0) {
      return [];
    }
    const supersededAt = params.supersededAt ?? utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE main_session_event_queue
        SET status = 'superseded',
            superseded_by_event_id = ?,
            superseded_at = ?,
            updated_at = ?
        WHERE event_id IN (${params.eventIds.map(() => "?").join(", ")})
      `)
      .run(this.normalizedNullableText(params.supersededByEventId), supersededAt, supersededAt, ...params.eventIds);
    return this.listMainSessionEventsByIds(params.workspaceId, params.eventIds);
  }

  transferQueuedMainSessionEvents(params: {
    workspaceId: string;
    subagentId: string;
    ownerMainSessionId: string;
  }): MainSessionEventQueueRecord[] {
    const existing = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], { workspace_id: string }>(`
        SELECT workspace_id
        FROM main_session_event_queue
        WHERE subagent_id = ?
        LIMIT 1
      `)
      .get(params.subagentId);
    if (existing) {
      this.ensureSession(
        {
          workspaceId: existing.workspace_id,
          sessionId: params.ownerMainSessionId,
        },
        { touchExisting: false }
      );
    }
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE main_session_event_queue
        SET owner_main_session_id = ?,
            updated_at = ?
        WHERE subagent_id = ?
          AND delivered_at IS NULL
          AND superseded_at IS NULL
      `)
      .run(params.ownerMainSessionId, now, params.subagentId);
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM main_session_event_queue
        WHERE subagent_id = ?
          AND delivered_at IS NULL
          AND superseded_at IS NULL
        ORDER BY datetime(created_at) ASC, event_id ASC
      `)
      .all(params.subagentId);
    return rows.map((row) => this.rowToMainSessionEventQueue(row));
  }

  recoverFailedMaterializedMainSessionEvents(params: {
    workspaceId: string;
    nowIso?: string;
  }): MainSessionEventQueueRecord[] {
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const rows = workspaceDb
      .prepare<[string], Record<string, unknown>>(
        `
          SELECT q.*
          FROM main_session_event_queue AS q
          INNER JOIN agent_session_inputs AS i
            ON i.input_id = q.materialized_input_id
          WHERE q.workspace_id = ?
            AND q.status = 'materialized'
            AND q.delivered_at IS NULL
            AND q.superseded_at IS NULL
            AND i.status = 'FAILED'
          ORDER BY datetime(q.created_at) ASC, q.event_id ASC
        `
      )
      .all(params.workspaceId);
    const events = rows.map((row) => this.rowToMainSessionEventQueue(row));
    if (events.length === 0) {
      return [];
    }
    const now = params.nowIso ?? utcNowIso();
    const resetEventStatement = workspaceDb.prepare(`
      UPDATE main_session_event_queue
      SET status = 'pending',
          materialized_input_id = NULL,
          delivered_at = NULL,
          earliest_deliver_at = ?,
          updated_at = ?
      WHERE event_id = ?
    `);
    const clearFailedInputIdempotencyStatement = workspaceDb.prepare(`
      UPDATE agent_session_inputs
      SET idempotency_key = NULL,
          updated_at = ?
      WHERE input_id = ?
        AND status = 'FAILED'
    `);
    const transaction = workspaceDb.transaction(
      (records: Array<{ eventId: string; materializedInputId: string | null }>) => {
        for (const record of records) {
          resetEventStatement.run(now, now, record.eventId);
          if (record.materializedInputId) {
            clearFailedInputIdempotencyStatement.run(now, record.materializedInputId);
          }
        }
      }
    );
    transaction(
      events.map((event) => ({
        eventId: event.eventId,
        materializedInputId: event.materializedInputId,
      }))
    );
    return events
      .map((event) =>
        this.getMainSessionEvent({
          workspaceId: params.workspaceId,
          eventId: event.eventId,
        })
      )
      .filter((event): event is MainSessionEventQueueRecord => event !== null);
  }

  upsertIntegrationConnection(params: {
    connectionId: string;
    providerId: string;
    ownerUserId: string;
    accountLabel: string;
    accountExternalId?: string | null;
    accountHandle?: string | null;
    accountEmail?: string | null;
    authMode: string;
    grantedScopes: string[];
    status: string;
    secretRef?: string | null;
  }): IntegrationConnectionRecord {
    const now = utcNowIso();
    this.controlPlaneDb()
      .prepare(`
        INSERT INTO integration_connections (
            connection_id, provider_id, owner_user_id, account_label, account_external_id,
            account_handle, account_email,
            auth_mode, granted_scopes, status, secret_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
            provider_id = excluded.provider_id,
            owner_user_id = excluded.owner_user_id,
            account_label = excluded.account_label,
            account_external_id = excluded.account_external_id,
            account_handle = excluded.account_handle,
            account_email = excluded.account_email,
            auth_mode = excluded.auth_mode,
            granted_scopes = excluded.granted_scopes,
            status = excluded.status,
            secret_ref = excluded.secret_ref,
            updated_at = excluded.updated_at
      `)
      .run(
        params.connectionId,
        params.providerId,
        params.ownerUserId,
        params.accountLabel,
        params.accountExternalId ?? null,
        normalizeIdentityValue(params.accountHandle),
        normalizeIdentityValue(params.accountEmail),
        params.authMode,
        JSON.stringify(params.grantedScopes ?? []),
        params.status,
        params.secretRef ?? null,
        now,
        now
      );
    const record = this.getIntegrationConnection(params.connectionId);
    if (!record) {
      throw new Error("failed to load integration connection");
    }
    return record;
  }

  /**
   * Find the most-recently-updated active connection that matches the
   * given (provider, owner) tuple AND either of the supplied identity
   * keys (handle or email, case-insensitive). Used by the integration
   * service to detect re-auth flows so the store doesn't grow a fresh
   * row every time the user reconnects the same external account.
   *
   * Returns null when no identity key is provided, or when no active
   * connection matches — the caller should fall back to creating a new
   * connection in that case.
   */
  findActiveIntegrationConnectionByIdentity(params: {
    providerId: string;
    ownerUserId: string;
    accountHandle?: string | null;
    accountEmail?: string | null;
  }): IntegrationConnectionRecord | null {
    const handle = normalizeIdentityValue(params.accountHandle);
    const email = normalizeIdentityValue(params.accountEmail);
    if (!handle && !email) {
      return null;
    }
    const filters: string[] = ["provider_id = ?", "owner_user_id = ?", "lower(status) = 'active'"];
    const values: (string | null)[] = [params.providerId, params.ownerUserId];
    const identityClauses: string[] = [];
    if (handle) {
      identityClauses.push("lower(account_handle) = lower(?)");
      values.push(handle);
    }
    if (email) {
      identityClauses.push("lower(account_email) = lower(?)");
      values.push(email);
    }
    filters.push(`(${identityClauses.join(" OR ")})`);
    const row = this.controlPlaneDb()
      .prepare<typeof values, Record<string, unknown>>(
        `SELECT * FROM integration_connections WHERE ${filters.join(" AND ")} ORDER BY datetime(updated_at) DESC LIMIT 1`
      )
      .get(...values);
    return row ? this.rowToIntegrationConnection(row) : null;
  }

  getIntegrationConnection(connectionId: string): IntegrationConnectionRecord | null {
    const row = this.controlPlaneDb()
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM integration_connections WHERE connection_id = ? LIMIT 1"
      )
      .get(connectionId);
    return row ? this.rowToIntegrationConnection(row) : null;
  }

  listIntegrationConnections(params: { providerId?: string; ownerUserId?: string } = {}): IntegrationConnectionRecord[] {
    let query = "SELECT * FROM integration_connections";
    const filters: string[] = [];
    const values: string[] = [];
    if (params.providerId) {
      filters.push("provider_id = ?");
      values.push(params.providerId);
    }
    if (params.ownerUserId) {
      filters.push("owner_user_id = ?");
      values.push(params.ownerUserId);
    }
    if (filters.length > 0) {
      query += ` WHERE ${filters.join(" AND ")}`;
    }
    query += " ORDER BY datetime(created_at) ASC, connection_id ASC";
    const rows = this.controlPlaneDb().prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToIntegrationConnection(row));
  }

  upsertIntegrationBinding(params: {
    bindingId: string;
    workspaceId: string;
    targetType: string;
    targetId: string;
    integrationKey: string;
    connectionId: string;
    isDefault: boolean;
  }): IntegrationBindingRecord {
    const connection = this.getIntegrationConnection(params.connectionId);
    if (!connection) {
      throw new Error(`integration connection ${params.connectionId} not found`);
    }

    const now = utcNowIso();
    const existing = this.getIntegrationBindingByTarget({
      workspaceId: params.workspaceId,
      targetType: params.targetType,
      targetId: params.targetId,
      integrationKey: params.integrationKey
    });

    if (existing) {
      this.controlPlaneDb()
        .prepare(`
          UPDATE integration_bindings
          SET binding_id = ?,
              connection_id = ?,
              is_default = ?,
              updated_at = ?
          WHERE workspace_id = ? AND target_type = ? AND target_id = ? AND integration_key = ?
        `)
        .run(
          params.bindingId,
          params.connectionId,
          params.isDefault ? 1 : 0,
          now,
          params.workspaceId,
          params.targetType,
          params.targetId,
          params.integrationKey
        );
    } else {
      this.controlPlaneDb()
        .prepare(`
          INSERT INTO integration_bindings (
              binding_id, workspace_id, target_type, target_id, integration_key,
              connection_id, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          params.bindingId,
          params.workspaceId,
          params.targetType,
          params.targetId,
          params.integrationKey,
          params.connectionId,
          params.isDefault ? 1 : 0,
          now,
          now
        );
    }

    const record = this.getIntegrationBindingByTarget({
      workspaceId: params.workspaceId,
      targetType: params.targetType,
      targetId: params.targetId,
      integrationKey: params.integrationKey
    });
    if (!record) {
      throw new Error("failed to load integration binding");
    }
    return record;
  }

  getIntegrationBinding(bindingId: string): IntegrationBindingRecord | null {
    const row = this.controlPlaneDb()
      .prepare<[string], Record<string, unknown>>("SELECT * FROM integration_bindings WHERE binding_id = ? LIMIT 1")
      .get(bindingId);
    return row ? this.rowToIntegrationBinding(row) : null;
  }

  getIntegrationBindingByTarget(params: {
    workspaceId: string;
    targetType: string;
    targetId: string;
    integrationKey: string;
  }): IntegrationBindingRecord | null {
    const row = this.controlPlaneDb()
      .prepare<[string, string, string, string], Record<string, unknown>>(`
        SELECT * FROM integration_bindings
        WHERE workspace_id = ? AND target_type = ? AND target_id = ? AND integration_key = ?
        LIMIT 1
      `)
      .get(params.workspaceId, params.targetType, params.targetId, params.integrationKey);
    return row ? this.rowToIntegrationBinding(row) : null;
  }

  listIntegrationBindings(params: { workspaceId?: string }): IntegrationBindingRecord[] {
    let query = "SELECT * FROM integration_bindings";
    const values: string[] = [];
    if (params.workspaceId) {
      query += " WHERE workspace_id = ?";
      values.push(params.workspaceId);
    }
    query += " ORDER BY is_default DESC, datetime(created_at) ASC, binding_id ASC";
    const rows = this.controlPlaneDb().prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToIntegrationBinding(row));
  }

  deleteIntegrationConnection(connectionId: string): boolean {
    const result = this.controlPlaneDb()
      .prepare("DELETE FROM integration_connections WHERE connection_id = ?")
      .run(connectionId);
    return result.changes > 0;
  }

  deleteIntegrationBinding(bindingId: string): boolean {
    const result = this.controlPlaneDb().prepare("DELETE FROM integration_bindings WHERE binding_id = ?").run(bindingId);
    return result.changes > 0;
  }

  upsertOAuthAppConfig(params: {
    providerId: string;
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    redirectPort?: number;
  }): OAuthAppConfigRecord {
    const now = utcNowIso();
    const redirectPort = params.redirectPort ?? 38765;
    this.controlPlaneDb().prepare(`
      INSERT INTO oauth_app_configs (provider_id, client_id, client_secret, authorize_url, token_url, scopes, redirect_port, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider_id) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret = CASE WHEN excluded.client_secret = '' THEN oauth_app_configs.client_secret ELSE excluded.client_secret END,
        authorize_url = excluded.authorize_url,
        token_url = excluded.token_url,
        scopes = excluded.scopes,
        redirect_port = excluded.redirect_port,
        updated_at = excluded.updated_at
    `).run(
      params.providerId, params.clientId, params.clientSecret,
      params.authorizeUrl, params.tokenUrl, JSON.stringify(params.scopes),
      redirectPort, now, now
    );
    const record = this.getOAuthAppConfig(params.providerId);
    if (!record) {
      throw new Error("failed to load OAuth app config");
    }
    return record;
  }

  getOAuthAppConfig(providerId: string): OAuthAppConfigRecord | null {
    const row = this.controlPlaneDb().prepare("SELECT * FROM oauth_app_configs WHERE provider_id = ?").get(providerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      providerId: row.provider_id as string,
      clientId: row.client_id as string,
      clientSecret: row.client_secret as string,
      authorizeUrl: row.authorize_url as string,
      tokenUrl: row.token_url as string,
      scopes: JSON.parse(row.scopes as string ?? "[]") as string[],
      redirectPort: row.redirect_port as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  listOAuthAppConfigs(): OAuthAppConfigRecord[] {
    const rows = this.controlPlaneDb().prepare("SELECT * FROM oauth_app_configs ORDER BY provider_id").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      providerId: row.provider_id as string,
      clientId: row.client_id as string,
      clientSecret: row.client_secret as string,
      authorizeUrl: row.authorize_url as string,
      tokenUrl: row.token_url as string,
      scopes: JSON.parse(row.scopes as string ?? "[]") as string[],
      redirectPort: row.redirect_port as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  deleteOAuthAppConfig(providerId: string): boolean {
    const result = this.controlPlaneDb().prepare("DELETE FROM oauth_app_configs WHERE provider_id = ?").run(providerId);
    return result.changes > 0;
  }

  enqueueInput(params: {
    workspaceId: string;
    sessionId: string;
    payload: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string | null;
  }): SessionInputRecord {
    if (params.idempotencyKey) {
      const existing = this.getInputByIdempotencyKey({
        workspaceId: params.workspaceId,
        idempotencyKey: params.idempotencyKey,
      });
      if (existing) {
        return existing;
      }
    }
    const inputId = randomUUID();
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO agent_session_inputs (
            input_id, session_id, workspace_id, payload, status, priority, available_at,
            attempt, idempotency_key, claimed_by, claimed_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)
      `)
      .run(
        inputId,
        params.sessionId,
        params.workspaceId,
        JSON.stringify(params.payload),
        "QUEUED",
        params.priority ?? 0,
        now,
        params.idempotencyKey ?? null,
        now,
        now
      );
    const record = this.getInput({
      workspaceId: params.workspaceId,
      inputId,
    });
    if (!record) {
      throw new Error("failed to load queued input");
    }
    return record;
  }

  getInput(params: { workspaceId: string; inputId: string }): SessionInputRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM agent_session_inputs WHERE input_id = ? LIMIT 1")
      .get(params.inputId);
    return this.rowToInput(row);
  }

  getInputByIdempotencyKey(params: { workspaceId: string; idempotencyKey: string }): SessionInputRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM agent_session_inputs WHERE idempotency_key = ? LIMIT 1"
      )
      .get(params.idempotencyKey);
    return this.rowToInput(row);
  }

  getLatestInputForSession(params: LatestSessionInputOptions): SessionInputRecord | null {
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 200;
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string, number], Record<string, unknown>>(
        `
          SELECT *
          FROM agent_session_inputs
          WHERE workspace_id = ? AND session_id = ?
          ORDER BY datetime(created_at) DESC, input_id DESC
          LIMIT ?
        `
      )
      .all(params.workspaceId, params.sessionId, limit);
    const records = rows
      .map((row) => this.rowToInput(row))
      .filter((record): record is SessionInputRecord => record !== null);
    const excludedSources = new Set(
      (params.excludeContextSources ?? []).map((value) => value.trim()).filter(Boolean)
    );
    const filtered = records.filter((record) => {
      const context =
        record.payload.context &&
        typeof record.payload.context === "object" &&
        !Array.isArray(record.payload.context)
          ? (record.payload.context as Record<string, unknown>)
          : null;
      const source =
        context && typeof context.source === "string" ? context.source.trim() : "";
      return !excludedSources.has(source);
    });
    if (filtered.length === 0) {
      return null;
    }
    if (!params.preferConfiguredModel) {
      return filtered[0] ?? null;
    }
    const configured = filtered.find((record) => {
      const model =
        typeof record.payload.model === "string" ? record.payload.model.trim() : "";
      const thinkingValue =
        typeof record.payload.thinking_value === "string"
          ? record.payload.thinking_value.trim()
          : "";
      return Boolean(model || thinkingValue);
    });
    return configured ?? filtered[0] ?? null;
  }

  updateInput(params: {
    workspaceId: string;
    inputId: string;
    fields: InputUpdateFields;
  }): SessionInputRecord | null {
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return this.getInput({
        workspaceId: params.workspaceId,
        inputId: params.inputId,
      });
    }

    const columnMap: Record<keyof InputUpdateFields, string> = {
      sessionId: "session_id",
      workspaceId: "workspace_id",
      payload: "payload",
      status: "status",
      priority: "priority",
      availableAt: "available_at",
      attempt: "attempt",
      idempotencyKey: "idempotency_key",
      claimedBy: "claimed_by",
      claimedUntil: "claimed_until"
    };

    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, rawValue] of entries) {
      const column = columnMap[key as keyof InputUpdateFields];
      if (!column) {
        throw new Error(`unsupported session input update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      values.push(key === "payload" ? JSON.stringify(rawValue ?? {}) : (rawValue as string | number | null));
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso());
    values.push(params.inputId);

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`UPDATE agent_session_inputs SET ${assignments.join(", ")} WHERE input_id = ?`)
      .run(...values);
    return this.getInput({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
  }

  renewInputClaim(params: {
    workspaceId: string;
    inputId: string;
    claimedBy: string;
    leaseSeconds: number;
    nowIso?: string;
  }): SessionInputRecord | null {
    const now = params.nowIso ? new Date(params.nowIso) : new Date();
    const nowIso = params.nowIso ?? now.toISOString();
    const claimedUntilIso =
      params.leaseSeconds > 0 ? new Date(now.getTime() + params.leaseSeconds * 1000).toISOString() : nowIso;
    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE agent_session_inputs
        SET claimed_until = ?,
            updated_at = ?
        WHERE input_id = ?
          AND status = 'CLAIMED'
          AND claimed_by = ?
      `)
      .run(claimedUntilIso, nowIso, params.inputId, params.claimedBy);
    if (result.changes === 0) {
      return null;
    }
    return this.getInput({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
  }

  claimInputs(params: {
    limit: number;
    claimedBy: string;
    leaseSeconds: number;
    distinctSessions?: boolean;
    excludeSessionIds?: string[];
  }): SessionInputRecord[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const claimedUntilIso =
      params.leaseSeconds > 0 ? new Date(now.getTime() + params.leaseSeconds * 1000).toISOString() : nowIso;

    const candidates = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      const rows = db
        .prepare<[string, string, string], { input_id: string; session_id: string; priority: number; created_at: string }>(`
          SELECT queued.input_id, queued.session_id, queued.priority, queued.created_at
          FROM agent_session_inputs AS queued
          WHERE queued.status = 'QUEUED'
            AND datetime(queued.available_at) <= datetime(?)
            AND (queued.claimed_until IS NULL OR datetime(queued.claimed_until) <= datetime(?))
            AND NOT EXISTS (
              SELECT 1
              FROM agent_session_inputs AS claimed
              WHERE claimed.session_id = queued.session_id
                AND claimed.input_id != queued.input_id
                AND claimed.status = 'CLAIMED'
                AND (claimed.claimed_until IS NULL OR datetime(claimed.claimed_until) > datetime(?))
            )
          ORDER BY priority DESC, datetime(created_at) ASC
        `)
        .all(nowIso, nowIso, nowIso);
      return rows.map((row) => ({
        workspaceId,
        inputId: row.input_id,
        sessionId: row.session_id,
        priority: row.priority,
        createdAt: row.created_at,
      }));
    });
    candidates.sort((left, right) => {
      const priorityCompare = Number(right.priority) - Number(left.priority);
      if (priorityCompare !== 0) {
        return priorityCompare;
      }
      const createdCompare = String(left.createdAt).localeCompare(String(right.createdAt));
      if (createdCompare !== 0) {
        return createdCompare;
      }
      return left.inputId.localeCompare(right.inputId);
    });

    const selectedInputs: Array<{ workspaceId: string; inputId: string }> = [];
    const seenSessionIds = new Set<string>();
    const excludedSessionIds = new Set(
      (params.excludeSessionIds ?? []).map((sessionId) => sessionId.trim()).filter((sessionId) => sessionId.length > 0),
    );
    for (const row of candidates) {
      if (excludedSessionIds.has(row.sessionId)) {
        continue;
      }
      if (params.distinctSessions && seenSessionIds.has(row.sessionId)) {
        continue;
      }
      selectedInputs.push({
        workspaceId: row.workspaceId,
        inputId: row.inputId,
      });
      if (params.distinctSessions) {
        seenSessionIds.add(row.sessionId);
      }
      if (selectedInputs.length >= Math.max(1, params.limit)) {
        break;
      }
    }
    const records: SessionInputRecord[] = [];
    for (const selected of selectedInputs) {
      const result = this.workspaceRuntimeDb(selected.workspaceId)
        .prepare(`
          UPDATE agent_session_inputs
          SET status = 'CLAIMED',
              claimed_by = ?,
              claimed_until = ?,
              updated_at = ?
          WHERE input_id = ?
            AND status = 'QUEUED'
        `)
        .run(params.claimedBy, claimedUntilIso, nowIso, selected.inputId);
      if (result.changes <= 0) {
        continue;
      }
      const record = this.getInput(selected);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  hasAvailableInputsForSession(params: { workspaceId: string; sessionId: string }): boolean {
    const nowIso = utcNowIso();
    const query = `
      SELECT input_id FROM agent_session_inputs
      WHERE session_id = ?
        AND workspace_id = ?
        AND status = 'QUEUED'
        AND datetime(available_at) <= datetime(?)
      LIMIT 1
    `;
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(
      params.sessionId,
      params.workspaceId,
      nowIso,
    );
    return Boolean(row);
  }

  listExpiredClaimedInputs(nowIso = utcNowIso()): SessionInputRecord[] {
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
      const rows = db
        .prepare<[string], Record<string, unknown>>(`
          SELECT *
          FROM agent_session_inputs
          WHERE status = 'CLAIMED'
            AND claimed_until IS NOT NULL
            AND datetime(claimed_until) <= datetime(?)
          ORDER BY datetime(claimed_until) ASC, datetime(updated_at) ASC
        `)
        .all(nowIso);
      return rows
        .map((row) => this.rowToInput(row))
        .filter((row): row is SessionInputRecord => row !== null);
    });
    records.sort((left, right) => {
      const claimedCompare = (left.claimedUntil ?? "").localeCompare(right.claimedUntil ?? "");
      if (claimedCompare !== 0) {
        return claimedCompare;
      }
      const updatedCompare = left.updatedAt.localeCompare(right.updatedAt);
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return left.inputId.localeCompare(right.inputId);
    });
    return records;
  }

  static readonly #LIST_CLAIMED_INPUTS_SQL = `
    SELECT *
    FROM agent_session_inputs
    WHERE status = 'CLAIMED'
    ORDER BY datetime(claimed_until) ASC, datetime(updated_at) ASC
  `;

  listClaimedInputs(): SessionInputRecord[] {
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
      const rows = db.prepare(RuntimeStateStore.#LIST_CLAIMED_INPUTS_SQL).all() as Array<Record<string, unknown>>;
      return rows
        .map((row) => this.rowToInput(row))
        .filter((row): row is SessionInputRecord => row !== null);
    });
    records.sort((left, right) => {
      const claimedCompare = (left.claimedUntil ?? "").localeCompare(right.claimedUntil ?? "");
      if (claimedCompare !== 0) {
        return claimedCompare;
      }
      const updatedCompare = left.updatedAt.localeCompare(right.updatedAt);
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return left.inputId.localeCompare(right.inputId);
    });
    return records;
  }

  enqueuePostRunJob(params: {
    jobType: string;
    workspaceId: string;
    sessionId: string;
    inputId: string;
    payload?: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string | null;
  }): PostRunJobRecord {
    if (params.idempotencyKey) {
      const existing = this.getPostRunJobByIdempotencyKey({
        workspaceId: params.workspaceId,
        idempotencyKey: params.idempotencyKey,
      });
      if (existing) {
        return existing;
      }
    }
    const jobId = randomUUID();
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO post_run_jobs (
            job_id, job_type, input_id, session_id, workspace_id, payload, status, priority, available_at,
            attempt, idempotency_key, claimed_by, claimed_until, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)
      `)
      .run(
        jobId,
        params.jobType,
        params.inputId,
        params.sessionId,
        params.workspaceId,
        JSON.stringify(params.payload ?? {}),
        "QUEUED",
        params.priority ?? 0,
        now,
        params.idempotencyKey ?? null,
        now,
        now
      );
    const record = this.getPostRunJob({
      workspaceId: params.workspaceId,
      jobId,
    });
    if (!record) {
      throw new Error("failed to load queued post-run job");
    }
    return record;
  }

  getPostRunJob(params: { workspaceId: string; jobId: string }): PostRunJobRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM post_run_jobs WHERE job_id = ? LIMIT 1")
      .get(params.jobId);
    return this.rowToPostRunJob(row);
  }

  getPostRunJobByIdempotencyKey(params: { workspaceId: string; idempotencyKey: string }): PostRunJobRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM post_run_jobs WHERE idempotency_key = ? LIMIT 1")
      .get(params.idempotencyKey);
    return this.rowToPostRunJob(row);
  }

  listPostRunJobs(params: {
    workspaceId?: string;
    sessionId?: string;
    inputId?: string;
    jobType?: string;
    statuses?: string[];
    limit?: number;
    offset?: number;
  }): PostRunJobRecord[] {
    if (!params.workspaceId) {
      const jobs = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
        let query = "SELECT * FROM post_run_jobs WHERE 1 = 1";
        const values: Array<string | number> = [];
        if (params.sessionId) {
          query += " AND session_id = ?";
          values.push(params.sessionId);
        }
        if (params.inputId) {
          query += " AND input_id = ?";
          values.push(params.inputId);
        }
        if (params.jobType) {
          query += " AND job_type = ?";
          values.push(params.jobType);
        }
        if (params.statuses && params.statuses.length > 0) {
          const placeholders = params.statuses.map(() => "?").join(", ");
          query += ` AND status IN (${placeholders})`;
          values.push(...params.statuses);
        }
        query += " ORDER BY priority DESC, datetime(created_at) ASC";
        const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
        return rows
          .map((row) => this.rowToPostRunJob(row))
          .filter((row): row is PostRunJobRecord => row !== null);
      });
      jobs.sort((left, right) => {
        const priorityCompare = right.priority - left.priority;
        if (priorityCompare !== 0) {
          return priorityCompare;
        }
        const createdCompare = left.createdAt.localeCompare(right.createdAt);
        if (createdCompare !== 0) {
          return createdCompare;
        }
        return left.jobId.localeCompare(right.jobId);
      });
      return jobs.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 100));
    }
    let query = "SELECT * FROM post_run_jobs WHERE 1 = 1";
    const values: Array<string | number> = [];
    if (params.workspaceId) {
      query += " AND workspace_id = ?";
      values.push(params.workspaceId);
    }
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.jobType) {
      query += " AND job_type = ?";
      values.push(params.jobType);
    }
    if (params.statuses && params.statuses.length > 0) {
      const placeholders = params.statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      values.push(...params.statuses);
    }
    query += " ORDER BY priority DESC, datetime(created_at) ASC LIMIT ? OFFSET ?";
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.rowToPostRunJob(row))
      .filter((row): row is PostRunJobRecord => row !== null);
  }

  updatePostRunJob(params: {
    workspaceId: string;
    jobId: string;
    fields: PostRunJobUpdateFields;
  }): PostRunJobRecord | null {
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return this.getPostRunJob({
        workspaceId: params.workspaceId,
        jobId: params.jobId,
      });
    }

    const columnMap: Record<keyof PostRunJobUpdateFields, string> = {
      jobType: "job_type",
      inputId: "input_id",
      sessionId: "session_id",
      workspaceId: "workspace_id",
      payload: "payload",
      status: "status",
      priority: "priority",
      availableAt: "available_at",
      attempt: "attempt",
      idempotencyKey: "idempotency_key",
      claimedBy: "claimed_by",
      claimedUntil: "claimed_until",
      lastError: "last_error",
    };

    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, rawValue] of entries) {
      const column = columnMap[key as keyof PostRunJobUpdateFields];
      if (!column) {
        throw new Error(`unsupported post-run job update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      values.push(
        key === "payload" || key === "lastError"
          ? rawValue == null
            ? null
            : JSON.stringify(rawValue)
          : (rawValue as string | number | null)
      );
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso());
    values.push(params.jobId);

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`UPDATE post_run_jobs SET ${assignments.join(", ")} WHERE job_id = ?`)
      .run(...values);
    return this.getPostRunJob({
      workspaceId: params.workspaceId,
      jobId: params.jobId,
    });
  }

  claimPostRunJobs(params: { limit: number; claimedBy: string; leaseSeconds: number; distinctSessions?: boolean }): PostRunJobRecord[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const claimedUntilIso =
      params.leaseSeconds > 0 ? new Date(now.getTime() + params.leaseSeconds * 1000).toISOString() : nowIso;

    const candidates = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      const rows = db
        .prepare<[string, string], { job_id: string; session_id: string; priority: number; created_at: string }>(`
          SELECT job_id, session_id, priority, created_at
          FROM post_run_jobs
          WHERE status = 'QUEUED'
            AND datetime(available_at) <= datetime(?)
            AND (claimed_until IS NULL OR datetime(claimed_until) <= datetime(?))
          ORDER BY priority DESC, datetime(created_at) ASC
        `)
        .all(nowIso, nowIso);
      return rows.map((row) => ({
        workspaceId,
        jobId: row.job_id,
        sessionId: row.session_id,
        priority: row.priority,
        createdAt: row.created_at,
      }));
    });
    candidates.sort((left, right) => {
      const priorityCompare = Number(right.priority) - Number(left.priority);
      if (priorityCompare !== 0) {
        return priorityCompare;
      }
      const createdCompare = String(left.createdAt).localeCompare(String(right.createdAt));
      if (createdCompare !== 0) {
        return createdCompare;
      }
      return left.jobId.localeCompare(right.jobId);
    });

    const selectedJobs: Array<{ workspaceId: string; jobId: string }> = [];
    const seenSessionIds = new Set<string>();
    for (const row of candidates) {
      if (params.distinctSessions && seenSessionIds.has(row.sessionId)) {
        continue;
      }
      selectedJobs.push({
        workspaceId: row.workspaceId,
        jobId: row.jobId,
      });
      if (params.distinctSessions) {
        seenSessionIds.add(row.sessionId);
      }
      if (selectedJobs.length >= Math.max(1, params.limit)) {
        break;
      }
    }
    const records: PostRunJobRecord[] = [];
    for (const selected of selectedJobs) {
      const result = this.workspaceRuntimeDb(selected.workspaceId)
        .prepare(`
          UPDATE post_run_jobs
          SET status = 'CLAIMED',
              claimed_by = ?,
              claimed_until = ?,
              updated_at = ?
          WHERE job_id = ?
            AND status = 'QUEUED'
        `)
        .run(params.claimedBy, claimedUntilIso, nowIso, selected.jobId);
      if (result.changes <= 0) {
        continue;
      }
      const record = this.getPostRunJob(selected);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  static readonly #LIST_EXPIRED_CLAIMED_POST_RUN_JOBS_SQL = `
    SELECT *
    FROM post_run_jobs
    WHERE status = 'CLAIMED'
      AND claimed_until IS NOT NULL
      AND datetime(claimed_until) <= datetime(?)
    ORDER BY datetime(claimed_until) ASC, datetime(updated_at) ASC
  `;

  listExpiredClaimedPostRunJobs(nowIso = utcNowIso()): PostRunJobRecord[] {
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
      const rows = db.prepare(RuntimeStateStore.#LIST_EXPIRED_CLAIMED_POST_RUN_JOBS_SQL).all(nowIso) as Array<Record<string, unknown>>;
      return rows
        .map((row) => this.rowToPostRunJob(row))
        .filter((row): row is PostRunJobRecord => row !== null);
    });
    records.sort((left, right) => {
      const claimedCompare = (left.claimedUntil ?? "").localeCompare(right.claimedUntil ?? "");
      if (claimedCompare !== 0) {
        return claimedCompare;
      }
      const updatedCompare = left.updatedAt.localeCompare(right.updatedAt);
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return left.jobId.localeCompare(right.jobId);
    });
    return records;
  }

  ensureRuntimeState(params: {
    workspaceId: string;
    sessionId: string;
    status?: string;
    currentInputId?: string | null;
  }): SessionRuntimeStateRecord {
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId
      },
      { touchExisting: false }
    );
    const now = utcNowIso();
    workspaceDb
      .prepare(`
        INSERT INTO session_runtime_state (
            workspace_id, session_id, status, current_input_id, current_worker_id,
            lease_until, heartbeat_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(workspace_id, session_id) DO UPDATE SET
            status = excluded.status,
            current_input_id = excluded.current_input_id,
            updated_at = excluded.updated_at
      `)
      .run(params.workspaceId, params.sessionId, params.status ?? "QUEUED", params.currentInputId ?? null, now, now);
    const row = workspaceDb
      .prepare<[string, string], Record<string, unknown>>(
        "SELECT * FROM session_runtime_state WHERE workspace_id = ? AND session_id = ? LIMIT 1"
      )
      .get(params.workspaceId, params.sessionId);
    return this.rowToRuntimeState(row);
  }

  updateRuntimeState(params: {
    workspaceId: string;
    sessionId: string;
    status: string;
    currentInputId?: string | null;
    currentWorkerId?: string | null;
    leaseUntil?: string | null;
    heartbeatAt?: string | null;
    lastError?: Record<string, unknown> | string | null;
  }): SessionRuntimeStateRecord {
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId
      },
      { touchExisting: false }
    );
    const heartbeatAt = params.heartbeatAt ?? utcNowIso();
    const serializedLastError =
      params.lastError == null
        ? null
        : typeof params.lastError === "string"
        ? params.lastError
        : JSON.stringify(params.lastError);

    workspaceDb
      .prepare(`
        INSERT INTO session_runtime_state (
            workspace_id, session_id, status, current_input_id, current_worker_id,
            lease_until, heartbeat_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, session_id) DO UPDATE SET
            status = excluded.status,
            current_input_id = excluded.current_input_id,
            current_worker_id = excluded.current_worker_id,
            lease_until = excluded.lease_until,
            heartbeat_at = excluded.heartbeat_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
      `)
      .run(
        params.workspaceId,
        params.sessionId,
        params.status,
        params.currentInputId ?? null,
        params.currentWorkerId ?? null,
        params.leaseUntil ?? null,
        heartbeatAt,
        serializedLastError,
        heartbeatAt,
        heartbeatAt
      );
    const row = workspaceDb
      .prepare<[string, string], Record<string, unknown>>(
        "SELECT * FROM session_runtime_state WHERE workspace_id = ? AND session_id = ? LIMIT 1"
      )
      .get(params.workspaceId, params.sessionId);
    return this.rowToRuntimeState(row);
  }

  listRuntimeStates(workspaceId: string): SessionRuntimeStateRecord[] {
    const rows = this.workspaceRuntimeDb(workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM session_runtime_state
        WHERE workspace_id = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
      `)
      .all(workspaceId);
    return rows.map((row) => this.rowToRuntimeState(row));
  }

  getRuntimeState(params: { workspaceId: string; sessionId: string }): SessionRuntimeStateRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(`
        SELECT * FROM session_runtime_state
        WHERE workspace_id = ? AND session_id = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC LIMIT 1
      `)
      .get(params.workspaceId, params.sessionId);
    return row ? this.rowToRuntimeState(row) : null;
  }

  insertSessionMessage(params: {
    workspaceId: string;
    sessionId: string;
    role: string;
    text: string;
    messageId?: string;
    createdAt?: string;
  }): void {
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT OR REPLACE INTO session_messages (
            id, workspace_id, session_id, role, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.messageId ?? randomUUID(),
        params.workspaceId,
        params.sessionId,
        params.role,
        params.text,
        params.createdAt ?? utcNowIso()
      );
  }

  countSessionMessages(params: {
    workspaceId: string;
    sessionId: string;
    role?: string;
  }): number {
    let query = `
      SELECT COUNT(*) AS total
      FROM session_messages
      WHERE workspace_id = ? AND session_id = ?
    `;
    const values: string[] = [params.workspaceId, params.sessionId];
    if (params.role) {
      query += " AND role = ?";
      values.push(params.role);
    }
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  listSessionMessages(params: {
    workspaceId: string;
    sessionId: string;
    role?: string;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  }): SessionMessageRecord[] {
    let query = `
      SELECT id, role, text, created_at
      FROM session_messages
      WHERE workspace_id = ? AND session_id = ?
    `;
    const values: Array<string | number> = [params.workspaceId, params.sessionId];
    if (params.role) {
      query += " AND role = ?";
      values.push(params.role);
    }
    const direction = params.order === "desc" ? "DESC" : "ASC";
    query += ` ORDER BY julianday(created_at) ${direction}, id ${direction}`;
    if (params.limit !== undefined || params.offset !== undefined) {
      query += " LIMIT ? OFFSET ?";
      values.push(params.limit ?? -1, params.offset ?? 0);
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<typeof values, { id: string; role: string; text: string; created_at: string }>(query)
      .all(...values);
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.created_at,
      metadata: {}
    }));
  }

  appendOutputEvent(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    sequence: number;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt?: string;
  }): void {
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO session_output_events (
            workspace_id, session_id, input_id, sequence, event_type, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.workspaceId,
        params.sessionId,
        params.inputId,
        params.sequence,
        params.eventType,
        JSON.stringify(params.payload),
        params.createdAt ?? utcNowIso()
      );
  }

  latestOutputEventId(params: { workspaceId: string; sessionId: string; inputId?: string; excludedEventTypes?: string[] }): number {
    let query = `
      SELECT MAX(id) AS max_id
      FROM session_output_events
      WHERE workspace_id = ?
        AND session_id = ?
    `;
    const values: string[] = [params.workspaceId, params.sessionId];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    const excludedEventTypes = (params.excludedEventTypes ?? []).filter((value) => Boolean(value && value.trim()));
    if (excludedEventTypes.length > 0) {
      query += ` AND event_type NOT IN (${excludedEventTypes.map(() => "?").join(", ")})`;
      values.push(...excludedEventTypes);
    }
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as { max_id: number | null } | undefined;
    return row?.max_id ?? 0;
  }

  listOutputEvents(params: {
    workspaceId: string;
    sessionId: string;
    inputId?: string;
    includeHistory?: boolean;
    afterEventId?: number;
    excludedEventTypes?: string[];
  }): OutputEventRecord[] {
    let query = `
      SELECT id, workspace_id, session_id, input_id, sequence, event_type, payload, created_at
      FROM session_output_events
      WHERE workspace_id = ?
        AND session_id = ?
        AND id > ?
    `;
    const values: Array<string | number> = [params.workspaceId, params.sessionId, params.afterEventId ?? 0];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    const excludedEventTypes = (params.excludedEventTypes ?? []).filter((value) => Boolean(value && value.trim()));
    if (excludedEventTypes.length > 0) {
      query += ` AND event_type NOT IN (${excludedEventTypes.map(() => "?").join(", ")})`;
      values.push(...excludedEventTypes);
    }
    if (params.includeHistory === false) {
      query += " AND 1 = 0";
    }
    query += " ORDER BY id ASC";

    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      inputId: String(row.input_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      payload: this.parseJsonDict(row.payload),
      createdAt: String(row.created_at)
    }));
  }

  createTerminalSession(params: {
    terminalId?: string;
    workspaceId: string;
    sessionId?: string | null;
    inputId?: string | null;
    title?: string | null;
    backend: TerminalSessionBackend;
    owner: TerminalSessionOwner;
    status: TerminalSessionStatus;
    cwd: string;
    shell?: string | null;
    command: string;
    exitCode?: number | null;
    createdBy?: string | null;
    createdAt?: string;
    startedAt?: string;
    lastActivityAt?: string;
    endedAt?: string | null;
    metadata?: Record<string, unknown> | null;
  }): TerminalSessionRecord {
    if (params.sessionId) {
      this.ensureSession(
        {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
        },
        { touchExisting: false }
      );
    }

    const terminalId = params.terminalId ?? randomUUID();
    const createdAt = params.createdAt ?? utcNowIso();
    const startedAt = params.startedAt ?? createdAt;
    const lastActivityAt = params.lastActivityAt ?? startedAt;

    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    workspaceDb
      .prepare(`
        INSERT INTO terminal_sessions (
            terminal_id, workspace_id, session_id, input_id, title, backend, owner, status,
            cwd, shell, command, exit_code, last_event_seq, created_by, created_at,
            started_at, last_activity_at, ended_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        terminalId,
        params.workspaceId,
        params.sessionId ?? null,
        params.inputId ?? null,
        params.title ?? "",
        params.backend,
        params.owner,
        params.status,
        params.cwd,
        params.shell ?? null,
        params.command,
        params.exitCode ?? null,
        0,
        params.createdBy ?? null,
        createdAt,
        startedAt,
        lastActivityAt,
        params.endedAt ?? null,
        JSON.stringify(params.metadata ?? {})
      );

    const row = workspaceDb
      .prepare<[string], Record<string, unknown>>("SELECT * FROM terminal_sessions WHERE terminal_id = ? LIMIT 1")
      .get(terminalId);
    if (!row) {
      throw new Error(`terminal session ${terminalId} was not created`);
    }
    return this.rowToTerminalSession(row);
  }

  getTerminalSession(params: { workspaceId: string; terminalId: string }): TerminalSessionRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM terminal_sessions WHERE terminal_id = ? LIMIT 1")
      .get(params.terminalId);
    return row ? this.rowToTerminalSession(row) : null;
  }

  listTerminalSessions(params: {
    workspaceId?: string;
    sessionId?: string;
    statuses?: TerminalSessionStatus[];
  } = {}): TerminalSessionRecord[] {
    const statuses = (params.statuses ?? []).filter((value) => Boolean(value));
    if (!params.workspaceId) {
      const sessions = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
        let query = `
          SELECT *
          FROM terminal_sessions
          WHERE 1 = 1
        `;
        const values: string[] = [];
        if (params.sessionId) {
          query += " AND session_id = ?";
          values.push(params.sessionId);
        }
        if (statuses.length > 0) {
          query += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
          values.push(...statuses);
        }
        query += " ORDER BY datetime(last_activity_at) DESC, datetime(created_at) DESC, terminal_id DESC";
        const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
        return rows.map((row) => this.rowToTerminalSession(row));
      });
      sessions.sort((left, right) => {
        const activityCompare = right.lastActivityAt.localeCompare(left.lastActivityAt);
        if (activityCompare !== 0) {
          return activityCompare;
        }
        const createdAtCompare = right.createdAt.localeCompare(left.createdAt);
        if (createdAtCompare !== 0) {
          return createdAtCompare;
        }
        return right.terminalId.localeCompare(left.terminalId);
      });
      return sessions;
    }
    let query = `
      SELECT *
      FROM terminal_sessions
      WHERE 1 = 1
    `;
    const values: string[] = [];
    query += " AND workspace_id = ?";
    values.push(params.workspaceId);
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (statuses.length > 0) {
      query += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
      values.push(...statuses);
    }
    query += " ORDER BY datetime(last_activity_at) DESC, datetime(created_at) DESC, terminal_id DESC";
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTerminalSession(row));
  }

  updateTerminalSession(params: {
    workspaceId: string;
    terminalId: string;
    title?: string | null;
    status?: TerminalSessionStatus;
    exitCode?: number | null;
    lastActivityAt?: string;
    endedAt?: string | null;
    metadata?: Record<string, unknown> | null;
  }): TerminalSessionRecord {
    const existing = this.getTerminalSession({ workspaceId: params.workspaceId, terminalId: params.terminalId });
    if (!existing) {
      throw new Error(`terminal session ${params.terminalId} not found`);
    }
    const nextTitle = params.title !== undefined ? params.title ?? "" : existing.title;
    const nextStatus = params.status ?? existing.status;
    const nextExitCode = params.exitCode !== undefined ? params.exitCode : existing.exitCode;
    const nextLastActivityAt = params.lastActivityAt ?? utcNowIso();
    const nextEndedAt = params.endedAt !== undefined ? params.endedAt : existing.endedAt;
    const nextMetadata = params.metadata !== undefined ? params.metadata ?? {} : existing.metadata;

    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    workspaceDb
      .prepare(`
        UPDATE terminal_sessions
        SET title = ?,
            status = ?,
            exit_code = ?,
            last_activity_at = ?,
            ended_at = ?,
            metadata = ?
        WHERE terminal_id = ?
      `)
      .run(
        nextTitle,
        nextStatus,
        nextExitCode,
        nextLastActivityAt,
        nextEndedAt,
        JSON.stringify(nextMetadata),
        params.terminalId
      );

    const row = workspaceDb
      .prepare<[string], Record<string, unknown>>("SELECT * FROM terminal_sessions WHERE terminal_id = ? LIMIT 1")
      .get(params.terminalId);
    if (!row) {
      throw new Error(`terminal session ${params.terminalId} disappeared during update`);
    }
    return this.rowToTerminalSession(row);
  }

  appendTerminalSessionEvent(params: {
    workspaceId: string;
    terminalId: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt?: string;
    status?: TerminalSessionStatus;
    exitCode?: number | null;
    endedAt?: string | null;
  }): TerminalSessionEventRecord {
    const createdAt = params.createdAt ?? utcNowIso();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const transaction = workspaceDb.transaction(() => {
      const row = workspaceDb
        .prepare<[string], Record<string, unknown>>("SELECT * FROM terminal_sessions WHERE terminal_id = ? LIMIT 1")
        .get(params.terminalId);
      if (!row) {
        throw new Error(`terminal session ${params.terminalId} not found`);
      }
      const session = this.rowToTerminalSession(row);
      const nextSequence = session.lastEventSeq + 1;
      workspaceDb
        .prepare(`
          INSERT INTO terminal_session_events (
              terminal_id, workspace_id, session_id, sequence, event_type, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.terminalId,
          session.workspaceId,
          session.sessionId,
          nextSequence,
          params.eventType,
          JSON.stringify(params.payload),
          createdAt
        );
      workspaceDb
        .prepare(`
          UPDATE terminal_sessions
          SET last_event_seq = ?,
              status = ?,
              exit_code = ?,
              last_activity_at = ?,
              ended_at = ?
          WHERE terminal_id = ?
        `)
        .run(
          nextSequence,
          params.status ?? session.status,
          params.exitCode !== undefined ? params.exitCode : session.exitCode,
          createdAt,
          params.endedAt !== undefined ? params.endedAt : session.endedAt,
          session.terminalId
        );
      const eventRow = workspaceDb
        .prepare<[string, number], Record<string, unknown>>(
          "SELECT * FROM terminal_session_events WHERE terminal_id = ? AND sequence = ? LIMIT 1"
        )
        .get(session.terminalId, nextSequence);
      if (!eventRow) {
        throw new Error(`terminal session event ${session.terminalId}:${nextSequence} was not created`);
      }
      return this.rowToTerminalSessionEvent(eventRow);
    });
    return transaction();
  }

  listTerminalSessionEvents(params: {
    workspaceId: string;
    terminalId: string;
    afterSequence?: number;
    limit?: number;
  }): TerminalSessionEventRecord[] {
    let query = `
      SELECT *
      FROM terminal_session_events
      WHERE terminal_id = ?
        AND sequence > ?
      ORDER BY sequence ASC
    `;
    const values: Array<string | number> = [params.terminalId, params.afterSequence ?? 0];
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      query += " LIMIT ?";
      values.push(Math.trunc(params.limit));
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTerminalSessionEvent(row));
  }

  upsertTurnResult(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    startedAt: string;
    completedAt?: string | null;
    status: string;
    stopReason?: string | null;
    assistantText?: string;
    toolUsageSummary?: Record<string, unknown> | null;
    permissionDenials?: Array<Record<string, unknown>> | null;
    promptSectionIds?: string[] | null;
    capabilityManifestFingerprint?: string | null;
    requestSnapshotFingerprint?: string | null;
    promptCacheProfile?: Record<string, unknown> | null;
    contextBudgetDecisions?: Record<string, unknown> | null;
    tokenUsage?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }): TurnResultRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );

    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const existing = this.getTurnResult({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    workspaceDb
      .prepare(`
        INSERT INTO turn_results (
            workspace_id,
            session_id,
            input_id,
            started_at,
            completed_at,
            status,
            stop_reason,
            assistant_text,
            tool_usage_summary,
            permission_denials,
            prompt_section_ids,
            capability_manifest_fingerprint,
            request_snapshot_fingerprint,
            prompt_cache_profile,
            context_budget_decisions,
            token_usage,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(input_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            session_id = excluded.session_id,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            status = excluded.status,
            stop_reason = excluded.stop_reason,
            assistant_text = excluded.assistant_text,
            tool_usage_summary = excluded.tool_usage_summary,
            permission_denials = excluded.permission_denials,
            prompt_section_ids = excluded.prompt_section_ids,
            capability_manifest_fingerprint = excluded.capability_manifest_fingerprint,
            request_snapshot_fingerprint = excluded.request_snapshot_fingerprint,
            prompt_cache_profile = excluded.prompt_cache_profile,
            context_budget_decisions = excluded.context_budget_decisions,
            token_usage = excluded.token_usage,
            updated_at = excluded.updated_at
      `)
      .run(
        params.workspaceId,
        params.sessionId,
        params.inputId,
        params.startedAt,
        params.completedAt ?? null,
        params.status,
        params.stopReason ?? null,
        params.assistantText ?? "",
        JSON.stringify(params.toolUsageSummary ?? {}),
        JSON.stringify(params.permissionDenials ?? []),
        JSON.stringify(params.promptSectionIds ?? []),
        params.capabilityManifestFingerprint ?? null,
        params.requestSnapshotFingerprint ?? null,
        params.promptCacheProfile ? JSON.stringify(params.promptCacheProfile) : null,
        params.contextBudgetDecisions
          ? JSON.stringify(params.contextBudgetDecisions)
          : null,
        params.tokenUsage ? JSON.stringify(params.tokenUsage) : null,
        createdAt,
        now
      );

    const record = this.getTurnResult({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
    if (!record) {
      throw new Error("turn result row not found after upsert");
    }
    return record;
  }

  getTurnResult(params: { workspaceId: string; inputId: string }): TurnResultRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM turn_results WHERE input_id = ? LIMIT 1")
      .get(params.inputId);
    return row ? this.rowToTurnResult(row) : null;
  }

  updateTurnResultContextBudgetDecisions(params: {
    workspaceId: string;
    inputId: string;
    contextBudgetDecisions: Record<string, unknown> | null;
    updatedAt?: string;
  }): TurnResultRecord | null {
    const now = params.updatedAt ?? utcNowIso();
    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string | null, string, string]>(
        `
          UPDATE turn_results
          SET context_budget_decisions = ?,
              updated_at = ?
          WHERE input_id = ?
        `
      )
      .run(params.contextBudgetDecisions ? JSON.stringify(params.contextBudgetDecisions) : null, now, params.inputId);
    if (result.changes === 0) {
      return null;
    }
    return this.getTurnResult({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
  }

  countTurnResults(params: { workspaceId: string; sessionId: string; inputId?: string; status?: string }): number {
    let query = `
      SELECT COUNT(*) AS total
      FROM turn_results
      WHERE workspace_id = ?
        AND session_id = ?
    `;
    const values: string[] = [params.workspaceId, params.sessionId];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  listTurnResults(params: {
    workspaceId: string;
    sessionId: string;
    inputId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): TurnResultRecord[] {
    let query = `
      SELECT *
      FROM turn_results
      WHERE workspace_id = ?
        AND session_id = ?
    `;
    const values: Array<string | number> = [params.workspaceId, params.sessionId];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    query += `
      ORDER BY datetime(COALESCE(completed_at, started_at)) DESC, created_at DESC, input_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTurnResult(row));
  }

  getRuntimeUserProfile(params: { profileId?: string } = {}): RuntimeUserProfileRecord | null {
    const row = this.controlPlaneDb()
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM runtime_user_profiles WHERE profile_id = ? LIMIT 1"
      )
      .get(params.profileId ?? "default");
    return row ? this.rowToRuntimeUserProfile(row) : null;
  }

  upsertRuntimeUserProfile(params: {
    profileId?: string;
    name?: string | null;
    nameSource?: RuntimeUserProfileNameSource | null;
    createdAt?: string;
    updatedAt?: string;
  }): RuntimeUserProfileRecord {
    const profileId = (params.profileId ?? "default").trim() || "default";
    const existing = this.getRuntimeUserProfile({ profileId });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    const normalizedName = typeof params.name === "string" ? params.name.trim() : "";
    const resolvedName = normalizedName || null;
    const resolvedNameSource = resolvedName
      ? (params.nameSource ?? existing?.nameSource ?? "manual")
      : null;

    this.controlPlaneDb()
      .prepare(`
        INSERT INTO runtime_user_profiles (
            profile_id,
            name,
            name_source,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
            name = excluded.name,
            name_source = excluded.name_source,
            updated_at = excluded.updated_at
      `)
      .run(profileId, resolvedName, resolvedNameSource, createdAt, now);

    const record = this.getRuntimeUserProfile({ profileId });
    if (!record) {
      throw new Error("runtime user profile row not found after upsert");
    }
    return record;
  }

  applyRuntimeUserProfileAuthFallback(params: {
    profileId?: string;
    name: string;
    updatedAt?: string;
  }): RuntimeUserProfileRecord | null {
    const profileId = (params.profileId ?? "default").trim() || "default";
    const normalizedName = params.name.trim();
    if (!normalizedName) {
      return this.getRuntimeUserProfile({ profileId });
    }
    const existing = this.getRuntimeUserProfile({ profileId });
    if (existing?.name?.trim()) {
      return existing;
    }
    return this.upsertRuntimeUserProfile({
      profileId,
      name: normalizedName,
      nameSource: "auth_fallback",
      updatedAt: params.updatedAt,
    });
  }

  upsertMemoryEntry(params: {
    memoryId: string;
    workspaceId?: string | null;
    sessionId?: string | null;
    scope: MemoryEntryScope;
    memoryType: MemoryEntryType;
    subjectKey: string;
    path: string;
    title: string;
    summary: string;
    tags?: string[] | null;
    verificationPolicy: MemoryVerificationPolicy;
    stalenessPolicy: MemoryStalenessPolicy;
    staleAfterSeconds?: number | null;
    sourceTurnInputId?: string | null;
    sourceMessageId?: string | null;
    sourceType?: MemoryEntrySourceType | null;
    observedAt?: string | null;
    lastVerifiedAt?: string | null;
    confidence?: number | null;
    fingerprint: string;
    status?: string;
    supersededAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): MemoryEntryRecord {
    const existing = this.getMemoryEntry({
      memoryId: params.memoryId,
      workspaceId: params.workspaceId ?? null,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    const memoryDb = this.memoryDbForWorkspace(params.workspaceId ?? null);
    memoryDb
      .prepare(`
        INSERT INTO memory_entries (
            memory_id,
            workspace_id,
            session_id,
            scope,
            memory_type,
            subject_key,
            path,
            title,
            summary,
            tags,
            verification_policy,
            staleness_policy,
            stale_after_seconds,
            source_turn_input_id,
            source_message_id,
            source_type,
            observed_at,
            last_verified_at,
            confidence,
            fingerprint,
            status,
            superseded_at,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            session_id = excluded.session_id,
            scope = excluded.scope,
            memory_type = excluded.memory_type,
            subject_key = excluded.subject_key,
            path = excluded.path,
            title = excluded.title,
            summary = excluded.summary,
            tags = excluded.tags,
            verification_policy = excluded.verification_policy,
            staleness_policy = excluded.staleness_policy,
            stale_after_seconds = excluded.stale_after_seconds,
            source_turn_input_id = excluded.source_turn_input_id,
            source_message_id = excluded.source_message_id,
            source_type = excluded.source_type,
            observed_at = excluded.observed_at,
            last_verified_at = excluded.last_verified_at,
            confidence = excluded.confidence,
            fingerprint = excluded.fingerprint,
            status = excluded.status,
            superseded_at = excluded.superseded_at,
            updated_at = excluded.updated_at
      `)
      .run(
        params.memoryId,
        params.workspaceId ?? null,
        params.sessionId ?? null,
        params.scope,
        params.memoryType,
        params.subjectKey,
        params.path,
        params.title,
        params.summary,
        JSON.stringify(params.tags ?? []),
        params.verificationPolicy,
        params.stalenessPolicy,
        params.staleAfterSeconds ?? null,
        params.sourceTurnInputId ?? null,
        params.sourceMessageId ?? null,
        params.sourceType ?? null,
        params.observedAt ?? null,
        params.lastVerifiedAt ?? null,
        params.confidence ?? null,
        params.fingerprint,
        params.status ?? "active",
        params.supersededAt ?? null,
        createdAt,
        now
      );

    const record = this.getMemoryEntry({
      memoryId: params.memoryId,
      workspaceId: params.workspaceId ?? null,
    });
    if (!record) {
      throw new Error("memory entry row not found after upsert");
    }
    return record;
  }

  getMemoryEntry(params: { memoryId: string; workspaceId?: string | null }): MemoryEntryRecord | null {
    const databases = params.workspaceId === undefined
      ? this.listReadableMemoryDbs()
      : [{ workspaceId: params.workspaceId ?? null, db: this.memoryDbForWorkspace(params.workspaceId ?? null) }];
    for (const { db } of databases) {
      const row = db
        .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_entries WHERE memory_id = ? LIMIT 1")
        .get(params.memoryId);
      if (row) {
        return this.rowToMemoryEntry(row);
      }
    }
    return null;
  }

  listMemoryEntries(params: {
    workspaceId?: string | null;
    scope?: string | null;
    memoryType?: string | null;
    status?: string | null;
    limit?: number;
    offset?: number;
  } = {}): MemoryEntryRecord[] {
    const fetchLimit = (params.limit ?? 200) + (params.offset ?? 0);
    const queryRows = (db: Database.Database, limit: number, offset: number): MemoryEntryRecord[] => {
      let query = `
        SELECT *
        FROM memory_entries
        WHERE 1 = 1
      `;
      const values: Array<string | number> = [];
      if (params.workspaceId !== undefined) {
        if (params.workspaceId === null) {
          query += " AND workspace_id IS NULL";
        } else {
          query += " AND workspace_id = ?";
          values.push(params.workspaceId);
        }
      }
      if (params.scope !== undefined) {
        if (params.scope === null) {
          query += " AND scope IS NULL";
        } else {
          query += " AND scope = ?";
          values.push(params.scope);
        }
      }
      if (params.memoryType !== undefined) {
        if (params.memoryType === null) {
          query += " AND memory_type IS NULL";
        } else {
          query += " AND memory_type = ?";
          values.push(params.memoryType);
        }
      }
      if (params.status !== undefined) {
        if (params.status === null) {
          query += " AND status IS NULL";
        } else {
          query += " AND status = ?";
          values.push(params.status);
        }
      }
      query += `
        ORDER BY updated_at DESC, created_at DESC, memory_id ASC
        LIMIT ? OFFSET ?
      `;
      values.push(limit, offset);
      const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToMemoryEntry(row));
    };
    const databases = (() => {
      if (params.workspaceId === null) {
        return [{ workspaceId: null, db: this.controlPlaneDb() }];
      }
      if (typeof params.workspaceId === "string") {
        return [{ workspaceId: params.workspaceId, db: this.workspaceRuntimeDb(params.workspaceId) }];
      }
      if (params.scope === "user") {
        return [{ workspaceId: null, db: this.controlPlaneDb() }];
      }
      if (params.scope && params.scope !== "user") {
        return this.listReadableMemoryDbs({ includeControlPlane: false, includeWorkspace: true });
      }
      return this.listReadableMemoryDbs();
    })();
    if (databases.length === 1) {
      return queryRows(databases[0].db, params.limit ?? 200, params.offset ?? 0);
    }
    const records = databases.flatMap(({ db }) => queryRows(db, fetchLimit, 0));
    records.sort((left, right) => {
      const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      const createdCompare = right.createdAt.localeCompare(left.createdAt);
      if (createdCompare !== 0) {
        return createdCompare;
      }
      return left.memoryId.localeCompare(right.memoryId);
    });
    return records.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 200));
  }

  listWorkspaceMemoryEntryCounts(params: {
    status?: string | null;
  } = {}): Array<{ workspaceId: string; count: number }> {
    const counts = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      let query = `
        SELECT COUNT(*) AS total
        FROM memory_entries
        WHERE scope = 'workspace'
          AND workspace_id = ?
      `;
      const values: Array<string | number> = [workspaceId];
      if (params.status !== undefined) {
        if (params.status === null) {
          query += " AND status IS NULL";
        } else {
          query += " AND status = ?";
          values.push(params.status);
        }
      }
      const row = db.prepare(query).get(...values) as { total: number } | undefined;
      const count = Number(row?.total ?? 0);
      return count > 0 ? [{ workspaceId, count }] : [];
    });
    counts.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    return counts;
  }

  getMemoryEmbeddingIndexByMemoryId(params: {
    memoryId: string;
    workspaceId?: string | null;
  }): MemoryEmbeddingIndexRecord | null {
    const databases = params.workspaceId === undefined
      ? this.listReadableMemoryDbs()
      : [{ workspaceId: params.workspaceId ?? null, db: this.memoryDbForWorkspace(params.workspaceId ?? null) }];
    for (const { db } of databases) {
      const row = db
        .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_embedding_index WHERE memory_id = ? LIMIT 1")
        .get(params.memoryId);
      if (row) {
        return this.rowToMemoryEmbeddingIndex(row);
      }
    }
    return null;
  }

  getMemoryEmbeddingIndexByPath(params: {
    path: string;
    workspaceId?: string | null;
  }): MemoryEmbeddingIndexRecord | null {
    const databases = params.workspaceId === undefined
      ? this.listReadableMemoryDbs()
      : [{ workspaceId: params.workspaceId ?? null, db: this.memoryDbForWorkspace(params.workspaceId ?? null) }];
    for (const { db } of databases) {
      const row = db
        .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_embedding_index WHERE path = ? LIMIT 1")
        .get(params.path);
      if (row) {
        return this.rowToMemoryEmbeddingIndex(row);
      }
    }
    return null;
  }

  listMemoryEmbeddingIndexes(params: {
    memoryIds?: string[];
    workspaceId?: string | null;
    scopeBucket?: MemoryEmbeddingScopeBucket | null;
    embeddingModel?: string | null;
    limit?: number;
    offset?: number;
  } = {}): MemoryEmbeddingIndexRecord[] {
    const fetchLimit = (params.limit ?? 5000) + (params.offset ?? 0);
    const queryRows = (db: Database.Database): MemoryEmbeddingIndexRecord[] => {
      let query = `
        SELECT *
        FROM memory_embedding_index
        WHERE 1 = 1
      `;
      const values: Array<string | number> = [];
      if (params.memoryIds && params.memoryIds.length > 0) {
        query += ` AND memory_id IN (${params.memoryIds.map(() => "?").join(", ")})`;
        values.push(...params.memoryIds);
      }
      if (params.workspaceId !== undefined) {
        if (params.workspaceId === null) {
          query += " AND workspace_id IS NULL";
        } else {
          query += " AND workspace_id = ?";
          values.push(params.workspaceId);
        }
      }
      if (params.scopeBucket !== undefined) {
        if (params.scopeBucket === null) {
          query += " AND scope_bucket IS NULL";
        } else {
          query += " AND scope_bucket = ?";
          values.push(params.scopeBucket);
        }
      }
      if (params.embeddingModel !== undefined) {
        if (params.embeddingModel === null) {
          query += " AND embedding_model IS NULL";
        } else {
          query += " AND embedding_model = ?";
          values.push(params.embeddingModel);
        }
      }
      query += `
        ORDER BY vec_rowid ASC
        LIMIT ? OFFSET 0
      `;
      values.push(fetchLimit);
      const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToMemoryEmbeddingIndex(row));
    };
    const databases = (() => {
      if (params.workspaceId === null) {
        return [{ workspaceId: null, db: this.controlPlaneDb() }];
      }
      if (typeof params.workspaceId === "string") {
        return [{ workspaceId: params.workspaceId, db: this.workspaceRuntimeDb(params.workspaceId) }];
      }
      if (params.scopeBucket && params.scopeBucket !== "workspace") {
        return [{ workspaceId: null, db: this.controlPlaneDb() }];
      }
      if (params.scopeBucket === "workspace") {
        return this.listReadableMemoryDbs({ includeControlPlane: false, includeWorkspace: true });
      }
      return this.listReadableMemoryDbs();
    })();
    const records = databases.flatMap(({ db }) => queryRows(db));
    records.sort((left, right) => left.vecRowid - right.vecRowid);
    return records.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 5000));
  }

  upsertMemoryEmbeddingIndex(params: {
    memoryId: string;
    path: string;
    workspaceId: string | null;
    scopeBucket: MemoryEmbeddingScopeBucket;
    memoryType: string;
    contentFingerprint: string;
    embeddingModel: string;
    embeddingDim: number;
    indexedAt?: string;
    updatedAt?: string;
  }): MemoryEmbeddingIndexRecord {
    const existing =
      this.getMemoryEmbeddingIndexByMemoryId({
        memoryId: params.memoryId,
        workspaceId: params.workspaceId,
      }) ??
      this.getMemoryEmbeddingIndexByPath({
        path: params.path,
        workspaceId: params.workspaceId,
      });
    const now = params.updatedAt ?? utcNowIso();
    const indexedAt = existing?.indexedAt ?? params.indexedAt ?? now;
    if (existing && existing.memoryId !== params.memoryId) {
      this.deleteMemoryEmbeddingIndex(existing.memoryId);
    }
    const memoryDb = this.memoryDbForWorkspace(params.workspaceId);
    memoryDb
      .prepare(`
        INSERT INTO memory_embedding_index (
            vec_rowid,
            memory_id,
            path,
            workspace_id,
            scope_bucket,
            memory_type,
            content_fingerprint,
            embedding_model,
            embedding_dim,
            indexed_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
            path = excluded.path,
            workspace_id = excluded.workspace_id,
            scope_bucket = excluded.scope_bucket,
            memory_type = excluded.memory_type,
            content_fingerprint = excluded.content_fingerprint,
            embedding_model = excluded.embedding_model,
            embedding_dim = excluded.embedding_dim,
            indexed_at = excluded.indexed_at,
            updated_at = excluded.updated_at
      `)
      .run(
        existing?.vecRowid ?? null,
        params.memoryId,
        params.path,
        params.workspaceId,
        params.scopeBucket,
        params.memoryType,
        params.contentFingerprint,
        params.embeddingModel,
        params.embeddingDim,
        indexedAt,
        now,
      );
    const record = this.getMemoryEmbeddingIndexByMemoryId({
      memoryId: params.memoryId,
      workspaceId: params.workspaceId,
    });
    if (!record) {
      throw new Error("memory embedding index row not found after upsert");
    }
    return record;
  }

  deleteMemoryEmbeddingIndex(memoryId: string): void {
    const existing = this.getMemoryEmbeddingIndexByMemoryId({ memoryId });
    if (!existing) {
      return;
    }
    const memoryDb = this.memoryDbForWorkspace(existing.workspaceId);
    if (this.#vectorIndexSupported) {
      memoryDb.prepare("DELETE FROM memory_recall_vec WHERE vec_rowid = ?").run(existing.vecRowid);
    }
    memoryDb.prepare("DELETE FROM memory_embedding_index WHERE memory_id = ?").run(memoryId);
  }

  replaceMemoryRecallVector(params: {
    vecRowid: number;
    embedding: Float32Array;
    scopeBucket: MemoryEmbeddingScopeBucket;
    workspaceId: string | null;
    memoryType: string;
  }): void {
    if (!this.#vectorIndexSupported) {
      return;
    }
    const memoryDb = this.memoryDbForWorkspace(params.workspaceId);
    memoryDb.prepare("DELETE FROM memory_recall_vec WHERE vec_rowid = ?").run(params.vecRowid);
    memoryDb
      .prepare(`
        INSERT INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
        VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
      `)
      .run(
        params.vecRowid,
        params.embedding,
        params.scopeBucket,
        params.workspaceId ?? "",
        params.memoryType,
      );
  }

  searchWorkspaceMemoryRecallVectors(params: {
    workspaceId: string;
    embedding: Float32Array;
    limit: number;
    memoryTypes?: string[];
  }): MemoryVectorSearchResult[] {
    if (!this.#vectorIndexSupported) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.trunc(params.limit));
    let query = `
      SELECT vec_rowid, distance
      FROM memory_recall_vec
      WHERE embedding MATCH ?
        AND k = ?
        AND scope_bucket = 'workspace'
        AND workspace_id = ?
    `;
    const values: Array<string | number | Float32Array | null> = [params.embedding, normalizedLimit, params.workspaceId];
    if (params.memoryTypes && params.memoryTypes.length > 0) {
      query += ` AND memory_type IN (${params.memoryTypes.map(() => "?").join(", ")})`;
      values.push(...params.memoryTypes);
    }
    const memoryDb = this.memoryDbForWorkspace(params.workspaceId);
    const rows = memoryDb.prepare(query).all(...values) as Array<{ vec_rowid: number; distance: number }>;
    return this.vectorResultsForRows(memoryDb, rows);
  }

  searchUserMemoryRecallVectors(params: {
    embedding: Float32Array;
    limit: number;
    scopeBuckets?: Array<Extract<MemoryEmbeddingScopeBucket, "preference" | "identity">>;
    memoryTypes?: string[];
  }): MemoryVectorSearchResult[] {
    if (!this.#vectorIndexSupported) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.trunc(params.limit));
    const scopeBuckets = (params.scopeBuckets && params.scopeBuckets.length > 0)
      ? params.scopeBuckets
      : ["preference", "identity"];
    let query = `
      SELECT vec_rowid, distance
      FROM memory_recall_vec
      WHERE embedding MATCH ?
        AND k = ?
        AND scope_bucket IN (${scopeBuckets.map(() => "?").join(", ")})
    `;
    const values: Array<string | number | Float32Array | null> = [params.embedding, normalizedLimit, ...scopeBuckets];
    if (params.memoryTypes && params.memoryTypes.length > 0) {
      query += ` AND memory_type IN (${params.memoryTypes.map(() => "?").join(", ")})`;
      values.push(...params.memoryTypes);
    }
    const memoryDb = this.controlPlaneDb();
    const rows = memoryDb.prepare(query).all(...values) as Array<{ vec_rowid: number; distance: number }>;
    return this.vectorResultsForRows(memoryDb, rows);
  }

  upsertTurnRequestSnapshot(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    snapshotKind: string;
    fingerprint: string;
    payload: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }): TurnRequestSnapshotRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );

    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const existing = this.getTurnRequestSnapshot({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    workspaceDb
      .prepare(`
        INSERT INTO turn_request_snapshots (
            workspace_id,
            session_id,
            input_id,
            snapshot_kind,
            fingerprint,
            payload,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(input_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            session_id = excluded.session_id,
            snapshot_kind = excluded.snapshot_kind,
            fingerprint = excluded.fingerprint,
            payload = excluded.payload,
            updated_at = excluded.updated_at
      `)
      .run(
        params.workspaceId,
        params.sessionId,
        params.inputId,
        params.snapshotKind,
        params.fingerprint,
        JSON.stringify(params.payload),
        createdAt,
        now
      );

    const record = this.getTurnRequestSnapshot({
      workspaceId: params.workspaceId,
      inputId: params.inputId,
    });
    if (!record) {
      throw new Error("turn request snapshot row not found after upsert");
    }
    return record;
  }

  getTurnRequestSnapshot(params: { workspaceId: string; inputId: string }): TurnRequestSnapshotRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM turn_request_snapshots WHERE input_id = ? LIMIT 1")
      .get(params.inputId);
    return row ? this.rowToTurnRequestSnapshot(row) : null;
  }

  listTurnRequestSnapshots(params: {
    workspaceId: string;
    sessionId: string;
    inputId?: string;
    limit?: number;
    offset?: number;
  }): TurnRequestSnapshotRecord[] {
    let query = `
      SELECT *
      FROM turn_request_snapshots
      WHERE workspace_id = ?
        AND session_id = ?
    `;
    const values: Array<string | number> = [params.workspaceId, params.sessionId];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    query += `
      ORDER BY datetime(updated_at) DESC, created_at DESC, input_id DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTurnRequestSnapshot(row));
  }

  createOutputFolder(params: { workspaceId: string; name: string }): OutputFolderRecord {
    const resolvedId = randomUUID();
    const now = utcNowIso();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const countRow = workspaceDb
      .prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM output_folders WHERE workspace_id = ?")
      .get(params.workspaceId);
    const position = countRow?.count ?? 0;
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO output_folders (
            id, workspace_id, name, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(resolvedId, params.workspaceId, params.name, position, now, now);
    });
    const row = workspaceDb
      .prepare<[string], Record<string, unknown>>("SELECT * FROM output_folders WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("output folder row not found after insert");
    }
    return this.rowToOutputFolder(row);
  }

  listOutputFolders(params: { workspaceId: string }): OutputFolderRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM output_folders
        WHERE workspace_id = ?
        ORDER BY position ASC, datetime(created_at) ASC, id ASC
      `)
      .all(params.workspaceId);
    return rows.map((row) => this.rowToOutputFolder(row));
  }

  updateOutputFolder(params: {
    workspaceId: string;
    folderId: string;
    name?: string | null;
    position?: number | null;
  }): OutputFolderRecord | null {
    const existing = this.getOutputFolder({
      workspaceId: params.workspaceId,
      folderId: params.folderId,
    });
    if (!existing) {
      return null;
    }
    const updatedAt = utcNowIso();
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`
        UPDATE output_folders
        SET name = ?, position = ?, updated_at = ?
        WHERE id = ?
      `).run(params.name ?? existing.name, params.position ?? existing.position, updatedAt, params.folderId);
    });
    return this.getOutputFolder({
      workspaceId: params.workspaceId,
      folderId: params.folderId,
    });
  }

  getOutputFolder(params: { workspaceId: string; folderId: string }): OutputFolderRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM output_folders WHERE id = ? LIMIT 1")
      .get(params.folderId);
    return row ? this.rowToOutputFolder(row) : null;
  }

  deleteOutputFolder(params: { workspaceId: string; folderId: string }): boolean {
    const existing = this.getOutputFolder(params);
    if (!existing) {
      return false;
    }
    const updatedAt = utcNowIso();
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare("UPDATE outputs SET folder_id = NULL, updated_at = ? WHERE folder_id = ?").run(updatedAt, params.folderId);
      db.prepare("DELETE FROM output_folders WHERE id = ?").run(params.folderId);
    });
    return this.getOutputFolder(params) === null;
  }

  createOutput(params: {
    workspaceId: string;
    outputType: string;
    title?: string;
    status?: string;
    moduleId?: string | null;
    moduleResourceId?: string | null;
    filePath?: string | null;
    htmlContent?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    artifactId?: string | null;
    folderId?: string | null;
    platform?: string | null;
    metadata?: Record<string, unknown> | null;
    outputId?: string;
  }): OutputRecord {
    const resolvedId = params.outputId ?? randomUUID();
    const now = utcNowIso();
    const metadataJson = JSON.stringify(params.metadata ?? {});
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO outputs (
            id, workspace_id, output_type, title, status, module_id, module_resource_id, file_path,
            html_content, session_id, input_id, artifact_id, folder_id, platform, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedId,
        params.workspaceId,
        params.outputType,
        params.title ?? "",
        params.status ?? "draft",
        params.moduleId ?? null,
        params.moduleResourceId ?? null,
        params.filePath ?? null,
        params.htmlContent ?? null,
        params.sessionId ?? null,
        params.inputId ?? null,
        params.artifactId ?? null,
        params.folderId ?? null,
        params.platform ?? null,
        metadataJson,
        now,
        now
      );
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM outputs WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("output row not found after insert");
    }
    return this.rowToOutput(row);
  }

  listOutputs(params: {
    workspaceId: string;
    outputType?: string | null;
    status?: string | null;
    platform?: string | null;
    folderId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    limit?: number;
    offset?: number;
  }): OutputRecord[] {
    let query = "SELECT * FROM outputs WHERE workspace_id = ?";
    const values: Array<string | number> = [params.workspaceId];
    if (params.outputType) {
      query += " AND output_type = ?";
      values.push(params.outputType);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    if (params.platform) {
      query += " AND platform = ?";
      values.push(params.platform);
    }
    if (params.folderId) {
      query += " AND folder_id = ?";
      values.push(params.folderId);
    }
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    query += " ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?";
    values.push(params.limit ?? 50, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToOutput(row));
  }

  getOutput(params: { workspaceId: string; outputId: string }): OutputRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM outputs WHERE id = ? LIMIT 1")
      .get(params.outputId);
    return row ? this.rowToOutput(row) : null;
  }

  updateOutput(params: {
    workspaceId: string;
    outputId: string;
    title?: string | null;
    status?: string | null;
    moduleResourceId?: string | null;
    filePath?: string | null;
    htmlContent?: string | null;
    metadata?: Record<string, unknown> | null;
    folderId?: string | null;
  }): OutputRecord | null {
    const existing = this.getOutput({
      workspaceId: params.workspaceId,
      outputId: params.outputId,
    });
    if (!existing) {
      return null;
    }
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`
        UPDATE outputs
        SET title = ?,
            status = ?,
            module_resource_id = ?,
            file_path = ?,
            html_content = ?,
            metadata = ?,
            folder_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.title ?? existing.title,
        params.status ?? existing.status,
        params.moduleResourceId ?? existing.moduleResourceId,
        params.filePath ?? existing.filePath,
        params.htmlContent ?? existing.htmlContent,
        JSON.stringify(params.metadata ?? existing.metadata),
        params.folderId ?? existing.folderId,
        utcNowIso(),
        params.outputId
      );
    });
    return this.getOutput({
      workspaceId: params.workspaceId,
      outputId: params.outputId,
    });
  }

  deleteOutput(params: { workspaceId: string; outputId: string }): boolean {
    const existing = this.getOutput(params);
    if (!existing) {
      return false;
    }
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare("DELETE FROM outputs WHERE id = ?").run(params.outputId);
    });
    return this.getOutput(params) === null;
  }

  getOutputCounts(params: { workspaceId: string }): Record<string, unknown> {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT status, platform, folder_id FROM outputs WHERE workspace_id = ?")
      .all(params.workspaceId);
    const byStatus: Record<string, number> = {};
    const byPlatform: Record<string, number> = {};
    const byFolder: Record<string, number> = {};
    for (const row of rows) {
      const status = row.status == null ? "" : String(row.status);
      const platform = row.platform == null ? "" : String(row.platform);
      const folder = row.folder_id == null ? "" : String(row.folder_id);
      if (status) byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (platform) byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
      if (folder) byFolder[folder] = (byFolder[folder] ?? 0) + 1;
    }
    return {
      total: rows.length,
      by_status: byStatus,
      by_platform: byPlatform,
      by_folder: byFolder
    };
  }

  upsertAppBuild(params: {
    workspaceId: string;
    appId: string;
    status: string;
    error?: string | null;
  }): AppBuildRecord {
    const now = utcNowIso();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const existing = this.getAppBuild({
      workspaceId: params.workspaceId,
      appId: params.appId
    });
    if (existing) {
      const fields: Record<string, string | null> = {
        status: params.status,
        updated_at: now
      };
      if (params.status === "building") {
        fields.started_at = now;
        fields.error = null;
      } else if (params.status === "completed") {
        fields.completed_at = now;
        fields.error = null;
      } else if (params.status === "failed") {
        fields.completed_at = now;
        fields.error = params.error ?? null;
      }
      const setClause = Object.keys(fields)
        .map((column) => `${column} = ?`)
        .join(", ");
      this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
        db.prepare(`UPDATE app_builds SET ${setClause} WHERE workspace_id = ? AND app_id = ?`)
          .run(...Object.values(fields), params.workspaceId, params.appId);
      });
    } else {
      this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
        db.prepare(`
          INSERT INTO app_builds (
              workspace_id, app_id, status, started_at, completed_at, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          params.workspaceId,
          params.appId,
          params.status,
          params.status === "building" ? now : null,
          null,
          params.error ?? null,
          now,
          now
        );
      });
    }
    const row = workspaceDb
      .prepare<[string, string], Record<string, unknown>>(
        "SELECT * FROM app_builds WHERE workspace_id = ? AND app_id = ? LIMIT 1"
      )
      .get(params.workspaceId, params.appId);
    if (!row) {
      throw new Error("app build row not found after upsert");
    }
    return this.rowToAppBuild(row);
  }

  getAppBuild(params: { workspaceId: string; appId: string }): AppBuildRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(
        "SELECT * FROM app_builds WHERE workspace_id = ? AND app_id = ? LIMIT 1"
      )
      .get(params.workspaceId, params.appId);
    return row ? this.rowToAppBuild(row) : null;
  }

  deleteAppBuild(params: { workspaceId: string; appId: string }): boolean {
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare("DELETE FROM app_builds WHERE workspace_id = ? AND app_id = ?").run(params.workspaceId, params.appId);
    });
    return this.getAppBuild(params) === null;
  }

  /** Set the persistent restart-attempts counter for an app build row.
   *  No-op if the build row does not exist. */
  setAppBuildRestartAttempts(params: {
    workspaceId: string;
    appId: string;
    attempts: number;
  }): void {
    const safeAttempts = Math.max(0, Math.floor(params.attempts) || 0);
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(
        "UPDATE app_builds SET restart_attempts = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ?",
      ).run(safeAttempts, utcNowIso(), params.workspaceId, params.appId);
    });
  }

  // --- App Ports ---

  allocateAppPort(params: { workspaceId: string; appId: string }): AppPortRecord {
    const allocate = this.controlPlaneDb().transaction(() => {
      const existing = this.getAppPort({ workspaceId: params.workspaceId, appId: params.appId });
      if (existing) {
        return existing;
      }

      const port = this.findAvailablePort();
      const now = utcNowIso();

      this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
        db.prepare(`
          INSERT OR IGNORE INTO app_ports (workspace_id, app_id, port, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(params.workspaceId, params.appId, port, now, now);
      });

      return this.getAppPort({ workspaceId: params.workspaceId, appId: params.appId })!;
    });
    return allocate();
  }

  getAppPort(params: { workspaceId: string; appId: string }): AppPortRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(
        "SELECT * FROM app_ports WHERE workspace_id = ? AND app_id = ? LIMIT 1"
      )
      .get(params.workspaceId, params.appId);
    return row ? this.rowToAppPort(row) : null;
  }

  listAppPorts(params: { workspaceId: string }): AppPortRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM app_ports WHERE workspace_id = ?"
      )
      .all(params.workspaceId);
    return rows.map((row) => this.rowToAppPort(row));
  }

  listAllAppPorts(): AppPortRecord[] {
    const readableWorkspaceRuntimeDbs = this.listReadableWorkspaceRuntimeDbs();
    const ports = readableWorkspaceRuntimeDbs.flatMap(({ db }) => {
      const rows = db
        .prepare<[], Record<string, unknown>>(
          "SELECT * FROM app_ports"
        )
        .all();
      return rows.map((row) => this.rowToAppPort(row));
    });
    const scannedWorkspaceIds = new Set(
      readableWorkspaceRuntimeDbs.map(({ workspaceId }) => workspaceId),
    );
    for (const workspace of this.listWorkspaces({ includeDeleted: true })) {
      if (!workspace.deletedAtUtc || scannedWorkspaceIds.has(workspace.id)) {
        continue;
      }
      const preservedWorkspacePath = this.resolveDeletedWorkspacePreservedPath(
        workspace.id,
      );
      if (!preservedWorkspacePath) {
        continue;
      }
      const dbPath = workspaceRuntimeDbPathForWorkspacePath(preservedWorkspacePath);
      if (!fs.existsSync(dbPath)) {
        continue;
      }
      const deletedWorkspaceDb = new Database(dbPath, { readonly: true });
      try {
        const rows = deletedWorkspaceDb
          .prepare<[], Record<string, unknown>>("SELECT * FROM app_ports")
          .all();
        ports.push(...rows.map((row) => this.rowToAppPort(row)));
        scannedWorkspaceIds.add(workspace.id);
      } catch {
        // Skip unreadable preserved bundles during aggregate scans.
      } finally {
        deletedWorkspaceDb.close();
      }
    }
    return ports;
  }

  deleteAppPort(params: { workspaceId: string; appId: string }): boolean {
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare("DELETE FROM app_ports WHERE workspace_id = ? AND app_id = ?").run(params.workspaceId, params.appId);
    });
    return this.getAppPort(params) === null;
  }

  // --- App Catalog ---

  upsertAppCatalogEntry(params: {
    appId: string;
    source: "marketplace" | "local";
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    tags: string[];
    version: string | null;
    archiveUrl: string | null;
    archivePath: string | null;
    target: string;
    cachedAt: string;
    providerId: string | null;
    credentialSource: string | null;
  }): AppCatalogEntryRecord {
    const tagsJson = JSON.stringify(params.tags ?? []);
    this.controlPlaneDb().prepare(`
      INSERT INTO app_catalog (
        app_id, source, name, description, icon, category,
        tags_json, version, archive_url, archive_path, target, cached_at,
        provider_id, credential_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, app_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        icon = excluded.icon,
        category = excluded.category,
        tags_json = excluded.tags_json,
        version = excluded.version,
        archive_url = excluded.archive_url,
        archive_path = excluded.archive_path,
        target = excluded.target,
        cached_at = excluded.cached_at,
        provider_id = excluded.provider_id,
        credential_source = excluded.credential_source
    `).run(
      params.appId,
      params.source,
      params.name,
      params.description,
      params.icon,
      params.category,
      tagsJson,
      params.version,
      params.archiveUrl,
      params.archivePath,
      params.target,
      params.cachedAt,
      params.providerId,
      params.credentialSource,
    );
    return {
      appId: params.appId,
      source: params.source,
      name: params.name,
      description: params.description,
      icon: params.icon,
      category: params.category,
      tags: [...(params.tags ?? [])],
      version: params.version,
      archiveUrl: params.archiveUrl,
      archivePath: params.archivePath,
      target: params.target,
      cachedAt: params.cachedAt,
      providerId: params.providerId,
      credentialSource: params.credentialSource,
    };
  }

  listAppCatalogEntries(
    params: { source?: "marketplace" | "local" } = {},
  ): AppCatalogEntryRecord[] {
    const rows = params.source
      ? this.controlPlaneDb()
          .prepare<[string], Record<string, unknown>>(
            "SELECT * FROM app_catalog WHERE source = ? ORDER BY app_id",
          )
          .all(params.source)
      : this.controlPlaneDb()
          .prepare<[], Record<string, unknown>>(
            "SELECT * FROM app_catalog ORDER BY source, app_id",
          )
          .all();
    return rows.map((row) => this.rowToAppCatalog(row));
  }

  clearAppCatalogSource(source: "marketplace" | "local"): number {
    const result = this.controlPlaneDb()
      .prepare("DELETE FROM app_catalog WHERE source = ?")
      .run(source);
    return result.changes;
  }

  deleteAppCatalogEntry(params: { source: string; appId: string }): boolean {
    const result = this.controlPlaneDb()
      .prepare("DELETE FROM app_catalog WHERE source = ? AND app_id = ?")
      .run(params.source, params.appId);
    return result.changes > 0;
  }

  private rowToAppCatalog(row: Record<string, unknown>): AppCatalogEntryRecord {
    let tags: string[] = [];
    const tagsRaw = row.tags_json;
    if (typeof tagsRaw === "string" && tagsRaw.length > 0) {
      try {
        const parsed = JSON.parse(tagsRaw);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === "string");
        }
      } catch {
        tags = [];
      }
    }
    const sourceRaw = row.source == null ? "" : String(row.source);
    const source: "marketplace" | "local" =
      sourceRaw === "marketplace" || sourceRaw === "local" ? sourceRaw : "marketplace";
    return {
      appId: String(row.app_id ?? ""),
      source,
      name: String(row.name ?? ""),
      description: row.description == null ? null : String(row.description),
      icon: row.icon == null ? null : String(row.icon),
      category: row.category == null ? null : String(row.category),
      tags,
      version: row.version == null ? null : String(row.version),
      archiveUrl: row.archive_url == null ? null : String(row.archive_url),
      archivePath: row.archive_path == null ? null : String(row.archive_path),
      target: String(row.target ?? ""),
      cachedAt: String(row.cached_at ?? ""),
      providerId: row.provider_id == null ? null : String(row.provider_id),
      credentialSource:
        row.credential_source == null ? null : String(row.credential_source),
    };
  }

  private findAvailablePort(): number {
    const BASE_PORT = 38080;
    const MAX_PORT = 38979;

    const allocated = new Set(this.listAllAppPorts().map((record) => record.port));

    for (let port = BASE_PORT; port <= MAX_PORT; port++) {
      if (!allocated.has(port)) {
        return port;
      }
    }
    throw new Error(`No available ports in range ${BASE_PORT}-${MAX_PORT}`);
  }

  private rowToAppPort(row: Record<string, unknown>): AppPortRecord {
    return {
      workspaceId: String(row.workspace_id ?? ""),
      appId: String(row.app_id ?? ""),
      port: Number(row.port ?? 0),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  createCronjob(params: {
    workspaceId: string;
    initiatedBy: string;
    cron: string;
    description: string;
    instruction?: string;
    delivery: Record<string, unknown>;
    enabled?: boolean;
    metadata?: Record<string, unknown> | null;
    name?: string;
    jobId?: string;
    nextRunAt?: string | null;
  }): CronjobRecord {
    const resolvedId = params.jobId ?? randomUUID();
    const now = utcNowIso();
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO cronjobs (
            id, workspace_id, initiated_by, name, cron, description, instruction, enabled, delivery, metadata,
            last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, ?, ?)
      `).run(
        resolvedId,
        params.workspaceId,
        params.initiatedBy,
        params.name ?? "",
        params.cron,
        params.description,
        params.instruction ?? params.description,
        params.enabled === false ? 0 : 1,
        JSON.stringify(params.delivery),
        JSON.stringify(params.metadata ?? {}),
        params.nextRunAt ?? null,
        now,
        now
      );
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM cronjobs WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("cronjob row not found after insert");
    }
    return this.rowToCronjob(row);
  }

  getCronjob(params: { workspaceId: string; jobId: string }): CronjobRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM cronjobs WHERE id = ? LIMIT 1")
      .get(params.jobId);
    return row ? this.rowToCronjob(row) : null;
  }

  listCronjobs(params: { workspaceId?: string | null; enabledOnly?: boolean }): CronjobRecord[] {
    if (!params.workspaceId) {
      const jobs = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
        let query = "SELECT * FROM cronjobs";
        if (params.enabledOnly) {
          query += " WHERE enabled = 1";
        }
        query += " ORDER BY datetime(created_at) ASC, id ASC";
        const rows = db.prepare(query).all() as Array<Record<string, unknown>>;
        return rows.map((row) => this.rowToCronjob(row));
      });
      jobs.sort((left, right) => {
        const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
        if (createdAtCompare !== 0) {
          return createdAtCompare;
        }
        return left.id.localeCompare(right.id);
      });
      return jobs;
    }
    let query = "SELECT * FROM cronjobs";
    const filters: string[] = [];
    const values: string[] = [];
    if (params.workspaceId) {
      filters.push("workspace_id = ?");
      values.push(params.workspaceId);
    }
    if (params.enabledOnly) {
      filters.push("enabled = 1");
    }
    if (filters.length > 0) {
      query += ` WHERE ${filters.join(" AND ")}`;
    }
    query += " ORDER BY datetime(created_at) ASC, id ASC";
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToCronjob(row));
  }

  updateCronjob(params: {
    workspaceId: string;
    jobId: string;
    name?: string | null;
    cron?: string | null;
    description?: string | null;
    instruction?: string | null;
    enabled?: boolean | null;
    delivery?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    lastRunAt?: string | null;
    nextRunAt?: string | null;
    runCount?: number | null;
    lastStatus?: string | null;
    lastError?: string | null;
  }): CronjobRecord | null {
    const existing = this.getCronjob({
      workspaceId: params.workspaceId,
      jobId: params.jobId,
    });
    if (!existing) {
      return null;
    }
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`
        UPDATE cronjobs
        SET name = ?,
            cron = ?,
            description = ?,
            instruction = ?,
            enabled = ?,
            delivery = ?,
            metadata = ?,
            last_run_at = ?,
            next_run_at = ?,
            run_count = ?,
            last_status = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.name ?? existing.name,
        params.cron ?? existing.cron,
        params.description ?? existing.description,
        params.instruction ?? existing.instruction,
        params.enabled == null ? (existing.enabled ? 1 : 0) : params.enabled ? 1 : 0,
        JSON.stringify(params.delivery ?? existing.delivery),
        JSON.stringify(params.metadata ?? existing.metadata),
        params.lastRunAt === undefined ? existing.lastRunAt : params.lastRunAt,
        params.nextRunAt === undefined ? existing.nextRunAt : params.nextRunAt,
        params.runCount ?? existing.runCount,
        params.lastStatus === undefined ? existing.lastStatus : params.lastStatus,
        params.lastError === undefined ? existing.lastError : params.lastError,
        utcNowIso(),
        params.jobId
      );
    });
    return this.getCronjob({
      workspaceId: params.workspaceId,
      jobId: params.jobId,
    });
  }

  deleteCronjob(params: { workspaceId: string; jobId: string }): boolean {
    const existing = this.getCronjob(params);
    if (!existing) {
      return false;
    }
    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare("DELETE FROM cronjobs WHERE id = ?").run(params.jobId);
    });
    return this.getCronjob(params) === null;
  }

  createRuntimeNotification(params: {
    workspaceId: string;
    cronjobId?: string | null;
    sourceType?: string | null;
    sourceLabel?: string | null;
    title: string;
    message: string;
    level?: RuntimeNotificationLevel | null;
    priority?: RuntimeNotificationPriority | null;
    state?: RuntimeNotificationState | null;
    metadata?: Record<string, unknown> | null;
    notificationId?: string;
    createdAt?: string;
    readAt?: string | null;
    dismissedAt?: string | null;
  }): RuntimeNotificationRecord {
    const resolvedId = params.notificationId ?? randomUUID();
    const now = params.createdAt ?? utcNowIso();
    const level = this.normalizedNotificationLevel(params.level);
    const priority = this.normalizedNotificationPriority(params.priority);
    const state = this.normalizedNotificationState(params.state);
    const readAt =
      params.readAt !== undefined
        ? params.readAt
        : state === "read" || state === "dismissed"
          ? now
          : null;
    const dismissedAt =
      params.dismissedAt !== undefined ? params.dismissedAt : state === "dismissed" ? now : null;

    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO runtime_notifications (
            id, workspace_id, cronjob_id, source_type, source_label, title, message, level, priority, state,
            metadata, read_at, dismissed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedId,
        params.workspaceId,
        this.normalizedNullableText(params.cronjobId),
        this.normalizedNullableText(params.sourceType) ?? "system",
        this.normalizedNullableText(params.sourceLabel),
        params.title.trim(),
        params.message.trim(),
        level,
        priority,
        state,
        JSON.stringify(params.metadata ?? {}),
        readAt,
        dismissedAt,
        now,
        now
      );
    });

    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM runtime_notifications WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("runtime notification row not found after insert");
    }
    return this.rowToRuntimeNotification(row);
  }

  getRuntimeNotification(params: { workspaceId: string; notificationId: string }): RuntimeNotificationRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM runtime_notifications WHERE id = ? LIMIT 1")
      .get(params.notificationId);
    return row ? this.rowToRuntimeNotification(row) : null;
  }

  listRuntimeNotifications(params: {
    workspaceId?: string | null;
    includeDismissed?: boolean;
    limit?: number | null;
    sourceType?: string | null;
    excludeSourceTypes?: string[] | null;
  }): RuntimeNotificationRecord[] {
    if (!params.workspaceId) {
      const notifications = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db }) => {
        let query = "SELECT * FROM runtime_notifications";
        const filters: string[] = [];
        const values: Array<string | number> = [];
        const normalizedSourceType = this.normalizedNullableText(params.sourceType);
        if (normalizedSourceType) {
          filters.push("source_type = ?");
          values.push(normalizedSourceType);
        }
        if (!params.includeDismissed) {
          filters.push("state != 'dismissed'");
        }
        const excludedSourceTypes =
          params.excludeSourceTypes
            ?.map((value) => this.normalizedNullableText(value))
            .filter((value): value is string => Boolean(value)) ?? [];
        if (excludedSourceTypes.length > 0) {
          filters.push(
            `coalesce(source_type, '') NOT IN (${excludedSourceTypes
              .map(() => "?")
              .join(", ")})`,
          );
          values.push(...excludedSourceTypes);
        }
        if (filters.length > 0) {
          query += ` WHERE ${filters.join(" AND ")}`;
        }
        query += " ORDER BY datetime(created_at) DESC, id DESC";
        const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
        return rows.map((row) => this.rowToRuntimeNotification(row));
      });
      notifications.sort((left, right) => {
        const priorityCompare =
          this.notificationPriorityWeight(right.priority) -
          this.notificationPriorityWeight(left.priority);
        if (priorityCompare !== 0) {
          return priorityCompare;
        }
        const createdAtCompare = right.createdAt.localeCompare(left.createdAt);
        if (createdAtCompare !== 0) {
          return createdAtCompare;
        }
        return right.id.localeCompare(left.id);
      });
      if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
        return notifications.slice(0, Math.floor(params.limit));
      }
      return notifications;
    }
    let query = "SELECT * FROM runtime_notifications";
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (params.workspaceId) {
      filters.push("workspace_id = ?");
      values.push(params.workspaceId);
    }
    const normalizedSourceType = this.normalizedNullableText(params.sourceType);
    if (normalizedSourceType) {
      filters.push("source_type = ?");
      values.push(normalizedSourceType);
    }
    if (!params.includeDismissed) {
      filters.push("state != 'dismissed'");
    }
    const excludedSourceTypes =
      params.excludeSourceTypes
        ?.map((value) => this.normalizedNullableText(value))
        .filter((value): value is string => Boolean(value)) ?? [];
    if (excludedSourceTypes.length > 0) {
      filters.push(
        `coalesce(source_type, '') NOT IN (${excludedSourceTypes
          .map(() => "?")
          .join(", ")})`,
      );
      values.push(...excludedSourceTypes);
    }
    if (filters.length > 0) {
      query += ` WHERE ${filters.join(" AND ")}`;
    }
    query += ` ORDER BY ${this.notificationPrioritySortSql()} DESC, datetime(created_at) DESC, id DESC`;
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      query += " LIMIT ?";
      values.push(Math.floor(params.limit));
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRuntimeNotification(row));
  }

  updateRuntimeNotification(params: {
    workspaceId: string;
    notificationId: string;
    title?: string | null;
    message?: string | null;
    level?: RuntimeNotificationLevel | null;
    priority?: RuntimeNotificationPriority | null;
    state?: RuntimeNotificationState | null;
    metadata?: Record<string, unknown> | null;
    readAt?: string | null;
    dismissedAt?: string | null;
    sourceLabel?: string | null;
  }): RuntimeNotificationRecord | null {
    const existing = this.getRuntimeNotification({
      workspaceId: params.workspaceId,
      notificationId: params.notificationId,
    });
    if (!existing) {
      return null;
    }

    const now = utcNowIso();
    const nextState = params.state == null ? existing.state : this.normalizedNotificationState(params.state);
    const nextReadAt =
      params.readAt !== undefined
        ? params.readAt
        : nextState === "unread"
          ? null
          : existing.readAt ?? now;
    const nextDismissedAt =
      params.dismissedAt !== undefined
        ? params.dismissedAt
        : nextState === "dismissed"
          ? existing.dismissedAt ?? now
          : null;

    this.mirrorWorkspaceRuntimeMutation(existing.workspaceId, (db) => {
      db.prepare(`
        UPDATE runtime_notifications
        SET source_label = ?,
            title = ?,
            message = ?,
            level = ?,
            priority = ?,
            state = ?,
            metadata = ?,
            read_at = ?,
            dismissed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.sourceLabel === undefined ? existing.sourceLabel : this.normalizedNullableText(params.sourceLabel),
        params.title == null ? existing.title : params.title.trim(),
        params.message == null ? existing.message : params.message.trim(),
        params.level == null ? existing.level : this.normalizedNotificationLevel(params.level),
        params.priority == null ? existing.priority : this.normalizedNotificationPriority(params.priority),
        nextState,
        JSON.stringify(params.metadata ?? existing.metadata),
        nextReadAt,
        nextDismissedAt,
        now,
        params.notificationId
      );
    });

    return this.getRuntimeNotification({
      workspaceId: params.workspaceId,
      notificationId: params.notificationId,
    });
  }

  createTaskProposal(params: {
    proposalId: string;
    workspaceId: string;
    taskName: string;
    taskPrompt: string;
    taskGenerationRationale: string;
    proposalSource?: TaskProposalSource | string;
    sourceEventIds?: string[];
    createdAt: string;
    state?: string;
  }): TaskProposalRecord {
    const proposalSource = normalizeTaskProposalSource(params.proposalSource);
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO task_proposals (
            proposal_id,
            workspace_id,
            task_name,
            task_prompt,
            task_generation_rationale,
            proposal_source,
            source_event_ids,
            created_at,
            state,
            accepted_session_id,
            accepted_input_id,
            accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        params.proposalId,
        params.workspaceId,
        params.taskName,
        params.taskPrompt,
        params.taskGenerationRationale,
        proposalSource,
        JSON.stringify(params.sourceEventIds ?? []),
        params.createdAt,
        params.state ?? "not_reviewed"
      );
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM task_proposals WHERE proposal_id = ? LIMIT 1")
      .get(params.proposalId);
    if (!row) {
      throw new Error("task proposal row not found after insert");
    }
    return this.rowToTaskProposal(row);
  }

  getTaskProposal(params: { workspaceId: string; proposalId: string }): TaskProposalRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM task_proposals WHERE proposal_id = ? LIMIT 1")
      .get(params.proposalId);
    return row ? this.rowToTaskProposal(row) : null;
  }

  listTaskProposals(params: { workspaceId: string }): TaskProposalRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM task_proposals
        WHERE workspace_id = ?
        ORDER BY datetime(created_at) DESC, proposal_id DESC
      `)
      .all(params.workspaceId);
    return rows.map((row) => this.rowToTaskProposal(row));
  }

  listUnreviewedTaskProposals(params: { workspaceId: string }): TaskProposalRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM task_proposals
        WHERE workspace_id = ? AND state = 'not_reviewed'
        ORDER BY datetime(created_at) DESC, proposal_id DESC
      `)
      .all(params.workspaceId);
    return rows.map((row) => this.rowToTaskProposal(row));
  }

  updateTaskProposalState(params: { workspaceId: string; proposalId: string; state: string }): TaskProposalRecord | null {
    return this.updateTaskProposal({
      workspaceId: params.workspaceId,
      proposalId: params.proposalId,
      fields: {
        state: params.state
      }
    });
  }

  createEvolveSkillCandidate(params: {
    candidateId: string;
    workspaceId: string;
    sessionId: string;
    inputId: string;
    kind: EvolveSkillCandidateKind;
    status?: EvolveSkillCandidateState;
    taskProposalId?: string | null;
    title: string;
    summary: string;
    slug: string;
    skillPath: string;
    contentFingerprint: string;
    confidence?: number | null;
    evaluationNotes?: string | null;
    sourceTurnInputIds?: string[];
    createdAt?: string;
    updatedAt?: string;
    proposedAt?: string | null;
    dismissedAt?: string | null;
    acceptedAt?: string | null;
    promotedAt?: string | null;
  }): EvolveSkillCandidateRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );
    const createdAt = params.createdAt ?? utcNowIso();
    const updatedAt = params.updatedAt ?? createdAt;
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO evolve_skill_candidates (
            candidate_id,
            workspace_id,
            session_id,
            input_id,
            task_proposal_id,
            kind,
            status,
            title,
            summary,
            slug,
            skill_path,
            content_fingerprint,
            confidence,
            evaluation_notes,
            source_turn_input_ids,
            created_at,
            updated_at,
            proposed_at,
            dismissed_at,
            accepted_at,
            promoted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.candidateId,
        params.workspaceId,
        params.sessionId,
        params.inputId,
        this.normalizedNullableText(params.taskProposalId),
        params.kind,
        params.status ?? "draft",
        params.title,
        params.summary,
        params.slug,
        params.skillPath,
        params.contentFingerprint,
        typeof params.confidence === "number" && Number.isFinite(params.confidence) ? params.confidence : null,
        this.normalizedNullableText(params.evaluationNotes),
        JSON.stringify(params.sourceTurnInputIds ?? []),
        createdAt,
        updatedAt,
        this.normalizedNullableText(params.proposedAt),
        this.normalizedNullableText(params.dismissedAt),
        this.normalizedNullableText(params.acceptedAt),
        this.normalizedNullableText(params.promotedAt)
      );
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM evolve_skill_candidates WHERE candidate_id = ? LIMIT 1")
      .get(params.candidateId);
    if (!row) {
      throw new Error("evolve skill candidate row not found after insert");
    }
    return this.rowToEvolveSkillCandidate(row);
  }

  getEvolveSkillCandidate(params: { workspaceId: string; candidateId: string }): EvolveSkillCandidateRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM evolve_skill_candidates WHERE candidate_id = ? LIMIT 1")
      .get(params.candidateId);
    return row ? this.rowToEvolveSkillCandidate(row) : null;
  }

  getEvolveSkillCandidateByTaskProposalId(params: {
    workspaceId: string;
    proposalId: string;
  }): EvolveSkillCandidateRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM evolve_skill_candidates WHERE task_proposal_id = ? ORDER BY datetime(created_at) DESC, candidate_id DESC LIMIT 1"
      )
      .get(params.proposalId);
    return row ? this.rowToEvolveSkillCandidate(row) : null;
  }

  listEvolveSkillCandidates(params: {
    workspaceId: string;
    sessionId?: string | null;
    inputId?: string | null;
    kind?: EvolveSkillCandidateKind | null;
    status?: EvolveSkillCandidateState | null;
    limit?: number;
    offset?: number;
  }): EvolveSkillCandidateRecord[] {
    let query = "SELECT * FROM evolve_skill_candidates WHERE workspace_id = ?";
    const values: Array<string | number> = [params.workspaceId];
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.kind) {
      query += " AND kind = ?";
      values.push(params.kind);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    query += " ORDER BY datetime(created_at) DESC, candidate_id DESC LIMIT ? OFFSET ?";
    values.push(params.limit ?? 200, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvolveSkillCandidate(row));
  }

  createMemoryUpdateProposal(params: {
    proposalId: string;
    workspaceId: string;
    sessionId: string;
    inputId: string;
    proposalKind: MemoryUpdateProposalKind;
    targetKey: string;
    title: string;
    summary: string;
    payload?: Record<string, unknown> | null;
    evidence?: string | null;
    confidence?: number | null;
    sourceMessageId?: string | null;
    state?: MemoryUpdateProposalState;
    persistedMemoryId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    acceptedAt?: string | null;
    dismissedAt?: string | null;
  }): MemoryUpdateProposalRecord {
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      },
      { touchExisting: false }
    );
    const createdAt = params.createdAt ?? utcNowIso();
    const updatedAt = params.updatedAt ?? createdAt;
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO memory_update_proposals (
            proposal_id,
            workspace_id,
            session_id,
            input_id,
            proposal_kind,
            target_key,
            title,
            summary,
            payload,
            evidence,
            confidence,
            source_message_id,
            state,
            persisted_memory_id,
            created_at,
            updated_at,
            accepted_at,
            dismissed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.proposalId,
        params.workspaceId,
        params.sessionId,
        params.inputId,
        params.proposalKind,
        params.targetKey,
        params.title,
        params.summary,
        JSON.stringify(params.payload ?? {}),
        this.normalizedNullableText(params.evidence),
        params.confidence ?? null,
        this.normalizedNullableText(params.sourceMessageId),
        params.state ?? "pending",
        this.normalizedNullableText(params.persistedMemoryId),
        createdAt,
        updatedAt,
        this.normalizedNullableText(params.acceptedAt),
        this.normalizedNullableText(params.dismissedAt)
      );
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_update_proposals WHERE proposal_id = ? LIMIT 1")
      .get(params.proposalId);
    if (!row) {
      throw new Error("memory update proposal row not found after insert");
    }
    return this.rowToMemoryUpdateProposal(row);
  }

  getMemoryUpdateProposal(params: { workspaceId: string; proposalId: string }): MemoryUpdateProposalRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_update_proposals WHERE proposal_id = ? LIMIT 1")
      .get(params.proposalId);
    return row ? this.rowToMemoryUpdateProposal(row) : null;
  }

  listMemoryUpdateProposals(params: {
    workspaceId: string;
    sessionId?: string | null;
    inputId?: string | null;
    state?: MemoryUpdateProposalState | null;
    limit?: number;
    offset?: number;
  }): MemoryUpdateProposalRecord[] {
    let query = "SELECT * FROM memory_update_proposals WHERE workspace_id = ?";
    const values: Array<string | number> = [params.workspaceId];
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.state) {
      query += " AND state = ?";
      values.push(params.state);
    }
    query += " ORDER BY datetime(created_at) ASC, proposal_id ASC LIMIT ? OFFSET ?";
    values.push(params.limit ?? 200, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMemoryUpdateProposal(row));
  }

  private db(): Database.Database {
    if (this.#db) {
      return this.#db;
    }

    this.migrateLegacyHostStateDb();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    this.#vectorIndexSupported = this.tryLoadVectorExtension(db);
    this.ensureRuntimeDbSchema(db);
    if (this.controlPlaneDbPath === this.dbPath) {
      this.ensureControlPlaneDbSchema(db);
    }
    this.runPendingMigrations(db);
    this.#db = db;
    return db;
  }

  private controlPlaneDb(): Database.Database {
    if (this.controlPlaneDbPath === this.dbPath) {
      return this.db();
    }
    if (this.#controlPlaneDb) {
      return this.#controlPlaneDb;
    }

    const legacy = this.db();
    fs.mkdirSync(path.dirname(this.controlPlaneDbPath), { recursive: true });
    const db = new Database(this.controlPlaneDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    this.#vectorIndexSupported = this.tryLoadVectorExtension(db) || this.#vectorIndexSupported;
    this.ensureControlPlaneDbSchema(db);
    this.backfillControlPlaneDbFromLegacyRuntimeDb(db, legacy);
    this.#controlPlaneDb = db;
    return db;
  }

  private workspaceRuntimeDb(workspaceId: string): Database.Database {
    const cached = this.#workspaceRuntimeDbs.get(workspaceId);
    const workspaceRecord = this.getWorkspace(workspaceId, { includeDeleted: true });
    if (workspaceRecord?.deletedAtUtc) {
      if (cached) {
        return cached.db;
      }
      const db = new Database(":memory:");
      db.pragma("journal_mode = MEMORY");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");
      this.#vectorIndexSupported = this.tryLoadVectorExtension(db) || this.#vectorIndexSupported;
      this.ensureWorkspaceRuntimeDbSchema(db);
      this.#workspaceRuntimeDbs.set(workspaceId, {
        dbPath: `__deleted__/${workspaceId}`,
        db,
      });
      return db;
    }
    const registeredPath = this.workspacePathFromRegistry(workspaceId);
    const workspacePath = registeredPath ? this.assertWorkspaceFolderHealthy(workspaceId) : this.workspaceDir(workspaceId);
    const dbPath = workspaceRuntimeDbPathForWorkspacePath(workspacePath);
    if (cached && cached.dbPath === dbPath) {
      return cached.db;
    }
    if (cached) {
      cached.db.close();
      this.#workspaceRuntimeDbs.delete(workspaceId);
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    this.#vectorIndexSupported = this.tryLoadVectorExtension(db) || this.#vectorIndexSupported;
    this.ensureWorkspaceRuntimeDbSchema(db);
    this.ensureWorkspaceRuntimeLegacyBackfill(db, workspaceId);
    this.#workspaceRuntimeDbs.set(workspaceId, { dbPath, db });
    return db;
  }

  private mirrorWorkspaceRuntimeMutation(workspaceId: string, mutate: (db: Database.Database) => void): void {
    const workspaceDb = this.workspaceRuntimeDb(workspaceId);
    mutate(workspaceDb);
  }

  private listReadableWorkspaceRuntimeDbs(): Array<{ workspaceId: string; db: Database.Database }> {
    const databases = new Map<string, Database.Database>();
    for (const [workspaceId, entry] of this.#workspaceRuntimeDbs.entries()) {
      databases.set(workspaceId, entry.db);
    }
    for (const workspace of this.listWorkspaces({ includeDeleted: false })) {
      if (databases.has(workspace.id)) {
        continue;
      }
      try {
        databases.set(workspace.id, this.workspaceRuntimeDb(workspace.id));
      } catch {
        // Skip unhealthy or missing workspace bundles during aggregate scans.
      }
    }
    return Array.from(databases.entries()).map(([workspaceId, db]) => ({
      workspaceId,
      db,
    }));
  }

  private resolveDeletedWorkspacePreservedPath(workspaceId: string): string | null {
    const discovered = this.workspacePathMatchesIdentity(
      this.discoverWorkspacePath(workspaceId),
      workspaceId,
    );
    if (discovered) {
      return discovered;
    }
    const storedPath = this.workspacePathFromRegistry(workspaceId);
    if (!storedPath) {
      return null;
    }
    const candidatePath = storedPath.startsWith(
      `${DELETED_WORKSPACE_PATH_TOMBSTONE_PREFIX}/`,
    )
      ? decodeDeletedWorkspacePathTombstone(storedPath, workspaceId)
      : storedPath;
    return this.workspacePathMatchesIdentity(candidatePath, workspaceId);
  }
  private memoryDbForWorkspace(workspaceId?: string | null): Database.Database {
    if (typeof workspaceId === "string" && workspaceId.trim().length > 0) {
      return this.workspaceRuntimeDb(workspaceId);
    }
    return this.controlPlaneDb();
  }

  private listReadableMemoryDbs(params: {
    includeControlPlane?: boolean;
    includeWorkspace?: boolean;
  } = {}): Array<{ workspaceId: string | null; db: Database.Database }> {
    const includeControlPlane = params.includeControlPlane ?? true;
    const includeWorkspace = params.includeWorkspace ?? true;
    const databases: Array<{ workspaceId: string | null; db: Database.Database }> = [];
    if (includeControlPlane) {
      databases.push({ workspaceId: null, db: this.controlPlaneDb() });
    }
    if (includeWorkspace) {
      databases.push(...this.listReadableWorkspaceRuntimeDbs());
    }
    return databases;
  }

  private backfillControlPlaneDbFromLegacyRuntimeDb(
    db: Database.Database,
    legacy: Database.Database,
  ): void {
    if (this.controlPlaneDbPath === this.dbPath) {
      return;
    }
    const tableNames = new Set<string>(
      (legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (tableNames.has("workspaces")) {
      const rows = legacy.prepare("SELECT * FROM workspaces").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO workspaces (
          id,
          workspace_path,
          name,
          status,
          harness,
          error_message,
          onboarding_status,
          onboarding_session_id,
          onboarding_completed_at,
          onboarding_completion_summary,
          onboarding_requested_at,
          onboarding_requested_by,
          created_at,
          updated_at,
          deleted_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.id,
          row.workspace_path,
          row.name,
          row.status,
          row.harness ?? null,
          row.error_message ?? null,
          row.onboarding_status,
          row.onboarding_session_id ?? null,
          row.onboarding_completed_at ?? null,
          row.onboarding_completion_summary ?? null,
          row.onboarding_requested_at ?? null,
          row.onboarding_requested_by ?? null,
          row.created_at ?? null,
          row.updated_at ?? null,
          row.deleted_at_utc ?? null
        );
      }
    }
    if (tableNames.has("runtime_user_profiles")) {
      const rows = legacy.prepare("SELECT * FROM runtime_user_profiles").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO runtime_user_profiles (
          profile_id,
          name,
          name_source,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.profile_id,
          row.name ?? null,
          row.name_source ?? null,
          row.created_at,
          row.updated_at
        );
      }
    }
    if (tableNames.has("integration_connections")) {
      const rows = legacy.prepare("SELECT * FROM integration_connections").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO integration_connections (
          connection_id,
          provider_id,
          owner_user_id,
          account_label,
          account_external_id,
          account_handle,
          account_email,
          auth_mode,
          granted_scopes,
          status,
          secret_ref,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.connection_id,
          row.provider_id,
          row.owner_user_id,
          row.account_label,
          row.account_external_id ?? null,
          row.account_handle ?? null,
          row.account_email ?? null,
          row.auth_mode,
          row.granted_scopes,
          row.status,
          row.secret_ref ?? null,
          row.created_at,
          row.updated_at
        );
      }
    }
    if (tableNames.has("integration_bindings")) {
      const rows = legacy.prepare("SELECT * FROM integration_bindings").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO integration_bindings (
          binding_id,
          workspace_id,
          target_type,
          target_id,
          integration_key,
          connection_id,
          is_default,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.binding_id,
          row.workspace_id,
          row.target_type,
          row.target_id,
          row.integration_key,
          row.connection_id,
          row.is_default,
          row.created_at,
          row.updated_at
        );
      }
    }
    if (tableNames.has("oauth_app_configs")) {
      const rows = legacy.prepare("SELECT * FROM oauth_app_configs").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO oauth_app_configs (
          provider_id,
          client_id,
          client_secret,
          authorize_url,
          token_url,
          scopes,
          redirect_port,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.provider_id,
          row.client_id,
          row.client_secret,
          row.authorize_url,
          row.token_url,
          row.scopes,
          row.redirect_port,
          row.created_at,
          row.updated_at
        );
      }
    }
    if (tableNames.has("app_catalog")) {
      const rows = legacy.prepare("SELECT * FROM app_catalog").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO app_catalog (
          app_id,
          source,
          name,
          description,
          icon,
          category,
          tags_json,
          version,
          archive_url,
          archive_path,
          target,
          cached_at,
          provider_id,
          credential_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.app_id,
          row.source,
          row.name,
          row.description ?? null,
          row.icon ?? null,
          row.category ?? null,
          row.tags_json,
          row.version ?? null,
          row.archive_url ?? null,
          row.archive_path ?? null,
          row.target,
          row.cached_at,
          row.provider_id ?? null,
          row.credential_source ?? null
        );
      }
    }
    this.backfillControlPlaneMemoryTables(db, legacy);
  }

  private backfillWorkspaceRuntimeDbFromLegacyRuntimeDb(
    db: Database.Database,
    legacy: Database.Database,
    workspaceId: string,
  ): void {
    for (const tableName of WORKSPACE_SCOPED_LEGACY_BACKFILL_TABLES) {
      this.backfillWorkspaceScopedTableRows({
        db,
        legacy,
        workspaceId,
        tableName,
      });
    }
    this.backfillWorkspaceScopedMemoryVectors({
      db,
      legacy,
      workspaceId,
    });
  }

  private ensureWorkspaceRuntimeLegacyBackfill(
    db: Database.Database,
    workspaceId: string,
  ): void {
    if (this.workspaceRuntimeLegacyBackfillComplete(db)) {
      return;
    }
    const legacy = this.db();
    const runBackfill = db.transaction(() => {
      this.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb(
        db,
        legacy,
        workspaceId,
      );
      this.markWorkspaceRuntimeLegacyBackfillComplete(db);
    });
    runBackfill();
  }

  private workspaceRuntimeLegacyBackfillComplete(
    db: Database.Database,
  ): boolean {
    if (!this.tableExists(db, "workspace_runtime_metadata")) {
      return false;
    }
    const row = db
      .prepare<[string], { value?: string }>(
        "SELECT value FROM workspace_runtime_metadata WHERE key = ? LIMIT 1",
      )
      .get(WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY);
    return row?.value === "complete";
  }

  private markWorkspaceRuntimeLegacyBackfillComplete(
    db: Database.Database,
  ): void {
    db.prepare(`
      INSERT INTO workspace_runtime_metadata (key, value, updated_at)
      VALUES (?, 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(
      WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY,
      utcNowIso(),
    );
  }

  private backfillControlPlaneMemoryTables(db: Database.Database, legacy: Database.Database): void {
    this.backfillControlPlaneMemoryTableRows({
      db,
      legacy,
      tableName: "memory_entries",
      whereClause: "workspace_id IS NULL",
    });
    this.backfillControlPlaneMemoryTableRows({
      db,
      legacy,
      tableName: "memory_embedding_index",
      whereClause: "workspace_id IS NULL",
    });
    if (!this.#vectorIndexSupported || !this.tableExists(legacy, "memory_recall_vec") || !this.tableExists(db, "memory_recall_vec")) {
      return;
    }
    const rows = legacy
      .prepare(`
        SELECT vec_rowid, embedding, scope_bucket, workspace_id, memory_type
        FROM memory_recall_vec
        WHERE COALESCE(workspace_id, '') = ''
      `)
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return;
    }
    const existingRowIds = new Set<number>(
      (db.prepare("SELECT vec_rowid FROM memory_recall_vec").all() as Array<{ vec_rowid: number }>).map((row) =>
        Number(row.vec_rowid)
      )
    );
    const pendingRows = rows.filter((row) => !existingRowIds.has(Number(row.vec_rowid)));
    if (pendingRows.length === 0) {
      return;
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        insert.run(row.vec_rowid, row.embedding, row.scope_bucket, row.workspace_id, row.memory_type);
      }
    });
    insertMany(pendingRows);
  }

  private backfillWorkspaceScopedTableRows(params: {
    db: Database.Database;
    legacy: Database.Database;
    workspaceId: string;
    tableName: string;
  }): void {
    if (!this.tableExists(params.legacy, params.tableName) || !this.tableExists(params.db, params.tableName)) {
      return;
    }

    const targetColumns = (
      params.db.prepare(`PRAGMA table_info(${params.tableName})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
    if (targetColumns.length === 0) {
      return;
    }
    const legacyColumns = new Set<string>(
      (params.legacy.prepare(`PRAGMA table_info(${params.tableName})`).all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    const sharedColumns = targetColumns.filter((column) => legacyColumns.has(column));
    if (sharedColumns.length === 0) {
      return;
    }

    const rows = params.legacy
      .prepare(`SELECT ${sharedColumns.join(", ")} FROM ${params.tableName} WHERE workspace_id = ?`)
      .all(params.workspaceId) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return;
    }

    const insert = params.db.prepare(`
      INSERT OR IGNORE INTO ${params.tableName} (${sharedColumns.join(", ")})
      VALUES (${sharedColumns.map(() => "?").join(", ")})
    `);
    const insertMany = params.db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        insert.run(...sharedColumns.map((column) => row[column] ?? null));
      }
    });
    insertMany(rows);
  }

  private backfillControlPlaneMemoryTableRows(params: {
    db: Database.Database;
    legacy: Database.Database;
    tableName: "memory_entries" | "memory_embedding_index";
    whereClause: string;
  }): void {
    if (!this.tableExists(params.legacy, params.tableName) || !this.tableExists(params.db, params.tableName)) {
      return;
    }
    const targetColumns = (
      params.db.prepare(`PRAGMA table_info(${params.tableName})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
    if (targetColumns.length === 0) {
      return;
    }
    const legacyColumns = new Set<string>(
      (params.legacy.prepare(`PRAGMA table_info(${params.tableName})`).all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    const sharedColumns = targetColumns.filter((column) => legacyColumns.has(column));
    if (sharedColumns.length === 0) {
      return;
    }
    const rows = params.legacy
      .prepare(`SELECT ${sharedColumns.join(", ")} FROM ${params.tableName} WHERE ${params.whereClause}`)
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return;
    }
    const insert = params.db.prepare(`
      INSERT OR IGNORE INTO ${params.tableName} (${sharedColumns.join(", ")})
      VALUES (${sharedColumns.map(() => "?").join(", ")})
    `);
    const insertMany = params.db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        insert.run(...sharedColumns.map((column) => row[column] ?? null));
      }
    });
    insertMany(rows);
  }

  private backfillWorkspaceScopedMemoryVectors(params: {
    db: Database.Database;
    legacy: Database.Database;
    workspaceId: string;
  }): void {
    if (!this.#vectorIndexSupported || !this.tableExists(params.legacy, "memory_recall_vec") || !this.tableExists(params.db, "memory_recall_vec")) {
      return;
    }
    const rows = params.legacy
      .prepare(`
        SELECT vec_rowid, embedding, scope_bucket, workspace_id, memory_type
        FROM memory_recall_vec
        WHERE scope_bucket = 'workspace'
          AND workspace_id = ?
      `)
      .all(params.workspaceId) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return;
    }
    const existingRowIds = new Set<number>(
      (params.db.prepare("SELECT vec_rowid FROM memory_recall_vec").all() as Array<{ vec_rowid: number }>).map((row) =>
        Number(row.vec_rowid)
      )
    );
    const pendingRows = rows.filter((row) => !existingRowIds.has(Number(row.vec_rowid)));
    if (pendingRows.length === 0) {
      return;
    }
    const insert = params.db.prepare(`
      INSERT OR IGNORE INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `);
    const insertMany = params.db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        insert.run(row.vec_rowid, row.embedding, row.scope_bucket, row.workspace_id, row.memory_type);
      }
    });
    insertMany(pendingRows);
  }

  private runPendingMigrations(db: Database.Database): void {
    if (RUNTIME_DB_MIGRATIONS.length === 0 && LATEST_SEED_VERSION === 0) {
      // No migrations registered yet — skip the runner entirely so we don't
      // even read PRAGMA user_version. Future schema changes opt in by adding
      // a file under src/migrations/ and bumping LATEST_SEED_VERSION when
      // they overlap with the legacy ensure-helpers.
      return;
    }
    const runner = new MigrationRunner(RUNTIME_DB_MIGRATIONS, {
      latestSeedVersion: LATEST_SEED_VERSION,
      log: this.#onMigrationEvent,
    });
    runner.apply(db);
  }

  private ensureWorkspaceMetadataReady(): void {
    void this.controlPlaneDb();
  }

  private migrateLegacyHostStateDb(): void {
    if (!this.usesImplicitHostStatePath || this.dbPath === this.legacyDbPath) {
      return;
    }
    if (fs.existsSync(this.dbPath) || !fs.existsSync(this.legacyDbPath)) {
      return;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const legacyPath = `${this.legacyDbPath}${suffix}`;
      if (!fs.existsSync(legacyPath)) {
        continue;
      }
      const nextPath = `${this.dbPath}${suffix}`;
      if (fs.existsSync(nextPath)) {
        continue;
      }
      try {
        fs.renameSync(legacyPath, nextPath);
      } catch {
        fs.copyFileSync(legacyPath, nextPath);
        fs.unlinkSync(legacyPath);
      }
    }
  }

  private tryLoadVectorExtension(db: Database.Database): boolean {
    try {
      sqliteVec.load(db as unknown as { loadExtension(file: string, entrypoint?: string | undefined): void });
      return true;
    } catch {
      return false;
    }
  }

  private ensureMemoryEmbeddingIndexSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embedding_index (
          vec_rowid INTEGER PRIMARY KEY,
          memory_id TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL UNIQUE,
          workspace_id TEXT,
          scope_bucket TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          content_fingerprint TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_dim INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embedding_index_workspace_scope
          ON memory_embedding_index (workspace_id, scope_bucket, memory_type);

      CREATE INDEX IF NOT EXISTS idx_memory_embedding_index_scope_type
          ON memory_embedding_index (scope_bucket, memory_type);
    `);
    if (!this.#vectorIndexSupported) {
      return;
    }
    const existingColumns = db
      .prepare("SELECT name FROM pragma_table_info('memory_recall_vec')")
      .all() as Array<{ name: string }>;
    if (existingColumns.length > 0 && !existingColumns.some((column) => column.name === "vec_rowid")) {
      db.exec("DROP TABLE IF EXISTS memory_recall_vec;");
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_vec USING vec0(
          vec_rowid INTEGER PRIMARY KEY,
          embedding float[1536],
          scope_bucket TEXT,
          workspace_id TEXT,
          memory_type TEXT
      );
    `);
  }

  private ensureMemoryEntriesTableSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
          memory_id TEXT PRIMARY KEY,
          workspace_id TEXT,
          session_id TEXT,
          scope TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          verification_policy TEXT NOT NULL,
          staleness_policy TEXT NOT NULL DEFAULT 'stable',
          stale_after_seconds INTEGER,
          source_turn_input_id TEXT,
          source_message_id TEXT,
          source_type TEXT,
          observed_at TEXT,
          last_verified_at TEXT,
          confidence REAL,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          superseded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_scope_updated
          ON memory_entries (workspace_id, scope, status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_updated
          ON memory_entries (scope, status, updated_at DESC, created_at DESC);
    `);
  }

  private ensureControlPlaneDbSchema(db: Database.Database): void {
    this.ensureWorkspacesTableSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_user_profiles (
          profile_id TEXT PRIMARY KEY,
          name TEXT,
          name_source TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integration_connections (
          connection_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          account_label TEXT NOT NULL,
          account_external_id TEXT,
          account_handle TEXT,
          account_email TEXT,
          auth_mode TEXT NOT NULL,
          granted_scopes TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          secret_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner_updated
          ON integration_connections (provider_id, owner_user_id, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS integration_bindings (
          binding_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          integration_key TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (workspace_id, target_type, target_id, integration_key),
          FOREIGN KEY (connection_id) REFERENCES integration_connections(connection_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_integration_bindings_workspace_updated
          ON integration_bindings (workspace_id, is_default DESC, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS app_catalog (
          app_id TEXT NOT NULL,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          category TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          version TEXT,
          archive_url TEXT,
          archive_path TEXT,
          target TEXT NOT NULL,
          cached_at TEXT NOT NULL,
          provider_id TEXT,
          credential_source TEXT,
          PRIMARY KEY (source, app_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_catalog_source
          ON app_catalog (source);

      CREATE TABLE IF NOT EXISTS oauth_app_configs (
          provider_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          client_secret TEXT NOT NULL,
          authorize_url TEXT NOT NULL,
          token_url TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          redirect_port INTEGER NOT NULL DEFAULT 38765,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );
    `);
    this.ensureMemoryEntriesTableSchema(db);
    this.ensureMemoryEmbeddingIndexSchema(db);
    this.migrateIntegrationConnectionIdentityColumns(db);
    this.migrateAppCatalogProviderColumns(db);
  }

  private migrateAppCatalogProviderColumns(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tableNames.has("app_catalog")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(app_catalog)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("provider_id")) {
      db.exec("ALTER TABLE app_catalog ADD COLUMN provider_id TEXT;");
    }
    if (!columns.has("credential_source")) {
      db.exec("ALTER TABLE app_catalog ADD COLUMN credential_source TEXT;");
    }
  }

  private ensureWorkspaceRuntimeDbSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_runtime_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'workspace_session',
          title TEXT,
          parent_session_id TEXT,
          source_proposal_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          PRIMARY KEY (workspace_id, session_id),
          UNIQUE (workspace_id, source_proposal_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_updated
          ON agent_sessions (workspace_id, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          harness_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, session_id),
          UNIQUE (workspace_id, harness, harness_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runtime_sessions_workspace_updated
          ON agent_runtime_sessions (workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_bindings (
          binding_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'main',
          is_active INTEGER NOT NULL DEFAULT 1,
          metadata TEXT NOT NULL DEFAULT '{}',
          last_active_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (workspace_id, channel, conversation_key, role),
          UNIQUE (session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_workspace_role_active_updated
          ON conversation_bindings (workspace_id, role, is_active, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_channel_key_active
          ON conversation_bindings (channel, conversation_key, is_active);

      CREATE TABLE IF NOT EXISTS agent_session_inputs (
          input_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT,
          claimed_by TEXT,
          claimed_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_session_inputs_workspace_created
          ON agent_session_inputs (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_session_inputs_session_status
          ON agent_session_inputs (session_id, status, available_at);

      CREATE TABLE IF NOT EXISTS post_run_jobs (
          job_id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          input_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT,
          claimed_by TEXT,
          claimed_until TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_post_run_jobs_workspace_created
          ON post_run_jobs (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_post_run_jobs_session_status
          ON post_run_jobs (session_id, status, available_at);

      CREATE TABLE IF NOT EXISTS main_session_event_queue (
          event_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          owner_main_session_id TEXT NOT NULL,
          origin_main_session_id TEXT NOT NULL,
          subagent_id TEXT,
          event_type TEXT NOT NULL,
          delivery_bucket TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL DEFAULT '{}',
          coalesce_key TEXT,
          earliest_deliver_at TEXT,
          latest_deliver_at TEXT,
          materialized_input_id TEXT,
          superseded_by_event_id TEXT,
          delivered_at TEXT,
          superseded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_owner_status_earliest
          ON main_session_event_queue (owner_main_session_id, status, earliest_deliver_at, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_workspace_status_created
          ON main_session_event_queue (workspace_id, status, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_subagent_created
          ON main_session_event_queue (subagent_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_materialized_input
          ON main_session_event_queue (materialized_input_id);

      CREATE TABLE IF NOT EXISTS session_runtime_state (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${SESSION_RUNTIME_STATE_STATUS_SQL})),
          current_input_id TEXT,
          current_worker_id TEXT,
          lease_until TEXT,
          heartbeat_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS session_runtime_state_workspace_session_idx
          ON session_runtime_state (workspace_id, session_id);

      CREATE INDEX IF NOT EXISTS session_runtime_state_session_id_idx
          ON session_runtime_state (session_id);

      CREATE TABLE IF NOT EXISTS session_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_workspace_session_created
          ON session_messages (workspace_id, session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS session_output_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_output_events_session_input_sequence
          ON session_output_events (session_id, input_id, sequence ASC);

      CREATE INDEX IF NOT EXISTS idx_session_output_events_workspace_session_created
          ON session_output_events (workspace_id, session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS terminal_sessions (
          terminal_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT,
          input_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          backend TEXT NOT NULL,
          owner TEXT NOT NULL,
          status TEXT NOT NULL,
          cwd TEXT NOT NULL,
          shell TEXT,
          command TEXT NOT NULL,
          exit_code INTEGER,
          last_event_seq INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          ended_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace_status
          ON terminal_sessions (workspace_id, status, last_activity_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_session_created
          ON terminal_sessions (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS terminal_session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          terminal_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_session_events_terminal_sequence
          ON terminal_session_events (terminal_id, sequence ASC);

      CREATE INDEX IF NOT EXISTS idx_terminal_session_events_workspace_created
          ON terminal_session_events (workspace_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS turn_results (
          input_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          stop_reason TEXT,
          assistant_text TEXT NOT NULL DEFAULT '',
          tool_usage_summary TEXT NOT NULL DEFAULT '{}',
          permission_denials TEXT NOT NULL DEFAULT '[]',
          prompt_section_ids TEXT NOT NULL DEFAULT '[]',
          capability_manifest_fingerprint TEXT,
          request_snapshot_fingerprint TEXT,
          prompt_cache_profile TEXT,
          context_budget_decisions TEXT,
          token_usage TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_results_workspace_session_completed
          ON turn_results (workspace_id, session_id, completed_at DESC, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_turn_results_session_input
          ON turn_results (session_id, input_id);

      CREATE TABLE IF NOT EXISTS subagent_runs (
          subagent_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          parent_session_id TEXT,
          parent_input_id TEXT,
          origin_main_session_id TEXT NOT NULL,
          owner_main_session_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          initial_child_input_id TEXT,
          current_child_input_id TEXT,
          latest_child_input_id TEXT,
          title TEXT,
          goal TEXT NOT NULL,
          context TEXT,
          source_type TEXT,
          source_id TEXT,
          proposal_id TEXT,
          cronjob_id TEXT,
          retry_of_subagent_id TEXT,
          tool_profile TEXT NOT NULL DEFAULT '{}',
          requested_model TEXT,
          effective_model TEXT,
          status TEXT NOT NULL,
          summary TEXT,
          latest_progress_payload TEXT,
          blocking_payload TEXT,
          result_payload TEXT,
          error_payload TEXT,
          last_event_at TEXT,
          owner_transferred_at TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (workspace_id, child_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_workspace_status_updated
          ON subagent_runs (workspace_id, status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_owner_status_updated
          ON subagent_runs (owner_main_session_id, status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_origin_created
          ON subagent_runs (origin_main_session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_retry_created
          ON subagent_runs (retry_of_subagent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_proposals (
          proposal_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_name TEXT NOT NULL,
          task_prompt TEXT NOT NULL,
          task_generation_rationale TEXT NOT NULL,
          proposal_source TEXT NOT NULL DEFAULT 'proactive',
          source_event_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'not_reviewed',
          accepted_session_id TEXT,
          accepted_input_id TEXT,
          accepted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_proposals_workspace_created
          ON task_proposals (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_proposals_workspace_state_created
          ON task_proposals (workspace_id, state, created_at DESC);

      CREATE TABLE IF NOT EXISTS evolve_skill_candidates (
          candidate_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          task_proposal_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          slug TEXT NOT NULL,
          skill_path TEXT NOT NULL,
          content_fingerprint TEXT NOT NULL,
          confidence REAL,
          evaluation_notes TEXT,
          source_turn_input_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          proposed_at TEXT,
          dismissed_at TEXT,
          accepted_at TEXT,
          promoted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_evolve_skill_candidates_workspace_created
          ON evolve_skill_candidates (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_evolve_skill_candidates_workspace_status_created
          ON evolve_skill_candidates (workspace_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_evolve_skill_candidates_task_proposal
          ON evolve_skill_candidates (task_proposal_id);

      CREATE TABLE IF NOT EXISTS memory_update_proposals (
          proposal_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          proposal_kind TEXT NOT NULL,
          target_key TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          evidence TEXT,
          confidence REAL,
          source_message_id TEXT,
          state TEXT NOT NULL DEFAULT 'pending',
          persisted_memory_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          accepted_at TEXT,
          dismissed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_workspace_created
          ON memory_update_proposals (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_session_input_created
          ON memory_update_proposals (session_id, input_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_workspace_state_created
          ON memory_update_proposals (workspace_id, state, created_at DESC);

      CREATE TABLE IF NOT EXISTS output_folders (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_output_folders_workspace_position
          ON output_folders (workspace_id, position ASC, created_at ASC);

      CREATE TABLE IF NOT EXISTS outputs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          output_type TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          module_id TEXT,
          module_resource_id TEXT,
          file_path TEXT,
          html_content TEXT,
          session_id TEXT,
          input_id TEXT,
          artifact_id TEXT,
          folder_id TEXT,
          platform TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outputs_workspace_created
          ON outputs (workspace_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_outputs_workspace_folder_created
          ON outputs (workspace_id, folder_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_outputs_session_input_created
          ON outputs (session_id, input_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS app_builds (
          workspace_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          restart_attempts INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, app_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_builds_workspace
          ON app_builds (workspace_id);

      CREATE TABLE IF NOT EXISTS app_ports (
          workspace_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          port INTEGER NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, app_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_ports_workspace
          ON app_ports (workspace_id);

      CREATE TABLE IF NOT EXISTS cronjobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          initiated_by TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          cron TEXT NOT NULL,
          description TEXT NOT NULL,
          instruction TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          delivery TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          last_run_at TEXT,
          next_run_at TEXT,
          run_count INTEGER NOT NULL DEFAULT 0,
          last_status TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cronjobs_workspace_created
          ON cronjobs (workspace_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_cronjobs_enabled_next_run
          ON cronjobs (enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS runtime_notifications (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cronjob_id TEXT,
          source_type TEXT NOT NULL,
          source_label TEXT,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          priority TEXT NOT NULL DEFAULT 'normal',
          state TEXT NOT NULL DEFAULT 'unread',
          metadata TEXT NOT NULL DEFAULT '{}',
          read_at TEXT,
          dismissed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_notifications_workspace_state_created
          ON runtime_notifications (workspace_id, state, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_runtime_notifications_state_created
          ON runtime_notifications (state, created_at DESC);
    `);
    this.ensureMemoryEntriesTableSchema(db);
    this.ensureMemoryEmbeddingIndexSchema(db);
    this.ensureConversationBindingsTableSchema(db);
    this.ensureSubagentRunsTableSchema(db);
    this.ensureSessionRuntimeStateTableSchema(db);
    this.ensureTurnArtifactsSchema(db);
    this.ensureTaskProposalsTableSchema(db);
    this.ensureEvolveSkillCandidatesTableSchema(db);
    this.ensureMemoryUpdateProposalsTableSchema(db);
    this.ensureOutputsTableSchema(db);
    this.migrateRuntimeNotificationPriority(db);
    this.migrateCronjobInstructions(db);
    this.migrateAppBuildRestartAttempts(db);
  }

  private ensureRuntimeDbSchema(db: Database.Database): void {
    this.ensureWorkspacesTableSchema(db);
    this.migrateRevertIntegrationConnectionsWorkspace(db);
    this.migrateIntegrationConnectionIdentityColumns(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          harness TEXT,
          error_message TEXT,
          onboarding_status TEXT NOT NULL,
          onboarding_session_id TEXT,
          onboarding_completed_at TEXT,
          onboarding_completion_summary TEXT,
          onboarding_requested_at TEXT,
          onboarding_requested_by TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at_utc TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_updated
          ON workspaces (updated_at DESC, created_at DESC);
    `);
  }

  private ensureConversationBindingsTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("conversation_bindings")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(conversation_bindings)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("metadata")) {
      db.exec("ALTER TABLE conversation_bindings ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';");
    }
    if (!columns.has("last_active_at")) {
      db.exec("ALTER TABLE conversation_bindings ADD COLUMN last_active_at TEXT;");
    }
    if (!columns.has("is_active")) {
      db.exec("ALTER TABLE conversation_bindings ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_workspace_role_active_updated
          ON conversation_bindings (workspace_id, role, is_active, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_channel_key_active
          ON conversation_bindings (channel, conversation_key, is_active);
    `);
  }

  private ensureSubagentRunsTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("subagent_runs")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(subagent_runs)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("initial_child_input_id")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN initial_child_input_id TEXT;");
    }
    if (!columns.has("current_child_input_id")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN current_child_input_id TEXT;");
    }
    if (!columns.has("latest_child_input_id")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN latest_child_input_id TEXT;");
    }
    if (!columns.has("latest_progress_payload")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN latest_progress_payload TEXT;");
    }
    if (!columns.has("blocking_payload")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN blocking_payload TEXT;");
    }
    if (!columns.has("result_payload")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN result_payload TEXT;");
    }
    if (!columns.has("error_payload")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN error_payload TEXT;");
    }
    if (!columns.has("last_event_at")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN last_event_at TEXT;");
    }
    if (!columns.has("owner_transferred_at")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN owner_transferred_at TEXT;");
    }
    if (!columns.has("cancelled_at")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN cancelled_at TEXT;");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_workspace_status_updated
          ON subagent_runs (workspace_id, status, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_owner_status_updated
          ON subagent_runs (owner_main_session_id, status, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_origin_created
          ON subagent_runs (origin_main_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_retry_created
          ON subagent_runs (retry_of_subagent_id, created_at DESC);
    `);
  }

  private ensureMainSessionEventQueueTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("main_session_event_queue")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(main_session_event_queue)").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!columns.has("coalesce_key")) {
      db.exec("ALTER TABLE main_session_event_queue ADD COLUMN coalesce_key TEXT;");
    }
    if (!columns.has("materialized_input_id")) {
      db.exec("ALTER TABLE main_session_event_queue ADD COLUMN materialized_input_id TEXT;");
    }
    if (!columns.has("superseded_by_event_id")) {
      db.exec("ALTER TABLE main_session_event_queue ADD COLUMN superseded_by_event_id TEXT;");
    }
    if (!columns.has("delivered_at")) {
      db.exec("ALTER TABLE main_session_event_queue ADD COLUMN delivered_at TEXT;");
    }
    if (!columns.has("superseded_at")) {
      db.exec("ALTER TABLE main_session_event_queue ADD COLUMN superseded_at TEXT;");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_owner_status_earliest
          ON main_session_event_queue (owner_main_session_id, status, earliest_deliver_at, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_workspace_status_created
          ON main_session_event_queue (workspace_id, status, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_subagent_created
          ON main_session_event_queue (subagent_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_main_session_event_queue_materialized_input
          ON main_session_event_queue (materialized_input_id);
    `);
  }

  private ensureSessionRuntimeStateTableSchema(db: Database.Database): void {
    const row = db
      .prepare<[string], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .get("session_runtime_state");
    const normalizedSql = (row?.sql ?? "").toUpperCase();
    if (!normalizedSql || normalizedSql.includes("'PAUSED'")) {
      return;
    }

    db.exec(`
      ALTER TABLE session_runtime_state RENAME TO session_runtime_state_legacy_no_paused;

      CREATE TABLE session_runtime_state (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${SESSION_RUNTIME_STATE_STATUS_SQL})),
          current_input_id TEXT,
          current_worker_id TEXT,
          lease_until TEXT,
          heartbeat_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, session_id)
      );

      INSERT INTO session_runtime_state (
          workspace_id,
          session_id,
          status,
          current_input_id,
          current_worker_id,
          lease_until,
          heartbeat_at,
          last_error,
          created_at,
          updated_at
      )
      SELECT
          workspace_id,
          session_id,
          CASE
            WHEN UPPER(status) IN (${SESSION_RUNTIME_STATE_STATUS_SQL}) THEN UPPER(status)
            ELSE 'IDLE'
          END,
          current_input_id,
          current_worker_id,
          lease_until,
          heartbeat_at,
          last_error,
          created_at,
          updated_at
      FROM session_runtime_state_legacy_no_paused;

      DROP TABLE session_runtime_state_legacy_no_paused;

      CREATE INDEX IF NOT EXISTS session_runtime_state_workspace_session_idx
          ON session_runtime_state (workspace_id, session_id);

      CREATE INDEX IF NOT EXISTS session_runtime_state_session_id_idx
          ON session_runtime_state (session_id);
    `);
  }

  private migrateRuntimeNotificationPriority(db: Database.Database): void {
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(runtime_notifications)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("priority")) {
      db.exec("ALTER TABLE runtime_notifications ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';");
    }
  }

  private migrateCronjobInstructions(db: Database.Database): void {
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(cronjobs)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("instruction")) {
      db.exec("ALTER TABLE cronjobs ADD COLUMN instruction TEXT NOT NULL DEFAULT '';");
    }
    db.exec("UPDATE cronjobs SET instruction = description WHERE trim(coalesce(instruction, '')) = '';");
  }

  private migrateAppBuildRestartAttempts(db: Database.Database): void {
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(app_builds)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("restart_attempts")) {
      db.exec("ALTER TABLE app_builds ADD COLUMN restart_attempts INTEGER NOT NULL DEFAULT 0;");
    }
  }

  // Connections are user-global; per-workspace scoping lives in
  // integration_bindings. The short-lived feat/composio-workspace-scoped-accounts
  // branch added a workspace_id column to integration_connections that conflicts
  // with the "one account → many workspaces" model. This migration removes it
  // for any DB that still has the column, materializing each row's prior intent
  // as a default workspace binding so we don't lose the user's setup.
  private migrateRevertIntegrationConnectionsWorkspace(db: Database.Database): void {
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(integration_connections)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("workspace_id")) {
      return;
    }

    const rows = db
      .prepare(
        "SELECT connection_id, provider_id, workspace_id FROM integration_connections WHERE workspace_id IS NOT NULL AND trim(workspace_id) != ''"
      )
      .all() as Array<{ connection_id: string; provider_id: string; workspace_id: string }>;
    if (rows.length > 0) {
      const insertBinding = db.prepare(
        "INSERT OR IGNORE INTO integration_bindings (binding_id, workspace_id, target_type, target_id, integration_key, connection_id, is_default, created_at, updated_at) VALUES (?, ?, 'workspace', 'default', ?, ?, 1, ?, ?)"
      );
      const now = utcNowIso();
      for (const row of rows) {
        insertBinding.run(randomUUID(), row.workspace_id, row.provider_id, row.connection_id, now, now);
      }
    }

    db.exec("DROP INDEX IF EXISTS idx_integration_connections_workspace_provider;");
    db.exec("ALTER TABLE integration_connections DROP COLUMN workspace_id;");
  }

  // Adds the provider-side identity columns (`account_handle`, `account_email`)
  // used for dedupe-on-reconnect. Composio re-auth flows produce a new
  // `account_external_id` every time even for the same real account, so
  // we resolve the stable identity via whoami at connect time and store it
  // here. Both columns are nullable: legacy rows without whoami data
  // simply won't deduplicate until they next reconnect.
  private migrateIntegrationConnectionIdentityColumns(db: Database.Database): void {
    if (!this.tableExists(db, "integration_connections")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(integration_connections)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("account_handle")) {
      db.exec("ALTER TABLE integration_connections ADD COLUMN account_handle TEXT;");
    }
    if (!columns.has("account_email")) {
      db.exec("ALTER TABLE integration_connections ADD COLUMN account_email TEXT;");
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner_handle ON integration_connections (provider_id, owner_user_id, account_handle);"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner_email ON integration_connections (provider_id, owner_user_id, account_email);"
    );
  }

  private migrateLegacySessionArtifactsToOutputs(db: Database.Database): void {
    const tables = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tables.has("session_artifacts")) {
      return;
    }

    const legacyRows = db
      .prepare<
        [],
        {
          id: string;
          session_id: string;
          workspace_id: string;
          artifact_type: string;
          external_id: string;
          platform: string | null;
          title: string | null;
          metadata: string | null;
          created_at: string;
        }
      >(`
        SELECT id, session_id, workspace_id, artifact_type, external_id, platform, title, metadata, created_at
        FROM session_artifacts
        ORDER BY datetime(created_at) ASC, id ASC
      `)
      .all();

    const hasOutputForArtifact = db.prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM outputs WHERE artifact_id = ? LIMIT 1"
    );
    const insertOutput = db.prepare(`
      INSERT INTO outputs (
          id, workspace_id, output_type, title, status, module_id, module_resource_id, file_path,
          html_content, session_id, input_id, artifact_id, folder_id, platform, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      for (const row of legacyRows) {
        if (hasOutputForArtifact.get(row.id)) {
          continue;
        }
        const existingMetadata = this.parseJsonDict(row.metadata);
        const mergedMetadata = {
          ...existingMetadata,
          origin_type: "app",
          change_type: "created",
          artifact_type: row.artifact_type,
          external_id: row.external_id,
        };
        insertOutput.run(
          randomUUID(),
          row.workspace_id,
          outputTypeForArtifactType(row.artifact_type),
          row.title ?? "",
          "completed",
          null,
          row.external_id,
          null,
          null,
          row.session_id,
          null,
          row.id,
          null,
          row.platform ?? null,
          JSON.stringify(mergedMetadata),
          row.created_at,
          row.created_at
        );
      }
      db.exec("DROP TABLE IF EXISTS session_artifacts;");
    });

    migrate();
  }

  private tableExists(db: Database.Database, tableName: string): boolean {
    const row = db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .get(tableName);
    return Boolean(row);
  }

  private ensureTaskProposalsTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("task_proposals")) {
      return;
    }

    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(task_proposals)").all() as Array<{ name: string }>).map((row) => row.name)
    );

    if (!columns.has("accepted_session_id")) {
      db.exec("ALTER TABLE task_proposals ADD COLUMN accepted_session_id TEXT;");
    }
    if (!columns.has("accepted_input_id")) {
      db.exec("ALTER TABLE task_proposals ADD COLUMN accepted_input_id TEXT;");
    }
    if (!columns.has("accepted_at")) {
      db.exec("ALTER TABLE task_proposals ADD COLUMN accepted_at TEXT;");
    }
    if (!columns.has("proposal_source")) {
      db.exec("ALTER TABLE task_proposals ADD COLUMN proposal_source TEXT NOT NULL DEFAULT 'proactive';");
    }
    db.exec("UPDATE task_proposals SET proposal_source = 'proactive' WHERE trim(coalesce(proposal_source, '')) = '';");
  }

  private ensureEvolveSkillCandidatesTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("evolve_skill_candidates")) {
      return;
    }

    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(evolve_skill_candidates)").all() as Array<{ name: string }>).map((row) => row.name)
    );

    if (!columns.has("task_proposal_id")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN task_proposal_id TEXT;");
    }
    if (!columns.has("kind")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill_create';");
    }
    if (!columns.has("status")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';");
    }
    if (!columns.has("title")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN title TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("summary")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN summary TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("slug")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN slug TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("skill_path")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN skill_path TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("content_fingerprint")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN content_fingerprint TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("confidence")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN confidence REAL;");
    }
    if (!columns.has("evaluation_notes")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN evaluation_notes TEXT;");
    }
    if (!columns.has("source_turn_input_ids")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN source_turn_input_ids TEXT NOT NULL DEFAULT '[]';");
    }
    if (!columns.has("created_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN created_at TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("updated_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("proposed_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN proposed_at TEXT;");
    }
    if (!columns.has("dismissed_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN dismissed_at TEXT;");
    }
    if (!columns.has("accepted_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN accepted_at TEXT;");
    }
    if (!columns.has("promoted_at")) {
      db.exec("ALTER TABLE evolve_skill_candidates ADD COLUMN promoted_at TEXT;");
    }
  }

  private ensureMemoryUpdateProposalsTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("memory_update_proposals")) {
      return;
    }

    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(memory_update_proposals)").all() as Array<{ name: string }>).map((row) => row.name)
    );

    if (!columns.has("payload")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';");
    }
    if (!columns.has("evidence")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN evidence TEXT;");
    }
    if (!columns.has("confidence")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN confidence REAL;");
    }
    if (!columns.has("source_message_id")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN source_message_id TEXT;");
    }
    if (!columns.has("state")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';");
    }
    if (!columns.has("persisted_memory_id")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN persisted_memory_id TEXT;");
    }
    if (!columns.has("updated_at")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN updated_at TEXT;");
      db.exec("UPDATE memory_update_proposals SET updated_at = created_at WHERE updated_at IS NULL;");
    }
    if (!columns.has("accepted_at")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN accepted_at TEXT;");
    }
    if (!columns.has("dismissed_at")) {
      db.exec("ALTER TABLE memory_update_proposals ADD COLUMN dismissed_at TEXT;");
    }
  }

  private rebuildTurnResultsWithoutLegacyColumns(db: Database.Database): void {
    db.exec(`
      ALTER TABLE turn_results RENAME TO turn_results_legacy_with_removed_columns;

      CREATE TABLE turn_results (
          input_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          stop_reason TEXT,
          assistant_text TEXT NOT NULL DEFAULT '',
          tool_usage_summary TEXT NOT NULL DEFAULT '{}',
          permission_denials TEXT NOT NULL DEFAULT '[]',
          prompt_section_ids TEXT NOT NULL DEFAULT '[]',
          capability_manifest_fingerprint TEXT,
          request_snapshot_fingerprint TEXT,
          prompt_cache_profile TEXT,
          context_budget_decisions TEXT,
          token_usage TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      INSERT INTO turn_results (
          input_id,
          workspace_id,
          session_id,
          started_at,
          completed_at,
          status,
          stop_reason,
          assistant_text,
          tool_usage_summary,
          permission_denials,
          prompt_section_ids,
          capability_manifest_fingerprint,
          request_snapshot_fingerprint,
          prompt_cache_profile,
          context_budget_decisions,
          token_usage,
          created_at,
          updated_at
      )
      SELECT
          input_id,
          workspace_id,
          session_id,
          started_at,
          completed_at,
          status,
          stop_reason,
          assistant_text,
          tool_usage_summary,
          permission_denials,
          prompt_section_ids,
          capability_manifest_fingerprint,
          request_snapshot_fingerprint,
          prompt_cache_profile,
          context_budget_decisions,
          token_usage,
          created_at,
          updated_at
      FROM turn_results_legacy_with_removed_columns;

      DROP TABLE turn_results_legacy_with_removed_columns;

      CREATE INDEX IF NOT EXISTS idx_turn_results_workspace_session_completed
          ON turn_results (workspace_id, session_id, completed_at DESC, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_turn_results_session_input
          ON turn_results (session_id, input_id);
    `);
  }

  private ensureTurnArtifactsSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );

    if (tableNames.has("turn_results")) {
      const columns = new Set<string>(
        (db.prepare("PRAGMA table_info(turn_results)").all() as Array<{ name: string }>).map((row) => row.name)
      );
      if (!columns.has("request_snapshot_fingerprint")) {
        db.exec("ALTER TABLE turn_results ADD COLUMN request_snapshot_fingerprint TEXT;");
      }
      if (!columns.has("prompt_cache_profile")) {
        db.exec("ALTER TABLE turn_results ADD COLUMN prompt_cache_profile TEXT;");
      }
      if (!columns.has("context_budget_decisions")) {
        db.exec("ALTER TABLE turn_results ADD COLUMN context_budget_decisions TEXT;");
      }
      if (columns.has("compaction_boundary_id") || columns.has("compacted_summary")) {
        this.rebuildTurnResultsWithoutLegacyColumns(db);
      }
    }
    if (tableNames.has("compaction_boundaries")) {
      db.exec("DROP TABLE compaction_boundaries;");
    }

    if (tableNames.has("memory_entries")) {
      const columns = new Set<string>(
        (db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>).map((row) => row.name)
      );
      if (!columns.has("staleness_policy")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN staleness_policy TEXT NOT NULL DEFAULT 'stable';");
      }
      if (!columns.has("stale_after_seconds")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN stale_after_seconds INTEGER;");
      }
      if (!columns.has("source_type")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN source_type TEXT;");
      }
      if (!columns.has("observed_at")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN observed_at TEXT;");
      }
      if (!columns.has("last_verified_at")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN last_verified_at TEXT;");
      }
      if (!columns.has("confidence")) {
        db.exec("ALTER TABLE memory_entries ADD COLUMN confidence REAL;");
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_request_snapshots (
          input_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          snapshot_kind TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_request_snapshots_workspace_session_updated
          ON turn_request_snapshots (workspace_id, session_id, updated_at DESC, created_at DESC);
    `);
  }

  private ensureOutputsTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("outputs")) {
      return;
    }

    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(outputs)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("input_id")) {
      db.exec("ALTER TABLE outputs ADD COLUMN input_id TEXT;");
    }
  }

  private ensureWorkspacesTableSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          harness TEXT,
          error_message TEXT,
          onboarding_status TEXT NOT NULL,
          onboarding_session_id TEXT,
          onboarding_completed_at TEXT,
          onboarding_completion_summary TEXT,
          onboarding_requested_at TEXT,
          onboarding_requested_by TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at_utc TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_updated
          ON workspaces (updated_at DESC, created_at DESC);
    `);

    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (tableNames.has("workspaces")) {
      const columns = new Set<string>(
        (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((row) => row.name)
      );
      if (!columns.has("workspace_path")) {
        db.exec(`
          ALTER TABLE workspaces RENAME TO workspaces_legacy_no_path;

          CREATE TABLE workspaces (
              id TEXT PRIMARY KEY,
              workspace_path TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              status TEXT NOT NULL,
              harness TEXT,
              error_message TEXT,
              onboarding_status TEXT NOT NULL,
              onboarding_session_id TEXT,
              onboarding_completed_at TEXT,
              onboarding_completion_summary TEXT,
              onboarding_requested_at TEXT,
              onboarding_requested_by TEXT,
              created_at TEXT,
              updated_at TEXT,
              deleted_at_utc TEXT
          );

          INSERT INTO workspaces (
              id,
              workspace_path,
              name,
              status,
              harness,
              error_message,
              onboarding_status,
              onboarding_session_id,
              onboarding_completed_at,
              onboarding_completion_summary,
              onboarding_requested_at,
              onboarding_requested_by,
              created_at,
              updated_at,
              deleted_at_utc
          )
          SELECT
              id,
              '' AS workspace_path,
              name,
              status,
              harness,
              error_message,
              onboarding_status,
              onboarding_session_id,
              onboarding_completed_at,
              onboarding_completion_summary,
              onboarding_requested_at,
              onboarding_requested_by,
              created_at,
              updated_at,
              deleted_at_utc
          FROM workspaces_legacy_no_path;

          DROP TABLE workspaces_legacy_no_path;
        `);
      }
    }

    const refreshedColumns = new Set<string>(
      (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (refreshedColumns.has("main_session_id")) {
      db.exec(`
        ALTER TABLE workspaces RENAME TO workspaces_legacy_main_session;

        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            harness TEXT,
            error_message TEXT,
            onboarding_status TEXT NOT NULL,
            onboarding_session_id TEXT,
            onboarding_completed_at TEXT,
            onboarding_completion_summary TEXT,
            onboarding_requested_at TEXT,
            onboarding_requested_by TEXT,
            created_at TEXT,
            updated_at TEXT,
            deleted_at_utc TEXT
        );

        INSERT INTO workspaces (
            id,
            workspace_path,
            name,
            status,
            harness,
            error_message,
            onboarding_status,
            onboarding_session_id,
            onboarding_completed_at,
            onboarding_completion_summary,
            onboarding_requested_at,
            onboarding_requested_by,
            created_at,
            updated_at,
            deleted_at_utc
        )
        SELECT
            id,
            workspace_path,
            name,
            status,
            harness,
            error_message,
            onboarding_status,
            onboarding_session_id,
            onboarding_completed_at,
            onboarding_completion_summary,
            onboarding_requested_at,
            onboarding_requested_by,
            created_at,
            updated_at,
            deleted_at_utc
        FROM workspaces_legacy_main_session;

        DROP TABLE workspaces_legacy_main_session;

        CREATE INDEX IF NOT EXISTS idx_workspaces_updated
            ON workspaces (updated_at DESC, created_at DESC);
      `);
    }

    this.migrateWorkspacesTable(db);
  }

  private migrateWorkspacesTable(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );

    if (tableNames.has("workspaces")) {
      const rows = db.prepare<[], WorkspaceRow>("SELECT * FROM workspaces").all();
      for (const row of rows) {
        const workspacePath = row.workspace_path.trim();
        if (row.deleted_at_utc != null) {
          const preservedPath = this.workspacePathMatchesIdentity(
            this.discoverWorkspacePath(row.id),
            row.id,
          ) ?? this.workspacePathMatchesIdentity(
            decodeDeletedWorkspacePathTombstone(workspacePath, row.id)
              ?? workspacePath,
            row.id,
          );
          const nextPath = preservedPath
            ? deletedWorkspacePathTombstone(row.id, preservedPath)
            : workspacePath;
          if (nextPath) {
            db.prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(nextPath, row.id);
          }
          continue;
        }
        const resolvedPath =
          workspacePath && fs.existsSync(workspacePath) && fs.statSync(workspacePath).isDirectory()
            ? workspacePath
            : this.discoverWorkspacePath(row.id) ?? this.defaultWorkspaceDir(row.id);
        db.prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(resolvedPath, row.id);
        this.writeWorkspaceIdentityFile(resolvedPath, row.id);
      }
    }

    if (tableNames.has("workspaces_legacy_with_owner")) {
      const rows = db.prepare<[], Omit<WorkspaceRow, "workspace_path">>("SELECT * FROM workspaces_legacy_with_owner").all();
      for (const row of rows) {
        const record = this.workspaceRecordFromRowLike(row);
        this.upsertWorkspaceRowInDb(record, this.discoverWorkspacePath(record.id) ?? this.defaultWorkspaceDir(record.id), db);
      }
      db.exec("DROP TABLE workspaces_legacy_with_owner; DROP INDEX IF EXISTS idx_workspaces_user_updated;");
    }

    if (!fs.existsSync(this.workspaceRoot) || !fs.statSync(this.workspaceRoot).isDirectory()) {
      return;
    }

    for (const childName of fs.readdirSync(this.workspaceRoot)) {
      const childPath = path.join(this.workspaceRoot, childName);
      if (!fs.statSync(childPath).isDirectory()) {
        continue;
      }
      const legacyMetadataPath = path.join(childPath, LEGACY_WORKSPACE_METADATA_FILENAME);
      if (!fs.existsSync(legacyMetadataPath)) {
        continue;
      }

      const payload = JSON.parse(fs.readFileSync(legacyMetadataPath, "utf-8")) as Record<string, unknown>;
      const record = this.workspaceRecordFromLegacyPayload(payload);
      this.upsertWorkspaceRowInDb(record, childPath, db);
      this.writeWorkspaceIdentityFile(childPath, record.id);
      fs.rmSync(legacyMetadataPath, { force: true });
    }
  }

  private rowToWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return this.workspaceRecordFromRowLike(row);
  }

  private workspaceRecordFromRowLike(row: Record<string, unknown>): WorkspaceRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
      harness: row.harness == null ? null : String(row.harness),
      errorMessage: row.error_message == null ? null : String(row.error_message),
      onboardingStatus: String(row.onboarding_status),
      onboardingSessionId: row.onboarding_session_id == null ? null : String(row.onboarding_session_id),
      onboardingCompletedAt: row.onboarding_completed_at == null ? null : String(row.onboarding_completed_at),
      onboardingCompletionSummary:
        row.onboarding_completion_summary == null ? null : String(row.onboarding_completion_summary),
      onboardingRequestedAt: row.onboarding_requested_at == null ? null : String(row.onboarding_requested_at),
      onboardingRequestedBy: row.onboarding_requested_by == null ? null : String(row.onboarding_requested_by),
      createdAt: row.created_at == null ? null : String(row.created_at),
      updatedAt: row.updated_at == null ? null : String(row.updated_at),
      deletedAtUtc: row.deleted_at_utc == null ? null : String(row.deleted_at_utc)
    };
  }

  private workspaceRecordFromLegacyPayload(data: Record<string, unknown>): WorkspaceRecord {
    return {
      id: String(data.id),
      name: String(data.name),
      status: String(data.status),
      harness: data.harness == null ? null : String(data.harness),
      errorMessage: data.error_message == null ? null : String(data.error_message),
      onboardingStatus: String(data.onboarding_status),
      onboardingSessionId: data.onboarding_session_id == null ? null : String(data.onboarding_session_id),
      onboardingCompletedAt: data.onboarding_completed_at == null ? null : String(data.onboarding_completed_at),
      onboardingCompletionSummary:
        data.onboarding_completion_summary == null ? null : String(data.onboarding_completion_summary),
      onboardingRequestedAt: data.onboarding_requested_at == null ? null : String(data.onboarding_requested_at),
      onboardingRequestedBy: data.onboarding_requested_by == null ? null : String(data.onboarding_requested_by),
      createdAt: data.created_at == null ? null : String(data.created_at),
      updatedAt: data.updated_at == null ? null : String(data.updated_at),
      deletedAtUtc: data.deleted_at_utc == null ? null : String(data.deleted_at_utc)
    };
  }

  private workspacePathFromRegistry(workspaceId: string): string | null {
    const row = this.controlPlaneDb()
      .prepare<[string], { workspace_path: string | null }>("SELECT workspace_path FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId);
    if (!row || row.workspace_path == null) {
      return null;
    }
    const value = row.workspace_path.trim();
    return value || null;
  }

  private upsertWorkspaceRowInDb(record: WorkspaceRecord, workspacePath: string, db: Database.Database): void {
    db.prepare(`
      INSERT INTO workspaces (
          id, workspace_path, name, status, harness, error_message,
          onboarding_status, onboarding_session_id, onboarding_completed_at,
          onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
          created_at, updated_at, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          name = excluded.name,
          status = excluded.status,
          harness = excluded.harness,
          error_message = excluded.error_message,
          onboarding_status = excluded.onboarding_status,
          onboarding_session_id = excluded.onboarding_session_id,
          onboarding_completed_at = excluded.onboarding_completed_at,
          onboarding_completion_summary = excluded.onboarding_completion_summary,
          onboarding_requested_at = excluded.onboarding_requested_at,
          onboarding_requested_by = excluded.onboarding_requested_by,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at_utc = excluded.deleted_at_utc
    `).run(
      record.id,
      workspacePath,
      record.name,
      record.status,
      record.harness,
      record.errorMessage,
      record.onboardingStatus,
      record.onboardingSessionId,
      record.onboardingCompletedAt,
      record.onboardingCompletionSummary,
      record.onboardingRequestedAt,
      record.onboardingRequestedBy,
      record.createdAt,
      record.updatedAt,
      record.deletedAtUtc
    );
  }

  private upsertWorkspaceRow(record: WorkspaceRecord, workspacePath: string): void {
    this.upsertWorkspaceRowInDb(record, workspacePath, this.controlPlaneDb());
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.upsertWorkspaceRowInDb(record, workspacePath, this.db());
    }
  }

  private writeWorkspaceIdentityFile(workspacePath: string, workspaceId: string): void {
    const identityPath = currentWorkspaceIdentityPath(workspacePath);
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    const tempPath = `${identityPath}.tmp`;
    fs.writeFileSync(tempPath, `${workspaceId}\n`, "utf-8");
    fs.renameSync(tempPath, identityPath);
  }

  private discoverWorkspacePath(workspaceId: string): string | null {
    if (!fs.existsSync(this.workspaceRoot) || !fs.statSync(this.workspaceRoot).isDirectory()) {
      return null;
    }

    for (const childName of fs.readdirSync(this.workspaceRoot)) {
      const childPath = path.join(this.workspaceRoot, childName);
      if (!fs.statSync(childPath).isDirectory()) {
        continue;
      }
      const identityPath = ensureWorkspaceIdentityMigrated(childPath);
      const legacyPath = legacyWorkspaceIdentityPath(childPath);
      const candidatePath = fs.existsSync(identityPath) ? identityPath : legacyPath;
      if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
        continue;
      }

      try {
        const raw = fs.readFileSync(candidatePath, "utf-8").trim();
        if (raw === workspaceId) {
          return childPath;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private workspacePathMatchesIdentity(
    workspacePath: string | null | undefined,
    workspaceId: string,
  ): string | null {
    if (!workspacePath) {
      return null;
    }
    try {
      const resolvedPath = path.resolve(workspacePath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        return null;
      }
      const identityPath = ensureWorkspaceIdentityMigrated(resolvedPath);
      if (!fs.existsSync(identityPath) || !fs.statSync(identityPath).isFile()) {
        return null;
      }
      const rawIdentity = fs.readFileSync(identityPath, "utf-8").trim();
      return rawIdentity === workspaceId ? resolvedPath : null;
    } catch {
      return null;
    }
  }

  private updateWorkspacePath(workspaceId: string, workspacePath: string): void {
    this.controlPlaneDb().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(workspacePath, workspaceId);
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.db().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(workspacePath, workspaceId);
    }
  }

  private recoverMissingWorkspaceRecord(workspaceId: string): WorkspaceRecord | null {
    const discovered = this.discoverWorkspacePath(workspaceId);
    if (!discovered) {
      return null;
    }

    const now = utcNowIso();
    const record: WorkspaceRecord = {
      id: workspaceId,
      name: workspaceId,
      status: "active",
      harness: this.sandboxAgentHarness,
      errorMessage: null,
      onboardingStatus: "not_required",
      onboardingSessionId: null,
      onboardingCompletedAt: null,
      onboardingCompletionSummary: null,
      onboardingRequestedAt: null,
      onboardingRequestedBy: null,
      createdAt: now,
      updatedAt: now,
      deletedAtUtc: null
    };
    this.upsertWorkspaceRow(record, discovered);
    return record;
  }

  private defaultWorkspaceDir(workspaceId: string): string {
    return path.join(this.workspaceRoot, sanitizeWorkspaceId(workspaceId));
  }

  private rowToInput(row: Record<string, unknown> | undefined): SessionInputRecord | null {
    if (!row) {
      return null;
    }
    return {
      inputId: String(row.input_id),
      sessionId: String(row.session_id),
      workspaceId: String(row.workspace_id),
      payload: this.parseJsonDict(row.payload),
      status: String(row.status),
      priority: Number(row.priority),
      availableAt: String(row.available_at),
      attempt: Number(row.attempt),
      idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
      claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
      claimedUntil: row.claimed_until == null ? null : String(row.claimed_until),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToPostRunJob(row: Record<string, unknown> | undefined): PostRunJobRecord | null {
    if (!row) {
      return null;
    }
    return {
      jobId: String(row.job_id),
      jobType: String(row.job_type),
      inputId: String(row.input_id),
      sessionId: String(row.session_id),
      workspaceId: String(row.workspace_id),
      payload: this.parseJsonDict(row.payload),
      status: String(row.status),
      priority: Number(row.priority),
      availableAt: String(row.available_at),
      attempt: Number(row.attempt),
      idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
      claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
      claimedUntil: row.claimed_until == null ? null : String(row.claimed_until),
      lastError: row.last_error == null ? null : this.parseJsonObjectOrMessage(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToRuntimeState(row: Record<string, unknown> | undefined): SessionRuntimeStateRecord {
    if (!row) {
      throw new Error("runtime state row not found");
    }
    return {
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      status: String(row.status),
      currentInputId: row.current_input_id == null ? null : String(row.current_input_id),
      currentWorkerId: row.current_worker_id == null ? null : String(row.current_worker_id),
      leaseUntil: row.lease_until == null ? null : String(row.lease_until),
      heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
      lastError: this.parseJsonObjectOrMessage(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToTerminalSession(row: Record<string, unknown>): TerminalSessionRecord {
    const normalizedBackend = String(row.backend).trim().toLowerCase();
    const normalizedOwner = String(row.owner).trim().toLowerCase();
    const normalizedStatus = String(row.status).trim().toLowerCase();
    return {
      terminalId: String(row.terminal_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      inputId: row.input_id == null ? null : String(row.input_id),
      title: row.title == null ? "" : String(row.title),
      backend: normalizedBackend === "node_pty" ? "node_pty" : "node_pty",
      owner: normalizedOwner === "user" ? "user" : "agent",
      status:
        normalizedStatus === "starting" ||
        normalizedStatus === "running" ||
        normalizedStatus === "exited" ||
        normalizedStatus === "failed" ||
        normalizedStatus === "interrupted" ||
        normalizedStatus === "closed"
          ? normalizedStatus
          : "starting",
      cwd: String(row.cwd),
      shell: row.shell == null ? null : String(row.shell),
      command: String(row.command),
      exitCode: row.exit_code == null ? null : Number(row.exit_code),
      lastEventSeq: Number(row.last_event_seq ?? 0),
      createdBy: row.created_by == null ? null : String(row.created_by),
      createdAt: String(row.created_at),
      startedAt: String(row.started_at),
      lastActivityAt: String(row.last_activity_at),
      endedAt: row.ended_at == null ? null : String(row.ended_at),
      metadata: this.parseJsonDict(row.metadata),
    };
  }

  private rowToTerminalSessionEvent(row: Record<string, unknown>): TerminalSessionEventRecord {
    return {
      id: Number(row.id),
      terminalId: String(row.terminal_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      payload: this.parseJsonDict(row.payload),
      createdAt: String(row.created_at),
    };
  }

  private rowToTurnResult(row: Record<string, unknown>): TurnResultRecord {
    return {
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      inputId: String(row.input_id),
      startedAt: String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      status: String(row.status),
      stopReason: row.stop_reason == null ? null : String(row.stop_reason),
      assistantText: row.assistant_text == null ? "" : String(row.assistant_text),
      toolUsageSummary: this.parseJsonDict(row.tool_usage_summary),
      permissionDenials: this.parseJsonDictList(row.permission_denials),
      promptSectionIds: this.parseJsonList(row.prompt_section_ids).filter(
        (item): item is string => typeof item === "string"
      ),
      capabilityManifestFingerprint:
        row.capability_manifest_fingerprint == null ? null : String(row.capability_manifest_fingerprint),
      requestSnapshotFingerprint:
        row.request_snapshot_fingerprint == null ? null : String(row.request_snapshot_fingerprint),
      promptCacheProfile: row.prompt_cache_profile == null ? null : this.parseJsonObjectOrMessage(row.prompt_cache_profile),
      contextBudgetDecisions:
        row.context_budget_decisions == null
          ? null
          : this.parseJsonObjectOrMessage(row.context_budget_decisions),
      tokenUsage: row.token_usage == null ? null : this.parseJsonObjectOrMessage(row.token_usage),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToTurnRequestSnapshot(row: Record<string, unknown>): TurnRequestSnapshotRecord {
    return {
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      inputId: String(row.input_id),
      snapshotKind: String(row.snapshot_kind),
      fingerprint: String(row.fingerprint),
      payload: this.parseJsonDict(row.payload),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToRuntimeUserProfile(row: Record<string, unknown>): RuntimeUserProfileRecord {
    return {
      profileId: String(row.profile_id),
      name: row.name == null ? null : String(row.name),
      nameSource: row.name_source == null ? null : String(row.name_source) as RuntimeUserProfileNameSource,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToMemoryEntry(row: Record<string, unknown>): MemoryEntryRecord {
    return {
      memoryId: String(row.memory_id),
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      scope: String(row.scope) as MemoryEntryScope,
      memoryType: String(row.memory_type) as MemoryEntryType,
      subjectKey: String(row.subject_key),
      path: String(row.path),
      title: String(row.title),
      summary: String(row.summary),
      tags: this.parseJsonList(row.tags).filter((item): item is string => typeof item === "string"),
      verificationPolicy: String(row.verification_policy) as MemoryVerificationPolicy,
      stalenessPolicy: String(row.staleness_policy ?? "stable") as MemoryStalenessPolicy,
      staleAfterSeconds: (() => {
        if (row.stale_after_seconds == null) {
          return null;
        }
        const parsed =
          typeof row.stale_after_seconds === "number" ? row.stale_after_seconds : Number(row.stale_after_seconds);
        return Number.isFinite(parsed) ? parsed : null;
      })(),
      sourceTurnInputId: row.source_turn_input_id == null ? null : String(row.source_turn_input_id),
      sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
      sourceType: row.source_type == null ? null : String(row.source_type) as MemoryEntrySourceType,
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      lastVerifiedAt: row.last_verified_at == null ? null : String(row.last_verified_at),
      confidence: (() => {
        if (row.confidence == null) {
          return null;
        }
        const parsed = typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
        return Number.isFinite(parsed) ? parsed : null;
      })(),
      fingerprint: String(row.fingerprint),
      status: String(row.status),
      supersededAt: row.superseded_at == null ? null : String(row.superseded_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToMemoryEmbeddingIndex(row: Record<string, unknown>): MemoryEmbeddingIndexRecord {
    return {
      vecRowid: Number(row.vec_rowid),
      memoryId: String(row.memory_id),
      path: String(row.path),
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      scopeBucket: String(row.scope_bucket) as MemoryEmbeddingScopeBucket,
      memoryType: String(row.memory_type),
      contentFingerprint: String(row.content_fingerprint),
      embeddingModel: String(row.embedding_model),
      embeddingDim: Number(row.embedding_dim),
      indexedAt: String(row.indexed_at),
      updatedAt: String(row.updated_at),
    };
  }

  private vectorResultsForRows(
    db: Database.Database,
    rows: Array<{ vec_rowid: number; distance: number }>
  ): MemoryVectorSearchResult[] {
    if (rows.length === 0) {
      return [];
    }
    const rowIds = rows.map((row) => Number(row.vec_rowid)).filter((value) => Number.isFinite(value));
    if (rowIds.length === 0) {
      return [];
    }
    const mappingRows = db
      .prepare(`
        SELECT *
        FROM memory_embedding_index
        WHERE vec_rowid IN (${rowIds.map(() => "?").join(", ")})
      `)
      .all(...rowIds) as Array<Record<string, unknown>>;
    const byRowId = new Map<number, MemoryEmbeddingIndexRecord>();
    for (const row of mappingRows) {
      const record = this.rowToMemoryEmbeddingIndex(row);
      byRowId.set(record.vecRowid, record);
    }
    const results: MemoryVectorSearchResult[] = [];
    for (const row of rows) {
      const mapping = byRowId.get(Number(row.vec_rowid));
      if (!mapping) {
        continue;
      }
      results.push({
        vecRowid: mapping.vecRowid,
        distance: Number(row.distance),
        memoryId: mapping.memoryId,
        path: mapping.path,
        workspaceId: mapping.workspaceId,
        scopeBucket: mapping.scopeBucket,
        memoryType: mapping.memoryType,
      });
    }
    return results;
  }

  private rowToIntegrationConnection(row: Record<string, unknown>): IntegrationConnectionRecord {
    return {
      connectionId: String(row.connection_id),
      providerId: String(row.provider_id),
      ownerUserId: String(row.owner_user_id),
      accountLabel: String(row.account_label),
      accountExternalId: row.account_external_id == null ? null : String(row.account_external_id),
      accountHandle: row.account_handle == null ? null : String(row.account_handle),
      accountEmail: row.account_email == null ? null : String(row.account_email),
      authMode: String(row.auth_mode),
      grantedScopes: this.parseJsonList(row.granted_scopes).filter((item): item is string => typeof item === "string"),
      status: String(row.status),
      secretRef: row.secret_ref == null ? null : String(row.secret_ref),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToIntegrationBinding(row: Record<string, unknown>): IntegrationBindingRecord {
    return {
      bindingId: String(row.binding_id),
      workspaceId: String(row.workspace_id),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      integrationKey: String(row.integration_key),
      connectionId: String(row.connection_id),
      isDefault: Boolean(Number(row.is_default)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToConversationBinding(row: Record<string, unknown>): ConversationBindingRecord {
    return {
      bindingId: String(row.binding_id),
      workspaceId: String(row.workspace_id),
      channel: String(row.channel),
      conversationKey: String(row.conversation_key),
      sessionId: String(row.session_id),
      role: String(row.role),
      isActive: Boolean(Number(row.is_active)),
      metadata: this.parseJsonDict(row.metadata),
      lastActiveAt: row.last_active_at == null ? null : String(row.last_active_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToAgentSession(row: Record<string, unknown>): AgentSessionRecord {
    return {
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      kind: String(row.kind),
      title: row.title == null ? null : String(row.title),
      parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
      sourceProposalId: row.source_proposal_id == null ? null : String(row.source_proposal_id),
      createdBy: row.created_by == null ? null : String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at == null ? null : String(row.archived_at)
    };
  }

  private rowToSubagentRun(row: Record<string, unknown>): SubagentRunRecord {
    return {
      subagentId: String(row.subagent_id),
      workspaceId: String(row.workspace_id),
      parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
      parentInputId: row.parent_input_id == null ? null : String(row.parent_input_id),
      originMainSessionId: String(row.origin_main_session_id),
      ownerMainSessionId: String(row.owner_main_session_id),
      childSessionId: String(row.child_session_id),
      initialChildInputId: row.initial_child_input_id == null ? null : String(row.initial_child_input_id),
      currentChildInputId: row.current_child_input_id == null ? null : String(row.current_child_input_id),
      latestChildInputId: row.latest_child_input_id == null ? null : String(row.latest_child_input_id),
      title: row.title == null ? null : String(row.title),
      goal: String(row.goal),
      context: row.context == null ? null : String(row.context),
      sourceType: row.source_type == null ? null : String(row.source_type),
      sourceId: row.source_id == null ? null : String(row.source_id),
      proposalId: row.proposal_id == null ? null : String(row.proposal_id),
      cronjobId: row.cronjob_id == null ? null : String(row.cronjob_id),
      retryOfSubagentId: row.retry_of_subagent_id == null ? null : String(row.retry_of_subagent_id),
      toolProfile: this.parseJsonDict(row.tool_profile),
      requestedModel: row.requested_model == null ? null : String(row.requested_model),
      effectiveModel: row.effective_model == null ? null : String(row.effective_model),
      status: String(row.status),
      summary: row.summary == null ? null : String(row.summary),
      latestProgressPayload:
        row.latest_progress_payload == null ? null : this.parseJsonObjectOrMessage(row.latest_progress_payload),
      blockingPayload: row.blocking_payload == null ? null : this.parseJsonObjectOrMessage(row.blocking_payload),
      resultPayload: row.result_payload == null ? null : this.parseJsonObjectOrMessage(row.result_payload),
      errorPayload: row.error_payload == null ? null : this.parseJsonObjectOrMessage(row.error_payload),
      lastEventAt: row.last_event_at == null ? null : String(row.last_event_at),
      ownerTransferredAt: row.owner_transferred_at == null ? null : String(row.owner_transferred_at),
      createdAt: String(row.created_at),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToMainSessionEventQueue(row: Record<string, unknown>): MainSessionEventQueueRecord {
    return {
      eventId: String(row.event_id),
      workspaceId: String(row.workspace_id),
      ownerMainSessionId: String(row.owner_main_session_id),
      originMainSessionId: String(row.origin_main_session_id),
      subagentId: row.subagent_id == null ? null : String(row.subagent_id),
      eventType: String(row.event_type),
      deliveryBucket: String(row.delivery_bucket),
      status: String(row.status),
      payload: this.parseJsonDict(row.payload),
      coalesceKey: row.coalesce_key == null ? null : String(row.coalesce_key),
      earliestDeliverAt: row.earliest_deliver_at == null ? null : String(row.earliest_deliver_at),
      latestDeliverAt: row.latest_deliver_at == null ? null : String(row.latest_deliver_at),
      materializedInputId: row.materialized_input_id == null ? null : String(row.materialized_input_id),
      supersededByEventId: row.superseded_by_event_id == null ? null : String(row.superseded_by_event_id),
      deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
      supersededAt: row.superseded_at == null ? null : String(row.superseded_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  private parseJsonDict(raw: unknown): Record<string, unknown> {
    if (raw == null) {
      return {};
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed as unknown };
    } catch {
      return { message: String(raw) };
    }
  }

  private parseJsonDictList(raw: unknown): Array<Record<string, unknown>> {
    return this.parseJsonList(raw).filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  }

  private parseJsonObjectOrMessage(raw: unknown): Record<string, unknown> | null {
    if (raw == null) {
      return null;
    }
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { message: String(raw) };
    } catch {
      return { message: String(raw) };
    }
  }

  private rowToOutputFolder(row: Record<string, unknown>): OutputFolderRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      position: Number(row.position),
      createdAt: row.created_at == null ? null : String(row.created_at),
      updatedAt: row.updated_at == null ? null : String(row.updated_at)
    };
  }

  private rowToOutput(row: Record<string, unknown>): OutputRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      outputType: String(row.output_type),
      title: row.title == null ? "" : String(row.title),
      status: row.status == null ? "draft" : String(row.status),
      moduleId: row.module_id == null ? null : String(row.module_id),
      moduleResourceId: row.module_resource_id == null ? null : String(row.module_resource_id),
      filePath: row.file_path == null ? null : String(row.file_path),
      htmlContent: row.html_content == null ? null : String(row.html_content),
      sessionId: row.session_id == null ? null : String(row.session_id),
      inputId: row.input_id == null ? null : String(row.input_id),
      artifactId: row.artifact_id == null ? null : String(row.artifact_id),
      folderId: row.folder_id == null ? null : String(row.folder_id),
      platform: row.platform == null ? null : String(row.platform),
      metadata: this.parseJsonDict(row.metadata),
      createdAt: row.created_at == null ? null : String(row.created_at),
      updatedAt: row.updated_at == null ? null : String(row.updated_at)
    };
  }

  private rowToAppBuild(row: Record<string, unknown>): AppBuildRecord {
    return {
      workspaceId: String(row.workspace_id),
      appId: String(row.app_id),
      status: String(row.status),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      error: row.error == null ? null : String(row.error),
      restartAttempts:
        row.restart_attempts == null
          ? 0
          : Math.max(0, Number(row.restart_attempts) || 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToCronjob(row: Record<string, unknown>): CronjobRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      initiatedBy: String(row.initiated_by),
      name: row.name == null ? "" : String(row.name),
      cron: String(row.cron),
      description: String(row.description),
      instruction: row.instruction == null || String(row.instruction).trim().length === 0 ? String(row.description) : String(row.instruction),
      enabled: Boolean(Number(row.enabled)),
      delivery: this.parseJsonDict(row.delivery),
      metadata: this.parseJsonDict(row.metadata),
      lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
      runCount: Number(row.run_count ?? 0),
      lastStatus: row.last_status == null ? null : String(row.last_status),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToRuntimeNotification(row: Record<string, unknown>): RuntimeNotificationRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      cronjobId: row.cronjob_id == null ? null : String(row.cronjob_id),
      sourceType: String(row.source_type),
      sourceLabel: row.source_label == null ? null : String(row.source_label),
      title: String(row.title),
      message: String(row.message),
      level: this.normalizedNotificationLevel(row.level == null ? null : String(row.level)),
      priority: this.normalizedNotificationPriority(row.priority == null ? null : String(row.priority)),
      state: this.normalizedNotificationState(row.state == null ? null : String(row.state)),
      metadata: this.parseJsonDict(row.metadata),
      readAt: row.read_at == null ? null : String(row.read_at),
      dismissedAt: row.dismissed_at == null ? null : String(row.dismissed_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToTaskProposal(row: Record<string, unknown>): TaskProposalRecord {
    const sourceEventIds = this.parseJsonList(row.source_event_ids).filter((item): item is string => typeof item === "string");
    return {
      proposalId: String(row.proposal_id),
      workspaceId: String(row.workspace_id),
      taskName: String(row.task_name),
      taskPrompt: String(row.task_prompt),
      taskGenerationRationale: String(row.task_generation_rationale),
      proposalSource: normalizeTaskProposalSource(row.proposal_source == null ? null : String(row.proposal_source)),
      sourceEventIds,
      createdAt: String(row.created_at),
      state: String(row.state),
      acceptedSessionId: row.accepted_session_id == null ? null : String(row.accepted_session_id),
      acceptedInputId: row.accepted_input_id == null ? null : String(row.accepted_input_id),
      acceptedAt: row.accepted_at == null ? null : String(row.accepted_at)
    };
  }

  private rowToEvolveSkillCandidate(row: Record<string, unknown>): EvolveSkillCandidateRecord {
    const sourceTurnInputIds = this.parseJsonList(row.source_turn_input_ids).filter(
      (item): item is string => typeof item === "string"
    );
    return {
      candidateId: String(row.candidate_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      inputId: String(row.input_id),
      taskProposalId: row.task_proposal_id == null ? null : String(row.task_proposal_id),
      kind: normalizeEvolveSkillCandidateKind(row.kind == null ? null : String(row.kind)),
      status: normalizeEvolveSkillCandidateState(row.status == null ? null : String(row.status)),
      title: String(row.title),
      summary: String(row.summary),
      slug: String(row.slug),
      skillPath: String(row.skill_path),
      contentFingerprint: String(row.content_fingerprint),
      confidence:
        typeof row.confidence === "number" && Number.isFinite(row.confidence)
          ? row.confidence
          : row.confidence == null
            ? null
            : Number.isFinite(Number(row.confidence))
              ? Number(row.confidence)
              : null,
      evaluationNotes: row.evaluation_notes == null ? null : String(row.evaluation_notes),
      sourceTurnInputIds,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      proposedAt: row.proposed_at == null ? null : String(row.proposed_at),
      dismissedAt: row.dismissed_at == null ? null : String(row.dismissed_at),
      acceptedAt: row.accepted_at == null ? null : String(row.accepted_at),
      promotedAt: row.promoted_at == null ? null : String(row.promoted_at),
    };
  }

  private rowToMemoryUpdateProposal(row: Record<string, unknown>): MemoryUpdateProposalRecord {
    return {
      proposalId: String(row.proposal_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      inputId: String(row.input_id),
      proposalKind: String(row.proposal_kind) as MemoryUpdateProposalKind,
      targetKey: String(row.target_key),
      title: String(row.title),
      summary: String(row.summary),
      payload: this.parseJsonDict(row.payload),
      evidence: row.evidence == null ? null : String(row.evidence),
      confidence: row.confidence == null ? null : Number(row.confidence),
      sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
      state: String(row.state) as MemoryUpdateProposalState,
      persistedMemoryId: row.persisted_memory_id == null ? null : String(row.persisted_memory_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      acceptedAt: row.accepted_at == null ? null : String(row.accepted_at),
      dismissedAt: row.dismissed_at == null ? null : String(row.dismissed_at),
    };
  }

  private parseJsonList(raw: unknown): unknown[] {
    if (raw == null) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private normalizedNullableText(value: string | null | undefined): string | null {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
  }

  private requiredNormalizedText(value: string | null | undefined, fieldName: string): string {
    const normalized = this.normalizedNullableText(value);
    if (!normalized) {
      throw new Error(`${fieldName} is required`);
    }
    return normalized;
  }

  private normalizedConversationBindingRole(value: string | null | undefined): string {
    return this.normalizedNullableText(value) ?? "main";
  }

  private normalizedSessionKind(value: string | null | undefined): string {
    return this.normalizedNullableText(value) ?? "workspace_session";
  }

  private normalizedNotificationLevel(value: string | null | undefined): RuntimeNotificationLevel {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (normalized === "success" || normalized === "warning" || normalized === "error") {
      return normalized;
    }
    return "info";
  }

  private normalizedNotificationPriority(value: string | null | undefined): RuntimeNotificationPriority {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (normalized === "low" || normalized === "high" || normalized === "critical") {
      return normalized;
    }
    return "normal";
  }

  private notificationPrioritySortSql(tableAlias = ""): string {
    const prefix = tableAlias ? `${tableAlias}.` : "";
    return `CASE ${prefix}priority WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END`;
  }

  private notificationPriorityWeight(priority: RuntimeNotificationPriority): number {
    switch (priority) {
      case "critical":
        return 3;
      case "high":
        return 2;
      case "normal":
        return 1;
      default:
        return 0;
    }
  }

  private normalizedNotificationState(value: string | null | undefined): RuntimeNotificationState {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (normalized === "read" || normalized === "dismissed") {
      return normalized;
    }
    return "unread";
  }

  private requireSession(params: { workspaceId: string; sessionId: string }): AgentSessionRecord {
    const record = this.getSession(params);
    if (!record) {
      throw new Error("agent session row not found");
    }
    return record;
  }

  private updateConversationBinding(params: {
    workspaceId: string;
    bindingId: string;
    fields: ConversationBindingUpdateFields;
  }): ConversationBindingRecord | null {
    const existing = this.getConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
    });
    if (!existing) {
      return null;
    }
    const next: ConversationBindingRecord = {
      ...existing,
      sessionId:
        params.fields.sessionId === undefined
          ? existing.sessionId
          : this.requiredNormalizedText(params.fields.sessionId, "sessionId"),
      role:
        params.fields.role === undefined
          ? existing.role
          : this.normalizedConversationBindingRole(params.fields.role),
      isActive: params.fields.isActive === undefined ? existing.isActive : Boolean(params.fields.isActive),
      metadata: params.fields.metadata === undefined ? existing.metadata : params.fields.metadata,
      lastActiveAt:
        params.fields.lastActiveAt === undefined
          ? existing.lastActiveAt
          : this.normalizedNullableText(params.fields.lastActiveAt),
      updatedAt: utcNowIso(),
    };

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE conversation_bindings
        SET session_id = ?,
            role = ?,
            is_active = ?,
            metadata = ?,
            last_active_at = ?,
            updated_at = ?
        WHERE binding_id = ?
      `)
      .run(
        next.sessionId,
        next.role,
        next.isActive ? 1 : 0,
        JSON.stringify(next.metadata),
        next.lastActiveAt,
        next.updatedAt,
        params.bindingId
      );
    return this.getConversationBinding({
      workspaceId: params.workspaceId,
      bindingId: params.bindingId,
    });
  }

  private listMainSessionEventsByIds(workspaceId: string, eventIds: string[]): MainSessionEventQueueRecord[] {
    if (eventIds.length === 0) {
      return [];
    }
    const rows = this.workspaceRuntimeDb(workspaceId)
      .prepare(`
        SELECT *
        FROM main_session_event_queue
        WHERE event_id IN (${eventIds.map(() => "?").join(", ")})
        ORDER BY datetime(created_at) ASC, event_id ASC
      `)
      .all(...eventIds) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMainSessionEventQueue(row));
  }

  private requireUpdatedSession(params: {
    workspaceId: string;
    sessionId: string;
    fields: AgentSessionUpdateFields;
  }): AgentSessionRecord {
    const existing = this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
    const next: AgentSessionRecord = {
      ...existing,
      kind: params.fields.kind == null ? existing.kind : this.normalizedSessionKind(params.fields.kind),
      title: params.fields.title === undefined ? existing.title : this.normalizedNullableText(params.fields.title),
      parentSessionId:
        params.fields.parentSessionId === undefined
          ? existing.parentSessionId
          : this.normalizedNullableText(params.fields.parentSessionId),
      sourceProposalId:
        params.fields.sourceProposalId === undefined
          ? existing.sourceProposalId
          : this.normalizedNullableText(params.fields.sourceProposalId),
      createdBy:
        params.fields.createdBy === undefined ? existing.createdBy : this.normalizedNullableText(params.fields.createdBy),
      archivedAt:
        params.fields.archivedAt === undefined ? existing.archivedAt : this.normalizedNullableText(params.fields.archivedAt),
      updatedAt: utcNowIso()
    };

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE agent_sessions
        SET kind = ?,
            title = ?,
            parent_session_id = ?,
            source_proposal_id = ?,
            created_by = ?,
            updated_at = ?,
            archived_at = ?
        WHERE workspace_id = ? AND session_id = ?
      `)
      .run(
        next.kind,
        next.title,
        next.parentSessionId,
        next.sourceProposalId,
        next.createdBy,
        next.updatedAt,
        next.archivedAt,
        params.workspaceId,
        params.sessionId
      );

    return this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
  }
}
