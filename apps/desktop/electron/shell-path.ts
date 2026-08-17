import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * macOS (and Linux) GUI apps launched from Finder/Dock/Spotlight do NOT
 * inherit the user's login-shell PATH — the launching process never sources
 * `~/.zshrc` / `~/.zprofile` / `~/.bash_profile`, so it sees only the minimal
 * system default PATH (roughly `/usr/bin:/bin:/usr/sbin:/sbin`).
 *
 * That breaks CLI-binary discovery for anything we later spawn. In particular
 * the embedded runtime probes for `claude` on PATH
 * (runtime/api-server/src/harness-availability.ts → findOnPath) and the modern
 * Claude Code native installer puts the binary at `~/.local/bin/claude`, adding
 * `~/.local/bin` to PATH *only* via shell rc files. Result: `which claude`
 * resolves fine in a terminal, but the Dock-launched app reports the
 * claude-code harness as unavailable.
 *
 * This is the same technique as sindresorhus/fix-path, vendored here so we
 * don't pull the ESM `execa`/`shell-env` dependency chain into the tsup
 * CommonJS Electron-main bundle. We resolve the login shell's PATH once at
 * startup and merge it into `process.env.PATH`, which the runtime child
 * process then inherits (see the `spawn(...)` in main.ts that passes
 * `{ ...process.env }`).
 *
 * Windows has the SAME symptom via a different mechanism: the Claude Code
 * native installer drops `claude.exe` in `%USERPROFILE%\.local\bin` and adds
 * that dir to PATH only through the *shell* environment (Git Bash rc), not the
 * persistent registry PATH a GUI launch inherits. npm-global CLIs (`codex`,
 * etc.) live in `%APPDATA%\npm`, which likewise isn't always on the registry
 * PATH. So the Dock-equivalent problem is real on Windows too — the runtime
 * probes for `claude` and spawns it, and `spawn` fails with `ENOENT` because
 * those dirs aren't visible. Rather than query a login shell (Windows has no
 * equivalent), we append the well-known per-user install dirs that exist on
 * disk. See {@link computeWindowsSupplementalPath}.
 */

// Unique marker so we can extract PATH cleanly even when rc files print
// banners/noise to stdout during shell init.
const DELIMITER = "__HOLABOSS_SHELL_PATH__";

function defaultLoginShell(): string {
  if (process.env.SHELL) {
    return process.env.SHELL;
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/**
 * Run the user's login shell as an interactive login shell (`-ilc`) so it
 * sources both profile (`.zprofile`/`.bash_profile`/`.profile`) and rc
 * (`.zshrc`/`.bashrc`) files — the native installer may write to either — and
 * print the resulting PATH. Returns null on any failure; this must never throw
 * or block startup beyond the timeout.
 */
function resolveLoginShellPath(): string | null {
  const shell = defaultLoginShell();
  // `printf` is a builtin in zsh/bash/dash and, unlike `echo -n`, prints no
  // stray `-n`. The PATH is emitted between two delimiters.
  const command = `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`;
  try {
    const out = execFileSync(shell, ["-ilc", command], {
      encoding: "utf8",
      timeout: 5_000,
      // Don't attach a tty; swallow stderr (interactive shells often warn
      // "can't access tty; job control turned off").
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TERM: "dumb" },
    });
    const start = out.indexOf(DELIMITER);
    const end = out.lastIndexOf(DELIMITER);
    if (start === -1 || end <= start) {
      return null;
    }
    const value = out.slice(start + DELIMITER.length, end).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Merge two PATH strings, keeping `shellPath` entries first (the user-intended
 * ordering from their shell) and appending any dirs from `currentPath` not
 * already present, so we never drop a directory the GUI process already had.
 * Pure + exported for unit testing.
 */
export function mergePathEntries(
  shellPath: string,
  currentPath: string,
  // Injectable so the Windows branch stays testable off Windows. `;` vs `:`
  // is the whole difference, and joining `C:\\Windows` with a `:` separator
  // makes the drive letter indistinguishable from a separator.
  sep: string = path.delimiter,
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...shellPath.split(sep), ...currentPath.split(sep)]) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(sep);
}

/**
 * Per-user install dirs that a Windows GUI launch does not reliably inherit,
 * because the installers add them to the shell env rather than the persistent
 * registry PATH. Ordered by how commonly external harnesses land there.
 */
function windowsInstallDirCandidates(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA;
  return [
    path.join(home, ".local", "bin"), // Claude Code native installer (claude.exe)
    appData ? path.join(appData, "npm") : "", // npm global bin (codex, …)
    path.join(home, ".bun", "bin"), // bun global installs
  ].filter((dir) => dir.length > 0);
}

/**
 * Append the existing per-user install dirs to `currentPath`, keeping the
 * current (registry-inherited) entries first and never injecting a dir that
 * isn't on disk. Pure + exported for unit testing (`existsFn` is injected so
 * tests don't touch the real filesystem).
 */
export function computeWindowsSupplementalPath(
  currentPath: string,
  candidateDirs: string[],
  existsFn: (dir: string) => boolean,
  // Defaults to the host delimiter so production callers are unchanged; tests
  // pass ";" so this Windows-only path can be exercised on any host.
  sep: string = path.delimiter,
): string {
  const present = candidateDirs.filter((dir) => dir && existsFn(dir));
  if (present.length === 0) {
    return currentPath;
  }
  return mergePathEntries(currentPath, present.join(sep), sep);
}

/**
 * Resolve the login-shell PATH (macOS/Linux) or append per-user install dirs
 * (Windows) and merge into `process.env.PATH`. A safe no-op if the shell can't
 * be queried or no candidate dirs exist. Call once, early in main-process
 * startup, before anything probes PATH or spawns child processes.
 */
export function applyLoginShellPathToEnv(): void {
  if (process.platform === "win32") {
    const before = process.env.PATH ?? "";
    const merged = computeWindowsSupplementalPath(
      before,
      windowsInstallDirCandidates(),
      existsSync,
    );
    if (merged !== before) {
      process.env.PATH = merged;
      if (process.env.HOLABOSS_DEBUG_SHELL_PATH) {
        console.info(
          `[shell-path] appended Windows per-user install dirs\n  before: ${before}\n  after:  ${merged}`,
        );
      }
    }
    return;
  }
  const shellPath = resolveLoginShellPath();
  if (!shellPath) {
    return;
  }
  const before = process.env.PATH ?? "";
  const merged = mergePathEntries(shellPath, before);
  if (merged.length > 0) {
    process.env.PATH = merged;
  }
  if (process.env.HOLABOSS_DEBUG_SHELL_PATH && merged !== before) {
    // Early startup: logging infra isn't wired yet, so console is all we have.
    console.info(
      `[shell-path] augmented PATH from login shell\n  before: ${before}\n  after:  ${merged}`,
    );
  }
}
