import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prunePackagedTree } from "./prune_packaged_tree.mjs";

test("prunePackagedTree preserves skill markdown while pruning other markdown files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-prune-packaged-tree-"));
  const skillDir = path.join(root, "runtime", "harnesses", "src", "embedded-skills", "skill-creator");
  const referenceDir = path.join(skillDir, "references");
  const docsDir = path.join(root, "runtime", "docs");
  const readmePath = path.join(root, "runtime", "README.md");
  const skillPath = path.join(skillDir, "SKILL.md");
  const referencePath = path.join(referenceDir, "integration-backed-apps.md");
  const docsPath = path.join(docsDir, "guide.md");

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(referenceDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(skillPath, "---\nname: skill-creator\ndescription: Skill creator\n---\n", "utf8");
    fs.writeFileSync(referencePath, "# Integration-backed apps\n", "utf8");
    fs.writeFileSync(readmePath, "# Runtime\n", "utf8");
    fs.writeFileSync(docsPath, "# Guide\n", "utf8");

    prunePackagedTree(root, "macos");

    assert.equal(fs.existsSync(skillPath), true);
    assert.equal(fs.existsSync(referencePath), true);
    assert.equal(fs.existsSync(readmePath), false);
    assert.equal(fs.existsSync(docsPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prunePackagedTree removes packaged-runtime archives, sources, and duplicate node binaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-prune-node-runtime-"));
  const nodePackageDir = path.join(root, "node_modules", "node");
  const nodeBinDir = path.join(nodePackageDir, "bin");
  const topLevelShimDir = path.join(root, "node_modules", ".bin");
  const topLevelNodeShimPath = path.join(topLevelShimDir, "node.cmd");
  const topLevelNpmShimPath = path.join(topLevelShimDir, "npm.cmd");
  const nodePackageShimDir = path.join(nodePackageDir, "node_modules", ".bin");
  const nodePackageShimPath = path.join(nodePackageShimDir, "node");
  const duplicateNodeDir = path.join(nodePackageDir, "node_modules", "node-bin-win-x64", "bin");
  const setupDir = path.join(nodePackageDir, "node_modules", "node-bin-setup");
  const archivePath = path.join(root, "node_modules", "mcporter", "mcporter-0.7.3.tgz");
  const sourcePath = path.join(root, "node_modules", "better-sqlite3", "deps", "sqlite3", "sqlite3.c");
  const binaryPath = path.join(root, "node_modules", "native-module", "binding.node");

  try {
    fs.mkdirSync(nodeBinDir, { recursive: true });
    fs.mkdirSync(topLevelShimDir, { recursive: true });
    fs.mkdirSync(nodePackageShimDir, { recursive: true });
    fs.mkdirSync(duplicateNodeDir, { recursive: true });
    fs.mkdirSync(setupDir, { recursive: true });
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(path.join(nodeBinDir, "node.exe"), "node", "utf8");
    fs.writeFileSync(topLevelNodeShimPath, "node shim", "utf8");
    fs.writeFileSync(topLevelNpmShimPath, "npm shim", "utf8");
    fs.writeFileSync(path.join(duplicateNodeDir, "node.exe"), "duplicate", "utf8");
    try {
      fs.symlinkSync("../node-bin-win-x64/bin/node.exe", nodePackageShimPath);
    } catch {
      fs.writeFileSync(nodePackageShimPath, "node shim", "utf8");
    }
    fs.writeFileSync(path.join(setupDir, "index.js"), "setup", "utf8");
    fs.writeFileSync(archivePath, "archive", "utf8");
    fs.writeFileSync(sourcePath, "source", "utf8");
    fs.writeFileSync(binaryPath, "native", "utf8");

    prunePackagedTree(root, "windows");

    assert.equal(fs.existsSync(path.join(nodeBinDir, "node.exe")), true);
    assert.equal(fs.existsSync(topLevelNodeShimPath), true);
    assert.equal(fs.existsSync(topLevelNpmShimPath), true);
    assert.equal(fs.existsSync(nodePackageShimDir), false);
    assert.equal(fs.existsSync(path.join(nodePackageDir, "node_modules", "node-bin-win-x64")), false);
    assert.equal(fs.existsSync(setupDir), false);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(binaryPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prunePackagedTree keeps node-bin package mirrors until the staged node executable exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-prune-node-runtime-guard-"));
  const duplicateNodePath = path.join(
    root,
    "node_modules",
    "node",
    "node_modules",
    "node-bin-win-x64",
    "bin",
    "node.exe",
  );

  try {
    fs.mkdirSync(path.dirname(duplicateNodePath), { recursive: true });
    fs.writeFileSync(duplicateNodePath, "duplicate", "utf8");

    prunePackagedTree(root, "windows");

    assert.equal(fs.existsSync(duplicateNodePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prunePackagedTree removes dangling symlinks left behind by file pruning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-prune-dangling-links-"));
  const realDistDir = path.join(root, "runtime", "state-store", "dist");
  const linkedDistDir = path.join(
    root,
    "runtime",
    "api-server",
    "node_modules",
    "@holaboss",
    "runtime-state-store",
    "dist",
  );
  const liveTargetPath = path.join(realDistDir, "index.mjs");
  const prunedTargetPath = path.join(realDistDir, "index.d.ts");
  const liveLinkPath = path.join(linkedDistDir, "index.mjs");
  const prunedLinkPath = path.join(linkedDistDir, "index.d.ts");

  try {
    fs.mkdirSync(realDistDir, { recursive: true });
    fs.mkdirSync(linkedDistDir, { recursive: true });
    fs.writeFileSync(liveTargetPath, "export {};\n", "utf8");
    fs.writeFileSync(prunedTargetPath, "export {};\n", "utf8");
    fs.symlinkSync(liveTargetPath, liveLinkPath);
    fs.symlinkSync(prunedTargetPath, prunedLinkPath);

    prunePackagedTree(root, "macos");

    assert.equal(fs.existsSync(liveLinkPath), true);
    assert.equal(fs.existsSync(prunedTargetPath), false);
    assert.equal(fs.existsSync(prunedLinkPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
