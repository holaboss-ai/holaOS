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
  assert.match(sidebarSource, />\s*New issue\s*</);
  assert.match(sidebarSource, />\s*Dashboard\s*</);
  assert.match(sidebarSource, />\s*Issues\s*</);
  assert.match(sidebarSource, />\s*Teammates\s*</);
  assert.match(sidebarSource, /const setComposerPrefill = useSetAtom\(chatComposerPrefillAtom\);/);
  assert.match(sidebarSource, /const setFocusMode = useSetAtom\(focusModeAtom\);/);
  assert.match(sidebarSource, /const handleNewIssue = useCallback\(\(\) => \{/);
  assert.match(sidebarSource, /text: "New issue: ",/);
  assert.match(sidebarSource, /mode: "replace",/);
  assert.match(sidebarSource, /sessionMode: "preserve",/);
  assert.match(sidebarSource, /setFocusMode\(false\);/);
  assert.match(sidebarSource, /onClick=\{handleNewIssue\}/);
  assert.match(
    sidebarSource,
    /<div className="grid gap-2">[\s\S]*>\s*New issue\s*<[\s\S]*>\s*Dashboard\s*<[\s\S]*>\s*Issues\s*<[\s\S]*>\s*Teammates\s*</,
  );
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

  assert.match(boardPaneSource, /const BOARD_COLUMN_CHROME:/);
  assert.match(
    boardPaneSource,
    /const BOARD_STATUS_ORDER: VisibleBoardStatus\[] = \[\s*"todo",\s*"in_progress",\s*"in_review",\s*"blocked",\s*"done",\s*\];/,
  );
  assert.match(
    boardPaneSource,
    /const visibleIssues = useMemo\(\s*\(\) => issues\.filter\(\(issue\) => issue\.status !== "backlog"\),/,
  );
  assert.doesNotMatch(boardPaneSource, />\s*All\s*</);
  assert.doesNotMatch(boardPaneSource, />\s*Members\s*</);
  assert.doesNotMatch(boardPaneSource, />\s*Agents\s*</);
  assert.doesNotMatch(boardPaneSource, /workingCount/);
  assert.doesNotMatch(boardPaneSource, /<span>Agent Team<\/span>/);
  assert.match(boardPaneSource, />\s*Issues\s*</);
  assert.doesNotMatch(boardPaneSource, /setNewIssueOpen/);
  assert.match(boardPaneSource, /const openIssueDetailTab = useOpenIssueDetailTab\(\);/);
  assert.match(boardPaneSource, /void openIssueDetailTab\(\{\s*workspaceId: issue\.workspace_id,\s*issueId: issue\.issue_id,/);
  assert.match(boardPaneSource, /line-clamp-1 text-\[15px\] font-semibold/);
  assert.doesNotMatch(boardPaneSource, /draggable=\{/);
  assert.doesNotMatch(boardPaneSource, /onDragStart=\{/);
  assert.doesNotMatch(boardPaneSource, /onDragOver=\{/);
  assert.doesNotMatch(boardPaneSource, /onDrop=\{/);
  assert.doesNotMatch(boardPaneSource, /Drag to move/);
  assert.match(boardPaneSource, /window\.electronAPI\.workspace\.stopIssueRun/);
  assert.match(boardPaneSource, /const isCollapsed = columnIssues\.length === 0;/);
  assert.match(
    boardPaneSource,
    /isCollapsed\s*\?\s*"min-w-\[128px\] flex-\[1_1_0%\]"\s*:\s*"min-w-\[320px\] flex-\[3_1_0%\]"/,
  );
  assert.match(boardPaneSource, /min-w-full items-stretch gap-5 pb-3/);
  assert.match(boardPaneSource, /isCollapsed\s*\?\s*"justify-start px-4"\s*:\s*"justify-between gap-3 px-4"/);
  assert.match(boardPaneSource, /className="truncate text-\[14px\] font-semibold text-foreground"/);
  assert.match(boardPaneSource, /aria-label=\{`\$\{issueStatusLabel\(status\)\} column empty`\}/);
  assert.doesNotMatch(boardPaneSource, /window\.prompt\(\s*"Why is this issue blocked\?"/);
  assert.doesNotMatch(boardPaneSource, /SelectTrigger/);
  assert.doesNotMatch(boardPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(dashboardPaneSource, /export function WorkspaceDashboardPane/);
  assert.match(
    dashboardPaneSource,
    /const STATUS_ORDER: IssueStatusPayload\[] = \[\s*"todo",\s*"in_progress",\s*"in_review",\s*"blocked",\s*"done",\s*\];/,
  );
  assert.match(
    dashboardPaneSource,
    /const visibleIssues = useMemo\(\s*\(\) => issues\.filter\(\(issue\) => issue\.status !== "backlog"\),/,
  );
  assert.match(
    dashboardPaneSource,
    /window\.electronAPI\.workspace\.listTurnResults\(\{/,
  );
  assert.doesNotMatch(dashboardPaneSource, /<span>Agent Team<\/span>/);
  assert.match(dashboardPaneSource, />\s*Dashboard\s*</);
  assert.match(dashboardPaneSource, /Waiting for Review/);
  assert.match(dashboardPaneSource, /Token Consumption/);
  assert.match(dashboardPaneSource, /Run Activity/);
  assert.match(dashboardPaneSource, /Issues by Priority/);
  assert.match(dashboardPaneSource, /Issues by Status/);
  assert.doesNotMatch(dashboardPaneSource, /Success Rate/);
  assert.match(dashboardPaneSource, /Recent Activity/);
  assert.match(dashboardPaneSource, /Recent Tasks/);
  assert.doesNotMatch(dashboardPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(issueDetailPaneSource, /export function IssueDetailPane/);
  assert.match(issueDetailPaneSource, /chatMessagesFromSessionState/);
  assert.match(issueDetailPaneSource, /ConversationTurns/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.queueSessionInput/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.getSessionHistory/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.openSessionOutputStream/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.onSessionStreamEvent/);
  assert.match(issueDetailPaneSource, /window\.electronAPI\.workspace\.stageSessionAttachments/);
  assert.match(issueDetailPaneSource, /workspaceSurfaceTab\("issues_board"/);
  assert.match(issueDetailPaneSource, /Back to board/);
  assert.match(issueDetailPaneSource, /Related issues/);
  assert.match(issueDetailPaneSource, /Create sub-issue/);
  assert.match(issueDetailPaneSource, /parent_issue_id: issue\.issue_id/);
  assert.match(issueDetailPaneSource, /Sub-issue of/);
  assert.match(issueDetailPaneSource, /attachments: nextIssueAttachments/);
  assert.doesNotMatch(issueDetailPaneSource, /title="Properties"/);
  assert.match(issueDetailPaneSource, /Activity/);
  assert.doesNotMatch(
    issueDetailPaneSource,
    /\{ value: "backlog", label: "Backlog" \},/,
  );
  assert.doesNotMatch(issueDetailPaneSource, /Backlog \(hidden\)/);
  assert.match(issueDetailPaneSource, /showExecutionInternals: true,/);
  assert.match(issueDetailPaneSource, /<ConversationTurns[\s\S]*showExecutionInternals/);
  assert.match(issueDetailPaneSource, /liveAssistantTurn=\{/);
  assert.match(issueDetailPaneSource, /messages\.length > 0 \|\| showLiveAssistantTurn/);
  assert.match(issueDetailPaneSource, /The full run trace will appear here once this issue has execution or replies\./);
  assert.doesNotMatch(issueDetailPaneSource, /getMessageWrapperClassName=\{/);
  assert.match(issueDetailPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(teammatesPaneSource, /export function TeammatesPane/);
  assert.match(
    teammatesPaneSource,
    /const TEAMMATE_TABLE_GRID_COLUMNS =\s*"grid-cols-\[minmax\(240px,2\.4fr\)_132px_132px_104px_96px\]";/,
  );
  assert.match(teammatesPaneSource, /DialogPrimitive\.Root/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.listTeammates/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.listIssues/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.ensureMainSession/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.queueSessionInput/);
  assert.match(teammatesPaneSource, /window\.electronAPI\.workspace\.updateTeammate/);
  assert.match(teammatesPaneSource, /useOpenIssueDetailTab/);
  assert.match(teammatesPaneSource, /placeholder="Search teammates\.\.\."/);
  assert.match(teammatesPaneSource, /Back to teammates/);
  assert.match(teammatesPaneSource, /Send a teammate creation request to the main session\./);
  assert.match(teammatesPaneSource, /Please ask the built-in HR teammate to create this teammate\./);
  assert.match(teammatesPaneSource, /Teammate name: \$\{name\}/);
  assert.match(teammatesPaneSource, /Teammate role: \$\{role\}/);
  assert.match(teammatesPaneSource, /TabsTrigger\s+value="activity"/);
  assert.match(teammatesPaneSource, /TabsTrigger\s+value="issues"/);
  assert.match(teammatesPaneSource, /TabsTrigger\s+value="instructions"/);
  assert.match(teammatesPaneSource, /TabsTrigger\s+value="skills"/);
  assert.doesNotMatch(teammatesPaneSource, /Preferred tools/);
  assert.doesNotMatch(teammatesPaneSource, /<span>Agent Team<\/span>/);
  assert.match(teammatesPaneSource, />\s*Teammate\s*</);
  assert.doesNotMatch(teammatesPaneSource, /Creating a new teammate/);
  assert.match(teammatesPaneSource, /ConfirmDialog/);
  assert.match(teammatesPaneSource, /SKILL\.md/);
  assert.match(teammatesPaneSource, /className="min-w-0 flex-1"/);
  assert.match(
    teammatesPaneSource,
    /className="truncate text-\[15px\] font-semibold text-foreground"/,
  );
  assert.doesNotMatch(teammatesPaneSource, /WorkspaceSurfaceHeader/);

  assert.match(surfaceHeaderSource, /export function WorkspaceSurfaceHeader/);
  assert.match(surfaceHeaderSource, /statusMessage/);
  assert.match(surfaceHeaderSource, /meta/);
});
