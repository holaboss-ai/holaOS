import { contextBridge, ipcRenderer } from "electron";
import {
  BFF_FETCH_CHANNEL,
  type BffFetchRequest,
  type BffFetchResponse,
} from "../shared/bff-fetch-protocol.js";

interface FileSystemEntry {
  name: string;
  absolutePath: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

interface ListDirectoryResponse {
  currentPath: string;
  parentPath: string | null;
  entries: FileSystemEntry[];
}

type FilePreviewKind =
  | "text"
  | "image"
  | "pdf"
  | "table"
  | "presentation"
  | "unsupported";

interface FilePreviewTableImagePayload {
  row: number;
  column: number;
  dataUrl: string;
  widthPx?: number;
  heightPx?: number;
  alt?: string;
}

interface FilePreviewTableSheetPayload {
  name: string;
  index: number;
  columns: string[];
  rows: string[][];
  links?: (string | null)[][];
  images?: FilePreviewTableImagePayload[];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
  hasHeaderRow: boolean;
}

interface FilePreviewPresentationTextBoxPayload {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  paragraphs: string[];
  align: "left" | "center" | "right" | "justify";
  fontSizePx?: number;
  bold?: boolean;
}

interface FilePreviewPresentationSlidePayload {
  index: number;
  boxes: FilePreviewPresentationTextBoxPayload[];
}

interface FilePreviewPayload {
  absolutePath: string;
  name: string;
  extension: string;
  kind: FilePreviewKind;
  mimeType?: string;
  content?: string;
  dataUrl?: string;
  tableSheets?: FilePreviewTableSheetPayload[];
  presentationSlides?: FilePreviewPresentationSlidePayload[];
  presentationWidth?: number;
  presentationHeight?: number;
  size: number;
  modifiedAt: string;
  isEditable: boolean;
  unsupportedReason?: string;
}

interface FileBookmarkPayload {
  id: string;
  targetPath: string;
  label: string;
  isDirectory: boolean;
  createdAt: string;
}

interface FileSystemMutationPayload {
  absolutePath: string;
}

type ExplorerExternalImportEntryPayload =
  | {
      kind: "directory";
      relativePath: string;
    }
  | {
      kind: "file";
      relativePath: string;
      content: Uint8Array;
    };

interface ExplorerExternalImportResultPayload {
  absolutePaths: string[];
}

interface DiagnosticsExportRequestPayload {
  workspaceId?: string | null;
}

interface DiagnosticsExportPayload {
  bundlePath: string;
  fileName: string;
  archiveSizeBytes: number;
  includedFiles: string[];
  workspaceId?: string | null;
  workspaceName?: string | null;
}

interface BrowserBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserVisibleSnapshotPayload {
  bounds: BrowserBoundsPayload;
  dataUrl: string;
}

interface BrowserAnchorBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

type UiSettingsPaneSection = "account" | "billing" | "providers" | "integrations" | "submissions" | "settings" | "about";

interface DesktopWindowStatePayload {
  isFullScreen: boolean;
  isMaximized: boolean;
  isMinimized: boolean;
}

interface BrowserStatePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  initialized: boolean;
  error: string;
}

type BrowserSpaceId = "user" | "agent";

type OperatorSurfaceType = "browser" | "editor" | "terminal" | "app_surface";
type OperatorSurfaceOwner = "user" | "agent";
type OperatorSurfaceMutability = "inspect_only" | "takeover_allowed" | "agent_owned";

interface OperatorSurfacePayload {
  surface_id: string;
  surface_type: OperatorSurfaceType;
  owner: OperatorSurfaceOwner;
  active: boolean;
  mutability: OperatorSurfaceMutability;
  summary: string;
}

interface OperatorSurfaceContextPayload {
  active_surface_id: string | null;
  surfaces: OperatorSurfacePayload[];
}

interface BrowserTabCountsPayload {
  user: number;
  agent: number;
}

interface BrowserTabListPayload {
  space: BrowserSpaceId;
  activeTabId: string;
  tabs: BrowserStatePayload[];
  tabCounts: BrowserTabCountsPayload;
  sessionId: string | null;
  lifecycleState: "active" | "suspended" | null;
  controlMode: "none" | "user_locked" | "session_owned";
  controlSessionId: string | null;
}

interface BrowserBookmarkPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  folderPath?: string[];
  createdAt: string;
}

type BrowserDownloadStatus = "progressing" | "completed" | "cancelled" | "interrupted";

interface BrowserDownloadPayload {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  status: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
}

interface BrowserHistoryEntryPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
}

interface BrowserClipboardScreenshotPayload {
  tabId: string;
  pageTitle: string;
  url: string;
  width: number;
  height: number;
  copied: boolean;
}

interface ClipboardImagePayload {
  name: string;
  mime_type: string;
  content_base64: string;
  width: number;
  height: number;
}

interface AddressSuggestionPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

type RuntimeStatus = "disabled" | "missing" | "starting" | "running" | "stopped" | "error";

interface RuntimeStatusPayload {
  status: RuntimeStatus;
  available: boolean;
  runtimeRoot: string | null;
  sandboxRoot: string | null;
  executablePath: string | null;
  url: string | null;
  pid: number | null;
  harness: string | null;
  startupMessage: string | null;
  lastError: string;
}

interface RuntimeConfigPayload {
  configPath: string | null;
  loadedFromFile: boolean;
  authTokenPresent: boolean;
  userId: string | null;
  sandboxId: string | null;
  modelProxyBaseUrl: string | null;
  defaultModel: string | null;
  subagentModel: string | null;
  defaultBackgroundModel: string | null;
  defaultEmbeddingModel: string | null;
  defaultImageModel: string | null;
  controlPlaneBaseUrl: string | null;
  catalogVersion: string | null;
  providerModelGroups: RuntimeProviderModelGroupPayload[];
}

interface RuntimeProviderModelPayload {
  token: string;
  modelId: string;
  label?: string;
  reasoning?: boolean;
  thinkingValues?: string[];
  defaultThinkingValue?: string | null;
  inputModalities?: ("text" | "image" | "audio" | "video")[];
  capabilities?: string[];
}

interface RuntimeProviderModelGroupPayload {
  providerId: string;
  providerLabel: string;
  kind: string;
  models: RuntimeProviderModelPayload[];
}

interface RuntimeConfigUpdatePayload {
  authToken?: string | null;
  modelProxyApiKey?: string | null;
  userId?: string | null;
  sandboxId?: string | null;
  modelProxyBaseUrl?: string | null;
  defaultModel?: string | null;
  subagentModel?: string | null;
  defaultBackgroundModel?: string | null;
  defaultEmbeddingModel?: string | null;
  defaultImageModel?: string | null;
  controlPlaneBaseUrl?: string | null;
}

type AppUpdateChannel = "latest" | "beta";

interface AppUpdateStatusPayload {
  supported: boolean;
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  downloadProgressPercent: number | null;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  dismissedVersion: string | null;
  lastCheckedAt: string | null;
  error: string;
  channel: AppUpdateChannel;
  preferredChannel: AppUpdateChannel | null;
}

interface WorkbenchOpenBrowserPayload {
  workspaceId?: string | null;
  url?: string | null;
  space?: BrowserSpaceId | null;
  sessionId?: string | null;
}

interface TemplateAgentInfoPayload {
  role: string;
  description: string;
}

interface TemplateViewInfoPayload {
  name: string;
  description: string;
}

interface TemplateAppEntryPayload {
  name: string;
  required: boolean;
}

interface TemplateMetadataPayload {
  name: string;
  repo: string;
  path: string;
  default_ref: string;
  description: string | null;
  is_hidden: boolean;
  is_coming_soon: boolean;
  allowed_user_ids: string[];
  icon: string;
  emoji: string | null;
  apps: TemplateAppEntryPayload[];
  min_optional_apps: number;
  tags: string[];
  category: string;
  long_description: string | null;
  agents: TemplateAgentInfoPayload[];
  views: TemplateViewInfoPayload[];
  install_count?: number;
  source?: string;
  verified?: boolean;
  author_name?: string;
  author_id?: string;
}

interface SpotlightItemPayload {
  label: string;
  title: string;
  description: string;
  template_name: string;
}

interface TemplateListResponsePayload {
  templates: TemplateMetadataPayload[];
  spotlight: SpotlightItemPayload[];
}

interface WorkspaceRecordPayload {
  id: string;
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
}

interface WorkspaceResponsePayload {
  workspace: WorkspaceRecordPayload;
}

interface WorkspaceListResponsePayload {
  items: WorkspaceRecordPayload[];
  total: number;
  limit: number;
  offset: number;
}

type BrowserImportSource = "chrome" | "chromium" | "arc" | "safari";

interface BrowserImportSummaryPayload {
  sourceKind: BrowserImportSource | "workspace_copy";
  sourceLabel: string;
  sourcePath: string;
  sourceProfileDir: string;
  sourceProfileLabel: string;
  importedBookmarks: number;
  importedHistoryEntries: number;
  importedCookies: number;
  skippedCookies: number;
  warnings: string[];
}

interface BrowserImportProfilePayload {
  workspaceId: string;
  source: BrowserImportSource;
  profileDir?: string | null;
  safariArchivePath?: string | null;
}

interface BrowserImportProfileOptionPayload {
  profileId: string;
  profileLabel: string;
  profileDir: string;
}

interface BrowserCopyWorkspaceProfilePayload {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
}

interface TaskProposalRecordPayload {
  proposal_id: string;
  workspace_id: string;
  task_name: string;
  task_prompt: string;
  task_generation_rationale: string;
  proposal_source: "proactive" | "evolve";
  created_at: string;
  state: string;
  source_event_ids: string[];
  accepted_session_id: string | null;
  accepted_input_id: string | null;
  accepted_at: string | null;
}

interface TaskProposalListResponsePayload {
  proposals: TaskProposalRecordPayload[];
  count: number;
}

interface ProactiveStatusSnapshotPayload {
  state: string;
  detail: string | null;
  recorded_at: string | null;
}

interface ProactiveAgentStatusPayload {
  workspace_id: string;
  proposal_count: number;
  heartbeat: ProactiveStatusSnapshotPayload;
  bridge: ProactiveStatusSnapshotPayload;
  lifecycle_state: string;
  lifecycle_summary: string;
  lifecycle_detail: string | null;
}

interface RemoteTaskProposalGenerationRequestPayload {
  workspace_id: string;
}

interface RemoteTaskProposalGenerationResponsePayload {
  accepted: boolean;
  accepted_count: number;
  event_count: number;
  correlation_id: string;
}

interface ProactiveTaskProposalPreferenceUpdatePayload {
  enabled: boolean;
  holaboss_user_id?: string;
  sandbox_id?: string;
}

interface ProactiveTaskProposalPreferencePayload {
  enabled: boolean;
  holaboss_user_id: string;
  sandbox_id: string;
}

interface ProactiveHeartbeatWorkspacePayload {
  workspace_id: string;
  workspace_name: string | null;
  enabled: boolean;
  last_seen_at: string | null;
}

interface ProactiveHeartbeatConfigPayload {
  holaboss_user_id: string;
  sandbox_id: string;
  has_schedule: boolean;
  cron: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  workspaces: ProactiveHeartbeatWorkspacePayload[];
}

interface ProactiveHeartbeatConfigUpdatePayload {
  cron?: string;
  enabled?: boolean;
  holaboss_user_id?: string;
  sandbox_id?: string;
}

interface ProactiveHeartbeatWorkspaceUpdatePayload {
  workspace_id: string;
  workspace_name?: string | null;
  enabled: boolean;
  holaboss_user_id?: string;
  sandbox_id?: string;
}

interface TaskProposalStateUpdatePayload {
  proposal: TaskProposalRecordPayload;
}

interface AgentSessionRecordPayload {
  workspace_id: string;
  session_id: string;
  kind: string;
  title: string | null;
  parent_session_id: string | null;
  source_proposal_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AgentSessionListResponsePayload {
  items: AgentSessionRecordPayload[];
  count: number;
}

interface CreateAgentSessionPayload {
  workspace_id: string;
  session_id?: string | null;
  kind?: string | null;
  title?: string | null;
  parent_session_id?: string | null;
  created_by?: string | null;
}

interface CreateAgentSessionResponsePayload {
  session: AgentSessionRecordPayload;
}

interface TaskProposalAcceptPayload {
  proposal_id: string;
  task_name?: string | null;
  task_prompt?: string | null;
  session_id?: string | null;
  parent_session_id?: string | null;
  created_by?: string | null;
  priority?: number;
  model?: string | null;
}

interface TaskProposalAcceptResponsePayload {
  proposal: TaskProposalRecordPayload;
  session: AgentSessionRecordPayload;
  input: EnqueueSessionInputResponsePayload;
}

type MemoryUpdateProposalKind = "preference" | "identity" | "profile";
type MemoryUpdateProposalState = "pending" | "accepted" | "dismissed";

interface MemoryUpdateProposalRecordPayload {
  proposal_id: string;
  workspace_id: string;
  session_id: string;
  input_id: string;
  proposal_kind: MemoryUpdateProposalKind;
  target_key: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: string | null;
  confidence: number | null;
  source_message_id: string | null;
  state: MemoryUpdateProposalState;
  persisted_memory_id: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  dismissed_at: string | null;
}

interface MemoryUpdateProposalListRequestPayload {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  state?: MemoryUpdateProposalState | null;
  limit?: number;
  offset?: number;
}

interface MemoryUpdateProposalListResponsePayload {
  proposals: MemoryUpdateProposalRecordPayload[];
  count: number;
}

interface MemoryUpdateProposalAcceptPayload {
  proposalId: string;
  summary?: string | null;
}

interface MemoryUpdateProposalAcceptResponsePayload {
  proposal: MemoryUpdateProposalRecordPayload;
}

interface MemoryUpdateProposalDismissResponsePayload {
  proposal: MemoryUpdateProposalRecordPayload;
}

interface CronjobDeliveryPayload {
  mode: string;
  channel: string;
  to: string | null;
}

interface CronjobRecordPayload {
  id: string;
  workspace_id: string;
  initiated_by: string;
  name: string;
  cron: string;
  description: string;
  instruction: string;
  enabled: boolean;
  delivery: CronjobDeliveryPayload;
  metadata: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CronjobListResponsePayload {
  jobs: CronjobRecordPayload[];
  count: number;
}

interface CronjobCreatePayload {
  workspace_id: string;
  initiated_by: string;
  session_id?: string;
  name?: string;
  cron: string;
  description: string;
  instruction?: string;
  enabled?: boolean;
  delivery: CronjobDeliveryPayload;
  model?: string;
  metadata?: Record<string, unknown>;
}

interface CronjobUpdatePayload {
  session_id?: string;
  name?: string;
  cron?: string;
  description?: string;
  instruction?: string;
  enabled?: boolean;
  delivery?: CronjobDeliveryPayload;
  model?: string;
  metadata?: Record<string, unknown>;
}

interface CronjobRunNowPayload {
  model?: string;
}

interface SessionRuntimeRecordPayload {
  workspace_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  has_queued_inputs?: boolean;
  current_input_id: string | null;
  current_worker_id: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  last_error: Record<string, unknown> | null;
  last_turn_status: string | null;
  last_turn_completed_at: string | null;
  last_turn_stop_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRuntimeStateListResponsePayload {
  items: SessionRuntimeRecordPayload[];
  count: number;
}

interface SessionHistoryMessagePayload {
  id: string;
  role: string;
  text: string;
  created_at: string | null;
  metadata: Record<string, unknown>;
}

interface SessionHistoryResponsePayload {
  workspace_id: string;
  session_id: string;
  harness: string;
  harness_session_id: string;
  source: string;
  messages: SessionHistoryMessagePayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  raw: unknown | null;
}

interface SessionHistoryRequestPayload {
  sessionId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

interface SessionOutputEventPayload {
  id: number;
  workspace_id: string;
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface SessionOutputEventListRequestPayload {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
}

interface SessionOutputEventListResponsePayload {
  items: SessionOutputEventPayload[];
  count: number;
  last_event_id: number;
}

interface EnqueueSessionInputResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  current_input_id?: string | null;
  has_queued_inputs?: boolean;
}

interface PauseSessionRunResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
}

interface UpdateQueuedSessionInputResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
  text: string;
  updated_at: string;
}

interface HolabossClientConfigPayload {
  projectsUrl: string;
  marketplaceUrl: string;
}

interface DesktopBillingOverviewPayload {
  hasHostedBillingAccount: boolean;
  planId: string;
  planName: string | null;
  planStatus: string;
  renewsAt: string | null;
  expiresAt: string | null;
  creditsBalance: number;
  totalAllocated: number;
  totalUsed: number;
  monthlyCreditsIncluded: number | null;
  monthlyCreditsUsed: number | null;
  dailyRefreshCredits: number | null;
  dailyRefreshTarget: number | null;
  lowBalanceThreshold: number;
  isLowBalance: boolean;
}

interface DesktopBillingUsageItemPayload {
  id: string;
  type: string;
  sourceType: string | null;
  reason: string | null;
  serviceType: string | null;
  serviceId: string | null;
  category: string | null;
  metadata: Record<string, unknown> | null;
  amount: number;
  absoluteAmount: number;
  createdAt: string;
}

interface DesktopBillingUsagePayload {
  items: DesktopBillingUsageItemPayload[];
  count: number;
}

interface DesktopBillingLinksPayload {
  billingPageUrl: string;
  addCreditsUrl: string;
  upgradeUrl: string;
  usageUrl: string;
}

interface HolabossCreateWorkspacePayload {
  holaboss_user_id: string;
  harness?: string | null;
  name: string;
  template_mode?: "template" | "empty" | "empty_onboarding" | null;
  template_root_path?: string | null;
  template_name?: string | null;
  template_ref?: string | null;
  template_commit?: string | null;
  workspace_path?: string | null;
}

interface TemplateFolderSelectionPayload {
  canceled: boolean;
  rootPath: string | null;
  templateName: string | null;
  description: string | null;
}

interface WorkspaceRuntimeFolderSelectionPayload {
  canceled: boolean;
  rootPath: string | null;
}

interface HolabossQueueSessionInputPayload {
  text: string;
  workspace_id: string;
  image_urls: string[] | null;
  attachments?: SessionInputAttachmentPayload[] | null;
  session_id?: string | null;
  idempotency_key?: string | null;
  priority?: number;
  model?: string | null;
  thinking_value?: string | null;
}

interface HolabossPauseSessionRunPayload {
  workspace_id: string;
  session_id: string;
}

interface HolabossUpdateQueuedSessionInputPayload {
  workspace_id: string;
  session_id: string;
  input_id: string;
  text: string;
}

interface HolabossStreamSessionOutputsPayload {
  sessionId: string;
  workspaceId?: string | null;
  inputId?: string | null;
  includeHistory?: boolean;
  stopOnTerminal?: boolean;
}

interface HolabossListOutputsPayload {
  workspaceId: string;
  outputType?: string | null;
  status?: string | null;
  platform?: string | null;
  folderId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  limit?: number;
  offset?: number;
}

interface HolabossSessionStreamHandlePayload {
  streamId: string;
}

interface InstalledWorkspaceAppPayload {
  app_id: string;
  config_path: string;
  lifecycle: Record<string, string> | null;
  build_status?: string;
  ready: boolean;
  error: string | null;
}

interface InstalledWorkspaceAppListResponsePayload {
  apps: InstalledWorkspaceAppPayload[];
  count: number;
}

interface WorkspaceLifecycleBlockingAppPayload {
  app_id: string;
  status: string;
  error: string | null;
}

interface WorkspaceLifecyclePayload {
  workspace: WorkspaceRecordPayload;
  applications: InstalledWorkspaceAppPayload[];
  ready: boolean;
  reason: string | null;
  phase: string;
  phase_label: string;
  phase_detail: string | null;
  blocking_apps: WorkspaceLifecycleBlockingAppPayload[];
}

interface HolabossSessionStreamEventPayload {
  streamId: string;
  type: "event" | "error" | "done";
  event?: {
    event: string;
    id: string | null;
    data: unknown;
  };
  error?: string;
}

interface HolabossSessionStreamDebugEntry {
  at: string;
  streamId: string;
  phase: string;
  detail: string;
}

interface IntegrationCatalogResponsePayload {
  providers: {
    provider_id: string;
    display_name: string;
    description: string;
    auth_modes: string[];
    supports_oss: boolean;
    supports_managed: boolean;
    default_scopes: string[];
    docs_url: string | null;
  }[];
}

interface IntegrationConnectionPayload {
  connection_id: string;
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  account_external_id: string | null;
  auth_mode: string;
  granted_scopes: string[];
  status: string;
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface IntegrationConnectionListResponsePayload {
  connections: IntegrationConnectionPayload[];
}

interface IntegrationBindingListResponsePayload {
  bindings: {
    binding_id: string;
    workspace_id: string;
    target_type: string;
    target_id: string;
    integration_key: string;
    connection_id: string;
    is_default: boolean;
    created_at: string;
    updated_at: string;
  }[];
}

interface IntegrationBindingPayload {
  binding_id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  integration_key: string;
  connection_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface IntegrationUpsertBindingPayload {
  connection_id: string;
  is_default?: boolean;
}

interface IntegrationCreateConnectionPayload {
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  auth_mode: string;
  granted_scopes: string[];
  secret_ref?: string;
}

interface IntegrationUpdateConnectionPayload {
  status?: string;
  secret_ref?: string;
  account_label?: string;
}

interface OAuthAppConfigPayload {
  provider_id: string;
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port: number;
  created_at: string;
  updated_at: string;
}

interface OAuthAppConfigListResponsePayload {
  configs: OAuthAppConfigPayload[];
}

interface OAuthAppConfigUpsertPayload {
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port?: number;
}

interface OAuthAuthorizeResponsePayload {
  authorize_url: string;
  state: string;
}

interface ComposioConnectResult {
  redirect_url: string;
  connected_account_id: string;
  auth_config_id: string;
  expires_at: string | null;
}

interface ComposioAccountStatus {
  id: string;
  status: string;
  authConfigId: string | null;
  toolkitSlug: string | null;
  userId: string | null;
}

interface TemplateIntegrationRequirement {
  key: string;
  provider: string;
  required: boolean;
  app_id: string;
}

interface ResolveTemplateIntegrationsResult {
  requirements: TemplateIntegrationRequirement[];
  connected_providers: string[];
  missing_providers: string[];
}
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  fs: {
    listDirectory: (targetPath?: string | null, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:listDirectory", targetPath, workspaceId) as Promise<ListDirectoryResponse>,
    readFilePreview: (targetPath: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:readFilePreview", targetPath, workspaceId) as Promise<FilePreviewPayload>,
    writeTextFile: (targetPath: string, content: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:writeTextFile", targetPath, content, workspaceId) as Promise<FilePreviewPayload>,
    writeTableFile: (
      targetPath: string,
      tableSheets: FilePreviewTableSheetPayload[],
      workspaceId?: string | null,
    ) =>
      ipcRenderer.invoke("fs:writeTableFile", targetPath, tableSheets, workspaceId) as Promise<FilePreviewPayload>,
    watchFile: (targetPath: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:watchFile", targetPath, workspaceId) as Promise<FilePreviewWatchSubscriptionPayload>,
    unwatchFile: (subscriptionId: string) =>
      ipcRenderer.invoke("fs:unwatchFile", subscriptionId) as Promise<void>,
    createPath: (
      parentPath: string | null | undefined,
      kind: "file" | "directory",
      workspaceId?: string | null,
    ) =>
      ipcRenderer.invoke("fs:createPath", parentPath, kind, workspaceId) as Promise<FileSystemMutationPayload>,
    importExternalEntries: (
      destinationDirectoryPath: string,
      entries: ExplorerExternalImportEntryPayload[],
      workspaceId?: string | null,
    ) =>
      ipcRenderer.invoke(
        "fs:importExternalEntries",
        destinationDirectoryPath,
        entries,
        workspaceId,
      ) as Promise<ExplorerExternalImportResultPayload>,
    renamePath: (targetPath: string, nextName: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:renamePath", targetPath, nextName, workspaceId) as Promise<FileSystemMutationPayload>,
    copyPath: (
      sourcePath: string,
      destinationDirectoryPath: string,
      workspaceId?: string | null,
    ) =>
      ipcRenderer.invoke("fs:copyPath", sourcePath, destinationDirectoryPath, workspaceId) as Promise<FileSystemMutationPayload>,
    movePath: (
      sourcePath: string,
      destinationDirectoryPath: string,
      workspaceId?: string | null,
    ) =>
      ipcRenderer.invoke("fs:movePath", sourcePath, destinationDirectoryPath, workspaceId) as Promise<FileSystemMutationPayload>,
    deletePath: (targetPath: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:deletePath", targetPath, workspaceId) as Promise<{ deleted: boolean }>,
    revealInFolder: (targetPath: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:revealInFolder", targetPath, workspaceId) as Promise<{ revealed: boolean }>,
    exportFileTo: (
      targetPath: string,
      workspaceId?: string | null,
      payload?: { content?: string; suggestedName?: string },
    ) =>
      ipcRenderer.invoke(
        "fs:exportFileTo",
        targetPath,
        workspaceId,
        payload,
      ) as Promise<{ path: string | null; canceled: boolean }>,
    getBookmarks: (workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:getBookmarks", workspaceId) as Promise<FileBookmarkPayload[]>,
    addBookmark: (targetPath: string, label?: string, workspaceId?: string | null) =>
      ipcRenderer.invoke("fs:addBookmark", targetPath, label, workspaceId) as Promise<FileBookmarkPayload[]>,
    removeBookmark: (bookmarkId: string) =>
      ipcRenderer.invoke("fs:removeBookmark", bookmarkId) as Promise<FileBookmarkPayload[]>,
    onFileChange: (listener: (payload: FilePreviewChangePayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: FilePreviewChangePayload) => listener(payload);
      ipcRenderer.on("fs:fileChanged", wrapped);
      return () => ipcRenderer.removeListener("fs:fileChanged", wrapped);
    },
    onBookmarksChange: (listener: (bookmarks: FileBookmarkPayload[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, bookmarks: FileBookmarkPayload[]) => listener(bookmarks);
      ipcRenderer.on("fs:bookmarks", wrapped);
      return () => ipcRenderer.removeListener("fs:bookmarks", wrapped);
    }
  },
  diagnostics: {
    exportBundle: (payload?: DiagnosticsExportRequestPayload) =>
      ipcRenderer.invoke("diagnostics:exportBundle", payload) as Promise<DiagnosticsExportPayload>,
    revealBundle: (bundlePath: string) =>
      ipcRenderer.invoke("diagnostics:revealBundle", bundlePath) as Promise<boolean>,
  },
  app: {
    relaunch: () => ipcRenderer.invoke("app:relaunch") as Promise<void>,
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke("runtime:getStatus") as Promise<RuntimeStatusPayload>,
    restart: () => ipcRenderer.invoke("runtime:restart") as Promise<RuntimeStatusPayload>,
    getConfig: () => ipcRenderer.invoke("runtime:getConfig") as Promise<RuntimeConfigPayload>,
    getProfile: () => ipcRenderer.invoke("runtime:getProfile") as Promise<RuntimeUserProfilePayload>,
    getConfigDocument: () => ipcRenderer.invoke("runtime:getConfigDocument") as Promise<string>,
    setConfig: (payload: RuntimeConfigUpdatePayload) =>
      ipcRenderer.invoke("runtime:setConfig", payload) as Promise<RuntimeConfigPayload>,
    setProfile: (payload: RuntimeUserProfileUpdatePayload) =>
      ipcRenderer.invoke("runtime:setProfile", payload) as Promise<RuntimeUserProfilePayload>,
    setConfigDocument: (rawDocument: string) =>
      ipcRenderer.invoke("runtime:setConfigDocument", rawDocument) as Promise<RuntimeConfigPayload>,
    exchangeBinding: (sandboxId: string) =>
      ipcRenderer.invoke("runtime:exchangeBinding", sandboxId) as Promise<RuntimeConfigPayload>,
    connectCodexOAuth: () =>
      ipcRenderer.invoke("runtime:connectCodexOAuth") as Promise<RuntimeConfigPayload>,
    validateProvider: (providerId: string) =>
      ipcRenderer.invoke("runtime:validateProvider", providerId) as Promise<{
        ok: boolean;
        detail: string;
      }>,
    onConfigChange: (listener: (config: RuntimeConfigPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, config: RuntimeConfigPayload) => listener(config);
      ipcRenderer.on("runtime:config", wrapped);
      return () => ipcRenderer.removeListener("runtime:config", wrapped);
    },
    onStateChange: (listener: (status: RuntimeStatusPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: RuntimeStatusPayload) => listener(status);
      ipcRenderer.on("runtime:state", wrapped);
      return () => ipcRenderer.removeListener("runtime:state", wrapped);
    }
  },
  ui: {
    getTheme: () => ipcRenderer.invoke("ui:getTheme") as Promise<string>,
    getWindowState: () =>
      ipcRenderer.invoke("ui:getWindowState") as Promise<DesktopWindowStatePayload>,
    minimizeWindow: () => ipcRenderer.invoke("ui:minimizeWindow") as Promise<void>,
    toggleWindowSize: () => ipcRenderer.invoke("ui:toggleWindowSize") as Promise<void>,
    closeWindow: () => ipcRenderer.invoke("ui:closeWindow") as Promise<void>,
    setTheme: (theme: string) => ipcRenderer.invoke("ui:setTheme", theme) as Promise<void>,
    showNativeNotification: (payload: {
      title: string;
      body: string;
      workspaceId?: string | null;
      sessionId?: string | null;
      force?: boolean;
    }) =>
      ipcRenderer.invoke("ui:showNativeNotification", payload) as Promise<boolean>,
    setBadgeCount: (count: number) =>
      ipcRenderer.invoke("ui:setBadgeCount", count) as Promise<void>,
    getNotificationsEnabled: () =>
      ipcRenderer.invoke("ui:getNotificationsEnabled") as Promise<boolean>,
    setNotificationsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("ui:setNotificationsEnabled", enabled) as Promise<boolean>,
    openSettingsPane: (section?: UiSettingsPaneSection) => ipcRenderer.invoke("ui:openSettingsPane", section) as Promise<void>,
    openExternalUrl: (url: string) => ipcRenderer.invoke("ui:openExternalUrl", url) as Promise<void>,
    onWindowStateChange: (listener: (state: DesktopWindowStatePayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopWindowStatePayload) => listener(state);
      ipcRenderer.on("ui:windowState", wrapped);
      return () => ipcRenderer.removeListener("ui:windowState", wrapped);
    },
    onThemeChange: (listener: (theme: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, theme: string) => listener(theme);
      ipcRenderer.on("ui:themeChanged", wrapped);
      return () => ipcRenderer.removeListener("ui:themeChanged", wrapped);
    },
    onOpenSettingsPane: (listener: (section: UiSettingsPaneSection) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, section: UiSettingsPaneSection) => listener(section);
      ipcRenderer.on("ui:openSettingsPane", wrapped);
      return () => ipcRenderer.removeListener("ui:openSettingsPane", wrapped);
    },
    onNotificationActivated: (
      listener: (payload: { workspaceId: string; sessionId: string | null }) => void,
    ) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        payload: { workspaceId: string; sessionId: string | null },
      ) => listener(payload);
      ipcRenderer.on("ui:notificationActivated", wrapped);
      return () => ipcRenderer.removeListener("ui:notificationActivated", wrapped);
    },
  },
  clipboard: {
    readImage: () =>
      ipcRenderer.invoke("clipboard:readImage") as Promise<ClipboardImagePayload | null>,
    writeText: (text: string) =>
      ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
  },
  bff: {
    /**
     * fetch-shaped IPC bridge to the BFF. Use the renderer-side wrapper
     * `bffFetch` from `src/lib/bff-fetch-bridge.ts` rather than calling
     * this directly — the wrapper presents a real `Response` object.
     */
    fetch: (req: BffFetchRequest): Promise<BffFetchResponse> =>
      ipcRenderer.invoke(BFF_FETCH_CHANNEL, req) as Promise<BffFetchResponse>,
  },
  appUpdate: {
    getStatus: () => ipcRenderer.invoke("appUpdate:getStatus") as Promise<AppUpdateStatusPayload>,
    checkNow: () => ipcRenderer.invoke("appUpdate:checkNow") as Promise<AppUpdateStatusPayload>,
    dismiss: (version?: string | null) => ipcRenderer.invoke("appUpdate:dismiss", version) as Promise<AppUpdateStatusPayload>,
    setChannel: (channel: AppUpdateChannel) => ipcRenderer.invoke("appUpdate:setChannel", channel) as Promise<AppUpdateStatusPayload>,
    installNow: () => ipcRenderer.invoke("appUpdate:installNow") as Promise<void>,
    onStateChange: (listener: (status: AppUpdateStatusPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: AppUpdateStatusPayload) => listener(status);
      ipcRenderer.on("appUpdate:state", wrapped);
      return () => ipcRenderer.removeListener("appUpdate:state", wrapped);
    }
  },
  workbench: {
    onOpenBrowser: (listener: (payload: WorkbenchOpenBrowserPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: WorkbenchOpenBrowserPayload) => listener(payload);
      ipcRenderer.on("workbench:openBrowser", wrapped);
      return () => ipcRenderer.removeListener("workbench:openBrowser", wrapped);
    }
  },
  appSurface: {
    navigate: (workspaceId: string, appId: string, path?: string) =>
      ipcRenderer.invoke("appSurface:navigate", workspaceId, appId, path) as Promise<void>,
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("appSurface:setBounds", bounds) as Promise<void>,
    reload: (appId: string) =>
      ipcRenderer.invoke("appSurface:reload", appId) as Promise<void>,
    destroy: (appId: string) =>
      ipcRenderer.invoke("appSurface:destroy", appId) as Promise<void>,
    hide: () =>
      ipcRenderer.invoke("appSurface:hide") as Promise<void>,
    resolveUrl: (workspaceId: string, appId: string, path?: string) =>
      ipcRenderer.invoke("appSurface:resolveUrl", workspaceId, appId, path) as Promise<string>,
  },
  workspace: {
    getClientConfig: () => ipcRenderer.invoke("workspace:getClientConfig") as Promise<HolabossClientConfigPayload>,
    pickTemplateFolder: () =>
      ipcRenderer.invoke("workspace:pickTemplateFolder") as Promise<TemplateFolderSelectionPayload>,
    pickWorkspaceRuntimeFolder: () =>
      ipcRenderer.invoke("workspace:pickWorkspaceRuntimeFolder") as Promise<WorkspaceRuntimeFolderSelectionPayload>,
    pickWorkspaceRelocationFolder: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:pickWorkspaceRelocationFolder", workspaceId) as Promise<WorkspaceRuntimeFolderSelectionPayload>,
    relocate: (workspaceId: string, newPath: string) =>
      ipcRenderer.invoke("workspace:relocate", workspaceId, newPath) as Promise<WorkspaceResponsePayload>,
    activate: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:activate", workspaceId) as Promise<WorkspaceResponsePayload>,
    listImportBrowserProfiles: (source: BrowserImportSource) =>
      ipcRenderer.invoke("workspace:listImportBrowserProfiles", source) as Promise<BrowserImportProfileOptionPayload[]>,
    importBrowserProfile: (payload: BrowserImportProfilePayload) =>
      ipcRenderer.invoke("workspace:importBrowserProfile", payload) as Promise<BrowserImportSummaryPayload | null>,
    copyBrowserWorkspaceProfile: (payload: BrowserCopyWorkspaceProfilePayload) =>
      ipcRenderer.invoke("workspace:copyBrowserWorkspaceProfile", payload) as Promise<BrowserImportSummaryPayload>,
    listWorkspaces: () => ipcRenderer.invoke("workspace:listWorkspaces") as Promise<WorkspaceListResponsePayload>,
    listWorkspacesCached: () =>
      ipcRenderer.invoke("workspace:listWorkspacesCached") as Promise<WorkspaceListResponsePayload>,
    getWorkspaceLifecycle: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:getWorkspaceLifecycle", workspaceId) as Promise<WorkspaceLifecyclePayload>,
    activateWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:activateWorkspace", workspaceId) as Promise<WorkspaceLifecyclePayload>,
    openWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:openWorkspace", workspaceId) as Promise<WorkspaceOpenSessionPayload>,
    listInstalledApps: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:listInstalledApps", workspaceId) as Promise<InstalledWorkspaceAppListResponsePayload>,
    removeInstalledApp: (workspaceId: string, appId: string) =>
      ipcRenderer.invoke("workspace:removeInstalledApp", workspaceId, appId) as Promise<void>,
    listAppCatalog: (params: { source?: "marketplace" | "local" }) =>
      ipcRenderer.invoke("workspace:listAppCatalog", params) as Promise<AppCatalogListResponse>,
    syncAppCatalog: (params: { source: "marketplace" | "local" }) =>
      ipcRenderer.invoke("workspace:syncAppCatalog", params) as Promise<AppCatalogSyncResponse>,
    installAppFromCatalog: (params: InstallAppFromCatalogRequest) =>
      ipcRenderer.invoke("workspace:installAppFromCatalog", params) as Promise<InstallAppFromCatalogResponse>,
    installAppFromArchiveFile: (params: { workspaceId: string }) =>
      ipcRenderer.invoke("workspace:installAppFromArchiveFile", params) as Promise<InstallAppFromCatalogResponse | null>,
    runDashboardQuery: (params: { workspaceId: string; sql: string }) =>
      ipcRenderer.invoke("dashboard:runQuery", params) as Promise<DashboardQueryResult>,
    listOutputs: (payload: string | HolabossListOutputsPayload) =>
      ipcRenderer.invoke("workspace:listOutputs", payload) as Promise<WorkspaceOutputListResponsePayload>,
    listSkills: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:listSkills", workspaceId) as Promise<WorkspaceSkillListResponsePayload>,
    getWorkspaceRoot: (workspaceId: string) => ipcRenderer.invoke("workspace:getWorkspaceRoot", workspaceId) as Promise<string>,
    createWorkspace: (payload: HolabossCreateWorkspacePayload) =>
      ipcRenderer.invoke("workspace:createWorkspace", payload) as Promise<WorkspaceResponsePayload>,
    deleteWorkspace: (workspaceId: string, keepFiles?: boolean) =>
      ipcRenderer.invoke("workspace:deleteWorkspace", workspaceId, keepFiles) as Promise<WorkspaceResponsePayload>,
    updateAppearance: (
      workspaceId: string,
      payload: { icon: string | null; iconColor: string | null },
    ) =>
      ipcRenderer.invoke(
        "workspace:updateAppearance",
        workspaceId,
        payload,
      ) as Promise<WorkspaceResponsePayload>,
    listCronjobs: (workspaceId: string, enabledOnly?: boolean) =>
      ipcRenderer.invoke("workspace:listCronjobs", workspaceId, enabledOnly) as Promise<CronjobListResponsePayload>,
    runCronjobNow: (workspaceId: string, jobId: string, payload?: CronjobRunNowPayload) =>
      ipcRenderer.invoke("workspace:runCronjobNow", workspaceId, jobId, payload) as Promise<CronjobRunResponsePayload>,
    createCronjob: (payload: CronjobCreatePayload) =>
      ipcRenderer.invoke("workspace:createCronjob", payload) as Promise<CronjobRecordPayload>,
    updateCronjob: (workspaceId: string, jobId: string, payload: CronjobUpdatePayload) =>
      ipcRenderer.invoke("workspace:updateCronjob", workspaceId, jobId, payload) as Promise<CronjobRecordPayload>,
    deleteCronjob: (workspaceId: string, jobId: string) =>
      ipcRenderer.invoke("workspace:deleteCronjob", workspaceId, jobId) as Promise<{ success: boolean }>,
    listNotifications: (
      workspaceId?: string | null,
      includeDismissed?: boolean,
      options?: {
        includeCronjobSource?: boolean;
        sourceType?: string | null;
      },
    ) =>
      ipcRenderer.invoke(
        "workspace:listNotifications",
        workspaceId,
        includeDismissed,
        options,
      ) as Promise<RuntimeNotificationListResponsePayload>,
    updateNotification: (workspaceId: string, notificationId: string, payload: RuntimeNotificationUpdatePayload) =>
      ipcRenderer.invoke("workspace:updateNotification", workspaceId, notificationId, payload) as Promise<RuntimeNotificationRecordPayload>,
    listTaskProposals: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:listTaskProposals", workspaceId) as Promise<TaskProposalListResponsePayload>,
    listBackgroundTasks: (payload: BackgroundTaskListRequestPayload) =>
      ipcRenderer.invoke("workspace:listBackgroundTasks", payload) as Promise<BackgroundTaskListResponsePayload>,
    archiveBackgroundTask: (payload: ArchiveBackgroundTaskPayload) =>
      ipcRenderer.invoke("workspace:archiveBackgroundTask", payload) as Promise<ArchiveBackgroundTaskResponsePayload>,
    acceptTaskProposal: (payload: TaskProposalAcceptPayload) =>
      ipcRenderer.invoke("workspace:acceptTaskProposal", payload) as Promise<TaskProposalAcceptResponsePayload>,
    listMemoryUpdateProposals: (payload: MemoryUpdateProposalListRequestPayload) =>
      ipcRenderer.invoke("workspace:listMemoryUpdateProposals", payload) as Promise<MemoryUpdateProposalListResponsePayload>,
    acceptMemoryUpdateProposal: (payload: MemoryUpdateProposalAcceptPayload) =>
      ipcRenderer.invoke("workspace:acceptMemoryUpdateProposal", payload) as Promise<MemoryUpdateProposalAcceptResponsePayload>,
    dismissMemoryUpdateProposal: (workspaceId: string, proposalId: string) =>
      ipcRenderer.invoke("workspace:dismissMemoryUpdateProposal", workspaceId, proposalId) as Promise<MemoryUpdateProposalDismissResponsePayload>,
    getProactiveStatus: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:getProactiveStatus", workspaceId) as Promise<ProactiveAgentStatusPayload>,
    getProactiveTaskProposalPreference: () =>
      ipcRenderer.invoke(
        "workspace:getProactiveTaskProposalPreference",
      ) as Promise<ProactiveTaskProposalPreferencePayload>,
    setProactiveTaskProposalPreference: (
      payload: ProactiveTaskProposalPreferenceUpdatePayload,
    ) =>
      ipcRenderer.invoke(
        "workspace:setProactiveTaskProposalPreference",
        payload,
      ) as Promise<ProactiveTaskProposalPreferencePayload>,
    getProactiveHeartbeatConfig: () =>
      ipcRenderer.invoke(
        "workspace:getProactiveHeartbeatConfig",
      ) as Promise<ProactiveHeartbeatConfigPayload>,
    setProactiveHeartbeatConfig: (
      payload: ProactiveHeartbeatConfigUpdatePayload,
    ) =>
      ipcRenderer.invoke(
        "workspace:setProactiveHeartbeatConfig",
        payload,
      ) as Promise<ProactiveHeartbeatConfigPayload>,
    setProactiveHeartbeatWorkspaceEnabled: (
      payload: ProactiveHeartbeatWorkspaceUpdatePayload,
    ) =>
      ipcRenderer.invoke(
        "workspace:setProactiveHeartbeatWorkspaceEnabled",
        payload,
      ) as Promise<ProactiveHeartbeatConfigPayload>,
    updateTaskProposalState: (workspaceId: string, proposalId: string, state: string) =>
      ipcRenderer.invoke("workspace:updateTaskProposalState", workspaceId, proposalId, state) as Promise<TaskProposalStateUpdatePayload>,
    requestRemoteTaskProposalGeneration: (
      payload: RemoteTaskProposalGenerationRequestPayload,
    ) =>
      ipcRenderer.invoke(
        "workspace:requestRemoteTaskProposalGeneration",
        payload,
      ) as Promise<RemoteTaskProposalGenerationResponsePayload>,
    ensureMainSession: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:ensureMainSession", workspaceId) as Promise<EnsureWorkspaceMainSessionResponsePayload>,
    listAgentSessions: (payload: string | ListAgentSessionsRequestPayload) =>
      ipcRenderer.invoke("workspace:listAgentSessions", payload) as Promise<AgentSessionListResponsePayload>,
    createAgentSession: (payload: CreateAgentSessionPayload) =>
      ipcRenderer.invoke("workspace:createAgentSession", payload) as Promise<CreateAgentSessionResponsePayload>,
    listRuntimeStates: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:listRuntimeStates", workspaceId) as Promise<SessionRuntimeStateListResponsePayload>,
    getSessionHistory: (payload: SessionHistoryRequestPayload) =>
      ipcRenderer.invoke("workspace:getSessionHistory", payload) as Promise<SessionHistoryResponsePayload>,
    getSessionOutputEvents: (payload: SessionOutputEventListRequestPayload) =>
      ipcRenderer.invoke("workspace:getSessionOutputEvents", payload) as Promise<SessionOutputEventListResponsePayload>,
    stageSessionAttachments: (payload: StageSessionAttachmentsPayload) =>
      ipcRenderer.invoke("workspace:stageSessionAttachments", payload) as Promise<StageSessionAttachmentsResponsePayload>,
    stageSessionAttachmentPaths: (payload: StageSessionAttachmentPathsPayload) =>
      ipcRenderer.invoke("workspace:stageSessionAttachmentPaths", payload) as Promise<StageSessionAttachmentsResponsePayload>,
    queueSessionInput: (payload: HolabossQueueSessionInputPayload) =>
      ipcRenderer.invoke("workspace:queueSessionInput", payload) as Promise<EnqueueSessionInputResponsePayload>,
    pauseSessionRun: (payload: HolabossPauseSessionRunPayload) =>
      ipcRenderer.invoke("workspace:pauseSessionRun", payload) as Promise<PauseSessionRunResponsePayload>,
    updateQueuedSessionInput: (payload: HolabossUpdateQueuedSessionInputPayload) =>
      ipcRenderer.invoke("workspace:updateQueuedSessionInput", payload) as Promise<UpdateQueuedSessionInputResponsePayload>,
    openSessionOutputStream: (payload: HolabossStreamSessionOutputsPayload) =>
      ipcRenderer.invoke("workspace:openSessionOutputStream", payload) as Promise<HolabossSessionStreamHandlePayload>,
    closeSessionOutputStream: (streamId: string, reason?: string) =>
      ipcRenderer.invoke("workspace:closeSessionOutputStream", streamId, reason) as Promise<void>,
    getSessionStreamDebug: () =>
      ipcRenderer.invoke("workspace:getSessionStreamDebug") as Promise<HolabossSessionStreamDebugEntry[]>,
    isVerboseTelemetryEnabled: () => ipcRenderer.invoke("workspace:isVerboseTelemetryEnabled") as Promise<boolean>,
    listIntegrationCatalog: () =>
      ipcRenderer.invoke("workspace:listIntegrationCatalog") as Promise<IntegrationCatalogResponsePayload>,
    listIntegrationConnections: (params?: { providerId?: string; ownerUserId?: string }) =>
      ipcRenderer.invoke("workspace:listIntegrationConnections", params) as Promise<IntegrationConnectionListResponsePayload>,
    listIntegrationBindings: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:listIntegrationBindings", workspaceId) as Promise<IntegrationBindingListResponsePayload>,
    upsertIntegrationBinding: (workspaceId: string, targetType: string, targetId: string, integrationKey: string, payload: IntegrationUpsertBindingPayload) =>
      ipcRenderer.invoke("workspace:upsertIntegrationBinding", workspaceId, targetType, targetId, integrationKey, payload) as Promise<IntegrationBindingPayload>,
    createIntegrationConnection: (payload: IntegrationCreateConnectionPayload) =>
      ipcRenderer.invoke("workspace:createIntegrationConnection", payload) as Promise<IntegrationConnectionPayload>,
    updateIntegrationConnection: (connectionId: string, payload: IntegrationUpdateConnectionPayload) =>
      ipcRenderer.invoke("workspace:updateIntegrationConnection", connectionId, payload) as Promise<IntegrationConnectionPayload>,
    deleteIntegrationConnection: (connectionId: string) =>
      ipcRenderer.invoke("workspace:deleteIntegrationConnection", connectionId) as Promise<{ deleted: boolean }>,
    mergeIntegrationConnections: (keepConnectionId: string, removeConnectionIds: string[]) =>
      ipcRenderer.invoke(
        "workspace:mergeIntegrationConnections",
        keepConnectionId,
        removeConnectionIds,
      ) as Promise<IntegrationMergeConnectionsResult>,
    deleteIntegrationBinding: (bindingId: string, workspaceId: string) =>
      ipcRenderer.invoke("workspace:deleteIntegrationBinding", bindingId, workspaceId) as Promise<{ deleted: boolean }>,
    listOAuthConfigs: () =>
      ipcRenderer.invoke("workspace:listOAuthConfigs") as Promise<OAuthAppConfigListResponsePayload>,
    upsertOAuthConfig: (providerId: string, payload: OAuthAppConfigUpsertPayload) =>
      ipcRenderer.invoke("workspace:upsertOAuthConfig", providerId, payload) as Promise<OAuthAppConfigPayload>,
    deleteOAuthConfig: (providerId: string) =>
      ipcRenderer.invoke("workspace:deleteOAuthConfig", providerId) as Promise<{ deleted: boolean }>,
    startOAuthFlow: (provider: string) =>
      ipcRenderer.invoke("workspace:startOAuthFlow", provider) as Promise<OAuthAuthorizeResponsePayload>,
    composioListToolkits: () =>
      ipcRenderer.invoke("workspace:composioListToolkits") as Promise<{ toolkits: Array<{ slug: string; name: string; description: string; logo: string | null; auth_schemes: string[]; categories: string[] }> }>,
    composioListConnections: () =>
      ipcRenderer.invoke("workspace:composioListConnections") as Promise<{ connections: Array<{ id: string; toolkitSlug: string; toolkitName: string; toolkitLogo: string | null; userId: string; createdAt: string }> }>,
    composioConnect: (payload: { provider: string; owner_user_id: string; callback_url?: string }) =>
      ipcRenderer.invoke("workspace:composioConnect", payload) as Promise<ComposioConnectResult>,
    composioAccountStatus: (
      connectedAccountId: string,
      providerId?: string | null,
    ) =>
      ipcRenderer.invoke(
        "workspace:composioAccountStatus",
        connectedAccountId,
        providerId ?? null,
      ) as Promise<ComposioAccountStatus>,
    composioFinalize: (payload: {
      connected_account_id: string;
      provider: string;
      owner_user_id: string;
      account_label?: string;
      account_handle?: string | null;
      account_email?: string | null;
    }) =>
      ipcRenderer.invoke("workspace:composioFinalize", payload) as Promise<IntegrationConnectionPayload>,
    composioRefreshConnection: (connectionId: string) =>
      ipcRenderer.invoke(
        "workspace:composioRefreshConnection",
        connectionId,
      ) as Promise<{
        connection: IntegrationConnectionPayload;
        changed: boolean;
        reason?: "no_external_id" | "account_missing" | "no_new_identity";
      }>,
    resolveTemplateIntegrations: (payload: HolabossCreateWorkspacePayload) =>
      ipcRenderer.invoke("workspace:resolveTemplateIntegrations", payload) as Promise<ResolveTemplateIntegrationsResult>,
    generateTemplateContent: (params: {
      contentType: "onboarding" | "readme";
      name: string;
      description: string;
      category: string;
      tags: string[];
      apps: string[];
    }) =>
      ipcRenderer.invoke("workspace:generateTemplateContent", params) as Promise<{ content: string }>,
    createSubmission: (payload: CreateSubmissionPayload) =>
      ipcRenderer.invoke("workspace:createSubmission", payload) as Promise<CreateSubmissionResponse>,
    packageAndUploadWorkspace: (params: {
      workspaceId: string;
      apps: string[];
      manifest: Record<string, unknown>;
      uploadUrl: string;
      forceExcludePaths?: string[];
    }) =>
      ipcRenderer.invoke("workspace:packageAndUploadWorkspace", params) as Promise<PackageAndUploadResult>,
    onPublishProgress: (
      listener: (payload: PublishProgressPayload) => void,
    ) => {
      const wrapped = (_e: Electron.IpcRendererEvent, payload: PublishProgressPayload) => listener(payload);
      ipcRenderer.on("workspace:publishProgress", wrapped);
      return () => ipcRenderer.removeListener("workspace:publishProgress", wrapped);
    },
    previewBundle: (params: { workspaceId: string; apps: string[]; forceExcludePaths?: string[] }) =>
      ipcRenderer.invoke("workspace:previewBundle", params) as Promise<BundlePreviewPayload>,
    checkTemplateName: (name: string) =>
      ipcRenderer.invoke("workspace:checkTemplateName", name) as Promise<TemplateNameCheckPayload>,
    finalizeSubmission: (submissionId: string) =>
      ipcRenderer.invoke("workspace:finalizeSubmission", submissionId) as Promise<FinalizeSubmissionResponse>,
    listSubmissions: () =>
      ipcRenderer.invoke("workspace:listSubmissions") as Promise<SubmissionListResponse>,
    deleteSubmission: (submissionId: string) =>
      ipcRenderer.invoke("workspace:deleteSubmission", { submissionId }) as Promise<{ deleted: boolean }>,
    setOperatorSurfaceContext: (workspaceId: string, context: OperatorSurfaceContextPayload | null) =>
      ipcRenderer.invoke("workspace:setOperatorSurfaceContext", workspaceId, context) as Promise<void>,
    onSessionStreamEvent: (listener: (payload: HolabossSessionStreamEventPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: HolabossSessionStreamEventPayload) => listener(payload);
      ipcRenderer.on("workspace:sessionStream", wrapped);
      return () => ipcRenderer.removeListener("workspace:sessionStream", wrapped);
    }
  },
  auth: {
    getUser: () => ipcRenderer.invoke("auth:getUser") as Promise<AuthUserPayload | null>,
    // Renderer-direct BFF clients (e.g. @holaboss/app-sdk in renderer,
    // billing RPC) reach the BFF via the bff:fetch bridge below — the
    // raw cookie stays in main. These two accessors expose only the host
    // URL the renderer should target.
    getApiBaseUrl: () => ipcRenderer.invoke("auth:getApiBaseUrl") as Promise<string>,
    getMarketplaceBaseUrl: () =>
      ipcRenderer.invoke("auth:getMarketplaceBaseUrl") as Promise<string>,
    requestAuth: () => ipcRenderer.invoke("auth:requestAuth") as Promise<void>,
    signOut: () => ipcRenderer.invoke("auth:signOut") as Promise<void>,
    showPopup: (anchorBounds: BrowserAnchorBoundsPayload) => ipcRenderer.invoke("auth:showPopup", anchorBounds) as Promise<void>,
    togglePopup: (anchorBounds: BrowserAnchorBoundsPayload) => ipcRenderer.invoke("auth:togglePopup", anchorBounds) as Promise<void>,
    scheduleClosePopup: (delayMs?: number) => ipcRenderer.invoke("auth:scheduleClosePopup", delayMs) as Promise<void>,
    cancelClosePopup: () => ipcRenderer.invoke("auth:cancelClosePopup") as Promise<void>,
    closePopup: () => ipcRenderer.invoke("auth:closePopup") as Promise<void>,
    onAuthenticated: (listener: (user: AuthUserPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, user: AuthUserPayload) => listener(user);
      ipcRenderer.on("auth:authenticated", wrapped);
      return () => ipcRenderer.removeListener("auth:authenticated", wrapped);
    },
    onUserUpdated: (listener: (user: AuthUserPayload | null) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, user: AuthUserPayload | null) => listener(user);
      ipcRenderer.on("auth:userUpdated", wrapped);
      return () => ipcRenderer.removeListener("auth:userUpdated", wrapped);
    },
    onError: (listener: (payload: AuthErrorPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AuthErrorPayload) => listener(payload);
      ipcRenderer.on("auth:error", wrapped);
      return () => ipcRenderer.removeListener("auth:error", wrapped);
    }
  },
  browser: {
    setActiveWorkspace: (
      workspaceId?: string | null,
      space?: BrowserSpaceId | null,
      sessionId?: string | null,
    ) =>
      ipcRenderer.invoke("browser:setActiveWorkspace", workspaceId, space, sessionId) as Promise<BrowserTabListPayload>,
    getState: () => ipcRenderer.invoke("browser:getState") as Promise<BrowserTabListPayload>,
    setBounds: (bounds: BrowserBoundsPayload) => ipcRenderer.invoke("browser:setBounds", bounds) as Promise<BrowserTabListPayload>,
    captureVisibleSnapshot: () =>
      ipcRenderer.invoke("browser:captureVisibleSnapshot") as Promise<BrowserVisibleSnapshotPayload | null>,
    navigate: (targetUrl: string) => ipcRenderer.invoke("browser:navigate", targetUrl) as Promise<BrowserTabListPayload>,
    back: () => ipcRenderer.invoke("browser:back") as Promise<BrowserTabListPayload>,
    forward: () => ipcRenderer.invoke("browser:forward") as Promise<BrowserTabListPayload>,
    reload: () => ipcRenderer.invoke("browser:reload") as Promise<BrowserTabListPayload>,
    stopLoading: () => ipcRenderer.invoke("browser:stopLoading") as Promise<BrowserTabListPayload>,
    captureScreenshotToClipboard: () =>
      ipcRenderer.invoke("browser:captureScreenshotToClipboard") as Promise<BrowserClipboardScreenshotPayload>,
    newTab: (targetUrl?: string) => ipcRenderer.invoke("browser:newTab", targetUrl) as Promise<BrowserTabListPayload>,
    setActiveTab: (tabId: string) => ipcRenderer.invoke("browser:setActiveTab", tabId) as Promise<BrowserTabListPayload>,
    closeTab: (tabId: string) => ipcRenderer.invoke("browser:closeTab", tabId) as Promise<BrowserTabListPayload>,
    getBookmarks: () => ipcRenderer.invoke("browser:getBookmarks") as Promise<BrowserBookmarkPayload[]>,
    addBookmark: (payload: { url: string; title?: string }) =>
      ipcRenderer.invoke("browser:addBookmark", payload) as Promise<BrowserBookmarkPayload[]>,
    removeBookmark: (bookmarkId: string) =>
      ipcRenderer.invoke("browser:removeBookmark", bookmarkId) as Promise<BrowserBookmarkPayload[]>,
    getDownloads: () => ipcRenderer.invoke("browser:getDownloads") as Promise<BrowserDownloadPayload[]>,
    getHistory: () => ipcRenderer.invoke("browser:getHistory") as Promise<BrowserHistoryEntryPayload[]>,
    showAddressSuggestions: (
      anchorBounds: BrowserAnchorBoundsPayload,
      suggestions: AddressSuggestionPayload[],
      selectedIndex: number
    ) => ipcRenderer.invoke("browser:showAddressSuggestions", anchorBounds, suggestions, selectedIndex) as Promise<void>,
    hideAddressSuggestions: () => ipcRenderer.invoke("browser:hideAddressSuggestions") as Promise<void>,
    toggleOverflowPopup: (anchorBounds: BrowserAnchorBoundsPayload) =>
      ipcRenderer.invoke("browser:toggleOverflowPopup", anchorBounds) as Promise<void>,
    toggleHistoryPopup: (anchorBounds: BrowserAnchorBoundsPayload) =>
      ipcRenderer.invoke("browser:toggleHistoryPopup", anchorBounds) as Promise<void>,
    removeHistoryEntry: (historyId: string) =>
      ipcRenderer.invoke("browser:removeHistoryEntry", historyId) as Promise<BrowserHistoryEntryPayload[]>,
    clearHistory: () => ipcRenderer.invoke("browser:clearHistory") as Promise<BrowserHistoryEntryPayload[]>,
    toggleDownloadsPopup: (anchorBounds: BrowserAnchorBoundsPayload) =>
      ipcRenderer.invoke("browser:toggleDownloadsPopup", anchorBounds) as Promise<void>,
    showDownloadInFolder: (downloadId: string) => ipcRenderer.invoke("browser:showDownloadInFolder", downloadId) as Promise<boolean>,
    openDownload: (downloadId: string) => ipcRenderer.invoke("browser:openDownload", downloadId) as Promise<string>,
    closeDownloadsPopup: () => ipcRenderer.invoke("browser:closeDownloadsPopup") as Promise<void>,
    onStateChange: (listener: (state: BrowserTabListPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserTabListPayload) => listener(state);
      ipcRenderer.on("browser:state", wrapped);
      return () => ipcRenderer.removeListener("browser:state", wrapped);
    },
    onBookmarksChange: (listener: (bookmarks: BrowserBookmarkPayload[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, bookmarks: BrowserBookmarkPayload[]) => listener(bookmarks);
      ipcRenderer.on("browser:bookmarks", wrapped);
      return () => ipcRenderer.removeListener("browser:bookmarks", wrapped);
    },
    onDownloadsChange: (listener: (downloads: BrowserDownloadPayload[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, downloads: BrowserDownloadPayload[]) => listener(downloads);
      ipcRenderer.on("browser:downloads", wrapped);
      return () => ipcRenderer.removeListener("browser:downloads", wrapped);
    },
    onHistoryChange: (listener: (history: BrowserHistoryEntryPayload[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, history: BrowserHistoryEntryPayload[]) => listener(history);
      ipcRenderer.on("browser:history", wrapped);
      return () => ipcRenderer.removeListener("browser:history", wrapped);
    },
    onAddressSuggestionChosen: (listener: (index: number) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, index: number) => listener(index);
      ipcRenderer.on("browser:addressSuggestionChosen", wrapped);
      return () => ipcRenderer.removeListener("browser:addressSuggestionChosen", wrapped);
    }
  }
});
