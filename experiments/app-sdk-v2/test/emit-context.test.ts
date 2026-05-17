// Locks in the syncOutput fix: emit.summary / emit.deepLink callbacks receive
// row with id, status, and external_id populated — not just the schema fields.

import { describe, test, expect } from "bun:test"
import { createApp, z, createBridge, type TransportFn } from "../src/index.ts"
import { PINTEREST } from "../src/providers/pinterest.ts"
import type { AppHandleInternal } from "../src/app.ts"

const transport: TransportFn = async () => ({ status: 200, body: { id: "extern_42" } })
const bridge = () => createBridge({ provider: PINTEREST, transport })

function appWithIdInSummary() {
  const app = createApp({ id: "test", provider: PINTEREST })
  app.connection()

  const thing = app.resource("thing", {
    schema: z.object({ name: z.string() }),
    states: ["draft", "active"] as const,
    initialState: "draft",
    emit: {
      surface: "content_plan",
      // ★ THIS is the regression check: row.id / row.status / row.external_id
      // MUST be defined when emit callbacks fire. Old action-runner only spread
      // rowData + external_id, leaving id and status undefined.
      summary: r => `${r.id}|${r.status}|${r.name}|${r.external_id ?? "no-ext"}`,
      deepLink: r => `https://x.test/${r.id}/${r.external_id ?? "none"}`,
    },
  })

  app.action(thing, "activate", {
    fromStates: ["draft"],
    toState: "active",
    run: async ({ bridge }) => {
      const r = await bridge.call<{ id: string }>("POST", "/things")
      if (r.kind === "error") return { fail: r }
      return { ok: true, externalId: r.data.id }
    },
  })

  return app as unknown as AppHandleInternal
}

describe("emit callbacks receive complete row (id, status, external_id)", () => {
  test("after action.toState transition: emit row has id + status + external_id", async () => {
    const app = appWithIdInSummary()
    const row = app._state.insertRow("thing", { name: "widget" }, "draft")

    await app._invokeAction({ actionName: "activate", rowId: row.id, bridge: bridge() })

    const card = app.state().outputs.find(o => o.rowId === row.id)!
    expect(card.summary).toBe(`${row.id}|active|widget|extern_42`)
    expect(card.deepLink).toBe(`https://x.test/${row.id}/extern_42`)

    // Before fix: would have been "undefined|undefined|widget|extern_42"
  })
})
