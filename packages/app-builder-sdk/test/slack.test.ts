import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { SLACK } from "../reference/slack-messaging/provider.ts"
import { buildSlackApp } from "../reference/slack-messaging/app.ts"
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
  return createBridge({ provider: SLACK, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildSlackApp() as unknown as { app: AppHandleInternal; message: any; channel: any }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("Slack — Slack's own states (sent/scheduled/edited/deleted)", () => {
  test("send_message: draft → sent (not 'published')", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "hello world",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { ok: true, ts: "1234.567", channel: "C123" } })

    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect(r).toEqual({ ok: true, externalId: "1234.567" })
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    expect(app._state.getRow(row.id)!.externalId).toBe("1234.567")

    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("ops_log")
    expect(card!.status).toBe("sent")
  })

  test("schedule_send + reverse: scheduled → draft (real upstream cancel)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "later",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { ok: true, scheduled_message_id: "Q123", post_at: 999 } })
    await app._invokeAction({
      actionName: "schedule_send",
      rowId: row.id,
      input: { post_at: 999 },
      bridge: bridge(),
    })
    expect(app._state.getRow(row.id)!.status).toBe("scheduled")

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const rev = await app._invokeReverse({ actionName: "schedule_send", rowId: row.id, bridge: bridge() })
    expect((rev as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("draft")
    expect(calls.at(-1)?.url).toContain("deleteScheduledMessage")
  })

  test("edit_message: sent → edited", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "old", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({
      actionName: "edit_message", rowId: row.id, input: { text: "new" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("edited")
    expect((app._state.getRow(row.id)!.data as any).text).toBe("new")
  })

  test("react: SIDE EFFECT, does NOT change message status", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "hi", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })
    app._state.upsertOutput({
      resourceName: "message", rowId: row.id, surface: "ops_log",
      status: "sent", summary: "hi", deepLink: null,
    })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "thumbsup" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    const cards = app.state().outputs.filter(o => o.rowId === row.id)
    expect(cards).toHaveLength(1)
    expect(cards[0].status).toBe("sent")
  })

  test("custom toolName: react uses 'slack_react' not 'slack_react_message'", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("slack_react")
    expect(names).not.toContain("slack_react_message")
  })

  test("invalid state: trying to react on a draft is rejected", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "x",
    }, "draft")
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "ok" }, bridge: bridge(),
    })
    expect((r as any).fail.code).toBe("invalid_state")
  })

  test("delete_message: sent → deleted", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "bye", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({ actionName: "delete_message", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("deleted")
  })

  // ─── Regression: real-Slack bugs found by E2E ────────────────────────────

  test("REGRESSION: Slack returns 200 + {ok:false} → action MUST fail (not silent ok)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "x",
    }, "draft")

    // The exact pattern that real Slack uses for content/permission errors:
    // HTTP 200, body says ok:false. Old code only checked HTTP status and
    // treated this as success.
    scriptedResponses.push({ status: 200, body: { ok: false, error: "channel_not_found" } })

    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("channel_not_found")
    // Row should be marked failed (via failedState), NOT 'sent'
    expect(app._state.getRow(row.id)!.status).toBe("failed")
  })

  test("REGRESSION: Slack DM resolves user_id → DM channel; persisted back to row", async () => {
    const { app } = setup()
    // Agent sends to user_id (DM-self pattern); Slack auto-resolves to DM channel id
    const row = app._state.insertRow("message", {
      channel_id: "U07XXXX",       // user_id, not a real channel
      text: "hello self",
    }, "draft")

    scriptedResponses.push({
      status: 200,
      body: { ok: true, ts: "1700000000.111111", channel: "D0DMCHAN" },  // ← Slack returns DM channel
    })
    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)

    // ★ The row.channel_id was overwritten with the DM channel id Slack actually addresses.
    // Without this, subsequent edit/delete/react would hit a wrong channel and silently fail.
    expect((app._state.getRow(row.id)!.data as any).channel_id).toBe("D0DMCHAN")
  })

  test("REGRESSION: schedule_send reverse propagates ALL errors (no swallow not_found)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "later", external_id: "Q123",
    }, "scheduled")
    app._state.updateRow(row.id, { externalId: "Q123" })

    // Slack says the scheduled message no longer exists — old code swallowed this
    // as success. But "not_found" might mean upstream actually fired the message;
    // agent must see the failure and decide.
    scriptedResponses.push({ status: 200, body: { ok: false, error: "not_found" } })
    const r = await app._invokeReverse({ actionName: "schedule_send", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("not_found")
  })

  test("REGRESSION: schedule_send persists DM channel from response (verified via chat.scheduledMessages.list)", async () => {
    const { app } = setup()
    // Agent schedules to a user_id (DM-self pattern)
    const row = app._state.insertRow("message", {
      channel_id: "U07XXXX", text: "later",
    }, "draft")

    // Slack returns the DM channel. Slack's own chat.scheduledMessages.list
    // verifies the message is stored under that DM channel — so the reverse
    // (chat.deleteScheduledMessage) must use the DM channel too.
    scriptedResponses.push({
      status: 200,
      body: {
        ok: true,
        scheduled_message_id: "Q0ABCDE",
        post_at: 1700000060,
        channel: "D0DMCHAN",
      },
    })
    const r = await app._invokeAction({
      actionName: "schedule_send",
      rowId: row.id,
      input: { post_at: 1700000060 },
      bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect((app._state.getRow(row.id)!.data as any).channel_id).toBe("D0DMCHAN")
  })

  test("REGRESSION: invalid_scheduled_message_id from delete propagates as fail (Slack's 60s rule)", async () => {
    const { app } = setup()
    // Setup: row already in 'scheduled' state with persisted DM channel
    const row = app._state.insertRow("message", {
      channel_id: "D0DMCHAN", text: "x", external_id: "Q0LATE",
    }, "scheduled")
    app._state.updateRow(row.id, { externalId: "Q0LATE" })

    // Real Slack behavior: if cancel is invoked <60s before post_at, Slack returns
    // invalid_scheduled_message_id (message has graduated out of the cancellable queue).
    // Action MUST propagate as fail, NOT silently claim success.
    scriptedResponses.push({
      status: 200,
      body: { ok: false, error: "invalid_scheduled_message_id" },
    })
    const r = await app._invokeReverse({ actionName: "schedule_send", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("invalid_scheduled_message_id")
    // Row stays in 'scheduled' — agent must know the cancel didn't succeed
    expect(app._state.getRow(row.id)!.status).toBe("scheduled")
  })
})
