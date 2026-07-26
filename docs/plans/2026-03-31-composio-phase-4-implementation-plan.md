# Composio Managed Auth (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Composio as a managed OAuth backend so users can connect provider accounts (Google, GitHub, etc.) with one click instead of configuring their own OAuth apps or pasting tokens manually.

**Architecture:** A new `ComposioService` wraps the verified Composio REST API (`auth_configs`, `connected_accounts`, `tools/execute/proxy`). Connections with `auth_mode: "composio"` store only the Composio `connected_account_id` in `accountExternalId` — no raw tokens in `secretRef`. The existing `IntegrationBrokerService.exchangeToken` is extended: when it encounters a `composio` connection, it calls the Composio proxy API to obtain a short-lived provider token, then returns it through the same `POST /api/v1/integrations/broker/token` contract. This keeps every existing module working without changes. New runtime API routes handle the connect flow (create link → poll status → store connection). Desktop IPC and UI are extended with a "Managed Connect" button.

**Tech Stack:** TypeScript, Fastify (runtime API server), node:test, Electron (desktop), React (IntegrationsPane), Composio REST API v3

## References

- `docs/plans/2026-03-31-composio-app-runtime-design.md` — full architecture rationale
- `docs/plans/2026-03-30-integrations-engineering-design.md` — base integration architecture
- `runtime/api-server/src/composio-minimal-example.ts` — verified API client code
- `runtime/api-server/src/composio-test-server.ts` — browser-based feasibility test

## File Structure

### Runtime repo (`holaOS`)

| File | Responsibility |
|------|---------------|
| `runtime/api-server/src/composio-service.ts` (new) | Composio API client: auth configs, connect links, account status, proxy |
| `runtime/api-server/src/composio-service.test.ts` (new) | Unit tests with mock fetch |
| `runtime/api-server/src/integration-broker.ts` (modify) | Extend `exchangeToken` to resolve tokens from Composio connections |
| `runtime/api-server/src/integration-broker.test.ts` (modify) | Add Composio token resolution tests |
| `runtime/api-server/src/app.ts` (modify) | Register Composio connect routes |
| `runtime/api-server/src/app.test.ts` (modify) | Route integration tests |
| `desktop/electron/main.ts` (modify) | Add Composio connect IPC handlers |
| `desktop/electron/preload.ts` (modify) | Expose Composio connect IPC to renderer |
| `desktop/src/types/electron.d.ts` (modify) | Add Composio connect type signatures |
| `desktop/src/components/panes/IntegrationsPane.tsx` (modify) | Add "Managed Connect" button and popup flow |

---

## Task 1: Extract Composio Service From Verified Example

**Files:**
- Create: `runtime/api-server/src/composio-service.ts`
- Create: `runtime/api-server/src/composio-service.test.ts`

### Step 1: Write failing Composio service tests

- [ ] Create `runtime/api-server/src/composio-service.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposioService,
  type ComposioConfig
} from "./composio-service.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

function testConfig(fetchImpl: typeof fetch): ComposioConfig {
  return { apiKey: "test-key", baseUrl: "https://backend.composio.dev", fetchImpl };
}

test("createConnectLink finds existing auth config and creates link", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/api/v3/auth_configs?")) {
      return jsonResponse({
        items: [{
          id: "authcfg_1", status: "ENABLED",
          is_composio_managed: true, toolkit: { slug: "gmail" }
        }]
      });
    }
    if (url.endsWith("/api/v3/connected_accounts/link")) {
      return jsonResponse({
        redirect_url: "https://connect.composio.dev/link/abc",
        connected_account_id: "ca_1",
        expires_at: "2026-04-01T00:00:00Z"
      }, { status: 201 });
    }
    throw new Error(`unexpected: ${url}`);
  };

  const service = new ComposioService(testConfig(fetchImpl));
  const result = await service.createConnectLink({
    toolkitSlug: "gmail",
    userId: "user-1",
    callbackUrl: "http://localhost:3099/callback"
  });

  assert.equal(result.connectedAccountId, "ca_1");
  assert.equal(result.redirectUrl, "https://connect.composio.dev/link/abc");
  assert.equal(result.authConfigCreated, false);
  assert.equal(calls.length, 2);
});

test("getConnectedAccount returns normalized status", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse({
      id: "ca_1", status: "ACTIVE",
      auth_config: { id: "authcfg_1" },
      toolkit: { slug: "gmail" },
      user_id: "user-1"
    });
  };

  const service = new ComposioService(testConfig(fetchImpl));
  const account = await service.getConnectedAccount("ca_1");

  assert.equal(account.id, "ca_1");
  assert.equal(account.status, "ACTIVE");
  assert.equal(account.toolkitSlug, "gmail");
});

test("proxyRequest returns envelope with data, status, headers", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse({
      data: { emailAddress: "test@gmail.com" },
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const service = new ComposioService(testConfig(fetchImpl));
  const result = await service.proxyRequest({
    connectedAccountId: "ca_1",
    method: "GET",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile"
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { emailAddress: "test@gmail.com" });
});

test("getAccessToken extracts token from proxy auth.test-style response", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/connected_accounts/")) {
      return jsonResponse({ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } });
    }
    if (url.includes("/tools/execute/proxy")) {
      return jsonResponse({
        data: { access_token: "ya29.live-token-xyz" },
        status: 200,
        headers: {}
      });
    }
    throw new Error(`unexpected: ${url}`);
  };

  const service = new ComposioService(testConfig(fetchImpl));
  const token = await service.getAccessToken("ca_1", "google");

  assert.equal(token, "ya29.live-token-xyz");
});

test("getAccessToken throws when account is not ACTIVE", async () => {
  const fetchImpl: typeof fetch = async () => {
    return jsonResponse({ id: "ca_1", status: "INITIATED", toolkit: { slug: "gmail" } });
  };

  const service = new ComposioService(testConfig(fetchImpl));
  await assert.rejects(
    () => service.getAccessToken("ca_1", "google"),
    (error: Error) => {
      assert.match(error.message, /not ACTIVE/);
      return true;
    }
  );
});
```

### Step 2: Run tests to verify they fail

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/composio-service.test.ts
```

Expected: FAIL because `composio-service.ts` does not exist.

### Step 3: Implement ComposioService

- [ ] Create `runtime/api-server/src/composio-service.ts`:

```ts
const DEFAULT_BASE_URL = "https://backend.composio.dev";

export interface ComposioConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ConnectLinkResult {
  authConfigId: string;
  authConfigCreated: boolean;
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string | null;
}

export interface ConnectedAccount {
  id: string;
  status: string;
  authConfigId: string | null;
  toolkitSlug: string | null;
  userId: string | null;
}

export interface ProxyResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

interface AuthConfigItem {
  id?: string;
  status?: string;
  is_composio_managed?: boolean;
  toolkit?: { slug?: string | null } | null;
}

function baseUrl(base?: string): string {
  return (base?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function headers(apiKey: string): HeadersInit {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new Error(`Composio returned empty response (${response.status})`);
  return JSON.parse(text) as T;
}

export class ComposioService {
  private readonly apiKey: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ComposioConfig) {
    this.apiKey = config.apiKey;
    this.base = baseUrl(config.baseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createConnectLink(params: {
    toolkitSlug: string;
    userId: string;
    callbackUrl?: string;
  }): Promise<ConnectLinkResult> {
    // 1. Find or create managed auth config
    const query = new URLSearchParams({
      toolkit_slug: params.toolkitSlug,
      is_composio_managed: "true",
      show_disabled: "false"
    });
    const listResp = await this.fetchImpl(`${this.base}/api/v3/auth_configs?${query}`, {
      headers: headers(this.apiKey)
    });
    if (!listResp.ok) {
      const body = await listResp.text();
      throw new Error(`Failed to list auth configs: ${listResp.status} ${body}`);
    }
    const configs = await parseJson<{ items?: AuthConfigItem[] }>(listResp);
    const existing = (configs.items ?? []).find(
      (c) =>
        c.status?.toUpperCase() === "ENABLED" &&
        c.is_composio_managed === true &&
        c.toolkit?.slug?.toLowerCase() === params.toolkitSlug.toLowerCase()
    );

    let authConfigId: string;
    let authConfigCreated = false;

    if (existing?.id) {
      authConfigId = existing.id;
    } else {
      const createResp = await this.fetchImpl(`${this.base}/api/v3/auth_configs`, {
        method: "POST",
        headers: headers(this.apiKey),
        body: JSON.stringify({
          toolkit: { slug: params.toolkitSlug },
          auth_config: { type: "use_composio_managed_auth" }
        })
      });
      if (!createResp.ok) {
        const body = await createResp.text();
        throw new Error(`Failed to create auth config: ${createResp.status} ${body}`);
      }
      const created = await parseJson<{ id?: string; auth_config?: { id?: string } }>(createResp);
      authConfigId = created.id ?? created.auth_config?.id ?? "";
      if (!authConfigId) throw new Error("Composio returned no auth config ID");
      authConfigCreated = true;
    }

    // 2. Create connect link
    const linkResp = await this.fetchImpl(`${this.base}/api/v3/connected_accounts/link`, {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: params.userId,
        ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {})
      })
    });
    if (!linkResp.ok) {
      const body = await linkResp.text();
      throw new Error(`Failed to create connect link: ${linkResp.status} ${body}`);
    }
    const link = await parseJson<{
      redirect_url?: string;
      connected_account_id?: string;
      expires_at?: string | null;
    }>(linkResp);

    return {
      authConfigId,
      authConfigCreated,
      connectedAccountId: link.connected_account_id ?? "",
      redirectUrl: link.redirect_url ?? "",
      expiresAt: link.expires_at ?? null
    };
  }

  async getConnectedAccount(connectedAccountId: string): Promise<ConnectedAccount> {
    const resp = await this.fetchImpl(
      `${this.base}/api/v3/connected_accounts/${connectedAccountId}`,
      { headers: headers(this.apiKey) }
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Failed to get connected account: ${resp.status} ${body}`);
    }
    const data = await parseJson<{
      id?: string;
      status?: string;
      auth_config?: { id?: string } | null;
      toolkit?: { slug?: string } | null;
      user_id?: string;
    }>(resp);
    return {
      id: data.id ?? connectedAccountId,
      status: (data.status ?? "UNKNOWN").toUpperCase(),
      authConfigId: data.auth_config?.id ?? null,
      toolkitSlug: data.toolkit?.slug ?? null,
      userId: data.user_id ?? null
    };
  }

  async proxyRequest<TData = unknown>(params: {
    connectedAccountId: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    endpoint: string;
    body?: unknown;
  }): Promise<ProxyResponse<TData>> {
    const resp = await this.fetchImpl(`${this.base}/api/v3/tools/execute/proxy`, {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify({
        connected_account_id: params.connectedAccountId,
        endpoint: params.endpoint,
        method: params.method,
        ...(params.body !== undefined ? { body: params.body } : {})
      })
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Proxy request failed: ${resp.status} ${body}`);
    }
    const payload = await parseJson<{
      data?: TData | null;
      status?: number;
      headers?: Record<string, string>;
    }>(resp);
    return {
      data: payload.data ?? null,
      status: payload.status ?? resp.status,
      headers: payload.headers ?? {}
    };
  }

  /**
   * Obtain a short-lived provider access token for a Composio connected account.
   * Used by the broker to satisfy `exchangeToken` for `auth_mode: "composio"` connections.
   */
  async getAccessToken(connectedAccountId: string, provider: string): Promise<string> {
    const account = await this.getConnectedAccount(connectedAccountId);
    if (account.status !== "ACTIVE") {
      throw new Error(
        `Composio account ${connectedAccountId} is not ACTIVE (status: ${account.status})`
      );
    }

    const tokenEndpoint = PROVIDER_TOKEN_ENDPOINTS[provider];
    if (!tokenEndpoint) {
      throw new Error(`No token resolution endpoint configured for provider "${provider}"`);
    }

    const result = await this.proxyRequest<{ access_token?: string }>({
      connectedAccountId,
      method: "GET",
      endpoint: tokenEndpoint
    });

    const token = result.data?.access_token;
    if (!token) {
      throw new Error(`Composio proxy did not return an access_token for ${provider}`);
    }
    return token;
  }
}

/**
 * Provider-specific endpoints that return `{ access_token }` when called via proxy.
 * These are used by getAccessToken to extract a usable provider token.
 */
const PROVIDER_TOKEN_ENDPOINTS: Record<string, string> = {
  google: "https://oauth2.googleapis.com/tokeninfo",
  github: "https://api.github.com/user"
};
```

**Important note:** The `getAccessToken` approach above uses the proxy to hit a provider endpoint that returns token info. However, Composio may also expose a direct token retrieval endpoint. If during implementation you discover that `GET /api/v3/connected_accounts/{id}` returns a `state.access_token` field, use that instead — it's simpler and doesn't waste a proxy call. Check the actual response from the Composio API before finalizing this implementation. The fallback approach (proxy to tokeninfo) is guaranteed to work based on our feasibility test.

### Step 4: Run tests to verify they pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/composio-service.test.ts
```

Expected: all tests PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/composio-service.ts runtime/api-server/src/composio-service.test.ts
git commit -m "feat: add ComposioService for managed OAuth connect and token resolution"
```

---

## Task 2: Extend Broker To Resolve Tokens From Composio Connections

**Files:**
- Modify: `runtime/api-server/src/integration-broker.ts`
- Modify: `runtime/api-server/src/integration-broker.test.ts`

### Step 1: Write failing broker test for Composio token resolution

- [ ] Add this test to the end of `runtime/api-server/src/integration-broker.test.ts`:

```ts
test("exchangeToken resolves token from composio connection via ComposioService", async () => {
  const root = makeTempDir("hb-broker-composio-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "ws-composio",
    name: "Composio Test",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-composio-google",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "test@gmail.com (Composio)",
    authMode: "composio",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: null,
    accountExternalId: "ca_composio_123"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-composio-google",
    workspaceId: "ws-composio",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-composio-google",
    isDefault: true
  });

  const mockComposioService = {
    getAccessToken: async (connectedAccountId: string, provider: string) => {
      assert.equal(connectedAccountId, "ca_composio_123");
      assert.equal(provider, "google");
      return "ya29.composio-resolved-token";
    }
  };

  const broker = new IntegrationBrokerService(store, mockComposioService as any);
  const result = await broker.exchangeToken({
    grant: "grant:ws-composio:gmail-app:test-nonce",
    provider: "google"
  });

  assert.equal(result.token, "ya29.composio-resolved-token");
  assert.equal(result.provider, "google");
  assert.equal(result.connection_id, "conn-composio-google");

  store.close();
});

test("exchangeToken throws when composio connection has no accountExternalId", async () => {
  const root = makeTempDir("hb-broker-composio-noext-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "ws-noext",
    name: "No External",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-noext",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "broken composio",
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    accountExternalId: null
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-noext",
    workspaceId: "ws-noext",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-noext",
    isDefault: true
  });

  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    () => broker.exchangeToken({
      grant: "grant:ws-noext:gmail-app:test-nonce",
      provider: "google"
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "token_unavailable"
  );

  store.close();
});
```

### Step 2: Run tests to verify they fail

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: FAIL because `IntegrationBrokerService` constructor does not accept a second argument.

### Step 3: Extend IntegrationBrokerService

- [ ] Modify `runtime/api-server/src/integration-broker.ts`:

Add the Composio service interface and update the constructor:

```ts
export interface ComposioTokenResolver {
  getAccessToken(connectedAccountId: string, provider: string): Promise<string>;
}
```

Update the class:

```ts
export class IntegrationBrokerService {
  readonly store: RuntimeStateStore;
  private readonly composio: ComposioTokenResolver | null;

  constructor(store: RuntimeStateStore, composio?: ComposioTokenResolver | null) {
    this.store = store;
    this.composio = composio ?? null;
  }
```

In `exchangeToken`, after the connection status check and before the existing `resolveTokenWithRefresh` call, add the Composio branch:

```ts
    if (connection.authMode === "composio") {
      if (!connection.accountExternalId) {
        throw new BrokerError(
          "token_unavailable",
          503,
          `${provider} composio connection has no linked account`
        );
      }
      if (!this.composio) {
        throw new BrokerError(
          "token_unavailable",
          503,
          `composio token resolver is not configured`
        );
      }
      try {
        const token = await this.composio.getAccessToken(
          connection.accountExternalId,
          provider
        );
        return { token, provider, connection_id: connection.connectionId };
      } catch (error) {
        throw new BrokerError(
          "token_unavailable",
          503,
          `composio token resolution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
```

### Step 4: Run tests to verify they pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: all tests PASS including the new Composio tests.

### Step 5: Run all existing integration tests to verify no regression

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
```

Expected: all PASS.

### Step 6: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/integration-broker.ts runtime/api-server/src/integration-broker.test.ts
git commit -m "feat: extend broker to resolve tokens from composio connections"
```

---

## Task 3: Register Composio Connect Routes

**Files:**
- Modify: `runtime/api-server/src/app.ts`

### Step 1: Add Composio service construction and routes

- [ ] In `runtime/api-server/src/app.ts`, add the import:

```ts
import { ComposioService } from "./composio-service.js";
```

After the existing service construction block (around line 1161), add:

```ts
  const composioApiKey = process.env.COMPOSIO_API_KEY ?? "";
  const composioService = composioApiKey
    ? new ComposioService({ apiKey: composioApiKey })
    : null;

  // Update broker to use composio service
  const brokerService = new IntegrationBrokerService(store, composioService);
```

Remove the earlier `const brokerService = new IntegrationBrokerService(store);` line.

### Step 2: Add the connect routes

- [ ] After the existing `POST /api/v1/integrations/oauth/authorize` route, add:

```ts
  // ---- Composio Managed Connect ----

  app.post("/api/v1/integrations/composio/connect", async (request, reply) => {
    if (!composioService) {
      return sendError(reply, 503, "Composio is not configured (COMPOSIO_API_KEY missing)");
    }
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    const ownerUserId = typeof request.body.owner_user_id === "string" ? request.body.owner_user_id : "local";
    const callbackUrl = typeof request.body.callback_url === "string" ? request.body.callback_url : undefined;
    if (!provider) {
      return sendError(reply, 400, "provider is required");
    }

    // Map provider_id to Composio toolkit slug
    const toolkitSlug = PROVIDER_TO_COMPOSIO_TOOLKIT[provider] ?? provider;

    try {
      const link = await composioService.createConnectLink({
        toolkitSlug,
        userId: ownerUserId,
        callbackUrl
      });
      return {
        redirect_url: link.redirectUrl,
        connected_account_id: link.connectedAccountId,
        auth_config_id: link.authConfigId,
        expires_at: link.expiresAt
      };
    } catch (error) {
      return sendError(reply, 502, error instanceof Error ? error.message : "composio connect failed");
    }
  });

  app.get("/api/v1/integrations/composio/account/:connectedAccountId", async (request, reply) => {
    if (!composioService) {
      return sendError(reply, 503, "Composio is not configured");
    }
    const params = request.params as { connectedAccountId: string };
    try {
      const account = await composioService.getConnectedAccount(params.connectedAccountId);
      return account;
    } catch (error) {
      return sendError(reply, 502, error instanceof Error ? error.message : "composio account check failed");
    }
  });

  app.post("/api/v1/integrations/composio/finalize", async (request, reply) => {
    if (!composioService) {
      return sendError(reply, 503, "Composio is not configured");
    }
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const connectedAccountId = typeof request.body.connected_account_id === "string" ? request.body.connected_account_id : "";
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    const ownerUserId = typeof request.body.owner_user_id === "string" ? request.body.owner_user_id : "local";
    const accountLabel = typeof request.body.account_label === "string" ? request.body.account_label : "";
    if (!connectedAccountId || !provider) {
      return sendError(reply, 400, "connected_account_id and provider are required");
    }

    try {
      const account = await composioService.getConnectedAccount(connectedAccountId);
      if (account.status !== "ACTIVE") {
        return sendError(reply, 409, `account is not ACTIVE (status: ${account.status})`);
      }
      const label = accountLabel || `${provider} (Composio)`;
      const connection = integrationService.createConnection({
        providerId: provider,
        ownerUserId,
        accountLabel: label,
        authMode: "composio",
        grantedScopes: [],
        accountExternalId: connectedAccountId
      });
      return connection;
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 502, error instanceof Error ? error.message : "composio finalize failed");
    }
  });
```

### Step 3: Add the provider-to-toolkit mapping constant

- [ ] Add near the top of the route registration section:

```ts
const PROVIDER_TO_COMPOSIO_TOOLKIT: Record<string, string> = {
  google: "gmail",
  github: "github",
  reddit: "reddit",
  twitter: "twitter",
  linkedin: "linkedin"
};
```

### Step 4: Run existing tests to verify no regression

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
```

Expected: all PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/app.ts
git commit -m "feat: register composio managed connect routes"
```

---

## Task 4: Add Desktop IPC For Composio Connect Flow

**Files:**
- Modify: `desktop/src/types/electron.d.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`

### Step 1: Add Composio connect types

- [ ] In `desktop/src/types/electron.d.ts`, add these types (before `ElectronAPI`):

```ts
  interface ComposioConnectResult {
    redirect_url: string;
    connected_account_id: string;
    auth_config_id: string;
    expires_at: string | null;
  }

  interface ComposioAccountStatus {
    id: string;
    status: string;
    authConfigId: string | null;
    toolkitSlug: string | null;
    userId: string | null;
  }
```

- [ ] Add these methods inside the `workspace` property of `ElectronAPI`:

```ts
      composioConnect: (payload: { provider: string; owner_user_id: string; callback_url?: string }) => Promise<ComposioConnectResult>;
      composioAccountStatus: (connectedAccountId: string) => Promise<ComposioAccountStatus>;
      composioFinalize: (payload: { connected_account_id: string; provider: string; owner_user_id: string; account_label?: string }) => Promise<IntegrationConnectionPayload>;
```

### Step 2: Add preload IPC methods

- [ ] In `desktop/electron/preload.ts`, add inside the `workspace` property:

```ts
    composioConnect: (payload: { provider: string; owner_user_id: string; callback_url?: string }) =>
      ipcRenderer.invoke("workspace:composioConnect", payload) as Promise<ComposioConnectResult>,
    composioAccountStatus: (connectedAccountId: string) =>
      ipcRenderer.invoke("workspace:composioAccountStatus", connectedAccountId) as Promise<ComposioAccountStatus>,
    composioFinalize: (payload: { connected_account_id: string; provider: string; owner_user_id: string; account_label?: string }) =>
      ipcRenderer.invoke("workspace:composioFinalize", payload) as Promise<IntegrationConnectionPayload>,
```

### Step 3: Add main process IPC handlers

- [ ] In `desktop/electron/main.ts`, add the helper functions (follow existing `requestRuntimeJson` pattern):

```ts
async function composioConnect(
  payload: { provider: string; owner_user_id: string; callback_url?: string }
): Promise<ComposioConnectResult> {
  return requestRuntimeJson<ComposioConnectResult>({
    method: "POST",
    path: "/api/v1/integrations/composio/connect",
    payload,
  });
}

async function composioAccountStatus(
  connectedAccountId: string
): Promise<ComposioAccountStatus> {
  return requestRuntimeJson<ComposioAccountStatus>({
    method: "GET",
    path: `/api/v1/integrations/composio/account/${encodeURIComponent(connectedAccountId)}`,
  });
}

async function composioFinalize(
  payload: { connected_account_id: string; provider: string; owner_user_id: string; account_label?: string }
): Promise<IntegrationConnectionPayload> {
  return requestRuntimeJson<IntegrationConnectionPayload>({
    method: "POST",
    path: "/api/v1/integrations/composio/finalize",
    payload,
  });
}
```

- [ ] Register the IPC handlers after existing integration handlers:

```ts
  handleTrustedIpc(
    "workspace:composioConnect",
    ["main"],
    async (_event, payload: { provider: string; owner_user_id: string; callback_url?: string }) =>
      composioConnect(payload),
  );
  handleTrustedIpc(
    "workspace:composioAccountStatus",
    ["main"],
    async (_event, connectedAccountId: string) =>
      composioAccountStatus(connectedAccountId),
  );
  handleTrustedIpc(
    "workspace:composioFinalize",
    ["main"],
    async (_event, payload: { connected_account_id: string; provider: string; owner_user_id: string; account_label?: string }) =>
      composioFinalize(payload),
  );
```

### Step 4: Verify desktop typecheck

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add desktop/src/types/electron.d.ts desktop/electron/preload.ts desktop/electron/main.ts
git commit -m "feat: add desktop IPC for composio managed connect flow"
```

---

## Task 5: Add Managed Connect Button To IntegrationsPane

**Files:**
- Modify: `desktop/src/components/panes/IntegrationsPane.tsx`

### Step 1: Read the current pane code

- [ ] Read the full content of `desktop/src/components/panes/IntegrationsPane.tsx` to understand the existing structure, state management, and component patterns before making changes.

### Step 2: Add Composio connect state and handler

- [ ] Add state variables:

```tsx
const [composioConnecting, setComposioConnecting] = useState(false);
```

- [ ] Add the managed connect handler function:

```tsx
const handleManagedConnect = async () => {
  if (!selectedProvider) return;
  setComposioConnecting(true);
  setErrorMessage(null);
  try {
    const runtimeConfig = await window.electronAPI.runtime.getConfig();
    const userId = runtimeConfig.userId ?? "local";

    // 1. Create connect link
    const link = await window.electronAPI.workspace.composioConnect({
      provider: selectedProvider.provider_id,
      owner_user_id: userId
    });

    // 2. Open OAuth popup
    window.open(link.redirect_url, "composio-oauth", "width=600,height=700");

    // 3. Poll until ACTIVE (max 5 min, every 3s)
    let account: ComposioAccountStatus | null = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await window.electronAPI.workspace.composioAccountStatus(
        link.connected_account_id
      );
      if (status.status === "ACTIVE") {
        account = status;
        break;
      }
    }

    if (!account) {
      setErrorMessage("OAuth timed out. Please try again.");
      return;
    }

    // 4. Finalize — create local connection
    const connection = await window.electronAPI.workspace.composioFinalize({
      connected_account_id: link.connected_account_id,
      provider: selectedProvider.provider_id,
      owner_user_id: userId,
      account_label: `${selectedProvider.display_name} (Managed)`
    });

    setConnections((prev) => [...prev, connection]);
  } catch (error) {
    setErrorMessage(normalizeErrorMessage(error));
  } finally {
    setComposioConnecting(false);
  }
};
```

### Step 3: Add the Managed Connect button

- [ ] In the provider detail header area, next to the existing "Import Token" button, add:

```tsx
<button
  type="button"
  disabled={composioConnecting}
  onClick={handleManagedConnect}
  className="rounded-[12px] border border-neon-green/35 bg-neon-green/8 px-3 py-1.5 text-[11px] font-medium text-neon-green transition-colors duration-200 hover:bg-neon-green/14 disabled:opacity-50"
>
  {composioConnecting ? "Connecting…" : "Connect"}
</button>
```

This button should appear when the provider's `auth_modes` includes `"managed"` and the provider is listed in the catalog. It should be the primary action — placed before the "Import Token" button.

### Step 4: Verify desktop typecheck

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add desktop/src/components/panes/IntegrationsPane.tsx
git commit -m "feat: add managed connect button to integrations pane"
```

---

## Task 6: Final Verification

### Step 1: Run all runtime tests

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss/holaOS

cd runtime/api-server && node --import tsx --test src/composio-service.test.ts
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
cd runtime/api-server && node --import tsx --test src/app-lifecycle-worker.test.ts
cd runtime/state-store && node --import tsx --test src/store.test.ts
```

Expected: all tests PASS.

### Step 2: Verify desktop build

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS.

### Step 3: Manual E2E verification (requires COMPOSIO_API_KEY)

- [ ] Run the test server to verify the full flow end-to-end:

```bash
cd runtime/api-server && COMPOSIO_API_KEY=<key> node --import tsx src/composio-test-server.ts
```

Open `http://localhost:3099`, select Gmail, click "Start OAuth Flow", complete authorization, verify all 3 steps turn green.

---

## Notes For Execution

- **COMPOSIO_API_KEY**: The Composio API key is read from `process.env.COMPOSIO_API_KEY`. When not set, `composioService` is `null` and all `/composio/*` routes return 503. The broker falls back to existing behavior (local token resolution).

- **Token resolution strategy**: The `getAccessToken` method in Task 1 uses a proxy call to a provider endpoint as the guaranteed working approach. During implementation, check if `GET /api/v3/connected_accounts/{id}` returns `state.access_token` directly — if so, use that simpler path instead of the proxy call.

- **Provider-to-toolkit mapping**: Composio uses "toolkit slugs" (e.g., `gmail`) while Holaboss uses provider IDs (e.g., `google`). The `PROVIDER_TO_COMPOSIO_TOOLKIT` mapping in Task 3 handles this. If a provider is not in the map, it falls through to using the provider ID as the toolkit slug.

- **No module changes needed**: Because the broker's `exchangeToken` contract is unchanged (apps still call `POST /api/v1/integrations/broker/token`), existing modules (Gmail, Sheets, GitHub, Reddit, Twitter, LinkedIn) work with Composio connections without any code changes. The broker transparently resolves tokens from Composio when it encounters `auth_mode: "composio"`.

- **Binding after connect**: After a Composio connection is created via `/composio/finalize`, the user still needs to bind it to a workspace. This uses the existing binding UI — no changes needed.

- **Cleanup of example files**: `composio-minimal-example.ts`, `composio-minimal-example.test.ts`, and `composio-test-server.ts` are development/verification artifacts. They can be kept for reference or removed after Phase 4 is complete. They are not imported by production code.
