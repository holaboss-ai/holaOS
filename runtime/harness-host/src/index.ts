import { fileURLToPath } from "node:url";

import * as Sentry from "@sentry/node";

import { decodeHarnessHostPiRequestBase64 } from "./contracts.js";
import { flushHarnessSentry, initHarnessSentry } from "./harness-ai-monitoring.js";
import { requireHarnessHostPluginByCommand } from "./harness-registry.js";
import { compactPiSession } from "./pi.js";

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

  try {
    const exitCode = await runHarnessHostCli(argv, deps);
    await Promise.allSettled([flushWritableStream(stdout), flushWritableStream(stderr)]);
    await flushHarnessSentry();
    exit(exitCode);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    Sentry.captureException(error);
    stderr.write(`${message}\n`);
    await Promise.allSettled([flushWritableStream(stdout), flushWritableStream(stderr)]);
    await flushHarnessSentry();
    exit(1);
  }
}

initHarnessSentry();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runHarnessHostMain(process.argv.slice(2));
}
