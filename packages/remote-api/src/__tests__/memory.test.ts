import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { remoteApiRouter } from "../server/router";
import type { MemoryService } from "../server";

function makeMemory(): MemoryService {
  return {
    search: (input) => ({
      results: [{ path: "facts/x.md", score: 0.9 }],
      workspace_id: input.workspaceId,
      query: input.query,
    }),
    get: (input) => ({ workspace_id: input.workspaceId, content: "hello" }),
    upsert: (input) => ({ ok: true, path: input.path }),
    status: (input) => ({ workspace_id: input.workspaceId, entries: 3 }),
    sync: (input) => ({ workspace_id: input.workspaceId, synced: true }),
    browseTree: (input) => ({ root: { id: "root" }, workspace_id: input.workspaceId }),
    readFile: (input) => ({ path: input.path, content: "file body" }),
    readNodeDetail: (input) => ({ node_id: input.nodeId }),
    browseGraph: (input) => ({ forest: input.forest, nodes: [], edges: [] }),
  };
}

function makeClient() {
  return createRouterClient(remoteApiRouter, {
    context: {
      memory: makeMemory(),
      outputs: { list: () => ({ items: [] }) },
      notifications: {
        list: () => ({ items: [], count: 0 }),
        update: () => {
          throw new Error("not used");
        },
      },
      cronjobs: {
        list: () => ({ jobs: [], count: 0 }),
        runNow: () => {
          throw new Error("not used");
        },
        create: () => {
          throw new Error("not used");
        },
        update: () => {
          throw new Error("not used");
        },
        delete: () => ({ success: true }),
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
        catalog: () => ({ capabilities: [] }),
        listInstalled: () => ({ capabilities: [] }),
        install: () => {
          throw new Error("not used");
        },
        create: () => {
          throw new Error("not used");
        },
        importPlugin: () => {
          throw new Error("not used");
        },
        uninstall: () => ({ removed: false }),
        toggle: () => {
          throw new Error("not used");
        },
      },
    },
  });
}

describe("remoteApiRouter.memory", () => {
  it("searches and passes through the result", async () => {
    const client = makeClient();
    const result = await client.memory.search({ workspaceId: "ws_1", query: "deploy" });
    expect(result.query).toBe("deploy");
    expect(Array.isArray(result.results)).toBe(true);
  });

  it("upserts with the required path", async () => {
    const client = makeClient();
    const result = await client.memory.upsert({
      path: "facts/x.md",
      content: "note",
    });
    expect(result).toMatchObject({ ok: true, path: "facts/x.md" });
  });

  it("rejects a search missing the query (contract validation)", async () => {
    const client = makeClient();
    await expect(
      // @ts-expect-error query is required by the contract
      client.memory.search({})
    ).rejects.toBeTruthy();
  });

  it("reports status", async () => {
    const client = makeClient();
    const result = await client.memory.status({});
    expect(result.entries).toBe(3);
  });

  it("browses the memory tree", async () => {
    const client = makeClient();
    const result = await client.memory.browseTree({});
    expect(result).toMatchObject({ root: { id: "root" } });
  });

  it("reads a memory file via the browser surface", async () => {
    const client = makeClient();
    const result = await client.memory.readFile({
      path: "preference/x.md",
    });
    expect(result.content).toBe("file body");
  });
});
