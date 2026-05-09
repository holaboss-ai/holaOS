export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface TsRunnerInputAttachment {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

export type TsRunnerEventType =
  | "run_claimed"
  | "run_started"
  | "pi_native_event"
  | "thinking_delta"
  | "output_delta"
  | "tool_call"
  | "skill_invocation"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "mcp_server_unavailable"
  | "run_completed"
  | "run_failed";

export interface TsRunnerRequest {
  holaboss_user_id?: string;
  workspace_id: string;
  session_id: string;
  session_kind?: string | null;
  input_id: string;
  instruction: string;
  attachments?: TsRunnerInputAttachment[];
  image_urls?: string[];
  context: JsonObject;
  model?: string | null;
  thinking_value?: string | null;
  debug: boolean;
}

export interface TsRunnerEvent {
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: TsRunnerEventType;
  timestamp: string;
  payload: JsonObject;
}

export interface TsRunnerPushCallbackConfig {
  protocol_version: string;
  run_id: string;
  callback_url: string;
  callback_token: string;
  ack_timeout_ms: number;
  max_retries: number;
}

export const TS_RUNNER_PUSH_CONTEXT_KEY = "_sandbox_runtime_push_v1";
export const TS_RUNNER_PUSH_PROTOCOL_VERSION = "1.0";

type LoggerLike = Pick<typeof console, "warn">;

export class TsRunnerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsRunnerRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TsRunnerRequestError(`${fieldName} is required`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TsRunnerRequestError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function integerInRange(
  value: unknown,
  fieldName: string,
  { min, max, defaultValue }: { min: number; max: number; defaultValue: number }
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new TsRunnerRequestError(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function attachments(value: unknown): TsRunnerInputAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const mimeType = typeof item.mime_type === "string" ? item.mime_type.trim() : "";
      const workspacePath = typeof item.workspace_path === "string" ? item.workspace_path.trim() : "";
      const sizeBytes = typeof item.size_bytes === "number" && Number.isFinite(item.size_bytes) ? item.size_bytes : 0;
      const kind =
        item.kind === "image"
          ? "image"
          : item.kind === "folder"
            ? "folder"
            : item.kind === "file"
              ? "file"
              : mimeType.startsWith("image/")
                ? "image"
                : mimeType === "inode/directory"
                  ? "folder"
                  : "file";
      if (!id || !name || !mimeType || !workspacePath) {
        throw new TsRunnerRequestError("attachments entries must include id, name, mime_type, and workspace_path");
      }
      return {
        id,
        kind,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        workspace_path: workspacePath
      } satisfies TsRunnerInputAttachment;
    })
    .filter((item): item is TsRunnerInputAttachment => Boolean(item));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function decodeTsRunnerRequestPayload(encoded: string): unknown {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new TsRunnerRequestError("request_base64 is required");
  }

  let raw: string;
  try {
    raw = Buffer.from(trimmed, "base64").toString("utf8");
  } catch (error) {
    throw new TsRunnerRequestError(
      `request_base64 must be valid base64: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!raw.trim()) {
    throw new TsRunnerRequestError("request payload must be valid base64-encoded JSON");
  }

  return JSON.parse(raw);
}

export function validateTsRunnerRequest(payload: unknown): TsRunnerRequest {
  if (!isRecord(payload)) {
    throw new TsRunnerRequestError("request payload must be an object");
  }

  const context = payload.context ?? {};
  if (!isRecord(context)) {
    throw new TsRunnerRequestError("context must be an object");
  }

  const debugValue = payload.debug;
  if (debugValue !== undefined && typeof debugValue !== "boolean") {
    throw new TsRunnerRequestError("debug must be a boolean");
  }

  return {
    holaboss_user_id: optionalNonEmptyString(payload.holaboss_user_id, "holaboss_user_id"),
    workspace_id: requiredString(payload.workspace_id, "workspace_id"),
    session_id: requiredString(payload.session_id, "session_id"),
    session_kind: optionalNonEmptyString(payload.session_kind, "session_kind") ?? null,
    input_id: requiredString(payload.input_id, "input_id"),
    instruction: requiredString(payload.instruction, "instruction"),
    attachments: attachments(payload.attachments),
    image_urls: stringArray(payload.image_urls),
    context: context as JsonObject,
    model: payload.model === undefined || payload.model === null ? null : requiredString(payload.model, "model"),
    thinking_value:
      payload.thinking_value === undefined || payload.thinking_value === null
        ? null
        : requiredString(payload.thinking_value, "thinking_value"),
    debug: debugValue ?? false
  };
}

export function decodeTsRunnerRequest(encoded: string): TsRunnerRequest {
  return validateTsRunnerRequest(decodeTsRunnerRequestPayload(encoded));
}

export function fallbackEventIdentity(payload: unknown): { sessionId: string; inputId: string } {
  if (!isRecord(payload)) {
    return { sessionId: "unknown", inputId: "unknown" };
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id : "unknown";
  const inputId = typeof payload.input_id === "string" && payload.input_id.trim() ? payload.input_id : "unknown";
  return { sessionId, inputId };
}

export function resolvePushCallbackConfig(
  request: TsRunnerRequest,
  options: { logger?: LoggerLike } = {}
): TsRunnerPushCallbackConfig | null {
  const logger = options.logger ?? console;
  const raw = request.context[TS_RUNNER_PUSH_CONTEXT_KEY];
  if (!isRecord(raw)) {
    return null;
  }

  try {
    const config: TsRunnerPushCallbackConfig = {
      protocol_version:
        optionalNonEmptyString(raw.protocol_version, `${TS_RUNNER_PUSH_CONTEXT_KEY}.protocol_version`) ??
        TS_RUNNER_PUSH_PROTOCOL_VERSION,
      run_id: requiredString(raw.run_id, `${TS_RUNNER_PUSH_CONTEXT_KEY}.run_id`),
      callback_url: requiredString(raw.callback_url, `${TS_RUNNER_PUSH_CONTEXT_KEY}.callback_url`),
      callback_token: requiredString(raw.callback_token, `${TS_RUNNER_PUSH_CONTEXT_KEY}.callback_token`),
      ack_timeout_ms: integerInRange(raw.ack_timeout_ms, `${TS_RUNNER_PUSH_CONTEXT_KEY}.ack_timeout_ms`, {
        min: 100,
        max: 60000,
        defaultValue: 3000
      }),
      max_retries: integerInRange(raw.max_retries, `${TS_RUNNER_PUSH_CONTEXT_KEY}.max_retries`, {
        min: 0,
        max: 10,
        defaultValue: 3
      })
    };
    if (config.protocol_version !== TS_RUNNER_PUSH_PROTOCOL_VERSION) {
      logger.warn(`Unsupported push protocol version: ${config.protocol_version}`);
      return null;
    }
    return config;
  } catch (error) {
    logger.warn(
      "Invalid push callback config in request context:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
