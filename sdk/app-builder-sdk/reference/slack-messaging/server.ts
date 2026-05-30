// Production entry point for the Slack v2 app module.
//
// What this file does (in one place):
//   1. Builds the Slack app with a SqliteStateBackend (persists to WORKSPACE_DB_PATH)
//   2. Wires a runtime-broker transport (reads HOLABOSS_APP_GRANT + broker URL)
//   3. Starts the MCP server on MCP_PORT
//   4. Handles SIGTERM / SIGINT for clean shutdown
//
// When the Holaboss runtime launches this app via app.runtime.yaml lifecycle.start,
// it injects all required env vars. From the user's perspective:
//   - Connect Slack via desktop OAuth flow (existing infrastructure)
//   - Workspace gets a slack-v2 app entry, MCP tools become available to agent
//   - Agent calls slack_send_message → SDK → broker → real Slack
//
// To generate this app's app.runtime.yaml: bun run reference/slack-messaging/manifest.ts

import { buildSlackApp } from "./app.ts"
import {
  createBridge,
  createRuntimeBrokerTransport,
  SqliteStateBackend,
  startMcpServer,
} from "../../src/index.ts"
import { SLACK } from "./provider.ts"

const workspaceDbPath = process.env.WORKSPACE_DB_PATH
if (!workspaceDbPath) {
  console.error("[slack-v2] WORKSPACE_DB_PATH not set — refusing to start without persistence")
  process.exit(1)
}
const mcpPort = Number(process.env.MCP_PORT ?? 3099)
// Holaboss runtime allocates an HTTP port per app for the desktop iframe
// surface. Headless SDK modules don't have a web UI, but the desktop still
// tries to load the URL — startMcpServer serves a placeholder page on PORT
// to avoid ERR_CONNECTION_REFUSED.
const httpPort = process.env.PORT ? Number(process.env.PORT) : undefined

// 1) SQLite-backed state (persists across app restarts)
const backend = new SqliteStateBackend({ dbPath: workspaceDbPath, appId: "slack" })

// 2) Build the Slack app with persistent backend
const { app } = buildSlackApp({ backend })

// 3) Production transport — reads HOLABOSS_APP_GRANT + HOLABOSS_INTEGRATION_BROKER_URL from env
const transport = createRuntimeBrokerTransport({ provider: "slack" })
const bridge = createBridge({ provider: SLACK, transport })

// 4) Boot MCP server (+ headless web stub if PORT was injected)
const server = await startMcpServer({ app: app as never, port: mcpPort, bridge, httpPort })
console.log(`[slack-v2] MCP server listening on :${server.port}`)
if (server.httpPort) console.log(`[slack-v2] Web stub on :${server.httpPort}`)
console.log(`[slack-v2] Workspace DB: ${workspaceDbPath}`)
console.log(`[slack-v2] Tools registered: ${app.derivedTools().length}`)

// 5) Clean shutdown
async function shutdown(signal: string) {
  console.log(`[slack-v2] Received ${signal}, shutting down…`)
  await server.close().catch(err => console.error("[slack-v2] MCP close failed:", err))
  process.exit(0)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
