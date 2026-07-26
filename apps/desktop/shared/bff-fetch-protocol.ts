/**
 * Wire format for the `bff:fetch` IPC channel.
 *
 * The renderer cannot fetch the BFF directly: Chromium 138+ blocks
 * third-party cookies even with `SameSite=None; Secure`, and a thick-client
 * Electron app (renderer at file:// or http://localhost:5173) is third-party
 * to api.holaos.ai / api.imerchstaging.com. Going through main process side-
 * steps that entirely (main fetch is server-side, not subject to browser
 * cookie policy) and keeps the auth cookie out of renderer memory.
 *
 * This is a deliberately tiny subset of the fetch API — JSON request/response
 * only. Streaming bodies, AbortSignal, redirect mode, etc. are out of scope;
 * if a use case needs them, add them to this protocol explicitly rather than
 * leaking the full RequestInit shape across the IPC boundary.
 */

export type BffFetchRequest = {
  /** Absolute URL. The main-side handler enforces a host allowlist. */
  url: string;
  method: string;
  /** Plain string headers; `Cookie` is rejected — main injects it. */
  headers: Record<string, string>;
  /** Stringified body (JSON, plain text). Binary uploads not supported. */
  body?: string;
};

export type BffFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw response body as text. Caller decodes (JSON.parse, etc.). */
  body: string;
};

/**
 * Header names the renderer is not allowed to set. Cookie is owned by main
 * (injected from Better-Auth electron client), Host/Origin/etc. are managed
 * by the network stack.
 */
export const BFF_FETCH_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "cookie",
  "host",
  "content-length",
  "connection",
]);

export const BFF_FETCH_CHANNEL = "bff:fetch";
