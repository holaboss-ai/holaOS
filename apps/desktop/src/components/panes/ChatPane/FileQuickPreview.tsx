import { useEffect, useRef, useState } from "react";

import { Loader2, X } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FileQuickPreviewProps {
  workspaceId: string;
  relativePath: string;
  onClose: () => void;
}

export function FileQuickPreview({
  workspaceId,
  relativePath,
  onClose,
}: FileQuickPreviewProps) {
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const requestKey = useRef<string>("");

  useEffect(() => {
    const key = `${workspaceId}::${relativePath}`;
    if (requestKey.current === key) return;
    requestKey.current = key;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPreview(null);
    window.electronAPI.fs
      .readFilePreview(relativePath, workspaceId)
      .then((payload) => {
        if (cancelled) return;
        setPreview(payload);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, relativePath]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim px-6 py-10 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[82vh] w-full max-w-[860px] flex-col overflow-hidden",
          "rounded-2xl border border-border bg-background shadow-2xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border bg-fg-4 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              File preview
            </div>
            <div className="mt-0.5 truncate font-mono text-sm text-foreground">
              {relativePath}
            </div>
          </div>
          {preview ? (
            <div className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {formatBytes(preview.size)}
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-sm text-destructive">
              {error}
            </div>
          ) : preview ? (
            <PreviewBody payload={preview} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ payload }: { payload: FilePreviewPayload }) {
  if (payload.unsupportedReason) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {payload.unsupportedReason}
      </div>
    );
  }
  switch (payload.kind) {
    case "image":
      return payload.dataUrl ? (
        <div className="flex h-full items-center justify-center bg-fg-2 p-6">
          <img
            src={payload.dataUrl}
            alt={payload.name}
            className="max-h-[70vh] max-w-full rounded-lg shadow-sm"
          />
        </div>
      ) : (
        <UnavailablePreview reason="Image data not available." />
      );

    case "video":
      return payload.dataUrl ? (
        <div className="flex h-full items-center justify-center bg-fg-2 p-6">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={payload.dataUrl}
            controls
            autoPlay
            loop
            className="max-h-[70vh] max-w-full rounded-lg shadow-sm"
          />
        </div>
      ) : (
        <UnavailablePreview reason="Video data not available." />
      );

    case "text":
      if (typeof payload.content !== "string") {
        return <UnavailablePreview reason="Text content not available." />;
      }
      return (
        <pre className="m-0 whitespace-pre-wrap break-words p-5 font-mono text-[12.5px] leading-6 text-fg-92">
          {payload.content}
        </pre>
      );

    case "pdf":
      return payload.dataUrl ? (
        <iframe
          src={payload.dataUrl}
          title={payload.name}
          className="h-[70vh] w-full"
        />
      ) : (
        <UnavailablePreview reason="PDF data not available." />
      );

    case "table":
    case "presentation":
      return (
        <UnavailablePreview reason="This preview type opens fully in the workspace shell after onboarding." />
      );

    case "unsupported":
    default:
      return (
        <UnavailablePreview reason="No quick preview available for this file type." />
      );
  }
}

function UnavailablePreview({ reason }: { reason: string }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {reason}
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
