import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANEL_PATH = new URL("./shell/ChatPanel.tsx", import.meta.url);

test("the shell routes cronjob background tasks into automations", async () => {
  const source = await readFile(CHAT_PANEL_PATH, "utf8");

  assert.match(
    source,
    /const handleOpenBackgroundTask = useCallback\(\s*\(task: BackgroundTaskRecordPayload\) => \{[\s\S]*if \(workspaceId && \(sourceType === "cronjob" \|\| cronjobId\)\) \{[\s\S]*workspaceSurfaceTab\("automations", workspaceId\)[\s\S]*return true;[\s\S]*\},[\s\S]*\);/,
  );
  assert.match(source, /<ChatPane[\s\S]*onOpenBackgroundTask=\{handleOpenBackgroundTask\}/);
});
