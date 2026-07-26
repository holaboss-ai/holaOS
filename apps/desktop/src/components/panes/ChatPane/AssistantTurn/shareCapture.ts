import type {
  ShareDraftFile,
  ShareDraftImage,
  ShareDraftItem,
  ShareDraftSessionStep,
  ShareDraftSessionTurn,
} from "@holaboss/app-host/protocol";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";
import type { ChatExecutionTimelineItem, ChatMessage } from "../types";

// A minimal shape both WorkspaceOutputRecordPayload and the Remote API's
// OutputItem satisfy — so the same capture path serves the turn rows and the
// session Outputs popover.
export type ShareableOutput = {
  id: string;
  file_path?: string | null;
  module_id?: string | null;
};

const SHARE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const MAX_SHARE_IMAGES = 4;

const SHARE_VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
// Cap the share-via-base64 video so it doesn't choke the IPC bridge; larger clips
// can be attached manually in the composer (uploaded directly with the session).
const MAX_SHARE_VIDEO_BYTES = 50 * 1024 * 1024;

function extOf(path: string, table: Record<string, string>): string | null {
  const lower = path.toLowerCase();
  return Object.keys(table).find((e) => lower.endsWith(e)) ?? null;
}

/** True when an output is a generated image/video we can attach to a HolaHub post. */
export function isShareableMediaOutput(
  output: ShareableOutput
): boolean {
  const path = output.file_path;
  return Boolean(
    path && (extOf(path, SHARE_IMAGE_MIME) || extOf(path, SHARE_VIDEO_MIME))
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Capture generated image outputs (by file extension) as base64 so the HolaHub
// composer — which holds the session — can upload them on prefill.
export async function gatherShareImages(
  outputs: ShareableOutput[],
  workspaceId: string | null
): Promise<ShareDraftImage[]> {
  if (!workspaceId) {
    return [];
  }
  const images: ShareDraftImage[] = [];
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_IMAGE_MIME) : null;
    if (!(path && ext)) {
      continue;
    }
    try {
      const bytes = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      images.push({
        dataBase64: bytesToBase64(bytes),
        contentType: SHARE_IMAGE_MIME[ext],
      });
    } catch {
      // Unreadable output — skip it.
    }
    if (images.length >= MAX_SHARE_IMAGES) {
      break;
    }
  }
  return images;
}

// Capture the first small-enough generated video (by extension) as base64.
export async function gatherShareVideos(
  outputs: ShareableOutput[],
  workspaceId: string | null
): Promise<ShareDraftImage[]> {
  if (!workspaceId) {
    return [];
  }
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_VIDEO_MIME) : null;
    if (!(path && ext)) {
      continue;
    }
    try {
      const bytes = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      if (bytes.length === 0 || bytes.length > MAX_SHARE_VIDEO_BYTES) {
        continue;
      }
      return [
        { dataBase64: bytesToBase64(bytes), contentType: SHARE_VIDEO_MIME[ext] },
      ];
    } catch {
      // Unreadable — try the next output.
    }
  }
  return [];
}

// Deliverable documents (pptx/docx/pdf/…) — shareable inside a session as
// downloadable file cards. Extension → MIME (advisory; the server gates by ext).
const SHARE_DOC_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
const MAX_SHARE_FILE_BYTES = 50 * 1024 * 1024;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "file";
}

// Internal tool-call artifacts (e.g. "search_web-call_<hex>.json", raw tool
// dumps) are outputs but NOT deliverables — they must never end up in a share.
const INTERNAL_ARTIFACT_RE = /[-_]call_[0-9a-f]{6,}/i;
function isInternalArtifact(path: string): boolean {
  return INTERNAL_ARTIFACT_RE.test(baseName(path));
}

/** True when an output is a shareable deliverable document (not an image/video,
 *  and not an internal tool-call artifact). */
export function isShareableDocOutput(output: ShareableOutput): boolean {
  const path = output.file_path;
  return Boolean(
    path && extOf(path, SHARE_DOC_MIME) && !isInternalArtifact(path)
  );
}

/** Capture document outputs as base64 (keeping the original file name) so the
 *  HolaHub composer can upload them — the download-card path for a session. */
export async function gatherShareFiles(
  outputs: ShareableOutput[],
  workspaceId: string | null
): Promise<ShareDraftFile[]> {
  if (!workspaceId) {
    return [];
  }
  const files: ShareDraftFile[] = [];
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_DOC_MIME) : null;
    if (!(path && ext) || isInternalArtifact(path)) {
      continue;
    }
    try {
      const bytes = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      if (bytes.length === 0 || bytes.length > MAX_SHARE_FILE_BYTES) {
        continue;
      }
      files.push({
        fileName: baseName(path),
        contentType: SHARE_DOC_MIME[ext],
        dataBase64: bytesToBase64(bytes),
      });
    } catch {
      // Unreadable output — skip it.
    }
  }
  return files;
}

// The simplified tool/phase trace of an assistant turn — just step titles (no
// args/output), so a shared post can show "Worked across N steps". Trace steps
// live in `segments` (execution) on newer turns, or the flat `executionItems`.
function stepsFromMessage(message: ChatMessage): ShareDraftSessionStep[] {
  const items: ChatExecutionTimelineItem[] = [];
  if (message.segments && message.segments.length > 0) {
    for (const segment of message.segments) {
      if (segment.kind === "execution") {
        items.push(...segment.items);
      }
    }
  } else if (message.executionItems) {
    items.push(...message.executionItems);
  }
  const steps: ShareDraftSessionStep[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "trace_step") {
      continue;
    }
    const title = (item.step.title ?? "").trim();
    if (!title || item.step.status === "error" || seen.has(title)) {
      continue;
    }
    seen.add(title);
    steps.push({ title, kind: item.step.kind });
    if (steps.length >= 10) {
      break;
    }
  }
  return steps;
}

// The assistant's visible reply lives in `segments` (kind "output") once a turn
// is segmented — `message.text` is cleared then. Read the output segments (what
// the desktop actually renders), falling back to message.text.
export function visibleText(message: ChatMessage): string {
  const segments = message.segments ?? [];
  if (segments.length > 0) {
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment.kind === "output") {
        parts.push(segment.text);
      }
    }
    const joined = parts.join("\n\n").trim();
    if (joined) {
      return joined;
    }
  }
  return (message.text ?? "").trim();
}

/** Build a shareable conversation transcript from the assembled chat messages.
 *  Text + a simplified step trace per turn (no thinking/args/output) + its
 *  media/files captured to base64; local paths and metadata never leave. */
export async function gatherSessionSnapshot(
  messages: ChatMessage[],
  workspaceId: string | null,
  // Friendly model name for this session (e.g. "Claude Opus 4.8"), stamped on
  // assistant turns so a shared post can annotate which model replied.
  modelLabel?: string | null
): Promise<{ turns: ShareDraftSessionTurn[] }> {
  const model = (modelLabel ?? "").trim();
  const turns: ShareDraftSessionTurn[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const outputs = message.outputs ?? [];
    const text = visibleText(message);
    const steps =
      message.role === "assistant" ? stepsFromMessage(message) : [];
    const [images, videos, files] = await Promise.all([
      gatherShareImages(outputs, workspaceId),
      gatherShareVideos(outputs, workspaceId),
      gatherShareFiles(outputs, workspaceId),
    ]);
    // Skip a turn with nothing to show — no text, media, or steps.
    if (
      !text &&
      images.length === 0 &&
      videos.length === 0 &&
      files.length === 0 &&
      steps.length === 0
    ) {
      continue;
    }
    turns.push({
      role: message.role,
      text,
      createdAt: message.createdAt ?? null,
      ...(images.length > 0 ? { images } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(steps.length > 0 ? { steps } : {}),
      ...(message.role === "assistant" && model ? { model } : {}),
    });
  }
  return { turns };
}

// Attribute a share to the apps that actually produced these outputs (their
// `module_id`), not every capability installed — so the credited/installable
// items reflect what made the content.
export function gatherShareAttributionItems(
  outputs: ShareableOutput[]
): ShareDraftItem[] {
  const items: ShareDraftItem[] = [];
  const seen = new Set<string>();
  for (const output of outputs) {
    const moduleId = (output.module_id ?? "").trim().toLowerCase();
    if (!moduleId || seen.has(moduleId)) {
      continue;
    }
    seen.add(moduleId);
    items.push({
      type: "holaapp",
      ref: moduleId,
      name: toolkitDisplayName(moduleId),
    });
  }
  return items;
}
