import test from "node:test";
import assert from "node:assert/strict";

import {
  readSseStream,
  tryParseInvalidationFrame,
} from "./composio-events-bridge.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test("tryParseInvalidationFrame extracts connection_id + event_type", () => {
  const parsed = tryParseInvalidationFrame(
    JSON.stringify({
      type: "connection.invalidated",
      connection_id: "ca_abc",
      event_type: "composio.connected_account.expired",
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.connection_id, "ca_abc");
  assert.equal(parsed?.event_type, "composio.connected_account.expired");
  assert.equal(parsed?.type, "connection.invalidated");
  assert.equal(typeof parsed?.received_at, "number");
});

test("tryParseInvalidationFrame rejects unrelated frames", () => {
  assert.equal(tryParseInvalidationFrame("not json"), null);
  assert.equal(tryParseInvalidationFrame(JSON.stringify({})), null);
  assert.equal(
    tryParseInvalidationFrame(
      JSON.stringify({ type: "something.else", connection_id: "ca_abc" }),
    ),
    null,
  );
  assert.equal(
    tryParseInvalidationFrame(
      JSON.stringify({ type: "connection.invalidated" }),
    ),
    null,
  );
});

test("readSseStream ignores keep-alive comments + emits data frames", async () => {
  const frames: string[] = [];
  const stream = streamFrom([
    ": connected\n\n",
    'data: {"type":"connection.invalidated","connection_id":"ca_1","event_type":"composio.connected_account.expired"}\n\n',
    'data: {"type":"connection.invalidated","connection_id":"ca_2","event_type":"composio.connected_account.updated"}\n\n',
  ]);
  await readSseStream(stream, (data) => frames.push(data));
  assert.equal(frames.length, 2);
  assert.equal(JSON.parse(frames[0]).connection_id, "ca_1");
  assert.equal(JSON.parse(frames[1]).connection_id, "ca_2");
});

test("readSseStream stitches data lines split across chunks", async () => {
  const frames: string[] = [];
  // The chunk boundary cuts the JSON body in half — the parser must hold the
  // incomplete event in its buffer until the terminating blank line arrives.
  const stream = streamFrom([
    'data: {"type":"connection.inval',
    'idated","connection_id":"ca_1","event_type":"composio.connected_account.expired"}\n\n',
  ]);
  await readSseStream(stream, (data) => frames.push(data));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0]).connection_id, "ca_1");
});

test("readSseStream supports CRLF line endings + multi-line data", async () => {
  const frames: string[] = [];
  const stream = streamFrom([
    "data: line-one\r\ndata: line-two\r\n\r\n",
  ]);
  await readSseStream(stream, (data) => frames.push(data));
  assert.equal(frames.length, 1);
  assert.equal(frames[0], "line-one\nline-two");
});
