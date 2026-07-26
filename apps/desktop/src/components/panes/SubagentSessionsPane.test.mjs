import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./SubagentSessionsPane.tsx", import.meta.url);

test("sessions pane keeps the inline session summary but limits the full view to scheduled automation runs", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /const cronjobSessions = useMemo\([\s\S]*sessions\.filter\([\s\S]*inspectableRunSessionCategory\(session\) === "cronjob"/,
  );
  assert.match(
    source,
    /<FullSessionsView[\s\S]*sessions=\{cronjobSessions\}[\s\S]*onOpenSession=\{onOpenSession\}/,
  );
  assert.match(source, /placeholder="Search scheduled runs…"/);
  assert.match(source, /aria-label="Search scheduled runs"/);
  assert.match(source, /\?\s*"No scheduled automation runs yet\."/);
  assert.match(source, /sourceType === "workflow" && triggerKind === "cron"/);
  assert.doesNotMatch(source, /\["subagent", "Subagents"\]/);
  assert.doesNotMatch(source, /\["all", "All"\]/);
});
