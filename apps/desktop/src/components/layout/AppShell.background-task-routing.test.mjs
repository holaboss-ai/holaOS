import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);

test("legacy app shell routes cronjob background tasks into automations", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const handleOpenBackgroundTask = useCallback\(\s*\(task: BackgroundTaskRecordPayload\) => \{[\s\S]*sourceType !== "cronjob" && !cronjobId[\s\S]*return false;[\s\S]*setAgentView\(\{ type: "automations" \}\);[\s\S]*return true;[\s\S]*\},[\s\S]*\);/,
  );
  assert.match(source, /<ChatPane[\s\S]*onOpenBackgroundTask=\{handleOpenBackgroundTask\}/);
});
