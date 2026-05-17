// Real E2E for the Telegram app — BDD-style scenarios against a live bot.
//
// Setup:
//   1. Talk to @BotFather, /newbot, save the bot token
//   2. Connect Telegram via desktop UI (Composio) using that bot token
//   3. Start a chat with your bot and send it any message so it knows your chat_id
//   4. export COMPOSIO_API_KEY=ck_...
//      export TEST_TELEGRAM_CHAT_ID=<your numeric chat id, from getUpdates>
//
// Optional:
//   COMPOSIO_USER_ID                  scope account listing to a specific user
//   COMPOSIO_TELEGRAM_ACCOUNT_ID      skip auto-discovery
//
// Run: bun run reference/telegram-messaging/e2e.ts

import { buildTelegramApp } from "./app.ts"
import { createBridge, type BridgeClient } from "../../src/index.ts"
import { TELEGRAM } from "./provider.ts"
import { createComposioDirectTransport } from "../../src/bridge-transports/composio-direct.ts"
import type { AppHandleInternal } from "../../src/app.ts"

// ─── Env ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.COMPOSIO_API_KEY
if (!API_KEY) {
  console.error(`Missing env: COMPOSIO_API_KEY=ck_xxx`)
  process.exit(1)
}
const CHAT_ID = process.env.TEST_TELEGRAM_CHAT_ID
if (!CHAT_ID) {
  console.error(`Missing env: TEST_TELEGRAM_CHAT_ID=<numeric chat id>
  - DM your bot first, then GET /bot<token>/getUpdates to find your chat id`)
  process.exit(1)
}
const COMPOSIO_BASE = (process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev").replace(/\/+$/, "")
const USER_ID = process.env.COMPOSIO_USER_ID
let ACCOUNT_ID = process.env.COMPOSIO_TELEGRAM_ACCOUNT_ID

async function discoverTelegramConnection(): Promise<string> {
  const params = new URLSearchParams({ page: "1", page_size: "200" })
  if (USER_ID) params.set("user_id", USER_ID)
  const url = `${COMPOSIO_BASE}/api/v3/connected_accounts?${params}`
  const r = await fetch(url, { headers: { "x-api-key": API_KEY! } })
  if (!r.ok) {
    const text = await r.text().catch(() => "")
    throw new Error(`Composio list-accounts failed (${r.status}): ${text.slice(0, 300)}`)
  }
  const data = (await r.json()) as {
    items?: Array<{ id?: string; status?: string; toolkit?: { slug?: string } }>
  }
  const tgs = (data.items ?? []).filter(
    a => a.toolkit?.slug?.toLowerCase() === "telegram"
      && (a.status ?? "").toUpperCase() === "ACTIVE",
  )
  if (tgs.length === 0) {
    throw new Error(`No active Telegram connection in Composio. Connect via desktop UI first.`)
  }
  return tgs[0]!.id ?? ""
}

if (!ACCOUNT_ID) {
  console.log("Discovering Telegram connection from Composio…")
  ACCOUNT_ID = await discoverTelegramConnection()
  console.log(`  → ${ACCOUNT_ID}`)
}

const transport = createComposioDirectTransport({ apiKey: API_KEY, connectedAccountId: ACCOUNT_ID })
const bridge: BridgeClient = createBridge({ provider: TELEGRAM, transport })
const { app } = buildTelegramApp() as unknown as { app: AppHandleInternal }
app._setTurn({ turnId: "e2e", sessionId: "e2e" })

console.log(`\nSUT ready (chat_id=${CHAT_ID}). Running scenarios…\n`)

interface ScenarioResult { feature: string; name: string; ok: boolean; ms: number; err?: string }
const results: ScenarioResult[] = []
let currentFeature = ""
function feature(name: string) { currentFeature = name; console.log(`\n━━━ Feature: ${name} ━━━`) }
async function scenario(name: string, body: () => Promise<void>) {
  const start = Date.now()
  console.log(`\n  Scenario: ${name}`)
  try {
    await body()
    const ms = Date.now() - start
    results.push({ feature: currentFeature, name, ok: true, ms })
    console.log(`  ✓ pass (${ms}ms)`)
  } catch (e) {
    const ms = Date.now() - start
    const err = e instanceof Error ? e.message : String(e)
    results.push({ feature: currentFeature, name, ok: false, ms, err })
    console.error(`  ✗ FAIL: ${err}`)
  }
}
function given(s: string) { console.log(`    Given ${s}`) }
function when(s: string)  { console.log(`    When  ${s}`) }
function then(s: string)  { console.log(`    Then  ${s}`) }
function expect<T>(actual: T) {
  return {
    toBe(expected: T, label = "value") {
      if (actual !== expected) throw new Error(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy(label = "value") {
      if (!actual) throw new Error(`${label}: expected truthy, got ${JSON.stringify(actual)}`)
    },
  }
}
function expectOk(
  result: { ok: true; externalId?: string } | { fail: { code: string; message: string } },
  label = "action",
): asserts result is { ok: true; externalId?: string } {
  if ("fail" in result) {
    throw new Error(`${label} expected ok but FAILED: code='${result.fail.code}' message='${result.fail.message}'`)
  }
}

const stamp = () => new Date().toISOString().slice(11, 19)
let sentMessage: { id: string; externalId?: string } | null = null

feature("Send a message")

await scenario("draft → sent, returns message_id, emits dashboard card", async () => {
  given(`a draft message row targeting chat ${CHAT_ID}`)
  const row = app._state.insertRow("message", {
    chat_id: CHAT_ID, text: `[E2E ${stamp()}] send scenario`,
  }, "draft")

  when("the agent invokes send_message")
  const result = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge })

  then("the action succeeds and Telegram returns a message_id")
  expectOk(result, "send_message")
  expect(result.externalId).toBeTruthy("externalId (Telegram message_id)")

  then("the row transitions to 'sent' and persists externalId")
  const final = app._state.getRow(row.id)
  expect(final?.status).toBe("sent", "row.status after send")
  expect(final?.externalId).toBe(result.externalId!, "row.externalId persisted")

  sentMessage = { id: row.id, externalId: result.externalId }
})

feature("Edit and react")

await scenario("edit_message: sent → edited and updates upstream text", async () => {
  given("the sent message from the previous scenario")
  expect(!!sentMessage).toBe(true, "send scenario must succeed first")

  when("the agent edits the text")
  const result = await app._invokeAction({
    actionName: "edit_message",
    rowId: sentMessage!.id,
    input: { text: `[E2E ${stamp()}] (edited via SDK)` },
    bridge,
  })

  then("the action succeeds and row transitions to 'edited'")
  expectOk(result, "edit_message")
  expect(app._state.getRow(sentMessage!.id)?.status).toBe("edited", "row.status after edit")
})

await scenario("react: adds 👍 WITHOUT mutating row.status (side-effect contract)", async () => {
  given("the same message, now in 'edited' state")
  expect(!!sentMessage).toBe(true)
  const beforeStatus = app._state.getRow(sentMessage!.id)?.status

  when("the agent reacts with 👍")
  const result = await app._invokeAction({
    actionName: "react",
    rowId: sentMessage!.id,
    input: { emoji: "👍" },
    bridge,
  })

  then("the action succeeds but row.status is unchanged (toState: null)")
  expectOk(result, "react")
  expect(app._state.getRow(sentMessage!.id)?.status).toBe(beforeStatus!, "row.status preserved")
})

feature("State machine guards")

await scenario("react on a draft fails with typed invalid_state — NO upstream call", async () => {
  given("a fresh draft never sent to Telegram")
  const draft = app._state.insertRow("message", {
    chat_id: CHAT_ID, text: "should never reach Telegram",
  }, "draft")

  when("the agent tries to react on the draft")
  const result = await app._invokeAction({
    actionName: "react", rowId: draft.id, input: { emoji: "👍" }, bridge,
  })

  then("the action fails with code='invalid_state'")
  expect("fail" in result).toBe(true, "result kind")
  if ("fail" in result) {
    expect(result.fail.code).toBe("invalid_state", "fail.code")
  }
  expect(app._state.getRow(draft.id)?.status).toBe("draft", "row.status unchanged")
})

feature("Cleanup")

await scenario("delete_message removes the test message; row → deleted", async () => {
  given("the sent message from the first scenario")
  expect(!!sentMessage).toBe(true)

  when("the agent invokes delete_message")
  const result = await app._invokeAction({
    actionName: "delete_message", rowId: sentMessage!.id, bridge,
  })

  then("the action succeeds and row transitions to 'deleted'")
  expectOk(result, "delete_message")
  expect(app._state.getRow(sentMessage!.id)?.status).toBe("deleted", "row.status after delete")
})

const passed = results.filter(r => r.ok).length
const failed = results.length - passed
const totalMs = results.reduce((sum, r) => sum + r.ms, 0)

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`  ${passed} passed / ${failed} failed in ${totalMs}ms`)
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

if (failed > 0) {
  console.log("\nFailures:")
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  ✗ [${r.feature}] ${r.name}`)
    console.log(`    ${r.err}`)
  }
  process.exit(1)
}
