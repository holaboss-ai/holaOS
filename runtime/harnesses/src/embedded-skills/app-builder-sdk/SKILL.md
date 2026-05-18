---
name: app-builder-sdk
description: Build a new headless holaOS app module using @holaboss/app-builder-sdk (5 primitives, MCP-only, no web UI). Prefer this over the legacy app-builder skill when the request is "add a new integration / provider module" rather than "build a dashboard or UI app."
---

# App Builder (SDK)

Use this skill when the user wants a **new provider integration module** — Discord, Notion, Asana, Stripe, Linear, anything that maps to "talk to one external service via MCP tools." For dashboard/UI/analytics apps, fall back to the legacy `app-builder` skill instead.

A module built with this SDK is **headless**: an MCP server + a tiny HTTP stub. No TanStack Start, no web UI to design. The agent (in the user's desktop) drives it via MCP tool calls.

## When NOT to use this skill

- The user asked for a **UI** (dashboard, table view, chart, table editor) → use `app-builder` skill instead. SDK apps don't ship UI.
- The request is for **shared data ingestion / cron tasks** without an external provider → legacy `app-builder` skill is still the right tool.
- The user already has a working hola-boss-apps module and wants to extend it → modify it in place; don't rewrite as SDK.

## The 5 primitives

Every SDK app composes exactly these:

```ts
app.connection()             // declares "this app needs an integration binding"
app.resource(name, {...})    // declares a row type (status machine, schema, emit rules)
app.action(resource, name, { fromStates, toState, run, [reversible], [steps], [schema] })
app.sync(name, { schedule, attachTo, fetch, upsert, normalize })
app.start()                  // validate config; no scheduling — automations layer does that
```

Mental model:
- `resource` = a row in the app's SQLite (e.g. `message`, `event`, `issue`, `pin`)
- `action` = state transition + upstream API call (e.g. `send_message: draft → sent`)
- `sync` = periodic upstream read that upserts records keyed by external id
- HOW (steps / states / reversal) lives in the SDK. WHEN (scheduling, retry) lives in Holaboss automations — **the SDK never schedules**.

Full type contract: `experiments/app-builder-sdk/src/types.ts`. Public exports: `experiments/app-builder-sdk/src/index.ts`.

### `provider.id` vs `composioToolkit` — DO NOT CONFUSE

`ProviderRegistry` has two id-like fields and getting them wrong is the most common cause of `integration_not_bound` 404s at the broker.

- `id`: must match `integration_connections.provider_id` (what desktop OAuth writes when the user connects the provider). Also the lookup key that `createRuntimeBrokerTransport({ provider })` and `upsertBinding(integration_key)` use. Sample values: `"slack"`, `"discord"`, `"github"`, `"gmail"`, `"linkedin"`. Singular noun, the way the provider markets itself.
- `composioToolkit`: Composio's internal toolkit slug, used by Composio to pick the right API client. Sometimes equal to `id` (Slack), sometimes not (Discord's bot toolkit is `"discordbot"`; Google Calendar is `"googlecalendar"`; LinkedIn is `"linkedin"` for OAuth and there may be variants).

Mistake pattern: agent picks the Composio toolkit slug as `provider.id` because that's what they found in Composio's docs. Result: `broker_proxy → integration_not_bound: no <slug> binding for workspace` because the OAuth flow registered the connection under a different `provider_id` and the binding integration_key is set from that.

Discovery rule: check the existing OAuth provider id BEFORE writing the provider file:

```
sqlite3 ~/.holaboss-desktop/sandbox-host/state/control-plane.db \
  "SELECT DISTINCT provider_id FROM integration_connections;"
```

Use the value from the existing schema. If the user has never connected this provider before, default `provider.id` to the way Composio's connect URL spells it (matches what the desktop OAuth handler will store).

## Pick a reference shape

Copy the closest reference dir as your template; don't write from scratch. All references are at `experiments/app-builder-sdk/reference/<shape>/`.

| Shape | Reference | Use when the request looks like |
|---|---|---|
| **messaging** | `slack-messaging/` | Send / edit / delete / react on a message; chat-like provider (Discord, Telegram, IRC, SMS). Has custom state alphabet + side-effect actions + reversible scheduled send. **Also the only reference with full `server.ts` + `app.runtime.yaml`** — copy those two files verbatim into any new module regardless of shape. |
| **publishing** | `pinterest-publishing/` | Multi-step upload-then-publish + reversible cancel; idempotency via `row.external_id` short-circuit. Use for any "create draft → confirm → publish → can be deleted" flow (image / video / blog posts). |
| **workflow** | `github-workflow/` | Multi-state lifecycle (`draft / open / in_progress / closed / reopened / failed`), reversible close↔reopen, side-effect actions (`comment`, `assign`) that don't change row.status. CRM leads / issue trackers / ticketing systems. |
| **event-with-time** | `gcalendar-events/` | Resources carry their own `start_time/end_time` (intrinsic, not "schedule this action later"); RSVP as side-effect; recurring (RRULE). Use for calendar / booking / appointment modules. |
| (already-built dogfood) | `telegram-messaging/` | First app a cold subagent built using only this skill + the SDK. Integer external IDs (`message_id` is int — stringify on persist). Read its inline notes if your provider also has integer IDs. |

Always read the `app.ts` of the chosen reference end-to-end before writing your own. Each one's top-of-file banner notes the shape it demonstrates and provider-specific quirks the agent who wrote it found.

## File layout per module

A complete SDK app is **4 files**, all under `<workspace>/apps/<app_id>/`:

```
<workspace>/apps/<app_id>/
├── app.ts              # buildXApp(options) — connection / resource / action / sync declarations
├── provider.ts         # ProviderRegistry: id, baseUrl, allowedHosts, whoamiPath, composioToolkit
├── server.ts           # production entry: SqliteStateBackend + runtime-broker + startMcpServer
├── app.runtime.yaml    # manifest (lifecycle, healthchecks, mcp.tools list, env_contract, integration)
└── package.json        # only declares: @holaboss/app-builder-sdk via `file:` dep
```

There is **no** Vite config, no TanStack Start, no `_template/` to fork, no `.output/`, no React. The web UI surface that the desktop iframe expects is auto-served as a one-screen "headless module" placeholder by `startMcpServer({ httpPort })` — no work needed from the app author.

Copy `reference/slack-messaging/{server.ts,app.runtime.yaml}` and adapt the constants. Copy `reference/<your-shape>/{app.ts,provider.ts}` and adapt the resource/action declarations.

## Install protocol

After writing the 4 files into `<workspace>/apps/<app_id>/`, do these in order. Do not skip steps:

### 1. `package.json` — use a `file:` dep, absolute path

```json
{
  "name": "<app_id>-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@holaboss/app-builder-sdk": "file:/absolute/path/to/holaOS/experiments/app-builder-sdk"
  }
}
```

Why absolute, not relative: the path is per-machine, so the agent must read `$HOME` or the repo root from a known constant (the runtime exposes the workspace root) and write the absolute string. Relative paths break across worktrees.

### 2. `bun install` once in the app dir

```
cd <workspace>/apps/<app_id> && bun install
```

If the user's runtime injects `WORKSPACE_DB_PATH`, `HOLABOSS_APP_GRANT`, `HOLABOSS_INTEGRATION_BROKER_URL`, `MCP_PORT`, `PORT` (it does — see runtime's `app-lifecycle-worker.ts`), the production entry in `server.ts` runs as-is. Don't try to set these yourself.

### 3. `app.runtime.yaml` — declare env contract + mcp tools

Required env contract for any SDK app:

```yaml
env_contract:
  - "HOLABOSS_WORKSPACE_ID"
  - "WORKSPACE_DB_PATH"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
  - "MCP_PORT"
```

`mcp.tools` list must match what `app.derivedTools()` returns. The derivation rules from `experiments/app-builder-sdk/src/app.ts:165-238` are:
- `<app_id>_connection_status` — always
- For each resource: `<app_id>_list_<plural>`, `<app_id>_get_<resource>`, and (if `refreshEvery + fetch` declared) `<app_id>_refresh_<plural>`
- For each action: `<app_id>_<action_name>_<resource_name>` (or `def.toolName` override), plus `<app_id>_cancel_<action>_<resource>` for reversible
- For each sync: `<app_id>_<sync_name>_sync_status`
- `<app_id>_snapshot` — always

If you're not sure, write the app, `bun run server.ts` once locally, and read the "Tools registered: N" log line.

### 4. `integration` block in app.runtime.yaml

```yaml
integration:
  destination: "<provider_id>"     # matches ProviderRegistry.id
  credential_source: "platform"     # always; uses Composio via runtime broker
```

### 5. Register in `workspace.yaml`

Three places to add. They're separate top-level sections; don't reorder existing entries.

```yaml
mcp_registry:
  allowlist:
    tool_ids:
      - <app_id>.<tool_name>     # add one line per tool from app.runtime.yaml mcp.tools
      # ...
  servers:
    <app_id>:
      type: remote
      url: http://localhost:<MCP_PORT>/mcp/sse
      enabled: true
      timeout_ms: 30000
applications:
  - app_id: <app_id>
    config_path: apps/<app_id>/app.runtime.yaml
    lifecycle:
      setup: bun install
      start: >-
        MCP_PORT=<port> nohup bun run server.ts > /tmp/<app_id>-module.log 2>&1 &
      stop: kill $(lsof -t -i :<port> 2>/dev/null) 2>/dev/null || true
```

The MCP port and HTTP port are allocated by the runtime per app (`workspace-apps.ts:122`). For dogfood you can hard-code free ports in the high 38000s.

### 6. Bind the integration connection (current known gap)

**The runtime does not auto-bind an existing provider connection to a freshly-installed app.** Until that gap is closed, after installing the app you must:

```
curl -X PUT 'http://127.0.0.1:40531/api/v1/integrations/bindings/<workspace_id>/app/<app_id>/<provider_id>' \
  -H 'Content-Type: application/json' \
  -d '{"connection_id":"<existing_connection_id>"}'
```

Get `<existing_connection_id>` from the runtime DB:

```
sqlite3 ~/.holaboss-desktop/sandbox-host/state/control-plane.db \
  "SELECT connection_id, account_handle FROM integration_connections WHERE provider_id='<provider>' AND status='active';"
```

If no row → user has not connected this provider yet; tell them to use the desktop integrations panel before continuing. Don't try to mint a Composio connection from the agent — that's an OAuth flow that requires user consent in the desktop UI.

The PUT triggers `refreshAppsForIntegrationBinding` which restarts the app process, so the new env propagates within a few seconds.

## Verification checklist

Run all of these. Stop at the first failure and report the symptom verbatim, don't paper over it.

1. `cd <workspace>/apps/<app_id> && bun install` → exit 0, lockfile written
2. `MCP_PORT=<port> WORKSPACE_DB_PATH=/tmp/<app_id>.db HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:40531/api/v1/integrations HOLABOSS_APP_GRANT=fake bun run server.ts &` → "MCP server listening on :<port>" and "Tools registered: N" in stdout
3. `curl http://localhost:<port>/mcp/health` → `{"status":"ok","app_id":"<app_id>"}`
4. (After registering in workspace.yaml + restarting desktop or hitting the binding refresh API) the app appears in the desktop integrations pane
5. After the manual PUT binding step, agent calls `<app_id>_connection_status` → returns `{connected: true, identity: {...}}` if `provider.whoamiPath` is set, else `{connected: null, reason: "no_probe_defined"}`. Anything else (`{connected: false, reason: ...}`) means the binding or the upstream is broken — read the `message` field, fix root cause, don't retry blindly.
6. Agent calls one real action tool end-to-end (e.g. `discord_send_message_message`). Must return `{ok: true, externalId: "..."}` and the provider must show the action in its UI (the user can verify).

## Known gaps and quirks

These are real, current, will bite the agent. Don't try to "fix" them inside the app code — they live in the runtime / desktop and are tracked separately.

- **Binding not auto-created on install.** See step 6 above. Manual PUT for now.
- **Cookie format quirk fix lives in runtime/api-server/src/composio-service.ts.** If you see `Composio proxy via Hono failed: 500 Internal Server Error`, the runtime build is stale — rebuild via `npm run desktop:prepare-runtime:local` and restart desktop.
- **Hono `/api/composio/proxy` had a body-double-read bug** (now fixed in `frontend/apps/server/src/api/composio.ts`). If the staging Hono hasn't been redeployed since this fix, the same 500 shows up. Don't recurse into "is my SDK call wrong" — verify staging is up to date first.
- **Provider HTTP method matters.** Slack / Telegram bot API need POST for read endpoints too. Pinterest / GitHub / Google use GET. Read the reference closest to your provider; don't default to GET.
- **Composio's proxy doesn't cover every endpoint.** If a specific upstream URL returns 500 for the proxy but works from raw provider docs, it may not be in Composio's allowlist for that toolkit. Check `https://app.composio.dev/...` toolkit docs.
- **The `whoamiPath` in ProviderRegistry is GET-by-default.** If your provider needs POST for whoami (Slack auth.test), the SDK's `connection_status` will return `{connected: false}`. Workaround: either change provider.whoamiPath to a GET endpoint, or implement a custom probe inside an action. The "POST whoami" gap is on the SDK to fix.

## Anti-patterns

- Do not import `@holaboss/bridge` — that's the legacy SDK. Use `@holaboss/app-builder-sdk` exclusively.
- Do not write `as any` to dodge a type error. The SDK vends `RowOf<TSchema>` end-to-end via `z.infer`; if a callback's `row` doesn't have the field you want, the schema is missing it — fix the schema.
- Do not hand-write a Vite config or TanStack Start scaffold. The whole point of this SDK is no UI.
- Do not hardcode the broker URL, grant, workspace id, or MCP port. They're env-injected at boot.
- Do not write a "scheduler" — no cron in app code. Sync `schedule:` strings are descriptive, not executed by the SDK.
- Do not write a separate SKILL.md under the app's directory. The two skill systems are `embedded-skills/` (here) and `<workspace>/skills/`. App-local Markdown is not a skill.
- Do not deploy until step 5 of the verification checklist returns `connected: true`. A green `/mcp/health` is necessary but not sufficient.

## Reference index (read order)

1. `experiments/app-builder-sdk/README.md` — top-level overview
2. `experiments/app-builder-sdk/src/index.ts` — public surface
3. `experiments/app-builder-sdk/src/types.ts` — full type contract, including `RowOf` and the integer-id stringify note
4. `experiments/app-builder-sdk/reference/<shape>/app.ts` — copy + adapt
5. `experiments/app-builder-sdk/reference/slack-messaging/server.ts` + `app.runtime.yaml` — copy + adapt
6. `experiments/app-builder-sdk/test/mcp-server.test.ts` — what derived tools / `connection_status` / refresh / sync_status are expected to do; useful as oracle when writing a new app's tests
