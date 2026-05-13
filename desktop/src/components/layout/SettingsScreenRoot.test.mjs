import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SETTINGS_SCREEN_ROOT_PATH = new URL("./SettingsScreenRoot.tsx", import.meta.url);

test("settings screen observes app updates without starting a new check", async () => {
  const source = await readFile(SETTINGS_SCREEN_ROOT_PATH, "utf8");

  assert.match(source, /window\.electronAPI\.appUpdate\.getStatus\(\)/);
  assert.match(source, /window\.electronAPI\.appUpdate\.onStateChange/);
  assert.doesNotMatch(source, /window\.electronAPI\.appUpdate\.checkNow\(\)/);
});
