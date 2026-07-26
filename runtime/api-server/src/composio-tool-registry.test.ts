import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolkitCatalogFromUpstream,
  type ComposioUpstreamTool,
} from "./composio-tool-registry.js";

function tool(slug: string): ComposioUpstreamTool {
  return {
    slug,
    name: slug,
    description: slug,
    input_schema: { type: "object", properties: {} },
    read_only: slug.startsWith("GET_") || slug.startsWith("LIST_"),
  };
}

test("preload keeps write/action tools even when reads dominate", () => {
  // 20 read tools ahead of the writes — the old read-first top-16 would have
  // preloaded zero writes.
  const reads = Array.from({ length: 20 }, (_, i) => tool(`GET_ITEM_${i}`));
  const writes = [
    tool("CREATE_ISSUE"),
    tool("SEND_MESSAGE"),
    tool("UPDATE_RECORD"),
  ];
  const entries = buildToolkitCatalogFromUpstream("github", "acc_1", [
    ...reads,
    ...writes,
  ]);

  const preloadedWriteSlugs = entries
    .map((e) => e.tool_slug)
    .filter((slug) => !(slug.startsWith("GET_") || slug.startsWith("LIST_")));

  assert.ok(
    preloadedWriteSlugs.includes("CREATE_ISSUE"),
    "write tools must be preloaded, not starved by reads",
  );
  assert.equal(preloadedWriteSlugs.length, 3);
});

test("preload preserves upstream order within each category", () => {
  const upstream = [tool("GET_B"), tool("GET_A"), tool("CREATE_Z")];
  const entries = buildToolkitCatalogFromUpstream("x", "acc", upstream);
  // Reads keep upstream order (B before A), not alphabetical.
  assert.deepEqual(
    entries.map((e) => e.tool_slug),
    ["GET_B", "GET_A", "CREATE_Z"],
  );
});

test("preload backfills toward the total when one category is short", () => {
  // Only reads present — should still fill up to the total from reads.
  const reads = Array.from({ length: 30 }, (_, i) => tool(`LIST_${i}`));
  const entries = buildToolkitCatalogFromUpstream("x", "acc", reads);
  assert.equal(entries.length, 24);
});

test("preload caps the total", () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0 ? tool(`GET_${i}`) : tool(`CREATE_${i}`),
  );
  const entries = buildToolkitCatalogFromUpstream("x", "acc", many);
  assert.equal(entries.length, 24);
});
