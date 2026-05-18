// Verify the runtime-broker transport's body shape, error mapping, and env
// resolution. Mocks fetch so we don't need a real Holaboss runtime running.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createRuntimeBrokerTransport } from "../src/bridge-transports/runtime-broker.ts"

let capturedRequests: Array<{ url: string; init: RequestInit }> = []
let scriptedResponses: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = []

function mockFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    capturedRequests.push({ url: String(input), init: init ?? {} })
    const next = scriptedResponses.shift()
    if (!next) throw new Error(`no scripted response for ${String(input)}`)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

beforeEach(() => {
  capturedRequests = []
  scriptedResponses = []
})

afterEach(() => {
  delete process.env.HOLABOSS_INTEGRATION_BROKER_URL
  delete process.env.HOLABOSS_APP_GRANT
})

describe("runtime-broker transport", () => {
  test("happy path: POSTs to /broker/proxy with grant + provider + request envelope", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:ws_test:slack_app:nonce123",
      provider: "slack",
      fetchImpl: mockFetch(),
    })

    scriptedResponses.push({
      status: 200,
      body: {
        data: { ok: true, ts: "1700.111", channel: "C123" },
        status: 200,
        headers: { "x-slack-req-id": "abc" },
      },
    })

    const result = await transport({
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "hi" },
    })

    // What the SDK BridgeClient sees:
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, ts: "1700.111", channel: "C123" })
    expect(result.headers!["x-slack-req-id"]).toBe("abc")

    // What was sent to /broker/proxy:
    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!
    expect(req.url).toBe("http://localhost:8080/broker/proxy")
    expect(req.init.method).toBe("POST")
    const sentBody = JSON.parse(req.init.body as string)
    expect(sentBody).toEqual({
      grant: "grant:ws_test:slack_app:nonce123",
      provider: "slack",
      request: {
        method: "POST",
        endpoint: "https://slack.com/api/chat.postMessage",
        body: { channel: "C123", text: "hi" },
      },
    })
  })

  test("env fallback: brokerUrl + grant resolved from HOLABOSS_* env when not passed", async () => {
    process.env.HOLABOSS_INTEGRATION_BROKER_URL = "http://runtime:9000/"  // trailing slash
    process.env.HOLABOSS_APP_GRANT = "grant:ws_env:env_app:env_nonce"

    const transport = createRuntimeBrokerTransport({
      provider: "twitter",
      fetchImpl: mockFetch(),
    })

    scriptedResponses.push({
      status: 200,
      body: { data: { id: "tweet_42" }, status: 200, headers: {} },
    })

    await transport({ method: "GET", url: "https://api.x.com/2/tweets/42" })

    const req = capturedRequests[0]!
    expect(req.url).toBe("http://runtime:9000/broker/proxy")  // trailing slash stripped
    const sentBody = JSON.parse(req.init.body as string)
    expect(sentBody.grant).toBe("grant:ws_env:env_app:env_nonce")
    expect(sentBody.provider).toBe("twitter")
  })

  test("missing brokerUrl throws at construction (early fail)", () => {
    expect(() => createRuntimeBrokerTransport({
      provider: "slack",
      grant: "grant:x:x:x",
      fetchImpl: mockFetch(),
    })).toThrow(/HOLABOSS_INTEGRATION_BROKER_URL/)
  })

  test("missing grant throws at construction", () => {
    expect(() => createRuntimeBrokerTransport({
      provider: "slack",
      brokerUrl: "http://localhost:8080",
      fetchImpl: mockFetch(),
    })).toThrow(/HOLABOSS_APP_GRANT/)
  })

  test("missing provider throws at construction", () => {
    expect(() => createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:x:x:x",
      provider: "",
      fetchImpl: mockFetch(),
    })).toThrow(/provider is required/)
  })

  test("broker-level error (401 grant_invalid): status + body passed through for BridgeClient mapping", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:bad",
      provider: "slack",
      fetchImpl: mockFetch(),
    })

    // Matches integration-broker.ts BrokerError shape for invalid grant
    scriptedResponses.push({
      status: 401,
      body: { error: "grant_invalid", message: "app grant is malformed" },
    })

    const result = await transport({ method: "POST", url: "https://slack.com/api/chat.postMessage" })
    expect(result.status).toBe(401)
    expect(result.body).toEqual({ error: "grant_invalid", message: "app grant is malformed" })
    // BridgeClient will map status 401 → BridgeError code "not_connected" automatically
  })

  test("upstream provider error (200 envelope + status:401 inside): both surfaced correctly", async () => {
    // Broker succeeds (HTTP 200) but upstream Slack returned 401 — the
    // envelope's status field carries the real provider status.
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:x:x:x",
      provider: "slack",
      fetchImpl: mockFetch(),
    })

    scriptedResponses.push({
      status: 200,
      body: {
        data: { error: "token_revoked" },
        status: 401,                 // ← upstream's status, not broker's
        headers: { "retry-after": "3600" },
      },
    })

    const result = await transport({ method: "POST", url: "https://slack.com/api/users.info" })
    expect(result.status).toBe(401)              // surfaces upstream status
    expect(result.body).toEqual({ error: "token_revoked" })
    expect(result.headers!["retry-after"]).toBe("3600")
  })

  test("body omitted when undefined (GET requests don't ship empty body)", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:x:x:x",
      provider: "github",
      fetchImpl: mockFetch(),
    })
    scriptedResponses.push({
      status: 200,
      body: { data: { login: "octocat" }, status: 200, headers: {} },
    })
    await transport({ method: "GET", url: "https://api.github.com/user" })

    const sent = JSON.parse(capturedRequests[0]!.init.body as string)
    expect(sent.request.method).toBe("GET")
    expect(sent.request.endpoint).toBe("https://api.github.com/user")
    expect("body" in sent.request).toBe(false)   // body field absent, not "body: undefined"
  })

  // Holaboss session crashes Hono auth middleware → Worker bubbles up a generic
  // 500 wrapped by runtime's ComposioService. The transport recognises the
  // signature and recasts to 401 so bridge.ts maps to `not_connected` and the
  // agent surfaces "please re-login to Holaboss" instead of "upstream 500".
  test("Hono auth crash (500 with 'Composio proxy via Hono failed' detail) recast to 401", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:x:x:x",
      provider: "slack",
      fetchImpl: mockFetch(),
    })
    scriptedResponses.push({
      status: 500,
      body: { detail: "Composio proxy via Hono failed: 500 Internal Server Error" },
    })

    const result = await transport({ method: "GET", url: "https://slack.com/api/auth.test" })
    expect(result.status).toBe(401)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe("holaboss_session_invalid")
    expect(String(body.message)).toMatch(/log in to holaboss/i)
    expect(body.broker_status).toBe(500)
    expect((body.broker_body as Record<string, unknown>).detail).toMatch(/Composio proxy via Hono failed/)
  })

  test("Hono 401 (clean unauthorized) also recast — same signature in error body", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:x:x:x",
      provider: "slack",
      fetchImpl: mockFetch(),
    })
    scriptedResponses.push({
      status: 500,
      body: { detail: "Composio proxy via Hono failed: 401 {\"error\":\"unauthorized\"}" },
    })

    const result = await transport({ method: "POST", url: "https://slack.com/api/chat.postMessage", body: {} })
    expect(result.status).toBe(401)
    expect((result.body as Record<string, unknown>).error).toBe("holaboss_session_invalid")
  })

  test("non-Hono broker errors (grant_invalid) NOT recast — pass through unchanged", async () => {
    const transport = createRuntimeBrokerTransport({
      brokerUrl: "http://localhost:8080",
      grant: "grant:bad",
      provider: "slack",
      fetchImpl: mockFetch(),
    })
    scriptedResponses.push({
      status: 401,
      body: { error: "grant_invalid", message: "app grant is malformed" },
    })

    const result = await transport({ method: "GET", url: "https://slack.com/api/auth.test" })
    expect(result.status).toBe(401)
    expect((result.body as Record<string, unknown>).error).toBe("grant_invalid")  // NOT holaboss_session_invalid
  })
})
