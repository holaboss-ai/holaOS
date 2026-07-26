import type { Migration } from "../migrations.js";

/**
 * Per-field provenance audit table.
 *
 * `base_object_records.created_by_workflow_*` only ever names the *first*
 * writer of a record — once a workflow updates a field, the originating
 * provenance no longer answers "who wrote field X." `record_field_writes`
 * is the append-only log that does.
 *
 * Written by the store on every top-level data field that diffs against
 * the previous row inside `upsertBaseObjectRecord`. `source` classifies
 * the writer (workflow / manual / integration) so reads can tell apart
 * "an agent computed this" from "a user typed it in" from "an external
 * sync wrote it". For workflow writes, the run/node-run identifiers
 * point back into `workflow_runs` / `workflow_node_runs` so the
 * record_get_context reader can re-hydrate reasoning on demand.
 *
 * Gated on `base_object_records` existing so this migration is a no-op
 * against the control-plane DB (which has no record tables).
 */
export const migration: Migration = {
  id: 10,
  name: "record-field-writes",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("base_object_records")) {
      return;
    }
    if (tableNames.has("record_field_writes")) {
      return;
    }
    db.exec(`
      CREATE TABLE record_field_writes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          record_id TEXT NOT NULL,
          base_id TEXT NOT NULL,
          object_id TEXT NOT NULL,
          field_path TEXT NOT NULL,
          previous_value TEXT,
          new_value TEXT,
          source TEXT NOT NULL,
          workflow_id TEXT,
          workflow_revision_id TEXT,
          workflow_run_id TEXT,
          workflow_node_run_id TEXT,
          agent_session_id TEXT,
          actor TEXT,
          written_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_record_field_writes_record_written
          ON record_field_writes (workspace_id, record_id, written_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_record_field_writes_record_field_written
          ON record_field_writes (workspace_id, record_id, field_path, written_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_record_field_writes_workflow_run_written
          ON record_field_writes (workspace_id, workflow_run_id, written_at DESC);
    `);
  },
};

function listTableNames(
  db: Parameters<Migration["up"]>[0],
): Set<string> {
  return new Set<string>(
    (
      db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}
