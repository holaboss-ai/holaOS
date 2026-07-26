import { useEffect, useState } from "react";
import {
  FileText,
  Folder,
  Image as ImageIcon,
  X,
} from "@/components/ui/icons";
import type { AttachmentListItem } from "./types";

export function formatAttachmentSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function attachmentButtonLabel(attachment: {
  name: string;
  size_bytes: number;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size_bytes);
  return sizeLabel ? `${attachment.name} (${sizeLabel})` : attachment.name;
}

function AttachmentImageThumb({
  file,
  title,
  className = "size-7 shrink-0 rounded-md object-cover",
}: {
  file: File;
  title?: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (loadFailed || !objectUrl) {
    return <ImageIcon className="size-4 shrink-0 text-primary" />;
  }
  return (
    <img
      alt=""
      title={title}
      className={className}
      onError={() => setLoadFailed(true)}
      src={objectUrl}
    />
  );
}

export function AttachmentList({
  attachments,
  onRemove,
  onPreview,
  className = "",
}: {
  attachments: AttachmentListItem[];
  onRemove?: (attachmentId: string) => void;
  onPreview?: (attachment: AttachmentListItem) => void;
  className?: string;
}) {
  return (
    // `w-full` is load-bearing: without it the container sizes to its
    // child chip, so chip's own `max-w-full` resolves to the chip's own
    // width (no cap). Pinning the list to the bubble column gives chips
    // a real boundary to truncate against on narrow chat panes.
    <div className={`flex w-full min-w-0 flex-wrap gap-2 ${className}`.trim()}>
      {attachments.map((attachment) => {
        const isImagePreviewable =
          attachment.kind === "image" &&
          Boolean(onPreview) &&
          Boolean(
            attachment.file ||
            (typeof attachment.workspace_path === "string" &&
              attachment.workspace_path.trim()),
          );

        // Images with a local file render as a bare square tile — the name
        // lives in the tooltip instead of bloating the row.
        if (attachment.kind === "image" && attachment.file) {
          const tileLabel = attachmentButtonLabel(attachment);
          const thumb = (
            <AttachmentImageThumb
              file={attachment.file}
              title={tileLabel}
              className="size-full object-cover"
            />
          );
          return (
            <div
              className="group/attachment relative"
              key={attachment.id}
              title={tileLabel}
            >
              {isImagePreviewable ? (
                <button
                  aria-label={`Preview ${attachment.name}`}
                  className="grid size-14 place-items-center overflow-hidden rounded-lg border border-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  onClick={() => onPreview?.(attachment)}
                  type="button"
                >
                  {thumb}
                </button>
              ) : (
                <div className="grid size-14 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                  {thumb}
                </div>
              )}
              {onRemove ? (
                <button
                  aria-label={`Remove ${attachment.name}`}
                  className="absolute -top-1.5 -right-1.5 grid size-[18px] place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  onClick={() => onRemove(attachment.id)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
          );
        }

        const icon =
          attachment.kind === "image" ? (
            <ImageIcon className="size-4 shrink-0 text-primary" />
          ) : attachment.kind === "folder" ? (
            <Folder className="size-3.5 shrink-0 text-primary" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-primary" />
          );

        // `truncate` alone doesn't shrink a flex child below its content
        // width — without min-w-0 + flex-1 the span stretches to its
        // full text length and pushes the chip past max-w-full of the
        // user-bubble column, especially with long filenames + size.
        const labelClassName = "min-w-0 flex-1 truncate";
        // Full workspace path on hover — the chip itself only shows the file
        // name, so the path stays discoverable without bloating the chip.
        const referencePath =
          typeof attachment.workspace_path === "string"
            ? attachment.workspace_path.trim()
            : "";

        const content = (
          <>
            {icon}
            <span className={labelClassName}>
              {attachmentButtonLabel(attachment)}
            </span>
          </>
        );

        return (
          <div
            className="group/attachment bg-muted relative inline-flex max-w-full items-center gap-2 rounded-lg border border-border py-[5px] pr-2 pl-2.5 text-xs text-foreground"
            key={attachment.id}
            title={referencePath || undefined}
          >
            {isImagePreviewable ? (
              <button
                aria-label={`Preview ${attachment.name}`}
                className="flex min-w-0 items-center gap-2 rounded-md text-left transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                onClick={() => onPreview?.(attachment)}
                title={`Preview ${attachment.name}`}
                type="button"
              >
                {content}
              </button>
            ) : (
              content
            )}
            {onRemove ? (
              <button
                aria-label={`Remove ${attachment.name}`}
                className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition group-hover/attachment:opacity-100 hover:text-foreground"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
