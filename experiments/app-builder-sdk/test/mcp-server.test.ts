// Verify the MCP server boots, exposes /mcp/health, registers expected tools
// from a Slack app instance, and routes a tool call through to the SDK.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { startMcpServer, type StartedMcpServer } from "../src/runtime/mcp-server.ts"
import { createBridge, type TransportFn } from "../src/index.ts"
import { SLACK } from "../examples/slack/provider.ts"
import { buildSlackApp } from "../examples/slack/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let server: StartedMcpServer
let app: AppHandleInternal
let baseUrl: string

const scriptedResponses: Array<{ status: number; body: unknown }> = []
const transport: TransportFn = async () => {
  const next = scriptedResponses.shift()
  if (!next) throw new Error("no scripted response")
  return next
}

beforeAll(async () => {
  const built = buildSlackApp() as unknown as { app: AppHandleInternal }
  app = built.app
  app._setTurn({ turnId: "t_mcp", sessionId: "s_mcp" })
  const bridge = createBridge({ provider: SLACK, transport })
  server = await startMcpServer({ app, port: 0, bridge })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(async () => {
  await server.close()
})

describe("MCP server — boot + tool registration + routing", () => {
  test("health endpoint responds with status:ok and app_id", async () => {
    const r = await fetch(`${baseUrl}/mcp/health`)
    expect(r.status).toBe(200)
    const body = await r.json() as { status: string; app_id: string }
    expect(body.status).toBe("ok")
    expect(body.app_id).toBe("slack")
  })

  test("tools/list via MCP JSON-RPC: derived tool names appear", async () => {
    // Start an SSE session
    const session = await openSseSession(baseUrl)
    const tools = await mcpListTools(baseUrl, session.sessionId)
    const names = tools.map(t => t.name)

    // Connection / snapshot
    expect(names).toContain("slack_connection_status")
    expect(names).toContain("slack_snapshot")

    // Per-resource CRUD
    expect(names).toContain("slack_create_message")
    expect(names).toContain("slack_list_messages")
    expect(names).toContain("slack_get_message")
    expect(names).toContain("slack_create_channel")

    // Action tools (from buildSlackApp registrations)
    expect(names).toContain("slack_send_message_message")
    expect(names).toContain("slack_edit_message_message")
    expect(names).toContain("slack_delete_message_message")
    expect(names).toContain("slack_react")           // custom toolName override
    expect(names).toContain("slack_schedule_send_message")

    // Reverse tool (schedule_send is reversible)
    expect(names).toContain("slack_cancel_schedule_send_message")

    // Sync status descriptor
    expect(names).toContain("slack_channel_directory_sync_status")

    await session.close()
  })

  test("tools/call slack_create_message inserts a row in 'draft' state", async () => {
    const session = await openSseSession(baseUrl)
    const result = await mcpCallTool(baseUrl, session.sessionId, "slack_create_message", {
      channel_id: "C12345", text: "hello via mcp",
    })
    expect(result.isError).toBeFalsy()
    const created = JSON.parse(result.content[0]!.text!)
    expect(created.status).toBe("draft")
    expect(created.channel_id).toBe("C12345")
    expect(created.text).toBe("hello via mcp")
    expect(created.id).toMatch(/^r_/)

    // Verify row really lives in app state
    const stateRow = app._state.getRow(created.id)
    expect(stateRow?.status).toBe("draft")

    await session.close()
  })

  test("tools/call slack_send_message_message routes through SDK to bridge", async () => {
    const row = app._state.insertRow("message", {
      channel_id: "C9999", text: "hi from mcp tool",
    }, "draft")

    scriptedResponses.push({ status: 200, body: { ok: true, ts: "9999.000", channel: "C9999" } })

    const session = await openSseSession(baseUrl)
    const result = await mcpCallTool(baseUrl, session.sessionId, "slack_send_message_message", {
      message_id: row.id,
    })
    expect(result.isError).toBeFalsy()
    const ok = JSON.parse(result.content[0]!.text!)
    expect(ok.ok).toBe(true)
    expect(ok.externalId).toBe("9999.000")

    // Row state updated
    const updated = app._state.getRow(row.id)
    expect(updated?.status).toBe("sent")
    expect(updated?.externalId).toBe("9999.000")

    await session.close()
  })

  test("tools/call with invalid state surfaces isError + typed code", async () => {
    const draft = app._state.insertRow("message", {
      channel_id: "C0000", text: "never react",
    }, "draft")

    const session = await openSseSession(baseUrl)
    const result = await mcpCallTool(baseUrl, session.sessionId, "slack_react", {
      message_id: draft.id, emoji: "rocket",
    })
    expect(result.isError).toBe(true)
    const err = JSON.parse(result.content[0]!.text!)
    expect(err.code).toBe("invalid_state")
    await session.close()
  })

  test("tools/call slack_snapshot returns aggregate row counts", async () => {
    const session = await openSseSession(baseUrl)
    const result = await mcpCallTool(baseUrl, session.sessionId, "slack_snapshot", {})
    expect(result.isError).toBeFalsy()
    const snap = JSON.parse(result.content[0]!.text!)
    expect(snap.app_id).toBe("slack")
    expect(snap.rows_by_resource).toBeDefined()
    // We've inserted multiple message rows above; should see "message" key
    expect(snap.rows_by_resource.message).toBeDefined()
    await session.close()
  })
})

// ─── MCP JSON-RPC client helpers (no @modelcontextprotocol/sdk client dep) ───
//
// We talk to the server directly over SSE + POST /mcp/messages so the tests
// don't pull in extra client machinery.

interface SseSession {
  sessionId: string
  close: () => Promise<void>
}

async function openSseSession(base: string): Promise<SseSession> {
  // Open SSE; read the first event which carries the sessionId via the
  // POST URL: SSEServerTransport emits "endpoint" event with /mcp/messages?sessionId=...
  const abortCtrl = new AbortController()
  const r = await fetch(`${base}/mcp/sse`, { signal: abortCtrl.signal })
  if (!r.ok || !r.body) throw new Error(`SSE failed: ${r.status}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let sessionId = ""
  // Read until we see the "endpoint" event with sessionId
  for (let i = 0; i < 20; i++) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const match = buf.match(/sessionId=([a-zA-Z0-9_-]+)/)
    if (match) { sessionId = match[1]!; break }
  }
  if (!sessionId) throw new Error("no sessionId received")
  return {
    sessionId,
    close: async () => { abortCtrl.abort(); try { await reader.cancel() } catch {} },
  }
}

async function mcpListTools(base: string, sessionId: string): Promise<Array<{ name: string }>> {
  const result = await mcpJsonRpc(base, sessionId, "tools/list", {})
  return (result as { tools: Array<{ name: string }> }).tools
}

async function mcpCallTool(base: string, sessionId: string, name: string, args: Record<string, unknown>) {
  const result = await mcpJsonRpc(base, sessionId, "tools/call", { name, arguments: args })
  return result as { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
}

async function mcpJsonRpc(base: string, sessionId: string, method: string, params: unknown): Promise<unknown> {
  // The MCP server's SSEServerTransport responds via the SSE stream we opened.
  // We need to (a) POST the request, (b) read the matching response from SSE.
  // Simpler approach: do request via POST + assume server posts back via SSE.
  // For tests, McpServer.connect returns request/response over SSE. We'll
  // re-open SSE per call to keep the helper minimal.
  const sess = await openSseSessionWithReader(base)
  const requestId = Math.floor(Math.random() * 1_000_000)
  const postPromise = fetch(`${base}/mcp/messages?sessionId=${sess.sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  })
  const response = await sess.readUntilResponse(requestId, 5000)
  await postPromise
  await sess.close()
  if (response.error) throw new Error(`MCP error: ${JSON.stringify(response.error)}`)
  return response.result
}

interface SseSessionWithReader extends SseSession {
  readUntilResponse: (id: number, timeoutMs: number) => Promise<{ result?: unknown; error?: unknown }>
}

async function openSseSessionWithReader(base: string): Promise<SseSessionWithReader> {
  const abortCtrl = new AbortController()
  const r = await fetch(`${base}/mcp/sse`, { signal: abortCtrl.signal })
  if (!r.ok || !r.body) throw new Error(`SSE failed: ${r.status}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let sessionId = ""
  while (!sessionId) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const m = buf.match(/sessionId=([a-zA-Z0-9_-]+)/)
    if (m) sessionId = m[1]!
  }
  if (!sessionId) throw new Error("no sessionId")
  return {
    sessionId,
    close: async () => { abortCtrl.abort(); try { await reader.cancel() } catch {} },
    readUntilResponse: async (id, timeoutMs) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Each SSE event ends in \n\n; data lines start with "data: "
        const events = buf.split("\n\n")
        buf = events.pop() ?? ""
        for (const ev of events) {
          const dataLine = ev.split("\n").find(l => l.startsWith("data: "))
          if (!dataLine) continue
          const raw = dataLine.slice("data: ".length)
          try {
            const parsed = JSON.parse(raw)
            if (parsed.id === id) return { result: parsed.result, error: parsed.error }
          } catch {}
        }
      }
      throw new Error(`timeout waiting for response to id=${id}`)
    },
  }
}
