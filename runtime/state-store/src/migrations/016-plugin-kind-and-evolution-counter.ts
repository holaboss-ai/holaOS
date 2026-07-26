import type { Migration } from "../migrations.js";

/**
 * Proposals + Evolution: two small additions packaged together because
 * they're both single-column extensions to existing tables.
 *
 *  1. `workspace_plugins.kind` — distinguishes synthetic Proposal plugins
 *     from user-authored plugins. Suppresses default plugin UI chrome
 *     in the desktop overlay when `kind = 'proposal'`. Defaults to `'user'`.
 *
 *  2. `evolution_decision_counters` — per-workflow counter incremented on
 *     every `record_feedback` row with `source = 'review_decision'`. When
 *     the count crosses the threshold (5 — encoded in the application,
 *     not here) the evolution agent fires for that workflow and the row
 *     resets. Keyed by workflow_id so accepts that mint a new revision
 *     don't reset progress toward the next proposal.
 *
 * Gated on `workspace_plugins` existing (migration 001).
 */
export const migration: Migration = {
  id: 16,
  name: "plugin-kind-and-evolution-counter",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("workspace_plugins")) {
      return;
    }
    ensureColumn(db, "workspace_plugins", "kind", "TEXT");
    // Backfill: existing rows are user plugins; new rows must always
    // specify kind explicitly via createWorkspacePlugin.
    db.exec(`
      UPDATE workspace_plugins
         SET kind = 'user'
       WHERE kind IS NULL;
    `);

    if (!tableNames.has("evolution_decision_counters")) {
      db.exec(`
        CREATE TABLE evolution_decision_counters (
            workspace_id TEXT NOT NULL,
            workflow_id TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            last_fired_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, workflow_id)
        );
      `);
    }
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
