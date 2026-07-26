import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { CapabilitiesService, RemoteApiContext } from "../server";
import { CapabilitiesServiceError } from "../server";
import { remoteApiRouter } from "../server/router";

const notUsed = () => {
  throw new Error("not used");
};

const memoryStub: RemoteApiContext["memory"] = {
  search: notUsed,
  get: notUsed,
  upsert: notUsed,
  status: notUsed,
  sync: notUsed,
  browseTree: notUsed,
  readFile: notUsed,
  readNodeDetail: notUsed,
  browseGraph: notUsed,
};

function makeWorkspaceCapability(workspaceId: string, capabilityId: string) {
  return {
    workspaceId,
    capabilityId,
    version: "1.0.0",
    name: "Test Capability",
    description: "desc",
    icon: null,
    status: "active",
    installedSkillIds: ["skill_1"],
    integrationStatus: { twitter: "connected" },
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeCapabilities(): CapabilitiesService {
  return {
    catalog: () => ({
      capabilities: [
        {
          id: "capability_1",
          name: "Test Capability",
          description: "desc",
          skills: [{ path: "skills/a/SKILL.md" }, { ref: "shared-skill" }],
          integrations: [{ provider: "twitter", required: true }],
        },
      ],
    }),
    listInstalled: (input) => ({
      capabilities: [makeWorkspaceCapability("ws_1", "capability_1")],
    }),
    install: (input) => makeWorkspaceCapability("ws_1", input.capabilityId),
    create: (input) =>
      makeWorkspaceCapability(
        "ws_1",
        input.name.toLowerCase().replace(/\s+/g, "-"),
      ),
    importPlugin: () => makeWorkspaceCapability("ws_1", "imported-plugin"),
    uninstall: () => ({ removed: true }),
    toggle: (input) => makeWorkspaceCapability("ws_1", input.capabilityId),
  };
}

function makeClient(capabilities: CapabilitiesService) {
  return createRouterClient(remoteApiRouter, {
    context: {
      memory: memoryStub,
      outputs: { list: () => ({ items: [] }) },
      notifications: { list: () => ({ items: [], count: 0 }), update: notUsed },
      cronjobs: {
        list: () => ({ jobs: [], count: 0 }),
        runNow: notUsed,
        create: notUsed,
        update: notUsed,
        delete: () => ({ success: true }),
      },
      skills: {
        catalog: () => ({ skills: [] }),
        install: notUsed,
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
      capabilities,
    },
  });
}

describe("remoteApiRouter.capabilities", () => {
  it("returns the catalog with skill refs of both kinds", async () => {
    const client = makeClient(makeCapabilities());
    const result = await client.capabilities.catalog({});
    expect(result.capabilities).toHaveLength(1);
    expect(result.capabilities[0]?.skills).toEqual([
      { path: "skills/a/SKILL.md" },
      { ref: "shared-skill" },
    ]);
  });

  it("lists installed capabilities scoped to the workspace", async () => {
    const client = makeClient(makeCapabilities());
    const result = await client.capabilities.listInstalled({});
    expect(result.capabilities[0]?.workspaceId).toBe("ws_1");
  });

  it("installs and toggles, returning the workspace capability record", async () => {
    const client = makeClient(makeCapabilities());
    const installed = await client.capabilities.install({
      capabilityId: "capability_1",
    });
    expect(installed.capabilityId).toBe("capability_1");
    const toggled = await client.capabilities.toggle({
      capabilityId: "capability_1",
      enabled: false,
    });
    expect(toggled.capabilityId).toBe("capability_1");
  });

  it("uninstalls and reports removal", async () => {
    const client = makeClient(makeCapabilities());
    const result = await client.capabilities.uninstall({
      capabilityId: "capability_1",
    });
    expect(result.removed).toBe(true);
  });

  it("maps CapabilitiesServiceError NOT_FOUND to a typed install error", async () => {
    const client = makeClient({
      ...makeCapabilities(),
      install: () => {
        throw new CapabilitiesServiceError("NOT_FOUND");
      },
    });
    await expect(
      client.capabilities.install({ capabilityId: "missing" })
    ).rejects.toBeTruthy();
  });
});
