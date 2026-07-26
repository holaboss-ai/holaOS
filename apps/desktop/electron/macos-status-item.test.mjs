import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("desktop main process installs a macOS status item for Holaboss", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /Tray,/);
  assert.match(source, /let statusItemTray: Tray \| null = null;/);
  assert.match(source, /function desktopAppIconPath\(\): string \{/);
  assert.match(source, /function desktopStatusItemIconPath\(\): string \{/);
  assert.match(source, /function installMacStatusItem\(\) \{/);
  assert.match(source, /if \(process\.platform !== "darwin" \|\| statusItemTray\) \{\s*return;\s*\}/);
  assert.match(source, /const icon = nativeImage\.createFromPath\(desktopStatusItemIconPath\(\)\);/);
  assert.match(source, /icon\.setTemplateImage\(true\);/);
  assert.match(source, /statusItemTray = new Tray\(icon\);/);
  assert.match(source, /statusItemTray\.setToolTip\(configuredMacAppMenuProductLabel\(\)\);/);
  assert.match(source, /statusItemTray\.setContextMenu\(\s*Menu\.buildFromTemplate\(\[/);
  assert.match(source, /label: `Open \$\{configuredMacAppMenuProductLabel\(\)\}`,/);
  assert.match(source, /label: `Quit \$\{configuredMacAppMenuProductLabel\(\)\}`,\s*role: "quit",/);
  assert.match(
    source,
    /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*installMacStatusItem\(\);[\s\S]*installMacApplicationMenu\(\);/,
  );
});

test("desktop packaging bundles the macOS status item template assets", async () => {
  const source = await readFile(new URL("../electron-builder.config.cjs", import.meta.url), "utf8");

  assert.match(source, /from: "resources\/holaStatusTemplate\.png"/);
  assert.match(source, /to: "holaStatusTemplate\.png"/);
  assert.match(source, /from: "resources\/holaStatusTemplate@2x\.png"/);
  assert.match(source, /to: "holaStatusTemplate@2x\.png"/);
});
