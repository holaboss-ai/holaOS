import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("desktop main process installs a minimal macOS app menu for Holaboss", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /const MAC_APP_MENU_PRODUCT_LABEL = "Holaboss";/);
  assert.match(source, /function focusOrCreateMainWindow\(\) \{/);
  assert.match(source, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s*createMainWindow\(\);\s*return;\s*\}/);
  assert.match(source, /if \(mainWindow\.isMinimized\(\)\) \{\s*mainWindow\.restore\(\);\s*\}/);
  assert.match(source, /if \(!mainWindow\.isVisible\(\)\) \{\s*mainWindow\.show\(\);\s*\}/);
  assert.match(source, /mainWindow\.focus\(\);/);
  assert.match(source, /function installMacApplicationMenu\(\) \{/);
  assert.match(source, /if \(process\.platform !== "darwin"\) \{\s*return;\s*\}/);
  assert.match(source, /label: app\.getName\(\),/);
  assert.match(source, /label: `Open \$\{configuredMacAppMenuProductLabel\(\)\}`,/);
  assert.match(source, /click: \(\) => \{\s*focusOrCreateMainWindow\(\);\s*\},/);
  assert.match(source, /label: `Quit \$\{configuredMacAppMenuProductLabel\(\)\}`,\s*role: "quit",/);
  assert.match(source, /label: "Edit",\s*submenu: \[/);
  assert.match(source, /label: "Cut", role: "cut"/);
  assert.match(source, /label: "Copy", role: "copy"/);
  assert.match(source, /label: "Paste", role: "paste"/);
  assert.match(source, /label: "Select All", role: "selectAll"/);
  assert.match(source, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\);/);
  assert.match(source, /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*installMacApplicationMenu\(\);[\s\S]*applyMainShellContentSecurityPolicy\(session\.defaultSession\);/);
});

test("desktop main process installs a hidden Windows app menu so native shortcuts work", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /function installWindowsApplicationMenu\(\) \{/);
  assert.match(source, /if \(process\.platform !== "win32"\) \{\s*return;\s*\}/);
  // Close Tab / Close Window carry the same CmdOrCtrl accelerators as macOS.
  assert.match(
    source,
    /label: "Close Tab",\s*accelerator: "CmdOrCtrl\+W",\s*click: \(\) => \{\s*mainWindow\?\.webContents\.send\("app:closeActiveTab"\);/,
  );
  assert.match(
    source,
    /label: "Close Window",\s*accelerator: "CmdOrCtrl\+Shift\+W",\s*role: "close",/,
  );
  assert.match(source, /role: "togglefullscreen"/);
  // Installed alongside the macOS menu in whenReady (each guards its own OS).
  assert.match(
    source,
    /installMacApplicationMenu\(\);\s*installWindowsApplicationMenu\(\);/,
  );
});
