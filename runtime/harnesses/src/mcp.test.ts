import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHarnessMcpToolName,
  discoverHarnessMcpTools,
  harnessMcpToolNameAliases,
  mcpVaultKeysForServer,
  type HarnessMcpRuntimeLike,
  type HarnessMcpServerBinding,
  type HarnessMcpToolRef,
} from "./mcp.js";

test("mcpVaultKeysForServer matches the id exactly + as a hashed prefix, not a shared prefix", () => {
  const entries = {
    mcp_heygen_com: {},
    "mcp_heygen_com|abc123": {},
    "mcp_heygen_com|def456": {},
    // a DIFFERENT server whose id merely starts with the same text must NOT match
    "mcp_heygen_com_two|zzz": {},
    "other_server|q": {},
  };
  const keys = mcpVaultKeysForServer(entries, "mcp_heygen_com").sort();
  assert.deepEqual(keys, [
    "mcp_heygen_com",
    "mcp_heygen_com|abc123",
    "mcp_heygen_com|def456",
  ]);
});

test("harnessMcpToolNameAliases covers the sanitized and original-tool mcp__ forms", () => {
  const aliases = harnessMcpToolNameAliases("adspower-local-api", "get-group-list");
  // The Claude-SDK-style prefixed name a model like GLM emits (server sanitized,
  // original tool segment kept) — the exact failing name observed.
  assert.ok(aliases.includes("mcp__adspower_local_api__get-group-list"));
  // The fully-sanitized canonical form.
  assert.ok(aliases.includes(buildHarnessMcpToolName("adspower-local-api", "get-group-list")));
  assert.ok(aliases.includes("mcp__adspower_local_api__get_group_list"));
  // No duplicates.
  assert.equal(aliases.length, new Set(aliases).size);
});

test("harnessMcpToolNameAliases collapses when the tool needs no sanitizing", () => {
  // Underscored tool name → both forms coincide → a single alias.
  const aliases = harnessMcpToolNameAliases("srv", "do_thing");
  assert.deepEqual(aliases, ["mcp__srv__do_thing"]);
});

function httpBinding(serverId: string, timeoutMs = 50): HarnessMcpServerBinding {
  return {
    serverId,
    timeoutMs,
    description: serverId,
    transport: { kind: "http", url: "http://unused", headers: {} },
  };
}

function runtimeReturning(byServer: Record<string, string[]>): HarnessMcpRuntimeLike {
  return {
    async listTools(serverId) {
      return (byServer[serverId] ?? []).map((name) => ({ name }));
    },
  };
}

function ref(serverId: string, toolName: string): HarnessMcpToolRef {
  return { tool_id: `${serverId}.${toolName}`, server_id: serverId, tool_name: toolName };
}

// Keep the discovery loop from waiting out the real 10s deadline.
const fast = { retryIntervalMs: 5, maxWaitMs: 30 } as const;

// Regression guard for 021a1ea0: a REACHABLE server must keep the tools it did
// return even when some allowlisted tools never showed up. If the skip guard
// regresses to `failures.some(...)` (drop the whole server on any failure),
// `tools` collapses to [] and this test fails.
test("discoverHarnessMcpTools: reachable server keeps working tools when some declared tools are missing", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("cap__helper")],
    runtime: runtimeReturning({ cap__helper: ["echo", "add"] }), // server lacks "ghost"
    toolRefs: [ref("cap__helper", "echo"), ref("cap__helper", "add"), ref("cap__helper", "ghost")],
    ...fast,
  });

  assert.deepEqual(
    result.tools.map((tool) => tool.toolName).sort(),
    ["add", "echo"],
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].serverId, "cap__helper");
  assert.match(result.failures[0].reason, /not discovered/i);
  assert.deepEqual(result.failures[0].missingToolIds, ["cap__helper.ghost"]);
});

test("discoverHarnessMcpTools: an unreachable server contributes no tools and is reported", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("cap__down")],
    runtime: {
      async listTools() {
        throw new Error("connect ECONNREFUSED");
      },
    },
    toolRefs: [ref("cap__down", "echo")],
    ...fast,
  });

  assert.deepEqual(result.tools, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /unreachable/i);
  assert.deepEqual(result.failures[0].missingToolIds, ["cap__down.echo"]);
});

// A user-connected remote server has NO allowlist (its tools aren't known until
// discovery). Before, an unreachable one with no allowlist was dropped with no
// failure — so an OAuth-protected server (401) surfaced zero tools AND zero
// errors, and the agent reported "connected". Now it's reported, and a 401 is
// classified as authRequired so the UI can offer Authorize.
test("discoverHarnessMcpTools: no-allowlist server that 401s is reported as authRequired", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("heygen")],
    runtime: {
      async listTools() {
        throw new Error("HTTP 401 Unauthorized: Bearer token required");
      },
    },
    toolRefs: [], // user-connected server: no allowlist
    ...fast,
  });

  assert.deepEqual(result.tools, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].serverId, "heygen");
  assert.equal(result.failures[0].authRequired, true);
  assert.match(result.failures[0].reason, /authorization required/i);
});

test("discoverHarnessMcpTools: no-allowlist server that is unreachable is reported (not auth)", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("down")],
    runtime: {
      async listTools() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
      },
    },
    toolRefs: [],
    ...fast,
  });

  assert.deepEqual(result.tools, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].authRequired, false);
  assert.match(result.failures[0].reason, /unreachable/i);
});

test("discoverHarnessMcpTools: all declared tools present -> all returned, no failures", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("cap__ok")],
    runtime: runtimeReturning({ cap__ok: ["echo", "add"] }),
    toolRefs: [ref("cap__ok", "echo"), ref("cap__ok", "add")],
    ...fast,
  });

  assert.deepEqual(
    result.tools.map((tool) => tool.toolName).sort(),
    ["add", "echo"],
  );
  assert.deepEqual(result.failures, []);
});

// Cross-server isolation: a failing server must not take a healthy sibling's
// tools down with it (the bug treated failures globally per the shared list).
test("discoverHarnessMcpTools: one unreachable server does not knock out a healthy sibling", async () => {
  const result = await discoverHarnessMcpTools({
    bindings: [httpBinding("cap__good"), httpBinding("cap__bad")],
    runtime: {
      async listTools(serverId) {
        if (serverId === "cap__bad") {
          throw new Error("down");
        }
        return [{ name: "echo" }];
      },
    },
    toolRefs: [ref("cap__good", "echo"), ref("cap__bad", "echo")],
    ...fast,
  });

  assert.deepEqual(result.tools.map((tool) => tool.toolName), ["echo"]);
  assert.equal(result.tools[0].serverId, "cap__good");
  assert.deepEqual(
    result.failures.map((failure) => failure.serverId),
    ["cap__bad"],
  );
});
