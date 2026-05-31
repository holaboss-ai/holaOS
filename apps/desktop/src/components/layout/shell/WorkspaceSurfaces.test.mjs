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
  ] = await Promise.all([
    readFile(CENTER_PATH, "utf8"),
    readFile(SIDEBAR_PATH, "utf8"),
    readFile(SEARCH_DIALOG_PATH, "utf8"),
    readFile(TOP_CHROME_PATH, "utf8"),
    readFile(BOARD_PANE_PATH, "utf8"),
    readFile(DASHBOARD_PANE_PATH, "utf8"),
    readFile(ISSUE_DETAIL_PANE_PATH, "utf8"),
    readFile(TEAMMATES_PANE_PATH, "utf8"),
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
  // SidebarNavRow is the shared row primitive — Dashboard / Issues / Teammates
  // all render through it with label + onClick. Catching the component name
  // alone keeps the test resilient to row-styling churn.
  assert.match(sidebarSource, /function SidebarNavRow\(/);
  assert.match(sidebarSource, /label="Dashboard"\s*onClick=\{handleOpenDashboard\}/);
  assert.match(sidebarSource, /label="Issues"\s*onClick=\{handleOpenBoard\}/);
  assert.match(sidebarSource, /label="Teammates"\s*onClick=\{handleOpenTeammates\}/);
  // New-issue affordance is now an icon-only header button — text moved into
  // aria-label so it stays screen-reader-discoverable.
  assert.match(sidebarSource, /aria-label="New issue"/);
  assert.match(sidebarSource, /onClick=\{handleNewIssue\}/);
  // Handler delegates to the NewIssueDialog atom; prefill / focus toggles
  // belong to the old composer-driven flow and are intentionally gone.
  assert.match(sidebarSource, /const setNewIssueOpen = useSetAtom\(newIssueOpenAtom\);/);
  assert.match(sidebarSource, /const handleNewIssue = useCallback\(\(\) => \{[\s\S]*?setNewIssueOpen\(true\);/);
  assert.doesNotMatch(sidebarSource, /text: "New issue: ",/);
  assert.doesNotMatch(sidebarSource, /<div className="grid gap-2">/);
  // Empty-state copy when no workspace is selected — replaces the previous
  // silently-disabled buttons.
  assert.match(
    sidebarSource,
    /if \(!selectedWorkspaceId\) \{[\s\S]*?Select a workspace from the top bar/,
  );
  // Done issues collapse into a disclosure instead of polluting the active list.
  assert.match(sidebarSource, /const \[showDone, setShowDone\] = useState\(false\);/);
  assert.match(sidebarSource, /setShowDone\(\(prev\) => !prev\)/);
  assert.match(sidebarSource, /SectionLabel className="justify-between">[\s\S]*?<span>Agent Team</);
  assert.match(sidebarSource, /setInternalTabs\(\(prev\) => upsertInternalTab\(prev, tab\)\);/);
  assert.match(sidebarSource, /setActiveInternalTabId\(tab\.id\);/);
  assert.doesNotMatch(sidebarSource, /function SidebarNewIssueAction\(\)/);

  assert.match(searchDialogSource, /label="Dashboard"/);
  assert.match(searchDialogSource, /label="Board"/);
  assert.match(searchDialogSource, /label="Teammates"/);
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

  // Board still shows status columns in a fixed order and hides backlog.
  // The styling/collapsing tricks change often; the filter + ordering and
  // the issue-detail navigation are the load-bearing invariants.
  assert.match(
    boardPaneSource,
    /const BOARD_STATUS_ORDER: VisibleBoardStatus\[] = \[\s*"todo",\s*"in_progress",\s*"in_review",\s*"blocked",\s*"done",\s*\];/,
  );
  assert.match(
    boardPaneSource,
    /const visibleIssues = useMemo\(\s*\(\) => issues\.filter\(\(issue\) => issue\.status !== "backlog"\),/,
  );
  assert.match(boardPaneSource, /const openIssueDetailTab = useOpenIssueDetailTab\(\);/);
  assert.match(boardPaneSource, /void openIssueDetailTab\(\{\s*workspaceId: issue\.workspace_id,\s*issueId: issue\.issue_id,/);
  // Drag-to-move and the broken inline modal are intentionally gone; status
  // edits go through the issue detail surface now.
  assert.doesNotMatch(boardPaneSource, /draggable=\{/);
  assert.doesNotMatch(boardPaneSource, /onDragStart=\{/);
  assert.doesNotMatch(boardPaneSource, /onDragOver=\{/);
  assert.doesNotMatch(boardPaneSource, /onDrop=\{/);
  assert.doesNotMatch(boardPaneSource, /window\.prompt\(\s*"Why is this issue blocked\?"/);
  assert.match(boardPaneSource, /window\.electronAPI\.workspace\.stopIssueRun/);
  // Empty-column accessibility hook still routes through issueStatusLabel.
  assert.match(boardPaneSource, /aria-label=\{`Add issue to \$\{issueStatusLabel\(status\)\}`\}/);

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
  // The dashboard card layout iterates frequently. Test the data-shape
  // invariants only; card titles belong to UI churn and should not block CI.

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
  assert.match(issueDetailPaneSource, /Sub-issues/);
  assert.match(issueDetailPaneSource, /parent_issue_id: issue\.issue_id/);
  // Parent issue surfaces via the Field label, not the old "Sub-issue of …" copy.
  assert.match(issueDetailPaneSource, /<Field label="Parent">/);
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
  assert.doesNotMatch(issueDetailPaneSource, /getMessageWrapperClassName=\{/);

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
  assert.match(teammatesPaneSource, /placeholder="Search teammates"/);
  // Routing the "ask HR to onboard a new teammate" intent through the main
  // session — load-bearing because it's the user's only entry point into
  // teammate creation today.
  assert.match(teammatesPaneSource, /Send a teammate creation request to the main session\./);
  assert.match(teammatesPaneSource, /Please ask the built-in HR teammate to create this teammate\./);
  assert.match(teammatesPaneSource, /Teammate name: \$\{name\}/);
  assert.match(teammatesPaneSource, /Teammate role: \$\{role\}/);
  // Detail-view tabs are emitted via a typed tuple → loose check on the
  // four canonical values rather than the JSX trigger nodes themselves.
  assert.match(teammatesPaneSource, /value: "activity",/);
  assert.match(teammatesPaneSource, /value: "issues",/);
  assert.match(teammatesPaneSource, /value: "instructions",/);
  assert.match(teammatesPaneSource, /value: "skills",/);
  assert.match(teammatesPaneSource, /ConfirmDialog/);
  assert.match(teammatesPaneSource, /SKILL\.md/);
});
