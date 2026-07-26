import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  piMcpServersForceRefresh,
  piMcpToolCacheKey,
  readPiMcpToolCache,
  writePiMcpToolCache,
} from "./pi-mcp-tool-cache.js";

const sampleTools = [
  {
    harnessToolName: "gofunds_list_markets",
    serverId: "gofunds",
    toolId: "gofunds.list_markets",
    toolName: "list_markets",
    description: "List markets",
    inputSchema: { type: "object", properties: {} },
    timeoutMs: 60000,
  },
];

test("piMcpToolCacheKey is stable across key order and sensitive to changes", () => {
  const a = piMcpToolCacheKey(
    [{ name: "gofunds", config: { url: "https://x/mcp", enabled: true } }],
    [{ server_id: "gofunds", tool_id: "gofunds.list_markets" }],
  );
  // Same data, different key order -> same hash.
  const b = piMcpToolCacheKey(
    [{ name: "gofunds", config: { enabled: true, url: "https://x/mcp" } }],
    [{ tool_id: "gofunds.list_markets", server_id: "gofunds" }],
  );
  assert.equal(a, b);
  // Different server url -> different hash.
  const c = piMcpToolCacheKey(
    [{ name: "gofunds", config: { url: "https://y/mcp", enabled: true } }],
    [{ server_id: "gofunds", tool_id: "gofunds.list_markets" }],
  );
  assert.notEqual(a, c);
  // Different allowlist -> different hash.
  const d = piMcpToolCacheKey(
    [{ name: "gofunds", config: { url: "https://x/mcp", enabled: true } }],
    [{ server_id: "gofunds", tool_id: "gofunds.get_market" }],
  );
  assert.notEqual(a, d);
});

test("piMcpServersForceRefresh detects the force-refresh flag", () => {
  assert.equal(piMcpServersForceRefresh([{ name: "gofunds", config: {} }]), false);
  assert.equal(
    piMcpServersForceRefresh([
      { name: "gofunds", config: {} },
      { name: "app", config: {}, _holaboss_force_refresh: true },
    ]),
    true,
  );
});

test("writePiMcpToolCache / readPiMcpToolCache round-trip and invalidate on key mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-"));
  try {
    const key = "abc123";
    assert.equal(readPiMcpToolCache(dir, key), null); // no file yet
    writePiMcpToolCache(dir, key, sampleTools);
    const hit = readPiMcpToolCache(dir, key);
    assert.deepEqual(hit, sampleTools);
    // A different key (config changed) misses, even though a file exists.
    assert.equal(readPiMcpToolCache(dir, "different-key"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
