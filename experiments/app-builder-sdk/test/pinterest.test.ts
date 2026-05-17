import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { PINTEREST } from "../reference/pinterest-publishing/provider.ts"
import { buildPinterestApp } from "../reference/pinterest-publishing/app.ts"
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
  return createBridge({ provider: PINTEREST, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildPinterestApp() as unknown as { app: AppHandleInternal; pin: any; board: any }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("Pinterest — publishing shape works end-to-end", () => {
  test("happy path 2-step publish lands in 'published'", async () => {
    const { app } = setup()
    const row = app._state.insertRow("pin", {
      board_id: "b_42", image_url: "https://example.com/cat.jpg", title: "My cat",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { id: "media_999" } })
    scriptedResponses.push({ status: 200, body: { id: "pin_777" } })

    const result = await app._invokeAction({ actionName: "publish", rowId: row.id, bridge: bridge() })
    expect(result).toEqual({ ok: true, externalId: "pin_777" })

    const final = app._state.getRow(row.id)!
    expect(final.status).toBe("published")
    expect(final.externalId).toBe("pin_777")
    expect((final.data as any).media_id).toBe("media_999")
    expect(final.createdInTurn).toBe("turn_1")

    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("content_plan")
    expect(card!.status).toBe("published")
    expect(card!.summary).toBe("My cat")
    expect(card!.deepLink).toBe("https://pinterest.com/pin/pin_777")
  })

  test("partial success → row lands in 'failed' (declared failedState)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("pin", {
      board_id: "b_42", image_url: "https://x", title: "x",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { id: "media_999" } })
    scriptedResponses.push({ status: 500, body: { error: "internal" } })

    const result = await app._invokeAction({ actionName: "publish", rowId: row.id, bridge: bridge() })
    expect("fail" in result).toBe(true)
    const final = app._state.getRow(row.id)!
    expect(final.status).toBe("failed")
    expect((final.data as any).media_id).toBe("media_999")
  })

  test("reversible publish: cancel returns row to 'draft' and deletes upstream", async () => {
    const { app } = setup()
    const row = app._state.insertRow("pin", {
      board_id: "b_42", image_url: "https://x", title: "x",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { id: "media_999" } })
    scriptedResponses.push({ status: 200, body: { id: "pin_777" } })
    await app._invokeAction({ actionName: "publish", rowId: row.id, bridge: bridge() })
    expect(app._state.getRow(row.id)!.status).toBe("published")

    // Now cancel
    scriptedResponses.push({ status: 204, body: null })   // DELETE returns 204
    const r = await app._invokeReverse({ actionName: "publish", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("draft")
    expect(calls.at(-1)?.method).toBe("DELETE")
  })

  test("derived tools include reverse + connection + snapshot + sync", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("pinterest_connection_status")
    expect(names).toContain("pinterest_publish_pin")
    expect(names).toContain("pinterest_cancel_publish_pin")   // reversible
    expect(names).toContain("pinterest_edit_pin")
    expect(names).toContain("pinterest_list_pins")
    expect(names).toContain("pinterest_list_boards")
    expect(names).toContain("pinterest_refresh_boards")
    expect(names).toContain("pinterest_pin_metrics_sync_status")
    expect(names).toContain("pinterest_snapshot")
  })

  test("auth error surfaces with reauth hint", async () => {
    const { app } = setup()
    const row = app._state.insertRow("pin", { board_id: "x", image_url: "https://x", title: "x" }, "draft")
    scriptedResponses.push({ status: 401, body: { error: "expired" } })
    const result = await app._invokeAction({ actionName: "publish", rowId: row.id, bridge: bridge() })
    expect((result as any).fail.code).toBe("not_connected")
    expect(app.state().notifications[0].agentHint).toContain("reconnect")
  })
})
