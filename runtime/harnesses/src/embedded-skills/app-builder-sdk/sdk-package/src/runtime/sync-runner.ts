// Executes a registered sync.
// SDK does NOT schedule — automations or tests call runSync().
//
// fetch() MUST return { ok: true, items } | { ok: false, error }. The runner
// distinguishes "upstream returned 0 items" (ok: true, items: []) from
// "upstream failed" (ok: false) — the latter triggers app.notify and reports
// failure to the caller so automations can retry intelligently.

import type { BridgeClient, ResourceHandle, StateBackend, SyncDef } from "../types.ts"
import { createDbView } from "./db-view.ts"

interface RunSyncOpts {
  appId: string
  syncName: string
  syncDef: SyncDef<any, any, any>
  bridge: BridgeClient
  state: StateBackend
}

export interface SyncRunResult {
  ok: boolean
  fetched: number
  upserted: number
  error?: { code: string; message: string }
}

export async function runSync(opts: RunSyncOpts): Promise<SyncRunResult> {
  const { appId, syncName, syncDef, bridge, state } = opts
  const startTime = Date.now()

  state.pushAudit("sync.start", { app: appId, sync: syncName })

  const db = createDbView(state)
  let fetchResult
  try {
    fetchResult = await syncDef.fetch({ bridge, db })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    state.pushAudit("sync.end", {
      app: appId, sync: syncName, outcome: "fail",
      total_ms: Date.now() - startTime, error: msg,
    })
    state.pushNotification({
      level: "warning",
      summary: `${appId} sync '${syncName}' threw: ${msg}`,
      agentHint: "Sync will retry on next automation tick.",
    })
    return { ok: false, fetched: 0, upserted: 0, error: { code: "fetch_threw", message: msg } }
  }

  if (!fetchResult.ok) {
    const err = fetchResult.error
    state.pushAudit("sync.end", {
      app: appId, sync: syncName, outcome: "fail",
      total_ms: Date.now() - startTime, error: err,
    })
    const isAuth = err.code === "not_connected"
    state.pushNotification({
      level: "error",
      summary: `${appId} sync '${syncName}' upstream failed: ${err.message}`,
      agentHint: isAuth
        ? "Connection expired; ask user to reconnect."
        : "Sync will retry on next automation tick.",
    })
    return { ok: false, fetched: 0, upserted: 0, error: { code: err.code, message: err.message } }
  }

  const rawList = fetchResult.items
  const keyField = syncDef.upsert.key
  let upserted = 0
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const key = String(r[keyField] ?? "")
    if (!key) continue

    let normalized: Record<string, unknown> = {}
    try {
      normalized = syncDef.normalize(raw) as Record<string, unknown>
    } catch {
      continue
    }

    let attachedRowId = ""
    if (syncDef.attachTo) {
      const attachResource = syncDef.attachTo as ResourceHandle<any, any>
      const matched = state.rowsByResource(attachResource.name).find(
        rr => rr.id === key || rr.externalId === key,
      )
      attachedRowId = matched?.id ?? ""
    }

    state.upsertSyncRecord({ syncName, attachedRowId, key, raw: r, normalized })
    upserted++
  }

  state.pushAudit("sync.end", {
    app: appId, sync: syncName, outcome: "ok",
    fetched: rawList.length, upserted,
    total_ms: Date.now() - startTime,
  })

  return { ok: true, fetched: rawList.length, upserted }
}
