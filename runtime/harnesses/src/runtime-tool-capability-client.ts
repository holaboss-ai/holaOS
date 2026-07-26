import type { RuntimeAgentToolId } from "./runtime-agent-tools.js";
import {
  formatCapabilityToolResultForModel,
  isRecord,
  normalizeRuntimeApiBaseUrl,
  requestCapabilityJson,
  toolRequestSignal,
} from "./capability-http.js";

const RUNTIME_TOOLS_CAPABILITY_STATUS_PATH = "/api/v1/capabilities/runtime-tools";
const RUNTIME_TOOLS_ASK_USER_QUESTION_PATH =
  "/api/v1/capabilities/runtime-tools/ask-user-question";
const RUNTIME_TOOLS_CRONJOBS_PATH = "/api/v1/capabilities/runtime-tools/cronjobs";
const RUNTIME_TOOLS_CAPABILITY_INSTALL_PATH = "/api/v1/capabilities/runtime-tools/capability-install";
const RUNTIME_TOOLS_PLUGINS_PATH = "/api/v1/capabilities/runtime-tools/plugins";
const RUNTIME_TOOLS_SUBAGENTS_PATH = "/api/v1/capabilities/runtime-tools/subagents";
const RUNTIME_TOOLS_TASKS_PATH = "/api/v1/capabilities/runtime-tools/tasks";
const RUNTIME_TOOLS_IMAGE_GENERATE_PATH = "/api/v1/capabilities/runtime-tools/images/generate";
const RUNTIME_TOOLS_VIDEO_GENERATE_PATH = "/api/v1/capabilities/runtime-tools/videos/generate";
const RUNTIME_TOOLS_DOWNLOADS_PATH = "/api/v1/capabilities/runtime-tools/downloads";
const RUNTIME_TOOLS_MACOS_SETTINGS_PATH = "/api/v1/capabilities/runtime-tools/macos-settings";
const RUNTIME_TOOLS_REPORTS_PATH = "/api/v1/capabilities/runtime-tools/reports";
const RUNTIME_TOOLS_SEND_FILE_PATH = "/api/v1/capabilities/runtime-tools/send-file";
const RUNTIME_TOOLS_WEB_SEARCH_PATH = "/api/v1/capabilities/runtime-tools/web-search";
const RUNTIME_TOOLS_MEMORY_RETRIEVE_PATH = "/api/v1/capabilities/runtime-tools/memory/retrieve";
const RUNTIME_TOOLS_MEMORY_REMEMBER_PATH = "/api/v1/capabilities/runtime-tools/memory/remember";
const RUNTIME_TOOLS_TODO_PATH = "/api/v1/capabilities/runtime-tools/todo";
const RUNTIME_TOOLS_WORKSPACE_INSTRUCTIONS_PATH = "/api/v1/capabilities/runtime-tools/workspace-instructions";
const RUNTIME_TOOLS_SKILL_PATH = "/api/v1/capabilities/runtime-tools/skill";
const RUNTIME_TOOLS_TERMINAL_SESSIONS_PATH = "/api/v1/capabilities/runtime-tools/terminal-sessions";
const RUNTIME_TOOLS_WORKSPACE_APPS_PATH = "/api/v1/capabilities/runtime-tools/workspace-apps";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PATH = "/api/v1/capabilities/runtime-tools/workspace-integrations";
const RUNTIME_TOOLS_WORKSPACE_APPS_PORTS_PATH = "/api/v1/capabilities/runtime-tools/workspace-apps/ports";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_PROPOSE_CONNECT_PATH =
  "/api/v1/capabilities/runtime-tools/workspace-integrations/propose-connect";
const RUNTIME_TOOLS_WORKSPACE_INTEGRATIONS_SET_DEFAULT_ACCOUNT_PATH =
  "/api/v1/capabilities/runtime-tools/workspace-integrations/set-default-account";
const RUNTIME_TOOLS_MCP_CONNECT_PATH =
  "/api/v1/capabilities/runtime-tools/mcp/connect";
const RUNTIME_TOOLS_MCP_REFRESH_PATH =
  "/api/v1/capabilities/runtime-tools/mcp/refresh";
const RUNTIME_TOOLS_MCP_REAUTHORIZE_PATH =
  "/api/v1/capabilities/runtime-tools/mcp/reauthorize";
const DEFAULT_RUNTIME_TOOL_TIMEOUT_MS = 30000;
const IMAGE_GENERATE_RUNTIME_TOOL_TIMEOUT_MS = 180000;
// Video jobs submit + poll + download; allow well past the proxy's job wait.
const VIDEO_GENERATE_RUNTIME_TOOL_TIMEOUT_MS = 600000;
const DOWNLOAD_URL_RUNTIME_TOOL_TIMEOUT_MS = 120000;
const TERMINAL_WAIT_RUNTIME_TOOL_TIMEOUT_MS = 65000;

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

function taskPath(taskId: unknown): string {
  const value = optionalString(taskId);
  if (!value) {
    throw new Error("task_id is required");
  }
  return `${RUNTIME_TOOLS_TASKS_PATH}/${encodeURIComponent(value)}`;
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
  const body: Record<string, unknown> = {
    cron: String(params.cron ?? ""),
    description: String(params.description ?? ""),
  };
  if (typeof params.name === "string") body.name = params.name;
  if (typeof params.instruction === "string") body.instruction = params.instruction;
  if (typeof params.enabled === "boolean") body.enabled = params.enabled;
  if (isRecord(params.delivery)) body.delivery = params.delivery;
  if (isRecord(params.metadata)) body.metadata = params.metadata;
  if (typeof params.project_id === "string") body.project_id = params.project_id;
  return body;
}

function updateCronjobBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const body: Record<string, unknown> = {};
  if (typeof params.name === "string") body.name = params.name;
  if (typeof params.cron === "string") body.cron = params.cron;
  if (typeof params.description === "string") body.description = params.description;
  if (typeof params.instruction === "string") body.instruction = params.instruction;
  if (typeof params.enabled === "boolean") body.enabled = params.enabled;
  if (isRecord(params.delivery)) body.delivery = params.delivery;
  if (isRecord(params.metadata)) body.metadata = params.metadata;
  if (typeof params.project_id === "string") body.project_id = params.project_id;
  return body;
}

function pluginsListPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const query = new URLSearchParams();
  if (params.include_archived === true) {
    query.set("include_archived", "true");
  }
  const suffix = query.toString();
  return suffix ? `${RUNTIME_TOOLS_PLUGINS_PATH}?${suffix}` : RUNTIME_TOOLS_PLUGINS_PATH;
}

function pluginPath(pluginId: unknown): string {
  const value = optionalString(pluginId);
  if (!value) {
    throw new Error("plugin_id is required");
  }
  return `${RUNTIME_TOOLS_PLUGINS_PATH}/${encodeURIComponent(value)}`;
}

function pluginObjectsPath(pluginId: unknown): string {
  return `${pluginPath(pluginId)}/objects`;
}

function pluginObjectPath(pluginId: unknown, objectId: unknown): string {
  const value = optionalString(objectId);
  if (!value) {
    throw new Error("object_id is required");
  }
  return `${pluginPath(pluginId)}/objects/${encodeURIComponent(value)}`;
}

function pluginObjectFieldsPath(pluginId: unknown, objectId: unknown): string {
  return `${pluginObjectPath(pluginId, objectId)}/fields`;
}

function pluginDashboardsPath(pluginId: unknown): string {
  return `${pluginPath(pluginId)}/dashboards`;
}

function pluginWorkflowsPath(pluginId: unknown): string {
  return `${pluginPath(pluginId)}/workflows`;
}

function pluginWorkflowPath(pluginId: unknown, workflowId: unknown): string {
  const value = optionalString(workflowId);
  if (!value) {
    throw new Error("workflow_id is required");
  }
  return `${pluginPath(pluginId)}/workflows/${encodeURIComponent(value)}`;
}

function pluginWorkflowNodePath(
  pluginId: unknown,
  workflowId: unknown,
  nodeId: unknown,
): string {
  const value = optionalString(nodeId);
  if (!value) {
    throw new Error("node_id is required");
  }
  return `${pluginWorkflowPath(pluginId, workflowId)}/nodes/${encodeURIComponent(value)}`;
}

function pluginWorkflowEdgePath(
  pluginId: unknown,
  workflowId: unknown,
  edgeId: unknown,
): string {
  const value = optionalString(edgeId);
  if (!value) {
    throw new Error("edge_id is required");
  }
  return `${pluginWorkflowPath(pluginId, workflowId)}/edges/${encodeURIComponent(value)}`;
}

function pluginWorkflowNodeBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const node = isRecord(params.node) ? params.node : {};
  return { ...node };
}

function pluginWorkflowEdgeBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const edge = isRecord(params.edge) ? params.edge : {};
  return { ...edge };
}

function createWorkflowBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    name: String(params.name ?? ""),
    ...(optionalString(params.description) ? { description: optionalString(params.description) } : {}),
    ...(optionalString(params.status) ? { status: optionalString(params.status) } : {}),
    ...(optionalString(params.created_by) ? { created_by: optionalString(params.created_by) } : {}),
    ...(Array.isArray(params.nodes) ? { nodes: params.nodes } : {}),
    ...(Array.isArray(params.edges) ? { edges: params.edges } : {}),
    ...(isRecord(params.metadata) ? { metadata: params.metadata } : {}),
  };
}

function updateWorkflowBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.name) ? { name: optionalString(params.name) } : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "description")
      ? { description: optionalString(params.description) ?? "" }
      : {}),
    ...(optionalString(params.status) ? { status: optionalString(params.status) } : {}),
    ...(Object.prototype.hasOwnProperty.call(params, "created_by")
      ? { created_by: optionalString(params.created_by) ?? "" }
      : {}),
    ...(Array.isArray(params.nodes) ? { nodes: params.nodes } : {}),
    ...(Array.isArray(params.edges) ? { edges: params.edges } : {}),
    ...(isRecord(params.metadata) ? { metadata: params.metadata } : {}),
  };
}

function createWorkflowTestBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.created_by) ? { created_by: optionalString(params.created_by) } : {}),
  };
}

function createWorkflowStartBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.trigger_kind) ? { trigger_kind: optionalString(params.trigger_kind) } : {}),
    ...(optionalString(params.trigger_node_id)
      ? { trigger_node_id: optionalString(params.trigger_node_id) }
      : {}),
    ...(optionalString(params.created_by) ? { created_by: optionalString(params.created_by) } : {}),
  };
}

function createWorkflowNodeBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    node: isRecord(params.node) ? params.node : {},
  };
}

function createWorkflowEdgeBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    edge: isRecord(params.edge) ? params.edge : {},
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

function createVideoGenerationBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const seconds = typeof params.seconds === "number" && Number.isFinite(params.seconds)
    ? params.seconds
    : undefined;
  return {
    prompt: String(params.prompt ?? ""),
    ...(optionalString(params.filename) ? { filename: optionalString(params.filename) } : {}),
    ...(optionalString(params.size) ? { size: optionalString(params.size) } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
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
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
  };
}

function createDelegateTaskBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const normalizedTasks = Array.isArray(params.tasks)
    ? params.tasks
        .map((task) => normalizeDelegateTask(task))
        .filter((task) => typeof task.goal === "string")
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

function getTaskPath(toolParams: unknown): string {
  return taskPath(isRecord(toolParams) ? toolParams.task_id : undefined);
}

function listTasksPath(toolParams: unknown): string {
  const params = isRecord(toolParams) ? toolParams : {};
  const query = new URLSearchParams();
  for (const status of optionalStringArray(params.statuses) ?? []) {
    query.append("statuses", status);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    query.set("limit", String(Math.trunc(params.limit)));
  }
  const suffix = query.toString();
  return suffix ? `${RUNTIME_TOOLS_TASKS_PATH}?${suffix}` : RUNTIME_TOOLS_TASKS_PATH;
}

function createRerunTaskBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
    ...(typeof params.priority === "number" && Number.isFinite(params.priority)
      ? { priority: Math.trunc(params.priority) }
      : {}),
  };
}

function createReplyTaskBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    text: String(params.text ?? ""),
    ...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
    ...(typeof params.priority === "number" && Number.isFinite(params.priority)
      ? { priority: Math.trunc(params.priority) }
      : {}),
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

function createOpenMacosSettingsBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    ...(optionalString(params.pane) ? { pane: optionalString(params.pane) } : {}),
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

function createRememberBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  return {
    title: String(params.title ?? ""),
    summary: String(params.summary ?? ""),
    ...(optionalString(params.scope) ? { scope: optionalString(params.scope) } : {}),
    ...(optionalString(params.memory_type) ? { memory_type: optionalString(params.memory_type) } : {}),
    ...(optionalString(params.subject_key) ? { subject_key: optionalString(params.subject_key) } : {}),
    ...(Array.isArray(params.tags) ? { tags: params.tags } : {}),
    ...(optionalString(params.evidence) ? { evidence: optionalString(params.evidence) } : {}),
    ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
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

function createMcpConnectBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const body: Record<string, unknown> = {};
  if (typeof params.url === "string") body.url = params.url;
  if (Array.isArray(params.command)) {
    body.command = params.command.filter((v): v is string => typeof v === "string");
  }
  if (typeof params.name === "string") body.name = params.name;
  if (isRecord(params.headers)) body.headers = params.headers;
  if (isRecord(params.env)) body.env = params.env;
  return body;
}

function createMcpReauthorizeBody(toolParams: unknown): Record<string, unknown> {
  const params = isRecord(toolParams) ? toolParams : {};
  const body: Record<string, unknown> = {};
  if (typeof params.server === "string") body.server = params.server;
  return body;
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
  if (toolId === "video_generate") {
    return VIDEO_GENERATE_RUNTIME_TOOL_TIMEOUT_MS;
  }
  if (toolId === "download_url") {
    return DOWNLOAD_URL_RUNTIME_TOOL_TIMEOUT_MS;
  }
  if (toolId === "terminal_session_wait") {
    return TERMINAL_WAIT_RUNTIME_TOOL_TIMEOUT_MS;
  }
  return DEFAULT_RUNTIME_TOOL_TIMEOUT_MS;
}

function coerceMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Models frequently mis-shape ask_user_question: they pass `questions: [...]`
// (plural, at the root) instead of the `question` wrapper, and sometimes a
// JSON-stringified value. Normalize any of those into the canonical `question`
// payload (a single item or a `{ questions: [...] }` deck) the runtime expects.
function normalizeAskUserQuestion(params: Record<string, unknown>): unknown {
  let question = coerceMaybeJson(params.question);
  if (question == null && params.questions != null) {
    const questions = coerceMaybeJson(params.questions);
    question = Array.isArray(questions) ? { questions } : questions;
  }
  if (Array.isArray(question)) {
    question = { questions: question };
  }
  return question;
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
    case "ask_user_question": {
      const params = isRecord(toolParams) ? toolParams : {};
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_ASK_USER_QUESTION_PATH,
        body: {
          question: normalizeAskUserQuestion(params),
        },
      };
    }
    case "capability_install":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_CAPABILITY_INSTALL_PATH,
        body: { capability_id: String((isRecord(toolParams) ? toolParams.capability_id : "") ?? "") },
      };
    case "cronjobs_list":
      return { method: "GET", requestPath: cronjobsListPath(toolParams) };
    case "cronjobs_get":
      return {
        method: "GET",
        requestPath: cronjobPath(isRecord(toolParams) ? toolParams.job_id : undefined),
      };
    case "cronjobs_create":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_CRONJOBS_PATH,
        body: createCronjobBody(toolParams),
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
    case "cronjobs_run_now":
      return {
        method: "POST",
        requestPath: `${cronjobPath(isRecord(toolParams) ? toolParams.job_id : undefined)}/run`,
        body: {},
      };
    case "delegate_task":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_SUBAGENTS_PATH,
        body: createDelegateTaskBody(toolParams),
      };
    case "get_task":
      return {
        method: "GET",
        requestPath: getTaskPath(toolParams),
      };
    case "list_tasks":
      return {
        method: "GET",
        requestPath: listTasksPath(toolParams),
      };
    case "reply_task":
      return {
        method: "POST",
        requestPath: `${taskPath(isRecord(toolParams) ? toolParams.task_id : undefined)}/reply`,
        body: createReplyTaskBody(toolParams),
      };
    case "cancel_task":
      return {
        method: "POST",
        requestPath: `${taskPath(isRecord(toolParams) ? toolParams.task_id : undefined)}/cancel`,
        body: {},
      };
    case "rerun_task":
      return {
        method: "POST",
        requestPath: `${taskPath(isRecord(toolParams) ? toolParams.task_id : undefined)}/rerun`,
        body: createRerunTaskBody(toolParams),
      };
    case "image_generate":
      return { method: "POST", requestPath: RUNTIME_TOOLS_IMAGE_GENERATE_PATH, body: createImageGenerationBody(toolParams) };
    case "video_generate":
      return { method: "POST", requestPath: RUNTIME_TOOLS_VIDEO_GENERATE_PATH, body: createVideoGenerationBody(toolParams) };
    case "download_url":
      return { method: "POST", requestPath: RUNTIME_TOOLS_DOWNLOADS_PATH, body: createDownloadUrlBody(toolParams) };
    case "send_file":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_SEND_FILE_PATH,
        body: { path: String((isRecord(toolParams) ? toolParams.path : "") ?? "") },
      };
    case "open_macos_settings":
      return { method: "POST", requestPath: RUNTIME_TOOLS_MACOS_SETTINGS_PATH, body: createOpenMacosSettingsBody(toolParams) };
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
    case "remember":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_MEMORY_REMEMBER_PATH,
        body: createRememberBody(toolParams),
      };
    case "skill":
      return { method: "POST", requestPath: RUNTIME_TOOLS_SKILL_PATH, body: createSkillBody(toolParams) };
    case "todoread":
      return { method: "GET", requestPath: RUNTIME_TOOLS_TODO_PATH };
    case "todowrite":
      return { method: "POST", requestPath: RUNTIME_TOOLS_TODO_PATH, body: createTodoWriteBody(toolParams) };
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
    case "mcp_connect":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_MCP_CONNECT_PATH,
        body: createMcpConnectBody(toolParams),
      };
    case "mcp_refresh":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_MCP_REFRESH_PATH,
        body: {},
      };
    case "mcp_reauthorize":
      return {
        method: "POST",
        requestPath: RUNTIME_TOOLS_MCP_REAUTHORIZE_PATH,
        body: createMcpReauthorizeBody(toolParams),
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

  const formatted = formatCapabilityToolResultForModel(response.payload);
  return {
    content: [{ type: "text", text: formatted.text }],
    details: {
      tool_id: params.toolId,
      ...(formatted.compacted
        ? {
            raw: response.payload,
            raw_result_bytes: formatted.serializedBytes,
            model_result_bytes: formatted.modelTextBytes,
          }
        : {}),
    },
  };
}
