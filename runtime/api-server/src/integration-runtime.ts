import path from "node:path";

import {
  type IntegrationBindingRecord,
  type IntegrationConnectionRecord,
  type RuntimeStateStore
} from "@holaboss/runtime-state-store";

import { createSignedGrant } from "./grant-signing.js";
import { type ResolvedApplicationRuntime } from "./workspace-apps.js";

function defaultIntegrationBrokerUrl(): string {
  const port = process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? process.env.PORT ?? "8080";
  return `http://127.0.0.1:${port}/api/v1/integrations`;
}

export interface IntegrationRuntimeResolution {
  workspaceId: string | null;
  appId: string;
  brokerUrl: string;
  appGrant: string | null;
  env: NodeJS.ProcessEnv;
  bindings: IntegrationBindingRecord[];
  connections: IntegrationConnectionRecord[];
}

export type IntegrationReadinessCode =
  | "ready"
  | "integration_not_bound"
  | "integration_not_connected"
  | "integration_needs_reauth";

export interface IntegrationReadinessIssue {
  integrationKey: string;
  provider: string;
  code: IntegrationReadinessCode;
  message: string;
}

export interface IntegrationReadinessResult {
  ready: boolean;
  issues: IntegrationReadinessIssue[];
}

function toProviderEnvKey(provider: string): string {
  return provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function deriveWorkspaceApiUrl(brokerUrl: string): string {
  return brokerUrl.replace(/\/integrations\/?$/, "");
}

function isActiveIntegrationConnection(connection: IntegrationConnectionRecord): boolean {
  return connection.status.trim().toLowerCase() === "active";
}

function resolveWorkspaceIdFromAppDir(store: RuntimeStateStore, appDir?: string): string | null {
  if (!appDir) {
    return null;
  }
  const normalizedAppDir = path.resolve(appDir);
  for (const workspace of store.listWorkspaces()) {
    const workspaceDir = path.resolve(store.workspaceDir(workspace.id));
    const relative = path.relative(workspaceDir, normalizedAppDir);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return workspace.id;
    }
  }
  return null;
}

function resolveBindingForRequirement(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  appId: string;
  integrationKey: string;
  provider: string;
}): IntegrationBindingRecord | null {
  const integrationKeys = [params.integrationKey, params.provider]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  for (const integrationKey of integrationKeys) {
    const binding =
      params.store.getIntegrationBindingByTarget({
        workspaceId: params.workspaceId,
        targetType: "app",
        targetId: params.appId,
        integrationKey
      }) ??
      params.store.getIntegrationBindingByTarget({
        workspaceId: params.workspaceId,
        targetType: "workspace",
        targetId: "default",
        integrationKey
      });
    if (binding) {
      return binding;
    }
  }
  return null;
}

export function resolveIntegrationRuntime(params: {
  store: RuntimeStateStore;
  appId: string;
  resolvedApp?: ResolvedApplicationRuntime;
  appDir?: string;
  workspaceId?: string;
  integrationBrokerUrl?: string;
}): IntegrationRuntimeResolution {
  const resolvedApp = params.resolvedApp;
  const requirements = resolvedApp?.integrations ?? [];
  const brokerUrl = params.integrationBrokerUrl ?? defaultIntegrationBrokerUrl();
  const workspaceApiUrl = deriveWorkspaceApiUrl(brokerUrl);
  const workspaceId = params.workspaceId ?? resolveWorkspaceIdFromAppDir(params.store, params.appDir);
  const env: NodeJS.ProcessEnv = {};
  const bindings: IntegrationBindingRecord[] = [];
  const connections: IntegrationConnectionRecord[] = [];

  if (requirements.length === 0 || !workspaceId) {
    return {
      workspaceId,
      appId: params.appId,
      brokerUrl,
      appGrant: null,
      env,
      bindings,
      connections
    };
  }

  env.HOLABOSS_INTEGRATION_BROKER_URL = brokerUrl;
  env.WORKSPACE_API_URL = workspaceApiUrl;
  env.HOLABOSS_WORKSPACE_ID = workspaceId;
  env.HOLABOSS_APP_GRANT = createSignedGrant(workspaceId, params.appId);

  for (const requirement of requirements) {
    const binding = resolveBindingForRequirement({
      store: params.store,
      workspaceId,
      appId: params.appId,
      integrationKey: requirement.key,
      provider: requirement.provider
    });
    if (!binding) {
      continue;
    }
    const connection = params.store.getIntegrationConnection(binding.connectionId);
    if (!connection || !isActiveIntegrationConnection(connection)) {
      continue;
    }
    bindings.push(binding);
    connections.push(connection);

    env[`WORKSPACE_${toProviderEnvKey(requirement.provider)}_INTEGRATION_ID`] = connection.connectionId;
  }

  return {
    workspaceId,
    appId: params.appId,
    brokerUrl,
    appGrant: env.HOLABOSS_APP_GRANT ?? null,
    env,
    bindings,
    connections
  };
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  reddit: "Reddit",
  twitter: "Twitter / X",
  linkedin: "LinkedIn"
};

function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export function checkIntegrationReadiness(params: {
  store: RuntimeStateStore;
  appId: string;
  resolvedApp?: ResolvedApplicationRuntime;
  workspaceId?: string;
  appDir?: string;
}): IntegrationReadinessResult {
  const resolvedApp = params.resolvedApp;
  const requirements = resolvedApp?.integrations ?? [];
  const workspaceId = params.workspaceId ?? resolveWorkspaceIdFromAppDir(params.store, params.appDir);
  const issues: IntegrationReadinessIssue[] = [];

  if (requirements.length === 0 || !workspaceId) {
    return { ready: true, issues };
  }

  for (const requirement of requirements) {
    if (!requirement.required) {
      continue;
    }
    const displayName = providerDisplayName(requirement.provider);
    const binding = resolveBindingForRequirement({
      store: params.store,
      workspaceId,
      appId: params.appId,
      integrationKey: requirement.key,
      provider: requirement.provider
    });
    if (!binding) {
      issues.push({
        integrationKey: requirement.key,
        provider: requirement.provider,
        code: "integration_not_bound",
        message: `${displayName} is not connected for this workspace`
      });
      continue;
    }
    const connection = params.store.getIntegrationConnection(binding.connectionId);
    if (!connection) {
      issues.push({
        integrationKey: requirement.key,
        provider: requirement.provider,
        code: "integration_not_connected",
        message: `${displayName} connection is missing`
      });
      continue;
    }
    if (!isActiveIntegrationConnection(connection)) {
      issues.push({
        integrationKey: requirement.key,
        provider: requirement.provider,
        code: "integration_needs_reauth",
        message: `${displayName} account needs re-authentication`
      });
    }
  }

  return { ready: issues.length === 0, issues };
}
