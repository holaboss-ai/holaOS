import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { checkIntegrationReadiness, resolveIntegrationRuntime } from "./integration-runtime.js";

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

function createResolvedApp() {
  return {
    appId: "gmail",
    mcp: { transport: "http-sse", port: 3099, path: "/mcp" },
    mcpTools: [],
    healthCheck: { path: "/mcp/health", timeoutS: 30, intervalS: 1 },
    envContract: ["HOLABOSS_USER_ID", "PLATFORM_INTEGRATION_TOKEN", "WORKSPACE_GOOGLE_INTEGRATION_ID", "WORKSPACE_GITHUB_INTEGRATION_ID"],
    integrations: [
      {
        key: "google",
        provider: "google",
        capability: "gmail",
        scopes: ["gmail.send", "gmail.readonly"],
        required: true,
        credentialSource: "platform" as const,
        holabossUserIdRequired: true
      },
      {
        key: "github",
        provider: "github",
        capability: "github",
        scopes: ["repo"],
        required: false,
        credentialSource: "platform" as const,
        holabossUserIdRequired: false
      }
    ],
    startCommand: "",
    baseDir: "apps/gmail",
    lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
  };
}

function createSingleIntegrationResolvedApp() {
  return {
    appId: "gmail",
    mcp: { transport: "http-sse", port: 3099, path: "/mcp" },
    mcpTools: [],
    healthCheck: { path: "/mcp/health", timeoutS: 30, intervalS: 1 },
    envContract: ["HOLABOSS_USER_ID", "PLATFORM_INTEGRATION_TOKEN", "WORKSPACE_GOOGLE_INTEGRATION_ID", "WORKSPACE_API_URL"],
    integrations: [
      {
        key: "google",
        provider: "google",
        capability: "gmail",
        scopes: ["gmail.send", "gmail.readonly"],
        required: true,
        credentialSource: "platform" as const,
        holabossUserIdRequired: true
      }
    ],
    startCommand: "",
    baseDir: "apps/gmail",
    lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
  };
}

function createSingleIntegrationResolvedAppWithAliasKey() {
  return {
    ...createSingleIntegrationResolvedApp(),
    integrations: [
      {
        key: "primary_google",
        provider: "google",
        capability: "gmail",
        scopes: ["gmail.send", "gmail.readonly"],
        required: true,
        credentialSource: "platform" as const,
        holabossUserIdRequired: true
      }
    ]
  };
}

test("injects workspace api url and legacy token for a single active binding", () => {
  const root = makeTempDir("hb-integration-runtime-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const googleConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "token-google-1"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: googleConnection.connectionId,
    isDefault: true
  });

  const result = resolveIntegrationRuntime({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    appDir: path.join(store.workspaceDir(workspace.id), "apps", "gmail"),
    resolvedApp: createSingleIntegrationResolvedApp()
  });

  assert.equal(result.workspaceId, workspace.id);
  assert.equal(result.appId, "gmail");
  assert.equal(result.env.HOLABOSS_INTEGRATION_BROKER_URL, "http://127.0.0.1:8080/api/v1/integrations");
  assert.equal(result.env.WORKSPACE_API_URL, "http://127.0.0.1:8080/api/v1");
  assert.match(result.env.HOLABOSS_APP_GRANT ?? "", /^grant:workspace-1:gmail:/);
  assert.equal(result.env.PLATFORM_INTEGRATION_TOKEN, undefined);
  assert.equal(result.env.WORKSPACE_GOOGLE_INTEGRATION_ID, googleConnection.connectionId);
  assert.equal(result.env.WORKSPACE_GITHUB_INTEGRATION_ID, undefined);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.connections.length, 1);

  store.close();
});

test("suppresses legacy token when multiple active platform-backed bindings resolve", () => {
  const root = makeTempDir("hb-integration-runtime-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const googleConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "token-google-1"
  });
  const githubConnection = store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "holaboss-bot",
    authMode: "oauth_app",
    grantedScopes: ["repo"],
    status: "active",
    secretRef: "token-github-1"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: googleConnection.connectionId,
    isDefault: true
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-github-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "github",
    connectionId: githubConnection.connectionId,
    isDefault: true
  });

  const result = resolveIntegrationRuntime({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    appDir: path.join(store.workspaceDir(workspace.id), "apps", "gmail"),
    resolvedApp: createResolvedApp()
  });

  assert.equal(result.env.WORKSPACE_API_URL, "http://127.0.0.1:8080/api/v1");
  assert.equal(result.env.PLATFORM_INTEGRATION_TOKEN, undefined);
  assert.equal(result.env.WORKSPACE_GOOGLE_INTEGRATION_ID, googleConnection.connectionId);
  assert.equal(result.env.WORKSPACE_GITHUB_INTEGRATION_ID, githubConnection.connectionId);
  assert.equal(result.bindings.length, 2);
  assert.equal(result.connections.length, 2);

  store.close();
});

test("skips inactive connections when building compatibility env", () => {
  const root = makeTempDir("hb-integration-runtime-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const inactiveConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-inactive",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "inactive@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "inactive",
    secretRef: "token-google-inactive"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: inactiveConnection.connectionId,
    isDefault: true
  });

  const result = resolveIntegrationRuntime({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    appDir: path.join(store.workspaceDir(workspace.id), "apps", "gmail"),
    resolvedApp: createSingleIntegrationResolvedApp()
  });

  assert.equal(result.env.WORKSPACE_API_URL, "http://127.0.0.1:8080/api/v1");
  assert.equal(result.env.WORKSPACE_GOOGLE_INTEGRATION_ID, undefined);
  assert.equal(result.env.PLATFORM_INTEGRATION_TOKEN, undefined);
  assert.equal(result.bindings.length, 0);
  assert.equal(result.connections.length, 0);

  store.close();
});

test("prefers an app-specific binding override over a workspace default binding", () => {
  const root = makeTempDir("hb-integration-runtime-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const defaultConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-default",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "default@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-google-default"
  });
  const appConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-app",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "app@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active",
    secretRef: "token-google-app"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: defaultConnection.connectionId,
    isDefault: true
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: workspace.id,
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: appConnection.connectionId,
    isDefault: false
  });

  const result = resolveIntegrationRuntime({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createResolvedApp()
  });

  assert.equal(result.env.PLATFORM_INTEGRATION_TOKEN, undefined);
  assert.equal(result.env.WORKSPACE_GOOGLE_INTEGRATION_ID, appConnection.connectionId);
  assert.equal(result.bindings[0]?.bindingId, "bind-google-app");

  store.close();
});

test("checkIntegrationReadiness returns integration_not_bound when no binding exists", () => {
  const root = makeTempDir("hb-integration-readiness-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });

  const readiness = checkIntegrationReadiness({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createSingleIntegrationResolvedApp()
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.issues.length, 1);
  assert.equal(readiness.issues[0]?.code, "integration_not_bound");
  assert.equal(readiness.issues[0]?.provider, "google");
  assert.equal(readiness.issues[0]?.message, "Google is not connected for this workspace");

  store.close();
});

test("checkIntegrationReadiness returns integration_needs_reauth for inactive connection", () => {
  const root = makeTempDir("hb-integration-readiness-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const inactiveConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-inactive",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "inactive@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "expired",
    secretRef: "token-google-expired"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: inactiveConnection.connectionId,
    isDefault: true
  });

  const readiness = checkIntegrationReadiness({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createSingleIntegrationResolvedApp()
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.issues.length, 1);
  assert.equal(readiness.issues[0]?.code, "integration_needs_reauth");
  assert.equal(readiness.issues[0]?.message, "Google account needs re-authentication");

  store.close();
});

test("checkIntegrationReadiness returns ready when all required integrations are bound and active", () => {
  const root = makeTempDir("hb-integration-readiness-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const googleConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "token-google-1"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: googleConnection.connectionId,
    isDefault: true
  });

  const readiness = checkIntegrationReadiness({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createSingleIntegrationResolvedApp()
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.issues.length, 0);

  store.close();
});

test("checkIntegrationReadiness accepts provider-key bindings for legacy custom manifest keys", () => {
  const root = makeTempDir("hb-integration-readiness-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const googleConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "token-google-1"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: workspace.id,
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: googleConnection.connectionId,
    isDefault: false
  });

  const readiness = checkIntegrationReadiness({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createSingleIntegrationResolvedAppWithAliasKey()
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.issues.length, 0);

  store.close();
});

test("checkIntegrationReadiness skips optional integrations", () => {
  const root = makeTempDir("hb-integration-readiness-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active"
  });
  const googleConnection = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "token-google-1"
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: workspace.id,
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: googleConnection.connectionId,
    isDefault: true
  });

  const readiness = checkIntegrationReadiness({
    store,
    workspaceId: workspace.id,
    appId: "gmail",
    resolvedApp: createResolvedApp()
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.issues.length, 0);

  store.close();
});
