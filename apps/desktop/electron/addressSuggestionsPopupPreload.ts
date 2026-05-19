import { contextBridge, ipcRenderer } from "electron";

interface AddressSuggestionPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

interface AddressSuggestionsStatePayload {
  suggestions: AddressSuggestionPayload[];
  selectedIndex: number;
}

contextBridge.exposeInMainWorld("addressSuggestions", {
  choose: (index: number) => ipcRenderer.invoke("browser:chooseAddressSuggestion", index) as Promise<void>,
  onSuggestionsChange: (listener: (payload: AddressSuggestionsStatePayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AddressSuggestionsStatePayload) => listener(payload);
    ipcRenderer.on("addressSuggestions:update", wrapped);
    return () => ipcRenderer.removeListener("addressSuggestions:update", wrapped);
  }
});
