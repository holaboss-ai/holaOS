import type { BrowserWindow, DownloadItem } from "electron";

/**
 * Native Electron status enum used inside main / on disk. Differs from the
 * renderer-visible `BrowserDownloadPayload.status` in
 * `shared/browser-pane-protocol.ts` — translation happens at the IPC
 * boundary in `popups.ts` / handler layers, not here.
 */
export type BrowserDownloadStatus =
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserDownloadOverride {
  url: string;
  defaultPath: string;
  dialogTitle: string;
  buttonLabel: string;
}

export interface BrowserDownloadRecord {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  status: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Minimal structural view of `BrowserWorkspaceState` that the download
 * tracker needs. Defined here so this module doesn't pull in main's full
 * workspace type. Real type stays in main.ts; matching shape is enough.
 */
export interface BrowserDownloadWorkspace {
  workspaceId: string;
  partition: string;
  session: Electron.Session;
  downloadTrackingRegistered: boolean;
  downloads: BrowserDownloadRecord[];
}

export interface BrowserPaneDownloadsDeps {
  getMainWindow: () => BrowserWindow | null;
  getActiveWorkspaceId: () => string;
  getWorkspace: (id: string) => BrowserDownloadWorkspace | null;
  /** Pop a queued save-as override for `targetUrl` if one was registered by context-menu. */
  consumeDownloadOverride: (
    workspace: BrowserDownloadWorkspace,
    targetUrl: string
  ) => BrowserDownloadOverride | null;
  /** Default disk path for a new download for this workspace. */
  resolveTargetPath: (workspaceId: string, filename: string) => string;
  persistWorkspace: (workspaceId: string) => Promise<void> | void;
  /** Pushed to popup as well via popups module. */
  sendDownloadsToPopup: (downloads: BrowserDownloadRecord[]) => void;
  hasOpenDownloadsPopup: () => boolean;
}

export interface BrowserPaneDownloads {
  emitDownloadsState: (workspaceId?: string | null) => void;
  ensureBrowserWorkspaceDownloadTracking: (workspace: BrowserDownloadWorkspace) => void;
}

export function createBrowserPaneDownloads(
  deps: BrowserPaneDownloadsDeps
): BrowserPaneDownloads {
  // Tracks which Electron `partition` strings already have a `will-download`
  // listener attached. Hoisted into the module so a partition shared across
  // workspace recreations doesn't re-register.
  const trackingPartitions = new Set<string>();

  function emitDownloadsState(workspaceId?: string | null): void {
    const win = deps.getMainWindow();
    const activeId = deps.getActiveWorkspaceId();
    const normalized =
      typeof workspaceId === "string" ? workspaceId.trim() : activeId;
    if (!win || win.isDestroyed()) {
      if (!deps.hasOpenDownloadsPopup()) {
        return;
      }
    }
    if (normalized !== activeId) {
      return;
    }
    const workspace = deps.getWorkspace(normalized);
    const downloads = workspace?.downloads ?? [];
    win?.webContents.send("browser:downloads", downloads);
    deps.sendDownloadsToPopup(downloads);
  }

  function ensureBrowserWorkspaceDownloadTracking(
    workspace: BrowserDownloadWorkspace
  ): void {
    if (
      workspace.downloadTrackingRegistered ||
      trackingPartitions.has(workspace.partition)
    ) {
      workspace.downloadTrackingRegistered = true;
      return;
    }
    workspace.downloadTrackingRegistered = true;
    trackingPartitions.add(workspace.partition);
    workspace.session.on("will-download", (_event, item: DownloadItem) => {
      const currentWorkspace = deps.getWorkspace(workspace.workspaceId);
      if (!currentWorkspace) {
        return;
      }

      const createdAt = new Date().toISOString();
      const downloadId = `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const override = deps.consumeDownloadOverride(currentWorkspace, item.getURL());
      const savePath = override
        ? ""
        : deps.resolveTargetPath(currentWorkspace.workspaceId, item.getFilename());
      if (override) {
        item.setSaveDialogOptions({
          title: override.dialogTitle,
          buttonLabel: override.buttonLabel,
          defaultPath: override.defaultPath,
          properties: ["showOverwriteConfirmation"],
        });
      } else {
        item.setSavePath(savePath);
      }

      const payload: BrowserDownloadRecord = {
        id: downloadId,
        url: item.getURL(),
        filename: item.getFilename(),
        targetPath: item.getSavePath() || savePath,
        status: "progressing",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        createdAt,
        completedAt: null,
      };

      currentWorkspace.downloads = [payload, ...currentWorkspace.downloads].slice(0, 100);
      emitDownloadsState(workspace.workspaceId);
      void deps.persistWorkspace(workspace.workspaceId);

      const updateDownload = (patch: Partial<BrowserDownloadRecord>) => {
        const latestWorkspace = deps.getWorkspace(workspace.workspaceId);
        if (!latestWorkspace) {
          return;
        }
        latestWorkspace.downloads = latestWorkspace.downloads.map((download) =>
          download.id === downloadId ? { ...download, ...patch } : download
        );
        emitDownloadsState(workspace.workspaceId);
        void deps.persistWorkspace(workspace.workspaceId);
      };

      item.on("updated", (_updatedEvent, state) => {
        updateDownload({
          status: state === "interrupted" ? "interrupted" : "progressing",
          targetPath: item.getSavePath() || "",
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        });
      });

      item.once("done", (_doneEvent, state) => {
        const nextStatus: BrowserDownloadStatus =
          state === "completed"
            ? "completed"
            : state === "cancelled"
              ? "cancelled"
              : "interrupted";
        updateDownload({
          status: nextStatus,
          targetPath: item.getSavePath() || "",
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          completedAt: nextStatus === "completed" ? new Date().toISOString() : null,
        });
      });
    });
  }

  return { emitDownloadsState, ensureBrowserWorkspaceDownloadTracking };
}
