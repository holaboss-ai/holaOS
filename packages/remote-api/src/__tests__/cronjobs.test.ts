import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { remoteApiRouter } from "../server/router";
import {
  CronjobsServiceError,
  type CronjobRecord,
  type CronjobsService,
  type RemoteApiContext,
} from "../server";

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

const outputsStub: RemoteApiContext["outputs"] = { list: () => ({ items: [] }) };
const notificationsStub: RemoteApiContext["notifications"] = {
  list: () => ({ items: [], count: 0 }),
  update: () => {
    throw new Error("not used");
  },
};

function makeRecord(overrides: Partial<CronjobRecord> = {}): CronjobRecord {
  return {
    id: "cj_1",
    workflow_id: "wf_1",
    workspace_id: "ws_1",
    initiated_by: "user",
    name: "Daily digest",
    cron: "0 9 * * *",
    description: "Send a digest",
    instruction: "Send a digest",
    enabled: true,
    delivery: { mode: "chat", channel: "default", to: null },
    metadata: {},
    last_run_at: null,
    next_run_at: null,
    run_count: 0,
    last_status: null,
    last_error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCronjobs(): CronjobsService {
  const record = makeRecord();
  const exists = (jobId: string) => jobId === record.id;
  return {
    list: () => ({ jobs: [record], count: 1 }),
    create: (input) =>
      makeRecord({ name: input.name ?? "Daily digest", cron: input.cron }),
    runNow: (input) => {
      if (!exists(input.jobId)) {
        throw new CronjobsServiceError("NOT_FOUND");
      }
      return {
        success: true,
        cronjob: record,
        session_id: null,
        notification_id: null,
      };
    },
    update: (input) => {
      if (!exists(input.jobId)) {
        throw new CronjobsServiceError("NOT_FOUND");
      }
      return makeRecord({ enabled: input.enabled ?? record.enabled });
    },
    delete: (input) => {
      if (!exists(input.jobId)) {
        throw new CronjobsServiceError("NOT_FOUND");
      }
      return { success: true };
    },
  };
}

function makeClient() {
  return createRouterClient(remoteApiRouter, {
    context: {
      memory: memoryStub,
      outputs: outputsStub,
      notifications: notificationsStub,
      cronjobs: makeCronjobs(),
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

describe("remoteApiRouter.cronjobs", () => {
  it("lists cronjobs with a count", async () => {
    const client = makeClient();
    const result = await client.cronjobs.list({});
    expect(result.count).toBe(1);
    expect(result.jobs[0]?.id).toBe("cj_1");
  });

  it("runs a cronjob now", async () => {
    const client = makeClient();
    const result = await client.cronjobs.runNow({ jobId: "cj_1" });
    expect(result.success).toBe(true);
    expect(result.cronjob.id).toBe("cj_1");
  });

  it("updates a cronjob's enabled flag", async () => {
    const client = makeClient();
    const result = await client.cronjobs.update({
      jobId: "cj_1",
      enabled: false,
    });
    expect(result.enabled).toBe(false);
  });

  it("deletes a cronjob", async () => {
    const client = makeClient();
    const result = await client.cronjobs.delete({ jobId: "cj_1" });
    expect(result.success).toBe(true);
  });

  it("maps an unknown id to a typed NOT_FOUND error", async () => {
    const client = makeClient();
    try {
      await client.cronjobs.delete({ jobId: "missing" });
      throw new Error("expected NOT_FOUND");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("NOT_FOUND");
    }
  });
});
