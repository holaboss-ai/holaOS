import { createHash, randomBytes } from "node:crypto";

import type { PublishAction } from "./publish-action-classifier.js";

export const PUBLISH_APPROVAL_TTL_MS = 30 * 60 * 1000;
const PENDING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CARD_QUESTIONS = 4;
const MAX_REQUESTS_PER_SESSION = 20;
const ANSWER_SCAN_LIMIT = 100;
const QUESTION_ID_PREFIX = "publish_approval_";
const APPROVE_OPTION_ID = "approve";
const DECLINE_OPTION_ID = "decline";
const BACKGROUND_SESSION_KINDS: ReadonlySet<string> = new Set([
  "subagent",
  "task_proposal",
]);

const APPROVAL_REQUIRED_MESSAGE =
  "Publishing needs the user's approval. The exact content is now shown to them in an approval card. " +
  "Stop and end your turn without retrying. If they approve, call this tool again with exactly the same arguments; " +
  "if they ask for changes, revise and call it again to request a new approval.";
const APPROVAL_DECLINED_MESSAGE =
  "The user did not approve this content, so it was not published. Follow their reply; " +
  "if they asked for changes, revise and call the tool again to request a new approval.";
const APPROVAL_UNAVAILABLE_MESSAGE =
  "Publishing needs the user's approval, which can't be requested from this session. " +
  "Don't publish from here; return the final draft so the user can approve it in their chat.";

// Scheduled jobs and IM chats can't show the desktop approval card; they keep posting as configured.
function isUnattendedSession(createdBy: string | null | undefined): boolean {
  const origin = (createdBy ?? "").trim().toLowerCase();
  return origin === "cronjob" || origin.startsWith("im:");
}

export type PublishApprovalBlockCode =
  | "approval_required"
  | "approval_declined"
  | "approval_unavailable";

export type PublishApprovalDecision =
  | { allowed: true }
  | { allowed: false; code: PublishApprovalBlockCode; message: string };

export interface PublishApprovalStore {
  getSession(params: {
    workspaceId: string;
    sessionId: string;
  }): { kind: string; createdBy?: string | null } | null;
  setSessionActiveUserQuestion(params: {
    workspaceId: string;
    sessionId: string;
    activeUserQuestion: string | null;
  }): unknown;
  listSessionInputs(params: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
  }): Array<{ payload: Record<string, unknown>; createdAt: string }>;
}

export interface PublishApprovalRequest {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
  action: PublishAction;
  toolkitSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
}

type ApprovalStatus = "pending" | "approved" | "declined";

interface ApprovalRecord {
  questionId: string;
  fingerprint: string;
  title: string;
  prompt: string;
  inputId: string;
  createdAtMs: number;
  status: ApprovalStatus;
  answeredAtMs: number | null;
}

type InputRecord = { payload: Record<string, unknown>; createdAt: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === null || entry === undefined) {
        continue;
      }
      result[key] = canonicalValue(entry);
    }
    return result;
  }
  return value;
}

export function publishPayloadFingerprint(params: {
  toolkitSlug: string;
  toolSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    toolkit: params.toolkitSlug.trim().toLowerCase(),
    tool: params.toolSlug.trim().toUpperCase(),
    account: params.connectedAccountId.trim(),
    arguments: canonicalValue(params.arguments ?? {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function renderPublishContent(args: Record<string, unknown>): string {
  const canonical = canonicalValue(args ?? {});
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(isRecord(canonical) ? canonical : {})) {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    blocks.push(text.includes("\n") ? `${key}:\n${text}` : `${key}: ${text}`);
  }
  return blocks.join("\n\n").trim() || "(no content)";
}

function findAnswer(
  inputs: InputRecord[],
  record: ApprovalRecord,
): { approved: boolean; answeredAtMs: number } | null {
  for (const input of inputs) {
    const context = isRecord(input.payload.context) ? input.payload.context : null;
    if (
      !context ||
      context.source !== "ask_user_question" ||
      !Array.isArray(context.questions)
    ) {
      continue;
    }
    for (const entry of context.questions) {
      if (!isRecord(entry) || entry.question_id !== record.questionId) {
        continue;
      }
      const answeredAtMs = Date.parse(input.createdAt);
      const approved =
        Number.isFinite(answeredAtMs) &&
        entry.option_id === APPROVE_OPTION_ID &&
        entry.question_prompt === record.prompt &&
        entry.skipped !== true &&
        !entry.response_text;
      return { approved, answeredAtMs };
    }
  }
  return null;
}

function approvalCard(records: ApprovalRecord[]): Record<string, unknown> {
  return {
    title: "Approve before publishing",
    questions: records.map((record) => ({
      id: record.questionId,
      title: record.title,
      prompt: record.prompt,
      allow_freeform: true,
      freeform_placeholder: "Or say what to change",
      options: [
        {
          id: DECLINE_OPTION_ID,
          label: "Don't publish",
          answer_text: "Don't publish this.",
        },
        {
          id: APPROVE_OPTION_ID,
          label: "Publish exactly this",
          answer_text:
            "Approved. Publish it exactly as shown, with the same arguments.",
        },
      ],
    })),
  };
}

export class PublishApprovalGate {
  private readonly records = new Map<string, ApprovalRecord[]>();
  private readonly store: PublishApprovalStore;
  private readonly now: () => number;
  private readonly approvalTtlMs: number;

  constructor(options: {
    store: PublishApprovalStore;
    now?: () => number;
    approvalTtlMs?: number;
  }) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? PUBLISH_APPROVAL_TTL_MS;
  }

  authorize(request: PublishApprovalRequest): PublishApprovalDecision {
    const workspaceId = request.workspaceId.trim();
    const sessionId = request.sessionId.trim();
    const session =
      workspaceId && sessionId
        ? this.store.getSession({ workspaceId, sessionId })
        : null;
    if (
      !session ||
      BACKGROUND_SESSION_KINDS.has(session.kind.trim().toLowerCase())
    ) {
      return blocked("approval_unavailable");
    }
    if (isUnattendedSession(session.createdBy)) {
      return { allowed: true };
    }
    const key = `${workspaceId}\u0000${sessionId}`;
    const now = this.now();
    const records = this.resolve(key, workspaceId, sessionId, now);
    const fingerprint = publishPayloadFingerprint({
      toolkitSlug: request.toolkitSlug,
      toolSlug: request.action.toolSlug,
      connectedAccountId: request.connectedAccountId,
      arguments: request.arguments,
    });
    const match = records.find((record) => record.fingerprint === fingerprint);
    if (match?.status === "approved") {
      this.records.set(key, records.filter((record) => record !== match));
      return { allowed: true };
    }
    if (match?.status === "declined") {
      this.records.set(
        key,
        records.filter((record) => record.status !== "declined"),
      );
      return blocked("approval_declined");
    }
    const inputId = request.inputId?.trim() ?? "";
    const current: ApprovalRecord = match ?? {
      questionId: `${QUESTION_ID_PREFIX}${randomBytes(16).toString("hex")}`,
      fingerprint,
      title: `${request.action.platformLabel} · ${request.action.actionLabel}`,
      prompt: renderPublishContent(request.arguments),
      inputId,
      createdAtMs: now,
      status: "pending",
      answeredAtMs: null,
    };
    current.inputId = inputId;
    const kept = records.filter(
      (record) =>
        record !== current &&
        (record.status === "approved" ||
          (record.status === "pending" && record.inputId === inputId)),
    );
    const next = [...kept, current].slice(-MAX_REQUESTS_PER_SESSION);
    this.records.set(key, next);
    const shown = next
      .filter((record) => record.status === "pending")
      .slice(-MAX_CARD_QUESTIONS);
    try {
      this.store.setSessionActiveUserQuestion({
        workspaceId,
        sessionId,
        activeUserQuestion: JSON.stringify(approvalCard(shown)),
      });
    } catch {
      return blocked("approval_unavailable");
    }
    return blocked("approval_required");
  }

  private resolve(
    key: string,
    workspaceId: string,
    sessionId: string,
    now: number,
  ): ApprovalRecord[] {
    const records = this.records.get(key) ?? [];
    if (records.length === 0) {
      return [];
    }
    const inputs = records.some((record) => record.status === "pending")
      ? this.store.listSessionInputs({
          workspaceId,
          sessionId,
          limit: ANSWER_SCAN_LIMIT,
        })
      : [];
    for (const record of records) {
      if (record.status !== "pending") {
        continue;
      }
      const answer = findAnswer(inputs, record);
      if (answer) {
        record.status = answer.approved ? "approved" : "declined";
        record.answeredAtMs = answer.answeredAtMs;
      }
    }
    const live = records.filter((record) => {
      if (record.status === "approved") {
        return (
          record.answeredAtMs !== null &&
          now - record.answeredAtMs <= this.approvalTtlMs
        );
      }
      if (record.status === "pending") {
        return now - record.createdAtMs <= PENDING_APPROVAL_TTL_MS;
      }
      return true;
    });
    this.records.set(key, live);
    return live;
  }
}

function blocked(code: PublishApprovalBlockCode): PublishApprovalDecision {
  const message =
    code === "approval_declined"
      ? APPROVAL_DECLINED_MESSAGE
      : code === "approval_unavailable"
        ? APPROVAL_UNAVAILABLE_MESSAGE
        : APPROVAL_REQUIRED_MESSAGE;
  return { allowed: false, code, message };
}

export function publishApprovalUnavailable(): PublishApprovalDecision {
  return blocked("approval_unavailable");
}
