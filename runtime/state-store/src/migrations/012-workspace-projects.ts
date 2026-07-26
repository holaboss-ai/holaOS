import type { Migration } from "../migrations.js";

/**
 * Introduces Projects as a first-class entity nested under a workspace,
 * and lets a session bind to one.
 *
 * Shape:
 *   - `workspace_projects` rows are workspace-scoped (PK on workspace_id,
 *     project_id). `project_path` is the project's own directory, which
 *     does NOT have to live under the workspace path.
 *   - `agent_sessions.project_id` is nullable. NULL means the session
 *     belongs to the workspace's General bucket and the agent run uses
 *     `workspace.workspace_path` as cwd. Otherwise cwd is the project's
 *     `project_path`. Outputs follow the same rule.
 *   - No SQL-level FK is declared because the rest of the agent_sessions
 *     schema also avoids FKs and handles referential integrity at the
 *     app layer. On project delete the service layer sets the column to
 *     NULL on the project's sessions in the same transaction (equivalent
 *     to ON DELETE SET NULL).
 *
 * Gated on `agent_sessions` existing so the migration is a no-op against
 * the control-plane DB (matches migration 011's pattern).
 */
export const migration: Migration = {
  id: 12,
  name: "workspace-projects",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("agent_sessions")) {
      return;
    }

    if (!tableNames.has("workspace_projects")) {
      db.exec(`
        CREATE TABLE workspace_projects (
            workspace_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            project_path TEXT NOT NULL,
            icon TEXT,
            icon_color TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, project_id)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_projects_workspace_updated
            ON workspace_projects (workspace_id, updated_at DESC, created_at DESC);
      `);
    }

    ensureColumn(db, "agent_sessions", "project_id", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_project
          ON agent_sessions (project_id)
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
