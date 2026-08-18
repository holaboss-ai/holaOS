import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANE_PATH = new URL("./index.tsx", import.meta.url);
const ISSUE_THREAD_CONTROLS_PATH = new URL(
  "./IssueThreadControls.tsx",
  import.meta.url,
);

test("chat pane treats issue sessions as interactive and renders issue thread controls", async () => {
  const [chatPaneSource, issueThreadControlsSource] = await Promise.all([
    readFile(CHAT_PANE_PATH, "utf8"),
    readFile(ISSUE_THREAD_CONTROLS_PATH, "utf8"),
  ]);

  assert.match(chatPaneSource, /import \{ IssueThreadControls \} from "\.\/IssueThreadControls";/);
  assert.match(
    chatPaneSource,
    /const isReadOnlyInspectionSession =\s*!isViewingBoundMainSession &&\s*!isOnboardingVariant &&\s*activeSessionReadOnly &&\s*!activeIssue;/,
  );
  assert.match(
    chatPaneSource,
    /<IssueThreadControls[\s\S]*issue=\{activeIssue\}[\s\S]*onStopIssueRun=\{handleStopActiveIssueRun\}/,
  );
  assert.match(
    chatPaneSource,
    /window\.electronAPI\.workspace\.updateIssue\(/,
  );
  assert.match(
    chatPaneSource,
    /window\.electronAPI\.workspace\.stopIssueRun\(/,
  );
  assert.match(
    chatPaneSource,
    /window\.prompt\(\s*"Why is this issue blocked\?"/,
  );

  assert.match(
    issueThreadControlsSource,
    /export function IssueThreadControls/,
  );
  assert.doesNotMatch(
    issueThreadControlsSource,
    /\{ value: "backlog", label: "Backlog" \},/,
  );
  assert.match(issueThreadControlsSource, /Backlog \(hidden\)/);
  assert.match(
    issueThreadControlsSource,
    /Issue fields are locked while this run is active\./,
  );
  assert.match(
    issueThreadControlsSource,
    /Edit details/,
  );
  assert.match(
    issueThreadControlsSource,
    /Waiting issues need a blocker reason\./,
  );
});
