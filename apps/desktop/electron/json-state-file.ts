import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Durable read/write for the small JSON state files in userData — browser
 * profiles, fingerprint templates, file bookmarks, the model-catalogue cache.
 *
 * Both halves matter together. The write is atomic so a crash mid-write cannot
 * leave a truncated file; the read quarantines a file that does not parse
 * instead of silently discarding it. Every caller follows a failed read with a
 * write of the fallback, so without the quarantine a single bad parse
 * permanently destroyed the only copy of the user's data.
 */

/**
 * Read JSON, falling back when the file is missing or damaged.
 *
 * A missing file is the normal first-run case and is silent. A file that
 * exists but does not parse is damaged user data: it is renamed to
 * `<name>.corrupt-<timestamp>` before the fallback is returned, so the loss is
 * recoverable and leaves evidence.
 */
export async function readJsonStateFile<T>(
  filePath: string,
  fallback: T,
  options: { log?: (message: string) => void } = {},
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return fallback; // absent (or unreadable) — nothing to preserve
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(filePath, quarantinePath).catch(() => undefined);
    options.log?.(
      `[state] ${path.basename(filePath)} did not parse (${
        error instanceof Error ? error.message : String(error)
      }); preserved at ${path.basename(quarantinePath)}`,
    );
    return fallback;
  }
}

/**
 * Write JSON atomically (temp file + rename), matching the shape already used
 * by writeRuntimeConfigTextAtomically in main.ts.
 *
 * These files are rewritten on every mutation — each browser-profile create,
 * rename, delete, default-pin, fingerprint seed and debug-port assignment — so
 * the truncation window of a plain writeFile is hit far more often than it
 * looks.
 */
export async function writeJsonStateFileAtomically(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // randomUUID, not pid+timestamp: these files are rewritten on every mutation,
  // so two writes to the same path can easily land in the same millisecond of
  // the same process. Sharing a temp made the loser's rename fail with ENOENT
  // and fall into the replace path below — destroying the real file to install
  // a temp that no longer existed.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
  let renamed = false;
  try {
    await fs.rename(tempPath, filePath);
    renamed = true;
  } catch {
    // Windows cannot always rename onto an existing file (an AV scanner or a
    // second process holding a handle). Move the current file aside rather than
    // deleting it: whatever blocks the first rename is unlikely to have cleared
    // microseconds later, and an `rm` + failed retry would leave NO copy at all
    // — the precise loss this function exists to prevent.
    const backupPath = `${filePath}.${randomUUID()}.bak`;
    const movedAside = await fs
      .rename(filePath, backupPath)
      .then(() => true)
      .catch(() => false);
    try {
      await fs.rename(tempPath, filePath);
      renamed = true;
      if (movedAside) {
        await fs.rm(backupPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      // Put the original back before giving up, so a failed write is a no-op
      // rather than a deletion. If even that cannot land — whatever blocks
      // renames onto this path blocks all of them — the backup STAYS on disk
      // and the error names it. The one outcome that must never happen is
      // zero surviving copies.
      if (movedAside) {
        const restored = await fs
          .rename(backupPath, filePath)
          .then(() => true)
          .catch(() => false);
        if (!restored) {
          // `cause` is assigned rather than passed to the constructor: this
          // package's tsconfig lib predates the two-argument Error.
          const failure = new Error(
            `Failed to write ${path.basename(filePath)}; its previous contents are preserved at ${backupPath}`,
          );
          (failure as { cause?: unknown }).cause = error;
          throw failure;
        }
      }
      throw error;
    }
  } finally {
    // Only ever remove the temp we still own. After a successful rename the
    // path is the live file, and `force: true` would happily delete it if the
    // rename were ever reported as failed after the fact.
    if (!renamed) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
