import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactSessionOverThreshold,
  piCompactionReserveTokens,
} from "./pi.js";

/**
 * End-of-turn compaction, driven directly instead of by chatting until the
 * context window fills up.
 *
 * This was previously verifiable only by hand: the trigger lived in a closure
 * over a live session, so reaching it meant a real conversation long enough to
 * cross half the context window, and the outcome was written to a `console.warn`
 * that lands in ts-runner's buffered stderr — surfaced only when a run FAILS.
 * Compaction failing does not fail the run, so the one signal that it broke went
 * to a stream nobody reads.
 */

/** Minimal stand-in for pi's AgentSession: only the surface compaction uses. */
function fakeSession(options: {
  tokens?: number | null;
  contextWindow?: number;
  isCompacting?: boolean;
  compact?: () => Promise<unknown>;
  omitCompact?: boolean;
}) {
  const calls: string[] = [];
  const session: Record<string, unknown> = {
    isCompacting: options.isCompacting ?? false,
    getContextUsage: () =>
      options.contextWindow === undefined && options.tokens === undefined
        ? null
        : { tokens: options.tokens ?? null, contextWindow: options.contextWindow ?? 0 },
  };
  if (!options.omitCompact) {
    session.compact = async () => {
      calls.push("compact");
      return options.compact ? await options.compact() : undefined;
    };
  }
  return { session, calls };
}

test("compaction fires once usage crosses half the context window", async () => {
  // The threshold is `contextWindow - reserve`, and reserve is defined so that
  // the trigger sits at 50% of the window. Pinning it here means a change to
  // the ratio has to be deliberate rather than incidental.
  const contextWindow = 200_000;
  const threshold = contextWindow - piCompactionReserveTokens(contextWindow);
  assert.equal(threshold, 100_000, "trigger should be half the context window");

  const under = fakeSession({ tokens: threshold, contextWindow });
  assert.deepEqual(await compactSessionOverThreshold(under.session), {
    status: "skipped",
    reason: "under-threshold",
  });
  assert.deepEqual(under.calls, [], "exactly at the threshold must not compact");

  const over = fakeSession({ tokens: threshold + 1, contextWindow });
  assert.deepEqual(await compactSessionOverThreshold(over.session), {
    status: "compacted",
  });
  assert.deepEqual(over.calls, ["compact"], "one token over must compact");
});

test("a compaction failure is reported, not swallowed", async () => {
  // The failure that matters: the next turn resumes an uncompacted session and
  // blows the context window. Previously this produced one console.warn into a
  // buffered stream, so the user's symptom was an unexplained failure a turn later.
  const { session } = fakeSession({
    tokens: 150_000,
    contextWindow: 200_000,
    compact: async () => {
      throw new Error("413 payload too large");
    },
  });

  const outcome = await compactSessionOverThreshold(session);
  assert.equal(outcome.status, "failed");
  assert.match(
    outcome.status === "failed" ? outcome.error : "",
    /413 payload too large/,
  );
});

test("compaction does not re-enter while pi is already compacting", async () => {
  const { session, calls } = fakeSession({
    tokens: 150_000,
    contextWindow: 200_000,
    isCompacting: true,
  });
  assert.deepEqual(await compactSessionOverThreshold(session), {
    status: "skipped",
    reason: "already-compacting",
  });
  assert.deepEqual(calls, []);
});

test("missing or unusable usage never triggers compaction", async () => {
  // getContextUsage returning null, or a zero window, must be a skip rather than
  // a divide-by-zero that compacts every turn.
  for (const options of [
    {},
    { tokens: null, contextWindow: 200_000 },
    { tokens: 150_000, contextWindow: 0 },
  ]) {
    const { session, calls } = fakeSession(options);
    const outcome = await compactSessionOverThreshold(session);
    assert.equal(
      outcome.status,
      "skipped",
      `expected a skip for ${JSON.stringify(options)}`,
    );
    assert.deepEqual(calls, []);
  }
});

test("a session without compact() is skipped rather than crashing the turn", async () => {
  // Compaction runs AFTER the terminal event. A throw here is a post-terminal
  // error, which the in-process path must not report as a failed run.
  const { session } = fakeSession({
    tokens: 150_000,
    contextWindow: 200_000,
    omitCompact: true,
  });
  assert.deepEqual(await compactSessionOverThreshold(session), {
    status: "skipped",
    reason: "unsupported",
  });
});
