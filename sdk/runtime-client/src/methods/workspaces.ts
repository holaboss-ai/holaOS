import type { RequestFn } from "../request";

export type WorkspaceRecord = {
  id: string;
  name: string;
  status: string;
  harness: string | null;
  error_message: string | null;
  onboarding_status: string;
  onboarding_state?: string | null;
  onboarding_session_id: string | null;
  alignment_question?: Record<string, unknown> | null;
  alignment_report?: Record<string, unknown> | null;
  verification_report?: Record<string, unknown> | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at_utc: string | null;
  icon?: string | null;
  icon_color?: string | null;
  workspace_path?: string | null;
  folder_state?: "healthy" | "missing" | null;
  workspace_role?: string | null;
  source_workspace_id?: string | null;
  lab_purpose?: string | null;
  lab_status?: string | null;
};

export type WorkspaceResponse = {
  workspace: WorkspaceRecord;
};

export type WorkspaceListResponse = {
  items: WorkspaceRecord[];
  total: number;
  limit: number;
  offset: number;
};

export type ListWorkspacesParams = {
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
};

// TODO: tighten type — payload shape mirrors the runtime POST /workspaces
// body, callers in main.ts assemble it with `name`, `harness`,
// `status`, `onboarding_status`, optional `workspace_path`, etc.
export type CreateWorkspaceBody = Record<string, unknown>;

// TODO: tighten type — patch body for PATCH /workspaces/{id}, accepts any
// subset of WorkspaceRecord-shaped fields plus runtime-managed ones like
// `error_message`, `onboarding_status`, `onboarding_session_id`,
// `workspace_path`.
export type UpdateWorkspaceBody = Record<string, unknown>;

export type DeleteWorkspaceOptions = {
  keepFiles?: boolean;
};

export type WorkspacesMethods = {
  list(params?: ListWorkspacesParams): Promise<WorkspaceListResponse>;
  get(workspaceId: string): Promise<WorkspaceResponse>;
  create(payload: CreateWorkspaceBody): Promise<WorkspaceResponse>;
  update(
    workspaceId: string,
    payload: UpdateWorkspaceBody
  ): Promise<WorkspaceResponse>;
  delete(
    workspaceId: string,
    options?: DeleteWorkspaceOptions
  ): Promise<WorkspaceResponse>;
  activate(workspaceId: string): Promise<WorkspaceResponse>;
  ensureAppsRunning(workspaceId: string): Promise<Record<string, unknown>>;
};

export function makeWorkspacesMethods(request: RequestFn): WorkspacesMethods {
  return {
    list({ includeDeleted = false, limit = 100, offset = 0 } = {}) {
      return request<WorkspaceListResponse>({
        method: "GET",
        path: "/api/v1/workspaces",
        params: {
          include_deleted: includeDeleted,
          limit,
          offset,
        },
      });
    },

    get(workspaceId) {
      return request<WorkspaceResponse>({
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      });
    },

    create(payload) {
      return request<WorkspaceResponse>({
        method: "POST",
        path: "/api/v1/workspaces",
        payload,
      });
    },

    update(workspaceId, payload) {
      return request<WorkspaceResponse>({
        method: "PATCH",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        payload,
      });
    },

    delete(workspaceId, options = {}) {
      const req = {
        method: "DELETE" as const,
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        ...(options.keepFiles !== undefined
          ? { params: { keep_files: options.keepFiles } }
          : {}),
      };
      return request<WorkspaceResponse>(req);
    },

    activate(workspaceId) {
      return request<WorkspaceResponse>({
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        payload: {},
      });
    },

    ensureAppsRunning(workspaceId) {
      return request<Record<string, unknown>>({
        method: "POST",
        path: "/api/v1/apps/ensure-running",
        payload: { workspace_id: workspaceId },
        timeoutMs: 300000,
        retryTransientErrors: true,
      });
    },
  };
}
