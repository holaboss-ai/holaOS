import { atom } from "jotai";

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
