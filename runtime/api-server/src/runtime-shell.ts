import path from "node:path";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

export type RuntimeShellKind = "posix" | "powershell";

type SpawnLike = typeof spawn;
type ChildLike = ReturnType<SpawnLike>;

export function runtimeShellKind(platform: NodeJS.Platform = process.platform): RuntimeShellKind {
  return platform === "win32" ? "powershell" : "posix";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = (env.SystemRoot ?? env.windir ?? "C:\\Windows").trim();
  if (!systemRoot) {
    return "powershell.exe";
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function shellPathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}

export function quoteShellValue(value: string, platform: NodeJS.Platform = process.platform): string {
  if (runtimeShellKind(platform) === "powershell") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommandInvocation(commandText: string, platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
  detached: boolean;
  shellKind: RuntimeShellKind;
} {
  const shellKind = runtimeShellKind(platform);
  if (shellKind === "powershell") {
    return {
      command: windowsPowerShellPath(),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", commandText],
      detached: false,
      shellKind,
    };
  }
  return {
    command: "/bin/bash",
    args: ["-lc", commandText],
    detached: true,
    shellKind,
  };
}

export function spawnShellCommand(
  spawnImpl: SpawnLike,
  commandText: string,
  options: (SpawnOptions & { platform?: NodeJS.Platform; detached?: boolean }) | undefined = {},
): ChildLike {
  const { platform = process.platform, detached, ...spawnOptions } = options;
  const invocation = shellCommandInvocation(commandText, platform);
  return spawnImpl(invocation.command, invocation.args, {
    ...spawnOptions,
    detached: detached ?? invocation.detached,
  });
}

export function killChildProcess(
  child: ChildLike,
  signal: NodeJS.Signals = "SIGTERM",
  options: { platform?: NodeJS.Platform } = {},
): void {
  if (child.killed) {
    return;
  }

  const pid = typeof child.pid === "number" ? child.pid : 0;
  const platform = options.platform ?? process.platform;

  if (platform === "win32" && pid > 0) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall back to the direct child kill below.
    }
  }

  if (platform !== "win32" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child kill below.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

/**
 * Bound on how long the runner may keep working after its terminal event
 * before it is force-killed. Mirrors IN_PROCESS_TERMINATION_GRACE_MS in
 * ts-runner (duplicated rather than imported — the dependency would be a cycle,
 * and this file must stay free of runner internals).
 */
const RUNNER_POST_TERMINAL_GRACE_MS = 120_000;

/**
 * Terminate the runner after its terminal event — without cutting off the work
 * that runs *after* that event.
 *
 * End-of-turn compaction runs after the terminal event, and the terminal event
 * is exactly what prompts this call. A 621k-token compaction was measured at
 * 26.1s, so anything that kills the runner promptly here truncates it, leaving
 * the session uncompacted; the next turn is then larger and likelier to be
 * truncated again.
 *
 * The two platforms need opposite treatment, which is the bug this fixes:
 *
 *  - POSIX: SIGTERM is catchable, so the runner defers it until the turn
 *    settles and then leaves by draining its event loop. Unchanged.
 *
 *  - Windows: there is NO catchable termination signal for a Node child.
 *    `child.kill("SIGTERM")` is an abrupt TerminateProcess, which is why
 *    killChildProcess falls back to `taskkill /t /f` — a hard kill no handler
 *    can defer. Signalling at all on Windows therefore guarantees compaction is
 *    killed, every turn. So we send nothing and let the runner exit on its own,
 *    with a force-kill as the backstop the POSIX side gets from the runner's
 *    own grace timer.
 *
 * The Windows path predates the in-process harness: the spawned harness-host
 * sat inside the same `/t` process tree, so it was killed just the same.
 */
export function terminateRunnerAfterTerminalEvent(
  child: ChildLike,
  options: {
    platform?: NodeJS.Platform;
    forceAfterMs?: number;
    kill?: (child: ChildLike, signal: NodeJS.Signals) => void;
  } = {},
): NodeJS.Timeout | null {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? killChildProcess;

  if (platform !== "win32") {
    kill(child, "SIGTERM");
    // No escalation: the runner's own grace timer is the bound on POSIX, and
    // adding a second one here would cut compaction off at whichever fires
    // first — reintroducing the race from the other side.
    return null;
  }

  const forceAfterMs = options.forceAfterMs ?? RUNNER_POST_TERMINAL_GRACE_MS;
  const timer = setTimeout(() => {
    if (!child.killed) {
      kill(child, "SIGKILL");
    }
  }, forceAfterMs);
  timer.unref?.();
  return timer;
}

export function buildPortListenerKillCommand(
  ports: number[],
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedPorts = ports
    .map((port) => Math.trunc(port))
    .filter((port) => Number.isInteger(port) && port > 0);

  if (normalizedPorts.length === 0) {
    return "";
  }

  if (runtimeShellKind(platform) === "powershell") {
    return [
      `$ports = @(${normalizedPorts.join(", ")});`,
      "foreach ($port in $ports) {",
      "  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |",
      "    Where-Object { $_.State -eq 'Listen' } |",
      "    Select-Object -ExpandProperty OwningProcess -Unique |",
      "    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      "}",
    ].join(" ");
  }

  // CRITICAL: restrict to LISTEN state. Without `-sTCP:LISTEN`, lsof also
  // returns PIDs with ESTABLISHED/CLOSE_WAIT sockets on the same port —
  // including the runtime process itself when it has just probed the app's
  // /healthz. That turned orphan cleanup into a self-kill loop.
  return normalizedPorts
    .map(
      (port) =>
        `kill $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true`,
    )
    .join(" ; ");
}
