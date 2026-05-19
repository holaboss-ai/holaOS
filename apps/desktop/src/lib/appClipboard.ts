import { type ExplorerAttachmentDragPayload } from "@/lib/attachmentDrag";

type ExplorerAttachmentClipboardEntry = {
  payload: ExplorerAttachmentDragPayload;
  text: string;
  updatedAt: number;
};

const EXPLORER_ATTACHMENT_CLIPBOARD_TTL_MS = 10 * 60 * 1000;

let explorerAttachmentClipboardEntry: ExplorerAttachmentClipboardEntry | null =
  null;

export function setExplorerAttachmentClipboardEntry(
  entry: Omit<ExplorerAttachmentClipboardEntry, "updatedAt">,
) {
  explorerAttachmentClipboardEntry = {
    ...entry,
    updatedAt: Date.now(),
  };
}

export function getExplorerAttachmentClipboardEntry() {
  if (
    explorerAttachmentClipboardEntry &&
    Date.now() - explorerAttachmentClipboardEntry.updatedAt >
      EXPLORER_ATTACHMENT_CLIPBOARD_TTL_MS
  ) {
    explorerAttachmentClipboardEntry = null;
  }
  return explorerAttachmentClipboardEntry;
}

export function clearExplorerAttachmentClipboardEntry() {
  explorerAttachmentClipboardEntry = null;
}
