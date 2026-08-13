import type {
  AttachmentListItem,
  PendingAttachment,
  PendingExplorerAttachmentFile,
  PendingLocalAttachmentFile,
} from "./types";
import { attachmentLooksLikeImage } from "./helpers";
import {
  type ExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "../../../lib/attachmentDrag";

export interface PendingAttachmentStagingApi {
  stageLocalFiles: (
    files: PendingLocalAttachmentFile[],
  ) => Promise<SessionInputAttachmentPayload[]>;
  stageExplorerFiles: (
    files: PendingExplorerAttachmentFile[],
  ) => Promise<SessionInputAttachmentPayload[]>;
}

export function attachmentUploadPayload(
  file: File,
): Promise<StageSessionAttachmentFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve({
        name: file.name,
        mime_type: file.type || null,
        content_base64: separator >= 0 ? result.slice(separator + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function pendingAttachmentId(seed: string): string {
  return `${seed}-${crypto.randomUUID()}`;
}

export function pendingAttachmentsToListItems(
  attachments: PendingAttachment[],
): AttachmentListItem[] {
  return attachments.map((attachment): AttachmentListItem => {
    if (attachment.source === "local-file") {
      return {
        id: attachment.id,
        kind: attachmentLooksLikeImage(
          attachment.file.name,
          attachment.file.type,
        )
          ? "image"
          : "file",
        name: attachment.file.name,
        size_bytes: attachment.file.size,
        file: attachment.file,
      };
    }
    if (attachment.source === "app-context") {
      return {
        id: attachment.id,
        kind: "file",
        name: `${attachment.appName} · ${attachment.title}`,
        size_bytes: 0,
      };
    }
    return {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      size_bytes: attachment.size_bytes,
      workspace_path: attachment.absolutePath,
    };
  });
}

export function createPendingLocalAttachment(
  file: File,
): PendingLocalAttachmentFile {
  return {
    id: pendingAttachmentId(`${file.name}-${file.size}-${file.lastModified}`),
    source: "local-file",
    file,
  };
}

export function createPendingExplorerAttachment(
  file: ExplorerAttachmentDragPayload,
): PendingExplorerAttachmentFile {
  return {
    id: pendingAttachmentId(`${file.absolutePath}-${file.size}`),
    source: "explorer-path",
    absolutePath: file.absolutePath,
    name: file.name,
    mime_type: file.mimeType ?? null,
    size_bytes: file.size,
    kind: resolveExplorerAttachmentKind(file),
  };
}

/**
 * Stages local and Explorer attachments concurrently, then restores the order
 * in which the user added them. App-context entries are intentionally omitted:
 * they are serialized into prompt text by ChatPane rather than staged as files.
 */
export async function stagePendingFileAttachments(
  attachments: PendingAttachment[],
  api: PendingAttachmentStagingApi,
): Promise<SessionInputAttachmentPayload[]> {
  const localFiles = attachments.filter(
    (entry): entry is PendingLocalAttachmentFile =>
      entry.source === "local-file",
  );
  const explorerFiles = attachments.filter(
    (entry): entry is PendingExplorerAttachmentFile =>
      entry.source === "explorer-path",
  );

  const [stagedLocalAttachments, stagedExplorerAttachments] = await Promise.all(
    [
      localFiles.length > 0 ? api.stageLocalFiles(localFiles) : [],
      explorerFiles.length > 0 ? api.stageExplorerFiles(explorerFiles) : [],
    ],
  );

  let localIndex = 0;
  let explorerIndex = 0;
  return attachments.flatMap((entry) => {
    if (entry.source === "app-context") {
      return [];
    }
    if (entry.source === "local-file") {
      const attachment = stagedLocalAttachments[localIndex];
      localIndex += 1;
      if (!attachment) {
        throw new Error("Failed to stage a dropped file attachment.");
      }
      return [attachment];
    }

    const attachment = stagedExplorerAttachments[explorerIndex];
    explorerIndex += 1;
    if (!attachment) {
      throw new Error("Failed to stage an explorer attachment.");
    }
    return [attachment];
  });
}
