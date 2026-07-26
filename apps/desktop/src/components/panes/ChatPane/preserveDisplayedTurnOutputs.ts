import type { ChatMessage } from "./types";

// Output cards aren't intrinsic to a committed turn — they're re-derived from
// the artifact pool on every conversation refresh. While a later run is
// streaming, that pool can be transiently incomplete (the background artifact
// refetch bails so it won't clobber the live turn), so a refresh would rebuild
// an earlier turn with empty outputs and its card would vanish mid-run. Keep an
// already-displayed turn's outputs when the fresh derivation has none for it.
export function preserveDisplayedTurnOutputs(
  next: ChatMessage[],
  prev: ChatMessage[],
): ChatMessage[] {
  const prevOutputsById = new Map<string, WorkspaceOutputRecordPayload[]>();
  for (const message of prev) {
    if (
      message.role === "assistant" &&
      message.outputs &&
      message.outputs.length > 0
    ) {
      prevOutputsById.set(message.id, message.outputs);
    }
  }
  if (prevOutputsById.size === 0) {
    return next;
  }
  return next.map((message) => {
    if (
      message.role === "assistant" &&
      (!message.outputs || message.outputs.length === 0)
    ) {
      const preserved = prevOutputsById.get(message.id);
      if (preserved) {
        return { ...message, outputs: preserved };
      }
    }
    return message;
  });
}
