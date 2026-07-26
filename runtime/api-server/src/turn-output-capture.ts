import fs from "node:fs";
import path from "node:path";

export interface WorkspaceFileManifestEntry {
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface WorkspaceFileManifest {
  entries: Map<string, WorkspaceFileManifestEntry>;
}

export interface CapturedWorkspaceFileOutput {
  filePath: string;
  outputType: string;
  title: string;
  metadata: Record<string, unknown>;
}

const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".holaboss",
  ".npm-cache",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
]);

// Runtime-managed control files, never user deliverables. The runtime rewrites
// them during a turn (MCP registry sync rewrites workspace.yaml, app lifecycle
// rewrites app.runtime.yaml), which bumps their mtime — without this the
// before/after capture diff registers them as outputs and channels attach them.
const SKIP_ROOT_FILE_NAMES = new Set([
  "workspace.yaml",
  "workspace.json",
  "AGENTS.md",
]);

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".m4v",
  ".avi",
  ".mkv",
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".json",
  ".md",
  ".pdf",
  ".rtf",
  ".tex",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx",
  ".yaml",
  ".yml",
]);

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".tsx",
  ".ts",
  ".vue",
]);

const LINK_EXTENSIONS = new Set([
  ".url",
  ".webloc",
]);

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function shouldSkipPath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  if (parts.length === 0) {
    return true;
  }
  if (parts.some((part) => SKIP_DIRECTORY_NAMES.has(part))) {
    return true;
  }
  if (parts.length === 1 && SKIP_ROOT_FILE_NAMES.has(parts[0])) {
    return true;
  }
  if (parts[0] === "apps" && parts.length >= 3 && parts[2] === "data") {
    return true;
  }
  if (parts[0] === "apps" && parts.length === 3 && parts[2] === "app.runtime.yaml") {
    return true;
  }
  return false;
}

function artifactCategoryForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (LINK_EXTENSIONS.has(extension)) {
    return "link";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "code";
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    if (extension === ".csv" || extension === ".tsv" || extension === ".xls" || extension === ".xlsx") {
      return "spreadsheet";
    }
    return "document";
  }
  return "file";
}

function outputTypeForCategory(category: string): string {
  if (category === "document" || category === "spreadsheet" || category === "link") {
    return "document";
  }
  return "file";
}

export function collectWorkspaceFileManifest(workspaceDir: string): WorkspaceFileManifest {
  const entries = new Map<string, WorkspaceFileManifestEntry>();
  const rootDir = path.resolve(workspaceDir);
  if (!fs.existsSync(rootDir)) {
    return { entries };
  }
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(path.relative(workspaceDir, fullPath));
      if (!relativePath || shouldSkipPath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.statSync(fullPath);
      entries.set(relativePath, {
        relativePath,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    }
  }

  return { entries };
}

export function detectWorkspaceFileOutputs(params: {
  workspaceDir: string;
  before: WorkspaceFileManifest;
  maxOutputs?: number;
}): CapturedWorkspaceFileOutput[] {
  const after = collectWorkspaceFileManifest(params.workspaceDir);
  const outputs: CapturedWorkspaceFileOutput[] = [];
  const maxOutputs = Math.max(1, params.maxOutputs ?? 200);

  for (const entry of after.entries.values()) {
    const previous = params.before.entries.get(entry.relativePath) ?? null;
    let changeType: "created" | "modified" | null = null;
    if (!previous) {
      changeType = "created";
    } else if (previous.sizeBytes !== entry.sizeBytes || previous.modifiedMs !== entry.modifiedMs) {
      changeType = "modified";
    }
    if (!changeType) {
      continue;
    }

    const category = artifactCategoryForPath(entry.relativePath);
    outputs.push({
      filePath: entry.relativePath,
      outputType: outputTypeForCategory(category),
      title: path.basename(entry.relativePath),
      metadata: {
        origin_type: "file",
        change_type: changeType,
        category,
        size_bytes: entry.sizeBytes,
        modified_at: new Date(entry.modifiedMs).toISOString(),
      },
    });

    if (outputs.length >= maxOutputs) {
      break;
    }
  }

  outputs.sort((left, right) => {
    const leftChanged = String(left.metadata.change_type);
    const rightChanged = String(right.metadata.change_type);
    if (leftChanged !== rightChanged) {
      return leftChanged === "created" ? -1 : 1;
    }
    return left.filePath.localeCompare(right.filePath);
  });

  return outputs;
}
