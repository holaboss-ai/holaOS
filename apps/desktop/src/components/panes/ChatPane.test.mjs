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

test("chat pane surfaces workspace activation errors before generic app-starting copy", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const \{\s*[\s\S]*workspaceBlockingReason,\s*workspaceErrorMessage,\s*refreshWorkspaceData,\s*\} = useWorkspaceDesktop\(\);/,
  );
  assert.match(
    source,
    /setChatErrorMessage\(\s*workspaceBlockingReason \|\|[\s\S]*workspaceErrorMessage \|\|[\s\S]*"Workspace apps are still starting\.",\s*\);/,
  );
  assert.match(
    source,
    /const readinessMessage =[\s\S]*workspaceBlockingReason \|\|[\s\S]*workspaceErrorMessage \|\|[\s\S]*"Preparing workspace apps\.\.\."[\s\S]*"Workspace apps are still starting\."/,
  );
  assert.match(source, /workspace_error_message: workspaceErrorMessage \|\| null,/);
});

test("onboarding chat opens active lab controller sessions while normal chat can return to main", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /function isLabControllerSessionKind\(kind: string \| null \| undefined\) \{[\s\S]*normalized === "workspace_onboarding" \|\| normalized === "meeting_mode";/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\s*\.listAgentSessions\(\{\s*workspaceId: selectedWorkspaceId,\s*includeArchived: false,\s*limit: 100,\s*offset: 0,\s*\}\)/,
  );
  assert.match(
    source,
    /const activeLabControllerSession =[\s\S]*sessionRecords\.find\(\(session\) =>[\s\S]*isLabControllerSessionKind\(session\.kind\),/,
  );
  assert.match(
    source,
    /const preferredControllerSessionId =[\s\S]*: isOnboardingVariant[\s\S]*\? activeLabControllerSession\?\.session_id\?\.trim\(\) \|\|[\s\S]*onboardingSessionId[\s\S]*: "";/,
  );
  assert.match(
    source,
    /const mainSessionResponse = preferredControllerSessionId\s*\?\s*null\s*:\s*await window\.electronAPI\.workspace\.ensureMainSession\(/,
  );
  assert.match(
    source,
    /const isWorkspaceOnboardingControllerSession =[\s\S]*isOnboardingVariant[\s\S]*activeSessionIdValue === workspaceOnboardingSessionId/,
  );
  assert.match(
    source,
    /const isControllerSession =[\s\S]*isLabControllerSession \|\| isWorkspaceOnboardingControllerSession;/,
  );
  assert.match(
    source,
    /const isReadOnlyInspectionSession =[\s\S]*activeSessionReadOnly \|\|[\s\S]*\(!isViewingBoundMainSession && !isControllerSession\);/,
  );
  assert.match(
    source,
    /model: isControllerSession \? null : resolvedChatModel \|\| null,/,
  );
});

test("onboarding chat enters the onboarding session immediately and omits the onboarding banner chrome", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const workspaceOnboardingSessionId =\s*\(\s*selectedWorkspace\?\.onboarding_session_id \|\| ""\s*\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const selectedWorkspaceAlignmentQuestionKey =\s*serializedOnboardingQuestionKey\(selectedWorkspace\?\.alignment_question\);/,
  );
  assert.match(
    source,
    /const nextSessionId =[\s\S]*\|\|\s*\(isOnboardingVariant \? workspaceOnboardingSessionId : ""\)\s*\|\|[\s\S]*mainSessionResponse\.session\?\.session_id\?\.trim\(\)/,
  );
  assert.match(
    source,
    /\}, \[\s*isOnboardingVariant,\s*selectedWorkspaceAlignmentQuestionKey,\s*selectedWorkspace\?\.onboarding_state,\s*sessionJumpRequestKey,\s*sessionJumpSessionId,\s*selectedWorkspaceId,\s*selectedWorkspace\?\.onboarding_session_id,\s*selectedWorkspace\?\.onboarding_status,\s*\]\);/,
  );
  assert.doesNotMatch(
    source,
    /text-\[10px\] font-medium uppercase text-primary">\s*Workspace onboarding/,
  );
  assert.doesNotMatch(source, /onboardingStatusTone\(/);
  assert.doesNotMatch(source, /onboardingStatusLabel\(/);
});

test("onboarding chat uses a survey-style alignment card with navigation and freeform response drafts", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const \[onboardingQuestionSlideIndex, setOnboardingQuestionSlideIndex\] =\s*useState\(0\);/,
  );
  assert.match(
    source,
    /const \[onboardingQuestionDrafts, setOnboardingQuestionDrafts\] = useState<\s*Record<string, OnboardingAlignmentQuestionDraft>\s*>\(\{\}\);/,
  );
  assert.match(source, /type OnboardingAlignmentQuestionDraft = \{/);
  assert.match(source, /allowFreeform: item\.allow_freeform !== false,/);
  assert.match(
    source,
    /<div className="mt-1 text-\[1\.45rem\] font-medium leading-tight text-foreground">/,
  );
  assert.match(
    source,
    /const answeredAlignmentQuestionCount = alignmentQuestionItems\.filter\(\(question\) =>[\s\S]*onboardingAlignmentQuestionIsAnswered\(onboardingQuestionDrafts\[question\.id\]\)/,
  );
  assert.match(source, /Natural language response/);
  assert.match(source, /placeholder=\{activeAlignmentQuestion\.freeformPlaceholder\}/);
  assert.match(source, /onboardingQuestionTextareaRef\.current\?\.blur\(\);/);
  assert.match(
    source,
    /optionId:\s*option\.id,\s*responseText:\s*""/,
  );
  assert.match(
    source,
    /onFocus=\{\(\) => \{[\s\S]*current\.optionId[\s\S]*optionId:\s*""/,
  );
  assert.match(
    source,
    /optionId:\s*nextResponseText\.trim\(\) \? "" : current\.optionId,\s*responseText:\s*nextResponseText/,
  );
  assert.match(
    source,
    /answerOnboardingAlignmentQuestion\(\s*workspaceId,\s*[\s\S]*model:\s*resolvedChatModel \|\| null,\s*thinkingValue:\s*effectiveThinkingValue,\s*answers,[\s\S]*\)/,
  );
  assert.match(
    source,
    /const isLastAlignmentQuestion =\s*safeOnboardingQuestionSlideIndex >= alignmentQuestionCount - 1;/,
  );
  assert.match(
    source,
    /Answer this alignment question before continuing\./,
  );
  assert.match(
    source,
    /setOnboardingQuestionSlideIndex\(\(current\) =>[\s\S]*Math\.min\(current \+ 1, alignmentQuestionCount - 1\)/,
  );
  assert.doesNotMatch(
    source,
    /Help the onboarding agent decide the next alignment step/,
  );
  assert.doesNotMatch(
    source,
    /Choose an option, answer in your own words, or do both\./,
  );
  assert.doesNotMatch(
    source,
    /alignmentQuestionItems\.map\(\(question, index\) =>/,
  );
  assert.doesNotMatch(
    source,
    /placeholder=\{activeAlignmentQuestion\.notesPlaceholder\}/,
  );
  assert.doesNotMatch(source, /\{alignmentQuestion\?\.details \? \(/);
  assert.doesNotMatch(source, /\{activeAlignmentQuestion\.details \? \(/);
  assert.doesNotMatch(
    source,
    /<div className="rounded-\[24px\] border border-border\/80 bg-muted\/30 p-4">[\s\S]*activeAlignmentQuestion\.prompt/,
  );
  assert.doesNotMatch(source, /Awaiting answer/);
  assert.match(source, /Previous/);
  assert.doesNotMatch(source, />\s*Next\s*</);
  assert.match(source, /Submit answers/);
});

test("onboarding review cards format structured reports and scroll independently", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const ONBOARDING_REPORT_MARKDOWN_KEYS = \[/);
  assert.match(source, /function onboardingReportMarkdown\(/);
  assert.match(source, /function onboardingReportObjectSummary\(/);
  assert.match(source, /function onboardingReportObjectDetailLines\(/);
  assert.match(
    source,
    /const onboardingReviewCardScrollable =\s*alignmentReviewCardVisible \|\| verificationReviewCardVisible;/,
  );
  assert.match(
    source,
    /const alignmentReportMarkdown = useMemo\(\s*\(\) => onboardingReportMarkdown\(alignmentReport\),/,
  );
  assert.match(
    source,
    /const verificationReportMarkdown = useMemo\(\s*\(\) => onboardingReportMarkdown\(verificationReport\),/,
  );
  assert.match(
    source,
    /alignmentReportMarkdown \? \(\s*<SimpleMarkdown[\s\S]*\{alignmentReportMarkdown\}[\s\S]*<\/SimpleMarkdown>/,
  );
  assert.match(
    source,
    /verificationReportMarkdown \? \(\s*<SimpleMarkdown[\s\S]*\{verificationReportMarkdown\}[\s\S]*<\/SimpleMarkdown>/,
  );
  assert.match(source, /return body \? `## \$\{entry\.label\}\\n\$\{body\}` : "";/);
  assert.match(
    source,
    /\.filter\(\(\[key\]\) => !ONBOARDING_REPORT_HIDDEN_DETAIL_KEYS\.has\(key\)\)/,
  );
  assert.match(source, /chat-scrollbar-thin max-h-\[76vh\] overflow-y-auto/);
  assert.match(source, /\$\{indent\}• \$\{summary\}/);
  assert.doesNotMatch(source, /const serialized = JSON\.stringify\(value\);/);
});

test("chat pane blocks lab controller input while owned subagents are executing", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function backgroundTaskIsExecuting\(/);
  assert.match(
    source,
    /const \[\s*activeControllerSubagentExecutionCount,\s*setActiveControllerSubagentExecutionCount,\s*\] = useState\(0\);/,
  );
  assert.match(
    source,
    /const activeSessionWorkspaceId =[\s\S]*activeSessionRecord\?\.workspace_id[\s\S]*selectedWorkspaceId/,
  );
  assert.match(
    source,
    /const controllerBackgroundTasksWorkspaceId = isControllerSession[\s\S]*\? activeSessionWorkspaceId[\s\S]*: \(selectedWorkspaceId \|\| ""\)\.trim\(\);/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.listBackgroundTasks\(\{\s*workspaceId,\s*ownerMainSessionId: controllerSessionId,\s*statuses: \["queued", "running"\],\s*limit: 50,\s*\}\)/,
  );
  assert.match(
    source,
    /setActiveControllerSubagentExecutionCount\(\(current\) =>[\s\S]*current === executingCount \? current : executingCount/,
  );
  assert.match(
    source,
    /const controllerSubagentExecutingDisabledReason =[\s\S]*Subagent is implementing the approved design\. Wait for it to finish before sending another message\./,
  );
  assert.match(
    source,
    /baseComposerDisabledReason \|\|\s*controllerSubagentExecutingDisabledReason \|\|/,
  );
  assert.match(
    source,
    /if \(controllerSubagentExecutingDisabledReason\) \{\s*setChatErrorMessage\(controllerSubagentExecutingDisabledReason\);\s*return;\s*\}/,
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

  assert.match(source, /const displayLabel =[\s\S]*selectedModelLabel \|\| "Select model"/);
  assert.match(
    source,
    /const noAvailableModels =\s*!runtimeDefaultModelAvailable &&\s*modelOptions\.length === 0 &&\s*modelOptionGroups\.length === 0;/,
  );
  assert.match(source, /disabled=\{optionDisabled\}/);
  assert.match(source, /option\.statusLabel/);
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
    /onOpenModelProviders=\{\(\) =>[\s\S]*window\.electronAPI\.ui\.openSettingsPane\("providers"\)[\s\S]*\}/,
  );
  assert.match(source, /aria-label="Configure model providers"/);
  assert.match(
    source,
    /<Waypoints className="size-3\.5 shrink-0 text-muted-foreground" \/>/,
  );
  assert.match(source, /Open provider settings to connect a model\./);
  assert.match(
    source,
    /className=\{\s*compactComposerControls[\s\S]*\? "min-w-0 shrink-0"[\s\S]*: noAvailableModels[\s\S]*\? "min-w-0 flex flex-1 basis-full flex-wrap items-center gap-2"[\s\S]*: "min-w-0 shrink-0"[\s\S]*\}/,
  );
  assert.match(
    source,
    /\{compactComposerControls[\s\S]*\? "Providers"[\s\S]*: "Set up providers"\}/,
  );
  assert.match(
    source,
    /className=\{`min-w-0 text-\[10px\] leading-5 text-muted-foreground \$\{[\s\S]*compactComposerControls \? "hidden" : ""[\s\S]*`\}/,
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
  assert.match(source, /function ImageAttachmentPreviewModal\(/);
  assert.match(
    source,
    /attachment\.kind === "image" &&[\s\S]*Boolean\(onPreview\)[\s\S]*attachment\.file[\s\S]*attachment\.workspace_path/,
  );
  assert.match(source, /aria-label=\{`Preview \$\{attachment\.name\}`\}/);
  assert.match(
    source,
    /window\.electronAPI\.browser\.captureVisibleSnapshot\(\)\.catch\(\(\) => null\)/,
  );
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
    /browserSnapshot: BrowserVisibleSnapshotPayload \| null;/,
  );
  assert.match(
    source,
    /<ImageAttachmentPreviewModal[\s\S]*open=\{Boolean\(imageAttachmentPreview\)\}[\s\S]*preview=\{imageAttachmentPreview\}[\s\S]*onClose=\{closeImageAttachmentPreview\}/,
  );
  assert.match(source, /const showImage = !preview\.isLoading && !preview\.errorMessage;/);
  assert.match(
    source,
    /preview\.browserSnapshot \? \([\s\S]*src=\{preview\.browserSnapshot\.dataUrl\}[\s\S]*left: `\$\{preview\.browserSnapshot\.bounds\.x\}px`[\s\S]*top: `\$\{preview\.browserSnapshot\.bounds\.y\}px`/,
  );
  assert.match(
    source,
    /className="absolute inset-0 bg-black\/70 backdrop-blur-\[2px\]"/,
  );
  assert.match(
    source,
    /className="relative z-10 flex max-h-\[calc\(100vh-64px\)\] flex-col overflow-hidden rounded-2xl border border-white\/10 bg-background shadow-2xl"/,
  );
  assert.match(source, /style=\{\{ maxWidth: "92vw" \}\}/);
  assert.match(
    source,
    /className=\{`overflow-auto px-4 py-4 \$\{[\s\S]*showImage \? "bg-transparent" : "min-h-\[240px\] min-w-\[320px\] bg-muted\/20"[\s\S]*`\}/,
  );
  assert.match(
    source,
    /className="block h-auto w-auto rounded-lg ring-1 ring-black\/8"/,
  );
  assert.match(
    source,
    /maxWidth: "calc\(92vw - 32px\)",[\s\S]*maxHeight: "calc\(88vh - 128px\)"/,
  );
  assert.match(source, /return createPortal\(modalContent, document\.body\);/);
});

test("chat composer footer wraps controls based on available pane width instead of viewport breakpoints", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX = 240;/,
  );
  assert.match(source, /const syncComposerFooterLayout = \(\) => \{/);
  assert.match(source, /const footerStyle = window\.getComputedStyle\(footer\);/);
  assert.match(
    source,
    /const horizontalPadding =[\s\S]*footerStyle\.paddingLeft[\s\S]*footerStyle\.paddingRight/,
  );
  assert.match(
    source,
    /const width = Math\.max\(\s*0,\s*Math\.round\(footer\.clientWidth - horizontalPadding\),\s*\);/,
  );
  assert.match(
    source,
    /const composerFooterLayoutSyncFrameRef = useRef<number \| null>\(null\);/,
  );
  assert.match(
    source,
    /const cancelComposerFooterLayoutSync = \(\) => \{[\s\S]*window\.cancelAnimationFrame\(composerFooterLayoutSyncFrameRef\.current\);[\s\S]*composerFooterLayoutSyncFrameRef\.current = null;[\s\S]*\};/,
  );
  assert.match(
    source,
    /const scheduleComposerFooterLayoutSync = \(\) => \{[\s\S]*window\.requestAnimationFrame\(\s*\(\) => \{[\s\S]*syncComposerFooterLayout\(\);[\s\S]*\},\s*\);[\s\S]*\};/,
  );
  assert.match(
    source,
    /const resizeObserver = new ResizeObserver\(\(\) => \{\s*scheduleComposerFooterLayoutSync\(\);\s*\}\);/,
  );
  assert.match(
    source,
    /const compactComposerControls =\s*showModelSelector &&[\s\S]*composerFooterLayout\.width > 0[\s\S]*composerFooterLayout\.actionsWidth > 0[\s\S]*composerFooterLayout\.width < fullFooterControlWidth/,
  );
  assert.doesNotMatch(source, /composerFooterLayout\.wraps/);
  assert.doesNotMatch(source, /Array\.from\(footer\.children\)/);
  assert.match(
    source,
    /const compactModelControlWidth = compactComposerControls[\s\S]*COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX[\s\S]*compactFooterControlWidth -[\s\S]*COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX/,
  );
  assert.match(
    source,
    /const compactThinkingControlWidth = showThinkingValueSelector[\s\S]*COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX[\s\S]*compactFooterControlWidth - compactModelControlWidth/,
  );
  assert.match(
    source,
    /className=\{`px-3 pb-3 text-muted-foreground \$\{[\s\S]*compactComposerControls[\s\S]*\? "flex items-center gap-1\.5 overflow-hidden"[\s\S]*: "flex flex-wrap items-center gap-1\.5"[\s\S]*`\}/,
  );
  assert.match(
    source,
    /className=\{\s*compactComposerControls[\s\S]*\? "min-w-0 shrink-0"[\s\S]*: noAvailableModels[\s\S]*"min-w-0 flex flex-1 basis-full flex-wrap items-center gap-2"[\s\S]*\}/,
  );
  assert.match(
    source,
    /style=\{\s*compactComposerControls\s*\?\s*\{ width: `\$\{compactModelControlWidth\}px` \}\s*:\s*undefined\s*\}/,
  );
  assert.match(
    source,
    /className="ml-auto flex shrink-0 items-center gap-1\.5"/,
  );
  assert.match(source, /compact=\{compactComposerControls\}/);
  assert.doesNotMatch(source, /sm:w-\[208px\]/);
});

test("chat pane defers scroll metrics updates out of resize and scroll callbacks", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const chatScrollMetricsSyncFrameRef = useRef<number \| null>\(null\);/,
  );
  assert.match(
    source,
    /const chatScrollMetricsSyncTargetRef = useRef<HTMLDivElement \| null>\(null\);/,
  );
  assert.match(
    source,
    /const cancelChatScrollMetricsSync = \(\) => \{[\s\S]*window\.cancelAnimationFrame\(chatScrollMetricsSyncFrameRef\.current\);[\s\S]*chatScrollMetricsSyncTargetRef\.current = null;[\s\S]*\};/,
  );
  assert.match(
    source,
    /const scheduleChatScrollMetricsSync = \(container\?: HTMLDivElement \| null\) => \{[\s\S]*chatScrollMetricsSyncFrameRef\.current = window\.requestAnimationFrame\(\(\) => \{[\s\S]*syncChatScrollMetrics\(target\);[\s\S]*\}\);[\s\S]*\};/,
  );
  assert.match(
    source,
    /useEffect\(\s*\(\) => \(\) => \{[\s\S]*clearChatScrollbarDragState\(\);[\s\S]*cancelChatScrollMetricsSync\(\);[\s\S]*\},\s*\[\],\s*\);/,
  );
  assert.match(
    source,
    /const resizeObserver = new ResizeObserver\(\(\) => \{\s*scheduleChatScrollMetricsSync\(container\);\s*\}\);/,
  );
  assert.match(source, /scheduleChatScrollMetricsSync\(currentTarget\);/);
  assert.doesNotMatch(
    source,
    /const resizeObserver = new ResizeObserver\(\(\) => \{\s*syncChatScrollMetrics\(container\);\s*\}\);/,
  );
  assert.doesNotMatch(source, /syncChatScrollMetrics\(currentTarget\);/);
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

test("chat pane only uses workspace lifecycle blocking state for startup composer disablement", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const readinessMessage =[\s\S]*workspaceBlockingReason \|\|[\s\S]*isActivatingWorkspace[\s\S]*"Preparing workspace apps\.\.\."[\s\S]*"Workspace apps are still starting\."/,
  );
  assert.match(
    source,
    /if \(!isOnboardingVariant && !workspaceAppsReady\) \{[\s\S]*workspaceBlockingReason \|\| "Workspace apps are still starting\."/,
  );
  assert.doesNotMatch(source, /workspaceErrorMessage/);
});

test("chat pane does not adopt unmatched done or error stream frames and refreshes after matching done", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /action: "adopt_stream_for_done"/);
  assert.doesNotMatch(source, /action: "adopt_stream_for_error"/);
  assert.match(
    source,
    /if \(payload\.type === "done"\) \{[\s\S]*const refreshSessionId = activeSessionIdRef\.current;[\s\S]*action: "applied_done"[\s\S]*if \(refreshSessionId && selectedWorkspaceId\) \{[\s\S]*scheduleConversationRefresh\(refreshSessionId, selectedWorkspaceId\);[\s\S]*\}/,
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

  assert.match(source, /function compactComposerModelLabel\(label: string\)/);
  assert.match(source, /function displayThinkingValueLabel\(value: string\)/);
  assert.match(source, /const compactLabel = compactComposerModelLabel\(displayLabel\);/);
  assert.match(
    source,
    /compact \? \(\s*<>\s*<span className="flex min-w-0 items-center gap-1\.5">[\s\S]*<ProviderBrandIcon[\s\S]*<span className="truncate">\{compactLabel\}<\/span>/,
  );
  assert.match(
    source,
    /const selectedThinkingLabel = displayThinkingValueLabel\(\s*selectedThinkingValue,\s*\);/,
  );
  assert.match(source, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(
    source,
    /aria-label=\{\s*compact \? `Reasoning effort: \$\{selectedThinkingLabel\}` : undefined\s*\}/,
  );
  assert.match(
    source,
    /compact\s*\?\s*showCompactLabel\s*\?\s*"w-full min-w-0 justify-between px-2\.5"\s*:\s*"w-full min-w-0 justify-center px-2\.5"/,
  );
  assert.match(
    source,
    /compact \? \(\s*showCompactLabel \? \(\s*<>\s*<span className="flex min-w-0 items-center gap-1\.5">[\s\S]*<Lightbulb[\s\S]*<span className="truncate">\{selectedThinkingLabel\}<\/span>[\s\S]*<ChevronDown[\s\S]*<\/>\s*\) : \(\s*<span className="flex min-w-0 items-center gap-1\.5">[\s\S]*<Lightbulb[\s\S]*<ChevronDown/,
  );
  assert.match(
    source,
    /<PopoverContent[\s\S]*align="start"[\s\S]*side="top"[\s\S]*sideOffset=\{8\}[\s\S]*className="max-w-40 gap-0 rounded-lg p-1 shadow-xs ring-0"[\s\S]*Reasoning effort[\s\S]*thinkingValues\.map\(\(value\) => renderOption\(value\)\)/,
  );
});

test("chat trace summary only surfaces terminal run failures in the summary label", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const terminalErrorCount = steps\.filter\(\s*\(step\) => step\.kind === "phase" && step\.status === "error"/,
  );
  assert.match(source, /const groupHasTerminalError = terminalErrorCount > 0;/);
  assert.match(
    source,
    /const summarySuffix = groupHasTerminalError[\s\S]*`\s*\(\$\{terminalErrorCount\} failed\)`[\s\S]*:\s*"";/,
  );
  assert.match(
    source,
    /const showLiveSummarySpinner =[\s\S]*\(groupIsLive \|\| runningCount > 0\) && !groupExpanded;/,
  );
  assert.match(
    source,
    /groupHasTerminalError[\s\S]*<AlertTriangle[\s\S]*showLiveSummarySpinner[\s\S]*<Loader2[\s\S]*groupIsLive \|\| runningCount > 0[\s\S]*<Clock3[\s\S]*<Check/,
  );
});

test("chat phase mapping still defines claimed and started bootstrap steps", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /if \(eventType === "run_claimed"\) \{/);
  assert.match(source, /title: "Checking workspace context"/);
  assert.match(source, /if \(eventType === "run_started"\) \{/);
  assert.match(source, /title: "Running"/);
});

test("chat trace summary keeps a live run in progress when no active step label is available", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /<TraceStepGroup[\s\S]*live=\{live\}/);
  assert.match(
    source,
    /const groupIsLive = live && activeStep !== null && !groupHasTerminalError;/,
  );
  assert.match(
    source,
    /runningCount > 0[\s\S]*`Running \$\{stepLabel\}\.\.\.`/,
  );
});

test("chat pane persists terminal run failures in-thread when no assistant text was emitted", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type ChatAssistantSegment =/);
  assert.match(source, /tone\?: "default" \| "error";/);
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
    source,
    /segment\.tone === "error" \?\s*\(\s*<div[\s\S]*theme-chat-system-bubble mt-2 rounded-xl border px-3 py-2\.5 text-xs text-foreground/,
  );
});

test("chat history reconstructs failed turns even when no assistant history message exists", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function inputIdFromHistoryMessage\(message: SessionHistoryMessagePayload\)/);
  assert.match(source, /function turnInputIdsFromHistoryMessages\(/);
  assert.match(source, /const assistantInputIds = turnInputIdsFromHistoryMessages\(historyMessages\);/);
  assert.match(source, /const assistantHistoryInputIds = new Set\(knownAssistantInputIds\);/);
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

test("chat trace collapsed summary surfaces the current active step", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const activeStep =[\s\S]*\.find\(\s*\(step\) => step\.status === "running" \|\| step\.status === "waiting"\s*\)\s*\?\?\s*null;/,
  );
  assert.match(
    source,
    /const latestStep = steps\.length > 0 \? steps\[steps\.length - 1\] : null;/,
  );
  assert.match(
    source,
    /const summaryStep = activeStep \?\? \(groupIsLive \? latestStep : null\);/,
  );
  assert.match(
    source,
    /summaryStep[\s\S]*summaryStep === activeStep \|\| summaryStep\.status === "waiting"[\s\S]*`\$\{traceStatusLabel\(summaryStep\.status\)\}: \$\{summaryStep\.title\}`[\s\S]*groupIsLive[\s\S]*summaryStep\.title/,
  );
  assert.match(
    source,
    /className="flex w-full items-center gap-2 rounded-lg px-2\.5 py-1\.5 -ml-2\.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"/,
  );
  assert.match(source, /<span className="min-w-0 flex-1 leading-5">/);
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

test("chat pane renders live placeholder status as faint text with animated trailing dots", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /aria-live="polite"/);
  assert.match(
    source,
    /const normalizedStatus = \([\s\S]*showExecutionInternals \? status : status \? "Working" : ""[\s\S]*\)\s*\.replace\(\/\\\.\+\$\/, ""\)\s*\.trim\(\);/,
  );
  assert.match(source, /function LiveStatusLine\(/);
  assert.match(source, /const normalizedLabel = label\.replace\(\/\\\.\+\$\/, ""\)\.trim\(\);/);
  assert.match(
    source,
    /className=\{`inline-flex items-baseline gap-0\.5 text-xs leading-6 text-muted-foreground \$\{className\}`\.trim\(\)\}/,
  );
  assert.match(source, /function LiveStatusEllipsis\(\)/);
  assert.match(source, /function TypingStatusLine\(/);
  assert.match(source, /aria-label="Assistant is typing"/);
  assert.match(
    source,
    /className=\{`inline-flex items-center text-\[18px\] leading-none tracking-\[0\.18em\] text-muted-foreground\/78 \$\{className\}`\.trim\(\)\}/,
  );
  assert.match(source, /@keyframes status-dot-wave/);
  assert.match(source, /30% \{ transform: translateY\(-3px\); \}/);
  assert.match(source, /animation: "status-dot-wave 1200ms ease-in-out infinite"/);
  assert.match(source, /animationDelay: `\$\{index \* 120\}ms`/);
  assert.doesNotMatch(source, /Preparing first question\.\.\./);
  assert.doesNotMatch(source, /Queued\.\.\./);
  assert.doesNotMatch(source, /Working\.\.\./);
  assert.doesNotMatch(source, /Checking workspace context\.\.\./);
});

test("chat pane keeps a persistent working line only for trace-visible live turns after content starts", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const showWorkingStatusLine =\s*live &&\s*showExecutionInternals &&\s*renderedSegments\.length > 0;/,
  );
  assert.match(
    source,
    /showStatusPlaceholder =[\s\S]*live &&[\s\S]*Boolean\(normalizedStatus\) &&[\s\S]*renderedSegments\.length === 0;/,
  );
  assert.match(
    source,
    /{showWorkingStatusLine[\s\S]*renderStatusLine\(\s*"Working",[\s\S]*renderedSegments\.some\(\(segment\) => segment\.kind === "execution"\)/,
  );
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
    /status === "WAITING_USER" \|\| status === "PAUSED"[\s\S]*commitLiveAssistantMessage\(\);[\s\S]*scheduleConversationRefresh\(normalizedCurrentSessionId, selectedWorkspaceId\);/,
  );
  assert.match(
    source,
    /const attachPendingWithoutStream = Boolean\(\s*pendingInputId && !activeStreamId,\s*\);[\s\S]*if \(attachPendingWithoutStream\) \{\s*return;\s*\}/,
  );
});

test("chat pane renders an execution timeline that interleaves thinking segments with trace entries", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type ChatAssistantSegment =/);
  assert.match(source, /executionItems\?: ChatExecutionTimelineItem\[];/);
  assert.match(source, /segments\?: ChatAssistantSegment\[];/);
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
    source,
    /function ExecutionTimelineThinkingEntry[\s\S]*className="py-1"[\s\S]*className="-ml-2\.5 w-\[calc\(100%\+0\.625rem\)\] rounded-xl border border-border bg-muted px-3\.5 py-3"/,
  );
  assert.match(
    source,
    /function ExecutionTimelineThinkingEntry[\s\S]*className="chat-markdown chat-thinking-markdown max-w-full text-foreground"/,
  );
  assert.match(source, /<AssistantTurn[\s\S]*segments=\{message\.segments \?\? \[\]\}/);
  assert.match(source, /<AssistantTurn[\s\S]*segments=\{renderedLiveAssistantSegments\}/);
  assert.match(source, /\{renderedSegments\.map\(\(segment, index\) =>/);
  assert.match(source, /segment\.kind === "execution" \?\s*\(\s*<TraceStepGroup/);
  assert.match(source, /<ExecutionTimelineThinkingEntry/);
  assert.match(source, /<TraceTimelineStepEntry/);
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
    /const showSessionExecutionInternals = shouldShowExecutionInternalsForSession\(\s*activeSessionId,\s*\);/,
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
    source,
    /selectedLabel: needsProviderPrefix[\s\S]*\? `\$\{providerGroup\.providerLabel\} · \$\{modelLabel\}`[\s\S]*: modelLabel/,
  );
  assert.match(
    source,
    /searchText: `\$\{providerGroup\.providerLabel\} \$\{modelLabel\} \$\{model\.token\}`/,
  );
  assert.match(source, /const filteredOptionGroups = useMemo\(/);
  assert.match(
    source,
    /modelOptionGroups\.length > 0[\s\S]*\? modelOptionGroups[\s\S]*: \[\{ label: "", options: modelOptions }\]/,
  );
  assert.match(source, /group\.label \? \(/);
  assert.match(source, /text-\[10px\] font-medium uppercase text-muted-foreground/);
  assert.doesNotMatch(source, /filteredOptions\.map/);
});

test("chat pane does not suppress claude options for the holaboss proxy fallback path", async () => {
  const source = await readFile(sourcePath, "utf8");
  const presetBlock =
    source.match(/const CHAT_MODEL_PRESETS = \[[\s\S]*?\] as const;/)?.[0] ?? "";

  assert.doesNotMatch(presetBlock, /claude-/);
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
    source,
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
    source,
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
    source,
    /function normalizeClipboardAttachmentFile\(file: File, index: number\): File/,
  );
  assert.match(
    source,
    /const baseName = file\.type\.startsWith\("image\/"\)\s*\?\s*`pasted-image-\$\{index \+ 1\}`\s*:\s*`pasted-file-\$\{index \+ 1\}`;/,
  );
  assert.match(
    source,
    /function clipboardFilesFromDataTransfer\(\s*dataTransfer: DataTransfer \| null,\s*\): File\[\]/,
  );
  assert.match(source, /function fileFromClipboardImagePayload\(\s*payload: ClipboardImagePayload \| null,\s*\): File \| null/);
  assert.match(source, /window\.electronAPI\.clipboard\.readImage\(\)/);
  assert.match(source, /function explorerAttachmentFilesFromClipboardText\(\s*clipboardText: string,\s*\): ExplorerAttachmentDragPayload\[\]/);
  assert.match(source, /getExplorerAttachmentClipboardEntry\(\)/);
  assert.match(
    source,
    /dataTransfer\.files\.length > 0\s*\?\s*Array\.from\(dataTransfer\.files\)/,
  );
  assert.match(
    source,
    /const handleTextareaPaste = \(event: ClipboardEvent<HTMLTextAreaElement>\) => \{/,
  );
  assert.match(
    source,
    /const pastedFiles = clipboardFilesFromDataTransfer\(event\.clipboardData\);/,
  );
  assert.match(source, /const explorerFiles =\s*explorerAttachmentFilesFromClipboardText\(clipboardText\);/);
  assert.match(source, /onAddExplorerAttachments\(explorerFiles\);/);
  assert.match(source, /const hasClipboardImageType = clipboardTypes\.some\(/);
  assert.match(source, /clipboardImageFileFromElectronClipboard\(\)/);
  assert.match(source, /onAddDroppedFiles\(\[file\]\);/);
  assert.match(source, /event\.preventDefault\(\);/);
  assert.match(source, /onAddDroppedFiles\(pastedFiles\);/);
  assert.match(source, /onPaste=\{handleTextareaPaste\}/);
});

test("chat pane filters managed catalog entries that are not chat-capable", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function runtimeModelHasChatCapability\(model: RuntimeProviderModelPayload\)/);
  assert.match(source, /const capabilities = runtimeModelCapabilities\(model\);/);
  assert.match(source, /return capabilities.length === 0 \|\| capabilities.includes\("chat"\);/);
  assert.match(source, /if \(!runtimeModelHasChatCapability\(model\)\) \{\s*return false;\s*\}/);
});

test("chat pane prefixes run failures with provider and model context", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function runFailedContextLabel\(payload: Record<string, unknown>\): string/);
  assert.match(source, /function runFailedDetail\(payload: Record<string, unknown>\): string/);
  assert.match(
    source,
    /return detail\.startsWith\(contextLabel\)\s*\?\s*detail\s*:\s*`\$\{contextLabel\}: \$\{detail\}`;/,
  );
  assert.match(source, /const errorText = runFailedDetail\(payload\);/);
  assert.match(source, /const detail = runFailedDetail\(eventPayload\);/);
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
    /async function createWorkspaceSession\(\s*workspaceId: string,\s*parentSessionId\?: string \| null,\s*\): Promise<string \| null>/,
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
    /if \(!targetSessionId && selectedWorkspace\) \{[\s\S]*targetSessionId = await createWorkspaceSession\(\s*selectedWorkspace\.id,[\s\S]*pendingSessionTarget\?\.mode === "draft"[\s\S]*\? pendingSessionTarget\.parentSessionId[\s\S]*: draftParentSessionIdRef\.current,/,
  );
});

test("chat pane exposes an in-pane session dropdown for switching agent sessions", async () => {
  const source = await readFile(sourcePath, "utf8");
  const chatHeaderSource = await readFile(chatHeaderSourcePath, "utf8");

  assert.match(source, /onOpenInbox\?: \(\) => void;/);
  assert.match(source, /onOpenSessions\?: \(\) => void;/);
  assert.match(source, /inboxUnreadCount\?: number;/);
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
  assert.match(source, /const openPrimaryControllerSession = async \(\) => \{/);
  assert.match(
    source,
    /isOnboardingVariant \? "Onboarding session" : "Main session"/,
  );
  assert.match(chatHeaderSource, /aria-label="Main session"/);
  assert.match(chatHeaderSource, /<TooltipContent>Main session<\/TooltipContent>/);
  assert.match(
    source,
    /Return to the onboarding session to continue the conversation\./,
  );
  assert.match(source, /const handleOpenReadOnlyAgentSession = \(/);
  assert.match(source, /setLocalSessionOpenRequestState\(\{\s*sessionId: mainSessionId,\s*requestKey: Date\.now\(\),\s*readOnly: false,\s*\}\);/);
  assert.match(source, /setLocalSessionOpenRequestState\(\{\s*sessionId,\s*requestKey: Date\.now\(\),\s*readOnly: true,\s*\}\);/);
  assert.match(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.match(chatHeaderSource, /aria-label="Sessions"/);
  assert.match(chatHeaderSource, /aria-label="Inbox"/);
  assert.match(chatHeaderSource, /inboxUnreadCount > 0 \? \(/);
  assert.match(chatHeaderSource, /onClick=\{\(\) => onOpenInbox\(\)\}/);
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
    /if \(!cancelled\) \{\s*if \(!historyLoaded\) \{\s*cancelHistoryViewportRestore\(\);\s*\}\s*setIsLoadingHistory\(false\);\s*consumeSessionOpenRequest\(requestKey\);\s*\}/,
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
    /if \(pendingSessionTarget\) \{\s*consumeSessionOpenRequest\(pendingSessionTarget\.requestKey\);\s*clearSessionView\(\);[\s\S]*setActiveSession\(pendingSessionTarget\.sessionId\);[\s\S]*draftParentSessionIdRef\.current = pendingSessionTarget\.parentSessionId;\s*setActiveSession\(null\);/,
  );
  assert.match(
    source,
    /if \(!targetSessionId && selectedWorkspace\) \{\s*targetSessionId = await createWorkspaceSession\(\s*selectedWorkspace\.id,\s*pendingSessionTarget\?\.mode === "draft"\s*\?\s*pendingSessionTarget\.parentSessionId\s*:\s*draftParentSessionIdRef\.current,\s*\);/,
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

  assert.match(source, /let historyLoaded = false;\s*beginHistoryViewportRestore\(\);\s*setIsLoadingHistory\(true\);/);
  assert.match(
    source,
    /finally \{[\s\S]*if \(!cancelled\) \{[\s\S]*if \(!historyLoaded\) \{[\s\S]*cancelHistoryViewportRestore\(\);[\s\S]*\}[\s\S]*setIsLoadingHistory\(false\);[\s\S]*consumeSessionOpenRequest\(requestKey\);[\s\S]*\}[\s\S]*\}/,
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
  assert.match(source, /function HistoryRestoreSkeleton\(\)/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{[\s\S]*container\.scrollTo\(\{\s*top: container\.scrollHeight,\s*behavior: "auto",\s*\}\);[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*setIsHistoryViewportPending\(false\);[\s\S]*\}\);[\s\S]*\}, \[historyViewportRestoreGeneration, isHistoryViewportPending\]\);/,
  );
  assert.match(
    source,
    /behavior:\s*isResponding \|\| isHistoryViewportPending \? "auto" : "smooth"/,
  );
  assert.match(
    source,
    /const showHistoryRestoreScreen =\s*isLoadingHistory \|\| isHistoryViewportPending;/,
  );
  assert.match(source, /role="status"/);
  assert.match(source, /aria-label="Loading conversation"/);
  assert.match(source, /animate-pulse/);
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
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const composerIsComposingRef = useRef\(false\);/);
  assert.match(
    source,
    /if \(\s*composerIsComposingRef\.current \|\|[\s\S]*nativeEvent\.isComposing === true \|\|[\s\S]*nativeEvent\.keyCode === 229[\s\S]*\) \{\s*return;\s*\}/,
  );
  assert.match(source, /const onComposerCompositionStart = \([\s\S]*composerIsComposingRef\.current = true;/);
  assert.match(source, /const onComposerCompositionEnd = \([\s\S]*composerIsComposingRef\.current = false;/);
  assert.match(source, /<Composer[\s\S]*onCompositionStart=\{onComposerCompositionStart\}[\s\S]*onCompositionEnd=\{onComposerCompositionEnd\}/);
  assert.match(source, /<textarea[\s\S]*onCompositionStart=\{onCompositionStart\}[\s\S]*onCompositionEnd=\{onCompositionEnd\}/);
});

test("chat turns render markdown and keep long content wrapped inside the bubble", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{ SimpleMarkdown \} from "@\/components\/marketplace\/SimpleMarkdown";/);
  assert.match(source, /onOpenLinkInBrowser\?: \(url: string\) => void;/);
  assert.match(source, /onLinkClick=\{onOpenLinkInBrowser\}/);
  assert.match(
    source,
    /<SimpleMarkdown[\s\S]*className="chat-markdown chat-user-markdown max-w-full"[\s\S]*onLinkClick=\{onLinkClick\}[\s\S]*\{text\}[\s\S]*<\/SimpleMarkdown>/,
  );
  assert.match(source, /<SimpleMarkdown[\s\S]*className="chat-markdown chat-assistant-markdown mt-2 max-w-full text-foreground"[\s\S]*onLinkClick=\{onLinkClick\}[\s\S]*\{text\}[\s\S]*<\/SimpleMarkdown>/);
  assert.match(source, /theme-chat-user-bubble inline-flex min-w-0 max-w-full/);
});

test("user turns expose a hover footer with copy and timestamp metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /createdAt\?: string;/);
  assert.match(source, /function chatMessageTimeLabel\(value: string \| null \| undefined\): string/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /document\.execCommand\("copy"\)/);
  assert.match(source, /const timeLabel = chatMessageTimeLabel\(createdAt\);/);
  assert.match(source, /className="group\/user-turn flex min-w-0 justify-end"/);
  assert.match(
    source,
    /group-hover\/user-turn:opacity-100[\s\S]*group-hover\/user-turn:pointer-events-auto[\s\S]*group-focus-within\/user-turn:opacity-100/,
  );
  assert.match(source, /aria-label=\{\s*copyFeedbackVisible[\s\S]*"Copy user message"/);
  assert.match(source, /<Copy className="size-3\.5" strokeWidth=\{1\.9\} \/>/);
  assert.match(source, /<Check className="size-3\.5" strokeWidth=\{1\.9\} \/>/);
  assert.match(source, /createdAt: message\.created_at \|\| undefined,/);
  assert.match(source, /const queuedMessageCreatedAt = new Date\(\)\.toISOString\(\);/);
  assert.match(source, /createdAt=\{message\.createdAt\}/);
});

test("chat thread uses the full pane width for normal messages", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /className=\{`chat-scrollbar-hidden h-full min-h-0 overflow-x-hidden overflow-y-auto \$\{hasMessages \? "" : "flex items-center justify-center"\}`\}/);
  assert.match(source, /messagesContentRef\}[\s\S]*className=\{`flex min-w-0 w-full flex-col gap-4 px-4 pb-3 pt-5 \$\{\s*showHistoryRestoreScreen \? "invisible" : ""\s*\}`\}/);
  assert.match(source, /<form onSubmit=\{onSubmit\} className="w-full">/);
  assert.match(source, /className=\{`flex min-w-0 justify-start \$\{showSeparator \? "mt-2" : ""\}`\.trim\(\)\}[\s\S]*<article[\s\S]*className=\{`min-w-0 w-full max-w-4xl/);
  assert.match(source, /className="group\/user-turn flex min-w-0 justify-end"[\s\S]*max-w-\[420px\][\s\S]*sm:max-w-\[560px\][\s\S]*lg:max-w-\[680px\]/);
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

test("chat pane surfaces context-budget diagnostics from terminal event payloads", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function contextBudgetDetails\(/);
  assert.match(source, /Prompt lanes trimmed/);
  assert.doesNotMatch(source, /Tool replay clipped/);
  assert.match(source, /Retrieval-only continuity mode/);
  assert.match(source, /Checkpoint compaction queued/);
  assert.match(
    source,
    /if \(budgetDetails\.length > 0\) \{\s*return \{\s*id: "phase:context-budget",[\s\S]*title: "Context budget"/,
  );
});

test("view all artifacts modal sorts artifacts newest first", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function dedupeOutputsForDisplay\(outputs: WorkspaceOutputRecordPayload\[\]\)/);
  assert.match(source, /function outputDisplayDedupeKey\(output: WorkspaceOutputRecordPayload\)/);
  assert.match(source, /function outputDisplayPriority\(output: WorkspaceOutputRecordPayload\)/);
  assert.match(
    source,
    /function sortOutputsLatestFirst\(outputs: WorkspaceOutputRecordPayload\[\]\)/,
  );
  assert.match(
    source,
    /const allDisplayOutputs =\s*outputs\.length > 1 \? dedupeOutputsForDisplay\(outputs\) : outputs;/,
  );
  assert.match(
    source,
    /const filteredOutputs = sortOutputsLatestFirst\(\s*filter === "all"\s*\?\s*allDisplayOutputs\s*:\s*allDisplayOutputs\.filter\(/,
  );
  assert.match(
    source,
    /if \(leftTime !== rightTime\) \{\s*return rightTime - leftTime;\s*\}/,
  );
  assert.match(
    source,
    /const \[artifactBrowserScope, setArtifactBrowserScope\] =\s*useState<\s*"session" \| "reply"\s*>\("session"\);/,
  );
  assert.match(source, /scope=\{artifactBrowserScope\}/);
  assert.match(
    source,
    /\{allDisplayOutputs\.length === 1 \? "" : "s"\}\{" "\}\s*\{scope === "reply"[\s\S]*"attached to this reply"[\s\S]*: "in this session"\}/,
  );
});

test("artifact rows include timestamp metadata in both inline and modal lists", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const timeLabel = chatMessageTimeLabel\(output\.created_at\);/);
  assert.match(
    source,
    /if \(timeLabel\) \{\s*parts\.push\(timeLabel\);\s*\}/,
  );
  assert.match(
    source,
    /<div className="truncate text-xs text-muted-foreground">\s*\{outputSecondaryLabel\(output\)\}\s*<\/div>/,
  );
  assert.match(
    source,
    /<div className="truncate text-xs text-muted-foreground">\s*\{outputSecondaryLabel\(output\)\}\s*<\/div>/,
  );
  assert.match(
    source,
    /const displayOutputs =\s*outputs\.length > 1 \? dedupeOutputsForDisplay\(outputs\) : outputs;/,
  );
  assert.match(source, /\{displayOutputs\.map\(\(output\) => \(/);
  assert.match(source, /View artifacts in this reply \(\{displayOutputs\.length\}\)/);
});

test("tool trace steps are collapsed by default and first toggle expands them", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /return collapsedTraceByStepId\[step\.id\] \?\? true;/);
  assert.match(source, /\[stepId\]: !\(prev\[stepId\] \?\? true\)/);
  assert.doesNotMatch(source, /\[step\.id\]: false/);
});

test("live trace auto-expands during the run and collapses when output starts", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /function TraceStepGroup\(\{[\s\S]*items,[\s\S]*live = false,[\s\S]*liveOutputStarted = false,/,
  );
  assert.match(source, /const steps = traceStepsFromExecutionItems\(items\);/);
  assert.match(
    source,
    /const \[groupExpanded, setGroupExpanded\] = useState\(\s*live && !liveOutputStarted,\s*\);/,
  );
  assert.match(
    source,
    /if \(live && !previousLiveRef\.current\) \{\s*setGroupExpanded\(!liveOutputStarted\);\s*\}/,
  );
  assert.match(
    source,
    /if \(live && liveOutputStarted && !previousLiveOutputStartedRef\.current\) \{\s*setGroupExpanded\(false\);\s*\}/,
  );
  assert.match(
    source,
    /const showLiveSummarySpinner =[\s\S]*\(groupIsLive \|\| runningCount > 0\) && !groupExpanded;/,
  );
  assert.match(
    source,
    /const activeStep =[\s\S]*step\.status === "running" \|\| step\.status === "waiting"[\s\S]*const groupIsLive = live && activeStep !== null && !groupHasTerminalError;/,
  );
  assert.match(
    source,
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
    /const nextSessionId =[\s\S]*\(hasSessionJumpRequest && requestedSessionId[\s\S]*\?\s*requestedSessionId[\s\S]*:\s*null\)[\s\S]*mainSessionResponse\.session\?\.session_id\?\.trim\(\)[\s\S]*\|\|\s*null;/,
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
    source,
    /\{isResponding \? \(\s*<Button[\s\S]*onClick=\{onPause\}[\s\S]*>\s*\{pausePending \? \(\s*<Loader2[\s\S]*\) : \(\s*<Square[\s\S]*\)\}\s*Pause\s*<\/Button>\s*\) : null\}[\s\S]*<Button[\s\S]*aria-label=\{isResponding \? "Queue message" : "Send message"\}[\s\S]*<ArrowUp/,
  );
  assert.match(source, /disabled=\{pausePending \|\| pauseDisabled \|\| disabled\}/);
});

test("chat composer supports ctrl-c draft cancel and arrow-up recall", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface ComposerInputRecallSnapshot \{/);
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
    /setInput\(""\);\s*setQuotedSkillIds\(\[\]\);\s*setPendingAttachments\(\[\]\);\s*setAttachmentGateMessage\(""\);/,
  );
  assert.match(source, /function recallLatestComposerInput\(\)/);
  assert.match(
    source,
    /setInput\(recallableInput\.text\);[\s\S]*textarea\.focus\(\);[\s\S]*textarea\.setSelectionRange\(cursorPosition, cursorPosition\);/,
  );
  assert.match(source, /rememberSubmittedComposerInput\(text, selectedWorkspace\.id\);/);
  assert.match(
    source,
    /event\.key\.toLowerCase\(\) === "c"[\s\S]*event\.ctrlKey[\s\S]*cancelComposerDraftFromKeyboard\(\)[\s\S]*event\.preventDefault\(\);/,
  );
  assert.match(
    source,
    /event\.key === "ArrowUp"[\s\S]*quotedSkillIds\.length === 0[\s\S]*pendingAttachments\.length === 0[\s\S]*selectionStart === 0[\s\S]*selectionEnd === 0[\s\S]*recallLatestComposerInput\(\)[\s\S]*event\.preventDefault\(\);/,
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
    /const statusPlaceholderLabel =[\s\S]*normalizedStatus\.toLowerCase\(\) === "checking workspace context"[\s\S]*\?\s*"Working"\s*:\s*normalizedStatus;/,
  );
  assert.match(
    assistantTurnSource,
    /const showStatusPlaceholder =[\s\S]*live &&[\s\S]*Boolean\(statusPlaceholderLabel\) &&[\s\S]*renderedSegments\.length === 0;/,
  );
  assert.match(
    assistantTurnSource,
    /\{showStatusPlaceholder[\s\S]*renderStatusLine\(statusPlaceholderLabel\)[\s\S]*: null\}/,
  );
});

test("assistant turns can use a soft structural band without adding bubble chrome", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /displayMessages\.map\(\(message, index\) =>/);
  assert.match(source, /showSeparator=\{index > 0\}/);
  assert.match(source, /showSeparator=\{displayMessages\.length > 0\}/);
  assert.match(source, /showSeparator = false,/);
  assert.match(source, /showSeparator\?: boolean;/);
  assert.match(
    source,
    /className=\{`flex min-w-0 justify-start \$\{showSeparator \? "mt-2" : ""\}`\.trim\(\)\}/,
  );
  assert.match(
    source,
    /className=\{`min-w-0 w-full max-w-4xl \$\{\s*showSeparator \? "rounded-\[1\.75rem\] bg-muted\/35 px-5 py-4" : ""\s*\}`\.trim\(\)\}/,
  );
});

test("main-session assistant turns are labeled as Hola", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const assistantLabel = isViewingBoundMainSession \? "Hola" : activeSessionTitle;/,
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
    /quotedSkillIds\.length === 0\) \|\|\s*isSubmittingMessage/,
  );
  assert.match(
    source,
    /const queueOntoActiveRun =[\s\S]*\(isResponding[\s\S]*Boolean\(activeStreamIdRef\.current\)[\s\S]*Boolean\(pendingInputIdRef\.current\)\)[\s\S]*targetSessionId === activeSessionIdRef\.current;/,
  );
  assert.match(
    source,
    /if \(!queueOntoActiveRun\) \{[\s\S]*setMessages\(\(prev\) => \[\.\.\.prev, userMessage\]\);[\s\S]*\}/,
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
  assert.match(source, /function queuedSessionInputPreviewText\(item: QueuedSessionInput\)/);
  assert.match(source, /async function updateQueuedSessionInputText\(/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.updateQueuedSessionInput\(\s*\{\s*workspace_id: item\.workspaceId,\s*session_id: item\.sessionId,\s*input_id: item\.inputId,\s*text: serializedText,\s*\},?\s*\)/,
  );
  assert.match(source, /function QueuedSessionInputRail\(/);
  assert.match(
    source,
    /<QueuedSessionInputRail[\s\S]*items=\{displayedQueuedSessionInputs\}[\s\S]*onEditItem=\{[\s\S]*updateQueuedSessionInputText[\s\S]*\}[\s\S]*<Composer/,
  );
  assert.match(source, /children: ReactNode;/);
  assert.match(source, /const panelInsetPx = \d+;/);
  assert.match(source, /const panelHeightPx = \d+;/);
  assert.match(source, /const queueViewportHeightPx = \d+;/);
  assert.match(source, /className="pointer-events-none absolute inset-x-0 top-0"/);
  assert.match(source, /className="pointer-events-auto absolute inset-x-0 overflow-hidden rounded-3xl/);
  assert.match(source, /className="overflow-y-auto pr-1\.5"/);
  assert.match(source, /\{items\.map\(\(item\) => \{/);
  assert.match(
    source,
    /<CornerDownLeft[\s\S]*className="size-4 shrink-0 text-muted-foreground"/,
  );
  assert.match(source, /aria-label="Edit queued message"/);
  assert.match(source, /aria-label="Save queued message edit"/);
  assert.match(source, /aria-label="Cancel queued message edit"/);
  assert.match(source, /className="relative z-10 rounded-3xl bg-background"/);
  assert.match(source, /style=\{\{\s*marginTop: `\$\{-overlapPx\}px`\s*\}\}/);
  assert.doesNotMatch(source, /Queued messages/);
  assert.doesNotMatch(source, /Up next/);
  assert.doesNotMatch(source, /Sending next/);
  assert.match(source, /const inputDisabled = disabled;/);
  assert.match(source, /if \(!dataTransfer \|\| disabled\) \{/);
});

test("chat pane exposes a queued message preview hook for dev console inspection", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const QUEUED_MESSAGES_PREVIEW_EVENT =\s*"holaboss:queued-messages-preview-change";/,
  );
  assert.match(source, /__holabossQueuedMessagesPreviewState\?: QueuedSessionInputPreviewDescriptor\[\];/);
  assert.match(source, /__holabossDevQueuedMessagesPreview\?: \{/);
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
    /!isReadOnlyInspectionSession \? \(\s*<div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">[\s\S]*<BackgroundTasksPane[\s\S]*workspaceId=\{controllerBackgroundTasksWorkspaceId\}[\s\S]*ownerMainSessionId=\{[\s\S]*controllerBackgroundTasksOwnerMainSessionId[\s\S]*\}[\s\S]*variant="inline"[\s\S]*\) : null/,
  );
  assert.doesNotMatch(
    source,
    /!isOnboardingVariant && !isReadOnlyInspectionSession \? \(\s*<SubagentSessionsPane[\s\S]*variant="inline"[\s\S]*\) : null/,
  );
  assert.match(source, /const handleOpenReadOnlyAgentSession = \(/);
  assert.match(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.match(
    source,
    /className=\{`mx-auto flex min-w-0 w-full \$\{CHAT_LAYOUT\.contentMaxWidth\} flex-col gap-2 pl-4 pr-7 pb-3 pt-5 \$\{\s*showHistoryRestoreScreen \? "invisible" : ""\s*\}`\}/,
  );
  assert.match(
    source,
    /className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4"/,
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
  assert.match(source, /lastChatScrollTopRef\.current = target\.scrollTop;/);
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

test("chat pane custom scrollbar thumb can be dragged", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const chatScrollbarDragStateRef = useRef<ChatScrollbarDragState \| null>\(/,
  );
  assert.match(
    source,
    /function updateChatScrollFromScrollbarPointer\([\s\S]*container\.scrollTop = nextScrollTop;[\s\S]*scheduleChatScrollMetricsSync\(container\);/,
  );
  assert.match(
    source,
    /event\.currentTarget\.setPointerCapture\(event\.pointerId\);/,
  );
  assert.match(source, /data-chat-scrollbar-thumb="true"/);
  assert.match(source, /onPointerDown=\{handleChatScrollbarPointerDown\}/);
  assert.match(source, /onPointerMove=\{handleChatScrollbarPointerMove\}/);
  assert.match(
    source,
    /onLostPointerCapture=\{\(\) => \{\s*clearChatScrollbarDragState\(\);\s*\}\}/,
  );
});

test("chat pane offers an explicit jump-to-browser CTA instead of auto-switching the visible agent browser session", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface ChatPaneBrowserJumpRequest \{/);
  assert.match(source, /browserJumpRequest\?: ChatPaneBrowserJumpRequest \| null;/);
  assert.match(
    source,
    /onBrowserJumpRequestConsumed\?:\s*\(\s*sessionId: string,\s*requestKey: number,\s*\) => void;/,
  );
  assert.match(source, /onJumpToSessionBrowser\?: \(sessionId: string, requestKey: number\) => void;/);
  assert.match(
    source,
    /const \[visibleBrowserState,\s*setVisibleBrowserState\] =\s*useState<\s*BrowserTabListPayload\s*>\(\(\) => initialBrowserState\("user"\)\);/,
  );
  assert.match(source, /const applyVisibleBrowserState = \(state: BrowserTabListPayload\) => \{/);
  assert.match(source, /window\.electronAPI\.browser\.getState\(\)\.then\(applyVisibleBrowserState\);/);
  assert.match(
    source,
    /window\.electronAPI\.browser\.onStateChange\(\s*applyVisibleBrowserState,\s*\);/,
  );
  assert.match(
    source,
    /const visibleAgentBrowserSessionId =[\s\S]*visibleBrowserState\.space === "agent"[\s\S]*\?\s*visibleBrowserState\.controlSessionId \|\|[\s\S]*visibleBrowserState\.sessionId \|\|[\s\S]*""[\s\S]*:\s*"";/,
  );
  assert.match(
    source,
    /const showSessionBrowserJumpCta = Boolean\(\s*browserJumpRequest &&\s*activeSessionId &&\s*browserJumpRequest\.sessionId === activeSessionId &&\s*\(visibleBrowserState\.space !== "agent" \|\|\s*visibleAgentBrowserSessionId !== activeSessionId\),\s*\);/,
  );
  assert.match(
    source,
    /onBrowserJumpRequestConsumed\?\.\(\s*activeSessionId,\s*browserJumpRequest\.requestKey,\s*\);/,
  );
  assert.match(
    source,
    /onJumpToSessionBrowser\?\.\(\s*browserJumpRequest\.sessionId,\s*browserJumpRequest\.requestKey,\s*\);/,
  );
  assert.match(source, /statusAccessory = null,/);
  assert.match(source, /statusAccessory\?: ReactNode;/);
  assert.match(
    source,
    /const renderStatusLine = \(nextLabel: string, className = ""\) => \{/,
  );
  assert.match(
    source,
    /if \(!statusAccessory\) \{\s*return <LiveStatusLine label=\{nextLabel\} className=\{className\} \/>\s*;\s*\}/,
  );
  assert.doesNotMatch(source, /showLiveAssistantTurn \|\|\s*showSessionBrowserJumpCta/);
  assert.doesNotMatch(source, /This session started using its browser\./);
  assert.match(source, /View in agent browser/);
  assert.match(
    source,
    /const sessionBrowserJumpCta = showSessionBrowserJumpCta \? \(/,
  );
  assert.match(
    source,
    /statusAccessory=\{sessionBrowserJumpCta\}/,
  );
  assert.match(
    source,
    /footerAccessory=\{\s*message\.id === lastCompletedAssistantMessageId\s*\?\s*sessionBrowserJumpCta\s*:\s*null\s*\}/,
  );
  assert.match(
    source,
    /const lastCompletedAssistantMessageId = useMemo\(/,
  );
});

test("chat pane preserves the status placeholder while a queued stream attachment is still pending", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const showStatusPlaceholder =\s*live && Boolean\(normalizedStatus\) && renderedSegments\.length === 0;/,
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
    source,
    /\{showStatusPlaceholder \? renderStatusLine\(normalizedStatus\) : null\}/,
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
    /if \(shouldAttachAutonomousRun\) \{[\s\S]*await loadSessionConversation\(mainSessionId, workspaceId, runtimeStates\.items, \{[\s\S]*readOnly: false,[\s\S]*\}\);[\s\S]*return true;\s*\}/,
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
    source,
    /const MAIN_SESSION_EVENT_BATCH_HEADER =\s*"\[Holaboss Main Session Event Batch v1\]";/,
  );
  assert.match(
    source,
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
    /const renderedMessagesForDisplay =\s*shouldAttachLiveRunStream && currentRuntimeInputId\s*\?\s*page\.renderedMessages\.filter\(\s*\(message\) =>\s*message\.role !== "assistant" \|\|\s*inputIdFromMessageId\(message\.id, "assistant"\) !==\s*currentRuntimeInputId,\s*\)\s*:\s*page\.renderedMessages;/,
  );
  assert.match(
    source,
    /setMessages\(\s*mergePendingOptimisticUserMessages\(\s*renderedMessagesForDisplay,/,
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

  assert.match(source, /interface PendingOptimisticUserMessage \{/);
  assert.match(source, /localMessageId: string;/);
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
    /const reconciledPendingOptimisticUserMessages =[\s\S]*reconcilePendingOptimisticUserMessages\(\s*pendingOptimisticUserMessagesRef\.current,[\s\S]*persistedInputIds,[\s\S]*\);/,
  );
  assert.match(
    source,
    /setMessages\(\s*mergePendingOptimisticUserMessages\([\s\S]*renderedMessagesForDisplay,[\s\S]*reconciledPendingOptimisticUserMessages,[\s\S]*sessionId: nextSessionId,[\s\S]*\)\s*\);/,
  );
  assert.match(
    source,
    /if \(!queueOntoActiveRun && optimisticUserMessageId\) \{[\s\S]*prev\.filter\(\(message\) => message\.id !== optimisticUserMessageId\)[\s\S]*item\.localMessageId !== optimisticUserMessageId/,
  );
});
