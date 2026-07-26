import assert from "node:assert/strict";
import test from "node:test";

import { boundedMcpToolContent } from "./runtime-tools-mcp.js";

test("boundedMcpToolContent forwards content and drops details (the raw-payload leak)", () => {
  const result = {
    content: [{ type: "text", text: "compacted preview (8KB)" }],
    details: { raw: "X".repeat(400_000), model_result_bytes: 24 },
  };
  const out = boundedMcpToolContent(result);
  assert.deepEqual(out, [{ type: "text", text: "compacted preview (8KB)" }]);
  // The 400KB details.raw must NOT appear anywhere.
  assert.ok(!out[0]!.text.includes("XXXX"), "details.raw leaked into content");
});

test("boundedMcpToolContent joins multiple content text parts", () => {
  const out = boundedMcpToolContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  assert.equal(out[0]!.text, "a\nb");
});

test("boundedMcpToolContent serializes a content-less object but strips details", () => {
  const out = boundedMcpToolContent({ ok: true, value: 42, details: { raw: "secret".repeat(1000) } });
  assert.equal(out[0]!.text, JSON.stringify({ ok: true, value: 42 }));
  assert.ok(!out[0]!.text.includes("secret"));
});

test("boundedMcpToolContent passes strings through", () => {
  assert.deepEqual(boundedMcpToolContent("hello"), [{ type: "text", text: "hello" }]);
});

test("boundedMcpToolContent caps oversized content with a truncation note", () => {
  const big = "y".repeat(200_000);
  const out = boundedMcpToolContent({ content: [{ type: "text", text: big }] }, 50 * 1024);
  const bytes = Buffer.byteLength(out[0]!.text, "utf8");
  assert.ok(bytes <= 50 * 1024, `capped to <=50KB, got ${bytes}`);
  assert.match(out[0]!.text, /Tool output truncated: exceeded the 50KB per-call cap/);
});

test("boundedMcpToolContent leaves small results untouched", () => {
  const out = boundedMcpToolContent({ content: [{ type: "text", text: "small" }] }, 50 * 1024);
  assert.equal(out[0]!.text, "small");
});
