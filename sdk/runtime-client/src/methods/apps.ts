import type { RequestFn } from "../request";

export type InstalledWorkspaceApp = {
  app_id: string;
  config_path: string;
  lifecycle: Record<string, string> | null;
  build_status?: string;
  ready: boolean;
  error: string | null;
};

export type InstalledWorkspaceAppListResponse = {
  apps: InstalledWorkspaceApp[];
  count: number;
};

export type AppCatalogEntry = {
  app_id: string;
  source: "marketplace" | "local";
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  tags: string[];
  version: string | null;
  archive_url: string | null;
  archive_path: string | null;
  target: string;
  cached_at: string;
  provider_id: string | null;
  credential_source: string | null;
};

export type AppCatalogListResponse = {
  entries: AppCatalogEntry[];
  count: number;
};

export type AppCatalogSyncResponse = {
  synced: number;
  source: "marketplace" | "local";
  target: string;
};

// TODO: tighten type — sync body assembled in main.ts with
// `source`, `target`, and an `entries` array of catalog rows.
export type AppCatalogSyncBody = Record<string, unknown>;

export type InstallAppFromCatalogResponse = {
  app_id: string;
  status: string;
  detail: string;
  ready: boolean;
  error: string | null;
};

export type InstallArchiveBody = {
  workspace_id: string;
  app_id: string;
  archive_path: string;
};

export type ListAppCatalogParams = {
  source?: "marketplace" | "local";
};

export type AppPortMap = Record<string, { http: number; mcp: number }>;

export type AppsMethods = {
  listCatalog(params?: ListAppCatalogParams): Promise<AppCatalogListResponse>;
  syncCatalog(payload: AppCatalogSyncBody): Promise<AppCatalogSyncResponse>;
  installArchive(
    payload: InstallArchiveBody,
    options?: { timeoutMs?: number }
  ): Promise<InstallAppFromCatalogResponse>;
  listInstalled(workspaceId: string): Promise<InstalledWorkspaceAppListResponse>;
  remove(
    workspaceId: string,
    appId: string,
    options?: { timeoutMs?: number }
  ): Promise<Record<string, unknown>>;
  listPorts(workspaceId: string): Promise<AppPortMap>;
};

export function makeAppsMethods(request: RequestFn): AppsMethods {
  return {
    listCatalog({ source } = {}) {
      const params: Record<string, string> = {};
      if (source) {
        params.source = source;
      }
      return request<AppCatalogListResponse>({
        method: "GET",
        path: "/api/v1/apps/catalog",
        params,
      });
    },

    syncCatalog(payload) {
      return request<AppCatalogSyncResponse>({
        method: "POST",
        path: "/api/v1/apps/catalog/sync",
        payload,
      });
    },

    installArchive(payload, options = {}) {
      return request<InstallAppFromCatalogResponse>({
        method: "POST",
        path: "/api/v1/apps/install-archive",
        payload,
        timeoutMs: options.timeoutMs ?? 300_000,
      });
    },

    listInstalled(workspaceId) {
      return request<InstalledWorkspaceAppListResponse>({
        method: "GET",
        path: "/api/v1/apps",
        params: {
          workspace_id: workspaceId,
        },
      });
    },

    remove(workspaceId, appId, options = {}) {
      return request<Record<string, unknown>>({
        method: "DELETE",
        path: `/api/v1/apps/${encodeURIComponent(appId)}`,
        payload: {
          workspace_id: workspaceId,
        },
        timeoutMs: options.timeoutMs ?? 30000,
      });
    },

    listPorts(workspaceId) {
      return request<AppPortMap>({
        method: "GET",
        path: "/api/v1/apps/ports",
        params: { workspace_id: workspaceId },
      });
    },
  };
}
