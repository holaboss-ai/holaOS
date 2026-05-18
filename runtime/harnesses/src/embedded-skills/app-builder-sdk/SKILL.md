---
name: app-builder-sdk
description: Build a new holaOS app using @holaboss/app-builder-sdk (5 backend primitives + optional shadcn dashboard UI). The canonical path for vibe-coded apps — integration modules AND dashboard apps both live here.
---

# App Builder (SDK)

Use this skill whenever the user wants a new holaOS app. Two shapes both ship through the same SDK; pick the one the request needs:

1. **Integration-only module** — Slack, Discord, Notion, Stripe, Linear, anything whose value is "talk to one external service via MCP tools, agent drives, no per-app dashboard". The SDK's default web stub is fine; no `src/client/` directory.
2. **Dashboard app** — vibe-coded content planners, CRMs, kanban-style trackers, podcast-guest managers, anything where the user expects a workspace pane they can look at and click around in. **Has a real shadcn UI** authored under `src/client/` (TanStack Start). The MCP tools are still there — they're how the agent drives the same data the dashboard surfaces.

The SDK core (5 primitives below) is identical for both shapes. The dashboard shape adds a `src/client/` directory; that's the only structural delta.

All supplemental files named in this skill are bundled beside this `SKILL.md`. Treat those paths as skill-local references that are safe to use in packaged runtimes; do not guess at repo-root paths.

## When NOT to use this skill

- The user already has a working hola-boss-apps module and wants to extend it → modify it in place; don't rewrite as SDK. (The legacy app-builder skill that used to live alongside this one has been removed; all new app work goes through this SDK.)

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

Full type contract: `sdk/types.ts`. Public exports: `sdk/index.ts`.

### `provider.id` MUST be the Composio toolkit slug

There is ONE provider identifier; the same value flows through every layer of the connect + proxy chain:

- `app.runtime.yaml`'s `integration.destination`
- `pending_integrations[].provider_id` (runtime emits this to drive the chat Connect card)
- Hono `/api/composio/connect`'s `body.provider` (Hono uses it verbatim as Composio's `toolkit_slug`)
- `integration_connections.provider_id` (DB row created at OAuth finalize)
- `integration_bindings.integration_key` (DB row created when the user clicks Bind)
- `createRuntimeBrokerTransport({ provider })` at runtime (broker keys the binding lookup on it)

`provider.id` in `ProviderRegistry` IS this value. It MUST be the canonical Composio toolkit slug — the exact string in Composio's catalog at https://platform.composio.dev — not a "user-friendly" alias. Common ones that bite:

- Discord bot: **`discordbot`** (NOT `discord` — that slug, if it exists, grants only `identify` scope and cannot post messages → `POST /channels/.../messages` returns 401, which the SDK maps to `not_connected`)
- Google Calendar: **`googlecalendar`** (NOT `gcal` or `google`)
- Google Sheets: **`googlesheets`**
- Google Drive: **`googledrive`**
- Slack / GitHub / Gmail / Notion / Stripe / Linear / Figma / Calendly / Mailchimp / Reddit / Twitter / Instagram / YouTube / LinkedIn: **lowercase brand name** (verify in catalog).

If unsure, verify against Composio's catalog BEFORE writing `provider.ts`:

```bash
curl -sS https://backend.composio.dev/api/v3/toolkits \
  -H "x-api-key: $COMPOSIO_API_KEY" \
  | jq -r '.items[] | select(.slug | test("(?i)<keyword>")) | .slug + " — " + .name'
```

The legacy `composioToolkit` field on `ProviderRegistry` is **deprecated**. Do not set it. If a reference still does, replace `id` with the same value and drop `composioToolkit`. Splitting them was a misreading of the runtime — the broker proxy uses ONLY `provider` (= `cfg.id`); `composioToolkit` is dead code, currently used only by `manifest.ts` as a fallback that should never trigger when `id` is correct.

## Dashboard / workspace-pane UI (vibe-coded apps)

The SDK's default `startMcpServer({ httpPort, ... })` ships a one-screen "headless module" placeholder on the http port. That placeholder is **only acceptable for integration-only modules** (Slack-style MCP-driven flows). The moment the user asks for a dashboard / list view / kanban / calendar / "let me see my X", **you must replace the placeholder with a real shadcn UI under `src/client/`**. The placeholder is what makes vibe-coded apps look ugly — the user has flagged it explicitly.

The product constraints are distilled below from the original vibe-coding design review. Treat this section as the source of truth for the UI constraints in packaged runtimes.

### L1 — shadcn registry is the ONLY component source

Bring shadcn primitives in via the holaOS-locked registry version (set in the app's `components.json`). No other component library (Material UI, Ant, Chakra, etc.). No raw `<div>` styled with custom classes either — use `Card`, `Button`, `Input`, `Select`, `Table`, `Dialog`, `Sheet`, `Tabs`, `Popover`, `Accordion`, `Dropdown`, `Badge`, `Avatar`, etc.

### L2 — theme tokens are immutable

Colors, font sizes, spacing, radii **all** come from CSS variables wired up by the holaOS theme (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`, `--border`, `--radius`, etc.). No inline `style={{ color: "#f12711" }}`. No custom CSS files. No new Tailwind colors. If a value is missing from the token palette, it's a SDK gap to escalate — do not patch it locally.

### L3 — prefer opinionated layouts when they exist

The platform is rolling out a small library of "long like a family" layout components: `AppShell`, `ResourceList`, `ResourceDetail`, `ResourceKanban`, `ResourceCalendar`. If they're available (check `@holaboss/app-builder-sdk` exports at write-time), reach for them first — they consume an `app.resource()` declaration and render the right UI with zero boilerplate. If they're NOT yet exported, **do not invent your own AppShell with `<div>` + Tailwind**. Compose shadcn primitives directly in a single route file: `Card` + `Tabs` + `Table` is the safe minimum, and it upgrades cleanly when the layouts land.

### L4 — free compose within L1+L2

Within those two ironclad layers, you have full freedom: drop in `Dialog` for confirmations, `Popover` for filters, `Tabs` for view switching. Different apps should be visually distinguishable (a content planner ≠ a CRM) but everyone in the workspace should "look like one family".

### Practical scaffolding (today, no AppShell yet)

For a dashboard app, `src/client/` is a TanStack Start surface that serves the workspace iframe:

```
src/client/
├── components.json          # locked shadcn registry pinned in app.runtime.yaml
├── routes/
│   ├── __root.tsx          # imports the global theme.css (CSS variables)
│   └── index.tsx           # ResourceList-style table by default
├── components/
│   └── ui/                  # shadcn primitives — generated via shadcn CLI, NOT hand-written
└── lib/utils.ts             # cn() helper (shadcn convention)
```

Wire it up by:

1. Start TanStack Start (or simple Bun.serve serving a Vite-built dashboard) on `env.PORT` from the same `server.ts` that boots the MCP server on `env.MCP_PORT`. The desktop's iframe loads whatever the http port serves.
2. The dashboard reads the app's own SQLite (the table `app.resource()` declared) via TanStack Start server functions — same DB the MCP tools mutate. **Never duplicate state.**
3. Mount the global theme stylesheet at the top of `__root.tsx`. Without it the shadcn tokens fall back to defaults and the app looks alien.

### Schema migration (from PM doc)

vibe coding's biggest failure mode is destructive migrations. Rules:

| Change | Behaviour |
|---|---|
| Add field | Additive, safe, default value auto-filled, agent does it directly |
| Rename field | Safe, auto-migrate |
| Delete field | Destructive — require user confirm + auto-backup the old data |
| Change field type | Destructive — same |
| Change state alphabet | Existing-state mapping must be explicit; agent proposes, user confirms |

Each schema change is a version; the user must be able to roll back.

### UI anti-patterns (failure modes the user flagged)

- **Raw HTML with hand-written Tailwind classes for whole layouts.** The default placeholder is exactly this and it looked terrible. Always start from `Card` + `Table` + `Tabs`.
- **Inline `style={{ ... }}`** anywhere except `style={{ width: ... }}` for measured layout (resize observers etc.). Colors / spacing / radii never inline.
- **Hardcoded hex colors / px values for spacing or radii.** Use the theme tokens; if missing, surface to the SDK team.
- **A new component library** (radix-ui standalone, headless-ui, react-aria) — shadcn already wraps Radix; that's the only path.
- **A single-page dashboard with 3+ deeply nested `div`s of custom flexbox.** Use shadcn's `Card`, `Separator`, `Tabs` — they encode the platform's spacing rhythm.
- **Per-app dark mode toggle / theme picker.** Theme is workspace-level; the app inherits via CSS variables and does nothing.

### Reviewer pass

After writing the dashboard, eyeball it against an existing healthy holaOS pane (e.g. the marketplace pane, the integrations pane). It should feel like the same product. If it doesn't, you've broken L1 or L2 — re-check.

## Pick a reference shape

Copy the closest bundled reference dir as your template; don't write from scratch. All backend references are at `reference/<shape>/`.

The existing references are **integration-only** (no `src/client/`). Use them for the backend skeleton (`app.ts`, `provider.ts`, `server.ts`, `app.runtime.yaml`) — they're correct. For dashboard apps, layer `src/client/` on top per the "Dashboard / workspace-pane UI" section above; no dashboard-shape reference exists yet, so model the visual after the desktop's healthy panes (marketplace / integrations) and the L1-L4 constraints.

| Shape | Reference | Use when the request looks like |
|---|---|---|
| **messaging** | `slack-messaging/` | Send / edit / delete / react on a message; chat-like provider (Discord, Telegram, IRC, SMS). Has custom state alphabet + side-effect actions + reversible scheduled send. **Also the only reference with full `server.ts` + `app.runtime.yaml`** — copy those two files verbatim into any new module regardless of shape. |
| **publishing** | `pinterest-publishing/` | Multi-step upload-then-publish + reversible cancel; idempotency via `row.external_id` short-circuit. Use for any "create draft → confirm → publish → can be deleted" flow (image / video / blog posts). |
| **workflow** | `github-workflow/` | Multi-state lifecycle (`draft / open / in_progress / closed / reopened / failed`), reversible close↔reopen, side-effect actions (`comment`, `assign`) that don't change row.status. CRM leads / issue trackers / ticketing systems. |
| **event-with-time** | `gcalendar-events/` | Resources carry their own `start_time/end_time` (intrinsic, not "schedule this action later"); RSVP as side-effect; recurring (RRULE). Use for calendar / booking / appointment modules. |
| (already-built dogfood) | `telegram-messaging/` | First app a cold subagent built using only this skill + the SDK. Integer external IDs (`message_id` is int — stringify on persist). Read its inline notes if your provider also has integer IDs. |

Always read the `app.ts` of the chosen reference end-to-end before writing your own. Each one's top-of-file banner notes the shape it demonstrates and provider-specific quirks the agent who wrote it found.

## File layout per module

### Integration-only modules — 4 files

For Slack-style modules where the agent drives via MCP and no dashboard is needed:

```
<workspace>/apps/<app_id>/
├── app.ts              # buildXApp(options) — connection / resource / action / sync declarations
├── provider.ts         # ProviderRegistry: id, baseUrl, allowedHosts, whoamiPath
├── server.ts           # production entry: SqliteStateBackend + runtime-broker + startMcpServer
├── app.runtime.yaml    # manifest (lifecycle, healthchecks, mcp.tools list, env_contract, integration)
└── package.json        # only declares: @holaboss/app-builder-sdk via `file:` dep
```

`startMcpServer({ httpPort })`'s built-in placeholder is acceptable here — the user never opens this app's workspace pane in practice, they drive it from chat. Copy `reference/slack-messaging/{server.ts,app.runtime.yaml}` and adapt the constants. Copy `reference/<your-shape>/{app.ts,provider.ts}` and adapt the resource/action declarations.

### Dashboard apps — adds `src/client/`

For vibe-coded apps where the user expects a workspace pane:

```
<workspace>/apps/<app_id>/
├── app.ts              # SDK declarations (same as integration-only)
├── provider.ts         # (omit when the app has no upstream integration)
├── server.ts           # boots BOTH the MCP server (MCP_PORT) and the dashboard server (PORT)
├── app.runtime.yaml    # adds PORT to env_contract; references the client lifecycle
├── package.json        # adds: @tanstack/react-start, react, shadcn deps via `bunx shadcn add`
├── src/client/         # TanStack Start dashboard — see "Dashboard / workspace-pane UI" above
│   ├── routes/
│   ├── components/ui/  # shadcn primitives, generated NOT hand-written
│   └── lib/utils.ts
└── components.json     # shadcn registry pinned to the holaOS-locked version
```

`server.ts` for dashboard apps runs two things:

```ts
// 1) MCP — same as integration-only
startMcpServer({ mcpPort: Number(process.env.MCP_PORT), app, bridge, state })

// 2) Dashboard — Bun.serve the TanStack Start build output OR Vite dev server.
//    Reads from the SAME SqliteStateBackend the SDK uses, via TanStack Start
//    server functions. NEVER spin up a second DB.
import { build } from "./client/build" // built dashboard
Bun.serve({ port: Number(process.env.PORT), fetch: build.fetch })
```

The desktop's iframe (`AppSurfacePane`) resolves the URL to `env.PORT`; whatever you serve there is what the user sees.

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
    "@holaboss/app-builder-sdk": "file:/absolute/path/to/<app-builder-sdk-skill-dir>/sdk-package"
  }
}
```

Prefer the bundled `sdk-package` path beside this skill. Do not assume a repo checkout exists. The dependency path still needs to be absolute because the SDK package lives outside the workspace and relative paths break across worktrees.

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

`mcp.tools` list must match what `app.derivedTools()` returns. The derivation rules from `sdk/app.ts:165-238` are:
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

### 6. Bind the integration connection

After installing the app, bind it to the existing provider connection:

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

### Backend (every app)

1. `cd <workspace>/apps/<app_id> && bun install` → exit 0, lockfile written
2. `MCP_PORT=<port> WORKSPACE_DB_PATH=/tmp/<app_id>.db HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:40531/api/v1/integrations HOLABOSS_APP_GRANT=fake bun run server.ts &` → "MCP server listening on :<port>" and "Tools registered: N" in stdout
3. `curl http://localhost:<port>/mcp/health` → `{"status":"ok","app_id":"<app_id>"}`
4. (After registering in workspace.yaml + restarting desktop or hitting the binding refresh API) the app appears in the desktop integrations pane
5. After the manual PUT binding step, agent calls `<app_id>_connection_status` → returns `{connected: true, identity: {...}}` if `provider.whoamiPath` is set, else `{connected: null, reason: "no_probe_defined"}`. Anything else (`{connected: false, reason: ...}`) means the binding or the upstream is broken — read the `message` field, fix root cause, don't retry blindly.
6. Agent calls one real action tool end-to-end (e.g. `discord_send_message_message`). Must return `{ok: true, externalId: "..."}` and the provider must show the action in its UI (the user can verify).

### Dashboard (additionally, for dashboard apps)

7. `curl http://localhost:<PORT>/` returns a TanStack Start HTML response — NOT the SDK's default "headless module" placeholder (search for "headless module" in the response body; if it appears, the dashboard server didn't start or isn't bound to PORT).
8. Open the app's workspace pane in the desktop. It MUST visually resemble other holaOS panes — same fonts, same borders, same radii, same Card surface color. If it looks alien (raw HTML, off-brand colors, weird spacing), you've broken L1 or L2 of the UI constraints. Re-check that the global theme stylesheet is imported in `__root.tsx` and that all surfaces use shadcn primitives.
9. Click around. Every interaction (dialogs, dropdowns, table sort, tab switch) must come from shadcn primitives; no native `<select>` / `<input>` / `<button>` should appear unstyled.
10. Reload the desktop. The dashboard should rehydrate without a flash of unstyled content — confirms the CSS variables resolve at first paint.

## Anti-patterns

### SDK / backend

- Do not import `@holaboss/bridge` — that's the legacy SDK. Use `@holaboss/app-builder-sdk` exclusively.
- Do not write `as any` to dodge a type error. The SDK vends `RowOf<TSchema>` end-to-end via `z.infer`; if a callback's `row` doesn't have the field you want, the schema is missing it — fix the schema.
- Do not hardcode the broker URL, grant, workspace id, MCP port, or dashboard PORT. They're env-injected at boot.
- Do not write a "scheduler" — no cron in app code. Sync `schedule:` strings are descriptive, not executed by the SDK.
- Do not write a separate SKILL.md under the app's directory. The two skill systems are `embedded-skills/` (here) and `<workspace>/skills/`. App-local Markdown is not a skill.
- Do not deploy until step 5 of the verification checklist returns `connected: true`. A green `/mcp/health` is necessary but not sufficient.
- Do not spin up a second SQLite DB for the dashboard. The dashboard reads from the same `SqliteStateBackend` the SDK uses (the table `app.resource()` declared) — via TanStack Start server functions.

### Dashboard UI

- Do not ship the SDK's default "headless module" placeholder when the user asked for a dashboard. That page is intentionally minimal and ugly; the moment a dashboard is needed, `src/client/` must replace it.
- Do not hand-write `<div>`-based layouts. Compose shadcn primitives (`Card`, `Tabs`, `Table`, `Dialog`, etc.) from the locked registry.
- Do not introduce a second component library (MUI, Ant, Chakra, raw Radix, Headless UI). The holaOS-locked shadcn registry is the only allowed source.
- Do not use inline `style={{ color: ..., padding: ... }}` for colors / spacing / radii. CSS variables (`--background`, `--primary`, `--radius`, …) only.
- Do not write a per-app theme toggle. Theme is workspace-level; the app inherits via CSS variables.
- Do not hand-write `components/ui/button.tsx` etc. — use `bunx shadcn add button` so the locked registry version lands.

## Reference index (read order)

### Always

1. `sdk/README.txt` — top-level overview bundled for packaged runtimes
2. `sdk/index.ts` — public surface
3. `sdk/types.ts` — full type contract, including `RowOf` and the integer-id stringify note
4. `sdk/app.ts` — derived tool naming, primitive wiring, and registration behavior

### For the backend shape (both integration-only and dashboard apps need this)

5. `reference/<shape>/app.ts` — copy + adapt; pick the shape that matches the user's request (messaging / publishing / workflow / event-with-time)
6. `reference/slack-messaging/server.ts` + `reference/slack-messaging/app.runtime.yaml` — copy + adapt; this is the only bundled reference that ships a complete `server.ts`
7. `sdk/mcp-server.test.ts` — what derived tools / `connection_status` / refresh / sync_status are expected to do; useful as oracle when writing a new app's tests

### For dashboard apps (additionally)

8. `ui-reference/components.json` — the holaOS-locked shadcn registry version. Match it in the app's own `components.json` so primitives stay aligned.
9. `ui-reference/tokens.css` and `ui-reference/themes/holaos.css` — the shared CSS variable tokens (`--background` / `--primary` / `--radius` / etc.). Use these; do not invent new ones.
10. Compare against the current live desktop panes if available, but do not leave the workspace or guess repo-root source paths just to locate pane source files.
