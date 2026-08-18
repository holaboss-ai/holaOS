import type { ChatMessage } from "./types";

/**
 * Keep a just-finished assistant turn on screen until the server's history
 * catches up with it.
 *
 * When a run completes, the turn is committed straight into local state so it
 * appears the instant streaming stops. The conversation is then refreshed on a
 * ladder (150ms / 500ms / 1.5s / 3s) because the runtime persists the turn
 * asynchronously — deliberately so, since that relay was moved off the turn's
 * critical path.
 *
 * The 150ms refresh therefore usually arrives BEFORE the turn is queryable, and
 * it replaces the message list with the server's. The existing helpers do not
 * cover this: `mergePendingOptimisticUserMessages` re-adds pending USER
 * messages, and `preserveDisplayedTurnOutputs` maps over the server list, so a
 * message missing from it is simply dropped. The turn vanishes and reappears
 * ~350ms later on the next refresh — the flicker users see at the end of every
 * response.
 *
 * User messages already have exactly this protection. This is the assistant
 * half of that symmetry: hold locally committed turns until the persisted turn
 * shows up, then let the server's copy win.
 */
export function preserveCommittedAssistantTurns(
  next: ChatMessage[],
  pending: ChatMessage[],
): ChatMessage[] {
  if (pending.length === 0) {
    return next;
  }
  const present = new Set(next.map((message) => message.id));
  // Anything the server now returns is authoritative — its copy carries
  // outputs, provenance and ids the local one never had, so a still-pending
  // turn is only appended while genuinely absent.
  const missing = pending.filter((message) => !present.has(message.id));
  if (missing.length === 0) {
    return next;
  }
  // Appended, not spliced: these are always the newest turn in the session, and
  // the refresh that dropped them is by definition missing the tail.
  return [...next, ...missing];
}

/**
 * Drop the turns the server has caught up on. Called with each refresh's
 * rendered history so the pending set stays bounded and a turn that was later
 * deleted server-side cannot be resurrected forever.
 */
export function settleCommittedAssistantTurns(
  pending: ChatMessage[],
  rendered: ChatMessage[],
): ChatMessage[] {
  if (pending.length === 0) {
    return pending;
  }
  const present = new Set(rendered.map((message) => message.id));
  return pending.filter((message) => !present.has(message.id));
}
