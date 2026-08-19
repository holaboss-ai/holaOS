import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * SIGTERM deferral for in-process pi turns.
 *
 * Why this needs a real child: runner-worker SIGTERMs the runner the moment it
 * sees a terminal event, and with pi in-process that signal lands while pi is
 * still doing its post-terminal work — compaction and dispose run AFTER
 * `run_completed`. If the signal killed the runner there, compaction would be
 * cut off halfway and the next turn would resume an uncompacted session.
 *
 * That is a property of process-global signal disposition, so it cannot be
 * asserted in-process: a test that installs the handler in the test runner
 * would either kill the runner or prove nothing. Each case below therefore
 * stages the turn in a child and sends it a genuine signal.
 *
 * This path runs on EVERY turn, not just at shutdown — which is what makes it
 * worth the cost of a subprocess test.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "testing", "in-process-signal-child.mts");

interface Child {
  process: ChildProcess;
  ready: Promise<void>;
  settled: Promise<void>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderr: () => string;
}

function startChild(scenario: "settle" | "wedge", graceMs: number): Child {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CHILD, scenario],
    {
      cwd: path.resolve(here, ".."),
      env: {
        ...process.env,
        HB_HARNESS_IN_PROCESS_GRACE_MS: String(graceMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const waiters = new Map<string, () => void>();
  const signal = (key: string) =>
    new Promise<void>((resolve) => waiters.set(key, resolve));
  const ready = signal("ready");
  const settled = signal("settled");

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      for (const [key, resolve] of waiters) {
        if (message[key] === true) {
          resolve();
        }
      }
    }
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.on("exit", (code, exitSignal) => {
        resolve({ code, signal: exitSignal });
      });
    },
  );

  return { process: child, ready, settled, exited, stderr: () => stderr };
}

/** Resolves to null if the process is still running when the window elapses. */
async function exitWithin(
  child: Child,
  ms: number,
): Promise<{ code: number | null; signal: string | null } | null> {
  return await Promise.race([
    child.exited,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms).unref?.();
    }),
  ]);
}

test("SIGTERM during an in-flight turn does not kill the runner", async () => {
  // The turn here stands in for pi's post-terminal window: run_completed has
  // been relayed, runner-worker has fired SIGTERM, and compaction is still
  // running. Dying now truncates it.
  const child = startChild("settle", 30_000);
  try {
    await child.ready;
    child.process.kill("SIGTERM");

    const early = await exitWithin(child, 400);
    assert.equal(
      early,
      null,
      "the runner exited while a turn was still in flight — post-terminal compaction would be cut off",
    );
    assert.match(
      child.stderr(),
      /deferring SIGTERM/,
      "the deferral should say so; a silent one is indistinguishable from a missing handler",
    );

    child.process.stdin?.write("settle\n");
    await child.settled;

    // The deferral must RELEASE when the turn ends, not grant the runner
    // lasting immunity to signals. A counter that failed to unwind — an early
    // return that skipped `endInProcessTurn`, say — would leave the runner
    // killable only by SIGKILL, and the symptom would be orphaned runner
    // processes rather than anything visible in a turn.
    child.process.kill("SIGTERM");
    const after = await exitWithin(child, 5_000);
    assert.notEqual(
      after,
      null,
      "a signal after the turn settled must terminate the runner immediately",
    );
    assert.equal(after?.code, 0);
  } finally {
    child.process.kill("SIGKILL");
  }
});

test("SIGINT is deferred the same way as SIGTERM", async () => {
  const child = startChild("settle", 30_000);
  try {
    await child.ready;
    child.process.kill("SIGINT");
    assert.equal(
      await exitWithin(child, 400),
      null,
      "SIGINT must defer too — the default disposition kills the process outright",
    );
  } finally {
    child.process.kill("SIGKILL");
  }
});

test("a turn that never settles still exits, via the grace timer", async () => {
  // The deferral must be bounded. Without the timer a wedged turn would hold
  // the runner open indefinitely and the parent would have to SIGKILL it.
  const child = startChild("wedge", 300);
  try {
    await child.ready;
    child.process.kill("SIGTERM");

    const result = await exitWithin(child, 8_000);
    assert.notEqual(result, null, "the grace timer did not fire");
    assert.equal(result?.code, 0, "the bounded exit should be clean");
    assert.match(
      child.stderr(),
      /did not settle within 300ms/,
      "the forced exit should be attributable in the log",
    );
  } finally {
    child.process.kill("SIGKILL");
  }
});

test("repeated signals during one turn do not stack grace timers", async () => {
  // runner-worker can fire more than once (terminal event, then stream
  // teardown). Each signal starting its own timer would make the effective
  // grace the FIRST one to fire, shortening the window unpredictably.
  const child = startChild("settle", 30_000);
  try {
    await child.ready;
    for (let i = 0; i < 5; i += 1) {
      child.process.kill("SIGTERM");
    }
    assert.equal(await exitWithin(child, 400), null, "still deferring");

    const deferrals = child.stderr().match(/deferring SIG/g) ?? [];
    assert.equal(
      deferrals.length,
      1,
      `expected one deferral for five signals, got ${deferrals.length}`,
    );
  } finally {
    child.process.kill("SIGKILL");
  }
});
