import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HarnessSupportedModel } from "../../harnesses/src/types.js";

/**
 * Out-of-process model discovery. The api-server cannot spawn a harness CLI's
 * handshake itself (CLI spawning is harness-host territory), so it runs the
 * harness-host `discover-models` subcommand and parses its `{ models: [...] }`
 * line. Never throws: any failure (spawn error, timeout, bad output) resolves
 * to [] so the caller falls back to the harness's static catalogue.
 *
 * The path + node-bin resolution mirrors ts-runner.ts's harnessHostEntryPath /
 * runtimeNodeBin (kept local to avoid importing that 2.7k-line module here).
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

function parseDiscoveredModels(stdout: string): HarnessSupportedModel[] {
  // The subcommand prints exactly one JSON line, but tolerate extra log lines
  // by scanning for the last line that parses into `{ models: [...] }`.
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as { models?: unknown };
      if (parsed && Array.isArray(parsed.models)) {
        return parsed.models.filter(isSupportedModel);
      }
    } catch {
      // not the JSON line — keep scanning
    }
  }
  return [];
}

function isSupportedModel(value: unknown): value is HarnessSupportedModel {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { label?: unknown }).label === "string"
  );
}

export interface DiscoverHarnessModelsOptions {
  harnessId: string;
  cwd: string;
  timeoutMs?: number;
}

export function discoverHarnessModelsViaHost(
  options: DiscoverHarnessModelsOptions,
): Promise<HarnessSupportedModel[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  return new Promise<HarnessSupportedModel[]>((resolve) => {
    let settled = false;
    const finish = (models: HarnessSupportedModel[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(models);
    };

    let child;
    try {
      child = spawn(
        runtimeNodeBin(),
        [
          ...argsPrefix,
          entryPath,
          "discover-models",
          "--harness",
          options.harnessId,
          "--cwd",
          options.cwd,
        ],
        { cwd: runtimeRootDir(), stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      finish([]);
      return;
    }

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // Drain stderr so the pipe never blocks the child; the subcommand's own
    // discovery logging is noise here.
    child.stderr?.resume();

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(parseDiscoveredModels(stdout));
    }, timeoutMs);

    child.on("error", () => finish([]));
    child.on("close", () => finish(parseDiscoveredModels(stdout)));
  });
}

export interface HarnessConnectionTestResult {
  ok: boolean;
  detail: string;
  duration_ms: number;
}

export function parseConnectionResult(stdout: string): HarnessConnectionTestResult | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as Partial<HarnessConnectionTestResult>;
      if (parsed && typeof parsed.ok === "boolean") {
        return {
          ok: parsed.ok,
          detail: typeof parsed.detail === "string" ? parsed.detail : "",
          duration_ms: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
        };
      }
    } catch {
      // not the JSON line — keep scanning
    }
  }
  return null;
}

/**
 * Run a live connection test for a harness out-of-process: spawn the
 * harness-host `test-connection` subcommand (which runs the harness with a
 * tiny prompt) and parse its `{ ok, detail, duration_ms }` verdict. The outer
 * spawn timeout sits a few seconds past the inner run timeout as a backstop.
 */
export function testHarnessConnectionViaHost(options: {
  harnessId: string;
  timeoutMs?: number;
}): Promise<HarnessConnectionTestResult> {
  const innerTimeoutMs = options.timeoutMs ?? 45_000;
  const outerTimeoutMs = innerTimeoutMs + 8_000;
  const { entryPath, argsPrefix } = harnessHostEntryPath();
  return new Promise<HarnessConnectionTestResult>((resolve) => {
    let settled = false;
    const finish = (result: HarnessConnectionTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(
        runtimeNodeBin(),
        [
          ...argsPrefix,
          entryPath,
          "test-connection",
          "--harness",
          options.harnessId,
          "--timeout-ms",
          String(innerTimeoutMs),
        ],
        { cwd: runtimeRootDir(), stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      finish({
        ok: false,
        detail: error instanceof Error ? error.message : "failed to start connection test",
        duration_ms: 0,
      });
      return;
    }

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.resume();

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(
        parseConnectionResult(stdout) ?? {
          ok: false,
          detail: "Connection test timed out.",
          duration_ms: outerTimeoutMs,
        },
      );
    }, outerTimeoutMs);

    child.on("error", (error) =>
      finish({ ok: false, detail: error.message, duration_ms: 0 }),
    );
    child.on("close", () =>
      finish(
        parseConnectionResult(stdout) ?? {
          ok: false,
          detail: "The connection test produced no result.",
          duration_ms: 0,
        },
      ),
    );
  });
}
