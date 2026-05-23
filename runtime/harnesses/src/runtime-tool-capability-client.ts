import type { RuntimeAgentToolId } from "./runtime-agent-tools.js";
import {
  formatCapabilityToolResultForModel,
  isRecord,
  normalizeRuntimeApiBaseUrl,
  requestCapabilityJson,
  toolRequestSignal,
} from "./capability-http.js";

const RUNTIME_TOOLS_CAPABILITY_STATUS_PATH = "/api/v1/capabilities/runtime-tools";
const RUNTIME_TOOLS_ONBOARDING_STATUS_PATH = "/api/v1/capabilities/runtime-tools/onboarding/status";
const RUNTIME_TOOLS_ONBOARDING_ALIGNMENT_QUESTION_PATH =
  "/api/v1/capabilities/runtime-tools/onboarding/alignment-question";
const RUNTIME_TOOLS_ONBOARDING_ALIGNMENT_REPORT_PATH =
  "/api/v1/capabilities/runtime-tools/onboarding/alignment-report";
const RUNTIME_TOOLS_ONBOARDING_VERIFICATION_REPORT_PATH =
  "/api/v1/capabilities/runtime-tools/onboarding/verification-report";
const RUNTIME_TOOLS_ONBOARDING_COMPLETE_PATH = "/api/v1/capabilities/runtime-tools/onboarding/complete";
const RUNTIME_TOOLS_CRONJOBS_PATH = "/api/v1/capabilities/runtime-tools/cronjobs";
const RUNTIME_TOOLS_SUBAGENTS_PATH = "/api/v1/capabilities/runtime-tools/subagents";
const RUNTIME_TOOLS_BACKGROUND_TASKS_PATH = "/api/v1/capabilities/runtime-tools/background-tasks";
const RUNTIME_TOOLS_IMAGE_GENERATE_PATH = "/api/v1/capabilities/runtime-tools/images/generate";
const RUNTIME_TOOLS_DOWNLOADS_PATH = "/api/v1/capabilities/runtime-tools/downloads";
const RUNTIME_TOOLS_REPORTS_PATH = "/api/v1/capabilities/runtime-tools/reports";
const RUNTIME_TOOLS_WEB_SEARCH_PATH = "/api/v1/capabilities/runtime-tools/web-search";
const RUNTIME_TOOLS_MEMORY_RETRIEVE_PATH = "/api/v1/capabilities/runtime-tools/memory/retrieve";
const RUNTIME_TOOLS_TODO_PATH = "/api/v1/capabilities/runtime-tools/todo";
const RUNTIME_TOOLS_SCRATCHPAD_PATH = "/api/v1/capabilities/runtime-tools/scratchpad";
const RUNTIME_TOOLS_WORKSPACE_INSTRUCTIONS_PATH = "/api/v1/capabilities/runtime-tools/workspace-instructions";
const RUNTIME_TOOLS_SKILL_PATH = "/api/v1/capabilities/runtime-tools/skill";
const RUNTIME_TOOLS_TERMINAL_SESSIONS_PATH = "/api/v1/capabilities/runtime-tools/terminal-sessions";
const RUNTIME_TOOLS_WORKSPACE_APPS_PATH = "/api/v1/capabilities/runtime-tools/workspace-apps";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PATH = "/api/v1/capabilities/runtime-tools/workspace-integrations";
const RUNTIME_TOOLS_WORKSPACE_APPS_PORTS_PATH = "/api/v1/capabilities/runtime-tools/workspace-apps/ports";
const RUNTIME_TOOLS_WORKSPACE_DATA_TABLES_PATH = "/api/v1/capabilities/runtime-tools/workspace-data/tables";
const RUNTIME_TOOLS_WORKSPACE_DATA_QUERY_PATH = "/api/v1/capabilities/runtime-tools/workspace-data/query";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PROPOSE_CONNECT_PATH =
  "/api/v1/capabilities/runtime-tools/workspace-integrations/propose-connect";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_SET_DEFAULT_ACCOUNT_PATH =
  "/api/v1/capabilities/runtime-tools/workspace-integrations/set-default-account";
const DEFAULT_RUNTIME_TOOL_TIMEOUT_MS = 30000;
const IMAGE_GENERATE_RUNTIME_TOOL_TIMEOUT_MS = 180000;
const DOWNLOAD_URL_RUNTIME_TOOL_TIMEOUT_MS = 120000;
const TERMINAL_WAIT_RUNTIME_TOOL_TIMEOUT_MS = 65000;
const MODEL_CRONJOB_DELIVERY_MODE_ALIAS = "deliver";
const STORED_CRONJOB_DELIVERY_MODE = "announce";

export interface RuntimeToolCapabilityClientOptions {
  runtimeApiBaseUrl: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  fetchImpl?: typeof fetch;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalJsonObject(raw: unknown, fieldName: string): Record<string, unknown> | undefined {
  const value = optionalString(raw);
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must be valid JSON object`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${fieldName} must be valid JSON object`);
  }
  return parsed;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function buildDeliveryPayload(toolParams: unknown): Record<string, unknown> | undefined {
  const params = isRecord(toolParams) ? toolParams : {};
  const channel = optionalString(params.delivery_channel);
  const mode = normalizeCronjobDeliveryModeForRequest(params.delivery_mode);
  const to = optionalString(params.delivery_to);
  if (!channel && !mode && to === undefined) {
    return undefined;
  }
  return {
    ...(channel ? { channel } : {}),
    ...(mode ? { mode } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

function normalizeCronjobDeliveryModeForRequest(value: unknown): string | undefined {
  const mode = optionalString(value);
  if (!mode) {
    return undefined;
  }
  return mode === MODEL_CRONJOB_DELIVERY_MODE_ALIAS ? STORED_CRONJOB_DELIVERY_MODE : mode;
}

function rewriteCronjobDeliveryModesForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteCronjobDeliveryModesForModel(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "delivery" && isRecord(entry)) {
      const nextDelivery: Record<string, unknown> = {};
      for (const [deliveryKey, deliveryValue] of Object.entries(entry)) {
        if (deliveryKey === "mode" && deliveryValue === STORED_CRONJOB_DELIVERY_MODE) {
          nextDelivery[deliveryKey] = MODEL_CRONJOB_DELIVERY_MODE_ALIAS;
          continue;
        }
        nextDelivery[deliveryKey] = rewriteCronjobDeliveryModesForModel(deliveryValue);
      }
      next[key] = nextDelivery;
      continue;
    }
    next[key] = rewriteCronjobDeliveryModesForModel(entry);
  }
  return next;
}

function subagentPath(subagentId: unknown): string {
  const value = optionalString(subagentId);
  if (!value) {
    throw new Error("subagent_id is required");
  }
  return `${RUNTIME_TOOLS_SUBAGENTS_PATH}/${encodeURIComponent(value)}`;
}

function cronjobPath(jobId: unknown): string {
  const value = optionalString(jobId);
  if (!value) {
    throw new Error("job_id is required");
  }
  return `${RUNTIME_TOOLS_CRONJOBS_PATH}/${encodeURIComponent(value)}`;
}

function cronjobsListPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const query = new URLSearchParams();
  if (params.enabled_only === true) {
    query.set("enabled_only", "true");
  }
  const suffix = query.toString();
  return suffix ? `${RUNTIME_TOOLS_CRONJOBS_PATH}?${suffix}` : RUNTIME_TOOLS_CRONJOBS_PATH;
}

function createCronjobBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const delivery = buildDeliveryPayload(params);
  const metadata = parseOptionalJsonObject(params.metadata_json, "metadata_json");
  return {
    cron: String(params.cron ?? ""),
    description: String(params.description ?? ""),
    instruction: String(params.instruction ?? ""),
    ...(optionalString(params.initiated_by) ? { initiated_by: optionalString(params.initiated_by) } : {}),
    ...(optionalString(params.name) ? { name: optionalString(params.name) } : {}),
    ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
    ...(delivery ? { delivery } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function updateCronjobBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const delivery = buildDeliveryPayload(params);
  const metadata = parseOptionalJsonObject(params.metadata_json, "metadata_json");
  return {
    ...(optionalString(params.name) ? { name: optionalString(params.name) } : {}),
    ...(optionalString(params.cron) ? { cron: optionalString(params.cron) } : {}),
    ...(optionalString(params.description) ? { description: optionalString(params.description) } : {}),
    ...(optionalString(params.instruction) ? { instruction: optionalString(params.instruction) } : {}),
    ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
    ...(delivery ? { delivery } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function createImageGenerationBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    prompt: String(params.prompt ?? ""),
    ...(optionalString(params.filename) ? { filename: optionalString(params.filename) } : {}),
    ...(optionalString(params.size) ? { size: optionalString(params.size) } : {}),
  };
}

function normalizeDelegateTask(taskParams: unknown): Record<string, unknown> {
  const params = isRecord(taskParams) ? taskParams : {};
  const goal = optionalString(params.goal);
  return {
    ...(optionalString(params.title) ? { title: optionalString(params.title) } : {}),
    ...(goal ? { goal } : {}),
    ...(optionalString(params.context) ? { context: optionalString(params.context) } : {}),
    ...(optionalStringArray(params.tools) ? { tools: optionalStringArray(params.tools) } : {}),
    ...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
    ...(params.use_user_browser_surface === true
      ? { use_user_browser_surface: true }
      : {}),
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function createDelegateTaskBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const normalizedTasks = Array.isArray(params.tasks)
    ? params.tasks.map((task) => normalizeDelegateTask(task)).filter((task) => typeof task.goal === "string")
    : [];
  if (normalizedTasks.length > 0) {
    return { tasks: normalizedTasks };
  }
  return { tasks: [normalizeDelegateTask(params)] };
}

function createWorkspaceInstructionsBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const body: Record<string, unknown> = {
    op: String(params.op ?? ""),
  };
  const rule = optionalString(params.rule);
  if (rule) {
    body.rule = rule;
  }
  if (typeof params.content === "string") {
    body.content = params.content;
  }
  return body;
}

function getSubagentPath(toolParams: unknown): string {
  return subagentPath(isRecord(toolParams) ? toolParams.subagent_id : undefined);
}

function listBackgroundTasksPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const query = new URLSearchParams();
  for (const status of optionalStringArray(params.statuses) ?? []) {
    query.append("status", status);
  }
  const ownerMainSessionId = optionalString(params.owner_main_session_id);
  if (ownerMainSessionId) {
    query.set("owner_main_session_id", ownerMainSessionId);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    query.set("limit", String(Math.trunc(params.limit)));
  }
  const suffix = query.toString();
  return suffix
    ? `${RUNTIME_TOOLS_BACKGROUND_TASKS_PATH}?${suffix}`
    : RUNTIME_TOOLS_BACKGROUND_TASKS_PATH;
}

function createResumeSubagentBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    answer: String(params.answer ?? ""),
    ...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
  };
}

function createContinueSubagentBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    instruction: String(params.instruction ?? ""),
    ...(optionalString(params.title) ? { title: optionalString(params.title) } : {}),
    ...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
  };
}

function createDownloadUrlBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    url: String(params.url ?? ""),
    ...(optionalString(params.output_path) ? { output_path: optionalString(params.output_path) } : {}),
    ...(optionalString(params.expected_mime_prefix)
      ? { expected_mime_prefix: optionalString(params.expected_mime_prefix) }
      : {}),
    ...(typeof params.overwrite === "boolean" ? { overwrite: params.overwrite } : {}),
  };
}

function createWriteReportBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    content: String(params.content ?? ""),
    ...(optionalString(params.title) ? { title: optionalString(params.title) } : {}),
    ...(optionalString(params.filename) ? { filename: optionalString(params.filename) } : {}),
    ...(optionalString(params.summary) ? { summary: optionalString(params.summary) } : {}),
  };
}

function createWebSearchBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    query: String(params.query ?? ""),
    ...(typeof params.num_results === "number" ? { num_results: params.num_results } : {}),
    ...(typeof params.max_results === "number" ? { max_results: params.max_results } : {}),
    ...(optionalString(params.livecrawl) ? { livecrawl: optionalString(params.livecrawl) } : {}),
    ...(optionalString(params.type) ? { type: optionalString(params.type) } : {}),
    ...(typeof params.context_max_characters === "number"
      ? { context_max_characters: params.context_max_characters }
      : {}),
    ...(typeof params.text_offset === "number" ? { text_offset: params.text_offset } : {}),
    ...(typeof params.text_limit === "number" ? { text_limit: params.text_limit } : {}),
  };
}

function createMemoryRetrieveBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    query: String(params.query ?? ""),
    ...(optionalString(params.mode) ? { mode: optionalString(params.mode) } : {}),
    ...(optionalString(params.tree_id) ? { tree_id: optionalString(params.tree_id) } : {}),
    ...(optionalString(params.node_id) ? { node_id: optionalString(params.node_id) } : {}),
    ...(typeof params.max_results === "number" ? { max_results: params.max_results } : {}),
  };
}

function createSkillBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    name: String(params.name ?? ""),
    ...(optionalString(params.args) ? { args: optionalString(params.args) } : {}),
  };
}

function createTodoWriteBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ops: Array.isArray(params.ops) ? params.ops : [],
  };
}

function createScratchpadWriteBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    op: String(params.op ?? ""),
    ...(optionalString(params.content) ? { content: optionalString(params.content) } : {}),
  };
}

function terminalSessionPath(terminalId: unknown): string {
  const value = optionalString(terminalId);
  if (!value) {
    throw new Error("terminal_id is required");
  }
  return `${RUNTIME_TOOLS_TERMINAL_SESSIONS_PATH}/${encodeURIComponent(value)}`;
}

function workspaceAppPath(appId: unknown): string {
  const value = optionalString(appId);
  if (!value) {
    throw new Error("app_id is required");
  }
  return `${RUNTIME_TOOLS_WORKSPACE_APPS_PATH}/${encodeURIComponent(value)}`;
}

function workspaceAppStatusPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const appId = optionalString(params.app_id);
  if (!appId) {
    return RUNTIME_TOOLS_WORKSPACE_APPS_PATH;
  }
  return `${workspaceAppPath(appId)}/status`;
}

function workspaceAppPortsPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const appId = optionalString(params.app_id);
  if (!appId) {
    return RUNTIME_TOOLS_WORKSPACE_APPS_PORTS_PATH;
  }
  return `${workspaceAppPath(appId)}/ports`;
}

function workspaceDataTablePath(tableName: unknown): string {
  const value = optionalString(tableName);
  if (!value) {
    throw new Error("table_name is required");
  }
  return `${RUNTIME_TOOLS_WORKSPACE_DATA_TABLES_PATH}/${encodeURIComponent(value)}`;
}

function createTerminalSessionBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    command: String(params.command ?? ""),
    ...(optionalString(params.title) ? { title: optionalString(params.title) } : {}),
    ...(optionalString(params.cwd) ? { cwd: optionalString(params.cwd) } : {}),
    ...(typeof params.cols === "number" ? { cols: params.cols } : {}),
    ...(typeof params.rows === "number" ? { rows: params.rows } : {}),
  };
}

function readTerminalSessionBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(typeof params.after_sequence === "number" ? { after_sequence: params.after_sequence } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

function waitTerminalSessionBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(typeof params.after_sequence === "number" ? { after_sequence: params.after_sequence } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function sendTerminalSessionInputBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    data: String(params.data ?? ""),
  };
}

function signalTerminalSessionBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.signal) ? { signal: optionalString(params.signal) } : {}),
  };
}

function createWorkspaceAppFindBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.query) ? { query: optionalString(params.query) } : {}),
    ...(optionalString(params.source) ? { source: optionalString(params.source) } : {}),
  };
}

function createWorkspaceAppInstallBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    app_id: String(params.app_id ?? ""),
  };
}

function createWorkspaceAppScaffoldBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    app_id: String(params.app_id ?? ""),
    ...(optionalString(params.name) ? { name: optionalString(params.name) } : {}),
    ...(typeof params.overwrite === "boolean" ? { overwrite: params.overwrite } : {}),
  };
}

function createWorkspaceAppRegisterBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    app_id: String(params.app_id ?? ""),
    ...(optionalString(params.config_path) ? { config_path: optionalString(params.config_path) } : {}),
  };
}

function createWorkspaceAppBuildBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function createWorkspaceAppsEnsureRunningBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalStringArray(params.app_ids) ? { app_ids: optionalStringArray(params.app_ids) } : {}),
  };
}

function createWorkspaceAppWaitUntilReadyBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
    ...(typeof params.poll_interval_ms === "number"
      ? { poll_interval_ms: params.poll_interval_ms }
      : {}),
  };
}

function createWorkspaceAppProbeEndpointsBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalStringArray(params.checks) ? { checks: optionalStringArray(params.checks) } : {}),
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function createWorkspaceDataSampleRowsBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
  };
}

function createWorkspaceDataQueryBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    query: String(params.query ?? ""),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function createWorkspaceIntegrationsProposeConnectBody(
  toolParams: unknown,
): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    toolkit_slug: String(params.toolkit_slug ?? ""),
    ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
  };
}

function createWorkspaceIntegrationsSetDefaultAccountBody(
  toolParams: unknown,
): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    provider_id: String(params.provider_id ?? ""),
    connection_id: String(params.connection_id ?? ""),
  };
}

export function runtimeToolHeaders(params: {
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const normalizedWorkspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
  if (normalizedWorkspaceId) {
    headers["x-holaboss-workspace-id"] = normalizedWorkspaceId;
  }
  const normalizedSessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (normalizedSessionId) {
    headers["x-holaboss-session-id"] = normalizedSessionId;
  }
  const normalizedInputId = typeof params.inputId === "string" ? params.inputId.trim() : "";
  if (normalizedInputId) {
    headers["x-holaboss-input-id"] = normalizedInputId;
  }
  const normalizedSelectedModel = typeof params.selectedModel === "string" ? params.selectedModel.trim() : "";
  if (normalizedSelectedModel) {
    headers["x-holaboss-selected-model"] = normalizedSelectedModel;
  }
  return headers;
}

export function resolveRuntimeToolCapabilityBaseUrl(value: unknown): string {
  return normalizeRuntimeApiBaseUrl(value);
}

export async function runtimeToolCapabilityAvailable(
  options: RuntimeToolCapabilityClientOptions,
): Promise<boolean> {
  try {
    const response = await requestCapabilityJson({
      url: `${options.runtimeApiBaseUrl}${RUNTIME_TOOLS_CAPABILITY_STATUS_PATH}`,
      method: "GET",
      headers: runtimeToolHeaders({
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        selectedModel: options.selectedModel,
      }),
      signal: AbortSignal.timeout(2000),
      fetchImpl: options.fetchImpl,
    });
    return response.ok && isRecord(response.payload) && response.payload.available === true;
  } catch {
    return false;
  }
}

function runtimeToolTimeoutMs(toolId: RuntimeAgentToolId): number {
  if (toolId === "image_generate") {
    return IMAGE_GENERATE_RUNTIME_TOOL_TIMEOUT_MS;
  }
  if (toolId === "download_url") {
    return DOWNLOAD_URL_RUNTIME_TOOL_TIMEOUT_MS;
  }
  if (toolId === "terminal_session_wait") {
    return TERMINAL_WAIT_RUNTIME_TOOL_TIMEOUT_MS;
  }
  return DEFAULT_RUNTIME_TOOL_TIMEOUT_MS;
}

function requestPlan(
  toolId: RuntimeAgentToolId,
  toolParams: unknown,
): {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  requestPath: string;
  body?: Record<string, unknown>;
} {
  switch (toolId) {
    case "onboarding_status":
      return { method: "GET", requestPath: RUNTIME_TOOLS_ONBOARDING_STATUS_PATH };
    case "holaboss_create_alignment_question": {
      const params = isRecord(toolParams) ? toolParams : {};
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_ONBOARDING_ALIGNMENT_QUESTION_PATH,
        body: {
          question: params.question,
        },
      };
    }
    case "holaboss_create_alignment_report":
    case "holaboss_create_verification_report": {
      const params = isRecord(toolParams) ? toolParams : {};
      return {
        method: "POST",
        requestPath:
          toolId === "holaboss_create_alignment_report"
            ? RUNTIME_TOOLS_ONBOARDING_ALIGNMENT_REPORT_PATH
            : RUNTIME_TOOLS_ONBOARDING_VERIFICATION_REPORT_PATH,
        body: {
          report: params.report,
        },
      };
    }
    case "holaboss_onboarding_complete": {
      const params = isRecord(toolParams) ? toolParams : {};
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_ONBOARDING_COMPLETE_PATH,
        body: {
          summary: String(params.summary ?? ""),
          ...(optionalString(params.requested_by) ? { requested_by: optionalString(params.requested_by) } : {}),
        },
      };
    }
    case "cronjobs_list":
      return { method: "GET", requestPath: cronjobsListPath(toolParams) };
    case "cronjobs_create":
      return { method: "POST", requestPath: RUNTIME_TOOLS_CRONJOBS_PATH, body: createCronjobBody(toolParams) };
    case "cronjobs_get":
      return {
        method: "GET",
        requestPath: cronjobPath(isRecord(toolParams) ? toolParams.job_id : undefined),
      };
    case "cronjobs_update":
      return {
        method: "PATCH",
        requestPath: cronjobPath(isRecord(toolParams) ? toolParams.job_id : undefined),
        body: updateCronjobBody(toolParams),
      };
    case "cronjobs_delete":
      return {
        method: "DELETE",
        requestPath: cronjobPath(isRecord(toolParams) ? toolParams.job_id : undefined),
      };
    case "delegate_task":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_SUBAGENTS_PATH,
        body: createDelegateTaskBody(toolParams),
      };
    case "get_subagent":
      return {
        method: "GET",
        requestPath: getSubagentPath(toolParams),
      };
    case "list_background_tasks":
      return {
        method: "GET",
        requestPath: listBackgroundTasksPath(toolParams),
      };
    case "cancel_subagent":
      return {
        method: "POST",
        requestPath: `${subagentPath(isRecord(toolParams) ? toolParams.subagent_id : undefined)}/cancel`,
        body: {},
      };
    case "resume_subagent":
      return {
        method: "POST",
        requestPath: `${subagentPath(isRecord(toolParams) ? toolParams.subagent_id : undefined)}/resume`,
        body: createResumeSubagentBody(toolParams),
      };
    case "continue_subagent":
      return {
        method: "POST",
        requestPath: `${subagentPath(isRecord(toolParams) ? toolParams.subagent_id : undefined)}/continue`,
        body: createContinueSubagentBody(toolParams),
      };
    case "image_generate":
      return { method: "POST", requestPath: RUNTIME_TOOLS_IMAGE_GENERATE_PATH, body: createImageGenerationBody(toolParams) };
    case "download_url":
      return { method: "POST", requestPath: RUNTIME_TOOLS_DOWNLOADS_PATH, body: createDownloadUrlBody(toolParams) };
    case "write_report":
      return { method: "POST", requestPath: RUNTIME_TOOLS_REPORTS_PATH, body: createWriteReportBody(toolParams) };
    case "web_search":
      return { method: "POST", requestPath: RUNTIME_TOOLS_WEB_SEARCH_PATH, body: createWebSearchBody(toolParams) };
    case "memory_retrieve":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_MEMORY_RETRIEVE_PATH,
        body: createMemoryRetrieveBody(toolParams),
      };
    case "skill":
      return { method: "POST", requestPath: RUNTIME_TOOLS_SKILL_PATH, body: createSkillBody(toolParams) };
    case "todoread":
      return { method: "GET", requestPath: RUNTIME_TOOLS_TODO_PATH };
    case "todowrite":
      return { method: "POST", requestPath: RUNTIME_TOOLS_TODO_PATH, body: createTodoWriteBody(toolParams) };
    case "scratchpad_read":
      return { method: "GET", requestPath: RUNTIME_TOOLS_SCRATCHPAD_PATH };
    case "scratchpad_write":
      return { method: "POST", requestPath: RUNTIME_TOOLS_SCRATCHPAD_PATH, body: createScratchpadWriteBody(toolParams) };
    case "update_workspace_instructions":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_WORKSPACE_INSTRUCTIONS_PATH,
        body: createWorkspaceInstructionsBody(toolParams),
      };
    case "terminal_sessions_list":
      return { method: "GET", requestPath: RUNTIME_TOOLS_TERMINAL_SESSIONS_PATH };
    case "terminal_session_start":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_TERMINAL_SESSIONS_PATH,
        body: createTerminalSessionBody(toolParams),
      };
    case "terminal_session_get":
      return {
        method: "GET",
        requestPath: terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined),
      };
    case "terminal_session_read":
      return {
        method: "POST",
        requestPath: `${terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined)}/read`,
        body: readTerminalSessionBody(toolParams),
      };
    case "terminal_session_wait":
      return {
        method: "POST",
        requestPath: `${terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined)}/wait`,
        body: waitTerminalSessionBody(toolParams),
      };
    case "terminal_session_send_input":
      return {
        method: "POST",
        requestPath: `${terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined)}/input`,
        body: sendTerminalSessionInputBody(toolParams),
      };
    case "terminal_session_signal":
      return {
        method: "POST",
        requestPath: `${terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined)}/signal`,
        body: signalTerminalSessionBody(toolParams),
      };
    case "terminal_session_close":
      return {
        method: "POST",
        requestPath: `${terminalSessionPath(isRecord(toolParams) ? toolParams.terminal_id : undefined)}/close`,
        body: {},
      };
    case "workspace_integrations_list_catalog":
      return {
        method: "POST",
        requestPath: `${RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PATH}/catalog`,
        body: {},
      };
    case "workspace_apps_scaffold":
      return {
        method: "POST",
        requestPath: `${RUNTIME_TOOLS_WORKSPACE_APPS_PATH}/scaffold`,
        body: createWorkspaceAppScaffoldBody(toolParams),
      };
    case "workspace_apps_register":
      return {
        method: "POST",
        requestPath: `${RUNTIME_TOOLS_WORKSPACE_APPS_PATH}/register`,
        body: createWorkspaceAppRegisterBody(toolParams),
      };
    case "workspace_apps_build":
      return {
        method: "POST",
        requestPath: `${workspaceAppPath(isRecord(toolParams) ? toolParams.app_id : undefined)}/build`,
        body: createWorkspaceAppBuildBody(toolParams),
      };
    case "workspace_apps_ensure_running":
      return {
        method: "POST",
        requestPath: `${RUNTIME_TOOLS_WORKSPACE_APPS_PATH}/ensure-running`,
        body: createWorkspaceAppsEnsureRunningBody(toolParams),
      };
    case "workspace_apps_restart":
      return {
        method: "POST",
        requestPath: `${workspaceAppPath(isRecord(toolParams) ? toolParams.app_id : undefined)}/restart`,
        body: {},
      };
    case "workspace_apps_restart_and_wait_ready":
      return {
        method: "POST",
        requestPath: `${workspaceAppPath(isRecord(toolParams) ? toolParams.app_id : undefined)}/restart-and-wait-ready`,
        body: createWorkspaceAppWaitUntilReadyBody(toolParams),
      };
    case "workspace_apps_wait_until_ready":
      return {
        method: "POST",
        requestPath: `${workspaceAppPath(isRecord(toolParams) ? toolParams.app_id : undefined)}/wait-until-ready`,
        body: createWorkspaceAppWaitUntilReadyBody(toolParams),
      };
    case "workspace_apps_get_status":
      return {
        method: "GET",
        requestPath: workspaceAppStatusPath(toolParams),
      };
    case "workspace_apps_get_ports":
      return {
        method: "GET",
        requestPath: workspaceAppPortsPath(toolParams),
      };
    case "workspace_apps_probe_endpoints":
      return {
        method: "POST",
        requestPath: `${workspaceAppPath(isRecord(toolParams) ? toolParams.app_id : undefined)}/probe-endpoints`,
        body: createWorkspaceAppProbeEndpointsBody(toolParams),
      };
    case "workspace_data_list_tables": {
      const params = isRecord(toolParams) ? toolParams : {};
      const include = params.include_system === true ? "true" : "";
      return {
        method: "GET",
        requestPath: include
          ? `${RUNTIME_TOOLS_WORKSPACE_DATA_TABLES_PATH}?include_system=true`
          : RUNTIME_TOOLS_WORKSPACE_DATA_TABLES_PATH,
      };
    }
    case "workspace_data_describe_table":
      return {
        method: "GET",
        requestPath: workspaceDataTablePath(isRecord(toolParams) ? toolParams.table_name : undefined),
      };
    case "workspace_data_sample_rows":
      return {
        method: "POST",
        requestPath: `${workspaceDataTablePath(isRecord(toolParams) ? toolParams.table_name : undefined)}/sample`,
        body: createWorkspaceDataSampleRowsBody(toolParams),
      };
    case "workspace_data_query":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_WORKSPACE_DATA_QUERY_PATH,
        body: createWorkspaceDataQueryBody(toolParams),
      };
    case "holaboss_workspace_integrations_propose_connect":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PROPOSE_CONNECT_PATH,
        body: createWorkspaceIntegrationsProposeConnectBody(toolParams),
      };
    case "holaboss_workspace_integrations_set_default_account":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_SET_DEFAULT_ACCOUNT_PATH,
        body: createWorkspaceIntegrationsSetDefaultAccountBody(toolParams),
      };
  }
  throw new Error(`Unsupported runtime tool: ${toolId}`);
}

export async function executeRuntimeToolCapability(params: RuntimeToolCapabilityClientOptions & {
  toolId: RuntimeAgentToolId;
  toolParams: unknown;
  signal?: AbortSignal;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: {
    tool_id: RuntimeAgentToolId;
    raw?: unknown;
    raw_result_bytes?: number;
    model_result_bytes?: number;
  };
}> {
  const plan = requestPlan(params.toolId, params.toolParams);
  const response = await requestCapabilityJson({
    url: `${params.runtimeApiBaseUrl}${plan.requestPath}`,
    method: plan.method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-holaboss-tool-result-mode": "preview",
      ...runtimeToolHeaders({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        inputId: params.inputId,
        selectedModel: params.selectedModel,
      }),
    },
    ...(plan.body && plan.method !== "GET" && plan.method !== "DELETE"
      ? { body: JSON.stringify(plan.body) }
      : {}),
    signal: toolRequestSignal(params.signal, runtimeToolTimeoutMs(params.toolId)),
    fetchImpl: params.fetchImpl,
  });

  if (!response.ok) {
    const message = isRecord(response.payload)
      ? String(response.payload.detail ?? response.payload.error ?? `Holaboss runtime tool '${params.toolId}' failed.`)
      : `Holaboss runtime tool '${params.toolId}' failed.`;
    throw new Error(message);
  }

  const modelFacingPayload = rewriteCronjobDeliveryModesForModel(response.payload);
  const formatted = formatCapabilityToolResultForModel(modelFacingPayload);
  return {
    content: [{ type: "text", text: formatted.text }],
    details: {
      tool_id: params.toolId,
      ...(formatted.compacted
        ? {
            raw: modelFacingPayload,
            raw_result_bytes: formatted.serializedBytes,
            model_result_bytes: formatted.modelTextBytes,
          }
        : {}),
    },
  };
}
