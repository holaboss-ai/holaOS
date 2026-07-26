import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repairPiSessionFileInPlace } from "./pi.js";

function withTempFile<T>(contents: string, fn: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-repair-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("repairs toolResult entries with missing content field", () => {
  const broken = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({
      type: "message",
      id: "a",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "b",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "notion_fetch_data",
        isError: false,
        timestamp: 1,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "c",
      message: { role: "assistant", content: null, stopReason: "stop" },
    }),
  ].join("\n");

  withTempFile(broken, (file) => {
    repairPiSessionFileInPlace(file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const entryB = JSON.parse(lines[2]!);
    const entryC = JSON.parse(lines[3]!);
    assert.ok(Array.isArray(entryB.message.content));
    assert.equal(entryB.message.content[0].type, "text");
    assert.ok(Array.isArray(entryC.message.content));
    assert.equal(entryC.message.content[0].type, "text");
  });
});

test("leaves valid messages untouched (idempotent on already-good files)", () => {
  const good = [
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    }),
  ].join("\n");
  withTempFile(good, (file) => {
    const before = fs.readFileSync(file, "utf8");
    repairPiSessionFileInPlace(file);
    repairPiSessionFileInPlace(file);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after, before);
  });
});

test("leaves string content alone (some providers send string content)", () => {
  const stringContent = [
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: "plain text reply" },
    }),
  ].join("\n");
  withTempFile(stringContent, (file) => {
    const before = fs.readFileSync(file, "utf8");
    repairPiSessionFileInPlace(file);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("skips non-message entries (session header, model_change, etc.)", () => {
  const headers = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "model_change", provider: "openai" }),
    JSON.stringify({ type: "thinking_level_change" }),
  ].join("\n");
  withTempFile(headers, (file) => {
    const before = fs.readFileSync(file, "utf8");
    repairPiSessionFileInPlace(file);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("handles malformed JSON lines without crashing", () => {
  const mixed = [
    "{not json",
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", toolCallId: "x", isError: false, timestamp: 0 },
    }),
    "",
  ].join("\n");
  withTempFile(mixed, (file) => {
    repairPiSessionFileInPlace(file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    assert.equal(lines[0], "{not json");
    const fixed = JSON.parse(lines[1]!);
    assert.ok(Array.isArray(fixed.message.content));
  });
});

test("no-op on missing file", () => {
  repairPiSessionFileInPlace(path.join(os.tmpdir(), "definitely-not-a-real-file.jsonl"));
});
