import type { Migration } from "../migrations.js";

/**
 * Adds `project_id` to outputs so a session's artifacts can be attributed
 * to the project the session belongs to (mirrors `agent_sessions.project_id`
 * added in 012). General-session outputs (project_id NULL) continue to
 * live under the workspace's output root; project-session outputs live
 * under the project's `outputs/` directory and surface in project-scoped
 * artifact views.
 *
 * Gated on the `outputs` table existing so the migration is a no-op against
 * the control-plane DB.
 */
export const migration: Migration = {
  id: 13,
  name: "output-project-id",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("outputs")) {
      return;
    }
    ensureColumn(db, "outputs", "project_id", "TEXT");
    // `outputs.workspace_id` was dropped in migration 029 (redundant inside a
    // per-workspace runtime DB). On a fresh DB the table is already
    // workspace_id-free when this older migration runs, so the index must omit
    // it; on a legacy DB the column still exists but the index has no need for
    // it either (migration 029 strips workspace_id from every outputs index).
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_outputs_project_created
          ON outputs (project_id, created_at DESC)
          WHERE project_id IS NOT NULL;
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
