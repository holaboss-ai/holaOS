/**
 * Wait for a Composio connected_account to settle (ACTIVE, FAILED, EXPIRED,
 * INACTIVE) after the user has been sent through an external OAuth flow.
 *
 * Design goal — minimal: the only trigger is the desktop window regaining
 * focus. While the user is in their browser doing OAuth, nothing polls
 * (Chromium throttles background timers anyway, and burning Composio quota
 * blindly is wasteful). When the user comes back, we run a tight check
 * burst that covers Composio's typical INITIATED → ACTIVE flip latency.
 *
 * If a check burst exhausts itself without ACTIVE, the helper goes idle and
 * waits for the next focus event — so a user who peeks at Electron, sees
 * "still waiting", and goes back to the browser to finish OAuth will get a
 * fresh check burst when they return again.
 *
 * Resolves with:
 *   - { status: "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" } — terminal
 *   - { cancelled: true } — caller aborted via signal
 *   - { timedOut: true } — safety net at SAFETY_TIMEOUT_MS (10 min)
 */

type ComposioStatusFetcher = (
  connectedAccountId: string,
  providerId: string | null,
) => Promise<{ status?: string }>;

export type ComposioConnectionOutcome =
  | { status: "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" }
  | { cancelled: true }
  | { timedOut: true };

const CHECK_BURST_INTERVAL_MS = 1500;
const CHECK_BURST_MAX_ITERATIONS = 20;
const SAFETY_TIMEOUT_MS = 10 * 60 * 1000;

export interface WaitForComposioConnectionParams {
  connectedAccountId: string;
  signal: AbortSignal;
  /** Injection point — production callers pass
   *  `window.electronAPI.workspace.composioAccountStatus`. */
  fetchStatus: ComposioStatusFetcher;
}

export function waitForComposioConnectionSettled(
  params: WaitForComposioConnectionParams,
): Promise<ComposioConnectionOutcome> {
  const { connectedAccountId, signal, fetchStatus } = params;
  return new Promise<ComposioConnectionOutcome>((resolve) => {
    let resolved = false;
    let burstInFlight = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      signal.removeEventListener("abort", onAbort);
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    const settle = (outcome: ComposioConnectionOutcome) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve(outcome);
    };

    const onAbort = () => {
      settle({ cancelled: true });
    };

    async function runCheckBurst() {
      // Re-entrancy guard: a focus event arriving mid-burst is a no-op.
      // The current burst will finish and the next focus event will trigger
      // a fresh one if still needed.
      if (burstInFlight || resolved) {
        return;
      }
      burstInFlight = true;
      try {
        for (let i = 0; i < CHECK_BURST_MAX_ITERATIONS; i++) {
          if (resolved) {
            return;
          }
          if (signal.aborted) {
            settle({ cancelled: true });
            return;
          }
          try {
            const result = await fetchStatus(connectedAccountId, null);
            if (resolved) {
              return;
            }
            const upper = (result.status ?? "").toUpperCase();
            if (upper === "ACTIVE") {
              settle({ status: "ACTIVE" });
              return;
            }
            if (
              upper === "FAILED" ||
              upper === "EXPIRED" ||
              upper === "INACTIVE"
            ) {
              settle({ status: upper });
              return;
            }
            // INITIATED / INITIATING / MISSING — Composio hasn't finished
            // flipping yet. Sleep and try again until the burst budget is
            // exhausted.
          } catch {
            // Network blip — try again on the next iteration. A persistent
            // error path would burn the burst budget and then idle until
            // the next focus event.
          }
          await new Promise((r) => setTimeout(r, CHECK_BURST_INTERVAL_MS));
        }
        // Burst exhausted without a terminal status. Stay subscribed; the
        // next `focus` event triggers a fresh burst.
      } finally {
        burstInFlight = false;
      }
    }

    const onFocus = () => {
      void runCheckBurst();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("focus", onFocus);

    safetyTimer = setTimeout(() => {
      settle({ timedOut: true });
    }, SAFETY_TIMEOUT_MS);

    // If the desktop window is already focused at start — e.g. OAuth opened
    // in a way that didn't transfer focus, or the user clicked back very
    // quickly — fire an immediate burst rather than waiting for the next
    // focus event (which won't come).
    if (document.hasFocus()) {
      void runCheckBurst();
    }
  });
}
