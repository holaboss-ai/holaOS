import type { Migration } from "../migrations.js";

/**
 * workspace-removal Piece 5: drop the redundant `workspace_id` column from the
 * session-scoped per-workspace runtime DB tables. Inside a per-workspace runtime
 * DB the `workspace_id` is constant (the DB file already scopes the data), so it
 * is removable; rows identify by their own keys (`session_id`, `input_id`,
 * `job_id`, `binding_id`, …) and attach to the runtime.
 *
 * Tables (the session group, tied together by `deleteSession`):
 *   agent_sessions, agent_runtime_sessions, conversation_bindings,
 *   agent_session_inputs, post_run_jobs, session_runtime_state,
 *   session_messages, session_output_events.
 *
 * For each table that still has a `workspace_id` column we do a SQLite table
 * rebuild: re-create the table with `workspace_id` stripped (preserving every
 * other column, including ones added by earlier migrations like
 * `agent_sessions.workflow_run_id` / `.harness_id` / `.review_record_id`, plus
 * any CHECK / DEFAULT clauses), copy all columns except `workspace_id` over,
 * swap it in, and recreate that table's indexes with `workspace_id` removed from
 * their key lists.
 *
 * Order-independent vs `ensureWorkspaceRuntimeDbSchema` (which already creates
 * the new, `workspace_id`-free schema for fresh DBs) and idempotent: gated on
 * the column actually existing, so it is a no-op on fresh DBs and on the
 * control-plane DB (which never had these per-workspace tables).
 *
 * CONTROL-PLANE / LEGACY host-state monolith: skipped entirely (same guard as
 * migration 029). The same migration chain runs on the legacy host-state
 * monolith DB (`this.db()`), which historically held these session tables for
 * EVERY workspace, keyed by `workspace_id`. That column is NOT redundant there —
 * it is the multi-workspace discriminator that `consolidateHostStateMonolithIntoRoot`
 * reads to map each workspace's sessions onto the right `projects` row when
 * folding the monolith into the single root `data.db`. Stripping it there would
 * destroy that discriminator and collapse every workspace's sessions together,
 * making them unrecoverable. We detect this DB by the presence of the
 * control-plane-only `workspaces` table (never created in a per-workspace DB or
 * the root data.db) and no-op.
 */

const SESSION_TABLES = [
  "agent_sessions",
  "agent_runtime_sessions",
  "conversation_bindings",
  "agent_session_inputs",
  "post_run_jobs",
  "session_runtime_state",
  "session_messages",
  "session_output_events",
] as const;

export const migration: Migration = {
  id: 28,
  name: "drop-workspace-id-session-tables",
  up: (db) => {
    const existingTables = listTableNames(db);
    // No-op on the control-plane / legacy host-state monolith DB: there the
    // `workspace_id` column on these session tables is the per-workspace
    // discriminator that the host-state-monolith->root fold depends on (see the
    // file header). The `workspaces` registry table exists only in that DB,
    // never per-workspace and never in the root data.db.
    if (existingTables.has("workspaces")) {
      return;
    }
    for (const table of SESSION_TABLES) {
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
      const indexSqls = tableIndexCreateSqls(db, table).map((sql) =>
        stripWorkspaceIdFromIndex(sql),
      );
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
 * columns) is preserved verbatim.
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

/** Strip a leading/middle `workspace_id` token from PRIMARY KEY / UNIQUE column lists. */
function stripWorkspaceIdFromKeyClauses(sql: string): string {
  return sql.replace(
    /\(([^()]*)\)/g,
    (match, inner: string) => {
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
    },
  );
}

/**
 * Remove `workspace_id` from an index's indexed-column list, e.g.
 *   ... ON agent_sessions (workspace_id, updated_at DESC) -> ... (updated_at DESC)
 * Indexes whose only column was `workspace_id` collapse to `()`, which SQLite
 * rejects — but no such index exists on these tables, and the caller only feeds
 * indexes that already coexisted with other columns.
 */
function stripWorkspaceIdFromIndex(sql: string): string {
  return stripWorkspaceIdFromKeyClauses(sql);
}
