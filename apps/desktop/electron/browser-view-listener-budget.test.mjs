import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop main process budgets BrowserView closed listeners from actual main window listener growth", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const MAIN_WINDOW_MIN_LISTENER_BUDGET = 32;/);
  assert.match(
    source,
    /function reserveMainWindowClosedListenerBudget\(\s*additionalClosedListeners = 0,\s*\)/,
  );
  assert.match(
    source,
    /mainWindow\.listenerCount\("closed"\)\s*\+\s*additionalClosedListeners\s*\+\s*MAIN_WINDOW_CLOSED_LISTENER_BUFFER/,
  );
  assert.doesNotMatch(source, /tabCount \+ MAIN_WINDOW_CLOSED_LISTENER_BUFFER/);
});

test("desktop main process avoids reattaching the same BrowserView on browser tab and app surface updates", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /let attachedBrowserTabView: BrowserView \| null = null;/);
  assert.match(source, /let attachedAppSurfaceView: BrowserView \| null = null;/);
  assert.match(
    source,
    /if \(attachedBrowserTabView !== activeTab\.view\) \{\s*reserveMainWindowClosedListenerBudget\(1\);\s*mainWindow\.setBrowserView\(activeTab\.view\);\s*attachedBrowserTabView = activeTab\.view;\s*\}/,
  );
  assert.match(
    source,
    /if \(attachedAppSurfaceView !== view\) \{\s*if \(attachedAppSurfaceView\) \{\s*mainWindow\.removeBrowserView\(attachedAppSurfaceView\);\s*\}\s*reserveMainWindowClosedListenerBudget\(1\);\s*mainWindow\.addBrowserView\(view\);\s*attachedAppSurfaceView = view;\s*\}/,
  );
  assert.match(
    source,
    /if \(!workspace \|\| !workspace\.activeTabId \|\| !hasVisibleBrowserBounds\(\)\) \{\s*mainWindow\?\.setBrowserView\(null\);\s*attachedBrowserTabView = null;\s*return;\s*\}/,
  );
});
