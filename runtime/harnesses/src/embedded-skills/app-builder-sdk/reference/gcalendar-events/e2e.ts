// Real E2E for the Google Calendar app — BDD scenarios against your live calendar.
//
// Zero-friction: set COMPOSIO_API_KEY and run. The script discovers your Calendar
// connection from Composio and uses your "primary" calendar (Google's alias for
// your own main calendar — no impact on shared calendars).
//
// Test events are scheduled ~1 hour out, immediately cleaned up via the Cleanup
// feature. If a scenario fails partway, you may need to delete leftover events
// manually (search calendar for "[E2E").
//
// Optional overrides:
//   COMPOSIO_USER_ID          scope account listing to a specific user
//   COMPOSIO_GCAL_ACCOUNT_ID  skip auto-discovery
//   TEST_CALENDAR_ID          use this calendar instead of "primary"
//
// Run: bun run reference/gcalendar-events/e2e.ts

import { buildGcalendarApp } from "./app.ts"
import { createBridge, type BridgeClient } from "../../src/index.ts"
import { GCALENDAR } from "./provider.ts"
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
const USER_ID = process.env.COMPOSIO_USER_ID
let ACCOUNT_ID = process.env.COMPOSIO_GCAL_ACCOUNT_ID
const CALENDAR_ID = process.env.TEST_CALENDAR_ID ?? "primary"

// ─── Auto-discover: Composio Calendar connection ───────────────────────────

async function discoverCalendarConnection(): Promise<string> {
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
  const cals = (data.items ?? []).filter(
    a => a.toolkit?.slug?.toLowerCase() === "googlecalendar"
      && (a.status ?? "").toUpperCase() === "ACTIVE",
  )
  if (cals.length === 0) {
    throw new Error(`No active Google Calendar connection in Composio.
  - connect Calendar via desktop UI first, OR
  - set COMPOSIO_USER_ID to filter by user`)
  }
  if (cals.length > 1) {
    console.warn(`Found ${cals.length} active Calendar connections — picking first.`)
    console.warn(`  IDs: ${cals.map(c => c.id).join(", ")}`)
    console.warn(`  To pick explicitly, set COMPOSIO_GCAL_ACCOUNT_ID.`)
  }
  return cals[0]!.id ?? ""
}

if (!ACCOUNT_ID) {
  console.log("Discovering Google Calendar connection from Composio…")
  ACCOUNT_ID = await discoverCalendarConnection()
  console.log(`  → ${ACCOUNT_ID}`)
}

// ─── Build SUT ─────────────────────────────────────────────────────────────

const transport = createComposioDirectTransport({ apiKey: API_KEY, connectedAccountId: ACCOUNT_ID })
const bridge: BridgeClient = createBridge({ provider: GCALENDAR, transport })
const { app, event } = buildGcalendarApp() as unknown as { app: AppHandleInternal; event: any }
app._setTurn({ turnId: "e2e", sessionId: "e2e" })

console.log(`SUT ready. Target calendar: ${CALENDAR_ID}\nRunning scenarios…\n`)

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
function futureEvent(offsetMinutes = 60, durationMinutes = 30) {
  const start = new Date(Date.now() + offsetMinutes * 60_000)
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  return { start_time: start.toISOString(), end_time: end.toISOString() }
}

let createdEvent: { id: string; externalId?: string } | null = null

// ───────────────────────────────────────────────────────────────────────────
// Scenarios
// ───────────────────────────────────────────────────────────────────────────

feature("Create event")

await scenario("draft → confirmed; event appears in calendar with externalId + dashboard card", async () => {
  given(`a draft event on calendar '${CALENDAR_ID}'`)
  const times = futureEvent(60, 30)
  const row = app._state.insertRow("event", {
    calendar_id: CALENDAR_ID,
    summary: `[E2E ${stamp()}] create scenario`,
    description: "Auto-created by app-builder-sdk e2e — safe to ignore.",
    ...times,
  }, "draft")
  expect(app._state.getRow(row.id)?.status).toBe("draft", "row.status initial")

  when("the agent invokes create_event")
  const result = await app._invokeAction({ actionName: "create_event", rowId: row.id, bridge })

  then("the action succeeds and Google returns an event id")
  expectOk(result, "create_event")
  expect(result.externalId).toBeTruthy("Google event id")

  then("the row transitions to 'confirmed' and persists externalId")
  const final = app._state.getRow(row.id)
  expect(final?.status).toBe("confirmed", "row.status after create")
  expect(final?.externalId).toBe(result.externalId!, "row.externalId persisted")

  then("a dashboard card is emitted with a Calendar deepLink")
  const card = app.state().outputs.find(o => o.rowId === row.id)
  expect(!!card).toBe(true, "dashboard card exists")
  expect(card!.status).toBe("confirmed", "card.status")
  expect(card!.deepLink ?? "").toMatch(/calendar\.google\.com/, "card.deepLink")

  createdEvent = { id: row.id, externalId: result.externalId }
})

feature("Update event")

await scenario("update_event: change summary; row stays 'confirmed'; upstream patched", async () => {
  given("the event created above")
  expect(!!createdEvent).toBe(true, "create scenario must succeed first")

  when("the agent updates the summary")
  const result = await app._invokeAction({
    actionName: "update_event",
    rowId: createdEvent!.id,
    input: { summary: `[E2E ${stamp()}] (updated via SDK)` },
    bridge,
  })

  then("the action succeeds and row stays 'confirmed'")
  expectOk(result, "update_event")
  expect(app._state.getRow(createdEvent!.id)?.status).toBe("confirmed", "row.status after update")
})

feature("State machine guards")

await scenario("rsvp on a draft row fails with typed invalid_state — NO upstream call", async () => {
  given("a fresh draft row never created on Google")
  const times = futureEvent(60, 30)
  const draft = app._state.insertRow("event", {
    calendar_id: CALENDAR_ID, summary: "should never reach Google", ...times,
  }, "draft")
  expect(draft.externalId).toBe(undefined, "no externalId for unsent draft")

  when("the agent tries to RSVP on the draft")
  const result = await app._invokeAction({
    actionName: "rsvp",
    rowId: draft.id,
    input: { response: "accepted", self_email: "test@example.com" },
    bridge,
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

feature("Reversible action: create + reverse")

await scenario("create + reverse roundtrip — row created → reverted to draft, event deleted upstream", async () => {
  given("a fresh draft event")
  const times = futureEvent(120, 30)
  const row = app._state.insertRow("event", {
    calendar_id: CALENDAR_ID,
    summary: `[E2E ${stamp()}] this should NEVER persist (created then reverted)`,
    ...times,
  }, "draft")

  when("the agent invokes create_event")
  const created = await app._invokeAction({ actionName: "create_event", rowId: row.id, bridge })

  then("the create succeeds with a Google event id")
  expectOk(created, "create_event")
  expect(app._state.getRow(row.id)?.status).toBe("confirmed", "row.status after create")

  when("the agent invokes the reverse (cancel) action")
  const reversed = await app._invokeReverse({ actionName: "create_event", rowId: row.id, bridge })

  then("the reverse succeeds and row transitions back to 'draft'")
  expectOk(reversed, "reverse(create_event)")
  expect(app._state.getRow(row.id)?.status).toBe("draft", "row.status after reverse")
})

feature("Cleanup")

await scenario("delete_event removes the test event from calendar; row → deleted, card reflects", async () => {
  given("the event created in the first scenario")
  expect(!!createdEvent).toBe(true)

  when("the agent invokes delete_event")
  const result = await app._invokeAction({
    actionName: "delete_event", rowId: createdEvent!.id, bridge,
  })

  then("the action succeeds and row transitions to 'deleted'")
  expectOk(result, "delete_event")
  expect(app._state.getRow(createdEvent!.id)?.status).toBe("deleted", "row.status after delete")

  then("the dashboard card status reflects the deletion")
  const card = app.state().outputs.find(o => o.rowId === createdEvent!.id)
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
