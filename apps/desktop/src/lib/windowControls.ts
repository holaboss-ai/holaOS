// Windows caption-controls gutter — the right-side mirror of the macOS
// traffic-light gutter (see `useStoplightCompensation` in StoplightContext).
//
// On Windows the app is frameless (`frame: false` in electron/main.ts) and
// draws its own minimize / restore / close cluster via
// `WindowsTitlebarControls`, mounted at the app root and anchored to the
// window's top-right. Those are Windows-native-sized caption buttons — three
// flush, full-height buttons ~46px wide → the cluster spans the rightmost
// ~138px. Any app affordance that reaches the window's top-right edge (the
// chat toolbar, the fullscreen tab-strip controls) must be pushed left by at
// least that much or it collides with the caption buttons — which is exactly
// what happens on Windows where macOS left its top-right free.
//
// We reserve a hair beyond the cluster so there's a small visual gap between
// the app affordance and the window controls. Keep this in sync with the
// button width in WindowsTitlebarControls (3 × 46px + ~8px gap).
export const WINDOWS_CAPTION_GUTTER_PX = 146;

/** True when running in the desktop app on Windows. */
export function isWindowsDesktop(): boolean {
  return window.electronAPI?.platform === "win32";
}

/**
 * Pixels to reserve on the top-right for the Windows caption controls.
 * Zero on macOS/Linux (and in non-Electron contexts) so callers can add it
 * unconditionally without branching.
 */
export function windowsCaptionGutterPx(): number {
  return isWindowsDesktop() ? WINDOWS_CAPTION_GUTTER_PX : 0;
}
