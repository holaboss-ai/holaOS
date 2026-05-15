import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { PresentationPreview } from "@/components/panes/PresentationPreview";
import { SpreadsheetEditor } from "@/components/panes/SpreadsheetEditor";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

interface FilePreviewPaneProps {
  filePath: string;
}

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

export function FilePreviewPane({ filePath }: FilePreviewPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
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
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-md text-sm text-muted-foreground">{error}</div>
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
    const content = preview.content ?? "";
    if (MARKDOWN_EXTS.has(preview.extension.toLowerCase())) {
      return (
        <div className="h-full overflow-auto">
          <div className="mx-auto max-w-3xl px-10 py-12">
            <SimpleMarkdown className="file-preview-markdown">
              {content}
            </SimpleMarkdown>
          </div>
        </div>
      );
    }
    return (
      <div className="h-full overflow-auto bg-muted">
        <pre className="px-6 py-5 font-mono text-[13px] leading-6 text-foreground">
          {content}
        </pre>
      </div>
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
