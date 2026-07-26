import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANEL_PATH = new URL("./ChatPanel.tsx", import.meta.url);

test("new shell routes background tasks to issue detail tabs", async () => {
  const source = await readFile(CHAT_PANEL_PATH, "utf8");

  assert.match(source, /import \{ useOpenIssueDetailTab \} from "\.\/useOpenIssueDetailTab";/);
  assert.match(
    source,
    /const handleOpenBackgroundTask = useCallback\(\s*\(task: BackgroundTaskRecordPayload\) => \{[\s\S]*sourceType === "issue" \|\| sourceType === "delegate_task"[\s\S]*openIssueDetailTab\(\{[\s\S]*issueId: sourceId,[\s\S]*title: task\.title,[\s\S]*\}\);[\s\S]*if \(workspaceId && sourceType === "cronjob" && issueId\) \{[\s\S]*openIssueDetailTab\(\{[\s\S]*issueId,[\s\S]*title: task\.title,[\s\S]*\}\);[\s\S]*return true;[\s\S]*\}[\s\S]*return false;[\s\S]*\},[\s\S]*\);/,
  );
  assert.match(source, /<ChatPane[\s\S]*onOpenBackgroundTask=\{handleOpenBackgroundTask\}/);
  // The legacy cronjob branch (no resolved issue) now opens the
  // Automations surface rather than the Workflows tab — that's where
  // the user actually wants to see the schedule that owns the run.
  assert.match(source, /workspaceSurfaceTab\("automations", workspaceId\)/);
  assert.doesNotMatch(source, /workspaceSurfaceTab\("workflows", workspaceId\)/);
});
