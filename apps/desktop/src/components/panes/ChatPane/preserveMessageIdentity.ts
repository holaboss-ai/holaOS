import type { ChatMessage } from "./types";

/**
 * Return the PREVIOUS object for any message whose content is unchanged.
 *
 * Every conversation refresh rebuilds the whole message list from raw payloads,
 * so even a turn that has not changed in an hour comes back as a brand-new
 * object with brand-new `segments` / `outputs` / `executionItems` arrays. That
 * defeats memoization from the top down:
 *
 *  - `displayMessages` is `useMemo`'d on `[messages]`, and `messages` is a new
 *    array every time, so the memo never holds.
 *  - `AssistantTurn` is wrapped in `React.memo` with a comparator that compares
 *    those props BY REFERENCE, so every message re-renders on every refresh —
 *    re-running markdown and syntax highlighting for the entire conversation.
 *
 * Making the comparator smarter cannot fix that; the inputs genuinely are new
 * objects. The fix is upstream: hand back the object React already has when
 * nothing about it changed. Then the reference comparisons start succeeding and
 * the existing memoization does what it was written to do.
 *
 * Returns the previous ARRAY too when every message was preserved, so the
 * `useMemo` above it also holds and a no-op refresh costs no re-render at all.
 */
export function preserveMessageIdentity(
  next: ChatMessage[],
  prev: ChatMessage[],
): ChatMessage[] {
  if (prev.length === 0 || next.length === 0) {
    return next;
  }
  const prevById = new Map<string, ChatMessage>();
  for (const message of prev) {
    prevById.set(message.id, message);
  }

  let changed = false;
  const merged = next.map((message) => {
    const previous = prevById.get(message.id);
    if (previous && previous !== message && isSameRenderedMessage(previous, message)) {
      return previous;
    }
    if (previous !== message) {
      changed = true;
    }
    return message;
  });

  // Same messages, same order → hand back the array React already has.
  if (!changed && merged.length === prev.length) {
    let identical = true;
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== prev[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return prev;
    }
  }
  return merged;
}

/**
 * Structural equality over what a turn actually renders.
 *
 * Compared by serialization rather than field-by-field on purpose: a turn's
 * shape keeps growing (segments, executionItems, outputs, pendingIntegrations,
 * mcpAuthorizations, publishedPosts, backgroundTaskReferences…) and a
 * hand-written comparison silently rots into "equal" for whichever field was
 * added last — which would pin stale content on screen. Being wrong in that
 * direction is far worse than the comparison cost, which is proportional to the
 * message we just built anyway, and is paid once per refresh instead of once
 * per render.
 */
function isSameRenderedMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id !== b.id || a.role !== b.role) {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Non-serializable (cyclic) message: treat as changed rather than risk
    // pinning stale content.
    return false;
  }
}
