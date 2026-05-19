import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { GCALENDAR } from "../reference/gcalendar-events/provider.ts"
import { buildGcalendarApp } from "../reference/gcalendar-events/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let calls: Array<{ method: string; url: string; body?: any }> = []
let scriptedResponses: Array<{ status: number; body: unknown }> = []
const transport: TransportFn = async (req) => {
  calls.push({ method: req.method, url: req.url, body: req.body })
  const next = scriptedResponses.shift()
  if (!next) throw new Error(`no scripted response for ${req.method} ${req.url}`)
  return next
}
function bridge() {
  return createBridge({ provider: GCALENDAR, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildGcalendarApp() as unknown as {
    app: AppHandleInternal
    event: any
    calendar: any
  }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("Google Calendar — event lifecycle", () => {
  test("create_event: draft → confirmed, externalId persisted", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      {
        calendar_id: "primary",
        summary: "Team standup",
        start_time: "2026-06-01T14:00:00-07:00",
        end_time: "2026-06-01T14:30:00-07:00",
        time_zone: "America/Los_Angeles",
      },
      "draft",
    )
    scriptedResponses.push({
      status: 200,
      body: { id: "evt_abc", htmlLink: "https://calendar.google.com/..." },
    })

    const r = await app._invokeAction({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect(r).toEqual({ ok: true, externalId: "evt_abc" })

    const final = app._state.getRow(row.id)!
    expect(final.status).toBe("confirmed")
    expect(final.externalId).toBe("evt_abc")

    // The action body should carry intrinsic event timing — proves the
    // start_time/end_time live with the event, not the SDK scheduler.
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toContain("/calendars/primary/events")
    expect(calls[0].body.start.dateTime).toBe("2026-06-01T14:00:00-07:00")
    expect(calls[0].body.end.dateTime).toBe("2026-06-01T14:30:00-07:00")

    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("ops_log")
    expect(card!.status).toBe("confirmed")
    expect(card!.summary).toContain("Team standup")
    expect(card!.deepLink).toContain("eid=evt_abc")
  })

  test("recurring event: one row, RRULE forwarded to upstream", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      {
        calendar_id: "primary",
        summary: "Weekly 1:1",
        start_time: "2026-06-01T10:00:00-07:00",
        end_time: "2026-06-01T10:30:00-07:00",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
      "draft",
    )
    scriptedResponses.push({ status: 200, body: { id: "evt_recur", htmlLink: "..." } })

    await app._invokeAction({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })

    expect(calls[0].body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"])
    // One row, not N — occurrences stay upstream-only.
    expect(app._state.snapshot().rows.filter(r => r.resource === "event")).toHaveLength(1)
  })

  test("create_event is idempotent: replaying with same row skips upstream POST", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      {
        calendar_id: "primary",
        summary: "Once",
        start_time: "2026-06-01T14:00:00-07:00",
        end_time: "2026-06-01T15:00:00-07:00",
      },
      "draft",
    )
    scriptedResponses.push({ status: 200, body: { id: "evt_once", htmlLink: "..." } })

    const r1 = await app._invokeAction({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((r1 as any).externalId).toBe("evt_once")
    expect(calls).toHaveLength(1)

    // Simulate automations retry: put the row back into draft (as a
    // hypothetical caller-driven re-run) and replay. The action MUST notice
    // external_id is already set and refuse to double-POST.
    app._state.updateRow(row.id, { status: "draft" })

    const r2 = await app._invokeAction({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((r2 as any).ok).toBe(true)
    expect((r2 as any).externalId).toBe("evt_once")
    // No new upstream call.
    expect(calls).toHaveLength(1)
    expect(app._state.getRow(row.id)!.status).toBe("confirmed")
  })

  test("cancel_event: confirmed → cancelled (soft, body.status=cancelled)", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      { calendar_id: "primary", summary: "x", start_time: "t1", end_time: "t2" },
      "confirmed",
    )
    app._state.updateRow(row.id, { externalId: "evt_xyz" })

    scriptedResponses.push({ status: 200, body: { id: "evt_xyz", status: "cancelled" } })
    const r = await app._invokeAction({
      actionName: "cancel_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("cancelled")
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].body).toEqual({ status: "cancelled" })
  })

  test("rsvp: side effect, does NOT change event.status, merges attendees", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      {
        calendar_id: "primary",
        summary: "Big meeting",
        start_time: "t1",
        end_time: "t2",
        attendees: [
          { email: "host@example.com" },
          { email: "me@example.com" },
        ],
      },
      "confirmed",
    )
    app._state.updateRow(row.id, { externalId: "evt_invited" })
    app._state.upsertOutput({
      resourceName: "event",
      rowId: row.id,
      surface: "ops_log",
      status: "confirmed",
      summary: "Big meeting",
      deepLink: null,
    })

    scriptedResponses.push({ status: 200, body: { id: "evt_invited" } })
    const r = await app._invokeAction({
      actionName: "rsvp",
      rowId: row.id,
      input: { response: "accepted", self_email: "me@example.com" },
      bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("confirmed") // unchanged

    const sentAttendees = calls[0].body.attendees as Array<any>
    const me = sentAttendees.find(a => a.email === "me@example.com")
    const host = sentAttendees.find(a => a.email === "host@example.com")
    expect(me.responseStatus).toBe("accepted")
    expect(host).toBeDefined()
    expect(host.responseStatus).toBeUndefined()

    // Dashboard card untouched
    const cards = app.state().outputs.filter(o => o.rowId === row.id)
    expect(cards).toHaveLength(1)
    expect(cards[0].status).toBe("confirmed")
  })

  test("invalid state: cancel_event on a draft is rejected", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      { calendar_id: "primary", summary: "x", start_time: "t1", end_time: "t2" },
      "draft",
    )
    const r = await app._invokeAction({
      actionName: "cancel_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((r as any).fail.code).toBe("invalid_state")
    expect((r as any).fail.message).toContain("from state 'draft'")
  })

  test("auth error on create_event lands row in 'failed' with reauth hint", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      { calendar_id: "primary", summary: "x", start_time: "t1", end_time: "t2" },
      "draft",
    )
    scriptedResponses.push({
      status: 401,
      body: { error: "Invalid Credentials" },
    })
    const r = await app._invokeAction({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((r as any).fail.code).toBe("not_connected")
    expect(app._state.getRow(row.id)!.status).toBe("failed")
    expect(app.state().notifications[0].agentHint).toContain("reconnect")
  })

  test("create_event reversible: confirmed → draft + DELETE upstream", async () => {
    const { app } = setup()
    const row = app._state.insertRow(
      "event",
      { calendar_id: "primary", summary: "x", start_time: "t1", end_time: "t2" },
      "draft",
    )
    scriptedResponses.push({ status: 200, body: { id: "evt_kill", htmlLink: "..." } })
    await app._invokeAction({ actionName: "create_event", rowId: row.id, bridge: bridge() })

    scriptedResponses.push({ status: 204, body: null })
    const rev = await app._invokeReverse({
      actionName: "create_event",
      rowId: row.id,
      bridge: bridge(),
    })
    expect((rev as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("draft")
    expect(calls.at(-1)?.method).toBe("DELETE")
    expect(calls.at(-1)?.url).toContain("evt_kill")
  })

  test("derived tools include create/update/cancel/delete/rsvp + reverse + sync", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("gcalendar_connection_status")
    expect(names).toContain("gcalendar_create_event_event")
    expect(names).toContain("gcalendar_cancel_create_event_event") // reversible
    expect(names).toContain("gcalendar_update_event_event")
    expect(names).toContain("gcalendar_cancel_event_event")
    expect(names).toContain("gcalendar_delete_event_event")
    expect(names).toContain("gcalendar_rsvp") // toolName override
    expect(names).toContain("gcalendar_list_events")
    expect(names).toContain("gcalendar_list_calendars")
    expect(names).toContain("gcalendar_refresh_calendars")
    expect(names).toContain("gcalendar_upcoming_events_sync_status")
    expect(names).toContain("gcalendar_snapshot")
  })
})
