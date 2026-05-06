import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  ArrowLeft,
  ChevronRight,
  Eye,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  GitBranch,
  KeyRound,
  Loader2,
  Lock,
  type LucideIcon,
  MoreHorizontal,
  Package,
  Plus,
  Save,
  Search,
  Settings,
  Star,
} from "lucide-react";
import { Icon as IconifyIcon, addCollection } from "@iconify/react";
import catppuccinCollection from "@iconify-json/catppuccin/icons.json";

addCollection(catppuccinCollection as Parameters<typeof addCollection>[0]);
import { DashboardRenderer } from "@/components/dashboard/DashboardRenderer";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { PresentationPreview } from "@/components/panes/PresentationPreview";
import {
  areTablePreviewSheetsEqual,
  cloneTablePreviewSheets,
  SpreadsheetEditor,
} from "@/components/panes/SpreadsheetEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaneCard } from "@/components/ui/PaneCard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EXPLORER_ATTACHMENT_DRAG_TYPE,
  inferDraggedAttachmentKind,
  serializeExplorerAttachmentDragPayload,
} from "@/lib/attachmentDrag";
import {
  clearExplorerAttachmentClipboardEntry,
  setExplorerAttachmentClipboardEntry,
} from "@/lib/appClipboard";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

export type FileExplorerFocusRequest = {
  path: string;
  requestKey: number;
};

interface FileExplorerPaneProps {
  focusRequest?: FileExplorerFocusRequest | null;
  onFocusRequestConsumed?: (requestKey: number) => void;
  previewInPane?: boolean;
  onFileOpen?: (path: string) => void;
  onReferenceInChat?: (entry: LocalFileEntry) => void;
  onDeleteEntry?: (entry: LocalFileEntry) => void;
  onOpenLinkInBrowser?: (url: string) => void;
  onOpenLocalLink?: (absolutePath: string) => void;
  embedded?: boolean;
}

const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".avif",
  ".heic",
]);

const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
]);

const JSON_EXTENSIONS = new Set([".json", ".jsonl"]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".py",
  ".sh",
  ".sql",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".php",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
]);

const CONFIG_EXTENSIONS = new Set([".yml", ".yaml", ".toml", ".ini"]);

const SPECIAL_CODE_FILENAMES = new Set(["dockerfile", "makefile"]);

const SPECIAL_POLICY_FILENAMES = new Set(["agents.md"]);

const MARKDOWN_PREVIEW_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const HTML_PREVIEW_EXTENSIONS = new Set([".html", ".htm"]);

// Deterministic varied widths (%) for the file-tree loading skeleton — gives
// the placeholder rows an organic, non-uniform silhouette without any RNG.
// First two rows are wider (root-level folders/files), remaining rows sit
// shorter and are indented to suggest nested content.
const FILE_SKELETON_ROW_WIDTHS = [68, 52, 64, 44, 58, 40, 50, 46];
const EXPLORER_INTERNAL_MOVE_DRAG_TYPE =
  "application/x-holaboss-file-explorer-move";
let explorerClipboardEntry: ExplorerClipboardEntry | null = null;

type TextPreviewMode = "edit" | "preview";

type ExplorerIconDescriptor = {
  name: string;
};

type FileExplorerContextMenuState = {
  entry: LocalFileEntry;
  x: number;
  y: number;
  paneBounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
};

type FileExplorerVisibleRow =
  | {
      type: "entry";
      entry: LocalFileEntry;
      depth: number;
      isExpanded: boolean;
      isLoadingChildren: boolean;
      childError: string;
    }
  | {
      type: "feedback";
      id: string;
      depth: number;
      tone: "loading" | "error";
      message: string;
    };

type FileExplorerVisibleSection = {
  id: "protected" | "workspace";
  rows: FileExplorerVisibleRow[];
};

type ExplorerClipboardMode = "copy" | "cut";

type ExplorerClipboardEntry = {
  mode: ExplorerClipboardMode;
  sourcePath: string;
  name: string;
  isDirectory: boolean;
  workspaceId: string;
};

type ExplorerExternalImportEntry =
  | {
      kind: "directory";
      relativePath: string;
    }
  | {
      kind: "file";
      relativePath: string;
      content: Uint8Array;
    };

type ExplorerExternalDropEntry = FileSystemEntry;

type ExplorerExternalDropDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => ExplorerExternalDropEntry | null;
};

function joinExplorerImportPath(parentPath: string, name: string) {
  const trimmedName = name
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!parentPath) {
    return trimmedName;
  }
  return trimmedName ? `${parentPath}/${trimmedName}` : parentPath;
}

function droppedFileRelativePath(file: File) {
  const relativePath =
    "webkitRelativePath" in file && typeof file.webkitRelativePath === "string"
      ? file.webkitRelativePath.trim()
      : "";
  return relativePath || file.name;
}

async function readExternalDropDirectoryEntries(
  entry: FileSystemDirectoryEntry,
) {
  const reader = entry.createReader();
  const entries: ExplorerExternalDropEntry[] = [];

  while (true) {
    const nextBatch = await new Promise<ExplorerExternalDropEntry[]>(
      (resolve, reject) => {
        reader.readEntries(resolve, (error) => {
          reject(error ?? new Error(`Failed to read ${entry.name}.`));
        });
      },
    );
    if (nextBatch.length === 0) {
      break;
    }
    entries.push(...nextBatch);
  }

  return entries;
}

async function readExternalDropFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, (error) => {
      reject(error ?? new Error(`Failed to read ${entry.name}.`));
    });
  });
}

async function collectDroppedExternalEntriesFromEntry(
  entry: ExplorerExternalDropEntry,
  parentRelativePath = "",
): Promise<ExplorerExternalImportEntry[]> {
  const relativePath = joinExplorerImportPath(parentRelativePath, entry.name);
  if (!relativePath) {
    return [];
  }

  if (entry.isFile) {
    const file = await readExternalDropFile(entry as FileSystemFileEntry);
    return [
      {
        kind: "file",
        relativePath,
        content: new Uint8Array(await file.arrayBuffer()),
      },
    ];
  }

  const childEntries = await readExternalDropDirectoryEntries(
    entry as FileSystemDirectoryEntry,
  );
  const importedEntries: ExplorerExternalImportEntry[] = [
    { kind: "directory", relativePath },
  ];
  for (const childEntry of childEntries) {
    importedEntries.push(
      ...(await collectDroppedExternalEntriesFromEntry(
        childEntry,
        relativePath,
      )),
    );
  }
  return importedEntries;
}

function dedupeExplorerExternalImportEntries(
  entries: ExplorerExternalImportEntry[],
) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}:${entry.relativePath}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasExternalExplorerDropData(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }

  if ((dataTransfer.files?.length ?? 0) > 0) {
    return true;
  }

  return Array.from(dataTransfer.items ?? []).some(
    (item) => item.kind === "file",
  );
}

async function collectDroppedExternalEntries(
  dataTransfer: DataTransfer | null,
) {
  if (!dataTransfer) {
    return [];
  }

  const importedEntries: ExplorerExternalImportEntry[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }

    const filesystemEntry = (
      item as ExplorerExternalDropDataTransferItem
    ).webkitGetAsEntry?.();
    if (filesystemEntry) {
      importedEntries.push(
        ...(await collectDroppedExternalEntriesFromEntry(filesystemEntry)),
      );
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    importedEntries.push({
      kind: "file",
      relativePath: droppedFileRelativePath(file),
      content: new Uint8Array(await file.arrayBuffer()),
    });
  }

  const fileEntries = await Promise.all(
    Array.from(dataTransfer.files ?? []).map(async (file) => ({
      kind: "file" as const,
      relativePath: droppedFileRelativePath(file),
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  if (importedEntries.length === 0) {
    return dedupeExplorerExternalImportEntries(fileEntries);
  }

  const hasImportedDirectories = importedEntries.some(
    (entry) => entry.kind === "directory",
  );
  if (hasImportedDirectories) {
    return dedupeExplorerExternalImportEntries(importedEntries);
  }

  const importedFilePaths = new Set(
    importedEntries
      .filter(
        (
          entry,
        ): entry is Extract<ExplorerExternalImportEntry, { kind: "file" }> =>
          entry.kind === "file",
      )
      .map((entry) => entry.relativePath),
  );
  const hasUnmatchedDroppedFiles = fileEntries.some(
    (entry) => !importedFilePaths.has(entry.relativePath),
  );
  if (!hasUnmatchedDroppedFiles) {
    return dedupeExplorerExternalImportEntries(importedEntries);
  }

  return dedupeExplorerExternalImportEntries([
    ...importedEntries,
    ...fileEntries,
  ]);
}

function getComparableFileName(targetName: string) {
  const normalized = targetName
    .trim()
    .toLowerCase()
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function getFileExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase();
  const lastDotIndex = normalized.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }
  return normalized.slice(lastDotIndex);
}

function getExplorerIconDescriptor(
  targetName: string,
  isDirectory: boolean,
  isExpanded = false,
): ExplorerIconDescriptor {
  if (isDirectory) {
    return { name: isExpanded ? "folder-open" : "folder" };
  }

  const normalizedFileName = getComparableFileName(targetName);
  const extension = getFileExtension(normalizedFileName);

  if (normalizedFileName === "package.json") return { name: "npm" };
  if (normalizedFileName === "package-lock.json") return { name: "lock" };
  if (normalizedFileName === "bun.lockb" || normalizedFileName === "bun.lock") {
    return { name: "bun" };
  }
  if (normalizedFileName === "pnpm-lock.yaml") return { name: "pnpm" };
  if (
    normalizedFileName === ".gitignore" ||
    normalizedFileName === ".gitattributes"
  ) {
    return { name: "git" };
  }
  if (normalizedFileName === "dockerfile") return { name: "docker" };
  if (normalizedFileName === "makefile") return { name: "config" };
  if (normalizedFileName.startsWith(".env")) return { name: "env" };
  if (
    SPECIAL_POLICY_FILENAMES.has(normalizedFileName) ||
    normalizedFileName === "readme.md" ||
    normalizedFileName === "readme"
  ) {
    return { name: "readme" };
  }
  if (normalizedFileName.endsWith(".lock")) return { name: "lock" };

  if (SPREADSHEET_EXTENSIONS.has(extension)) return { name: "csv" };
  if (extension === ".pdf") return { name: "pdf" };

  if (IMAGE_EXTENSIONS.has(extension)) {
    return { name: extension === ".svg" ? "svg" : "image" };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) return { name: "zip" };
  if (AUDIO_EXTENSIONS.has(extension)) return { name: "audio" };
  if (VIDEO_EXTENSIONS.has(extension)) return { name: "video" };
  if (JSON_EXTENSIONS.has(extension)) return { name: "json" };

  switch (extension) {
    case ".ts":
    case ".tsx":
      return { name: "typescript" };
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return { name: "javascript" };
    case ".css":
      return { name: "css" };
    case ".scss":
    case ".sass":
      return { name: "sass" };
    case ".html":
    case ".htm":
      return { name: "html" };
    case ".xml":
      return { name: "xml" };
    case ".py":
      return { name: "python" };
    case ".sh":
    case ".bash":
    case ".zsh":
      return { name: "bash" };
    case ".sql":
      return { name: "database" };
    case ".go":
      return { name: "go" };
    case ".rs":
      return { name: "rust" };
    case ".java":
      return { name: "java" };
    case ".kt":
      return { name: "kotlin" };
    case ".php":
      return { name: "php" };
    case ".swift":
      return { name: "swift" };
    case ".c":
      return { name: "c" };
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return { name: "cpp" };
    case ".md":
    case ".mdx":
    case ".markdown":
      return { name: "markdown" };
    case ".dashboard":
      return { name: "database" };
    case ".yml":
    case ".yaml":
      return { name: "yaml" };
    case ".toml":
      return { name: "toml" };
    case ".ini":
      return { name: "config" };
    default:
      return { name: "text" };
  }
}

function getLucideIconForDescriptor(name: string): LucideIcon {
  switch (name) {
    case "folder":
      return Folder;
    case "folder-open":
      return FolderOpen;
    case "image":
    case "svg":
      return FileImage;
    case "audio":
      return FileAudio;
    case "video":
      return FileVideo;
    case "zip":
      return FileArchive;
    case "csv":
      return FileSpreadsheet;
    case "pdf":
    case "markdown":
    case "readme":
      return FileText;
    case "json":
    case "yaml":
    case "toml":
      return FileJson;
    case "typescript":
    case "javascript":
    case "python":
    case "go":
    case "rust":
    case "java":
    case "kotlin":
    case "php":
    case "swift":
    case "c":
    case "cpp":
    case "bash":
    case "html":
    case "css":
    case "sass":
    case "xml":
    case "database":
      return FileCode;
    case "env":
      return KeyRound;
    case "lock":
      return Lock;
    case "git":
      return GitBranch;
    case "docker":
    case "npm":
    case "bun":
    case "pnpm":
      return Package;
    case "config":
      return Settings;
    default:
      return File;
  }
}

function FileTreeIcon({
  descriptorName,
  className = "",
}: {
  descriptorName: string;
  className?: string;
}) {
  const Icon = getLucideIconForDescriptor(descriptorName);
  return (
    <Icon
      className={`size-3.5 shrink-0 text-muted-foreground ${className}`.trim()}
      strokeWidth={1.7}
    />
  );
}

function isMarkdownPreviewPayload(
  preview: Pick<FilePreviewPayload, "kind" | "extension"> | null | undefined,
): boolean {
  if (!preview || preview.kind !== "text") {
    return false;
  }
  return MARKDOWN_PREVIEW_EXTENSIONS.has(
    preview.extension.trim().toLowerCase(),
  );
}

function isHtmlPreviewPayload(
  preview: Pick<FilePreviewPayload, "kind" | "extension"> | null | undefined,
): boolean {
  if (!preview || preview.kind !== "text") {
    return false;
  }
  return HTML_PREVIEW_EXTENSIONS.has(preview.extension.trim().toLowerCase());
}

function getFolderName(targetPath: string) {
  const normalized = targetPath.replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:$/.test(normalized)) {
    return normalized;
  }

  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || targetPath;
}

function getParentFolderPath(targetPath: string) {
  const normalized = targetPath.replace(/[\\/]+$/, "");
  const windowsRootMatch = normalized.match(/^[a-zA-Z]:$/);
  if (windowsRootMatch) {
    return null;
  }

  if (normalized === "/") {
    return null;
  }

  const lastSeparatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (lastSeparatorIndex <= 0) {
    return normalized.includes("\\") ? normalized.slice(0, 3) : "/";
  }

  return normalized.slice(0, lastSeparatorIndex);
}

function normalizeComparablePath(targetPath: string) {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return "";
  }

  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function isPathWithin(parentPath: string, targetPath: string) {
  const normalizedParent = normalizeComparablePath(parentPath);
  const normalizedTarget = normalizeComparablePath(targetPath);
  if (!normalizedParent || !normalizedTarget) {
    return false;
  }
  return (
    normalizedTarget === normalizedParent ||
    normalizedTarget.startsWith(`${normalizedParent}/`)
  );
}

function isAbsolutePath(targetPath: string) {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(targetPath.trim());
}

function isMissingFilePreviewError(cause: unknown) {
  if (!(cause instanceof Error)) {
    return false;
  }
  return (
    /\bENOENT\b/i.test(cause.message) ||
    /no such file or directory/i.test(cause.message)
  );
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function remapPathAfterRename(
  sourcePath: string,
  nextPath: string,
  candidatePath: string | null | undefined,
) {
  const trimmedCandidatePath = (candidatePath ?? "").trim();
  const trimmedNextPath = nextPath.trim();
  const normalizedSourcePath = normalizeComparablePath(sourcePath);
  const normalizedCandidatePath = normalizeComparablePath(trimmedCandidatePath);
  if (
    !trimmedCandidatePath ||
    !trimmedNextPath ||
    !normalizedSourcePath ||
    !normalizedCandidatePath ||
    !isPathWithin(normalizedSourcePath, normalizedCandidatePath)
  ) {
    return trimmedCandidatePath;
  }
  if (normalizedCandidatePath === normalizedSourcePath) {
    return trimmedNextPath;
  }
  const suffix = normalizedCandidatePath
    .slice(normalizedSourcePath.length)
    .replace(/^\/+/, "");
  if (!suffix) {
    return trimmedNextPath;
  }
  const separator = trimmedNextPath.includes("\\") ? "\\" : "/";
  return `${trimmedNextPath.replace(/[\\/]+$/, "")}${separator}${suffix.split("/").join(separator)}`;
}

function remapExplorerPathRecord<T>(
  record: Record<string, T>,
  sourcePath: string,
  nextPath: string,
) {
  let changed = false;
  const nextRecord: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const remappedKey = remapPathAfterRename(sourcePath, nextPath, key) || key;
    if (remappedKey !== key) {
      changed = true;
    }
    nextRecord[remappedKey] = value;
  }
  return changed ? nextRecord : record;
}

function remapDirectoryEntriesByPath(
  directoryEntriesByPath: Record<string, LocalFileEntry[]>,
  sourcePath: string,
  nextPath: string,
) {
  let changed = false;
  const nextEntriesByPath: Record<string, LocalFileEntry[]> = {};
  for (const [directoryPath, entries] of Object.entries(
    directoryEntriesByPath,
  )) {
    const remappedDirectoryPath =
      remapPathAfterRename(sourcePath, nextPath, directoryPath) ||
      directoryPath;
    const remappedEntries = entries.map((entry) => {
      const remappedAbsolutePath = remapPathAfterRename(
        sourcePath,
        nextPath,
        entry.absolutePath,
      );
      if (remappedAbsolutePath === entry.absolutePath) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        absolutePath: remappedAbsolutePath,
      };
    });
    if (remappedDirectoryPath !== directoryPath) {
      changed = true;
    }
    nextEntriesByPath[remappedDirectoryPath] = remappedEntries;
  }
  return changed ? nextEntriesByPath : directoryEntriesByPath;
}

function resolveWorkspaceTargetPath(workspaceRoot: string, targetPath: string) {
  const trimmedRoot = workspaceRoot.trim();
  const trimmedTarget = targetPath.trim();
  if (!trimmedRoot) {
    return trimmedTarget;
  }
  if (isAbsolutePath(trimmedTarget)) {
    return trimmedTarget;
  }
  const separator = trimmedRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = trimmedRoot.replace(/[\\/]+$/, "");
  const normalizedTarget = trimmedTarget.replace(/^[\\/]+/, "");
  return `${normalizedRoot}${separator}${normalizedTarget}`;
}

function getProtectedWorkspacePathLabel(
  workspaceRoot: string | null | undefined,
  targetPath: string | null | undefined,
): "workspace.yaml" | "AGENTS.md" | "skills" | null {
  const normalizedWorkspaceRoot = normalizeComparablePath(workspaceRoot ?? "");
  const normalizedTargetPath = normalizeComparablePath(targetPath ?? "");
  if (
    !normalizedWorkspaceRoot ||
    !normalizedTargetPath ||
    !isPathWithin(normalizedWorkspaceRoot, normalizedTargetPath)
  ) {
    return null;
  }

  const relativePath = normalizedTargetPath
    .slice(normalizedWorkspaceRoot.length)
    .replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }
  const comparableRelativePath = relativePath.toLowerCase();
  if (comparableRelativePath === "workspace.yaml") {
    return "workspace.yaml";
  }
  if (comparableRelativePath === "agents.md") {
    return "AGENTS.md";
  }
  if (comparableRelativePath === "skills") {
    return "skills";
  }
  return null;
}

function protectedWorkspacePathMessage(
  workspaceRoot: string | null | undefined,
  targetPath: string | null | undefined,
) {
  const protectedPathLabel = getProtectedWorkspacePathLabel(
    workspaceRoot,
    targetPath,
  );
  if (!protectedPathLabel) {
    return "";
  }
  if (protectedPathLabel === "skills") {
    return "The skills folder cannot be renamed, moved, or deleted from the file explorer.";
  }
  return `${protectedPathLabel} cannot be renamed, moved, or deleted from the file explorer.`;
}

function isProtectedWorkspacePath(
  workspaceRoot: string | null | undefined,
  targetPath: string | null | undefined,
) {
  return Boolean(getProtectedWorkspacePathLabel(workspaceRoot, targetPath));
}

function findLoadedEntry(
  entries: LocalFileEntry[],
  targetPath: string,
  directoryEntriesByPath: Record<string, LocalFileEntry[]>,
): LocalFileEntry | null {
  const normalizedTargetPath = normalizeComparablePath(targetPath);
  if (!normalizedTargetPath) {
    return null;
  }

  const stack = [...entries];
  while (stack.length > 0) {
    const entry = stack.shift();
    if (!entry) {
      continue;
    }

    if (normalizeComparablePath(entry.absolutePath) === normalizedTargetPath) {
      return entry;
    }

    if (!entry.isDirectory) {
      continue;
    }

    const childEntries = directoryEntriesByPath[entry.absolutePath];
    if (childEntries?.length) {
      stack.unshift(...childEntries);
    }
  }

  return null;
}

function buildVisibleExplorerRows(
  entries: LocalFileEntry[],
  directoryEntriesByPath: Record<string, LocalFileEntry[]>,
  expandedDirectoryPaths: Record<string, boolean>,
  directoryLoadingByPath: Record<string, boolean>,
  directoryErrorByPath: Record<string, string>,
  query: string,
  depth = 0,
): FileExplorerVisibleRow[] {
  const rows: FileExplorerVisibleRow[] = [];

  for (const entry of entries) {
    const isExpanded = Boolean(expandedDirectoryPaths[entry.absolutePath]);
    const isLoadingChildren = Boolean(
      directoryLoadingByPath[entry.absolutePath],
    );
    const childError = directoryErrorByPath[entry.absolutePath] ?? "";
    const shouldSearchChildren =
      entry.isDirectory && (isExpanded || query.length > 0);
    const childEntries = shouldSearchChildren
      ? (directoryEntriesByPath[entry.absolutePath] ?? [])
      : [];
    const childRows = shouldSearchChildren
      ? buildVisibleExplorerRows(
          childEntries,
          directoryEntriesByPath,
          expandedDirectoryPaths,
          directoryLoadingByPath,
          directoryErrorByPath,
          query,
          depth + 1,
        )
      : [];
    const matchesSelf =
      query.length === 0 || entry.name.toLowerCase().includes(query);
    const hasMatchingDescendants = childRows.length > 0;

    if (query.length > 0 && !matchesSelf && !hasMatchingDescendants) {
      continue;
    }

    rows.push({
      type: "entry",
      entry,
      depth,
      isExpanded,
      isLoadingChildren,
      childError,
    });

    const shouldShowChildren = entry.isDirectory
      ? query.length > 0
        ? hasMatchingDescendants
        : isExpanded
      : false;
    if (!shouldShowChildren) {
      continue;
    }

    if (isLoadingChildren) {
      rows.push({
        type: "feedback",
        id: `loading:${entry.absolutePath}`,
        depth: depth + 1,
        tone: "loading",
        message: "Loading folder...",
      });
      continue;
    }

    if (childError) {
      rows.push({
        type: "feedback",
        id: `error:${entry.absolutePath}`,
        depth: depth + 1,
        tone: "error",
        message: childError,
      });
      continue;
    }

    rows.push(...childRows);
  }

  return rows;
}

function isWorkspaceRootExplorerView(
  currentPath: string | null | undefined,
  workspaceRootPath: string | null | undefined,
) {
  const normalizedCurrentPath = normalizeComparablePath(currentPath ?? "");
  const normalizedWorkspaceRoot = normalizeComparablePath(
    workspaceRootPath ?? "",
  );
  return Boolean(
    normalizedCurrentPath &&
    normalizedWorkspaceRoot &&
    normalizedCurrentPath === normalizedWorkspaceRoot,
  );
}

function formatFileSize(size: number) {
  if (size <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatModified(ts: string) {
  const date = new Date(ts);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renameSelectionEnd(targetName: string, isDirectory: boolean) {
  if (isDirectory) {
    return targetName.length;
  }
  const lastDotIndex = targetName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return targetName.length;
  }
  return lastDotIndex;
}

function getExplorerRowTooltip(entry: LocalFileEntry, isExpanded: boolean) {
  if (entry.isDirectory) {
    return isExpanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`;
  }
  return `Open ${entry.name}`;
}

function getExplorerRowId(absolutePath: string) {
  return `explorer-row-${absolutePath.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function createAttachmentDragPreview(entry: LocalFileEntry) {
  const preview = document.createElement("div");
  const rootStyles = getComputedStyle(document.documentElement);
  const popoverBg =
    rootStyles.getPropertyValue("--popover").trim() ||
    rootStyles.getPropertyValue("--card").trim() ||
    "var(--background)";
  const primary = rootStyles.getPropertyValue("--primary").trim() || "#f58419";
  const popoverFg =
    rootStyles.getPropertyValue("--popover-foreground").trim() ||
    rootStyles.getPropertyValue("--foreground").trim() ||
    "#111";

  preview.style.position = "fixed";
  preview.style.top = "-1000px";
  preview.style.left = "-1000px";
  preview.style.display = "inline-flex";
  preview.style.alignItems = "center";
  preview.style.maxWidth = "220px";
  preview.style.padding = "6px 10px";
  preview.style.border = `1px solid color-mix(in oklch, ${primary} 34%, transparent)`;
  preview.style.borderRadius = "999px";
  preview.style.background = `color-mix(in oklch, ${popoverBg} 92%, transparent)`;
  preview.style.boxShadow = `0 10px 24px color-mix(in oklch, ${popoverFg} 14%, transparent)`;
  preview.style.backdropFilter = "blur(10px)";
  preview.style.color = popoverFg;
  preview.style.fontFamily =
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  preview.style.pointerEvents = "none";
  preview.style.zIndex = "2147483647";

  const label = document.createElement("span");
  label.textContent = entry.name;
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  label.style.fontSize = "11px";
  label.style.fontWeight = "600";
  label.style.lineHeight = "1.2";

  preview.append(label);
  document.body.append(preview);
  return preview;
}

export function FileExplorerPane({
  focusRequest = null,
  onFocusRequestConsumed,
  previewInPane = true,
  onFileOpen,
  onReferenceInChat,
  onDeleteEntry,
  onOpenLinkInBrowser,
  onOpenLocalLink,
  embedded = false,
}: FileExplorerPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameInFlightRef = useRef(false);
  const createInFlightRef = useRef(false);
  const moveInFlightRef = useRef(false);
  const importInFlightRef = useRef(false);
  const pasteInFlightRef = useRef(false);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedWorkspaceRootRef = useRef<{
    workspaceId: string;
    rootPath: string;
  } | null>(null);
  const lastProcessedFocusRequestKeyRef = useRef<number | null>(null);
  const workspaceSessionKeyRef = useRef(0);
  const directoryLoadRequestKeyRef = useRef(0);
  const previewRequestKeyRef = useRef(0);
  const currentPathRef = useRef("");
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const deleteEntryRef = useRef<
    ((entry: LocalFileEntry) => Promise<void>) | null
  >(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<LocalFileEntry[]>([]);
  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<
    Record<string, LocalFileEntry[]>
  >({});
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState<
    Record<string, boolean>
  >({});
  const [directoryLoadingByPath, setDirectoryLoadingByPath] = useState<
    Record<string, boolean>
  >({});
  const [directoryErrorByPath, setDirectoryErrorByPath] = useState<
    Record<string, string>
  >({});
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [workspaceRootPath, setWorkspaceRootPath] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [previewDraft, setPreviewDraft] = useState("");
  const [tablePreviewDraft, setTablePreviewDraft] = useState<
    FilePreviewTableSheetPayload[]
  >([]);
  const [textPreviewMode, setTextPreviewMode] =
    useState<TextPreviewMode>("edit");
  const [activeTableSheetIndex, setActiveTableSheetIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fileBookmarks, setFileBookmarks] = useState<FileBookmarkPayload[]>([]);
  const [contextMenu, setContextMenu] =
    useState<FileExplorerContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [draggedEntryPath, setDraggedEntryPath] = useState<string | null>(null);
  const [directoryDropTargetPath, setDirectoryDropTargetPath] = useState<
    string | null
  >(null);
  const [paneExternalDropTarget, setPaneExternalDropTarget] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    description?: string;
    confirmLabel?: string;
    destructive?: boolean;
  } | null>(null);
  const confirmResolveRef = useRef<((value: boolean) => void) | null>(null);
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const requestConfirmation = useCallback(
    (request: {
      title: string;
      description?: string;
      confirmLabel?: string;
      destructive?: boolean;
    }) => {
      confirmResolveRef.current?.(false);
      return new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmRequest(request);
      });
    },
    [],
  );

  const handleConfirmResolution = useCallback((result: boolean) => {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmRequest(null);
    resolve?.(result);
  }, []);

  currentPathRef.current = currentPath;

  const clearActiveDropTargets = useCallback(() => {
    setDirectoryDropTargetPath(null);
    setPaneExternalDropTarget(false);
  }, []);

  const resetPreviewState = useCallback(() => {
    previewRequestKeyRef.current += 1;
    isDirtyRef.current = false;
    isSavingRef.current = false;
    setPreview(null);
    setPreviewDraft("");
    setTablePreviewDraft([]);
    setTextPreviewMode("edit");
    setActiveTableSheetIndex(0);
    setPreviewError("");
    setPreviewLoading(false);
    setSaving(false);
  }, []);

  const validateWorkspaceScopedTargetPath = useCallback(
    async (targetPath?: string | null) => {
      const normalizedWorkspaceId = selectedWorkspaceId?.trim() || "";
      const normalizedTargetPath =
        typeof targetPath === "string" ? targetPath.trim() : "";
      const nextTargetPath = normalizedTargetPath || null;

      if (
        !normalizedWorkspaceId ||
        !normalizedTargetPath ||
        !isAbsolutePath(normalizedTargetPath)
      ) {
        return {
          allowed: true,
          targetPath: nextTargetPath,
        };
      }

      let resolvedWorkspaceRoot = "";
      try {
        resolvedWorkspaceRoot = (
          await window.electronAPI.workspace.getWorkspaceRoot(
            normalizedWorkspaceId,
          )
        ).trim();
      } catch {
        resolvedWorkspaceRoot = workspaceRootPath?.trim() || "";
      }

      if (
        resolvedWorkspaceRoot &&
        normalizeComparablePath(resolvedWorkspaceRoot) !==
          normalizeComparablePath(workspaceRootPath ?? "")
      ) {
        setWorkspaceRootPath(resolvedWorkspaceRoot);
      }

      if (!resolvedWorkspaceRoot) {
        return {
          allowed: false,
          targetPath: nextTargetPath,
        };
      }

      return {
        allowed: isPathWithin(resolvedWorkspaceRoot, normalizedTargetPath),
        targetPath: nextTargetPath,
      };
    },
    [selectedWorkspaceId, workspaceRootPath],
  );

  const loadDirectory = useCallback(
    async (targetPath?: string | null, pushHistory = true) => {
      const workspaceSessionKey = workspaceSessionKeyRef.current;
      const requestKey = ++directoryLoadRequestKeyRef.current;
      const { allowed, targetPath: validatedTargetPath } =
        await validateWorkspaceScopedTargetPath(targetPath ?? null);
      if (
        workspaceSessionKey !== workspaceSessionKeyRef.current ||
        requestKey !== directoryLoadRequestKeyRef.current ||
        !allowed
      ) {
        return;
      }

      setLoading(true);
      setError("");

      try {
        const payload = await window.electronAPI.fs.listDirectory(
          validatedTargetPath,
          selectedWorkspaceId ?? null,
        );
        if (
          workspaceSessionKey !== workspaceSessionKeyRef.current ||
          requestKey !== directoryLoadRequestKeyRef.current
        ) {
          return;
        }
        const previousCurrentPath = currentPathRef.current;
        const shouldResetTree =
          pushHistory ||
          normalizeComparablePath(previousCurrentPath) !==
            normalizeComparablePath(payload.currentPath);
        setCurrentPath(payload.currentPath);
        currentPathRef.current = payload.currentPath;
        setEntries(payload.entries);
        setDirectoryEntriesByPath((current) =>
          shouldResetTree
            ? { [payload.currentPath]: payload.entries }
            : { ...current, [payload.currentPath]: payload.entries },
        );
        if (shouldResetTree) {
          setExpandedDirectoryPaths({});
          setDirectoryLoadingByPath({});
          setDirectoryErrorByPath({});
        }

        setSelectedPath((prev) =>
          !prev ||
          (!payload.entries.some((entry) => entry.absolutePath === prev) &&
            !isPathWithin(payload.currentPath, prev))
            ? (payload.entries[0]?.absolutePath ?? "")
            : prev,
        );
      } catch (cause) {
        if (
          workspaceSessionKey !== workspaceSessionKeyRef.current ||
          requestKey !== directoryLoadRequestKeyRef.current
        ) {
          return;
        }
        const message =
          cause instanceof Error ? cause.message : "Failed to open directory.";
        setError(message);
      } finally {
        if (
          workspaceSessionKey === workspaceSessionKeyRef.current &&
          requestKey === directoryLoadRequestKeyRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [selectedWorkspaceId, validateWorkspaceScopedTargetPath],
  );

  useEffect(() => {
    void loadDirectory(null, true);
  }, [loadDirectory]);

  useEffect(() => {
    workspaceSessionKeyRef.current += 1;
    directoryLoadRequestKeyRef.current += 1;
    previewRequestKeyRef.current += 1;
    lastSyncedWorkspaceRootRef.current = null;
    currentPathRef.current = "";
    setCurrentPath("");
    setEntries([]);
    setDirectoryEntriesByPath({});
    setExpandedDirectoryPaths({});
    setDirectoryLoadingByPath({});
    setDirectoryErrorByPath({});
    setSelectedPath("");
    setWorkspaceRootPath(null);
    setLoading(false);
    setError("");
    setContextMenu(null);
    setRenamingPath(null);
    setRenameDraft("");
    setRenameSaving(false);
    setDraggedEntryPath(null);
    setDirectoryDropTargetPath(null);
    setPaneExternalDropTarget(false);
    resetPreviewState();
  }, [resetPreviewState, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }

    let cancelled = false;

    async function loadWorkspaceDirectory() {
      try {
        const workspaceRoot =
          await window.electronAPI.workspace.getWorkspaceRoot(
            selectedWorkspaceId,
          );
        if (workspaceRoot) {
          setWorkspaceRootPath(workspaceRoot);
        }
        const lastSyncedWorkspaceRoot = lastSyncedWorkspaceRootRef.current;
        if (
          !workspaceRoot ||
          cancelled ||
          (lastSyncedWorkspaceRoot?.workspaceId === selectedWorkspaceId &&
            lastSyncedWorkspaceRoot.rootPath === workspaceRoot)
        ) {
          return;
        }
        lastSyncedWorkspaceRootRef.current = {
          workspaceId: selectedWorkspaceId,
          rootPath: workspaceRoot,
        };
        await loadDirectory(workspaceRoot, true);
      } catch {
        // The workspace directory may not exist yet while provisioning.
      }
    }

    void loadWorkspaceDirectory();
    return () => {
      cancelled = true;
    };
  }, [loadDirectory, selectedWorkspaceId]);

  useEffect(() => {
    if (!currentPath) {
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;

    const refreshLoadedDirectories = async () => {
      if (cancelled || refreshInFlight) {
        return;
      }

      refreshInFlight = true;
      try {
        const refreshTargets = [
          currentPath,
          ...Object.entries(expandedDirectoryPaths)
            .filter(([, isExpanded]) => isExpanded)
            .map(([targetPath]) => targetPath),
        ].filter(
          (targetPath, index, paths) =>
            Boolean(targetPath) &&
            paths.findIndex(
              (candidatePath) =>
                normalizeComparablePath(candidatePath) ===
                normalizeComparablePath(targetPath),
            ) === index,
        );
        const refreshedDirectories = await Promise.allSettled(
          refreshTargets.map(async (targetPath) => {
            const { allowed, targetPath: validatedTargetPath } =
              await validateWorkspaceScopedTargetPath(targetPath);
            if (!allowed || !validatedTargetPath) {
              return null;
            }
            return window.electronAPI.fs.listDirectory(
              validatedTargetPath,
              selectedWorkspaceId ?? null,
            );
          }),
        );
        if (cancelled) {
          return;
        }

        let currentDirectoryPayload: LocalDirectoryResponse | null = null;
        const refreshedEntriesByPath: Record<string, LocalFileEntry[]> = {};

        for (const refreshedDirectory of refreshedDirectories) {
          if (
            refreshedDirectory.status !== "fulfilled" ||
            !refreshedDirectory.value
          ) {
            continue;
          }
          const payload = refreshedDirectory.value;
          refreshedEntriesByPath[payload.currentPath] = payload.entries;
          if (
            normalizeComparablePath(payload.currentPath) ===
            normalizeComparablePath(currentPath)
          ) {
            currentDirectoryPayload = payload;
          }
        }

        if (Object.keys(refreshedEntriesByPath).length > 0) {
          setDirectoryEntriesByPath((current) => ({
            ...current,
            ...refreshedEntriesByPath,
          }));
        }
        if (!currentDirectoryPayload) {
          return;
        }

        setEntries(currentDirectoryPayload.entries);
        setSelectedPath((prev) =>
          !prev ||
          (!currentDirectoryPayload.entries.some(
            (entry) => entry.absolutePath === prev,
          ) &&
            !isPathWithin(currentDirectoryPayload.currentPath, prev))
            ? (currentDirectoryPayload.entries[0]?.absolutePath ?? "")
            : prev,
        );
      } catch {
        // Best-effort background refresh; keep current listings on transient failures.
      } finally {
        refreshInFlight = false;
      }
    };

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refreshLoadedDirectories();
    };

    const timer = window.setInterval(tick, 5000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshLoadedDirectories();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    currentPath,
    expandedDirectoryPaths,
    selectedWorkspaceId,
    validateWorkspaceScopedTargetPath,
  ]);

  useEffect(() => {
    let mounted = true;

    void window.electronAPI.fs
      .getBookmarks(selectedWorkspaceId ?? null)
      .then((bookmarks) => {
        if (mounted) {
          setFileBookmarks(bookmarks);
        }
      });

    const unsubscribe = window.electronAPI.fs.onBookmarksChange((bookmarks) => {
      setFileBookmarks(bookmarks);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    return () => {
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return;
      }
      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    const closeMenu = () => {
      setContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);

    const focusTimer = window.setTimeout(() => {
      const firstItem = contextMenuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      firstItem?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [contextMenu]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const buildRows = (targetEntries: LocalFileEntry[]) =>
      buildVisibleExplorerRows(
        targetEntries,
        directoryEntriesByPath,
        expandedDirectoryPaths,
        directoryLoadingByPath,
        directoryErrorByPath,
        normalizedQuery,
      );

    if (!isWorkspaceRootExplorerView(currentPath, workspaceRootPath)) {
      return [
        {
          id: "workspace" as const,
          rows: buildRows(entries),
        },
      ];
    }

    const protectedRootEntries = entries.filter((entry) =>
      isProtectedWorkspacePath(workspaceRootPath, entry.absolutePath),
    );
    const workspaceEntries = entries.filter(
      (entry) =>
        !isProtectedWorkspacePath(workspaceRootPath, entry.absolutePath),
    );
    const protectedRows = buildRows(protectedRootEntries);
    const workspaceRows = buildRows(workspaceEntries);
    const sections: FileExplorerVisibleSection[] = [];

    if (protectedRows.length > 0) {
      sections.push({
        id: "protected",
        rows: protectedRows,
      });
    }
    if (workspaceRows.length > 0) {
      sections.push({
        id: "workspace",
        rows: workspaceRows,
      });
    }

    return sections;
  }, [
    currentPath,
    directoryEntriesByPath,
    directoryErrorByPath,
    directoryLoadingByPath,
    entries,
    expandedDirectoryPaths,
    query,
    workspaceRootPath,
  ]);
  const visibleRows = useMemo(
    () => filteredEntries.flatMap((section) => section.rows),
    [filteredEntries],
  );
  const hasVisibleEntryRows = useMemo(
    () => visibleRows.some((row) => row.type === "entry"),
    [visibleRows],
  );

  const selectedEntry = useMemo(
    () => findLoadedEntry(entries, selectedPath, directoryEntriesByPath),
    [directoryEntriesByPath, entries, selectedPath],
  );
  const renamingEntry = renamingPath
    ? findLoadedEntry(entries, renamingPath, directoryEntriesByPath)
    : null;
  const creationTargetDirectoryPath = selectedEntry?.isDirectory
    ? selectedEntry.absolutePath
    : selectedEntry
      ? (getParentFolderPath(selectedEntry.absolutePath) ?? currentPath)
      : currentPath;
  const isDirty =
    preview?.kind === "text" && preview.isEditable
      ? previewDraft !== (preview.content ?? "")
      : preview?.kind === "table" && preview.isEditable
        ? !areTablePreviewSheetsEqual(tablePreviewDraft, preview.tableSheets)
        : false;
  const isMarkdownPreview = isMarkdownPreviewPayload(preview);
  const isHtmlPreview = isHtmlPreviewPayload(preview);
  const supportsRenderedTextPreview = isMarkdownPreview || isHtmlPreview;

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    isSavingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (loading || error || hasVisibleEntryRows) {
      return;
    }

    resetPreviewState();
  }, [error, hasVisibleEntryRows, loading, resetPreviewState]);

  useEffect(() => {
    if (!selectedPath) return;
    const rowElement = document.getElementById(getExplorerRowId(selectedPath));
    if (!rowElement) return;
    rowElement.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedPath, expandedDirectoryPaths, visibleRows]);

  const openPreviewLink = useCallback(
    (url: string) => {
      if (onOpenLinkInBrowser) {
        onOpenLinkInBrowser(url);
        return;
      }
      void window.electronAPI.ui.openExternalUrl(url);
    },
    [onOpenLinkInBrowser],
  );

  const previewAbsolutePath = preview?.absolutePath ?? null;
  const handleLocalLinkInPreview = useCallback(
    (href: string) => {
      if (!onOpenLocalLink) {
        return;
      }
      let raw = href.trim();
      if (!raw) {
        return;
      }
      if (raw.toLowerCase().startsWith("file://")) {
        raw = raw.slice(7);
      }
      let cleaned = raw;
      try {
        cleaned = decodeURI(raw);
      } catch {
        cleaned = raw;
      }
      let absolute = cleaned;
      if (!isAbsolutePath(cleaned)) {
        const previewPath = previewAbsolutePath?.trim() ?? "";
        const sep = previewPath.includes("\\") ? "\\" : "/";
        const baseDir = previewPath
          ? (() => {
              const idx = previewPath.lastIndexOf(sep);
              return idx <= 0 ? sep : previewPath.slice(0, idx);
            })()
          : (workspaceRootPath?.trim() ?? "");
        if (!baseDir) {
          return;
        }
        absolute = resolveWorkspaceTargetPath(baseDir, cleaned);
      }
      onOpenLocalLink(absolute);
    },
    [onOpenLocalLink, previewAbsolutePath, workspaceRootPath],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openEntryContextMenu = useCallback(
    (
      entry: LocalFileEntry,
      options?: {
        x?: number;
        y?: number;
        anchorRect?: DOMRect | null;
      },
    ) => {
      const paneRect = containerRef.current?.getBoundingClientRect();
      if (!paneRect) {
        return;
      }

      const anchorRect = options?.anchorRect ?? null;
      setSelectedPath(entry.absolutePath);
      setContextMenu({
        entry,
        x: options?.x ?? anchorRect?.right ?? paneRect.left + 8,
        y: options?.y ?? anchorRect?.bottom ?? paneRect.top + 8,
        paneBounds: {
          left: paneRect.left,
          top: paneRect.top,
          right: paneRect.right,
          bottom: paneRect.bottom,
          width: paneRect.width,
          height: paneRect.height,
        },
      });
    },
    [],
  );

  const ensureDirectoryEntriesLoaded = useCallback(
    async (targetPath: string) => {
      const normalizedTargetPath = targetPath.trim();
      if (!normalizedTargetPath) {
        return null;
      }

      const { allowed, targetPath: validatedTargetPath } =
        await validateWorkspaceScopedTargetPath(normalizedTargetPath);
      if (!allowed || !validatedTargetPath) {
        return null;
      }

      if (directoryEntriesByPath[validatedTargetPath]) {
        return directoryEntriesByPath[validatedTargetPath];
      }

      setDirectoryLoadingByPath((current) => ({
        ...current,
        [validatedTargetPath]: true,
      }));
      setDirectoryErrorByPath((current) => {
        if (!current[validatedTargetPath]) {
          return current;
        }
        const next = { ...current };
        delete next[validatedTargetPath];
        return next;
      });

      try {
        const payload = await window.electronAPI.fs.listDirectory(
          validatedTargetPath,
          selectedWorkspaceId ?? null,
        );
        setDirectoryEntriesByPath((current) => ({
          ...current,
          [payload.currentPath]: payload.entries,
        }));
        return payload.entries;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to open directory.";
        setDirectoryErrorByPath((current) => ({
          ...current,
          [validatedTargetPath]: message,
        }));
        return null;
      } finally {
        setDirectoryLoadingByPath((current) => {
          if (!current[validatedTargetPath]) {
            return current;
          }
          const next = { ...current };
          delete next[validatedTargetPath];
          return next;
        });
      }
    },
    [
      directoryEntriesByPath,
      selectedWorkspaceId,
      validateWorkspaceScopedTargetPath,
    ],
  );

  const refreshDirectoryEntries = useCallback(
    async (targetPath: string) => {
      const normalizedTargetPath = targetPath.trim();
      if (!normalizedTargetPath) {
        return;
      }

      const { allowed, targetPath: validatedTargetPath } =
        await validateWorkspaceScopedTargetPath(normalizedTargetPath);
      if (!allowed || !validatedTargetPath) {
        return;
      }

      if (
        normalizeComparablePath(validatedTargetPath) ===
        normalizeComparablePath(currentPathRef.current)
      ) {
        await loadDirectory(currentPathRef.current, false);
        return;
      }

      const payload = await window.electronAPI.fs.listDirectory(
        validatedTargetPath,
        selectedWorkspaceId ?? null,
      );
      setDirectoryEntriesByPath((current) => ({
        ...current,
        [payload.currentPath]: payload.entries,
      }));
      setDirectoryErrorByPath((current) => {
        if (!current[payload.currentPath]) {
          return current;
        }
        const next = { ...current };
        delete next[payload.currentPath];
        return next;
      });
    },
    [loadDirectory, selectedWorkspaceId, validateWorkspaceScopedTargetPath],
  );

  const revealPathInTree = useCallback(
    async (targetPath: string) => {
      const parentFolderPath = getParentFolderPath(targetPath);
      if (!parentFolderPath) {
        return;
      }

      const treeRootPath = currentPathRef.current;
      if (!treeRootPath || !isPathWithin(treeRootPath, parentFolderPath)) {
        await loadDirectory(parentFolderPath, true);
        return;
      }

      const ancestorPaths: string[] = [];
      const normalizedTreeRoot = normalizeComparablePath(treeRootPath);
      let cursor: string | null = parentFolderPath;

      while (cursor && normalizeComparablePath(cursor) !== normalizedTreeRoot) {
        ancestorPaths.unshift(cursor);
        const nextParent = getParentFolderPath(cursor);
        if (
          !nextParent ||
          normalizeComparablePath(nextParent) ===
            normalizeComparablePath(cursor)
        ) {
          break;
        }
        cursor = nextParent;
      }

      for (const ancestorPath of ancestorPaths) {
        const childEntries = await ensureDirectoryEntriesLoaded(ancestorPath);
        if (childEntries === null) {
          return;
        }
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [ancestorPath]: true,
        }));
      }
    },
    [ensureDirectoryEntriesLoaded, loadDirectory],
  );

  const toggleDirectoryExpansion = useCallback(
    async (entry: LocalFileEntry) => {
      setSelectedPath(entry.absolutePath);
      closeContextMenu();

      if (expandedDirectoryPaths[entry.absolutePath]) {
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [entry.absolutePath]: false,
        }));
        return;
      }

      const childEntries = await ensureDirectoryEntriesLoaded(
        entry.absolutePath,
      );
      if (childEntries === null) {
        return;
      }

      setExpandedDirectoryPaths((current) => ({
        ...current,
        [entry.absolutePath]: true,
      }));
    },
    [closeContextMenu, ensureDirectoryEntriesLoaded, expandedDirectoryPaths],
  );

  const confirmDiscardIfDirty = useCallback(async () => {
    if (!isDirty) {
      return true;
    }

    return requestConfirmation({
      title: "Discard unsaved changes?",
      description:
        "You have unsaved changes in this file. Discarding will lose them — cancel to return and save first.",
      confirmLabel: "Discard changes",
      destructive: true,
    });
  }, [isDirty, requestConfirmation]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!renamingEntry || !renameInputRef.current) {
      return;
    }

    const input = renameInputRef.current;
    const selectionEnd = renameSelectionEnd(
      renamingEntry.name,
      renamingEntry.isDirectory,
    );
    input.focus();
    input.setSelectionRange(0, selectionEnd);
  }, [renamingEntry]);

  const stopRenamingEntry = useCallback(() => {
    setRenamingPath(null);
    setRenameDraft("");
    setRenameSaving(false);
  }, []);

  const copyExplorerEntryToClipboard = useCallback(
    (entry: LocalFileEntry, mode: ExplorerClipboardMode) => {
      const normalizedSourcePath = entry.absolutePath.trim();
      const normalizedWorkspaceId = selectedWorkspaceId?.trim() || "";
      if (!normalizedSourcePath) {
        return false;
      }
      if (mode === "cut") {
        const protectedMessage = protectedWorkspacePathMessage(
          workspaceRootPath,
          normalizedSourcePath,
        );
        if (protectedMessage) {
          closeContextMenu();
          setError(protectedMessage);
          return false;
        }
      }

      const clipboardName =
        entry.name.trim() || getFolderName(normalizedSourcePath);
      explorerClipboardEntry = {
        mode,
        sourcePath: normalizedSourcePath,
        name: clipboardName,
        isDirectory: entry.isDirectory,
        workspaceId: normalizedWorkspaceId,
      };
      if (mode === "copy") {
        setExplorerAttachmentClipboardEntry({
          text: normalizedSourcePath,
          payload: {
            absolutePath: normalizedSourcePath,
            name: clipboardName,
            size: Number.isFinite(entry.size) ? Math.max(0, entry.size) : 0,
            mimeType: entry.isDirectory ? "inode/directory" : null,
            kind: entry.isDirectory
              ? "folder"
              : inferDraggedAttachmentKind(clipboardName),
          },
        });
      } else {
        clearExplorerAttachmentClipboardEntry();
      }
      void window.electronAPI.clipboard
        .writeText(normalizedSourcePath)
        .catch(() => undefined);
      closeContextMenu();
      setError("");
      return true;
    },
    [closeContextMenu, selectedWorkspaceId, workspaceRootPath],
  );

  useEffect(() => {
    const watchedPath = preview?.absolutePath?.trim() || "";
    if (!previewInPane || !watchedPath) {
      return;
    }

    let cancelled = false;
    let subscriptionId = "";
    let refreshInFlight = false;

    const refreshPreviewFromDisk = async () => {
      if (
        cancelled ||
        refreshInFlight ||
        isDirtyRef.current ||
        isSavingRef.current
      ) {
        return;
      }

      refreshInFlight = true;
      try {
        const { allowed, targetPath: validatedWatchedPath } =
          await validateWorkspaceScopedTargetPath(watchedPath);
        if (!allowed || !validatedWatchedPath) {
          resetPreviewState();
          setSelectedPath((current) =>
            normalizeComparablePath(current) ===
            normalizeComparablePath(watchedPath)
              ? ""
              : current,
          );
          return;
        }
        const nextPreview = await window.electronAPI.fs.readFilePreview(
          validatedWatchedPath,
          selectedWorkspaceId ?? null,
        );
        if (cancelled) {
          return;
        }
        setPreview(nextPreview);
        setPreviewDraft(nextPreview.content ?? "");
        setTablePreviewDraft(cloneTablePreviewSheets(nextPreview.tableSheets));
      } catch (cause) {
        if (!cancelled && isMissingFilePreviewError(cause)) {
          resetPreviewState();
          setSelectedPath((current) =>
            normalizeComparablePath(current) ===
            normalizeComparablePath(watchedPath)
              ? ""
              : current,
          );
          return;
        }
        // The agent may still be writing or replacing the file; wait for the next event.
      } finally {
        refreshInFlight = false;
      }
    };

    const unsubscribe = window.electronAPI.fs.onFileChange((payload) => {
      if (
        normalizeComparablePath(payload.absolutePath) !==
        normalizeComparablePath(watchedPath)
      ) {
        return;
      }
      void refreshPreviewFromDisk();
    });

    void (async () => {
      const { allowed, targetPath: validatedWatchedPath } =
        await validateWorkspaceScopedTargetPath(watchedPath);
      if (!allowed || !validatedWatchedPath) {
        resetPreviewState();
        setSelectedPath((current) =>
          normalizeComparablePath(current) ===
          normalizeComparablePath(watchedPath)
            ? ""
            : current,
        );
        return;
      }
      const subscription = await window.electronAPI.fs.watchFile(
        validatedWatchedPath,
        selectedWorkspaceId ?? null,
      );
      if (cancelled) {
        void window.electronAPI.fs.unwatchFile(subscription.subscriptionId);
        return;
      }
      subscriptionId = subscription.subscriptionId;
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
      if (subscriptionId) {
        void window.electronAPI.fs.unwatchFile(subscriptionId);
      }
    };
  }, [
    preview?.absolutePath,
    previewInPane,
    resetPreviewState,
    selectedWorkspaceId,
    validateWorkspaceScopedTargetPath,
  ]);

  const startRenamingEntry = useCallback(
    (entry: LocalFileEntry) => {
      const protectedMessage = protectedWorkspacePathMessage(
        workspaceRootPath,
        entry.absolutePath,
      );
      if (protectedMessage) {
        closeContextMenu();
        setError(protectedMessage);
        return;
      }
      closeContextMenu();
      setError("");
      setSelectedPath(entry.absolutePath);
      setRenamingPath(entry.absolutePath);
      setRenameDraft(entry.name);
    },
    [closeContextMenu, workspaceRootPath],
  );

  const openFilePreview = async (
    targetPath: string,
    options?: { skipConfirm?: boolean },
  ) => {
    const workspaceSessionKey = workspaceSessionKeyRef.current;
    const requestKey = ++previewRequestKeyRef.current;
    const { allowed, targetPath: validatedTargetPath } =
      await validateWorkspaceScopedTargetPath(targetPath);
    if (
      workspaceSessionKey !== workspaceSessionKeyRef.current ||
      requestKey !== previewRequestKeyRef.current ||
      !allowed ||
      !validatedTargetPath
    ) {
      if (!allowed || !validatedTargetPath) {
        resetPreviewState();
        setSelectedPath((current) =>
          normalizeComparablePath(current) ===
          normalizeComparablePath(targetPath)
            ? ""
            : current,
        );
      }
      return;
    }

    const skipConfirm = options?.skipConfirm ?? false;
    if (!skipConfirm && !(await confirmDiscardIfDirty())) {
      return;
    }

    await revealPathInTree(validatedTargetPath);

    setSelectedPath(validatedTargetPath);
    setPreviewLoading(true);
    setPreviewError("");
    setActiveTableSheetIndex(0);

    try {
      const payload = await window.electronAPI.fs.readFilePreview(
        validatedTargetPath,
        selectedWorkspaceId ?? null,
      );
      if (
        workspaceSessionKey !== workspaceSessionKeyRef.current ||
        requestKey !== previewRequestKeyRef.current
      ) {
        return;
      }
      setPreview(payload);
      setPreviewDraft(payload.content ?? "");
      setTablePreviewDraft(cloneTablePreviewSheets(payload.tableSheets));
      const prefersRenderedTextPreview =
        isMarkdownPreviewPayload(payload) || isHtmlPreviewPayload(payload);
      setTextPreviewMode(prefersRenderedTextPreview ? "preview" : "edit");
    } catch (cause) {
      if (
        workspaceSessionKey !== workspaceSessionKeyRef.current ||
        requestKey !== previewRequestKeyRef.current
      ) {
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Failed to open file.";
      setPreview(null);
      setTextPreviewMode("edit");
      setTablePreviewDraft([]);
      setPreviewError(message);
    } finally {
      if (
        workspaceSessionKey === workspaceSessionKeyRef.current &&
        requestKey === previewRequestKeyRef.current
      ) {
        setPreviewLoading(false);
      }
    }
  };

  const openFileTarget = useCallback(
    async (
      targetPath: string,
      options?: { skipConfirm?: boolean },
    ) => {
      if (previewInPane || !onFileOpen) {
        await openFilePreview(targetPath, options);
        return;
      }

      const { allowed, targetPath: validatedTargetPath } =
        await validateWorkspaceScopedTargetPath(targetPath);
      if (!allowed || !validatedTargetPath) {
        return;
      }

      const skipConfirm = options?.skipConfirm ?? false;
      if (!skipConfirm && !(await confirmDiscardIfDirty())) {
        return;
      }

      await revealPathInTree(validatedTargetPath);

      setSelectedPath(validatedTargetPath);
      resetPreviewState();
      onFileOpen(validatedTargetPath);
    },
    [
      confirmDiscardIfDirty,
      onFileOpen,
      openFilePreview,
      previewInPane,
      resetPreviewState,
      revealPathInTree,
      validateWorkspaceScopedTargetPath,
    ],
  );

  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (renamingPath) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const entryRows = visibleRows.filter(
        (row): row is Extract<FileExplorerVisibleRow, { type: "entry" }> =>
          row.type === "entry",
      );
      if (entryRows.length === 0) return;

      const currentIndex = entryRows.findIndex(
        (row) => row.entry.absolutePath === selectedPath,
      );

      const focus = (index: number) => {
        const clamped = Math.max(0, Math.min(index, entryRows.length - 1));
        setSelectedPath(entryRows[clamped].entry.absolutePath);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focus(currentIndex < 0 ? 0 : currentIndex + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          focus(currentIndex < 0 ? 0 : currentIndex - 1);
          return;
        case "Home":
          event.preventDefault();
          focus(0);
          return;
        case "End":
          event.preventDefault();
          focus(entryRows.length - 1);
          return;
        case "ArrowRight": {
          if (currentIndex < 0) return;
          const row = entryRows[currentIndex];
          if (row.entry.isDirectory) {
            event.preventDefault();
            if (!row.isExpanded) {
              void toggleDirectoryExpansion(row.entry);
              return;
            }
            const child = entryRows[currentIndex + 1];
            if (child && child.depth > row.depth) {
              focus(currentIndex + 1);
            }
          }
          return;
        }
        case "ArrowLeft": {
          if (currentIndex < 0) return;
          const row = entryRows[currentIndex];
          event.preventDefault();
          if (row.entry.isDirectory && row.isExpanded) {
            void toggleDirectoryExpansion(row.entry);
            return;
          }
          for (let i = currentIndex - 1; i >= 0; i -= 1) {
            if (entryRows[i].depth < row.depth) {
              focus(i);
              return;
            }
          }
          return;
        }
        case "Enter": {
          if (currentIndex < 0) return;
          const row = entryRows[currentIndex];
          event.preventDefault();
          if (row.entry.isDirectory) {
            void toggleDirectoryExpansion(row.entry);
          } else if (previewInPane) {
            void openFilePreview(row.entry.absolutePath);
          } else {
            void openFileTarget(row.entry.absolutePath);
          }
          return;
        }
        case "F2": {
          if (currentIndex < 0) return;
          event.preventDefault();
          startRenamingEntry(entryRows[currentIndex].entry);
          return;
        }
        case "Delete":
        case "Backspace": {
          if (currentIndex < 0) return;
          event.preventDefault();
          void deleteEntryRef.current?.(entryRows[currentIndex].entry);
          return;
        }
        default:
          return;
      }
    },
    [
      openFilePreview,
      openFileTarget,
      previewInPane,
      renamingPath,
      selectedPath,
      startRenamingEntry,
      toggleDirectoryExpansion,
      visibleRows,
    ],
  );

  const closePreview = async () => {
    if (!(await confirmDiscardIfDirty())) {
      return;
    }

    resetPreviewState();
  };

  const savePreview = async () => {
    if (!preview?.isEditable) {
      return;
    }

    const workspaceSessionKey = workspaceSessionKeyRef.current;
    const requestKey = ++previewRequestKeyRef.current;
    setSaving(true);
    setPreviewError("");

    try {
      const nextPreview =
        preview.kind === "table"
          ? await window.electronAPI.fs.writeTableFile(
              preview.absolutePath,
              tablePreviewDraft,
              selectedWorkspaceId ?? null,
            )
          : await window.electronAPI.fs.writeTextFile(
              preview.absolutePath,
              previewDraft,
              selectedWorkspaceId ?? null,
            );
      if (
        workspaceSessionKey !== workspaceSessionKeyRef.current ||
        requestKey !== previewRequestKeyRef.current
      ) {
        return;
      }
      setPreview(nextPreview);
      setPreviewDraft(nextPreview.content ?? "");
      setTablePreviewDraft(cloneTablePreviewSheets(nextPreview.tableSheets));
      await loadDirectory(currentPath, false);
    } catch (cause) {
      if (
        workspaceSessionKey !== workspaceSessionKeyRef.current ||
        requestKey !== previewRequestKeyRef.current
      ) {
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Failed to save file.";
      setPreviewError(message);
    } finally {
      if (
        workspaceSessionKey === workspaceSessionKeyRef.current &&
        requestKey === previewRequestKeyRef.current
      ) {
        setSaving(false);
      }
    }
  };

  const previewTableSheets =
    preview?.kind === "table" && Array.isArray(preview.tableSheets)
      ? tablePreviewDraft
      : [];
  const activeTableSheet =
    previewTableSheets.length > 0
      ? previewTableSheets[
          Math.min(activeTableSheetIndex, previewTableSheets.length - 1)
        ]
      : null;
  const showInlinePreview =
    previewInPane &&
    hasVisibleEntryRows &&
    Boolean(preview || previewLoading || previewError);
  const selectedFileEntry =
    !previewInPane && selectedEntry && !selectedEntry.isDirectory
      ? selectedEntry
      : null;
  const bookmarkTargetPath =
    preview?.absolutePath ?? selectedFileEntry?.absolutePath ?? currentPath;
  const bookmarkTargetLabel =
    preview?.name ?? selectedFileEntry?.name ?? getFolderName(currentPath);
  const activeBookmark = fileBookmarks.find(
    (bookmark) => bookmark.targetPath === bookmarkTargetPath,
  );
  const activeBookmarkId =
    preview?.absolutePath ?? selectedFileEntry?.absolutePath ?? currentPath;
  const normalizedQuery = query.trim().toLowerCase();

  const toggleBookmark = async () => {
    if (!bookmarkTargetPath) {
      return;
    }

    if (activeBookmark) {
      await window.electronAPI.fs.removeBookmark(activeBookmark.id);
      return;
    }

    await window.electronAPI.fs.addBookmark(
      bookmarkTargetPath,
      bookmarkTargetLabel,
      selectedWorkspaceId ?? null,
    );
  };

  const openBookmarkedTarget = async (bookmark: FileBookmarkPayload) => {
    if (bookmark.isDirectory) {
      setSelectedPath(bookmark.targetPath);
      if (
        !currentPathRef.current ||
        !isPathWithin(currentPathRef.current, bookmark.targetPath)
      ) {
        await loadDirectory(bookmark.targetPath, true);
        return;
      }

      await revealPathInTree(
        `${bookmark.targetPath}${bookmark.targetPath.includes("\\") ? "\\" : "/"}.__bookmark__`,
      );
      const childEntries = await ensureDirectoryEntriesLoaded(
        bookmark.targetPath,
      );
      if (childEntries !== null) {
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [bookmark.targetPath]: true,
        }));
      }
      return;
    }

    await openFileTarget(bookmark.targetPath, { skipConfirm: false });
  };

  useEffect(() => {
    if (!focusRequest?.path?.trim()) {
      return;
    }
    const request = focusRequest;
    if (lastProcessedFocusRequestKeyRef.current === request.requestKey) {
      return;
    }
    lastProcessedFocusRequestKeyRef.current = request.requestKey;

    let cancelled = false;

    async function openRequestedArtifact() {
      let targetPath = request.path.trim();
      if (!isAbsolutePath(targetPath) && selectedWorkspaceId) {
        const workspaceRoot =
          workspaceRootPath ??
          (await window.electronAPI.workspace.getWorkspaceRoot(
            selectedWorkspaceId,
          ));
        if (cancelled) {
          return;
        }
        if (workspaceRoot) {
          setWorkspaceRootPath(workspaceRoot);
          targetPath = resolveWorkspaceTargetPath(workspaceRoot, targetPath);
        }
      }

      if (cancelled) {
        return;
      }

      try {
        await openFileTarget(targetPath);
      } finally {
        if (!cancelled) {
          onFocusRequestConsumed?.(request.requestKey);
        }
      }
    }

    void openRequestedArtifact();
    return () => {
      cancelled = true;
    };
  }, [
    focusRequest,
    onFocusRequestConsumed,
    openFileTarget,
    selectedWorkspaceId,
    workspaceRootPath,
  ]);

  const referenceEntryInChat = useCallback(
    (entry: LocalFileEntry) => {
      closeContextMenu();
      setSelectedPath(entry.absolutePath);
      setError("");
      onReferenceInChat?.(entry);
    },
    [closeContextMenu, onReferenceInChat],
  );

  const submitRenameEntry = useCallback(async () => {
    if (!renamingEntry || renameInFlightRef.current) {
      return;
    }

    const nextName = renameDraft.trim();
    if (!nextName || nextName === renamingEntry.name) {
      stopRenamingEntry();
      return;
    }

    const sourcePath = renamingEntry.absolutePath;
    const shouldRetargetExternalFile =
      !previewInPane &&
      Boolean(onFileOpen) &&
      normalizeComparablePath(selectedPath) ===
        normalizeComparablePath(sourcePath);

    setError("");
    renameInFlightRef.current = true;
    setRenameSaving(true);
    try {
      const payload = await window.electronAPI.fs.renamePath(
        sourcePath,
        nextName,
        selectedWorkspaceId ?? null,
      );
      const nextAbsolutePath = payload.absolutePath;
      const parentPath =
        getParentFolderPath(sourcePath) ?? currentPathRef.current;
      setDirectoryEntriesByPath((current) =>
        remapDirectoryEntriesByPath(current, sourcePath, nextAbsolutePath),
      );
      setExpandedDirectoryPaths((current) =>
        remapExplorerPathRecord(current, sourcePath, nextAbsolutePath),
      );
      setDirectoryLoadingByPath((current) =>
        remapExplorerPathRecord(current, sourcePath, nextAbsolutePath),
      );
      setDirectoryErrorByPath((current) =>
        remapExplorerPathRecord(current, sourcePath, nextAbsolutePath),
      );
      await refreshDirectoryEntries(parentPath);
      await revealPathInTree(nextAbsolutePath);
      if (explorerClipboardEntry) {
        const remappedClipboardPath = remapPathAfterRename(
          sourcePath,
          nextAbsolutePath,
          explorerClipboardEntry.sourcePath,
        );
        if (
          remappedClipboardPath &&
          remappedClipboardPath !== explorerClipboardEntry.sourcePath
        ) {
          explorerClipboardEntry = {
            ...explorerClipboardEntry,
            sourcePath: remappedClipboardPath,
            name: getFolderName(remappedClipboardPath),
          };
        }
      }
      setSelectedPath(nextAbsolutePath);
      setPreview((current) => {
        if (!current) {
          return current;
        }
        const remappedAbsolutePath = remapPathAfterRename(
          sourcePath,
          nextAbsolutePath,
          current.absolutePath,
        );
        if (
          !remappedAbsolutePath ||
          remappedAbsolutePath === current.absolutePath
        ) {
          return current;
        }
        return {
          ...current,
          absolutePath: remappedAbsolutePath,
          name: getFolderName(remappedAbsolutePath),
        };
      });
      if (shouldRetargetExternalFile) {
        onFileOpen?.(nextAbsolutePath);
      }
      stopRenamingEntry();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Failed to rename item.";
      setError(message);
      window.setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    } finally {
      renameInFlightRef.current = false;
      setRenameSaving(false);
    }
  }, [
    onFileOpen,
    previewInPane,
    renameDraft,
    renamingEntry,
    revealPathInTree,
    refreshDirectoryEntries,
    selectedPath,
    selectedWorkspaceId,
    stopRenamingEntry,
  ]);

  const renameEntryFromContextMenu = useCallback(
    (entry: LocalFileEntry) => {
      startRenamingEntry(entry);
    },
    [startRenamingEntry],
  );

  const cancelRenameEntry = useCallback(() => {
    if (renameInFlightRef.current) {
      return;
    }
    stopRenamingEntry();
  }, [stopRenamingEntry]);

  const createEntry = useCallback(
    async (
      kind: FileSystemCreateKind,
      targetDirectoryPath: string | null | undefined = currentPathRef.current,
    ) => {
      const normalizedTargetDirectoryPath = (targetDirectoryPath ?? "").trim();
      if (!normalizedTargetDirectoryPath || createInFlightRef.current) {
        return;
      }

      closeContextMenu();
      clearActiveDropTargets();
      setError("");
      stopRenamingEntry();
      createInFlightRef.current = true;

      try {
        const payload = await window.electronAPI.fs.createPath(
          normalizedTargetDirectoryPath,
          kind,
          selectedWorkspaceId ?? null,
        );
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [normalizedTargetDirectoryPath]: true,
        }));
        await refreshDirectoryEntries(normalizedTargetDirectoryPath);
        await revealPathInTree(payload.absolutePath);
        setSelectedPath(payload.absolutePath);
        setRenamingPath(payload.absolutePath);
        setRenameDraft(getFolderName(payload.absolutePath));
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to create item.";
        setError(message);
      } finally {
        createInFlightRef.current = false;
      }
    },
    [
      clearActiveDropTargets,
      closeContextMenu,
      refreshDirectoryEntries,
      revealPathInTree,
      selectedWorkspaceId,
      stopRenamingEntry,
    ],
  );

  const importExternalEntriesToDirectory = useCallback(
    async (
      dataTransfer: DataTransfer | null,
      destinationDirectoryPath: string,
    ) => {
      const normalizedDestinationDirectoryPath =
        destinationDirectoryPath.trim();
      if (!normalizedDestinationDirectoryPath || importInFlightRef.current) {
        return;
      }

      closeContextMenu();
      stopRenamingEntry();
      clearActiveDropTargets();
      setError("");
      importInFlightRef.current = true;

      try {
        const importedEntries =
          await collectDroppedExternalEntries(dataTransfer);
        if (importedEntries.length === 0) {
          return;
        }

        const payload = await window.electronAPI.fs.importExternalEntries(
          normalizedDestinationDirectoryPath,
          importedEntries,
          selectedWorkspaceId ?? null,
        );
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [normalizedDestinationDirectoryPath]: true,
        }));

        const refreshTargets = [normalizedDestinationDirectoryPath].filter(
          (targetPath, index, paths) =>
            Boolean(targetPath) &&
            paths.findIndex(
              (candidatePath) =>
                normalizeComparablePath(candidatePath ?? "") ===
                normalizeComparablePath(targetPath ?? ""),
            ) === index,
        ) as string[];
        await Promise.all(
          refreshTargets.map((targetPath) =>
            refreshDirectoryEntries(targetPath),
          ),
        );

        const firstImportedPath = payload.absolutePaths[0] ?? "";
        if (firstImportedPath) {
          await revealPathInTree(firstImportedPath);
          setSelectedPath(firstImportedPath);
        }
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to import items.";
        setError(message);
      } finally {
        importInFlightRef.current = false;
      }
    },
    [
      clearActiveDropTargets,
      closeContextMenu,
      refreshDirectoryEntries,
      revealPathInTree,
      selectedWorkspaceId,
      stopRenamingEntry,
    ],
  );

  const moveEntryToDirectory = useCallback(
    async (sourcePath: string, destinationDirectoryPath: string) => {
      const normalizedSourcePath = sourcePath.trim();
      const normalizedDestinationDirectoryPath =
        destinationDirectoryPath.trim();
      if (
        !normalizedSourcePath ||
        !normalizedDestinationDirectoryPath ||
        moveInFlightRef.current
      ) {
        return false;
      }

      const sourceParentPath = getParentFolderPath(normalizedSourcePath);
      if (!sourceParentPath) {
        return false;
      }
      if (
        normalizeComparablePath(sourceParentPath) ===
        normalizeComparablePath(normalizedDestinationDirectoryPath)
      ) {
        return false;
      }
      const protectedMessage =
        protectedWorkspacePathMessage(
          workspaceRootPath,
          normalizedSourcePath,
        ) ||
        protectedWorkspacePathMessage(
          workspaceRootPath,
          normalizedDestinationDirectoryPath,
        );
      if (protectedMessage) {
        setError(protectedMessage);
        return false;
      }

      const shouldRetargetExternalFile =
        !previewInPane &&
        Boolean(onFileOpen) &&
        normalizeComparablePath(selectedPath) ===
          normalizeComparablePath(normalizedSourcePath);

      clearActiveDropTargets();
      setError("");
      moveInFlightRef.current = true;

      try {
        const payload = await window.electronAPI.fs.movePath(
          normalizedSourcePath,
          normalizedDestinationDirectoryPath,
          selectedWorkspaceId ?? null,
        );
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [normalizedDestinationDirectoryPath]: true,
        }));

        const refreshTargets = [
          sourceParentPath,
          normalizedDestinationDirectoryPath,
        ].filter(
          (targetPath, index, paths) =>
            Boolean(targetPath) &&
            paths.findIndex(
              (candidatePath) =>
                normalizeComparablePath(candidatePath) ===
                normalizeComparablePath(targetPath),
            ) === index,
        );
        await Promise.all(
          refreshTargets.map((targetPath) =>
            refreshDirectoryEntries(targetPath),
          ),
        );
        await revealPathInTree(payload.absolutePath);
        if (explorerClipboardEntry) {
          const remappedClipboardPath = remapPathAfterRename(
            normalizedSourcePath,
            payload.absolutePath,
            explorerClipboardEntry.sourcePath,
          );
          if (
            remappedClipboardPath &&
            remappedClipboardPath !== explorerClipboardEntry.sourcePath
          ) {
            explorerClipboardEntry = {
              ...explorerClipboardEntry,
              sourcePath: remappedClipboardPath,
              name: getFolderName(remappedClipboardPath),
            };
          }
        }

        setSelectedPath(payload.absolutePath);
        setPreview((current) => {
          if (
            !current ||
            normalizeComparablePath(current.absolutePath) !==
              normalizeComparablePath(normalizedSourcePath)
          ) {
            return current;
          }
          return {
            ...current,
            absolutePath: payload.absolutePath,
            name: getFolderName(payload.absolutePath),
          };
        });

        if (shouldRetargetExternalFile) {
          onFileOpen?.(payload.absolutePath);
        }
        return true;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to move item.";
        setError(message);
        return false;
      } finally {
        moveInFlightRef.current = false;
        setDraggedEntryPath(null);
      }
    },
    [
      clearActiveDropTargets,
      onFileOpen,
      previewInPane,
      refreshDirectoryEntries,
      revealPathInTree,
      selectedPath,
      selectedWorkspaceId,
      workspaceRootPath,
    ],
  );

  const pasteExplorerClipboardIntoDirectory = useCallback(
    async (destinationDirectoryPath?: string | null) => {
      const clipboardEntry = explorerClipboardEntry;
      const normalizedDestinationDirectoryPath =
        (destinationDirectoryPath ?? "").trim() ||
        currentPathRef.current.trim();
      if (
        !clipboardEntry ||
        !normalizedDestinationDirectoryPath ||
        pasteInFlightRef.current
      ) {
        return;
      }

      const normalizedWorkspaceId = selectedWorkspaceId?.trim() || "";
      if (clipboardEntry.workspaceId !== normalizedWorkspaceId) {
        setError(
          "Copy, cut, and paste only work within the current workspace.",
        );
        return;
      }

      const protectedMessage = protectedWorkspacePathMessage(
        workspaceRootPath,
        normalizedDestinationDirectoryPath,
      );
      if (protectedMessage) {
        setError(protectedMessage);
        return;
      }

      closeContextMenu();
      stopRenamingEntry();
      clearActiveDropTargets();
      setError("");
      pasteInFlightRef.current = true;

      try {
        if (clipboardEntry.mode === "cut") {
          const moved = await moveEntryToDirectory(
            clipboardEntry.sourcePath,
            normalizedDestinationDirectoryPath,
          );
          if (moved) {
            explorerClipboardEntry = null;
          }
          return;
        }

        const payload = await window.electronAPI.fs.copyPath(
          clipboardEntry.sourcePath,
          normalizedDestinationDirectoryPath,
          selectedWorkspaceId ?? null,
        );
        setExpandedDirectoryPaths((current) => ({
          ...current,
          [normalizedDestinationDirectoryPath]: true,
        }));
        await refreshDirectoryEntries(normalizedDestinationDirectoryPath);
        await revealPathInTree(payload.absolutePath);
        setSelectedPath(payload.absolutePath);
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to paste item.";
        setError(message);
      } finally {
        pasteInFlightRef.current = false;
      }
    },
    [
      clearActiveDropTargets,
      closeContextMenu,
      moveEntryToDirectory,
      refreshDirectoryEntries,
      revealPathInTree,
      selectedWorkspaceId,
      stopRenamingEntry,
      workspaceRootPath,
    ],
  );

  const revealEntryInFolder = useCallback(
    async (entry: LocalFileEntry) => {
      setError("");
      try {
        await window.electronAPI.fs.revealInFolder(
          entry.absolutePath,
          selectedWorkspaceId ?? null,
        );
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : "Failed to reveal in file manager.";
        setError(message);
      }
    },
    [selectedWorkspaceId],
  );

  const revealEntryFromContextMenu = useCallback(
    async (entry: LocalFileEntry) => {
      closeContextMenu();
      await revealEntryInFolder(entry);
    },
    [closeContextMenu, revealEntryInFolder],
  );

  useEffect(() => {
    const isExplorerShortcutTarget = (target: EventTarget | null) => {
      if (renamingPath) {
        return false;
      }

      const container = containerRef.current;
      const focusTarget =
        target instanceof Node ? target : document.activeElement;
      if (!(focusTarget instanceof Node) || !container?.contains(focusTarget)) {
        return false;
      }
      if (isEditableKeyboardTarget(focusTarget)) {
        return false;
      }

      return true;
    };

    const handleClipboardCopy = (
      event: ClipboardEvent,
      mode: ExplorerClipboardMode,
    ) => {
      if (event.defaultPrevented || !isExplorerShortcutTarget(event.target)) {
        return;
      }
      if (!selectedEntry) {
        return;
      }

      if (!copyExplorerEntryToClipboard(selectedEntry, mode)) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", selectedEntry.absolutePath);
    };
    const handleCopy = (event: ClipboardEvent) =>
      handleClipboardCopy(event, "copy");
    const handleCut = (event: ClipboardEvent) =>
      handleClipboardCopy(event, "cut");

    const handleClipboardPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !isExplorerShortcutTarget(event.target)) {
        return;
      }
      if (!creationTargetDirectoryPath) {
        return;
      }

      event.preventDefault();
      void pasteExplorerClipboardIntoDirectory(creationTargetDirectoryPath);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isExplorerShortcutTarget(event.target)) {
        return;
      }

      const primaryModifier = event.metaKey || event.ctrlKey;
      if (!primaryModifier || event.altKey) {
        return;
      }

      const normalizedKey = event.key.trim().toLowerCase();
      if (normalizedKey === "c") {
        if (!selectedEntry) {
          return;
        }
        event.preventDefault();
        copyExplorerEntryToClipboard(selectedEntry, "copy");
        return;
      }
      if (normalizedKey === "x") {
        if (!selectedEntry) {
          return;
        }
        event.preventDefault();
        copyExplorerEntryToClipboard(selectedEntry, "cut");
        return;
      }
      if (normalizedKey === "v") {
        if (!creationTargetDirectoryPath) {
          return;
        }
        event.preventDefault();
        void pasteExplorerClipboardIntoDirectory(creationTargetDirectoryPath);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("copy", handleCopy);
    window.addEventListener("cut", handleCut);
    window.addEventListener("paste", handleClipboardPaste);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("cut", handleCut);
      window.removeEventListener("paste", handleClipboardPaste);
    };
  }, [
    copyExplorerEntryToClipboard,
    creationTargetDirectoryPath,
    pasteExplorerClipboardIntoDirectory,
    renamingPath,
    selectedEntry,
  ]);

  const canMoveDraggedEntryToDirectoryPath = useCallback(
    (targetDirectoryPath: string | null | undefined) => {
      const normalizedDraggedEntryPath = normalizeComparablePath(
        draggedEntryPath ?? "",
      );
      const normalizedTargetPath = normalizeComparablePath(
        targetDirectoryPath ?? "",
      );
      if (!normalizedDraggedEntryPath || !normalizedTargetPath) {
        return false;
      }
      if (normalizedDraggedEntryPath === normalizedTargetPath) {
        return false;
      }
      if (
        isProtectedWorkspacePath(
          workspaceRootPath,
          normalizedDraggedEntryPath,
        ) ||
        isProtectedWorkspacePath(workspaceRootPath, normalizedTargetPath)
      ) {
        return false;
      }

      const draggedEntryParentPath = getParentFolderPath(
        draggedEntryPath ?? "",
      );
      return (
        normalizeComparablePath(draggedEntryParentPath ?? "") !==
        normalizedTargetPath
      );
    },
    [draggedEntryPath, workspaceRootPath],
  );

  const canDropDraggedEntryIntoDirectory = useCallback(
    (entry: LocalFileEntry) => {
      if (!entry.isDirectory) {
        return false;
      }
      return canMoveDraggedEntryToDirectoryPath(entry.absolutePath);
    },
    [canMoveDraggedEntryToDirectoryPath],
  );

  const onPaneDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const canMoveDraggedEntry = canMoveDraggedEntryToDirectoryPath(
        currentPathRef.current,
      );
      const canImportExternalEntries =
        hasExternalExplorerDropData(event.dataTransfer) &&
        Boolean(currentPathRef.current);
      if (!canMoveDraggedEntry && !canImportExternalEntries) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canMoveDraggedEntry ? "move" : "copy";
      setDirectoryDropTargetPath(null);
      if (!paneExternalDropTarget) {
        setPaneExternalDropTarget(true);
      }
    },
    [canMoveDraggedEntryToDirectoryPath, paneExternalDropTarget],
  );

  const onPaneDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!paneExternalDropTarget) {
        return;
      }
      const relatedTarget = event.relatedTarget;
      if (
        typeof Node !== "undefined" &&
        relatedTarget instanceof Node &&
        event.currentTarget.contains(relatedTarget)
      ) {
        return;
      }
      setPaneExternalDropTarget(false);
    },
    [paneExternalDropTarget],
  );

  const onPaneDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const canMoveDraggedEntry = canMoveDraggedEntryToDirectoryPath(
        currentPathRef.current,
      );
      const canImportExternalEntries =
        hasExternalExplorerDropData(event.dataTransfer) &&
        Boolean(currentPathRef.current);
      if (!canMoveDraggedEntry && !canImportExternalEntries) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearActiveDropTargets();
      if (canMoveDraggedEntry && draggedEntryPath) {
        void moveEntryToDirectory(draggedEntryPath, currentPathRef.current);
        return;
      }
      void importExternalEntriesToDirectory(
        event.dataTransfer,
        currentPathRef.current,
      );
    },
    [
      canMoveDraggedEntryToDirectoryPath,
      clearActiveDropTargets,
      draggedEntryPath,
      importExternalEntriesToDirectory,
      moveEntryToDirectory,
    ],
  );

  const deleteEntryFromContextMenu = useCallback(
    async (entry: LocalFileEntry) => {
      closeContextMenu();
      const protectedMessage = protectedWorkspacePathMessage(
        workspaceRootPath,
        entry.absolutePath,
      );
      if (protectedMessage) {
        setError(protectedMessage);
        return;
      }
      const confirmed = await requestConfirmation({
        title: entry.isDirectory
          ? `Delete folder "${entry.name}"?`
          : `Delete file "${entry.name}"?`,
        description: entry.isDirectory
          ? "The folder and all of its contents will be permanently removed. This cannot be undone."
          : "This file will be permanently removed. This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      setError("");
      const normalizedDeletedPath = normalizeComparablePath(entry.absolutePath);
      const normalizedSelectedPath = normalizeComparablePath(selectedPath);
      const normalizedPreviewPath = normalizeComparablePath(
        preview?.absolutePath ?? "",
      );
      const deletedAffectsSelection =
        Boolean(normalizedDeletedPath) &&
        Boolean(normalizedSelectedPath) &&
        isPathWithin(normalizedDeletedPath, normalizedSelectedPath);
      const deletedAffectsPreview =
        Boolean(normalizedDeletedPath) &&
        Boolean(normalizedPreviewPath) &&
        isPathWithin(normalizedDeletedPath, normalizedPreviewPath);
      try {
        await window.electronAPI.fs.deletePath(
          entry.absolutePath,
          selectedWorkspaceId ?? null,
        );
        const parentPath =
          getParentFolderPath(entry.absolutePath) ?? currentPathRef.current;
        await refreshDirectoryEntries(parentPath);
        if (deletedAffectsPreview) {
          resetPreviewState();
        }
        if (deletedAffectsSelection) {
          setSelectedPath("");
        }
        if (
          explorerClipboardEntry &&
          isPathWithin(normalizedDeletedPath, explorerClipboardEntry.sourcePath)
        ) {
          explorerClipboardEntry = null;
        }
        onDeleteEntry?.(entry);
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to delete file.";
        setError(message);
      }
    },
    [
      closeContextMenu,
      onDeleteEntry,
      preview?.absolutePath,
      refreshDirectoryEntries,
      requestConfirmation,
      resetPreviewState,
      selectedPath,
      selectedWorkspaceId,
      workspaceRootPath,
    ],
  );

  useEffect(() => {
    deleteEntryRef.current = deleteEntryFromContextMenu;
  }, [deleteEntryFromContextMenu]);

  const contextMenuPosition = useMemo(() => {
    if (!contextMenu) {
      return null;
    }
    const menuWidth = Math.min(
      196,
      Math.max(160, contextMenu.paneBounds.width - 16),
    );
    const menuHeight = 204;
    return {
      left: Math.max(
        contextMenu.paneBounds.left + 8,
        Math.min(contextMenu.x, contextMenu.paneBounds.right - menuWidth - 8),
      ),
      top: Math.max(
        contextMenu.paneBounds.top + 8,
        Math.min(contextMenu.y, contextMenu.paneBounds.bottom - menuHeight - 8),
      ),
      width: menuWidth,
    };
  }, [contextMenu]);

  const previewFileName = preview?.name || selectedEntry?.name || "Untitled";
  const previewFileIcon = selectedEntry
    ? getExplorerIconDescriptor(previewFileName, selectedEntry.isDirectory)
    : getExplorerIconDescriptor(previewFileName, false);

  const content = showInlinePreview ? (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* File identity header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted">
          <IconifyIcon
            icon={`catppuccin:${previewFileIcon.name}`}
            width={15}
            height={15}
            className="grayscale contrast-125"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {previewFileName}
            </span>
            {isDirty ? (
              <Badge
                variant="outline"
                className="border-warning/30 bg-warning/10 text-warning"
              >
                Unsaved
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {selectedPath ? (
              <span className="truncate">
                {selectedPath.split("/").slice(-2, -1)[0] || ""}/
              </span>
            ) : null}
            {preview?.size != null ? (
              <span className="shrink-0">{formatFileSize(preview.size)}</span>
            ) : null}
            {preview?.modifiedAt ? (
              <>
                <span className="shrink-0 text-border">·</span>
                <span className="shrink-0">
                  {formatModified(preview.modifiedAt)}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {previewLoading ? (
          <div className="grid h-full place-items-center">
            <div className="text-center">
              <Loader2
                size={16}
                className="mx-auto animate-spin text-muted-foreground"
              />
              <div className="mt-2 text-xs text-muted-foreground">
                Loading file...
              </div>
            </div>
          </div>
        ) : previewError ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <div className="text-sm font-medium text-destructive">
                Cannot preview
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {previewError}
              </div>
            </div>
          </div>
        ) : preview?.kind === "text" &&
          preview.extension === ".dashboard" &&
          selectedWorkspaceId ? (
          <DashboardRenderer
            workspaceId={selectedWorkspaceId}
            content={previewDraft}
          />
        ) : preview?.kind === "text" ? (
          isMarkdownPreview && textPreviewMode === "preview" ? (
            <div className="h-full overflow-auto">
              <div className="mx-auto max-w-3xl px-10 py-12">
                {previewDraft.trim() ? (
                  <SimpleMarkdown
                    className="file-preview-markdown"
                    onLinkClick={openPreviewLink}
                    onLocalLinkClick={handleLocalLinkInPreview}
                  >
                    {previewDraft}
                  </SimpleMarkdown>
                ) : (
                  <div className="py-12 text-center text-xs text-muted-foreground">
                    Empty file — switch to Edit to add content.
                  </div>
                )}
              </div>
            </div>
          ) : isHtmlPreview && textPreviewMode === "preview" ? (
            previewDraft.trim() ? (
              <div className="h-full overflow-hidden bg-muted p-4">
                <iframe
                  title={preview.name}
                  sandbox=""
                  srcDoc={previewDraft}
                  className="h-full w-full rounded-lg border border-border bg-white"
                />
              </div>
            ) : (
              <div className="grid h-full place-items-center px-6 text-center">
                <div className="text-xs text-muted-foreground">
                  Empty file — switch to Edit to add markup.
                </div>
              </div>
            )
          ) : (
            <div className="h-full overflow-auto bg-muted">
              <textarea
                aria-label={`Edit ${preview.name}`}
                value={previewDraft}
                onChange={(event) => setPreviewDraft(event.target.value)}
                readOnly={!preview.isEditable}
                spellCheck={false}
                className={`h-full min-h-full w-full resize-none border-0 bg-transparent px-6 py-5 font-mono text-[13px] leading-6 text-foreground outline-none ${
                  preview.isEditable ? "" : "cursor-default opacity-80"
                }`}
              />
            </div>
          )
        ) : preview?.kind === "image" && preview.dataUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
            <img
              src={preview.dataUrl}
              alt={preview.name}
              className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
            />
          </div>
        ) : preview?.kind === "pdf" && preview.dataUrl ? (
          <div className="h-full overflow-hidden">
            <iframe
              src={preview.dataUrl}
              title={preview.name}
              className="h-full w-full border-0"
            />
          </div>
        ) : preview?.kind === "presentation" && preview.presentationSlides ? (
          <PresentationPreview
            name={preview.name}
            slides={preview.presentationSlides}
            slideWidth={preview.presentationWidth}
            slideHeight={preview.presentationHeight}
          />
        ) : preview?.kind === "table" && activeTableSheet ? (
          <SpreadsheetEditor
            sheets={previewTableSheets}
            activeSheetIndex={activeTableSheetIndex}
            onActiveSheetIndexChange={setActiveTableSheetIndex}
            editable={preview.isEditable}
            readOnlyReason={
              activeTableSheet.truncated
                ? "Trimmed previews are read-only"
                : preview.extension === ".xls"
                  ? "Legacy .xls files are read-only"
                  : null
            }
            onChange={setTablePreviewDraft}
            onOpenLinkInBrowser={openPreviewLink}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center rounded-lg border border-border bg-muted px-5 text-center">
            <IconifyIcon
              icon="catppuccin:text"
              width={22}
              height={22}
              className="mb-3 grayscale contrast-125 opacity-60"
            />
            <div className="text-sm font-medium text-foreground">
              Preview unavailable
            </div>
            <div className="mt-2 max-w-xs text-xs leading-6 text-muted-foreground">
              {preview?.unsupportedReason ||
                "This file type is not supported for inline preview yet."}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : (
    <div ref={containerRef} className="flex h-full min-h-0">
      {fileBookmarks.length > 0 ? (
        <aside className="flex w-11 flex-col items-center gap-1.5 border-r border-border py-2.5">
          <div className="chat-scrollbar-hidden flex min-h-0 flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto px-1">
            {fileBookmarks.map((bookmark) => {
              const isActive = activeBookmarkId === bookmark.targetPath;
              const descriptor = getExplorerIconDescriptor(
                bookmark.targetPath,
                bookmark.isDirectory,
              );
              return (
                <button
                  key={bookmark.id}
                  type="button"
                  onClick={() => void openBookmarkedTarget(bookmark)}
                  title={bookmark.label}
                  className={`grid size-7 shrink-0 place-items-center rounded-md transition-colors ${
                    isActive
                      ? "bg-accent text-foreground ring-1 ring-inset ring-primary/30"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <IconifyIcon
                    icon={`catppuccin:${descriptor.name}`}
                    width={15}
                    height={15}
                    className="grayscale contrast-125"
                  />
                </button>
              );
            })}
          </div>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs transition-colors focus-within:border-ring">
              <Search size={12} className="shrink-0 text-muted-foreground" />
              <input
                aria-label="Search files"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="embedded-input min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Search"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Create new item"
                    disabled={!creationTargetDirectoryPath || renameSaving}
                    className="shrink-0 text-muted-foreground"
                  />
                }
              >
                <Plus size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-40">
                <DropdownMenuItem
                  onClick={() =>
                    void createEntry("file", creationTargetDirectoryPath)
                  }
                >
                  New file
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void createEntry("directory", creationTargetDirectoryPath)
                  }
                >
                  New folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant={activeBookmark ? "outline" : "ghost"}
              size="icon-sm"
              aria-label={activeBookmark ? "Remove bookmark" : "Add bookmark"}
              onClick={() => void toggleBookmark()}
              disabled={!bookmarkTargetPath}
              className={`shrink-0 ${
                activeBookmark
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground"
              }`}
            >
              <Star
                size={14}
                className={activeBookmark ? "fill-current" : ""}
              />
            </Button>
          </div>
        </div>

        <div
          role="tree"
          aria-label="Workspace files"
          tabIndex={0}
          aria-activedescendant={
            selectedPath ? getExplorerRowId(selectedPath) : undefined
          }
          onKeyDown={handleTreeKeyDown}
          className={`chat-scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
            paneExternalDropTarget
              ? "rounded-sm ring-1 ring-inset ring-primary/40"
              : ""
          }`}
          onDragOver={onPaneDragOver}
          onDragLeave={onPaneDragLeave}
          onDrop={onPaneDrop}
        >
          {loading ? (
            <div
              className="space-y-0.5"
              role="status"
              aria-label="Loading files"
            >
              {FILE_SKELETON_ROW_WIDTHS.map((width, index) => (
                <div
                  key={index}
                  className="flex items-center gap-1 px-1.5 py-0.5"
                  style={{
                    paddingLeft: `${6 + (index < 2 ? 0 : 12)}px`,
                  }}
                >
                  <div className="size-3.5 shrink-0 rounded-sm bg-muted animate-pulse" />
                  <div
                    className="h-3 rounded-sm bg-muted animate-pulse"
                    style={{
                      width: `${width}%`,
                      animationDelay: `${index * 60}ms`,
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="px-1.5 py-2 text-xs text-destructive">{error}</div>
          ) : null}

          {!loading && !error && visibleRows.length === 0 ? (
            <div className="px-1.5 py-2 text-xs text-muted-foreground">
              No matches.
            </div>
          ) : null}

          {!loading && !error
            ? filteredEntries.map((section, sectionIndex) => (
                <div
                  key={section.id}
                  role="group"
                  aria-label={
                    section.id === "protected"
                      ? "Protected workspace files"
                      : "Workspace files"
                  }
                  className={sectionIndex > 0 ? "mt-1.5 pt-1.5" : ""}
                >
                  {section.rows.map((row) => {
                    if (row.type === "feedback") {
                      return (
                        <div
                          key={row.id}
                          className={`rounded-sm px-1.5 py-1 text-xs ${
                            row.tone === "error"
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                          style={{ paddingLeft: `${6 + row.depth * 12}px` }}
                        >
                          {row.message}
                        </div>
                      );
                    }

                    const { entry, depth, isExpanded, isLoadingChildren } = row;
                    const descriptor = getExplorerIconDescriptor(
                      entry.name,
                      entry.isDirectory,
                      isExpanded,
                    );
                    const entryIsProtected = isProtectedWorkspacePath(
                      workspaceRootPath,
                      entry.absolutePath,
                    );
                    const selected = selectedPath === entry.absolutePath;
                    const isRenaming = renamingPath === entry.absolutePath;
                    const isDirectoryDropTarget =
                      directoryDropTargetPath === entry.absolutePath;
                    const isContextMenuTarget =
                      contextMenu?.entry.absolutePath === entry.absolutePath;
                    const rowHoverActionsClassName = `${
                      selected || isContextMenuTarget
                        ? "opacity-100"
                        : "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                    }`;
                    const rowClassName = `group w-full rounded-sm px-1.5 py-0.5 text-left transition-colors ${
                      selected
                        ? "bg-accent text-foreground"
                        : "text-foreground hover:bg-muted"
                    } ${
                      isDirectoryDropTarget
                        ? "ring-1 ring-inset ring-primary/40"
                        : ""
                    } ${isRenaming ? "cursor-default" : "cursor-pointer"}`;
                    const nameField = isRenaming ? (
                      <input
                        ref={renameInputRef}
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => {
                          void submitRenameEntry();
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void submitRenameEntry();
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenameEntry();
                          }
                        }}
                        disabled={renameSaving}
                        className="embedded-input h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-sm text-foreground outline-none focus:border-ring disabled:opacity-60"
                      />
                    ) : (
                      <span className="truncate text-sm">{entry.name}</span>
                    );
                    const disclosureControl = entry.isDirectory ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleDirectoryExpansion(entry);
                        }}
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={
                          isExpanded ? "Collapse folder" : "Expand folder"
                        }
                      >
                        <ChevronRight
                          size={10}
                          className={`transition-transform duration-150 ${
                            isExpanded ? "rotate-90" : ""
                          } ${isLoadingChildren ? "opacity-60" : ""}`}
                        />
                      </button>
                    ) : (
                      <span className="size-3.5 shrink-0" />
                    );
                    const rowContent = (
                      <span
                        className="flex min-w-0 flex-1 items-center gap-1"
                        style={{ paddingLeft: `${depth * 12}px` }}
                      >
                        {disclosureControl}
                        <FileTreeIcon descriptorName={descriptor.name} />
                        {nameField}
                      </span>
                    );
                    return (
                      <div
                        key={entry.absolutePath}
                        id={getExplorerRowId(entry.absolutePath)}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-selected={selected}
                        aria-expanded={
                          entry.isDirectory ? isExpanded : undefined
                        }
                        aria-label={entry.name}
                        className={rowClassName}
                        title={getExplorerRowTooltip(entry, isExpanded)}
                        onDragOver={(event) => {
                          const canMoveDraggedEntry =
                            canDropDraggedEntryIntoDirectory(entry);
                          const canImportExternalEntries =
                            entry.isDirectory &&
                            hasExternalExplorerDropData(event.dataTransfer);
                          if (
                            !canMoveDraggedEntry &&
                            !canImportExternalEntries
                          ) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = canMoveDraggedEntry
                            ? "move"
                            : "copy";
                          if (paneExternalDropTarget) {
                            setPaneExternalDropTarget(false);
                          }
                          if (directoryDropTargetPath !== entry.absolutePath) {
                            setDirectoryDropTargetPath(entry.absolutePath);
                          }
                        }}
                        onDragLeave={(event) => {
                          if (directoryDropTargetPath !== entry.absolutePath) {
                            return;
                          }
                          const relatedTarget = event.relatedTarget;
                          if (
                            typeof Node !== "undefined" &&
                            relatedTarget instanceof Node &&
                            event.currentTarget.contains(relatedTarget)
                          ) {
                            return;
                          }
                          setDirectoryDropTargetPath(null);
                        }}
                        onDrop={(event) => {
                          const canMoveDraggedEntry =
                            canDropDraggedEntryIntoDirectory(entry);
                          const canImportExternalEntries =
                            entry.isDirectory &&
                            hasExternalExplorerDropData(event.dataTransfer);
                          if (
                            !canMoveDraggedEntry &&
                            !canImportExternalEntries
                          ) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          clearActiveDropTargets();
                          if (canMoveDraggedEntry && draggedEntryPath) {
                            void moveEntryToDirectory(
                              draggedEntryPath,
                              entry.absolutePath,
                            );
                            return;
                          }
                          void importExternalEntriesToDirectory(
                            event.dataTransfer,
                            entry.absolutePath,
                          );
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (isRenaming) {
                            return;
                          }
                          openEntryContextMenu(entry, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        {isRenaming ? (
                          <div className="w-full">{rowContent}</div>
                        ) : (
                          <div className="flex w-full min-w-0 items-center gap-1">
                            <button
                              type="button"
                              draggable={!entryIsProtected}
                              onClick={() => {
                                setSelectedPath(entry.absolutePath);
                                closeContextMenu();
                                if (entry.isDirectory) {
                                  void toggleDirectoryExpansion(entry);
                                  return;
                                }
                                if (!previewInPane) {
                                  void openFileTarget(entry.absolutePath);
                                }
                              }}
                              onDoubleClick={() => {
                                if (!entry.isDirectory && previewInPane) {
                                  void openFilePreview(entry.absolutePath);
                                }
                              }}
                              onDragStart={(event) => {
                                if (entryIsProtected) {
                                  event.preventDefault();
                                  return;
                                }

                                setDraggedEntryPath(entry.absolutePath);
                                clearActiveDropTargets();
                                event.dataTransfer.effectAllowed = "copyMove";
                                event.dataTransfer.setData(
                                  EXPLORER_INTERNAL_MOVE_DRAG_TYPE,
                                  entry.absolutePath,
                                );
                                event.dataTransfer.setData(
                                  EXPLORER_ATTACHMENT_DRAG_TYPE,
                                  serializeExplorerAttachmentDragPayload({
                                    absolutePath: entry.absolutePath,
                                    name: entry.name,
                                    size: Number.isFinite(entry.size)
                                      ? Math.max(0, entry.size)
                                      : 0,
                                    mimeType: entry.isDirectory
                                      ? "inode/directory"
                                      : null,
                                    kind: entry.isDirectory
                                      ? "folder"
                                      : inferDraggedAttachmentKind(entry.name),
                                  }),
                                );
                                const preview =
                                  createAttachmentDragPreview(entry);
                                dragPreviewRef.current?.remove();
                                dragPreviewRef.current = preview;
                                event.dataTransfer.setDragImage(
                                  preview,
                                  18,
                                  18,
                                );
                              }}
                              onDragEnd={() => {
                                setDraggedEntryPath(null);
                                clearActiveDropTargets();
                                dragPreviewRef.current?.remove();
                                dragPreviewRef.current = null;
                              }}
                              className="w-full min-w-0 cursor-pointer text-left"
                              tabIndex={-1}
                            >
                              {rowContent}
                            </button>
                            <div className="flex shrink-0 items-center gap-0.5">
                              {onReferenceInChat ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Attach ${entry.name} to chat`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    referenceEntryInChat(entry);
                                  }}
                                  className={`shrink-0 text-xs font-semibold text-muted-foreground transition-opacity ${rowHoverActionsClassName}`}
                                >
                                  <AtSign size={12} />
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`More actions for ${entry.name}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openEntryContextMenu(entry, {
                                    anchorRect:
                                      event.currentTarget.getBoundingClientRect(),
                                  });
                                }}
                                className={`shrink-0 text-muted-foreground transition-opacity ${rowHoverActionsClassName}`}
                              >
                                <MoreHorizontal size={12} />
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );

  const explorerPane = embedded ? (
    content
  ) : (
    <PaneCard
      title={showInlinePreview ? "File" : ""}
      actions={
        showInlinePreview ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closePreview}
            >
              <ArrowLeft size={12} />
              Files
            </Button>
            <Button
              variant={activeBookmark ? "outline" : "ghost"}
              size="icon-sm"
              aria-label={activeBookmark ? "Remove bookmark" : "Add bookmark"}
              onClick={() => void toggleBookmark()}
              disabled={!bookmarkTargetPath}
              className={
                activeBookmark
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground"
              }
            >
              <Star
                size={12}
                className={activeBookmark ? "fill-current" : ""}
              />
            </Button>
            {supportsRenderedTextPreview ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  setTextPreviewMode(
                    textPreviewMode === "preview" ? "edit" : "preview",
                  )
                }
                aria-label={
                  textPreviewMode === "preview"
                    ? "Switch to edit mode"
                    : "Switch to preview mode"
                }
                title={
                  textPreviewMode === "preview"
                    ? "Previewing — click to edit"
                    : "Editing — click to preview"
                }
                className={
                  textPreviewMode === "preview"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }
              >
                <Eye className="size-3.5" />
              </Button>
            ) : null}
            {preview?.isEditable && (isDirty || saving) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void savePreview()}
                disabled={!isDirty || saving}
              >
                <Save className="size-3.5" />
                {saving ? "Saving" : "Save"}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {content}
    </PaneCard>
  );
  const contextMenuTargetDirectoryPath = contextMenu?.entry.isDirectory
    ? contextMenu.entry.absolutePath
    : contextMenu
      ? (getParentFolderPath(contextMenu.entry.absolutePath) ??
        currentPathRef.current)
      : "";
  const contextMenuEntryIsProtected = isProtectedWorkspacePath(
    workspaceRootPath,
    contextMenu?.entry.absolutePath,
  );
  const contextMenuTargetDirectoryIsProtected = Boolean(
    protectedWorkspacePathMessage(
      workspaceRootPath,
      contextMenuTargetDirectoryPath,
    ),
  );
  const canPasteIntoContextMenuTarget =
    Boolean(explorerClipboardEntry) &&
    Boolean(contextMenuTargetDirectoryPath) &&
    !contextMenuTargetDirectoryIsProtected;
  const desktopPlatform = window.electronAPI?.platform ?? "";
  const revealInFolderLabel =
    desktopPlatform === "darwin"
      ? "Show in Finder"
      : desktopPlatform === "win32"
        ? "Show in Explorer"
        : "Show in File Manager";

  return (
    <>
      {explorerPane}
      <ConfirmDialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open && confirmRequest !== null) {
            handleConfirmResolution(false);
          }
        }}
        title={confirmRequest?.title ?? ""}
        description={confirmRequest?.description}
        confirmLabel={confirmRequest?.confirmLabel}
        destructive={confirmRequest?.destructive}
        onConfirm={() => handleConfirmResolution(true)}
      />
      {contextMenu && contextMenuPosition
        ? createPortal(
            <div
              ref={contextMenuRef}
              role="menu"
              aria-label={`Actions for ${contextMenu.entry.name}`}
              style={contextMenuPosition}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const items = Array.from(
                    contextMenuRef.current?.querySelectorAll<HTMLElement>(
                      '[role="menuitem"]:not([disabled])',
                    ) ?? [],
                  );
                  if (items.length === 0) return;
                  const activeIndex = items.findIndex(
                    (item) => item === document.activeElement,
                  );
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  const nextIndex =
                    activeIndex < 0
                      ? 0
                      : (activeIndex + delta + items.length) % items.length;
                  items[nextIndex].focus();
                }
              }}
              className="fixed z-[80] rounded-xl border border-border bg-popover/92 p-1.5 text-popover-foreground shadow-xl ring-1 ring-border backdrop-blur-xl"
            >
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                onClick={() => {
                  void createEntry("file", contextMenuTargetDirectoryPath);
                }}
                className="w-full justify-start font-normal"
              >
                New file
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                onClick={() => {
                  void createEntry("directory", contextMenuTargetDirectoryPath);
                }}
                className="w-full justify-start font-normal"
              >
                New folder
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                onClick={() => {
                  copyExplorerEntryToClipboard(contextMenu.entry, "copy");
                }}
                className="w-full justify-start font-normal"
              >
                Copy
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                disabled={contextMenuEntryIsProtected}
                onClick={() => {
                  copyExplorerEntryToClipboard(contextMenu.entry, "cut");
                }}
                className="w-full justify-start font-normal"
              >
                Cut
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                disabled={!canPasteIntoContextMenuTarget}
                onClick={() => {
                  void pasteExplorerClipboardIntoDirectory(
                    contextMenuTargetDirectoryPath,
                  );
                }}
                className="w-full justify-start font-normal"
              >
                Paste
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                onClick={() => {
                  void revealEntryFromContextMenu(contextMenu.entry);
                }}
                className="w-full justify-start font-normal"
              >
                {revealInFolderLabel}
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                disabled={contextMenuEntryIsProtected}
                onClick={() => {
                  void renameEntryFromContextMenu(contextMenu.entry);
                }}
                className="w-full justify-start font-normal"
              >
                Rename…
              </Button>
              <Button
                type="button"
                role="menuitem"
                variant="ghost"
                size="default"
                disabled={contextMenuEntryIsProtected}
                onClick={() => {
                  void deleteEntryFromContextMenu(contextMenu.entry);
                }}
                className="w-full justify-start font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Delete…
              </Button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
