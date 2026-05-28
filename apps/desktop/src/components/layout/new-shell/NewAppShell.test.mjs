import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NEW_APP_SHELL_PATH = new URL("./NewAppShell.tsx", import.meta.url);

test("experimental shell swaps into onboarding takeover mode for onboarding workspaces", async () => {
  const source = await readFile(NEW_APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /import \{ WorkspaceOnboardingSurface \} from "@\/features\/workspace-onboarding\/WorkspaceOnboardingSurface";/,
  );
  assert.match(
    source,
    /const \{\s*onboardingModeActive,\s*workspaces,\s*hasHydratedWorkspaceList\s*\} =\s*useWorkspaceDesktop\(\);/,
  );
  assert.match(
    source,
    /\{onboardingModeActive \? \(\s*<div className="flex min-w-0 flex-1 flex-col bg-background">\s*<ExperimentalWorkspaceOnboardingTakeover \/>\s*<\/div>\s*\) : \(\s*<>\s*<div[\s\S]*?<TopChrome \/>\s*<Center \/>\s*<\/div>\s*<ChatPanel layout=\{layout\} \/>\s*<\/>\s*\)\}/,
  );
  assert.match(source, /<NewIssueDialog \/>/);
  assert.match(
    source,
    /function ExperimentalWorkspaceOnboardingTakeover\(\) \{[\s\S]*<WorkspaceOnboardingSurface \/>[\s\S]*\}/,
  );
});
