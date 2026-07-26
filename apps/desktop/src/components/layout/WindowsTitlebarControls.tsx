import { Copy, Minus, Square, X } from "@/components/ui/icons";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isWindowsDesktop } from "@/lib/windowControls";

/**
 * Custom minimize / restore / close controls for the frameless Windows window
 * (electron/main.ts sets `frame: false` on win32, so the OS draws no caption
 * buttons). Mounted ONCE at the app root — see App.tsx — so it renders on every
 * screen: the boot splash, the sign-in gate, and the authed shell alike.
 * Previously it lived inside AppShell, which meant the pre-auth screens had no
 * way to close or minimize the window.
 *
 * No-op on macOS/Linux, where the OS provides the window controls (macOS uses
 * `titleBarStyle: "hiddenInset"` traffic-lights on the left).
 *
 * Portaled to document.body with `fixed` positioning so it always sits at the
 * root stacking context, pinned to the window's top-right regardless of the
 * current screen's layout or any transformed ancestor. The reserved-gutter
 * offsets in TopChrome / ChatPanel (see `windowsCaptionGutterPx`) keep the
 * authed shell's own top-right affordances clear of this cluster.
 */
export function WindowsTitlebarControls() {
  const isWindows = isWindowsDesktop();
  const [windowState, setWindowState] = useState<DesktopWindowStatePayload>({
    isFullScreen: false,
    isMaximized: false,
    isMinimized: false,
  });

  useEffect(() => {
    if (!isWindows) return;
    let mounted = true;
    void window.electronAPI.ui.getWindowState().then((nextState) => {
      if (mounted) {
        setWindowState(nextState);
      }
    });

    const unsubscribe = window.electronAPI.ui.onWindowStateChange(
      (nextState) => {
        if (mounted) {
          setWindowState(nextState);
        }
      },
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [isWindows]);

  if (!isWindows) return null;

  // Windows-native caption buttons: full title-bar height, ~46px wide, flush
  // (no gap, no radius), with an edge-to-edge hover fill and the standard red
  // close-hover (#c42b1c). The base carries no hover colors so the neutral vs.
  // red hover styles don't collide in the generated stylesheet.
  const captionButtonBase =
    "window-no-drag flex h-10 w-[46px] items-center justify-center text-foreground/55 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50";
  const neutralHover = "hover:bg-foreground/10 hover:text-foreground";

  return createPortal(
    <div className="window-drag fixed top-0 right-0 z-[60] flex h-10 items-center">
      <div className="window-no-drag flex items-center">
        <button
          type="button"
          aria-label="Minimize window"
          className={`${captionButtonBase} ${neutralHover}`}
          onClick={() => {
            void window.electronAPI.ui.minimizeWindow();
          }}
        >
          <Minus className="size-3.5" strokeWidth={2.1} />
        </button>
        <button
          type="button"
          aria-label={
            windowState.isMaximized || windowState.isFullScreen
              ? "Restore window"
              : "Maximize window"
          }
          className={`${captionButtonBase} ${neutralHover}`}
          onClick={() => {
            void window.electronAPI.ui.toggleWindowSize();
          }}
        >
          {windowState.isMaximized || windowState.isFullScreen ? (
            <Copy className="size-3.5" strokeWidth={1.9} />
          ) : (
            <Square className="size-3.5" strokeWidth={1.9} />
          )}
        </button>
        <button
          type="button"
          aria-label="Close window"
          className={`${captionButtonBase} hover:bg-[#c42b1c] hover:text-white`}
          onClick={() => {
            void window.electronAPI.ui.closeWindow();
          }}
        >
          <X className="size-3.5" strokeWidth={2.1} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
