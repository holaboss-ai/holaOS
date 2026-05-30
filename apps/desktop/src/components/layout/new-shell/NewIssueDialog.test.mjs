import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NEW_APP_SHELL_PATH = new URL("./NewAppShell.tsx", import.meta.url);
const NEW_ISSUE_DIALOG_PATH = new URL("./NewIssueDialog.tsx", import.meta.url);
const BOARD_PANE_PATH = new URL("./IssuesBoardPane.tsx", import.meta.url);
const SEARCH_DIALOG_PATH = new URL("./SearchDialog.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const UI_STATE_PATH = new URL("./state/ui.ts", import.meta.url);

test("new shell issue creation dialog stages attachments, creates issues, and opens the issue detail tab", async () => {
  const [
    newAppShellSource,
    newIssueDialogSource,
    boardPaneSource,
    searchDialogSource,
    sidebarSource,
    uiStateSource,
  ] = await Promise.all([
    readFile(NEW_APP_SHELL_PATH, "utf8"),
    readFile(NEW_ISSUE_DIALOG_PATH, "utf8"),
    readFile(BOARD_PANE_PATH, "utf8"),
    readFile(SEARCH_DIALOG_PATH, "utf8"),
    readFile(SIDEBAR_PATH, "utf8"),
    readFile(UI_STATE_PATH, "utf8"),
  ]);

  assert.match(uiStateSource, /export const newIssueOpenAtom = atom\(false\);/);
  assert.match(newAppShellSource, /import \{ NewIssueDialog \} from "\.\/NewIssueDialog";/);
  assert.match(newAppShellSource, /<NewIssueDialog \/>/);

  assert.match(
    newIssueDialogSource,
    /window\.electronAPI\.workspace[\s\S]*?\.listTeammates\(selectedWorkspaceId\)/,
  );
  assert.match(
    newIssueDialogSource,
    /window\.electronAPI\.workspace\.stageSessionAttachments\(\{/,
  );
  assert.match(
    newIssueDialogSource,
    /window\.electronAPI\.workspace\.createIssue\(\{/,
  );
  assert.match(
    newIssueDialogSource,
    /const openIssueDetailTab = useOpenIssueDetailTab\(\);/,
  );
  assert.match(
    newIssueDialogSource,
    /void openIssueDetailTab\(\{\s*workspaceId: selectedWorkspaceId,\s*issueId: created\.issue\.issue_id,/,
  );
  assert.match(newIssueDialogSource, /status === "blocked" && !blockerReason\.trim\(\)/);
  assert.doesNotMatch(
    newIssueDialogSource,
    /\{ value: "backlog", label: "Backlog" \},/,
  );
  assert.match(newIssueDialogSource, /priority: priority \|\| null,/);
  assert.match(
    newIssueDialogSource,
    /assignee_teammate_id: assigneeTeammateId \|\| null,/,
  );

  assert.doesNotMatch(boardPaneSource, />\s*All\s*</);
  assert.doesNotMatch(boardPaneSource, />\s*Members\s*</);
  assert.doesNotMatch(boardPaneSource, />\s*Agents\s*</);
  assert.doesNotMatch(boardPaneSource, /setNewIssueOpen/);
  assert.match(sidebarSource, /const setComposerPrefill = useSetAtom\(chatComposerPrefillAtom\);/);
  assert.match(sidebarSource, /const handleNewIssue = useCallback\(\(\) => \{/);
  assert.match(sidebarSource, /text: "New issue: ",/);
  assert.match(sidebarSource, /sessionMode: "preserve",/);
  assert.match(sidebarSource, /onClick=\{handleNewIssue\}/);
  assert.match(sidebarSource, />\s*New issue\s*</);
  assert.doesNotMatch(searchDialogSource, /label="New issue"/);
  assert.doesNotMatch(sidebarSource, /function SidebarNewIssueAction\(\) \{/);
});
