import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { remoteApi } from "./remoteApiClient";

/**
 * TanStack Query bindings for the Remote API. The standard for desktop
 * server/runtime data:
 *
 *   - request/response runtime data (reads/writes via remote-api) → TanStack
 *     Query through these utils (`remoteApiQuery.<domain>.<op>.queryOptions(...)`
 *     / `.mutationOptions(...)`), which gives end-to-end typed options + a
 *     consistent query key derived from the contract path.
 *   - UI / selection state → useState / Jotai.
 *   - event-pushed state (e.g. runtime:state) → subscriptions / Jotai.
 *
 * Invalidate related queries after a mutation, e.g.
 *   queryClient.invalidateQueries({ queryKey: remoteApiQuery.memory.key() })
 */
export const remoteApiQuery = createTanstackQueryUtils(remoteApi);
