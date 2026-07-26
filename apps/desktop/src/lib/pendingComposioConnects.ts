/**
 * Durable record of Composio connects that were initiated but not yet confirmed
 * active.
 *
 * Composio creates the connected-account record the instant a connect flow
 * starts (to mint the OAuth redirect URL). The in-session cleanup in
 * IntegrationsPane deletes that record if the flow is abandoned — but it can't
 * run if the desktop app is *killed* mid-OAuth, leaving a permanent "reconnect
 * required" orphan (upstream status "INITIALIZING", which the backend surfaces
 * to the desktop as the ambiguous "UNKNOWN" — so it can't be reconciled by
 * status alone).
 *
 * Persisting the exact account id (localStorage survives restarts) lets the
 * next launch clean up that *specific* abandoned account — no status guessing,
 * so a healthy account that merely reads as UNKNOWN during a transient Composio
 * outage is never touched.
 */

const STORAGE_KEY = "holaboss.pending-composio-connects";

export interface PendingComposioConnect {
  /** Composio connected_account_id. */
  id: string;
  /** Provider id, so the cleanup can re-check the account's real status. */
  provider: string;
}

function read(): PendingComposioConnect[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is PendingComposioConnect =>
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.provider === "string",
    );
  } catch {
    return [];
  }
}

function write(entries: PendingComposioConnect[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable — best effort; cleanup just won't survive a restart.
  }
}

export function addPendingComposioConnect(entry: PendingComposioConnect): void {
  const entries = read().filter((existing) => existing.id !== entry.id);
  entries.push(entry);
  write(entries);
}

export function removePendingComposioConnect(id: string): void {
  const entries = read();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length !== entries.length) {
    write(next);
  }
}

export function listPendingComposioConnects(): PendingComposioConnect[] {
  return read();
}

// In-memory set of connects in progress in THIS session. It complements the
// durable markers: a durable marker present but NOT in-flight means the connect
// was abandoned (e.g. the app was killed) and should be reconciled; in-flight
// means it's still mid-OAuth right now and must never be touched. Being
// in-memory, an app restart clears it — which is exactly when a leftover
// durable marker should be treated as abandoned. Module scope (not a component
// ref) so it survives an IntegrationsPane unmount/remount during the flow.
const inFlight = new Set<string>();

export function markComposioConnectInFlight(id: string): void {
  inFlight.add(id);
}

export function clearComposioConnectInFlight(id: string): void {
  inFlight.delete(id);
}

export function isComposioConnectInFlight(id: string): boolean {
  return inFlight.has(id);
}
