import type { MainSessionEventQueueRecord } from "@holaboss/runtime-state-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const MAX_BACKGROUND_SUMMARY_PROMPT_CHARS = 40_000;
const MAX_BACKGROUND_GOAL_PROMPT_CHARS = 1_200;
const MAX_BACKGROUND_CONTEXT_PROMPT_CHARS = 1_200;

function sanitizePromptText(
  value: unknown,
  maxChars: number,
): string | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizedDeliverableMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const key of [
    "artifact_type",
    "change_type",
    "category",
    "mime_type",
    "size_bytes",
    "modified_at",
    "summary",
    "origin_type",
    "presentation",
    "resource",
  ]) {
    if (metadata[key] !== undefined) {
      sanitized[key] = metadata[key];
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizedForwardedDeliverable(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = sanitizedDeliverableMetadata(
    isRecord(value.metadata) ? value.metadata : null,
  );
  const deliverable: Record<string, unknown> = {};
  for (const key of [
    "output_id",
    "artifact_id",
    "type",
    "output_type",
    "title",
    "status",
    "module_id",
    "module_resource_id",
    "file_path",
    "platform",
    "safe_to_forward",
  ]) {
    if (value[key] !== undefined) {
      deliverable[key] = value[key];
    }
  }
  if (metadata) {
    deliverable.metadata = metadata;
  }
  return Object.keys(deliverable).length > 0 ? deliverable : null;
}

function sanitizeDeliverableArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizedForwardedDeliverable(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function sanitizeEditedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const editedFiles: string[] = [];
  for (const entry of value) {
    const filePath = optionalString(entry);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    editedFiles.push(filePath);
    if (editedFiles.length >= 20) {
      break;
    }
  }
  return editedFiles;
}

function sanitizeBackgroundEventPayloadForPrompt(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const forwardableDeliverables = sanitizeDeliverableArray(
    payload.forwardable_deliverables,
  );
  const partialDeliverables = sanitizeDeliverableArray(
    payload.partial_deliverables,
  );
  const editedFiles = sanitizeEditedFiles(payload.edited_files);

  for (const key of [
    "source_type",
    "source_id",
    "issue_id",
    "status",
    "title",
    "turn_status",
    "stop_reason",
    "cronjob_name",
    "cronjob_schedule",
    "cronjob_first_run",
    "cronjob_delivery_channel",
    "cronjob_delivery_mode",
  ]) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }

  const summary = sanitizePromptText(
    payload.summary,
    MAX_BACKGROUND_SUMMARY_PROMPT_CHARS,
  );
  if (summary) {
    sanitized.summary = summary;
  }
  const blockingQuestion = sanitizePromptText(
    payload.blocking_question,
    MAX_BACKGROUND_SUMMARY_PROMPT_CHARS,
  );
  if (blockingQuestion) {
    sanitized.blocking_question = blockingQuestion;
  }
  const goal = sanitizePromptText(
    payload.goal,
    MAX_BACKGROUND_GOAL_PROMPT_CHARS,
  );
  if (goal) {
    sanitized.goal = goal;
  }
  const context = sanitizePromptText(
    payload.context,
    MAX_BACKGROUND_CONTEXT_PROMPT_CHARS,
  );
  if (context) {
    sanitized.context = context;
  }

  if (forwardableDeliverables.length > 0) {
    sanitized.forwardable_deliverables = forwardableDeliverables;
  }
  if (partialDeliverables.length > 0) {
    sanitized.partial_deliverables = partialDeliverables;
  }
  if (editedFiles.length > 0) {
    sanitized.edited_files = editedFiles;
  }

  return sanitized;
}

export function queuedMainSessionEventPromptEntry(
  event:
    | MainSessionEventQueueRecord
    | {
        eventId?: string;
        event_id?: string;
        eventType?: string;
        event_type?: string;
        deliveryBucket?: string;
        delivery_bucket?: string;
        status?: string;
        subagentId?: string | null;
        subagent_id?: string | null;
        payload?: Record<string, unknown> | unknown;
        createdAt?: string;
        created_at?: string;
      },
): Record<string, unknown> {
  const payload = isRecord(event.payload) ? event.payload : {};
  return {
    event_id:
      optionalString(
        "eventId" in event ? event.eventId : undefined,
      ) ??
      optionalString(
        "event_id" in event ? event.event_id : undefined,
      ) ??
      "",
    event_type:
      optionalString(
        "eventType" in event ? event.eventType : undefined,
      ) ??
      optionalString(
        "event_type" in event ? event.event_type : undefined,
      ) ??
      "",
    delivery_bucket:
      optionalString(
        "deliveryBucket" in event ? event.deliveryBucket : undefined,
      ) ??
      optionalString(
        "delivery_bucket" in event ? event.delivery_bucket : undefined,
      ) ??
      "",
    status: optionalString(event.status) ?? "",
    subagent_id:
      optionalString(
        "subagentId" in event ? event.subagentId : undefined,
      ) ??
      optionalString(
        "subagent_id" in event ? event.subagent_id : undefined,
      ) ??
      null,
    payload: sanitizeBackgroundEventPayloadForPrompt(payload),
    created_at:
      optionalString(
        "createdAt" in event ? event.createdAt : undefined,
      ) ??
      optionalString(
        "created_at" in event ? event.created_at : undefined,
      ) ??
      "",
  };
}
