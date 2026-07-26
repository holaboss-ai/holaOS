import type { Migration } from "../migrations.js";

/**
 * Per-session owning HolaApp.
 *
 * A HolaApp session belongs to the app it was opened under: it's listed via the
 * app's own session dropdown (not the workspace sidebar) and the agent run is
 * restricted to strictly that app's MCP tools. `owning_app_id` is the holaAppId
 * that owns the session; NULL means an ordinary workspace/project session (the
 * existing shared system), so all legacy rows are correctly left NULL — no
 * backfill.
 *
 * Gated on `agent_sessions` existing so the migration is a no-op on fresh
 * installs where the seed schema is created first.
 */
export const migration: Migration = {
  id: 32,
  name: "session-owning-app-id",
  up: (db) => {
    if (!listTableNames(db).has("agent_sessions")) {
      return;
    }
    ensureColumn(db, "agent_sessions", "owning_app_id", "TEXT");
    // Index the app-scoped listing (dropdown resume reads the most-recent row
    // for an app); NULL owning_app_id rows are excluded from the index.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_owning_app_updated
          ON agent_sessions (owning_app_id, updated_at DESC, created_at DESC)
       WHERE owning_app_id IS NOT NULL;
    `);
  },
};

function listTableNames(db: Parameters<Migration["up"]>[0]): Set<string> {
  return new Set<string>(
    (
      db
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `)
        .all() as Array<{ name: string }>
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
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (columns.has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}
