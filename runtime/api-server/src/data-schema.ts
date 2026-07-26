/**
 * Parser + DDL builder for the `data_schema:` block of an app's
 * `app.runtime.yaml`. See `docs/plans/2026-04-30-workspace-data-layer-tier2.md`.
 *
 * Pure functions over the manifest object. No SQLite I/O — that lives
 * in apply-app-schema.ts. Keeping the two split makes the parser
 * trivial to unit test and keeps DDL string generation testable
 * without touching the filesystem.
 */

import { createHash } from "node:crypto";

export type ColumnVisibility = "user_facing" | "app_internal" | "runtime_internal";

export interface ColumnDef {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default: string | null;
}

export interface IndexDef {
  name: string;
  columns: string[];
  /** Optional WHERE clause for partial indexes. */
  where: string | null;
  unique: boolean;
}

export interface TableDef {
  name: string;
  visibility: ColumnVisibility;
  columns: ColumnDef[];
  /** Composite primary key when set; takes precedence over per-column primary_key. */
  primaryKey: string[] | null;
  indexes: IndexDef[];
}

export interface DataSchema {
  version: number;
  tables: TableDef[];
  /** Stable hash of the manifest contents — recorded with the
   *  applied version so we can detect tampering / out-of-band edits. */
  sha: string;
}

const COLUMN_TYPE_RE = /^[A-Z][A-Z0-9_ ]*$/i;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export class DataSchemaError extends Error {
  constructor(public path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DataSchemaError";
  }
}

/** Parse a `data_schema:` block (already JS-deserialized from YAML)
 *  into a normalized DataSchema. Throws DataSchemaError on the first
 *  shape problem; we don't attempt partial parsing because a broken
 *  manifest should never silently apply half a schema. */
export function parseDataSchema(raw: unknown, options: { appId: string }): DataSchema {
  if (!isRecord(raw)) {
    throw new DataSchemaError("data_schema", "must be an object");
  }
  const versionRaw = raw.version;
  if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw) || versionRaw < 1) {
    throw new DataSchemaError("data_schema.version", "must be a positive integer");
  }
  const tablesRaw = raw.tables;
  if (!isRecord(tablesRaw)) {
    throw new DataSchemaError("data_schema.tables", "must be an object keyed by table name");
  }
  const tables: TableDef[] = [];
  for (const [name, table] of Object.entries(tablesRaw)) {
    tables.push(parseTable(name, table, options.appId));
  }
  if (tables.length === 0) {
    throw new DataSchemaError("data_schema.tables", "must declare at least one table");
  }
  return {
    version: versionRaw,
    tables,
    sha: hashSchema(versionRaw, tables),
  };
}

function parseTable(name: string, raw: unknown, appId: string): TableDef {
  const path = `data_schema.tables.${name}`;
  if (!NAME_RE.test(name)) {
    throw new DataSchemaError(path, "table name must be lower_snake_case (start with a letter)");
  }
  // Namespace hygiene: workspace-shared tables must be prefixed with the
  // app id so cross-app collisions are impossible. Underscore-prefixed
  // names are reserved for runtime-internal tables (_workspace_meta,
  // _app_schema_versions) and apps may not declare them.
  if (name.startsWith("_")) {
    throw new DataSchemaError(path, "table name must not start with `_` (reserved for runtime)");
  }
  if (!name.startsWith(`${appId}_`)) {
    throw new DataSchemaError(
      path,
      `table name must start with the app id prefix "${appId}_" so the workspace data layer stays unambiguous`,
    );
  }
  if (!isRecord(raw)) {
    throw new DataSchemaError(path, "must be an object");
  }
  const visibility = parseVisibility(`${path}.visibility`, raw.visibility);
  const columns = parseColumns(`${path}.columns`, raw.columns);
  const primaryKey = parsePrimaryKey(`${path}.primary_key`, raw.primary_key, columns);
  const indexes = parseIndexes(`${path}.indexes`, raw.indexes);
  return { name, visibility, columns, primaryKey, indexes };
}

function parseVisibility(path: string, raw: unknown): ColumnVisibility {
  if (raw === undefined) return "user_facing";
  if (typeof raw !== "string") {
    throw new DataSchemaError(path, "must be a string");
  }
  if (raw === "user_facing" || raw === "app_internal" || raw === "runtime_internal") {
    return raw;
  }
  throw new DataSchemaError(
    path,
    `must be one of: user_facing, app_internal, runtime_internal (got ${JSON.stringify(raw)})`,
  );
}

function parseColumns(path: string, raw: unknown): ColumnDef[] {
  if (!isRecord(raw)) {
    throw new DataSchemaError(path, "must be an object keyed by column name");
  }
  const columns: ColumnDef[] = [];
  for (const [name, def] of Object.entries(raw)) {
    columns.push(parseColumn(`${path}.${name}`, name, def));
  }
  if (columns.length === 0) {
    throw new DataSchemaError(path, "must declare at least one column");
  }
  return columns;
}

function parseColumn(path: string, name: string, raw: unknown): ColumnDef {
  if (!NAME_RE.test(name)) {
    throw new DataSchemaError(path, "column name must be lower_snake_case");
  }
  if (!isRecord(raw)) {
    throw new DataSchemaError(path, "must be an object with at least { type }");
  }
  if (typeof raw.type !== "string" || !COLUMN_TYPE_RE.test(raw.type)) {
    throw new DataSchemaError(`${path}.type`, "must be a SQL type string (e.g. TEXT, INTEGER, REAL)");
  }
  const primaryKey = raw.primary_key === true;
  const notNull = raw.not_null === true || primaryKey; // PK implies NOT NULL
  const def = raw.default;
  if (def !== undefined && typeof def !== "string") {
    throw new DataSchemaError(`${path}.default`, "must be a SQL expression string when present");
  }
  return {
    name,
    type: raw.type.toUpperCase(),
    primaryKey,
    notNull,
    default: typeof def === "string" ? def : null,
  };
}

function parsePrimaryKey(path: string, raw: unknown, columns: ColumnDef[]): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new DataSchemaError(path, "must be an array of column names when present");
  }
  const cols = raw as string[];
  if (cols.length === 0) {
    throw new DataSchemaError(path, "must contain at least one column name");
  }
  const declared = new Set(columns.map((c) => c.name));
  for (const c of cols) {
    if (!declared.has(c)) {
      throw new DataSchemaError(path, `references undeclared column "${c}"`);
    }
  }
  // Mutually exclusive with per-column primary_key markers.
  if (columns.some((c) => c.primaryKey)) {
    throw new DataSchemaError(
      path,
      "cannot combine table-level primary_key with column-level primary_key markers",
    );
  }
  return cols;
}

function parseIndexes(path: string, raw: unknown): IndexDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new DataSchemaError(path, "must be an array of index definitions");
  }
  return raw.map((entry, i) => parseIndex(`${path}[${i}]`, entry));
}

function parseIndex(path: string, raw: unknown): IndexDef {
  if (!isRecord(raw)) {
    throw new DataSchemaError(path, "must be an object");
  }
  if (typeof raw.name !== "string" || !NAME_RE.test(raw.name)) {
    throw new DataSchemaError(`${path}.name`, "must be a lower_snake_case index name");
  }
  if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.some((c) => typeof c !== "string")) {
    throw new DataSchemaError(`${path}.columns`, "must be a non-empty array of column names");
  }
  const where = raw.where;
  if (where !== undefined && typeof where !== "string") {
    throw new DataSchemaError(`${path}.where`, "must be a string SQL expression when present");
  }
  return {
    name: raw.name,
    columns: raw.columns as string[],
    where: typeof where === "string" ? where : null,
    unique: raw.unique === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the CREATE TABLE statement for a TableDef. */
export function buildCreateTableDDL(table: TableDef): string {
  const colLines = table.columns.map((c) => buildColumnLine(c, table));
  const tableConstraints: string[] = [];
  if (table.primaryKey && table.primaryKey.length > 0) {
    tableConstraints.push(`PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  const all = [...colLines, ...tableConstraints].join(",\n  ");
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n  ${all}\n);`;
}

function buildColumnLine(col: ColumnDef, table: TableDef): string {
  const parts: string[] = [quoteIdent(col.name), col.type];
  // Per-column primary key only when there's no table-level composite PK.
  if (col.primaryKey && (!table.primaryKey || table.primaryKey.length === 0)) {
    parts.push("PRIMARY KEY");
  }
  if (col.notNull && !col.primaryKey) {
    parts.push("NOT NULL");
  }
  if (col.default !== null) {
    parts.push(`DEFAULT ${col.default}`);
  }
  return parts.join(" ");
}

/** Build the CREATE INDEX statement for an IndexDef on a given table. */
export function buildCreateIndexDDL(table: string, idx: IndexDef): string {
  const unique = idx.unique ? "UNIQUE " : "";
  const cols = idx.columns.map(quoteIdent).join(", ");
  const where = idx.where ? ` WHERE ${idx.where}` : "";
  return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idx.name)} ON ${quoteIdent(table)} (${cols})${where};`;
}

/** Build a single ADD COLUMN statement (auto-diff for additive upgrades).
 *  SQLite forbids ADD COLUMN for NOT NULL columns without a default and
 *  for PRIMARY KEY columns; the applier checks before invoking. */
export function buildAddColumnDDL(table: string, col: ColumnDef): string {
  const parts: string[] = [quoteIdent(col.name), col.type];
  if (col.notNull) parts.push("NOT NULL");
  if (col.default !== null) parts.push(`DEFAULT ${col.default}`);
  return `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${parts.join(" ")};`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Stable, deterministic hash of the parsed schema. The applier records
 *  this alongside the version so we can tell apart "version 4 of
 *  manifest A" from "version 4 of manifest B" — useful when an app's
 *  yaml gets edited out-of-band without a version bump. */
function hashSchema(version: number, tables: TableDef[]): string {
  const normalized = JSON.stringify({
    version,
    tables: tables.map((t) => ({
      name: t.name,
      visibility: t.visibility,
      primaryKey: t.primaryKey,
      columns: t.columns,
      indexes: t.indexes,
    })),
  });
  return createHash("sha256").update(normalized).digest("hex");
}
