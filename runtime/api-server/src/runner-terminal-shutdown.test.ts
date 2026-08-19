import assert from "node:assert/strict";
import { test } from "node:test";

import { terminateRunnerAfterTerminalEvent } from "./runtime-shell.js";

/**
 * How the runner is terminated after its terminal event.
 *
 * End-of-turn compaction runs AFTER that event, and the event is what prompts
 * the termination — so whatever happens here is compaction's entire budget. A
 * 621k-token compaction was measured at 26.1s.
 *
 * The platform is injected because the bug being fixed is Windows-only and
 * cannot be reproduced on this machine: `killChildProcess` ignores the
 * requested signal on win32 and runs `taskkill /t /f`, a hard kill no handler
 * can defer, so signalling there killed compaction outright on every turn.
 */

function fakeChild(): { killed: boolean; pid: number } {
  return { killed: false, pid: 1234 };
}

function recordingKill() {
  const calls: string[] = [];
  return {
    calls,
    kill: (_child: unknown, signal: NodeJS.Signals) => {
      calls.push(signal);
    },
  };
}

test("POSIX signals the runner so it can defer until the turn settles", () => {
  const { calls, kill } = recordingKill();
  const timer = terminateRunnerAfterTerminalEvent(fakeChild() as never, {
    platform: "darwin",
    kill: kill as never,
  });

  assert.deepEqual(calls, ["SIGTERM"], "SIGTERM is catchable on POSIX");
  assert.equal(
    timer,
    null,
    "no escalation timer: the runner's own grace is the bound, and a second one would cut compaction off at whichever fired first",
  );
});

test("Windows does NOT signal, because any signal there is a hard kill", () => {
  // The whole bug. `killChildProcess(child, "SIGTERM")` on win32 runs
  // `taskkill /pid <pid> /t /f`. There is no catchable termination signal for a
  // Node child on Windows, so sending one guarantees compaction is truncated.
  const { calls, kill } = recordingKill();
  const timer = terminateRunnerAfterTerminalEvent(fakeChild() as never, {
    platform: "win32",
    kill: kill as never,
    forceAfterMs: 50,
  });

  assert.deepEqual(
    calls,
    [],
    "signalling on Windows force-kills the process tree and truncates compaction",
  );
  assert.notEqual(timer, null, "but the wait must still be bounded");
  if (timer) {
    clearTimeout(timer);
  }
});

test("Windows force-kills once the grace elapses", async () => {
  // The runner normally exits on its own when the turn settles. This is the
  // backstop for one that does not — the bound POSIX gets from the runner's own
  // grace timer.
  const { calls, kill } = recordingKill();
  terminateRunnerAfterTerminalEvent(fakeChild() as never, {
    platform: "win32",
    kill: kill as never,
    forceAfterMs: 20,
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, ["SIGKILL"], "a wedged runner must still be reclaimed");
});

test("a runner that already exited is not killed again", async () => {
  const { calls, kill } = recordingKill();
  const child = fakeChild();
  terminateRunnerAfterTerminalEvent(child as never, {
    platform: "win32",
    kill: kill as never,
    forceAfterMs: 20,
  });
  // The normal case: the runner finishes compaction and exits by itself.
  child.killed = true;

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, [], "no gratuitous kill after a clean exit");
});

test("the Windows grace leaves room for a real compaction", () => {
  // 26.1s measured for a 621k-token compaction. The default must clear it by a
  // wide margin, since a truncated compaction leaves the session uncompacted
  // and makes the next turn larger still.
  const { calls, kill } = recordingKill();
  const timer = terminateRunnerAfterTerminalEvent(fakeChild() as never, {
    platform: "win32",
    kill: kill as never,
  });
  assert.notEqual(timer, null);
  assert.deepEqual(calls, [], "must not kill synchronously");
  if (timer) {
    // Node exposes the scheduled delay on the handle; assert the default is
    // generous rather than trusting the constant by eye.
    const delay = (timer as unknown as { _idleTimeout: number })._idleTimeout;
    assert.ok(
      delay >= 26_100 * 3,
      `default grace ${delay}ms leaves too little room for a 26.1s compaction`,
    );
  }
});
