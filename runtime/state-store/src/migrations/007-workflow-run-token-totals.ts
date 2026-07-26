import type { Migration } from "../migrations.js";

/**
 * Adds aggregated token-usage columns to `workflow_runs` so the per-plugin
 * Admin Panel can compute totals + per-model breakdown without re-scanning
 * `turn_results` on every read.
 *
 * Columns are populated at run-completion time by the store; existing
 * already-completed rows stay at zero (acceptable for an additive read path).
 */
export const migration: Migration = {
  id: 7,
  name: "workflow-run-token-totals",
  up: (db) => {
    const tableNames = new Set<string>(
      (
        db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    if (!tableNames.has("workflow_runs")) {
      return;
    }

    ensureColumn(db, "workflow_runs", "tokens_input", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "workflow_runs", "tokens_output", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
      db,
      "workflow_runs",
      "tokens_cached_input",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      db,
      "workflow_runs",
      "tokens_by_model",
      "TEXT NOT NULL DEFAULT '{}'",
    );
  },
};

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
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}
