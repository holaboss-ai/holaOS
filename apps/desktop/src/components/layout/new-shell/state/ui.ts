import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { overlayOpenCountAtom } from "../overlay-presence";
import { activeInternalTabIdAtom } from "./internalTabs";

/** Is the sidebar collapsed (icon-only / hidden)? Persists across sessions. */
export const sidebarCollapsedAtom = atomWithStorage(
  "holaboss-new-shell-sidebar-collapsed-v1",
  false,
);

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
 * Which "section" the sidebar is showing in its body. Notion-style
 * horizontal nav at the top of the sidebar switches between these.
 * "home" is the default workspace nav; the others surface their content
 * (Inbox / Artifacts / Automations) inside the sidebar so the main
 * canvas keeps painting whatever the user was looking at.
 */
export type SidebarSection = "home" | "inbox" | "artifacts" | "automations";
export const sidebarSectionAtom = atomWithStorage<SidebarSection>(
  "holaboss-new-shell-sidebar-section-v1",
  "home",
);

/** Is the new-tab command palette dialog open? */
export const newTabOpenAtom = atom(false);

/** Is the cmd+K universal Search palette open? */
export const searchOpenAtom = atom(false);

/** Is the Publish-to-Store screen open? */
export const publishOpenAtom = atom(false);

/** Is the create-new-workspace panel open? */
export const createWorkspaceOpenAtom = atom(false);

/** Is the Automations overlay open? */
export const automationsOpenAtom = atom(false);

/** Is the Settings full-screen overlay open? */
export const settingsOpenAtom = atom(false);

/** Is the Marketplace overlay open? */
export const marketplaceOpenAtom = atom(false);

/** Is the Apps expandable group in the sidebar expanded? Persists. */
export const appsExpandedAtom = atomWithStorage(
  "holaboss-new-shell-apps-expanded-v1",
  true,
);

/**
 * Manual "focus on chat" override. When true AND at least one tab exists,
 * the shell collapses to a chat-only canvas with a tabs-hidden pill on
 * the chat. When no tabs exist the shell goes chat-only automatically,
 * regardless of this flag. Persists so users who prefer focus keep it.
 */
export const focusModeAtom = atomWithStorage(
  "holaboss-new-shell-focus-mode-v1",
  false,
);

/**
 * Chat panel width in split mode (canvas modes ignore this and flex-1
 * across the middle). Resizable via the left-edge drag handle on the
 * chat panel. Clamped to [CHAT_PANEL_MIN_WIDTH, CHAT_PANEL_MAX_WIDTH] at
 * the consumer. Persists.
 */
export const CHAT_PANEL_MIN_WIDTH = 360;
export const CHAT_PANEL_MAX_WIDTH = 720;
export const CHAT_PANEL_DEFAULT_WIDTH = 480;
export const chatPanelWidthAtom = atomWithStorage<number>(
  "holaboss-new-shell-chat-panel-width-v1",
  CHAT_PANEL_DEFAULT_WIDTH,
);

/** Active section inside the Settings overlay. */
export const settingsSectionAtom = atom<UiSettingsPaneSection>("settings");

/**
 * Which view the right-hand chat panel is showing. "chat" is the normal
 * ChatPane; "sessions" swaps in the workspace's session list (legacy
 * AppShell's agentView pattern). Lifted to jotai so cmd+K can flip it.
 */
export type ChatPanelView = "chat" | "sessions";
export const chatPanelViewAtom = atom<ChatPanelView>("chat");

/**
 * Prefill request driven from outside the chat panel (e.g. the Automations
 * "New schedule" button). ChatPanel watches this atom and threads it to
 * ChatPane as `composerPrefillRequest` + a "draft" session open request.
 * Bumping `requestKey` re-triggers the prefill even when the text matches
 * a previous request.
 */
export interface ChatComposerPrefill {
  text: string;
  requestKey: number;
  mode?: "replace" | "append";
}
export const chatComposerPrefillAtom = atom<ChatComposerPrefill | null>(null);

/**
 * True when any overlay is open. BrowserPane reads this to detach the
 * native BrowserView; otherwise the OS-level webview paints on top of
 * the React modal layer and the user can't see it.
 */
export const browserViewSuspendedAtom = atom(
  (get) =>
    get(newTabOpenAtom) ||
    get(searchOpenAtom) ||
    get(publishOpenAtom) ||
    get(createWorkspaceOpenAtom) ||
    get(automationsOpenAtom) ||
    get(settingsOpenAtom) ||
    get(marketplaceOpenAtom) ||
    get(activeInternalTabIdAtom) !== null ||
    get(overlayOpenCountAtom) > 0,
);
