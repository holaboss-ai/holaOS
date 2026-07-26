# Stage 7 — Shared bind state hook + drop `APP_CATALOG`

> Stage 6 left two "intentionally NOT done" loose ends. Both turn into
> production gaps if left in place. This stage closes them.

## Two cleanups, one stage

### Cleanup A — drop the hardcoded `APP_CATALOG`

`desktop/src/lib/workspaceApps.ts` shipped a `Record<string, ...>` with
seven baked-in apps (Gmail, Twitter, LinkedIn, Reddit, Sheets, GitHub,
Cal.com) carrying `{label, summary, accentClassName}`. New apps the
agent builds (Discord, Notion, Stripe, …) fell through to a
`labelFromAppId(appId)` fallback that turned `discord-sdk` into "Discord
Sdk" and applied a generic emerald accent. Same architectural smell as
`PROVIDER_TO_TOOLKIT` (Stage 3) and `PROVIDER_WHOAMI` (Stage 4) — a
hardcoded provider/app registry that ages every time the agent adds a
new module.

The source of truth is the app's own `app.runtime.yaml` `name:` field
(and `slug:`). The runtime already parses it; it just wasn't surfaced.

Fix:

- `/api/v1/apps` now reads the yaml and returns the `name` field per
  entry (already includes `integrations[]` from Stage 6).
- `InstalledWorkspaceAppPayload` gains `name?: string | null` (electron
  ambient types).
- `hydrateInstalledWorkspaceApps` uses `app.name` first; falls back to
  `labelFromAppId(app_id)` for any yaml that omits `name:`.
- `APP_CATALOG`, `workspaceAppCatalogEntry`, the `summary` field, and
  the `accentClassName` field are deleted entirely. The accent was
  unused outside one test assertion; summary was used as a tooltip
  fallback that now uses the label.

Net: any agent-built app shows its real display name on the App Surface
title bar and sidebar without any desktop code change. Zero per-app
registry.

### Cleanup B — extract `useIntegrationBinding` hook

`IntegrationConnectCard` (chat-side, transient) and `AppSurfacePane`
(per-app, persistent) shipped two parallel implementations of the same
state machine:

```
loading / no_workspace / no_connection / needs_binding / bound
+ connect (OAuth → finalize → bind → restart)
+ bind (upsert binding → restart)
+ refresh
```

Two copies meant any production fix (Stage 2's restart-after-bind,
Stage 4's whoami passthrough) had to be applied twice — and one was
quietly out of sync (AppSurfacePane only added `restartApp` after
Stage 6 explicitly wired it).

New shared hook at `desktop/src/lib/useIntegrationBinding.ts`:

```ts
useIntegrationBinding({
  appId,
  provider,                          // Composio toolkit slug
  whoami?,                           // optional, Stage 4 descriptor
  onAfterBind?,
  considerWorkspaceDefault?,         // App Surface = true, chat card = false
}): {
  state: IntegrationBindingState,    // 5-kind union
  busy: "connecting" | "binding" | null,
  errorMessage: string,
  refresh, connect, bind,
}
```

- `connect()` fans out to `connectIntegrationProvider({ provider, appId,
  whoami })`, then `upsertIntegrationBinding` with the freshly issued
  `connection_id` (no list-and-pick race), then `restartApp`, then
  `refresh`.
- `bind(connectionId)` upserts + restarts + refreshes.
- `considerWorkspaceDefault: true` makes a `workspace/default/<provider>`
  binding count as "bound" too — the App Surface wants this so a
  workspace-level gmail connection presents as bound for every
  gmail-shaped app; the chat card wants the opposite (force an explicit
  app-level bind on a brand-new install).

Both consumers now render their own layout against the same hook
output:

- `IntegrationConnectCard`: ~155 lines (was ~225). All `useState` /
  `useCallback` plumbing for state/refresh/handleConnect/handleBind
  gone.
- `AppSurfacePane`: integrationContext + checkIntegration +
  handleSelectBinding + handleConnectAccount + rebootAppAfterBindChange
  collapsed into a single hook call. Window-focus-refetch effect now
  drives `refreshBinding` instead of a per-pane fetcher. Two dead
  `connectionPrimary` / `connectionSecondary` helpers and the unused
  `connectIntegrationProvider` destructure dropped.

## Files changed

Runtime (`holaOS/runtime/api-server/src/`):

- `app.ts` — `/api/v1/apps` reads yaml `name` per entry, returns it
  alongside `integrations[]`.

Desktop (`holaOS/desktop/`):

- `src/types/electron.d.ts` — `InstalledWorkspaceAppPayload.name?`.
- `src/lib/workspaceApps.ts` — `APP_CATALOG` /
  `workspaceAppCatalogEntry` / `summary` / `accentClassName` removed;
  `WorkspaceAppDefinition` is now just `{id, label}`;
  `hydrateInstalledWorkspaceApps` uses yaml `name`.
- `src/lib/useIntegrationBinding.ts` — new shared hook.
- `src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx` —
  hook consumer, render unchanged.
- `src/components/panes/AppSurfacePane.tsx` — hook consumer; provider
  resolved from yaml `integrations[]` only; render references
  renamed (`integrationContext.providerName` → `bindingProviderName`,
  etc.).
- `src/components/panes/SpaceApplicationsExplorerPane.tsx` — drops
  the removed `summary` field from the tooltip.
- `src/components/panes/appSurfacePresentation.test.mjs` — old test
  asserted on the removed `workspaceAppCatalogEntry`; replaced with
  one that exercises the new yaml-name resolution.

## Verification

1. Build / restart:
   ```bash
   cd holaOS
   npm run desktop:prepare-runtime:local
   npm run desktop:dev
   ```
2. Agent builds any new toolkit-backed app (Discord, Notion, Stripe,
   anything with a yaml `name:` + `integrations[].provider`):
   - Sidebar shows the yaml's `name` verbatim (e.g. "Discord (SDK)"),
     not a title-cased id.
   - App Surface header renders Connect / Bind / Switch controls keyed
     on the yaml-declared toolkit slug.
3. Pre-existing apps (Gmail, GitHub) still show their canonical names
   because their yamls already carry `name: "Gmail"` etc.
4. Chat Connect card and App Surface bind dropdown now share runtime
   behavior: a switch in either rebinds + auto-restarts the running
   app and the other view reflects the change on next focus.

## Cross-stage typecheck

`bunx tsc --noEmit` clean for `holaOS/desktop`, `holaOS/runtime/api-server`,
and `holaOS/experiments/app-builder-sdk`. Runtime test suite: 100/100
relevant integration tests pass (`integration-types`,
`runtime-agent-tools`, `claimed-input-executor`,
`workspace-runtime-plan`).

The `appSurfacePresentation.test.mjs` file fails to import via `node
--import tsx --test` on Node 24 — this is a **pre-existing**
loader/extension issue at HEAD (verified by running against
`git stash`), not introduced by this stage.
