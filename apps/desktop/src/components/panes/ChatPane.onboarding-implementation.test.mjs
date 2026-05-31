import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./ChatPane/index.tsx", import.meta.url);

test("onboarding implementing mode renders live delegated-task pills and opens issue detail in place", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /const ONBOARDING_IMPLEMENTATION_TASK_STATUSES = \[\s*"queued",\s*"running",\s*"waiting_on_user",\s*\] as const;/,
  );
  assert.match(
    source,
    /const onboardingImplementationMode =[\s\S]*selectedWorkspace\?\.onboarding_state[\s\S]*"implementing";/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.listBackgroundTasks\(\{\s*workspaceId,\s*ownerMainSessionId: controllerSessionId,\s*statuses: \[\.\.\.ONBOARDING_IMPLEMENTATION_TASK_STATUSES\],\s*limit: 50,\s*\}\)/,
  );
  assert.match(
    source,
    /const onboardingImplementationTaskStrip = onboardingImplementationTaskStripVisible \? \([\s\S]*Implementing approved plan[\s\S]*<BackgroundTaskReferenceCards[\s\S]*references=\{onboardingImplementationTaskReferences\}[\s\S]*onOpenReference=\{handleOpenBackgroundTaskReference\}/,
  );
  assert.match(
    source,
    /if \(onboardingImplementationMode\) \{[\s\S]*setOnboardingIssueDetailTarget\(\{\s*workspaceId,\s*issueId,\s*title: reference\.title\?\.trim\(\) \|\| null,\s*\}\);[\s\S]*return;/,
  );
  assert.match(
    source,
    /onboardingIssueDetailTarget \? \([\s\S]*<IssueDetailPane[\s\S]*workspaceId=\{onboardingIssueDetailTarget\.workspaceId\}[\s\S]*issueId=\{onboardingIssueDetailTarget\.issueId\}[\s\S]*onBack=\{\(\) => setOnboardingIssueDetailTarget\(null\)\}[\s\S]*backLabel="Back to onboarding"/,
  );
});
