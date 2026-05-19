import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);

test("app shell no longer exposes a dedicated background tasks pane", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.doesNotMatch(source, /\| \{ type: "backgroundTasks" \}/);
  assert.doesNotMatch(source, /const handleOpenBackgroundTasksPane = useCallback\(\(\) => \{/);
  assert.doesNotMatch(source, /setAgentView\(\{ type: "backgroundTasks" \}\);/);
  assert.doesNotMatch(source, /if \(agentView\.type === "backgroundTasks"\) \{/);
  assert.doesNotMatch(source, /<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}/);
  assert.doesNotMatch(source, /<ChatPane[\s\S]*onOpenBackgroundTasks=/);
  assert.match(source, /<ChatPane[\s\S]*onOpenInbox=\{handleOpenInboxPane\}/);
});
