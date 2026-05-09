---
name: app-builder
description: Build or modify holaOS apps following the current app contract, including UI, MCP, shared data, integrations, outputs, and verification.
---

# App Builder

Use this skill when the user wants a new holaOS app or asks to modify an existing holaOS app.

This includes requests for dashboards, trackers, analytics surfaces, CSV visualizers, CRMs, internal tools, integration-backed apps, and automations. Build an app for those requests rather than switching to a separate dashboard-only authoring model.

## Build Target
1. Apps are the only build target.
2. This embedded skill is guidance only. Do not write new guidance into `runtime/harnesses/src/embedded-skills/` when fulfilling the user's app request; write or update the target workspace app instead.
3. Peer apps are useful for local conventions only: naming, route structure, table prefixes, MCP tool naming, metadata shape, and UI idioms.
4. When a request is clearly about an existing app, prefer modifying that app. Otherwise create a new app.

## Core Rules
1. Start from the minimum valid holaOS app contract.
2. Prefer the smallest useful first version.
3. Add only the capabilities the request actually needs.
4. Prefer existing sources of truth over creating new ones.
5. Never hardcode ports, workspace ids, or provider tokens.
6. Do not stop at scaffold creation; verify the app is healthy.

## Minimum App Contract
The app is only a real holaOS app when all of these are true:
- it exists under `apps/<app_id>/`
- it has `app.runtime.yaml`
- it is registered in `workspace.yaml`

Default required shape:

```text
<workspace-root>/
  workspace.yaml
  apps/
    <app_id>/
      app.runtime.yaml
      package.json
      tsconfig.json
      src/
        server.ts
```

Every runtime-managed app must:
- serve `GET /` on `$PORT`
- serve MCP health on `$MCP_PORT`
- keep explicit MCP config in `app.runtime.yaml`
- keep `app.runtime.yaml app_id` exactly aligned with the `workspace.yaml` registration
- choose exactly one start mode rather than leaving launch behavior ambiguous

Even UI-only apps still need MCP transport wiring and MCP health.

## Baseline Manifest
Use this as the default starting point and customize only what the request needs:

```yaml
app_id: my_app
name: My App
slug: my-app

lifecycle:
  setup: npm install
  start: npm run start

healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 5

mcp:
  transport: http-sse
  port: 13100
  path: /mcp/sse
  tools: []

env_contract:
  - HOLABOSS_WORKSPACE_ID
```

Manifest rules:
- `mcp.port` is required
- `mcp.path` should be explicit
- `healthchecks.mcp.path` should be explicit
- use `integrations` for provider requirements
- add `WORKSPACE_DB_PATH` to `env_contract` when shared workspace data is required

## Default Stack
If the user did not ask for a specific stack, default to:
- TypeScript
- Node.js
- Express
- one runtime-managed Node process
- simple HTML first
- React or a richer frontend only when justified

Typical dependencies:
- `@modelcontextprotocol/sdk`
- `express`
- `zod`
- `typescript`
- `tsx`
- `@holaboss/bridge` and `better-sqlite3` when shared workspace data access is needed

## Workflow
1. Determine the minimum useful first version of the app.
2. Identify the data source or sources the app should use:
   - installed app tables
   - local files
   - app-owned tables
   - a mixed-source combination
3. Check whether the app needs each of these capabilities:
   - local UI surface
   - MCP tools for agent use
   - shared workspace data access
   - app-owned data writes
   - brokered integrations
   - outputs or deep links
   - background jobs or polling
4. Inspect peer apps if local conventions would help.
5. Verify dependency readiness before coding:
   - if reading another app's data, verify that app is installed, healthy, and has the expected tables
   - if reading local files, verify the files exist and the format is usable
   - if a required source is missing, fail clearly or ask for the missing prerequisite
6. Create the minimum valid app skeleton.
7. Add only the capabilities required for the request.
8. Register or install the app.
9. Verify health, MCP behavior, data access, integrations, and outputs as applicable.
10. If setup, start, manifest, or health checks fail, fix the app before stopping.

## Capability Guidance

### UI Surface
- If the app needs a user-facing interface, serve `/` on `$PORT`.
- Keep the first version simple until the runtime contract is healthy.
- Prefer a simple HTML or light server-rendered surface first unless a richer frontend is clearly justified.

### MCP Surface
- Keep MCP transport and MCP health routes even when the app is mostly UI.
- If the app exposes agent-callable behavior:
  - declare raw tool names in `mcp.tools`
  - implement matching MCP behavior on the app's MCP server
  - keep tools narrow, composable, and machine-readable
- If the app does not need agent-callable tools:
  - keep the MCP transport routes
  - keep the MCP health route
  - remove placeholder tools

Minimum MCP contract:
- expose `GET /mcp/health`
- expose `GET /mcp/sse`
- expose `POST /mcp/messages`
- read `process.env.MCP_PORT`

### Shared Data
- Use `WORKSPACE_DB_PATH` for shared workspace data access when needed.
- Add `WORKSPACE_DB_PATH` to `env_contract` when shared workspace data access is required.
- Use `getWorkspaceDb()` from `@holaboss/bridge` when possible.
- Treat other apps' tables as read-only.
- Use your own app prefix for writes.
- Prefer the shared workspace DB model over inventing a separate root-level app DB contract.
- Do not duplicate another app's source-of-truth data unless the duplication is intentional and justified.
- Fail clearly if required tables are missing.

### Data Source Strategy
- Prefer existing sources of truth before creating new ones.
- If an installed app already owns the needed data, read its tables instead of declaring a second integration or copying its rows.
- If the request is file-based, use the local file directly when that is sufficient.
- If the app needs durable interactive behavior over a file source, import or normalize the file into app-owned tables.
- Use app-owned tables for:
  - imported normalized data
  - app-specific state
  - annotations
  - saved views or preferences
  - clearly intentional derived caches
- For mixed-source apps, keep the ownership boundary clear: foreign app tables stay read-only, local files are imported only when needed, and app-owned tables hold only the app's own durable state.

### Integrations
- If provider access is needed, declare `integrations` in `app.runtime.yaml`.
- Do not assume raw provider tokens in environment variables.
- Use brokered or platform-managed integration behavior.

Example:

```yaml
integrations:
  - key: primary_google
    provider: google
    capability: gmail
    scopes:
      - https://www.googleapis.com/auth/gmail.modify
    required: true
    credential_source: platform
    holaboss_user_id_required: true
```

### Outputs
- Use outputs only when app results should be visible outside the app's own surface.
- Add deep links or output metadata only when the user request needs cross-app visibility or reopen behavior.

### Background Work
- Add polling, scheduling, or long-lived background behavior only when it is core to the request.
- Do not introduce background complexity into the first version unless the app is fundamentally an automation app.

## Common Recipe: Dashboard-Like App Over Existing Data Sources
- Create an app, not a standalone dashboard artifact.
- Start with a minimal UI that proves the app contract and shows the first useful data view.
- If an installed app already owns the needed data, read its shared tables first.
- If the request is based on a local file, read or import that file before adding extra infrastructure.
- If the request combines sources, keep the source-of-truth boundaries clear and avoid copying foreign app data into new tables unless intentional.
- Do not add a new provider integration when an installed app already owns the data.
- Do not add MCP tools unless the request actually needs agent-callable app actions.
- Add app-owned tables only when the app needs durable state such as saved filters, annotations, imported normalized data, or preferences.

## Verification Checklist
- `app.runtime.yaml` exists and parses cleanly
- `workspace.yaml` registration exists and matches `app_id`
- the app serves `/` on `$PORT` when a UI surface is expected
- `GET /mcp/health` works on `$MCP_PORT`
- MCP transport routes are exposed correctly
- declared MCP tools reconcile and behave correctly when used
- dependency apps are healthy when the app reads their data
- expected foreign tables exist when the app reads installed app data
- expected local files exist and are readable when the app depends on them
- shared DB access follows `WORKSPACE_DB_PATH` rules when needed
- foreign app tables are treated as read-only
- app-owned tables use the app's own prefix when the app writes durable state
- mixed-source behavior is correct when the app combines installed app data and local files
- declared integrations work through the platform bridge when needed
- outputs and deep links reopen correctly when used
- the app reaches a healthy or ready state

## Common Failure Modes
- files created but app not registered
- invalid `app.runtime.yaml`
- hardcoded `PORT` or `MCP_PORT`
- missing MCP health route
- `mcp.tools` declared but not implemented
- shared DB usage added without the right env contract
- reading another app's data without verifying the app or tables exist
- duplicating another app's source data instead of reusing it
- importing file data into durable tables when direct file use would have been enough
- integrations expected without manifest declaration
- frontend complexity added before basic runtime health works

## Build Discipline
- Get the base app healthy first.
- Then add UI, MCP tools, shared data logic, integrations, outputs, and background behavior incrementally.
- Prefer the smallest useful working app over a broad but unhealthy scaffold.
