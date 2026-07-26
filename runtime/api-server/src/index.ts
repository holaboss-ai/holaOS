import { setTimeout as sleep } from "node:timers/promises";
import { buildRuntimeApiServer } from "./app.js";

const SHUTDOWN_TIMEOUT_MS = 2_000;

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 0;
  }
}

async function main(): Promise<void> {
  const port = Number.parseInt(
    process.env.SANDBOX_RUNTIME_API_PORT ??
      process.env.SANDBOX_AGENT_BIND_PORT ??
      process.env.PORT ??
      "3060",
    10,
  );
  // Security: default the bind host to loopback so the runtime API is not exposed
  // on all interfaces. Ops can still opt back into a wider bind via the
  // SANDBOX_RUNTIME_API_HOST / SANDBOX_AGENT_BIND_HOST env overrides.
  const host =
    (
      process.env.SANDBOX_RUNTIME_API_HOST ??
      process.env.SANDBOX_AGENT_BIND_HOST ??
      "127.0.0.1"
    ).trim() || "127.0.0.1";
  const app = buildRuntimeApiServer({ logger: true });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await Promise.race([
          app.close().catch(() => undefined),
          sleep(SHUTDOWN_TIMEOUT_MS),
        ]);
      } finally {
        process.exit(signalExitCode(signal));
      }
    })();
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  // Without these handlers an uncaught exception / unhandled rejection in a
  // background worker crashes the runtime with exit code 1 and the stack only
  // reaches stderr — invisible in runtime.log. Log it through pino first so the
  // crash is diagnosable, then preserve the default exit(1).
  let fatalHandled = false;
  const handleFatal = (
    kind: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ): void => {
    if (fatalHandled) {
      return;
    }
    fatalHandled = true;
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      app.log.fatal({ err }, `runtime fatal: ${kind}`);
    } catch {
      // Logger may be unavailable mid-crash; fall back to stderr.
      console.error(`runtime fatal: ${kind}`, err);
    }
    process.exit(1);
  };

  process.on("uncaughtException", (error) => {
    handleFatal("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatal("unhandledRejection", reason);
  });

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

await main();
