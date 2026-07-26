import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveActiveToolkitConnections,
  resolveActiveToolkitConnectionsRemoteFirst,
  type RemoteComposioConnection,
} from "./composio-toolkit-resolver.js";
import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

function makeStoreStub(params: {
  connections: Array<{
    connectionId: string;
    providerId: string;
    status: string;
    accountExternalId: string;
  }>;
  workspaceDefaultByProvider?: Record<string, string>;
}) {
  const fullConnections: IntegrationConnectionRecord[] = params.connections.map(
    (entry) => ({
      connectionId: entry.connectionId,
      providerId: entry.providerId,
      ownerUserId: "u1",
      accountLabel: entry.providerId,
      accountExternalId: entry.accountExternalId,
      accountHandle: null,
      accountEmail: null,
      contextCronAutoFetchEnabled: true,
      authMode: "composio",
      grantedScopes: [],
      status: entry.status,
      secretRef: null,
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z",
    }),
  );
  const defaults = params.workspaceDefaultByProvider ?? {};
  return {
    listIntegrationConnections: (filter: { providerId?: string } = {}) => {
      if (filter.providerId) {
        return fullConnections.filter(
          (entry) => entry.providerId.toLowerCase() === filter.providerId!.toLowerCase(),
        );
      }
      return fullConnections;
    },
    getIntegrationBindingByTarget: (q: { integrationKey: string }) => {
      const connectionId = defaults[q.integrationKey];
      if (!connectionId) return null;
      return {
        bindingId: "b1",
        workspaceId: "ws1",
        targetType: "workspace_default",
        targetId: "ws1",
        integrationKey: q.integrationKey,
        connectionId,
        isDefault: true,
        createdAt: "2026-06-11T00:00:00Z",
        updatedAt: "2026-06-11T00:00:00Z",
      };
    },
  } as unknown as RuntimeStateStore;
}

test("resolveActiveToolkitConnections picks ACTIVE in-catalog connections one per toolkit", () => {
  const store = makeStoreStub({
    connections: [
      { connectionId: "c1", providerId: "gmail", status: "active", accountExternalId: "ext_gmail" },
      { connectionId: "c2", providerId: "notion", status: "active", accountExternalId: "ext_notion" },
      { connectionId: "c3", providerId: "totally_unknown", status: "active", accountExternalId: "ext_x" },
      { connectionId: "c4", providerId: "twitter", status: "expired", accountExternalId: "ext_tw" },
    ],
  });
  const resolved = resolveActiveToolkitConnections(store, "ws1");
  const slugs = resolved.map((entry) => entry.toolkit_slug).sort();
  assert.deepEqual(slugs, ["gmail", "notion"]);
  const gmail = resolved.find((entry) => entry.toolkit_slug === "gmail")!;
  assert.equal(gmail.connection_id, "c1");
  assert.equal(gmail.connected_account_id, "ext_gmail");
});

test("resolveActiveToolkitConnections picks workspace_default account when multiple connections exist", () => {
  const store = makeStoreStub({
    connections: [
      { connectionId: "c1", providerId: "gmail", status: "active", accountExternalId: "ext_a" },
      { connectionId: "c2", providerId: "gmail", status: "active", accountExternalId: "ext_b" },
    ],
    workspaceDefaultByProvider: { gmail: "c2" },
  });
  const resolved = resolveActiveToolkitConnections(store, "ws1");
  const gmail = resolved.find((entry) => entry.toolkit_slug === "gmail")!;
  assert.equal(gmail.connection_id, "c2");
  assert.equal(gmail.connected_account_id, "ext_b");
});

test("resolveActiveToolkitConnections falls back to the NEWEST active connection when no workspace_default is set", () => {
  const store = makeStoreStub({
    connections: [
      { connectionId: "c-old", providerId: "notion", status: "active", accountExternalId: "ca_old" },
      { connectionId: "c-new", providerId: "notion", status: "active", accountExternalId: "ca_new" },
    ],
  });
  const resolved = resolveActiveToolkitConnections(store, "ws1");
  const notion = resolved.find((entry) => entry.toolkit_slug === "notion")!;
  assert.equal(notion.connection_id, "c-new", "newest connection wins when nothing else pins one");
  assert.equal(notion.connected_account_id, "ca_new");
});

test("remote-first resolve: with multiple active Notion accounts, the NEWEST (by createdAt) wins — not list position", async () => {
  const store = makeStoreStub({ connections: [] });
  // Deliberately unordered: the newest account is NOT last in the array, so a
  // naive "last element" pick would choose the wrong (older) one.
  const remoteConnections: RemoteComposioConnection[] = [
    { id: "ca_new", toolkitSlug: "notion", status: "ACTIVE", createdAt: "2026-07-06T00:00:00Z" },
    { id: "ca_old", toolkitSlug: "notion", status: "ACTIVE", createdAt: "2026-06-20T00:00:00Z" },
    // A dropped/expired account must be ignored entirely.
    { id: "ca_dead", toolkitSlug: "notion", status: "EXPIRED", createdAt: "2026-07-07T00:00:00Z" },
  ];
  const resolved = await resolveActiveToolkitConnectionsRemoteFirst({
    store,
    workspaceId: "ws1",
    remote: { listConnections: async () => remoteConnections },
  });
  const notion = resolved.find((entry) => entry.toolkit_slug === "notion");
  assert.ok(notion, "notion resolves from the active remote set");
  assert.equal(notion!.connected_account_id, "ca_new");
});
