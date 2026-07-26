import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowUpRight,
  Code2,
  Download,
  Eye,
  FileText,
  FileX2,
  Loader2,
} from "@/components/ui/icons";
import { useDefaultApp } from "@/lib/useFileIcon";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";
import type { FUniver } from "@univerjs/presets";
import { MarkdownEditor as TiptapMarkdownEditor } from "@holaboss/editor";
import { HtmlPreviewFrame } from "@/components/panes/HtmlPreviewFrame";
import { PresentationPreview } from "@/components/panes/PresentationPreview";
import {
  SpreadsheetEditor,
  areTablePreviewSheetsEqual,
  cloneTablePreviewSheets,
} from "@/components/panes/SpreadsheetEditor";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  documentEngineAtom,
  presentationEngineAtom,
  spreadsheetEngineAtom,
} from "@/lib/spreadsheetEngine";
import { slideDataFromPresentation } from "@/lib/presentationToSlideData";
import { univerDocumentBodyToHtml } from "@/lib/univerDocToHtml";
import { docxBytesToStyledHtml } from "@/lib/docxToStyledHtml";
import { useIsDarkTheme } from "@/lib/themeAttr";
import { resolveLocalHrefToAbsolutePath } from "@/lib/workspacePaths";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { MentionInChatButton } from "./MentionInChatButton";
import { PinStarButton } from "./PinStarButton";
import { fileNameFromPath } from "./state/internalTabs";
import { removeRecentFileByPathAtom } from "./state/recentFiles";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

const DocxEditorMount = lazy(
  () => import("@/components/panes/DocxEditorMount"),
);

const PptxRendererMount = lazy(
  () => import("@/components/panes/PptxRendererMount"),
);

const UniverSpreadsheetView = lazy(() =>
  import("@/components/panes/UniverSpreadsheetView").then((module) => ({
    default: module.UniverSpreadsheetView,
  })),
);

const UniverDocView = lazy(() =>
  import("@/components/panes/UniverDocView").then((module) => ({
    default: module.UniverDocView,
  })),
);

const UniverSlideView = lazy(() =>
  import("@/components/panes/UniverSlideView").then((module) => ({
    default: module.UniverSlideView,
  })),
);

interface FilePreviewPaneProps {
  filePath: string;
  onClose?: () => void;
}

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXTS = new Set([".html", ".htm"]);

// "Open in <App>" — resolves and shows the real default app's name + icon
// (e.g. "Open in Xcode"), falling back to a generic glyph + "default app".
function OpenInDefaultAppButton({
  absolutePath,
  workspaceId,
  onOpen,
  size = "xs",
  variant = "ghost",
}: {
  absolutePath: string;
  workspaceId: string | null;
  onOpen: () => void;
  size?: "xs" | "sm";
  variant?: "ghost" | "default";
}) {
  const { name, iconUrl } = useDefaultApp(absolutePath, workspaceId);
  return (
    <Button onClick={onOpen} size={size} type="button" variant={variant}>
      {iconUrl ? (
        <img
          alt=""
          className="size-3.5 shrink-0 object-contain"
          src={iconUrl}
        />
      ) : (
        <ArrowUpRight className="size-3.5" />
      )}
      {name ? `Open in ${name}` : "Open in default app"}
    </Button>
  );
}

function isNotFoundError(message: string): boolean {
  return /ENOENT|no such file or directory|not found/i.test(message);
}

export function FilePreviewPane({ filePath, onClose }: FilePreviewPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const removeRecentFileByPath = useSetAtom(removeRecentFileByPathAtom);
  const spreadsheetEngine = useAtomValue(spreadsheetEngineAtom);
  const documentEngine = useAtomValue(documentEngineAtom);
  const presentationEngine = useAtomValue(presentationEngineAtom);
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tableSheetIndex, setTableSheetIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    setTableSheetIndex(0);
    void (async () => {
      try {
        const payload = await window.electronAPI.fs.readFilePreview(
          filePath,
          selectedWorkspaceId ?? null,
        );
        if (!cancelled) setPreview(payload);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, selectedWorkspaceId]);

  // Watch the file on disk so external edits (Pages saves the docx,
  // Excel saves the xlsx, the agent writes a new revision) flow back
  // into the preview pane without a manual refresh. Re-fetches on
  // every fs:fileChanged event matching this preview's absolutePath.
  const previewAbsolutePath = preview?.absolutePath ?? null;
  useEffect(() => {
    if (!previewAbsolutePath) return;
    let cancelled = false;
    let subscriptionId: string | null = null;
    let inFlight = false;
    let pendingRefresh = false;

    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) {
        pendingRefresh = true;
        return;
      }
      inFlight = true;
      try {
        const next = await window.electronAPI.fs.readFilePreview(
          filePath,
          selectedWorkspaceId ?? null,
        );
        if (!cancelled) setPreview(next);
      } catch {
        // Atomic-save dance (write → rename) can briefly delete the file;
        // tolerate the transient ENOENT and rely on the next event.
      } finally {
        inFlight = false;
        if (pendingRefresh && !cancelled) {
          pendingRefresh = false;
          void refresh();
        }
      }
    };

    const unsubscribe = window.electronAPI.fs.onFileChange((payload) => {
      if (payload.absolutePath !== previewAbsolutePath) return;
      void refresh();
    });

    void (async () => {
      try {
        const subscription = await window.electronAPI.fs.watchFile(
          filePath,
          selectedWorkspaceId ?? null,
        );
        if (cancelled) {
          void window.electronAPI.fs.unwatchFile(subscription.subscriptionId);
          return;
        }
        subscriptionId = subscription.subscriptionId;
      } catch {
        // best-effort — without a watcher the preview just won't auto-refresh
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      if (subscriptionId) {
        void window.electronAPI.fs.unwatchFile(subscriptionId);
      }
    };
  }, [previewAbsolutePath, filePath, selectedWorkspaceId]);

  if (error) {
    const notFound = isNotFoundError(error);
    const fileName = fileNameFromPath(filePath);
    const handleClose = () => {
      if (notFound) {
        removeRecentFileByPath({
          filePath,
          workspaceId: selectedWorkspaceId ?? null,
        });
      }
      onClose?.();
    };
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="flex max-w-md flex-col items-center gap-3">
          <FileX2 className="size-8 text-muted-foreground/60" />
          <div className="text-sm font-medium text-foreground">
            {notFound ? "File not found" : "Couldn't open this file"}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            {fileName}
          </div>
          {!notFound ? (
            <div className="break-all text-xs text-muted-foreground/80">
              {error}
            </div>
          ) : null}
          {onClose ? (
            <Button size="sm" variant="secondary" onClick={handleClose}>
              Close tab
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (preview.kind === "image" && preview.dataUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
        <img
          src={preview.dataUrl}
          alt={preview.name}
          className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
        />
      </div>
    );
  }

  if (preview.kind === "video" && preview.dataUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={preview.dataUrl}
          controls
          autoPlay
          loop
          className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
        />
      </div>
    );
  }

  if (preview.kind === "pdf" && preview.dataUrl) {
    return (
      <iframe
        src={preview.dataUrl}
        title={preview.name}
        className="h-full w-full border-0"
      />
    );
  }

  if (preview.kind === "presentation") {
    if (
      presentationEngine === "univer" &&
      preview.presentationSlides &&
      preview.presentationSlides.length > 0
    ) {
      return (
        <UniverSlideSurface
          preview={preview}
          workspaceId={selectedWorkspaceId ?? null}
        />
      );
    }
    return (
      <PptxPresentationSurface
        preview={preview}
        workspaceId={selectedWorkspaceId ?? null}
      />
    );
  }

  if (preview.kind === "document") {
    if (preview.extension.toLowerCase() === ".docx") {
      if (documentEngine === "univer" && preview.content) {
        return (
          <UniverDocSurface
            preview={preview}
            workspaceId={selectedWorkspaceId ?? null}
            onUpdated={setPreview}
          />
        );
      }
      return (
        <DocxDocumentSurface
          preview={preview}
          workspaceId={selectedWorkspaceId ?? null}
          onUpdated={setPreview}
        />
      );
    }
    return (
      <DocumentPreview
        preview={preview}
        workspaceId={selectedWorkspaceId ?? null}
      />
    );
  }

  if (preview.kind === "table" && preview.tableSheets) {
    if (spreadsheetEngine === "univer" && preview.univerSnapshot) {
      return (
        <UniverSpreadsheetSurface
          preview={preview}
          workspaceId={selectedWorkspaceId ?? null}
          onUpdated={setPreview}
        />
      );
    }
    return (
      <SpreadsheetSurface
        preview={preview}
        workspaceId={selectedWorkspaceId ?? null}
        onUpdated={setPreview}
        activeSheetIndex={tableSheetIndex}
        onActiveSheetIndexChange={setTableSheetIndex}
      />
    );
  }

  if (preview.kind === "text") {
    const ext = preview.extension.toLowerCase();
    if (MARKDOWN_EXTS.has(ext)) {
      return (
        <MarkdownEditor
          preview={preview}
          workspaceId={selectedWorkspaceId ?? null}
          onUpdated={setPreview}
        />
      );
    }
    if (HTML_EXTS.has(ext)) {
      return (
        <HtmlPreview
          preview={preview}
          workspaceId={selectedWorkspaceId ?? null}
          onUpdated={setPreview}
        />
      );
    }
    return (
      <TextEditor
        preview={preview}
        workspaceId={selectedWorkspaceId ?? null}
        onUpdated={setPreview}
      />
    );
  }

  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="max-w-md text-sm text-muted-foreground">
        {preview.unsupportedReason || "Preview unavailable for this file type."}
      </div>
    </div>
  );
}
interface EditorSurfaceProps {
  preview: FilePreviewPayload;
  workspaceId: string | null;
  onUpdated: (next: FilePreviewPayload) => void;
}

function useFileDraft(
  preview: FilePreviewPayload,
  workspaceId: string | null,
  onUpdated: (next: FilePreviewPayload) => void,
) {
  const [draft, setDraft] = useState(preview.content ?? "");
  const [saving, setSaving] = useState(false);

  // Reset whenever we switch files OR the on-disk content changes
  // beneath us (e.g. external write); keying on absolutePath +
  // preview.modifiedAt lets us re-baseline cleanly.
  useEffect(() => {
    setDraft(preview.content ?? "");
  }, [preview.absolutePath, preview.modifiedAt, preview.content]);

  const dirty = draft !== (preview.content ?? "");

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await window.electronAPI.fs.writeTextFile(
        preview.absolutePath,
        draft,
        workspaceId,
      );
      onUpdated(next);
    } catch {
      // surface left to the dirty indicator; user can retry
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, preview.absolutePath, workspaceId, onUpdated]);

  // Send the live draft so unsaved edits ride along — exporting must not
  // mutate the working file as a side effect.
  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name, content: draft },
      );
    } catch {
      // dialog cancellation and write errors are both surfaced natively
    }
  }, [preview.absolutePath, preview.name, workspaceId, draft]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [dirty, draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { draft, setDraft, dirty, saving, save, exportFile };
}

function pdfExportSuggestedName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? "").trim();
  const segments = trimmed
    .split(/[/\\]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const leaf = segments.length > 0 ? segments[segments.length - 1]! : "";
  if (!leaf) return "export.pdf";
  return `${leaf.replace(/\.[^./\\]+$/u, "")}.pdf`;
}

function ExportFileButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label="Export file"
          />
        }
      >
        <Download className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="py-1">
        Export file
      </TooltipContent>
    </Tooltip>
  );
}

function ExportPdfButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label="Export PDF"
          />
        }
      >
        <FileText className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="py-1">
        Export PDF
      </TooltipContent>
    </Tooltip>
  );
}

function MarkdownEditor({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const { draft, setDraft, dirty, saving, save, exportFile } = useFileDraft(
    preview,
    workspaceId,
    onUpdated,
  );
  const { openUrlInBrowserTab, openFileInInternalTab } = useOpenWorkspaceOutput();
  const editable = preview.isEditable;
  const sourceAbsolutePath = preview.absolutePath;
  const handleLocalLink = useCallback(
    (href: string) => {
      const resolved = resolveLocalHrefToAbsolutePath(
        href,
        sourceAbsolutePath,
      );
      if (resolved) {
        openFileInInternalTab(resolved);
      }
    },
    [openFileInInternalTab, sourceAbsolutePath],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {dirty ? (
          <span className="text-[11px] text-muted-foreground">Unsaved</span>
        ) : null}
        {editable && dirty ? (
          <Button
            size="xs"
            variant="default"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            Save
          </Button>
        ) : null}
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-10 py-8">
          <TiptapMarkdownEditor
            value={draft}
            onChange={setDraft}
            readOnly={!editable}
            placeholder="Press / for commands…"
            onLinkClick={(url) => void openUrlInBrowserTab(url)}
            onLocalLinkClick={handleLocalLink}
          />
        </div>
      </div>
    </div>
  );
}

type HtmlViewMode = "preview" | "source";

function HtmlPreview({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const { draft, setDraft, dirty, saving, save, exportFile } = useFileDraft(
    preview,
    workspaceId,
    onUpdated,
  );
  const [mode, setMode] = useState<HtmlViewMode>("preview");
  const { openUrlInBrowserTab, openFileInInternalTab } = useOpenWorkspaceOutput();
  const editable = preview.isEditable;
  const sourceAbsolutePath = preview.absolutePath;

  const exportPdf = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportHtmlToPdf({
        html: draft,
        suggestedName: pdfExportSuggestedName(preview.name),
        basePath: preview.absolutePath,
      });
    } catch {
      // surfaced natively by the save dialog
    }
  }, [draft, preview.name, preview.absolutePath]);

  const handleLocalLink = useCallback(
    (href: string) => {
      const resolved = resolveLocalHrefToAbsolutePath(
        href,
        sourceAbsolutePath,
      );
      if (resolved) {
        openFileInInternalTab(resolved);
      }
    },
    [openFileInInternalTab, sourceAbsolutePath],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              mode === "preview"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="size-3" strokeWidth={1.75} />
            Preview
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              mode === "source"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="size-3" strokeWidth={1.75} />
            Source
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-muted-foreground">Unsaved</span>
          ) : null}
          {editable && dirty ? (
            <Button
              size="xs"
              variant="default"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-3 animate-spin" /> : null}
              Save
            </Button>
          ) : null}
          <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
          <ExportPdfButton
            onClick={() => void exportPdf()}
            disabled={!draft.trim()}
          />
          <ExportFileButton onClick={() => void exportFile()} />
        </div>
      </div>
      {mode === "preview" ? (
        draft.trim() ? (
          <div className="min-h-0 flex-1 overflow-hidden bg-muted p-4">
            <HtmlPreviewFrame
              title={preview.name}
              html={draft}
              onOpenLinkInBrowser={(url) => void openUrlInBrowserTab(url)}
              onOpenLocalLink={handleLocalLink}
              className="h-full w-full rounded-lg border border-border bg-white"
            />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <div className="text-xs text-muted-foreground">
              Empty file — switch to Source to add markup.
            </div>
          </div>
        )
      ) : (
        <textarea
          aria-label={`Edit ${preview.name}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={!editable}
          spellCheck={false}
          className={cn(
            "min-h-0 flex-1 resize-none border-0 bg-muted px-6 py-5 font-mono text-[13px] leading-6 text-foreground outline-none",
            !editable && "cursor-default opacity-80",
          )}
        />
      )}
    </div>
  );
}

function DocumentPreview({
  preview,
  workspaceId,
}: {
  preview: FilePreviewPayload;
  workspaceId: string | null;
}) {
  const { openUrlInBrowserTab, openFileInInternalTab } = useOpenWorkspaceOutput();
  const sourceAbsolutePath = preview.absolutePath;
  const html = preview.content ?? "";

  const openInDefaultApp = useCallback(async () => {
    try {
      await window.electronAPI.fs.openInDefaultApp(
        preview.absolutePath,
        workspaceId,
      );
    } catch {
      // surfaced natively by the OS dialog if no app is registered
    }
  }, [preview.absolutePath, workspaceId]);

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name },
      );
    } catch {
      // dialog cancellation handled natively
    }
  }, [preview.absolutePath, preview.name, workspaceId]);

  const handleLocalLink = useCallback(
    (href: string) => {
      const resolved = resolveLocalHrefToAbsolutePath(
        href,
        sourceAbsolutePath,
      );
      if (resolved) {
        openFileInInternalTab(resolved);
      }
    },
    [openFileInInternalTab, sourceAbsolutePath],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        <OpenInDefaultAppButton
          absolutePath={preview.absolutePath}
          onOpen={() => void openInDefaultApp()}
          workspaceId={workspaceId}
        />
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      {html.trim() ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted p-4">
          <HtmlPreviewFrame
            title={preview.name}
            html={wrapDocxPreviewHtml(html)}
            onOpenLinkInBrowser={(url) => void openUrlInBrowserTab(url)}
            onOpenLocalLink={handleLocalLink}
            className="h-full w-full rounded-lg border border-border bg-white"
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="text-xs text-muted-foreground">
              Empty document
            </div>
            <OpenInDefaultAppButton
              absolutePath={preview.absolutePath}
              onOpen={() => void openInDefaultApp()}
              size="sm"
              variant="default"
              workspaceId={workspaceId}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// mammoth returns naked HTML (no document/head wrapper); inject minimal
// reset + typography so the iframe doesn't render in 8px serif default
// browser styling.
function wrapDocxPreviewHtml(body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body {
    margin: 0;
    padding: 48px 56px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3; }
  h1 { font-size: 1.9em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  p { margin: 0 0 0.8em 0; }
  ul, ol { padding-left: 1.4em; margin: 0 0 0.8em 0; }
  table { border-collapse: collapse; margin: 1em 0; }
  td, th { border: 1px solid #d0d0d0; padding: 6px 10px; }
  a { color: #2563eb; }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #d0d0d0; margin: 1em 0; padding: 0 1em; color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function DocxDocumentSurface({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const editorRef = useRef<DocxEditorRef>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Dirty/saved tracking is a monotonic revision counter rather than a
  // boolean flag: every armed edit bumps `rev`, and a successful write
  // records the rev it persisted. `dirty = rev !== savedRev` is derived,
  // so a save that lands while the user is still typing can't mask the
  // newer edits (the classic debounce data-loss window) — savedRev simply
  // stays behind `rev` and the autosave effect reschedules. A failed write
  // leaves savedRev behind too, which is what gives us automatic retry.
  const [rev, setRev] = useState(0);
  const [savedRev, setSavedRev] = useState(0);
  const [saving, setSaving] = useState(false);
  const armedRef = useRef(false);
  const revRef = useRef(0);
  const savingRef = useRef(false);

  // Load the raw .docx bytes once per file. Keyed on absolutePath ONLY (not
  // modifiedAt): the editor owns the in-memory document while open, so our
  // own writes — and the watcher refresh they trigger — must not remount it
  // and drop the caret.
  const absolutePath = preview.absolutePath;
  useEffect(() => {
    let cancelled = false;
    armedRef.current = false;
    revRef.current = 0;
    setRev(0);
    setSavedRev(0);
    setBytes(null);
    setLoadFailed(false);
    void (async () => {
      try {
        const raw = await window.electronAPI.fs.readFileBytes(
          absolutePath,
          workspaceId,
        );
        if (!cancelled) {
          setBytes(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [absolutePath, workspaceId]);

  const dirty = rev !== savedRev;

  // The single writer. Snapshots the rev at call time so concurrent edits
  // advance `rev` past it and keep the doc dirty for the next cycle.
  const persistBuffer = useCallback(
    async (buffer: ArrayBuffer) => {
      if (savingRef.current) return;
      const targetRev = revRef.current;
      savingRef.current = true;
      setSaving(true);
      try {
        const next = await window.electronAPI.fs.writeBinaryFile(
          absolutePath,
          new Uint8Array(buffer),
          workspaceId,
        );
        setSavedRev(targetRev);
        onUpdated(next);
      } catch {
        // savedRev stays behind rev → the autosave effect reschedules a retry
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [absolutePath, workspaceId, onUpdated],
  );

  const saveNow = useCallback(async () => {
    const ref = editorRef.current;
    if (!ref || savingRef.current) return;
    const buffer = await ref.save();
    if (buffer) await persistBuffer(buffer);
  }, [persistBuffer]);

  // Idle autosave — docx editing is many small mutations, so wait for a
  // pause rather than relying on Cmd+S muscle memory. Re-runs whenever rev,
  // savedRev, or saving change: a new edit, a completed save that left
  // edits behind, or a failed save all reschedule a write here.
  const saveRef = useRef(saveNow);
  useEffect(() => {
    saveRef.current = saveNow;
  }, [saveNow]);
  useEffect(() => {
    if (rev === savedRev || saving) return;
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [rev, savedRev, saving]);

  const exportFile = useCallback(async () => {
    if (dirty) await saveNow();
    try {
      await window.electronAPI.fs.exportFileTo(absolutePath, workspaceId, {
        suggestedName: preview.name,
      });
    } catch {
      // dialog cancellation handled natively
    }
  }, [absolutePath, preview.name, workspaceId, dirty, saveNow]);

  if (loadFailed) {
    return <DocumentPreview preview={preview} workspaceId={workspaceId} />;
  }

  const titleBarRight = (
    <div className="flex items-center gap-2">
      {saving ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Saving…
        </span>
      ) : dirty ? (
        <span className="text-[11px] text-muted-foreground">Unsaved</span>
      ) : null}
      <PinStarButton
        favorite={{
          kind: "file",
          workspaceId,
          filePath: absolutePath,
          label: preview.name,
        }}
        notify
      />
      <MentionInChatButton absolutePath={absolutePath} />
      <ExportFileButton onClick={() => void exportFile()} />
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {bytes ? (
        <Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <DocxEditorMount
            ref={editorRef}
            documentBuffer={bytes}
            mode="editing"
            documentName={preview.name}
            style={{ height: "100%" }}
            onEditorViewReady={() => {
              window.setTimeout(() => {
                armedRef.current = true;
              }, 400);
            }}
            onChange={() => {
              if (!armedRef.current) return;
              revRef.current += 1;
              setRev(revRef.current);
            }}
            onSave={(buffer) => void persistBuffer(buffer)}
            onError={() => setLoadFailed(true)}
            renderTitleBarRight={() => titleBarRight}
          />
        </Suspense>
      ) : (
        <div className="grid h-full place-items-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function PptxPresentationSurface({
  preview,
  workspaceId,
}: {
  preview: FilePreviewPayload;
  workspaceId: string | null;
}) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [failed, setFailed] = useState(false);
  const absolutePath = preview.absolutePath;

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setFailed(false);
    void (async () => {
      try {
        const raw = await window.electronAPI.fs.readFileBytes(
          absolutePath,
          workspaceId,
        );
        if (!cancelled) {
          setBytes(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [absolutePath, workspaceId]);

  const openInDefaultApp = useCallback(async () => {
    try {
      await window.electronAPI.fs.openInDefaultApp(absolutePath, workspaceId);
    } catch {
      // surfaced natively by the OS dialog if no app is registered
    }
  }, [absolutePath, workspaceId]);

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(absolutePath, workspaceId, {
        suggestedName: preview.name,
      });
    } catch {
      // dialog cancellation handled natively
    }
  }, [absolutePath, preview.name, workspaceId]);

  // Fall back to the legacy text reconstruction when the bytes can't load or
  // the renderer throws on a malformed deck — never leave the user staring at
  // a blank pane.
  if (failed) {
    return (
      <PresentationPreview
        name={preview.name}
        slides={preview.presentationSlides ?? []}
        slideWidth={preview.presentationWidth}
        slideHeight={preview.presentationHeight}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        <OpenInDefaultAppButton
          absolutePath={absolutePath}
          onOpen={() => void openInDefaultApp()}
          workspaceId={workspaceId}
        />
        <PinStarButton
        favorite={{
          kind: "file",
          workspaceId,
          filePath: absolutePath,
          label: preview.name,
        }}
        notify
      />
      <MentionInChatButton absolutePath={absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted px-6 py-5">
        <div className="mx-auto max-w-5xl">
          {bytes ? (
            <Suspense
              fallback={
                <div className="grid place-items-center py-24">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <PptxRendererMount bytes={bytes} onError={() => setFailed(true)} />
            </Suspense>
          ) : (
            <div className="grid place-items-center py-24">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UniverSlideSurface({
  preview,
  workspaceId,
}: {
  preview: FilePreviewPayload;
  workspaceId: string | null;
}) {
  const isDark = useIsDarkTheme();
  const slideData = useMemo(
    () =>
      slideDataFromPresentation(preview.presentationSlides ?? [], {
        width: preview.presentationWidth,
        height: preview.presentationHeight,
        title: preview.name,
      }),
    [
      preview.presentationSlides,
      preview.presentationWidth,
      preview.presentationHeight,
      preview.name,
    ],
  );

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name },
      );
    } catch {
      // dialog cancellation handled natively
    }
  }, [preview.absolutePath, preview.name, workspaceId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        <span className="mr-auto text-[11px] text-muted-foreground">
          Preview only
        </span>
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <UniverSlideView
            key={preview.absolutePath}
            slideData={slideData}
            darkMode={isDark}
          />
        </Suspense>
      </div>
    </div>
  );
}

function UniverDocSurface({
  preview,
  workspaceId,
  onUpdated,
}: EditorSurfaceProps) {
  const isDark = useIsDarkTheme();
  const editable = preview.isEditable || preview.extension === ".docx";
  const apiRef = useRef<FUniver | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Mount the doc from this HTML; replaced only on file switch / external
  // write, never on our own save echoes. Starts empty and is filled by the
  // effect below — we render color from the raw .docx, not preview.content
  // (mammoth strips it).
  const [mountHtml, setMountHtml] = useState("");
  const [mountKey, setMountKey] = useState(0);
  const lastSavedModifiedAtRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Ignore the modifiedAt bump from our own save so the editor isn't
    // remounted (dropping the caret) right after persisting.
    if (
      bootstrappedRef.current &&
      preview.modifiedAt === lastSavedModifiedAtRef.current
    ) {
      return;
    }
    bootstrappedRef.current = true;
    void (async () => {
      // Convert the raw .docx directly so text color and shading survive;
      // fall back to the (colorless) mammoth HTML only if that fails.
      let html = preview.content ?? "";
      try {
        const raw = await window.electronAPI.fs.readFileBytes(
          preview.absolutePath,
          workspaceId,
        );
        html = await docxBytesToStyledHtml(
          raw instanceof Uint8Array ? raw : new Uint8Array(raw),
        );
      } catch {
        // keep the preview.content fallback
      }
      if (cancelled) {
        return;
      }
      setMountHtml(html);
      setMountKey((key) => key + 1);
      setDirty(false);
      setErrorMessage(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [preview.absolutePath, preview.modifiedAt, preview.content, workspaceId]);

  const save = useCallback(async () => {
    const api = apiRef.current;
    if (!api || !editable || saving) {
      return;
    }
    const body = api.getActiveDocument()?.getSnapshot().body;
    if (!body) {
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      const next = await window.electronAPI.fs.writeDocxFromHtml(
        preview.absolutePath,
        univerDocumentBodyToHtml(body),
        workspaceId,
      );
      lastSavedModifiedAtRef.current = next.modifiedAt;
      setDirty(false);
      onUpdated(next);
    } catch (cause) {
      setErrorMessage(
        cause instanceof Error ? cause.message : "Failed to save document.",
      );
    } finally {
      setSaving(false);
    }
  }, [editable, saving, preview.absolutePath, workspaceId, onUpdated]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleReady = useCallback((api: FUniver) => {
    apiRef.current = api;
  }, []);
  const handleEdited = useCallback(() => {
    setDirty(true);
  }, []);
  const handleDispose = useCallback(() => {
    apiRef.current = null;
  }, []);

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name },
      );
    } catch {
      // dialog cancellation handled natively
    }
  }, [preview.absolutePath, preview.name, workspaceId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {errorMessage ? (
          <span className="mr-auto text-[11px] text-destructive">
            {errorMessage}
          </span>
        ) : saving ? (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Saving…
          </span>
        ) : dirty ? (
          <span className="mr-auto text-[11px] text-muted-foreground">
            Unsaved
          </span>
        ) : null}
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <UniverDocView
            key={`${preview.absolutePath}:${mountKey}`}
            html={mountHtml}
            darkMode={isDark}
            onReady={handleReady}
            onEdited={handleEdited}
            onDispose={handleDispose}
          />
        </Suspense>
      </div>
    </div>
  );
}

function UniverSpreadsheetSurface({
  preview,
  workspaceId,
  onUpdated,
}: EditorSurfaceProps) {
  const isDark = useIsDarkTheme();
  const editable = preview.isEditable;
  const apiRef = useRef<FUniver | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The snapshot the Univer instance is mounted from. Replaced only on file
  // switch or an external write — never on our own save echoes, so editing
  // is not interrupted mid-session.
  const [mountSnapshot, setMountSnapshot] = useState(preview.univerSnapshot);
  const [mountKey, setMountKey] = useState(0);
  const lastSavedModifiedAtRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      return;
    }
    // Our own save round-trips through onUpdated with a new modifiedAt; skip
    // remounting for it. Anything else (external write, file switch) reloads.
    if (preview.modifiedAt === lastSavedModifiedAtRef.current) {
      return;
    }
    setMountSnapshot(preview.univerSnapshot);
    setMountKey((key) => key + 1);
    setDirty(false);
    setErrorMessage(null);
  }, [preview.absolutePath, preview.modifiedAt, preview.univerSnapshot]);

  const save = useCallback(async () => {
    const api = apiRef.current;
    if (!api || !editable || saving) {
      return;
    }
    const snapshot = api.getActiveWorkbook()?.save();
    if (!snapshot) {
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      const next = await window.electronAPI.fs.writeUniverWorkbook(
        preview.absolutePath,
        snapshot,
        workspaceId,
      );
      lastSavedModifiedAtRef.current = next.modifiedAt;
      setDirty(false);
      onUpdated(next);
    } catch (cause) {
      setErrorMessage(
        cause instanceof Error ? cause.message : "Failed to save spreadsheet.",
      );
    } finally {
      setSaving(false);
    }
  }, [editable, saving, preview.absolutePath, workspaceId, onUpdated]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [dirty]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleReady = useCallback((api: FUniver) => {
    apiRef.current = api;
  }, []);

  const handleEdited = useCallback(() => {
    setDirty(true);
  }, []);

  const handleDispose = useCallback(() => {
    apiRef.current = null;
  }, []);

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name },
      );
    } catch {
      // dialog cancellation handled natively
    }
  }, [preview.absolutePath, preview.name, workspaceId]);

  if (!mountSnapshot) {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {errorMessage ? (
          <span className="text-[11px] text-destructive">{errorMessage}</span>
        ) : saving ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Saving…
          </span>
        ) : dirty ? (
          <span className="text-[11px] text-muted-foreground">Unsaved</span>
        ) : null}
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <UniverSpreadsheetView
            key={`${preview.absolutePath}:${mountKey}`}
            snapshot={mountSnapshot}
            editable={editable}
            darkMode={isDark}
            onReady={handleReady}
            onEdited={handleEdited}
            onDispose={handleDispose}
          />
        </Suspense>
      </div>
    </div>
  );
}

function SpreadsheetSurface({
  preview,
  workspaceId,
  onUpdated,
  activeSheetIndex,
  onActiveSheetIndexChange,
}: EditorSurfaceProps & {
  activeSheetIndex: number;
  onActiveSheetIndexChange: (index: number) => void;
}) {
  const [draft, setDraft] = useState<FilePreviewTableSheetPayload[]>(
    () => cloneTablePreviewSheets(preview.tableSheets),
  );
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-baseline when the file changes or the on-disk content updates
  // beneath us (external write). Same shape as useFileDraft above.
  useEffect(() => {
    setDraft(cloneTablePreviewSheets(preview.tableSheets));
    setErrorMessage(null);
  }, [preview.absolutePath, preview.modifiedAt, preview.tableSheets]);

  const dirty = !areTablePreviewSheetsEqual(draft, preview.tableSheets);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const next = await window.electronAPI.fs.writeTableFile(
        preview.absolutePath,
        draft,
        workspaceId,
      );
      onUpdated(next);
    } catch (cause) {
      setErrorMessage(
        cause instanceof Error ? cause.message : "Failed to save spreadsheet.",
      );
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, preview.absolutePath, workspaceId, onUpdated]);

  // Auto-save on idle: spreadsheet editing is many small mutations, the
  // Cmd+S muscle is wrong here. Wait 600ms after the last change.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [dirty, draft]);

  // Cmd/Ctrl+S to force-flush.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const exportFile = useCallback(async () => {
    try {
      await window.electronAPI.fs.exportFileTo(
        preview.absolutePath,
        workspaceId,
        { suggestedName: preview.name },
      );
    } catch {
      // dialog cancellation handled natively
    }
  }, [preview.absolutePath, preview.name, workspaceId]);

  const activeSheet = draft[activeSheetIndex] ?? null;
  const readOnlyReason = !preview.isEditable
    ? preview.extension === ".xls"
      ? "Legacy .xls files are read-only"
      : activeSheet?.truncated
        ? "Trimmed previews are read-only"
        : "Read only"
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {errorMessage ? (
          <span className="text-[11px] text-destructive">{errorMessage}</span>
        ) : saving ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Saving…
          </span>
        ) : dirty ? (
          <span className="text-[11px] text-muted-foreground">Unsaved</span>
        ) : null}
        <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
        <ExportFileButton onClick={() => void exportFile()} />
      </div>
      <div className="min-h-0 flex-1">
        <SpreadsheetEditor
          sheets={draft}
          activeSheetIndex={activeSheetIndex}
          onActiveSheetIndexChange={onActiveSheetIndexChange}
          editable={preview.isEditable}
          readOnlyReason={readOnlyReason}
          onChange={setDraft}
        />
      </div>
    </div>
  );
}

function TextEditor({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const { draft, setDraft, dirty, saving, save, exportFile } = useFileDraft(
    preview,
    workspaceId,
    onUpdated,
  );
  const editable = preview.isEditable;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs text-muted-foreground">
          {editable ? "Editable" : preview.unsupportedReason || "Read only"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-muted-foreground">
              Unsaved
            </span>
          ) : null}
          {editable && dirty ? (
            <Button
              size="xs"
              variant="default"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-3 animate-spin" /> : null}
              Save
            </Button>
          ) : null}
          <PinStarButton
          favorite={{
            kind: "file",
            workspaceId,
            filePath: preview.absolutePath,
            label: preview.name,
          }}
          notify
        />
        <MentionInChatButton absolutePath={preview.absolutePath} />
          <ExportFileButton onClick={() => void exportFile()} />
        </div>
      </div>
      <textarea
        aria-label={`Edit ${preview.name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!editable}
        spellCheck={false}
        className={cn(
          "min-h-0 flex-1 resize-none border-0 bg-muted px-6 py-5 font-mono text-[13px] leading-6 text-foreground outline-none",
          !editable && "cursor-default opacity-80",
        )}
      />
    </div>
  );
}
