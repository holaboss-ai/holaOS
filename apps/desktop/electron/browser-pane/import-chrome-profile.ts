/**
 * Seed a first-class Browser Profile's real-Chrome user-data-dir from an
 * installed Chromium-family profile (Chrome / Chromium / Arc).
 *
 * Each profile launches a genuine Chrome process (`--user-data-dir=<dir>/chrome`,
 * see main.ts `launchProfileChromium`), NOT the Electron `persist:` partition the
 * old workspace import wrote to. So importing here is a **native profile
 * directory copy**: cookies, logins, bookmarks, extensions and site data all
 * carry over in Chrome's own on-disk format — no per-record translation.
 *
 * macOS decryption note: Chromium cookies/passwords are encrypted with a key in
 * the login Keychain ("<Family> Safe Storage"), NOT in the copied files. They
 * therefore decrypt only when the profile is launched with the SAME browser
 * family it was imported from (main.ts picks the binary from `importedFrom`).
 * `Local State` (copied too) additionally carries the Windows/DPAPI key + prefs.
 *
 * Leaf-level (only node:fs/node:path) so the skip policy is unit-testable.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Volatile / rebuildable directories skipped during the copy (matched by
 * basename). Keeps the import fast and avoids dragging hundreds of MB of caches;
 * everything that carries identity/state (Cookies, Login Data, Local Storage,
 * IndexedDB, Extensions, Preferences, History, Bookmarks) is preserved.
 */
export const CHROME_PROFILE_COPY_SKIP_DIRS: ReadonlySet<string> = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "component_crx_cache",
  "optimization_guide_model_store",
  "Service Worker",
  "blob_storage",
]);

/** True when a profile entry (by basename) is a skippable cache directory. */
export function shouldSkipChromeProfileEntry(basename: string): boolean {
  return CHROME_PROFILE_COPY_SKIP_DIRS.has(basename);
}

export interface ChromeProfileCopyResult {
  /** Whether the source `Local State` (encryption key + prefs) was copied. */
  copiedLocalState: boolean;
  /** Absolute path of the seeded `Default` profile directory. */
  targetProfileDir: string;
  /**
   * Source files that were locked (EBUSY/EPERM/EACCES) and therefore skipped.
   * A RUNNING source browser holds exclusive locks on its SQLite DBs (Cookies,
   * History, Web Data, Login Data), so a non-empty list ⇒ the browser is open
   * and the import is incomplete — the caller should tell the user to close it.
   */
  skippedLockedFiles: string[];
}

/** OS lock/permission codes a running browser produces on its profile files. */
const LOCKED_FILE_ERROR_CODES: ReadonlySet<string> = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
]);

function isLockedFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && LOCKED_FILE_ERROR_CODES.has(code);
}

/**
 * Recursively copy `src` → `dest`, skipping cache subtrees (by basename) and any
 * file the OS reports as locked — instead of aborting the whole copy the way
 * `fs.cp` does on the first `EBUSY`. Only regular files and directories are
 * copied (Chrome's Singleton* symlinks/sockets are skipped). Locked source files
 * are appended to `lockedFiles` so the caller can report them.
 */
async function copyProfileTreeResilient(
  src: string,
  dest: string,
  lockedFiles: string[],
): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (shouldSkipChromeProfileEntry(entry.name)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyProfileTreeResilient(from, to, lockedFiles);
    } else if (entry.isFile()) {
      try {
        await fs.copyFile(from, to);
      } catch (error) {
        if (isLockedFileError(error)) {
          lockedFiles.push(from);
        } else {
          throw error;
        }
      }
    }
  }
}

/**
 * Copy a source Chromium profile directory into a target user-data-dir as its
 * `Default` profile, plus the sibling `Local State`. Skips cache directories.
 * The launched Chrome (pointed at `targetUserDataDir`) then reads it natively.
 */
export async function copyChromiumProfileIntoUserDataDir(opts: {
  /** Source profile dir, e.g. `.../Google/Chrome/Default`. */
  sourceProfileDir: string;
  /** Target Chrome `--user-data-dir`, e.g. `<storage>/chrome`. */
  targetUserDataDir: string;
}): Promise<ChromeProfileCopyResult> {
  const sourceProfileDir = opts.sourceProfileDir.trim();
  const targetUserDataDir = opts.targetUserDataDir.trim();
  if (!sourceProfileDir || !existsSync(sourceProfileDir)) {
    throw new Error("The selected browser profile folder no longer exists.");
  }

  const targetProfileDir = path.join(targetUserDataDir, "Default");
  await fs.mkdir(targetProfileDir, { recursive: true });

  // Resilient (per-file) copy: a running source browser locks its SQLite DBs,
  // and `fs.cp` would abort the entire import on the first EBUSY. Skip locked
  // files instead and report them so the caller can ask the user to close it.
  const skippedLockedFiles: string[] = [];
  await copyProfileTreeResilient(
    sourceProfileDir,
    targetProfileDir,
    skippedLockedFiles,
  );

  // `Local State` lives at the user-data-dir root (parent of the profile dir).
  const sourceLocalState = path.join(
    path.dirname(sourceProfileDir),
    "Local State",
  );
  let copiedLocalState = false;
  if (existsSync(sourceLocalState)) {
    try {
      await fs.copyFile(
        sourceLocalState,
        path.join(targetUserDataDir, "Local State"),
      );
      copiedLocalState = true;
    } catch (error) {
      if (isLockedFileError(error)) {
        skippedLockedFiles.push(sourceLocalState);
      } else {
        throw error;
      }
    }
  }

  return { copiedLocalState, targetProfileDir, skippedLockedFiles };
}
