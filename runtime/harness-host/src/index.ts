import { fileURLToPath } from "node:url";

import { testHarnessConnection } from "./connection-test.js";
import { decodeHarnessHostPiRequestBase64 } from "./contracts.js";
import { authorizeMcpServerOAuth } from "./mcp-authorize.js";
import {
  listHarnessHostPlugins,
  requireHarnessHostPluginByCommand,
} from "./harness-registry.js";
import { discoverHarnessModels } from "./model-discovery.js";
import { compactPiSession } from "./pi.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";

type ReadableRequestStream = Pick<NodeJS.ReadableStream, "setEncoding"> &
  AsyncIterable<string | Buffer>;

type HarnessHostCliDeps = {
  resolvePluginByCommand?: typeof requireHarnessHostPluginByCommand;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: ReadableRequestStream;
  exit?: (code: number) => void;
};

async function readRequestBase64FromStdin(
  stdin: ReadableRequestStream,
): Promise<string> {
  stdin.setEncoding("utf8");
  let encoded = "";
  for await (const chunk of stdin) {
    encoded += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return encoded.trim();
}

function readFlagValue(args: string[], flag: string): string | null {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function readRequestBase64(
  args: string[],
  stdin: ReadableRequestStream = process.stdin as ReadableRequestStream,
) {
  const flagIndex = args.findIndex((arg) => arg === "--request-base64");
  if (flagIndex !== -1) {
    const encoded = args[flagIndex + 1];
    if (!encoded) {
      throw new Error("missing value for --request-base64");
    }
    return encoded;
  }

  if (args.includes("--request-stdin")) {
    const encoded = await readRequestBase64FromStdin(stdin);
    if (!encoded) {
      throw new Error("missing stdin payload for --request-stdin");
    }
    return encoded;
  }

  throw new Error("missing required argument --request-base64 or --request-stdin");
}

export async function flushWritableStream(stream: Pick<NodeJS.WritableStream, "write">): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write("", (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function runHarnessHostCli(
  argv: string[],
  deps: Pick<HarnessHostCliDeps, "resolvePluginByCommand" | "stdout" | "stdin"> = {},
) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("missing command");
  }

  if (command === "compact-pi-session") {
    const encoded = await readRequestBase64(
      args,
      deps.stdin ?? (process.stdin as ReadableRequestStream),
    );
    const request = decodeHarnessHostPiRequestBase64(encoded);
    const result = await compactPiSession(request);
    const stdout = deps.stdout ?? process.stdout;
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.error ? 1 : 0;
  }

  if (command === "discover-models") {
    // Out-of-process model discovery: the api-server spawns this to read a
    // harness's live model catalogue (it can't run CLI handshakes itself).
    // Always exits 0 with a JSON `{ models: [...] }` line — an empty list
    // signals "fall back to the static catalogue" upstream.
    const harnessId = readFlagValue(args, "--harness") ?? "";
    const cwd = readFlagValue(args, "--cwd") ?? process.cwd();
    const models = await discoverHarnessModels(harnessId, cwd);
    const stdout = deps.stdout ?? process.stdout;
    stdout.write(`${JSON.stringify({ models })}\n`);
    return 0;
  }

  if (command === "test-connection") {
    // Live connection test: run the harness with a tiny prompt and report a
    // pass/fail verdict. Always exits 0 with a JSON result line; the api-server
    // spawns this (it can't run the harness CLI itself).
    const harnessId = readFlagValue(args, "--harness") ?? "";
    const cwd = readFlagValue(args, "--cwd") ?? undefined;
    const timeoutMs = Number.parseInt(readFlagValue(args, "--timeout-ms") ?? "", 10);
    const stdout = deps.stdout ?? process.stdout;
    const hostCommand = listHarnessHostPlugins().find((plugin) => plugin.id === harnessId)?.command;
    if (!hostCommand) {
      stdout.write(
        `${JSON.stringify({ ok: false, detail: `unknown harness: ${harnessId}`, duration_ms: 0 })}\n`,
      );
      return 0;
    }
    const result = await testHarnessConnection({
      harnessId,
      hostCommand,
      cwd,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45_000,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (command === "authorize-mcp") {
    // Interactive OAuth for a user-connected remote MCP server. The api-server
    // spawns this (it can't open a browser + own a loopback redirect itself);
    // it opens the system browser, waits for consent, and persists the token to
    // the workspace's mcp-oauth cache. Always exits with a JSON result line.
    const workspaceDir = readFlagValue(args, "--workspace-dir") ?? "";
    const serverId = readFlagValue(args, "--server-id") ?? "";
    const url = readFlagValue(args, "--url") ?? "";
    const headersRaw = readFlagValue(args, "--headers");
    const timeoutMs = Number.parseInt(readFlagValue(args, "--timeout-ms") ?? "", 10);
    let headers: Record<string, string> | undefined;
    if (headersRaw) {
      try {
        const parsed = JSON.parse(headersRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          headers = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          );
        }
      } catch {
        // ignore malformed --headers; proceed with none
      }
    }
    const result = await authorizeMcpServerOAuth({
      workspaceDir,
      serverId,
      url,
      headers,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      reauthorize: args.includes("--reauthorize"),
    });
    const stdout = deps.stdout ?? process.stdout;
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }

  const resolvePluginByCommand = deps.resolvePluginByCommand ?? requireHarnessHostPluginByCommand;
  const plugin = resolvePluginByCommand(command);
  const encoded = await readRequestBase64(
    args,
    deps.stdin ?? (process.stdin as ReadableRequestStream),
  );
  const request = plugin.decodeRequestBase64(encoded);
  return await plugin.run(request);
}

export async function runHarnessHostMain(argv: string[], deps: HarnessHostCliDeps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  installBenignStdioEpipeGuard({ stdout, stderr });

  try {
    const exitCode = await runHarnessHostCli(argv, deps);
    await Promise.allSettled([flushWritableStream(stdout), flushWritableStream(stderr)]);
    exit(exitCode);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    await Promise.allSettled([flushWritableStream(stdout), flushWritableStream(stderr)]);
    exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runHarnessHostMain(process.argv.slice(2));
}
