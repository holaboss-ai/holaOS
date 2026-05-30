import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const UI_STATE_PATH = new URL("./state/ui.ts", import.meta.url);
const CHAT_PANEL_PATH = new URL("./ChatPanel.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const USE_ISSUES_PATH = new URL("./useIssues.ts", import.meta.url);
const OPEN_ISSUE_TAB_PATH = new URL("./useOpenIssueDetailTab.ts", import.meta.url);

test("new shell issues sidebar opens issue detail tabs and keeps inbox empty", async () => {
  const [uiStateSource, chatPanelSource, sidebarSource, useIssuesSource, openIssueTabSource] =
    await Promise.all([
      readFile(UI_STATE_PATH, "utf8"),
      readFile(CHAT_PANEL_PATH, "utf8"),
      readFile(SIDEBAR_PATH, "utf8"),
      readFile(USE_ISSUES_PATH, "utf8"),
      readFile(OPEN_ISSUE_TAB_PATH, "utf8"),
    ]);

  assert.match(uiStateSource, /export type SidebarSection =[\s\S]*"issues"/);
  assert.match(uiStateSource, /export const chatSessionOpenRequestAtom = atom<ChatSessionOpenRequest \| null>\(/);
  assert.match(uiStateSource, /sessionMode\?: "preserve" \| "draft";/);

  assert.match(chatPanelSource, /const \[sessionOpenRequest, setSessionOpenRequest\] = useAtom\(\s*chatSessionOpenRequestAtom,/);
  assert.match(chatPanelSource, /onSessionOpenRequestConsumed=\{handleSessionOpenRequestConsumed\}/);
  assert.match(chatPanelSource, /setSessionOpenRequest\(\(current\) =>\s*current\?\.requestKey === requestKey \? null : current,\s*\)/);
  assert.match(
    chatPanelSource,
    /if \(\(composerPrefill\.sessionMode \?\? "preserve"\) === "draft"\) \{/,
  );

  assert.match(openIssueTabSource, /export function useOpenIssueDetailTab\(\)/);
  assert.match(openIssueTabSource, /issueDetailTab\(\{/);
  assert.doesNotMatch(openIssueTabSource, /ensureMainSession/);
  assert.doesNotMatch(openIssueTabSource, /chatSessionOpenRequestAtom/);
  assert.doesNotMatch(openIssueTabSource, /chatPanelViewAtom/);

  assert.match(useIssuesSource, /window\.electronAPI\.workspace\.listIssues\(workspaceId\)/);
  assert.match(useIssuesSource, /window\.electronAPI\.workspace\.listTeammates\(workspaceId\)/);

  assert.match(sidebarSource, /section === "issues" \? <SidebarIssuesSection \/> : null/);
  assert.match(sidebarSource, /\{ key: "issues", label: "Agent Team", icon: <Bot \/> \}/);
  assert.match(sidebarSource, /const MAC_WORKSPACE_POPOVER_LEFT_INSET = 72;/);
  assert.match(sidebarSource, /const isMacDesktop = window\.electronAPI\?\.platform === "darwin";/);
  assert.match(
    sidebarSource,
    /const workspacePopoverAlignOffset = isMacDesktop\s*\?\s*-MAC_WORKSPACE_POPOVER_LEFT_INSET\s*:\s*0;/,
  );
  assert.match(
    sidebarSource,
    /className=\{cn\(\s*"window-drag flex h-10 shrink-0 items-center pr-2",\s*isMacDesktop \? "pl-20" : "pl-2",\s*\)\}/,
  );
  assert.match(sidebarSource, /alignOffset=\{workspacePopoverAlignOffset\}/);
  assert.match(sidebarSource, /function SidebarIssuesSection\(\) \{/);
  assert.match(sidebarSource, />\s*New issue\s*</);
  assert.match(sidebarSource, />\s*Dashboard\s*</);
  assert.match(sidebarSource, />\s*Issues\s*</);
  assert.match(sidebarSource, />\s*Teammates\s*</);
  assert.match(sidebarSource, /const setComposerPrefill = useSetAtom\(chatComposerPrefillAtom\);/);
  assert.match(sidebarSource, /const setFocusMode = useSetAtom\(focusModeAtom\);/);
  assert.match(sidebarSource, /const handleNewIssue = useCallback\(\(\) => \{/);
  assert.match(sidebarSource, /text: "New issue: ",/);
  assert.match(sidebarSource, /sessionMode: "preserve",/);
  assert.match(sidebarSource, /setFocusMode\(false\);/);
  assert.match(sidebarSource, /onClick=\{handleNewIssue\}/);
  assert.match(
    sidebarSource,
    /<div className="grid gap-2">[\s\S]*>\s*New issue\s*<[\s\S]*>\s*Dashboard\s*<[\s\S]*>\s*Issues\s*<[\s\S]*>\s*Teammates\s*</,
  );
  assert.match(sidebarSource, /const openIssueDetailTab = useOpenIssueDetailTab\(\);/);
  assert.match(sidebarSource, /void openIssueDetailTab\(\{\s*workspaceId: issue\.workspace_id,\s*issueId: issue\.issue_id,/);
  assert.doesNotMatch(sidebarSource, /sessionId: issue\.session_id/);
  assert.match(sidebarSource, /function SidebarInboxSection\(\) \{/);
  assert.match(sidebarSource, /Inbox is empty for now/);
  assert.doesNotMatch(sidebarSource, /useTaskProposals/);
});
