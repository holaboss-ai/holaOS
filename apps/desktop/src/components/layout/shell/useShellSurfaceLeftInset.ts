import { useAtomValue } from "jotai";
import { useStoplightCompensation } from "@/lib/StoplightContext";
import { centerFullscreenAtom, sidebarCollapsedAtom } from "./state/ui";

/**
 * Left inset for a full-window shell surface — the workspace overlays
 * (Capabilities / Automations / Channels / Projects / Apps / Skills) that
 * replace the whole content area.
 *
 * When the sidebar collapses it goes to `width: 0` (see Sidebar), so these
 * panes sit at x=0 and their top row would land under the macOS stoplights
 * plus the floating "Expand sidebar" button rendered by AppShell. This mirrors
 * TopChrome's inset exactly so every surface clears the same chrome:
 *   - collapsed  → clear the stoplights + the floating expand button (macOS),
 *                  or just the button off macOS
 *   - fullscreen → stoplights only (the sidebar and the floating button are
 *                  both hidden in that mode)
 *   - expanded   → `base` (the sidebar sits to the left, so no reservation)
 *
 * Returns a CSS length string for `paddingLeft`. Pass the surface's natural
 * left padding as `base` (default `1rem`) so the expanded look is unchanged;
 * pair it with `transition-[padding-left] duration-stride ease-out-expo` so it
 * animates in step with the sidebar.
 */
export function useShellSurfaceLeftInset(base = "1rem"): string {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const centerFullscreen = useAtomValue(centerFullscreenAtom);
  const reserveStoplightGutter = useStoplightCompensation();
  if (centerFullscreen) {
    return reserveStoplightGutter ? "5rem" : base;
  }
  if (sidebarCollapsed) {
    return reserveStoplightGutter ? "7.25rem" : "2.75rem";
  }
  return base;
}
