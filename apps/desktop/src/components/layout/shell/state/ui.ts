import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { ExplorerAttachmentDragPayload } from "@/lib/attachmentDrag";
import type { ApiKeyInstall } from "@/lib/holaAppMarketplace";
import type { ChatMessage } from "@/components/panes/ChatPane/types";
import { overlayOpenCountAtom } from "../overlay-presence";
import type { InternalTab } from "./internalTabs";

/** The user's own sidebar-collapsed preference. Persists across sessions and is
 * only written by explicit user toggles (collapse button, ⌘\, command palette).
 * The app-open collapse is kept out of here so it can't outlive the app that
 * caused it — see `sidebarCollapsedAtom`. */
const sidebarCollapsedPreferenceAtom = atomWithStorage(
  "holaboss-new-shell-sidebar-collapsed-v1",
  false,
);

/** Transient, in-memory collapse forced while a HolaApp surface is open. `null`
 * means "follow the user's preference". Never persisted, so quitting with an app
 * open leaves nothing behind on relaunch. */
const sidebarCollapseOverrideAtom = atom<boolean | null>(null);

/** Effective sidebar-collapsed state used by all UI. Reads as the transient app
 * override when present, otherwise the persisted user preference. Writing to it
 * is treated as an explicit user action: it sets the preference and drops any
 * app override, so a manual expand/collapse always wins and persists. */
export const sidebarCollapsedAtom = atom(
  (get) =>
    get(sidebarCollapseOverrideAtom) ?? get(sidebarCollapsedPreferenceAtom),
  (get, set, next: boolean | ((prev: boolean) => boolean)) => {
    const prev =
      get(sidebarCollapseOverrideAtom) ?? get(sidebarCollapsedPreferenceAtom);
    const value = typeof next === "function" ? next(prev) : next;
    set(sidebarCollapsedPreferenceAtom, value);
    set(sidebarCollapseOverrideAtom, null);
  },
);

/** Which context the sidebar shows: `local` = the personal workspace (Home,
 * Marketplace, Projects, HolaApps, sessions…); `employee` = the AI-employee surface
 * (its Home + the employee roster + threads). Persists across launches; `getOnInit`
 * reads the stored choice on first render so the shell mounts in the right mode. */
export type SidebarMode = "local" | "employee";
export const sidebarModeAtom = atomWithStorage<SidebarMode>(
  "holaboss-sidebar-mode-v1",
  "local",
  undefined,
  { getOnInit: true },
);

/** Transiently collapse the sidebar because a HolaApp surface just opened. Not
 * persisted and cleared by any explicit user toggle, so it never survives a
 * quit-while-app-open into the next launch. */
export const collapseSidebarForAppSurfaceAtom = atom(null, (_get, set) => {
  set(sidebarCollapseOverrideAtom, true);
});

/**
 * The sidebar's EFFECTIVE mode.
 *
 * Cloud mode (the experimental Local/Cloud switcher and the employee surface it
 * revealed) was removed from the UI. `sidebarModeAtom` is persisted, so anyone
 * who tried it still has "employee" on disk — and reading that raw would leave
 * them with a Local sidebar and an Employee main area, stranded in a mode with
 * no switcher to get back from.
 *
 * Everything that renders off the mode reads this instead, so the pin is in one
 * place rather than re-derived per consumer. Restoring cloud mode means making
 * this return the stored value again.
 */
export const effectiveSidebarModeAtom = atom<SidebarMode>(() => "local");

/**
 * The middle tab area is maximized to fill the window (sidebar + chat hidden).
 * Transient — never persisted; Esc / the toggle restores the prior layout.
 */
export const centerFullscreenAtom = atom(false);

/**
 * Per-session collapsed state for the docked Outputs/Sources card, keyed by
 * session id. Missing = collapsed, so a fresh chat opens clean; the header's
 * Outputs toggle flips it. Persisted + per-session, so each chat keeps its own
 * choice and they never bleed into one another.
 */
export const contextCardCollapsedBySessionAtom = atomWithStorage<
  Record<string, boolean>
>("holaboss.chat.contextCardCollapsedBySession", {});

/**
 * Sidebar width when expanded. Resizable via the right-edge drag handle.
 * Clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] at the consumer.
 * Persists.
 */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const sidebarWidthAtom = atomWithStorage<number>(
  "holaboss-new-shell-sidebar-width-v1",
  SIDEBAR_DEFAULT_WIDTH,
);

/**
 * Which "section" the sidebar is showing in its body. Preserved for shell
 * actions that still target the older home / inbox / library section model.
 */
export type SidebarSection = "home" | "issues" | "inbox";
export const sidebarSectionAtom = atomWithStorage<SidebarSection>(
  "holaboss-new-shell-sidebar-section-v1",
  "home",
);

/** Is the cmd+K universal Search palette open? */
export const searchOpenAtom = atom(false);

/** Is the Publish-to-Store screen open? */
export const publishOpenAtom = atom(false);

/** Is the create-new-issue dialog open? */
export const newIssueOpenAtom = atom(false);

/** Is the Settings full-screen overlay open? */
export const settingsOpenAtom = atom(false);

/** The org being switched TO (or null when not switching) — drives a full-screen
 * loading overlay so the whole app re-scopes behind one clear transition rather
 * than flickering pane-by-pane. Carries the target so the splash text can read
 * "Switching to <Org>…" vs "Returning to your personal workspace…". */
export type OrgSwitchTarget = { toPersonal: boolean; orgName: string | null };
export const orgSwitchingAtom = atom<OrgSwitchTarget | null>(null);

/** Is the Keyboard shortcuts cheatsheet overlay open? */
export const shortcutsHelpOpenAtom = atom(false);

/** Is the Apps expandable group in the sidebar expanded? Persists. */
export const appsExpandedAtom = atomWithStorage(
  "holaboss-new-shell-apps-expanded-v1",
  true,
);

/** Is the Output section (formerly Library/Artifacts) expanded? Persists. */
export const outputExpandedAtom = atomWithStorage(
  "holaboss-new-shell-output-expanded-v1",
  true,
);

/**
 * Manual "focus on chat" override. When true AND at least one tab exists,
 * the shell collapses to a chat-only canvas with a tabs-hidden pill on
 * the chat. When no tabs exist the shell goes chat-only automatically,
 * regardless of this flag. Persists so users who prefer focus keep it.
 */
// `getOnInit: true` so the persisted value is read on the first render
// rather than after a microtask. AppShell's main-view seed effect runs
// at mount and reads both this atom and `defaultMainViewModeAtom` to
// decide whether to flip focus mode — without sync init it would fire
// with the atom defaults, lock the seed ref to the current workspace,
// and never reconcile against the real persisted preferences.
export const focusModeAtom = atomWithStorage(
  "holaboss-new-shell-focus-mode-v1",
  false,
  undefined,
  { getOnInit: true },
);

/**
 * Per-workspace "main view" preference chosen at workspace-creation time.
 *  - "workspace" (default) → split layout: tabs + chat side by side.
 *  - "chat"               → chat fills the canvas; the welcome surface
 *                            takes over the middle when tabs are empty.
 *
 * Keyed by workspaceId so each workspace can remember its own choice.
 * AppShell seeds focusModeAtom from this map on workspace activation,
 * so the preference acts as the initial state but the in-session focus
 * toggle still wins until the user navigates away and back.
 */
export type WorkspaceMainViewMode = "workspace" | "chat";

// Exported so AppShell's migration code can read the legacy key
// directly from localStorage without instantiating its atom.
export const DEFAULT_MAIN_VIEW_MODE_STORAGE_KEY =
  "holaboss.default-main-view-mode-v1";
export const LEGACY_WORKSPACE_MAIN_VIEW_MODE_MAP_STORAGE_KEY =
  "holaboss-new-shell-workspace-main-view-v1";

/**
 * The user's single preference for which view a workspace opens to.
 * Replaces the per-workspace map below — in practice nobody actually
 * wanted "chat-first in workspace A, workspace-first in workspace B,"
 * the granularity just happened because the atom was easy to key on
 * workspace id at the time.
 *
 * AppShell runs a one-shot majority-vote migration on mount: if this
 * key isn't set in localStorage but the old per-workspace map has
 * entries, it picks the majority value from the old map and writes it
 * here. Ties go to "chat" (the default).
 */
export const defaultMainViewModeAtom = atomWithStorage<WorkspaceMainViewMode>(
  DEFAULT_MAIN_VIEW_MODE_STORAGE_KEY,
  "chat",
  undefined,
  // See focusModeAtom — both atoms back the same mount-time seed effect.
  { getOnInit: true },
);

/**
 * @deprecated Kept only so the one-shot migration in AppShell can read
 * it. Don't read or write this from new code — use
 * `defaultMainViewModeAtom`. Will be removed once migration has
 * settled in shipped builds.
 */
export const workspaceMainViewModeMapAtom = atomWithStorage<
  Record<string, WorkspaceMainViewMode>
>(LEGACY_WORKSPACE_MAIN_VIEW_MODE_MAP_STORAGE_KEY, {});

/**
 * Chat panel width in split mode (canvas modes ignore this and flex-1
 * across the middle). Resizable via the left-edge drag handle on the
 * chat panel. Clamped to [CHAT_PANEL_MIN_WIDTH, CHAT_PANEL_MAX_WIDTH] at
 * the consumer. Persists.
 */
export const CHAT_PANEL_MIN_WIDTH = 420;
export const CHAT_PANEL_MAX_WIDTH = 720;
export const CHAT_PANEL_DEFAULT_WIDTH = 480;
export const chatPanelWidthAtom = atomWithStorage<number>(
  "holaboss-new-shell-chat-panel-width-v1",
  CHAT_PANEL_DEFAULT_WIDTH,
);

/** Is the right-hand chat panel hidden in split mode? Persists. */
export const chatPanelHiddenAtom = atomWithStorage(
  "holaboss-new-shell-chat-panel-hidden-v1",
  false,
);

/** Active section inside the Settings overlay. */
export const settingsSectionAtom = atom<UiSettingsPaneSection>("settings");

/**
 * Which view the right-hand chat panel is showing. "chat" is the normal
 * ChatPane; "sessions" swaps in the workspace's session list (legacy
 * AppShell's agentView pattern). Lifted to jotai so cmd+K can flip it.
 */
export type ChatPanelView = "chat" | "sessions" | "artifacts";
export const chatPanelViewAtom = atom<ChatPanelView>("chat");

/**
 * Per-workspace count of outputs the user has already "seen" — i.e. the
 * display-output count at the moment they last opened the Outputs view.
 * Drives the "new outputs" dot on the chat header's Outputs button: a dot
 * shows when the live count exceeds this baseline. Persisted so the signal
 * survives restarts (outputs created while away still read as new).
 */
export const lastSeenOutputsCountAtom = atomWithStorage<Record<string, number>>(
  "holaboss.chat.lastSeenOutputsCount",
  {},
);

/**
 * Projects overlay state. When non-null, ChatPanel renders an overlay over
 * the entire central pane (sidebar stays visible) instead of the normal
 * ChatPane/ArtifactsView/SessionsView. The two modes correspond to the
 * Projects index page (card grid) and a project's landing page (chat
 * composer scoped to that project). Submitting the first message on a
 * landing page clears this atom and selects the new session.
 */
export type ProjectViewState =
  | { mode: "index" }
  | { mode: "landing"; projectId: string };
export const projectViewAtom = atom<ProjectViewState | null>(null);

/**
 * Workspace-level full-screen overlay (sibling to projectViewAtom). When
 * non-null, ShellMainArea hides the central pane + chat panel and renders
 * the named workspace surface instead. Used for Automations, Skills, and
 * Customize — all full-screen workspace surfaces.
 */
export type WorkspaceOverlay =
  | "automations"
  | "skills"
  | "customize"
  | "channels"
  | "profiles"
  | "apps"
  | "members"
  // HolaEmployee is a first-class surface (like Home), NOT a HolaApp opened in the
  // center with app chrome — so it rides the workspace-overlay track, rendered as
  // a chromeless full-width web surface with the sidebar as its exit.
  | "holaemployee"
  | "rewards"
  | "holahub"
  // Full-page WYSIWYG "Share to HolaHub" composer — pick turns/outputs, toggle the
  // model annotation, write a caption, then hand off to the hub to publish. The
  // conversation to share rides in `shareSessionPayloadAtom`.
  | "holahub-share";
// The app opens to Home (the HolaHub surface) — it's the first-class landing.
// This only decides the initial screen: it's cleared the moment the user starts
// a chat/session, so nobody's trapped.
export const workspaceOverlayAtom = atom<WorkspaceOverlay | null>("holahub");

/** The conversation staged for the full-page "Share to HolaHub" composer. Set by
 *  `useOpenSharePreview` right before flipping the overlay to "holahub-share". */
export interface ShareSessionPayload {
  messages: ChatMessage[];
  workspaceId: string | null;
  /** Friendly name of the session's active model (e.g. "Claude Opus 4.8"). */
  model: string;
  /** The same model as a resolvable id (e.g. "anthropic/claude-sonnet-4-6") —
   *  what a Recipe stores, since the display name cannot be selected again. */
  modelId: string;
  /** skill id → title, and integration slug → name, so a share can name the
   *  tools it detects without reaching back into the composer's state. */
  skillNames: Record<string, string>;
  integrationNames: Record<string, string>;
  // Render context so the preview renders turns exactly as the live chat does
  // (reusing the real UserTurn/AssistantTurn components).
  label: string;
  mode: string;
  harnessId: string | null;
  showExecutionInternals: boolean;
}
export const shareSessionPayloadAtom = atom<ShareSessionPayload | null>(null);

/** A host hand-off asking the chat to open on a particular model (Reproduce
 *  carrying the model its Output was made on). Consumed by ChatPane, which
 *  ignores a model this install does not have. */
export interface ChatModelRequest {
  model: string;
  requestKey: number;
}
export const chatModelRequestAtom = atom<ChatModelRequest | null>(null);

/** How the "Share to HolaHub" composer opens: the whole conversation (a
 *  transcript "session" post) or just the produced artifacts (a media "post"). */
export type ShareMode = "conversation" | "outputs";

/** The mode the composer should open in, set by the header Share menu right
 *  before it stages the payload. SharePreviewPane seeds its initial tab from it. */
export const shareInitialModeAtom = atom<ShareMode>("conversation");

/** The active chat's "Share to HolaHub" action, published by ChatPane when the
 *  session has messages (else null). The shell's chat toolbar reads it so the
 *  Share control sits with the other header actions on the right — a dropdown
 *  that opens the composer straight into the chosen mode. `hasOutputs` gates the
 *  "Share outputs" entry to conversations that actually produced shareable media. */
export const chatShareActionAtom = atom<{
  open: (mode: ShareMode) => void;
  hasOutputs: boolean;
} | null>(null);

// The Customize tabs (Apps first, then the agent-building blocks). Kept here so
// entry points outside CustomizePane — e.g. the sidebar HolaApps section — can
// land the overlay on a specific tab.
export type CustomizeTab = "apps" | "capabilities" | "skills" | "mcps";
export const customizeTabAtom = atom<CustomizeTab>("apps");

// When set, the Discover (holahub) overlay opens navigated to this path (e.g.
// `/threads/<postId>` to jump straight to a post an agent just published)
// instead of its home feed. Cleared on a plain Discover open from the sidebar.
export const holahubPendingPathAtom = atom<string | null>(null);

// The active Employee-space section. Most sections are the SAME embedded web
// surface ("holaemployee") at a different `?section=` — the web Cloud Home hides
// its own left nav inside the desktop and this rail drives it, so there's one
// source of truth. Home = the surface's default (`/employees`, no `?section`).
// "catalog" is the exception: it's a distinct ROUTE (`/employees/catalog`, the
// shared-employee marketplace), not a `?section=` of Home — AppShell maps it to a
// `/catalog` path suffix instead.
export type CloudSection = "home" | "catalog" | "members";
export const cloudSectionAtom = atom<CloudSection>("home");

/** A pending "install this catalog item" intent from a hosted page (HolaHub's
 * install op → HOST_INSTALL_EVENT). CustomizePane consumes it: opens the item's
 * tab + focuses its native install detail, then clears this. */
export type PendingHubInstall = {
  type: "skill" | "mcp" | "holaapp" | "capability";
  ref: string;
};
export const pendingHubInstallAtom = atom<PendingHubInstall | null>(null);

/** A pending HolaApp install intent from a hosted page (HolaHub), for the flavors
 * the HeadlessInstaller can't complete headlessly (connection-tier / hosted-MCP
 * that need credentials up front). The HolaApp store (HolaAppMarketplacePane)
 * consumes it: opens that app's own install gate, then clears this. Holds the
 * holaAppId. */
export const pendingHubAppInstallAtom = atom<string | null>(null);

/** A HolaApp whose detail page the store should open on arrival. Set by
 * `useHostOpenApp` when HolaHub asks to open a connection-tier app — it has no
 * surface, so "Manage" lands on its ConnectionAppDetail (connected accounts,
 * add/refresh/disconnect). Consumed and cleared by HolaAppMarketplacePane. */
export const pendingHubAppDetailAtom = atom<string | null>(null);


/**
 * When a workspace surface (e.g. Customize) hands the user off into a draft
 * chat — "create with agent", "use in chat" — it stamps where to return so the
 * chat can offer a one-click way back instead of stranding the user.
 */
export const chatReturnTargetAtom = atom<WorkspaceOverlay | null>(null);

/** A web HolaApp open as its own dedicated center-column pane (NOT a tab).
 * Takes the middle column while the chat panel stays beside it (so Discuss
 * lands in context). Cleared by its close button or by opening a browser
 * tab / file in the center. */
export interface ActiveWebAppSurface {
  holaAppId: string;
  title: string;
  path?: string;
  /** Absolute URL for third-party apps (e.g. Notion); when omitted the surface
   * derives `<WEB_APP_BASE_URL>/apps/<holaAppId>`. */
  url?: string;
  /** Live location of the surface's BrowserView — the page the user is actually
   * viewing right now, updated on in-surface navigation (full + SPA in-page).
   * Folded into the chat copilot's context so it knows the current page. */
  currentUrl?: string;
  currentTitle?: string;
  /** Integrations this app declares (from the catalog). Folded into the copilot's
   * context as a SOFT hint about which connections/tools may be relevant here —
   * a guide, not a requirement. */
  integrations?: { provider: string; required: boolean }[];
  /** Tool names from the app's own MCP server, for apps whose capabilities come
   * from a bundled MCP server rather than a Composio integration. The MCP-side
   * counterpart of `integrations` for the same soft tool hint. */
  mcpTools?: string[];
  /** API-key install config (OmniSocials, Publora) — carried here so the
   * surface-based install gate reads it without a per-app desktop lookup. */
  apiKeyInstall?: ApiKeyInstall;
}
export const activeWebAppSurfaceAtom = atom<ActiveWebAppSurface | null>(null);

/** API-key apps whose key HAS been provided (MCP connected), keyed by holaAppId.
 * PERSISTED. The install gate is SURFACE-based: the chat is blocked whenever an
 * API-key app's surface is open and its id is NOT in this map. Set true when the
 * user submits the key (gate unlock); cleared on uninstall (so a reinstall gates
 * again). Because both "surface open" and "connected" are durable, the gate
 * survives navigation and restarts without any per-session bookkeeping. */
export const apiKeyConnectedAppsAtom = atomWithStorage<Record<string, boolean>>(
  "holaboss-apikey-connected-apps-v1",
  {},
);

/**
 * The session whose tab is open in the chat pane. Promoted from ChatPane's
 * local `activeSessionIdRef` so that views outside ChatPane (e.g. the
 * project landing page) can route into the chat pane atomically after
 * creating a session.
 */
export const selectedWorkspaceIdAtom = atomWithStorage<string>(
  "holaboss-selected-workspace-v1",
  "",
);

/** Per-workspace memory of the last-selected session — the single source of
 *  truth for "which session is active". The sidebar, chat, and browser panes
 *  all read/write it through selectedSessionIdAtom, so they never diverge. */
export const selectedSessionByWorkspaceAtom = atomWithStorage<
  Record<string, string>
>("holaboss-selected-session-by-workspace-v1", {});

/** The selected session for the CURRENT workspace. Writing it updates the
 *  per-workspace map, so switching workspace restores that workspace's own
 *  session AND a sidebar session switch is picked up by the browser pane. */
export const selectedSessionIdAtom = atom(
  (get) =>
    get(selectedSessionByWorkspaceAtom)[get(selectedWorkspaceIdAtom).trim()] ??
    null,
  (get, set, sessionId: string | null) => {
    const workspaceId = get(selectedWorkspaceIdAtom).trim();
    if (!workspaceId) {
      return;
    }
    const prev = get(selectedSessionByWorkspaceAtom);
    const next = (sessionId ?? "").trim();
    if (next) {
      if (prev[workspaceId] === next) {
        return;
      }
      set(selectedSessionByWorkspaceAtom, { ...prev, [workspaceId]: next });
    } else {
      if (!(workspaceId in prev)) {
        return;
      }
      const copy = { ...prev };
      delete copy[workspaceId];
      set(selectedSessionByWorkspaceAtom, copy);
    }
  },
);

// Open workspace tabs are scoped to the active session — each chat keeps its
// own set of opened files/surfaces, mirroring the per-session browser tabs.
// `internalTabsAtom` / `activeInternalTabIdAtom` are the session-aware facade;
// consumers use them unchanged while the state lives in these keyed records
// (in-memory: tabs can hold image object URLs we must not persist).
const internalTabsBySessionAtom = atom<Record<string, InternalTab[]>>({});
const activeInternalTabIdBySessionAtom = atom<Record<string, string | null>>(
  {},
);
const EMPTY_INTERNAL_TABS: InternalTab[] = [];

export const internalTabsAtom = atom(
  (get) =>
    get(internalTabsBySessionAtom)[(get(selectedSessionIdAtom) ?? "").trim()] ??
    EMPTY_INTERNAL_TABS,
  (
    get,
    set,
    update: InternalTab[] | ((prev: InternalTab[]) => InternalTab[]),
  ) => {
    const key = (get(selectedSessionIdAtom) ?? "").trim();
    const all = get(internalTabsBySessionAtom);
    const prev = all[key] ?? EMPTY_INTERNAL_TABS;
    const next =
      typeof update === "function"
        ? (update as (p: InternalTab[]) => InternalTab[])(prev)
        : update;
    set(internalTabsBySessionAtom, { ...all, [key]: next });
  },
);

export const activeInternalTabIdAtom = atom(
  (get) =>
    get(activeInternalTabIdBySessionAtom)[
      (get(selectedSessionIdAtom) ?? "").trim()
    ] ?? null,
  (
    get,
    set,
    update: string | null | ((prev: string | null) => string | null),
  ) => {
    const key = (get(selectedSessionIdAtom) ?? "").trim();
    const all = get(activeInternalTabIdBySessionAtom);
    const prev = all[key] ?? null;
    const next =
      typeof update === "function"
        ? (update as (p: string | null) => string | null)(prev)
        : update;
    set(activeInternalTabIdBySessionAtom, { ...all, [key]: next });
  },
);

/**
 * Per-session "last viewed" ISO timestamps. Keyed by `session_id`. Drives the
 * sidebar's unread blue dot: a session shows the dot when its `updated_at`
 * is newer than what's recorded here AND it is not the currently selected
 * session. Persisted so the dot survives reloads.
 */
export const sessionLastViewedAtAtom = atomWithStorage<Record<string, string>>(
  "holaboss-session-last-viewed-v1",
  {},
);

/**
 * Collapsed sidebar session groups, keyed by group id (a project_id, or
 * "general"). Persisted so collapse state survives reloads — mirrors
 * collapsedFavoriteGroupsAtom for the Pinned section.
 */
export const collapsedSessionGroupsAtom = atomWithStorage<string[]>(
  "holaboss-session-groups-collapsed-v1",
  [],
);


/**
 * Prefill request driven from outside the chat panel (e.g. the Automations
 * "New schedule" button). ChatPanel watches this atom and threads it to
 * ChatPane as `composerPrefillRequest`, optionally pairing it with a fresh
 * draft-session open request when the caller wants a clean composer.
 * Bumping `requestKey` re-triggers the prefill even when the text matches
 * a previous request.
 */
export interface ChatComposerPrefill {
  text: string;
  requestKey: number;
  mode?: "replace" | "append";
  sessionMode?: "preserve" | "draft";
  autoSubmit?: boolean;
}
export const chatComposerPrefillAtom = atom<ChatComposerPrefill | null>(null);

let composerPrefillKeyCounter = 0;

/**
 * App-global, monotonic request key for composer prefills. Per-component
 * counters reset on remount and collide across surfaces, which makes the
 * draft-session dedup in ChatPanel drop a repeat prefill (e.g. opening a second
 * capability and clicking Customize would not open a fresh session). A shared
 * counter guarantees every prefill gets a distinct key.
 */
export function nextComposerPrefillKey(): number {
  composerPrefillKeyCounter += 1;
  return composerPrefillKeyCounter;
}

export interface ChatLocalAttachmentRequest {
  files: File[];
  requestKey: number;
}
export const chatLocalAttachmentRequestAtom =
  atom<ChatLocalAttachmentRequest | null>(null);

/**
 * Cross-pane request to drop file-reference chips into the chat composer
 * (e.g. the file-preview "@" button). Mirrors the drag-from-explorer flow —
 * same payload, same `appendPendingExplorerAttachments` consumer — so the
 * reference shows as a removable chip instead of a raw `@path` in the text.
 */
export interface ChatExplorerAttachmentRequest {
  files: ExplorerAttachmentDragPayload[];
  requestKey: number;
}
export const chatExplorerAttachmentRequestAtom =
  atom<ChatExplorerAttachmentRequest | null>(null);

/**
 * Cross-pane request to drop generic "app context" pills into the composer
 * (e.g. need-review's Discuss handing over a record). Each item shows as a
 * removable card; its `contextText` is folded into the message on send.
 */
export interface ChatAppContextAttachmentItem {
  appName: string;
  title: string;
  contextText: string;
}
export interface ChatAppContextAttachmentRequest {
  items: ChatAppContextAttachmentItem[];
  requestKey: number;
}
export const chatAppContextAttachmentRequestAtom =
  atom<ChatAppContextAttachmentRequest | null>(null);

export interface ChatSessionOpenRequest {
  sessionId: string;
  requestKey: number;
  mode?: "session" | "draft";
  parentSessionId?: string | null;
  readOnly?: boolean;
  /** A blank "+ New chat" draft resets the composer; a prefill-driven draft
   *  (e.g. schedule edit) seeds the composer and must keep its content. */
  clearComposer?: boolean;
}
export const chatSessionOpenRequestAtom = atom<ChatSessionOpenRequest | null>(
  null,
);

/** The chat session that was active before a HolaApp surface took over the
 *  middle column. Opening an app swaps the chat to its own fresh draft, so
 *  closing the app restores this session — returning to the "latest session
 *  page" instead of the app's now-orphaned draft. */
export const preHolaAppSessionIdAtom = atom<string | null>(null);


/**
 * True when any overlay is open. BrowserPane reads this to detach the
 * native BrowserView; otherwise the OS-level webview paints on top of
 * the React modal layer and the user can't see it.
 */
export const browserViewSuspendedAtom = atom(
  (get) =>
    get(searchOpenAtom) ||
    get(publishOpenAtom) ||
    get(newIssueOpenAtom) ||
    get(settingsOpenAtom) ||
    get(shortcutsHelpOpenAtom) ||
    // An internal tab (e.g. a PDF preview) renders in the center/chat column and
    // must not be painted over by that column's native web-HolaApp BrowserView.
    // But it is NOT rendered while a full-area workspace overlay (Discover/
    // HolaEmployee/…) is open — those live in a different render branch — so it
    // must not suspend the OVERLAY's own web surface, or opening a preview then
    // navigating to Discover leaves Discover permanently blank. Gate on there
    // being no active overlay.
    (get(workspaceOverlayAtom) === null &&
      get(activeInternalTabIdAtom) !== null) ||
    get(overlayOpenCountAtom) > 0,
);
