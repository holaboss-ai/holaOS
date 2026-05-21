import { createWriteStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  resolveRuntimePlatform,
  runtimeBundleDirName,
  runtimeBundleExecutableRelativePaths,
  runtimeBundleRequiredPathGroups
} from "./runtime-bundle.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(scriptDir, "..");
const runtimePlatform = resolveRuntimePlatform();
const stageParentDir = path.join(repoRoot, "out");
const stageDir = path.join(stageParentDir, runtimeBundleDirName(runtimePlatform));
const defaultLocalRuntimeDir = path.join(os.tmpdir(), `holaboss-runtime-${runtimePlatform}-full`);

function log(message) {
  process.stdout.write(`[stage-runtime] ${message}\n`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths) {
  for (const targetPath of paths) {
    if (await pathExists(targetPath)) {
      return targetPath;
    }
  }
  return null;
}

async function ensureCleanStageDir() {
  await fs.rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(stageParentDir, { recursive: true });
}

async function copyRuntimeDirectory(sourceDir) {
  log(`copying runtime directory from ${sourceDir}`);
  // Skip .cache-key during the bulk copy and write it last (after
  // validate) so we never see a stage dir with a matching cache key but
  // missing payload — that's the state that wedges `tryReuseStagedBundle`
  // into a false "cache hit" on the next run.
  await fs.cp(sourceDir, stageDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => path.basename(src) !== ".cache-key",
  });
}

async function syncStageCacheKey(sourceDir) {
  const sourceKeyPath = path.join(sourceDir, ".cache-key");
  try {
    const sourceKey = await fs.readFile(sourceKeyPath, "utf-8");
    await fs.writeFile(path.join(stageDir, ".cache-key"), sourceKey);
  } catch {
    // Source carries no cache key — leave the stage without one so the
    // next run does a full re-stage instead of trusting an unanchored key.
  }
}

async function extractRuntimeTarball(tarballPath) {
  log(`extracting runtime tarball from ${tarballPath}`);
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-runtime-extract-"));
  await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDir]);

  const entries = await fs.readdir(extractDir);
  if (entries.length === 0) {
    throw new Error(`Runtime tarball ${tarballPath} extracted no files.`);
  }

  const rootEntry = entries.length === 1 ? path.join(extractDir, entries[0]) : extractDir;
  const runtimeRoot = (await firstExistingPath(
    runtimeBundleExecutableRelativePaths(runtimePlatform).map((relativePath) => path.join(rootEntry, relativePath))
  ))
    ? rootEntry
    : null;
  if (!runtimeRoot) {
    throw new Error(
      `Runtime tarball ${tarballPath} did not contain a runtime root with ${
        runtimeBundleExecutableRelativePaths(runtimePlatform).join(" or ")
      }.`
    );
  }

  await fs.cp(runtimeRoot, stageDir, { recursive: true, verbatimSymlinks: true });
}

async function downloadRuntimeTarball(url, destinationTarball) {
  log(`downloading runtime tarball from ${url}`);
  const headers = {};
  if (process.env.HOLABOSS_RUNTIME_BUNDLE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.HOLABOSS_RUNTIME_BUNDLE_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download runtime bundle (${response.status} ${response.statusText}).`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationTarball));
}

async function validateStageDir() {
  for (const requiredGroup of runtimeBundleRequiredPathGroups(runtimePlatform)) {
    const matchingPath = await firstExistingPath(
      requiredGroup.map((relativePath) => path.join(stageDir, relativePath))
    );
    if (!matchingPath) {
      throw new Error(
        `Staged runtime is incomplete. Missing ${requiredGroup.join(" or ")} under ${stageDir}.`
      );
    }
  }

  const packageMetadataPath = path.join(stageDir, "package-metadata.json");
  const packageMetadata = JSON.parse(await fs.readFile(packageMetadataPath, "utf-8"));
  const createdAt = packageMetadata.createdAt ?? packageMetadata.created_at ?? "unknown";
  log(`staged runtime ready at ${stageDir} (platform=${packageMetadata.platform}, createdAt=${createdAt})`);
}

// Incremental copy gate: the upstream packager script writes a
// .cache-key into its OUTPUT_ROOT. If our staged copy carries the same
// key already, the underlying ~800MB cp is pointless. Skip and reuse
// the existing stage. Bypass with HOLABOSS_RUNTIME_FORCE_STAGE=1.
async function tryReuseStagedBundle(sourceDir) {
  if (process.env.HOLABOSS_RUNTIME_FORCE_STAGE === "1") {
    return false;
  }
  const sourceKeyPath = path.join(sourceDir, ".cache-key");
  const stageKeyPath = path.join(stageDir, ".cache-key");
  try {
    const [sourceKey, stageKey] = await Promise.all([
      fs.readFile(sourceKeyPath, "utf-8"),
      fs.readFile(stageKeyPath, "utf-8"),
    ]);
    if (sourceKey.trim() === stageKey.trim()) {
      log(`stage cache hit (${sourceKey.trim().slice(0, 12)}…) — skipping copy`);
      return true;
    }
  } catch {
    // Missing key on either side — fall through to a real copy.
  }
  return false;
}

async function stageRuntimeBundle() {
  const runtimeDir = process.env.HOLABOSS_RUNTIME_DIR?.trim();
  const runtimeTarball = process.env.HOLABOSS_RUNTIME_TARBALL?.trim();
  const runtimeBundleUrl = process.env.HOLABOSS_RUNTIME_BUNDLE_URL?.trim();

  // Fast path: when the source is a local dir AND its .cache-key matches
  // our staged copy's .cache-key, we don't need to do anything. Validate
  // the existing stage and return.
  if (runtimeDir && (await tryReuseStagedBundle(path.resolve(runtimeDir)))) {
    await validateStageDir();
    return;
  }

  await ensureCleanStageDir();

  if (runtimeDir) {
    const resolvedRuntimeDir = path.resolve(runtimeDir);
    await copyRuntimeDirectory(resolvedRuntimeDir);
    await validateStageDir();
    await syncStageCacheKey(resolvedRuntimeDir);
    return;
  }

  if (runtimeTarball) {
    await extractRuntimeTarball(path.resolve(runtimeTarball));
    await validateStageDir();
    return;
  }

  if (runtimeBundleUrl) {
    const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-runtime-download-"));
    const downloadPath = path.join(downloadDir, `runtime-${runtimePlatform}.tar.gz`);
    await downloadRuntimeTarball(runtimeBundleUrl, downloadPath);
    await extractRuntimeTarball(downloadPath);
    await validateStageDir();
    return;
  }

  if (existsSync(defaultLocalRuntimeDir)) {
    log(`copying fallback runtime directory from ${defaultLocalRuntimeDir}`);
    await copyRuntimeDirectory(defaultLocalRuntimeDir);
    await validateStageDir();
    await syncStageCacheKey(defaultLocalRuntimeDir);
    return;
  }

  throw new Error(
    "No runtime bundle source found. Set HOLABOSS_RUNTIME_DIR, HOLABOSS_RUNTIME_TARBALL, or HOLABOSS_RUNTIME_BUNDLE_URL, or run npm run prepare:runtime:local first."
  );
}

stageRuntimeBundle().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[stage-runtime] ${message}\n`);
  process.exitCode = 1;
});
