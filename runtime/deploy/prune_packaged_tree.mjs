#!/usr/bin/env node

import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE_SUFFIXES_TO_PRUNE = [
  ".d.ts",
  ".d.cts",
  ".d.mts",
  ".map",
  ".md",
  ".markdown",
  ".c",
  ".pdb",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tsbuildinfo",
  ".exp",
  ".lib"
];

const DIRECTORY_NAMES_TO_PRUNE = new Set([
  ".github",
  ".vscode",
  "__tests__",
  "test",
  "tests",
  "example",
  "examples",
  "website",
  "coverage",
  "benchmark",
  "benchmarks"
]);

const DOC_DIRECTORY_NAMES = new Set(["doc", "docs"]);

const KOFFI_PREFIXES_TO_KEEP = {
  macos: new Set(["darwin_"]),
  linux: new Set(["linux_", "musl_"]),
  windows: new Set(["win32_"])
};

function countFiles(rootPath) {
  const stats = lstatSync(rootPath);
  if (!stats.isDirectory()) {
    return 1;
  }

  let count = 0;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    count += countFiles(path.join(rootPath, entry.name));
  }
  return count;
}

function isEmbeddedSkillSupportPath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.includes("/embedded-skills/");
}

function shouldPruneFile(filePath) {
  const fileName = path.basename(filePath);
  if (fileName === "SKILL.md") {
    return false;
  }
  if (isEmbeddedSkillSupportPath(filePath) && (fileName.endsWith(".md") || fileName.endsWith(".markdown"))) {
    return false;
  }
  return FILE_SUFFIXES_TO_PRUNE.some((suffix) => fileName.endsWith(suffix));
}

function pruneCommonRuntimeFiles(rootPath, insideNodeModules = false) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nextInsideNodeModules = insideNodeModules || entry.name === "node_modules";
      if (DIRECTORY_NAMES_TO_PRUNE.has(entry.name)) {
        rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      if (DOC_DIRECTORY_NAMES.has(entry.name) && !insideNodeModules) {
        rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      pruneCommonRuntimeFiles(entryPath, nextInsideNodeModules);
      continue;
    }

    if (entry.isFile() && shouldPruneFile(entryPath)) {
      rmSync(entryPath, { force: true });
    }
  }
}

function pruneKoffiBinaries(rootPath, targetPlatform) {
  const keepPrefixes = KOFFI_PREFIXES_TO_KEEP[targetPlatform];
  if (!keepPrefixes) {
    return;
  }

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }

    if (
      path.basename(rootPath) === "koffi" &&
      path.basename(path.dirname(rootPath)) === "build" &&
      path.basename(path.dirname(path.dirname(rootPath))) === "koffi" &&
      path.basename(path.dirname(path.dirname(path.dirname(rootPath)))) === "node_modules"
    ) {
      if (![...keepPrefixes].some((prefix) => entry.name.startsWith(prefix))) {
        rmSync(entryPath, { recursive: true, force: true });
      }
      continue;
    }

    pruneKoffiBinaries(entryPath, targetPlatform);
  }
}

function pruneNodePackageBinaryMirrors(rootPath) {
  const nodePackageDir = path.join(rootPath, "node_modules", "node");
  const nodeBinDir = path.join(nodePackageDir, "bin");
  if (!hasAnyNodeExecutable(nodeBinDir)) {
    return;
  }

  const nodePackageModulesDir = path.join(nodePackageDir, "node_modules");
  let entries;
  try {
    entries = readdirSync(nodePackageModulesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".bin") {
      rmSync(path.join(nodePackageModulesDir, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!entry.name.startsWith("node-bin-")) {
      continue;
    }
    rmSync(path.join(nodePackageModulesDir, entry.name), { recursive: true, force: true });
  }
}

function pruneDanglingSymlinks(rootPath) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        statSync(entryPath);
      } catch {
        rmSync(entryPath, { force: true });
      }
      continue;
    }
    if (entry.isDirectory()) {
      pruneDanglingSymlinks(entryPath);
    }
  }
}

function hasAnyNodeExecutable(nodeBinDir) {
  try {
    for (const entry of readdirSync(nodeBinDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name === "node" || entry.name === "node.exe")) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function prunePackagedTree(targetRoot, targetPlatform = "") {
  const resolvedRoot = path.resolve(targetRoot);
  let beforeCount = 0;
  try {
    beforeCount = countFiles(resolvedRoot);
  } catch {
    return;
  }

  pruneCommonRuntimeFiles(resolvedRoot);
  pruneNodePackageBinaryMirrors(resolvedRoot);
  if (targetPlatform) {
    pruneKoffiBinaries(resolvedRoot, targetPlatform);
  }
  pruneDanglingSymlinks(resolvedRoot);
  const afterCount = countFiles(resolvedRoot);
  console.error(`pruned packaged tree at ${resolvedRoot} (${beforeCount} -> ${afterCount} files)`);
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const targetRoot = process.argv[2];
  const targetPlatform = process.argv[3] ?? "";
  if (!targetRoot) {
    console.error("usage: prune_packaged_tree.mjs <target-root> [platform]");
    process.exit(1);
  }
  prunePackagedTree(targetRoot, targetPlatform);
}
