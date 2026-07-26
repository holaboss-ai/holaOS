import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 19,
  name: "workspace-addons",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_addons (
          workspace_id TEXT NOT NULL,
          addon_id TEXT NOT NULL,
          version TEXT,
          name TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          installed_skill_ids TEXT,
          integration_status TEXT,
          config_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, addon_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_addons_workspace_updated
          ON workspace_addons (workspace_id, updated_at DESC, created_at DESC);
    `);
  },
};
