import type {
  AttachmentListItem,
  PendingAttachment,
  PendingExplorerAttachmentFile,
  PendingLocalAttachmentFile,
} from "./types";
import {
  attachmentLooksLikeImage,
  imageInputUnsupportedMessage,
} from "./helpers";
import {
  type ExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "../../../lib/attachmentDrag";

export const MAX_COMPOSER_ATTACHMENT_COUNT = 50;
export const MAX_COMPOSER_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface PendingAttachmentAdmissionOptions<T> {
  currentAttachmentCount: number;
  imageInputSupported: boolean;
  modelLabel: string;
  getSizeBytes: (file: T) => number;
  isImage: (file: T) => boolean;
}

export interface PendingAttachmentAdmissionResult<T> {
  acceptedFiles: T[];
  gateMessage: string;
  rejectedImageCount: number;
  oversizedCount: number;
  overflowCount: number;
}

/**
 * Applies the composer attachment policy before local or Explorer files enter
 * pending state. Callers provide only the source-specific size/image readers.
 */
export function admitPendingAttachmentFiles<T>(
  files: readonly T[],
  options: PendingAttachmentAdmissionOptions<T>,
): PendingAttachmentAdmissionResult<T> {
  const eligibleFiles: T[] = [];
  let rejectedImageCount = 0;
  let oversizedCount = 0;

  for (const file of files) {
    if (!options.imageInputSupported && options.isImage(file)) {
      rejectedImageCount += 1;
      continue;
    }
    if (options.getSizeBytes(file) > MAX_COMPOSER_ATTACHMENT_BYTES) {
      oversizedCount += 1;
      continue;
    }
    eligibleFiles.push(file);
  }

  const remainingSlots = Math.max(
    0,
    MAX_COMPOSER_ATTACHMENT_COUNT - options.currentAttachmentCount,
  );
  const acceptedFiles = eligibleFiles.slice(0, remainingSlots);
  const overflowCount = eligibleFiles.length - acceptedFiles.length;
  const gateParts: string[] = [];

  if (rejectedImageCount > 0) {
    gateParts.push(
      `${imageInputUnsupportedMessage(options.modelLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`,
    );
  }
  if (oversizedCount > 0) {
    const maxMegabytes = MAX_COMPOSER_ATTACHMENT_BYTES / (1024 * 1024);
    gateParts.push(
      `Skipped ${oversizedCount} file${oversizedCount === 1 ? "" : "s"} over ${maxMegabytes}MB.`,
    );
  }
  if (overflowCount > 0) {
    gateParts.push(
      `Limit ${MAX_COMPOSER_ATTACHMENT_COUNT} attachments — skipped ${overflowCount}.`,
    );
  }

  return {
    acceptedFiles,
    gateMessage: gateParts.join(" "),
    rejectedImageCount,
    oversizedCount,
    overflowCount,
  };
}

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
