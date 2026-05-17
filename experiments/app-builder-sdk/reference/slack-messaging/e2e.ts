// Real E2E for the Slack app — BDD-style scenarios against a live Slack workspace.
//
// Zero-friction: set COMPOSIO_API_KEY and run. The script discovers your Slack
// connection from Composio, your own user_id via auth.test, and DMs the test
// messages to YOURSELF (no team channels spammed).
//
// Optional overrides:
//   COMPOSIO_USER_ID            scope account listing to a specific user
//   COMPOSIO_SLACK_ACCOUNT_ID   skip auto-discovery (use this id directly)
//   TEST_SLACK_CHANNEL          send to this channel instead of self-DM
//
// Run: bun run reference/slack-messaging/e2e.ts

import { buildSlackApp } from "./app.ts"
import { createBridge, type BridgeClient } from "../../src/index.ts"
import { SLACK } from "./provider.ts"
import { createComposioDirectTransport } from "../../src/bridge-transports/composio-direct.ts"
import type { AppHandleInternal } from "../../src/app.ts"

// ─── Env ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.COMPOSIO_API_KEY
if (!API_KEY) {
  console.error(`Missing env: COMPOSIO_API_KEY=ck_xxx
Find it in backend/.env or your frontend wrangler secrets.`)
  process.exit(1)
}
const COMPOSIO_BASE = (process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev").replace(/\/+$/, "")
const USER_ID = process.env.COMPOSIO_USER_ID                    // optional
let ACCOUNT_ID = process.env.COMPOSIO_SLACK_ACCOUNT_ID          // optional override
let CHANNEL = process.env.TEST_SLACK_CHANNEL                    // optional override

// ─── Auto-discover: Composio Slack connection ──────────────────────────────

async function discoverSlackConnection(): Promise<string> {
  const params = new URLSearchParams({ page: "1", page_size: "200" })
  if (USER_ID) params.set("user_id", USER_ID)
  const url = `${COMPOSIO_BASE}/api/v3/connected_accounts?${params}`
  const r = await fetch(url, { headers: { "x-api-key": API_KEY! } })
  if (!r.ok) {
    const text = await r.text().catch(() => "")
    throw new Error(`Composio list-accounts failed (${r.status}): ${text.slice(0, 300)}
  - if "user_id required" → set COMPOSIO_USER_ID=<your holaboss user id>`)
  }
  const data = (await r.json()) as {
    items?: Array<{ id?: string; status?: string; toolkit?: { slug?: string } }>
  }
  const slacks = (data.items ?? []).filter(
    a => a.toolkit?.slug?.toLowerCase() === "slack"
      && (a.status ?? "").toUpperCase() === "ACTIVE",
  )
  if (slacks.length === 0) {
    throw new Error(`No active Slack connection in Composio.
  - connect Slack via desktop UI first, OR
  - set COMPOSIO_USER_ID to filter by user`)
  }
  if (slacks.length > 1) {
    console.warn(`Found ${slacks.length} active Slack connections — picking first.`)
    console.warn(`  IDs: ${slacks.map(s => s.id).join(", ")}`)
    console.warn(`  To pick explicitly, set COMPOSIO_SLACK_ACCOUNT_ID.`)
  }
  return slacks[0]!.id ?? ""
}

if (!ACCOUNT_ID) {
  console.log("Discovering Slack connection from Composio…")
  ACCOUNT_ID = await discoverSlackConnection()
  console.log(`  → ${ACCOUNT_ID}`)
}

// ─── Build SUT ─────────────────────────────────────────────────────────────

const transport = createComposioDirectTransport({ apiKey: API_KEY, connectedAccountId: ACCOUNT_ID })
const bridge: BridgeClient = createBridge({ provider: SLACK, transport })
const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
app._setTurn({ turnId: "e2e", sessionId: "e2e" })

// ─── Auto-discover: own Slack user_id for DM-to-self ───────────────────────

if (!CHANNEL) {
  console.log("Discovering your own Slack user via auth.test…")
  const r = await bridge.call<{ ok: boolean; user_id?: string; user?: string; team?: string }>(
    "POST", "/auth.test",
  )
  if (r.kind === "error" || !r.data?.user_id) {
    throw new Error(`auth.test failed: ${JSON.stringify(r).slice(0, 300)}
  - set TEST_SLACK_CHANNEL=C0... manually to skip self-DM`)
  }
  CHANNEL = r.data.user_id
  console.log(`  → DMing @${r.data.user} (workspace ${r.data.team}, channel ${CHANNEL})`)
}

console.log(`\nSUT ready. Running scenarios…\n`)

// ─── Minimal BDD harness ───────────────────────────────────────────────────

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
    toMatch(re: RegExp, label = "value") {
      if (typeof actual !== "string" || !re.test(actual))
        throw new Error(`${label}: expected to match ${re}, got ${JSON.stringify(actual)}`)
    },
  }
}

// Specialized assertion for action results — if the action failed, includes
// the full fail.code + message in the error so we don't have to guess.
function expectOk(
  result: { ok: true; externalId?: string } | { fail: { code: string; message: string } },
  label = "action",
): asserts result is { ok: true; externalId?: string } {
  if ("fail" in result) {
    throw new Error(
      `${label} expected ok but FAILED: code='${result.fail.code}' message='${result.fail.message}'`,
    )
  }
}

const stamp = () => new Date().toISOString().slice(11, 19)
let sentMessage: { id: string; externalId?: string } | null = null

// ───────────────────────────────────────────────────────────────────────────
// Scenarios
// ───────────────────────────────────────────────────────────────────────────

feature("Send a message")

await scenario("draft → sent transitions row, returns Slack ts, emits dashboard card", async () => {
  given(`a draft message row targeting ${CHANNEL}`)
  const row = app._state.insertRow("message", {
    channel_id: CHANNEL!, text: `[E2E ${stamp()}] send scenario`,
  }, "draft")
  expect(app._state.getRow(row.id)?.status).toBe("draft", "row.status initial")

  when("the agent invokes send_message")
  const result = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge })

  then("the action succeeds and Slack returns a message ts")
  expectOk(result, "send_message")
  const externalId = result.externalId
  expect(externalId).toBeTruthy("externalId (Slack ts)")

  then("the row transitions to 'sent' and persists externalId")
  const final = app._state.getRow(row.id)
  expect(final?.status).toBe("sent", "row.status after send")
  expect(final?.externalId).toBe(externalId!, "row.externalId persisted")

  then("a dashboard card is emitted with a Slack deepLink")
  const card = app.state().outputs.find(o => o.rowId === row.id)
  expect(!!card).toBe(true, "dashboard card exists")
  expect(card!.status).toBe("sent", "card.status")
  expect(card!.deepLink ?? "").toMatch(/slack\.com\/archives\//, "card.deepLink")

  sentMessage = { id: row.id, externalId }
})

feature("Edit and react to a sent message")

await scenario("edit_message transitions sent → edited and updates upstream text", async () => {
  given("the message sent in the previous scenario")
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

await scenario("react adds emoji WITHOUT mutating row.status (side-effect contract)", async () => {
  given("the same message, now in 'edited' state")
  expect(!!sentMessage).toBe(true)
  const beforeStatus = app._state.getRow(sentMessage!.id)?.status
  const beforeCardCount = app.state().outputs.filter(o => o.rowId === sentMessage!.id).length

  when("the agent reacts with :rocket:")
  const result = await app._invokeAction({
    actionName: "react",
    rowId: sentMessage!.id,
    input: { emoji: "rocket" },
    bridge,
  })

  then("the action succeeds but row.status is unchanged (toState: null)")
  expectOk(result, "react")
  expect(app._state.getRow(sentMessage!.id)?.status).toBe(beforeStatus!, "row.status preserved")

  then("no new dashboard card is emitted (side-effect actions don't dirty the surface)")
  const afterCardCount = app.state().outputs.filter(o => o.rowId === sentMessage!.id).length
  expect(afterCardCount).toBe(beforeCardCount, "dashboard card count")
})

feature("State machine guards")

await scenario("react on a draft row fails with typed invalid_state — NO upstream call", async () => {
  given("a fresh draft row never sent to Slack")
  const draft = app._state.insertRow("message", {
    channel_id: CHANNEL!, text: "should never reach Slack",
  }, "draft")
  expect(draft.externalId).toBe(undefined, "no externalId for unsent draft")

  when("the agent tries to react on the draft")
  const result = await app._invokeAction({
    actionName: "react", rowId: draft.id, input: { emoji: "thumbsup" }, bridge,
  })

  then("the action fails with code='invalid_state' and a state-naming message")
  expect("fail" in result).toBe(true, "result kind")
  if ("fail" in result) {
    expect(result.fail.code).toBe("invalid_state", "fail.code")
    expect(result.fail.message).toMatch(/from state 'draft'/, "fail.message")
  }

  then("the row remains untouched")
  expect(app._state.getRow(draft.id)?.status).toBe("draft", "row.status unchanged")
})

feature("Reversible action: schedule + cancel")

await scenario("schedule_send + reverse roundtrip — row scheduled → draft, upstream cancel called", async () => {
  given("a fresh draft row scheduled 180s in the future (Slack requires >60s lead time at cancel time)")
  const future = Math.floor(Date.now() / 1000) + 180
  const row = app._state.insertRow("message", {
    channel_id: CHANNEL!,
    text: `[E2E ${stamp()}] this should NEVER appear (scheduled then cancelled)`,
  }, "draft")

  when("the agent invokes schedule_send")
  const scheduled = await app._invokeAction({
    actionName: "schedule_send", rowId: row.id, input: { post_at: future }, bridge,
  })

  then("the action succeeds with a scheduled_message_id as externalId")
  expectOk(scheduled, "schedule_send")
  expect(scheduled.externalId).toBeTruthy("scheduled_message_id")
  expect(app._state.getRow(row.id)?.status).toBe("scheduled", "row.status after schedule")

  when("the agent invokes the reverse (cancel) action")
  const reversed = await app._invokeReverse({ actionName: "schedule_send", rowId: row.id, bridge })

  then("the reverse succeeds and row transitions back to 'draft'")
  expectOk(reversed, "reverse(schedule_send)")
  expect(app._state.getRow(row.id)?.status).toBe("draft", "row.status after reverse")
})

feature("Cleanup")

await scenario("delete_message removes the test message; row → deleted, card reflects", async () => {
  given("the sent message from the first scenario")
  expect(!!sentMessage).toBe(true)

  when("the agent invokes delete_message")
  const result = await app._invokeAction({
    actionName: "delete_message", rowId: sentMessage!.id, bridge,
  })

  then("the action succeeds and row transitions to 'deleted'")
  expectOk(result, "delete_message")
  expect(app._state.getRow(sentMessage!.id)?.status).toBe("deleted", "row.status after delete")

  then("the dashboard card status reflects the deletion")
  const card = app.state().outputs.find(o => o.rowId === sentMessage!.id)
  expect(card?.status).toBe("deleted", "card.status")
})

// ─── Summary ───────────────────────────────────────────────────────────────

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
