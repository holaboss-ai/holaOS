import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 5,
  name: "remove-teammate-runtime-references",
  up: (db) => {
    const tableNames = listTableNames(db);

    if (tableNames.has("issues")) {
      ensureColumn(db, "issues", "assignee_id", "TEXT");
      clearColumn(db, "issues", "assignee_id");
    }

    if (tableNames.has("subagent_runs")) {
      ensureColumn(db, "subagent_runs", "teammate_id", "TEXT");
      clearColumn(db, "subagent_runs", "teammate_id");
    }

    if (tableNames.has("cronjobs")) {
      ensureColumn(db, "cronjobs", "teammate_id", "TEXT");
      clearColumn(db, "cronjobs", "teammate_id");
    }

    if (tableNames.has("workflows")) {
      const workflowRows = db
        .prepare(`
          SELECT workflow_id, nodes
          FROM workflows
          WHERE trim(coalesce(nodes, '')) <> ''
        `)
        .all() as Array<{ workflow_id: string; nodes: string }>;
      const updateWorkflow = db.prepare(`
        UPDATE workflows
        SET nodes = ?
        WHERE workflow_id = ?
      `);
      for (const row of workflowRows) {
        const cleaned = stripWorkflowAgentTeammateIds(row.nodes);
        if (cleaned !== row.nodes) {
          updateWorkflow.run(cleaned, row.workflow_id);
        }
      }
    }

    if (tableNames.has("workflow_revisions")) {
      const revisionRows = db
        .prepare(`
          SELECT workflow_revision_id, nodes
          FROM workflow_revisions
          WHERE trim(coalesce(nodes, '')) <> ''
        `)
        .all() as Array<{ workflow_revision_id: string; nodes: string }>;
      const updateRevision = db.prepare(`
        UPDATE workflow_revisions
        SET nodes = ?
        WHERE workflow_revision_id = ?
      `);
      for (const row of revisionRows) {
        const cleaned = stripWorkflowAgentTeammateIds(row.nodes);
        if (cleaned !== row.nodes) {
          updateRevision.run(cleaned, row.workflow_revision_id);
        }
      }
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

/**
 * Empty out `columnName` on `tableName` without tripping a legacy `NOT NULL`
 * declaration. Migration 005's original form ran `SET ${columnName} = NULL`,
 * which crashes any DB where the column was first created inline as
 * `NOT NULL DEFAULT '...'` (the pre-migration ensure-schema baseline for
 * cronjobs/subagent_runs/issues did exactly that). Migration 009 rebuilds
 * those tables to drop the constraint, but it can only run after THIS
 * migration succeeds — so we degrade gracefully here: use `''` when the
 * column is `NOT NULL`, `NULL` otherwise. Both forms are semantically
 * "cleared" to every downstream reader.
 */
function clearColumn(
  db: Parameters<Migration["up"]>[0],
  tableName: string,
  columnName: string,
): void {
  const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const column = info.find((row) => row.name === columnName);
  if (!column) {
    return;
  }
  const blank = column.notnull ? "''" : "NULL";
  db.exec(`
    UPDATE ${tableName}
    SET ${columnName} = ${blank}
    WHERE trim(coalesce(${columnName}, '')) <> ''
  `);
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

function stripWorkflowAgentTeammateIds(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return raw;
    }
    const nextNodes = parsed.map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return node;
      }
      const record = node as Record<string, unknown>;
      if (record.type !== "agent") {
        return record;
      }
      const config = record.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return record;
      }
      const nextConfig = { ...(config as Record<string, unknown>) };
      delete nextConfig.teammate_id;
      return {
        ...record,
        config: nextConfig,
      };
    });
    return JSON.stringify(nextNodes);
  } catch {
    return raw;
  }
}
