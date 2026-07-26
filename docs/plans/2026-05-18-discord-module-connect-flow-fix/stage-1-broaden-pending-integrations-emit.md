# Stage 1 — Broaden `pending_integrations` emit (Bug 1)

> Symptom: desktop agent creates a new Discord module, but no Connect button
> appears in the conversation. User has to open the Integrations pane manually
> to authorize the toolkit.

## Root cause

`pending_integrations` is the payload the runtime emits in a tool result so
the chat UI can render an inline Connect card next to the assistant message.

Two layers were both involved:

1. `pendingIntegrationsFromAppManifests` (runtime-agent-tools.ts) reads each
   app's `app.runtime.yaml`, parses `integrations[]` (and the legacy
   `integration` singular via `integration-types.ts:88` fallback), and emits
   one entry per `required: true` integration. **This part already works
   correctly for Discord** — `integration: { destination: "discordbot" }`
   resolves to `provider: "discordbot"`.
2. `claimed-input-executor.ts:3266` `PENDING_INTEGRATION_EMITTING_TOOLS` only
   scanned the output of four tools:
   - `workspace_apps_install`
   - `workspace_apps_ensure_running`
   - `workspace_apps_restart`
   - `workspace_apps_restart_and_wait_ready`

If the desktop agent ended its build flow on any other tool —
`workspace_apps_scaffold`, `_register`, `_build`, `_wait_until_ready`, or
`_get_status` — the chat UI never saw `pending_integrations` and the Connect
card was never rendered. The SKILL.md instructs the agent to end on
`ensure_running`, but in practice the LLM does not always follow that path.

## Fix

Two changes, both in `holaOS/runtime/api-server/src/`:

1. **`claimed-input-executor.ts:3266`** — extend the emitting set with five
   completion-type tools:
   ```ts
   "workspace_apps_scaffold",
   "workspace_apps_register",
   "workspace_apps_build",
   "workspace_apps_wait_until_ready",
   "workspace_apps_get_status",
   ```

2. **`runtime-agent-tools.ts`** — introduce a private helper
   `pendingIntegrationsForApps(workspaceId, appIds)` and call it at the tail
   of every completion-type tool method so the JSON result carries
   `pending_integrations: [...]` whenever a registered app has at least one
   `required: true` integration:
   - `scaffoldWorkspaceApp`
   - `registerWorkspaceApp`
   - `buildWorkspaceApp` (both `skipped` and normal paths)
   - `getWorkspaceAppStatus` (single-app + all-apps variants)
   - `restartWorkspaceApp`
   - `waitUntilWorkspaceAppReady` (both ready and timed-out paths)

The card UI already de-dupes by `(provider_id, app_id)`, so emitting the same
entry from multiple successive tools is harmless — only the most recent
assistant turn renders the card.

## Files changed

- `runtime/api-server/src/claimed-input-executor.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`

## Verification

1. Rebuild runtime + redeploy bundled `.pyc` into desktop:
   ```bash
   cd holaOS
   npm run desktop:prepare-runtime:local
   ```
2. Restart the desktop app.
3. Ask the agent to create a Discord module from scratch.
4. After the agent reports the app is ready, a Connect Discord card MUST
   appear inline in the chat. This should hold regardless of which tool the
   agent invoked last.

## Out of scope (handled in later stages)

- The Hono `/api/composio/connect` first-time failure (Stage 3 — Bug 2).
- Running Discord app not picking up the new grant after authorization
  (Stage 2 — Bug 3).
