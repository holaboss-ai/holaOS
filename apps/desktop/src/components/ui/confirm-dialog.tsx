import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-background/70 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-[91] w-[min(420px,calc(100vw-32px))]",
            "-translate-x-1/2 -translate-y-1/2 rounded-xl border border-border",
            "bg-popover p-5 text-popover-foreground shadow-xl ring-1 ring-foreground/10",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            "outline-none",
          )}
        >
          <AlertDialogPrimitive.Title className="text-sm font-semibold text-foreground">
            {title}
          </AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description className="mt-2 text-xs leading-6 text-muted-foreground">
              {description}
            </AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-5 flex items-center justify-end gap-2">
            <AlertDialogPrimitive.Close
              render={
                <Button type="button" variant="ghost" size="sm">
                  {cancelLabel}
                </Button>
              }
            />
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              size="sm"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
