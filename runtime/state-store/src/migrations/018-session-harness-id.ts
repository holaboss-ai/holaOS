import type { Migration } from "../migrations.js";

/**
 * Per-session harness binding.
 *
 * Each agent session is bound to a single harness (Hola / Claude Code /
 * Codex / …) at creation and cannot be changed afterwards — switching
 * harnesses mid-session would require translating one CLI's session
 * state into another's, which we deliberately don't support. Existing
 * rows are backfilled to `'pi'` (the only harness before this column
 * existed); new rows are written by the session-create endpoints.
 *
 * Gated on `agent_sessions` existing so the migration is a no-op on
 * fresh installs where the seed schema already includes the column.
 */
export const migration: Migration = {
  id: 18,
  name: "session-harness-id",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("agent_sessions")) {
      return;
    }
    ensureColumn(db, "agent_sessions", "harness_id", "TEXT");
    db.exec(`
      UPDATE agent_sessions
         SET harness_id = 'pi'
       WHERE harness_id IS NULL;
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
