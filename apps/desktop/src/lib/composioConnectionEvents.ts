/**
 * Renderer-side fanout for Composio `connection.invalidated` events forwarded
 * from main via the `composio:events:*` IPC channel.
 *
 * The IPC listener is installed once on the first subscription; each consumer
 * registers a local callback that runs synchronously on every frame. Use the
 * promise helper when the caller wants to await a specific connection's next
 * invalidation (e.g. shortcutting the OAuth poll loop).
 */

type Listener = (event: ComposioConnectionInvalidatedEventPayload) => void;

const listeners = new Set<Listener>();
let installed = false;

function ensureIpcInstalled(): void {
  if (installed) return;
  if (typeof window === "undefined" || !window.electronAPI?.composio) return;
  installed = true;
  window.electronAPI.composio.onConnectionInvalidated((payload) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(payload);
      } catch {
        // A consumer throwing shouldn't break fanout for the rest.
      }
    }
  });
}

export function subscribeComposioConnectionInvalidated(
  listener: Listener,
): () => void {
  ensureIpcInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resolves with the next invalidation event whose `connection_id` matches
 * `externalId` (Composio's `ca_xxx`). Rejects when `signal` aborts. The
 * caller is responsible for cancelling via the signal if it gives up — the
 * helper does not impose its own timeout.
 */
export function waitForComposioConnectionInvalidation({
  externalId,
  signal,
}: {
  externalId: string;
  signal?: AbortSignal;
}): Promise<ComposioConnectionInvalidatedEventPayload> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }

    let unsubscribe: (() => void) | null = null;
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = null;
      signal?.removeEventListener("abort", onAbort);
    };

    unsubscribe = subscribeComposioConnectionInvalidated((event) => {
      if (event.connection_id !== externalId) return;
      cleanup();
      resolve(event);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
