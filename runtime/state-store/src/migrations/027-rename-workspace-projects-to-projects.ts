import type { Migration } from "../migrations.js";

/**
 * workspace-removal Piece 5: rename `workspace_projects` -> `projects` and drop
 * its `workspace_id` (redundant inside a per-workspace runtime DB — the DB file
 * already scopes the data). Projects attach to the runtime and are identified by
 * `project_id` alone.
 *
 * Order-independent vs `ensureWorkspaceRuntimeDbSchema` (which creates `projects`
 * for fresh DBs): create `projects` if missing, copy any legacy rows over, then
 * drop the old table. No-op on DBs that never had `workspace_projects` (e.g. the
 * control-plane DB).
 */
export const migration: Migration = {
  id: 27,
  name: "rename-workspace-projects-to-projects",
  up: (db) => {
    if (!listTableNames(db).has("workspace_projects")) {
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          project_path TEXT NOT NULL,
          icon TEXT,
          icon_color TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id)
      );
      INSERT OR IGNORE INTO projects
          (project_id, name, project_path, icon, icon_color, created_at, updated_at)
          SELECT project_id, name, project_path, icon, icon_color, created_at, updated_at
          FROM workspace_projects;
      DROP TABLE workspace_projects;
      CREATE INDEX IF NOT EXISTS idx_projects_updated
          ON projects (updated_at DESC, created_at DESC);
    `);
  },
};

function listTableNames(db: Parameters<Migration["up"]>[0]): Set<string> {
  return new Set<string>(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}
