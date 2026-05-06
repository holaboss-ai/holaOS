import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const overflowPreloadPath = path.join(__dirname, "overflowPopupPreload.ts");
const popupsPath = path.join(__dirname, "browser-pane", "popups.ts");
const handlersPath = path.join(__dirname, "browser-pane", "handlers.ts");
const importChromiumPath = path.join(
  __dirname,
  "browser-pane",
  "import-chromium.ts",
);
const importBrowsersPath = path.join(
  __dirname,
  "browser-pane",
  "import-browsers.ts",
);

test("desktop browser import flow discovers a Chrome profile and imports bookmarks, history, and cookies", async () => {
  const chromiumSource = await readFile(importChromiumPath, "utf8");
  const browsersSource = await readFile(importBrowsersPath, "utf8");

  // Chromium profile discovery + selection.
  assert.match(
    chromiumSource,
    /export function resolveChromiumFamilyUserDataRoot\(\s*browser: ChromiumFamilyBrowser,\s*\): string \| null \{/,
  );
  assert.match(
    chromiumSource,
    /export function resolveChromeUserDataRoot\(\): string \| null \{/,
  );
  assert.match(
    chromiumSource,
    /export async function resolveChromiumFamilyProfileSelection\(\s*browser: ChromiumFamilyBrowser,\s*preferredProfileDir: string \| null \| undefined,\s*ownerWindow: BrowserWindow \| null,\s*\): Promise<ChromiumProfileSelection \| null> \{/,
  );
  assert.match(
    chromiumSource,
    /const importableProfiles: ChromiumProfileSelection\[] = \[];/,
  );
  assert.match(
    chromiumSource,
    /export async function discoverChromiumFamilyImportProfiles\(\s*browser: ChromiumFamilyBrowser,\s*\): Promise<\{/,
  );
  assert.match(chromiumSource, /if \(profiles\.length > 1\) \{/);
  assert.match(
    chromiumSource,
    /selectChromiumFamilyProfileDirectory\(\s*browser,\s*userDataDir,\s*ownerWindow,\s*\)/,
  );
  assert.match(
    chromiumSource,
    /export function chromeProfileHasImportableData\(profileDir: string\) \{/,
  );
  assert.match(
    chromiumSource,
    /export async function resolveChromeProfileSelection\(\s*ownerWindow: BrowserWindow \| null,\s*\): Promise<ChromiumProfileSelection \| null> \{/,
  );

  // Bookmark + history readers.
  assert.match(
    chromiumSource,
    /export async function readChromeBookmarks\(\s*profileDir: string,\s*\): Promise<BrowserBookmarkPayload\[]> \{/,
  );
  assert.match(
    chromiumSource,
    /export async function readChromeHistory\(\s*profileDir: string,\s*\): Promise<BrowserHistoryEntryPayload\[]> \{/,
  );

  // Cookie import (chromium family + chrome convenience wrapper).
  assert.match(
    chromiumSource,
    /export async function importChromiumFamilyCookiesIntoWorkspaceSession\(\s*browser: ChromiumFamilyBrowser,\s*browserSession: Session,\s*profileDir: string,\s*\): Promise<BrowserCookieImportSummary> \{/,
  );
  assert.match(
    chromiumSource,
    /export async function importChromeCookiesIntoWorkspaceSession\(\s*browserSession: Session,\s*profileDir: string,\s*\): Promise<BrowserCookieImportSummary> \{/,
  );

  // Cookie decryption helpers (mac keychain + Windows DPAPI + AES).
  assert.match(chromiumSource, /execFileSync\(\s*"security",/);
  assert.match(chromiumSource, /pbkdf2Sync\(\s*safeStoragePassword,/);
  assert.match(
    chromiumSource,
    /export function readChromeWindowsEncryptedKey\(userDataDir: string\) \{/,
  );
  assert.match(chromiumSource, /ProtectedData\]::Unprotect/);
  assert.match(
    chromiumSource,
    /export function decryptChromeCookieValueWindows\(\s*encryptedValue: Buffer,\s*encryptionKey: Buffer,\s*\) \{/,
  );
  assert.match(
    chromiumSource,
    /export function stripChromeCookieDomainHashPrefix\(\s*hostKey: string,\s*decryptedValue: Buffer,\s*\) \{/,
  );
  assert.match(
    chromiumSource,
    /createHash\("sha256"\)\.update\(hostKey, "utf8"\)\.digest\(\)/,
  );
  assert.match(
    chromiumSource,
    /cookieValue = decodeChromeCookieValue\(\s*row\.host_key,\s*decryptedValue,\s*\);/,
  );
  assert.match(
    chromiumSource,
    /CHROME_WINDOWS_APP_BOUND_COOKIE_PREFIX = "v20"/,
  );
  assert.match(
    chromiumSource,
    /App-Bound encryption and cannot be imported from a different desktop app/,
  );
  assert.match(
    chromiumSource,
    /const nowEpochSeconds = Date\.now\(\) \/ 1000;/,
  );
  assert.match(
    chromiumSource,
    /Skipped \$\{expiredCount\} expired \$\{browserDisplayName\} cookies\./,
  );
  assert.match(
    chromiumSource,
    /const transferableCookies: Array<\{/,
  );
  assert.match(
    chromiumSource,
    /if \(transferableCookies\.length === 0\) \{/,
  );
  assert.match(
    chromiumSource,
    /const stagedSession = session\.fromPartition\(/,
  );
  assert.match(
    chromiumSource,
    /await stagedSession\.clearStorageData\(\{ storages: \["cookies"\] \}\);/,
  );
  assert.match(
    chromiumSource,
    /await browserSession\.clearStorageData\(\{ storages: \["cookies"\] \}\);/,
  );
  assert.match(chromiumSource, /await browserSession\.cookies\.set\(/);
  assert.match(chromiumSource, /await browserSession\.cookies\.flushStore\(\);/);

  // Public orchestration entry points moved to import-browsers.ts.
  assert.match(
    browsersSource,
    /export async function listImportBrowserProfiles\(\s*source: BrowserImportSource,\s*\): Promise<BrowserImportProfileOptionPayload\[]> \{/,
  );
  assert.match(
    browsersSource,
    /export async function importChromiumFamilyProfileIntoWorkspace\(\s*browser: ChromiumFamilyBrowser,\s*workspaceId: string \| null \| undefined,\s*profileDir: string \| null \| undefined,\s*deps: BrowserImportDeps,\s*\): Promise<BrowserImportSummary \| null> \{/,
  );
  assert.match(
    browsersSource,
    /export async function importSafariProfileIntoWorkspace\(\s*workspaceId: string \| null \| undefined,\s*safariArchivePath: string \| null \| undefined,\s*deps: BrowserImportDeps,\s*\): Promise<BrowserImportSummary \| null> \{/,
  );
  assert.match(
    browsersSource,
    /export async function importBrowserProfileIntoWorkspace\(\s*payload: BrowserImportProfilePayload,\s*deps: BrowserImportDeps,\s*\): Promise<BrowserImportSummary \| null> \{/,
  );
  assert.match(
    browsersSource,
    /export async function copyBrowserWorkspaceProfile\(\s*payload: BrowserCopyWorkspaceProfilePayload,\s*deps: BrowserImportDeps,\s*\): Promise<BrowserImportSummary> \{/,
  );
  assert.match(
    browsersSource,
    /cookieSummary\.importedCount === 0 &&\s*\(bookmarkCount > 0 \|\| historyCount > 0\)/,
  );
  assert.match(
    browsersSource,
    /Skipped \$\{expiredCount\} expired workspace cookies\./,
  );
  assert.match(
    browsersSource,
    /export async function importChromeProfileIntoWorkspace\(\s*workspaceId: string \| null \| undefined,\s*deps: BrowserImportDeps,\s*\): Promise<BrowserImportSummary \| null> \{/,
  );
});

test("desktop browser overflow popup exposes Chrome import and reports the result", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const popupsSource = await readFile(popupsPath, "utf8");
  const handlersSource = await readFile(handlersPath, "utf8");

  // Overflow popup HTML lives in browser-pane/popups.ts (BP-P3 extraction).
  assert.match(
    popupsSource,
    /<button class="item" id="chrome-import"><span class="icon">⇪<\/span><span>Import Chrome<\/span><\/button>/,
  );
  assert.match(popupsSource, /window\.overflowPopup\.importChrome\(\)/);
  assert.match(
    handlersSource,
    /ipcMain\.handle\("browser:overflowImportChrome", async \(\) => \{/,
  );
  assert.match(
    handlersSource,
    /Chrome data was imported into this workspace browser\./,
  );
  assert.match(handlersSource, /Could not import data from Chrome\./);
  assert.match(
    source,
    /handleTrustedIpc\(\s*"workspace:listImportBrowserProfiles",/,
  );
  assert.match(
    source,
    /handleTrustedIpc\(\s*"workspace:importBrowserProfile",/,
  );
  assert.match(
    source,
    /handleTrustedIpc\(\s*"workspace:copyBrowserWorkspaceProfile",/,
  );
});

test("overflow popup preload exposes the Chrome import action", async () => {
  const source = await readFile(overflowPreloadPath, "utf8");

  assert.match(
    source,
    /importChrome: \(\) =>\s*ipcRenderer\.invoke\("browser:overflowImportChrome"\) as Promise<void>,/,
  );
});
