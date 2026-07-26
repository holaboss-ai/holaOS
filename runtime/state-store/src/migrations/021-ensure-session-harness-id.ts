import type { Migration } from "../migrations.js";

/**
 * Repairs DBs that skipped migration 018 (`session-harness-id`).
 *
 * An earlier branch used migration id 18 for a different change
 * (`workspace-addons`); when that was renumbered so id 18 became
 * `session-harness-id`, any DB already at `user_version >= 18` from the old
 * numbering skips the new id-18 migration — so its `agent_sessions` table
 * never gains the `harness_id` column. `ensureSession` then INSERTs
 * `harness_id` into a missing column and every session-create fails.
 *
 * This migration idempotently ensures the column exists and backfills `'pi'`,
 * matching what migration 018 would have done. No-op where the column already
 * exists (fresh installs, DBs that applied 018 correctly).
 */
export const migration: Migration = {
  id: 21,
  name: "ensure-session-harness-id",
  up: (db) => {
    const hasTable =
      db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions' LIMIT 1`,
        )
        .get() !== undefined;
    if (!hasTable) {
      return;
    }
    const hasColumn = (
      db.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{
        name: string;
      }>
    ).some((column) => column.name === "harness_id");
    if (!hasColumn) {
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN harness_id TEXT;`);
    }
    db.exec(`
      UPDATE agent_sessions
         SET harness_id = 'pi'
       WHERE harness_id IS NULL;
    `);
  },
};
