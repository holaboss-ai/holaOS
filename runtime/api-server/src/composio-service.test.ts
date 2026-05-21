import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposioService,
  type ComposioServiceConfig,
  ComposioToolExecutionError
} from "./composio-service.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

function createService(fetchImpl: typeof fetch, overrides: Partial<ComposioServiceConfig> = {}): ComposioService {
  return new ComposioService({
    honoBaseUrl: "https://app.holaboss.test/",
    authCookie: "hb_session=abc123",
    fetchImpl,
    ...overrides
  });
}

test("proxyRequest forwards the Hono session cookie and returns the envelope payload", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      data: { emailAddress: "test@gmail.com", messagesTotal: 42 },
      status: 201,
      headers: { "content-type": "application/json" }
    });
  };

  const service = createService(fetchImpl);
  const result = await service.proxyRequest<{ emailAddress: string; messagesTotal: number }>({
    connectedAccountId: "ca_500",
    method: "GET",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile"
  });

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "https://app.holaboss.test/api/composio/proxy");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.Cookie, "hb_session=abc123");

  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    connected_account_id: "ca_500",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    method: "GET"
  });

  assert.equal(result.status, 201);
  assert.equal(result.data?.emailAddress, "test@gmail.com");
  assert.equal(result.data?.messagesTotal, 42);
  assert.equal(result.headers["content-type"], "application/json");
});

test("proxyRequest includes the optional request body for mutating calls", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({
      data: { id: "msg_123" },
      status: 200,
      headers: {}
    });
  };

  const service = createService(fetchImpl, { honoBaseUrl: "https://edge.holaboss.test" });
  const result = await service.proxyRequest<{ id: string }>({
    connectedAccountId: "ca_600",
    method: "POST",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    body: { raw: "base64encodedmessage" }
  });

  assert.equal(result.data?.id, "msg_123");
  assert.deepEqual(capturedBody, {
    connected_account_id: "ca_600",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    method: "POST",
    body: { raw: "base64encodedmessage" }
  });
});

test("proxyRequest falls back to the HTTP status when the Hono payload omits status", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse(
      {
        data: { ok: true },
        headers: { "x-test": "1" }
      },
      { status: 202 }
    );
  };

  const service = createService(fetchImpl);
  const result = await service.proxyRequest<{ ok: boolean }>({
    connectedAccountId: "ca_700",
    method: "DELETE",
    endpoint: "https://api.github.com/user/installations/123"
  });

  assert.equal(result.status, 202);
  assert.equal(result.data?.ok, true);
  assert.equal(result.headers["x-test"], "1");
});

test("constructor strips leading '; ' from authCookie (Better Auth Electron client quirk)", async () => {
  // Better Auth's Electron client returns the cookie header as `; name=value` so
  // it can be spliced onto an existing Cookie header. When passed verbatim as a
  // fresh Cookie header the leading empty pair crashes Hono's auth middleware
  // on Cloudflare Workers (Worker bubbles a generic 500 instead of clean 401).
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({ data: null, status: 200, headers: {} });
  };
  const service = createService(fetchImpl, {
    authCookie: "; __Secure-better-auth.session_token=abc.def.ghi"
  });
  await service.proxyRequest({
    connectedAccountId: "ca_1",
    method: "GET",
    endpoint: "https://slack.com/api/auth.test"
  });
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Cookie, "__Secure-better-auth.session_token=abc.def.ghi");
});

test("constructor strips multiple leading semicolons + whitespace", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({ data: null, status: 200, headers: {} });
  const service = createService(fetchImpl, { authCookie: " ;; ; hb_session=x; other=y" });
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const trackingFetch: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return fetchImpl(input, init);
  };
  const tracked = createService(trackingFetch, { authCookie: " ;; ; hb_session=x; other=y" });
  await tracked.proxyRequest({
    connectedAccountId: "ca_2",
    method: "GET",
    endpoint: "https://api.test/whoami"
  });
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Cookie, "hb_session=x; other=y");
  // sanity: original service also has the stripped value (constructor-side, not call-site)
  void service;
});

test("constructor leaves a normal cookie untouched", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({ data: null, status: 200, headers: {} });
  };
  const service = createService(fetchImpl, { authCookie: "hb_session=plain; other=x" });
  await service.proxyRequest({
    connectedAccountId: "ca_3",
    method: "GET",
    endpoint: "https://api.test/whoami"
  });
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Cookie, "hb_session=plain; other=x");
});

test("proxyRequest throws a descriptive error when the Hono proxy call fails", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response("rate limited", { status: 429 });
  };

  const service = createService(fetchImpl);
  await assert.rejects(
    () =>
      service.proxyRequest({
        connectedAccountId: "ca_800",
        method: "GET",
        endpoint: "https://api.github.com/user"
      }),
    (error: Error) => {
      assert.match(error.message, /Composio proxy via Hono failed: 429/);
      return true;
    }
  );
});

test("executeTool posts to /api/composio/execute with tool_slug + arguments and returns peeled data", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      ok: true,
      data: { emailAddress: "tommy@holaboss.ai", messagesTotal: 626 },
      log_id: "log_-Ttzl7Tql0Y3"
    });
  };

  const service = createService(fetchImpl);
  const result = await service.executeTool<{ emailAddress: string; messagesTotal: number }>({
    toolSlug: "GMAIL_GET_PROFILE",
    connectedAccountId: "ca_4vYjam9qHD46",
    arguments: {}
  });

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "https://app.holaboss.test/api/composio/execute");
  assert.equal(calls[0]?.init?.method, "POST");

  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    tool_slug: "GMAIL_GET_PROFILE",
    connected_account_id: "ca_4vYjam9qHD46",
    arguments: {}
  });

  assert.equal(result.data?.emailAddress, "tommy@holaboss.ai");
  assert.equal(result.data?.messagesTotal, 626);
  assert.equal(result.logId, "log_-Ttzl7Tql0Y3");
});

test("executeTool defaults arguments to {} when caller omits", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true, data: null, log_id: null });
  };

  const service = createService(fetchImpl);
  await service.executeTool({
    toolSlug: "GMAIL_LIST_LABELS",
    connectedAccountId: "ca_1"
  });

  assert.deepEqual(capturedBody, {
    tool_slug: "GMAIL_LIST_LABELS",
    connected_account_id: "ca_1",
    arguments: {}
  });
});

test("executeTool throws ComposioToolExecutionError preserving Hono's structured error envelope", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "connection_expired",
          message: "Connected account is no longer authorized",
          slug: "CONNECTED_ACCOUNT_NOT_ACTIVE",
          connected_account_id: "ca_dead",
          user_action: "reconnect"
        }
      },
      { status: 401 }
    );
  };

  const service = createService(fetchImpl);
  await assert.rejects(
    () =>
      service.executeTool({
        toolSlug: "GMAIL_FETCH_EMAILS",
        connectedAccountId: "ca_dead"
      }),
    (error: unknown) => {
      assert.ok(error instanceof ComposioToolExecutionError);
      assert.equal(error.httpStatus, 401);
      assert.equal(error.detail.code, "connection_expired");
      assert.equal(error.detail.user_action, "reconnect");
      assert.equal(error.detail.connected_account_id, "ca_dead");
      return true;
    }
  );
});

test("listConnections forwards the cookie and maps the Hono /connections payload", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      connections: [
        {
          id: "ca_gmail_1",
          status: "ACTIVE",
          toolkitSlug: "gmail",
          toolkitName: "Gmail",
          toolkitLogo: "https://logos.composio.dev/api/gmail",
          userId: "user_123",
          createdAt: "2026-05-01T00:00:00Z"
        },
        {
          id: "ca_slack_1",
          status: "expired",
          toolkitSlug: "slack",
          toolkitName: "Slack",
          userId: "user_123",
          createdAt: "2026-05-02T00:00:00Z"
        }
      ]
    });
  };

  const service = createService(fetchImpl);
  const connections = await service.listConnections();

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "https://app.holaboss.test/api/composio/connections");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.Cookie, "hb_session=abc123");

  assert.equal(connections.length, 2);
  assert.equal(connections[0]?.id, "ca_gmail_1");
  assert.equal(connections[0]?.status, "ACTIVE");
  assert.equal(connections[0]?.toolkitSlug, "gmail");
  // lowercased status from Hono gets normalized to upper
  assert.equal(connections[1]?.status, "EXPIRED");
});

test("listConnections throws when Hono returns non-2xx", async () => {
  const fetchImpl: typeof fetch = async () => new Response("oops", { status: 503 });
  const service = createService(fetchImpl);
  await assert.rejects(
    () => service.listConnections(),
    (error: Error) => {
      assert.match(error.message, /Composio listConnections via Hono failed: 503/);
      return true;
    }
  );
});

test("executeTool surfaces 'unknown_error' when Hono returns a bare non-2xx with no JSON body", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response("Internal Server Error", { status: 500 });
  };

  const service = createService(fetchImpl);
  await assert.rejects(
    () =>
      service.executeTool({
        toolSlug: "GMAIL_FETCH_EMAILS",
        connectedAccountId: "ca_x"
      }),
    (error: unknown) => {
      assert.ok(error instanceof ComposioToolExecutionError);
      assert.equal(error.httpStatus, 500);
      assert.equal(error.detail.code, "unknown_error");
      return true;
    }
  );
});
