/**
 * App-level cache for Composio whoami metadata, keyed by connection_id.
 *
 * Why a module-level singleton: three surfaces (IntegrationsPane,
 * AppSurfacePane toolbar picker, AppCatalogCard install picker) all need
 * the same `composioAccountStatus()` data. Keeping each component's local
 * `useState<Map>` meant N parallel fetches per session and per-component
 * render shimmer ("Account 1" → "@joshua") every time a different surface
 * mounted. This store dedupes inflight fetches by external_id and lets
 * any consumer subscribe via `useSyncExternalStore`.
 *
 * Append-only by default — a transient fetch failure won't blank an
 * avatar already on screen. Mutations come only from successful fetches
 * or explicit `invalidate*` calls (used after dedupe merges).
 */

import { useEffect } from "react";
import { useSyncExternalStore } from "react";

type Listener = () => void;

let snapshot: Map<string, ComposioAccountStatus> = new Map();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

function commit(next: Map<string, ComposioAccountStatus>) {
  if (next === snapshot) return;
  snapshot = next;
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Map<string, ComposioAccountStatus> {
  return snapshot;
}

function fetchOnce(
  connectionId: string,
  externalId: string,
  providerId: string,
): Promise<void> {
  // Dedupe by external_id — multiple connection_ids can share the same
  // Composio account post-merge, and we'd rather hit the API once.
  const existing = inflight.get(externalId);
  if (existing) return existing;

  const promise = window.electronAPI.workspace
    .composioAccountStatus(externalId, providerId)
    .then(
      (status) => {
        const next = new Map(snapshot);
        next.set(connectionId, status);
        commit(next);
      },
      () => {
        // Swallow — append-only. The next consumer mount will retry.
      },
    )
    .finally(() => {
      inflight.delete(externalId);
    });

  inflight.set(externalId, promise);
  return promise;
}

/**
 * Subscribe to whoami metadata for the given connections. Triggers a
 * fetch for any connection whose metadata isn't cached yet; returns the
 * full snapshot map on every store update.
 */
export function useIntegrationAccountMetadata(
  connections: IntegrationConnectionPayload[],
): Map<string, ComposioAccountStatus> {
  const meta = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    for (const c of connections) {
      const externalId = c.account_external_id;
      if (!externalId) continue;
      if (snapshot.has(c.connection_id)) continue;
      void fetchOnce(c.connection_id, externalId, c.provider_id);
    }
  }, [connections]);

  return meta;
}

/**
 * Drop cached entries for the given connection_ids (or all entries when
 * called with no argument). Use after dedupe merges so other surfaces
 * don't keep showing rows for connections that no longer exist.
 */
export function invalidateIntegrationAccountCache(
  connectionIds?: readonly string[],
): void {
  if (connectionIds && connectionIds.length > 0) {
    let mutated = false;
    const next = new Map(snapshot);
    for (const id of connectionIds) {
      if (next.delete(id)) mutated = true;
    }
    if (mutated) commit(next);
    return;
  }
  if (snapshot.size === 0) return;
  commit(new Map());
}
