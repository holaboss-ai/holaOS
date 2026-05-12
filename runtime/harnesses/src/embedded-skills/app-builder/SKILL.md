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

## Deterministic Workspace Tools
When these runtime tools are surfaced for the current run, prefer them over hand-written platform glue:
- `workspace_apps_find` to check the marketplace/local catalog before deciding to build a new app
- `workspace_apps_install` when the catalog already contains the app the user wants
- `workspace_apps_scaffold` for the minimum valid app skeleton
- `workspace_apps_register` for `workspace.yaml` registration
- `workspace_apps_build` for deterministic `package.json` build verification instead of ad hoc shell
- `workspace_apps_ensure_running` to hand the app to the managed runtime
- `workspace_apps_restart` after changing files for an already-running app
- `workspace_apps_restart_and_wait_ready` when you want one managed restart + readiness step
- `workspace_apps_wait_until_ready` to verify runtime truth instead of a preview tab
- `workspace_apps_get_status` as the primary managed app inspection tool because it includes readiness, ports, runtime contract, and revision hints
- `workspace_apps_get_ports` only when a legacy caller needs ports alone
- `workspace_apps_probe_endpoints` for deterministic managed UI/MCP endpoint checks instead of raw `curl`
- `workspace_data_list_tables`, `workspace_data_describe_table`, and `workspace_data_sample_rows` for shared data discovery
- `workspace_data_query` for deterministic read-only joins, aggregations, and mixed-source previews against shared workspace data

These tools are for workspace-contract operations. Keep app-specific UI, workflows, and domain logic model-driven.
If `workspace_apps_find` returns an exact or clearly suitable app for the user's request, prefer `workspace_apps_install` over scaffolding a new app. Only build a new app when no suitable catalog app exists, the install route is blocked, or the user explicitly asked for a custom app.

## Build/Update Lifecycle
Follow this sequence for both new apps and updates to existing apps:
1. Inspect workspace context, existing apps, data sources, and any required local files.
2. If `workspace_apps_find` is surfaced and the request could match an existing workspace app, query the catalog before deciding to build.
3. Decide whether to modify an existing app, install an existing catalog app, or create a new one.
4. If an exact or clearly suitable catalog app exists, install it and stop the build path unless the user explicitly asked for a custom app.
5. Otherwise scaffold the minimum valid app shape or edit the existing app files.
6. Add only the capabilities the request actually needs.
7. Register the app or update its workspace registration.
8. Run `workspace_apps_build` when a deterministic build script exists instead of relying on ad hoc shell output.
9. If the app was already running, prefer `workspace_apps_restart_and_wait_ready`; otherwise ensure the managed runtime is running it.
10. Wait until runtime truth reports the app as `ready: true` if you did not already use the compound restart-and-wait tool.
11. Verify the managed UI, MCP, data access, integrations, and outputs that the request depends on. Prefer `workspace_apps_probe_endpoints` for UI/MCP contract checks.
12. Only then report that the app is installed, updated, or working.

Do not treat file creation, `npm install`, or a standalone browser preview as completion.

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

## Workspace Context First
This is not generic app generation. Build against the active holaOS workspace.

Before writing code, inspect the workspace context that already exists:
- `workspace.yaml`
- `AGENTS.md` if present
- peer apps under `apps/`
- the user's local files if the request depends on them
- installed app data sources when the app should read existing tables
- existing outputs, routes, or naming conventions when relevant

Prefer reusing workspace conventions and sources of truth over inventing a standalone mini-project shape.

## Canonical System Snippets
Prefer adapting these snippets over inventing holaOS runtime glue from scratch. Keep imports, env names, manifest fields, and route shapes aligned with these examples unless the workspace already uses a better local convention.

### Minimal `package.json`

```json
{
  "name": "my-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "tsx src/server.ts",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^24.0.1",
    "tsx": "^4.19.3",
    "typescript": "^5.8.3"
  }
}
```

### Minimal `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### Minimal Runtime-Managed `src/server.ts`

Use this when the app needs a simple UI surface and no complex framework. This is the preferred starting point for dashboards, trackers, and import visualizers.

```ts
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";

const appId = "my-app";
const uiPort = Number(process.env.PORT || 3000);
const mcpPort = Number(process.env.MCP_PORT || 13100);

function jsonRpcSuccess(id: unknown, result: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const uiApp = express();
uiApp.get("/", (_req, res) => {
  res.status(200).type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My App</title>
      </head>
      <body>
        <main>
          <h1>My App</h1>
          <p>Replace this placeholder with the first useful UI.</p>
        </main>
      </body>
    </html>
  `);
});

const mcpApp = express();
mcpApp.use(express.json({ limit: "1mb" }));

mcpApp.get("/mcp/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    app_id: appId,
    transport: "http-sse",
    sse_path: "/mcp/sse",
    message_path: "/mcp/messages",
  });
});

mcpApp.get("/mcp/sse", (req: Request, res: Response) => {
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write(
    `event: endpoint\ndata: ${JSON.stringify({ sessionId, messagePath: "/mcp/messages" })}\n\n`,
  );
  res.write(`event: ready\ndata: ${JSON.stringify({ appId })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    res.end();
  });
});

mcpApp.post("/mcp/messages", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = isRecord(body.params) ? body.params : {};

  if (!method) {
    res.status(400).json(jsonRpcError(id, -32600, "Invalid Request"));
    return;
  }

  if (method === "initialize") {
    const protocolVersion =
      typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
    res.status(200).json(
      jsonRpcSuccess(id, {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: appId,
          version: "0.1.0",
        },
      }),
    );
    return;
  }

  if (method === "tools/list") {
    res.status(200).json(jsonRpcSuccess(id, { tools: [] }));
    return;
  }

  if (method === "resources/list") {
    res.status(200).json(jsonRpcSuccess(id, { resources: [] }));
    return;
  }

  if (method === "prompts/list") {
    res.status(200).json(jsonRpcSuccess(id, { prompts: [] }));
    return;
  }

  if (method === "ping") {
    res.status(200).json(jsonRpcSuccess(id, {}));
    return;
  }

  if (method.startsWith("notifications/")) {
    res.status(202).json({ ok: true });
    return;
  }

  res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${method}`));
});

const uiServer = uiApp.listen(uiPort, () => {
  const address = uiServer.address() as AddressInfo;
  console.log(`[${appId}] UI listening on http://127.0.0.1:${address.port}`);
});

const mcpServer = mcpApp.listen(mcpPort, () => {
  const address = mcpServer.address() as AddressInfo;
  console.log(`[${appId}] MCP listening on http://127.0.0.1:${address.port}`);
});

function shutdown(signal: string) {
  console.log(`[${appId}] Received ${signal}, shutting down.`);
  uiServer.close(() => undefined);
  mcpServer.close(() => undefined);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
```

### Shared Workspace DB Read Pattern

Use this when the app should read shared workspace data. Add `WORKSPACE_DB_PATH` to `env_contract` and install `@holaboss/bridge` plus `better-sqlite3`.

```ts
import { getWorkspaceDb } from "@holaboss/bridge";

const db = getWorkspaceDb();

export function listRecentTwitterPosts(limit = 25) {
  return db
    .prepare(
      `
        SELECT id, text, created_at
        FROM twitter_posts
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as Array<{
      id: string;
      text: string;
      created_at: string;
    }>;
}
```

Rules:
- foreign app tables are read-only
- do not copy another app's rows into new tables unless there is a clear reason
- verify the foreign table exists before claiming the app works

### App-Owned Table Pattern

Use this when the app needs durable state such as saved filters, annotations, imports, or preferences.

```ts
import { getWorkspaceDb } from "@holaboss/bridge";

const db = getWorkspaceDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS my_app_saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

export function saveView(id: string, name: string, configJson: string) {
  db.prepare(
    `
      INSERT INTO my_app_saved_views (id, name, config_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        config_json = excluded.config_json
    `,
  ).run(id, name, configJson);
}
```

Rules:
- use the app's own prefix for durable tables
- app-owned tables may store imports, annotations, settings, and derived state
- foreign app tables remain read-only

### Integration Manifest Pattern

Use this when the app needs provider access through holaOS-managed integrations.

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

Use the bridge client instead of expecting raw provider tokens:

```ts
import { createIntegrationClient } from "@holaboss/bridge";

const gmail = createIntegrationClient("google");

const response = await gmail.proxy({
  method: "POST",
  endpoint: "/gmail/v1/users/me/messages/send",
  body: {
    raw: encodedMessage,
  },
});
```

Rules:
- do not expect provider tokens directly in env
- use integrations only when existing installed app data is not already sufficient
- keep integration declarations explicit in `app.runtime.yaml`
- after `workspace_apps_ensure_running` succeeds, the runtime reads each declared `integrations:` entry with `required: true` and surfaces a Connect button next to your reply for any provider the user has not yet authorized — you do NOT need to call any extra tool. Just tell the user the app is ready and let them click Connect.

### Durable Output Pattern

Use this when the app should publish durable workspace records outside the app surface.

```ts
import { createAppOutput, updateAppOutput } from "@holaboss/bridge";

const output = await createAppOutput({
  outputType: "draft_post",
  title: draft.title,
  moduleId: "twitter",
  moduleResourceId: draft.id,
  status: "queued",
  metadata: {
    view: "drafts",
  },
});

if (output) {
  await updateAppOutput(output.id, {
    status: "published",
    moduleResourceId: published.id,
  });
}
```

Rules:
- use outputs only when the result should live outside the app UI
- avoid duplicate outputs for the same resource
- prefer app-local UI state when the result does not need workspace-level visibility

### Managed Runtime Verification Pattern

Never stop at `npm install`, file creation, or a browser preview.

The managed app is only actually ready when:
- `workspace.yaml` includes the app registration
- the workspace runtime has started the app
- the installed app list reports `ready: true`
- the UI route works on the runtime-managed app port
- `GET /mcp/health` works on the runtime-managed MCP port

When a runtime control path is available, the preferred sequence is:

```text
1. Register or install the app.
2. If you modified an already-running app, stop it first through the workspace runtime.
3. Ask the workspace runtime to ensure apps are running.
4. Re-read the installed app list for the workspace.
5. Confirm the app reports ready: true.
6. Verify the managed app surface or runtime-managed app port, not only a standalone preview.
7. Only then say the app is installed and working.
```

If a direct runtime control path is not available in the current environment, be explicit about the limitation. Do not claim the app is fully installed and ready if you only verified a standalone preview server.

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
9. If you changed an app that was already installed or already running, restart the managed app through the workspace runtime so the active process actually picks up the new code.
10. Ensure the workspace runtime has actually started the app after registration, install, or restart. Do not stop at file creation or a standalone browser preview.
11. Verify health, MCP behavior, data access, integrations, and outputs as applicable.
12. If setup, start, manifest, runtime activation, restart, or health checks fail, fix the app before stopping.

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
- the workspace runtime has picked up the registration and started the app
- the installed app list reports the app as `ready: true`
- if an existing app was modified, the managed app process was restarted before verification
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
- app files created and browser preview works, but the workspace runtime never starts the managed app
- an existing managed app was modified, but the old process kept serving stale code because it was never restarted
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
