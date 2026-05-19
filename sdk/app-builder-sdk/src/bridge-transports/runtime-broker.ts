// Runtime-broker transport — production path inside the Holaboss runtime.
//
// Uses the same `/broker/proxy` endpoint + grant-based auth as the legacy
// `@holaboss/bridge` SDK, so this SDK's apps slot into existing sandbox
// integration infrastructure with no runtime-side changes.
//
// The runtime injects two env vars when launching an SDK app:
//   - HOLABOSS_INTEGRATION_BROKER_URL   in-sandbox runtime URL
//   - HOLABOSS_APP_GRANT                grant:<workspaceId>:<appId>:<nonce>
//
// On broker-level errors (grant invalid, binding missing, connection inactive,
// token unavailable) the transport returns the HTTP status as-is, so
// BridgeClient can map them to typed BridgeError codes (`not_connected`,
// `validation_failed`, etc.).
//
// On broker success the response is `{ data, status, headers }` where `status`
// is the UPSTREAM provider's status (might be Slack's 200 + body.ok:false, a
// 429 from Twitter, etc.) — this transport faithfully passes it through so
// provider-specific handling stays in the app code.

import type { TransportFn } from "../bridge.ts"

export interface RuntimeBrokerOpts {
  /** Provider id (e.g. "slack", "twitter"). Required — broker uses it to
   *  look up the integration binding for the grant's workspace+app. */
  provider: string
  /** Broker URL. Defaults to HOLABOSS_INTEGRATION_BROKER_URL env. */
  brokerUrl?: string
  /** App grant token. Defaults to HOLABOSS_APP_GRANT env. */
  grant?: string
  fetchImpl?: typeof fetch
}

export function createRuntimeBrokerTransport(opts: RuntimeBrokerOpts): TransportFn {
  const brokerUrl = (opts.brokerUrl ?? process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "")
    .replace(/\/+$/, "")
  const grant = opts.grant ?? process.env.HOLABOSS_APP_GRANT ?? ""

  if (!brokerUrl) {
    throw new Error(
      "runtime-broker transport: HOLABOSS_INTEGRATION_BROKER_URL not set and no brokerUrl override provided",
    )
  }
  if (!grant) {
    throw new Error(
      "runtime-broker transport: HOLABOSS_APP_GRANT not set and no grant override provided",
    )
  }
  if (!opts.provider) {
    throw new Error("runtime-broker transport: provider is required")
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const provider = opts.provider

  return async ({ method, url, body }) => {
    const r = await fetchImpl(`${brokerUrl}/broker/proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant,
        provider,
        request: {
          method,
          endpoint: url,
          ...(body !== undefined ? { body } : {}),
        },
      }),
    })

    // Broker-level failure (HTTP non-2xx from /broker/proxy itself).
    // Body shape from integration-broker.ts: { error: <code>, message: <text> }
    // SDK BridgeClient maps the status to typed error codes.
    if (!r.ok) {
      const text = await r.text().catch(() => "")
      let parsed: unknown = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = { _raw: text } }

      // Recast Hono-upstream auth failures to 401 so bridge.ts maps them to
      // `not_connected` and the agent surfaces "please re-login to Holaboss"
      // instead of a generic upstream 5xx. The cookie-crash signature is a 5xx
      // from runtime's ComposioService wrapping Hono's response — the error
      // string "Composio proxy via Hono failed: ..." is stable across the
      // crash and the auth-rejection paths (see runtime/api-server/src/
      // composio-service.ts).
      if (isHonoAuthFailure(r.status, parsed)) {
        return {
          status: 401,
          body: {
            error: "holaboss_session_invalid",
            message:
              "Holaboss session is invalid or expired. Log in to Holaboss in the desktop app, " +
              "then restart desktop so the runtime picks up a fresh auth cookie.",
            broker_status: r.status,
            broker_body: parsed,
          },
          headers: {},
        }
      }
      return { status: r.status, body: parsed, headers: {} }
    }

    // Broker succeeded — unwrap the provider response envelope.
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

function isHonoAuthFailure(brokerStatus: number, body: unknown): boolean {
  if (brokerStatus < 400) return false
  if (!body || typeof body !== "object") return false
  const r = body as Record<string, unknown>
  const candidate =
    (typeof r.detail === "string" ? r.detail : null) ??
    (typeof r.message === "string" ? r.message : null) ??
    (typeof r.error === "string" ? r.error : null)
  if (!candidate) return false
  return /Composio proxy via Hono failed/i.test(candidate)
}
