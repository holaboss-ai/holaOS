import { readFileSync, statSync } from "node:fs";
// Use the win32 path variant explicitly, not the ambient `node:path`. This code
// reasons about Windows paths (backslashes, `;`-separated PATH, PATHEXT), and
// its unit tests run on Linux CI where the ambient delimiter (`:`) and join
// (`/`) would corrupt Windows-style inputs. On the real Windows runtime this is
// identical to the ambient behaviour.
import { win32 as winPath } from "node:path";

const { delimiter, dirname, extname, isAbsolute, join } = winPath;

/**
 * Windows npm-shim → `node <cli.js>` invocation rewrite for npm-installed agent
 * CLIs that speak a long-lived bidirectional stdio protocol (e.g. the codex
 * app-server, or an npm-installed claude).
 *
 * The problem: npm installs a CLI as three sibling launchers next to each
 * other — `<name>` (POSIX), `<name>.cmd`, `<name>.ps1`. A Windows GUI runtime
 * spawns `<name>`, which resolves to `<name>.cmd`. Every launcher is a dead end
 * for a persistent stdio server:
 *   1. `<name>` (extension-less POSIX shim) isn't executable on Windows, and a
 *      bare `spawn("codex")` can't resolve the `.cmd` at all (ENOENT).
 *   2. `<name>.cmd` needs `shell: true` (the CVE-2024-27980 EINVAL guard), and
 *      cmd.exe then expands the `.cmd` body's `%*` by RE-TOKENISING the raw
 *      command line — truncating/mangling any argv element with a newline (the
 *      multi-line `--append-system-prompt` these harnesses pass).
 *   3. `<name>.ps1` via `powershell -File` (the approach this file used to take)
 *      routes stdin through PowerShell's
 *      `$input | & node …` pipeline. That works for a fire-and-forget CLI, but
 *      DEADLOCKS a bidirectional JSON-RPC/ACP server: codex's `app-server`
 *      blocks forever on a handshake PowerShell never forwards, so the run
 *      "exits without responding". Verified empirically on Windows — spawning
 *      via `codex.ps1` produced total silence; `node codex.js` answered the
 *      `initialize` in ~1.4s.
 *
 * The fix: read the resolved `.cmd`/`.ps1` npm shim, extract the Node CLI entry
 * it launches (`…/node_modules/<pkg>/bin/<name>.js`), and invoke
 * `<node> <cli.js> <args…>` directly. This spawns the SAME Node the shim would
 * (`process.execPath` — the node already running harness-host, not a bundled
 * one), passes each argv element as a discrete token (multi-line args survive),
 * and keeps a direct node→node pipe with no shell in the middle (bidirectional
 * stdio survives). It strictly dominates the `.ps1` rewrite for these harnesses.
 *
 * Deliberately a no-op (returns the input unchanged) when: not on Windows; the
 * binary resolves to a real executable (`.exe`/`.com` — claude.exe, a native
 * codex); or the shim isn't a recognisable Node launcher (no extractable `.js`
 * entry). Callers keep their existing `spawn(command, args)` behaviour in every
 * such case.
 */
export interface CliInvocation {
  command: string;
  args: string[];
}

export interface WindowsInvocationDeps {
  platform: NodeJS.Platform;
  pathEnv: string;
  pathExt: string;
  systemRoot: string;
  /** Node executable used to run an extracted CLI entry. Defaults to the node
   * already running harness-host, which the npm shim would itself fall back to. */
  nodeExe: string;
  isFile: (p: string) => boolean;
  /** Read a shim file's text; returns "" when unreadable. */
  readFile: (p: string) => string;
}

function defaultDeps(): WindowsInvocationDeps {
  return {
    platform: process.platform,
    pathEnv: process.env.PATH ?? "",
    pathExt: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    systemRoot: process.env.SystemRoot || "C:\\Windows",
    nodeExe: process.execPath,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    },
  };
}

/**
 * PATHEXT-aware resolution of `command` to a concrete file path. Handles both
 * bare names (searched across PATH) and explicit paths (an operator-pinned
 * HOLABOSS_*_PATH). Returns null when nothing resolves.
 */
function resolveOnPath(
  command: string,
  deps: WindowsInvocationDeps,
): string | null {
  const exts = deps.pathExt.split(";").filter((e) => e.length > 0);
  // A path (has a separator) is tried directly; a bare name is searched on
  // PATH.
  const hasSep = command.includes("/") || command.includes("\\");
  const bases = hasSep
    ? [command]
    : deps.pathEnv
        .split(delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => join(dir, command));
  // Only match the literal spelling when it already carries a PATHEXT
  // extension. Windows can't execute an extension-less file, and npm installs
  // an extension-less POSIX shim (`codex`) right next to `codex.cmd` — matching
  // the bare name would pick the un-runnable shim and hide the real `.cmd`.
  // Mirrors Go's exec.LookPath, which only considers PATHEXT variants.
  const lower = command.toLowerCase();
  const literalIsExecutable = exts.some((ext) => lower.endsWith(ext.toLowerCase()));
  for (const base of bases) {
    if (literalIsExecutable && deps.isFile(base)) {
      return base;
    }
    for (const ext of exts) {
      const candidate = base + ext;
      if (deps.isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve a `.js`/`.cjs`/`.mjs` token found inside a shim to an absolute path.
 * npm shims reference the entry relative to the shim's own directory via
 * `%dp0%` (`.cmd`) or `$basedir` (`.ps1`); strip that prefix and rejoin against
 * the shim's real dir. An already-absolute token is returned as-is.
 */
function resolveShimJsToken(token: string, shimPath: string): string | null {
  const normalized = token.replace(/\//g, "\\");
  const relative = normalized.replace(
    /^(?:%~?dp0%|\$basedir|\$PSScriptRoot)\\?/i,
    "",
  );
  if (!relative) {
    return null;
  }
  if (isAbsolute(relative)) {
    return relative;
  }
  return join(dirname(shimPath), relative);
}

/**
 * Read an npm `.cmd`/`.ps1` shim and return the absolute path of the Node CLI
 * entry it launches (`node_modules/<pkg>/bin/<name>.js`), or null when the file
 * isn't a recognisable Node launcher. Every quoted `.js`/`.cjs`/`.mjs` token is
 * tried in order; the first that resolves to a real file wins. `node.exe` /
 * `node$exe` references are ignored (they don't end in a JS extension).
 */
function extractNodeCliEntryFromShim(
  shimPath: string,
  deps: WindowsInvocationDeps,
): string | null {
  const text = deps.readFile(shimPath);
  if (!text) {
    return null;
  }
  const tokenPattern = /["']([^"'\r\n]*?\.(?:c|m)?js)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    const entry = resolveShimJsToken(match[1]!, shimPath);
    if (entry && deps.isFile(entry)) {
      return entry;
    }
  }
  return null;
}

export function resolveWindowsCliInvocation(
  toolName: string,
  command: string,
  args: string[],
  deps: WindowsInvocationDeps = defaultDeps(),
): CliInvocation {
  if (deps.platform !== "win32") {
    return { command, args };
  }
  const resolved = resolveOnPath(command, deps);
  if (!resolved) {
    // Let the caller's spawn surface its own ENOENT with the original name.
    return { command, args };
  }
  const ext = extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    // Real executable (claude.exe, a native codex, …) — spawn as-is.
    return { command, args };
  }
  // npm shim → find the Node CLI entry it launches and spawn node on it
  // directly. Parse the resolved `.cmd` first, then a sibling `<toolName>.ps1`
  // (belt-and-suspenders for shims whose `.cmd` format we don't recognise).
  const entry =
    extractNodeCliEntryFromShim(resolved, deps) ??
    extractNodeCliEntryFromShim(join(dirname(resolved), `${toolName}.ps1`), deps);
  if (!entry) {
    // Not a recognisable Node shim — leave the caller's spawn unchanged.
    return { command, args };
  }
  return { command: deps.nodeExe, args: [entry, ...args] };
}
