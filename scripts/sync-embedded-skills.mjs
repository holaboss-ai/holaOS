#!/usr/bin/env node
// Regenerate runtime/harnesses/src/embedded-skills/app-builder-sdk/{sdk-package,reference}/
// from the workspace source at sdk/app-builder-sdk/.
//
// The embedded snapshot ships inside packaged runtimes so SKILL.md's path
// citations stay valid without a repo checkout. Run this whenever you change
// sdk/app-builder-sdk/{src,reference,README*,package.json,bun.lock,tsconfig.json}.
// CI can wire `git diff --exit-code` after this script to enforce snapshot freshness.

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(repoRoot, "sdk", "app-builder-sdk");
const snapshotRoot = path.join(
  repoRoot,
  "runtime",
  "harnesses",
  "src",
  "embedded-skills",
  "app-builder-sdk",
  "sdk-package",
);
const referenceSnapshotRoot = path.join(
  repoRoot,
  "runtime",
  "harnesses",
  "src",
  "embedded-skills",
  "app-builder-sdk",
  "reference",
);

function log(message) {
  process.stdout.write(`[sync-embedded-skills] ${message}\n`);
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function copyFile(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
  return true;
}

function main() {
  if (!existsSync(sourceRoot)) {
    process.stderr.write(`[sync-embedded-skills] source not found: ${sourceRoot}\n`);
    process.exit(1);
  }

  // sdk-package/ snapshot: src/ + package.json + README.{md,txt} + tsconfig.json + bun.lock.
  // No test/ — runtime/deploy/prune_packaged_tree.sh strips `test/` dirs at packaging time.
  // No reference/ here either — the top-level reference/ snapshot covers that path.
  rmSync(snapshotRoot, { recursive: true, force: true });
  mkdirSync(snapshotRoot, { recursive: true });

  copyTree(path.join(sourceRoot, "src"), path.join(snapshotRoot, "src"));
  copyFile(path.join(sourceRoot, "package.json"), path.join(snapshotRoot, "package.json"));
  copyFile(path.join(sourceRoot, "tsconfig.json"), path.join(snapshotRoot, "tsconfig.json"));
  copyFile(path.join(sourceRoot, "bun.lock"), path.join(snapshotRoot, "bun.lock"));
  copyFile(path.join(sourceRoot, "README.md"), path.join(snapshotRoot, "README.md"));
  // README.txt is the version that survives prune_packaged_tree.sh's `*.md ! SKILL.md`.
  // Mirror README.md content into README.txt so packaged agents can still read it.
  const readmeMd = path.join(sourceRoot, "README.md");
  if (existsSync(readmeMd)) {
    writeFileSync(path.join(snapshotRoot, "README.txt"), readFileSync(readmeMd, "utf8"));
  }

  // Top-level reference/<shape>/ snapshot — what SKILL.md cites for "copy this as your template".
  copyTree(path.join(sourceRoot, "reference"), referenceSnapshotRoot);

  log(`synced ${sourceRoot} -> ${snapshotRoot} + ${referenceSnapshotRoot}`);
}

main();
