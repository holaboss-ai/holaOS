/**
 * Name a browser — create a new one or rename an existing one.
 *
 * Matches the app's dialog convention (see ProfileImportDialog): a base-ui
 * Dialog with a header (title + close), a labeled text input, and a footer with
 * Cancel + a primary action. Replaces the pane's old inline-edit affordance.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { X } from "@/components/ui/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BrowserNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "rename";
  initialName?: string;
  onSubmit: (name: string) => void | Promise<void>;
}

export function BrowserNameDialog({
  open,
  onOpenChange,
  mode,
  initialName = "",
  onSubmit,
}: BrowserNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);

  // Seed the field each time the dialog opens (create → blank, rename → current).
  useEffect(() => {
    if (open) {
      setName(initialName);
      setSubmitting(false);
    }
  }, [open, initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex w-[min(440px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <header className="flex items-start justify-between gap-4 border-border border-b px-6 py-5">
            <DialogPrimitive.Title className="font-semibold text-[19px] text-foreground">
              {mode === "create" ? "New browser" : "Rename browser"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              render={
                <button
                  aria-label="Close"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "shrink-0 rounded-full",
                  )}
                  type="button"
                >
                  <X size={16} />
                </button>
              }
            />
          </header>

          <div className="px-6 py-5">
            <label className="block">
              <span className="mb-1.5 block font-medium text-foreground text-sm">
                Name
              </span>
              <input
                // biome-ignore lint/a11y/noAutofocus: focus the sole field on open
                autoFocus
                className="h-10 w-full rounded-lg bg-fg-2 px-3 text-foreground text-sm outline-none transition-colors focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder="e.g. Work Twitter"
                value={name}
              />
            </label>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-border border-t px-6 py-4">
            <DialogPrimitive.Close
              render={
                <button
                  className={buttonVariants({ variant: "outline" })}
                  type="button"
                >
                  Cancel
                </button>
              }
            />
            <Button
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              type="button"
            >
              {mode === "create" ? "Create" : "Save"}
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
