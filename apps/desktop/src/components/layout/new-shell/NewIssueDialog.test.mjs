import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NEW_APP_SHELL_PATH = new URL("./NewAppShell.tsx", import.meta.url);
const NEW_ISSUE_DIALOG_PATH = new URL("./NewIssueDialog.tsx", import.meta.url);
const SEARCH_DIALOG_PATH = new URL("./SearchDialog.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const UI_STATE_PATH = new URL("./state/ui.ts", import.meta.url);

test("new shell issue creation dialog stages attachments, creates issues, and opens the issue session", async () => {
  const [
    newAppShellSource,
    newIssueDialogSource,
    searchDialogSource,
    sidebarSource,
    uiStateSource,
  ] = await Promise.all([
    readFile(NEW_APP_SHELL_PATH, "utf8"),
    readFile(NEW_ISSUE_DIALOG_PATH, "utf8"),
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
    /setSessionOpenRequest\(\{\s*sessionId:\s*created\.session\?\.session_id \|\| created\.issue\.session_id,/,
  );
  assert.match(newIssueDialogSource, /status === "blocked" && !blockerReason\.trim\(\)/);
  assert.match(newIssueDialogSource, /priority: priority \|\| null,/);
  assert.match(
    newIssueDialogSource,
    /assignee_teammate_id: assigneeTeammateId \|\| null,/,
  );

  assert.match(searchDialogSource, /label="New issue"/);
  assert.match(searchDialogSource, /setNewIssueOpen\(true\)/);
  assert.match(sidebarSource, /function SidebarNewIssueAction\(\) \{/);
  assert.match(sidebarSource, /setNewIssueOpen\(true\)/);
});
