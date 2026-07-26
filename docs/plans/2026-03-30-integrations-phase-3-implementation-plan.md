# Integrations Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the integration lifecycle by adding connection management (manual token import, disconnect, reconnect), migrating the remaining publishing modules (Reddit, Twitter, LinkedIn) to broker-based tokens, and deprecating `PLATFORM_INTEGRATION_TOKEN`.

**Architecture:** Phase 3 closes the two critical gaps from Phases 1-2: (1) there is no way to create connections — the state store has `upsertIntegrationConnection` but no HTTP endpoint exposes it, so the desktop UI shows empty connection lists and the system is unusable without manual database manipulation. Phase 3 adds connection CRUD endpoints, desktop UI for manual token import, and migrates the last 3 modules. It also introduces a runtime deprecation flag for the legacy `PLATFORM_INTEGRATION_TOKEN` env var so Phase 4 can remove it.

**Tech Stack:** TypeScript, Fastify (runtime API server), node:test, Electron (desktop), React (IntegrationsPane)

## Scope

Phase 3 includes:

- connection creation endpoint (manual token import)
- connection update endpoint (status changes, token rotation)
- connection deletion endpoint (with binding cascade check)
- desktop IPC plumbing for connection lifecycle
- desktop UI: token import dialog, disconnect button, reconnect action
- Reddit module migration to broker-based token acquisition
- Twitter module migration to broker-based token acquisition
- LinkedIn module migration to broker-based token acquisition
- runtime deprecation warning for `PLATFORM_INTEGRATION_TOKEN`

Phase 3 does not include:

- OAuth redirect flows (interactive browser-based auth)
- hosted/managed OAuth app registry
- team or org policy controls
- full removal of `PLATFORM_INTEGRATION_TOKEN` (kept behind deprecation flag)

---

## File Structure

### Runtime repo (`holaOS`)

| File | Responsibility |
|------|---------------|
| `runtime/api-server/src/integrations.ts` (modify) | Add connection create, update, delete methods to service |
| `runtime/api-server/src/integrations.test.ts` (modify) | Add connection lifecycle tests |
| `runtime/api-server/src/app.ts` (modify) | Register connection CRUD routes |
| `runtime/api-server/src/integration-runtime.ts` (modify) | Add deprecation warning when legacy token is injected |
| `desktop/src/types/electron.d.ts` (modify) | Add connection management type signatures |
| `desktop/electron/preload.ts` (modify) | Add connection management IPC methods |
| `desktop/electron/main.ts` (modify) | Add connection management IPC handlers |
| `desktop/src/components/panes/IntegrationsPane.tsx` (modify) | Add token import dialog, disconnect, reconnect UI |

### Module repo (`holaboss-modules`)

| File | Responsibility |
|------|---------------|
| `reddit/src/server/integration-client.ts` (new) | Broker client with fallback |
| `reddit/src/server/publisher.ts` (modify) | Async token resolution via broker |
| `reddit/app.runtime.yaml` (modify) | Add broker env vars to contract |
| `twitter/src/server/integration-client.ts` (new) | Broker client with fallback |
| `twitter/src/server/publisher.ts` (modify) | Async token resolution via broker |
| `twitter/app.runtime.yaml` (modify) | Add broker env vars to contract |
| `linkedin/src/server/integration-client.ts` (new) | Broker client with fallback |
| `linkedin/src/server/publisher.ts` (modify) | Async token resolution via broker |
| `linkedin/app.runtime.yaml` (modify) | Add broker env vars to contract |

---

## Task 1: Add Connection Lifecycle Methods To Integration Service

**Files:**
- Modify: `runtime/api-server/src/integrations.ts`
- Modify: `runtime/api-server/src/integrations.test.ts`

### Step 1: Write failing connection lifecycle tests

- [ ] Add these tests to the end of `runtime/api-server/src/integrations.test.ts`:

```ts
test("creates a connection via manual token import and lists it", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const connection = service.createConnection({
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    secretRef: "gya_manual-token-value"
  });

  assert.equal(connection.provider_id, "google");
  assert.equal(connection.account_label, "owner@holaboss.ai");
  assert.equal(connection.auth_mode, "manual_token");
  assert.equal(connection.status, "active");
  assert.ok(connection.connection_id);

  const listed = service.listConnections({ providerId: "google" });
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0]?.connection_id, connection.connection_id);

  store.close();
});

test("updates connection status and secret_ref", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  const connection = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "holaboss-bot",
    authMode: "manual_token",
    grantedScopes: ["repo"],
    secretRef: "ghp_old-token"
  });

  const updated = service.updateConnection(connection.connection_id, {
    status: "expired"
  });
  assert.equal(updated.status, "expired");
  assert.equal(updated.connection_id, connection.connection_id);

  const rotated = service.updateConnection(connection.connection_id, {
    secretRef: "ghp_new-token",
    status: "active"
  });
  assert.equal(rotated.status, "active");

  store.close();
});

test("deletes a connection and rejects deletion when bindings exist", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "opencode",
    status: "active"
  });
  const connection = service.createConnection({
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send"],
    secretRef: "gya_token"
  });

  service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: connection.connection_id,
    isDefault: true
  });

  assert.throws(
    () => service.deleteConnection(connection.connection_id),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 409 &&
      error.message.includes("bound")
  );

  service.deleteBinding(
    service.listBindings({ workspaceId: "workspace-1" }).bindings[0]!.binding_id,
    "workspace-1"
  );

  const result = service.deleteConnection(connection.connection_id);
  assert.equal(result.deleted, true);
  assert.equal(service.listConnections({ providerId: "google" }).connections.length, 0);

  store.close();
});

test("rejects creating a connection with missing required fields", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  assert.throws(
    () => service.createConnection({
      providerId: "",
      ownerUserId: "user-1",
      accountLabel: "test",
      authMode: "manual_token",
      grantedScopes: [],
      secretRef: "token"
    }),
    (error: unknown) =>
      error instanceof IntegrationServiceError && error.statusCode === 400
  );

  assert.throws(
    () => service.createConnection({
      providerId: "google",
      ownerUserId: "",
      accountLabel: "test",
      authMode: "manual_token",
      grantedScopes: [],
      secretRef: "token"
    }),
    (error: unknown) =>
      error instanceof IntegrationServiceError && error.statusCode === 400
  );

  store.close();
});
```

### Step 2: Run tests to verify they fail

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
```

Expected: FAIL because `createConnection`, `updateConnection`, `deleteConnection` do not exist.

### Step 3: Implement connection lifecycle methods

- [ ] Add these methods to the `RuntimeIntegrationService` class in `runtime/api-server/src/integrations.ts`:

```ts
  createConnection(params: {
    providerId: string;
    ownerUserId: string;
    accountLabel: string;
    authMode: string;
    grantedScopes: string[];
    secretRef?: string;
    accountExternalId?: string;
  }): IntegrationConnectionPayload {
    const providerId = requiredString(params.providerId, "provider_id");
    const ownerUserId = requiredString(params.ownerUserId, "owner_user_id");
    const accountLabel = requiredString(params.accountLabel, "account_label");
    const authMode = requiredString(params.authMode, "auth_mode");

    const record = this.store.upsertIntegrationConnection({
      connectionId: randomUUID(),
      providerId,
      ownerUserId,
      accountLabel,
      authMode,
      grantedScopes: params.grantedScopes ?? [],
      status: "active",
      secretRef: params.secretRef,
      accountExternalId: params.accountExternalId
    });

    return toIntegrationConnectionPayload(record);
  }

  updateConnection(connectionId: string, params: {
    status?: string;
    secretRef?: string;
    accountLabel?: string;
    grantedScopes?: string[];
  }): IntegrationConnectionPayload {
    const normalizedId = requiredString(connectionId, "connection_id");
    const existing = this.store.getIntegrationConnection(normalizedId);
    if (!existing) {
      throw new IntegrationServiceError(404, "connection not found");
    }

    const record = this.store.upsertIntegrationConnection({
      connectionId: existing.connectionId,
      providerId: existing.providerId,
      ownerUserId: existing.ownerUserId,
      accountLabel: params.accountLabel ?? existing.accountLabel,
      authMode: existing.authMode,
      grantedScopes: params.grantedScopes ?? existing.grantedScopes,
      status: params.status ?? existing.status,
      secretRef: params.secretRef !== undefined ? params.secretRef : existing.secretRef,
      accountExternalId: existing.accountExternalId
    });

    return toIntegrationConnectionPayload(record);
  }

  deleteConnection(connectionId: string): { deleted: true } {
    const normalizedId = requiredString(connectionId, "connection_id");
    const existing = this.store.getIntegrationConnection(normalizedId);
    if (!existing) {
      throw new IntegrationServiceError(404, "connection not found");
    }

    const bindings = this.store.listIntegrationBindings({}).filter(
      (b) => b.connectionId === normalizedId
    );
    if (bindings.length > 0) {
      throw new IntegrationServiceError(
        409,
        `connection is bound to ${bindings.length} workspace(s) — remove bindings first`
      );
    }

    this.store.deleteIntegrationConnection(normalizedId);
    return { deleted: true };
  }
```

**Note:** The `deleteIntegrationConnection` method may not exist on the store yet. If not, add it to the state store:

In `runtime/state-store/src/store.ts`, add this method to the `RuntimeStateStore` class:

```ts
  deleteIntegrationConnection(connectionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM integration_connections WHERE connection_id = ?")
      .run(connectionId);
    return result.changes > 0;
  }
```

And export the method in `runtime/state-store/src/index.ts` if needed (the store class itself is already exported).

Also, the `listIntegrationBindings` filter call needs to work without a workspace filter. Check if the existing method supports `listIntegrationBindings({})` (empty filter). If it requires `workspaceId`, you may need to query all bindings for the connection differently. Read the store code to verify.

### Step 4: Run tests to verify they pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
```

Expected: all tests PASS.

### Step 5: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/integrations.ts runtime/api-server/src/integrations.test.ts runtime/state-store/src/store.ts
git commit -m "feat: add connection create, update, and delete to integration service"
```

---

## Task 2: Register Connection CRUD Routes

**Files:**
- Modify: `runtime/api-server/src/app.ts`

### Step 1: Add connection routes

- [ ] In `runtime/api-server/src/app.ts`, after the existing `GET /api/v1/integrations/connections` route, add these three routes:

```ts
  app.post("/api/v1/integrations/connections", async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return integrationService.createConnection({
        providerId: typeof request.body.provider_id === "string" ? request.body.provider_id : "",
        ownerUserId: typeof request.body.owner_user_id === "string" ? request.body.owner_user_id : "",
        accountLabel: typeof request.body.account_label === "string" ? request.body.account_label : "",
        authMode: typeof request.body.auth_mode === "string" ? request.body.auth_mode : "manual_token",
        grantedScopes: Array.isArray(request.body.granted_scopes) ? request.body.granted_scopes : [],
        secretRef: typeof request.body.secret_ref === "string" ? request.body.secret_ref : undefined,
        accountExternalId: typeof request.body.account_external_id === "string" ? request.body.account_external_id : undefined
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection creation failed");
    }
  });

  app.patch("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = request.params as { connectionId: string };
    if (!isRecord(request.body)) {
      return sendError(reply, 400, "request body must be an object");
    }
    try {
      return integrationService.updateConnection(params.connectionId, {
        status: typeof request.body.status === "string" ? request.body.status : undefined,
        secretRef: typeof request.body.secret_ref === "string" ? request.body.secret_ref : undefined,
        accountLabel: typeof request.body.account_label === "string" ? request.body.account_label : undefined,
        grantedScopes: Array.isArray(request.body.granted_scopes) ? request.body.granted_scopes : undefined
      });
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection update failed");
    }
  });

  app.delete("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = request.params as { connectionId: string };
    try {
      return integrationService.deleteConnection(params.connectionId);
    } catch (error) {
      if (error instanceof IntegrationServiceError) {
        return sendError(reply, error.statusCode, error.message);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "connection deletion failed");
    }
  });
```

### Step 2: Run existing tests to verify no regression

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integrations.test.ts
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
```

Expected: all tests PASS.

### Step 3: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/app.ts
git commit -m "feat: register connection create, update, and delete routes"
```

---

## Task 3: Add Desktop IPC And UI For Connection Management

**Files:**
- Modify: `desktop/src/types/electron.d.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/components/panes/IntegrationsPane.tsx`

### Step 1: Add connection management types to electron.d.ts

- [ ] Add this interface before `ElectronAPI` in `desktop/src/types/electron.d.ts`:

```ts
  interface IntegrationCreateConnectionPayload {
    provider_id: string;
    owner_user_id: string;
    account_label: string;
    auth_mode: string;
    granted_scopes: string[];
    secret_ref?: string;
  }

  interface IntegrationUpdateConnectionPayload {
    status?: string;
    secret_ref?: string;
    account_label?: string;
  }
```

- [ ] Add these methods inside the `workspace` property of `ElectronAPI`:

```ts
      createIntegrationConnection: (payload: IntegrationCreateConnectionPayload) => Promise<IntegrationConnectionPayload>;
      updateIntegrationConnection: (connectionId: string, payload: IntegrationUpdateConnectionPayload) => Promise<IntegrationConnectionPayload>;
      deleteIntegrationConnection: (connectionId: string) => Promise<{ deleted: boolean }>;
```

### Step 2: Add preload IPC methods

- [ ] Add matching type interfaces in `desktop/electron/preload.ts` (before `contextBridge.exposeInMainWorld`):

```ts
interface IntegrationCreateConnectionPayload {
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  auth_mode: string;
  granted_scopes: string[];
  secret_ref?: string;
}

interface IntegrationUpdateConnectionPayload {
  status?: string;
  secret_ref?: string;
  account_label?: string;
}
```

- [ ] Add inside the `workspace` property of `contextBridge.exposeInMainWorld`:

```ts
    createIntegrationConnection: (payload: IntegrationCreateConnectionPayload) =>
      ipcRenderer.invoke("workspace:createIntegrationConnection", payload) as Promise<IntegrationConnectionPayload>,
    updateIntegrationConnection: (connectionId: string, payload: IntegrationUpdateConnectionPayload) =>
      ipcRenderer.invoke("workspace:updateIntegrationConnection", connectionId, payload) as Promise<IntegrationConnectionPayload>,
    deleteIntegrationConnection: (connectionId: string) =>
      ipcRenderer.invoke("workspace:deleteIntegrationConnection", connectionId) as Promise<{ deleted: boolean }>,
```

### Step 3: Add main process IPC handlers

- [ ] In `desktop/electron/main.ts`, add the corresponding type declarations and helper functions (follow the existing pattern for `listIntegrationCatalog` etc.):

```ts
async function createIntegrationConnection(
  payload: IntegrationCreateConnectionPayload,
): Promise<IntegrationConnectionPayload> {
  return requestRuntimeJson<IntegrationConnectionPayload>({
    method: "POST",
    path: "/api/v1/integrations/connections",
    payload,
  });
}

async function updateIntegrationConnection(
  connectionId: string,
  payload: IntegrationUpdateConnectionPayload,
): Promise<IntegrationConnectionPayload> {
  return requestRuntimeJson<IntegrationConnectionPayload>({
    method: "PATCH",
    path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
    payload,
  });
}

async function deleteIntegrationConnection(
  connectionId: string,
): Promise<{ deleted: boolean }> {
  return requestRuntimeJson<{ deleted: boolean }>({
    method: "DELETE",
    path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
  });
}
```

- [ ] Register the IPC handlers after existing integration handlers:

```ts
  handleTrustedIpc(
    "workspace:createIntegrationConnection",
    ["main"],
    async (_event, payload: IntegrationCreateConnectionPayload) =>
      createIntegrationConnection(payload),
  );
  handleTrustedIpc(
    "workspace:updateIntegrationConnection",
    ["main"],
    async (_event, connectionId: string, payload: IntegrationUpdateConnectionPayload) =>
      updateIntegrationConnection(connectionId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteIntegrationConnection",
    ["main"],
    async (_event, connectionId: string) =>
      deleteIntegrationConnection(connectionId),
  );
```

### Step 4: Add token import dialog and connection actions to IntegrationsPane

- [ ] Read the current `desktop/src/components/panes/IntegrationsPane.tsx` fully. Then add:

1. **State for the import dialog**: `showImportDialog`, `importForm` fields (provider pre-filled, account label, token)

2. **Import Token button** in the provider detail header (next to the state badge):
```tsx
<button
  type="button"
  onClick={() => setShowImportDialog(true)}
  className="rounded-[12px] border border-neon-green/35 bg-neon-green/8 px-3 py-1.5 text-[11px] font-medium text-neon-green transition-colors duration-200 hover:bg-neon-green/14"
>
  Import Token
</button>
```

3. **Token import dialog** (shown when `showImportDialog` is true) — a simple form with:
   - Account label input (text)
   - Token input (password field)
   - Submit button that calls `window.electronAPI.workspace.createIntegrationConnection()`
   - On success: refresh connections list, close dialog

4. **Disconnect button** per connection (next to the existing Bind/Bound display):
```tsx
<button
  type="button"
  disabled={isSaving}
  onClick={() => handleDisconnect(conn.connection_id)}
  className="rounded-[12px] border border-rose-400/25 bg-rose-400/6 p-2 text-rose-400/82 transition-colors duration-200 hover:bg-rose-400/14 disabled:opacity-50"
  title="Disconnect"
>
  <Trash2 size={13} />
</button>
```

5. **handleDisconnect function**: calls `deleteIntegrationConnection`, removes from local state, handles 409 error (bound connections) by showing error message.

6. **Reconnect action** for inactive connections — a button that opens the import dialog pre-filled with the connection's account label, calling `updateIntegrationConnection` with a new `secret_ref` and `status: "active"`.

The `handleCreateConnection` function should:
```ts
const handleCreateConnection = async (accountLabel: string, token: string) => {
  if (!selectedProvider) return;
  setIsSaving(true);
  try {
    const runtimeConfig = await window.electronAPI.runtime.getConfig();
    const connection = await window.electronAPI.workspace.createIntegrationConnection({
      provider_id: selectedProvider.provider_id,
      owner_user_id: runtimeConfig.userId ?? "local",
      account_label: accountLabel,
      auth_mode: "manual_token",
      granted_scopes: selectedProvider.default_scopes,
      secret_ref: token,
    });
    setConnections((prev) => [...prev, connection]);
    setShowImportDialog(false);
  } catch (error) {
    setErrorMessage(normalizeErrorMessage(error));
  } finally {
    setIsSaving(false);
  }
};
```

### Step 5: Verify desktop typecheck

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS.

### Step 6: Commit

- [ ] Run:

```bash
git add desktop/src/types/electron.d.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/src/components/panes/IntegrationsPane.tsx
git commit -m "feat: add desktop connection management with token import UI"
```

---

## Task 4: Migrate Publishing Modules To Broker-Based Token Acquisition

**Files (module repo at `/Users/you/holaboss-ai/holaboss-modules/`):**
- Create: `reddit/src/server/integration-client.ts`
- Modify: `reddit/src/server/publisher.ts`
- Modify: `reddit/app.runtime.yaml`
- Create: `twitter/src/server/integration-client.ts`
- Modify: `twitter/src/server/publisher.ts`
- Modify: `twitter/app.runtime.yaml`
- Create: `linkedin/src/server/integration-client.ts`
- Modify: `linkedin/src/server/publisher.ts`
- Modify: `linkedin/app.runtime.yaml`

### Step 1: Create integration-client.ts in all 3 modules

- [ ] Create the identical `src/server/integration-client.ts` in `reddit/`, `twitter/`, and `linkedin/`:

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

### Step 2: Update publisher.ts in each module

- [ ] For each module, READ the existing `publisher.ts` first, then apply this migration pattern:

**Reddit** (`reddit/src/server/publisher.ts`):

Replace the constructor and headers method. The key changes:
1. Add import: `import { getProviderToken } from "./integration-client"`
2. Remove `private readonly integrationToken: string` from class fields
3. Add `private cachedToken: string | null = null` to class fields
4. Remove `this.integrationToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? ""` from constructor
5. Add async token resolution method
6. Make `headers()` async
7. Update all callers of `this.headers()` to `await this.headers()`

The constructor becomes:
```ts
  private readonly workspaceApiUrl: string
  private readonly integrationId: string
  private cachedToken: string | null = null

  constructor() {
    const raw = process.env.WORKSPACE_API_URL ?? "http://localhost:3033"
    this.workspaceApiUrl = raw.replace(/\/+$/, "")
    this.integrationId = process.env.WORKSPACE_REDDIT_INTEGRATION_ID ?? ""
  }

  private async resolveToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken
    this.cachedToken = await getProviderToken("reddit")
    return this.cachedToken
  }

  private async headers() {
    const token = await this.resolveToken()
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }
```

Then change every `this.headers()` call to `await this.headers()` in `publish()` and `cancelScheduled()`.

**Twitter** (`twitter/src/server/publisher.ts`):
Same pattern but `getProviderToken("twitter")` and `WORKSPACE_X_INTEGRATION_ID`.

**LinkedIn** (`linkedin/src/server/publisher.ts`):
Same pattern but `getProviderToken("linkedin")` and `WORKSPACE_LINKEDIN_INTEGRATION_ID`.

### Step 3: Update app.runtime.yaml in each module

- [ ] Add `HOLABOSS_INTEGRATION_BROKER_URL` and `HOLABOSS_APP_GRANT` to the `env_contract` list in each module's `app.runtime.yaml`. Keep all existing entries.

### Step 4: Build each module

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/reddit && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/twitter && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/linkedin && npm run build
```

Expected: all 3 build successfully.

### Step 5: Commit each module

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/reddit
git add src/server/integration-client.ts src/server/publisher.ts app.runtime.yaml
git commit -m "feat: migrate reddit publisher to broker-based token acquisition"

cd /Users/you/holaboss-ai/holaboss-modules/twitter
git add src/server/integration-client.ts src/server/publisher.ts app.runtime.yaml
git commit -m "feat: migrate twitter publisher to broker-based token acquisition"

cd /Users/you/holaboss-ai/holaboss-modules/linkedin
git add src/server/integration-client.ts src/server/publisher.ts app.runtime.yaml
git commit -m "feat: migrate linkedin publisher to broker-based token acquisition"
```

---

## Task 5: Add PLATFORM_INTEGRATION_TOKEN Deprecation Warning

**Files:**
- Modify: `runtime/api-server/src/integration-runtime.ts`

### Step 1: Add deprecation log

- [ ] In `runtime/api-server/src/integration-runtime.ts`, in the `resolveIntegrationRuntime` function, find the section where `PLATFORM_INTEGRATION_TOKEN` is set:

```ts
  if (platformIntegrationTokens.length === 1) {
    env.PLATFORM_INTEGRATION_TOKEN = platformIntegrationTokens[0]!;
  }
```

Add a deprecation notice after it:

```ts
  if (platformIntegrationTokens.length === 1) {
    env.PLATFORM_INTEGRATION_TOKEN = platformIntegrationTokens[0]!;
    if (typeof process !== "undefined" && process.stderr) {
      process.stderr.write(
        `[holaboss] DEPRECATION: PLATFORM_INTEGRATION_TOKEN is set for app "${params.appId}". ` +
        `Migrate to HOLABOSS_INTEGRATION_BROKER_URL + HOLABOSS_APP_GRANT. ` +
        `This env var will be removed in a future release.\n`
      );
    }
  }
```

### Step 2: Verify tests still pass

- [ ] Run:

```bash
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
```

Expected: all tests PASS (deprecation is a log, not a behavior change).

### Step 3: Commit

- [ ] Run:

```bash
git add runtime/api-server/src/integration-runtime.ts
git commit -m "feat: add deprecation warning for PLATFORM_INTEGRATION_TOKEN"
```

---

## Task 6: Final Verification

### Step 1: Run all runtime tests

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss/holaOS

cd runtime/api-server && node --import tsx --test src/integrations.test.ts
cd runtime/api-server && node --import tsx --test src/integration-broker.test.ts
cd runtime/api-server && node --import tsx --test src/integration-runtime.test.ts
cd runtime/api-server && node --import tsx --test src/app-lifecycle-worker.test.ts
cd runtime/state-store && node --import tsx --test src/store.test.ts
cd runtime/harness-host && node --import tsx --test src/opencode.test.ts
npm --prefix desktop run typecheck
```

Expected: all tests PASS, desktop typecheck PASS.

### Step 2: Verify module builds

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss-modules/reddit && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/twitter && npm run build
cd /Users/you/holaboss-ai/holaboss-modules/linkedin && npm run build
```

Expected: all builds succeed.

### Step 3: Verify runtime bundle

- [ ] Run:

```bash
cd /Users/you/holaboss-ai/holaboss/holaOS && npm run desktop:prepare-runtime:local
```

Expected: runtime bundle prepares successfully.

---

## Notes For Execution

- Connection `deleteIntegrationConnection` may not exist on the state store. If missing, add a simple `DELETE FROM integration_connections WHERE connection_id = ?` method. Check the store first before implementing.
- The `listIntegrationBindings` method may require a `workspaceId` filter. For the connection deletion cascade check, you may need to query all bindings across workspaces. Check the store's actual implementation and adapt the `deleteConnection` method if needed.
- Publishing modules use `this.headers()` as a method call inside async methods (`publish`, `cancelScheduled`). Making `headers()` async and adding `await` is safe because all callers are already async.
- The token import dialog in IntegrationsPane should use the existing component patterns (rounded cards, theme classes, neon-green accents). Read the current pane code to match the design system.
- The deprecation warning writes to `stderr` to avoid polluting structured JSON output. It fires once per app start, not per request.
- `PLATFORM_INTEGRATION_TOKEN` is NOT removed in this phase — it remains as a fallback. Full removal is Phase 4.
