import assert from "node:assert/strict";
import { test } from "node:test";

import { humanizeRunFailure } from "./runFailureText";

/**
 * Taken from real production runs. An out-of-credits condition reached the
 * transcript four different ways in one week — only one of them a sentence.
 * The others were the raw upstream body, so the user saw JSON in the chat.
 */

test("the raw insufficient-quota payload becomes a sentence", () => {
  const raw =
    '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota for model proxy requests","quota":{"userId":"b9UFtSwWTKkSdTGnGw9RSEoG8R2KF4TF","balance":-89,"totalAllocated":6000}}}';
  assert.equal(
    humanizeRunFailure(raw),
    "You're out of credits. Top up your plan to keep using your agent.",
  );
});

test("an opaque provider 402 is recognized too", () => {
  assert.equal(
    humanizeRunFailure("OpenAI API error (402): 402 status code (no body)"),
    "You're out of credits. Top up your plan to keep using your agent.",
  );
});

test("a prompt too big to afford gets its own, actionable message", () => {
  // Distinct from an empty wallet: this one is fixable by shortening the turn.
  const raw =
    '402 {"detail":{"code":"model_proxy_call_exceeds_balance","message":"This request\'s prompt costs more than the remaining balance even at the cheapest applicable rate. Top up to continue.","projectedMinimumTokens":13700,"balanceTokens":4000}}';
  assert.match(humanizeRunFailure(raw), /shorter conversation/);
});

test("the already-friendly message is left alone", () => {
  const friendly = "You're out of credits. Top up your plan to keep using your agent.";
  assert.equal(humanizeRunFailure(friendly), friendly);
});

test("an unrelated failure keeps its real text", () => {
  // Flattening every error into something vague would be worse than the bug.
  const other = "orphaned: the worker did not finish within the run lease";
  assert.equal(humanizeRunFailure(other), other);
});
