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
//   - <app>_connection_status           reports app.connection() state
//   - <app>_snapshot                    compact situational read
//
// Sync tools (`_sync_status`, `_refresh_*`) are derived as descriptors but
// not yet wired to handlers — left as TODO for Iter 4.

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
}

export interface StartedMcpServer {
  /** Actual port the server is listening on (resolved after 0 → OS-assigned). */
  port: number
  /** Stop the server gracefully. */
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

  return {
    port: actualPort,
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()))
    }),
  }
}

// ─── Tool registration ─────────────────────────────────────────────────────

function registerTools(mcp: McpServer, app: AppHandleInternal, bridge: BridgeClient): void {
  const appId = app.config.id

  // Connection
  mcp.registerTool(
    `${appId}_connection_status`,
    {
      title: "Connection status",
      description: `Check whether ${appId} is connected and ready to call.`,
      inputSchema: {},
    },
    async () => textResult({
      // Placeholder — real implementation hooks runtime's integration_connections table
      app_id: appId,
      connected: true,
      note: "Iter 3 stub — wire to runtime integration_connections in Iter 4",
    }),
  )

  // Per-resource: create / list / get
  for (const [resourceName, resource] of app._resources) {
    const inputShapeForCreate = extractShape(resource.schema)

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

  // Sync status (descriptor only for Iter 3; runtime-driven sync execution is Iter 4)
  for (const sync of app._syncs) {
    mcp.registerTool(
      `${appId}_${sync.name}_sync_status`,
      {
        title: `${sync.name} sync status`,
        description: `Status of the ${sync.name} sync (last run, errors). Iter 3: descriptor only.`,
        inputSchema: {},
      },
      async () => textResult({
        sync_name: sync.name,
        schedule: sync.def.schedule,
        note: "Iter 3 stub — sync execution moves to Iter 4 / automations layer",
      }),
    )
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
