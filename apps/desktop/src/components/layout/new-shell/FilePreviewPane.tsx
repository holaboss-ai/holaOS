import { useCallback, useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { FileX2, Loader2 } from "lucide-react";
import { MarkdownEditor as TiptapMarkdownEditor } from "@holaboss/editor";
import { PresentationPreview } from "@/components/panes/PresentationPreview";
import { SpreadsheetEditor } from "@/components/panes/SpreadsheetEditor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { fileNameFromPath } from "./state/internalTabs";
import { removeRecentFileByPathAtom } from "./state/recentFiles";

interface FilePreviewPaneProps {
  filePath: string;
  onClose?: () => void;
}

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

function isNotFoundError(message: string): boolean {
  return /ENOENT|no such file or directory|not found/i.test(message);
}

export function FilePreviewPane({ filePath, onClose }: FilePreviewPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const removeRecentFileByPath = useSetAtom(removeRecentFileByPathAtom);
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

  if (preview.kind === "pdf" && preview.dataUrl) {
    return (
      <iframe
        src={preview.dataUrl}
        title={preview.name}
        className="h-full w-full border-0"
      />
    );
  }

  if (preview.kind === "presentation" && preview.presentationSlides) {
    return (
      <PresentationPreview
        name={preview.name}
        slides={preview.presentationSlides}
        slideWidth={preview.presentationWidth}
        slideHeight={preview.presentationHeight}
      />
    );
  }

  if (preview.kind === "table" && preview.tableSheets) {
    return (
      <SpreadsheetEditor
        sheets={preview.tableSheets}
        activeSheetIndex={tableSheetIndex}
        onActiveSheetIndexChange={setTableSheetIndex}
        editable={false}
        readOnlyReason="Open in the file explorer to edit."
      />
    );
  }

  if (preview.kind === "text") {
    if (MARKDOWN_EXTS.has(preview.extension.toLowerCase())) {
      return (
        <MarkdownEditor
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

  // Cmd/Ctrl+S to save when dirty.
  useEffect(() => {
    if (!dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  return { draft, setDraft, dirty, saving, save };
}

function MarkdownEditor({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const { draft, setDraft, dirty, saving, save } = useFileDraft(
    preview,
    workspaceId,
    onUpdated,
  );
  const editable = preview.isEditable;

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
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-10 py-8">
          <TiptapMarkdownEditor
            value={draft}
            onChange={setDraft}
            readOnly={!editable}
            placeholder="Press / for commands…"
          />
        </div>
      </div>
    </div>
  );
}

function TextEditor({ preview, workspaceId, onUpdated }: EditorSurfaceProps) {
  const { draft, setDraft, dirty, saving, save } = useFileDraft(
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
