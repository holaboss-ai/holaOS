import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteApiMcpServer } from "../mcp";
import type { RemoteApiContext, RemoteApiIdentity } from "../server";

const notUsed = () => {
  throw new Error("not used");
};

function makeContext(identity?: RemoteApiIdentity): RemoteApiContext {
  return {
    memory: {
      search: notUsed,
      get: notUsed,
      upsert: notUsed,
      status: notUsed,
      sync: notUsed,
      browseTree: notUsed,
      readFile: notUsed,
      readNodeDetail: notUsed,
      browseGraph: notUsed,
    },
    outputs: {
      list: (input) => ({
        items: [
          {
            id: "out_1",
            workspace_id: "ws_1",
            output_type: "file",
            title: "hello.md",
            status: "ready",
            module_id: null,
            module_resource_id: null,
            file_path: "hello.md",
            html_content: null,
            session_id: null,
            project_id: null,
            input_id: null,
            artifact_id: null,
            folder_id: null,
            platform: null,
            metadata: {},
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    },
    notifications: { list: notUsed, update: notUsed },
    cronjobs: {
      list: notUsed,
      runNow: notUsed,
      create: notUsed,
      update: notUsed,
      delete: notUsed,
    },
    skills: {
      catalog: () => ({ skills: [] }),
      install: () => {
        throw new Error("not used");
      },
    },
    channels: {
      list: () => ({ channels: [], count: 0 }),
      validate: () => ({ ok: false, bot_username: null, error: null }),
      startDeviceAuth: () => ({ device_code: "", qr_url: "", interval_sec: 5, expires_in_sec: 600 }),
      pollDeviceAuth: () => ({ status: "pending" as const, connection: null }),
      create: () => {
        throw new Error("not used");
      },
      delete: () => ({ success: true }),
      setModel: () => {
        throw new Error("not used");
      },
      setHarness: () => {
        throw new Error("not used");
      },
      listSessions: () => ({ sessions: [], count: 0 }),
    },
    capabilities: {
      catalog: notUsed,
      listInstalled: notUsed,
      install: notUsed,
      create: notUsed,
      importPlugin: notUsed,
      uninstall: notUsed,
      toggle: notUsed,
    },
    identity,
  };
}

// A real Streamable-HTTP MCP endpoint over a localhost server, driven by a real
// MCP client transport — the closest thing to how an external client (Inspector,
// Claude Desktop, a 3rd-party agent) would reach the runtime once /mcp is mounted.
// Identity is fixed to ws_a so the authz middleware can be exercised over the wire.
let httpServer: http.Server;
let baseUrl: string;
let client: Client;

beforeAll(async () => {
  const server = createRemoteApiMcpServer({
    context: makeContext({ workspaceId: "ws_a", subject: "u1", scopes: [] }),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  httpServer = http.createServer((req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;

  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
});

afterAll(async () => {
  await client?.close();
  httpServer?.close();
});

describe("remote-api MCP binding over Streamable HTTP (e2e)", () => {
  it("advertises the tool to a real client over HTTP", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("outputs_list");
  });

  it("calls outputs_list over HTTP and gets the routed result", async () => {
    const result = await client.callTool({
      name: "outputs_list",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(JSON.parse(text).items[0].workspace_id).toBe("ws_1");
  });
});
