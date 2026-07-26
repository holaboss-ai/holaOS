import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
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

async function connect(context: RemoteApiContext) {
  const server = createRemoteApiMcpServer({ context });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("remote-api MCP binding", () => {
  it("lists the exposed tools", async () => {
    const client = await connect(makeContext());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("outputs_list");
  });

  it("invokes outputs_list through the oRPC router in-process", async () => {
    const client = await connect(makeContext());
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
