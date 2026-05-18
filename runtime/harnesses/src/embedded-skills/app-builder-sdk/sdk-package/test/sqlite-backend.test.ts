// Verify SqliteStateBackend:
//   1. Implements StateBackend correctly (parity with InMemoryStateBackend)
//   2. Truly persists — data survives backend recreation against the same DB

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { unlinkSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteStateBackend } from "../src/runtime/state-backend-sqlite.ts"
import { RuntimeState } from "../src/runtime/state.ts"
import { createApp, z, createBridge, type TransportFn } from "../src/index.ts"
import { PINTEREST } from "../reference/pinterest-publishing/provider.ts"
import { buildPinterestApp } from "../reference/pinterest-publishing/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "app-sdk-sqlite-"))
  dbPath = join(tmpDir, "workspace.db")
})

afterEach(() => {
  try { unlinkSync(dbPath) } catch {}
  try { unlinkSync(dbPath + "-wal") } catch {}
  try { unlinkSync(dbPath + "-shm") } catch {}
})

describe("SqliteStateBackend — implements StateBackend with persistence", () => {
  test("CRUD parity: same operations produce same snapshot shape as InMemoryStateBackend", () => {
    const sqlite = new SqliteStateBackend({ dbPath, appId: "t1" })
    const memory = new RuntimeState()

    for (const backend of [sqlite, memory]) {
      backend.setTurnContext({ turnId: "turn_x", sessionId: "sess_x" })
      const row = backend.insertRow("post", { content: "hello" }, "draft")
      backend.updateRow(row.id, { status: "published", externalId: "ext_123" })
      backend.pushAudit("action.start", { foo: "bar" })
      backend.upsertOutput({
        resourceName: "post", rowId: row.id, surface: "content_plan",
        status: "published", summary: "hello", deepLink: "https://x.test/123",
      })
      backend.pushNotification({ level: "info", summary: "all good", agentHint: "carry on" })
      backend.upsertSyncRecord({
        syncName: "metrics", key: "k1", attachedRowId: row.id,
        raw: { views: 5 }, normalized: { reach: 5, engagement: 0, clicks: 0 },
      })
    }

    const sqliteSnap = sqlite.snapshot()
    const memorySnap = memory.snapshot()

    // Shape parity — same counts everywhere
    expect(sqliteSnap.rows.length).toBe(memorySnap.rows.length)
    expect(sqliteSnap.audit.length).toBe(memorySnap.audit.length)
    expect(sqliteSnap.outputs.length).toBe(memorySnap.outputs.length)
    expect(sqliteSnap.notifications.length).toBe(memorySnap.notifications.length)
    expect(sqliteSnap.syncRecords.length).toBe(memorySnap.syncRecords.length)

    // Spot-check specific values
    expect(sqliteSnap.rows[0]!.status).toBe("published")
    expect(sqliteSnap.rows[0]!.externalId).toBe("ext_123")
    expect((sqliteSnap.rows[0]!.data as any).content).toBe("hello")
    expect(sqliteSnap.rows[0]!.createdInTurn).toBe("turn_x")
    expect(sqliteSnap.outputs[0]!.deepLink).toBe("https://x.test/123")
    expect(sqliteSnap.notifications[0]!.level).toBe("info")
    expect(sqliteSnap.notifications[0]!.agentHint).toBe("carry on")

    sqlite.close()
  })

  test("PERSISTENCE: data survives backend recreation against the same DB file", () => {
    // First instance: write
    const b1 = new SqliteStateBackend({ dbPath, appId: "t2" })
    b1.setTurnContext({ turnId: "turn_a", sessionId: "sess_a" })
    const row = b1.insertRow("post", { content: "persistent hi" }, "draft")
    b1.updateRow(row.id, { status: "sent", externalId: "ext_persist" })
    b1.upsertOutput({
      resourceName: "post", rowId: row.id, surface: "ops_log",
      status: "sent", summary: "persistent hi", deepLink: null,
    })
    b1.close()

    // Second instance: read fresh
    const b2 = new SqliteStateBackend({ dbPath, appId: "t2" })
    const persisted = b2.getRow(row.id)
    expect(persisted).toBeDefined()
    expect(persisted!.status).toBe("sent")
    expect(persisted!.externalId).toBe("ext_persist")
    expect((persisted!.data as any).content).toBe("persistent hi")
    expect(persisted!.createdInTurn).toBe("turn_a")

    const snap = b2.snapshot()
    expect(snap.outputs).toHaveLength(1)
    expect(snap.outputs[0]!.summary).toBe("persistent hi")

    b2.close()
  })

  test("ISOLATION: two apps in the same DB don't see each other's rows", () => {
    const slack = new SqliteStateBackend({ dbPath, appId: "slack" })
    const pinterest = new SqliteStateBackend({ dbPath, appId: "pinterest" })

    slack.insertRow("message", { text: "slack hello" }, "sent")
    pinterest.insertRow("pin", { title: "pinterest hello" }, "draft")

    const slackSnap = slack.snapshot()
    const pinterestSnap = pinterest.snapshot()
    expect(slackSnap.rows).toHaveLength(1)
    expect(pinterestSnap.rows).toHaveLength(1)
    expect((slackSnap.rows[0]!.data as any).text).toBe("slack hello")
    expect((pinterestSnap.rows[0]!.data as any).title).toBe("pinterest hello")

    slack.close()
    pinterest.close()
  })

  test("INTEGRATION: a full Pinterest app with SqliteStateBackend runs end-to-end", async () => {
    const sqlite = new SqliteStateBackend({ dbPath, appId: "pinterest" })
    const { app } = buildPinterestApp({ backend: sqlite }) as unknown as { app: AppHandleInternal }
    app._setTurn({ turnId: "t_int", sessionId: "s_int" })

    const calls: any[] = []
    const transport: TransportFn = async (req) => {
      calls.push(req)
      if (req.url.endsWith("/media")) return { status: 200, body: { id: "media_42" } }
      if (req.url.endsWith("/pins")) return { status: 200, body: { id: "pin_42" } }
      throw new Error(`unexpected ${req.url}`)
    }
    const bridge = createBridge({ provider: PINTEREST, transport })

    const row = app._state.insertRow("pin", {
      board_id: "b_1", image_url: "https://x/y.jpg", title: "my pin",
    }, "draft")

    const result = await app._invokeAction({ actionName: "publish", rowId: row.id, bridge })
    expect((result as any).ok).toBe(true)
    expect((result as any).externalId).toBe("pin_42")

    // Row state survived through SQLite
    const finalRow = app._state.getRow(row.id)
    expect(finalRow!.status).toBe("published")
    expect(finalRow!.externalId).toBe("pin_42")
    expect((finalRow!.data as any).media_id).toBe("media_42")  // checkpoint via persist

    // Dashboard card emitted to SQLite
    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card?.status).toBe("published")
    expect(card?.deepLink).toBe("https://pinterest.com/pin/pin_42")

    sqlite.close()
  })
})

