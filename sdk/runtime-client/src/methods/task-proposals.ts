import type { RequestFn } from "../request";

export type TaskProposalRecord = {
  proposal_id: string;
  workspace_id: string;
  task_name: string;
  task_prompt: string;
  task_generation_rationale: string;
  proposal_source: "proactive" | "evolve";
  created_at: string;
  state: string;
  source_event_ids: string[];
  accepted_session_id: string | null;
  accepted_input_id: string | null;
  accepted_at: string | null;
};

export type TaskProposalListResponse = {
  proposals: TaskProposalRecord[];
  count: number;
};

export type TaskProposalAcceptPayload = {
  proposal_id: string;
  workspace_id: string;
  task_name?: string | null;
  task_prompt?: string | null;
  session_id?: string | null;
  parent_session_id?: string | null;
  created_by?: string | null;
  priority?: number;
  model?: string | null;
};

// The accept response carries `session` and `input` shapes owned by other
// runtime domains. Keeping the SDK type loose avoids cross-domain coupling;
// call sites that need richer typing can re-cast at the boundary.
export type TaskProposalAcceptResponse = {
  proposal: TaskProposalRecord;
  session: Record<string, unknown>;
  input: Record<string, unknown>;
};

export type TaskProposalStateUpdateResponse = {
  proposal: TaskProposalRecord;
};

export type TaskProposalsMethods = {
  listUnreviewed(workspaceId: string): Promise<TaskProposalListResponse>;
  accept(payload: TaskProposalAcceptPayload): Promise<TaskProposalAcceptResponse>;
  updateState(
    workspaceId: string,
    proposalId: string,
    state: string
  ): Promise<TaskProposalStateUpdateResponse>;
};

export function makeTaskProposalsMethods(
  request: RequestFn
): TaskProposalsMethods {
  return {
    listUnreviewed(workspaceId) {
      return request<TaskProposalListResponse>({
        method: "GET",
        path: "/api/v1/task-proposals/unreviewed",
        params: { workspace_id: workspaceId },
      });
    },
    accept(payload) {
      return request<TaskProposalAcceptResponse>({
        method: "POST",
        path: `/api/v1/task-proposals/${encodeURIComponent(payload.proposal_id)}/accept`,
        payload: {
          workspace_id: payload.workspace_id,
          task_name: payload.task_name,
          task_prompt: payload.task_prompt,
          session_id: payload.session_id,
          parent_session_id: payload.parent_session_id,
          created_by: payload.created_by,
          priority: payload.priority ?? 0,
          model: payload.model ?? null,
        },
      });
    },
    updateState(workspaceId, proposalId, state) {
      return request<TaskProposalStateUpdateResponse>({
        method: "PATCH",
        path: `/api/v1/task-proposals/${encodeURIComponent(proposalId)}`,
        payload: {
          workspace_id: workspaceId,
          state,
        },
      });
    },
  };
}
