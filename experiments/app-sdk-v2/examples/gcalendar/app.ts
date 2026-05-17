// Google Calendar — event-shape app.
//
// Event start_time/end_time are intrinsic event attributes (the user books
// a meeting for March 5 at 2pm). This is NOT the "schedule this action to
// run later" concept — that lives in Holaboss automations.

import { createApp, z } from "../../src/index.ts"
import { GCALENDAR } from "../../src/providers/gcalendar.ts"

export function buildGcalendarApp() {
  const app = createApp({
    id: "gcalendar",
    provider: GCALENDAR,
    description: "Google Calendar event management",
  })

  app.connection()

  const calendar = app.resource("calendar", {
    schema: z.object({
      id: z.string(),
      summary: z.string(),
      time_zone: z.string().optional(),
      primary: z.boolean().optional(),
    }),
    states: ["cached"] as const,
    initialState: "cached",
    emit: { surface: "none" },
    refreshEvery: "6h",
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{
        items: { id: string; summary: string; timeZone?: string; primary?: boolean }[]
      }>("GET", "/users/me/calendarList")
      if (r.kind === "error") throw r
      return r.data.items.map(c => ({
        id: c.id, summary: c.summary, time_zone: c.timeZone, primary: c.primary,
      }))
    },
  })

  const event = app.resource("event", {
    schema: z.object({
      calendar_id: calendar.ref(),
      summary: z.string().max(1024),
      description: z.string().optional(),
      location: z.string().optional(),
      start_time: z.string(),
      end_time: z.string(),
      time_zone: z.string().optional(),
      recurrence: z.array(z.string()).optional(),
      attendees: z.array(z.object({
        email: z.string().email(),
        optional: z.boolean().optional(),
        responseStatus: z.string().optional(),
      })).optional(),
    }),
    states: ["draft", "confirmed", "cancelled", "deleted", "failed"] as const,
    initialState: "draft",
    failedState: "failed",
    emit: {
      surface: "ops_log",
      summary: r => `${r.summary} @ ${r.start_time}`,
      deepLink: r => r.external_id && r.calendar_id
        ? `https://calendar.google.com/calendar/event?eid=${r.external_id}`
        : null,
    },
  })

  app.action(event, "create_event", {
    fromStates: ["draft"],
    toState: "confirmed",
    reversible: {
      toState: "draft",
      run: async ({ row, bridge }) => {
        if (!row.external_id) return { ok: true }
        const r = await bridge.call(
          "DELETE",
          `/calendars/${encodeURIComponent(row.calendar_id)}/events/${row.external_id}`,
        )
        if (r.kind === "error" && r.code !== "not_found") return { fail: r }
        return { ok: true }
      },
    },
    run: async ({ row, bridge }) => {
      if (row.external_id) return { ok: true, externalId: row.external_id }  // idempotent
      const body: Record<string, unknown> = {
        summary: row.summary,
        description: row.description,
        location: row.location,
        start: { dateTime: row.start_time, timeZone: row.time_zone },
        end: { dateTime: row.end_time, timeZone: row.time_zone },
      }
      if (row.recurrence) body.recurrence = row.recurrence
      if (row.attendees) body.attendees = row.attendees

      const r = await bridge.call<{ id: string }>(
        "POST",
        `/calendars/${encodeURIComponent(row.calendar_id)}/events`,
        body,
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true, externalId: r.data.id }
    },
  })

  app.action(event, "update_event", {
    fromStates: ["confirmed"],
    toState: "confirmed",
    schema: z.object({
      summary: z.string().max(1024).optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
    }),
    run: async ({ row, input, bridge, persist }) => {
      const patch: Record<string, unknown> = {}
      if (input.summary !== undefined) patch.summary = input.summary
      if (input.description !== undefined) patch.description = input.description
      if (input.location !== undefined) patch.location = input.location
      if (input.start_time) patch.start = { dateTime: input.start_time, timeZone: row.time_zone }
      if (input.end_time) patch.end = { dateTime: input.end_time, timeZone: row.time_zone }

      const r = await bridge.call(
        "PATCH",
        `/calendars/${encodeURIComponent(row.calendar_id)}/events/${row.external_id}`,
        patch,
      )
      if (r.kind === "error") return { fail: r }
      await persist(input)
      return { ok: true }
    },
  })

  app.action(event, "cancel_event", {
    fromStates: ["confirmed"],
    toState: "cancelled",
    run: async ({ row, bridge }) => {
      const r = await bridge.call(
        "PATCH",
        `/calendars/${encodeURIComponent(row.calendar_id)}/events/${row.external_id}`,
        { status: "cancelled" },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.action(event, "delete_event", {
    fromStates: ["draft", "confirmed", "cancelled"],
    toState: "deleted",
    run: async ({ row, bridge }) => {
      if (row.external_id) {
        const r = await bridge.call(
          "DELETE",
          `/calendars/${encodeURIComponent(row.calendar_id)}/events/${row.external_id}`,
        )
        if (r.kind === "error" && r.code !== "not_found") return { fail: r }
      }
      return { ok: true }
    },
  })

  app.action(event, "rsvp", {
    fromStates: ["confirmed"],
    toState: null,
    toolName: "gcalendar_rsvp",
    schema: z.object({
      response: z.enum(["accepted", "declined", "tentative"]),
      self_email: z.string().email(),
    }),
    run: async ({ row, input, bridge }) => {
      const existing = row.attendees ?? []
      const others = existing.filter(a => a.email !== input.self_email)
      const me = existing.find(a => a.email === input.self_email) ?? { email: input.self_email }
      const nextAttendees = [...others, { ...me, responseStatus: input.response }]

      const r = await bridge.call(
        "PATCH",
        `/calendars/${encodeURIComponent(row.calendar_id)}/events/${row.external_id}`,
        { attendees: nextAttendees },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.sync("upcoming_events", {
    schedule: "*/15 * * * *",
    attachTo: event,
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{
        items: {
          id: string
          summary?: string
          status: string
          start?: { dateTime?: string; date?: string }
          end?: { dateTime?: string; date?: string }
        }[]
      }>("GET", "/calendars/primary/events?singleEvents=false&maxResults=50")
      if (r.kind === "error") return { ok: false, error: r }
      return { ok: true, items: r.data.items }
    },
    upsert: { key: "id" },
    normalize: raw => ({
      external_id: raw.id,
      summary: raw.summary ?? "(no title)",
      start_time: raw.start?.dateTime ?? raw.start?.date ?? "",
      end_time: raw.end?.dateTime ?? raw.end?.date ?? "",
      upstream_status: raw.status,
    }),
  })

  return { app, calendar, event }
}
