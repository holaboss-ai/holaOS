import { atom } from "jotai";

/** Is the new-tab command palette dialog open? */
export const newTabOpenAtom = atom(false);

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

/** Is the Apps gallery overlay open? */
export const appsOpenAtom = atom(false);

/** Active section inside the Settings overlay. */
export const settingsSectionAtom = atom<
  "account" | "billing" | "providers" | "integrations" | "submissions" | "settings"
>("settings");

/**
 * True when any overlay is open. BrowserPane reads this to detach the
 * native BrowserView; otherwise the OS-level webview paints on top of
 * the React modal layer and the user can't see it.
 */
export const browserViewSuspendedAtom = atom(
  (get) =>
    get(newTabOpenAtom) ||
    get(publishOpenAtom) ||
    get(createWorkspaceOpenAtom) ||
    get(inboxOpenAtom) ||
    get(artifactsOpenAtom) ||
    get(automationsOpenAtom) ||
    get(sessionsOpenAtom) ||
    get(settingsOpenAtom) ||
    get(marketplaceOpenAtom) ||
    get(appsOpenAtom),
);
