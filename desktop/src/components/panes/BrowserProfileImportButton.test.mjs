import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "BrowserProfileImportButton.tsx");

test("browser profile import button exposes a centered workspace re-import dialog", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /export function BrowserProfileImportButton\(/);
  assert.match(source, /useWorkspaceSelection\(\)/);
  assert.match(source, /import \{ Dialog as DialogPrimitive \} from "@base-ui\/react\/dialog";/);
  assert.match(source, /const \[internalOpen, setInternalOpen\] = useState\(false\);/);
  assert.match(source, /const open = controlledOpen \?\? internalOpen;/);
  assert.match(source, /<DialogPrimitive.Root open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(source, /DialogPrimitive.Backdrop className="fixed inset-0 z-\[120\] bg-scrim backdrop-blur-sm/);
  assert.match(source, /DialogPrimitive.Popup className="fixed top-1\/2 left-1\/2 z-\[121\] flex max-h-\[min\(780px,calc\(100vh-32px\)\)\] w-\[min\(720px,calc\(100vw-32px\)\)\]/);
  assert.match(source, /Set Up Browser Profile/);
  assert.match(source, /Re-import a browser profile or copy one from another[\s\S]*workspace into this workspace browser\./);
  assert.match(source, /PROFILE_SETUP_MODE_OPTIONS/);
  assert.match(source, /Copy from another workspace/);
  assert.match(source, /Import from a browser/);
  assert.match(source, /Current workspace cookies are replaced before import so stale[\s\S]*login[\s\S]*state does not linger\./);
  assert.match(source, /app-bound/);
  assert.match(source, /non-cookie storage/);
  assert.match(source, /sign in/);
  assert.doesNotMatch(source, /PopoverContent/);
});

test("browser profile import button loads profiles and invokes the import IPC", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /onClick=\{\(\) => setOpen\(true\)\}/);
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
