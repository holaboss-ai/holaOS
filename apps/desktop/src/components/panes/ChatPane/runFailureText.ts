/**
 * Turn a machine failure payload into something a person can act on.
 *
 * A run that fails on credits reaches the transcript as the raw wire error — e.g.
 * `402 {"detail":{"code":"model_proxy_insufficient_quota",...}}` — because the
 * run's stored error is the upstream body verbatim. Only one of several 402 paths
 * is normalized upstream, so in one production week the same condition surfaced
 * four different ways and only one of them was a sentence.
 *
 * Recognized conditions are rewritten; everything else passes through unchanged,
 * so an unfamiliar error still shows its real text instead of being flattened
 * into something vague.
 *
 * Its own module (not index.tsx) so it can be tested without loading the whole
 * ChatPane component tree.
 */
export function humanizeRunFailure(detail: string): string {
  const text = detail.toLowerCase();
  const isPayment =
    /\b402\b/.test(text) ||
    text.includes("payment required") ||
    /insufficient (?:quota|credit)/.test(text);
  if (!isPayment) {
    return detail;
  }
  // Distinct situations: the wallet is empty, versus this one prompt being too
  // big to afford. The second is actionable without topping up (shorten it), so
  // don't collapse them into one message.
  if (
    text.includes("exceeds_balance") ||
    text.includes("costs more than the remaining")
  ) {
    return "This request costs more than your remaining balance. Top up, or start a shorter conversation.";
  }
  return "You're out of credits. Top up your plan to keep using your agent.";
}
