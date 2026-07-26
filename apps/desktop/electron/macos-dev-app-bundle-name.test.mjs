import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PATCH_SCRIPT_PATH = new URL("../scripts/patch-electron-plist.mjs", import.meta.url);

test("desktop macOS dev Electron bundle is rebranded to Holaboss", async () => {
  const source = await readFile(PATCH_SCRIPT_PATH, "utf8");

  assert.match(source, /const APP_NAME = "Holaboss";/);
  assert.match(source, /run\(`Set :CFBundleName \$\{APP_NAME\}`\);/);
  assert.match(source, /run\(`Set :CFBundleDisplayName \$\{APP_NAME\}`\);/);
  assert.match(source, /let urlSchemeAlreadyPatched = false;/);
  assert.match(source, /if \(!urlSchemeAlreadyPatched\) \{/);
  assert.match(
    source,
    /run\(`Set :CFBundleURLTypes:0:CFBundleURLName 'Holaboss Auth Callback'`\);/,
  );
});
