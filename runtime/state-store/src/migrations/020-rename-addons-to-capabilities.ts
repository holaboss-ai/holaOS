import type { Migration } from "../migrations.js";

const CREATE_NEW = `
  CREATE TABLE workspace_capabilities (
    workspace_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
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
    PRIMARY KEY (workspace_id, capability_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_capabilities_workspace_updated
    ON workspace_capabilities (workspace_id, updated_at DESC, created_at DESC);
`;

export const migration: Migration = {
  id: 20,
  name: "rename-addons-to-capabilities",
  up: (db) => {
    const tableExists = (name: string): boolean =>
      db
        .prepare<[string], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
        )
        .get(name) !== undefined;

    if (tableExists("workspace_capabilities")) {
      return;
    }
    if (!tableExists("workspace_addons")) {
      db.exec(CREATE_NEW);
      return;
    }
    db.exec(`
      ${CREATE_NEW}
      INSERT INTO workspace_capabilities (
        workspace_id, capability_id, version, name, description, icon, status,
        installed_skill_ids, integration_status, config_json, created_at, updated_at
      )
      SELECT
        workspace_id, addon_id, version, name, description, icon, status,
        installed_skill_ids, integration_status, config_json, created_at, updated_at
      FROM workspace_addons;
      DROP TABLE workspace_addons;
    `);
  },
};
