import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { modifierKeyLabel, shortcutKeyLabel } from "./keyboardShortcuts";

interface FileTypeOption {
  id: string;
  label: string;
  promptLabel: string;
}

const FILE_TYPES: FileTypeOption[] = [
  { id: "document", label: "Word", promptLabel: "Word document (.docx)" },
  { id: "sheet", label: "Sheet", promptLabel: "spreadsheet" },
  { id: "slides", label: "Slides", promptLabel: "slide deck" },
  { id: "markdown", label: "Markdown", promptLabel: "markdown note" },
  { id: "pdf", label: "PDF", promptLabel: "PDF" },
];

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the finished prompt to hand off to the chat composer. */
  onConfirm: (prompt: string) => void;
}

function buildPrompt(type: FileTypeOption, requirement: string): string {
  return `${requirement}\n\nPlease deliver this as a new ${type.promptLabel} in this workspace.`;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  onConfirm,
}: NewTaskDialogProps) {
  const [value, setValue] = useState("");
  const [typeId, setTypeId] = useState(FILE_TYPES[0].id);

  useEffect(() => {
    if (open) {
      setValue("");
      setTypeId(FILE_TYPES[0].id);
    }
  }, [open]);

  const selectedType =
    FILE_TYPES.find((t) => t.id === typeId) ?? FILE_TYPES[0];

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(buildPrompt(selectedType, trimmed));
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[18%] left-1/2 z-[100] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl outline-none ease-out-expo data-open:duration-stride data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-open:slide-in-from-top-2 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <div
            className="flex flex-col gap-5 p-6"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                handleConfirm();
              }
            }}
          >
            <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-foreground">
              New task
            </DialogPrimitive.Title>

            <textarea
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="e.g. A launch announcement for our new analytics dashboard"
              rows={4}
              className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            />

            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                File type
              </span>
              <div className="flex flex-wrap gap-1.5">
                {FILE_TYPES.map((type) => {
                  const active = type.id === typeId;
                  return (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setTypeId(type.id)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-snappy ease-out-expo",
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground hover:bg-fg-6 hover:text-foreground",
                      )}
                    >
                      {type.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border/60 pt-4">
              <span className="text-[11px] text-muted-foreground/60">
                {modifierKeyLabel()}
                {shortcutKeyLabel("↵")} to create
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="rounded-lg px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors duration-snappy ease-out-expo hover:bg-fg-6 hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!value.trim()}
                  className="rounded-lg bg-foreground px-3.5 py-2 text-xs font-medium text-background transition-colors duration-snappy ease-out-expo hover:bg-foreground/90 disabled:opacity-50"
                >
                  Create task
                </button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
