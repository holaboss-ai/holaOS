# Workspace Integration Auto-Bind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When creating a workspace, automatically detect integration requirements from the template's apps, check if the user has existing connections, auto-bind if available, and trigger the Composio connect flow if not — all before the workspace is fully created.

**Architecture:** The `createWorkspace` flow in `desktop/electron/main.ts` is extended: after template materialization but before workspace record creation, it parses `app.runtime.yaml` files from the materialized template to extract integration requirements. It returns a `pending_integrations` list to the frontend if any provider has no active connection. The `MarketplacePane.tsx` UI gains a new "Connect integrations" step between template selection and workspace creation. If all integrations are satisfied (existing connections found), the workspace is created and bindings are auto-created. If not, the user completes the Composio connect flow inline, then creation proceeds.

**Tech Stack:** TypeScript, Electron IPC, React (MarketplacePane), Fastify (runtime API), YAML parsing

---

## File Structure

| File | Responsibility |
|------|---------------|
| `desktop/electron/main.ts` (modify) | Add `resolveTemplateIntegrations()` helper, update `createWorkspace()` to parse integrations from materialized template, auto-bind after workspace creation |
| `desktop/src/types/electron.d.ts` (modify) | Add `IntegrationRequirement` type, update `createWorkspace` return type |
| `desktop/electron/preload.ts` (modify) | Add `resolveTemplateIntegrations` IPC method |
| `desktop/src/components/panes/MarketplacePane.tsx` (modify) | Add integration connect step between template selection and workspace creation |
| `desktop/src/lib/workspaceDesktop.tsx` (modify) | Update `createWorkspace` to handle integration flow |

---

## Task 1: Add Template Integration Resolution to Electron Main

**Files:**
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/types/electron.d.ts`
- Modify: `desktop/electron/preload.ts`

This task adds the ability to parse integration requirements from a materialized template's files, check which providers the user already has connections for, and return the result.

### Step 1: Add types to electron.d.ts

- [ ] Read `desktop/src/types/electron.d.ts`, then add these types before `ElectronAPI`:

```ts
  interface TemplateIntegrationRequirement {
    key: string;
    provider: string;
    required: boolean;
    app_id: string;
  }

  interface ResolveTemplateIntegrationsResult {
    requirements: TemplateIntegrationRequirement[];
    connected_providers: string[];
    missing_providers: string[];
  }
```

- [ ] Add this method to `ElectronAPI.workspace`:

```ts
      resolveTemplateIntegrations: (payload: HolabossCreateWorkspacePayload) => Promise<ResolveTemplateIntegrationsResult>;
```

### Step 2: Add preload IPC

- [ ] Read `desktop/electron/preload.ts`. Add the matching type interfaces (same as electron.d.ts, following the existing pattern of local type redeclaration). Add inside the `workspace` property:

```ts
    resolveTemplateIntegrations: (payload: HolabossCreateWorkspacePayload) =>
      ipcRenderer.invoke("workspace:resolveTemplateIntegrations", payload) as Promise<ResolveTemplateIntegrationsResult>,
```

### Step 3: Implement resolveTemplateIntegrations in main.ts

- [ ] Read `desktop/electron/main.ts`. Find the `materializeLocalTemplate` and `materializeMarketplaceTemplate` functions to understand how templates are materialized.

- [ ] Add a helper function that extracts integration requirements from materialized template files. Place it near the existing template functions (around line 4800):

```ts
function extractIntegrationRequirementsFromTemplateFiles(
  files: MaterializedTemplateFilePayload[]
): Array<{ key: string; provider: string; required: boolean; appId: string }> {
  const requirements: Array<{ key: string; provider: string; required: boolean; appId: string }> = [];

  for (const file of files) {
    // Match apps/{appId}/app.runtime.yaml
    const match = file.path.match(/^apps\/([^/]+)\/app\.runtime\.yaml$/);
    if (!match) continue;
    const appId = match[1]!;

    let content: string;
    try {
      content = Buffer.from(file.content_base64, "base64").toString("utf-8");
    } catch {
      continue;
    }

    // Simple YAML parsing for integration block
    // Look for "integration:" (legacy single) or "integrations:" (list)
    const yaml = parseYamlSafe(content);
    if (!yaml || typeof yaml !== "object") continue;

    const record = yaml as Record<string, unknown>;

    // Legacy single integration
    if (record.integration && typeof record.integration === "object") {
      const integ = record.integration as Record<string, unknown>;
      const provider = typeof integ.destination === "string"
        ? integ.destination
        : typeof integ.provider === "string"
          ? integ.provider
          : null;
      if (provider) {
        requirements.push({
          key: provider,
          provider,
          required: integ.required !== false,
          appId
        });
      }
    }

    // List-based integrations
    if (Array.isArray(record.integrations)) {
      for (const item of record.integrations) {
        if (typeof item !== "object" || item === null) continue;
        const integ = item as Record<string, unknown>;
        const provider = typeof integ.provider === "string" ? integ.provider : null;
        const key = typeof integ.key === "string" ? integ.key : provider;
        if (provider && key) {
          requirements.push({
            key,
            provider,
            required: integ.required !== false,
            appId
          });
        }
      }
    }
  }

  return requirements;
}
```

**Note:** `parseYamlSafe` should use the existing `js-yaml` import in main.ts. Check if `js-yaml` is already imported — if so, use `yaml.load()`. If not, check if there's another YAML parser available. The runtime api-server has `js-yaml` as a dependency. For main.ts, a simple regex-based approach is also acceptable if YAML parsing is not already available.

- [ ] Add the main `resolveTemplateIntegrations` function:

```ts
async function resolveTemplateIntegrations(
  payload: HolabossCreateWorkspacePayload
): Promise<ResolveTemplateIntegrationsResult> {
  // Materialize template to get files (same logic as createWorkspace)
  const templateRootPath = payload.template_root_path?.trim() || "";
  const templateName = payload.template_name?.trim() || "";
  let materializedTemplate: MaterializeTemplateResponsePayload | null = null;

  if (templateRootPath) {
    materializedTemplate = await materializeLocalTemplate({ template_root_path: templateRootPath });
  } else if (templateName) {
    materializedTemplate = await materializeMarketplaceTemplate({
      holaboss_user_id: payload.holaboss_user_id,
      template_name: templateName,
      template_ref: payload.template_ref,
      template_commit: payload.template_commit,
    });
  }

  if (!materializedTemplate) {
    return { requirements: [], connected_providers: [], missing_providers: [] };
  }

  // Extract integration requirements from app.runtime.yaml files
  const requirements = extractIntegrationRequirementsFromTemplateFiles(materializedTemplate.files);
  if (requirements.length === 0) {
    return { requirements: [], connected_providers: [], missing_providers: [] };
  }

  // Check which providers the user already has active connections for
  const uniqueProviders = [...new Set(requirements.map(r => r.provider))];
  let connections: IntegrationConnectionListResponsePayload;
  try {
    connections = await listIntegrationConnections();
  } catch {
    connections = { connections: [] };
  }

  const connectedProviders = new Set<string>();
  for (const conn of connections.connections) {
    if (conn.status === "active") {
      connectedProviders.add(conn.provider_id);
    }
  }

  const connected: string[] = [];
  const missing: string[] = [];
  for (const provider of uniqueProviders) {
    if (connectedProviders.has(provider)) {
      connected.push(provider);
    } else {
      missing.push(provider);
    }
  }

  return {
    requirements: requirements.map(r => ({
      key: r.key,
      provider: r.provider,
      required: r.required,
      app_id: r.appId
    })),
    connected_providers: connected,
    missing_providers: missing
  };
}
```

- [ ] Register the IPC handler (near the existing workspace IPC handlers):

```ts
  handleTrustedIpc(
    "workspace:resolveTemplateIntegrations",
    ["main"],
    async (_event, payload: HolabossCreateWorkspacePayload) =>
      resolveTemplateIntegrations(payload),
  );
```

### Step 4: Add auto-bind logic to createWorkspace

- [ ] In `createWorkspace()` in main.ts, after the workspace is activated (after the `PATCH /api/v1/workspaces/{workspaceId}` call with `status: "active"`, around line 6285-6294), add auto-binding logic:

```ts
    // Auto-bind integrations for apps that require them
    if (materializedTemplate) {
      const integrationReqs = extractIntegrationRequirementsFromTemplateFiles(materializedTemplate.files);
      if (integrationReqs.length > 0) {
        let connections: IntegrationConnectionListResponsePayload;
        try {
          connections = await listIntegrationConnections();
        } catch {
          connections = { connections: [] };
        }

        for (const req of integrationReqs) {
          const activeConnection = connections.connections.find(
            c => c.provider_id === req.provider && c.status === "active"
          );
          if (activeConnection) {
            try {
              await upsertIntegrationBinding(
                workspaceId,
                "workspace",
                "default",
                req.key,
                { connection_id: activeConnection.connection_id, is_default: true }
              );
            } catch {
              // Non-fatal: binding may already exist or workspace may not be ready
            }
          }
        }
      }
    }
```

**Important:** Find the exact location of `upsertIntegrationBinding` function in main.ts. It should already exist since the IntegrationsPane uses it. Search for "upsertIntegrationBinding" to find the function signature and ensure the call matches.

### Step 5: Verify typecheck

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS (only pre-existing MarketplaceGallery errors).

### Step 6: Commit

- [ ] Run:

```bash
git add desktop/electron/main.ts desktop/src/types/electron.d.ts desktop/electron/preload.ts
git commit -m "feat: add template integration resolution and auto-bind during workspace creation"
```

---

## Task 2: Add Integration Connect Step to MarketplacePane

**Files:**
- Modify: `desktop/src/components/panes/MarketplacePane.tsx`
- Modify: `desktop/src/lib/workspaceDesktop.tsx`

This task adds a new step to the workspace creation flow: after the user clicks "Create workspace", if integrations are needed and not connected, show a connect step before proceeding.

### Step 1: Update workspaceDesktop.tsx to support integration resolution

- [ ] Read `desktop/src/lib/workspaceDesktop.tsx` fully. Add new state variables and functions to the context.

Add these state variables inside the provider:

```ts
const [pendingIntegrations, setPendingIntegrations] = useState<ResolveTemplateIntegrationsResult | null>(null);
const [isResolvingIntegrations, setIsResolvingIntegrations] = useState(false);
```

Add a new function `resolveAndCreateWorkspace` that replaces the direct `createWorkspace` flow:

```ts
  async function resolveIntegrationsBeforeCreate(): Promise<ResolveTemplateIntegrationsResult | null> {
    if (templateSourceMode === "empty" || templateSourceMode === "empty_onboarding") {
      return null; // No template, no integration requirements
    }
    setIsResolvingIntegrations(true);
    try {
      const payload: HolabossCreateWorkspacePayload = templateSourceMode === "marketplace"
        ? {
            holaboss_user_id: resolvedUserId,
            harness: selectedCreateHarness,
            name: newWorkspaceName.trim() || "Desktop Workspace",
            template_mode: "template",
            template_name: selectedMarketplaceTemplate?.name ?? ""
          }
        : {
            holaboss_user_id: resolvedUserId || "local-oss",
            harness: selectedCreateHarness,
            name: newWorkspaceName.trim() || "Desktop Workspace",
            template_mode: "template",
            template_root_path: selectedTemplateFolder?.rootPath ?? ""
          };

      const result = await window.electronAPI.workspace.resolveTemplateIntegrations(payload);
      if (result.missing_providers.length > 0) {
        setPendingIntegrations(result);
        return result;
      }
      return null; // All integrations satisfied
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
      return null;
    } finally {
      setIsResolvingIntegrations(false);
    }
  }

  function clearPendingIntegrations() {
    setPendingIntegrations(null);
  }
```

- [ ] Add these to the context interface and provider value:

In the interface, add:

```ts
  pendingIntegrations: ResolveTemplateIntegrationsResult | null;
  isResolvingIntegrations: boolean;
  resolveIntegrationsBeforeCreate: () => Promise<ResolveTemplateIntegrationsResult | null>;
  clearPendingIntegrations: () => void;
```

In the provider value object, add:

```ts
      pendingIntegrations,
      isResolvingIntegrations,
      resolveIntegrationsBeforeCreate,
      clearPendingIntegrations,
```

### Step 2: Update MarketplacePane.tsx with integration connect step

- [ ] Read `desktop/src/components/panes/MarketplacePane.tsx` fully. Extend the `View` type and add the connect step.

Change the View type:

```ts
type View = "gallery" | "detail" | "creating" | "connect_integrations";
```

Add state for the Composio connect flow:

```ts
const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
const [connectStatus, setConnectStatus] = useState("");
```

Destructure the new values from context:

```ts
const {
  // ... existing destructured values ...
  pendingIntegrations,
  isResolvingIntegrations,
  resolveIntegrationsBeforeCreate,
  clearPendingIntegrations,
} = useWorkspaceDesktop();
```

Update `handleCreate`:

```ts
  async function handleCreate() {
    // First check if integrations are needed
    const pending = await resolveIntegrationsBeforeCreate();
    if (pending && pending.missing_providers.length > 0) {
      setView("connect_integrations");
      return;
    }
    // All integrations satisfied (or no integrations needed), proceed
    void createWorkspace();
  }
```

Add a handler for connecting a single provider:

```ts
  async function handleConnectProvider(provider: string) {
    setConnectingProvider(provider);
    setConnectStatus("Preparing...");
    try {
      const runtimeConfig = await window.electronAPI.runtime.getConfig();
      const userId = runtimeConfig.userId ?? "local";

      const link = await window.electronAPI.workspace.composioConnect({
        provider,
        owner_user_id: userId
      });

      setConnectStatus("Complete authorization in your browser...");
      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      // Poll for ACTIVE
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const status = await window.electronAPI.workspace.composioAccountStatus(link.connected_account_id);
        if (status.status === "ACTIVE") {
          // Finalize — create local connection
          await window.electronAPI.workspace.composioFinalize({
            connected_account_id: link.connected_account_id,
            provider,
            owner_user_id: userId,
            account_label: `${provider} (Managed)`
          });
          setConnectStatus("");
          setConnectingProvider(null);

          // Re-resolve to update the missing list
          const updated = await resolveIntegrationsBeforeCreate();
          if (!updated || updated.missing_providers.length === 0) {
            // All connected now — proceed to create
            setView("creating");
            void createWorkspace();
          }
          return;
        }
      }
      setConnectStatus("Connection timed out. Please try again.");
    } catch (error) {
      setConnectStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectingProvider(null);
    }
  }
```

Add the "connect_integrations" view inside the return JSX, as a new branch in the view conditional (after the `creating` view):

```tsx
) : view === "connect_integrations" && pendingIntegrations ? (
  <div className="flex h-full min-h-0 flex-col">
    <button
      type="button"
      onClick={() => { clearPendingIntegrations(); setView("creating"); }}
      className="mb-4 self-start text-[12px] text-text-muted/76 underline transition-colors hover:text-text-main"
    >
      &larr; Back
    </button>

    <div className="mx-auto w-full max-w-md">
      <div className="text-[10px] uppercase text-text-dim/72">
        Connect integrations
      </div>
      <div className="mt-1 text-[20px] font-semibold text-text-main">
        This workspace needs access
      </div>
      <div className="mt-2 text-[13px] text-text-muted/84">
        Connect the following accounts to continue.
      </div>

      <div className="mt-4 grid gap-3">
        {pendingIntegrations.missing_providers.map(provider => (
          <div
            key={provider}
            className="flex items-center justify-between rounded-[14px] border border-panel-border/35 bg-[var(--theme-subtle-bg)] px-4 py-3"
          >
            <div className="text-[13px] font-medium capitalize text-text-main">
              {provider}
            </div>
            <button
              type="button"
              disabled={connectingProvider !== null}
              onClick={() => void handleConnectProvider(provider)}
              className="rounded-[12px] border border-neon-green/35 bg-neon-green/8 px-3 py-1.5 text-[11px] font-medium text-neon-green transition-colors hover:bg-neon-green/14 disabled:opacity-50"
            >
              {connectingProvider === provider ? "Connecting..." : "Connect"}
            </button>
          </div>
        ))}

        {pendingIntegrations.connected_providers.map(provider => (
          <div
            key={provider}
            className="flex items-center justify-between rounded-[14px] border border-neon-green/20 bg-neon-green/4 px-4 py-3"
          >
            <div className="text-[13px] font-medium capitalize text-text-main">
              {provider}
            </div>
            <span className="text-[11px] text-neon-green">Connected</span>
          </div>
        ))}
      </div>

      {connectStatus ? (
        <div className="mt-3 text-[12px] text-text-muted">{connectStatus}</div>
      ) : null}
    </div>
  </div>
```

Also update the "Create workspace" button to show a loading state during integration resolution:

```tsx
<button
  type="button"
  disabled={!newWorkspaceName.trim() || isResolvingIntegrations}
  onClick={handleCreate}
  className="mt-5 w-full rounded-[18px] border border-[rgba(247,90,84,0.38)] bg-[rgba(247,90,84,0.9)] px-6 py-3 text-[14px] font-medium text-white transition-colors hover:bg-[rgba(247,90,84,1)] disabled:cursor-not-allowed disabled:opacity-50"
>
  {isResolvingIntegrations ? "Checking integrations..." : "Create workspace"}
</button>
```

### Step 3: Verify typecheck

- [ ] Run:

```bash
npm --prefix desktop run typecheck
```

Expected: PASS.

### Step 4: Commit

- [ ] Run:

```bash
git add desktop/src/components/panes/MarketplacePane.tsx desktop/src/lib/workspaceDesktop.tsx
git commit -m "feat: add integration connect step to workspace creation flow"
```

---

## Task 3: Handle Provider-to-Toolkit Mapping in Connect Flow

**Files:**
- Modify: `desktop/electron/main.ts`

The Composio connect endpoint expects a `provider` field which gets mapped to a toolkit slug server-side (`google` → `gmail`). The integration requirements use provider names like `google`, which is what we pass. This task ensures the mapping is consistent.

### Step 1: Verify mapping exists in app.ts

- [ ] Read `runtime/api-server/src/app.ts` and verify the `PROVIDER_TO_COMPOSIO_TOOLKIT` mapping is present (added in Phase 4). The `/composio/connect` route already handles the mapping. No runtime changes needed.

### Step 2: Add display name mapping to MarketplacePane

- [ ] In `MarketplacePane.tsx`, add a display name mapping for the provider names shown in the connect step:

```ts
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  reddit: "Reddit",
  twitter: "Twitter / X",
  linkedin: "LinkedIn"
};

function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}
```

Update the connect_integrations view to use `providerDisplayName(provider)` instead of raw `provider` with `capitalize`.

### Step 3: Commit

- [ ] Run:

```bash
git add desktop/src/components/panes/MarketplacePane.tsx
git commit -m "fix: use proper display names for providers in integration connect step"
```

---

## Task 4: End-to-End Manual Verification

### Step 1: Verify the full flow

- [ ] Start the desktop app with `COMPOSIO_API_KEY` set.

- [ ] Delete any existing workspace.

- [ ] Go to Marketplace, select a template that has a Gmail app (e.g., `gmail_assistant`).

- [ ] Click "Create workspace".

- [ ] Expected: If no Google connection exists, the "Connect integrations" step appears showing "Google" with a "Connect" button.

- [ ] Click "Connect", complete OAuth in browser.

- [ ] Expected: After OAuth completes, the provider shows "Connected" and workspace creation proceeds automatically.

- [ ] Expected: In the created workspace, the Gmail app has a working integration binding (auto-bound).

- [ ] Verify: Send a test email via the Gmail tool in chat.

### Step 2: Verify auto-bind skip

- [ ] Create another workspace with the same template.

- [ ] Expected: Since the Google connection already exists, the connect step is skipped entirely and the workspace is created directly with the binding auto-applied.

---

## Notes For Execution

- **YAML parsing in main.ts**: Check if `js-yaml` is already imported in main.ts. If not, it may be available via the runtime bundle or as a devDependency. If neither, use a simple regex approach for the limited YAML parsing needed (just extracting `integration.destination` / `integration.provider` and `integrations[].provider`).

- **Template materialization is idempotent**: `resolveTemplateIntegrations` calls the same materialize functions as `createWorkspace`. For marketplace templates, this means an extra API call to the control plane. If this is a concern, the materialized template could be cached between the resolve and create steps. For V1, the extra call is acceptable.

- **Auto-bind uses workspace-level default binding**: Each integration requirement creates a `targetType: "workspace", targetId: "default"` binding. This means all apps in the workspace share the same connection per provider, which matches the current binding model.

- **Error handling in connect flow**: If the connect flow fails or times out, the user can click "Back" and try again, or proceed without connecting (workspace will be created but tools will fail at runtime). The connect step is not a hard gate for V1.

- **Catalog auth_modes check**: The connect button should only appear for providers that support managed connect (`auth_modes.includes("managed")` in the catalog). For V1, all providers in the catalog support managed, so this check can be deferred.
