import {
  Feather,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Image as ImageIcon,
  Link2,
  Puzzle,
  Waypoints,
} from "@/components/ui/icons";
import { FileBrandIcon, hasOfficeBrandIcon } from "@/lib/fileBrandIcon";
import { outputDeliverableKind, type OutputItem } from "@/lib/outputs";
import { chatMessageTimeLabel } from "./helpers";
import { formatAttachmentSize } from "./AttachmentList";
import type { ArtifactBrowserFilter } from "./types";

type OutputVisualKind =
  | "spreadsheet"
  | "document"
  | "pdf"
  | "code"
  | "image"
  | "link"
  | "app"
  | "capability"
  | "skill"
  | "file";

const SPREADSHEET_EXTENSIONS = new Set([
  "xlsx",
  "xls",
  "xlsm",
  "xlsb",
  "ods",
  "csv",
  "tsv",
]);
const PDF_EXTENSIONS = new Set(["pdf"]);
// Mirrors the runtime's IMAGE_EXTENSIONS (turn-output-capture.ts). Used to
// classify an output as an image by EXTENSION when its metadata `category` is
// absent — e.g. a file delivered via `send_file` doesn't carry a category, so
// without this a .jpg falls back to the generic file icon.
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "php",
  "swift",
  "kt",
  "sh",
  "json",
  "yml",
  "yaml",
  "toml",
  "xml",
  "sql",
  "css",
  "scss",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "doc",
  "docx",
  "rtf",
  "odt",
  "html",
  "htm",
]);

export function outputMetadataString(
  output: WorkspaceOutputRecordPayload,
  key: string,
) {
  const value = output.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

export function outputMetadataNumber(
  output: WorkspaceOutputRecordPayload,
  key: string,
) {
  const value = output.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function outputDisplayPath(output: WorkspaceOutputRecordPayload) {
  const metadataPath = outputMetadataString(output, "file_path");
  if (metadataPath) {
    return metadataPath;
  }
  const filePath = output.file_path?.trim() ?? "";
  if (filePath) {
    return filePath;
  }
  const title = output.title?.trim() ?? "";
  if (/[\\/]/.test(title) || /\.[A-Za-z0-9]+$/.test(title)) {
    return title;
  }
  return "";
}

export function outputDisplayPathSegments(output: WorkspaceOutputRecordPayload) {
  const normalizedPath = outputDisplayPath(output)
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return normalizedPath ? normalizedPath.split("/").filter(Boolean) : [];
}

function shouldHideOutputFromArtifactDisplay(
  output: WorkspaceOutputRecordPayload,
) {
  // Agent-built capability/skill manifests live under capabilities/ and
  // skills/ but ARE the deliverable — keep them (the skills/ rule below would
  // otherwise hide the skill, diverging from the Outputs library).
  if (outputDeliverableKind(output as OutputItem)) {
    return false;
  }
  const segments = outputDisplayPathSegments(output);
  if (segments.length === 0) {
    return false;
  }
  const fileName = segments[segments.length - 1];
  // Mirror the main-process shouldHideWorkspaceManagedArtifactOutput filter:
  // app internals (apps/<id>/*) are represented by the App card, never as
  // individual files in the browser. The per-turn loader pulls these in
  // unfiltered (includeManaged) so the card layer can collapse them, so the
  // browser has to re-hide them here.
  return (
    fileName === "agents.md" ||
    segments[0] === "apps" ||
    segments.includes("skills")
  );
}

export function outputBrowserFilterForOutput(
  output: WorkspaceOutputRecordPayload,
): ArtifactBrowserFilter {
  if (
    outputMetadataString(output, "origin_type") === "app" ||
    output.module_id
  ) {
    return "apps";
  }
  const category = outputMetadataString(output, "category");
  if (category === "image") {
    return "images";
  }
  if (category === "code") {
    return "code";
  }
  if (category === "link") {
    return "links";
  }
  // Fallback: classify by file extension when no (or a non-classifying)
  // category was recorded — so an image delivered without a category metadata
  // (e.g. via `send_file`) still gets the image icon + shows under Images.
  const extension = outputFileExtensionFromTitle(output);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "images";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "code";
  }
  return "documents";
}

export function outputKindLabel(output: WorkspaceOutputRecordPayload) {
  if (
    outputMetadataString(output, "origin_type") === "app" ||
    output.module_id
  ) {
    const artifactType = outputMetadataString(output, "artifact_type");
    if (artifactType) {
      return artifactType.charAt(0).toUpperCase() + artifactType.slice(1);
    }
    return "Artifact";
  }
  const category = outputMetadataString(output, "category");
  if (category === "image") {
    return "Image";
  }
  if (category === "video") {
    return "Video";
  }
  if (category === "code") {
    return "Code file";
  }
  if (category === "link") {
    return "Link";
  }
  if (category === "spreadsheet") {
    return "Spreadsheet";
  }
  if (category === "document") {
    return "Document";
  }
  return output.output_type === "document" ? "Document" : "File";
}

// Lightweight extension lookup that doesn't depend on the metadata
// envelope (which agent-authored files often skip). Reads the title
// suffix only — used inside outputKindLabel before metadata parsing.
export function outputFileExtensionFromTitle(
  output: WorkspaceOutputRecordPayload,
): string {
  const fromTitle = output.title?.trim() ?? "";
  const dotIndex = fromTitle.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fromTitle.length - 1) {
    return fromTitle.slice(dotIndex + 1).toLowerCase();
  }
  const path = outputDisplayPath(output);
  const pathDot = path.lastIndexOf(".");
  if (pathDot > 0 && pathDot < path.length - 1) {
    return path.slice(pathDot + 1).toLowerCase();
  }
  return "";
}

/**
 * Resolves the most-descriptive label we can show for an output, in
 * priority order. The producer-side `output.title` wins when it's set
 * (the dominant case — agent-authored files use this, write_report
 * sets it, etc.). When it's empty (frequently the case for module-app
 * creates where the app sometimes passes "" through), fall through:
 *
 *  - metadata.summary (set by write_report-style tools) — trimmed to
 *    a single readable line so the row stays scannable
 *  - file path basename — preserves the agent's filename even when
 *    the title wasn't propagated upstream
 *  - capitalized artifact_type — for app outputs, "Tweet" / "Post"
 *    reads better than the previous "${kind} #${n}" counter
 *  - fallback (caller-provided counter, then literal "Untitled
 *    artifact")
 */
const TITLE_SUMMARY_MAX = 64;

export function outputDisplayTitle(
  output: WorkspaceOutputRecordPayload,
  fallback?: string,
): string {
  const title = output.title?.trim();
  if (title) {
    return title;
  }
  const summary = outputMetadataString(output, "summary");
  if (summary) {
    const firstLine = summary.split(/\r?\n/).find(Boolean)?.trim() ?? "";
    const cleaned = firstLine || summary.trim();
    return cleaned.length > TITLE_SUMMARY_MAX
      ? `${cleaned.slice(0, TITLE_SUMMARY_MAX - 1).trimEnd()}…`
      : cleaned;
  }
  const path = outputDisplayPath(output);
  if (path) {
    const segments = path.split(/[\\/]/).filter(Boolean);
    const basename = segments[segments.length - 1];
    if (basename) {
      return basename;
    }
  }
  const artifactType = outputMetadataString(output, "artifact_type");
  if (artifactType) {
    return artifactType.charAt(0).toUpperCase() + artifactType.slice(1);
  }
  return fallback?.trim() || "Untitled artifact";
}

export function outputSecondaryLabel(
  output: WorkspaceOutputRecordPayload,
  options?: { includeKind?: boolean },
) {
  const parts = (options?.includeKind ?? true)
    ? [outputKindLabel(output)]
    : [];
  const sizeLabel = formatAttachmentSize(
    outputMetadataNumber(output, "size_bytes") ?? 0,
  );
  if (sizeLabel) {
    parts.push(sizeLabel);
  }
  const timeLabel = chatMessageTimeLabel(output.created_at);
  if (timeLabel) {
    parts.push(timeLabel);
  }
  return parts.join(" · ");
}

export function sortOutputs(outputs: WorkspaceOutputRecordPayload[]) {
  return [...dedupeOutputsForDisplay(outputs)].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.title.localeCompare(right.title);
  });
}

export function sortOutputsLatestFirst(outputs: WorkspaceOutputRecordPayload[]) {
  return [...dedupeOutputsForDisplay(outputs)].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.title.localeCompare(right.title);
  });
}

function outputDisplayDedupeKey(output: WorkspaceOutputRecordPayload) {
  const filePath = outputDisplayPath(output);
  if (filePath) {
    return `path:${filePath}`;
  }
  const artifactId = output.artifact_id?.trim() ?? "";
  if (artifactId) {
    return `artifact:${artifactId}`;
  }
  const title = output.title?.trim().toLowerCase() ?? "";
  if (title) {
    return `title:${title}`;
  }
  return `id:${output.id}`;
}

function outputDisplayPriority(output: WorkspaceOutputRecordPayload) {
  let score = 0;
  const originType = outputMetadataString(output, "origin_type");
  if (originType === "forwarded_subagent") {
    score += 40;
  } else if (originType === "runtime_tool") {
    score += 35;
  } else if (originType === "app") {
    score += 30;
  }

  if (outputMetadataString(output, "artifact_type") === "report") {
    score += 20;
  }
  if (!/\.[A-Za-z0-9]+$/.test(output.title?.trim() ?? "")) {
    score += 5;
  }
  return score;
}

function shouldPreferOutputForDisplay(
  candidate: WorkspaceOutputRecordPayload,
  current: WorkspaceOutputRecordPayload,
) {
  const candidatePriority = outputDisplayPriority(candidate);
  const currentPriority = outputDisplayPriority(current);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }
  const candidateCreatedAt = Date.parse(candidate.created_at || "") || 0;
  const currentCreatedAt = Date.parse(current.created_at || "") || 0;
  if (candidateCreatedAt !== currentCreatedAt) {
    return candidateCreatedAt > currentCreatedAt;
  }
  return candidate.title.localeCompare(current.title) < 0;
}

export function dedupeOutputsForDisplay(
  outputs: WorkspaceOutputRecordPayload[],
) {
  const preferredByKey = new Map<string, WorkspaceOutputRecordPayload>();
  for (const output of outputs) {
    if (shouldHideOutputFromArtifactDisplay(output)) {
      continue;
    }
    const key = outputDisplayDedupeKey(output);
    const current = preferredByKey.get(key);
    if (!current || shouldPreferOutputForDisplay(output, current)) {
      preferredByKey.set(key, output);
    }
  }
  return [...preferredByKey.values()];
}

function outputFileExtension(output: WorkspaceOutputRecordPayload): string {
  const metadataExt = outputMetadataString(output, "extension");
  if (metadataExt) {
    return metadataExt.replace(/^\./, "").toLowerCase();
  }
  const fromTitle = output.title?.trim() ?? "";
  const dotIndex = fromTitle.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fromTitle.length - 1) {
    return fromTitle.slice(dotIndex + 1).toLowerCase();
  }
  return "";
}

function outputVisualKind(
  output: WorkspaceOutputRecordPayload,
): OutputVisualKind {
  const deliverable = outputDeliverableKind(output as OutputItem);
  if (deliverable) {
    return deliverable;
  }
  const filter = outputBrowserFilterForOutput(output);
  if (filter === "apps") {
    return "app";
  }
  if (filter === "images") {
    return "image";
  }
  if (filter === "links") {
    return "link";
  }

  const extension = outputFileExtension(output);
  if (extension) {
    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      return "spreadsheet";
    }
    if (PDF_EXTENSIONS.has(extension)) {
      return "pdf";
    }
    if (CODE_EXTENSIONS.has(extension)) {
      return "code";
    }
    if (DOCUMENT_EXTENSIONS.has(extension)) {
      return "document";
    }
  }

  if (filter === "code") {
    return "code";
  }
  const category = outputMetadataString(output, "category");
  if (category === "spreadsheet") {
    return "spreadsheet";
  }
  if (category === "document") {
    return "document";
  }
  return "file";
}

function outputVisualTheme(kind: OutputVisualKind): {
  Icon: typeof FileText;
  tileClass: string;
  iconClass: string;
} {
  switch (kind) {
    case "spreadsheet":
      return {
        Icon: FileSpreadsheet,
        tileClass: "bg-success/12 ring-1 ring-inset ring-success/20",
        iconClass: "text-success",
      };
    case "pdf":
      return {
        Icon: FileType,
        tileClass: "bg-destructive/12 ring-1 ring-inset ring-destructive/20",
        iconClass: "text-destructive",
      };
    case "document":
      return {
        Icon: FileText,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "code":
      return {
        Icon: FileCode2,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "image":
      return {
        Icon: ImageIcon,
        tileClass: "bg-warning/12 ring-1 ring-inset ring-warning/20",
        iconClass: "text-warning",
      };
    case "link":
      return {
        Icon: Link2,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "app":
      return {
        Icon: Waypoints,
        tileClass: "bg-primary/12 ring-1 ring-inset ring-primary/20",
        iconClass: "text-primary",
      };
    case "capability":
      return {
        Icon: Puzzle,
        tileClass: "bg-primary/12 ring-1 ring-inset ring-primary/20",
        iconClass: "text-primary",
      };
    case "skill":
      return {
        Icon: Feather,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    default:
      return {
        Icon: FileIcon,
        tileClass: "bg-muted ring-1 ring-inset ring-border",
        iconClass: "text-muted-foreground",
      };
  }
}

export function OutputArtifactIcon({
  output,
  size = "md",
  variant = "tile",
}: {
  output: WorkspaceOutputRecordPayload;
  size?: "sm" | "md";
  /**
   * "tile" (default): tinted rounded square with the icon inset —
   * matches the legacy reply-scoped modal.
   * "bare": just the colored icon, no surrounding tile. Used by
   * the Linear-style slim row list in ArtifactsPane.
   */
  variant?: "tile" | "bare";
}) {
  const iconSize = size === "sm" ? 14 : 16;
  const brandPath = output.file_path ?? output.title ?? "";

  if (hasOfficeBrandIcon(brandPath)) {
    if (variant === "bare") {
      return (
        <FileBrandIcon
          className="shrink-0"
          filePath={brandPath}
          size={iconSize}
        />
      );
    }
    const brandTileSize = size === "sm" ? "size-7" : "size-9";
    return (
      <div
        className={`grid ${brandTileSize} shrink-0 place-items-center rounded-lg bg-muted`}
      >
        <FileBrandIcon filePath={brandPath} size={iconSize} />
      </div>
    );
  }

  const kind = outputVisualKind(output);
  const { Icon, tileClass, iconClass } = outputVisualTheme(kind);
  if (variant === "bare") {
    return (
      <Icon
        size={iconSize}
        className={`shrink-0 ${iconClass}`}
      />
    );
  }
  const tileSize = size === "sm" ? "size-7" : "size-9";
  return (
    <div
      className={`grid ${tileSize} shrink-0 place-items-center rounded-lg ${tileClass}`}
    >
      <Icon size={iconSize} className={iconClass} />
    </div>
  );
}

