import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  exportDiagnosticsBundle,
  redactDiagnosticsValue,
} from "./diagnostics-bundle.ts";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const BUNDLE_PATH = new URL("./diagnostics-bundle.ts", import.meta.url);
const SETTINGS_DIALOG_PATH = new URL(
  "../src/components/layout/SettingsScreenRoot.tsx",
  import.meta.url,
);
const RENDERER_TYPES_PATH = new URL(
  "../src/types/electron.d.ts",
  import.meta.url,
);

function seedDatabase(filePath) {
  const db = new Database(filePath);
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
  } finally {
    db.close();
  }
}

test("desktop diagnostics export wires the About-pane button to the Electron bridge with no workspace arg", async () => {
  const [settingsSource, preloadSource, rendererTypesSource] = await Promise.all(
    [
      readFile(SETTINGS_DIALOG_PATH, "utf8"),
      readFile(PRELOAD_PATH, "utf8"),
      readFile(RENDERER_TYPES_PATH, "utf8"),
    ],
  );

  assert.match(settingsSource, /label="Diagnostics bundle"/);
  assert.match(
    settingsSource,
    /async function handleExportDiagnosticsBundle\(\)/,
  );
  assert.match(
    settingsSource,
    /window\.electronAPI\.diagnostics\.exportBundle\(\)/,
  );
  // The workspace picker is gone — no per-workspace selection remains.
  assert.doesNotMatch(settingsSource, /diagnosticsWorkspaceOptions/);
  assert.match(
    preloadSource,
    /exportBundle: \(\) =>\s*ipcRenderer\.invoke\("diagnostics:exportBundle"\)/,
  );
  assert.match(
    rendererTypesSource,
    /exportBundle: \(\) => Promise<DiagnosticsExportPayload>;/,
  );
});

test("desktop diagnostics export snapshots the overall runtime databases and redacts the config", async () => {
  const [mainSource, bundleSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(BUNDLE_PATH, "utf8"),
  ]);

  assert.match(
    mainSource,
    /handleTrustedIpc\("diagnostics:exportBundle", \["main"\], async \(\) =>\s*exportDesktopDiagnosticsBundle\(\),\s*\);/,
  );
  // The overall snapshot captures the root runtime store plus the host/control
  // registries — no workspace-scoped slice.
  assert.match(mainSource, /archiveName: "data\.db"/);
  assert.match(mainSource, /archiveName: "host-state\.db"/);
  assert.match(mainSource, /archiveName: "control-plane\.db"/);
  // No workspace gate remains — the export never resolves or rejects on a
  // selected workspace.
  assert.doesNotMatch(mainSource, /resolveDiagnosticsWorkspace/);
  assert.doesNotMatch(mainSource, /not available for diagnostics export/);
  assert.match(bundleSource, /await source\.backup\(targetPath\)/);
  // Source opened read-only (a backup only reads → can never touch the live
  // DB), and the snapshot is integrity-verified before shipping so a corrupt
  // capture is flagged rather than silently handed over.
  assert.match(bundleSource, /readonly: true/);
  assert.match(bundleSource, /quick_check/);
  assert.match(bundleSource, /INTEGRITY_FAILED/);
  assert.doesNotMatch(bundleSource, /copyWorkspaceScopedRuntimeDatabase/);
  assert.doesNotMatch(bundleSource, /workspace-runtime\.db/);
  assert.match(bundleSource, /runtime-config\.redacted\.json/);
  assert.match(bundleSource, /REDACTED_VALUE = "\[REDACTED\]"/);
});

test("exportDiagnosticsBundle includes every present runtime database and skips missing inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hb-diag-export-"));
  try {
    const dataDb = path.join(root, "state", "data.db");
    const hostDb = path.join(root, "state", "host-state.db");
    const controlDb = path.join(root, "state", "control-plane.db");
    await mkdir(path.join(root, "state"), { recursive: true });
    seedDatabase(dataDb);
    seedDatabase(hostDb);
    seedDatabase(controlDb);

    const runtimeLogPath = path.join(root, "runtime.log");
    await writeFile(runtimeLogPath, "boot ok\n", "utf8");
    const runtimeConfigPath = path.join(root, "runtime-config.json");
    await writeFile(
      runtimeConfigPath,
      JSON.stringify({ api_key: "sk-should-be-hidden", port: 8080 }),
      "utf8",
    );

    const bundlePath = path.join(root, "out", "bundle.zip");
    const result = await exportDiagnosticsBundle({
      bundlePath,
      runtimeLogPath,
      databases: [
        { sourcePath: dataDb, archiveName: "data.db" },
        { sourcePath: hostDb, archiveName: "host-state.db" },
        { sourcePath: controlDb, archiveName: "control-plane.db" },
        // A path that does not exist must be skipped, not throw.
        { sourcePath: path.join(root, "state", "missing.db"), archiveName: "missing.db" },
      ],
      runtimeConfigPath,
      summary: { exported_at: "2026-06-29T00:00:00.000Z", runtime_status: "ok" },
    });

    assert.deepEqual(
      [...result.includedFiles].sort(),
      [
        "control-plane.db",
        "data.db",
        "diagnostics-summary.json",
        "host-state.db",
        "runtime-config.redacted.json",
        "runtime.log",
      ],
    );
    assert.ok(!result.includedFiles.includes("missing.db"));
    const stats = await stat(bundlePath);
    assert.ok(stats.size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportDiagnosticsBundle works with no databases and a missing log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hb-diag-empty-"));
  try {
    const bundlePath = path.join(root, "bundle.zip");
    const result = await exportDiagnosticsBundle({
      bundlePath,
      runtimeLogPath: path.join(root, "does-not-exist.log"),
      databases: [],
      runtimeConfigPath: path.join(root, "does-not-exist.json"),
      summary: { exported_at: "2026-06-29T00:00:00.000Z" },
    });
    // Always at least the summary; nothing throws when inputs are absent.
    assert.deepEqual(result.includedFiles, ["diagnostics-summary.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactDiagnosticsValue masks sensitive keys and preserves the rest", () => {
  const redacted = redactDiagnosticsValue({
    api_key: "secret",
    access_token: "t",
    nested: { password: "p", port: 8080 },
    keep: "visible",
  });
  assert.deepEqual(redacted, {
    api_key: "[REDACTED]",
    access_token: "[REDACTED]",
    nested: { password: "[REDACTED]", port: 8080 },
    keep: "visible",
  });
});
