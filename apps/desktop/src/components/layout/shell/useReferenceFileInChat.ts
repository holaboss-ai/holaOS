import { useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  type ExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "@/lib/attachmentDrag";
import { fileNameFromPath } from "./state/internalTabs";
import { chatExplorerAttachmentRequestAtom } from "./state/ui";

/**
 * Drop a workspace file into the chat composer as a removable reference
 * chip (not a raw `@path` in the message text). The single entry point
 * behind every "@ this file" affordance — file-preview toolbar, sidebar
 * output rows, recent-file rows — so they all behave identically.
 */
export function useReferenceFileInChat() {
  const setExplorerAttachmentRequest = useSetAtom(
    chatExplorerAttachmentRequestAtom,
  );

  return useCallback(
    (absolutePath: string | null | undefined) => {
      const path = (absolutePath ?? "").trim();
      if (!path) {
        return;
      }
      const name = fileNameFromPath(path);
      if (!name) {
        return;
      }
      const payload: ExplorerAttachmentDragPayload = {
        absolutePath: path,
        name,
        size: 0,
        kind: resolveExplorerAttachmentKind({ name, mimeType: null }),
      };
      // Date.now() keeps the request key globally monotonic across every
      // call site — a per-instance counter would reset and collide with the
      // ChatPane's last-handled key, silently dropping the reference.
      setExplorerAttachmentRequest({
        files: [payload],
        requestKey: Date.now(),
      });
    },
    [setExplorerAttachmentRequest],
  );
}
