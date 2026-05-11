import { useEffect } from "react";

/**
 * Close a panel / overlay when the user presses ESC.
 *
 * - Listener only attaches when `open` is true (no global cost when closed).
 * - Bails on `event.defaultPrevented` so Radix-style components that own
 *   their own ESC handling (and call preventDefault) win.
 * - Bails on any modifier (⌘/Ctrl/Alt/Shift + ESC) so power-user shortcuts
 *   that involve ESC don't accidentally close the panel.
 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);
}
