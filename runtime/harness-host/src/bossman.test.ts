import assert from "node:assert/strict";
import { test } from "node:test";

import { mapSdkMessage } from "./bossman.js";
import type { RunnerEventType } from "./contracts.js";

type Emitted = { type: RunnerEventType; payload: Record<string, unknown> };

function collector() {
  const events: Emitted[] = [];
  const emit = (type: RunnerEventType, payload: Record<string, unknown>) =>
    void events.push({ type, payload });
  return { events, emit };
}

function textStreamEvent(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function assistantText(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

test("stream_event text deltas are surfaced as output_delta and latch streamedPartialContent", () => {
  const { events, emit } = collector();
  const streamState = { streamedPartialContent: false };

  mapSdkMessage(textStreamEvent("Hel"), emit, null, new Map(), streamState);
  mapSdkMessage(textStreamEvent("lo"), emit, null, new Map(), streamState);

  assert.equal(streamState.streamedPartialContent, true);
  assert.deepEqual(
    events,
    [
      { type: "output_delta", payload: { delta: "Hel" } },
      { type: "output_delta", payload: { delta: "lo" } },
    ],
  );
});

test("thinking deltas stream via stream_event as thinking_delta", () => {
  const { events, emit } = collector();
  const streamState = { streamedPartialContent: false };
  mapSdkMessage(
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    },
    emit,
    null,
    new Map(),
    streamState,
  );
  assert.deepEqual(events, [{ type: "thinking_delta", payload: { delta: "hmm" } }]);
});

test("the aggregate assistant block does NOT re-emit text once partials streamed (no doubling)", () => {
  const { events, emit } = collector();
  const streamState = { streamedPartialContent: false };

  // Partial deltas stream the text first...
  mapSdkMessage(textStreamEvent("Hello"), emit, null, new Map(), streamState);
  // ...then the complete assistant message arrives with the same aggregate text.
  mapSdkMessage(assistantText("Hello"), emit, null, new Map(), streamState);

  // Only the streamed delta should have been emitted — not a second copy.
  assert.deepEqual(events, [{ type: "output_delta", payload: { delta: "Hello" } }]);
});

test("without any partial stream, the assistant block still emits text (fallback, never dropped)", () => {
  const { events, emit } = collector();
  const streamState = { streamedPartialContent: false };

  mapSdkMessage(assistantText("Complete answer"), emit, null, new Map(), streamState);

  assert.deepEqual(events, [
    { type: "output_delta", payload: { delta: "Complete answer" } },
  ]);
});

test("tool_use is emitted from the assistant block regardless of streaming state", () => {
  const { events, emit } = collector();
  const streamState = { streamedPartialContent: true };
  mapSdkMessage(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "already streamed" },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
        ],
      },
    },
    emit,
    null,
    new Map(),
    streamState,
  );
  // Text suppressed (already streamed), tool_use still surfaced.
  assert.deepEqual(events, [
    {
      type: "tool_call",
      payload: {
        tool_name: "bash",
        call_id: "call_1",
        tool_args: { command: "ls" },
        phase: "in_progress",
      },
    },
  ]);
});
