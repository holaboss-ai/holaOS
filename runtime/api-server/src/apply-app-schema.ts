/**
 * Apply a parsed DataSchema to a workspace's data.db. See
 * `docs/plans/2026-04-30-workspace-data-layer-tier2.md`.
 *
 * Lifecycle: called from the runtime's app start/install path before
 * the app process spawns. Must be idempotent — every restart hits
 * this. Must be safe under concurrency — multiple apps can be
 * starting in parallel, each calling apply on the shared data.db.
 *
 * Algorithm:
 *   1. Open data.db (caller has already ensureWorkspaceDataDb'd it).
 *   2. Ensure _app_schema_versions exists.
 *   3. Look up the recorded version for this app id.
 *   4. If recorded.version === manifest.version && recorded.sha === manifest.sha:
 *        no-op.
 *      Else if recorded is missing AND any of the manifest's tables already
 *        exist in DB (pre-Tier-2 workspace):
 *        ADOPT — record the manifest version against the live tables
 *        without running CREATE/ALTER. Future upgrades use the diff path.
 *      Else if recorded is missing:
 *        FRESH INSTALL — CREATE TABLE / CREATE INDEX everything.
 *      Else:
 *        UPGRADE — additive auto-diff:
 *          - new tables → CREATE
 *          - new columns on existing tables → ALTER TABLE ... ADD COLUMN
 *            (rejected if NOT NULL without DEFAULT)
 *          - new indexes → CREATE INDEX
 *        Destructive changes (drop/rename/type) are NOT auto-applied;
 *        the manifest must bump the version and the app must ship an
 *        explicit migration block (out of scope for this iteration —
 *        rejected with an explanatory error).
 */

import Database from "better-sqlite3";

import {
  buildAddColumnDDL,
  buildCreateIndexDDL,
  buildCreateTableDDL,
  type ColumnDef,
  type DataSchema,
  type IndexDef,
  type TableDef,
} from "./data-schema.js";

export interface ApplySchemaOptions {
  appId: string;
  /** Path to the workspace's data.db (caller responsibility:
   *  ensureWorkspaceDataDb has already run). */
  dataDbPath: string;
  schema: DataSchema;
}

export type ApplySchemaResult =
  | { kind: "noop"; version: number }
  | { kind: "adopted"; version: number; tables: string[] }
  | { kind: "fresh"; version: number; tables: string[] }
  | { kind: "upgraded"; from: number; to: number; addedTables: string[]; addedColumns: string[]; addedIndexes: string[] }
  | { kind: "rejected"; reason: string };

export class ApplySchemaError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ApplySchemaError";
  }
}

const VERSIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _app_schema_versions (
    app_id        TEXT PRIMARY KEY,
    version       INTEGER NOT NULL,
    manifest_sha  TEXT NOT NULL,
    applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

interface VersionRow {
  app_id: string;
  version: number;
  manifest_sha: string;
}

export function applyAppSchema(opts: ApplySchemaOptions): ApplySchemaResult {
  const { appId, dataDbPath, schema } = opts;
  const db = new Database(dataDbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(VERSIONS_TABLE_DDL);

    const recorded = db
      .prepare("SELECT app_id, version, manifest_sha FROM _app_schema_versions WHERE app_id = ?")
      .get(appId) as VersionRow | undefined;

    if (recorded && recorded.version === schema.version && recorded.manifest_sha === schema.sha) {
      return { kind: "noop", version: schema.version };
    }

    const liveTables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );

    if (!recorded) {
      const anyTableLives = schema.tables.some((t) => liveTables.has(t.name));
      if (anyTableLives) {
        // Pre-Tier-2 workspace: tables already exist (created by the
        // app's old in-code schema). Adopt the manifest version
        // against the live shape without re-running DDL. Future
        // upgrades use the diff path.
        recordVersion(db, appId, schema);
        return {
          kind: "adopted",
          version: schema.version,
          tables: schema.tables.map((t) => t.name),
        };
      }
      // Genuine fresh install — CREATE everything.
      const txn = db.transaction(() => {
        for (const table of schema.tables) {
          db.exec(buildCreateTableDDL(table));
          for (const idx of table.indexes) {
            db.exec(buildCreateIndexDDL(table.name, idx));
          }
        }
        recordVersion(db, appId, schema);
      });
      txn();
      return {
        kind: "fresh",
        version: schema.version,
        tables: schema.tables.map((t) => t.name),
      };
    }

    // Upgrade path. Diff manifest vs live schema, additive only.
    const diff = diffSchema(db, schema);
    if (diff.destructive.length > 0) {
      // Until explicit migrations are wired up we refuse to silently
      // drop / rename / retype. This keeps the auto-applier safe;
      // when we add migration scripts the rejected branch turns into
      // an "execute scripts then auto-diff additive" branch.
      throw new ApplySchemaError(
        `app "${appId}" v${schema.version} requires destructive changes that need an explicit migration: ${diff.destructive.join("; ")}`,
      );
    }

    const txn = db.transaction(() => {
      for (const table of diff.newTables) {
        db.exec(buildCreateTableDDL(table));
        for (const idx of table.indexes) {
          db.exec(buildCreateIndexDDL(table.name, idx));
        }
      }
      for (const { table, column } of diff.newColumns) {
        db.exec(buildAddColumnDDL(table, column));
      }
      for (const { table, index } of diff.newIndexes) {
        db.exec(buildCreateIndexDDL(table, index));
      }
      recordVersion(db, appId, schema);
    });
    txn();

    return {
      kind: "upgraded",
      from: recorded.version,
      to: schema.version,
      addedTables: diff.newTables.map((t) => t.name),
      addedColumns: diff.newColumns.map((c) => `${c.table}.${c.column.name}`),
      addedIndexes: diff.newIndexes.map((i) => `${i.table}.${i.index.name}`),
    };
  } finally {
    db.close();
  }
}

function recordVersion(db: Database.Database, appId: string, schema: DataSchema): void {
  db.prepare(
    `INSERT INTO _app_schema_versions (app_id, version, manifest_sha)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       version = excluded.version,
       manifest_sha = excluded.manifest_sha,
       applied_at = datetime('now')`,
  ).run(appId, schema.version, schema.sha);
}

interface SchemaDiff {
  newTables: TableDef[];
  newColumns: Array<{ table: string; column: ColumnDef }>;
  newIndexes: Array<{ table: string; index: IndexDef }>;
  /** Human-readable descriptions of changes that are NOT additive. */
  destructive: string[];
}

function diffSchema(db: Database.Database, schema: DataSchema): SchemaDiff {
  const result: SchemaDiff = {
    newTables: [],
    newColumns: [],
    newIndexes: [],
    destructive: [],
  };
  const liveTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  for (const table of schema.tables) {
    if (!liveTables.has(table.name)) {
      result.newTables.push(table);
      continue;
    }
    const liveCols = readLiveColumns(db, table.name);
    for (const col of table.columns) {
      const live = liveCols.get(col.name);
      if (!live) {
        if (col.notNull && col.default === null && !col.primaryKey) {
          result.destructive.push(
            `cannot add NOT NULL column "${table.name}.${col.name}" without a DEFAULT (would fail on existing rows)`,
          );
          continue;
        }
        if (col.primaryKey) {
          result.destructive.push(
            `cannot add PRIMARY KEY column "${table.name}.${col.name}" via ALTER TABLE`,
          );
          continue;
        }
        result.newColumns.push({ table: table.name, column: col });
        continue;
      }
      if (live.type.toUpperCase() !== col.type.toUpperCase()) {
        result.destructive.push(
          `column type changed for "${table.name}.${col.name}": ${live.type} → ${col.type}`,
        );
      }
    }
    // Columns dropped from manifest but present in DB: not destructive
    // by themselves (we just stop using them), so we don't flag.
    const liveIdx = readLiveIndexes(db, table.name);
    for (const idx of table.indexes) {
      if (!liveIdx.has(idx.name)) {
        result.newIndexes.push({ table: table.name, index: idx });
      }
    }
  }
  return result;
}

interface LiveColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

function readLiveColumns(db: Database.Database, table: string): Map<string, LiveColumn> {
  const rows = db
    .prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
    .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const map = new Map<string, LiveColumn>();
  for (const r of rows) {
    map.set(r.name, {
      name: r.name,
      type: r.type,
      notNull: r.notnull === 1,
      primaryKey: r.pk > 0,
    });
  }
  return map;
}

function readLiveIndexes(db: Database.Database, table: string): Set<string> {
  const rows = db
    .prepare(`PRAGMA index_list("${table.replace(/"/g, '""')}")`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
