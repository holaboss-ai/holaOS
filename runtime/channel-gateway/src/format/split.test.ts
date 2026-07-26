import { test } from "node:test";
import assert from "node:assert/strict";

import { measure, splitMessage } from "./split.js";

test("text within the limit is returned unchanged", () => {
  assert.deepEqual(splitMessage("hello", 100), ["hello"]);
});

test("every chunk is within the limit", () => {
  const text = "word ".repeat(500).trim();
  const parts = splitMessage(text, 100);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(measure(part, "codepoints") <= 100, `chunk too long: ${part.length}`);
  }
  assert.equal(parts.join(""), text);
});

test("prefers to break at a paragraph boundary", () => {
  const text = "para one here\n\npara two here\n\npara three here";
  const parts = splitMessage(text, 20);
  // first chunk should end right after the first blank line, not mid-word
  assert.ok(parts[0]!.endsWith("\n\n") || parts[0]!.trimEnd() === "para one here");
});

test("a long unbroken line is hard-cut and reassembles", () => {
  const text = "x".repeat(250);
  const parts = splitMessage(text, 100);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), text);
});

test("does not split a surrogate pair under a utf16 limit", () => {
  // each 😀 is 2 UTF-16 units; an odd limit must not cut between surrogates
  const text = "😀".repeat(10);
  const parts = splitMessage(text, 5, "utf16");
  for (const part of parts) {
    assert.equal(part.length % 2, 0, "a surrogate pair was split");
  }
  assert.equal(parts.join(""), text);
});
