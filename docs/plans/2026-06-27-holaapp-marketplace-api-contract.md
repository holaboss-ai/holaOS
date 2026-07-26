# HolaApp Marketplace & Install — API Contract

**Date**: 2026-06-27
**Status**: Draft (contract to agree before either side builds)
**Owners**: Backend (the closed-source backend / holaapp-backend) ⇄ Desktop (holaOS)
**Related**: `docs/plans/2026-06-27-holaapp-bundles-prd.md`

This is the agreed wire contract between the **desktop client** and the **server**
for: browsing available HolaApps, installing/uninstalling them, and provisioning each
app's MCP + skills. It is the seam that lets the two repos build independently.

## Principles

1. **Server is the source of truth.** The catalog, per-user install state, and each
   app's MCP + skill definitions all live server-side. The desktop hardcodes nothing.
2. **The desktop is a thin applier.** Because the agent runs in the **local** desktop
   sandbox runtime (it reads `workspace.yaml` + local `skills/`), the desktop applies
   the server-provided provisioning to the local runtime. It does not invent it.
3. **MCP + skills are never surfaced.** The marketplace shows an *app*. The user sees
   "installed" and "my agent can use it" — never a tool list or a skill.
4. **Evolution, not greenfield.** `GET /api/v1/apps` already exists (returns a thin
   list the desktop renders). This extends that surface; it does not replace it.

## v1 scope (decided)

To ship a concrete first cut, v1 is deliberately narrow. A v1 server returns
**hosted + MCP + session** only:

- **Hosted surfaces only** — `surface.type: "hosted"` (need-review, gofunds). `"local"`
  (app-builder apps) and `"none"` (integration-only) are deferred.
- **MCP-only provisioning** — install provisions MCP servers; `provisioning.skills` is
  always `[]` in v1. Skill delivery is fully specified below for forward-compatibility,
  but is gated on the personalization learns-vs-configures fork (PRD Open Q #7).
- **Session auth** — MCP servers use `auth: { mode: "session" }` (the desktop's existing
  Better-Auth bearer injection). Server-minted scoped tokens are deferred.

The richer shapes (skills, local surface, token auth) are kept in the types so the
contract is forward-compatible and clients can be lenient — they just aren't exercised
in v1.

## Current state (what exists today)

- `GET /api/v1/apps` → `{ apps: [{ holaAppId, title, iconUrl?, url? }] }` — consumed by
  `apps/desktop/src/lib/webHolaApps.ts`. Every returned app is shown in the launcher;
  there is **no install concept**.
- The desktop **hardcodes** each app's MCP tools (`WEB_HOLAAPP_MCP_TOOLS` in `main.ts`)
  and constructs the MCP URL from a per-env base, then writes a remote server entry +
  tool allowlist into `workspace.yaml` (`attachWebHolaAppMcp`). **This contract removes
  that hardcoding** — the tool list + URL come from the server.

## Data model

```ts
// A marketplace card. Thin — NO mcp/skills here (not surfaced, not needed to render).
interface AppCatalogEntry {
  holaAppId: string;            // stable id, e.g. "need-review"
  title: string;
  description?: string;
  iconUrl?: string;
  category?: string;            // for marketplace grouping
  version: string;              // current published bundle version
  installed: boolean;           // install state for the authenticated user
  surface: AppSurface;          // how the launcher opens it once installed
}

type AppSurface =
  | { type: "hosted"; path?: string; url?: string }  // v1. web pane; url = absolute 3rd-party
  | { type: "local"; port: number }                  // DEFERRED. app-builder app on a local port
  | { type: "none" };                                // DEFERRED. integration-only, no pane

// The provisioning the desktop must APPLY to the local runtime on install.
interface AppProvisioning {
  mcp: McpServerSpec[];         // [] if the app has no tools
  skills: SkillDelivery[];      // v1: ALWAYS [] (skill delivery deferred — see v1 scope)
}

interface McpServerSpec {
  id: string;                   // server id in workspace.yaml, e.g. "need-review"
  transport: "http";            // hosted streamable-HTTP MCP
  url: string;                  // ABSOLUTE — server resolves its own env (prod/staging)
  auth: { mode: "session" }     // v1. desktop injects its Better-Auth bearer
       | { mode: "token"; token: string };  // DEFERRED. server-minted scoped token
  tools: string[];              // the allowlist — server-sourced (kills WEB_HOLAAPP_MCP_TOOLS)
  timeoutMs?: number;
}

interface SkillDelivery {
  id: string;                   // skill id, becomes skills/<id>/ locally
  version: string;              // seed version → the merge-base for future updates
  source:
    | { type: "inline"; files: { path: string; content: string }[] }
    | { type: "url"; url: string };   // desktop fetches + unpacks
}
```

## Endpoints

### 1. List the catalog — `GET /api/v1/apps`
Returns every available app **plus this user's install state**. Replaces the current
thin list (adds `installed`, `description`, `category`, `version`, `surface`).

```jsonc
// 200
{ "apps": [
  { "holaAppId": "need-review", "title": "Need Review", "version": "0.1.0",
    "installed": true,  "surface": { "type": "hosted", "path": "/apps/need-review" } },
  { "holaAppId": "gofunds", "title": "GoFunds", "version": "0.3.1",
    "installed": false, "surface": { "type": "hosted", "path": "/apps/gofunds" } }
]}
```
- **Launcher (left column)** renders only `installed: true`.
- **Marketplace** renders the full list with an Install/Uninstall affordance per card.

### 2. Install — `POST /api/v1/apps/{holaAppId}/install`
Server records install state for the user, provisions/authorizes the app, and returns
the provisioning the desktop applies locally.

```jsonc
// 200
{ "holaAppId": "need-review", "installed": true,
  "provisioning": {
    "mcp": [
      { "id": "need-review", "transport": "http",
        "url": "https://api.holaos.ai/mcp/need-review/mcp",
        "auth": { "mode": "session" },
        "tools": ["list_records","get_record","approve_record", "..."] }
    ],
    "skills": []          // need-review has no seed skill in v1
  }
}
```
- Idempotent: installing an already-installed app returns the same body (no dup).
- `409`/`needs_connection` (future): if the app declares a required integration not yet
  connected, return the provider to connect before install completes.

### 3. Uninstall — `POST /api/v1/apps/{holaAppId}/uninstall`
```jsonc
// 200
{ "holaAppId": "need-review", "installed": false }
```
Desktop reverses its local apply (remove the MCP server from `workspace.yaml`, remove
the launcher entry, archive/remove the local skill copy).

### 4. Installed provisioning (re-sync) — `GET /api/v1/apps/installed`
The desktop must **re-apply** MCP on every runtime start (today `ensureWebHolaAppMcpAttached`
re-attaches per chat turn). This returns the installed apps **with** their current
provisioning so the desktop can re-apply from server truth — not a cached/hardcoded list.

```jsonc
// 200
{ "apps": [
  { "holaAppId": "need-review", "version": "0.1.0",
    "provisioning": { "mcp": [ /* … */ ], "skills": [ /* … */ ] } }
]}
```

## Desktop responsibilities (the local apply)

| Server says | Desktop does (local) |
|---|---|
| `install` → `provisioning.mcp[]` | write each as a remote server in `workspace.yaml` `mcp_registry.servers` + add `tools` to `allowlist.tool_ids` (this is today's `attachWebHolaAppMcp`, now fed by server data) |
| `auth: { mode: "session" }` | inject the desktop's Better-Auth bearer into the server entry's `headers` |
| `provisioning.skills[]` | write each into local `skills/<id>/`; record `version` as the **merge-base** for personalization (PRD §6) |
| `installed: true` | add to the launcher (left column) |
| `uninstall` | reverse all of the above |
| runtime start / pre-turn | call `GET /api/v1/apps/installed` and re-apply (replaces the hardcoded loop) |

## What this removes

- `WEB_HOLAAPP_MCP_TOOLS` (hardcoded tool lists) → `provisioning.mcp[].tools`.
- Desktop-side MCP **URL construction** from a per-env base → server returns absolute `url`.
- "Every listed app is shown" → only `installed` apps in the launcher.

## Auth & security

- All calls go through the **gateway** with the user's Better-Auth session (the gateway
  injects `x-holaboss-user-id`); install state is **per user**.
- MCP endpoints are auth-exempt at the edge (`/mcp/*`) and do their own bearer auth — the
  `auth.mode: "session"` bearer is the desktop's session token, as today.
- Installing grants the agent new tools. v1 = first-party apps, implicit trust (PRD
  Non-Goal #5 + Open Q #1). A consent surface is deferred.

## Versioning & compatibility

- `version` per app enables the personalization **3-way merge** on update (PRD §6): the
  desktop compares the installed seed version to the catalog version.
- Back-compat: the current thin `GET /api/v1/apps` fields (`holaAppId`, `title`,
  `iconUrl`, `url`) are preserved; new fields are additive. The desktop's existing
  fallback list keeps working until the server returns the richer shape.

## Open questions

**Decided for v1** (see *v1 scope*): MCP auth = `session`; skill delivery = deferred
(`skills: []`); surfaces = hosted-only; **re-sync = poll** — the desktop calls
`GET /api/v1/apps/installed` on runtime start and before each turn (reusing the existing
`ensureWebHolaAppMcpAttached` re-apply hook); no server→desktop push in v1.

Still open:

| # | Question | Bearing | When it matters |
|---|---|---|---|
| 5 | **Uninstall of shared skills**: ref-count if two apps deliver the same skill id? | PRD Open Q #4 | when skills ship (post-v1) |

Deferred-but-pre-decided (revisit when the feature lands): server-minted scoped MCP
tokens (vs session); skill delivery shape + learns-vs-configures (PRD Open Q #7);
local-surface app lifecycle.
