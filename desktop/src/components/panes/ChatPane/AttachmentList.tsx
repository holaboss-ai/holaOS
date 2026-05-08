import { useEffect, useState } from "react";
import {
  FileText,
  Folder,
  Image as ImageIcon,
  X,
} from "lucide-react";
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

function AttachmentImageThumb({ file }: { file: File }) {
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
      className="size-7 shrink-0 rounded-md object-cover"
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
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {attachments.map((attachment) => {
        const isImagePreviewable =
          attachment.kind === "image" &&
          Boolean(onPreview) &&
          Boolean(
            attachment.file ||
            (typeof attachment.workspace_path === "string" &&
              attachment.workspace_path.trim()),
          );

        const icon =
          attachment.kind === "image" && attachment.file ? (
            <AttachmentImageThumb file={attachment.file} />
          ) : attachment.kind === "image" ? (
            <ImageIcon className="size-4 shrink-0 text-primary" />
          ) : attachment.kind === "folder" ? (
            <Folder className="size-3.5 shrink-0 text-primary" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-primary" />
          );

        const labelClassName = "truncate";
        const isImageThumb = attachment.kind === "image" && Boolean(attachment.file);

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
            className="group/attachment bg-muted relative inline-flex max-w-full items-center gap-2 rounded-lg border border-border pr-2 text-xs text-foreground"
            key={attachment.id}
            style={{
              paddingLeft: isImageThumb ? "4px" : "10px",
              paddingTop: isImageThumb ? "4px" : "5px",
              paddingBottom: isImageThumb ? "4px" : "5px",
            }}
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
