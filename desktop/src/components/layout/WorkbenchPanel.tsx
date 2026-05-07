import type { ReactNode } from "react";
import { Globe, X } from "lucide-react";

export type WorkbenchTab = "browser";

interface WorkbenchPanelProps {
  onClose: () => void;
  children: ReactNode;
}

export function WorkbenchPanel({ onClose, children }: WorkbenchPanelProps) {
  return (
    <section className="theme-shell soft-vignette neon-border relative flex h-[360px] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl shadow-subtle-sm">
      <header className="theme-header-surface flex shrink-0 items-center justify-between gap-3 border-b border-primary px-4 py-3">
        <div className="inline-flex h-10 items-center gap-2 rounded-2xl border border-primary bg-primary/10 px-3 text-[12px] text-primary">
          <Globe size={14} />
          <span>Browser</span>
        </div>

        <button
          type="button"
          aria-label="Close workbench"
          onClick={onClose}
          className="grid h-9 w-9 place-items-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:text-primary"
        >
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-3">{children}</div>
    </section>
  );
}
