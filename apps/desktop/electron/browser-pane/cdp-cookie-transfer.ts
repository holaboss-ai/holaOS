/**
 * Windows-safe cookie transfer for imported Chrome profiles.
 *
 * WHY THIS EXISTS
 * Chrome on Windows (127+) protects its cookie key with **App-Bound Encryption**
 * (v20 cookies), unwrappable only by Chrome running on its ORIGINAL user-data-dir
 * via the elevation service. A raw file copy of the profile (see
 * import-chrome-profile.ts) therefore launches logged-OUT: the relocated Chrome
 * can't unwrap the app-bound key and drops the cookies. macOS has no such thing
 * (its key lives in the Keychain, portable across profile paths), so the copy is
 * enough there.
 *
 * THE FIX (this file)
 * Transfer DECRYPTED cookies over CDP instead of carrying encrypted blobs:
 *   1. Briefly launch the SOURCE Chrome on its own user-data-dir + profile with a
 *      debug port — the one context that CAN decrypt its app-bound cookies — and
 *      read them via Playwright (plaintext).  [captureCookiesFromChromeProfile]
 *   2. Stash them next to the target profile.   [writePendingImportedCookies]
 *   3. On the target profile's next launch, inject them over CDP; the target
 *      Chrome re-encrypts with ITS own key.     [see profileCdpAddCookies + main.ts]
 *
 * Best-effort: any failure (source Chrome open, binary missing, timeout) returns
 * an error string and the caller falls back to the plain copy + a warning. Google
 * specifically also uses device-bound sessions (DBSC) that may still re-challenge;
 * this fixes the general case (Reddit, most sites).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { chromium } from "playwright-core";

/** A cookie in the shape Playwright's `context.addCookies` accepts. */
export interface TransferableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; omitted for session cookies. */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** The subset of Playwright's cookie shape we read. */
export interface PlaywrightCookieLike {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  /** Playwright uses -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Map Playwright cookies onto the transfer shape, dropping already-expired ones
 * (session cookies are KEPT — they carry the live login). Pure + unit-testable.
 */
export function toTransferableCookies(
  cookies: PlaywrightCookieLike[],
  nowUnixSeconds: number,
): TransferableCookie[] {
  const out: TransferableCookie[] = [];
  for (const cookie of cookies) {
    const name = typeof cookie.name === "string" ? cookie.name : "";
    const domain = typeof cookie.domain === "string" ? cookie.domain : "";
    if (!name || !domain) {
      continue;
    }
    const isSession =
      typeof cookie.expires !== "number" || cookie.expires === -1;
    if (
      !isSession &&
      typeof cookie.expires === "number" &&
      cookie.expires <= nowUnixSeconds
    ) {
      continue; // already expired — nothing to carry
    }
    out.push({
      name,
      value: typeof cookie.value === "string" ? cookie.value : "",
      domain,
      path: cookie.path && cookie.path.trim() ? cookie.path : "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(isSession ? {} : { expires: cookie.expires }),
    });
  }
  return out;
}

const CAPTURE_CONNECT_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An OS-assigned free TCP port on loopback. */
async function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : 0;
      server.close(() => {
        port ? resolve(port) : reject(new Error("could not allocate a port"));
      });
    });
  });
}

/** Force-kill a spawned Chrome and its child processes (renderers). */
function killChromeTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Best-effort; a stray temporary Chrome is harmless and exits on its own.
  }
}

export interface CaptureCookiesResult {
  cookies: TransferableCookie[];
  /** null on success; a human-readable reason when nothing was captured. */
  error: string | null;
}

/**
 * Launch the SOURCE Chrome on its own profile with a debug port and read its
 * decrypted cookies. Off-screen + non-headless: headless can skip the elevation
 * service that decrypts app-bound (v20) cookies, so we use a real (but off-screen,
 * 1×1) window and tear it down within seconds.
 *
 * Only works when the source Chrome is CLOSED — a second Chrome on a live
 * user-data-dir forwards to the running instance and exits, so the debug port
 * never opens and we time out (returned as an error for the caller to surface).
 */
export async function captureCookiesFromChromeProfile(opts: {
  /** Absolute path to the source browser's chrome/chromium executable. */
  chromeBinary: string;
  /** The source browser's user-data-dir (parent of the profile dir). */
  sourceUserDataDir: string;
  /** The profile directory NAME under the user-data-dir, e.g. "Default". */
  sourceProfileDirName: string;
  nowUnixSeconds?: number;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}): Promise<CaptureCookiesResult> {
  if (!existsSync(opts.chromeBinary)) {
    return { cookies: [], error: "Source browser executable was not found." };
  }
  if (!existsSync(opts.sourceUserDataDir)) {
    return { cookies: [], error: "Source browser profile folder no longer exists." };
  }

  let port: number;
  try {
    port = await findFreeLoopbackPort();
  } catch (error) {
    return {
      cookies: [],
      error: error instanceof Error ? error.message : "no free debug port",
    };
  }

  const spawnImpl = opts.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  try {
    child = spawnImpl(
      opts.chromeBinary,
      [
        `--user-data-dir=${opts.sourceUserDataDir}`,
        `--profile-directory=${opts.sourceProfileDirName}`,
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-component-update",
        "--window-position=-32000,-32000",
        "--window-size=1,1",
        "about:blank",
      ],
      { detached: false, stdio: "ignore", windowsHide: true },
    );

    const deadline = Date.now() + CAPTURE_CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        // Chrome exited immediately — almost always because the source Chrome is
        // already running and this launch forwarded to it, so no port opened.
        return {
          cookies: [],
          error:
            "The source browser is still open. Close it completely and re-import so its signed-in sessions can be carried over.",
        };
      }
      try {
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
          { timeout: 1500 },
        );
        try {
          const context = browser.contexts()[0];
          const raw = context ? await context.cookies() : [];
          const now =
            opts.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
          return {
            cookies: toTransferableCookies(raw as PlaywrightCookieLike[], now),
            error: null,
          };
        } finally {
          await browser.close().catch(() => undefined);
        }
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    return {
      cookies: [],
      error:
        lastError instanceof Error
          ? `Timed out reading the source profile's cookies (${lastError.message}).`
          : "Timed out reading the source profile's cookies.",
    };
  } catch (error) {
    return {
      cookies: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (child) {
      killChromeTree(child);
    }
  }
}

// --- Pending-cookie handoff (import → next launch) --------------------------
// Capture happens at import (source available); injection happens on the target
// profile's next launch (Chrome up with a debug port). Persist across that gap —
// and across an app restart — as a small JSON sidecar next to the profile dir.

/** Sidecar path: sibling of the profile's chrome/ user-data-dir. */
export function pendingImportedCookiesPath(targetUserDataDir: string): string {
  return path.join(
    path.dirname(targetUserDataDir),
    "pending-imported-cookies.json",
  );
}

export async function writePendingImportedCookies(
  targetUserDataDir: string,
  cookies: TransferableCookie[],
): Promise<void> {
  if (cookies.length === 0) {
    return;
  }
  const file = pendingImportedCookiesPath(targetUserDataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, cookies }, null, 2),
    "utf8",
  );
}

export async function readPendingImportedCookies(
  targetUserDataDir: string,
): Promise<TransferableCookie[]> {
  const file = pendingImportedCookiesPath(targetUserDataDir);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      cookies?: unknown;
    };
    return Array.isArray(parsed.cookies)
      ? (parsed.cookies as TransferableCookie[])
      : [];
  } catch {
    return [];
  }
}

export async function clearPendingImportedCookies(
  targetUserDataDir: string,
): Promise<void> {
  await fs
    .rm(pendingImportedCookiesPath(targetUserDataDir), { force: true })
    .catch(() => undefined);
}
