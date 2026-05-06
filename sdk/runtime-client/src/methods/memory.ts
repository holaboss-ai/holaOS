import type { RequestFn } from "../request";

export type MemoryUpdateProposalKind = "preference" | "identity" | "profile";
export type MemoryUpdateProposalState = "pending" | "accepted" | "dismissed";

export type MemoryUpdateProposalRecord = {
  proposal_id: string;
  workspace_id: string;
  session_id: string;
  input_id: string;
  proposal_kind: MemoryUpdateProposalKind;
  target_key: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: string | null;
  confidence: number | null;
  source_message_id: string | null;
  state: MemoryUpdateProposalState;
  persisted_memory_id: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  dismissed_at: string | null;
};

export type MemoryUpdateProposalListParams = {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  state?: MemoryUpdateProposalState | null;
  limit?: number;
  offset?: number;
};

export type MemoryUpdateProposalListResponse = {
  proposals: MemoryUpdateProposalRecord[];
  count: number;
};

export type MemoryUpdateProposalAcceptPayload = {
  proposalId: string;
  workspaceId: string;
  summary?: string | null;
};

export type MemoryUpdateProposalAcceptResponse = {
  proposal: MemoryUpdateProposalRecord;
};

export type MemoryUpdateProposalDismissResponse = {
  proposal: MemoryUpdateProposalRecord;
};

export type MemoryMethods = {
  listUpdateProposals(
    params: MemoryUpdateProposalListParams
  ): Promise<MemoryUpdateProposalListResponse>;
  acceptUpdateProposal(
    payload: MemoryUpdateProposalAcceptPayload
  ): Promise<MemoryUpdateProposalAcceptResponse>;
  dismissUpdateProposal(
    workspaceId: string,
    proposalId: string
  ): Promise<MemoryUpdateProposalDismissResponse>;
};

export function makeMemoryMethods(request: RequestFn): MemoryMethods {
  return {
    listUpdateProposals(params) {
      return request<MemoryUpdateProposalListResponse>({
        method: "GET",
        path: "/api/v1/memory-update-proposals",
        params: {
          workspace_id: params.workspaceId,
          session_id: params.sessionId ?? undefined,
          input_id: params.inputId ?? undefined,
          state: params.state ?? undefined,
          limit: params.limit ?? 200,
          offset: params.offset ?? 0,
        },
      });
    },
    acceptUpdateProposal(payload) {
      return request<MemoryUpdateProposalAcceptResponse>({
        method: "POST",
        path: `/api/v1/memory-update-proposals/${encodeURIComponent(payload.proposalId)}/accept`,
        payload: {
          workspace_id: payload.workspaceId,
          summary: payload.summary ?? undefined,
        },
      });
    },
    dismissUpdateProposal(workspaceId, proposalId) {
      return request<MemoryUpdateProposalDismissResponse>({
        method: "POST",
        path: `/api/v1/memory-update-proposals/${encodeURIComponent(proposalId)}/dismiss`,
        payload: {
          workspace_id: workspaceId,
        },
      });
    },
  };
}
