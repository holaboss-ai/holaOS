import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
const WORKSPACE_IDENTITY_LOCK_FILENAME = `${WORKSPACE_IDENTITY_FILENAME}.lock`;
/** Bump to re-ANALYZE when semantic-memory index coverage changes. */
const SEMANTIC_MEMORY_PLANNER_STATS_MARKER = "semantic_memory_nodes_analyze_v1";
const WORKSPACE_IDENTITY_WRITE_RETRY_ATTEMPTS = 3;
const WORKSPACE_IDENTITY_WRITE_RETRY_DELAY_MS = 25;
const WORKSPACE_IDENTITY_LOCK_RETRY_ATTEMPTS = 20;
const WORKSPACE_IDENTITY_LOCK_RETRY_DELAY_MS = 25;
const WORKSPACE_IDENTITY_LOCK_STALE_MS = 30_000;
const WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY =
  "legacy_workspace_backfill_v1_complete";
// Persisted (root-DB) marker: the legacy host-state monolith has already been folded
// into the root. Guards against re-folding it on a later store open — the monolith file
// is kept intact (never retired), so without this the fold re-INSERTs a `projects` row
// for every legacy workspace_id (INSERT OR IGNORE) on every launch, silently
// resurrecting projects the user has since deleted.
const HOST_STATE_MONOLITH_FOLDED_MARKER_KEY = "host_state_monolith_folded_v1";
const MAIN_SESSION_KIND = "main_session";
const SUBAGENT_SESSION_KIND = "subagent";
const MAIN_SESSION_BINDING_ROLE = "main_session";
const MAIN_SESSION_CONVERSATION_KEY = "main_session";
const CORE_WORKSPACE_PLUGIN_ID = "core";
const CORE_WORKSPACE_PLUGIN_NAME = "Core";
// Per-workspace tables whose rows are migrated from the legacy single
// multi-workspace runtime.db into each per-workspace DB on first open.
// `backfillWorkspaceScopedTableRows` scopes the legacy SELECT by
// `WHERE workspace_id = ?` (the legacy table still has the column) and inserts
// only the columns the per-workspace target actually has — so tables whose
// `workspace_id` column was dropped (migrations 028/029) still backfill
// correctly: the column is simply omitted from the copied set.
const WORKSPACE_SCOPED_LEGACY_BACKFILL_TABLES = [
  "main_session_event_queue",
  "subagent_runs",
  "terminal_sessions",
  "terminal_session_events",
  "turn_results",
  "turn_request_snapshots",
  "issues",
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
// workspace-removal Piece 5.7: the integration knowledge graph is control-plane
// ONLY. The root data.db schema no longer creates these tables and migration 030
// drops any pre-existing per-workspace/root copy, so the root-consolidation folds
// (consolidateWorkspaceRuntimeDbsIntoRoot / consolidateHostStateMonolithIntoRoot)
// must NEVER copy them into root. They are plain tables, so the `_fts`/`_vec`/
// virtual-table skip in those filters does not exclude them — this explicit set
// does. (Their rows are derived/rebuildable and intentionally discarded.)
const INTEGRATION_GRAPH_ROOT_SKIP_TABLES = new Set<string>([
  "integration_trees",
  "integration_leaves",
  "integration_node_embeddings",
]);
const SYNC_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

type RuntimeStateStoreWorkspaceErrorCode =
  | "workspace_folder_missing"
  | "workspace_identity_write_busy"
  | "workspace_identity_write_failed";

type RuntimeStateStoreWorkspaceError = Error & {
  code?: RuntimeStateStoreWorkspaceErrorCode;
  workspacePath?: string;
  cause?: unknown;
};

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(SYNC_SLEEP_BUFFER, 0, 0, ms);
}

function createWorkspaceFolderMissingError(workspacePath: string): RuntimeStateStoreWorkspaceError {
  const err = new Error(
    `workspace folder is missing at ${workspacePath}. Relocate the workspace or delete the record.`,
  ) as RuntimeStateStoreWorkspaceError;
  err.code = "workspace_folder_missing";
  err.workspacePath = workspacePath;
  return err;
}

function createWorkspaceIdentityWriteError(params: {
  workspacePath: string;
  detail: string;
  code?: RuntimeStateStoreWorkspaceErrorCode;
  cause?: unknown;
}): RuntimeStateStoreWorkspaceError {
  const err = new Error(
    `failed to persist workspace identity file under ${params.workspacePath}: ${params.detail}`,
  ) as RuntimeStateStoreWorkspaceError;
  err.code = params.code ?? "workspace_identity_write_failed";
  err.workspacePath = params.workspacePath;
  err.cause = params.cause;
  return err;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
    );
  }
  return value;
}

// workspace-removal Piece 5.10: the single-tenant runtime collapses to ONE
// synthetic root workspace with this constant id (no `workspaces` table lookup).
// Shared with the api-server canonical resolver + the desktop. `ROOT_WORKSPACE_EPOCH`
// is the fallback for the root's timestamps when no real row exists to borrow from
// (Date.now()/new Date() are banned in this file).
export const ROOT_WORKSPACE_ID = "root";
const ROOT_WORKSPACE_EPOCH = "1970-01-01T00:00:00.000Z";

export interface WorkspaceRecord {
  id: string;
  name: string;
  status: string;
  harness: string | null;
  errorMessage: string | null;
  onboardingStatus: string;
  onboardingState: string | null;
  onboardingSessionId: string | null;
  onboardingAlignmentQuestion: string | null;
  onboardingAlignmentReport: string | null;
  onboardingVerificationReport: string | null;
  onboardingCompletedAt: string | null;
  onboardingCompletionSummary: string | null;
  onboardingRequestedAt: string | null;
  onboardingRequestedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAtUtc: string | null;
  icon: string | null;
  iconColor: string | null;
  workspaceRole: string;
  sourceWorkspaceId: string | null;
  labPurpose: string | null;
  labStatus: string | null;
}

export interface AgentSessionRecord {
  workspaceId: string;
  sessionId: string;
  kind: string;
  title: string | null;
  parentSessionId: string | null;
  createdBy: string | null;
  /**
   * When non-null, the session belongs to a project inside the workspace and
   * the agent run uses the project's `project_path` as its cwd. Null means
   * the session is workspace-scoped ("General") and uses the workspace path.
   */
  projectId: string | null;
  /**
   * The harness bound to this session (e.g. "pi" for Hola, "claude-code",
   * "codex"). Picked at creation by the user and immutable thereafter —
   * switching harnesses mid-session is not supported. Null only on legacy
   * rows from before migration 018; treat null as "pi".
   */
  harnessId: string | null;
  /**
   * The HolaApp that owns this session, or null for an ordinary workspace/
   * project session. App sessions are listed via the app's own dropdown (not the
   * workspace sidebar) and their agent run is restricted to strictly that app's
   * MCP tools. Immutable — set at creation. See migration 032.
   */
  owningAppId: string | null;
  /**
   * The org this session belongs to (org-owned sessions). Stamped at creation
   * from the then-active org and immutable thereafter — every agent run in the
   * session bills this org, regardless of which org is active later. Null =
   * legacy row (created before migration 033) or an unattributed session; the
   * run falls back to the live runtime-config org. See migration 033.
   */
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  activeUserQuestion: string | null;
}

export interface WorkspaceProjectRecord {
  workspaceId: string;
  projectId: string;
  name: string;
  /** Independent directory on disk; NOT required to live under workspacePath. */
  projectPath: string;
  icon: string | null;
  iconColor: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface ChannelConnectionRecord {
  connectionId: string;
  workspaceId: string;
  platform: string;
  enabled: boolean;
  token: string | null;
  botUsername: string | null;
  allowFrom: string[];
  requireMention: boolean;
  apiBaseUrl: string | null;
  status: string;
  statusDetail: string | null;
  config: Record<string, unknown>;
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
  contextCronAutoFetchEnabled: boolean;
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


export type WorkspaceCapabilityStatus = "active" | "disabled";

export interface WorkspaceCapabilityRecord {
  workspaceId: string;
  capabilityId: string;
  version: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  status: WorkspaceCapabilityStatus;
  installedSkillIds: string[];
  integrationStatus: Record<string, string>;
  config: Record<string, unknown>;
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
  issueId: string | null;
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
  workflowRunId: string | null;
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
  timezone: string | null;
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

export type InteractionEntityType =
  | "project"
  | "workflow"
  | "preference"
  | "identity"
  | "person"
  | "customer"
  | "system"
  | "topic"
  | "misc";
export type InteractionEntityStatus = "active" | "archived";
export type InteractionLeafStatus = "active" | "superseded" | "archived";
export type InteractionTreeChildKind = "leaf" | "summary";
export type IntegrationTreeStatus = "active" | "archived";
export type IntegrationLeafStatus = "active" | "superseded" | "archived";
export type MemoryNodeKind = "tree" | "entity" | "branch" | "summary" | "leaf";
export type MemoryNodeStatus = "active" | "superseded" | "retired" | "archived";
export type SemanticMemoryCategory = "interaction" | "integration" | "workspace";
export type SemanticMemoryNodeClass = "semantic" | "leaf";

export interface InteractionEntityRecord {
  workspaceId: string;
  entityId: string;
  entityType: InteractionEntityType;
  canonicalName: string;
  slug: string;
  summary: string | null;
  aliases: string[];
  isSystem: boolean;
  status: InteractionEntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionLeafRecord {
  workspaceId: string;
  leafId: string;
  entityId: string;
  subjectKey: string;
  path: string;
  title: string;
  summary: string;
  fingerprint: string;
  bodySha256: string;
  tags: string[];
  secondaryEntityIds: string[];
  sourceType: string | null;
  sourceEventId: string | null;
  sourceMessageId: string | null;
  sourceTurnInputId: string | null;
  admissionConfidence: number | null;
  entityConfidence: number | null;
  observedAt: string | null;
  supersedesLeafId: string | null;
  supersededAt: string | null;
  status: InteractionLeafStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionNodeEmbeddingRecord {
  workspaceId: string;
  nodeKind: InteractionTreeChildKind;
  nodeId: string;
  entityId: string;
  embeddingModel: string;
  contentFingerprint: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
  updatedAt: string;
}

export interface InteractionNodeEmbeddingVectorSearchResult {
  vecRowid: number;
  distance: number;
  workspaceId: string;
  nodeKind: InteractionTreeChildKind;
  nodeId: string;
  entityId: string;
  embeddingModel: string;
}

export interface IntegrationTreeRecord {
  workspaceId?: string | null;
  treeId: string;
  provider: string;
  ownerUserId: string;
  accountNamespace: string;
  accountDisplayName: string;
  accountKey: string;
  accountLabel: string;
  slug: string;
  summary: string | null;
  status: IntegrationTreeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationLeafRecord {
  workspaceId?: string | null;
  leafId: string;
  treeId: string;
  subjectKey: string;
  entityKey: string | null;
  entityLabel: string | null;
  branchKey: string | null;
  branchLabel: string | null;
  path: string;
  title: string;
  summary: string;
  fingerprint: string;
  bodySha256: string;
  tags: string[];
  sourceType: string | null;
  sourceEventId: string | null;
  sourceMessageId: string | null;
  externalObjectId: string | null;
  externalObjectType: string | null;
  admissionConfidence: number | null;
  observedAt: string | null;
  supersedesLeafId: string | null;
  supersededAt: string | null;
  status: IntegrationLeafStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationNodeEmbeddingRecord {
  workspaceId?: string | null;
  nodeKind: InteractionTreeChildKind;
  nodeId: string;
  treeId: string;
  embeddingModel: string;
  contentFingerprint: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationNodeEmbeddingVectorSearchResult {
  vecRowid: number;
  distance: number;
  workspaceId?: string | null;
  nodeKind: InteractionTreeChildKind;
  nodeId: string;
  treeId: string;
  embeddingModel: string;
}

export interface SemanticMemoryNodeRecord {
  workspaceId: string | null;
  category: SemanticMemoryCategory;
  treeId: string;
  nodeId: string;
  nodeClass: SemanticMemoryNodeClass;
  nodeKind: string;
  sourceLeafId: string | null;
  path: string;
  title: string;
  summary: string;
  bodySha256: string;
  childCount: number;
  observedAt: string | null;
  status: MemoryNodeStatus;
  isMaterialized: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticMemoryContainmentEdgeRecord {
  workspaceId: string | null;
  category: SemanticMemoryCategory;
  treeId: string;
  parentNodeId: string;
  childNodeId: string;
  position: number;
  createdAt: string;
}

export interface SemanticMemoryRelationRecord {
  workspaceId: string | null;
  category: SemanticMemoryCategory;
  treeId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticMemoryEvidenceRefRecord {
  workspaceId: string | null;
  category: SemanticMemoryCategory;
  treeId: string;
  nodeId: string;
  refId: string;
  provider: string | null;
  accountNamespace: string | null;
  connectionId: string | null;
  externalObjectId: string | null;
  externalObjectType: string | null;
  sourceType: string | null;
  sourceEventId: string | null;
  sourceMessageId: string | null;
  sourceTurnInputId: string | null;
  observedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticMemorySearchDocRecord {
  workspaceId: string | null;
  category: SemanticMemoryCategory;
  treeId: string;
  nodeId: string;
  nodeClass: SemanticMemoryNodeClass;
  nodeKind: string;
  path: string;
  childCount: number;
  title: string;
  summary: string;
  bodyText: string;
  excerpt: string | null;
  observedAt: string | null;
  status: MemoryNodeStatus;
  updatedAt: string;
}

export interface SemanticMemorySearchHitRecord extends SemanticMemorySearchDocRecord {
  bm25Score: number;
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
  /**
   * Project this output belongs to, mirroring `agent_sessions.project_id`.
   * Outputs produced by a project session carry the project's id and are
   * physically written under `<project_path>/outputs/`; General-session
   * outputs are NULL and live under `<workspace_dir>/outputs/`.
   */
  projectId: string | null;
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

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked";
export type IssuePriority = "critical" | "high" | "medium" | "low";
export const ISSUE_BLOCKED_BY_RELATIONS = ["input", "handoff"] as const;
export type IssueBlockedByRelation = typeof ISSUE_BLOCKED_BY_RELATIONS[number];

export function normalizeIssueBlockedByRelation(value: string | null | undefined): IssueBlockedByRelation | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }
  if ((ISSUE_BLOCKED_BY_RELATIONS as readonly string[]).includes(normalized)) {
    return normalized as IssueBlockedByRelation;
  }
  throw new Error(
    `unsupported issue blocked_by relation "${normalized}"; expected one of: ${ISSUE_BLOCKED_BY_RELATIONS.join(", ")}`,
  );
}

export interface IssueAttachmentRecord {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mimeType: string;
  sizeBytes: number;
  workspacePath: string;
  createdAt: string;
}

export interface IssueBlockedByRecord {
  taskId: string;
  relation: IssueBlockedByRelation;
  instruction: string | null;
}

export interface IssueRecord {
  issueId: string;
  workspaceId: string;
  issueNumber: number;
  sessionId: string;
  sourceType: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority | null;
  assigneeId: string | null;
  blockedBy: IssueBlockedByRecord[];
  blockerReason: string | null;
  attachments: IssueAttachmentRecord[];
  activeSubagentId: string | null;
  latestSubagentId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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

export interface RuntimeStateStoreOptions {
  hostStateDbPath?: string;
  dbPath?: string;
  controlPlaneDbPath?: string;
  workspaceRoot?: string;
  sandboxRoot?: string;
  sandboxAgentHarness?: string;
  portInUseProbe?: (port: number) => boolean;
  /**
   * Optional structured log hook for schema migrations. Wire to pino/Sentry
   * in api-server; tests can pass a recorder. Receives events shaped like
   * `{event: "migrations.applied", id: 3, name: "...", durationMs: 12}`.
   */
  onMigrationEvent?: (event: MigrationLogEvent) => void;
  /**
   * Retention policy for the append-only `session_output_events` log. Enforced
   * lazily — a bounded per-session cap trim on each run's terminal event (write
   * path) plus a batched background sweep (age + cap) driven by the api-server —
   * never as a blocking boot-time delete. Merged over
   * {@link DEFAULT_OUTPUT_EVENT_RETENTION}; tests override with tiny values.
   */
  outputEventRetention?: Partial<OutputEventRetentionPolicy>;
}

/**
 * Retention policy for `session_output_events` — the streaming per-turn event
 * log that the desktop replays as session history. It is append-only and had no
 * pruning historically, so it grew unbounded (multi-GB data.db, runaway sessions
 * with hundreds of thousands of rows). Both knobs are enforced lazily and can be
 * disabled by setting to 0.
 */
export interface OutputEventRetentionPolicy {
  /** Delete events older than this many days. 0 disables age-based pruning. */
  maxAgeDays: number;
  /** Keep at most this many (newest) events per session. 0 disables the cap. */
  maxEventsPerSession: number;
  /**
   * Keep at most this many (newest) events across ALL sessions. 0 disables it.
   *
   * The backstop the other two knobs cannot provide: neither bounds the number
   * of SESSIONS. In the field 162 scheduled sessions each sat at exactly the
   * 25k per-session cap — 2.29M rows, 1.9GB, entirely within policy and nothing
   * prunable — and boot cost scales with the file.
   */
  maxTotalEvents: number;
}

/**
 * "Balanced" default: keep 30 days of replayable history, and cap any single
 * session at 25k events (trims runaway agent loops without touching normal
 * sessions). Chosen with the product owner over the aggressive/conservative
 * alternatives.
 */
export const DEFAULT_OUTPUT_EVENT_RETENTION: OutputEventRetentionPolicy = {
  maxAgeDays: 30,
  maxEventsPerSession: 25_000,
  // ~250k events measured out at roughly 200MB on real data (~830 bytes/row),
  // against the 1.9GB that 2.29M rows produced. Comfortably above real
  // interactive use — the same install had 19.5k events across every chat it
  // had ever held — so this only ever bites the runaway case it exists for.
  maxTotalEvents: 250_000,
};

/**
 * States for the `data.db.open` marker. The distinction exists because the
 * boot-time integrity check is unbounded and the desktop's startup probe is not:
 * without a way to tell "died while open" from "died while checking", a check
 * that outlives the probe re-arms itself on every boot and never completes.
 */
const ROOT_DB_MARKER_OPEN = "open";
const ROOT_DB_MARKER_CHECKING = "checking";

/**
 * Cap on how many over-the-limit events the WRITE path trims per run completion,
 * so a first-time trim of a huge legacy session can't block the hot path with a
 * 300k-row DELETE. The background sweep clears any remaining backlog.
 */
const WRITE_PATH_TRIM_LIMIT = 2_000;

/**
 * Only bother compacting data.db when at least this fraction of its pages are on
 * the freelist (i.e. reclaimable). Pruning frees pages to the freelist without
 * shrinking the file; below this ratio a VACUUM isn't worth the one-time boot
 * cost.
 */
const ROOT_DB_COMPACT_MIN_FREE_RATIO = 0.2;

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Validate a `VACUUM INTO` output before it is allowed to replace the live
 * data.db: it must pass `quick_check` and carry the exact schema version we
 * compacted from. A corrupt or version-skewed copy is rejected so it can never
 * clobber good data.
 */
function validateCompactedRootDb(
  copyPath: string,
  expectedUserVersion: number,
): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(copyPath, { readonly: true });
    if (db.pragma("quick_check", { simple: true }) !== "ok") {
      return false;
    }
    return (
      (db.pragma("user_version", { simple: true }) as number) ===
      expectedUserVersion
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

type AgentSessionUpdateFields = Partial<{
  kind: string | null;
  title: string | null;
  parentSessionId: string | null;
  createdBy: string | null;
  projectId: string | null;
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


type IssueUpdateFields = Partial<{
  sessionId: string;
  sourceType: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority | null;
  assigneeId: string | null;
  blockedBy: IssueBlockedByRecord[];
  blockerReason: string | null;
  attachments: IssueAttachmentRecord[];
  activeSubagentId: string | null;
  latestSubagentId: string | null;
  createdBy: string | null;
  completedAt: string | null;
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
  issueId: string | null;
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
  onboarding_state: string | null;
  onboarding_session_id: string | null;
  onboarding_alignment_question: string | null;
  onboarding_alignment_report: string | null;
  onboarding_verification_report: string | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at_utc: string | null;
  icon: string | null;
  icon_color: string | null;
  workspace_role: string | null;
  source_workspace_id: string | null;
  lab_purpose: string | null;
  lab_status: string | null;
};


export function utcNowIso(): string {
  return new Date().toISOString();
}

function parseJsonStringArray(raw: unknown): string[] {
  if (raw == null) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonStringRecord(raw: unknown): Record<string, string> {
  if (raw == null) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        result[key] = String(value);
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
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

function defaultPortInUseProbe(port: number): boolean {
  const normalizedPort = Math.trunc(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    try {
      const command = [
        `$port = ${normalizedPort};`,
        "$conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue;",
        "if ($conn) { exit 0 }",
        "exit 1",
      ].join(" ");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        {
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
        },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }

  try {
    const result = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${normalizedPort}`, "-sTCP:LISTEN", "-t"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return (result.stdout?.toString("utf8").trim() ?? "").length > 0;
  } catch {
    return false;
  }
}

export class RuntimeStateStore {
  readonly dbPath: string;
  readonly legacyDbPath: string;
  readonly usesImplicitHostStatePath: boolean;
  readonly controlPlaneDbPath: string;
  /**
   * Phase A (workspace-removal Piece 5) DORMANT machinery. Path to the single
   * root runtime DB (`data.db`) that will eventually hold ALL former workspaces'
   * runtime data folded together as projects. NOT used by any production path
   * yet — only `rootRuntimeDb()` / `consolidateWorkspaceRuntimeDbsIntoRoot()`
   * (and their tests) touch it. Phase B will flip `workspaceRuntimeDb` to return
   * this DB; until then nothing here is wired into open/init/session routing.
   */
  readonly rootRuntimeDbPath: string;
  readonly workspaceRoot: string;
  readonly sandboxAgentHarness: string | null;
  readonly #onMigrationEvent: ((event: MigrationLogEvent) => void) | undefined;
  readonly #outputEventRetention: OutputEventRetentionPolicy;
  readonly #portInUseProbe: (port: number) => boolean;
  // In-process signal fired after each session_output_event insert, so the SSE
  // stream can wake on write instead of polling on a fixed interval — the
  // difference between smooth token streaming and 20-bursts/sec jerkiness. The
  // emitter carries the sessionId; the SSE loop keeps a fixed-interval sleep as
  // a fallback, so a cross-process writer (no signal) simply degrades to polling
  // with no missed events. maxListeners=0 → unbounded concurrent streams.
  readonly #outputEventNotifier = new EventEmitter().setMaxListeners(0);
  #db: Database.Database | null = null;
  #controlPlaneDb: Database.Database | null = null;
  // The single root runtime DB (data.db) shared by every live workspace; opened
  // lazily by rootRuntimeDb(). See rootRuntimeDbPath.
  #rootRuntimeDb: Database.Database | null = null;
  #workspaceRuntimeDbs: Map<string, { dbPath: string; db: Database.Database }> = new Map();
  #vectorIndexSupported = false;
  #statementCache: Map<string, Database.Statement> = new Map();

  constructor(options: RuntimeStateStoreOptions = {}) {
    this.dbPath = hostStateDbPath(options);
    this.legacyDbPath = legacyRuntimeDbPath(options);
    this.usesImplicitHostStatePath = !hasExplicitHostStatePath(options);
    this.controlPlaneDbPath = controlPlaneDbPath(options);
    // Phase A DORMANT: sibling of control-plane.db at <state>/data.db. Computed
    // here so the path is stable/observable, but the file is created only when
    // rootRuntimeDb() is first called (consolidation / Phase B), never on init.
    this.rootRuntimeDbPath = path.join(path.dirname(this.controlPlaneDbPath), "data.db");
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(os.tmpdir(), "workspace-root"));
    this.#onMigrationEvent = options.onMigrationEvent;
    this.#outputEventRetention = {
      ...DEFAULT_OUTPUT_EVENT_RETENTION,
      ...(options.outputEventRetention ?? {}),
    };
    this.sandboxAgentHarness = (options.sandboxAgentHarness ?? process.env.SANDBOX_AGENT_HARNESS ?? "").trim() || null;
    this.#portInUseProbe = options.portInUseProbe ?? defaultPortInUseProbe;
  }

  close(): void {
    this.#statementCache.clear();
    this.#db?.close();
    this.#db = null;
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.#controlPlaneDb?.close();
    }
    this.#controlPlaneDb = null;
    // Phase A DORMANT root runtime DB (data.db). Distinct file from all others,
    // so an unconditional close is safe.
    this.#rootRuntimeDb?.close();
    this.#rootRuntimeDb = null;
    // Clean shutdown: clear the dirty marker so the next open skips the
    // integrity check (a cleanly-closed DB cannot be left inconsistent).
    try {
      fs.rmSync(this.rootDbDirtyMarkerPath(), { force: true });
    } catch {
      // best-effort
    }
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

  workspaceTransaction<T>(workspaceId: string, fn: () => T): T {
    return this.workspaceRuntimeDb(workspaceId).transaction(fn)();
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

  private workspacePathState(workspacePath: string): "healthy" | "missing" {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    try {
      if (fs.existsSync(resolvedWorkspacePath) && fs.statSync(resolvedWorkspacePath).isDirectory()) {
        return "healthy";
      }
    } catch {
      // Fall through — any stat error means we can't trust the folder.
    }
    return "missing";
  }

  private assertWorkspacePathHealthy(workspacePath: string): string {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    if (this.workspacePathState(resolvedWorkspacePath) === "healthy") {
      return resolvedWorkspacePath;
    }
    throw createWorkspaceFolderMissingError(resolvedWorkspacePath);
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
    return this.workspacePathState(this.workspaceDir(workspaceId));
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
    throw createWorkspaceFolderMissingError(dir);
  }

  /**
   * Single-tenant end-state (Piece 5.10): the runtime is ONE synthetic root
   * workspace. Callers see exactly one workspace (`ROOT_WORKSPACE_ID`); the
   * former per-workspace rows now live as `projects`. The `workspaces` table is
   * still read internally (consolidation, harness/name borrow) until Piece 5.11
   * drops it.
   */
  listWorkspaces(_options: { includeDeleted?: boolean } = {}): WorkspaceRecord[] {
    return [this.syntheticRootWorkspace()];
  }

  getWorkspace(
    _workspaceId: string,
    _options: { includeDeleted?: boolean } = {},
  ): WorkspaceRecord | null {
    // Lenient: any id resolves to the single root, so existing `if (!ws) 404`
    // guards never fire in the single-tenant runtime.
    return this.syntheticRootWorkspace();
  }

  /**
   * The REAL `workspaces` registry rows (control-plane table). The one-time
   * consolidation must iterate each ACTUAL former workspace to fold it — never
   * the synthetic root — so it uses this, not `listWorkspaces()`. Removed with
   * the table in Piece 5.11.
   */
  /**
   * True while the legacy `workspaces` registry table still exists. The
   * consolidation drops it (Piece 5.11) once every workspace is folded into
   * projects; after that the synthetic root + its readers run off config + the
   * `projects` table alone.
   */
  private workspacesTableExists(): boolean {
    return Boolean(
      this.controlPlaneDb()
        .prepare(
          "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'workspaces'",
        )
        .get(),
    );
  }

  private listRegisteredWorkspaceRecords(
    options: { includeDeleted?: boolean } = {},
  ): WorkspaceRecord[] {
    this.ensureWorkspaceMetadataReady();
    if (!this.workspacesTableExists()) {
      return [];
    }
    // `SELECT *`, not an explicit column list: this reads a LEGACY table that is
    // about to be folded into `projects` and dropped (Piece 5.11), and whose
    // schema drifts across old installs. Piece 5.11 removed `ensureWorkspacesTableSchema`,
    // which used to back-fill late columns (`onboarding_state`, `icon`, `lab_*`,
    // `workspace_role`, …) via ALTER on every boot — so an older row may be missing
    // any of them. `workspaceRecordFromRowLike` reads each field with a loose
    // `== null` guard, so a column absent from `SELECT *` arrives as `undefined`
    // and maps to `null`. The required (`id`/`name`/`status`/`onboarding_status`)
    // and ORDER BY columns are part of the original base schema, always present.
    const rows = this.controlPlaneDb()
      .prepare<[], WorkspaceRow>(`
        SELECT * FROM workspaces
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `)
      .all();
    const items = rows.map((row) => this.rowToWorkspace(row));
    return items.filter(
      (record) => options.includeDeleted || !record.deletedAtUtc,
    );
  }

  /** Filesystem home of the synthetic root (its own managed folder). */
  private rootWorkspacePath(): string {
    return this.defaultWorkspaceDir(ROOT_WORKSPACE_ID);
  }

  /**
   * The single synthetic root workspace record. Borrows harness/name/timestamps
   * from the most-recently-updated real row (continuity for existing installs),
   * falling back to config + a fixed epoch when the table is empty/gone.
   */
  private syntheticRootWorkspace(): WorkspaceRecord {
    const live = this.listRegisteredWorkspaceRecords({ includeDeleted: false })[0] ?? null;
    return {
      id: ROOT_WORKSPACE_ID,
      name: live?.name || "Workspace",
      status: "active",
      harness: live?.harness ?? this.sandboxAgentHarness,
      errorMessage: null,
      onboardingStatus: "not_required",
      onboardingState: null,
      onboardingSessionId: null,
      onboardingAlignmentQuestion: null,
      onboardingAlignmentReport: null,
      onboardingVerificationReport: null,
      onboardingCompletedAt: null,
      onboardingCompletionSummary: null,
      onboardingRequestedAt: null,
      onboardingRequestedBy: null,
      createdAt: live?.createdAt ?? ROOT_WORKSPACE_EPOCH,
      updatedAt: live?.updatedAt ?? ROOT_WORKSPACE_EPOCH,
      deletedAtUtc: null,
      icon: null,
      iconColor: null,
      workspaceRole: "source",
      sourceWorkspaceId: null,
      labPurpose: null,
      labStatus: null,
    };
  }

  /**
   * Look up one workspace by id in the REAL `workspaces` registry table (not the
   * synthetic root). Registry-backed callers must consult the actual registry:
   * post-workspace-removal `getWorkspace` returns the synthetic root for ANY id,
   * so a direct registry read is the only way to tell whether a row genuinely
   * exists. Returns null when the registry table is absent.
   */
  private getRegisteredWorkspaceRecord(
    workspaceId: string,
    options: { includeDeleted?: boolean } = {},
  ): WorkspaceRecord | null {
    return (
      this.listRegisteredWorkspaceRecords(options).find(
        (record) => record.id === workspaceId,
      ) ?? null
    );
  }

  /**
   * Returns the absolute root directory under which a session's outputs are
   * written and read. Project-bound sessions get the project's own
   * directory; General sessions and sessions in unknown projects fall back
   * to the workspace runtime dir. Used by the write_report tool, output
   * resolvers, and any consumer that needs to materialize an output's
   * absolute path from its (workspace-or-project)-relative file_path.
   */
  sessionOutputRoot(params: {
    workspaceId: string;
    sessionId?: string | null;
    projectId?: string | null;
  }): string {
    const explicitProjectId = params.projectId ?? undefined;
    const inferredProjectId =
      explicitProjectId === undefined && params.sessionId
        ? this.getSession({
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
          })?.projectId
        : explicitProjectId;
    const projectId = inferredProjectId ?? null;
    if (projectId) {
      const project = this.getWorkspaceProject({
        workspaceId: params.workspaceId,
        projectId,
      });
      if (project?.projectPath) {
        return project.projectPath;
      }
    }
    return this.workspaceDir(params.workspaceId);
  }

  /**
   * Resolves an OutputRecord's absolute path on disk. Project-bound outputs
   * live under the project's directory; others live under the workspace
   * runtime dir. Joining `output.filePath` (which is always relative to the
   * output root, by convention) with the resolved root gives the canonical
   * absolute path for reads.
   */
  resolveOutputAbsolutePath(output: Pick<OutputRecord, "workspaceId" | "projectId" | "filePath">): string | null {
    if (!output.filePath) return null;
    if (path.isAbsolute(output.filePath)) {
      return output.filePath;
    }
    const root = this.sessionOutputRoot({
      workspaceId: output.workspaceId,
      projectId: output.projectId,
    });
    return path.join(root, output.filePath);
  }

  // ─── Workspace projects ─────────────────────────────────────────────
  // A project lives under a workspace and owns its own directory on disk
  // (independent of the workspace_path). Sessions can opt into a project
  // via agent_sessions.project_id — the run then uses project_path as cwd.

  listWorkspaceProjects(workspaceId: string): WorkspaceProjectRecord[] {
    const rows = this.workspaceRuntimeDb(workspaceId)
      .prepare<[], Record<string, unknown>>(`
        SELECT *
        FROM projects
        ORDER BY updated_at DESC, created_at DESC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToWorkspaceProject(row, workspaceId));
  }

  getWorkspaceProject(params: {
    workspaceId: string;
    projectId: string;
  }): WorkspaceProjectRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM projects
        WHERE project_id = ?
        LIMIT 1
      `)
      .get(params.projectId);
    return row ? this.rowToWorkspaceProject(row, params.workspaceId) : null;
  }

  createWorkspaceProject(params: {
    workspaceId: string;
    projectId: string;
    name: string;
    projectPath: string;
    icon?: string | null;
    iconColor?: string | null;
  }): WorkspaceProjectRecord {
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO projects (
            project_id,
            name,
            project_path,
            icon,
            icon_color,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.projectId,
        params.name,
        params.projectPath,
        this.normalizedNullableText(params.icon ?? null),
        this.normalizedNullableText(params.iconColor ?? null),
        now,
        now,
      );
    const created = this.getWorkspaceProject({
      workspaceId: params.workspaceId,
      projectId: params.projectId,
    });
    if (!created) {
      throw new Error(
        `workspace project ${params.projectId} disappeared immediately after insert`,
      );
    }
    return created;
  }

  updateWorkspaceProject(params: {
    workspaceId: string;
    projectId: string;
    fields: Partial<{
      name: string;
      icon: string | null;
      iconColor: string | null;
    }>;
  }): WorkspaceProjectRecord {
    const existing = this.getWorkspaceProject({
      workspaceId: params.workspaceId,
      projectId: params.projectId,
    });
    if (!existing) {
      throw new Error(
        `workspace project ${params.projectId} not found in workspace ${params.workspaceId}`,
      );
    }
    const next: WorkspaceProjectRecord = {
      ...existing,
      name: params.fields.name === undefined ? existing.name : params.fields.name,
      icon:
        params.fields.icon === undefined
          ? existing.icon
          : this.normalizedNullableText(params.fields.icon),
      iconColor:
        params.fields.iconColor === undefined
          ? existing.iconColor
          : this.normalizedNullableText(params.fields.iconColor),
      updatedAt: utcNowIso(),
    };
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE projects
        SET name = ?,
            icon = ?,
            icon_color = ?,
            updated_at = ?
        WHERE project_id = ?
      `)
      .run(
        next.name,
        next.icon,
        next.iconColor,
        next.updatedAt,
        params.projectId,
      );
    return next;
  }

  /**
   * Removes a project. Sessions that referenced it transition to General
   * (project_id NULL) in the same transaction — matches the spec's
   * "ON DELETE SET NULL" intent without relying on SQLite FK enforcement.
   *
   * We deliberately do NOT bump `updated_at` on the reassigned sessions.
   * The session itself hasn't changed in any way the user cares about —
   * only its containing bucket. Bumping updated_at would (a) cause the
   * sidebar's unread blue dot to light up on every moved session even if
   * the user had already read them, and (b) reorder General by recency
   * around an administrative event rather than real activity.
   */
  deleteWorkspaceProject(params: {
    workspaceId: string;
    projectId: string;
  }): void {
    const db = this.workspaceRuntimeDb(params.workspaceId);
    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE agent_sessions SET project_id = NULL WHERE project_id = ?",
      ).run(params.projectId);
      db.prepare(
        "DELETE FROM projects WHERE project_id = ?",
      ).run(params.projectId);
    });
    tx();
  }

  ensureSession(
    params: {
      workspaceId: string;
      sessionId: string;
      kind?: string | null;
      title?: string | null;
      parentSessionId?: string | null;
      createdBy?: string | null;
      projectId?: string | null;
      /**
       * Bound only on initial insert. Ignored on update — harness is
       * immutable once a session starts; callers that need to "switch
       * harness" must create a new session.
       */
      harnessId?: string | null;
      /**
       * The HolaApp that owns this session. Bound only on initial insert (like
       * harnessId) — immutable thereafter. Null = ordinary workspace session.
       */
      owningAppId?: string | null;
      /**
       * The org that owns this session (org-owned sessions). Bound only on the
       * initial insert (like harnessId/owningAppId) — immutable thereafter. Null
       * = unattributed (run falls back to the live runtime-config org).
       */
      orgId?: string | null;
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
      const resolvedHarnessId =
        this.normalizedNullableText(params.harnessId) ?? "pi";
      workspaceDb
        .prepare(`
          INSERT INTO agent_sessions (
              session_id,
              kind,
              title,
              parent_session_id,
              created_by,
              project_id,
              harness_id,
              owning_app_id,
              org_id,
              created_at,
              updated_at,
              archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          params.sessionId,
          this.normalizedSessionKind(params.kind),
          this.normalizedNullableText(params.title),
          this.normalizedNullableText(params.parentSessionId),
          this.normalizedNullableText(params.createdBy),
          this.normalizedNullableText(params.projectId),
          resolvedHarnessId,
          this.normalizedNullableText(params.owningAppId),
          this.normalizedNullableText(params.orgId),
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
    if (params.createdBy !== undefined) {
      updates.createdBy = this.normalizedNullableText(params.createdBy);
    }
    if (params.projectId !== undefined) {
      updates.projectId = this.normalizedNullableText(params.projectId);
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
      .prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
      .run(now, params.sessionId);
    return this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
  }

  getSession(params: { workspaceId: string; sessionId: string }): AgentSessionRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM agent_sessions
        WHERE session_id = ?
        LIMIT 1
      `)
      .get(params.sessionId);
    return row ? this.rowToAgentSession(row, params.workspaceId) : null;
  }

  setSessionActiveUserQuestion(params: {
    workspaceId: string;
    sessionId: string;
    activeUserQuestion: string | null;
  }): AgentSessionRecord {
    const existing = this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const now = utcNowIso();
    const normalizedQuestion = this.normalizedNullableText(params.activeUserQuestion);
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(
        "UPDATE agent_sessions SET active_user_question = ?, updated_at = ? WHERE session_id = ?"
      )
      .run(
        normalizedQuestion,
        now,
        params.sessionId
      );
    return {
      ...existing,
      activeUserQuestion: normalizedQuestion,
      updatedAt: now,
    };
  }

  /** Renames a session by setting its title (null clears it). */
  renameSession(params: {
    workspaceId: string;
    sessionId: string;
    title: string | null;
  }): AgentSessionRecord {
    const existing = this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const now = utcNowIso();
    const title = this.normalizedNullableText(params.title);
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(
        "UPDATE agent_sessions SET title = ?, updated_at = ? WHERE session_id = ?"
      )
      .run(title, now, params.sessionId);
    return { ...existing, title, updatedAt: now };
  }

  /**
   * Hard-deletes a session and every row scoped to it (inputs, runtime
   * state, messages, output events, queued main-session events, conversation
   * binding). Runs in a single transaction so a session never half-vanishes.
   */
  deleteSession(params: { workspaceId: string; sessionId: string }): void {
    const { workspaceId, sessionId } = params;
    const db = this.workspaceRuntimeDb(workspaceId);
    const tx = db.transaction(() => {
      for (const table of [
        "agent_runtime_sessions",
        "conversation_bindings",
        "agent_session_inputs",
        "post_run_jobs",
        "session_runtime_state",
        "session_messages",
        "session_output_events",
      ]) {
        db.prepare(
          `DELETE FROM ${table} WHERE session_id = ?`
        ).run(sessionId);
      }
      db.prepare(
        "DELETE FROM main_session_event_queue WHERE owner_main_session_id = ? OR origin_main_session_id = ?"
      ).run(sessionId, sessionId);
      db.prepare(
        "DELETE FROM agent_sessions WHERE session_id = ?"
      ).run(sessionId);
    });
    tx();
  }

  /**
   * Update a session's harness binding. Allowed ONLY while the session
   * has zero inputs — i.e. the user clicked "New chat" but has not yet
   * sent a message. Once a turn has been queued, the harness is locked
   * because the runtime has already committed to a CLI / runner whose
   * state can't be translated to a different harness mid-stream.
   *
   * Throws if any input has ever been queued for the session.
   */
  updateSessionHarnessId(params: {
    workspaceId: string;
    sessionId: string;
    harnessId: string;
  }): AgentSessionRecord {
    const existing = this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const inputCountRow = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) as count
           FROM agent_session_inputs
          WHERE session_id = ?`,
      )
      .get(params.sessionId);
    const inputCount = inputCountRow?.count ?? 0;
    if (inputCount > 0) {
      throw new Error(
        `cannot change harness on session ${params.sessionId}: ${inputCount} input(s) already queued`,
      );
    }
    const normalizedHarnessId =
      this.normalizedNullableText(params.harnessId) ?? "pi";
    const now = utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(
        "UPDATE agent_sessions SET harness_id = ?, updated_at = ? WHERE session_id = ?",
      )
      .run(
        normalizedHarnessId,
        now,
        params.sessionId,
      );
    return {
      ...existing,
      harnessId: normalizedHarnessId,
      updatedAt: now,
    };
  }

  listSessions(params: {
    workspaceId: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
    /** Return only sessions owned by this HolaApp (the app's dropdown list). */
    owningAppId?: string | null;
    /** Return only ordinary workspace sessions (owning_app_id IS NULL) — used to
     *  keep HolaApp sessions out of the workspace sidebar. Ignored when
     *  `owningAppId` is set. */
    excludeAppOwned?: boolean;
    /** Org-scoped sidebar: return only sessions owned by this TEAM org (strict
     *  `org_id = ?`). Omit to not filter by org. Personal is modeled as "no org"
     *  — use `onlyUnattributedOrg` for the Personal view, not this. */
    orgId?: string | null;
    /** Personal (no-org) view: return only sessions with `org_id IS NULL`
     *  (personal + legacy/pre-033). Ignored when `orgId` is set. */
    onlyUnattributedOrg?: boolean;
  }): AgentSessionRecord[] {
    const clauses = ["(? = 1 OR archived_at IS NULL)"];
    const values: unknown[] = [params.includeArchived ? 1 : 0];
    const appId =
      typeof params.owningAppId === "string" ? params.owningAppId.trim() : "";
    if (appId) {
      clauses.push("owning_app_id = ?");
      values.push(appId);
    } else if (params.excludeAppOwned) {
      clauses.push("owning_app_id IS NULL");
    }
    const orgId =
      typeof params.orgId === "string" ? params.orgId.trim() : "";
    if (orgId) {
      clauses.push("org_id = ?");
      values.push(orgId);
    } else if (params.onlyUnattributedOrg) {
      clauses.push("org_id IS NULL");
    }
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<unknown[], Record<string, unknown>>(`
        SELECT *
        FROM agent_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, session_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...values);
    return rows.map((row) => this.rowToAgentSession(row, params.workspaceId));
  }



  private normalizedIssueBlockedBy(params: {
    workspaceId: string;
    issueId: string;
    blockedBy?: IssueBlockedByRecord[] | null;
  }): IssueBlockedByRecord[] {
    const normalized: IssueBlockedByRecord[] = [];
    const seenTaskIds = new Set<string>();
    for (const edge of params.blockedBy ?? []) {
      const taskId = this.normalizedNullableText(edge.taskId);
      if (!taskId || seenTaskIds.has(taskId)) {
        continue;
      }
      if (taskId === params.issueId) {
        throw new Error("issue cannot be blocked by itself");
      }
      const blocker = this.getIssue({
        workspaceId: params.workspaceId,
        issueId: taskId,
      });
      if (!blocker) {
        throw new Error(`blocking issue ${taskId} not found`);
      }
      const visited = new Set<string>();
      const visit = (currentIssueId: string, path: Set<string>): void => {
        if (currentIssueId === params.issueId || path.has(currentIssueId)) {
          throw new Error("issue blocking graph cannot contain cycles");
        }
        if (visited.has(currentIssueId)) {
          return;
        }
        visited.add(currentIssueId);
        const currentIssue = this.getIssue({
          workspaceId: params.workspaceId,
          issueId: currentIssueId,
        });
        if (!currentIssue) {
          throw new Error(`blocking issue ${currentIssueId} not found`);
        }
        const nextPath = new Set(path);
        nextPath.add(currentIssueId);
        for (const childEdge of currentIssue.blockedBy) {
          visit(childEdge.taskId, nextPath);
        }
      };
      for (const childEdge of blocker.blockedBy) {
        visit(childEdge.taskId, new Set([taskId]));
      }
      seenTaskIds.add(taskId);
      normalized.push({
        taskId,
        relation: normalizeIssueBlockedByRelation(edge.relation) ?? "input",
        instruction: this.normalizedNullableText(edge.instruction),
      });
    }
    return normalized;
  }

  createIssue(params: {
    issueId?: string;
    workspaceId: string;
    sessionId?: string;
    sourceType?: string | null;
    title: string;
    description?: string | null;
    status: IssueStatus;
    priority?: IssuePriority | null;
    assigneeId?: string | null;
    blockedBy?: IssueBlockedByRecord[] | null;
    blockerReason?: string | null;
    attachments?: Array<Partial<IssueAttachmentRecord> & {
      name: string;
      mimeType: string;
      workspacePath: string;
    }> | null;
    activeSubagentId?: string | null;
    latestSubagentId?: string | null;
    createdBy?: string | null;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string | null;
  }): IssueRecord {
    const status = this.requiredIssueStatus(params.status);
    const blockerReason = this.normalizedNullableText(params.blockerReason);
    if (status === "blocked" && !blockerReason) {
      throw new Error("blockerReason is required when issue status is blocked");
    }
    const assigneeId = null;
    const workspace = this.getWorkspace(params.workspaceId);
    if (!workspace) {
      throw new Error(`workspace ${params.workspaceId} not found`);
    }
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const nextIssueNumber =
      (
        workspaceDb
          .prepare<[], { max_issue_number: number | null }>(
            "SELECT MAX(issue_number) AS max_issue_number FROM issues",
          )
          .get()?.max_issue_number ?? 0
      ) + 1;
    const issueId =
      this.normalizedNullableText(params.issueId) ??
      `${this.issueIdPrefixForWorkspaceName(workspace.name)}-${nextIssueNumber}`;
    const sessionId =
      this.normalizedNullableText(params.sessionId) ??
      `issue-${randomUUID()}`;
    if (this.getIssue({ workspaceId: params.workspaceId, issueId })) {
      throw new Error(`issue ${issueId} already exists`);
    }
    if (this.getSession({ workspaceId: params.workspaceId, sessionId })) {
      throw new Error(`session ${sessionId} already exists`);
    }
    const blockedBy = this.normalizedIssueBlockedBy({
      workspaceId: params.workspaceId,
      issueId,
      blockedBy: params.blockedBy,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = params.createdAt ?? now;
    const attachments = this.normalizedIssueAttachments(params.attachments, createdAt);
    const completedAt =
      status === "done"
        ? this.normalizedNullableText(params.completedAt) ?? now
        : this.normalizedNullableText(params.completedAt);

    const session = this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId,
        kind: "subagent",
        title: params.title,
        createdBy: params.createdBy ?? "workspace_user",
      },
      { touchExisting: false },
    );
    this.ensureRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
      status: "IDLE",
      currentInputId: null,
    });

    workspaceDb
      .prepare(`
        INSERT INTO issues (
            issue_id,
            issue_number,
            session_id,
            parent_issue_id,
            source_type,
            title,
            description,
            status,
            priority,
            assignee_id,
            blocked_by_json,
            blocker_reason,
            attachment_payloads,
            active_subagent_id,
            latest_subagent_id,
            created_by,
            created_at,
            updated_at,
            completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        issueId,
        nextIssueNumber,
        session.sessionId,
        null,
        this.normalizedNullableText(params.sourceType),
        this.requiredNormalizedText(params.title, "title"),
        this.normalizedNullableText(params.description),
        status,
        this.nullableIssuePriority(params.priority),
        assigneeId,
        JSON.stringify(blockedBy),
        blockerReason,
        JSON.stringify(attachments),
        this.normalizedNullableText(params.activeSubagentId),
        this.normalizedNullableText(params.latestSubagentId),
        this.normalizedNullableText(params.createdBy) ?? "workspace_user",
        createdAt,
        now,
        completedAt,
      );

    const record = this.getIssue({ workspaceId: params.workspaceId, issueId });
    if (!record) {
      throw new Error("issue row not found after insert");
    }
    return record;
  }

  getIssue(params: { workspaceId: string; issueId: string }): IssueRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM issues
        WHERE issue_id = ?
        LIMIT 1
      `)
      .get(params.issueId);
    return row ? this.rowToIssue(row, params.workspaceId) : null;
  }

  getIssueBySessionId(params: {
    workspaceId: string;
    sessionId: string;
  }): IssueRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM issues
        WHERE session_id = ?
        LIMIT 1
      `)
      .get(params.sessionId);
    return row ? this.rowToIssue(row, params.workspaceId) : null;
  }

  listIssues(params: {
    workspaceId: string;
    statuses?: IssueStatus[] | null;
    limit?: number;
    offset?: number;
  }): IssueRecord[] {
    const statuses = Array.from(new Set((params.statuses ?? []).filter((status): status is IssueStatus => !!status)));
    const whereClauses = ["1 = 1"];
    const values: unknown[] = [];
    if (statuses.length > 0) {
      whereClauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    values.push(params.limit ?? 200, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<unknown[], Record<string, unknown>>(`
        SELECT *
        FROM issues
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY datetime(updated_at) DESC, issue_number DESC, issue_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...values);
    return rows.map((row) => this.rowToIssue(row, params.workspaceId));
  }

  updateIssue(params: {
    workspaceId: string;
    issueId: string;
    fields: IssueUpdateFields;
  }): IssueRecord | null {
    const existing = this.getIssue({ workspaceId: params.workspaceId, issueId: params.issueId });
    if (!existing) {
      return null;
    }
    const entries = Object.entries(params.fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return existing;
    }

    const nextStatus =
      params.fields.status === undefined
        ? existing.status
        : this.requiredIssueStatus(params.fields.status);
    const nextBlockerReason =
      params.fields.blockerReason === undefined
        ? existing.blockerReason
        : this.normalizedNullableText(params.fields.blockerReason);
    if (nextStatus === "blocked" && !nextBlockerReason) {
      throw new Error("blockerReason is required when issue status is blocked");
    }

    const nextAssigneeTeammateId =
      params.fields.assigneeId === undefined
        ? existing.assigneeId
        : null;
    if (
      params.fields.sessionId &&
      params.fields.sessionId !== existing.sessionId &&
      this.getSession({ workspaceId: existing.workspaceId, sessionId: params.fields.sessionId })
    ) {
      throw new Error(`session ${params.fields.sessionId} already exists`);
    }
    if (params.fields.sessionId) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.sessionId,
          kind: "subagent",
          title: params.fields.title ?? existing.title,
        },
        { touchExisting: false },
      );
    }
    if (params.fields.title !== undefined) {
      this.ensureSession(
        {
          workspaceId: existing.workspaceId,
          sessionId: params.fields.sessionId ?? existing.sessionId,
          title: params.fields.title,
          kind: "subagent",
        },
        { touchExisting: false },
      );
    }
    const nextBlockedBy =
      params.fields.blockedBy === undefined
        ? existing.blockedBy
        : this.normalizedIssueBlockedBy({
            workspaceId: params.workspaceId,
            issueId: existing.issueId,
            blockedBy: params.fields.blockedBy,
          });
    const columnMap: Record<keyof IssueUpdateFields, string> = {
      sessionId: "session_id",
      sourceType: "source_type",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      assigneeId: "assignee_id",
      blockedBy: "blocked_by_json",
      blockerReason: "blocker_reason",
      attachments: "attachment_payloads",
      activeSubagentId: "active_subagent_id",
      latestSubagentId: "latest_subagent_id",
      createdBy: "created_by",
      completedAt: "completed_at",
    };

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, rawValue] of entries) {
      const typedKey = key as keyof IssueUpdateFields;
      const column = columnMap[typedKey];
      if (!column) {
        throw new Error(`unsupported issue update field: ${key}`);
      }
      assignments.push(`${column} = ?`);
      if (typedKey === "attachments") {
        values.push(
          JSON.stringify(
            this.normalizedIssueAttachments(
              rawValue as IssueAttachmentRecord[],
              existing.createdAt,
            ),
          ),
        );
        continue;
      }
      if (typedKey === "status") {
        values.push(nextStatus);
        continue;
      }
      if (typedKey === "blockedBy") {
        values.push(JSON.stringify(nextBlockedBy));
        continue;
      }
      if (typedKey === "priority") {
        values.push(this.nullableIssuePriority(rawValue as IssuePriority | null | undefined));
        continue;
      }
      if (typedKey === "title") {
        values.push(this.requiredNormalizedText(rawValue as string | null | undefined, "title"));
        continue;
      }
      values.push(this.normalizedNullableText(rawValue as string | null | undefined));
    }

    if (params.fields.status !== undefined && params.fields.completedAt === undefined) {
      assignments.push("completed_at = ?");
      values.push(nextStatus === "done" ? utcNowIso() : null);
    }
    assignments.push("updated_at = ?");
    values.push(utcNowIso(), params.issueId);

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`UPDATE issues SET ${assignments.join(", ")} WHERE issue_id = ?`)
      .run(...values);

    return this.getIssue({ workspaceId: params.workspaceId, issueId: params.issueId });
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

  upsertBinding(params: {
    workspaceId: string;
    sessionId: string;
    harness: string;
    harnessSessionId: string;
  }): SessionBindingRecord {
    // Forward the harness to ensureSession so that callers which create a
    // session implicitly via upsertBinding (project sessions, ACP-driven
    // flows) get the harness bound at the same time. ensureSession only
    // writes harness_id on first insert; the immutability guarantee still
    // holds for sessions created up-front by the session-create endpoints.
    this.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        harnessId: params.harness,
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
            WHERE session_id = ?
          `,
        )
        .run(params.sessionId);
      workspaceDb
        .prepare(
          `
            DELETE FROM agent_runtime_sessions
            WHERE harness = ? AND harness_session_id = ?
          `,
        )
        .run(params.harness, params.harnessSessionId);
      workspaceDb
        .prepare(`
          INSERT INTO agent_runtime_sessions (
              session_id, harness, harness_session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
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
      .prepare<[string], {
        session_id: string;
        harness: string;
        harness_session_id: string;
        created_at: string;
        updated_at: string;
      }>(`
        SELECT session_id, harness, harness_session_id, created_at, updated_at
        FROM agent_runtime_sessions
        WHERE session_id = ?
        LIMIT 1
      `)
      .get(params.sessionId);
    if (!row) {
      return null;
    }
    return {
      workspaceId: params.workspaceId,
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
        [string, string],
        {
          session_id: string;
          harness: string;
          harness_session_id: string;
          created_at: string;
          updated_at: string;
        }
      >(`
        SELECT session_id, harness, harness_session_id, created_at, updated_at
        FROM agent_runtime_sessions
        WHERE harness = ? AND harness_session_id = ?
        LIMIT 1
      `)
      .get(params.harness, params.harnessSessionId);
    if (!row) {
      return null;
    }
    return {
      workspaceId: params.workspaceId,
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
    const conversationKey = this.normalizedConversationBindingKey(params.conversationKey);
    const bindingId = params.bindingId ?? randomUUID();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);

    workspaceDb
      .prepare(`
        INSERT INTO conversation_bindings (
            binding_id,
            channel,
            conversation_key,
            session_id,
            role,
            is_active,
            metadata,
            last_active_at,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, conversation_key, role) DO UPDATE SET
            session_id = excluded.session_id,
            is_active = excluded.is_active,
            metadata = excluded.metadata,
            last_active_at = excluded.last_active_at,
            updated_at = excluded.updated_at
      `)
      .run(
        bindingId,
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
    return row ? this.rowToConversationBinding(row, params.workspaceId) : null;
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
      WHERE channel = ?
        AND conversation_key = ?
    `;
    const values: string[] = [
      this.requiredNormalizedText(params.channel, "channel"),
      this.normalizedConversationBindingKey(params.conversationKey),
    ];
    if (role !== undefined) {
      query += " AND role = ?";
      values.push(role);
    }
    query += " ORDER BY is_active DESC, datetime(updated_at) DESC, created_at DESC LIMIT 1";
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as Record<string, unknown> | undefined;
    return row ? this.rowToConversationBinding(row, params.workspaceId) : null;
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
      WHERE session_id = ?
    `;
    const values: string[] = [params.sessionId];
    if (role !== undefined) {
      query += " AND role = ?";
      values.push(role);
    }
    query += " ORDER BY is_active DESC, datetime(updated_at) DESC, created_at DESC LIMIT 1";
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(...values) as Record<string, unknown> | undefined;
    return row ? this.rowToConversationBinding(row, params.workspaceId) : null;
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
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToConversationBinding(row, params.workspaceId));
  }

  upsertChannelConnection(params: {
    connectionId?: string;
    workspaceId: string;
    platform: string;
    enabled?: boolean;
    token?: string | null;
    botUsername?: string | null;
    allowFrom?: string[];
    requireMention?: boolean;
    apiBaseUrl?: string | null;
    status?: string;
    statusDetail?: string | null;
    config?: Record<string, unknown> | null;
  }): ChannelConnectionRecord {
    const now = utcNowIso();
    const connectionId = params.connectionId?.trim() || randomUUID();
    const existing = this.getChannelConnection({
      workspaceId: params.workspaceId,
      connectionId,
    });
    const enabled = (params.enabled ?? existing?.enabled ?? true) ? 1 : 0;
    const token = params.token !== undefined ? params.token : existing?.token ?? null;
    const botUsername =
      params.botUsername !== undefined ? params.botUsername : existing?.botUsername ?? null;
    const allowFrom = params.allowFrom ?? existing?.allowFrom ?? [];
    const requireMention = (params.requireMention ?? existing?.requireMention ?? false) ? 1 : 0;
    const apiBaseUrl =
      params.apiBaseUrl !== undefined ? params.apiBaseUrl : existing?.apiBaseUrl ?? null;
    const status = params.status ?? existing?.status ?? "pending";
    const statusDetail =
      params.statusDetail !== undefined ? params.statusDetail : existing?.statusDetail ?? null;
    const config =
      params.config !== undefined ? params.config ?? {} : existing?.config ?? {};
    const createdAt = existing?.createdAt ?? now;

    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO channel_connections (
            connection_id, workspace_id, platform, enabled, token, bot_username,
            allow_from, require_mention, api_base_url, status, status_detail,
            config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, connection_id) DO UPDATE SET
            platform = excluded.platform,
            enabled = excluded.enabled,
            token = excluded.token,
            bot_username = excluded.bot_username,
            allow_from = excluded.allow_from,
            require_mention = excluded.require_mention,
            api_base_url = excluded.api_base_url,
            status = excluded.status,
            status_detail = excluded.status_detail,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
      `)
      .run(
        connectionId,
        params.workspaceId,
        this.requiredNormalizedText(params.platform, "platform"),
        enabled,
        this.normalizedNullableText(token),
        this.normalizedNullableText(botUsername),
        JSON.stringify(allowFrom),
        requireMention,
        this.normalizedNullableText(apiBaseUrl),
        this.requiredNormalizedText(status, "status"),
        this.normalizedNullableText(statusDetail),
        JSON.stringify(config),
        createdAt,
        now,
      );

    const record = this.getChannelConnection({
      workspaceId: params.workspaceId,
      connectionId,
    });
    if (!record) {
      throw new Error("channel connection not found after upsert");
    }
    return record;
  }

  getChannelConnection(params: {
    workspaceId: string;
    connectionId: string;
  }): ChannelConnectionRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare("SELECT * FROM channel_connections WHERE workspace_id = ? AND connection_id = ? LIMIT 1")
      .get(params.workspaceId, params.connectionId) as Record<string, unknown> | undefined;
    return row ? this.rowToChannelConnection(row) : null;
  }

  listChannelConnections(params: {
    workspaceId: string;
    platform?: string;
    enabledOnly?: boolean;
  }): ChannelConnectionRecord[] {
    let query = "SELECT * FROM channel_connections WHERE workspace_id = ?";
    const values: Array<string | number> = [params.workspaceId];
    if (params.platform) {
      query += " AND platform = ?";
      values.push(params.platform);
    }
    if (params.enabledOnly) {
      query += " AND enabled = 1";
    }
    query += " ORDER BY datetime(created_at) ASC, connection_id ASC";
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(query)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToChannelConnection(row));
  }

  deleteChannelConnection(params: { workspaceId: string; connectionId: string }): boolean {
    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare("DELETE FROM channel_connections WHERE workspace_id = ? AND connection_id = ?")
      .run(params.workspaceId, params.connectionId);
    return result.changes > 0;
  }

  setChannelConnectionStatus(params: {
    workspaceId: string;
    connectionId: string;
    status: string;
    statusDetail?: string | null;
    botUsername?: string | null;
  }): ChannelConnectionRecord | null {
    const existing = this.getChannelConnection({
      workspaceId: params.workspaceId,
      connectionId: params.connectionId,
    });
    if (!existing) return null;
    return this.upsertChannelConnection({
      workspaceId: params.workspaceId,
      connectionId: params.connectionId,
      platform: existing.platform,
      status: params.status,
      statusDetail: params.statusDetail,
      botUsername: params.botUsername,
    });
  }

  private rowToChannelConnection(row: Record<string, unknown>): ChannelConnectionRecord {
    let allowFrom: string[] = [];
    const rawAllow = row.allow_from;
    if (typeof rawAllow === "string" && rawAllow.trim()) {
      try {
        const parsed = JSON.parse(rawAllow);
        if (Array.isArray(parsed)) {
          allowFrom = parsed.filter((value): value is string => typeof value === "string");
        }
      } catch {
        // tolerate malformed json
      }
    }
    let config: Record<string, unknown> = {};
    const rawConfig = row.config_json;
    if (typeof rawConfig === "string" && rawConfig.trim()) {
      try {
        const parsed = JSON.parse(rawConfig);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      } catch {
        // tolerate malformed json
      }
    }
    return {
      connectionId: String(row.connection_id),
      workspaceId: String(row.workspace_id),
      platform: String(row.platform),
      enabled: Number(row.enabled) !== 0,
      token: row.token == null ? null : String(row.token),
      botUsername: row.bot_username == null ? null : String(row.bot_username),
      allowFrom,
      requireMention: Number(row.require_mention) !== 0,
      apiBaseUrl: row.api_base_url == null ? null : String(row.api_base_url),
      status: row.status == null ? "pending" : String(row.status),
      statusDetail: row.status_detail == null ? null : String(row.status_detail),
      config,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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
    childSessionKind?: string | null;
    initialChildInputId?: string | null;
    currentChildInputId?: string | null;
    latestChildInputId?: string | null;
    title?: string | null;
    goal: string;
    context?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    issueId?: string | null;
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
        kind: this.normalizedNullableText(params.childSessionKind) ?? "subagent",
        parentSessionId: params.parentSessionId,
        title: params.title,
      },
      { touchExisting: false }
    );
    const workflowRunId: string | null = null;

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
            issue_id,
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
            workflow_run_id,
            created_at,
            started_at,
            completed_at,
            cancelled_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        subagentId,
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
        this.normalizedNullableText(params.issueId),
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
        workflowRunId,
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
      issueId: "issue_id",
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
      "issueId",
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
        values.push(
          this.normalizedNullableText(
            typeof value === "string"
              ? value
              : (value as string | null | undefined),
          ),
        );
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
    return row ? this.rowToSubagentRun(row, params.workspaceId) : null;
  }

  getSubagentRunByChildSession(params: {
    workspaceId: string;
    childSessionId: string;
  }): SubagentRunRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT *
        FROM subagent_runs
        WHERE child_session_id = ?
        LIMIT 1
      `)
      .get(params.childSessionId);
    return row ? this.rowToSubagentRun(row, params.workspaceId) : null;
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
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToSubagentRun(row, params.workspaceId));
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
    return rows.map((row) => this.rowToSubagentRun(row, params.workspaceId));
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
    return rows.map((row) => this.rowToSubagentRun(row, params.workspaceId));
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
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToSubagentRun(row, params.workspaceId));
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
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToSubagentRun(row, params.workspaceId));
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
          WHERE subagent_id = ?
            AND delivered_at IS NULL
            AND superseded_at IS NULL
        `)
        .run(params.ownerMainSessionId, utcNowIso(), params.subagentId);
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
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
    return row ? this.rowToMainSessionEventQueue(row, params.workspaceId) : null;
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
    return rows.map((row) => this.rowToMainSessionEventQueue(row, params.workspaceId));
  }

  listPendingMainSessionEventsByWorkspace(params: {
    workspaceId: string;
    before?: string | null;
    limit?: number;
  }): MainSessionEventQueueRecord[] {
    let query = `
      SELECT *
      FROM main_session_event_queue
      WHERE status = 'pending'
        AND delivered_at IS NULL
        AND superseded_at IS NULL
    `;
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToMainSessionEventQueue(row, params.workspaceId));
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
      .prepare<[string], { event_id: string }>(`
        SELECT event_id
        FROM main_session_event_queue
        WHERE subagent_id = ?
        LIMIT 1
      `)
      .get(params.subagentId);
    if (existing) {
      this.ensureSession(
        {
          workspaceId: params.workspaceId,
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
    return rows.map((row) => this.rowToMainSessionEventQueue(row, params.workspaceId));
  }

  recoverFailedMaterializedMainSessionEvents(params: {
    workspaceId: string;
    nowIso?: string;
  }): MainSessionEventQueueRecord[] {
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const rows = workspaceDb
      .prepare<[], Record<string, unknown>>(
        `
          SELECT q.*
          FROM main_session_event_queue AS q
          INNER JOIN agent_session_inputs AS i
            ON i.input_id = q.materialized_input_id
          WHERE q.status = 'materialized'
            AND q.delivered_at IS NULL
            AND q.superseded_at IS NULL
            AND i.status = 'FAILED'
          ORDER BY datetime(q.created_at) ASC, q.event_id ASC
        `
      )
      .all();
    const events = rows.map((row) => this.rowToMainSessionEventQueue(row, params.workspaceId));
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
    contextCronAutoFetchEnabled?: boolean;
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
            context_cron_auto_fetch_enabled,
            auth_mode, granted_scopes, status, secret_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
            provider_id = excluded.provider_id,
            owner_user_id = excluded.owner_user_id,
            account_label = excluded.account_label,
            account_external_id = excluded.account_external_id,
            account_handle = excluded.account_handle,
            account_email = excluded.account_email,
            context_cron_auto_fetch_enabled = excluded.context_cron_auto_fetch_enabled,
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
        params.contextCronAutoFetchEnabled === undefined
          ? 1
          : params.contextCronAutoFetchEnabled
            ? 1
            : 0,
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
    // Composio accounts (ca_...) are remote-only in Stage 3 and never stored
    // locally, so skip the local existence check for them (validated at the
    // service layer / remotely). Local (bot-token) connections still require a row.
    if (!params.connectionId.trim().toLowerCase().startsWith("ca_")) {
      const connection = this.getIntegrationConnection(params.connectionId);
      if (!connection) {
        throw new Error(`integration connection ${params.connectionId} not found`);
      }
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

  /** Flip an integration connection to `expired` so the resolver skips it
   *  and the UI shows it as needs-reauth. No-ops if the row is already at
   *  the target status — safe to call from the execute error path on every
   *  failed call. Returns true when status actually flipped. */
  markIntegrationConnectionExpired(connectionId: string): boolean {
    const now = utcNowIso();
    const result = this.controlPlaneDb()
      .prepare(
        "UPDATE integration_connections SET status = 'expired', updated_at = ? WHERE connection_id = ? AND status != 'expired'",
      )
      .run(now, connectionId);
    return result.changes > 0;
  }

  getComposioToolSchemas(
    toolkitSlug: string,
  ): { schemasJson: string; fetchedAt: string } | null {
    const row = this.controlPlaneDb()
      .prepare<[string], Record<string, unknown>>(
        "SELECT schemas_json, fetched_at FROM composio_tool_schemas WHERE toolkit_slug = ?",
      )
      .get(toolkitSlug.trim().toLowerCase());
    if (!row) return null;
    return {
      schemasJson: String(row.schemas_json),
      fetchedAt: String(row.fetched_at),
    };
  }

  upsertComposioToolSchemas(params: {
    toolkitSlug: string;
    schemasJson: string;
    fetchedAt?: string;
  }): void {
    const fetchedAt = params.fetchedAt ?? utcNowIso();
    this.controlPlaneDb()
      .prepare(
        `INSERT INTO composio_tool_schemas (toolkit_slug, schemas_json, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(toolkit_slug) DO UPDATE SET
           schemas_json = excluded.schemas_json,
           fetched_at = excluded.fetched_at`,
      )
      .run(params.toolkitSlug.trim().toLowerCase(), params.schemasJson, fetchedAt);
  }

  deleteComposioToolSchemas(toolkitSlug: string): boolean {
    const result = this.controlPlaneDb()
      .prepare("DELETE FROM composio_tool_schemas WHERE toolkit_slug = ?")
      .run(toolkitSlug.trim().toLowerCase());
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
            input_id, session_id, payload, status, priority, available_at,
            attempt, idempotency_key, claimed_by, claimed_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)
      `)
      .run(
        inputId,
        params.sessionId,
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
    return this.rowToInput(row, params.workspaceId);
  }

  getInputByIdempotencyKey(params: { workspaceId: string; idempotencyKey: string }): SessionInputRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM agent_session_inputs WHERE idempotency_key = ? LIMIT 1"
      )
      .get(params.idempotencyKey);
    return this.rowToInput(row, params.workspaceId);
  }

  getLatestInputForSession(params: LatestSessionInputOptions): SessionInputRecord | null {
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 200;
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, number], Record<string, unknown>>(
        `
          SELECT *
          FROM agent_session_inputs
          WHERE session_id = ?
          ORDER BY datetime(created_at) DESC, rowid DESC
          LIMIT ?
        `
      )
      .all(params.sessionId, limit);
    const records = rows
      .map((row) => this.rowToInput(row, params.workspaceId))
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

  listSessionInputs(params: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
  }): SessionInputRecord[] {
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 200;
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, number], Record<string, unknown>>(
        `
          SELECT *
          FROM agent_session_inputs
          WHERE session_id = ?
          ORDER BY datetime(created_at) DESC, rowid DESC
          LIMIT ?
        `
      )
      .all(params.sessionId, limit);
    return rows
      .map((row) => this.rowToInput(row, params.workspaceId))
      .filter((record): record is SessionInputRecord => record !== null);
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

    const columnMap: Partial<Record<keyof InputUpdateFields, string>> = {
      sessionId: "session_id",
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

  // Returns every QUEUED input across visible workspace runtime dbs whose
  // available_at is still in the future — i.e. inputs that were deferred
  // by a gate (waiting on user OAuth, throttle, etc.). Used by the
  // integration-proposal gate's wake-up sweep to find rows that can now
  // be re-promoted to available.
  listDeferredQueuedInputs(): SessionInputRecord[] {
    const nowIso = new Date().toISOString();
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      const rows = db
        .prepare<[string], Record<string, unknown>>(`
          SELECT *
          FROM agent_session_inputs
          WHERE status = 'QUEUED'
            AND datetime(available_at) > datetime(?)
        `)
        .all(nowIso);
      return rows
        .map((row) => this.rowToInput(row, workspaceId))
        .filter((record): record is SessionInputRecord => record !== null);
    });
    return records;
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
        AND status = 'QUEUED'
        AND datetime(available_at) <= datetime(?)
      LIMIT 1
    `;
    const row = this.workspaceRuntimeDb(params.workspaceId).prepare(query).get(
      params.sessionId,
      nowIso,
    );
    return Boolean(row);
  }

  listExpiredClaimedInputs(nowIso = utcNowIso()): SessionInputRecord[] {
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
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
        .map((row) => this.rowToInput(row, workspaceId))
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
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      const rows = db.prepare(RuntimeStateStore.#LIST_CLAIMED_INPUTS_SQL).all() as Array<Record<string, unknown>>;
      return rows
        .map((row) => this.rowToInput(row, workspaceId))
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
            job_id, job_type, input_id, session_id, payload, status, priority, available_at,
            attempt, idempotency_key, claimed_by, claimed_until, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?)
      `)
      .run(
        jobId,
        params.jobType,
        params.inputId,
        params.sessionId,
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
    return this.rowToPostRunJob(row, params.workspaceId);
  }

  getPostRunJobByIdempotencyKey(params: { workspaceId: string; idempotencyKey: string }): PostRunJobRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM post_run_jobs WHERE idempotency_key = ? LIMIT 1")
      .get(params.idempotencyKey);
    return this.rowToPostRunJob(row, params.workspaceId);
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
      const jobs = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
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
          .map((row) => this.rowToPostRunJob(row, workspaceId))
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
      .map((row) => this.rowToPostRunJob(row, params.workspaceId as string))
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

    const columnMap: Partial<Record<keyof PostRunJobUpdateFields, string>> = {
      jobType: "job_type",
      inputId: "input_id",
      sessionId: "session_id",
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
    const records = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
      const rows = db.prepare(RuntimeStateStore.#LIST_EXPIRED_CLAIMED_POST_RUN_JOBS_SQL).all(nowIso) as Array<Record<string, unknown>>;
      return rows
        .map((row) => this.rowToPostRunJob(row, workspaceId))
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
            session_id, status, current_input_id, current_worker_id,
            lease_until, heartbeat_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            status = excluded.status,
            current_input_id = excluded.current_input_id,
            updated_at = excluded.updated_at
      `)
      .run(params.sessionId, params.status ?? "QUEUED", params.currentInputId ?? null, now, now);
    const row = workspaceDb
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM session_runtime_state WHERE session_id = ? LIMIT 1"
      )
      .get(params.sessionId);
    return this.rowToRuntimeState(row, params.workspaceId);
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
            session_id, status, current_input_id, current_worker_id,
            lease_until, heartbeat_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            status = excluded.status,
            current_input_id = excluded.current_input_id,
            current_worker_id = excluded.current_worker_id,
            lease_until = excluded.lease_until,
            heartbeat_at = excluded.heartbeat_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
      `)
      .run(
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
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM session_runtime_state WHERE session_id = ? LIMIT 1"
      )
      .get(params.sessionId);
    return this.rowToRuntimeState(row, params.workspaceId);
  }

  listRuntimeStates(workspaceId: string): SessionRuntimeStateRecord[] {
    const rows = this.workspaceRuntimeDb(workspaceId)
      .prepare<[], Record<string, unknown>>(`
        SELECT * FROM session_runtime_state
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
      `)
      .all();
    return rows.map((row) => this.rowToRuntimeState(row, workspaceId));
  }

  getRuntimeState(params: { workspaceId: string; sessionId: string }): SessionRuntimeStateRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM session_runtime_state
        WHERE session_id = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC LIMIT 1
      `)
      .get(params.sessionId);
    return row ? this.rowToRuntimeState(row, params.workspaceId) : null;
  }

  countPendingSessionInputs(params: { workspaceId: string; sessionId: string }): number {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], { count: number }>(`
        SELECT COUNT(*) AS count FROM agent_session_inputs
        WHERE session_id = ?
          AND status IN ('QUEUED', 'CLAIMED')
      `)
      .get(params.sessionId);
    return row?.count ?? 0;
  }

  insertSessionMessage(params: {
    workspaceId: string;
    sessionId: string;
    role: string;
    text: string;
    metadata?: Record<string, unknown> | null;
    messageId?: string;
    createdAt?: string;
  }): void {
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT OR REPLACE INTO session_messages (
            id, session_id, role, text, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.messageId ?? randomUUID(),
        params.sessionId,
        params.role,
        params.text,
        JSON.stringify(params.metadata ?? {}),
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
      WHERE session_id = ?
    `;
    const values: string[] = [params.sessionId];
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
      SELECT id, role, text, metadata, created_at
      FROM session_messages
      WHERE session_id = ?
    `;
    const values: Array<string | number> = [params.sessionId];
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
      .prepare<typeof values, { id: string; role: string; text: string; metadata: string; created_at: string }>(query)
      .all(...values);
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.created_at,
      metadata: this.parseJsonDict(row.metadata)
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
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    workspaceDb
      .prepare(`
        INSERT INTO session_output_events (
            session_id, input_id, sequence, event_type, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.sessionId,
        params.inputId,
        params.sequence,
        params.eventType,
        JSON.stringify(params.payload),
        params.createdAt ?? utcNowIso()
      );
    // A completed run is fresh activity the user may not have seen. Agent
    // output otherwise never touches the session's updated_at (only user
    // input / metadata edits do), so a run that finishes while the user is
    // looking elsewhere would never light the sidebar's "completed but not
    // viewed" dot (updated_at > last-viewed) or sort as recently active.
    // Bump it here on the terminal completion event — the single chokepoint
    // every executor completion path funnels through.
    if (params.eventType === "run_completed") {
      workspaceDb
        .prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
        .run(utcNowIso(), params.sessionId);
      // Enforce the per-session retention cap at the natural end-of-run
      // chokepoint. Bounded (WRITE_PATH_TRIM_LIMIT) so a first-time trim of a
      // huge legacy session can't stall the hot path; the background sweep
      // clears any remaining backlog. Best-effort — a retention failure (e.g. a
      // transient lock) must NEVER break a run's completion write.
      const cap = this.#outputEventRetention.maxEventsPerSession;
      if (cap > 0) {
        try {
          this.trimSessionOutputEvents({
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
            maxEvents: cap,
            limit: WRITE_PATH_TRIM_LIMIT,
          });
        } catch {
          // Swallow: retention is best-effort and the background sweep retries.
        }
      }
    }
    // Wake any SSE stream tailing this session so the just-written event is
    // delivered immediately (see waitForOutputEvent).
    this.#outputEventNotifier.emit("append", params.sessionId);
  }

  /**
   * Resolve as soon as an output event is appended for `sessionId`, or after
   * `timeoutMs` (whichever first). Lets a stream loop block on writes instead of
   * busy-polling: `while (drain()) …; await waitForOutputEvent(...)`. Matches on
   * sessionId only (globally unique) so a workspace-id mismatch between writer
   * and reader can't drop the signal; the timeout is the fallback for any
   * out-of-process writer whose signal never reaches this process.
   */
  waitForOutputEvent(params: {
    sessionId: string;
    timeoutMs: number;
  }): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#outputEventNotifier.off("append", onAppend);
        resolve();
      };
      const onAppend = (sessionId: string): void => {
        if (sessionId === params.sessionId) finish();
      };
      const timer = setTimeout(finish, params.timeoutMs);
      this.#outputEventNotifier.on("append", onAppend);
    });
  }

  deleteOutputEventsForInput(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
  }): void {
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        DELETE FROM session_output_events
        WHERE session_id = ? AND input_id = ?
      `)
      .run(params.sessionId, params.inputId);
  }

  /** The effective (option-merged) retention policy for the event log. */
  get outputEventRetentionPolicy(): OutputEventRetentionPolicy {
    return this.#outputEventRetention;
  }

  /**
   * Enforce the per-session retention cap: keep the newest `maxEvents` rows for
   * `sessionId`, deleting older ones. Optionally bound the number deleted this
   * call via `limit` (for the write path / background batching). Returns rows
   * deleted; a no-op when the session has <= maxEvents rows or `maxEvents <= 0`.
   *
   * Deletes only OLD events (lowest ids) — the live SSE tail reads the newest,
   * so trimming here never disturbs an in-flight stream, only truncates
   * scroll-back history beyond the cap.
   */
  trimSessionOutputEvents(params: {
    workspaceId: string;
    sessionId: string;
    maxEvents: number;
    limit?: number;
  }): number {
    if (params.maxEvents <= 0) {
      return 0;
    }
    const db = this.workspaceRuntimeDb(params.workspaceId);
    // Threshold id = the id of the (maxEvents+1)-th newest row. Everything at or
    // below it is older than the cap. NULL (fewer rows than the cap) → no-op.
    const threshold = db
      .prepare(`
        SELECT id FROM session_output_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 1 OFFSET ?
      `)
      .get(params.sessionId, params.maxEvents) as { id: number } | undefined;
    if (!threshold) {
      return 0;
    }
    if (params.limit && params.limit > 0) {
      // Bounded: delete at most `limit` of the oldest over-cap rows.
      const result = db
        .prepare(`
          DELETE FROM session_output_events
          WHERE id IN (
            SELECT id FROM session_output_events
            WHERE session_id = ? AND id <= ?
            ORDER BY id ASC
            LIMIT ?
          )
        `)
        .run(params.sessionId, threshold.id, params.limit);
      return result.changes;
    }
    const result = db
      .prepare(`
        DELETE FROM session_output_events
        WHERE session_id = ? AND id <= ?
      `)
      .run(params.sessionId, threshold.id);
    return result.changes;
  }

  /**
   * Background-sweep primitive: delete up to `limit` of the OLDEST
   * `session_output_events` rows (across all sessions) whose `created_at` is
   * before `cutoffIso`, in the root runtime db. Returns rows deleted; loop until
   * it returns 0. Bounded per call so the caller can yield between batches and
   * never hold the write lock long.
   */
  pruneRootOutputEventsByAge(params: { cutoffIso: string; limit: number }): number {
    const limit = Math.max(1, params.limit);
    const result = this.rootRuntimeDb()
      .prepare(`
        DELETE FROM session_output_events
        WHERE id IN (
          SELECT id FROM session_output_events
          WHERE created_at < ?
          ORDER BY id ASC
          LIMIT ?
        )
      `)
      .run(params.cutoffIso, limit);
    return result.changes;
  }

  /**
   * Background-sweep primitive: count root-db output events older than `cutoffIso`
   * (the age-based retention backlog). Used to size the maintenance progress bar
   * up front so the desktop can show "cleaned X / N" during a heavy first sweep.
   */
  countRootOutputEventsOlderThan(cutoffIso: string): number {
    const row = this.rootRuntimeDb()
      .prepare(`SELECT COUNT(*) AS n FROM session_output_events WHERE created_at < ?`)
      .get(cutoffIso) as { n?: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Background-sweep primitive: list sessions in the root runtime db whose event
   * count exceeds `cap`, heaviest first. One grouped scan; the caller then trims
   * each via {@link trimSessionOutputEvents} in bounded batches. Returns [] when
   * `cap <= 0`.
   */
  listRootSessionsExceedingOutputEventCap(
    cap: number,
  ): Array<{ sessionId: string; count: number }> {
    if (cap <= 0) {
      return [];
    }
    const rows = this.rootRuntimeDb()
      .prepare(`
        SELECT session_id AS sessionId, COUNT(*) AS count
        FROM session_output_events
        GROUP BY session_id
        HAVING COUNT(*) > ?
        ORDER BY COUNT(*) DESC
      `)
      .all(cap) as Array<{ sessionId: string; count: number }>;
    return rows;
  }

  /**
   * Background-sweep primitive: total output events in the root db.
   *
   * The per-session cap cannot bound the FILE. Observed in the field: 162
   * scheduled sessions each sitting at exactly the 25k cap — 2.29M rows and
   * 1.9GB, every one of them within policy, and nothing to prune. Boot cost
   * scales with the file, so "within policy" was still enough to brick the app.
   */
  countRootOutputEvents(): number {
    const row = this.rootRuntimeDb()
      .prepare(`SELECT COUNT(*) AS n FROM session_output_events`)
      .get() as { n?: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Background-sweep primitive: delete the OLDEST output events in the root db,
   * up to `limit`, keeping the table at or under `keep` rows total.
   *
   * Oldest-first, matching the age-based phase — a global cap means "keep the
   * newest N overall", and trimming the largest sessions instead would let a
   * chatty session evict a quiet one's recent history. Returns rows deleted.
   */
  trimRootOutputEventsToTotal(params: { keep: number; limit: number }): number {
    if (params.keep <= 0 || params.limit <= 0) {
      return 0;
    }
    const total = this.countRootOutputEvents();
    const excess = total - params.keep;
    if (excess <= 0) {
      return 0;
    }
    const batch = Math.min(excess, params.limit);
    const result = this.rootRuntimeDb()
      .prepare(`
        DELETE FROM session_output_events
        WHERE id IN (
          SELECT id FROM session_output_events ORDER BY id ASC LIMIT ?
        )
      `)
      .run(batch);
    return result.changes ?? 0;
  }

  latestOutputEventId(params: { workspaceId: string; sessionId: string; inputId?: string; excludedEventTypes?: string[] }): number {
    let query = `
      SELECT MAX(id) AS max_id
      FROM session_output_events
      WHERE session_id = ?
    `;
    const values: string[] = [params.sessionId];
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
      SELECT id, session_id, input_id, sequence, event_type, payload, created_at
      FROM session_output_events
      WHERE session_id = ?
        AND id > ?
    `;
    const values: Array<string | number> = [params.sessionId, params.afterEventId ?? 0];
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
      workspaceId: params.workspaceId,
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
            terminal_id, session_id, input_id, title, backend, owner, status,
            cwd, shell, command, exit_code, last_event_seq, created_by, created_at,
            started_at, last_activity_at, ended_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        terminalId,
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
    return this.rowToTerminalSession(row, params.workspaceId);
  }

  getTerminalSession(params: { workspaceId: string; terminalId: string }): TerminalSessionRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM terminal_sessions WHERE terminal_id = ? LIMIT 1")
      .get(params.terminalId);
    return row ? this.rowToTerminalSession(row, params.workspaceId) : null;
  }

  listTerminalSessions(params: {
    workspaceId?: string;
    sessionId?: string;
    statuses?: TerminalSessionStatus[];
  } = {}): TerminalSessionRecord[] {
    const statuses = (params.statuses ?? []).filter((value) => Boolean(value));
    if (!params.workspaceId) {
      const sessions = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
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
        return rows.map((row) => this.rowToTerminalSession(row, workspaceId));
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
    const workspaceId = params.workspaceId;
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
    const rows = this.workspaceRuntimeDb(workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTerminalSession(row, workspaceId));
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
    return this.rowToTerminalSession(row, params.workspaceId);
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
      const session = this.rowToTerminalSession(row, params.workspaceId);
      const nextSequence = session.lastEventSeq + 1;
      workspaceDb
        .prepare(`
          INSERT INTO terminal_session_events (
              terminal_id, session_id, sequence, event_type, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.terminalId,
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
      return this.rowToTerminalSessionEvent(eventRow, params.workspaceId);
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
    return rows.map((row) => this.rowToTerminalSessionEvent(row, params.workspaceId));
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(input_id) DO UPDATE SET
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
    return row ? this.rowToTurnResult(row, params.workspaceId) : null;
  }

  getLatestTurnResultForSession(params: {
    workspaceId: string;
    sessionId: string;
  }): TurnResultRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(`
        SELECT * FROM turn_results
        WHERE session_id = ?
        ORDER BY datetime(started_at) DESC LIMIT 1
      `)
      .get(params.sessionId);
    return row ? this.rowToTurnResult(row, params.workspaceId) : null;
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
      WHERE session_id = ?
    `;
    const values: string[] = [params.sessionId];
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

  countWorkspaceTurnResults(params: {
    workspaceId: string;
    sessionId?: string;
    inputId?: string;
    status?: string;
  }): number {
    let query = `
      SELECT COUNT(*) AS total
      FROM turn_results
      WHERE 1 = 1
    `;
    const values: string[] = [];
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(query)
      .get(...values) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  listTurnResults(params: {
    workspaceId: string;
    sessionId: string;
    inputId?: string;
    status?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): TurnResultRecord[] {
    let query = `
      SELECT *
      FROM turn_results
      WHERE session_id = ?
    `;
    const values: Array<string | number> = [params.sessionId];
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    const order = params.order === "asc" ? "ASC" : "DESC";
    query += `
      ORDER BY datetime(COALESCE(completed_at, started_at)) ${order}, created_at ${order}, input_id ${order}
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTurnResult(row, params.workspaceId));
  }

  listWorkspaceTurnResults(params: {
    workspaceId: string;
    sessionId?: string;
    inputId?: string;
    status?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): TurnResultRecord[] {
    let query = `
      SELECT *
      FROM turn_results
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
    if (params.sessionId) {
      query += " AND session_id = ?";
      values.push(params.sessionId);
    }
    if (params.inputId) {
      query += " AND input_id = ?";
      values.push(params.inputId);
    }
    if (params.status) {
      query += " AND status = ?";
      values.push(params.status);
    }
    const order = params.order === "asc" ? "ASC" : "DESC";
    query += `
      ORDER BY datetime(COALESCE(completed_at, started_at)) ${order}, created_at ${order}, input_id ${order}
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(query)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTurnResult(row, params.workspaceId));
  }

  getWorkspaceRuntimeMetadata(params: {
    workspaceId: string;
    key: string;
  }): string | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], { value?: string }>("SELECT value FROM workspace_runtime_metadata WHERE key = ? LIMIT 1")
      .get(params.key);
    return typeof row?.value === "string" ? row.value : null;
  }

  setWorkspaceRuntimeMetadata(params: {
    workspaceId: string;
    key: string;
    value: string;
    updatedAt?: string;
  }): void {
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(
        `
          INSERT INTO workspace_runtime_metadata (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run(params.key, params.value, params.updatedAt ?? utcNowIso());
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
    timezone?: string | null;
    nameSource?: RuntimeUserProfileNameSource | null;
    createdAt?: string;
    updatedAt?: string;
  }): RuntimeUserProfileRecord {
    const profileId = (params.profileId ?? "default").trim() || "default";
    const existing = this.getRuntimeUserProfile({ profileId });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    const normalizedName = typeof params.name === "string" ? params.name.trim() : "";
    const normalizedTimezone =
      typeof params.timezone === "string" ? params.timezone.trim() : "";
    const resolvedName = normalizedName || null;
    const resolvedTimezone = normalizedTimezone || null;
    const resolvedNameSource = resolvedName
      ? (params.nameSource ?? existing?.nameSource ?? "manual")
      : null;

    this.controlPlaneDb()
      .prepare(`
        INSERT INTO runtime_user_profiles (
            profile_id,
            name,
            timezone,
            name_source,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
            name = excluded.name,
            timezone = excluded.timezone,
            name_source = excluded.name_source,
            updated_at = excluded.updated_at
      `)
      .run(
        profileId,
        resolvedName,
        resolvedTimezone,
        resolvedNameSource,
        createdAt,
        now,
      );

    const record = this.getRuntimeUserProfile({ profileId });
    if (!record) {
      throw new Error("runtime user profile row not found after upsert");
    }
    return record;
  }

  applyRuntimeUserProfileAuthFallback(params: {
    profileId?: string;
    name?: string | null;
    timezone?: string | null;
    updatedAt?: string;
  }): RuntimeUserProfileRecord | null {
    const profileId = (params.profileId ?? "default").trim() || "default";
    const normalizedName =
      typeof params.name === "string" ? params.name.trim() : "";
    const normalizedTimezone =
      typeof params.timezone === "string" ? params.timezone.trim() : "";
    const existing = this.getRuntimeUserProfile({ profileId });
    const shouldFillName = normalizedName.length > 0 && !(existing?.name?.trim());
    const shouldFillTimezone =
      normalizedTimezone.length > 0 && !(existing?.timezone?.trim());
    if (!shouldFillName && !shouldFillTimezone) {
      return existing;
    }
    return this.upsertRuntimeUserProfile({
      profileId,
      name: shouldFillName ? normalizedName : existing?.name ?? null,
      timezone:
        shouldFillTimezone ? normalizedTimezone : existing?.timezone ?? null,
      nameSource:
        shouldFillName ? "auth_fallback" : existing?.nameSource ?? null,
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
    // Single-tenant end-state: workspace-scoped memory entries for EVERY former
    // workspace now live in the one root runtime DB, each row keeping its own
    // `workspace_id`. GROUP BY that column to report a count per workspace —
    // the per-db scan + `WHERE workspace_id = <tag>` form would only ever count
    // the single canonically-tagged entry's workspace and miss the rest.
    let query = `
      SELECT workspace_id AS workspaceId, COUNT(*) AS total
      FROM memory_entries
      WHERE scope = 'workspace'
        AND workspace_id IS NOT NULL
    `;
    const values: Array<string | number> = [];
    if (params.status !== undefined) {
      if (params.status === null) {
        query += " AND status IS NULL";
      } else {
        query += " AND status = ?";
        values.push(params.status);
      }
    }
    query += " GROUP BY workspace_id";
    const rows = this.rootRuntimeDb().prepare(query).all(...values) as Array<{
      workspaceId: string;
      total: number;
    }>;
    const counts = rows
      .map((row) => ({ workspaceId: row.workspaceId, count: Number(row.total) }))
      .filter((entry) => entry.count > 0);
    counts.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    return counts;
  }

  upsertInteractionEntity(params: {
    workspaceId: string;
    entityId: string;
    entityType: InteractionEntityType;
    canonicalName: string;
    slug: string;
    summary?: string | null;
    aliases?: string[] | null;
    isSystem?: boolean;
    status?: InteractionEntityStatus;
    createdAt?: string;
    updatedAt?: string;
  }): InteractionEntityRecord {
    const existing = this.getInteractionEntity({
      workspaceId: params.workspaceId,
      entityId: params.entityId,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO interaction_entities (
          entity_id,
          entity_type,
          canonical_name,
          slug,
          summary,
          aliases,
          is_system,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          entity_type = excluded.entity_type,
          canonical_name = excluded.canonical_name,
          slug = excluded.slug,
          summary = excluded.summary,
          aliases = excluded.aliases,
          is_system = excluded.is_system,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(
        params.entityId,
        params.entityType,
        params.canonicalName,
        params.slug,
        params.summary ?? null,
        JSON.stringify(params.aliases ?? []),
        params.isSystem ? 1 : 0,
        params.status ?? "active",
        createdAt,
        now,
      );
    const record = this.getInteractionEntity({
      workspaceId: params.workspaceId,
      entityId: params.entityId,
    });
    if (!record) {
      throw new Error("interaction entity row not found after upsert");
    }
    return record;
  }

  getInteractionEntity(params: {
    workspaceId: string;
    entityId: string;
  }): InteractionEntityRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM interaction_entities WHERE entity_id = ? LIMIT 1",
      )
      .get(params.entityId);
    return row ? this.rowToInteractionEntity(row, params.workspaceId) : null;
  }

  getInteractionEntityBySlug(params: {
    workspaceId: string;
    slug: string;
  }): InteractionEntityRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM interaction_entities WHERE slug = ? LIMIT 1",
      )
      .get(params.slug);
    return row ? this.rowToInteractionEntity(row, params.workspaceId) : null;
  }

  listInteractionEntities(params: {
    workspaceId: string;
    status?: InteractionEntityStatus | null;
    includeSystem?: boolean;
    limit?: number;
    offset?: number;
  }): InteractionEntityRecord[] {
    let query = `
      SELECT *
      FROM interaction_entities
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
    if (params.status !== undefined) {
      if (params.status === null) {
        query += " AND status IS NULL";
      } else {
        query += " AND status = ?";
        values.push(params.status);
      }
    }
    if (!(params.includeSystem ?? true)) {
      query += " AND is_system = 0";
    }
    query += `
      ORDER BY updated_at DESC, created_at DESC, canonical_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 200, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToInteractionEntity(row, params.workspaceId));
  }

  upsertInteractionLeaf(params: {
    workspaceId: string;
    leafId: string;
    entityId: string;
    subjectKey: string;
    path: string;
    title: string;
    summary: string;
    fingerprint: string;
    bodySha256: string;
    tags?: string[] | null;
    secondaryEntityIds?: string[] | null;
    sourceType?: string | null;
    sourceEventId?: string | null;
    sourceMessageId?: string | null;
    sourceTurnInputId?: string | null;
    admissionConfidence?: number | null;
    entityConfidence?: number | null;
    observedAt?: string | null;
    supersedesLeafId?: string | null;
    supersededAt?: string | null;
    status?: InteractionLeafStatus;
    createdAt?: string;
    updatedAt?: string;
  }): InteractionLeafRecord {
    const existing = this.getInteractionLeaf({
      workspaceId: params.workspaceId,
      leafId: params.leafId,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO interaction_leaves (
          leaf_id,
          entity_id,
          subject_key,
          path,
          title,
          summary,
          fingerprint,
          body_sha256,
          tags,
          secondary_entity_ids,
          source_type,
          source_event_id,
          source_message_id,
          source_turn_input_id,
          admission_confidence,
          entity_confidence,
          observed_at,
          supersedes_leaf_id,
          superseded_at,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(leaf_id) DO UPDATE SET
          entity_id = excluded.entity_id,
          subject_key = excluded.subject_key,
          path = excluded.path,
          title = excluded.title,
          summary = excluded.summary,
          fingerprint = excluded.fingerprint,
          body_sha256 = excluded.body_sha256,
          tags = excluded.tags,
          secondary_entity_ids = excluded.secondary_entity_ids,
          source_type = excluded.source_type,
          source_event_id = excluded.source_event_id,
          source_message_id = excluded.source_message_id,
          source_turn_input_id = excluded.source_turn_input_id,
          admission_confidence = excluded.admission_confidence,
          entity_confidence = excluded.entity_confidence,
          observed_at = excluded.observed_at,
          supersedes_leaf_id = excluded.supersedes_leaf_id,
          superseded_at = excluded.superseded_at,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(
        params.leafId,
        params.entityId,
        params.subjectKey,
        params.path,
        params.title,
        params.summary,
        params.fingerprint,
        params.bodySha256,
        JSON.stringify(params.tags ?? []),
        JSON.stringify(params.secondaryEntityIds ?? []),
        params.sourceType ?? null,
        params.sourceEventId ?? null,
        params.sourceMessageId ?? null,
        params.sourceTurnInputId ?? null,
        params.admissionConfidence ?? null,
        params.entityConfidence ?? null,
        params.observedAt ?? null,
        params.supersedesLeafId ?? null,
        params.supersededAt ?? null,
        params.status ?? "active",
        createdAt,
        now,
      );
    const record = this.getInteractionLeaf({
      workspaceId: params.workspaceId,
      leafId: params.leafId,
    });
    if (!record) {
      throw new Error("interaction leaf row not found after upsert");
    }
    return record;
  }

  getInteractionLeaf(params: {
    workspaceId: string;
    leafId: string;
  }): InteractionLeafRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM interaction_leaves WHERE leaf_id = ? LIMIT 1",
      )
      .get(params.leafId);
    return row ? this.rowToInteractionLeaf(row, params.workspaceId) : null;
  }

  getInteractionLeafByPath(params: {
    workspaceId: string;
    path: string;
  }): InteractionLeafRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM interaction_leaves WHERE path = ? LIMIT 1",
      )
      .get(params.path);
    return row ? this.rowToInteractionLeaf(row, params.workspaceId) : null;
  }

  getInteractionLeafByFingerprint(params: {
    workspaceId: string;
    entityId: string;
    fingerprint: string;
  }): InteractionLeafRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM interaction_leaves
          WHERE entity_id = ?
            AND fingerprint = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(params.entityId, params.fingerprint);
    return row ? this.rowToInteractionLeaf(row, params.workspaceId) : null;
  }

  getLatestActiveInteractionLeafBySubject(params: {
    workspaceId: string;
    entityId: string;
    subjectKey: string;
  }): InteractionLeafRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM interaction_leaves
          WHERE entity_id = ?
            AND subject_key = ?
            AND status = 'active'
          ORDER BY observed_at DESC, updated_at DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(params.entityId, params.subjectKey);
    return row ? this.rowToInteractionLeaf(row, params.workspaceId) : null;
  }

  listInteractionLeaves(params: {
    workspaceId: string;
    entityId?: string | null;
    status?: InteractionLeafStatus | null;
    limit?: number;
    offset?: number;
  }): InteractionLeafRecord[] {
    let query = `
      SELECT *
      FROM interaction_leaves
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
    if (params.entityId !== undefined) {
      if (params.entityId === null) {
        query += " AND entity_id IS NULL";
      } else {
        query += " AND entity_id = ?";
        values.push(params.entityId);
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
      ORDER BY COALESCE(observed_at, updated_at) DESC, created_at DESC, leaf_id ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 200, params.offset ?? 0);
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToInteractionLeaf(row, params.workspaceId));
  }

  updateInteractionLeafStatus(params: {
    workspaceId: string;
    leafId: string;
    status: InteractionLeafStatus;
    supersededAt?: string | null;
    updatedAt?: string;
  }): InteractionLeafRecord | null {
    const now = params.updatedAt ?? utcNowIso();
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        UPDATE interaction_leaves
        SET status = ?,
            superseded_at = ?,
            updated_at = ?
        WHERE leaf_id = ?
      `)
      .run(
        params.status,
        params.supersededAt ?? null,
        now,
        params.leafId,
      );
    return this.getInteractionLeaf({
      workspaceId: params.workspaceId,
      leafId: params.leafId,
    });
  }

  upsertInteractionNodeEmbedding(params: {
    workspaceId: string;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    entityId: string;
    embeddingModel: string;
    contentFingerprint: string;
    dimensions: number;
    vector: number[];
    createdAt?: string;
    updatedAt?: string;
  }): InteractionNodeEmbeddingRecord {
    const existing = this.getInteractionNodeEmbedding({
      workspaceId: params.workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        INSERT INTO interaction_node_embeddings (
          node_kind,
          node_id,
          entity_id,
          embedding_model,
          content_fingerprint,
          dimensions,
          vector_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_kind, node_id, embedding_model) DO UPDATE SET
          entity_id = excluded.entity_id,
          content_fingerprint = excluded.content_fingerprint,
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at
      `)
      .run(
        params.nodeKind,
        params.nodeId,
        params.entityId,
        params.embeddingModel,
        params.contentFingerprint,
        params.dimensions,
        JSON.stringify(params.vector),
        createdAt,
        now,
      );
    const record = this.getInteractionNodeEmbedding({
      workspaceId: params.workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!record) {
      throw new Error("interaction embedding row not found after upsert");
    }
    this.replaceInteractionNodeEmbeddingVector({
      workspaceId: params.workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
      embedding: new Float32Array(params.vector),
    });
    return record;
  }

  getInteractionNodeEmbedding(params: {
    workspaceId: string;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
  }): InteractionNodeEmbeddingRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM interaction_node_embeddings
          WHERE node_kind = ?
            AND node_id = ?
            AND embedding_model = ?
          LIMIT 1
        `,
      )
      .get(params.nodeKind, params.nodeId, params.embeddingModel);
    return row ? this.rowToInteractionNodeEmbedding(row, params.workspaceId) : null;
  }

  private interactionNodeEmbeddingRowid(params: {
    workspaceId: string;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
  }): number | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<
        [string, string, string],
        { vec_rowid?: number | bigint | null }
      >(
        `
          SELECT rowid AS vec_rowid
          FROM interaction_node_embeddings
          WHERE node_kind = ?
            AND node_id = ?
            AND embedding_model = ?
          LIMIT 1
        `,
      )
      .get(params.nodeKind, params.nodeId, params.embeddingModel);
    if (!row?.vec_rowid) {
      return null;
    }
    return Number(row.vec_rowid);
  }

  replaceInteractionNodeEmbeddingVector(params: {
    workspaceId: string;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
    embedding: Float32Array;
  }): void {
    if (!this.#vectorIndexSupported || params.embedding.length !== 1536) {
      return;
    }
    const record = this.getInteractionNodeEmbedding({
      workspaceId: params.workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!record) {
      return;
    }
    const vecRowid = this.interactionNodeEmbeddingRowid({
      workspaceId: params.workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!Number.isFinite(vecRowid)) {
      return;
    }
    const db = this.workspaceRuntimeDb(params.workspaceId);
    db.prepare("DELETE FROM interaction_node_embedding_vec WHERE vec_rowid = ?").run(vecRowid);
    db
      .prepare(`
        INSERT INTO interaction_node_embedding_vec (vec_rowid, embedding, entity_id, node_kind, embedding_model)
        VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
      `)
      .run(
        vecRowid,
        params.embedding,
        record.entityId,
        record.nodeKind,
        record.embeddingModel,
      );
  }

  private backfillInteractionNodeEmbeddingVectors(params: {
    workspaceId: string;
    embeddingModel: string;
    entityIds?: string[] | null;
    nodeKinds?: InteractionTreeChildKind[] | null;
  }): void {
    if (!this.#vectorIndexSupported) {
      return;
    }
    const normalizedEntityIds = params.entityIds
      ? [...new Set(params.entityIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    const normalizedNodeKinds = params.nodeKinds
      ? [...new Set(params.nodeKinds.map((value) => value.trim()).filter(Boolean) as InteractionTreeChildKind[])]
      : null;
    const db = this.workspaceRuntimeDb(params.workspaceId);
    let query = `
      SELECT rowid AS vec_rowid, vector_json, entity_id, node_kind, embedding_model
      FROM interaction_node_embeddings
      WHERE embedding_model = ?
        AND dimensions = 1536
    `;
    const values: Array<string | number> = [params.embeddingModel];
    if (normalizedEntityIds && normalizedEntityIds.length > 0) {
      query += ` AND entity_id IN (${normalizedEntityIds.map(() => "?").join(", ")})`;
      values.push(...normalizedEntityIds);
    }
    if (normalizedNodeKinds && normalizedNodeKinds.length > 0) {
      query += ` AND node_kind IN (${normalizedNodeKinds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeKinds);
    }
    const sourceRows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    if (sourceRows.length === 0) {
      return;
    }
    const rowIds = sourceRows
      .map((row) => Number(row.vec_rowid))
      .filter((value) => Number.isFinite(value));
    if (rowIds.length === 0) {
      return;
    }
    const existingRowIds = new Set<number>(
      (
        db.prepare(`
          SELECT vec_rowid
          FROM interaction_node_embedding_vec
          WHERE vec_rowid IN (${rowIds.map(() => "?").join(", ")})
        `).all(...rowIds) as Array<{ vec_rowid: number | bigint }>
      )
        .map((row) => Number(row.vec_rowid))
        .filter((value) => Number.isFinite(value)),
    );
    const insert = db.prepare(`
      INSERT INTO interaction_node_embedding_vec (vec_rowid, embedding, entity_id, node_kind, embedding_model)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        const vecRowid = Number(row.vec_rowid);
        if (!Number.isFinite(vecRowid) || existingRowIds.has(vecRowid)) {
          continue;
        }
        const vector = this.parseJsonList(row.vector_json)
          .map((value) => (typeof value === "number" ? value : Number(value)))
          .filter((value) => Number.isFinite(value));
        if (vector.length !== 1536) {
          continue;
        }
        insert.run(
          vecRowid,
          new Float32Array(vector),
          String(row.entity_id),
          String(row.node_kind),
          String(row.embedding_model),
        );
      }
    });
    insertMany(sourceRows);
  }

  listInteractionNodeEmbeddings(params: {
    workspaceId: string;
    entityId?: string | null;
    embeddingModel?: string | null;
    nodeIds?: string[] | null;
  }): InteractionNodeEmbeddingRecord[] {
    const normalizedNodeIds = params.nodeIds
      ? [...new Set(params.nodeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    if (params.nodeIds && normalizedNodeIds && normalizedNodeIds.length === 0) {
      return [];
    }
    let query = `
      SELECT *
      FROM interaction_node_embeddings
      WHERE 1 = 1
    `;
    const values: Array<string | number> = [];
    if (params.entityId !== undefined) {
      if (params.entityId === null) {
        query += " AND entity_id IS NULL";
      } else {
        query += " AND entity_id = ?";
        values.push(params.entityId);
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
    if (normalizedNodeIds) {
      query += ` AND node_id IN (${normalizedNodeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeIds);
    }
    query += " ORDER BY updated_at DESC, created_at DESC, node_id ASC";
    const rows = this.workspaceRuntimeDb(params.workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToInteractionNodeEmbedding(row, params.workspaceId));
  }

  searchInteractionNodeEmbeddingsByVector(params: {
    workspaceId: string;
    embedding: Float32Array;
    embeddingModel: string;
    limit: number;
    entityIds?: string[] | null;
    nodeKinds?: InteractionTreeChildKind[] | null;
  }): InteractionNodeEmbeddingVectorSearchResult[] {
    if (!this.#vectorIndexSupported || params.embedding.length !== 1536) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.trunc(params.limit));
    const normalizedEntityIds = params.entityIds
      ? [...new Set(params.entityIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    const normalizedNodeKinds = params.nodeKinds
      ? [...new Set(params.nodeKinds.map((value) => value.trim()).filter(Boolean) as InteractionTreeChildKind[])]
      : null;
    this.backfillInteractionNodeEmbeddingVectors({
      workspaceId: params.workspaceId,
      embeddingModel: params.embeddingModel,
      entityIds: normalizedEntityIds,
      nodeKinds: normalizedNodeKinds,
    });
    let query = `
      SELECT vec_rowid, distance
      FROM interaction_node_embedding_vec
      WHERE embedding MATCH ?
        AND k = ?
        AND embedding_model = ?
    `;
    const values: Array<string | number | Float32Array> = [params.embedding, normalizedLimit, params.embeddingModel];
    if (normalizedEntityIds && normalizedEntityIds.length > 0) {
      query += ` AND entity_id IN (${normalizedEntityIds.map(() => "?").join(", ")})`;
      values.push(...normalizedEntityIds);
    }
    if (normalizedNodeKinds && normalizedNodeKinds.length > 0) {
      query += ` AND node_kind IN (${normalizedNodeKinds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeKinds);
    }
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(query)
      .all(...values) as Array<{ vec_rowid: number; distance: number }>;
    return this.interactionEmbeddingVectorResultsForRows(params.workspaceId, rows);
  }

  private interactionEmbeddingVectorResultsForRows(
    workspaceId: string,
    rows: Array<{ vec_rowid: number; distance: number }>
  ): InteractionNodeEmbeddingVectorSearchResult[] {
    if (rows.length === 0) {
      return [];
    }
    const rowIds = rows.map((row) => Number(row.vec_rowid)).filter((value) => Number.isFinite(value));
    if (rowIds.length === 0) {
      return [];
    }
    const db = this.workspaceRuntimeDb(workspaceId);
    const mappingRows = db
      .prepare(`
        SELECT rowid AS vec_rowid, *
        FROM interaction_node_embeddings
        WHERE rowid IN (${rowIds.map(() => "?").join(", ")})
      `)
      .all(...rowIds) as Array<Record<string, unknown>>;
    const byRowId = new Map<number, InteractionNodeEmbeddingRecord>();
    for (const row of mappingRows) {
      const vecRowid = Number(row.vec_rowid);
      if (!Number.isFinite(vecRowid)) {
        continue;
      }
      byRowId.set(vecRowid, this.rowToInteractionNodeEmbedding(row, workspaceId));
    }
    const results: InteractionNodeEmbeddingVectorSearchResult[] = [];
    for (const row of rows) {
      const mapping = byRowId.get(Number(row.vec_rowid));
      if (!mapping) {
        continue;
      }
      results.push({
        vecRowid: Number(row.vec_rowid),
        distance: Number(row.distance),
        workspaceId: mapping.workspaceId,
        nodeKind: mapping.nodeKind,
        nodeId: mapping.nodeId,
        entityId: mapping.entityId,
        embeddingModel: mapping.embeddingModel,
      });
    }
    return results;
  }

  upsertIntegrationTree(params: {
    workspaceId?: string | null;
    treeId: string;
    provider: string;
    ownerUserId?: string | null;
    accountNamespace?: string | null;
    accountDisplayName?: string | null;
    accountKey?: string | null;
    accountLabel?: string | null;
    slug: string;
    summary?: string | null;
    status?: IntegrationTreeStatus;
    createdAt?: string;
    updatedAt?: string;
  }): IntegrationTreeRecord {
    if (params.workspaceId === undefined) {
      throw new Error("upsertIntegrationTree requires workspaceId; pass null for legacy control-plane access");
    }
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    const existing = this.getIntegrationTree({ workspaceId, treeId: params.treeId });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    const accountNamespace = (
      params.accountNamespace
      ?? params.accountKey
      ?? existing?.accountNamespace
      ?? existing?.accountKey
      ?? ""
    ).trim();
    const accountDisplayName = (
      params.accountDisplayName
      ?? params.accountLabel
      ?? existing?.accountDisplayName
      ?? existing?.accountLabel
      ?? accountNamespace
    ).trim();
    const ownerUserId = (params.ownerUserId ?? existing?.ownerUserId ?? "").trim();
    if (workspaceId) {
      this.workspaceRuntimeDb(workspaceId)
        .prepare(`
	          INSERT INTO integration_trees (
	            workspace_id,
	            tree_id,
	            provider,
            owner_user_id,
            account_id,
            account_namespace,
            account_key,
            account_label,
            slug,
            summary,
	            status,
	            created_at,
	            updated_at
	          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, tree_id) DO UPDATE SET
            provider = excluded.provider,
            owner_user_id = excluded.owner_user_id,
            account_id = excluded.account_id,
            account_namespace = excluded.account_namespace,
            account_key = excluded.account_key,
            account_label = excluded.account_label,
            slug = excluded.slug,
            summary = excluded.summary,
            status = excluded.status,
            updated_at = excluded.updated_at
        `)
        .run(
          workspaceId,
          params.treeId,
          params.provider,
          "",
          accountNamespace,
          accountNamespace,
          accountNamespace,
          accountDisplayName,
          params.slug,
          params.summary ?? null,
          params.status ?? "active",
          createdAt,
          now,
        );
    } else {
      this.controlPlaneDb()
        .prepare(`
	          INSERT INTO integration_trees (
	            tree_id,
	            provider,
            owner_user_id,
            account_namespace,
            account_key,
            account_label,
            slug,
            summary,
	            status,
	            created_at,
	            updated_at
	          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tree_id) DO UPDATE SET
            provider = excluded.provider,
            owner_user_id = excluded.owner_user_id,
            account_namespace = excluded.account_namespace,
            account_key = excluded.account_key,
            account_label = excluded.account_label,
            slug = excluded.slug,
            summary = excluded.summary,
            status = excluded.status,
            updated_at = excluded.updated_at
        `)
        .run(
          params.treeId,
          params.provider,
          ownerUserId,
          accountNamespace,
          accountNamespace,
          accountDisplayName,
          params.slug,
          params.summary ?? null,
          params.status ?? "active",
          createdAt,
          now,
        );
    }
    const record = this.getIntegrationTree({ workspaceId, treeId: params.treeId });
    if (!record) {
      throw new Error("integration tree row not found after upsert");
    }
    return record;
  }

  getIntegrationTree(params: {
    workspaceId?: string | null;
    treeId: string;
  }): IntegrationTreeRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string], Record<string, unknown>>(
            "SELECT * FROM integration_trees WHERE workspace_id = ? AND tree_id = ? LIMIT 1",
          )
          .get(workspaceId, params.treeId)
        : db
          .prepare<[string], Record<string, unknown>>(
            "SELECT * FROM integration_trees WHERE tree_id = ? LIMIT 1",
          )
          .get(params.treeId);
      if (row) {
        return this.rowToIntegrationTree(row);
      }
    }
    return null;
  }

  getIntegrationTreeBySlug(params: {
    workspaceId?: string | null;
    slug: string;
  }): IntegrationTreeRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string], Record<string, unknown>>(
            "SELECT * FROM integration_trees WHERE workspace_id = ? AND slug = ? LIMIT 1",
          )
          .get(workspaceId, params.slug)
        : db
          .prepare<[string], Record<string, unknown>>(
            "SELECT * FROM integration_trees WHERE slug = ? LIMIT 1",
          )
          .get(params.slug);
      if (row) {
        return this.rowToIntegrationTree(row);
      }
    }
    return null;
  }

  getIntegrationTreeByAccountIdentity(params: {
    workspaceId?: string | null;
    provider: string;
    ownerUserId?: string | null;
    accountNamespace?: string | null;
    accountKey?: string | null;
  }): IntegrationTreeRecord | null {
    const accountNamespace = (params.accountNamespace ?? params.accountKey ?? "").trim();
    const ownerUserId = (params.ownerUserId ?? "").trim();
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_trees
              WHERE workspace_id = ?
                AND provider = ?
                AND account_namespace = ?
              LIMIT 1
            `,
          )
          .get(workspaceId, params.provider, accountNamespace)
        : db
          .prepare<[string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_trees
              WHERE provider = ?
                AND owner_user_id = ?
                AND account_namespace = ?
              LIMIT 1
            `,
          )
          .get(params.provider, ownerUserId, accountNamespace);
      if (row) {
        return this.rowToIntegrationTree(row);
      }
    }
    return null;
  }

  listIntegrationTrees(params: {
    workspaceId?: string | null;
    status?: IntegrationTreeStatus | null;
    provider?: string | null;
    ownerUserId?: string | null;
    limit?: number;
    offset?: number;
  } = {}): IntegrationTreeRecord[] {
    const results: IntegrationTreeRecord[] = [];
    const seen = new Set<string>();
    const maxRows = (params.limit ?? 200) + (params.offset ?? 0);
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      let query = `
        SELECT *
        FROM integration_trees
        WHERE 1 = 1
      `;
      const values: Array<string | number> = [];
      if (workspaceId) {
        query += " AND workspace_id = ?";
        values.push(workspaceId);
      }
      if (params.status !== undefined) {
        if (params.status === null) {
          query += " AND status IS NULL";
        } else {
          query += " AND status = ?";
          values.push(params.status);
        }
      }
      if (params.provider !== undefined) {
        if (params.provider === null) {
          query += " AND provider IS NULL";
        } else {
          query += " AND provider = ?";
          values.push(params.provider);
        }
      }
      if (params.ownerUserId !== undefined) {
        if (!workspaceId) {
          if (params.ownerUserId === null) {
            query += " AND owner_user_id IS NULL";
          } else {
            query += " AND (owner_user_id = ? OR owner_user_id IS NULL OR owner_user_id = '')";
            values.push(params.ownerUserId);
          }
        }
      }
      query += `
        ORDER BY updated_at DESC, created_at DESC, account_label COLLATE NOCASE ASC
        LIMIT ? OFFSET 0
      `;
      values.push(maxRows);
      const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const record = this.rowToIntegrationTree(row);
        const key = `${record.workspaceId ?? "control"}:${record.treeId}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(record);
        }
      }
    }
    results.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || left.accountDisplayName.localeCompare(right.accountDisplayName)
      || (left.workspaceId ?? "").localeCompare(right.workspaceId ?? "")
      || left.treeId.localeCompare(right.treeId),
    );
    return results.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 200));
  }

  upsertIntegrationLeaf(params: {
    workspaceId?: string | null;
    leafId: string;
    treeId: string;
    subjectKey: string;
    entityKey?: string | null;
    entityLabel?: string | null;
    branchKey?: string | null;
    branchLabel?: string | null;
    path: string;
    title: string;
    summary: string;
    fingerprint: string;
    bodySha256: string;
    tags?: string[] | null;
    sourceType?: string | null;
    sourceEventId?: string | null;
    sourceMessageId?: string | null;
    externalObjectId?: string | null;
    externalObjectType?: string | null;
    admissionConfidence?: number | null;
    observedAt?: string | null;
    supersedesLeafId?: string | null;
    supersededAt?: string | null;
    status?: IntegrationLeafStatus;
    createdAt?: string;
    updatedAt?: string;
  }): IntegrationLeafRecord {
    if (params.workspaceId === undefined) {
      throw new Error("upsertIntegrationLeaf requires workspaceId; pass null for legacy control-plane access");
    }
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    const existing = this.getIntegrationLeaf({ workspaceId, leafId: params.leafId });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    if (workspaceId) {
      this.workspaceRuntimeDb(workspaceId)
        .prepare(`
          INSERT INTO integration_leaves (
            workspace_id,
            leaf_id,
            tree_id,
            subject_key,
            entity_key,
            entity_label,
            branch_key,
            branch_label,
            path,
            title,
            summary,
            fingerprint,
            body_sha256,
            tags,
            source_type,
            source_event_id,
            source_message_id,
            external_object_id,
            external_object_type,
            admission_confidence,
            observed_at,
            supersedes_leaf_id,
            superseded_at,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, leaf_id) DO UPDATE SET
            tree_id = excluded.tree_id,
            subject_key = excluded.subject_key,
            entity_key = excluded.entity_key,
            entity_label = excluded.entity_label,
            branch_key = excluded.branch_key,
            branch_label = excluded.branch_label,
            path = excluded.path,
            title = excluded.title,
            summary = excluded.summary,
            fingerprint = excluded.fingerprint,
            body_sha256 = excluded.body_sha256,
            tags = excluded.tags,
            source_type = excluded.source_type,
            source_event_id = excluded.source_event_id,
            source_message_id = excluded.source_message_id,
            external_object_id = excluded.external_object_id,
            external_object_type = excluded.external_object_type,
            admission_confidence = excluded.admission_confidence,
            observed_at = excluded.observed_at,
            supersedes_leaf_id = excluded.supersedes_leaf_id,
            superseded_at = excluded.superseded_at,
            status = excluded.status,
            updated_at = excluded.updated_at
        `)
        .run(
          workspaceId,
          params.leafId,
          params.treeId,
          params.subjectKey,
          params.entityKey ?? null,
          params.entityLabel ?? null,
          params.branchKey ?? null,
          params.branchLabel ?? null,
          params.path,
          params.title,
          params.summary,
          params.fingerprint,
          params.bodySha256,
          JSON.stringify(params.tags ?? []),
          params.sourceType ?? null,
          params.sourceEventId ?? null,
          params.sourceMessageId ?? null,
          params.externalObjectId ?? null,
          params.externalObjectType ?? null,
          params.admissionConfidence ?? null,
          params.observedAt ?? null,
          params.supersedesLeafId ?? null,
          params.supersededAt ?? null,
          params.status ?? "active",
          createdAt,
          now,
        );
    } else {
      this.controlPlaneDb()
        .prepare(`
          INSERT INTO integration_leaves (
            leaf_id,
            tree_id,
            subject_key,
            entity_key,
            entity_label,
            branch_key,
            branch_label,
            path,
            title,
            summary,
            fingerprint,
            body_sha256,
            tags,
            source_type,
            source_event_id,
            source_message_id,
            external_object_id,
            external_object_type,
            admission_confidence,
            observed_at,
            supersedes_leaf_id,
            superseded_at,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(leaf_id) DO UPDATE SET
            tree_id = excluded.tree_id,
            subject_key = excluded.subject_key,
            entity_key = excluded.entity_key,
            entity_label = excluded.entity_label,
            branch_key = excluded.branch_key,
            branch_label = excluded.branch_label,
            path = excluded.path,
            title = excluded.title,
            summary = excluded.summary,
            fingerprint = excluded.fingerprint,
            body_sha256 = excluded.body_sha256,
            tags = excluded.tags,
            source_type = excluded.source_type,
            source_event_id = excluded.source_event_id,
            source_message_id = excluded.source_message_id,
            external_object_id = excluded.external_object_id,
            external_object_type = excluded.external_object_type,
            admission_confidence = excluded.admission_confidence,
            observed_at = excluded.observed_at,
            supersedes_leaf_id = excluded.supersedes_leaf_id,
            superseded_at = excluded.superseded_at,
            status = excluded.status,
            updated_at = excluded.updated_at
        `)
        .run(
          params.leafId,
          params.treeId,
          params.subjectKey,
          params.entityKey ?? null,
          params.entityLabel ?? null,
          params.branchKey ?? null,
          params.branchLabel ?? null,
          params.path,
          params.title,
          params.summary,
          params.fingerprint,
          params.bodySha256,
          JSON.stringify(params.tags ?? []),
          params.sourceType ?? null,
          params.sourceEventId ?? null,
          params.sourceMessageId ?? null,
          params.externalObjectId ?? null,
          params.externalObjectType ?? null,
          params.admissionConfidence ?? null,
          params.observedAt ?? null,
          params.supersedesLeafId ?? null,
          params.supersededAt ?? null,
          params.status ?? "active",
          createdAt,
          now,
        );
    }
    const record = this.getIntegrationLeaf({ workspaceId, leafId: params.leafId });
    if (!record) {
      throw new Error("integration leaf row not found after upsert");
    }
    return record;
  }

  getIntegrationLeaf(params: {
    workspaceId?: string | null;
    leafId: string;
  }): IntegrationLeafRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string], Record<string, unknown>>(
            "SELECT * FROM integration_leaves WHERE workspace_id = ? AND leaf_id = ? LIMIT 1",
          )
          .get(workspaceId, params.leafId)
        : db
          .prepare<[string], Record<string, unknown>>(
            "SELECT * FROM integration_leaves WHERE leaf_id = ? LIMIT 1",
          )
          .get(params.leafId);
      if (row) {
        return this.rowToIntegrationLeaf(row);
      }
    }
    return null;
  }

  getIntegrationLeafByPath(params: {
    workspaceId?: string | null;
    path: string;
  }): IntegrationLeafRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string], Record<string, unknown>>(
            "SELECT * FROM integration_leaves WHERE workspace_id = ? AND path = ? LIMIT 1",
          )
          .get(workspaceId, params.path)
        : db
          .prepare<[string], Record<string, unknown>>(
            "SELECT * FROM integration_leaves WHERE path = ? LIMIT 1",
          )
          .get(params.path);
      if (row) {
        return this.rowToIntegrationLeaf(row);
      }
    }
    return null;
  }

  getIntegrationLeafByFingerprint(params: {
    workspaceId?: string | null;
    treeId: string;
    fingerprint: string;
  }): IntegrationLeafRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_leaves
              WHERE workspace_id = ?
                AND tree_id = ?
                AND fingerprint = ?
              ORDER BY updated_at DESC, created_at DESC
              LIMIT 1
            `,
          )
          .get(workspaceId, params.treeId, params.fingerprint)
        : db
          .prepare<[string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_leaves
              WHERE tree_id = ?
                AND fingerprint = ?
              ORDER BY updated_at DESC, created_at DESC
              LIMIT 1
            `,
          )
          .get(params.treeId, params.fingerprint);
      if (row) {
        return this.rowToIntegrationLeaf(row);
      }
    }
    return null;
  }

  getLatestActiveIntegrationLeafBySubject(params: {
    workspaceId?: string | null;
    treeId: string;
    subjectKey: string;
  }): IntegrationLeafRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_leaves
              WHERE workspace_id = ?
                AND tree_id = ?
                AND subject_key = ?
                AND status = 'active'
              ORDER BY observed_at DESC, updated_at DESC, created_at DESC
              LIMIT 1
            `,
          )
          .get(workspaceId, params.treeId, params.subjectKey)
        : db
          .prepare<[string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_leaves
              WHERE tree_id = ?
                AND subject_key = ?
                AND status = 'active'
              ORDER BY observed_at DESC, updated_at DESC, created_at DESC
              LIMIT 1
            `,
          )
          .get(params.treeId, params.subjectKey);
      if (row) {
        return this.rowToIntegrationLeaf(row);
      }
    }
    return null;
  }

  listIntegrationLeaves(params: {
    workspaceId?: string | null;
    treeId?: string | null;
    status?: IntegrationLeafStatus | null;
    limit?: number;
    offset?: number;
  } = {}): IntegrationLeafRecord[] {
    const results: IntegrationLeafRecord[] = [];
    const seen = new Set<string>();
    const maxRows = (params.limit ?? 200) + (params.offset ?? 0);
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      let query = `
        SELECT *
        FROM integration_leaves
        WHERE 1 = 1
      `;
      const values: Array<string | number> = [];
      if (workspaceId) {
        query += " AND workspace_id = ?";
        values.push(workspaceId);
      }
      if (params.treeId !== undefined) {
        if (params.treeId === null) {
          query += " AND tree_id IS NULL";
        } else {
          query += " AND tree_id = ?";
          values.push(params.treeId);
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
        ORDER BY COALESCE(observed_at, updated_at) DESC, created_at DESC, leaf_id ASC
        LIMIT ? OFFSET 0
      `;
      values.push(maxRows);
      const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const record = this.rowToIntegrationLeaf(row);
        const key = `${record.workspaceId ?? "control"}:${record.leafId}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(record);
        }
      }
    }
    results.sort((left, right) =>
      (right.observedAt ?? right.updatedAt).localeCompare(left.observedAt ?? left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || left.leafId.localeCompare(right.leafId),
    );
    return results.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 200));
  }

  updateIntegrationLeafStatus(params: {
    workspaceId?: string | null;
    leafId: string;
    status: IntegrationLeafStatus;
    supersededAt?: string | null;
    updatedAt?: string;
  }): IntegrationLeafRecord | null {
    if (params.workspaceId === undefined) {
      throw new Error("updateIntegrationLeafStatus requires workspaceId; pass null for legacy control-plane access");
    }
    const now = params.updatedAt ?? utcNowIso();
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    if (workspaceId) {
      this.workspaceRuntimeDb(workspaceId)
        .prepare(`
          UPDATE integration_leaves
          SET status = ?,
              superseded_at = ?,
              updated_at = ?
          WHERE workspace_id = ?
            AND leaf_id = ?
        `)
        .run(
          params.status,
          params.supersededAt ?? null,
          now,
          workspaceId,
          params.leafId,
        );
    } else {
      this.controlPlaneDb()
        .prepare(`
          UPDATE integration_leaves
          SET status = ?,
              superseded_at = ?,
              updated_at = ?
          WHERE leaf_id = ?
        `)
        .run(
          params.status,
          params.supersededAt ?? null,
          now,
          params.leafId,
        );
    }
    return this.getIntegrationLeaf({ workspaceId, leafId: params.leafId });
  }

  replaceSemanticMemoryTree(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodes: Array<{
      nodeId: string;
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
    edges: Array<{
      parentNodeId: string;
      childNodeId: string;
      position: number;
      createdAt?: string;
    }>;
  }): SemanticMemoryNodeRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const replace = scope.db.transaction(() => {
      const now = utcNowIso();
      if (scope.workspaceId !== null) {
        scope.db.prepare(`
          DELETE FROM semantic_memory_edges
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);
        scope.db.prepare(`
          DELETE FROM semantic_memory_nodes
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);

        const insertNode = scope.db.prepare(`
          INSERT INTO semantic_memory_nodes (
            workspace_id,
            category,
            tree_id,
            node_id,
            node_class,
            node_kind,
            source_leaf_id,
            path,
            title,
            summary,
            body_sha256,
            child_count,
            observed_at,
            status,
            is_materialized,
            metadata,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const node of params.nodes) {
          insertNode.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            node.nodeId,
            node.nodeClass,
            node.nodeKind,
            node.sourceLeafId ?? null,
            node.path,
            node.title,
            node.summary,
            node.bodySha256,
            node.childCount ?? 0,
            node.observedAt ?? null,
            node.status ?? "active",
            node.isMaterialized ? 1 : 0,
            JSON.stringify(node.metadata ?? {}),
            node.createdAt ?? now,
            node.updatedAt ?? now,
          );
        }

        const insertEdge = scope.db.prepare(`
          INSERT INTO semantic_memory_edges (
            workspace_id,
            category,
            tree_id,
            parent_node_id,
            child_node_id,
            position,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const edge of params.edges) {
          insertEdge.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            edge.parentNodeId,
            edge.childNodeId,
            edge.position,
            edge.createdAt ?? now,
          );
        }
        return;
      }

      scope.db.prepare(`
        DELETE FROM semantic_memory_edges
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);
      scope.db.prepare(`
        DELETE FROM semantic_memory_nodes
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);

      const insertNode = scope.db.prepare(`
        INSERT INTO semantic_memory_nodes (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          source_leaf_id,
          path,
          title,
          summary,
          body_sha256,
          child_count,
          observed_at,
          status,
          is_materialized,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of params.nodes) {
        insertNode.run(
          params.category,
          params.treeId,
          node.nodeId,
          node.nodeClass,
          node.nodeKind,
          node.sourceLeafId ?? null,
          node.path,
          node.title,
          node.summary,
          node.bodySha256,
          node.childCount ?? 0,
          node.observedAt ?? null,
          node.status ?? "active",
          node.isMaterialized ? 1 : 0,
          JSON.stringify(node.metadata ?? {}),
          node.createdAt ?? now,
          node.updatedAt ?? now,
        );
      }

      const insertEdge = scope.db.prepare(`
        INSERT INTO semantic_memory_edges (
          category,
          tree_id,
          parent_node_id,
          child_node_id,
          position,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const edge of params.edges) {
        insertEdge.run(
          params.category,
          params.treeId,
          edge.parentNodeId,
          edge.childNodeId,
          edge.position,
          edge.createdAt ?? now,
        );
      }
    });
    replace();
    return this.listSemanticMemoryNodes({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      status: "active",
      limit: Math.max(200, params.nodes.length + 10),
    });
  }

  syncSemanticMemoryTree(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodes: Array<{
      nodeId: string;
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
    edges: Array<{
      parentNodeId: string;
      childNodeId: string;
      position: number;
      createdAt?: string;
    }>;
  }): SemanticMemoryNodeRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const sync = scope.db.transaction(() => {
      const now = utcNowIso();
      const existingNodes = this.listSemanticMemoryNodes({
        category: params.category,
        workspaceId: scope.workspaceId,
        treeId: params.treeId,
        limit: 10_000,
        offset: 0,
      });
      const existingNodesById = new Map(existingNodes.map((node) => [node.nodeId, node]));
      const desiredNodeIds = new Set(params.nodes.map((node) => node.nodeId));
      const upsertNode = scope.workspaceId !== null
        ? scope.db.prepare(`
            INSERT INTO semantic_memory_nodes (
              workspace_id,
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              source_leaf_id,
              path,
              title,
              summary,
              body_sha256,
              child_count,
              observed_at,
              status,
              is_materialized,
              metadata,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, category, tree_id, node_id) DO UPDATE SET
              node_class = excluded.node_class,
              node_kind = excluded.node_kind,
              source_leaf_id = excluded.source_leaf_id,
              path = excluded.path,
              title = excluded.title,
              summary = excluded.summary,
              body_sha256 = excluded.body_sha256,
              child_count = excluded.child_count,
              observed_at = excluded.observed_at,
              status = excluded.status,
              is_materialized = excluded.is_materialized,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `)
        : scope.db.prepare(`
            INSERT INTO semantic_memory_nodes (
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              source_leaf_id,
              path,
              title,
              summary,
              body_sha256,
              child_count,
              observed_at,
              status,
              is_materialized,
              metadata,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(category, tree_id, node_id) DO UPDATE SET
              node_class = excluded.node_class,
              node_kind = excluded.node_kind,
              source_leaf_id = excluded.source_leaf_id,
              path = excluded.path,
              title = excluded.title,
              summary = excluded.summary,
              body_sha256 = excluded.body_sha256,
              child_count = excluded.child_count,
              observed_at = excluded.observed_at,
              status = excluded.status,
              is_materialized = excluded.is_materialized,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `);
      for (const node of params.nodes) {
        const existing = existingNodesById.get(node.nodeId) ?? null;
        if (existing && this.semanticMemoryNodeMatches(existing, node)) {
          continue;
        }
        const createdAt = existing?.createdAt ?? node.createdAt ?? now;
        const updatedAt = node.updatedAt ?? now;
        const metadataJson = JSON.stringify(node.metadata ?? {});
        if (scope.workspaceId !== null) {
          upsertNode.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            node.nodeId,
            node.nodeClass,
            node.nodeKind,
            node.sourceLeafId ?? null,
            node.path,
            node.title,
            node.summary,
            node.bodySha256,
            node.childCount ?? 0,
            node.observedAt ?? null,
            node.status ?? "active",
            node.isMaterialized ? 1 : 0,
            metadataJson,
            createdAt,
            updatedAt,
          );
          continue;
        }
        upsertNode.run(
          params.category,
          params.treeId,
          node.nodeId,
          node.nodeClass,
          node.nodeKind,
          node.sourceLeafId ?? null,
          node.path,
          node.title,
          node.summary,
          node.bodySha256,
          node.childCount ?? 0,
          node.observedAt ?? null,
          node.status ?? "active",
          node.isMaterialized ? 1 : 0,
          metadataJson,
          createdAt,
          updatedAt,
        );
      }

      const existingEdges = this.listAllSemanticMemoryEdgesForTree({
        category: params.category,
        workspaceId: scope.workspaceId,
        treeId: params.treeId,
      });
      const existingEdgesByParent = new Map<string, SemanticMemoryContainmentEdgeRecord[]>();
      for (const edge of existingEdges) {
        const bucket = existingEdgesByParent.get(edge.parentNodeId);
        if (bucket) {
          bucket.push(edge);
        } else {
          existingEdgesByParent.set(edge.parentNodeId, [edge]);
        }
      }
      const desiredEdgesByParent = new Map<string, Array<{
        parentNodeId: string;
        childNodeId: string;
        position: number;
        createdAt?: string;
      }>>();
      for (const edge of params.edges) {
        const bucket = desiredEdgesByParent.get(edge.parentNodeId);
        if (bucket) {
          bucket.push(edge);
        } else {
          desiredEdgesByParent.set(edge.parentNodeId, [edge]);
        }
      }
      const deleteParentEdges = scope.workspaceId !== null
        ? scope.db.prepare(`
            DELETE FROM semantic_memory_edges
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND parent_node_id = ?
          `)
        : scope.db.prepare(`
            DELETE FROM semantic_memory_edges
            WHERE category = ? AND tree_id = ? AND parent_node_id = ?
          `);
      const insertEdge = scope.workspaceId !== null
        ? scope.db.prepare(`
            INSERT INTO semantic_memory_edges (
              workspace_id,
              category,
              tree_id,
              parent_node_id,
              child_node_id,
              position,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
        : scope.db.prepare(`
            INSERT INTO semantic_memory_edges (
              category,
              tree_id,
              parent_node_id,
              child_node_id,
              position,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `);
      const parentIds = new Set([
        ...existingEdgesByParent.keys(),
        ...desiredEdgesByParent.keys(),
      ]);
      for (const parentNodeId of parentIds) {
        const existingBucket = [...(existingEdgesByParent.get(parentNodeId) ?? [])]
          .sort((left, right) => left.position - right.position || left.childNodeId.localeCompare(right.childNodeId));
        const desiredBucket = [...(desiredEdgesByParent.get(parentNodeId) ?? [])]
          .sort((left, right) => left.position - right.position || left.childNodeId.localeCompare(right.childNodeId));
        if (this.semanticMemoryEdgesMatch(existingBucket, desiredBucket)) {
          continue;
        }
        if (scope.workspaceId !== null) {
          deleteParentEdges.run(scope.workspaceId, params.category, params.treeId, parentNodeId);
        } else {
          deleteParentEdges.run(params.category, params.treeId, parentNodeId);
        }
        for (const edge of desiredBucket) {
          const existingEdge = existingBucket.find((candidate) => candidate.childNodeId === edge.childNodeId) ?? null;
          const createdAt = existingEdge?.createdAt ?? edge.createdAt ?? now;
          if (scope.workspaceId !== null) {
            insertEdge.run(
              scope.workspaceId,
              params.category,
              params.treeId,
              edge.parentNodeId,
              edge.childNodeId,
              edge.position,
              createdAt,
            );
            continue;
          }
          insertEdge.run(
            params.category,
            params.treeId,
            edge.parentNodeId,
            edge.childNodeId,
            edge.position,
            createdAt,
          );
        }
      }

      const deleteNode = scope.workspaceId !== null
        ? scope.db.prepare(`
            DELETE FROM semantic_memory_nodes
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
          `)
        : scope.db.prepare(`
            DELETE FROM semantic_memory_nodes
            WHERE category = ? AND tree_id = ? AND node_id = ?
          `);
      for (const node of existingNodes) {
        if (desiredNodeIds.has(node.nodeId)) {
          continue;
        }
        if (scope.workspaceId !== null) {
          deleteNode.run(scope.workspaceId, params.category, params.treeId, node.nodeId);
        } else {
          deleteNode.run(params.category, params.treeId, node.nodeId);
        }
      }
    });
    sync();
    return this.listSemanticMemoryNodes({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      status: "active",
      limit: Math.max(200, params.nodes.length + 10),
    });
  }

  replaceSemanticMemorySearchDocs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    docs: Array<{
      nodeId: string;
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
      updatedAt?: string;
    }>;
  }): SemanticMemorySearchDocRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const replace = scope.db.transaction(() => {
      const now = utcNowIso();
      if (scope.workspaceId !== null) {
        scope.db.prepare(`
          DELETE FROM semantic_memory_search_docs
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);
        scope.db.prepare(`
          DELETE FROM semantic_memory_search_fts
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);

        const insertDoc = scope.db.prepare(`
          INSERT INTO semantic_memory_search_docs (
            workspace_id,
            category,
            tree_id,
            node_id,
            node_class,
            node_kind,
            path,
            child_count,
            title,
            summary,
            body_text,
            excerpt,
            observed_at,
            status,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFts = scope.db.prepare(`
          INSERT INTO semantic_memory_search_fts (
            workspace_id,
            category,
            tree_id,
            node_id,
            node_class,
            node_kind,
            path,
            child_count,
            title,
            summary,
            body_text,
            excerpt,
            observed_at,
            status,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const doc of params.docs) {
          const updatedAt = doc.updatedAt ?? now;
          const childCount = doc.childCount ?? 0;
          const excerpt = doc.excerpt ?? null;
          const observedAt = doc.observedAt ?? null;
          const status = doc.status ?? "active";
          insertDoc.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            doc.nodeId,
            doc.nodeClass,
            doc.nodeKind,
            doc.path,
            childCount,
            doc.title,
            doc.summary,
            doc.bodyText,
            excerpt,
            observedAt,
            status,
            updatedAt,
          );
          insertFts.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            doc.nodeId,
            doc.nodeClass,
            doc.nodeKind,
            doc.path,
            childCount,
            doc.title,
            doc.summary,
            doc.bodyText,
            excerpt,
            observedAt,
            status,
            updatedAt,
          );
        }
        return;
      }

      scope.db.prepare(`
        DELETE FROM semantic_memory_search_docs
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);
      scope.db.prepare(`
        DELETE FROM semantic_memory_search_fts
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);

      const insertDoc = scope.db.prepare(`
        INSERT INTO semantic_memory_search_docs (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = scope.db.prepare(`
        INSERT INTO semantic_memory_search_fts (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const doc of params.docs) {
        const updatedAt = doc.updatedAt ?? now;
        const childCount = doc.childCount ?? 0;
        const excerpt = doc.excerpt ?? null;
        const observedAt = doc.observedAt ?? null;
        const status = doc.status ?? "active";
        insertDoc.run(
          params.category,
          params.treeId,
          doc.nodeId,
          doc.nodeClass,
          doc.nodeKind,
          doc.path,
          childCount,
          doc.title,
          doc.summary,
          doc.bodyText,
          excerpt,
          observedAt,
          status,
          updatedAt,
        );
        insertFts.run(
          params.category,
          params.treeId,
          doc.nodeId,
          doc.nodeClass,
          doc.nodeKind,
          doc.path,
          childCount,
          doc.title,
          doc.summary,
          doc.bodyText,
          excerpt,
          observedAt,
          status,
          updatedAt,
        );
      }
    });
    replace();
    return this.listSemanticMemorySearchDocs({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      status: "active",
      limit: Math.max(200, params.docs.length + 10),
    });
  }

  syncSemanticMemorySearchDocs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    docs: Array<{
      nodeId: string;
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
      updatedAt?: string;
    }>;
  }): SemanticMemorySearchDocRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const sync = scope.db.transaction(() => {
      const now = utcNowIso();
      const existingDocs = this.listSemanticMemorySearchDocs({
        category: params.category,
        workspaceId: scope.workspaceId,
        treeId: params.treeId,
        limit: 10_000,
        offset: 0,
      });
      const existingDocsById = new Map(existingDocs.map((doc) => [doc.nodeId, doc]));
      const desiredNodeIds = new Set(params.docs.map((doc) => doc.nodeId));
      const upsertDoc = scope.workspaceId !== null
        ? scope.db.prepare(`
            INSERT INTO semantic_memory_search_docs (
              workspace_id,
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              path,
              child_count,
              title,
              summary,
              body_text,
              excerpt,
              observed_at,
              status,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, category, tree_id, node_id) DO UPDATE SET
              node_class = excluded.node_class,
              node_kind = excluded.node_kind,
              path = excluded.path,
              child_count = excluded.child_count,
              title = excluded.title,
              summary = excluded.summary,
              body_text = excluded.body_text,
              excerpt = excluded.excerpt,
              observed_at = excluded.observed_at,
              status = excluded.status,
              updated_at = excluded.updated_at
          `)
        : scope.db.prepare(`
            INSERT INTO semantic_memory_search_docs (
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              path,
              child_count,
              title,
              summary,
              body_text,
              excerpt,
              observed_at,
              status,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(category, tree_id, node_id) DO UPDATE SET
              node_class = excluded.node_class,
              node_kind = excluded.node_kind,
              path = excluded.path,
              child_count = excluded.child_count,
              title = excluded.title,
              summary = excluded.summary,
              body_text = excluded.body_text,
              excerpt = excluded.excerpt,
              observed_at = excluded.observed_at,
              status = excluded.status,
              updated_at = excluded.updated_at
          `);
      const deleteDoc = scope.workspaceId !== null
        ? scope.db.prepare(`
            DELETE FROM semantic_memory_search_docs
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
          `)
        : scope.db.prepare(`
            DELETE FROM semantic_memory_search_docs
            WHERE category = ? AND tree_id = ? AND node_id = ?
          `);
      const deleteFtsByNode = scope.workspaceId !== null
        ? scope.db.prepare(`
            DELETE FROM semantic_memory_search_fts
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
          `)
        : scope.db.prepare(`
            DELETE FROM semantic_memory_search_fts
            WHERE category = ? AND tree_id = ? AND node_id = ?
          `);
      const insertFts = scope.workspaceId !== null
        ? scope.db.prepare(`
            INSERT INTO semantic_memory_search_fts (
              workspace_id,
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              path,
              child_count,
              title,
              summary,
              body_text,
              excerpt,
              observed_at,
              status,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
        : scope.db.prepare(`
            INSERT INTO semantic_memory_search_fts (
              category,
              tree_id,
              node_id,
              node_class,
              node_kind,
              path,
              child_count,
              title,
              summary,
              body_text,
              excerpt,
              observed_at,
              status,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
      for (const existing of existingDocs) {
        if (desiredNodeIds.has(existing.nodeId)) {
          continue;
        }
        if (scope.workspaceId !== null) {
          deleteDoc.run(scope.workspaceId, params.category, params.treeId, existing.nodeId);
          deleteFtsByNode.run(scope.workspaceId, params.category, params.treeId, existing.nodeId);
        } else {
          deleteDoc.run(params.category, params.treeId, existing.nodeId);
          deleteFtsByNode.run(params.category, params.treeId, existing.nodeId);
        }
      }
      for (const doc of params.docs) {
        const existing = existingDocsById.get(doc.nodeId) ?? null;
        if (existing && this.semanticMemorySearchDocMatches(existing, doc)) {
          continue;
        }
        const updatedAt = doc.updatedAt ?? now;
        const childCount = doc.childCount ?? 0;
        const excerpt = doc.excerpt ?? null;
        const observedAt = doc.observedAt ?? null;
        const status = doc.status ?? "active";
        if (scope.workspaceId !== null) {
          upsertDoc.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            doc.nodeId,
            doc.nodeClass,
            doc.nodeKind,
            doc.path,
            childCount,
            doc.title,
            doc.summary,
            doc.bodyText,
            excerpt,
            observedAt,
            status,
            updatedAt,
          );
          deleteFtsByNode.run(scope.workspaceId, params.category, params.treeId, doc.nodeId);
          insertFts.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            doc.nodeId,
            doc.nodeClass,
            doc.nodeKind,
            doc.path,
            childCount,
            doc.title,
            doc.summary,
            doc.bodyText,
            excerpt,
            observedAt,
            status,
            updatedAt,
          );
          continue;
        }
        upsertDoc.run(
          params.category,
          params.treeId,
          doc.nodeId,
          doc.nodeClass,
          doc.nodeKind,
          doc.path,
          childCount,
          doc.title,
          doc.summary,
          doc.bodyText,
          excerpt,
          observedAt,
          status,
          updatedAt,
        );
        deleteFtsByNode.run(params.category, params.treeId, doc.nodeId);
        insertFts.run(
          params.category,
          params.treeId,
          doc.nodeId,
          doc.nodeClass,
          doc.nodeKind,
          doc.path,
          childCount,
          doc.title,
          doc.summary,
          doc.bodyText,
          excerpt,
          observedAt,
          status,
          updatedAt,
        );
      }
    });
    sync();
    return this.listSemanticMemorySearchDocs({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      status: "active",
      limit: Math.max(200, params.docs.length + 10),
    });
  }

  getSemanticMemorySearchDoc(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodeId: string;
  }): SemanticMemorySearchDocRecord | null {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    if (scope.workspaceId !== null) {
      const row = scope.db
        .prepare<[string, string, string, string], Record<string, unknown>>(
          `
            SELECT *
            FROM semantic_memory_search_docs
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
            LIMIT 1
          `,
        )
        .get(scope.workspaceId, params.category, params.treeId, params.nodeId);
      return row ? this.rowToSemanticMemorySearchDoc(row) : null;
    }
    const row = scope.db
      .prepare<[string, string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM semantic_memory_search_docs
          WHERE category = ? AND tree_id = ? AND node_id = ?
          LIMIT 1
        `,
      )
      .get(params.category, params.treeId, params.nodeId);
    return row ? this.rowToSemanticMemorySearchDoc(row) : null;
  }

  upsertSemanticMemorySearchDoc(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodeId: string;
    nodeClass: SemanticMemoryNodeClass;
    nodeKind: string;
    path: string;
    childCount?: number;
    title: string;
    summary: string;
    bodyText: string;
    excerpt?: string | null;
    observedAt?: string | null;
    status?: MemoryNodeStatus;
    updatedAt?: string;
  }): SemanticMemorySearchDocRecord {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const now = params.updatedAt ?? utcNowIso();
    const childCount = params.childCount ?? 0;
    const excerpt = params.excerpt ?? null;
    const observedAt = params.observedAt ?? null;
    const status = params.status ?? "active";
    if (scope.workspaceId !== null) {
      scope.db.prepare(`
        INSERT INTO semantic_memory_search_docs (
          workspace_id,
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, category, tree_id, node_id) DO UPDATE SET
          node_class = excluded.node_class,
          node_kind = excluded.node_kind,
          path = excluded.path,
          child_count = excluded.child_count,
          title = excluded.title,
          summary = excluded.summary,
          body_text = excluded.body_text,
          excerpt = excluded.excerpt,
          observed_at = excluded.observed_at,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(
        scope.workspaceId,
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.path,
        childCount,
        params.title,
        params.summary,
        params.bodyText,
        excerpt,
        observedAt,
        status,
        now,
      );
      scope.db.prepare(`
        DELETE FROM semantic_memory_search_fts
        WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
      `).run(scope.workspaceId, params.category, params.treeId, params.nodeId);
      scope.db.prepare(`
        INSERT INTO semantic_memory_search_fts (
          workspace_id,
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.workspaceId,
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.path,
        childCount,
        params.title,
        params.summary,
        params.bodyText,
        excerpt,
        observedAt,
        status,
        now,
      );
    } else {
      scope.db.prepare(`
        INSERT INTO semantic_memory_search_docs (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, tree_id, node_id) DO UPDATE SET
          node_class = excluded.node_class,
          node_kind = excluded.node_kind,
          path = excluded.path,
          child_count = excluded.child_count,
          title = excluded.title,
          summary = excluded.summary,
          body_text = excluded.body_text,
          excerpt = excluded.excerpt,
          observed_at = excluded.observed_at,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.path,
        childCount,
        params.title,
        params.summary,
        params.bodyText,
        excerpt,
        observedAt,
        status,
        now,
      );
      scope.db.prepare(`
        DELETE FROM semantic_memory_search_fts
        WHERE category = ? AND tree_id = ? AND node_id = ?
      `).run(params.category, params.treeId, params.nodeId);
      scope.db.prepare(`
        INSERT INTO semantic_memory_search_fts (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.path,
        childCount,
        params.title,
        params.summary,
        params.bodyText,
        excerpt,
        observedAt,
        status,
        now,
      );
    }
    const record = this.getSemanticMemorySearchDoc({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      nodeId: params.nodeId,
    });
    if (!record) {
      throw new Error("semantic memory search doc row not found after upsert");
    }
    return record;
  }

  listSemanticMemorySearchDocs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId?: string | null;
    treeIds?: string[] | null;
    nodeId?: string | null;
    nodeIds?: string[] | null;
    nodeClass?: SemanticMemoryNodeClass | null;
    nodeKind?: string | null;
    status?: MemoryNodeStatus | null;
    limit?: number;
    offset?: number;
  }): SemanticMemorySearchDocRecord[] {
    const normalizedTreeIds = params.treeIds
      ? [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    const normalizedNodeIds = params.nodeIds
      ? [...new Set(params.nodeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    if (params.treeIds && normalizedTreeIds && normalizedTreeIds.length === 0) {
      return [];
    }
    if (params.nodeIds && normalizedNodeIds && normalizedNodeIds.length === 0) {
      return [];
    }
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    let query = `
      SELECT *
      FROM semantic_memory_search_docs
      WHERE category = ?
    `;
    const values: Array<string | number> = [params.category];
    if (scope.workspaceId !== null) {
      query += " AND workspace_id = ?";
      values.push(scope.workspaceId);
    }
    if (normalizedTreeIds) {
      query += ` AND tree_id IN (${normalizedTreeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedTreeIds);
    } else if (params.treeId !== undefined) {
      if (params.treeId === null) {
        query += " AND tree_id IS NULL";
      } else {
        query += " AND tree_id = ?";
        values.push(params.treeId);
      }
    }
    if (params.nodeId !== undefined) {
      if (params.nodeId === null) {
        query += " AND node_id IS NULL";
      } else {
        query += " AND node_id = ?";
        values.push(params.nodeId);
      }
    } else if (normalizedNodeIds) {
      query += ` AND node_id IN (${normalizedNodeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeIds);
    }
    if (params.nodeClass !== undefined) {
      if (params.nodeClass === null) {
        query += " AND node_class IS NULL";
      } else {
        query += " AND node_class = ?";
        values.push(params.nodeClass);
      }
    }
    if (params.nodeKind !== undefined) {
      if (params.nodeKind === null) {
        query += " AND node_kind IS NULL";
      } else {
        query += " AND node_kind = ?";
        values.push(params.nodeKind);
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
      ORDER BY updated_at DESC, path ASC, node_id ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 500, params.offset ?? 0);
    const rows = scope.db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemorySearchDoc(row));
  }

  searchSemanticMemorySearchDocs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    matchQuery: string;
    treeId?: string | null;
    treeIds?: string[] | null;
    nodeClass?: SemanticMemoryNodeClass | null;
    nodeKind?: string | null;
    status?: MemoryNodeStatus | null;
    limit?: number;
    offset?: number;
  }): SemanticMemorySearchHitRecord[] {
    const matchQuery = params.matchQuery.trim();
    if (!matchQuery) {
      return [];
    }
    const normalizedTreeIds = params.treeIds
      ? [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    if (params.treeIds && normalizedTreeIds && normalizedTreeIds.length === 0) {
      return [];
    }
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    let query = `
      SELECT *,
             bm25(semantic_memory_search_fts, 4.0, 2.0, 1.0) AS bm25_score
      FROM semantic_memory_search_fts
      WHERE semantic_memory_search_fts MATCH ?
    `;
    const values: Array<string | number> = [matchQuery];
    if (scope.workspaceId !== null) {
      query += " AND workspace_id = ?";
      values.push(scope.workspaceId);
    }
    query += " AND category = ?";
    values.push(params.category);
    if (normalizedTreeIds) {
      query += ` AND tree_id IN (${normalizedTreeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedTreeIds);
    } else if (params.treeId !== undefined) {
      if (params.treeId === null) {
        query += " AND tree_id IS NULL";
      } else {
        query += " AND tree_id = ?";
        values.push(params.treeId);
      }
    }
    if (params.nodeClass !== undefined) {
      if (params.nodeClass === null) {
        query += " AND node_class IS NULL";
      } else {
        query += " AND node_class = ?";
        values.push(params.nodeClass);
      }
    }
    if (params.nodeKind !== undefined) {
      if (params.nodeKind === null) {
        query += " AND node_kind IS NULL";
      } else {
        query += " AND node_kind = ?";
        values.push(params.nodeKind);
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
      ORDER BY bm25_score ASC, updated_at DESC, path ASC, node_id ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 100, params.offset ?? 0);
    // Security/DoS: `matchQuery` is a raw FTS5 MATCH expression bound as a
    // parameter (so no SQL injection), but a malformed FTS5 query (unbalanced
    // quotes, a bad operator, etc.) makes SQLite raise SQLITE_ERROR. Rather
    // than surface that as a 500, treat an invalid FTS expression as "no
    // results" — normal token queries still work unchanged.
    let rows: Array<Record<string, unknown>>;
    try {
      rows = scope.db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? "";
      if (code === "SQLITE_ERROR" || /fts5|MATCH|syntax error/i.test(String((error as Error)?.message ?? ""))) {
        return [];
      }
      throw error;
    }
    return rows.map((row) => this.rowToSemanticMemorySearchHit(row));
  }

  getSemanticMemoryNode(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodeId: string;
  }): SemanticMemoryNodeRecord | null {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    if (scope.workspaceId !== null) {
      const row = scope.db
        .prepare<[string, string, string, string], Record<string, unknown>>(
          `
            SELECT *
            FROM semantic_memory_nodes
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND node_id = ?
            LIMIT 1
          `,
        )
        .get(scope.workspaceId, params.category, params.treeId, params.nodeId);
      return row ? this.rowToSemanticMemoryNode(row) : null;
    }
    const row = scope.db
      .prepare<[string, string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM semantic_memory_nodes
          WHERE category = ? AND tree_id = ? AND node_id = ?
          LIMIT 1
        `,
      )
      .get(params.category, params.treeId, params.nodeId);
    return row ? this.rowToSemanticMemoryNode(row) : null;
  }

  upsertSemanticMemoryNode(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodeId: string;
    nodeClass: SemanticMemoryNodeClass;
    nodeKind: string;
    sourceLeafId?: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: MemoryNodeStatus;
    isMaterialized?: boolean;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }): SemanticMemoryNodeRecord {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const existing = this.getSemanticMemoryNode({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      nodeId: params.nodeId,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    const metadataJson = JSON.stringify(params.metadata ?? {});
    if (scope.workspaceId !== null) {
      scope.db.prepare(`
        INSERT INTO semantic_memory_nodes (
          workspace_id,
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          source_leaf_id,
          path,
          title,
          summary,
          body_sha256,
          child_count,
          observed_at,
          status,
          is_materialized,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, category, tree_id, node_id) DO UPDATE SET
          node_class = excluded.node_class,
          node_kind = excluded.node_kind,
          source_leaf_id = excluded.source_leaf_id,
          path = excluded.path,
          title = excluded.title,
          summary = excluded.summary,
          body_sha256 = excluded.body_sha256,
          child_count = excluded.child_count,
          observed_at = excluded.observed_at,
          status = excluded.status,
          is_materialized = excluded.is_materialized,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        scope.workspaceId,
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.sourceLeafId ?? null,
        params.path,
        params.title,
        params.summary,
        params.bodySha256,
        params.childCount ?? 0,
        params.observedAt ?? null,
        params.status ?? "active",
        params.isMaterialized ? 1 : 0,
        metadataJson,
        createdAt,
        now,
      );
    } else {
      scope.db.prepare(`
        INSERT INTO semantic_memory_nodes (
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          source_leaf_id,
          path,
          title,
          summary,
          body_sha256,
          child_count,
          observed_at,
          status,
          is_materialized,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, tree_id, node_id) DO UPDATE SET
          node_class = excluded.node_class,
          node_kind = excluded.node_kind,
          source_leaf_id = excluded.source_leaf_id,
          path = excluded.path,
          title = excluded.title,
          summary = excluded.summary,
          body_sha256 = excluded.body_sha256,
          child_count = excluded.child_count,
          observed_at = excluded.observed_at,
          status = excluded.status,
          is_materialized = excluded.is_materialized,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        params.category,
        params.treeId,
        params.nodeId,
        params.nodeClass,
        params.nodeKind,
        params.sourceLeafId ?? null,
        params.path,
        params.title,
        params.summary,
        params.bodySha256,
        params.childCount ?? 0,
        params.observedAt ?? null,
        params.status ?? "active",
        params.isMaterialized ? 1 : 0,
        metadataJson,
        createdAt,
        now,
      );
    }
    const record = this.getSemanticMemoryNode({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      nodeId: params.nodeId,
    });
    if (!record) {
      throw new Error("semantic memory node row not found after upsert");
    }
    return record;
  }

  getSemanticMemoryNodeByPath(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    path: string;
  }): SemanticMemoryNodeRecord | null {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    if (scope.workspaceId !== null) {
      const row = scope.db
        .prepare<[string, string, string], Record<string, unknown>>(
          `
            SELECT *
            FROM semantic_memory_nodes
            WHERE workspace_id = ? AND category = ? AND path = ?
            LIMIT 1
          `,
        )
        .get(scope.workspaceId, params.category, params.path);
      return row ? this.rowToSemanticMemoryNode(row) : null;
    }
    const row = scope.db
      .prepare<[string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM semantic_memory_nodes
          WHERE category = ? AND path = ?
          LIMIT 1
        `,
      )
      .get(params.category, params.path);
    return row ? this.rowToSemanticMemoryNode(row) : null;
  }

  listSemanticMemoryNodes(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId?: string | null;
    nodeClass?: SemanticMemoryNodeClass | null;
    nodeKind?: string | null;
    status?: MemoryNodeStatus | null;
    limit?: number;
    offset?: number;
  }): SemanticMemoryNodeRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    let query = `
      SELECT *
      FROM semantic_memory_nodes
      WHERE category = ?
    `;
    const values: Array<string | number> = [params.category];
    if (scope.workspaceId !== null) {
      query += " AND workspace_id = ?";
      values.push(scope.workspaceId);
    }
    if (params.treeId !== undefined) {
      if (params.treeId === null) {
        query += " AND tree_id IS NULL";
      } else {
        query += " AND tree_id = ?";
        values.push(params.treeId);
      }
    }
    if (params.nodeClass !== undefined) {
      if (params.nodeClass === null) {
        query += " AND node_class IS NULL";
      } else {
        query += " AND node_class = ?";
        values.push(params.nodeClass);
      }
    }
    if (params.nodeKind !== undefined) {
      if (params.nodeKind === null) {
        query += " AND node_kind IS NULL";
      } else {
        query += " AND node_kind = ?";
        values.push(params.nodeKind);
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
      ORDER BY path ASC, updated_at DESC, node_id ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 500, params.offset ?? 0);
    const rows = scope.db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemoryNode(row));
  }

  /**
   * Wipe this workspace's durable memory: every semantic + interaction row and
   * the on-disk mirror under `.holaboss/memory`.
   *
   * Both halves matter. Deleting only the rows leaves the markdown mirror behind
   * as orphans (a manual purge that skipped it left ~69k stray files), and
   * deleting only files leaves recall returning rows whose content is gone.
   *
   * Backfill-completion flags are deliberately NOT cleared: they gate one-shot
   * imports that would re-ingest historical outputs as memory on the next boot,
   * which would silently undo the wipe.
   *
   * sqlite-vec virtual tables are cleared through their shadow tables — the vec0
   * module is not always loadable in every process that opens this DB, and a
   * plain DELETE against the virtual table would throw there.
   */
  clearWorkspaceMemory(params: { workspaceId: string }): {
    deletedRows: number;
    deletedFiles: number;
  } {
    const db = this.workspaceRuntimeDb(params.workspaceId);
    const rowTables = [
      "semantic_memory_nodes",
      "semantic_memory_edges",
      "semantic_memory_relations",
      "semantic_memory_evidence_refs",
      "semantic_memory_search_docs",
      "semantic_memory_search_fts",
      "interaction_entities",
      "interaction_leaves",
      "interaction_node_embeddings",
      "interaction_node_embedding_vec_chunks",
      "interaction_node_embedding_vec_rowids",
      "interaction_node_embedding_vec_vector_chunks00",
      "interaction_node_embedding_vec_metadatachunks00",
      "interaction_node_embedding_vec_metadatachunks01",
      "interaction_node_embedding_vec_metadatachunks02",
      "interaction_node_embedding_vec_metadatatext00",
      "interaction_node_embedding_vec_metadatatext01",
      "interaction_node_embedding_vec_metadatatext02",
      "memory_recall_vec_chunks",
      "memory_recall_vec_rowids",
      "memory_recall_vec_vector_chunks00",
      "memory_embedding_index",
    ];
    let deletedRows = 0;
    const wipe = db.transaction(() => {
      for (const table of rowTables) {
        try {
          deletedRows += db.prepare(`DELETE FROM "${table}"`).run().changes;
        } catch {
          // Table absent on this schema version (or a vec shadow that this
          // build does not create) — nothing to clear.
        }
      }
      try {
        deletedRows += db
          .prepare(
            "DELETE FROM workspace_runtime_metadata WHERE key LIKE 'workspace_memory_batch_%'",
          )
          .run().changes;
      } catch {
        // Metadata bookkeeping only; its absence is not a failure.
      }
    });
    wipe();

    let deletedFiles = 0;
    try {
      const memoryDir = path.join(
        this.workspaceDir(params.workspaceId),
        WORKSPACE_RUNTIME_DIRNAME,
        "memory",
      );
      const countFiles = (dir: string): number => {
        let total = 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          total += entry.isDirectory()
            ? countFiles(path.join(dir, entry.name))
            : 1;
        }
        return total;
      };
      if (fs.existsSync(memoryDir)) {
        deletedFiles = countFiles(memoryDir);
        for (const entry of fs.readdirSync(memoryDir)) {
          fs.rmSync(path.join(memoryDir, entry), {
            recursive: true,
            force: true,
          });
        }
      }
    } catch {
      // Rows are already gone; a mirror we could not remove is stale but inert,
      // and must not fail the whole clear.
    }

    return { deletedRows, deletedFiles };
  }

  listSemanticMemoryChildren(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    parentNodeId: string;
  }): SemanticMemoryContainmentEdgeRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    if (scope.workspaceId !== null) {
      const rows = scope.db
        .prepare<[string, string, string, string], Record<string, unknown>>(
          `
            SELECT *
            FROM semantic_memory_edges
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND parent_node_id = ?
            ORDER BY position ASC, child_node_id ASC
          `,
        )
        .all(scope.workspaceId, params.category, params.treeId, params.parentNodeId) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToSemanticMemoryContainmentEdge(row));
    }
    const rows = scope.db
      .prepare<[string, string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM semantic_memory_edges
          WHERE category = ? AND tree_id = ? AND parent_node_id = ?
          ORDER BY position ASC, child_node_id ASC
        `,
      )
      .all(params.category, params.treeId, params.parentNodeId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemoryContainmentEdge(row));
  }

  replaceSemanticMemoryRelations(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    relations: Array<{
      fromNodeId: string;
      toNodeId: string;
      relationType: string;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
  }): SemanticMemoryRelationRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const replace = scope.db.transaction(() => {
      const now = utcNowIso();
      if (scope.workspaceId !== null) {
        scope.db.prepare(`
          DELETE FROM semantic_memory_relations
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);

        const insertRelation = scope.db.prepare(`
          INSERT INTO semantic_memory_relations (
            workspace_id,
            category,
            tree_id,
            from_node_id,
            to_node_id,
            relation_type,
            metadata,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const relation of params.relations) {
          insertRelation.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            relation.fromNodeId,
            relation.toNodeId,
            relation.relationType,
            JSON.stringify(relation.metadata ?? {}),
            relation.createdAt ?? now,
            relation.updatedAt ?? now,
          );
        }
        return;
      }

      scope.db.prepare(`
        DELETE FROM semantic_memory_relations
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);

      const insertRelation = scope.db.prepare(`
        INSERT INTO semantic_memory_relations (
          category,
          tree_id,
          from_node_id,
          to_node_id,
          relation_type,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const relation of params.relations) {
        insertRelation.run(
          params.category,
          params.treeId,
          relation.fromNodeId,
          relation.toNodeId,
          relation.relationType,
          JSON.stringify(relation.metadata ?? {}),
          relation.createdAt ?? now,
          relation.updatedAt ?? now,
        );
      }
    });
    replace();
    return this.listSemanticMemoryRelations({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      limit: Math.max(200, params.relations.length + 10),
    });
  }

  syncSemanticMemoryRelations(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    relations: Array<{
      fromNodeId: string;
      toNodeId: string;
      relationType: string;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
  }): SemanticMemoryRelationRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const sync = scope.db.transaction(() => {
      const now = utcNowIso();
      const existingRelations = this.listSemanticMemoryRelations({
        category: params.category,
        workspaceId: scope.workspaceId,
        treeId: params.treeId,
        limit: 10_000,
        offset: 0,
      });
      const existingByKey = new Map(existingRelations.map((relation) => [
        `${relation.fromNodeId}|${relation.toNodeId}|${relation.relationType}`,
        relation,
      ]));
      const desiredKeys = new Set(
        params.relations.map((relation) => `${relation.fromNodeId}|${relation.toNodeId}|${relation.relationType}`),
      );
      const deleteRelation = scope.workspaceId !== null
        ? scope.db.prepare(`
            DELETE FROM semantic_memory_relations
            WHERE workspace_id = ? AND category = ? AND tree_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?
          `)
        : scope.db.prepare(`
            DELETE FROM semantic_memory_relations
            WHERE category = ? AND tree_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?
          `);
      for (const existing of existingRelations) {
        const key = `${existing.fromNodeId}|${existing.toNodeId}|${existing.relationType}`;
        if (desiredKeys.has(key)) {
          continue;
        }
        if (scope.workspaceId !== null) {
          deleteRelation.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            existing.fromNodeId,
            existing.toNodeId,
            existing.relationType,
          );
        } else {
          deleteRelation.run(
            params.category,
            params.treeId,
            existing.fromNodeId,
            existing.toNodeId,
            existing.relationType,
          );
        }
      }
      const upsertRelation = scope.workspaceId !== null
        ? scope.db.prepare(`
            INSERT INTO semantic_memory_relations (
              workspace_id,
              category,
              tree_id,
              from_node_id,
              to_node_id,
              relation_type,
              metadata,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, category, tree_id, from_node_id, to_node_id, relation_type) DO UPDATE SET
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `)
        : scope.db.prepare(`
            INSERT INTO semantic_memory_relations (
              category,
              tree_id,
              from_node_id,
              to_node_id,
              relation_type,
              metadata,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(category, tree_id, from_node_id, to_node_id, relation_type) DO UPDATE SET
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `);
      for (const relation of params.relations) {
        const key = `${relation.fromNodeId}|${relation.toNodeId}|${relation.relationType}`;
        const existing = existingByKey.get(key) ?? null;
        if (existing && this.semanticMemoryRelationMatches(existing, relation)) {
          continue;
        }
        const createdAt = existing?.createdAt ?? relation.createdAt ?? now;
        const updatedAt = relation.updatedAt ?? now;
        const metadataJson = JSON.stringify(relation.metadata ?? {});
        if (scope.workspaceId !== null) {
          upsertRelation.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            relation.fromNodeId,
            relation.toNodeId,
            relation.relationType,
            metadataJson,
            createdAt,
            updatedAt,
          );
          continue;
        }
        upsertRelation.run(
          params.category,
          params.treeId,
          relation.fromNodeId,
          relation.toNodeId,
          relation.relationType,
          metadataJson,
          createdAt,
          updatedAt,
        );
      }
    });
    sync();
    return this.listSemanticMemoryRelations({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      limit: Math.max(200, params.relations.length + 10),
    });
  }

  listSemanticMemoryRelations(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId?: string | null;
    fromNodeId?: string | null;
    relationType?: string | null;
    limit?: number;
    offset?: number;
  }): SemanticMemoryRelationRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    let query = `
      SELECT *
      FROM semantic_memory_relations
      WHERE category = ?
    `;
    const values: Array<string | number> = [params.category];
    if (scope.workspaceId !== null) {
      query += " AND workspace_id = ?";
      values.push(scope.workspaceId);
    }
    if (params.treeId !== undefined) {
      if (params.treeId === null) {
        query += " AND tree_id IS NULL";
      } else {
        query += " AND tree_id = ?";
        values.push(params.treeId);
      }
    }
    if (params.fromNodeId !== undefined) {
      if (params.fromNodeId === null) {
        query += " AND from_node_id IS NULL";
      } else {
        query += " AND from_node_id = ?";
        values.push(params.fromNodeId);
      }
    }
    if (params.relationType !== undefined) {
      if (params.relationType === null) {
        query += " AND relation_type IS NULL";
      } else {
        query += " AND relation_type = ?";
        values.push(params.relationType);
      }
    }
    query += `
      ORDER BY relation_type ASC, from_node_id ASC, to_node_id ASC, updated_at DESC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 500, params.offset ?? 0);
    const rows = scope.db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemoryRelation(row));
  }

  replaceSemanticMemoryEvidenceRefs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    refs: Array<{
      nodeId: string;
      refId: string;
      provider?: string | null;
      accountNamespace?: string | null;
      connectionId?: string | null;
      externalObjectId?: string | null;
      externalObjectType?: string | null;
      sourceType?: string | null;
      sourceEventId?: string | null;
      sourceMessageId?: string | null;
      sourceTurnInputId?: string | null;
      observedAt?: string | null;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
  }): SemanticMemoryEvidenceRefRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const replace = scope.db.transaction(() => {
      const now = utcNowIso();
      if (scope.workspaceId !== null) {
        scope.db.prepare(`
          DELETE FROM semantic_memory_evidence_refs
          WHERE workspace_id = ? AND category = ? AND tree_id = ?
        `).run(scope.workspaceId, params.category, params.treeId);
        const insertRef = scope.db.prepare(`
          INSERT INTO semantic_memory_evidence_refs (
            workspace_id,
            category,
            tree_id,
            node_id,
            ref_id,
            provider,
            account_namespace,
            connection_id,
            external_object_id,
            external_object_type,
            source_type,
            source_event_id,
            source_message_id,
            source_turn_input_id,
            observed_at,
            metadata,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const ref of params.refs) {
          insertRef.run(
            scope.workspaceId,
            params.category,
            params.treeId,
            ref.nodeId,
            ref.refId,
            this.normalizedNullableText(ref.provider),
            this.normalizedNullableText(ref.accountNamespace),
            this.normalizedNullableText(ref.connectionId),
            this.normalizedNullableText(ref.externalObjectId),
            this.normalizedNullableText(ref.externalObjectType),
            this.normalizedNullableText(ref.sourceType),
            this.normalizedNullableText(ref.sourceEventId),
            this.normalizedNullableText(ref.sourceMessageId),
            this.normalizedNullableText(ref.sourceTurnInputId),
            this.normalizedNullableText(ref.observedAt),
            JSON.stringify(ref.metadata ?? {}),
            ref.createdAt ?? now,
            ref.updatedAt ?? now,
          );
        }
        return;
      }
      scope.db.prepare(`
        DELETE FROM semantic_memory_evidence_refs
        WHERE category = ? AND tree_id = ?
      `).run(params.category, params.treeId);
      const insertRef = scope.db.prepare(`
        INSERT INTO semantic_memory_evidence_refs (
          category,
          tree_id,
          node_id,
          ref_id,
          provider,
          account_namespace,
          connection_id,
          external_object_id,
          external_object_type,
          source_type,
          source_event_id,
          source_message_id,
          source_turn_input_id,
          observed_at,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ref of params.refs) {
        insertRef.run(
          params.category,
          params.treeId,
          ref.nodeId,
          ref.refId,
          this.normalizedNullableText(ref.provider),
          this.normalizedNullableText(ref.accountNamespace),
          this.normalizedNullableText(ref.connectionId),
          this.normalizedNullableText(ref.externalObjectId),
          this.normalizedNullableText(ref.externalObjectType),
          this.normalizedNullableText(ref.sourceType),
          this.normalizedNullableText(ref.sourceEventId),
          this.normalizedNullableText(ref.sourceMessageId),
          this.normalizedNullableText(ref.sourceTurnInputId),
          this.normalizedNullableText(ref.observedAt),
          JSON.stringify(ref.metadata ?? {}),
          ref.createdAt ?? now,
          ref.updatedAt ?? now,
        );
      }
    });
    replace();
    return this.listSemanticMemoryEvidenceRefs({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      limit: Math.max(200, params.refs.length + 10),
      offset: 0,
    });
  }

  listSemanticMemoryEvidenceRefs(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId?: string | null;
    nodeId?: string | null;
    limit?: number;
    offset?: number;
  }): SemanticMemoryEvidenceRefRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    let query = `
      SELECT *
      FROM semantic_memory_evidence_refs
      WHERE category = ?
    `;
    const values: Array<string | number> = [params.category];
    if (scope.workspaceId !== null) {
      query += " AND workspace_id = ?";
      values.push(scope.workspaceId);
    }
    if (params.treeId !== undefined) {
      if (params.treeId === null) {
        query += " AND tree_id IS NULL";
      } else {
        query += " AND tree_id = ?";
        values.push(params.treeId);
      }
    }
    if (params.nodeId !== undefined) {
      if (params.nodeId === null) {
        query += " AND node_id IS NULL";
      } else {
        query += " AND node_id = ?";
        values.push(params.nodeId);
      }
    }
    query += `
      ORDER BY updated_at DESC, node_id ASC, ref_id ASC
      LIMIT ? OFFSET ?
    `;
    values.push(params.limit ?? 500, params.offset ?? 0);
    const rows = scope.db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemoryEvidenceRef(row));
  }

  upsertSemanticMemoryEvidenceRef(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    nodeId: string;
    refId: string;
    provider?: string | null;
    accountNamespace?: string | null;
    connectionId?: string | null;
    externalObjectId?: string | null;
    externalObjectType?: string | null;
    sourceType?: string | null;
    sourceEventId?: string | null;
    sourceMessageId?: string | null;
    sourceTurnInputId?: string | null;
    observedAt?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }): SemanticMemoryEvidenceRefRecord {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const existing = this.listSemanticMemoryEvidenceRefs({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      nodeId: params.nodeId,
      limit: 100,
      offset: 0,
    }).find((record) => record.refId === params.refId) ?? null;
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    if (scope.workspaceId !== null) {
      scope.db.prepare(`
        INSERT INTO semantic_memory_evidence_refs (
          workspace_id,
          category,
          tree_id,
          node_id,
          ref_id,
          provider,
          account_namespace,
          connection_id,
          external_object_id,
          external_object_type,
          source_type,
          source_event_id,
          source_message_id,
          source_turn_input_id,
          observed_at,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, category, tree_id, node_id, ref_id) DO UPDATE SET
          provider = excluded.provider,
          account_namespace = excluded.account_namespace,
          connection_id = excluded.connection_id,
          external_object_id = excluded.external_object_id,
          external_object_type = excluded.external_object_type,
          source_type = excluded.source_type,
          source_event_id = excluded.source_event_id,
          source_message_id = excluded.source_message_id,
          source_turn_input_id = excluded.source_turn_input_id,
          observed_at = excluded.observed_at,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        scope.workspaceId,
        params.category,
        params.treeId,
        params.nodeId,
        params.refId,
        this.normalizedNullableText(params.provider),
        this.normalizedNullableText(params.accountNamespace),
        this.normalizedNullableText(params.connectionId),
        this.normalizedNullableText(params.externalObjectId),
        this.normalizedNullableText(params.externalObjectType),
        this.normalizedNullableText(params.sourceType),
        this.normalizedNullableText(params.sourceEventId),
        this.normalizedNullableText(params.sourceMessageId),
        this.normalizedNullableText(params.sourceTurnInputId),
        this.normalizedNullableText(params.observedAt),
        JSON.stringify(params.metadata ?? {}),
        createdAt,
        now,
      );
    } else {
      scope.db.prepare(`
        INSERT INTO semantic_memory_evidence_refs (
          category,
          tree_id,
          node_id,
          ref_id,
          provider,
          account_namespace,
          connection_id,
          external_object_id,
          external_object_type,
          source_type,
          source_event_id,
          source_message_id,
          source_turn_input_id,
          observed_at,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, tree_id, node_id, ref_id) DO UPDATE SET
          provider = excluded.provider,
          account_namespace = excluded.account_namespace,
          connection_id = excluded.connection_id,
          external_object_id = excluded.external_object_id,
          external_object_type = excluded.external_object_type,
          source_type = excluded.source_type,
          source_event_id = excluded.source_event_id,
          source_message_id = excluded.source_message_id,
          source_turn_input_id = excluded.source_turn_input_id,
          observed_at = excluded.observed_at,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        params.category,
        params.treeId,
        params.nodeId,
        params.refId,
        this.normalizedNullableText(params.provider),
        this.normalizedNullableText(params.accountNamespace),
        this.normalizedNullableText(params.connectionId),
        this.normalizedNullableText(params.externalObjectId),
        this.normalizedNullableText(params.externalObjectType),
        this.normalizedNullableText(params.sourceType),
        this.normalizedNullableText(params.sourceEventId),
        this.normalizedNullableText(params.sourceMessageId),
        this.normalizedNullableText(params.sourceTurnInputId),
        this.normalizedNullableText(params.observedAt),
        JSON.stringify(params.metadata ?? {}),
        createdAt,
        now,
      );
    }
    const record = this.listSemanticMemoryEvidenceRefs({
      category: params.category,
      workspaceId: scope.workspaceId,
      treeId: params.treeId,
      nodeId: params.nodeId,
      limit: 100,
      offset: 0,
    }).find((candidate) => candidate.refId === params.refId) ?? null;
    if (!record) {
      throw new Error("semantic memory evidence ref row not found after upsert");
    }
    return record;
  }

  updateSemanticMemoryLeafStatusBySourceLeafIds(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
    sourceLeafIds: string[];
    status: MemoryNodeStatus;
    updatedAt?: string;
  }): number {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    const sourceLeafIds = [...new Set(params.sourceLeafIds.map((value) => value.trim()).filter(Boolean))];
    if (sourceLeafIds.length === 0) {
      return 0;
    }
    const now = params.updatedAt ?? utcNowIso();
    const placeholders = sourceLeafIds.map(() => "?").join(", ");
    const update = scope.db.transaction(() => {
      const nodeFilter = scope.workspaceId !== null
        ? `
            workspace_id = ?
              AND category = ?
              AND tree_id = ?
              AND node_class = 'leaf'
              AND source_leaf_id IN (${placeholders})
          `
        : `
            category = ?
              AND tree_id = ?
              AND node_class = 'leaf'
              AND source_leaf_id IN (${placeholders})
          `;
      const nodeFilterValues: Array<string> = scope.workspaceId !== null
        ? [scope.workspaceId, params.category, params.treeId, ...sourceLeafIds]
        : [params.category, params.treeId, ...sourceLeafIds];
      const nodeIds = (
        scope.db.prepare(`
          SELECT node_id
          FROM semantic_memory_nodes
          WHERE ${nodeFilter}
        `).all(...nodeFilterValues) as Array<{ node_id?: string }>
      ).map((row) => String(row.node_id ?? "")).filter(Boolean);
      if (nodeIds.length === 0) {
        return 0;
      }
      const nodeIdPlaceholders = nodeIds.map(() => "?").join(", ");
      const updateNodeValues: Array<string> = scope.workspaceId !== null
        ? [params.status, now, scope.workspaceId, params.category, params.treeId, ...sourceLeafIds]
        : [params.status, now, params.category, params.treeId, ...sourceLeafIds];
      scope.db.prepare(`
        UPDATE semantic_memory_nodes
        SET status = ?,
            updated_at = ?
        WHERE ${nodeFilter}
      `).run(...updateNodeValues);

      const searchDocFilter = scope.workspaceId !== null
        ? `
            workspace_id = ?
              AND category = ?
              AND tree_id = ?
              AND node_id IN (${nodeIdPlaceholders})
          `
        : `
            category = ?
              AND tree_id = ?
              AND node_id IN (${nodeIdPlaceholders})
          `;
      const searchDocFilterValues: Array<string> = scope.workspaceId !== null
        ? [scope.workspaceId, params.category, params.treeId, ...nodeIds]
        : [params.category, params.treeId, ...nodeIds];
      const updateSearchDocValues: Array<string> = scope.workspaceId !== null
        ? [params.status, now, scope.workspaceId, params.category, params.treeId, ...nodeIds]
        : [params.status, now, params.category, params.treeId, ...nodeIds];
      scope.db.prepare(`
        UPDATE semantic_memory_search_docs
        SET status = ?,
            updated_at = ?
        WHERE ${searchDocFilter}
      `).run(...updateSearchDocValues);

      scope.db.prepare(`
        DELETE FROM semantic_memory_search_fts
        WHERE ${searchDocFilter}
      `).run(...searchDocFilterValues);
      scope.db.prepare(`
        INSERT INTO semantic_memory_search_fts (
          ${scope.workspaceId !== null ? "workspace_id," : ""}
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        )
        SELECT
          ${scope.workspaceId !== null ? "workspace_id," : ""}
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        FROM semantic_memory_search_docs
        WHERE ${searchDocFilter}
      `).run(...searchDocFilterValues);
      return nodeIds.length;
    });
    return update();
  }

  migrateSemanticMemoryTreeCategory(params: {
    workspaceId: string;
    treeId: string;
    fromCategory: SemanticMemoryCategory;
    toCategory: SemanticMemoryCategory;
  }): boolean {
    const workspaceId = params.workspaceId.trim();
    const treeId = params.treeId.trim();
    if (!workspaceId || !treeId || params.fromCategory === params.toCategory) {
      return false;
    }
    const db = this.workspaceRuntimeDb(workspaceId);
    const migrate = db.transaction(() => {
      const targetNodeCount = Number(
        (db
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM semantic_memory_nodes
              WHERE workspace_id = ?
                AND category = ?
                AND tree_id = ?
            `,
          )
          .get(workspaceId, params.toCategory, treeId) as { count?: number } | undefined)?.count ?? 0,
      );
      if (targetNodeCount > 0) {
        return false;
      }
      const sourceNodeCount = Number(
        (db
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM semantic_memory_nodes
              WHERE workspace_id = ?
                AND category = ?
                AND tree_id = ?
            `,
          )
          .get(workspaceId, params.fromCategory, treeId) as { count?: number } | undefined)?.count ?? 0,
      );
      if (sourceNodeCount === 0) {
        return false;
      }

      db.prepare(`
        UPDATE semantic_memory_edges
        SET category = ?
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(params.toCategory, workspaceId, params.fromCategory, treeId);
      db.prepare(`
        UPDATE semantic_memory_relations
        SET category = ?
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(params.toCategory, workspaceId, params.fromCategory, treeId);
      db.prepare(`
        UPDATE semantic_memory_evidence_refs
        SET category = ?
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(params.toCategory, workspaceId, params.fromCategory, treeId);
      db.prepare(`
        UPDATE semantic_memory_nodes
        SET category = ?
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(params.toCategory, workspaceId, params.fromCategory, treeId);
      db.prepare(`
        UPDATE semantic_memory_search_docs
        SET category = ?
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(params.toCategory, workspaceId, params.fromCategory, treeId);

      db.prepare(`
        DELETE FROM semantic_memory_search_fts
        WHERE workspace_id = ?
          AND tree_id = ?
          AND category IN (?, ?)
      `).run(workspaceId, treeId, params.fromCategory, params.toCategory);
      db.prepare(`
        INSERT INTO semantic_memory_search_fts (
          workspace_id,
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        )
        SELECT
          workspace_id,
          category,
          tree_id,
          node_id,
          node_class,
          node_kind,
          path,
          child_count,
          title,
          summary,
          body_text,
          excerpt,
          observed_at,
          status,
          updated_at
        FROM semantic_memory_search_docs
        WHERE workspace_id = ?
          AND category = ?
          AND tree_id = ?
      `).run(workspaceId, params.toCategory, treeId);
      return true;
    });
    return migrate();
  }

  deleteIntegrationTreeMemory(params: {
    workspaceId?: string | null;
    treeId: string;
  }): {
    deleted: boolean;
    deletedTree: boolean;
    deletedLeaves: number;
    deletedSemanticNodes: number;
    deletedSemanticEdges: number;
    deletedSemanticRelations: number;
    deletedSemanticEvidenceRefs: number;
    deletedSemanticSearchDocs: number;
    deletedEmbeddings: number;
  } {
    if (params.workspaceId === undefined) {
      throw new Error("deleteIntegrationTreeMemory requires workspaceId; pass null for legacy control-plane access");
    }
    // workspace-removal Piece 5.7: the integration graph (trees/leaves/embeddings)
    // is control-plane-only, but its SEMANTIC projection is still scoped per
    // category: the "integration" projection lives in the control-plane DB, while
    // the "workspace" projection lives in the requested workspace's runtime/root
    // DB (the out-of-scope semantic_memory_* subsystem). So deletion now spans two
    // DBs: the integration tables + the "integration" semantic rows go from the
    // control-plane DB, and the "workspace" semantic rows go from the requested
    // workspace DB (when a workspaceId is supplied).
    const requestedWorkspaceId = typeof params.workspaceId === "string" && params.workspaceId.trim().length > 0
      ? params.workspaceId.trim()
      : null;

    // Phase 1: integration graph + "integration" semantic projection, control-plane.
    const controlPlane = this.controlPlaneDb();
    const removeControlPlane = controlPlane.transaction(() => {
      const count = (table: string): number =>
        Number(
          (controlPlane
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tree_id = ?`)
            .get(params.treeId) as { count?: number } | undefined)?.count ?? 0,
        );
      const deletedLeaves = count("integration_leaves");
      const deletedEmbeddings = count("integration_node_embeddings");
      const semantic = this.deleteSemanticMemoryTreeRows({
        db: controlPlane,
        workspaceId: null,
        categories: ["integration"],
        treeId: params.treeId,
      });

      const embeddingRowIds = (
        controlPlane
          .prepare(
            `SELECT rowid AS vec_rowid FROM integration_node_embeddings WHERE tree_id = ?`,
          )
          .all(params.treeId) as Array<{ vec_rowid: number | bigint }>
      )
        .map((row) => Number(row.vec_rowid))
        .filter((value) => Number.isFinite(value));
      controlPlane.prepare(`DELETE FROM integration_node_embeddings WHERE tree_id = ?`).run(params.treeId);
      if (this.#vectorIndexSupported && embeddingRowIds.length > 0) {
        controlPlane.prepare(`
          DELETE FROM integration_node_embedding_vec
          WHERE vec_rowid IN (${embeddingRowIds.map(() => "?").join(", ")})
        `).run(...embeddingRowIds);
      }
      controlPlane.prepare(`DELETE FROM integration_leaves WHERE tree_id = ?`).run(params.treeId);
      const deletedTree = controlPlane
        .prepare(`DELETE FROM integration_trees WHERE tree_id = ?`)
        .run(params.treeId).changes > 0;
      return { deletedTree, deletedLeaves, deletedEmbeddings, semantic };
    })();

    // Phase 2: "workspace" semantic projection, in the requested workspace's DB.
    // Skipped entirely for control-plane (null) callers — there is no per-workspace
    // projection to clear in that case.
    const workspaceSemantic = requestedWorkspaceId
      ? (() => {
        const workspaceDb = this.workspaceRuntimeDb(requestedWorkspaceId);
        return workspaceDb.transaction(() =>
          this.deleteSemanticMemoryTreeRows({
            db: workspaceDb,
            workspaceId: requestedWorkspaceId,
            categories: ["workspace"],
            treeId: params.treeId,
          }),
        )();
      })()
      : { nodes: 0, edges: 0, relations: 0, evidenceRefs: 0, searchDocs: 0 };

    const deletedSemanticNodes = removeControlPlane.semantic.nodes + workspaceSemantic.nodes;
    const deletedSemanticEdges = removeControlPlane.semantic.edges + workspaceSemantic.edges;
    const deletedSemanticRelations = removeControlPlane.semantic.relations + workspaceSemantic.relations;
    const deletedSemanticEvidenceRefs = removeControlPlane.semantic.evidenceRefs + workspaceSemantic.evidenceRefs;
    const deletedSemanticSearchDocs = removeControlPlane.semantic.searchDocs + workspaceSemantic.searchDocs;

    return {
      deleted: removeControlPlane.deletedTree
        || removeControlPlane.deletedLeaves > 0
        || deletedSemanticNodes > 0
        || deletedSemanticRelations > 0
        || deletedSemanticEvidenceRefs > 0
        || deletedSemanticEdges > 0
        || deletedSemanticSearchDocs > 0
        || removeControlPlane.deletedEmbeddings > 0,
      deletedTree: removeControlPlane.deletedTree,
      deletedLeaves: removeControlPlane.deletedLeaves,
      deletedSemanticNodes,
      deletedSemanticEdges,
      deletedSemanticRelations,
      deletedSemanticEvidenceRefs,
      deletedSemanticSearchDocs,
      deletedEmbeddings: removeControlPlane.deletedEmbeddings,
    };
  }

  /**
   * Delete every semantic_memory_* row for the given categories + tree from a
   * single DB, returning per-table counts of what was removed. Used by
   * deleteIntegrationTreeMemory, which now spans the control-plane DB (category
   * "integration") and the per-workspace/root DB (category "workspace"). Must run
   * inside a caller-provided transaction on `db`. The FTS shadow
   * (`semantic_memory_search_fts`) is purged alongside the base rows; its deletes
   * are not counted (it mirrors search_docs).
   */
  private deleteSemanticMemoryTreeRows(params: {
    db: Database.Database;
    workspaceId: string | null;
    categories: SemanticMemoryCategory[];
    treeId: string;
  }): {
    nodes: number;
    edges: number;
    relations: number;
    evidenceRefs: number;
    searchDocs: number;
  } {
    const { db, workspaceId, categories, treeId } = params;
    if (categories.length === 0) {
      return { nodes: 0, edges: 0, relations: 0, evidenceRefs: 0, searchDocs: 0 };
    }
    const placeholders = categories.map(() => "?").join(", ");
    const whereWorkspace = workspaceId ? "AND workspace_id = ?" : "";
    const whereArgs = workspaceId
      ? [...categories, workspaceId, treeId]
      : [...categories, treeId];
    const countRows = (table: string): number =>
      Number(
        (db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table}
             WHERE category IN (${placeholders}) ${whereWorkspace} AND tree_id = ?`,
          )
          .get(...whereArgs) as { count?: number } | undefined)?.count ?? 0,
      );
    const nodes = countRows("semantic_memory_nodes");
    const edges = countRows("semantic_memory_edges");
    const relations = countRows("semantic_memory_relations");
    const evidenceRefs = countRows("semantic_memory_evidence_refs");
    const searchDocs = countRows("semantic_memory_search_docs");
    for (const table of [
      "semantic_memory_search_fts",
      "semantic_memory_edges",
      "semantic_memory_relations",
      "semantic_memory_evidence_refs",
      "semantic_memory_nodes",
      "semantic_memory_search_docs",
    ]) {
      db.prepare(
        `DELETE FROM ${table}
         WHERE category IN (${placeholders}) ${whereWorkspace} AND tree_id = ?`,
      ).run(...whereArgs);
    }
    return { nodes, edges, relations, evidenceRefs, searchDocs };
  }

  upsertIntegrationNodeEmbedding(params: {
    workspaceId?: string | null;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    treeId: string;
    embeddingModel: string;
    contentFingerprint: string;
    dimensions: number;
    vector: number[];
    createdAt?: string;
    updatedAt?: string;
  }): IntegrationNodeEmbeddingRecord {
    if (params.workspaceId === undefined) {
      throw new Error("upsertIntegrationNodeEmbedding requires workspaceId; pass null for legacy control-plane access");
    }
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    const existing = this.getIntegrationNodeEmbedding({
      workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    const now = params.updatedAt ?? utcNowIso();
    const createdAt = existing?.createdAt ?? params.createdAt ?? now;
    if (workspaceId) {
      this.workspaceRuntimeDb(workspaceId)
        .prepare(`
          INSERT INTO integration_node_embeddings (
            workspace_id,
            node_kind,
            node_id,
            tree_id,
            embedding_model,
            content_fingerprint,
            dimensions,
            vector_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, node_kind, node_id, embedding_model) DO UPDATE SET
            tree_id = excluded.tree_id,
            content_fingerprint = excluded.content_fingerprint,
            dimensions = excluded.dimensions,
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `)
        .run(
          workspaceId,
          params.nodeKind,
          params.nodeId,
          params.treeId,
          params.embeddingModel,
          params.contentFingerprint,
          params.dimensions,
          JSON.stringify(params.vector),
          createdAt,
          now,
        );
    } else {
      this.controlPlaneDb()
        .prepare(`
          INSERT INTO integration_node_embeddings (
            node_kind,
            node_id,
            tree_id,
            embedding_model,
            content_fingerprint,
            dimensions,
            vector_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(node_kind, node_id, embedding_model) DO UPDATE SET
            tree_id = excluded.tree_id,
            content_fingerprint = excluded.content_fingerprint,
            dimensions = excluded.dimensions,
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `)
        .run(
          params.nodeKind,
          params.nodeId,
          params.treeId,
          params.embeddingModel,
          params.contentFingerprint,
          params.dimensions,
          JSON.stringify(params.vector),
          createdAt,
          now,
        );
    }
    const record = this.getIntegrationNodeEmbedding({
      workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!record) {
      throw new Error("integration embedding row not found after upsert");
    }
    this.replaceIntegrationNodeEmbeddingVector({
      workspaceId,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
      embedding: new Float32Array(params.vector),
    });
    return record;
  }

  getIntegrationNodeEmbedding(params: {
    workspaceId?: string | null;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
  }): IntegrationNodeEmbeddingRecord | null {
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      const row = workspaceId
        ? db
          .prepare<[string, string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_node_embeddings
              WHERE workspace_id = ?
                AND node_kind = ?
                AND node_id = ?
                AND embedding_model = ?
              LIMIT 1
            `,
          )
          .get(workspaceId, params.nodeKind, params.nodeId, params.embeddingModel)
        : db
          .prepare<[string, string, string], Record<string, unknown>>(
            `
              SELECT *
              FROM integration_node_embeddings
              WHERE node_kind = ?
                AND node_id = ?
                AND embedding_model = ?
              LIMIT 1
            `,
          )
          .get(params.nodeKind, params.nodeId, params.embeddingModel);
      if (row) {
        return this.rowToIntegrationNodeEmbedding(row);
      }
    }
    return null;
  }

  private integrationNodeEmbeddingRowid(params: {
    workspaceId?: string | null;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
  }): number | null {
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    const db = this.integrationDbForWorkspace(workspaceId);
    const row = workspaceId
      ? db
        .prepare<
          [string, string, string, string],
          { vec_rowid?: number | bigint | null }
        >(
          `
            SELECT rowid AS vec_rowid
            FROM integration_node_embeddings
            WHERE workspace_id = ?
              AND node_kind = ?
              AND node_id = ?
              AND embedding_model = ?
            LIMIT 1
          `,
        )
        .get(workspaceId, params.nodeKind, params.nodeId, params.embeddingModel)
      : db
        .prepare<
          [string, string, string],
          { vec_rowid?: number | bigint | null }
        >(
          `
            SELECT rowid AS vec_rowid
            FROM integration_node_embeddings
            WHERE node_kind = ?
              AND node_id = ?
              AND embedding_model = ?
            LIMIT 1
          `,
        )
        .get(params.nodeKind, params.nodeId, params.embeddingModel);
    if (!row?.vec_rowid) {
      return null;
    }
    return Number(row.vec_rowid);
  }

  replaceIntegrationNodeEmbeddingVector(params: {
    workspaceId?: string | null;
    nodeKind: InteractionTreeChildKind;
    nodeId: string;
    embeddingModel: string;
    embedding: Float32Array;
  }): void {
    if (!this.#vectorIndexSupported || params.embedding.length !== 1536) {
      return;
    }
    const record = this.getIntegrationNodeEmbedding({
      workspaceId: params.workspaceId ?? null,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!record) {
      return;
    }
    const vecRowid = this.integrationNodeEmbeddingRowid({
      workspaceId: params.workspaceId ?? null,
      nodeKind: params.nodeKind,
      nodeId: params.nodeId,
      embeddingModel: params.embeddingModel,
    });
    if (!Number.isFinite(vecRowid)) {
      return;
    }
    const db = this.integrationDbForWorkspace(params.workspaceId ?? null);
    db.prepare("DELETE FROM integration_node_embedding_vec WHERE vec_rowid = ?").run(vecRowid);
    db
      .prepare(`
        INSERT INTO integration_node_embedding_vec (vec_rowid, embedding, tree_id, node_kind, embedding_model)
        VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
      `)
      .run(
        vecRowid,
        params.embedding,
        record.treeId,
        record.nodeKind,
        record.embeddingModel,
      );
  }

  private backfillIntegrationNodeEmbeddingVectors(params: {
    workspaceId?: string | null;
    embeddingModel: string;
    treeIds?: string[] | null;
    nodeKinds?: InteractionTreeChildKind[] | null;
  }): void {
    if (!this.#vectorIndexSupported) {
      return;
    }
    const normalizedTreeIds = params.treeIds
      ? [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    const normalizedNodeKinds = params.nodeKinds
      ? [...new Set(params.nodeKinds.map((value) => value.trim()).filter(Boolean) as InteractionTreeChildKind[])]
      : null;
    // workspace-removal Piece 5.7: integration graph is control-plane-only. Force
    // the control-plane code path (workspaceId = null) regardless of any
    // workspaceId the caller passes, so every query/write targets the
    // control-plane tables (which have no `workspace_id` column).
    const workspaceId = null;
    void params.workspaceId;
    const db = this.integrationDbForWorkspace(workspaceId);
    let query = `
      SELECT rowid AS vec_rowid, vector_json, tree_id, node_kind, embedding_model
      FROM integration_node_embeddings
      WHERE ${workspaceId ? "workspace_id = ? AND" : ""} embedding_model = ?
        AND dimensions = 1536
    `;
    const values: Array<string | number> = workspaceId
      ? [workspaceId, params.embeddingModel]
      : [params.embeddingModel];
    if (normalizedTreeIds && normalizedTreeIds.length > 0) {
      query += ` AND tree_id IN (${normalizedTreeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedTreeIds);
    }
    if (normalizedNodeKinds && normalizedNodeKinds.length > 0) {
      query += ` AND node_kind IN (${normalizedNodeKinds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeKinds);
    }
    const sourceRows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
    if (sourceRows.length === 0) {
      return;
    }
    const rowIds = sourceRows
      .map((row) => Number(row.vec_rowid))
      .filter((value) => Number.isFinite(value));
    if (rowIds.length === 0) {
      return;
    }
    const existingRowIds = new Set<number>(
      (
        db.prepare(`
          SELECT vec_rowid
          FROM integration_node_embedding_vec
          WHERE vec_rowid IN (${rowIds.map(() => "?").join(", ")})
        `).all(...rowIds) as Array<{ vec_rowid: number | bigint }>
      )
        .map((row) => Number(row.vec_rowid))
        .filter((value) => Number.isFinite(value)),
    );
    const insert = db.prepare(`
      INSERT INTO integration_node_embedding_vec (vec_rowid, embedding, tree_id, node_kind, embedding_model)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((items: Array<Record<string, unknown>>) => {
      for (const row of items) {
        const vecRowid = Number(row.vec_rowid);
        if (!Number.isFinite(vecRowid) || existingRowIds.has(vecRowid)) {
          continue;
        }
        const vector = this.parseJsonList(row.vector_json)
          .map((value) => (typeof value === "number" ? value : Number(value)))
          .filter((value) => Number.isFinite(value));
        if (vector.length !== 1536) {
          continue;
        }
        insert.run(
          vecRowid,
          new Float32Array(vector),
          String(row.tree_id),
          String(row.node_kind),
          String(row.embedding_model),
        );
      }
    });
    insertMany(sourceRows);
  }

  listIntegrationNodeEmbeddings(params: {
    workspaceId?: string | null;
    treeId?: string | null;
    embeddingModel?: string | null;
    nodeIds?: string[] | null;
  } = {}): IntegrationNodeEmbeddingRecord[] {
    const normalizedNodeIds = params.nodeIds
      ? [...new Set(params.nodeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    if (params.nodeIds && normalizedNodeIds && normalizedNodeIds.length === 0) {
      return [];
    }
    const results: IntegrationNodeEmbeddingRecord[] = [];
    const seen = new Set<string>();
    for (const { workspaceId, db } of this.listReadableIntegrationDbs({
      workspaceId: params.workspaceId,
    })) {
      let query = `
        SELECT *
        FROM integration_node_embeddings
        WHERE 1 = 1
      `;
      const values: Array<string | number> = [];
      if (workspaceId) {
        query += " AND workspace_id = ?";
        values.push(workspaceId);
      }
      if (params.treeId !== undefined) {
        if (params.treeId === null) {
          query += " AND tree_id IS NULL";
        } else {
          query += " AND tree_id = ?";
          values.push(params.treeId);
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
      if (normalizedNodeIds) {
        query += ` AND node_id IN (${normalizedNodeIds.map(() => "?").join(", ")})`;
        values.push(...normalizedNodeIds);
      }
      query += " ORDER BY updated_at DESC, created_at DESC, node_id ASC";
      const rows = db.prepare(query).all(...values) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const record = this.rowToIntegrationNodeEmbedding(row);
        const key = `${record.workspaceId ?? "control"}:${record.nodeKind}:${record.nodeId}:${record.embeddingModel}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(record);
        }
      }
    }
    return results;
  }

  searchIntegrationNodeEmbeddingsByVector(params: {
    workspaceId?: string | null;
    embedding: Float32Array;
    embeddingModel: string;
    limit: number;
    treeIds?: string[] | null;
    nodeKinds?: InteractionTreeChildKind[] | null;
  }): IntegrationNodeEmbeddingVectorSearchResult[] {
    if (params.workspaceId === undefined) {
      throw new Error("searchIntegrationNodeEmbeddingsByVector requires workspaceId; pass null for legacy control-plane access");
    }
    if (!this.#vectorIndexSupported || params.embedding.length !== 1536) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.trunc(params.limit));
    const normalizedTreeIds = params.treeIds
      ? [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))]
      : null;
    const normalizedNodeKinds = params.nodeKinds
      ? [...new Set(params.nodeKinds.map((value) => value.trim()).filter(Boolean) as InteractionTreeChildKind[])]
      : null;
    this.backfillIntegrationNodeEmbeddingVectors({
      workspaceId: params.workspaceId ?? null,
      embeddingModel: params.embeddingModel,
      treeIds: normalizedTreeIds,
      nodeKinds: normalizedNodeKinds,
    });
    let query = `
      SELECT vec_rowid, distance
      FROM integration_node_embedding_vec
      WHERE embedding MATCH ?
        AND k = ?
        AND embedding_model = ?
    `;
    const values: Array<string | number | Float32Array> = [params.embedding, normalizedLimit, params.embeddingModel];
    if (normalizedTreeIds && normalizedTreeIds.length > 0) {
      query += ` AND tree_id IN (${normalizedTreeIds.map(() => "?").join(", ")})`;
      values.push(...normalizedTreeIds);
    }
    if (normalizedNodeKinds && normalizedNodeKinds.length > 0) {
      query += ` AND node_kind IN (${normalizedNodeKinds.map(() => "?").join(", ")})`;
      values.push(...normalizedNodeKinds);
    }
    const db = this.integrationDbForWorkspace(params.workspaceId ?? null);
    const rows = db
      .prepare(query)
      .all(...values) as Array<{ vec_rowid: number; distance: number }>;
    return this.integrationEmbeddingVectorResultsForRows({
      workspaceId: params.workspaceId ?? null,
      rows,
    });
  }

  private integrationEmbeddingVectorResultsForRows(params: {
    workspaceId?: string | null;
    rows: Array<{ vec_rowid: number; distance: number }>;
  }
  ): IntegrationNodeEmbeddingVectorSearchResult[] {
    if (params.rows.length === 0) {
      return [];
    }
    const rowIds = params.rows.map((row) => Number(row.vec_rowid)).filter((value) => Number.isFinite(value));
    if (rowIds.length === 0) {
      return [];
    }
    const db = this.integrationDbForWorkspace(params.workspaceId ?? null);
    const mappingRows = db
      .prepare(`
        SELECT rowid AS vec_rowid, *
        FROM integration_node_embeddings
        WHERE rowid IN (${rowIds.map(() => "?").join(", ")})
      `)
      .all(...rowIds) as Array<Record<string, unknown>>;
    const byRowId = new Map<number, IntegrationNodeEmbeddingRecord>();
    for (const row of mappingRows) {
      const vecRowid = Number(row.vec_rowid);
      if (!Number.isFinite(vecRowid)) {
        continue;
      }
      byRowId.set(vecRowid, this.rowToIntegrationNodeEmbedding(row));
    }
    const results: IntegrationNodeEmbeddingVectorSearchResult[] = [];
    for (const row of params.rows) {
      const mapping = byRowId.get(Number(row.vec_rowid));
      if (!mapping) {
        continue;
      }
      results.push({
        vecRowid: Number(row.vec_rowid),
        distance: Number(row.distance),
        workspaceId: mapping.workspaceId,
        nodeKind: mapping.nodeKind,
        nodeId: mapping.nodeId,
        treeId: mapping.treeId,
        embeddingModel: mapping.embeddingModel,
      });
    }
    return results;
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
            session_id,
            input_id,
            snapshot_kind,
            fingerprint,
            payload,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(input_id) DO UPDATE SET
            session_id = excluded.session_id,
            snapshot_kind = excluded.snapshot_kind,
            fingerprint = excluded.fingerprint,
            payload = excluded.payload,
            updated_at = excluded.updated_at
      `)
      .run(
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
    return row ? this.rowToTurnRequestSnapshot(row, params.workspaceId) : null;
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
      WHERE session_id = ?
    `;
    const values: Array<string | number> = [params.sessionId];
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
    return rows.map((row) => this.rowToTurnRequestSnapshot(row, params.workspaceId));
  }

  createOutputFolder(params: { workspaceId: string; name: string }): OutputFolderRecord {
    const resolvedId = randomUUID();
    const now = utcNowIso();
    const workspaceDb = this.workspaceRuntimeDb(params.workspaceId);
    const countRow = workspaceDb
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM output_folders")
      .get();
    const position = countRow?.count ?? 0;
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO output_folders (
            id, name, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(resolvedId, params.name, position, now, now);
    });
    const row = workspaceDb
      .prepare<[string], Record<string, unknown>>("SELECT * FROM output_folders WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("output folder row not found after insert");
    }
    return this.rowToOutputFolder(row, params.workspaceId);
  }

  listOutputFolders(params: { workspaceId: string }): OutputFolderRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[], Record<string, unknown>>(`
        SELECT * FROM output_folders
        ORDER BY position ASC, datetime(created_at) ASC, id ASC
      `)
      .all();
    return rows.map((row) => this.rowToOutputFolder(row, params.workspaceId));
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
    return row ? this.rowToOutputFolder(row, params.workspaceId) : null;
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

  private extractOutputFtsFields(
    metadata: Record<string, unknown> | null | undefined,
  ): { teammateId: string; pluginId: string } {
    const meta = (metadata ?? {}) as Record<string, unknown>;
    const rawTeammate = meta.produced_by_teammate_id;
    const teammateId =
      typeof rawTeammate === "string" && rawTeammate.trim()
        ? rawTeammate.trim()
        : "";
    const rawPlugin = meta.produced_by_plugin_id;
    const pluginId =
      typeof rawPlugin === "string" && rawPlugin.trim()
        ? rawPlugin.trim()
        : "";
    return { teammateId, pluginId };
  }

  private syncOutputFtsRow(
    db: Database.Database,
    row: {
      id: string;
      outputType: string;
      moduleId: string | null;
      status: string;
      title: string;
      filePath: string | null;
      htmlContent: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: string | null;
    },
  ): void {
    db.prepare("DELETE FROM outputs_fts WHERE id = ?").run(row.id);
    const { teammateId, pluginId } = this.extractOutputFtsFields(row.metadata);
    db.prepare(
      `
        INSERT INTO outputs_fts (
          id,
          output_type,
          module_id,
          status,
          produced_by_teammate_id,
          produced_by_plugin_id,
          created_at,
          title,
          file_path,
          body_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      row.id,
      row.outputType,
      row.moduleId ?? "",
      row.status,
      teammateId,
      pluginId,
      row.createdAt ?? "",
      row.title ?? "",
      row.filePath ?? "",
      row.htmlContent ?? "",
    );
  }

  createOutput(params: {
    workspaceId: string;
    projectId?: string | null;
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
    createdAt?: string;
    updatedAt?: string;
  }): OutputRecord {
    const resolvedId = params.outputId ?? randomUUID();
    const now = utcNowIso();
    const createdAt = params.createdAt ?? now;
    const updatedAt = params.updatedAt ?? createdAt;
    const metadataJson = JSON.stringify(params.metadata ?? {});
    // If projectId wasn't passed explicitly but the session has one, inherit
    // from the session so existing callers that already pass sessionId
    // automatically get project-aware outputs without each callsite needing
    // a manual update.
    const inheritedProjectId =
      params.projectId === undefined && params.sessionId
        ? this.getSession({
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
          })?.projectId ?? null
        : params.projectId ?? null;
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT INTO outputs (
            id, project_id, output_type, title, status, module_id, module_resource_id, file_path,
            html_content, session_id, input_id, artifact_id, folder_id, platform, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedId,
        inheritedProjectId,
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
        createdAt,
        updatedAt
      );
      this.syncOutputFtsRow(db, {
        id: resolvedId,
        outputType: params.outputType,
        moduleId: params.moduleId ?? null,
        status: params.status ?? "draft",
        title: params.title ?? "",
        filePath: params.filePath ?? null,
        htmlContent: params.htmlContent ?? null,
        metadata: params.metadata ?? {},
        createdAt,
      });
    });
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM outputs WHERE id = ? LIMIT 1")
      .get(resolvedId);
    if (!row) {
      throw new Error("output row not found after insert");
    }
    return this.rowToOutput(row, params.workspaceId);
  }

  listOutputs(params: {
    workspaceId: string;
    /**
     * Filter by project scope. `undefined` → no filter (return all rows for
     * the workspace). `null` → only General-session outputs. A string →
     * only outputs from sessions in that project.
     */
    projectId?: string | null;
    outputType?: string | null;
    status?: string | null;
    platform?: string | null;
    folderId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    limit?: number;
    offset?: number;
  }): OutputRecord[] {
    let query = "SELECT * FROM outputs WHERE 1 = 1";
    const values: Array<string | number> = [];
    if (params.projectId === null) {
      query += " AND project_id IS NULL";
    } else if (typeof params.projectId === "string") {
      query += " AND project_id = ?";
      values.push(params.projectId);
    }
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
    return rows.map((row) => this.rowToOutput(row, params.workspaceId));
  }

  getOutput(params: { workspaceId: string; outputId: string }): OutputRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM outputs WHERE id = ? LIMIT 1")
      .get(params.outputId);
    return row ? this.rowToOutput(row, params.workspaceId) : null;
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
      this.syncOutputFtsRow(db, {
        id: params.outputId,
        outputType: existing.outputType,
        moduleId: existing.moduleId,
        status: params.status ?? existing.status,
        title: params.title ?? existing.title,
        filePath: params.filePath ?? existing.filePath,
        htmlContent: params.htmlContent ?? existing.htmlContent,
        metadata: params.metadata ?? existing.metadata,
        createdAt: existing.createdAt,
      });
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
      db.prepare("DELETE FROM outputs_fts WHERE id = ?").run(params.outputId);
    });
    return this.getOutput(params) === null;
  }

  getOutputCounts(params: { workspaceId: string }): Record<string, unknown> {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[], Record<string, unknown>>("SELECT status, platform, folder_id FROM outputs")
      .all();
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

  searchOutputs(params: {
    workspaceId: string;
    query: string;
    producerId?: string | null;
    dateRangeStart?: string | null;
    dateRangeEnd?: string | null;
    limit?: number;
    offset?: number;
  }): { results: Array<{ output: OutputRecord; snippet: string }>; total: number } {
    const trimmed = (params.query ?? "").trim();
    if (!trimmed) {
      return { results: [], total: 0 };
    }
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const offset = Math.max(0, params.offset ?? 0);
    const matchExpression = this.buildOutputFtsMatch(trimmed);
    const filters: string[] = ["outputs_fts MATCH ?"];
    const values: Array<string | number> = [matchExpression];
    if (params.producerId) {
      filters.push("(produced_by_teammate_id = ? OR produced_by_plugin_id = ?)");
      values.push(params.producerId, params.producerId);
    }
    if (params.dateRangeStart) {
      filters.push("created_at >= ?");
      values.push(params.dateRangeStart);
    }
    if (params.dateRangeEnd) {
      filters.push("created_at <= ?");
      values.push(params.dateRangeEnd);
    }
    const whereClause = filters.join(" AND ");
    const db = this.workspaceRuntimeDb(params.workspaceId);
    const totalRow = db
      .prepare<Array<string | number>, { total: number }>(
        `SELECT COUNT(*) AS total FROM outputs_fts WHERE ${whereClause}`,
      )
      .get(...values);
    const total = totalRow?.total ?? 0;
    if (total === 0) {
      return { results: [], total: 0 };
    }
    // bm25 column weights: title 4.0, file_path 2.0, body 1.0 — title hits
    // dominate, body hits still rank but lower.
    const rows = db
      .prepare<Array<string | number>, { id: string; snippet: string }>(
        `
          SELECT
            id,
            snippet(outputs_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
          FROM outputs_fts
          WHERE ${whereClause}
          ORDER BY bm25(outputs_fts, 4.0, 2.0, 1.0) ASC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...values, limit, offset);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return { results: [], total };
    }
    const placeholders = ids.map(() => "?").join(", ");
    const outputRows = db
      .prepare<string[], Record<string, unknown>>(
        `SELECT * FROM outputs WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    const outputById = new Map<string, OutputRecord>();
    for (const row of outputRows) {
      const record = this.rowToOutput(row, params.workspaceId);
      outputById.set(record.id, record);
    }
    const results: Array<{ output: OutputRecord; snippet: string }> = [];
    for (const row of rows) {
      const output = outputById.get(row.id);
      if (!output) continue;
      results.push({ output, snippet: row.snippet ?? "" });
    }
    return { results, total };
  }

  private buildOutputFtsMatch(rawQuery: string): string {
    // FTS5 MATCH input is a query, not a literal. To stay friendly for casual
    // typing ("budget q3"), tokenize on whitespace, drop punctuation, wrap
    // each token as a prefix match, and AND them together.
    const tokens = rawQuery
      .split(/\s+/)
      .map((tok) => tok.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter((tok) => tok.length > 0);
    if (tokens.length === 0) {
      // Fall back to an impossible match — guarantees no hits but a valid
      // FTS5 expression.
      return '""';
    }
    return tokens.map((tok) => `${tok}*`).join(" ");
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
        db.prepare(`UPDATE app_builds SET ${setClause} WHERE app_id = ?`)
          .run(...Object.values(fields), params.appId);
      });
    } else {
      this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
        db.prepare(`
          INSERT INTO app_builds (
              app_id, status, started_at, completed_at, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
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
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM app_builds WHERE app_id = ? LIMIT 1"
      )
      .get(params.appId);
    if (!row) {
      throw new Error("app build row not found after upsert");
    }
    return this.rowToAppBuild(row, params.workspaceId);
  }

  getAppBuild(params: { workspaceId: string; appId: string }): AppBuildRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM app_builds WHERE app_id = ? LIMIT 1"
      )
      .get(params.appId);
    return row ? this.rowToAppBuild(row, params.workspaceId) : null;
  }

  deleteAppBuild(params: { workspaceId: string; appId: string }): boolean {
    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare("DELETE FROM app_builds WHERE app_id = ?").run(params.appId);
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
        "UPDATE app_builds SET restart_attempts = ?, updated_at = ? WHERE app_id = ?",
      ).run(safeAttempts, utcNowIso(), params.appId);
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
          INSERT OR IGNORE INTO app_ports (app_id, port, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(params.appId, port, now, now);
      });

      return this.getAppPort({ workspaceId: params.workspaceId, appId: params.appId })!;
    });
    return allocate();
  }

  getAppPort(params: { workspaceId: string; appId: string }): AppPortRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM app_ports WHERE app_id = ? LIMIT 1"
      )
      .get(params.appId);
    return row ? this.rowToAppPort(row, params.workspaceId) : null;
  }

  listAppPorts(params: { workspaceId: string }): AppPortRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[], Record<string, unknown>>(
        "SELECT * FROM app_ports"
      )
      .all();
    return rows.map((row) => this.rowToAppPort(row, params.workspaceId));
  }

  listAllAppPorts(): AppPortRecord[] {
    const readableWorkspaceRuntimeDbs = this.listReadableWorkspaceRuntimeDbs();
    const ports = readableWorkspaceRuntimeDbs.flatMap(({ db, workspaceId }) => {
      const rows = db
        .prepare<[], Record<string, unknown>>(
          "SELECT * FROM app_ports"
        )
        .all();
      return rows.map((row) => this.rowToAppPort(row, workspaceId));
    });
    const scannedWorkspaceIds = new Set(
      readableWorkspaceRuntimeDbs.map(({ workspaceId }) => workspaceId),
    );
    for (const workspace of this.listRegisteredWorkspaceRecords({ includeDeleted: true })) {
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
        ports.push(...rows.map((row) => this.rowToAppPort(row, workspace.id)));
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
      db.prepare("DELETE FROM app_ports WHERE app_id = ?").run(params.appId);
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
      if (!allocated.has(port) && !this.#portInUseProbe(port)) {
        return port;
      }
    }
    throw new Error(`No available ports in range ${BASE_PORT}-${MAX_PORT}`);
  }

  private rowToAppPort(
    row: Record<string, unknown>,
    workspaceId: string,
  ): AppPortRecord {
    return {
      workspaceId,
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
            id, initiated_by, name, cron, description, instruction, enabled, delivery, metadata,
            last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, ?, ?)
      `).run(
        resolvedId,
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
    return this.rowToCronjob(row, params.workspaceId);
  }

  getCronjob(params: { workspaceId: string; jobId: string }): CronjobRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM cronjobs WHERE id = ? LIMIT 1")
      .get(params.jobId);
    return row ? this.rowToCronjob(row, params.workspaceId) : null;
  }

  listCronjobs(params: {
    workspaceId?: string | null;
    enabledOnly?: boolean;
    // Opt-in pagination. Omit `limit` to return the full roster (unchanged
    // behavior). `offset` without `limit` skips the first N and returns the
    // rest. Both are floored to non-negative integers; invalid values ignored.
    limit?: number | null;
    offset?: number | null;
  }): CronjobRecord[] {
    const limit =
      typeof params.limit === "number" &&
      Number.isFinite(params.limit) &&
      params.limit > 0
        ? Math.floor(params.limit)
        : null;
    const offset =
      typeof params.offset === "number" &&
      Number.isFinite(params.offset) &&
      params.offset > 0
        ? Math.floor(params.offset)
        : 0;
    if (!params.workspaceId) {
      const jobs = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
        let query = "SELECT * FROM cronjobs";
        if (params.enabledOnly) {
          query += " WHERE enabled = 1";
        }
        query += " ORDER BY datetime(created_at) ASC, id ASC";
        const rows = db.prepare(query).all() as Array<Record<string, unknown>>;
        return rows.map((row) => this.rowToCronjob(row, workspaceId));
      });
      jobs.sort((left, right) => {
        const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
        if (createdAtCompare !== 0) {
          return createdAtCompare;
        }
        return left.id.localeCompare(right.id);
      });
      // Cross-DB pagination is applied after the merge+sort — a per-DB SQL
      // LIMIT/OFFSET can't page a merged ordering.
      if (limit === null) {
        return offset > 0 ? jobs.slice(offset) : jobs;
      }
      return jobs.slice(offset, offset + limit);
    }
    const workspaceId = params.workspaceId;
    let query = "SELECT * FROM cronjobs";
    const filters: string[] = [];
    const values: string[] = [];
    if (params.enabledOnly) {
      filters.push("enabled = 1");
    }
    if (filters.length > 0) {
      query += ` WHERE ${filters.join(" AND ")}`;
    }
    query += " ORDER BY datetime(created_at) ASC, id ASC";
    // limit/offset are validated non-negative integers above, so inlining them
    // is injection-safe. SQLite needs LIMIT before OFFSET; LIMIT -1 pages by
    // offset alone.
    if (limit !== null) {
      query += ` LIMIT ${limit} OFFSET ${offset}`;
    } else if (offset > 0) {
      query += ` LIMIT -1 OFFSET ${offset}`;
    }
    const rows = this.workspaceRuntimeDb(workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToCronjob(row, workspaceId));
  }

  /** Total cronjobs matching the same filters as {@link listCronjobs} — used to
   * report `total` / `has_more` alongside a paginated page. */
  countCronjobs(params: { workspaceId?: string | null; enabledOnly?: boolean }): number {
    const whereEnabled = params.enabledOnly ? " WHERE enabled = 1" : "";
    if (!params.workspaceId) {
      return this.listReadableWorkspaceRuntimeDbs().reduce((sum, { db }) => {
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM cronjobs${whereEnabled}`)
          .get() as { n: number } | undefined;
        return sum + (row?.n ?? 0);
      }, 0);
    }
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`SELECT COUNT(*) AS n FROM cronjobs${whereEnabled}`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
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
            id, cronjob_id, source_type, source_label, title, message, level, priority, state,
            metadata, read_at, dismissed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedId,
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
    return this.rowToRuntimeNotification(row, params.workspaceId);
  }

  getRuntimeNotification(params: { workspaceId: string; notificationId: string }): RuntimeNotificationRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM runtime_notifications WHERE id = ? LIMIT 1")
      .get(params.notificationId);
    return row ? this.rowToRuntimeNotification(row, params.workspaceId) : null;
  }

  listRuntimeNotifications(params: {
    workspaceId?: string | null;
    includeDismissed?: boolean;
    limit?: number | null;
    sourceType?: string | null;
    excludeSourceTypes?: string[] | null;
  }): RuntimeNotificationRecord[] {
    if (!params.workspaceId) {
      const notifications = this.listReadableWorkspaceRuntimeDbs().flatMap(({ db, workspaceId }) => {
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
        return rows.map((row) => this.rowToRuntimeNotification(row, workspaceId));
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
    const workspaceId = params.workspaceId;
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
    query += ` ORDER BY ${this.notificationPrioritySortSql()} DESC, datetime(created_at) DESC, id DESC`;
    if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      query += " LIMIT ?";
      values.push(Math.floor(params.limit));
    }
    const rows = this.workspaceRuntimeDb(workspaceId).prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRuntimeNotification(row, workspaceId));
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.proposalId,
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
    return this.rowToMemoryUpdateProposal(row, params.workspaceId);
  }

  getMemoryUpdateProposal(params: { workspaceId: string; proposalId: string }): MemoryUpdateProposalRecord | null {
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string], Record<string, unknown>>("SELECT * FROM memory_update_proposals WHERE proposal_id = ? LIMIT 1")
      .get(params.proposalId);
    return row ? this.rowToMemoryUpdateProposal(row, params.workspaceId) : null;
  }

  listMemoryUpdateProposals(params: {
    workspaceId: string;
    sessionId?: string | null;
    inputId?: string | null;
    state?: MemoryUpdateProposalState | null;
    limit?: number;
    offset?: number;
  }): MemoryUpdateProposalRecord[] {
    let query = "SELECT * FROM memory_update_proposals WHERE 1 = 1";
    const values: Array<string | number> = [];
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
    return rows.map((row) => this.rowToMemoryUpdateProposal(row, params.workspaceId));
  }

  createWorkspaceCapability(params: {
    workspaceId: string;
    capabilityId: string;
    version?: string | null;
    name: string;
    description?: string | null;
    icon?: string | null;
    status?: WorkspaceCapabilityStatus | null;
    installedSkillIds?: string[] | null;
    integrationStatus?: Record<string, string> | null;
    config?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }): WorkspaceCapabilityRecord {
    const name = this.requiredNormalizedText(params.name, "name");
    const capabilityId = this.requiredNormalizedText(params.capabilityId, "capabilityId");
    const status = this.requiredWorkspaceCapabilityStatus(params.status ?? "active");
    const now = params.updatedAt ?? utcNowIso();
    const existing = this.getWorkspaceCapability({
      workspaceId: params.workspaceId,
      capabilityId,
    });
    const createdAt = params.createdAt ?? existing?.createdAt ?? now;

    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO workspace_capabilities (
          workspace_id,
          capability_id,
          version,
          name,
          description,
          icon,
          status,
          installed_skill_ids,
          integration_status,
          config_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.workspaceId,
        capabilityId,
        this.normalizedNullableText(params.version),
        name,
        this.normalizedNullableText(params.description),
        this.normalizedNullableText(params.icon),
        status,
        JSON.stringify(params.installedSkillIds ?? []),
        JSON.stringify(params.integrationStatus ?? {}),
        JSON.stringify(params.config ?? {}),
        createdAt,
        now,
      );
    });

    const record = this.getWorkspaceCapability({
      workspaceId: params.workspaceId,
      capabilityId,
    });
    if (!record) {
      throw new Error("workspace capability row not found after insert");
    }
    return record;
  }

  getWorkspaceCapability(params: {
    workspaceId: string;
    capabilityId: string;
  }): WorkspaceCapabilityRecord | null {
    const capabilityId = this.requiredNormalizedText(params.capabilityId, "capabilityId");
    const row = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, string], Record<string, unknown>>(`
        SELECT *
        FROM workspace_capabilities
        WHERE workspace_id = ?
          AND capability_id = ?
        LIMIT 1
      `)
      .get(params.workspaceId, capabilityId);
    return row ? this.rowToWorkspaceCapability(row) : null;
  }

  listWorkspaceCapabilities(params: {
    workspaceId: string;
    limit?: number;
    offset?: number;
  }): WorkspaceCapabilityRecord[] {
    const rows = this.workspaceRuntimeDb(params.workspaceId)
      .prepare<[string, number, number], Record<string, unknown>>(`
        SELECT *
        FROM workspace_capabilities
        WHERE workspace_id = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, capability_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(
        params.workspaceId,
        params.limit ?? 100,
        params.offset ?? 0,
      );
    return rows.map((row) => this.rowToWorkspaceCapability(row));
  }

  setWorkspaceCapabilityStatus(params: {
    workspaceId: string;
    capabilityId: string;
    status: WorkspaceCapabilityStatus;
  }): WorkspaceCapabilityRecord | null {
    const capabilityId = this.requiredNormalizedText(params.capabilityId, "capabilityId");
    const existing = this.getWorkspaceCapability({
      workspaceId: params.workspaceId,
      capabilityId,
    });
    if (!existing) {
      return null;
    }
    const status = this.requiredWorkspaceCapabilityStatus(params.status);

    this.mirrorWorkspaceRuntimeMutation(params.workspaceId, (db) => {
      db.prepare(`
        UPDATE workspace_capabilities
        SET status = ?,
            updated_at = ?
        WHERE workspace_id = ?
          AND capability_id = ?
      `).run(status, utcNowIso(), params.workspaceId, capabilityId);
    });

    return this.getWorkspaceCapability({
      workspaceId: params.workspaceId,
      capabilityId,
    });
  }

  deleteWorkspaceCapability(params: { workspaceId: string; capabilityId: string }): boolean {
    const capabilityId = this.requiredNormalizedText(params.capabilityId, "capabilityId");
    const result = this.workspaceRuntimeDb(params.workspaceId)
      .prepare(`
        DELETE FROM workspace_capabilities
        WHERE workspace_id = ?
          AND capability_id = ?
      `)
      .run(params.workspaceId, capabilityId);
    return result.changes > 0;
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
    // Single-tenant end-state (workspace-removal Piece 5): the one real LIVE
    // workspace now shares the single root runtime DB (data.db). The
    // per-workspace runtime.db files are no longer opened for it — they are kept
    // untouched purely as a backup and are NOT auto-folded into the root (that
    // fold was removed for being high-risk; recover legacy data on demand via
    // scripts/recover-projects.mjs). (Soft-deleted workspaces, handled above,
    // still get their own isolated db.)
    return this.rootRuntimeDb();
  }

  /** Path to the marker that requests a one-time data.db compaction on next boot. */
  private rootDbCompactMarkerPath(): string {
    return `${this.rootRuntimeDbPath}.compact-requested`;
  }

  /**
   * Request a one-time file compaction of data.db on the NEXT boot. Called by
   * the background retention sweep after it frees meaningful space: deleted rows
   * go to the freelist, so the file stays large until a VACUUM rewrites it. We
   * defer to boot (see {@link maybeCompactAndSwapRootDb}) rather than VACUUM live
   * because a background VACUUM snapshot would go stale the instant the next
   * write lands, and swapping it in would lose that write.
   */
  requestRootDbCompaction(): void {
    try {
      fs.writeFileSync(this.rootDbCompactMarkerPath(), "");
    } catch (err) {
      console.warn(
        "[runtime-state-store] failed to request data.db compaction:",
        err,
      );
    }
  }

  /**
   * If a compaction was requested (marker present) and data.db has enough
   * reclaimable free space, rebuild it compactly via `VACUUM INTO` and swap the
   * result into place — all BEFORE the main connection opens, so the source is
   * quiescent (single process, no open handle) and no write can be lost. Fully
   * guarded: any failure leaves the original data.db untouched. The marker is
   * cleared up-front so a doomed compaction (e.g. out of disk) never retries
   * every boot.
   */
  private maybeCompactAndSwapRootDb(): void {
    const markerPath = this.rootDbCompactMarkerPath();
    if (!fileExists(markerPath)) {
      return;
    }
    const tmpPath = `${this.rootRuntimeDbPath}.compact.tmp`;
    try {
      fs.rmSync(markerPath, { force: true });
      fs.rmSync(tmpPath, { force: true });
      if (!fileExists(this.rootRuntimeDbPath)) {
        return;
      }

      // Inspect the live file (read-only) to decide if a VACUUM is worthwhile
      // and to pin the schema version the compacted copy must match.
      let freelistPages = 0;
      let pageCount = 0;
      let userVersion = 0;
      let probe: Database.Database | null = null;
      try {
        probe = new Database(this.rootRuntimeDbPath, { readonly: true });
        freelistPages = probe.pragma("freelist_count", { simple: true }) as number;
        pageCount = probe.pragma("page_count", { simple: true }) as number;
        userVersion = probe.pragma("user_version", { simple: true }) as number;
      } finally {
        probe?.close();
      }
      if (
        pageCount === 0 ||
        freelistPages / pageCount < ROOT_DB_COMPACT_MIN_FREE_RATIO
      ) {
        return;
      }

      // Rebuild into a temp copy on a short-lived connection (recovers any WAL
      // into the snapshot), then validate before it is allowed near the original.
      let compactConn: Database.Database | null = null;
      try {
        compactConn = new Database(this.rootRuntimeDbPath);
        compactConn.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
      } finally {
        compactConn?.close();
      }
      if (!validateCompactedRootDb(tmpPath, userVersion)) {
        fs.rmSync(tmpPath, { force: true });
        console.warn(
          "[runtime-state-store] compacted data.db failed validation; keeping original",
        );
        return;
      }

      const before = safeFileSize(this.rootRuntimeDbPath);
      const after = safeFileSize(tmpPath);
      // Swap: the compacted copy already folded in any WAL, so dropping the live
      // file + its now-stale WAL/SHM sidecars is safe. No handle is open.
      for (const suffix of ["-wal", "-shm", ""]) {
        try {
          fs.rmSync(`${this.rootRuntimeDbPath}${suffix}`, { force: true });
        } catch {
          // best-effort
        }
      }
      fs.renameSync(tmpPath, this.rootRuntimeDbPath);
      console.info(
        `[runtime-state-store] compacted data.db ${(before / 1e9).toFixed(2)}GB -> ${(after / 1e9).toFixed(2)}GB`,
      );
    } catch (err) {
      console.warn(
        "[runtime-state-store] data.db compaction failed; keeping original:",
        err,
      );
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Marker written while a session holds data.db open, removed on clean close.
   * Its presence at open time means the previous run crashed — the only way a
   * SQLite DB can be left inconsistent — and thus the only time the integrity
   * check below is worth its cost. A clean launch never pays for it.
   *
   * Its CONTENTS distinguish how far the previous run got:
   *   "open"     — the DB was open for normal use when the process died.
   *   "checking" — the process died while running the integrity check itself.
   *
   * That distinction is load-bearing; see {@link ROOT_DB_MARKER_CHECKING}.
   */
  private rootDbDirtyMarkerPath(): string {
    return `${this.rootRuntimeDbPath}.open`;
  }

  private readRootDbMarker(): string | null {
    try {
      return fs.readFileSync(this.rootDbDirtyMarkerPath(), "utf8").trim();
    } catch {
      return null;
    }
  }

  private writeRootDbMarker(state: string): void {
    try {
      fs.writeFileSync(this.rootDbDirtyMarkerPath(), state);
    } catch {
      // best-effort — a missing marker only costs an extra check next crash.
    }
  }

  private openRootDbConnectionOnly(): Database.Database {
    fs.mkdirSync(path.dirname(this.rootRuntimeDbPath), { recursive: true });
    const db = new Database(this.rootRuntimeDbPath);
    try {
      // On a malformed file even these can throw SQLITE_CORRUPT (setting WAL mode
      // touches the header/freelist) — close the handle before rethrowing so the
      // caller's corruption guard doesn't leak a connection.
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");
    } catch (err) {
      try {
        db.close();
      } catch {
        // ignore
      }
      throw err;
    }
    return db;
  }

  /** PRAGMA quick_check — structural integrity. A throw (SQLITE_CORRUPT) or any
   *  non-"ok" result means the DB is malformed. */
  private rootDbPassesIntegrityCheck(db: Database.Database): boolean {
    try {
      return db.pragma("quick_check", { simple: true }) === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Move a corrupt data.db (+ its WAL/SHM sidecars) aside so a fresh one can
   * take its place. The bad file is preserved for offline recovery, never
   * deleted, unless it can't be renamed (then reset outright — a corrupt DB that
   * keeps the app broken is worse than lost history).
   */
  private quarantineCorruptRootDb(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${this.rootRuntimeDbPath}.corrupt-${stamp}`;
    try {
      if (fileExists(this.rootRuntimeDbPath)) {
        fs.renameSync(this.rootRuntimeDbPath, quarantinePath);
      }
      for (const suffix of ["-wal", "-shm"]) {
        try {
          fs.rmSync(`${this.rootRuntimeDbPath}${suffix}`, { force: true });
        } catch {
          // best-effort
        }
      }
      console.error(
        `[runtime-state-store] data.db failed integrity check; quarantined to ${path.basename(quarantinePath)} and started fresh. Recover readable data with: sqlite3 '${quarantinePath}' '.recover' | sqlite3 recovered.db`,
      );
    } catch (err) {
      console.error(
        "[runtime-state-store] failed to quarantine corrupt data.db; resetting it:",
        err,
      );
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(`${this.rootRuntimeDbPath}${suffix}`, { force: true });
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Open data.db with a boot-time corruption guard. If the previous run crashed
   * (dirty marker present) and the file no longer passes quick_check, quarantine
   * it and start fresh — otherwise a malformed DB fails migrations or, worse,
   * silently wedges the queue worker so agents hang forever with no visible
   * cause. Gated on an unclean prior shutdown so healthy launches stay fast.
   */
  private openRootRuntimeDbConnection(): Database.Database {
    const priorMarker = this.readRootDbMarker();
    const priorRunUnclean = priorMarker !== null;
    // The previous run died DURING the check itself. Running it again would die
    // the same way, forever: quick_check is unbounded (it walks every page — ~80s
    // on a 2GB data.db) and the desktop gives the runtime ~30s to answer /healthz
    // before killing and respawning it. Being killed leaves the marker, which
    // re-arms the check. That livelock bricks the app with no error anywhere:
    // the runtime never binds and the log only shows the boot line repeating.
    //
    // So the check gets exactly ONE attempt. If it did not survive that, boot
    // without it and say so — a DB that is genuinely malformed still surfaces at
    // migration time, which fails loudly, whereas the loop never surfaces at all.
    const integrityCheckDiedLastBoot = priorMarker === ROOT_DB_MARKER_CHECKING;
    let db: Database.Database | null = null;
    if (priorRunUnclean && !integrityCheckDiedLastBoot) {
      // Record that the check is underway BEFORE running it, so that if this
      // process is killed mid-check the next boot can tell "crashed while open"
      // from "crashed while checking".
      this.writeRootDbMarker(ROOT_DB_MARKER_CHECKING);
      console.warn(
        `[state-store] previous run exited uncleanly — verifying ${path.basename(this.rootRuntimeDbPath)} integrity (this can take minutes on a large database)`,
      );
      // The prior run crashed, so the DB may be malformed. Corruption can surface
      // either as a throw while opening/setting pragmas OR as a non-"ok"
      // quick_check — treat both the same: quarantine the bad file and start
      // fresh so a corrupt DB can't wedge migrations or the queue worker.
      const startedAt = Date.now();
      try {
        db = this.openRootDbConnectionOnly();
        if (!this.rootDbPassesIntegrityCheck(db)) {
          throw new Error("root data.db failed quick_check");
        }
        console.warn(
          `[state-store] integrity check passed in ${Math.round((Date.now() - startedAt) / 1000)}s`,
        );
      } catch {
        try {
          db?.close();
        } catch {
          // ignore
        }
        db = null;
        this.quarantineCorruptRootDb();
      }
    } else if (integrityCheckDiedLastBoot) {
      console.warn(
        `[state-store] skipping the integrity check on ${path.basename(this.rootRuntimeDbPath)}: the previous boot was killed while running it. Booting without it — run "PRAGMA quick_check" by hand if you suspect corruption.`,
      );
    }
    if (!db) {
      db = this.openRootDbConnectionOnly();
    }
    // Mark the session open; close() clears it on a clean exit.
    this.writeRootDbMarker(ROOT_DB_MARKER_OPEN);
    return db;
  }

  /**
   * Resolver for the single root runtime DB (`data.db`) — the single-tenant
   * end-state store that holds EVERY live workspace's runtime data, with each
   * former workspace folded in as a `projects` row. `workspaceRuntimeDb` routes
   * every live workspace here (Phase B), so this is the hot runtime DB, not
   * dormant machinery anymore. Mirrors the original `workspaceRuntimeDb` open
   * sequence (mkdir → new Database → pragmas → vector ext → schema → migrations →
   * cache) but with NO legacy backfill — data arrives either from new writes
   * (which land here directly) or, for a pre-existing deployment, from the
   * one-time fold of the per-workspace runtime.db files below.
   */
  private rootRuntimeDb(): Database.Database {
    if (this.#rootRuntimeDb) {
      return this.#rootRuntimeDb;
    }
    // One-time file compaction, if the background retention sweep requested it.
    // Runs here — before the connection is opened, while the DB is quiescent in
    // this single process — because that is the only point a VACUUM snapshot is
    // guaranteed complete and a file swap cannot lose a concurrent write.
    this.maybeCompactAndSwapRootDb();
    const db = this.openRootRuntimeDbConnection();
    this.#vectorIndexSupported = this.tryLoadVectorExtension(db) || this.#vectorIndexSupported;
    this.ensureWorkspaceRuntimeDbSchema(db);
    this.runPendingMigrations(db);
    // Cache the handle. The one-time legacy fold (pre-existing per-workspace
    // runtime.db files + the host-state monolith → this root db) is DELIBERATELY
    // no longer run on open. It was high-risk: the fold could orphan a user's
    // Projects + sessions on upgrade (empty-timestamp project rows that break the
    // list render + INSERT OR IGNORE failing to re-tag sessions already in root).
    // Live reads/writes already route to this root db regardless of the fold, so
    // pre-flip legacy data is simply left untouched as a backup and IGNORED —
    // recover it on demand with scripts/recover-projects.mjs.
    // `consolidateWorkspaceRuntimeDbsIntoRoot()` is retained (tests + that manual
    // recovery reference the same logic) but is never auto-invoked.
    this.#rootRuntimeDb = db;
    return db;
  }

  /**
   * Phase A (workspace-removal Piece 5) DORMANT machinery — public for tests and
   * for Phase B to invoke once. NOT called by any constructor/init/open path.
   *
   * Folds every live workspace's per-workspace runtime DB into the single root
   * `data.db`: each workspace becomes a `projects` row, and its runtime rows are
   * copied across, with `agent_sessions` tagged to that project. This is a
   * non-destructive N→1 consolidation — the per-workspace DB files and the
   * `workspaces` table are left fully intact as a backup; nothing is deleted or
   * dropped. Idempotent: a workspace whose `projects` row already exists in the
   * root is skipped, and all inserts use `INSERT OR IGNORE`, so re-runs never
   * throw or clobber.
   */
  consolidateWorkspaceRuntimeDbsIntoRoot(): {
    workspacesConsolidated: number;
    sessionsCopied: number;
  } {
    const root = this.rootRuntimeDb();
    let workspacesConsolidated = 0;
    let sessionsCopied = 0;
    let foldFailures = 0;

    const existingProject = root.prepare<[string], { project_id: string }>(
      "SELECT project_id FROM projects WHERE project_id = ?",
    );
    const insertProject = root.prepare(`
      INSERT OR IGNORE INTO projects (
          project_id, name, project_path, icon, icon_color, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const workspace of this.listRegisteredWorkspaceRecords({ includeDeleted: false })) {
      // Idempotency: already consolidated → skip entirely (no re-copy).
      if (existingProject.get(workspace.id)) {
        continue;
      }

      const workspacePath = this.workspaceDir(workspace.id);
      const sourceDbPath = workspaceRuntimeDbPathForWorkspacePath(workspacePath);
      if (!fs.existsSync(sourceDbPath)) {
        // No per-workspace runtime DB on disk (never opened / pruned) — nothing
        // to fold in. Leave it out of the projects registry too, so a later run
        // can pick it up if the DB materializes.
        continue;
      }

      // The projects table requires NOT NULL timestamps. Reuse the workspace's
      // own strings; fall back to utcNowIso() (NEVER "") — an empty created_at
      // breaks the Projects list render and orphans the folded project.
      const createdAt = workspace.createdAt ?? workspace.updatedAt ?? utcNowIso();
      const updatedAt = workspace.updatedAt ?? workspace.createdAt ?? createdAt;

      // Per-workspace fault isolation: one corrupt/locked/unreadable source DB
      // must skip ONLY that workspace and let the loop continue — never abort the
      // whole consolidation. DETACH runs in finally so a thrown copy can't leave
      // `src` attached and poison the next iteration.
      try {
        // ATTACH/DETACH must live OUTSIDE the per-workspace transaction — SQLite
        // forbids attaching a database while a transaction is open. The actual
        // row copy still runs inside one transaction on the root DB so the
        // projects row + every copied row land atomically (or not at all).
        root.exec(`ATTACH DATABASE '${sourceDbPath.replace(/'/g, "''")}' AS src`);
        try {
          let copiedSessions = 0;
          root.transaction(() => {
            insertProject.run(
              workspace.id,
              workspace.name,
              workspacePath,
              workspace.icon ?? null,
              workspace.iconColor ?? null,
              createdAt,
              updatedAt,
            );

            // Carry the workspace's own sub-projects into root `projects` as peer
            // projects, so their sessions aren't orphaned. The main copy loop
            // below can't reach them: `projects` is filtered out, and a legacy
            // `workspace_projects` table doesn't exist in root. Try both source
            // names; INSERT OR IGNORE keeps it idempotent.
            for (const srcProjectTable of ["projects", "workspace_projects"]) {
              const srcProjectColumns = (
                root
                  .prepare(
                    `SELECT name FROM pragma_table_info('${srcProjectTable}', 'src')`,
                  )
                  .all() as Array<{ name: string }>
              ).map((row) => row.name);
              if (srcProjectColumns.length === 0) {
                continue;
              }
              const rootProjectColumns = (
                root
                  .prepare(`SELECT name FROM pragma_table_info('projects', 'main')`)
                  .all() as Array<{ name: string }>
              ).map((row) => row.name);
              const sharedProjectColumns = rootProjectColumns.filter(
                (column) =>
                  column !== "workspace_id" && srcProjectColumns.includes(column),
              );
              if (sharedProjectColumns.length === 0) {
                continue;
              }
              const projectColumnList = sharedProjectColumns
                .map((column) => `"${column}"`)
                .join(", ");
              root
                .prepare(
                  `INSERT OR IGNORE INTO main."projects" (${projectColumnList})
                   SELECT ${projectColumnList} FROM src."${srcProjectTable}"`,
                )
                .run();
            }

            // Enumerate copyable data tables on the attached source: plain tables
            // only — skip the `projects` registry (handled above), every FTS5
            // table + its shadow tables (`*_fts*`), every vec0 virtual table + its
            // shadows (`*_vec*`), any other virtual table, and sqlite internals.
            // `outputs_fts` is intentionally NOT raw-copied: it is an app-derived
            // index, rebuilt from the copied `outputs` rows below.
            const sourceTables = (
              root
                .prepare(
                  `SELECT name, sql FROM src.sqlite_master
                   WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
                )
                .all() as Array<{ name: string; sql: string | null }>
            )
              .filter(
                ({ name, sql }) =>
                  name !== "projects" &&
                  // Integration graph is control-plane-only now (Piece 5.7); the
                  // root has no such table to copy into. Skip explicitly — they
                  // are plain tables the _fts/_vec/virtual filter below misses.
                  !INTEGRATION_GRAPH_ROOT_SKIP_TABLES.has(name) &&
                  !name.includes("_fts") &&
                  !name.includes("_vec") &&
                  !(sql ?? "").trim().toUpperCase().startsWith("CREATE VIRTUAL TABLE"),
              )
              .map(({ name }) => name);

            for (const table of sourceTables) {
              // Root must actually have this table for a column-matched copy.
              // Check `main.sqlite_master` EXPLICITLY: an unqualified
              // pragma_table_info() resolves against the ATTACHED `src` when
              // `main` lacks the table (e.g. a legacy `workspace_projects`), which
              // would wrongly pass this guard and then throw "no such table:
              // main.<table>" on the INSERT — aborting the whole workspace fold.
              const rootHasTable = root
                .prepare(
                  `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
                )
                .get(table);
              if (!rootHasTable) {
                continue;
              }
              const rootColumns = (
                root
                  .prepare(`SELECT name FROM pragma_table_info(?)`)
                  .all(table) as Array<{ name: string }>
              ).map((row) => row.name);
              if (rootColumns.length === 0) {
                continue;
              }
              const srcColumns = new Set(
                (
                  root
                    .prepare(`SELECT name FROM pragma_table_info('${table}', 'src')`)
                    .all() as Array<{ name: string }>
                ).map((row) => row.name),
              );
              const sharedColumns = rootColumns.filter((column) =>
                srcColumns.has(column),
              );
              if (sharedColumns.length === 0) {
                continue;
              }

              const targetColumnList = sharedColumns
                .map((column) => `"${column}"`)
                .join(", ");

              if (table === "agent_sessions") {
                // Tag every copied session to this project, but preserve a
                // pre-existing (non-null) project_id from the source row.
                const selectList = sharedColumns
                  .map((column) =>
                    column === "project_id"
                      ? `COALESCE("project_id", '${workspace.id.replace(/'/g, "''")}') AS "project_id"`
                      : `"${column}"`,
                  )
                  .join(", ");
                const result = root
                  .prepare(
                    `INSERT OR IGNORE INTO main."agent_sessions" (${targetColumnList})
                     SELECT ${selectList} FROM src."agent_sessions"`,
                  )
                  .run();
                copiedSessions += result.changes;
                // INSERT OR IGNORE won't re-tag a session already present in root,
                // leaving project_id NULL (orphaned). Backfill those pre-existing
                // NULL rows: prefer the source row's own project_id (a sub-project),
                // else this workspace's project id.
                root
                  .prepare(
                    `UPDATE main."agent_sessions"
                       SET project_id = COALESCE(
                         (SELECT ss."project_id" FROM src."agent_sessions" ss
                          WHERE ss."session_id" = main."agent_sessions"."session_id"),
                         ?
                       )
                     WHERE project_id IS NULL
                       AND session_id IN (SELECT session_id FROM src."agent_sessions")`,
                  )
                  .run(workspace.id);
              } else {
                const columnList = sharedColumns
                  .map((column) => `"${column}"`)
                  .join(", ");
                root
                  .prepare(
                    `INSERT OR IGNORE INTO main."${table}" (${targetColumnList})
                     SELECT ${columnList} FROM src."${table}"`,
                  )
                  .run();
              }
            }
          })();
          // Only credit the copy once the transaction has actually committed, so
          // a mid-copy throw (caught below) leaves the running totals untouched.
          sessionsCopied += copiedSessions;
        } finally {
          // DETACH is best-effort: if the ATTACH itself threw, `src` was never
          // attached and this would throw "no such database" — that secondary
          // error must not mask the original, so it is swallowed.
          try {
            root.exec("DETACH DATABASE src");
          } catch {
            // ignore — nothing was attached, or it is already detached.
          }
        }

        // Rebuild the outputs FTS index from the now-copied `outputs` rows. This
        // is a no-op once the root FTS already has any rows (its internal guard
        // short-circuits), so it effectively indexes the first consolidated
        // workspace's outputs; later workspaces' outputs are re-indexed lazily by
        // normal app writes / Phase B. The raw row data is fully copied either
        // way — only the derived search index is approximate here.
        this.backfillOutputsFts(root);

        workspacesConsolidated += 1;
      } catch (err) {
        // Skip ONLY this workspace — its rows stay in the per-workspace backup db
        // and a later re-run can fold it once it is healthy — and keep
        // consolidating the rest. The root db's partial state (this workspace's
        // transaction rolled back atomically) remains consistent. LOG it: a
        // silent skip here once hid the workspace_projects attached-DB pragma bug.
        console.warn(
          `[runtime-state-store] consolidation: skipped workspace ${workspace.id}:`,
          err,
        );
        foldFailures += 1;
        continue;
      }
    }

    // After the per-workspace files are folded (so per-workspace rows WIN on PK
    // collisions — the INSERT OR IGNOREs above ran first), fold the legacy
    // host-state monolith DB (`this.dbPath`) into the root as well. A deployment
    // whose runtime data still lives in that monolith — sessions/outputs/etc.
    // tagged with `workspace_id` — would otherwise be invisible after the
    // single-tenant flip. The monolith only fills gaps the per-workspace files
    // did not. Defensive: a failure here must not abort consolidation.
    sessionsCopied += this.consolidateHostStateMonolithIntoRoot(root);

    // Piece 5.11: once EVERY workspace is folded into projects (none failed), the
    // `workspaces` registry table is fully superseded by `projects` + the
    // synthetic root — drop it. Doing it HERE (not in a migration) guarantees
    // fold-before-drop: a migration would race ahead of this lazily-run fold and
    // could drop the table before a fresh upgrade folded it, losing that
    // install's history. Skipped if any fold failed (so a retry can still see the
    // unfolded rows); idempotent (DROP IF EXISTS, and the schema-ensure no longer
    // recreates it).
    if (foldFailures === 0) {
      this.controlPlaneDb().exec("DROP TABLE IF EXISTS workspaces");
      // ...and the legacy host-state monolith's own copy, when it is a separate
      // DB. Post-5.11 nothing creates it (the desktop bootstrap + both runtime
      // schema-ensures stopped) and nothing reads it, so dropping the folded
      // table leaves the registry gone for good rather than lingering vestigial.
      if (this.controlPlaneDbPath !== this.dbPath) {
        this.db().exec("DROP TABLE IF EXISTS workspaces");
      }
    }

    return { workspacesConsolidated, sessionsCopied };
  }

  /**
   * Fold the legacy host-state monolith DB (`this.dbPath`, opened via `this.db()`,
   * schema `ensureRuntimeDbSchema`) into the single root `data.db`, returning the
   * number of `agent_sessions` rows copied. Historically a deployment kept ALL of
   * its runtime data — sessions, outputs, cronjobs, … — in this one monolith,
   * discriminated by a `workspace_id` column. After the single-tenant flip those
   * rows route to the per-workspace runtime.db files / root, so any rows still
   * stranded in the monolith must be migrated here or they become invisible.
   *
   * Runs AFTER the per-workspace fold (the caller's loop), so the per-workspace
   * files' rows already landed and win on primary-key collisions — every copy
   * here is INSERT OR IGNORE, so the monolith only fills gaps it left.
   *
   * Non-destructive and cheap-idempotent: INSERT OR IGNORE everywhere, never
   * UPDATE/DELETE, and the `workspaces` table + the monolith file itself are left
   * fully intact. The whole consolidation is latched to run once per process, but
   * even an un-latched re-run is harmless (re-copies 0 rows, creates no dups).
   *
   * Fault-isolated: wrapped in try/catch with DETACH in finally; a corrupt /
   * locked / unreadable monolith returns 0 rather than throwing (the caller also
   * swallows, but defence in depth keeps the rest of consolidation intact).
   */
  private consolidateHostStateMonolithIntoRoot(root: Database.Database): number {
    // Already folded once (persisted marker) → NEVER re-fold. The monolith file is
    // kept intact as a backup, so without this guard the fold re-runs on every store
    // open and re-INSERTs a `projects` row (INSERT OR IGNORE) for every legacy
    // workspace_id — silently resurrecting projects the user has since deleted.
    if (this.hostStateMonolithFolded(root)) {
      return 0;
    }
    // No monolith file on disk → nothing to fold. Check BEFORE this.db(), which
    // would otherwise create + schematize an empty monolith from scratch. Don't set
    // the marker here: the file may still appear later (an upgrade path), and a
    // no-op has nothing to guard against.
    if (!fs.existsSync(this.dbPath)) {
      return 0;
    }
    // Open/obtain the monolith for its side effect (migrate + schema-ensure +
    // cache the handle so the file on disk is fully consistent before ATTACH).
    // With Part 1's guard, migration 028 no-ops on a `workspaces`-bearing DB, so
    // the monolith's session tables KEEP their `workspace_id` discriminator for
    // the map below. We then ATTACH the file by path (not via this handle).
    this.db();
    const legacyPath = this.dbPath;

    let copiedSessions = 0;
    // Whether the monolith actually held legacy workspace data (any workspace_id).
    // An EMPTY monolith — e.g. the host-state db that `controlPlaneDb()` creates
    // on a fresh install, which has no session tables — folds nothing and must NOT
    // be marked done: there is nothing to guard against re-creating, and marking it
    // would block a real fold if data ever appears. Only a monolith that carried
    // real workspace data (and thus created `projects` rows that a delete must be
    // able to stick against) gets the one-time marker.
    let monolithHadWorkspaceData = false;
    try {
      // ATTACH/DETACH must live OUTSIDE any transaction — SQLite forbids
      // attaching a database while a transaction is open (same constraint the
      // per-workspace fold documents). The row copy still runs inside one root
      // transaction so every copied row lands atomically (or not at all).
      root.exec(`ATTACH DATABASE '${legacyPath.replace(/'/g, "''")}' AS legacy`);
      try {
        // Enumerate copyable plain tables on the attached monolith — identical
        // filter to the per-workspace fold: skip `projects` + the `workspaces`
        // registry, every FTS5 table + its shadows (`*_fts*`), every vec0 table +
        // its shadows (`*_vec*`), any other virtual table, and sqlite internals.
        const legacyTables = (
          root
            .prepare(
              `SELECT name, sql FROM legacy.sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            .all() as Array<{ name: string; sql: string | null }>
        )
          .filter(
            ({ name, sql }) =>
              name !== "projects" &&
              name !== "workspaces" &&
              // Integration graph is control-plane-only now (Piece 5.7); the root
              // has no such table to copy into. Skip explicitly — they are plain
              // tables the _fts/_vec/virtual filter below misses.
              !INTEGRATION_GRAPH_ROOT_SKIP_TABLES.has(name) &&
              !name.includes("_fts") &&
              !name.includes("_vec") &&
              !(sql ?? "").trim().toUpperCase().startsWith("CREATE VIRTUAL TABLE"),
          )
          .map(({ name }) => name);

        root.transaction(() => {
          for (const table of legacyTables) {
            // Root must actually have this table for a column-matched copy.
            // Check `main.sqlite_master` EXPLICITLY — an unqualified
            // pragma_table_info() resolves against the ATTACHED `legacy` DB when
            // `main` lacks the table, wrongly passing this guard then throwing on
            // the INSERT into a nonexistent main table.
            const rootHasTable = root
              .prepare(
                `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
              )
              .get(table);
            if (!rootHasTable) {
              continue;
            }
            const rootColumns = (
              root
                .prepare(`SELECT name FROM pragma_table_info(?)`)
                .all(table) as Array<{ name: string }>
            ).map((row) => row.name);
            if (rootColumns.length === 0) {
              continue;
            }
            const legacyColumns = new Set(
              (
                root
                  .prepare(`SELECT name FROM pragma_table_info('${table}', 'legacy')`)
                  .all() as Array<{ name: string }>
              ).map((row) => row.name),
            );

            const legacyHasWorkspaceId = legacyColumns.has("workspace_id");

            if (legacyHasWorkspaceId) {
              // For each DISTINCT workspace_id present in this monolith table,
              // ensure a `projects` row exists in root (project_id == that
              // workspace_id) so the copied rows have a project to attach to.
              // Name/path come from the `workspaces` registry; a hard-deleted
              // workspace (no registry row) falls back to id-as-name + "" path
              // so its data is still folded, never dropped.
              const distinctWorkspaceIds = (
                root
                  .prepare(
                    `SELECT DISTINCT workspace_id AS id FROM legacy."${table}"
                     WHERE workspace_id IS NOT NULL`,
                  )
                  .all() as Array<{ id: string }>
              ).map((row) => row.id);
              if (distinctWorkspaceIds.length > 0) {
                monolithHadWorkspaceData = true;
              }
              for (const workspaceId of distinctWorkspaceIds) {
                this.ensureProjectRowForMonolithWorkspace(root, workspaceId);
              }
            }

            // Root has NO `workspace_id` column on any of these tables (Piece 5
            // dropped it), so drop it from the target column list for EVERY
            // table. Match only the remaining columns the root shares.
            const sharedColumns = rootColumns.filter(
              (column) =>
                column !== "workspace_id" && legacyColumns.has(column),
            );
            if (sharedColumns.length === 0) {
              continue;
            }
            const targetColumnList = sharedColumns
              .map((column) => `"${column}"`)
              .join(", ");

            if (table === "agent_sessions" && legacyHasWorkspaceId) {
              // Tag every copied session to its workspace's project, preserving
              // a pre-existing (non-null) project_id from the monolith row.
              const selectList = sharedColumns
                .map((column) =>
                  column === "project_id"
                    ? `COALESCE("project_id", "workspace_id") AS "project_id"`
                    : `"${column}"`,
                )
                .join(", ");
              const result = root
                .prepare(
                  `INSERT OR IGNORE INTO main."agent_sessions" (${targetColumnList})
                   SELECT ${selectList} FROM legacy."agent_sessions"`,
                )
                .run();
              copiedSessions += result.changes;
              // INSERT OR IGNORE cannot re-tag a session that ALREADY exists in
              // root — it skips the row, leaving project_id NULL and orphaning the
              // session from its project (the "sessions disappeared" bug). Backfill
              // project_id on those pre-existing NULL rows from the monolith's
              // workspace_id (the id that IS the project id for this fold).
              root
                .prepare(
                  `UPDATE main."agent_sessions"
                     SET project_id = (
                       SELECT ls."workspace_id" FROM legacy."agent_sessions" ls
                       WHERE ls."session_id" = main."agent_sessions"."session_id"
                     )
                   WHERE project_id IS NULL
                     AND session_id IN (
                       SELECT session_id FROM legacy."agent_sessions"
                       WHERE workspace_id IS NOT NULL
                     )`,
                )
                .run();
            } else {
              const columnList = sharedColumns
                .map((column) => `"${column}"`)
                .join(", ");
              root
                .prepare(
                  `INSERT OR IGNORE INTO main."${table}" (${targetColumnList})
                   SELECT ${columnList} FROM legacy."${table}"`,
                )
                .run();
            }
          }
        })();

        // Index the freshly-copied `outputs` rows into the outputs FTS (no-op
        // once the root FTS already has rows — its internal guard short-circuits).
        this.backfillOutputsFts(root);
      } finally {
        // DETACH is best-effort: if the ATTACH threw, `legacy` was never attached
        // and this would throw "no such database" — swallow that secondary error
        // so it can't mask the original.
        try {
          root.exec("DETACH DATABASE legacy");
        } catch {
          // ignore — nothing was attached, or it is already detached.
        }
      }
    } catch (err) {
      // Monolith corrupt / locked / unreadable, or an ATTACH/copy failure: the
      // root transaction rolled back atomically, so the root db stays consistent
      // and the monolith's rows simply stay in the (intact) monolith. Never throw,
      // but LOG it — don't repeat the silent-failure mistake.
      console.warn(
        "[runtime-state-store] host-state monolith fold failed:",
        err,
      );
      return 0;
    }

    // Fold succeeded (the catch above returns early on failure, so a failed fold
    // is retried on the next open). If the monolith actually carried legacy
    // workspace data, mark it done so we NEVER re-fold — this is the fix for
    // deleted projects creeping back after a release install (the re-fold's
    // INSERT OR IGNORE would otherwise resurrect every project the user deleted).
    if (monolithHadWorkspaceData) {
      this.markHostStateMonolithFolded(root);
    }
    return copiedSessions;
  }

  /**
   * Ensure a `projects` row exists in the root for a workspace id discovered in
   * the host-state monolith's `workspace_id` discriminator. Looks up the
   * display name / path from the `workspaces` registry; a hard-deleted workspace
   * (no registry row) falls back to the id as the name and "" as the path so its
   * stranded monolith data is still folded in rather than dropped. INSERT OR
   * IGNORE → cheap-idempotent, never clobbers an existing project row.
   */
  private ensureProjectRowForMonolithWorkspace(
    root: Database.Database,
    workspaceId: string,
  ): void {
    // Must read the REAL registry, not the synthetic root: getWorkspace() returns
    // the root (with a borrowed name) for ANY id, so the `?? workspaceId` fallback
    // below would never fire for an unregistered/hard-deleted workspace and the
    // folded `projects` row would inherit the wrong name.
    const record = this.getRegisteredWorkspaceRecord(workspaceId, { includeDeleted: true });
    const name = record?.name ?? workspaceId;
    // workspacePathFromRegistry never throws and returns null for a hard-deleted
    // / unregistered workspace; fall back to "" so the NOT NULL column is filled.
    const projectPath = this.workspacePathFromRegistry(workspaceId) ?? "";
    // Timestamps: reuse the registry's strings; the projects table requires
    // NOT NULL timestamps. A hard-deleted workspace has none — fall back to
    // utcNowIso(), NEVER "": an empty created_at breaks the Projects list render
    // (invalid date), which is what made folded projects "disappear".
    const createdAt = record?.createdAt ?? record?.updatedAt ?? utcNowIso();
    const updatedAt = record?.updatedAt ?? record?.createdAt ?? createdAt;
    root
      .prepare(`
        INSERT OR IGNORE INTO projects (
            project_id, name, project_path, icon, icon_color, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workspaceId,
        name,
        projectPath,
        record?.icon ?? null,
        record?.iconColor ?? null,
        createdAt,
        updatedAt,
      );
  }

  private mirrorWorkspaceRuntimeMutation(workspaceId: string, mutate: (db: Database.Database) => void): void {
    const workspaceDb = this.workspaceRuntimeDb(workspaceId);
    mutate(workspaceDb);
  }

  private listReadableWorkspaceRuntimeDbs(): Array<{ workspaceId: string; db: Database.Database }> {
    // Single-tenant end-state: the one real workspace shares the root runtime DB,
    // which holds ALL of its rows. Return exactly ONE entry for it — returning
    // one-per-workspace would hand back the SAME handle N times and make every
    // aggregate scan double-count (and every claim loop re-scan the same rows).
    // That entry is tagged with the canonical (most-recently-updated) live
    // workspace id, mirroring resolveCanonicalWorkspaceId; callers fold the
    // record's workspaceId straight back into workspaceRuntimeDb(), which routes
    // any real live id to this same root. "" only when there is no live workspace
    // at all — in which case the root is empty and scans return nothing.
    const canonicalWorkspaceId =
      this.listWorkspaces({ includeDeleted: false })[0]?.id ?? "";
    const databases: Array<{ workspaceId: string; db: Database.Database }> = [
      { workspaceId: canonicalWorkspaceId, db: this.rootRuntimeDb() },
    ];
    // ALSO include every cached isolated runtime db — draft labs (their own
    // per-workspace file) and soft-deleted workspaces (their in-memory schema-only
    // db). These never route to the root (labs are sandboxes that merge back;
    // deleted workspaces keep their data isolated), so their rows are invisible to
    // the root entry above. Aggregate scans that must see them — most importantly
    // findAvailablePort()'s port-collision check via listAllAppPorts() — would
    // otherwise miss lab/deleted ports and hand out colliding allocations. The
    // root db is cached separately (#rootRuntimeDb), so it can't appear here too.
    for (const [workspaceId, entry] of this.#workspaceRuntimeDbs.entries()) {
      databases.push({ workspaceId, db: entry.db });
    }
    return databases;
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

  private integrationDbForWorkspace(_workspaceId?: string | null): Database.Database {
    // workspace-removal Piece 5.7: the integration knowledge graph
    // (integration_trees / integration_leaves / integration_node_embeddings) is
    // account-global and lives ONLY in the control-plane DB now. The former
    // per-workspace/root variant of these tables is dropped by migration 030
    // (a clean drop — those rows are derived/rebuildable and intentionally not
    // preserved). The `workspaceId` arg is kept on the signature for call-site
    // stability but is intentionally ignored.
    return this.controlPlaneDb();
  }

  private listReadableIntegrationDbs(params: {
    workspaceId?: string | null;
    includeControlPlane?: boolean;
    includeWorkspace?: boolean;
  } = {}): Array<{ workspaceId: string | null; db: Database.Database }> {
    // Integration graph is control-plane-only (Piece 5.7): every read resolves to
    // the single control-plane DB regardless of the requested workspace scope.
    // Returning `workspaceId: null` makes downstream readers take their
    // control-plane query branch (the `workspaceId ? ... : ...` ternaries), so no
    // query references the now-dropped per-workspace `workspace_id` column.
    void params;
    return [{ workspaceId: null, db: this.controlPlaneDb() }];
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

  private resolveSemanticMemoryScope(
    category: SemanticMemoryCategory,
    workspaceId?: string | null,
  ): { workspaceId: string | null; db: Database.Database } {
    if (category === "interaction" || category === "workspace") {
      if (!workspaceId) {
        throw new Error(`semantic ${category} memory requires workspaceId`);
      }
      return {
        workspaceId,
        db: this.workspaceRuntimeDb(workspaceId),
      };
    }
    if (category === "integration") {
      // workspace-removal Piece 5.7: integration semantic memory is account-global
      // and control-plane-only. Any requested workspace scope collapses to the
      // control-plane DB (`workspaceId: null`), matching the integration graph
      // tables that now live exclusively there. The `workspaceId` arg is kept for
      // call-site stability but is ignored for this category.
      return {
        workspaceId: null,
        db: this.controlPlaneDb(),
      };
    }
    return {
      workspaceId: null,
      db: this.controlPlaneDb(),
    };
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
    // Piece 5.11: do NOT backfill the `workspaces` table. It is legacy/transient
    // — read-only until the consolidation folds it into `projects`, then dropped —
    // so nothing should WRITE it. The old backfill hard-coded late columns
    // (`icon`/`icon_color`, `onboarding_state`, …) that drift off older targets
    // now that `ensureWorkspacesTableSchema` no longer back-fills them, so it would
    // crash control-plane init with "no column named icon". Existing control-plane
    // workspace rows are untouched and still fold via
    // consolidateWorkspaceRuntimeDbsIntoRoot before the table is dropped.
    if (tableNames.has("runtime_user_profiles")) {
      const rows = legacy.prepare("SELECT * FROM runtime_user_profiles").all() as Array<Record<string, unknown>>;
      const statement = db.prepare(`
        INSERT OR IGNORE INTO runtime_user_profiles (
          profile_id,
          name,
          timezone,
          name_source,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        statement.run(
          row.profile_id,
          row.name ?? null,
          row.timezone ?? null,
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

  /** Has the legacy host-state monolith already been folded into the root? Persisted in
   *  the root's `workspace_runtime_metadata` so the guard survives restarts/releases.
   *  (Retained for tests + manual recovery; the fold is no longer auto-run on open.) */
  private hostStateMonolithFolded(root: Database.Database): boolean {
    if (!this.tableExists(root, "workspace_runtime_metadata")) {
      return false;
    }
    const row = root
      .prepare<[string], { value?: string }>(
        "SELECT value FROM workspace_runtime_metadata WHERE key = ? LIMIT 1",
      )
      .get(HOST_STATE_MONOLITH_FOLDED_MARKER_KEY);
    return row?.value === "complete";
  }

  private markHostStateMonolithFolded(root: Database.Database): void {
    root.prepare(`
      INSERT INTO workspace_runtime_metadata (key, value, updated_at)
      VALUES (?, 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(
      HOST_STATE_MONOLITH_FOLDED_MARKER_KEY,
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

    // The legacy multi-workspace runtime.db keeps `workspace_id` on these
    // tables (migration 029 no-ops there), so scope the copy to this workspace.
    // Guard on the column actually existing so a legacy table that lost it
    // (single-scope) still backfills instead of throwing "no such column".
    const rows = legacyColumns.has("workspace_id")
      ? (params.legacy
          .prepare(`SELECT ${sharedColumns.join(", ")} FROM ${params.tableName} WHERE workspace_id = ?`)
          .all(params.workspaceId) as Array<Record<string, unknown>>)
      : (params.legacy
          .prepare(`SELECT ${sharedColumns.join(", ")} FROM ${params.tableName}`)
          .all() as Array<Record<string, unknown>>);
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
    // Piece 5.11: workspaces table no longer created (single-tenant root).
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_user_profiles (
          profile_id TEXT PRIMARY KEY,
          name TEXT,
          timezone TEXT,
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
          context_cron_auto_fetch_enabled INTEGER NOT NULL DEFAULT 1,
          auth_mode TEXT NOT NULL,
          granted_scopes TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          secret_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner_updated
          ON integration_connections (provider_id, owner_user_id, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS composio_tool_schemas (
          toolkit_slug TEXT PRIMARY KEY,
          schemas_json TEXT NOT NULL,
          fetched_at TEXT NOT NULL
      );

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
          UNIQUE (workspace_id, target_type, target_id, integration_key)
          -- No FK on connection_id: under Stage 3, Composio accounts (ca_…) are
          -- remote-only (no local integration_connections row), so an FK here
          -- rejected binding them ("FOREIGN KEY constraint failed"). Validity is
          -- enforced at enumeration / in code; migrateDropIntegrationBindingsFk
          -- rebuilds pre-existing tables that still carry the old FK.
      );

      CREATE INDEX IF NOT EXISTS idx_integration_bindings_workspace_updated
          ON integration_bindings (workspace_id, is_default DESC, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS integration_trees (
          tree_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          account_namespace TEXT NOT NULL,
          account_key TEXT NOT NULL,
          account_label TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          summary TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (provider, owner_user_id, account_key)
      );

      CREATE INDEX IF NOT EXISTS idx_integration_trees_provider_owner_status_updated
          ON integration_trees (provider, owner_user_id, status, updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS integration_leaves (
          leaf_id TEXT PRIMARY KEY,
          tree_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          entity_key TEXT,
          entity_label TEXT,
          branch_key TEXT,
          branch_label TEXT,
          path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          source_type TEXT,
          source_event_id TEXT,
          source_message_id TEXT,
          external_object_id TEXT,
          external_object_type TEXT,
          admission_confidence REAL,
          observed_at TEXT,
          supersedes_leaf_id TEXT,
          superseded_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_integration_leaves_tree_status_observed
          ON integration_leaves (tree_id, status, observed_at DESC, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_integration_leaves_tree_subject
          ON integration_leaves (tree_id, subject_key, status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_integration_leaves_tree_fingerprint
          ON integration_leaves (tree_id, fingerprint);

      CREATE TABLE IF NOT EXISTS integration_node_embeddings (
          node_kind TEXT NOT NULL,
          node_id TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          content_fingerprint TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (node_kind, node_id, embedding_model)
      );

      CREATE INDEX IF NOT EXISTS idx_integration_node_embeddings_tree_updated
          ON integration_node_embeddings (tree_id, embedding_model, updated_at DESC);


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
    this.ensureIntegrationTreesTableSchema(db);
    this.ensureIntegrationLeavesTableSchema(db);
    this.ensureSemanticMemoryTableSchema({ db, workspaceScoped: false });
    this.ensureSemanticMemorySearchTableSchema({ db, workspaceScoped: false });
    if (this.#vectorIndexSupported) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS integration_node_embedding_vec USING vec0(
            vec_rowid INTEGER PRIMARY KEY,
            embedding float[1536],
            tree_id TEXT,
            node_kind TEXT,
            embedding_model TEXT
        );
      `);
    }
    const runtimeUserProfileColumns = new Set<string>(
      (
        db.prepare("PRAGMA table_info(runtime_user_profiles)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (!runtimeUserProfileColumns.has("timezone")) {
      db.exec("ALTER TABLE runtime_user_profiles ADD COLUMN timezone TEXT;");
    }
    this.migrateIntegrationConnectionIdentityColumns(db);
    // integration_bindings lives in the control-plane DB, so its FK-drop
    // migration MUST run on this connection — the copy in ensureRuntimeDbSchema
    // only ever sees data.db (no integration_bindings there) and is a silent
    // no-op. Without this call, pre-existing control-plane DBs kept the old FK
    // and binding a Composio (ca_…) account failed with "FOREIGN KEY constraint
    // failed".
    this.migrateDropIntegrationBindingsFk(db);
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
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'main_session',
          title TEXT,
          parent_session_id TEXT,
          source_proposal_id TEXT,
          created_by TEXT,
          workflow_run_id TEXT,
          project_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          active_user_question TEXT,
          PRIMARY KEY (session_id),
          UNIQUE (source_proposal_id)
      );

      CREATE TABLE IF NOT EXISTS projects (
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          project_path TEXT NOT NULL,
          icon TEXT,
          icon_color TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_projects_updated
          ON projects (updated_at DESC, created_at DESC);
      -- idx_agent_sessions_workflow_run is created by migration 008 only.
      -- Putting it here would fail against legacy DBs whose agent_sessions
      -- table predates the workflow_run_id column (CREATE INDEX evaluates
      -- the column at definition time; the ALTER lives in the migration).

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_updated
          ON agent_sessions (updated_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          harness_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id),
          UNIQUE (harness, harness_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runtime_sessions_workspace_updated
          ON agent_runtime_sessions (updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_bindings (
          binding_id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'main_session',
          is_active INTEGER NOT NULL DEFAULT 1,
          metadata TEXT NOT NULL DEFAULT '{}',
          last_active_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (channel, conversation_key, role),
          UNIQUE (session_id)
      );

      CREATE TABLE IF NOT EXISTS agent_session_inputs (
          input_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
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
          ON agent_session_inputs (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_session_inputs_session_status
          ON agent_session_inputs (session_id, status, available_at);

      CREATE TABLE IF NOT EXISTS post_run_jobs (
          job_id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          input_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
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
          ON post_run_jobs (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_post_run_jobs_session_status
          ON post_run_jobs (session_id, status, available_at);

      CREATE TABLE IF NOT EXISTS main_session_event_queue (
          event_id TEXT PRIMARY KEY,
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

      CREATE TABLE IF NOT EXISTS session_runtime_state (
          session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${SESSION_RUNTIME_STATE_STATUS_SQL})),
          current_input_id TEXT,
          current_worker_id TEXT,
          lease_until TEXT,
          heartbeat_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id)
      );

      CREATE INDEX IF NOT EXISTS session_runtime_state_main_session_idx
          ON session_runtime_state (session_id);

      CREATE INDEX IF NOT EXISTS session_runtime_state_session_id_idx
          ON session_runtime_state (session_id);

      CREATE TABLE IF NOT EXISTS session_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_main_session_created
          ON session_messages (session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS session_output_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_output_events_session_input_sequence
          ON session_output_events (session_id, input_id, sequence ASC);

      CREATE INDEX IF NOT EXISTS idx_session_output_events_main_session_created
          ON session_output_events (session_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_session_output_events_session_id
          ON session_output_events (session_id, id ASC);

      CREATE TABLE IF NOT EXISTS terminal_sessions (
          terminal_id TEXT PRIMARY KEY,
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
          ON terminal_sessions (status, last_activity_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_session_created
          ON terminal_sessions (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS terminal_session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          terminal_id TEXT NOT NULL,
          session_id TEXT,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_session_events_terminal_sequence
          ON terminal_session_events (terminal_id, sequence ASC);

      CREATE INDEX IF NOT EXISTS idx_terminal_session_events_workspace_created
          ON terminal_session_events (created_at ASC);

      CREATE TABLE IF NOT EXISTS turn_results (
          input_id TEXT PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS idx_turn_results_main_session_completed
          ON turn_results (session_id, completed_at DESC, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_turn_results_session_input
          ON turn_results (session_id, input_id);

      CREATE TABLE IF NOT EXISTS subagent_runs (
          subagent_id TEXT PRIMARY KEY,
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
          issue_id TEXT,
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
          workflow_run_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (child_session_id)
      );
      -- idx_subagent_runs_workflow_run is created by migration 008 only.
      -- See the matching comment on agent_sessions above.

      CREATE TABLE IF NOT EXISTS issues (
          issue_id TEXT PRIMARY KEY,
          issue_number INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          parent_issue_id TEXT,
          source_type TEXT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          priority TEXT,
          assignee_id TEXT,
          blocked_by_json TEXT NOT NULL DEFAULT '[]',
          blocker_reason TEXT,
          attachment_payloads TEXT NOT NULL DEFAULT '[]',
          active_subagent_id TEXT,
          latest_subagent_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE (issue_number),
          UNIQUE (session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_issues_workspace_status_updated
          ON issues (status, updated_at DESC, issue_number DESC);

      CREATE INDEX IF NOT EXISTS idx_issues_workspace_assignee_status_updated
          ON issues (assignee_id, status, updated_at DESC, issue_number DESC);

      CREATE TABLE IF NOT EXISTS memory_update_proposals (
          proposal_id TEXT PRIMARY KEY,
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

      CREATE TABLE IF NOT EXISTS interaction_entities (
          entity_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          canonical_name TEXT NOT NULL,
          slug TEXT NOT NULL,
          summary TEXT,
          aliases TEXT NOT NULL DEFAULT '[]',
          is_system INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (entity_id),
          UNIQUE (slug)
      );

      CREATE INDEX IF NOT EXISTS idx_interaction_entities_workspace_status_updated
          ON interaction_entities (status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_interaction_entities_workspace_slug
          ON interaction_entities (slug);

      CREATE TABLE IF NOT EXISTS interaction_leaves (
          leaf_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          secondary_entity_ids TEXT NOT NULL DEFAULT '[]',
          source_type TEXT,
          source_event_id TEXT,
          source_message_id TEXT,
          source_turn_input_id TEXT,
          admission_confidence REAL,
          entity_confidence REAL,
          observed_at TEXT,
          supersedes_leaf_id TEXT,
          superseded_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (leaf_id),
          UNIQUE (path)
      );

      CREATE INDEX IF NOT EXISTS idx_interaction_leaves_workspace_entity_status_observed
          ON interaction_leaves (entity_id, status, observed_at DESC, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_interaction_leaves_workspace_entity_subject
          ON interaction_leaves (entity_id, subject_key, status, updated_at DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_interaction_leaves_workspace_entity_fingerprint
          ON interaction_leaves (entity_id, fingerprint);

      CREATE TABLE IF NOT EXISTS interaction_node_embeddings (
          node_kind TEXT NOT NULL,
          node_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          content_fingerprint TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (node_kind, node_id, embedding_model)
      );

      CREATE INDEX IF NOT EXISTS idx_interaction_node_embeddings_workspace_entity_updated
          ON interaction_node_embeddings (entity_id, embedding_model, updated_at DESC);

      -- workspace-removal Piece 5.7: the integration knowledge graph
      -- (integration_trees / integration_leaves / integration_node_embeddings) is
      -- account-global and now lives ONLY in the control-plane DB
      -- (ensureControlPlaneDbSchema). The former per-workspace/root variant of
      -- these tables is intentionally NOT created here; migration 030 drops any
      -- pre-existing copy from per-workspace/root DBs (a clean drop — those rows
      -- are derived/rebuildable and intentionally not preserved).

      CREATE TABLE IF NOT EXISTS output_folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_output_folders_workspace_position
          ON output_folders (position ASC, created_at ASC);

      CREATE TABLE IF NOT EXISTS outputs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
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
      -- idx_outputs_project_created is created by migration 013 only.
      -- Putting it here would fail against legacy DBs whose outputs
      -- table predates the project_id column (CREATE INDEX evaluates
      -- the column at definition time; the ALTER lives in the migration).

      CREATE VIRTUAL TABLE IF NOT EXISTS outputs_fts USING fts5(
          id UNINDEXED,
          output_type UNINDEXED,
          module_id UNINDEXED,
          status UNINDEXED,
          produced_by_teammate_id UNINDEXED,
          produced_by_plugin_id UNINDEXED,
          created_at UNINDEXED,
          title,
          file_path,
          body_text,
          tokenize = 'unicode61 remove_diacritics 2'
      );


      CREATE TABLE IF NOT EXISTS app_builds (
          app_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          restart_attempts INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (app_id)
      );

      CREATE TABLE IF NOT EXISTS app_ports (
          app_id TEXT NOT NULL,
          port INTEGER NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (app_id)
      );

      CREATE TABLE IF NOT EXISTS cronjobs (
          id TEXT PRIMARY KEY,
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
          ON cronjobs (created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_cronjobs_enabled_next_run
          ON cronjobs (enabled, next_run_at);


      CREATE TABLE IF NOT EXISTS runtime_notifications (
          id TEXT PRIMARY KEY,
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
          ON runtime_notifications (state, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_runtime_notifications_state_created
          ON runtime_notifications (state, created_at DESC);
    `);
    this.ensureMemoryEntriesTableSchema(db);
    this.ensureMemoryEmbeddingIndexSchema(db);
    this.ensureSessionMessagesTableSchema(db);
    this.ensureConversationBindingsTableSchema(db);
    // workspace-removal Piece 5.7: integration_trees / integration_leaves no
    // longer exist in per-workspace/root DBs (control-plane-only), so their
    // column reconcilers are not invoked here — they run only in
    // ensureControlPlaneDbSchema. Migration 030 drops any pre-existing copy.
    this.ensureSemanticMemoryTableSchema({ db, workspaceScoped: true });
    this.runBestEffortMigration("migrate-legacy-session-kinds", () =>
      this.migrateLegacySessionKinds(db),
    );
    this.ensureAgentSessionsActiveUserQuestionColumn(db);
    this.ensureSemanticMemorySearchTableSchema({ db, workspaceScoped: true });
    if (this.#vectorIndexSupported) {
      // workspace-removal Piece 5.7: integration_node_embedding_vec (the vec0
      // shadow of integration_node_embeddings) is NOT created here — the
      // integration embedding graph is control-plane-only now, so its vec index
      // lives only in ensureControlPlaneDbSchema. Migration 030 drops any
      // pre-existing copy from per-workspace/root DBs. interaction_node_embedding_vec
      // stays: interaction embeddings remain workspace-scoped.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS interaction_node_embedding_vec USING vec0(
            vec_rowid INTEGER PRIMARY KEY,
            embedding float[1536],
            entity_id TEXT,
            node_kind TEXT,
            embedding_model TEXT
        );
      `);
    }
    this.ensureIssuesTableSchema(db);
    this.ensureSubagentRunsTableSchema(db);
    this.ensureSessionRuntimeStateTableSchema(db);
    this.ensureTurnArtifactsSchema(db);
    this.ensureMemoryUpdateProposalsTableSchema(db);
    this.ensureOutputsTableSchema(db);
    this.migrateRuntimeNotificationPriority(db);
    this.migrateCronjobInstructions(db);
    this.migrateAppBuildRestartAttempts(db);
  }

  private ensureRuntimeDbSchema(db: Database.Database): void {
    // Piece 5.11: no `ensureWorkspacesTableSchema` — the workspaces table is not
    // created (single-tenant synthetic root; former workspaces are projects).
    this.migrateRevertIntegrationConnectionsWorkspace(db);
    this.migrateDropIntegrationBindingsFk(db);
    this.migrateIntegrationConnectionIdentityColumns(db);
    // Piece 5.11: the `workspaces` registry table is no longer created. The
    // runtime is single-tenant — one synthetic root workspace — and former
    // workspaces live as `projects`. A pre-existing table is dropped by the
    // consolidation once its rows are folded (see consolidateWorkspaceRuntimeDbsIntoRoot).
    this.ensureSessionMessagesTableSchema(db);
  }

  private ensureSessionMessagesTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!tableNames.has("session_messages")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    if (!columns.has("metadata")) {
      db.exec("ALTER TABLE session_messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';");
    }
  }

  private ensureIntegrationLeavesTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tableNames.has("integration_leaves")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(integration_leaves)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("entity_key")) {
      db.exec("ALTER TABLE integration_leaves ADD COLUMN entity_key TEXT;");
    }
    if (!columns.has("entity_label")) {
      db.exec("ALTER TABLE integration_leaves ADD COLUMN entity_label TEXT;");
    }
    if (!columns.has("branch_key")) {
      db.exec("ALTER TABLE integration_leaves ADD COLUMN branch_key TEXT;");
    }
    if (!columns.has("branch_label")) {
      db.exec("ALTER TABLE integration_leaves ADD COLUMN branch_label TEXT;");
    }
  }

  private ensureIntegrationTreesTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tableNames.has("integration_trees")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(integration_trees)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("owner_user_id")) {
      db.exec("ALTER TABLE integration_trees ADD COLUMN owner_user_id TEXT;");
    }
    if (!columns.has("account_namespace")) {
      db.exec("ALTER TABLE integration_trees ADD COLUMN account_namespace TEXT;");
    }
    if (!columns.has("account_key")) {
      db.exec("ALTER TABLE integration_trees ADD COLUMN account_key TEXT;");
    }
    if (columns.has("account_id") && !columns.has("account_key")) {
      db.exec("UPDATE integration_trees SET account_key = account_id WHERE account_key IS NULL;");
    }
    if (columns.has("account_key")) {
      db.exec(`
        UPDATE integration_trees
        SET account_namespace = account_key
        WHERE (account_namespace IS NULL OR account_namespace = '')
          AND account_key IS NOT NULL
          AND account_key != ''
      `);
    }
    if (columns.has("account_id")) {
      db.exec(`
        UPDATE integration_trees
        SET account_namespace = account_id
        WHERE (account_namespace IS NULL OR account_namespace = '')
          AND account_id IS NOT NULL
          AND account_id != ''
      `);
      db.exec(`
        UPDATE integration_trees
        SET account_key = account_id
        WHERE (account_key IS NULL OR account_key = '')
          AND account_id IS NOT NULL
          AND account_id != ''
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_integration_trees_provider_namespace_updated
          ON integration_trees (provider, account_namespace, updated_at DESC, created_at DESC);
    `);
    if (columns.has("workspace_id")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_integration_trees_workspace_provider_namespace
            ON integration_trees (workspace_id, provider, account_namespace);
      `);
    }
  }

  private ensureSemanticMemoryTableSchema(params: {
    db: Database.Database;
    workspaceScoped: boolean;
  }): void {
    const prefix = params.workspaceScoped
      ? `
          workspace_id TEXT NOT NULL,
      `
      : "";
    const workspaceIdPrefix = params.workspaceScoped ? "workspace_id, " : "";
    const workspaceUniquePrefix = params.workspaceScoped ? "workspace_id, " : "";
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_nodes (
          ${prefix}category TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_class TEXT NOT NULL,
          node_kind TEXT NOT NULL,
          source_leaf_id TEXT,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          child_count INTEGER NOT NULL DEFAULT 0,
          observed_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          is_materialized INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (${workspaceIdPrefix}category, tree_id, node_id),
          UNIQUE (${workspaceUniquePrefix}category, path)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_nodes_tree_status_kind
          ON semantic_memory_nodes (${workspaceIdPrefix}category, tree_id, status, node_class, node_kind, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_nodes_tree_path
          ON semantic_memory_nodes (${workspaceIdPrefix}category, tree_id, path);

      -- Serves the per-tree candidate-pool lookup in listWorkspaceLexicalSupportHits,
      -- which issues ONE listSemanticMemoryNodes query per integration tree on every
      -- turn. Without this the planner picks the UNIQUE (workspace_id, category, path)
      -- autoindex -- it satisfies the ORDER BY path prefix, so it avoids a sort but
      -- then filters the whole table PER TREE. On a workspace with 603 trees / 69k
      -- nodes that measured 26s of synchronous CPU per turn; with this index, 62ms
      -- (424x, byte-identical result set + order). Column order matters: the five
      -- equality predicates lead, so each lookup is a seek.
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_nodes_tree_class_status_path
          ON semantic_memory_nodes (${workspaceIdPrefix}category, tree_id, node_class, status, path);

      CREATE TABLE IF NOT EXISTS semantic_memory_edges (
          ${prefix}category TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          parent_node_id TEXT NOT NULL,
          child_node_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (${workspaceIdPrefix}category, tree_id, parent_node_id, child_node_id),
          UNIQUE (${workspaceUniquePrefix}category, tree_id, parent_node_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_edges_parent_position
          ON semantic_memory_edges (${workspaceIdPrefix}category, tree_id, parent_node_id, position ASC);

      CREATE TABLE IF NOT EXISTS semantic_memory_relations (
          ${prefix}category TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (${workspaceIdPrefix}category, tree_id, from_node_id, to_node_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_relations_tree_from_type
          ON semantic_memory_relations (${workspaceIdPrefix}category, tree_id, from_node_id, relation_type, updated_at DESC);

      CREATE TABLE IF NOT EXISTS semantic_memory_evidence_refs (
          ${prefix}category TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          provider TEXT,
          account_namespace TEXT,
          connection_id TEXT,
          external_object_id TEXT,
          external_object_type TEXT,
          source_type TEXT,
          source_event_id TEXT,
          source_message_id TEXT,
          source_turn_input_id TEXT,
          observed_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (${workspaceIdPrefix}category, tree_id, node_id, ref_id)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_evidence_refs_node
          ON semantic_memory_evidence_refs (${workspaceIdPrefix}category, tree_id, node_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_evidence_refs_external_object
          ON semantic_memory_evidence_refs (${workspaceIdPrefix}category, tree_id, external_object_type, external_object_id);
    `);

    this.ensureSemanticMemoryPlannerStats(params.db);
  }

  /**
   * Creating idx_semantic_memory_nodes_tree_class_status_path is NOT sufficient on
   * an existing database: with no stats in sqlite_stat1 the planner keeps choosing
   * the UNIQUE (workspace_id, category, path) autoindex, because that one satisfies
   * the `ORDER BY path` prefix. Measured on a real 603-tree / 69k-node workspace:
   * index alone = no change at all (25.8s -> 25.5s), index + ANALYZE = 25.8s -> 70ms.
   *
   * So ANALYZE has to run once for the index to do anything. It is ~150ms on that
   * workspace, and we gate it on a marker row so it does not run on every open —
   * SQLite keeps sqlite_stat1 until the next ANALYZE, so once is enough.
   */
  private ensureSemanticMemoryPlannerStats(db: Database.Database): void {
    const hasNodesTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'semantic_memory_nodes' LIMIT 1",
      )
      .get();
    if (!hasNodesTable) {
      return;
    }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_memory_planner_stats (
            marker TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
      `);
      const alreadyAnalyzed = db
        .prepare("SELECT 1 FROM semantic_memory_planner_stats WHERE marker = ? LIMIT 1")
        .get(SEMANTIC_MEMORY_PLANNER_STATS_MARKER);
      if (alreadyAnalyzed) {
        return;
      }
      db.exec("ANALYZE semantic_memory_nodes");
      db.prepare(
        "INSERT OR REPLACE INTO semantic_memory_planner_stats (marker, applied_at) VALUES (?, ?)",
      ).run(SEMANTIC_MEMORY_PLANNER_STATS_MARKER, utcNowIso());
    } catch {
      // Best effort: stale stats only cost query speed, never correctness, and a
      // failure here must not block opening the store. The next open retries.
    }
  }

  private ensureSemanticMemorySearchTableSchema(params: {
    db: Database.Database;
    workspaceScoped: boolean;
  }): void {
    const prefix = params.workspaceScoped
      ? `
          workspace_id TEXT NOT NULL,
      `
      : "";
    const workspaceIdPrefix = params.workspaceScoped ? "workspace_id, " : "";
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_search_docs (
          ${prefix}category TEXT NOT NULL,
          tree_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_class TEXT NOT NULL,
          node_kind TEXT NOT NULL,
          path TEXT NOT NULL,
          child_count INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          body_text TEXT NOT NULL,
          excerpt TEXT,
          observed_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (${workspaceIdPrefix}category, tree_id, node_id)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_search_docs_tree_status
          ON semantic_memory_search_docs (${workspaceIdPrefix}category, tree_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_semantic_memory_search_docs_tree_kind
          ON semantic_memory_search_docs (${workspaceIdPrefix}category, tree_id, node_class, node_kind, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory_search_fts USING fts5(
          ${params.workspaceScoped ? "workspace_id UNINDEXED,\n" : ""}category UNINDEXED,
          tree_id UNINDEXED,
          node_id UNINDEXED,
          node_class UNINDEXED,
          node_kind UNINDEXED,
          path UNINDEXED,
          child_count UNINDEXED,
          title,
          summary,
          body_text,
          excerpt UNINDEXED,
          observed_at UNINDEXED,
          status UNINDEXED,
          updated_at UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
      );
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
          ON conversation_bindings (role, is_active, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_channel_key_active
          ON conversation_bindings (channel, conversation_key, is_active);
    `);
  }

  /**
   * Run a best-effort, idempotent data-normalization migration. Unlike the
   * structural schema setup (CREATE TABLE/INDEX/ALTER), these rewrite existing
   * row VALUES and so can trip over unforeseen real-world data shapes. A failure
   * here must NEVER abort schema setup and crash-loop the runtime on a blank,
   * never-loading screen — as a conversation_bindings UNIQUE collision in
   * migrate-legacy-session-kinds once did, taking the desktop app (and its
   * diagnostics export) down with it. Log it loudly and continue with the
   * un-normalized rows; a later fixed release can re-run the (idempotent) step.
   */
  private runBestEffortMigration(label: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.warn(
        `[runtime-state-store] best-effort migration "${label}" failed; continuing with un-normalized data:`,
        err,
      );
    }
  }

  private migrateLegacySessionKinds(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const now = utcNowIso();
    const migrate = db.transaction(() => {
      if (tableNames.has("agent_sessions")) {
        db.prepare(
          `
            UPDATE agent_sessions
            SET kind = CASE
                    WHEN lower(kind) IN ('workspace_session', 'main') THEN ?
                    WHEN lower(kind) = 'task_proposal' THEN ?
                    ELSE kind
                END,
                updated_at = ?
            WHERE lower(kind) IN ('workspace_session', 'main', 'task_proposal')
          `,
        ).run(MAIN_SESSION_KIND, SUBAGENT_SESSION_KIND, now);
      }
      if (tableNames.has("conversation_bindings")) {
        // Every legacy 'main' binding (and any already-canonical one) normalizes
        // onto the SAME (channel, conversation_key, role) tuple below. The table
        // enforces UNIQUE(channel, conversation_key, role), so a blind rewrite
        // collides the moment one channel carries more than one such binding —
        // exactly what the workspace-removal fold produces by merging each former
        // workspace's main binding into the single root data.db. That collision
        // used to throw here, abort schema setup, and crash-loop the runtime on
        // open (leaving the desktop app on a blank, never-loading screen). Collapse
        // to a single main binding per channel first — keep the most authoritative
        // candidate, drop the redundant rest — THEN normalize the survivors.
        type MainBindingCandidate = {
          binding_id: string;
          channel: string;
          role: string;
          conversation_key: string;
          is_active: number;
          recency: string | null;
        };
        const candidates = db
          .prepare(
            `
              SELECT binding_id, channel, role, conversation_key, is_active,
                     COALESCE(last_active_at, updated_at, created_at) AS recency
              FROM conversation_bindings
              WHERE lower(role) = 'main'
                 OR lower(conversation_key) = lower(?)
            `,
          )
          .all(MAIN_SESSION_CONVERSATION_KEY) as MainBindingCandidate[];
        const isCanonical = (row: MainBindingCandidate): boolean =>
          row.role === MAIN_SESSION_BINDING_ROLE &&
          row.conversation_key === MAIN_SESSION_CONVERSATION_KEY;
        // Keep the most authoritative main binding per channel: an already-canonical
        // row first (never disturb a healthy current binding), then active over
        // inactive, then most-recently-active, with binding_id as a stable final
        // tie-break so the choice is deterministic across re-runs.
        const beats = (
          candidate: MainBindingCandidate,
          incumbent: MainBindingCandidate,
        ): boolean => {
          const candidateCanonical = isCanonical(candidate);
          const incumbentCanonical = isCanonical(incumbent);
          if (candidateCanonical !== incumbentCanonical) {
            return candidateCanonical;
          }
          if (candidate.is_active !== incumbent.is_active) {
            return candidate.is_active > incumbent.is_active;
          }
          const candidateRecency = candidate.recency ?? "";
          const incumbentRecency = incumbent.recency ?? "";
          if (candidateRecency !== incumbentRecency) {
            return candidateRecency > incumbentRecency;
          }
          return candidate.binding_id < incumbent.binding_id;
        };
        const winnerByChannel = new Map<string, MainBindingCandidate>();
        const redundantBindingIds: string[] = [];
        for (const candidate of candidates) {
          const incumbent = winnerByChannel.get(candidate.channel);
          if (!incumbent) {
            winnerByChannel.set(candidate.channel, candidate);
            continue;
          }
          if (beats(candidate, incumbent)) {
            redundantBindingIds.push(incumbent.binding_id);
            winnerByChannel.set(candidate.channel, candidate);
          } else {
            redundantBindingIds.push(candidate.binding_id);
          }
        }
        if (redundantBindingIds.length > 0) {
          const deleteBinding = db.prepare(
            "DELETE FROM conversation_bindings WHERE binding_id = ?",
          );
          for (const bindingId of redundantBindingIds) {
            deleteBinding.run(bindingId);
          }
        }
        // Exactly one main candidate per channel survives now, so normalizing the
        // survivors onto the canonical tuple can no longer violate the constraint.
        db.prepare(
          `
            UPDATE conversation_bindings
            SET role = ?,
                conversation_key = ?,
                updated_at = ?
            WHERE lower(role) = 'main'
               OR lower(conversation_key) = lower(?)
          `,
        ).run(
          MAIN_SESSION_BINDING_ROLE,
          MAIN_SESSION_CONVERSATION_KEY,
          now,
          MAIN_SESSION_CONVERSATION_KEY,
        );
      }
    });
    migrate();
  }

  private ensureAgentSessionsActiveUserQuestionColumn(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tableNames.has("agent_sessions")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("active_user_question")) {
      db.exec("ALTER TABLE agent_sessions ADD COLUMN active_user_question TEXT;");
    }
  }

  private ensureIssuesTableSchema(db: Database.Database): void {
    const tableNames = new Set<string>(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tableNames.has("issues")) {
      return;
    }
    const columns = new Set<string>(
      (db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("parent_issue_id")) {
      db.exec("ALTER TABLE issues ADD COLUMN parent_issue_id TEXT;");
    }
    if (!columns.has("source_type")) {
      db.exec("ALTER TABLE issues ADD COLUMN source_type TEXT;");
    }
    if (!columns.has("blocked_by_json")) {
      db.exec("ALTER TABLE issues ADD COLUMN blocked_by_json TEXT NOT NULL DEFAULT '[]';");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_workspace_status_updated
          ON issues (status, updated_at DESC, issue_number DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_workspace_assignee_status_updated
          ON issues (assignee_id, status, updated_at DESC, issue_number DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_workspace_parent_updated
          ON issues (parent_issue_id, updated_at DESC, issue_number DESC);
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
    if (!columns.has("issue_id")) {
      db.exec("ALTER TABLE subagent_runs ADD COLUMN issue_id TEXT;");
    }
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
          ON subagent_runs (status, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_owner_status_updated
          ON subagent_runs (owner_main_session_id, status, updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_origin_created
          ON subagent_runs (origin_main_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_retry_created
          ON subagent_runs (retry_of_subagent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_issue_created
          ON subagent_runs (issue_id, created_at DESC);
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
          ON main_session_event_queue (status, created_at ASC);
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
          session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${SESSION_RUNTIME_STATE_STATUS_SQL})),
          current_input_id TEXT,
          current_worker_id TEXT,
          lease_until TEXT,
          heartbeat_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id)
      );

      INSERT INTO session_runtime_state (
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

      CREATE INDEX IF NOT EXISTS session_runtime_state_main_session_idx
          ON session_runtime_state (session_id);

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

  // integration_bindings originally FK'd connection_id → integration_connections.
  // Under Stage 3, Composio accounts (ca_…) are the source of truth and live
  // remote-only — they have no local integration_connections row — so binding one
  // failed at the DB layer with "FOREIGN KEY constraint failed". Drop the FK by
  // rebuilding the table (SQLite can't drop a constraint in place). One-time per
  // DB: a no-op once the table carries no connection_id FK. Safe to rebuild —
  // integration_bindings is a leaf (nothing FK-references it) and the copy is
  // wrapped in a transaction for atomicity.
  private migrateDropIntegrationBindingsFk(db: Database.Database): void {
    const hasConnectionFk = (
      db
        .prepare("PRAGMA foreign_key_list(integration_bindings)")
        .all() as Array<{ table: string }>
    ).some((fk) => fk.table === "integration_connections");
    if (!hasConnectionFk) {
      return;
    }
    db.transaction(() => {
      db.exec(`
        CREATE TABLE integration_bindings_new (
            binding_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            integration_key TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (workspace_id, target_type, target_id, integration_key)
        );
        INSERT INTO integration_bindings_new
            (binding_id, workspace_id, target_type, target_id, integration_key,
             connection_id, is_default, created_at, updated_at)
          SELECT binding_id, workspace_id, target_type, target_id, integration_key,
                 connection_id, is_default, created_at, updated_at
            FROM integration_bindings;
        DROP TABLE integration_bindings;
        ALTER TABLE integration_bindings_new RENAME TO integration_bindings;
        CREATE INDEX IF NOT EXISTS idx_integration_bindings_workspace_updated
            ON integration_bindings (workspace_id, is_default DESC, updated_at DESC, created_at DESC);
      `);
    })();
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
    if (!columns.has("context_cron_auto_fetch_enabled")) {
      db.exec("ALTER TABLE integration_connections ADD COLUMN context_cron_auto_fetch_enabled INTEGER NOT NULL DEFAULT 1;");
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
          id, output_type, title, status, module_id, module_resource_id, file_path,
          html_content, session_id, input_id, artifact_id, folder_id, platform, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_workspace_created
          ON memory_update_proposals (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_session_input_created
          ON memory_update_proposals (session_id, input_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_update_proposals_workspace_state_created
          ON memory_update_proposals (state, created_at DESC);
    `);
  }

  private rebuildTurnResultsWithoutLegacyColumns(db: Database.Database): void {
    db.exec(`
      ALTER TABLE turn_results RENAME TO turn_results_legacy_with_removed_columns;

      CREATE TABLE turn_results (
          input_id TEXT PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS idx_turn_results_main_session_completed
          ON turn_results (session_id, completed_at DESC, started_at DESC);

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
          session_id TEXT NOT NULL,
          snapshot_kind TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_request_snapshots_main_session_updated
          ON turn_request_snapshots (session_id, updated_at DESC, created_at DESC);
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
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_outputs_workspace_created
          ON outputs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outputs_workspace_folder_created
          ON outputs (folder_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outputs_session_input_created
          ON outputs (session_id, input_id, created_at DESC);
    `);
    this.backfillOutputsFts(db);
  }

  private backfillOutputsFts(db: Database.Database): void {
    const ftsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outputs_fts'",
      )
      .get();
    if (!ftsExists) {
      return;
    }
    const indexed = db
      .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM outputs_fts")
      .get();
    if ((indexed?.total ?? 0) > 0) {
      return;
    }
    const rows = db
      .prepare<[], Record<string, unknown>>("SELECT * FROM outputs")
      .all();
    if (rows.length === 0) {
      return;
    }
    const populate = db.transaction(() => {
      for (const row of rows) {
        // workspaceId is immaterial here: outputs_fts no longer stores it and
        // this only rebuilds the FTS index from the (per-workspace) outputs.
        const record = this.rowToOutput(row, "");
        this.syncOutputFtsRow(db, {
          id: record.id,
          outputType: record.outputType,
          moduleId: record.moduleId,
          status: record.status,
          title: record.title,
          filePath: record.filePath,
          htmlContent: record.htmlContent,
          metadata: record.metadata,
          createdAt: record.createdAt,
        });
      }
    });
    populate();
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
      onboardingState: row.onboarding_state == null ? null : String(row.onboarding_state),
      onboardingSessionId: row.onboarding_session_id == null ? null : String(row.onboarding_session_id),
      onboardingAlignmentQuestion:
        row.onboarding_alignment_question == null ? null : String(row.onboarding_alignment_question),
      onboardingAlignmentReport:
        row.onboarding_alignment_report == null ? null : String(row.onboarding_alignment_report),
      onboardingVerificationReport:
        row.onboarding_verification_report == null ? null : String(row.onboarding_verification_report),
      onboardingCompletedAt: row.onboarding_completed_at == null ? null : String(row.onboarding_completed_at),
      onboardingCompletionSummary:
        row.onboarding_completion_summary == null ? null : String(row.onboarding_completion_summary),
      onboardingRequestedAt: row.onboarding_requested_at == null ? null : String(row.onboarding_requested_at),
      onboardingRequestedBy: row.onboarding_requested_by == null ? null : String(row.onboarding_requested_by),
      createdAt: row.created_at == null ? null : String(row.created_at),
      updatedAt: row.updated_at == null ? null : String(row.updated_at),
      deletedAtUtc: row.deleted_at_utc == null ? null : String(row.deleted_at_utc),
      icon: row.icon == null ? null : String(row.icon),
      iconColor: row.icon_color == null ? null : String(row.icon_color),
      workspaceRole: row.workspace_role == null ? "source" : String(row.workspace_role),
      sourceWorkspaceId: row.source_workspace_id == null ? null : String(row.source_workspace_id),
      labPurpose: row.lab_purpose == null ? null : String(row.lab_purpose),
      labStatus: row.lab_status == null ? null : String(row.lab_status)
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
      onboardingState: data.onboarding_state == null ? null : String(data.onboarding_state),
      onboardingSessionId: data.onboarding_session_id == null ? null : String(data.onboarding_session_id),
      onboardingAlignmentQuestion:
        data.onboarding_alignment_question == null ? null : String(data.onboarding_alignment_question),
      onboardingAlignmentReport:
        data.onboarding_alignment_report == null ? null : String(data.onboarding_alignment_report),
      onboardingVerificationReport:
        data.onboarding_verification_report == null ? null : String(data.onboarding_verification_report),
      onboardingCompletedAt: data.onboarding_completed_at == null ? null : String(data.onboarding_completed_at),
      onboardingCompletionSummary:
        data.onboarding_completion_summary == null ? null : String(data.onboarding_completion_summary),
      onboardingRequestedAt: data.onboarding_requested_at == null ? null : String(data.onboarding_requested_at),
      onboardingRequestedBy: data.onboarding_requested_by == null ? null : String(data.onboarding_requested_by),
      createdAt: data.created_at == null ? null : String(data.created_at),
      updatedAt: data.updated_at == null ? null : String(data.updated_at),
      deletedAtUtc: data.deleted_at_utc == null ? null : String(data.deleted_at_utc),
      icon: data.icon == null ? null : String(data.icon),
      iconColor: data.icon_color == null ? null : String(data.icon_color),
      workspaceRole: data.workspace_role == null ? "source" : String(data.workspace_role),
      sourceWorkspaceId: data.source_workspace_id == null ? null : String(data.source_workspace_id),
      labPurpose: data.lab_purpose == null ? null : String(data.lab_purpose),
      labStatus: data.lab_status == null ? null : String(data.lab_status)
    };
  }

  private workspacePathFromRegistry(workspaceId: string): string | null {
    // The synthetic root has no registry row — its path is config-derived.
    if (workspaceId === ROOT_WORKSPACE_ID) {
      return this.rootWorkspacePath();
    }
    if (!this.workspacesTableExists()) {
      return null;
    }
    const row = this.controlPlaneDb()
      .prepare<[string], { workspace_path: string | null }>("SELECT workspace_path FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId);
    if (!row || row.workspace_path == null) {
      return null;
    }
    const value = row.workspace_path.trim();
    return value || null;
  }

  private writeWorkspaceIdentityFile(workspacePath: string, workspaceId: string): void {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const usesManagedWriteLock = this.isWithinManagedRoot(resolvedWorkspacePath);
    const maxAttempts = usesManagedWriteLock ? WORKSPACE_IDENTITY_WRITE_RETRY_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const tempPath = `${currentWorkspaceIdentityPath(resolvedWorkspacePath)}.${process.pid}.${attempt}.${randomUUID()}.tmp`;
      try {
        const writeOnce = () => {
          const stateDir = this.ensureWorkspaceIdentityStateDir(resolvedWorkspacePath);
          const identityPath = path.join(stateDir, WORKSPACE_IDENTITY_FILENAME);
          fs.writeFileSync(tempPath, `${workspaceId}\n`, "utf-8");
          fs.renameSync(tempPath, identityPath);
        };
        if (usesManagedWriteLock) {
          this.withManagedWorkspaceIdentityWriteLock(resolvedWorkspacePath, writeOnce);
        } else {
          writeOnce();
        }
        return;
      } catch (error) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup only.
        }
        const normalized = this.normalizeWorkspaceIdentityWriteError(resolvedWorkspacePath, error);
        if (
          attempt < maxAttempts &&
          this.shouldRetryWorkspaceIdentityWrite(resolvedWorkspacePath, normalized)
        ) {
          sleepSync(WORKSPACE_IDENTITY_WRITE_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw normalized;
      }
    }
  }

  private maybeWriteWorkspaceIdentityFile(workspacePath: string, workspaceId: string): void {
    if (this.workspacePathState(workspacePath) !== "healthy") {
      return;
    }
    this.writeWorkspaceIdentityFile(workspacePath, workspaceId);
  }

  private ensureWorkspaceIdentityStateDir(workspacePath: string): string {
    const resolvedWorkspacePath = this.assertWorkspacePathHealthy(workspacePath);
    const runtimeDir = path.join(resolvedWorkspacePath, WORKSPACE_RUNTIME_DIRNAME);
    const stateDir = path.join(runtimeDir, WORKSPACE_STATE_DIRNAME);
    this.ensureWorkspaceIdentityDir(runtimeDir, resolvedWorkspacePath);
    this.ensureWorkspaceIdentityDir(stateDir, resolvedWorkspacePath);
    return stateDir;
  }

  private ensureWorkspaceIdentityDir(dirPath: string, workspacePath: string): void {
    try {
      fs.mkdirSync(dirPath);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        try {
          if (fs.statSync(dirPath).isDirectory()) {
            return;
          }
        } catch {
          // Fall through to the normalized error below.
        }
      }
      throw this.normalizeWorkspaceIdentityWriteError(workspacePath, error);
    }
  }

  private withManagedWorkspaceIdentityWriteLock<T>(workspacePath: string, fn: () => T): T {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    if (!this.isWithinManagedRoot(resolvedWorkspacePath)) {
      return fn();
    }
    const stateDir = this.ensureWorkspaceIdentityStateDir(resolvedWorkspacePath);
    const lockPath = path.join(stateDir, WORKSPACE_IDENTITY_LOCK_FILENAME);
    for (let attempt = 1; attempt <= WORKSPACE_IDENTITY_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
        try {
          return fn();
        } finally {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // Best-effort cleanup only.
          }
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          if (this.tryClearStaleWorkspaceIdentityWriteLock(lockPath)) {
            continue;
          }
          if (attempt < WORKSPACE_IDENTITY_LOCK_RETRY_ATTEMPTS) {
            sleepSync(WORKSPACE_IDENTITY_LOCK_RETRY_DELAY_MS);
            continue;
          }
          throw createWorkspaceIdentityWriteError({
            workspacePath: resolvedWorkspacePath,
            detail: "workspace identity write lock remained busy after retries",
            code: "workspace_identity_write_busy",
            cause: error,
          });
        }
        throw this.normalizeWorkspaceIdentityWriteError(resolvedWorkspacePath, error);
      }
    }
    throw createWorkspaceIdentityWriteError({
      workspacePath: resolvedWorkspacePath,
      detail: "workspace identity write lock remained busy after retries",
      code: "workspace_identity_write_busy",
    });
  }

  private tryClearStaleWorkspaceIdentityWriteLock(lockPath: string): boolean {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs < WORKSPACE_IDENTITY_LOCK_STALE_MS) {
        return false;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return err.code === "ENOENT";
    }
    try {
      fs.rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private shouldRetryWorkspaceIdentityWrite(workspacePath: string, error: unknown): boolean {
    if (!this.isWithinManagedRoot(workspacePath)) {
      return false;
    }
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return ["ENOENT", "EBUSY", "EPERM", "workspace_folder_missing", "workspace_identity_write_busy"].includes(code);
  }

  private normalizeWorkspaceIdentityWriteError(
    workspacePath: string,
    error: unknown,
  ): RuntimeStateStoreWorkspaceError {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const existing = error as RuntimeStateStoreWorkspaceError;
    if (
      existing?.code === "workspace_folder_missing" ||
      existing?.code === "workspace_identity_write_busy" ||
      existing?.code === "workspace_identity_write_failed"
    ) {
      existing.workspacePath ??= resolvedWorkspacePath;
      return existing;
    }
    if (this.workspacePathState(resolvedWorkspacePath) !== "healthy") {
      return createWorkspaceFolderMissingError(resolvedWorkspacePath);
    }
    return createWorkspaceIdentityWriteError({
      workspacePath: resolvedWorkspacePath,
      detail: error instanceof Error ? error.message : String(error),
      cause: error,
    });
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
    // Piece 5.11: the workspaces registry is dropped once folded into projects.
    // The synthetic root resolves its path directly (rootWorkspacePath), so there
    // is nothing to reconcile here — skip when the table is gone rather than
    // `UPDATE` a dropped table.
    if (!this.workspacesTableExists()) {
      return;
    }
    this.controlPlaneDb().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(workspacePath, workspaceId);
    if (this.controlPlaneDbPath !== this.dbPath) {
      this.db().prepare("UPDATE workspaces SET workspace_path = ? WHERE id = ?").run(workspacePath, workspaceId);
    }
  }

  private defaultWorkspaceDir(workspaceId: string): string {
    return path.join(this.workspaceRoot, sanitizeWorkspaceId(workspaceId));
  }

  private rowToInput(
    row: Record<string, unknown> | undefined,
    workspaceId: string,
  ): SessionInputRecord | null {
    if (!row) {
      return null;
    }
    return {
      inputId: String(row.input_id),
      sessionId: String(row.session_id),
      workspaceId,
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

  private rowToPostRunJob(
    row: Record<string, unknown> | undefined,
    workspaceId: string,
  ): PostRunJobRecord | null {
    if (!row) {
      return null;
    }
    return {
      jobId: String(row.job_id),
      jobType: String(row.job_type),
      inputId: String(row.input_id),
      sessionId: String(row.session_id),
      workspaceId,
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

  private rowToRuntimeState(
    row: Record<string, unknown> | undefined,
    workspaceId: string,
  ): SessionRuntimeStateRecord {
    if (!row) {
      throw new Error("runtime state row not found");
    }
    return {
      workspaceId,
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

  private rowToTerminalSession(
    row: Record<string, unknown>,
    workspaceId: string,
  ): TerminalSessionRecord {
    const normalizedBackend = String(row.backend).trim().toLowerCase();
    const normalizedOwner = String(row.owner).trim().toLowerCase();
    const normalizedStatus = String(row.status).trim().toLowerCase();
    return {
      terminalId: String(row.terminal_id),
      workspaceId,
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

  private rowToTerminalSessionEvent(
    row: Record<string, unknown>,
    workspaceId: string,
  ): TerminalSessionEventRecord {
    return {
      id: Number(row.id),
      terminalId: String(row.terminal_id),
      workspaceId,
      sessionId: row.session_id == null ? null : String(row.session_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      payload: this.parseJsonDict(row.payload),
      createdAt: String(row.created_at),
    };
  }

  private rowToTurnResult(
    row: Record<string, unknown>,
    workspaceId: string,
  ): TurnResultRecord {
    return {
      workspaceId,
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

  private rowToTurnRequestSnapshot(
    row: Record<string, unknown>,
    workspaceId: string,
  ): TurnRequestSnapshotRecord {
    return {
      workspaceId,
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
      timezone: row.timezone == null ? null : String(row.timezone),
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

  private rowToInteractionEntity(
    row: Record<string, unknown>,
    workspaceId: string,
  ): InteractionEntityRecord {
    return {
      workspaceId,
      entityId: String(row.entity_id),
      entityType: String(row.entity_type) as InteractionEntityType,
      canonicalName: String(row.canonical_name),
      slug: String(row.slug),
      summary: row.summary == null ? null : String(row.summary),
      aliases: this.parseJsonList(row.aliases).filter((item): item is string => typeof item === "string"),
      isSystem: Number(row.is_system ?? 0) === 1,
      status: String(row.status) as InteractionEntityStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToInteractionLeaf(
    row: Record<string, unknown>,
    workspaceId: string,
  ): InteractionLeafRecord {
    return {
      workspaceId,
      leafId: String(row.leaf_id),
      entityId: String(row.entity_id),
      subjectKey: String(row.subject_key),
      path: String(row.path),
      title: String(row.title),
      summary: String(row.summary),
      fingerprint: String(row.fingerprint),
      bodySha256: String(row.body_sha256),
      tags: this.parseJsonList(row.tags).filter((item): item is string => typeof item === "string"),
      secondaryEntityIds: this.parseJsonList(row.secondary_entity_ids).filter(
        (item): item is string => typeof item === "string",
      ),
      sourceType: row.source_type == null ? null : String(row.source_type),
      sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
      sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
      sourceTurnInputId: row.source_turn_input_id == null ? null : String(row.source_turn_input_id),
      admissionConfidence: row.admission_confidence == null ? null : Number(row.admission_confidence),
      entityConfidence: row.entity_confidence == null ? null : Number(row.entity_confidence),
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      supersedesLeafId: row.supersedes_leaf_id == null ? null : String(row.supersedes_leaf_id),
      supersededAt: row.superseded_at == null ? null : String(row.superseded_at),
      status: String(row.status) as InteractionLeafStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToInteractionNodeEmbedding(
    row: Record<string, unknown>,
    workspaceId: string,
  ): InteractionNodeEmbeddingRecord {
    return {
      workspaceId,
      nodeKind: String(row.node_kind) as InteractionTreeChildKind,
      nodeId: String(row.node_id),
      entityId: String(row.entity_id),
      embeddingModel: String(row.embedding_model),
      contentFingerprint: String(row.content_fingerprint),
      dimensions: Number(row.dimensions),
      vector: this.parseJsonList(row.vector_json)
        .map((value) => (typeof value === "number" ? value : Number(value)))
        .filter((value) => Number.isFinite(value)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToIntegrationTree(row: Record<string, unknown>): IntegrationTreeRecord {
    const workspaceId = row.workspace_id == null ? null : String(row.workspace_id);
    const accountNamespace =
      row.account_namespace == null
        ? row.account_key == null
          ? String(row.account_id ?? "")
          : String(row.account_key)
        : String(row.account_namespace);
    const accountDisplayName = String(row.account_label);
    return {
      workspaceId,
      treeId: String(row.tree_id),
      provider: String(row.provider),
      ownerUserId: workspaceId ? "" : row.owner_user_id == null ? "" : String(row.owner_user_id),
      accountNamespace,
      accountDisplayName,
      accountKey: accountNamespace,
      accountLabel: accountDisplayName,
      slug: String(row.slug),
      summary: row.summary == null ? null : String(row.summary),
      status: String(row.status) as IntegrationTreeStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToIntegrationLeaf(row: Record<string, unknown>): IntegrationLeafRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      leafId: String(row.leaf_id),
      treeId: String(row.tree_id),
      subjectKey: String(row.subject_key),
      entityKey: row.entity_key == null ? null : String(row.entity_key),
      entityLabel: row.entity_label == null ? null : String(row.entity_label),
      branchKey: row.branch_key == null ? null : String(row.branch_key),
      branchLabel: row.branch_label == null ? null : String(row.branch_label),
      path: String(row.path),
      title: String(row.title),
      summary: String(row.summary),
      fingerprint: String(row.fingerprint),
      bodySha256: String(row.body_sha256),
      tags: this.parseJsonList(row.tags).filter((item): item is string => typeof item === "string"),
      sourceType: row.source_type == null ? null : String(row.source_type),
      sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
      sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
      externalObjectId: row.external_object_id == null ? null : String(row.external_object_id),
      externalObjectType: row.external_object_type == null ? null : String(row.external_object_type),
      admissionConfidence: row.admission_confidence == null ? null : Number(row.admission_confidence),
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      supersedesLeafId: row.supersedes_leaf_id == null ? null : String(row.supersedes_leaf_id),
      supersededAt: row.superseded_at == null ? null : String(row.superseded_at),
      status: String(row.status) as IntegrationLeafStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private listAllSemanticMemoryEdgesForTree(params: {
    category: SemanticMemoryCategory;
    workspaceId?: string | null;
    treeId: string;
  }): SemanticMemoryContainmentEdgeRecord[] {
    const scope = this.resolveSemanticMemoryScope(params.category, params.workspaceId);
    if (scope.workspaceId !== null) {
      const rows = scope.db
        .prepare<[string, string, string], Record<string, unknown>>(
          `
            SELECT *
            FROM semantic_memory_edges
            WHERE workspace_id = ? AND category = ? AND tree_id = ?
            ORDER BY parent_node_id ASC, position ASC, child_node_id ASC
          `,
        )
        .all(scope.workspaceId, params.category, params.treeId) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToSemanticMemoryContainmentEdge(row));
    }
    const rows = scope.db
      .prepare<[string, string], Record<string, unknown>>(
        `
          SELECT *
          FROM semantic_memory_edges
          WHERE category = ? AND tree_id = ?
          ORDER BY parent_node_id ASC, position ASC, child_node_id ASC
        `,
      )
      .all(params.category, params.treeId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSemanticMemoryContainmentEdge(row));
  }

  private semanticMemoryNodeMatches(
    existing: SemanticMemoryNodeRecord,
    desired: {
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
    },
  ): boolean {
    return existing.nodeClass === desired.nodeClass
      && existing.nodeKind === desired.nodeKind
      && existing.sourceLeafId === (desired.sourceLeafId ?? null)
      && existing.path === desired.path
      && existing.title === desired.title
      && existing.summary === desired.summary
      && existing.bodySha256 === desired.bodySha256
      && existing.childCount === (desired.childCount ?? 0)
      && existing.observedAt === (desired.observedAt ?? null)
      && existing.status === (desired.status ?? "active")
      && existing.isMaterialized === Boolean(desired.isMaterialized)
      && JSON.stringify(existing.metadata ?? {}) === JSON.stringify(desired.metadata ?? {});
  }

  private semanticMemoryEdgesMatch(
    existing: SemanticMemoryContainmentEdgeRecord[],
    desired: Array<{ childNodeId: string; position: number }>
  ): boolean {
    if (existing.length !== desired.length) {
      return false;
    }
    for (let index = 0; index < existing.length; index += 1) {
      if (existing[index]?.childNodeId !== desired[index]?.childNodeId) {
        return false;
      }
      if (existing[index]?.position !== desired[index]?.position) {
        return false;
      }
    }
    return true;
  }

  private semanticMemorySearchDocMatches(
    existing: SemanticMemorySearchDocRecord,
    desired: {
      nodeClass: SemanticMemoryNodeClass;
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: MemoryNodeStatus;
    },
  ): boolean {
    return existing.nodeClass === desired.nodeClass
      && existing.nodeKind === desired.nodeKind
      && existing.path === desired.path
      && existing.childCount === (desired.childCount ?? 0)
      && existing.title === desired.title
      && existing.summary === desired.summary
      && existing.bodyText === desired.bodyText
      && existing.excerpt === (desired.excerpt ?? null)
      && existing.observedAt === (desired.observedAt ?? null)
      && existing.status === (desired.status ?? "active");
  }

  private semanticMemoryRelationMatches(
    existing: SemanticMemoryRelationRecord,
    desired: {
      metadata?: Record<string, unknown> | null;
    },
  ): boolean {
    return JSON.stringify(existing.metadata ?? {}) === JSON.stringify(desired.metadata ?? {});
  }

  private rowToSemanticMemoryNode(row: Record<string, unknown>): SemanticMemoryNodeRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      category: String(row.category) as SemanticMemoryCategory,
      treeId: String(row.tree_id),
      nodeId: String(row.node_id),
      nodeClass: String(row.node_class) as SemanticMemoryNodeClass,
      nodeKind: String(row.node_kind),
      sourceLeafId: row.source_leaf_id == null ? null : String(row.source_leaf_id),
      path: String(row.path),
      title: String(row.title),
      summary: String(row.summary),
      bodySha256: String(row.body_sha256),
      childCount: Number(row.child_count ?? 0),
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      status: String(row.status) as MemoryNodeStatus,
      isMaterialized: Number(row.is_materialized ?? 0) !== 0,
      metadata: this.parseJsonDict(row.metadata),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToSemanticMemorySearchDoc(
    row: Record<string, unknown>,
  ): SemanticMemorySearchDocRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      category: String(row.category) as SemanticMemoryCategory,
      treeId: String(row.tree_id),
      nodeId: String(row.node_id),
      nodeClass: String(row.node_class) as SemanticMemoryNodeClass,
      nodeKind: String(row.node_kind),
      path: String(row.path),
      childCount: Number(row.child_count ?? 0),
      title: String(row.title),
      summary: String(row.summary),
      bodyText: String(row.body_text ?? ""),
      excerpt: row.excerpt == null ? null : String(row.excerpt),
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      status: String(row.status) as MemoryNodeStatus,
      updatedAt: String(row.updated_at),
    };
  }

  private rowToSemanticMemorySearchHit(
    row: Record<string, unknown>,
  ): SemanticMemorySearchHitRecord {
    return {
      ...this.rowToSemanticMemorySearchDoc(row),
      bm25Score: Number(row.bm25_score),
    };
  }

  private rowToSemanticMemoryContainmentEdge(
    row: Record<string, unknown>,
  ): SemanticMemoryContainmentEdgeRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      category: String(row.category) as SemanticMemoryCategory,
      treeId: String(row.tree_id),
      parentNodeId: String(row.parent_node_id),
      childNodeId: String(row.child_node_id),
      position: Number(row.position),
      createdAt: String(row.created_at),
    };
  }

  private rowToSemanticMemoryRelation(
    row: Record<string, unknown>,
  ): SemanticMemoryRelationRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      category: String(row.category) as SemanticMemoryCategory,
      treeId: String(row.tree_id),
      fromNodeId: String(row.from_node_id),
      toNodeId: String(row.to_node_id),
      relationType: String(row.relation_type),
      metadata: this.parseJsonDict(row.metadata),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToSemanticMemoryEvidenceRef(
    row: Record<string, unknown>,
  ): SemanticMemoryEvidenceRefRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      category: String(row.category) as SemanticMemoryCategory,
      treeId: String(row.tree_id),
      nodeId: String(row.node_id),
      refId: String(row.ref_id),
      provider: row.provider == null ? null : String(row.provider),
      accountNamespace:
        row.account_namespace == null ? null : String(row.account_namespace),
      connectionId: row.connection_id == null ? null : String(row.connection_id),
      externalObjectId:
        row.external_object_id == null ? null : String(row.external_object_id),
      externalObjectType:
        row.external_object_type == null
          ? null
          : String(row.external_object_type),
      sourceType: row.source_type == null ? null : String(row.source_type),
      sourceEventId:
        row.source_event_id == null ? null : String(row.source_event_id),
      sourceMessageId:
        row.source_message_id == null ? null : String(row.source_message_id),
      sourceTurnInputId:
        row.source_turn_input_id == null
          ? null
          : String(row.source_turn_input_id),
      observedAt: row.observed_at == null ? null : String(row.observed_at),
      metadata: this.parseJsonDict(row.metadata),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToIntegrationNodeEmbedding(row: Record<string, unknown>): IntegrationNodeEmbeddingRecord {
    return {
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      nodeKind: String(row.node_kind) as InteractionTreeChildKind,
      nodeId: String(row.node_id),
      treeId: String(row.tree_id),
      embeddingModel: String(row.embedding_model),
      contentFingerprint: String(row.content_fingerprint),
      dimensions: Number(row.dimensions),
      vector: this.parseJsonList(row.vector_json)
        .map((value) => (typeof value === "number" ? value : Number(value)))
        .filter((value) => Number.isFinite(value)),
      createdAt: String(row.created_at),
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
      contextCronAutoFetchEnabled:
        row.context_cron_auto_fetch_enabled === false
          ? false
          : Number(row.context_cron_auto_fetch_enabled ?? 1) !== 0,
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

  private rowToConversationBinding(
    row: Record<string, unknown>,
    workspaceId: string,
  ): ConversationBindingRecord {
    return {
      bindingId: String(row.binding_id),
      workspaceId,
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

  private rowToWorkspaceProject(
    row: Record<string, unknown>,
    workspaceId: string,
  ): WorkspaceProjectRecord {
    return {
      workspaceId,
      projectId: String(row.project_id),
      name: String(row.name),
      projectPath: String(row.project_path),
      icon: row.icon == null ? null : String(row.icon),
      iconColor: row.icon_color == null ? null : String(row.icon_color),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToAgentSession(
    row: Record<string, unknown>,
    workspaceId: string,
  ): AgentSessionRecord {
    return {
      workspaceId,
      sessionId: String(row.session_id),
      kind: this.normalizedSessionKind(String(row.kind)),
      title: row.title == null ? null : String(row.title),
      parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
      createdBy: row.created_by == null ? null : String(row.created_by),
      projectId: row.project_id == null ? null : String(row.project_id),
      harnessId: row.harness_id == null ? null : String(row.harness_id),
      owningAppId: row.owning_app_id == null ? null : String(row.owning_app_id),
      orgId: row.org_id == null ? null : String(row.org_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at == null ? null : String(row.archived_at),
      activeUserQuestion: row.active_user_question == null ? null : String(row.active_user_question)
    };
  }

  private rowToWorkspaceCapability(row: Record<string, unknown>): WorkspaceCapabilityRecord {
    return {
      workspaceId: String(row.workspace_id),
      capabilityId: String(row.capability_id),
      version: row.version == null ? null : String(row.version),
      name: String(row.name),
      description: row.description == null ? null : String(row.description),
      icon: row.icon == null ? null : String(row.icon),
      status: this.requiredWorkspaceCapabilityStatus(
        row.status == null ? null : String(row.status),
      ),
      installedSkillIds: parseJsonStringArray(row.installed_skill_ids),
      integrationStatus: parseJsonStringRecord(row.integration_status),
      config: this.parseJsonDict(row.config_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }


  private rowToIssue(
    row: Record<string, unknown>,
    workspaceId: string,
  ): IssueRecord {
    return {
      issueId: String(row.issue_id),
      workspaceId,
      issueNumber: Number(row.issue_number),
      sessionId: String(row.session_id),
      sourceType: row.source_type == null ? null : String(row.source_type),
      title: String(row.title),
      description: row.description == null ? null : String(row.description),
      status: this.requiredIssueStatus(row.status == null ? null : String(row.status)),
      priority: this.nullableIssuePriority(row.priority == null ? null : String(row.priority)),
      assigneeId: null,
      blockedBy: this.parseIssueBlockedBy(row.blocked_by_json),
      blockerReason: row.blocker_reason == null ? null : String(row.blocker_reason),
      attachments: this.parseIssueAttachments(row.attachment_payloads),
      activeSubagentId: row.active_subagent_id == null ? null : String(row.active_subagent_id),
      latestSubagentId: row.latest_subagent_id == null ? null : String(row.latest_subagent_id),
      createdBy: row.created_by == null ? null : String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    };
  }

  private rowToSubagentRun(
    row: Record<string, unknown>,
    workspaceId: string,
  ): SubagentRunRecord {
    return {
      subagentId: String(row.subagent_id),
      workspaceId,
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
      issueId: row.issue_id == null ? null : String(row.issue_id),
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
      workflowRunId: row.workflow_run_id == null ? null : String(row.workflow_run_id),
      createdAt: String(row.created_at),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToMainSessionEventQueue(
    row: Record<string, unknown>,
    workspaceId: string,
  ): MainSessionEventQueueRecord {
    return {
      eventId: String(row.event_id),
      workspaceId,
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

  private rowToOutputFolder(
    row: Record<string, unknown>,
    workspaceId: string,
  ): OutputFolderRecord {
    return {
      id: String(row.id),
      workspaceId,
      name: String(row.name),
      position: Number(row.position),
      createdAt: row.created_at == null ? null : String(row.created_at),
      updatedAt: row.updated_at == null ? null : String(row.updated_at)
    };
  }

  private rowToOutput(
    row: Record<string, unknown>,
    workspaceId: string,
  ): OutputRecord {
    return {
      id: String(row.id),
      workspaceId,
      projectId: row.project_id == null ? null : String(row.project_id),
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

  private rowToAppBuild(
    row: Record<string, unknown>,
    workspaceId: string,
  ): AppBuildRecord {
    return {
      workspaceId,
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

  private rowToCronjob(
    row: Record<string, unknown>,
    workspaceId: string,
  ): CronjobRecord {
    return {
      id: String(row.id),
      workspaceId,
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

  private rowToRuntimeNotification(
    row: Record<string, unknown>,
    workspaceId: string,
  ): RuntimeNotificationRecord {
    return {
      id: String(row.id),
      workspaceId,
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

  private rowToMemoryUpdateProposal(
    row: Record<string, unknown>,
    workspaceId: string,
  ): MemoryUpdateProposalRecord {
    return {
      proposalId: String(row.proposal_id),
      workspaceId,
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

  private parseJsonValue(raw: unknown): unknown {
    if (raw == null) {
      return null;
    }
    if (typeof raw === "object") {
      return raw;
    }
    try {
      return JSON.parse(String(raw));
    } catch {
      return raw;
    }
  }

  private parseIssueAttachments(raw: unknown): IssueAttachmentRecord[] {
    return this.parseJsonList(raw)
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const value = entry as Record<string, unknown>;
        const name = this.normalizedNullableText(typeof value.name === "string" ? value.name : null);
        const mimeType = this.normalizedNullableText(
          typeof value.mimeType === "string"
            ? value.mimeType
            : typeof value.mime_type === "string"
              ? value.mime_type
              : null,
        );
        const workspacePath = this.normalizedNullableText(
          typeof value.workspacePath === "string"
            ? value.workspacePath
            : typeof value.workspace_path === "string"
              ? value.workspace_path
              : null,
        );
        if (!name || !mimeType || !workspacePath) {
          return null;
        }
        const kindValue =
          value.kind === "image" || value.kind === "folder" || value.kind === "file"
            ? value.kind
            : mimeType.startsWith("image/")
              ? "image"
              : mimeType === "inode/directory"
                ? "folder"
                : "file";
        return {
          id:
            this.normalizedNullableText(
              typeof value.id === "string" ? value.id : null,
            ) ?? randomUUID(),
          kind: kindValue,
          name,
          mimeType,
          sizeBytes:
            typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
              ? value.sizeBytes
              : typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes)
                ? value.size_bytes
                : 0,
          workspacePath,
          createdAt:
            this.normalizedNullableText(
              typeof value.createdAt === "string"
                ? value.createdAt
                : typeof value.created_at === "string"
                  ? value.created_at
                  : null,
            ) ?? utcNowIso(),
        };
      })
      .filter((entry): entry is IssueAttachmentRecord => Boolean(entry));
  }

  private parseIssueBlockedBy(raw: unknown): IssueBlockedByRecord[] {
    return this.parseJsonList(raw)
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const value = entry as Record<string, unknown>;
        const taskId = this.normalizedNullableText(
          typeof value.taskId === "string"
            ? value.taskId
            : typeof value.task_id === "string"
              ? value.task_id
              : null,
        );
        if (!taskId) {
          return null;
        }
        return {
          taskId,
          relation:
            this.normalizedNullableText(
              typeof value.relation === "string" ? value.relation : null,
            ) ?? "input",
          instruction: this.normalizedNullableText(
            typeof value.instruction === "string" ? value.instruction : null,
          ),
        };
      })
      .filter((entry): entry is IssueBlockedByRecord => Boolean(entry));
  }

  private normalizedIssueAttachments(
    attachments:
      | Array<Partial<IssueAttachmentRecord> & {
          name: string;
          mimeType?: string;
          mime_type?: string;
          workspacePath?: string;
          workspace_path?: string;
        }>
      | IssueAttachmentRecord[]
      | null
      | undefined,
    fallbackTimestamp: string,
  ): IssueAttachmentRecord[] {
    return this.parseIssueAttachments(attachments ?? []).map((attachment) => ({
      ...attachment,
      createdAt: this.normalizedNullableText(attachment.createdAt) ?? fallbackTimestamp,
    }));
  }

  private normalizedStringArray(values: unknown[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
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

  private requiredIssueStatus(value: string | null | undefined): IssueStatus {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (
      normalized === "backlog" ||
      normalized === "todo" ||
      normalized === "in_progress" ||
      normalized === "in_review" ||
      normalized === "done" ||
      normalized === "blocked"
    ) {
      return normalized;
    }
    throw new Error(`unsupported issue status: ${value ?? ""}`);
  }

  private nullableIssuePriority(value: string | null | undefined): IssuePriority | null {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
      return normalized;
    }
    throw new Error(`unsupported issue priority: ${value ?? ""}`);
  }

  private requiredWorkspaceCapabilityStatus(
    value: string | null | undefined,
  ): WorkspaceCapabilityStatus {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (normalized === "active" || normalized === "disabled") {
      return normalized;
    }
    throw new Error(`unsupported workspace capability status: ${value ?? ""}`);
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
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (!normalized || normalized === "main") {
      return MAIN_SESSION_BINDING_ROLE;
    }
    return normalized;
  }

  private normalizedConversationBindingKey(value: string | null | undefined): string {
    const normalized = this.requiredNormalizedText(value, "conversationKey").toLowerCase();
    if (normalized === "workspace-main") {
      return MAIN_SESSION_CONVERSATION_KEY;
    }
    return normalized;
  }

  private normalizedSessionKind(value: string | null | undefined): string {
    const normalized = this.normalizedNullableText(value)?.toLowerCase();
    if (!normalized || normalized === "workspace_session" || normalized === "main") {
      return MAIN_SESSION_KIND;
    }
    if (normalized === "task_proposal") {
      return SUBAGENT_SESSION_KIND;
    }
    return normalized;
  }

  private issueIdPrefixForWorkspaceName(workspaceName: string | null | undefined): string {
    const compact = Array.from(this.normalizedNullableText(workspaceName) ?? "")
      .filter((char) => /[\p{L}\p{N}]/u.test(char))
      .slice(0, 3)
      .join("");
    return (compact || "WRK").toUpperCase();
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
    return rows.map((row) => this.rowToMainSessionEventQueue(row, workspaceId));
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
      createdBy:
        params.fields.createdBy === undefined ? existing.createdBy : this.normalizedNullableText(params.fields.createdBy),
      projectId:
        params.fields.projectId === undefined
          ? existing.projectId
          : this.normalizedNullableText(params.fields.projectId),
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
            created_by = ?,
            project_id = ?,
            updated_at = ?,
            archived_at = ?
        WHERE session_id = ?
      `)
      .run(
        next.kind,
        next.title,
        next.parentSessionId,
        next.createdBy,
        next.projectId,
        next.updatedAt,
        next.archivedAt,
        params.sessionId
      );

    return this.requireSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId
    });
  }
}
