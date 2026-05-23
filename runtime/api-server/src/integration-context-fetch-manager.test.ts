import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import {
  createIntegrationContextFetchManager,
} from "./integration-context-fetch-manager.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => void, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await sleep(10);
    }
  }
  assertion();
}

function buildConnection(params: {
  connectionId: string;
  providerId: string;
  accountLabel: string;
}): IntegrationConnectionRecord {
  return {
    connectionId: params.connectionId,
    providerId: params.providerId,
    ownerUserId: "user-1",
    accountLabel: params.accountLabel,
    accountExternalId: `ca_${params.connectionId}`,
    accountHandle: null,
    accountEmail: null,
    contextCronAutoFetchEnabled: true,
    lastContextFetchAttemptedAt: null,
    lastContextFetchCompletedAt: null,
    lastContextFetchStatus: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}

function createStore(
  connections: IntegrationConnectionRecord[],
): RuntimeStateStore {
  const connectionById = new Map(
    connections.map((connection) => [connection.connectionId, connection]),
  );
  return {
    getIntegrationConnection(connectionId: string) {
      return connectionById.get(connectionId) ?? null;
    },
    upsertIntegrationConnection(params: {
      connectionId: string;
      providerId: string;
      ownerUserId: string;
      accountLabel: string;
      accountExternalId?: string | null;
      accountHandle?: string | null;
      accountEmail?: string | null;
      contextCronAutoFetchEnabled?: boolean;
      lastContextFetchAttemptedAt?: string | null;
      lastContextFetchCompletedAt?: string | null;
      lastContextFetchStatus?: string | null;
      authMode: string;
      grantedScopes: string[];
      status: string;
      secretRef?: string | null;
    }) {
      const existing = connectionById.get(params.connectionId);
      const updated: IntegrationConnectionRecord = {
        connectionId: params.connectionId,
        providerId: params.providerId,
        ownerUserId: params.ownerUserId,
        accountLabel: params.accountLabel,
        accountExternalId: params.accountExternalId ?? null,
        accountHandle: params.accountHandle ?? null,
        accountEmail: params.accountEmail ?? null,
        contextCronAutoFetchEnabled:
          params.contextCronAutoFetchEnabled ?? true,
        lastContextFetchAttemptedAt:
          params.lastContextFetchAttemptedAt ?? null,
        lastContextFetchCompletedAt:
          params.lastContextFetchCompletedAt ?? null,
        lastContextFetchStatus: params.lastContextFetchStatus ?? null,
        authMode: params.authMode,
        grantedScopes: params.grantedScopes,
        status: params.status,
        secretRef: params.secretRef ?? null,
        createdAt: existing?.createdAt ?? "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      };
      connectionById.set(params.connectionId, updated);
      return updated;
    },
  } as unknown as RuntimeStateStore;
}

test("integration context fetch manager dedups per connection while allowing parallel runs", async () => {
  const store = createStore([
    buildConnection({
      connectionId: "conn-gmail-1",
      providerId: "gmail",
      accountLabel: "Gmail",
    }),
    buildConnection({
      connectionId: "conn-slack-1",
      providerId: "slack",
      accountLabel: "Slack",
    }),
  ]);

  const gates = new Map([
    ["conn-gmail-1", createDeferred<void>()],
    ["conn-slack-1", createDeferred<void>()],
  ]);
  const calls: string[] = [];
  const manager = createIntegrationContextFetchManager({
    store,
    runFetch: async ({ connectionId, onProgress }) => {
      calls.push(connectionId);
      onProgress?.({
        provider_id: connectionId.includes("gmail") ? "gmail" : "slack",
        connection_id: connectionId,
        account_key: `${connectionId}-account`,
        account_label: connectionId.includes("gmail") ? "Gmail" : "Slack",
        tree_id: `${connectionId}-tree`,
        current_chunk_label: `Fetching ${connectionId}`,
        chunks_total: 4,
        chunks_completed: 1,
        messages_seen: 2,
        messages_persisted: 1,
        leaves_created: 1,
        leaves_superseding: 0,
        leaves_unchanged: 0,
        summary_nodes: 0,
        actions: ["FETCH_START"],
      });
      await gates.get(connectionId)?.promise;
      onProgress?.({
        provider_id: connectionId.includes("gmail") ? "gmail" : "slack",
        connection_id: connectionId,
        account_key: `${connectionId}-account`,
        account_label: connectionId.includes("gmail") ? "Gmail" : "Slack",
        tree_id: `${connectionId}-tree`,
        current_chunk_label: `Finishing ${connectionId}`,
        chunks_total: 4,
        chunks_completed: 4,
        messages_seen: 2,
        messages_persisted: 2,
        leaves_created: 2,
        leaves_superseding: 0,
        leaves_unchanged: 0,
        summary_nodes: 3,
        actions: ["FETCH_START", "FETCH_DONE"],
      });
      return {
        ok: true,
        supported: true,
        provider_id: connectionId.includes("gmail") ? "gmail" : "slack",
        connection_id: connectionId,
        account_key: `${connectionId}-account`,
        account_label: connectionId.includes("gmail") ? "Gmail" : "Slack",
        tree_id: `${connectionId}-tree`,
        fetched_at: "2026-05-22T00:00:00.000Z",
        leaves_created: 2,
        leaves_superseding: 0,
        leaves_unchanged: 0,
        messages_seen: 2,
        messages_persisted: 2,
        summary_nodes: 3,
        actions: ["FETCH_START", "FETCH_DONE"],
      };
    },
  });

  const first = await manager.start({ connectionId: "conn-gmail-1" });
  const deduped = await manager.start({ connectionId: "conn-gmail-1" });
  const parallel = await manager.start({ connectionId: "conn-slack-1" });

  assert.equal(first.started, true);
  assert.equal(first.deduped, false);
  assert.equal(deduped.started, false);
  assert.equal(deduped.deduped, true);
  assert.equal(parallel.started, true);
  assert.equal(calls.filter((value) => value === "conn-gmail-1").length, 1);
  assert.equal(calls.filter((value) => value === "conn-slack-1").length, 1);

  const running = manager.list({
    connectionIds: ["conn-gmail-1", "conn-slack-1"],
  });
  assert.equal(running.statuses.length, 2);
  assert.equal(
    running.statuses.every((status) => status.status === "running"),
    true,
  );
  assert.equal(
    running.statuses.every((status) => status.chunks_total === 4),
    true,
  );

  gates.get("conn-gmail-1")?.resolve();
  gates.get("conn-slack-1")?.resolve();

  await waitFor(() => {
    const completed = manager.list({
      connectionIds: ["conn-gmail-1", "conn-slack-1"],
    });
    assert.equal(
      completed.statuses.every((status) => status.status === "completed"),
      true,
    );
    assert.equal(
      completed.statuses.every((status) => status.chunks_completed === 4),
      true,
    );
    assert.equal(
      completed.statuses.every(
        (status) => status.current_chunk_label?.includes("Fetched") === true,
      ),
      true,
    );
  });

  assert.equal(
    store.getIntegrationConnection("conn-gmail-1")?.lastContextFetchStatus,
    "completed",
  );
  assert.equal(
    store.getIntegrationConnection("conn-slack-1")?.lastContextFetchStatus,
    "completed",
  );
  assert.equal(
    store.getIntegrationConnection("conn-gmail-1")?.lastContextFetchAttemptedAt
      !== null,
    true,
  );
});

test("integration context fetch manager records unsupported providers without starting a run", async () => {
  const store = createStore([
    buildConnection({
      connectionId: "conn-linear-1",
      providerId: "linear",
      accountLabel: "Linear",
    }),
  ]);

  let called = false;
  const manager = createIntegrationContextFetchManager({
    store,
    runFetch: async () => {
      called = true;
      throw new Error("should not run");
    },
  });

  const response = await manager.start({ connectionId: "conn-linear-1" });

  assert.equal(response.started, false);
  assert.equal(response.deduped, false);
  assert.equal(response.status.supported, false);
  assert.equal(response.status.status, "unsupported");
  assert.equal(called, false);

  const listed = manager.list({ connectionIds: ["conn-linear-1"] });
  assert.equal(listed.statuses.length, 1);
  assert.equal(listed.statuses[0]?.status, "unsupported");
  assert.equal(
    store.getIntegrationConnection("conn-linear-1")?.lastContextFetchStatus,
    "unsupported",
  );
});
