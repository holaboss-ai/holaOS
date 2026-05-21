import { atom, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent as RawDropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent as RawPopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { Menu as MenuPrimitive } from "@base-ui/react/menu";

/**
 * Counter of new-shell overlays (Popover / DropdownMenu / etc.) that are
 * currently open. browserViewSuspendedAtom watches this; any non-zero
 * value detaches the native Electron BrowserView so React-rendered
 * popovers don't get painted-over by the OS-level webview.
 *
 * Use the wrappers below (SuspendingPopover, SuspendingDropdownMenu)
 * rather than incrementing/decrementing directly — the wrappers tie the
 * counter to the overlay's own open lifecycle.
 */
export const overlayOpenCountAtom = atom(0);

/**
 * Track a boolean `open` flag against the global overlay counter.
 * Increments on open, decrements on close / unmount. Safe to call from
 * arbitrary callers — the cleanup function balances the increment even
 * when the consumer unmounts while open.
 */
function useOverlayPresence(open: boolean) {
  const setCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    if (!open) return;
    setCount((c) => c + 1);
    return () => {
      setCount((c) => Math.max(0, c - 1));
    };
  }, [open, setCount]);
}

/**
 * Drop-in replacement for `<Popover>` that registers its open state
 * with the global overlay counter. Works for both controlled and
 * uncontrolled usage.
 */
export function SuspendingPopover({
  open,
  onOpenChange,
  defaultOpen,
  ...props
}: PopoverPrimitive.Root.Props) {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const actualOpen = open ?? internalOpen;
  useOverlayPresence(actualOpen);
  return (
    <Popover
      open={actualOpen}
      defaultOpen={defaultOpen}
      onOpenChange={(next, eventDetails) => {
        if (open === undefined) setInternalOpen(next);
        onOpenChange?.(next, eventDetails);
      }}
      {...props}
    />
  );
}

/**
 * Drop-in replacement for `<DropdownMenu>` (base-ui Menu.Root) that
 * registers its open state with the global overlay counter.
 */
export function SuspendingDropdownMenu({
  open,
  onOpenChange,
  defaultOpen,
  ...props
}: MenuPrimitive.Root.Props) {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const actualOpen = open ?? internalOpen;
  useOverlayPresence(actualOpen);
  return (
    <DropdownMenu
      open={actualOpen}
      defaultOpen={defaultOpen}
      onOpenChange={(next, eventDetails) => {
        if (open === undefined) setInternalOpen(next);
        onOpenChange?.(next, eventDetails);
      }}
      {...props}
    />
  );
}

// Re-export trigger/content pieces so consumers can import them from the
// same module for symmetry.
export {
  PopoverTrigger,
  RawPopoverContent as PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
  DropdownMenuTrigger,
  RawDropdownMenuContent as DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
};
