// Self-host OAuth E2E — proves the SDK works with a transport you control,
// no Composio / Holaboss backend involved. Single scenario, just enough to
// validate the transport contract end-to-end.
//
// Required env:
//   SLACK_BEARER_TOKEN   xoxb-... or xoxp-... (Slack token from your app/install)
//   TEST_SLACK_CHANNEL   channel id
//
// Run: bun run reference/slack-messaging/e2e-bearer.ts

import { buildSlackApp } from "./app.ts"
import { createBridge } from "../../src/bridge.ts"
import { SLACK } from "./provider.ts"
import { createBearerTokenTransport } from "../../src/bridge-transports/bearer.ts"
import type { AppHandleInternal } from "../../src/app.ts"

const TOKEN = process.env.SLACK_BEARER_TOKEN
const CHANNEL = process.env.TEST_SLACK_CHANNEL
if (!TOKEN || !CHANNEL) {
  console.error(`Missing env. Set SLACK_BEARER_TOKEN and TEST_SLACK_CHANNEL.`)
  process.exit(1)
}

// ─── BDD harness (tiny duplicate of e2e.ts's — keeps this file standalone) ─

async function scenario(name: string, body: () => Promise<void>) {
  console.log(`\nScenario: ${name}`)
  const start = Date.now()
  try { await body(); console.log(`  ✓ pass (${Date.now() - start}ms)`) }
  catch (e) { console.error(`  ✗ FAIL:`, e instanceof Error ? e.message : e); process.exit(1) }
}
function given(s: string) { console.log(`  Given ${s}`) }
function when(s: string)  { console.log(`  When  ${s}`) }
function then(s: string)  { console.log(`  Then  ${s}`) }
function expect<T>(actual: T) {
  return {
    toBe(expected: T, label = "value") {
      if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy(label = "value") {
      if (!actual) throw new Error(`${label}: expected truthy, got ${JSON.stringify(actual)}`)
    },
  }
}

// ─── SUT ────────────────────────────────────────────────────────────────────

const transport = createBearerTokenTransport({ accessToken: TOKEN })
const bridge = createBridge({ provider: SLACK, transport })
const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
app._setTurn({ turnId: "e2e-bearer", sessionId: "e2e-bearer" })

// ─── Scenario ───────────────────────────────────────────────────────────────

await scenario("Self-host OAuth path: send_message succeeds with bearer transport, row → sent", async () => {
  given("a draft message and a SDK bridge wired to a user-provided bearer token")
  const row = app._state.insertRow("message", {
    channel_id: CHANNEL,
    text: `[E2E-bearer ${new Date().toISOString().slice(11, 19)}] self-host OAuth proof`,
  }, "draft")

  when("the agent invokes send_message")
  const result = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge })

  then("the SDK doesn't care that no Composio / Holaboss backend is in the path — it just works")
  expect("ok" in result).toBe(true, "result kind")
  const externalId = "ok" in result ? result.externalId : undefined
  expect(externalId).toBeTruthy("Slack ts returned via bearer transport")
  expect(app._state.getRow(row.id)?.status).toBe("sent", "row.status after send")

  console.log(`  Dashboard card:`, app.state().outputs.find(o => o.rowId === row.id))
})
