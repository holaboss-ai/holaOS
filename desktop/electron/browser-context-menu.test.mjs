import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const TAB_STATE_PATH = new URL("./browser-pane/tab-state.ts", import.meta.url);
const HTTP_SERVICE_PATH = new URL("./browser-pane/http-service.ts", import.meta.url);

test("browser tabs register a native context menu for BrowserView content", async () => {
  const source = await readFile(TAB_STATE_PATH, "utf8");

  assert.match(source, /Menu,/);
  assert.match(source, /clipboard,/);
  assert.match(source, /type ContextMenuParams,/);
  assert.match(source, /type MenuItemConstructorOptions,/);
  assert.match(source, /function showBrowserViewContextMenu\(/);
  assert.match(source, /const popupX = browserBounds\.x \+ context\.x;/);
  assert.match(source, /const popupY = browserBounds\.y \+ context\.y;/);
  assert.match(
    source,
    /view\.webContents\.on\("context-menu", \(_event, params\) => \{\s*showBrowserViewContextMenu\(\{\s*workspaceId,\s*space: browserSpace,\s*sessionId: normalizedSessionId,\s*view,\s*context: params,/,
  );
  assert.match(source, /label: "Open Link in New Tab"/);
  assert.match(source, /label: "Open Link Externally"/);
  assert.match(source, /label: "Copy Link Address"/);
  assert.match(source, /clipboard\.writeText\(linkUrl\);/);
  assert.match(source, /function browserContextSuggestedFilename\(/);
  assert.match(source, /function queueBrowserDownloadPrompt\(/);
  assert.match(source, /label: "Open Image in New Tab"/);
  assert.match(source, /label: "Copy Image Address"/);
  assert.match(source, /label: "Save Image As\.\.\."/);
  assert.match(source, /queueBrowserDownloadPrompt\(workspaceId, imageUrl,/);
  assert.match(source, /void view\.webContents\.downloadURL\(imageUrl\);/);
  assert.match(source, /label: "Cut", role: "cut"/);
  assert.match(source, /label: "Copy", role: "copy"/);
  assert.match(source, /label: "Paste", role: "paste"/);
  assert.match(source, /label: "Back"/);
  assert.match(source, /label: "Forward"/);
  assert.match(source, /label: "Reload"/);
  assert.match(source, /Menu\.buildFromTemplate\(template\)\.popup\(\{/);
  assert.match(source, /frame: context\.frame \?\? undefined/);
  assert.match(source, /x: popupX,/);
  assert.match(source, /y: popupY,/);
});

test("desktop browser service exposes a real context-click endpoint for BrowserView input", async () => {
  const source = await readFile(HTTP_SERVICE_PATH, "utf8");

  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/context-click"\)/);
  assert.match(source, /await deps\.withTemporarilyRenderedBrowserTab\(\s*activeTab,\s*async \(\) =>\s*deps\.withProgrammaticBrowserInput\(\s*activeTab\.view\.webContents,\s*async \(\) => \{/s);
  assert.match(source, /activeTab\.view\.webContents\.focus\(\);/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseMove",/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseDown",[\s\S]*button: "right",/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseUp",[\s\S]*button: "right",/);
  assert.match(source, /\{\s*requireFocusedWindow: true,\s*workspaceId: targetWorkspaceId,\s*\}/);
});

test("desktop browser service exposes a real mouse endpoint for BrowserView input", async () => {
  const source = await readFile(HTTP_SERVICE_PATH, "utf8");

  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/mouse"\)/);
  assert.match(source, /const expression = optionalExpressionPayload\(payload\.expression\);/);
  assert.match(source, /const action =\s*payload\.action === "double_click" \|\| payload\.action === "hover"/);
  assert.match(source, /await deps\.withTemporarilyRenderedBrowserTab\(\s*activeTab,\s*async \(\) =>\s*deps\.withProgrammaticBrowserInput\(\s*activeTab\.view\.webContents,\s*async \(\) => \{/s);
  assert.match(source, /executeJavaScript\(expression\)/);
  assert.match(source, /activeTab\.view\.webContents\.focus\(\);/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseMove",/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseDown",[\s\S]*button: "left",/);
  assert.match(source, /await activeTab\.view\.webContents\.sendInputEvent\(\{\s*type: "mouseUp",[\s\S]*button: "left",/);
  assert.match(source, /clickCount: 2,/);
  assert.match(source, /\{\s*requireFocusedWindow: true,\s*workspaceId: targetWorkspaceId,\s*\}/);
});

test("desktop browser service exposes real keyboard input for rich editors", async () => {
  const source = await readFile(HTTP_SERVICE_PATH, "utf8");
  const mainSource = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/keyboard"\)/);
  assert.match(source, /await deps\.withTemporarilyRenderedBrowserTab\(\s*activeTab,\s*async \(\) =>\s*deps\.withProgrammaticBrowserInput\(\s*activeTab\.view\.webContents,\s*async \(\) => \{/s);
  assert.match(source, /const index = positiveIntegerPayload\(payload\.index\);/);
  assert.match(source, /const expression = optionalExpressionPayload\(payload\.expression\);/);
  assert.match(source, /resolvedAction = serializeEvalResult\(\s*await activeTab\.view\.webContents\.executeJavaScript\(expression\),/s);
  assert.match(source, /executeJavaScript\(\s*focusIndexedKeyboardTargetExpression\(index\),/s);
  assert.match(source, /await activeTab\.view\.webContents\.insertText\(text\);/);
  assert.match(source, /\{\s*requireFocusedWindow: true,\s*workspaceId: targetWorkspaceId,\s*\}/);
  assert.match(mainSource, /async function clearFocusedBrowserTextInput\(/);
  assert.match(mainSource, /await sendBrowserKeyPress\(webContents, "A", \[selectAllModifier\]\);/);
  assert.match(source, /await deps\.sendBrowserKeyPress\(\s*activeTab\.view\.webContents,\s*"Enter",/s);
});
