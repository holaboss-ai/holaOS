import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 25,
  name: "channel-connections",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_connections (
          connection_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          token TEXT,
          bot_username TEXT,
          allow_from TEXT NOT NULL DEFAULT '[]',
          require_mention INTEGER NOT NULL DEFAULT 0,
          api_base_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          status_detail TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_connections_workspace
          ON channel_connections (workspace_id, platform);
    `);
  },
};
