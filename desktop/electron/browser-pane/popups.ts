/**
 * Browser-pane popup windows: Downloads / History / Overflow / Address
 * Suggestions.
 *
 * Each popup is a small, frameless `BrowserWindow` parented to the desktop
 * main window, loaded with a static HTML data: URL. They are shown / hidden
 * relative to anchor bounds reported by the renderer (the toolbar buttons in
 * the browser pane).
 *
 * State (the four `BrowserWindow | null` slots, the cached overflow anchor
 * bounds, and the address-suggestion payload) lives entirely inside this
 * module. main.ts reaches the module through the `BrowserPanePopups`
 * interface returned by `createBrowserPanePopups(deps)`.
 *
 * Behaviour preserved exactly from main.ts (BP-P3); no semantic changes.
 */
import { BrowserWindow } from "electron";
import path from "node:path";

import type {
  AddressSuggestionPayload,
  BrowserAnchorBoundsPayload,
  BrowserHistoryEntryPayload,
} from "../../shared/browser-pane-protocol.js";

/**
 * Structural download payload accepted by the popup. We don't import the
 * shared `BrowserDownloadPayload` here because main.ts uses Electron-native
 * status values (`progressing` / `interrupted`) that disagree with the
 * renderer-facing protocol enum (`in_progress` / `failed`). The popup only
 * forwards the array to the renderer over IPC, so a structural shape is
 * sufficient.
 */
type PopupDownloadPayload = Readonly<unknown>;

const DOWNLOADS_POPUP_WIDTH = 360;
const DOWNLOADS_POPUP_HEIGHT = 340;
const HISTORY_POPUP_WIDTH = 420;
const HISTORY_POPUP_HEIGHT = 420;
const OVERFLOW_POPUP_WIDTH = 220;
const OVERFLOW_POPUP_HEIGHT = 172;
const ADDRESS_SUGGESTIONS_POPUP_MIN_HEIGHT = 88;
const ADDRESS_SUGGESTIONS_POPUP_MAX_HEIGHT = 320;

/**
 * Identifies which popup a `BrowserWindow` reference belongs to. main.ts
 * uses this string in diagnostics / Sentry breadcrumbs when classifying
 * window references.
 */
export type BrowserPanePopupKind =
  | "downloads_popup"
  | "history_popup"
  | "overflow_popup"
  | "address_suggestions_popup";

/**
 * Dependencies the popups module reads from main.ts. The shape is narrow on
 * purpose — popups never reach the workspace state graph or the runtime
 * client directly.
 */
export interface BrowserPanePopupsDeps {
  /** Owner window for parenting popups. Returns null pre-launch. */
  getMainWindow: () => BrowserWindow | null;
  /**
   * Sync — current popup theme CSS (palette + base rules). Computed by
   * main.ts since the palette resolver lives there. Re-evaluated on every
   * popup render.
   */
  popupThemeCss: () => string;
  /** Returns the path to the directory where preload bundles are emitted. */
  preloadDir: () => string;
}

interface AddressSuggestionsState {
  suggestions: AddressSuggestionPayload[];
  selectedIndex: number;
}

const EMPTY_ADDRESS_SUGGESTIONS: AddressSuggestionsState = {
  suggestions: [],
  selectedIndex: -1,
};

// =============================================================================
// HTML generators
// =============================================================================

function createDownloadsPopupHtml(themeCss: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Downloads</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Exo 2", "Segoe UI Variable", sans-serif;
        background: transparent;
        color: #deeee6;
      }
      .panel {
        margin: 10px;
        border-radius: 18px;
        border: 1px solid rgba(87, 255, 173, 0.24);
        background: linear-gradient(180deg, rgba(9, 16, 13, 0.98), rgba(5, 9, 7, 0.98));
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
        overflow: hidden;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 18px 10px;
      }
      .title {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(222, 238, 230, 0.82);
      }
      .close {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 9999px;
        background: transparent;
        color: rgba(222, 238, 230, 0.6);
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }
      .close:hover { background: rgba(255, 255, 255, 0.06); color: rgba(222, 238, 230, 0.92); }
      .list {
        max-height: 274px;
        overflow-y: auto;
        padding: 0 12px 12px;
      }
      .empty {
        margin: 0 6px 6px;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid rgba(87, 255, 173, 0.14);
        background: rgba(255, 255, 255, 0.03);
        font-size: 12px;
        color: rgba(222, 238, 230, 0.68);
      }
      .item {
        margin: 0 6px 10px;
        padding: 12px;
        border-radius: 14px;
        border: 1px solid rgba(87, 255, 173, 0.14);
        background: rgba(255, 255, 255, 0.03);
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .meta {
        min-width: 0;
        flex: 1;
      }
      .filename {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 700;
        color: rgba(222, 238, 230, 0.92);
      }
      .status {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 3px;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(222, 238, 230, 0.48);
      }
      .actions {
        display: flex;
        gap: 6px;
      }
      .action {
        height: 28px;
        min-width: 28px;
        padding: 0 10px;
        border-radius: 10px;
        border: 1px solid rgba(87, 255, 173, 0.18);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(222, 238, 230, 0.76);
        cursor: pointer;
        font-size: 11px;
      }
      .action:hover { border-color: rgba(87, 255, 173, 0.42); color: #57ffad; }
      .bar {
        margin-top: 10px;
        height: 6px;
        border-radius: 9999px;
        background: rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .bar > span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, rgba(87, 255, 173, 0.72), rgba(87, 255, 173, 0.92));
      }
      ${themeCss}
    </style>
  </head>
  <body>
    <div class="panel">
      <div class="header">
        <div class="title">Downloads</div>
        <button class="close" id="close" aria-label="Close">×</button>
      </div>
      <div class="list" id="list"></div>
    </div>
    <script>
      const list = document.getElementById("list");
      const close = document.getElementById("close");

      const render = (downloads) => {
        const recent = downloads.slice(0, 5);
        if (!recent.length) {
          list.innerHTML = '<div class="empty">No downloads yet.</div>';
          return;
        }

        list.innerHTML = recent.map((download) => {
          const progress = download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : 0;
          return \`
            <div class="item">
              <div class="row">
                <div class="meta">
                  <div class="filename" title="\${download.filename}">\${download.filename}</div>
                  <div class="status">\${download.status}</div>
                </div>
                <div class="actions">
                  <button class="action" data-open="\${download.id}">Open</button>
                  <button class="action" data-reveal="\${download.id}">Show</button>
                </div>
              </div>
              <div class="bar"><span style="width:\${progress}%"></span></div>
            </div>
          \`;
        }).join("");

        list.querySelectorAll("[data-open]").forEach((button) => {
          button.addEventListener("click", () => window.downloadsPopup.openDownload(button.dataset.open));
        });
        list.querySelectorAll("[data-reveal]").forEach((button) => {
          button.addEventListener("click", () => window.downloadsPopup.showDownloadInFolder(button.dataset.reveal));
        });
      };

      close.addEventListener("click", () => window.downloadsPopup.close());
      window.downloadsPopup.onDownloadsChange(render);
      window.downloadsPopup.getDownloads().then(render);
    </script>
  </body>
</html>`;
}

function createHistoryPopupHtml(themeCss: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>History</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Exo 2", "Segoe UI Variable", sans-serif;
        background: transparent;
        color: #deeee6;
      }
      .panel {
        margin: 10px;
        border-radius: 18px;
        border: 1px solid rgba(87, 255, 173, 0.24);
        background: linear-gradient(180deg, rgba(9, 16, 13, 0.98), rgba(5, 9, 7, 0.98));
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
        overflow: hidden;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 16px 18px 10px;
      }
      .title {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(222, 238, 230, 0.82);
      }
      .actions { display: flex; gap: 6px; }
      .button {
        height: 28px;
        min-width: 28px;
        padding: 0 10px;
        border-radius: 10px;
        border: 1px solid rgba(87, 255, 173, 0.18);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(222, 238, 230, 0.76);
        cursor: pointer;
        font-size: 11px;
      }
      .button:hover { border-color: rgba(87, 255, 173, 0.42); color: #57ffad; }
      .list {
        max-height: 344px;
        overflow-y: auto;
        padding: 0 12px 12px;
      }
      .empty {
        margin: 0 6px 6px;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid rgba(87, 255, 173, 0.14);
        background: rgba(255, 255, 255, 0.03);
        font-size: 12px;
        color: rgba(222, 238, 230, 0.68);
      }
      .item {
        margin: 0 6px 8px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(87, 255, 173, 0.14);
        background: rgba(255, 255, 255, 0.03);
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .open {
        flex: 1;
        min-width: 0;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
        padding: 0;
      }
      .title-row {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 700;
        color: rgba(222, 238, 230, 0.92);
      }
      .url-row {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 3px;
        font-size: 11px;
        color: rgba(222, 238, 230, 0.56);
      }
      .icon {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        flex: 0 0 auto;
      }
      .remove {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 9999px;
        background: transparent;
        color: rgba(222, 238, 230, 0.58);
        cursor: pointer;
        font-size: 16px;
      }
      .remove:hover { background: rgba(255, 255, 255, 0.06); color: #57ffad; }
      ${themeCss}
    </style>
  </head>
  <body>
    <div class="panel">
      <div class="header">
        <div class="title">History</div>
        <div class="actions">
          <button class="button" id="clear">Clear</button>
          <button class="button" id="close">Close</button>
        </div>
      </div>
      <div class="list" id="list"></div>
    </div>
    <script>
      const list = document.getElementById("list");
      const clear = document.getElementById("clear");
      const close = document.getElementById("close");

      const formatTime = (value) => new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date(value));

      const render = (entries) => {
        const recent = entries.slice(0, 30);
        if (!recent.length) {
          list.innerHTML = '<div class="empty">No browsing history yet.</div>';
          return;
        }

        list.innerHTML = recent.map((entry) => {
          const icon = entry.faviconUrl
            ? '<img class="icon" src="' + entry.faviconUrl + '" alt="" />'
            : '<div class="icon" style="background:rgba(255,255,255,0.08)"></div>';

          return \`
            <div class="item">
              \${icon}
              <button class="open" data-url="\${entry.url}">
                <div class="title-row" title="\${entry.title}">\${entry.title}</div>
                <div class="url-row" title="\${entry.url}">\${entry.url} · \${formatTime(entry.lastVisitedAt)}</div>
              </button>
              <button class="remove" data-remove="\${entry.id}" aria-label="Remove">×</button>
            </div>
          \`;
        }).join("");

        list.querySelectorAll("[data-url]").forEach((button) => {
          button.addEventListener("click", () => window.historyPopup.openUrl(button.dataset.url));
        });
        list.querySelectorAll("[data-remove]").forEach((button) => {
          button.addEventListener("click", () => window.historyPopup.removeEntry(button.dataset.remove));
        });
      };

      clear.addEventListener("click", () => window.historyPopup.clear());
      close.addEventListener("click", () => window.historyPopup.close());
      window.historyPopup.onHistoryChange(render);
      window.historyPopup.getHistory().then(render);
    </script>
  </body>
</html>`;
}

function createOverflowPopupHtml(themeCss: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>More</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: transparent;
      }
      .panel {
        margin: 10px;
        border-radius: 12px;
        padding: 4px;
      }
      .item {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        padding: 7px 10px;
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }
      .icon {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--popup-text-subtle);
      }
      .icon svg {
        width: 100%;
        height: 100%;
      }
      ${themeCss}
    </style>
  </head>
  <body>
    <div class="panel">
      <button class="item" id="downloads">
        <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/></svg></span>
        <span>Downloads</span>
      </button>
      <button class="item" id="history">
        <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
        <span>History</span>
      </button>
      <button class="item" id="chrome-import">
        <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg></span>
        <span>Import Chrome</span>
      </button>
    </div>
    <script>
      document.getElementById("downloads").addEventListener("click", () => window.overflowPopup.openDownloads());
      document.getElementById("history").addEventListener("click", () => window.overflowPopup.openHistory());
      document.getElementById("chrome-import").addEventListener("click", () => window.overflowPopup.importChrome());
    </script>
  </body>
</html>`;
}

function createAddressSuggestionsPopupHtml(themeCss: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Suggestions</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: transparent;
      }
      .panel {
        margin: 6px 0 0;
        border-radius: 12px;
        overflow: hidden;
      }
      .list {
        max-height: 100%;
        overflow-y: auto;
        padding: 4px;
      }
      .item {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        padding: 7px 10px;
        text-align: left;
        cursor: pointer;
      }
      .icon {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        border-radius: 3px;
        opacity: 0.82;
      }
      .icon-fallback {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--popup-text-subtle);
      }
      .icon-fallback svg {
        width: 100%;
        height: 100%;
      }
      .meta {
        min-width: 0;
        flex: 1;
      }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1.35;
      }
      .url {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 1px;
        font-size: 11px;
        line-height: 1.3;
        color: var(--popup-text-subtle);
      }
      ${themeCss}
    </style>
  </head>
  <body>
    <div class="panel">
      <div class="list" id="list"></div>
    </div>
    <script>
      const list = document.getElementById("list");

      const FALLBACK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

      const render = (payload) => {
        const suggestions = payload?.suggestions ?? [];
        const selectedIndex = payload?.selectedIndex ?? -1;
        list.innerHTML = suggestions.map((entry, index) => {
          const icon = entry.faviconUrl
            ? '<img class="icon" src="' + entry.faviconUrl + '" alt="" />'
            : '<span class="icon-fallback" aria-hidden="true">' + FALLBACK_ICON_SVG + '</span>';

          return \`
            <button class="item \${index === selectedIndex ? "active" : ""}" data-index="\${index}">
              \${icon}
              <div class="meta">
                <div class="title" title="\${entry.title || entry.url}">\${entry.title || entry.url}</div>
                <div class="url" title="\${entry.url}">\${entry.url}</div>
              </div>
            </button>
          \`;
        }).join("");

        list.querySelectorAll("[data-index]").forEach((button) => {
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            window.addressSuggestions.choose(Number(button.dataset.index));
          });
        });
      };

      window.addressSuggestions.onSuggestionsChange(render);
    </script>
  </body>
</html>`;
}

// =============================================================================
// Public façade
// =============================================================================

/**
 * Public surface for the popups module. main.ts holds one instance and
 * routes IPC handler bodies through it. The factory closes over the deps so
 * callers don't have to thread them through every method.
 */
export interface BrowserPanePopups {
  toggleDownloadsPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  toggleHistoryPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  toggleOverflowPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  showAddressSuggestionsPopup: (
    anchorBounds: BrowserAnchorBoundsPayload,
    suggestions: AddressSuggestionPayload[],
    selectedIndex: number,
  ) => void;
  hideAddressSuggestionsPopup: () => void;

  /** Hide the downloads popup. */
  hideDownloadsPopup: () => void;
  /** Hide the history popup. */
  hideHistoryPopup: () => void;
  /** Hide the overflow popup. Used after dispatching an overflow action. */
  hideOverflowPopup: () => void;

  /** Send the latest downloads list to the popup if open. */
  sendDownloadsToPopup: (downloads: PopupDownloadPayload[]) => void;
  /** Whether the downloads popup window currently exists (and isn't destroyed). */
  hasOpenDownloadsPopup: () => boolean;
  /** Send the latest history list to the popup if open. */
  sendHistoryToPopup: (history: BrowserHistoryEntryPayload[]) => void;
  /** Whether the history popup window currently exists (and isn't destroyed). */
  hasOpenHistoryPopup: () => boolean;

  /** Anchor bounds last passed to `toggleOverflowPopup`. */
  getOverflowAnchorBounds: () => BrowserAnchorBoundsPayload | null;

  /**
   * Force-close every popup window owned by this module. Used by the main
   * window `closed` handler and the theme-change reset. After this call, the
   * next show/toggle will re-create the popup with the current theme CSS.
   */
  closeAllPopups: () => void;

  /**
   * If `window` is one of the four popup windows, return its kind label;
   * otherwise return `null`. main.ts uses this for diagnostic naming of
   * arbitrary BrowserWindow references.
   */
  classifyWindow: (window: BrowserWindow | null) => BrowserPanePopupKind | null;
}

export function createBrowserPanePopups(
  deps: BrowserPanePopupsDeps,
): BrowserPanePopups {
  let downloadsPopupWindow: BrowserWindow | null = null;
  let historyPopupWindow: BrowserWindow | null = null;
  let overflowPopupWindow: BrowserWindow | null = null;
  let addressSuggestionsPopupWindow: BrowserWindow | null = null;
  let overflowAnchorBounds: BrowserAnchorBoundsPayload | null = null;
  let addressSuggestionsState: AddressSuggestionsState = {
    ...EMPTY_ADDRESS_SUGGESTIONS,
  };

  function emitAddressSuggestionsState() {
    addressSuggestionsPopupWindow?.webContents.send(
      "addressSuggestions:update",
      addressSuggestionsState,
    );
  }

  function ensureDownloadsPopupWindow(): BrowserWindow | null {
    if (downloadsPopupWindow && !downloadsPopupWindow.isDestroyed()) {
      return downloadsPopupWindow;
    }
    const main = deps.getMainWindow();
    if (!main) {
      return null;
    }
    downloadsPopupWindow = new BrowserWindow({
      width: DOWNLOADS_POPUP_WIDTH,
      height: DOWNLOADS_POPUP_HEIGHT,
      parent: main,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      transparent: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(deps.preloadDir(), "downloadsPopupPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    downloadsPopupWindow.on("blur", () => {
      downloadsPopupWindow?.hide();
    });
    downloadsPopupWindow.once("closed", () => {
      downloadsPopupWindow = null;
    });
    const html = createDownloadsPopupHtml(deps.popupThemeCss());
    void downloadsPopupWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return downloadsPopupWindow;
  }

  function ensureHistoryPopupWindow(): BrowserWindow | null {
    if (historyPopupWindow && !historyPopupWindow.isDestroyed()) {
      return historyPopupWindow;
    }
    const main = deps.getMainWindow();
    if (!main) {
      return null;
    }
    historyPopupWindow = new BrowserWindow({
      width: HISTORY_POPUP_WIDTH,
      height: HISTORY_POPUP_HEIGHT,
      parent: main,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      transparent: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(deps.preloadDir(), "historyPopupPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    historyPopupWindow.on("blur", () => {
      historyPopupWindow?.hide();
    });
    historyPopupWindow.once("closed", () => {
      historyPopupWindow = null;
    });
    const html = createHistoryPopupHtml(deps.popupThemeCss());
    void historyPopupWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return historyPopupWindow;
  }

  function ensureOverflowPopupWindow(): BrowserWindow | null {
    if (overflowPopupWindow && !overflowPopupWindow.isDestroyed()) {
      return overflowPopupWindow;
    }
    const main = deps.getMainWindow();
    if (!main) {
      return null;
    }
    overflowPopupWindow = new BrowserWindow({
      width: OVERFLOW_POPUP_WIDTH,
      height: OVERFLOW_POPUP_HEIGHT,
      parent: main,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      transparent: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(deps.preloadDir(), "overflowPopupPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    overflowPopupWindow.on("blur", () => {
      overflowPopupWindow?.hide();
    });
    overflowPopupWindow.once("closed", () => {
      overflowPopupWindow = null;
    });
    const html = createOverflowPopupHtml(deps.popupThemeCss());
    void overflowPopupWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return overflowPopupWindow;
  }

  function ensureAddressSuggestionsPopupWindow(): BrowserWindow | null {
    if (
      addressSuggestionsPopupWindow &&
      !addressSuggestionsPopupWindow.isDestroyed()
    ) {
      return addressSuggestionsPopupWindow;
    }
    const main = deps.getMainWindow();
    if (!main) {
      return null;
    }
    addressSuggestionsPopupWindow = new BrowserWindow({
      width: 420,
      height: ADDRESS_SUGGESTIONS_POPUP_MIN_HEIGHT,
      parent: main,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      transparent: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(deps.preloadDir(), "addressSuggestionsPopupPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    addressSuggestionsPopupWindow.once("closed", () => {
      addressSuggestionsPopupWindow = null;
    });
    const html = createAddressSuggestionsPopupHtml(deps.popupThemeCss());
    void addressSuggestionsPopupWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return addressSuggestionsPopupWindow;
  }

  function toggleDownloadsPopup(anchorBounds: BrowserAnchorBoundsPayload) {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) {
      return;
    }
    const popup = ensureDownloadsPopupWindow();
    if (!popup) {
      return;
    }
    if (popup.isVisible()) {
      popup.hide();
      return;
    }
    const contentBounds = main.getContentBounds();
    const x = Math.round(
      Math.min(
        Math.max(
          contentBounds.x +
            anchorBounds.x +
            anchorBounds.width -
            DOWNLOADS_POPUP_WIDTH,
          contentBounds.x + 8,
        ),
        contentBounds.x + contentBounds.width - DOWNLOADS_POPUP_WIDTH - 8,
      ),
    );
    const y = Math.round(
      contentBounds.y + anchorBounds.y + anchorBounds.height + 8,
    );
    popup.setBounds({
      x,
      y,
      width: DOWNLOADS_POPUP_WIDTH,
      height: DOWNLOADS_POPUP_HEIGHT,
    });
    popup.show();
    popup.focus();
  }

  function toggleHistoryPopup(anchorBounds: BrowserAnchorBoundsPayload) {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) {
      return;
    }
    const popup = ensureHistoryPopupWindow();
    if (!popup) {
      return;
    }
    if (popup.isVisible()) {
      popup.hide();
      return;
    }
    const contentBounds = main.getContentBounds();
    const x = Math.round(
      Math.min(
        Math.max(
          contentBounds.x +
            anchorBounds.x +
            anchorBounds.width -
            HISTORY_POPUP_WIDTH,
          contentBounds.x + 8,
        ),
        contentBounds.x + contentBounds.width - HISTORY_POPUP_WIDTH - 8,
      ),
    );
    const y = Math.round(
      contentBounds.y + anchorBounds.y + anchorBounds.height + 8,
    );
    popup.setBounds({
      x,
      y,
      width: HISTORY_POPUP_WIDTH,
      height: HISTORY_POPUP_HEIGHT,
    });
    popup.show();
    popup.focus();
  }

  function toggleOverflowPopup(anchorBounds: BrowserAnchorBoundsPayload) {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) {
      return;
    }
    const popup = ensureOverflowPopupWindow();
    if (!popup) {
      return;
    }
    overflowAnchorBounds = anchorBounds;
    if (popup.isVisible()) {
      popup.hide();
      return;
    }
    const contentBounds = main.getContentBounds();
    const x = Math.round(
      Math.min(
        Math.max(
          contentBounds.x +
            anchorBounds.x +
            anchorBounds.width -
            OVERFLOW_POPUP_WIDTH,
          contentBounds.x + 8,
        ),
        contentBounds.x + contentBounds.width - OVERFLOW_POPUP_WIDTH - 8,
      ),
    );
    const y = Math.round(
      contentBounds.y + anchorBounds.y + anchorBounds.height + 8,
    );
    popup.setBounds({
      x,
      y,
      width: OVERFLOW_POPUP_WIDTH,
      height: OVERFLOW_POPUP_HEIGHT,
    });
    popup.show();
    popup.focus();
  }

  function showAddressSuggestionsPopup(
    anchorBounds: BrowserAnchorBoundsPayload,
    suggestions: AddressSuggestionPayload[],
    selectedIndex: number,
  ) {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) {
      return;
    }
    const popup = ensureAddressSuggestionsPopupWindow();
    if (!popup) {
      return;
    }
    addressSuggestionsState = { suggestions, selectedIndex };
    const contentBounds = main.getContentBounds();
    const itemHeight = 49;
    const popupHeight = Math.max(
      ADDRESS_SUGGESTIONS_POPUP_MIN_HEIGHT,
      Math.min(
        ADDRESS_SUGGESTIONS_POPUP_MAX_HEIGHT,
        suggestions.length * itemHeight + 8,
      ),
    );
    popup.setBounds({
      x: Math.round(contentBounds.x + anchorBounds.x),
      y: Math.round(contentBounds.y + anchorBounds.y + anchorBounds.height),
      width: Math.round(anchorBounds.width),
      height: popupHeight,
    });
    popup.showInactive();
    emitAddressSuggestionsState();
  }

  function hideAddressSuggestionsPopup() {
    addressSuggestionsState = { ...EMPTY_ADDRESS_SUGGESTIONS };
    addressSuggestionsPopupWindow?.hide();
  }

  function hideDownloadsPopup() {
    downloadsPopupWindow?.hide();
  }

  function hideHistoryPopup() {
    historyPopupWindow?.hide();
  }

  function hideOverflowPopup() {
    overflowPopupWindow?.hide();
  }

  function sendDownloadsToPopup(downloads: PopupDownloadPayload[]) {
    downloadsPopupWindow?.webContents.send("downloads:update", downloads);
  }

  function hasOpenDownloadsPopup(): boolean {
    return !!(downloadsPopupWindow && !downloadsPopupWindow.isDestroyed());
  }

  function sendHistoryToPopup(history: BrowserHistoryEntryPayload[]) {
    historyPopupWindow?.webContents.send("history:update", history);
  }

  function hasOpenHistoryPopup(): boolean {
    return !!(historyPopupWindow && !historyPopupWindow.isDestroyed());
  }

  function getOverflowAnchorBounds(): BrowserAnchorBoundsPayload | null {
    return overflowAnchorBounds;
  }

  function closeAllPopups() {
    addressSuggestionsPopupWindow?.close();
    addressSuggestionsPopupWindow = null;
    downloadsPopupWindow?.close();
    downloadsPopupWindow = null;
    historyPopupWindow?.close();
    historyPopupWindow = null;
    overflowPopupWindow?.close();
    overflowPopupWindow = null;
  }

  function classifyWindow(
    window: BrowserWindow | null,
  ): BrowserPanePopupKind | null {
    if (!window) {
      return null;
    }
    if (window === downloadsPopupWindow) {
      return "downloads_popup";
    }
    if (window === historyPopupWindow) {
      return "history_popup";
    }
    if (window === overflowPopupWindow) {
      return "overflow_popup";
    }
    if (window === addressSuggestionsPopupWindow) {
      return "address_suggestions_popup";
    }
    return null;
  }

  return {
    toggleDownloadsPopup,
    toggleHistoryPopup,
    toggleOverflowPopup,
    showAddressSuggestionsPopup,
    hideAddressSuggestionsPopup,
    hideDownloadsPopup,
    hideHistoryPopup,
    hideOverflowPopup,
    sendDownloadsToPopup,
    hasOpenDownloadsPopup,
    sendHistoryToPopup,
    hasOpenHistoryPopup,
    getOverflowAnchorBounds,
    closeAllPopups,
    classifyWindow,
  };
}

