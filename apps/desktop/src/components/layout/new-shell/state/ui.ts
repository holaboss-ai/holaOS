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

/** Is the Inbox overlay open? */
export const inboxOpenAtom = atom(false);

/** Is the Artifacts overlay open? */
export const artifactsOpenAtom = atom(false);

/** Is the Automations overlay open? */
export const automationsOpenAtom = atom(false);

/** Is the Sessions overlay open? */
export const sessionsOpenAtom = atom(false);

/** Is the Settings full-screen overlay open? */
export const settingsOpenAtom = atom(false);

/** Is the Marketplace overlay open? */
export const marketplaceOpenAtom = atom(false);

/** Is the Apps expandable group in the sidebar expanded? Persists. */
export const appsExpandedAtom = atomWithStorage(
  "holaboss-new-shell-apps-expanded-v1",
  true,
);

/** Active section inside the Settings overlay. */
export const settingsSectionAtom = atom<UiSettingsPaneSection>("settings");

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
    get(inboxOpenAtom) ||
    get(artifactsOpenAtom) ||
    get(automationsOpenAtom) ||
    get(sessionsOpenAtom) ||
    get(settingsOpenAtom) ||
    get(marketplaceOpenAtom) ||
    get(activeInternalTabIdAtom) !== null ||
    get(overlayOpenCountAtom) > 0,
);
