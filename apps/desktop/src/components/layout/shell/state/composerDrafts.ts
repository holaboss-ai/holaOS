import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/**
 * Per-workspace draft text for the chat composer. Persists across session
 * unmounts and reloads so a half-typed message survives switching tabs,
 * closing/reopening the window, etc.
 *
 * Keyed by workspaceId only (not workspaceId + sessionId): the dominant
 * case is "I was typing in this workspace's chat, got distracted, came
 * back". Sub-session granularity would carry a refactor cost without
 * meaningful day-to-day payoff for current usage patterns.
 *
 * Empty entries are pruned on write so an idle workspace doesn't carry
 * an empty-string slot in localStorage forever.
 */
export const composerDraftsAtom = atomWithStorage<Record<string, string>>(
  "holaboss-shell-composer-drafts-v1",
  {},
);

export const composerDraftForWorkspaceAtom = atom((get) => {
  const all = get(composerDraftsAtom);
  return (workspaceId: string | null) => {
    if (!workspaceId) return "";
    return all[workspaceId] ?? "";
  };
});

export const setComposerDraftAtom = atom(
  null,
  (
    get,
    set,
    input: { workspaceId: string | null; text: string },
  ) => {
    if (!input.workspaceId) return;
    const all = get(composerDraftsAtom);
    const current = all[input.workspaceId] ?? "";
    if (current === input.text) return;
    if (!input.text) {
      // Drop empty drafts so cleared composers don't leave stale keys.
      if (!(input.workspaceId in all)) return;
      const { [input.workspaceId]: _omitted, ...rest } = all;
      set(composerDraftsAtom, rest);
      return;
    }
    set(composerDraftsAtom, { ...all, [input.workspaceId]: input.text });
  },
);
