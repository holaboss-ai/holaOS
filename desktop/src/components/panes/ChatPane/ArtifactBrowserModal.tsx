import {
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Image as ImageIcon,
  Link2,
  Waypoints,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function outputDisplayPathSegments(output: WorkspaceOutputRecordPayload) {
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
  const segments = outputDisplayPathSegments(output);
  if (segments.length === 0) {
    return false;
  }
  const fileName = segments[segments.length - 1];
  return fileName === "agents.md" || segments.includes("skills");
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

export function outputChangeLabel(output: WorkspaceOutputRecordPayload) {
  const changeType = outputMetadataString(output, "change_type");
  if (changeType === "created") {
    return "Created";
  }
  if (changeType === "modified") {
    return "Updated";
  }
  return "";
}

export function outputSecondaryLabel(output: WorkspaceOutputRecordPayload) {
  const parts = [outputKindLabel(output)];
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
  const kind = outputVisualKind(output);
  const { Icon, tileClass, iconClass } = outputVisualTheme(kind);
  if (variant === "bare") {
    const iconSize = size === "sm" ? 14 : 16;
    return (
      <Icon
        size={iconSize}
        className={`shrink-0 ${iconClass}`}
      />
    );
  }
  const tileSize = size === "sm" ? "size-7" : "size-9";
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <div
      className={`grid ${tileSize} shrink-0 place-items-center rounded-lg ${tileClass}`}
    >
      <Icon size={iconSize} className={iconClass} />
    </div>
  );
}

export function ArtifactBrowserModal({
  open,
  filter,
  outputs,
  scope,
  onClose,
  onFilterChange,
  onOpenOutput,
  layout = "page",
}: {
  open: boolean;
  filter: ArtifactBrowserFilter;
  outputs: WorkspaceOutputRecordPayload[];
  scope: "session" | "reply";
  onClose: () => void;
  onFilterChange: (nextFilter: ArtifactBrowserFilter) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  layout?: "page" | "card";
}) {
  if (!open) {
    return null;
  }

  const filterLabels: Array<{ id: ArtifactBrowserFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "documents", label: "Documents" },
    { id: "images", label: "Images" },
    { id: "code", label: "Code files" },
    { id: "links", label: "Links" },
    { id: "apps", label: "Apps" },
  ];
  const allDisplayOutputs = dedupeOutputsForDisplay(outputs);
  const filteredOutputs = sortOutputsLatestFirst(
    filter === "all"
      ? allDisplayOutputs
      : allDisplayOutputs.filter(
          (output) => outputBrowserFilterForOutput(output) === filter,
        ),
  );
  const overlayClassName =
    layout === "card"
      ? "absolute inset-0 z-30 flex items-stretch justify-stretch bg-background/88 p-2 backdrop-blur-[2px]"
      : "absolute inset-0 z-30 flex items-center justify-center bg-black/40 px-6 py-8 backdrop-blur-[2px]";
  const panelClassName =
    layout === "card"
      ? "flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl"
      : "flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl";

  return (
    <div
      className={overlayClassName}
      data-control-center-swipe-ignore={layout === "card" ? "true" : undefined}
    >
      <div className={panelClassName}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Artifacts
            </div>
            <div className="text-xs text-muted-foreground">
              {allDisplayOutputs.length} item
              {allDisplayOutputs.length === 1 ? "" : "s"}{" "}
              {scope === "reply"
                ? "attached to this reply"
                : "in this session"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">
          {filterLabels.map((item) => {
            const active = filter === item.id;
            return (
              <Button
                key={item.id}
                variant={active ? "secondary" : "ghost"}
                size="xs"
                onClick={() => onFilterChange(item.id)}
              >
                {item.label}
              </Button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {filteredOutputs.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No artifacts match this filter.
            </div>
          ) : (
            <div className="grid gap-2">
              {filteredOutputs.map((output) => {
                const kindLabel = outputKindLabel(output);
                const changeLabel = outputChangeLabel(output);
                return (
                  <button
                    key={output.id}
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenOutput?.(output);
                    }}
                    disabled={!onOpenOutput}
                    className="group flex w-full min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left ring-border transition-colors hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-card"
                  >
                    <OutputArtifactIcon output={output} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {kindLabel}
                      </div>
                      <div className="truncate text-sm font-medium text-foreground">
                        {output.title || "Untitled artifact"}
                      </div>
                    </div>
                    {changeLabel ? (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] uppercase"
                      >
                        {changeLabel}
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
