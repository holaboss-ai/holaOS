import { contextBridge, ipcRenderer } from "electron";

interface BrowserHistoryEntryPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
}

contextBridge.exposeInMainWorld("historyPopup", {
  getHistory: () => ipcRenderer.invoke("browser:getHistory") as Promise<BrowserHistoryEntryPayload[]>,
  openUrl: (targetUrl: string) => ipcRenderer.invoke("browser:openHistoryUrl", targetUrl) as Promise<void>,
  removeEntry: (historyId: string) => ipcRenderer.invoke("browser:removeHistoryEntry", historyId) as Promise<BrowserHistoryEntryPayload[]>,
  clear: () => ipcRenderer.invoke("browser:clearHistory") as Promise<BrowserHistoryEntryPayload[]>,
  close: () => ipcRenderer.invoke("browser:closeHistoryPopup") as Promise<void>,
  onHistoryChange: (listener: (history: BrowserHistoryEntryPayload[]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, history: BrowserHistoryEntryPayload[]) => listener(history);
    ipcRenderer.on("history:update", wrapped);
    return () => ipcRenderer.removeListener("history:update", wrapped);
  }
});
