import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CENTER_PATH = new URL("./Center.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const SEARCH_DIALOG_PATH = new URL("./SearchDialog.tsx", import.meta.url);
const TOP_CHROME_PATH = new URL("./TopChrome.tsx", import.meta.url);
const BOARD_PANE_PATH = new URL("./IssuesBoardPane.tsx", import.meta.url);
const DASHBOARD_PANE_PATH = new URL("./WorkspaceDashboardPane.tsx", import.meta.url);
const ISSUE_DETAIL_PANE_PATH = new URL("./IssueDetailPane.tsx", import.meta.url);
const TEAMMATES_PANE_PATH = new URL("./TeammatesPane.tsx", import.meta.url);
const SURFACE_HEADER_PATH = new URL("./WorkspaceSurfaceHeader.tsx", import.meta.url);

test("workspace surfaces wire board and dashboard tabs through the shell", async () => {
  const [
    centerSource,
    sidebarSource,
    searchDialogSource,
    topChromeSource,
    boardPaneSource,
    dashboardPaneSource,
    issueDetailPaneSource,
    teammatesPaneSource,
    surfaceHeaderSource,
  ] = await Promise.all([
    readFile(CENTER_PATH, "utf8"),
    readFile(SIDEBAR_PATH, "utf8"),
    readFile(SEARCH_DIALOG_PATH, "utf8"),
    readFile(TOP_CHROME_PATH, "utf8"),
    readFile(BOARD_PANE_PATH, "utf8"),
    readFile(DASHBOARD_PANE_PATH, "utf8"),
    readFile(ISSUE_DETAIL_PANE_PATH, "utf8"),
    readFile(TEAMMATES_PANE_PATH, "utf8"),
    readFile(SURFACE_HEADER_PATH, "utf8"),
  ]);

  assert.match(centerSource, /import \{ TeammatesPane \} from "\.\/TeammatesPane";/);
  assert.match(centerSource, /import \{ IssueDetailPane \} from "\.\/IssueDetailPane";/);
  assert.match(centerSource, /import \{ IssuesBoardPane \} from "\.\/IssuesBoardPane";/);
  assert.match(centerSource, /import \{ WorkspaceDashboardPane \} from "\.\/WorkspaceDashboardPane";/);
  assert.match(centerSource, /activeInternal\.kind === "issue_detail" \? \(\s*<IssueDetailPane[\s\S]*issueId=\{activeInternal\.issueId\}/);
  assert.match(centerSource, /activeInternal\.kind === "issues_board" \? \(\s*<IssuesBoardPane workspaceId=\{activeInternal\.workspaceId\} \/>/);
  assert.match(centerSource, /activeInternal\.kind === "teammates" \? \(\s*<TeammatesPane workspaceId=\{activeInternal\.workspaceId\} \/>/);
  assert.match(centerSource, /activeInternal\.kind === "workspace_dashboard" \? \(\s*<WorkspaceDashboardPane workspaceId=\{activeInternal\.workspaceId\} \/>/);

  assert.match(sidebarSource, /label: "Home", icon: <Home \/>/);
  assert.match(sidebarSource, /label: "Agent Team", icon: <Bot \/>/);
  assert.match(sidebarSource, /function openWorkspaceSurfaceTab\(/);
  assert.match(sidebarSource, /kind: "workspace_dashboard"/);
  assert.match(sidebarSource, /kind: "issues_board"/);
  assert.match(sidebarSource, /kind: "teammates"/);
  assert.match(sidebarSource, /function SidebarIssuesSection\(\) \{/);
  assert.match(sidebarSource, /Open dashboard/);
  assert.match(sidebarSource, /Open board/);
  assert.match(sidebarSource, /Open teammates/);
  assert.match(sidebarSource, /SectionLabel>\s*Agent Team/);
  assert.match(sidebarSource, /setInternalTabs\(\(prev\) => upsertInternalTab\(prev, tab\)\);/);
  assert.match(sidebarSource, /setActiveInternalTabId\(tab\.id\);/);
  assert.doesNotMatch(sidebarSource, /function SidebarNewIssueAction\(\)/);

  assert.match(searchDialogSource, /label="Open Dashboard"/);
  assert.match(searchDialogSource, /label="Open Board"/);
  assert.match(searchDialogSource, /label="Open Teammates"/);
  assert.match(searchDialogSource, /openWorkspaceSurface\("workspace_dashboard"\)/);
  assert.match(searchDialogSource, /openWorkspaceSurface\("issues_board"\)/);
  assert.match(searchDialogSource, /openWorkspaceSurface\("teammates"\)/);
  assert.doesNotMatch(searchDialogSource, /label="New issue"/);

  assert.match(topChromeSource, /Bot/);
  assert.match(topChromeSource, /CircleDot/);
  assert.match(topChromeSource, /FolderKanban/);
  assert.match(topChromeSource, /LayoutDashboard/);
  assert.match(topChromeSource, /kind === "issue_detail"/);
  assert.match(topChromeSource, /kind === "issues_board"/);
  assert.match(topChromeSource, /kind === "teammates"/);
  assert.match(topChromeSource, /kind === "workspace_dashboard"/);

  assert.match(boardPaneSource, /const BOARD_MUTATION_STATUSES:/);
  assert.match(boardPaneSource, /const BOARD_COLUMN_CHROME:/);
  assert.match(boardPaneSource, /Kanban Board/);
  assert.match(boardPaneSource, /workingCount/);
  assert.match(boardPaneSource, /const openIssueDetailTab = useOpenIssueDetailTab\(\);/);
  assert.match(boardPaneSource, /void openIssueDetailTab\(\{\s*workspaceId: issue\.workspace_id,\s*issueId: issue\.issue_id,/);
  assert.match(boardPaneSource, /value: "in_progress", label: "In progress", disabled: true/);
  assert.match(boardPaneSource, /window\.electronAPI\.workspace\.stopIssueRun/);
  assert.match(boardPaneSource, /window\.prompt\(\s*"Why is this issue blocked\?"/);
  assert.match(boardPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(dashboardPaneSource, /export function WorkspaceDashboardPane/);
  assert.match(dashboardPaneSource, /Track teammate coverage, active work, and issue flow at a glance\./);
  assert.match(dashboardPaneSource, /Issues by priority/);
  assert.match(dashboardPaneSource, /Issues by status/);
  assert.match(dashboardPaneSource, /Recently updated/);
  assert.match(dashboardPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(issueDetailPaneSource, /export function IssueDetailPane/);
  assert.match(issueDetailPaneSource, /chatMessagesFromSessionState/);
  assert.match(issueDetailPaneSource, /ConversationTurns/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.queueSessionInput/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.getSessionHistory/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.stageSessionAttachments/);
  assert.match(issueDetailPaneSource, /attachments: nextIssueAttachments/);
  assert.match(issueDetailPaneSource, /Properties/);
  assert.match(issueDetailPaneSource, /Activity/);
  assert.match(issueDetailPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(teammatesPaneSource, /export function TeammatesPane/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.listTeammates/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.createTeammate/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.updateTeammate/);
  assert.match(teammatesPaneSource, /ConfirmDialog/);
  assert.match(teammatesPaneSource, /SKILL\.md/);
  assert.match(teammatesPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(surfaceHeaderSource, /export function WorkspaceSurfaceHeader/);
  assert.match(surfaceHeaderSource, /statusMessage/);
  assert.match(surfaceHeaderSource, /meta/);
});
