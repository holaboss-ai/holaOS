/**
 * Turn a failure the Holaboss wallet raised into something a person can act on.
 *
 * A run blocked on credits reaches the transcript as the raw upstream body,
 * because the run's stored error is that body verbatim and only one of several
 * 402 paths is normalized upstream. In one production week the same condition
 * surfaced four different ways, only one of them a sentence.
 *
 * ## Why this matches OUR error codes and not "402"
 *
 * An earlier version matched `/\b402\b/` plus the phrases "payment required" and
 * "insufficient quota|credit". Measured against real inputs that was wrong in the
 * expensive direction — rewriting an unrelated failure into "you're out of
 * credits" is worse than showing raw JSON, because it names the wrong problem AND
 * deletes the real message:
 *
 *  - the two phrase rules caught ZERO real wallet blocks (every one of them
 *    carries a leading 402 anyway) while being the sole trigger for false
 *    positives;
 *  - a bare 402 shows up in stack traces (`agent.js:402:17`), durations, byte
 *    counts, ports, and `at position 402`;
 *  - worst, a BYO/custom-provider 402 means the USER'S OWN provider account is
 *    out of credit. The BYO send path returns before the quota gate, so those
 *    errors arrive here verbatim — and "top up your plan" both points at the
 *    wrong account and deletes the provider's own remediation link.
 *
 * The codes below cannot appear in any of those. They are emitted only by our
 * quota gate, which the BYO path never reaches, so matching them is proof that
 * the Holaboss wallet is what blocked the run.
 *
 * Deliberately NOT handled:
 *  - `OpenAI API error (402): 402 status code (no body)` — a real wallet block,
 *    but once the SDK has eaten the body it is byte-identical to a BYO
 *    provider's 402. The fix belongs upstream: the gate replies
 *    `{"detail":{...}}` while the OpenAI SDK reads `error`, which is why the
 *    code is missing here in the first place.
 *  - Bossman fuel — a separate wallet, and the backend already converts it to a
 *    sentence before it leaves (`agent_operator/quota.ts`), so there is nothing
 *    to rewrite and no way to mislabel it as credits.
 *
 * Its own module (not index.tsx) so it is testable without the ChatPane tree.
 */

/** Codes our quota gate emits, each a different situation for the user. */
const WALLET_BLOCK_MESSAGES: ReadonlyArray<readonly [code: string, message: string]> = [
  // Actionable WITHOUT topping up (send less), so it must not collapse into the
  // generic message. Kept short: the caller truncates at 120 chars.
  [
    "model_proxy_call_exceeds_balance",
    "This request costs more than your remaining balance. Top up, or start a shorter conversation.",
  ],
  [
    "model_proxy_insufficient_quota",
    "You're out of credits. Top up your plan to keep using your agent.",
  ],
];

/**
 * Rewrite a wallet block into a sentence, or return null to leave the failure
 * exactly as it is. Null (rather than the input) so callers can tell "not mine"
 * from "rewritten" — a wallet block is not a condition of the model that was
 * running, so it is shown without the provider/model prefix.
 */
export function walletBlockMessage(detail: string): string | null {
  for (const [code, message] of WALLET_BLOCK_MESSAGES) {
    if (detail.includes(code)) {
      return message;
    }
  }
  return null;
}
