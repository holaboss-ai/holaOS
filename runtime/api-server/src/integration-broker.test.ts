import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import {
  BrokerError,
  IntegrationBrokerService,
  parseAppGrant
} from "./integration-broker.js";
import { buildRuntimeApiServer } from "./app.js";

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

test("parseAppGrant extracts workspace and app from a valid grant string", () => {
  const result = parseAppGrant("grant:workspace-1:gmail:abc-123-uuid");
  assert.deepEqual(result, {
    workspaceId: "workspace-1",
    appId: "gmail",
    nonce: "abc-123-uuid"
  });
});

test("parseAppGrant returns null for malformed grant strings", () => {
  assert.equal(parseAppGrant(""), null);
  assert.equal(parseAppGrant("not-a-grant"), null);
  assert.equal(parseAppGrant("grant:only-two"), null);
  assert.equal(parseAppGrant("grant:workspace:app:"), null);
  assert.equal(parseAppGrant("xgrant:workspace:app:nonce"), null);
});

test("exchangeToken returns provider token for a valid grant and active binding", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "gya_actual-google-token-value"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });

  const broker = new IntegrationBrokerService(store);
  const result = await broker.exchangeToken({
    grant: "grant:workspace-1:gmail:some-uuid",
    provider: "google"
  });

  assert.equal(result.token, "gya_actual-google-token-value");
  assert.equal(result.provider, "google");
  assert.equal(result.connection_id, "conn-google-1");

  store.close();
});

test("exchangeToken throws grant_invalid for a malformed grant", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () => broker.exchangeToken({ grant: "bad-grant", provider: "google" }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "grant_invalid" &&
      error.statusCode === 401
  );

  store.close();
});

test("exchangeToken throws integration_not_bound when no binding exists", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "integration_not_bound" &&
      error.statusCode === 404
  );

  store.close();
});

test("exchangeToken throws connection_inactive when connection is expired", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-expired",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "expired@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "expired",
    secretRef: "expired-token"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-expired",
    isDefault: true
  });
  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "connection_inactive" &&
      error.statusCode === 403
  );

  store.close();
});

test("exchangeToken throws token_unavailable when connection has no secret_ref", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-no-secret",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "nosecret@holaboss.ai",
    authMode: "manual_token",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-no-secret",
    isDefault: true
  });
  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () =>
      broker.exchangeToken({
        grant: "grant:workspace-1:gmail:some-uuid",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "token_unavailable" &&
      error.statusCode === 503
  );

  store.close();
});

test("exchangeToken prefers app-specific binding over workspace default", async () => {
  const root = makeTempDir("hb-broker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-default",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "default@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-default"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-app",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "app@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-app-specific"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-default",
    isDefault: true
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: "workspace-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-app",
    isDefault: false
  });
  const broker = new IntegrationBrokerService(store);

  const result = await broker.exchangeToken({
    grant: "grant:workspace-1:gmail:some-uuid",
    provider: "google"
  });

  assert.equal(result.token, "token-app-specific");
  assert.equal(result.connection_id, "conn-google-app");

  store.close();
});

test("POST /api/v1/integrations/broker/token returns provider token via HTTP", async () => {
  const root = makeTempDir("hb-broker-route-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "owner@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "gya_test-token-value"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-1",
    workspaceId: "workspace-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });

  const app = buildRuntimeApiServer({
    store,
    workspaceRoot: path.join(root, "workspace"),
    queueWorker: null,
    cronWorker: null,
  });

  const successResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "grant:workspace-1:gmail:test-uuid",
      provider: "google"
    }
  });
  assert.equal(successResponse.statusCode, 200);
  const successBody = successResponse.json();
  assert.equal(successBody.token, "gya_test-token-value");
  assert.equal(successBody.provider, "google");
  assert.equal(successBody.connection_id, "conn-google-1");

  const errorResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "bad-grant",
      provider: "google"
    }
  });
  assert.equal(errorResponse.statusCode, 401);
  const errorBody = errorResponse.json();
  assert.equal(errorBody.error, "grant_invalid");

  const unboundResponse = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/broker/token",
    payload: {
      grant: "grant:workspace-1:gmail:test-uuid",
      provider: "reddit"
    }
  });
  assert.equal(unboundResponse.statusCode, 404);
  assert.equal(unboundResponse.json().error, "integration_not_bound");

  await app.close();
  store.close();
});

test("exchangeToken rejects composio connections (must use /broker/proxy)", async () => {
  const root = makeTempDir("hb-broker-composio-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "ws-composio",
    name: "Composio Workspace",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-composio-gmail",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "composio@holaboss.ai",
    authMode: "composio",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: null,
    accountExternalId: "ca_composio_123"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-composio-gmail",
    workspaceId: "ws-composio",
    targetType: "app",
    targetId: "gmail-app",
    integrationKey: "google",
    connectionId: "conn-composio-gmail",
    isDefault: false
  });

  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () =>
      broker.exchangeToken({
        grant: "grant:ws-composio:gmail-app:test-nonce",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "token_unavailable" &&
      error.message.includes("/broker/proxy")
  );

  store.close();
});

test("exchangeToken throws for composio connection even without accountExternalId", async () => {
  const root = makeTempDir("hb-broker-composio-no-ext-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  seedWorkspaceRecord(store, {
    workspaceId: "ws-composio-2",
    name: "Composio Workspace 2",
    harness: "pi",
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-composio-no-ext",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "composio-noext@holaboss.ai",
    authMode: "composio",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: null,
    accountExternalId: null
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-composio-no-ext",
    workspaceId: "ws-composio-2",
    targetType: "app",
    targetId: "gmail-app",
    integrationKey: "google",
    connectionId: "conn-composio-no-ext",
    isDefault: false
  });

  const broker = new IntegrationBrokerService(store);

  await assert.rejects(
    async () =>
      broker.exchangeToken({
        grant: "grant:ws-composio-2:gmail-app:test-nonce",
        provider: "google"
      }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "token_unavailable" &&
      error.message.includes("/broker/proxy")
  );

  store.close();
});
