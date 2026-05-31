import type { BrowserWindow } from "electron";

import {
  COMPOSIO_EVENTS_INVALIDATED_CHANNEL,
  COMPOSIO_EVENTS_STATUS_CHANNEL,
  type ComposioConnectionInvalidatedEvent,
  type ComposioEventsBridgeStatus,
} from "../shared/composio-events-protocol.js";

/**
 * Main-process bridge that owns the long-lived SSE connection to the cloud
 * BFF's `/api/composio/events` and fans frames out to renderer windows.
 *
 * Why main, not renderer: same constraint as `bff:fetch` — Chromium 138+
 * blocks third-party cookies on cross-site EventSource, so a renderer
 * subscription would silently drop the Better-Auth cookie. Node fetch in
 * main has no such policy.
 *
 * Lifecycle: caller invokes `start()` once auth becomes available, `stop()`
 * on sign-out. The bridge handles transient network failures internally via
 * exponential backoff; sustained `401` shuts it down and waits for the next
 * `start()` (typically driven by `auth:authenticated`).
 */
export type ComposioEventsBridgeDeps = {
  /** Empty string when no session — bridge will refuse to start. */
  getCookieHeader: () => string;
  /** e.g. `https://api.imerchstaging.com`; empty string disables the bridge. */
  getApiBaseUrl: () => string;
  /** Lazy lookup so window recreation doesn't strand us with a stale handle. */
  getTargetWindows: () => readonly BrowserWindow[];
  log?: (event: ComposioEventsBridgeLogEvent) => void;
};

export type ComposioEventsBridgeLogEvent =
  | { event: "composio_events.start"; baseUrl: string }
  | { event: "composio_events.open" }
  | { event: "composio_events.frame"; eventType: string; connectionId: string }
  | { event: "composio_events.parse_error"; detail: string }
  | { event: "composio_events.unauthorized" }
  | { event: "composio_events.http_error"; status: number }
  | { event: "composio_events.network_error"; detail: string }
  | {
      event: "composio_events.reconnect_scheduled";
      attempt: number;
      delayMs: number;
    }
  | { event: "composio_events.stop"; reason: string };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PATH = "/api/composio/events";

export type ComposioEventsBridge = {
  start: () => void;
  stop: (reason?: string) => void;
  /** Drop the current connection and reconnect immediately (cookie rotated). */
  restart: () => void;
};

export function createComposioEventsBridge(
  deps: ComposioEventsBridgeDeps
): ComposioEventsBridge {
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = true;

  function broadcastStatus(status: ComposioEventsBridgeStatus) {
    for (const win of deps.getTargetWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(COMPOSIO_EVENTS_STATUS_CHANNEL, status);
    }
  }

  function broadcastEvent(payload: ComposioConnectionInvalidatedEvent) {
    for (const win of deps.getTargetWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(COMPOSIO_EVENTS_INVALIDATED_CHANNEL, payload);
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const delayMs = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** attempt
    );
    attempt += 1;
    deps.log?.({
      event: "composio_events.reconnect_scheduled",
      attempt,
      delayMs,
    });
    broadcastStatus({
      state: "reconnecting",
      nextAttemptInMs: delayMs,
      attempt,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const baseUrl = deps.getApiBaseUrl().trim();
    if (!baseUrl) {
      stopped = true;
      broadcastStatus({ state: "stopped", reason: "no_api_base_url" });
      deps.log?.({ event: "composio_events.stop", reason: "no_api_base_url" });
      return;
    }
    const cookie = deps.getCookieHeader();
    if (!cookie) {
      // No session yet. Don't burn the backoff budget — wait for `start()` to
      // be called again from an auth lifecycle event.
      stopped = true;
      broadcastStatus({ state: "stopped", reason: "no_cookie" });
      deps.log?.({ event: "composio_events.stop", reason: "no_cookie" });
      return;
    }

    controller?.abort();
    controller = new AbortController();
    const localController = controller;

    const url = `${baseUrl.replace(/\/$/u, "")}${PATH}`;
    deps.log?.({ event: "composio_events.start", baseUrl });
    broadcastStatus({ state: "connecting" });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          Cookie: cookie,
        },
        signal: localController.signal,
        // Match the BFF reverse-proxy contract — surface redirects so we
        // don't get hijacked into an auth flow over a long-lived stream.
        redirect: "manual",
      });
    } catch (error) {
      if (localController.signal.aborted) return;
      const detail = error instanceof Error ? error.message : String(error);
      deps.log?.({ event: "composio_events.network_error", detail });
      scheduleReconnect();
      return;
    }

    if (response.status === 401 || response.status === 403) {
      deps.log?.({ event: "composio_events.unauthorized" });
      stopped = true;
      broadcastStatus({ state: "stopped", reason: `http_${response.status}` });
      return;
    }
    if (!response.ok || !response.body) {
      deps.log?.({
        event: "composio_events.http_error",
        status: response.status,
      });
      scheduleReconnect();
      return;
    }

    // Connected: reset backoff and hand off to the reader loop. Any
    // termination of the loop (clean EOF, error, abort) routes through
    // `scheduleReconnect` unless the bridge was explicitly stopped.
    attempt = 0;
    broadcastStatus({ state: "open" });
    deps.log?.({ event: "composio_events.open" });

    try {
      await readSseStream(response.body, (data) => {
        const parsed = tryParseInvalidationFrame(data);
        if (!parsed) {
          deps.log?.({
            event: "composio_events.parse_error",
            detail: data.slice(0, 200),
          });
          return;
        }
        deps.log?.({
          event: "composio_events.frame",
          eventType: parsed.event_type,
          connectionId: parsed.connection_id,
        });
        broadcastEvent(parsed);
      });
    } catch (error) {
      if (localController.signal.aborted) return;
      const detail = error instanceof Error ? error.message : String(error);
      deps.log?.({ event: "composio_events.network_error", detail });
    }

    if (!stopped) {
      scheduleReconnect();
    }
  }

  return {
    start() {
      stopped = false;
      attempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void connect();
    },
    stop(reason = "manual") {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
      controller = null;
      attempt = 0;
      broadcastStatus({ state: "stopped", reason });
      deps.log?.({ event: "composio_events.stop", reason });
    },
    restart() {
      controller?.abort();
      controller = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopped = false;
      attempt = 0;
      void connect();
    },
  };
}

/**
 * Drain a `text/event-stream` body, invoking `onData` once per SSE event
 * with the decoded `data:` payload. Lines beginning with `:` are comments
 * (Composio sends `: connected` as the keep-alive frame) and are ignored.
 *
 * Only `data:` lines are surfaced — `event:` / `id:` / `retry:` are
 * intentionally dropped because the Composio bridge protocol doesn't use
 * them; if that changes, add named-event dispatch here.
 *
 * Exported for tests; consumers should use `createComposioEventsBridge`.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // Loop terminates when the server closes the stream (`done: true`) or the
  // underlying fetch is aborted (the reader throws). Both cases bubble up
  // to the caller, which decides whether to reconnect.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    // SSE events end on a blank line. Use a regex to handle CRLF + LF mixes.
    const events = buffer.split(/\r?\n\r?\n/u);
    buffer = events.pop() ?? "";
    for (const raw of events) {
      const lines = raw.split(/\r?\n/u);
      const dataParts: string[] = [];
      for (const line of lines) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          dataParts.push(line.slice(5).replace(/^\s/u, ""));
        }
      }
      if (dataParts.length > 0) {
        onData(dataParts.join("\n"));
      }
    }
  }
}

export function tryParseInvalidationFrame(
  raw: string
): ComposioConnectionInvalidatedEvent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type !== "connection.invalidated") return null;
    const connectionId =
      typeof parsed.connection_id === "string" ? parsed.connection_id : null;
    if (!connectionId) return null;
    const eventType =
      typeof parsed.event_type === "string" ? parsed.event_type : "";
    return {
      type: "connection.invalidated",
      connection_id: connectionId,
      event_type: eventType,
      received_at: Date.now(),
    };
  } catch {
    return null;
  }
}
