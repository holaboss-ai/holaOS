import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const AUTH_POPUP_PRELOAD_PATH = new URL("./authPopupPreload.ts", import.meta.url);
const MAIN_PATH = new URL("./main.ts", import.meta.url);
const APP_SHELL_PATH = new URL("../src/components/layout/AppShell.tsx", import.meta.url);

test("settings pane routing keeps the full settings section list available across Electron bridges", async () => {
  const [preloadSource, authPopupPreloadSource, mainSource, appShellSource] = await Promise.all([
    readFile(PRELOAD_PATH, "utf8"),
    readFile(AUTH_POPUP_PRELOAD_PATH, "utf8"),
    readFile(MAIN_PATH, "utf8"),
    readFile(APP_SHELL_PATH, "utf8")
  ]);

  assert.match(preloadSource, /type UiSettingsPaneSection = "account" \| "billing" \| "providers" \| "integrations" \| "submissions" \| "settings" \| "automations" \| "about";/);
  assert.match(authPopupPreloadSource, /type UiSettingsPaneSection = "account" \| "billing" \| "providers" \| "integrations" \| "submissions" \| "settings" \| "automations" \| "about";/);
  assert.match(mainSource, /type UiSettingsPaneSection =[\s\S]*"account"[\s\S]*"billing"[\s\S]*"providers"[\s\S]*"integrations"[\s\S]*"submissions"[\s\S]*"settings"[\s\S]*"automations"[\s\S]*"about";/);
  assert.match(appShellSource, /return \([\s\S]*value === "account"[\s\S]*value === "billing"[\s\S]*value === "providers"[\s\S]*value === "integrations"[\s\S]*value === "submissions"[\s\S]*value === "settings"[\s\S]*value === "automations"[\s\S]*value === "about"[\s\S]*\);/);
});
