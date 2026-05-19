import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const preloadSourcePath = path.join(__dirname, "preload.ts");
const electronTypesPath = path.join(
  __dirname,
  "..",
  "src",
  "types",
  "electron.d.ts",
);
const utilsSourcePath = path.join(__dirname, "browser-pane", "utils.ts");

test("desktop browser ignores aborted loadURL rejections during active navigations", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  // ERR_ABORTED detection helpers moved to browser-pane/utils.ts in BP-P5.
  const utilsSource = await readFile(utilsSourcePath, "utf8");

  assert.match(utilsSource, /export function isAbortedBrowserLoadError\(error: unknown\): boolean \{/);
  assert.match(
    utilsSource,
    /candidate\.code === "ERR_ABORTED"[\s\S]*candidate\.errno === -3[\s\S]*candidate\.message\.includes\("ERR_ABORTED"\)/,
  );
  assert.match(
    source,
    /async function navigateActiveBrowserTab\([\s\S]*?await activeTab\.view\.webContents\.loadURL\(targetUrl\);[\s\S]*?if \(isAbortedBrowserLoadError\(error\)\) \{\s*return browserWorkspaceSnapshot\(workspaceId, space, sessionId,[\s\S]*?\);\s*\}/,
  );
  assert.match(
    source,
    /"browser:openHistoryUrl"[\s\S]*?await activeTab\.view\.webContents\.loadURL\(targetUrl\);[\s\S]*?if \(isAbortedBrowserLoadError\(error\)\) \{\s*return browserWorkspaceSnapshot\([\s\S]*workspace\.workspaceId,[\s\S]*activeBrowserSpaceId,[\s\S]*activeBrowserSessionId[\s\S]*\);\s*\}/,
  );
});

test("desktop browser ignores aborted main-frame load failures and initial tab redirects", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const utilsSource = await readFile(utilsSourcePath, "utf8");

  assert.match(
    utilsSource,
    /export function isAbortedBrowserLoadFailure\(\s*errorCode: number,\s*errorDescription: string,\s*\): boolean \{/,
  );
  assert.match(
    utilsSource,
    /errorCode === -3 \|\| errorDescription\.trim\(\)\.toUpperCase\(\) === "ERR_ABORTED"/,
  );
  assert.match(
    source,
    /view\.webContents\.on\(\s*"did-fail-load",[\s\S]*?!isMainFrame \|\|[\s\S]*isAbortedBrowserLoadFailure\(errorCode, errorDescription\)[\s\S]*return;/,
  );
  assert.match(
    source,
    /if \(hasInitialUrl\) \{[\s\S]*view\.webContents\.loadURL\(initialUrl\)\.catch\(\(error\) => \{[\s\S]*if \(isAbortedBrowserLoadError\(error\)\) \{\s*return;\s*\}/,
  );
});

test("desktop browser exposes stop-loading controls through IPC and preload", async () => {
  const mainSource = await readFile(mainSourcePath, "utf8");
  const preloadSource = await readFile(preloadSourcePath, "utf8");
  const electronTypes = await readFile(electronTypesPath, "utf8");

  assert.match(
    mainSource,
    /ipcMain\.handle\("browser:stopLoading", async \(\) => \{[\s\S]*if \(activeTab\?\.view\.webContents\.isLoadingMainFrame\(\)\) \{\s*activeTab\.view\.webContents\.stop\(\);/,
  );
  assert.match(
    preloadSource,
    /stopLoading: \(\) => ipcRenderer\.invoke\("browser:stopLoading"\) as Promise<BrowserTabListPayload>/,
  );
  assert.match(
    electronTypes,
    /stopLoading: \(\) => Promise<BrowserTabListPayload>;/,
  );
});
