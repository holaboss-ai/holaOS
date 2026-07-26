import type { Migration } from "../migrations.js";

/**
 * workspace-removal Piece 5 (continuation of migration 028): drop the redundant
 * `workspace_id` column from the remaining per-workspace runtime-DB tables.
 *
 * Inside a per-workspace runtime DB the `workspace_id` is constant (the DB file
 * already scopes the data), so it is removable; rows identify by their own keys
 * and attach to the runtime. Method signatures keep their `workspaceId` param
 * (it selects the per-workspace DB), so external callers are unchanged.
 *
 * Tables (all created by `ensureWorkspaceRuntimeDbSchema`, none shared with the
 * control-plane DB):
 *   turn_results, turn_request_snapshots, subagent_runs,
 *   main_session_event_queue, output_folders, outputs, interaction_entities,
 *   interaction_leaves, interaction_node_embeddings, cronjobs,
 *   runtime_notifications, issues, app_builds, app_ports, terminal_sessions,
 *   terminal_session_events, memory_update_proposals.
 *
 * Explicitly NOT touched (control-plane / dual-mode tables that legitimately
 * keep `workspace_id`): integration_bindings (control-plane only) and the
 * integration_trees / integration_leaves / integration_node_embeddings graph,
 * which exist in BOTH the control-plane and per-workspace DBs with different
 * shapes and are routed through `resolveSemanticMemoryScope`; they share the
 * out-of-scope `semantic_memory_*` dual-mode subsystem.
 *
 * For each table that still has a `workspace_id` column we do a SQLite table
 * rebuild: re-create the table with `workspace_id` stripped (preserving every
 * other column, including ALTER-added ones, plus any CHECK / DEFAULT / UNIQUE /
 * PRIMARY KEY clauses), copy all columns except `workspace_id` over, swap it in,
 * and recreate that table's indexes with `workspace_id` removed from their key
 * lists.
 *
 * `outputs_fts` is an FTS5 virtual table (no row rebuild): it carries a
 * `workspace_id UNINDEXED` column that is fully derivable from `outputs`. We
 * drop and recreate it without `workspace_id`; the store's `backfillOutputsFts`
 * repopulates it from `outputs` on next open.
 *
 * Order-independent vs `ensureWorkspaceRuntimeDbSchema` (which already creates
 * the new, `workspace_id`-free schema for fresh DBs) and idempotent: gated on
 * the column actually existing, so it is a no-op on fresh per-workspace DBs.
 *
 * CONTROL-PLANE / LEGACY runtime.db: skipped entirely. The same migration chain
 * runs on the legacy single-file runtime.db (`this.db()`), which historically
 * held these tables for EVERY workspace, keyed by `workspace_id`. That column is
 * NOT redundant there — it is the multi-workspace discriminator that
 * `backfillWorkspaceScopedTableRows` reads (`... WHERE workspace_id = ?`) to copy
 * each workspace's rows into its per-workspace DB on first open. Stripping it
 * there would both break that backfill and collapse all workspaces' rows
 * together. We detect this DB by the presence of the control-plane-only
 * `workspaces` table (never created in a per-workspace DB) and no-op. The legacy
 * tables there are read-only backfill sources; nothing writes `workspace_id`
 * into them anymore, so leaving the dead column in place is harmless.
 */

const REMAINING_TABLES = [
  "turn_results",
  "turn_request_snapshots",
  "subagent_runs",
  "main_session_event_queue",
  "output_folders",
  "outputs",
  "interaction_entities",
  "interaction_leaves",
  "interaction_node_embeddings",
  "cronjobs",
  "runtime_notifications",
  "issues",
  "app_builds",
  "app_ports",
  "terminal_sessions",
  "terminal_session_events",
  "memory_update_proposals",
] as const;

/** Matches a `CREATE INDEX ... ON tbl ()` whose column list ended up empty. */
const INDEX_HAS_EMPTY_COLUMN_LIST = /\(\s*\)\s*$/;

export const migration: Migration = {
  id: 29,
  name: "drop-workspace-id-remaining-tables",
  up: (db) => {
    const existingTables = listTableNames(db);
    // No-op on the control-plane / legacy multi-workspace runtime.db: there the
    // `workspace_id` column on these tables is the per-workspace discriminator
    // the legacy->per-workspace backfill depends on (see the file header). The
    // `workspaces` registry table exists only in that DB, never per-workspace.
    if (existingTables.has("workspaces")) {
      return;
    }
    for (const table of REMAINING_TABLES) {
      if (!existingTables.has(table)) {
        continue;
      }
      if (!tableColumns(db, table).includes("workspace_id")) {
        // Already converted (e.g. fresh schema, or a sibling schema-repair
        // helper rebuilt the table without workspace_id before this ran).
        continue;
      }

      const createSql = tableCreateSql(db, table);
      if (!createSql) {
        continue;
      }
      const newCreateSql = stripWorkspaceIdFromCreateTable(createSql, table);
      const indexSqls = tableIndexCreateSqls(db, table)
        .map((sql) => stripWorkspaceIdFromIndex(sql))
        // Drop indexes whose only column was workspace_id — they collapse to an
        // empty `()` column list (e.g. idx_app_builds_workspace,
        // idx_app_ports_workspace) which SQLite rejects. They carry no value
        // once workspace_id is gone (the table is already workspace-scoped).
        .filter((sql) => !INDEX_HAS_EMPTY_COLUMN_LIST.test(sql));
      const copyColumns = tableColumns(db, table).filter(
        (column) => column !== "workspace_id",
      );
      const columnList = copyColumns.map((column) => `"${column}"`).join(", ");

      db.exec(`
        ${newCreateSql};
        INSERT INTO "${table}__new" (${columnList})
            SELECT ${columnList} FROM "${table}";
        DROP TABLE "${table}";
        ALTER TABLE "${table}__new" RENAME TO "${table}";
        ${indexSqls.map((sql) => `${sql};`).join("\n        ")}
      `);
    }

    // outputs_fts: FTS5 shadow of outputs. Drop the workspace_id UNINDEXED
    // column by recreating the virtual table; the store repopulates it from
    // `outputs` (which keeps no workspace_id either) on next open.
    if (
      existingTables.has("outputs_fts") &&
      ftsHasWorkspaceIdColumn(db, "outputs_fts")
    ) {
      db.exec(`
        DROP TABLE outputs_fts;
        CREATE VIRTUAL TABLE outputs_fts USING fts5(
            id UNINDEXED,
            output_type UNINDEXED,
            module_id UNINDEXED,
            status UNINDEXED,
            produced_by_teammate_id UNINDEXED,
            produced_by_plugin_id UNINDEXED,
            created_at UNINDEXED,
            title,
            file_path,
            body_text,
            tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
    }
  },
};

function listTableNames(db: Parameters<Migration["up"]>[0]): Set<string> {
  return new Set<string>(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}

function tableColumns(
  db: Parameters<Migration["up"]>[0],
  table: string,
): string[] {
  return (
    db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** FTS5 virtual tables expose their columns through PRAGMA table_info too. */
function ftsHasWorkspaceIdColumn(
  db: Parameters<Migration["up"]>[0],
  table: string,
): boolean {
  return tableColumns(db, table).includes("workspace_id");
}

function tableCreateSql(
  db: Parameters<Migration["up"]>[0],
  table: string,
): string | null {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function tableIndexCreateSqls(
  db: Parameters<Migration["up"]>[0],
  table: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
      )
      .all(table) as Array<{ sql: string | null }>
  )
    .map((row) => row.sql ?? "")
    .filter((sql) => sql.trim().length > 0);
}

/**
 * Rewrite a `CREATE TABLE` statement so it targets `<table>__new` and no longer
 * declares `workspace_id`: drops the `workspace_id <type> …` column definition
 * and removes `workspace_id` from any composite `PRIMARY KEY (...)` /
 * `UNIQUE (...)` clause. Everything else (types, NOT NULL, DEFAULT, CHECK, other
 * columns, FOREIGN KEY clauses) is preserved verbatim.
 *
 * Splits the outer `( … )` body on top-level commas so the `workspace_id` column
 * can be dropped regardless of its position (first, middle, or last) without a
 * fragile single regex.
 */
function stripWorkspaceIdFromCreateTable(sql: string, table: string): string {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open === -1 || close === -1 || close <= open) {
    return sql.trim();
  }
  const body = sql.slice(open + 1, close);
  const items = splitTopLevel(body)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => !isWorkspaceIdColumnDef(item))
    .map((item) => stripWorkspaceIdFromKeyClauses(item));

  return `CREATE TABLE "${table}__new" (\n  ${items.join(",\n  ")}\n)`;
}

/** True if a `CREATE TABLE` body item is the `workspace_id` column definition. */
function isWorkspaceIdColumnDef(item: string): boolean {
  return /^(?:"workspace_id"|`workspace_id`|\[workspace_id\]|workspace_id)\b/i.test(
    item,
  );
}

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

/** Strip a `workspace_id` token from PRIMARY KEY / UNIQUE / index column lists. */
function stripWorkspaceIdFromKeyClauses(sql: string): string {
  return sql.replace(/\(([^()]*)\)/g, (match, inner: string) => {
    if (!/\bworkspace_id\b/.test(inner)) {
      return match;
    }
    const columns = inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // Only treat this as a key/column list if every member looks like an
    // identifier (optionally with ASC/DESC). Leave expressions untouched.
    const isColumnList = columns.every((part) =>
      /^(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z0-9_]+)(?:\s+(?:ASC|DESC))?$/i.test(
        part,
      ),
    );
    if (!isColumnList) {
      return match;
    }
    const kept = columns.filter(
      (part) =>
        !/^(?:"workspace_id"|`workspace_id`|\[workspace_id\]|workspace_id)(?:\s+(?:ASC|DESC))?$/i.test(
          part,
        ),
    );
    return `(${kept.join(", ")})`;
  });
}

/**
 * Remove `workspace_id` from an index's indexed-column list, e.g.
 *   ... ON turn_results (workspace_id, session_id, completed_at DESC) ->
 *   ... ON turn_results (session_id, completed_at DESC)
 * Indexes whose only column was `workspace_id` would collapse to `()`, which
 * SQLite rejects — but no such index exists on these tables (every workspace_id
 * index coexists with at least one other column).
 */
function stripWorkspaceIdFromIndex(sql: string): string {
  return stripWorkspaceIdFromKeyClauses(sql);
}
