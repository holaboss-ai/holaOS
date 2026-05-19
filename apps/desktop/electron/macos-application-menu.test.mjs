import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("desktop main process installs a minimal macOS app menu for holaOS", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /const MAC_APP_MENU_PRODUCT_LABEL = "holaOS";/);
  assert.match(source, /function focusOrCreateMainWindow\(\) \{/);
  assert.match(source, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s*createMainWindow\(\);\s*return;\s*\}/);
  assert.match(source, /if \(mainWindow\.isMinimized\(\)\) \{\s*mainWindow\.restore\(\);\s*\}/);
  assert.match(source, /if \(!mainWindow\.isVisible\(\)\) \{\s*mainWindow\.show\(\);\s*\}/);
  assert.match(source, /mainWindow\.focus\(\);/);
  assert.match(source, /function installMacApplicationMenu\(\) \{/);
  assert.match(source, /if \(process\.platform !== "darwin"\) \{\s*return;\s*\}/);
  assert.match(source, /label: app\.getName\(\),/);
  assert.match(source, /label: `Open \$\{MAC_APP_MENU_PRODUCT_LABEL\}`,/);
  assert.match(source, /click: \(\) => \{\s*focusOrCreateMainWindow\(\);\s*\},/);
  assert.match(source, /label: `Quit \$\{MAC_APP_MENU_PRODUCT_LABEL\}`,\s*role: "quit",/);
  assert.match(source, /label: "Edit",\s*submenu: \[/);
  assert.match(source, /label: "Cut", role: "cut"/);
  assert.match(source, /label: "Copy", role: "copy"/);
  assert.match(source, /label: "Paste", role: "paste"/);
  assert.match(source, /label: "Select All", role: "selectAll"/);
  assert.match(source, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\);/);
  assert.match(source, /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*installMacApplicationMenu\(\);[\s\S]*applyMainShellContentSecurityPolicy\(session\.defaultSession\);/);
});
