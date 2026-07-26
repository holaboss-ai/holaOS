import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function collectWorkspaceSnapshot(workspaceDir: string) {
  const files: Array<Record<string, unknown>> = [];
  const extensionCounts: Record<string, number> = {};
  let totalSize = 0;
  const maxFiles = 5000;
  const skipDirectories = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
  const stack: string[] = [workspaceDir];

  while (stack.length > 0 && files.length < maxFiles) {
    const currentDir = stack.pop() as string;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(workspaceDir, fullPath);
      if (!relativePath) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.statSync(fullPath);
      totalSize += stat.size;
      const extension = path.extname(entry.name).toLowerCase() || "(none)";
      extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
      files.push({
        path: relativePath.split(path.sep).join("/"),
        size: stat.size,
        modified: new Date(stat.mtimeMs).toISOString()
      });
      if (files.length >= maxFiles) {
        break;
      }
    }
  }

  const previews: Record<string, string> = {};
  for (const keyFile of ["workspace.yaml", "README.md", "AGENTS.md", "package.json"]) {
    const fullPath = path.join(workspaceDir, keyFile);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }
    previews[keyFile] = fs.readFileSync(fullPath).subarray(0, 1000).toString("utf8");
  }

  const git: Record<string, unknown> = {};
  if (fs.existsSync(path.join(workspaceDir, ".git"))) {
    try {
      const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workspaceDir,
        encoding: "utf8",
        timeout: 5000
      });
      if (branchResult.status === 0) {
        git.branch = branchResult.stdout.trim();
      }
      const statusResult = spawnSync("git", ["status", "--porcelain"], {
        cwd: workspaceDir,
        encoding: "utf8",
        timeout: 5000
      });
      git.dirty = Boolean(statusResult.stdout.trim());
    } catch {
      // Ignore git inspection failures.
    }
  }

  return {
    file_count: files.length,
    total_size: totalSize,
    files,
    extension_counts: extensionCounts,
    previews,
    git
  };
}
