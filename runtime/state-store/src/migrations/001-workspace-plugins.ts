import type { Migration } from "../migrations.js";

const CORE_PLUGIN_ID = "core";
const CORE_PLUGIN_NAME = "Core";

export const migration: Migration = {
  id: 1,
  name: "workspace-plugins",
  up: (db) => {
    const tableNames = listTableNames(db);
    const hasBasesTable = tableNames.has("bases");
    const hasWorkflowsTable = tableNames.has("workflows");
    const hasTeammatesTable = tableNames.has("teammates");
    const hasAnyPluginOwnedTable =
      hasBasesTable || hasWorkflowsTable || hasTeammatesTable;
    if (!hasAnyPluginOwnedTable) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_plugins (
          workspace_id TEXT NOT NULL,
          plugin_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          PRIMARY KEY (workspace_id, plugin_id),
          UNIQUE (workspace_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_plugins_workspace_updated
          ON workspace_plugins (workspace_id, updated_at DESC, created_at DESC);
    `);

    if (hasBasesTable) {
      ensureColumn(db, "bases", "plugin_id", "TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bases_workspace_plugin_unique
            ON bases (workspace_id, plugin_id)
            WHERE plugin_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_bases_workspace_plugin_updated
            ON bases (workspace_id, plugin_id, updated_at DESC, created_at DESC);
      `);
    }
    if (hasWorkflowsTable) {
      ensureColumn(db, "workflows", "plugin_id", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflows_workspace_plugin_updated
            ON workflows (workspace_id, plugin_id, updated_at DESC, created_at DESC);
      `);
    }
    if (hasTeammatesTable) {
      ensureColumn(db, "teammates", "plugin_id", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_teammates_workspace_plugin_updated
            ON teammates (workspace_id, plugin_id, updated_at DESC, created_at DESC);
      `);
    }

    const workspaceIdSelects: string[] = [];
    if (hasBasesTable) {
      workspaceIdSelects.push(`
        SELECT workspace_id
        FROM bases
        WHERE COALESCE(workspace_id, '') <> ''
      `);
    }
    if (hasWorkflowsTable) {
      workspaceIdSelects.push(`
        SELECT workspace_id
        FROM workflows
        WHERE COALESCE(workspace_id, '') <> ''
      `);
    }
    if (hasTeammatesTable) {
      workspaceIdSelects.push(`
        SELECT workspace_id
        FROM teammates
        WHERE COALESCE(workspace_id, '') <> ''
          AND (kind IS NULL OR kind != 'system')
      `);
    }
    if (workspaceIdSelects.length === 0) {
      return;
    }

    const workspaceIds = db
      .prepare<unknown[], { workspace_id: string }>(`
        SELECT DISTINCT workspace_id
        FROM (
          ${workspaceIdSelects.join("\nUNION\n")}
        )
      `)
      .all()
      .map((row) => row.workspace_id)
      .filter((workspaceId) => workspaceId.trim().length > 0);
    if (workspaceIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const insertPlugin = db.prepare(`
      INSERT OR IGNORE INTO workspace_plugins (
        workspace_id,
        plugin_id,
        slug,
        name,
        description,
        icon,
        status,
        created_at,
        updated_at,
        archived_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)
    `);
    const assignBasePlugin = db.prepare(`
      UPDATE bases
      SET plugin_id = ?
      WHERE workspace_id = ?
        AND plugin_id IS NULL
    `);
    const assignWorkflowPlugin = db.prepare(`
      UPDATE workflows
      SET plugin_id = ?
      WHERE workspace_id = ?
        AND plugin_id IS NULL
    `);
    const assignCustomTeammatePlugin = hasTeammatesTable
      ? db.prepare(`
          UPDATE teammates
          SET plugin_id = ?
          WHERE workspace_id = ?
            AND plugin_id IS NULL
            AND kind = 'custom'
        `)
      : null;

    for (const workspaceId of workspaceIds) {
      insertPlugin.run(
        workspaceId,
        CORE_PLUGIN_ID,
        CORE_PLUGIN_ID,
        CORE_PLUGIN_NAME,
        now,
        now,
      );
      if (hasBasesTable) {
        assignBasePlugin.run(CORE_PLUGIN_ID, workspaceId);
      }
      if (hasWorkflowsTable) {
        assignWorkflowPlugin.run(CORE_PLUGIN_ID, workspaceId);
      }
      assignCustomTeammatePlugin?.run(CORE_PLUGIN_ID, workspaceId);
    }
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
