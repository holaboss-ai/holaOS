// Composio direct transport — talks to Composio's REST API without going
// through any Holaboss backend (no Hono, no cookie, no runtime, no grant).
//
// Use this when you hold the Composio API key directly (single-tenant deploy,
// E2E test scripts, local development). For multi-tenant production where
// Composio API key must NOT be exposed to the caller, use a different
// transport that brokers through your backend.
//
// Auth: COMPOSIO_API_KEY header (your Holaboss-deployment key).
// Identity: connected_account_id (per-provider, per-user, set up via OAuth flow).

import type { TransportFn } from "../bridge.ts"

export interface ComposioDirectOpts {
  /** Composio API base URL. Default: https://backend.composio.dev */
  composioBaseUrl?: string
  /** COMPOSIO_API_KEY for your deployment. */
  apiKey: string
  /**
   * Composio connected_account_id for the target provider.
   * Set up via Composio OAuth flow (e.g. via desktop UI), then read from
   * workspace.db integration_connections.account_external_id.
   */
  connectedAccountId: string
  fetchImpl?: typeof fetch
}

export function createComposioDirectTransport(opts: ComposioDirectOpts): TransportFn {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = (opts.composioBaseUrl ?? "https://backend.composio.dev").replace(/\/+$/, "")

  return async ({ method, url, body }) => {
    const r = await fetchImpl(`${base}/api/v3/tools/execute/proxy`, {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        connected_account_id: opts.connectedAccountId,
        endpoint: url,           // Composio expects absolute URL
        method,
        ...(body !== undefined ? { body } : {}),
      }),
    })

    // Composio wraps successful provider responses as { data, status, headers }.
    // Non-2xx from Composio means Composio itself errored (auth / quota / etc.)
    if (!r.ok) {
      const text = await r.text().catch(() => "")
      let parsed: unknown = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = { _raw: text } }
      return { status: r.status, body: parsed, headers: {} }
    }

    const payload = (await r.json()) as {
      data?: unknown
      status?: number
      headers?: Record<string, string>
    }
    return {
      status: payload.status ?? r.status,
      body: payload.data ?? null,
      headers: payload.headers ?? {},
    }
  }
}
