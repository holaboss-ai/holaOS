/**
 * Wire format for the `composio:events:*` IPC channel.
 *
 * The desktop subscribes to the cloud BFF's `/api/composio/events` SSE
 * stream from the main process (renderer can't open a cross-origin
 * EventSource with cookies — same Chromium third-party cookie constraint
 * that drives `bff:fetch`). Main parses SSE frames, then forwards each
 * `connection.invalidated` event to every webContents via this channel.
 *
 * Renderer subscribers use the event's `connection_id` (Composio's
 * `ca_xxx`) to match against the local integration row's
 * `account_external_id` and trigger a refetch.
 */

/** Channel that main publishes invalidation events on. */
export const COMPOSIO_EVENTS_INVALIDATED_CHANNEL =
  "composio:events:invalidated";

/** Optional channel for bridge-status updates (debug surface). */
export const COMPOSIO_EVENTS_STATUS_CHANNEL = "composio:events:status";

export type ComposioConnectionInvalidatedEvent = {
  type: "connection.invalidated";
  /** Composio connected_account_id (ca_xxx). */
  connection_id: string;
  /** Original Composio event type, e.g. `composio.connected_account.expired`. */
  event_type: string;
  /** ms since epoch. Main stamps this when it parses the frame. */
  received_at: number;
};

export type ComposioEventsBridgeStatus =
  | { state: "idle"; reason?: string }
  | { state: "connecting" }
  | { state: "open" }
  | { state: "reconnecting"; nextAttemptInMs: number; attempt: number }
  | { state: "stopped"; reason: string };
