import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRuntimePlatform, runtimeBundleDirName } from "./runtime-bundle.mjs";

// Build-side companion to electron/runtime-archive.ts. Tars the staged
// `out/runtime-<platform>/` tree into a single `out/runtime-windows.tar.gz`
// so the Windows installer ships ONE file instead of ~41k, and the desktop
// extracts it once on first launch. See electron/runtime-archive.ts for the
// runtime side and the "why".
//
// Windows-only by design: macOS/Linux installers copy the app bundle wholesale
// and don't suffer the per-file NSIS extraction cost, so they keep the loose
// tree. Set HOLABOSS_RUNTIME_NO_ARCHIVE=1 to skip archiving (escape hatch: the
// electron-builder config then ships the tree on Windows too).

export const RUNTIME_ARCHIVE_BASENAME = "runtime-windows.tar.gz";

function log(message) {
  process.stdout.write(`[archive-runtime] ${message}\n`);
}

function resolveTarExe() {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const inbox = path.join(systemRoot, "System32", "tar.exe");
    if (existsSync(inbox)) {
      return inbox;
    }
  }
  // GNU tar on the build host (non-Windows cross-build) produces a .tar.gz
  // that bsdtar reads fine on the target.
  return "tar";
}

/**
 * Create `out/runtime-windows.tar.gz` from the staged tree. No-op unless the
 * target platform is Windows and archiving isn't disabled. Returns the archive
 * path (or null when skipped).
 */
export function archiveRuntimeBundle() {
  const runtimePlatform = resolveRuntimePlatform();
  if (runtimePlatform !== "windows") {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(
    (process.env.HOLABOSS_RUNTIME_NO_ARCHIVE || "").trim().toLowerCase(),
  )) {
    log("HOLABOSS_RUNTIME_NO_ARCHIVE set — skipping archive (installer ships the tree)");
    return null;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(scriptDir, "..", "out");
  const stageDir = path.join(outDir, runtimeBundleDirName(runtimePlatform));
  const archivePath = path.join(outDir, RUNTIME_ARCHIVE_BASENAME);

  if (!existsSync(stageDir)) {
    throw new Error(
      `Cannot archive: staged runtime bundle missing at ${stageDir}. Run prepare:runtime:windows first.`,
    );
  }

  const tarExe = resolveTarExe();
  log(`archiving ${stageDir} → ${archivePath} (via ${tarExe})`);
  // `-c -z -f <archive> -C <stageDir> .` — gzip the tree's CONTENTS so the
  // runtime extracts them directly into its target dir (no wrapper folder).
  const result = spawnSync(
    tarExe,
    ["-c", "-z", "-f", archivePath, "-C", stageDir, "."],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (result.error) {
    throw new Error(`tar spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    throw new Error(`tar exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }

  const sizeMb = (statSync(archivePath).size / (1024 * 1024)).toFixed(1);
  log(`archive ready: ${archivePath} (${sizeMb} MB)`);
  return archivePath;
}

// Run when invoked directly (not when imported by stage-runtime-bundle.mjs).
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    archiveRuntimeBundle();
  } catch (error) {
    process.stderr.write(
      `[archive-runtime] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
