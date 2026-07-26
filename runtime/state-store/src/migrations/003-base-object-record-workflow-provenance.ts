import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 3,
  name: "base-object-record-workflow-provenance",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("base_object_records")) {
      return;
    }

    ensureColumn(db, "base_object_records", "created_by_workflow_id", "TEXT");
    ensureColumn(
      db,
      "base_object_records",
      "created_by_workflow_revision_id",
      "TEXT",
    );
    ensureColumn(db, "base_object_records", "created_by_workflow_run_id", "TEXT");
    ensureColumn(
      db,
      "base_object_records",
      "created_by_workflow_node_run_id",
      "TEXT",
    );
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_base_object_records_workflow_created
          ON base_object_records (workspace_id, created_by_workflow_id, created_at DESC, record_id DESC);
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
