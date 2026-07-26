import { spawn } from "node:child_process";

export interface CapturedCommand {
  /** Combined stdout (and optionally stderr) text. */
  output: string;
  /** Process exit code, or null if it was killed / never started. */
  code: number | null;
}

/**
 * Run a short-lived CLI and capture its output, with a hard timeout. Used
 * only for model-discovery shellouts (e.g. codex model discovery) — NOT for
 * agent runs. Never rejects: a missing binary, a
 * non-zero exit, or a timeout all resolve to whatever was captured so the
 * caller can parse-or-fall-back (it parses output even on non-zero exit).
 */
export function captureCommand(
  binary: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; combineStderr?: boolean; env?: NodeJS.ProcessEnv },
): Promise<CapturedCommand> {
  return new Promise<CapturedCommand>((resolve) => {
    let settled = false;
    const finish = (result: CapturedCommand): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Binary not found / spawn failure — treat as empty output.
      finish({ output: "", code: null });
      return;
    }

    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    if (options.combineStderr) {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
      });
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ output, code: null });
    }, options.timeoutMs);

    child.on("error", () => finish({ output, code: null }));
    child.on("close", (code) => finish({ output, code }));
  });
}
