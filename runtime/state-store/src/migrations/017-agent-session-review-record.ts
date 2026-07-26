import type { Migration } from "../migrations.js";

/**
 * Proposals: per-record review chat sessions.
 *
 * A review companion session is scoped to a single base record (the
 * artifact being reviewed) and persists across attempts on that record.
 * `agent_sessions.review_record_id` is the foreign key the desktop
 * overlay reads to mount the session in the Review detail pane.
 *
 * Cascade-delete with the record is enforced at the application layer
 * (the existing record-delete path looks for sessions with this FK).
 * We don't add a SQL CASCADE here because base_object_records is a
 * separate concern and we want the application layer to also prune
 * the structured-capture rows in record_feedback that point at this
 * session.
 *
 * Gated on `agent_sessions` existing.
 */
export const migration: Migration = {
  id: 17,
  name: "agent-session-review-record",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("agent_sessions")) {
      return;
    }
    ensureColumn(db, "agent_sessions", "review_record_id", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_review_record
          ON agent_sessions (review_record_id)
          WHERE review_record_id IS NOT NULL;
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
