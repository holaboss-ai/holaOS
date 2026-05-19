import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  BFF_FETCH_CHANNEL,
  BFF_FETCH_FORBIDDEN_HEADERS,
  type BffFetchRequest,
  type BffFetchResponse,
} from "../shared/bff-fetch-protocol.js";

export type BffFetchHandlerDeps = {
  /**
   * Sync — current Better-Auth Cookie header. Empty string means no session.
   * Renderer never sees this value.
   */
  getCookieHeader: () => string;

  /**
   * Hosts the renderer may target. Hostnames only (e.g.
   * `api.holaboss.ai`), no scheme/port. Re-evaluated per request so config
   * reloads land without restart.
   */
  allowedHosts: () => readonly string[];

  /**
   * Registers the IPC handler. Pass `handleTrustedIpc` from main to apply
   * the project's standard sender-scope assertion; default registers via
   * `ipcMain.handle` directly.
   */
  register?: (
    channel: string,
    handler: (
      event: IpcMainInvokeEvent,
      req: BffFetchRequest
    ) => Promise<BffFetchResponse>
  ) => void;

  /**
   * Optional structured logger. Receives one of:
   *   { event: "bff_fetch.start", url, method }
   *   { event: "bff_fetch.success", url, status, durationMs }
   *   { event: "bff_fetch.error", url, error, durationMs }
   * Wire to Sentry/pino in main.
   */
  log?: (event: BffFetchLogEvent) => void;

  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
};

export type BffFetchLogEvent =
  | { event: "bff_fetch.start"; url: string; method: string }
  | {
      event: "bff_fetch.success";
      url: string;
      method: string;
      status: number;
      durationMs: number;
    }
  | {
      event: "bff_fetch.error";
      url: string;
      method: string;
      durationMs: number;
      error: string;
    };

export class BffFetchAllowlistError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `bff:fetch refused — host not in allowlist for ${url}. Add it to allowedHosts() in main.`
    );
    this.name = "BffFetchAllowlistError";
    this.url = url;
  }
}

function isHostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return allowedHosts.includes(host);
}

function sanitizeHeaders(input: Record<string, string>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (BFF_FETCH_FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      // Drop silently — protocol comment documents this.
      continue;
    }
    out.set(key, value);
  }
  return out;
}

function serializeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`bff:fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Installs the `bff:fetch` IPC handler. Call once from main during boot.
 *
 * The handler:
 *   1. Validates the request URL is in the allowlist.
 *   2. Injects the current auth cookie (renderer never touches it).
 *   3. Forwards via Node fetch — server-side, no browser cookie policy.
 *   4. Serializes the response into JSON-safe shape and returns.
 */
export function installBffFetchHandler(deps: BffFetchHandlerDeps): void {
  const register = deps.register ?? defaultRegister;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  register(BFF_FETCH_CHANNEL, async (_event, req) => {
    const startedAt = Date.now();
    deps.log?.({
      event: "bff_fetch.start",
      url: req.url,
      method: req.method,
    });

    if (!isHostAllowed(req.url, deps.allowedHosts())) {
      throw new BffFetchAllowlistError(req.url);
    }

    const headers = sanitizeHeaders(req.headers);
    const cookie = deps.getCookieHeader();
    if (cookie) {
      headers.set("Cookie", cookie);
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        req.url,
        {
          method: req.method,
          headers,
          body: req.body,
          // The BFF doesn't redirect under normal flow; surface 3xx as-is so
          // the renderer can decide rather than silently following.
          redirect: "manual",
        },
        timeoutMs
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.({
        event: "bff_fetch.error",
        url: req.url,
        method: req.method,
        durationMs,
        error: message,
      });
      throw error;
    }

    const body = await response.text();
    const durationMs = Date.now() - startedAt;
    deps.log?.({
      event: "bff_fetch.success",
      url: req.url,
      method: req.method,
      status: response.status,
      durationMs,
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: serializeResponseHeaders(response.headers),
      body,
    };
  });
}

function defaultRegister(
  channel: string,
  handler: (
    event: IpcMainInvokeEvent,
    req: BffFetchRequest
  ) => Promise<BffFetchResponse>
): void {
  ipcMain.handle(channel, handler);
}
