import type { BrowserWindow } from "electron";

import type { BrowserBookmarkPayload } from "../../shared/browser-pane-protocol.js";

export interface BrowserPaneBookmarksDeps {
  getMainWindow: () => BrowserWindow | null;
  getActiveWorkspaceId: () => string;
  /**
   * Returns the workspace's bookmark list (or empty array if not loaded).
   */
  getWorkspaceBookmarks: (workspaceId: string) => BrowserBookmarkPayload[];
}

export interface BrowserPaneBookmarks {
  emitBookmarksState: (workspaceId?: string | null) => void;
}

export function createBrowserPaneBookmarks(
  deps: BrowserPaneBookmarksDeps
): BrowserPaneBookmarks {
  function emitBookmarksState(workspaceId?: string | null): void {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    const activeId = deps.getActiveWorkspaceId();
    const normalized =
      typeof workspaceId === "string" ? workspaceId.trim() : activeId;
    if (normalized !== activeId) {
      return;
    }
    win.webContents.send("browser:bookmarks", deps.getWorkspaceBookmarks(normalized));
  }

  return { emitBookmarksState };
}
