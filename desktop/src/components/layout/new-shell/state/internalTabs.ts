import { atom } from "jotai";

/**
 * Internal (non-browser) tabs — currently only file-preview tabs.
 * Live alongside browser tabs in TopChrome; when one is active the
 * native BrowserView suspends and Center renders the preview pane.
 */
export type InternalTab = {
  id: string;
  kind: "file";
  filePath: string;
  label: string;
};

export const internalTabsAtom = atom<InternalTab[]>([]);
export const activeInternalTabIdAtom = atom<string | null>(null);

let counter = 0;
export function makeInternalTabId(): string {
  counter += 1;
  return `int-${Date.now()}-${counter}`;
}

export function fileNameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
