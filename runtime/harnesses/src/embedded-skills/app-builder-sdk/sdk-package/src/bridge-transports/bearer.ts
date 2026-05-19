// Generic OAuth bearer-token transport.
//
// Use this when YOU manage OAuth — your own auth server, Auth0, Clerk, manual
// token issuance, anything. The SDK doesn't care where the token comes from;
// it only cares that this transport produces requests with a valid Bearer
// header.
//
// Token refresh is NOT this transport's job. Either:
//   - pass a sync `accessToken: string` (the SDK will not retry on 401)
//   - pass an async getter `accessToken: () => Promise<string>` that returns
//     a currently-valid token (your OAuth client handles refresh internally)
//
// On 401/403 the SDK's BridgeClient surfaces a typed `not_connected` error
// with reauthUrl hint based on the provider registry; YOU are responsible for
// driving the user back through OAuth.

import type { TransportFn } from "../bridge.ts"

export interface BearerTokenOpts {
  /** Either a static token or a function that returns a currently-valid token. */
  accessToken: string | (() => string | Promise<string>)
  /** Extra headers to merge into every request (e.g. User-Agent). */
  defaultHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}

export function createBearerTokenTransport(opts: BearerTokenOpts): TransportFn {
  const fetchImpl = opts.fetchImpl ?? fetch

  return async ({ method, url, body }) => {
    const token = typeof opts.accessToken === "function"
      ? await opts.accessToken()
      : opts.accessToken

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...opts.defaultHeaders,
    }
    if (body !== undefined) headers["Content-Type"] = "application/json"

    const r = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    let parsed: unknown = null
    const text = await r.text()
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = { _raw: text } }
    }

    const respHeaders: Record<string, string> = {}
    r.headers.forEach((v, k) => { respHeaders[k] = v })

    return { status: r.status, body: parsed, headers: respHeaders }
  }
}
