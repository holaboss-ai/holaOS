/// <reference types="vite/client" />

declare global {
  interface LocalFileEntry {
    name: string;
    absolutePath: string;
    isDirectory: boolean;
    size: number;
    modifiedAt: string;
  }

  interface LocalDirectoryResponse {
    currentPath: string;
    parentPath: string | null;
    entries: LocalFileEntry[];
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

  type FileSystemCreateKind = "file" | "directory";

  interface FilePreviewWatchSubscriptionPayload {
    subscriptionId: string;
    absolutePath: string;
  }

  interface FilePreviewChangePayload {
    absolutePath: string;
  }

  interface HtmlToPdfExportRequestPayload {
    html: string;
    suggestedName?: string;
    basePath?: string | null;
  }

  interface DiagnosticsExportPayload {
    bundlePath: string;
    fileName: string;
    archiveSizeBytes: number;
    includedFiles: string[];
    workspaceId?: string | null;
    workspaceName?: string | null;
  }

  interface DiagnosticsExportRequestPayload {
    workspaceId?: string | null;
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

  type UiSettingsPaneSection = "account" | "billing" | "providers" | "integrations" | "memory" | "submissions" | "settings" | "experimental";

  interface MemoryBrowserTreeNodePayload {
    name: string;
    path: string;
    kind: "directory" | "file";
    size_bytes: number | null;
    modified_at: string | null;
    children?: MemoryBrowserTreeNodePayload[];
  }

  interface MemoryBrowserTreeResponsePayload {
    workspace_id: string;
    root: MemoryBrowserTreeNodePayload;
    counts: {
      directories: number;
      files: number;
    };
  }

  interface MemoryBrowserFileResponsePayload {
    workspace_id: string;
    path: string;
    name: string;
    size_bytes: number;
    modified_at: string;
    content: string;
  }

  type MemoryBrowserGraphForestPayload = "workspace" | "integrations";
  type MemoryBrowserGraphNodeKindPayload = "root" | "tree" | "entity" | "branch" | "summary" | "leaf";

  interface MemoryBrowserGraphNodePayload {
    id: string;
    kind: MemoryBrowserGraphNodeKindPayload;
    category: "interaction" | "integration";
    tree_id: string | null;
    label: string;
    subtitle: string | null;
    status: string | null;
    level: number | null;
    child_count: number | null;
    path: string | null;
  }

  interface MemoryBrowserGraphEdgePayload {
    from: string;
    to: string;
    kind: "contains" | "parent_child" | "reference";
  }

  interface MemoryBrowserGraphResponsePayload {
    workspace_id: string;
    forest: MemoryBrowserGraphForestPayload;
    focus_tree_id: string | null;
    nodes: MemoryBrowserGraphNodePayload[];
    edges: MemoryBrowserGraphEdgePayload[];
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
    desktopBrowserReady: boolean;
    desktopBrowserUrl: string | null;
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

  type RuntimeUserProfileNameSource = "manual" | "agent" | "authFallback";
  type AppUpdateChannel = "latest" | "beta";

  interface RuntimeUserProfilePayload {
    profileId: string;
    name: string | null;
    nameSource: RuntimeUserProfileNameSource | null;
    createdAt: string | null;
    updatedAt: string | null;
  }

  interface RuntimeUserProfileUpdatePayload {
    profileId?: string | null;
    name?: string | null;
    nameSource?: RuntimeUserProfileNameSource | null;
  }

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

interface DesktopWindowStatePayload {
  isFullScreen: boolean;
  isMaximized: boolean;
  isMinimized: boolean;
}

// Per-toolkit whoami descriptor declared in the app's `app.runtime.yaml`,
// forwarded from runtime → chat UI → composioConnect → Hono so the profile
// fetch can resolve identity fields without a Hono-side per-toolkit map.
// Field values are dot-paths against the provider's /me response; a value
// containing `{...}` placeholders is treated as a URL template (used e.g.
// for Discord avatars: "https://cdn.discordapp.com/avatars/{id}/{avatar}.png").
// Arrays of candidates are also supported (first non-empty wins) to absorb
// shape drift between provider API versions.
type PendingIntegrationWhoamiField = string | string[];
interface PendingIntegrationWhoami {
  endpoint: string;
  fallback_endpoints?: string[];
  fields: {
    handle?: PendingIntegrationWhoamiField;
    display_name?: PendingIntegrationWhoamiField;
    avatar_url?: PendingIntegrationWhoamiField;
    email?: PendingIntegrationWhoamiField;
  };
}

interface DesktopNativeNotificationPayload {
  title: string;
  body: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  force?: boolean;
}

interface RuntimeNotificationListOptionsPayload {
  includeCronjobSource?: boolean;
  sourceType?: string | null;
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
    // Community-source templates omit these array fields on the wire; the
    // renderer-side workspaceDesktop loader normalizes them to [] before
    // exposing them via context, so UI code can rely on them being present.
    apps: TemplateAppEntryPayload[];
    min_optional_apps: number;
    tags: string[];
    category: string;
    long_description: string | null;
    agents: TemplateAgentInfoPayload[];
    views: TemplateViewInfoPayload[];
    display_name?: string | null;
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

  type WorkspaceLocationPayload = "local" | "cloud";

  interface WorkspaceRecordPayload {
    id: string;
    location: WorkspaceLocationPayload;
    name: string;
    status: string;
    harness: string | null;
    error_message: string | null;
    onboarding_status: string;
    onboarding_state?: string | null;
    onboarding_session_id: string | null;
    alignment_question?: Record<string, unknown> | null;
    alignment_report?: Record<string, unknown> | null;
    verification_report?: Record<string, unknown> | null;
    onboarding_completed_at: string | null;
    onboarding_completion_summary: string | null;
    onboarding_requested_at: string | null;
    onboarding_requested_by: string | null;
    created_at: string | null;
    updated_at: string | null;
    deleted_at_utc: string | null;
    icon?: string | null;
    icon_color?: string | null;
    workspace_role?: string | null;
    source_workspace_id?: string | null;
    lab_purpose?: string | null;
    lab_status?: string | null;
    workspace_path?: string | null;
    folder_state?: "healthy" | "missing" | null;
  }

  interface WorkspaceResponsePayload {
    workspace: WorkspaceRecordPayload;
  }

  interface WorkspaceLabResponsePayload {
    lab: WorkspaceRecordPayload | null;
    source: WorkspaceRecordPayload | null;
    session: AgentSessionRecordPayload | null;
    created?: boolean;
  }

  interface WorkspaceListResponsePayload {
    items: WorkspaceRecordPayload[];
    total: number;
    limit: number;
    offset: number;
  }

  interface WorkspaceOnboardingStatusPayload {
    workspace_id: string;
    onboarding_status: string;
    onboarding_state: string | null;
    alignment_question: Record<string, unknown> | null;
    alignment_report: Record<string, unknown> | null;
    verification_report: Record<string, unknown> | null;
    onboarding_completed_at: string | null;
    onboarding_completion_summary: string | null;
    onboarding_requested_at: string | null;
    onboarding_requested_by: string | null;
    lab_workspace_id?: string | null;
    lab_purpose?: string | null;
    lab_status?: string | null;
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

  interface BackgroundTaskLiveStatePayload {
    runtime_status: string | null;
    current_input_id: string | null;
    current_input_status: string | null;
    latest_input_id: string | null;
    latest_input_status: string | null;
    latest_turn_status: string | null;
    latest_turn_stop_reason: string | null;
  }

  interface BackgroundTaskRecordPayload {
    subagent_id: string;
    workspace_id: string;
    parent_session_id: string | null;
    parent_input_id: string | null;
    origin_main_session_id: string;
    owner_main_session_id: string;
    child_session_id: string;
    initial_child_input_id: string | null;
    current_child_input_id: string | null;
    latest_child_input_id: string | null;
    title: string;
    goal: string;
    context: string | null;
    source_type: string | null;
    source_id: string | null;
    proposal_id: string | null;
    cronjob_id: string | null;
    retry_of_subagent_id: string | null;
    tool_profile: Record<string, unknown>;
    requested_model: string | null;
    effective_model: string | null;
    status: string;
    summary: string | null;
    latest_progress_payload: Record<string, unknown> | null;
    blocking_payload: Record<string, unknown> | null;
    result_payload: Record<string, unknown> | null;
    error_payload: Record<string, unknown> | null;
    last_event_at: string | null;
    owner_transferred_at: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    updated_at: string;
    live_state: BackgroundTaskLiveStatePayload;
  }

  interface BackgroundTaskListRequestPayload {
    workspaceId: string;
    ownerMainSessionId?: string | null;
    statuses?: string[];
    limit?: number;
  }

  interface BackgroundTaskListResponsePayload {
    tasks: BackgroundTaskRecordPayload[];
    count: number;
  }

  interface ArchiveBackgroundTaskPayload {
    workspaceId: string;
    subagentId: string;
    ownerMainSessionId?: string | null;
  }

  interface ArchiveBackgroundTaskResponsePayload {
    subagent_id: string;
    child_session_id: string;
    archived: boolean;
    archived_at: string | null;
  }

  interface MainSessionLegacyExportPayload {
    session_id: string;
    title: string | null;
    kind: string;
    archived_at: string;
    exported_at: string;
    message_count: number;
    output_count: number;
    json_path: string;
    markdown_path: string;
  }

  interface EnsureWorkspaceMainSessionResponsePayload {
    session: AgentSessionRecordPayload;
    migrated_legacy_sessions: MainSessionLegacyExportPayload[];
    migrated_legacy_session_count: number;
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
    source_type?: string | null;
    cronjob_id?: string | null;
    proposal_id?: string | null;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  }

  interface AgentSessionListResponsePayload {
    items: AgentSessionRecordPayload[];
    count: number;
  }

  interface ListAgentSessionsRequestPayload {
    workspaceId: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
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
    workspace_id: string;
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

  interface CronjobRunResponsePayload {
    success: boolean;
    cronjob: CronjobRecordPayload;
    session_id: string | null;
    notification_id: string | null;
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

  type RuntimeNotificationLevel = "info" | "success" | "warning" | "error";
  type RuntimeNotificationPriority = "low" | "normal" | "high" | "critical";
  type RuntimeNotificationState = "unread" | "read" | "dismissed";

  interface RuntimeNotificationRecordPayload {
    id: string;
    workspace_id: string;
    cronjob_id: string | null;
    source_type: string;
    source_label: string | null;
    title: string;
    message: string;
    level: RuntimeNotificationLevel;
    priority: RuntimeNotificationPriority;
    state: RuntimeNotificationState;
    metadata: Record<string, unknown>;
    read_at: string | null;
    dismissed_at: string | null;
    created_at: string;
    updated_at: string;
  }

  interface RuntimeNotificationListResponsePayload {
    items: RuntimeNotificationRecordPayload[];
    count: number;
  }

  interface RuntimeNotificationUpdatePayload {
    state?: RuntimeNotificationState;
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

  interface SessionInputAttachmentPayload {
    id: string;
    kind: "image" | "file" | "folder";
    name: string;
    mime_type: string;
    size_bytes: number;
    workspace_path: string;
  }

  interface StageSessionAttachmentFilePayload {
    name: string;
    mime_type?: string | null;
    content_base64: string;
  }

  interface StageSessionAttachmentsPayload {
    workspace_id: string;
    files: StageSessionAttachmentFilePayload[];
  }

  interface StageSessionAttachmentPathPayload {
    absolute_path: string;
    name?: string | null;
    mime_type?: string | null;
    kind?: "image" | "file" | "folder" | null;
  }

  interface StageSessionAttachmentPathsPayload {
    workspace_id: string;
    files: StageSessionAttachmentPathPayload[];
  }

  interface StageSessionAttachmentsResponsePayload {
    attachments: SessionInputAttachmentPayload[];
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

  interface CancelQueuedSessionInputResponsePayload {
    input_id: string;
    session_id: string;
    status: string;
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

  interface InstalledWorkspaceAppIntegrationRequirement {
    key: string;
    /**
     * Composio toolkit slug (== `integration.destination` / `provider.id`)
     * — drives the per-app Connect button on the App Surface and the
     * `pending_integrations` emit in chat tool results.
     */
    provider: string;
    capability: string | null;
    required: boolean;
    /**
     * Optional whoami descriptor declared in the app's yaml — when present
     * the desktop forwards it to Hono `/composio/connect` so the per-toolkit
     * profile fetch resolves without a Hono-side constant. See
     * `PendingIntegrationWhoami` for the shape.
     */
    whoami?: PendingIntegrationWhoami | null;
  }

  interface InstalledWorkspaceAppPayload {
    app_id: string;
    /**
     * Display name from yaml's top-level `name:` field. Null when the yaml
     * is unparseable or omits `name:` — the desktop falls back to a
     * title-cased `app_id`.
     */
    name?: string | null;
    config_path: string;
    lifecycle: Record<string, string> | null;
    build_status?: string;
    ready: boolean;
    error: string | null;
    /**
     * Integrations declared in the app's `app.runtime.yaml`. Empty when the
     * yaml has no `integrations:` block (UI-only apps, data-only apps). The
     * runtime parses this fresh on every list call.
     */
    integrations?: InstalledWorkspaceAppIntegrationRequirement[];
  }

  interface InstalledWorkspaceAppListResponsePayload {
    apps: InstalledWorkspaceAppPayload[];
    count: number;
  }

  interface AppTemplateArchivePayload {
    target: string;
    url: string;
  }

  interface AppCatalogEntryPayload {
    app_id: string;
    source: "marketplace" | "local";
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    tags: string[];
    version: string | null;
    archive_url: string | null;
    archive_path: string | null;
    target: string;
    cached_at: string;
    provider_id: string | null;
    credential_source: string | null;
  }

  interface AppCatalogListResponse {
    entries: AppCatalogEntryPayload[];
    count: number;
  }

  interface AppCatalogSyncResponse {
    synced: number;
    source: "marketplace" | "local";
    target: string;
  }

  interface InstallAppFromCatalogRequest {
    workspaceId: string;
    appId: string;
    source: "marketplace" | "local";
  }

  interface InstallAppFromCatalogResponse {
    app_id: string;
    status: string;
    detail: string;
    ready: boolean;
    error: string | null;
  }

  interface AppTemplateMetadataPayload {
    name: string;
    repo: string;
    path: string;
    default_ref: string;
    description: string | null;
    readme: string | null;
    is_hidden: boolean;
    is_coming_soon: boolean;
    allowed_user_ids: string[];
    icon: string | null;
    category: string;
    tags: string[];
    version?: string | null;
    archives?: AppTemplateArchivePayload[];
    provider_id?: string | null;
    credential_source?: string | null;
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

  interface WorkspaceCardSummaryTaskCountsPayload {
    running: number;
    queued: number;
    waiting_on_user: number;
    failed: number;
  }

  interface WorkspaceCardSummaryPayload {
    workspace_id: string;
    lifecycle: "starting" | "ready" | "error";
    task_counts: WorkspaceCardSummaryTaskCountsPayload;
  }

  interface WorkspaceCardSummariesResponsePayload {
    summaries: WorkspaceCardSummaryPayload[];
  }

  interface WorkspaceRuntimeSessionPayload {
    workspace_id: string;
    location: WorkspaceLocationPayload;
    runtime_base_url: string;
    runtime_auth_token: string | null;
    workspace_root: string;
  }

  interface WorkspaceOpenSessionPayload extends WorkspaceRuntimeSessionPayload {
    lifecycle: WorkspaceLifecyclePayload;
  }

  interface WorkspaceOutputRecordPayload {
    id: string;
    workspace_id: string;
    output_type: string;
    title: string;
    status: string;
    module_id: string | null;
    module_resource_id: string | null;
    file_path: string | null;
    html_content: string | null;
    session_id: string | null;
    input_id: string | null;
    artifact_id: string | null;
    folder_id: string | null;
    platform: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }

  interface WorkspaceOutputListRequestPayload {
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

  interface WorkspaceOutputListResponsePayload {
    items: WorkspaceOutputRecordPayload[];
  }

  interface WorkspaceOutputFolderRecordPayload {
    id: string;
    workspace_id: string;
    name: string;
    position: number;
    created_at: string;
    updated_at: string;
  }

  interface WorkspaceOutputFolderListResponsePayload {
    items: WorkspaceOutputFolderRecordPayload[];
  }

  interface WorkspaceSkillRecordPayload {
    skill_id: string;
    source_dir: string;
    skill_file_path: string;
    title: string;
    summary: string;
    modified_at: string;
  }

  interface WorkspaceSkillListResponsePayload {
    workspace_id: string;
    workspace_root: string;
    skills_path: string;
    skills: WorkspaceSkillRecordPayload[];
  }

  interface AuthUserPayload {
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    personalXAccount?: string | null;
    timezone?: string | null;
    invitationVerified?: boolean | null;
    onboardingCompleted?: boolean | null;
    role?: string | null;
    [key: string]: unknown;
  }

  interface AuthErrorPayload {
    message?: string;
    status: number;
    statusText: string;
    path: string;
  }

  interface HolabossCreateWorkspacePayload {
    holaboss_user_id: string;
    location?: WorkspaceLocationPayload | null;
    harness?: string | null;
    name: string;
    template_mode?: "template" | "empty" | "empty_onboarding" | null;
    template_root_path?: string | null;
    template_name?: string | null;
    template_ref?: string | null;
    template_commit?: string | null;
    template_apps?: string[];
    workspace_onboarding_mode?: "start" | "skip" | null;
    workspace_onboarding_engine?: "deterministic" | "agentic" | null;
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

  interface HolabossStreamSessionOutputsPayload {
    sessionId: string;
    workspaceId?: string | null;
    inputId?: string | null;
    includeHistory?: boolean;
    stopOnTerminal?: boolean;
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

  interface HolabossCancelQueuedSessionInputPayload {
    workspace_id: string;
    session_id: string;
    input_id: string;
  }

  interface HolabossSessionStreamHandlePayload {
    streamId: string;
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

  interface IntegrationCatalogProviderPayload {
    provider_id: string;
    display_name: string;
    description: string;
    auth_modes: string[];
    supports_oss: boolean;
    supports_managed: boolean;
    default_scopes: string[];
    docs_url: string | null;
  }

  interface IntegrationCatalogResponsePayload {
    providers: IntegrationCatalogProviderPayload[];
  }

  interface IntegrationConnectionPayload {
    connection_id: string;
    provider_id: string;
    owner_user_id: string;
    account_label: string;
    account_external_id: string | null;
    /** Provider-side handle from whoami (e.g. Twitter @joshua) — used for re-auth dedupe. */
    account_handle: string | null;
    /** Provider-side email from whoami (e.g. josh@example.com) — used for re-auth dedupe. */
    account_email: string | null;
    context_cron_auto_fetch_enabled: boolean;
    last_context_fetch_attempted_at: string | null;
    last_context_fetch_completed_at: string | null;
    last_context_fetch_status: string | null;
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

  interface IntegrationBindingPayload {
    binding_id: string;
    workspace_id: string;
    target_type: "workspace" | "app" | "agent";
    target_id: string;
    integration_key: string;
    connection_id: string;
    is_default: boolean;
    created_at: string;
    updated_at: string;
  }

  interface IntegrationBindingListResponsePayload {
    bindings: IntegrationBindingPayload[];
  }

  interface IntegrationUpsertBindingPayload {
    connection_id: string;
    is_default?: boolean;
  }

  interface ConnectionWorkspaceUsageEntry {
    connection_id: string;
    workspaces: Array<{
      workspace_id: string;
      target_type: string;
      target_id: string;
      integration_key: string;
    }>;
  }

  interface ConnectionWorkspaceUsagePayload {
    usage: ConnectionWorkspaceUsageEntry[];
  }

  interface ComposioToolkitCapability {
    name: string;
    description: string;
    tool_slug: string;
    read_only: boolean;
  }

  interface ComposioToolkitCapabilitiesPayload {
    toolkits: Record<string, ComposioToolkitCapability[]>;
  }

  interface IntegrationStoreCatalogEntry {
    slug: string;
    tier: "hero" | "supported";
    category: string;
  }

  interface IntegrationStoreCatalogPayload {
    entries: IntegrationStoreCatalogEntry[];
  }

  interface IntegrationContextFetchStatusPayload {
    connection_id: string;
    provider_id: string;
    run_id: string;
    supported: boolean;
    status: "running" | "completed" | "failed" | "unsupported";
    account_key: string | null;
    account_label: string | null;
    tree_id: string | null;
    current_chunk_label: string | null;
    chunks_total: number;
    chunks_completed: number;
    messages_seen: number;
    messages_persisted: number;
    leaves_created: number;
    leaves_superseding: number;
    leaves_unchanged: number;
    summary_nodes: number;
    actions: string[];
    started_at: string | null;
    updated_at: string;
    completed_at: string | null;
    fetched_at: string | null;
    error_message: string | null;
    reason: string | null;
  }

  interface IntegrationContextFetchStartResponsePayload {
    ok: true;
    started: boolean;
    deduped: boolean;
    status: IntegrationContextFetchStatusPayload;
  }

  interface IntegrationContextFetchStatusListResponsePayload {
    ok: true;
    statuses: IntegrationContextFetchStatusPayload[];
  }

  interface IntegrationMemoryClearResponsePayload {
    ok: true;
    provider_id: string;
    connection_id: string;
    cleared: boolean;
    tree_ids: string[];
    deleted_trees: number;
    deleted_leaves: number;
    deleted_summary_nodes: number;
    deleted_tree_edges: number;
    deleted_canonical_nodes: number;
    deleted_canonical_edges: number;
    deleted_relations: number;
    deleted_embeddings: number;
    deleted_files: number;
  }
  interface AllWorkspaceIntegrationOverridesPayload {
    overrides: Array<{
      workspace_id: string;
      toolkit_slug: string;
      state: "disabled" | "pinned";
      pinned_connection_id: string | null;
      created_at: string;
      updated_at: string;
    }>;
  }

  interface WorkspaceIntegrationConnectionPayload {
    connected_account_id: string;
    status: string;
    user_id: string;
    created_at: string;
  }

  interface WorkspaceIntegrationPayload {
    toolkit_slug: string;
    toolkit_name: string;
    toolkit_logo: string | null;
    supported: boolean;
    tier: "hero" | "auto";
    effective_state: "auto" | "disabled" | "pinned";
    effective_connection_id: string | null;
    pinned_connection_id: string | null;
    connections: WorkspaceIntegrationConnectionPayload[];
  }

  interface WorkspaceIntegrationsListResponsePayload {
    workspace_id: string;
    integrations: WorkspaceIntegrationPayload[];
  }

  interface WorkspaceIntegrationOverridePayload {
    workspace_id: string;
    toolkit_slug: string;
    state: "disabled" | "pinned";
    pinned_connection_id: string | null;
    created_at: string;
    updated_at: string;
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
    /** Backfill provider-side identity. `null` clears, omit to leave alone. */
    account_handle?: string | null;
    account_email?: string | null;
    context_cron_auto_fetch_enabled?: boolean;
    last_context_fetch_attempted_at?: string | null;
    last_context_fetch_completed_at?: string | null;
    last_context_fetch_status?: string | null;
  }

  interface IntegrationMergeConnectionsResult {
    kept_connection_id: string;
    removed_count: number;
    repointed_bindings: number;
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
    handle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
    data?: Record<string, unknown> | null;
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
    provider_logos: Record<string, string>;
  }

  interface CreateSubmissionPayload {
    workspaceId: string;
    name: string;
    description: string;
    authorName?: string;
    category: string;
    tags: string[];
    apps: string[];
    onboardingMd: string | null;
    readmeMd: string | null;
  }

  interface CreateSubmissionResponse {
    submission_id: string;
    template_id: string;
    upload_url: string;
    upload_expires_at: string;
  }

  interface FinalizeSubmissionResponse {
    submission_id: string;
    status: string;
    template_name: string;
  }

  interface PackageAndUploadResult {
    archiveSizeBytes: number;
  }

  interface PublishProgressPayload {
    phase: "packaging" | "uploading" | "done";
    stage?: "start" | "progress" | "complete";
    uploadedBytes?: number;
    totalBytes?: number;
    archiveSizeBytes?: number;
    error?: string;
  }

  type BundleExclusionReason =
    | "personal_memory"
    | "runtime_state"
    | "credential"
    | "ignored_dir"
    | "build_artifact"
    | "hbignore"
    | "unselected_app"
    | "system_file"
    | "user_excluded";

  interface BundleFilePayload {
    path: string;
    sizeBytes: number;
  }

  interface BundleExclusionPayload {
    path: string;
    reason: BundleExclusionReason;
    sizeBytes: number;
  }

  interface BundlePreviewPayload {
    included: BundleFilePayload[];
    excluded: BundleExclusionPayload[];
    totalIncludedBytes: number;
    totalExcludedBytes: number;
  }

  interface TemplateNameCheckPayload {
    available: boolean;
    slug: string;
    conflict: "yours" | "other" | null;
    existingTemplateId?: string | null;
    reason: "checked" | "fallback" | "invalid";
  }

  interface SubmissionRecord {
    id: string;
    author_id: string;
    author_name: string;
    template_name: string;
    template_id: string;
    version: string;
    status: "pending_review" | "published" | "rejected";
    manifest: Record<string, unknown>;
    archive_size_bytes: number;
    review_notes: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
  }

  interface SubmissionListResponse {
    submissions: SubmissionRecord[];
    count: number;
  }

  interface ElectronAPI {
    platform: string;
    versions: {
      chrome: string;
      electron: string;
      node: string;
    };
    fs: {
      listDirectory: (targetPath?: string | null, workspaceId?: string | null) => Promise<LocalDirectoryResponse>;
      readFilePreview: (targetPath: string, workspaceId?: string | null) => Promise<FilePreviewPayload>;
      writeTextFile: (targetPath: string, content: string, workspaceId?: string | null) => Promise<FilePreviewPayload>;
      writeTableFile: (targetPath: string, tableSheets: FilePreviewTableSheetPayload[], workspaceId?: string | null) => Promise<FilePreviewPayload>;
      watchFile: (targetPath: string, workspaceId?: string | null) => Promise<FilePreviewWatchSubscriptionPayload>;
      unwatchFile: (subscriptionId: string) => Promise<void>;
      createPath: (
        parentPath: string | null | undefined,
        kind: FileSystemCreateKind,
        workspaceId?: string | null,
      ) => Promise<FileSystemMutationPayload>;
      importExternalEntries: (
        destinationDirectoryPath: string,
        entries: ExplorerExternalImportEntryPayload[],
        workspaceId?: string | null,
      ) => Promise<ExplorerExternalImportResultPayload>;
      renamePath: (targetPath: string, nextName: string, workspaceId?: string | null) => Promise<FileSystemMutationPayload>;
      copyPath: (
        sourcePath: string,
        destinationDirectoryPath: string,
        workspaceId?: string | null,
      ) => Promise<FileSystemMutationPayload>;
      movePath: (
        sourcePath: string,
        destinationDirectoryPath: string,
        workspaceId?: string | null,
      ) => Promise<FileSystemMutationPayload>;
      deletePath: (targetPath: string, workspaceId?: string | null) => Promise<{ deleted: boolean }>;
      revealInFolder: (targetPath: string, workspaceId?: string | null) => Promise<{ revealed: boolean }>;
      exportFileTo: (
        targetPath: string,
        workspaceId?: string | null,
        payload?: { content?: string; suggestedName?: string },
      ) => Promise<{ path: string | null; canceled: boolean }>;
      exportHtmlToPdf: (
        payload: HtmlToPdfExportRequestPayload,
      ) => Promise<{ path: string | null; canceled: boolean }>;
      getBookmarks: (workspaceId?: string | null) => Promise<FileBookmarkPayload[]>;
      addBookmark: (targetPath: string, label?: string, workspaceId?: string | null) => Promise<FileBookmarkPayload[]>;
      removeBookmark: (bookmarkId: string) => Promise<FileBookmarkPayload[]>;
      onFileChange: (listener: (payload: FilePreviewChangePayload) => void) => () => void;
      onBookmarksChange: (listener: (bookmarks: FileBookmarkPayload[]) => void) => () => void;
    };
    diagnostics: {
      exportBundle: (
        payload?: DiagnosticsExportRequestPayload,
      ) => Promise<DiagnosticsExportPayload>;
      revealBundle: (bundlePath: string) => Promise<boolean>;
    };
    app: {
      relaunch: () => Promise<void>;
    };
    runtime: {
      getStatus: () => Promise<RuntimeStatusPayload>;
      restart: () => Promise<RuntimeStatusPayload>;
      getConfig: () => Promise<RuntimeConfigPayload>;
      getProfile: () => Promise<RuntimeUserProfilePayload>;
      getConfigDocument: () => Promise<string>;
      setConfig: (payload: RuntimeConfigUpdatePayload) => Promise<RuntimeConfigPayload>;
      setProfile: (payload: RuntimeUserProfileUpdatePayload) => Promise<RuntimeUserProfilePayload>;
      setConfigDocument: (rawDocument: string) => Promise<RuntimeConfigPayload>;
      exchangeBinding: (sandboxId: string) => Promise<RuntimeConfigPayload>;
      connectCodexOAuth: () => Promise<RuntimeConfigPayload>;
      startCodexOAuth: () => Promise<{
        userCode: string;
        intervalSeconds: number;
      }>;
      awaitCodexOAuth: () => Promise<RuntimeConfigPayload>;
      cancelCodexOAuth: () => Promise<void>;
      refreshCodexToken: () => Promise<{
        refreshed: boolean;
        accessTokenExpiresAt: string | null;
      }>;
      validateProvider: (
        providerId: string,
      ) => Promise<{ ok: boolean; detail: string }>;
      onConfigChange: (listener: (config: RuntimeConfigPayload) => void) => () => void;
      onStateChange: (listener: (status: RuntimeStatusPayload) => void) => () => void;
    };
    ui: {
      getTheme: () => Promise<string>;
      getWindowState: () => Promise<DesktopWindowStatePayload>;
      minimizeWindow: () => Promise<void>;
      toggleWindowSize: () => Promise<void>;
      closeWindow: () => Promise<void>;
      setTheme: (theme: string) => Promise<void>;
      showNativeNotification: (
        payload: DesktopNativeNotificationPayload
      ) => Promise<boolean>;
      setBadgeCount: (count: number) => Promise<void>;
      getNotificationsEnabled: () => Promise<boolean>;
      setNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
      openSettingsPane: (section?: UiSettingsPaneSection) => Promise<void>;
      openExternalUrl: (url: string) => Promise<void>;
      onWindowStateChange: (listener: (state: DesktopWindowStatePayload) => void) => () => void;
      onThemeChange: (listener: (theme: string) => void) => () => void;
      onOpenSettingsPane: (listener: (section: UiSettingsPaneSection) => void) => () => void;
      onNotificationActivated: (
        listener: (payload: { workspaceId: string; sessionId: string | null }) => void,
      ) => () => void;
    };
    clipboard: {
      readImage: () => Promise<ClipboardImagePayload | null>;
      writeText: (text: string) => Promise<void>;
    };
    bff: {
      fetch: (
        req: import("../../shared/bff-fetch-protocol").BffFetchRequest,
      ) => Promise<import("../../shared/bff-fetch-protocol").BffFetchResponse>;
    };
    appUpdate: {
      getStatus: () => Promise<AppUpdateStatusPayload>;
      checkNow: () => Promise<AppUpdateStatusPayload>;
      dismiss: (version?: string | null) => Promise<AppUpdateStatusPayload>;
      setChannel: (channel: AppUpdateChannel) => Promise<AppUpdateStatusPayload>;
      installNow: () => Promise<void>;
      onStateChange: (listener: (status: AppUpdateStatusPayload) => void) => () => void;
    };
    workbench: {
      onOpenBrowser: (listener: (payload: WorkbenchOpenBrowserPayload) => void) => () => void;
    };
    appSurface: {
      navigate(workspaceId: string, appId: string, path?: string): Promise<void>;
      setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
      reload(appId: string): Promise<void>;
      destroy(appId: string): Promise<void>;
      hide(): Promise<void>;
      resolveUrl(workspaceId: string, appId: string, path?: string): Promise<string>;
    };
    workspace: {
      getClientConfig: () => Promise<HolabossClientConfigPayload>;
      pickTemplateFolder: () => Promise<TemplateFolderSelectionPayload>;
      pickWorkspaceRuntimeFolder: () => Promise<WorkspaceRuntimeFolderSelectionPayload>;
      pickWorkspaceRelocationFolder: (workspaceId: string) => Promise<WorkspaceRuntimeFolderSelectionPayload>;
      relocate: (workspaceId: string, newPath: string) => Promise<WorkspaceResponsePayload>;
      activate: (workspaceId: string) => Promise<WorkspaceResponsePayload>;
      listImportBrowserProfiles: (
        source: BrowserImportSource
      ) => Promise<BrowserImportProfileOptionPayload[]>;
      importBrowserProfile: (
        payload: BrowserImportProfilePayload
      ) => Promise<BrowserImportSummaryPayload | null>;
      copyBrowserWorkspaceProfile: (
        payload: BrowserCopyWorkspaceProfilePayload
      ) => Promise<BrowserImportSummaryPayload>;
      listWorkspaces: () => Promise<WorkspaceListResponsePayload>;
      listWorkspacesCached: () => Promise<WorkspaceListResponsePayload>;
      getWorkspaceLifecycle: (workspaceId: string) => Promise<WorkspaceLifecyclePayload>;
      listWorkspaceCardSummaries: (
        workspaceIds: string[]
      ) => Promise<WorkspaceCardSummariesResponsePayload>;
      activateWorkspace: (workspaceId: string) => Promise<WorkspaceLifecyclePayload>;
      openWorkspace: (workspaceId: string) => Promise<WorkspaceOpenSessionPayload>;
      listInstalledApps: (workspaceId: string) => Promise<InstalledWorkspaceAppListResponsePayload>;
      removeInstalledApp: (workspaceId: string, appId: string) => Promise<void>;
      listAppCatalog: (params: { source?: "marketplace" | "local" }) => Promise<AppCatalogListResponse>;
      syncAppCatalog: (params: { source: "marketplace" | "local" }) => Promise<AppCatalogSyncResponse>;
      installAppFromCatalog: (params: InstallAppFromCatalogRequest) => Promise<InstallAppFromCatalogResponse>;
      installAppFromArchiveFile: (params: { workspaceId: string }) => Promise<InstallAppFromCatalogResponse | null>;
      listOutputs: (payload: string | WorkspaceOutputListRequestPayload) => Promise<WorkspaceOutputListResponsePayload>;
      listOutputFolders: (workspaceId: string) => Promise<WorkspaceOutputFolderListResponsePayload>;
      listSkills: (workspaceId: string) => Promise<WorkspaceSkillListResponsePayload>;
      getWorkspaceRoot: (workspaceId: string) => Promise<string>;
      createWorkspace: (payload: HolabossCreateWorkspacePayload) => Promise<WorkspaceResponsePayload>;
      createWorkspaceLab: (
        workspaceId: string,
        purpose: "workspace_onboarding" | "meeting_mode",
      ) => Promise<WorkspaceLabResponsePayload>;
      deleteWorkspace: (workspaceId: string, keepFiles?: boolean) => Promise<WorkspaceResponsePayload>;
      updateAppearance: (
        workspaceId: string,
        payload: { icon: string | null; iconColor: string | null },
      ) => Promise<WorkspaceResponsePayload>;
      listCronjobs: (workspaceId: string, enabledOnly?: boolean) => Promise<CronjobListResponsePayload>;
      runCronjobNow: (workspaceId: string, jobId: string, payload?: CronjobRunNowPayload) => Promise<CronjobRunResponsePayload>;
      createCronjob: (payload: CronjobCreatePayload) => Promise<CronjobRecordPayload>;
      updateCronjob: (workspaceId: string, jobId: string, payload: CronjobUpdatePayload) => Promise<CronjobRecordPayload>;
      deleteCronjob: (workspaceId: string, jobId: string) => Promise<{ success: boolean }>;
      listNotifications: (
        workspaceId?: string | null,
        includeDismissed?: boolean,
        options?: RuntimeNotificationListOptionsPayload
      ) => Promise<RuntimeNotificationListResponsePayload>;
      updateNotification: (
        workspaceId: string,
        notificationId: string,
        payload: RuntimeNotificationUpdatePayload
      ) => Promise<RuntimeNotificationRecordPayload>;
      listTaskProposals: (workspaceId: string) => Promise<TaskProposalListResponsePayload>;
      listBackgroundTasks: (
        payload: BackgroundTaskListRequestPayload
      ) => Promise<BackgroundTaskListResponsePayload>;
      archiveBackgroundTask: (
        payload: ArchiveBackgroundTaskPayload
      ) => Promise<ArchiveBackgroundTaskResponsePayload>;
      acceptTaskProposal: (payload: TaskProposalAcceptPayload) => Promise<TaskProposalAcceptResponsePayload>;
      updateTaskProposalState: (
        workspaceId: string,
        proposalId: string,
        state: string
      ) => Promise<TaskProposalStateUpdatePayload>;
      ensureMainSession: (workspaceId: string) => Promise<EnsureWorkspaceMainSessionResponsePayload>;
      listAgentSessions: (
        payload: string | ListAgentSessionsRequestPayload
      ) => Promise<AgentSessionListResponsePayload>;
      createAgentSession: (payload: CreateAgentSessionPayload) => Promise<CreateAgentSessionResponsePayload>;
      listRuntimeStates: (workspaceId: string) => Promise<SessionRuntimeStateListResponsePayload>;
      getSessionHistory: (payload: SessionHistoryRequestPayload) => Promise<SessionHistoryResponsePayload>;
      getSessionOutputEvents: (payload: SessionOutputEventListRequestPayload) => Promise<SessionOutputEventListResponsePayload>;
      stageSessionAttachments: (payload: StageSessionAttachmentsPayload) => Promise<StageSessionAttachmentsResponsePayload>;
      stageSessionAttachmentPaths: (
        payload: StageSessionAttachmentPathsPayload
      ) => Promise<StageSessionAttachmentsResponsePayload>;
      queueSessionInput: (payload: HolabossQueueSessionInputPayload) => Promise<EnqueueSessionInputResponsePayload>;
      getOnboardingStatus: (workspaceId: string) => Promise<WorkspaceOnboardingStatusPayload>;
      continueDeterministicOnboarding: (
        workspaceId: string
      ) => Promise<WorkspaceResponsePayload>;
      skipWorkspaceOnboarding: (
        workspaceId: string
      ) => Promise<WorkspaceResponsePayload>;
      answerOnboardingAlignmentQuestion: (
        workspaceId: string,
        payload: {
          model?: string | null;
          thinkingValue?: string | null;
          optionId?: string | null;
          responseText?: string | null;
          notes?: string | null;
          answers?: Array<{
            questionId?: string | null;
            optionId?: string | null;
            responseText?: string | null;
            notes?: string | null;
          }>;
        }
      ) => Promise<WorkspaceOnboardingStatusPayload>;
      approveOnboardingAlignment: (workspaceId: string) => Promise<WorkspaceOnboardingStatusPayload>;
      requestOnboardingAlignmentRevision: (workspaceId: string) => Promise<WorkspaceOnboardingStatusPayload>;
      requestOnboardingVerificationRevision: (workspaceId: string) => Promise<WorkspaceOnboardingStatusPayload>;
      completeOnboarding: (
        workspaceId: string,
        payload: { summary: string; requestedBy?: string | null }
      ) => Promise<WorkspaceOnboardingStatusPayload | WorkspaceLabResponsePayload>;
      pauseSessionRun: (payload: HolabossPauseSessionRunPayload) => Promise<PauseSessionRunResponsePayload>;
      updateQueuedSessionInput: (
        payload: HolabossUpdateQueuedSessionInputPayload
      ) => Promise<UpdateQueuedSessionInputResponsePayload>;
      cancelQueuedSessionInput: (
        payload: HolabossCancelQueuedSessionInputPayload
      ) => Promise<CancelQueuedSessionInputResponsePayload>;
      openSessionOutputStream: (payload: HolabossStreamSessionOutputsPayload) => Promise<HolabossSessionStreamHandlePayload>;
      closeSessionOutputStream: (streamId: string, reason?: string) => Promise<void>;
      getSessionStreamDebug: () => Promise<HolabossSessionStreamDebugEntry[]>;
      isVerboseTelemetryEnabled: () => Promise<boolean>;
      listIntegrationCatalog: () => Promise<IntegrationCatalogResponsePayload>;
      listIntegrationConnections: (params?: { providerId?: string; ownerUserId?: string }) => Promise<IntegrationConnectionListResponsePayload>;
      listIntegrationBindings: (workspaceId: string) => Promise<IntegrationBindingListResponsePayload>;
      getWorkspaceDefaultAccount: (workspaceId: string, providerId: string) => Promise<{ connection_id: string | null }>;
      setWorkspaceDefaultAccount: (workspaceId: string, providerId: string, connectionId: string) => Promise<{ connection_id: string }>;
      upsertIntegrationBinding: (workspaceId: string, targetType: string, targetId: string, integrationKey: string, payload: IntegrationUpsertBindingPayload) => Promise<IntegrationBindingPayload>;
      createIntegrationConnection: (payload: IntegrationCreateConnectionPayload) => Promise<IntegrationConnectionPayload>;
      updateIntegrationConnection: (connectionId: string, payload: IntegrationUpdateConnectionPayload) => Promise<IntegrationConnectionPayload>;
      deleteIntegrationConnection: (connectionId: string) => Promise<{ deleted: boolean }>;
      mergeIntegrationConnections: (
        keepConnectionId: string,
        removeConnectionIds: string[]
      ) => Promise<IntegrationMergeConnectionsResult>;
      deleteIntegrationBinding: (bindingId: string, workspaceId: string) => Promise<{ deleted: boolean }>;
      listConnectionWorkspaceUsage: () => Promise<ConnectionWorkspaceUsagePayload>;
      listComposioToolkitCapabilities: () => Promise<ComposioToolkitCapabilitiesPayload>;
      listIntegrationStoreCatalog: () => Promise<IntegrationStoreCatalogPayload>;
      listAllWorkspaceIntegrationOverrides: () => Promise<AllWorkspaceIntegrationOverridesPayload>;
      listWorkspaceIntegrations: (workspaceId: string) => Promise<WorkspaceIntegrationsListResponsePayload>;
      listMemoryBrowserTree: (workspaceId: string) => Promise<MemoryBrowserTreeResponsePayload>;
      readMemoryBrowserFile: (
        workspaceId: string,
        targetPath: string
      ) => Promise<MemoryBrowserFileResponsePayload>;
      listMemoryBrowserGraph: (
        workspaceId: string,
        params: { forest: MemoryBrowserGraphForestPayload; treeId?: string | null }
      ) => Promise<MemoryBrowserGraphResponsePayload>;
      setWorkspaceIntegrationOverride: (
        workspaceId: string,
        toolkitSlug: string,
        payload: { state: "disabled" | "pinned"; pinned_connection_id?: string | null }
      ) => Promise<WorkspaceIntegrationOverridePayload>;
      clearWorkspaceIntegrationOverride: (
        workspaceId: string,
        toolkitSlug: string
      ) => Promise<{ deleted: boolean }>;
      listOAuthConfigs: () => Promise<OAuthAppConfigListResponsePayload>;
      upsertOAuthConfig: (providerId: string, payload: OAuthAppConfigUpsertPayload) => Promise<OAuthAppConfigPayload>;
      deleteOAuthConfig: (providerId: string) => Promise<{ deleted: boolean }>;
      startOAuthFlow: (provider: string) => Promise<OAuthAuthorizeResponsePayload>;
      composioListToolkits: () => Promise<{ toolkits: Array<{ slug: string; name: string; description: string; logo: string | null; auth_schemes: string[]; categories: string[] }> }>;
      composioListConnections: () => Promise<{ connections: Array<{ id: string; toolkitSlug: string; toolkitName: string; toolkitLogo: string | null; userId: string; createdAt: string }> }>;
      composioExecute: (params: {
        providerSlug: string;
        toolSlug: string;
        arguments?: Record<string, unknown>;
      }) => Promise<unknown>;
      debugComposioRuntimeTest: (params?: {
        providerSlug?: string;
        toolSlug?: string;
        arguments?: Record<string, unknown>;
      }) => Promise<unknown>;
      fetchIntegrationContext: (
        connectionId: string
      ) => Promise<IntegrationContextFetchStartResponsePayload>;
      listIntegrationContextFetchStatuses: (
        connectionIds?: string[]
      ) => Promise<IntegrationContextFetchStatusListResponsePayload>;
      clearIntegrationMemory: (
        connectionId: string
      ) => Promise<IntegrationMemoryClearResponsePayload>;
      restartApp: (workspaceId: string, appId: string) => Promise<{
        workspace_id: string;
        app_id: string;
        restarted: boolean;
      }>;
      composioConnect: (payload: {
        provider: string;
        owner_user_id: string;
        callback_url?: string;
        // Optional whoami descriptor forwarded to Hono and stashed against
        // `connected_account_id` so the profile-fetch path can resolve
        // handle / email / display_name / avatar from the provider's /me
        // endpoint without a Hono-side per-toolkit constant. Shape mirrors
        // `WhoamiConfig` in runtime/api-server/src/integration-types.ts.
        whoami?: PendingIntegrationWhoami | null;
      }) => Promise<ComposioConnectResult>;
      composioAccountStatus: (
        connectedAccountId: string,
        providerId?: string | null,
      ) => Promise<ComposioAccountStatus>;
      composioFinalize: (payload: {
        connected_account_id: string;
        provider: string;
        owner_user_id: string;
        account_label?: string;
        account_handle?: string | null;
        account_email?: string | null;
      }) => Promise<IntegrationConnectionPayload>;
      composioRefreshConnection: (connectionId: string) => Promise<{
        connection: IntegrationConnectionPayload;
        changed: boolean;
        reason?: "no_external_id" | "account_missing" | "no_new_identity";
      }>;
      composioDeleteUpstream: (connectedAccountId: string) => Promise<{
        deleted: boolean;
        missing: boolean;
      }>;
      composioMcpEnsureRunning: (workspaceId: string) => Promise<unknown>;
      resolveTemplateIntegrations: (payload: HolabossCreateWorkspacePayload) => Promise<ResolveTemplateIntegrationsResult>;
      generateTemplateContent(params: {
        contentType: "onboarding" | "readme";
        name: string;
        description: string;
        category: string;
        tags: string[];
        apps: string[];
      }): Promise<{ content: string }>;
      createSubmission(payload: CreateSubmissionPayload): Promise<CreateSubmissionResponse>;
      packageAndUploadWorkspace(params: {
        workspaceId: string;
        apps: string[];
        manifest: Record<string, unknown>;
        uploadUrl: string;
        forceExcludePaths?: string[];
      }): Promise<PackageAndUploadResult>;
      onPublishProgress: (
        listener: (payload: PublishProgressPayload) => void,
      ) => () => void;
      previewBundle(params: {
        workspaceId: string;
        apps: string[];
        forceExcludePaths?: string[];
      }): Promise<BundlePreviewPayload>;
      checkTemplateName(name: string): Promise<TemplateNameCheckPayload>;
      finalizeSubmission(submissionId: string): Promise<FinalizeSubmissionResponse>;
      listSubmissions(): Promise<SubmissionListResponse>;
      deleteSubmission(submissionId: string): Promise<{ deleted: boolean }>;
      setOperatorSurfaceContext(workspaceId: string, context: OperatorSurfaceContextPayload | null): Promise<void>;
      onSessionStreamEvent: (listener: (payload: HolabossSessionStreamEventPayload) => void) => () => void;
    };
    auth: {
      getUser: () => Promise<AuthUserPayload | null>;
      // Renderer-side BFF clients reach the API via the bff.fetch bridge —
      // these accessors expose only the host URLs the renderer should target.
      getApiBaseUrl: () => Promise<string>;
      getMarketplaceBaseUrl: () => Promise<string>;
      requestAuth: () => Promise<void>;
      signOut: () => Promise<void>;
      showPopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
      togglePopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
      scheduleClosePopup: (delayMs?: number) => Promise<void>;
      cancelClosePopup: () => Promise<void>;
      closePopup: () => Promise<void>;
      onAuthenticated: (callback: (user: AuthUserPayload) => unknown) => () => void;
      onUserUpdated: (callback: (user: AuthUserPayload | null) => unknown) => () => void;
      onError: (callback: (context: AuthErrorPayload) => unknown) => () => void;
    };
    browser: {
      setActiveWorkspace: (
        workspaceId?: string | null,
        space?: BrowserSpaceId | null,
        sessionId?: string | null,
      ) => Promise<BrowserTabListPayload>;
      getState: () => Promise<BrowserTabListPayload>;
      setBounds: (bounds: BrowserBoundsPayload) => Promise<BrowserTabListPayload>;
      captureVisibleSnapshot: () => Promise<BrowserVisibleSnapshotPayload | null>;
      navigate: (targetUrl: string) => Promise<BrowserTabListPayload>;
      back: () => Promise<BrowserTabListPayload>;
      forward: () => Promise<BrowserTabListPayload>;
      reload: () => Promise<BrowserTabListPayload>;
      stopLoading: () => Promise<BrowserTabListPayload>;
      captureScreenshotToClipboard: () => Promise<BrowserClipboardScreenshotPayload>;
      newTab: (targetUrl?: string) => Promise<BrowserTabListPayload>;
      setActiveTab: (tabId: string) => Promise<BrowserTabListPayload>;
      closeTab: (tabId: string) => Promise<BrowserTabListPayload>;
      getBookmarks: () => Promise<BrowserBookmarkPayload[]>;
      addBookmark: (payload: { url: string; title?: string }) => Promise<BrowserBookmarkPayload[]>;
      removeBookmark: (bookmarkId: string) => Promise<BrowserBookmarkPayload[]>;
      getDownloads: () => Promise<BrowserDownloadPayload[]>;
      getHistory: () => Promise<BrowserHistoryEntryPayload[]>;
      showAddressSuggestions: (
        anchorBounds: BrowserAnchorBoundsPayload,
        suggestions: AddressSuggestionPayload[],
        selectedIndex: number
      ) => Promise<void>;
      hideAddressSuggestions: () => Promise<void>;
      toggleOverflowPopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
      onOpenImportProfile: (listener: () => void) => () => void;
      toggleHistoryPopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
      removeHistoryEntry: (historyId: string) => Promise<BrowserHistoryEntryPayload[]>;
      clearHistory: () => Promise<BrowserHistoryEntryPayload[]>;
      toggleDownloadsPopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
      showDownloadInFolder: (downloadId: string) => Promise<boolean>;
      openDownload: (downloadId: string) => Promise<string>;
      closeDownloadsPopup: () => Promise<void>;
      onStateChange: (listener: (state: BrowserTabListPayload) => void) => () => void;
      onBookmarksChange: (listener: (bookmarks: BrowserBookmarkPayload[]) => void) => () => void;
      onDownloadsChange: (listener: (downloads: BrowserDownloadPayload[]) => void) => () => void;
      onHistoryChange: (listener: (history: BrowserHistoryEntryPayload[]) => void) => () => void;
      onAddressSuggestionChosen: (listener: (index: number) => void) => () => void;
    };
  }

  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
