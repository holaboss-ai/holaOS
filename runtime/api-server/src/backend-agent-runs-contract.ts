export const BACKEND_AGENT_RUN_EVENT_TYPES = [
  "tool_call",
  "skill_invocation",
  "output_delta",
  "run_state",
  "run_completed",
  "run_failed",
] as const;

export type BackendAgentRunEventType =
  (typeof BACKEND_AGENT_RUN_EVENT_TYPES)[number];

export interface BackendAgentRunStartRequest {
  session_id: string;
  input_id: string;
  run_id: string;
  model?: string;
}

export interface BackendAgentRunEventRequest {
  session_id: string;
  input_id: string;
  run_id: string;
  sequence: number;
  event_type: BackendAgentRunEventType;
  payload: Record<string, unknown>;
  timestamp: string;
}
