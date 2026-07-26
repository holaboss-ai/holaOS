import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { remoteApiRouter } from "../server/router";
import {
  NotificationsServiceError,
  type NotificationsService,
  type NotificationRecord,
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

const outputsStub: RemoteApiContext["outputs"] = {
  list: () => ({ items: [] }),
};

function makeRecord(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "ntf_1",
    workspace_id: "ws_1",
    cronjob_id: null,
    workflow_id: null,
    workflow_run_id: null,
    workflow_trigger_kind: null,
    source_type: "agent",
    source_label: null,
    title: "Done",
    message: "Run finished",
    level: "info",
    priority: "normal",
    state: "unread",
    metadata: {},
    read_at: null,
    dismissed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeNotifications(): NotificationsService {
  const record = makeRecord();
  return {
    list: (input) => ({
      items: input.includeDismissed ? [record, makeRecord({ id: "ntf_2", state: "dismissed" })] : [record],
      count: input.includeDismissed ? 2 : 1,
    }),
    update: (input) => {
      if (input.notificationId !== record.id) {
        throw new NotificationsServiceError("NOT_FOUND");
      }
      return makeRecord({ state: input.state ?? "unread" });
    },
  };
}

function makeClient() {
  return createRouterClient(remoteApiRouter, {
    context: {
      memory: memoryStub,
      outputs: outputsStub,
      notifications: makeNotifications(),
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

describe("remoteApiRouter.notifications", () => {
  it("lists notifications (global, no workspaceId) with a count", async () => {
    const client = makeClient();
    const result = await client.notifications.list({ includeCronjobSource: true });
    expect(result.count).toBe(1);
    expect(result.items[0]?.id).toBe("ntf_1");
  });

  it("includes dismissed when asked", async () => {
    const client = makeClient();
    const result = await client.notifications.list({ includeDismissed: true });
    expect(result.count).toBe(2);
  });

  it("updates a notification state", async () => {
    const client = makeClient();
    const result = await client.notifications.update({
      notificationId: "ntf_1",
      state: "read",
    });
    expect(result.state).toBe("read");
  });

  it("maps an unknown id to a typed NOT_FOUND error", async () => {
    const client = makeClient();
    try {
      await client.notifications.update({
        notificationId: "missing",
        state: "read",
      });
      throw new Error("expected NOT_FOUND");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("NOT_FOUND");
    }
  });
});
