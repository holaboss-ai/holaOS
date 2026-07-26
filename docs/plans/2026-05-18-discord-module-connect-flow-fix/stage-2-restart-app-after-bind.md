# Stage 2 — Restart the workspace app after a binding change (Bug 3)

> Symptom: user clicks Connect Discord, OAuth succeeds, the Composio
> connection is finalized and the workspace-app binding is upserted — but
> the running Discord app still answers as if no integration is configured.
> The agent has to be told to restart the app, or the user has to do it
> manually.

## Root cause

The runtime bridge transport
(`experiments/app-builder-sdk/src/bridge-transports/runtime-broker.ts` and
the equivalent in `@holaboss/bridge`) reads `HOLABOSS_APP_GRANT` from
`process.env` once at module import. The grant carries `(workspace, app)`
identity, which the integration-broker uses on every provider call to look
up the bound connection.

When a new binding is created **after** the app has started:

1. The runtime writes the new binding to `runtime.db` correctly.
2. The integration-broker can resolve the binding on subsequent calls.
3. **But** the bridge in the running app process still carries either a
   stale grant or no grant — env is captured at boot, not refreshed.

The desktop already calls `composioFinalize` (writes the connection) and
`upsertIntegrationBinding` (writes the workspace-app binding) in
`IntegrationConnectCard.handleConnect` / `handleBind`. What was missing
was a process-level restart of the app so `integration-runtime.ts` can
re-inject `HOLABOSS_APP_GRANT` at the next boot.

The runtime already exposes the right endpoint
(`POST /api/v1/capabilities/runtime-tools/workspace-apps/:appId/restart` —
backed by `RuntimeAgentToolsService.restartWorkspaceApp`), but no desktop
IPC surfaced it to the renderer.

## Fix

End-to-end wiring of a new `restartApp` IPC, then call it from the bind
flow.

### 1. Runtime → main process

**`electron/main.ts`** — new `restartWorkspaceApp(workspaceId, appId)` thin
wrapper around `requestWorkspaceRuntimeJson` posting to the
`workspace-apps/:appId/restart` capability endpoint.

### 2. IPC registration

**`electron/main.ts`** — `handleTrustedIpc("workspace:restartApp", ...)`
next to the other binding handlers.

### 3. Preload bridge

**`electron/preload.ts`** — expose
`window.electronAPI.workspace.restartApp(workspaceId, appId)`.

### 4. Renderer type definition

**`src/types/electron.d.ts`** — add the method signature to the
`workspace` IPC surface.

### 5. Renderer consumer

**`src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx`**
— extract a `rebootAppAfterBindChange` helper; call it in both
`handleConnect` (after a fresh OAuth-driven bind) and `handleBind` (after
the user switches/binds an existing connection).

The restart is fire-and-forget: a thrown error is swallowed because the
bind itself succeeded, and a manual restart later will recover the same
end state. The next agent call against the app will surface the actual
error if anything broker-side is still wrong.

## Files changed

- `desktop/electron/main.ts` (new helper + IPC handler)
- `desktop/electron/preload.ts` (bridge entry)
- `desktop/src/types/electron.d.ts` (type)
- `desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx`
  (consumer)

## Verification

1. Rebuild desktop:
   ```bash
   cd holaOS
   npm run desktop:install
   npm run desktop:dev
   ```
2. Create a fresh Discord module (Stage 1 must already be deployed —
   otherwise the Connect card may not appear at all).
3. Click Connect Discord, complete the OAuth flow in the popped browser.
4. After the card transitions to the "Bound to discordbot-module" state,
   immediately ask the agent to call a Discord tool (e.g. list guilds).
5. The tool MUST work on the first call — no manual restart, no
   "integration not bound" error.
6. Repeat with switching accounts (drop-down "Switch to account 2") to
   confirm `handleBind` also triggers the restart.

## Out of scope (handled separately)

- Bug 1 (Stage 1): Connect button not appearing — Stage 2 only matters if
  the card renders in the first place.
- Bug 2 (Stage 3): Hono `/api/composio/connect` first-time failures — the
  user has to be able to complete OAuth for Stage 2 to ever exercise.
- Future optimization: drop the restart in favor of an in-process env
  refresh hook on the bridge transport, so Discord doesn't lose a few
  seconds of uptime per bind. Not worth the complexity until restart
  proves user-visible.
