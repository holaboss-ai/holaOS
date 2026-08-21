import assert from "node:assert/strict";
import { test } from "node:test";

import { walletBlockMessage } from "./runFailureText";

/**
 * Inputs below are real production strings unless marked constructed.
 *
 * The bar this has to clear is asymmetric. Failing to rewrite a wallet block
 * leaves the user where they already are — reading JSON. Rewriting something
 * that is NOT a wallet block is worse than the bug: it names the wrong problem
 * and deletes the real message, including any link that would have fixed it.
 * So the negative tests below are the load-bearing half of this file.
 */

// ---------------------------------------------------------------- positives

test("the raw insufficient-quota payload becomes a sentence", () => {
  const raw =
    '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota for model proxy requests","quota":{"userId":"b9UFtSwWTKkSdTGnGw9RSEoG8R2KF4TF","balance":-89,"totalAllocated":6000}}}';
  assert.equal(
    walletBlockMessage(raw),
    "You're out of credits. Top up your plan to keep using your agent.",
  );
});

test("a prompt too big to afford gets its own, actionable message", () => {
  // Distinct from an empty wallet: fixable by shortening the turn, so it must
  // not collapse into the generic "top up" line.
  const raw =
    '402 {"detail":{"code":"model_proxy_call_exceeds_balance","message":"This request\'s prompt costs more than the remaining balance even at the cheapest applicable rate. Top up to continue.","projectedMinimumTokens":13700,"balanceTokens":4000}}';
  const message = walletBlockMessage(raw);
  assert.match(String(message), /remaining balance/);
  assert.doesNotMatch(String(message), /out of credits/);
});

test("a fuel exhaustion passes through with its own wording", () => {
  // Bossman fuel is a different wallet, and the backend already converts it to a
  // sentence (agent_operator/quota.ts) before it leaves. Matching it here could
  // only relabel "fuel" as "credits" and send the user to the wrong purchase.
  const fromBackend =
    "You're out of Bossman fuel. Top up or upgrade your plan to keep building.";
  assert.equal(walletBlockMessage(fromBackend), null);
});

test("every message fits the caller's 120-char truncation", () => {
  // Truncated past its verb, an instruction is just noise.
  for (const raw of [
    '{"code":"model_proxy_insufficient_quota"}',
    '{"code":"model_proxy_call_exceeds_balance"}',
  ]) {
    const message = walletBlockMessage(raw);
    assert.ok(message, `expected a message for ${raw}`);
    assert.ok(
      String(message).length <= 120,
      `${String(message).length} chars: ${message}`,
    );
  }
});

// ---------------------------------------------------------------- negatives

test("a BYO provider's own 402 is left completely alone", () => {
  // The BYO send path bypasses our quota gate entirely (model_proxy returns
  // early before _ensure_sufficient_quota), so a 402 here is the USER'S OWN
  // provider account. Rewriting it points at the wrong account AND deletes the
  // link that would have fixed it.
  const raw =
    'OpenRouter API error (402): {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1024. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account","code":402}}';
  assert.equal(walletBlockMessage(raw), null);
});

test("a stack trace that happens to contain 402 is not a wallet block", () => {
  // constructed — line:column numbers are the most common way a bare 402
  // appears in an error that has nothing to do with money.
  assert.equal(
    walletBlockMessage(
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at handleTurn (agent.js:402:17)",
    ),
    null,
  );
});

test("a rate limit that quotes 402 elsewhere is not a wallet block", () => {
  // constructed — a number in a duration or a body excerpt must not trip it.
  assert.equal(
    walletBlockMessage(
      "429 Too Many Requests: rate limited, retry after 402 seconds",
    ),
    null,
  );
});

test("another service's 'insufficient quota' is not our wallet", () => {
  // Google Drive says this when the DRIVE is full. "Top up your plan" is a
  // wrong and unfixable instruction.
  assert.equal(
    walletBlockMessage(
      'Google Drive error: {"error":{"code":403,"message":"The user\'s Drive storage quota has been exceeded.","reason":"insufficient quota"}}',
    ),
    null,
  );
});

test("a bare 'Payment Required' from somewhere else is not our wallet", () => {
  // constructed — any HTTP intermediary can emit this reason phrase.
  assert.equal(
    walletBlockMessage("Upstream proxy returned: 402 Payment Required"),
    null,
  );
});

test("an opaque provider 402 is deliberately NOT rewritten", () => {
  // Real, and really a wallet block — but once the SDK has eaten the body it is
  // byte-identical to a BYO provider's 402, so guessing would trade a JSON
  // string for a wrong instruction. The fix for this one is upstream: emit
  // {"error":{"code":...}} so there is something to switch on.
  assert.equal(
    walletBlockMessage("OpenAI API error (402): 402 status code (no body)"),
    null,
  );
});

test("an unrelated failure keeps its real text", () => {
  assert.equal(
    walletBlockMessage("orphaned: the worker did not finish within the run lease"),
    null,
  );
});
