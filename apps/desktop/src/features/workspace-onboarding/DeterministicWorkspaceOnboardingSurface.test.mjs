import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DETERMINISTIC_WORKSPACE_ONBOARDING_SURFACE_PATH = new URL(
  "./DeterministicWorkspaceOnboardingSurface.tsx",
  import.meta.url,
);

test("deterministic workspace onboarding does not enqueue a starter prompt", async () => {
  const source = await readFile(
    DETERMINISTIC_WORKSPACE_ONBOARDING_SURFACE_PATH,
    "utf8",
  );

  assert.doesNotMatch(source, /FIRST_RUN_STARTERS/);
  assert.doesNotMatch(source, /pickStarterSlug/);
  assert.doesNotMatch(source, /ensureMainSession\(/);
  assert.doesNotMatch(source, /queueSessionInput\(/);
  assert.match(
    source,
    /async function handleContinue\(\) \{[\s\S]*await continueDeterministicOnboarding\(\);[\s\S]*\}/,
  );
  assert.match(source, /deterministic_context_fetching/);
  assert.match(source, />\s*Fetching your context\s*</);
  assert.match(source, /listIntegrationContextFetchStatuses/);
  assert.match(source, /Overall progress/);
  assert.match(source, /chunks complete/);
  assert.match(
    source,
    /You can enter the workspace while that keeps running in the background\./,
  );
  assert.match(source, /"Enter workspace now"/);
});
