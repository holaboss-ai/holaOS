import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

test("desktop diagnostics export wires an About-pane button to the Electron bridge", async () => {
  const [settingsSource, preloadSource, rendererTypesSource] = await Promise.all(
    [
      readFile(SETTINGS_DIALOG_PATH, "utf8"),
      readFile(PRELOAD_PATH, "utf8"),
      readFile(RENDERER_TYPES_PATH, "utf8"),
    ],
  );

  assert.match(settingsSource, /label="Diagnostics bundle"/);
  assert.match(settingsSource, /heading="Export bundle for"/);
  assert.match(
    settingsSource,
    /async function handleExportDiagnosticsBundle\(workspaceId: string\)/,
  );
  assert.match(
    settingsSource,
    /window\.electronAPI\.diagnostics\.exportBundle\(\{\s*workspaceId: trimmed,\s*\}\)/,
  );
  assert.match(
    preloadSource,
    /diagnostics:\s*\{\s*exportBundle: \(payload\?: DiagnosticsExportRequestPayload\) =>\s*ipcRenderer\.invoke\("diagnostics:exportBundle", payload\)/,
  );
  assert.match(
    rendererTypesSource,
    /exportBundle: \(\s*payload\?: DiagnosticsExportRequestPayload,\s*\) => Promise<DiagnosticsExportPayload>;/,
  );
});

test("desktop diagnostics export snapshots host and workspace runtime dbs and redacts runtime config", async () => {
  const [mainSource, bundleSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(BUNDLE_PATH, "utf8"),
  ]);

  assert.match(
    mainSource,
    /handleTrustedIpc\(\s*"diagnostics:exportBundle",\s*\["main"\],\s*async \(_event, payload\?: DiagnosticsExportRequestPayload\) =>\s*exportDesktopDiagnosticsBundle\(payload\),\s*\);/,
  );
  assert.match(mainSource, /runtimeLogPath: runtimeLogsPath\(\),/);
  assert.match(mainSource, /runtimeDbPath: runtimeDatabasePath\(\),/);
  assert.match(mainSource, /runtimeConfigPath: runtimeConfigPath\(\),/);
  assert.match(
    mainSource,
    /const workspaceRuntimeDbPath = workspace\s*\?\s*workspaceRuntimeDbPathForStartupCheck\(\s*workspace\.id,\s*workspace\.workspace_path \?\? null,\s*\)\s*:\s*null;/,
  );
  assert.match(mainSource, /workspaceRuntimeDbPath,/);
  assert.match(mainSource, /workspaceId: workspace\?\.id \?\? null,/);
  assert.match(mainSource, /workspace: workspaceSummary,/);
  assert.match(mainSource, /shell\.showItemInFolder\(result\.bundlePath\);/);
  assert.match(bundleSource, /await database\.backup\(targetPath\);/);
  assert.match(bundleSource, /copyWorkspaceScopedRuntimeDatabase/);
  assert.match(bundleSource, /params\.workspaceRuntimeDbPath\?\.trim\(\) \|\| ""/);
  assert.match(bundleSource, /archivePath: "workspace-runtime\.db"/);
  assert.match(bundleSource, /workspace\.json/);
  assert.match(bundleSource, /runtime-config\.redacted\.json/);
  assert.match(bundleSource, /REDACTED_VALUE = "\[REDACTED\]"/);
});
