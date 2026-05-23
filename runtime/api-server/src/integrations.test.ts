import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { IntegrationServiceError, RuntimeIntegrationService } from "./integrations.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("returns the integration catalog with gmail and googlesheets", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const catalog = service.getCatalog();
  const ids = catalog.providers.map((provider) => provider.provider_id);

  assert.equal(ids[0], "gmail");
  assert.equal(ids[1], "googlesheets");
  assert.ok(ids.includes("google"), "legacy google entry should be present");
  assert.ok(ids.includes("github"));
  assert.ok(ids.includes("reddit"));
  assert.ok(ids.includes("twitter"));
  assert.ok(ids.includes("linkedin"));

  store.close();
});

test("upserts workspace-scoped bindings and rejects invalid target types", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  const connection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });

  const binding = service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: connection.connectionId,
    isDefault: true
  });

  assert.equal(binding.workspace_id, "workspace-1");
  assert.equal(binding.connection_id, connection.connectionId);
  assert.equal(service.listBindings({ workspaceId: "workspace-1" }).bindings[0]?.workspace_id, "workspace-1");
  assert.equal(service.deleteBinding(binding.binding_id, "workspace-1").deleted, true);

  assert.throws(
    () =>
      service.upsertBinding({
        workspaceId: "workspace-1",
        targetType: "invalid",
        targetId: "default",
        integrationKey: "google",
        connectionId: connection.connectionId,
        isDefault: false
      }),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 400 &&
      error.message.includes("target_type")
  );

  store.close();
});

test("fires onBindingCreated for new bindings and not for rebinding the same target", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const createdBindings: Array<{
    bindingId: string;
    workspaceId: string;
    targetType: string;
    targetId: string;
    integrationKey: string;
    connectionId: string;
    isDefault: boolean;
  }> = [];
  const service = new RuntimeIntegrationService(store, {
    onBindingCreated: (binding) => {
      createdBindings.push(binding);
    }
  });
  const firstConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "first@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  const secondConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-2",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "second@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });

  const firstBinding = service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace_default",
    targetId: "google",
    integrationKey: "google",
    connectionId: firstConnection.connectionId,
    isDefault: true
  });
  service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace_default",
    targetId: "google",
    integrationKey: "google",
    connectionId: secondConnection.connectionId,
    isDefault: false
  });

  assert.equal(createdBindings.length, 1);
  assert.deepEqual(createdBindings[0], {
    bindingId: firstBinding.binding_id,
    workspaceId: "workspace-1",
    targetType: "workspace_default",
    targetId: "google",
    integrationKey: "google",
    connectionId: firstConnection.connectionId,
    isDefault: true
  });

  store.close();
});

test("rejects missing connections, cross-provider bindings, and missing workspaces", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  const githubConnection = store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["repo"],
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });

  assert.throws(
    () =>
      service.upsertBinding({
        workspaceId: "workspace-1",
        targetType: "workspace",
        targetId: "default",
        integrationKey: "github",
        connectionId: "missing-connection",
        isDefault: true
      }),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 404 &&
      error.message.includes("integration connection")
  );

  assert.throws(
    () =>
      service.upsertBinding({
        workspaceId: "workspace-1",
        targetType: "workspace",
        targetId: "default",
        integrationKey: "google",
        connectionId: githubConnection.connectionId,
        isDefault: true
      }),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 400 &&
      error.message.includes("does not match")
  );

  assert.throws(
    () => service.listBindings({ workspaceId: "missing-workspace" }),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 404 &&
      error.message === "workspace not found"
  );

  store.close();
});

test("rejects delete binding requests without workspace scoping or with the wrong workspace", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  const connection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-2",
    name: "Workspace 2",
    harness: "pi",
    status: "active"
  });
  const binding = service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: connection.connectionId,
    isDefault: true
  });

  assert.throws(
    () => service.deleteBinding(binding.binding_id),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 400 &&
      error.message.includes("workspace_id")
  );

  assert.throws(
    () => service.deleteBinding(binding.binding_id, "workspace-2" as never),
    (error: unknown) =>
      error instanceof IntegrationServiceError &&
      error.statusCode === 404 &&
      error.message === "binding not found"
  );

  store.close();
});

test("creates a connection via manual token import and lists it", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const connection = service.createConnection({
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    secretRef: "gya_manual-token-value"
  });

  assert.equal(connection.provider_id, "google");
  assert.equal(connection.account_label, "joshua@holaboss.ai");
  assert.equal(connection.auth_mode, "manual_token");
  assert.equal(connection.status, "active");
  assert.ok(connection.connection_id);

  const listed = service.listConnections({ providerId: "google" });
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0]?.connection_id, connection.connection_id);

  store.close();
});

test("manual token import generates a default account label when none is provided", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const connection = service.createConnection({
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "   ",
    authMode: "manual_token",
    grantedScopes: ["gmail.send"],
    secretRef: "gya_manual-token-value"
  });

  assert.equal(connection.account_label, "Google connection");

  store.close();
});

test("updates connection status and secret_ref", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  const connection = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "holaboss-bot",
    authMode: "manual_token",
    grantedScopes: ["repo"],
    secretRef: "ghp_old-token"
  });

  const updated = service.updateConnection(connection.connection_id, {
    status: "expired"
  });
  assert.equal(updated.status, "expired");

  const rotated = service.updateConnection(connection.connection_id, {
    secretRef: "ghp_new-token",
    status: "active"
  });
  assert.equal(rotated.status, "active");

  store.close();
});

test("deleting a connection cascades through every workspace binding", () => {
  const root = makeTempDir("hb-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-2",
    name: "Workspace 2",
    harness: "pi",
    status: "active"
  });
  const connection = service.createConnection({
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send"],
    secretRef: "gya_token"
  });

  // Bind the same connection to two different workspaces (the
  // user-global model: one account → many workspaces).
  service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: connection.connection_id,
    isDefault: true
  });
  service.upsertBinding({
    workspaceId: "workspace-2",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: connection.connection_id,
    isDefault: true
  });

  // Deleting the connection should remove every binding pointing at it
  // and report how many were swept.
  const result = service.deleteConnection(connection.connection_id);
  assert.equal(result.deleted, true);
  assert.equal(result.removed_bindings, 2);
  assert.equal(service.listConnections({ providerId: "google" }).connections.length, 0);
  assert.equal(service.listBindings({ workspaceId: "workspace-1" }).bindings.length, 0);
  assert.equal(service.listBindings({ workspaceId: "workspace-2" }).bindings.length, 0);

  store.close();
});

test("createConnection dedupes a re-auth flow on the same handle: keeps connection_id, refreshes external_id and secret_ref, preserves bindings", () => {
  const root = makeTempDir("hb-integrations-dedupe-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });

  // First connect — Composio mints connected_account ID "ca_v1".
  const first = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_v1",
    accountHandle: "joshua",
    secretRef: "secret/twitter/v1"
  });
  // Bind to a workspace so we can prove it survives the re-auth.
  service.upsertBinding({
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "twitter",
    connectionId: first.connection_id,
    isDefault: true
  });

  // Second connect (re-auth) — Composio mints a new ID "ca_v2", but the
  // underlying handle is the same.
  const second = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_v2",
    accountHandle: "joshua",
    secretRef: "secret/twitter/v2"
  });

  // Same connection_id (the dedupe contract).
  assert.equal(second.connection_id, first.connection_id);
  // Volatile fields refreshed.
  assert.equal(second.account_external_id, "ca_v2");
  assert.equal(second.secret_ref, "secret/twitter/v2");
  // Identity preserved.
  assert.equal(second.account_handle, "joshua");
  // Only one row exists.
  assert.equal(service.listConnections({ providerId: "twitter" }).connections.length, 1);
  // Workspace binding survives because connection_id didn't change.
  const bindings = service.listBindings({ workspaceId: "workspace-1" }).bindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.connection_id, first.connection_id);

  store.close();
});

test("createConnection without identity creates a fresh row each time (no dedupe possible)", () => {
  const root = makeTempDir("hb-integrations-no-identity-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const first = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "First",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_x"
  });
  const second = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "Second",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_y"
  });

  // Two distinct rows when identity isn't supplied — the dedupe finder
  // bails out, the legacy create-fresh path runs.
  assert.notEqual(first.connection_id, second.connection_id);
  assert.equal(service.listConnections({ providerId: "github" }).connections.length, 2);

  store.close();
});

test("updateConnection backfills identity onto a legacy NULL-identity row without clobbering other fields", () => {
  const root = makeTempDir("hb-integrations-backfill-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  // Legacy row created without identity (pre-fix behaviour).
  const legacy = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_legacy"
  });
  assert.equal(legacy.account_handle, null);
  assert.equal(legacy.account_email, null);

  const backfilled = service.updateConnection(legacy.connection_id, {
    accountHandle: "joshua",
    accountEmail: "j@example.com"
  });
  assert.equal(backfilled.account_handle, "joshua");
  assert.equal(backfilled.account_email, "j@example.com");
  // Other fields preserved.
  assert.equal(backfilled.account_label, "@joshua");
  assert.equal(backfilled.account_external_id, "ca_legacy");
  assert.equal(backfilled.status, "active");

  // Now a re-auth on the same handle dedupes against the backfilled row.
  const second = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_new",
    accountHandle: "joshua"
  });
  assert.equal(second.connection_id, legacy.connection_id);
  assert.equal(second.account_external_id, "ca_new");

  store.close();
});

test("mergeConnections repoints bindings to the keep id, drops removed connections, and reports counts", () => {
  const root = makeTempDir("hb-integrations-merge-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);
  store.createWorkspace({
    workspaceId: "workspace-A",
    name: "A",
    harness: "pi",
    status: "active"
  });
  store.createWorkspace({
    workspaceId: "workspace-B",
    name: "B",
    harness: "pi",
    status: "active"
  });

  const keep = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua (oldest)",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_old",
    accountHandle: "joshua"
  });
  const dup1 = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua (mid)",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_mid"
  });
  const dup2 = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua (newest)",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_new"
  });

  // Bind dup1 to workspace-A, dup2 to workspace-B; keep has no bindings.
  service.upsertBinding({
    workspaceId: "workspace-A",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "github",
    connectionId: dup1.connection_id,
    isDefault: true
  });
  service.upsertBinding({
    workspaceId: "workspace-B",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "github",
    connectionId: dup2.connection_id,
    isDefault: true
  });

  const result = service.mergeConnections({
    keepConnectionId: keep.connection_id,
    removeConnectionIds: [dup1.connection_id, dup2.connection_id]
  });
  assert.equal(result.kept_connection_id, keep.connection_id);
  assert.equal(result.removed_count, 2);
  assert.equal(result.repointed_bindings, 2);

  // Only the keep row remains, both workspaces now bind to it.
  const remaining = service.listConnections({ providerId: "github" }).connections;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.connection_id, keep.connection_id);
  const bindingsA = service.listBindings({ workspaceId: "workspace-A" }).bindings;
  assert.equal(bindingsA.length, 1);
  assert.equal(bindingsA[0]?.connection_id, keep.connection_id);
  const bindingsB = service.listBindings({ workspaceId: "workspace-B" }).bindings;
  assert.equal(bindingsB.length, 1);
  assert.equal(bindingsB[0]?.connection_id, keep.connection_id);

  store.close();
});

test("mergeConnections rejects merging connections that don't share provider+owner", () => {
  const root = makeTempDir("hb-integrations-merge-cross-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const tw = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "tw",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_tw"
  });
  const gh = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "gh",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_gh"
  });

  assert.throws(
    () =>
      service.mergeConnections({
        keepConnectionId: tw.connection_id,
        removeConnectionIds: [gh.connection_id]
      }),
    /provider\/owner does not match/
  );

  // Both rows still present after the rejection.
  assert.equal(service.listConnections().connections.length, 2);

  store.close();
});

test("createConnection scopes dedupe per provider+owner: same handle on different providers stays separate", () => {
  const root = makeTempDir("hb-integrations-cross-provider-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const service = new RuntimeIntegrationService(store);

  const tw = service.createConnection({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_tw",
    accountHandle: "joshua"
  });
  const gh = service.createConnection({
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua",
    authMode: "composio",
    grantedScopes: [],
    accountExternalId: "ca_gh",
    accountHandle: "joshua"
  });

  // Different connection_ids — dedupe is provider-scoped.
  assert.notEqual(tw.connection_id, gh.connection_id);
  assert.equal(service.listConnections().connections.length, 2);

  store.close();
});
