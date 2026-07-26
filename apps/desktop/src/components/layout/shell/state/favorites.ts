import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

const MAX_ENTRIES = 200;

/**
 * User-curated "pinned" list. Complements recentFiles (auto, time-decayed)
 * with explicit signal: "I care about this thing and want it always at
 * hand". Renders as the top section of the sidebar.
 *
 * Three kinds:
 *  - issue : per-workspace; sidebar filters to current workspace
 *  - file  : per-workspace (or null for non-workspace files); same filter
 *  - url   : global; visible across all workspaces
 *
 * Stored as a single flat array; the workspace filter happens at render
 * time. Keeps the storage shape stable when users switch workspaces.
 */
export type FavoriteItem =
  | {
      kind: "issue";
      id: string;
      workspaceId: string;
      issueId: string;
      title: string;
      starredAt: string;
    }
  | {
      kind: "file";
      id: string;
      workspaceId: string | null;
      filePath: string;
      label: string;
      starredAt: string;
    }
  | {
      kind: "url";
      id: string;
      url: string;
      title: string;
      faviconUrl?: string;
      starredAt: string;
    }
  | {
      // Workspace artifact / output. We keep only the minimal pointer
      // (workspaceId + outputId + the title at star time) rather than the
      // full payload — the latter goes stale when the module renames a
      // route or when the producer republishes. At open time the sidebar
      // re-fetches the live payload via the outputs list and replays
      // openOutput, which keeps URL / file resolution honest.
      kind: "output";
      id: string;
      workspaceId: string;
      outputId: string;
      title: string;
      filePath?: string | null;
      starredAt: string;
    }
  | {
      // Installed module app. Pinning an app keeps a quick-launch entry; at
      // open time the workspace resolves the app's current web surface URL.
      kind: "app";
      id: string;
      workspaceId: string;
      appId: string;
      label: string;
      starredAt: string;
    };

// Stable composite key per kind. Used both as the React/Set key and as
// the dedupe predicate inside the toggle atom.
export function favoriteKey(
  input:
    | { kind: "issue"; workspaceId: string; issueId: string }
    | { kind: "file"; workspaceId: string | null; filePath: string }
    | { kind: "url"; url: string }
    | { kind: "output"; workspaceId: string; outputId: string }
    | { kind: "app"; workspaceId: string; appId: string },
): string {
  if (input.kind === "issue") {
    return `issue:${input.workspaceId}:${input.issueId}`;
  }
  if (input.kind === "file") {
    return `file:${input.workspaceId ?? "_"}:${input.filePath}`;
  }
  if (input.kind === "output") {
    return `output:${input.workspaceId}:${input.outputId}`;
  }
  if (input.kind === "app") {
    return `app:${input.workspaceId}:${input.appId}`;
  }
  return `url:${input.url}`;
}

export const favoritesAtom = atomWithStorage<FavoriteItem[]>(
  "holaboss-shell-favorites-v1",
  [],
);

/**
 * Toggle a favorite: add if absent, remove if present. Matches by
 * composite key so adding the "same" issue twice from different surfaces
 * (sidebar row vs board card) never duplicates.
 *
 * New entries land at the head so most-recently-starred items appear
 * first — same convention as recents.
 */
/** Descriptor accepted by toggleFavoriteAtom — also the prop shape any
 *  surface passes to the shared PinStarButton. */
export type FavoriteToggleInput =
  | {
      kind: "issue";
      workspaceId: string;
      issueId: string;
      title: string;
    }
  | {
      kind: "file";
      workspaceId: string | null;
      filePath: string;
      label: string;
    }
  | { kind: "url"; url: string; title: string; faviconUrl?: string }
  | {
      kind: "output";
      workspaceId: string;
      outputId: string;
      title: string;
      filePath?: string | null;
    }
  | {
      kind: "app";
      workspaceId: string;
      appId: string;
      label: string;
    };

export const toggleFavoriteAtom = atom(
  null,
  (get, set, input: FavoriteToggleInput) => {
    const key = favoriteKey(input);
    const prev = get(favoritesAtom);
    const existing = prev.find((entry) => entry.id === key);
    if (existing) {
      set(
        favoritesAtom,
        prev.filter((entry) => entry.id !== key),
      );
      return;
    }
    const now = new Date().toISOString();
    let next: FavoriteItem;
    if (input.kind === "issue") {
      next = {
        kind: "issue",
        id: key,
        workspaceId: input.workspaceId,
        issueId: input.issueId,
        title: input.title,
        starredAt: now,
      };
    } else if (input.kind === "file") {
      next = {
        kind: "file",
        id: key,
        workspaceId: input.workspaceId,
        filePath: input.filePath,
        label: input.label,
        starredAt: now,
      };
    } else if (input.kind === "output") {
      next = {
        kind: "output",
        id: key,
        workspaceId: input.workspaceId,
        outputId: input.outputId,
        title: input.title,
        filePath: input.filePath ?? null,
        starredAt: now,
      };
    } else if (input.kind === "app") {
      next = {
        kind: "app",
        id: key,
        workspaceId: input.workspaceId,
        appId: input.appId,
        label: input.label,
        starredAt: now,
      };
    } else {
      next = {
        kind: "url",
        id: key,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
        starredAt: now,
      };
    }
    set(favoritesAtom, [next, ...prev].slice(0, MAX_ENTRIES));
  },
);

/**
 * Filtered view for the sidebar Favorites section. Returns:
 *  - all starred URLs (always visible across workspaces — a URL has no
 *    workspace affinity)
 *  - workspace-scoped issues + files matching the active workspace
 *
 * When no workspace is selected, falls back to URLs only so the section
 * still renders something useful instead of going empty.
 */
export const favoritesForWorkspaceAtom = atom((get) => {
  const all = get(favoritesAtom);
  return (workspaceId: string | null) =>
    all.filter((entry) => {
      // Drop legacy "folder" pins left in storage from the retired Files tree.
      if ((entry as { kind: string }).kind === "folder") return false;
      if (entry.kind === "url") return true;
      if (!workspaceId) return false;
      // issue / file / output / app all carry a workspaceId scope.
      return entry.workspaceId === workspaceId;
    });
});

/**
 * Reactive `isFavorite(key) → boolean` derived from the storage atom.
 * Components read this via useAtomValue and call the returned function
 * with a key from favoriteKey() to drive their star-on/off visual.
 */
export const isFavoriteAtom = atom((get) => {
  const all = get(favoritesAtom);
  const keys = new Set(all.map((entry) => entry.id));
  return (key: string) => keys.has(key);
});

/**
 * Manual reorder for drag-to-reorder in the sidebar. Moves `draggedId` to
 * sit before/after `targetId` within the flat storage array — which is the
 * display order. Reordering against a visible target in the global array
 * keeps items from other workspaces (and global URLs) in place.
 */
export const moveFavoriteAtom = atom(
  null,
  (
    get,
    set,
    input: { draggedId: string; targetId: string; place: "before" | "after" },
  ) => {
    const { draggedId, targetId, place } = input;
    if (draggedId === targetId) return;
    const prev = get(favoritesAtom);
    const fromIndex = prev.findIndex((entry) => entry.id === draggedId);
    if (fromIndex === -1) return;
    const dragged = prev[fromIndex];
    const without = prev.filter((entry) => entry.id !== draggedId);
    const targetIndex = without.findIndex((entry) => entry.id === targetId);
    if (targetIndex === -1) return;
    const insertAt = place === "before" ? targetIndex : targetIndex + 1;
    const next = [...without];
    next.splice(insertAt, 0, dragged);
    set(favoritesAtom, next);
  },
);
