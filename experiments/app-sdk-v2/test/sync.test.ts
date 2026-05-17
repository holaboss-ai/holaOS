// Verifies that app.sync(...) actually runs fetch → upsert → normalize.

import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { PINTEREST } from "../src/providers/pinterest.ts"
import { GITHUB } from "../src/providers/github.ts"
import { SLACK } from "../src/providers/slack.ts"
import { buildPinterestApp } from "../examples/pinterest/app.ts"
import { buildGithubIssuesApp } from "../examples/github-issues/app.ts"
import { buildSlackApp } from "../examples/slack/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let calls: Array<{ method: string; url: string; body?: any }> = []
let scriptedResponses: Array<{ status: number; body: unknown }> = []
const transport: TransportFn = async (req) => {
  calls.push({ method: req.method, url: req.url, body: req.body })
  const next = scriptedResponses.shift()
  if (!next) throw new Error(`no scripted response for ${req.method} ${req.url}`)
  return next
}

describe("Sync — runs fetch + upsert + normalize end-to-end", () => {
  test("Pinterest pin_metrics: fetches analytics for published pins, normalizes to {reach,engagement,clicks}", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildPinterestApp() as unknown as { app: AppHandleInternal }
    app._setTurn({ turnId: "t1", sessionId: "s1" })

    // Seed 2 published pins
    const p1 = app._state.insertRow("pin", { board_id: "b", image_url: "https://x" }, "published")
    app._state.updateRow(p1.id, { externalId: "pin_A" })
    const p2 = app._state.insertRow("pin", { board_id: "b", image_url: "https://y" }, "published")
    app._state.updateRow(p2.id, { externalId: "pin_B" })

    // Script analytics responses for both
    scriptedResponses.push({
      status: 200,
      body: { IMPRESSION: 1000, SAVE: 50, PIN_CLICK: 10, OUTBOUND_CLICK: 5 },
    })
    scriptedResponses.push({
      status: 200,
      body: { IMPRESSION: 500, SAVE: 20, PIN_CLICK: 3, OUTBOUND_CLICK: 1 },
    })

    const r = await app._runSync("pin_metrics", createBridge({ provider: PINTEREST, transport }))
    expect(r.ok).toBe(true)
    expect(r.fetched).toBe(2)
    expect(r.upserted).toBe(2)

    // Sync records stored, normalized correctly
    const records = app.state().syncRecords
    expect(records).toHaveLength(2)
    const first = records.find(s => s.key === p1.id)!
    expect(first.normalized).toEqual({ reach: 1000, engagement: 60, clicks: 5 })
    expect(first.attachedRowId).toBe(p1.id)   // attached to pin row

    // Audit log has sync.start + sync.end
    const events = app.state().audit.map(a => a.event)
    expect(events).toContain("sync.start")
    expect(events).toContain("sync.end")
  })

  test("GitHub issue_activity: fetches open issues, normalizes engagement metrics", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildGithubIssuesApp() as unknown as { app: AppHandleInternal }
    app._setTurn({ turnId: "t1", sessionId: "s1" })

    const i = app._state.insertRow("issue", { repo_full_name: "x/y", title: "Bug" }, "open")
    app._state.updateRow(i.id, { externalId: "42" })

    scriptedResponses.push({
      status: 200,
      body: { reactions: { total_count: 8 }, comments: 4 },
    })

    const r = await app._runSync("issue_activity", createBridge({ provider: GITHUB, transport }))
    expect(r.ok).toBe(true)
    expect(r.fetched).toBe(1)
    expect(r.upserted).toBe(1)

    const rec = app.state().syncRecords.find(s => s.key === i.id)!
    expect(rec.normalized).toEqual({ reach: 8, engagement: 4, clicks: 0 })
  })

  test("Slack channel_directory: lists channels", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
    app._setTurn({ turnId: "t1", sessionId: "s1" })

    scriptedResponses.push({
      status: 200,
      body: { channels: [{ id: "C1", name: "general" }, { id: "C2", name: "random" }] },
    })

    const r = await app._runSync("channel_directory", createBridge({ provider: SLACK, transport }))
    expect(r.ok).toBe(true)
    expect(r.fetched).toBe(2)
    expect(r.upserted).toBe(2)

    const records = app.state().syncRecords
    expect(records).toHaveLength(2)
    expect(records[0]!.normalized).toEqual({ id: "C1", name: "general" })
  })

  test("Sync UPSTREAM ERROR: r.ok=false, notification raised, NOT confused with 'empty success'", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }

    scriptedResponses.push({ status: 500, body: { error: "internal" } })

    const r = await app._runSync("channel_directory", createBridge({ provider: SLACK, transport }))
    expect(r.ok).toBe(false)                  // ← was the regression: silently true before
    expect(r.error?.code).toBe("upstream_error")

    // Notification raised so automations / agent can react
    const notif = app.state().notifications.find(n => n.summary.includes("channel_directory"))
    expect(notif).toBeDefined()
    expect(notif!.level).toBe("error")
    expect(notif!.agentHint).toContain("retry")
  })

  test("Sync UPSTREAM SUCCESS WITH EMPTY: r.ok=true, fetched=0 — distinct from upstream error", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }

    // 200 with empty list = legitimately nothing to sync
    scriptedResponses.push({ status: 200, body: { channels: [] } })

    const r = await app._runSync("channel_directory", createBridge({ provider: SLACK, transport }))
    expect(r.ok).toBe(true)
    expect(r.fetched).toBe(0)
    expect(r.upserted).toBe(0)
    // No error notification for legitimate empty result
    const errNotifs = app.state().notifications.filter(n => n.level === "error")
    expect(errNotifs).toHaveLength(0)
  })

  test("Sync AUTH ERROR: notification hints 'reconnect'", async () => {
    calls = []
    scriptedResponses = []
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }

    scriptedResponses.push({ status: 401, body: { error: "token expired" } })

    const r = await app._runSync("channel_directory", createBridge({ provider: SLACK, transport }))
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("not_connected")
    const notif = app.state().notifications.find(n => n.level === "error")
    expect(notif?.agentHint).toContain("reconnect")
  })

  test("Sync against unknown name throws", async () => {
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
    await expect(app._runSync("nonexistent", createBridge({ provider: SLACK, transport })))
      .rejects.toThrow(/not registered/)
  })

  test("DbView.query.where: filter is type-safe (status comes from resource.states)", async () => {
    calls = []
    scriptedResponses = []
    const { app, pin } = buildPinterestApp() as unknown as { app: AppHandleInternal; pin: any }

    // Insert 3 pins in different states
    app._state.insertRow("pin", { board_id: "b", image_url: "https://1" }, "draft")
    const p2 = app._state.insertRow("pin", { board_id: "b", image_url: "https://2" }, "published")
    app._state.updateRow(p2.id, { externalId: "pin_B" })
    const p3 = app._state.insertRow("pin", { board_id: "b", image_url: "https://3" }, "published")
    app._state.updateRow(p3.id, { externalId: "pin_C" })

    // 2 analytics responses (only published rows should hit the API)
    scriptedResponses.push({ status: 200, body: { IMPRESSION: 100, SAVE: 5, PIN_CLICK: 1, OUTBOUND_CLICK: 0 } })
    scriptedResponses.push({ status: 200, body: { IMPRESSION: 200, SAVE: 10, PIN_CLICK: 2, OUTBOUND_CLICK: 1 } })

    const r = await app._runSync("pin_metrics", createBridge({ provider: PINTEREST, transport }))
    expect(r.fetched).toBe(2)   // only the 2 published, not the draft
  })
})
