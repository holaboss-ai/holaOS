import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { RemoteApiContext, RemoteApiIdentity } from "../server";
import { remoteApiRouter } from "../server/router";

const notUsed = () => {
  throw new Error("not used");
};

function makeClient(identity?: RemoteApiIdentity) {
  const context: RemoteApiContext = {
    memory: {
      search: (input) => ({ ok: true, workspaceId: input.workspaceId }),
      get: notUsed,
      upsert: notUsed,
      status: notUsed,
      sync: notUsed,
      browseTree: notUsed,
      readFile: notUsed,
      readNodeDetail: notUsed,
      browseGraph: notUsed,
    },
    outputs: { list: notUsed },
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
      importUpload: () => {
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
  return createRouterClient(remoteApiRouter, { context });
}

describe("remoteApiRouter authz seam", () => {
  it("no-ops when no identity is present (in-process path)", async () => {
    const client = makeClient();
    const result = await client.memory.search({ workspaceId: "ws_b", query: "x" });
    expect(result).toMatchObject({ ok: true });
  });

  it("allows a call whose workspaceId matches the identity", async () => {
    const client = makeClient({ workspaceId: "ws_a", subject: "u1", scopes: [] });
    const result = await client.memory.search({ workspaceId: "ws_a", query: "x" });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a call for a workspace the identity is not authorized for", async () => {
    const client = makeClient({ workspaceId: "ws_a", subject: "u1", scopes: [] });
    await expect(
      client.memory.search({ workspaceId: "ws_b", query: "x" })
    ).rejects.toThrow();
  });
});
