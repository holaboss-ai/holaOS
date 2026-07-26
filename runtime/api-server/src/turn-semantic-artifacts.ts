import fs from "node:fs";
import path from "node:path";

import type { RuntimeStateStore, SessionMessageRecord, TurnResultRecord } from "@holaboss/runtime-state-store";

import { compactTurnSummary } from "./turn-result-summary.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
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
  const assistantMessageText = assistantMessageTextForTurn(store, turnResult);
  if (assistantMessageText.trim().length > 0) {
    return assistantMessageText;
  }
  return turnResult.assistantText;
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

type IntegrationToolAccount = {
  providerId: string;
  accountNamespace: string;
  connectionId: string | null;
};

export interface TurnIntegrationToolEvidenceEntry {
  providerId: string;
  accountNamespace: string;
  connectionId: string | null;
  toolName: string;
  toolId: string | null;
  callId: string | null;
  resultSummary: string | null;
  resultBodyText: string | null;
  outputEventId: number;
  observedAt: string;
}

function integrationAccountFromToolResult(result: unknown): IntegrationToolAccount | null {
  const topLevel = isRecord(result) ? result : null;
  const details = topLevel && isRecord(topLevel.details) ? topLevel.details : null;
  const raw = details && isRecord(details.raw) ? details.raw : null;
  for (const candidate of [raw, topLevel]) {
    if (!candidate) {
      continue;
    }
    const meta = isRecord(candidate._meta) ? candidate._meta : null;
    const integration = meta && isRecord(meta.holaboss_integration_account)
      ? meta.holaboss_integration_account
      : null;
    const providerId = integration && optionalString(integration.provider_id);
    const accountNamespace = integration && optionalString(integration.account_namespace);
    const connectionId = integration && optionalString(integration.connection_id);
    if (providerId && accountNamespace) {
      return {
        providerId,
        accountNamespace,
        connectionId,
      };
    }
  }
  return null;
}

export type TurnInputAttachment = {
  id: string;
  kind: "file" | "image" | "folder";
  name: string;
  mimeType: string;
  sizeBytes: number;
  workspacePath: string;
};

function turnInputAttachmentFromValue(value: unknown): TurnInputAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const mimeType = optionalString(value.mime_type) ?? optionalString(value.mimeType);
  const workspacePath = optionalString(value.workspace_path) ?? optionalString(value.workspacePath);
  const sizeBytes = typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes)
    ? Math.max(0, Math.trunc(value.size_bytes))
    : typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
      ? Math.max(0, Math.trunc(value.sizeBytes))
      : 0;
  const kind = value.kind === "image"
    ? "image"
    : value.kind === "folder"
      ? "folder"
      : value.kind === "file"
        ? "file"
        : mimeType?.startsWith("image/")
          ? "image"
          : mimeType === "inode/directory"
            ? "folder"
            : "file";
  if (!id || !name || !mimeType || !workspacePath) {
    return null;
  }
  return {
    id,
    kind,
    name,
    mimeType,
    sizeBytes,
    workspacePath,
  };
}

export function inputAttachmentsForTurn(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): TurnInputAttachment[] {
  const attachments = store.getInput({
    workspaceId: turnResult.workspaceId,
    inputId: turnResult.inputId,
  })?.payload.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .map((item) => turnInputAttachmentFromValue(item))
    .filter((item): item is TurnInputAttachment => Boolean(item));
}

export function attachmentPreviewText(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  attachment: TurnInputAttachment;
}): string | null {
  if (params.attachment.kind === "folder") {
    return null;
  }
  if (!/^(text\/|application\/json$|application\/(xml|xhtml\+xml)$)/i.test(params.attachment.mimeType)) {
    return null;
  }
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const absolutePath = path.join(workspaceDir, params.attachment.workspacePath);
  try {
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return null;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    const collapsed = content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return collapsed ? clipText(collapsed, 240) : null;
  } catch {
    return null;
  }
}

function textFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) ? optionalString(part.text) : null))
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text ? clipText(text, 320) : null;
}

function fullTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (!isRecord(part)) {
        return null;
      }
      const text = optionalString(part.text);
      if (text) {
        return text;
      }
      const html = optionalString(part.html);
      if (html) {
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return text ? text.trim() : null;
}

function safeJsonWithoutMeta(value: Record<string, unknown>): string | null {
  const clone = { ...value };
  delete clone._meta;
  const json = JSON.stringify(clone, null, 2);
  return json && json !== "{}" ? json : null;
}

function summarizedToolResultText(result: unknown): string | null {
  const topLevel = isRecord(result) ? result : null;
  const details = topLevel && isRecord(topLevel.details) ? topLevel.details : null;
  const raw = details && isRecord(details.raw) ? details.raw : null;
  for (const candidate of [topLevel, raw]) {
    if (!candidate) {
      continue;
    }
    const contentText = textFromContentBlocks(candidate.content);
    if (contentText) {
      return contentText;
    }
    const structured = isRecord(candidate.structuredContent) ? candidate.structuredContent : null;
    if (structured) {
      const clone = { ...structured };
      delete clone._meta;
      const json = clipText(JSON.stringify(clone), 320);
      if (json) {
        return json;
      }
    }
  }
  if (raw) {
    const clone = { ...raw };
    delete clone._meta;
    return clipText(JSON.stringify(clone), 320);
  }
  if (topLevel) {
    const clone = { ...topLevel };
    delete clone._meta;
    return clipText(JSON.stringify(clone), 320);
  }
  return null;
}

function fullToolResultText(result: unknown): string | null {
  const topLevel = isRecord(result) ? result : null;
  const details = topLevel && isRecord(topLevel.details) ? topLevel.details : null;
  const raw = details && isRecord(details.raw) ? details.raw : null;
  const sections: string[] = [];

  for (const candidate of [topLevel, raw]) {
    if (!candidate) {
      continue;
    }
    const contentText = fullTextFromContentBlocks(candidate.content);
    if (contentText) {
      sections.push(contentText);
    }
    const structured = isRecord(candidate.structuredContent) ? candidate.structuredContent : null;
    if (structured) {
      const json = safeJsonWithoutMeta(structured);
      if (json) {
        sections.push(`Structured content:\n${json}`);
      }
    }
  }

  if (raw) {
    const json = safeJsonWithoutMeta(raw);
    if (json) {
      sections.push(`Raw details:\n${json}`);
    }
  } else if (topLevel) {
    const json = safeJsonWithoutMeta(topLevel);
    if (json) {
      sections.push(`Tool result:\n${json}`);
    }
  }

  const combined = sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
  return combined || null;
}

export function integrationToolEvidenceEntriesFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): TurnIntegrationToolEvidenceEntry[] {
  const entries = new Map<string, TurnIntegrationToolEvidenceEntry>();
  for (const event of store.listOutputEvents({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    inputId: turnResult.inputId,
  })) {
    if (event.eventType !== "tool_call") {
      continue;
    }
    const payload = event.payload;
    if (payload.phase !== "completed" || payload.error === true) {
      continue;
    }
    const account = integrationAccountFromToolResult(payload.result);
    if (!account) {
      continue;
    }
    const toolName = optionalString(payload.tool_name) ?? optionalString(payload.tool_id) ?? "integration_tool";
    const callId = optionalString(payload.call_id);
    const entryKey = callId ?? `output-event:${event.id}`;
    entries.set(entryKey, {
      providerId: account.providerId,
      accountNamespace: account.accountNamespace,
      connectionId: account.connectionId,
      toolName,
      toolId: optionalString(payload.tool_id),
      callId,
      resultSummary: summarizedToolResultText(payload.result),
      resultBodyText: fullToolResultText(payload.result),
      outputEventId: event.id,
      observedAt: event.createdAt,
    });
  }
  return [...entries.values()];
}

export function integrationToolEvidenceFromTurnArtifacts(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string[] {
  return integrationToolEvidenceEntriesFromTurnArtifacts(store, turnResult)
    .slice(0, 4)
    .map((entry) =>
      compactWhitespace(
        `[${entry.providerId} ${entry.accountNamespace}] ${entry.toolName}${entry.resultSummary ? ` => ${entry.resultSummary}` : ""}`,
      ),
    );
}

export function attachmentEvidenceFromTurnInput(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string[] {
  return inputAttachmentsForTurn(store, turnResult)
    .slice(0, 6)
    .map((attachment) => {
      const preview = attachmentPreviewText({
        store,
        workspaceId: turnResult.workspaceId,
        attachment,
      });
      const header = `${attachment.name} [${attachment.kind}, ${attachment.mimeType}] at ${attachment.workspacePath}`;
      return preview
        ? compactWhitespace(`${header} => ${preview}`)
        : compactWhitespace(header);
    });
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
