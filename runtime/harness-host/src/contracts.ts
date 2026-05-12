export const HARNESS_HOST_NOT_IMPLEMENTED_EXIT_CODE = 86;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type KnownRunnerEventType =
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

export type RunnerEventType = KnownRunnerEventType;

export interface RunnerOutputEvent {
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: RunnerEventType;
  timestamp?: string;
  payload: Record<string, unknown>;
}

export type RunnerOutputEventPayload = RunnerOutputEvent;

export interface RunnerRequest {
  holaboss_user_id?: string | null;
  workspace_id: string;
  session_id: string;
  session_kind?: string | null;
  input_id: string;
  instruction: string;
  attachments?: HarnessHostInputAttachmentPayload[];
  image_urls?: string[];
  context: JsonObject;
  model?: string | null;
  thinking_value?: string | null;
  debug: boolean;
}

export interface HarnessHostInputAttachmentPayload {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

export interface HarnessHostModelClientPayload {
  model_proxy_provider: string;
  api_key: string;
  base_url?: string | null;
  default_headers?: Record<string, string> | null;
}

export type ModelClientConfigPayload = HarnessHostModelClientPayload;

export interface HarnessHostPiRequest {
  workspace_id: string;
  workspace_dir: string;
  session_id: string;
  browser_tools_enabled?: boolean;
  browser_space?: "agent" | "user" | null;
  force_compaction?: boolean;
  input_id: string;
  instruction: string;
  context_messages?: string[];
  tools?: Record<string, boolean>;
  attachments?: HarnessHostInputAttachmentPayload[];
  image_urls?: string[];
  thinking_value?: string | null;
  debug: boolean;
  harness_session_id?: string | null;
  persisted_harness_session_id?: string | null;
  provider_id: string;
  model_id: string;
  timeout_seconds: number;
  runtime_api_base_url?: string | null;
  system_prompt: string;
  workspace_skill_dirs: string[];
  mcp_servers: JsonObject[];
  mcp_tool_refs: HarnessHostPiMcpToolRef[];
  workspace_config_checksum: string;
  run_started_payload: JsonObject;
  model_client: HarnessHostModelClientPayload;
}

export type PiHarnessHostRequest = HarnessHostPiRequest;

export interface HarnessHostPiMcpToolRef {
  tool_id: string;
  server_id: string;
  tool_name: string;
}

export interface WorkspaceMcpSidecarCliRequest {
  workspace_dir: string;
  physical_server_id: string;
  expected_fingerprint: string;
  timeout_ms: number;
  readiness_timeout_s: number;
  catalog_json_base64: string;
}

export interface WorkspaceMcpSidecarCliResponse {
  url: string;
  pid: number;
  reused: boolean;
}

export interface AgentRuntimeConfigGeneralMemberPayload {
  id: string;
  model: string;
  prompt: string;
  role?: string | null;
}

export interface AgentRuntimeConfigCliRequest {
  session_id: string;
  workspace_id: string;
  input_id: string;
  runtime_exec_model_proxy_api_key?: string | null;
  runtime_exec_sandbox_id?: string | null;
  runtime_exec_run_id?: string | null;
  selected_model?: string | null;
  default_provider_id: string;
  session_mode: string;
  workspace_config_checksum: string;
  workspace_skill_ids: string[];
  default_tools: string[];
  extra_tools: string[];
  tool_server_id_map?: Record<string, string> | null;
  resolved_mcp_tool_refs: Array<Record<string, string>>;
  resolved_mcp_server_ids?: string[];
  resolved_output_schemas: Record<string, JsonObject>;
  agent: AgentRuntimeConfigGeneralMemberPayload;
}

export interface AgentRuntimeConfigCliResponse {
  provider_id: string;
  model_id: string;
  mode: string;
  system_prompt: string;
  model_client: HarnessHostModelClientPayload;
  tools: Record<string, boolean>;
  workspace_tool_ids: string[];
  workspace_skill_ids: string[];
  output_schema_member_id?: string | null;
  output_format?: JsonObject | null;
  workspace_config_checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function stringOrEmpty(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function requiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function optionalBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function optionalBrowserSpace(
  value: unknown,
): "agent" | "user" | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value === "agent" || value === "user") {
    return value;
  }
  throw new Error("browser_space must be `agent` or `user`");
}

function requiredInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return Number(value);
}

function requiredNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean");
  return Object.fromEntries(entries);
}

function jsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => isJsonValue(entry[1]));
  return Object.fromEntries(entries);
}

function jsonObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is JsonObject => isRecord(item) && isJsonValue(item));
}

function inputAttachments(value: unknown, fieldName: string): HarnessHostInputAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${fieldName}[${index}] must be an object`);
    }
    const id = requiredString(item.id, `${fieldName}[${index}].id`);
    const name = requiredString(item.name, `${fieldName}[${index}].name`);
    const mimeType = requiredString(item.mime_type, `${fieldName}[${index}].mime_type`);
    const workspacePath = requiredString(item.workspace_path, `${fieldName}[${index}].workspace_path`);
    const sizeBytes = item.size_bytes === undefined ? 0 : requiredNumber(item.size_bytes, `${fieldName}[${index}].size_bytes`);
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
    return {
      id,
      kind,
      name,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      workspace_path: workspacePath,
    };
  });
}

function modelClientConfigPayload(value: unknown, fieldName: string): HarnessHostModelClientPayload {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return {
    model_proxy_provider: requiredString(value.model_proxy_provider, `${fieldName}.model_proxy_provider`),
    api_key: requiredString(value.api_key, `${fieldName}.api_key`),
    base_url: optionalString(value.base_url),
    default_headers: Object.keys(stringRecord(value.default_headers)).length > 0 ? stringRecord(value.default_headers) : null,
  };
}

function generalMemberPayload(
  value: unknown,
  fieldName: string
): AgentRuntimeConfigGeneralMemberPayload | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return {
    id: requiredString(value.id, `${fieldName}.id`),
    model: requiredString(value.model, `${fieldName}.model`),
    prompt: requiredString(value.prompt, `${fieldName}.prompt`),
    role: optionalString(value.role),
  };
}

export function decodeRequestBase64<T>(encoded: string): T {
  const raw = Buffer.from(encoded, "base64").toString("utf-8");
  return JSON.parse(raw) as T;
}

export function decodeRunnerRequestBase64(encoded: string): RunnerRequest {
  const parsed = decodeRequestBase64<unknown>(encoded);
  if (!isRecord(parsed)) {
    throw new Error("runner request payload must be an object");
  }
  return {
    holaboss_user_id: optionalString(parsed.holaboss_user_id),
    workspace_id: requiredString(parsed.workspace_id, "workspace_id"),
    session_id: requiredString(parsed.session_id, "session_id"),
    session_kind: optionalString(parsed.session_kind),
    input_id: requiredString(parsed.input_id, "input_id"),
    instruction: requiredString(parsed.instruction, "instruction"),
    attachments: inputAttachments(parsed.attachments, "attachments"),
    image_urls: stringArray(parsed.image_urls),
    context: jsonObject(parsed.context),
    model: optionalString(parsed.model),
    thinking_value: optionalString(parsed.thinking_value),
    debug: optionalBoolean(parsed.debug, false),
  };
}

export function decodeHarnessHostPiRequestBase64(encoded: string): HarnessHostPiRequest {
  const parsed = decodeRequestBase64<unknown>(encoded);
  if (!isRecord(parsed)) {
    throw new Error("pi harness request payload must be an object");
  }
  return {
    workspace_id: requiredString(parsed.workspace_id, "workspace_id"),
    workspace_dir: requiredString(parsed.workspace_dir, "workspace_dir"),
    session_id: requiredString(parsed.session_id, "session_id"),
    browser_tools_enabled: optionalBoolean(parsed.browser_tools_enabled, false),
    browser_space: optionalBrowserSpace(parsed.browser_space),
    force_compaction: optionalBoolean(parsed.force_compaction, false),
    input_id: requiredString(parsed.input_id, "input_id"),
    instruction: requiredString(parsed.instruction, "instruction"),
    context_messages: stringArray(parsed.context_messages),
    tools: booleanRecord(parsed.tools),
    attachments: inputAttachments(parsed.attachments, "attachments"),
    image_urls: stringArray(parsed.image_urls),
    thinking_value: optionalString(parsed.thinking_value),
    debug: optionalBoolean(parsed.debug, false),
    harness_session_id: optionalString(parsed.harness_session_id),
    persisted_harness_session_id: optionalString(parsed.persisted_harness_session_id),
    provider_id: requiredString(parsed.provider_id, "provider_id"),
    model_id: requiredString(parsed.model_id, "model_id"),
    timeout_seconds: requiredInteger(parsed.timeout_seconds, "timeout_seconds"),
    runtime_api_base_url: optionalString(parsed.runtime_api_base_url),
    system_prompt: stringOrEmpty(parsed.system_prompt, "system_prompt"),
    workspace_skill_dirs: stringArray(parsed.workspace_skill_dirs),
    mcp_servers: jsonObjectArray(parsed.mcp_servers),
    mcp_tool_refs: Array.isArray(parsed.mcp_tool_refs)
      ? parsed.mcp_tool_refs
          .filter(isRecord)
          .map((toolRef) => ({
            tool_id: requiredString(toolRef.tool_id, "mcp_tool_refs[].tool_id"),
            server_id: requiredString(toolRef.server_id, "mcp_tool_refs[].server_id"),
            tool_name: requiredString(toolRef.tool_name, "mcp_tool_refs[].tool_name"),
          }))
      : [],
    workspace_config_checksum: requiredString(parsed.workspace_config_checksum, "workspace_config_checksum"),
    run_started_payload: jsonObject(parsed.run_started_payload),
    model_client: modelClientConfigPayload(parsed.model_client, "model_client"),
  };
}

export const decodePiHarnessHostRequestBase64 = decodeHarnessHostPiRequestBase64;

export function decodeAgentRuntimeConfigCliRequestBase64(encoded: string): AgentRuntimeConfigCliRequest {
  const parsed = decodeRequestBase64<unknown>(encoded);
  if (!isRecord(parsed)) {
    throw new Error("agent runtime config request payload must be an object");
  }
  return {
    session_id: requiredString(parsed.session_id, "session_id"),
    workspace_id: requiredString(parsed.workspace_id, "workspace_id"),
    input_id: requiredString(parsed.input_id, "input_id"),
    runtime_exec_model_proxy_api_key: optionalString(parsed.runtime_exec_model_proxy_api_key),
    runtime_exec_sandbox_id: optionalString(parsed.runtime_exec_sandbox_id),
    runtime_exec_run_id: optionalString(parsed.runtime_exec_run_id),
    selected_model: optionalString(parsed.selected_model),
    default_provider_id: requiredString(parsed.default_provider_id, "default_provider_id"),
    session_mode: requiredString(parsed.session_mode, "session_mode"),
    workspace_config_checksum: requiredString(parsed.workspace_config_checksum, "workspace_config_checksum"),
    workspace_skill_ids: stringArray(parsed.workspace_skill_ids),
    default_tools: stringArray(parsed.default_tools),
    extra_tools: stringArray(parsed.extra_tools),
    tool_server_id_map: isRecord(parsed.tool_server_id_map) ? stringRecord(parsed.tool_server_id_map) : null,
    resolved_mcp_tool_refs: Array.isArray(parsed.resolved_mcp_tool_refs)
      ? parsed.resolved_mcp_tool_refs.filter(isRecord).map((item) => stringRecord(item))
      : [],
    resolved_mcp_server_ids: stringArray(parsed.resolved_mcp_server_ids),
    resolved_output_schemas: isRecord(parsed.resolved_output_schemas)
      ? Object.fromEntries(
          Object.entries(parsed.resolved_output_schemas)
            .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]) && isJsonValue(entry[1]))
            .map(([key, value]) => [key, jsonObject(value)])
        )
      : {},
    agent:
      generalMemberPayload(parsed.agent, "agent") ??
      (() => {
        throw new Error("agent is required");
      })(),
  };
}

export function decodeWorkspaceMcpSidecarCliRequestBase64(encoded: string): WorkspaceMcpSidecarCliRequest {
  const parsed = decodeRequestBase64<unknown>(encoded);
  if (!isRecord(parsed)) {
    throw new Error("workspace MCP sidecar request payload must be an object");
  }
  return {
    workspace_dir: requiredString(parsed.workspace_dir, "workspace_dir"),
    physical_server_id: requiredString(parsed.physical_server_id, "physical_server_id"),
    expected_fingerprint: requiredString(parsed.expected_fingerprint, "expected_fingerprint"),
    timeout_ms: requiredInteger(parsed.timeout_ms, "timeout_ms"),
    readiness_timeout_s: requiredNumber(parsed.readiness_timeout_s, "readiness_timeout_s"),
    catalog_json_base64: requiredString(parsed.catalog_json_base64, "catalog_json_base64"),
  };
}
