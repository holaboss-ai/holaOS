#!/usr/bin/env node
/**
 * holaboss-runtime — debug CLI for host-state.db inside a sandbox.
 *
 * Use this instead of curling the api-server when you need to:
 *   - Inspect schema version / pending migrations
 *   - List tables and row counts
 *   - Dump a table as JSON
 *   - List workspaces / sessions / cronjobs / queued inputs / failed jobs
 *   - Quick health check
 *
 * The api-server's ts-runner CLI (cli.ts) is JSON-RPC for backend integration;
 * this CLI is for humans tailing logs.
 *
 * Usage:
 *   holaboss-runtime [--db-path <path>] <command> [args]
 *
 *   migrations              Show current user_version + registered migrations
 *   tables                  List tables with row counts
 *   dump <table> [--limit N] [--where 'col=val' ...]
 *                           Print rows as JSON (default limit 100)
 *   workspaces              List workspaces with status + onboarding
 *   sessions <workspace>    List agent sessions for a workspace
 *   jobs                    Queue worker / cron / evolve job snapshot
 *   health                  Quick sanity check (DB opens, schema version, etc.)
 *   help                    Print this message
 *
 * Exit code: 0 on success, 1 on error, 2 on bad usage.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import path from "node:path";

import { LATEST_SEED_VERSION, RUNTIME_DB_MIGRATIONS } from "./migrations/index.js";
import { runtimeDbPath } from "./store.js";

interface ParsedArgs {
  dbPath: string;
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let dbPath = runtimeDbPath();
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db-path") {
      dbPath = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  const [command = "help", ...rest] = positional;
  return { dbPath, command, positional: rest, flags };
}

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("query_only = ON");
  return db;
}

function workspaceRuntimeDbPathForWorkspacePath(workspacePath: string): string {
  return path.join(workspacePath, ".holaboss", "state", "runtime.db");
}

function readUserVersion(db: Database.Database): number {
  const row = db.pragma("user_version") as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

interface CommandContext {
  args: ParsedArgs;
  /** Lazy DB; commands that don't need the DB skip the connection cost. */
  db: () => Database.Database;
  out: (line: string) => void;
}

const commands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  help: ({ out }) => {
    out(USAGE);
    return 0;
  },

  migrations: ({ db, out }) => {
    const current = readUserVersion(db());
    const target = RUNTIME_DB_MIGRATIONS.length === 0
      ? LATEST_SEED_VERSION
      : RUNTIME_DB_MIGRATIONS[RUNTIME_DB_MIGRATIONS.length - 1]!.id;
    out(JSON.stringify({
      current,
      target,
      seedVersion: LATEST_SEED_VERSION,
      pending: RUNTIME_DB_MIGRATIONS.filter((m) => m.id > current).map((m) => ({
        id: m.id,
        name: m.name,
      })),
      registered: RUNTIME_DB_MIGRATIONS.map((m) => ({ id: m.id, name: m.name })),
    }, null, 2));
    return 0;
  },

  tables: ({ db, out }) => {
    const rows = db()
      .prepare<unknown[], { name: string; type: string }>(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all();
    const counts = rows.map((row) => {
      try {
        const c = db()
          .prepare<unknown[], { count: number }>(
            // Quote name to handle reserved-name edge cases. The name comes
            // from sqlite_master so it's already SQL-safe.
            `SELECT COUNT(*) AS count FROM "${row.name.replace(/"/g, '""')}"`,
          )
          .get();
        return { table: row.name, rows: c?.count ?? 0 };
      } catch (error) {
        // Virtual tables (e.g. sqlite-vec's vec0-backed memory_embedding_index)
        // require the extension to be loaded, which a readonly debug session
        // may not have. Surface as an opaque count rather than failing the
        // whole command — `dump` is still available if you need detail.
        return {
          table: row.name,
          rows: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    out(JSON.stringify(counts, null, 2));
    return 0;
  },

  dump: ({ db, args, out }) => {
    const table = args.positional[0];
    if (!table) {
      out("usage: dump <table> [--limit N] [--where 'col=val' ...]");
      return 2;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      out(`refusing to dump table with unsafe name: ${table}`);
      return 2;
    }
    const limit = Number(args.flags.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 0) {
      out(`invalid --limit: ${args.flags.limit}`);
      return 2;
    }
    let where = "";
    const params: unknown[] = [];
    const whereFlag = args.flags.where;
    if (typeof whereFlag === "string") {
      const match = whereFlag.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (!match) {
        out(`invalid --where: expected col=val, got: ${whereFlag}`);
        return 2;
      }
      where = ` WHERE "${match[1]}" = ?`;
      params.push(match[2]);
    }
    const sql = `SELECT * FROM "${table}"${where} LIMIT ?`;
    params.push(limit);
    const rows = db().prepare(sql).all(...params);
    out(JSON.stringify(rows, null, 2));
    return 0;
  },

  workspaces: ({ db, out }) => {
    const rows = db()
      .prepare(
        `SELECT id, name, status, harness, error_message, onboarding_status,
                deleted_at_utc, workspace_path, created_at, updated_at
         FROM workspaces
         ORDER BY datetime(updated_at) DESC NULLS LAST, datetime(created_at) DESC`,
      )
      .all();
    out(JSON.stringify(rows, null, 2));
    return 0;
  },

  sessions: ({ db, args, out }) => {
    const workspaceId = args.positional[0];
    if (!workspaceId) {
      out("usage: sessions <workspace-id>");
      return 2;
    }
    const workspaceRow = db()
      .prepare<[string], { workspace_path: string | null }>(
        "SELECT workspace_path FROM workspaces WHERE id = ? LIMIT 1",
      )
      .get(workspaceId);
    const workspacePath = workspaceRow?.workspace_path?.trim() ?? "";
    const workspaceDbPath = workspacePath
      ? workspaceRuntimeDbPathForWorkspacePath(workspacePath)
      : "";
    const sessionSql = `SELECT s.session_id, s.kind, s.title, s.parent_session_id,
            s.created_at, s.updated_at, s.archived_at,
            rs.status AS runtime_status, rs.current_input_id,
            rs.heartbeat_at, rs.last_error
     FROM agent_sessions AS s
     LEFT JOIN session_runtime_state AS rs
       ON s.workspace_id = rs.workspace_id AND s.session_id = rs.session_id
     WHERE s.workspace_id = ?
     ORDER BY datetime(s.updated_at) DESC`;
    let rows: unknown[] = [];
    if (workspaceDbPath && existsSync(workspaceDbPath)) {
      const workspaceDb = openDb(workspaceDbPath);
      try {
        rows = workspaceDb.prepare(sessionSql).all(workspaceId);
      } finally {
        workspaceDb.close();
      }
    } else {
      const hasLegacySessionsTable = Boolean(
        db()
          .prepare<[string], { present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
          )
          .get("agent_sessions")?.present,
      );
      rows = hasLegacySessionsTable ? db().prepare(sessionSql).all(workspaceId) : [];
    }
    out(JSON.stringify(rows, null, 2));
    return 0;
  },

  jobs: ({ db, out }) => {
    const queueCounts = new Map<string, number>();
    const postRunCounts = new Map<string, number>();
    const cronCounts = new Map<string, number>();
    const evolveCounts = new Map<string, number>();
    const workspaceIdsWithRuntimeDb = new Set<string>();
    const workspaceRows = safeAll(
      db(),
      `SELECT id, workspace_path FROM workspaces WHERE deleted_at_utc IS NULL`,
    );
    if (Array.isArray(workspaceRows)) {
      for (const workspaceRow of workspaceRows as Array<{ id?: string; workspace_path?: string }>) {
        const workspacePath =
          typeof workspaceRow.workspace_path === "string"
            ? workspaceRow.workspace_path.trim()
            : "";
        if (!workspacePath) {
          continue;
        }
        const workspaceRuntimeDbPath = workspaceRuntimeDbPathForWorkspacePath(workspacePath);
        if (!existsSync(workspaceRuntimeDbPath)) {
          continue;
        }
        workspaceIdsWithRuntimeDb.add(String(workspaceRow.id));
        const workspaceDb = openDb(workspaceRuntimeDbPath);
        try {
          const workspaceQueueRows = safeAll(
            workspaceDb,
            `SELECT status, COUNT(*) AS count FROM agent_session_inputs GROUP BY status`,
          );
          if (Array.isArray(workspaceQueueRows)) {
            for (const row of workspaceQueueRows as Array<{ status?: string; count?: number }>) {
              const key = typeof row.status === "string" ? row.status : "";
              queueCounts.set(key, (queueCounts.get(key) ?? 0) + Number(row.count ?? 0));
            }
          }
          const workspacePostRunRows = safeAll(
            workspaceDb,
            `SELECT status, COUNT(*) AS count FROM post_run_jobs GROUP BY status`,
          );
          if (Array.isArray(workspacePostRunRows)) {
            for (const row of workspacePostRunRows as Array<{ status?: string; count?: number }>) {
              const key = typeof row.status === "string" ? row.status : "";
              postRunCounts.set(key, (postRunCounts.get(key) ?? 0) + Number(row.count ?? 0));
            }
          }
          const workspaceCronRows = safeAll(
            workspaceDb,
            `SELECT enabled, COUNT(*) AS count FROM cronjobs GROUP BY enabled`,
          );
          if (Array.isArray(workspaceCronRows)) {
            for (const row of workspaceCronRows as Array<{ enabled?: number; count?: number }>) {
              const key = String(row.enabled ?? 0);
              cronCounts.set(key, (cronCounts.get(key) ?? 0) + Number(row.count ?? 0));
            }
          }
          const workspaceEvolveRows = safeAll(
            workspaceDb,
            `SELECT status AS state, COUNT(*) AS count FROM evolve_skill_candidates GROUP BY status`,
          );
          if (Array.isArray(workspaceEvolveRows)) {
            for (const row of workspaceEvolveRows as Array<{ state?: string; count?: number }>) {
              const key = typeof row.state === "string" ? row.state : "";
              evolveCounts.set(key, (evolveCounts.get(key) ?? 0) + Number(row.count ?? 0));
            }
          }
        } finally {
          workspaceDb.close();
        }
      }
    }
    const legacyWorkspaceIds = Array.from(workspaceIdsWithRuntimeDb);
    const legacyWorkspaceFilter = legacyWorkspaceIds.length > 0
      ? ` WHERE workspace_id NOT IN (${legacyWorkspaceIds.map(() => "?").join(", ")})`
      : "";
    const safeScopedLegacyAll = <T>(sql: string): T[] => {
      try {
        return db().prepare(sql).all(...legacyWorkspaceIds) as T[];
      } catch {
        return [];
      }
    };
    for (const row of safeScopedLegacyAll<Array<{ status?: string; count?: number }>[number]>(
      `SELECT status, COUNT(*) AS count FROM agent_session_inputs${legacyWorkspaceFilter} GROUP BY status`,
    )) {
      const key = typeof row.status === "string" ? row.status : "";
      queueCounts.set(key, (queueCounts.get(key) ?? 0) + Number(row.count ?? 0));
    }
    for (const row of safeScopedLegacyAll<Array<{ status?: string; count?: number }>[number]>(
      `SELECT status, COUNT(*) AS count FROM post_run_jobs${legacyWorkspaceFilter} GROUP BY status`,
    )) {
      const key = typeof row.status === "string" ? row.status : "";
      postRunCounts.set(key, (postRunCounts.get(key) ?? 0) + Number(row.count ?? 0));
    }
    for (const row of safeScopedLegacyAll<Array<{ enabled?: number; count?: number }>[number]>(
      `SELECT enabled, COUNT(*) AS count FROM cronjobs${legacyWorkspaceFilter} GROUP BY enabled`,
    )) {
      const key = String(row.enabled ?? 0);
      cronCounts.set(key, (cronCounts.get(key) ?? 0) + Number(row.count ?? 0));
    }
    for (const row of safeScopedLegacyAll<Array<{ state?: string; count?: number }>[number]>(
      `SELECT status AS state, COUNT(*) AS count FROM evolve_skill_candidates${legacyWorkspaceFilter} GROUP BY status`,
    )) {
      const key = typeof row.state === "string" ? row.state : "";
      evolveCounts.set(key, (evolveCounts.get(key) ?? 0) + Number(row.count ?? 0));
    }
    const queueRows = Array.from(queueCounts.entries()).map(([status, count]) => ({
      status,
      count,
    }));
    const postRunRows = Array.from(postRunCounts.entries()).map(([status, count]) => ({
      status,
      count,
    }));
    const cronRows = Array.from(cronCounts.entries()).map(([enabled, count]) => ({
      enabled: Number(enabled),
      count,
    }));
    const evolveRows = Array.from(evolveCounts.entries()).map(([state, count]) => ({
      state,
      count,
    }));
    out(
      JSON.stringify(
        {
          queue: queueRows,
          cron: cronRows,
          post_run: postRunRows,
          evolve_candidates: evolveRows,
        },
        null,
        2,
      ),
    );
    return 0;
  },

  health: ({ db, args, out }) => {
    const errors: string[] = [];
    let userVersion = 0;
    let tableCount = 0;
    try {
      userVersion = readUserVersion(db());
      const row = db()
        .prepare<unknown[], { count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get();
      tableCount = row?.count ?? 0;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const ok = errors.length === 0 && tableCount > 0;
    out(
      JSON.stringify(
        { ok, dbPath: args.dbPath, userVersion, tableCount, errors },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  },
};

function safeAll(
  db: Database.Database,
  sql: string,
): unknown[] | { error: string } {
  try {
    return db.prepare(sql).all();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const USAGE = `holaboss-runtime — debug CLI for host-state.db

Usage:
  holaboss-runtime [--db-path <path>] <command> [args]

Commands:
  migrations              Schema version + registered/pending migrations
  tables                  List tables with row counts
  dump <table>            Dump a table as JSON (--limit N, --where col=val)
  workspaces              List all workspaces
  sessions <workspace>    List sessions for a workspace + runtime state
  jobs                    Queue / cron / post-run / evolve job snapshot
  health                  Sanity check (returns non-zero if unhealthy)
  help                    Show this message

Flags:
  --db-path <path>        Override host-state.db location (default: env-resolved)`;

export interface RunCliOptions {
  argv?: ReadonlyArray<string>;
  out?: (line: string) => void;
  openDb?: (dbPath: string) => Database.Database;
}

export async function runDebugCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const out = options.out ?? ((line: string) => {
    process.stdout.write(`${line}\n`);
  });
  const args = parseArgs(argv);
  const command = commands[args.command];
  if (!command) {
    out(`unknown command: ${args.command}`);
    out(USAGE);
    return 2;
  }

  const dbOpener = options.openDb ?? openDb;
  const lazyHolder: { db: Database.Database | null } = { db: null };
  const dbGetter = () => {
    if (!lazyHolder.db) {
      lazyHolder.db = dbOpener(args.dbPath);
    }
    return lazyHolder.db;
  };

  try {
    return await command({ args, db: dbGetter, out });
  } catch (error) {
    out(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (lazyHolder.db) {
      try {
        lazyHolder.db.close();
      } catch {
        // ignore
      }
    }
  }
}

// Direct invocation entry — only run when this is the executed script,
// not when imported by tests.
const isMainModule = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1] ?? "";
  return entry.endsWith("debug-cli.mjs") || entry.endsWith("debug-cli.ts");
})();

if (isMainModule) {
  void runDebugCli().then((code) => {
    process.exit(code);
  });
}
