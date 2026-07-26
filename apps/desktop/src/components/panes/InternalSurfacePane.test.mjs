import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "InternalSurfacePane.tsx");

test("internal surface renders markdown files with the shared markdown renderer", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{ HtmlPreviewFrame \} from "@\/components\/panes\/HtmlPreviewFrame";/);
  assert.match(source, /import \{ SimpleMarkdown \} from "@\/components\/marketplace\/SimpleMarkdown";/);
  assert.match(source, /const MARKDOWN_PREVIEW_EXTENSIONS = new Set\(\[\s*"\.md",\s*"\.mdx",\s*"\.markdown"\s*\]\);/);
  assert.match(source, /const HTML_PREVIEW_EXTENSIONS = new Set\(\[\s*"\.html",\s*"\.htm"\s*\]\);/);
  assert.match(source, /const \[workspaceRootPath, setWorkspaceRootPath\] = useState<string \| null>\(\s*null,\s*\);/);
  assert.match(source, /const resolveWorkspacePreviewPath = useCallback\(/);
  assert.match(source, /function isMarkdownPreviewPayload\(/);
  assert.match(source, /function isHtmlPreviewPayload\(/);
  assert.match(source, /const \[textPreviewMode, setTextPreviewMode\] =\s*useState<TextPreviewMode>\("edit"\);/);
  assert.match(source, /setTextPreviewMode\("edit"\);/);
  assert.match(source, /if \(preview\.kind === "text"\) \{[\s\S]*\{isMarkdownPreview \? \(/);
  assert.match(source, /const supportsRenderedTextPreview = isMarkdownPreview \|\| isHtmlPreview;/);
  assert.match(source, /<SimpleMarkdown[\s\S]*className="file-preview-markdown"[\s\S]*onLinkClick=\{openPreviewLink\}[\s\S]*onLocalLinkClick=\{handleLocalLinkInPreview\}[\s\S]*\{previewDraft\}[\s\S]*<\/SimpleMarkdown>/);
  assert.match(source, /isHtmlPreview && textPreviewMode === "preview"/);
  assert.match(source, /<HtmlPreviewFrame[\s\S]*title=\{preview\.name\}[\s\S]*html=\{previewDraft\}[\s\S]*onOpenLinkInBrowser=\{openPreviewLink\}[\s\S]*onOpenLocalLink=\{handleLocalLinkInPreview\}[\s\S]*className="h-full w-full rounded-lg border border-border bg-white"/);
  assert.match(source, /Empty file — switch to Edit to add markup\./);
  assert.match(source, /if \(onOpenLinkInBrowser\) \{\s*onOpenLinkInBrowser\(url\);\s*return;\s*\}/);
  assert.match(source, /window\.electronAPI\.ui\.openExternalUrl\(url\)/);
  assert.match(source, /const handleLocalLinkInPreview = useCallback\(/);
  assert.match(source, /onResourceMissing\?: \(resourceId: string\) => void;/);
  assert.match(
    source,
    /const resolvedTargetPath = await resolveWorkspacePreviewPath\(targetPath\);[\s\S]*if \(!resolvedTargetPath\) \{[\s\S]*setPreview\(null\);[\s\S]*setErrorMessage\(""\);[\s\S]*return;\s*\}[\s\S]*window\.electronAPI\.fs\.readFilePreview\(\s*resolvedTargetPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /function isMissingFilePreviewError\(cause: unknown\)/);
  assert.match(
    source,
    /if \(isMissingFilePreviewError\(error\)\) \{\s*setErrorMessage\(""\);[\s\S]*onResourceMissing\?\.\(targetPath\);[\s\S]*setIsSaving\(false\);[\s\S]*return;\s*\}/,
  );
});

test("internal surface renders html files inside a sandboxed iframe preview", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const HTML_PREVIEW_EXTENSIONS = new Set\(\[\s*"\.html",\s*"\.htm"\s*\]\);/);
  assert.match(source, /function isHtmlPreviewPayload\(/);
  assert.match(source, /const exportHtmlPreviewAsPdf = useCallback\(/);
  assert.match(source, /window\.electronAPI\.fs\.exportHtmlToPdf\(payload\)/);
  assert.match(source, /suggestedName: pdfExportSuggestedName\(\s*resourceId \|\| "output-preview",\s*\)/);
  assert.match(source, /suggestedName: pdfExportSuggestedName\(\s*preview\.name,\s*\)/);
  assert.match(source, /basePath: preview\.absolutePath,/);
  assert.match(source, /Export the rendered HTML preview as a PDF\./);
  assert.match(source, /aria-label="Export PDF"/);
  assert.match(source, /const isHtmlPreview = isHtmlPreviewPayload\(preview\);/);
  assert.match(source, /const supportsRenderedTextPreview = isMarkdownPreview \|\| isHtmlPreview;/);
  assert.match(source, /isHtmlPreview && textPreviewMode === "preview"/);
  assert.match(source, /<HtmlPreviewFrame[\s\S]*title=\{preview\.name\}[\s\S]*html=\{previewDraft\}[\s\S]*onOpenLinkInBrowser=\{openPreviewLink\}[\s\S]*onOpenLocalLink=\{handleLocalLinkInPreview\}[\s\S]*className="h-full w-full rounded-lg border border-border bg-white"/);
  assert.match(source, /Empty file — switch to Edit to add markup\./);
});

test("internal surface preview omits absolute path metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(
    source,
    /MetadataRow label="Path" value=\{preview\.absolutePath\}/,
  );
  assert.doesNotMatch(
    source,
    /MetadataRow label="Target" value=\{resourceId\}/,
  );
});

test("internal surface enables editing and saving for file displays", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const savePreview = useCallback\(async \(\) => \{[\s\S]*window\.electronAPI\.fs\.writeTextFile\(\s*preview\.absolutePath,\s*previewDraft,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /window\.electronAPI\.fs\.writeTableFile\(\s*preview\.absolutePath,\s*tablePreviewDraft,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(
    source,
    /const \[tablePreviewDraft, setTablePreviewDraft\] = useState<[\s\S]*FilePreviewTableSheetPayload\[\][\s\S]*>\(\[\]\);/,
  );
  assert.match(
    source,
    /<textarea[\s\S]*value=\{previewDraft\}[\s\S]*onChange=\{\(event\) => setPreviewDraft\(event\.target\.value\)\}[\s\S]*readOnly=\{!preview\.isEditable\}/,
  );
  assert.match(
    source,
    /{preview\.isEditable \? \(\s*<Button[\s\S]*onClick=\{\(\) => void savePreview\(\)\}[\s\S]*\{isSaving \? "Saving" : "Save"\}/,
  );
  assert.match(
    source,
    /<SpreadsheetEditor[\s\S]*sheets=\{tablePreviewDraft\}[\s\S]*editable=\{preview\.isEditable\}[\s\S]*onChange=\{setTablePreviewDraft\}[\s\S]*onOpenLinkInBrowser=\{openPreviewLink\}/,
  );
});

test("internal surface renders editable spreadsheet previews", async () => {
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
  assert.match(source, /setTablePreviewDraft\(cloneTablePreviewSheets\(nextPreview\.tableSheets\)\);/);
  assert.match(source, /window\.electronAPI\.fs\.writeTableFile\(\s*preview\.absolutePath,\s*tablePreviewDraft,\s*selectedWorkspaceId \?\? null,\s*\)/);
  assert.match(
    source,
    /<SpreadsheetEditor[\s\S]*sheets=\{tablePreviewDraft\}[\s\S]*editable=\{preview\.isEditable\}[\s\S]*onChange=\{setTablePreviewDraft\}[\s\S]*onOpenLinkInBrowser=\{openPreviewLink\}/,
  );
});

test("internal surface renders PowerPoint presentation previews", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /import \{ PresentationPreview \} from "@\/components\/panes\/PresentationPreview";/,
  );
  assert.match(
    source,
    /preview\.kind === "presentation" && preview\.presentationSlides/,
  );
  assert.match(
    source,
    /<PresentationPreview[\s\S]*slides=\{preview\.presentationSlides\}[\s\S]*slideWidth=\{preview\.presentationWidth\}[\s\S]*slideHeight=\{preview\.presentationHeight\}/,
  );
});

test("internal surface refreshes open file previews when the backing file changes on disk", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const isDirtyRef = useRef\(false\);/);
  assert.match(source, /const isSavingRef = useRef\(false\);/);
  assert.match(source, /const pendingExternalRefreshPathRef = useRef<string \| null>\(null\);/);
  assert.match(
    source,
    /const resolvedWatchedPath =\s*await resolveWorkspacePreviewPath\(watchedPath\);[\s\S]*if \(!resolvedWatchedPath\) \{\s*return;\s*\}[\s\S]*window\.electronAPI\.fs\.watchFile\(\s*resolvedWatchedPath,\s*selectedWorkspaceId \?\? null,\s*\)/,
  );
  assert.match(source, /const unsubscribe = window\.electronAPI\.fs\.onFileChange\(\(payload\) => \{/);
  assert.match(source, /if \(isDirtyRef\.current\) \{\s*pendingExternalRefreshPathRef\.current = changedPath;\s*return;\s*\}/);
  assert.match(source, /void loadPreviewFromDisk\(changedPath,\s*\{\s*preserveViewState: true,\s*showLoading: false,\s*\}\);/);
  assert.match(source, /void window\.electronAPI\.fs\.unwatchFile\(subscriptionId\);/);
  assert.match(source, /const pendingPath = pendingExternalRefreshPathRef\.current;/);
});
