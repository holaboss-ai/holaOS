import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { TELEGRAM } from "../reference/telegram-messaging/provider.ts"
import { buildTelegramApp } from "../reference/telegram-messaging/app.ts"
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
  return createBridge({ provider: TELEGRAM, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildTelegramApp() as unknown as { app: AppHandleInternal; message: any; chat: any }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("Telegram — bot messaging state machine", () => {
  test("send_message: draft → sent, persists numeric message_id as string", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "hello",
    }, "draft")
    scriptedResponses.push({
      status: 200,
      body: { ok: true, result: { message_id: 42, chat: { id: 12345 } } },
    })

    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)
    expect((r as any).externalId).toBe("42")
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    expect(app._state.getRow(row.id)!.externalId).toBe("42")

    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("ops_log")
    expect(card!.status).toBe("sent")
  })

  test("edit_message: sent → edited, persists new text", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "old", external_id: "42",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "42" })

    scriptedResponses.push({ status: 200, body: { ok: true, result: true } })
    const r = await app._invokeAction({
      actionName: "edit_message", rowId: row.id, input: { text: "new" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("edited")
    expect((app._state.getRow(row.id)!.data as any).text).toBe("new")
  })

  test("delete_message: sent → deleted", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "bye", external_id: "42",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "42" })

    scriptedResponses.push({ status: 200, body: { ok: true, result: true } })
    const r = await app._invokeAction({ actionName: "delete_message", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("deleted")
  })

  test("react: SIDE EFFECT, does NOT change message status", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "hi", external_id: "42",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "42" })
    app._state.upsertOutput({
      resourceName: "message", rowId: row.id, surface: "ops_log",
      status: "sent", summary: "hi", deepLink: null,
    })

    scriptedResponses.push({ status: 200, body: { ok: true, result: true } })
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "👍" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    const cards = app.state().outputs.filter(o => o.rowId === row.id)
    expect(cards).toHaveLength(1)

    // verify the reaction body shape Telegram requires
    const last = calls.at(-1)!
    expect(last.url).toContain("/setMessageReaction")
    expect(last.body.reaction[0]).toEqual({ type: "emoji", emoji: "👍" })
  })

  test("custom toolName: react uses 'telegram_react' not 'telegram_react_message'", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("telegram_react")
    expect(names).not.toContain("telegram_react_message")
  })

  test("invalid state: trying to react on a draft is rejected", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "x",
    }, "draft")
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "👍" }, bridge: bridge(),
    })
    expect((r as any).fail.code).toBe("invalid_state")
  })

  test("REGRESSION: Telegram returns 200 + {ok:false} → action MUST fail (not silent ok)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "x",
    }, "draft")

    // Real Telegram response shape for errors
    scriptedResponses.push({
      status: 200,
      body: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
    })

    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("telegram_400")
    expect((r as any).fail.message).toContain("chat not found")
    expect(app._state.getRow(row.id)!.status).toBe("failed")
  })

  test("REGRESSION: send_message returns ok but no message_id → fail (not silent success)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "x",
    }, "draft")

    // Malformed Telegram response — defensive guard
    scriptedResponses.push({ status: 200, body: { ok: true, result: {} } })
    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("telegram_missing_message_id")
  })

  test("REGRESSION: delete_message 'message not found' propagates as fail (no swallow)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      chat_id: "12345", text: "x", external_id: "42",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "42" })

    scriptedResponses.push({
      status: 200,
      body: { ok: false, error_code: 400, description: "Bad Request: message to delete not found" },
    })
    const r = await app._invokeAction({ actionName: "delete_message", rowId: row.id, bridge: bridge() })
    expect("fail" in r).toBe(true)
    expect((r as any).fail.code).toBe("telegram_400")
  })
})
