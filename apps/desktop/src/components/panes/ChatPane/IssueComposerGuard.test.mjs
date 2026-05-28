import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANE_PATH = new URL("./index.tsx", import.meta.url);

test("chat pane disables the composer for issue-thread states that should not accept replies", async () => {
  const source = await readFile(CHAT_PANE_PATH, "utf8");

  assert.match(
    source,
    /window\.electronAPI\.workspace\.listIssues\(workspaceId\)/,
  );
  assert.match(
    source,
    /const activeIssue = useMemo\(\(\) => \{/,
  );
  assert.match(
    source,
    /const isReadOnlyInspectionSession =\s*!isViewingBoundMainSession && !isOnboardingVariant && !activeIssue;/,
  );
  assert.match(
    source,
    /activeIssue\.status === "backlog"/,
  );
  assert.match(
    source,
    /"Move this issue to Todo before replying in the issue thread\."/,
  );
  assert.match(
    source,
    /!activeIssue\.assignee_teammate_id/,
  );
  assert.match(
    source,
    /"Assign a teammate before replying in the issue thread\."/,
  );
  assert.match(
    source,
    /isResponding\s*\?\s*"This issue is actively running\. Wait for the current run to finish before replying\."/,
  );
});
