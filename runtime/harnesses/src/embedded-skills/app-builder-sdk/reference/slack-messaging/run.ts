// Interactive demo for the Slack app.
// Walks: send_message → edit_message → react → delete_message
// against a fake transport, printing the row, dashboard card, and audit log
// at each step. Run with: `bun run reference/slack-messaging/run.ts`

import { buildSlackApp } from "./app.ts"
import { createBridge, type TransportFn } from "../../src/bridge.ts"
import { SLACK } from "./provider.ts"
import type { AppHandleInternal } from "../../src/app.ts"

// Fake Slack — scripts replies. Real impl would call /broker/proxy.
const replies = new Map<string, unknown>([
  ["POST https://slack.com/api/chat.postMessage",
    { ok: true, ts: "1700000000.111111", channel: "C0123" }],
  ["POST https://slack.com/api/chat.update",
    { ok: true, ts: "1700000000.111111", channel: "C0123" }],
  ["POST https://slack.com/api/reactions.add",
    { ok: true }],
  ["POST https://slack.com/api/chat.delete",
    { ok: true }],
])

const transport: TransportFn = async ({ method, url, body }) => {
  console.log(`  → ${method} ${url}`)
  if (body) console.log(`     body: ${JSON.stringify(body)}`)
  const key = `${method} ${url}`
  const body_ = replies.get(key)
  if (!body_) throw new Error(`no scripted reply for ${key}`)
  return { status: 200, body: body_ }
}

const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
app._setTurn({ turnId: "demo-turn", sessionId: "demo-session" })
const bridge = createBridge({ provider: SLACK, transport })

console.log("\n=== Derived MCP tools ===")
console.table(app.derivedTools().map(t => ({ name: t.name, category: t.category, input: t.inputShape })))

console.log("\n=== Step 1: create draft row + send_message ===")
const row = app._state.insertRow("message", {
  channel_id: "C0123",
  text: "Hello from the v2 SDK demo",
}, "draft")
console.log(`  row inserted: id=${row.id}, status=${row.status}`)

const send = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge })
console.log("  result:", send)
console.log("  row now:", { status: app._state.getRow(row.id)?.status, externalId: app._state.getRow(row.id)?.externalId })

console.log("\n=== Step 2: edit_message ===")
const edit = await app._invokeAction({
  actionName: "edit_message",
  rowId: row.id,
  input: { text: "Hello from the v2 SDK demo (edited)" },
  bridge,
})
console.log("  result:", edit, "→ status:", app._state.getRow(row.id)?.status)

console.log("\n=== Step 3: react (side effect — status should stay 'edited') ===")
const react = await app._invokeAction({
  actionName: "react", rowId: row.id, input: { emoji: "rocket" }, bridge,
})
console.log("  result:", react, "→ status:", app._state.getRow(row.id)?.status)

console.log("\n=== Step 4: delete_message ===")
const del = await app._invokeAction({ actionName: "delete_message", rowId: row.id, bridge })
console.log("  result:", del, "→ status:", app._state.getRow(row.id)?.status)

console.log("\n=== Dashboard cards (what user would see in workspace) ===")
console.table(app.state().outputs.map(o => ({
  status: o.status, surface: o.surface, summary: o.summary, deepLink: o.deepLink,
})))

console.log("\n=== Audit log (last 8 events) ===")
console.table(app.state().audit.slice(-8).map(a => ({
  event: a.event,
  step: a.fields.step ?? a.fields.action ?? "-",
  outcome: a.fields.outcome ?? "-",
})))
