import fs from "node:fs";
import path from "node:path";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  AppLifecycleExecutorError,
  type AppLifecycleActionResult,
  appBuildHasCompletedSetup,
  type AppLifecycleExecutorLike
} from "./app-lifecycle-worker.js";
import { portsForWorkspaceApp, type ResolvedApplicationRuntime } from "./workspace-apps.js";

type StringMap = Record<string, unknown>;

export type ResolvedApplicationsBootstrapRequestPayload = {
  workspace_dir?: string;
  holaboss_user_id?: string;
  resolved_applications?: unknown;
};

export type ResolvedApplicationsBootstrapApplication = {
  app_id: string;
  mcp_url: string;
  timeout_ms: number;
  ports: { http: number; mcp: number };
};

export type ResolvedApplicationsBootstrapResponse = {
  applications: ResolvedApplicationsBootstrapApplication[];
};

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function optionalStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function requiredDict(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

export function parseResolvedApplicationRuntimePayload(value: unknown): ResolvedApplicationRuntime {
  const payload = requiredDict(value, "resolved_application");
  const appId = requiredString(payload.app_id, "resolved_application.app_id");
  const mcp = requiredDict(payload.mcp, "resolved_application.mcp");
  const healthCheck = requiredDict(payload.health_check, "resolved_application.health_check");
  const lifecycle = isRecord(payload.lifecycle) ? payload.lifecycle : {};
  const mcpPort = optionalInteger(mcp.port, Number.NaN);
  const timeoutS = optionalInteger(healthCheck.timeout_s, Number.NaN);
  const intervalS = optionalInteger(healthCheck.interval_s, Number.NaN);
  if (!Number.isFinite(mcpPort)) {
    throw new Error("resolved_application.mcp.port is required");
  }
  if (!Number.isFinite(timeoutS)) {
    throw new Error("resolved_application.health_check.timeout_s is required");
  }
  if (!Number.isFinite(intervalS)) {
    throw new Error("resolved_application.health_check.interval_s is required");
  }
  return {
    appId,
    mcp: {
      transport: requiredString(mcp.transport, "resolved_application.mcp.transport"),
      port: mcpPort,
      path: requiredString(mcp.path, "resolved_application.mcp.path")
    },
    mcpTools: optionalStringList(payload.mcp_tools),
    healthCheck: {
      target:
        optionalString(healthCheck.target) === "api" ? "api" : "mcp",
      path: requiredString(healthCheck.path, "resolved_application.health_check.path"),
      timeoutS,
      intervalS
    },
    envContract: optionalStringList(payload.env_contract),
    startCommand: optionalString(payload.start_command) ?? "",
    baseDir: optionalString(payload.base_dir) ?? "",
    lifecycle: {
      setup: optionalString(lifecycle.setup) ?? "",
      start: optionalString(lifecycle.start) ?? "",
      stop: optionalString(lifecycle.stop) ?? ""
    }
  };
}

export function appDirForResolvedApplication(workspaceDir: string, resolvedApp: ResolvedApplicationRuntime): string {
  const workspaceRoot = path.resolve(workspaceDir);
  const appDir = path.resolve(
    workspaceRoot,
    resolvedApp.baseDir && resolvedApp.baseDir.trim() ? resolvedApp.baseDir : path.join("apps", resolvedApp.appId)
  );
  const relativeAppDir = path.relative(workspaceRoot, appDir);
  if (relativeAppDir.startsWith("..") || path.isAbsolute(relativeAppDir)) {
    throw new AppLifecycleExecutorError(
      400,
      `resolved_application.base_dir escapes workspace: '${resolvedApp.baseDir}'`
    );
  }
  return appDir;
}

function normalizeResolvedApplicationsBootstrapApplication(params: {
  requestedAppId: string;
  started: AppLifecycleActionResult;
  mcpPath: string;
  timeoutMs: number;
}): ResolvedApplicationsBootstrapApplication {
  if (params.started.app_id !== params.requestedAppId) {
    throw new AppLifecycleExecutorError(
      500,
      `resolved app startup returned mismatched app id '${params.started.app_id}' for '${params.requestedAppId}'`
    );
  }
  const { http, mcp } = params.started.ports;
  if (!Number.isInteger(http) || http <= 0 || !Number.isInteger(mcp) || mcp <= 0) {
    throw new AppLifecycleExecutorError(
      500,
      `resolved app startup returned invalid ports for '${params.requestedAppId}'`
    );
  }
  return {
    app_id: params.requestedAppId,
    mcp_url: `http://localhost:${mcp}${params.mcpPath}`,
    timeout_ms: params.timeoutMs,
    ports: { http, mcp }
  };
}

async function waitForInFlightAppBuild(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  appId: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const timeoutMs = params.timeoutMs ?? 305_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const build = params.store.getAppBuild({
      workspaceId: params.workspaceId,
      appId: params.appId
    });
    const status = build?.status;
    if (status !== "building") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new AppLifecycleExecutorError(
    504,
    `timed out waiting for app '${params.appId}' setup already in progress`
  );
}

export async function bootstrapResolvedApplications(params: {
  workspaceDir: string;
  holabossUserId?: string;
  resolvedApplications?: unknown;
  store?: RuntimeStateStore;
  workspaceId?: string;
  appLifecycleExecutor: AppLifecycleExecutorLike;
}): Promise<ResolvedApplicationsBootstrapResponse> {
  const resolvedWorkspaceDir = path.resolve(params.workspaceDir);
  if (!fs.existsSync(resolvedWorkspaceDir) || !fs.statSync(resolvedWorkspaceDir).isDirectory()) {
    throw new AppLifecycleExecutorError(404, `workspace_dir not found: '${params.workspaceDir}'`);
  }
  const holabossUserId = optionalString(params.holabossUserId);
  const rawResolvedApps = Array.isArray(params.resolvedApplications) ? params.resolvedApplications : null;
  if (!rawResolvedApps) {
    throw new AppLifecycleExecutorError(400, "resolved_applications must be an array");
  }
  if (rawResolvedApps.length === 0) {
    throw new AppLifecycleExecutorError(400, "resolved_applications must not be empty");
  }
  const parsedResolvedApps = rawResolvedApps.map((rawResolvedApp) =>
    parseResolvedApplicationRuntimePayload(rawResolvedApp)
  );
  const seenAppIds = new Set<string>();
  for (const resolvedApp of parsedResolvedApps) {
    if (seenAppIds.has(resolvedApp.appId)) {
      throw new AppLifecycleExecutorError(
        400,
        `resolved_applications contains duplicate app_id '${resolvedApp.appId}'`
      );
    }
    seenAppIds.add(resolvedApp.appId);
  }
  const preparedStarts = parsedResolvedApps.map((resolvedApp, index) => ({
    resolvedApp,
    appDir: appDirForResolvedApplication(resolvedWorkspaceDir, resolvedApp),
    ports: portsForWorkspaceApp({
      appId: resolvedApp.appId,
      fallbackIndex: index,
      store: params.store,
      workspaceId: params.workspaceId,
      allocate: true
    })
  }));
  const applications: ResolvedApplicationsBootstrapApplication[] = [];
  for (const preparedStart of preparedStarts) {
    let build =
      params.store && params.workspaceId
        ? params.store.getAppBuild({
          workspaceId: params.workspaceId,
          appId: preparedStart.resolvedApp.appId
        })
        : null;
    if (build?.status === "building" && params.store && params.workspaceId) {
      const settledStatus = await waitForInFlightAppBuild({
        store: params.store,
        workspaceId: params.workspaceId,
        appId: preparedStart.resolvedApp.appId
      });
      build = settledStatus
        ? params.store.getAppBuild({
          workspaceId: params.workspaceId,
          appId: preparedStart.resolvedApp.appId
        })
        : null;
    }
    if (build?.status === "failed") {
      throw new AppLifecycleExecutorError(
        500,
        `App '${preparedStart.resolvedApp.appId}' setup failed${build.error ? `: ${build.error}` : ""}`
      );
    }
    const started = await params.appLifecycleExecutor.startApp({
      appId: preparedStart.resolvedApp.appId,
      appDir: preparedStart.appDir,
      httpPort: preparedStart.ports.http,
      mcpPort: preparedStart.ports.mcp,
      holabossUserId,
      workspaceId: params.workspaceId,
      resolvedApp: preparedStart.resolvedApp,
      skipSetup: appBuildHasCompletedSetup(build?.status)
    });
    applications.push(
      normalizeResolvedApplicationsBootstrapApplication({
        requestedAppId: preparedStart.resolvedApp.appId,
        started,
        mcpPath: preparedStart.resolvedApp.mcp.path,
        timeoutMs: preparedStart.resolvedApp.healthCheck.timeoutS * 1000
      })
    );
  }
  return { applications };
}

export async function startResolvedApplications(params: {
  store: RuntimeStateStore;
  appLifecycleExecutor: AppLifecycleExecutorLike;
  workspaceId: string;
  body: ResolvedApplicationsBootstrapRequestPayload;
}): Promise<ResolvedApplicationsBootstrapResponse> {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new AppLifecycleExecutorError(404, "workspace not found");
  }
  const expectedWorkspaceDir = path.resolve(params.store.workspaceDir(workspace.id));
  const workspaceDir = optionalString(params.body.workspace_dir) ?? expectedWorkspaceDir;
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (resolvedWorkspaceDir !== expectedWorkspaceDir) {
    throw new AppLifecycleExecutorError(400, `workspace_dir does not match workspace '${params.workspaceId}'`);
  }
  return await bootstrapResolvedApplications({
    workspaceDir: resolvedWorkspaceDir,
    holabossUserId: params.body.holaboss_user_id,
    resolvedApplications: params.body.resolved_applications,
    store: params.store,
    workspaceId: params.workspaceId,
    appLifecycleExecutor: params.appLifecycleExecutor
  });
}
