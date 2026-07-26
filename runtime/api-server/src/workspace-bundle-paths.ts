import fs from "node:fs";
import path from "node:path";

export const WORKSPACE_RUNTIME_DIRNAME = ".holaboss";
export const WORKSPACE_STATE_DIRNAME = "state";
export const WORKSPACE_MEMORY_DIRNAME = "memory";
export const LEGACY_GLOBAL_MEMORY_WORKSPACE_DIRNAME = "workspace";

function ensureDir(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

export function workspaceRuntimeDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), WORKSPACE_RUNTIME_DIRNAME);
}

export function workspaceStateDir(workspaceDir: string): string {
  return path.join(workspaceRuntimeDir(workspaceDir), WORKSPACE_STATE_DIRNAME);
}

export function workspaceMemoryDir(workspaceDir: string): string {
  return path.join(workspaceRuntimeDir(workspaceDir), WORKSPACE_MEMORY_DIRNAME);
}

export function workspaceRuntimeRelativePath(...relativeSegments: string[]): string {
  return path.posix.join(WORKSPACE_RUNTIME_DIRNAME, ...relativeSegments);
}

export function workspaceStateRelativePath(...relativeSegments: string[]): string {
  return path.posix.join(
    WORKSPACE_RUNTIME_DIRNAME,
    WORKSPACE_STATE_DIRNAME,
    ...relativeSegments,
  );
}

export function globalMemoryDirForWorkspaceRoot(workspaceRoot: string): string {
  const configured = (process.env.MEMORY_ROOT_DIR ?? "").trim();
  if (!configured) {
    return path.join(path.dirname(path.resolve(workspaceRoot)), WORKSPACE_MEMORY_DIRNAME);
  }
  if (path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  return path.resolve(path.join(workspaceRoot, configured));
}

export function legacyWorkspaceMemoryDir(params: {
  workspaceRoot: string;
  workspaceId: string;
}): string {
  return path.join(
    globalMemoryDirForWorkspaceRoot(params.workspaceRoot),
    LEGACY_GLOBAL_MEMORY_WORKSPACE_DIRNAME,
    params.workspaceId,
  );
}

export function migrateLegacyWorkspaceMemoryIfNeeded(params: {
  workspaceRoot: string;
  workspaceDir: string;
  workspaceId: string;
}): { migrated: boolean; workspaceMemoryDir: string; globalMemoryDir: string } {
  const nextWorkspaceMemoryDir = workspaceMemoryDir(params.workspaceDir);
  const globalMemoryDir = globalMemoryDirForWorkspaceRoot(params.workspaceRoot);
  const legacyDir = legacyWorkspaceMemoryDir({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
  });

  if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) {
    return { migrated: false, workspaceMemoryDir: nextWorkspaceMemoryDir, globalMemoryDir };
  }

  ensureDir(nextWorkspaceMemoryDir);
  for (const childName of fs.readdirSync(legacyDir)) {
    const sourcePath = path.join(legacyDir, childName);
    const targetPath = path.join(nextWorkspaceMemoryDir, childName);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    fs.renameSync(sourcePath, targetPath);
  }
  if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
  const legacyParent = path.dirname(legacyDir);
  if (fs.existsSync(legacyParent) && fs.statSync(legacyParent).isDirectory() && fs.readdirSync(legacyParent).length === 0) {
    fs.rmSync(legacyParent, { recursive: true, force: true });
  }
  return { migrated: true, workspaceMemoryDir: nextWorkspaceMemoryDir, globalMemoryDir };
}

export function resolveMemoryFilePath(params: {
  workspaceRoot: string;
  workspaceDir: string;
  workspaceId: string;
  relPath: string;
}): string {
  const normalized = params.relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const workspacePrefix = `workspace/${params.workspaceId}/`;
  if (normalized.startsWith(workspacePrefix)) {
    migrateLegacyWorkspaceMemoryIfNeeded({
      workspaceRoot: params.workspaceRoot,
      workspaceDir: params.workspaceDir,
      workspaceId: params.workspaceId,
    });
    return path.join(workspaceMemoryDir(params.workspaceDir), normalized.slice(workspacePrefix.length));
  }
  return path.join(globalMemoryDirForWorkspaceRoot(params.workspaceRoot), normalized);
}

export function workspaceStatePath(workspaceDir: string, ...relativeSegments: string[]): string {
  return path.join(workspaceStateDir(workspaceDir), ...relativeSegments);
}

export function migrateLegacyWorkspaceStatePath(params: {
  workspaceDir: string;
  relativeSegments: string[];
  legacyRelativeSegments: string[];
  isDirectory?: boolean;
}): string {
  const targetPath = workspaceStatePath(params.workspaceDir, ...params.relativeSegments);
  const legacyPath = path.join(path.resolve(params.workspaceDir), ...params.legacyRelativeSegments);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  if (!fs.existsSync(legacyPath)) {
    return targetPath;
  }
  ensureDir(path.dirname(targetPath));
  fs.renameSync(legacyPath, targetPath);
  return targetPath;
}

export function ensureWorkspaceStateDir(workspaceDir: string): string {
  return ensureDir(workspaceStateDir(workspaceDir));
}

export function ensureWorkspaceMemoryDir(workspaceDir: string): string {
  return ensureDir(workspaceMemoryDir(workspaceDir));
}
