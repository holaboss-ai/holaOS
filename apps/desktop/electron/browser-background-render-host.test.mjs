import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TAB_STATE_PATH = new URL("./browser-pane/tab-state.ts", import.meta.url);
const HTTP_SERVICE_PATH = new URL("./browser-pane/http-service.ts", import.meta.url);

test("browser tab state can temporarily host a background BrowserView in a hidden window", async () => {
  const source = await readFile(TAB_STATE_PATH, "utf8");

  assert.match(source, /async function withTemporarilyRenderedBrowserTab<T>\(/);
  assert.match(source, /if \(\s*!options\.requireFocusedWindow &&\s*attachedView === tab\.view &&\s*hasVisibleBounds\(\)\s*\) \{\s*return callback\(\);\s*\}/s);
  assert.match(source, /const host = new BrowserWindow\(\{\s*show: options\.requireFocusedWindow === true,\s*paintWhenInitiallyHidden: true,/s);
  assert.match(source, /async function withBrowserTabHostedInWindow<T>\(/);
  assert.match(source, /host\.setBrowserView\(tab\.view\);/);
  assert.match(source, /tab\.view\.setBounds\(bounds\);/);
  assert.match(source, /if \(options\.requireFocusedWindow === true\) \{\s*host\.show\(\);\s*host\.focus\(\);\s*await waitForBrowserWindowFocus\(host\);\s*tab\.view\.webContents\.focus\(\);\s*\}/s);
  assert.match(source, /async function waitForRenderedBrowserFrame\(\s*tab: BrowserTabRecord,\s*\): Promise<boolean> \{/s);
  assert.match(source, /await waitForRenderedBrowserViewport\(tab\);/);
  assert.match(source, /webContents\.beginFrameSubscription\(\(\) => \{/);
  assert.match(source, /webContents\.invalidate\(\);/);
  assert.match(source, /webContents\.endFrameSubscription\(\);/);
  assert.match(source, /if \(options\.waitForRenderedFrame === true\) \{\s*await waitForRenderedBrowserFrame\(tab\);\s*\}/s);
  assert.match(source, /host\.setBrowserView\(null\);/);
  assert.match(source, /host\.destroy\(\);/);
});

test("browser tab state reuses invisible agent input hosts behind a global queue", async () => {
  const source = await readFile(TAB_STATE_PATH, "utf8");

  assert.match(source, /const sharedAgentInputHosts = new Map<string, SharedAgentInputHostState>\(\);/);
  assert.match(source, /let focusedAgentInputQueue = Promise\.resolve\(\);/);
  assert.match(source, /function invisibleInputHostWindowBounds\(/);
  assert.match(source, /transparent: true,/);
  assert.match(source, /opacity: BACKGROUND_INPUT_HOST_OPACITY,/);
  assert.match(source, /host\.setIgnoreMouseEvents\(true\);/);
  assert.match(source, /async function withQueuedAgentInputHost<T>\(/);
  assert.match(source, /const previousQueue = focusedAgentInputQueue;/);
  assert.match(source, /scheduleSharedAgentInputHostDestroy\(workspaceId, hostState\);/);
});

test("desktop browser http service renders background tabs before evaluate and screenshot", async () => {
  const source = await readFile(HTTP_SERVICE_PATH, "utf8");

  assert.match(source, /withTemporarilyRenderedBrowserTab: <T>\(\s*tab: HttpServiceTabRecord,\s*callback: \(\) => Promise<T>,\s*options\?: \{\s*requireFocusedWindow\?: boolean;\s*workspaceId\?: string \| null;\s*waitForRenderedFrame\?: boolean;\s*\},\s*\) => Promise<T>;/s);
  assert.match(source, /const result = await deps\.withTemporarilyRenderedBrowserTab\(\s*activeTab,\s*async \(\) =>\s*activeTab\.view\.webContents\.executeJavaScript\(expression\),/s);
  assert.match(source, /async function captureBrowserScreenshotWithRetries\(/);
  assert.match(source, /message\.includes\("UnknownVizError"\)/);
  assert.match(source, /await tab\.view\.webContents\.executeJavaScript\("document\.readyState", true\);/);
  assert.match(source, /const image = await deps\.withTemporarilyRenderedBrowserTab\(/);
  assert.match(source, /captureBrowserScreenshotWithRetries\(activeTab\)/);
  assert.match(source, /waitForRenderedFrame: true/);
});

test("desktop browser http service uses a focused temporary host for background input routes", async () => {
  const source = await readFile(HTTP_SERVICE_PATH, "utf8");

  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/context-click"\)/);
  assert.match(source, /await deps\.withTemporarilyRenderedBrowserTab\(\s*activeTab,\s*async \(\) =>\s*deps\.withProgrammaticBrowserInput\(/s);
  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/mouse"\)/);
  assert.match(source, /if \(method === "POST" && pathname === "\/api\/v1\/browser\/keyboard"\)/);
  assert.match(source, /\{\s*requireFocusedWindow: true,\s*workspaceId: targetWorkspaceId,\s*\}/);
});
