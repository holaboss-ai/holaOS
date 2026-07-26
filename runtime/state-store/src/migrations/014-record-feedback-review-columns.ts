import type { Migration } from "../migrations.js";

/**
 * Proposals + Evolution: extend `record_feedback` so the review companion's
 * structured-capture tool calls can be persisted alongside existing rating
 * feedback. Columns added:
 *
 *   - attempt_idx       : monotonically increasing index of the review attempt
 *                         this row applies to (one record can have many).
 *   - review_session_id : per-record chat session FK (the conversation that
 *                         produced this row).
 *   - review_node_id    : the workflow review node that produced the record.
 *   - batch_id          : caller-supplied tag from /run (count > 1) so
 *                         Evolution can analyze approve/reject patterns
 *                         within a single user intent.
 *
 * `source` stays TEXT, so new values `review_decision` and
 * `review_revision_request` need no schema change — only the application-level
 * enum. Index by review_session_id + workflow_revision_id to keep Evolution's
 * "what's been said about this revision lately?" queries cheap.
 *
 * Gated on `record_feedback` existing (migration 011) so the control-plane
 * DB skips this entirely.
 */
export const migration: Migration = {
  id: 14,
  name: "record-feedback-review-columns",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("record_feedback")) {
      return;
    }
    ensureColumn(db, "record_feedback", "attempt_idx", "INTEGER");
    ensureColumn(db, "record_feedback", "review_session_id", "TEXT");
    ensureColumn(db, "record_feedback", "review_node_id", "TEXT");
    ensureColumn(db, "record_feedback", "batch_id", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_record_feedback_review_session_created
          ON record_feedback (workspace_id, review_session_id, created_at DESC, feedback_id DESC)
          WHERE review_session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_revision_source_created
          ON record_feedback (workspace_id, workflow_revision_id, source, created_at DESC, feedback_id DESC)
          WHERE workflow_revision_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_record_feedback_batch_created
          ON record_feedback (workspace_id, batch_id, created_at DESC, feedback_id DESC)
          WHERE batch_id IS NOT NULL;
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

function ensureColumn(
  db: Parameters<Migration["up"]>[0],
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = new Set<string>(
    (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (columns.has(columnName)) {
    return;
  }
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`,
  );
}
