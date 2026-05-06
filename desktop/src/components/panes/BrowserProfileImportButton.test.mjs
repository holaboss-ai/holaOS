import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "BrowserProfileImportButton.tsx");

test("browser profile import button exposes a workspace re-import popover", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /export function BrowserProfileImportButton\(/);
  assert.match(source, /useWorkspaceSelection\(\)/);
  assert.match(source, /PopoverContent align="end"/);
  assert.match(source, /Set Up Browser Profile/);
  assert.match(source, /Re-import a browser profile or copy one from another workspace into[\s\S]*this workspace browser\./);
  assert.match(source, /PROFILE_SETUP_MODE_OPTIONS/);
  assert.match(source, /Copy from another workspace/);
  assert.match(source, /Import from a browser/);
  assert.match(source, /Current workspace cookies are replaced before import so stale login[\s\S]*state does not linger\./);
  assert.match(source, /Sites that rely on app-bound encryption or[\s\S]*non-cookie storage may still ask you to sign in again\./);
});

test("browser profile import button loads profiles and invokes the import IPC", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /listImportBrowserProfiles\(browserImportSource\)/);
  assert.match(source, /workspaceId: trimmedWorkspaceId,/);
  assert.match(source, /source: browserImportSource,/);
  assert.match(source, /profileDir:\s*browserImportSource === "safari" \|\|\s*profileSelectionDeferredToImportDialog/);
  assert.match(source, /Import Into Workspace Browser/);
  assert.match(source, /browserProfileSummaryMessage/);
  assert.match(source, /prefix: `Imported \$\{summary\.sourceLabel\}\.`/);
  assert.match(source, /Refresh the current page if it still shows an expired-cookie error\./);
});

test("browser profile import button supports copying from another workspace", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /listWorkspaces\(\)/);
  assert.match(source, /workspace\.id !== selectedWorkspaceId/);
  assert.match(source, /workspace\.folder_state !== "missing"/);
  assert.match(source, /copyBrowserWorkspaceProfile\(\{/);
  assert.match(source, /sourceWorkspaceId: copySourceWorkspaceId\.trim\(\),/);
  assert.match(source, /targetWorkspaceId: trimmedWorkspaceId,/);
  assert.match(source, /Copy Into Workspace Browser/);
  assert.match(source, /Copied browser profile from/);
  assert.match(source, /Source workspace/);
});

test("browser profile import button keeps the legacy main-process picker fallback", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /IMPORT_PROFILE_LIST_HANDLER_MISSING_MESSAGE/);
  assert.match(source, /Profile list is unavailable in this desktop session\. Continue and choose the profile in the native import dialog\./);
  assert.match(source, /Browser import cancelled\./);
});
