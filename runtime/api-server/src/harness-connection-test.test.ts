import assert from "node:assert/strict";
import test from "node:test";

import { parseConnectionResult } from "./harness-model-discovery.js";

test("parseConnectionResult reads the verdict from the last JSON line", () => {
  const out = [
    "[some harness log line]",
    JSON.stringify({ ok: true, detail: 'Responded: "OK"', duration_ms: 1234 }),
  ].join("\n");
  assert.deepEqual(parseConnectionResult(out), {
    ok: true,
    detail: 'Responded: "OK"',
    duration_ms: 1234,
  });
});

test("parseConnectionResult tolerates noise + missing fields", () => {
  const out = "not json\n{\"ok\":false}\ntrailing noise";
  assert.deepEqual(parseConnectionResult(out), {
    ok: false,
    detail: "",
    duration_ms: 0,
  });
});

test("parseConnectionResult returns null when there is no verdict line", () => {
  assert.equal(parseConnectionResult(""), null);
  assert.equal(parseConnectionResult("just logs\nmore logs"), null);
  // An object without a boolean `ok` is not a verdict.
  assert.equal(parseConnectionResult(JSON.stringify({ detail: "x" })), null);
});
