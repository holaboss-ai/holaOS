# Stage 6 — In-app "Bind integration" button

> User feedback: the chat Connect card only emits once. To rebind, switch
> accounts, or recover from "I dismissed the card before clicking", users
> have to leave the conversation and go through the workspace-wide
> Integrations pane. They want a per-app bind button right on the App
> Surface.

## What was already there

`AppSurfacePane.tsx` had partial wiring for a per-app bind UI:

- `integrationContext` state tracking `(providerId, candidates,
  currentBindingId, currentConnectionId)`.
- `handleSelectBinding` calling `upsertIntegrationBinding` from the
  account-picker dropdown.
- A `handleConnectAccount` button that — and this is the punchline —
  **just opened the Settings → Integrations pane**, so the "in-app
  bind" UX was a redirect, not a bind.

Plus a hardcoded `knownProviders` map (`gmail: "gmail", sheets:
"googlesheets", calcom: "cal", …`) that resolved `appId → provider_id`
when no app-level binding existed yet, so it could render the
"Connect …" button. **For any app the agent builds outside this
12-entry list (Discord, Notion, Stripe, …) the map returned undefined →
`integrationContext` was set to null → the button never rendered.**
This is the same architectural smell Stage 3 killed for
`PROVIDER_TO_TOOLKIT` in Hono.

## Fix

### Source of truth: app.runtime.yaml

`/api/v1/apps` now returns each installed app's `integrations[]` block
parsed from its `app.runtime.yaml` (via the existing
`resolveWorkspaceAppRuntime`):

```json
{
  "app_id": "discord-sdk",
  "integrations": [{
    "key": "primary_discord",
    "provider": "discordbot",
    "capability": null,
    "required": true,
    "whoami": { ... }   // optional, Stage 4 descriptor
  }]
}
```

This is the same shape `pending_integrations` uses elsewhere in the
chat flow, so the App Surface can reuse the Stage 4 whoami passthrough.

### Provider resolution drops the hardcoded map

`AppSurfacePane.checkIntegration` now resolves the provider in this order:

1. **Existing app-level binding** — `bindings.find(b => b.target_type === "app" && b.target_id === appId).integration_key`
2. **YAML declaration** — `installedApp.integrations.find(i => i.required)?.provider`
3. **None** — leave `integrationContext: null` (the app declares no required integration; no button rendered).

The `knownProviders` map is gone entirely. New apps the agent builds
get a working Connect button the moment they declare `integrations:` in
their yaml, with zero desktop code change.

### handleConnectAccount runs the full flow inline

Replaces the "open settings" stub with:

```
connectIntegrationProvider({ provider, appId, whoami })   // Stage 4 path
  → window.electronAPI.workspace.upsertIntegrationBinding(...)
  → window.electronAPI.workspace.restartApp(...)          // Stage 2 path
  → checkIntegration()                                    // re-render UI
```

`whoami` is read from the installed app's `integrations[]` so the
profile fetch finds handle/email/avatar without a Hono-side constant.

`handleSelectBinding` (the dropdown-switch case) also calls
`restartApp` now, matching `IntegrationConnectCard.handleBind`'s Stage 2
behavior. Previously switching accounts left the running app with the
old grant captured at module init.

## Files changed

Runtime:

- `holaOS/runtime/api-server/src/app.ts` — `/api/v1/apps` now includes
  `integrations[]` (with optional `whoami`) per app, parsed from yaml.

Desktop:

- `holaOS/desktop/src/types/electron.d.ts` —
  `InstalledWorkspaceAppIntegrationRequirement` interface;
  `InstalledWorkspaceAppPayload` gains optional `integrations?`.
- `holaOS/desktop/src/lib/workspaceApps.ts` —
  `WorkspaceInstalledAppDefinition` carries `integrations`;
  `hydrateInstalledWorkspaceApps` plumbs them through.
- `holaOS/desktop/src/components/panes/AppSurfacePane.tsx` —
  `knownProviders` map deleted; provider resolved from yaml-declared
  integrations; `handleConnectAccount` runs full OAuth+bind+restart
  inline; `handleSelectBinding` also restarts.

## Verification

1. Rebuild runtime + restart desktop:
   ```
   cd holaOS && npm run desktop:prepare-runtime:local && npm run desktop:dev
   ```
2. From the App Surface for the Discord module (with Stage 5's
   `discordbot` toolkit slug already in yaml):
   - If currently unbound: the "Connect discordbot" button appears at
     the top of the surface. Click → OAuth pop-up → guild pick →
     bot installs → button transitions to bound state showing the
     newly resolved identity.
   - If already bound: dropdown shows current account; "Switch to <other>"
     and "Add another account" entries work without leaving the surface.
3. Verify other apps the agent builds (e.g. Notion) get the same
   treatment with zero desktop code change — only their yaml's
   `integrations[].provider` matters.

## Out of scope (intentionally NOT done)

- Removing the `APP_CATALOG` map at `workspaceApps.ts:15-58` —
  that one is for display labels/colors of installed apps, not for
  provider resolution. Less harmful (falls back to title-cased appId
  for unknowns), but eventually should move to per-yaml display metadata
  the same way whoami did.
- Moving the chat-side Connect card to share rendering with the App
  Surface bind UI — they have different layouts and different state
  shapes (chat card is per-conversation-event, App Surface bind is
  per-app-permanent). A shared "useIntegrationBinding(appId, provider)"
  hook would be the right refactor but is its own follow-up.
