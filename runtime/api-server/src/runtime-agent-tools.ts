import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import Database from "better-sqlite3";
import yaml from "js-yaml";

import {
  type AgentSessionRecord,
  type AppBuildRecord,
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
import { buildAppSetupEnv } from "./app-setup-env.js";
import { cronjobNextRunAt } from "./cron-worker.js";
import { ensureWorkspaceDataDb } from "./ts-runner-session-state.js";
import { generateWorkspaceImage } from "./image-generation.js";
import { searchPublicWeb } from "./native-web-search.js";
import { killChildProcess, spawnShellCommand } from "./runtime-shell.js";
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
import { retrieveWorkspaceMemory, type WorkspaceMemoryCategory } from "./workspace-memory.js";
import type { ComposioMcpManager } from "./composio-mcp-manager.js";
import { getStoreCatalogEntry } from "./integration-store-catalog.js";
import { invokeWorkspaceSkill, resolveWorkspaceSkills } from "./workspace-skills.js";
import {
  listWorkspaceApplicationPorts,
  listWorkspaceApplications,
  parseInstalledAppRuntime,
  parseResolvedAppRuntime,
  readWorkspaceMcpRegistryServerNames,
  resolveWorkspaceAppRuntime,
  updateWorkspaceApplications,
} from "./workspace-apps.js";
import {
  INTEGRATION_CATALOG_PROVIDERS,
  integrationCatalogProviderIds,
} from "./integration-catalog.js";
import {
  findForbiddenUpstreamHosts,
  formatHostLintError,
} from "./workspace-app-host-lint.js";
import {
  dashboardUiLintViolations,
  formatDashboardUiLintError,
  inspectDashboardUiUsage,
} from "./workspace-app-ui-lint.js";
const SESSION_REFRESH_NOTE =
  "New MCP servers became available in this turn. Their tools will be visible to you starting from the next user message — please end this turn (do not call the new tools yet) and let the user trigger the next one.";

function buildSessionRefreshFields(newMcpServers: string[]): JsonObject {
  if (newMcpServers.length === 0) {
    return {};
  }
  return {
    requires_session_refresh: true,
    new_mcp_servers: [...newMcpServers],
    session_refresh_note: SESSION_REFRESH_NOTE,
  };
}

/**
 * Build the auto-queued post-build polish-pass prompt for a dashboard
 * app. The wording is deliberately concrete on three operational points
 * where every past failed session went off-path:
 *
 *   - Whole-file `bash cat > file <<'EOF'` rewrites, not `edit` calls.
 *     The single successful polish session in the corpus used heredocs
 *     for both main.tsx and styles.css. Every other "polish" turn that
 *     used `edit` did 1-2 trivial changes and declared done.
 *   - Re-run build + restart + verify with `browser_screenshot` (not
 *     just `curl`). The screenshot is the visual feedback loop; without
 *     it the agent can't tell whether the rules actually landed.
 *   - "A clean tool-call ceremony without visible visual improvement
 *     fails this pass." Closes the checkbox-compliance loophole.
 *
 * Deliberately omits any concrete visual rules (KPI layout, typography
 * sizes, density numbers). Earlier versions of this prompt named the
 * exact anti-patterns ("no full-width stacked KPI cards", "no text-2xl")
 * to warn against them; observed output then reliably reproduced those
 * patterns — naming the failure mode anchored the agent on it. Visual
 * authority belongs entirely to `interface-design` content; the prompt
 * stays purely operational.
 */
function buildPolishPassPrompt(appId: string): string {
  return [
    "[Auto-queued post-build polish pass]",
    "",
    `The dashboard app \`${appId}\` was just confirmed running in this workspace. Before continuing with anything else, perform a design polish pass on its src/client/.`,
    "",
    "1. Invoke `skill({ name: \"interface-design\" })` to load the design rules. Read its full output, including any `.interface-design/system.md` artifact it writes to disk.",
    "",
    "1.5. Spatial composition sketch. BEFORE any heredoc rewrite, write a plain-text spatial sketch as a comment block at the top of the main route/component file. Answer each question with SPECIFIC field/section names from this app's data model — vague answers (\"the KPI row\", \"the user lands on the main area\") do not satisfy this step. The JSX you write in step 2 MUST implement what the sketch describes.",
    "    - What are the 3–5 distinct information regions on this dashboard? Name them by content (\"open work counts split by relation\"), not by visual (\"the metrics strip\").",
    "    - Which two regions belong side-by-side because they answer related questions? Why?",
    "    - What lives above the fold on a 1280×800 viewport? Why specifically those things and not the others?",
    "    - Which group of items is similar enough to compress into a horizontal strip in ONE row (3–6 metrics)? Vs. which groups deserve vertical separation because they're conceptually distinct?",
    "    - Where does the user's eye land first, and what is the one action you want them to take from that landing spot?",
    "    The screenshot taken in step 4 will be compared against this sketch. If the sketch says \"3 KPIs in a horizontal strip\" and the rendered output stacks them vertically, the pass fails.",
    "",
    `2. For each \`.tsx\` and \`.css\` file under \`apps/${appId}/src/client/\`: REWRITE the whole file using \`bash\` heredoc syntax (\`cat > path/to/file <<'EOF' ... EOF\`), NOT via \`edit\`. Whole-file rewrite is the explicit mode for this pass — incremental \`edit\` calls have repeatedly produced checkbox-compliant no-changes. Apply the \`interface-design\` skill's rules end-to-end AND implement the spatial sketch from step 1.5. Note: the design system clamps any \`font-bold\` / \`font-semibold\` / \`font-extrabold\` / \`font-black\` to 500 at render time, so do not rely on those classes for emphasis.`,
    "",
    `3. Re-run \`workspace_apps_build\` + \`workspace_apps_restart_and_wait_ready\` for \`${appId}\`.`,
    "",
    "4. Verify with `browser_screenshot`. Look at the rendered output and compare it line-by-line against the spatial sketch you wrote in step 1.5 AND the `interface-design` rules you loaded. If the screenshot doesn't match either, return to step 2 and rewrite again. Two iterations is normal.",
    "",
    "5. Only after the screenshot matches the sketch AND the interface-design rules, declare the polish pass done.",
    "",
    "The user is the one who will see the rendered UI. A clean tool-call ceremony without visible visual improvement fails this pass — there is no half-credit for invoking the skill, doing trivial edits, and reporting 'looks good'.",
  ].join("\n");
}

/** Returns true when an app dir contains a `src/client/` subdirectory,
 *  i.e. it ships a dashboard UI (vs. an integration-only MCP module). */
function appIsDashboardShape(workspaceDir: string, appId: string): boolean {
  const clientDir = path.join(workspaceDir, "apps", appId, "src", "client");
  try {
    return statSync(clientDir).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the user-facing main session to route the polish input at.
 *  If `callerSessionId` is a delegated subagent, use its owner main
 *  session so the polish turn shows up in the chat the user is
 *  watching; if it's already a main session, route to it directly. */
function resolvePolishTargetSession(
  store: RuntimeStateStore,
  workspaceId: string,
  callerSessionId: string,
): string {
  try {
    const run = store.getSubagentRunByChildSession({
      workspaceId,
      childSessionId: callerSessionId,
    });
    if (run?.ownerMainSessionId) return run.ownerMainSessionId;
  } catch {
    // store lookup is best-effort; fall through to caller session.
  }
  return callerSessionId;
}

function pendingIntegrationsFromAppManifests(params: {
  workspaceDir: string;
  appIds: string[];
  store?: RuntimeStateStore;
  workspaceId?: string;
}): JsonObject[] {
  const boundKeys = new Set<string>();
  if (params.store && params.workspaceId) {
    for (const binding of params.store.listIntegrationBindings({
      workspaceId: params.workspaceId,
    })) {
      if (binding.targetType !== "app") continue;
      boundKeys.add(
        `${binding.targetId.toLowerCase()}|${binding.integrationKey.toLowerCase()}`,
      );
    }
  }
  const seen = new Set<string>();
  const out: JsonObject[] = [];
  for (const appId of params.appIds) {
    const manifestPath = path.join(params.workspaceDir, "apps", appId, "app.runtime.yaml");
    if (!existsSync(manifestPath)) continue;
    let parsed;
    try {
      parsed = parseResolvedAppRuntime(
        readFileSync(manifestPath, "utf8"),
        appId,
        `apps/${appId}/app.runtime.yaml`,
      );
    } catch {
      continue;
    }
    for (const integration of parsed.integrations ?? []) {
      if (!integration.required) continue;
      const providerLower = integration.provider.toLowerCase();
      if (boundKeys.has(`${appId.toLowerCase()}|${providerLower}`)) continue;
      const key = `${appId}|${providerLower}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Count active connections for this provider so the agent can tell
      // "user needs to OAuth-connect (zero accounts)" apart from
      // "user already has accounts, app just needs binding (chat UI
      // handles the picker)". Without this the agent calls
      // propose_connect even when the user has authorized accounts,
      // and the user sees a duplicate Connect card next to the
      // auto-rendered binding picker.
      let availableAccounts = 0;
      if (params.store) {
        try {
          availableAccounts = params.store
            .listIntegrationConnections({ providerId: integration.provider })
            .filter((conn) => conn.status.trim().toLowerCase() === "active")
            .length;
        } catch {
          availableAccounts = 0;
        }
      }
      out.push({
        app_id: appId,
        provider_id: integration.provider,
        credential_source: integration.credentialSource,
        available_accounts: availableAccounts,
        // Forward the per-yaml whoami config (if any) so the chat UI can
        // pass it to Hono's /composio/connect — removes the need for the
        // central PROVIDER_WHOAMI constant in the Hono worker.
        ...(integration.whoami
          ? { whoami: integration.whoami as unknown as JsonValue }
          : {}),
      });
    }
  }
  return out;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const SUBAGENT_CANCEL_SETTLE_TIMEOUT_MS = 8_000;
const SUBAGENT_CANCEL_SETTLE_POLL_INTERVAL_MS = 50;
const WORKSPACE_APP_BUILD_TIMEOUT_MS = 180_000;
const WORKSPACE_APP_PROBE_TIMEOUT_MS = 5_000;
const WORKSPACE_DATA_QUERY_DEFAULT_LIMIT = 100;
const WORKSPACE_DATA_QUERY_MAX_LIMIT = 500;
const WORKSPACE_DATA_QUERY_MAX_OFFSET = 10_000;
const WORKSPACE_DATA_QUERY_DEFAULT_TIMEOUT_MS = 2_000;
const WORKSPACE_DATA_QUERY_MAX_TIMEOUT_MS = 10_000;
const WORKSPACE_APP_ENDPOINT_PROBE_CHECKS = [
  "ui",
  "mcp_health",
  "mcp_initialize",
  "mcp_tools_list",
] as const;
const REPORT_FILE_EXTENSION = ".html";
const REPORT_MIME_TYPE = "text/html";
export const ONBOARDING_ALIGNMENT_STATE = "aligning";
export const ONBOARDING_AWAITING_ALIGNMENT_APPROVAL_STATE =
  "awaiting_alignment_approval";
export const ONBOARDING_IMPLEMENTING_STATE = "implementing";
export const ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE =
  "awaiting_verification_acceptance";
export const ONBOARDING_COMPLETED_STATE = "completed";
export const ONBOARDING_ABANDONED_STATE = "abandoned";
export const ONBOARDING_WORKFLOW_STATES = new Set<string>([
  ONBOARDING_ALIGNMENT_STATE,
  ONBOARDING_AWAITING_ALIGNMENT_APPROVAL_STATE,
  ONBOARDING_IMPLEMENTING_STATE,
  ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE,
  ONBOARDING_COMPLETED_STATE,
  ONBOARDING_ABANDONED_STATE,
]);

type WorkspaceAppEndpointProbeCheck = (typeof WORKSPACE_APP_ENDPOINT_PROBE_CHECKS)[number];

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

interface RuntimeAgentToolAppLifecycleCallbacks {
  ensureAppRunning?: ((workspaceId: string, appId: string) => Promise<void>) | null;
  ensureAllAppsRunning?: ((workspaceId: string) => Promise<unknown>) | null;
  stopApp?: ((workspaceId: string, appId: string) => Promise<unknown>) | null;
  /**
   * Install an app archive (download + extract + register + start). Provided
   * by app.ts which delegates to the existing /api/v1/apps/install-archive
   * pipeline. Returning ok:false propagates the runtime error to the agent
   * tool result so the model can retry or surface the failure to the user.
   */
  installFromArchive?:
    | ((params: {
        workspaceId: string;
        appId: string;
        archiveUrl?: string | null;
        archivePath?: string | null;
      }) => Promise<{
        ok: boolean;
        ready: boolean;
        detail: string;
        error: string | null;
        statusCode?: number;
      }>)
    | null;
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

export interface RuntimeAgentToolsRetrieveMemoryParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  query: string;
  categories?: WorkspaceMemoryCategory[] | null;
  mode?: "mixed" | "summaries" | "leaves" | null;
  treeId?: string | null;
  nodeId?: string | null;
  maxResults?: number | null;
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
   *  Default false — agents rarely need these for user-facing app
   *  experiences and their visibility just adds noise. */
  includeSystem?: boolean;
}

export interface RuntimeAgentToolsScaffoldWorkspaceAppParams {
  workspaceId: string;
  appId: string;
  name?: string | null;
  overwrite?: boolean;
}

export interface RuntimeAgentToolsRegisterWorkspaceAppParams {
  workspaceId: string;
  appId: string;
  configPath?: string | null;
}

export interface RuntimeAgentToolsBuildWorkspaceAppParams {
  workspaceId: string;
  appId: string;
  timeoutMs?: number | null;
}

export interface RuntimeAgentToolsEnsureWorkspaceAppsRunningParams {
  workspaceId: string;
  appIds?: string[] | null;
  /** Session that called this — used as the routing target for the
   *  auto-queued post-build polish pass. If the caller is a subagent
   *  the polish input is rerouted to its owner main session so the
   *  polish turn shows up in the user-facing chat. */
  sessionId?: string | null;
}

export interface RuntimeAgentToolsRestartWorkspaceAppParams {
  workspaceId: string;
  appId: string;
}

export interface RuntimeAgentToolsFindWorkspaceAppsParams {
  workspaceId: string;
  query?: string | null;
  source?: "marketplace" | "local" | "installed" | "all" | null;
}

export interface RuntimeAgentToolsInstallWorkspaceAppParams {
  workspaceId: string;
  appId: string;
}

export interface RuntimeAgentToolsRestartAndWaitWorkspaceAppReadyParams {
  workspaceId: string;
  appId: string;
  timeoutMs?: number | null;
  pollIntervalMs?: number | null;
}

export interface RuntimeAgentToolsWaitUntilWorkspaceAppReadyParams {
  workspaceId: string;
  appId: string;
  timeoutMs?: number | null;
  pollIntervalMs?: number | null;
}

export interface RuntimeAgentToolsGetWorkspaceAppStatusParams {
  workspaceId: string;
  appId?: string | null;
}

export interface RuntimeAgentToolsGetWorkspaceAppPortsParams {
  workspaceId: string;
  appId?: string | null;
}

export interface RuntimeAgentToolsProbeWorkspaceAppEndpointsParams {
  workspaceId: string;
  appId: string;
  checks?: string[] | null;
  timeoutMs?: number | null;
}

export interface RuntimeAgentToolsDescribeDataTableParams {
  workspaceId: string;
  tableName: string;
}

export interface RuntimeAgentToolsSampleDataTableRowsParams {
  workspaceId: string;
  tableName: string;
  limit?: number | null;
  offset?: number | null;
}

export interface RuntimeAgentToolsQueryWorkspaceDataParams {
  workspaceId: string;
  query: string;
  limit?: number | null;
  offset?: number | null;
  timeoutMs?: number | null;
}

// Suffixes that mark a table as app-internal under the cross-platform
// metrics convention (see post-metrics-convention plan doc). Tables
// matching these are hidden from workspace data discovery by default so
// the agent's "what can I query?" view stays focused on user-facing data.
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

function sanitizeWorkspaceAppId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new RuntimeAgentToolsServiceError(400, "app_id_required", "app_id is required");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "app_id_invalid",
      "app_id must not contain path separators",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "app_id_invalid",
      "app_id contains invalid characters",
    );
  }
  return value;
}

function humanizeWorkspaceAppName(appId: string): string {
  return appId
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function workspaceAppSlug(appId: string): string {
  return appId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || appId;
}

function resolveWorkspaceRelativePath(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.split("/").includes("..")) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_path_invalid",
      "path traversal not allowed",
    );
  }
  const resolvedRoot = path.resolve(rootDir);
  const fullPath = path.resolve(resolvedRoot, normalized);
  if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_path_invalid",
      "path traversal not allowed",
    );
  }
  return fullPath;
}

function scaffoldWorkspaceAppManifest(params: { appId: string; name: string }): string {
  return yaml.dump(
    {
      app_id: params.appId,
      name: params.name,
      slug: workspaceAppSlug(params.appId),
      lifecycle: {
        setup: "npm install",
        start: "npm run start",
      },
      healthchecks: {
        mcp: {
          path: "/mcp/health",
          // 120s covers a cold-start vibe-coded app: first-time
          // npm install (40-60s) + first vite build (20-40s) + boot
          // (5-10s). 30s was the historical default and routinely
          // surfaced as "did not become healthy within 30s" on second
          // binding upserts where the app needed a full restart.
          timeout_s: 120,
          interval_s: 5,
        },
      },
      mcp: {
        transport: "http-sse",
        port: 13100,
        path: "/mcp/sse",
        tools: [],
      },
      env_contract: ["HOLABOSS_WORKSPACE_ID"],
    },
    { sortKeys: false, noRefs: true, lineWidth: 0 },
  );
}

function scaffoldWorkspaceAppPackageJson(params: { appId: string }): string {
  return `${JSON.stringify(
    {
      name: params.appId,
      version: "0.1.0",
      private: true,
      scripts: {
        start: "tsx src/server.ts",
        build: "tsc -p tsconfig.json",
      },
      dependencies: {
        express: "^4.21.2",
      },
      devDependencies: {
        "@types/express": "^4.17.21",
        "@types/node": "^24.0.1",
        tsx: "^4.19.3",
        typescript: "^5.8.3",
      },
    },
    null,
    2,
  )}\n`;
}

function scaffoldWorkspaceAppTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "CommonJS",
        moduleResolution: "Node",
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        strict: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
        types: ["node"],
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  )}\n`;
}

function scaffoldWorkspaceAppServerTs(params: { appId: string; name: string }): string {
  const appIdLiteral = JSON.stringify(params.appId);
  const appNameLiteral = JSON.stringify(params.name);
  return `import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";

const appId = ${appIdLiteral};
const appName = ${appNameLiteral};
const uiPort = Number(process.env.PORT || 3000);
const mcpPort = Number(process.env.MCP_PORT || 13100);

function jsonRpcSuccess(id: unknown, result: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const uiApp = express();
uiApp.get("/", (_req, res) => {
  res.status(200).type("html").send(\`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>\${appName}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        background: #08111f;
        color: #ecf3ff;
      }

      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 48px 24px 64px;
      }

      .eyebrow {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(32, 154, 255, 0.18);
        color: #61c4ff;
        font-size: 13px;
        font-weight: 600;
      }

      h1 {
        margin: 20px 0 12px;
        font-size: clamp(40px, 9vw, 68px);
        line-height: 0.98;
      }

      p {
        margin: 0;
        color: #b6c5dd;
        font-size: 18px;
        line-height: 1.6;
      }

      .card {
        margin-top: 32px;
        padding: 20px 22px;
        border-radius: 22px;
        background: rgba(13, 24, 45, 0.84);
        border: 1px solid rgba(120, 156, 214, 0.2);
      }

      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <span class="eyebrow">holaOS app scaffold</span>
      <h1>\${appName}</h1>
      <p>This runtime-managed starter is registered with the current workspace. Replace this placeholder with the first useful UI for the user request.</p>
      <section class="card">
        <strong>Managed runtime status</strong>
        <p>UI port: <code>\${uiPort}</code><br />MCP port: <code>\${mcpPort}</code></p>
      </section>
    </main>
  </body>
</html>\`);
});

uiApp.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, app_id: appId });
});

const mcpApp = express();
mcpApp.use(express.json({ limit: "1mb" }));

mcpApp.get("/mcp/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    app_id: appId,
    transport: "http-sse",
    sse_path: "/mcp/sse",
    message_path: "/mcp/messages",
  });
});

mcpApp.get("/mcp/sse", (req: Request, res: Response) => {
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write(
    \`event: endpoint\\ndata: \${JSON.stringify({ sessionId, messagePath: "/mcp/messages" })}\\n\\n\`,
  );
  res.write(\`event: ready\\ndata: \${JSON.stringify({ appId })}\\n\\n\`);

  const heartbeat = setInterval(() => {
    res.write(\`event: ping\\ndata: \${JSON.stringify({ ts: new Date().toISOString() })}\\n\\n\`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    res.end();
  });
});

mcpApp.post("/mcp/messages", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = isRecord(body.params) ? body.params : {};

  if (!method) {
    res.status(400).json(jsonRpcError(id, -32600, "Invalid Request"));
    return;
  }

  if (method === "initialize") {
    const protocolVersion =
      typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
    res.status(200).json(
      jsonRpcSuccess(id, {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: appId,
          version: "0.1.0",
        },
      }),
    );
    return;
  }

  if (method === "tools/list") {
    res.status(200).json(jsonRpcSuccess(id, { tools: [] }));
    return;
  }

  if (method === "resources/list") {
    res.status(200).json(jsonRpcSuccess(id, { resources: [] }));
    return;
  }

  if (method === "prompts/list") {
    res.status(200).json(jsonRpcSuccess(id, { prompts: [] }));
    return;
  }

  if (method === "ping") {
    res.status(200).json(jsonRpcSuccess(id, {}));
    return;
  }

  if (method.startsWith("notifications/")) {
    res.status(202).json({ ok: true });
    return;
  }

  res.status(200).json(jsonRpcError(id, -32601, \`Method not found: \${method}\`));
});

const uiServer = uiApp.listen(uiPort, () => {
  const address = uiServer.address() as AddressInfo;
  console.log(\`[\${appId}] UI listening on http://127.0.0.1:\${address.port}\`);
});

const mcpServer = mcpApp.listen(mcpPort, () => {
  const address = mcpServer.address() as AddressInfo;
  console.log(\`[\${appId}] MCP listening on http://127.0.0.1:\${address.port}\`);
});

function shutdown(signal: string) {
  console.log(\`[\${appId}] Received \${signal}, shutting down.\`);
  uiServer.close(() => undefined);
  mcpServer.close(() => undefined);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fallbackWorkspaceAppBuildStatus(entry: Record<string, unknown>): string {
  const lifecycle = isRecord(entry.lifecycle) ? (entry.lifecycle as Record<string, unknown>) : null;
  return typeof lifecycle?.setup === "string" && lifecycle.setup.trim().length > 0 ? "pending" : "stopped";
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
    id: runtimeToolBaseDefinition("onboarding_status").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/onboarding/status",
    description: runtimeToolBaseDefinition("onboarding_status").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_create_alignment_question").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/alignment-question",
    description: runtimeToolBaseDefinition("holaboss_create_alignment_question").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_create_alignment_report").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/alignment-report",
    description: runtimeToolBaseDefinition("holaboss_create_alignment_report").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_create_verification_report").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/verification-report",
    description: runtimeToolBaseDefinition("holaboss_create_verification_report").description
  },
  {
    id: runtimeToolBaseDefinition("holaboss_onboarding_complete").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/complete",
    description: runtimeToolBaseDefinition("holaboss_onboarding_complete").description
  },
  {
    id: runtimeToolBaseDefinition("cronjobs_list").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/cronjobs",
    description: runtimeToolBaseDefinition("cronjobs_list").description
  },
  {
    id: runtimeToolBaseDefinition("cronjobs_create").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/cronjobs",
    description: runtimeToolBaseDefinition("cronjobs_create").description
  },
  {
    id: runtimeToolBaseDefinition("cronjobs_get").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("cronjobs_get").description
  },
  {
    id: runtimeToolBaseDefinition("cronjobs_update").id,
    method: "PATCH",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("cronjobs_update").description
  },
  {
    id: runtimeToolBaseDefinition("cronjobs_delete").id,
    method: "DELETE",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId",
    description: runtimeToolBaseDefinition("cronjobs_delete").description
  },
  {
    id: runtimeToolBaseDefinition("delegate_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents",
    description: runtimeToolBaseDefinition("delegate_task").description
  },
  {
    id: runtimeToolBaseDefinition("get_subagent").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId",
    description: runtimeToolBaseDefinition("get_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("list_background_tasks").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/background-tasks",
    description: runtimeToolBaseDefinition("list_background_tasks").description
  },
  {
    id: runtimeToolBaseDefinition("cancel_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/cancel",
    description: runtimeToolBaseDefinition("cancel_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("resume_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/resume",
    description: runtimeToolBaseDefinition("resume_subagent").description
  },
  {
    id: runtimeToolBaseDefinition("continue_subagent").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents/:subagentId/continue",
    description: runtimeToolBaseDefinition("continue_subagent").description
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
    id: runtimeToolBaseDefinition("memory_retrieve").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/memory/retrieve",
    description: runtimeToolBaseDefinition("memory_retrieve").description
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
    id: runtimeToolBaseDefinition("scratchpad_read").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/scratchpad",
    description: runtimeToolBaseDefinition("scratchpad_read").description
  },
  {
    id: runtimeToolBaseDefinition("scratchpad_write").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/scratchpad",
    description: runtimeToolBaseDefinition("scratchpad_write").description
  },
  {
    id: runtimeToolBaseDefinition("update_workspace_instructions").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-instructions",
    description: runtimeToolBaseDefinition("update_workspace_instructions").description
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
    id: runtimeToolBaseDefinition("workspace_integrations_list_catalog").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-integrations/catalog",
    description: runtimeToolBaseDefinition("workspace_integrations_list_catalog").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_scaffold").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/scaffold",
    description: runtimeToolBaseDefinition("workspace_apps_scaffold").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_register").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/register",
    description: runtimeToolBaseDefinition("workspace_apps_register").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_build").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/build",
    description: runtimeToolBaseDefinition("workspace_apps_build").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_ensure_running").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/ensure-running",
    description: runtimeToolBaseDefinition("workspace_apps_ensure_running").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_restart").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/restart",
    description: runtimeToolBaseDefinition("workspace_apps_restart").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_restart_and_wait_ready").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/restart-and-wait-ready",
    description: runtimeToolBaseDefinition("workspace_apps_restart_and_wait_ready").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_wait_until_ready").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/wait-until-ready",
    description: runtimeToolBaseDefinition("workspace_apps_wait_until_ready").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_get_status").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/status",
    description: runtimeToolBaseDefinition("workspace_apps_get_status").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_get_ports").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/ports",
    description: runtimeToolBaseDefinition("workspace_apps_get_ports").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_apps_probe_endpoints").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-apps/:appId/probe-endpoints",
    description: runtimeToolBaseDefinition("workspace_apps_probe_endpoints").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_data_list_tables").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/workspace-data/tables",
    description: runtimeToolBaseDefinition("workspace_data_list_tables").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_data_describe_table").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/workspace-data/tables/:tableName",
    description: runtimeToolBaseDefinition("workspace_data_describe_table").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_data_sample_rows").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-data/tables/:tableName/sample",
    description: runtimeToolBaseDefinition("workspace_data_sample_rows").description
  },
  {
    id: runtimeToolBaseDefinition("workspace_data_query").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/workspace-data/query",
    description: runtimeToolBaseDefinition("workspace_data_query").description
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

function isWorkspaceAppEndpointProbeCheck(value: string): value is WorkspaceAppEndpointProbeCheck {
  return (WORKSPACE_APP_ENDPOINT_PROBE_CHECKS as readonly string[]).includes(value);
}

function latestIsoTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!latest || value > latest) {
      latest = value;
    }
  }
  return latest;
}

function safeStatMtimeIso(targetPath: string): string | null {
  try {
    return statSync(targetPath).mtime.toISOString();
  } catch {
    return null;
  }
}

function latestDirectoryMtimeIso(targetDir: string): string | null {
  if (!existsSync(targetDir)) {
    return null;
  }
  let latest = safeStatMtimeIso(targetDir);
  try {
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      const fullPath = path.join(targetDir, entry.name);
      const entryTimestamp = entry.isDirectory()
        ? latestDirectoryMtimeIso(fullPath)
        : safeStatMtimeIso(fullPath);
      latest = latestIsoTimestamp([latest, entryTimestamp]);
    }
  } catch {
    return latest;
  }
  return latest;
}

function workspaceAppMessagePath(mcpPath: string): string {
  const normalized = normalizedString(mcpPath) || "/mcp/sse";
  if (normalized.endsWith("/sse")) {
    return normalized.replace(/\/sse$/, "/messages");
  }
  return "/mcp/messages";
}

function workspaceAppRevisionInfo(params: {
  workspaceDir: string;
  appId: string;
  configPath: string;
  build: AppBuildRecord | null;
}): JsonObject {
  const appDir = path.join(
    params.workspaceDir,
    params.configPath ? path.dirname(params.configPath) : path.join("apps", params.appId),
  );
  const manifestPath = path.join(params.workspaceDir, params.configPath || `apps/${params.appId}/app.runtime.yaml`);
  const packageJsonPath = path.join(appDir, "package.json");
  const tsconfigPath = path.join(appDir, "tsconfig.json");
  const srcUpdatedAt = latestDirectoryMtimeIso(path.join(appDir, "src"));
  const distUpdatedAt = latestDirectoryMtimeIso(path.join(appDir, "dist"));
  const sourceUpdatedAt = latestIsoTimestamp([
    safeStatMtimeIso(manifestPath),
    safeStatMtimeIso(packageJsonPath),
    safeStatMtimeIso(tsconfigPath),
    srcUpdatedAt,
  ]);
  const lastReadyAt = params.build?.status === "running" ? params.build.updatedAt : null;
  const codeChangedSinceReady =
    sourceUpdatedAt && lastReadyAt ? sourceUpdatedAt > lastReadyAt : null;
  const codeChangedSinceBuild =
    sourceUpdatedAt && params.build?.completedAt
      ? sourceUpdatedAt > params.build.completedAt
      : sourceUpdatedAt && params.build
        ? params.build.completedAt === null
        : null;

  return {
    manifest_updated_at: safeStatMtimeIso(manifestPath),
    package_json_updated_at: safeStatMtimeIso(packageJsonPath),
    tsconfig_updated_at: safeStatMtimeIso(tsconfigPath),
    src_updated_at: srcUpdatedAt,
    dist_updated_at: distUpdatedAt,
    source_updated_at: sourceUpdatedAt,
    build_record_created_at: params.build?.createdAt ?? null,
    runtime_status_updated_at: params.build?.updatedAt ?? null,
    build_started_at: params.build?.startedAt ?? null,
    build_completed_at: params.build?.completedAt ?? null,
    last_ready_at: lastReadyAt,
    restart_attempts: params.build?.restartAttempts ?? 0,
    code_changed_since_build: codeChangedSinceBuild,
    code_changed_since_ready: codeChangedSinceReady,
    managed_runtime_stale: codeChangedSinceReady,
  };
}

async function runWorkspaceAppCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const MAX_CAPTURE_BYTES = 128 * 1024;
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnShellCommand(spawn, params.command, {
      cwd: params.cwd,
      env: buildAppSetupEnv(params.cwd),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killChildProcess(child, "SIGKILL");
      resolve({
        command: params.command,
        exitCode: null,
        timedOut: true,
        stdout,
        stderr,
      });
    }, params.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= MAX_CAPTURE_BYTES) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(0, MAX_CAPTURE_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= MAX_CAPTURE_BYTES) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(0, MAX_CAPTURE_BYTES);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        command: params.command,
        exitCode: code,
        timedOut: false,
        stdout,
        stderr,
      });
    });
  });
}

async function fetchWorkspaceAppProbe(params: {
  url: string;
  method?: "GET" | "POST";
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  ok: boolean;
  statusCode: number;
  contentType: string;
  bodyText: string;
  jsonBody: unknown | null;
}> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: params.method ?? "GET",
      headers: params.headers,
      body: params.body,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = (await response.text()).slice(0, 8_000);
    let jsonBody: unknown | null = null;
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        jsonBody = JSON.parse(bodyText);
      } catch {
        jsonBody = null;
      }
    }
    return {
      ok: response.ok,
      statusCode: response.status,
      contentType,
      bodyText,
      jsonBody,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
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
    .replace(/\.(?:md|mdx|markdown|html?)$/i, "")
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
    case "text/html":
      return ".html";
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
    case ".html":
    case ".htm":
      return "text/html";
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

function textFromHtmlFragment(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reportTitleFromContent(content: string): string {
  const titleMatch = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = textFromHtmlFragment(titleMatch[1]);
    if (title) {
      return title;
    }
  }
  const h1Match = content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const title = textFromHtmlFragment(h1Match[1]);
    if (title) {
      return title;
    }
  }
  const headingMatch = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  if (/<[^>]+>/.test(content)) {
    const htmlText = textFromHtmlFragment(content);
    if (htmlText) {
      return htmlText.slice(0, 120);
    }
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
    normalizedString(params.filename).replace(/\.(?:md|mdx|markdown|html?)$/i, "") ||
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
      index === 0
        ? `${preferredStem}${REPORT_FILE_EXTENSION}`
        : `${preferredStem}-${index + 1}${REPORT_FILE_EXTENSION}`;
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
  delete nextMetadata.model;
  const userId = normalizedString(params.holabossUserId);
  if (userId && typeof nextMetadata.holaboss_user_id !== "string") {
    nextMetadata.holaboss_user_id = userId;
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

function parseStoredOnboardingReport(
  raw: string | null | undefined,
): JsonValue | null {
  const normalized = normalizedString(raw);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized) as JsonValue;
  } catch {
    return null;
  }
}

type OnboardingAlignmentQuestionOption = {
  id: string;
  label: string;
  description?: string | null;
  answer_text?: string | null;
  recommended?: boolean;
};

type OnboardingAlignmentQuestionItem = {
  id: string;
  title?: string | null;
  prompt: string;
  details?: string | null;
  allow_notes?: boolean;
  notes_placeholder?: string | null;
  allow_freeform?: boolean;
  freeform_placeholder?: string | null;
  options: OnboardingAlignmentQuestionOption[];
};

type OnboardingAlignmentQuestion = {
  title?: string | null;
  details?: string | null;
  questions: OnboardingAlignmentQuestionItem[];
};

type OnboardingAlignmentQuestionAnswer = {
  question_id?: string | null;
  option_id?: string | null;
  response_text?: string | null;
  notes?: string | null;
};

function sanitizeAlignmentQuestionOption(
  value: Record<string, unknown>,
  index: number,
  path = "question.options",
): OnboardingAlignmentQuestionOption {
  const id = normalizedString(value.id) || `option_${index + 1}`;
  const label =
    normalizedString(value.label) ||
    normalizedString(value.title) ||
    normalizedString(value.text);
  if (!label) {
    throw new Error(`${path}[${index}].label is required`);
  }
  return {
    id,
    label,
    description: normalizedString(value.description) || null,
    answer_text:
      normalizedString(value.answer_text) ||
      normalizedString(value.answer) ||
      normalizedString(value.value) ||
      null,
    recommended: value.recommended === true,
  };
}

function sanitizeAlignmentQuestionItem(
  value: Record<string, unknown>,
  index: number,
  defaults?: Partial<OnboardingAlignmentQuestionItem>,
  path = "question",
): OnboardingAlignmentQuestionItem {
  const id = normalizedString(value.id) || defaults?.id || `question_${index + 1}`;
  const explicitTitle = normalizedString(value.title);
  const prompt =
    normalizedString(value.prompt) ||
    normalizedString(value.question) ||
    normalizedString(value.text) ||
    explicitTitle;
  if (!prompt) {
    throw new Error(`${path}.prompt is required`);
  }
  const optionsValue = Array.isArray(value.options)
    ? value.options
    : Array.isArray(value.choices)
      ? value.choices
      : null;
  if (!optionsValue || optionsValue.length < 2) {
    throw new Error(`${path}.options must contain at least two options`);
  }
  const options = optionsValue.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${path}.options[${index}] must be an object`);
    }
    return sanitizeAlignmentQuestionOption(item, index, `${path}.options`);
  });
  return {
    id,
    title:
      explicitTitle && explicitTitle !== prompt
        ? explicitTitle
        : defaults?.title || null,
    prompt,
    details: normalizedString(value.details) || defaults?.details || null,
    allow_notes:
      typeof value.allow_notes === "boolean"
        ? value.allow_notes
        : defaults?.allow_notes === true,
    notes_placeholder:
      normalizedString(value.notes_placeholder) || defaults?.notes_placeholder || null,
    allow_freeform:
      typeof value.allow_freeform === "boolean"
        ? value.allow_freeform
        : defaults?.allow_freeform !== false,
    freeform_placeholder:
      normalizedString(value.freeform_placeholder) ||
      defaults?.freeform_placeholder ||
      null,
    options,
  };
}

function sanitizeAlignmentQuestion(
  value: Record<string, unknown>,
): OnboardingAlignmentQuestion {
  const defaults: Partial<OnboardingAlignmentQuestionItem> = {
    title: normalizedString(value.title) || null,
    details: normalizedString(value.details) || null,
    allow_notes: value.allow_notes === true,
    notes_placeholder: normalizedString(value.notes_placeholder) || null,
    allow_freeform: value.allow_freeform !== false,
    freeform_placeholder: normalizedString(value.freeform_placeholder) || null,
  };
  const questionItems = Array.isArray(value.questions)
    ? value.questions
    : Array.isArray(value.items)
      ? value.items
      : null;
  if (questionItems && questionItems.length > 0) {
    const questions = questionItems.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(`question.questions[${index}] must be an object`);
      }
      return sanitizeAlignmentQuestionItem(
        item,
        index,
        defaults,
        `question.questions[${index}]`,
      );
    });
    return {
      title: defaults.title || null,
      details: defaults.details || null,
      questions,
    };
  }
  return {
    title: defaults.title || null,
    details: defaults.details || null,
    questions: [sanitizeAlignmentQuestionItem(value, 0, defaults, "question")],
  };
}

function parseStoredAlignmentQuestion(
  raw: string | null | undefined,
): OnboardingAlignmentQuestion | null {
  const parsed = parseStoredOnboardingReport(raw);
  if (!isRecord(parsed)) {
    return null;
  }
  try {
    return sanitizeAlignmentQuestion(parsed);
  } catch {
    return null;
  }
}

export function effectiveOnboardingState(workspace: WorkspaceRecord): string | null {
  const normalized = normalizedString(workspace.onboardingState);
  if (normalized) {
    return normalized;
  }
  if (workspace.onboardingStatus === "completed") {
    return ONBOARDING_COMPLETED_STATE;
  }
  if (workspace.onboardingStatus === "pending") {
    return ONBOARDING_ALIGNMENT_STATE;
  }
  return null;
}

export function onboardingPayload(workspace: WorkspaceRecord): JsonObject {
  return {
    workspace_id: workspace.id,
    onboarding_status: workspace.onboardingStatus,
    onboarding_state: effectiveOnboardingState(workspace),
    onboarding_session_id: workspace.onboardingSessionId,
    alignment_question: parseStoredAlignmentQuestion(
      workspace.onboardingAlignmentQuestion,
    ) as unknown as JsonValue | null,
    alignment_report: parseStoredOnboardingReport(workspace.onboardingAlignmentReport),
    verification_report: parseStoredOnboardingReport(workspace.onboardingVerificationReport),
    onboarding_completed_at: workspace.onboardingCompletedAt,
    onboarding_completion_summary: workspace.onboardingCompletionSummary,
    onboarding_requested_at: workspace.onboardingRequestedAt,
    onboarding_requested_by: workspace.onboardingRequestedBy
  };
}

export function cronjobPayload(record: CronjobRecord): JsonObject {
  const metadata: JsonObject = { ...((record.metadata ?? {}) as JsonObject) };
  delete metadata.model;
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
    metadata: metadata as JsonValue,
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
      appLifecycle?: RuntimeAgentToolAppLifecycleCallbacks | null;
      composioMcpManager?: ComposioMcpManager | null;
    },
  ) {}

  capabilityStatus(context?: { workspaceId?: string | null }): RuntimeAgentToolCapabilityPayload {
    return runtimeAgentToolCapabilityPayload(context);
  }

  onboardingStatus(workspaceId: string): JsonObject {
    const scope = this.resolveOnboardingFlowScope(workspaceId);
    return {
      ...onboardingPayload(scope.source),
      lab_workspace_id: scope.lab?.id ?? null,
      lab_purpose: scope.lab?.labPurpose ?? null,
      lab_status: scope.lab?.labStatus ?? null,
    };
  }

  createAlignmentQuestion(params: {
    workspaceId: string;
    question: Record<string, unknown>;
  }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [ONBOARDING_ALIGNMENT_STATE]);
    let question: OnboardingAlignmentQuestion;
    try {
      question = sanitizeAlignmentQuestion(params.question);
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "alignment_question_invalid",
        error instanceof Error ? error.message : "alignment question is invalid",
      );
    }
    const source = this.syncOnboardingFlow(scope, {
      onboardingAlignmentQuestion: JSON.stringify(question),
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  answerAlignmentQuestion(params: {
    workspaceId: string;
    model?: string | null;
    thinkingValue?: string | null;
    optionId?: string | null;
    responseText?: string | null;
    notes?: string | null;
    answers?: OnboardingAlignmentQuestionAnswer[] | null;
  }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [ONBOARDING_ALIGNMENT_STATE]);
    const question = parseStoredAlignmentQuestion(
      scope.source.onboardingAlignmentQuestion,
    );
    if (!question) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "alignment_question_not_active",
        "no active alignment question is awaiting an answer",
      );
    }
    const questions = question.questions;
    if (questions.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "alignment_question_not_active",
        "no active alignment question is awaiting an answer",
      );
    }
    const sessionId = normalizedString(scope.source.onboardingSessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "onboarding_session_not_configured",
        "onboarding session is not configured",
      );
    }
    if (
      !this.store.getSession({
        workspaceId: scope.lab.id,
        sessionId,
      })
    ) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "onboarding_session_not_found",
        "onboarding session could not be found in the active lab",
      );
    }
    const normalizedAnswers =
      Array.isArray(params.answers) && params.answers.length > 0
        ? params.answers
        : [
            {
              question_id: questions[0]?.id ?? null,
              option_id: params.optionId ?? null,
              response_text: params.responseText ?? null,
              notes: params.notes ?? null,
            } satisfies OnboardingAlignmentQuestionAnswer,
          ];
    const answerLines: Array<{
      payload: Record<string, unknown>;
      text: string;
    }> = [];
    for (const [index, currentQuestion] of questions.entries()) {
      const answer =
        normalizedAnswers.find(
          (item) =>
            normalizedString(item.question_id) === currentQuestion.id,
        ) ?? (index === 0 ? normalizedAnswers[0] ?? null : null);
      // No matching answer for this question. When the UI submits a
      // single-question answer against a multi-question deck (the common
      // case), the remaining questions stay unanswered and roll back to
      // the agent on the next turn. Skip rather than throwing.
      if (!answer) continue;
      const optionId = normalizedString(answer.option_id);
      const option =
        optionId
          ? currentQuestion.options.find((item) => item.id === optionId)
          : null;
      if (optionId && !option) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "alignment_question_option_invalid",
          `selected alignment question option is invalid for ${currentQuestion.id}`,
        );
      }
      const responseText = normalizedString(answer.response_text) || "";
      if (!option && !responseText) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "alignment_question_answer_required",
          `an option or response text is required for ${currentQuestion.id}`,
        );
      }
      if (responseText && currentQuestion.allow_freeform === false) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "alignment_question_freeform_not_allowed",
          `freeform response is not allowed for ${currentQuestion.id}`,
        );
      }
      const noteText = normalizedString(answer.notes) || "";
      const selectedAnswerText = option?.answer_text || option?.label || "";
      const normalizedAnswerText = responseText || selectedAnswerText;
      const lines = [
        questions.length > 1
          ? `Question ${index + 1}: ${currentQuestion.prompt}`
          : currentQuestion.prompt,
      ];
      if (option) {
        lines.push(`Selected option: ${option.label}`);
      }
      lines.push(`Answer: ${normalizedAnswerText}`);
      if (noteText) {
        lines.push(`Additional notes: ${noteText}`);
      }
      answerLines.push({
        payload: {
          question_id: currentQuestion.id,
          question_prompt: currentQuestion.prompt,
          option_id: option?.id ?? null,
          option_label: option?.label ?? null,
          response_text: responseText || null,
          notes: noteText || null,
        },
        text: lines.join("\n"),
      });
    }
    const queuedText = answerLines.map((entry) => entry.text).join("\n\n");
    this.store.ensureRuntimeState({
      workspaceId: scope.lab.id,
      sessionId,
      status: "QUEUED",
    });
    const input = this.store.enqueueInput({
      workspaceId: scope.lab.id,
      sessionId,
      payload: {
        text: queuedText,
        attachments: [],
        image_urls: [],
        model: normalizedString(params.model) || null,
        thinking_value: normalizedString(params.thinkingValue) || null,
        context: {
          source: "alignment_question",
          question_count: questions.length,
          questions: answerLines.map((entry) => entry.payload),
        },
      },
    });
    this.store.updateRuntimeState({
      workspaceId: scope.lab.id,
      sessionId,
      status: "QUEUED",
      currentInputId: input.inputId,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null,
    });
    const source = this.syncOnboardingFlow(scope, {
      onboardingAlignmentQuestion: null,
    });
    this.options.queueWorker?.wake();
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  createAlignmentReport(params: {
    workspaceId: string;
    report: Record<string, unknown>;
  }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [ONBOARDING_ALIGNMENT_STATE]);
    if (Object.keys(params.report).length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "alignment_report_required",
        "alignment report must be a non-empty object",
      );
    }
    const serialized = JSON.stringify(params.report);
    const source = this.syncOnboardingFlow(scope, {
      onboardingState: ONBOARDING_AWAITING_ALIGNMENT_APPROVAL_STATE,
      onboardingAlignmentQuestion: null,
      onboardingAlignmentReport: serialized,
      onboardingVerificationReport: null,
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  approveAlignment(params: { workspaceId: string }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [
      ONBOARDING_AWAITING_ALIGNMENT_APPROVAL_STATE,
    ]);
    const source = this.syncOnboardingFlow(scope, {
      onboardingState: ONBOARDING_IMPLEMENTING_STATE,
      onboardingAlignmentQuestion: null,
      onboardingVerificationReport: null,
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  requestAlignmentRevision(params: { workspaceId: string }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [
      ONBOARDING_AWAITING_ALIGNMENT_APPROVAL_STATE,
    ]);
    const source = this.syncOnboardingFlow(scope, {
      onboardingState: ONBOARDING_ALIGNMENT_STATE,
      onboardingAlignmentQuestion: null,
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  createVerificationReport(params: {
    workspaceId: string;
    report: Record<string, unknown>;
  }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [ONBOARDING_IMPLEMENTING_STATE]);
    if (Object.keys(params.report).length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "verification_report_required",
        "verification report must be a non-empty object",
      );
    }
    const serialized = JSON.stringify(params.report);
    const source = this.syncOnboardingFlow(scope, {
      onboardingState: ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE,
      onboardingAlignmentQuestion: null,
      onboardingVerificationReport: serialized,
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  requestVerificationRevision(params: { workspaceId: string }): JsonObject {
    const scope = this.requireActiveOnboardingLab(params.workspaceId);
    this.requireOnboardingState(scope.source, [
      ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE,
    ]);
    const source = this.syncOnboardingFlow(scope, {
      onboardingState: ONBOARDING_ALIGNMENT_STATE,
      onboardingAlignmentQuestion: null,
      onboardingVerificationReport: null,
    });
    return {
      ...onboardingPayload(source),
      lab_workspace_id: scope.lab.id,
      lab_purpose: scope.lab.labPurpose,
      lab_status: scope.lab.labStatus,
    };
  }

  completeOnboarding(params: {
    workspaceId: string;
    summary: string;
    requestedBy?: string | null;
  }): JsonObject {
    const workspace = this.requireWorkspace(params.workspaceId);
    const state = effectiveOnboardingState(workspace);
    if (
      normalizedString(workspace.onboardingState) &&
      state &&
      state !== ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE
    ) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "onboarding_state_conflict",
        `onboarding can only be completed from ${ONBOARDING_AWAITING_VERIFICATION_ACCEPTANCE_STATE}`,
      );
    }
    const now = utcNowIso();
    const updated = this.store.updateWorkspace(workspace.id, {
      onboardingStatus: "completed",
      onboardingState: ONBOARDING_COMPLETED_STATE,
      onboardingCompletedAt: now,
      onboardingCompletionSummary: params.summary,
      onboardingRequestedAt: now,
      onboardingRequestedBy: normalizedString(params.requestedBy) || "workspace_agent"
    });
    return onboardingPayload(updated);
  }

  listIntegrationCatalog(params: { workspaceId: string }): JsonObject {
    this.requireWorkspace(params.workspaceId);
    return {
      workspace_id: params.workspaceId,
      provider_ids: integrationCatalogProviderIds(),
      providers: INTEGRATION_CATALOG_PROVIDERS.map((provider) => ({
        provider_id: provider.provider_id,
        display_name: provider.display_name,
        description: provider.description,
        auth_modes: [...provider.auth_modes],
        supports_oss: provider.supports_oss,
        supports_managed: provider.supports_managed,
        default_scopes: [...provider.default_scopes],
        docs_url: provider.docs_url,
      })),
      requirement:
        "Use the exact canonical provider_id from this catalog in app.runtime.yaml integrations and createIntegrationClient(...). E.g. use 'twitter' for X.",
    };
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
    const workspace = this.requireWorkspace(params.workspaceId);
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
    const isDraftLab = workspace.workspaceRole === "draft_lab";
    const requestedEnabled = params.enabled !== false;
    // Cronjobs inside a draft lab are design context only — the lab is a
    // throwaway scratch space, so its cronjobs must not actually fire.
    // Remember the author's intent on the metadata so it can be restored
    // verbatim when the lab merges back into the source workspace.
    const effectiveEnabled = isDraftLab ? false : requestedEnabled;
    const effectiveNextRunAt = isDraftLab
      ? null
      : cronjobNextRunAt(cron, new Date());
    const baseMetadata = metadataWithCronjobDefaults({
      metadata: params.metadata,
      holabossUserId: params.holabossUserId,
      selectedModel: params.selectedModel,
      sourceSessionId: params.sessionId,
    });
    const metadata: JsonObject = isDraftLab
      ? {
          ...baseMetadata,
          author_recommended_enabled: requestedEnabled,
          lab_execution_disabled: true,
        }
      : baseMetadata;
    const created = this.store.createCronjob({
      workspaceId: params.workspaceId,
      initiatedBy: normalizedString(params.initiatedBy) || "workspace_agent",
      name: normalizedString(params.name),
      cron,
      description,
      instruction,
      enabled: effectiveEnabled,
      delivery: normalizeDelivery({
        channel: normalizedString(params.delivery?.channel ?? "session_run") || "session_run",
        mode: params.delivery?.mode ?? "announce",
        to: params.delivery?.to
      }),
      metadata,
      nextRunAt: effectiveNextRunAt,
    });
    return cronjobPayload(created);
  }

  updateCronjob(params: RuntimeAgentToolsUpdateCronjobParams): JsonObject {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const workspace = this.requireWorkspace(workspaceId);
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
    const isDraftLab = workspace.workspaceRole === "draft_lab";
    const effectiveEnabled =
      params.enabled === undefined
        ? undefined
        : isDraftLab
          ? false
          : params.enabled;
    const baseMetadata =
      params.metadata === undefined
        ? undefined
        : metadataWithCronjobDefaults({
            metadata: params.metadata,
            holabossUserId: null,
          });
    let effectiveMetadata = baseMetadata;
    if (isDraftLab && params.enabled !== undefined) {
      // Carry the author's requested enabled state forward in metadata so
      // a later lab-merge can restore intent; the row itself stays disabled.
      const existingMetadata = isRecord(existing.metadata) ? existing.metadata : {};
      effectiveMetadata = {
        ...((baseMetadata ?? existingMetadata) as JsonObject),
        author_recommended_enabled: params.enabled,
        lab_execution_disabled: true,
      };
    }
    const effectiveNextRunAt =
      cron === null
        ? undefined
        : isDraftLab
          ? null
          : cronjobNextRunAt(cron, new Date());
    const updated = this.store.updateCronjob({
      workspaceId,
      jobId: params.jobId,
      name: params.name === undefined ? undefined : normalizedString(params.name),
      cron,
      description,
      instruction: resolvedInstructionForCronjobUpdate({ existing, description, instruction }),
      enabled: effectiveEnabled,
      delivery:
        params.delivery === undefined || params.delivery === null
          ? undefined
          : normalizeDelivery({
              channel: params.delivery.channel,
              mode: params.delivery.mode,
              to: params.delivery.to
            }),
      metadata: effectiveMetadata,
      nextRunAt: effectiveNextRunAt,
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
    const parentInput = normalizedString(params.inputId)
      ? this.store.getInput({
          workspaceId: params.workspaceId,
          inputId: normalizedString(params.inputId),
        })
      : null;
    const controllerLatestInput = this.latestControllerInput(
      params.workspaceId,
      controllerSession.sessionId,
    );
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
        params.selectedModel ??
        params.model ??
        inputModelValue(parentInput) ??
        inputModelValue(controllerLatestInput) ??
        inputModelValue(previousChildInput),
      selectedThinkingValue:
        inputThinkingValue(parentInput) ??
        inputThinkingValue(controllerLatestInput) ??
        inputThinkingValue(previousChildInput),
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
    const controllerLatestInput = this.latestControllerInput(
      params.workspaceId,
      controllerSession.sessionId,
    );
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
        inputModelValue(controllerLatestInput) ??
        inputModelValue(previousChildInput),
      selectedThinkingValue:
        inputThinkingValue(parentInput) ??
        inputThinkingValue(controllerLatestInput) ??
        inputThinkingValue(previousChildInput),
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
      toolId: "list_background_tasks",
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
      toolId: "get_subagent",
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
        mime_type: REPORT_MIME_TYPE,
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
      mime_type: REPORT_MIME_TYPE,
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

  async retrieveMemory(params: RuntimeAgentToolsRetrieveMemoryParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const mode = normalizedString(params.mode) as "mixed" | "summaries" | "leaves";
    if (mode && mode !== "mixed" && mode !== "summaries" && mode !== "leaves") {
      throw new RuntimeAgentToolsServiceError(
        400,
        "memory_retrieve_mode_invalid",
        "mode must be one of [\"mixed\",\"summaries\",\"leaves\"]",
      );
    }
    const result = await retrieveWorkspaceMemory({
      store: this.store,
      workspaceId: params.workspaceId,
      query: params.query,
      categories: params.categories ?? null,
      mode: mode || "mixed",
      treeId: normalizedString(params.treeId) || null,
      nodeId: normalizedString(params.nodeId) || null,
      maxResults: normalizedInteger(params.maxResults, 8, 1, 50),
      selectedModel: normalizedString(params.selectedModel) || null,
      sessionId: normalizedString(params.sessionId) || null,
      inputId: normalizedString(params.inputId) || null,
    });
    const sanitizeHit = (hit: Record<string, unknown>): JsonObject => {
      const { path: _path, absolute_path: _absolutePath, ...rest } = hit;
      return { ...rest } as JsonObject;
    };
    return {
      tool_id: "memory_retrieve",
      categories: result.categories,
      query: result.query,
      mode: result.mode,
      tree_id: result.tree_id,
      node_id: result.node_id,
      hits: result.hits.map((hit) => sanitizeHit({ ...hit })),
      children: result.children ? result.children.map((child) => sanitizeHit({ ...child })) : null,
    };
  }

  invokeSkill(params: RuntimeAgentToolsInvokeSkillParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    try {
      const workspaceDir = this.store.workspaceDir(params.workspaceId);
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

  private latestControllerInput(
    workspaceId: string,
    sessionId: string,
  ): SessionInputRecord | null {
    const runtimeState = this.store.getRuntimeState({
      workspaceId,
      sessionId,
    });
    const currentInputId = normalizedString(runtimeState?.currentInputId);
    if (currentInputId) {
      return this.store.getInput({
        workspaceId,
        inputId: currentInputId,
      });
    }
    return this.store.getLatestInputForSession({
      workspaceId,
      sessionId,
      excludeContextSources: ["main_session_event_batch"],
      preferConfiguredModel: true,
    });
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
    toolId: "get_subagent" | "list_background_tasks";
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

  private resolveOnboardingFlowScope(workspaceId: string): {
    source: WorkspaceRecord;
    lab: WorkspaceRecord | null;
  } {
    const workspace = this.requireWorkspace(workspaceId);
    if (
      workspace.workspaceRole === "draft_lab" &&
      workspace.labPurpose === "workspace_onboarding"
    ) {
      const sourceWorkspaceId = normalizedString(workspace.sourceWorkspaceId);
      const source = sourceWorkspaceId
        ? this.store.getWorkspace(sourceWorkspaceId)
        : null;
      if (!source) {
        throw new RuntimeAgentToolsServiceError(
          404,
          "source_workspace_not_found",
          "source workspace not found",
        );
      }
      return { source, lab: workspace };
    }
    const activeLab = this.store.getActiveWorkspaceLab(workspace.id);
    if (activeLab?.labPurpose === "workspace_onboarding") {
      return { source: workspace, lab: activeLab };
    }
    return { source: workspace, lab: null };
  }

  private requireActiveOnboardingLab(workspaceId: string): {
    source: WorkspaceRecord;
    lab: WorkspaceRecord;
  } {
    const scope = this.resolveOnboardingFlowScope(workspaceId);
    if (!scope.lab) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "onboarding_lab_not_active",
        "active workspace onboarding lab not found",
      );
    }
    return { source: scope.source, lab: scope.lab };
  }

  private requireOnboardingState(
    workspace: WorkspaceRecord,
    allowedStates: string[],
  ): string {
    const currentState = effectiveOnboardingState(workspace);
    if (!currentState || !allowedStates.includes(currentState)) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "onboarding_state_conflict",
        `expected onboarding state ${allowedStates.join(" or ")}, got ${currentState ?? "unset"}`,
      );
    }
    return currentState;
  }

  private syncOnboardingFlow(
    scope: { source: WorkspaceRecord; lab: WorkspaceRecord | null },
    fields: {
      onboardingState?: string | null;
      onboardingAlignmentQuestion?: string | null;
      onboardingAlignmentReport?: string | null;
      onboardingVerificationReport?: string | null;
      onboardingCompletedAt?: string | null;
      onboardingCompletionSummary?: string | null;
      onboardingRequestedAt?: string | null;
      onboardingRequestedBy?: string | null;
      onboardingStatus?: string | null;
    },
  ): WorkspaceRecord {
    const source = this.store.updateWorkspace(scope.source.id, fields);
    if (scope.lab) {
      this.store.updateWorkspace(scope.lab.id, fields);
    }
    return source;
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

  private requireWorkspaceAppLifecycle(): RuntimeAgentToolAppLifecycleCallbacks {
    const lifecycle = this.options.appLifecycle;
    if (!lifecycle) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_lifecycle_unavailable",
        "workspace app lifecycle is not available in this runtime",
      );
    }
    return lifecycle;
  }

  private listRegisteredWorkspaceAppEntries(workspaceId: string): Array<Record<string, unknown>> {
    this.requireWorkspace(workspaceId);
    return listWorkspaceApplications(path.join(this.options.workspaceRoot, workspaceId));
  }

  // Each completion-type workspace_apps_* tool calls this so the chat UI can
  // surface a Connect button whenever the agent finishes a build flow. Pass
  // an explicit appIds list when only one app changed; pass empty for "all
  // registered apps".
  private pendingIntegrationsForApps(
    workspaceId: string,
    appIds: string[] = [],
  ): JsonObject[] {
    const resolvedIds =
      appIds.length > 0
        ? appIds
        : this.listRegisteredWorkspaceAppEntries(workspaceId)
            .map((entry) => (typeof entry.app_id === "string" ? entry.app_id : ""))
            .filter((id) => id.length > 0);
    if (resolvedIds.length === 0) {
      return [];
    }
    return pendingIntegrationsFromAppManifests({
      workspaceDir: path.join(this.options.workspaceRoot, workspaceId),
      appIds: resolvedIds,
      store: this.store,
      workspaceId,
    });
  }

  private requireRegisteredWorkspaceApp(params: {
    workspaceId: string;
    appId: string;
  }): Record<string, unknown> {
    const appId = sanitizeWorkspaceAppId(params.appId);
    const entry = this.listRegisteredWorkspaceAppEntries(params.workspaceId).find(
      (candidate) => candidate.app_id === appId,
    );
    if (!entry) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "workspace_app_not_found",
        `app '${appId}' is not registered in workspace.yaml`,
      );
    }
    return entry;
  }

  private workspaceAppStatusEntry(params: {
    workspaceId: string;
    entry: Record<string, unknown>;
  }): JsonObject {
    const appId = typeof params.entry.app_id === "string" ? params.entry.app_id : "";
    const build = appId
      ? this.store.getAppBuild({ workspaceId: params.workspaceId, appId })
      : null;
    const buildStatus = appId
      ? build?.status ?? fallbackWorkspaceAppBuildStatus(params.entry)
      : "unknown";
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const ports = appId
      ? listWorkspaceApplicationPorts(workspaceDir, {
          store: this.store,
          workspaceId: params.workspaceId,
          allocatePorts: true,
        })[appId] ?? null
      : null;
    const configPath = typeof params.entry.config_path === "string" ? params.entry.config_path : "";
    let resolvedRuntime: ReturnType<typeof resolveWorkspaceAppRuntime> | null = null;
    let runtimeResolutionError: string | null = null;
    if (appId.length > 0 && configPath) {
      try {
        resolvedRuntime = resolveWorkspaceAppRuntime(workspaceDir, appId, {
          store: this.store,
          workspaceId: params.workspaceId,
          allocatePorts: true,
        });
      } catch (error) {
        runtimeResolutionError = error instanceof Error ? error.message : "failed to resolve app runtime";
      }
    }
    const mcpPath = resolvedRuntime?.resolvedApp.mcp.path ?? "/mcp/sse";
    const runtimeContract = resolvedRuntime
      ? ({
          app_dir: path.relative(workspaceDir, resolvedRuntime.appDir).replace(/\\/g, "/"),
          mcp: {
            transport: resolvedRuntime.resolvedApp.mcp.transport,
            sse_path: mcpPath,
            message_path: workspaceAppMessagePath(mcpPath),
            tools_declared: resolvedRuntime.resolvedApp.mcpTools,
          },
          healthcheck: {
            target: resolvedRuntime.resolvedApp.healthCheck.target ?? "mcp",
            path: resolvedRuntime.resolvedApp.healthCheck.path,
            timeout_s: resolvedRuntime.resolvedApp.healthCheck.timeoutS,
            interval_s: resolvedRuntime.resolvedApp.healthCheck.intervalS,
          },
          env_contract: resolvedRuntime.resolvedApp.envContract,
          integrations_declared: resolvedRuntime.resolvedApp.integrations?.map((integration) => ({
            key: integration.key,
            provider: integration.provider,
            capability: integration.capability,
            required: integration.required,
          })) ?? [],
        } satisfies JsonObject)
      : null;
    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      config_path: configPath,
      lifecycle: isRecord(params.entry.lifecycle) ? (params.entry.lifecycle as JsonObject) : null,
      build_status: buildStatus,
      ready: buildStatus === "running",
      error: build?.status === "failed" ? build.error ?? "unknown error" : null,
      ports: ports ? { http: ports.http, mcp: ports.mcp } : null,
      runtime_contract: runtimeContract,
      runtime_resolution_error: runtimeResolutionError,
      revision: workspaceAppRevisionInfo({
        workspaceDir,
        appId,
        configPath,
        build,
      }),
      registered: appId.length > 0,
    };
  }

  async findWorkspaceApps(
    params: RuntimeAgentToolsFindWorkspaceAppsParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const requestedSource = normalizedString(params.source) || "all";
    const source = requestedSource === "marketplace" || requestedSource === "local" || requestedSource === "installed" || requestedSource === "all"
      ? requestedSource
      : "all";
    const query = normalizedString(params.query).toLowerCase();

    const installedEntries = this.listRegisteredWorkspaceAppEntries(params.workspaceId);
    const installedAppIds = new Set(
      installedEntries
        .map((entry) => (typeof entry.app_id === "string" ? entry.app_id : ""))
        .filter((id) => id.length > 0),
    );

    const catalogEntries =
      source === "installed"
        ? []
        : source === "marketplace" || source === "local"
          ? this.store.listAppCatalogEntries({ source })
          : this.store.listAppCatalogEntries();

    type ResultRow = {
      app_id: string;
      name: string;
      description: string | null;
      source: "marketplace" | "local" | "installed";
      installed: boolean;
      provider_id: string | null;
      credential_source: string | null;
      archive_url: string | null;
    };
    const byAppId = new Map<string, ResultRow>();

    for (const entry of catalogEntries) {
      byAppId.set(entry.appId, {
        app_id: entry.appId,
        name: entry.name,
        description: entry.description,
        source: entry.source,
        installed: installedAppIds.has(entry.appId),
        provider_id: entry.providerId,
        credential_source: entry.credentialSource,
        archive_url: entry.archiveUrl,
      });
    }

    if (source === "installed" || source === "all") {
      for (const installed of installedEntries) {
        const appId = typeof installed.app_id === "string" ? installed.app_id : "";
        if (!appId) {
          continue;
        }
        const existing = byAppId.get(appId);
        if (existing) {
          existing.installed = true;
          // When source filter is "installed", surface as installed regardless
          // of the catalog row's original marketplace/local source.
          if (source === "installed") {
            existing.source = "installed";
          }
          continue;
        }
        byAppId.set(appId, {
          app_id: appId,
          name: appId,
          description: null,
          source: "installed",
          installed: true,
          provider_id: null,
          credential_source: null,
          archive_url: null,
        });
      }
    }

    let results = [...byAppId.values()];
    if (query) {
      results = results.filter((row) => {
        const haystack = `${row.app_id} ${row.name} ${row.description ?? ""}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    results.sort((a, b) => {
      // Installed first, then catalog source order, then alpha.
      if (a.installed !== b.installed) {
        return a.installed ? -1 : 1;
      }
      if (a.source !== b.source) {
        return a.source.localeCompare(b.source);
      }
      return a.app_id.localeCompare(b.app_id);
    });

    const catalogEmpty =
      catalogEntries.length === 0 && (source === "all" || source === "marketplace" || source === "local");
    const hint =
      catalogEmpty && results.length === 0
        ? "Catalog is empty. The user can populate it by opening the Marketplace tab in the desktop app once, which syncs the latest entries from the marketplace. After that, retry `workspace_apps_find`."
        : null;

    return {
      workspace_id: params.workspaceId,
      query: query || null,
      source,
      results: results.map((row) => ({
        app_id: row.app_id,
        name: row.name,
        description: row.description,
        source: row.source as string,
        installed: row.installed,
        provider_id: row.provider_id,
        credential_source: row.credential_source,
        archive_url: row.archive_url,
      })),
      count: results.length,
      ...(hint ? { hint } : {}),
    };
  }

  async installWorkspaceApp(
    params: RuntimeAgentToolsInstallWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const lifecycle = this.requireWorkspaceAppLifecycle();
    if (!lifecycle.installFromArchive) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_install_unavailable",
        "managed app install is not available in this runtime",
      );
    }
    const appId = sanitizeWorkspaceAppId(params.appId);

    const allEntries = this.store.listAppCatalogEntries();
    const candidates = allEntries.filter((entry) => entry.appId === appId);
    if (candidates.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "workspace_app_catalog_entry_not_found",
        `no catalog entry found for app '${appId}' — call workspace_apps_find first`,
      );
    }
    candidates.sort((a, b) => (a.source === "marketplace" ? -1 : b.source === "marketplace" ? 1 : 0));
    const entry = candidates[0]!;
    if (!entry.archiveUrl && !entry.archivePath) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_catalog_entry_no_archive",
        `catalog entry for '${appId}' has no archive_url or archive_path`,
      );
    }

    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const mcpServersBefore = readWorkspaceMcpRegistryServerNames(workspaceDir);

    const installResult = await lifecycle.installFromArchive({
      workspaceId: params.workspaceId,
      appId,
      archiveUrl: entry.archiveUrl,
      archivePath: entry.archivePath,
    });

    const mcpServersAfter = readWorkspaceMcpRegistryServerNames(workspaceDir);
    const newMcpServers = [...mcpServersAfter].filter((name) => !mcpServersBefore.has(name));

    if (!installResult.ok) {
      throw new RuntimeAgentToolsServiceError(
        installResult.statusCode ?? 500,
        "workspace_app_install_failed",
        installResult.error || installResult.detail || "install failed",
      );
    }

    const status = this.getWorkspaceAppStatus({
      workspaceId: params.workspaceId,
      appId,
    });

    const pendingIntegrations =
      entry.providerId
        ? [
            {
              app_id: appId,
              provider_id: entry.providerId,
              credential_source: entry.credentialSource,
            },
          ]
        : [];
    const integrationNote =
      pendingIntegrations.length > 0
        ? `This app needs a connected ${entry.providerId} account. Tell the user a Connect button is shown below your message — they can click it to authorize. Do not try to call the app's tools until they confirm the connection.`
        : null;

    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      source: entry.source,
      catalog_name: entry.name,
      provider_id: entry.providerId,
      credential_source: entry.credentialSource,
      ready: installResult.ready,
      detail: installResult.detail,
      error: installResult.error,
      status,
      ...buildSessionRefreshFields(newMcpServers),
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations, integration_note: integrationNote }
        : {}),
    };
  }

  async scaffoldWorkspaceApp(
    params: RuntimeAgentToolsScaffoldWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const appId = sanitizeWorkspaceAppId(params.appId);
    const name =
      normalizedString(params.name) || humanizeWorkspaceAppName(appId) || appId;
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const appDir = path.join(workspaceDir, "apps", appId);
    const overwrite = params.overwrite === true;

    await fs.mkdir(path.join(appDir, "src"), { recursive: true });

    const managedFiles = [
      "app.runtime.yaml",
      "package.json",
      "tsconfig.json",
      path.join("src", "server.ts"),
    ];

    if (!overwrite) {
      for (const relativePath of managedFiles) {
        if (existsSync(path.join(appDir, relativePath))) {
          throw new RuntimeAgentToolsServiceError(
            409,
            "workspace_app_scaffold_exists",
            `scaffold target already exists at apps/${appId}; pass overwrite=true to rewrite the managed starter files`,
          );
        }
      }
    }

    const files: Array<{ relativePath: string; content: string }> = [
      {
        relativePath: "app.runtime.yaml",
        content: scaffoldWorkspaceAppManifest({ appId, name }),
      },
      {
        relativePath: "package.json",
        content: scaffoldWorkspaceAppPackageJson({ appId }),
      },
      {
        relativePath: "tsconfig.json",
        content: scaffoldWorkspaceAppTsconfig(),
      },
      {
        relativePath: path.join("src", "server.ts"),
        content: scaffoldWorkspaceAppServerTs({ appId, name }),
      },
    ];

    for (const file of files) {
      const fullPath = path.join(appDir, file.relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, "utf8");
    }

    const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      app_dir: `apps/${appId}`,
      manifest_path: `apps/${appId}/app.runtime.yaml`,
      created_files: files.map((file) => `apps/${appId}/${file.relativePath.replace(/\\/g, "/")}`),
      overwritten: overwrite,
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations }
        : {}),
    };
  }

  async registerWorkspaceApp(
    params: RuntimeAgentToolsRegisterWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const appId = sanitizeWorkspaceAppId(params.appId);
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const configPath =
      normalizedString(params.configPath) || `apps/${appId}/app.runtime.yaml`;
    const manifestPath = resolveWorkspaceRelativePath(workspaceDir, configPath);
    if (!existsSync(manifestPath)) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "workspace_app_manifest_not_found",
        `manifest not found at ${configPath}`,
      );
    }

    let parsed;
    try {
      parsed = parseInstalledAppRuntime(
        await fs.readFile(manifestPath, "utf8"),
        appId,
        configPath.replace(/\\/g, "/"),
      );
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_manifest_invalid",
        error instanceof Error ? error.message : "invalid app.runtime.yaml",
      );
    }

    const appDir = path.dirname(manifestPath);
    const hostViolations = findForbiddenUpstreamHosts(appDir);
    if (hostViolations.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_upstream_host_hardcoded",
        formatHostLintError(hostViolations),
      );
    }

    // Two integrity lints for dashboard-shape apps (those with
    // `src/client/`). Both target observed bypasses where the library
    // is in the dep graph but no library primitives actually compose
    // the UI. Source-of-truth + rationale live in workspace-app-ui-lint.ts.
    //
    //   1. Minimum named imports from @holaboss/ui — catches the
    //      "import styles.css only, hand-roll every component" pattern.
    //   2. CSS import allowlist — catches the parallel-stylesheet
    //      pattern where the agent ships its own custom CSS file with
    //      hardcoded hex colors and shadow variables.
    const uiUsage = inspectDashboardUiUsage(appDir);
    const uiViolations = dashboardUiLintViolations(uiUsage);
    if (uiViolations.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        uiViolations[0]!.code,
        formatDashboardUiLintError(uiViolations),
      );
    }

    const lifecycle: Record<string, string> = {};
    if (parsed.lifecycle.setup) lifecycle.setup = parsed.lifecycle.setup;
    if (parsed.lifecycle.start) lifecycle.start = parsed.lifecycle.start;
    if (parsed.lifecycle.stop) lifecycle.stop = parsed.lifecycle.stop;

    let changed = false;
    updateWorkspaceApplications(workspaceDir, (applications) => {
      const nextEntry: Record<string, unknown> = {
        app_id: appId,
        config_path: parsed.configPath,
      };
      if (Object.keys(lifecycle).length > 0) {
        nextEntry.lifecycle = lifecycle;
      }
      const existingIndex = applications.findIndex((entry) => entry.app_id === appId);
      if (existingIndex >= 0) {
        const current = applications[existingIndex] ?? {};
        const sameConfig = current.config_path === parsed.configPath;
        const currentLifecycle = isRecord(current.lifecycle) ? current.lifecycle : null;
        const sameLifecycle =
          JSON.stringify(currentLifecycle ?? {}) === JSON.stringify(Object.keys(lifecycle).length > 0 ? lifecycle : {});
        if (sameConfig && sameLifecycle) {
          return applications;
        }
        applications[existingIndex] = nextEntry;
        changed = true;
        return applications;
      }
      applications.push(nextEntry);
      changed = true;
      return applications;
    });

    const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      config_path: parsed.configPath,
      lifecycle: Object.keys(lifecycle).length > 0 ? lifecycle : null,
      changed,
      registered: true,
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations }
        : {}),
    };
  }

  async buildWorkspaceApp(
    params: RuntimeAgentToolsBuildWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const appId = sanitizeWorkspaceAppId(params.appId);
    this.requireRegisteredWorkspaceApp({ workspaceId: params.workspaceId, appId });
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const resolved = resolveWorkspaceAppRuntime(workspaceDir, appId, {
      store: this.store,
      workspaceId: params.workspaceId,
      allocatePorts: true,
    });
    const packageJsonPath = path.join(resolved.appDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "workspace_app_package_not_found",
        `package.json not found for app '${appId}'`,
      );
    }

    let packageJson: unknown;
    try {
      packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_package_invalid",
        error instanceof Error ? error.message : "invalid package.json",
      );
    }

    const buildScript =
      isRecord(packageJson) && isRecord(packageJson.scripts) && typeof packageJson.scripts.build === "string"
        ? packageJson.scripts.build.trim()
        : "";
    const appDirRelative = path.relative(workspaceDir, resolved.appDir).replace(/\\/g, "/");
    const pendingIntegrationsSkip = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
    if (!buildScript) {
      return {
        workspace_id: params.workspaceId,
        app_id: appId,
        app_dir: appDirRelative,
        package_json_path: `${appDirRelative}/package.json`,
        build_script: null,
        command: null,
        skipped: true,
        reason: "no_build_script",
        ok: true,
        ...(pendingIntegrationsSkip.length > 0
          ? { pending_integrations: pendingIntegrationsSkip }
          : {}),
      };
    }

    const timeoutMs = normalizedInteger(
      params.timeoutMs ?? WORKSPACE_APP_BUILD_TIMEOUT_MS,
      WORKSPACE_APP_BUILD_TIMEOUT_MS,
      1_000,
      900_000,
    );
    const result = await runWorkspaceAppCommand({
      command: "npm run build",
      cwd: resolved.appDir,
      timeoutMs,
    });
    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      app_dir: appDirRelative,
      package_json_path: `${appDirRelative}/package.json`,
      build_script: buildScript,
      command: result.command,
      timeout_ms: timeoutMs,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      ok: !result.timedOut && (result.exitCode ?? 1) === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(pendingIntegrationsSkip.length > 0
        ? { pending_integrations: pendingIntegrationsSkip }
        : {}),
    };
  }

  getWorkspaceAppStatus(
    params: RuntimeAgentToolsGetWorkspaceAppStatusParams,
  ): JsonObject {
    const appId = normalizedString(params.appId);
    if (appId) {
      const entry = this.requireRegisteredWorkspaceApp({
        workspaceId: params.workspaceId,
        appId,
      });
      const statusEntry = this.workspaceAppStatusEntry({
        workspaceId: params.workspaceId,
        entry,
      });
      const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
      return {
        ...statusEntry,
        ...(pendingIntegrations.length > 0
          ? { pending_integrations: pendingIntegrations }
          : {}),
      };
    }

    const apps = this.listRegisteredWorkspaceAppEntries(params.workspaceId)
      .filter((entry) => typeof entry.app_id === "string" && entry.app_id.length > 0)
      .map((entry) =>
        this.workspaceAppStatusEntry({
          workspaceId: params.workspaceId,
          entry,
        }),
      );
    const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId);
    return {
      workspace_id: params.workspaceId,
      apps,
      count: apps.length,
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations }
        : {}),
    };
  }

  getWorkspaceAppPorts(
    params: RuntimeAgentToolsGetWorkspaceAppPortsParams,
  ): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const portsByApp = listWorkspaceApplicationPorts(workspaceDir, {
      store: this.store,
      workspaceId: params.workspaceId,
      allocatePorts: true,
    });
    const appId = normalizedString(params.appId);
    if (appId) {
      this.requireRegisteredWorkspaceApp({
        workspaceId: params.workspaceId,
        appId,
      });
      const ports = portsByApp[appId];
      return {
        workspace_id: params.workspaceId,
        app_id: appId,
        ports: ports ? { http: ports.http, mcp: ports.mcp } : null,
      };
    }

    const apps = Object.entries(portsByApp).map(([registeredAppId, ports]) => ({
      app_id: registeredAppId,
      ports: { http: ports.http, mcp: ports.mcp },
    }));
    return {
      workspace_id: params.workspaceId,
      apps,
      count: apps.length,
    };
  }

  async ensureWorkspaceAppsRunning(
    params: RuntimeAgentToolsEnsureWorkspaceAppsRunningParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const lifecycle = this.requireWorkspaceAppLifecycle();
    const requestedAppIds = normalizedStringList(params.appIds);
    const targetAppIds =
      requestedAppIds.length > 0
        ? requestedAppIds.map((appId) => sanitizeWorkspaceAppId(appId))
        : this.listRegisteredWorkspaceAppEntries(params.workspaceId)
            .map((entry) => (typeof entry.app_id === "string" ? entry.app_id : ""))
            .filter((appId) => appId.length > 0);

    if (targetAppIds.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "workspace_apps_empty",
        "no registered workspace apps found",
      );
    }

    for (const appId of targetAppIds) {
      this.requireRegisteredWorkspaceApp({ workspaceId: params.workspaceId, appId });
    }

    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const mcpServersBefore = readWorkspaceMcpRegistryServerNames(workspaceDir);

    if (requestedAppIds.length === 0 && lifecycle.ensureAllAppsRunning) {
      await lifecycle.ensureAllAppsRunning(params.workspaceId);
    } else if (lifecycle.ensureAppRunning) {
      for (const appId of targetAppIds) {
        await lifecycle.ensureAppRunning(params.workspaceId, appId);
      }
    } else {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_ensure_running_unavailable",
        "managed app startup is not available in this runtime",
      );
    }

    // PR 1: opportunistically bootstrap the composio-mcp host alongside
    // app startup. Failures here never fail the call — composio direct
    // tools are additive; without them the agent still has app tools.
    if (this.options.composioMcpManager) {
      try {
        await this.options.composioMcpManager.ensureRunning(params.workspaceId);
      } catch {
        // manager already logs; nothing else to do
      }
    }

    const mcpServersAfter = readWorkspaceMcpRegistryServerNames(workspaceDir);
    const newMcpServers = [...mcpServersAfter].filter((name) => !mcpServersBefore.has(name));
    const pendingIntegrations = pendingIntegrationsFromAppManifests({
      workspaceDir,
      appIds: targetAppIds,
      store: this.store,
      workspaceId: params.workspaceId,
    });

    const statusResult = this.getWorkspaceAppStatus({
      workspaceId: params.workspaceId,
    });

    // ---------------------------------------------------------------
    // Post-build polish-pass auto-queue (dashboard apps only).
    //
    // Forensic context: forcing the agent to do an interface-design
    // refactor pass in the SAME turn as the build consistently
    // resulted in checkbox-compliance (skill invoked, 1 trivial edit,
    // done) — see docs/plans/2026-05-22-interface-design-skill-noop-
    // forensic.md. The single observed successful polish happened in
    // a SEPARATE turn that the user manually triggered with "use
    // skill interface-design to polish this dashboard". Splitting
    // across turns is the load-bearing property: fresh context,
    // narrow scope, no build-time fatigue.
    //
    // What this does: when this call brings a dashboard-shape app to
    // a healthy state and the caller carries a session id, enqueue a
    // polish-only input on the user-facing main session. The queue
    // worker dispatches it as a new turn after the current one ends;
    // the agent then runs the polish prompt against the just-built
    // app with the rules in fresh context. Idempotency is keyed by
    // (session, app) so repeat ensure-running calls during the build
    // do not re-trigger.
    // ---------------------------------------------------------------
    const polishCallerSessionId =
      typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    const polishPassQueued: JsonObject[] = [];
    // Defer polish when ANY of the apps have unresolved integrations.
    // Polish takes a browser_screenshot to evaluate the layout — if the
    // app is rendering its `integration_not_bound` empty state instead
    // of real chrome with real data, the screenshot tells the agent
    // nothing about whether the layout is right. The next ensure-running
    // call after the user binds will re-trigger this code path with an
    // empty pending list and the polish will queue properly.
    const polishBlockedByPendingIntegrations = pendingIntegrations.length > 0;
    if (polishCallerSessionId && !polishBlockedByPendingIntegrations) {
      const polishSessionId = resolvePolishTargetSession(
        this.store,
        params.workspaceId,
        polishCallerSessionId,
      );
      for (const appId of targetAppIds) {
        if (!appIsDashboardShape(workspaceDir, appId)) continue;
        const idempotencyKey = `polish-pass:${polishSessionId}:${appId}`;
        try {
          const input = this.store.enqueueInput({
            workspaceId: params.workspaceId,
            sessionId: polishSessionId,
            idempotencyKey,
            payload: {
              text: buildPolishPassPrompt(appId),
              image_urls: [],
              context: {
                source: "runtime_auto_queue",
                source_type: "post_build_polish_pass",
                app_id: appId,
                caller_session_id: polishCallerSessionId,
              },
            },
          });
          polishPassQueued.push({
            app_id: appId,
            input_id: input.inputId,
            session_id: polishSessionId,
          });
        } catch {
          // Best-effort. A failure to enqueue should never break the
          // ensure-running response; the agent can still complete its
          // current turn.
        }
      }
    }

    return {
      workspace_id: params.workspaceId,
      app_ids: targetAppIds,
      count: targetAppIds.length,
      status: statusResult,
      ...buildSessionRefreshFields(newMcpServers),
      ...(pendingIntegrations.length > 0 ? { pending_integrations: pendingIntegrations } : {}),
      ...(polishPassQueued.length > 0
        ? { polish_pass_queued: polishPassQueued }
        : {}),
    };
  }

  async restartWorkspaceApp(
    params: RuntimeAgentToolsRestartWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const lifecycle = this.requireWorkspaceAppLifecycle();
    const appId = sanitizeWorkspaceAppId(params.appId);
    this.requireRegisteredWorkspaceApp({ workspaceId: params.workspaceId, appId });

    if (!lifecycle.stopApp || !lifecycle.ensureAppRunning) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_restart_unavailable",
        "managed app restart is not available in this runtime",
      );
    }

    await lifecycle.stopApp(params.workspaceId, appId);
    await lifecycle.ensureAppRunning(params.workspaceId, appId);
    const status = this.getWorkspaceAppStatus({
      workspaceId: params.workspaceId,
      appId,
    });
    const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      restarted: true,
      status,
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations }
        : {}),
    };
  }

  async restartAndWaitUntilWorkspaceAppReady(
    params: RuntimeAgentToolsRestartAndWaitWorkspaceAppReadyParams,
  ): Promise<JsonObject> {
    const appId = sanitizeWorkspaceAppId(params.appId);
    await this.restartWorkspaceApp({
      workspaceId: params.workspaceId,
      appId,
    });
    const waited = await this.waitUntilWorkspaceAppReady({
      workspaceId: params.workspaceId,
      appId,
      timeoutMs: params.timeoutMs,
      pollIntervalMs: params.pollIntervalMs,
    });
    return {
      ...(waited as JsonObject),
      restarted: true,
    };
  }

  async waitUntilWorkspaceAppReady(
    params: RuntimeAgentToolsWaitUntilWorkspaceAppReadyParams,
  ): Promise<JsonObject> {
    const appId = sanitizeWorkspaceAppId(params.appId);
    this.requireRegisteredWorkspaceApp({ workspaceId: params.workspaceId, appId });
    const timeoutMs = normalizedInteger(params.timeoutMs ?? 60_000, 60_000, 1, 300_000);
    const pollIntervalMs = normalizedInteger(
      params.pollIntervalMs ?? 1_000,
      1_000,
      50,
      10_000,
    );
    const startedAt = Date.now();
    let polls = 0;

    while (Date.now() - startedAt <= timeoutMs) {
      polls += 1;
      const status = this.getWorkspaceAppStatus({
        workspaceId: params.workspaceId,
        appId,
      });
      if (status.ready === true || status.build_status === "failed") {
        const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
        return {
          ...(status as JsonObject),
          timed_out: false,
          polls,
          elapsed_ms: Date.now() - startedAt,
          ...(pendingIntegrations.length > 0
            ? { pending_integrations: pendingIntegrations }
            : {}),
        };
      }
      await sleep(pollIntervalMs);
    }

    const status = this.getWorkspaceAppStatus({
      workspaceId: params.workspaceId,
      appId,
    });
    const pendingIntegrations = this.pendingIntegrationsForApps(params.workspaceId, [appId]);
    return {
      ...(status as JsonObject),
      timed_out: true,
      polls,
      elapsed_ms: Date.now() - startedAt,
      ...(pendingIntegrations.length > 0
        ? { pending_integrations: pendingIntegrations }
        : {}),
    };
  }

  async probeWorkspaceAppEndpoints(
    params: RuntimeAgentToolsProbeWorkspaceAppEndpointsParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const appId = sanitizeWorkspaceAppId(params.appId);
    this.requireRegisteredWorkspaceApp({ workspaceId: params.workspaceId, appId });
    const requestedChecks = normalizedStringList(params.checks);
    const invalidChecks = requestedChecks.filter((value) => !isWorkspaceAppEndpointProbeCheck(value));
    if (invalidChecks.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_probe_invalid_checks",
        `unsupported checks: ${invalidChecks.join(", ")}`,
      );
    }
    const checks = (
      requestedChecks.length > 0
        ? requestedChecks
        : [...WORKSPACE_APP_ENDPOINT_PROBE_CHECKS]
    ) as WorkspaceAppEndpointProbeCheck[];
    const timeoutMs = normalizedInteger(
      params.timeoutMs ?? WORKSPACE_APP_PROBE_TIMEOUT_MS,
      WORKSPACE_APP_PROBE_TIMEOUT_MS,
      100,
      60_000,
    );
    const workspaceDir = path.join(this.options.workspaceRoot, params.workspaceId);
    const resolved = resolveWorkspaceAppRuntime(workspaceDir, appId, {
      store: this.store,
      workspaceId: params.workspaceId,
      allocatePorts: true,
    });
    const uiBaseUrl = `http://127.0.0.1:${resolved.ports.http}`;
    const mcpBaseUrl = `http://127.0.0.1:${resolved.ports.mcp}`;
    const mcpSsePath = normalizedString(resolved.resolvedApp.mcp.path) || "/mcp/sse";
    const derivedMessagePath = workspaceAppMessagePath(mcpSsePath);
    const healthPath = normalizedString(resolved.resolvedApp.healthCheck.path) || "/mcp/health";
    const healthBaseUrl =
      resolved.resolvedApp.healthCheck.target === "api" ? uiBaseUrl : mcpBaseUrl;
    const healthUrl = `${healthBaseUrl}${healthPath}`;
    let discoveredMessagePath = derivedMessagePath;
    const currentStatus = this.getWorkspaceAppStatus({
      workspaceId: params.workspaceId,
      appId,
    });
    const results: JsonObject[] = [];

    for (const check of checks) {
      try {
        if (check === "ui") {
          const probe = await fetchWorkspaceAppProbe({
            url: `${uiBaseUrl}/`,
            timeoutMs,
          });
          results.push({
            check,
            ok: probe.ok,
            url: `${uiBaseUrl}/`,
            method: "GET",
            status_code: probe.statusCode,
            content_type: probe.contentType,
            body_excerpt: probe.bodyText.slice(0, 500),
          });
          continue;
        }

        if (check === "mcp_health") {
          const probe = await fetchWorkspaceAppProbe({
            url: healthUrl,
            timeoutMs,
          });
          const discoveredBody = probe.jsonBody;
          if (isRecord(discoveredBody) && typeof discoveredBody.message_path === "string") {
            discoveredMessagePath = normalizedString(discoveredBody.message_path) || discoveredMessagePath;
          }
          results.push({
            check,
            ok: probe.ok,
            url: healthUrl,
            method: "GET",
            status_code: probe.statusCode,
            content_type: probe.contentType,
            body: probe.jsonBody && isRecord(probe.jsonBody)
              ? (probe.jsonBody as JsonObject)
              : probe.bodyText.slice(0, 500),
          });
          continue;
        }

        if (check === "mcp_initialize" || check === "mcp_tools_list") {
          const body =
            check === "mcp_initialize"
              ? {
                  jsonrpc: "2.0",
                  id: "probe-initialize",
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: {
                      name: "runtime-agent-tools",
                      version: "0.1.0",
                    },
                  },
                }
              : {
                  jsonrpc: "2.0",
                  id: "probe-tools-list",
                  method: "tools/list",
                  params: {},
                };
          const messageUrl = `${mcpBaseUrl}${discoveredMessagePath}`;
          const probe = await fetchWorkspaceAppProbe({
            url: messageUrl,
            method: "POST",
            timeoutMs,
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const json = probe.jsonBody;
          const toolCount =
            check === "mcp_tools_list" &&
              isRecord(json) &&
              isRecord(json.result) &&
              Array.isArray(json.result.tools)
              ? json.result.tools.length
              : null;
          results.push({
            check,
            ok: probe.ok,
            url: messageUrl,
            method: "POST",
            status_code: probe.statusCode,
            content_type: probe.contentType,
            tool_count: toolCount,
            body: json && isRecord(json) ? (json as JsonObject) : probe.bodyText.slice(0, 500),
          });
        }
      } catch (error) {
        results.push({
          check,
          ok: false,
          error: error instanceof Error ? error.message : "probe failed",
        });
      }
    }

    return {
      workspace_id: params.workspaceId,
      app_id: appId,
      timeout_ms: timeoutMs,
      ports: {
        http: resolved.ports.http,
        mcp: resolved.ports.mcp,
      },
      checks: results,
      all_ok: results.every((entry) => entry.ok === true),
      count: results.length,
      status: currentStatus,
    };
  }

  describeDataTable(
    params: RuntimeAgentToolsDescribeDataTableParams,
  ): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );
    const tableName = normalizedString(params.tableName);
    if (!tableName) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "table_name_required",
        "table_name is required",
      );
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      if (isRuntimeInternalTable(tableName)) {
        throw new RuntimeAgentToolsServiceError(
          404,
          "table_not_found",
          `table "${tableName}" not found`,
        );
      }
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
        .get(tableName) as { 1?: number } | undefined;
      if (!exists) {
        throw new RuntimeAgentToolsServiceError(
          404,
          "table_not_found",
          `table "${tableName}" not found`,
        );
      }
      const quoted = quoteSqlIdentifier(tableName);
      const columns = db
        .prepare(`PRAGMA table_info(${quoted})`)
        .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const rowCount = db
        .prepare(`SELECT COUNT(*) AS c FROM ${quoted}`)
        .get() as { c: number };
      return {
        workspace_id: params.workspaceId,
        table_name: tableName,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          not_null: Boolean(column.notnull),
          primary_key: Boolean(column.pk),
        })),
        row_count: rowCount.c,
        system_table: isSystemTable(tableName),
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        throw error;
      }
      throw new RuntimeAgentToolsServiceError(
        500,
        "describe_data_table_failed",
        error instanceof Error ? error.message : "Failed to describe data table",
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

  sampleDataTableRows(
    params: RuntimeAgentToolsSampleDataTableRowsParams,
  ): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const description = this.describeDataTable({
      workspaceId: params.workspaceId,
      tableName: params.tableName,
    });
    const tableName = String(description.table_name ?? "");
    const limit = normalizedInteger(params.limit ?? 5, 5, 1, 25);
    const offset = normalizedInteger(params.offset ?? 0, 0, 0, 10_000);
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      const rows = db
        .prepare(
          `SELECT * FROM ${quoteSqlIdentifier(tableName)} LIMIT ${limit} OFFSET ${offset}`,
        )
        .all() as Array<Record<string, JsonValue>>;
      return {
        workspace_id: params.workspaceId,
        table_name: tableName,
        limit,
        offset,
        rows,
        row_count: rows.length,
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        throw error;
      }
      throw new RuntimeAgentToolsServiceError(
        500,
        "sample_data_table_rows_failed",
        error instanceof Error ? error.message : "Failed to sample data table rows",
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

  queryWorkspaceData(
    params: RuntimeAgentToolsQueryWorkspaceDataParams,
  ): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const query = normalizeWorkspaceDataQuery(params.query);
    const limit = normalizedInteger(
      params.limit ?? WORKSPACE_DATA_QUERY_DEFAULT_LIMIT,
      WORKSPACE_DATA_QUERY_DEFAULT_LIMIT,
      1,
      WORKSPACE_DATA_QUERY_MAX_LIMIT,
    );
    const offset = normalizedInteger(
      params.offset ?? 0,
      0,
      0,
      WORKSPACE_DATA_QUERY_MAX_OFFSET,
    );
    const timeoutMs = normalizedInteger(
      params.timeoutMs ?? WORKSPACE_DATA_QUERY_DEFAULT_TIMEOUT_MS,
      WORKSPACE_DATA_QUERY_DEFAULT_TIMEOUT_MS,
      1,
      WORKSPACE_DATA_QUERY_MAX_TIMEOUT_MS,
    );
    const dbPath = ensureWorkspaceDataDb(
      path.join(this.options.workspaceRoot, params.workspaceId),
    );

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      db.pragma(`busy_timeout = ${timeoutMs}`);

      const prepared = db.prepare(query);
      const columnMetadata = prepared.columns() as Array<{
        name?: string | null;
        type?: string | null;
      }>;
      const wrapped = db.prepare(
        `SELECT * FROM (${query}) AS workspace_data_query_result LIMIT ${limit + 1} OFFSET ${offset}`,
      );
      const startedAt = Date.now();
      const rawRows = wrapped.all() as Array<Record<string, unknown>>;
      const elapsedMs = Date.now() - startedAt;
      const truncated = rawRows.length > limit;
      const rows = rawRows
        .slice(0, limit)
        .map((row) => workspaceDataQueryRowToJson(row));

      return {
        workspace_id: params.workspaceId,
        query,
        limit,
        offset,
        timeout_ms: timeoutMs,
        elapsed_ms: elapsedMs,
        row_count: rows.length,
        truncated,
        columns: columnMetadata.map((column) => ({
          name: typeof column.name === "string" && column.name.trim() ? column.name : "column",
          type: typeof column.type === "string" && column.type.trim() ? column.type : "UNKNOWN",
        })),
        rows,
      };
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        throw error;
      }
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_data_query_failed",
        error instanceof Error ? error.message : "Failed to query workspace data",
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

  proposeIntegrationConnect(params: {
    workspaceId: string;
    toolkitSlug: string;
    reason?: string;
  }): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const slug = params.toolkitSlug.trim().toLowerCase();
    if (!slug) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "toolkit_slug_required",
        "toolkit_slug is required",
      );
    }
    const entry = getStoreCatalogEntry(slug);
    if (!entry) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "toolkit_not_in_store_catalog",
        `Toolkit '${slug}' is not in the integration store catalog. Use one of the supported slugs.`,
      );
    }
    const reason =
      typeof params.reason === "string" && params.reason.trim().length > 0
        ? params.reason.trim()
        : null;
    // The chat UI parses `proposed_integration` and renders a Connect
    // card; agent should NOT write its own connect copy in the reply.
    return {
      proposed_integration: {
        toolkit_slug: slug,
        tier: entry.tier,
        category: entry.category,
        ...(reason ? { reason } : {}),
      },
    };
  }

  // Introspects the workspace's shared SQLite (data.db) and returns the
  // tables module apps have created. Shared by the deterministic
  // workspace-data inspection routes so agents can discover real sources
  // of truth and their shapes. Read-only — opens the file with PRAGMA
  // query_only and closes it before returning.
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
          "Pass include_system=true if you genuinely need them — they usually are not relevant to user-facing app experiences.";
      }
      return result;
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        500,
        "workspace_data_list_tables_failed",
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

}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function normalizeWorkspaceDataQuery(value: string): string {
  const trimmed = normalizedString(value);
  if (!trimmed) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_data_query_required",
      "query is required",
    );
  }

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "").trim();
  const surface = stripSqlStringsAndComments(withoutTrailingSemicolon).trim();
  if (!surface) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_data_query_required",
      "query is required",
    );
  }
  if (surface.includes(";")) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_data_query_multiple_statements",
      "only a single SQL statement is allowed",
    );
  }

  const firstToken = surface.match(/^([a-z]+)/i)?.[1]?.toLowerCase() ?? "";
  if (firstToken !== "select" && firstToken !== "with") {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_data_query_unsafe",
      "only read-only SELECT queries are allowed",
    );
  }

  if (
    /\b(insert|update|delete|alter|drop|create|attach|detach|pragma|vacuum|reindex|analyze|replace|upsert|merge|begin|commit|rollback)\b/i
      .test(surface)
  ) {
    throw new RuntimeAgentToolsServiceError(
      400,
      "workspace_data_query_unsafe",
      "query contains non-read-only SQL",
    );
  }

  return withoutTrailingSemicolon;
}

function stripSqlStringsAndComments(value: string): string {
  let out = "";
  let mode:
    | "normal"
    | "single_quote"
    | "double_quote"
    | "backtick"
    | "line_comment"
    | "block_comment" = "normal";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1] ?? "";

    if (mode === "normal") {
      if (char === "'" ) {
        mode = "single_quote";
        out += " ";
        continue;
      }
      if (char === "\"") {
        mode = "double_quote";
        out += " ";
        continue;
      }
      if (char === "`") {
        mode = "backtick";
        out += " ";
        continue;
      }
      if (char === "-" && next === "-") {
        mode = "line_comment";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block_comment";
        out += "  ";
        index += 1;
        continue;
      }
      out += char;
      continue;
    }

    if (mode === "single_quote") {
      if (char === "'" && next === "'") {
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "'") {
        mode = "normal";
      }
      out += char === "\n" ? "\n" : " ";
      continue;
    }

    if (mode === "double_quote") {
      if (char === "\"" && next === "\"") {
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "\"") {
        mode = "normal";
      }
      out += char === "\n" ? "\n" : " ";
      continue;
    }

    if (mode === "backtick") {
      if (char === "`" && next === "`") {
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "`") {
        mode = "normal";
      }
      out += char === "\n" ? "\n" : " ";
      continue;
    }

    if (mode === "line_comment") {
      if (char === "\n") {
        mode = "normal";
        out += "\n";
        continue;
      }
      out += " ";
      continue;
    }

    if (char === "*" && next === "/") {
      mode = "normal";
      out += "  ";
      index += 1;
      continue;
    }
    out += char === "\n" ? "\n" : " ";
  }

  return out;
}

function workspaceDataQueryValueToJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => workspaceDataQueryValueToJson(entry));
  }
  if (typeof value === "object" && value !== null) {
    const objectValue: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      objectValue[key] = workspaceDataQueryValueToJson(entry);
    }
    return objectValue;
  }
  return String(value);
}

function workspaceDataQueryRowToJson(row: Record<string, unknown>): Record<string, JsonValue> {
  const normalizedRow: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) {
    normalizedRow[key] = workspaceDataQueryValueToJson(value);
  }
  return normalizedRow;
}
