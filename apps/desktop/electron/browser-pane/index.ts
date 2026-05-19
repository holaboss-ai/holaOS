/**
 * Browser-pane subsystem entry point.
 *
 * The browser pane is Holaboss desktop's in-app web browser surface — tabs,
 * navigation, popup windows (history / downloads / overflow / address-bar
 * suggestions), bookmarks, downloads, screenshots, profile import, and the
 * HTTP service that lets the renderer reach the runtime through this pane.
 *
 * It is being extracted from `electron/main.ts` in phases. This module is
 * the eventual home for ~120 functions and ~24 module-level vars; today
 * (P1) it only exposes the install function shell. Each phase moves a
 * self-contained sub-domain (import → popups → bookmarks/downloads →
 * tabs → workspaces → service → handlers).
 *
 * Design tenets:
 *
 *   - **Deps via injection** — main owns Sentry, mainWindow, runtimeClient,
 *     authCookieHeader; this module only sees what it needs.
 *   - **Wire types live in `shared/browser-pane-protocol.ts`** — one source
 *     of truth for what crosses the IPC boundary.
 *   - **State is in `state.ts`** (P2) — module-level mutable vars get
 *     accessors, no direct global reads from other files.
 *   - **Handlers are thin delegators** — every `browser:*` IPC handler in
 *     `handlers.ts` calls into a sub-domain function; no business logic in
 *     the handler block.
 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export interface BrowserPaneDeps {
  /** Returns the current main window or null if not yet created. */
  getMainWindow: () => BrowserWindow | null;

  /**
   * Sync — current Better-Auth Cookie header for the desktop browser
   * service. Used to authenticate renderer-→runtime requests routed through
   * the in-pane HTTP service.
   */
  getCookieHeader: () => string;

  /**
   * Trusted IPC registration. Pass main's `handleTrustedIpc` so handlers
   * inherit the project's standard sender-scope assertion.
   */
  register: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => void;

  /**
   * Optional structured log hook; receives `{ event: "browser_pane.*" }`
   * shapes. Wire to Sentry breadcrumbs / pino in main.
   */
  log?: (event: BrowserPaneLogEvent) => void;
}

export type BrowserPaneLogEvent = {
  event: string;
  outcome?: "start" | "success" | "error" | "skipped";
  detail?: string;
  [key: string]: unknown;
};

/**
 * Installs the browser-pane subsystem. Call once at app boot, after
 * `mainWindow` is reachable via `deps.getMainWindow`.
 *
 * P1: shell only. Subsequent phases move IPC handlers and helpers in.
 */
export function installBrowserPaneHandlers(_deps: BrowserPaneDeps): void {
  // Phase markers — populated as sub-domains migrate in.
  //   P3: import-browsers
  //   P4: popups
  //   P5: bookmarks / downloads / context-menu
  //   P6: tabs / navigation
  //   P7: workspaces / agent session lifecycle / user lock
  //   P8: HTTP service
  //   P9: ipcMain.handle("browser:*") block
}
