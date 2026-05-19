import { atom } from "jotai";

/**
 * Internal (non-browser) tabs. Live alongside browser tabs in TopChrome;
 * when one is active the native BrowserView suspends and Center renders
 * the corresponding preview.
 *
 * - `file`: a workspace file opened from sidebar / chat output / link.
 * - `image`: an in-memory image (chat attachment without a workspace path).
 *   `dataUrl` may be a blob: URL; when `revokeOnClose` is true, the shell
 *   calls URL.revokeObjectURL after the tab is removed.
 */
export type InternalTab =
  | {
      id: string;
      kind: "file";
      filePath: string;
      label: string;
    }
  | {
      id: string;
      kind: "image";
      dataUrl: string;
      label: string;
      revokeOnClose?: boolean;
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
