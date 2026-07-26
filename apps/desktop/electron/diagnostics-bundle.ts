import archiver from "archiver";
import Database from "better-sqlite3";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DiagnosticsBundleDatabase {
  /** Absolute path to the SQLite database to snapshot. */
  sourcePath: string;
  /** File name the snapshot is stored under inside the bundle zip. */
  archiveName: string;
}

export interface DiagnosticsBundleExportParams {
  bundlePath: string;
  runtimeLogPath: string;
  /**
   * Full backups of the runtime's databases (root data.db, host-state.db,
   * control-plane.db, …). Each is snapshotted with SQLite's online backup API
   * and stored under its archiveName; missing files are skipped.
   */
  databases: DiagnosticsBundleDatabase[];
  runtimeConfigPath: string;
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

interface DatabaseBackupResult {
  /** A snapshot file was produced at targetPath. */
  copied: boolean;
  /** The snapshot passed PRAGMA quick_check. false → may be partially corrupt. */
  integrityOk: boolean;
}

async function backupDatabase(
  sourcePath: string,
  targetPath: string,
): Promise<DatabaseBackupResult> {
  if (!existsSync(sourcePath)) {
    return { copied: false, integrityOk: false };
  }
  // Read-only source: a backup only ever reads, so it can never write to,
  // lock, or corrupt the live DB. SQLite's online backup API yields a
  // consistent snapshot even while the runtime holds the DB open in WAL mode —
  // unlike a raw file copy, which tears a live WAL database into an unusable,
  // corrupt mess (the failure mode this replaced).
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(targetPath);
  } catch {
    // Interrupted/failed backup — drop any partial output so it's never shipped.
    await fs.rm(targetPath, { force: true });
    return { copied: false, integrityOk: false };
  } finally {
    source.close();
  }
  // Verify before shipping. A completed backup of a healthy DB is always
  // consistent, so a failure here means the *source* was already corrupt — flag
  // it rather than hand over a DB that silently wastes hours to debug. Also
  // fold the snapshot out of WAL mode so it's a single self-contained file the
  // team can open read-only anywhere (no -wal/-shm sidecars required).
  let integrityOk = false;
  try {
    const verify = new Database(targetPath, { fileMustExist: true });
    try {
      verify.pragma("journal_mode = DELETE");
      integrityOk = verify.pragma("quick_check", { simple: true }) === "ok";
    } finally {
      verify.close();
    }
  } catch {
    integrityOk = false;
  }
  return { copied: true, integrityOk };
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
        error: "runtime-config.json could not be parsed for redaction.",
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

    const runtimeLogSnapshotPath = path.join(stagingRoot, "runtime.log");
    if (await copyIfPresent(params.runtimeLogPath, runtimeLogSnapshotPath)) {
      entries.push({
        sourcePath: runtimeLogSnapshotPath,
        archivePath: "runtime.log",
      });
      includedFiles.push("runtime.log");
    }

    const seenArchiveNames = new Set<string>();
    for (const database of params.databases) {
      const archiveName = database.archiveName.trim();
      const sourcePath = database.sourcePath.trim();
      if (!archiveName || !sourcePath || seenArchiveNames.has(archiveName)) {
        continue;
      }
      const snapshotPath = path.join(stagingRoot, archiveName);
      const backup = await backupDatabase(sourcePath, snapshotPath);
      if (backup.copied) {
        seenArchiveNames.add(archiveName);
        entries.push({ sourcePath: snapshotPath, archivePath: archiveName });
        includedFiles.push(archiveName);
        if (!backup.integrityOk) {
          // Snapshot failed quick_check — ship it (it may still be partially
          // recoverable) but drop a loud marker so nobody burns hours on a DB
          // that was already corrupt at the source.
          const warnName = `${archiveName}.INTEGRITY_FAILED.txt`;
          const warnPath = path.join(stagingRoot, warnName);
          await fs.writeFile(
            warnPath,
            `${archiveName} failed PRAGMA quick_check when this bundle was exported.\n` +
              `It was already corrupt at the source; the snapshot is faithful but not directly usable.\n` +
              `Recover what's readable with:\n` +
              `  sqlite3 ${archiveName} ".recover" | sqlite3 ${archiveName}.recovered\n`,
            "utf8",
          );
          entries.push({ sourcePath: warnPath, archivePath: warnName });
          includedFiles.push(warnName);
        }
      }
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
