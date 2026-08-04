/// <reference types="vite/client" />

import type {
	ChatStartInput,
	InstallEventPayload,
	InstalledList,
	InstallResult,
	InstallStatusEventPayload,
	OpenAppEventPayload,
	ShareDraft,
} from "@holaboss/app-host/protocol";
import type { IWorkbookData } from "@univerjs/core";

declare global {
	/** Payload of the `host:openChat` event main emits after a hosted HolaApp
	 * page calls `window.__holabossHost.chat.start` (the session is already
	 * created). The shell opens it + prefills the composer. */
	interface HostOpenChatPayload {
		session: MainSessionRecordPayload;
		input: ChatStartInput;
		sourceAppId: string;
	}

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
		| "video"
		| "pdf"
		| "table"
		| "presentation"
		| "document"
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
		univerSnapshot?: IWorkbookData;
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

	type UiSettingsPaneSection =
		| "account"
		| "billing"
		| "byok"
		| "providers"
		| "agents"
		| "integrations"
		| "channels"
		| "memory"
		| "submissions"
		| "settings"
		| "experimental";

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

	interface MemoryBrowserNodeEvidenceRefPayload {
		ref_id: string;
		provider: string | null;
		account_namespace: string | null;
		connection_id: string | null;
		external_object_id: string | null;
		external_object_type: string | null;
		source_type: string | null;
		source_event_id: string | null;
		source_message_id: string | null;
		source_turn_input_id: string | null;
		observed_at: string | null;
		metadata: Record<string, unknown>;
	}

	interface MemoryBrowserNodeRelationPayload {
		relation_type: string;
		source_node_id: string;
		source_label: string | null;
		source_tree_id: string | null;
		target_node_id: string;
		target_label: string | null;
		target_tree_id: string | null;
		target_entity_key: string | null;
		target_resolution_kind: "resolved" | "synthetic" | "missing";
		metadata: Record<string, unknown>;
	}

	interface MemoryBrowserNodeDetailResponsePayload {
		workspace_id: string;
		node_id: string;
		tree_id: string | null;
		category: "workspace";
		kind: MemoryBrowserGraphNodeKindPayload | null;
		label: string | null;
		subtitle: string | null;
		path: string | null;
		evidence_refs: MemoryBrowserNodeEvidenceRefPayload[];
		outgoing_relations: MemoryBrowserNodeRelationPayload[];
		incoming_relations: MemoryBrowserNodeRelationPayload[];
	}

	type MemoryBrowserGraphForestPayload = "workspace";
	type MemoryBrowserGraphNodeKindPayload =
		| "root"
		| "section"
		| "tree"
		| "node"
		| "summary"
		| "leaf";

	interface MemoryBrowserGraphNodePayload {
		id: string;
		kind: MemoryBrowserGraphNodeKindPayload;
		category: "workspace";
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

	interface MemoryBrowserGraphLimitsPayload {
		max_layers: number;
		max_nodes: number;
		total_nodes: number;
		total_edges: number;
		displayed_nodes: number;
		displayed_edges: number;
		truncated_by_layers: boolean;
		truncated_by_nodes: boolean;
	}

	interface MemoryBrowserGraphResponsePayload {
		workspace_id: string;
		forest: MemoryBrowserGraphForestPayload;
		focus_tree_id: string | null;
		nodes: MemoryBrowserGraphNodePayload[];
		edges: MemoryBrowserGraphEdgePayload[];
		limits: MemoryBrowserGraphLimitsPayload;
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

	type BrowserSpaceId = "agent";
	type OperatorSurfaceType = "browser" | "editor" | "terminal" | "app_surface";
	type OperatorSurfaceOwner = "user" | "agent";
	type OperatorSurfaceMutability =
		| "inspect_only"
		| "takeover_allowed"
		| "agent_owned";

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
		agent: number;
	}

	interface FingerprintPayload {
		seed: number;
		platform: "windows" | "macos" | "linux";
		gpuVendor?: string;
		gpuRenderer?: string;
		hardwareConcurrency?: number;
		deviceMemory?: number;
		screenWidth?: number;
		screenHeight?: number;
		brand?: "Chrome" | "Edge" | "Opera" | "Vivaldi";
		brandVersion?: string;
		platformVersion?: string;
		timezone?: string;
		locale?: string;
		noise?: boolean;
		webrtcIp?: string;
		fontsDir?: string;
		storageQuota?: number;
	}

	interface ProfileProxyPayload {
		server: string;
		username?: string;
		password?: string;
		geoip?: boolean;
	}

	interface BrowserProfilePayload {
		id: string;
		name: string;
		createdAt: string;
		source: string;
		importedFrom?: string;
		engine?: "system" | "fingerprint";
		fingerprint?: FingerprintPayload;
		proxy?: ProfileProxyPayload;
		/** True for the pinned default browser the agent drives when none is named. */
		isDefault?: boolean;
	}

	interface FingerprintTemplatePayload {
		id: string;
		name: string;
		createdAt: string;
		source: "builtin" | "imported" | "captured" | "user";
		fingerprint: Omit<FingerprintPayload, "seed"> & { seed?: number };
	}

	interface ProfileImportRequestPayload {
		source: Exclude<BrowserImportSource, "safari">;
		profileDir: string;
		profileLabel?: string | null;
		name?: string | null;
	}

	interface ProfileImportResultPayload {
		profile: BrowserProfilePayload;
		copiedLocalState: boolean;
		matchedBinaryAvailable: boolean;
		/** Windows: decrypted cookies captured from the source to seed the login. */
		cookiesCaptured: number;
		/** Set when the Windows cookie transfer couldn't run (e.g. source open). */
		cookieTransferWarning: string | null;
	}

	interface BrowserTabListPayload {
		space: BrowserSpaceId;
		activeTabId: string;
		tabs: BrowserStatePayload[];
		tabCounts: BrowserTabCountsPayload;
		sessionId: string | null;
		lifecycleState: "active" | "suspended" | null;
		controlMode: "none" | "session_owned";
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

	type BrowserDownloadStatus =
		| "progressing"
		| "completed"
		| "cancelled"
		| "interrupted";

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

	type RuntimeStatus =
		| "disabled"
		| "missing"
		| "starting"
		| "running"
		| "stopped"
		| "error";

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

	interface DbMaintenanceStatusPayload {
		phase: "idle" | "estimating" | "pruning" | "done";
		heavy: boolean;
		deletedRows: number;
		estimatedRows: number;
		done: boolean;
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
		timezone: string | null;
		nameSource: RuntimeUserProfileNameSource | null;
		createdAt: string | null;
		updatedAt: string | null;
	}

	interface RuntimeUserProfileUpdatePayload {
		profileId?: string | null;
		name?: string | null;
		timezone?: string | null;
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

	type ImplementationActivity = "running" | "queued" | "idle" | "failed";

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
		alignment_report?:
			| import("../../../../shared/onboarding-contract").OnboardingAlignmentReport
			| null;
		verification_report?: Record<string, unknown> | null;
		onboarding_completed_at: string | null;
		onboarding_completion_summary: string | null;
		onboarding_requested_at: string | null;
		onboarding_requested_by: string | null;
		implementation_activity?: ImplementationActivity | null;
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

	interface WorkspaceListResponsePayload {
		items: WorkspaceRecordPayload[];
		total: number;
		limit: number;
		offset: number;
	}

	type BrowserImportSource =
		| "chrome"
		| "chromium"
		| "arc"
		| "edge"
		| "brave"
		| "dia"
		| "safari";

	interface BrowserImportProfileOptionPayload {
		profileId: string;
		profileLabel: string;
		profileDir: string;
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
		workflow_run_id: string | null;
		workflow_id: string | null;
		workflow_trigger_kind: string | null;
		issue_id: string | null;
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

	type IssueStatusPayload =
		| "backlog"
		| "todo"
		| "in_progress"
		| "in_review"
		| "done"
		| "blocked";
	type IssuePriorityPayload = "critical" | "high" | "medium" | "low";

	interface IssueAttachmentPayload {
		id: string;
		kind: "image" | "file" | "folder";
		name: string;
		mime_type: string;
		size_bytes: number;
		workspace_path: string;
		created_at: string;
	}

	interface IssueBlockedByPayload {
		task_id: string;
		relation?: string | null;
		instruction?: string | null;
	}

	interface IssueRecordPayload {
		issue_id: string;
		workspace_id: string;
		issue_number: number;
		session_id: string;
		blocked_by: IssueBlockedByPayload[];
		title: string;
		description: string | null;
		status: IssueStatusPayload;
		priority: IssuePriorityPayload | null;
		blocker_reason: string | null;
		attachments: IssueAttachmentPayload[];
		active_subagent_id: string | null;
		latest_subagent_id: string | null;
		created_by: string | null;
		created_at: string;
		updated_at: string;
		completed_at: string | null;
	}

	interface IssueListResponsePayload {
		issues: IssueRecordPayload[];
		count: number;
	}

	interface CreateIssuePayload {
		workspace_id: string;
		blocked_by?: IssueBlockedByPayload[] | null;
		title: string;
		description?: string | null;
		status: IssueStatusPayload;
		priority?: IssuePriorityPayload | null;
		blocker_reason?: string | null;
		attachments?: SessionInputAttachmentPayload[] | null;
	}

	interface CreateIssueResponsePayload {
		issue: IssueRecordPayload;
		session: AgentSessionRecordPayload | null;
	}

	interface UpdateIssuePayload {
		workspace_id: string;
		blocked_by?: IssueBlockedByPayload[] | null;
		title?: string | null;
		description?: string | null;
		status?: IssueStatusPayload;
		priority?: IssuePriorityPayload | null;
		blocker_reason?: string | null;
		attachments?: SessionInputAttachmentPayload[] | null;
	}

	interface UpdateIssueResponsePayload {
		issue: IssueRecordPayload;
	}

	interface StopIssueRunResponsePayload {
		issue: IssueRecordPayload;
	}

	interface ContinueBackgroundTaskPayload {
		workspaceId: string;
		subagentId: string;
		ownerMainSessionId: string;
		instruction: string;
		title?: string | null;
	}

	type ContinueBackgroundTaskResponsePayload = Record<string, unknown>;

	interface EnsureWorkspaceMainSessionResponsePayload {
		/** Null when resolving with `create: false` and the workspace has no
		 *  primary chat yet (the renderer opens a lazy draft in that case). */
		session: AgentSessionRecordPayload | null;
	}

	interface MainSessionRecordPayload extends AgentSessionRecordPayload {
		is_active: boolean;
	}

	interface ListMainSessionsResponsePayload {
		sessions: MainSessionRecordPayload[];
	}

	interface CreateMainSessionPayload {
		title?: string | null;
		/** When non-null, binds the new session to a project so the run uses
		 * the project's path as cwd. Null = General (workspace-scoped). */
		project_id?: string | null;
		/** Harness picked at session start (e.g. "pi" for Hola, "claude-code",
		 * "codex"). Immutable after creation; switching harnesses mid-session
		 * is not supported. Omit to inherit the workspace default. */
		harness_id?: string | null;
		/** Owning HolaApp. When set, the runtime does NOT promote the session to the
		 * workspace's active main_session — it belongs to the app. */
		app_id?: string | null;
	}

	interface CreateMainSessionResponsePayload {
		session: MainSessionRecordPayload;
	}

	interface ActivateMainSessionResponsePayload {
		session: MainSessionRecordPayload;
	}

	interface UpdateMainSessionPayload {
		title?: string | null;
	}

	interface UpdateMainSessionResponsePayload {
		session: MainSessionRecordPayload;
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
		workflow_run_id?: string | null;
		workflow_id?: string | null;
		workflow_trigger_kind?: string | null;
		proposal_id?: string | null;
		project_id?: string | null;
		/** Harness bound to this session (e.g. "pi", "claude-code", "codex").
		 * Mutable only while the session has zero inputs; once a turn is
		 * queued the runtime locks it. */
		harness_id?: string | null;
		/** The session's effective model — an automation's pinned model, else the
		 * most recent model-bearing turn. Lets the composer reflect the model THIS
		 * session runs instead of the global preference. Null => no session model
		 * yet (composer falls back to the global default that seeds new chats). */
		selected_model?: string | null;
		/** The HolaApp that owns this session, or null for a workspace/project
		 * session. App sessions are listed via the app's dropdown, not the sidebar. */
		owning_app_id?: string | null;
		created_at: string;
		updated_at: string;
		archived_at: string | null;
		active_user_question?: Record<string, unknown> | null;
	}

	interface WorkspaceProjectRecordPayload {
		workspace_id: string;
		project_id: string;
		name: string;
		project_path: string;
		icon: string | null;
		icon_color: string | null;
		created_at: string;
		updated_at: string;
	}

	interface ListWorkspaceProjectsResponsePayload {
		items: WorkspaceProjectRecordPayload[];
	}

	interface WorkspaceConfigYamlPayload {
		/** Absolute path to the workspace.yaml on disk. */
		path: string;
		/** False when the file does not exist yet (content is then empty). */
		exists: boolean;
		/** Raw file contents, verbatim. */
		content: string;
	}

	interface WorkspaceMcpServerEntryPayload {
		id: string;
		transport: "remote" | "local";
		enabled: boolean;
		url?: string;
		command?: string[];
		/** True when auto-registered by an installed workspace app (vs connected
		 *  by the user/agent via mcp_connect). */
		appManaged: boolean;
		/** The app container that owns this server, when app-managed. Groups
		 *  app-owned servers under their app; standalone servers have no owner. */
		ownerAppId?: string;
	}

	interface WorkspaceMcpServersPayload {
		servers: WorkspaceMcpServerEntryPayload[];
	}

	interface DeleteWorkspaceMcpServerResponsePayload {
		removed: boolean;
		server_id: string;
	}

	interface HarnessAvailabilityCapabilitiesPayload {
		requiresBackend: boolean;
		supportsStructuredOutput: boolean;
		supportsWaitingUser: boolean;
		supportsSkills: boolean;
		supportsMcpTools: boolean;
	}

	interface HarnessSupportedModelPayload {
		id: string;
		label: string;
		provider: string;
		default?: boolean;
	}

	interface HarnessAvailabilityEntryPayload {
		id: string;
		display_name: string;
		capabilities: HarnessAvailabilityCapabilitiesPayload;
		/** False when the CLI binary couldn't be found on PATH. The picker
		 * should still list the entry but disable selection. */
		available: boolean;
		/** Either the resolved binary path or a one-line install hint. */
		detection: string;
		/** Models this harness's host runner accepts. Empty means the
		 * harness uses the runtime model catalogue (pi/Hola); non-empty
		 * means this harness has its own namespace and the desktop should
		 * render a picker scoped to these entries. */
		supported_models: HarnessSupportedModelPayload[];
	}

	interface ListHarnessAvailabilityResponsePayload {
		harnesses: HarnessAvailabilityEntryPayload[];
	}

	/** Result of a live "test connection" run — the runtime executes the harness
	 *  with a tiny prompt and reports whether it responded. */
	interface HarnessConnectionTestResultPayload {
		ok: boolean;
		/** Output snippet on success, or the error/reason on failure. */
		detail: string;
		duration_ms: number;
	}

	interface UpdateSessionHarnessResponsePayload {
		session: AgentSessionRecordPayload;
	}

	interface CreateWorkspaceProjectPayload {
		name: string;
		project_path: string;
		/** When true, the runtime calls mkdir -p on project_path. */
		create_if_missing?: boolean;
		icon?: string | null;
		icon_color?: string | null;
	}

	interface CreateWorkspaceProjectResponsePayload {
		project: WorkspaceProjectRecordPayload;
	}

	interface UpdateWorkspaceProjectPayload {
		name?: string;
		icon?: string | null;
		icon_color?: string | null;
	}

	interface UpdateWorkspaceProjectResponsePayload {
		project: WorkspaceProjectRecordPayload;
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
		project_id?: string | null;
		created_by?: string | null;
		/** Owning HolaApp — stamps owning_app_id on the created session. */
		app_id?: string | null;
	}

	interface CreateAgentSessionResponsePayload {
		session: AgentSessionRecordPayload;
	}

	interface CronjobDeliveryPayload {
		mode: string;
		channel: string;
		to: string | null;
	}

	interface CronjobRecordPayload {
		id: string;
		workflow_id: string;
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
		workflow_id: string;
		workflow_run_id: string;
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
		owner_main_session_id?: string | null;
	}

	type RuntimeNotificationLevel = "info" | "success" | "warning" | "error";
	type RuntimeNotificationPriority = "low" | "normal" | "high" | "critical";
	type RuntimeNotificationState = "unread" | "read" | "dismissed";

	interface RuntimeNotificationRecordPayload {
		id: string;
		workspace_id: string;
		cronjob_id: string | null;
		workflow_id: string | null;
		workflow_run_id: string | null;
		workflow_trigger_kind: string | null;
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

	interface SessionTurnResultPayload {
		workspace_id: string;
		session_id: string;
		input_id: string;
		started_at: string;
		completed_at: string | null;
		status: string;
		stop_reason: string | null;
		assistant_text: string;
		tool_usage_summary: Record<string, unknown>;
		permission_denials: Array<Record<string, unknown>>;
		prompt_section_ids: string[];
		capability_manifest_fingerprint: string | null;
		request_snapshot_fingerprint: string | null;
		prompt_cache_profile: Record<string, unknown> | null;
		context_budget_decisions: Record<string, unknown> | null;
		token_usage: Record<string, unknown> | null;
		created_at: string;
		updated_at: string;
	}

	interface SessionTurnResultListRequestPayload {
		workspaceId: string;
		sessionId?: string | null;
		inputId?: string | null;
		status?: string | null;
		limit?: number;
		offset?: number;
		order?: "asc" | "desc";
	}

	interface SessionTurnResultListResponsePayload {
		workspace_id: string;
		session_id: string | null;
		items: SessionTurnResultPayload[];
		count: number;
		total: number;
		limit: number;
		offset: number;
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

	interface HolabossAnswerUserQuestionAnswer {
		question_id: string;
		option_id?: string | null;
		response_text?: string | null;
		notes?: string | null;
	}

	interface HolabossAnswerUserQuestionPayload {
		workspace_id: string;
		session_id: string;
		answers: HolabossAnswerUserQuestionAnswer[];
		model?: string | null;
		thinking_value?: string | null;
	}

	interface AnswerUserQuestionResponsePayload {
		workspace_id: string;
		session_id: string;
		active_user_question?: Record<string, unknown> | null;
		input_id?: string;
		status?: string;
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
		project_id: string | null;
		metadata: Record<string, unknown>;
		created_at: string;
		updated_at: string;
	}

	type WorkspaceActivityProducerKind = "teammate" | "plugin" | "unknown";

	interface WorkspaceActivityProducerPayload {
		producer_id: string;
		producer_name: string;
		producer_kind: WorkspaceActivityProducerKind;
		count: number;
	}

	interface WorkspaceActivityResponsePayload {
		workspace_id: string;
		date: string;
		outputs: WorkspaceOutputRecordPayload[];
		by_producer: WorkspaceActivityProducerPayload[];
		total: number;
	}

	interface WorkspaceOutputSearchDateRangePayload {
		start?: string | null;
		end?: string | null;
	}

	interface WorkspaceOutputSearchFiltersPayload {
		producerId?: string | null;
		dateRange?: WorkspaceOutputSearchDateRangePayload | null;
	}

	interface WorkspaceOutputSearchRequestPayload {
		workspaceId: string;
		query: string;
		filters?: WorkspaceOutputSearchFiltersPayload;
		limit?: number;
		offset?: number;
	}

	interface WorkspaceOutputSearchResultPayload {
		output: WorkspaceOutputRecordPayload;
		snippet: string;
	}

	interface WorkspaceOutputSearchResponsePayload {
		results: WorkspaceOutputSearchResultPayload[];
		total: number;
	}

	interface WorkspaceOutputCreatePayload {
		workspaceId: string;
		outputType: string;
		title?: string | null;
		filePath?: string | null;
		status?: string | null;
		sessionId?: string | null;
		inputId?: string | null;
		metadata?: Record<string, unknown>;
	}

	interface WorkspaceOutputCreateResponsePayload {
		output: WorkspaceOutputRecordPayload;
	}

	interface ArtifactTemplateRecordPayload {
		id: string;
		name: string;
		description: string | null;
		category: string | null;
		ext: string;
		outputType: string;
		fileName: string;
		createdAt: string;
	}

	interface ArtifactTemplateListResponsePayload {
		templates: ArtifactTemplateRecordPayload[];
	}

	interface ArtifactTemplatePreviewPayload {
		kind: "text" | "image" | "none";
		text?: string;
		dataUrl?: string;
	}

	interface SaveOutputAsArtifactTemplatePayload {
		workspaceId: string;
		filePath: string;
		outputType: string;
		name: string;
		description?: string | null;
		category?: string | null;
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

	/** A tenant the signed-in user belongs to (Better-Auth organization). The
	 * desktop's profile selector switches the *active* one; "Personal" is the
	 * user's team-of-one org. Shape mirrors the org plugin's list rows — kept
	 * forgiving (index signature) since the renderer only needs id/name/slug. */
	interface DesktopOrganizationPayload {
		id: string;
		name: string;
		slug?: string | null;
		logo?: string | null;
		createdAt?: string;
		metadata?: unknown;
		[key: string]: unknown;
	}

	/** One member of an organization (Better-Auth member row + joined user). */
	interface DesktopOrgMemberPayload {
		id: string;
		userId: string;
		role: string;
		user?: { name?: string | null; email?: string | null } | null;
		[key: string]: unknown;
	}

	/** One pending (or resolved) invitation to an organization. */
	interface DesktopOrgInvitationPayload {
		id: string;
		email: string;
		role?: string | null;
		status: string;
		[key: string]: unknown;
	}

	/** The full active organization (getFullOrganization) — adds the member
	 * roster (with the acting user's role) used to gate org-admin affordances. */
	interface DesktopActiveOrganizationPayload
		extends DesktopOrganizationPayload {
		members?: DesktopOrgMemberPayload[];
		invitations?: DesktopOrgInvitationPayload[];
	}

	// Mirrors shared/composio-events-protocol.ts — duplicated here so the
	// ambient ElectronAPI surface doesn't need a module import.
	interface ComposioConnectionInvalidatedEventPayload {
		type: "connection.invalidated";
		/** Composio connected_account_id (ca_xxx) — match against account_external_id. */
		connection_id: string;
		/** Original Composio event type, e.g. `composio.connected_account.expired`. */
		event_type: string;
		received_at: number;
	}

	type ComposioEventsBridgeStatusPayload =
		| { state: "idle"; reason?: string }
		| { state: "connecting" }
		| { state: "open" }
		| { state: "reconnecting"; nextAttemptInMs: number; attempt: number }
		| { state: "stopped"; reason: string };

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
		/** Ambient context about the open HolaApp/surface (the "user currently has
		 * <app> open …" block + the app's MCP tool hint). Sent to the AGENT only —
		 * the runtime folds it into the turn instruction and never persists it as
		 * the user message, so the visible bubble stays exactly what the user typed. */
		app_context_text?: string | null;
		workspace_id: string;
		image_urls: string[] | null;
		attachments?: SessionInputAttachmentPayload[] | null;
		session_id?: string | null;
		idempotency_key?: string | null;
		priority?: number;
		model?: string | null;
		thinking_value?: string | null;
		/** Owning HolaApp — stamps owning_app_id when this lazily creates the session. */
		app_id?: string | null;
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

	interface HolaEmployeeSummaryPayload {
		employeeId: string;
		name: string;
		mandate?: string;
		model?: string;
		connectorCount?: number;
		/** The permanent preset "Hola" employee — wears the Holaboss brand mark and
		 *  can't be archived. */
		preset?: boolean;
		/** Deterministic avatar (bg color + emoji) for the roster row. */
		avatar?: { color: string; emoji: string };
		/** The caller's latest conversation with this employee: when it was last
		 *  active + a one-line preview of the last message (null if none yet). */
		lastActivityAt?: string | null;
		lastMessagePreview?: string | null;
		/** The threadId of that latest conversation — carried on the roster so opening
		 *  the employee is instant (no per-click listThreads round-trip). Null = none yet. */
		lastThreadId?: string | null;
		/** True when this employee isn't the caller's own — it was added from the
		 *  shared-employee catalogue (membership), so the roster groups it under
		 *  "Shared with you" rather than the owned "Employees" list. */
		shared?: boolean;
		/** Listed in the shared catalogue (has a published snapshot recipients run). */
		published?: boolean;
		/** The owner has draft config edits not yet published to recipients — drives the
		 *  chat header's "Draft · unpublished changes" chip (owner is testing the draft). */
		hasUnpublishedChanges?: boolean;
	}

	interface HolaEmployeeThreadPayload {
		threadId: string;
		title: string;
		updatedAt: string;
	}

	// The employee's equipped skills / capabilities / integrations (composer "+" menu).
	interface HolaEmployeeEquipmentPayload {
		skills: { id: string; label: string }[];
		capabilities: { id: string; label: string }[];
		integrations: { slug: string; name: string }[];
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
		connected_accounts?: Array<{
			connection_id: string;
			account_namespace: string;
		}>;
		workspace_default_connection_id?: string | null;
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
		/** Provider-side handle from whoami (e.g. Twitter @alice) — used for re-auth dedupe. */
		account_handle: string | null;
		/** Provider-side email from whoami (e.g. josh@example.com) — used for re-auth dedupe. */
		account_email: string | null;
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

	interface IntegrationStoreCatalogEntry {
		slug: string;
		tier: "hero" | "supported";
		category: string;
		beta?: boolean;
	}

	interface IntegrationStoreCatalogPayload {
		entries: IntegrationStoreCatalogEntry[];
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
		connected?: boolean;
	}

	interface ComposioToolkitAuth {
		managed: boolean;
		scheme: string | null;
		fields: Array<{
			name: string;
			required: boolean;
			type: string;
			displayName: string;
			description: string;
		}>;
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
			listDirectory: (
				targetPath?: string | null,
				workspaceId?: string | null,
			) => Promise<LocalDirectoryResponse>;
			readFilePreview: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			pathExists: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<boolean>;
			writeTextFile: (
				targetPath: string,
				content: string,
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			writeTableFile: (
				targetPath: string,
				tableSheets: FilePreviewTableSheetPayload[],
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			writeUniverWorkbook: (
				targetPath: string,
				snapshot: IWorkbookData,
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			writeDocxFromHtml: (
				targetPath: string,
				html: string,
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			readFileBytes: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<Uint8Array>;
			writeBinaryFile: (
				targetPath: string,
				bytes: Uint8Array,
				workspaceId?: string | null,
			) => Promise<FilePreviewPayload>;
			watchFile: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<FilePreviewWatchSubscriptionPayload>;
			unwatchFile: (subscriptionId: string) => Promise<void>;
			createPath: (
				parentPath: string | null | undefined,
				kind: FileSystemCreateKind,
				workspaceId?: string | null,
				extensionHint?: string | null,
				desiredName?: string | null,
			) => Promise<FileSystemMutationPayload>;
			importExternalEntries: (
				destinationDirectoryPath: string,
				entries: ExplorerExternalImportEntryPayload[],
				workspaceId?: string | null,
			) => Promise<ExplorerExternalImportResultPayload>;
			renamePath: (
				targetPath: string,
				nextName: string,
				workspaceId?: string | null,
			) => Promise<FileSystemMutationPayload>;
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
			deletePath: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<{ deleted: boolean }>;
			revealInFolder: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<{ revealed: boolean }>;
			openInDefaultApp: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<{ opened: boolean; error?: string }>;
			getDefaultApp: (
				targetPath: string,
				workspaceId?: string | null,
			) => Promise<{ name: string | null; iconDataUrl: string | null }>;
			exportFileTo: (
				targetPath: string,
				workspaceId?: string | null,
				payload?: { content?: string; suggestedName?: string },
			) => Promise<{ path: string | null; canceled: boolean }>;
			exportHtmlToPdf: (
				payload: HtmlToPdfExportRequestPayload,
			) => Promise<{ path: string | null; canceled: boolean }>;
			getBookmarks: (
				workspaceId?: string | null,
			) => Promise<FileBookmarkPayload[]>;
			addBookmark: (
				targetPath: string,
				label?: string,
				workspaceId?: string | null,
			) => Promise<FileBookmarkPayload[]>;
			removeBookmark: (bookmarkId: string) => Promise<FileBookmarkPayload[]>;
			onFileChange: (
				listener: (payload: FilePreviewChangePayload) => void,
			) => () => void;
			onBookmarksChange: (
				listener: (bookmarks: FileBookmarkPayload[]) => void,
			) => () => void;
		};
		diagnostics: {
			exportBundle: () => Promise<DiagnosticsExportPayload>;
			revealBundle: (bundlePath: string) => Promise<boolean>;
		};
		app: {
			relaunch: () => Promise<void>;
			onCloseActiveTab: (listener: () => void) => () => void;
		};
		runtime: {
			getStatus: () => Promise<RuntimeStatusPayload>;
			getDbMaintenance: () => Promise<DbMaintenanceStatusPayload | null>;
			restart: () => Promise<RuntimeStatusPayload>;
			getConfig: () => Promise<RuntimeConfigPayload>;
			refreshModelCatalog: () => Promise<RuntimeConfigPayload>;
			getProfile: () => Promise<RuntimeUserProfilePayload>;
			getConfigDocument: () => Promise<string>;
			setConfig: (
				payload: RuntimeConfigUpdatePayload,
			) => Promise<RuntimeConfigPayload>;
			setProfile: (
				payload: RuntimeUserProfileUpdatePayload,
			) => Promise<RuntimeUserProfilePayload>;
			setConfigDocument: (rawDocument: string) => Promise<RuntimeConfigPayload>;
			exchangeBinding: (sandboxId: string) => Promise<RuntimeConfigPayload>;
			validateProvider: (
				providerId: string,
			) => Promise<{ ok: boolean; detail: string }>;
			onConfigChange: (
				listener: (config: RuntimeConfigPayload) => void,
			) => () => void;
			onStateChange: (
				listener: (status: RuntimeStatusPayload) => void,
			) => () => void;
		};
		ui: {
			getTheme: () => Promise<string>;
			getWindowState: () => Promise<DesktopWindowStatePayload>;
			minimizeWindow: () => Promise<void>;
			toggleWindowSize: () => Promise<void>;
			closeWindow: () => Promise<void>;
			setTheme: (theme: string) => Promise<void>;
			showNativeNotification: (
				payload: DesktopNativeNotificationPayload,
			) => Promise<boolean>;
			setBadgeCount: (count: number) => Promise<void>;
			getNotificationsEnabled: () => Promise<boolean>;
			setNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
			getKeepAwakeEnabled: () => Promise<boolean>;
			setKeepAwakeEnabled: (enabled: boolean) => Promise<boolean>;
			openSettingsPane: (section?: UiSettingsPaneSection) => Promise<void>;
			openExternalUrl: (url: string) => Promise<void>;
			onWindowStateChange: (
				listener: (state: DesktopWindowStatePayload) => void,
			) => () => void;
			onThemeChange: (listener: (theme: string) => void) => () => void;
			onOpenSettingsPane: (
				listener: (section: UiSettingsPaneSection) => void,
			) => () => void;
			onNotificationActivated: (
				listener: (payload: {
					workspaceId: string;
					sessionId: string | null;
				}) => void,
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
			setChannel: (
				channel: AppUpdateChannel,
			) => Promise<AppUpdateStatusPayload>;
			installNow: () => Promise<void>;
			onStateChange: (
				listener: (status: AppUpdateStatusPayload) => void,
			) => () => void;
		};
		workbench: {
			onOpenBrowser: (
				listener: (payload: WorkbenchOpenBrowserPayload) => void,
			) => () => void;
		};
		appSurface: {
			/** Web deep link (ai.holaboss.app://open-app?appId=…) forwarded from main;
			 * the subscriber drives useOpenHolaApp() to open the app surface. */
			onOpenFromDeepLink(
				listener: (target: { appId: string; path?: string }) => void,
			): () => void;
			/** Pull a deep link that landed before the subscriber mounted (cold
			 * start / pre-sign-in). Returns it once, then null. */
			consumePendingDeepLink(): Promise<{
				appId: string;
				path?: string;
			} | null>;
			navigate(
				workspaceId: string,
				appId: string,
				path?: string,
			): Promise<void>;
			navigateWebApp(
				holaAppId: string,
				path?: string,
				url?: string,
				forceReload?: boolean,
				/** When set, a same-document target (same origin+path, only the query/hash
				 * differs) is applied via client-side history.pushState on the warm page
				 * instead of a full reload — for query-driven surfaces (Cloud rail
				 * ?section=). Falls back to a hard load if the page can't accept it. */
				soft?: boolean,
			): Promise<void>;
			destroyWebApp(holaAppId: string): Promise<void>;
			/** Background-load a web HolaApp surface into its detached, invisible
			 * BrowserView so the first open reveals instantly (warm-reopen) instead of
			 * a cold SPA load. Best-effort; no-op if unauthenticated or already warm. */
			prewarmWebApp(holaAppId: string): Promise<void>;
			setBounds(bounds: {
				x: number;
				y: number;
				width: number;
				height: number;
			}): Promise<void>;
			reload(appId: string): Promise<void>;
			destroy(appId: string): Promise<void>;
			hide(): Promise<void>;
			resolveUrl(
				workspaceId: string,
				appId: string,
				path?: string,
			): Promise<string>;
			/** Subscribe to the active surface's live location (current page URL +
			 * title), pushed on in-surface navigation. Returns an unsubscribe fn. */
			onLocationChanged(
				listener: (payload: {
					appId: string;
					url: string;
					title: string;
				}) => void,
			): () => void;
			/** Subscribe to surface failures — a load error, a dead renderer, or a
			 * view revealed on about:blank. Returns an unsubscribe fn. */
			onFailed(
				listener: (payload: {
					appId: string;
					kind: "load" | "crash" | "blank";
					code?: number;
					detail?: string;
					url?: string;
				}) => void,
			): () => void;
			/** Ask whether the surface is actually showing anything. */
			probe(surfaceKey: string): Promise<{
				missing: boolean;
				empty: boolean;
				url: string;
			}>;
			/** Clear this app's origin (cookies + storage) and reload it. */
			clearAppData(surfaceKey: string, appUrl?: string): Promise<void>;
		};
		holaApps: {
			install(holaAppId: string): Promise<void>;
			uninstall(holaAppId: string): Promise<void>;
			sync(holaAppIds: string[]): Promise<void>;
			attachApiKeyMcp(args: {
				holaAppId: string;
				mcpUrl: string;
				apiKey: string;
				auth:
					| { kind: "query"; param: string }
					| { kind: "header"; name: string; prefix?: string };
			}): Promise<{ ok: boolean; toolCount?: number; error?: string }>;
			detachApiKeyMcp(holaAppId: string): Promise<void>;
			attachCommandMcp(args: {
				holaAppId: string;
				command: string[];
				env?: Record<string, string>;
			}): Promise<void>;
		};
		/** Marketplace MCP servers (mcp-catalog install). The user's credentials are
		 * split by target and carried into the main process, which writes them to the
		 * local workspace.yaml — they never leave the machine or ride a gateway call. */
		mcpMarketplace: {
			install(config: {
				id: string;
				mcpUrl: string;
				holabossHosted: boolean;
				headerKeys: Record<string, string>;
				queryKeys: Record<string, string>;
				envKeys: Record<string, string>;
				tools: string[];
			}): Promise<void>;
			/** Attach an app-owned hosted MCP (HolaApp hostedMcpInstall) — written to
			 *  app_servers, bypassing the marketplace's catalog-reconciled set. */
			attachAppOwned(config: {
				id: string;
				mcpUrl: string;
				holabossHosted: boolean;
				headerKeys: Record<string, string>;
				queryKeys: Record<string, string>;
				envKeys: Record<string, string>;
				tools: string[];
				ownerAppId: string;
			}): Promise<void>;
			uninstall(id: string): Promise<void>;
			sync(
				configs: {
					id: string;
					mcpUrl: string;
					holabossHosted: boolean;
					headerKeys: Record<string, string>;
					queryKeys: Record<string, string>;
					envKeys: Record<string, string>;
					tools: string[];
				}[],
			): Promise<void>;
			/** Re-sync the app-owned hosted-MCP set (hostedMcpInstall apps) so main
			 *  re-attaches them per turn — the bearer refresh, on a separate track from
			 *  `sync` (never catalog-reconciled). */
			syncAppOwned(
				configs: {
					id: string;
					mcpUrl: string;
					holabossHosted: boolean;
					headerKeys: Record<string, string>;
					queryKeys: Record<string, string>;
					envKeys: Record<string, string>;
					tools: string[];
					ownerAppId: string;
				}[],
			): Promise<void>;
		};
		host: {
			onOpenChat(listener: (payload: HostOpenChatPayload) => void): () => void;
			onOpenApp(listener: (payload: OpenAppEventPayload) => void): () => void;
			onInstall(listener: (payload: InstallEventPayload) => void): () => void;
			sendInstallResult(requestId: string, result: InstallResult): void;
			onInstallStatus(
				listener: (payload: InstallStatusEventPayload) => void,
			): () => void;
			sendInstallStatus(requestId: string, list: InstalledList): void;
			onEmployeesChanged(listener: () => void): () => void;
		};
		holahub: {
			stageShare(draft: ShareDraft): Promise<boolean>;
		};
		workspace: {
			getClientConfig: () => Promise<HolabossClientConfigPayload>;
			pickTemplateFolder: () => Promise<TemplateFolderSelectionPayload>;
			pickWorkspaceRuntimeFolder: () => Promise<WorkspaceRuntimeFolderSelectionPayload>;
			pickWorkspaceRelocationFolder: (
				workspaceId: string,
			) => Promise<WorkspaceRuntimeFolderSelectionPayload>;
			relocate: (
				workspaceId: string,
				newPath: string,
			) => Promise<WorkspaceResponsePayload>;
			activate: (workspaceId: string) => Promise<WorkspaceResponsePayload>;
			listWorkspaces: () => Promise<WorkspaceListResponsePayload>;
			listWorkspacesCached: () => Promise<WorkspaceListResponsePayload>;
			getWorkspaceLifecycle: (
				workspaceId: string,
			) => Promise<WorkspaceLifecyclePayload>;
			listWorkspaceCardSummaries: (
				workspaceIds: string[],
			) => Promise<WorkspaceCardSummariesResponsePayload>;
			activateWorkspace: (
				workspaceId: string,
			) => Promise<WorkspaceLifecyclePayload>;
			openWorkspace: (
				workspaceId: string,
			) => Promise<WorkspaceOpenSessionPayload>;
			listInstalledApps: (
				workspaceId: string,
			) => Promise<InstalledWorkspaceAppListResponsePayload>;
			removeInstalledApp: (workspaceId: string, appId: string) => Promise<void>;
			listActivity: (payload: {
				workspaceId: string;
				date: string;
			}) => Promise<WorkspaceActivityResponsePayload>;
			listOutputFolders: (
				workspaceId: string,
			) => Promise<WorkspaceOutputFolderListResponsePayload>;
			searchOutputs: (
				payload: WorkspaceOutputSearchRequestPayload,
			) => Promise<WorkspaceOutputSearchResponsePayload>;
			createOutput: (
				payload: WorkspaceOutputCreatePayload,
			) => Promise<WorkspaceOutputCreateResponsePayload>;
			updateOutput: (payload: {
				workspaceId: string;
				outputId: string;
				title?: string | null;
				status?: string | null;
				folderId?: string | null;
				filePath?: string | null;
			}) => Promise<WorkspaceOutputCreateResponsePayload>;
			deleteOutput: (payload: {
				workspaceId: string;
				outputId: string;
			}) => Promise<{ deleted: boolean }>;
			listArtifactTemplates: () => Promise<ArtifactTemplateListResponsePayload>;
			readArtifactTemplatePreview: (payload: {
				templateId: string;
			}) => Promise<ArtifactTemplatePreviewPayload>;
			saveOutputAsTemplate: (
				payload: SaveOutputAsArtifactTemplatePayload,
			) => Promise<ArtifactTemplateRecordPayload>;
			createOutputFromTemplate: (payload: {
				workspaceId: string;
				templateId: string;
				sessionId?: string | null;
				name?: string | null;
			}) => Promise<WorkspaceOutputCreateResponsePayload>;
			deleteArtifactTemplate: (payload: {
				templateId: string;
			}) => Promise<{ deleted: boolean }>;
			listSkills: (
				workspaceId: string,
			) => Promise<WorkspaceSkillListResponsePayload>;
			deleteSkill: (payload: {
				workspaceId: string;
				skillId: string;
			}) => Promise<{ deleted: boolean }>;
			getWorkspaceRoot: (workspaceId: string) => Promise<string>;
			listIssues: (workspaceId: string) => Promise<IssueListResponsePayload>;
			createIssue: (
				payload: CreateIssuePayload,
			) => Promise<CreateIssueResponsePayload>;
			updateIssue: (
				workspaceId: string,
				issueId: string,
				payload: UpdateIssuePayload,
			) => Promise<UpdateIssueResponsePayload>;
			stopIssueRun: (
				workspaceId: string,
				issueId: string,
			) => Promise<StopIssueRunResponsePayload>;
			listBackgroundTasks: (
				payload: BackgroundTaskListRequestPayload,
			) => Promise<BackgroundTaskListResponsePayload>;
			archiveBackgroundTask: (
				payload: ArchiveBackgroundTaskPayload,
			) => Promise<ArchiveBackgroundTaskResponsePayload>;
			continueBackgroundTask: (
				payload: ContinueBackgroundTaskPayload,
			) => Promise<ContinueBackgroundTaskResponsePayload>;
			ensureMainSession: (
				workspaceId: string,
				opts?: { create?: boolean },
			) => Promise<EnsureWorkspaceMainSessionResponsePayload>;
			listMainSessions: (
				workspaceId: string,
				appId?: string | null,
			) => Promise<ListMainSessionsResponsePayload>;
			createMainSession: (
				workspaceId: string,
				payload?: CreateMainSessionPayload,
			) => Promise<CreateMainSessionResponsePayload>;
			listProjects: (
				workspaceId: string,
			) => Promise<ListWorkspaceProjectsResponsePayload>;
			getConfigYaml: (
				workspaceId: string,
			) => Promise<WorkspaceConfigYamlPayload>;
			listMcpServers: (
				workspaceId: string,
			) => Promise<WorkspaceMcpServersPayload>;
			deleteMcpServer: (
				workspaceId: string,
				serverId: string,
			) => Promise<DeleteWorkspaceMcpServerResponsePayload>;
			refreshMcpTools: (
				workspaceId: string,
			) => Promise<{ refreshed: boolean; servers?: string[] }>;
			authorizeMcpServer: (
				workspaceId: string,
				serverId: string,
				reauthorize?: boolean,
			) => Promise<{
				ok: boolean;
				server_id: string;
				tool_count: number;
				detail: string;
				requires_session_refresh?: boolean;
			}>;
			mcpServerAuthorized: (
				workspaceId: string,
				serverId: string,
			) => Promise<{
				authorized: boolean;
				registered?: boolean;
				server_id?: string;
			}>;
			listHarnessAvailability: (
				workspaceId: string,
			) => Promise<ListHarnessAvailabilityResponsePayload>;
			testHarnessConnection: (
				workspaceId: string,
				harnessId: string,
			) => Promise<HarnessConnectionTestResultPayload>;
			updateSessionHarness: (
				workspaceId: string,
				sessionId: string,
				harnessId: string,
			) => Promise<UpdateSessionHarnessResponsePayload>;
			createProject: (
				workspaceId: string,
				payload: CreateWorkspaceProjectPayload,
			) => Promise<CreateWorkspaceProjectResponsePayload>;
			updateProject: (
				workspaceId: string,
				projectId: string,
				payload: UpdateWorkspaceProjectPayload,
			) => Promise<UpdateWorkspaceProjectResponsePayload>;
			deleteProject: (
				workspaceId: string,
				projectId: string,
			) => Promise<{ ok: true }>;
			pickProjectFolder: () => Promise<string | null>;
			activateMainSession: (
				workspaceId: string,
				sessionId: string,
			) => Promise<ActivateMainSessionResponsePayload>;
			updateMainSession: (
				workspaceId: string,
				sessionId: string,
				payload: UpdateMainSessionPayload,
			) => Promise<UpdateMainSessionResponsePayload>;
			deleteMainSession: (
				workspaceId: string,
				sessionId: string,
			) => Promise<{ ok: true }>;
			listAgentSessions: (
				payload: string | ListAgentSessionsRequestPayload,
			) => Promise<AgentSessionListResponsePayload>;
			createAgentSession: (
				payload: CreateAgentSessionPayload,
			) => Promise<CreateAgentSessionResponsePayload>;
			listRuntimeStates: (
				workspaceId: string,
			) => Promise<SessionRuntimeStateListResponsePayload>;
			getSessionHistory: (
				payload: SessionHistoryRequestPayload,
			) => Promise<SessionHistoryResponsePayload>;
			listTurnResults: (
				payload: SessionTurnResultListRequestPayload,
			) => Promise<SessionTurnResultListResponsePayload>;
			getSessionOutputEvents: (
				payload: SessionOutputEventListRequestPayload,
			) => Promise<SessionOutputEventListResponsePayload>;
			stageSessionAttachments: (
				payload: StageSessionAttachmentsPayload,
			) => Promise<StageSessionAttachmentsResponsePayload>;
			stageSessionAttachmentPaths: (
				payload: StageSessionAttachmentPathsPayload,
			) => Promise<StageSessionAttachmentsResponsePayload>;
			queueSessionInput: (
				payload: HolabossQueueSessionInputPayload,
			) => Promise<EnqueueSessionInputResponsePayload>;
			pauseSessionRun: (
				payload: HolabossPauseSessionRunPayload,
			) => Promise<PauseSessionRunResponsePayload>;
			answerUserQuestion: (
				payload: HolabossAnswerUserQuestionPayload,
			) => Promise<AnswerUserQuestionResponsePayload>;
			updateQueuedSessionInput: (
				payload: HolabossUpdateQueuedSessionInputPayload,
			) => Promise<UpdateQueuedSessionInputResponsePayload>;
			cancelQueuedSessionInput: (
				payload: HolabossCancelQueuedSessionInputPayload,
			) => Promise<CancelQueuedSessionInputResponsePayload>;
			openSessionOutputStream: (
				payload: HolabossStreamSessionOutputsPayload,
			) => Promise<HolabossSessionStreamHandlePayload>;
			closeSessionOutputStream: (
				streamId: string,
				reason?: string,
			) => Promise<void>;
			getSessionStreamDebug: () => Promise<HolabossSessionStreamDebugEntry[]>;
			isVerboseTelemetryEnabled: () => Promise<boolean>;
			listIntegrationCatalog: () => Promise<IntegrationCatalogResponsePayload>;
			listIntegrationConnections: (params?: {
				providerId?: string;
				ownerUserId?: string;
			}) => Promise<IntegrationConnectionListResponsePayload>;
			listIntegrationBindings: (
				workspaceId: string,
			) => Promise<IntegrationBindingListResponsePayload>;
			getWorkspaceDefaultAccount: (
				workspaceId: string,
				providerId: string,
			) => Promise<{ connection_id: string | null }>;
			setWorkspaceDefaultAccount: (
				workspaceId: string,
				providerId: string,
				connectionId: string,
			) => Promise<{ connection_id: string }>;
			upsertIntegrationBinding: (
				workspaceId: string,
				targetType: string,
				targetId: string,
				integrationKey: string,
				payload: IntegrationUpsertBindingPayload,
			) => Promise<IntegrationBindingPayload>;
			createIntegrationConnection: (
				payload: IntegrationCreateConnectionPayload,
			) => Promise<IntegrationConnectionPayload>;
			updateIntegrationConnection: (
				connectionId: string,
				payload: IntegrationUpdateConnectionPayload,
			) => Promise<IntegrationConnectionPayload>;
			deleteIntegrationConnection: (
				connectionId: string,
			) => Promise<{ deleted: boolean }>;
			mergeIntegrationConnections: (
				keepConnectionId: string,
				removeConnectionIds: string[],
			) => Promise<IntegrationMergeConnectionsResult>;
			deleteIntegrationBinding: (
				bindingId: string,
				workspaceId: string,
			) => Promise<{ deleted: boolean }>;
			listConnectionWorkspaceUsage: () => Promise<ConnectionWorkspaceUsagePayload>;
			listIntegrationStoreCatalog: () => Promise<IntegrationStoreCatalogPayload>;
			listMemoryBrowserTree: (
				workspaceId: string,
			) => Promise<MemoryBrowserTreeResponsePayload>;
			readMemoryBrowserFile: (
				workspaceId: string,
				targetPath: string,
			) => Promise<MemoryBrowserFileResponsePayload>;
			readMemoryBrowserNodeDetail: (
				workspaceId: string,
				params: { nodeId: string; treeId?: string | null },
			) => Promise<MemoryBrowserNodeDetailResponsePayload>;
			listMemoryBrowserGraph: (
				workspaceId: string,
				params: {
					forest: MemoryBrowserGraphForestPayload;
					treeId?: string | null;
					maxLayers?: number | null;
					maxNodes?: number | null;
				},
			) => Promise<MemoryBrowserGraphResponsePayload>;
			listOAuthConfigs: () => Promise<OAuthAppConfigListResponsePayload>;
			upsertOAuthConfig: (
				providerId: string,
				payload: OAuthAppConfigUpsertPayload,
			) => Promise<OAuthAppConfigPayload>;
			deleteOAuthConfig: (providerId: string) => Promise<{ deleted: boolean }>;
			startOAuthFlow: (
				provider: string,
			) => Promise<OAuthAuthorizeResponsePayload>;
			composioListToolkits: () => Promise<{
				toolkits: Array<{
					slug: string;
					name: string;
					description: string;
					logo: string | null;
					auth_schemes: string[];
					categories: string[];
				}>;
			}>;
			composioListConnections: (
				force?: boolean,
			) => Promise<{
				connections: Array<{
					id: string;
					status: string;
					toolkitSlug: string;
					toolkitName: string;
					toolkitLogo: string | null;
					userId: string;
					createdAt: string;
					canResolveIdentity?: boolean;
				}>;
			}>;
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
			restartApp: (
				workspaceId: string,
				appId: string,
			) => Promise<{
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
				// Present for toolkits with no managed OAuth: the user's own scheme +
				// credentials, connected server-side with no OAuth window.
				auth_scheme?: string;
				credentials?: Record<string, string>;
			}) => Promise<ComposioConnectResult>;
			composioToolkitAuth: (
				toolkitSlug: string,
			) => Promise<ComposioToolkitAuth>;
			composioReconnect: (connectedAccountId: string) => Promise<{
				id: string;
				status: string;
				redirect_url: string | null;
			}>;
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
				reason?:
					| "no_external_id"
					| "account_missing"
					| "no_new_identity"
					| "provider_credentials_rejected";
				/** Set with `provider_credentials_rejected` so the UI can name
				 *  the specific provider in a reconnect prompt. */
				providerLabel?: string;
				/** Upstream HTTP status (typically 401/403) when the provider
				 *  rejected Composio's stored token. */
				providerStatus?: number;
			}>;
			composioDeleteUpstream: (connectedAccountId: string) => Promise<{
				deleted: boolean;
				missing: boolean;
			}>;
			composioMcpEnsureRunning: (workspaceId: string) => Promise<unknown>;
			resolveTemplateIntegrations: (
				payload: HolabossCreateWorkspacePayload,
			) => Promise<ResolveTemplateIntegrationsResult>;
			generateTemplateContent(params: {
				contentType: "onboarding" | "readme";
				name: string;
				description: string;
				category: string;
				tags: string[];
				apps: string[];
			}): Promise<{ content: string }>;
			createSubmission(
				payload: CreateSubmissionPayload,
			): Promise<CreateSubmissionResponse>;
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
			finalizeSubmission(
				submissionId: string,
			): Promise<FinalizeSubmissionResponse>;
			listSubmissions(): Promise<SubmissionListResponse>;
			deleteSubmission(submissionId: string): Promise<{ deleted: boolean }>;
			setOperatorSurfaceContext(
				workspaceId: string,
				context: OperatorSurfaceContextPayload | null,
			): Promise<void>;
			onSessionStreamEvent: (
				listener: (payload: HolabossSessionStreamEventPayload) => void,
			) => () => void;
		};
		holaemployee: {
			listEmployees: () => Promise<HolaEmployeeSummaryPayload[]>;
			listThreads: (employeeId: string) => Promise<HolaEmployeeThreadPayload[]>;
			threadHistory: (
				employeeId: string,
				threadId: string,
			) => Promise<unknown[]>;
			getEquipment: (
				employeeId: string,
			) => Promise<HolaEmployeeEquipmentPayload>;
			openChatStream: (payload: {
				employeeId: string;
				threadId: string;
				message: string;
				attachments?: {
					name: string;
					mimeType: string;
					contentBase64: string;
				}[];
			}) => Promise<HolabossSessionStreamHandlePayload>;
			closeChatStream: (streamId: string) => Promise<void>;
			onChatStreamEvent: (
				listener: (payload: HolabossSessionStreamEventPayload) => void,
			) => () => void;
		};
		auth: {
			getUser: () => Promise<AuthUserPayload | null>;
			// Renderer-side BFF clients reach the API via the bff.fetch bridge —
			// these accessors expose only the host URLs the renderer should target.
			getApiBaseUrl: () => Promise<string>;
			getMarketplaceBaseUrl: () => Promise<string>;
			getBackendBaseUrl: () => Promise<string>;
			requestAuth: () => Promise<void>;
			signOut: () => Promise<void>;
			// Organization (tenant) context. Switching the active org re-scopes every
			// backend call (the gateway injects x-holaboss-org-id from the session).
			listOrganizations: () => Promise<DesktopOrganizationPayload[]>;
			getActiveOrganization: () => Promise<DesktopActiveOrganizationPayload | null>;
			setActiveOrganization: (
				organizationId: string | null,
			) => Promise<DesktopActiveOrganizationPayload | null>;
			inviteOrgMember: (payload: {
				email: string;
				role: "admin" | "member";
			}) => Promise<{ ok: boolean; error?: string }>;
			removeOrgMember: (
				memberIdOrEmail: string,
			) => Promise<{ ok: boolean; error?: string }>;
			updateOrgMemberRole: (payload: {
				memberId: string;
				role: "admin" | "member";
			}) => Promise<{ ok: boolean; error?: string }>;
			cancelOrgInvitation: (
				invitationId: string,
			) => Promise<{ ok: boolean; error?: string }>;
			showPopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
			togglePopup: (anchorBounds: BrowserAnchorBoundsPayload) => Promise<void>;
			scheduleClosePopup: (delayMs?: number) => Promise<void>;
			cancelClosePopup: () => Promise<void>;
			closePopup: () => Promise<void>;
			onAuthenticated: (
				callback: (user: AuthUserPayload) => unknown,
			) => () => void;
			onUserUpdated: (
				callback: (user: AuthUserPayload | null) => unknown,
			) => () => void;
			onError: (callback: (context: AuthErrorPayload) => unknown) => () => void;
		};
		composio: {
			onConnectionInvalidated: (
				listener: (
					payload: ComposioConnectionInvalidatedEventPayload,
				) => unknown,
			) => () => void;
			onStatusChange: (
				listener: (payload: ComposioEventsBridgeStatusPayload) => unknown,
			) => () => void;
		};
		tabs: {
			showContextMenu: (opts: {
				canCloseLeft: boolean;
				canCloseRight: boolean;
				canCloseOthers: boolean;
				canCloseAll?: boolean;
				hasDeleteFile: boolean;
			}) => Promise<
				| "close"
				| "closeOthers"
				| "closeToLeft"
				| "closeToRight"
				| "closeAll"
				| "deleteFile"
				| null
			>;
		};
		profiles: {
			list: () => Promise<BrowserProfilePayload[]>;
			create: (name?: string | null) => Promise<BrowserProfilePayload>;
			rename: (
				profileId: string,
				name: string,
			) => Promise<BrowserProfilePayload[]>;
			remove: (
				profileId: string,
			) => Promise<{ deleted: boolean; profiles: BrowserProfilePayload[] }>;
			setDefault: (profileId: string) => Promise<BrowserProfilePayload[]>;
			launch: (
				profileId: string,
				url?: string | null,
			) => Promise<{ ok: boolean; error?: string }>;
			listImportSources: (
				source: BrowserImportSource,
			) => Promise<BrowserImportProfileOptionPayload[]>;
			import: (
				payload: ProfileImportRequestPayload,
			) => Promise<ProfileImportResultPayload>;
			importSpreadsheet: (fileBytes: ArrayBuffer) => Promise<{
				ok: boolean;
				error?: string;
				imported: number;
				warnings: string[];
			}>;
			close: (profileId: string) => Promise<{ ok: boolean }>;
			runningIds: () => Promise<string[]>;
			setEngine: (
				profileId: string,
				engine: "system" | "fingerprint",
			) => Promise<BrowserProfilePayload[]>;
			setFingerprint: (
				profileId: string,
				fingerprint: FingerprintPayload,
			) => Promise<BrowserProfilePayload[]>;
			previewFingerprint: (
				fingerprint: FingerprintPayload,
			) => Promise<{ warnings: string[] }>;
			onRunningChange: (listener: (runningIds: string[]) => void) => () => void;
		};
		fingerprintTemplates: {
			list: () => Promise<FingerprintTemplatePayload[]>;
			import: (raw: unknown) => Promise<{
				templates: FingerprintTemplatePayload[];
				warnings: string[];
			}>;
			save: (
				name: string,
				fingerprint: FingerprintPayload,
			) => Promise<FingerprintTemplatePayload[]>;
			delete: (id: string) => Promise<FingerprintTemplatePayload[]>;
		};
	}

	interface Window {
		electronAPI: ElectronAPI;
	}
}
