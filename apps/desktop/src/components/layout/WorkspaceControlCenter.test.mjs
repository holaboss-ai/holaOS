import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKSPACE_CONTROL_CENTER_PATH = new URL(
  "./WorkspaceControlCenter.tsx",
  import.meta.url,
);

test("workspace control center renders preview cards through the main chat turn components", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /import \{[\s\S]*ArtifactBrowserModal,[\s\S]*chatMessagesFromSessionState,[\s\S]*ConversationTurns,[\s\S]*historyMessagesInDisplayOrder,[\s\S]*inputIdFromMessageId,[\s\S]*turnInputIdsFromHistoryMessages,[\s\S]*type ChatMessage,[\s\S]*\} from "@\/components\/panes\/ChatPane";/,
  );
  assert.match(source, /<ConversationTurns/);
  assert.match(source, /assistantFitToContent/);
  assert.match(source, /onOpenOutput=\{\(output\) =>/);
  assert.match(source, /onOpenOutput\(workspaceId, output\)/);
  assert.match(source, /const \[artifactBrowserOpen, setArtifactBrowserOpen\] = useState\(false\);/);
  assert.match(source, /const \[artifactBrowserFilter, setArtifactBrowserFilter\] =\s*useState<ArtifactBrowserFilter>\("all"\);/);
  assert.match(source, /const \[artifactBrowserOutputs, setArtifactBrowserOutputs\] = useState<\s*WorkspaceOutputRecordPayload\[]\s*>\(\[\]\);/);
  assert.match(source, /const handleOpenArtifacts = useCallback\(\s*\(outputs: WorkspaceOutputRecordPayload\[]\) => \{/);
  assert.match(source, /setArtifactBrowserOutputs\(outputs\);/);
  assert.match(source, /setArtifactBrowserOpen\(true\);/);
  assert.match(source, /onOpenAllArtifacts=\{handleOpenArtifacts\}/);
  assert.match(source, /<ArtifactBrowserModal[\s\S]*layout="card"/);
  assert.match(source, /composerModel: string \| null;/);
  assert.match(source, /orderedWorkspaceIds: readonly string\[];/);
  assert.match(source, /highlightedWorkspaceIds: readonly string\[];/);
  assert.match(source, /onWorkspaceOrderChange: \(workspaceIds: string\[]\) => void;/);
  assert.match(source, /onVisibleWorkspaceIdsChange: \(workspaceIds: string\[]\) => void;/);
  assert.match(source, /onCardComposerSubmit: \(workspaceId: string\) => void;/);
  assert.match(source, /onWorkspaceCompletion: \(workspaceId: string\) => void;/);
});

test("workspace control center queues card composer input with the resolved shell composer model", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /composerModel: string \| null;/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.queueSessionInput\(\{[\s\S]*priority: 0,[\s\S]*model: composerModel,/,
  );
  assert.match(source, /<WorkspaceControlCenterCard[\s\S]*composerModel=\{composerModel\}/);
});

test("workspace control center supports persisted drag reordering of cards", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /GripVertical/);
  assert.match(source, /type DragEvent as ReactDragEvent/);
  assert.match(
    source,
    /function mergeWorkspaceOrder\(\s*sortedWorkspaces: WorkspaceRecordPayload\[],\s*orderedWorkspaceIds: readonly string\[],\s*\)/,
  );
  assert.match(source, /const orderedWorkspaces = useMemo\(/);
  assert.match(
    source,
    /mergeWorkspaceOrder\(sortedWorkspaces, orderedWorkspaceIds\)/,
  );
  assert.match(source, /const \[draggedWorkspaceId, setDraggedWorkspaceId\] = useState\(""\);/);
  assert.match(source, /const \[dragTargetWorkspaceId, setDragTargetWorkspaceId\] = useState\(""\);/);
  assert.match(
    source,
    /const handleDragStartWorkspace = useCallback\(\s*\(event: ReactDragEvent<HTMLButtonElement>, workspaceId: string\) => \{/,
  );
  assert.match(source, /event\.dataTransfer\.effectAllowed = "move";/);
  assert.match(source, /const handleDropWorkspace = useCallback\(/);
  assert.match(source, /onWorkspaceOrderChange\(nextOrderedWorkspaceIds\);/);
  assert.match(source, /draggable/);
  assert.match(source, /aria-label=\{`Reorder \$\{workspace\.name\}`\}/);
  assert.match(source, /onDragStart=\{\(event\) => onDragStartWorkspace\(event, workspaceId\)\}/);
  assert.match(source, /onDragEnter=\{\(\) => onDragEnterWorkspace\(workspaceId\)\}/);
  assert.match(source, /onDrop=\{\(event\) => onDropWorkspace\(event, workspaceId\)\}/);
  assert.match(source, /onDragEnd=\{onDragEndWorkspace\}/);
  assert.match(source, /<WorkspaceControlCenterCard[\s\S]*isDragging=\{draggedWorkspaceId === workspace\.id\.trim\(\)\}/);
  assert.match(source, /<WorkspaceControlCenterCard[\s\S]*onDropWorkspace=\{handleDropWorkspace\}/);
});

test("workspace control center reports the visible page and highlights unseen completed cards", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /hasUnreadCompletionHighlight: boolean;/);
  assert.match(source, /const highlightedWorkspaceIdSet = useMemo\(/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*onVisibleWorkspaceIdsChange\([\s\S]*currentPageWorkspaces[\s\S]*\);\s*\}, \[currentPageWorkspaces, onVisibleWorkspaceIdsChange\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*return \(\) => \{\s*onVisibleWorkspaceIdsChange\(\[\]\);/,
  );
  assert.match(source, /onPointerDownCapture=\{\(\) => onSelectWorkspace\(workspaceId\)\}/);
  assert.match(source, /onFocusCapture=\{\(\) => onSelectWorkspace\(workspaceId\)\}/);
  assert.match(
    source,
    /hasUnreadCompletionHighlight[\s\S]*\?\s*"border-primary\/65 shadow-\[0_16px_48px_-24px_color-mix\(in_oklch,var\(--primary\)_44%,transparent\)\]"/,
  );
  assert.match(source, /hasUnreadCompletionHighlight=\{highlightedWorkspaceIdSet\.has\(/);
  assert.match(source, /onCardComposerSubmit=\{onCardComposerSubmit\}/);
  assert.match(source, /onCardComposerSubmit\(workspaceId\);/);
  assert.match(source, /onWorkspaceCompletion=\{onWorkspaceCompletion\}/);
});

test("workspace control center signals visible completions directly from the card transcript controller", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /const CONTROL_CENTER_RUNTIME_POLL_INTERVAL_MS = 750;/,
  );
  assert.match(source, /const hasHydratedSnapshotRef = useRef\(false\);/);
  assert.match(source, /const latestAssistantMessageIdRef = useRef\(""\);/);
  assert.match(source, /const lastSignaledCompletionKeyRef = useRef\(""\);/);
  assert.match(
    source,
    /const lastTerminalRunOutcomeRef = useRef<"completed" \| "failed" \| null>\(null\);/,
  );
  assert.match(
    source,
    /const signalWorkspaceCompletion = useCallback\(\s*\(completionKey\?: string \| null\) => \{/,
  );
  assert.match(
    source,
    /onWorkspaceCompletion\(workspaceId\);/,
  );
  assert.match(
    source,
    /const shouldSignalSnapshotCompletion =[\s\S]*hasHydratedSnapshotRef\.current[\s\S]*!shouldAttachLiveRunStream[\s\S]*latestAssistantMessageId !== latestAssistantMessageIdRef\.current;/,
  );
  assert.match(source, /latestAssistantMessageIdRef\.current = latestAssistantMessageId;/);
  assert.match(source, /hasHydratedSnapshotRef\.current = true;/);
  assert.match(source, /if \(shouldSignalSnapshotCompletion\) \{\s*signalWorkspaceCompletion\(latestAssistantMessageId\);/);
  assert.match(source, /payload\.type === "done"[\s\S]*signalWorkspaceCompletion\(/);
  assert.match(source, /lastTerminalRunOutcomeRef\.current = "failed";/);
  assert.match(source, /lastTerminalRunOutcomeRef\.current = "completed";/);
  assert.match(source, /eventType === "run_completed"[\s\S]*signalWorkspaceCompletion\(/);
  assert.match(
    source,
    /const lastTurnCompletedAt = \(\s*nextRuntimeState\?\.last_turn_completed_at \|\| ""\s*\)\.trim\(\);[\s\S]*signalWorkspaceCompletion\(/,
  );
  assert.match(
    source,
    /window\.setInterval\(\(\) => \{[\s\S]*pollRuntimeState\(\);[\s\S]*\}, CONTROL_CENTER_RUNTIME_POLL_INTERVAL_MS\);/,
  );
});

test("workspace control center renders a live assistant placeholder in the chat pane instead of a working frame badge", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /const \[liveAssistantText, setLiveAssistantText\] = useState\(""\);/);
  assert.match(source, /const \[liveAgentStatus, setLiveAgentStatus\] = useState\(""\);/);
  assert.match(source, /const liveAssistantTurn =/);
  assert.match(source, /isResponding \|\| Boolean\(liveAssistantText\.trim\(\)\)/);
  assert.match(source, /status: liveAgentStatus \|\| \(isResponding \? "Working" : ""\),/);
  assert.match(source, /setLiveAssistantText\(\(current\) => `\$\{current\}\$\{delta\}`\);/);
  assert.match(source, /runtimeCardState !== "working" && runtimeCardState !== "queued" \? \(/);
  assert.match(source, /liveAssistantTurn=\{liveAssistantTurn\}/);
  assert.match(source, /showExecutionInternals=\{false\}/);
  assert.doesNotMatch(source, /TypingStatusLine/);
});

test("workspace control center retries terminal refreshes so completed replies do not wait for a manual reload", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /const CONTROL_CENTER_TERMINAL_REFRESH_DELAYS_MS = \[150, 500, 1_500, 3_000\];/,
  );
  assert.match(
    source,
    /const terminalRefreshTimerIdsRef = useRef<number\[]>\(\[]\);/,
  );
  assert.match(
    source,
    /const clearScheduledTerminalRefreshes = useCallback\(\(\) => \{/,
  );
  assert.match(
    source,
    /const scheduleTerminalRefresh = useCallback\(\(\) => \{/,
  );
  assert.match(
    source,
    /for \(const delayMs of CONTROL_CENTER_TERMINAL_REFRESH_DELAYS_MS\)/,
  );
  assert.match(
    source,
    /void refreshSnapshot\(\{ attachStream: false \}\)\.catch\(\(\) => undefined\);/,
  );
  assert.match(source, /payload\.type === "done"[\s\S]*scheduleTerminalRefresh\(\);/);
  assert.match(source, /eventType === "run_completed"[\s\S]*scheduleTerminalRefresh\(\);/);
  assert.match(source, /eventType === "run_failed"[\s\S]*scheduleTerminalRefresh\(\);/);
});

test("workspace control center commits the live assistant reply locally before terminal refresh reconciliation", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /const pendingCommittedAssistantMessageRef =\s*useRef<PreviewChatMessage \| null>\(null\);/,
  );
  assert.match(
    source,
    /const liveAssistantTextRef = useRef\(""\);/,
  );
  assert.match(source, /liveAssistantTextRef\.current = liveAssistantText;/);
  assert.match(
    source,
    /const commitLiveAssistantPreviewMessage = useCallback\(\s*\(inputId\?: string \| null\) => \{/,
  );
  assert.match(
    source,
    /id: normalizedInputId\s*\?\s*`assistant-\$\{normalizedInputId\}`\s*:\s*`assistant-preview-\$\{Date\.now\(\)\}`/,
  );
  assert.match(
    source,
    /pendingCommittedAssistantMessageRef\.current = nextMessage;/,
  );
  assert.match(
    source,
    /setMessages\(\(current\) => \{[\s\S]*current\.some\(\(message\) => message\.id === nextMessage\.id\)[\s\S]*trimPreviewMessages\(\[\.\.\.current, nextMessage\]\)/,
  );
  assert.match(source, /setLiveAssistantText\(""\);/);
  assert.match(
    source,
    /const committed = commitLiveAssistantPreviewMessage\(finishedInputId\);/,
  );
  assert.match(
    source,
    /const committed = commitLiveAssistantPreviewMessage\(completedInputId\);/,
  );
  assert.match(
    source,
    /const completedInputId = \(nextRuntimeState\?\.current_input_id \|\| ""\)\.trim\(\);[\s\S]*const committed = commitLiveAssistantPreviewMessage\(completedInputId\);/,
  );
});

test("workspace control center passively reconciles idle main-session follow-ups", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /const CONTROL_CENTER_IDLE_RECONCILE_INTERVAL_MS = 2500;/,
  );
  assert.match(
    source,
    /function latestPreviewMessageId\(messages: PreviewChatMessage\[]\) \{/,
  );
  assert.match(
    source,
    /const messagesRef = useRef<PreviewChatMessage\[]>\(\[]\);/,
  );
  assert.match(source, /messagesRef\.current = messages;/);
  assert.match(
    source,
    /const reconcileIdleMainSessionActivity = async \(\) => \{/,
  );
  assert.match(
    source,
    /document\.visibilityState !== "visible"/,
  );
  assert.match(
    source,
    /const shouldAttachAutonomousRun =[\s\S]*!activeStreamIdRef\.current[\s\S]*!pendingInputIdRef\.current[\s\S]*\["BUSY", "QUEUED"\]\.includes\(currentRuntimeStatus\);/,
  );
  assert.match(
    source,
    /await refreshSnapshot\(\{ attachStream: true \}\);/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.getSessionHistory\(\{[\s\S]*limit: 1,[\s\S]*order: "desc",/,
  );
  assert.match(
    source,
    /const latestDisplayedMessageId = latestPreviewMessageId\(messagesRef\.current\);/,
  );
  assert.match(
    source,
    /latestHistoryMessageId === latestDisplayedMessageId/,
  );
  assert.match(
    source,
    /await refreshSnapshot\(\{ attachStream: false \}\);/,
  );
  assert.match(
    source,
    /window\.setInterval\(\(\) => \{[\s\S]*reconcileIdleMainSessionActivity\(\);[\s\S]*\}, CONTROL_CENTER_IDLE_RECONCILE_INTERVAL_MS\);/,
  );
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleMainSession\);/);
  assert.match(
    source,
    /document\.addEventListener\("visibilitychange", refreshVisibleMainSession\);/,
  );
});

test("workspace control center loads the latest main-session history slice and recent turn outputs", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /order: "desc"/);
  assert.match(source, /historyMessagesInDisplayOrder\(\s*history\.messages,\s*"desc"/);
  assert.match(source, /turnInputIdsFromHistoryMessages\(historyMessages\)/);
  assert.match(source, /window\.electronAPI\.workspace\.getSessionOutputEvents\(\{/);
  assert.match(source, /window\.electronAPI\.workspace\.listOutputs\(\{/);
  assert.match(source, /window\.electronAPI\.workspace\.listMemoryUpdateProposals\(\{/);
  assert.match(source, /chatMessagesFromSessionState\(\{/);
  assert.match(source, /showExecutionInternals: false,/);
});

test("workspace control center suppresses the in-flight assistant history row when attaching a live stream", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(
    source,
    /const currentRuntimeInputId = \(\s*nextRuntimeState\?\.current_input_id \|\| ""\s*\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const shouldAttachLiveRunStream =[\s\S]*options\?\.attachStream !== false[\s\S]*nextRuntimeCardState === "queued" \|\| nextRuntimeCardState === "working"/,
  );
  assert.match(
    source,
    /const renderedMessagesForDisplay =\s*shouldAttachLiveRunStream && currentRuntimeInputId\s*\?\s*nextMessages\.filter\(\s*\(message\) =>\s*message\.role !== "assistant" \|\|\s*inputIdFromMessageId\(message\.id, "assistant"\) !==\s*currentRuntimeInputId,\s*\)\s*:\s*nextMessages;/,
  );
  assert.match(source, /setMessages\(nextRenderedMessages\);/);
  assert.match(
    source,
    /if \(shouldAttachLiveRunStream\) \{[\s\S]*includeHistory: Boolean\(currentRuntimeInputId\),/,
  );
  assert.match(
    source,
    /const pendingCommittedAssistantMessage =\s*pendingCommittedAssistantMessageRef\.current;/,
  );
  assert.match(
    source,
    /const nextRenderedMessages =[\s\S]*pendingCommittedAssistantMessage[\s\S]*!renderedMessagesForDisplay\.some\(\s*\(message\) => message\.id === pendingCommittedAssistantMessage\.id,\s*\)[\s\S]*trimPreviewMessages\(\[[\s\S]*pendingCommittedAssistantMessage,[\s\S]*\]\)/,
  );
  assert.match(
    source,
    /pendingCommittedAssistantMessageRef\.current = null;/,
  );
  assert.match(source, /setMessages\(nextRenderedMessages\);/);
});

test("workspace control center sizes cards to fit up to two visible rows before hitting a minimum height", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /cardsPerRow: number;/);
  assert.match(source, /const WORKSPACE_CARD_MIN_WIDTH = 320;/);
  assert.match(source, /const WORKSPACE_CARD_MIN_HEIGHT = 320;/);
  assert.match(source, /const WORKSPACE_CARD_MAX_HEIGHT = 480;/);
  assert.match(source, /const \[gridColumnCount, setGridColumnCount\] = useState\(\(\) =>\s*Math\.max\(1, Math\.min\(cardsPerRow, workspaces\.length \|\| 1\)\),\s*\);/);
  assert.match(source, /const \[visibleRowCount, setVisibleRowCount\] = useState\(1\);/);
  assert.match(source, /const \[cardHeight, setCardHeight\] = useState\(WORKSPACE_CARD_MAX_HEIGHT\);/);
  assert.match(source, /const \[allowVerticalOverflow, setAllowVerticalOverflow\] = useState\(false\);/);
  assert.match(source, /const viewportRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(source, /const availableWidth = Math\.max\(\s*0,\s*viewport\.clientWidth - paddingLeft - paddingRight,\s*\);/);
  assert.match(source, /const columnGap = 16;/);
  assert.match(source, /const maxColumnsByWidth = Math\.max\(\s*1,\s*Math\.floor\(\s*\(availableWidth \+ columnGap\) \/[\s\S]*WORKSPACE_CARD_MIN_WIDTH \+ columnGap[\s\S]*\),\s*\);/);
  assert.match(source, /const columnCount = Math\.max\(\s*1,\s*Math\.min\(cardsPerRow, workspaces\.length \|\| 1, maxColumnsByWidth\),\s*\);/);
  assert.match(source, /const totalRowCount = Math\.max\(\s*1,\s*Math\.ceil\(workspaces\.length \/ columnCount\),\s*\);/);
  assert.match(source, /const maxVisibleRowsByHeight = Math\.max\(\s*1,\s*Math\.floor\(\s*\(availableHeight \+ rowGap\) \/ \(WORKSPACE_CARD_MIN_HEIGHT \+ rowGap\),\s*\),\s*\);/);
  assert.match(source, /const visibleRowCount = Math\.max\(\s*1,\s*Math\.min\(\s*WORKSPACE_CARD_VISIBLE_ROWS,\s*totalRowCount,\s*maxVisibleRowsByHeight,\s*\),\s*\);/);
  assert.match(source, /const fittedHeight = Math\.floor\(\s*\(availableHeight - rowGap \* \(visibleRowCount - 1\)\) \/ visibleRowCount,\s*\);/);
  assert.match(source, /availableHeight >= WORKSPACE_CARD_MIN_HEIGHT\s*\?\s*WORKSPACE_CARD_MIN_HEIGHT\s*:\s*Math\.max\(1, fittedHeight\)/);
  assert.match(source, /Math\.ceil\(totalRowCount \/ visibleRowCount\)/);
  assert.match(source, /availableHeight > 0 && availableHeight < WORKSPACE_CARD_MIN_HEIGHT/);
  assert.match(source, /style=\{\s*\{[\s\S]*gridAutoRows: `\$\{cardHeight\}px`,[\s\S]*gridTemplateColumns: `repeat\(\$\{gridColumnCount\}, minmax\(0, 1fr\)\)`/);
  assert.match(source, /"relative h-full min-h-0 min-w-0 border border-border\/70 bg-card py-0 shadow-md"/);
  assert.match(source, /const currentPageWorkspaces = pagedWorkspaces\[currentPage\] \?\? \[\];/);
});

test("workspace control center pages between card rows on dominant horizontal wheel swipes", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /ChevronLeft,/);
  assert.match(source, /ChevronRight,/);
  assert.match(source, /type WheelEvent as ReactWheelEvent,/);
  assert.match(source, /const WORKSPACE_CARD_VISIBLE_ROWS = 2;/);
  assert.match(source, /const CONTROL_CENTER_WHEEL_SWIPE_THRESHOLD_PX = 140;/);
  assert.match(source, /const CONTROL_CENTER_WHEEL_SWIPE_RESET_MS = 180;/);
  assert.match(source, /function shouldIgnoreControlCenterSwipeGesture\(target: EventTarget \| null\)/);
  assert.match(source, /const \[pageCount, setPageCount\] = useState\(1\);/);
  assert.match(source, /const \[currentPage, setCurrentPage\] = useState\(0\);/);
  assert.match(source, /const wheelSwipeAccumulationRef = useRef\(0\);/);
  assert.match(source, /const navigatePage = useCallback\(\s*\(direction: -1 \| 1\) => \{/);
  assert.match(source, /const canPageBackward = currentPage > 0;/);
  assert.match(source, /const canPageForward = currentPage < pageCount - 1;/);
  assert.match(source, /const handleWheelSwipe = useCallback\(\s*\(event: ReactWheelEvent<HTMLDivElement>\) => \{/);
  assert.match(source, /horizontalDistance <= verticalDistance \* 1\.15/);
  assert.match(source, /event\.deltaX > 0 && currentPage >= pageCount - 1/);
  assert.match(source, /wheelSwipeAccumulationRef\.current \+= event\.deltaX;/);
  assert.match(source, /CONTROL_CENTER_WHEEL_SWIPE_THRESHOLD_PX/);
  assert.match(source, /const direction = wheelSwipeAccumulationRef\.current > 0 \? 1 : -1;/);
  assert.match(source, /navigatePage\(direction as -1 \| 1\);/);
  assert.match(source, /onWheelCapture=\{handleWheelSwipe\}/);
  assert.match(source, /allowVerticalOverflow \? "overflow-y-auto" : "overflow-y-hidden"/);
  assert.match(source, /style=\{\{ touchAction: "pan-x pinch-zoom" \}\}/);
  assert.match(source, /className="flex min-h-0 min-w-0 flex-1 items-stretch gap-0 px-0 sm:gap-px sm:px-0\.5"/);
  assert.match(source, /className="flex min-h-0 w-3\.5 shrink-0 flex-col items-center justify-center"/);
  assert.match(source, /className="h-10 w-full self-center justify-center rounded-\[8px\] border border-transparent bg-transparent px-0 text-foreground\/60 shadow-none transition-colors hover:bg-black\/8 hover:text-foreground dark:hover:bg-white\/10"/);
  assert.match(source, /<ChevronLeft className="-translate-x-px size-3" \/>/);
  assert.match(source, /<ChevronRight className="translate-x-px size-3" \/>/);
  assert.match(source, /className="block h-10 w-3\.5 shrink-0"/);
  assert.match(source, /className="grid min-w-0 gap-4"/);
  assert.match(source, /key=\{`page-\$\{currentPage\}`\}/);
  assert.match(source, /currentPageWorkspaces\.map\(\(workspace\) => \(/);
  assert.doesNotMatch(source, /transform: `translateX/);
  assert.doesNotMatch(source, /pagedWorkspaces\.map\(\(pageWorkspaces, pageIndex\) => \(/);
  assert.match(source, /pageCount > 1 \?/);
  assert.match(source, /aria-label="Previous control center page"/);
  assert.match(source, /canPageBackward \? \(/);
  assert.match(source, /onClick=\{\(\) => navigatePage\(-1\)\}/);
  assert.match(source, /\) : \(\s*<span className="block h-10 w-3\.5 shrink-0" \/>\s*\)/);
  assert.match(source, /aria-label="Next control center page"/);
  assert.match(source, /canPageForward \? \(/);
  assert.match(source, /onClick=\{\(\) => navigatePage\(1\)\}/);
  assert.match(source, /className="relative flex h-6 shrink-0 items-center justify-center pb-1"/);
  assert.match(source, /className="pointer-events-none flex items-center gap-1 rounded-full border border-border\/60 bg-background\/82 px-1\.5 py-0\.5 shadow-sm backdrop-blur-sm"/);
  assert.match(source, /Array\.from\(\{ length: pageCount \}, \(_, pageIndex\) => \(/);
  assert.match(source, /aria-label=\{`Go to control center page \$\{pageIndex \+ 1\}`\}/);
  assert.match(source, /aria-pressed=\{pageIndex === currentPage\}/);
  assert.match(source, /onClick=\{\(\) => setCurrentPage\(pageIndex\)\}/);
  assert.doesNotMatch(source, /absolute inset-y-0 left-0 right-0/);
});

test("workspace control center recency ignores main-session touch timestamps", async () => {
  const source = await readFile(WORKSPACE_CONTROL_CENTER_PATH, "utf8");

  assert.match(source, /function lastActivityFromSnapshot\(params: \{/);
  assert.doesNotMatch(source, /mainSessionUpdatedAt:/);
  assert.match(source, /return lastMessageAt \|\| params\.fallbackActivityAt;/);
  assert.doesNotMatch(source, /activityByWorkspaceId/);
  assert.doesNotMatch(source, /onActivityAtChange/);
});
