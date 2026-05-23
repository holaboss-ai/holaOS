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

Full type contract: `sdk-package/src/types.ts`. Public exports: `sdk-package/src/index.ts`.

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

If unsure, verify against the **integration store catalog** BEFORE writing `provider.ts` — the runtime will reject `workspace_apps_register` on any `provider` that isn't in this list with a "did you mean '<x>'?" suggestion. The store catalog is the curated subset of Composio toolkits we explicitly support; Composio has 1000+ toolkits but only the ones in `runtime/api-server/src/integration-store-catalog.ts` (Hero + Supported tiers) are accepted.

```bash
# Look up supported slugs from the runtime (preferred — single source of truth):
curl -sS http://127.0.0.1:8080/api/v1/capabilities/runtime-tools/integrations/catalog | jq '.provider_ids'

# Or grep the catalog file directly if you have the repo open.
```

Composio's own catalog (`https://backend.composio.dev/api/v3/toolkits`) is a useful reference for slug spelling but is **not** the source of truth — a slug existing on Composio does NOT mean we support it. If you want to add a new toolkit, the workflow is: add a row to `integration-store-catalog.ts`, not bake the unsupported slug into your app.

The legacy `composioToolkit` field on `ProviderRegistry` is **deprecated**. Do not set it. If a reference still does, replace `id` with the same value and drop `composioToolkit`. Splitting them was a misreading of the runtime — the broker proxy uses ONLY `provider` (= `cfg.id`); `composioToolkit` is dead code, currently used only by `manifest.ts` as a fallback that should never trigger when `id` is correct.

### Connection readiness: ask the runtime, never the upstream host

If your app needs to show "connected / needs connection" status in the UI, you **MUST** call `getIntegrationStatus()` from `@holaboss/app-builder-sdk` on mount (via a TanStack Start server function or loader), and re-call it after the user finishes any Connect flow. There is **no other supported way** to detect connectivity. Pinging the upstream host (`https://api.twitter.com/...`, `https://api.notion.com/...`) is not just suboptimal — it is the exact failure mode that left every previous vibe-coded dashboard stuck on "needs connection" the moment Composio rerouted the toolkit (api.twitter.com → api.x.com, Discord scope-only slug, etc.). The register-time lint rejects hardcoded upstream hosts; `getIntegrationStatus()` is the only way through.

```ts
// src/client/lib/integration-status.ts (TanStack Start server function)
import { getIntegrationStatus } from "@holaboss/app-builder-sdk"

export const integrationStatus = createServerFn().handler(async () => {
  return getIntegrationStatus()
})

// or narrow to one provider for a per-toolkit badge:
export const twitterStatus = createServerFn().handler(async () => {
  return getIntegrationStatus({ provider: "twitter" })
})
```

The helper reads `HOLABOSS_APP_GRANT` + `WORKSPACE_API_URL` (both injected by the runtime when your app starts) and calls the runtime's `/api/v1/integrations/readiness` endpoint. Response shape: `{ ready: boolean, issues: [{ provider, integrationKey, code, message }] }`. `code` is one of `ready | integration_not_bound | integration_not_connected | integration_needs_reauth` — let the UI pick the affordance from that code (e.g. show "Connect" for `integration_not_connected` and "Reconnect" for `integration_needs_reauth`).

There is **no legitimate reason** for an SDK app to ping the upstream API host as a connectivity test. If something looks like it needs that, you want `getIntegrationStatus` instead.

The runtime enforces this at `workspace_apps_register` time: a source-tree scan rejects any app whose `src/` contains hardcoded toolkit hosts like `api.twitter.com`, `api.x.com`, `api.github.com`, `slack.com/api`, `api.notion.com`, `api.linear.app`, `gmail.googleapis.com`, etc. The error names the file, line, and the provider you should be routing through instead. The right shape is **always** `createRuntimeBrokerTransport({ provider })` — no upstream host belongs in your app code.

## Dashboard / workspace-pane UI (vibe-coded apps)

The SDK's default `startMcpServer({ httpPort, ... })` ships a one-screen "headless module" placeholder on the http port. That placeholder is **only acceptable for integration-only modules** (Slack-style MCP-driven flows). The moment the user asks for a dashboard / list view / kanban / calendar / "let me see my X", you must replace the placeholder with a real dashboard built on `@holaboss/ui`.

### Polish pass: handled by a separate auto-queued turn

For dashboard apps (those with `src/client/`), the runtime auto-queues a polish-only input on the main session after `workspace_apps_ensure_running` returns `ready: true`. You do **not** have to invoke `interface-design` or refactor `src/client/` inside the same turn as the build. The response from `workspace_apps_ensure_running` includes a `polish_pass_queued` array listing the queued input(s); the polish turn dispatches automatically as the next turn on the user's chat.

In this build turn: finish wrapping up cleanly — tell the user the app is built, mention that a polish pass will run next. That's it.

In the auto-queued polish turn (you'll see a `text` payload starting with `[Auto-queued post-build polish pass]`):

1. Invoke `skill({ name: "interface-design" })` and read its full output.
2. For each `.tsx` / `.css` file under `apps/<app_id>/src/client/`: **REWRITE the whole file via `bash` heredoc** (`cat > path/to/file <<'EOF' ... EOF`), NOT via `edit`. Whole-file rewrite is mandatory for this pass — incremental edits repeatedly produce checkbox-compliant no-changes.
3. Re-run `workspace_apps_build` + `workspace_apps_restart_and_wait_ready`.
4. Take a `browser_screenshot` of the rendered dashboard. Compare it against the `interface-design` rules you just loaded. If the rendered output doesn't match those rules, return to step 2 and rewrite again.
5. Only after the screenshot is right, declare the polish pass done.

Why this is a separate auto-queued turn and not part of the build turn:

- Doing both in one turn consistently produced "skill invoked, 1 trivial edit, ready" — the agent's task-complete mindset and ~80-tool-call context fatigue defeated every prompt-strength escalation we tried. Forensic at `holaOS/docs/plans/2026-05-22-interface-design-skill-noop-forensic.md`.
- A separate turn restores fresh context, narrow scope, and no build-time inertia. Empirically this matches the one observed successful polish, which the user manually triggered as a second turn.

What this gate is NOT:

- Not optional for dashboard apps — the input is queued mechanically; you can't skip it. Integration-only modules (no `src/client/`) get no queued input.
- Not satisfied by ceremony — the runtime can verify file mtimes / screenshot, and the user checks the rendered UI either way.
- Not replaced by `frontend-design` — that one targets marketing pages and drifts the output the wrong way.

### Visual decisions belong to `interface-design`, not here

Every visual decision — density, hierarchy, typography, color usage, layout shape — is delegated to the `interface-design` skill that runs in the auto-queued polish turn. This file deliberately does NOT prescribe what a dashboard should look like.

The reasoning is empirical: previous versions of this skill listed concrete visual rules and named the failure modes to avoid. Observed output consistently reproduced the named failure modes — naming an anti-pattern is enough to anchor on it. Removing them from this file leaves `interface-design` as the sole authority on look-and-feel.

If your output looks wrong, the fix lives in the polish turn (re-invoke `interface-design`, rewrite via heredoc, screenshot, iterate). It does not live in this SKILL.md.

### The rule: import `@holaboss/ui`, do not redefine primitives

`@holaboss/ui` is a public npm package. It provides every primitive and CSS token your dashboard needs. **Do not generate shadcn primitives, copy a `components/ui/` directory, write your own Card, or import any other component library**. If `@holaboss/ui` is missing something, surface it to the SDK team instead of inventing a local replacement — visual drift is the failure mode the library exists to prevent.

Layout itself is your call. There is no `DashboardShell` / `PageHeader` / `DataTable` / `StatPill` / etc. — those were removed in 0.3.0. Compose page chrome from the raw primitives (Card, Tabs, Sheet, Sidebar, Table, Skeleton, EmptyState…). What the layout should look like is decided in the `interface-design` polish turn, not here.

Install:

```bash
cd <app-dir>
bun add @holaboss/ui
```

Both `@holaboss/app-builder-sdk` and `@holaboss/ui` are public npm packages. The resulting `package.json` looks like:

```json
"dependencies": {
  "@holaboss/app-builder-sdk": "latest",
  "@holaboss/ui": "latest"
}
```

**Always use `"latest"` for both.** These packages are lockstep-evolving alongside this skill — pre-1.0 caret semver (`^0.1.0`) only matches `0.1.x`, so any pinned dep silently drifts behind the skill when a new minor is published. `"latest"` keeps every fresh `bun install` aligned with the runtime's current expectations. Do NOT install via `file:` paths, git refs, or pinned versions — `"latest"` is the only supported form.

### Mount the styles — one import, done

`@holaboss/ui` ships a pre-compiled stylesheet that contains:
- the holaOS design tokens (`--background`, `--foreground`, `--primary`, `--radius`, etc.)
- the default theme palette
- every Tailwind utility class used by the library's primitives + layouts

Import it once at the dashboard root:

```tsx
// src/client/routes/__root.tsx
import "@holaboss/ui/styles.css";
```

That's it. **Do not** try to add `@holaboss/ui` to your own Tailwind `@source` list — the utilities are already baked in. **Do not** mount `tokens.css` + `themes/holaos.css` separately unless you have an explicit reason (those exports exist as an escape hatch).

Visual rules: colors / spacing / radii come from these CSS variables. No inline `style={{ color: "#f12711" }}`. No custom CSS files. No new Tailwind colors. If a value is missing from the token palette, escalate to the SDK team — do not patch it locally.

### Catalog of what `@holaboss/ui` ships

A full base-ui-flavoured shadcn surface — ~55 primitives. The ones you reach for most for a dashboard:

- **Containers**: `Card` (+ Header/Title/Description/Content/Footer/Action), `Sheet`, `Drawer`, `Dialog`, `AlertDialog`, `HoverCard`, `Popover`, `Tabs`
- **Lists / tables**: `Table` (+ Header/Body/Row/Cell/Caption/Footer), `Sidebar` family, `Accordion`, `Collapsible`
- **Form**: `Input`, `Textarea`, `Select`, `NativeSelect`, `Checkbox`, `RadioGroup`, `Switch`, `Slider`, `Combobox`, `Field` family (FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldDescription, FieldError), `InputGroup`, `InputOTP`, `Label`
- **Charts**: `Chart` family — `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` (wraps Recharts)
- **States**: `EmptyState`, `Skeleton`, `Spinner`, `Progress`, `Alert`
- **Atoms**: `Button`, `Badge`, `Avatar`, `StatusDot`, `Kbd`, `Separator`, `Tooltip`, `Toggle`, `ToggleGroup`, `ButtonGroup`, `Item`
- **Nav / IA**: `Breadcrumb`, `Pagination`, `NavigationMenu`, `Menubar`, `DropdownMenu`, `ContextMenu`, `Command`
- **Layout helpers**: `AspectRatio`, `Resizable`, `Calendar`, `Carousel`

**Utility**: `cn(...)` for class merging. **Toast**: import `Toaster` and use `toast()` from `sonner` (re-exported).

### Wiring the client app

1. Start TanStack Start (or simple Bun.serve serving a Vite-built dashboard) on `env.PORT` from the same `server.ts` that boots the MCP server on `env.MCP_PORT`. The desktop's iframe loads whatever the http port serves.
2. The dashboard reads the app's own SQLite (the table `app.resource()` declared) via TanStack Start server functions — same DB the MCP tools mutate. **Never duplicate state.**
3. Mount `@holaboss/ui/styles.css` at the top of `__root.tsx`. That single import covers the tokens, the default theme, and every Tailwind utility class the library uses. Without it the tokens fall back to defaults and the components render with no styling.

Beyond those three wiring points, **the layout is yours**. The `interface-design` skill output (delivered in the auto-queued polish turn) is your design brief; the primitive catalog above is your toolbox. No scaffolding template, no "minimal dashboard route" stub to copy.

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

### UI anti-patterns — two are enforced at register time

`workspace_apps_register` runs two structural lints over `src/client/` for dashboard apps. Both reject the call with file/line context; nothing ships until they pass.

- **Minimum named imports from `@holaboss/ui`.** A dashboard with fewer than 3 distinct named imports from the library across all `src/client/` files is rejected. Importing only `@holaboss/ui/styles.css` (the stylesheet) does NOT count — the library exists to provide composable components, not just tokens. Replace hand-rolled className-based components with the library's `Card` / `Button` / `Table` / `Badge` / `StatusDot` / `Skeleton` / `EmptyState` / `Tabs` / `ChartContainer` etc.
- **No parallel design system in app-local CSS.** Any `.css` file under `src/client/` containing hex color literals (`#1f883d`), raw color function calls (`rgb()` / `hsl()` / `oklch()` / `lab()` / `lch()`), or custom CSS variable definitions that don't forward an existing holaOS token (`--my-thing: var(--background);` style passthroughs are allowed) is rejected. The lint exists because agents repeatedly shipped 200+-line stylesheets defining their own theme on top of the library — bypassing the OKLch palette, the font-weight cap, and the workspace theme system. App-local CSS may contain `@import "tailwindcss"` and empty `@layer` blocks so app-side composed Tailwind classes work; that's all.

Other UI anti-patterns (not lint-enforced, but still wrong):

- **A `components/ui/` directory or any shadcn-add path.** Import primitives from `@holaboss/ui` only.
- **Inline `style={{ ... }}`** anywhere except `style={{ width: ... }}` for measured layout (resize observers, etc.).
- **Hardcoded hex colors / px values for spacing or radii.** Use the theme tokens; if missing, surface to the SDK team.
- **A new component library** (Material UI, Ant, Chakra, react-aria, etc.) — `@holaboss/ui` wraps the workspace-canonical primitives; that's the only path.
- **Per-app dark mode toggle / theme picker.** Theme is workspace-level; the app inherits via CSS variables and does nothing.

### App-level anti-patterns (not UI — code shape)

- **Hand-rolled polling / `setInterval` / `setTimeout(retry, N)` / custom backoff loops.** All scheduling and retry lives in the workspace automations layer. The SDK's `sync(name, { schedule, ... })` is a **declarative** statement of intent — Holaboss runs it on the declared cadence; you do not. Putting an interval in client or server code creates duplicate fetches, fights workspace pause/resume, and ignores user-level rate budgets.
- **Custom OAuth, token storage, or refresh logic.** The runtime broker via Composio owns the OAuth lifecycle, token rotation, scope negotiation, and re-auth detection end-to-end. Your app's only credential primitive is `createRuntimeBrokerTransport({ provider })`. If you find yourself reading a token, you are off-path; route through the broker instead. To branch on "needs reauth", use `getIntegrationStatus()` and inspect `code === "integration_needs_reauth"`.
- **Hardcoded user identity in code** — usernames, email addresses, account ids, workspace names. These are mutable + per-workspace. Read identity from `getIntegrationStatus()` issues (handle/email come back enriched), from app row state, or from a server-function parameter. Never bake "@jotyy" or "user@example.com" into source.
- **Layering a second ORM / entity abstraction on top of `resource` + `action` + `sync`.** The five primitives are the whole storage contract; the MCP tool surface and the dashboard reads derive from them. If you need a field, a state, or an action that doesn't exist in your `resource`, extend the resource — don't wrap it in your own `class Repository`. A parallel model silently desynchronizes from the tools the agent gets.
- **All-or-nothing dashboard rendering.** Don't block the entire page on a `Promise.all` of every server fetch. Each card, table, and chart should render the moment its own data lands, with a `Skeleton` during fetch and `EmptyState` if the data is empty. A 0.5s skeleton beats a 4s blank page even when the slow query is just one card.
- **Forgetting the `integration:` block when the app uses a Composio provider.** If you call `createRuntimeBrokerTransport({ provider: "gmail" })` anywhere in the app, `app.runtime.yaml` MUST declare a matching `integrations:` entry. Otherwise the binding step has no key to bind, `getIntegrationStatus()` reports `integration_not_bound`, and the dashboard is stuck. See section 4 below.

### Reviewer pass

After writing the dashboard, eyeball it against an existing healthy holaOS pane (e.g. the marketplace pane, the integrations pane). It should feel like the same product. If it doesn't, you've imported something from outside `@holaboss/ui` or redefined a primitive — re-check.

## Pick a reference shape

Copy the closest bundled reference dir as your template; don't write from scratch. All backend references are at `reference/<shape>/`.

Backend references (`slack-messaging`, `pinterest-publishing`, `github-workflow`, `gcalendar-events`, `telegram-messaging`) are integration-only (no `src/client/`). Use them for the backend skeleton (`app.ts`, `provider.ts`, `server.ts`, `app.runtime.yaml`) — they're correct. **There is no dashboard reference.** Dashboard-shape apps assemble `src/client/` themselves from `@holaboss/ui` primitives under the `interface-design` skill's guidance — copying a single canonical template was producing every dashboard looking the same, so the template was removed.

| Shape | Reference | Use when the request looks like |
|---|---|---|
| **dashboard** | _(none — compose freely)_ | Anything with a list / table / kanban / calendar / "let me see my X" — agent-built workspace pane. There is no canonical `src/client/` template; assemble from `@holaboss/ui` primitives under the `interface-design` skill. Combine with one of the backend shapes below for the actual data plane. |
| **messaging** | `slack-messaging/` | Send / edit / delete / react on a message; chat-like provider (Discord, Telegram, IRC, SMS). Has custom state alphabet + side-effect actions + reversible scheduled send. **Also the only backend reference with full `server.ts` + `app.runtime.yaml`** — copy those two files verbatim into any new module regardless of shape. |
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
└── package.json        # declares @holaboss/app-builder-sdk via npm semver
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

### 1. `package.json` — npm semver, no `file:` paths

```json
{
  "name": "<app_id>-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@holaboss/app-builder-sdk": "latest",
    "@holaboss/ui": "latest"
  }
}
```

Both packages live on npmjs.com (public, Apache-2.0). `bun install` pulls them down like any normal dep — no repo checkout assumption, no machine-specific file: paths. Use `"latest"` literally; do not pin a version.

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

`mcp.tools` list must match what `app.derivedTools()` returns. The derivation rules from `sdk-package/src/app.ts:165-238` are:
- `<app_id>_connection_status` — always
- For each resource: `<app_id>_list_<plural>`, `<app_id>_get_<resource>`, and (if `refreshEvery + fetch` declared) `<app_id>_refresh_<plural>`
- For each action: `<app_id>_<action_name>_<resource_name>` (or `def.toolName` override), plus `<app_id>_cancel_<action>_<resource>` for reversible
- For each sync: `<app_id>_<sync_name>_sync_status`
- `<app_id>_snapshot` — always

If you're not sure, write the app, `bun run server.ts` once locally, and read the "Tools registered: N" log line.

### 4. `integration` block in app.runtime.yaml — REQUIRED if the app calls any provider

If your app uses `createRuntimeBrokerTransport({ provider })` or otherwise consumes a Composio toolkit, you **must** declare a matching `integrations:` entry. Without it:
- The runtime binding lookup has no key to match, so `upsertIntegrationBinding` succeeds at the row level but `getIntegrationStatus()` reports `integration_not_bound` forever.
- The Connect card the chat renders never resolves, the multi-card gate keeps the agent paused, and the user sees a dashboard stuck on "needs connection" no matter how many times they click Connect.

Skip this block only when the app is purely internal (no upstream calls).

```yaml
integrations:
  - key: <integration_key>          # local handle the app uses; usually same as provider_id
    provider: <provider_id>         # MUST be a Composio store catalog slug (see section above)
    capability: <api | messaging | files | ...>
    required: true                  # block startup if not bound
    credential_source: platform     # always; uses Composio via runtime broker
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
      timeout_ms: 120000   # vibe-coded apps cold-start slowly: first npm install + first build + boot easily blow past 30s; 120s is the runtime default for the same reason
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

### Propose connect for every required integration BEFORE declaring the app done

The single biggest failure mode in vibe-coded apps is **shipping a non-functional app and rationalizing it as "safe mode" / "access not available yet" instead of asking the user to connect**. That rationalization is wrong every time. Read this carefully.

**The required loop:**

1. App declares `integrations: [...]` in `app.runtime.yaml` for every provider it uses. (See section 4 below — this is mandatory whenever the app calls any provider; the alternative is not "skip the declaration", it is "you do not need this provider in your app".)
2. `workspace_apps_register` / `workspace_apps_ensure_running` returns a `pending_integrations` array listing every declared provider that does not yet have an active connection.
3. For **each** entry in `pending_integrations`, you call `holaboss_workspace_integrations_propose_connect({ toolkit_slug })`. One card per provider. Same turn is fine.
4. You stop. The runtime emits a `waiting_on_pending_integrations` event, parks your next input, and re-dispatches it the moment all required connections land as `active`. You do not poll, do not retry, do not chain "let me also call gmail_get_profile to verify" — that hits 401 noise.
5. When the system re-dispatches you, every required provider is connected, the dashboard's `getIntegrationStatus()` will return `ready: true`, and the app actually works.

**The trap you must NOT fall into:**

- Do not catch a 401 / `integration_not_connected` from an MCP tool and conclude "this API is not available" or "Composio doesn't expose this". That error means **the user hasn't connected yet**, NOT that the action is missing. Propose connect and try again after the user authorizes.
- Do not skip declaring `integrations` in the manifest because "then the gate will pause my turn". The gate IS the contract — being paused is the correct outcome when the user needs to do an OAuth step. Skipping the declaration to dodge the gate is shipping a broken app.
- Do not invent "safe mode", "manual mode", "logging-only mode", "preview mode", or any other phrase that means "the app I just shipped doesn't actually work". Those are agent rationalizations of the same underlying bug: you did not propose_connect when you should have.
- Do not double-propose the same toolkit "in case the first one didn't take" — the gate de-dupes by slug.

**Concrete heuristic:** if your final message would contain any of "isn't available yet", "doesn't expose", "safe mode", "manual mode", "logging-only", "no real recipient", or "shows blockers instead of pretending to send" — stop, go back to step 3, and propose_connect the missing providers. Then re-evaluate.

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

1. `sdk-package/README.txt` — top-level overview bundled for packaged runtimes
2. `sdk-package/src/index.ts` — public surface
3. `sdk-package/src/types.ts` — full type contract, including `RowOf` and the integer-id stringify note
4. `sdk-package/src/app.ts` — derived tool naming, primitive wiring, and registration behavior

### For the backend shape (both integration-only and dashboard apps need this)

5. `reference/<shape>/app.ts` — copy + adapt; pick the shape that matches the user's request (messaging / publishing / workflow / event-with-time)
6. `reference/slack-messaging/server.ts` + `reference/slack-messaging/app.runtime.yaml` — copy + adapt; this is the only bundled reference that ships a complete `server.ts`

### For dashboard apps (additionally)

7. `@holaboss/ui` on npmjs.com — public package with the full primitive catalog (~55 base-ui shadcn components incl. Chart family, Sidebar, Dialog/Sheet/Drawer, Table, Form, Calendar, Carousel, Sonner). Install via `bun add @holaboss/ui` and mount the bundled styles via a single `import "@holaboss/ui/styles.css"` at the dashboard root. No DashboardShell/DataTable/StatPill layouts — compose from primitives.
8. _(no dashboard reference)_ — dashboards compose freely from `@holaboss/ui` primitives. The `interface-design` skill chained above is the only authority on shape.
9. Compare against the current live desktop panes if available, but do not leave the workspace or guess repo-root source paths just to locate pane source files.
