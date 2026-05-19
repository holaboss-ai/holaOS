// MCP server boot — exposes SDK app's derived tools as a real MCP server
// over HTTP/SSE (matches the convention used by all hola-boss-apps modules).
//
// Pattern follows _template/src/server/mcp.ts:
//   GET  /mcp/health    → { status: "ok" }
//   GET  /mcp/sse       → establishes SSE transport (one per agent session)
//   POST /mcp/messages  → routes JSON-RPC messages to the right SSE transport
//
// Tools registered automatically from the app:
//   - <app>_create_<resource>           creates a row in initialState
//   - <app>_list_<resource>s            lists rows of that resource
//   - <app>_get_<resource>              fetches one by id
//   - <app>_<action>_<resource>         invokes a registered action
//   - <app>_cancel_<action>_<resource>  invokes a reversible action's reverse
//   - <app>_connection_status           probes provider whoami via bridge
//   - <app>_refresh_<plural>            (for resources with refreshEvery+fetch)
//   - <app>_<sync>_sync_status          reads last sync run from audit
//   - <app>_snapshot                    compact situational read

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer, type Server as HttpServer } from "node:http"
import { z, type ZodObject, type ZodRawShape } from "zod"
import type { AppHandleInternal } from "../app.ts"
import type { BridgeClient } from "../types.ts"

export interface StartMcpServerOpts {
  app: AppHandleInternal
  /** Port to listen on. Use 0 for an OS-assigned port (returned via `port`). */
  port: number
  /** Bridge used when actions/syncs need to call upstream. Production should
   *  pass a runtime-broker transport; tests can pass a mock transport. */
  bridge: BridgeClient
  /** Optional MCP server display name. Defaults to `<app.id> Module`. */
  serverName?: string
  /** Optional MCP server version. */
  serverVersion?: string
  /** Optional web-surface port. Holaboss desktop renders an iframe at this URL
   *  for hola-boss-apps-style modules. SDK apps are headless, but the desktop
   *  still tries to load the URL — this option binds a tiny HTTP server that
   *  serves a placeholder page so the iframe gets a 200 instead of
   *  ERR_CONNECTION_REFUSED. Wire from `process.env.PORT` in production. */
  httpPort?: number
}

export interface StartedMcpServer {
  /** Actual port the MCP server is listening on (resolved after 0 → OS-assigned). */
  port: number
  /** Actual port the web-surface stub is listening on (if httpPort was set). */
  httpPort?: number
  /** Stop both servers gracefully. */
  close: () => Promise<void>
}

export async function startMcpServer(opts: StartMcpServerOpts): Promise<StartedMcpServer> {
  const { app, bridge } = opts
  const serverName = opts.serverName ?? `${app.config.id} Module`
  const serverVersion = opts.serverVersion ?? "1.0.0"

  // Per-session transports (MCP allows multiple concurrent SSE clients).
  const transports = new Map<string, SSEServerTransport>()

  function buildServer(): McpServer {
    const server = new McpServer({ name: serverName, version: serverVersion })
    registerTools(server, app, bridge)
    return server
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`)

    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", app_id: app.config.id }))
      return
    }

    if (url.pathname === "/mcp/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/mcp/messages", res)
      transports.set(transport.sessionId, transport)
      const server = buildServer()
      await server.connect(transport)
      return
    }

    if (url.pathname === "/mcp/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId")
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400)
        res.end("Unknown session")
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve) => httpServer.listen(opts.port, () => resolve()))
  const addr = httpServer.address()
  const actualPort = typeof addr === "object" && addr ? addr.port : opts.port

  let webStub: HttpServer | undefined
  let actualHttpPort: number | undefined
  if (opts.httpPort !== undefined) {
    webStub = createWebStub(app.config.id, actualPort)
    await new Promise<void>((resolve) => webStub!.listen(opts.httpPort, () => resolve()))
    const sAddr = webStub.address()
    actualHttpPort = typeof sAddr === "object" && sAddr ? sAddr.port : opts.httpPort
  }

  return {
    port: actualPort,
    httpPort: actualHttpPort,
    close: () => Promise.all([
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
      webStub
        ? new Promise<void>((resolve, reject) =>
            webStub!.close((err) => (err ? reject(err) : resolve())),
          )
        : Promise.resolve(),
    ]).then(() => undefined),
  }
}

// Headless-module placeholder for the desktop's iframe surface.
function createWebStub(appId: string, mcpPort: number): HttpServer {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(appId)} — headless module</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark }
    body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
           margin: 0; padding: 32px; max-width: 640px }
    h1 { font-size: 18px; margin: 0 0 8px; font-weight: 600 }
    p  { margin: 6px 0; opacity: .8 }
    code { font: 12px ui-monospace, SF Mono, Menlo, monospace;
           background: color-mix(in srgb, currentColor 8%, transparent);
           padding: 1px 6px; border-radius: 4px }
  </style>
</head>
<body>
  <h1>${escapeHtml(appId)}</h1>
  <p>This module was built with <code>@holaboss/app-builder-sdk</code> and is headless — it exposes only an MCP server, no web UI.</p>
  <p>Drive it from agent chat. The MCP server is on <code>:${mcpPort}/mcp/sse</code>.</p>
</body>
</html>`
  return createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", surface: "headless_stub", app_id: appId }))
      return
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

// ─── Tool registration ─────────────────────────────────────────────────────

function registerTools(mcp: McpServer, app: AppHandleInternal, bridge: BridgeClient): void {
  const appId = app.config.id

  // Connection — probe provider.whoamiPath via bridge.
  mcp.registerTool(
    `${appId}_connection_status`,
    {
      title: "Connection status",
      description: `Check whether ${appId} is connected and ready to call (probes the provider's whoami endpoint).`,
      inputSchema: {},
    },
    async () => textResult(await probeConnection(app, bridge)),
  )

  // Per-resource: create / list / get / (refresh if refreshEvery + fetch declared)
  for (const [resourceName, resource] of app._resources) {
    const inputShapeForCreate = extractShape(resource.schema)

    if (resource.def.refreshEvery && resource.def.fetch) {
      mcp.registerTool(
        `${appId}_refresh_${plural(resourceName)}`,
        {
          title: `Refresh ${resourceName} cache`,
          description: `Re-pull ${resourceName} list from upstream and upsert into local cache.`,
          inputSchema: {},
        },
        async () => textResult(await refreshResource(app, resource, bridge)),
      )
    }

    mcp.registerTool(
      `${appId}_create_${resourceName}`,
      {
        title: `Create ${resourceName} draft`,
        description: `Create a new ${resourceName} row in '${resource.def.initialState}' state. ` +
          `No upstream call yet — use an action tool to act on the row.`,
        inputSchema: inputShapeForCreate,
      },
      async (input) => {
        const row = app._state.insertRow(resourceName, input as Record<string, unknown>, resource.def.initialState)
        return textResult(rowAsView(row))
      },
    )

    mcp.registerTool(
      `${appId}_list_${plural(resourceName)}`,
      {
        title: `List ${resourceName} rows`,
        description: `List all ${resourceName} rows tracked by this app, with status and ids.`,
        inputSchema: {},
      },
      async () => {
        const rows = app._state.rowsByResource(resourceName).map(rowAsView)
        return textResult({ rows, count: rows.length })
      },
    )

    mcp.registerTool(
      `${appId}_get_${resourceName}`,
      {
        title: `Get ${resourceName} by id`,
        description: `Fetch a single ${resourceName} row by its id.`,
        inputSchema: { id: z.string() },
      },
      async (input) => {
        const row = app._state.getRow((input as { id: string }).id)
        if (!row) return errResult("not_found", `${resourceName} not found`)
        return textResult(rowAsView(row))
      },
    )
  }

  // Per-action: invoke + (if reversible) cancel
  for (const reg of app._actions) {
    const toolName = reg.def.toolName ?? `${appId}_${reg.name}_${reg.resource.name}`
    const rowIdKey = `${reg.resource.name}_id`

    // Action input shape: <resource>_id + (action.schema's fields if defined)
    const extraShape = extractShape(reg.def.schema)
    const inputShape: ZodRawShape = { [rowIdKey]: z.string(), ...extraShape }

    mcp.registerTool(
      toolName,
      {
        title: `${reg.name} ${reg.resource.name}`,
        description:
          `${reg.name} a ${reg.resource.name} ` +
          `(from ${reg.def.fromStates.join("|")} → ${reg.def.toState ?? "side-effect"})`,
        inputSchema: inputShape,
      },
      async (input) => {
        const i = input as Record<string, unknown>
        const rowId = i[rowIdKey] as string
        const actionInput: Record<string, unknown> = { ...i }
        delete actionInput[rowIdKey]
        const result = await app._invokeAction({
          actionName: reg.name, rowId, input: actionInput, bridge,
        })
        return "fail" in result
          ? errResult(result.fail.code, result.fail.message)
          : textResult(result)
      },
    )

    if (reg.def.reversible) {
      const reverseToolName = reg.def.toolName
        ? `${reg.def.toolName}_reverse`
        : `${appId}_cancel_${reg.name}_${reg.resource.name}`
      mcp.registerTool(
        reverseToolName,
        {
          title: `Cancel ${reg.name} ${reg.resource.name}`,
          description:
            `Reverse a ${reg.name} on a ${reg.resource.name} ` +
            `(brings row back to '${reg.def.reversible.toState}')`,
          inputSchema: { [rowIdKey]: z.string() },
        },
        async (input) => {
          const rowId = (input as Record<string, string>)[rowIdKey]
          const result = await app._invokeReverse({
            actionName: reg.name, rowId: rowId!, bridge,
          })
          return "fail" in result
            ? errResult(result.fail.code, result.fail.message)
            : textResult(result)
        },
      )
    }
  }

  // Snapshot
  mcp.registerTool(
    `${appId}_snapshot`,
    {
      title: `${appId} snapshot`,
      description: `Compact situational read of this app: row counts by status, recent failures, last sync time.`,
      inputSchema: {},
    },
    async () => textResult(buildSnapshot(app)),
  )

  // Sync status — read last sync.start/sync.end from audit + record count.
  for (const sync of app._syncs) {
    mcp.registerTool(
      `${appId}_${sync.name}_sync_status`,
      {
        title: `${sync.name} sync status`,
        description: `Last-run status of the ${sync.name} sync (started_at, outcome, fetched, upserted, error).`,
        inputSchema: {},
      },
      async () => textResult(readSyncStatus(app, sync.name)),
    )
  }
}

// ─── Tool handlers extracted for clarity / unit reuse ──────────────────────

async function probeConnection(app: AppHandleInternal, bridge: BridgeClient) {
  const appId = app.config.id
  const whoamiPath = app.config.provider.whoamiPath
  if (!whoamiPath) {
    return {
      app_id: appId,
      connected: null,
      reason: "no_probe_defined",
      message: `provider '${app.config.provider.id}' has no whoamiPath — connection cannot be verified`,
    }
  }
  const r = await bridge.call("GET", whoamiPath)
  if (r.kind === "ok") {
    return { app_id: appId, connected: true as const, identity: r.data }
  }
  return {
    app_id: appId,
    connected: false as const,
    reason: r.code,
    message: r.message,
    upstream_status: r.upstreamStatus,
    reauth_url: r.reauthUrl,
  }
}

async function refreshResource(
  app: AppHandleInternal,
  resource: { name: string; schema: unknown; def: { fetch?: (ctx: { bridge: BridgeClient }) => Promise<unknown[]>; initialState: string } },
  bridge: BridgeClient,
) {
  const fetchFn = resource.def.fetch
  if (!fetchFn) {
    return { ok: false, error: { code: "no_fetch_defined", message: `${resource.name} has refreshEvery but no fetch()` } }
  }
  let items: unknown[]
  try {
    items = await fetchFn({ bridge })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: { code: "fetch_threw", message: msg } }
  }
  const existing = app._state.rowsByResource(resource.name)
  const initialState = resource.def.initialState
  let inserted = 0
  let updated = 0
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue
    const data = raw as Record<string, unknown>
    const key = data.id !== undefined ? String(data.id) : null
    const match = key ? existing.find(r => String(r.data.id ?? "") === key) : undefined
    if (match) {
      app._state.updateRow(match.id, { data, status: initialState })
      updated++
    } else {
      app._state.insertRow(resource.name, data, initialState)
      inserted++
    }
  }
  return { ok: true, fetched: items.length, inserted, updated }
}

function readSyncStatus(app: AppHandleInternal, syncName: string) {
  const snap = app._state.snapshot()
  const matching = snap.audit.filter(e =>
    (e.event === "sync.start" || e.event === "sync.end") && e.fields.sync === syncName,
  )
  const lastStart = [...matching].reverse().find(e => e.event === "sync.start")
  const lastEnd = [...matching].reverse().find(e => e.event === "sync.end")
  const sync = app._syncs.find(s => s.name === syncName)
  const recordsTotal = snap.syncRecords.filter(r => r.syncName === syncName).length

  if (!lastEnd && !lastStart) {
    return {
      sync_name: syncName,
      schedule: sync?.def.schedule ?? null,
      has_ever_run: false,
      records_total: recordsTotal,
    }
  }
  const endFields = (lastEnd?.fields ?? {}) as Record<string, unknown>
  return {
    sync_name: syncName,
    schedule: sync?.def.schedule ?? null,
    has_ever_run: true,
    started_at: lastStart?.at,
    ended_at: lastEnd?.at,
    outcome: endFields.outcome ?? null,
    fetched: endFields.fetched ?? null,
    upserted: endFields.upserted ?? null,
    total_ms: endFields.total_ms ?? null,
    error: endFields.error ?? null,
    records_total: recordsTotal,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractShape(schema: unknown): ZodRawShape {
  if (schema && typeof schema === "object" && "shape" in schema) {
    return (schema as ZodObject<ZodRawShape>).shape
  }
  return {}
}

function plural(name: string): string {
  if (name.endsWith("s") || name.endsWith("x") || name.endsWith("ch")) return `${name}es`
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

function rowAsView(row: { id: string; status: string; data: Record<string, unknown>; externalId?: string; errorMessage?: string }) {
  return {
    id: row.id,
    status: row.status,
    ...row.data,
    ...(row.externalId ? { external_id: row.externalId } : {}),
    ...(row.errorMessage ? { error_message: row.errorMessage } : {}),
  }
}

function buildSnapshot(app: AppHandleInternal) {
  const state = app.state()
  const counts: Record<string, Record<string, number>> = {}
  for (const row of state.rows) {
    counts[row.resource] = counts[row.resource] ?? {}
    counts[row.resource]![row.status] = (counts[row.resource]![row.status] ?? 0) + 1
  }
  const recentFailures = state.notifications
    .filter(n => n.level === "error")
    .slice(-5)
    .map(n => ({ at: n.at, summary: n.summary }))
  return {
    app_id: app.config.id,
    rows_by_resource: counts,
    recent_failures: recentFailures,
    total_outputs: state.outputs.length,
    total_sync_records: state.syncRecords.length,
  }
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined,
  }
}

function errResult(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code, message }, null, 2) }],
    isError: true as const,
  }
}
