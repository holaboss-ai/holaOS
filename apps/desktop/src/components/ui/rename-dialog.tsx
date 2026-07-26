import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RenameDialog({
  open,
  title,
  initial,
  placeholder,
  confirmLabel = "Rename",
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (next: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) {
      setValue(initial);
    }
  }, [open, initial]);

  const submit = () => {
    const next = value.trim();
    if (!next) {
      return;
    }
    onConfirm(next);
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[25%] left-1/2 z-[100] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          <DialogPrimitive.Title className="text-base font-semibold text-foreground">
            {title}
          </DialogPrimitive.Title>
          <Input
            autoFocus
            className="mt-3"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            value={value}
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!value.trim()}
              onClick={submit}
              size="sm"
              type="button"
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
