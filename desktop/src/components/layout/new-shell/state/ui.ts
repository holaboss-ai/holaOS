import { atom } from "jotai";

/** Is the new-tab command palette dialog open? */
export const newTabOpenAtom = atom(false);

/** Is the Publish-to-Store screen open? */
export const publishOpenAtom = atom(false);

/** Is the create-new-workspace panel open? */
export const createWorkspaceOpenAtom = atom(false);
