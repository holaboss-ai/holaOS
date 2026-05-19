import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const popupsPath = path.join(__dirname, "browser-pane", "popups.ts");
const utilsPath = path.join(__dirname, "browser-pane", "utils.ts");

test("desktop browser keeps auth-style popup windows while promoting ordinary new-window requests into tabs", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  // Popup-frame-name normalisation moved to browser-pane/utils.ts in BP-P5.
  const utilsSource = await readFile(utilsPath, "utf8");

  assert.match(utilsSource, /export function normalizeBrowserPopupFrameName\(\s*frameName\?: string \| null,\s*\): string \{/);
  assert.match(
    utilsSource,
    /export function isBrowserPopupWindowRequest\(\s*frameName\?: string \| null,\s*features\?: string \| null,\s*\): boolean \{/,
  );
  assert.match(
    utilsSource,
    /if \(normalizeBrowserPopupFrameName\(frameName\)\) \{\s*return true;\s*\}/,
  );
  assert.match(
    utilsSource,
    /normalizedFeatures\.includes\("popup"\)[\s\S]*normalizedFeatures\.includes\("width="\)[\s\S]*normalizedFeatures\.includes\("height="\)/,
  );
  assert.match(
    source,
    /const shouldOpenAsTab =\s*disposition === "foreground-tab" \|\|\s*disposition === "background-tab" \|\|\s*disposition === "new-window";/,
  );
  assert.match(
    source,
    /view\.webContents\.setWindowOpenHandler\(\s*\(\{ url, disposition, frameName, features \}\) => \{/,
  );
  assert.match(
    source,
    /if \(shouldAllowBrowserPopupWindow\(normalizedUrl, frameName, features\)\) \{\s*return \{\s*action: "allow",[\s\S]*overrideBrowserWindowOptions: \{[\s\S]*parent: mainWindow \?\? undefined,[\s\S]*width: 520,[\s\S]*height: 760,[\s\S]*session: workspace\.session,/,
  );
  assert.match(
    source,
    /function isBrowserPopupNavigationUrl\(rawUrl: string\): boolean \{[\s\S]*normalizedUrl === "about:blank" \|\| isHttpOrHttpsUrl\(normalizedUrl\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /function shouldAllowBrowserPopupWindow\([\s\S]*normalizedUrl === "about:blank" \|\|[\s\S]*isBrowserPopupWindowRequest\(frameName, features\)/,
  );
  assert.match(
    source,
    /function openExternalUrlFromMain\(rawUrl: string, source: string\): void \{[\s\S]*shell\.openExternal\(normalizedUrl\)\.catch/,
  );
  assert.match(
    source,
    /handleBrowserWindowOpenAsTab\(\s*workspaceId,\s*normalizedUrl,\s*disposition,\s*frameName,\s*browserSpace,\s*normalizedSessionId,\s*\);/,
  );
  assert.match(
    source,
    /const existingPopupTab = Array\.from\(tabSpace\.tabs\.entries\(\)\)\.find\([\s\S]*tab\.popupFrameName === normalizedFrameName[\s\S]*tab\.state\.url === normalizedUrl[\s\S]*now - tab\.popupOpenedAtMs <= DUPLICATE_BROWSER_POPUP_TAB_WINDOW_MS/,
  );
  assert.match(
    source,
    /const DUPLICATE_BROWSER_POPUP_TAB_WINDOW_MS = 2_000;/,
  );
  assert.match(
    source,
    /if \(existingPopupTab\) \{[\s\S]*focusBrowserTabInSpace\(workspaceId, tabSpace, existingTabId, space, sessionId\);[\s\S]*return;\s*\}/,
  );
});

test("desktop browser service exposes explicit tab creation endpoint", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /if \(method === "POST" && pathname === "\/api\/v1\/browser\/tabs"\)/,
  );
});

test("desktop browser overflow popup exposes downloads and history actions", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const popupsSource = await readFile(popupsPath, "utf8");

  // Overflow popup HTML lives in browser-pane/popups.ts (BP-P3 extraction).
  assert.match(popupsSource, /<button class="item" id="downloads"><span class="icon">⭳<\/span><span>Downloads<\/span><\/button>/);
  assert.match(popupsSource, /window\.overflowPopup\.openDownloads\(\)/);
  assert.match(source, /ipcMain\.handle\("browser:overflowOpenDownloads", \(\) => \{/);
  assert.match(source, /browserPanePopups\.toggleDownloadsPopup\(overflowAnchorBounds\);/);
});
