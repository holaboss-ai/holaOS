import type { Migration } from "../migrations.js";

/**
 * Rebuilds `cronjobs` so `teammate_id` is plain `TEXT` (nullable, no
 * default). Workspace DBs created before the teammate-removal work used
 * `ensureWorkspaceRuntimeDbSchema` to declare the column inline as
 * `TEXT NOT NULL DEFAULT 'general'`. Migration 005 then tried to null
 * that column out — which crashed any DB whose cronjobs row still
 * carried the legacy `'general'` value. Migration 005 was patched to
 * write `''` instead of `NULL` on `NOT NULL` columns so it can complete,
 * but the underlying constraint stays — and any future code that needs
 * to set the column to NULL would re-trip the same crash.
 *
 * SQLite has no portable `ALTER TABLE ... DROP CONSTRAINT`, so we use
 * the standard "create new table, copy data, swap, rename" dance. The
 * new table's column list mirrors today's `ensureWorkspaceRuntimeDbSchema`
 * baseline; teammate_id is retained for backward read-compatibility but
 * nullable.
 *
 * Idempotent — skipped on:
 *   - DBs that don't have `cronjobs` at all (fresh non-workspace DBs),
 *   - DBs where `teammate_id` is already nullable (post-migration-009
 *     reopens, or fresh DBs where migration 005's `ensureColumn` added
 *     the column nullable to begin with).
 */
export const migration: Migration = {
  id: 9,
  name: "relax-cronjobs-teammate-not-null",
  up: (db) => {
    const cronjobsExists =
      db
        .prepare<[string], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        )
        .get("cronjobs") !== undefined;
    if (!cronjobsExists) {
      return;
    }

    const info = db.prepare(`PRAGMA table_info(cronjobs)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const teammateColumn = info.find((row) => row.name === "teammate_id");
    if (!teammateColumn || teammateColumn.notnull === 0) {
      // No constraint to relax (column absent or already nullable).
      return;
    }

    db.exec(`
      CREATE TABLE cronjobs__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          initiated_by TEXT NOT NULL,
          teammate_id TEXT,
          name TEXT NOT NULL DEFAULT '',
          cron TEXT NOT NULL,
          description TEXT NOT NULL,
          instruction TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          delivery TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          last_run_at TEXT,
          next_run_at TEXT,
          run_count INTEGER NOT NULL DEFAULT 0,
          last_status TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      INSERT INTO cronjobs__new (
          id, workspace_id, initiated_by, teammate_id, name, cron, description,
          instruction, enabled, delivery, metadata, last_run_at, next_run_at,
          run_count, last_status, last_error, created_at, updated_at
      )
      SELECT
          id, workspace_id, initiated_by,
          NULLIF(teammate_id, '') AS teammate_id,
          name, cron, description, instruction, enabled, delivery, metadata,
          last_run_at, next_run_at, run_count, last_status, last_error,
          created_at, updated_at
      FROM cronjobs;

      DROP TABLE cronjobs;
      ALTER TABLE cronjobs__new RENAME TO cronjobs;

      CREATE INDEX IF NOT EXISTS idx_cronjobs_workspace_created
          ON cronjobs (workspace_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_cronjobs_enabled_next_run
          ON cronjobs (enabled, next_run_at);
    `);
  },
};
