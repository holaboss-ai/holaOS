import archiver from "archiver";
import Database from "better-sqlite3";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DiagnosticsBundleExportParams {
  bundlePath: string;
  runtimeLogPath: string;
  runtimeDbPath: string;
  runtimeConfigPath: string;
  workspaceId?: string | null;
  workspaceSummary?: Record<string, unknown> | null;
  summary: Record<string, unknown>;
}

export interface DiagnosticsBundleExportResult {
  bundlePath: string;
  fileName: string;
  archiveSizeBytes: number;
  includedFiles: string[];
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^authorization$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
];

interface SqliteMasterObject {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface SqliteColumnInfo {
  name: string;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function redactDiagnosticsValue(
  value: unknown,
  keyName = "",
): unknown {
  if (shouldRedactKey(keyName)) {
    if (value === null || value === undefined) {
      return value;
    }
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticsValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDiagnosticsValue(entry, key),
      ]),
    );
  }

  return value;
}

async function copyIfPresent(sourcePath: string, targetPath: string) {
  if (!existsSync(sourcePath)) {
    return false;
  }
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function tableColumns(
  database: Database.Database,
  tableName: string,
): string[] {
  return (
    database
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
      .all() as SqliteColumnInfo[]
  ).map((column) => column.name);
}

function workspaceFilterForTable(
  tableName: string,
  columnNames: Set<string>,
): string | null {
  if (tableName === "workspaces" && columnNames.has("id")) {
    return "id";
  }
  if (columnNames.has("workspace_id")) {
    return "workspace_id";
  }
  return null;
}

function copyWorkspaceTableRows(
  source: Database.Database,
  target: Database.Database,
  tableName: string,
  workspaceId: string,
) {
  const columns = tableColumns(source, tableName);
  if (columns.length === 0) {
    return;
  }
  const columnNames = new Set(columns);
  const filterColumn = workspaceFilterForTable(tableName, columnNames);
  if (!filterColumn) {
    return;
  }

  const quotedColumns = columns.map(quoteSqlIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const quotedTable = quoteSqlIdentifier(tableName);
  const select = source.prepare(
    `SELECT ${quotedColumns} FROM ${quotedTable} WHERE ${quoteSqlIdentifier(
      filterColumn,
    )} = ?`,
  );
  const insert = target.prepare(
    `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`,
  );

  for (const row of select.iterate(workspaceId) as Iterable<
    Record<string, unknown>
  >) {
    insert.run(...columns.map((column) => row[column]));
  }
}

function isVirtualTableObject(object: SqliteMasterObject): boolean {
  return /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(object.sql ?? "");
}

function isVirtualTableShadowObject(
  name: string,
  virtualTableNames: Set<string>,
): boolean {
  for (const virtualTableName of virtualTableNames) {
    if (name === virtualTableName || name.startsWith(`${virtualTableName}_`)) {
      return true;
    }
  }
  return false;
}

function copyWorkspaceScopedRuntimeDatabase(
  sourcePath: string,
  targetPath: string,
  workspaceId: string,
) {
  const source = new Database(sourcePath, {
    fileMustExist: true,
    readonly: true,
  });
  let target: Database.Database | null = null;
  try {
    const tableObjects = source
      .prepare(
        `
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY name ASC
      `,
      )
      .all() as SqliteMasterObject[];
    const virtualTableNames = new Set(
      tableObjects
        .filter(isVirtualTableObject)
        .map((object) => object.name),
    );
    const copiedTableNames = new Set<string>();

    target = new Database(targetPath);
    target.pragma("foreign_keys = OFF");
    target.exec("BEGIN");
    try {
      for (const table of tableObjects) {
        if (isVirtualTableShadowObject(table.name, virtualTableNames)) {
          continue;
        }
        target.exec(table.sql ?? "");
        copiedTableNames.add(table.name);
      }

      for (const tableName of copiedTableNames) {
        copyWorkspaceTableRows(source, target, tableName, workspaceId);
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }

    const postTableObjects = source
      .prepare(
        `
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE type IN ('index', 'trigger', 'view')
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY CASE type
          WHEN 'index' THEN 0
          WHEN 'trigger' THEN 1
          ELSE 2
        END, name ASC
      `,
      )
      .all() as SqliteMasterObject[];
    for (const object of postTableObjects) {
      if (
        object.tbl_name &&
        !copiedTableNames.has(object.tbl_name) &&
        object.type !== "view"
      ) {
        continue;
      }
      try {
        target.exec(object.sql ?? "");
      } catch {
        // Keep the workspace data snapshot even if an auxiliary index/view
        // cannot be recreated in a support bundle environment.
      }
    }
    target.pragma("optimize");
  } finally {
    target?.close();
    source.close();
  }
}

async function backupRuntimeDatabase(
  sourcePath: string,
  targetPath: string,
  workspaceId?: string | null,
) {
  if (!existsSync(sourcePath)) {
    return false;
  }

  const normalizedWorkspaceId = workspaceId?.trim() || "";
  if (normalizedWorkspaceId) {
    await fs.rm(targetPath, { force: true });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    copyWorkspaceScopedRuntimeDatabase(
      sourcePath,
      targetPath,
      normalizedWorkspaceId,
    );
    return true;
  }

  const database = new Database(sourcePath, { fileMustExist: true });
  try {
    await database.backup(targetPath);
    return true;
  } finally {
    database.close();
  }
}

async function writeRedactedRuntimeConfig(
  sourcePath: string,
  targetPath: string,
) {
  if (!existsSync(sourcePath)) {
    return false;
  }

  const rawDocument = await fs.readFile(sourcePath, "utf8");
  let serialized = "";
  try {
    const parsed = JSON.parse(rawDocument) as unknown;
    serialized = `${JSON.stringify(redactDiagnosticsValue(parsed), null, 2)}\n`;
  } catch {
    serialized = `${JSON.stringify(
      {
        error:
          "runtime-config.json could not be parsed for redaction.",
      },
      null,
      2,
    )}\n`;
  }

  await fs.writeFile(targetPath, serialized, "utf8");
  return true;
}

async function createZipArchive(
  bundlePath: string,
  entries: Array<{ sourcePath: string; archivePath: string }>,
) {
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  await fs.rm(bundlePath, { force: true });

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(bundlePath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    for (const entry of entries) {
      archive.file(entry.sourcePath, { name: entry.archivePath });
    }
    void archive.finalize();
  });
}

export async function exportDiagnosticsBundle(
  params: DiagnosticsBundleExportParams,
): Promise<DiagnosticsBundleExportResult> {
  const stagingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-diagnostics-"),
  );
  const includedFiles: string[] = [];

  try {
    const entries: Array<{ sourcePath: string; archivePath: string }> = [];

    const summaryPath = path.join(stagingRoot, "diagnostics-summary.json");
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(params.summary, null, 2)}\n`,
      "utf8",
    );
    entries.push({
      sourcePath: summaryPath,
      archivePath: "diagnostics-summary.json",
    });
    includedFiles.push("diagnostics-summary.json");

    if (params.workspaceSummary) {
      const workspaceSummaryPath = path.join(stagingRoot, "workspace.json");
      await fs.writeFile(
        workspaceSummaryPath,
        `${JSON.stringify(
          redactDiagnosticsValue(params.workspaceSummary),
          null,
          2,
        )}\n`,
        "utf8",
      );
      entries.push({
        sourcePath: workspaceSummaryPath,
        archivePath: "workspace.json",
      });
      includedFiles.push("workspace.json");
    }

    const runtimeLogSnapshotPath = path.join(stagingRoot, "runtime.log");
    if (
      await copyIfPresent(params.runtimeLogPath, runtimeLogSnapshotPath)
    ) {
      entries.push({
        sourcePath: runtimeLogSnapshotPath,
        archivePath: "runtime.log",
      });
      includedFiles.push("runtime.log");
    }

    const runtimeDbSnapshotPath = path.join(stagingRoot, "host-state.db");
    if (
      await backupRuntimeDatabase(
        params.runtimeDbPath,
        runtimeDbSnapshotPath,
        params.workspaceId,
      )
    ) {
      entries.push({
        sourcePath: runtimeDbSnapshotPath,
        archivePath: "host-state.db",
      });
      includedFiles.push("host-state.db");
    }

    const redactedConfigPath = path.join(
      stagingRoot,
      "runtime-config.redacted.json",
    );
    if (
      await writeRedactedRuntimeConfig(
        params.runtimeConfigPath,
        redactedConfigPath,
      )
    ) {
      entries.push({
        sourcePath: redactedConfigPath,
        archivePath: "runtime-config.redacted.json",
      });
      includedFiles.push("runtime-config.redacted.json");
    }

    await createZipArchive(params.bundlePath, entries);
    const archiveStats = await fs.stat(params.bundlePath);

    return {
      bundlePath: params.bundlePath,
      fileName: path.basename(params.bundlePath),
      archiveSizeBytes: archiveStats.size,
      includedFiles,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
