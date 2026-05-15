import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface TabContextMenuTarget {
  x: number;
  y: number;
  tabId: string;
  /** Source list — informs which "close *" options are available. */
  list: "browser" | "internal";
}

export interface TabContextMenuActions {
  onClose(): void;
  onCloseOthers(): void;
  onCloseToLeft(): void;
  onCloseToRight(): void;
}

interface TabContextMenuProps {
  target: TabContextMenuTarget;
  actions: TabContextMenuActions;
  canCloseLeft: boolean;
  canCloseRight: boolean;
  canCloseOthers: boolean;
  onDismiss(): void;
}

export function TabContextMenu({
  target,
  actions,
  canCloseLeft,
  canCloseRight,
  canCloseOthers,
  onDismiss,
}: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onDismiss]);

  const wrap = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  // Position with a viewport-edge guard so the menu doesn't clip.
  const width = 200;
  const x = Math.min(target.x, window.innerWidth - width - 8);
  const y = Math.min(target.y, window.innerHeight - 200);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y, width }}
      className="fixed z-[200] flex flex-col gap-px rounded-md border border-border bg-popover py-1 shadow-2xl ring-1 ring-foreground/5"
    >
      <MenuItem onSelect={wrap(actions.onClose)}>Close tab</MenuItem>
      <MenuItem disabled={!canCloseOthers} onSelect={wrap(actions.onCloseOthers)}>
        Close others
      </MenuItem>
      <MenuItem disabled={!canCloseLeft} onSelect={wrap(actions.onCloseToLeft)}>
        Close tabs to the left
      </MenuItem>
      <MenuItem
        disabled={!canCloseRight}
        onSelect={wrap(actions.onCloseToRight)}
      >
        Close tabs to the right
      </MenuItem>
    </div>,
    document.body,
  );
}

function MenuItem({
  disabled,
  onSelect,
  children,
}: {
  disabled?: boolean;
  onSelect(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className="flex h-7 items-center px-2.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.05] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
