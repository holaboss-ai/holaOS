# Integrations Phase 1 Implementation Plan

> **Execution Note:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first end-to-end integrations layer for Holaboss, including runtime parsing of integration requirements, persisted connections and bindings, a compatibility broker/API, app lifecycle injection, and a desktop management surface.

**Architecture:** Phase 1 is a compatibility bridge. It introduces structured integration metadata and binding resolution without forcing every existing module to immediately abandon `PLATFORM_INTEGRATION_TOKEN`. The runtime becomes the source of truth for connections and bindings, the desktop gets a first-class Integrations UI, and app lifecycle execution injects resolved integration data into app processes.

**Tech Stack:** TypeScript, Electron, React, Fastify, better-sqlite3, local runtime state store, YAML app manifests

## Scope

This plan implements the Phase 1 bridge described in:

- `docs/plans/2026-03-30-integrations-product-and-ux-design.md`
- `docs/plans/2026-03-30-integrations-engineering-design.md`

Phase 1 includes:

- parsing integration metadata from app manifests
- storing integration connections and workspace/app bindings
- exposing runtime APIs for catalog, connections, and bindings
- injecting compatibility env vars and a future-facing broker contract into apps
- adding a desktop Integrations management center

Phase 1 does not include:

- full provider proxy execution for every app call
- removing `PLATFORM_INTEGRATION_TOKEN`
- managed control-plane connection synchronization
- team/org policy controls

## Task 1: Parse Integration Requirements From App Manifests

**Files:**
- Create: `runtime/api-server/src/integration-types.ts`
- Modify: `runtime/api-server/src/workspace-runtime-plan.ts`
- Modify: `runtime/api-server/src/workspace-runtime-plan.test.ts`
- Modify: `runtime/api-server/src/workspace-apps.ts`
- Modify: `runtime/api-server/src/app.test.ts`

**Step 1: Write failing manifest parsing tests**

Add tests proving that `app.runtime.yaml` can parse both:

- legacy single-block `integration:`
- new list-based `integrations:`

Test cases should assert these fields:

```ts
assert.deepEqual(result.integrations, [
  {
    key: "primary_google",
    provider: "google",
    capability: "gmail",
    scopes: ["gmail.send", "gmail.readonly"],
    required: true,
    credentialSource: "platform",
    holabossUserIdRequired: true,
  },
]);
```

Also add a compatibility test for the current Gmail manifest shape:

```ts
assert.equal(result.integrations[0]?.provider, "google");
assert.equal(result.integrations[0]?.credentialSource, "platform");
```

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test runtime/api-server/src/workspace-runtime-plan.test.ts
node --import tsx --test runtime/api-server/src/app.test.ts
```

Expected:

- FAIL because `integrations` is not part of the resolved runtime model

**Step 3: Add shared integration types**

Create `runtime/api-server/src/integration-types.ts` with minimal shared types:

```ts
export interface ResolvedIntegrationRequirement {
  key: string;
  provider: string;
  capability: string | null;
  scopes: string[];
  required: boolean;
  credentialSource: "platform" | "manual" | "broker";
  holabossUserIdRequired: boolean;
}
```

Use this type in both runtime planning and installed app runtime parsing.

**Step 4: Implement parser support**

In `workspace-runtime-plan.ts` and `workspace-apps.ts`:

- parse `integrations:` if present
- map legacy `integration:` into a single `ResolvedIntegrationRequirement`
- keep `env_contract` parsing intact
- include `integrations` on the resolved app/runtime objects

Do not introduce provider-specific behavior in this task. This is only schema parsing.

**Step 5: Run tests to verify they pass**

Run:

```bash
node --import tsx --test runtime/api-server/src/workspace-runtime-plan.test.ts
node --import tsx --test runtime/api-server/src/app.test.ts
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add runtime/api-server/src/integration-types.ts runtime/api-server/src/workspace-runtime-plan.ts runtime/api-server/src/workspace-runtime-plan.test.ts runtime/api-server/src/workspace-apps.ts runtime/api-server/src/app.test.ts
git commit -m "feat: parse integration requirements from app manifests"
```

## Task 2: Persist Integration Connections And Bindings In The Runtime State Store

**Files:**
- Modify: `runtime/state-store/src/store.ts`
- Modify: `runtime/state-store/src/index.ts`
- Modify: `runtime/state-store/src/store.test.ts`

**Step 1: Write failing state-store tests**

Add tests for:

- create and list provider connections
- upsert workspace default binding
- upsert app-specific binding
- delete binding
- filter bindings by workspace

Target API shape:

```ts
store.upsertIntegrationConnection({
  connectionId: "conn-1",
  providerId: "google",
  ownerUserId: "user-1",
  accountLabel: "owner@holaboss.ai",
  authMode: "oauth_app",
  grantedScopes: ["gmail.send"],
  status: "active",
});

store.upsertIntegrationBinding({
  bindingId: "bind-1",
  workspaceId: "ws-1",
  targetType: "workspace",
  targetId: "default",
  integrationKey: "google",
  connectionId: "conn-1",
  isDefault: true,
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test runtime/state-store/src/store.test.ts
```

Expected:

- FAIL because integration connection and binding APIs do not exist

**Step 3: Add database schema and store methods**

Extend `store.ts` with tables and methods for:

- `integration_connections`
- `integration_bindings`

Keep schema minimal for Phase 1:

- ids
- provider
- owner user
- account label
- auth mode
- granted scopes
- status
- connection secret reference
- timestamps

Binding table should include:

- workspace id
- target type
- target id
- integration key
- connection id
- is default

Export the new types through `index.ts`.

**Step 4: Run tests to verify they pass**

Run:

```bash
node --import tsx --test runtime/state-store/src/store.test.ts
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add runtime/state-store/src/store.ts runtime/state-store/src/index.ts runtime/state-store/src/store.test.ts
git commit -m "feat: add integration connections and bindings to runtime state store"
```

## Task 3: Add Runtime Integration Service And API Routes

**Files:**
- Create: `runtime/api-server/src/integrations.ts`
- Create: `runtime/api-server/src/integrations.test.ts`
- Modify: `runtime/api-server/src/app.ts`
- Modify: `runtime/api-server/src/app.test.ts`

**Step 1: Write failing service and route tests**

Add route coverage for:

- `GET /api/v1/integrations/catalog`
- `GET /api/v1/integrations/connections`
- `GET /api/v1/integrations/bindings?workspace_id=...`
- `PUT /api/v1/integrations/bindings/:workspaceId/:targetType/:targetId/:integrationKey`
- `DELETE /api/v1/integrations/bindings/:bindingId`

Use a static Phase 1 catalog for:

- github
- google
- reddit
- twitter
- linkedin

Sample expected response:

```ts
assert.equal(response.json().providers[0]?.provider_id, "google");
assert.equal(response.json().bindings[0]?.workspace_id, "ws-1");
```

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test runtime/api-server/src/integrations.test.ts
node --import tsx --test runtime/api-server/src/app.test.ts
```

Expected:

- FAIL because service and routes do not exist

**Step 3: Implement the integration service**

Create `integrations.ts` with:

- static Phase 1 provider catalog
- helpers to list and mutate connections and bindings via the state store
- validation for `targetType` and required ids

Keep it deliberately simple. Do not implement OAuth in this task.

**Step 4: Register routes in `app.ts`**

Expose the routes above using the new service.

Requirements:

- route payloads should be JSON only
- errors should use existing API error conventions
- bindings must be workspace-scoped

**Step 5: Run tests to verify they pass**

Run:

```bash
node --import tsx --test runtime/api-server/src/integrations.test.ts
node --import tsx --test runtime/api-server/src/app.test.ts
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add runtime/api-server/src/integrations.ts runtime/api-server/src/integrations.test.ts runtime/api-server/src/app.ts runtime/api-server/src/app.test.ts
git commit -m "feat: add runtime integration catalog and binding routes"
```

## Task 4: Resolve Bindings During App Start And Inject Compatibility Env

**Files:**
- Modify: `runtime/api-server/src/app-lifecycle-worker.ts`
- Modify: `runtime/api-server/src/app-lifecycle-worker.test.ts`
- Modify: `runtime/api-server/src/app-setup-env.ts`
- Modify: `runtime/api-server/src/workspace-apps.ts`
- Create: `runtime/api-server/src/integration-runtime.ts`
- Create: `runtime/api-server/src/integration-runtime.test.ts`

**Step 1: Write failing runtime resolution tests**

Add tests for:

- resolving a workspace default binding for an app integration
- resolving an app-specific binding override
- injecting `HOLABOSS_INTEGRATION_BROKER_URL`
- injecting `HOLABOSS_APP_GRANT`
- injecting compatibility env values for current apps:
  - `PLATFORM_INTEGRATION_TOKEN`
  - `WORKSPACE_GOOGLE_INTEGRATION_ID`
  - `WORKSPACE_GITHUB_INTEGRATION_ID`

Use a fake token payload in test fixtures:

```ts
assert.equal(env.PLATFORM_INTEGRATION_TOKEN, "token-google-1");
assert.equal(env.WORKSPACE_GOOGLE_INTEGRATION_ID, "conn-google-1");
assert.equal(env.HOLABOSS_INTEGRATION_BROKER_URL, "http://127.0.0.1:8080/api/v1/integrations");
```

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test runtime/api-server/src/integration-runtime.test.ts
node --import tsx --test runtime/api-server/src/app-lifecycle-worker.test.ts
```

Expected:

- FAIL because no integration resolution step exists

**Step 3: Implement integration runtime resolution**

Create `integration-runtime.ts` with logic to:

- inspect `resolvedApp.integrations`
- load matching connection and binding records
- construct compatibility env output
- mint a stub Phase 1 app grant

Phase 1 can use a simple opaque grant like:

```ts
`grant:${workspaceId}:${appId}:${Date.now()}`
```

Do not build signed auth yet.

**Step 4: Wire env injection into app lifecycle**

In `app-lifecycle-worker.ts`:

- expand `buildShellLifecycleEnv`
- preserve existing `HOLABOSS_USER_ID`
- add integration-derived env values when the app declares a matching integration

In `app-setup-env.ts`:

- add helper functions if needed to write a future-compatible integration file path
- keep the implementation minimal and compatibility-focused

**Step 5: Run tests to verify they pass**

Run:

```bash
node --import tsx --test runtime/api-server/src/integration-runtime.test.ts
node --import tsx --test runtime/api-server/src/app-lifecycle-worker.test.ts
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add runtime/api-server/src/integration-runtime.ts runtime/api-server/src/integration-runtime.test.ts runtime/api-server/src/app-lifecycle-worker.ts runtime/api-server/src/app-lifecycle-worker.test.ts runtime/api-server/src/app-setup-env.ts runtime/api-server/src/workspace-apps.ts
git commit -m "feat: resolve integration bindings during app lifecycle start"
```

## Task 5: Add Desktop Integrations Management Surface

**Files:**
- Create: `desktop/src/components/panes/IntegrationsPane.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/components/layout/LeftNavigationRail.tsx`
- Modify: `desktop/src/lib/workspaceDesktop.tsx`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`

**Step 1: Write failing desktop integration-state plumbing tests or type assertions**

If the desktop surface has no formal tests, add at least compile-time coverage by extending the Electron payload types and verifying the pane consumes:

- provider catalog
- connection list
- workspace bindings

If a lightweight component test path exists, use it. Otherwise use type-safe wiring plus app build verification.

Expected data contract:

```ts
type IntegrationCatalogProvider = {
  provider_id: string;
  display_name: string;
  auth_modes: string[];
  state: "not_connected" | "connected" | "needs_setup" | "needs_reauth";
};
```

**Step 2: Implement runtime IPC plumbing**

In `desktop/electron/main.ts` and `preload.ts`, add methods for:

- list integration catalog
- list connections
- list bindings for selected workspace
- save binding
- delete binding

Expose them in `desktop/src/types/electron.d.ts`.

**Step 3: Add the Integrations pane**

Create `IntegrationsPane.tsx` with three MVP sections:

- Discover
- Connected
- Workspace Bindings

Requirements:

- searchable provider list
- state badges
- binding chooser UI
- clear empty states for OSS setup

Do not build the full Developer tab in this task. Use a small placeholder link or section.

**Step 4: Add navigation entry**

Update:

- `App.tsx`
- `LeftNavigationRail.tsx`
- `workspaceDesktop.tsx`

so `Integrations` becomes a top-level destination alongside existing panes.

**Step 5: Verify desktop build**

Run:

```bash
npm --prefix desktop run typecheck
npm --prefix desktop run build
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add desktop/src/components/panes/IntegrationsPane.tsx desktop/src/App.tsx desktop/src/components/layout/LeftNavigationRail.tsx desktop/src/lib/workspaceDesktop.tsx desktop/electron/main.ts desktop/electron/preload.ts desktop/src/types/electron.d.ts
git commit -m "feat: add desktop integrations management surface"
```

## Task 6: Improve Tool Error Visibility And Preflight Integration Readiness

**Files:**
- Modify: `runtime/harness-host/src/opencode.ts`
- Modify: `runtime/harness-host/src/opencode.test.ts`
- Modify: `desktop/src/components/panes/ChatPane.tsx`
- Modify: `runtime/api-server/src/integrations.ts`
- Modify: `runtime/api-server/src/integration-runtime.ts`

**Step 1: Write failing tests for readiness and error mapping**

Add tests proving:

- missing binding resolves to a typed runtime error such as `integration_not_bound`
- tool result errors surface a short actionable message
- desktop trace status shows error state, not completed state

Some of the tool status mapping work is already present. Extend tests to cover typed integration errors and short summaries.

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test runtime/harness-host/src/opencode.test.ts
npm --prefix desktop run typecheck
```

Expected:

- FAIL or incomplete behavior because typed integration readiness messages do not exist yet

**Step 3: Add integration preflight checks**

Before app-backed tool execution or when constructing app readiness state:

- detect missing connection or binding
- return typed integration readiness state
- map that to a user-facing summary such as:
  - `Gmail is not connected for this workspace`
  - `GitHub account needs re-authentication`

In `ChatPane.tsx`, ensure the UI uses the error summary rather than raw opaque payload text where possible.

**Step 4: Run tests and sanity verification**

Run:

```bash
node --import tsx --test runtime/harness-host/src/opencode.test.ts
npm --prefix desktop run typecheck
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add runtime/harness-host/src/opencode.ts runtime/harness-host/src/opencode.test.ts desktop/src/components/panes/ChatPane.tsx runtime/api-server/src/integrations.ts runtime/api-server/src/integration-runtime.ts
git commit -m "fix: surface actionable integration readiness and tool auth errors"
```

## Final Verification

Run the full targeted verification set before calling Phase 1 complete:

```bash
node --import tsx --test runtime/state-store/src/store.test.ts
node --import tsx --test runtime/api-server/src/workspace-runtime-plan.test.ts
node --import tsx --test runtime/api-server/src/app.test.ts
node --import tsx --test runtime/api-server/src/integrations.test.ts
node --import tsx --test runtime/api-server/src/integration-runtime.test.ts
node --import tsx --test runtime/api-server/src/app-lifecycle-worker.test.ts
node --import tsx --test runtime/harness-host/src/opencode.test.ts
npm --prefix desktop run typecheck
```

Expected:

- all tests pass
- desktop typecheck passes
- Integrations pane can list providers, connections, and bindings
- app lifecycle env injection provides compatibility values to Gmail/GitHub-style modules

## Notes For Execution

- Keep Phase 1 compatibility-focused. Do not build full provider proxy execution yet.
- Avoid adding provider-specific logic in more than one place. Centralize mapping in `integration-runtime.ts` or `integrations.ts`.
- Do not remove `PLATFORM_INTEGRATION_TOKEN` in this phase.
- Prefer additive changes and migration shims over broad rewrites.

Plan complete and saved to `docs/plans/2026-03-30-integrations-phase-1-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
