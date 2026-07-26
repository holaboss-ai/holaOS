import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildRuntimeApiServer } from "./app.js";

// The curated first-cut set exposed to CLI harnesses. Keep in sync with
// CURATED_RUNTIME_TOOL_IDS in runtime-tools-mcp.ts.
const EXPECTED_RUNTIME_TOOL_NAMES = [
  "web_search",
  "image_generate",
  "video_generate",
  "download_url",
  "write_report",
  "memory_retrieve",
  "cronjobs_list",
  "cronjobs_get",
  "cronjobs_create",
  "cronjobs_update",
  "cronjobs_delete",
  "cronjobs_run_now",
  "update_workspace_instructions",
  "skill",
  "workspace_integrations_list_catalog",
  "holaboss_workspace_integrations_propose_connect",
  "holaboss_workspace_integrations_set_default_account",
  "mcp_connect",
  "mcp_refresh",
  "open_macos_settings",
];

// Drives the runtime-tools MCP mount over Streamable HTTP against the real
// runtime: a real MCP client connects to /mcp/runtime-tools, lists tools, and
// asserts the curated runtime-tool surface is exposed with object input schemas
// (the parity path CLI harnesses use). Teardown order matters: the client holds
// an open stream, so it must close before the server.
test("runtime-tools MCP /mcp/runtime-tools exposes the curated runtime tools over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-tools-mcp-it-"));
  const app = buildRuntimeApiServer({
    workspaceRoot: path.join(root, "workspace"),
    dbPath: path.join(root, "runtime.db"),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "runtime-tools-mcp-it", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp/runtime-tools`),
      ),
    );

    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const expected of EXPECTED_RUNTIME_TOOL_NAMES) {
      assert.ok(names.has(expected), `missing runtime tool: ${expected}`);
    }
    // This surface is the runtime-tool set, not the oRPC read sliver.
    assert.ok(!names.has("outputs_list"));

    // Every tool must carry an object JSON Schema so CLI harness MCP clients can
    // materialize call arguments.
    for (const tool of tools) {
      assert.equal(
        (tool.inputSchema as { type?: string }).type,
        "object",
        `tool ${tool.name} must expose an object input schema`,
      );
    }
  } finally {
    await client.close();
    await app.close();
  }
});
