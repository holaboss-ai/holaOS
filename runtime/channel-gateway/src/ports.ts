import type { IncomingMessage } from "./connector.js";

/**
 * The runtime surface the gateway needs, injected so the channel-gateway package
 * stays decoupled from `@holaboss/runtime-state-store`/api-server. The api-server
 * provides the concrete implementation backed by the SQLite state store. This
 * mirrors how the connectors take repository protocols.
 */

/** A persisted agent output event, normalized for the egress watcher. */
export interface ChannelOutputEvent {
  /** Monotonic store id; carry the highest one back as `afterEventId` next poll. */
  id: number;
  sequence: number;
  /** e.g. "output_delta" | "run_completed" | "run_failed" | "tool_call" | ... */
  eventType: string;
  payload: Record<string, unknown>;
}

export interface FireMessageResult {
  sessionId: string;
  inputId: string;
  /** False when this was an idempotent duplicate (existing input returned). */
  created: boolean;
}

export type TerminalStatus = "completed" | "failed";

export interface PollOutputsResult {
  events: ChannelOutputEvent[];
  /** Highest event id in this batch (or the input `afterEventId` if none). */
  lastEventId: number;
  /** Set when a terminal event was seen in this batch. */
  terminal: TerminalStatus | null;
  /** Final assistant text from a `run_completed` event's `payload.output`. */
  finalText: string | null;
  /** Error text from a `run_failed` event's `payload.error`. */
  error: string | null;
}

/** A deliverable file artifact produced during a turn (a registered output with
 *  a file on disk), resolved to an absolute path the connector can upload. */
export interface ChannelArtifact {
  kind: "image" | "document" | "voice" | "video";
  /** Absolute on-disk path. */
  path: string;
  name: string;
  mimeType?: string;
}

export interface ChannelRuntimePort {
  /**
   * Resolve the concrete workspace id a connection binds to. `requestedWorkspaceId`
   * comes from the connection config; when absent the impl may fall back to the sole
   * workspace. Returns null when it cannot be resolved (caller drops the message).
   */
  resolveWorkspaceId(params: {
    platform: string;
    connectionId: string;
    requestedWorkspaceId?: string | null;
  }): string | null;

  /**
   * Create-or-reuse the session for this message and enqueue its text as a turn —
   * the `fireCronjob` analog. Also records the channel→session conversation binding.
   * Idempotent on `idempotencyKey` (a duplicate returns the existing input).
   */
  fireMessage(params: {
    message: IncomingMessage;
    sessionId: string;
    idempotencyKey: string | null;
  }): FireMessageResult;

  /** Read output events for a turn after `afterEventId` (exclusive). */
  pollOutputs(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    afterEventId: number;
  }): PollOutputsResult;

  /**
   * Deliverable file artifacts produced during a turn — registered outputs that
   * have a file on disk — resolved to absolute paths + a native media kind, so a
   * connector can upload them as attachments. Empty when the turn produced none.
   */
  getTurnArtifacts(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
  }): ChannelArtifact[];
}
