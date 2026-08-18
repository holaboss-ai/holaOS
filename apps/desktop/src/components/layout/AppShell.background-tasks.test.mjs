import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANEL_PATH = new URL("./shell/ChatPanel.tsx", import.meta.url);

test("the shell no longer exposes a dedicated background tasks pane", async () => {
  const source = await readFile(CHAT_PANEL_PATH, "utf8");

  assert.doesNotMatch(source, /\| \{ type: "backgroundTasks" \}/);
  assert.doesNotMatch(source, /const handleOpenBackgroundTasksPane = useCallback\(\(\) => \{/);
  assert.doesNotMatch(source, /if \(agentView\.type === "backgroundTasks"\) \{/);
  assert.doesNotMatch(source, /<BackgroundTasksPane/);
  assert.doesNotMatch(source, /<ChatPane[\s\S]*onOpenBackgroundTasks=/);
  assert.match(source, /<ChatPane\b/);
});
