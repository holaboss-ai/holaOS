// Pinterest — publishing-shape app with multi-step publish.

import { createApp, z } from "../../src/index.ts"
import { PINTEREST } from "../../src/providers/pinterest.ts"

export function buildPinterestApp() {
  const app = createApp({
    id: "pinterest",
    provider: PINTEREST,
    description: "Pinterest pin publishing & board management",
  })

  app.connection()

  // ─── Board: container, read-mostly, NOT in dashboard ─────────────────────
  const board = app.resource("board", {
    schema: z.object({ id: z.string(), name: z.string() }),
    states: ["cached"] as const,
    initialState: "cached",
    emit: { surface: "none" },
    refreshEvery: "1h",
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{ items: { id: string; name: string }[] }>("GET", "/boards")
      if (r.kind === "error") throw r
      return r.data.items
    },
  })

  // ─── Pin: publishing-shape ───────────────────────────────────────────────
  const pin = app.resource("pin", {
    schema: z.object({
      board_id: board.ref(),
      image_url: z.string().url(),
      title: z.string().max(100).optional(),
      description: z.string().max(500).optional(),
      media_id: z.string().optional(),       // checkpoint field, set after upload step
    }),
    states: ["draft", "scheduled", "published", "failed"] as const,
    initialState: "draft",
    failedState: "failed",
    emit: {
      surface: "content_plan",
      summary: r => r.title ?? r.description?.slice(0, 50) ?? "Untitled pin",
      deepLink: r => r.external_id ? `https://pinterest.com/pin/${r.external_id}` : null,
    },
  })

  app.action(pin, "publish", {
    fromStates: ["draft"],
    toState: "published",
    reversible: {
      toState: "draft",
      run: async ({ row, bridge }) => {
        if (row.external_id) {
          const r = await bridge.call("DELETE", `/pins/${row.external_id}`)
          if (r.kind === "error" && r.code !== "not_found") return { fail: r }
        }
        return { ok: true }
      },
    },
    steps: [
      {
        name: "upload_media",
        run: async ({ row, bridge, persist }) => {
          if (row.media_id) return { ok: true }   // idempotent: already uploaded
          const r = await bridge.call<{ id: string }>("POST", "/media", {
            media_type: "image",
            url: row.image_url,
          })
          if (r.kind === "error") return { fail: r }
          await persist({ media_id: r.data.id })
          return { ok: true }
        },
      },
      {
        name: "create_pin",
        run: async ({ row, bridge }) => {
          if (row.external_id) return { ok: true, externalId: row.external_id }
          const r = await bridge.call<{ id: string }>("POST", "/pins", {
            board_id: row.board_id,
            media_source: { source_type: "image_upload", media_id: row.media_id },
            title: row.title,
            description: row.description,
          })
          if (r.kind === "error") return { fail: r }
          return { ok: true, externalId: r.data.id }
        },
      },
    ],
  })

  app.action(pin, "edit", {
    fromStates: ["draft", "published"],
    toState: "published",
    schema: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    run: async ({ row, input, bridge, persist }) => {
      if (row.status === "draft") {
        await persist(input)
        return { ok: true }
      }
      const r = await bridge.call("PATCH", `/pins/${row.external_id}`, input)
      if (r.kind === "error") return { fail: r }
      await persist(input)
      return { ok: true }
    },
  })

  app.sync("pin_metrics", {
    schedule: "0 */6 * * *",
    attachTo: pin,
    fetch: async ({ bridge, db }) => {
      const pins = db.query(pin).where({ status: "published" }).recent("30d")
      const results: { pin_id: string; raw: Record<string, number> }[] = []
      for (const p of pins) {
        if (!p.external_id) continue
        const r = await bridge.call<Record<string, number>>(
          "GET",
          `/pins/${p.external_id}/analytics?metric_types=SAVE,PIN_CLICK,IMPRESSION,OUTBOUND_CLICK`,
        )
        if (r.kind === "error") return { ok: false, error: r }
        results.push({ pin_id: p.id, raw: r.data })
      }
      return { ok: true, items: results }
    },
    upsert: { key: "pin_id" },
    normalize: raw => ({
      reach: raw.raw.IMPRESSION ?? 0,
      engagement: (raw.raw.SAVE ?? 0) + (raw.raw.PIN_CLICK ?? 0),
      clicks: raw.raw.OUTBOUND_CLICK ?? 0,
    }),
  })

  return { app, pin, board }
}
