import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

const MAX_ENTRIES = 50;

/**
 * Recently-opened app/module outputs (twitter posts, linkedin drafts, …).
 * File-backed outputs already land in recentFilesAtom via the internal-tab
 * path; these are the module-backed ones that open as an app surface, which
 * have no on-disk path. Kept separate from recentFilesAtom so the file store
 * doesn't need a schema migration. The sidebar merges both, sorted by openedAt.
 */
export type RecentOutput = {
  id: string;
  outputId: string;
  workspaceId: string | null;
  label: string;
  moduleId: string | null;
  moduleResourceId: string | null;
  outputType: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  openedAt: string;
};

export const recentOutputsAtom = atomWithStorage<RecentOutput[]>(
  "holaboss-new-shell-recent-outputs-v1",
  [],
);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ro-${Date.now()}-${counter}`;
}

export const pushRecentOutputAtom = atom(
  null,
  (
    get,
    set,
    input: {
      outputId: string;
      workspaceId: string | null;
      label: string;
      moduleId: string | null;
      moduleResourceId: string | null;
      outputType: string;
      metadata: Record<string, unknown>;
      updatedAt: string;
    },
  ) => {
    if (!input.outputId.trim()) return;
    const now = new Date().toISOString();
    const prev = get(recentOutputsAtom);
    const existing = prev.find(
      (e) =>
        e.outputId === input.outputId && e.workspaceId === input.workspaceId,
    );
    const updated: RecentOutput = {
      id: existing?.id ?? nextId(),
      outputId: input.outputId,
      workspaceId: input.workspaceId,
      label: input.label,
      moduleId: input.moduleId,
      moduleResourceId: input.moduleResourceId,
      outputType: input.outputType,
      metadata: input.metadata,
      updatedAt: input.updatedAt,
      openedAt: now,
    };
    const next = [
      updated,
      ...prev.filter((e) => e.id !== updated.id),
    ].slice(0, MAX_ENTRIES);
    set(recentOutputsAtom, next);
  },
);

export const removeRecentOutputAtom = atom(null, (get, set, id: string) => {
  set(
    recentOutputsAtom,
    get(recentOutputsAtom).filter((e) => e.id !== id),
  );
});
