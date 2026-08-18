import { clearComposioInlineCache } from "../../harnesses/src/composio-inline-cache.js";

/**
 * Drop the cached Composio inline tool listing after a connection changes.
 *
 * `composio-inline-cache.ts` shipped with `clearComposioInlineCache` documented
 * as "the connect/install hook" — and nothing ever called it, so the TTL was the
 * only invalidation the cache had. That forced one number to do two incompatible
 * jobs: short enough that a newly connected integration appears promptly, and
 * long enough that the bootstrap fetch actually hits between turns. It was tuned
 * for the first, so the second never happened on any turn a user took more than
 * two minutes to send.
 *
 * With explicit invalidation the TTL only has to cover changes made OUTSIDE this
 * runtime (see the note on its `DEFAULT_TTL_MS`), so it can be far longer.
 *
 * ## Why this fans out over every workspace
 *
 * The cache is keyed per workspace, but integration connections are **user-global**
 * — `RuntimeIntegrationService.deleteConnection` spells this out: "Connections are
 * user-global; deleting one means it should also disappear from every workspace
 * that binds it." So a connection mutation has no single workspace to invalidate,
 * and filtering by current bindings would be wrong in the case that matters most:
 * a freshly connected account has no bindings yet.
 *
 * Clearing every workspace is therefore the correct scope, and it is cheap — one
 * `unlink` of a small JSON file per workspace, on an action a user takes by hand.
 */
export interface ComposioCacheInvalidationStore {
  listWorkspaces(options?: { includeDeleted?: boolean }): Array<{ id: string }>;
  workspaceDir(workspaceId: string): string;
}

export interface ComposioCacheInvalidationLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Clear every workspace's cached listing. Never throws — a failed invalidation
 * must not fail the connect/disconnect it is attached to, and the worst case is
 * the pre-existing behavior (stale until the TTL).
 *
 * @returns how many workspaces actually had a cache file to drop.
 */
export function invalidateComposioInlineToolCache(
  store: ComposioCacheInvalidationStore,
  logger?: ComposioCacheInvalidationLogger,
): number {
  let cleared = 0;
  try {
    for (const workspace of store.listWorkspaces({ includeDeleted: true })) {
      try {
        if (clearComposioInlineCache(store.workspaceDir(workspace.id))) {
          cleared += 1;
        }
      } catch {
        // A single unreadable workspace dir must not stop the others.
      }
    }
  } catch {
    return cleared;
  }
  if (cleared > 0) {
    logger?.info?.("composio inline tool cache invalidated", { workspaces: cleared });
  }
  return cleared;
}
