const STDIO_EPIPE_GUARD_SYMBOL = Symbol.for("holaboss.harnessHost.stdioEpipeGuard");

function isEpipeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "EPIPE";
}

function installGuardOnStream(stream: NodeJS.WritableStream | null | undefined): void {
  if (!stream || typeof (stream as { on?: unknown }).on !== "function") {
    return;
  }
  const guardedStream = stream as NodeJS.WritableStream & { [STDIO_EPIPE_GUARD_SYMBOL]?: boolean };
  if (guardedStream[STDIO_EPIPE_GUARD_SYMBOL]) {
    return;
  }
  guardedStream[STDIO_EPIPE_GUARD_SYMBOL] = true;
  guardedStream.on("error", (error: unknown) => {
    if (isEpipeError(error)) {
      return;
    }
    throw error instanceof Error ? error : new Error(String(error));
  });
}

export function installBenignStdioEpipeGuard(io: {
  stdout?: NodeJS.WritableStream | null;
  stderr?: NodeJS.WritableStream | null;
} = {}): void {
  installGuardOnStream(io.stdout ?? process.stdout);
  installGuardOnStream(io.stderr ?? process.stderr);
}
