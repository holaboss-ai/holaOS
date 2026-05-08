import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);

test("app shell routes file outputs into the explorer and universal display while keeping chat active", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const target = workspaceOutputNavigationTarget\(output, installedAppIds\);/
  );
  assert.match(
    source,
    /if \(\s*\(target\.surface === "document" \|\|\s*target\.surface === "file"\) &&\s*target\.resourceId\?\.trim\(\)\s*\) \{/
  );
  assert.match(source, /setSpaceWorkspacePanelCollapsed\(false\);/);
  assert.match(
    source,
    /setSpaceVisibility\(\(previous\) => \(\{\s*\.\.\.previous,\s*agent: true,\s*files: true,\s*\}\)\);/
  );
  assert.match(source, /setSpaceExplorerMode\("files"\);/);
  assert.match(source, /setAgentView\(\{ type: "chat" \}\);/);
  assert.match(
    source,
    /setSpaceDisplayView\(\{\s*type: "internal",\s*surface: target\.surface,\s*resourceId: target\.resourceId,\s*\}\);/
  );
  assert.match(
    source,
    /setFileExplorerFocusRequest\(\{\s*path: target\.resourceId,\s*requestKey: Date\.now\(\),\s*\}\);/
  );
});

test("app shell routes app outputs into the applications explorer and app surface", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const platformId = \(output\.platform \|\| ""\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(source, /presentation\?\.kind === "app_resource" && presentation\.view/);
  assert.match(
    source,
    /const looksLikeAppBackedDraft =[\s\S]*output\.output_type === "post"[\s\S]*artifact_type[\s\S]*=== "draft"/,
  );
  assert.match(
    source,
    /const appId =[\s\S]*moduleId && installedAppIds\.has\(moduleId\)[\s\S]*\? moduleId/,
  );
  assert.match(
    source,
    /\(hasAppPresentation \|\| looksLikeAppBackedDraft\) &&[\s\S]*platformId &&[\s\S]*installedAppIds\.has\(platformId\)[\s\S]*\? platformId/,
  );
  assert.match(source, /const handleOpenSpaceApp = useCallback\(/);
  assert.match(source, /setSpaceWorkspacePanelCollapsed\(false\);/);
  assert.match(source, /setSpaceExplorerMode\("applications"\);/);
  assert.match(
    source,
    /setSpaceDisplayView\(\{\s*type: "app",\s*appId,\s*path: options\?\.path,\s*resourceId: options\?\.resourceId,\s*view: options\?\.view,\s*\}\);/,
  );
  assert.match(
    source,
    /if \(target\.type === "app"\) \{\s*handleOpenSpaceApp\(target\.appId,\s*\{\s*path: target\.path,\s*resourceId: target\.resourceId,\s*view: target\.view,\s*resetAgentView: true,\s*\}\);/,
  );
  assert.doesNotMatch(source, /window\.electronAPI\.appSurface\.resolveUrl/);
});

test("app shell restores the last app surface when returning to the applications explorer lane", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /type RestorableSpaceAppDisplayView = Extract<SpaceDisplayView, \{ type: "app" \}>;/,
  );
  assert.match(
    source,
    /const lastRestorableSpaceAppDisplayViewByWorkspaceRef =\s*useRef<\s*Record<string, RestorableSpaceAppDisplayView>\s*>\(\{\}\);/,
  );
  assert.match(
    source,
    /if \(!selectedWorkspaceId \|\| spaceDisplayView\.type !== "app"\) \{\s*return;\s*\}\s*lastRestorableSpaceAppDisplayViewByWorkspaceRef\.current\[\s*selectedWorkspaceId\s*\]\s*=\s*spaceDisplayView;/,
  );
  assert.match(
    source,
    /const restoreLastSpaceAppDisplayView = useCallback\(\(\) => \{\s*if \(!selectedWorkspaceId\) \{\s*setSpaceDisplayView\(\{ type: "browser" \}\);\s*return;\s*\}\s*const lastAppDisplayView =\s*lastRestorableSpaceAppDisplayViewByWorkspaceRef\.current\[\s*selectedWorkspaceId\s*\];\s*if \(lastAppDisplayView\) \{\s*setSpaceDisplayView\(lastAppDisplayView\);\s*return;\s*\}\s*setSpaceDisplayView\(spaceDisplayView\);\s*\}, \[selectedWorkspaceId, spaceDisplayView\]\);/,
  );
  assert.match(
    source,
    /if \(value === "browser"\) \{\s*setSpaceDisplayView\(\{\s*type: "browser",?\s*\}\);\s*\} else if \(value === "applications"\) \{\s*restoreLastSpaceAppDisplayView\(\);\s*\} else \{\s*restoreLastSpaceFileDisplayView\(\);\s*\}/,
  );
  assert.match(
    source,
    /setSpaceExplorerMode\(value\);\s*if \(value === "browser"\) \{\s*setSpaceDisplayView\(\{\s*type: "browser",?\s*\}\);\s*\} else if \(value === "applications"\) \{\s*restoreLastSpaceAppDisplayView\(\);\s*\} else \{\s*restoreLastSpaceFileDisplayView\(\);\s*\}/,
  );
});

test("app shell opens the centered add apps dialog from the applications explorer", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /import \{ WorkspaceAppsDialog \} from "@\/components\/layout\/WorkspaceAppsDialog";/);
  assert.match(
    source,
    /const \[workspaceAppsDialogOpen, setWorkspaceAppsDialogOpen\] =\s*useState\(false\);/,
  );
  assert.match(
    source,
    /const \[chatImagePreviewOpen, setChatImagePreviewOpen\] =\s*useState\(false\);/,
  );
  assert.match(
    source,
    /const handleAddApp = \(\) => \{\s*setWorkspaceAppsDialogOpen\(true\);\s*\};/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(selectedWorkspaceId\) \{\s*return;\s*\}\s*setWorkspaceAppsDialogOpen\(false\);\s*\}, \[selectedWorkspaceId\]\);/,
  );
  assert.match(
    source,
    /<SpaceApplicationsExplorerPane[\s\S]*onAddApp=\{handleAddApp\}/,
  );
  assert.match(
    source,
    /<WorkspaceAppsDialog[\s\S]*open=\{workspaceAppsDialogOpen\}[\s\S]*onClose=\{\(\) => setWorkspaceAppsDialogOpen\(false\)\}/,
  );
  assert.match(
    source,
    /const shouldSuspendBrowserNativeView =\s*[\s\S]*taskProposalDetailsDialogOpen[\s\S]*chatImagePreviewOpen[\s\S]*workspaceAppsDialogOpen[\s\S]*createWorkspacePanelOpen[\s\S]*publishOpen;/,
  );
  assert.doesNotMatch(
    source,
    /const shouldSuspendBrowserNativeView =\s*isUtilityPaneResizing \|\|/,
  );
  assert.doesNotMatch(
    source,
    /const handleAddApp = \(\) => \{\s*handleOpenMarketplace\("apps"\);\s*\};/,
  );
});

test("app shell passes the current app version into the settings dialog", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  // Settings is now a full-screen route via SettingsScreenRoot (was
  // SettingsDialog before #285). The mount lives behind a
  // settingsDialogOpen guard inside the AppShell <main>.
  assert.match(
    source,
    /<SettingsScreenRoot[\s\S]*appVersion=\{effectiveAppUpdateStatus\?\.currentVersion \|\| ""\}/,
  );
  assert.match(
    source,
    /<SettingsScreenRoot[\s\S]*workspaceCardsPerRow=\{controlCenterCardsPerRow\}[\s\S]*onWorkspaceCardsPerRowChange=\{setControlCenterCardsPerRow\}/,
  );
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*composerModel=\{currentComposerSelectedModel\(runtimeConfig\)\}/,
  );
});

test("app shell persists and passes custom control-center workspace card ordering", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY =\s*"holaboss-control-center-workspace-card-order-v1";/,
  );
  assert.match(
    source,
    /function loadControlCenterWorkspaceCardOrder\(\): string\[] \{/,
  );
  assert.match(
    source,
    /localStorage\.getItem\(\s*CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY,\s*\);/,
  );
  assert.match(
    source,
    /const \[\s*controlCenterWorkspaceCardOrder,\s*setControlCenterWorkspaceCardOrder,\s*\] = useState<string\[]>\(\(\) => loadControlCenterWorkspaceCardOrder\(\)\);/,
  );
  assert.match(
    source,
    /localStorage\.setItem\(\s*CONTROL_CENTER_WORKSPACE_CARD_ORDER_STORAGE_KEY,\s*JSON\.stringify\(controlCenterWorkspaceCardOrder\),\s*\);/,
  );
  assert.match(
    source,
    /setControlCenterWorkspaceCardOrder\(\(current\) => \{\s*const next = current\.filter\(\(workspaceId, index\) => \{/,
  );
  assert.match(source, /return current\.indexOf\(workspaceId\) === index;/);
  assert.match(
    source,
    /const handleControlCenterWorkspaceOrderChange = useCallback\(\s*\(workspaceIds: string\[]\) => \{/,
  );
  assert.match(
    source,
    /setControlCenterWorkspaceCardOrder\(\(current\) =>\s*current\.length === nextWorkspaceIds\.length &&\s*current\.every\(\(workspaceId, index\) => workspaceId === nextWorkspaceIds\[index\]\)\s*\?\s*current\s*:\s*nextWorkspaceIds,\s*\);/,
  );
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*orderedWorkspaceIds=\{controlCenterWorkspaceCardOrder\}/,
  );
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*onWorkspaceOrderChange=\{handleControlCenterWorkspaceOrderChange\}/,
  );
});

test("app shell suppresses visible control-center completion toasts in favor of card highlights", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const \[controlCenterVisibleWorkspaceIds, setControlCenterVisibleWorkspaceIds\] =\s*useState<string\[]>\(\[]\);/,
  );
  assert.match(
    source,
    /const \[\s*controlCenterHighlightedWorkspaceIds,\s*setControlCenterHighlightedWorkspaceIds,\s*\] =\s*useState<string\[]>\(\[]\);/,
  );
  assert.match(
    source,
    /const controlCenterCardComposerSubmissionWorkspaceIdsRef = useRef\(\s*new Set<string>\(\),\s*\);/,
  );
  assert.match(source, /const controlCenterVisibleWorkspaceIdSet = useMemo\(/);
  assert.match(
    source,
    /const handleControlCenterVisibleWorkspaceIdsChange = useCallback\(\s*\(workspaceIds: string\[]\) => \{/,
  );
  assert.match(
    source,
    /const handleMarkControlCenterWorkspaceComposerSubmission = useCallback\(\s*\(workspaceId: string\) => \{/,
  );
  assert.match(
    source,
    /const handleControlCenterWorkspaceCompletion = useCallback\(\s*\(workspaceId: string\) => \{/,
  );
  assert.match(
    source,
    /const clearControlCenterWorkspaceHighlight = useCallback\(\s*\(workspaceId: string\) => \{/,
  );
  assert.match(
    source,
    /const isVisibleControlCenterMainSessionNotification =\s*activeShellView === "control_center"[\s\S]*item\.source_type === "main_session"[\s\S]*controlCenterVisibleWorkspaceIdSet\.has\(\s*normalizedNotificationWorkspaceId,\s*\);/,
  );
  assert.match(
    source,
    /const consumeControlCenterComposerSubmissionSuppression = \(\) => \{/,
  );
  assert.match(
    source,
    /if \(isVisibleControlCenterMainSessionNotification\) \{[\s\S]*setControlCenterHighlightedWorkspaceIds\(\(current\) => \{[\s\S]*return \[normalizedNotificationWorkspaceId, \.\.\.current\];[\s\S]*state: "dismissed",/,
  );
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*highlightedWorkspaceIds=\{controlCenterHighlightedWorkspaceIds\}[\s\S]*onVisibleWorkspaceIdsChange=\{\s*handleControlCenterVisibleWorkspaceIdsChange\s*\}[\s\S]*onCardComposerSubmit=\{\s*handleMarkControlCenterWorkspaceComposerSubmission\s*\}/,
  );
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*onWorkspaceCompletion=\{handleControlCenterWorkspaceCompletion\}/,
  );
});

test("app shell clears a consumed file explorer focus request", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /<FileExplorerPane[\s\S]*focusRequest=\{fileExplorerFocusRequest\}/);
  assert.match(source, /<FileExplorerPane[\s\S]*previewInPane=\{false\}/);
  assert.match(
    source,
    /onFileOpen=\{\(path\) => \{\s*setSpaceDisplayView\(\{\s*type: "internal",\s*surface: "file",\s*resourceId: path,\s*\}\);/
  );
  assert.match(
    source,
    /onFocusRequestConsumed=\{\(requestKey\) => \{\s*setFileExplorerFocusRequest\(\(current\) =>\s*current\?\.requestKey === requestKey \? null : current,\s*\);\s*\}\}/
  );
});

test("app shell syncs file-oriented agent operations into the explorer and display", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const handleSyncAgentOperationFileDisplay = useCallback\(\s*\(path: string\) => \{/,
  );
  assert.match(source, /const targetPath = path\.trim\(\);/);
  assert.match(source, /setSpaceWorkspacePanelCollapsed\(false\);/);
  assert.match(source, /setSpaceExplorerMode\("files"\);/);
  assert.match(
    source,
    /setSpaceDisplayView\(\{\s*type: "internal",\s*surface: "file",\s*resourceId: targetPath,\s*\}\);/,
  );
  assert.match(
    source,
    /setFileExplorerFocusRequest\(\{\s*path: targetPath,\s*requestKey: Date\.now\(\),\s*\}\);/,
  );
  assert.match(
    source,
    /<OnboardingPane[\s\S]*onSyncFileDisplayFromAgentOperation=\{\s*handleSyncAgentOperationFileDisplay\s*\}/,
  );
  assert.match(
    source,
    /<OnboardingPane[\s\S]*onImageAttachmentPreviewOpenChange=\{setChatImagePreviewOpen\}/,
  );
  assert.match(
    source,
    /<ChatPane[\s\S]*onSyncFileDisplayFromAgentOperation=\{\s*handleSyncAgentOperationFileDisplay\s*\}/,
  );
  assert.match(
    source,
    /<ChatPane[\s\S]*onImageAttachmentPreviewOpenChange=\{setChatImagePreviewOpen\}/,
  );
});

test("app shell restores the last internal display and otherwise keeps the current display when returning to files mode", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /type RestorableSpaceFileDisplayView = Extract<\s*SpaceDisplayView,\s*\{ type: "internal" \}\s*>;/,
  );
  assert.match(
    source,
    /const lastRestorableSpaceFileDisplayViewByWorkspaceRef =\s*useRef<\s*Record<string, RestorableSpaceFileDisplayView>\s*>\(\{\}\);/,
  );
  assert.match(
    source,
    /const syncFileExplorerFocusWithDisplayView = useCallback\(\s*\(displayView: SpaceDisplayView \| null\) => \{/,
  );
  assert.match(
    source,
    /if \(displayView\?\.type !== "internal"\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /displayView\.surface === "document"[\s\S]*displayView\.surface === "file"[\s\S]*displayView\.resourceId\?\.trim\(\)/,
  );
  assert.match(
    source,
    /setFileExplorerFocusRequest\(\{\s*path: displayView\.resourceId,\s*requestKey: Date\.now\(\),\s*\}\);/,
  );
  assert.match(
    source,
    /\},\s*\[\]\s*\);/,
  );
  assert.match(
    source,
    /if \(!selectedWorkspaceId \|\| spaceDisplayView\.type !== "internal"\) \{\s*return;\s*\}\s*lastRestorableSpaceFileDisplayViewByWorkspaceRef\.current\[\s*selectedWorkspaceId\s*\]\s*=\s*spaceDisplayView;/,
  );
  assert.match(
    source,
    /const restoreLastSpaceFileDisplayView = useCallback\(\(\) => \{[\s\S]*setSpaceDisplayView\(\{ type: "browser" \}\);[\s\S]*const lastDisplayView =[\s\S]*lastRestorableSpaceFileDisplayViewByWorkspaceRef\.current\[[\s\S]*selectedWorkspaceId[\s\S]*const nextDisplayView = lastDisplayView \?\? spaceDisplayView;[\s\S]*setSpaceDisplayView\(nextDisplayView\);[\s\S]*syncFileExplorerFocusWithDisplayView\(nextDisplayView\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!selectedWorkspaceId\) \{\s*setSpaceExplorerMode\("browser"\);\s*setSpaceDisplayView\(\{ type: "browser" \}\);\s*return;\s*\}\s*const nextDisplayView =\s*lastRestorableSpaceFileDisplayViewByWorkspaceRef\.current\[\s*selectedWorkspaceId\s*\];\s*if \(!nextDisplayView\) \{\s*setSpaceExplorerMode\("browser"\);\s*setSpaceDisplayView\(\{ type: "browser" \}\);\s*return;\s*\}\s*setSpaceDisplayView\(nextDisplayView\);\s*syncFileExplorerFocusWithDisplayView\(nextDisplayView\);\s*\}, \[selectedWorkspaceId, syncFileExplorerFocusWithDisplayView\]\);/,
  );
  assert.match(
    source,
    /onClick=\{\(\) => \{\s*setSpaceExplorerMode\(value\);\s*if \(value === "browser"\) \{\s*setSpaceDisplayView\(\{\s*type: "browser",?\s*\}\);\s*\} else if \(value === "applications"\) \{\s*restoreLastSpaceAppDisplayView\(\);\s*\} else \{\s*restoreLastSpaceFileDisplayView\(\);\s*\}\s*\}\}/,
  );
});

test("app shell removes the outputs quick action", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.doesNotMatch(source, /aria-label="Open outputs panel"/);
});

test("app shell treats missing or stopped runtime states as startup blockers", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /function runtimeStartupBlockedMessage\(\s*runtimeStatus: RuntimeStatusPayload \| null,\s*fallbackMessage = "",\s*\)/,
  );
  assert.match(source, /if \(runtimeStatus\.status === "missing"\) \{/);
  assert.match(source, /if \(runtimeStatus\.status === "stopped"\) \{/);
  assert.match(
    source,
    /const runtimeStartupBlockedDetail = runtimeStartupBlockedMessage\(\s*runtimeStatus,\s*workspaceBlockingReason \|\| workspaceErrorMessage,\s*\);/,
  );
  assert.match(
    source,
    /const bootstrapErrorMessage =\s*!hasHydratedWorkspaceList\s*\?\s*runtimeStartupBlockedMessage\(runtimeStatus, workspaceErrorMessage\)\s*:\s*"";/,
  );
  assert.match(
    source,
    /const hydratedRuntimeErrorMessage =\s*hasHydratedWorkspaceList &&\s*runtimeStartupBlockedDetail &&\s*\(!hasWorkspaces \|\| !workspaceAppsReady\)\s*\?\s*runtimeStartupBlockedDetail\s*:\s*"";/,
  );
  assert.match(
    source,
    /\) : hydratedRuntimeErrorMessage \? \(\s*<WorkspaceStartupErrorPane message=\{hydratedRuntimeErrorMessage\} \/>\s*\) : !hasWorkspaces \? \(/,
  );
});

test("app shell polls runtime notifications and renders the toast stack", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /window\.electronAPI\.workspace\.listNotifications\(\s*null,\s*false,\s*\{\s*includeCronjobSource: true,\s*\}\s*\)/,
  );
  assert.match(source, /<NotificationToastStack[\s\S]*leadingToast=\{/);
  assert.match(source, /const effectiveToastNotifications = useMemo\(/);
  assert.match(source, /<NotificationToastStack[\s\S]*notifications=\{effectiveToastNotifications\}/);
  assert.match(source, /<NotificationToastStack[\s\S]*onCloseToast=\{\(notificationId\) => \{\s*void handleCloseDisplayedNotification\(notificationId\);\s*\}\}/);
  assert.doesNotMatch(source, /className=\{anchoredToastStackClassName\}/);
  assert.doesNotMatch(source, /style=\{anchoredToastStackStyle\}/);
  assert.match(source, /const runtimeNotificationById = useMemo\(/);
  assert.doesNotMatch(source, /notificationToastTimeoutsRef/);
  assert.doesNotMatch(source, /notificationToastDurationMs/);
  assert.doesNotMatch(source, /window\.setTimeout\(\(\) => \{\s*dismissNotificationToast\(item\.id\);/);
});

test("app shell keeps desktop updates separate from runtime notification state", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /function appUpdateChangelogUrl\(/);
  assert.match(source, /const handleDismissUpdate = useCallback\(/);
  assert.match(source, /void window\.electronAPI\.appUpdate\.dismiss\(/);
  assert.match(source, /void window\.electronAPI\.ui\.openExternalUrl\(changelogUrl\);/);
  assert.doesNotMatch(source, /combinedNotifications/);
  assert.doesNotMatch(source, /syntheticNotificationStates/);
  assert.match(source, /<SpaceBrowserDisplayPane[\s\S]*suspendNativeView=\{shouldSuspendBrowserNativeView\}/);
});

test("app shell opens cronjob session-run notifications in the sub-session chat", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /function notificationTargetSessionId\(/);
  assert.match(source, /const targetSessionId = notificationTargetSessionId\(notification\);/);
  assert.match(source, /setSelectedWorkspaceId\(targetWorkspaceId\);/);
  assert.match(source, /setChatSessionJumpRequest\(\{\s*sessionId: targetSessionId,\s*requestKey: Date\.now\(\),\s*\}\);/);
  assert.match(source, /setChatFocusRequestKey\(\(current\) => current \+ 1\);/);
});

test("app shell routes runtime notifications by window state and workspace visibility", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /function notificationDeliveryChannel\(/);
  assert.match(source, /function isSystemCronjobNotification\(/);
  assert.match(source, /function shouldIncludeRuntimeNotificationInShell\(/);
  assert.match(source, /function shouldShowNativeRuntimeNotification\(/);
  assert.match(source, /function shouldDismissVisibleRuntimeNotification\(/);
  assert.match(source, /function shouldToastVisibleRuntimeNotification\(/);
  assert.match(source, /const nativeRuntimeNotificationAttemptedAtRef = useRef\(\s*new Map<string, number>\(\),\s*\);/);
  assert.match(source, /window\.electronAPI\.workspace\.listNotifications\(\s*null,\s*false,/);
  assert.match(source, /window\.electronAPI\.ui\.getWindowState\(\)\.catch\(\(\) => null\)/);
  assert.match(source, /includeCronjobSource: true/);
  assert.match(source, /const shellNotifications = response\.items\.filter\(\s*shouldIncludeRuntimeNotificationInShell,\s*\)/);
  assert.match(source, /const isWindowMinimized = windowState\?\.isMinimized === true;/);
  assert.match(source, /shouldShowNativeRuntimeNotification\(item,\s*isWindowMinimized\)/);
  assert.match(source, /const shown = await window\.electronAPI\.ui\.showNativeNotification\(\{/);
  assert.match(source, /Date\.now\(\) - lastAttemptAt < 15_000/);
  assert.match(source, /shouldDismissVisibleRuntimeNotification\(item,\s*selectedWorkspaceId\)/);
  assert.match(source, /shouldToastVisibleRuntimeNotification\(item,\s*selectedWorkspaceId\)/);
  assert.doesNotMatch(source, /force: true/);
  assert.match(
    source,
    /await window\.electronAPI\.workspace\.updateNotification\(item\.id,\s*\{\s*state: "dismissed",\s*\}\);/,
  );
});

test("app shell exposes a dev-only app update preview hook", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const DEV_APP_UPDATE_PREVIEW_STORAGE_KEY = "holaboss-dev-app-update-preview-v1";/);
  assert.match(source, /type DevAppUpdatePreviewMode = "off" \| "downloading" \| "ready";/);
  assert.match(source, /window\.__holabossDevUpdatePreview = \{/);
  assert.match(source, /downloading: \(\) => updateMode\("downloading"\)/);
  assert.match(source, /ready: \(\) => updateMode\("ready"\)/);
  assert.match(source, /clear: \(\) => updateMode\("off"\)/);
  assert.match(source, /buildDevAppUpdatePreviewStatus\(/);
});

test("app shell exposes a dev-only notification toast preview hook", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const DEV_NOTIFICATION_TOAST_PREVIEW_ID_PREFIX =\s*"dev-notification-toast-preview:";/);
  assert.match(source, /function buildDevNotificationToastPreviewNotifications\(/);
  assert.match(source, /window\.__holabossDevNotificationToastPreview = \{/);
  assert.match(source, /stack: \(\) => showDevNotificationToastPreview\(\)/);
  assert.match(source, /clear: \(\) => clearDevNotificationToastPreview\(\)/);
  assert.match(source, /if \(isDevNotificationToastPreviewId\(notificationId\)\) \{/);
});

test("app shell uses the integrated title bar path for macOS and Windows", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const hasIntegratedTitleBar =\s*desktopPlatform === "darwin" \|\| desktopPlatform === "win32";/,
  );
  assert.match(
    source,
    /const titleBarContainerClassName =\s*desktopPlatform === "win32"\s*\?\s*"relative min-w-0 -mx-2 -mt-2 sm:-mx-3 sm:-mt-2.5"/,
  );
  assert.match(
    source,
    /<TopTabsBar[\s\S]*integratedTitleBar=\{hasIntegratedTitleBar\}[\s\S]*desktopPlatform=\{desktopPlatform\}/,
  );
});

test("app shell no longer reserves a separate safe pane region for update toasts", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const effectiveAppUpdateStatus = useMemo\(/,
  );
  assert.match(
    source,
    /const shouldShowAppUpdateReminder = Boolean\(\s*effectiveAppUpdateStatus &&\s*effectiveAppUpdateStatus\.downloaded,\s*\);/,
  );
  assert.doesNotMatch(source, /shouldUseSafeToastAnchor/);
  assert.doesNotMatch(source, /LEFT_NAVIGATION_RAIL_WIDTH_PX/);
  assert.doesNotMatch(source, /APP_SHELL_SPACE_COLUMN_GAP_PX/);
  assert.doesNotMatch(source, /FIXED_SAFE_TOAST_REGION_WIDTH_PX/);
  assert.doesNotMatch(source, /anchoredToastStackClassName/);
  assert.doesNotMatch(source, /anchoredToastStackStyle/);
  assert.match(
    source,
    /const shouldSuspendBrowserNativeView =\s*workspaceSwitcherOpen \|\|[\s\S]*settingsDialogOpen \|\|[\s\S]*taskProposalDetailsDialogOpen \|\|[\s\S]*chatImagePreviewOpen \|\|[\s\S]*createWorkspacePanelOpen \|\|[\s\S]*publishOpen;/,
  );
  assert.doesNotMatch(
    source,
    /const shouldSuspendBrowserNativeView =\s*isUtilityPaneResizing \|\|/,
  );
  assert.match(source, /<SpaceBrowserDisplayPane[\s\S]*suspendNativeView=\{shouldSuspendBrowserNativeView\}/);
  assert.doesNotMatch(
    source,
    /const startSpaceDisplayResize = useCallback\([\s\S]*?window\.electronAPI\.browser\.setBounds\(/,
  );
  assert.doesNotMatch(
    source,
    /const startUtilityPaneResize = useCallback\([\s\S]*?window\.electronAPI\.browser\.setBounds\(/,
  );
});

test("app shell renders a persistent icon rail beside a drag-resizable explorer panel in space mode", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const MIN_EXPLORER_PANEL_WIDTH = 220;/);
  assert.match(source, /const MAX_EXPLORER_PANEL_WIDTH = 480;/);
  assert.match(source, /const MIN_FILES_PANE_WIDTH = MIN_EXPLORER_PANEL_WIDTH;/);
  assert.match(source, /const MIN_BROWSER_PANE_WIDTH = 120;/);
  assert.match(source, /const MIN_AGENT_CONTENT_WIDTH = 380;/);
  assert.match(source, /const DEFAULT_FILES_PANE_WIDTH = 260;/);
  assert.match(source, /const SPACE_AGENT_PANE_WIDTH = 420;/);
  assert.match(source, /const SPACE_DISPLAY_MIN_WIDTH = 420;/);
  assert.match(source, /const SPACE_EXPLORER_RAIL_WIDTH = 52;/);
  assert.doesNotMatch(source, /SPACE_EXPLORER_COLLAPSED_WIDTH/);
  assert.doesNotMatch(source, /const SPACE_EXPLORER_WIDTH/);
  assert.match(
    source,
    /const \[spaceAgentPaneWidth, setSpaceAgentPaneWidth\] = useState\(\s*SPACE_AGENT_PANE_WIDTH,\s*\);/,
  );
  assert.match(
    source,
    /const clampExplorerPanelWidth = useCallback\(\(width: number\) => \{\s*return Math\.max\(\s*MIN_EXPLORER_PANEL_WIDTH,\s*Math\.min\(width, MAX_EXPLORER_PANEL_WIDTH\),\s*\);\s*\}, \[\]\);/,
  );
  assert.match(
    source,
    /const clampSpaceAgentPaneWidth = useCallback\(\s*\(width: number\) => \{/,
  );
  assert.match(
    source,
    /const explorerWidth = SPACE_EXPLORER_RAIL_WIDTH \+ filesPaneWidth;/,
  );
  assert.match(
    source,
    /hostWidth -\s*explorerWidth -\s*SPACE_DISPLAY_MIN_WIDTH -\s*UTILITY_PANE_RESIZER_WIDTH/,
  );
  assert.match(source, /new ResizeObserver\(schedule\)/);
});

test("app shell wires filesPaneWidth into the explorer panel and uses a drag handle mirrored from the agent pane resizer", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const \[filesPaneWidth, setFilesPaneWidth\] =\s*useState\(\s*DEFAULT_FILES_PANE_WIDTH,\s*\);/,
  );
  assert.match(
    source,
    /width: `\$\{SPACE_EXPLORER_RAIL_WIDTH\}px`,/,
  );
  assert.match(
    source,
    /style=\{\{ width: `\$\{filesPaneWidth\}px` \}\}[\s\S]*id="space-explorer-panel"/,
  );
  assert.match(
    source,
    /const startExplorerPanelResize = useCallback\(\s*\(event: ReactPointerEvent<HTMLDivElement>\) => \{\s*explorerPanelResizeStateRef\.current = \{\s*startWidth: filesPaneWidth,\s*startX: event\.clientX,\s*\};/,
  );
  assert.match(
    source,
    /setFilesPaneWidth\(\s*clampExplorerPanelWidth\(\s*resizeState\.startWidth \+ \(event\.clientX - resizeState\.startX\),\s*\),\s*\);/,
  );
  assert.match(
    source,
    /role="separator"\s*aria-label="Resize explorer panel"\s*aria-orientation="vertical"\s*onPointerDown=\{startExplorerPanelResize\}/,
  );
  assert.doesNotMatch(source, /showSpaceExplorer/);
  assert.doesNotMatch(source, /function loadFilesPaneWidth\(\): number \{/);
  assert.doesNotMatch(source, /holaboss-files-pane-width-v1/);
});

test("app shell uses the top toolbar for shell navigation and removes the left rail", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /type ShellView = "control_center" \| "space";/);
  // Default landing changed from "control_center" to "space" — the app
  // resumes the user's last workspace on launch (Cursor/VSCode/Notion
  // convention; control center remains opt-in via the toolbar).
  assert.match(
    source,
    /const \[activeShellView, setActiveShellView\] =\s*useState<ShellView>\("space"\);/,
  );
  assert.match(source, /const handleOpenControlCenter = useCallback\(\(\) => \{/);
  assert.match(source, /const handleEnterWorkspace = useCallback\(\s*\(workspaceId: string\) => \{/);
  assert.match(source, /const handleOpenControlCenterWorkspaceOutput = useCallback\(\s*async \(workspaceId: string, output: WorkspaceOutputRecordPayload\) => \{/);
  assert.match(source, /window\.electronAPI\.workspace\.getWorkspaceLifecycle\(\s*normalizedWorkspaceId/);
  assert.match(source, /<WorkspaceControlCenter[\s\S]*onEnterWorkspace=\{handleEnterWorkspace\}[\s\S]*onOpenOutput=\{handleOpenControlCenterWorkspaceOutput\}/);
  assert.match(source, /controlCenterActive=\{controlCenterMode\}/);
  assert.match(source, /onOpenControlCenter=\{handleOpenControlCenter\}/);
  assert.match(source, /handleOpenAutomationsPane = useCallback/);
  assert.match(source, /const handleOpenSessionsPane = useCallback\(\(\) => \{/);
  assert.match(source, /setAgentView\(\{ type: "sessions" \}\)/);
  assert.match(source, /setAgentView\(\{ type: "automations" \}\)/);
  assert.match(source, /onOpenSessions=\{handleOpenSessionsPane\}/);
  assert.match(source, /onOpenAutomations=\{handleOpenAutomationsPane\}/);
  assert.match(source, /<SubagentSessionsPane[\s\S]*variant="full"/);
  assert.match(source, /<AutomationsPane[\s\S]*onRunNow=\{handleReturnToChatPane\}/);
  assert.match(source, /<AutomationsPane[\s\S]*onCreateSchedule=\{\(\) =>\s*handleCreateScheduleInChat\(selectedWorkspaceId\)/);
  assert.doesNotMatch(source, /<SettingsDialog[\s\S]*onCreateAutomationSchedule/);
  assert.doesNotMatch(source, /<SettingsDialog[\s\S]*onEditAutomationSchedule/);
  assert.doesNotMatch(source, /<SettingsDialog[\s\S]*onOpenAutomationRunSession/);
  assert.doesNotMatch(source, /handleOpenMarketplace/);
  assert.doesNotMatch(source, /MarketplacePane/);
  assert.doesNotMatch(source, /ChatArtifactBrowserRequest/);
  assert.doesNotMatch(source, /handleOpenControlCenterWorkspaceArtifacts/);
  assert.doesNotMatch(source, /artifactBrowserRequest=\{chatArtifactBrowserRequest\}/);
  assert.doesNotMatch(source, /activeShellView === "marketplace"/);
  assert.doesNotMatch(source, /handleOpenSpace = useCallback/);
  assert.doesNotMatch(source, /onOpenSpace=\{handleOpenSpace\}/);
  assert.doesNotMatch(source, /isSpaceActive=\{spaceMode\}/);
  assert.doesNotMatch(source, /activeShellView === "automations"/);
  assert.doesNotMatch(source, /LeftNavigationRail/);
});

test("app shell defaults to the user's last workspace on startup", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  // Default activeShellView is "space" — control center is opt-in.
  assert.match(source, /useState<ShellView>\("space"\)/);

  // Startup ref renamed to reflect general scope (no longer single-workspace-only).
  assert.match(
    source,
    /const startupWorkspaceSelectionHandledRef = useRef\(false\);/,
  );

  // Auto-pick most-recent workspace when stored selection is invalid.
  assert.match(source, /workspaces\.length === 0/);
  assert.match(source, /selectionIsValid/);
  assert.match(source, /setSelectedWorkspaceId\(fallbackWorkspaceId\)/);
});

test("app shell no longer renders the dedicated app mode after removing the left rail", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.doesNotMatch(source, /activeShellView === "app"/);
  assert.doesNotMatch(source, /handleOpenInstalledApp/);
  assert.doesNotMatch(source, /Choose an app/);
  assert.doesNotMatch(source, /left rail/);
});

test("app shell requests remote task proposal generation without a separate success banner", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /requestRemoteTaskProposalGeneration\(/);
  assert.match(source, /Suggestions are unavailable right now\./);
  assert.doesNotMatch(source, /Remote heartbeat accepted/);
  assert.doesNotMatch(source, /Pending cloud jobs/);
});

test("accepting a task proposal starts background work without surfacing a hidden session id", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /async function acceptTaskProposal\(proposal: TaskProposalRecordPayload\)/);
  assert.match(source, /function currentComposerSelectedModel\(/);
  assert.match(source, /localStorage\.getItem\(CHAT_MODEL_STORAGE_KEY\)/);
  assert.match(source, /model: currentComposerSelectedModel\(runtimeConfig\)/);
  assert.match(source, /Started background task "\$\{proposal\.task_name\}"\./);
  assert.doesNotMatch(source, /const proposalSessionId = `proposal-\$\{crypto\.randomUUID\(\)\}`;/);
  assert.doesNotMatch(source, /Queued "\$\{proposal\.task_name\}" into session \$\{targetSessionId\}\./);
  assert.doesNotMatch(source, /session_id: proposalSessionId/);
});

test("app shell raises a local toast when fresh task proposals arrive and opens the inbox from it", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const TASK_PROPOSAL_TOAST_ID_PREFIX = "task-proposal-toast:";/);
  assert.match(source, /function buildTaskProposalToastNotification\(/);
  assert.match(
    source,
    /const \[taskProposalToastNotifications,\s*setTaskProposalToastNotifications\] =\s*useState<\s*RuntimeNotificationRecordPayload\[\]\s*>\(\[\]\);/,
  );
  assert.match(
    source,
    /const knownTaskProposalIdsByWorkspaceRef = useRef<Record<string, string\[]>>\(\s*\{\s*\},?\s*\);/,
  );
  assert.match(source, /const applyTaskProposals = useCallback\(/);
  assert.match(source, /const pendingNewProposals = proposals\.filter\(\(proposal\) => \{/);
  assert.match(
    source,
    /return isNew && proposal\.state\.trim\(\)\.toLowerCase\(\) === "pending";/,
  );
  assert.match(
    source,
    /setTaskProposalToastNotifications\(\(current\) =>\s*\[toast, \.\.\.current\]\.slice\(0, 4\),?\s*\)\s*;/,
  );
  assert.match(source, /if \(isTaskProposalToastId\(notificationId\)\) \{/);
  assert.match(source, /openTaskProposalInbox\(notification\.workspace_id\);/);
});

test("app shell does not replay agent browser navigations through the user-facing browser IPC", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /window\.electronAPI\.workbench\.onOpenBrowser\(/);
  assert.match(source, /const requestedUrl =\s*typeof payload\.url === "string" \? payload\.url\.trim\(\) : "";/);
  assert.match(
    source,
    /if \(requestedUrl\) \{\s*openBrowserPane\(\);\s*void window\.electronAPI\.browser\s*\.setActiveWorkspace\(\s*payload\.workspaceId \?\? selectedWorkspaceId \?\? null,\s*targetBrowserSpace,\s*payload\.sessionId \?\? null,\s*\)\s*\.catch\(\(\) => undefined\);\s*return;\s*\}/,
  );
  assert.doesNotMatch(
    source,
    /if \(requestedUrl\) \{[\s\S]*browser\.navigate\(requestedUrl\)/,
  );
});

test("app shell keeps agent browser open requests session-scoped until the user explicitly jumps to that browser", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const \[\s*chatBrowserJumpRequestKeysBySessionId,\s*setChatBrowserJumpRequestKeysBySessionId,\s*\] =\s*useState<Record<string, number>>\(\{\}\);/,
  );
  assert.match(
    source,
    /const consumeChatBrowserJumpRequest = useCallback\([\s\S]*delete next\[normalizedSessionId\];[\s\S]*\);/,
  );
  assert.match(
    source,
    /const handleJumpToSessionBrowser = useCallback\([\s\S]*revealBrowserPane\("agent"\);[\s\S]*window\.electronAPI\.browser\s*\.setActiveWorkspace\(selectedWorkspaceId, "agent", normalizedSessionId\)/,
  );
  assert.match(
    source,
    /const activeChatBrowserJumpRequest = useMemo\(\(\) => \{[\s\S]*chatBrowserJumpRequestKeysBySessionId\[normalizedSessionId\] \?\? 0;/,
  );
  assert.match(
    source,
    /if \(targetBrowserSpace === "agent" && normalizedSessionId\) \{\s*setChatBrowserJumpRequestKeysBySessionId\(\(current\) => \(\{\s*\.\.\.current,\s*\[normalizedSessionId\]: Date\.now\(\),\s*\}\)\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /<ChatPane[\s\S]*browserJumpRequest=\{activeChatBrowserJumpRequest\}[\s\S]*onBrowserJumpRequestConsumed=\{consumeChatBrowserJumpRequest\}[\s\S]*onJumpToSessionBrowser=\{handleJumpToSessionBrowser\}/,
  );
});

test("app shell tracks unread task proposals and badges the inbox control", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const TASK_PROPOSAL_SEEN_STORAGE_KEY = "holaboss-task-proposal-seen-v1";/);
  assert.match(source, /const \[seenTaskProposalIdsByWorkspace, setSeenTaskProposalIdsByWorkspace\] =\s*useState<Record<string, string\[]>>\(loadSeenTaskProposalIdsByWorkspace\);/);
  assert.match(source, /const unreadTaskProposalCount = useMemo\(\(\) => \{/);
  assert.match(source, /const markTaskProposalsSeen = useCallback\(/);
  assert.match(
    source,
    /if \(\s*agentView\.type !== "inbox" \|\|\s*!selectedWorkspaceId \|\|\s*taskProposals.length === 0\s*\) \{\s*return;\s*\}\s*markTaskProposalsSeen\(selectedWorkspaceId, taskProposals\);/,
  );
  assert.match(source, /if \(tab === "inbox" && selectedWorkspaceId\) \{\s*markTaskProposalsSeen\(selectedWorkspaceId, taskProposals\);\s*\}/);
  assert.match(source, /const handleOpenInboxPane = useCallback\(\(\) => \{/);
  assert.match(source, /setAgentView\(\{ type: "inbox" \}\);/);
  assert.match(source, /inboxUnreadCount=\{unreadTaskProposalCount\}/);
  assert.match(source, /onOpenInbox=\{handleOpenInboxPane\}/);
  assert.doesNotMatch(source, /unreadProposalCount=\{unreadTaskProposalCount\}/);
  assert.doesNotMatch(source, /aria-label="Open inbox"/);
});

test("app shell renders a persistent explorer rail and universal display in space mode", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY =\s*"holaboss-control-center-cards-per-row-v1";/,
  );
  assert.match(source, /function loadControlCenterCardsPerRow\(\): ControlCenterCardsPerRow \{/);
  assert.match(source, /localStorage\.getItem\(CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY\)/);
  assert.match(source, /if \(isControlCenterCardsPerRow\(parsed\)\) \{\s*return parsed;\s*\}/);
  assert.match(source, /function loadSpaceVisibility\(\): SpaceVisibilityState \{/);
  assert.match(
    source,
    /const SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY =\s*"holaboss-space-workspace-panel-collapsed-v1";/,
  );
  assert.match(source, /function loadSpaceWorkspacePanelCollapsed\(\): boolean \{/);
  assert.match(source, /localStorage\.getItem\(SPACE_VISIBILITY_STORAGE_KEY\)/);
  assert.match(
    source,
    /if \(parsed && typeof parsed === "object" && !Array\.isArray\(parsed\)\) \{\s*return \{\s*agent: true,\s*files: true,\s*browser: true,\s*\};/,
  );
  assert.doesNotMatch(source, /const toggleUtilityPaneVisibility = useCallback\(\(paneId: UtilityPaneId\) => \{/);
  assert.doesNotMatch(source, /className="mr-1\.5 flex w-9 shrink-0 flex-col items-center gap-1\.5 py-1"/);
  assert.doesNotMatch(source, /aria-label="Toggle files pane"/);
  assert.doesNotMatch(source, /aria-label="Toggle browser pane"/);
  assert.match(source, /type SpaceExplorerMode = "files" \| "browser" \| "applications";/);
  assert.match(source, /const \[spaceExplorerMode, setSpaceExplorerMode\] =\s*useState<SpaceExplorerMode>\("files"\);/);
  assert.match(
    source,
    /const \[spaceWorkspacePanelCollapsed, setSpaceWorkspacePanelCollapsed\] =\s*useState\(loadSpaceWorkspacePanelCollapsed\);/,
  );
  assert.match(
    source,
    /const \[controlCenterCardsPerRow, setControlCenterCardsPerRow\] =\s*useState<ControlCenterCardsPerRow>\(loadControlCenterCardsPerRow\);/,
  );
  assert.doesNotMatch(source, /spaceExplorerCollapsed/);
  assert.doesNotMatch(source, /setSpaceExplorerCollapsed/);
  assert.match(source, /const \[spaceDisplayView, setSpaceDisplayView\] = useState<SpaceDisplayView>\(\{\s*type: "browser",\s*\}\);/);
  assert.match(
    source,
    /localStorage\.setItem\(\s*SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY,\s*spaceWorkspacePanelCollapsed \? "1" : "0",\s*\);/,
  );
  assert.match(
    source,
    /localStorage\.setItem\(\s*CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY,\s*String\(controlCenterCardsPerRow\),\s*\);/,
  );
  assert.match(
    source,
    /if \(!spaceWorkspacePanelCollapsed\) \{\s*return;\s*\}\s*setSpaceWorkspacePanelCollapsed\(false\);/,
  );
  assert.match(source, /<FileExplorerPane[\s\S]*focusRequest=\{fileExplorerFocusRequest\}/);
  assert.match(source, /<FileExplorerPane[\s\S]*onOpenLinkInBrowser=\{handleOpenLinkInNewAppBrowserTab\}/);
  assert.match(source, /<FileExplorerPane[\s\S]*previewInPane=\{false\}/);
  assert.match(source, /<InternalSurfacePane[\s\S]*onOpenLinkInBrowser=\{handleOpenLinkInNewAppBrowserTab\}/);
  assert.match(source, /<SpaceApplicationsExplorerPane[\s\S]*installedApps=\{installedApps\}/);
  assert.match(source, /<SpaceApplicationsExplorerPane[\s\S]*onAddApp=\{handleAddApp\}/);
  assert.match(source, /<SpaceBrowserExplorerPane[\s\S]*browserSpace=\{spaceBrowserSpace\}/);
  assert.match(
    source,
    /<WorkspaceControlCenter[\s\S]*cardsPerRow=\{controlCenterCardsPerRow\}/,
  );
  assert.match(source, /<SpaceBrowserDisplayPane[\s\S]*layoutSyncKey=\{spaceDisplayLayoutSyncKey\}/);
  assert.match(source, /<SpaceBrowserDisplayPane[\s\S]*embedded/);
  assert.match(
    source,
    /aria-label=\{`Open \$\{label\.toLowerCase\(\)\} explorer`\}/,
  );
  assert.match(
    source,
    /value: "files",\s*label: "Files",\s*icon: Folder,\s*\},\s*\{\s*value: "browser",\s*label: "Browser",\s*icon: Globe,\s*\},\s*\{\s*value: "applications",\s*label: "Apps",\s*icon: LayoutGrid,/,
  );
  assert.match(source, /aria-label="Resize display pane"/);
  assert.match(source, /aria-label="Resize explorer panel"/);
  assert.match(source, /id="space-workspace-panel"/);
  assert.doesNotMatch(source, /aria-controls="space-workspace-panel"/);
  assert.doesNotMatch(source, /aria-label=\{spaceWorkspacePanelToggleLabel\}/);
  assert.doesNotMatch(source, /Expand explorer and display/);
  assert.doesNotMatch(source, /Collapse explorer and display/);
  assert.doesNotMatch(source, /inline-flex h-8 items-center gap-2 rounded-full border px-3/);
  assert.doesNotMatch(source, /spaceDrawerToggleLabel/);
  assert.doesNotMatch(source, /utilityPaneRenderWidth/);
});

test("app shell routes agent-originated browser opens into the agent browser space", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const revealBrowserPane = useCallback\(\(space: BrowserSpaceId = "user"\) => \{\s*setActiveShellView\("space"\);\s*setSpaceWorkspacePanelCollapsed\(false\);\s*setSpaceExplorerMode\("browser"\);/,
  );
  assert.match(source, /const targetBrowserSpace =\s*payload\.space === "agent" \? "agent" : "user";/);
  assert.match(source, /\.setActiveWorkspace\(\s*payload\.workspaceId \?\? selectedWorkspaceId \?\? null,\s*targetBrowserSpace,\s*payload\.sessionId \?\? null,\s*\)/);
  assert.match(source, /\.setActiveWorkspace\(targetWorkspaceId, "user"\)/);
  assert.match(source, /const handleOpenLinkInNewAppBrowserTab = useCallback\(/);
  assert.match(source, /\.then\(\(\) => window\.electronAPI\.browser\.newTab\(normalizedUrl\)\)/);
});

test("app shell reports active non-browser operator surfaces back to Electron", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /type ReportedOperatorSurfaceContext = \{/);
  assert.match(source, /function buildReportedOperatorSurfaceContext\(params: \{/);
  assert.match(source, /surface_id: `editor:\$\{params\.owner\}:\$\{resourceId\}`/);
  assert.match(source, /surface_type: "editor"/);
  assert.match(source, /surface_type: "app_surface"/);
  assert.match(source, /const reportedOperatorSurfaceWorkspaceIdRef = useRef<string \| null>\(null\);/);
  assert.match(source, /const reportedOperatorSurfaceContext = useMemo\(/);
  assert.match(source, /window\.electronAPI\.workspace\.setOperatorSurfaceContext\(\s*previousWorkspaceId,\s*null,\s*\)/);
  assert.match(source, /window\.electronAPI\.workspace\.setOperatorSurfaceContext\(\s*nextWorkspaceId,\s*reportedOperatorSurfaceContext,\s*\)/);
});

test("app shell polls proactive status for the selected workspace", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const \[proactiveStatus, setProactiveStatus\]/);
  assert.match(source, /workspace\.getProactiveStatus\(\s*selectedWorkspace\.id,/);
  assert.match(source, /runtimeConfig\?\.authTokenPresent/);
  assert.match(source, /runtimeConfig\?\.modelProxyBaseUrl/);
  assert.match(source, /runtimeStatus\?\.status/);
  assert.match(source, /const \[taskProposalDetailsDialogOpen, setTaskProposalDetailsDialogOpen\] =\s*useState\(false\);/);
  assert.match(source, /<OperationsInboxPane[\s\S]*proactiveStatus=\{proactiveStatus\}/);
  assert.match(source, /<OperationsInboxPane[\s\S]*isLoadingProactiveStatus=\{isLoadingProactiveStatus\}/);
  assert.match(source, /<OperationsInboxPane[\s\S]*onProposalDetailsOpenChange=\{setTaskProposalDetailsDialogOpen\}/);
});

test("app shell reloads proactive preference after workspace hydration completes", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const \[proactiveTaskProposalsEnabled, setProactiveTaskProposalsEnabled\] =\s*useState\(false\);/);
  assert.match(source, /if \(!hasHydratedWorkspaceList\) \{\s*return;\s*\}/);
  assert.match(source, /workspace\.getProactiveTaskProposalPreference\(\)/);
  assert.match(source, /setProactiveTaskProposalsEnabled\(preference\.enabled === true\);/);
  assert.match(source, /\}, \[hasHydratedWorkspaceList, selectedWorkspaceId\]\);/);
});

test("app shell keeps polling task proposals even when proactive auth preferences are unavailable", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /workspace\.listTaskProposals\(\s*selectedWorkspace\.id,/);
  assert.doesNotMatch(source, /if \(!hasLoadedProactiveTaskProposalsPreference\) \{\s*setIsLoadingTaskProposals\(false\);\s*return;\s*\}/);
  assert.doesNotMatch(source, /if \(!proactiveTaskProposalsEnabled\) \{\s*setIsLoadingTaskProposals\(false\);\s*return;\s*\}/);
  assert.match(source, /\}, \[selectedWorkspace, selectedWorkspaceId\]\);/);
});

test("app shell no longer renders a separate right panel in space mode", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.doesNotMatch(source, /const showOperationsDrawer/);
  assert.match(source, /const mainGridClassName = appShellMainGridClassName\(\{/);
  assert.doesNotMatch(source, /lg:grid-cols-\[60px_minmax\(0,1fr\)_336px\]/);
  assert.doesNotMatch(source, /<OperationsDrawer(?:\s|>)/);
  assert.doesNotMatch(source, /aria-label="Open inbox panel"/);
  assert.doesNotMatch(source, /aria-label="Open sessions panel"/);
  assert.doesNotMatch(source, /aria-label="Show right panel"/);
  assert.doesNotMatch(source, /aria-label="Hide right panel"/);
});

test("app shell can route new schedule creation into a prefilled workspace chat", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /type ChatComposerPrefillRequest = \{\s*text: string;\s*requestKey: number;\s*mode\?: "replace" \| "append";\s*\};/);
  assert.match(source, /const \[chatComposerPrefillRequest, setChatComposerPrefillRequest\] =\s*useState<ChatComposerPrefillRequest \| null>\(null\);/);
  assert.match(source, /const chatSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const chatComposerPrefillRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const nextChatSessionOpenRequestKey = useCallback\(\(\) => \{\s*chatSessionOpenRequestKeyRef\.current \+= 1;\s*return chatSessionOpenRequestKeyRef\.current;\s*\}, \[\]\);/);
  assert.match(source, /const nextChatComposerPrefillRequestKey = useCallback\(\(\) => \{\s*chatComposerPrefillRequestKeyRef\.current \+= 1;\s*return chatComposerPrefillRequestKeyRef\.current;\s*\}, \[\]\);/);
  assert.match(source, /const handleCreateScheduleInChat = useCallback\(\s*\(workspaceId\?: string \| null\) => \{/);
  assert.match(source, /const normalizedWorkspaceId =\s*workspaceId\?\.trim\(\) \|\| selectedWorkspaceId\?\.trim\(\) \|\| "";/);
  assert.match(source, /if \(normalizedWorkspaceId !== \(selectedWorkspaceId\?\.trim\(\) \|\| ""\)\) \{\s*setSelectedWorkspaceId\(normalizedWorkspaceId\);\s*\}/);
  assert.match(source, /setActiveShellView\("space"\);/);
  assert.match(source, /setSpaceVisibility\(\(previous\) => \(\{\s*\.\.\.previous,\s*agent: true,\s*\}\)\);/);
  assert.match(source, /setAgentView\(\{ type: "chat" \}\);/);
  assert.match(source, /setChatSessionJumpRequest\(null\);/);
  assert.match(source, /setChatSessionOpenRequest\(\{\s*sessionId: "",\s*mode: "draft",\s*parentSessionId: null,\s*requestKey: nextChatSessionOpenRequestKey\(\),\s*\}\);/);
  assert.match(source, /setChatComposerPrefillRequest\(\{\s*text: "Create a cronjob for ",\s*requestKey: nextChatComposerPrefillRequestKey\(\),\s*mode: "replace",\s*\}\);/);
  assert.match(source, /composerPrefillRequest=\{chatComposerPrefillRequest\}/);
  assert.match(source, /onComposerPrefillConsumed=\{handleChatComposerPrefillConsumed\}/);
  assert.match(source, /<AutomationsPane[\s\S]*onCreateSchedule=\{\(\) =>\s*handleCreateScheduleInChat\(selectedWorkspaceId\)/);
});

test("app shell can route schedule edits into a prefilled workspace chat", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const handleEditScheduleInChat = useCallback\(\s*\(\s*job: CronjobRecordPayload,\s*workspaceId\?: string \| null,?\s*\) => \{/);
  assert.match(source, /const jobName =\s*job\.name\?\.trim\(\) \|\| job\.description\?\.trim\(\) \|\| "Untitled schedule";/);
  assert.match(source, /const instruction =\s*job\.instruction\?\.trim\(\) \|\| job\.description\?\.trim\(\) \|\| "";/);
  assert.match(source, /Edit cronjob "\$\{jobName\}" \(id: \$\{job\.id\}\)\. Current cron: \$\{job\.cron\}\./);
  assert.match(source, /Current instruction: \$\{instruction\}\\n\\nUpdate it to:/);
  assert.match(source, /mode: "replace"/);
  assert.match(source, /<AutomationsPane[\s\S]*onEditSchedule=\{\(job\) =>\s*handleEditScheduleInChat\(job, selectedWorkspaceId\)/);
});

test("app shell can route explorer references into chat attachments or text prefills", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /type ChatExplorerAttachmentRequest = \{\s*files: ExplorerAttachmentDragPayload\[];\s*requestKey: number;\s*\};/,
  );
  assert.match(
    source,
    /const \[chatExplorerAttachmentRequest, setChatExplorerAttachmentRequest\] =\s*useState<ChatExplorerAttachmentRequest \| null>\(null\);/,
  );
  assert.match(
    source,
    /const handleReferenceWorkspacePathInChat = useCallback\(\s*\(entry: LocalFileEntry\) => \{/,
  );
  assert.match(source, /const normalizedAbsolutePath = entry\.absolutePath\.trim\(\);/);
  assert.match(source, /const normalizedName = entry\.name\.trim\(\);/);
  assert.match(
    source,
    /if \(!normalizedAbsolutePath \|\| !normalizedName\) \{\s*return;\s*\}/,
  );
  assert.match(source, /setActiveShellView\("space"\);/);
  assert.match(source, /setSpaceVisibility\(\(previous\) => \(\{\s*\.\.\.previous,\s*agent: true,\s*\}\)\);/);
  assert.match(source, /setAgentView\(\{ type: "chat" \}\);/);
  assert.match(
    source,
    /setChatExplorerAttachmentRequest\(\{\s*files: \[\s*\{\s*absolutePath: normalizedAbsolutePath,\s*name: normalizedName,\s*size: Number\.isFinite\(entry\.size\) \? Math\.max\(0, entry\.size\) : 0,\s*mimeType: entry\.isDirectory \? "inode\/directory" : null,\s*kind: entry\.isDirectory \? "folder" : undefined,\s*\},\s*\],\s*requestKey: nextChatExplorerAttachmentRequestKey\(\),\s*\}\);/,
  );
  assert.match(source, /setChatFocusRequestKey\(\(current\) => current \+ 1\);/);
  assert.match(
    source,
    /explorerAttachmentRequest=\{chatExplorerAttachmentRequest\}/,
  );
  assert.match(
    source,
    /onExplorerAttachmentRequestConsumed=\{\s*handleChatExplorerAttachmentRequestConsumed\s*\}/,
  );
  assert.match(source, /<FileExplorerPane[\s\S]*onReferenceInChat=\{handleReferenceWorkspacePathInChat\}/);
});

test("app shell does not route browser comment captures into chat attachments", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.doesNotMatch(source, /ChatBrowserCommentRequest/);
  assert.doesNotMatch(source, /chatBrowserCommentRequest/);
  assert.doesNotMatch(source, /handleAttachBrowserCommentsToChat/);
  assert.doesNotMatch(source, /BrowserChatCommentDraft/);
  assert.doesNotMatch(source, /onAttachCommentsToChat=/);
  assert.doesNotMatch(source, /browserCommentRequest=/);
});

test("app shell clears missing internal file surfaces after explorer deletion or preview invalidation", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /function normalizeComparablePath\(targetPath: string\)/);
  assert.match(source, /function isPathWithin\(parentPath: string, targetPath: string\)/);
  assert.match(
    source,
    /const handleMissingInternalResource = useCallback\(\s*\(resourceId: string\) => \{[\s\S]*setAgentView\(\(current\) => \{[\s\S]*return \{ type: "chat" \};[\s\S]*setSpaceDisplayView\(\(current\) => \{[\s\S]*delete lastRestorableSpaceFileDisplayViewByWorkspaceRef\.current\[[\s\S]*selectedWorkspaceId[\s\S]*return \{ type: "empty" \};/,
  );
  assert.match(
    source,
    /const handleDeleteWorkspaceEntry = useCallback\(\s*\(entry: LocalFileEntry\) => \{[\s\S]*const normalizedDeletedPath = normalizeComparablePath\(entry\.absolutePath\);[\s\S]*setSpaceDisplayView\(\(current\) => \{[\s\S]*!isPathWithin\(normalizedDeletedPath, current\.resourceId\?\.trim\(\) \?\? ""\)[\s\S]*return \{ type: "empty" \};/,
  );
  assert.match(source, /<InternalSurfacePane[\s\S]*onResourceMissing=\{handleMissingInternalResource\}/);
  assert.match(source, /<FileExplorerPane[\s\S]*onDeleteEntry=\{handleDeleteWorkspaceEntry\}/);
});

test("app shell passes new session requests into the chat pane selector", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /type ChatSessionOpenRequest = \{\s*sessionId: string;\s*requestKey: number;\s*mode\?: "session" \| "draft";\s*parentSessionId\?: string \| null;\s*\};/);
  assert.match(
    source,
    /const \[\s*chatComposerDraftTextByWorkspace,\s*setChatComposerDraftTextByWorkspace,\s*\] =\s*useState<Record<string, string>>\(\{\}\);/,
  );
  assert.match(
    source,
    /const handleCreateSession = useCallback\(\s*\(request\?: \{\s*sessionId: string;\s*mode\?: "session" \| "draft";\s*parentSessionId\?: string \| null;\s*requestKey: number;\s*\}\) => \{/,
  );
  assert.match(
    source,
    /const handleChatComposerDraftTextChange = useCallback\(\s*\(text: string\) => \{[\s\S]*const workspaceId = selectedWorkspaceId\?\.trim\(\) \|\| "";/,
  );
  assert.match(
    source,
    /setChatComposerDraftTextByWorkspace\(\(current\) => \{[\s\S]*const existing = current\[workspaceId\] \?\? "";[\s\S]*if \(!text\) \{[\s\S]*delete next\[workspaceId\];[\s\S]*\}[\s\S]*\[workspaceId\]: text,/,
  );
  assert.match(source, /const handleChatSessionOpenRequestConsumed = useCallback\(\s*\(requestKey: number\) => \{/);
  assert.match(source, /setChatSessionOpenRequest\(\(current\) =>\s*current\?\.requestKey === requestKey \? null : current,\s*\);/);
  assert.match(
    source,
    /setChatSessionOpenRequest\(\s*request \?\? \{\s*sessionId: "",\s*mode: "draft",\s*parentSessionId: null,\s*requestKey: nextChatSessionOpenRequestKey\(\),\s*\},\s*\);/,
  );
  assert.match(source, /setChatFocusRequestKey\(\(current\) => current \+ 1\);/);
  assert.doesNotMatch(source, /const \[isCreatingSession, setIsCreatingSession\] = useState\(false\);/);
  assert.doesNotMatch(source, /window\.electronAPI\.workspace\.createAgentSession\(\{/);
  assert.match(source, /const handleReturnToChatPane = useCallback\(\(\) => \{/);
  assert.match(source, /aria-label="Return to chat"/);
  assert.match(source, /<OperationsInboxPane[\s\S]*proposals=\{taskProposals\}/);
  assert.match(
    source,
    /sessionOpenRequest=\{chatSessionOpenRequest\}[\s\S]*composerDraftText=\{[\s\S]*chatComposerDraftTextByWorkspace\[selectedWorkspaceId\] \?\? ""[\s\S]*\}[\s\S]*onComposerDraftTextChange=\{handleChatComposerDraftTextChange\}/,
  );
  assert.match(source, /onSessionOpenRequestConsumed=\{handleChatSessionOpenRequestConsumed\}/);
});

test("app shell keeps session-open request keys monotonic after requests are consumed", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(source, /const chatSessionOpenRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const nextChatSessionOpenRequestKey = useCallback\(\(\) => \{\s*chatSessionOpenRequestKeyRef\.current \+= 1;\s*return chatSessionOpenRequestKeyRef\.current;\s*\}, \[\]\);/);
  assert.match(source, /setChatSessionOpenRequest\(\{\s*sessionId: normalizedSessionId,\s*mode: "session",\s*requestKey: nextChatSessionOpenRequestKey\(\),\s*\}\);/);
  assert.doesNotMatch(source, /setChatSessionOpenRequest\(\(previous\) => \(\{\s*sessionId: normalizedSessionId,\s*mode: "session",\s*requestKey: \(previous\?\.requestKey \?\? 0\) \+ 1,\s*\}\)\);/);
});

test("app shell passes workspace-scoped chat composer drafts into the chat pane", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /const \[\s*chatComposerDraftTextByWorkspace,\s*setChatComposerDraftTextByWorkspace,\s*\] =\s*useState<Record<string, string>>\(\{\}\);/,
  );
  assert.match(
    source,
    /const handleChatComposerDraftTextChange = useCallback\(\s*\(text: string\) => \{[\s\S]*const workspaceId = selectedWorkspaceId\?\.trim\(\) \|\| "";/,
  );
  assert.match(
    source,
    /setChatComposerDraftTextByWorkspace\(\(current\) => \{[\s\S]*const existing = current\[workspaceId\] \?\? "";[\s\S]*if \(!text\) \{[\s\S]*delete next\[workspaceId\];[\s\S]*\}[\s\S]*\[workspaceId\]: text,/,
  );
  assert.match(
    source,
    /<ChatPane[\s\S]*composerDraftText=\{[\s\S]*chatComposerDraftTextByWorkspace\[selectedWorkspaceId\] \?\? ""[\s\S]*\}[\s\S]*onComposerDraftTextChange=\{handleChatComposerDraftTextChange\}/,
  );
  assert.match(
    source,
    /<ChatPane[\s\S]*onImageAttachmentPreviewOpenChange=\{setChatImagePreviewOpen\}[\s\S]*composerDraftText=\{/,
  );
});
