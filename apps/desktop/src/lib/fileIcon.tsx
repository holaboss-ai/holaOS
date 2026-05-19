import { Icon as IconifyIcon, addCollection } from "@iconify/react";
import catppuccinCollection from "@iconify-json/catppuccin/icons.json";

// Idempotent — addCollection is a no-op when the prefix is already loaded.
addCollection(catppuccinCollection as Parameters<typeof addCollection>[0]);

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

const SPECIAL_POLICY_FILENAMES = new Set(["agents.md"]);

function comparableFileName(targetName: string): string {
  const normalized = targetName
    .trim()
    .toLowerCase()
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function fileExtension(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  const lastDotIndex = normalized.lastIndexOf(".");
  if (lastDotIndex <= 0) return "";
  return normalized.slice(lastDotIndex);
}

/**
 * Mirrors FileExplorerPane.getExplorerIconDescriptor so internal file
 * tabs and any other surface that needs a file icon stay visually
 * consistent with the explorer. Returns a catppuccin icon name (used
 * as `catppuccin:${name}` with @iconify/react).
 */
export function getFileIconDescriptor(
  targetName: string,
  isDirectory = false,
  isExpanded = false,
): string {
  if (isDirectory) return isExpanded ? "folder-open" : "folder";

  const name = comparableFileName(targetName);
  const ext = fileExtension(name);

  if (name === "package.json") return "npm";
  if (name === "package-lock.json") return "lock";
  if (name === "bun.lockb" || name === "bun.lock") return "bun";
  if (name === "pnpm-lock.yaml") return "pnpm";
  if (name === ".gitignore" || name === ".gitattributes") return "git";
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "config";
  if (name.startsWith(".env")) return "env";
  if (
    SPECIAL_POLICY_FILENAMES.has(name) ||
    name === "readme.md" ||
    name === "readme"
  ) {
    return "readme";
  }
  if (name.endsWith(".lock")) return "lock";

  if (SPREADSHEET_EXTENSIONS.has(ext)) return "csv";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return ext === ".svg" ? "svg" : "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "zip";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (JSON_EXTENSIONS.has(ext)) return "json";

  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".css":
      return "css";
    case ".scss":
    case ".sass":
      return "sass";
    case ".html":
    case ".htm":
      return "html";
    case ".xml":
      return "xml";
    case ".py":
      return "python";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "bash";
    case ".sql":
      return "database";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".php":
      return "php";
    case ".swift":
      return "swift";
    case ".c":
      return "c";
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return "cpp";
    case ".md":
    case ".mdx":
    case ".markdown":
      return "markdown";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".ini":
      return "config";
    default:
      return "text";
  }
}

interface FileTypeIconProps {
  filePath: string;
  isDirectory?: boolean;
  className?: string;
  size?: number;
}

export function FileTypeIcon({
  filePath,
  isDirectory = false,
  className,
  size = 14,
}: FileTypeIconProps) {
  const descriptor = getFileIconDescriptor(filePath, isDirectory);
  return (
    <IconifyIcon
      icon={`catppuccin:${descriptor}`}
      width={size}
      height={size}
      className={className}
    />
  );
}
