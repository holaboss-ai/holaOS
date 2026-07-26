// Covers the shared pi MCP tool-cache path helpers. This is the single source
// of truth for a cache file that harness-host WRITES and the api-server CLEARS
// (for the "Refresh MCP tools" capability), so the path derivation and the
// best-effort delete must both be pinned down here.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PI_MCP_TOOL_CACHE_FILE,
  clearPiMcpToolCache,
  piMcpToolCachePath,
} from "./pi-mcp-tool-cache-path.js";

test("piMcpToolCachePath lands under <workspace>/.holaboss/state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-cache-path-"));
  assert.equal(
    piMcpToolCachePath(dir),
    path.join(dir, ".holaboss", "state", PI_MCP_TOOL_CACHE_FILE),
  );
});

test("clearPiMcpToolCache removes the cache and its .tmp sibling, reporting prior existence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-cache-clear-"));
  const target = piMcpToolCachePath(dir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ hash: "abc", tools: [] }), "utf8");
  writeFileSync(`${target}.tmp`, "partial", "utf8");

  const existed = clearPiMcpToolCache(dir);

  assert.equal(existed, true, "reports the cache was present");
  assert.equal(existsSync(target), false, "cache file removed");
  assert.equal(existsSync(`${target}.tmp`), false, "interrupted .tmp removed");
});

test("clearPiMcpToolCache returns false when there is no cache (and never throws)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-cache-miss-"));
  assert.equal(clearPiMcpToolCache(dir), false);
  // A second call is still a clean no-op.
  assert.equal(clearPiMcpToolCache(dir), false);
});

test("clearPiMcpToolCache leaves unrelated files in the state dir intact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-cache-scope-"));
  const stateDir = path.dirname(piMcpToolCachePath(dir));
  mkdirSync(stateDir, { recursive: true });
  const sibling = path.join(stateDir, "runtime-config.json");
  writeFileSync(sibling, JSON.stringify({ keep: true }), "utf8");
  writeFileSync(piMcpToolCachePath(dir), "{}", "utf8");

  clearPiMcpToolCache(dir);

  assert.equal(existsSync(sibling), true, "unrelated state file preserved");
  assert.deepEqual(JSON.parse(readFileSync(sibling, "utf8")), { keep: true });
});
