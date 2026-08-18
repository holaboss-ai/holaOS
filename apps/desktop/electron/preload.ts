import {
	type ChatStartInput,
	HOST_EMPLOYEES_CHANGED_EVENT,
	HOST_INSTALL_EVENT,
	HOST_INSTALL_RESULT,
	HOST_INSTALL_STATUS_EVENT,
	HOST_INSTALL_STATUS_RESULT,
	HOST_OPEN_APP_EVENT,
	HOST_RENDERER_EVENT,
	type InstallEventPayload,
	type InstalledList,
	type InstallResult,
	type InstallStatusEventPayload,
	type OpenAppEventPayload,
	type ShareDraft,
} from "@holaboss/app-host/protocol";
import { contextBridge, ipcRenderer } from "electron";
import type { OnboardingAlignmentReport } from "../../../shared/onboarding-contract.js";
import {
	BFF_FETCH_CHANNEL,
	type BffFetchRequest,
	type BffFetchResponse,
} from "../shared/bff-fetch-protocol.js";
import {
	COMPOSIO_EVENTS_INVALIDATED_CHANNEL,
	COMPOSIO_EVENTS_STATUS_CHANNEL,
	type ComposioConnectionInvalidatedEvent,
	type ComposioEventsBridgeStatus,
} from "../shared/composio-events-protocol.js";

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
	| "video"
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

// Sections the settings screen can actually render (SettingsScreenRoot's
// SETTINGS_NAV + its submissions branch). Kept identical in main.ts,
// preload.ts, authPopupPreload.ts and electron.d.ts.
//
// These four had drifted to four different lists, and three of the values they
// carried between them — "providers", "integrations", "about" — matched no
// render branch at all, so passing one opened Settings with a blank pane and
// no nav item selected.
type UiSettingsPaneSection =
	| "account"
	| "agents"
	| "billing"
	| "byok"
	| "channels"
	| "experimental"
	| "memory"
	| "settings"
	| "submissions";

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
}

interface FingerprintTemplatePayload {
	id: string;
	name: string;
	createdAt: string;
	source: "builtin" | "imported" | "captured" | "user";
	fingerprint: Omit<FingerprintPayload, "seed"> & { seed?: number };
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

/**
 * What the runtime is doing while it starts. `ready: false` means "still
 * working", not "failed" — the splash tells busy from hung by whether `phase`
 * advances.
 */
interface RuntimeBootStatusPayload {
	ready: boolean;
	phase: string;
	phase_elapsed_ms: number;
	total_elapsed_ms: number;
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
	onboarding_state?: string | null;
	onboarding_session_id: string | null;
	alignment_question?: Record<string, unknown> | null;
	alignment_report?: OnboardingAlignmentReport | null;
	verification_report?: Record<string, unknown> | null;
	onboarding_completed_at: string | null;
	onboarding_completion_summary: string | null;
	onboarding_requested_at: string | null;
	onboarding_requested_by: string | null;
	created_at: string | null;
	updated_at: string | null;
	deleted_at_utc: string | null;
	workspace_role?: string | null;
	source_workspace_id?: string | null;
	lab_purpose?: string | null;
	lab_status?: string | null;
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
	created_at: string;
	updated_at: string;
	archived_at: string | null;
	active_user_question?: Record<string, unknown> | null;
	/** The HolaApp that owns this session, or null for a workspace session. */
	owning_app_id?: string | null;
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

interface WorkflowNodePositionPayload {
	x: number;
	y: number;
}

interface WorkflowNodePayload {
	node_id: string;
	type: "agent" | "tool" | "trigger" | "condition" | "review";
	label: string;
	description: string | null;
	config: Record<string, unknown>;
	position: WorkflowNodePositionPayload | null;
}

interface WorkflowEdgePayload {
	edge_id: string;
	source_node_id: string;
	source_handle_id?: string | null;
	target_node_id: string;
	target_handle_id?: string | null;
	label: string | null;
	metadata: Record<string, unknown>;
}

interface WorkflowRecordPayload {
	workflow_id: string;
	workspace_id: string;
	plugin_id: string | null;
	name: string;
	description: string | null;
	status: "draft" | "active" | "archived";
	created_by: string | null;
	nodes: WorkflowNodePayload[];
	edges: WorkflowEdgePayload[];
	metadata: Record<string, unknown>;
	last_test_run_id: string | null;
	last_test_status: "passed" | "needs_attention" | "failed" | null;
	last_test_summary: string | null;
	last_test_at: string | null;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

interface WorkflowRunRecordPayload {
	run_id: string;
	workflow_id: string;
	workflow_revision_id: string | null;
	workspace_id: string;
	mode: "test" | "live";
	status:
		| "queued"
		| "running"
		| "blocked"
		| "completed"
		| "failed"
		| "cancelled"
		| "passed"
		| "needs_attention";
	summary: string;
	triggered_by: string | null;
	result: Record<string, unknown>;
	started_at: string;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

interface WorkflowRevisionRecordPayload {
	workflow_revision_id: string;
	workflow_id: string;
	workspace_id: string;
	plugin_id: string | null;
	revision_number: number;
	name: string;
	description: string | null;
	status: "draft" | "active" | "archived";
	created_by: string | null;
	nodes: WorkflowNodePayload[];
	edges: WorkflowEdgePayload[];
	metadata: Record<string, unknown>;
	created_at: string;
}

interface WorkflowGraphCheckPayload {
	code: string;
	level: "info" | "warning" | "error";
	message: string;
}

interface WorkflowGraphAnalysisPayload {
	status: "passed" | "needs_attention" | "failed";
	summary: string;
	checks: WorkflowGraphCheckPayload[];
	counts: {
		nodes: number;
		edges: number;
		by_type: Record<string, number>;
	};
	can_execute: boolean;
}

interface WorkflowListResponsePayload {
	workflows: WorkflowRecordPayload[];
	count: number;
}

interface WorkflowRunListResponsePayload {
	runs: WorkflowRunRecordPayload[];
	count: number;
}

interface WorkflowRevisionListResponsePayload {
	revisions: WorkflowRevisionRecordPayload[];
	count: number;
}

interface CreateWorkflowPayload {
	workspace_id: string;
	plugin_id?: string | null;
	name: string;
	description?: string | null;
	status?: "draft" | "active" | "archived";
	created_by?: string | null;
	nodes?: WorkflowNodePayload[];
	edges?: WorkflowEdgePayload[];
	metadata?: Record<string, unknown>;
}

interface UpdateWorkflowPayload {
	name?: string;
	description?: string | null;
	status?: "draft" | "active" | "archived";
	created_by?: string | null;
	nodes?: WorkflowNodePayload[];
	edges?: WorkflowEdgePayload[];
	metadata?: Record<string, unknown>;
}

interface WorkflowTestPayload {
	created_by?: string;
}

interface WorkflowTestResponsePayload {
	workflow: WorkflowRecordPayload;
	run: WorkflowRunRecordPayload;
	analysis: WorkflowGraphAnalysisPayload;
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

interface HolabossCreateWorkspacePayload {
	holaboss_user_id: string;
	harness?: string | null;
	name: string;
	template_mode?: "template" | "empty" | "empty_onboarding" | null;
	template_root_path?: string | null;
	template_name?: string | null;
	template_ref?: string | null;
	template_commit?: string | null;
	workspace_onboarding_mode?: "start" | "skip" | null;
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
	/** Ambient open-app context for the AGENT only — folded into the turn
	 * instruction by the runtime, never persisted as the user message. */
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

interface HolabossPauseSessionRunPayload {
	workspace_id: string;
	session_id: string;
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

interface HolabossStreamSessionOutputsPayload {
	sessionId: string;
	workspaceId?: string | null;
	inputId?: string | null;
	includeHistory?: boolean;
	stopOnTerminal?: boolean;
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

// A server-side HolaEmployee, as returned by the backend directory (loose — the
// desktop reads name/id + a few fields; the backend carries more).
interface HolaEmployeeSummaryPayload {
	employeeId: string;
	name: string;
	mandate?: string;
	model?: string;
	connectorCount?: number;
	/** The permanent preset "Hola" employee (Holaboss brand mark; not archivable). */
	preset?: boolean;
	/** The caller's latest conversation with this employee (roster preview). */
	lastActivityAt?: string | null;
	lastMessagePreview?: string | null;
	lastThreadId?: string | null;
	avatar?: { color: string; emoji: string };
	/** True for a catalogue-added (shared) employee, not one the caller owns. */
	shared?: boolean;
	/** Listed in the catalogue (has a published snapshot). */
	published?: boolean;
	/** Owner has unpublished draft edits — drives the chat "Draft" chip. */
	hasUnpublishedChanges?: boolean;
}

// One of the caller's private desktop conversations with an employee.
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
	account_handle: string | null;
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

interface IntegrationUpdateConnectionPayload {
	status?: string;
	secret_ref?: string;
	account_label?: string;
	account_handle?: string | null;
	account_email?: string | null;
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
		node: process.versions.node,
	},
	fs: {
		listDirectory: (targetPath?: string | null, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:listDirectory",
				targetPath,
				workspaceId,
			) as Promise<ListDirectoryResponse>,
		readFilePreview: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:readFilePreview",
				targetPath,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		pathExists: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:pathExists",
				targetPath,
				workspaceId,
			) as Promise<boolean>,
		writeTextFile: (
			targetPath: string,
			content: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:writeTextFile",
				targetPath,
				content,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		writeTableFile: (
			targetPath: string,
			tableSheets: FilePreviewTableSheetPayload[],
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:writeTableFile",
				targetPath,
				tableSheets,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		writeUniverWorkbook: (
			targetPath: string,
			snapshot: unknown,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:writeUniverWorkbook",
				targetPath,
				snapshot,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		writeDocxFromHtml: (
			targetPath: string,
			html: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:writeDocxFromHtml",
				targetPath,
				html,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		readFileBytes: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:readFileBytes",
				targetPath,
				workspaceId,
			) as Promise<Uint8Array>,
		writeBinaryFile: (
			targetPath: string,
			bytes: Uint8Array,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:writeBinaryFile",
				targetPath,
				bytes,
				workspaceId,
			) as Promise<FilePreviewPayload>,
		watchFile: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:watchFile",
				targetPath,
				workspaceId,
			) as Promise<FilePreviewWatchSubscriptionPayload>,
		unwatchFile: (subscriptionId: string) =>
			ipcRenderer.invoke("fs:unwatchFile", subscriptionId) as Promise<void>,
		createPath: (
			parentPath: string | null | undefined,
			kind: "file" | "directory",
			workspaceId?: string | null,
			extensionHint?: string | null,
			desiredName?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:createPath",
				parentPath,
				kind,
				workspaceId,
				extensionHint,
				desiredName,
			) as Promise<FileSystemMutationPayload>,
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
		renamePath: (
			targetPath: string,
			nextName: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:renamePath",
				targetPath,
				nextName,
				workspaceId,
			) as Promise<FileSystemMutationPayload>,
		copyPath: (
			sourcePath: string,
			destinationDirectoryPath: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:copyPath",
				sourcePath,
				destinationDirectoryPath,
				workspaceId,
			) as Promise<FileSystemMutationPayload>,
		movePath: (
			sourcePath: string,
			destinationDirectoryPath: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:movePath",
				sourcePath,
				destinationDirectoryPath,
				workspaceId,
			) as Promise<FileSystemMutationPayload>,
		deletePath: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke("fs:deletePath", targetPath, workspaceId) as Promise<{
				deleted: boolean;
			}>,
		revealInFolder: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:revealInFolder",
				targetPath,
				workspaceId,
			) as Promise<{ revealed: boolean }>,
		openInDefaultApp: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:openInDefaultApp",
				targetPath,
				workspaceId,
			) as Promise<{ opened: boolean; error?: string }>,
		getDefaultApp: (targetPath: string, workspaceId?: string | null) =>
			ipcRenderer.invoke(
				"fs:getDefaultApp",
				targetPath,
				workspaceId,
			) as Promise<{ name: string | null; iconDataUrl: string | null }>,
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
		exportHtmlToPdf: (payload: HtmlToPdfExportRequestPayload) =>
			ipcRenderer.invoke("fs:exportHtmlToPdf", payload) as Promise<{
				path: string | null;
				canceled: boolean;
			}>,
		getBookmarks: (workspaceId?: string | null) =>
			ipcRenderer.invoke("fs:getBookmarks", workspaceId) as Promise<
				FileBookmarkPayload[]
			>,
		addBookmark: (
			targetPath: string,
			label?: string,
			workspaceId?: string | null,
		) =>
			ipcRenderer.invoke(
				"fs:addBookmark",
				targetPath,
				label,
				workspaceId,
			) as Promise<FileBookmarkPayload[]>,
		removeBookmark: (bookmarkId: string) =>
			ipcRenderer.invoke("fs:removeBookmark", bookmarkId) as Promise<
				FileBookmarkPayload[]
			>,
		onFileChange: (listener: (payload: FilePreviewChangePayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: FilePreviewChangePayload,
			) => listener(payload);
			ipcRenderer.on("fs:fileChanged", wrapped);
			return () => ipcRenderer.removeListener("fs:fileChanged", wrapped);
		},
		onBookmarksChange: (
			listener: (bookmarks: FileBookmarkPayload[]) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				bookmarks: FileBookmarkPayload[],
			) => listener(bookmarks);
			ipcRenderer.on("fs:bookmarks", wrapped);
			return () => ipcRenderer.removeListener("fs:bookmarks", wrapped);
		},
	},
	diagnostics: {
		exportBundle: () =>
			ipcRenderer.invoke(
				"diagnostics:exportBundle",
			) as Promise<DiagnosticsExportPayload>,
		revealBundle: (bundlePath: string) =>
			ipcRenderer.invoke(
				"diagnostics:revealBundle",
				bundlePath,
			) as Promise<boolean>,
	},
	app: {
		relaunch: () => ipcRenderer.invoke("app:relaunch") as Promise<void>,
		onCloseActiveTab: (listener: () => void) => {
			const wrapped = () => listener();
			ipcRenderer.on("app:closeActiveTab", wrapped);
			return () => ipcRenderer.removeListener("app:closeActiveTab", wrapped);
		},
	},
	runtime: {
		getStatus: () =>
			ipcRenderer.invoke("runtime:getStatus") as Promise<RuntimeStatusPayload>,
		getDbMaintenance: () =>
			ipcRenderer.invoke(
				"runtime:getDbMaintenance",
			) as Promise<DbMaintenanceStatusPayload | null>,
		getBootStatus: () =>
			ipcRenderer.invoke(
				"runtime:getBootStatus",
			) as Promise<RuntimeBootStatusPayload | null>,
		restart: () =>
			ipcRenderer.invoke("runtime:restart") as Promise<RuntimeStatusPayload>,
		getConfig: () =>
			ipcRenderer.invoke("runtime:getConfig") as Promise<RuntimeConfigPayload>,
		refreshModelCatalog: () =>
			ipcRenderer.invoke(
				"runtime:refreshModelCatalog",
			) as Promise<RuntimeConfigPayload>,
		getProfile: () =>
			ipcRenderer.invoke(
				"runtime:getProfile",
			) as Promise<RuntimeUserProfilePayload>,
		getConfigDocument: () =>
			ipcRenderer.invoke("runtime:getConfigDocument") as Promise<string>,
		setConfig: (payload: RuntimeConfigUpdatePayload) =>
			ipcRenderer.invoke(
				"runtime:setConfig",
				payload,
			) as Promise<RuntimeConfigPayload>,
		setProfile: (payload: RuntimeUserProfileUpdatePayload) =>
			ipcRenderer.invoke(
				"runtime:setProfile",
				payload,
			) as Promise<RuntimeUserProfilePayload>,
		setConfigDocument: (rawDocument: string) =>
			ipcRenderer.invoke(
				"runtime:setConfigDocument",
				rawDocument,
			) as Promise<RuntimeConfigPayload>,
		exchangeBinding: (sandboxId: string) =>
			ipcRenderer.invoke(
				"runtime:exchangeBinding",
				sandboxId,
			) as Promise<RuntimeConfigPayload>,
		validateProvider: (providerId: string) =>
			ipcRenderer.invoke("runtime:validateProvider", providerId) as Promise<{
				ok: boolean;
				detail: string;
			}>,
		onConfigChange: (listener: (config: RuntimeConfigPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				config: RuntimeConfigPayload,
			) => listener(config);
			ipcRenderer.on("runtime:config", wrapped);
			return () => ipcRenderer.removeListener("runtime:config", wrapped);
		},
		onStateChange: (listener: (status: RuntimeStatusPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				status: RuntimeStatusPayload,
			) => listener(status);
			ipcRenderer.on("runtime:state", wrapped);
			return () => ipcRenderer.removeListener("runtime:state", wrapped);
		},
	},
	ui: {
		getTheme: () => ipcRenderer.invoke("ui:getTheme") as Promise<string>,
		getWindowState: () =>
			ipcRenderer.invoke(
				"ui:getWindowState",
			) as Promise<DesktopWindowStatePayload>,
		minimizeWindow: () =>
			ipcRenderer.invoke("ui:minimizeWindow") as Promise<void>,
		toggleWindowSize: () =>
			ipcRenderer.invoke("ui:toggleWindowSize") as Promise<void>,
		closeWindow: () => ipcRenderer.invoke("ui:closeWindow") as Promise<void>,
		setTheme: (theme: string) =>
			ipcRenderer.invoke("ui:setTheme", theme) as Promise<void>,
		showNativeNotification: (payload: {
			title: string;
			body: string;
			workspaceId?: string | null;
			sessionId?: string | null;
			force?: boolean;
		}) =>
			ipcRenderer.invoke(
				"ui:showNativeNotification",
				payload,
			) as Promise<boolean>,
		setBadgeCount: (count: number) =>
			ipcRenderer.invoke("ui:setBadgeCount", count) as Promise<void>,
		getNotificationsEnabled: () =>
			ipcRenderer.invoke("ui:getNotificationsEnabled") as Promise<boolean>,
		setNotificationsEnabled: (enabled: boolean) =>
			ipcRenderer.invoke(
				"ui:setNotificationsEnabled",
				enabled,
			) as Promise<boolean>,
		getKeepAwakeEnabled: () =>
			ipcRenderer.invoke("ui:getKeepAwakeEnabled") as Promise<boolean>,
		setKeepAwakeEnabled: (enabled: boolean) =>
			ipcRenderer.invoke("ui:setKeepAwakeEnabled", enabled) as Promise<boolean>,
		openSettingsPane: (section?: UiSettingsPaneSection) =>
			ipcRenderer.invoke("ui:openSettingsPane", section) as Promise<void>,
		openExternalUrl: (url: string) =>
			ipcRenderer.invoke("ui:openExternalUrl", url) as Promise<void>,
		onWindowStateChange: (
			listener: (state: DesktopWindowStatePayload) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				state: DesktopWindowStatePayload,
			) => listener(state);
			ipcRenderer.on("ui:windowState", wrapped);
			return () => ipcRenderer.removeListener("ui:windowState", wrapped);
		},
		onThemeChange: (listener: (theme: string) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, theme: string) =>
				listener(theme);
			ipcRenderer.on("ui:themeChanged", wrapped);
			return () => ipcRenderer.removeListener("ui:themeChanged", wrapped);
		},
		onOpenSettingsPane: (
			listener: (section: UiSettingsPaneSection) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				section: UiSettingsPaneSection,
			) => listener(section);
			ipcRenderer.on("ui:openSettingsPane", wrapped);
			return () => ipcRenderer.removeListener("ui:openSettingsPane", wrapped);
		},
		onNotificationActivated: (
			listener: (payload: {
				workspaceId: string;
				sessionId: string | null;
			}) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: { workspaceId: string; sessionId: string | null },
			) => listener(payload);
			ipcRenderer.on("ui:notificationActivated", wrapped);
			return () =>
				ipcRenderer.removeListener("ui:notificationActivated", wrapped);
		},
	},
	clipboard: {
		readImage: () =>
			ipcRenderer.invoke(
				"clipboard:readImage",
			) as Promise<ClipboardImagePayload | null>,
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
		getStatus: () =>
			ipcRenderer.invoke(
				"appUpdate:getStatus",
			) as Promise<AppUpdateStatusPayload>,
		checkNow: () =>
			ipcRenderer.invoke(
				"appUpdate:checkNow",
			) as Promise<AppUpdateStatusPayload>,
		dismiss: (version?: string | null) =>
			ipcRenderer.invoke(
				"appUpdate:dismiss",
				version,
			) as Promise<AppUpdateStatusPayload>,
		setChannel: (channel: AppUpdateChannel) =>
			ipcRenderer.invoke(
				"appUpdate:setChannel",
				channel,
			) as Promise<AppUpdateStatusPayload>,
		installNow: () =>
			ipcRenderer.invoke("appUpdate:installNow") as Promise<void>,
		onStateChange: (listener: (status: AppUpdateStatusPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				status: AppUpdateStatusPayload,
			) => listener(status);
			ipcRenderer.on("appUpdate:state", wrapped);
			return () => ipcRenderer.removeListener("appUpdate:state", wrapped);
		},
	},
	workbench: {
		onOpenBrowser: (
			listener: (payload: WorkbenchOpenBrowserPayload) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: WorkbenchOpenBrowserPayload,
			) => listener(payload);
			ipcRenderer.on("workbench:openBrowser", wrapped);
			return () => ipcRenderer.removeListener("workbench:openBrowser", wrapped);
		},
	},
	appSurface: {
		onOpenFromDeepLink: (
			listener: (target: { appId: string; path?: string }) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				target: { appId: string; path?: string },
			) => listener(target);
			ipcRenderer.on("holaApp:openFromDeepLink", wrapped);
			return () =>
				ipcRenderer.removeListener("holaApp:openFromDeepLink", wrapped);
		},
		consumePendingDeepLink: () =>
			ipcRenderer.invoke("holaApp:consumePendingDeepLink") as Promise<{
				appId: string;
				path?: string;
			} | null>,
		navigate: (workspaceId: string, appId: string, path?: string) =>
			ipcRenderer.invoke(
				"appSurface:navigate",
				workspaceId,
				appId,
				path,
			) as Promise<void>,
		navigateWebApp: (
			holaAppId: string,
			path?: string,
			url?: string,
			forceReload?: boolean,
			soft?: boolean,
		) =>
			ipcRenderer.invoke(
				"appSurface:navigateWebApp",
				holaAppId,
				path,
				url,
				forceReload,
				soft,
			) as Promise<void>,
		destroyWebApp: (holaAppId: string) =>
			ipcRenderer.invoke(
				"appSurface:destroyWebApp",
				holaAppId,
			) as Promise<void>,
		prewarmWebApp: (holaAppId: string) =>
			ipcRenderer.invoke(
				"appSurface:prewarmWebApp",
				holaAppId,
			) as Promise<void>,
		setBounds: (bounds: {
			x: number;
			y: number;
			width: number;
			height: number;
		}) => ipcRenderer.invoke("appSurface:setBounds", bounds) as Promise<void>,
		reload: (appId: string) =>
			ipcRenderer.invoke("appSurface:reload", appId) as Promise<void>,
		destroy: (appId: string) =>
			ipcRenderer.invoke("appSurface:destroy", appId) as Promise<void>,
		hide: () => ipcRenderer.invoke("appSurface:hide") as Promise<void>,
		resolveUrl: (workspaceId: string, appId: string, path?: string) =>
			ipcRenderer.invoke(
				"appSurface:resolveUrl",
				workspaceId,
				appId,
				path,
			) as Promise<string>,
		onLocationChanged: (
			listener: (payload: {
				appId: string;
				url: string;
				title: string;
			}) => void,
		) => {
			const wrapped = (
				_event: unknown,
				payload: { appId: string; url: string; title: string },
			) => listener(payload);
			ipcRenderer.on("appSurface:location", wrapped);
			return () => ipcRenderer.removeListener("appSurface:location", wrapped);
		},
		/** The surface failed to show anything — a load error, a dead renderer, or
		 *  a view revealed on about:blank. The pane has no other way to know: the
		 *  native view paints over its own reserved space. */
		onFailed: (
			listener: (payload: {
				appId: string;
				kind: "load" | "crash" | "blank";
				code?: number;
				detail?: string;
				url?: string;
			}) => void,
		) => {
			const wrapped = (
				_event: unknown,
				payload: {
					appId: string;
					kind: "load" | "crash" | "blank";
					code?: number;
					detail?: string;
					url?: string;
				},
			) => listener(payload);
			ipcRenderer.on("appSurface:failed", wrapped);
			return () => ipcRenderer.removeListener("appSurface:failed", wrapped);
		},
		/** Ask whether the surface is actually showing anything. The backstop for a
		 *  blank nobody reported. */
		probe: (surfaceKey: string) =>
			ipcRenderer.invoke("appSurface:probe", surfaceKey) as Promise<{
				missing: boolean;
				empty: boolean;
				url: string;
			}>,
		/** Clear this app's own origin (cookies + storage) and reload — recovery
		 *  for a surface stuck on a stale or half-signed-in page. */
		clearAppData: (surfaceKey: string, appUrl?: string) =>
			ipcRenderer.invoke(
				"appSurface:clearAppData",
				surfaceKey,
				appUrl,
			) as Promise<void>,
	},
	holaApps: {
		install: (holaAppId: string) =>
			ipcRenderer.invoke("holaApps:install", holaAppId) as Promise<void>,
		uninstall: (holaAppId: string) =>
			ipcRenderer.invoke("holaApps:uninstall", holaAppId) as Promise<void>,
		sync: (holaAppIds: string[]) =>
			ipcRenderer.invoke("holaApps:sync", holaAppIds) as Promise<void>,
		// Attach an app's OWN external MCP server, authenticated by a user-supplied
		// API key (OmniSocials-style install gate) — connects the app's own MCP
		// server via the runtime's canonical mcp_connect path.
		attachApiKeyMcp: (args: {
			holaAppId: string;
			mcpUrl: string;
			apiKey: string;
			auth:
				| { kind: "query"; param: string }
				| { kind: "header"; name: string; prefix?: string };
		}) =>
			ipcRenderer.invoke("holaApps:attachApiKeyMcp", args) as Promise<{
				ok: boolean;
				toolCount?: number;
				error?: string;
			}>,
		detachApiKeyMcp: (holaAppId: string) =>
			ipcRenderer.invoke(
				"holaApps:detachApiKeyMcp",
				holaAppId,
			) as Promise<void>,
		// Attach a LOCAL (stdio) MCP server the runtime spawns via `command` (drawio)
		// — one-click install + ensure-up on launch. Detach rides holaApps:uninstall.
		attachCommandMcp: (args: {
			holaAppId: string;
			command: string[];
			env?: Record<string, string>;
		}) =>
			ipcRenderer.invoke("holaApps:attachCommandMcp", args) as Promise<void>,
	},
	// Marketplace MCP servers (mcp-catalog install). install/sync carry the user's LOCAL
	// credentials (split by target) into the main process, which writes them to the local
	// workspace.yaml — they never leave the machine or ride a gateway call.
	mcpMarketplace: {
		install: (config: {
			id: string;
			mcpUrl: string;
			holabossHosted: boolean;
			headerKeys: Record<string, string>;
			queryKeys: Record<string, string>;
			envKeys: Record<string, string>;
			tools: string[];
		}) => ipcRenderer.invoke("mcpMarketplace:install", config) as Promise<void>,
		// Attach an APP-OWNED hosted MCP (a HolaApp's hostedMcpInstall) — written to
		// app_servers, bypassing the marketplace's catalog-reconciled install set.
		attachAppOwned: (config: {
			id: string;
			mcpUrl: string;
			holabossHosted: boolean;
			headerKeys: Record<string, string>;
			queryKeys: Record<string, string>;
			envKeys: Record<string, string>;
			tools: string[];
			ownerAppId: string;
		}) =>
			ipcRenderer.invoke(
				"mcpMarketplace:attachAppOwned",
				config,
			) as Promise<void>,
		uninstall: (id: string) =>
			ipcRenderer.invoke("mcpMarketplace:uninstall", id) as Promise<void>,
		sync: (
			configs: {
				id: string;
				mcpUrl: string;
				holabossHosted: boolean;
				headerKeys: Record<string, string>;
				queryKeys: Record<string, string>;
				envKeys: Record<string, string>;
				tools: string[];
			}[],
		) => ipcRenderer.invoke("mcpMarketplace:sync", configs) as Promise<void>,
		// Re-sync the APP-OWNED hosted-MCP set (hostedMcpInstall apps like jianguoyun)
		// so main re-attaches them per turn — the bearer refresh, mirroring `sync` for
		// standalone marketplace MCPs but kept on a separate track (never catalog-reconciled).
		syncAppOwned: (
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
		) =>
			ipcRenderer.invoke(
				"mcpMarketplace:syncAppOwned",
				configs,
			) as Promise<void>,
	},
	// Shell-side receiver for the host bridge: main emits HOST_RENDERER_EVENT
	// after a hosted HolaApp page calls window.__holabossHost.chat.start, having
	// already created the session. The shell opens it + prefills the composer.
	host: {
		onOpenChat: (
			listener: (payload: {
				session: { session_id: string } & Record<string, unknown>;
				input: ChatStartInput;
				sourceAppId: string;
			}) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: {
					session: { session_id: string } & Record<string, unknown>;
					input: ChatStartInput;
					sourceAppId: string;
				},
			) => listener(payload);
			ipcRenderer.on(HOST_RENDERER_EVENT, wrapped);
			return () => ipcRenderer.removeListener(HOST_RENDERER_EVENT, wrapped);
		},
		// Main emits HOST_OPEN_APP_EVENT when a hosted page invokes `item.open` for a
		// holaapp — the shell resolves the app def by ref and opens its surface.
		onOpenApp: (listener: (payload: OpenAppEventPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: OpenAppEventPayload,
			) => listener(payload);
			ipcRenderer.on(HOST_OPEN_APP_EVENT, wrapped);
			return () => ipcRenderer.removeListener(HOST_OPEN_APP_EVENT, wrapped);
		},
		// Main emits HOST_INSTALL_EVENT when a hosted page (HolaHub) invokes the
		// `install` op — the shell's headless installer installs it in place (or
		// opens the native connect surface) and replies via sendInstallResult.
		onInstall: (listener: (payload: InstallEventPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: InstallEventPayload,
			) => listener(payload);
			ipcRenderer.on(HOST_INSTALL_EVENT, wrapped);
			return () => ipcRenderer.removeListener(HOST_INSTALL_EVENT, wrapped);
		},
		// Shell reports the outcome of an install back to main, which relays it to
		// the hosted page that invoked `install`.
		sendInstallResult: (requestId: string, result: InstallResult) =>
			ipcRenderer.send(HOST_INSTALL_RESULT, { requestId, result }),
		// Main emits HOST_INSTALL_STATUS_EVENT when a hosted page invokes
		// `install.status` — the shell replies via sendInstallStatus with what's
		// installed, so the page can show "Installed" for items already present.
		onInstallStatus: (
			listener: (payload: InstallStatusEventPayload) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: InstallStatusEventPayload,
			) => listener(payload);
			ipcRenderer.on(HOST_INSTALL_STATUS_EVENT, wrapped);
			return () =>
				ipcRenderer.removeListener(HOST_INSTALL_STATUS_EVENT, wrapped);
		},
		sendInstallStatus: (requestId: string, list: InstalledList) =>
			ipcRenderer.send(HOST_INSTALL_STATUS_RESULT, { requestId, list }),
		// Main emits HOST_EMPLOYEES_CHANGED_EVENT when the `/employees` web surface
		// invokes `employees.changed` — the shell refetches its HolaEmployee roster
		// so a just-created/renamed/archived employee shows in the sidebar at once.
		onEmployeesChanged: (listener: () => void) => {
			const wrapped = () => listener();
			ipcRenderer.on(HOST_EMPLOYEES_CHANGED_EVENT, wrapped);
			return () =>
				ipcRenderer.removeListener(HOST_EMPLOYEES_CHANGED_EVENT, wrapped);
		},
	},
	holahub: {
		// Shell (ChatPane) stages a desktop output to share; main holds it until the
		// HolaHub web surface pulls it via the holahub.consume-pending-share op.
		stageShare: (draft: ShareDraft): Promise<boolean> =>
			ipcRenderer.invoke("holahub:stage-share", draft) as Promise<boolean>,
	},
	workspace: {
		getClientConfig: () =>
			ipcRenderer.invoke(
				"workspace:getClientConfig",
			) as Promise<HolabossClientConfigPayload>,
		pickTemplateFolder: () =>
			ipcRenderer.invoke(
				"workspace:pickTemplateFolder",
			) as Promise<TemplateFolderSelectionPayload>,
		pickWorkspaceRuntimeFolder: () =>
			ipcRenderer.invoke(
				"workspace:pickWorkspaceRuntimeFolder",
			) as Promise<WorkspaceRuntimeFolderSelectionPayload>,
		pickWorkspaceRelocationFolder: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:pickWorkspaceRelocationFolder",
				workspaceId,
			) as Promise<WorkspaceRuntimeFolderSelectionPayload>,
		relocate: (workspaceId: string, newPath: string) =>
			ipcRenderer.invoke(
				"workspace:relocate",
				workspaceId,
				newPath,
			) as Promise<WorkspaceResponsePayload>,
		activate: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:activate",
				workspaceId,
			) as Promise<WorkspaceResponsePayload>,
		listWorkspaces: () =>
			ipcRenderer.invoke(
				"workspace:listWorkspaces",
			) as Promise<WorkspaceListResponsePayload>,
		listWorkspacesCached: () =>
			ipcRenderer.invoke(
				"workspace:listWorkspacesCached",
			) as Promise<WorkspaceListResponsePayload>,
		getWorkspaceLifecycle: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:getWorkspaceLifecycle",
				workspaceId,
			) as Promise<WorkspaceLifecyclePayload>,
		listWorkspaceCardSummaries: (workspaceIds: string[]) =>
			ipcRenderer.invoke(
				"workspace:listWorkspaceCardSummaries",
				workspaceIds,
			) as Promise<WorkspaceCardSummariesResponsePayload>,
		activateWorkspace: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:activateWorkspace",
				workspaceId,
			) as Promise<WorkspaceLifecyclePayload>,
		openWorkspace: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:openWorkspace",
				workspaceId,
			) as Promise<WorkspaceOpenSessionPayload>,
		listInstalledApps: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listInstalledApps",
				workspaceId,
			) as Promise<InstalledWorkspaceAppListResponsePayload>,
		removeInstalledApp: (workspaceId: string, appId: string) =>
			ipcRenderer.invoke(
				"workspace:removeInstalledApp",
				workspaceId,
				appId,
			) as Promise<void>,
		listActivity: (payload: { workspaceId: string; date: string }) =>
			ipcRenderer.invoke(
				"workspace:listActivity",
				payload,
			) as Promise<WorkspaceActivityResponsePayload>,
		listOutputFolders: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listOutputFolders",
				workspaceId,
			) as Promise<WorkspaceOutputFolderListResponsePayload>,
		searchOutputs: (payload: WorkspaceOutputSearchRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:searchOutputs",
				payload,
			) as Promise<WorkspaceOutputSearchResponsePayload>,
		createOutput: (payload: WorkspaceOutputCreatePayload) =>
			ipcRenderer.invoke(
				"workspace:createOutput",
				payload,
			) as Promise<WorkspaceOutputCreateResponsePayload>,
		updateOutput: (payload: {
			workspaceId: string;
			outputId: string;
			title?: string | null;
			status?: string | null;
			folderId?: string | null;
		}) =>
			ipcRenderer.invoke(
				"workspace:updateOutput",
				payload,
			) as Promise<WorkspaceOutputCreateResponsePayload>,
		deleteOutput: (payload: { workspaceId: string; outputId: string }) =>
			ipcRenderer.invoke("workspace:deleteOutput", payload) as Promise<{
				deleted: boolean;
			}>,
		listArtifactTemplates: () =>
			ipcRenderer.invoke(
				"workspace:listArtifactTemplates",
			) as Promise<ArtifactTemplateListResponsePayload>,
		readArtifactTemplatePreview: (payload: { templateId: string }) =>
			ipcRenderer.invoke(
				"workspace:readArtifactTemplatePreview",
				payload,
			) as Promise<ArtifactTemplatePreviewPayload>,
		saveOutputAsTemplate: (payload: SaveOutputAsArtifactTemplatePayload) =>
			ipcRenderer.invoke(
				"workspace:saveOutputAsTemplate",
				payload,
			) as Promise<ArtifactTemplateRecordPayload>,
		createOutputFromTemplate: (payload: {
			workspaceId: string;
			templateId: string;
			sessionId?: string | null;
			name?: string | null;
		}) =>
			ipcRenderer.invoke(
				"workspace:createOutputFromTemplate",
				payload,
			) as Promise<WorkspaceOutputCreateResponsePayload>,
		deleteArtifactTemplate: (payload: { templateId: string }) =>
			ipcRenderer.invoke(
				"workspace:deleteArtifactTemplate",
				payload,
			) as Promise<{
				deleted: boolean;
			}>,
		listSkills: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listSkills",
				workspaceId,
			) as Promise<WorkspaceSkillListResponsePayload>,
		deleteSkill: (payload: { workspaceId: string; skillId: string }) =>
			ipcRenderer.invoke("workspace:deleteSkill", payload) as Promise<{
				deleted: boolean;
			}>,
		getWorkspaceRoot: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:getWorkspaceRoot",
				workspaceId,
			) as Promise<string>,
		listIssues: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listIssues",
				workspaceId,
			) as Promise<IssueListResponsePayload>,
		createIssue: (payload: CreateIssuePayload) =>
			ipcRenderer.invoke(
				"workspace:createIssue",
				payload,
			) as Promise<CreateIssueResponsePayload>,
		updateIssue: (
			workspaceId: string,
			issueId: string,
			payload: UpdateIssuePayload,
		) =>
			ipcRenderer.invoke(
				"workspace:updateIssue",
				workspaceId,
				issueId,
				payload,
			) as Promise<UpdateIssueResponsePayload>,
		stopIssueRun: (workspaceId: string, issueId: string) =>
			ipcRenderer.invoke(
				"workspace:stopIssueRun",
				workspaceId,
				issueId,
			) as Promise<StopIssueRunResponsePayload>,
		listBackgroundTasks: (payload: BackgroundTaskListRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:listBackgroundTasks",
				payload,
			) as Promise<BackgroundTaskListResponsePayload>,
		archiveBackgroundTask: (payload: ArchiveBackgroundTaskPayload) =>
			ipcRenderer.invoke(
				"workspace:archiveBackgroundTask",
				payload,
			) as Promise<ArchiveBackgroundTaskResponsePayload>,
		continueBackgroundTask: (payload: ContinueBackgroundTaskPayload) =>
			ipcRenderer.invoke(
				"workspace:continueBackgroundTask",
				payload,
			) as Promise<ContinueBackgroundTaskResponsePayload>,
		ensureMainSession: (workspaceId: string, opts?: { create?: boolean }) =>
			ipcRenderer.invoke(
				"workspace:ensureMainSession",
				workspaceId,
				opts,
			) as Promise<EnsureWorkspaceMainSessionResponsePayload>,
		listMainSessions: (workspaceId: string, appId?: string | null) =>
			ipcRenderer.invoke(
				"workspace:listMainSessions",
				workspaceId,
				appId ?? null,
			) as Promise<ListMainSessionsResponsePayload>,
		createMainSession: (
			workspaceId: string,
			payload?: CreateMainSessionPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:createMainSession",
				workspaceId,
				payload ?? {},
			) as Promise<CreateMainSessionResponsePayload>,
		activateMainSession: (workspaceId: string, sessionId: string) =>
			ipcRenderer.invoke(
				"workspace:activateMainSession",
				workspaceId,
				sessionId,
			) as Promise<ActivateMainSessionResponsePayload>,
		updateMainSession: (
			workspaceId: string,
			sessionId: string,
			payload: UpdateMainSessionPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:updateMainSession",
				workspaceId,
				sessionId,
				payload,
			) as Promise<UpdateMainSessionResponsePayload>,
		deleteMainSession: (workspaceId: string, sessionId: string) =>
			ipcRenderer.invoke(
				"workspace:deleteMainSession",
				workspaceId,
				sessionId,
			) as Promise<{ ok: true }>,
		listProjects: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listProjects",
				workspaceId,
			) as Promise<ListWorkspaceProjectsResponsePayload>,
		getConfigYaml: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:getConfigYaml",
				workspaceId,
			) as Promise<WorkspaceConfigYamlPayload>,
		listMcpServers: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listMcpServers",
				workspaceId,
			) as Promise<WorkspaceMcpServersPayload>,
		deleteMcpServer: (workspaceId: string, serverId: string) =>
			ipcRenderer.invoke(
				"workspace:deleteMcpServer",
				workspaceId,
				serverId,
			) as Promise<DeleteWorkspaceMcpServerResponsePayload>,
		refreshMcpTools: (workspaceId: string) =>
			ipcRenderer.invoke("workspace:refreshMcpTools", workspaceId) as Promise<{
				refreshed: boolean;
				servers?: string[];
			}>,
		authorizeMcpServer: (
			workspaceId: string,
			serverId: string,
			reauthorize?: boolean,
		) =>
			ipcRenderer.invoke(
				"workspace:authorizeMcpServer",
				workspaceId,
				serverId,
				reauthorize ?? false,
			) as Promise<{
				ok: boolean;
				server_id: string;
				tool_count: number;
				detail: string;
				requires_session_refresh?: boolean;
			}>,
		mcpServerAuthorized: (workspaceId: string, serverId: string) =>
			ipcRenderer.invoke(
				"workspace:mcpServerAuthorized",
				workspaceId,
				serverId,
			) as Promise<{
				authorized: boolean;
				registered?: boolean;
				server_id?: string;
			}>,
		listHarnessAvailability: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listHarnessAvailability",
				workspaceId,
			) as Promise<ListHarnessAvailabilityResponsePayload>,
		testHarnessConnection: (workspaceId: string, harnessId: string) =>
			ipcRenderer.invoke(
				"workspace:testHarnessConnection",
				workspaceId,
				harnessId,
			) as Promise<HarnessConnectionTestResultPayload>,
		updateSessionHarness: (
			workspaceId: string,
			sessionId: string,
			harnessId: string,
		) =>
			ipcRenderer.invoke(
				"workspace:updateSessionHarness",
				workspaceId,
				sessionId,
				harnessId,
			) as Promise<UpdateSessionHarnessResponsePayload>,
		createProject: (
			workspaceId: string,
			payload: CreateWorkspaceProjectPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:createProject",
				workspaceId,
				payload,
			) as Promise<CreateWorkspaceProjectResponsePayload>,
		updateProject: (
			workspaceId: string,
			projectId: string,
			payload: UpdateWorkspaceProjectPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:updateProject",
				workspaceId,
				projectId,
				payload,
			) as Promise<UpdateWorkspaceProjectResponsePayload>,
		deleteProject: (workspaceId: string, projectId: string) =>
			ipcRenderer.invoke(
				"workspace:deleteProject",
				workspaceId,
				projectId,
			) as Promise<{ ok: true }>,
		pickProjectFolder: () =>
			ipcRenderer.invoke("workspace:pickProjectFolder") as Promise<
				string | null
			>,
		listAgentSessions: (payload: string | ListAgentSessionsRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:listAgentSessions",
				payload,
			) as Promise<AgentSessionListResponsePayload>,
		createAgentSession: (payload: CreateAgentSessionPayload) =>
			ipcRenderer.invoke(
				"workspace:createAgentSession",
				payload,
			) as Promise<CreateAgentSessionResponsePayload>,
		listRuntimeStates: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listRuntimeStates",
				workspaceId,
			) as Promise<SessionRuntimeStateListResponsePayload>,
		getSessionHistory: (payload: SessionHistoryRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:getSessionHistory",
				payload,
			) as Promise<SessionHistoryResponsePayload>,
		listTurnResults: (payload: SessionTurnResultListRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:listTurnResults",
				payload,
			) as Promise<SessionTurnResultListResponsePayload>,
		getSessionOutputEvents: (payload: SessionOutputEventListRequestPayload) =>
			ipcRenderer.invoke(
				"workspace:getSessionOutputEvents",
				payload,
			) as Promise<SessionOutputEventListResponsePayload>,
		stageSessionAttachments: (payload: StageSessionAttachmentsPayload) =>
			ipcRenderer.invoke(
				"workspace:stageSessionAttachments",
				payload,
			) as Promise<StageSessionAttachmentsResponsePayload>,
		stageSessionAttachmentPaths: (
			payload: StageSessionAttachmentPathsPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:stageSessionAttachmentPaths",
				payload,
			) as Promise<StageSessionAttachmentsResponsePayload>,
		queueSessionInput: (payload: HolabossQueueSessionInputPayload) =>
			ipcRenderer.invoke(
				"workspace:queueSessionInput",
				payload,
			) as Promise<EnqueueSessionInputResponsePayload>,
		pauseSessionRun: (payload: HolabossPauseSessionRunPayload) =>
			ipcRenderer.invoke(
				"workspace:pauseSessionRun",
				payload,
			) as Promise<PauseSessionRunResponsePayload>,
		answerUserQuestion: (payload: HolabossAnswerUserQuestionPayload) =>
			ipcRenderer.invoke(
				"workspace:answerUserQuestion",
				payload,
			) as Promise<AnswerUserQuestionResponsePayload>,
		updateQueuedSessionInput: (
			payload: HolabossUpdateQueuedSessionInputPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:updateQueuedSessionInput",
				payload,
			) as Promise<UpdateQueuedSessionInputResponsePayload>,
		cancelQueuedSessionInput: (
			payload: HolabossCancelQueuedSessionInputPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:cancelQueuedSessionInput",
				payload,
			) as Promise<CancelQueuedSessionInputResponsePayload>,
		openSessionOutputStream: (payload: HolabossStreamSessionOutputsPayload) =>
			ipcRenderer.invoke(
				"workspace:openSessionOutputStream",
				payload,
			) as Promise<HolabossSessionStreamHandlePayload>,
		closeSessionOutputStream: (streamId: string, reason?: string) =>
			ipcRenderer.invoke(
				"workspace:closeSessionOutputStream",
				streamId,
				reason,
			) as Promise<void>,
		getSessionStreamDebug: () =>
			ipcRenderer.invoke("workspace:getSessionStreamDebug") as Promise<
				HolabossSessionStreamDebugEntry[]
			>,
		isVerboseTelemetryEnabled: () =>
			ipcRenderer.invoke(
				"workspace:isVerboseTelemetryEnabled",
			) as Promise<boolean>,
		listIntegrationCatalog: () =>
			ipcRenderer.invoke(
				"workspace:listIntegrationCatalog",
			) as Promise<IntegrationCatalogResponsePayload>,
		listIntegrationConnections: (params?: {
			providerId?: string;
			ownerUserId?: string;
		}) =>
			ipcRenderer.invoke(
				"workspace:listIntegrationConnections",
				params,
			) as Promise<IntegrationConnectionListResponsePayload>,
		listIntegrationBindings: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listIntegrationBindings",
				workspaceId,
			) as Promise<IntegrationBindingListResponsePayload>,
		getWorkspaceDefaultAccount: (workspaceId: string, providerId: string) =>
			ipcRenderer.invoke(
				"workspace:getWorkspaceDefaultAccount",
				workspaceId,
				providerId,
			) as Promise<{ connection_id: string | null }>,
		setWorkspaceDefaultAccount: (
			workspaceId: string,
			providerId: string,
			connectionId: string,
		) =>
			ipcRenderer.invoke(
				"workspace:setWorkspaceDefaultAccount",
				workspaceId,
				providerId,
				connectionId,
			) as Promise<{ connection_id: string }>,
		upsertIntegrationBinding: (
			workspaceId: string,
			targetType: string,
			targetId: string,
			integrationKey: string,
			payload: IntegrationUpsertBindingPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:upsertIntegrationBinding",
				workspaceId,
				targetType,
				targetId,
				integrationKey,
				payload,
			) as Promise<IntegrationBindingPayload>,
		createIntegrationConnection: (
			payload: IntegrationCreateConnectionPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:createIntegrationConnection",
				payload,
			) as Promise<IntegrationConnectionPayload>,
		updateIntegrationConnection: (
			connectionId: string,
			payload: IntegrationUpdateConnectionPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:updateIntegrationConnection",
				connectionId,
				payload,
			) as Promise<IntegrationConnectionPayload>,
		deleteIntegrationConnection: (connectionId: string) =>
			ipcRenderer.invoke(
				"workspace:deleteIntegrationConnection",
				connectionId,
			) as Promise<{ deleted: boolean }>,
		mergeIntegrationConnections: (
			keepConnectionId: string,
			removeConnectionIds: string[],
		) =>
			ipcRenderer.invoke(
				"workspace:mergeIntegrationConnections",
				keepConnectionId,
				removeConnectionIds,
			) as Promise<IntegrationMergeConnectionsResult>,
		deleteIntegrationBinding: (bindingId: string, workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:deleteIntegrationBinding",
				bindingId,
				workspaceId,
			) as Promise<{ deleted: boolean }>,
		listConnectionWorkspaceUsage: () =>
			ipcRenderer.invoke(
				"workspace:listConnectionWorkspaceUsage",
			) as Promise<ConnectionWorkspaceUsagePayload>,
		listIntegrationStoreCatalog: () =>
			ipcRenderer.invoke(
				"workspace:listIntegrationStoreCatalog",
			) as Promise<IntegrationStoreCatalogPayload>,
		listMemoryBrowserTree: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:listMemoryBrowserTree",
				workspaceId,
			) as Promise<MemoryBrowserTreeResponsePayload>,
		readMemoryBrowserFile: (workspaceId: string, targetPath: string) =>
			ipcRenderer.invoke(
				"workspace:readMemoryBrowserFile",
				workspaceId,
				targetPath,
			) as Promise<MemoryBrowserFileResponsePayload>,
		readMemoryBrowserNodeDetail: (
			workspaceId: string,
			params: { nodeId: string; treeId?: string | null },
		) =>
			ipcRenderer.invoke(
				"workspace:readMemoryBrowserNodeDetail",
				workspaceId,
				params,
			) as Promise<MemoryBrowserNodeDetailResponsePayload>,
		listMemoryBrowserGraph: (
			workspaceId: string,
			params: {
				forest: MemoryBrowserGraphForestPayload;
				treeId?: string | null;
				maxLayers?: number | null;
				maxNodes?: number | null;
			},
		) =>
			ipcRenderer.invoke(
				"workspace:listMemoryBrowserGraph",
				workspaceId,
				params,
			) as Promise<MemoryBrowserGraphResponsePayload>,
		restartApp: (workspaceId: string, appId: string) =>
			ipcRenderer.invoke(
				"workspace:restartApp",
				workspaceId,
				appId,
			) as Promise<{
				workspace_id: string;
				app_id: string;
				restarted: boolean;
			}>,
		listOAuthConfigs: () =>
			ipcRenderer.invoke(
				"workspace:listOAuthConfigs",
			) as Promise<OAuthAppConfigListResponsePayload>,
		upsertOAuthConfig: (
			providerId: string,
			payload: OAuthAppConfigUpsertPayload,
		) =>
			ipcRenderer.invoke(
				"workspace:upsertOAuthConfig",
				providerId,
				payload,
			) as Promise<OAuthAppConfigPayload>,
		deleteOAuthConfig: (providerId: string) =>
			ipcRenderer.invoke("workspace:deleteOAuthConfig", providerId) as Promise<{
				deleted: boolean;
			}>,
		startOAuthFlow: (provider: string) =>
			ipcRenderer.invoke(
				"workspace:startOAuthFlow",
				provider,
			) as Promise<OAuthAuthorizeResponsePayload>,
		composioListToolkits: () =>
			ipcRenderer.invoke("workspace:composioListToolkits") as Promise<{
				toolkits: Array<{
					slug: string;
					name: string;
					description: string;
					logo: string | null;
					auth_schemes: string[];
					categories: string[];
				}>;
			}>,
		composioListConnections: (force?: boolean) =>
			ipcRenderer.invoke(
				"workspace:composioListConnections",
				force,
			) as Promise<{
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
			}>,
		composioExecute: (params: {
			providerSlug: string;
			toolSlug: string;
			arguments?: Record<string, unknown>;
		}) =>
			ipcRenderer.invoke(
				"workspace:composioExecute",
				params,
			) as Promise<unknown>,
		debugComposioRuntimeTest: (params?: {
			providerSlug?: string;
			toolSlug?: string;
			arguments?: Record<string, unknown>;
		}) =>
			ipcRenderer.invoke(
				"workspace:debugComposioRuntimeTest",
				params,
			) as Promise<unknown>,
		composioConnect: (payload: {
			provider: string;
			owner_user_id: string;
			callback_url?: string;
			whoami?: PendingIntegrationWhoami | null;
			auth_scheme?: string;
			credentials?: Record<string, string>;
		}) =>
			ipcRenderer.invoke(
				"workspace:composioConnect",
				payload,
			) as Promise<ComposioConnectResult>,
		composioToolkitAuth: (toolkitSlug: string) =>
			ipcRenderer.invoke(
				"workspace:composioToolkitAuth",
				toolkitSlug,
			) as Promise<ComposioToolkitAuth>,
		composioReconnect: (connectedAccountId: string) =>
			ipcRenderer.invoke(
				"workspace:composioReconnect",
				connectedAccountId,
			) as Promise<{
				id: string;
				status: string;
				redirect_url: string | null;
			}>,
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
			ipcRenderer.invoke(
				"workspace:composioFinalize",
				payload,
			) as Promise<IntegrationConnectionPayload>,
		composioRefreshConnection: (connectionId: string) =>
			ipcRenderer.invoke(
				"workspace:composioRefreshConnection",
				connectionId,
			) as Promise<{
				connection: IntegrationConnectionPayload;
				changed: boolean;
				reason?: "no_external_id" | "account_missing" | "no_new_identity";
			}>,
		composioDeleteUpstream: (connectedAccountId: string) =>
			ipcRenderer.invoke(
				"workspace:composioDeleteUpstream",
				connectedAccountId,
			) as Promise<{ deleted: boolean; missing: boolean }>,
		composioMcpEnsureRunning: (workspaceId: string) =>
			ipcRenderer.invoke(
				"workspace:composioMcpEnsureRunning",
				workspaceId,
			) as Promise<unknown>,
		resolveTemplateIntegrations: (payload: HolabossCreateWorkspacePayload) =>
			ipcRenderer.invoke(
				"workspace:resolveTemplateIntegrations",
				payload,
			) as Promise<ResolveTemplateIntegrationsResult>,
		generateTemplateContent: (params: {
			contentType: "onboarding" | "readme";
			name: string;
			description: string;
			category: string;
			tags: string[];
			apps: string[];
		}) =>
			ipcRenderer.invoke(
				"workspace:generateTemplateContent",
				params,
			) as Promise<{ content: string }>,
		createSubmission: (payload: CreateSubmissionPayload) =>
			ipcRenderer.invoke(
				"workspace:createSubmission",
				payload,
			) as Promise<CreateSubmissionResponse>,
		packageAndUploadWorkspace: (params: {
			workspaceId: string;
			apps: string[];
			manifest: Record<string, unknown>;
			uploadUrl: string;
			forceExcludePaths?: string[];
		}) =>
			ipcRenderer.invoke(
				"workspace:packageAndUploadWorkspace",
				params,
			) as Promise<PackageAndUploadResult>,
		onPublishProgress: (
			listener: (payload: PublishProgressPayload) => void,
		) => {
			const wrapped = (
				_e: Electron.IpcRendererEvent,
				payload: PublishProgressPayload,
			) => listener(payload);
			ipcRenderer.on("workspace:publishProgress", wrapped);
			return () =>
				ipcRenderer.removeListener("workspace:publishProgress", wrapped);
		},
		previewBundle: (params: {
			workspaceId: string;
			apps: string[];
			forceExcludePaths?: string[];
		}) =>
			ipcRenderer.invoke(
				"workspace:previewBundle",
				params,
			) as Promise<BundlePreviewPayload>,
		checkTemplateName: (name: string) =>
			ipcRenderer.invoke(
				"workspace:checkTemplateName",
				name,
			) as Promise<TemplateNameCheckPayload>,
		finalizeSubmission: (submissionId: string) =>
			ipcRenderer.invoke(
				"workspace:finalizeSubmission",
				submissionId,
			) as Promise<FinalizeSubmissionResponse>,
		listSubmissions: () =>
			ipcRenderer.invoke(
				"workspace:listSubmissions",
			) as Promise<SubmissionListResponse>,
		deleteSubmission: (submissionId: string) =>
			ipcRenderer.invoke("workspace:deleteSubmission", {
				submissionId,
			}) as Promise<{ deleted: boolean }>,
		setOperatorSurfaceContext: (
			workspaceId: string,
			context: OperatorSurfaceContextPayload | null,
		) =>
			ipcRenderer.invoke(
				"workspace:setOperatorSurfaceContext",
				workspaceId,
				context,
			) as Promise<void>,
		onSessionStreamEvent: (
			listener: (payload: HolabossSessionStreamEventPayload) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: HolabossSessionStreamEventPayload,
			) => listener(payload);
			ipcRenderer.on("workspace:sessionStream", wrapped);
			return () =>
				ipcRenderer.removeListener("workspace:sessionStream", wrapped);
		},
	},
	holaemployee: {
		listEmployees: () =>
			ipcRenderer.invoke("holaemployee:listEmployees") as Promise<
				HolaEmployeeSummaryPayload[]
			>,
		listThreads: (employeeId: string) =>
			ipcRenderer.invoke("holaemployee:listThreads", employeeId) as Promise<
				HolaEmployeeThreadPayload[]
			>,
		threadHistory: (employeeId: string, threadId: string) =>
			ipcRenderer.invoke(
				"holaemployee:threadHistory",
				employeeId,
				threadId,
			) as Promise<unknown[]>,
		getEquipment: (employeeId: string) =>
			ipcRenderer.invoke(
				"holaemployee:getEquipment",
				employeeId,
			) as Promise<HolaEmployeeEquipmentPayload>,
		openChatStream: (payload: {
			employeeId: string;
			threadId: string;
			message: string;
			attachments?: { name: string; mimeType: string; contentBase64: string }[];
		}) =>
			ipcRenderer.invoke(
				"holaemployee:openChatStream",
				payload,
			) as Promise<HolabossSessionStreamHandlePayload>,
		closeChatStream: (streamId: string) =>
			ipcRenderer.invoke(
				"holaemployee:closeChatStream",
				streamId,
			) as Promise<void>,
		onChatStreamEvent: (
			listener: (payload: HolabossSessionStreamEventPayload) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: HolabossSessionStreamEventPayload,
			) => listener(payload);
			ipcRenderer.on("holaemployee:chatStream", wrapped);
			return () =>
				ipcRenderer.removeListener("holaemployee:chatStream", wrapped);
		},
	},
	auth: {
		getUser: () =>
			ipcRenderer.invoke("auth:getUser") as Promise<AuthUserPayload | null>,
		// Renderer-direct BFF clients (e.g. @holaboss/app-sdk in renderer,
		// billing RPC) reach the BFF via the bff:fetch bridge below — the
		// raw cookie stays in main. These two accessors expose only the host
		// URL the renderer should target.
		getApiBaseUrl: () =>
			ipcRenderer.invoke("auth:getApiBaseUrl") as Promise<string>,
		getMarketplaceBaseUrl: () =>
			ipcRenderer.invoke("auth:getMarketplaceBaseUrl") as Promise<string>,
		getBackendBaseUrl: () =>
			ipcRenderer.invoke("auth:getBackendBaseUrl") as Promise<string>,
		requestAuth: () => ipcRenderer.invoke("auth:requestAuth") as Promise<void>,
		signOut: () => ipcRenderer.invoke("auth:signOut") as Promise<void>,
		// Organization (tenant) context. Switching the active org re-scopes every
		// backend call (the gateway injects x-holaboss-org-id from the session).
		listOrganizations: () =>
			ipcRenderer.invoke("auth:listOrganizations") as Promise<
				DesktopOrganizationPayload[]
			>,
		getActiveOrganization: () =>
			ipcRenderer.invoke(
				"auth:getActiveOrganization",
			) as Promise<DesktopActiveOrganizationPayload | null>,
		setActiveOrganization: (organizationId: string | null) =>
			ipcRenderer.invoke(
				"auth:setActiveOrganization",
				organizationId,
			) as Promise<DesktopActiveOrganizationPayload | null>,
		// Org member management (the active org's member + invitation list comes from
		// getActiveOrganization; these are the mutations). Each resolves { ok, error? }.
		inviteOrgMember: (payload: { email: string; role: "admin" | "member" }) =>
			ipcRenderer.invoke("auth:inviteOrgMember", payload) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		removeOrgMember: (memberIdOrEmail: string) =>
			ipcRenderer.invoke("auth:removeOrgMember", memberIdOrEmail) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		updateOrgMemberRole: (payload: {
			memberId: string;
			role: "admin" | "member";
		}) =>
			ipcRenderer.invoke("auth:updateOrgMemberRole", payload) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		cancelOrgInvitation: (invitationId: string) =>
			ipcRenderer.invoke("auth:cancelOrgInvitation", invitationId) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		showPopup: (anchorBounds: BrowserAnchorBoundsPayload) =>
			ipcRenderer.invoke("auth:showPopup", anchorBounds) as Promise<void>,
		togglePopup: (anchorBounds: BrowserAnchorBoundsPayload) =>
			ipcRenderer.invoke("auth:togglePopup", anchorBounds) as Promise<void>,
		scheduleClosePopup: (delayMs?: number) =>
			ipcRenderer.invoke("auth:scheduleClosePopup", delayMs) as Promise<void>,
		cancelClosePopup: () =>
			ipcRenderer.invoke("auth:cancelClosePopup") as Promise<void>,
		closePopup: () => ipcRenderer.invoke("auth:closePopup") as Promise<void>,
		onAuthenticated: (listener: (user: AuthUserPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				user: AuthUserPayload,
			) => listener(user);
			ipcRenderer.on("auth:authenticated", wrapped);
			return () => ipcRenderer.removeListener("auth:authenticated", wrapped);
		},
		onUserUpdated: (listener: (user: AuthUserPayload | null) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				user: AuthUserPayload | null,
			) => listener(user);
			ipcRenderer.on("auth:userUpdated", wrapped);
			return () => ipcRenderer.removeListener("auth:userUpdated", wrapped);
		},
		onError: (listener: (payload: AuthErrorPayload) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: AuthErrorPayload,
			) => listener(payload);
			ipcRenderer.on("auth:error", wrapped);
			return () => ipcRenderer.removeListener("auth:error", wrapped);
		},
	},
	composio: {
		// Subscribe to the cloud BFF's SSE stream of Composio
		// `connected_account.*` events. Renderer never opens the EventSource
		// itself — main owns the long-lived connection and forwards each frame
		// over IPC. Match the event's `connection_id` (Composio's ca_xxx)
		// against the local row's `account_external_id` to find what to refetch.
		onConnectionInvalidated: (
			listener: (payload: ComposioConnectionInvalidatedEvent) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: ComposioConnectionInvalidatedEvent,
			) => listener(payload);
			ipcRenderer.on(COMPOSIO_EVENTS_INVALIDATED_CHANNEL, wrapped);
			return () =>
				ipcRenderer.removeListener(
					COMPOSIO_EVENTS_INVALIDATED_CHANNEL,
					wrapped,
				);
		},
		onStatusChange: (
			listener: (payload: ComposioEventsBridgeStatus) => void,
		) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				payload: ComposioEventsBridgeStatus,
			) => listener(payload);
			ipcRenderer.on(COMPOSIO_EVENTS_STATUS_CHANNEL, wrapped);
			return () =>
				ipcRenderer.removeListener(COMPOSIO_EVENTS_STATUS_CHANNEL, wrapped);
		},
	},
	tabs: {
		showContextMenu: (opts: {
			canCloseLeft: boolean;
			canCloseRight: boolean;
			canCloseOthers: boolean;
			canCloseAll?: boolean;
			hasDeleteFile: boolean;
		}) =>
			ipcRenderer.invoke("tabs:showContextMenu", opts) as Promise<
				| "close"
				| "closeOthers"
				| "closeToLeft"
				| "closeToRight"
				| "closeAll"
				| "deleteFile"
				| null
			>,
	},
	profiles: {
		list: () =>
			ipcRenderer.invoke("profiles:list") as Promise<BrowserProfilePayload[]>,
		create: (name?: string | null) =>
			ipcRenderer.invoke(
				"profiles:create",
				name,
			) as Promise<BrowserProfilePayload>,
		rename: (profileId: string, name: string) =>
			ipcRenderer.invoke("profiles:rename", profileId, name) as Promise<
				BrowserProfilePayload[]
			>,
		remove: (profileId: string) =>
			ipcRenderer.invoke("profiles:delete", profileId) as Promise<{
				deleted: boolean;
				profiles: BrowserProfilePayload[];
			}>,
		setDefault: (profileId: string) =>
			ipcRenderer.invoke("profiles:setDefault", profileId) as Promise<
				BrowserProfilePayload[]
			>,
		launch: (profileId: string, url?: string | null) =>
			ipcRenderer.invoke("profiles:launch", profileId, url ?? null) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		listImportSources: (source: BrowserImportSource) =>
			ipcRenderer.invoke("profiles:listImportSources", source) as Promise<
				BrowserImportProfileOptionPayload[]
			>,
		import: (payload: ProfileImportRequestPayload) =>
			ipcRenderer.invoke(
				"profiles:import",
				payload,
			) as Promise<ProfileImportResultPayload>,
		importSpreadsheet: (fileBytes: ArrayBuffer) =>
			ipcRenderer.invoke("profiles:importSpreadsheet", fileBytes) as Promise<{
				ok: boolean;
				error?: string;
				imported: number;
				warnings: string[];
			}>,
		fingerprintAvailable: () =>
			ipcRenderer.invoke("profiles:fingerprintAvailable") as Promise<boolean>,
		installedEngineInfo: () =>
			ipcRenderer.invoke("fingerprint:installedInfo") as Promise<{
				present: boolean;
				version?: string;
				dir: string;
			}>,
		engineDownloadAvailable: () =>
			ipcRenderer.invoke("fingerprint:downloadAvailable") as Promise<boolean>,
		installEngineFromFile: () =>
			ipcRenderer.invoke("fingerprint:installFromFile") as Promise<{
				ok: boolean;
				canceled?: boolean;
				error?: string;
				info?: { present: boolean; version?: string; dir: string };
			}>,
		installEngineFromUrl: () =>
			ipcRenderer.invoke("fingerprint:installFromUrl") as Promise<{
				ok: boolean;
				error?: string;
				info?: { present: boolean; version?: string; dir: string };
			}>,
		onEngineInstallProgress: (
			listener: (progress: {
				phase: "downloading" | "extracting" | "installing" | "done" | "error";
				pct?: number;
				message?: string;
			}) => void,
		) => {
			const wrapped = (_event: Electron.IpcRendererEvent, progress: unknown) =>
				listener(
					progress as {
						phase: "downloading" | "extracting" | "installing" | "done" | "error";
						pct?: number;
						message?: string;
					},
				);
			ipcRenderer.on("fingerprint:installProgress", wrapped);
			return () =>
				ipcRenderer.removeListener("fingerprint:installProgress", wrapped);
		},
		close: (profileId: string) =>
			ipcRenderer.invoke("profiles:close", profileId) as Promise<{
				ok: boolean;
			}>,
		runningIds: () =>
			ipcRenderer.invoke("profiles:runningIds") as Promise<string[]>,
		setEngine: (profileId: string, engine: "system" | "fingerprint") =>
			ipcRenderer.invoke("profiles:setEngine", profileId, engine) as Promise<
				BrowserProfilePayload[]
			>,
		setFingerprint: (profileId: string, fingerprint: FingerprintPayload) =>
			ipcRenderer.invoke(
				"profiles:setFingerprint",
				profileId,
				fingerprint,
			) as Promise<BrowserProfilePayload[]>,
		previewFingerprint: (fingerprint: FingerprintPayload) =>
			ipcRenderer.invoke(
				"profiles:previewFingerprint",
				fingerprint,
			) as Promise<{ warnings: string[] }>,
		onRunningChange: (listener: (runningIds: string[]) => void) => {
			const wrapped = (
				_event: Electron.IpcRendererEvent,
				runningIds: string[],
			) => listener(runningIds);
			ipcRenderer.on("profiles:running", wrapped);
			return () => ipcRenderer.removeListener("profiles:running", wrapped);
		},
	},
	fingerprintTemplates: {
		list: () =>
			ipcRenderer.invoke("fptemplates:list") as Promise<
				FingerprintTemplatePayload[]
			>,
		import: (raw: unknown) =>
			ipcRenderer.invoke("fptemplates:import", raw) as Promise<{
				templates: FingerprintTemplatePayload[];
				warnings: string[];
			}>,
		save: (name: string, fingerprint: FingerprintPayload) =>
			ipcRenderer.invoke("fptemplates:save", name, fingerprint) as Promise<
				FingerprintTemplatePayload[]
			>,
		delete: (id: string) =>
			ipcRenderer.invoke("fptemplates:delete", id) as Promise<
				FingerprintTemplatePayload[]
			>,
	},
});
