import { randomUUID } from "node:crypto";

import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 2,
  name: "workflow-revisions",
  up: (db) => {
    const tableNames = listTableNames(db);
    const hasWorkflowsTable = tableNames.has("workflows");
    const hasWorkflowRunsTable = tableNames.has("workflow_runs");
    if (!hasWorkflowsTable && !hasWorkflowRunsTable) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_revisions (
          workflow_revision_id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          plugin_id TEXT,
          revision_number INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          created_by TEXT,
          nodes TEXT NOT NULL DEFAULT '[]',
          edges TEXT NOT NULL DEFAULT '[]',
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          UNIQUE (workspace_id, workflow_id, revision_number)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_revisions_workflow_created
          ON workflow_revisions (workflow_id, revision_number DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_workflow_revisions_workspace_workflow_created
          ON workflow_revisions (workspace_id, workflow_id, revision_number DESC, created_at DESC);
    `);

    if (hasWorkflowRunsTable) {
      ensureColumn(db, "workflow_runs", "workflow_revision_id", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_revision_created
            ON workflow_runs (workflow_revision_id, created_at DESC, run_id ASC);
      `);
    }

    if (!hasWorkflowsTable) {
      return;
    }

    ensureColumn(db, "workflows", "plugin_id", "TEXT");

    const workflows = db.prepare(`
      SELECT workflow_id, workspace_id, plugin_id, name, description, status, created_by, nodes, edges, metadata, created_at, updated_at
      FROM workflows
      WHERE coalesce(trim(workflow_id), '') <> ''
        AND coalesce(trim(workspace_id), '') <> ''
    `).all() as Array<Record<string, unknown>>;

    const existingLatestRevision = db.prepare(`
      SELECT workflow_revision_id
      FROM workflow_revisions
      WHERE workspace_id = ?
        AND workflow_id = ?
      ORDER BY revision_number DESC, datetime(created_at) DESC, workflow_revision_id DESC
      LIMIT 1
    `);
    const insertRevision = db.prepare(`
      INSERT INTO workflow_revisions (
        workflow_revision_id,
        workflow_id,
        workspace_id,
        plugin_id,
        revision_number,
        name,
        description,
        status,
        created_by,
        nodes,
        edges,
        metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const assignRunsToRevision = hasWorkflowRunsTable
      ? db.prepare(`
          UPDATE workflow_runs
          SET workflow_revision_id = ?
          WHERE workspace_id = ?
            AND workflow_id = ?
            AND trim(coalesce(workflow_revision_id, '')) = ''
        `)
      : null;

    for (const workflow of workflows) {
      const workflowId = String(workflow.workflow_id);
      const workspaceId = String(workflow.workspace_id);
      let latestRevision = existingLatestRevision.get(
        workspaceId,
        workflowId,
      ) as { workflow_revision_id: string } | undefined;
      if (!latestRevision) {
        const revisionId = randomUUID();
        insertRevision.run(
          revisionId,
          workflowId,
          workspaceId,
          workflow.plugin_id == null ? null : String(workflow.plugin_id),
          1,
          String(workflow.name),
          workflow.description == null ? null : String(workflow.description),
          workflow.status == null ? "draft" : String(workflow.status),
          workflow.created_by == null ? null : String(workflow.created_by),
          workflow.nodes == null ? "[]" : String(workflow.nodes),
          workflow.edges == null ? "[]" : String(workflow.edges),
          workflow.metadata == null ? "{}" : String(workflow.metadata),
          workflow.updated_at == null
            ? workflow.created_at == null
              ? new Date().toISOString()
              : String(workflow.created_at)
            : String(workflow.updated_at),
        );
        latestRevision = { workflow_revision_id: revisionId };
      }
      assignRunsToRevision?.run(
        latestRevision.workflow_revision_id,
        workspaceId,
        workflowId,
      );
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
