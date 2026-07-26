import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { remoteApiRouter } from "../server/router";
import type { OutputsService, RemoteApiContext } from "../server";

const memoryStub: RemoteApiContext["memory"] = {
  search: () => ({}),
  get: () => ({}),
  upsert: () => ({}),
  status: () => ({}),
  sync: () => ({}),
  browseTree: () => ({}),
  readFile: () => ({}),
  readNodeDetail: () => ({}),
  browseGraph: () => ({}),
};

function makeOutputs(): OutputsService {
  return {
    list: (input) => ({
      items: [
        {
          id: "out_1",
          workspace_id: "ws_1",
          output_type: "document",
          title: "Doc",
          status: "ready",
          module_id: null,
          module_resource_id: null,
          file_path: null,
          html_content: null,
          session_id: input.sessionId ?? null,
          project_id: null,
          input_id: input.inputId ?? null,
          artifact_id: null,
          folder_id: input.folderId ?? null,
          platform: input.platform ?? null,
          metadata: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  };
}

function makeClient() {
  return createRouterClient(remoteApiRouter, {
    context: {
      memory: memoryStub,
      outputs: makeOutputs(),
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

describe("remoteApiRouter.outputs", () => {
  it("lists outputs and echoes workspace-scoped filters", async () => {
    const client = makeClient();
    const result = await client.outputs.list({ sessionId: "s_1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.workspace_id).toBe("ws_1");
    expect(result.items[0]?.session_id).toBe("s_1");
  });
});
