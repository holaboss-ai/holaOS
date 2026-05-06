import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import Database from "better-sqlite3";
import yaml from "js-yaml";

import {
  type AgentSessionRecord,
  type SessionInputRecord,
  type SessionRuntimeStateRecord,
  type SubagentRunRecord,
  type TurnResultRecord,
  utcNowIso,
  type CronjobRecord,
  type RuntimeStateStore,
  type TerminalSessionEventRecord,
  type TerminalSessionRecord,
  type TerminalSessionStatus,
  type WorkspaceRecord,
} from "@holaboss/runtime-state-store";

import { RUNTIME_AGENT_TOOL_DEFINITIONS as RUNTIME_AGENT_TOOL_BASE_DEFINITIONS } from "../../harnesses/src/runtime-agent-tools.js";
import { cronjobNextRunAt } from "./cron-worker.js";
import { ensureWorkspaceDataDb } from "./ts-runner-session-state.js";
import { generateWorkspaceImage } from "./image-generation.js";
import { searchPublicWeb } from "./native-web-search.js";
import { resolveSubagentExecutionProfile } from "./subagent-model.js";
import {
  readSessionScratchpad,
  type SessionScratchpadWriteOperation,
  writeSessionScratchpad,
} from "./session-scratchpad.js";
import {
  blockActiveSessionTodo,
  countSessionTodoTasks,
  flattenSessionTodoSummaries,
  formatSessionTodoListText,
  formatSessionTodoWriteText,
  readSessionTodo,
  readSessionTodoStatus,
  type SessionTodoState,
  writeSessionTodo,
} from "./session-todo.js";
import type { TerminalSessionManagerLike } from "./terminal-session-manager.js";
import type { QueueWorkerLike } from "./queue-worker.js";
import { invokeWorkspaceSkill, resolveWorkspaceSkills } from "./workspace-skills.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const SUBAGENT_CANCEL_SETTLE_TIMEOUT_MS = 8_000;
const SUBAGENT_CANCEL_SETTLE_POLL_INTERVAL_MS = 50;

export interface RuntimeAgentToolDefinition {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
}

export interface RuntimeAgentToolCapabilityPayload {
  available: true;
  workspace_id: string | null;
  tools: RuntimeAgentToolDefinition[];
}

export interface RuntimeAgentToolsCreateCronjobParams {
  workspaceId: string;
  initiatedBy?: string | null;
  sessionId?: string | null;
  selectedModel?: string | null;
  name?: string | null;
  cron: string;
  description: string;
  instruction?: string | null;
  enabled?: boolean;
  delivery?: {
    channel: string;
    mode?: string | null;
    to?: unknown;
  };
  metadata?: Record<string, unknown> | null;
  holabossUserId?: string | null;
}

export interface RuntimeAgentToolsUpdateCronjobParams {
  jobId: string;
  workspaceId?: string | null;
  name?: string | null;
  cron?: string | null;
  description?: string | null;
  instruction?: string | null;
  enabled?: boolean | null;
  delivery?:
    | {
        channel: string;
        mode?: string | null;
        to?: unknown;
      }
    | null;
  metadata?: Record<string, unknown> | null;
}

export interface RuntimeAgentToolsDelegateTaskItem {
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
  useUserBrowserSurface?: boolean | null;
}

export interface RuntimeAgentToolsDelegateTaskParams {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
  selectedModel?: string | null;
  tasks: RuntimeAgentToolsDelegateTaskItem[];
  createdBy?: string | null;
}

export interface RuntimeAgentToolsCancelSubagentParams {
  workspaceId: string;
  sessionId: string;
  subagentId: string;
}

export interface RuntimeAgentToolsResumeSubagentParams {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
  subagentId: string;
  answer: string;
  selectedModel?: string | null;
  model?: string | null;
}

export interface RuntimeAgentToolsContinueSubagentParams {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
  subagentId: string;
  instruction: string;
  title?: string | null;
  selectedModel?: string | null;
  model?: string | null;
}

export interface RuntimeAgentToolsListBackgroundTasksParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  ownerMainSessionId?: string | null;
  statuses?: string[] | null;
  limit?: number | null;
}

export interface RuntimeAgentToolsGetBackgroundTaskParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  subagentId: string;
  ownerMainSessionId?: string | null;
}

export interface RuntimeAgentToolsArchiveBackgroundTaskParams {
  workspaceId: string;
  subagentId: string;
  ownerMainSessionId?: string | null;
}

interface SyncedSubagentRunState {
  run: SubagentRunRecord;
  runtimeState: SessionRuntimeStateRecord | null;
  currentInput: SessionInputRecord | null;
  latestInput: SessionInputRecord | null;
  latestTurnResult: TurnResultRecord | null;
}

export interface RuntimeAgentToolsGenerateImageParams {
  workspaceId: string;
  sessionId?: string | null;
  selectedModel?: string | null;
  prompt: string;
  filename?: string | null;
  size?: string | null;
}

export interface RuntimeAgentToolsDownloadUrlParams {
  workspaceId: string;
  url: string;
  outputPath?: string | null;
  expectedMimePrefix?: string | null;
  overwrite?: boolean;
}

export interface RuntimeAgentToolsWriteReportParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  title?: string | null;
  filename?: string | null;
  summary?: string | null;
  content: string;
}

export interface RuntimeAgentToolsSearchWebParams {
  query: string;
  numResults?: number | null;
  maxResults?: number | null;
  livecrawl?: string | null;
  type?: string | null;
  contextMaxCharacters?: number | null;
  textOffset?: number | null;
  textLimit?: number | null;
}

export interface RuntimeAgentToolsInvokeSkillParams {
  workspaceId: string;
  requestedName: string;
  args?: string | null;
}

export interface RuntimeAgentToolsListDataTablesParams {
  workspaceId: string;
  /** When true, include tables that the convention treats as
   *  app-internal (queues, scheduler logs, settings, api usage).
   *  Default false — agents almost never need to compose dashboards
   *  off these and their visibility just adds noise. */
  includeSystem?: boolean;
}

export interface DataTableColumnInput {
  name: string;
  type: string;
  not_null?: boolean;
  primary_key?: boolean;
}

export interface RuntimeAgentToolsCreateDataTableParams {
  workspaceId: string;
  name: string;
  columns: DataTableColumnInput[];
  rows?: Array<Record<string, unknown>>;
  replaceExisting?: boolean;
}

// Suffixes that mark a table as app-internal under the cross-platform
// metrics convention (see post-metrics-convention plan doc). Tables
// matching these are hidden from list_data_tables by default so the
// agent's "what can I query?" view stays focused on user-facing data.
// Anything not on this list is treated as user data.
const SYSTEM_TABLE_SUFFIXES = [
  "_jobs", // publish queue
  "_metrics_runs", // scheduler activity log
  "_api_usage", // call counters
  "_settings", // pause flags & app config
  "_migrations", // future schema-version table
];

function isSystemTable(name: string): boolean {
  const lowered = name.toLowerCase();
  return SYSTEM_TABLE_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

// Runtime-internal tables are owned by the runtime itself, not by any
// module app, and are never relevant to the agent. Always hidden, even
// when includeSystem=true (which only reveals app-internal tables like
// queues / scheduler logs).
function isRuntimeInternalTable(name: string): boolean {
  return name.startsWith("_");
}

export type DashboardPanelInput =
  | {
      type: "kpi";
      title: string;
      query: string;
    }
  | {
      type: "data_view";
      title: string;
      query: string;
      views: Array<
        | { type: "table"; columns?: string[] }
        | {
            type: "board";
            group_by: string;
            card_title: string;
            card_subtitle?: string | null;
          }
      >;
      default_view?: "table" | "board" | null;
    };

export interface RuntimeAgentToolsCreateDashboardParams {
  workspaceId: string;
  name: string;
  title: string;
  description?: string | null;
  panels: DashboardPanelInput[];
}

export interface RuntimeAgentToolsReadScratchpadParams {
  workspaceId: string;
  sessionId: string;
}

export interface RuntimeAgentToolsReadTodoParams {
  workspaceId: string;
  sessionId: string;
}

export interface RuntimeAgentToolsWriteTodoParams {
  workspaceId: string;
  sessionId: string;
  toolParams: unknown;
}

export interface RuntimeAgentToolsBlockTodoParams {
  workspaceId: string;
  sessionId: string;
  detail: string;
}

export interface RuntimeAgentToolsWriteScratchpadParams {
  workspaceId: string;
  sessionId: string;
  op: SessionScratchpadWriteOperation;
  content?: string | null;
}

export type WorkspaceInstructionsOperation =
  | "read_current"
  | "append_rule"
  | "remove_rule"
  | "replace_managed_section";

export interface RuntimeAgentToolsUpdateWorkspaceInstructionsParams {
  workspaceId: string;
  op: WorkspaceInstructionsOperation;
  rule?: string | null;
  content?: string | null;
}

export interface RuntimeAgentToolsListTerminalSessionsParams {
  workspaceId: string;
  sessionId?: string | null;
  statuses?: TerminalSessionStatus[] | null;
}

export interface RuntimeAgentToolsStartTerminalSessionParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  title?: string | null;
  cwd?: string | null;
  command: string;
  cols?: number | null;
  rows?: number | null;
}

export interface RuntimeAgentToolsGetTerminalSessionParams {
  terminalId: string;
  workspaceId?: string | null;
}

export interface RuntimeAgentToolsReadTerminalSessionParams {
  terminalId: string;
  workspaceId?: string | null;
  afterSequence?: number | null;
  limit?: number | null;
}

export interface RuntimeAgentToolsWaitTerminalSessionParams extends RuntimeAgentToolsReadTerminalSessionParams {
  timeoutMs?: number | null;
}

export interface RuntimeAgentToolsSendTerminalSessionInputParams {
  terminalId: string;
  workspaceId?: string | null;
  data: string;
}

export interface RuntimeAgentToolsSignalTerminalSessionParams {
  terminalId: string;
  workspaceId?: string | null;
  signal?: string | null;
}

export interface RuntimeAgentToolsCloseTerminalSessionParams {
  terminalId: string;
  workspaceId?: string | null;
}

export const ALLOWED_DELIVERY_MODES = new Set(["none", "announce", "deliver"]);
export const ALLOWED_DELIVERY_CHANNELS = new Set(["system_notification", "session_run"]);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const WORKSPACE_INSTRUCTIONS_FILE_PATH = "AGENTS.md";
const WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_START = "<!-- holaboss-managed-workspace-instructions:start -->";
const WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_END = "<!-- holaboss-managed-workspace-instructions:end -->";
const WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_HEADING = "## Holaboss Managed Workspace Instructions";

function runtimeToolBaseDefinition(id: string) {
  const definition = RUNTIME_AGENT_TOOL_BASE_DEFINITIONS.find((tool) => tool.id === id);
  if (!definition) {
    throw new Error(`Unknown runtime agent tool base definition '${id}'`);
  }
  return definition;
}

export const RUNTIME_AGENT_TOOL_DEFINITIONS: RuntimeAgentToolDefinition[] = [
  {
    id: runtimeToolBaseDefinition("holaboss_onboarding_status").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/onboarding/status",
    description: runtimeToolBaseDefinition("holaboss_onboarding_status").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_onboarding_complete").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/complete",
    description: runtimeToolBaseDefinition("holaboss_onboarding_complete").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cronjobs_list").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/cronjobs",
    description: runtimeToolBaseDefinition("holaboss_cronjobs_list").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cronjobs_create").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/cronjobs",
    description: runtimeToolBaseDefinition("holaboss_cronjobs_create").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cronjobs_get").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("holaboss_cronjobs_get").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cronjobs_update").id,
    method: "PATCH",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("holaboss_cronjobs_update").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cronjobs_delete").id,
    method: "DELETE",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("holaboss_cronjobs_delete").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_delegate_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents",
    description: runtimeToolBaseDefinition("holaboss_delegate_task").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_get_subagent").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId",
    description: runtimeToolBaseDefinition("holaboss_get_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_list_background_tasks").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/background-tasks",
    description: runtimeToolBaseDefinition("holaboss_list_background_tasks").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_cancel_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/cancel",
    description: runtimeToolBaseDefinition("holaboss_cancel_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_resume_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/resume",
    description: runtimeToolBaseDefinition("holaboss_resume_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_continue_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/continue",
    description: runtimeToolBaseDefinition("holaboss_continue_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("image_generate").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/images/generate",
    description: runtimeToolBaseDefinition("image_generate").description
  },
  {
    id: runtimeToolBaseDefinition("download_url").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/downloads",
    description: runtimeToolBaseDefinition("download_url").description
  },
  {
    id: runtimeToolBaseDefinition("write_report").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/reports",
    description: runtimeToolBaseDefinition("write_report").description
  },
  {
    id: runtimeToolBaseDefinition("web_search").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/web-search",
    description: runtimeToolBaseDefinition("web_search").description
  },
  {
    id: runtimeToolBaseDefinition("todoread").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/todo",
    description: runtimeToolBaseDefinition("todoread").description
  },
  {
    id: runtimeToolBaseDefinition("todowrite").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/todo",
    description: runtimeToolBaseDefinition("todowrite").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_scratchpad_read").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/scratchpad",
    description: runtimeToolBaseDefinition("holaboss_scratchpad_read").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_scratchpad_write").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/scratchpad",
    description: runtimeToolBaseDefinition("holaboss_scratchpad_write").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_update_workspace_instructions").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-instructions",
    description: runtimeToolBaseDefinition("holaboss_update_workspace_instructions").description
  },
  {
    id: runtimeToolBaseDefinition("skill").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/skill",
    description: runtimeToolBaseDefinition("skill").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_sessions_list").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions",
    description: runtimeToolBaseDefinition("terminal_sessions_list").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_start").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions",
    description: runtimeToolBaseDefinition("terminal_session_start").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_get").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId",
    description: runtimeToolBaseDefinition("terminal_session_get").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_read").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/read",
    description: runtimeToolBaseDefinition("terminal_session_read").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_wait").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/wait",
    description: runtimeToolBaseDefinition("terminal_session_wait").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_send_input").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/input",
    description: runtimeToolBaseDefinition("terminal_session_send_input").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_signal").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/signal",
    description: runtimeToolBaseDefinition("terminal_session_signal").description
  },
  {
    id: runtimeToolBaseDefinition("terminal_session_close").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/terminal-sessions/:terminalId/close",
    description: runtimeToolBaseDefinition("terminal_session_close").description
  },
  {
    id: runtimeToolBaseDefinition("list_data_tables").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/data-tables",
    description: runtimeToolBaseDefinition("list_data_tables").description
  },
  {
    id: runtimeToolBaseDefinition("create_data_table").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/data-tables",
    description: runtimeToolBaseDefinition("create_data_table").description
  },
  {
    id: runtimeToolBaseDefinition("create_dashboard").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/dashboards",
    description: runtimeToolBaseDefinition("create_dashboard").description
  },
];

export class RuntimeAgentToolsServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RuntimeAgentToolsServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface SessionInputAttachmentPayload {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedInteger(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeManagedSectionContent(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeLineEndings(value).trim();
}

function normalizeRuleText(value: string | null | undefined): string {
  return normalizeManagedSectionContent(value).replace(/\s+/g, " ");
}

function extractManagedRulesFromContent(content: string): string[] {
  return normalizeLineEndings(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

type WorkspaceInstructionsDocumentState = {
  normalizedText: string;
  hasManagedSection: boolean;
  managedSectionContent: string;
  beforeManagedSection: string;
  afterManagedSection: string;
  malformedManagedSection: boolean;
};

function parseWorkspaceInstructionsDocument(text: string): WorkspaceInstructionsDocumentState {
  const normalizedText = normalizeLineEndings(text);
  const startIndex = normalizedText.indexOf(WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_START);
  const endIndex = normalizedText.indexOf(WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_END);
  if (startIndex === -1 && endIndex === -1) {
    return {
      normalizedText,
      hasManagedSection: false,
      managedSectionContent: "",
      beforeManagedSection: normalizedText,
      afterManagedSection: "",
      malformedManagedSection: false,
    };
  }
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return {
      normalizedText,
      hasManagedSection: false,
      managedSectionContent: "",
      beforeManagedSection: normalizedText,
      afterManagedSection: "",
      malformedManagedSection: true,
    };
  }
  const endMarkerIndex = endIndex + WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_END.length;
  const beforeManagedSection = normalizedText.slice(0, startIndex).trimEnd();
  const afterManagedSection = normalizedText.slice(endMarkerIndex).trimStart();
  let managedSectionBody = normalizedText
    .slice(startIndex + WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_START.length, endIndex)
    .trim();
  if (managedSectionBody.startsWith(WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_HEADING)) {
    managedSectionBody = managedSectionBody
      .slice(WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_HEADING.length)
      .trim();
  }
  return {
    normalizedText,
    hasManagedSection: true,
    managedSectionContent: managedSectionBody,
    beforeManagedSection,
    afterManagedSection,
    malformedManagedSection: false,
  };
}

function renderWorkspaceInstructionsManagedSection(content: string): string {
  const normalizedContent = normalizeManagedSectionContent(content);
  const lines = [
    WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_START,
    WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_HEADING,
  ];
  if (normalizedContent) {
    lines.push("", normalizedContent);
  }
  lines.push(WORKSPACE_INSTRUCTIONS_MANAGED_SECTION_END);
  return `${lines.join("\n").trimEnd()}\n`;
}

function composeWorkspaceInstructionsDocument(params: {
  beforeManagedSection: string;
  managedSectionContent: string;
  afterManagedSection: string;
}): string {
  const parts: string[] = [];
  const before = params.beforeManagedSection.trim();
  const after = params.afterManagedSection.trim();
  const managed = normalizeManagedSectionContent(params.managedSectionContent);
  if (before) {
    parts.push(before);
  }
  if (managed) {
    parts.push(renderWorkspaceInstructionsManagedSection(managed).trimEnd());
  }
  if (after) {
    parts.push(after);
  }
  if (parts.length === 0) {
    return "";
  }
  return `${parts.join("\n\n").trimEnd()}\n`;
}

function subagentRunHasWaitingBlocker(run: SubagentRunRecord): boolean {
  return normalizedString(run.blockingPayload?.status).toLowerCase() === "waiting_on_user";
}

function parseSessionInputAttachment(value: unknown): SessionInputAttachmentPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const attachment = value as Record<string, unknown>;
  const id = normalizedString(attachment.id);
  const kindValue = normalizedString(attachment.kind);
  const name = normalizedString(attachment.name);
  const mimeType = normalizedString(attachment.mime_type);
  const workspacePath = normalizedString(attachment.workspace_path);
  const sizeBytes =
    typeof attachment.size_bytes === "number" && Number.isFinite(attachment.size_bytes)
      ? Math.max(0, Math.trunc(attachment.size_bytes))
      : 0;
  const kind =
    kindValue === "image" || kindValue === "file" || kindValue === "folder"
      ? kindValue
      : null;
  if (!id || !kind || !name || !mimeType || !workspacePath) {
    return null;
  }
  return {
    id,
    kind,
    name,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    workspace_path: workspacePath,
  };
}

function attachmentsFromInputPayload(value: unknown): SessionInputAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => parseSessionInputAttachment(item))
    .filter((item): item is SessionInputAttachmentPayload => Boolean(item));
}

function quotedSkillIdsFromInstruction(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const skillIds: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }
    const match = /^\/([A-Za-z0-9_-]+)$/.exec(line);
    if (!match) {
      return [];
    }
    skillIds.push(match[1] ?? "");
    index += 1;
  }

  if (skillIds.length === 0) {
    return [];
  }

  if (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    return [];
  }

  return [...new Set(skillIds.filter((skillId) => skillId.length > 0))];
}

function serializeQuotedSkillPrompt(input: string, quotedSkillIds: string[]): string {
  const normalizedBody = input.trim();
  if (quotedSkillIds.length === 0) {
    return normalizedBody;
  }
  const lines = quotedSkillIds.map((skillId) => `/${skillId}`);
  if (!normalizedBody) {
    return lines.join("\n");
  }
  return [...lines, "", normalizedBody].join("\n");
}

function normalizedSubagentTaskTitle(value: string | null | undefined, goal: string): string {
  const explicit = normalizedString(value);
  if (explicit) {
    return explicit;
  }
  const firstLine = goal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? goal).slice(0, 120);
}

const EXPLICIT_USER_BROWSER_SURFACE_PATTERN = /\buse my browser\b/i;

function inputTextValue(
  input: { payload?: Record<string, unknown> | null } | null | undefined,
): string {
  const value = input?.payload?.text;
  return typeof value === "string" ? value : "";
}

function textExplicitlyRequestsUserBrowserSurface(value: string | null | undefined): boolean {
  const text = normalizedString(value);
  if (!text) {
    return false;
  }
  return EXPLICIT_USER_BROWSER_SURFACE_PATTERN.test(text);
}

function contextUsesUserBrowserSurface(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).use_user_browser_surface === true,
  );
}

function inputUsesUserBrowserSurface(
  input: { payload?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return contextUsesUserBrowserSurface(input?.payload?.context);
}

function inputThinkingValue(
  input: { payload?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const value = input?.payload?.thinking_value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function inputModelValue(
  input: { payload?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const value = input?.payload?.model;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function subagentInstruction(params: {
  goal: string;
  context?: string | null;
}): string {
  const goal = normalizedString(params.goal);
  const context = normalizedString(params.context);
  if (!context) {
    return goal;
  }
  return `${goal}\n\nContext:\n${context}`;
}

export function normalizeSubagentToolProfile(params: {
  tools?: string[] | null;
  timeoutMs?: number | null;
}): JsonObject {
  const tools = [...new Set((params.tools ?? []).map((tool) => normalizedString(tool)).filter((tool) => tool.length > 0))];
  return {
    requested_tools: tools,
    ...(typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? { timeout_ms: Math.max(1, Math.trunc(params.timeoutMs)) }
      : {}),
  };
}

function resolvedWorkspaceHarness(workspace: WorkspaceRecord): string {
  return normalizedString(workspace.harness) || "pi";
}

function sanitizeReportFilenameStem(value: string): string {
  const stem = value
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[/\\]+/g, " ")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  return stem || "report";
}

function sanitizeDownloadPathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "download";
}

function sanitizeDownloadFilename(value: string): string {
  return sanitizeDownloadPathSegment(path.basename(value || ""));
}

function normalizedMimeType(value: string | null | undefined): string {
  return normalizedString(value).split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionForMimeType(value: string): string {
  switch (normalizedMimeType(value)) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "text/csv":
      return ".csv";
    case "application/zip":
      return ".zip";
    default:
      return "";
  }
}

function mimeTypeFromFilename(value: string): string {
  switch (path.extname(value).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    default:
      return "";
  }
}

function filenameFromContentDisposition(value: string | null | undefined): string {
  const header = normalizedString(value);
  if (!header) {
    return "";
  }
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  const plainMatch = header.match(/filename\s*=\s*([^;]+)/i);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return "";
}

function filenameFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return decodeURIComponent(path.basename(parsed.pathname));
  } catch {
    return "";
  }
}

function normalizeExpectedMimePrefix(value: string | null | undefined): string {
  return normalizedString(value).toLowerCase();
}

function timeoutErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "download timed out";
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDownloadTarget(params: {
  workspaceRoot: string;
  workspaceId: string;
  outputPath?: string | null;
  overwrite?: boolean;
  suggestedFilename: string;
  mimeType: string;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const workspaceDir = path.join(params.workspaceRoot, params.workspaceId);
  const sanitizedFilename = sanitizeDownloadFilename(params.suggestedFilename || "download");
  const parsedSuggested = path.parse(sanitizedFilename);
  const fallbackExtension = parsedSuggested.ext || extensionForMimeType(params.mimeType);
  const fallbackStem = parsedSuggested.name || "download";

  const requestedPath = normalizedString(params.outputPath);
  if (requestedPath) {
    if (path.isAbsolute(requestedPath)) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "download_output_path_invalid",
        "output_path must be workspace-relative",
      );
    }
    const normalizedRelativePath = path.posix.normalize(requestedPath.replace(/\\/g, "/"));
    if (
      !normalizedRelativePath ||
      normalizedRelativePath === "." ||
      normalizedRelativePath.startsWith("../") ||
      normalizedRelativePath.includes("/../")
    ) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "download_output_path_invalid",
        "output_path must stay within the workspace",
      );
    }
    const parts = normalizedRelativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "download_output_path_invalid",
        "output_path must include a filename",
      );
    }
    const filePart = sanitizeDownloadFilename(parts.pop() ?? "");
    const parsedFile = path.parse(filePart);
    const finalFileName = `${parsedFile.name || fallbackStem}${parsedFile.ext || fallbackExtension}`;
    const safeRelativePath = path.posix.join(
      ...parts.map((part) => sanitizeDownloadPathSegment(part)),
      finalFileName,
    );
    const absolutePath = path.resolve(workspaceDir, safeRelativePath);
    const normalizedWorkspaceDir = path.resolve(workspaceDir);
    if (
      absolutePath !== normalizedWorkspaceDir &&
      !absolutePath.startsWith(`${normalizedWorkspaceDir}${path.sep}`)
    ) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "download_output_path_invalid",
        "output_path must stay within the workspace",
      );
    }
    if (!params.overwrite && (await pathExists(absolutePath))) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "download_target_exists",
        "output_path already exists",
      );
    }
    return { absolutePath, relativePath: safeRelativePath };
  }

  const downloadsDir = path.join(workspaceDir, "Downloads");
  for (let index = 0; index < 1000; index += 1) {
    const fileName =
      index === 0
        ? `${fallbackStem}${fallbackExtension}`
        : `${fallbackStem}-${index + 1}${fallbackExtension}`;
    const relativePath = path.posix.join("Downloads", fileName);
    const absolutePath = path.join(downloadsDir, fileName);
    if (!(await pathExists(absolutePath))) {
      return { absolutePath, relativePath };
    }
  }

  throw new RuntimeAgentToolsServiceError(
    500,
    "download_target_unavailable",
    "unable to allocate a download path",
  );
}

function reportTitleFromContent(content: string): string {
  const headingMatch = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  const firstContentLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstContentLine ? firstContentLine.slice(0, 120) : "";
}

function defaultReportTitle(params: {
  title?: string | null;
  filename?: string | null;
  content: string;
}): string {
  return (
    normalizedString(params.title) ||
    reportTitleFromContent(params.content) ||
    normalizedString(params.filename).replace(/\.md$/i, "") ||
    `Report ${utcNowIso().slice(0, 10)}`
  );
}

async function reportOutputFilePath(params: {
  workspaceDir: string;
  title: string;
  filename?: string | null;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const preferredStem = sanitizeReportFilenameStem(
    normalizedString(params.filename) || params.title,
  );
  for (let index = 0; index < 1000; index += 1) {
    const fileName =
      index === 0 ? `${preferredStem}.md` : `${preferredStem}-${index + 1}.md`;
    const relativePath = path.posix.join("outputs", "reports", fileName);
    const absolutePath = path.join(params.workspaceDir, relativePath);
    try {
      await fs.access(absolutePath);
    } catch {
      return { absolutePath, relativePath };
    }
  }
  throw new RuntimeAgentToolsServiceError(
    500,
    "report_path_exhausted",
    "unable to allocate a report output path",
  );
}

function metadataWithCronjobDefaults(params: {
  metadata: Record<string, unknown> | null | undefined;
  holabossUserId: string | null | undefined;
  selectedModel?: string | null | undefined;
  sourceSessionId?: string | null | undefined;
}
): JsonObject {
  const nextMetadata: JsonObject = { ...((params.metadata ?? {}) as JsonObject) };
  const userId = normalizedString(params.holabossUserId);
  if (userId && typeof nextMetadata.holaboss_user_id !== "string") {
    nextMetadata.holaboss_user_id = userId;
  }
  const selectedModel = normalizedString(params.selectedModel);
  if (selectedModel && typeof nextMetadata.model !== "string") {
    nextMetadata.model = selectedModel;
  }
  const sourceSessionId = normalizedString(params.sourceSessionId);
  if (sourceSessionId && typeof nextMetadata.source_session_id !== "string") {
    nextMetadata.source_session_id = sourceSessionId;
  }
  return nextMetadata;
}

function resolvedInstructionForCronjobUpdate(params: {
  existing: CronjobRecord;
  description: string | null;
  instruction: string | null;
}): string | null | undefined {
  if (params.instruction !== null) {
    return params.instruction;
  }
  if (params.description !== null && params.existing.instruction.trim() === params.existing.description.trim()) {
    return params.description;
  }
  return undefined;
}

export function normalizeDelivery(params: {
  channel: string;
  mode?: string | null;
  to?: unknown;
}): JsonObject {
  const normalizedMode = normalizedString(params.mode ?? "announce") || "announce";
  const canonicalMode = normalizedMode === "deliver" ? "announce" : normalizedMode;
  const normalizedChannel = normalizedString(params.channel);
  if (!ALLOWED_DELIVERY_MODES.has(normalizedMode)) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "cronjob_delivery_mode_invalid",
      `delivery mode must be one of ${JSON.stringify([...ALLOWED_DELIVERY_MODES].sort())}`
    );
  }
  if (!ALLOWED_DELIVERY_CHANNELS.has(normalizedChannel)) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "cronjob_delivery_channel_invalid",
      `delivery channel must be one of ${JSON.stringify([...ALLOWED_DELIVERY_CHANNELS].sort())}`
    );
  }
  return {
    mode: canonicalMode,
    channel: normalizedChannel,
    to: typeof params.to === "string" ? params.to : params.to == null ? null : String(params.to)
  };
}

export function onboardingPayload(workspace: WorkspaceRecord): JsonObject {
  return {
    workspace_id: workspace.id,
    onboarding_status: workspace.onboardingStatus,
    onboarding_session_id: workspace.onboardingSessionId,
    onboarding_completed_at: workspace.onboardingCompletedAt,
    onboarding_completion_summary: workspace.onboardingCompletionSummary,
    onboarding_requested_at: workspace.onboardingRequestedAt,
    onboarding_requested_by: workspace.onboardingRequestedBy
  };
}

export function cronjobPayload(record: CronjobRecord): JsonObject {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    initiated_by: record.initiatedBy,
    name: record.name,
    cron: record.cron,
    description: record.description,
    instruction: record.instruction,
    enabled: record.enabled,
    delivery: record.delivery as JsonValue,
    metadata: record.metadata as JsonValue,
    last_run_at: record.lastRunAt,
    next_run_at: record.nextRunAt,
    run_count: record.runCount,
    last_status: record.lastStatus,
    last_error: record.lastError,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function subagentLiveStatePayload(state: SyncedSubagentRunState): JsonObject {
  return {
    runtime_status: state.runtimeState?.status ?? null,
    current_input_id: state.currentInput?.inputId ?? state.run.currentChildInputId,
    current_input_status: state.currentInput?.status ?? null,
    latest_input_id: state.latestInput?.inputId ?? state.run.latestChildInputId,
    latest_input_status: state.latestInput?.status ?? null,
    latest_turn_status: state.latestTurnResult?.status ?? null,
    latest_turn_stop_reason: state.latestTurnResult?.stopReason ?? null,
  };
}

function subagentRunPayload(state: SyncedSubagentRunState): JsonObject {
  return {
    subagent_id: state.run.subagentId,
    workspace_id: state.run.workspaceId,
    parent_session_id: state.run.parentSessionId,
    parent_input_id: state.run.parentInputId,
    origin_main_session_id: state.run.originMainSessionId,
    owner_main_session_id: state.run.ownerMainSessionId,
    child_session_id: state.run.childSessionId,
    initial_child_input_id: state.run.initialChildInputId,
    current_child_input_id: state.run.currentChildInputId,
    latest_child_input_id: state.run.latestChildInputId,
    title: state.run.title,
    goal: state.run.goal,
    context: state.run.context,
    source_type: state.run.sourceType,
    source_id: state.run.sourceId,
    proposal_id: state.run.proposalId,
    cronjob_id: state.run.cronjobId,
    retry_of_subagent_id: state.run.retryOfSubagentId,
    tool_profile: state.run.toolProfile as JsonValue,
    requested_model: state.run.requestedModel,
    effective_model: state.run.effectiveModel,
    status: state.run.status,
    summary: state.run.summary,
    latest_progress_payload: state.run.latestProgressPayload as JsonValue,
    blocking_payload: state.run.blockingPayload as JsonValue,
    result_payload: state.run.resultPayload as JsonValue,
    error_payload: state.run.errorPayload as JsonValue,
    last_event_at: state.run.lastEventAt,
    owner_transferred_at: state.run.ownerTransferredAt,
    created_at: state.run.createdAt,
    started_at: state.run.startedAt,
    completed_at: state.run.completedAt,
    cancelled_at: state.run.cancelledAt,
    updated_at: state.run.updatedAt,
    live_state: subagentLiveStatePayload(state),
  };
}

function terminalSessionPayload(record: TerminalSessionRecord): JsonObject {
  return {
    terminal_id: record.terminalId,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    title: record.title,
    backend: record.backend,
    owner: record.owner,
    status: record.status,
    cwd: record.cwd,
    shell: record.shell,
    command: record.command,
    exit_code: record.exitCode,
    last_event_seq: record.lastEventSeq,
    created_by: record.createdBy,
    created_at: record.createdAt,
    started_at: record.startedAt,
    last_activity_at: record.lastActivityAt,
    ended_at: record.endedAt,
    metadata: record.metadata as JsonValue,
  };
}

function terminalSessionEventPayload(record: TerminalSessionEventRecord): JsonObject {
  return {
    id: record.id,
    terminal_id: record.terminalId,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    sequence: record.sequence,
    event_type: record.eventType,
    payload: record.payload as JsonValue,
    created_at: record.createdAt,
  };
}

function terminalSessionReadPayload(params: {
  terminal: TerminalSessionRecord;
  events: TerminalSessionEventRecord[];
  afterSequence: number;
  limit: number;
  timedOut?: boolean;
}): JsonObject {
  const latestEventSequence = normalizedInteger(
    params.terminal.lastEventSeq,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  let highestSequence = params.afterSequence;
  for (const event of params.events) {
    highestSequence = Math.max(
      highestSequence,
      normalizedInteger(event.sequence, 0, 0, Number.MAX_SAFE_INTEGER),
    );
  }
  const hasMore = latestEventSequence > highestSequence;
  const remainingEventCount = hasMore
    ? Math.max(0, latestEventSequence - highestSequence)
    : 0;
  return {
    terminal: terminalSessionPayload(params.terminal),
    events: params.events.map((event) => terminalSessionEventPayload(event)),
    count: params.events.length,
    after_sequence: params.afterSequence,
    limit: params.limit,
    has_more: hasMore,
    next_after_sequence: hasMore ? highestSequence : null,
    remaining_event_count: remainingEventCount,
    latest_event_sequence: latestEventSequence,
    timed_out: params.timedOut === true,
  };
}

function sessionTodoBlocked(state: SessionTodoState): boolean {
  return state.phases.flatMap((phase) => phase.tasks).some((task) => task.status === "blocked");
}

function sessionTodoReadPayload(state: SessionTodoState): JsonObject {
  const taskCount = countSessionTodoTasks(state.phases);
  return {
    text: formatSessionTodoListText(state.phases),
    session_id: state.session_id,
    updated_at: state.updated_at,
    phase_count: state.phases.length,
    task_count: taskCount,
    todo_count: taskCount,
    exists: taskCount > 0,
    blocked: sessionTodoBlocked(state),
    phases: state.phases as unknown as JsonValue,
    todos: flattenSessionTodoSummaries(state.phases) as unknown as JsonValue,
  };
}

function sessionTodoWritePayload(params: {
  previousState: SessionTodoState;
  nextState: SessionTodoState;
}): JsonObject {
  const previousTaskCount = countSessionTodoTasks(params.previousState.phases);
  const nextTaskCount = countSessionTodoTasks(params.nextState.phases);
  return {
    text: formatSessionTodoWriteText(params.nextState),
    session_id: params.nextState.session_id,
    updated_at: params.nextState.updated_at,
    previous_phase_count: params.previousState.phases.length,
    phase_count: params.nextState.phases.length,
    previous_task_count: previousTaskCount,
    task_count: nextTaskCount,
    previous_todo_count: previousTaskCount,
    todo_count: nextTaskCount,
    exists: nextTaskCount > 0,
    blocked: sessionTodoBlocked(params.nextState),
    phases: params.nextState.phases as unknown as JsonValue,
    todos: flattenSessionTodoSummaries(params.nextState.phases) as unknown as JsonValue,
  };
}

function sessionTodoStatusPayload(state: SessionTodoState): JsonObject {
  const taskCount = countSessionTodoTasks(state.phases);
  return {
    session_id: state.session_id,
    updated_at: state.updated_at,
    phase_count: state.phases.length,
    task_count: taskCount,
    todo_count: taskCount,
    exists: taskCount > 0,
    blocked: sessionTodoBlocked(state),
  };
}

export function runtimeAgentToolCapabilityPayload(context?: {
  workspaceId?: string | null;
}): RuntimeAgentToolCapabilityPayload {
  const workspaceId = normalizedString(context?.workspaceId);
  return {
    available: true,
    workspace_id: workspaceId || null,
    tools: RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => ({ ...tool }))
  };
}

export class RuntimeAgentToolsService {
  constructor(
    private readonly store: RuntimeStateStore,
    private readonly options: {
      workspaceRoot: string;
      terminalSessionManager?: TerminalSessionManagerLike | null;
      queueWorker?: QueueWorkerLike | null;
    },
  ) {}

  capabilityStatus(context?: { workspaceId?: string | null }): RuntimeAgentToolCapabilityPayload {
    return runtimeAgentToolCapabilityPayload(context);
  }

  onboardingStatus(workspaceId: string): JsonObject {
    return onboardingPayload(this.requireWorkspace(workspaceId));
  }

  completeOnboarding(params: {
    workspaceId: string;
    summary: string;
    requestedBy?: string | null;
  }): JsonObject {
    const workspace = this.requireWorkspace(params.workspaceId);
    const now = utcNowIso();
    const updated = this.store.updateWorkspace(workspace.id, {
      onboardingStatus: "completed",
      onboardingCompletedAt: now,
      onboardingCompletionSummary: params.summary,
      onboardingRequestedAt: now,
      onboardingRequestedBy: normalizedString(params.requestedBy) || "workspace_agent"
    });
    return onboardingPayload(updated);
  }

  listCronjobs(params: {
    workspaceId: string;
    enabledOnly?: boolean;
  }): JsonObject {
    const jobs = this.store
      .listCronjobs({
        workspaceId: params.workspaceId,
        enabledOnly: Boolean(params.enabledOnly)
      })
      .map((job) => cronjobPayload(job));
    return { jobs, count: jobs.length };
  }

  getCronjob(params: {
    jobId: string;
    workspaceId?: string | null;
  }): JsonObject | null {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const job = this.store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!job) {
      return null;
    }
    this.assertCronjobBelongsToWorkspace(job, params.workspaceId);
    return cronjobPayload(job);
  }

  createCronjob(params: RuntimeAgentToolsCreateCronjobParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const cron = normalizedString(params.cron);
    const description = normalizedString(params.description);
    const instruction = normalizedString(params.instruction ?? params.description);
    if (!cron) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_cron_required", "cron is required");
    }
    if (!description) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_description_required", "description is required");
    }
    if (!instruction) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_instruction_required", "instruction is required");
    }
    const created = this.store.createCronjob({
      workspaceId: params.workspaceId,
      initiatedBy: normalizedString(params.initiatedBy) || "workspace_agent",
      name: normalizedString(params.name),
      cron,
      description,
      instruction,
      enabled: params.enabled !== false,
      delivery: normalizeDelivery({
        channel: normalizedString(params.delivery?.channel ?? "session_run") || "session_run",
        mode: params.delivery?.mode ?? "announce",
        to: params.delivery?.to
      }),
      metadata: metadataWithCronjobDefaults({
        metadata: params.metadata,
        holabossUserId: params.holabossUserId,
        selectedModel: params.selectedModel,
        sourceSessionId: params.sessionId,
      }),
      nextRunAt: cronjobNextRunAt(cron, new Date())
    });
    return cronjobPayload(created);
  }

  updateCronjob(params: RuntimeAgentToolsUpdateCronjobParams): JsonObject {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const existing = this.requireCronjob({
      workspaceId,
      jobId: params.jobId,
    });
    this.assertCronjobBelongsToWorkspace(existing, workspaceId);
    const cron = params.cron == null ? null : normalizedString(params.cron);
    if (params.cron !== undefined && !cron) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_cron_required", "cron is required");
    }
    const description = params.description == null ? null : normalizedString(params.description);
    const instruction = params.instruction == null ? null : normalizedString(params.instruction);
    if (params.description !== undefined && !description) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_description_required", "description is required");
    }
    if (params.instruction !== undefined && !instruction) {
      throw new RuntimeAgentToolsServiceError(400, "cronjob_instruction_required", "instruction is required");
    }
    const updated = this.store.updateCronjob({
      workspaceId,
      jobId: params.jobId,
      name: params.name === undefined ? undefined : normalizedString(params.name),
      cron,
      description,
      instruction: resolvedInstructionForCronjobUpdate({ existing, description, instruction }),
      enabled: params.enabled === undefined ? undefined : params.enabled,
      delivery:
        params.delivery === undefined || params.delivery === null
          ? undefined
          : normalizeDelivery({
              channel: params.delivery.channel,
              mode: params.delivery.mode,
              to: params.delivery.to
            }),
      metadata: params.metadata === undefined ? undefined : params.metadata ?? {},
      nextRunAt: cron === null ? undefined : cronjobNextRunAt(cron, new Date())
    });
    if (!updated) {
      throw new RuntimeAgentToolsServiceError(404, "cronjob_not_found", "cronjob not found");
    }
    return cronjobPayload(updated);
  }

  deleteCronjob(params: {
    jobId: string;
    workspaceId?: string | null;
  }): JsonObject {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const existing = this.store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!existing) {
      return { success: false };
    }
    this.assertCronjobBelongsToWorkspace(existing, params.workspaceId);
    return { success: this.store.deleteCronjob({ workspaceId, jobId: params.jobId }) };
  }

  delegateTask(params: RuntimeAgentToolsDelegateTaskParams): JsonObject {
    const workspace = this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    const parentInputId = normalizedString(params.inputId) || null;
    const requestedTasks = params.tasks
      .map((task) => ({
        title: normalizedString(task.title),
        goal: normalizedString(task.goal),
        context: normalizedString(task.context),
        tools: normalizedStringList(task.tools),
        model: normalizedString(task.model),
        useUserBrowserSurface: task.useUserBrowserSurface === true,
        timeoutMs:
          typeof task.timeoutMs === "number" && Number.isFinite(task.timeoutMs)
            ? Math.max(1, Math.trunc(task.timeoutMs))
            : null,
      }))
      .filter((task) => task.goal.length > 0);
    if (requestedTasks.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "subagent_goal_required",
        "at least one delegated task with a non-empty goal is required",
      );
    }

    const createdRuns: SyncedSubagentRunState[] = [];
    for (const task of requestedTasks) {
      const childSessionId = `subagent-${randomUUID()}`;
      const title = normalizedSubagentTaskTitle(task.title, task.goal);
      const requestedModel = task.model || null;
      const parentInput = parentInputId
        ? this.store.getInput({
            workspaceId: params.workspaceId,
            inputId: parentInputId,
          })
        : null;
      const allowUserBrowserSurface = textExplicitlyRequestsUserBrowserSurface(
        inputTextValue(parentInput),
      );
      const useUserBrowserSurface =
        task.useUserBrowserSurface === true && allowUserBrowserSurface;
      const effectiveProfile = resolveSubagentExecutionProfile({
        selectedModel: params.selectedModel ?? inputModelValue(parentInput),
        selectedThinkingValue: inputThinkingValue(parentInput),
      });
      const effectiveModel = effectiveProfile.model;
      const toolProfile = normalizeSubagentToolProfile({
        tools: task.tools,
        timeoutMs: task.timeoutMs,
      });
      const forwardedAttachments = attachmentsFromInputPayload(parentInput?.payload.attachments);
      const forwardedImageUrls = normalizedStringList(parentInput?.payload.image_urls);
      const forwardedQuotedSkillIds = quotedSkillIdsFromInstruction(parentInput?.payload.text);
      const delegatedInstruction = serializeQuotedSkillPrompt(
        subagentInstruction({ goal: task.goal, context: task.context || null }),
        forwardedQuotedSkillIds,
      );
      const createdRun = this.store.createSubagentRun({
        workspaceId: params.workspaceId,
        parentSessionId: controllerSession.sessionId,
        parentInputId,
        originMainSessionId: controllerSession.sessionId,
        ownerMainSessionId: controllerSession.sessionId,
        childSessionId,
        title,
        goal: task.goal,
        context: task.context || null,
        sourceType: "delegate_task",
        toolProfile,
        requestedModel,
        effectiveModel,
        status: "queued",
      });
      if (!this.store.getBinding({ workspaceId: params.workspaceId, sessionId: childSessionId })) {
        this.store.upsertBinding({
          workspaceId: params.workspaceId,
          sessionId: childSessionId,
          harness: resolvedWorkspaceHarness(workspace),
          harnessSessionId: childSessionId,
        });
      }
      this.store.ensureRuntimeState({
        workspaceId: params.workspaceId,
        sessionId: childSessionId,
        status: "QUEUED",
      });
      const input = this.store.enqueueInput({
        workspaceId: params.workspaceId,
        sessionId: childSessionId,
        payload: {
          text: delegatedInstruction,
          attachments: forwardedAttachments,
          image_urls: forwardedImageUrls,
          model: effectiveModel,
          thinking_value: effectiveProfile.thinkingValue,
          context: {
            source: "subagent",
            subagent_id: createdRun.subagentId,
            parent_session_id: controllerSession.sessionId,
            parent_input_id: parentInputId,
            origin_main_session_id: controllerSession.sessionId,
            owner_main_session_id: controllerSession.sessionId,
            goal: task.goal,
            task_title: title,
            task_context: task.context || null,
            tool_profile: toolProfile,
            requested_model: requestedModel,
            effective_model: effectiveModel,
            forwarded_attachment_count: forwardedAttachments.length,
            forwarded_quoted_skill_ids: forwardedQuotedSkillIds,
            ...(useUserBrowserSurface ? { use_user_browser_surface: true } : {}),
          },
        },
      });
      this.store.updateRuntimeState({
        workspaceId: params.workspaceId,
        sessionId: childSessionId,
        status: "QUEUED",
        currentInputId: input.inputId,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
      const updatedRun =
        this.store.updateSubagentRun({
          workspaceId: params.workspaceId,
          subagentId: createdRun.subagentId,
          fields: {
            initialChildInputId: input.inputId,
            currentChildInputId: input.inputId,
            latestChildInputId: input.inputId,
            status: "queued",
          },
        }) ?? createdRun;
      createdRuns.push(this.syncSubagentRunState(updatedRun));
    }

    this.options.queueWorker?.wake();
    return {
      tasks: createdRuns.map((run) => subagentRunPayload(run)),
      count: createdRuns.length,
    };
  }

  async cancelSubagent(params: RuntimeAgentToolsCancelSubagentParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    let state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      ownerMainSessionId: controllerSession.sessionId,
    });
    if (state.run.status === "cancelled") {
      return subagentRunPayload(state);
    }
    const now = utcNowIso();
    if (state.currentInput?.status === "QUEUED") {
      this.store.updateInput({
        workspaceId: params.workspaceId,
        inputId: state.currentInput.inputId,
        fields: {
          status: "DONE",
          claimedBy: null,
          claimedUntil: null,
        },
      });
      this.store.updateRuntimeState({
        workspaceId: params.workspaceId,
        sessionId: state.run.childSessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
    } else if (state.currentInput?.status === "CLAIMED") {
      const paused = await this.options.queueWorker?.pauseSessionRun?.({
        workspaceId: params.workspaceId,
        sessionId: state.run.childSessionId,
      });
      if (!paused) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "subagent_cancel_unavailable",
          "subagent is currently running and could not be cancelled",
        );
      }
      state = await this.waitForSubagentCancellationSettlement({
        workspaceId: params.workspaceId,
        subagentId: params.subagentId,
        ownerMainSessionId: controllerSession.sessionId,
      });
    } else if (!["waiting_on_user", "queued", "running"].includes(state.run.status)) {
      return subagentRunPayload(state);
    } else {
      this.store.updateRuntimeState({
        workspaceId: params.workspaceId,
        sessionId: state.run.childSessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
      state = this.syncSubagentRunForOwner({
        workspaceId: params.workspaceId,
        subagentId: params.subagentId,
        ownerMainSessionId: controllerSession.sessionId,
      });
    }
    const completedAt =
      state.run.completedAt ??
      state.latestTurnResult?.completedAt ??
      state.latestTurnResult?.updatedAt ??
      null;
    const updated =
      this.store.updateSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: state.run.subagentId,
        fields: {
          status: "cancelled",
          cancelledAt: now,
          completedAt,
          summary: normalizedString(state.run.summary) || "Cancelled by user.",
          latestProgressPayload: null,
        },
      }) ?? state.run;
    return subagentRunPayload(this.syncSubagentRunState(updated));
  }

  resumeSubagent(params: RuntimeAgentToolsResumeSubagentParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    const answer = normalizedString(params.answer);
    if (!answer) {
      throw new RuntimeAgentToolsServiceError(400, "subagent_answer_required", "answer is required");
    }
    const state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      ownerMainSessionId: controllerSession.sessionId,
    });
    if (state.run.status !== "waiting_on_user") {
      throw new RuntimeAgentToolsServiceError(
        409,
        "subagent_not_waiting_on_user",
        "subagent is not currently waiting on user input",
      );
    }
    const previousChildInput = normalizedString(state.run.latestChildInputId)
      ? this.store.getInput({
          workspaceId: params.workspaceId,
          inputId: normalizedString(state.run.latestChildInputId),
        })
      : null;
    const effectiveProfile = resolveSubagentExecutionProfile({
      selectedModel:
        params.selectedModel ?? params.model ?? inputModelValue(previousChildInput),
      selectedThinkingValue: inputThinkingValue(previousChildInput),
    });
    const effectiveModel = effectiveProfile.model;
    const useUserBrowserSurface = inputUsesUserBrowserSurface(previousChildInput);
    const resumedInput = this.store.enqueueInput({
      workspaceId: params.workspaceId,
      sessionId: state.run.childSessionId,
      payload: {
        text: answer,
        attachments: [],
        image_urls: [],
        model: effectiveModel,
        thinking_value: effectiveProfile.thinkingValue,
        context: {
          source: "subagent_resume",
          subagent_id: state.run.subagentId,
          origin_main_session_id: state.run.originMainSessionId,
          owner_main_session_id: controllerSession.sessionId,
          parent_session_id: controllerSession.sessionId,
          parent_input_id: normalizedString(params.inputId) || null,
          resumed_from_input_id: state.run.latestChildInputId,
          resumed_from_status: state.run.status,
          ...(useUserBrowserSurface ? { use_user_browser_surface: true } : {}),
        },
      },
    });
      this.store.updateRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: state.run.childSessionId,
      status: "QUEUED",
      currentInputId: resumedInput.inputId,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null,
    });
    const updated =
      this.store.updateSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: state.run.subagentId,
        fields: {
          ownerMainSessionId: controllerSession.sessionId,
          currentChildInputId: resumedInput.inputId,
          latestChildInputId: resumedInput.inputId,
          status: "queued",
          blockingPayload: null,
          effectiveModel,
          latestProgressPayload: null,
        },
      }) ?? state.run;
    const staleWaitingEventIds = this.store
      .listPendingMainSessionEvents({
        workspaceId: params.workspaceId,
        ownerMainSessionId: controllerSession.sessionId,
        deliveryBucket: "waiting_on_user",
        limit: 500,
      })
      .filter((event) => event.subagentId === state.run.subagentId)
      .map((event) => event.eventId);
    if (staleWaitingEventIds.length > 0) {
      this.store.markMainSessionEventsSuperseded({
        workspaceId: params.workspaceId,
        eventIds: staleWaitingEventIds,
      });
    }
    this.options.queueWorker?.wake();
    return subagentRunPayload(this.syncSubagentRunState(updated));
  }

  continueSubagent(params: RuntimeAgentToolsContinueSubagentParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    const instruction = normalizedString(params.instruction);
    if (!instruction) {
      throw new RuntimeAgentToolsServiceError(400, "subagent_instruction_required", "instruction is required");
    }
    const state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      ownerMainSessionId: controllerSession.sessionId,
    });
    if (["queued", "running"].includes(state.run.status)) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "subagent_already_active",
        "subagent is already active",
      );
    }
    if (state.run.status === "waiting_on_user") {
      throw new RuntimeAgentToolsServiceError(
        409,
        "subagent_waiting_on_user",
        "subagent is waiting on user input; use resume instead",
      );
    }
    const parentInput = normalizedString(params.inputId)
      ? this.store.getInput({
          workspaceId: params.workspaceId,
          inputId: normalizedString(params.inputId),
        })
      : null;
    const previousChildInput = normalizedString(state.run.latestChildInputId)
      ? this.store.getInput({
          workspaceId: params.workspaceId,
          inputId: normalizedString(state.run.latestChildInputId),
        })
      : null;
    const effectiveProfile = resolveSubagentExecutionProfile({
      selectedModel:
        params.selectedModel ??
        params.model ??
        inputModelValue(parentInput) ??
        inputModelValue(previousChildInput),
      selectedThinkingValue:
        inputThinkingValue(parentInput) ?? inputThinkingValue(previousChildInput),
    });
    const effectiveModel = effectiveProfile.model;
    const forwardedAttachments = attachmentsFromInputPayload(parentInput?.payload.attachments);
    const forwardedImageUrls = normalizedStringList(parentInput?.payload.image_urls);
    const forwardedQuotedSkillIds = quotedSkillIdsFromInstruction(parentInput?.payload.text);
    const useUserBrowserSurface = inputUsesUserBrowserSurface(previousChildInput);
    const continuationInstruction = serializeQuotedSkillPrompt(
      subagentInstruction({
        goal: instruction,
        context:
          "Continue from your previous result in this same child session. Do not treat this as a brand-new unrelated task.",
      }),
      forwardedQuotedSkillIds,
    );
    this.store.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: state.run.childSessionId,
        kind: "subagent",
        parentSessionId: controllerSession.sessionId,
        title: normalizedString(params.title) || state.run.title,
        archivedAt: null,
      },
      { touchExisting: false },
    );
    const continuedInput = this.store.enqueueInput({
      workspaceId: params.workspaceId,
      sessionId: state.run.childSessionId,
      payload: {
        text: continuationInstruction,
        attachments: forwardedAttachments,
        image_urls: forwardedImageUrls,
        model: effectiveModel,
        thinking_value: effectiveProfile.thinkingValue,
        context: {
          source: "subagent_continue",
          subagent_id: state.run.subagentId,
          origin_main_session_id: state.run.originMainSessionId,
          owner_main_session_id: controllerSession.sessionId,
          parent_session_id: controllerSession.sessionId,
          parent_input_id: normalizedString(params.inputId) || null,
          continued_from_input_id: state.run.latestChildInputId,
          continued_from_status: state.run.status,
          ...(useUserBrowserSurface ? { use_user_browser_surface: true } : {}),
        },
      },
    });
    this.store.updateRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: state.run.childSessionId,
      status: "QUEUED",
      currentInputId: continuedInput.inputId,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null,
    });
    const nextTitle = normalizedSubagentTaskTitle(params.title, instruction);
    const updated =
      this.store.updateSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: state.run.subagentId,
        fields: {
          parentInputId: normalizedString(params.inputId) || state.run.parentInputId,
          ownerMainSessionId: controllerSession.sessionId,
          currentChildInputId: continuedInput.inputId,
          latestChildInputId: continuedInput.inputId,
          title: normalizedString(params.title) ? nextTitle : state.run.title,
          status: "queued",
          summary: null,
          blockingPayload: null,
          resultPayload: null,
          errorPayload: null,
          completedAt: null,
          cancelledAt: null,
          effectiveModel,
          latestProgressPayload: null,
          lastEventAt: null,
        },
      }) ?? state.run;
    this.options.queueWorker?.wake();
    return subagentRunPayload(this.syncSubagentRunState(updated));
  }

  listBackgroundTasks(params: RuntimeAgentToolsListBackgroundTasksParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const requestedSessionId = normalizedString(params.sessionId);
    if (requestedSessionId) {
      this.requireSubagentControllerSession(params.workspaceId, requestedSessionId);
    }
    const requestedStatuses = new Set(normalizedStringList(params.statuses).map((status) => status.toLowerCase()));
    const requestedOwnerMainSessionId = normalizedString(params.ownerMainSessionId);
    const synced = this.store
      .listSubagentRunsByWorkspace({ workspaceId: params.workspaceId })
      .map((run) => this.syncSubagentRunState(run))
      .filter((state) => this.isVisibleBackgroundTask(state.run))
      .filter((state) => (requestedOwnerMainSessionId ? state.run.ownerMainSessionId === requestedOwnerMainSessionId : true))
      .filter((state) => (requestedStatuses.size > 0 ? requestedStatuses.has(state.run.status.toLowerCase()) : true))
      .slice(0, normalizedInteger(params.limit, 200, 1, 1000));
    this.assertSameTurnDelegationPollingAllowed({
      workspaceId: params.workspaceId,
      sessionId: requestedSessionId || null,
      inputId: normalizedString(params.inputId) || null,
      states: synced,
      toolId: "holaboss_list_background_tasks",
    });
    return {
      tasks: synced.map((state) => subagentRunPayload(state)),
      count: synced.length,
    };
  }

  getBackgroundTask(params: RuntimeAgentToolsGetBackgroundTaskParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const requestedSessionId = normalizedString(params.sessionId);
    if (requestedSessionId) {
      this.requireSubagentControllerSession(params.workspaceId, requestedSessionId);
    }
    const state = this.syncSubagentRunForOwner({
        workspaceId: params.workspaceId,
        subagentId: params.subagentId,
        ownerMainSessionId: normalizedString(params.ownerMainSessionId) || requestedSessionId || null,
      });
    this.assertSameTurnDelegationPollingAllowed({
      workspaceId: params.workspaceId,
      sessionId: requestedSessionId || null,
      inputId: normalizedString(params.inputId) || null,
      states: [state],
      toolId: "holaboss_get_subagent",
    });
    if (!this.isVisibleBackgroundTask(state.run)) {
      throw new RuntimeAgentToolsServiceError(404, "subagent_not_found", "subagent not found");
    }
    return subagentRunPayload(state);
  }

  archiveBackgroundTask(
    params: RuntimeAgentToolsArchiveBackgroundTaskParams,
  ): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      ownerMainSessionId: normalizedString(params.ownerMainSessionId) || null,
    });
    const existingSession = this.store.getSession({
      workspaceId: state.run.workspaceId,
      sessionId: state.run.childSessionId,
    });
    if (!existingSession) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "subagent_session_not_found",
        "subagent session not found",
      );
    }
    const archivedAt = existingSession.archivedAt || utcNowIso();
    const archivedSession = this.store.ensureSession({
      workspaceId: existingSession.workspaceId,
      sessionId: existingSession.sessionId,
      archivedAt,
    });
    return {
      subagent_id: state.run.subagentId,
      child_session_id: archivedSession.sessionId,
      archived: true,
      archived_at: archivedSession.archivedAt,
    };
  }

  async generateImage(params: RuntimeAgentToolsGenerateImageParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId) || "session-main";
    const prompt = normalizedString(params.prompt);
    if (!prompt) {
      throw new RuntimeAgentToolsServiceError(400, "image_prompt_required", "prompt is required");
    }
    try {
      const generated = await generateWorkspaceImage({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId,
        inputId: "runtime-tool",
        selectedModel: params.selectedModel,
        prompt,
        filename: params.filename,
        size: params.size,
      });
      return {
        file_path: generated.filePath,
        mime_type: generated.mimeType,
        size_bytes: generated.sizeBytes,
        provider_id: generated.providerId,
        model_id: generated.modelId,
        revised_prompt: generated.revisedPrompt,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /not configured|configure an image generation provider/i.test(error.message)
      ) {
        throw new RuntimeAgentToolsServiceError(409, "image_generation_not_configured", error.message);
      }
      throw new RuntimeAgentToolsServiceError(
        502,
        "image_generation_failed",
        error instanceof Error ? error.message : "image generation failed",
      );
    }
  }

  async downloadUrl(params: RuntimeAgentToolsDownloadUrlParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sourceUrl = normalizedString(params.url);
    if (!sourceUrl) {
      throw new RuntimeAgentToolsServiceError(400, "download_url_required", "url is required");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      throw new RuntimeAgentToolsServiceError(400, "download_url_invalid", "url must be a valid http or https URL");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new RuntimeAgentToolsServiceError(400, "download_url_invalid", "url must use http or https");
    }

    let response: Response;
    try {
      response = await fetch(parsedUrl, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "download_request_failed",
        timeoutErrorMessage(error),
      );
    }

    if (!response.ok) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "download_request_failed",
        `download failed with status ${response.status}`,
      );
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new RuntimeAgentToolsServiceError(
        413,
        "download_too_large",
        `download exceeds ${MAX_DOWNLOAD_BYTES} bytes`,
      );
    }

    const finalUrl = normalizedString(response.url) || sourceUrl;
    const suggestedFilename =
      filenameFromContentDisposition(response.headers.get("content-disposition")) ||
      filenameFromUrl(finalUrl) ||
      filenameFromUrl(sourceUrl) ||
      "download";
    const headerMimeType = normalizedMimeType(response.headers.get("content-type"));
    const mimeType = headerMimeType || mimeTypeFromFilename(suggestedFilename) || "application/octet-stream";
    const expectedMimePrefix = normalizeExpectedMimePrefix(params.expectedMimePrefix);
    if (expectedMimePrefix && !mimeType.startsWith(expectedMimePrefix)) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "download_mime_mismatch",
        `downloaded content type ${mimeType} does not match expected prefix ${expectedMimePrefix}`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "download_read_failed",
        error instanceof Error ? error.message : "failed to read download",
      );
    }

    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new RuntimeAgentToolsServiceError(
        413,
        "download_too_large",
        `download exceeds ${MAX_DOWNLOAD_BYTES} bytes`,
      );
    }

    const { absolutePath, relativePath } = await resolveDownloadTarget({
      workspaceRoot: this.options.workspaceRoot,
      workspaceId: params.workspaceId,
      outputPath: params.outputPath,
      overwrite: params.overwrite,
      suggestedFilename,
      mimeType,
    });

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, bytes);

    return {
      file_path: relativePath,
      source_url: sourceUrl,
      final_url: finalUrl,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
    };
  }

  async readTodo(params: RuntimeAgentToolsReadTodoParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "todo_session_required", "session_id is required");
    }
    return sessionTodoReadPayload(
      await readSessionTodo({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId,
      }),
    );
  }

  async writeTodo(params: RuntimeAgentToolsWriteTodoParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "todo_session_required", "session_id is required");
    }
    const result = await writeSessionTodo({
      workspaceRoot: this.options.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId,
      toolParams: params.toolParams,
    });
    return sessionTodoWritePayload(result);
  }

  async readTodoStatus(params: RuntimeAgentToolsReadTodoParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "todo_session_required", "session_id is required");
    }
    const { state } = await readSessionTodoStatus({
      workspaceRoot: this.options.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId,
    });
    return sessionTodoStatusPayload(state);
  }

  async blockTodo(params: RuntimeAgentToolsBlockTodoParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "todo_session_required", "session_id is required");
    }
    const detail = normalizedString(params.detail);
    if (!detail) {
      throw new RuntimeAgentToolsServiceError(400, "todo_detail_required", "detail is required");
    }
    const state =
      (await blockActiveSessionTodo({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId,
        detail,
      })) ??
      (await readSessionTodo({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId,
      }));
    return sessionTodoStatusPayload(state);
  }

  async writeReport(params: RuntimeAgentToolsWriteReportParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    const content = String(params.content ?? "");
    if (!content.trim()) {
      throw new RuntimeAgentToolsServiceError(400, "report_content_required", "content is required");
    }
    const title = defaultReportTitle({
      title: params.title,
      filename: params.filename,
      content,
    });
    const workspaceDir = this.store.workspaceDir(params.workspaceId);
    const { absolutePath, relativePath } = await reportOutputFilePath({
      workspaceDir,
      title,
      filename: params.filename,
    });
    const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, normalizedContent, "utf8");

    const sizeBytes = Buffer.byteLength(normalizedContent, "utf8");
    const output = this.store.createOutput({
      workspaceId: params.workspaceId,
      outputType: "document",
      title,
      status: "completed",
      filePath: relativePath,
      sessionId: sessionId || null,
      inputId: normalizedString(params.inputId) || null,
      artifactId: randomUUID(),
      metadata: {
        origin_type: "runtime_tool",
        change_type: "created",
        category: "document",
        artifact_type: "report",
        mime_type: "text/markdown",
        size_bytes: sizeBytes,
        tool_id: "write_report",
        ...(normalizedString(params.summary)
          ? { summary: normalizedString(params.summary) }
          : {}),
        ...(normalizedString(params.selectedModel)
          ? { model: normalizedString(params.selectedModel) }
          : {}),
        ...(sessionId ? { source_session_id: sessionId } : {}),
      },
    });

    return {
      output_id: output.id,
      artifact_id: output.artifactId,
      title: output.title,
      file_path: relativePath,
      mime_type: "text/markdown",
      size_bytes: sizeBytes,
      created_at: output.createdAt,
    };
  }

  async searchWeb(params: RuntimeAgentToolsSearchWebParams): Promise<JsonObject> {
    try {
      const result = await searchPublicWeb({
        query: params.query,
        numResults: params.numResults,
        maxResults: params.maxResults,
        livecrawl: params.livecrawl,
        type: params.type,
        contextMaxCharacters: params.contextMaxCharacters,
      });
      const fullText = result.text;
      const textOffset = normalizedInteger(params.textOffset, 0, 0, Number.MAX_SAFE_INTEGER);
      const textLimit = normalizedInteger(params.textLimit, 12_000, 1, 200_000);
      const start = Math.min(textOffset, fullText.length);
      const end = Math.min(fullText.length, start + textLimit);
      const windowText = fullText.slice(start, end);
      const hasMore = end < fullText.length;
      return {
        text: windowText,
        provider: result.providerId,
        tool_id: "web_search",
        text_offset: start,
        text_limit: textLimit,
        text_total_chars: fullText.length,
        has_more: hasMore,
        next_text_offset: hasMore ? end : null,
      };
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "web_search_failed",
        error instanceof Error ? error.message : "web search failed"
      );
    }
  }

  invokeSkill(params: RuntimeAgentToolsInvokeSkillParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    try {
      const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
      const result = invokeWorkspaceSkill({
        requestedName: params.requestedName,
        args: params.args,
        workspaceSkills: resolveWorkspaceSkills(workspaceDir),
      });
      return {
        text: result.text,
        skill_block: result.skill_block,
        requested_name: result.requested_name,
        skill_id: result.skill_id,
        skill_name: result.skill_name,
        skill_file_path: result.skill_file_path,
        skill_base_dir: result.skill_base_dir,
        granted_tools: result.granted_tools as unknown as JsonValue,
        granted_commands: result.granted_commands as unknown as JsonValue,
        args: result.args,
        tool_id: "skill",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "skill invocation failed";
      const statusCode = /was not found/i.test(message) ? 404 : /requires a non-empty `name` argument/i.test(message) ? 400 : 500;
      throw new RuntimeAgentToolsServiceError(statusCode, "skill_invocation_failed", message);
    }
  }

  async readScratchpad(params: RuntimeAgentToolsReadScratchpadParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "scratchpad_session_required", "session_id is required");
    }
    const scratchpad = await readSessionScratchpad({
      workspaceRoot: this.options.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId,
      includeContent: true,
    });
    return {
      exists: scratchpad.exists,
      file_path: scratchpad.file_path,
      updated_at: scratchpad.updated_at,
      size_bytes: scratchpad.size_bytes,
      preview: scratchpad.preview,
      content: scratchpad.content ?? null,
    };
  }

  async writeScratchpad(params: RuntimeAgentToolsWriteScratchpadParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(400, "scratchpad_session_required", "session_id is required");
    }
    const op = normalizedString(params.op) as SessionScratchpadWriteOperation;
    if (op !== "append" && op !== "replace" && op !== "clear") {
      throw new RuntimeAgentToolsServiceError(
        400,
        "scratchpad_op_invalid",
        "op must be one of [\"append\",\"replace\",\"clear\"]",
      );
    }
    try {
      const scratchpad = await writeSessionScratchpad({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId,
        op,
        content: params.content,
      });
      return {
        op,
        ...scratchpad,
      };
    } catch (error) {
      if (error instanceof Error && /content is required/i.test(error.message)) {
        throw new RuntimeAgentToolsServiceError(400, "scratchpad_content_required", "content is required");
      }
      throw error;
    }
  }

  async updateWorkspaceInstructions(
    params: RuntimeAgentToolsUpdateWorkspaceInstructionsParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const op = normalizedString(params.op) as WorkspaceInstructionsOperation;
    if (
      op !== "read_current" &&
      op !== "append_rule" &&
      op !== "remove_rule" &&
      op !== "replace_managed_section"
    ) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_instructions_op_invalid",
        "op must be one of [\"read_current\",\"append_rule\",\"remove_rule\",\"replace_managed_section\"]",
      );
    }

    const absolutePath = path.join(
      this.options.workspaceRoot,
      params.workspaceId,
      WORKSPACE_INSTRUCTIONS_FILE_PATH,
    );
    const fileExists = existsSync(absolutePath);
    const currentText = fileExists
      ? normalizeLineEndings(await fs.readFile(absolutePath, "utf8"))
      : "";
    const parsed = parseWorkspaceInstructionsDocument(currentText);
    if (parsed.malformedManagedSection) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_instructions_malformed",
        "AGENTS.md contains malformed managed workspace-instructions markers",
      );
    }

    let nextManagedSectionContent = parsed.managedSectionContent;
    let changed = false;

    if (op === "append_rule") {
      const rule = normalizeRuleText(params.rule);
      if (!rule) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "workspace_instructions_rule_required",
          "rule is required for append_rule",
        );
      }
      const existingRules = new Set(
        extractManagedRulesFromContent(parsed.managedSectionContent).map((entry) =>
          normalizeRuleText(entry),
        ),
      );
      if (!existingRules.has(rule)) {
        nextManagedSectionContent = parsed.managedSectionContent
          ? `${parsed.managedSectionContent.trimEnd()}\n- ${rule}`
          : `- ${rule}`;
        changed = true;
      }
    } else if (op === "remove_rule") {
      const rule = normalizeRuleText(params.rule);
      if (!rule) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "workspace_instructions_rule_required",
          "rule is required for remove_rule",
        );
      }
      const remainingLines = normalizeLineEndings(parsed.managedSectionContent)
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          if (!/^[-*]\s+/.test(trimmed)) {
            return true;
          }
          return normalizeRuleText(trimmed.replace(/^[-*]\s+/, "")) !== rule;
        });
      const nextContent = normalizeManagedSectionContent(
        remainingLines.join("\n"),
      );
      changed = nextContent !== parsed.managedSectionContent;
      nextManagedSectionContent = nextContent;
    } else if (op === "replace_managed_section") {
      const nextContent = normalizeManagedSectionContent(params.content);
      changed = nextContent !== parsed.managedSectionContent || parsed.hasManagedSection !== Boolean(nextContent);
      nextManagedSectionContent = nextContent;
    }

    const nextText = composeWorkspaceInstructionsDocument({
      beforeManagedSection: parsed.beforeManagedSection,
      managedSectionContent: nextManagedSectionContent,
      afterManagedSection: parsed.afterManagedSection,
    });

    if (changed && nextText !== currentText) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, nextText, "utf8");
    }

    const finalText = changed ? nextText : currentText;
    const finalParsed = parseWorkspaceInstructionsDocument(finalText);
    return {
      op,
      changed: changed && nextText !== currentText,
      file_exists: fileExists || Boolean(finalText),
      file_path: WORKSPACE_INSTRUCTIONS_FILE_PATH,
      managed_section_present: finalParsed.hasManagedSection,
      managed_section_content: finalParsed.hasManagedSection
        ? finalParsed.managedSectionContent
        : null,
      managed_rules: extractManagedRulesFromContent(finalParsed.managedSectionContent),
      full_text: finalText || null,
    };
  }

  listTerminalSessions(params: RuntimeAgentToolsListTerminalSessionsParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const sessions = this.requireTerminalSessionManager()
      .listSessions({
        workspaceId: params.workspaceId,
        sessionId: normalizedString(params.sessionId) || undefined,
        statuses: Array.isArray(params.statuses) && params.statuses.length > 0 ? params.statuses : undefined,
      })
      .map((record) => terminalSessionPayload(record));
    return { sessions, count: sessions.length };
  }

  async startTerminalSession(params: RuntimeAgentToolsStartTerminalSessionParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const session = await this.requireTerminalSessionManager().createSession({
      workspaceId: params.workspaceId,
      sessionId: normalizedString(params.sessionId) || null,
      inputId: normalizedString(params.inputId) || null,
      title: normalizedString(params.title) || null,
      owner: "agent",
      cwd: normalizedString(params.cwd) || null,
      command: params.command,
      cols: typeof params.cols === "number" ? params.cols : undefined,
      rows: typeof params.rows === "number" ? params.rows : undefined,
      createdBy: "runtime_tool",
      metadata: {
        origin_type: "runtime_tool",
        tool_id: "terminal_session_start",
        ...(normalizedString(params.selectedModel)
          ? { model: normalizedString(params.selectedModel) }
          : {}),
      },
    });
    return terminalSessionPayload(session);
  }

  getTerminalSession(params: RuntimeAgentToolsGetTerminalSessionParams): JsonObject {
    return terminalSessionPayload(
      this.requireTerminalSession({
        terminalId: params.terminalId,
        workspaceId: normalizedString(params.workspaceId),
      })
    );
  }

  readTerminalSession(params: RuntimeAgentToolsReadTerminalSessionParams): JsonObject {
    const manager = this.requireTerminalSessionManager();
    const terminal = this.requireTerminalSession({
      terminalId: params.terminalId,
      workspaceId: normalizedString(params.workspaceId),
    });
    const afterSequence = normalizedInteger(params.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = normalizedInteger(params.limit, 200, 1, 1000);
    const events = manager.listEvents({
      workspaceId: terminal.workspaceId,
      terminalId: terminal.terminalId,
      afterSequence,
      limit,
    });
    return terminalSessionReadPayload({ terminal, events, afterSequence, limit });
  }

  async waitTerminalSession(params: RuntimeAgentToolsWaitTerminalSessionParams): Promise<JsonObject> {
    const manager = this.requireTerminalSessionManager();
    const initialTerminal = this.requireTerminalSession({
      terminalId: params.terminalId,
      workspaceId: normalizedString(params.workspaceId),
    });
    const afterSequence = normalizedInteger(params.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = normalizedInteger(params.limit, 200, 1, 1000);
    const timeoutMs = normalizedInteger(params.timeoutMs, 15_000, 1, 60_000);
    const immediateEvents = manager.listEvents({
      workspaceId: initialTerminal.workspaceId,
      terminalId: initialTerminal.terminalId,
      afterSequence,
      limit,
    });
    if (immediateEvents.length > 0 || !["starting", "running"].includes(initialTerminal.status)) {
      const terminal = this.requireTerminalSession({
        terminalId: params.terminalId,
        workspaceId: normalizedString(params.workspaceId),
      });
      return terminalSessionReadPayload({
        terminal,
        events: immediateEvents,
        afterSequence,
        limit,
        timedOut: false,
      });
    }

    return await new Promise<JsonObject>((resolve) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const finish = (timedOut: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        unsubscribe();
        const terminal = this.requireTerminalSession({
          terminalId: params.terminalId,
          workspaceId: normalizedString(params.workspaceId),
        });
        const events = manager.listEvents({
          workspaceId: terminal.workspaceId,
          terminalId: terminal.terminalId,
          afterSequence,
          limit,
        });
        resolve(
          terminalSessionReadPayload({
            terminal,
            events,
            afterSequence,
            limit,
            timedOut,
          }),
        );
      };
      const unsubscribe = manager.subscribe(initialTerminal.terminalId, (event) => {
        if (event.sequence > afterSequence) {
          finish(false);
        }
      });
      timeoutHandle = setTimeout(() => {
        finish(true);
      }, timeoutMs);
    });
  }

  async sendTerminalSessionInput(params: RuntimeAgentToolsSendTerminalSessionInputParams): Promise<JsonObject> {
    const terminal = this.requireTerminalSession({
      terminalId: params.terminalId,
      workspaceId: normalizedString(params.workspaceId),
    });
    const session = await this.requireTerminalSessionManager().sendInput({
      workspaceId: terminal.workspaceId,
      terminalId: normalizedString(params.terminalId),
      data: params.data,
    });
    return terminalSessionPayload(session);
  }

  async signalTerminalSession(params: RuntimeAgentToolsSignalTerminalSessionParams): Promise<JsonObject> {
    const terminal = this.requireTerminalSession({
      terminalId: params.terminalId,
      workspaceId: normalizedString(params.workspaceId),
    });
    const session = await this.requireTerminalSessionManager().signal({
      workspaceId: terminal.workspaceId,
      terminalId: normalizedString(params.terminalId),
      signal: normalizedString(params.signal) || null,
    });
    return terminalSessionPayload(session);
  }

  async closeTerminalSession(params: RuntimeAgentToolsCloseTerminalSessionParams): Promise<JsonObject> {
    const terminal = this.requireTerminalSession({
      terminalId: params.terminalId,
      workspaceId: normalizedString(params.workspaceId),
    });
    const session = await this.requireTerminalSessionManager().closeSession({
      workspaceId: terminal.workspaceId,
      terminalId: normalizedString(params.terminalId),
    });
    return terminalSessionPayload(session);
  }

  private requireSubagentControllerSession(workspaceId: string, sessionId: string): AgentSessionRecord {
    const normalizedSessionId = normalizedString(sessionId);
    if (!normalizedSessionId) {
      throw new RuntimeAgentToolsServiceError(400, "session_id_required", "session_id is required");
    }
    const session = this.store.getSession({ workspaceId, sessionId: normalizedSessionId });
    if (!session) {
      throw new RuntimeAgentToolsServiceError(404, "session_not_found", "session not found");
    }
    const kind = normalizedString(session.kind);
    if (kind === "subagent" || kind === "task_proposal" || kind === "cronjob") {
      throw new RuntimeAgentToolsServiceError(
        403,
        "subagent_control_forbidden",
        "only a main conversational session can delegate or control background tasks",
      );
    }
    return session;
  }

  private requireSubagentRun(params: {
    workspaceId: string;
    subagentId: string;
  }): SubagentRunRecord {
    const subagentId = normalizedString(params.subagentId);
    if (!subagentId) {
      throw new RuntimeAgentToolsServiceError(400, "subagent_id_required", "subagent_id is required");
    }
    const run = this.store.getSubagentRun({ workspaceId: params.workspaceId, subagentId });
    if (!run) {
      throw new RuntimeAgentToolsServiceError(404, "subagent_not_found", "subagent not found");
    }
    return run;
  }

  private syncSubagentRunForOwner(params: {
    workspaceId: string;
    subagentId: string;
    ownerMainSessionId?: string | null;
  }): SyncedSubagentRunState {
    let run = this.requireSubagentRun({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
    });
    const ownerMainSessionId = normalizedString(params.ownerMainSessionId);
    if (ownerMainSessionId && run.ownerMainSessionId !== ownerMainSessionId) {
      run =
        this.store.transferSubagentOwnership({
          workspaceId: params.workspaceId,
          subagentId: run.subagentId,
          ownerMainSessionId,
        }) ?? run;
    }
    return this.syncSubagentRunState(run);
  }

  private syncSubagentRunState(run: SubagentRunRecord): SyncedSubagentRunState {
    const runtimeState = this.store.getRuntimeState({
      workspaceId: run.workspaceId,
      sessionId: run.childSessionId,
    });
    const currentInputId =
      normalizedString(runtimeState?.currentInputId) ||
      normalizedString(run.currentChildInputId) ||
      normalizedString(run.latestChildInputId) ||
      normalizedString(run.initialChildInputId);
    const latestInputId =
      normalizedString(run.latestChildInputId) ||
      currentInputId ||
      normalizedString(run.initialChildInputId);
    const workspaceId = run.workspaceId;
    const currentInput = currentInputId
      ? this.store.getInput({
          workspaceId,
          inputId: currentInputId,
        })
      : null;
    const latestInput = latestInputId
      ? this.store.getInput({
          workspaceId,
          inputId: latestInputId,
        })
      : null;
    const latestTurnResult = latestInputId
      ? this.store.getTurnResult({
          workspaceId: run.workspaceId,
          inputId: latestInputId,
        })
      : null;

    const runtimeStatus = normalizedString(runtimeState?.status).toUpperCase();
    const currentInputStatus = normalizedString(currentInput?.status).toUpperCase();
    const hasWaitingBlocker = subagentRunHasWaitingBlocker(run);

    let derivedStatus = run.status;
    if (run.cancelledAt || normalizedString(run.status) === "cancelled") {
      derivedStatus = "cancelled";
    } else if (currentInputStatus === "CLAIMED" || runtimeStatus === "BUSY") {
      derivedStatus = "running";
    } else if (currentInputStatus === "QUEUED" || runtimeStatus === "QUEUED") {
      derivedStatus = "queued";
    } else if (latestTurnResult?.status === "waiting_user" || runtimeState?.status === "WAITING_USER") {
      derivedStatus = "waiting_on_user";
    } else if (normalizedString(run.status) === "waiting_on_user" || hasWaitingBlocker) {
      derivedStatus = "waiting_on_user";
    } else if (latestTurnResult?.status === "failed" || runtimeState?.status === "ERROR") {
      derivedStatus = "failed";
    } else if (latestTurnResult?.status === "completed") {
      derivedStatus = "completed";
    }

    const summaryFromTurn = normalizedString(latestTurnResult?.assistantText);
    const updates: Parameters<RuntimeStateStore["updateSubagentRun"]>[0]["fields"] = {};
    if (run.status !== derivedStatus) {
      updates.status = derivedStatus;
    }
    if (currentInputId && run.currentChildInputId !== currentInputId) {
      updates.currentChildInputId = currentInputId;
    }
    if (latestInputId && run.latestChildInputId !== latestInputId) {
      updates.latestChildInputId = latestInputId;
    }
    if (!run.startedAt && currentInput?.createdAt && ["queued", "running"].includes(derivedStatus)) {
      updates.startedAt = currentInput.createdAt;
    }
    if (run.latestProgressPayload) {
      updates.latestProgressPayload = null;
    }
    if (
      derivedStatus === "completed" &&
      latestTurnResult &&
      (!run.completedAt || !run.resultPayload || !run.summary)
    ) {
      updates.completedAt = run.completedAt ?? latestTurnResult.completedAt ?? utcNowIso();
      updates.summary = run.summary ?? summaryFromTurn ?? "Completed.";
      updates.resultPayload = run.resultPayload ?? {
        assistant_text: latestTurnResult.assistantText,
        turn_status: latestTurnResult.status,
        stop_reason: latestTurnResult.stopReason,
      };
      updates.lastEventAt = latestTurnResult.completedAt ?? latestTurnResult.updatedAt;
    } else if (
      derivedStatus === "failed" &&
      latestTurnResult &&
      (!run.completedAt || !run.errorPayload || !run.summary)
    ) {
      updates.completedAt = run.completedAt ?? latestTurnResult.completedAt ?? utcNowIso();
      updates.summary = run.summary ?? summaryFromTurn ?? "Failed.";
      updates.errorPayload = run.errorPayload ?? {
        assistant_text: latestTurnResult.assistantText,
        turn_status: latestTurnResult.status,
        stop_reason: latestTurnResult.stopReason,
      };
      updates.lastEventAt = latestTurnResult.completedAt ?? latestTurnResult.updatedAt;
    } else if (
      derivedStatus === "waiting_on_user" &&
      latestTurnResult &&
      (!run.blockingPayload || !run.summary)
    ) {
      updates.summary = run.summary ?? summaryFromTurn ?? "Waiting on user input.";
      updates.blockingPayload = run.blockingPayload ?? {
        assistant_text: latestTurnResult.assistantText,
        turn_status: latestTurnResult.status,
        stop_reason: latestTurnResult.stopReason,
      };
      updates.lastEventAt = latestTurnResult.completedAt ?? latestTurnResult.updatedAt;
    }
    if (derivedStatus === "waiting_on_user") {
      if (run.completedAt) {
        updates.completedAt = null;
      }
      if (run.resultPayload) {
        updates.resultPayload = null;
      }
      if (run.errorPayload) {
        updates.errorPayload = null;
      }
    }

    const syncedRun =
      Object.keys(updates).length > 0
        ? (this.store.updateSubagentRun({
            workspaceId: run.workspaceId,
            subagentId: run.subagentId,
            fields: updates,
          }) ?? run)
        : run;
    return {
      run: syncedRun,
      runtimeState,
      currentInput,
      latestInput,
      latestTurnResult,
    };
  }

  private isSubagentCancellationSettled(state: SyncedSubagentRunState): boolean {
    const runtimeStatus = normalizedString(state.runtimeState?.status)?.toUpperCase() ?? "";
    const currentInputStatus = normalizedString(state.currentInput?.status)?.toUpperCase() ?? "";
    if (runtimeStatus === "BUSY" || runtimeStatus === "QUEUED") {
      return false;
    }
    if (currentInputStatus === "CLAIMED" || currentInputStatus === "QUEUED") {
      return false;
    }
    return true;
  }

  private async waitForSubagentCancellationSettlement(params: {
    workspaceId: string;
    subagentId: string;
    ownerMainSessionId: string;
  }): Promise<SyncedSubagentRunState> {
    const deadline = Date.now() + SUBAGENT_CANCEL_SETTLE_TIMEOUT_MS;
    while (true) {
      const state = this.syncSubagentRunForOwner(params);
      if (this.isSubagentCancellationSettled(state)) {
        return state;
      }
      if (Date.now() >= deadline) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "subagent_cancel_settling",
          "subagent cancellation is still settling; try again shortly",
        );
      }
      await sleep(SUBAGENT_CANCEL_SETTLE_POLL_INTERVAL_MS);
    }
  }

  private assertSameTurnDelegationPollingAllowed(params: {
    workspaceId: string;
    sessionId?: string | null;
    inputId?: string | null;
    states: SyncedSubagentRunState[];
    toolId: "holaboss_get_subagent" | "holaboss_list_background_tasks";
  }): void {
    const sessionId = normalizedString(params.sessionId);
    const inputId = normalizedString(params.inputId);
    if (!sessionId || !inputId || params.states.length === 0) {
      return;
    }
    const blockingStates = params.states.filter((state) =>
      state.run.workspaceId === params.workspaceId &&
      state.run.parentSessionId === sessionId &&
      state.run.parentInputId === inputId &&
      ["queued", "running"].includes(state.run.status),
    );
    if (blockingStates.length === 0) {
      return;
    }
    throw new RuntimeAgentToolsServiceError(
      409,
      "same_turn_subagent_poll_forbidden",
      `do not use ${params.toolId} to poll a freshly delegated task in the same turn while it is still running; return control to the user and let the background task continue`,
    );
  }

  private isVisibleBackgroundTask(run: SubagentRunRecord): boolean {
    const childSession = this.store.getSession({
      workspaceId: run.workspaceId,
      sessionId: run.childSessionId,
    });
    return !childSession?.archivedAt;
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new RuntimeAgentToolsServiceError(404, "workspace_not_found", "workspace not found");
    }
    return workspace;
  }

  private requireWorkspaceId(workspaceId?: string | null): string {
    const normalized = normalizedString(workspaceId);
    if (!normalized) {
      throw new RuntimeAgentToolsServiceError(400, "workspace_id_required", "workspace_id is required");
    }
    return normalized;
  }

  private requireCronjob(params: { workspaceId?: string | null; jobId: string }): CronjobRecord {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const job = this.store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!job) {
      throw new RuntimeAgentToolsServiceError(404, "cronjob_not_found", "cronjob not found");
    }
    return job;
  }

  private assertCronjobBelongsToWorkspace(job: CronjobRecord, workspaceId?: string | null): void {
    const expectedWorkspaceId = normalizedString(workspaceId);
    if (expectedWorkspaceId && job.workspaceId !== expectedWorkspaceId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "cronjob_workspace_mismatch",
        "requested cronjob does not belong to this workspace"
      );
    }
  }

  private requireTerminalSessionManager(): TerminalSessionManagerLike {
    const manager = this.options.terminalSessionManager;
    if (!manager) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "terminal_sessions_unavailable",
        "terminal sessions are not available in this runtime",
      );
    }
    return manager;
  }

  private requireTerminalSession(params: {
    terminalId: string;
    workspaceId: string;
  }): TerminalSessionRecord {
    const terminalId = normalizedString(params.terminalId);
    if (!terminalId) {
      throw new RuntimeAgentToolsServiceError(400, "terminal_session_id_required", "terminal_id is required");
    }
    const workspaceId = normalizedString(params.workspaceId);
    if (!workspaceId) {
      throw new RuntimeAgentToolsServiceError(400, "workspace_id_required", "workspace_id is required");
    }
    const terminal = this.requireTerminalSessionManager().getSession({
      terminalId,
      workspaceId,
    });
    if (!terminal) {
      throw new RuntimeAgentToolsServiceError(404, "terminal_session_not_found", "terminal session not found");
    }
    return terminal;
  }

  // Introspects the workspace's shared SQLite (data.db) and returns the
  // tables module apps have created. Used by `create_dashboard` (or by
  // an agent composing one) to know what columns can be selected and
  // how many rows each table holds. Read-only — opens the file with
  // PRAGMA query_only and closes it before returning.
  listDataTables(params: RuntimeAgentToolsListDataTablesParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    // The shared data.db is a workspace-level resource, not an app's
    // file. Eagerly create it if a module app hasn't yet — otherwise
    // this tool gives the agent a misleading "no data exists" view
    // even on healthy workspaces where apps simply haven't called
    // their getDb() yet.
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      const includeSystem = Boolean(params.includeSystem);
      const out: JsonObject[] = [];
      let hiddenSystemCount = 0;
      for (const { name } of tables) {
        if (isRuntimeInternalTable(name)) continue;
        if (!includeSystem && isSystemTable(name)) {
          hiddenSystemCount += 1;
          continue;
        }
        const cols = db
          .prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)
          .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
        const rowCountRow = db
          .prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`)
          .get() as { c: number };
        out.push({
          name,
          columns: cols.map((c) => ({
            name: c.name,
            type: c.type,
            not_null: Boolean(c.notnull),
            primary_key: Boolean(c.pk),
          })),
          row_count: rowCountRow.c,
        });
      }
      const result: JsonObject = { tables: out, count: out.length };
      if (hiddenSystemCount > 0) {
        result.hidden_system_count = hiddenSystemCount;
        result.note =
          `${hiddenSystemCount} app-internal table(s) hidden (queues, scheduler logs, api usage, settings). ` +
          "Pass include_system=true if you genuinely need them — they aren't typically useful for user-facing dashboards.";
      }
      return result;
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        500,
        "list_data_tables_failed",
        error instanceof Error ? error.message : "Failed to introspect data.db",
      );
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      }
    }
  }

  createDataTable(params: RuntimeAgentToolsCreateDataTableParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const tableName = sanitizeUserDataTableName(params.name);
    const columns = validateDataTableColumns(params.columns);
    const rows = normalizeDataTableRows(params.rows ?? [], columns);
    const replaceExisting = params.replaceExisting === true;
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");

      const exists = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
          )
          .get(tableName),
      );
      if (exists && !replaceExisting) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "data_table_exists",
          `table "${tableName}" already exists; pass replace_existing=true to recreate it`,
        );
      }

      const insertSql = buildInsertUserDataTableSql(tableName, columns);
      const createSql = buildCreateUserDataTableSql(tableName, columns);
      const txn = db.transaction(() => {
        if (exists && replaceExisting) {
          db!.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`);
        }
        db!.exec(createSql);
        if (rows.length > 0) {
          const insert = db!.prepare(insertSql);
          for (const row of rows) {
            insert.run(
              ...columns.map((column) => sqliteInsertValue(row[column.name] ?? null)),
            );
          }
        }
      });
      txn();

      return {
        table_name: tableName,
        row_count: rows.length,
        column_count: columns.length,
        replaced_existing: exists && replaceExisting,
        db_path: ".holaboss/state/data.db",
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        throw error;
      }
      throw new RuntimeAgentToolsServiceError(
        500,
        "create_data_table_failed",
        error instanceof Error ? error.message : "Failed to create data table",
      );
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Authors a `.dashboard` file under workspace/<id>/files/dashboards/.
  // Each panel's SQL is dry-run against data.db (LIMIT 0) before the
  // file is written, so a parse / column / table error surfaces to the
  // agent immediately instead of leaving a broken file behind.
  async createDashboard(
    params: RuntimeAgentToolsCreateDashboardParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const name = sanitizeDashboardFileName(params.name);
    const title = String(params.title ?? "").trim();
    if (!title) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "dashboard_title_required",
        "title is required",
      );
    }
    if (!Array.isArray(params.panels) || params.panels.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "dashboard_panels_required",
        "panels must be a non-empty array",
      );
    }

    // ensureWorkspaceDataDb() creates the file with WAL + _workspace_meta
    // if it doesn't exist. The dashboard's panel queries will validate
    // (and fail loudly) below if they reference tables the user hasn't
    // populated yet — but the workspace-level resource itself always
    // exists, so the agent can build dashboards before any app starts.
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );

    const yamlPanels: unknown[] = [];
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      params.panels.forEach((panel, index) => {
        validatePanelInput(panel, index);
        try {
          // LIMIT 0 — verifies the SQL parses and column names resolve
          // without paying the cost of returning rows.
          db!.prepare(`SELECT * FROM (${panel.query}) LIMIT 0`).all();
        } catch (err) {
          throw new RuntimeAgentToolsServiceError(
            400,
            "dashboard_panel_query_invalid",
            `panel #${index + 1} (${panel.title}): SQL did not validate — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        yamlPanels.push(serializePanel(panel));
      });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      }
    }

    const yamlDoc: Record<string, unknown> = { title };
    if (params.description && params.description.trim()) {
      yamlDoc.description = params.description.trim();
    }
    yamlDoc.panels = yamlPanels;
    const content = yaml.dump(yamlDoc, { lineWidth: 120, noRefs: true });

    const targetDir = path.join(
      this.options.workspaceRoot,
      params.workspaceId,
      "files",
      "dashboards",
    );
    const targetFile = path.join(targetDir, `${name}.dashboard`);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetFile, content, "utf8");

    const relativePath = path.posix.join(
      "files",
      "dashboards",
      `${name}.dashboard`,
    );
    return {
      file_path: relativePath,
      absolute_path: targetFile,
      panel_count: params.panels.length,
      title,
    };
  }
}

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const DATA_TABLE_COLUMN_TYPES = new Set([
  "TEXT",
  "INTEGER",
  "REAL",
  "NUMERIC",
  "BLOB",
]);
type ValidatedDataTableColumn = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
};

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function sanitizeSqlIdentifier(params: {
  raw: string;
  fieldLabel: string;
  requiredCode: string;
  invalidCode: string;
}): string {
  const value = String(params.raw ?? "").trim();
  if (!value) {
    throw new RuntimeAgentToolsServiceError(
      400,
      params.requiredCode,
      `${params.fieldLabel} is required`,
    );
  }
  if (
    !SQL_IDENTIFIER_PATTERN.test(value) ||
    value.length > 80 ||
    value.toLowerCase().startsWith("sqlite_") ||
    value.startsWith("_")
  ) {
    throw new RuntimeAgentToolsServiceError(
      400,
      params.invalidCode,
      `${params.fieldLabel} must be a short SQL identifier using letters, digits, and underscores, and may not start with "_" or "sqlite_"`,
    );
  }
  return value;
}

function sanitizeUserDataTableName(raw: string): string {
  return sanitizeSqlIdentifier({
    raw,
    fieldLabel: "table name",
    requiredCode: "data_table_name_required",
    invalidCode: "data_table_name_invalid",
  });
}

function validateDataTableColumns(
  rawColumns: DataTableColumnInput[],
): ValidatedDataTableColumn[] {
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "data_table_columns_required",
      "columns must be a non-empty array",
    );
  }

  const seen = new Set<string>();
  let primaryKeyCount = 0;
  const columns = rawColumns.map((column, index) => {
    if (!column || typeof column !== "object") {
      throw new RuntimeAgentToolsServiceError(
        400,
        "data_table_column_invalid",
        `column #${index + 1} must be an object`,
      );
    }
    const name = sanitizeSqlIdentifier({
      raw: String(column.name ?? ""),
      fieldLabel: `column #${index + 1} name`,
      requiredCode: "data_table_column_name_required",
      invalidCode: "data_table_column_name_invalid",
    });
    const loweredName = name.toLowerCase();
    if (seen.has(loweredName)) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "data_table_column_name_invalid",
        `column name "${name}" is duplicated`,
      );
    }
    seen.add(loweredName);

    const type = String(column.type ?? "").trim().toUpperCase();
    if (!DATA_TABLE_COLUMN_TYPES.has(type)) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "data_table_column_type_invalid",
        `column "${name}" type must be one of ${Array.from(DATA_TABLE_COLUMN_TYPES).join(", ")}`,
      );
    }
    const primaryKey = column.primary_key === true;
    if (primaryKey) {
      primaryKeyCount += 1;
    }
    return {
      name,
      type,
      notNull: column.not_null === true,
      primaryKey,
    };
  });

  if (primaryKeyCount > 1) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "data_table_primary_key_invalid",
      "only one primary_key column is supported",
    );
  }
  return columns;
}

function normalizeDataTableRows(
  rawRows: Array<Record<string, unknown>>,
  columns: ValidatedDataTableColumn[],
): Array<Record<string, string | number | boolean | null>> {
  if (!Array.isArray(rawRows)) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "data_table_rows_invalid",
      "rows must be an array when provided",
    );
  }

  const allowedColumns = new Set(columns.map((column) => column.name));
  return rawRows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "data_table_rows_invalid",
        `row #${index + 1} must be an object`,
      );
    }

    for (const key of Object.keys(row)) {
      if (!allowedColumns.has(key)) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "data_table_rows_invalid",
          `row #${index + 1} contains unknown column "${key}"`,
        );
      }
    }

    const normalized: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      const hasValue = Object.prototype.hasOwnProperty.call(row, column.name);
      const value = hasValue ? row[column.name] : null;
      if (value === null || value === undefined) {
        if (column.notNull || column.primaryKey) {
          throw new RuntimeAgentToolsServiceError(
            400,
            "data_table_rows_invalid",
            `row #${index + 1} is missing required value for column "${column.name}"`,
          );
        }
        normalized[column.name] = null;
        continue;
      }
      if (typeof value === "string") {
        normalized[column.name] = value;
        continue;
      }
      if (typeof value === "boolean") {
        normalized[column.name] = value;
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        normalized[column.name] = value;
        continue;
      }
      throw new RuntimeAgentToolsServiceError(
        400,
        "data_table_rows_invalid",
        `row #${index + 1}, column "${column.name}" must be a string, number, boolean, or null`,
      );
    }
    return normalized;
  });
}

function buildCreateUserDataTableSql(
  tableName: string,
  columns: ValidatedDataTableColumn[],
): string {
  const columnSql = columns.map((column) =>
    [
      quoteSqlIdentifier(column.name),
      column.type,
      column.primaryKey ? "PRIMARY KEY" : "",
      column.notNull ? "NOT NULL" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return `CREATE TABLE ${quoteSqlIdentifier(tableName)} (${columnSql.join(", ")})`;
}

function buildInsertUserDataTableSql(
  tableName: string,
  columns: ValidatedDataTableColumn[],
): string {
  return `INSERT INTO ${quoteSqlIdentifier(tableName)} (${columns
    .map((column) => quoteSqlIdentifier(column.name))
    .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
}

function sqliteInsertValue(value: string | number | boolean | null): string | number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

const DASHBOARD_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function sanitizeDashboardFileName(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "dashboard_name_required",
      "name is required",
    );
  }
  // The agent passes the bare slug; we add the `.dashboard` extension.
  const stripped = value.endsWith(".dashboard")
    ? value.slice(0, -".dashboard".length)
    : value;
  if (!DASHBOARD_NAME_PATTERN.test(stripped) || stripped.length > 80) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "dashboard_name_invalid",
      "name must be a short slug — letters, digits, dot, underscore, or hyphen.",
    );
  }
  return stripped;
}

function validatePanelInput(panel: unknown, index: number): asserts panel is DashboardPanelInput {
  if (!panel || typeof panel !== "object") {
    throw new RuntimeAgentToolsServiceError(
      400,
      "dashboard_panel_invalid",
      `panel #${index + 1}: must be an object`,
    );
  }
  const p = panel as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (!title) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "dashboard_panel_title_required",
      `panel #${index + 1}: title is required`,
    );
  }
  if (!query) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "dashboard_panel_query_required",
      `panel #${index + 1}: query is required`,
    );
  }
  if (type === "kpi") {
    return;
  }
  if (type === "data_view") {
    const views = Array.isArray(p.views) ? p.views : [];
    if (views.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "dashboard_panel_views_required",
        `panel #${index + 1}: data_view requires at least one entry in \`views\``,
      );
    }
    views.forEach((rawView, vIdx) => {
      if (!rawView || typeof rawView !== "object") {
        throw new RuntimeAgentToolsServiceError(
          400,
          "dashboard_panel_view_invalid",
          `panel #${index + 1}, view #${vIdx + 1}: must be an object`,
        );
      }
      const v = rawView as Record<string, unknown>;
      if (v.type === "table") {
        if (
          v.columns !== undefined &&
          (!Array.isArray(v.columns) ||
            v.columns.some((c) => typeof c !== "string"))
        ) {
          throw new RuntimeAgentToolsServiceError(
            400,
            "dashboard_panel_view_invalid",
            `panel #${index + 1}, view #${vIdx + 1}: \`columns\` must be a list of strings`,
          );
        }
        return;
      }
      if (v.type === "board") {
        if (typeof v.group_by !== "string" || !v.group_by.trim()) {
          throw new RuntimeAgentToolsServiceError(
            400,
            "dashboard_panel_view_invalid",
            `panel #${index + 1}, view #${vIdx + 1}: board view requires \`group_by\``,
          );
        }
        if (typeof v.card_title !== "string" || !v.card_title.trim()) {
          throw new RuntimeAgentToolsServiceError(
            400,
            "dashboard_panel_view_invalid",
            `panel #${index + 1}, view #${vIdx + 1}: board view requires \`card_title\``,
          );
        }
        return;
      }
      throw new RuntimeAgentToolsServiceError(
        400,
        "dashboard_panel_view_invalid",
        `panel #${index + 1}, view #${vIdx + 1}: unknown \`type\` "${String(v.type)}". Expected "table" or "board".`,
      );
    });
    return;
  }
  throw new RuntimeAgentToolsServiceError(
    400,
    "dashboard_panel_type_invalid",
    `panel #${index + 1}: unknown \`type\` "${type}". Expected "kpi" or "data_view".`,
  );
}

function serializePanel(panel: DashboardPanelInput): Record<string, unknown> {
  if (panel.type === "kpi") {
    return { type: "kpi", title: panel.title.trim(), query: panel.query };
  }
  const views: Record<string, unknown>[] = panel.views.map((view) => {
    if (view.type === "table") {
      const out: Record<string, unknown> = { type: "table" };
      if (view.columns && view.columns.length > 0) out.columns = view.columns;
      return out;
    }
    const out: Record<string, unknown> = {
      type: "board",
      group_by: view.group_by,
      card_title: view.card_title,
    };
    if (view.card_subtitle && String(view.card_subtitle).trim()) {
      out.card_subtitle = String(view.card_subtitle).trim();
    }
    return out;
  });
  const out: Record<string, unknown> = {
    type: "data_view",
    title: panel.title.trim(),
    query: panel.query,
    views,
  };
  if (panel.default_view) out.default_view = panel.default_view;
  return out;
}
