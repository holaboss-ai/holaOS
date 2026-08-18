import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const piSourcePath = path.join(__dirname, "pi.ts");

/**
 * STRUCTURAL guard, deliberately.
 *
 * The four setup stages are module-level imports called inside createSession,
 * and PiDeps only lets a caller replace createSession wholesale — so there is
 * no seam to observe their concurrency from a test. What can be pinned is the
 * shape: they must sit in one Promise.all. Re-introducing a sequential `await`
 * is the regression this exists to catch, and it is a one-character change
 * away at all times.
 */

const PARALLEL_SETUP_STAGES = [
  "mcp_connect",
  "runtime_tools",
  "composio_inline",
  "web_search",
];

test("the independent session-setup stages run concurrently", () => {
  const source = fs.readFileSync(piSourcePath, "utf8");

  const start = source.indexOf("await Promise.all([");
  assert.notEqual(start, -1, "session setup no longer uses Promise.all");
  const block = source.slice(start, source.indexOf("\n    ]);", start));

  for (const stage of PARALLEL_SETUP_STAGES) {
    assert.ok(
      block.includes(`timedSetup("${stage}"`),
      `${stage} is no longer part of the concurrent setup batch`,
    );
  }
});

test("no setup stage was re-serialized with its own await", () => {
  const source = fs.readFileSync(piSourcePath, "utf8");

  // `await timedSetup("mcp_connect", …)` outside the batch means someone put
  // it back on the critical path. resource_reload and browser_tools are
  // deliberately not in the batch, so they are not checked here.
  for (const stage of PARALLEL_SETUP_STAGES) {
    assert.ok(
      !source.includes(`await timedSetup("${stage}"`),
      `${stage} is awaited on its own again — session_setup pays the sum, not the max`,
    );
  }
});
