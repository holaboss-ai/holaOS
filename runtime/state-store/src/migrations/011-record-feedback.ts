import type { Migration } from "../migrations.js";

/**
 * Append-only feedback channel.
 *
 * Targets are polymorphic: a feedback row may target a record (with
 * optional field_path), a workflow_run, a workflow_node_run, a turn
 * (session_id + input_id), or a whole workflow. Service-layer
 * validation enforces "exactly one target_kind populated correctly"
 * — we deliberately don't push that into CHECK constraints so future
 * shapes can be added without a table rebuild.
 *
 * Per-record feedback snapshots the producing workflow_run / writer
 * node_run at submission time so it stays bound to the version of
 * truth the user was looking at, not to the record's current state.
 *
 * `source` separates user gestures, agent self-critique, and eval
 * pipelines (all writing through the same channel). `rating` is
 * stored as TEXT so 'positive' / 'negative' / numeric scores ('80')
 * coexist without coercion games.
 *
 * Correction is JSON-encoded and never auto-applied — it's a
 * suggested value, not a write.
 *
 * Gated on `base_object_records` existing so the migration is a no-op
 * against the control-plane DB.
 */
export const migration: Migration = {
  id: 11,
  name: "record-feedback",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("base_object_records")) {
      return;
    }
    if (tableNames.has("record_feedback")) {
      return;
    }
    db.exec(`
      CREATE TABLE record_feedback (
          feedback_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          record_id TEXT,
          field_path TEXT,
          workflow_id TEXT,
          workflow_revision_id TEXT,
          workflow_run_id TEXT,
          workflow_node_run_id TEXT,
          turn_session_id TEXT,
          turn_input_id TEXT,
          rating TEXT NOT NULL,
          label TEXT,
          note TEXT,
          correction_json TEXT,
          source TEXT NOT NULL,
          submitted_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_record_feedback_record_created
          ON record_feedback (workspace_id, record_id, created_at DESC, feedback_id DESC)
          WHERE record_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_record_field_created
          ON record_feedback (workspace_id, record_id, field_path, created_at DESC, feedback_id DESC)
          WHERE record_id IS NOT NULL AND field_path IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_workflow_run_created
          ON record_feedback (workspace_id, workflow_run_id, created_at DESC, feedback_id DESC)
          WHERE workflow_run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_node_run_created
          ON record_feedback (workspace_id, workflow_node_run_id, created_at DESC, feedback_id DESC)
          WHERE workflow_node_run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_workflow_created
          ON record_feedback (workspace_id, workflow_id, created_at DESC, feedback_id DESC)
          WHERE workflow_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_turn_created
          ON record_feedback (workspace_id, turn_session_id, turn_input_id, created_at DESC, feedback_id DESC)
          WHERE turn_session_id IS NOT NULL;
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
