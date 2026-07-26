import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 6,
  name: "rename-assignee-teammate-id",
  up: (db) => {
    const tableNames = new Set<string>(
      (
        db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    if (!tableNames.has("issues")) {
      return;
    }

    const columns = new Set<string>(
      (
        db.prepare(`PRAGMA table_info(issues)`).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    if (!columns.has("assignee_id")) {
      db.exec(`ALTER TABLE issues ADD COLUMN assignee_id TEXT;`);
    }

    if (columns.has("assignee_teammate_id")) {
      db.exec(`
        UPDATE issues
        SET assignee_id = assignee_teammate_id
        WHERE assignee_id IS NULL
          AND trim(coalesce(assignee_teammate_id, '')) <> ''
      `);
    }
  },
};
