import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop main process uses holaOS as the packaged app name", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /electronApp\.setName\("holaOS"\);/);
  assert.match(source, /const APP_DISPLAY_NAME = "holaOS";/);
  assert.match(source, /const MAC_APP_MENU_PRODUCT_LABEL = "holaOS";/);
  assert.match(
    source,
    /app\.setName\(\s*process\.platform === "darwin" && isDev\s*\?\s*MAC_APP_MENU_PRODUCT_LABEL\s*:\s*APP_DISPLAY_NAME,\s*\)/,
  );
});

test("desktop main process opens the main window maximized by default on Windows", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /win\.once\("ready-to-show", \(\) => \{[\s\S]*if \(process\.platform === "win32"\) \{[\s\S]*win\.maximize\(\);[\s\S]*win\.show\(\);[\s\S]*return;[\s\S]*\}/,
  );
});
