// SQLite-backed StateBackend — production implementation.
//
// Uses bun:sqlite to open the workspace shared DB (WORKSPACE_DB_PATH) and
// keeps all SDK state in app-owned tables prefixed with the app id.
//
// This iteration intentionally does NOT bridge to @holaboss/runtime-state-store's
// `outputs` / `runtime_notifications` tables — those mappings come in a follow-up
// iteration. For now, outputs and notifications are persisted in app-owned
// tables; once we wire to state-store, those tables can be backfilled or
// migrated.

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
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

export interface SqliteStateBackendOpts {
  /** Filesystem path to the workspace SQLite database. */
  dbPath: string
  /** App id — used as table prefix so multiple SDK apps share workspace.db cleanly. */
  appId: string
}

export class SqliteStateBackend implements StateBackend {
  private db: Database
  private appId: string
  private turnContext: TurnContext | null = null

  // Pre-compiled statements
  private stmts: {
    insertRow: ReturnType<Database["prepare"]>
    updateRow: ReturnType<Database["prepare"]>
    getRow: ReturnType<Database["prepare"]>
    rowsByResource: ReturnType<Database["prepare"]>
    listAllRows: ReturnType<Database["prepare"]>
    insertAudit: ReturnType<Database["prepare"]>
    listAudit: ReturnType<Database["prepare"]>
    upsertOutput: ReturnType<Database["prepare"]>
    listOutputs: ReturnType<Database["prepare"]>
    insertNotification: ReturnType<Database["prepare"]>
    listNotifications: ReturnType<Database["prepare"]>
    upsertSyncRecord: ReturnType<Database["prepare"]>
    listSyncRecords: ReturnType<Database["prepare"]>
  }

  constructor(opts: SqliteStateBackendOpts) {
    this.appId = opts.appId
    this.db = new Database(opts.dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.createTables()
    this.stmts = this.prepareStatements()
  }

  setTurnContext(ctx: TurnContext | null): void {
    this.turnContext = ctx
  }

  insertRow(resource: string, data: Record<string, unknown>, status: string): RowRecord {
    const id = `r_${randomUUID().slice(0, 12)}`
    const now = new Date().toISOString()
    this.stmts.insertRow.run(
      id, resource, status, JSON.stringify(data),
      null, null, null,
      this.turnContext?.turnId ?? null,
      this.turnContext?.sessionId ?? null,
      now, now,
    )
    return {
      id, resource, status, data,
      createdInTurn: this.turnContext?.turnId,
      sessionId: this.turnContext?.sessionId,
      createdAt: now, updatedAt: now,
    }
  }

  updateRow(id: string, patch: Partial<RowRecord>): RowRecord {
    const existing = this.getRow(id)
    if (!existing) throw new Error(`row ${id} not found`)
    const merged: RowRecord = {
      ...existing,
      ...patch,
      data: patch.data ?? existing.data,
      updatedAt: new Date().toISOString(),
    }
    this.stmts.updateRow.run(
      merged.resource, merged.status, JSON.stringify(merged.data),
      merged.externalId ?? null,
      merged.errorMessage ?? null,
      merged.scheduledAt ?? null,
      merged.createdInTurn ?? null,
      merged.sessionId ?? null,
      merged.updatedAt,
      id,
    )
    return merged
  }

  getRow(id: string): RowRecord | undefined {
    const row = this.stmts.getRow.get(id) as RawRowRow | undefined
    return row ? this.rowFromRaw(row) : undefined
  }

  rowsByResource(resource: string): RowRecord[] {
    const rows = this.stmts.rowsByResource.all(resource) as RawRowRow[]
    return rows.map(r => this.rowFromRaw(r))
  }

  pushAudit(event: AuditEntry["event"], fields: Record<string, unknown>): void {
    this.stmts.insertAudit.run(new Date().toISOString(), event, JSON.stringify(fields))
  }

  upsertOutput(card: Omit<OutputCard, "updatedAt">): void {
    this.stmts.upsertOutput.run(
      card.resourceName, card.rowId,
      card.surface, card.status,
      card.summary ?? null,
      card.deepLink ?? null,
      new Date().toISOString(),
    )
  }

  pushNotification(n: Omit<NotificationEntry, "at">): void {
    this.stmts.insertNotification.run(
      new Date().toISOString(),
      n.level, n.summary,
      n.agentHint ?? null,
      n.ref?.kind ?? null,
      n.ref?.id ?? null,
    )
  }

  upsertSyncRecord(rec: Omit<SyncRecord, "syncedAt">): void {
    this.stmts.upsertSyncRecord.run(
      rec.syncName, rec.key, rec.attachedRowId,
      JSON.stringify(rec.raw), JSON.stringify(rec.normalized),
      new Date().toISOString(),
    )
  }

  snapshot(): AppState {
    const rows = (this.stmts.listAllRows.all() as RawRowRow[]).map(r => this.rowFromRaw(r))
    const audit = (this.stmts.listAudit.all() as RawAuditRow[]).map(a => ({
      at: a.at, event: a.event as AuditEntry["event"],
      fields: JSON.parse(a.fields_json),
    }))
    const outputs = (this.stmts.listOutputs.all() as RawOutputRow[]).map(o => ({
      resourceName: o.resource_name, rowId: o.row_id, surface: o.surface,
      status: o.status, summary: o.summary, deepLink: o.deep_link, updatedAt: o.updated_at,
    }))
    const notifications = (this.stmts.listNotifications.all() as RawNotifRow[]).map(n => ({
      at: n.at,
      level: n.level as NotificationEntry["level"],
      summary: n.summary,
      agentHint: n.agent_hint ?? undefined,
      ref: n.ref_kind && n.ref_id ? { kind: n.ref_kind, id: n.ref_id } : undefined,
    }))
    const syncRecords = (this.stmts.listSyncRecords.all() as RawSyncRow[]).map(s => ({
      syncName: s.sync_name, key: s.key, attachedRowId: s.attached_row_id ?? "",
      raw: JSON.parse(s.raw_json), normalized: JSON.parse(s.normalized_json),
      syncedAt: s.synced_at,
    }))
    return { rows, audit, outputs, notifications, syncRecords, derivedTools: [] }
  }

  /** Test-only: close the underlying DB. */
  close(): void {
    this.db.close()
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private t(suffix: string) { return `${this.appId}__${suffix}` }

  private createTables(): void {
    const rows = this.t("rows")
    const audit = this.t("audit")
    const outputs = this.t("outputs")
    const notif = this.t("notifications")
    const sync = this.t("sync_records")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${rows} (
        id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        external_id TEXT,
        error_message TEXT,
        scheduled_at TEXT,
        created_in_turn TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${rows}_resource ON ${rows}(resource);

      CREATE TABLE IF NOT EXISTS ${audit} (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        fields_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${outputs} (
        resource_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        deep_link TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (resource_name, row_id)
      );

      CREATE TABLE IF NOT EXISTS ${notif} (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        level TEXT NOT NULL,
        summary TEXT NOT NULL,
        agent_hint TEXT,
        ref_kind TEXT,
        ref_id TEXT
      );

      CREATE TABLE IF NOT EXISTS ${sync} (
        sync_name TEXT NOT NULL,
        key TEXT NOT NULL,
        attached_row_id TEXT,
        raw_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (sync_name, key)
      );
    `)
  }

  private prepareStatements() {
    const rows = this.t("rows")
    const audit = this.t("audit")
    const outputs = this.t("outputs")
    const notif = this.t("notifications")
    const sync = this.t("sync_records")
    return {
      insertRow: this.db.prepare(`
        INSERT INTO ${rows} (id, resource, status, data_json, external_id, error_message, scheduled_at, created_in_turn, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateRow: this.db.prepare(`
        UPDATE ${rows} SET resource = ?, status = ?, data_json = ?, external_id = ?, error_message = ?, scheduled_at = ?, created_in_turn = ?, session_id = ?, updated_at = ?
        WHERE id = ?
      `),
      getRow: this.db.prepare(`SELECT * FROM ${rows} WHERE id = ?`),
      rowsByResource: this.db.prepare(`SELECT * FROM ${rows} WHERE resource = ? ORDER BY created_at`),
      listAllRows: this.db.prepare(`SELECT * FROM ${rows} ORDER BY created_at`),
      insertAudit: this.db.prepare(`INSERT INTO ${audit} (at, event, fields_json) VALUES (?, ?, ?)`),
      listAudit: this.db.prepare(`SELECT * FROM ${audit} ORDER BY rowid`),
      upsertOutput: this.db.prepare(`
        INSERT INTO ${outputs} (resource_name, row_id, surface, status, summary, deep_link, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_name, row_id) DO UPDATE SET
          surface = excluded.surface,
          status = excluded.status,
          summary = excluded.summary,
          deep_link = excluded.deep_link,
          updated_at = excluded.updated_at
      `),
      listOutputs: this.db.prepare(`SELECT * FROM ${outputs} ORDER BY updated_at`),
      insertNotification: this.db.prepare(`
        INSERT INTO ${notif} (at, level, summary, agent_hint, ref_kind, ref_id) VALUES (?, ?, ?, ?, ?, ?)
      `),
      listNotifications: this.db.prepare(`SELECT * FROM ${notif} ORDER BY rowid`),
      upsertSyncRecord: this.db.prepare(`
        INSERT INTO ${sync} (sync_name, key, attached_row_id, raw_json, normalized_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sync_name, key) DO UPDATE SET
          attached_row_id = excluded.attached_row_id,
          raw_json = excluded.raw_json,
          normalized_json = excluded.normalized_json,
          synced_at = excluded.synced_at
      `),
      listSyncRecords: this.db.prepare(`SELECT * FROM ${sync} ORDER BY synced_at`),
    }
  }

  private rowFromRaw(r: RawRowRow): RowRecord {
    return {
      id: r.id, resource: r.resource, status: r.status,
      data: JSON.parse(r.data_json),
      externalId: r.external_id ?? undefined,
      errorMessage: r.error_message ?? undefined,
      scheduledAt: r.scheduled_at ?? undefined,
      createdInTurn: r.created_in_turn ?? undefined,
      sessionId: r.session_id ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }
  }
}

// Raw row shapes from SQLite
interface RawRowRow {
  id: string; resource: string; status: string; data_json: string
  external_id: string | null; error_message: string | null; scheduled_at: string | null
  created_in_turn: string | null; session_id: string | null
  created_at: string; updated_at: string
}
interface RawAuditRow { at: string; event: string; fields_json: string }
interface RawOutputRow {
  resource_name: string; row_id: string; surface: string; status: string
  summary: string | null; deep_link: string | null; updated_at: string
}
interface RawNotifRow {
  at: string; level: string; summary: string
  agent_hint: string | null; ref_kind: string | null; ref_id: string | null
}
interface RawSyncRow {
  sync_name: string; key: string; attached_row_id: string | null
  raw_json: string; normalized_json: string; synced_at: string
}
