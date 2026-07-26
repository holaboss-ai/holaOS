import type { Migration } from "../migrations.js";

/**
 * Removes the per-workspace integration override mechanism. Workspaces now
 * always inherit the full account-active integration pool — there is no
 * per-workspace enable/disable or pin-to-account. Runs against both the
 * runtime and control-plane DBs; the table only ever lived in the
 * control-plane DB, so this no-ops on runtime DBs.
 */
export const migration: Migration = {
  id: 22,
  name: "drop-workspace-integration-overrides",
  up: (db) => {
    db.exec(`DROP TABLE IF EXISTS workspace_integration_overrides;`);
  },
};
