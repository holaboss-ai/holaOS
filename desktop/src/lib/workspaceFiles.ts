/**
 * Recursive workspace file walk via the renderer-side `fs.listDirectory`
 * IPC. Returns a flat list of leaf files keyed by relative path, BFS
 * order so shallower files appear first when truncated.
 *
 * Used by the chat composer's `@`-mention picker; could be reused by
 * any surface that needs a quick "name everything in this workspace"
 * snapshot. Bounded by `maxDepth` and `maxFiles` so a very large
 * workspace doesn't choke the caller.
 */

export interface WorkspaceFileEntry {
  /** Filename only (no path). */
  name: string;
  /** Workspace-root-relative path with `/` separators. */
  relativePath: string;
  /** OS-absolute path resolved by the renderer-side fs IPC during the
   *  walk. Surfaces here so callers can hand it directly to
   *  `stageSessionAttachmentPaths` without a second round-trip. */
  absolutePath: string;
}

export interface ListWorkspaceFilesOptions {
  /** Max directory depth to descend. Default 4. Root is depth 0. */
  maxDepth?: number;
  /** Hard cap on returned files. Default 500. */
  maxFiles?: number;
  /** Directory names to skip entirely (tooling clutter). */
  skipDirs?: ReadonlySet<string>;
  /** Abort the walk between IPC calls. Useful when the workspace
   *  changes mid-walk and the caller wants to discard in-flight work. */
  signal?: AbortSignal;
}

const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".turbo",
]);

export async function listWorkspaceFiles(
  workspaceId: string,
  options: ListWorkspaceFilesOptions = {},
): Promise<WorkspaceFileEntry[]> {
  const {
    maxDepth = 4,
    maxFiles = 500,
    skipDirs = DEFAULT_SKIP_DIRS,
    signal,
  } = options;

  const collected: WorkspaceFileEntry[] = [];
  // BFS so the walk yields the most surface-level (most likely to be
  // referenced) files first when truncated by maxFiles.
  const queue: Array<{
    absolutePath: string | null;
    relPath: string;
    depth: number;
  }> = [{ absolutePath: null, relPath: "", depth: 0 }];

  while (queue.length > 0 && collected.length < maxFiles) {
    if (signal?.aborted) return collected;
    const next = queue.shift();
    if (!next) break;

    let response: LocalDirectoryResponse;
    try {
      response = await window.electronAPI.fs.listDirectory(
        next.absolutePath,
        workspaceId,
      );
    } catch {
      continue;
    }

    for (const entry of response.entries) {
      // Skip dotfiles/dotfolders (.git, .holaboss, etc.).
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory && skipDirs.has(entry.name)) continue;

      const relPath = next.relPath
        ? `${next.relPath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory) {
        if (next.depth + 1 < maxDepth) {
          queue.push({
            absolutePath: entry.absolutePath,
            relPath,
            depth: next.depth + 1,
          });
        }
        continue;
      }

      collected.push({
        name: entry.name,
        relativePath: relPath,
        absolutePath: entry.absolutePath,
      });
      if (collected.length >= maxFiles) break;
    }
  }

  // Stable sort: shallower paths first, then alphabetical.
  collected.sort((a, b) => {
    const depthA = a.relativePath.split("/").length;
    const depthB = b.relativePath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return collected;
}
