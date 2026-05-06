import type { RequestFn } from "../request";

export type RuntimeNotificationLevel = "info" | "success" | "warning" | "error";
export type RuntimeNotificationPriority = "low" | "normal" | "high" | "critical";
export type RuntimeNotificationState = "unread" | "read" | "dismissed";

export type RuntimeNotificationRecord = {
  id: string;
  workspace_id: string;
  cronjob_id: string | null;
  source_type: string;
  source_label: string | null;
  title: string;
  message: string;
  level: RuntimeNotificationLevel;
  priority: RuntimeNotificationPriority;
  state: RuntimeNotificationState;
  metadata: Record<string, unknown>;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RuntimeNotificationListResponse = {
  items: RuntimeNotificationRecord[];
  count: number;
};

export type RuntimeNotificationUpdatePayload = {
  state?: RuntimeNotificationState;
};

export type ListNotificationsParams = {
  workspaceId?: string | null;
  includeDismissed?: boolean;
  limit?: number;
};

export type NotificationsMethods = {
  list(params?: ListNotificationsParams): Promise<RuntimeNotificationListResponse>;
  update(
    workspaceId: string,
    notificationId: string,
    payload: RuntimeNotificationUpdatePayload
  ): Promise<RuntimeNotificationRecord>;
};

export function makeNotificationsMethods(
  request: RequestFn
): NotificationsMethods {
  return {
    list({ workspaceId, includeDismissed = false, limit = 50 } = {}) {
      return request<RuntimeNotificationListResponse>({
        method: "GET",
        path: "/api/v1/notifications",
        params: {
          workspace_id: workspaceId ?? undefined,
          include_dismissed: includeDismissed,
          limit,
        },
      });
    },
    update(workspaceId, notificationId, payload) {
      return request<RuntimeNotificationRecord>({
        method: "PATCH",
        path: `/api/v1/notifications/${encodeURIComponent(notificationId)}`,
        payload: {
          workspace_id: workspaceId,
          ...payload,
        },
      });
    },
  };
}
