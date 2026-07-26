# Integrations Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local broker token exchange endpoint to the runtime and migrate Gmail, Sheets, and GitHub modules from direct `PLATFORM_INTEGRATION_TOKEN` env var usage to broker-based token acquisition.

**Architecture:** Phase 2 introduces a broker token exchange service inside the existing runtime API server. Apps present their `HOLABOSS_APP_GRANT` (injected by Phase 1) and a provider name, and the broker resolves the correct provider token from the binding/connection chain. Each direct-API module (Gmail, Sheets, GitHub) gets a small integration client that calls the broker instead of reading env vars. `PLATFORM_INTEGRATION_TOKEN` remains as a fallback during migration but is no longer the primary token source.

**Tech Stack:** TypeScript, Fastify (runtime API server), node:test (testing), TanStack Start modules (Gmail/Sheets/GitHub)

## Scope

This plan implements the Phase 2 broker-first migration described in:

- `docs/plans/2026-03-30-integrations-engineering-design.md`
- `docs/plans/2026-03-30-integrations-product-and-ux-design.md`

Phase 2 includes:

- broker token exchange endpoint in the runtime API server
- grant parsing and validation
- integration client for direct-API modules
- Gmail module migration to broker-based tokens
- Sheets module migration to broker-based tokens
- GitHub module migration to broker-based tokens
- `credential_source: broker` support in manifest parsing

Phase 2 does not include:

- full provider proxy execution (broker does not relay API calls)
- signed or encrypted app grants (grants are parsed, not cryptographically verified)
- removing `PLATFORM_INTEGRATION_TOKEN` from modules (kept as fallback)
- publishing module migration (Reddit, Twitter, LinkedIn already use a delegated model)
- OAuth callback endpoints or interactive connection flows

## File Structure

### Runtime repo (`holaOS`)

| File | Responsibility |
|------|---------------|
| `runtime/api-server/src/integration-broker.ts` (new) | Broker service: grant parsing, token resolution, error types |
| `runtime/api-server/src/integration-broker.test.ts` (new) | Broker service unit tests |
| `runtime/api-server/src/app.ts` (modify) | Register broker route |
| `runtime/api-server/src/app.test.ts` (modify) | Broker route integration test |

### Module repo (`holaboss-modules`)

For each of Gmail, Sheets, GitHub:

| File | Responsibility |
|------|---------------|
| `{module}/src/server/integration-client.ts` (new) | Broker client: token exchange with fallback |
| `{module}/src/server/google-api.ts` or `github-api.ts` (modify) | Replace `getToken()` with broker client |
| `{module}/app.runtime.yaml` (modify) | Add `HOLABOSS_INTEGRATION_BROKER_URL` and `HOLABOSS_APP_GRANT` to `env_contract` |

---

## Task 1: Add Broker Token Exchange Service

**Files:**
- Create: `runtime/api-server/src/integration-broker.ts`
- Create: `runtime/api-server/src/integration-broker.test.ts`

### Step 1: Write failing broker service tests

- [ ] Create `runtime/api-server/src/integration-broker.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  BrokerError,
  IntegrationBrokerService,
  parseAppGrant
} from "./integration-broker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("parseAppGrant extracts workspace and app from a valid grant string", () => {
  const result = parseAppGrant("grant:workspace-1:gmail:abc-123-uuid");
  assert.deepEqual(result, {
    workspaceId: "workspace-1",
    appId: "gmail",
    nonce: "abc-123-uuid"
  });
});

test("parseAppGrant returns null for malformed grant strings", () => {
  assert.equal(parseAppGrant(""), null);
  assert.equal(parseAppGrant("not-a-grant"), null);
  assert.equal(parseAppGrant("grant:only-two"), null);
  assert.equal(parseAppGrant("grant:workspace:app:"), null);
  assert.equal(parseAppGrant("xgrant:workspace:app:nonce"), null);
});

test("exchangeToken returns provider token for a valid grant and active binding", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "gya_actual-google-token-value"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });

  const broker = new IntegrationBrokerService(store);
  const result = broker.exchangeToken({
    grant: "grant:workspace-1:gmail:some-uuid",
    provider: "google"
  });

  assert.equal(result.token, "gya_actual-google-token-value");
  assert.equal(result.provider, "google");
  assert.equal(result.connection_id, "conn-google-1");

  store.close();
});

test("exchangeToken throws grant_invalid for a malformed grant", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const broker = new IntegrationBrokerService(store);

  assert.throws(
    () => broker.exchangeToken({ grant: "bad-grant", provider: "google" }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "grant_invalid" &&
      error.statusCode === 401
  );

  store.close();
});

test("exchangeToken throws integration_not_bound when no binding exists", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  const broker = new IntegrationBrokerService(store);

  assert.throws(
    () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "integration_not_bound" &&
      error.statusCode === 404
  );

  store.close();
});

test("exchangeToken throws connection_inactive when connection is expired", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-expired",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "expired@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "expired",
    secretRef: "expired-token"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-expired",
    isDefault: true
  });
  const broker = new IntegrationBrokerService(store);

  assert.throws(
    () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "connection_inactive" &&
      error.statusCode === 403
  );

  store.close();
});

test("exchangeToken throws token_unavailable when connection has no secret_ref", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-no-secret",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "nosecret@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-no-secret",
    isDefault: true
  });
  const broker = new IntegrationBrokerService(store);

  assert.throws(
    () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "token_unavailable" &&
      error.statusCode === 503
  );

  store.close();
});

test("exchangeToken prefers app-specific binding over workspace default", () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-default",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "default@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-default"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-app",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "app@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-app-specific"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-default",
    isDefault: true
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: "workspace-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-app",
    isDefault: false
  });
  const broker = new IntegrationBrokerService(store);

  const result = broker.exchangeToken({
    grant: "grant:workspace-1:gmail:some-uuid",
    provider: "google"
  });

  assert.equal(result.token, "token-app-specific");
  assert.equal(result.connection_id, "conn-google-app");

  store.close();
});
```

### Step 2: Run tests to verify they fail

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: FAIL because `integration-broker.ts` does not exist.

### Step 3: Implement the broker service

- [ ] Create `runtime/api-server/src/integration-broker.ts`:

```ts
import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

export type BrokerErrorCode =
  | "grant_invalid"
  | "integration_not_bound"
  | "connection_inactive"
  | "token_unavailable";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly statusCode: number;

  constructor(code: BrokerErrorCode, statusCode: number, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ParsedAppGrant {
  workspaceId: string;
  appId: string;
  nonce: string;
}

export interface TokenExchangeResult {
  token: string;
  provider: string;
  connection_id: string;
}

export function parseAppGrant(grant: string): ParsedAppGrant | null {
  if (typeof grant !== "string" || !grant.startsWith("grant:")) {
    return null;
  }
  const parts = grant.slice("grant:".length).split(":");
  if (parts.length < 3) {
    return null;
  }
  const workspaceId = parts[0]!;
  const appId = parts[1]!;
  const nonce = parts.slice(2).join(":");
  if (!workspaceId || !appId || !nonce) {
    return null;
  }
  return { workspaceId, appId, nonce };
}

export class IntegrationBrokerService {
  readonly store: RuntimeStateStore;

  constructor(store: RuntimeStateStore) {
    this.store = store;
  }

  exchangeToken(params: {
    grant: string;
    provider: string;
  }): TokenExchangeResult {
    const parsed = parseAppGrant(params.grant);
    if (!parsed) {
      throw new BrokerError("grant_invalid", 401, "app grant is malformed");
    }

    const provider = params.provider.trim();
    if (!provider) {
      throw new BrokerError("grant_invalid", 401, "provider is required");
    }

    const binding =
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "app",
        targetId: parsed.appId,
        integrationKey: provider
      }) ??
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "workspace",
        targetId: "default",
        integrationKey: provider
      });

    if (!binding) {
      throw new BrokerError(
        "integration_not_bound",
        404,
        `no ${provider} binding for workspace ${parsed.workspaceId}`
      );
    }

    const connection = this.store.getIntegrationConnection(
      binding.connectionId
    );
    if (!connection) {
      throw new BrokerError(
        "integration_not_bound",
        404,
        `connection ${binding.connectionId} not found`
      );
    }

    if (connection.status.trim().toLowerCase() !== "active") {
      throw new BrokerError(
        "connection_inactive",
        403,
        `${provider} connection is ${connection.status}`
      );
    }

    if (!connection.secretRef) {
      throw new BrokerError(
        "token_unavailable",
        503,
        `${provider} connection has no credential`
      );
    }

    return {
      token: connection.secretRef,
      provider,
      connection_id: connection.connectionId
    };
  }
}
```

### Step 4: Run tests to verify they pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: all 7 tests PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/integration-broker.ts runtime/api-server/src/integration-broker.test.ts
git commit -m "feat: add integration broker token exchange service"
```

---

## Task 2: Register Broker Token Exchange Route

**Files:**
- Modify: `runtime/api-server/src/app.ts`

### Step 1: Write failing route test

- [ ] Add a test to `runtime/api-server/src/integration-broker.test.ts` that exercises the route through Fastify inject. First, add these imports at the top of the file:

```ts
import { buildApp } from "./app.js";
```

Then add this test at the end of the file:

```ts
test("POST /api/v1/integrations/broker/token returns provider token via HTTP", async () => {
  const root = makeTempDir("hb-broker-route-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "gya_test-token-value"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });

  const app = await buildApp({ store, workspaceRoot: path.join(root, "workspace") });

  const successResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "grant:workspace-1:gmail:test-uuid",
      provider: "google"
    }
  });
  assert.equal(successResponse.statusCode, 200);
  const successBody = successResponse.json();
  assert.equal(successBody.token, "gya_test-token-value");
  assert.equal(successBody.provider, "google");
  assert.equal(successBody.connection_id, "conn-google-1");

  const errorResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "bad-grant",
      provider: "google"
    }
  });
  assert.equal(errorResponse.statusCode, 401);
  const errorBody = errorResponse.json();
  assert.equal(errorBody.error, "grant_invalid");

  const unboundResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "grant:workspace-1:gmail:test-uuid",
      provider: "reddit"
    }
  });
  assert.equal(unboundResponse.statusCode, 404);
  assert.equal(unboundResponse.json().error, "integration_not_bound");

  await app.close();
  store.close();
});
```

### Step 2: Run tests to verify the route test fails

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: the new route test FAILS because the route is not registered.

### Step 3: Register the broker route in app.ts

- [ ] Add the import at the top of `runtime/api-server/src/app.ts`, near the other integration imports:

```ts
import {
  BrokerError,
  IntegrationBrokerService
} from "./integration-broker.js";
```

- [ ] Add the service instantiation after `integrationService` is created (search for `new RuntimeIntegrationService`):

```ts
const brokerService = new IntegrationBrokerService(store);
```

- [ ] Add the route registration after the `GET /api/v1/integrations/readiness` route:

```ts
  app.post("/api/v1/integrations/broker/token", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    const grant = typeof request.body.grant === "string" ? request.body.grant : "";
    const provider = typeof request.body.provider === "string" ? request.body.provider : "";
    if (!grant || !provider) {
      return sendError(reply, 400, "grant and provider are required");
    }
    try {
      return brokerService.exchangeToken({ grant, provider });
    } catch (error) {
      if (error instanceof BrokerError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message
        });
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "broker token exchange failed");
    }
  });
```

### Step 4: Run tests to verify they pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: all 8 tests PASS.

### Step 5: Verify existing tests still pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
```

Expected: all existing tests PASS.

### Step 6: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/integration-broker.ts runtime/api-server/src/integration-broker.test.ts runtime/api-server/src/app.ts
git commit -m "feat: add broker token exchange route"
```

---

## Task 3: Migrate Gmail Module To Broker-Based Token Acquisition

**Files:**
- Create: `../holaboss-modules/gmail/src/server/integration-client.ts`
- Modify: `../holaboss-modules/gmail/src/server/google-api.ts`
- Modify: `../holaboss-modules/gmail/app.runtime.yaml`

The module repo is at `/Users/you/holaboss-ai/holaboss-modules/gmail/`.

### Step 1: Create the integration client

- [ ] Create `../holaboss-modules/gmail/src/server/integration-client.ts`:

```ts
const BROKER_URL = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "";
const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? "";

interface TokenExchangeResponse {
  token: string;
  provider: string;
  connection_id: string;
}

interface TokenExchangeError {
  error: string;
  message: string;
}

export async function getProviderToken(provider: string): Promise<string> {
  if (!BROKER_URL || !APP_GRANT) {
    return getFallbackToken(provider);
  }

  const brokerTokenUrl = `${BROKER_URL}/broker/token`;
  try {
    const response = await fetch(brokerTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: APP_GRANT, provider })
    });

    if (response.ok) {
      const data = (await response.json()) as TokenExchangeResponse;
      return data.token;
    }

    let errorBody: TokenExchangeError | null = null;
    try {
      errorBody = (await response.json()) as TokenExchangeError;
    } catch {
      // ignore parse errors
    }

    const errorMessage = errorBody?.message ?? `broker returned ${response.status}`;
    throw new Error(`Integration broker error (${errorBody?.error ?? "unknown"}): ${errorMessage}`);
  } catch (error) {
    if (error instanceof TypeError && String(error.message).includes("fetch")) {
      return getFallbackToken(provider);
    }
    throw error;
  }
}

function getFallbackToken(provider: string): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }

  throw new Error(
    `No ${provider} token available. Connect via Integrations or set PLATFORM_INTEGRATION_TOKEN.`
  );
}
```

### Step 2: Update google-api.ts to use the integration client

- [ ] In `../holaboss-modules/gmail/src/server/google-api.ts`, replace the existing `getToken()` function and `headers()` function. The current file starts like this:

```ts
import { readFileSync } from "node:fs"

const TOKEN_FILE = "/holaboss/state/integration-tokens.json"
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

function getToken(): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? ""
  if (envToken) return envToken

  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"))
    if (data.google) return data.google as string
  } catch { /* file doesn't exist yet */ }

  throw new Error("No Google token. Connect via Settings or set PLATFORM_INTEGRATION_TOKEN.")
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" }
}
```

Replace that section with:

```ts
import { getProviderToken } from "./integration-client"

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

let cachedToken: string | null = null

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken
  cachedToken = await getProviderToken("google")
  return cachedToken
}

async function headers(): Promise<Record<string, string>> {
  const token = await resolveToken()
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}
```

Then update every function in the file that calls `headers()` to `await` it. The typical pattern changes from:

```ts
const res = await fetch(`${GMAIL_BASE}/threads?${params}`, { headers: headers() })
```

to:

```ts
const res = await fetch(`${GMAIL_BASE}/threads?${params}`, { headers: await headers() })
```

Apply this change to every `fetch()` call in `google-api.ts`. All exported functions in this file are already `async`, so adding `await` is safe.

Also remove the `readFileSync` import if it becomes unused after removing `getToken()`.

### Step 3: Update app.runtime.yaml env_contract

- [ ] In `../holaboss-modules/gmail/app.runtime.yaml`, update the `env_contract` section from:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GOOGLE_INTEGRATION_ID"
```

to:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GOOGLE_INTEGRATION_ID"
```

### Step 4: Verify the module builds

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/gmail && npm run build
```

Expected: build succeeds.

### Step 5: Commit

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/gmail
git add src/server/integration-client.ts src/server/google-api.ts app.runtime.yaml
git commit -m "feat: migrate gmail to broker-based token acquisition"
```

---

## Task 4: Migrate Sheets Module To Broker-Based Token Acquisition

**Files:**
- Create: `../holaboss-modules/sheets/src/server/integration-client.ts`
- Modify: `../holaboss-modules/sheets/src/server/google-api.ts`
- Modify: `../holaboss-modules/sheets/app.runtime.yaml`

The module repo is at `/Users/you/holaboss-ai/holaboss-modules/sheets/`.

### Step 1: Create the integration client

- [ ] Create `../holaboss-modules/sheets/src/server/integration-client.ts` with the same contents as the Gmail integration client from Task 3 Step 1:

```ts
const BROKER_URL = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "";
const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? "";

interface TokenExchangeResponse {
  token: string;
  provider: string;
  connection_id: string;
}

interface TokenExchangeError {
  error: string;
  message: string;
}

export async function getProviderToken(provider: string): Promise<string> {
  if (!BROKER_URL || !APP_GRANT) {
    return getFallbackToken(provider);
  }

  const brokerTokenUrl = `${BROKER_URL}/broker/token`;
  try {
    const response = await fetch(brokerTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: APP_GRANT, provider })
    });

    if (response.ok) {
      const data = (await response.json()) as TokenExchangeResponse;
      return data.token;
    }

    let errorBody: TokenExchangeError | null = null;
    try {
      errorBody = (await response.json()) as TokenExchangeError;
    } catch {
      // ignore parse errors
    }

    const errorMessage = errorBody?.message ?? `broker returned ${response.status}`;
    throw new Error(`Integration broker error (${errorBody?.error ?? "unknown"}): ${errorMessage}`);
  } catch (error) {
    if (error instanceof TypeError && String(error.message).includes("fetch")) {
      return getFallbackToken(provider);
    }
    throw error;
  }
}

function getFallbackToken(provider: string): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }

  throw new Error(
    `No ${provider} token available. Connect via Integrations or set PLATFORM_INTEGRATION_TOKEN.`
  );
}
```

### Step 2: Update google-api.ts to use the integration client

- [ ] In `../holaboss-modules/sheets/src/server/google-api.ts`, apply the same pattern as Task 3 Step 2. Replace the `getToken()` and `headers()` functions:

```ts
import { getProviderToken } from "./integration-client"

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"

let cachedToken: string | null = null

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken
  cachedToken = await getProviderToken("google")
  return cachedToken
}

async function headers(): Promise<Record<string, string>> {
  const token = await resolveToken()
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}
```

Update every `fetch()` call in the file to `await headers()` instead of `headers()`.

Remove the `readFileSync` import if it becomes unused.

**Note:** Sheets also has a `gmail-api.ts` file. If it uses the same `getToken()` pattern, apply the same migration. If it imports from `google-api.ts`, no change needed.

### Step 3: Update app.runtime.yaml env_contract

- [ ] In `../holaboss-modules/sheets/app.runtime.yaml`, update the `env_contract` section from:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GOOGLE_INTEGRATION_ID"
```

to:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GOOGLE_INTEGRATION_ID"
```

### Step 4: Verify the module builds

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/sheets && npm run build
```

Expected: build succeeds.

### Step 5: Commit

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/sheets
git add src/server/integration-client.ts src/server/google-api.ts app.runtime.yaml
git commit -m "feat: migrate sheets to broker-based token acquisition"
```

---

## Task 5: Migrate GitHub Module To Broker-Based Token Acquisition

**Files:**
- Create: `../holaboss-modules/github/src/server/integration-client.ts`
- Modify: `../holaboss-modules/github/src/server/github-api.ts`
- Modify: `../holaboss-modules/github/app.runtime.yaml`

The module repo is at `/Users/you/holaboss-ai/holaboss-modules/github/`.

### Step 1: Create the integration client

- [ ] Create `../holaboss-modules/github/src/server/integration-client.ts` with the same contents as the Gmail integration client from Task 3 Step 1:

```ts
const BROKER_URL = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "";
const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? "";

interface TokenExchangeResponse {
  token: string;
  provider: string;
  connection_id: string;
}

interface TokenExchangeError {
  error: string;
  message: string;
}

export async function getProviderToken(provider: string): Promise<string> {
  if (!BROKER_URL || !APP_GRANT) {
    return getFallbackToken(provider);
  }

  const brokerTokenUrl = `${BROKER_URL}/broker/token`;
  try {
    const response = await fetch(brokerTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: APP_GRANT, provider })
    });

    if (response.ok) {
      const data = (await response.json()) as TokenExchangeResponse;
      return data.token;
    }

    let errorBody: TokenExchangeError | null = null;
    try {
      errorBody = (await response.json()) as TokenExchangeError;
    } catch {
      // ignore parse errors
    }

    const errorMessage = errorBody?.message ?? `broker returned ${response.status}`;
    throw new Error(`Integration broker error (${errorBody?.error ?? "unknown"}): ${errorMessage}`);
  } catch (error) {
    if (error instanceof TypeError && String(error.message).includes("fetch")) {
      return getFallbackToken(provider);
    }
    throw error;
  }
}

function getFallbackToken(provider: string): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }

  throw new Error(
    `No ${provider} token available. Connect via Integrations or set PLATFORM_INTEGRATION_TOKEN.`
  );
}
```

### Step 2: Update github-api.ts to use the integration client

- [ ] In `../holaboss-modules/github/src/server/github-api.ts`, replace the `getToken()` and `headers()` functions. The current file starts like this:

```ts
import { readFileSync } from "node:fs"

const TOKEN_FILE = "/holaboss/state/integration-tokens.json"
const GH_BASE = "https://api.github.com"

function getToken(): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? ""
  if (envToken) return envToken

  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"))
    if (data.github) return data.github as string
  } catch { /* file doesn't exist yet */ }

  throw new Error("No GitHub token. Connect via Settings or set PLATFORM_INTEGRATION_TOKEN.")
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }
}
```

Replace that section with:

```ts
import { getProviderToken } from "./integration-client"

const GH_BASE = "https://api.github.com"

let cachedToken: string | null = null

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken
  cachedToken = await getProviderToken("github")
  return cachedToken
}

async function headers(): Promise<Record<string, string>> {
  const token = await resolveToken()
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }
}
```

Update every `fetch()` call in the file to `await headers()` instead of `headers()`.

Remove the `readFileSync` import if it becomes unused.

### Step 3: Update app.runtime.yaml env_contract

- [ ] In `../holaboss-modules/github/app.runtime.yaml`, update the `env_contract` section from:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GITHUB_INTEGRATION_ID"
```

to:

```yaml
env_contract:
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
  - "PLATFORM_INTEGRATION_TOKEN"
  - "WORKSPACE_API_URL"
  - "WORKSPACE_GITHUB_INTEGRATION_ID"
```

### Step 4: Verify the module builds

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/github && npm run build
```

Expected: build succeeds.

### Step 5: Commit

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/github
git add src/server/integration-client.ts src/server/github-api.ts app.runtime.yaml
git commit -m "feat: migrate github to broker-based token acquisition"
```

---

## Task 6: Final Verification

### Step 1: Run all runtime integration tests

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss/holaOS

# Broker service + route
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts

# Existing integration tests (must not regress)
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
cd runtime/api-server && node --import tsx --test src/app-lifecycle-worker.test.ts
cd runtime/state-store && node --import tsx --test src/store.test.ts
cd runtime/harness-host && node --import tsx --test src/opencode.test.ts

# Desktop typecheck
npm --prefix desktop run typecheck
```

Expected: all tests PASS, desktop typecheck PASS.

### Step 2: Verify module builds

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/gmail && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/sheets && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/github && npm run build
```

Expected: all builds succeed.

### Step 3: Verify runtime prepare

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss/holaOS && npm run desktop:prepare-runtime:local
```

Expected: runtime bundle prepares successfully.

---

## Notes For Execution

- The integration client uses a **token cache** (`cachedToken`). This is safe because modules are long-lived processes where the token does not change during a session. If token refresh becomes important, clear the cache on broker errors.
- The `PLATFORM_INTEGRATION_TOKEN` fallback ensures backwards compatibility. Modules work identically whether or not the broker is available.
- The broker does **not** proxy API calls. Modules still call provider APIs directly. The broker only resolves which token to use. Full proxy execution is deferred to Phase 3.
- Publishing modules (Reddit, Twitter, LinkedIn) already delegate through `WORKSPACE_API_URL` and do not need migration in this phase.
- The `integration-client.ts` is intentionally duplicated across modules rather than shared, following the modules repo's copy-paste architecture.
- When the broker is unreachable (network error during `fetch`), the client falls back to `PLATFORM_INTEGRATION_TOKEN` silently. This ensures modules work in environments without a broker.
