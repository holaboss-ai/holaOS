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

test("experimental settings expose the workspace onboarding mode preference", async () => {
  const source = await readFile(SETTINGS_SCREEN_ROOT_PATH, "utf8");

  assert.match(
    source,
    /loadWorkspaceOnboardingPreference,\s*persistWorkspaceOnboardingPreference,/,
  );
  assert.match(
    source,
    /<SettingsMenuSelectRow[\s\S]*label="Workspace onboarding mode"/,
  );
  assert.match(
    source,
    /persistWorkspaceOnboardingPreference\(nextValue\)/,
  );
  assert.match(source, /value: "deterministic"/);
  assert.match(source, /value: "agentic"/);
});
