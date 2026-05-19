import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./ChatPane.tsx", import.meta.url);

test("chat pane renders background tasks inline and removes the separate quick action", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.doesNotMatch(source, /onOpenBackgroundTasks\?: \(\) => void;/);
  assert.doesNotMatch(source, /<ChatHeader[\s\S]*onOpenBackgroundTasks=/);
  assert.doesNotMatch(source, /aria-label="Show background tasks"/);
  assert.doesNotMatch(source, /onClick=\{\(\) => onOpenBackgroundTasks\(\)\}/);
  assert.match(
    source,
    /!isOnboardingVariant && !isReadOnlyInspectionSession \? \(\s*<div className="pointer-events-none absolute inset-x-0 top-0 z-20">[\s\S]*<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}[\s\S]*variant="inline"/,
  );
  assert.match(
    source,
    /<BackgroundTasksPane[\s\S]*onOpenTaskSession=\{handleOpenBackgroundTaskSession\}/,
  );
  assert.match(source, /<div className="pointer-events-auto">/);
  assert.doesNotMatch(source, /<SubagentSessionsPane[\s\S]*variant="inline"/);
  assert.match(source, /readOnly: true,/);
  assert.match(source, /onOpenSessions\?: \(\) => void;/);
  assert.match(source, /aria-label="Show sessions"/);
  assert.doesNotMatch(source, /aria-label="Select agent session"/);
});
