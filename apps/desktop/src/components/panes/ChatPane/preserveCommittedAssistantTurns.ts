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
/**
 * Does this turn carry the execution trace that renders its "Worked for Ns"
 * anchor and Details disclosure?
 *
 * Mirrors the check the pane itself uses to decide a turn has execution
 * content (index.tsx, hasExecutionOnlyContent). The trace lives in either
 * shape: still-streaming turns accumulate `executionItems`, and a settled turn
 * has them folded into an `execution` segment.
 */
function hasExecutionTrace(message: ChatMessage): boolean {
  return (
    (message.executionItems?.length ?? 0) > 0 ||
    (message.segments?.some(
      (segment) => segment.kind === "execution" && segment.items.length > 0,
    ) ??
      false)
  );
}

export function preserveCommittedAssistantTurns(
  next: ChatMessage[],
  pending: ChatMessage[],
): ChatMessage[] {
  if (pending.length === 0) {
    return next;
  }
  const pendingById = new Map(pending.map((message) => [message.id, message]));
  // A turn can come back from the server PRESENT BUT BARE. The history render
  // rebuilds the execution trace from that turn's output events, and the
  // conversation refresh does not wait for them — so the server's copy arrives
  // carrying the text but no trace, and the "Worked for Ns" anchor and Details
  // disclosure disappear for a beat before the next rung fills them in. That is
  // the flicker at the end of a turn that survived preserving absent turns:
  // this one was never absent.
  //
  // While the server's copy is still missing a trace the local one has, the
  // local copy is the more complete record and keeps rendering. Substituted
  // whole rather than merged, so the trace keeps its original position relative
  // to the text — a turn that interleaves tools and prose would be reordered by
  // grafting segments back on.
  let substituted = false;
  const reconciled = next.map((message) => {
    const local = pendingById.get(message.id);
    if (!local || !hasExecutionTrace(local) || hasExecutionTrace(message)) {
      return message;
    }
    substituted = true;
    return local;
  });

  const present = new Set(next.map((message) => message.id));
  // Anything the server now returns is authoritative — its copy carries
  // outputs, provenance and ids the local one never had, so a still-pending
  // turn is only appended while genuinely absent.
  const missing = pending.filter((message) => !present.has(message.id));
  if (missing.length === 0) {
    return substituted ? reconciled : next;
  }
  // Appended, not spliced: these are always the newest turn in the session, and
  // the refresh that dropped them is by definition missing the tail.
  return [...reconciled, ...missing];
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
  const renderedById = new Map(rendered.map((message) => [message.id, message]));
  return pending.filter((message) => {
    const server = renderedById.get(message.id);
    if (!server) {
      return true;
    }
    // Present is not the same as caught up. Settling on id alone is what let
    // the trace blink out: the local copy was dropped while the server's still
    // had no execution events, leaving nothing to render the turn's chrome
    // from. Hold it until the server's copy actually carries the trace.
    return hasExecutionTrace(message) && !hasExecutionTrace(server);
  });
}
