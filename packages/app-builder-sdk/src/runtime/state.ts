// In-memory implementation of StateBackend.
//
// Used by default in tests and dev. Production runtime should inject
// SqliteStateBackend (see state-backend-sqlite.ts) which persists to
// workspace.db + Holaboss runtime state-store.

import type {
  AppState,
  AuditEntry,
  NotificationEntry,
  OutputCard,
  RowRecord,
  StateBackend,
  SyncRecord,
  TurnContext,
} from "../types.ts"

/**
 * In-memory StateBackend. Public fields (rows / audit / outputs / etc.)
 * are exposed for test inspection convenience — production callers should
 * go through the StateBackend interface methods.
 *
 * Name kept as `RuntimeState` for backward compatibility with existing
 * test code accessing `app._state` properties directly.
 */
export class RuntimeState implements StateBackend {
  rows: RowRecord[] = []
  audit: AuditEntry[] = []
  outputs: OutputCard[] = []
  notifications: NotificationEntry[] = []
  syncRecords: SyncRecord[] = []
  turnContext: TurnContext | null = null

  setTurnContext(ctx: TurnContext | null) {
    this.turnContext = ctx
  }

  insertRow(
    resource: string,
    data: Record<string, unknown>,
    status: string,
  ): RowRecord {
    const id = randId()
    const now = new Date().toISOString()
    const row: RowRecord = {
      id, resource, status, data,
      createdInTurn: this.turnContext?.turnId,
      sessionId: this.turnContext?.sessionId,
      createdAt: now, updatedAt: now,
    }
    this.rows.push(row)
    return row
  }

  updateRow(id: string, patch: Partial<RowRecord>): RowRecord {
    const r = this.rows.find(x => x.id === id)
    if (!r) throw new Error(`row ${id} not found`)
    Object.assign(r, patch, { updatedAt: new Date().toISOString() })
    return r
  }

  getRow(id: string): RowRecord | undefined {
    return this.rows.find(x => x.id === id)
  }

  rowsByResource(resource: string): RowRecord[] {
    return this.rows.filter(r => r.resource === resource)
  }

  pushAudit(event: AuditEntry["event"], fields: Record<string, unknown>) {
    this.audit.push({ at: new Date().toISOString(), event, fields })
  }

  upsertOutput(card: Omit<OutputCard, "updatedAt">) {
    const idx = this.outputs.findIndex(
      o => o.resourceName === card.resourceName && o.rowId === card.rowId,
    )
    const updated: OutputCard = { ...card, updatedAt: new Date().toISOString() }
    if (idx >= 0) this.outputs[idx] = updated
    else this.outputs.push(updated)
  }

  pushNotification(n: Omit<NotificationEntry, "at">) {
    this.notifications.push({ ...n, at: new Date().toISOString() })
  }

  upsertSyncRecord(rec: Omit<SyncRecord, "syncedAt">) {
    const idx = this.syncRecords.findIndex(
      s => s.syncName === rec.syncName && s.key === rec.key,
    )
    const updated: SyncRecord = { ...rec, syncedAt: new Date().toISOString() }
    if (idx >= 0) this.syncRecords[idx] = updated
    else this.syncRecords.push(updated)
  }

  snapshot(): AppState {
    return {
      rows: [...this.rows],
      audit: [...this.audit],
      outputs: [...this.outputs],
      notifications: [...this.notifications],
      syncRecords: [...this.syncRecords],
      derivedTools: [],
    }
  }
}

function randId() {
  return `r_${Math.random().toString(36).slice(2, 10)}`
}
