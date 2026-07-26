import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Out-of-process OAuth authorization for a user-connected remote MCP server.
 * The api-server can't own the interactive flow itself (opening a browser +
 * a loopback redirect listener is harness-host territory, where mcporter
 * lives), so it spawns the harness-host `authorize-mcp` subcommand and parses
 * its `{ ok, tool_count, detail }` line. The child opens the system browser and
 * blocks until the user consents (or the inner OAuth timeout elapses); the
 * outer spawn timeout sits past that as a backstop.
 *
 * Path + node-bin resolution mirrors harness-model-discovery.ts.
 */
function runtimeRootDir(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function harnessHostEntryPath(): { entryPath: string; argsPrefix: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const runtimeRoot = runtimeRootDir();
  if (path.extname(currentFile) === ".ts") {
    return {
      entryPath: path.join(runtimeRoot, "harness-host", "src", "index.ts"),
      argsPrefix: ["--import", "tsx"],
    };
  }
  return {
    entryPath: path.join(runtimeRoot, "harness-host", "dist", "index.mjs"),
    argsPrefix: [],
  };
}

function runtimeNodeBin(): string {
  return (process.env.HOLABOSS_RUNTIME_NODE_BIN ?? "").trim() || process.execPath;
}

export interface AuthorizeMcpResult {
  ok: boolean;
  tool_count: number;
  detail: string;
}

export function parseAuthorizeResult(stdout: string): AuthorizeMcpResult | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as Partial<AuthorizeMcpResult>;
      if (parsed && typeof parsed.ok === "boolean") {
        return {
          ok: parsed.ok,
          tool_count: typeof parsed.tool_count === "number" ? parsed.tool_count : 0,
          detail: typeof parsed.detail === "string" ? parsed.detail : "",
        };
      }
    } catch {
      // not the JSON line — keep scanning
    }
  }
  return null;
}

export interface AuthorizeMcpServerViaHostOptions {
  workspaceDir: string;
  serverId: string;
  url: string;
  headers?: Record<string, string>;
  /** How long to allow the browser consent to complete (inner). */
  timeoutMs?: number;
  /** Wipe the existing token first and force a fresh consent (switch account). */
  reauthorize?: boolean;
}

// Only ONE authorize flow can run at a time: the OAuth callback binds a FIXED loopback
// port (MCP_OAUTH_CALLBACK_PORT in mcp-authorize.ts), so a still-running prior attempt —
// e.g. one the user abandoned in the browser, which keeps waiting out its full consent
// timeout — holds that port and the next attempt dies with EADDRINUSE. Track the in-flight
// child and kill it (freeing the port) before spawning a new one.
let activeAuthorizeChild: ReturnType<typeof spawn> | null = null;
// Children we killed to free the callback port for a newer attempt — so their close can
// report a clear "superseded" reason instead of the generic "produced no result".
const supersededAuthorizeChildren = new WeakSet<ReturnType<typeof spawn>>();

async function terminateActiveAuthorize(): Promise<void> {
  const prev = activeAuthorizeChild;
  if (!prev) {
    return;
  }
  activeAuthorizeChild = null;
  supersededAuthorizeChildren.add(prev);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    // Wait for the child to actually exit so the OS releases the callback port before we
    // spawn the next one; cap it so a wedged child can't block authorize forever.
    prev.once("exit", finish);
    setTimeout(finish, 1500);
    try {
      prev.kill("SIGKILL");
    } catch {
      finish();
    }
  });
}

export async function authorizeMcpServerViaHost(
  options: AuthorizeMcpServerViaHostOptions,
): Promise<AuthorizeMcpResult> {
  const innerTimeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 180_000;
  const outerTimeoutMs = innerTimeoutMs + 15_000;
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  // Free the fixed OAuth callback port by killing any prior in-flight authorize first.
  await terminateActiveAuthorize();
  return new Promise<AuthorizeMcpResult>((resolve) => {
    let settled = false;
    const finish = (result: AuthorizeMcpResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeAuthorizeChild === child) {
        activeAuthorizeChild = null;
      }
      resolve(result);
    };

    const spawnArgs = [
      ...argsPrefix,
      entryPath,
      "authorize-mcp",
      "--workspace-dir",
      options.workspaceDir,
      "--server-id",
      options.serverId,
      "--url",
      options.url,
      "--timeout-ms",
      String(innerTimeoutMs),
    ];
    if (options.headers && Object.keys(options.headers).length > 0) {
      spawnArgs.push("--headers", JSON.stringify(options.headers));
    }
    if (options.reauthorize) {
      spawnArgs.push("--reauthorize");
    }

    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(runtimeNodeBin(), spawnArgs, {
        cwd: runtimeRootDir(),
        stdio: ["ignore", "pipe", "pipe"],
        // Keep mcporter at warn so its errors land on STDERR (captured below for a
        // diagnosable reason) without info/debug polluting STDOUT — the subcommand
        // writes its JSON result there. (Node routes console.log/info→stdout,
        // warn/error→stderr, so a higher level would corrupt result parsing.)
        env: {
          ...process.env,
          MCPORTER_LOG_LEVEL: process.env.MCPORTER_LOG_LEVEL || "warn",
        },
      });
    } catch (error) {
      finish({
        ok: false,
        tool_count: 0,
        detail: error instanceof Error ? error.message : "failed to start authorize flow",
      });
      return;
    }
    activeAuthorizeChild = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // Capture (don't just drain) stderr so a failure/timeout can report the last
    // OAuth log lines — the difference between "it hung" and "why it hung".
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    // Append the tail of the OAuth trace to a failure detail so it reaches the UI.
    const withTrace = (detail: string): string => {
      const tail = stderr.trim().split("\n").slice(-6).join(" | ").slice(-500);
      return tail ? `${detail} — oauth trace: ${tail}` : detail;
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(
        parseAuthorizeResult(stdout) ?? {
          ok: false,
          tool_count: 0,
          detail: withTrace("Authorization timed out — the sign-in did not complete."),
        },
      );
    }, outerTimeoutMs);

    child.on("error", (error) =>
      finish({ ok: false, tool_count: 0, detail: withTrace(error.message) }),
    );
    child.on("close", () =>
      finish(
        parseAuthorizeResult(stdout) ?? {
          ok: false,
          tool_count: 0,
          detail:
            child && supersededAuthorizeChildren.has(child)
              ? "superseded by a newer sign-in attempt"
              : withTrace("The authorize flow produced no result."),
        },
      ),
    );
  });
}
