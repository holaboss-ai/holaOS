import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagedConnectLink,
  getConnectedAccount,
  waitForConnectedAccount,
  proxyProviderRequest
} from "./composio-minimal-example.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

test("createManagedConnectLink reuses an enabled managed auth config before creating a link", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.includes("/api/v3/auth_configs?")) {
      return jsonResponse({
        items: [
          {
            id: "authcfg_existing",
            status: "ENABLED",
            is_composio_managed: true,
            toolkit: { slug: "gmail" }
          }
        ]
      });
    }
    if (url.endsWith("/api/v3/connected_accounts/link")) {
      return jsonResponse(
        {
          link_token: "lt_123",
          redirect_url: "https://auth.composio.dev/connect?token=lt_123",
          expires_at: "2026-04-01T00:00:00.000Z",
          connected_account_id: "ca_123"
        },
        { status: 201 }
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const result = await createManagedConnectLink({
    apiKey: "test-key",
    toolkitSlug: "gmail",
    userId: "user-1",
    callbackUrl: "https://example.com/callback",
    fetchImpl
  });

  assert.deepEqual(result, {
    authConfigId: "authcfg_existing",
    authConfigCreated: false,
    connectedAccountId: "ca_123",
    redirectUrl: "https://auth.composio.dev/connect?token=lt_123",
    expiresAt: "2026-04-01T00:00:00.000Z",
    userId: "user-1"
  });
  assert.equal(calls.length, 2);
  assert.match(String(calls[0]?.input), /toolkit_slug=gmail/);
  assert.match(String(calls[0]?.input), /is_composio_managed=true/);
  assert.equal(calls[1]?.init?.method, "POST");
});

test("getConnectedAccount returns normalized account data", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    assert.match(url, /\/api\/v3\/connected_accounts\/ca_100$/);
    return jsonResponse({
      id: "ca_100",
      status: "ACTIVE",
      auth_config: { id: "authcfg_1" },
      toolkit: { slug: "gmail" },
      user_id: "user-1"
    });
  };

  const account = await getConnectedAccount({
    apiKey: "test-key",
    connectedAccountId: "ca_100",
    fetchImpl
  });

  assert.deepEqual(account, {
    id: "ca_100",
    status: "ACTIVE",
    authConfigId: "authcfg_1",
    toolkitSlug: "gmail",
    userId: "user-1"
  });
});

test("waitForConnectedAccount resolves immediately when already ACTIVE", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return jsonResponse({
      id: "ca_200",
      status: "ACTIVE",
      auth_config: { id: "authcfg_2" },
      toolkit: { slug: "github" },
      user_id: "user-2"
    });
  };

  const account = await waitForConnectedAccount({
    apiKey: "test-key",
    connectedAccountId: "ca_200",
    fetchImpl,
    timeoutMs: 5_000,
    intervalMs: 100
  });

  assert.equal(account.status, "ACTIVE");
  assert.equal(callCount, 1);
});

test("waitForConnectedAccount polls until ACTIVE", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    const status = callCount >= 3 ? "ACTIVE" : "INITIATED";
    return jsonResponse({
      id: "ca_300",
      status,
      auth_config: { id: "authcfg_3" },
      toolkit: { slug: "gmail" },
      user_id: "user-3"
    });
  };

  const account = await waitForConnectedAccount({
    apiKey: "test-key",
    connectedAccountId: "ca_300",
    fetchImpl,
    timeoutMs: 10_000,
    intervalMs: 10
  });

  assert.equal(account.status, "ACTIVE");
  assert.equal(callCount, 3);
});

test("waitForConnectedAccount throws on timeout", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse({ id: "ca_400", status: "initiated" });
  };

  await assert.rejects(
    () =>
      waitForConnectedAccount({
        apiKey: "test-key",
        connectedAccountId: "ca_400",
        fetchImpl,
        timeoutMs: 50,
        intervalMs: 20
      }),
    (error: Error) => {
      assert.match(error.message, /did not become ACTIVE/);
      assert.match(error.message, /INITIATED/);
      return true;
    }
  );
});

test("proxyProviderRequest sends correct request and returns envelope response", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      data: { emailAddress: "test@gmail.com", messagesTotal: 42 },
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await proxyProviderRequest<{ emailAddress: string; messagesTotal: number }>({
    apiKey: "test-key",
    connectedAccountId: "ca_500",
    method: "GET",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    fetchImpl
  });

  assert.equal(result.status, 200);
  assert.equal(result.data?.emailAddress, "test@gmail.com");
  assert.equal(result.data?.messagesTotal, 42);
  assert.equal(result.headers["content-type"], "application/json");

  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.input), /\/api\/v3\/tools\/execute\/proxy$/);
  assert.equal(calls[0]?.init?.method, "POST");

  const body = JSON.parse(calls[0]?.init?.body as string);
  assert.equal(body.connected_account_id, "ca_500");
  assert.equal(body.method, "GET");
  assert.equal(body.endpoint, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(body.body, undefined);
});

test("proxyProviderRequest includes body for POST requests", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      data: { id: "msg_123", threadId: "thread_456" },
      status: 200,
      headers: {}
    });
  };

  const result = await proxyProviderRequest<{ id: string; threadId: string }>({
    apiKey: "test-key",
    connectedAccountId: "ca_600",
    method: "POST",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    body: { raw: "base64encodedmessage" },
    fetchImpl
  });

  assert.equal(result.data?.id, "msg_123");

  const body = JSON.parse(calls[0]?.init?.body as string);
  assert.equal(body.method, "POST");
  assert.deepEqual(body.body, { raw: "base64encodedmessage" });
});

test("proxyProviderRequest throws on non-ok response", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse({ error: "rate limited" }, { status: 429 });
  };

  await assert.rejects(
    () =>
      proxyProviderRequest({
        apiKey: "test-key",
        connectedAccountId: "ca_700",
        method: "GET",
        endpoint: "https://api.github.com/user",
        fetchImpl
      }),
    (error: Error) => {
      assert.match(error.message, /Proxy request failed: 429/);
      return true;
    }
  );
});

test("createManagedConnectLink creates a managed auth config when none exists", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.includes("/api/v3/auth_configs?")) {
      return jsonResponse({ items: [] });
    }
    if (url.endsWith("/api/v3/auth_configs")) {
      return jsonResponse(
        {
          toolkit: { slug: "gmail" },
          auth_config: {
            id: "authcfg_created",
            auth_scheme: "OAUTH2",
            is_composio_managed: true
          }
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/api/v3/connected_accounts/link")) {
      return jsonResponse(
        {
          link_token: "lt_456",
          redirect_url: "https://auth.composio.dev/connect?token=lt_456",
          expires_at: "2026-04-01T00:00:00.000Z",
          connected_account_id: "ca_456"
        },
        { status: 201 }
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const result = await createManagedConnectLink({
    apiKey: "test-key",
    toolkitSlug: "gmail",
    userId: "user-2",
    fetchImpl
  });

  assert.equal(result.authConfigId, "authcfg_created");
  assert.equal(result.authConfigCreated, true);
  assert.equal(result.connectedAccountId, "ca_456");
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(calls[2]?.init?.method, "POST");
});
