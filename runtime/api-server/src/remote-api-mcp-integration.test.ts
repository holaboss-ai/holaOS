import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildRuntimeApiServer } from "./app.js";

// Drives the MCP binding over Streamable HTTP against the real runtime: a real
// MCP client connects to /mcp on the booted server, lists tools, and calls
// outputs_list — which routes through the same oRPC router + store as /rpc.
// Teardown order matters: the client holds an open SSE stream to /mcp, so it
// must close before the server (else Fastify's close blocks on the connection).
test("remote-api MCP /mcp round-trips against the real runtime over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remote-api-mcp-it-"));
  const app = buildRuntimeApiServer({
    workspaceRoot: path.join(root, "workspace"),
    dbPath: path.join(root, "runtime.db"),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "mcp-it", version: "0.0.0" });
  try {
    // Single-tenant runtime: workspace CRUD was removed; the server exposes one
    // synthetic root workspace. Resolve its id instead of creating one.
    const listedWorkspaces = await fetch(`${baseUrl}/api/v1/workspaces`).then(
      (response) => response.json(),
    );
    const workspaceId = listedWorkspaces.items[0]?.id as string;
    assert.ok(workspaceId);

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)),
    );

    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "outputs_list"));

    const result = await client.callTool({
      name: "outputs_list",
      arguments: { workspaceId },
    });
    assert.notEqual(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    assert.ok(Array.isArray(parsed.items));
  } finally {
    await client.close();
    await app.close();
  }
});
