import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 4,
  name: "workspace-plugin-templates",
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
    if (!tableNames.has("workspace_plugins")) {
      return;
    }
    ensureColumn(db, "workspace_plugins", "template_id", "TEXT");
    ensureColumn(db, "workspace_plugins", "template_version", "TEXT");
    ensureColumn(
      db,
      "workspace_plugins",
      "config_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    db.exec(`
      UPDATE workspace_plugins
      SET config_json = '{}'
      WHERE trim(coalesce(config_json, '')) = ''
    `);
  },
};

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
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}
