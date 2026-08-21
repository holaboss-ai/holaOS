import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane", "index.tsx");
const conversationTurnsSourcePath = path.join(
  __dirname,
  "ChatPane",
  "ConversationTurns.tsx",
);
const assistantTurnSourcePath = path.join(
  __dirname,
  "ChatPane",
  "AssistantTurn",
  "index.tsx",
);
const chatHeaderSourcePath = path.join(__dirname, "ChatPane", "ChatHeader.tsx");

/** Read any file under src/ by repo-relative path.
 *
 *  These guards assert the pane DOES something. They were written when ChatPane
 *  was one file, so they all read index.tsx; as it was split into modules the
 *  behaviour stayed put and the assertions started failing on location alone.
 *  Each one below now reads whichever module actually holds its subject. */
async function readSourceFile(relativePath) {
  return readFile(path.join(__dirname, "..", "..", relativePath), "utf8");
}

test("chat pane surfaces workspace activation errors before generic app-starting copy", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const \{[\s\S]*workspaceBlockingReason,\s*workspaceErrorMessage,\s*refreshWorkspaceData,[\s\S]*\} = useWorkspaceDesktop\(\);/,
  );
  // The precedence is the point: a specific blocking reason, then the
  // activation error, and only then the generic "still starting" copy.
  assert.match(
    source,
    /const readinessMessage =[\s\S]*workspaceBlockingReason \|\|[\s\S]*workspaceErrorMessage \|\|[\s\S]*"Preparing workspace apps\.\.\."[\s\S]*"Workspace apps are still starting\."/,
  );
});

test("chat model picker hides holaboss models while signed out and only marks them pending after sign-in", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /filter\(\s*\(providerGroup\) =>\s*isSignedIn \|\| !isHolabossProviderId\(providerGroup\.providerId\),?\s*\)/,
  );
  assert.match(
    source,
    /pending:\s*isSignedIn &&\s*isHolabossProviderId\(providerGroup\.providerId\)\s*&&\s*!holabossProxyModelsAvailable/,
  );
  assert.match(source, /disabled: providerGroup\.pending/);
  assert.match(
    source,
    /statusLabel: providerGroup\.pending \? "Pending" : undefined/,
  );
  assert.match(
    source,
    /Managed models are finishing setup\. Refresh runtime binding or use another provider\./,
  );
});

test("chat model picker still renders pending signed-in holaboss options without collapsing back to provider setup", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /const displayLabel =[\s\S]*selectedModelLabel \|\| "Select model"/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const noAvailableModels =\s*!runtimeDefaultModelAvailable &&\s*modelOptions\.length === 0 &&\s*modelOptionGroups\.length === 0;/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /disabled=\{optionDisabled\}/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /option\.statusLabel/);
});

test("chat pane shows provider setup CTA when no chat models are available", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /Sign in or set a runtime user id first\./);
  assert.match(source, /No models available\. Configure a provider to start chatting\./);
  assert.match(
    source,
    /const requiresModelProviderSetup =\s*!hasConfiguredProviderCatalog && !holabossProxyModelsAvailable;/,
  );
  assert.match(
    source,
    /const availableChatModelOptions = hasConfiguredProviderCatalog[\s\S]*requiresModelProviderSetup[\s\S]*\?\s*\[]/,
  );
  assert.match(
    source,
    /onOpenModelProviders=\{\(\) =>[\s\S]*window\.electronAPI\.ui\.openSettingsPane\(\s*"byok",?\s*\)[\s\S]*\}/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /aria-label="Configure model providers"/);
  // The CTA moved into the composer and changed icon and copy; the
  // aria-label is what actually has to hold.
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /aria-label="Configure model providers"[\s\S]*<Wand2 className="size-3\.5 text-muted-foreground" \/>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /\{compactComposerControls[\s\S]*\? "Providers"[\s\S]*: "Set up providers"\}/,
  );
  assert.doesNotMatch(source, /title=\{modelSelectionUnavailableReason\}/);
  assert.doesNotMatch(
    source,
    /disabled=\{isResponding \|\| noAvailableModels\}[\s\S]*<option value=\{CHAT_MODEL_USE_RUNTIME_DEFAULT\}>\{modelSelectionUnavailableReason\}<\/option>/,
  );
  assert.doesNotMatch(source, /if \(!resolvedUserId\) \{/);
});

test("chat pane falls back to provider setup instead of holaboss pending state when signed out", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const hasPendingConfiguredProviderCatalog =\s*visibleConfiguredProviderModelGroups\.some\(/,
  );
  assert.match(
    source,
    /const modelSelectionUnavailableReason =[\s\S]*hasPendingConfiguredProviderCatalog[\s\S]*"Managed models are finishing setup\. Refresh runtime binding or use another provider\."[\s\S]*"No models available\. Configure a provider to start chatting\."/,
  );
  assert.match(
    source,
    /const requiresModelProviderSetup =\s*!hasConfiguredProviderCatalog && !holabossProxyModelsAvailable;/,
  );
});

test("chat pane preserves the Auto model preference when configured providers are available", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const modelPreferenceAvailable = hasConfiguredProviderCatalog[\s\S]*normalizedModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT[\s\S]*runtimeDefaultModelAvailable/,
  );
  assert.match(
    source,
    /const resolvedChatModel = hasConfiguredProviderCatalog[\s\S]*effectiveChatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT[\s\S]*runtimeDefaultModelAvailable[\s\S]*runtimeDefaultModel/,
  );
});

test("chat pane previews image attachments from both staged paths and local files", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{ createPortal, flushSync \} from "react-dom";/);
  assert.match(
    source,
    /const \[imageAttachmentPreview, setImageAttachmentPreview\] =\s*useState<ImageAttachmentPreviewState \| null>\(null\);/,
  );
  assert.match(
    source,
    /onImageAttachmentPreviewOpenChange\?: \(open: boolean\) => void;/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"), /function ImageAttachmentPreviewModal\(/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/AttachmentList.tsx"),
    /attachment\.kind === "image" &&[\s\S]*Boolean\(onPreview\)[\s\S]*attachment\.file[\s\S]*attachment\.workspace_path/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/AttachmentList.tsx"), /aria-label=\{`Preview \$\{attachment\.name\}`\}/);
  assert.match(source, /URL\.createObjectURL\(attachment\.file\)/);
  assert.match(
    source,
    /window\.electronAPI\.fs\.readFilePreview\(\s*attachmentPath,\s*selectedWorkspaceId,\s*\)/,
  );
  assert.match(
    source,
    /onImageAttachmentPreviewOpenChange\?\.\(Boolean\(imageAttachmentPreview\)\);/,
  );
  assert.match(
    source,
    /<ImageAttachmentPreviewModal[\s\S]*open=\{Boolean\(imageAttachmentPreview\)\}[\s\S]*preview=\{imageAttachmentPreview\}[\s\S]*onClose=\{closeImageAttachmentPreview\}/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"), /const showImage = !preview\.isLoading && !preview\.errorMessage;/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"),
    /className="absolute inset-0 bg-black\/70 backdrop-blur-\[2px\]"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"),
    /className="relative z-10 flex max-h-\[calc\(100vh-64px\)\] flex-col overflow-hidden rounded-2xl border border-white\/10 bg-background shadow-2xl"/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"), /style=\{\{ maxWidth: "92vw" \}\}/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"),
    /className="block h-auto w-auto rounded-lg ring-1 ring-black\/8"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"),
    /maxWidth: "calc\(92vw - 32px\)",[\s\S]*maxHeight: "calc\(88vh - 128px\)"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/ImageAttachmentPreviewModal.tsx"),
    /return createPortal\(modalContent, document\.body\);/,
  );
});

test("chat composer footer wraps controls based on available pane width instead of viewport breakpoints", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/constants.ts"),
    /const COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX = 240;/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /const syncComposerFooterLayout = \(\) => \{/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /const footerStyle = window\.getComputedStyle\(footer\);/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const horizontalPadding =[\s\S]*footerStyle\.paddingLeft[\s\S]*footerStyle\.paddingRight/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const width = Math\.max\(\s*0,\s*Math\.round\(footer\.clientWidth - horizontalPadding\),\s*\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const composerFooterLayoutSyncFrameRef = useRef<number \| null>\(null\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const cancelComposerFooterLayoutSync = \(\) => \{[\s\S]*window\.cancelAnimationFrame\(composerFooterLayoutSyncFrameRef\.current\);[\s\S]*composerFooterLayoutSyncFrameRef\.current = null;[\s\S]*\};/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const scheduleComposerFooterLayoutSync = \(\) => \{[\s\S]*window\.requestAnimationFrame\(\s*\(\) => \{[\s\S]*syncComposerFooterLayout\(\);[\s\S]*\},\s*\);[\s\S]*\};/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const resizeObserver = new ResizeObserver\(\(\) => \{\s*scheduleComposerFooterLayoutSync\(\);\s*\}\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const compactComposerControls =\s*showModelSelector &&[\s\S]*composerFooterLayout\.width > 0[\s\S]*composerFooterLayout\.actionsWidth > 0[\s\S]*composerFooterLayout\.width < fullFooterControlWidth/,
  );
  assert.doesNotMatch(source, /composerFooterLayout\.wraps/);
  assert.doesNotMatch(source, /Array\.from\(footer\.children\)/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const compactModelControlWidth = compactComposerControls[\s\S]*COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX[\s\S]*compactFooterControlWidth -[\s\S]*COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const compactThinkingControlWidth = showThinkingValueSelector[\s\S]*COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX[\s\S]*compactFooterControlWidth - compactModelControlWidth/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /compact=\{compactComposerControls\}/,
  );
  assert.doesNotMatch(source, /sm:w-\[208px\]/);
});

test("chat pane blocks overlapping older-history loads before state commits", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /function setIsLoadingOlderHistoryState\(nextValue: boolean\)/,
  );
  assert.match(
    source,
    /isLoadingHistory \|\|\s*isLoadingOlderHistoryRef\.current \|\|\s*pendingHistoryPrependRestoreRef\.current \|\|/,
  );
  assert.match(
    source,
    /setIsLoadingOlderHistoryState\(true\);[\s\S]*finally \{[\s\S]*setIsLoadingOlderHistoryState\(false\);[\s\S]*isLoadingOlderHistoryRef\.current = false;/,
  );
});

test("chat pane does not adopt unmatched done or error stream frames and refreshes after matching done", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /action: "adopt_stream_for_done"/);
  assert.doesNotMatch(source, /action: "adopt_stream_for_error"/);
  assert.match(
    source,
    // The refresh now carries the committed turn's id so the ladder waits for it
    // to be queryable — without that the turn is dropped for ~350ms at the end
    // of every response (see refreshLadder.test.ts).
    /if \(payload\.type === "done"\) \{[\s\S]*const refreshSessionId = activeSessionIdRef\.current;[\s\S]*action: "applied_done"[\s\S]*if \(refreshSessionId && selectedWorkspaceId\) \{[\s\S]*scheduleConversationRefresh\(refreshSessionId, selectedWorkspaceId, \{\s*awaitAssistantMessageId: committedAssistantMessage,\s*\}\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /if \(payload\.type === "error"\) \{[\s\S]*action: "drop_error_unmatched_stream"[\s\S]*return;[\s\S]*setChatErrorMessage\(payload\.error \|\| "The agent stream failed\."\)/,
  );
  assert.match(source, /const delays = \[150, 500, 1_500, 3_000\];/);
});

test("chat pane opens a targeted postqueue stream for normal sends", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /eventType: "stream_open_prequeue"/);
  assert.match(
    source,
    /if \(!queueOntoActiveRun\) \{[\s\S]*pendingInputIdRef\.current = queued\.input_id;[\s\S]*openSessionOutputStream\(\{[\s\S]*sessionId: queued\.session_id,[\s\S]*workspaceId: selectedWorkspace\.id,[\s\S]*inputId: queued\.input_id,[\s\S]*includeHistory: true,[\s\S]*stopOnTerminal: true,[\s\S]*\}\)/,
  );
  assert.match(source, /eventType: "stream_open_postqueue"/);
  assert.match(source, /pauseDisabled=\{isSubmittingMessage\}/);
});

test("chat composer switches model and thinking selectors into icon-led compact triggers", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/helpers.ts"), /function compactComposerModelLabel\(label: string\)/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ThinkingValueSelect.tsx"), /function displayThinkingValueLabel\(value: string\)/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /const compactLabel = compactComposerModelLabel\(displayLabel\);/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"),
    /compact \? \(\s*<>\s*<span className="flex min-w-0 items-center gap-1\.5">[\s\S]*<ProviderBrandIcon[\s\S]*<span className="truncate">\{compactLabel\}<\/span>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/ThinkingValueSelect.tsx"),
    /const selectedThinkingLabel = displayThinkingValueLabel\(\s*selectedThinkingValue,\s*\);/,
  );
  assert.match(await readSourceFile("components/harness/ChannelModelPicker.tsx"), /const \[open, setOpen\] = useState\(false\);/);
  assert.match(
    await readSourceFile(
      "components/panes/ChatPane/Composer/ThinkingValueSelect.tsx",
    ),
    /aria-label=\{\s*compact\s*\? `Reasoning effort: \$\{selectedThinkingLabel\}`\s*: undefined\s*\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/ThinkingValueSelect.tsx"),
    /<PopoverContent[\s\S]*align="start"[\s\S]*side="top"[\s\S]*sideOffset=\{8\}[\s\S]*className="max-w-40 gap-0 rounded-lg p-1 shadow-xs ring-0"[\s\S]*Reasoning effort[\s\S]*thinkingValues\.map\(\(value\) => renderOption\(value\)\)/,
  );
});

test("chat phase mapping still defines claimed and started bootstrap steps", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /if \(eventType === "run_claimed"\) \{/);
  assert.match(source, /title: "Checking workspace context"/);
  assert.match(source, /if \(eventType === "run_started"\) \{/);
  assert.match(source, /title: "Running"/);
});

test("chat pane persists terminal run failures in-thread when no assistant text was emitted", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /type ChatAssistantSegment =/);
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /tone\?: "default" \| "error";/);
  assert.match(
    source,
    /const liveAssistantSegmentsRef = useRef<ChatAssistantSegment\[]>\(\[]\);/,
  );
  assert.match(
    source,
    /function commitLiveAssistantMessage\(options\?: \{\s*fallbackText\?: string;\s*tone\?: ChatMessage\["tone"\];\s*\}\)/,
  );
  assert.match(
    source,
    /if \(options\?\.fallbackText && !hasOutputSegment\) \{\s*nextSegments = appendAssistantOutputSegment\(\s*nextSegments,\s*options\.fallbackText,\s*options\.tone \?\? "default",\s*\);\s*\}/,
  );
  assert.match(
    source,
    /const shouldPersistFailureText =\s*!liveAssistantTextRef\.current &&\s*!assistantSegmentsIncludeOutput\(liveAssistantSegmentsRef\.current\);\s*const committedFailureMessage = commitLiveAssistantMessage\(\{\s*fallbackText: shouldPersistFailureText \? detail : undefined,\s*tone: shouldPersistFailureText \? "error" : "default",\s*\}\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /segment\.tone === "error" \? \(\s*<ErrorSegment key=\{`output-\$\{index\}`\} text=\{segment\.text\} \/>/,
  );
});

test("chat history reconstructs failed turns even when no assistant history message exists", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/helpers.ts"),
    /export function inputIdFromHistoryMessage\(/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/helpers.ts"),
    /function turnInputIdsFromHistoryMessages\(/,
  );
  assert.match(source, /const assistantInputIds = turnInputIdsFromHistoryMessages\(historyMessages\);/);
  assert.match(source, /const assistantHistoryInputIds = new Set\(params\.knownAssistantInputIds \?\? \[\]\);/);
  assert.match(
    source,
    /if \(restoredAssistantState\.segments\) \{[\s\S]*nextMessage\.segments = restoredAssistantState\.segments;[\s\S]*nextMessage\.text = "";[\s\S]*nextMessage\.executionItems = undefined;[\s\S]*\} else if \(restoredAssistantState\.executionItems\) \{[\s\S]*nextMessage\.executionItems =[\s\S]*restoredAssistantState\.executionItems;[\s\S]*\}/,
  );
  assert.match(
    source,
    /nextMessage\.role === "user" &&[\s\S]*!assistantHistoryInputIds\.has\(userInputId\)/,
  );
  assert.match(
    source,
    /const syntheticAssistantMessage: ChatMessage = \{\s*id: `assistant-\$\{userInputId\}`,[\s\S]*segments: restoredAssistantState\.segments,[\s\S]*executionItems:\s*restoredAssistantState\.segments\s*\?\s*undefined\s*:\s*restoredAssistantState\.executionItems,/,
  );
});

test("chat pane keeps compaction restore inside bootstrap status instead of a standalone phase card", async () => {
  const [source, assistantTurnSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(assistantTurnSourcePath, "utf8"),
  ]);

  assert.match(
    source,
    /eventType === "run_claimed" \|\|\s*eventType === "compaction_restored" \|\|\s*eventType === "run_started"[\s\S]*setLiveAgentStatus\("Checking workspace context"\);/,
  );
  assert.match(
    source,
    /function shouldShowBootstrapPhaseTraceForSession\(\s*sessionId: string \| null \| undefined,\s*\)\s*\{\s*void sessionId;\s*return false;\s*\}/,
  );
  assert.match(
    source,
    /showBootstrapPhaseTrace:\s*shouldShowBootstrapPhaseTraceForSession\(sessionId\),/,
  );
  assert.match(
    source,
    /function isBootstrapPhaseTraceStepId\(stepId: string\)\s*\{[\s\S]*stepId === "phase:run-claimed"[\s\S]*stepId === "phase:run-started"[\s\S]*\}/,
  );
  assert.match(
    source,
    /isBootstrapPhaseTraceStepId\(phaseStep\.id\) &&\s*options\?\.showBootstrapPhaseTrace !== true/,
  );
  assert.match(
    source,
    /!isBootstrapPhaseTraceStepId\(phaseStep\.id\) \|\|\s*shouldShowBootstrapPhaseTraceForSession\(eventSessionId\)/,
  );
  assert.match(
    assistantTurnSource,
    /normalizedStatus\.toLowerCase\(\) === "checking workspace context"[\s\S]*\?\s*"Working"\s*:\s*normalizedStatus;/,
  );
  assert.doesNotMatch(source, /Preparing workspace context\.\.\./);
  assert.doesNotMatch(source, /title:\s*"Restored compacted context"/);
  assert.doesNotMatch(source, /id:\s*"phase:compaction-restored"/);
});

test("chat pane renders a live status line with a motion indicator", async () => {
  // The hand-rolled keyframe dots became a shared glyph, but the line still
  // has to announce itself and drop out when there is nothing to say.
  const status = await readSourceFile(
    "components/panes/ChatPane/AssistantTurn/status.tsx",
  );

  assert.match(status, /export function LiveStatusEllipsis\(\)/);
  assert.match(status, /export function LiveStatusLine\(\{/);
  assert.match(status, /aria-live="polite"/);
  assert.match(
    status,
    /const normalizedLabel = label\.replace\(\/\\\.\+\$\/, ""\)\.trim\(\);\s*if \(!normalizedLabel\) \{\s*return null;\s*\}/,
  );
  assert.match(status, /<LiveStatusEllipsis \/>\s*<span>\{normalizedLabel\}<\/span>/);
});

test("chat pane polling can clear a stale stream after runtime reaches terminal state", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /"runtime_poll_terminal_state"/);
  assert.match(
    source,
    /const activeStreamId = activeStreamIdRef\.current;[\s\S]*closeStreamWithReason\([\s\S]*activeStreamId,[\s\S]*"runtime_poll_terminal_state"/,
  );
  assert.match(
    source,
    /status === "WAITING_USER" \|\| status === "PAUSED"[\s\S]*commitLiveAssistantMessage\(\);[\s\S]*scheduleConversationRefresh\(\s*normalizedCurrentSessionId,\s*selectedWorkspaceId,?\s*\);/,
  );
  assert.match(
    source,
    /const attachPendingWithoutStream = Boolean\(\s*pendingInputId && !activeStreamId,\s*\);[\s\S]*if \(attachPendingWithoutStream\) \{\s*return;\s*\}/,
  );
});

test("chat pane renders an execution timeline that interleaves thinking segments with trace entries", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /type ChatAssistantSegment =/);
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /executionItems\?: ChatExecutionTimelineItem\[];/);
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /segments\?: ChatAssistantSegment\[];/);
  assert.match(source, /function appendAssistantOutputSegment\(/);
  assert.match(source, /function appendAssistantExecutionSegment\(/);
  assert.match(source, /function upsertAssistantExecutionTraceStep\(/);
  assert.match(source, /function finalizeAssistantExecutionSegments\(/);
  assert.match(source, /function liveAssistantSegmentsForRender\(/);
  assert.match(source, /function appendExecutionTimelineThinkingDelta\(/);
  assert.match(source, /function mergeTraceStep\(/);
  assert.match(source, /function upsertExecutionTimelineTraceItem\(/);
  assert.match(
    source,
    /function mergeTraceStep\([\s\S]*const incomingIsNewer =[\s\S]*incoming\.order > existing\.order[\s\S]*incoming\.order === existing\.order[\s\S]*traceStepStatusRank\(incoming\.status\)[\s\S]*traceStepStatusRank\(existing\.status\)/,
  );
  assert.match(
    source,
    /function upsertExecutionTimelineTraceItem\([\s\S]*step: mergeTraceStep\(item\.step, step\)/,
  );
  assert.match(source, /function traceStepsFromExecutionItems\(items: ChatExecutionTimelineItem\[]\)/);
  assert.match(source, /assistantHistoryStateFromOutputEvents[\s\S]*flushOutputSegment\(\);[\s\S]*executionItems = appendExecutionTimelineThinkingDelta\(/);
  assert.match(source, /assistantHistoryStateFromOutputEvents[\s\S]*const nextSegments = upsertAssistantExecutionTraceStep\(\s*segments,\s*phaseStep,\s*\);[\s\S]*if \(nextSegments\) \{\s*segments = nextSegments;\s*\} else \{\s*executionItems = upsertExecutionTimelineTraceItem\(/);
  assert.match(source, /assistantHistoryStateFromOutputEvents[\s\S]*const nextSegments = upsertAssistantExecutionTraceStep\(\s*segments,\s*toolStep,\s*\);[\s\S]*if \(nextSegments\) \{\s*segments = nextSegments;\s*\} else \{\s*executionItems = upsertExecutionTimelineTraceItem\(/);
  assert.match(source, /assistantHistoryStateFromOutputEvents[\s\S]*if \(event\.event_type === "output_delta"\) \{\s*flushExecutionSegment\(\);/);
  assert.match(source, /assistantHistoryStateFromOutputEvents[\s\S]*segments = finalizeAssistantExecutionSegments\(/);
  assert.match(source, /appendLiveThinkingDelta\(delta: string, order: number\) \{\s*flushLiveAssistantOutputSegment\(\);/);
  assert.match(source, /appendLiveAssistantDelta\(delta: string\) \{\s*flushLiveExecutionSegment\(\);/);
  assert.match(source, /function upsertLiveTraceStep\(step: ChatTraceStep\) \{\s*flushLiveAssistantOutputSegment\(\);[\s\S]*const nextSegments = upsertAssistantExecutionTraceStep\(\s*liveAssistantSegmentsRef\.current,\s*step,\s*\);[\s\S]*if \(nextSegments\) \{\s*setLiveAssistantSegmentsState\(nextSegments\);\s*return;\s*\}/);
  assert.match(source, /function finalizeLiveTraceSteps\([\s\S]*setLiveAssistantSegmentsState\(\s*finalizeAssistantExecutionSegments\(\s*liveAssistantSegmentsRef\.current,\s*status,\s*\),\s*\);/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/status.tsx"),
    /function ExecutionTimelineThinkingEntry[\s\S]*className="chat-markdown chat-thinking-markdown max-w-full text-foreground"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/ConversationTurns.tsx"),
    /<AssistantTurn[\s\S]*segments=\{message\.segments \?\? NO_SEGMENTS\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/ConversationTurns.tsx"),
    /<AssistantTurn[\s\S]*segments=\{liveAssistantTurn\.segments\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /\{renderedSegments\.map\(\(segment, index\) =>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /segment\.kind === "execution" \?\s*\(\s*<TraceStepGroup/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/TraceStepGroup.tsx"),
    /<ExecutionTimelineThinkingEntry/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/TraceStepGroup.tsx"),
    /<TraceTimelineStepEntry/,
  );
  assert.doesNotMatch(source, /<ThinkingPanel/);
  assert.doesNotMatch(source, /thinkingCollapsed/);
  assert.doesNotMatch(source, /onToggleThinking/);
});

test("main-session assistant turns keep execution internals visible in the main chat pane", async () => {
  const [source, conversationTurnsSource, assistantTurnSource] =
    await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(conversationTurnsSourcePath, "utf8"),
      readFile(assistantTurnSourcePath, "utf8"),
    ]);

  assert.match(
    source,
    /function shouldShowExecutionInternalsForSession\(\s*sessionId: string \| null \| undefined,\s*\)\s*\{\s*void sessionId;\s*return true;\s*\}/,
  );
  assert.match(
    source,
    /const showSessionExecutionInternals =\s*shouldShowExecutionInternalsForSession\(activeSessionId\);/,
  );
  assert.match(
    source,
    /<ConversationTurns[\s\S]*showExecutionInternals=\{\s*showSessionExecutionInternals\s*\}/,
  );
  assert.match(
    conversationTurnsSource,
    /<AssistantTurn[\s\S]*showExecutionInternals=\{showExecutionInternals\}[\s\S]*text=\{message\.text\}/,
  );
  assert.match(
    conversationTurnsSource,
    /<AssistantTurn[\s\S]*showExecutionInternals=\{showExecutionInternals\}[\s\S]*text=\{liveAssistantTurn\.text\}/,
  );
  assert.match(assistantTurnSource, /showExecutionInternals = true,/);
  assert.match(assistantTurnSource, /showExecutionInternals\?: boolean;/);
  assert.match(
    assistantTurnSource,
    /const normalizedStatus = \(\s*showExecutionInternals \? status : status \? "Working" : ""\s*\)/,
  );
  assert.match(
    assistantTurnSource,
    /const visibleSegments = showExecutionInternals[\s\S]*segments\.filter\([\s\S]*segment\.kind === "output"/,
  );
  assert.match(
    assistantTurnSource,
    /const visibleExecutionItems = showExecutionInternals \? executionItems : \[\];/,
  );
  assert.match(
    source,
    /function hasRenderableAssistantTurn\(\s*message: ChatMessage,\s*options\?: \{ showExecutionInternals\?: boolean \},/,
  );
  assert.match(
    source,
    /const hasExecutionOnlyContent =[\s\S]*segment\.kind === "execution" && segment\.items\.length > 0[\s\S]*\(message\.executionItems\?\.length \?\? 0\) > 0;/,
  );
  assert.match(
    source,
    /\(showExecutionInternals && hasExecutionOnlyContent\)/,
  );
  assert.match(
    source,
    /const displayMessages = useMemo\([\s\S]*hasRenderableAssistantTurn\(message,\s*\{\s*showExecutionInternals: showSessionExecutionInternals,\s*\}\)/,
  );
  assert.match(source, /function syntheticAssistantMessageFromSessionTurn\(params: \{/);
  assert.match(
    source,
    /Array\.from\(\s*new Set\(\[\.\.\.outputEventsByInputId\.keys\(\), \.\.\.outputsByInputId\.keys\(\)\]\),\s*\)\s*\.filter\(\(inputId\) => inputId && !historyTurnInputIds\.has\(inputId\)\)/,
  );
});

test("chat pane no longer sends native desktop notifications directly for main-session completions", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /function maybeRememberMainSessionCompletionNotification\(inputId: string\)/);
  assert.doesNotMatch(source, /function maybeShowMainSessionCompletionNotification\(params: \{/);
  assert.doesNotMatch(source, /Reply ready/);
});

test("chat pane plays a local chime for active main-session completions", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function playMainSessionCompletionChime\(\)/);
  assert.match(source, /function maybePlayMainSessionCompletionChime\(params: \{/);
  assert.match(
    source,
    /eventType === "run_completed"[\s\S]*maybePlayMainSessionCompletionChime\(\{\s*sessionId: eventSessionId,\s*inputId: eventInputId,\s*terminalStatus: completedStatus,\s*\}\);/,
  );
  assert.match(
    source,
    /status === "ERROR"[\s\S]*else \{[\s\S]*maybePlayMainSessionCompletionChime\(\{\s*sessionId: normalizedCurrentSessionId,\s*inputId: currentRuntimeInputId,\s*completedAt: currentState\.last_turn_completed_at,/,
  );
  assert.match(
    source,
    /activeSessionReadOnlyRef\.current = activeSessionReadOnly;/,
  );
});

test("chat trace tool errors surface stderr text instead of a generic error label", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function extractToolErrorText\(payload: Record<string, unknown>\)/);
  assert.match(source, /const resultText = extractToolResultText\(payload\.result\);/);
  assert.match(source, /const toolErrorText = extractToolErrorText\(payload\);/);
  assert.match(source, /if \(isError && toolErrorText\) \{\s*details\.push\(toolErrorText\);/);
});

test("chat pane groups configured models under provider headings", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const availableChatModelOptionGroups: ChatModelOptionGroup\[] =[\s\S]*hasConfiguredProviderCatalog/,
  );
  assert.match(
    await readSourceFile("lib/chat/useChatComposerModelSelection.ts"),
    /selectedLabel: needsProviderPrefix[\s\S]*\? `\$\{providerGroup\.providerLabel\} · \$\{modelLabel\}`[\s\S]*: modelLabel/,
  );
  assert.match(
    source,
    /searchText: `\$\{providerGroup\.providerLabel\} \$\{modelLabel\} \$\{model\.token\}`/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /const filteredOptionGroups = useMemo\(/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"),
    /modelOptionGroups\.length > 0[\s\S]*\? modelOptionGroups[\s\S]*: \[\{ label: "", options: modelOptions }\]/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/ModelCombobox.tsx"), /group\.label \? \(/);
  assert.match(source, /text-\[10px\] font-medium uppercase text-muted-foreground/);
  assert.doesNotMatch(source, /filteredOptions\.map/);
});

test("chat pane does not suppress claude options for the holaboss proxy fallback path", async () => {
  const source = await readFile(sourcePath, "utf8");
  // CHAT_MODEL_PRESETS lives in ChatPane/constants.ts (re-exported into
  // index.tsx). Read it from there so the regex isn't silently matching
  // the empty string when the constant block isn't inlined here.
  const constantsSource = await readFile(
    path.join(__dirname, "ChatPane", "constants.ts"),
    "utf8",
  );
  const presetBlock =
    constantsSource.match(/const CHAT_MODEL_PRESETS = \[[\s\S]*?\] as const;/)
      ?.[0] ?? "";

  // Claude IS expected in CHAT_MODEL_PRESETS now — the fallback list should
  // surface both GPT and Claude families so users without a working holaboss
  // proxy still see their full provider options. The original "don't
  // suppress claude" intent (no isClaudeChatModel filter) is still enforced
  // by the !isClaudeChatModel doesNotMatch assertions below.
  assert.match(presetBlock, /anthropic\/claude-/);
  assert.match(presetBlock, /openai\/gpt-/);
  assert.match(source, /normalized\.startsWith\("google\/"\)/);
  assert.match(source, /normalized\.startsWith\("gemini-"\)/);
  assert.match(
    source,
    /const runtimeDefaultModelAvailable =[\s\S]*hasConfiguredProviderCatalog[\s\S]*visibleConfiguredProviderModelGroups\.some\([\s\S]*model\.token\.trim\(\) === runtimeDefaultModel[\s\S]*\)[\s\S]*: holabossProxyModelsAvailable \|\|[\s\S]*!isHolabossProxyModel\(runtimeDefaultModel\)\);/,
  );
  assert.match(
    source,
    /holabossProxyModelsAvailable \|\| !isHolabossProxyModel\(model\)/,
  );
  assert.doesNotMatch(source, /function isClaudeChatModel\(model: string\)/);
  assert.doesNotMatch(source, /isUnsupportedHolabossProxyModel\(/);
  assert.doesNotMatch(source, /!isClaudeChatModel\(runtimeDefaultModel\)/);
  assert.doesNotMatch(source, /!isClaudeChatModel\(model\) &&/);
});

test("chat pane gates image attachments using model input modalities metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/helpers.ts"),
    /function supportsImageInput\([\s\S]*inputModalities\?: readonly string\[\] \| null,[\s\S]*\): boolean/,
  );
  assert.match(
    source,
    /const selectedInputModalities = selectedConfiguredModel[\s\S]*\?\s*\(selectedConfiguredModel\.inputModalities \?\? \[\]\)[\s\S]*:\s*\(selectedFallbackModelMetadata\?\.inputModalities \?\? \[\]\);/,
  );
  assert.match(
    source,
    /const selectedModelSupportsImageInput = supportsImageInput\(\s*selectedInputModalities,\s*\);/,
  );
  assert.match(
    source,
    /pendingAttachmentIsImage\(attachment\)/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/helpers.ts"),
    /attachment\.kind === "image" \|\|[\s\S]*attachmentLooksLikeImage\(attachment\.name,\s*attachment\.mime_type\)/,
  );
  assert.match(
    source,
    /const pendingImageInputUnsupportedMessage =[\s\S]*Remove the attached image or switch models\./,
  );
  assert.match(
    source,
    /if \(pendingImageInputUnsupportedMessage\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /submitDisabled=\{Boolean\([\s\S]*pendingImageInputUnsupportedMessage[\s\S]*\)\}/,
  );
});

test("chat composer can paste clipboard file and image attachments into the pending attachment flow", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /function normalizeClipboardAttachmentFile\(file: File, index: number\): File/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const baseName = file\.type\.startsWith\("image\/"\)\s*\?\s*`pasted-image-\$\{index \+ 1\}`\s*:\s*`pasted-file-\$\{index \+ 1\}`;/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /function clipboardFilesFromDataTransfer\(\s*dataTransfer: DataTransfer \| null,\s*\): File\[\]/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /function fileFromClipboardImagePayload\(\s*payload: ClipboardImagePayload \| null,\s*\): File \| null/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /window\.electronAPI\.clipboard\.readImage\(\)/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /function explorerAttachmentFilesFromClipboardText\(\s*clipboardText: string,\s*\): ExplorerAttachmentDragPayload\[\]/);
  assert.match(await readSourceFile("components/panes/ChatPane/Composer/index.tsx"), /getExplorerAttachmentClipboardEntry\(\)/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /dataTransfer\.files\.length > 0\s*\?\s*Array\.from\(dataTransfer\.files\)/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const handleEditorPaste = \(event: ClipboardEvent\): boolean => \{/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const pastedFiles = clipboardFilesFromDataTransfer\(event\.clipboardData\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const explorerFiles =\s*explorerAttachmentFilesFromClipboardText\(clipboardText\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /onAddExplorerAttachments\(explorerFiles\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const hasClipboardImageType = clipboardTypes\.some\(/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /clipboardImageFileFromElectronClipboard\(\)/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /onAddDroppedFiles\(\[file\]\);/,
  );
  assert.match(source, /event\.preventDefault\(\);/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /onAddDroppedFiles\(pastedFiles\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /onPasteFiles=\{handleEditorPaste\}/,
  );
});

test("chat pane filters managed catalog entries that are not chat-capable", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function runtimeModelHasChatCapability\(model: RuntimeProviderModelPayload\)/);
  assert.match(source, /const capabilities = runtimeModelCapabilities\(model\);/);
  assert.match(source, /return capabilities.length === 0 \|\| capabilities.includes\("chat"\);/);
  assert.match(source, /if \(!runtimeModelHasChatCapability\(model\)\) \{\s*return false;\s*\}/);
});

test("chat pane routes run failures through the shared failure-text module", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The functions themselves moved to runFailureText.ts so they could be tested
  // behaviourally (ChatPane's module graph cannot be imported by a test).
  // runFailureText.test.ts owns the prefixing and wallet-block behaviour; this
  // only pins that the pane still uses them at both entry points.
  assert.match(source, /from "\.\/runFailureText"/);
  assert.match(source, /const errorText = runFailedDetail\(payload\);/);
  assert.match(source, /const detail = runFailedDetail\(eventPayload\);/);
  assert.match(source, /runtimeStateErrorDetail\(currentState\.last_error\)/);
});

test("chat pane stops rebuilding assistant history after the first terminal output event", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function isTerminalSessionOutputEventType\(eventType: string\)/);
  assert.match(source, /let encounteredTerminalEvent = false;/);
  assert.match(source, /if \(encounteredTerminalEvent\) \{\s*continue;\s*\}/);
  assert.match(
    source,
    /if \(isTerminalSessionOutputEventType\(event\.event_type\)\) \{\s*encounteredTerminalEvent = true;\s*\}/,
  );
});

test("chat pane ignores duplicate or conflicting terminal stream events for the same input", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const terminalEventTypeByInputIdRef = useRef<[\s\S]*new Map\(\)\);/,
  );
  assert.match(source, /function recordTerminalEventForInput\(/);
  assert.match(source, /terminalEventTypeByInputIdRef\.current\.clear\(\);/);
  assert.match(
    source,
    /const priorTerminalEventType = recordTerminalEventForInput\(\s*eventInputId,\s*"run_failed",\s*\);[\s\S]*action: "skip_terminal_after_terminal"/,
  );
  assert.match(
    source,
    /const priorTerminalEventType = recordTerminalEventForInput\(\s*eventInputId,\s*"run_completed",\s*\);[\s\S]*action: "skip_terminal_after_terminal"/,
  );
});

test("chat pane binds in-flight stream attach to the current runtime input on session reload", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const currentRuntimeInputId = \(\s*currentRuntimeState\?\.current_input_id \|\| ""\s*\)\.trim\(\);/,
  );
  assert.match(
    source,
    /openSessionOutputStream\(\s*\{[\s\S]*inputId: currentRuntimeInputId \|\| undefined,[\s\S]*includeHistory: Boolean\(currentRuntimeInputId\),[\s\S]*stopOnTerminal: true,/,
  );
});

test("chat pane can create a workspace session when none exists yet", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /async function createWorkspaceSession\(\s*workspaceId: string,\s*parentSessionId\?: string \| null,[\s\S]*?\): Promise<string \| null>/,
  );
  assert.match(source, /window\.electronAPI\.workspace\.createAgentSession\(\{/);
  assert.match(source, /parent_session_id: parentSessionId\?\.trim\(\) \|\| null,/);
  assert.match(source, /const sessionId = created\.session\.session_id\.trim\(\);/);
  assert.doesNotMatch(
    source,
    /const resolvedSessionId =\s*nextSessionId \|\| \(await createWorkspaceSession\(selectedWorkspaceId\)\);/,
  );
  assert.match(
    source,
    /if \(!targetSessionId && selectedWorkspace\) \{[\s\S]*?pendingSessionTarget\?\.mode === "draft"\s*\? pendingSessionTarget\.parentSessionId\s*: draftParentSessionIdRef\.current;\s*targetSessionId = await createWorkspaceSession\(\s*selectedWorkspace\.id,\s*draftParentSessionId,/,
  );
});

test("chat pane keeps main-session controls without a sessions button", async () => {
  const source = await readFile(sourcePath, "utf8");
  const chatHeaderSource = await readFile(chatHeaderSourcePath, "utf8");

  assert.doesNotMatch(source, /onOpenSessions\?: \(\) => void;/);
  assert.match(source, /composerDraftText\?: string;/);
  assert.match(
    source,
    /onComposerDraftTextChange\?: \(text: string\) => void;/,
  );
  assert.match(source, /onSessionOpenRequestConsumed\?: \(requestKey: number\) => void;/);
  assert.match(source, /const \[localSessionOpenRequest, setLocalSessionOpenRequest\] =\s*useState<ChatPaneSessionOpenRequest \| null>\(null\);/);
  assert.match(
    source,
    /const \[input, setInput\] = useState\(\(\) => composerDraftText\);/,
  );
  assert.match(
    source,
    /const draftHydrationWorkspaceIdRef = useRef\(\s*\(selectedWorkspaceId \|\| ""\)\.trim\(\),?\s*\);/,
  );
  assert.match(
    source,
    /const skipNextComposerDraftPublishRef = useRef\(false\);/,
  );
  assert.match(
    source,
    /const localSessionOpenRequestRef =\s*useRef<ChatPaneSessionOpenRequest \| null>\(\s*null,?\s*\);/,
  );
  assert.match(source, /const effectiveSessionOpenRequest =\s*sessionOpenRequest \?\? localSessionOpenRequest;/);
  assert.match(
    source,
    /localSessionOpenRequestRef\.current = localSessionOpenRequest;/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*const normalizedWorkspaceId = \(selectedWorkspaceId \|\| ""\)\.trim\(\);[\s\S]*if \(draftHydrationWorkspaceIdRef\.current === normalizedWorkspaceId\) \{\s*return;\s*\}[\s\S]*draftHydrationWorkspaceIdRef\.current = normalizedWorkspaceId;[\s\S]*skipNextComposerDraftPublishRef\.current = true;[\s\S]*setInput\(\(current\) =>[\s\S]*current === composerDraftText \? current : composerDraftText,[\s\S]*\);[\s\S]*\}, \[composerDraftText, selectedWorkspaceId\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(skipNextComposerDraftPublishRef\.current\) \{[\s\S]*skipNextComposerDraftPublishRef\.current = false;[\s\S]*return;[\s\S]*\}[\s\S]*onComposerDraftTextChange\?\.\(input\);[\s\S]*\}, \[input, onComposerDraftTextChange\]\);/,
  );
  assert.match(source, /function setLocalSessionOpenRequestState\(/);
  assert.match(source, /const openMainSession = async \(\) => \{/);
  assert.match(source, /<ArrowLeft className="size-3" \/>\s*Main session/);
  assert.match(source, /<ArrowLeft className="size-3" \/>\s*Main session/);
  assert.match(source, /const handleOpenReadOnlyAgentSession = \(/);
  assert.match(source, /setLocalSessionOpenRequestState\(\{\s*sessionId: mainSessionId,\s*requestKey: Date\.now\(\),\s*readOnly: false,\s*\}\);/);
  assert.match(source, /setLocalSessionOpenRequestState\(\{\s*sessionId,\s*requestKey: Date\.now\(\),\s*readOnly: true,\s*\}\);/);
  assert.doesNotMatch(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.doesNotMatch(chatHeaderSource, /aria-label="Sessions"/);
  assert.match(source, /onSessionOpenRequestConsumed\?\.\(requestKey\);/);
});

test("chat pane syncs the shared file display from live file-oriented tool calls", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /onSyncFileDisplayFromAgentOperation\?: \(path: string\) => void;/,
  );
  assert.match(
    source,
    /function fileDisplaySyncTargetFromToolPayload\(\s*payload: Record<string, unknown>,\s*\): string \| null \{/,
  );
  assert.match(
    source,
    /const HASHLINE_SECTION_HEADER_PATTERN = \/\^¶\(\.\+\?\)\(\?:#\(\[0-9A-Fa-f\]\{3\}\)\)\?\$\/;/,
  );
  assert.match(
    source,
    /function hashlineSectionPathsFromEditInput\(input: string\): string\[] \{/,
  );
  assert.match(
    source,
    /function hashlineEditSyncTargetFromToolArgs\(value: unknown\): string \| null \{/,
  );
  assert.match(
    source,
    /const lastSyncedAgentOperationFileKeyRef = useRef\(""\);/,
  );
  assert.match(
    source,
    /toolName === "write_report" \|\| toolName === "image_generate"/,
  );
  assert.match(
    source,
    /syncableWorkspacePathFromRecord\(payload\.result,\s*\[\s*"file_path",\s*"path",\s*\]\)/,
  );
  assert.doesNotMatch(source, /toolName === "read" \|\| toolName === "edit"/);
  assert.match(source, /if \(toolName === "edit"\) \{/);
  assert.match(source, /hashlineEditSyncTargetFromToolArgs\(payload\.tool_args\)/);
  assert.match(source, /const argsSummary = extractToolTraceArgsSummary\(toolName, payload\);/);
  assert.match(source, /File: /);
  assert.match(
    source,
    /if \(eventType === "tool_call"\) \{\s*const fileDisplayTarget =\s*fileDisplaySyncTargetFromToolPayload\(eventPayload\);[\s\S]*if \(fileDisplayTarget && !activeSessionReadOnlyRef\.current\) \{/,
  );
});

test("chat pane keeps local picker session requests from overriding a newer shell session request", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const isExternalSessionOpenRequest = sessionOpenRequest !== null;/);
  assert.match(source, /const lastHandledExternalSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const lastHandledLocalSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(
    source,
    /const lastHandledSessionOpenRequestKeyRef = isExternalSessionOpenRequest\s*\?\s*lastHandledExternalSessionOpenRequestKeyRef\s*:\s*lastHandledLocalSessionOpenRequestKeyRef;/,
  );
  assert.match(
    source,
    /if \(!cancelled\) \{\s*if \(!historyLoaded\) \{\s*cancelHistoryViewportRestore\(\);\s*\}\s*endHistoryLoadSkeleton\(skeletonGeneration\);\s*consumeSessionOpenRequest\(requestKey\);\s*\}/,
  );
});

test("chat pane routes immediate sends through the newer pending session request instead of the previously active session", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const consumedSessionOpenRequestKeysRef = useRef<Set<number>>\(new Set\(\)\);/,
  );
  assert.match(source, /function consumeSessionOpenRequest\(requestKey: number\)/);
  assert.match(source, /function pendingSessionTargetForSend\(\): PendingSessionTarget \| null/);
  assert.match(
    source,
    /const currentSessionOpenRequest =\s*sessionOpenRequest \?\? localSessionOpenRequestRef\.current;/,
  );
  assert.match(
    source,
    /const pendingSessionTarget = pendingSessionTargetForSend\(\);[\s\S]*let targetSessionId =[\s\S]*pendingSessionTarget\?\.mode === "session"[\s\S]*activeSessionIdRef\.current;/,
  );
  assert.match(
    source,
    // clearSessionView now defers the blank here (keepMessages) so the canvas
    // is not empty for the whole session-creation round trip; the conversation
    // is swapped out when the send's own first message arrives.
    /if \(pendingSessionTarget\) \{\s*consumeSessionOpenRequest\(pendingSessionTarget\.requestKey\);[\s\S]*clearSessionView\(\{ keepMessages: true \}\);[\s\S]*setActiveSession\(pendingSessionTarget\.sessionId\);[\s\S]*draftParentSessionIdRef\.current = pendingSessionTarget\.parentSessionId;\s*setActiveSession\(null\);/,
  );
  assert.match(
    source,
    /if \(!targetSessionId && selectedWorkspace\) \{[\s\S]*?targetSessionId = await createWorkspaceSession\(\s*selectedWorkspace\.id,\s*draftParentSessionId,/,
  );
  assert.match(
    source,
    /if \(isSessionOpenRequestConsumed\(requestKey\)\) \{\s*consumeSessionOpenRequest\(requestKey\);\s*return;\s*\}\s*if \(requestKey === lastHandledSessionOpenRequestKeyRef\.current\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(cancelled \|\| isSessionOpenRequestConsumed\(requestKey\)\) \{\s*historyLoaded = true;\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(isSessionOpenRequestConsumed\(requestKey\)\) \{\s*consumeSessionOpenRequest\(requestKey\);\s*return;\s*\}/,
  );
});

test("chat pane mirrors composer draft text from shell state", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /composerDraftText\?: string;/);
  assert.match(
    source,
    /onComposerDraftTextChange\?: \(text: string\) => void;/,
  );
  assert.match(
    source,
    /const \[input, setInput\] = useState\(\(\) => composerDraftText\);/,
  );
  assert.match(
    source,
    /const draftHydrationWorkspaceIdRef = useRef\(\s*\(selectedWorkspaceId \|\| ""\)\.trim\(\),?\s*\);/,
  );
  assert.match(
    source,
    /const skipNextComposerDraftPublishRef = useRef\(false\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*const normalizedWorkspaceId = \(selectedWorkspaceId \|\| ""\)\.trim\(\);[\s\S]*if \(draftHydrationWorkspaceIdRef\.current === normalizedWorkspaceId\) \{\s*return;\s*\}[\s\S]*draftHydrationWorkspaceIdRef\.current = normalizedWorkspaceId;[\s\S]*skipNextComposerDraftPublishRef\.current = true;[\s\S]*setInput\(\(current\) =>[\s\S]*current === composerDraftText \? current : composerDraftText,[\s\S]*\);[\s\S]*\}, \[composerDraftText, selectedWorkspaceId\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(skipNextComposerDraftPublishRef\.current\) \{[\s\S]*skipNextComposerDraftPublishRef\.current = false;[\s\S]*return;[\s\S]*\}[\s\S]*onComposerDraftTextChange\?\.\(input\);[\s\S]*\}, \[input, onComposerDraftTextChange\]\);/,
  );
});

test("chat pane clears session-open requests only after the history restore flow settles", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The boolean loading flag became a generation-stamped skeleton, but the
  // ordering guarantee this guards — restore begins before the load — holds.
  assert.match(
    source,
    /let historyLoaded = false;\s*beginHistoryViewportRestore\(\);\s*const skeletonGeneration = beginHistoryLoadSkeleton\(\);/,
  );
  assert.match(
    source,
    /finally \{[\s\S]*if \(!cancelled\) \{[\s\S]*if \(!historyLoaded\) \{[\s\S]*cancelHistoryViewportRestore\(\);[\s\S]*\}[\s\S]*endHistoryLoadSkeleton\(skeletonGeneration\);[\s\S]*consumeSessionOpenRequest\(requestKey\);[\s\S]*\}[\s\S]*\}/,
  );
});

test("chat pane hides restored history until the viewport snaps to the latest message", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /useLayoutEffect/);
  assert.match(source, /const \[isHistoryViewportPending, setIsHistoryViewportPending\] =\s*useState\(false\);/);
  assert.match(
    source,
    /const \[\s*historyViewportRestoreGeneration,\s*setHistoryViewportRestoreGeneration,\s*\] = useState\(0\);/,
  );
  assert.match(source, /const historyViewportGenerationRef = useRef\(0\);/);
  assert.match(source, /function beginHistoryViewportRestore\(\)/);
  assert.match(source, /function requestHistoryViewportRestore\(\)/);
  assert.match(source, /function cancelHistoryViewportRestore\(\)/);
  assert.match(await readSourceFile("components/panes/ChatPane/skeletons.tsx"), /function HistoryRestoreSkeleton\(\)/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{[\s\S]*container\.scrollTo\(\{\s*top: container\.scrollHeight,\s*behavior: "auto",\s*\}\);[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*setIsHistoryViewportPending\(false\);[\s\S]*\}\);[\s\S]*\}, \[historyViewportRestoreGeneration, isHistoryViewportPending\]\);/,
  );
  assert.match(
    source,
    /behavior:\s*isResponding \|\|\s*isHistoryViewportPending \|\|\s*pendingPrefillBottomScrollRef\.current\s*\? "auto"\s*: "smooth"/,
  );
  assert.match(
    source,
    /const showHistoryRestoreScreen =\s*isLoadingHistory \|\| isHistoryViewportPending;/,
  );
  assert.match(source, /role="status"/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/skeletons.tsx"),
    /aria-label="Loading conversation"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/skeletons.tsx"),
    /animate-pulse/,
  );
  assert.match(source, /showHistoryRestoreScreen \? <HistoryRestoreSkeleton \/> : null/);
  assert.match(source, /showHistoryRestoreScreen \? "invisible" : ""/);
});

test("chat pane shows hosted billing warnings and blocks managed sends when credits are exhausted", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /useDesktopBilling/);
  assert.match(source, /selectedManagedProviderGroup\?\.kind === "holaboss_proxy"/);
  assert.match(source, /hasHostedBillingAccount/);
  assert.match(source, /Credits are running low\. Add more on web to avoid interruptions\./);
  assert.match(source, /You're out of credits for managed usage\./);
  assert.match(source, /Add credits/);
  assert.match(source, /Manage on web/);
  assert.match(source, /if \(isOutOfCredits\) \{/);
  assert.match(source, /void refreshBillingState\(\)\.catch\(\(\) => undefined\);/);
  assert.doesNotMatch(source, /await window\.electronAPI\.billing\.getOverview\(\)/);
});

test("chat composer does not submit on enter while IME composition is active", async () => {
  // The composer became a rich editor, so the guard moved into its keydown
  // handler — ahead of every other key branch, which is the whole point.
  const editor = await readSourceFile(
    "components/panes/ChatPane/Composer/editor/ComposerEditor.tsx",
  );

  assert.match(
    editor,
    /handleKeyDown: \(view, event\) => \{[\s\S]*?const native = event as KeyboardEvent & \{\s*isComposing\?: boolean;\s*keyCode\?: number;\s*\};\s*if \(native\.isComposing === true \|\| native\.keyCode === 229\) \{\s*return false;\s*\}/,
  );
});

test("chat turns render markdown and keep long content wrapped inside the bubble", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/layout/NotificationToastStack.tsx"), /import \{ SimpleMarkdown \} from "@\/components\/marketplace\/SimpleMarkdown";/);
  assert.match(source, /onOpenLinkInBrowser\?: \(url: string\) => void;/);
  assert.match(source, /onLinkClick=\{onOpenLinkInBrowser\}/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/UserTurn.tsx"),
    /<SimpleMarkdown[\s\S]*className="chat-markdown chat-user-markdown max-w-full"[\s\S]*onLinkClick=\{onLinkClick\}[\s\S]*<\/SimpleMarkdown>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /<SimpleMarkdown[\s\S]*className=\{`chat-markdown chat-assistant-markdown mt-2\.5 first:mt-0 max-w-full text-foreground\$\{[\s\S]*onLinkClick=\{onLinkClick\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/UserTurn.tsx"),
    /theme-chat-user-bubble inline-flex min-w-0 max-w-full/,
  );
});

test("user turns expose a hover footer with copy and timestamp metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/AssistantTurn/McpAuthorizeCard.tsx"), /createdAt\?: string;/);
  assert.match(await readSourceFile("components/panes/ChatPane/helpers.ts"), /function chatMessageTimeLabel\(value: string \| null \| undefined\): string/);
  assert.match(await readSourceFile("components/panes/ChatPane/UserTurn.tsx"), /navigator\.clipboard\?\.writeText/);
  assert.match(await readSourceFile("components/panes/ChatPane/UserTurn.tsx"), /document\.execCommand\("copy"\)/);
  assert.match(await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"), /const timeLabel = chatMessageTimeLabel\(createdAt\);/);
  assert.match(await readSourceFile("components/panes/ChatPane/UserTurn.tsx"), /className="group\/user-turn flex min-w-0 justify-end"/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/UserTurn.tsx"),
    /group-hover\/user-turn:opacity-100[\s\S]*group-hover\/user-turn:pointer-events-auto[\s\S]*group-focus-within\/user-turn:opacity-100/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/UserTurn.tsx"), /aria-label=\{\s*copyFeedbackVisible[\s\S]*"Copy user message"/);
  assert.match(await readSourceFile("components/layout/WindowsTitlebarControls.tsx"), /<Copy className="size-3\.5" strokeWidth=\{1\.9\} \/>/);
  assert.match(await readSourceFile("components/panes/ChatPane/AssistantTurn/ActionsMenu.tsx"), /<Check className="size-3\.5" strokeWidth=\{1\.9\} \/>/);
  assert.match(source, /createdAt: message\.created_at \|\| undefined,/);
  assert.match(source, /const queuedMessageCreatedAt = new Date\(\)\.toISOString\(\);/);
  assert.match(await readSourceFile("components/panes/ChatPane/ConversationTurns.tsx"), /createdAt=\{message\.createdAt\}/);
});

test("chat thread uses the full pane width for normal messages", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /messagesContentRef\}[\s\S]*\$\{\s*showHistoryRestoreScreen \? "invisible" : ""\s*\}`\}/);
  assert.match(source, /<form onSubmit=\{onSubmit\} className="w-full">/);
  // The user bubble is capped relative to the pane now (one clamp instead
  // of three breakpoint pins), so the thread itself keeps the full width.
  assert.match(
    await readSourceFile("components/panes/ChatPane/UserTurn.tsx"),
    /className="group\/user-turn flex min-w-0 justify-end"[\s\S]*max-w-\[min\(75%,40rem\)\]/,
  );
  assert.doesNotMatch(source, /messagesContentRef\}[\s\S]*max-w-\[800px\]/);
  assert.doesNotMatch(source, /<article className="max-w-\[760px\]">/);
});

test("chat pane no longer requests or renders memory proposal review UI", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /window\.electronAPI\.workspace\.listMemoryUpdateProposals\(\{/);
  assert.doesNotMatch(source, /memoryProposalsByInputId/);
  assert.doesNotMatch(source, /AssistantTurnMemoryProposals/);
  assert.doesNotMatch(source, /window\.electronAPI\.workspace\.acceptMemoryUpdateProposal\(\{/);
  assert.doesNotMatch(source, /window\.electronAPI\.workspace\.dismissMemoryUpdateProposal\(/);
  assert.doesNotMatch(source, /Edit memory proposal/);
});

test("chat pane gates context-budget diagnostics behind verbose telemetry", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function contextBudgetDetails\(/);
  assert.match(source, /Prompt lanes trimmed/);
  assert.doesNotMatch(source, /Tool replay clipped/);
  assert.match(source, /Retrieval-only continuity mode/);
  assert.match(source, /Checkpoint compaction queued/);
  assert.match(
    source,
    /const budgetDetails =\s*options\?\.showContextBudgetDiagnostics === true\s*\?\s*contextBudgetDetails\(payload\)\s*:\s*\[\];/,
  );
  assert.match(
    source,
    /showContextBudgetDiagnostics:\s*params\.showContextBudgetDiagnostics/,
  );
  assert.match(
    source,
    /showContextBudgetDiagnostics:\s*verboseTelemetryEnabled/,
  );
});


test("artifact rows include timestamp metadata in both inline and modal lists", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/ArtifactBrowserModal.tsx"), /const timeLabel = chatMessageTimeLabel\(output\.created_at\);/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/ArtifactBrowserModal.tsx"),
    /if \(timeLabel\) \{\s*parts\.push\(timeLabel\);\s*\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/Outputs.tsx"),
    /<span className="truncate text-xs text-muted-foreground\/80">\s*\{secondaryLabel\}\s*<\/span>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/Outputs.tsx"),
    /<span className="truncate text-xs text-muted-foreground\/80">\s*\{secondaryLabel\}\s*<\/span>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/Outputs.tsx"),
    /selectTurnResultCards\(dedupeOutputsForDisplay\(outputs\)\)/,
  );
});

test("tool trace steps are collapsed by default and first toggle expands them", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/status.tsx"),
    /const expanded = !\(collapsedByStepId\[step\.id\] \?\? true\);/,
  );
  assert.match(source, /\[stepId\]: !\(prev\[stepId\] \?\? true\)/);
  assert.doesNotMatch(source, /\[step\.id\]: false/);
});

test("live trace stays collapsed by default and respects an explicit user toggle", async () => {
  // The old policy auto-expanded a live run; it now stays compact and the
  // summary line carries live status instead. Once the user clicks the
  // chevron their choice wins — collapsing a trace out from under someone
  // who just chose to follow it is the worst version of this.
  const traceStepGroup = await readSourceFile(
    "components/panes/ChatPane/AssistantTurn/TraceStepGroup.tsx",
  );

  assert.match(
    traceStepGroup,
    /function TraceStepGroup\(\{[\s\S]*items,[\s\S]*live = false,[\s\S]*liveOutputStarted = false,/,
  );
  assert.match(
    traceStepGroup,
    /const steps = traceStepsFromExecutionItems\(visibleItems\);/,
  );
  assert.match(
    traceStepGroup,
    /const \[groupExpanded, setGroupExpanded\] = useState\(false\);/,
  );
  assert.match(
    traceStepGroup,
    /const handleToggleExpanded = \(\) => \{\s*userOverrodeRef\.current = true;\s*setGroupExpanded\(\(v\) => !v\);\s*\};/,
  );
  assert.match(
    traceStepGroup,
    /if \(userOverrodeRef\.current\) \{[\s\S]*?return;\s*\}\s*if \(live && !previousLiveRef\.current\) \{\s*setGroupExpanded\(false\);\s*\}/,
  );
  assert.match(
    traceStepGroup,
    /if \(live && liveOutputStarted && !previousLiveOutputStartedRef\.current\) \{\s*setGroupExpanded\(false\);\s*\}/,
  );
  // A forceExpand request from the footer menu resets the override.
  assert.match(
    traceStepGroup,
    /if \(forceExpandToken > 0\) \{\s*userOverrodeRef\.current = false;\s*setGroupExpanded\(true\);\s*\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /<TraceStepGroup[\s\S]*items=\{segment\.items\}[\s\S]*live=\{live\}[\s\S]*liveOutputStarted=\{[\s\S]*renderedSegments[\s\S]*slice\(index \+ 1\)[\s\S]*some\(\(nextSegment\) => nextSegment\.kind === "output"\)/,
  );
});

test("chat pane preserves interleaved assistant output and execution segments from ordered events", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /let segments: ChatAssistantSegment\[] = \[];/);
  assert.match(source, /const flushExecutionSegment = \(\) => \{/);
  assert.match(source, /const flushOutputSegment = \(\) => \{/);
  assert.match(
    source,
    /if \(event\.event_type === "thinking_delta"\) \{\s*flushOutputSegment\(\);/,
  );
  assert.match(
    source,
    /if \(event\.event_type === "output_delta"\) \{\s*flushExecutionSegment\(\);/,
  );
  assert.match(
    source,
    /flushOutputSegment\(\);\s*flushExecutionSegment\(\);\s*return \{\s*segments: segments\.length > 0 \? segments : undefined,/,
  );
  assert.match(source, /const renderedLiveAssistantSegments = liveAssistantSegmentsForRender\(/);
});

test("chat pane can jump to a requested sub-session run", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /sessionJumpSessionId = null/);
  assert.match(source, /sessionJumpRequestKey = 0/);
  assert.match(source, /const lastHandledSessionJumpRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const lastHandledExternalSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const lastHandledLocalSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const draftParentSessionIdRef = useRef<string \| null>\(null\);/);
  assert.match(
    source,
    /const hasSessionJumpRequest =[\s\S]*sessionJumpRequestKey > 0[\s\S]*sessionJumpRequestKey !== lastHandledSessionJumpRequestKeyRef\.current/,
  );
  assert.match(
    source,
    /const lastHandledSessionOpenRequestKeyRef = isExternalSessionOpenRequest\s*\?\s*lastHandledExternalSessionOpenRequestKeyRef\s*:\s*lastHandledLocalSessionOpenRequestKeyRef;/,
  );
  assert.match(
    source,
    /const requestMode = effectiveSessionOpenRequest\?\.mode \?\? "session";[\s\S]*const requestedParentSessionId =[\s\S]*effectiveSessionOpenRequest\?\.parentSessionId\?\.trim\(\) \|\| null;/,
  );
  assert.match(
    source,
    /if \(requestMode === "draft"\) \{[\s\S]*setActiveSessionReadOnly\(false\);[\s\S]*draftParentSessionIdRef\.current = requestedParentSessionId;[\s\S]*clearSessionView\(\);[\s\S]*setActiveSession\(null\);[\s\S]*requestHistoryViewportRestore\(\);[\s\S]*historyLoaded = true;[\s\S]*return;[\s\S]*\}/,
  );
  assert.match(
    source,
    /const resolvedSessionId =\s*\(hasSessionJumpRequest && requestedSessionId\s*\? requestedSessionId\s*: null\) \|\|\s*mainSessionResponse\.session\?\.session_id\?\.trim\(\) \|\|\s*null;/,
  );
});

test("chat pane no longer carries a session-local todo plan rail", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(
    source,
    /const \[currentTodoPlan, setCurrentTodoPlan\] = useState<ChatTodoPlan \| null>\(\s*null,\s*\);/,
  );
  assert.doesNotMatch(source, /const \[todoPanelExpanded, setTodoPanelExpanded\] = useState\(false\);/);
  assert.doesNotMatch(source, /setCurrentTodoPlan\(/);
  assert.doesNotMatch(source, /liveTodoPlanOverrideRef/);
  assert.match(
    source,
    /<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}[\s\S]*variant="inline"/,
  );
  assert.doesNotMatch(source, /<SubagentSessionsPane[\s\S]*variant="inline"/);
});

test("chat composer exposes a pause action for in-flight runs and calls the runtime pause API", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const \[isPausePending, setIsPausePending\] = useState\(false\);/);
  assert.match(source, /async function pauseCurrentRun\(\)/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.pauseSessionRun\(\{\s*workspace_id: selectedWorkspaceId,\s*session_id: sessionId,\s*\}\)/,
  );
  assert.match(
    source,
    /<Composer[\s\S]*pausePending=\{isPausePending\}[\s\S]*pauseDisabled=\{isSubmittingMessage\}[\s\S]*onPause=\{pauseCurrentRun\}/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /\{isResponding \? \(\s*<button[\s\S]*aria-label="Pause"[\s\S]*onClick=\{onPause\}[\s\S]*\) : \(\s*<button[\s\S]*aria-label="Send message"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /disabled=\{pausePending \|\| pauseDisabled \|\| disabled\}/,
  );
});

test("chat composer supports ctrl-c draft cancel and arrow-up recall", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /interface ComposerInputRecallSnapshot \{/);
  assert.match(
    source,
    /const lastSubmittedComposerInputRef =\s*useRef<ComposerInputRecallSnapshot \| null>\(null\);/,
  );
  assert.match(
    source,
    /const lastCancelledComposerInputRef =\s*useRef<ComposerInputRecallSnapshot \| null>\(null\);/,
  );
  assert.match(source, /function rememberSubmittedComposerInput\(text: string, workspaceId: string\)/);
  assert.match(source, /function cancelComposerDraftFromKeyboard\(\)/);
  assert.match(
    source,
    /setInput\(""\);\s*setQuotedSkillIds\(\[\]\);\s*setQuotedCapabilityIds\(\[\]\);\s*composerEditorRef\.current\?\.clear\(\);\s*setPendingAttachments\(\[\]\);\s*setAttachmentGateMessage\(""\);/,
  );
  assert.match(source, /function recallLatestComposerInput\(\)/);
  assert.match(
    source,
    /setInput\(recallableInput\.text\);\s*composerEditorRef\.current\?\.setContent\(\{\s*text: recallableInput\.text,/,
  );
  assert.match(source, /rememberSubmittedComposerInput\(text, selectedWorkspace\.id\);/);
  assert.match(
    await readSourceFile(
      "components/panes/ChatPane/Composer/editor/ComposerEditor.tsx",
    ),
    /event\.key\.toLowerCase\(\) === "c" &&\s*event\.ctrlKey &&[\s\S]*propsRef\.current\.onCancelDraft\(\)\s*\) \{\s*event\.preventDefault\(\);/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/editor/ComposerEditor.tsx"),
    /event\.key === "ArrowUp" &&[\s\S]*const atStart = empty && \$from\.pos <= 1;[\s\S]*view\.state\.doc\.textContent\.length === 0 &&\s*propsRef\.current\.onRecallLatest\(\)\s*\) \{\s*event\.preventDefault\(\);/,
  );
});

test("live assistant turn keeps a plain status placeholder before any trace or output arrives", async () => {
  const [source, assistantTurnSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(assistantTurnSourcePath, "utf8"),
  ]);

  assert.match(
    source,
    /const hasVisibleLiveAssistantContent =\s*renderedLiveAssistantSegments\.length > 0;/,
  );
  assert.match(
    source,
    /const showLiveAssistantTurn =\s*isResponding \|\|\s*hasVisibleLiveAssistantContent;/,
  );
  assert.match(
    source,
    /resetLiveTurn\(\);[\s\S]*setIsResponding\(true\);[\s\S]*setLiveAgentStatus\("Working"\);/,
  );
  assert.match(
    assistantTurnSource,
    /const statusFallback =\s*normalizedStatus\.toLowerCase\(\) === "checking workspace context"\s*\?\s*"Working"\s*:\s*normalizedStatus;/,
  );
  assert.match(
    assistantTurnSource,
    /const turnStatus = resolveTurnStatus\(renderedSegments, \{\s*live,\s*workedMs,\s*statusFallback,\s*\}\);/,
  );
  assert.match(assistantTurnSource, /\{turnStatusAnchor\}/);
});

test("main-session assistant turns are labeled as Hola", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const assistantLabel = activeIssue\s*\? "Background agent"\s*: isViewingBoundMainSession\s*\? "Hola"\s*: activeSessionTitle;/,
  );
  assert.doesNotMatch(
    source,
    /const assistantLabel = selectedWorkspace\?\.name \|\| "Assistant";/,
  );
});

test("chat pane keeps the current stream attached while queueing a follow-up input", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const \[isSubmittingMessage, setIsSubmittingMessage\] = useState\(false\);/);
  assert.match(
    source,
    /const \[queuedSessionInputs, setQueuedSessionInputs\] = useState<\s*QueuedSessionInput\[\]\s*>\(\[]\);/,
  );
  assert.match(
    source,
    /quotedSkillIds\.length === 0 &&\s*quotedIntegrationSlugs\.length === 0\) \|\|\s*isSubmittingMessage/,
  );
  assert.match(
    source,
    /const queueOntoActiveRun =[\s\S]*\(isResponding[\s\S]*Boolean\(activeStreamIdRef\.current\)[\s\S]*Boolean\(pendingInputIdRef\.current\)\)[\s\S]*targetSessionId === activeSessionIdRef\.current;/,
  );
  // The optimistic user message now either appends or REPLACES: sending into a
  // new session holds the outgoing conversation on screen (rather than blanking
  // the canvas for the whole session-creation round trip) and swaps it out here.
  assert.match(
    source,
    /if \(!queueOntoActiveRun\) \{[\s\S]*setMessages\(\(prev\) => \(swapping \? \[userMessage\] : \[\.\.\.prev, userMessage\]\)\);[\s\S]*\}/,
  );
  assert.doesNotMatch(source, /eventType: "stream_open_prequeue"/);
  assert.match(
    source,
    /if \(!queueOntoActiveRun\) \{[\s\S]*pendingInputIdRef\.current = queued\.input_id;[\s\S]*openSessionOutputStream\(\{[\s\S]*sessionId: queued\.session_id,[\s\S]*workspaceId: selectedWorkspace\.id,[\s\S]*inputId: queued\.input_id,[\s\S]*includeHistory: true,[\s\S]*stopOnTerminal: true,[\s\S]*\}\)[\s\S]*eventType: "stream_open_postqueue"/,
  );
  assert.match(
    source,
    /setQueuedSessionInputs\(\(current\) => \[[\s\S]*inputId: queued\.input_id,[\s\S]*status: "queued",[\s\S]*\}\s*,\s*\]\);/,
  );
  assert.match(source, /eventType: "stream_open_queued_handoff"/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /function queuedSessionInputPreviewText\(item: QueuedSessionInput\)/,
  );
  assert.match(source, /async function updateQueuedSessionInputText\(/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.updateQueuedSessionInput\(\s*\{\s*workspace_id: item\.workspaceId,\s*session_id: item\.sessionId,\s*input_id: item\.inputId,\s*text: serializedText,\s*\},?\s*\)/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /function QueuedSessionInputRail\(/,
  );
  assert.match(
    source,
    /<QueuedSessionInputRail[\s\S]*items=\{displayedQueuedSessionInputs\}[\s\S]*onEditItem=\{[\s\S]*updateQueuedSessionInputText[\s\S]*\}[\s\S]*<Composer/,
  );
  assert.match(
    await readSourceFile(
      "components/panes/ChatPane/QueuedSessionInputRail.tsx",
    ),
    /children: ReactNode;/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /const contentHeightPx = visibleCount \* ITEM_ROW_HEIGHT_PX;/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /const panelHeightPx = peekHeightPx \+ OVERLAP_PX;/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /className="pointer-events-none absolute inset-x-0 top-0"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /className="pointer-events-auto absolute inset-x-0 overflow-hidden rounded-\w+/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /\{items\.map\(\(item\) => \{/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /<CornerDownLeft className="size-3 shrink-0 text-muted-foreground\/70" \/>/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /aria-label="Edit queued message"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /aria-label="Save queued message edit"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /aria-label="Cancel queued message edit"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /className="relative z-10 rounded-3xl bg-background"/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/QueuedSessionInputRail.tsx"),
    /animate=\{\{ marginTop: items\.length > 0 \? -OVERLAP_PX : 0 \}\}/,
  );
  assert.doesNotMatch(source, /Queued messages/);
  assert.doesNotMatch(source, /Up next/);
  assert.doesNotMatch(source, /Sending next/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /const inputDisabled = disabled;/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/Composer/index.tsx"),
    /if \(!dataTransfer \|\| disabled\) \{/,
  );
});

test("chat pane exposes a queued message preview hook for dev console inspection", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/constants.ts"),
    /const QUEUED_MESSAGES_PREVIEW_EVENT =\s*"holaboss:queued-messages-preview-change";/,
  );
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /__holabossQueuedMessagesPreviewState\?: QueuedSessionInputPreviewDescriptor\[\];/);
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /__holabossDevQueuedMessagesPreview\?: \{/);
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\(QUEUED_MESSAGES_PREVIEW_EVENT\)\);/);
  assert.match(source, /function useQueuedSessionInputPreview\(params:/);
  assert.match(source, /window\.__holabossDevQueuedMessagesPreview = \{/);
  assert.match(
    source,
    /single:\s*\([\s\S]*Draft a concise follow-up after the current run finishes\.[\s\S]*=>/,
  );
  assert.match(source, /multiple: \(\) =>/);
  assert.match(source, /clear: \(\) => setQueuedSessionInputPreviewState\(\[]\)/);
  assert.match(source, /set: \(entries\) => setQueuedSessionInputPreviewState\(entries\)/);
  assert.match(source, /const queuedSessionInputPreview = useQueuedSessionInputPreview\(/);
  assert.match(
    source,
    /const displayedQueuedSessionInputs =\s*queuedSessionInputPreview\.length > 0[\s\S]*\?\s*queuedSessionInputPreview[\s\S]*:\s*activeQueuedSessionInputs;/,
  );
});

test("chat pane no longer exposes a separate todo preview rail", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /const todoPlanPreview = useTodoPlanPreview\(\);/);
  assert.doesNotMatch(source, /const displayedTodoPlan =/);
  assert.doesNotMatch(source, /const displayedTodoPanelExpanded =/);
  assert.doesNotMatch(source, /const toggleTodoPanel = \(\) => \{/);
});

test("chat pane renders inline background tasks near the top of the pane", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /!isOnboardingVariant && isViewingBoundMainSession \? \(\s*<div className="mb-3 empty:hidden">\s*<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}[\s\S]*variant="inline"/,
  );
  assert.doesNotMatch(
    source,
    /!isOnboardingVariant && !isReadOnlyInspectionSession \? \(\s*<SubagentSessionsPane[\s\S]*variant="inline"[\s\S]*\) : null/,
  );
  assert.match(source, /const handleOpenReadOnlyAgentSession = \(/);
  assert.doesNotMatch(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.match(
    source,
    /className=\{`mx-auto flex min-w-0 w-full \$\{effectiveContentMaxWidth\} flex-col gap-2[^`]*\$\{\s*showHistoryRestoreScreen \? "invisible" : ""\s*\}`\}/,
  );
  assert.doesNotMatch(source, /<CurrentTodoPanel/);
});

test("chat pane stops auto-follow while the user is actively selecting chat text", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function hasActiveChatSelection\(container: HTMLDivElement \| null\)/);
  assert.match(source, /const selection = window\.getSelection\(\);/);
  assert.match(
    source,
    /!container \|\|\s*!shouldAutoScrollRef\.current \|\|\s*hasActiveChatSelection\(container\)/,
  );
});

test("chat pane stops auto-follow as soon as the user scrolls upward during streaming", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const lastChatScrollTopRef = useRef\(0\);/);
  assert.match(source, /lastChatScrollTopRef\.current = nextScrollTop;/);
  assert.match(
    source,
    /onWheelCapture=\{\(event\) => \{\s*if \(event\.deltaY < 0\) \{\s*shouldAutoScrollRef\.current = false;\s*\}\s*\}\}/,
  );
  assert.match(
    source,
    /const scrolledUp =\s*nextScrollTop < lastChatScrollTopRef\.current;/,
  );
  assert.match(
    source,
    /shouldAutoScrollRef\.current = scrolledUp \? false : nearBottom;/,
  );
});

test("chat pane preserves the status placeholder while a queued stream attachment is still pending", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /const turnStatus = resolveTurnStatus\(renderedSegments, \{/,
  );
  assert.match(
    source,
    /pendingInputIdRef\.current = STREAM_ATTACH_PENDING;/,
  );
  assert.match(
    source,
    /const shouldPreservePendingPlaceholder =\s*pendingInputIdRef\.current === STREAM_ATTACH_PENDING;/,
  );
  assert.match(
    source,
    /if \(!shouldPreservePendingPlaceholder\) \{\s*resetLiveTurn\(\);\s*\}/,
  );
  assert.match(
    source,
    /const pendingInputId = pendingInputIdRef\.current \|\| "";/,
  );
  assert.match(
    source,
    /const attachPendingWithoutStream = Boolean\(\s*pendingInputId && !activeStreamId,\s*\);/,
  );
  assert.match(source, /if \(attachPendingWithoutStream\) \{\s*return;\s*\}/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/AssistantTurn/index.tsx"),
    /const turnStatusAnchor = turnStatus \? \([\s\S]*<span className="min-w-0 truncate">\{turnStatus\.label\}<\/span>/,
  );
});

test("conversation turns do not render delegated task cards inline with assistant replies", async () => {
  const source = await readFile(conversationTurnsSourcePath, "utf8");

  assert.doesNotMatch(source, /BackgroundTaskReferenceCards/);
  assert.doesNotMatch(source, /backgroundTaskFooterAccessory/);
  assert.match(
    await readSourceFile("components/panes/ChatPane/ConversationTurns.tsx"),
    /footerAccessory=\{\s*message\.id === assistantFooterAccessoryMessageId\s*\?\s*assistantFooterAccessory\s*:\s*null\s*\}/,
  );
});

test("chat pane idly refreshes the active main session to surface autonomous background follow-ups", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function latestVisibleChatMessageId\(messages: ChatMessage\[\]\): string \{/);
  assert.match(
    source,
    /async function reconcileAutonomousMainSessionActivity\(params: \{\s*workspaceId: string;\s*mainSessionId: string;\s*currentMessages: ChatMessage\[\];/,
  );
  assert.match(
    source,
    /if \(\s*!workspaceId \|\|\s*!mainSessionId \|\|\s*currentSessionId !== mainSessionId \|\|\s*activeSessionReadOnly \|\|\s*isLoadingHistory \|\|\s*isResponding\s*\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(currentContainer && !isNearChatBottom\(currentContainer\)\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /const shouldAttachAutonomousRun =[\s\S]*\["BUSY", "QUEUED"\]\.includes\(currentRuntimeStatus\);/,
  );
  assert.match(
    source,
    /if \(shouldAttachAutonomousRun\) \{\s*await loadSessionConversation\(\s*mainSessionId,\s*workspaceId,\s*runtimeStates\.items,\s*\{[\s\S]*?readOnly: false,[\s\S]*?return true;\s*\}/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.getSessionHistory\(\{\s*sessionId: mainSessionId,\s*workspaceId,\s*limit: 1,\s*offset: 0,\s*order: "desc",\s*\}\)/,
  );
  assert.match(
    source,
    /await reconcileAutonomousMainSessionActivity\(\{\s*workspaceId,\s*mainSessionId,\s*currentMessages: messages,/,
  );
});

test("chat pane suppresses empty synthetic background follow-up failures and keeps a stable retry status", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    await readSourceFile("components/panes/ChatPane/constants.ts"),
    /const MAIN_SESSION_EVENT_BATCH_HEADER =\s*"\[Holaboss Main Session Event Batch v1\]";/,
  );
  assert.match(
    await readSourceFile("components/panes/ChatPane/constants.ts"),
    /const BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE =\s*"Background update delayed\. Retrying automatically\.";/,
  );
  assert.match(
    source,
    /const \[backgroundDeliveryStatusMessage, setBackgroundDeliveryStatusMessage\] =\s*useState\(""\);/,
  );
  assert.match(
    source,
    /const mainSessionEventBatchInputIdsRef = useRef<Set<string>>\(new Set\(\)\);/,
  );
  assert.match(
    source,
    /const trackedMainSessionEventBatchInput =[\s\S]*rememberMainSessionEventBatchInput\(eventInputId, eventPayload\);[\s\S]*const isMainSessionEventBatchInput =[\s\S]*isRememberedMainSessionEventBatchInput\(eventInputId\);/,
  );
  assert.match(
    source,
    /if \(isMainSessionEventBatchInput && shouldPersistFailureText\) \{[\s\S]*setBackgroundDeliveryStatusMessage\(\s*BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE,\s*\);[\s\S]*action: "suppress_background_delivery_failure"[\s\S]*scheduleConversationRefresh\(eventSessionId, selectedWorkspaceId\);[\s\S]*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(isMainSessionEventBatchInput\) \{\s*setBackgroundDeliveryStatusMessage\(""\);\s*\}/,
  );
  assert.match(
    source,
    /\{chatErrorMessage \|\|\s*backgroundDeliveryStatusMessage \|\|[\s\S]*\{backgroundDeliveryStatusMessage \? \(\s*<div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">\s*\{backgroundDeliveryStatusMessage\}\s*<\/div>/,
  );
});

test("chat pane suppresses paused synthetic background follow-up completions before first token", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const suppressBackgroundDeliveryCompletion =\s*isMainSessionEventBatchInput &&\s*completedStatus === "paused" &&\s*!liveAssistantHasVisibleOutput\(\);/,
  );
  assert.match(
    source,
    /if \(suppressBackgroundDeliveryCompletion\) \{[\s\S]*setBackgroundDeliveryStatusMessage\(\s*BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE,\s*\);[\s\S]*action: "suppress_background_delivery_completion"[\s\S]*void refreshWorkspaceData\(\)\.catch\(\(\) => undefined\);[\s\S]*return;\s*\}/,
  );
});

test("chat pane suppresses the in-flight assistant history row when attaching a live stream", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const renderedForDisplay =\s*shouldAttachLiveRunStream && currentRuntimeInputId\s*\?\s*rendered\.filter\(\s*\(message\) =>\s*message\.role !== "assistant" \|\|\s*inputIdFromMessageId\(message\.id, "assistant"\) !==\s*currentRuntimeInputId,\s*\)\s*:\s*rendered;/,
  );
  assert.match(
    source,
    /setMessages\(\(prev\) =>[\s\S]*?mergePendingOptimisticUserMessages\(renderedForDisplay,/,
  );
  assert.match(
    source,
    /const hasAssistantMessage = renderedMessagesForDisplay\.some\(\s*\(message\) => message\.role === "assistant",\s*\);/,
  );
});

test("chat pane reconciles missed autonomous main-session follow-ups before appending a new user turn", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /if \(\s*!pendingSessionTarget &&\s*selectedWorkspace &&\s*targetSessionId === mainSessionIdForWorkspace &&[\s\S]*await reconcileAutonomousMainSessionActivity\(\{\s*workspaceId: selectedWorkspace\.id,\s*mainSessionId: mainSessionIdForWorkspace,\s*currentMessages: messages,\s*\}\);/,
  );
  assert.match(
    source,
    /const queueOntoActiveRun =\s*\(\s*isResponding \|\|\s*Boolean\(activeStreamIdRef\.current\)\s*\|\|\s*Boolean\(pendingInputIdRef\.current\)\s*\)\s*&&/,
  );
});

test("chat pane clears prior workspace live-run state immediately on workspace switch", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const previousSelectedWorkspaceIdRef = useRef\(\s*\(selectedWorkspaceId \|\| ""\)\.trim\(\),\s*\);/,
  );
  assert.match(
    source,
    /const normalizedWorkspaceId = \(selectedWorkspaceId \|\| ""\)\.trim\(\);[\s\S]*const previousWorkspaceId = previousSelectedWorkspaceIdRef\.current;[\s\S]*if \(previousWorkspaceId === normalizedWorkspaceId\) \{\s*return;\s*\}[\s\S]*previousSelectedWorkspaceIdRef\.current = normalizedWorkspaceId;/,
  );
  assert.match(source, /activeStreamIdRef\.current = null;/);
  assert.match(source, /pendingInputIdRef\.current = null;/);
  assert.match(source, /setQueuedSessionInputs\(\[\]\);/);
  assert.match(source, /setDesktopMainSession\(null\);/);
  assert.match(source, /setActiveSession\(null\);/);
  assert.match(source, /clearSessionView\(\);/);
  assert.match(
    source,
    /if \(activeStreamId\) \{\s*void closeStreamWithReason\(activeStreamId,\s*"selected_workspace_changed"\);\s*\}/,
  );
});

test("chat pane preserves optimistic user messages across history refresh until the persisted message arrives", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /interface PendingOptimisticUserMessage \{/);
  assert.match(await readSourceFile("components/panes/ChatPane/types.ts"), /localMessageId: string;/);
  assert.match(
    source,
    /function reconcilePendingOptimisticUserMessages\([\s\S]*return pendingMessages\.filter\(/,
  );
  assert.match(
    source,
    /const inputId = \(item\.inputId \|\| ""\)\.trim\(\);[\s\S]*if \(!inputId\) \{\s*return true;\s*\}/,
  );
  assert.match(
    source,
    /function mergePendingOptimisticUserMessages\([\s\S]*return uniqueChatMessagesInDisplayOrder\(\[[\s\S]*\.\.\.renderedMessages,[\s\S]*\.\.\.matchingPendingMessages,[\s\S]*\]\);/,
  );
  assert.match(
    source,
    /const \[pendingOptimisticUserMessages, setPendingOptimisticUserMessages\] =\s*useState<PendingOptimisticUserMessage\[\]>\(\[]\);/,
  );
  assert.match(
    source,
    /const pendingOptimisticUserMessagesRef = useRef<[\s\S]*PendingOptimisticUserMessage\[\][\s\S]*>\(\[]\);/,
  );
  assert.match(
    source,
    /function updatePendingOptimisticUserMessagesState\([\s\S]*pendingOptimisticUserMessagesRef\.current = next;[\s\S]*setPendingOptimisticUserMessages\(next\);/,
  );
  assert.match(source, /let optimisticUserMessageId = "";/);
  assert.match(source, /optimisticUserMessageId = `user-\$\{Date\.now\(\)\}`;/);
  assert.match(source, /const persistedUserMessageId = `user-\$\{queued\.input_id\}`;/);
  assert.match(
    source,
    /updatePendingOptimisticUserMessagesState\(\(current\) => \[[\s\S]*localMessageId: optimisticUserMessageId,[\s\S]*inputId: null,[\s\S]*sessionId: targetSessionId,[\s\S]*workspaceId: selectedWorkspace\.id,[\s\S]*message: userMessage,/,
  );
  assert.match(
    source,
    /updatePendingOptimisticUserMessagesState\(\(current\) =>[\s\S]*item\.localMessageId === optimisticUserMessageId[\s\S]*inputId: queued\.input_id,[\s\S]*sessionId: queued\.session_id,[\s\S]*message: persistedUserMessage,/,
  );
  assert.match(
    source,
    /const reconciled = reconcilePendingOptimisticUserMessages\(\s*pendingOptimisticUserMessagesRef\.current,\s*\{ workspaceId, sessionId: nextSessionId, persistedInputIds \},\s*\);/,
  );
  assert.match(
    source,
    /setMessages\(\(prev\) =>[\s\S]*?mergePendingOptimisticUserMessages\(renderedForDisplay, reconciled, \{\s*workspaceId,\s*sessionId: nextSessionId,\s*\}\)/,
  );
  assert.match(
    source,
    /if \(!queueAccepted && !queueOntoActiveRun && optimisticUserMessageId\) \{[\s\S]*prev\.filter\(\(message\) => message\.id !== optimisticUserMessageId\)[\s\S]*item\.localMessageId !== optimisticUserMessageId/,
  );
});

test("a failed send restores the composer without overwriting a newer draft", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The snapshot has to be taken before the optimistic clear, or there is
  // nothing to put back.
  assert.match(
    source,
    /const composerSnapshot = \{[\s\S]*text,[\s\S]*skillIds: quotedSkillIds,[\s\S]*capabilityIds: quotedCapabilityIds,[\s\S]*integrationSlugs: quotedIntegrationSlugs,[\s\S]*attachments: pendingAttachments,[\s\S]*\};/,
  );

  // Restoring is only correct while the composer is still empty. The failure
  // can land seconds after the optimistic clear, so an unconditional restore
  // overwrites whatever the user typed while waiting.
  assert.match(
    source,
    /const composerStillEmpty =\s*composerEditorRef\.current\?\.isEmpty\(\) !== false;/,
  );
  assert.match(
    source,
    /if \(composerStillEmpty\) \{[\s\S]*setInput\(composerSnapshot\.text\);[\s\S]*composerEditorRef\.current\?\.setContent\(\{/,
  );

  // When the draft wins, the failed message still must not vanish: recording
  // it is what makes the recall shortcut able to bring it back.
  assert.match(
    source,
    /\} else \{\s*rememberSubmittedComposerInput\(\s*composerSnapshot\.text,\s*selectedWorkspace\.id,\s*\);\s*\}/,
  );

  // Attachments merge rather than overwrite — re-staging files cannot clobber
  // typed text, but blindly assigning would drop newly dragged ones.
  assert.match(
    source,
    /setPendingAttachments\(\(current\) =>\s*current\.length === 0 \? composerSnapshot\.attachments : current,\s*\);/,
  );

  // Past the queue the turn exists, so nothing may be put back.
  assert.match(source, /let queueAccepted = false;/);
  assert.match(source, /queueAccepted = true;/);
  assert.match(source, /if \(!queueAccepted\) \{/);
});
