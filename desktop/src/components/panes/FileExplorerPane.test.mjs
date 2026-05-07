import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "FileExplorerPane.tsx");

test("file explorer syncs the workspace root only when the selected workspace changes", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const workspaceSessionKeyRef = useRef\(0\);/);
  assert.match(source, /const directoryLoadRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const previewRequestKeyRef = useRef\(0\);/);
  assert.match(
    source,
    /const lastSyncedWorkspaceRootRef = useRef<\{[\s\S]*workspaceId: string;[\s\S]*rootPath: string;[\s\S]*\} \| null>\(null\);/,
  );
  assert.match(
    source,
    /const resetPreviewState = useCallback\(\(\) => \{\s*previewRequestKeyRef\.current \+= 1;[\s\S]*setPreview\(null\);[\s\S]*setPreviewError\(""\);[\s\S]*setPreviewLoading\(false\);[\s\S]*setSaving\(false\);\s*\}, \[\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*workspaceSessionKeyRef\.current \+= 1;\s*directoryLoadRequestKeyRef\.current \+= 1;\s*previewRequestKeyRef\.current \+= 1;[\s\S]*setCurrentPath\(""\);[\s\S]*setSelectedPath\(""\);[\s\S]*resetPreviewState\(\);\s*\}, \[resetPreviewState, selectedWorkspaceId\]\);/,
  );
  assert.match(
    source,
    /const validateWorkspaceScopedTargetPath = useCallback\(/,
  );
  assert.match(
    source,
    /const \{ allowed, targetPath: validatedTargetPath \} =\s*await validateWorkspaceScopedTargetPath\(targetPath \?\? null\);[\s\S]*window\.electronAPI\.fs\.listDirectory\(\s*validatedTargetPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /const workspaceSessionKey = workspaceSessionKeyRef\.current;\s*const requestKey = \+\+directoryLoadRequestKeyRef\.current;/,
  );
  assert.match(
    source,
    /if \(\s*workspaceSessionKey !== workspaceSessionKeyRef\.current \|\|\s*requestKey !== directoryLoadRequestKeyRef\.current \|\|\s*!allowed\s*\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /lastSyncedWorkspaceRootRef\.current = \{\s*workspaceId: selectedWorkspaceId,\s*rootPath: workspaceRoot,\s*\};/
  );
  assert.match(source, /\}, \[loadDirectory, selectedWorkspaceId\]\);/);
  assert.doesNotMatch(source, /\}, \[currentPath, loadDirectory, selectedWorkspaceId\]\);/);
  assert.doesNotMatch(source, /currentPath === workspaceRoot/);
});

test("file explorer refreshes the current directory and expanded folders to surface live file changes", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const refreshTargets = \[\s*currentPath,\s*\.\.\.Object\.entries\(expandedDirectoryPaths\)[\s\S]*\.filter\(\s*\(\[, isExpanded\]\) => isExpanded\s*\)[\s\S]*\.map\(\(\[targetPath\]\) => targetPath\),\s*\]\.filter\(/,
  );
  assert.match(source, /const refreshedDirectories = await Promise\.allSettled\(/);
  assert.match(source, /refreshTargets\.map\(\(targetPath\) =>/);
  assert.match(
    source,
    /const \{ allowed, targetPath: validatedTargetPath \} =\s*await validateWorkspaceScopedTargetPath\(targetPath\);[\s\S]*if \(!allowed \|\| !validatedTargetPath\) \{\s*return null;\s*\}[\s\S]*window\.electronAPI\.fs\.listDirectory\(\s*validatedTargetPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /setDirectoryEntriesByPath\(\(current\) => \(\{\s*\.\.\.current,\s*\.\.\.refreshedEntriesByPath,\s*\}\)\);/,
  );
  assert.match(source, /const timer = window\.setInterval\(\(\) => \{\s*void refreshLoadedDirectories\(\);\s*\}, 1200\);/);
  assert.match(source, /window\.clearInterval\(timer\);/);
  assert.match(
    source,
    /\}, \[\s*currentPath,\s*expandedDirectoryPaths,\s*selectedWorkspaceId,\s*validateWorkspaceScopedTargetPath,\s*\]\);/,
  );
});

test("file explorer live-refreshes inline previews from file watch events without overwriting dirty edits", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const isDirtyRef = useRef\(false\);/);
  assert.match(source, /const isSavingRef = useRef\(false\);/);
  assert.match(source, /isDirtyRef\.current = isDirty;/);
  assert.match(source, /isSavingRef\.current = saving;/);
  assert.match(
    source,
    /const watchedPath = preview\?\.absolutePath\?\.trim\(\) \|\| "";\s*if \(!previewInPane \|\| !watchedPath\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.onFileChange\(\(payload\) => \{\s*if \(\s*normalizeComparablePath\(payload\.absolutePath\) !==\s*normalizeComparablePath\(watchedPath\)\s*\) \{\s*return;\s*\}\s*void refreshPreviewFromDisk\(\);\s*\}\);/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs[\s\S]*\.watchFile\(/,
  );
  assert.match(
    source,
    /if \(\s*cancelled \|\|\s*refreshInFlight \|\|\s*isDirtyRef\.current \|\|\s*isSavingRef\.current\s*\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(!allowed \|\| !validatedWatchedPath\) \{\s*resetPreviewState\(\);[\s\S]{0,320}setSelectedPath\(\(current\) =>[\s\S]{0,240}normalizeComparablePath\(watchedPath\)[\s\S]{0,160}\? ""[\s\S]{0,160}: current,[\s\S]{0,120}\);[\s\S]{0,80}return;\s*\}/,
  );
  assert.match(
    source,
    /const nextPreview = await window\.electronAPI\.fs\.readFilePreview\(\s*validatedWatchedPath,\s*selectedWorkspaceId \?\? null,\s*\);[\s\S]*setPreview\(nextPreview\);[\s\S]*setPreviewDraft\(nextPreview\.content \?\? ""\);/,
  );
  assert.match(source, /function isMissingFilePreviewError\(cause: unknown\)/);
  assert.match(
    source,
    /catch \(cause\) \{\s*if \(!cancelled && isMissingFilePreviewError\(cause\)\) \{\s*resetPreviewState\(\);[\s\S]*setSelectedPath\(\(current\) =>[\s\S]*normalizeComparablePath\(watchedPath\)[\s\S]*\? ""[\s\S]*: current,\s*\);[\s\S]*return;\s*\}[\s\S]*The agent may still be writing or replacing the file/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.watchFile\(\s*validatedWatchedPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /void window\.electronAPI\.fs\.unwatchFile\(subscriptionId\);/);
});

test("file explorer clears affected preview state when deleting the active resource", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /onDeleteEntry\?: \(entry: LocalFileEntry\) => void;/);
  assert.match(
    source,
    /const normalizedDeletedPath = normalizeComparablePath\(entry\.absolutePath\);[\s\S]*const normalizedSelectedPath = normalizeComparablePath\(selectedPath\);[\s\S]*const normalizedPreviewPath = normalizeComparablePath\(\s*preview\?\.absolutePath \?\? "",\s*\);/,
  );
  assert.match(
    source,
    /const deletedAffectsSelection =[\s\S]*isPathWithin\(normalizedDeletedPath, normalizedSelectedPath\);/,
  );
  assert.match(
    source,
    /const deletedAffectsPreview =[\s\S]*isPathWithin\(normalizedDeletedPath, normalizedPreviewPath\);/,
  );
  assert.match(
    source,
    /await refreshDirectoryEntries\(parentPath\);[\s\S]*if \(deletedAffectsPreview\) \{\s*resetPreviewState\(\);\s*\}[\s\S]*if \(deletedAffectsSelection\) \{\s*setSelectedPath\(""\);\s*\}[\s\S]*onDeleteEntry\?\.\(entry\);/,
  );
});

test("file explorer switches folders to inline tree expansion and keeps explorer-only file opening", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /type FileExplorerVisibleRow =/,
  );
  assert.match(
    source,
    /function buildVisibleExplorerRows\(/,
  );
  assert.match(
    source,
    /const toggleDirectoryExpansion = useCallback\(\s*async \(entry: LocalFileEntry\) => \{/,
  );
  assert.match(
    source,
    /onClick=\{\(\) => \{\s*setSelectedPath\(entry\.absolutePath\);\s*closeContextMenu\(\);\s*if \(entry\.isDirectory\) \{\s*void toggleDirectoryExpansion\(entry\);\s*return;\s*\}\s*if \(!previewInPane\) \{\s*void openFileTarget\(entry\.absolutePath\);\s*\}\s*\}\}/,
  );
  assert.match(
    source,
    /onDoubleClick=\{\(\) => \{\s*if \(!entry\.isDirectory && previewInPane\) \{\s*void openFilePreview\(entry\.absolutePath\);\s*\}\s*\}\}/,
  );
  assert.match(source, /click to \$\{isExpanded \? "collapse" : "expand"\} folder/);
  assert.match(source, /click to open file, use @ or drag to attach in chat/);
});

test("file explorer attaches folders through @ and drag payloads while preserving internal move gestures", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /import \{\s*EXPLORER_ATTACHMENT_DRAG_TYPE,\s*inferDraggedAttachmentKind,\s*serializeExplorerAttachmentDragPayload,\s*\} from "@\/lib\/attachmentDrag";/,
  );
  assert.match(source, /const entryIsProtected = isProtectedWorkspacePath\(\s*workspaceRootPath,\s*entry\.absolutePath,\s*\);/);
  assert.match(source, /const referenceEntryInChat = useCallback\(/);
  assert.match(source, /onReferenceInChat\?\.\(entry\);/);
  assert.match(source, /aria-label=\{`Attach \$\{entry\.name\} to chat`\}/);
  assert.match(source, /<AtSign size=\{12\} \/>/);
  assert.match(source, /const EXPLORER_INTERNAL_MOVE_DRAG_TYPE =\s*"application\/x-holaboss-file-explorer-move";/);
  assert.match(source, /const rowClassName = `group mb-0\.5 w-full rounded-md px-2 py-1\.5 text-left transition-colors/);
  assert.match(source, /\$\{isRenaming \? "cursor-default" : "cursor-pointer"\}/);
  assert.match(source, /className="flex min-w-0 flex-1 items-center gap-2"/);
  assert.match(source, /style=\{\{ paddingLeft: `\$\{depth \* 16\}px` \}\}/);
  assert.match(source, /className="flex w-full min-w-0 items-center gap-1"/);
  assert.match(source, /className="w-full min-w-0 cursor-pointer text-left"/);
  assert.match(source, /className="flex min-w-0 flex-1 flex-col gap-0\.5"/);
  assert.match(source, /className="flex shrink-0 items-center gap-0\.5"/);
  assert.match(source, /draggable=\{!entryIsProtected\}/);
  assert.match(source, /event\.dataTransfer\.effectAllowed = "copyMove";/);
  assert.match(
    source,
    /event\.dataTransfer\.setData\(\s*EXPLORER_INTERNAL_MOVE_DRAG_TYPE,\s*entry\.absolutePath,\s*\);/,
  );
  assert.match(
    source,
    /event\.dataTransfer\.setData\(\s*EXPLORER_ATTACHMENT_DRAG_TYPE,\s*serializeExplorerAttachmentDragPayload\(\{[\s\S]*kind: entry\.isDirectory\s*\?\s*"folder"\s*:\s*inferDraggedAttachmentKind\(entry\.name\),[\s\S]*\}\),\s*\);/,
  );
  assert.match(source, /if \(entryIsProtected\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/);
  assert.match(source, /const preview = createAttachmentDragPreview\(entry\);/);
  assert.doesNotMatch(source, /event\.dataTransfer\.setData\(\s*"text\/plain"/);
  assert.doesNotMatch(source, /cursor-grab/);
  assert.doesNotMatch(source, /cursor-grabbing/);
  assert.doesNotMatch(source, /className="flex min-w-0 items-center gap-2"\s*style=\{\{ paddingLeft: `\$\{depth \* 16\}px` \}\}/);
  assert.doesNotMatch(source, /className="flex min-w-0 items-center gap-2 pl-6 text-\[11px\] text-muted-foreground"/);
  assert.doesNotMatch(source, /className="mt-0\.5 flex shrink-0 items-center gap-0\.5"/);
  assert.match(source, /use @ or drag to attach in chat/);
});

test("file explorer hides protected workspace system entries from the root tree", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type FileExplorerVisibleSection = \{/);
  assert.match(source, /id: "workspace";/);
  assert.match(source, /rows: FileExplorerVisibleRow\[];/);
  assert.match(source, /function isWorkspaceRootExplorerView\(/);
  assert.match(
    source,
    /const visibleRootEntries = isWorkspaceRootExplorerView\(\s*currentPath,\s*workspaceRootPath,\s*\)\s*\?\s*entries\.filter\(\s*\(entry\) =>\s*!isProtectedWorkspacePath\(workspaceRootPath, entry\.absolutePath\),\s*\)\s*:\s*entries;/,
  );
  assert.match(
    source,
    /return \[\s*\{\s*id: "workspace" as const,\s*rows: buildRows\(visibleRootEntries\),\s*\},\s*\];/,
  );
  assert.match(
    source,
    /const visibleRows = useMemo\(\s*\(\) => filteredEntries\.flatMap\(\(section\) => section\.rows\),\s*\[filteredEntries\],\s*\);/,
  );
  assert.doesNotMatch(source, /id: "protected"/);
  assert.doesNotMatch(source, /Protected workspace files/);
});

test("file explorer keeps a minimal tree header without showing the workspace root row", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /<div className="flex items-center gap-2">[\s\S]*<div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-muted\/50 px-2\.5 py-1\.5 text-xs transition-colors focus-within:border-ring">[\s\S]*placeholder="Search files"[\s\S]*<\/div>[\s\S]*aria-label="Create new item"[\s\S]*aria-label=\{activeBookmark \? "Remove bookmark" : "Add bookmark"\}/,
  );
  assert.doesNotMatch(source, /text-\[11px\] font-medium uppercase tracking-\[0\.14em\] text-muted-foreground\/72">\s*Files\s*</);
  assert.doesNotMatch(source, /const rootFolderLabel = currentPath \? getFolderName\(currentPath\) : "Workspace";/);
  assert.doesNotMatch(source, /const isRootExpanded = normalizedQuery\.length > 0 \|\| expandedDirectoryPaths\[currentPath\] !== false;/);
  assert.doesNotMatch(source, /setExpandedDirectoryPaths\(\(current\) => \(\{\s*\.\.\.current,\s*\[currentPath\]: !isRootExpanded,\s*\}\)\);/);
  assert.doesNotMatch(source, /label="Back"/);
  assert.doesNotMatch(source, /label="Forward"/);
  assert.doesNotMatch(source, /label="Home"/);
  assert.doesNotMatch(source, /buildPathBreadcrumbs/);
  assert.doesNotMatch(source, /const \[history, setHistory\]/);
});

test("file explorer accepts one-shot focus requests for artifact files", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /export type FileExplorerFocusRequest = \{\s*path: string;\s*requestKey: number;\s*\};/);
  assert.match(
    source,
    /interface FileExplorerPaneProps \{\s*focusRequest\?: FileExplorerFocusRequest \| null;\s*onFocusRequestConsumed\?: \(requestKey: number\) => void;\s*previewInPane\?: boolean;\s*onFileOpen\?: \(path: string\) => void;\s*onReferenceInChat\?: \(entry: LocalFileEntry\) => void;\s*onDeleteEntry\?: \(entry: LocalFileEntry\) => void;\s*onOpenLinkInBrowser\?: \(url: string\) => void;\s*embedded\?: boolean;\s*\}/,
  );
  assert.match(source, /const request = focusRequest;\s*if \(lastProcessedFocusRequestKeyRef\.current === request\.requestKey\) \{\s*return;\s*\}/);
  assert.match(
    source,
    /const workspaceRoot =[\s\S]*workspaceRootPath \?\?[\s\S]*await window\.electronAPI\.workspace\.getWorkspaceRoot\(\s*selectedWorkspaceId,\s*\)\);/,
  );
  assert.match(source, /targetPath = resolveWorkspaceTargetPath\(workspaceRoot, targetPath\);/);
  assert.match(source, /const revealPathInTree = useCallback\(/);
  assert.match(source, /await openFileTarget\(targetPath, \{ syncDirectory: true \}\);/);
  assert.match(source, /onFocusRequestConsumed\?\.\(request\.requestKey\);/);
});

test("file explorer adds a markdown preview mode while keeping text editing inline", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const hasVisibleEntryRows = useMemo\(\s*\(\) => visibleRows\.some\(\(row\) => row\.type === "entry"\),\s*\[visibleRows\],\s*\);/,
  );
  assert.match(
    source,
    /if \(loading \|\| error \|\| hasVisibleEntryRows\) \{\s*return;\s*\}\s*resetPreviewState\(\);/,
  );
  assert.match(source, /import \{ SimpleMarkdown \} from "@\/components\/marketplace\/SimpleMarkdown";/);
  assert.match(source, /const MARKDOWN_PREVIEW_EXTENSIONS = new Set\(\[\s*"\.md",\s*"\.mdx",\s*"\.markdown"\s*\]\);/);
  assert.match(source, /const HTML_PREVIEW_EXTENSIONS = new Set\(\[\s*"\.html",\s*"\.htm"\s*\]\);/);
  assert.match(source, /type TextPreviewMode = "edit" \| "preview";/);
  assert.match(
    source,
    /const \[textPreviewMode, setTextPreviewMode\]\s*=\s*useState<TextPreviewMode>\("edit"\);/,
  );
  assert.match(source, /function isHtmlPreviewPayload\(/);
  assert.match(
    source,
    /const prefersRenderedTextPreview =\s*isMarkdownPreviewPayload\(payload\) \|\| isHtmlPreviewPayload\(payload\);\s*setTextPreviewMode\(prefersRenderedTextPreview \? "preview" : "edit"\);/,
  );
  assert.match(
    source,
    /const showInlinePreview =\s*previewInPane &&\s*hasVisibleEntryRows &&\s*Boolean\(preview \|\| previewLoading \|\| previewError\);/,
  );
  assert.match(source, /const explorerPane = embedded \? \(\s*content\s*\) : \(/);
  assert.match(source, /title=\{showInlinePreview \? "File" : ""\}/);
  assert.match(source, /preview\?\.kind === "text" \? \(/);
  assert.match(source, /isMarkdownPreview && textPreviewMode === "preview"/);
  assert.match(source, /<SimpleMarkdown[\s\S]*className="chat-markdown text-sm leading-7 text-foreground"[\s\S]*onLinkClick=\{openPreviewLink\}[\s\S]*\{previewDraft\}[\s\S]*<\/SimpleMarkdown>/);
  assert.match(source, /const supportsRenderedTextPreview = isMarkdownPreview \|\| isHtmlPreview;/);
  assert.match(source, /readOnly=\{!preview\.isEditable\}/);
  assert.match(source, />\s*Preview\s*<\/Button>/);
  assert.match(source, />\s*Edit\s*<\/Button>/);
  assert.match(source, /if \(onOpenLinkInBrowser\) \{\s*onOpenLinkInBrowser\(url\);\s*return;\s*\}/);
  assert.match(source, /window\.electronAPI\.ui\.openExternalUrl\(url\)/);
  assert.match(
    source,
    /const \{ allowed, targetPath: validatedTargetPath \} =\s*await validateWorkspaceScopedTargetPath\(targetPath\);[\s\S]*window\.electronAPI\.fs\.readFilePreview\(\s*validatedTargetPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /const workspaceSessionKey = workspaceSessionKeyRef\.current;\s*const requestKey = \+\+previewRequestKeyRef\.current;/,
  );
  assert.match(
    source,
    /if \(\s*workspaceSessionKey !== workspaceSessionKeyRef\.current \|\|\s*requestKey !== previewRequestKeyRef\.current\s*\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.writeTextFile\(\s*preview\.absolutePath,\s*previewDraft,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /Save/);
});

test("file explorer renders html files inside a sandboxed iframe preview", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const isHtmlPreview = isHtmlPreviewPayload\(preview\);/);
  assert.match(source, /isHtmlPreview && textPreviewMode === "preview"/);
  assert.match(source, /<iframe[\s\S]*title=\{preview\.name\}[\s\S]*sandbox=""[\s\S]*srcDoc=\{previewDraft\}[\s\S]*className="h-full w-full rounded-lg border border-border bg-white"/);
  assert.match(source, /Empty file — switch to Edit to add markup\./);
});

test("file explorer renders editable spreadsheet previews", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{[\s\S]*SpreadsheetEditor,[\s\S]*\} from "@\/components\/panes\/SpreadsheetEditor";/);
  assert.match(
    source,
    /const \[tablePreviewDraft, setTablePreviewDraft\] = useState<[\s\S]*FilePreviewTableSheetPayload\[\][\s\S]*>\(\[\]\);/,
  );
  assert.match(
    source,
    /preview\?\.kind === "table" && preview\.isEditable[\s\S]*!areTablePreviewSheetsEqual\(tablePreviewDraft, preview\.tableSheets\)/,
  );
  assert.match(source, /setTablePreviewDraft\(cloneTablePreviewSheets\(payload\.tableSheets\)\);/);
  assert.match(source, /window\.electronAPI\.fs\.writeTableFile\(\s*preview\.absolutePath,\s*tablePreviewDraft,\s*selectedWorkspaceId \?\? null,\s*\)/);
  assert.match(
    source,
    /<SpreadsheetEditor[\s\S]*sheets=\{previewTableSheets\}[\s\S]*editable=\{preview\.isEditable\}[\s\S]*onChange=\{setTablePreviewDraft\}[\s\S]*onOpenLinkInBrowser=\{openPreviewLink\}/,
  );
});

test("file explorer renders PowerPoint presentation previews", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /import \{ PresentationPreview \} from "@\/components\/panes\/PresentationPreview";/,
  );
  assert.match(
    source,
    /preview\?\.kind === "presentation" && preview\.presentationSlides/,
  );
  assert.match(
    source,
    /<PresentationPreview[\s\S]*slides=\{preview\.presentationSlides\}[\s\S]*slideWidth=\{preview\.presentationWidth\}[\s\S]*slideHeight=\{preview\.presentationHeight\}/,
  );
});

test("file explorer preview metadata omits the absolute file path", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(
    source,
    /\{preview\?\.absolutePath \? <span>\{preview\.absolutePath\}<\/span> : null\}/,
  );
});

test("file explorer warns users to save before leaving an unsaved file", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /You have unsaved changes\. Press Cancel to go back and save them, or OK to discard them\./,
  );
  assert.match(source, /if \(!skipConfirm && !confirmDiscardIfDirty\(\)\) \{\s*return;\s*\}/);
  assert.match(source, /if \(!confirmDiscardIfDirty\(\)\) \{\s*return;\s*\}\s*resetPreviewState\(\);/);
});

test("file explorer assigns richer icons for common file types", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /FileBadge2,/);
  assert.match(source, /FileSpreadsheet,/);
  assert.match(source, /FileVideoCamera,/);
  assert.match(source, /Shield,/);
  assert.match(source, /const SPECIAL_POLICY_FILENAMES = new Set\(\[\s*"agents\.md"\s*\]\);/);
  assert.match(source, /const normalizedFileName = getComparableFileName\(targetName\);/);
  assert.match(source, /if \(SPECIAL_POLICY_FILENAMES\.has\(normalizedFileName\)\) \{\s*return \{\s*Icon: Shield,/);
  assert.match(source, /if \(SPREADSHEET_EXTENSIONS\.has\(extension\)\) \{\s*return \{\s*Icon: FileSpreadsheet,/);
  assert.match(source, /if \(extension === ".pdf"\) \{\s*return \{\s*Icon: FileBadge2,/);
  assert.match(source, /if \(JSON_EXTENSIONS\.has\(extension\)\) \{\s*return \{\s*Icon: FileJson,/);
  assert.match(
    source,
    /const \{ Icon, className \} = getExplorerIconDescriptor\(\s*entry\.name,\s*entry\.isDirectory,\s*\);/,
  );
});

test("file explorer exposes right-click rename and delete actions for entries", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type FileExplorerContextMenuState = \{/);
  assert.match(source, /function remapPathAfterRename\(/);
  assert.match(source, /function remapExplorerPathRecord<T>\(/);
  assert.match(source, /function remapDirectoryEntriesByPath\(/);
  assert.match(
    source,
    /const \[contextMenu, setContextMenu\]\s*=\s*useState<FileExplorerContextMenuState \| null>\(null\);/,
  );
  assert.match(source, /const \[renamingPath, setRenamingPath\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[renameDraft, setRenameDraft\] = useState\(""\);/);
  assert.match(source, /const openEntryContextMenu = useCallback\(/);
  assert.match(
    source,
    /onContextMenu=\{\(event\) => \{\s*event\.preventDefault\(\);\s*if \(isRenaming\) \{\s*return;\s*\}\s*openEntryContextMenu\(entry,\s*\{\s*x: event\.clientX,\s*y: event\.clientY,\s*\}\);\s*\}\}/,
  );
  assert.match(source, /aria-label=\{`More actions for \$\{entry\.name\}`\}/);
  assert.match(
    source,
    /openEntryContextMenu\(entry,\s*\{\s*anchorRect:\s*event\.currentTarget\.getBoundingClientRect\(\),\s*\}\);/,
  );
  assert.doesNotMatch(source, /\{entry\.isDirectory \? \(\s*<Button[\s\S]*aria-label=\{`More actions for \$\{entry\.name\}`\}/);
  assert.match(source, /group-hover:pointer-events-auto group-hover:opacity-100/);
  assert.match(
    source,
    /const menuWidth = Math\.min\(\s*196,\s*Math\.max\(160, contextMenu\.paneBounds\.width - 16\),\s*\);/,
  );
  assert.match(source, /contextMenu\.paneBounds\.right - menuWidth - 8/);
  assert.match(source, /contextMenu\.paneBounds\.bottom - menuHeight - 8/);
  assert.match(source, /setRenamingPath\(entry\.absolutePath\);/);
  assert.match(source, /setRenameDraft\(entry\.name\);/);
  assert.doesNotMatch(source, /const openEntryFromContextMenu = useCallback\(/);
  assert.doesNotMatch(
    source,
    /createPortal\([\s\S]*Expand folder[\s\S]*New file/,
  );
  assert.doesNotMatch(
    source,
    /createPortal\([\s\S]*Collapse folder[\s\S]*New file/,
  );
  assert.doesNotMatch(
    source,
    /createPortal\([\s\S]*Open file[\s\S]*New file/,
  );
  assert.match(source, /ref=\{renameInputRef\}/);
  assert.match(source, /onBlur=\{\(\) => \{\s*void submitRenameEntry\(\);\s*\}\}/);
  assert.match(source, /if \(event\.key === "Enter"\) \{\s*event\.preventDefault\(\);\s*void submitRenameEntry\(\);/);
  assert.match(source, /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*cancelRenameEntry\(\);/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /Delete folder "\$\{entry\.name\}" and all of its contents\? This cannot be undone\./);
  assert.match(
    source,
    /window\.electronAPI\.fs\.renamePath\(\s*sourcePath,\s*nextName,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /const refreshDirectoryEntries = useCallback\(/);
  assert.match(
    source,
    /const parentPath =\s*getParentFolderPath\(sourcePath\)\s*\?\?\s*currentPathRef\.current;/,
  );
  assert.match(
    source,
    /setDirectoryEntriesByPath\(\(current\) =>\s*remapDirectoryEntriesByPath\(current, sourcePath, nextAbsolutePath\),\s*\);/,
  );
  assert.match(
    source,
    /setExpandedDirectoryPaths\(\(current\) =>\s*remapExplorerPathRecord\(current, sourcePath, nextAbsolutePath\),\s*\);/,
  );
  assert.match(
    source,
    /await revealPathInTree\(nextAbsolutePath\);/,
  );
  assert.match(
    source,
    /setPreview\(\(current\) => \{[\s\S]*remapPathAfterRename\(\s*sourcePath,\s*nextAbsolutePath,\s*current\.absolutePath,\s*\)[\s\S]*absolutePath: remappedAbsolutePath,[\s\S]*name: getFolderName\(remappedAbsolutePath\),[\s\S]*\}\);/,
  );
  assert.match(
    source,
    /const shouldRetargetExternalFile =[\s\S]*!previewInPane &&[\s\S]*Boolean\(onFileOpen\) &&[\s\S]*normalizeComparablePath\(selectedPath\) ===[\s\S]*normalizeComparablePath\(sourcePath\);/,
  );
  assert.match(
    source,
    /if \(shouldRetargetExternalFile\) \{\s*onFileOpen\?\.\(nextAbsolutePath\);\s*\}/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.deletePath\(\s*entry\.absolutePath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /Rename…/);
  assert.match(source, /Delete…/);
});

test("file explorer supports keyboard and context-menu copy, cut, and paste for selected entries", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type ExplorerClipboardMode = "copy" \| "cut";/);
  assert.match(source, /type ExplorerClipboardEntry = \{/);
  assert.match(source, /let explorerClipboardEntry: ExplorerClipboardEntry \| null = null;/);
  assert.match(source, /function isEditableKeyboardTarget\(target: EventTarget \| null\)/);
  assert.match(source, /const pasteInFlightRef = useRef\(false\);/);
  assert.match(source, /const copyExplorerEntryToClipboard = useCallback\(/);
  assert.match(
    source,
    /setExplorerAttachmentClipboardEntry\(\{\s*text: normalizedSourcePath,\s*payload: \{/,
  );
  assert.match(source, /window\.electronAPI\.clipboard\s*\.writeText\(normalizedSourcePath\)/);
  assert.match(
    source,
    /if \(mode === "cut"\) \{[\s\S]*protectedWorkspacePathMessage\(\s*workspaceRootPath,\s*normalizedSourcePath,\s*\);/,
  );
  assert.match(
    source,
    /const clipboardName =\s*entry\.name\.trim\(\) \|\| getFolderName\(normalizedSourcePath\);[\s\S]*explorerClipboardEntry = \{\s*mode,\s*sourcePath: normalizedSourcePath,\s*name: clipboardName,\s*isDirectory: entry\.isDirectory,\s*workspaceId: normalizedWorkspaceId,\s*\};/,
  );
  assert.match(source, /const pasteExplorerClipboardIntoDirectory = useCallback\(/);
  assert.match(
    source,
    /if \(clipboardEntry\.workspaceId !== normalizedWorkspaceId\) \{\s*setError\(\s*"Copy, cut, and paste only work within the current workspace\.",\s*\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /clipboardEntry\.mode === "cut"[\s\S]*await moveEntryToDirectory\(\s*clipboardEntry\.sourcePath,\s*normalizedDestinationDirectoryPath,\s*\)/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.copyPath\(\s*clipboardEntry\.sourcePath,\s*normalizedDestinationDirectoryPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /window\.addEventListener\("keydown", handleKeyDown\);[\s\S]*window\.removeEventListener\("keydown", handleKeyDown\);/,
  );
  assert.match(source, /window\.addEventListener\("copy", handleCopy\);/);
  assert.match(source, /window\.addEventListener\("cut", handleCut\);/);
  assert.match(source, /window\.addEventListener\("paste", handleClipboardPaste\);/);
  assert.match(
    source,
    /if \(isEditableKeyboardTarget\(focusTarget\)\) \{\s*return false;\s*\}/,
  );
  assert.match(
    source,
    /if \(normalizedKey === "c"\) \{[\s\S]*copyExplorerEntryToClipboard\(selectedEntry, "copy"\);/,
  );
  assert.match(
    source,
    /if \(normalizedKey === "x"\) \{[\s\S]*copyExplorerEntryToClipboard\(selectedEntry, "cut"\);/,
  );
  assert.match(
    source,
    /if \(normalizedKey === "v"\) \{[\s\S]*void pasteExplorerClipboardIntoDirectory\(creationTargetDirectoryPath\);/,
  );
  assert.match(source, /Copy/);
  assert.match(source, /Cut/);
  assert.match(source, /Paste/);
});

test("file explorer can create new files and folders at the selected directory target", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const creationTargetDirectoryPath = selectedEntry\?\.isDirectory[\s\S]*getParentFolderPath\(selectedEntry\.absolutePath\) \?\? currentPath[\s\S]*: currentPath;/,
  );
  assert.match(source, /aria-label="Create new item"/);
  assert.match(source, /<DropdownMenuContent align="end" sideOffset=\{6\} className="w-40">/);
  assert.match(
    source,
    /window\.electronAPI\.fs\.createPath\(\s*normalizedTargetDirectoryPath,\s*kind,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /disabled=\{!creationTargetDirectoryPath \|\| renameSaving\}/);
  assert.match(source, /setRenamingPath\(payload\.absolutePath\);/);
  assert.match(source, /setRenameDraft\(getFolderName\(payload\.absolutePath\)\);/);
  assert.match(source, /New file/);
  assert.match(source, /New folder/);
});

test("file explorer blocks renaming deleting and moving protected system entries", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function getProtectedWorkspacePathLabel\(/);
  assert.match(source, /function protectedWorkspacePathMessage\(/);
  assert.match(source, /function isProtectedWorkspacePath\(/);
  assert.match(source, /const comparableRelativePath = relativePath\.toLowerCase\(\);/);
  assert.match(
    source,
    /if \(comparableRelativePath === "workspace\.yaml"\) \{\s*return "workspace\.yaml";\s*\}/,
  );
  assert.match(
    source,
    /if \(comparableRelativePath === "agents\.md"\) \{\s*return "AGENTS\.md";\s*\}/,
  );
  assert.match(
    source,
    /if \(comparableRelativePath === "skills"\) \{\s*return "skills";\s*\}/,
  );
  assert.doesNotMatch(source, /if \(relativePath === "agents\.md"\)/);
  assert.doesNotMatch(source, /relativePath\.startsWith\("skills\/"\)/);
  assert.match(
    source,
    /const protectedMessage = protectedWorkspacePathMessage\(\s*workspaceRootPath,\s*entry\.absolutePath,\s*\);\s*if \(protectedMessage\) \{\s*closeContextMenu\(\);\s*setError\(protectedMessage\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /const protectedMessage =\s*protectedWorkspacePathMessage\(workspaceRootPath, normalizedSourcePath\) \|\|\s*protectedWorkspacePathMessage\(\s*workspaceRootPath,\s*normalizedDestinationDirectoryPath,\s*\);\s*if \(protectedMessage\) \{\s*setError\(protectedMessage\);\s*return false;\s*\}/,
  );
  assert.match(
    source,
    /if \(\s*isProtectedWorkspacePath\(workspaceRootPath, normalizedDraggedEntryPath\) \|\|\s*isProtectedWorkspacePath\(workspaceRootPath, normalizedTargetPath\)\s*\) \{\s*return false;\s*\}/,
  );
  assert.match(
    source,
    /disabled=\{contextMenuEntryIsProtected\}[\s\S]*Rename…[\s\S]*disabled=\{contextMenuEntryIsProtected\}[\s\S]*Delete…/,
  );
  assert.match(
    source,
    /The skills folder cannot be renamed, moved, or deleted from the file explorer\./,
  );
  assert.match(
    source,
    /return `\$\{protectedPathLabel\} cannot be renamed, moved, or deleted from the file explorer\.`;/,
  );
  assert.doesNotMatch(source, /creationTargetDirectoryIsProtected/);
  assert.match(source, /const contextMenuTargetDirectoryIsProtected = Boolean\(/);
});

test("file explorer can move dragged files into folder rows", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const \[draggedEntryPath, setDraggedEntryPath\] = useState<string \| null>\(null\);/,
  );
  assert.match(source, /const canMoveDraggedEntryToDirectoryPath = useCallback\(/);
  assert.match(
    source,
    /const \[directoryDropTargetPath, setDirectoryDropTargetPath\] = useState<[\s\S]*string \| null[\s\S]*>\(null\);/,
  );
  assert.match(source, /const canDropDraggedEntryIntoDirectory = useCallback\(/);
  assert.match(
    source,
    /event\.dataTransfer\.dropEffect = canMoveDraggedEntry\s*\?\s*"move"\s*:\s*"copy";/,
  );
  assert.match(
    source,
    /entry\.isDirectory &&\s*hasExternalExplorerDropData\(event\.dataTransfer\)/,
  );
  assert.match(
    source,
    /void moveEntryToDirectory\(\s*draggedEntryPath,\s*entry\.absolutePath,\s*\);/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.movePath\(\s*normalizedSourcePath,\s*normalizedDestinationDirectoryPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /setExpandedDirectoryPaths\(\(current\) => \(\{\s*\.\.\.current,\s*\[normalizedDestinationDirectoryPath\]: true,\s*\}\)\);/,
  );
  assert.match(
    source,
    /await Promise\.all\(\s*refreshTargets\.map\(\(targetPath\) => refreshDirectoryEntries\(targetPath\)\),\s*\);/,
  );
});

test("file explorer can move dragged files to the current directory from pane empty space", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const clearActiveDropTargets = useCallback\(\(\) => \{/);
  assert.match(source, /setDirectoryDropTargetPath\(null\);\s*setPaneExternalDropTarget\(false\);/);
  assert.match(
    source,
    /const canMoveDraggedEntry = canMoveDraggedEntryToDirectoryPath\(\s*currentPathRef\.current,\s*\);/,
  );
  assert.match(
    source,
    /const canImportExternalEntries =\s*hasExternalExplorerDropData\(event\.dataTransfer\) &&\s*Boolean\(currentPathRef\.current\);/,
  );
  assert.match(
    source,
    /if \(!canMoveDraggedEntry && !canImportExternalEntries\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /event\.dataTransfer\.dropEffect = canMoveDraggedEntry \? "move" : "copy";/,
  );
  assert.match(
    source,
    /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*clearActiveDropTargets\(\);\s*if \(canMoveDraggedEntry && draggedEntryPath\) \{\s*void moveEntryToDirectory\(draggedEntryPath,\s*currentPathRef\.current\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /onDragEnd=\{\(\) => \{\s*setDraggedEntryPath\(null\);\s*clearActiveDropTargets\(\);/,
  );
});

test("file explorer imports dragged external files and folders into the tree", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /type ExplorerExternalImportEntry =/);
  assert.match(source, /webkitGetAsEntry\?: \(\) => ExplorerExternalDropEntry \| null;/);
  assert.match(source, /async function collectDroppedExternalEntriesFromEntry\(/);
  assert.match(
    source,
    /const childEntries = await readExternalDropDirectoryEntries\(\s*entry as FileSystemDirectoryEntry,\s*\);/,
  );
  assert.match(source, /content: new Uint8Array\(await file\.arrayBuffer\(\)\),/);
  assert.match(source, /function hasExternalExplorerDropData\(dataTransfer: DataTransfer \| null\)/);
  assert.match(source, /const \[paneExternalDropTarget, setPaneExternalDropTarget\] = useState\(false\);/);
  assert.match(source, /const importExternalEntriesToDirectory = useCallback\(/);
  assert.match(
    source,
    /window\.electronAPI\.fs\.importExternalEntries\(\s*normalizedDestinationDirectoryPath,\s*importedEntries,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /const refreshTargets = \[\s*normalizedDestinationDirectoryPath\s*\]\.filter\(/,
  );
  assert.match(source, /event\.dataTransfer\.dropEffect = canMoveDraggedEntry\s*\?\s*"move"\s*:\s*"copy";/);
  assert.match(
    source,
    /entry\.isDirectory &&\s*hasExternalExplorerDropData\(event\.dataTransfer\)/,
  );
  assert.match(
    source,
    /void importExternalEntriesToDirectory\(\s*event\.dataTransfer,\s*entry\.absolutePath,\s*\);/,
  );
  assert.match(
    source,
    /className=\{`chat-scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1\.5 pb-1\.5 pt-1 \$\{[\s\S]*paneExternalDropTarget[\s\S]*"rounded-md bg-emerald-500\/10 ring-1 ring-emerald-500\/30"[\s\S]*\}`\}/,
  );
  assert.match(source, /onDragOver=\{onPaneDragOver\}/);
  assert.match(source, /onDrop=\{onPaneDrop\}/);
});

test("file explorer preserves multi-file external drops when entry-backed items are incomplete", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function droppedFileRelativePath\(file: File\)/);
  assert.match(
    source,
    /"webkitRelativePath" in file && typeof file\.webkitRelativePath === "string"/,
  );
  assert.match(source, /const file = item\.getAsFile\(\);/);
  assert.match(
    source,
    /if \(importedEntries\.length === 0\) \{\s*return dedupeExplorerExternalImportEntries\(fileEntries\);\s*\}/,
  );
  assert.match(
    source,
    /const hasImportedDirectories = importedEntries\.some\(\s*\(entry\) => entry\.kind === "directory",\s*\);/,
  );
  assert.match(
    source,
    /if \(hasImportedDirectories\) \{\s*return dedupeExplorerExternalImportEntries\(importedEntries\);\s*\}/,
  );
  assert.match(
    source,
    /const importedFilePaths = new Set\(\s*importedEntries[\s\S]*\.map\(\(entry\) => entry\.relativePath\),\s*\);/,
  );
  assert.match(
    source,
    /const hasUnmatchedDroppedFiles = fileEntries\.some\(\s*\(entry\) => !importedFilePaths\.has\(entry\.relativePath\),\s*\);/,
  );
  assert.match(
    source,
    /return dedupeExplorerExternalImportEntries\(\[\s*\.\.\.importedEntries,\s*\.\.\.fileEntries,\s*\]\);/,
  );
});

test("file explorer does not expose a pane-level close action", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /interface FileExplorerPaneProps \{\s*focusRequest\?: FileExplorerFocusRequest \| null;\s*onFocusRequestConsumed\?: \(requestKey: number\) => void;\s*previewInPane\?: boolean;\s*onFileOpen\?: \(path: string\) => void;\s*onReferenceInChat\?: \(entry: LocalFileEntry\) => void;\s*onDeleteEntry\?: \(entry: LocalFileEntry\) => void;\s*onOpenLinkInBrowser\?: \(url: string\) => void;\s*embedded\?: boolean;\s*\}/,
  );
  assert.match(
    source,
    /export function FileExplorerPane\(\{\s*focusRequest = null,\s*onFocusRequestConsumed,\s*previewInPane = true,\s*onFileOpen,\s*onReferenceInChat,\s*onDeleteEntry,\s*onOpenLinkInBrowser,\s*embedded = false,\s*}: FileExplorerPaneProps\)/,
  );
  assert.doesNotMatch(source, /label="Close file explorer"/);
  assert.doesNotMatch(source, /icon=\{<X size=\{1[23]\} \/>/);
});
