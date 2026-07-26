import assert from "node:assert/strict";
import { test } from "node:test";

import { composeMcp, foldKeyed } from "./mcp-compose.js";
import type { McpContribution } from "./mcp-compose.js";
import type { ResolvedMcpServerConfig, ResolvedMcpToolRef } from "./workspace-runtime-plan.js";

function server(serverId: string, url = `https://${serverId}`): ResolvedMcpServerConfig {
  return { server_id: serverId, type: "remote", command: [], url, headers: [], environment: [], timeout_ms: 10_000 };
}

function toolRef(serverId: string, toolName: string): ResolvedMcpToolRef {
  return { tool_id: `${serverId}.${toolName}`, server_id: serverId, tool_name: toolName };
}

function contribution(source: string, servers: ResolvedMcpServerConfig[], toolRefs: ResolvedMcpToolRef[]): McpContribution {
  return { source, servers, toolRefs };
}

test("compose: additive — keeps every distinct server/tool in source then declaration order", () => {
  const composed = composeMcp([
    contribution("workspace", [server("ws")], [toolRef("ws", "read")]),
    contribution("capability", [server("cap__x")], [toolRef("cap__x", "publish"), toolRef("cap__x", "list")]),
  ]);

  assert.deepEqual(
    composed.servers.map((s) => s.server_id),
    ["ws", "cap__x"],
  );
  assert.deepEqual(composed.allowlist, ["ws.read", "cap__x.publish", "cap__x.list"]);
});

test("compose: first-wins — a later source re-declaring a server/tool id is dropped, not displaced", () => {
  const composed = composeMcp([
    contribution("workspace", [server("shared", "https://existing")], [toolRef("shared", "go")]),
    contribution("capability", [server("shared", "https://override")], [toolRef("shared", "go")]),
  ]);

  assert.equal(composed.servers.length, 1);
  assert.equal(composed.servers[0].url, "https://existing");
  assert.equal(composed.toolRefs.length, 1);
  assert.equal(composed.serverSourceById.get("shared"), "workspace");
  assert.equal(composed.toolSourceById.get("shared.go"), "workspace");
});

test("compose: dedup within a single contribution is also first-wins", () => {
  const composed = composeMcp([
    contribution("capability", [server("a"), server("a", "https://dupe")], [toolRef("a", "t"), toolRef("a", "t")]),
  ]);

  assert.equal(composed.servers.length, 1);
  assert.equal(composed.servers[0].url, "https://a");
  assert.deepEqual(composed.allowlist, ["a.t"]);
});

test("compose: tags every kept entry with its contributing source", () => {
  const composed = composeMcp([
    contribution("workspace", [server("ws")], [toolRef("ws", "read")]),
    contribution("capability", [server("cap")], [toolRef("cap", "write")]),
  ]);

  assert.equal(composed.serverSourceById.get("ws"), "workspace");
  assert.equal(composed.serverSourceById.get("cap"), "capability");
  assert.equal(composed.toolSourceById.get("ws.read"), "workspace");
  assert.equal(composed.toolSourceById.get("cap.write"), "capability");
});

test("compose: empty input yields empty resolved set", () => {
  const composed = composeMcp([]);
  assert.deepEqual(composed.servers, []);
  assert.deepEqual(composed.toolRefs, []);
  assert.deepEqual(composed.allowlist, []);
});

test("foldKeyed first-wins: incumbent holds the slot, challenger dropped, source stays first", () => {
  const { values, sourceByKey } = foldKeyed<{ id: string; v: number }>(
    [
      { key: "a", value: { id: "a", v: 1 }, source: "x" },
      { key: "a", value: { id: "a", v: 2 }, source: "y" },
      { key: "b", value: { id: "b", v: 3 }, source: "y" },
    ],
    { mode: "first-wins" },
  );
  assert.deepEqual(values, [{ id: "a", v: 1 }, { id: "b", v: 3 }]);
  assert.equal(sourceByKey.get("a"), "x");
  assert.equal(sourceByKey.get("b"), "y");
});

test("foldKeyed last-wins: challenger replaces value + source but keeps first-seen position", () => {
  const { values, sourceByKey } = foldKeyed<{ id: string; v: number }>(
    [
      { key: "a", value: { id: "a", v: 1 }, source: "base" },
      { key: "b", value: { id: "b", v: 2 }, source: "base" },
      { key: "a", value: { id: "a", v: 9 }, source: "override" },
    ],
    { mode: "last-wins" },
  );
  assert.deepEqual(values, [{ id: "a", v: 9 }, { id: "b", v: 2 }]);
  assert.equal(sourceByKey.get("a"), "override");
});

test("foldKeyed last-wins with merge: kept value is merge(incumbent, challenger)", () => {
  const { values } = foldKeyed<{ id: string; tags: string[] }>(
    [
      { key: "a", value: { id: "a", tags: ["base"] }, source: "base" },
      { key: "a", value: { id: "a", tags: ["override"] }, source: "override" },
    ],
    { mode: "last-wins", merge: (incumbent, challenger) => ({ ...challenger, tags: [...incumbent.tags, ...challenger.tags] }) },
  );
  assert.deepEqual(values, [{ id: "a", tags: ["base", "override"] }]);
});

// Golden parity: the workspace-base + capability fold the capability merge
// performs must equal a plain additive concatenation with collisions dropped.
test("compose: reproduces capability-over-workspace additive merge", () => {
  const workspace = contribution(
    "workspace",
    [server("workspace", "")],
    [toolRef("twitter", "create_post")],
  );
  const capability = contribution(
    "capability",
    [server("x-poster__x", "https://mcp.example/sse")],
    [toolRef("x-poster__x", "publish")],
  );

  const composed = composeMcp([workspace, capability]);

  assert.deepEqual(
    composed.servers.map((s) => s.server_id),
    ["workspace", "x-poster__x"],
  );
  assert.deepEqual(composed.allowlist, ["twitter.create_post", "x-poster__x.publish"]);
});
