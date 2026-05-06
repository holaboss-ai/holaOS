import type { RuntimeStateStore, SessionMessageRecord, TurnResultRecord } from "@holaboss/runtime-state-store";

import { compactTurnSummary } from "./turn-result-summary.js";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function permissionDenialFromEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (payload.error !== true) {
    return null;
  }

  const candidates = [
    typeof payload.message === "string" ? payload.message : null,
    typeof payload.result === "string" ? payload.result : null,
    typeof payload.error_message === "string" ? payload.error_message : null,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const denialText = candidates.find((value) =>
    /permission|denied|not allowed/i.test(value),
  );
  if (!denialText) {
    return null;
  }

  return {
    tool_name:
      typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
    tool_id: typeof payload.tool_id === "string" ? payload.tool_id : null,
    reason: denialText,
  };
}

function assistantMessageTextForTurn(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string {
  const targetId = `assistant-${turnResult.inputId}`;
  const assistantMessages = store.listSessionMessages({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    role: "assistant",
    order: "desc",
    limit: 50,
    offset: 0,
  });
  const match = assistantMessages.find((message) => message.id === targetId);
  return match?.text ?? "";
}

export function assistantTextFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string {
  const deltas = store
    .listOutputEvents({
      workspaceId: turnResult.workspaceId,
      sessionId: turnResult.sessionId,
      inputId: turnResult.inputId,
    })
    .filter((event) => event.eventType === "output_delta")
    .map((event) => optionalString(event.payload.delta) ?? "")
    .filter(Boolean);
  if (deltas.length > 0) {
    return deltas.join("");
  }
  return assistantMessageTextForTurn(store, turnResult);
}

export function compactedSummaryFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string | null {
  return compactTurnSummary({
    ...turnResult,
    assistantText: assistantTextFromTurnArtifacts(store, turnResult),
  });
}

export function permissionDenialsFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const denials: Array<Record<string, unknown>> = [];
  for (const event of store.listOutputEvents({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    inputId: turnResult.inputId,
  })) {
    if (event.eventType !== "tool_call") {
      continue;
    }
    const denial = permissionDenialFromEventPayload(event.payload);
    if (!denial) {
      continue;
    }
    const key = JSON.stringify([
      optionalString(denial.tool_name) ?? "unknown",
      optionalString(denial.tool_id),
      optionalString(denial.reason) ?? "permission denied",
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    denials.push(denial);
  }
  return denials;
}

export function toolUsageSummaryFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): Record<string, unknown> {
  const calls = new Map<
    string,
    {
      toolName: string;
      toolId: string | null;
      completed: boolean;
      error: boolean;
    }
  >();
  for (const event of store.listOutputEvents({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    inputId: turnResult.inputId,
  })) {
    if (event.eventType !== "tool_call") {
      continue;
    }
    const payload = event.payload;
    const callId = optionalString(payload.call_id) ?? `sequence:${event.sequence}`;
    const existing = calls.get(callId);
    const toolName = optionalString(payload.tool_name) ?? existing?.toolName ?? "unknown";
    const toolId = optionalString(payload.tool_id) ?? existing?.toolId ?? null;
    const completed = payload.phase === "completed" || existing?.completed === true;
    const error = payload.error === true || existing?.error === true;
    calls.set(callId, {
      toolName,
      toolId,
      completed,
      error,
    });
  }
  const entries = [...calls.values()];
  return {
    total_calls: entries.length,
    completed_calls: entries.filter((entry) => entry.completed && !entry.error).length,
    failed_calls: entries.filter((entry) => entry.error).length,
    tool_names: [...new Set(entries.map((entry) => entry.toolName).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    ),
    tool_ids: [
      ...new Set(entries.map((entry) => entry.toolId).filter((value): value is string => Boolean(value))),
    ].sort((left, right) => left.localeCompare(right)),
  };
}

export function recentUserMessagesForTurn(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
  limit: number,
): SessionMessageRecord[] {
  return store
    .listSessionMessages({
      workspaceId: turnResult.workspaceId,
      sessionId: turnResult.sessionId,
      role: "user",
      order: "desc",
      limit,
      offset: 0,
    })
    .reverse();
}

export function latestUserMessageForSessionMessages(
  sessionMessages: SessionMessageRecord[],
): SessionMessageRecord | null {
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index];
    if (message.role === "user" && compactWhitespace(message.text)) {
      return message;
    }
  }
  return null;
}
