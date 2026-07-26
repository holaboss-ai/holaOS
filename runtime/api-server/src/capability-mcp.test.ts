import assert from "node:assert/strict";
import { test } from "node:test";

import { capabilityMcpServerId } from "./capability-mcp.js";

test("capabilityMcpServerId namespaces the server id by capability", () => {
  assert.equal(
    capabilityMcpServerId("marketing-suite", "planner"),
    "marketing-suite__planner",
  );
});
