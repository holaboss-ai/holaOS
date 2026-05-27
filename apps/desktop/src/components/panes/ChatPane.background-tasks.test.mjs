import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./ChatPane/index.tsx", import.meta.url);
const BACKGROUND_TASKS_SOURCE_PATH = new URL(
  "./BackgroundTasksPane.tsx",
  import.meta.url,
);

test("chat pane renders background tasks inline and removes the separate quick action", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");
  const backgroundTasksSource = await readFile(
    BACKGROUND_TASKS_SOURCE_PATH,
    "utf8",
  );

  assert.doesNotMatch(source, /onOpenBackgroundTasks\?: \(\) => void;/);
  assert.doesNotMatch(source, /<ChatHeader[\s\S]*onOpenBackgroundTasks=/);
  assert.doesNotMatch(source, /aria-label="Show background tasks"/);
  assert.doesNotMatch(source, /onClick=\{\(\) => onOpenBackgroundTasks\(\)\}/);
  assert.match(
    source,
    /isViewingBoundMainSession \? \(\s*<div className="flex shrink-0 justify-center px-4 pt-2 empty:hidden">[\s\S]*<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}[\s\S]*variant="inline"/,
  );
  assert.match(
    source,
    /<BackgroundTasksPane[\s\S]*onOpenTaskSession=\{handleOpenBackgroundTaskSession\}/,
  );
  assert.match(backgroundTasksSource, /ownerMainSessionId\?: string \| null;/);
  assert.match(
    backgroundTasksSource,
    /ownerMainSessionId = null,[\s\S]*const activeOwnerMainSessionId = ownerMainSessionId\?\.trim\(\) \|\| null;/,
  );
  assert.match(
    backgroundTasksSource,
    /listBackgroundTasks\(\{[\s\S]*workspaceId: activeWorkspaceId,[\s\S]*ownerMainSessionId: activeOwnerMainSessionId,/,
  );
  assert.doesNotMatch(source, /<SubagentSessionsPane[\s\S]*variant="inline"/);
  assert.match(source, /readOnly: true,/);
  assert.match(source, /onOpenSessions\?: \(\) => void;/);
  assert.match(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.doesNotMatch(source, /aria-label="Select agent session"/);
});
