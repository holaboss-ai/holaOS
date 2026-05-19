import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAttachmentSize } from "./AttachmentList";
import type { ImageAttachmentPreviewState } from "./types";

export function ImageAttachmentPreviewModal({
  open,
  preview,
  onClose,
}: {
  open: boolean;
  preview: ImageAttachmentPreviewState | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !preview) {
    return null;
  }

  const sizeLabel = formatAttachmentSize(preview.attachment.size_bytes);
  const showImage = !preview.isLoading && !preview.errorMessage;
  const modalContent = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center px-6 py-8"
      onClick={onClose}
    >
      {preview.browserSnapshot ? (
        <img
          aria-hidden="true"
          src={preview.browserSnapshot.dataUrl}
          alt=""
          className="pointer-events-none absolute object-fill"
          style={{
            left: `${preview.browserSnapshot.bounds.x}px`,
            top: `${preview.browserSnapshot.bounds.y}px`,
            width: `${preview.browserSnapshot.bounds.width}px`,
            height: `${preview.browserSnapshot.bounds.height}px`,
          }}
        />
      ) : null}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${preview.attachment.name}`}
        className="relative z-10 flex max-h-[calc(100vh-64px)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl"
        style={{ maxWidth: "92vw" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {preview.attachment.name}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {sizeLabel || "Image attachment"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div
          className={`overflow-auto px-4 py-4 ${
            showImage
              ? "bg-transparent"
              : "min-h-[240px] min-w-[320px] bg-muted/20"
          }`}
        >
          {preview.isLoading ? (
            <div className="flex h-full min-h-[208px] items-center justify-center gap-2 text-sm text-foreground/80">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading preview...</span>
            </div>
          ) : preview.errorMessage ? (
            <div className="flex h-full min-h-[208px] flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-5 text-warning" />
              <p className="max-w-md text-sm text-foreground/80">
                {preview.errorMessage}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center">
              <img
                src={preview.dataUrl}
                alt={preview.attachment.name}
                className="block h-auto w-auto rounded-lg ring-1 ring-black/8"
                style={{
                  maxWidth: "calc(92vw - 32px)",
                  maxHeight: "calc(88vh - 128px)",
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
