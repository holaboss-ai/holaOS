import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { FilePreviewPane } from "@/components/layout/shell/FilePreviewPane";
import {
  OutputArtifactIcon,
  outputDisplayTitle,
} from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { HtmlPreviewFrame } from "@/components/panes/HtmlPreviewFrame";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, MessageCircle, X } from "@/components/ui/icons";

// output.file_path is workspace-relative; join with the workspace root.
// Already-absolute paths pass through unchanged.
function resolveWorkspaceRelativePath(
  filePath: string,
  workspaceRoot: string | null,
): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  const root = (workspaceRoot ?? "").trim().replace(/[\\/]+$/, "");
  if (!root) {
    return trimmed;
  }
  return `${root}/${trimmed}`;
}

export function OutputPreviewModal({
  output,
  workspacePath,
  onClose,
  onOpenFull,
  onGoToSession,
}: {
  output: WorkspaceOutputRecordPayload | null;
  workspacePath: string | null;
  onClose: () => void;
  onOpenFull: (output: WorkspaceOutputRecordPayload) => void;
  onGoToSession: (sessionId: string) => void;
}) {
  useEffect(() => {
    if (!output) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [output, onClose]);

  if (!output) {
    return null;
  }

  const title = outputDisplayTitle(output);
  const absPath = output.file_path
    ? resolveWorkspaceRelativePath(output.file_path, workspacePath)
    : null;

  let body: ReactNode;
  if (absPath) {
    body = <FilePreviewPane filePath={absPath} />;
  } else if (output.html_content) {
    body = (
      <HtmlPreviewFrame
        className="h-full"
        html={output.html_content}
        title={title}
      />
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <OutputArtifactIcon output={output} size="md" variant="bare" />
        <p className="text-sm text-muted-foreground">
          No inline preview for this output.
        </p>
        <Button onClick={() => onOpenFull(output)} size="sm" type="button">
          <ArrowUpRight className="size-3.5" />
          Open in tab
        </Button>
      </div>
    );
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; Escape handled above + a Close button exists
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex h-[80vh] w-[min(960px,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <OutputArtifactIcon output={output} size="sm" variant="bare" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {output.session_id ? (
            <Button
              className="gap-1.5"
              onClick={() => onGoToSession(output.session_id as string)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <MessageCircle className="size-3.5" />
              Go to chat
            </Button>
          ) : null}
          <Button
            className="gap-1.5"
            onClick={() => onOpenFull(output)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowUpRight className="size-3.5" />
            Open in tab
          </Button>
          <Button
            aria-label="Close"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
