/**
 * Child process for `in-process-termination.test.ts`.
 *
 * Signal disposition is process-global: whether a SIGTERM kills the runner
 * mid-turn cannot be asserted from inside the process that owns the handler.
 * So the behaviour is staged in a real child, driven over stdout/stdin.
 *
 * Protocol (one JSON object per line on stdout):
 *   {"ready":true}    guard installed, turn in flight
 *   {"settled":true}  the turn finished
 * stdin: "settle\n" ends the turn.
 *
 * argv[2] selects the scenario:
 *   settle  the turn ends after the signal — the real shape of every turn
 *   wedge   the turn never ends — the grace timer must force the exit
 */
import { beginInProcessTurn, endInProcessTurn } from "../ts-runner.js";

const scenario = process.argv[2] ?? "settle";
const say = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

// Hold the event loop open for the whole test. Without this the process would
// exit on its own the moment it went idle, and "exited because the loop
// drained" is indistinguishable from "exited because the signal killed us" —
// the test would pass whether or not the deferral worked. In production the
// loop is held by the runtime's own open handles.
const keepAlive = setInterval(() => {}, 1_000);

const logger = {
  warn: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
  error: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
  log: () => {},
  info: () => {},
  debug: () => {},
};

beginInProcessTurn(logger as never);
say({ ready: true });

if (scenario === "settle") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (!chunk.includes("settle")) {
      return;
    }
    endInProcessTurn(logger as never);
    say({ settled: true });
    // Release the loop, exactly as the runner does once its post-run work is
    // done. A correctly deferred termination lets the process leave here.
    clearInterval(keepAlive);
    process.stdin.pause();
  });
}
// scenario === "wedge": the turn never ends, so only the grace timer can exit.
