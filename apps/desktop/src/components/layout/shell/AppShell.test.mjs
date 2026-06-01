import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);

test("AppShell swaps into onboarding takeover mode for onboarding workspaces", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const desktopPlatform = window\.electronAPI\?\.platform \?\? null;/,
  );
  assert.match(source, /const isWindowsTitleBar = desktopPlatform === "win32";/);
  assert.match(
    source,
    /import \{ WorkspaceOnboardingSurface \} from "@\/features\/workspace-onboarding\/WorkspaceOnboardingSurface";/,
  );
  assert.match(
    source,
    /const \{\s*onboardingModeActive,\s*workspaces,\s*hasHydratedWorkspaceList\s*\} =\s*useWorkspaceDesktop\(\);/,
  );
  // The shell now branches three ways — onboarding takeover, control-center
  // takeover, default chrome — so the old single-regex check is too brittle.
  // Keep separate checks for each branch's anchor element.
  assert.match(source, /onboardingModeActive \? \(/);
  assert.match(source, /<ExperimentalWorkspaceOnboardingTakeover \/>/);
  assert.match(source, /<TopChrome \/>/);
  assert.match(source, /<Center \/>/);
  assert.match(source, /<ChatPanel layout=\{layout\} \/>/);
  assert.match(source, /\{isWindowsTitleBar \? <WindowsTitlebarControls \/> : null\}/);
  assert.match(source, /<NewIssueDialog \/>/);
  assert.match(source, /function WindowsTitlebarControls\(\) \{/);
  assert.match(source, /window\.electronAPI\.ui\.getWindowState\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.onWindowStateChange/);
  assert.match(source, /window\.electronAPI\.ui\.minimizeWindow\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.toggleWindowSize\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.closeWindow\(\)/);
  assert.match(source, /className="window-drag absolute top-0 right-0 z-40 flex h-10 items-center pr-2 pl-6"/);
  assert.match(source, /aria-label="Minimize window"/);
  assert.match(source, /"Restore window"/);
  assert.match(source, /"Maximize window"/);
  assert.match(source, /aria-label="Close window"/);
  assert.match(
    source,
    /function ExperimentalWorkspaceOnboardingTakeover\(\) \{[\s\S]*<WorkspaceOnboardingSurface \/>[\s\S]*\}/,
  );
});
