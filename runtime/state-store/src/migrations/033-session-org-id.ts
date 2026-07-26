import type { Migration } from "../migrations.js";

/**
 * Per-session owning org (org-owned sessions).
 *
 * A session belongs to the org that was active when it was created. Every agent
 * run in the session bills that org (the runtime reads `org_id` off the session,
 * not the live runtime-config), so switching org mid-work — or running two
 * sessions across two orgs — attributes each session's spend correctly. `org_id`
 * is the org id; NULL means an unattributed/legacy session (the run falls back
 * to the live runtime-config org), so all pre-existing rows are correctly left
 * NULL — no backfill.
 *
 * Gated on `agent_sessions` existing so the migration is a no-op on fresh
 * installs where the seed schema is created first.
 */
export const migration: Migration = {
  id: 33,
  name: "session-org-id",
  up: (db) => {
    if (!listTableNames(db).has("agent_sessions")) {
      return;
    }
    ensureColumn(db, "agent_sessions", "org_id", "TEXT");
    // Index the org-scoped sidebar listing; NULL org_id rows are excluded (they
    // match every org via the query's `OR org_id IS NULL`, not this index).
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_updated
          ON agent_sessions (org_id, updated_at DESC, created_at DESC)
       WHERE org_id IS NOT NULL;
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
