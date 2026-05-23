import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import {
  RuntimeIntegrationContextAutofetchWorker,
} from "./integration-context-autofetch-worker.js";

function buildConnection(params: {
  connectionId: string;
  providerId: string;
  enabled?: boolean;
  status?: string;
  lastAttemptedAt?: string | null;
  createdAt?: string;
}): IntegrationConnectionRecord {
  return {
    connectionId: params.connectionId,
    providerId: params.providerId,
    ownerUserId: "user-1",
    accountLabel: params.connectionId,
    accountExternalId: `ca_${params.connectionId}`,
    accountHandle: null,
    accountEmail: null,
    contextCronAutoFetchEnabled: params.enabled ?? true,
    lastContextFetchAttemptedAt: params.lastAttemptedAt ?? null,
    lastContextFetchCompletedAt: null,
    lastContextFetchStatus: null,
    authMode: "composio",
    grantedScopes: [],
    status: params.status ?? "active",
    secretRef: null,
    createdAt: params.createdAt ?? "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}

function createStore(
  connections: IntegrationConnectionRecord[],
): RuntimeStateStore {
  return {
    listIntegrationConnections() {
      return connections;
    },
  } as unknown as RuntimeStateStore;
}

test("integration context autofetch worker starts only due supported enabled connections", async () => {
  const started: string[] = [];
  const worker = new RuntimeIntegrationContextAutofetchWorker({
    store: createStore([
      buildConnection({
        connectionId: "gmail-due",
        providerId: "gmail",
        lastAttemptedAt: "2026-05-22T00:00:00.000Z",
      }),
      buildConnection({
        connectionId: "slack-new",
        providerId: "slack",
        lastAttemptedAt: "2026-05-22T00:45:00.000Z",
      }),
      buildConnection({
        connectionId: "github-disabled",
        providerId: "github",
        enabled: false,
        lastAttemptedAt: "2026-05-22T00:00:00.000Z",
      }),
      buildConnection({
        connectionId: "notion-due",
        providerId: "notion",
        lastAttemptedAt: "2026-05-22T00:00:00.000Z",
      }),
      buildConnection({
        connectionId: "gmail-inactive",
        providerId: "gmail",
        status: "inactive",
        lastAttemptedAt: "2026-05-22T00:00:00.000Z",
      }),
      buildConnection({
        connectionId: "github-never-fetched",
        providerId: "github",
        lastAttemptedAt: null,
        createdAt: "2026-05-22T00:00:00.000Z",
      }),
    ]),
    fetchManager: {
      async start({ connectionId }) {
        started.push(connectionId);
        return {
          ok: true,
          started: true,
          deduped: false,
        };
      },
    },
    pollIntervalMs: 60_000,
    scheduleIntervalMs: 30 * 60_000,
  });

  const dueConnectionIds = await worker.processDueConnectionsOnce(
    new Date("2026-05-22T01:00:00.000Z"),
  );

  assert.deepEqual(
    dueConnectionIds.sort(),
    ["github-never-fetched", "gmail-due", "notion-due"].sort(),
  );
  assert.deepEqual(
    started.sort(),
    ["github-never-fetched", "gmail-due", "notion-due"].sort(),
  );
});
