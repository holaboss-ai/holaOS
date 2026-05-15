import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

const MAX_ENTRIES = 50;

/**
 * Renderer-side parallel of browser history for internal file tabs.
 * Files don't navigate via the BrowserView so main never sees them;
 * we keep our own persistent list keyed by filePath. Browser history
 * (URLs) and these (files) merge into a single time-sorted Recents
 * list in the sidebar.
 */
export type RecentFile = {
  id: string;
  filePath: string;
  label: string;
  workspaceId: string | null;
  openedAt: string;
};

export const recentFilesAtom = atomWithStorage<RecentFile[]>(
  "holaboss-new-shell-recent-files-v1",
  [],
);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `rf-${Date.now()}-${counter}`;
}

/**
 * Push a file as the most-recently-opened. Dedupes on filePath
 * (existing entry's id is preserved so React keys stay stable); caps
 * the list at MAX_ENTRIES.
 */
export const pushRecentFileAtom = atom(
  null,
  (
    get,
    set,
    input: { filePath: string; label: string; workspaceId: string | null },
  ) => {
    const now = new Date().toISOString();
    const prev = get(recentFilesAtom);
    const existing = prev.find((e) => e.filePath === input.filePath);
    const updated: RecentFile = {
      id: existing?.id ?? nextId(),
      filePath: input.filePath,
      label: input.label,
      workspaceId: input.workspaceId,
      openedAt: now,
    };
    const rest = prev.filter((e) => e.filePath !== input.filePath);
    set(recentFilesAtom, [updated, ...rest].slice(0, MAX_ENTRIES));
  },
);

export const removeRecentFileAtom = atom(null, (get, set, id: string) => {
  set(
    recentFilesAtom,
    get(recentFilesAtom).filter((e) => e.id !== id),
  );
});
