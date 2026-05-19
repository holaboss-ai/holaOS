import { LayoutGrid, X } from "lucide-react";
import { useEffect } from "react";
import { AppsGallery } from "@/components/marketplace/AppsGallery";
import { Button } from "@/components/ui/button";

interface WorkspaceAppsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WorkspaceAppsDialog({
  open,
  onClose,
}: WorkspaceAppsDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-50 grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close add apps"
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 bg-scrim backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add apps"
        className="pointer-events-auto relative z-10 flex h-[min(820px,calc(100vh-36px))] w-[min(1120px,calc(100vw-32px))] min-w-0 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xs"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-5">
          <div className="inline-flex min-w-0 items-center gap-2 text-[17px] font-semibold text-foreground">
            <LayoutGrid size={16} className="shrink-0 text-muted-foreground" />
            <span className="truncate">Add apps</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onClose}
              aria-label="Close add apps"
              className="rounded-full"
            >
              <X size={16} />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
          <AppsGallery />
        </div>
      </div>
    </div>
  );
}
