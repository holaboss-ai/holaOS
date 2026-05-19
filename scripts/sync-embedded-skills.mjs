#!/usr/bin/env node
// Regenerate runtime/harnesses/src/embedded-skills/app-builder-sdk/{sdk-package,reference,ui-package}/
// from the workspace sources at sdk/app-builder-sdk/ and sdk/ui/.
//
// The embedded snapshot ships inside packaged runtimes so SKILL.md's path
// citations stay valid without a repo checkout. Run this whenever you change
// sdk/app-builder-sdk/{src,reference,README*,package.json,tsconfig.json} or
// any sdk/ui source. CI can wire `git diff --exit-code` after this script to
// enforce snapshot freshness.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const skillRoot = path.join(
  repoRoot,
  "runtime",
  "harnesses",
  "src",
  "embedded-skills",
  "app-builder-sdk",
);

// sdk-package: installable @holaboss/app-builder-sdk snapshot agents `bun add
// file:` against. Mirrors sdk/app-builder-sdk/.
const sdkSource = path.join(repoRoot, "sdk", "app-builder-sdk");
const sdkSnapshot = path.join(skillRoot, "sdk-package");

// reference/<shape>/: template apps the agent copies as a starting point.
// Top-level rather than nested under sdk-package so SKILL.md citations are
// short and the prune step doesn't filter them (they live outside test/).
const referenceSnapshot = path.join(skillRoot, "reference");

// ui-package: installable @holaboss/ui snapshot agents `bun add file:`
// against for dashboards. Mirrors sdk/ui/.
const uiSource = path.join(repoRoot, "sdk", "ui");
const uiSnapshot = path.join(skillRoot, "ui-package");

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

function syncSdkPackage() {
  if (!existsSync(sdkSource)) {
    process.stderr.write(`[sync-embedded-skills] sdk source not found: ${sdkSource}\n`);
    process.exit(1);
  }
  // sdk-package/ snapshot: src/ + package.json + README.{md,txt} + tsconfig.json.
  // No test/ — runtime/deploy/prune_packaged_tree.sh strips `test/` dirs at
  // packaging time. No reference/ here either — top-level reference/ covers it.
  rmSync(sdkSnapshot, { recursive: true, force: true });
  mkdirSync(sdkSnapshot, { recursive: true });
  copyTree(path.join(sdkSource, "src"), path.join(sdkSnapshot, "src"));
  copyFile(path.join(sdkSource, "package.json"), path.join(sdkSnapshot, "package.json"));
  copyFile(path.join(sdkSource, "tsconfig.json"), path.join(sdkSnapshot, "tsconfig.json"));
  copyFile(path.join(sdkSource, "README.md"), path.join(sdkSnapshot, "README.md"));
  // .md gets pruned by `*.md ! SKILL.md`; the .txt copy survives packaging.
  const readmeMd = path.join(sdkSource, "README.md");
  if (existsSync(readmeMd)) {
    writeFileSync(
      path.join(sdkSnapshot, "README.txt"),
      readFileSync(readmeMd, "utf8"),
    );
  }
  // Top-level reference/<shape>/ snapshot.
  copyTree(path.join(sdkSource, "reference"), referenceSnapshot);
  log(`synced sdk/app-builder-sdk -> ${sdkSnapshot}`);
}

function syncUiPackage() {
  if (!existsSync(uiSource)) {
    process.stderr.write(`[sync-embedded-skills] ui source not found: ${uiSource}\n`);
    process.exit(1);
  }
  // ui-package/ snapshot: src/ + package.json + tsup.config.ts + tsconfig.json.
  // No test/ or dist/ ship in the embedded snapshot — the installable form
  // builds in the consuming app via the file: dep + bun install.
  rmSync(uiSnapshot, { recursive: true, force: true });
  mkdirSync(uiSnapshot, { recursive: true });
  copyTree(path.join(uiSource, "src"), path.join(uiSnapshot, "src"));
  copyFile(path.join(uiSource, "package.json"), path.join(uiSnapshot, "package.json"));
  copyFile(path.join(uiSource, "tsconfig.json"), path.join(uiSnapshot, "tsconfig.json"));
  copyFile(path.join(uiSource, "tsup.config.ts"), path.join(uiSnapshot, "tsup.config.ts"));
  log(`synced sdk/ui -> ${uiSnapshot}`);
}

syncSdkPackage();
syncUiPackage();
