import { contextBridge, ipcRenderer } from "electron";

interface BrowserDownloadPayload {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  status: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
}

contextBridge.exposeInMainWorld("downloadsPopup", {
  getDownloads: () => ipcRenderer.invoke("browser:getDownloads") as Promise<BrowserDownloadPayload[]>,
  openDownload: (downloadId: string) => ipcRenderer.invoke("browser:openDownload", downloadId) as Promise<string>,
  showDownloadInFolder: (downloadId: string) => ipcRenderer.invoke("browser:showDownloadInFolder", downloadId) as Promise<boolean>,
  close: () => ipcRenderer.invoke("browser:closeDownloadsPopup") as Promise<void>,
  onDownloadsChange: (listener: (downloads: BrowserDownloadPayload[]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, downloads: BrowserDownloadPayload[]) => listener(downloads);
    ipcRenderer.on("downloads:update", wrapped);
    return () => ipcRenderer.removeListener("downloads:update", wrapped);
  }
});
