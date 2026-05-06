import type { RequestFn } from "../request";

export type CronjobDelivery = {
  mode: string;
  channel: string;
  to: string | null;
};

export type CronjobRecord = {
  id: string;
  workspace_id: string;
  initiated_by: string;
  name: string;
  cron: string;
  description: string;
  instruction: string;
  enabled: boolean;
  delivery: CronjobDelivery;
  metadata: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type CronjobListResponse = {
  jobs: CronjobRecord[];
  count: number;
};

export type CronjobRunResponse = {
  success: boolean;
  cronjob: CronjobRecord;
  session_id: string | null;
  notification_id: string | null;
};

export type CronjobCreatePayload = {
  workspace_id: string;
  initiated_by: string;
  name?: string;
  cron: string;
  description: string;
  instruction?: string;
  enabled?: boolean;
  delivery: CronjobDelivery;
  metadata?: Record<string, unknown>;
};

export type CronjobUpdatePayload = {
  name?: string;
  cron?: string;
  description?: string;
  instruction?: string;
  enabled?: boolean;
  delivery?: CronjobDelivery;
  metadata?: Record<string, unknown>;
};

export type CronjobsMethods = {
  list(workspaceId: string, enabledOnly?: boolean): Promise<CronjobListResponse>;
  runNow(workspaceId: string, jobId: string): Promise<CronjobRunResponse>;
  create(payload: CronjobCreatePayload): Promise<CronjobRecord>;
  update(
    workspaceId: string,
    jobId: string,
    payload: CronjobUpdatePayload
  ): Promise<CronjobRecord>;
  delete(workspaceId: string, jobId: string): Promise<{ success: boolean }>;
};

export function makeCronjobsMethods(request: RequestFn): CronjobsMethods {
  return {
    list(workspaceId, enabledOnly = false) {
      return request<CronjobListResponse>({
        method: "GET",
        path: "/api/v1/cronjobs",
        params: {
          workspace_id: workspaceId,
          enabled_only: enabledOnly,
        },
      });
    },
    runNow(workspaceId, jobId) {
      return request<CronjobRunResponse>({
        method: "POST",
        path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}/run`,
        params: {
          workspace_id: workspaceId,
        },
      });
    },
    create(payload) {
      return request<CronjobRecord>({
        method: "POST",
        path: "/api/v1/cronjobs",
        payload,
      });
    },
    update(workspaceId, jobId, payload) {
      return request<CronjobRecord>({
        method: "PATCH",
        path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}`,
        payload: {
          workspace_id: workspaceId,
          ...payload,
        },
      });
    },
    delete(workspaceId, jobId) {
      return request<{ success: boolean }>({
        method: "DELETE",
        path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}`,
        params: {
          workspace_id: workspaceId,
        },
      });
    },
  };
}
