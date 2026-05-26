import {
  ArrowLeft,
  Boxes,
  Clock3,
  Folder,
  Globe,
  Inbox,
  LayoutGrid,
  Loader2,
  MessageCircle,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { appShellMainGridClassName } from "@/components/layout/appShellLayout";
import { BlockingErrorScreen } from "@/components/layout/BlockingErrorScreen";
import { NotificationToastStack } from "@/components/layout/NotificationToastStack";
import {
  type OperationsDrawerTab,
  OperationsInboxPane,
} from "@/components/layout/OperationsDrawer";
import { BootSplash } from "@/components/layout/BootSplash";
import { SettingsScreenRoot } from "@/components/layout/SettingsScreenRoot";
import { TopTabsBar } from "@/components/layout/TopTabsBar";
import { WorkspaceControlCenter } from "@/components/layout/WorkspaceControlCenter";
import { WorkspaceAppsDialog } from "@/components/layout/WorkspaceAppsDialog";
import { FirstWorkspacePane } from "@/components/onboarding";
import { WorkspaceOnboardingSurface } from "@/features/workspace-onboarding/WorkspaceOnboardingSurface";
import { AppSurfacePane } from "@/components/panes/AppSurfacePane";
import { BrowserPane } from "@/components/panes/BrowserPane";
import { ArtifactsPane } from "@/components/panes/ArtifactsPane";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { ChatPane } from "@/components/panes/ChatPane";
import {
  type FileExplorerFocusRequest,
  FileExplorerPane,
} from "@/components/panes/FileExplorerPane";
import { InternalSurfacePane } from "@/components/panes/InternalSurfacePane";
import { MissingWorkspacePane } from "@/components/panes/MissingWorkspacePane";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { SpaceApplicationsExplorerPane } from "@/components/panes/SpaceApplicationsExplorerPane";
import { SpaceBrowserDisplayPane } from "@/components/panes/SpaceBrowserDisplayPane";
import { SpaceBrowserExplorerPane } from "@/components/panes/SpaceBrowserExplorerPane";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { Button } from "@/components/ui/button";
import { UpdateReminder } from "@/components/ui/UpdateReminder";
import { StoplightProvider } from "@/lib/StoplightContext";
import { type ExplorerAttachmentDragPayload } from "@/lib/attachmentDrag";
import { CHAT_LAYOUT } from "@/lib/chatLayout";
import { useControlCenterCardSignals } from "@/lib/controlCenterLifecycle";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { cn } from "@/lib/utils";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
import {
  pushRendererSentryActivity,
  useRendererSentrySection,
} from "@/lib/rendererSentry";
import { getWorkspaceAppDefinition } from "@/lib/workspaceApps";
import {
  useWorkspaceDesktop,
  WorkspaceDesktopProvider,
} from "@/lib/workspaceDesktop";
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
} from "@/lib/workspaceSelection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const THEME_STORAGE_KEY = "holaboss-theme-v1";
const DEV_APP_UPDATE_PREVIEW_STORAGE_KEY = "holaboss-dev-app-update-preview-v1";
const DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX =
  "dev-notification-toast-preview:";
const TASK_PROPOSAL_TOAST_ID_PREFIX = "task-proposal-toast:";
const OPERATIONS_DRAWER_OPEN_STORAGE_KEY = "holaboss-operations-drawer-open-v1";
const OPERATIONS_DRAWER_TAB_STORAGE_KEY = "holaboss-operations-drawer-tab-v1";
const TASK_PROPOSAL_SEEN_STORAGE_KEY = "holaboss-task-proposal-seen-v1";
const CHAT_MODEL_STORAGE_KEY = "holaboss-chat-model-v1";
const CHAT_MODEL_USE_RUNTIME_DEFAULT = "__runtime_default__";
const BROWSER_PANE_WIDTH_STORAGE_KEY = "holaboss-browser-pane-width-v1";
const SPACE_VISIBILITY_STORAGE_KEY = "holaboss-space-visibility-v1";
const SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY =
  "holaboss-space-workspace-panel-collapsed-v1";
const CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY =
  "holaboss-control-center-cards-per-row-v1";
const CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY =
  "holaboss-control-center-workspace-card-order-v1";
const LAST_SHELL_VIEW_STORAGE_KEY = "holaboss-last-shell-view-v1";
const THEMES = [
  "holaos-dark",
  "holaos-light",
  "catppuccin-dark",
  "catppuccin-light",
  "rose-pine-dark",
  "rose-pine-light",
  "solarized-dark",
  "solarized-light",
  "nord-dark",
  "nord-light",
  "one-dark-pro-dark",
  "one-dark-pro-light",
  "gruvbox-dark",
  "gruvbox-light",
  "vitesse-dark",
  "vitesse-light",
] as const;
const MIN_EXPLORER_PANEL_WIDTH = 220;
const MAX_EXPLORER_PANEL_WIDTH = 480;
const EXPLORER_REVEAL_SNAP_THRESHOLD = 90;
const EXPLORER_DRAG_ACTIVATION_DELTA = 4;
const MIN_FILES_PANE_WIDTH = MIN_EXPLORER_PANEL_WIDTH;
const MIN_BROWSER_PANE_WIDTH = 120;
const MAX_UTILITY_PANE_WIDTH = 720;
const DEFAULT_FILES_PANE_WIDTH = 260;
const DEFAULT_BROWSER_PANE_WIDTH = 460;
const MIN_AGENT_CONTENT_WIDTH = 380;
const SPACE_AGENT_PANE_WIDTH = 420;
const SPACE_DISPLAY_MIN_WIDTH = 420;
const SPACE_EXPLORER_RAIL_WIDTH = 52;
const UTILITY_PANE_RESIZER_WIDTH = 16;
const APP_UPDATE_CHANGELOG_BASE_URL =
  "https://github.com/holaboss-ai/holaOS-releases/releases/tag";
const MAX_SEEN_TASK_PROPOSAL_IDS_PER_WORKSPACE = 200;

function currentComposerSelectedModel(
  runtimeConfig: RuntimeConfigPayload | null,
): string | null {
  const runtimeDefaultModel = (runtimeConfig?.defaultModel ?? "").trim();
  try {
    const storedModel = (localStorage.getItem(CHAT_MODEL_STORAGE_KEY) ?? "").trim();
    if (!storedModel || storedModel === CHAT_MODEL_USE_RUNTIME_DEFAULT) {
      return runtimeDefaultModel || null;
    }
    return storedModel;
  } catch {
    return runtimeDefaultModel || null;
  }
}

type SpaceComponentId = "agent" | "files" | "browser";
type UtilityPaneId = "files" | "browser";
type DevAppUpdatePreviewMode = "off" | "downloading" | "ready";
type SpaceExplorerMode = "files" | "browser" | "applications";
type ShellView = "control_center" | "space";

type SpaceVisibilityState = Record<SpaceComponentId, boolean>;

type UtilityPaneResizeState =
  | {
      mode: "single";
      paneId: UtilityPaneId;
      startWidth: number;
      startX: number;
      direction: 1 | -1;
    }
  | {
      mode: "pair";
      leftPaneId: UtilityPaneId;
      rightPaneId: UtilityPaneId;
      startLeftWidth: number;
      startRightWidth: number;
      startX: number;
    };

const FIXED_SPACE_ORDER: SpaceComponentId[] = ["files", "browser", "agent"];
const DEFAULT_SPACE_VISIBILITY: SpaceVisibilityState = {
  agent: true,
  files: true,
  browser: true,
};

declare global {
  interface Window {
    __holabossDevUpdatePreview?: {
      downloading: () => void;
      ready: () => void;
      clear: () => void;
    };
    __holabossDevNotificationToastPreview?: {
      stack: () => void;
      clear: () => void;
    };
  }
}

export type AppTheme = (typeof THEMES)[number];

function isAppTheme(value: string): value is AppTheme {
  return THEMES.includes(value as AppTheme);
}

// Appearance model — two orthogonal axes combined into the legacy AppTheme
// string for Electron IPC and `data-theme` application.
export const THEME_VARIANTS = [
  "holaos",
  "catppuccin",
  "rose-pine",
  "solarized",
  "nord",
  "one-dark-pro",
  "gruvbox",
  "vitesse",
] as const;

export type ThemeVariant = (typeof THEME_VARIANTS)[number];

function isThemeVariant(value: string): value is ThemeVariant {
  return THEME_VARIANTS.includes(value as ThemeVariant);
}

export type ColorScheme = "system" | "light" | "dark";
export type ControlCenterCardsPerRow = 2 | 3 | 4;

function isColorScheme(value: string): value is ColorScheme {
  return value === "system" || value === "light" || value === "dark";
}

function isControlCenterCardsPerRow(
  value: number,
): value is ControlCenterCardsPerRow {
  return value === 2 || value === 3 || value === 4;
}

const COLOR_SCHEME_STORAGE_KEY = "holaboss-color-scheme";
const THEME_VARIANT_STORAGE_KEY = "holaboss-theme-variant";

function isSettingsPaneSection(value: string): value is UiSettingsPaneSection {
  return (
    value === "account" ||
    value === "billing" ||
    value === "providers" ||
    value === "integrations" ||
    value === "memory" ||
    value === "submissions" ||
    value === "settings" ||
    value === "experimental"
  );
}

type AgentView =
  | { type: "chat" }
  | { type: "sessions" }
  | { type: "inbox" }
  | { type: "automations" }
  | { type: "artifacts" }
  | {
      type: "app";
      appId: string;
      path?: string | null;
      resourceId?: string | null;
      view?: string | null;
    }
  | {
      type: "internal";
      surface: "document" | "preview" | "file" | "event";
      resourceId?: string | null;
      htmlContent?: string | null;
    };

type SpaceDisplayView =
  | { type: "browser" }
  | {
      type: "app";
      appId: string;
      path?: string | null;
      resourceId?: string | null;
      view?: string | null;
    }
  | {
      type: "internal";
      surface: "document" | "preview" | "file" | "event";
      resourceId?: string | null;
      htmlContent?: string | null;
    }
  | { type: "empty" };

type RestorableSpaceFileDisplayView = Extract<
  SpaceDisplayView,
  { type: "internal" }
>;
type RestorableSpaceAppDisplayView = Extract<SpaceDisplayView, { type: "app" }>;

type ChatSessionOpenRequest = {
  sessionId: string;
  requestKey: number;
  mode?: "session" | "draft";
  parentSessionId?: string | null;
};

type ChatComposerPrefillRequest = {
  text: string;
  requestKey: number;
  mode?: "replace" | "append";
};

type ChatExplorerAttachmentRequest = {
  files: ExplorerAttachmentDragPayload[];
  requestKey: number;
};

type WorkspaceOutputNavigationTarget =
  | {
      type: "app";
      appId: string;
      path?: string | null;
      resourceId?: string | null;
      view?: string | null;
    }
  | {
      type: "internal";
      surface: "document" | "preview" | "file" | "event";
      resourceId?: string | null;
      htmlContent?: string | null;
    };

type ReportedOperatorSurfaceContext = {
  active_surface_id: string | null;
  surfaces: OperatorSurfacePayload[];
};

function summarizeAppShellView(
  view: AgentView | SpaceDisplayView,
): Record<string, unknown> {
  switch (view.type) {
    case "app":
      return {
        type: view.type,
        app_id: view.appId,
        path: view.path ?? null,
        resource_id: view.resourceId ?? null,
        view_id: view.view ?? null,
      };
    case "internal":
      return {
        type: view.type,
        surface: view.surface,
        resource_id: view.resourceId ?? null,
      };
    default:
      return {
        type: view.type,
      };
  }
}

function summarizeRuntimeStatusForSentry(
  runtimeStatus: RuntimeStatusPayload | null,
): Record<string, unknown> | null {
  if (!runtimeStatus) {
    return null;
  }
  return {
    status: runtimeStatus.status,
    available: runtimeStatus.available,
    pid: runtimeStatus.pid,
    harness: runtimeStatus.harness ?? null,
    desktop_browser_ready: runtimeStatus.desktopBrowserReady,
    last_error: runtimeStatus.lastError || null,
  };
}

function summarizeAppUpdateStatusForSentry(
  status: AppUpdateStatusPayload | null,
): Record<string, unknown> | null {
  if (!status) {
    return null;
  }
  return {
    supported: status.supported,
    checking: status.checking,
    available: status.available,
    downloaded: status.downloaded,
    current_version: status.currentVersion,
    latest_version: status.latestVersion ?? null,
    channel: status.channel,
    preferred_channel: status.preferredChannel ?? null,
    error: status.error || null,
  };
}

function nonEmptySurfaceText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function surfaceResourceLabel(resourceId: string): string {
  const normalized = resourceId.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function normalizeComparablePath(targetPath: string) {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return "";
  }

  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function isPathWithin(parentPath: string, targetPath: string) {
  const normalizedParent = normalizeComparablePath(parentPath);
  const normalizedTarget = normalizeComparablePath(targetPath);
  if (!normalizedParent || !normalizedTarget) {
    return false;
  }
  return (
    normalizedTarget === normalizedParent ||
    normalizedTarget.startsWith(`${normalizedParent}/`)
  );
}

function buildReportedSurfaceFromInternalView(params: {
  owner: OperatorSurfaceOwner;
  active: boolean;
  view:
    | Extract<AgentView, { type: "internal" }>
    | Extract<SpaceDisplayView, { type: "internal" }>;
}): OperatorSurfacePayload | null {
  const resourceId = nonEmptySurfaceText(params.view.resourceId);
  const ownerLabel = params.owner === "user" ? "User" : "Agent";
  const mutability: OperatorSurfaceMutability =
    params.owner === "agent" ? "agent_owned" : "inspect_only";

  if (
    (params.view.surface === "document" || params.view.surface === "file") &&
    resourceId
  ) {
    const fileName = surfaceResourceLabel(resourceId);
    return {
      surface_id: `editor:${params.owner}:${resourceId}`,
      surface_type: "editor",
      owner: params.owner,
      active: params.active,
      mutability,
      summary: `${ownerLabel} is currently viewing file "${fileName}" at \`${resourceId}\`.`,
    };
  }

  if (params.view.surface === "preview" || params.view.surface === "event") {
    const normalizedResourceId = resourceId || "current";
    return {
      surface_id: `app_surface:${params.owner}:${params.view.surface}:${normalizedResourceId}`,
      surface_type: "app_surface",
      owner: params.owner,
      active: params.active,
      mutability,
      summary:
        params.view.surface === "preview"
          ? `${ownerLabel} is currently viewing an internal preview surface${resourceId ? ` for \`${resourceId}\`` : ""}.`
          : `${ownerLabel} is currently viewing an internal event surface${resourceId ? ` for \`${resourceId}\`` : ""}.`,
    };
  }

  return null;
}

function buildReportedSurfaceFromAppView(params: {
  owner: OperatorSurfaceOwner;
  active: boolean;
  view:
    | Extract<AgentView, { type: "app" }>
    | Extract<SpaceDisplayView, { type: "app" }>;
}): OperatorSurfacePayload {
  const resourceId = nonEmptySurfaceText(params.view.resourceId);
  const routePath = nonEmptySurfaceText(params.view.path);
  const viewId = nonEmptySurfaceText(params.view.view);
  const ownerLabel = params.owner === "user" ? "User" : "Agent";
  const mutability: OperatorSurfaceMutability =
    params.owner === "agent" ? "agent_owned" : "inspect_only";
  return {
    surface_id: `app_surface:${params.owner}:${params.view.appId}:${resourceId || routePath || viewId || "current"}`,
    surface_type: "app_surface",
    owner: params.owner,
    active: params.active,
    mutability,
    summary: `${ownerLabel} is currently viewing workspace app \`${params.view.appId}\`${resourceId ? ` resource \`${resourceId}\`` : routePath ? ` route \`${routePath}\`` : ""}${viewId ? ` in view \`${viewId}\`` : ""}.`,
  };
}

function buildReportedOperatorSurfaceContext(params: {
  activeShellView: ShellView;
  agentView: AgentView;
  spaceDisplayView: SpaceDisplayView;
}): ReportedOperatorSurfaceContext | null {
  const surfaces: OperatorSurfacePayload[] = [];

  if (params.activeShellView === "space") {
    if (params.spaceDisplayView.type === "internal") {
      const surface = buildReportedSurfaceFromInternalView({
        owner: "user",
        active: true,
        view: params.spaceDisplayView,
      });
      if (surface) {
        surfaces.push(surface);
      }
    } else if (params.spaceDisplayView.type === "app") {
      surfaces.push(
        buildReportedSurfaceFromAppView({
          owner: "user",
          active: true,
          view: params.spaceDisplayView,
        }),
      );
    }

    if (params.agentView.type === "internal") {
      const surface = buildReportedSurfaceFromInternalView({
        owner: "agent",
        active: surfaces.length === 0,
        view: params.agentView,
      });
      if (surface) {
        surfaces.push(surface);
      }
    } else if (params.agentView.type === "app") {
      surfaces.push(
        buildReportedSurfaceFromAppView({
          owner: "agent",
          active: surfaces.length === 0,
          view: params.agentView,
        }),
      );
    }
  }

  if (surfaces.length === 0) {
    return null;
  }

  const activeSurface =
    surfaces.find((surface) => surface.active) ?? surfaces[0];
  return {
    active_surface_id: activeSurface?.surface_id ?? null,
    surfaces,
  };
}

function utilityPaneMinWidth(paneId: UtilityPaneId): number {
  return paneId === "files" ? MIN_FILES_PANE_WIDTH : MIN_BROWSER_PANE_WIDTH;
}

function isDevNotificationToastPreviewId(notificationId: string): boolean {
  return notificationId.startsWith(DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX);
}

function isTaskProposalToastId(notificationId: string): boolean {
  return notificationId.startsWith(TASK_PROPOSAL_TOAST_ID_PREFIX);
}

function buildDevNotificationToastPreviewNotifications(
  workspaceId: string | null,
): RuntimeNotificationRecordPayload[] {
  const normalizedWorkspaceId = workspaceId?.trim() || "dev-preview-workspace";
  const now = Date.now();
  return [
    {
      id: `${DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX}1`,
      workspace_id: normalizedWorkspaceId,
      cronjob_id: null,
      source_type: "dev_preview",
      source_label: "Preview",
      title: "Task proposal ready",
      message:
        "This is a collapsed preview stack. Hover it to fan the toasts out.",
      level: "info",
      priority: "normal",
      state: "unread",
      metadata: {},
      read_at: null,
      dismissed_at: null,
      created_at: new Date(now - 45_000).toISOString(),
      updated_at: new Date(now - 45_000).toISOString(),
    },
    {
      id: `${DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX}2`,
      workspace_id: normalizedWorkspaceId,
      cronjob_id: null,
      source_type: "dev_preview",
      source_label: "Preview",
      title: "Build completed",
      message:
        "A success toast helps show the stacked depth and color treatment.",
      level: "success",
      priority: "low",
      state: "unread",
      metadata: {},
      read_at: null,
      dismissed_at: null,
      created_at: new Date(now - 90_000).toISOString(),
      updated_at: new Date(now - 90_000).toISOString(),
    },
    {
      id: `${DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX}3`,
      workspace_id: normalizedWorkspaceId,
      cronjob_id: null,
      source_type: "dev_preview",
      source_label: "Preview",
      title: "Workflow waiting on input",
      message:
        "Use this preview hook whenever you want to inspect the stacked toast layout.",
      level: "warning",
      priority: "high",
      state: "unread",
      metadata: {},
      read_at: null,
      dismissed_at: null,
      created_at: new Date(now - 135_000).toISOString(),
      updated_at: new Date(now - 135_000).toISOString(),
    },
    {
      id: `${DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX}4`,
      workspace_id: normalizedWorkspaceId,
      cronjob_id: null,
      source_type: "dev_preview",
      source_label: "Preview",
      title: "Run failed",
      message:
        "The fourth toast makes the overlap obvious without needing real notification traffic.",
      level: "error",
      priority: "critical",
      state: "unread",
      metadata: {},
      read_at: null,
      dismissed_at: null,
      created_at: new Date(now - 180_000).toISOString(),
      updated_at: new Date(now - 180_000).toISOString(),
    },
  ];
}

function appUpdateChangelogUrl(status: AppUpdateStatusPayload): string | null {
  const version = status.latestVersion?.trim();
  if (!version) {
    return null;
  }
  return `${APP_UPDATE_CHANGELOG_BASE_URL}/holaOS-${version}`;
}

function buildTaskProposalToastNotification(params: {
  workspaceId: string;
  workspaceName?: string | null;
  proposals: TaskProposalRecordPayload[];
}): RuntimeNotificationRecordPayload {
  const now = new Date().toISOString();
  const proposalCount = params.proposals.length;
  const firstProposalName =
    params.proposals[0]?.task_name?.trim() || "Untitled task";
  const workspaceName = params.workspaceName?.trim() || "";
  const workspaceQualifier = workspaceName ? ` in ${workspaceName}` : "";

  return {
    id: `${TASK_PROPOSAL_TOAST_ID_PREFIX}${crypto.randomUUID()}`,
    workspace_id: params.workspaceId,
    cronjob_id: null,
    source_type: "task_proposal",
    source_label: "Task proposals",
    title: proposalCount === 1 ? "Task proposal ready" : "Task proposals ready",
    message:
      proposalCount === 1
        ? `"${firstProposalName}" is ready to review in the inbox${workspaceQualifier}.`
        : `${proposalCount} task proposals are ready to review in the inbox${workspaceQualifier}.`,
    level: "info",
    priority: "high",
    state: "unread",
    metadata: {
      proposal_ids: params.proposals.map((proposal) => proposal.proposal_id),
    },
    read_at: null,
    dismissed_at: null,
    created_at: now,
    updated_at: now,
  };
}

function notificationMetadataString(
  notification: RuntimeNotificationRecordPayload,
  key: string,
): string | null {
  const raw = notification.metadata[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function notificationActionUrl(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "action_url");
}

function notificationTargetSessionId(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "session_id");
}

function notificationDeliveryChannel(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  const delivery = notification.metadata.delivery;
  if (
    delivery &&
    typeof delivery === "object" &&
    !Array.isArray(delivery) &&
    typeof (delivery as { channel?: unknown }).channel === "string"
  ) {
    const channel = (delivery as { channel: string }).channel.trim();
    return channel || null;
  }
  return null;
}

function isSystemCronjobNotification(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type === "cronjob" &&
    notificationDeliveryChannel(notification) === "system_notification"
  );
}

function shouldIncludeRuntimeNotificationInShell(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type !== "cronjob" ||
    isSystemCronjobNotification(notification)
  );
}

function notificationBelongsToSelectedWorkspace(
  notification: RuntimeNotificationRecordPayload,
  selectedWorkspaceId: string | null,
): boolean {
  const notificationWorkspaceId = notification.workspace_id.trim();
  const normalizedSelectedWorkspaceId = selectedWorkspaceId?.trim() || "";
  return Boolean(
    notificationWorkspaceId &&
      normalizedSelectedWorkspaceId &&
      notificationWorkspaceId === normalizedSelectedWorkspaceId,
  );
}

function shouldShowNativeRuntimeNotification(
  notification: RuntimeNotificationRecordPayload,
  isWindowAway: boolean,
): boolean {
  if (isSystemCronjobNotification(notification)) {
    return true;
  }
  if (!isWindowAway) {
    return false;
  }
  return notification.source_type === "main_session";
}

function shouldDismissVisibleRuntimeNotification(
  notification: RuntimeNotificationRecordPayload,
  selectedWorkspaceId: string | null,
): boolean {
  if (
    notification.source_type !== "main_session" &&
    !isSystemCronjobNotification(notification)
  ) {
    return false;
  }
  return notificationBelongsToSelectedWorkspace(
    notification,
    selectedWorkspaceId,
  );
}

function shouldToastVisibleRuntimeNotification(
  notification: RuntimeNotificationRecordPayload,
  context: {
    selectedWorkspaceId: string | null;
    /** Session the user is currently viewing in the chat pane (null
     *  when they're elsewhere). If this matches the notification's
     *  target session, the user is already looking at the event —
     *  suppress the toast regardless of source type. */
    viewingChatSessionId: string | null;
  },
): boolean {
  const notifSessionId = notificationTargetSessionId(notification);
  if (
    context.viewingChatSessionId &&
    notifSessionId &&
    notifSessionId === context.viewingChatSessionId
  ) {
    return false;
  }
  if (
    notification.source_type === "main_session" ||
    isSystemCronjobNotification(notification)
  ) {
    return !notificationBelongsToSelectedWorkspace(
      notification,
      context.selectedWorkspaceId,
    );
  }
  return true;
}

function notificationActivationState(
  notification: RuntimeNotificationRecordPayload,
): RuntimeNotificationState {
  const activationState = notificationMetadataString(
    notification,
    "activation_state",
  )?.toLowerCase();
  if (activationState === "dismissed") {
    return "dismissed";
  }
  if (activationState === "read") {
    return "read";
  }
  return "read";
}

function loadSpaceVisibility(): SpaceVisibilityState {
  try {
    const raw = localStorage.getItem(SPACE_VISIBILITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<
        Record<SpaceComponentId, unknown>
      >;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          agent: true,
          files: true,
          browser: true,
        };
      }
    }
  } catch {
    // ignore invalid persisted layout state
  }
  return DEFAULT_SPACE_VISIBILITY;
}

function loadBrowserPaneWidth(): number {
  try {
    const raw = localStorage.getItem(BROWSER_PANE_WIDTH_STORAGE_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(
        MIN_BROWSER_PANE_WIDTH,
        Math.min(parsed, MAX_UTILITY_PANE_WIDTH),
      );
    }
  } catch {
    // ignore
  }

  return DEFAULT_BROWSER_PANE_WIDTH;
}

function loadSpaceWorkspacePanelCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(
      SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY,
    );
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // ignore invalid persisted layout state
  }

  return true;
}

function loadControlCenterCardsPerRow(): ControlCenterCardsPerRow {
  try {
    const raw = localStorage.getItem(CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY);
    const parsed = Number(raw);
    if (isControlCenterCardsPerRow(parsed)) {
      return parsed;
    }
  } catch {
    // ignore invalid persisted control center layout state
  }

  return 3;
}

/**
 * Restore the user's last "landing view" — either control center or
 * a specific workspace ("space"). The workspace itself is already
 * persisted by useWorkspaceSelection, so we only need to remember
 * which surface they were last in. New users (no saved value) get
 * "space" so onboarding lands directly in their first workspace.
 */
function loadLastShellView(): ShellView {
  try {
    const raw = localStorage.getItem(LAST_SHELL_VIEW_STORAGE_KEY);
    if (raw === "control_center" || raw === "space") {
      return raw;
    }
  } catch {
    // ignore invalid persisted shell-view state
  }
  return "space";
}

function loadControlCenterWorkspaceCardOrder(): string[] {
  try {
    const raw = localStorage.getItem(
      CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY,
    );
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadOperationsDrawerOpen(): boolean {
  try {
    const raw = localStorage.getItem(OPERATIONS_DRAWER_OPEN_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // ignore
  }

  return false;
}

function loadOperationsDrawerTab(): OperationsDrawerTab {
  try {
    const raw = localStorage.getItem(OPERATIONS_DRAWER_TAB_STORAGE_KEY);
    if (raw === "inbox" || raw === "running") {
      return raw;
    }
  } catch {
    // ignore
  }

  return "inbox";
}

function loadSeenTaskProposalIdsByWorkspace(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TASK_PROPOSAL_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, string[]> = {};
    for (const [workspaceId, proposalIds] of Object.entries(parsed)) {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId || !Array.isArray(proposalIds)) {
        continue;
      }
      const cleaned = Array.from(
        new Set(
          proposalIds
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ).slice(-MAX_SEEN_TASK_PROPOSAL_IDS_PER_WORKSPACE);
      if (cleaned.length > 0) {
        next[normalizedWorkspaceId] = cleaned;
      }
    }
    return next;
  } catch {
    // ignore invalid persisted proposal state
  }

  return {};
}

function splitAppTheme(
  value: string,
): { variant: ThemeVariant; scheme: "light" | "dark" } | null {
  if (!isAppTheme(value)) {
    return null;
  }
  if (value.endsWith("-dark")) {
    const variant = value.slice(0, -"-dark".length);
    if (isThemeVariant(variant)) {
      return { variant, scheme: "dark" };
    }
  }
  if (value.endsWith("-light")) {
    const variant = value.slice(0, -"-light".length);
    if (isThemeVariant(variant)) {
      return { variant, scheme: "light" };
    }
  }
  return null;
}

function loadColorScheme(): ColorScheme {
  try {
    const stored = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (stored && isColorScheme(stored)) {
      return stored;
    }
    // Migrate from legacy single-string key — if the old theme name encoded
    // an explicit light/dark, preserve the user's explicit choice; otherwise
    // fall through to "system" below.
    const legacy = localStorage.getItem(THEME_STORAGE_KEY);
    if (legacy) {
      const split = splitAppTheme(legacy);
      if (split) {
        return split.scheme;
      }
    }
  } catch {
    // ignore
  }
  return "system";
}

function loadThemeVariant(): ThemeVariant {
  try {
    const stored = localStorage.getItem(THEME_VARIANT_STORAGE_KEY);
    if (stored && isThemeVariant(stored)) {
      return stored;
    }
    const legacy = localStorage.getItem(THEME_STORAGE_KEY);
    if (legacy) {
      const split = splitAppTheme(legacy);
      if (split) {
        return split.variant;
      }
    }
  } catch {
    // ignore
  }
  return "holaos";
}

function normalizeDevAppUpdatePreviewMode(
  value: string | null | undefined,
): DevAppUpdatePreviewMode {
  if (value === "downloading" || value === "ready") {
    return value;
  }
  return "off";
}

function loadDevAppUpdatePreviewMode(): DevAppUpdatePreviewMode {
  if (!import.meta.env.DEV) {
    return "off";
  }

  try {
    return normalizeDevAppUpdatePreviewMode(
      localStorage.getItem(DEV_APP_UPDATE_PREVIEW_STORAGE_KEY),
    );
  } catch {
    return "off";
  }
}

function buildDevAppUpdatePreviewStatus(
  mode: DevAppUpdatePreviewMode,
  currentVersion: string,
): AppUpdateStatusPayload | null {
  if (mode === "off") {
    return null;
  }

  const now = new Date().toISOString();
  const latestVersion = "2026.4.99";

  return {
    supported: true,
    checking: false,
    available: mode === "downloading",
    downloaded: mode === "ready",
    downloadProgressPercent: mode === "downloading" ? 64 : 100,
    currentVersion: currentVersion.trim() || "0.1.0",
    latestVersion,
    releaseName: `holaOS ${latestVersion}`,
    publishedAt: now,
    dismissedVersion: null,
    lastCheckedAt: now,
    error: "",
    channel: "latest",
    preferredChannel: null,
  };
}

function spaceComponentLabel(componentId: SpaceComponentId) {
  if (componentId === "agent") {
    return "Agent";
  }
  if (componentId === "files") {
    return "Files";
  }
  return "Browser";
}

function spaceResizeHandleSpec(
  leftPaneId: SpaceComponentId,
  rightPaneId: SpaceComponentId,
): {
  leftPaneId: SpaceComponentId;
  rightPaneId: SpaceComponentId;
  label: string;
} {
  if (leftPaneId === "agent") {
    return {
      leftPaneId,
      rightPaneId,
      label: `Resize ${spaceComponentLabel(rightPaneId).toLowerCase()} pane`,
    };
  }
  if (rightPaneId === "agent") {
    return {
      leftPaneId,
      rightPaneId,
      label: `Resize ${spaceComponentLabel(leftPaneId).toLowerCase()} pane`,
    };
  }
  return {
    leftPaneId,
    rightPaneId,
    label: `Resize ${spaceComponentLabel(leftPaneId).toLowerCase()} and ${spaceComponentLabel(rightPaneId).toLowerCase()} panes`,
  };
}

function normalizeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return "Request failed.";
  }
  // Strip Electron IPC wrapper: "Error invoking remote method '...': Error: <actual>"
  const ipcMatch = error.message.match(
    /^Error invoking remote method '[^']+': Error: (.+)$/s,
  );
  return ipcMatch ? ipcMatch[1] : error.message;
}

function inferInternalSurfaceFromOutputType(
  outputType: string,
): "document" | "preview" | "file" | "event" {
  const normalized = outputType.trim().toLowerCase();
  if (normalized === "document") {
    return "document";
  }
  if (normalized === "preview") {
    return "preview";
  }
  if (normalized === "file") {
    return "file";
  }
  return "event";
}

function workspaceOutputNavigationTarget(
  output: WorkspaceOutputRecordPayload,
  installedAppIds: Set<string>,
): WorkspaceOutputNavigationTarget {
  const moduleId = (output.module_id || "").trim().toLowerCase();
  const platformId = (output.platform || "").trim().toLowerCase();
  const metadata = (output.metadata ?? {}) as Record<string, unknown>;
  const presentation = metadata.presentation as
    | { kind?: string; view?: string; path?: string }
    | undefined;
  const resource = metadata.resource as
    | { entity_id?: string; entity_type?: string; label?: string }
    | undefined;
  const hasAppPresentation =
    presentation?.kind === "app_resource" && presentation.view;
  const looksLikeAppBackedDraft =
    output.output_type === "post" ||
    ((metadata.artifact_type as string | undefined)?.trim()?.toLowerCase() ??
      "") === "draft";
  const appId =
    moduleId && installedAppIds.has(moduleId)
      ? moduleId
      : (hasAppPresentation || looksLikeAppBackedDraft) &&
          platformId &&
          installedAppIds.has(platformId)
        ? platformId
        : "";

  if (appId) {
    return {
      type: "app",
      appId,
      path: hasAppPresentation ? presentation?.path || null : null,
      resourceId:
        output.module_resource_id ||
        (typeof resource?.entity_id === "string" ? resource.entity_id : null),
      view: hasAppPresentation
        ? presentation.view
        : output.output_type === "post"
          ? "posts"
          : output.output_type || "home",
    };
  }

  return {
    type: "internal",
    surface: inferInternalSurfaceFromOutputType(output.output_type),
    resourceId: output.file_path || output.artifact_id || output.id,
    htmlContent: output.html_content,
  };
}

function EmptyWorkspacePane() {
  return (
    <FocusPlaceholder
      eyebrow="Workspace"
      title="Select a workspace to continue"
      description="Your desktop layout is ready, but no active workspace is selected yet. Choose one from the switcher in the top bar."
    />
  );
}

function runtimeStartupBlockedMessage(
  runtimeStatus: RuntimeStatusPayload | null,
  fallbackMessage = "",
) {
  const normalizedFallback = fallbackMessage.trim();
  if (!runtimeStatus) {
    return normalizedFallback;
  }

  const runtimeError = runtimeStatus.lastError.trim();
  if (runtimeStatus.status === "error") {
    return (
      runtimeError || normalizedFallback || "Embedded runtime failed to start."
    );
  }
  if (runtimeStatus.status === "missing") {
    return (
      runtimeError ||
      normalizedFallback ||
      "Embedded runtime bundle is missing from this desktop install."
    );
  }
  if (runtimeStatus.status === "stopped") {
    return (
      runtimeError ||
      normalizedFallback ||
      "Embedded runtime is not running. Restart the app to try again."
    );
  }
  return "";
}

function FocusPlaceholder({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="relative flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-card">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(87,255,173,0.08),transparent_45%)]" />
      <div className="relative max-w-[520px] px-8 text-center">
        <div className="text-[10px] uppercase text-primary">{eyebrow}</div>
        <div className="mt-3 text-[28px] font-semibold text-foreground">
          {title}
        </div>
        <div className="mt-3 text-[13px] text-muted-foreground">
          {description}
        </div>
      </div>
    </section>
  );
}

function WorkspaceStartupErrorPane({ message }: { message: string }) {
  const [isRelaunching, setIsRelaunching] = useState(false);

  async function handleRelaunch() {
    if (isRelaunching) {
      return;
    }
    setIsRelaunching(true);
    // Fire-and-forget: the IPC triggers app.quit() in main, so this promise
    // never resolves in practice. The spinner exists for the brief window
    // before the renderer is torn down.
    try {
      await window.electronAPI.app.relaunch();
    } catch {
      setIsRelaunching(false);
    }
  }

  return (
    <BlockingErrorScreen
      actions={
        <Button
          className="w-full"
          disabled={isRelaunching}
          onClick={() => void handleRelaunch()}
          size="lg"
          type="button"
        >
          {isRelaunching ? <Loader2 className="animate-spin" /> : null}
          Restart Holaboss
        </Button>
      }
      description="Something is keeping Holaboss from starting. Restarting the app usually clears it — if it doesn't, reinstalling will."
      technicalDetail={`${message}\n\nFor diagnostics, check runtime.log in the Electron userData directory.`}
      title="Holaboss couldn't start"
    />
  );
}

function WorkspaceOnboardingTakeover({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  focusRequestKey,
}: {
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onSyncFileDisplayFromAgentOperation?: (path: string) => void;
  onImageAttachmentPreviewOpenChange?: (open: boolean) => void;
  focusRequestKey: number;
}) {
  return (
    <section className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <WorkspaceOnboardingSurface
          onOpenOutput={onOpenOutput}
          onSyncFileDisplayFromAgentOperation={
            onSyncFileDisplayFromAgentOperation
          }
          onImageAttachmentPreviewOpenChange={
            onImageAttachmentPreviewOpenChange
          }
          focusRequestKey={focusRequestKey}
        />
      </div>
    </section>
  );
}

function AppShellContent() {
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const {
    runtimeConfig,
    workspaces,
    hasHydratedWorkspaceList,
    selectedWorkspace,
    installedApps,
    workspaceAppsReady,
    workspaceBlockingReason,
    workspaceErrorMessage,
    onboardingModeActive,
    chooseWorkspaceRelocationFolder,
    deleteWorkspace,
  } = useWorkspaceDesktop();
  const [colorScheme, setColorScheme] = useState<ColorScheme>(loadColorScheme);
  const [themeVariant, setThemeVariant] =
    useState<ThemeVariant>(loadThemeVariant);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const effectiveScheme: "light" | "dark" =
    colorScheme === "system"
      ? systemPrefersDark
        ? "dark"
        : "light"
      : colorScheme;
  const theme = `${themeVariant}-${effectiveScheme}` as AppTheme;
  const [runtimeStatus, setRuntimeStatus] =
    useState<RuntimeStatusPayload | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] =
    useState<AppUpdateStatusPayload | null>(null);
  const [devAppUpdatePreviewMode, setDevAppUpdatePreviewMode] =
    useState<DevAppUpdatePreviewMode>(loadDevAppUpdatePreviewMode);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  // Decoupled from `settingsDialogOpen` so the panel stays mounted long
  // enough for the exit animation to finish before unmount.
  const [settingsDialogRendered, setSettingsDialogRendered] = useState(false);
  useEffect(() => {
    if (settingsDialogOpen) {
      setSettingsDialogRendered(true);
    }
  }, [settingsDialogOpen]);
  const [settingsDialogSection, setSettingsDialogSection] =
    useState<UiSettingsPaneSection>("settings");
  const [publishOpen, setPublishOpen] = useState(false);
  const [submissionsFocusId, setSubmissionsFocusId] = useState<string | null>(null);
  const [createWorkspacePanelOpen, setCreateWorkspacePanelOpen] =
    useState(false);
  const [workspaceAppsDialogOpen, setWorkspaceAppsDialogOpen] = useState(false);
  const [
    createWorkspacePanelAnchorWorkspaceId,
    setCreateWorkspacePanelAnchorWorkspaceId,
  ] = useState("");
  const [activeShellView, setActiveShellView] =
    useState<ShellView>(() => loadLastShellView());
  // Persist the landing view so the next launch restores wherever the
  // user last was — control center if they were surveying the fleet,
  // or "space" (in-workspace) which combines with useWorkspaceSelection's
  // own persistence to drop them back into the exact workspace they
  // were using.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_SHELL_VIEW_STORAGE_KEY, activeShellView);
    } catch {
      // ignore quota / private-mode failures
    }
  }, [activeShellView]);
  const [agentView, setAgentView] = useState<AgentView>({ type: "chat" });
  const [chatFocusRequestKey, setChatFocusRequestKey] = useState(1);
  const [chatSessionJumpRequest, setChatSessionJumpRequest] = useState<{
    sessionId: string;
    requestKey: number;
  } | null>(null);
  const [chatSessionOpenRequest, setChatSessionOpenRequest] =
    useState<ChatSessionOpenRequest | null>(null);
  const [isStartingMeetingMode, setIsStartingMeetingMode] = useState(false);
  const [meetingModeError, setMeetingModeError] = useState("");
  const [chatImagePreviewOpen, setChatImagePreviewOpen] = useState(false);
  const [
    chatBrowserJumpRequestKeysBySessionId,
    setChatBrowserJumpRequestKeysBySessionId,
  ] = useState<Record<string, number>>({});
  const [
    chatComposerDraftTextByWorkspace,
    setChatComposerDraftTextByWorkspace,
  ] = useState<Record<string, string>>({});
  const [chatComposerPrefillRequest, setChatComposerPrefillRequest] =
    useState<ChatComposerPrefillRequest | null>(null);
  const [chatScheduleEditContext, setChatScheduleEditContext] =
    useState<CronjobRecordPayload | null>(null);
  const [chatExplorerAttachmentRequest, setChatExplorerAttachmentRequest] =
    useState<ChatExplorerAttachmentRequest | null>(null);
  const [fileExplorerFocusRequest, setFileExplorerFocusRequest] =
    useState<FileExplorerFocusRequest | null>(null);
  const [spaceExplorerMode, setSpaceExplorerMode] =
    useState<SpaceExplorerMode>("files");
  // Animate the content swap when the Space explorer mode changes. Every mode
  // enters from the right so all three tabs share one consistent idiom.
  const spaceExplorerSlideInClass = "slide-in-from-right-3";
  const [spaceWorkspacePanelCollapsed, setSpaceWorkspacePanelCollapsed] =
    useState(loadSpaceWorkspacePanelCollapsed);
  const [spaceBrowserFullscreen, setSpaceBrowserFullscreen] = useState(false);
  const [windowFocused, setWindowFocused] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
  const [spaceBrowserSpace, setSpaceBrowserSpace] =
    useState<BrowserSpaceId>("user");
  const [spaceDisplayView, setSpaceDisplayView] = useState<SpaceDisplayView>({
    type: "browser",
  });
  const [spaceAgentPaneWidth, setSpaceAgentPaneWidth] = useState(
    SPACE_AGENT_PANE_WIDTH,
  );
  // Live width of the space layout row, fed by the ResizeObserver below.
  // Used to derive explicit pixel widths for the display / agent panes
  // (instead of toggling flex-1 ↔ width:Xpx, which the browser can't
  // smoothly interpolate — see Tier 2 design notes).
  const [spaceLayoutHostWidth, setSpaceLayoutHostWidth] = useState(0);
  // True while the space-pane width transition is mid-flight. Flips
  // true on collapse/fullscreen toggle, back to false ~230ms later.
  // ChatPane reads this to pin its inner column width — preventing
  // text re-wrap during the outer animation.
  const [isSpacePaneAnimating, setIsSpacePaneAnimating] = useState(false);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null,
  );
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [topBarPopoverOpen, setTopBarPopoverOpen] = useState(false);
  const [spaceVisibility, setSpaceVisibility] =
    useState<SpaceVisibilityState>(loadSpaceVisibility);
  const [filesPaneWidth, setFilesPaneWidth] = useState(
    DEFAULT_FILES_PANE_WIDTH,
  );
  const [browserPaneWidth, setBrowserPaneWidth] =
    useState(loadBrowserPaneWidth);
  const [controlCenterCardsPerRow, setControlCenterCardsPerRow] =
    useState<ControlCenterCardsPerRow>(loadControlCenterCardsPerRow);
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] =
    useState(true);
  const [isUtilityPaneResizing, setIsUtilityPaneResizing] = useState(false);
  const [operationsDrawerOpen, setOperationsDrawerOpen] = useState(
    loadOperationsDrawerOpen,
  );
  const [activeOperationsTab, setActiveOperationsTab] =
    useState<OperationsDrawerTab>(loadOperationsDrawerTab);
  const [taskProposals, setTaskProposals] = useState<
    TaskProposalRecordPayload[]
  >([]);
  const [seenTaskProposalIdsByWorkspace, setSeenTaskProposalIdsByWorkspace] =
    useState<Record<string, string[]>>(loadSeenTaskProposalIdsByWorkspace);
  const [isLoadingTaskProposals, setIsLoadingTaskProposals] = useState(false);
  const [taskProposalStatusMessage, setTaskProposalStatusMessage] =
    useState("");
  const [taskProposalDetailsDialogOpen, setTaskProposalDetailsDialogOpen] =
    useState(false);
  // Keep request keys monotonic even after the request object is consumed.
  const chatSessionOpenRequestKeyRef = useRef(0);
  const chatComposerPrefillRequestKeyRef = useRef(0);
  const chatExplorerAttachmentRequestKeyRef = useRef(0);
  const [proposalAction, setProposalAction] = useState<{
    proposalId: string;
    action: "accept" | "dismiss";
  } | null>(null);
  const [notifications, setNotifications] = useState<
    RuntimeNotificationRecordPayload[]
  >([]);
  const [toastNotifications, setToastNotifications] = useState<
    RuntimeNotificationRecordPayload[]
  >([]);
  const [controlCenterVisibleWorkspaceIds, setControlCenterVisibleWorkspaceIds] =
    useState<string[]>([]);
  const [
    controlCenterHighlightedWorkspaceIds,
    setControlCenterHighlightedWorkspaceIds,
  ] = useState<string[]>([]);
  const [taskProposalToastNotifications, setTaskProposalToastNotifications] =
    useState<RuntimeNotificationRecordPayload[]>([]);
  const [devNotificationToastPreview, setDevNotificationToastPreview] =
    useState<RuntimeNotificationRecordPayload[]>([]);
  const [
    controlCenterWorkspaceCardOrder,
    setControlCenterWorkspaceCardOrder,
  ] = useState<string[]>(() => loadControlCenterWorkspaceCardOrder());
  const utilityPaneHostRef = useRef<HTMLDivElement | null>(null);
  const utilityPaneResizeStateRef = useRef<UtilityPaneResizeState | null>(null);
  const reportedOperatorSurfaceWorkspaceIdRef = useRef<string | null>(null);
  const filesPaneWidthRef = useRef(filesPaneWidth);
  const browserPaneWidthRef = useRef(browserPaneWidth);
  const spaceVisibilityRef = useRef(spaceVisibility);
  const notificationsHydratedRef = useRef(false);
  const seenNotificationIdsRef = useRef(new Set<string>());
  const controlCenterCardComposerSubmissionWorkspaceIdsRef = useRef(
    new Set<string>(),
  );
  const nativeRuntimeNotificationAttemptedAtRef = useRef(
    new Map<string, number>(),
  );
  const knownTaskProposalIdsByWorkspaceRef = useRef<Record<string, string[]>>(
    {},
  );
  const startupWorkspaceSelectionHandledRef = useRef(false);
  const seenWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const newlyCreatedWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const workspaceListInitializedRef = useRef(false);
  const lastRestorableSpaceFileDisplayViewByWorkspaceRef = useRef<
    Record<string, RestorableSpaceFileDisplayView>
  >({});
  const lastRestorableSpaceAppDisplayViewByWorkspaceRef = useRef<
    Record<string, RestorableSpaceAppDisplayView>
  >({});
  // Marks the workspace id for which the next workspace-change cycle should
  // *not* reset spaceDisplayView — the caller is about to (or just did) set
  // displayView explicitly, so the workspace-change effect at #space-display-
  // view-restore must defer to that intent. Cleared after the effect honors
  // it. See handleOpenControlCenterWorkspaceOutput for the canonical caller.
  const explicitSpaceDisplayViewRequestedForWorkspaceRef = useRef<string | null>(
    null,
  );
  const spaceDisplayResizeStateRef = useRef<{
    startWidth: number;
    startX: number;
  } | null>(null);
  const explorerRevealDragStateRef = useRef<{
    startX: number;
    startWidth: number;
    activated: boolean;
  } | null>(null);
  const [explorerRevealDragWidth, setExplorerRevealDragWidth] = useState<
    number | null
  >(null);

  filesPaneWidthRef.current = filesPaneWidth;
  browserPaneWidthRef.current = browserPaneWidth;
  spaceVisibilityRef.current = spaceVisibility;
  const effectiveSpaceWorkspacePanelCollapsed = spaceWorkspacePanelCollapsed;

  const effectiveAppUpdateStatus = useMemo(
    () =>
      buildDevAppUpdatePreviewStatus(
        devAppUpdatePreviewMode,
        appUpdateStatus?.currentVersion || "",
      ) ?? appUpdateStatus,
    [appUpdateStatus, devAppUpdatePreviewMode],
  );
  const effectiveToastNotifications = useMemo(
    () =>
      devNotificationToastPreview.length > 0
        ? devNotificationToastPreview
        : [...taskProposalToastNotifications, ...toastNotifications]
            .sort(
              (left, right) =>
                Date.parse(right.created_at) - Date.parse(left.created_at),
            )
            .slice(0, 4),
    [
      devNotificationToastPreview,
      taskProposalToastNotifications,
      toastNotifications,
    ],
  );
  const controlCenterVisibleWorkspaceIdSet = useMemo(
    () =>
      new Set(
        controlCenterVisibleWorkspaceIds
          .map((workspaceId) => workspaceId.trim())
          .filter(Boolean),
      ),
    [controlCenterVisibleWorkspaceIds],
  );

  useEffect(() => {
    const activeWorkspaceIds = new Set(
      workspaces
        .map((workspace) => workspace.id.trim())
        .filter(Boolean),
    );
    setControlCenterHighlightedWorkspaceIds((current) => {
      const next = current.filter((workspaceId) =>
        activeWorkspaceIds.has(workspaceId),
      );
      return next.length === current.length ? current : next;
    });
    setControlCenterVisibleWorkspaceIds((current) => {
      const next = current.filter((workspaceId) =>
        activeWorkspaceIds.has(workspaceId),
      );
      return next.length === current.length ? current : next;
    });
    setControlCenterWorkspaceCardOrder((current) => {
      const next = current.filter((workspaceId, index) => {
        if (!activeWorkspaceIds.has(workspaceId)) {
          return false;
        }
        return current.indexOf(workspaceId) === index;
      });
      return next.length === current.length ? current : next;
    });
    for (const workspaceId of [
      ...controlCenterCardComposerSubmissionWorkspaceIdsRef.current,
    ]) {
      if (!activeWorkspaceIds.has(workspaceId)) {
        controlCenterCardComposerSubmissionWorkspaceIdsRef.current.delete(
          workspaceId,
        );
      }
    }
  }, [workspaces]);
  const runtimeNotificationById = useMemo(
    () =>
      new Map(
        notifications.map((notification) => [notification.id, notification]),
      ),
    [notifications],
  );
  const taskProposalToastById = useMemo(
    () =>
      new Map(
        taskProposalToastNotifications.map((notification) => [
          notification.id,
          notification,
        ]),
      ),
    [taskProposalToastNotifications],
  );
  const unreadTaskProposalCount = useMemo(() => {
    if (!selectedWorkspaceId || taskProposals.length === 0) {
      return 0;
    }
    const seenProposalIds = new Set(
      seenTaskProposalIdsByWorkspace[selectedWorkspaceId] ?? [],
    );
    return taskProposals.reduce((count, proposal) => {
      const proposalId = proposal.proposal_id.trim();
      if (!proposalId || seenProposalIds.has(proposalId)) {
        return count;
      }
      return count + 1;
    }, 0);
  }, [seenTaskProposalIdsByWorkspace, selectedWorkspaceId, taskProposals]);

  const markTaskProposalsSeen = useCallback(
    (
      workspaceId: string | null | undefined,
      proposals: TaskProposalRecordPayload[],
    ) => {
      const normalizedWorkspaceId = workspaceId?.trim() || "";
      if (!normalizedWorkspaceId || proposals.length === 0) {
        return;
      }

      const proposalIds = Array.from(
        new Set(
          proposals
            .map((proposal) => proposal.proposal_id.trim())
            .filter(Boolean),
        ),
      );
      if (proposalIds.length === 0) {
        return;
      }

      setSeenTaskProposalIdsByWorkspace((current) => {
        const existing = current[normalizedWorkspaceId] ?? [];
        const nextIds = [...existing];
        let changed = false;
        for (const proposalId of proposalIds) {
          if (nextIds.includes(proposalId)) {
            continue;
          }
          nextIds.push(proposalId);
          changed = true;
        }
        if (!changed) {
          return current;
        }
        return {
          ...current,
          [normalizedWorkspaceId]: nextIds.slice(
            -MAX_SEEN_TASK_PROPOSAL_IDS_PER_WORKSPACE,
          ),
        };
      });
    },
    [],
  );

  const dismissTaskProposalToast = useCallback((notificationId: string) => {
    setTaskProposalToastNotifications((current) =>
      current.filter((item) => item.id !== notificationId),
    );
  }, []);

  const openTaskProposalInbox = useCallback(
    (workspaceId?: string | null) => {
      const normalizedWorkspaceId =
        workspaceId?.trim() || selectedWorkspaceId || "";
      if (normalizedWorkspaceId) {
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }
      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "inbox" });
      if (
        normalizedWorkspaceId &&
        normalizedWorkspaceId === selectedWorkspaceId &&
        taskProposals.length > 0
      ) {
        markTaskProposalsSeen(normalizedWorkspaceId, taskProposals);
      }
    },
    [
      markTaskProposalsSeen,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      taskProposals,
    ],
  );

  const applyTaskProposals = useCallback(
    (
      workspaceId: string | null | undefined,
      workspaceName: string | null | undefined,
      proposals: TaskProposalRecordPayload[],
      options?: { notify?: boolean },
    ) => {
      setTaskProposals(proposals);

      const normalizedWorkspaceId = workspaceId?.trim() || "";
      if (!normalizedWorkspaceId) {
        return;
      }

      const knownProposalIds = new Set(
        knownTaskProposalIdsByWorkspaceRef.current[normalizedWorkspaceId] ?? [],
      );
      const pendingNewProposals = proposals.filter((proposal) => {
        const proposalId = proposal.proposal_id.trim();
        if (!proposalId) {
          return false;
        }
        const isNew = !knownProposalIds.has(proposalId);
        knownProposalIds.add(proposalId);
        return isNew && proposal.state.trim().toLowerCase() === "pending";
      });
      knownTaskProposalIdsByWorkspaceRef.current[normalizedWorkspaceId] =
        Array.from(knownProposalIds).slice(
          -MAX_SEEN_TASK_PROPOSAL_IDS_PER_WORKSPACE,
        );

      if (options?.notify === false || pendingNewProposals.length === 0) {
        return;
      }

      const inboxVisible =
        agentView.type === "inbox" ||
        (operationsDrawerOpen && activeOperationsTab === "inbox");
      if (inboxVisible && normalizedWorkspaceId === selectedWorkspaceId) {
        return;
      }

      const toast = buildTaskProposalToastNotification({
        workspaceId: normalizedWorkspaceId,
        workspaceName,
        proposals: pendingNewProposals,
      });
      setTaskProposalToastNotifications((current) =>
        [toast, ...current].slice(0, 4),
      );
    },
    [
      activeOperationsTab,
      agentView.type,
      operationsDrawerOpen,
      selectedWorkspaceId,
    ],
  );

  const clampUtilityPaneWidth = useCallback(
    (
      paneId: UtilityPaneId,
      width: number,
      options?: { filesWidth?: number; browserWidth?: number },
    ) => {
      const hostWidth =
        utilityPaneHostRef.current?.getBoundingClientRect().width ?? 0;
      const effectiveFilesWidth =
        options?.filesWidth ?? filesPaneWidthRef.current;
      const effectiveBrowserWidth =
        options?.browserWidth ?? browserPaneWidthRef.current;
      const visiblePaneIds = FIXED_SPACE_ORDER.filter(
        (pane) => spaceVisibilityRef.current[pane],
      );
      const flexPaneId = visiblePaneIds.includes("agent")
        ? "agent"
        : (visiblePaneIds[visiblePaneIds.length - 1] ?? null);
      const resizerCount = Math.max(0, visiblePaneIds.length - 1);
      const fixedOtherWidths = visiblePaneIds.reduce((total, visiblePaneId) => {
        if (
          visiblePaneId === paneId ||
          visiblePaneId === flexPaneId ||
          visiblePaneId === "agent"
        ) {
          return total;
        }
        return (
          total +
          (visiblePaneId === "files"
            ? effectiveFilesWidth
            : effectiveBrowserWidth)
        );
      }, 0);
      const minFlexibleWidth =
        flexPaneId === "agent"
          ? MIN_AGENT_CONTENT_WIDTH
          : utilityPaneMinWidth(flexPaneId);
      const minPaneWidth = utilityPaneMinWidth(paneId);
      const maxWidth =
        hostWidth > 0
          ? Math.min(
              MAX_UTILITY_PANE_WIDTH,
              Math.max(
                minPaneWidth,
                hostWidth -
                  fixedOtherWidths -
                  minFlexibleWidth -
                  resizerCount * UTILITY_PANE_RESIZER_WIDTH,
              ),
            )
          : MAX_UTILITY_PANE_WIDTH;
      return Math.max(minPaneWidth, Math.min(width, maxWidth));
    },
    [],
  );

  const clampPairedUtilityPaneWidths = useCallback(
    (
      leftPaneId: UtilityPaneId,
      rightPaneId: UtilityPaneId,
      leftWidth: number,
      rightWidth: number,
    ) => {
      const hostWidth =
        utilityPaneHostRef.current?.getBoundingClientRect().width ?? 0;
      if (hostWidth <= 0) {
        return {
          leftWidth: Math.max(
            utilityPaneMinWidth(leftPaneId),
            Math.min(leftWidth, MAX_UTILITY_PANE_WIDTH),
          ),
          rightWidth: Math.max(
            utilityPaneMinWidth(rightPaneId),
            Math.min(rightWidth, MAX_UTILITY_PANE_WIDTH),
          ),
        };
      }

      const effectiveFilesWidth =
        leftPaneId === "files"
          ? leftWidth
          : rightPaneId === "files"
            ? rightWidth
            : filesPaneWidthRef.current;
      const effectiveBrowserWidth =
        leftPaneId === "browser"
          ? leftWidth
          : rightPaneId === "browser"
            ? rightWidth
            : browserPaneWidthRef.current;
      const visiblePaneIds = FIXED_SPACE_ORDER.filter(
        (pane) => spaceVisibilityRef.current[pane],
      );
      const resizerCount = Math.max(0, visiblePaneIds.length - 1);
      const fixedOtherWidths = visiblePaneIds.reduce((total, visiblePaneId) => {
        if (
          visiblePaneId === "agent" ||
          visiblePaneId === leftPaneId ||
          visiblePaneId === rightPaneId
        ) {
          return total;
        }
        return (
          total +
          (visiblePaneId === "files"
            ? effectiveFilesWidth
            : effectiveBrowserWidth)
        );
      }, 0);
      const maxCombinedWidth = Math.min(
        MAX_UTILITY_PANE_WIDTH * 2,
        Math.max(
          utilityPaneMinWidth(leftPaneId) + utilityPaneMinWidth(rightPaneId),
          hostWidth -
            fixedOtherWidths -
            MIN_AGENT_CONTENT_WIDTH -
            resizerCount * UTILITY_PANE_RESIZER_WIDTH,
        ),
      );
      const combinedWidth = Math.min(leftWidth + rightWidth, maxCombinedWidth);
      const nextLeftWidth = Math.max(
        utilityPaneMinWidth(leftPaneId),
        Math.min(leftWidth, combinedWidth - utilityPaneMinWidth(rightPaneId)),
      );
      return {
        leftWidth: nextLeftWidth,
        rightWidth: combinedWidth - nextLeftWidth,
      };
    },
    [],
  );

  const syncUtilityPaneWidths = useCallback(() => {
    const visiblePaneIds = FIXED_SPACE_ORDER.filter(
      (pane) => spaceVisibilityRef.current[pane],
    );
    if (visiblePaneIds.length === 0) {
      return;
    }

    const flexPaneId = visiblePaneIds.includes("agent")
      ? "agent"
      : (visiblePaneIds[visiblePaneIds.length - 1] ?? null);

    if (spaceVisibilityRef.current.files && flexPaneId !== "files") {
      setFilesPaneWidth((current) => clampUtilityPaneWidth("files", current));
    }
    if (spaceVisibilityRef.current.browser && flexPaneId !== "browser") {
      setBrowserPaneWidth((current) =>
        clampUtilityPaneWidth("browser", current),
      );
    }
  }, [clampUtilityPaneWidth]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    let mounted = true;
    void window.electronAPI.runtime.getStatus().then((status) => {
      if (mounted) {
        setRuntimeStatus(status);
      }
    });

    const unsubscribe = window.electronAPI.runtime.onStateChange((status) => {
      if (mounted) {
        setRuntimeStatus(status);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const updateMode = (mode: DevAppUpdatePreviewMode) => {
      setDevAppUpdatePreviewMode(mode);
      try {
        if (mode === "off") {
          localStorage.removeItem(DEV_APP_UPDATE_PREVIEW_STORAGE_KEY);
        } else {
          localStorage.setItem(DEV_APP_UPDATE_PREVIEW_STORAGE_KEY, mode);
        }
      } catch {
        // Ignore localStorage failures in dev preview mode.
      }
    };

    window.__holabossDevUpdatePreview = {
      downloading: () => updateMode("downloading"),
      ready: () => updateMode("ready"),
      clear: () => updateMode("off"),
    };

    return () => {
      delete window.__holabossDevUpdatePreview;
    };
  }, []);

  const showDevNotificationToastPreview = useCallback(() => {
    setDevNotificationToastPreview(
      buildDevNotificationToastPreviewNotifications(selectedWorkspaceId),
    );
  }, [selectedWorkspaceId]);

  const clearDevNotificationToastPreview = useCallback(() => {
    setDevNotificationToastPreview([]);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    window.__holabossDevNotificationToastPreview = {
      stack: () => showDevNotificationToastPreview(),
      clear: () => clearDevNotificationToastPreview(),
    };

    return () => {
      delete window.__holabossDevNotificationToastPreview;
    };
  }, [clearDevNotificationToastPreview, showDevNotificationToastPreview]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const unsubscribe = window.electronAPI.ui.onOpenSettingsPane((section) => {
      setSettingsDialogSection(
        isSettingsPaneSection(section) ? section : "settings",
      );
      setSettingsDialogOpen(true);
      void window.electronAPI.auth.closePopup();
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const unsubscribe = window.electronAPI.workbench.onOpenBrowser(
      (payload) => {
        if (
          payload.workspaceId &&
          payload.workspaceId !== selectedWorkspaceId
        ) {
          return;
        }

        const targetBrowserSpace = payload.space === "agent" ? "agent" : "user";
        const normalizedSessionId =
          typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
        const openBrowserPane = () => {
          setActiveShellView("space");
          setSpaceExplorerMode("browser");
          setSpaceBrowserSpace(targetBrowserSpace);
          setSpaceDisplayView({ type: "browser" });
          setSpaceWorkspacePanelCollapsed(false);
          setSpaceVisibility((previous) => ({
            ...previous,
            browser: true,
          }));
        };

        const requestedUrl =
          typeof payload.url === "string" ? payload.url.trim() : "";
        if (targetBrowserSpace === "agent" && normalizedSessionId) {
          setChatBrowserJumpRequestKeysBySessionId((current) => ({
            ...current,
            [normalizedSessionId]: Date.now(),
          }));
          return;
        }
        if (requestedUrl) {
          openBrowserPane();
          void window.electronAPI.browser
            .setActiveWorkspace(
              payload.workspaceId ?? selectedWorkspaceId ?? null,
              targetBrowserSpace,
              payload.sessionId ?? null,
            )
            .catch(() => undefined);
          return;
        }
        openBrowserPane();
        void window.electronAPI.browser
          .setActiveWorkspace(
            payload.workspaceId ?? selectedWorkspaceId ?? null,
            targetBrowserSpace,
            payload.sessionId ?? null,
          )
          .catch(() => undefined);
      },
    );

    return unsubscribe;
  }, [hasHydratedWorkspaceList, selectedWorkspaceId]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    let mounted = true;
    const applyAppUpdateStatus = (status: AppUpdateStatusPayload) => {
      if (mounted) {
        setAppUpdateStatus(status);
      }
    };

    const unsubscribe =
      window.electronAPI.appUpdate.onStateChange(applyAppUpdateStatus);

    void window.electronAPI.appUpdate
      .getStatus()
      .then(applyAppUpdateStatus)
      .catch(() => undefined);
    void window.electronAPI.appUpdate
      .checkNow()
      .then(applyAppUpdateStatus)
      .catch(() => undefined);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    // Renderer's localStorage is the source of truth for theme. Main holds an
    // in-memory `currentTheme` that doesn't persist across restart, so pulling
    // from it on mount would clobber the freshly-loaded localStorage state.
    // The save effect below pushes the correct value down to main instead.
    const unsubscribe = window.electronAPI.ui.onThemeChange((nextTheme) => {
      const split = splitAppTheme(nextTheme);
      if (split) {
        setThemeVariant(split.variant);
        setColorScheme((current) =>
          current === "system" ? current : split.scheme,
        );
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
    localStorage.setItem(THEME_VARIANT_STORAGE_KEY, themeVariant);
    void window.electronAPI.ui.setTheme(theme);
  }, [theme, colorScheme, themeVariant]);

  // Non-null only when the user is in the chat pane AND the window
  // is focused — tabbed-away counts as "not seeing it".
  const viewingChatSessionId =
    windowFocused &&
    activeShellView === "space" &&
    !spaceBrowserFullscreen &&
    agentView.type === "chat"
      ? (activeChatSessionId || "").trim() || null
      : null;

  const dismissNotificationToast = useCallback((notificationId: string) => {
    setToastNotifications((current) =>
      current.filter((item) => item.id !== notificationId),
    );
  }, []);

  const refreshNotifications = useCallback(async () => {
    if (!window.electronAPI) {
      return;
    }

    try {
      const [response, windowState] = await Promise.all([
        window.electronAPI.workspace.listNotifications(null, false, {
          includeCronjobSource: true,
        }),
        window.electronAPI.ui.getWindowState().catch(() => null),
      ]);
      const shellNotifications = response.items.filter(
        shouldIncludeRuntimeNotificationInShell,
      );
      setNotifications(shellNotifications);

      if (!notificationsHydratedRef.current) {
        notificationsHydratedRef.current = true;
        for (const item of shellNotifications) {
          seenNotificationIdsRef.current.add(item.id);
        }
        return;
      }

      const isWindowAway =
        windowState?.isMinimized === true || !windowFocused;
      for (const item of shellNotifications) {
        if (
          item.state !== "unread" ||
          seenNotificationIdsRef.current.has(item.id)
        ) {
          continue;
        }

        const normalizedNotificationWorkspaceId = item.workspace_id.trim();
        const isVisibleControlCenterMainSessionNotification =
          activeShellView === "control_center" &&
          item.source_type === "main_session" &&
          Boolean(normalizedNotificationWorkspaceId) &&
          controlCenterVisibleWorkspaceIdSet.has(
            normalizedNotificationWorkspaceId,
          );
        const consumeControlCenterComposerSubmissionSuppression = () => {
          if (
            item.source_type !== "main_session" ||
            !normalizedNotificationWorkspaceId
          ) {
            return false;
          }
          return controlCenterCardComposerSubmissionWorkspaceIdsRef.current.delete(
            normalizedNotificationWorkspaceId,
          );
        };

        if (shouldShowNativeRuntimeNotification(item, isWindowAway)) {
          const lastAttemptAt =
            nativeRuntimeNotificationAttemptedAtRef.current.get(item.id) ?? 0;
          if (Date.now() - lastAttemptAt < 15_000) {
            continue;
          }
          nativeRuntimeNotificationAttemptedAtRef.current.set(item.id, Date.now());
          const shown = await window.electronAPI.ui.showNativeNotification({
            title: item.title,
            body: item.message,
            workspaceId: item.workspace_id,
            sessionId: notificationTargetSessionId(item),
            force: isSystemCronjobNotification(item),
          });
          if (shown) {
            consumeControlCenterComposerSubmissionSuppression();
            seenNotificationIdsRef.current.add(item.id);
            nativeRuntimeNotificationAttemptedAtRef.current.delete(item.id);
            try {
              await window.electronAPI.workspace.updateNotification(item.workspace_id, item.id, {
                state: "dismissed",
              });
            } catch {
              // Ignore transient dismissal failures; the seen set prevents duplicate local alerts.
            }
          }
          continue;
        }

        if (isVisibleControlCenterMainSessionNotification) {
          const suppressHighlight =
            consumeControlCenterComposerSubmissionSuppression();
          seenNotificationIdsRef.current.add(item.id);
          if (!suppressHighlight) {
            setControlCenterHighlightedWorkspaceIds((current) => {
              if (current.includes(normalizedNotificationWorkspaceId)) {
                return current;
              }
              return [normalizedNotificationWorkspaceId, ...current];
            });
          }
          try {
            await window.electronAPI.workspace.updateNotification(item.workspace_id, item.id, {
              state: "dismissed",
            });
          } catch {
            // Ignore transient dismissal failures in the shell.
          }
          continue;
        }

        if (shouldDismissVisibleRuntimeNotification(item, selectedWorkspaceId)) {
          consumeControlCenterComposerSubmissionSuppression();
          seenNotificationIdsRef.current.add(item.id);
          try {
            await window.electronAPI.workspace.updateNotification(item.workspace_id, item.id, {
              state: "dismissed",
            });
          } catch {
            // Ignore transient dismissal failures in the shell.
          }
          continue;
        }

        if (
          !shouldToastVisibleRuntimeNotification(item, {
            selectedWorkspaceId,
            viewingChatSessionId: viewingChatSessionId,
          })
        ) {
          continue;
        }

        consumeControlCenterComposerSubmissionSuppression();
        seenNotificationIdsRef.current.add(item.id);
        setToastNotifications((current) => {
          if (current.some((existing) => existing.id === item.id)) {
            return current;
          }
          return [item, ...current].slice(0, 4);
        });
      }
    } catch {
      // Notification polling should stay silent when the runtime is restarting.
    }
  }, [
    activeShellView,
    controlCenterVisibleWorkspaceIdSet,
    selectedWorkspaceId,
    viewingChatSessionId,
  ]);

  useEffect(() => {
    // Drop toasts whose underlying notification (a) was deleted from
    // the store entirely OR (b) is no longer in the `unread` state.
    // Without the state check, notifications auto-marked "read" by
    // other UI paths (the inbox popover, server-side activation,
    // direct session view) would stay visible at the top even though
    // the inbox already removed them.
    const activeUnreadIds = new Set(
      notifications
        .filter((notification) => notification.state === "unread")
        .map((notification) => notification.id),
    );
    setToastNotifications((current) => {
      const next = current.filter((item) => activeUnreadIds.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [notifications]);

  // Auto-mark unread notifications as read when the user is actively
  // viewing the chat session they reference. "Opened the session" is
  // the strongest possible read-receipt signal — the user is looking
  // at the conversation, anything that landed there has been seen by
  // definition. Without this, notifications keep piling up in the
  // inbox / toast stack even though the user already read the event.
  const autoReadAttemptedNotificationIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!viewingChatSessionId || !window.electronAPI) {
      // Reset the dedupe set on session change so the next session
      // start fresh — same notification id could only appear under
      // one session anyway, but better to be defensive.
      autoReadAttemptedNotificationIdsRef.current = new Set();
      return;
    }
    const attempted = autoReadAttemptedNotificationIdsRef.current;
    const candidates = notifications.filter((notification) => {
      if (notification.state !== "unread") return false;
      if (attempted.has(notification.id)) return false;
      const notifSessionId = notificationTargetSessionId(notification);
      return notifSessionId === viewingChatSessionId;
    });
    if (candidates.length === 0) return;
    for (const notification of candidates) {
      attempted.add(notification.id);
      dismissNotificationToast(notification.id);
      window.electronAPI.workspace
        .updateNotification(notification.workspace_id, notification.id, {
          state: "read",
        })
        .catch(() => {
          // Network blip — let the next render retry by clearing the
          // attempted marker. The notification will still be unread
          // server-side and re-surface on the next refresh.
          attempted.delete(notification.id);
        });
    }
    void refreshNotifications();
  }, [
    dismissNotificationToast,
    notifications,
    refreshNotifications,
    viewingChatSessionId,
  ]);

  const handleActivateNotification = useCallback(
    async (notificationId: string) => {
      if (!window.electronAPI) {
        return;
      }
      const notification = runtimeNotificationById.get(notificationId);
      if (!notification) {
        return;
      }

      dismissNotificationToast(notification.id);
      const targetUrl = notificationActionUrl(notification);
      const targetSessionId = notificationTargetSessionId(notification);
      const nextState = notificationActivationState(notification);

      try {
        await window.electronAPI.workspace.updateNotification(notification.workspace_id, notification.id, {
          state: nextState,
        });
        await refreshNotifications();
      } catch {
        // Ignore transient notification update failures in the shell.
      }
      if (targetSessionId) {
        const targetWorkspaceId = notification.workspace_id.trim();
        if (targetWorkspaceId) {
          setSelectedWorkspaceId(targetWorkspaceId);
        }
        setActiveShellView("space");
        setSpaceVisibility((previous) => ({
          ...previous,
          agent: true,
        }));
        setAgentView({ type: "chat" });
        setChatSessionJumpRequest({
          sessionId: targetSessionId,
          requestKey: Date.now(),
        });
        setChatFocusRequestKey((current) => current + 1);
        return;
      }
      if (targetUrl) {
        try {
          await window.electronAPI.ui.openExternalUrl(targetUrl);
        } catch {
          // Ignore transient shell URL open failures.
        }
        return;
      }
      // Fallback: no session, no URL (typical for cronjob reminders) — at
      // least switch to the originating workspace so the click does something
      // visible.
      const fallbackWorkspaceId = notification.workspace_id.trim();
      if (fallbackWorkspaceId) {
        setSelectedWorkspaceId(fallbackWorkspaceId);
        setActiveShellView("space");
      }
    },
    [
      dismissNotificationToast,
      runtimeNotificationById,
      refreshNotifications,
      setSelectedWorkspaceId,
    ],
  );

  const handleDismissNotification = useCallback(
    async (notificationId: string) => {
      if (isDevNotificationToastPreviewId(notificationId)) {
        setDevNotificationToastPreview((current) =>
          current.filter((item) => item.id !== notificationId),
        );
        return;
      }
      if (!window.electronAPI) {
        return;
      }
      const notification = runtimeNotificationById.get(notificationId);
      if (!notification) {
        return;
      }

      try {
        dismissNotificationToast(notificationId);
        await window.electronAPI.workspace.updateNotification(notification.workspace_id, notificationId, {
          state: "dismissed",
        });
        await refreshNotifications();
      } catch {
        // Ignore transient notification update failures in the shell.
      }
    },
    [dismissNotificationToast, runtimeNotificationById, refreshNotifications],
  );

  const handleActivateDisplayedNotification = useCallback(
    async (notificationId: string) => {
      if (isDevNotificationToastPreviewId(notificationId)) {
        setDevNotificationToastPreview((current) =>
          current.filter((item) => item.id !== notificationId),
        );
        return;
      }
      if (isTaskProposalToastId(notificationId)) {
        const notification = taskProposalToastById.get(notificationId);
        if (!notification) {
          return;
        }
        dismissTaskProposalToast(notificationId);
        openTaskProposalInbox(notification.workspace_id);
        return;
      }
      await handleActivateNotification(notificationId);
    },
    [
      dismissTaskProposalToast,
      handleActivateNotification,
      openTaskProposalInbox,
      taskProposalToastById,
    ],
  );

  const handleCloseDisplayedNotification = useCallback(
    async (notificationId: string) => {
      if (isDevNotificationToastPreviewId(notificationId)) {
        setDevNotificationToastPreview((current) =>
          current.filter((item) => item.id !== notificationId),
        );
        return;
      }
      if (isTaskProposalToastId(notificationId)) {
        dismissTaskProposalToast(notificationId);
        return;
      }
      await handleDismissNotification(notificationId);
    },
    [dismissTaskProposalToast, handleDismissNotification],
  );

  const inboxNotifications = useMemo(
    () => notifications.filter((item) => item.state === "unread"),
    [notifications],
  );
  const inboxWorkspacesById = useMemo(() => {
    const map = new Map<string, WorkspaceRecordPayload>();
    for (const workspace of workspaces) {
      map.set(workspace.id.trim(), workspace);
    }
    return map;
  }, [workspaces]);
  const handleMarkAllInboxNotificationsRead = useCallback(async () => {
    if (!window.electronAPI || inboxNotifications.length === 0) return;
    // Optimistically clear locally so the badge / popover update without
    // waiting on the round-trip; refreshNotifications below reconciles with
    // the server's truth.
    for (const item of inboxNotifications) {
      dismissNotificationToast(item.id);
    }
    await Promise.allSettled(
      inboxNotifications.map((item) =>
        window.electronAPI!.workspace.updateNotification(
          item.workspace_id,
          item.id,
          { state: "dismissed" },
        ),
      ),
    );
    await refreshNotifications();
  }, [dismissNotificationToast, inboxNotifications, refreshNotifications]);

  useEffect(() => {
    void refreshNotifications();
    const intervalId = window.setInterval(() => {
      void refreshNotifications();
    }, 3000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshNotifications]);

  const handleColorSchemeChange = useCallback((next: ColorScheme) => {
    setColorScheme(next);
  }, []);
  const handleThemeVariantChange = useCallback((next: ThemeVariant) => {
    setThemeVariant(next);
  }, []);

  const handleOpenExternalUrl = useCallback((url: string) => {
    void window.electronAPI.ui.openExternalUrl(url);
  }, []);

  const revealBrowserPane = useCallback((space: BrowserSpaceId = "user") => {
    setActiveShellView("space");
    setSpaceWorkspacePanelCollapsed(false);
    setSpaceExplorerMode("browser");
    setSpaceBrowserSpace(space);
    setSpaceDisplayView({ type: "browser" });
    setSpaceVisibility((previous) => ({
      ...previous,
      browser: true,
    }));
  }, []);

  const consumeChatBrowserJumpRequest = useCallback(
    (sessionId: string, requestKey: number) => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId || requestKey <= 0) {
        return;
      }
      setChatBrowserJumpRequestKeysBySessionId((current) => {
        if ((current[normalizedSessionId] ?? 0) !== requestKey) {
          return current;
        }
        const next = { ...current };
        delete next[normalizedSessionId];
        return next;
      });
    },
    [],
  );

  const handleJumpToSessionBrowser = useCallback(
    (sessionId: string, requestKey: number) => {
      const normalizedSessionId = sessionId.trim();
      if (!selectedWorkspaceId || !normalizedSessionId) {
        return;
      }
      revealBrowserPane("agent");
      void window.electronAPI.browser
        .setActiveWorkspace(selectedWorkspaceId, "agent", normalizedSessionId)
        .catch(() => undefined);
      consumeChatBrowserJumpRequest(normalizedSessionId, requestKey);
    },
    [consumeChatBrowserJumpRequest, revealBrowserPane, selectedWorkspaceId],
  );

  const hasPendingAgentJump = useMemo(
    () =>
      Object.values(chatBrowserJumpRequestKeysBySessionId).some(
        (value) => value > 0,
      ),
    [chatBrowserJumpRequestKeysBySessionId],
  );

  const activeChatBrowserJumpRequest = useMemo(() => {
    const normalizedSessionId = (activeChatSessionId || "").trim();
    if (!normalizedSessionId) {
      return null;
    }
    const requestKey =
      chatBrowserJumpRequestKeysBySessionId[normalizedSessionId] ?? 0;
    if (requestKey <= 0) {
      return null;
    }
    return {
      sessionId: normalizedSessionId,
      requestKey,
    };
  }, [activeChatSessionId, chatBrowserJumpRequestKeysBySessionId]);

  const handleOpenLinkInAppBrowser = useCallback(
    (url: string, workspaceIdOverride?: string | null) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }

      revealBrowserPane("user");
      const targetWorkspaceId =
        workspaceIdOverride !== undefined
          ? workspaceIdOverride
          : selectedWorkspaceId || null;
      void window.electronAPI.browser
        .setActiveWorkspace(targetWorkspaceId, "user")
        .then(() => window.electronAPI.browser.navigate(normalizedUrl))
        .catch(() => undefined);
    },
    [revealBrowserPane, selectedWorkspaceId],
  );

  const handleOpenLinkInNewAppBrowserTab = useCallback(
    (url: string, workspaceIdOverride?: string | null) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }

      revealBrowserPane("user");
      const targetWorkspaceId =
        workspaceIdOverride !== undefined
          ? workspaceIdOverride
          : selectedWorkspaceId || null;
      void window.electronAPI.browser
        .setActiveWorkspace(targetWorkspaceId, "user")
        .then(() => window.electronAPI.browser.newTab(normalizedUrl))
        .catch(() => undefined);
    },
    [revealBrowserPane, selectedWorkspaceId],
  );

  const handleOpenCreateWorkspacePanel = useCallback(() => {
    setCreateWorkspacePanelAnchorWorkspaceId(selectedWorkspaceId || "");
    setCreateWorkspacePanelOpen(true);
  }, [hasHydratedWorkspaceList, selectedWorkspaceId]);

  const handleCloseCreateWorkspacePanel = useCallback(() => {
    setCreateWorkspacePanelOpen(false);
    setCreateWorkspacePanelAnchorWorkspaceId("");
  }, []);

  useEffect(() => {
    if (!createWorkspacePanelOpen) {
      return;
    }
    if (!selectedWorkspaceId || !createWorkspacePanelAnchorWorkspaceId) {
      return;
    }
    if (selectedWorkspaceId !== createWorkspacePanelAnchorWorkspaceId) {
      setActiveShellView("space");
      setAgentView({ type: "chat" });
      setChatFocusRequestKey((current) => current + 1);
      setCreateWorkspacePanelOpen(false);
      setCreateWorkspacePanelAnchorWorkspaceId("");
    }
  }, [
    createWorkspacePanelAnchorWorkspaceId,
    createWorkspacePanelOpen,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      return;
    }
    setWorkspaceAppsDialogOpen(false);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setChatSessionJumpRequest(null);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(
      OPERATIONS_DRAWER_OPEN_STORAGE_KEY,
      operationsDrawerOpen ? "1" : "0",
    );
  }, [operationsDrawerOpen]);

  useEffect(() => {
    localStorage.setItem(
      OPERATIONS_DRAWER_TAB_STORAGE_KEY,
      activeOperationsTab,
    );
  }, [activeOperationsTab]);

  useEffect(() => {
    localStorage.setItem(
      TASK_PROPOSAL_SEEN_STORAGE_KEY,
      JSON.stringify(seenTaskProposalIdsByWorkspace),
    );
  }, [seenTaskProposalIdsByWorkspace]);

  useEffect(() => {
    localStorage.setItem(
      BROWSER_PANE_WIDTH_STORAGE_KEY,
      String(browserPaneWidth),
    );
  }, [browserPaneWidth]);

  useEffect(() => {
    localStorage.setItem(
      CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY,
      String(controlCenterCardsPerRow),
    );
  }, [controlCenterCardsPerRow]);

  useEffect(() => {
    localStorage.setItem(
      CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY,
      JSON.stringify(controlCenterWorkspaceCardOrder),
    );
  }, [controlCenterWorkspaceCardOrder]);

  useEffect(() => {
    localStorage.setItem(
      SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY,
      spaceWorkspacePanelCollapsed ? "1" : "0",
    );
  }, [spaceWorkspacePanelCollapsed]);

  useEffect(() => {
    localStorage.setItem(
      SPACE_VISIBILITY_STORAGE_KEY,
      JSON.stringify(spaceVisibility),
    );
  }, [spaceVisibility]);

  useEffect(() => {
    if (spaceVisibility.agent) {
      return;
    }
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
    }));
  }, [spaceVisibility.agent]);

  useEffect(() => {
    setChatSessionOpenRequest(null);
    setMeetingModeError("");
    setChatBrowserJumpRequestKeysBySessionId({});
    setActiveChatSessionId(null);
    setChatScheduleEditContext(null);
  }, [selectedWorkspaceId]);

  async function refreshTaskProposals() {
    if (!selectedWorkspaceId || !selectedWorkspace) {
      applyTaskProposals(selectedWorkspaceId, selectedWorkspace?.name, [], {
        notify: false,
      });
      setTaskProposalStatusMessage("");
      return;
    }

    setTaskProposalStatusMessage("");
    setIsLoadingTaskProposals(true);
    try {
      const response = await window.electronAPI.workspace.listTaskProposals(
        selectedWorkspace.id,
      );
      applyTaskProposals(
        selectedWorkspace.id,
        selectedWorkspace.name,
        response.proposals,
      );
    } catch (error) {
      setTaskProposalStatusMessage(normalizeErrorMessage(error));
    } finally {
      setIsLoadingTaskProposals(false);
    }
  }

  async function acceptTaskProposal(proposal: TaskProposalRecordPayload) {
    if (!selectedWorkspaceId || !selectedWorkspace) {
      return;
    }

    setProposalAction({ proposalId: proposal.proposal_id, action: "accept" });
    setTaskProposalStatusMessage("");
    try {
      const accepted = await window.electronAPI.workspace.acceptTaskProposal({
        proposal_id: proposal.proposal_id,
        workspace_id: proposal.workspace_id,
        task_name: proposal.task_name,
        task_prompt: proposal.task_prompt,
        parent_session_id: activeChatSessionId?.trim() || null,
        priority: 0,
        model: currentComposerSelectedModel(runtimeConfig),
      });
      const detail =
        accepted.input.status === "QUEUED"
          ? `Started background task "${proposal.task_name}".`
          : `Accepted "${proposal.task_name}" as background work.`;
      setTaskProposalStatusMessage(detail);
      await refreshTaskProposals();
    } catch (error) {
      setTaskProposalStatusMessage(normalizeErrorMessage(error));
    } finally {
      setProposalAction(null);
    }
  }

  async function dismissTaskProposal(proposal: TaskProposalRecordPayload) {
    setProposalAction({ proposalId: proposal.proposal_id, action: "dismiss" });
    setTaskProposalStatusMessage("");
    try {
      await window.electronAPI.workspace.updateTaskProposalState(
        proposal.workspace_id,
        proposal.proposal_id,
        "dismissed",
      );
      const detail = `Dismissed "${proposal.task_name}" and persisted the update back to the backend.`;
      setTaskProposalStatusMessage(detail);
      await refreshTaskProposals();
    } catch (error) {
      setTaskProposalStatusMessage(normalizeErrorMessage(error));
    } finally {
      setProposalAction(null);
    }
  }

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedWorkspace) {
      applyTaskProposals(selectedWorkspaceId, selectedWorkspace?.name, [], {
        notify: false,
      });
      setTaskProposalStatusMessage("");
      setIsLoadingTaskProposals(false);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const response = await window.electronAPI.workspace.listTaskProposals(
          selectedWorkspace.id,
        );
        if (!cancelled) {
          applyTaskProposals(
            selectedWorkspace.id,
            selectedWorkspace.name,
            response.proposals,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setTaskProposalStatusMessage(normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingTaskProposals(false);
        }
      }
    };

    setIsLoadingTaskProposals(true);
    void load();
    const timer = window.setInterval(() => {
      setIsLoadingTaskProposals(true);
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyTaskProposals, selectedWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    if (
      agentView.type !== "inbox" ||
      !selectedWorkspaceId ||
      taskProposals.length === 0
    ) {
      return;
    }
    markTaskProposalsSeen(selectedWorkspaceId, taskProposals);
  }, [
    agentView.type,
    markTaskProposalsSeen,
    selectedWorkspaceId,
    taskProposals,
  ]);

  useEffect(() => {
    if (
      !operationsDrawerOpen ||
      activeOperationsTab !== "inbox" ||
      !selectedWorkspaceId ||
      taskProposals.length === 0
    ) {
      return;
    }
    markTaskProposalsSeen(selectedWorkspaceId, taskProposals);
  }, [
    activeOperationsTab,
    markTaskProposalsSeen,
    operationsDrawerOpen,
    selectedWorkspaceId,
    taskProposals,
  ]);

  const handleDismissUpdate = useCallback(() => {
    if (import.meta.env.DEV && devAppUpdatePreviewMode !== "off") {
      setDevAppUpdatePreviewMode("off");
      try {
        localStorage.removeItem(DEV_APP_UPDATE_PREVIEW_STORAGE_KEY);
      } catch {
        // Ignore localStorage failures in dev preview mode.
      }
      return;
    }
    void window.electronAPI.appUpdate.dismiss(
      effectiveAppUpdateStatus?.latestVersion ?? null,
    );
  }, [devAppUpdatePreviewMode, effectiveAppUpdateStatus]);

  const handleInstallUpdate = () => {
    if (import.meta.env.DEV && devAppUpdatePreviewMode !== "off") {
      return;
    }
    void window.electronAPI.appUpdate.installNow();
  };

  const handleOpenUpdateChangelog = useCallback(() => {
    if (!effectiveAppUpdateStatus) {
      return;
    }
    const changelogUrl = appUpdateChangelogUrl(effectiveAppUpdateStatus);
    if (!changelogUrl) {
      return;
    }
    void window.electronAPI.ui.openExternalUrl(changelogUrl);
  }, [effectiveAppUpdateStatus]);
  const toggleOperationsDrawer = () => {
    setOperationsDrawerOpen((open) => !open);
  };

  const openOperationsDrawerTab = (tab: OperationsDrawerTab) => {
    setActiveOperationsTab(tab);
    setOperationsDrawerOpen(true);
    if (tab === "inbox" && selectedWorkspaceId) {
      markTaskProposalsSeen(selectedWorkspaceId, taskProposals);
    }
  };

  const installedAppIds = useMemo(
    () => new Set(installedApps.map((app) => app.id)),
    [installedApps],
  );

  const handleAddApp = () => {
    setWorkspaceAppsDialogOpen(true);
  };

  const handleOpenSpaceApp = useCallback(
    (
      appId: string,
      options?: {
        path?: string | null;
        resourceId?: string | null;
        view?: string | null;
        resetAgentView?: boolean;
      },
    ) => {
      setActiveShellView("space");
      setSpaceWorkspacePanelCollapsed(false);
      setSpaceExplorerMode("applications");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
        files: true,
      }));
      if (options?.resetAgentView) {
        setAgentView({ type: "chat" });
      }
      setSpaceDisplayView({
        type: "app",
        appId,
        path: options?.path,
        resourceId: options?.resourceId,
        view: options?.view,
      });
    },
    [],
  );

  const handleOpenAutomationRunSession = useCallback(
    (sessionId: string, workspaceId?: string | null) => {
      const normalizedSessionId = sessionId.trim();
      const normalizedWorkspaceId =
        workspaceId?.trim() || selectedWorkspaceId?.trim() || "";
      if (!normalizedSessionId) {
        return;
      }
      if (!normalizedWorkspaceId) {
        return;
      }

      if (normalizedWorkspaceId !== (selectedWorkspaceId?.trim() || "")) {
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }

      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatSessionJumpRequest({
        sessionId: normalizedSessionId,
        requestKey: Date.now(),
      });
      setChatFocusRequestKey((current) => current + 1);
    },
    [selectedWorkspaceId, setSelectedWorkspaceId],
  );

  const nextChatSessionOpenRequestKey = useCallback(() => {
    chatSessionOpenRequestKeyRef.current += 1;
    return chatSessionOpenRequestKeyRef.current;
  }, []);

  const nextChatComposerPrefillRequestKey = useCallback(() => {
    chatComposerPrefillRequestKeyRef.current += 1;
    return chatComposerPrefillRequestKeyRef.current;
  }, []);

  const nextChatExplorerAttachmentRequestKey = useCallback(() => {
    chatExplorerAttachmentRequestKeyRef.current += 1;
    return chatExplorerAttachmentRequestKeyRef.current;
  }, []);

  const handleCreateScheduleInChat = useCallback(
    (workspaceId?: string | null) => {
      const normalizedWorkspaceId =
        workspaceId?.trim() || selectedWorkspaceId?.trim() || "";
      if (!normalizedWorkspaceId) {
        return;
      }

      if (normalizedWorkspaceId !== (selectedWorkspaceId?.trim() || "")) {
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }

      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatSessionJumpRequest(null);
      setChatSessionOpenRequest({
        sessionId: "",
        mode: "draft",
        parentSessionId: null,
        requestKey: nextChatSessionOpenRequestKey(),
      });
      setChatComposerPrefillRequest({
        text: "Create a schedule for ",
        requestKey: nextChatComposerPrefillRequestKey(),
        mode: "replace",
      });
      setChatFocusRequestKey((current) => current + 1);
    },
    [
      nextChatComposerPrefillRequestKey,
      nextChatSessionOpenRequestKey,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
    ],
  );

  const handleEditScheduleInChat = useCallback(
    (job: CronjobRecordPayload, workspaceId?: string | null) => {
      const normalizedWorkspaceId =
        workspaceId?.trim() || selectedWorkspaceId?.trim() || "";
      if (!normalizedWorkspaceId) {
        return;
      }

      if (normalizedWorkspaceId !== (selectedWorkspaceId?.trim() || "")) {
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }

      const jobName =
        job.name?.trim() || job.description?.trim() || "Untitled schedule";
      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatSessionJumpRequest(null);
      setChatSessionOpenRequest({
        sessionId: "",
        mode: "draft",
        parentSessionId: null,
        requestKey: nextChatSessionOpenRequestKey(),
      });
      // Lean prefill — the agent already has tool access to every
      // schedule, so it can fetch the cron / instruction / id by
      // name. Stuffing all that into the composer made the input
      // almost-impossible to edit (long pre-text in a single-line
      // composer). Now the user types only what they want to change.
      setChatComposerPrefillRequest({
        text: `Edit "${jobName}": `,
        requestKey: nextChatComposerPrefillRequestKey(),
        mode: "replace",
      });
      // Surface the schedule's full detail (cron / instruction /
      // description) above the composer so the user can read what they're
      // editing without asking the agent to dump it. Cleared on send /
      // dismiss inside ChatPane.
      setChatScheduleEditContext(job);
      setChatFocusRequestKey((current) => current + 1);
    },
    [
      nextChatComposerPrefillRequestKey,
      nextChatSessionOpenRequestKey,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
    ],
  );

  const handleCreateSession = useCallback(
    (request?: {
      sessionId: string;
      mode?: "session" | "draft";
      parentSessionId?: string | null;
      requestKey: number;
    }) => {
      if (!selectedWorkspaceId) {
        return;
      }

      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatSessionJumpRequest(null);
      setChatSessionOpenRequest(
        request ?? {
          sessionId: "",
          mode: "draft",
          parentSessionId: null,
          requestKey: nextChatSessionOpenRequestKey(),
        },
      );
      setChatFocusRequestKey((current) => current + 1);
    },
    [nextChatSessionOpenRequestKey, selectedWorkspaceId],
  );

  const handleOpenInboxPane = useCallback(() => {
    openTaskProposalInbox(selectedWorkspaceId);
  }, [openTaskProposalInbox, selectedWorkspaceId]);

  const handleOpenSessionsPane = useCallback(() => {
    setActiveShellView("space");
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
    }));
    setAgentView({ type: "sessions" });
  }, []);

  const handleOpenAutomationsPane = useCallback(() => {
    setActiveShellView("space");
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
    }));
    setAgentView({ type: "automations" });
  }, []);

  const handleOpenArtifactsPane = useCallback(() => {
    setActiveShellView("space");
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
    }));
    setAgentView({ type: "artifacts" });
  }, []);

  const handleReturnToChatPane = useCallback(() => {
    setAgentView({ type: "chat" });
    setChatFocusRequestKey((current) => current + 1);
  }, []);

  const handleOpenControlCenter = useCallback(() => {
    setActiveShellView("control_center");
  }, []);

  const clearControlCenterWorkspaceHighlight = useCallback(
    (workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }
      setControlCenterHighlightedWorkspaceIds((current) => {
        if (!current.includes(normalizedWorkspaceId)) {
          return current;
        }
        return current.filter((item) => item !== normalizedWorkspaceId);
      });
    },
    [],
  );

  const handleControlCenterVisibleWorkspaceIdsChange = useCallback(
    (workspaceIds: string[]) => {
      const nextWorkspaceIds = workspaceIds
        .map((workspaceId) => workspaceId.trim())
        .filter(Boolean);
      setControlCenterVisibleWorkspaceIds((current) =>
        current.length === nextWorkspaceIds.length &&
        current.every((workspaceId, index) => workspaceId === nextWorkspaceIds[index])
          ? current
          : nextWorkspaceIds,
      );
    },
    [],
  );

  const handleMarkControlCenterWorkspaceComposerSubmission = useCallback(
    (workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }
      controlCenterCardComposerSubmissionWorkspaceIdsRef.current.add(
        normalizedWorkspaceId,
      );
      clearControlCenterWorkspaceHighlight(normalizedWorkspaceId);
    },
    [clearControlCenterWorkspaceHighlight],
  );

  const handleControlCenterWorkspaceCompletion = useCallback(
    (workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (
        !normalizedWorkspaceId ||
        activeShellView !== "control_center" ||
        !controlCenterVisibleWorkspaceIdSet.has(normalizedWorkspaceId)
      ) {
        return;
      }
      const suppressHighlight =
        controlCenterCardComposerSubmissionWorkspaceIdsRef.current.delete(
          normalizedWorkspaceId,
        );
      if (suppressHighlight) {
        return;
      }
      setControlCenterHighlightedWorkspaceIds((current) => {
        if (current.includes(normalizedWorkspaceId)) {
          return current;
        }
        return [normalizedWorkspaceId, ...current];
      });
    },
    [activeShellView, controlCenterVisibleWorkspaceIdSet],
  );

  const handleControlCenterWorkspaceOrderChange = useCallback(
    (workspaceIds: string[]) => {
      const nextWorkspaceIds = workspaceIds
        .map((workspaceId) => workspaceId.trim())
        .filter(Boolean);
      setControlCenterWorkspaceCardOrder((current) =>
        current.length === nextWorkspaceIds.length &&
        current.every((workspaceId, index) => workspaceId === nextWorkspaceIds[index])
          ? current
          : nextWorkspaceIds,
      );
    },
    [],
  );

  const handleSelectControlCenterWorkspace = useCallback(
    (workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }
      clearControlCenterWorkspaceHighlight(normalizedWorkspaceId);
      setSelectedWorkspaceId(normalizedWorkspaceId);
    },
    [clearControlCenterWorkspaceHighlight, setSelectedWorkspaceId],
  );

  const handleEnterWorkspace = useCallback(
    (workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }

      clearControlCenterWorkspaceHighlight(normalizedWorkspaceId);
      if (normalizedWorkspaceId !== (selectedWorkspaceId?.trim() || "")) {
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }

      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatFocusRequestKey((current) => current + 1);
    },
    [
      clearControlCenterWorkspaceHighlight,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
    ],
  );

  const handleOpenWorkspaceRunningTasks = useCallback(
    (workspaceId: string) => {
      handleEnterWorkspace(workspaceId);
      setActiveOperationsTab("running");
      setOperationsDrawerOpen(true);
    },
    [handleEnterWorkspace],
  );

  const handleOpenWorkspaceAppsExplorer = useCallback(
    (workspaceId: string) => {
      handleEnterWorkspace(workspaceId);
      setSpaceVisibility((previous) => ({
        ...previous,
        files: true,
        agent: true,
      }));
      setSpaceWorkspacePanelCollapsed(false);
      setSpaceExplorerMode("applications");
    },
    [handleEnterWorkspace],
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI.ui.onNotificationActivated(
      ({ workspaceId }) => {
        if (!workspaceId) return;
        handleEnterWorkspace(workspaceId);
      },
    );
    return unsubscribe;
  }, [handleEnterWorkspace]);

  useEffect(() => {
    const unread = notifications.reduce(
      (count, item) => (item.state === "unread" ? count + 1 : count),
      0,
    );
    void window.electronAPI.ui.setBadgeCount(unread);
  }, [notifications]);

  useEffect(() => {
    return () => {
      void window.electronAPI.ui.setBadgeCount(0);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.ui
      .getNotificationsEnabled()
      .then((enabled) => {
        if (!cancelled) {
          setDesktopNotificationsEnabled(enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDesktopNotificationsChange = useCallback(
    (enabled: boolean) => {
      setDesktopNotificationsEnabled(enabled);
      void window.electronAPI.ui
        .setNotificationsEnabled(enabled)
        .then((persisted) => {
          setDesktopNotificationsEnabled(persisted);
        })
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (startupWorkspaceSelectionHandledRef.current) {
      return;
    }
    if (!hasHydratedWorkspaceList) {
      return;
    }
    if (workspaces.length === 0) {
      return;
    }

    startupWorkspaceSelectionHandledRef.current = true;

    const trimmedSelected = selectedWorkspaceId?.trim() || "";
    const selectionIsValid =
      trimmedSelected !== "" &&
      workspaces.some((workspace) => workspace.id === trimmedSelected);

    if (!selectionIsValid) {
      const fallbackWorkspaceId = workspaces[0]?.id ?? "";
      if (fallbackWorkspaceId) {
        setSelectedWorkspaceId(fallbackWorkspaceId);
      }
    }
  }, [
    hasHydratedWorkspaceList,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    workspaces,
  ]);

  // Flag any workspace IDs that show up *after* the initial hydration as
  // "freshly created in this session". Hydration itself never marks
  // anything new — existing workspaces from a prior session land in seen
  // before initialised flips true, so reload doesn't re-trigger expand.
  useEffect(() => {
    if (!hasHydratedWorkspaceList) {
      return;
    }
    for (const workspace of workspaces) {
      if (
        workspaceListInitializedRef.current &&
        !seenWorkspaceIdsRef.current.has(workspace.id)
      ) {
        newlyCreatedWorkspaceIdsRef.current.add(workspace.id);
      }
      seenWorkspaceIdsRef.current.add(workspace.id);
    }
    workspaceListInitializedRef.current = true;
  }, [workspaces, hasHydratedWorkspaceList]);

  // First time selectedWorkspaceId points at a freshly-created workspace,
  // expand the explorer panel so the user lands on a fully-revealed
  // surface. Consumed once — subsequent visits respect persisted state.
  useEffect(() => {
    const workspaceId = selectedWorkspaceId?.trim();
    if (!workspaceId) {
      return;
    }
    if (newlyCreatedWorkspaceIdsRef.current.has(workspaceId)) {
      newlyCreatedWorkspaceIdsRef.current.delete(workspaceId);
      setSpaceWorkspacePanelCollapsed(false);
    }
  }, [selectedWorkspaceId]);

  const handleChatComposerDraftTextChange = useCallback(
    (text: string) => {
      const workspaceId = selectedWorkspaceId?.trim() || "";
      if (!workspaceId) {
        return;
      }
      setChatComposerDraftTextByWorkspace((current) => {
        const existing = current[workspaceId] ?? "";
        if (existing === text) {
          return current;
        }
        if (!text) {
          if (!(workspaceId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[workspaceId];
          return next;
        }
        return {
          ...current,
          [workspaceId]: text,
        };
      });
    },
    [selectedWorkspaceId],
  );

  const handleReferenceWorkspacePathInChat = useCallback(
    (entry: LocalFileEntry) => {
      const normalizedAbsolutePath = entry.absolutePath.trim();
      const normalizedName = entry.name.trim();
      if (!normalizedAbsolutePath || !normalizedName) {
        return;
      }
      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatExplorerAttachmentRequest({
        files: [
          {
            absolutePath: normalizedAbsolutePath,
            name: normalizedName,
            size: Number.isFinite(entry.size) ? Math.max(0, entry.size) : 0,
            mimeType: entry.isDirectory ? "inode/directory" : null,
            kind: entry.isDirectory ? "folder" : undefined,
          },
        ],
        requestKey: nextChatExplorerAttachmentRequestKey(),
      });
      setChatFocusRequestKey((current) => current + 1);
    },
    [nextChatExplorerAttachmentRequestKey],
  );

  const handleChatComposerPrefillConsumed = useCallback(
    (requestKey: number) => {
      setChatComposerPrefillRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [],
  );

  const handleChatExplorerAttachmentRequestConsumed = useCallback(
    (requestKey: number) => {
      setChatExplorerAttachmentRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [],
  );

  const handleChatSessionOpenRequestConsumed = useCallback(
    (requestKey: number) => {
      setChatSessionOpenRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [],
  );

  const syncFileExplorerFocusWithDisplayView = useCallback(
    (displayView: SpaceDisplayView | null) => {
      if (displayView?.type !== "internal") {
        return;
      }
      if (
        (displayView.surface === "document" ||
          displayView.surface === "file") &&
        displayView.resourceId?.trim()
      ) {
        setFileExplorerFocusRequest({
          path: displayView.resourceId,
          requestKey: Date.now(),
        });
      }
    },
    [],
  );

  const handleMissingInternalResource = useCallback(
    (resourceId: string) => {
      const normalizedResourceId = normalizeComparablePath(resourceId);
      if (!normalizedResourceId) {
        return;
      }

      setAgentView((current) => {
        if (
          current.type !== "internal" ||
          (current.surface !== "document" && current.surface !== "file")
        ) {
          return current;
        }
        if (
          normalizeComparablePath(current.resourceId?.trim() ?? "") !==
          normalizedResourceId
        ) {
          return current;
        }
        return { type: "chat" };
      });

      setSpaceDisplayView((current) => {
        if (
          current.type !== "internal" ||
          (current.surface !== "document" && current.surface !== "file")
        ) {
          return current;
        }
        if (
          normalizeComparablePath(current.resourceId?.trim() ?? "") !==
          normalizedResourceId
        ) {
          return current;
        }
        if (selectedWorkspaceId) {
          delete lastRestorableSpaceFileDisplayViewByWorkspaceRef.current[
            selectedWorkspaceId
          ];
        }
        return { type: "empty" };
      });

      setFileExplorerFocusRequest((current) => {
        if (
          !current?.path ||
          normalizeComparablePath(current.path) !== normalizedResourceId
        ) {
          return current;
        }
        return null;
      });
    },
    [selectedWorkspaceId],
  );

  const handleDeleteWorkspaceEntry = useCallback(
    (entry: LocalFileEntry) => {
      const normalizedDeletedPath = normalizeComparablePath(entry.absolutePath);
      if (!normalizedDeletedPath) {
        return;
      }

      setAgentView((current) => {
        if (
          current.type !== "internal" ||
          (current.surface !== "document" && current.surface !== "file")
        ) {
          return current;
        }
        if (
          !isPathWithin(normalizedDeletedPath, current.resourceId?.trim() ?? "")
        ) {
          return current;
        }
        return { type: "chat" };
      });

      setSpaceDisplayView((current) => {
        if (
          current.type !== "internal" ||
          (current.surface !== "document" && current.surface !== "file")
        ) {
          return current;
        }
        if (
          !isPathWithin(normalizedDeletedPath, current.resourceId?.trim() ?? "")
        ) {
          return current;
        }
        if (selectedWorkspaceId) {
          delete lastRestorableSpaceFileDisplayViewByWorkspaceRef.current[
            selectedWorkspaceId
          ];
        }
        return { type: "empty" };
      });

      setFileExplorerFocusRequest((current) => {
        if (
          !current?.path ||
          !isPathWithin(normalizedDeletedPath, current.path)
        ) {
          return current;
        }
        return null;
      });
    },
    [selectedWorkspaceId],
  );

  const reportedOperatorSurfaceContext = useMemo(
    () =>
      buildReportedOperatorSurfaceContext({
        activeShellView,
        agentView,
        spaceDisplayView,
      }),
    [activeShellView, agentView, spaceDisplayView],
  );
  const appShellSentryState = useMemo(
    () => ({
      selected_workspace_id: selectedWorkspaceId || null,
      active_shell_view: activeShellView,
      active_chat_session_id: activeChatSessionId || null,
      agent_view: summarizeAppShellView(agentView),
      space_display_view: summarizeAppShellView(spaceDisplayView),
      space_layout: {
        explorer_mode: spaceExplorerMode,
        browser_space: spaceBrowserSpace,
        visibility: spaceVisibility,
        workspace_panel_collapsed: effectiveSpaceWorkspacePanelCollapsed,
      },
      workspace: {
        count: workspaces.length,
        has_selected_workspace: Boolean(selectedWorkspace),
        has_hydrated_workspace_list: hasHydratedWorkspaceList,
        apps_ready: workspaceAppsReady,
        blocking_reason: workspaceBlockingReason || null,
        error_message: workspaceErrorMessage || null,
        onboarding_mode_active: onboardingModeActive,
      },
      runtime_status: summarizeRuntimeStatusForSentry(runtimeStatus),
      operations: {
        drawer_open: operationsDrawerOpen,
        active_tab: activeOperationsTab,
      },
      dialogs: {
        workspace_switcher_open: workspaceSwitcherOpen,
        settings_open: settingsDialogOpen,
        publish_open: publishOpen,
        create_workspace_open: createWorkspacePanelOpen,
        workspace_apps_open: workspaceAppsDialogOpen,
        task_proposal_details_open: taskProposalDetailsDialogOpen,
      },
      notifications: {
        total: notifications.length,
        toast_count: effectiveToastNotifications.length,
        task_proposal_count: taskProposals.length,
      },
      app_update: summarizeAppUpdateStatusForSentry(effectiveAppUpdateStatus),
      operator_surface: reportedOperatorSurfaceContext
        ? {
            active_surface_id:
              reportedOperatorSurfaceContext.active_surface_id ?? null,
            surface_count: reportedOperatorSurfaceContext.surfaces.length,
          }
        : null,
    }),
    [
      activeChatSessionId,
      activeOperationsTab,
      activeShellView,
      agentView,
      createWorkspacePanelOpen,
      effectiveAppUpdateStatus,
      effectiveToastNotifications.length,
      hasHydratedWorkspaceList,
      notifications.length,
      onboardingModeActive,
      operationsDrawerOpen,
      publishOpen,
      reportedOperatorSurfaceContext,
      runtimeStatus,
      selectedWorkspace,
      selectedWorkspaceId,
      settingsDialogOpen,
      spaceBrowserSpace,
      spaceDisplayView,
      spaceExplorerMode,
      effectiveSpaceWorkspacePanelCollapsed,
      spaceVisibility,
      taskProposalDetailsDialogOpen,
      taskProposals.length,
      workspaceAppsDialogOpen,
      workspaceAppsReady,
      workspaceBlockingReason,
      workspaceErrorMessage,
      workspaceSwitcherOpen,
      workspaces.length,
    ],
  );
  useRendererSentrySection("app_shell", appShellSentryState);

  useEffect(() => {
    pushRendererSentryActivity("workspace", "selected workspace changed", {
      selected_workspace_id: selectedWorkspaceId || null,
      has_selected_workspace: Boolean(selectedWorkspace),
    });
  }, [selectedWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    pushRendererSentryActivity("navigation", "app shell view changed", {
      active_shell_view: activeShellView,
      agent_view_type: agentView.type,
      space_display_type: spaceDisplayView.type,
      space_explorer_mode: spaceExplorerMode,
      space_browser_space: spaceBrowserSpace,
      space_workspace_panel_collapsed: effectiveSpaceWorkspacePanelCollapsed,
    });
  }, [
    activeShellView,
    agentView.type,
    spaceBrowserSpace,
    spaceDisplayView.type,
    spaceExplorerMode,
    effectiveSpaceWorkspacePanelCollapsed,
  ]);

  useEffect(() => {
    pushRendererSentryActivity("runtime", "renderer runtime status changed", {
      status: runtimeStatus?.status ?? "unknown",
      available: runtimeStatus?.available ?? false,
      last_error: runtimeStatus?.lastError || null,
    });
  }, [
    runtimeStatus?.available,
    runtimeStatus?.lastError,
    runtimeStatus?.status,
  ]);

  useEffect(() => {
    if (!activeChatSessionId) {
      return;
    }
    pushRendererSentryActivity("chat", "active chat session changed", {
      selected_workspace_id: selectedWorkspaceId || null,
      session_id: activeChatSessionId,
    });
  }, [activeChatSessionId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || spaceDisplayView.type !== "internal") {
      return;
    }
    lastRestorableSpaceFileDisplayViewByWorkspaceRef.current[
      selectedWorkspaceId
    ] = spaceDisplayView;
  }, [selectedWorkspaceId, spaceDisplayView]);

  useEffect(() => {
    if (!selectedWorkspaceId || spaceDisplayView.type !== "app") {
      return;
    }
    lastRestorableSpaceAppDisplayViewByWorkspaceRef.current[
      selectedWorkspaceId
    ] = spaceDisplayView;
  }, [selectedWorkspaceId, spaceDisplayView]);

  const restoreLastSpaceFileDisplayView = useCallback(() => {
    if (!selectedWorkspaceId) {
      setSpaceDisplayView({ type: "browser" });
      return;
    }

    const lastDisplayView =
      lastRestorableSpaceFileDisplayViewByWorkspaceRef.current[
        selectedWorkspaceId
      ];
    const nextDisplayView = lastDisplayView ?? spaceDisplayView;
    setSpaceDisplayView(nextDisplayView);
    syncFileExplorerFocusWithDisplayView(nextDisplayView);
  }, [
    selectedWorkspaceId,
    spaceDisplayView,
    syncFileExplorerFocusWithDisplayView,
  ]);

  const restoreLastSpaceAppDisplayView = useCallback(() => {
    if (!selectedWorkspaceId) {
      setSpaceDisplayView({ type: "browser" });
      return;
    }

    const lastAppDisplayView =
      lastRestorableSpaceAppDisplayViewByWorkspaceRef.current[
        selectedWorkspaceId
      ];
    if (lastAppDisplayView) {
      setSpaceDisplayView(lastAppDisplayView);
      return;
    }

    setSpaceDisplayView(spaceDisplayView);
  }, [selectedWorkspaceId, spaceDisplayView]);

  const toggleSpaceBrowserFullscreen = useCallback(() => {
    setSpaceBrowserFullscreen((prev) => {
      const next = !prev;
      if (next) {
        setSpaceWorkspacePanelCollapsed(false);
      }
      return next;
    });
  }, []);

  const applyLayoutMode = useCallback(
    (mode: "split" | "focus_chat" | "focus_work") => {
      if (mode === "split") {
        setSpaceBrowserFullscreen(false);
        setSpaceWorkspacePanelCollapsed(false);
      } else if (mode === "focus_chat") {
        setSpaceBrowserFullscreen(false);
        setSpaceWorkspacePanelCollapsed(true);
      } else {
        setSpaceWorkspacePanelCollapsed(false);
        setSpaceBrowserFullscreen(true);
      }
    },
    [],
  );

  // ESC-to-close for the custom full-screen panels. Each panel owns its
  // own escape binding via useEscapeToClose; Radix-based dialogs
  // (WorkspaceAppsDialog, PublishScreen) own their own ESC handling, and
  // the hook's defaultPrevented guard makes sure we don't fight them.
  useEscapeToClose(createWorkspacePanelOpen, handleCloseCreateWorkspacePanel);
  const handleCloseSettingsViaEscape = useCallback(() => {
    setSettingsDialogOpen(false);
    setSubmissionsFocusId(null);
  }, []);
  useEscapeToClose(settingsDialogOpen, handleCloseSettingsViaEscape);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setSpaceExplorerMode("browser");
      setSpaceDisplayView({ type: "browser" });
      return;
    }

    // If the click handler that just triggered this workspace switch
    // explicitly set spaceDisplayView (e.g. opening a file from a Control
    // Center card), honor that intent — don't restore from cache or reset
    // to browser. Otherwise this effect races the click handler and wipes
    // the just-set view (the "first-visit workspace, click file, preview
    // doesn't open" bug).
    if (
      explicitSpaceDisplayViewRequestedForWorkspaceRef.current ===
      selectedWorkspaceId
    ) {
      explicitSpaceDisplayViewRequestedForWorkspaceRef.current = null;
      return;
    }

    const nextDisplayView =
      lastRestorableSpaceFileDisplayViewByWorkspaceRef.current[
        selectedWorkspaceId
      ];
    if (!nextDisplayView) {
      setSpaceExplorerMode("browser");
      setSpaceDisplayView({ type: "browser" });
      return;
    }

    setSpaceDisplayView(nextDisplayView);
    syncFileExplorerFocusWithDisplayView(nextDisplayView);
  }, [selectedWorkspaceId, syncFileExplorerFocusWithDisplayView]);

  useEffect(() => {
    let cancelled = false;
    const previousWorkspaceId =
      reportedOperatorSurfaceWorkspaceIdRef.current?.trim() || "";
    const nextWorkspaceId = selectedWorkspaceId?.trim() || "";
    const switchedWorkspaces =
      previousWorkspaceId.length > 0 &&
      previousWorkspaceId !== nextWorkspaceId;

    async function syncReportedOperatorSurfaceContext() {
      try {
        if (switchedWorkspaces) {
          // Clear the destination workspace first so a just-switched shell
          // never reports the previous workspace's surface context under the
          // new workspace id during the transition render.
          await window.electronAPI.workspace.setOperatorSurfaceContext(
            previousWorkspaceId,
            null,
          );
          if (nextWorkspaceId) {
            await window.electronAPI.workspace.setOperatorSurfaceContext(
              nextWorkspaceId,
              null,
            );
          }
          if (!cancelled) {
            reportedOperatorSurfaceWorkspaceIdRef.current =
              nextWorkspaceId || null;
          }
          return;
        }
        if (nextWorkspaceId) {
          await window.electronAPI.workspace.setOperatorSurfaceContext(
            nextWorkspaceId,
            reportedOperatorSurfaceContext,
          );
        }
        if (!cancelled) {
          reportedOperatorSurfaceWorkspaceIdRef.current =
            nextWorkspaceId || null;
        }
      } catch {
        if (!cancelled && !nextWorkspaceId) {
          reportedOperatorSurfaceWorkspaceIdRef.current = null;
        }
      }
    }

    void syncReportedOperatorSurfaceContext();
    return () => {
      cancelled = true;
    };
  }, [reportedOperatorSurfaceContext, selectedWorkspaceId]);

  const handleSyncAgentOperationFileDisplay = useCallback((path: string) => {
    const targetPath = path.trim();
    if (!targetPath) {
      return;
    }

    setActiveShellView("space");
    setSpaceWorkspacePanelCollapsed(false);
    setSpaceExplorerMode("files");
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
      files: true,
    }));
    setAgentView({ type: "chat" });
    setSpaceDisplayView({
      type: "internal",
      surface: "file",
      resourceId: targetPath,
    });
    setFileExplorerFocusRequest({
      path: targetPath,
      requestKey: Date.now(),
    });
  }, []);

  const handleOpenLocalLinkInFiles = useCallback(
    (href: string) => {
      let raw = href.trim();
      if (!raw) {
        return;
      }
      if (raw.toLowerCase().startsWith("file://")) {
        raw = raw.slice(7);
      }
      let decoded = raw;
      try {
        decoded = decodeURI(raw);
      } catch {
        decoded = raw;
      }
      // FileExplorerPane resolves relative paths against the workspace root.
      handleSyncAgentOperationFileDisplay(decoded);
    },
    [handleSyncAgentOperationFileDisplay],
  );

  const openWorkspaceOutputTarget = useCallback(
    (
      target: WorkspaceOutputNavigationTarget,
      output: WorkspaceOutputRecordPayload,
    ) => {
      if (target.type === "app") {
        handleOpenSpaceApp(target.appId, {
          path: target.path,
          resourceId: target.resourceId,
          view: target.view,
          resetAgentView: true,
        });
        return;
      }

      if (target.type === "internal") {
        if (
          (target.surface === "document" || target.surface === "file") &&
          target.resourceId?.trim()
        ) {
          setActiveShellView("space");
          setSpaceWorkspacePanelCollapsed(false);
          setSpaceExplorerMode("files");
          setSpaceVisibility((previous) => ({
            ...previous,
            agent: true,
            files: true,
          }));
          setAgentView({ type: "chat" });
          setSpaceDisplayView({
            type: "internal",
            surface: target.surface,
            resourceId: target.resourceId,
          });
          setFileExplorerFocusRequest({
            path: target.resourceId,
            requestKey: Date.now(),
          });
          return;
        }

        setActiveShellView("space");
        setSpaceWorkspacePanelCollapsed(false);
        setSpaceVisibility((previous) => ({
          ...previous,
          agent: true,
        }));
        setAgentView({ type: "chat" });
        setSpaceDisplayView({
          type: "internal",
          surface: target.surface,
          resourceId: target.resourceId ?? output.id,
          htmlContent: target.htmlContent,
        });
      }
    },
    [handleOpenSpaceApp],
  );

  const handleOpenWorkspaceOutput = useCallback(
    (output: WorkspaceOutputRecordPayload) => {
      const target = workspaceOutputNavigationTarget(output, installedAppIds);
      openWorkspaceOutputTarget(target, output);
    },
    [installedAppIds, openWorkspaceOutputTarget],
  );

  const handleOpenControlCenterWorkspaceOutput = useCallback(
    async (workspaceId: string, output: WorkspaceOutputRecordPayload) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }

      const sameWorkspace =
        normalizedWorkspaceId === (selectedWorkspaceId?.trim() || "");
      let workspaceInstalledAppIds = installedAppIds;

      // installedAppIds is hydrated lazily on workspace entry; before that
      // it is empty and routing would fall through to the internal surface.
      if (!sameWorkspace || !workspaceAppsReady) {
        try {
          const lifecycle =
            await window.electronAPI.workspace.getWorkspaceLifecycle(
              normalizedWorkspaceId,
            );
          workspaceInstalledAppIds = new Set(
            lifecycle.applications
              .map((application) => application.app_id.trim())
              .filter(Boolean),
          );
        } catch {
          workspaceInstalledAppIds = sameWorkspace
            ? installedAppIds
            : new Set<string>();
        }
      }

      if (!sameWorkspace) {
        // Mark before the workspace switch: this batches with the
        // setSpaceDisplayView call inside openWorkspaceOutputTarget below,
        // so when the workspace-change effect fires it sees the marker and
        // defers to our explicit displayView instead of overwriting it.
        explicitSpaceDisplayViewRequestedForWorkspaceRef.current =
          normalizedWorkspaceId;
        setSelectedWorkspaceId(normalizedWorkspaceId);
      }

      const target = workspaceOutputNavigationTarget(
        output,
        workspaceInstalledAppIds,
      );
      openWorkspaceOutputTarget(target, output);
    },
    [
      installedAppIds,
      openWorkspaceOutputTarget,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      workspaceAppsReady,
    ],
  );

  const handleOpenRunningSession = (sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }

    setActiveShellView("space");
    setSpaceVisibility((previous) => ({
      ...previous,
      agent: true,
    }));
    setAgentView({ type: "chat" });
    setChatSessionOpenRequest({
      sessionId: normalizedSessionId,
      mode: "session",
      requestKey: nextChatSessionOpenRequestKey(),
    });
  };

  const handleOpenMeetingMode = useCallback(async () => {
    const workspaceId = selectedWorkspaceId?.trim() || "";
    if (!workspaceId || isStartingMeetingMode) {
      return;
    }

    setIsStartingMeetingMode(true);
    setMeetingModeError("");
    try {
      const response = await window.electronAPI.workspace.createWorkspaceLab(
        workspaceId,
        "meeting_mode",
      );
      const labWorkspaceId = response.lab?.id?.trim() || workspaceId;
      const sessionId = response.session?.session_id?.trim() || "";
      if (!sessionId) {
        throw new Error("Meeting mode session was not created.");
      }

      if (response.created) {
        await window.electronAPI.workspace.queueSessionInput({
          workspace_id: labWorkspaceId,
          session_id: sessionId,
          text:
            "Start meeting mode. Use the lab copied from the current workspace. Invite the user to rapidly critique what has not worked well, build a concrete change backlog from their feedback, and only implement changes after the user confirms priorities.",
          image_urls: null,
          attachments: [],
          priority: 0,
          model: null,
          thinking_value: null,
        });
      }

      setActiveShellView("space");
      setSpaceVisibility((previous) => ({
        ...previous,
        agent: true,
      }));
      setAgentView({ type: "chat" });
      setChatSessionJumpRequest(null);
      setChatSessionOpenRequest({
        sessionId,
        mode: "session",
        requestKey: nextChatSessionOpenRequestKey(),
      });
      setChatFocusRequestKey((current) => current + 1);
    } catch (error) {
      setMeetingModeError(normalizeErrorMessage(error));
    } finally {
      setIsStartingMeetingMode(false);
    }
  }, [
    isStartingMeetingMode,
    nextChatSessionOpenRequestKey,
    selectedWorkspaceId,
  ]);

  const controlCenterMode = activeShellView === "control_center";
  const spaceMode = activeShellView === "space";

  const controlCenterCardSignals = useControlCenterCardSignals(
    controlCenterVisibleWorkspaceIds,
    controlCenterMode,
  );

  // ⌘1 / ⌘2 / ⌘3 jump directly to a layout mode. Mirrors the macOS
  // Finder / browser view-mode convention; users learn the trio once
  // from the layout picker dropdown. Suppressed inside text inputs
  // and outside space mode so it doesn't fight typing or fire when
  // the user is in the control center.
  useEffect(() => {
    if (!spaceMode || controlCenterMode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      switch (event.key) {
        case "1":
          event.preventDefault();
          applyLayoutMode("split");
          break;
        case "2":
          event.preventDefault();
          applyLayoutMode("focus_chat");
          break;
        case "3":
          event.preventDefault();
          applyLayoutMode("focus_work");
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applyLayoutMode, controlCenterMode, spaceMode]);

  const activeAppId =
    agentView.type === "app"
      ? agentView.appId
      : spaceDisplayView.type === "app"
        ? spaceDisplayView.appId
        : null;
  const activeApp = getWorkspaceAppDefinition(activeAppId, installedApps);
  const hasWorkspaces = workspaces.length > 0;
  const hasSelectedWorkspace = Boolean(selectedWorkspace);

  const visibleSpacePaneIds =
    hasWorkspaces && spaceMode
      ? FIXED_SPACE_ORDER.filter((paneId) => spaceVisibility[paneId])
      : [];
  const flexSpacePaneId = visibleSpacePaneIds.includes("agent")
    ? "agent"
    : (visibleSpacePaneIds[visibleSpacePaneIds.length - 1] ?? null);
  const shouldShowAppUpdateReminder = Boolean(
    effectiveAppUpdateStatus && effectiveAppUpdateStatus.downloaded,
  );
  const shouldSuspendBrowserNativeView =
    workspaceSwitcherOpen ||
    // `Rendered` (not `Open`) — keeps the webview detached until the
    // exit animation finishes; otherwise the webview re-attaches behind
    // the still-animating panel and the user sees a layout shudder.
    settingsDialogRendered ||
    taskProposalDetailsDialogOpen ||
    chatImagePreviewOpen ||
    workspaceAppsDialogOpen ||
    createWorkspacePanelOpen ||
    publishOpen ||
    effectiveSpaceWorkspacePanelCollapsed ||
    // BrowserView paints natively above renderer DOM, so toasts anchored
    // top-right would be hidden behind it. Detach while any toast is up.
    effectiveToastNotifications.length > 0 ||
    // Same reason — inbox / account / layout popovers anchored to the
    // top bar would render behind the BrowserView otherwise.
    topBarPopoverOpen;
  const runtimeStartupBlockedDetail = runtimeStartupBlockedMessage(
    runtimeStatus,
    workspaceBlockingReason || workspaceErrorMessage,
  );
  const bootstrapErrorMessage = !hasHydratedWorkspaceList
    ? runtimeStartupBlockedMessage(runtimeStatus, workspaceErrorMessage)
    : "";
  const hydratedRuntimeErrorMessage =
    hasHydratedWorkspaceList &&
    runtimeStartupBlockedDetail &&
    (!hasWorkspaces || !workspaceAppsReady)
      ? runtimeStartupBlockedDetail
      : "";
  const desktopPlatform = window.electronAPI?.platform ?? null;
  const hasIntegratedTitleBar =
    desktopPlatform === "darwin" || desktopPlatform === "win32";
  const titleBarContainerClassName =
    desktopPlatform === "win32"
      ? "relative min-w-0 -mx-2 -mt-1 sm:-mx-3 sm:-mt-1.5"
      : "relative min-w-0";
  const mainGridClassName = appShellMainGridClassName({
    hasWorkspaces,
    hasIntegratedTitleBar,
  });
  const showOnboardingTakeover =
    hasHydratedWorkspaceList &&
    hasWorkspaces &&
    hasSelectedWorkspace &&
    onboardingModeActive &&
    spaceMode;

  const agentContent = useMemo(() => {
    if (!hasSelectedWorkspace) {
      return <EmptyWorkspacePane />;
    }

    if (agentView.type === "automations") {
      return (
        <section className="flex h-full min-h-0 min-w-0 animate-in fade-in-0 slide-in-from-right-3 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm duration-200 ease-out">
          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
                <Clock3 size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">Automations</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleReturnToChatPane}
                aria-label="Return to chat"
              >
                <ArrowLeft size={15} />
              </Button>
            </div>
          </div>
          <div
            className={`mx-auto w-full ${CHAT_LAYOUT.contentMaxWidth} min-h-0 flex-1 overflow-hidden`}
          >
            <AutomationsPane
              workspaceId={selectedWorkspaceId}
              composerModel={currentComposerSelectedModel(runtimeConfig)}
              emptyWorkspaceMessage="Choose a workspace from the top bar to view and manage automations."
              onOpenRunSession={(sessionId) =>
                handleOpenAutomationRunSession(sessionId, selectedWorkspaceId)
              }
              onRunNow={handleReturnToChatPane}
              onCreateSchedule={() =>
                handleCreateScheduleInChat(selectedWorkspaceId)
              }
              onEditSchedule={(job) =>
                handleEditScheduleInChat(job, selectedWorkspaceId)
              }
            />
          </div>
        </section>
      );
    }

    if (agentView.type === "inbox") {
      return (
        <section className="flex h-full min-h-0 min-w-0 animate-in fade-in-0 slide-in-from-right-3 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm duration-200 ease-out">
          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
                <Inbox size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">Inbox</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleReturnToChatPane}
                aria-label="Return to chat"
              >
                <ArrowLeft size={15} />
              </Button>
            </div>
          </div>
          <div
            className={`mx-auto w-full ${CHAT_LAYOUT.contentMaxWidth} min-h-0 flex-1 overflow-hidden`}
          >
            <OperationsInboxPane
              proposals={taskProposals}
              isLoadingProposals={isLoadingTaskProposals}
              proposalStatusMessage={taskProposalStatusMessage}
              proposalAction={proposalAction}
              onAcceptProposal={acceptTaskProposal}
              onDismissProposal={dismissTaskProposal}
              onProposalDetailsOpenChange={setTaskProposalDetailsDialogOpen}
              hasWorkspace={hasSelectedWorkspace}
            />
          </div>
        </section>
      );
    }

    if (agentView.type === "sessions") {
      return (
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm">
          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
                <MessageCircle size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">Sessions</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleReturnToChatPane}
                aria-label="Return to chat"
              >
                <ArrowLeft size={15} />
              </Button>
            </div>
          </div>
          <div
            className={`mx-auto w-full ${CHAT_LAYOUT.contentMaxWidth} min-h-0 flex-1 overflow-hidden`}
          >
            <SubagentSessionsPane
              workspaceId={selectedWorkspaceId}
              variant="full"
              onOpenSession={(session) =>
                handleOpenRunningSession(session.session_id)
              }
            />
          </div>
        </section>
      );
    }

    if (agentView.type === "artifacts") {
      return (
        <section className="flex h-full min-h-0 min-w-0 animate-in fade-in-0 slide-in-from-right-3 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm duration-200 ease-out">
          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
                <Boxes size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">Artifacts</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleReturnToChatPane}
                aria-label="Return to chat"
              >
                <ArrowLeft size={15} />
              </Button>
            </div>
          </div>
          <div
            className={`mx-auto w-full ${CHAT_LAYOUT.contentMaxWidth} min-h-0 flex-1 overflow-hidden`}
          >
            <ArtifactsPane
              workspaceId={selectedWorkspaceId}
              onOpenOutput={(output) => handleOpenWorkspaceOutput(output)}
            />
          </div>
        </section>
      );
    }

    if (agentView.type === "chat") {
      if (selectedWorkspace && selectedWorkspace.folder_state === "missing") {
        return (
          <MissingWorkspacePane
            workspaceName={selectedWorkspace.name}
            workspacePath={selectedWorkspace.workspace_path ?? null}
            onRelocate={() =>
              chooseWorkspaceRelocationFolder(selectedWorkspace.id)
            }
            onDeleteRecord={async () => {
              await deleteWorkspace(selectedWorkspace.id);
            }}
          />
        );
      }
      return onboardingModeActive ? (
        <WorkspaceOnboardingSurface
          onOpenOutput={handleOpenWorkspaceOutput}
          onSyncFileDisplayFromAgentOperation={
            handleSyncAgentOperationFileDisplay
          }
          onImageAttachmentPreviewOpenChange={setChatImagePreviewOpen}
          focusRequestKey={chatFocusRequestKey}
        />
      ) : (
        <ChatPane
          onOpenOutput={handleOpenWorkspaceOutput}
          onSyncFileDisplayFromAgentOperation={
            handleSyncAgentOperationFileDisplay
          }
          onImageAttachmentPreviewOpenChange={setChatImagePreviewOpen}
          focusRequestKey={chatFocusRequestKey}
          onOpenLinkInBrowser={handleOpenLinkInAppBrowser}
          onOpenLocalLink={handleOpenLocalLinkInFiles}
          sessionJumpSessionId={chatSessionJumpRequest?.sessionId ?? null}
          sessionJumpRequestKey={chatSessionJumpRequest?.requestKey ?? 0}
          sessionOpenRequest={chatSessionOpenRequest}
          onSessionOpenRequestConsumed={handleChatSessionOpenRequestConsumed}
          composerPrefillRequest={chatComposerPrefillRequest}
          onComposerPrefillConsumed={handleChatComposerPrefillConsumed}
          explorerAttachmentRequest={chatExplorerAttachmentRequest}
          onExplorerAttachmentRequestConsumed={
            handleChatExplorerAttachmentRequestConsumed
          }
          onActiveSessionIdChange={setActiveChatSessionId}
          browserJumpRequest={activeChatBrowserJumpRequest}
          onBrowserJumpRequestConsumed={consumeChatBrowserJumpRequest}
          onJumpToSessionBrowser={handleJumpToSessionBrowser}
          onOpenSessions={handleOpenSessionsPane}
          onOpenMeetingMode={handleOpenMeetingMode}
          meetingModeBusy={isStartingMeetingMode}
          meetingModeError={meetingModeError}
          onOpenInbox={handleOpenInboxPane}
          inboxUnreadCount={unreadTaskProposalCount}
          onOpenAutomations={handleOpenAutomationsPane}
          onOpenArtifacts={handleOpenArtifactsPane}
          composerDraftText={
            selectedWorkspaceId
              ? (chatComposerDraftTextByWorkspace[selectedWorkspaceId] ?? "")
              : ""
          }
          onComposerDraftTextChange={handleChatComposerDraftTextChange}
          scheduleEditContext={chatScheduleEditContext}
          onScheduleEditContextDismiss={() => setChatScheduleEditContext(null)}
          isPaneAnimating={isSpacePaneAnimating}
        />
      );
    }

    if (agentView.type === "app") {
      return (
        <div className="flex h-full min-h-0 min-w-0 animate-in fade-in-0 slide-in-from-right-3 flex-col duration-200 ease-out">
          <AppSurfacePane
            key={agentView.appId}
            appId={agentView.appId}
            app={
              activeAppId === agentView.appId
                ? activeApp
                : getWorkspaceAppDefinition(agentView.appId, installedApps)
            }
            path={agentView.path}
            resourceId={agentView.resourceId}
            view={agentView.view}
          />
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 min-w-0 animate-in fade-in-0 slide-in-from-right-3 flex-col duration-200 ease-out">
        <InternalSurfacePane
          surface={agentView.surface}
          resourceId={agentView.resourceId}
          htmlContent={agentView.htmlContent}
          onResourceMissing={handleMissingInternalResource}
          onOpenLinkInBrowser={handleOpenLinkInNewAppBrowserTab}
          onOpenLocalLink={handleSyncAgentOperationFileDisplay}
        />
      </div>
    );
  }, [
    activeApp,
    activeAppId,
    agentView,
    chatFocusRequestKey,
    activeChatBrowserJumpRequest,
    chatImagePreviewOpen,
    chatComposerDraftTextByWorkspace,
    chatSessionJumpRequest,
    chatSessionOpenRequest,
    chatComposerPrefillRequest,
    chatExplorerAttachmentRequest,
    consumeChatBrowserJumpRequest,
    handleChatComposerDraftTextChange,
    handleChatComposerPrefillConsumed,
    handleJumpToSessionBrowser,
    handleMissingInternalResource,
    handleOpenInboxPane,
    handleOpenSessionsPane,
    handleOpenMeetingMode,
    handleOpenAutomationsPane,
    handleOpenArtifactsPane,
    handleOpenAutomationRunSession,
    handleCreateScheduleInChat,
    handleEditScheduleInChat,
    handleReturnToChatPane,
    handleCreateSession,
    handleOpenLinkInNewAppBrowserTab,
    handleOpenLinkInAppBrowser,
    handleOpenLocalLinkInFiles,
    handleSyncAgentOperationFileDisplay,
    handleOpenWorkspaceOutput,
    hasSelectedWorkspace,
    isLoadingTaskProposals,
    isStartingMeetingMode,
    proposalAction,
    meetingModeError,
    selectedWorkspace?.name,
    selectedWorkspace?.folder_state,
    selectedWorkspace?.workspace_path,
    selectedWorkspace?.id,
    selectedWorkspaceId,
    taskProposalStatusMessage,
    taskProposals,
    unreadTaskProposalCount,
    acceptTaskProposal,
    dismissTaskProposal,
    onboardingModeActive,
    chooseWorkspaceRelocationFolder,
    deleteWorkspace,
    isSpacePaneAnimating,
  ]);

  const spaceDisplayLayoutSyncKey = `${spaceExplorerMode}:${spaceBrowserSpace}:${filesPaneWidth}:${spaceAgentPaneWidth}:${spaceBrowserFullscreen ? "fs" : "split"}`;
  const spaceDisplayContent = useMemo(() => {
    if (!hasSelectedWorkspace) {
      return <EmptyWorkspacePane />;
    }

    if (spaceDisplayView.type === "browser") {
      return (
        <SpaceBrowserDisplayPane
          browserSpace={spaceBrowserSpace}
          suspendNativeView={shouldSuspendBrowserNativeView}
          layoutSyncKey={spaceDisplayLayoutSyncKey}
          embedded
          fullscreen={spaceBrowserFullscreen}
        />
      );
    }

    if (spaceDisplayView.type === "app") {
      return (
        <div className="h-full min-h-0 p-3">
          <AppSurfacePane
            key={spaceDisplayView.appId}
            appId={spaceDisplayView.appId}
            app={
              activeAppId === spaceDisplayView.appId
                ? activeApp
                : getWorkspaceAppDefinition(
                    spaceDisplayView.appId,
                    installedApps,
                  )
            }
            path={spaceDisplayView.path}
            resourceId={spaceDisplayView.resourceId}
            view={spaceDisplayView.view}
          />
        </div>
      );
    }

    if (spaceDisplayView.type === "internal") {
      return (
        <div className="h-full min-h-0 p-3">
          <InternalSurfacePane
            surface={spaceDisplayView.surface}
            resourceId={spaceDisplayView.resourceId}
            htmlContent={spaceDisplayView.htmlContent}
            onResourceMissing={handleMissingInternalResource}
            onOpenLinkInBrowser={handleOpenLinkInNewAppBrowserTab}
            onOpenLocalLink={handleSyncAgentOperationFileDisplay}
          />
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 p-3">
        <FocusPlaceholder
          eyebrow="Display"
          title="Universal display"
          description="Select a file from the explorer or switch into browser mode to project tabs and bookmarks here."
        />
      </div>
    );
  }, [
    activeApp,
    activeAppId,
    handleMissingInternalResource,
    handleOpenLinkInNewAppBrowserTab,
    hasSelectedWorkspace,
    installedApps,
    shouldSuspendBrowserNativeView,
    spaceAgentPaneWidth,
    spaceBrowserFullscreen,
    spaceBrowserSpace,
    spaceDisplayLayoutSyncKey,
    spaceDisplayView,
    spaceExplorerMode,
    toggleSpaceBrowserFullscreen,
  ]);

  const spacePanes = useMemo(
    () =>
      visibleSpacePaneIds.map((paneId) => ({
        id: paneId,
        flex: paneId === flexSpacePaneId,
        width:
          paneId === "files"
            ? filesPaneWidth
            : paneId === "browser"
              ? browserPaneWidth
              : 0,
        content:
          paneId === "agent" ? (
            agentContent
          ) : paneId === "files" ? (
            <FileExplorerPane
              key={selectedWorkspaceId ?? "no-workspace"}
              focusRequest={fileExplorerFocusRequest}
              onFocusRequestConsumed={(requestKey) => {
                setFileExplorerFocusRequest((current) =>
                  current?.requestKey === requestKey ? null : current,
                );
              }}
              onReferenceInChat={handleReferenceWorkspacePathInChat}
              onDeleteEntry={handleDeleteWorkspaceEntry}
              onOpenLinkInBrowser={handleOpenLinkInNewAppBrowserTab}
              onOpenLocalLink={handleSyncAgentOperationFileDisplay}
            />
          ) : (
            <BrowserPane
              suspendNativeView={shouldSuspendBrowserNativeView}
              layoutSyncKey={`${visibleSpacePaneIds.join("|")}:${filesPaneWidth}:${browserPaneWidth}`}
            />
          ),
      })),
    [
      agentContent,
      browserPaneWidth,
      fileExplorerFocusRequest,
      filesPaneWidth,
      flexSpacePaneId,
      handleDeleteWorkspaceEntry,
      handleReferenceWorkspacePathInChat,
      handleOpenLinkInNewAppBrowserTab,
      shouldSuspendBrowserNativeView,
      visibleSpacePaneIds,
    ],
  );

  const clampExplorerPanelWidth = useCallback((width: number) => {
    return Math.max(
      MIN_EXPLORER_PANEL_WIDTH,
      Math.min(width, MAX_EXPLORER_PANEL_WIDTH),
    );
  }, []);

  const clampSpaceAgentPaneWidth = useCallback(
    (width: number) => {
      const hostWidth =
        utilityPaneHostRef.current?.getBoundingClientRect().width ?? 0;
      const explorerWidth = SPACE_EXPLORER_RAIL_WIDTH + filesPaneWidth;
      const maxWidth =
        hostWidth > 0
          ? Math.min(
              MAX_UTILITY_PANE_WIDTH,
              Math.max(
                MIN_AGENT_CONTENT_WIDTH,
                hostWidth -
                  explorerWidth -
                  SPACE_DISPLAY_MIN_WIDTH -
                  UTILITY_PANE_RESIZER_WIDTH,
              ),
            )
          : MAX_UTILITY_PANE_WIDTH;
      return Math.max(MIN_AGENT_CONTENT_WIDTH, Math.min(width, maxWidth));
    },
    [filesPaneWidth],
  );

  const hasVisibleSpacePanes = visibleSpacePaneIds.length > 0;
  useEffect(() => {
    if (!spaceMode) {
      return;
    }

    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const measuredHostWidth = Math.round(
        utilityPaneHostRef.current?.getBoundingClientRect().width ?? 0,
      );
      setSpaceLayoutHostWidth((prev) =>
        prev === measuredHostWidth ? prev : measuredHostWidth,
      );
      setSpaceAgentPaneWidth((current) => clampSpaceAgentPaneWidth(current));
      if (hasVisibleSpacePanes) {
        syncUtilityPaneWidths();
      }
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(flush);
    };

    flush();
    window.addEventListener("resize", schedule);

    const host = utilityPaneHostRef.current;
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    if (observer && host) {
      observer.observe(host);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [
    clampSpaceAgentPaneWidth,
    hasVisibleSpacePanes,
    spaceMode,
    syncUtilityPaneWidths,
  ]);

  // Synchronous initial measurement so the first paint after spaceMode
  // mounts already has the correct pixel widths — without this the panes
  // would flash through a width:0 layout before the ResizeObserver fires.
  useLayoutEffect(() => {
    if (!spaceMode) return;
    const host = utilityPaneHostRef.current;
    if (!host) return;
    const width = Math.round(host.getBoundingClientRect().width);
    setSpaceLayoutHostWidth((prev) => (prev === width ? prev : width));
  }, [spaceMode]);

  // Skip the initial mount — there's no transition to mask there.
  // The state itself is declared earlier (alongside spaceLayoutHostWidth)
  // so the agentContent useMemo can pass it down to ChatPane.
  const spacePaneAnimatingFirstRunRef = useRef(true);
  useEffect(() => {
    if (spacePaneAnimatingFirstRunRef.current) {
      spacePaneAnimatingFirstRunRef.current = false;
      return;
    }
    setIsSpacePaneAnimating(true);
    // 230ms = the 200ms width transition + a small grace window so the
    // freeze releases after the browser has settled the final layout.
    const timer = window.setTimeout(() => {
      setIsSpacePaneAnimating(false);
    }, 230);
    return () => window.clearTimeout(timer);
  }, [effectiveSpaceWorkspacePanelCollapsed, spaceBrowserFullscreen]);

  // Width of the resize handle in the space layout row (matches the
  // `w-2` class on the separator div below).
  const SPACE_DISPLAY_HANDLE_WIDTH = 8;
  // Sum of the explorer rail + the handle slot. Both stay constant
  // through the collapse/expand transition, so the display and agent
  // panes share `hostWidth - reserved` between them.
  const spaceLayoutReservedWidth =
    SPACE_EXPLORER_RAIL_WIDTH + SPACE_DISPLAY_HANDLE_WIDTH;
  // Pixel widths for the display and agent panes. Computing them as
  // explicit values (instead of toggling `flex-1` ↔ `width:Xpx`) lets
  // the browser interpolate width smoothly — the root cause fix for
  // the choppy collapse/expand animation.
  const spaceLayoutDerivedWidths = useMemo(() => {
    const host = spaceLayoutHostWidth;
    if (host <= 0) {
      return null;
    }
    const remaining = Math.max(0, host - spaceLayoutReservedWidth);
    if (spaceBrowserFullscreen) {
      return { displayWidth: remaining, agentWidth: 0 };
    }
    if (effectiveSpaceWorkspacePanelCollapsed) {
      return { displayWidth: 0, agentWidth: remaining };
    }
    const agentWidth = Math.max(
      MIN_AGENT_CONTENT_WIDTH,
      Math.min(spaceAgentPaneWidth, remaining - SPACE_DISPLAY_MIN_WIDTH),
    );
    return {
      displayWidth: Math.max(0, remaining - agentWidth),
      agentWidth,
    };
  }, [
    effectiveSpaceWorkspacePanelCollapsed,
    spaceAgentPaneWidth,
    spaceBrowserFullscreen,
    spaceLayoutHostWidth,
    spaceLayoutReservedWidth,
  ]);

  const startSpaceDisplayResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      spaceDisplayResizeStateRef.current = {
        startWidth: spaceAgentPaneWidth,
        startX: event.clientX,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // BrowserView resizing falls back to the window listeners below.
      }
      setIsUtilityPaneResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
    },
    [spaceAgentPaneWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = spaceDisplayResizeStateRef.current;
      if (!resizeState) {
        return;
      }

      setSpaceAgentPaneWidth(
        clampSpaceAgentPaneWidth(
          resizeState.startWidth - (event.clientX - resizeState.startX),
        ),
      );
    };

    const stopResize = () => {
      if (!spaceDisplayResizeStateRef.current) {
        return;
      }

      spaceDisplayResizeStateRef.current = null;
      setIsUtilityPaneResizing(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, [clampSpaceAgentPaneWidth]);

  const beginExplorerDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, startWidth: number) => {
      // Stage the drag without mutating layout yet. We commit to dragging
      // only after the pointer moves past EXPLORER_DRAG_ACTIVATION_DELTA so
      // a bare click on the handle is a true no-op.
      explorerRevealDragStateRef.current = {
        startX: event.clientX,
        startWidth,
        activated: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // BrowserView resizing falls back to the window listeners below.
      }
      event.preventDefault();
    },
    [],
  );

  const startExplorerRevealDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      beginExplorerDrag(event, 0);
    },
    [beginExplorerDrag],
  );

  const startExplorerPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      beginExplorerDrag(event, filesPaneWidth);
    },
    [beginExplorerDrag, filesPaneWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = explorerRevealDragStateRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      if (
        !state.activated &&
        Math.abs(delta) < EXPLORER_DRAG_ACTIVATION_DELTA
      ) {
        return;
      }
      if (!state.activated) {
        state.activated = true;
        setIsUtilityPaneResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        if (state.startWidth === 0) {
          setSpaceWorkspacePanelCollapsed(false);
        }
      }
      const minWidth =
        state.startWidth === 0 ? 0 : MIN_EXPLORER_PANEL_WIDTH;
      setExplorerRevealDragWidth(
        Math.max(
          minWidth,
          Math.min(MAX_EXPLORER_PANEL_WIDTH, state.startWidth + delta),
        ),
      );
    };

    const stopDrag = () => {
      const state = explorerRevealDragStateRef.current;
      if (!state) return;
      explorerRevealDragStateRef.current = null;
      // Bare click — never activated. Leave layout untouched.
      if (!state.activated) {
        return;
      }
      setIsUtilityPaneResizing(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      const isRevealDrag = state.startWidth === 0;
      setExplorerRevealDragWidth((current) => {
        if (current === null) return null;
        if (isRevealDrag) {
          if (current < EXPLORER_REVEAL_SNAP_THRESHOLD) {
            setSpaceWorkspacePanelCollapsed(true);
          } else {
            setFilesPaneWidth(clampExplorerPanelWidth(current));
            setSpaceWorkspacePanelCollapsed(false);
          }
        } else {
          setFilesPaneWidth(clampExplorerPanelWidth(current));
        }
        return null;
      });
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [clampExplorerPanelWidth]);

  const startUtilityPaneResize = useCallback(
    (
      leftPaneId: SpaceComponentId,
      rightPaneId: SpaceComponentId,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (leftPaneId !== "agent" && rightPaneId !== "agent") {
        if (!spaceVisibility[leftPaneId] || !spaceVisibility[rightPaneId]) {
          return;
        }
        utilityPaneResizeStateRef.current = {
          mode: "pair",
          leftPaneId,
          rightPaneId,
          startLeftWidth:
            leftPaneId === "files" ? filesPaneWidth : browserPaneWidth,
          startRightWidth:
            rightPaneId === "files" ? filesPaneWidth : browserPaneWidth,
          startX: event.clientX,
        };
      } else {
        const paneId = leftPaneId === "agent" ? rightPaneId : leftPaneId;
        if (paneId === "agent" || !spaceVisibility[paneId]) {
          return;
        }
        utilityPaneResizeStateRef.current = {
          mode: "single",
          paneId,
          startWidth: paneId === "files" ? filesPaneWidth : browserPaneWidth,
          startX: event.clientX,
          direction: leftPaneId === "agent" ? -1 : 1,
        };
      }

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // BrowserView resizing falls back to the window listeners below.
      }
      setIsUtilityPaneResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
    },
    [browserPaneWidth, filesPaneWidth, spaceVisibility],
  );


  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = utilityPaneResizeStateRef.current;
      if (!resizeState) {
        return;
      }

      if (resizeState.mode === "pair") {
        const delta = event.clientX - resizeState.startX;
        const { leftWidth, rightWidth } = clampPairedUtilityPaneWidths(
          resizeState.leftPaneId,
          resizeState.rightPaneId,
          resizeState.startLeftWidth + delta,
          resizeState.startRightWidth - delta,
        );
        if (resizeState.leftPaneId === "files") {
          setFilesPaneWidth(leftWidth);
        } else {
          setBrowserPaneWidth(leftWidth);
        }
        if (resizeState.rightPaneId === "files") {
          setFilesPaneWidth(rightWidth);
        } else {
          setBrowserPaneWidth(rightWidth);
        }
        return;
      }

      const nextWidth = clampUtilityPaneWidth(
        resizeState.paneId,
        resizeState.startWidth +
          resizeState.direction * (event.clientX - resizeState.startX),
      );
      if (resizeState.paneId === "files") {
        setFilesPaneWidth(nextWidth);
      } else {
        setBrowserPaneWidth(nextWidth);
      }
    };

    const stopResize = () => {
      if (!utilityPaneResizeStateRef.current) {
        return;
      }

      utilityPaneResizeStateRef.current = null;
      setIsUtilityPaneResizing(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, [clampPairedUtilityPaneWidths, clampUtilityPaneWidth]);

  return (
    <StoplightProvider value={hasIntegratedTitleBar}>
      <main
        data-container="shell"
        className="fixed inset-0 h-screen overflow-hidden text-foreground"
      >
      <div className="pointer-events-none absolute inset-0 bg-noise-grid bg-[size:22px_22px] opacity-[0.04]" />
      <div className="theme-orb-primary pointer-events-none absolute -left-32 -top-32 h-80 w-80 rounded-full blur-3xl" />
      <div className="theme-orb-secondary pointer-events-none absolute -bottom-40 right-12 h-96 w-96 rounded-full blur-3xl" />

      <div className={mainGridClassName}>
        {isUtilityPaneResizing ? (
          <div className="absolute inset-0 z-30 cursor-col-resize" />
        ) : null}
        <NotificationToastStack
          leadingToast={
            shouldShowAppUpdateReminder && effectiveAppUpdateStatus ? (
              <UpdateReminder
                status={effectiveAppUpdateStatus}
                onDismiss={handleDismissUpdate}
                onInstallNow={handleInstallUpdate}
                onOpenChangelog={handleOpenUpdateChangelog}
              />
            ) : null
          }
          notifications={effectiveToastNotifications}
          onCloseToast={(notificationId) => {
            void handleCloseDisplayedNotification(notificationId);
          }}
          onActivateNotification={(notificationId) => {
            void handleActivateDisplayedNotification(notificationId);
          }}
        />

        {hasWorkspaces ? (
          <div className={titleBarContainerClassName}>
            <TopTabsBar
              integratedTitleBar={hasIntegratedTitleBar}
              desktopPlatform={desktopPlatform}
              runtimeStatus={runtimeStatus}
              controlCenterActive={controlCenterMode}
              inboxNotifications={inboxNotifications}
              inboxWorkspacesById={inboxWorkspacesById}
              onActivateInboxNotification={(id) =>
                void handleActivateDisplayedNotification(id)
              }
              onDismissInboxNotification={(id) =>
                void handleCloseDisplayedNotification(id)
              }
              onMarkAllInboxNotificationsRead={() =>
                void handleMarkAllInboxNotificationsRead()
              }
              onOpenControlCenter={handleOpenControlCenter}
              onWorkspaceSwitcherVisibilityChange={setWorkspaceSwitcherOpen}
              onTopBarPopoverOpenChange={setTopBarPopoverOpen}
              onOpenWorkspaceCreatePanel={handleOpenCreateWorkspacePanel}
              onOpenSettings={() => {
                setSettingsDialogSection("settings");
                setSettingsDialogOpen(true);
              }}
              onOpenAccount={() => {
                setSettingsDialogSection("account");
                setSettingsDialogOpen(true);
              }}
              onOpenBilling={() => {
                setSettingsDialogSection("billing");
                setSettingsDialogOpen(true);
              }}
              onOpenExternalUrl={handleOpenExternalUrl}
              onPublish={() => setPublishOpen(true)}
              showLayoutPicker={spaceMode && !controlCenterMode}
              layoutMode={
                spaceBrowserFullscreen
                  ? "focus_work"
                  : effectiveSpaceWorkspacePanelCollapsed
                    ? "focus_chat"
                    : "split"
              }
              onLayoutModeChange={applyLayoutMode}
            />
          </div>
        ) : null}

        {!hasHydratedWorkspaceList ? (
          bootstrapErrorMessage ? (
            <WorkspaceStartupErrorPane message={bootstrapErrorMessage} />
          ) : (
            <BootSplash />
          )
        ) : hydratedRuntimeErrorMessage ? (
          <WorkspaceStartupErrorPane message={hydratedRuntimeErrorMessage} />
        ) : !hasWorkspaces ? (
          <FirstWorkspacePane />
        ) : showOnboardingTakeover ? (
          <WorkspaceOnboardingTakeover
            onOpenOutput={handleOpenWorkspaceOutput}
            onSyncFileDisplayFromAgentOperation={
              handleSyncAgentOperationFileDisplay
            }
            onImageAttachmentPreviewOpenChange={setChatImagePreviewOpen}
            focusRequestKey={chatFocusRequestKey}
          />
        ) : controlCenterMode ? (
          <WorkspaceControlCenter
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            cardsPerRow={controlCenterCardsPerRow}
            orderedWorkspaceIds={controlCenterWorkspaceCardOrder}
            highlightedWorkspaceIds={controlCenterHighlightedWorkspaceIds}
            cardSignals={controlCenterCardSignals}
            onOpenWorkspaceRunningTasks={handleOpenWorkspaceRunningTasks}
            onOpenWorkspaceAppsExplorer={handleOpenWorkspaceAppsExplorer}
            onSelectWorkspace={handleSelectControlCenterWorkspace}
            onEnterWorkspace={handleEnterWorkspace}
            onOpenOutput={handleOpenControlCenterWorkspaceOutput}
            onWorkspaceOrderChange={handleControlCenterWorkspaceOrderChange}
            onVisibleWorkspaceIdsChange={
              handleControlCenterVisibleWorkspaceIdsChange
            }
            onCardComposerSubmit={
              handleMarkControlCenterWorkspaceComposerSubmission
            }
            onWorkspaceCompletion={handleControlCenterWorkspaceCompletion}
            onCreateWorkspace={handleOpenCreateWorkspacePanel}
          />
        ) : (
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              {spaceMode ? (
                <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
                  <div
                    ref={utilityPaneHostRef}
                    className="flex min-h-0 min-w-0 flex-1 items-stretch p-0.5"
                  >
                    <section
                      id="space-workspace-panel"
                      className={cn(
                        "flex min-h-0 min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-md backdrop-blur-sm",
                        effectiveSpaceWorkspacePanelCollapsed &&
                          explorerRevealDragWidth === null
                          ? "flex-none"
                          : "flex-1 basis-0",
                        !isUtilityPaneResizing &&
                          explorerRevealDragWidth === null &&
                          "transition-[flex-grow,flex-basis] duration-200 ease-out",
                      )}
                    >
                      <div
                        className="relative shrink-0 border-r border-border bg-card"
                        style={{
                          width: `${SPACE_EXPLORER_RAIL_WIDTH}px`,
                        }}
                      >
                        {effectiveSpaceWorkspacePanelCollapsed &&
                        explorerRevealDragWidth === null ? (
                          <div
                            role="separator"
                            aria-label="Drag to reveal explorer panel"
                            aria-orientation="vertical"
                            onPointerDown={startExplorerRevealDrag}
                            onDoubleClick={() => {
                              setSpaceWorkspacePanelCollapsed(false);
                            }}
                            className="group absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center"
                          >
                            <div className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/8 opacity-0 transition duration-150 group-hover:opacity-100" />
                          </div>
                        ) : null}
                        <nav
                          aria-label="Space explorer mode"
                          className="flex h-full min-h-0 flex-col items-center gap-1 px-1.5 py-2"
                        >
                          {(
                            [
                              {
                                value: "files",
                                label: "Files",
                                icon: Folder,
                              },
                              {
                                value: "browser",
                                label: "Browser",
                                icon: Globe,
                              },
                              {
                                value: "applications",
                                label: "Apps",
                                icon: LayoutGrid,
                              },
                            ] as const
                          ).map(({ value, label, icon: Icon }) => {
                            const isActive = spaceExplorerMode === value;
                            return (
                              <Tooltip key={value}>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => {
                                        setSpaceExplorerMode(value);
                                        if (value === "browser") {
                                          setSpaceDisplayView({
                                            type: "browser",
                                          });
                                        } else if (value === "applications") {
                                          restoreLastSpaceAppDisplayView();
                                        } else {
                                          restoreLastSpaceFileDisplayView();
                                        }
                                        setSpaceWorkspacePanelCollapsed(false);
                                      }}
                                      aria-label={`Open ${label.toLowerCase()} explorer`}
                                      aria-pressed={isActive}
                                      aria-controls="space-explorer-panel"
                                      title={label}
                                      className={
                                        isActive
                                          ? "bg-muted text-foreground"
                                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                                      }
                                    >
                                      <Icon />
                                    </Button>
                                  }
                                />
                                <TooltipContent
                                  side="right"
                                  align="center"
                                  className="py-1"
                                >
                                  {label}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })}
                        </nav>
                      </div>

                      <div
                        className={cn(
                          "relative shrink-0 [overflow:clip] [contain:layout_paint] [will-change:width]",
                          explorerRevealDragWidth === null &&
                            "transition-[width] duration-200 ease-out",
                          effectiveSpaceWorkspacePanelCollapsed &&
                            explorerRevealDragWidth === null &&
                            "hidden",
                        )}
                        style={{
                          width:
                            explorerRevealDragWidth !== null
                              ? `${explorerRevealDragWidth}px`
                              : effectiveSpaceWorkspacePanelCollapsed
                                ? 0
                                : `${filesPaneWidth}px`,
                        }}
                      >
                        {effectiveSpaceWorkspacePanelCollapsed ||
                        explorerRevealDragWidth !== null ? null : (
                          <div
                            role="separator"
                            aria-label="Resize explorer panel"
                            aria-orientation="vertical"
                            onPointerDown={startExplorerPanelResize}
                            className="group absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center"
                          >
                            <div className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/8 opacity-0 transition duration-150 group-hover:opacity-100" />
                          </div>
                        )}
                        <div
                          id="space-explorer-panel"
                          style={{ width: `${filesPaneWidth}px` }}
                          className={`relative flex h-full min-h-0 flex-col overflow-hidden bg-card ${
                            effectiveSpaceWorkspacePanelCollapsed
                              ? ""
                              : "border-r border-border"
                          }`}
                        >
                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            <div
                              key={spaceExplorerMode}
                              className={`flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-200 ease-out ${spaceExplorerSlideInClass}`}
                            >
                              {spaceExplorerMode === "files" ? (
                                <FileExplorerPane
                                  key={selectedWorkspaceId ?? "no-workspace"}
                                  focusRequest={fileExplorerFocusRequest}
                                  onFocusRequestConsumed={(requestKey) => {
                                    setFileExplorerFocusRequest((current) =>
                                      current?.requestKey === requestKey
                                        ? null
                                        : current,
                                    );
                                  }}
                                  onReferenceInChat={
                                    handleReferenceWorkspacePathInChat
                                  }
                                  onDeleteEntry={handleDeleteWorkspaceEntry}
                                  onOpenLinkInBrowser={
                                    handleOpenLinkInNewAppBrowserTab
                                  }
                                  onOpenLocalLink={
                                    handleSyncAgentOperationFileDisplay
                                  }
                                  previewInPane={false}
                                  embedded
                                  onFileOpen={(path) => {
                                    setSpaceDisplayView({
                                      type: "internal",
                                      surface: "file",
                                      resourceId: path,
                                    });
                                    setSpaceWorkspacePanelCollapsed(false);
                                  }}
                                />
                              ) : spaceExplorerMode === "applications" ? (
                                <SpaceApplicationsExplorerPane
                                  installedApps={installedApps}
                                  activeAppId={
                                    spaceDisplayView.type === "app"
                                      ? spaceDisplayView.appId
                                      : null
                                  }
                                  onAddApp={handleAddApp}
                                  onSelectApp={(appId) =>
                                    handleOpenSpaceApp(appId)
                                  }
                                />
                              ) : spaceExplorerMode === "browser" ? (
                                <SpaceBrowserExplorerPane
                                  browserSpace={spaceBrowserSpace}
                                  onBrowserSpaceChange={(space) => {
                                    setSpaceBrowserSpace(space);
                                    setSpaceDisplayView({
                                      type: "browser",
                                    });
                                    setSpaceWorkspacePanelCollapsed(false);
                                  }}
                                  onActivateDisplay={() => {
                                    setSpaceDisplayView({ type: "browser" });
                                    setSpaceWorkspacePanelCollapsed(false);
                                  }}
                                  hasPendingAgentJump={hasPendingAgentJump}
                                />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div
                        className={cn(
                          "min-h-0 min-w-0 flex-1 overflow-hidden",
                          effectiveSpaceWorkspacePanelCollapsed &&
                            explorerRevealDragWidth === null &&
                            "hidden",
                        )}
                      >
                        {spaceDisplayContent}
                      </div>
                    </section>

                    {!spaceBrowserFullscreen ? (
                      <div
                        role="separator"
                        aria-label="Resize display pane"
                        aria-orientation="vertical"
                        aria-hidden={effectiveSpaceWorkspacePanelCollapsed}
                        onPointerDown={
                          effectiveSpaceWorkspacePanelCollapsed
                            ? undefined
                            : startSpaceDisplayResize
                        }
                        className={`group relative z-10 flex w-2 shrink-0 items-center justify-center transition-opacity duration-200 ease-out ${
                          effectiveSpaceWorkspacePanelCollapsed
                            ? "pointer-events-none cursor-default opacity-0"
                            : "cursor-col-resize touch-none opacity-100"
                        }`}
                      >
                        <div className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/8 opacity-0 transition duration-150 group-hover:opacity-100" />
                      </div>
                    ) : null}

                    <div
                      className={cn(
                        "min-h-0 overflow-hidden rounded-xl [contain:layout_style]",
                        effectiveSpaceWorkspacePanelCollapsed &&
                          explorerRevealDragWidth === null
                          ? "min-w-0 flex-1 basis-0"
                          : "flex-none",
                        !isUtilityPaneResizing &&
                          explorerRevealDragWidth === null &&
                          "transition-[width,flex-grow,flex-basis] duration-200 ease-out",
                      )}
                      style={
                        effectiveSpaceWorkspacePanelCollapsed &&
                        explorerRevealDragWidth === null
                          ? undefined
                          : {
                              width: spaceLayoutDerivedWidths
                                ? `${spaceLayoutDerivedWidths.agentWidth}px`
                                : `${spaceAgentPaneWidth}px`,
                              minWidth: spaceBrowserFullscreen
                                ? 0
                                : `${MIN_AGENT_CONTENT_WIDTH}px`,
                            }
                      }
                      aria-hidden={spaceBrowserFullscreen}
                    >
                      {agentContent}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {createWorkspacePanelOpen ? (
        <FirstWorkspacePane
          variant="panel"
          onClose={handleCloseCreateWorkspacePanel}
        />
      ) : null}
      <WorkspaceAppsDialog
        open={workspaceAppsDialogOpen}
        onClose={() => setWorkspaceAppsDialogOpen(false)}
      />

      {/* Settings is a full-screen route now — covers the entire shell
          (TopTabsBar + workspace) when active. The previous modal Dialog
          mount used to sit here. SettingsScreenRoot owns its own scroll
          + nav rail; this wrapper just covers the surface so the
          background shell isn't visible behind it. */}
      {settingsDialogRendered ? (
        <div
          data-state={settingsDialogOpen ? "open" : "closed"}
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              !settingsDialogOpen
            ) {
              setSettingsDialogRendered(false);
            }
          }}
          className="absolute inset-0 z-40 overflow-hidden bg-background duration-200 ease-out data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-2 data-[state=open]:slide-in-from-bottom-2"
        >
          <SettingsScreenRoot
            activeSection={settingsDialogSection}
            appVersion={effectiveAppUpdateStatus?.currentVersion || ""}
            onSectionChange={(section) => {
              setSettingsDialogSection(section);
              if (section !== "submissions") {
                setSubmissionsFocusId(null);
              }
            }}
            onBackToApp={() => {
              setSettingsDialogOpen(false);
              setSubmissionsFocusId(null);
            }}
            colorScheme={colorScheme}
            onColorSchemeChange={handleColorSchemeChange}
            themeVariant={themeVariant}
            themeVariants={THEME_VARIANTS}
            onThemeVariantChange={handleThemeVariantChange}
            workspaceCardsPerRow={controlCenterCardsPerRow}
            onWorkspaceCardsPerRowChange={setControlCenterCardsPerRow}
            desktopNotificationsEnabled={desktopNotificationsEnabled}
            onDesktopNotificationsChange={handleDesktopNotificationsChange}
            onOpenExternalUrl={handleOpenExternalUrl}
            submissionsFocusId={submissionsFocusId}
          />
        </div>
      ) : null}
      {selectedWorkspaceId && (
        <PublishScreen
          onOpenChange={setPublishOpen}
          onViewSubmission={(submissionId) => {
            setSubmissionsFocusId(submissionId);
            setSettingsDialogSection("submissions");
            setSettingsDialogOpen(true);
          }}
          open={publishOpen}
          workspaceId={selectedWorkspaceId}
        />
      )}
      </main>
    </StoplightProvider>
  );
}

export function AppShell() {
  return (
    <WorkspaceSelectionProvider>
      <WorkspaceDesktopProvider>
        <DesktopBillingProvider>
          <AppShellContent />
        </DesktopBillingProvider>
      </WorkspaceDesktopProvider>
    </WorkspaceSelectionProvider>
  );
}
