import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Windows runtime-bundle archive: ship the ~41k-file runtime tree as ONE
 * compressed file and extract it on first launch, instead of letting NSIS
 * write every file individually at install time (each hit by Defender's
 * real-time scan — the cause of the multi-minute Windows install).
 *
 * Build side (scripts/archive-runtime-bundle.mjs) tars `out/runtime-windows/`
 * into `out/<ARCHIVE_BASENAME>`; electron-builder ships that single file into
 * `resources/`. This module (runtime side) extracts it once into a writable,
 * per-user, per-archive location under userData, and returns that path for
 * `resolveRuntimeRoot` to use.
 *
 * macOS/Linux are unaffected: their installers copy the app bundle wholesale
 * (no per-file NSIS extraction), so they keep shipping the loose tree and this
 * helper is a no-op (the archive isn't present).
 */
export const RUNTIME_ARCHIVE_BASENAME = "runtime-windows.tar.gz";

/** File that records which archive produced the current extraction. */
const MARKER_FILENAME = ".archive-marker";

/**
 * Identity of an archive: size + mtime. A rebuilt/updated archive changes at
 * least one, so a stale extraction is detected and redone. Pure + injectable
 * for testing.
 */
export function computeArchiveMarker(
  archivePath: string,
  statFn: (p: string) => { size: number; mtimeMs: number } = statSync,
): string {
  const st = statFn(archivePath);
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

/**
 * Decide whether an existing extraction can be reused. Pure so the branch logic
 * is unit-tested without touching the filesystem.
 */
export function extractionIsCurrent(
  existingMarker: string | null,
  wantMarker: string,
): boolean {
  return existingMarker !== null && existingMarker.trim() === wantMarker;
}

function resolveTarExe(): string {
  // bsdtar ships in-box on Windows 10 1803+; prefer the absolute System32 path
  // so a shadowed `tar` on PATH can't hijack it. Fall back to bare `tar`.
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const inbox = join(systemRoot, "System32", "tar.exe");
  return existsSync(inbox) ? inbox : "tar";
}

function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  const tarExe = resolveTarExe();
  // `-x -f <archive>` auto-detects gzip; `-C <dest>` extracts into dest. The
  // archive is created from the tree's CONTENTS (see the build script), so
  // dest ends up holding bin/, node-runtime/, runtime/, … directly. Async
  // spawn so the one-time first-launch extraction never blocks the main thread.
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tarExe, ["-x", "-f", archivePath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new Error(`tar spawn failed: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim();
        reject(new Error(`tar exited ${code}${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

export interface EnsureExtractedOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** process.resourcesPath — where the shipped archive lives. */
  resourcesPath: string;
  /** app.getPath("userData") — a writable, per-user location. */
  userDataDir: string;
  /** e.g. "runtime-windows". */
  bundleDirName: string;
  /** Optional structured logger; console by default. */
  log?: (message: string) => void;
}

/**
 * Ensure the Windows runtime archive is extracted and return the extracted
 * root, or null when the archive approach doesn't apply (non-Windows, dev, or a
 * build that still ships the loose tree). Callers fall back to their existing
 * resolution when null is returned, so this is strictly additive.
 *
 * Extraction is idempotent (marker-gated), atomic (temp dir + rename), and
 * self-healing (a partial/failed extraction leaves no marker, so the next
 * launch redoes it).
 */
export async function ensureExtractedWindowsRuntime(
  opts: EnsureExtractedOptions,
): Promise<string | null> {
  const log = opts.log ?? ((m: string) => console.info(`[runtime-archive] ${m}`));
  if (opts.platform !== "win32" || !opts.isPackaged) {
    return null;
  }
  const archivePath = join(opts.resourcesPath, RUNTIME_ARCHIVE_BASENAME);
  if (!existsSync(archivePath)) {
    // This build shipped the loose tree — nothing to extract.
    return null;
  }

  const target = join(opts.userDataDir, opts.bundleDirName);
  const markerPath = join(target, MARKER_FILENAME);
  const wantMarker = computeArchiveMarker(archivePath);

  let existingMarker: string | null = null;
  try {
    existingMarker = existsSync(markerPath)
      ? readFileSync(markerPath, "utf8")
      : null;
  } catch {
    existingMarker = null;
  }
  if (extractionIsCurrent(existingMarker, wantMarker)) {
    return target;
  }

  log(`extracting runtime bundle → ${target}`);
  mkdirSync(opts.userDataDir, { recursive: true });
  const tmpDir = mkdtempSync(join(opts.userDataDir, ".runtime-extract-"));
  try {
    await extractTarGz(archivePath, tmpDir);
    // Atomic swap: replace any prior extraction, then move the fresh tree into
    // place, then write the marker last so a crash mid-swap re-extracts.
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(tmpDir, target);
    writeFileSync(markerPath, wantMarker, "utf8");
    log("runtime bundle extracted");
    return target;
  } catch (error) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    log(
      `extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Return null so the caller falls back to any loose tree / surfaces its
    // own "runtime missing" error rather than us throwing on the launch path.
    return null;
  }
}
