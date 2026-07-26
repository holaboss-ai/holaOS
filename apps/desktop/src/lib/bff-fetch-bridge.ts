/**
 * fetch-compatible wrapper that proxies BFF calls through the Electron main
 * process. Use this anywhere you'd reach for `globalThis.fetch` to hit the
 * Hono BFF (api.holaos.ai / api.imerchstaging.com).
 *
 * Why: Chromium 138+ blocks third-party cookies on cross-site fetch even
 * with `SameSite=None; Secure`. The renderer (origin localhost:5173 in dev,
 * file:// when packaged) is third-party to api.*.holaboss.ai, so direct
 * fetch + `credentials: include` silently drops the auth cookie.
 *
 * Going through main is a Node-side fetch — no browser cookie policy in
 * play. Main owns the cookie and injects it on each request.
 */
import type {
  BffFetchRequest,
  BffFetchResponse,
} from "../../shared/bff-fetch-protocol";

class BffFetchUnsupportedBodyError extends Error {
  constructor(actual: string) {
    super(
      `bffFetch only supports string bodies (typically JSON.stringify(...)). Got: ${actual}. Streams, FormData, and Blob are not supported across the IPC boundary — serialize before calling.`
    );
    this.name = "BffFetchUnsupportedBodyError";
  }
}

function resolveUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function serializeRequestHeaders(input: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) {
    return out;
  }
  new Headers(input).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function serializeRequestBody(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return;
  }
  if (typeof body === "string") {
    return body;
  }
  // Anything else needs an explicit fix at the call site — we'd rather throw
  // than silently send wrong bytes.
  const constructorName = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
  throw new BffFetchUnsupportedBodyError(constructorName);
}

/**
 * Drop-in for `globalThis.fetch`, scoped to BFF endpoints (host allowlisted
 * in main). Call sites can use `.json()`, `.text()`, `.headers.get(...)`
 * exactly as with the native API.
 */
export async function bffFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const req: BffFetchRequest = {
    url: resolveUrl(input),
    method: (init?.method ?? "GET").toUpperCase(),
    headers: serializeRequestHeaders(init?.headers),
    body: serializeRequestBody(init?.body),
  };

  const resp: BffFetchResponse = await window.electronAPI.bff.fetch(req);

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: new Headers(resp.headers),
  });
}
