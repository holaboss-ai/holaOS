import type { RequestFn } from "../request";

export type AgentSessionRecord = {
  workspace_id: string;
  session_id: string;
  kind: string;
  title: string | null;
  parent_session_id: string | null;
  source_proposal_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type AgentSessionListResponse = {
  items: AgentSessionRecord[];
  count: number;
};

export type CreateAgentSessionBody = {
  workspace_id: string;
  session_id?: string | null;
  kind?: string | null;
  title?: string | null;
  parent_session_id?: string | null;
  created_by?: string | null;
};

export type CreateAgentSessionResponse = {
  session: AgentSessionRecord;
};

export type SessionRuntimeRecord = {
  workspace_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  has_queued_inputs?: boolean;
  current_input_id: string | null;
  current_worker_id: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  last_error: Record<string, unknown> | null;
  last_turn_status: string | null;
  last_turn_completed_at: string | null;
  last_turn_stop_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRuntimeStateListResponse = {
  items: SessionRuntimeRecord[];
  count: number;
};

export type SessionHistoryMessage = {
  id: string;
  role: string;
  text: string;
  created_at: string | null;
  metadata: Record<string, unknown>;
};

export type SessionHistoryResponse = {
  workspace_id: string;
  session_id: string;
  harness: string;
  harness_session_id: string;
  source: string;
  messages: SessionHistoryMessage[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  raw: unknown | null;
};

export type GetSessionHistoryParams = {
  sessionId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
};

export type SessionOutputEvent = {
  id: number;
  workspace_id: string;
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type SessionOutputEventListResponse = {
  items: SessionOutputEvent[];
  count: number;
  last_event_id: number;
};

export type GetSessionOutputEventsParams = {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
};

export type EnqueueSessionInputResponse = {
  input_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  current_input_id?: string | null;
  has_queued_inputs?: boolean;
};

// TODO: tighten type — payload mirrors HolabossQueueSessionInputPayload but
// sent as the runtime POST body directly (snake_case fields).
export type QueueSessionInputBody = Record<string, unknown>;

export type PauseSessionRunResponse = {
  input_id: string;
  session_id: string;
  status: string;
};

export type PauseSessionRunBody = {
  workspace_id: string;
};

export type UpdateQueuedSessionInputResponse = {
  input_id: string;
  session_id: string;
  status: string;
  text: string;
  updated_at: string;
};

export type UpdateQueuedSessionInputBody = {
  workspace_id: string;
  text: string;
};

export type ListAgentSessionsParams = {
  workspaceId: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type ListRuntimeStatesParams = {
  workspaceId: string;
  limit?: number;
  offset?: number;
};

export type SessionsMethods = {
  list(params: ListAgentSessionsParams): Promise<AgentSessionListResponse>;
  create(payload: CreateAgentSessionBody): Promise<CreateAgentSessionResponse>;
  listRuntimeStates(
    params: ListRuntimeStatesParams
  ): Promise<SessionRuntimeStateListResponse>;
  getHistory(params: GetSessionHistoryParams): Promise<SessionHistoryResponse>;
  getOutputEvents(
    params: GetSessionOutputEventsParams
  ): Promise<SessionOutputEventListResponse>;
  queueInput(
    payload: QueueSessionInputBody,
    options?: { retryTransientErrors?: boolean }
  ): Promise<EnqueueSessionInputResponse>;
  pause(
    sessionId: string,
    payload: PauseSessionRunBody
  ): Promise<PauseSessionRunResponse>;
  updateQueuedInput(
    sessionId: string,
    inputId: string,
    payload: UpdateQueuedSessionInputBody
  ): Promise<UpdateQueuedSessionInputResponse>;
};

export function makeSessionsMethods(request: RequestFn): SessionsMethods {
  return {
    list({ workspaceId, includeArchived = false, limit = 100, offset = 0 }) {
      return request<AgentSessionListResponse>({
        method: "GET",
        path: "/api/v1/agent-sessions",
        params: {
          workspace_id: workspaceId,
          include_archived: includeArchived,
          limit,
          offset,
        },
      });
    },

    create(payload) {
      return request<CreateAgentSessionResponse>({
        method: "POST",
        path: "/api/v1/agent-sessions",
        payload,
      });
    },

    listRuntimeStates({ workspaceId, limit = 100, offset = 0 }) {
      return request<SessionRuntimeStateListResponse>({
        method: "GET",
        path: `/api/v1/agent-sessions/by-workspace/${workspaceId}/runtime-states`,
        params: {
          limit,
          offset,
        },
      });
    },

    getHistory(params) {
      return request<SessionHistoryResponse>({
        method: "GET",
        path: `/api/v1/agent-sessions/${params.sessionId}/history`,
        params: {
          workspace_id: params.workspaceId,
          limit: params.limit ?? 200,
          offset: params.offset ?? 0,
          order: params.order ?? "asc",
        },
      });
    },

    getOutputEvents(params) {
      return request<SessionOutputEventListResponse>({
        method: "GET",
        path: `/api/v1/agent-sessions/${encodeURIComponent(params.sessionId)}/outputs/events`,
        params: {
          workspace_id: params.workspaceId,
          input_id: params.inputId ?? undefined,
          include_history: true,
          after_event_id: 0,
          include_native: false,
        },
      });
    },

    queueInput(payload, options = {}) {
      return request<EnqueueSessionInputResponse>({
        method: "POST",
        path: "/api/v1/agent-sessions/queue",
        payload,
        retryTransientErrors: options.retryTransientErrors ?? false,
      });
    },

    pause(sessionId, payload) {
      return request<PauseSessionRunResponse>({
        method: "POST",
        path: `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/pause`,
        payload,
      });
    },

    updateQueuedInput(sessionId, inputId, payload) {
      return request<UpdateQueuedSessionInputResponse>({
        method: "PATCH",
        path: `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}`,
        payload,
      });
    },
  };
}
