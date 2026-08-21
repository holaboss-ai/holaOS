import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { CronExpressionParser } from "cron-parser";
import yaml from "js-yaml";

import {
  type AgentSessionRecord,
  type AppBuildRecord,
  type IssueAttachmentRecord,
  type IssueBlockedByRecord,
  type IssueRecord,
  type IssueStatus,
  type RuntimeNotificationLevel,
  type RuntimeNotificationPriority,
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

import { listConnectionsMerged } from "./integration-connections-merged.js";

import { RUNTIME_AGENT_TOOL_DEFINITIONS as RUNTIME_AGENT_TOOL_BASE_DEFINITIONS } from "../../harnesses/src/runtime-agent-tools.js";
import {
  clearPiMcpToolCache,
  readMcpOAuthAccessToken,
  writeMcpAuthRequiredMarker,
} from "../../harnesses/src/index.js";
import { buildAppSetupEnv } from "./app-setup-env.js";
import { invalidateComposioInlineToolCache } from "./composio-cache-invalidation.js";
import { listHarnessAvailability } from "./harness-availability.js";
import { resolveRuntimeHarnessPlugin } from "./harness-registry.js";
import {
  cronjobNextRunAt,
  cronjobMetadataWithResolvedTimezone,
  runtimeUserTimezone,
} from "./cron-worker.js";
import { generateWorkspaceImage } from "./image-generation.js";
import { generateWorkspaceVideo } from "./video-generation.js";
import { searchPublicWeb } from "./native-web-search.js";
import { killChildProcess, spawnShellCommand } from "./runtime-shell.js";
import { resolveSubagentExecutionProfile } from "./subagent-model.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";
import { ssrfSafeFetch } from "./ssrf-guard.js";
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
import type { MemoryRetrievalPolicy } from "./memory-hybrid-retrieval.js";
import { retrieveWorkspaceMemory, type WorkspaceMemoryCategory } from "./workspace-memory.js";
import { BrokerError, type IntegrationBrokerService } from "./integration-broker.js";
import { getStoreCatalogEntry, listStoreCatalog } from "./integration-store-catalog.js";
import {
  invokeWorkspaceSkill,
  projectSessionVisibleWorkspaceSkills,
  resolveWorkspaceSkills,
} from "./workspace-skills.js";
import {
  listWorkspaceApplicationPorts,
  listWorkspaceApplications,
  listWorkspaceMcpRegistryServers,
  parseInstalledAppRuntime,
  parseResolvedAppRuntime,
  readWorkspaceMcpRegistryServerNames,
  readWorkspaceYamlDocument,
  resolveWorkspaceAppRuntime,
  type ResolvedApplicationSmokeTest,
  updateWorkspaceApplications,
  upsertWorkspaceMcpServerEntry,
} from "./workspace-apps.js";
import { authorizeMcpServerViaHost } from "./mcp-authorize-host.js";
import { installWorkspaceAuthoredCapability } from "./workspace-capabilities.js";
import {
  INTEGRATION_CATALOG_PROVIDERS,
  integrationCatalogProviderIds,
} from "./integration-catalog.js";
import {
  findProviderEffectManifestViolations,
  findForbiddenUpstreamHosts,
  formatProviderEffectManifestLintError,
  formatHostLintError,
} from "./workspace-app-host-lint.js";
import {
  dashboardUiLintViolations,
  formatDashboardUiLintError,
  inspectDashboardUiUsage,
} from "./workspace-app-ui-lint.js";
import { preferredCoordinatorSessionId } from "./coordinator-session-routing.js";
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

/** Per-app visual signature manifest. Written by the agent at the end
 *  of each polish pass; read by future polish passes for sibling apps
 *  in the same workspace to enforce signature divergence. Stored at
 *  `apps/{appId}/.signature.json`. */
type AppSignature = {
  app_id: string;
  captured_at: string;
  typography: string;
  palette: string;
  layout_archetype: string;
  hero_treatment: string;
  density: string;
};

/** Read `.signature.json` for every dashboard-shape app in the workspace
 *  except `excludeAppId`. Malformed or missing files are silently
 *  skipped — the constraint degrades gracefully (an app with no
 *  signature manifest simply isn't in the "must differ from" set). */
function readWorkspaceSignatures(workspaceDir: string, excludeAppId: string): AppSignature[] {
  const appsDir = path.join(workspaceDir, "apps");
  let entries: string[];
  try {
    entries = readdirSync(appsDir);
  } catch {
    return [];
  }
  const signatures: AppSignature[] = [];
  for (const appId of entries) {
    if (appId === excludeAppId) continue;
    if (!appIsDashboardShape(workspaceDir, appId)) continue;
    const signaturePath = path.join(appsDir, appId, ".signature.json");
    if (!existsSync(signaturePath)) continue;
    try {
      const raw = readFileSync(signaturePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSignature>;
      if (
        typeof parsed.typography === "string" &&
        typeof parsed.palette === "string" &&
        typeof parsed.layout_archetype === "string" &&
        typeof parsed.hero_treatment === "string" &&
        typeof parsed.density === "string"
      ) {
        signatures.push({
          app_id: typeof parsed.app_id === "string" ? parsed.app_id : appId,
          captured_at: typeof parsed.captured_at === "string" ? parsed.captured_at : "",
          typography: parsed.typography,
          palette: parsed.palette,
          layout_archetype: parsed.layout_archetype,
          hero_treatment: parsed.hero_treatment,
          density: parsed.density,
        });
      }
    } catch {
      // malformed manifest; skip without failing the polish pass.
    }
  }
  return signatures;
}

function formatExistingSignaturesBlock(signatures: AppSignature[]): string {
  if (signatures.length === 0) {
    return [
      "No sibling dashboard apps have declared a signature yet — this is the first one in the workspace.",
      "Make a deliberate, specific choice for every axis below. Every later app in this workspace will be required to differ from yours, so vague labels (\"custom\", \"modern\", \"unique\") will cripple future apps' ability to demonstrate divergence.",
    ].join("\n");
  }
  const lines = ["The following sibling dashboard apps in this workspace have already declared visual signatures:", ""];
  for (const sig of signatures) {
    lines.push(`  • \`${sig.app_id}\``);
    lines.push(`      typography: ${sig.typography}`);
    lines.push(`      palette: ${sig.palette}`);
    lines.push(`      layout_archetype: ${sig.layout_archetype}`);
    lines.push(`      hero_treatment: ${sig.hero_treatment}`);
    lines.push(`      density: ${sig.density}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
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
 *
 * Step 0 (workspace signature constraint) is the one exception to the
 * "purely operational" rule: it injects a stateful list of sibling-app
 * signatures and requires the new app to differ from each on ≥2 of 5
 * axes. This exists because interface-design's "find your signature"
 * doctrine has no cross-app visibility — every app independently
 * converges to the same training-prior default (typically an editorial
 * dashboard signature for analytics-shape apps). Injecting siblings
 * gives the skill the workspace context it needs to actually diverge.
 */
function buildPolishPassPrompt(appId: string, existingSignatures: AppSignature[]): string {
  return [
    "[Auto-queued post-build polish pass]",
    "",
    `The dashboard app \`${appId}\` was just confirmed running in this workspace. Before continuing with anything else, perform a design polish pass on its src/client/.`,
    "",
    "ORIENTATION (re-read at every checkpoint below).",
    "",
    "The dashboard is the user's tool, not a thing about itself. They open it to do work — read state, take action, decide what's next. Hero space goes to what they need to act on; chrome space to what the app does. The user should walk into work-in-progress, not into an introduction.",
    "",
    "If the rendered output reads like a magazine cover, a portfolio page, or a description of the app's capabilities, you have made the wrong thing — even if the spatial sketch is correct and the skill rules were followed. Linear's project view is the neighborhood. The app's homepage is not.",
    "",
    "0. WORKSPACE SIGNATURE CONSTRAINT (read this first — it shapes every choice in the steps below).",
    "",
    formatExistingSignaturesBlock(existingSignatures),
    "",
    "Your design MUST differ from EVERY existing signature on AT LEAST 2 of these 5 axes:",
    "  - typography (typeface family + hero scale, e.g. serif-hero, sans-stack, mono-dense, mixed-editorial)",
    "  - palette (dominant color world, e.g. dark-navy, light-paper, warm-cream, cold-terminal, forest-green)",
    "  - layout_archetype (macro spatial pattern, e.g. command-deck, time-rail, kanban, card-grid, split-pane, instrument-panel)",
    "  - hero_treatment (large-serif-headline, compact-title, no-hero, metric-led, status-strip, etc.)",
    "  - density (one of: spacious, balanced, dense, hyper-dense)",
    "",
    "When the interface-design skill's \"find your signature\" exploration suggests a direction that matches >3 of these axes against ANY existing app, REJECT that direction and explore a different one. Sameness across the workspace is the failure mode this constraint exists to prevent — if every app in this workspace ends up reading as the same product, the constraint has failed.",
    "",
    "1. Invoke `skill({ name: \"interface-design\" })` to load the design rules. Read its full output, including any `.interface-design/system.md` artifact it writes to disk. Apply step 0's constraint AS YOU DO the skill's domain/color-world exploration — do not run the exploration first and then check the constraint after.",
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
    "4. Verify with `browser_screenshot({ full_page: true })`. The default viewport-only screenshot hides everything below the fold — a dashboard taller than 800px ends up reviewed only at the hero, and the lower regions silently ship whatever the first heredoc produced. With `full_page: true` the entire scrollable surface comes back in one image; review it end to end. Compare against the spatial sketch from step 1.5, the `interface-design` rules, AND the sibling signatures listed in step 0: if your rendered output reads as the same product as any sibling (same hero shape + same palette family + same overall vibe), the constraint has failed even if your declared labels look different on paper. If the screenshot doesn't match the sketch, the skill rules, OR fails the divergence check, return to step 2 and rewrite again. Two iterations is normal.",
    "",
    `5. Write your final signature declaration to \`apps/${appId}/.signature.json\` via \`bash\` heredoc (\`cat > apps/${appId}/.signature.json <<'EOF' ... EOF\`). Use this exact schema:`,
    "",
    "    {",
    `      "app_id": "${appId}",`,
    "      \"captured_at\": \"<ISO-8601 UTC timestamp, e.g. 2026-05-30T10:57:12Z>\",",
    "      \"typography\": \"<kebab-case label>\",",
    "      \"palette\": \"<kebab-case label>\",",
    "      \"layout_archetype\": \"<kebab-case label>\",",
    "      \"hero_treatment\": \"<kebab-case label>\",",
    "      \"density\": \"<one of: spacious, balanced, dense, hyper-dense>\"",
    "    }",
    "",
    "    These labels are how future polish passes for sibling apps know what to differ from. Be specific and accurate — labels must describe what you ACTUALLY built, not what you wished you built. Vague labels (\"custom\", \"modern\", \"unique\", \"refined\") defeat the constraint for the next app and are not acceptable.",
    "",
    "6. Only after the screenshot matches the sketch AND the interface-design rules AND the divergence check AND the signature manifest is written, declare the polish pass done.",
    "",
    "The user is the one who will see the rendered UI. A clean tool-call ceremony without visible visual improvement fails this pass — there is no half-credit for invoking the skill, doing trivial edits, and reporting 'looks good'. Producing a signature that visually duplicates a sibling app also fails this pass, even if every other step was performed.",
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

function resolvePolishQueueTarget(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  callerSessionId: string;
}): {
  sessionId: string;
  continueSubagentRun: boolean;
} {
  try {
    const run = params.store.getSubagentRunByChildSession({
      workspaceId: params.workspaceId,
      childSessionId: params.callerSessionId,
    });
    if (run) {
      return {
        sessionId: params.callerSessionId,
        continueSubagentRun: true,
      };
    }
  } catch {
    // store lookup is best-effort; fall through to main-session routing.
  }
  return {
    sessionId: resolvePolishTargetSession(
      params.store,
      params.workspaceId,
      params.callerSessionId,
    ),
    continueSubagentRun: false,
  };
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
type JsonArray = JsonValue[];

function isJsonObject(value: JsonValue | null | undefined): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asJsonArray(value: JsonValue | null | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

const SUBAGENT_CANCEL_SETTLE_TIMEOUT_MS = 8_000;
const SUBAGENT_CANCEL_SETTLE_POLL_INTERVAL_MS = 50;
const WORKSPACE_APP_BUILD_TIMEOUT_MS = 180_000;
const WORKSPACE_APP_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_LOCAL_APP_ACTION_API_PATH = "/__holaboss/actions/run";
const WORKSPACE_APP_ENDPOINT_PROBE_CHECKS = [
  "ui",
  "mcp_health",
  "mcp_initialize",
  "mcp_tools_list",
] as const;
const REPORT_FILE_EXTENSION = ".html";
const REPORT_MIME_TYPE = "text/html";

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
  projectId?: string | null;
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
  projectId?: string | null;
}

export interface RuntimeAgentToolsDelegateTaskItem {
  blockedBy?: IssueBlockedByRecord[] | null;
  title?: string | null;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
  model?: string | null;
  timeoutMs?: number | null;
}

export interface RuntimeAgentToolsDelegateTaskParams {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
  selectedModel?: string | null;
  tasks: RuntimeAgentToolsDelegateTaskItem[];
  createdBy?: string | null;
}

export interface RuntimeAgentToolsGetTaskParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  taskId: string;
}

export interface RuntimeAgentToolsListTasksParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  statuses?: string[] | null;
  limit?: number | null;
}

export interface RuntimeAgentToolsReplyTaskParams {
  workspaceId: string;
  taskId: string;
  text: string;
  priority?: number | null;
}

export interface RuntimeAgentToolsCancelTaskParams {
  workspaceId: string;
  taskId: string;
}

export interface RuntimeAgentToolsRerunTaskParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  taskId: string;
  model?: string | null;
  selectedModel?: string | null;
  priority?: number | null;
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
  intent?: string | null;
  scope?: {
    categories?: WorkspaceMemoryCategory[] | null;
    treeIds?: string[] | null;
  } | null;
  retrievalPolicy?: MemoryRetrievalPolicy | null;
  answerGoal?: string | null;
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
  /** The turn this image belongs to. Without it the recorded output is not
   *  turn-scoped, and the end-of-turn file scan registers the file a second
   *  time instead of deduping against what this tool already recorded. */
  inputId?: string | null;
  selectedModel?: string | null;
  prompt: string;
  filename?: string | null;
  size?: string | null;
}

export interface RuntimeAgentToolsGenerateVideoParams {
  workspaceId: string;
  sessionId?: string | null;
  /** The turn this video belongs to — without it the recorded output is not
   *  turn-scoped and the end-of-turn scan registers the file a second time. */
  inputId?: string | null;
  selectedModel?: string | null;
  prompt: string;
  filename?: string | null;
  size?: string | null;
  seconds?: number | null;
}

export interface RuntimeAgentToolsDownloadUrlParams {
  workspaceId: string;
  url: string;
  outputPath?: string | null;
  expectedMimePrefix?: string | null;
  overwrite?: boolean;
}

export interface RuntimeAgentToolsSendFileParams {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  path: string;
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
  sessionId?: string | null;
  requestedName: string;
  args?: string | null;
}

export interface RuntimeAgentToolsScaffoldWorkspaceAppParams {
  workspaceId: string;
  sessionId?: string | null;
  appId: string;
  name?: string | null;
  overwrite?: boolean;
}

export interface RuntimeAgentToolsRegisterWorkspaceAppParams {
  workspaceId: string;
  sessionId?: string | null;
  appId: string;
  configPath?: string | null;
}

export interface RuntimeAgentToolsBuildWorkspaceAppParams {
  workspaceId: string;
  sessionId?: string | null;
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
  sessionId?: string | null;
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
  sessionId?: string | null;
  appId: string;
  timeoutMs?: number | null;
  pollIntervalMs?: number | null;
}

export interface RuntimeAgentToolsWaitUntilWorkspaceAppReadyParams {
  workspaceId: string;
  sessionId?: string | null;
  appId: string;
  timeoutMs?: number | null;
  pollIntervalMs?: number | null;
}

export interface RuntimeAgentToolsGetWorkspaceAppStatusParams {
  workspaceId: string;
  sessionId?: string | null;
  appId?: string | null;
}

export interface RuntimeAgentToolsGetWorkspaceAppPortsParams {
  workspaceId: string;
  sessionId?: string | null;
  appId?: string | null;
}

export interface RuntimeAgentToolsProbeWorkspaceAppEndpointsParams {
  workspaceId: string;
  sessionId?: string | null;
  appId: string;
  checks?: string[] | null;
  timeoutMs?: number | null;
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

  // MCP SSE transport: the "endpoint" event data MUST be a URL string
  // that the client can pass to new URL(data, baseUrl). Previously we
  // wrote a JSON object here, which the client then URL-encoded as a
  // path segment and POSTed to /mcp/<that-json>, hitting 404 and
  // silently disabling the app's MCP tools.
  res.write(
    \`event: endpoint\\ndata: /mcp/messages?sessionId=\${encodeURIComponent(sessionId)}\\n\\n\`,
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

const HOLAHUB_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function holahubImageContentType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

// The HolaHub MCP server (url + Authorization bearer) the desktop writes into
// workspace.yaml. Its upload endpoint is the /images sibling of the /sse MCP url.
function holahubUploadTarget(workspaceDir: string): {
  uploadUrl: string;
  authorization: string;
} {
  const document = readWorkspaceYamlDocument(workspaceDir);
  const registry = isRecord(document.mcp_registry) ? document.mcp_registry : {};
  const appServers = isRecord(registry.app_servers) ? registry.app_servers : {};
  const holahub = isRecord(appServers.holahub) ? appServers.holahub : {};
  const url = typeof holahub.url === "string" ? holahub.url : "";
  const headers = isRecord(holahub.headers) ? holahub.headers : {};
  const authorization =
    typeof headers.Authorization === "string" ? headers.Authorization : "";
  const uploadUrl = url ? url.replace(/\/sse(\?.*)?$/, "/images") : "";
  return { uploadUrl, authorization };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fallbackWorkspaceAppBuildStatus(entry: Record<string, unknown>): string {
  const lifecycle = isRecord(entry.lifecycle) ? (entry.lifecycle as Record<string, unknown>) : null;
  return typeof lifecycle?.setup === "string" && lifecycle.setup.trim().length > 0 ? "pending" : "stopped";
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

export interface RuntimeAgentToolsInstallCapabilityParams {
  workspaceId: string;
  capabilityId: string;
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
    id: runtimeToolBaseDefinition("ask_user_question").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/ask-user-question",
    description: runtimeToolBaseDefinition("ask_user_question").description
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
    id: runtimeToolBaseDefinition("cronjobs_run_now").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId/run",
    description: runtimeToolBaseDefinition("cronjobs_run_now").description
  },
  {
    id: runtimeToolBaseDefinition("delegate_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/subagents",
    description: runtimeToolBaseDefinition("delegate_task").description
  },
  {
    id: runtimeToolBaseDefinition("get_task").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/tasks/:taskId",
    description: runtimeToolBaseDefinition("get_task").description
  },
  {
    id: runtimeToolBaseDefinition("list_tasks").id,
    method: "GET",
    path: "/api/v1/capabilities/runtime-tools/tasks",
    description: runtimeToolBaseDefinition("list_tasks").description
  },
  {
    id: runtimeToolBaseDefinition("reply_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/tasks/:taskId/reply",
    description: runtimeToolBaseDefinition("reply_task").description
  },
  {
    id: runtimeToolBaseDefinition("cancel_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/tasks/:taskId/cancel",
    description: runtimeToolBaseDefinition("cancel_task").description
  },
  {
    id: runtimeToolBaseDefinition("rerun_task").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/tasks/:taskId/rerun",
    description: runtimeToolBaseDefinition("rerun_task").description
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
    id: runtimeToolBaseDefinition("send_file").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/send-file",
    description: runtimeToolBaseDefinition("send_file").description
  },
  {
    id: runtimeToolBaseDefinition("holahub_upload_image").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/holahub-upload-image",
    description: runtimeToolBaseDefinition("holahub_upload_image").description
  },
  {
    id: runtimeToolBaseDefinition("open_macos_settings").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/macos-settings",
    description: runtimeToolBaseDefinition("open_macos_settings").description
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
    id: runtimeToolBaseDefinition("capability_install").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/capability-install",
    description: runtimeToolBaseDefinition("capability_install").description
  },
  {
    id: runtimeToolBaseDefinition("mcp_connect").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/mcp/connect",
    description: runtimeToolBaseDefinition("mcp_connect").description
  },
  {
    id: runtimeToolBaseDefinition("mcp_refresh").id,
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/mcp/refresh",
    description: runtimeToolBaseDefinition("mcp_refresh").description
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

/**
 * Derive a stable, YAML-key-safe MCP server id from an explicit name, else the
 * URL host, else the command's leading token. Lowercased, non-alphanumerics
 * collapsed to underscores. Returns "" when nothing usable is present.
 */
function deriveMcpServerId(params: {
  name: string;
  url: string;
  command: string[];
}): string {
  const slug = (raw: string): string =>
    raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
  if (params.name) {
    const fromName = slug(params.name);
    if (fromName) return fromName;
  }
  if (params.url) {
    let host = "";
    try {
      host = new URL(params.url).hostname;
    } catch {
      host = params.url;
    }
    const fromUrl = slug(host);
    if (fromUrl) return fromUrl;
  }
  if (params.command.length > 0) {
    // Prefer the first token that looks like a package/binary name, not a flag.
    const token =
      params.command.find((c) => c && !c.startsWith("-")) ?? params.command[0];
    const base = slug((token ?? "").split(/[\\/]/).pop() ?? "");
    if (base) return base;
  }
  return "";
}

/**
 * Whether an already-registered server points at the SAME target as a new
 * connect — a reconnect / config update (safe to overwrite in place) vs a
 * genuinely different server that merely derived the same id (must not clobber).
 */
export function sameMcpTarget(
  entry: { transport: "remote" | "local"; url?: string; command?: string[] },
  transport: "remote" | "local",
  url: string,
  command: string[],
): boolean {
  if (entry.transport !== transport) {
    return false;
  }
  if (transport === "remote") {
    return (entry.url ?? "").trim() === url.trim();
  }
  return (entry.command ?? []).join("\u0000") === command.join("\u0000");
}

/** Keep only string→string entries; return null when nothing usable. */
function sanitizeStringMap(
  value: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && k.trim()) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

interface McpEndpointProbe {
  /** The endpoint answered an MCP `initialize` POST as an MCP server would
   *  (any status except a hard "this isn't an MCP endpoint here" — 404/405/5xx
   *  or a network failure). False strongly suggests a wrong URL. */
  reachable: boolean;
  /** The endpoint returned 401/403 — it needs an OAuth sign-in. */
  authRequired: boolean;
  /** The observed HTTP status (0 on network error), for a clearer message. */
  status: number;
}

/**
 * Best-effort probe of a remote MCP endpoint, used so `mcp_connect` can (a)
 * surface an Authorize card in the SAME turn when the server needs OAuth, and
 * (b) tell the user right away when the URL looks wrong instead of cheerfully
 * reporting "connected" and then failing tool discovery with a cryptic
 * transport error. Sends a minimal MCP `initialize`:
 *   - 401/403 → needs sign-in (per the MCP OAuth spec, usually a Bearer
 *     challenge) → authRequired, reachable.
 *   - 404/405/410/5xx or a network/timeout error → not an MCP endpoint here →
 *     NOT reachable (the URL is probably wrong, e.g. `/mcp/vl/` vs `/mcp/v1/`).
 *   - anything else (200/400/406/…) → the server spoke MCP → reachable.
 * Never throws.
 */
async function probeMcpEndpoint(url: string, timeoutMs = 5000): Promise<McpEndpointProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "holaboss-mcp-probe", version: "1" },
        },
      }),
      signal: controller.signal,
    });
    const status = response.status;
    if (status === 401 || status === 403) {
      return { reachable: true, authRequired: true, status };
    }
    const unreachable =
      status === 404 || status === 405 || status === 410 || status >= 500;
    return { reachable: !unreachable, authRequired: false, status };
  } catch {
    return { reachable: false, authRequired: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function firstNormalizedString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      normalized[key] = canonicalizeJsonValue((value as Record<string, JsonValue>)[key]);
    }
    return normalized;
  }
  return value;
}

function canonicalJsonValue(value: unknown): JsonValue {
  return canonicalizeJsonValue(sqliteValueToJson(value));
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function semanticBaseSnapshotSummary(snapshot: Record<string, unknown> | null | undefined): JsonObject {
  const typedSnapshot = isRecord(snapshot) ? snapshot : {};
  const countEntries = (key: string) =>
    Array.isArray(typedSnapshot[key]) ? typedSnapshot[key].length : 0;
  return {
    object_count: countEntries("objects"),
    field_count: countEntries("fields"),
    relation_count: countEntries("relations"),
    projection_count: countEntries("projections"),
    dashboard_count: countEntries("dashboards"),
    action_count: countEntries("actions"),
    automation_count: countEntries("automations"),
    trigger_count: countEntries("triggers"),
    integration_binding_count: countEntries("integration_bindings"),
    permission_count: countEntries("permissions"),
  };
}

function semanticSnapshotEntityName(entry: Record<string, unknown>, fallbackId: string): string | null {
  return (
    firstNormalizedString(
      entry.name,
      entry.label,
      entry.slug,
      entry.field_key,
      entry.integration_key,
      entry.subject_key,
      entry.role,
    ) ?? fallbackId
  );
}

function diffSemanticSnapshotEntityList(params: {
  current: unknown;
  published: unknown;
  idKey: string;
}): JsonObject {
  const currentEntries = Array.isArray(params.current)
    ? params.current.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const publishedEntries = Array.isArray(params.published)
    ? params.published.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const currentMap = new Map<string, Record<string, unknown>>();
  for (const entry of currentEntries) {
    const id = firstNormalizedString(entry[params.idKey]);
    if (id) {
      currentMap.set(id, entry);
    }
  }
  const publishedMap = new Map<string, Record<string, unknown>>();
  for (const entry of publishedEntries) {
    const id = firstNormalizedString(entry[params.idKey]);
    if (id) {
      publishedMap.set(id, entry);
    }
  }
  const added: JsonObject[] = [];
  const updated: JsonObject[] = [];
  const removed: JsonObject[] = [];
  let unchangedCount = 0;

  const currentIds = [...currentMap.keys()].sort((left, right) => left.localeCompare(right));
  for (const id of currentIds) {
    const currentEntry = currentMap.get(id);
    const publishedEntry = publishedMap.get(id);
    if (!currentEntry) {
      continue;
    }
    if (!publishedEntry) {
      added.push({
        id,
        name: semanticSnapshotEntityName(currentEntry, id),
        current: canonicalJsonValue(currentEntry),
      });
      continue;
    }
    if (canonicalJsonString(currentEntry) !== canonicalJsonString(publishedEntry)) {
      updated.push({
        id,
        name:
          semanticSnapshotEntityName(currentEntry, id) ??
          semanticSnapshotEntityName(publishedEntry, id),
        current: canonicalJsonValue(currentEntry),
        published: canonicalJsonValue(publishedEntry),
      });
      continue;
    }
    unchangedCount += 1;
  }

  const removedIds = [...publishedMap.keys()]
    .filter((id) => !currentMap.has(id))
    .sort((left, right) => left.localeCompare(right));
  for (const id of removedIds) {
    const publishedEntry = publishedMap.get(id);
    if (!publishedEntry) {
      continue;
    }
    removed.push({
      id,
      name: semanticSnapshotEntityName(publishedEntry, id),
      published: canonicalJsonValue(publishedEntry),
    });
  }

  return {
    changed: added.length > 0 || updated.length > 0 || removed.length > 0,
    added_count: added.length,
    updated_count: updated.length,
    removed_count: removed.length,
    unchanged_count: unchangedCount,
    added,
    updated,
    removed,
  };
}

function diffSemanticSnapshotSingleton(params: {
  current: unknown;
  published: unknown;
}): JsonObject {
  const current = isRecord(params.current) ? params.current : null;
  const published = isRecord(params.published) ? params.published : null;
  if (!current && !published) {
    return {
      changed: false,
      current: null,
      published: null,
    };
  }
  return {
    changed: canonicalJsonString(current) !== canonicalJsonString(published),
    current: current ? canonicalJsonValue(current) : null,
    published: published ? canonicalJsonValue(published) : null,
  };
}

function clippedSingleLineSummary(value: unknown, maxChars = 40_000): string {
  const text = normalizedString(value);
  if (!text) {
    return "";
  }
  const firstParagraph =
    text.split(/\n\s*\n/u).find((chunk) => chunk.trim().length > 0) ?? text;
  const compact = firstParagraph.replace(/\s+/gu, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
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

function countBy<T>(items: Iterable<T>, key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function integrationConnectionAccountNamespace(conn: {
  accountHandle?: string | null;
  accountEmail?: string | null;
  accountExternalId?: string | null;
  accountLabel?: string | null;
  connectionId: string;
}): string {
  const candidates = [
    conn.accountHandle,
    conn.accountEmail,
    conn.accountExternalId,
    conn.accountLabel,
    conn.connectionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = candidate.trim();
    if (normalized) {
      return normalized;
    }
  }
  return conn.connectionId;
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

function issueAttachmentFromSessionInputAttachment(
  attachment: SessionInputAttachmentPayload,
  createdAt: string,
): IssueAttachmentRecord {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mime_type,
    sizeBytes: attachment.size_bytes,
    workspacePath: attachment.workspace_path,
    createdAt,
  };
}

function delegatedIssueDescription(task: RuntimeAgentToolsDelegateTaskItem): string {
  const goal = normalizedString(task.goal);
  const context = normalizedString(task.context);
  if (!context) {
    return goal;
  }
  return `${goal}\n\nContext:\n${context}`;
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

function issueBootstrapInstruction(
  issue: Pick<IssueRecord, "title" | "description">,
  extraContext?: string | null,
): string {
  const title = normalizedString(issue.title);
  const description = normalizedString(issue.description);
  const goal = description || title;
  const context = [
    description && title ? `Issue title: ${title}` : "",
    normalizedString(extraContext),
  ].filter((section) => section.length > 0).join("\n\n");
  return subagentInstruction({ goal, context });
}

function issueDispatchInstruction(params: {
  issue: Pick<IssueRecord, "title" | "description">;
  sourceType?: string | null;
  extraContext?: string | null;
}): string {
  const goal =
    normalizedString(params.issue.description) ||
    normalizedString(params.issue.title);
  if (normalizedString(params.sourceType).toLowerCase() === "workflow") {
    return goal;
  }
  return issueBootstrapInstruction(params.issue, params.extraContext);
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
  fallbackTimezone?: string | null | undefined;
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
  return cronjobMetadataWithResolvedTimezone(
    nextMetadata,
    params.fallbackTimezone,
  ) as JsonObject;
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

function parseStoredOnboardingPayload(
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

// Cap on questions per ask. The answer card is a confirm affordance, not a
// form — keep the deck short so it stays a quick left/right review, not a
// wizard. Extras beyond this are dropped at sanitize time.
const MAX_USER_QUESTION_ITEMS = 4;

type ActiveUserQuestionOption = {
  id: string;
  label: string;
  description?: string | null;
  answer_text?: string | null;
  recommended?: boolean;
};

type ActiveUserQuestionItem = {
  id: string;
  title?: string | null;
  prompt: string;
  details?: string | null;
  allow_notes?: boolean;
  notes_placeholder?: string | null;
  allow_freeform?: boolean;
  freeform_placeholder?: string | null;
  options: ActiveUserQuestionOption[];
};

type ActiveUserQuestion = {
  title?: string | null;
  details?: string | null;
  questions: ActiveUserQuestionItem[];
};

type ActiveUserQuestionAnswer = {
  question_id?: string | null;
  option_id?: string | null;
  response_text?: string | null;
  notes?: string | null;
};

function sanitizeUserQuestionOption(
  value: Record<string, unknown>,
  index: number,
  path = "question.options",
): ActiveUserQuestionOption {
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

function sanitizeUserQuestionItem(
  value: Record<string, unknown>,
  index: number,
  defaults?: Partial<ActiveUserQuestionItem>,
  path = "question",
): ActiveUserQuestionItem {
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
    return sanitizeUserQuestionOption(item, index, `${path}.options`);
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

function sanitizeUserQuestion(
  value: Record<string, unknown>,
): ActiveUserQuestion {
  const defaults: Partial<ActiveUserQuestionItem> = {
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
    const questions = questionItems
      .slice(0, MAX_USER_QUESTION_ITEMS)
      .map((item, index) => {
        if (!isRecord(item)) {
          throw new Error(`question.questions[${index}] must be an object`);
        }
        return sanitizeUserQuestionItem(
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
    questions: [sanitizeUserQuestionItem(value, 0, defaults, "question")],
  };
}

export function parseStoredUserQuestion(
  raw: string | null | undefined,
): ActiveUserQuestion | null {
  const parsed = parseStoredOnboardingPayload(raw);
  if (!isRecord(parsed)) {
    return null;
  }
  try {
    return sanitizeUserQuestion(parsed);
  } catch {
    return null;
  }
}

function activeUserQuestionPayload(
  session: { workspaceId: string; sessionId: string; activeUserQuestion: string | null },
): JsonObject {
  return {
    workspace_id: session.workspaceId,
    session_id: session.sessionId,
    active_user_question: parseStoredUserQuestion(
      session.activeUserQuestion,
    ) as unknown as JsonValue | null,
  };
}

export function cronjobPayload(record: CronjobRecord): JsonObject {
  const metadata: JsonObject = { ...((record.metadata ?? {}) as JsonObject) };
  delete metadata.model;
  return {
    id: record.id,
    workflow_id: record.id,
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

// A long instruction dominates the `cronjobs_list` payload and is pure waste
// when the caller only wants the roster (schedule, name, status). Trim it to a
// short preview past this many characters; callers that need the full text call
// `cronjobs_get`.
const CRONJOB_LIST_INSTRUCTION_PREVIEW_CHARS = 200;

// Compact per-job shape for `cronjobs_list`: identical to cronjobPayload except
// a long `instruction` is replaced by `instruction_preview` +
// `instruction_truncated: true` (and `instruction` is omitted, so a truncated
// value can never be mistaken for the whole prompt). `instruction_chars` always
// carries the true length so the caller can tell how much was withheld.
export function cronjobListPayload(record: CronjobRecord): JsonObject {
  const payload = cronjobPayload(record);
  const instruction = record.instruction ?? "";
  const instructionChars = instruction.length;
  payload.instruction_chars = instructionChars;
  if (instructionChars > CRONJOB_LIST_INSTRUCTION_PREVIEW_CHARS) {
    delete payload.instruction;
    payload.instruction_preview =
      `${instruction.slice(0, CRONJOB_LIST_INSTRUCTION_PREVIEW_CHARS)}…`;
    payload.instruction_truncated = true;
  }
  return withCronjobAgentTimeHints(payload);
}

// Render a cronjob's UTC `next_run_at` instant as wall-clock time in its pinned
// timezone, e.g. "Fri, 2026-07-10 08:00 (Asia/Shanghai)".
function formatCronjobNextRunLocal(
  nextRunAtIso: string,
  timezone: string,
): string | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nextRunAtIso));
    return `${formatted} (${timezone})`;
  } catch {
    return null;
  }
}

// Agent-only presentation hints. The model kept reporting cron times in UTC
// because the raw payload exposes a timezone-agnostic cron (`0 8 * * *`) and a
// UTC `next_run_at` instant — so it guessed a conversion. These fields spell out
// the pinned timezone the cron actually fires in and the next run rendered in
// THAT timezone, so the model can report the schedule without converting.
//
// Deliberately NOT folded into cronjobPayload: that payload is shared with the
// desktop oRPC path, whose RemoteCronjobRecord schema rejects unknown fields
// (see the compactInstructions note on listCronjobs). Apply this only at the
// agent-tool boundary.
export function withCronjobAgentTimeHints(payload: JsonObject): JsonObject {
  const metadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? (payload.metadata as JsonObject)
      : null;
  const timezone =
    typeof metadata?.timezone === "string" && metadata.timezone.trim()
      ? metadata.timezone.trim()
      : null;
  const nextRunAt =
    typeof payload.next_run_at === "string" ? payload.next_run_at : null;
  return {
    ...payload,
    // The timezone the cron expression is evaluated in (NOT UTC).
    runs_in_timezone: timezone,
    // The next run as wall-clock time in that timezone; null when disabled or
    // no timezone is pinned. Report this to the user verbatim.
    next_run_local:
      timezone && nextRunAt
        ? formatCronjobNextRunLocal(nextRunAt, timezone)
        : null,
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

function issueAttachmentPayload(record: IssueAttachmentRecord): JsonObject {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    workspace_path: record.workspacePath,
    created_at: record.createdAt,
  };
}

function subagentRunPayload(state: SyncedSubagentRunState): JsonObject {
  return {
    task_id: state.run.issueId,
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
    issue_id: state.run.issueId,
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

function delegatedTaskManagerPayload(state: SyncedSubagentRunState): JsonObject {
  const payload = subagentRunPayload(state) as Record<string, JsonValue>;
  const { subagent_id: _subagentId, ...managerPayload } = payload;
  return managerPayload;
}

function taskPayload(params: {
  issue: IssueRecord;
  activeState?: SyncedSubagentRunState | null;
  latestState?: SyncedSubagentRunState | null;
  blockedByTaskIds?: string[] | null;
}): JsonObject {
  const blockedByTaskIds = params.blockedByTaskIds ?? [];
  return {
    task_id: params.issue.issueId,
    issue_id: params.issue.issueId,
    workspace_id: params.issue.workspaceId,
    task_number: params.issue.issueNumber,
    session_id: params.issue.sessionId,
    blocked_by: params.issue.blockedBy.map((edge) => ({
      task_id: edge.taskId,
      relation: edge.relation,
      instruction: edge.instruction,
    })),
    blocked_by_task_ids: blockedByTaskIds,
    workflow_blocked: blockedByTaskIds.length > 0,
    title: params.issue.title,
    description: params.issue.description,
    status: params.issue.status,
    priority: params.issue.priority,
    blocker_reason: params.issue.blockerReason,
    attachments: params.issue.attachments.map((attachment) => issueAttachmentPayload(attachment)),
    active_subagent_id: params.issue.activeSubagentId,
    latest_subagent_id: params.issue.latestSubagentId,
    created_by: params.issue.createdBy,
    created_at: params.issue.createdAt,
    updated_at: params.issue.updatedAt,
    completed_at: params.issue.completedAt,
    active_run: params.activeState ? subagentRunPayload(params.activeState) : null,
    latest_run: params.latestState ? subagentRunPayload(params.latestState) : null,
  };
}

function dedupeSyncedSubagentStates(states: SyncedSubagentRunState[]): SyncedSubagentRunState[] {
  const seen = new Set<string>();
  const deduped: SyncedSubagentRunState[] = [];
  for (const state of states) {
    const subagentId = normalizedString(state.run.subagentId);
    if (!subagentId || seen.has(subagentId)) {
      continue;
    }
    seen.add(subagentId);
    deduped.push(state);
  }
  return deduped;
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
      brokerService?: IntegrationBrokerService | null;
    },
  ) {}

  private workspaceAppSmokeTestTurnContext(params: {
    sessionId?: string | null;
    appId: string;
    smokeTestName: string;
  }): JsonObject | null {
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      return null;
    }
    const inputId = `smoke:${params.appId}:${params.smokeTestName}:${randomUUID()}`;
    return {
      session_id: sessionId,
      input_id: inputId,
      turn_id: inputId,
    };
  }

  private async runWorkspaceAppSmokeTests(params: {
    workspaceId: string;
    sessionId?: string | null;
    appIds: string[];
    workspaceDir: string;
    pendingIntegrations: JsonObject[];
  }): Promise<JsonObject[]> {
    const pendingAppIds = new Set(
      params.pendingIntegrations
        .map((entry) => normalizedString(entry.app_id))
        .filter((appId): appId is string => appId.length > 0),
    );
    const results: JsonObject[] = [];

    for (const appId of params.appIds) {
      if (pendingAppIds.has(appId)) {
        continue;
      }
      const resolved = resolveWorkspaceAppRuntime(params.workspaceDir, appId, {
        store: this.store,
        workspaceId: params.workspaceId,
        allocatePorts: true,
      });
      const smokeTests = resolved.resolvedApp.smokeTests ?? [];
      for (const smokeTest of smokeTests) {
        results.push(await this.runWorkspaceAppSmokeTest({
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          appId,
          resolved,
          smokeTest,
        }));
      }
    }

    return results;
  }

  private async runWorkspaceAppSmokeTest(params: {
    workspaceId: string;
    sessionId?: string | null;
    appId: string;
    resolved: ReturnType<typeof resolveWorkspaceAppRuntime>;
    smokeTest: ResolvedApplicationSmokeTest;
  }): Promise<JsonObject> {
    const turnContext = this.workspaceAppSmokeTestTurnContext({
      sessionId: params.sessionId,
      appId: params.appId,
      smokeTestName: params.smokeTest.name,
    });
    const body: JsonObject = {
      action_name: params.smokeTest.payload.actionName,
      ...(params.smokeTest.payload.rowId
        ? { row_id: params.smokeTest.payload.rowId }
        : {}),
      ...(params.smokeTest.payload.resourceName
        ? { resource_name: params.smokeTest.payload.resourceName }
        : {}),
      ...(params.smokeTest.payload.rowData
        ? { row_data: params.smokeTest.payload.rowData as JsonValue }
        : {}),
      ...(params.smokeTest.payload.rowStatus
        ? { row_status: params.smokeTest.payload.rowStatus }
        : {}),
      ...(params.smokeTest.payload.input
        ? { input: params.smokeTest.payload.input as JsonValue }
        : {}),
      ...(turnContext ? { turn_context: turnContext } : {}),
    };
    const url = `http://127.0.0.1:${params.resolved.ports.http}${params.smokeTest.path || DEFAULT_LOCAL_APP_ACTION_API_PATH}`;
    const timeoutMs = Math.max(1_000, params.smokeTest.timeoutS * 1_000);
    const startedAt = Date.now();
    let responseBody: JsonObject | null = null;
    let lastFailure = "no response";
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        const probe = await fetchWorkspaceAppProbe({
          url,
          method: "POST",
          timeoutMs,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (probe.ok && isRecord(probe.jsonBody)) {
          responseBody = probe.jsonBody as JsonObject;
          break;
        }
        lastFailure = probe.ok
          ? "returned non-JSON content"
          : `${probe.statusCode} ${probe.bodyText || "empty response"}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      await sleep(250);
    }
    if (!responseBody) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        `smoke test '${params.smokeTest.name}' for app '${params.appId}' failed: ${lastFailure}`,
      );
    }
    const action = this.assertWorkspaceAppLocalActionSmokeResult({
      appId: params.appId,
      smokeTestName: params.smokeTest.name,
      smokeTest: params.smokeTest,
      responseBody,
    });

    if (params.smokeTest.kind === "delegated_task_action") {
      const task = this.resolveWorkspaceAppSmokeTestTask({
        workspaceId: params.workspaceId,
        action,
        row: isRecord(responseBody.row) ? (responseBody.row as JsonObject) : null,
      });
      const run = isRecord(task.latest_run) ? (task.latest_run as JsonObject) : null;
      if (!run) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTest.name}' for app '${params.appId}' did not queue a delegated run`,
        );
      }
      const taskStatus = normalizedString(task.status).toLowerCase();
      const allowedTaskStatuses = new Set(
        params.smokeTest.expect.taskStatuses.map((status) => status.trim().toLowerCase()).filter(Boolean),
      );
      if (!allowedTaskStatuses.has(taskStatus)) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTest.name}' for app '${params.appId}' created task status '${taskStatus || "unknown"}' (expected one of ${[...allowedTaskStatuses].join(", ")})`,
        );
      }
      const runStatus = normalizedString(run.status).toLowerCase();
      const allowedRunStatuses = new Set(
        params.smokeTest.expect.runStatuses.map((status) => status.trim().toLowerCase()).filter(Boolean),
      );
      if (!allowedRunStatuses.has(runStatus)) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTest.name}' for app '${params.appId}' queued delegated run status '${runStatus || "unknown"}' (expected one of ${[...allowedRunStatuses].join(", ")})`,
        );
      }
      if (
        params.smokeTest.expect.requireRequestedModelNull &&
        Object.prototype.hasOwnProperty.call(run, "requested_model") &&
        run.requested_model !== null
      ) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTest.name}' for app '${params.appId}' set requested_model, but model selection is runtime-owned`,
        );
      }
      const effectiveModel = normalizedString(run.effective_model);
      if (params.smokeTest.expect.requireEffectiveModel && !effectiveModel) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTest.name}' for app '${params.appId}' did not resolve an effective_model`,
        );
      }
      const expectedParentSessionId = normalizedString(params.sessionId);
      if (expectedParentSessionId) {
        const parentSessionId = normalizedString(run.parent_session_id);
        const parentInputId = normalizedString(run.parent_input_id);
        if (parentSessionId !== expectedParentSessionId || !parentInputId) {
          throw new RuntimeAgentToolsServiceError(
            409,
            "workspace_app_smoke_test_failed",
            `smoke test '${params.smokeTest.name}' for app '${params.appId}' did not preserve parent turn routing`,
          );
        }
      }
      return {
        app_id: params.appId,
        name: params.smokeTest.name,
        kind: params.smokeTest.kind,
        ok: true,
        task_id: normalizedString(task.task_id) || null,
        task_status: taskStatus || null,
        run_status: runStatus || null,
        effective_model: effectiveModel || null,
      };
    }

    return {
      app_id: params.appId,
      name: params.smokeTest.name,
      kind: params.smokeTest.kind,
      ok: true,
      row_status: isRecord(responseBody.row)
        ? normalizedString((responseBody.row as JsonObject).status) || null
        : null,
      created_row:
        typeof responseBody.created_row === "boolean"
          ? responseBody.created_row
          : null,
    };
  }

  private assertWorkspaceAppLocalActionSmokeResult(params: {
    appId: string;
    smokeTestName: string;
    smokeTest: ResolvedApplicationSmokeTest;
    responseBody: JsonObject;
  }): JsonObject {
    const topLevelOk = params.responseBody.ok;
    if (topLevelOk !== true) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        `smoke test '${params.smokeTestName}' for app '${params.appId}' returned ok=${String(topLevelOk)}`,
      );
    }
    if (
      params.smokeTest.expect.createdRow !== null &&
      params.responseBody.created_row !== params.smokeTest.expect.createdRow
    ) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        `smoke test '${params.smokeTestName}' for app '${params.appId}' returned created_row=${String(params.responseBody.created_row)} (expected ${String(params.smokeTest.expect.createdRow)})`,
      );
    }
    const row = isRecord(params.responseBody.row)
      ? (params.responseBody.row as JsonObject)
      : null;
    if (params.smokeTest.expect.rowStatus) {
      const actualStatus = row ? normalizedString(row.status) : "";
      if (actualStatus !== params.smokeTest.expect.rowStatus) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "workspace_app_smoke_test_failed",
          `smoke test '${params.smokeTestName}' for app '${params.appId}' returned row status '${actualStatus || "unknown"}' (expected '${params.smokeTest.expect.rowStatus}')`,
        );
      }
    }
    const action = isRecord(params.responseBody.action)
      ? (params.responseBody.action as JsonObject)
      : null;
    if (!action) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        `smoke test '${params.smokeTestName}' for app '${params.appId}' returned no action result`,
      );
    }
    const actionOk = action.ok === true;
    if (params.smokeTest.expect.actionOk && !actionOk) {
      const errorMessage =
        isRecord(action.fail) && typeof action.fail.message === "string"
          ? action.fail.message
          : "action returned a failure payload";
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        `smoke test '${params.smokeTestName}' for app '${params.appId}' failed: ${errorMessage}`,
      );
    }
    return action;
  }

  private resolveWorkspaceAppSmokeTestTask(params: {
    workspaceId: string;
    action: JsonObject;
    row: JsonObject | null;
  }): JsonObject {
    const actionData = isRecord(params.action.data)
      ? (params.action.data as JsonObject)
      : null;
    if (actionData && isRecord(actionData.task)) {
      return actionData.task as JsonObject;
    }
    const taskId =
      normalizedString(actionData?.task_id) ||
      normalizedString(params.action.externalId) ||
      normalizedString(params.row?.external_id);
    if (!taskId) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "workspace_app_smoke_test_failed",
        "delegated task smoke test did not return a task identifier",
      );
    }
    return this.getTask({
      workspaceId: params.workspaceId,
      taskId,
    });
  }

  capabilityStatus(context?: { workspaceId?: string | null }): RuntimeAgentToolCapabilityPayload {
    return runtimeAgentToolCapabilityPayload(context);
  }

  dismissUserQuestion(params: {
    workspaceId: string;
    sessionId: string;
  }): JsonObject {
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "session_id_required",
        "session_id is required",
      );
    }
    const session = this.store.getSession({
      workspaceId: params.workspaceId,
      sessionId,
    });
    if (!session) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "session_not_found",
        "session not found",
      );
    }
    const cleared = this.store.setSessionActiveUserQuestion({
      workspaceId: params.workspaceId,
      sessionId,
      activeUserQuestion: null,
    });
    return activeUserQuestionPayload(cleared);
  }

  createUserQuestion(params: {
    workspaceId: string;
    sessionId: string;
    question: Record<string, unknown>;
  }): JsonObject {
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "session_id_required",
        "session_id is required",
      );
    }
    const session = this.store.getSession({
      workspaceId: params.workspaceId,
      sessionId,
    });
    if (!session) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "session_not_found",
        "session not found",
      );
    }
    let question: ActiveUserQuestion;
    try {
      question = sanitizeUserQuestion(params.question);
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "user_question_invalid",
        error instanceof Error ? error.message : "user question is invalid",
      );
    }
    const updated = this.store.setSessionActiveUserQuestion({
      workspaceId: params.workspaceId,
      sessionId,
      activeUserQuestion: JSON.stringify(question),
    });
    return activeUserQuestionPayload(updated);
  }

  answerUserQuestion(params: {
    workspaceId: string;
    sessionId: string;
    model?: string | null;
    thinkingValue?: string | null;
    optionId?: string | null;
    responseText?: string | null;
    notes?: string | null;
    answers?: ActiveUserQuestionAnswer[] | null;
  }): JsonObject {
    const sessionId = normalizedString(params.sessionId);
    if (!sessionId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "session_id_required",
        "session_id is required",
      );
    }
    const session = this.store.getSession({
      workspaceId: params.workspaceId,
      sessionId,
    });
    if (!session) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "session_not_found",
        "session not found",
      );
    }
    const question = parseStoredUserQuestion(session.activeUserQuestion);
    if (!question || question.questions.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "user_question_not_active",
        "no active user question is awaiting an answer",
      );
    }
    const questions = question.questions;
    const normalizedAnswers =
      Array.isArray(params.answers) && params.answers.length > 0
        ? params.answers
        : [
            {
              question_id: questions[0]?.id ?? null,
              option_id: params.optionId ?? null,
              response_text: params.responseText ?? null,
              notes: params.notes ?? null,
            } satisfies ActiveUserQuestionAnswer,
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
          "user_question_option_invalid",
          `selected user question option is invalid for ${currentQuestion.id}`,
        );
      }
      const responseText = normalizedString(answer.response_text) || "";
      if (responseText && currentQuestion.allow_freeform === false) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "user_question_freeform_not_allowed",
          `freeform response is not allowed for ${currentQuestion.id}`,
        );
      }
      const noteText = normalizedString(answer.notes) || "";
      const skipped = !option && !responseText;
      const selectedAnswerText = option?.answer_text || option?.label || "";
      const normalizedAnswerText = skipped
        ? "(skipped)"
        : responseText || selectedAnswerText;
      // For a single question, send just the user's answer — the
      // agent already has the prompt in conversation context, so
      // echoing it back reads like "why are you repeating my answer."
      // For multi-question decks, prefix with `Q<n>:` / `A:` so the
      // agent can match each answer to its prompt. Skipped questions
      // are still emitted so the agent sees the user passed on them.
      const lines: string[] =
        questions.length > 1
          ? [
              `Q${index + 1}: ${currentQuestion.prompt}`,
              `A: ${normalizedAnswerText}`,
            ]
          : [normalizedAnswerText];
      if (noteText) {
        lines.push(`(note: ${noteText})`);
      }
      answerLines.push({
        payload: {
          question_id: currentQuestion.id,
          question_prompt: currentQuestion.prompt,
          option_id: option?.id ?? null,
          option_label: option?.label ?? null,
          response_text: responseText || null,
          notes: noteText || null,
          skipped,
        },
        text: lines.join("\n"),
      });
    }
    const queuedText = answerLines.map((entry) => entry.text).join("\n\n");
    this.store.ensureRuntimeState({
      workspaceId: params.workspaceId,
      sessionId,
      status: "QUEUED",
    });
    const input = this.store.enqueueInput({
      workspaceId: params.workspaceId,
      sessionId,
      payload: {
        text: queuedText,
        attachments: [],
        image_urls: [],
        model: normalizedString(params.model) || null,
        thinking_value: normalizedString(params.thinkingValue) || null,
        context: {
          source: "ask_user_question",
          question_count: questions.length,
          questions: answerLines.map((entry) => entry.payload),
        },
      },
    });
    this.store.updateRuntimeState({
      workspaceId: params.workspaceId,
      sessionId,
      status: "QUEUED",
      currentInputId: input.inputId,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null,
    });
    const cleared = this.store.setSessionActiveUserQuestion({
      workspaceId: params.workspaceId,
      sessionId,
      activeUserQuestion: null,
    });
    this.options.queueWorker?.wake();
    // Surface the enqueued input so the caller (desktop) can attach an
    // input-specific output stream to the follow-up run, exactly like a send.
    return {
      ...activeUserQuestionPayload(cleared),
      input_id: input.inputId,
      status: "QUEUED",
    };
  }

  async listIntegrationCatalog(params: {
    workspaceId: string;
  }): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    // Index active connections + the workspace default per provider so
    // the agent can disambiguate when the user has multiple accounts
    // for the same toolkit. Each connected account exposes one
    // canonical `account_namespace` rather than separate label /
    // handle / email variants.
    const connectionsByProvider = new Map<
      string,
      Array<{ connection_id: string; account_namespace: string }>
    >();
    try {
      for (const conn of await listConnectionsMerged(this.store)) {
        if (conn.status.trim().toLowerCase() !== "active") continue;
        const key = conn.providerId.trim().toLowerCase();
        if (!key) continue;
        const list = connectionsByProvider.get(key) ?? [];
        list.push({
          connection_id: conn.connectionId,
          account_namespace: integrationConnectionAccountNamespace(conn),
        });
        connectionsByProvider.set(key, list);
      }
    } catch {
      // best-effort enrichment; the static catalog still ships
    }
    const ossProviderIds = new Set(
      integrationCatalogProviderIds().map((id) => id.toLowerCase()),
    );
    const storeOnlyProviders = listStoreCatalog()
      .filter((entry) => !ossProviderIds.has(entry.slug.toLowerCase()))
      .map((entry) => ({
        provider_id: entry.slug,
        display_name: entry.slug,
        description: `Composio-managed '${entry.slug}' toolkit (category: ${entry.category}).`,
        auth_modes: ["managed"],
        supports_oss: false,
        supports_managed: true,
        default_scopes: [] as string[],
        docs_url: null,
      }));
    const allProviders = [...INTEGRATION_CATALOG_PROVIDERS, ...storeOnlyProviders];
    return {
      workspace_id: params.workspaceId,
      provider_ids: allProviders.map((provider) => provider.provider_id),
      providers: allProviders.map((provider) => {
        const key = provider.provider_id.toLowerCase();
        const accounts = connectionsByProvider.get(key) ?? [];
        let defaultConnectionId: string | null = null;
        try {
          const binding = this.store.getIntegrationBindingByTarget({
            workspaceId: params.workspaceId,
            targetType: "workspace_default",
            targetId: params.workspaceId,
            integrationKey: key,
          });
          if (binding) defaultConnectionId = binding.connectionId;
        } catch {
          // best-effort
        }
        return {
          provider_id: provider.provider_id,
          display_name: provider.display_name,
          description: provider.description,
          auth_modes: [...provider.auth_modes],
          supports_oss: provider.supports_oss,
          supports_managed: provider.supports_managed,
          default_scopes: [...provider.default_scopes],
          docs_url: provider.docs_url,
          connected_accounts: accounts as unknown as JsonValue,
          workspace_default_connection_id: defaultConnectionId,
        };
      }),
      requirement:
        "Use the exact canonical provider_id from this catalog in app.runtime.yaml integrations and createIntegrationClient(...). E.g. use 'twitter' for X. When a provider has multiple `connected_accounts` and no `workspace_default_connection_id`, ask the user which account namespace this workspace should default to, then call `holaboss_workspace_integrations_set_default_account` to persist the choice.",
    };
  }

  listCronjobs(params: {
    workspaceId: string;
    enabledOnly?: boolean;
    // Trim long instructions to a preview (see cronjobListPayload). ONLY the
    // agent `cronjobs_list` tool wants this — it saves the model tokens. The
    // desktop oRPC path leaves it off: that response is validated against the
    // full RemoteCronjobRecord schema (which requires `instruction` and rejects
    // the preview fields), and the UI needs the complete instruction anyway.
    compactInstructions?: boolean;
    // Opt-in pagination. Omit `limit` for the full roster (unchanged shape:
    // `{ jobs, count }`). With `limit`/`offset` the result also carries `total`
    // and `has_more` so a caller can page a large roster.
    limit?: number | null;
    offset?: number | null;
  }): JsonObject {
    const toPayload = params.compactInstructions
      ? cronjobListPayload
      : cronjobPayload;
    const limit =
      typeof params.limit === "number" &&
      Number.isFinite(params.limit) &&
      params.limit > 0
        ? Math.floor(params.limit)
        : null;
    const offset =
      typeof params.offset === "number" &&
      Number.isFinite(params.offset) &&
      params.offset > 0
        ? Math.floor(params.offset)
        : 0;
    const jobs = this.store
      .listCronjobs({
        workspaceId: params.workspaceId,
        enabledOnly: Boolean(params.enabledOnly),
        limit,
        offset,
      })
      .map((cronjob) => toPayload(cronjob));
    // Unpaginated: the page IS the whole roster, so keep the original shape.
    if (limit === null && offset === 0) {
      return { jobs, count: jobs.length };
    }
    const total = this.store.countCronjobs({
      workspaceId: params.workspaceId,
      enabledOnly: Boolean(params.enabledOnly),
    });
    return {
      jobs,
      count: jobs.length,
      total,
      limit,
      offset,
      has_more: offset + jobs.length < total,
    };
  }

  getCronjob(params: {
    jobId: string;
    workspaceId?: string | null;
  }): JsonObject | null {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    const cronjob = this.store.getCronjob({ workspaceId, jobId: params.jobId });
    return cronjob ? cronjobPayload(cronjob) : null;
  }

  /**
   * Resolve the cronjob's project binding into `metadata.project_id`.
   * An explicitly requested project must exist; with no explicit request,
   * the binding defaults to the calling session's project so automations
   * created from a project chat deliver their output into that project.
   */
  private applyCronjobProjectBinding(params: {
    workspaceId: string;
    metadata: JsonObject;
    projectId?: string | null;
    defaultFromSessionId?: string | null;
  }): void {
    delete params.metadata.project_id;
    if (params.projectId !== undefined && params.projectId !== null) {
      const requested = params.projectId.trim();
      if (!requested) {
        return;
      }
      const project = this.store.getWorkspaceProject({
        workspaceId: params.workspaceId,
        projectId: requested,
      });
      if (!project) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "cronjob_project_not_found",
          `Project '${requested}' does not exist in this workspace.`,
        );
      }
      params.metadata.project_id = requested;
      return;
    }
    const sessionId = normalizedString(params.defaultFromSessionId);
    if (!sessionId) {
      return;
    }
    const sessionProjectId = this.store
      .getSession({ workspaceId: params.workspaceId, sessionId })
      ?.projectId?.trim();
    if (
      sessionProjectId &&
      this.store.getWorkspaceProject({
        workspaceId: params.workspaceId,
        projectId: sessionProjectId,
      })
    ) {
      params.metadata.project_id = sessionProjectId;
    }
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
    // Only schedule an automation on a usable agent. `metadata.harness` carries
    // the per-automation harness override (read back in fireCronjob); if set, it
    // must resolve to a registered, available harness — otherwise every fire
    // would silently fail. "Tested" readiness is a desktop-only signal;
    // availability (the CLI's binary present on this machine) is the runtime's
    // server-side truth, and the desktop picker additionally gates humans to
    // tested agents. pi/Hola is in-process and always available.
    const requestedHarness = isRecord(params.metadata)
      ? normalizedString(params.metadata.harness)
      : "";
    if (requestedHarness) {
      const plugin = resolveRuntimeHarnessPlugin(requestedHarness);
      const available =
        plugin?.id === "pi" ||
        listHarnessAvailability().some(
          (entry) => entry.id === plugin?.id && entry.available,
        );
      if (!plugin || !available) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "cronjob_harness_unavailable",
          `Agent "${requestedHarness}" is not available on this machine — install and test it in Settings → Agents before scheduling an automation with it.`,
        );
      }
    }
    const effectiveTimezone = runtimeUserTimezone(this.store);
    const effectiveEnabled = params.enabled !== false;
    const metadata = metadataWithCronjobDefaults({
      metadata: params.metadata,
      holabossUserId: params.holabossUserId,
      selectedModel: params.selectedModel,
      sourceSessionId: params.sessionId,
      fallbackTimezone: effectiveTimezone,
    });
    this.applyCronjobProjectBinding({
      workspaceId: params.workspaceId,
      metadata,
      projectId:
        params.projectId ??
        (typeof metadata.project_id === "string" ? metadata.project_id : undefined),
      defaultFromSessionId: params.sessionId,
    });
    const created = this.store.createCronjob({
      workspaceId: params.workspaceId,
      initiatedBy: normalizedString(params.initiatedBy) || "workspace_agent",
      name: normalizedString(params.name),
      cron,
      description,
      instruction,
      enabled: effectiveEnabled,
      delivery: normalizeDelivery({
        channel:
          normalizedString(params.delivery?.channel ?? "session_run") ||
          "session_run",
        mode: params.delivery?.mode ?? "announce",
        to: params.delivery?.to,
      }),
      metadata,
      nextRunAt: effectiveEnabled
        ? cronjobNextRunAt(
            cron,
            new Date(),
            typeof metadata.timezone === "string" ? metadata.timezone : effectiveTimezone,
          )
        : null,
    });
    return cronjobPayload(created);
  }

  private requireAppBuilderRuntimeToolSession(params: {
    workspaceId: string;
    sessionId?: string | null;
    toolId:
      | "workspace_apps_scaffold"
      | "workspace_apps_register"
      | "workspace_apps_build"
      | "workspace_apps_ensure_running"
      | "workspace_apps_restart"
      | "workspace_apps_restart_and_wait_ready"
      | "workspace_apps_wait_until_ready"
      | "workspace_apps_get_status"
      | "workspace_apps_get_ports"
      | "workspace_apps_probe_endpoints";
  }): void {
    void params;
  }

  updateCronjob(params: RuntimeAgentToolsUpdateCronjobParams): JsonObject {
    const workspaceId = this.requireWorkspaceId(params.workspaceId);
    this.requireWorkspace(workspaceId);
    const existing = this.store.getCronjob({ workspaceId, jobId: params.jobId });
    if (!existing) {
      throw new RuntimeAgentToolsServiceError(404, "cronjob_not_found", "cronjob not found");
    }
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
    const effectiveTimezone = runtimeUserTimezone(this.store);
    const effectiveEnabled = params.enabled;
    const effectiveMetadata =
      params.metadata === undefined
        ? (cronjobMetadataWithResolvedTimezone(
            existing.metadata,
            effectiveTimezone,
          ) as JsonObject)
        : metadataWithCronjobDefaults({
            metadata: params.metadata,
            holabossUserId: null,
            fallbackTimezone: effectiveTimezone,
          });
    const requestedProjectId =
      params.projectId !== undefined
        ? (params.projectId ?? "")
        : params.metadata !== undefined &&
            typeof effectiveMetadata.project_id === "string"
          ? effectiveMetadata.project_id
          : undefined;
    if (requestedProjectId !== undefined) {
      this.applyCronjobProjectBinding({
        workspaceId,
        metadata: effectiveMetadata,
        projectId: requestedProjectId,
      });
    }
    const resolvedTimezone =
      typeof effectiveMetadata.timezone === "string"
        ? effectiveMetadata.timezone
        : effectiveTimezone;
    const resolvedEnabled = effectiveEnabled ?? existing.enabled;
    const updated = this.store.updateCronjob({
      workspaceId,
      jobId: params.jobId,
      name: params.name === undefined ? undefined : normalizedString(params.name),
      cron: cron ?? undefined,
      description: description ?? undefined,
      instruction:
        resolvedInstructionForCronjobUpdate({
          existing,
          description,
          instruction,
        }) ?? undefined,
      enabled: effectiveEnabled ?? undefined,
      delivery:
        params.delivery == null
          ? undefined
          : normalizeDelivery({
              channel: params.delivery.channel,
              mode: params.delivery.mode,
              to: params.delivery.to,
            }),
      metadata: effectiveMetadata,
      nextRunAt: resolvedEnabled
        ? cronjobNextRunAt(cron ?? existing.cron, new Date(), resolvedTimezone)
        : null,
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
    return {
      success: this.store.deleteCronjob({ workspaceId, jobId: params.jobId }),
    };
  }

  delegateTask(params: RuntimeAgentToolsDelegateTaskParams): JsonObject {
    const workspace = this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    const parentInputId = normalizedString(params.inputId) || null;
    const requestedTasks = params.tasks
      .map((task) => ({
        blockedBy: task.blockedBy ?? [],
        title: normalizedString(task.title),
        goal: normalizedString(task.goal),
        context: normalizedString(task.context),
        tools: normalizedStringList(task.tools),
        model: normalizedString(task.model),
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

    const createdTasks: JsonObject[] = [];
    for (const task of requestedTasks) {
      const title = normalizedSubagentTaskTitle(task.title, task.goal);
      const requestedModel = task.model || null;
      const parentInput = parentInputId
        ? this.store.getInput({
            workspaceId: params.workspaceId,
            inputId: parentInputId,
          })
        : null;
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
      const issue = this.store.createIssue({
        workspaceId: params.workspaceId,
        blockedBy: task.blockedBy,
        title,
        description: delegatedIssueDescription(task),
        status: "todo",
        attachments: forwardedAttachments.map((attachment) =>
          issueAttachmentFromSessionInputAttachment(attachment, utcNowIso()),
        ),
        createdBy: normalizedString(params.createdBy) || "workspace_agent",
      });
      const childSessionId = issue.sessionId;
      const blockedByTaskIds = this.incompleteBlockingTaskIds(issue);
      const workflowContext = this.issueWorkflowInputContext(issue);
      const delegatedInstruction = serializeQuotedSkillPrompt(
        subagentInstruction({
          goal: task.goal,
          context: [
            task.context || "",
            workflowContext,
          ].filter((section) => section.length > 0).join("\n\n") || null,
        }),
        forwardedQuotedSkillIds,
      );
      const session = this.store.ensureSession(
        {
          workspaceId: params.workspaceId,
          sessionId: childSessionId,
          kind: "subagent",
          parentSessionId: controllerSession.sessionId,
          title,
          createdBy: normalizedString(params.createdBy) || "workspace_agent",
          archivedAt: null,
        },
        { touchExisting: false },
      );
      if (!this.store.getBinding({ workspaceId: params.workspaceId, sessionId: session.sessionId })) {
        this.store.upsertBinding({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
          harness: resolvedWorkspaceHarness(workspace),
          harnessSessionId: session.sessionId,
        });
      }
      if (blockedByTaskIds.length > 0) {
        this.store.ensureRuntimeState({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
          status: "IDLE",
        });
        this.store.updateRuntimeState({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
          status: "IDLE",
          currentInputId: null,
          currentWorkerId: null,
          leaseUntil: null,
          heartbeatAt: null,
          lastError: null,
        });
        createdTasks.push({
          ...taskPayload({
            issue,
            blockedByTaskIds,
          }),
          child_session_id: session.sessionId,
          initial_child_input_id: null,
          current_child_input_id: null,
          latest_child_input_id: null,
        });
      } else {
        const createdRun = this.store.createSubagentRun({
          workspaceId: params.workspaceId,
          parentSessionId: controllerSession.sessionId,
          parentInputId,
          originMainSessionId: controllerSession.sessionId,
          ownerMainSessionId: controllerSession.sessionId,
          childSessionId: session.sessionId,
          title,
          goal: task.goal,
          context: task.context || null,
          sourceType: "delegate_task",
          sourceId: issue.issueId,
          issueId: issue.issueId,
          toolProfile,
          requestedModel,
          effectiveModel,
          status: "queued",
        });
        this.store.ensureRuntimeState({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
          status: "QUEUED",
        });
        const input = this.store.enqueueInput({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
          payload: {
            text: delegatedInstruction,
            attachments: forwardedAttachments,
            image_urls: forwardedImageUrls,
            model: effectiveModel,
            thinking_value: effectiveProfile.thinkingValue,
            context: {
              source: "issue_bootstrap",
              subagent_id: createdRun.subagentId,
              parent_session_id: controllerSession.sessionId,
              parent_input_id: parentInputId,
              origin_main_session_id: controllerSession.sessionId,
              owner_main_session_id: controllerSession.sessionId,
              issue_id: issue.issueId,
              goal: task.goal,
              task_title: title,
              task_context: task.context || null,
              workflow_blocked_by: issue.blockedBy.map((edge) => ({
                task_id: edge.taskId,
                relation: edge.relation,
                instruction: edge.instruction,
              })) as JsonValue,
              tool_profile: toolProfile,
              requested_model: requestedModel,
              effective_model: effectiveModel,
              forwarded_attachment_count: forwardedAttachments.length,
              forwarded_quoted_skill_ids: forwardedQuotedSkillIds,
            },
          },
        });
        this.store.updateRuntimeState({
          workspaceId: params.workspaceId,
          sessionId: session.sessionId,
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
              issueId: issue.issueId,
              status: "queued",
            },
          }) ?? createdRun;
        this.store.updateIssue({
          workspaceId: params.workspaceId,
          issueId: issue.issueId,
          fields: {
            latestSubagentId: updatedRun.subagentId,
          },
        });
        createdTasks.push({
          ...delegatedTaskManagerPayload(this.syncSubagentRunState(updatedRun)),
          blocked_by: issue.blockedBy.map((edge) => ({
            task_id: edge.taskId,
            relation: edge.relation,
            instruction: edge.instruction,
          })),
          blocked_by_task_ids: blockedByTaskIds,
          workflow_blocked: blockedByTaskIds.length > 0,
        });
      }
    }

    this.options.queueWorker?.wake();
    return {
      tasks: createdTasks,
      count: createdTasks.length,
    };
  }

  dispatchIssue(params: {
    workspaceId: string;
    issueId: string;
    sourceType?: string | null;
    sourceId?: string | null;
    requestedModel?: string | null;
    selectedModel?: string | null;
    selectedThinkingValue?: string | null;
    parentSessionId?: string | null;
    parentInputId?: string | null;
    originMainSessionId?: string | null;
    ownerMainSessionId?: string | null;
    createdBy?: string | null;
    priority?: number | null;
    sessionKind?: string | null;
    toolKind?: string | null;
    draftPayload?: Record<string, unknown> | null;
    outputSchema?: Record<string, unknown> | null;
    upstreamSummary?: string | null;
    upstreamAssistantText?: string | null;
  }): {
    issue: IssueRecord;
    session: AgentSessionRecord;
    input: SessionInputRecord;
    run: SyncedSubagentRunState;
  } {
    const workspace = this.requireWorkspace(params.workspaceId);
    const issue = this.store.getIssue({
      workspaceId: params.workspaceId,
      issueId: params.issueId,
    });
    if (!issue) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "issue_not_found",
        `issue ${params.issueId} not found`,
      );
    }
    if (issue.activeSubagentId) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_already_running",
        "issue already has an active run",
      );
    }
    const blockedByTaskIds = this.incompleteBlockingTaskIds(issue);
    if (blockedByTaskIds.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_blocked_by_incomplete_tasks",
        `issue is blocked by incomplete tasks: ${blockedByTaskIds.join(", ")}`,
      );
    }
    const latestRunId = normalizedString(issue.latestSubagentId);
    if (latestRunId) {
      const latestRun = this.store.getSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: latestRunId,
      });
      if (
        latestRun &&
        ["queued", "running", "waiting_on_user"].includes(
          normalizedString(latestRun.status),
        )
      ) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "issue_run_already_queued",
          "issue already has work queued or running",
        );
      }
    }

    const requestedModel = normalizedString(params.requestedModel) || null;
    const effectiveProfile = resolveSubagentExecutionProfile({
      selectedModel: normalizedString(params.selectedModel) || null,
      selectedThinkingValue: normalizedString(params.selectedThinkingValue) || null,
    });
    const effectiveModel = effectiveProfile.model;
    const sourceType = this.resolveIssueRunSourceType({
      workspaceId: params.workspaceId,
      issue,
      explicitSourceType: params.sourceType,
    });
    const routing = this.resolveIssueExecutionRouting({
      workspace,
      issue,
      explicitParentSessionId: params.parentSessionId,
      explicitOriginMainSessionId: params.originMainSessionId,
      explicitOwnerMainSessionId: params.ownerMainSessionId,
    });
    const resolvedSessionKind =
      normalizedString(params.sessionKind).toLowerCase() === "tool_node"
        ? "tool_node"
        : "subagent";
    const toolKind = normalizedString(params.toolKind) || null;
    const draftPayload =
      params.draftPayload && typeof params.draftPayload === "object"
        ? (params.draftPayload as Record<string, unknown>)
        : null;
    const outputSchema =
      params.outputSchema && typeof params.outputSchema === "object"
        ? (params.outputSchema as Record<string, unknown>)
        : null;
    const upstreamSummary = normalizedString(params.upstreamSummary) || null;
    const upstreamAssistantText =
      normalizedString(params.upstreamAssistantText) || null;
    const toolNodeContextPayload =
      resolvedSessionKind === "tool_node" && toolKind
        ? {
            tool_kind: toolKind,
            draft_payload: draftPayload ?? {},
            output_schema: outputSchema ?? {},
            upstream_summary: upstreamSummary,
            upstream_assistant_text: upstreamAssistantText,
          }
        : null;
    const session = this.store.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: issue.sessionId,
        kind: resolvedSessionKind,
        parentSessionId: routing.parentSessionId,
        title: issue.title,
        createdBy:
          normalizedString(params.createdBy) ||
          issue.createdBy ||
          "workspace_user",
        archivedAt: null,
      },
      { touchExisting: false },
    );
    if (!this.store.getBinding({ workspaceId: params.workspaceId, sessionId: session.sessionId })) {
      this.store.upsertBinding({
        workspaceId: params.workspaceId,
        sessionId: session.sessionId,
        harness: resolvedWorkspaceHarness(workspace),
        harnessSessionId: session.sessionId,
      });
    }
    const toolProfile = {
      requested_tools: ["terminal", "file", "browser", "web"],
    };
    const createdRun = this.upsertIssueExecutionRun({
      workspaceId: params.workspaceId,
      issue,
      session,
      routing,
      requestedModel,
      effectiveModel,
      toolProfile,
      sourceType,
      sourceId: normalizedString(params.sourceId) || issue.issueId,
      parentInputId: normalizedString(params.parentInputId) || null,
      runContext: toolNodeContextPayload
        ? { tool_node_context: toolNodeContextPayload }
        : null,
      childSessionKind: resolvedSessionKind,
    });
    this.store.ensureRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
      status: "QUEUED",
    });
    const input = this.store.enqueueInput({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? Math.trunc(params.priority)
          : undefined,
      payload: {
        text: issueDispatchInstruction({
          issue,
          sourceType: params.sourceType,
          extraContext:
            normalizedString(params.sourceType).toLowerCase() === "workflow_unblocked"
              ? this.issueWorkflowInputContext(issue)
              : null,
        }),
        attachments: issue.attachments.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          workspace_path: attachment.workspacePath,
        })),
        image_urls: [],
        model: effectiveModel,
        thinking_value: effectiveProfile.thinkingValue,
        context: {
          source: "issue_bootstrap",
          subagent_id: createdRun.subagentId,
          issue_id: issue.issueId,
          parent_session_id: routing.parentSessionId,
          parent_input_id: normalizedString(params.parentInputId) || null,
          origin_main_session_id: routing.originMainSessionId,
          owner_main_session_id: routing.ownerMainSessionId,
          task_title: issue.title,
          goal: normalizedString(issue.description) || issue.title,
          requested_model: requestedModel,
          effective_model: effectiveModel,
          workflow_blocked_by: issue.blockedBy.map((edge) => ({
            task_id: edge.taskId,
            relation: edge.relation,
            instruction: edge.instruction,
          })) as JsonValue,
          ...(toolNodeContextPayload
            ? { tool_node_context: toolNodeContextPayload as JsonValue }
            : {}),
        },
      },
    });
    this.store.updateRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
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
          issueId: issue.issueId,
          status: "queued",
        },
      }) ?? createdRun;
    const updatedIssue =
      this.store.updateIssue({
        workspaceId: params.workspaceId,
        issueId: issue.issueId,
        fields: {
          status: "todo",
          latestSubagentId: updatedRun.subagentId,
          activeSubagentId: null,
          blockerReason: null,
          completedAt: null,
        },
      }) ?? issue;
    const syncedRun = this.syncSubagentRunState(updatedRun);
    this.options.queueWorker?.wake();
    return {
      issue: updatedIssue,
      session,
      input,
      run: syncedRun,
    };
  }

  queueIssueReply(params: {
    workspaceId: string;
    issueId: string;
    text: string;
    attachments?: SessionInputAttachmentPayload[] | null;
    imageUrls?: string[] | null;
    createdBy?: string | null;
    selectedModel?: string | null;
    selectedThinkingValue?: string | null;
    model?: string | null;
    priority?: number | null;
  }): {
    issue: IssueRecord;
    session: AgentSessionRecord;
    input: SessionInputRecord;
    run: SyncedSubagentRunState;
  } {
    const workspace = this.requireWorkspace(params.workspaceId);
    const issue = this.store.getIssue({
      workspaceId: params.workspaceId,
      issueId: params.issueId,
    });
    if (!issue) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "issue_not_found",
        `issue ${params.issueId} not found`,
      );
    }
    if (issue.status === "backlog") {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_backlog_read_only",
        "move the issue to Todo before replying in the issue thread",
      );
    }
    if (issue.activeSubagentId) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_already_running",
        "issue is currently running; wait for it to finish before replying",
      );
    }
    const blockedByTaskIds = this.incompleteBlockingTaskIds(issue);
    if (blockedByTaskIds.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_blocked_by_incomplete_tasks",
        `issue is blocked by incomplete tasks: ${blockedByTaskIds.join(", ")}`,
      );
    }
    const latestRunId = normalizedString(issue.latestSubagentId);
    if (latestRunId) {
      const latestRun = this.store.getSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: latestRunId,
      });
      if (
        latestRun &&
        ["queued", "running", "waiting_on_user"].includes(
          normalizedString(latestRun.status),
        )
      ) {
        throw new RuntimeAgentToolsServiceError(
          409,
          "issue_run_already_queued",
          "issue already has work queued or running",
        );
      }
    }

    const requestedModel = normalizedString(params.model) || null;
    const effectiveProfile = resolveSubagentExecutionProfile({
      selectedModel: params.selectedModel ?? requestedModel,
      selectedThinkingValue: params.selectedThinkingValue ?? null,
    });
    const effectiveModel = effectiveProfile.model;
    const sourceType = this.resolveIssueRunSourceType({
      workspaceId: params.workspaceId,
      issue,
    });
    const routing = this.resolveIssueExecutionRouting({
      workspace,
      issue,
    });
    const session = this.store.ensureSession(
      {
        workspaceId: params.workspaceId,
        sessionId: issue.sessionId,
        kind: "subagent",
        parentSessionId: routing.parentSessionId,
        title: issue.title,
        createdBy:
          normalizedString(params.createdBy) ||
          issue.createdBy ||
          "workspace_user",
        archivedAt: null,
      },
      { touchExisting: false },
    );
    if (!this.store.getBinding({ workspaceId: params.workspaceId, sessionId: session.sessionId })) {
      this.store.upsertBinding({
        workspaceId: params.workspaceId,
        sessionId: session.sessionId,
        harness: resolvedWorkspaceHarness(workspace),
        harnessSessionId: session.sessionId,
      });
    }
    const toolProfile = {
      requested_tools: ["terminal", "file", "browser", "web"],
    };
    const createdRun = this.upsertIssueExecutionRun({
      workspaceId: params.workspaceId,
      issue,
      session,
      routing,
      requestedModel,
      effectiveModel,
      toolProfile,
      sourceType,
      sourceId: issue.issueId,
      parentInputId: null,
    });
    this.store.ensureRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
      status: "QUEUED",
    });
    const input = this.store.enqueueInput({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? Math.trunc(params.priority)
          : undefined,
      payload: {
        text: normalizedString(params.text),
        attachments: params.attachments ?? [],
        image_urls: params.imageUrls ?? [],
        model: effectiveModel,
        thinking_value: effectiveProfile.thinkingValue,
        context: {
          source: "issue_reply",
          subagent_id: createdRun.subagentId,
          issue_id: issue.issueId,
          parent_session_id: routing.parentSessionId,
          parent_input_id: null,
          origin_main_session_id: routing.originMainSessionId,
          owner_main_session_id: routing.ownerMainSessionId,
          task_title: issue.title,
          goal: normalizedString(issue.description) || issue.title,
          requested_model: requestedModel,
          effective_model: effectiveModel,
        },
      },
    });
    this.store.updateRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: session.sessionId,
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
          issueId: issue.issueId,
          status: "queued",
        },
      }) ?? createdRun;
    this.store.updateIssue({
      workspaceId: params.workspaceId,
      issueId: issue.issueId,
      fields: {
        status: "todo",
        latestSubagentId: updatedRun.subagentId,
        activeSubagentId: null,
        blockerReason: null,
        completedAt: null,
      },
    });
    const syncedRun = this.syncSubagentRunState(updatedRun);
    const syncedIssue =
      this.store.getIssue({
        workspaceId: params.workspaceId,
        issueId: issue.issueId,
      }) ?? issue;
    this.options.queueWorker?.wake();
    return {
      issue: syncedIssue,
      session,
      input,
      run: syncedRun,
    };
  }

  getTask(params: RuntimeAgentToolsGetTaskParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const requestedSessionId = normalizedString(params.sessionId);
    if (requestedSessionId) {
      this.requireSubagentControllerSession(params.workspaceId, requestedSessionId);
    }
    const issue = this.requireTaskRecord({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
    });
    const states = this.taskRunStatesForIssue(issue);
    const syncedIssue =
      this.store.getIssue({
        workspaceId: params.workspaceId,
        issueId: issue.issueId,
      }) ?? issue;
    this.assertSameTurnDelegationPollingAllowed({
      workspaceId: params.workspaceId,
      sessionId: requestedSessionId || null,
      inputId: normalizedString(params.inputId) || null,
      states: states.allStates,
      toolId: "get_task",
    });
    return taskPayload({
      issue: syncedIssue,
      blockedByTaskIds: this.incompleteBlockingTaskIds(syncedIssue),
      activeState: states.activeState,
      latestState: states.latestState,
    });
  }

  listTasks(params: RuntimeAgentToolsListTasksParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const requestedSessionId = normalizedString(params.sessionId);
    if (requestedSessionId) {
      this.requireSubagentControllerSession(params.workspaceId, requestedSessionId);
    }
    const statuses = this.normalizedTaskStatuses(params.statuses);
    const issues = this.store.listIssues({
      workspaceId: params.workspaceId,
      statuses,
      limit: normalizedInteger(params.limit, 200, 1, 1000),
    });
    const payloads: JsonObject[] = [];
    const pollingStates: SyncedSubagentRunState[] = [];
    for (const issue of issues) {
      const states = this.taskRunStatesForIssue(issue);
      payloads.push(
        taskPayload({
          issue,
          blockedByTaskIds: this.incompleteBlockingTaskIds(issue),
          activeState: states.activeState,
          latestState: states.latestState,
        }),
      );
      pollingStates.push(...states.allStates);
    }
    this.assertSameTurnDelegationPollingAllowed({
      workspaceId: params.workspaceId,
      sessionId: requestedSessionId || null,
      inputId: normalizedString(params.inputId) || null,
      states: dedupeSyncedSubagentStates(pollingStates),
      toolId: "list_tasks",
    });
    return {
      tasks: payloads,
      count: payloads.length,
    };
  }

  replyTask(params: RuntimeAgentToolsReplyTaskParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const reply = this.queueIssueReply({
      workspaceId: params.workspaceId,
      issueId: params.taskId,
      text: params.text,
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? Math.trunc(params.priority)
          : null,
    });
    return taskPayload({
      issue: reply.issue,
      blockedByTaskIds: this.incompleteBlockingTaskIds(reply.issue),
      latestState: reply.run,
    });
  }

  async cancelTask(params: RuntimeAgentToolsCancelTaskParams): Promise<JsonObject> {
    await this.cancelIssueRun({
      workspaceId: params.workspaceId,
      issueId: params.taskId,
    });
    return this.getTask({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
    });
  }

  rerunTask(params: RuntimeAgentToolsRerunTaskParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const requestedSessionId = normalizedString(params.sessionId);
    const controllerSession = requestedSessionId
      ? this.requireSubagentControllerSession(params.workspaceId, requestedSessionId)
      : null;
    const parentInput =
      controllerSession && normalizedString(params.inputId)
        ? this.store.getInput({
            workspaceId: params.workspaceId,
            inputId: normalizedString(params.inputId),
          })
        : null;
    const controllerLatestInput = controllerSession
      ? this.latestControllerInput(params.workspaceId, controllerSession.sessionId)
      : null;
    const latestIssue = this.store.getIssue({
      workspaceId: params.workspaceId,
      issueId: params.taskId,
    });
    const latestRun = latestIssue?.latestSubagentId
      ? this.store.getSubagentRun({
          workspaceId: params.workspaceId,
          subagentId: latestIssue.latestSubagentId,
        })
      : null;
    const previousChildInput = normalizedString(latestRun?.latestChildInputId)
      ? this.store.getInput({
          workspaceId: params.workspaceId,
          inputId: normalizedString(latestRun?.latestChildInputId),
        })
      : null;
    const rerun = this.dispatchIssue({
      workspaceId: params.workspaceId,
      issueId: params.taskId,
      parentSessionId: controllerSession?.sessionId ?? null,
      parentInputId: controllerSession ? (normalizedString(params.inputId) || null) : null,
      originMainSessionId: controllerSession?.sessionId ?? null,
      ownerMainSessionId: controllerSession?.sessionId ?? null,
      requestedModel: normalizedString(params.model) || null,
      selectedModel:
        normalizedString(params.selectedModel) ||
        normalizedString(params.model) ||
        inputModelValue(parentInput) ||
        inputModelValue(controllerLatestInput) ||
        inputModelValue(previousChildInput) ||
        normalizedString(latestRun?.effectiveModel) ||
        null,
      selectedThinkingValue:
        inputThinkingValue(parentInput) ??
        inputThinkingValue(controllerLatestInput) ??
        inputThinkingValue(previousChildInput),
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? Math.trunc(params.priority)
          : null,
    });
    return taskPayload({
      issue: rerun.issue,
      blockedByTaskIds: this.incompleteBlockingTaskIds(rerun.issue),
      activeState: rerun.issue.activeSubagentId === rerun.run.run.subagentId ? rerun.run : null,
      latestState: rerun.run,
    });
  }

  syncLinkedIssueWorkflowForChildSession(params: {
    workspaceId: string;
    childSessionId: string;
  }): void {
    const childSessionId = normalizedString(params.childSessionId);
    if (!childSessionId) {
      return;
    }
    const run = this.store.getSubagentRunByChildSession({
      workspaceId: params.workspaceId,
      childSessionId,
    });
    if (!run) {
      return;
    }
    this.syncSubagentRunState(run);
  }

  async cancelSubagent(params: RuntimeAgentToolsCancelSubagentParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const controllerSession = this.requireSubagentControllerSession(params.workspaceId, params.sessionId);
    let state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId: params.subagentId,
      ownerMainSessionId: controllerSession.sessionId,
    });
    return subagentRunPayload(
      await this.cancelSyncedSubagentRunState(state, {
        workspaceId: params.workspaceId,
        ownerMainSessionId: controllerSession.sessionId,
      }),
    );
  }

  async cancelIssueRun(params: {
    workspaceId: string;
    issueId: string;
  }): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const issue = this.store.getIssue({
      workspaceId: params.workspaceId,
      issueId: params.issueId,
    });
    if (!issue) {
      throw new RuntimeAgentToolsServiceError(404, "issue_not_found", "issue not found");
    }
    const subagentId =
      normalizedString(issue.activeSubagentId) ||
      normalizedString(issue.latestSubagentId);
    if (!subagentId) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_not_running",
        "issue does not have queued or running work to cancel",
      );
    }
    const run = this.requireSubagentRun({
      workspaceId: params.workspaceId,
      subagentId,
    });
    const workspace = this.requireWorkspace(params.workspaceId);
    const ownerMainSessionId =
      this.resolveIssueExecutionRouting({
        workspace,
        issue,
        explicitParentSessionId: run.parentSessionId,
        explicitOriginMainSessionId: run.originMainSessionId,
        explicitOwnerMainSessionId: run.ownerMainSessionId,
      }).ownerMainSessionId;
    const state = this.syncSubagentRunForOwner({
      workspaceId: params.workspaceId,
      subagentId,
      ownerMainSessionId,
    });
    if (!["queued", "running", "waiting_on_user"].includes(state.run.status)) {
      throw new RuntimeAgentToolsServiceError(
        409,
        "issue_not_running",
        "issue does not have queued or running work to cancel",
      );
    }
    return subagentRunPayload(
      await this.cancelSyncedSubagentRunState(state, {
        workspaceId: params.workspaceId,
        ownerMainSessionId,
      }),
    );
  }

  private async cancelSyncedSubagentRunState(
    initialState: SyncedSubagentRunState,
    params: {
      workspaceId: string;
      ownerMainSessionId: string;
    },
  ): Promise<SyncedSubagentRunState> {
    let state = initialState;
    if (state.run.status === "cancelled") {
      return state;
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
        subagentId: state.run.subagentId,
        ownerMainSessionId: params.ownerMainSessionId,
      });
    } else if (!["waiting_on_user", "queued", "running"].includes(state.run.status)) {
      return state;
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
        subagentId: state.run.subagentId,
        ownerMainSessionId: params.ownerMainSessionId,
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
    const syncedState = this.syncSubagentRunState(updated);
    if (syncedState.run.issueId) {
      this.store.updateIssue({
        workspaceId: params.workspaceId,
        issueId: syncedState.run.issueId,
        fields: {
          status: "blocked",
          blockerReason: "Run cancelled by user.",
          activeSubagentId: null,
          latestSubagentId: syncedState.run.subagentId,
          completedAt: null,
        },
      });
    }
    return syncedState;
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
      toolId: "background task list endpoint",
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
      toolId: "background task detail endpoint",
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
      const imageOutputRoot = this.store.sessionOutputRoot({
        workspaceId: params.workspaceId,
        sessionId,
      });
      const generated = await generateWorkspaceImage({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        // Project-bound sessions write artifacts under the project dir, not the
        // workspace root (mirrors resolveOutputAbsolutePath's read side).
        outputRoot: imageOutputRoot,
        sessionId,
        inputId: "runtime-tool",
        selectedModel: params.selectedModel,
        prompt,
        filename: params.filename,
        size: params.size,
      });
      // Register the image as this turn's output ourselves rather than leaving it
      // to the end-of-turn file scan. The scan only sees "a new file appeared",
      // so an image recorded that way carries no trace of what generated it —
      // and which model made a picture is exactly what someone looking at it
      // later wants to know. The turn-scoped dedup guard means recording it here
      // suppresses the scan's own entry rather than duplicating it.
      this.store.createOutput({
        workspaceId: params.workspaceId,
        outputType: "image",
        title: path.basename(generated.filePath),
        status: "completed",
        // Absolute, so the end-of-turn scan's dedup — which compares absolute
        // paths — matches this row. A relative path would be resolved against
        // the project root instead of the session root this image was written
        // to, miss, and the scan would register the same file a second time.
        filePath: path.isAbsolute(generated.filePath)
          ? generated.filePath
          : path.join(imageOutputRoot, generated.filePath),
        sessionId,
        inputId: normalizedString(params.inputId) || null,
        artifactId: randomUUID(),
        metadata: {
          origin_type: "runtime_tool",
          change_type: "created",
          category: "image",
          artifact_type: "image",
          mime_type: generated.mimeType,
          size_bytes: generated.sizeBytes,
          tool_id: "image_generate",
          model: generated.modelId,
          // The generation itself, so anyone who sees this image later can read
          // what produced it. `prompt` is what the caller compiled and sent;
          // `revised_prompt` is what the provider rewrote it to, which is a
          // different fact and worth keeping separately.
          prompt: generated.prompt,
          ...(generated.revisedPrompt
            ? { revised_prompt: generated.revisedPrompt }
            : {}),
          ...(normalizedString(params.size)
            ? { image_size: normalizedString(params.size) }
            : {}),
          ...(generated.providerId ? { provider: generated.providerId } : {}),
          ...(sessionId ? { source_session_id: sessionId } : {}),
        },
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

  async generateVideo(params: RuntimeAgentToolsGenerateVideoParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId) || "session-main";
    const prompt = normalizedString(params.prompt);
    if (!prompt) {
      throw new RuntimeAgentToolsServiceError(400, "video_prompt_required", "prompt is required");
    }
    try {
      const videoOutputRoot = this.store.sessionOutputRoot({
        workspaceId: params.workspaceId,
        sessionId,
      });
      const generated = await generateWorkspaceVideo({
        workspaceRoot: this.options.workspaceRoot,
        workspaceId: params.workspaceId,
        // Project-bound sessions write artifacts under the project dir, not the
        // workspace root (mirrors resolveOutputAbsolutePath's read side).
        outputRoot: videoOutputRoot,
        sessionId,
        inputId: "runtime-tool",
        selectedModel: params.selectedModel,
        prompt,
        filename: params.filename,
        size: params.size,
        seconds: params.seconds,
      });
      // Same reason as image_generate: left to the end-of-turn file scan this
      // would be recorded as "a new .mp4 appeared", with no trace of the prompt
      // or model behind it. Absolute path so the scan's dedup matches.
      this.store.createOutput({
        workspaceId: params.workspaceId,
        outputType: "video",
        title: path.basename(generated.filePath),
        status: "completed",
        filePath: path.isAbsolute(generated.filePath)
          ? generated.filePath
          : path.join(videoOutputRoot, generated.filePath),
        sessionId,
        inputId: normalizedString(params.inputId) || null,
        artifactId: randomUUID(),
        metadata: {
          origin_type: "runtime_tool",
          change_type: "created",
          category: "video",
          artifact_type: "video",
          mime_type: generated.mimeType,
          size_bytes: generated.sizeBytes,
          tool_id: "video_generate",
          model: generated.modelId,
          prompt: generated.prompt,
          ...(normalizedString(params.size)
            ? { video_size: normalizedString(params.size) }
            : {}),
          ...(params.seconds ? { video_seconds: params.seconds } : {}),
          ...(generated.providerId ? { provider: generated.providerId } : {}),
          ...(sessionId ? { source_session_id: sessionId } : {}),
        },
      });
      return {
        file_path: generated.filePath,
        mime_type: generated.mimeType,
        size_bytes: generated.sizeBytes,
        provider_id: generated.providerId,
        model_id: generated.modelId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /not configured|configure a video generation provider/i.test(error.message)
      ) {
        throw new RuntimeAgentToolsServiceError(409, "video_generation_not_configured", error.message);
      }
      throw new RuntimeAgentToolsServiceError(
        502,
        "video_generation_failed",
        error instanceof Error ? error.message : "video generation failed",
      );
    }
  }

  async openMacosSettings(params: { pane?: string | null }): Promise<JsonObject> {
    const requestedPane = normalizedString(params.pane ?? "") || "privacy";

    // Prefer the desktop bridge: the Electron main process can REGISTER Holaboss
    // with macOS (desktopCapturer / askForMediaAccess / accessibility prompt) so
    // it shows up in the relevant Settings list — opening a pane alone can't do
    // that (that's why screencapture's failure never adds Holaboss). Falls back
    // to opening the pane via the host `open` when the bridge is unavailable.
    const bridge = this.resolveDesktopPermissionBridge();
    if (bridge) {
      try {
        const response = await fetch(`${bridge.origin}/api/v1/macos-permission`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-holaboss-desktop-token": bridge.authToken,
          },
          body: JSON.stringify({ kind: requestedPane }),
        });
        if (response.ok) {
          const result = (await response.json()) as JsonObject;
          return {
            ...result,
            via: "desktop",
            message:
              `Requested the macOS '${requestedPane.replace(/_/g, " ")}' permission for Holaboss — ` +
              "registered it where the OS supports a prompt and opened the relevant Settings pane. " +
              "Ask the user to enable Holaboss there if it isn't already, then retry the original operation.",
          };
        }
      } catch {
        // fall through to the host-open fallback below
      }
    }

    // Fallback: open the Settings pane via the host `open` (no registration).
    const PANE_ANCHORS: Record<string, string> = {
      screen_recording: "Privacy_ScreenCapture",
      accessibility: "Privacy_Accessibility",
      input_monitoring: "Privacy_ListenEvent",
      full_disk_access: "Privacy_AllFiles",
      files_and_folders: "Privacy_FilesAndFolders",
      automation: "Privacy_Automation",
      camera: "Privacy_Camera",
      microphone: "Privacy_Microphone",
      location: "Privacy_LocationServices",
      privacy: "Privacy",
    };
    const anchor = PANE_ANCHORS[requestedPane] ?? PANE_ANCHORS.privacy;
    if (process.platform !== "darwin") {
      return {
        opened: false,
        platform: process.platform,
        pane: requestedPane,
        message:
          "open_macos_settings only applies to the macOS desktop host; there is nothing to open on this platform.",
      };
    }
    const settingsUrl = `x-apple.systempreferences:com.apple.preference.security?${anchor}`;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("open", [settingsUrl], (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        500,
        "open_macos_settings_failed",
        `Failed to open macOS settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      opened: true,
      via: "host",
      pane: requestedPane,
      url: settingsUrl,
      message:
        `Opened macOS System Settings → Privacy & Security (${requestedPane.replace(/_/g, " ")}). ` +
        "Ask the user to enable Holaboss there (toggle it on, re-launch if prompted), then retry the original operation.",
    };
  }

  private resolveDesktopPermissionBridge(): {
    origin: string;
    authToken: string;
  } | null {
    try {
      const config = resolveProductRuntimeConfig({
        requireAuth: false,
        requireBaseUrl: false,
      });
      if (
        config.desktopBrowserEnabled &&
        config.desktopBrowserUrl.trim() &&
        config.desktopBrowserAuthToken.trim()
      ) {
        return {
          origin: new URL(config.desktopBrowserUrl).origin,
          authToken: config.desktopBrowserAuthToken,
        };
      }
    } catch {
      // config unavailable — no bridge, caller falls back to host `open`
    }
    return null;
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

    // SSRF: the download URL is agent-controlled — reject any target (and any
    // redirect hop) that resolves into loopback/private/link-local/reserved
    // address space. `ssrfSafeFetch` also uses redirect:"manual" so a public
    // URL can't 30x-redirect into a blocked host after this check.
    let response: Response;
    try {
      response = await ssrfSafeFetch(parsedUrl.toString(), {
        init: {
          method: "GET",
          signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS),
        },
      });
    } catch (error) {
      if (error instanceof RuntimeAgentToolsServiceError) {
        throw error;
      }
      // Distinguish an SSRF/validation rejection (400) from a network failure.
      const message = error instanceof Error ? error.message : "";
      if (
        message.includes("non-public") ||
        message.includes("not allowed") ||
        message.includes("could not be resolved") ||
        message.includes("must use http") ||
        message.includes("too many redirects")
      ) {
        throw new RuntimeAgentToolsServiceError(400, "download_url_invalid", message);
      }
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
    // Output root depends on the session's project: project-bound sessions
    // write under <project_path>/outputs/, General sessions under
    // <workspace_dir>/outputs/. Either way the stored file_path stays
    // relative so the consumer's resolveOutputAbsolutePath can re-derive
    // the absolute path from the persisted projectId.
    const outputRoot = this.store.sessionOutputRoot({
      workspaceId: params.workspaceId,
      sessionId: sessionId || null,
    });
    const { absolutePath, relativePath } = await reportOutputFilePath({
      workspaceDir: outputRoot,
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

  /** What an earlier record of the same file already knows about how it was
   *  made. Only the generation keys — the delivery record keeps its own identity. */
  private generationMetadataFor(
    workspaceId: string,
    inputId: string | null,
    filePath: string
  ): Record<string, unknown> {
    if (!inputId) {
      return {};
    }
    const GENERATION_KEYS = [
      "prompt",
      "revised_prompt",
      "model",
      "model_id",
      "provider",
      "image_size",
      "video_size",
      "video_seconds",
      "category",
      "artifact_type",
    ];
    try {
      const prior = this.store.listOutputs({ workspaceId, inputId, limit: 50 });
      for (const record of prior) {
        if (record.filePath !== filePath || !record.metadata) {
          continue;
        }
        const meta = record.metadata as Record<string, unknown>;
        const carried: Record<string, unknown> = {};
        for (const key of GENERATION_KEYS) {
          if (meta[key] !== undefined && meta[key] !== null) {
            carried[key] = meta[key];
          }
        }
        if (Object.keys(carried).length > 0) {
          return carried;
        }
      }
    } catch {
      // A lookup failure must never stop a file from being delivered.
    }
    return {};
  }

  /**
   * Deliver an EXISTING file to the user by registering it as this turn's output
   * (so channel egress / the chat sends it as an attachment). Unlike write_report
   * / image_generate, the file is not created here — it already exists; we only
   * register it against the current session + input so it is picked up as a
   * turn-scoped deliverable.
   */
  async sendFile(params: RuntimeAgentToolsSendFileParams): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const sessionId = normalizedString(params.sessionId);
    const rawPath = normalizedString(params.path);
    if (!rawPath) {
      throw new RuntimeAgentToolsServiceError(400, "send_file_path_required", "path is required");
    }
    // Accept an absolute path (agents usually deliver a file they just located)
    // or one relative to the workspace root.
    let workspaceDir: string;
    try {
      workspaceDir = this.store.workspaceDir(params.workspaceId);
    } catch {
      workspaceDir = this.options.workspaceRoot;
    }
    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceDir, rawPath);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats) {
      throw new RuntimeAgentToolsServiceError(404, "send_file_not_found", `file not found: ${rawPath}`);
    }
    if (!stats.isFile()) {
      throw new RuntimeAgentToolsServiceError(400, "send_file_not_a_file", `not a file: ${rawPath}`);
    }
    const title = path.basename(absolutePath);
    const inputId = normalizedString(params.inputId) || null;
    const output = this.store.createOutput({
      workspaceId: params.workspaceId,
      outputType: "file",
      title,
      status: "completed",
      filePath: absolutePath,
      sessionId: sessionId || null,
      inputId,
      artifactId: randomUUID(),
      metadata: {
        // Delivering a generated file writes a second record for it, and this
        // one describes the delivery. Carry the generation forward or the last
        // record wins downstream and the artifact reads as having no prompt.
        ...this.generationMetadataFor(params.workspaceId, inputId, absolutePath),
        origin_type: "runtime_tool",
        change_type: "delivered",
        tool_id: "send_file",
        size_bytes: stats.size,
        ...(sessionId ? { source_session_id: sessionId } : {}),
      },
    });
    return {
      output_id: output.id,
      artifact_id: output.artifactId,
      title: output.title,
      file_path: absolutePath,
      size_bytes: stats.size,
      created_at: output.createdAt,
    };
  }

  async holahubUploadImage(params: {
    workspaceId: string;
    path: string;
  }): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const rawPath = normalizedString(params.path);
    if (!rawPath) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "holahub_image_path_required",
        "path is required",
      );
    }
    let workspaceDir: string;
    try {
      workspaceDir = this.store.workspaceDir(params.workspaceId);
    } catch {
      workspaceDir = this.options.workspaceRoot;
    }
    const absolutePath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(workspaceDir, rawPath);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "holahub_image_not_found",
        `file not found: ${rawPath}`,
      );
    }
    if (stats.size > HOLAHUB_MAX_IMAGE_BYTES) {
      throw new RuntimeAgentToolsServiceError(
        413,
        "holahub_image_too_large",
        "image exceeds 4 MB",
      );
    }
    const contentType = holahubImageContentType(absolutePath);
    if (!contentType) {
      throw new RuntimeAgentToolsServiceError(
        415,
        "holahub_image_unsupported_type",
        "image must be png, jpeg, webp, or gif",
      );
    }
    // The HolaHub MCP url + bearer the desktop wrote into workspace.yaml; the
    // upload endpoint is its /images sibling (see registerHolahubMcp).
    const target = holahubUploadTarget(workspaceDir);
    if (!target.uploadUrl) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "holahub_not_connected",
        "HolaHub is not connected for this workspace",
      );
    }
    const bytes = await fs.readFile(absolutePath);
    let res: Response;
    try {
      res = await fetch(target.uploadUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.authorization
            ? { Authorization: target.authorization }
            : {}),
        },
        body: JSON.stringify({
          contentType,
          dataBase64: bytes.toString("base64"),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "holahub_image_upload_failed",
        timeoutErrorMessage(error),
      );
    }
    if (!res.ok) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "holahub_image_upload_failed",
        `upload failed with status ${res.status}`,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    const imageId = typeof body?.id === "string" ? body.id : "";
    if (!imageId) {
      throw new RuntimeAgentToolsServiceError(
        502,
        "holahub_image_upload_failed",
        "upload returned no image id",
      );
    }
    return { image_id: imageId };
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
    const result = await retrieveWorkspaceMemory({
      store: this.store,
      workspaceId: params.workspaceId,
      query: params.query,
      intent: normalizedString(params.intent) || null,
      categories: params.scope?.categories ?? null,
      treeIds: params.scope?.treeIds ?? null,
      retrievalPolicy: params.retrievalPolicy ?? null,
      answerGoal: normalizedString(params.answerGoal) || null,
      selectedModel: normalizedString(params.selectedModel) || null,
      sessionId: normalizedString(params.sessionId) || null,
      inputId: normalizedString(params.inputId) || null,
    });
    return {
      tool_id: "memory_retrieve",
      intent: result.intent,
      categories: result.categories,
      query: result.query,
      answer_goal: result.answer_goal,
      retrieval_pack: result.retrieval_pack as unknown as JsonValue,
      evidence: result.evidence as unknown as JsonValue,
      gaps: result.gaps as unknown as JsonValue,
      coverage: result.coverage as unknown as JsonValue,
    };
  }

  invokeSkill(params: RuntimeAgentToolsInvokeSkillParams): JsonObject {
    this.requireWorkspace(params.workspaceId);
    try {
      const workspaceDir = this.store.workspaceDir(params.workspaceId);
      const result = invokeWorkspaceSkill({
        requestedName: params.requestedName,
        args: params.args,
        workspaceSkills: projectSessionVisibleWorkspaceSkills({
          workspaceSkills: resolveWorkspaceSkills(workspaceDir),
        }),
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

  private normalizedTaskStatuses(statuses: string[] | null | undefined): IssueStatus[] {
    const normalized = Array.from(
      new Set(normalizedStringList(statuses).map((status) => status.toLowerCase())),
    );
    for (const status of normalized) {
      if (
        status !== "backlog" &&
        status !== "todo" &&
        status !== "in_progress" &&
        status !== "in_review" &&
        status !== "done" &&
        status !== "blocked"
      ) {
        throw new RuntimeAgentToolsServiceError(
          400,
          "task_status_invalid",
          `unsupported task status filter: ${status}`,
        );
      }
    }
    return normalized as IssueStatus[];
  }

  private requireTaskRecord(params: { workspaceId: string; taskId: string }): IssueRecord {
    const issue = this.store.getIssue({
      workspaceId: params.workspaceId,
      issueId: params.taskId,
    });
    if (!issue) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "task_not_found",
        `task ${params.taskId} not found`,
      );
    }
    return issue;
  }

  private taskRunStatesForIssue(issue: IssueRecord): {
    activeState: SyncedSubagentRunState | null;
    latestState: SyncedSubagentRunState | null;
    allStates: SyncedSubagentRunState[];
  } {
    const activeState = normalizedString(issue.activeSubagentId)
      ? this.syncTaskRunState({
          workspaceId: issue.workspaceId,
          subagentId: issue.activeSubagentId,
        })
      : null;
    const latestState =
      normalizedString(issue.latestSubagentId) &&
      normalizedString(issue.latestSubagentId) !== normalizedString(issue.activeSubagentId)
        ? this.syncTaskRunState({
            workspaceId: issue.workspaceId,
            subagentId: issue.latestSubagentId,
          })
        : activeState;
    return {
      activeState,
      latestState,
      allStates: dedupeSyncedSubagentStates(
        [activeState, latestState].filter(
          (state): state is SyncedSubagentRunState => state !== null,
        ),
      ),
    };
  }

  private syncTaskRunState(params: {
    workspaceId: string;
    subagentId: string | null;
  }): SyncedSubagentRunState | null {
    const subagentId = normalizedString(params.subagentId);
    if (!subagentId) {
      return null;
    }
    const run = this.store.getSubagentRun({
      workspaceId: params.workspaceId,
      subagentId,
    });
    return run ? this.syncSubagentRunState(run) : null;
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
    if (kind === "subagent" || kind === "cronjob") {
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

  syncSubagentRun(params: {
    workspaceId: string;
    subagentId: string;
  }): SyncedSubagentRunState {
    return this.syncSubagentRunState(
      this.requireSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: params.subagentId,
      }),
    );
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

  private issueBlockerReasonFromState(state: SyncedSubagentRunState): string | null {
    const blockingQuestion = normalizedString(
      state.run.blockingPayload?.blocking_question,
    );
    if (blockingQuestion) {
      return blockingQuestion;
    }
    const summary = normalizedString(
      state.run.blockingPayload?.summary ??
        state.run.summary ??
        state.latestTurnResult?.assistantText,
    );
    return summary || null;
  }

  private incompleteBlockingTaskIds(issue: Pick<IssueRecord, "workspaceId" | "blockedBy">): string[] {
    const blockedByTaskIds: string[] = [];
    for (const edge of issue.blockedBy) {
      const blocker = this.store.getIssue({
        workspaceId: issue.workspaceId,
        issueId: edge.taskId,
      });
      if (!blocker || blocker.status !== "done") {
        blockedByTaskIds.push(edge.taskId);
      }
    }
    return blockedByTaskIds;
  }

  private workflowRelationInstruction(edge: IssueBlockedByRecord): string {
    switch (edge.relation) {
      case "handoff":
        return "Continue from this upstream task's result and carry the work forward from the state it produced.";
      case "input":
        return "Use this upstream task's output as source input for this task.";
    }
  }

  private issueWorkflowInputContext(issue: Pick<IssueRecord, "workspaceId" | "blockedBy">): string {
    if (issue.blockedBy.length === 0) {
      return "";
    }
    const sections: string[] = ["Workflow inputs from blocking tasks:"];
    for (const edge of issue.blockedBy) {
      const blocker = this.store.getIssue({
        workspaceId: issue.workspaceId,
        issueId: edge.taskId,
      });
      if (!blocker) {
        sections.push(
          [
            `- Blocking task ${edge.taskId}`,
            `  Relation: ${edge.relation}`,
            `  Runtime behavior: ${this.workflowRelationInstruction(edge)}`,
            edge.instruction ? `  Instruction: ${edge.instruction}` : "",
            "  Status: missing",
          ].filter((line) => line.length > 0).join("\n"),
        );
        continue;
      }
      const latestState = blocker.latestSubagentId
        ? this.syncSubagentRunState(
            this.requireSubagentRun({
              workspaceId: blocker.workspaceId,
              subagentId: blocker.latestSubagentId,
            }),
          )
        : null;
      const result = normalizedString(
        latestState?.run.resultPayload?.summary ??
          latestState?.run.summary ??
          latestState?.latestTurnResult?.assistantText,
      );
      sections.push(
        [
          `- Blocking task ${blocker.issueId}: ${blocker.title}`,
          `  Relation: ${edge.relation}`,
          `  Runtime behavior: ${this.workflowRelationInstruction(edge)}`,
          edge.instruction ? `  Instruction: ${edge.instruction}` : "",
          `  Status: ${blocker.status}`,
          result ? `  Output:\n${result}` : "",
        ].filter((line) => line.length > 0).join("\n"),
      );
    }
    return sections.join("\n\n");
  }

  private issueFailureReasonFromState(state: SyncedSubagentRunState): string | null {
    const errorMessage = normalizedString(
      state.run.errorPayload?.message ??
        state.run.errorPayload?.summary ??
        state.run.summary ??
        state.latestTurnResult?.assistantText,
    );
    return errorMessage || null;
  }

  private dispatchReadyDownstreamIssues(params: {
    completedIssue: IssueRecord;
    completedState: SyncedSubagentRunState;
  }): void {
    const downstreamIssues = this.store
      .listIssues({
        workspaceId: params.completedIssue.workspaceId,
        limit: 1000,
      })
      .filter((issue) =>
        issue.blockedBy.some((edge) => edge.taskId === params.completedIssue.issueId),
      );
    for (const downstreamIssue of downstreamIssues) {
      if (
        downstreamIssue.status !== "todo" ||
        downstreamIssue.activeSubagentId ||
        this.incompleteBlockingTaskIds(downstreamIssue).length > 0
      ) {
        continue;
      }
      try {
        this.dispatchIssue({
          workspaceId: downstreamIssue.workspaceId,
          issueId: downstreamIssue.issueId,
          sourceType: "workflow_unblocked",
          sourceId: params.completedIssue.issueId,
          parentSessionId: params.completedState.run.ownerMainSessionId,
          originMainSessionId: params.completedState.run.originMainSessionId,
          ownerMainSessionId: params.completedState.run.ownerMainSessionId,
          createdBy: "workspace_agent",
        });
      } catch (error) {
        if (
          error instanceof RuntimeAgentToolsServiceError &&
          [404, 409].includes(error.statusCode)
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private syncLinkedIssueFromSubagentState(state: SyncedSubagentRunState): void {
    const issueId = normalizedString(state.run.issueId);
    if (!issueId) {
      return;
    }
    const issue = this.store.getIssue({
      workspaceId: state.run.workspaceId,
      issueId,
    });
    if (!issue) {
      return;
    }
    const desired: Parameters<RuntimeStateStore["updateIssue"]>[0]["fields"] = {
      latestSubagentId: state.run.subagentId,
    };
    if (state.run.status === "queued") {
      desired.status = "todo";
      desired.activeSubagentId = null;
      desired.blockerReason = null;
      desired.completedAt = null;
    } else if (state.run.status === "running") {
      desired.status = "in_progress";
      desired.activeSubagentId = state.run.subagentId;
      desired.blockerReason = null;
      desired.completedAt = null;
    } else if (state.run.status === "waiting_on_user") {
      desired.status = "blocked";
      desired.activeSubagentId = null;
      desired.blockerReason =
        this.issueBlockerReasonFromState(state) ?? issue.blockerReason ?? "Waiting on user input.";
      desired.completedAt = null;
    } else if (state.run.status === "completed") {
      desired.status = "done";
      desired.activeSubagentId = null;
      desired.blockerReason = null;
      desired.completedAt =
        state.run.completedAt ??
        state.latestTurnResult?.completedAt ??
        state.latestTurnResult?.updatedAt ??
        issue.completedAt ??
        utcNowIso();
    } else if (state.run.status === "failed") {
      desired.status = "blocked";
      desired.activeSubagentId = null;
      desired.blockerReason =
        this.issueFailureReasonFromState(state) ?? issue.blockerReason ?? "Run failed.";
      desired.completedAt = null;
    } else if (state.run.status === "cancelled") {
      desired.activeSubagentId = null;
    }
    const changedFields = Object.fromEntries(
      Object.entries(desired).filter(([key, value]) => {
        if (value === undefined) {
          return false;
        }
        return issue[key as keyof IssueRecord] !== value;
      }),
    ) as Parameters<RuntimeStateStore["updateIssue"]>[0]["fields"];
    const updatedIssue = Object.keys(changedFields).length === 0
      ? issue
      : this.store.updateIssue({
      workspaceId: state.run.workspaceId,
      issueId,
      fields: changedFields,
    }) ?? issue;
    if (state.run.status === "completed" && issue.status !== "done") {
      this.dispatchReadyDownstreamIssues({
        completedIssue: updatedIssue,
        completedState: state,
      });
    }
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
    const latestTurnStatus = normalizedString(latestTurnResult?.status).toLowerCase();
    const latestTurnStopReason = normalizedString(latestTurnResult?.stopReason).toLowerCase();
    const latestTurnIndicatesWaiting =
      latestTurnStatus === "waiting_user" || latestTurnStopReason === "waiting_on_user";
    const hasWaitingBlocker = subagentRunHasWaitingBlocker(run);

    let derivedStatus = run.status;
    if (run.cancelledAt || normalizedString(run.status) === "cancelled") {
      derivedStatus = "cancelled";
    } else if (latestTurnStatus === "failed" || runtimeStatus === "ERROR") {
      derivedStatus = "failed";
    } else if (
      latestTurnStatus === "completed" &&
      (latestTurnIndicatesWaiting || runtimeStatus === "WAITING_USER" || hasWaitingBlocker)
    ) {
      derivedStatus = "waiting_on_user";
    } else if (latestTurnStatus === "completed") {
      derivedStatus = "completed";
    } else if (latestTurnIndicatesWaiting || runtimeStatus === "WAITING_USER") {
      derivedStatus = "waiting_on_user";
    } else if (normalizedString(run.status) === "waiting_on_user" || hasWaitingBlocker) {
      derivedStatus = "waiting_on_user";
    } else if (currentInputStatus === "CLAIMED" || runtimeStatus === "BUSY") {
      derivedStatus = "running";
    } else if (currentInputStatus === "QUEUED" || runtimeStatus === "QUEUED") {
      derivedStatus = "queued";
    }

    const summaryFromTurn = clippedSingleLineSummary(latestTurnResult?.assistantText);
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
        summary: updates.summary,
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
        summary: updates.summary,
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
        summary: updates.summary,
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
    const syncedState = {
      run: syncedRun,
      runtimeState,
      currentInput,
      latestInput,
      latestTurnResult,
    };
    this.syncLinkedIssueFromSubagentState(syncedState);
    return syncedState;
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
    toolId: string;
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

  // Async: installWorkspaceAuthoredCapability returns a promise. This was
  // declared sync and laundered the promise through `as unknown as JsonObject`,
  // so the type checker could not see it — any caller that did not happen to
  // await got a promise where it expected the install result.
  async installCapability(
    params: RuntimeAgentToolsInstallCapabilityParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const capabilityId = normalizedString(params.capabilityId);
    if (!capabilityId) {
      throw new RuntimeAgentToolsServiceError(400, "capability_id_required", "capabilityId is required");
    }
    const result = await installWorkspaceAuthoredCapability({
      store: this.store,
      workspaceId: params.workspaceId,
      workspaceDir: this.store.workspaceDir(params.workspaceId),
      capabilityId,
    });
    return result as unknown as JsonObject;
  }

  async connectMcpServer(params: {
    workspaceId: string;
    url?: string | null;
    command?: string[] | null;
    name?: string | null;
    headers?: Record<string, string> | null;
    env?: Record<string, string> | null;
    /** When set, the server is owned by this app container (written to
     *  `app_servers`), not the standalone pool. The desktop app-install attach
     *  sets it; the agent's own `mcp_connect` tool leaves it unset. */
    ownerAppId?: string | null;
  }): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const url = normalizedString(params.url);
    const command = Array.isArray(params.command)
      ? params.command.map((v) => String(v).trim()).filter((v) => v.length > 0)
      : [];
    if (url && command.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_connect_ambiguous",
        "Provide exactly one of `url` (remote) or `command` (local), not both.",
      );
    }
    if (!url && command.length === 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_connect_missing_target",
        "Provide a remote server `url` or a local `command`.",
      );
    }
    const transport: "remote" | "local" = url ? "remote" : "local";

    // Security (prompt-injection RCE): a LOCAL `command` MCP server spawns an
    // arbitrary process on the user's machine. The desktop's own catalog-driven
    // installs (e.g. drawio) always carry an `ownerAppId` (they are written to
    // `app_servers`), so they are user/desktop-initiated by construction. The
    // agent's own `mcp_connect` tool leaves `ownerAppId` UNSET — so an
    // ownerAppId-less local-command connect is agent-initiated and could be
    // driven by a prompt-injection payload. This env gate lets ops refuse
    // agent-initiated local-command spawns WITHOUT touching the desktop install
    // flow. It is FAIL-OPEN by default (unset → allowed) to preserve the
    // documented "user pastes an MCP command config, agent connects it" flow;
    // set SANDBOX_ALLOW_AGENT_LOCAL_MCP=0/false/no to harden.
    if (transport === "local" && !normalizedString(params.ownerAppId)) {
      const flag = (process.env.SANDBOX_ALLOW_AGENT_LOCAL_MCP ?? "").trim().toLowerCase();
      const agentLocalMcpDisabled = flag === "0" || flag === "false" || flag === "no";
      if (agentLocalMcpDisabled) {
        throw new RuntimeAgentToolsServiceError(
          403,
          "mcp_connect_local_command_disabled",
          "Connecting a local `command` MCP server is disabled for agent-initiated requests on this runtime. Use a remote `url` server, or install the local MCP through the desktop app.",
        );
      }
    }

    const baseServerId = deriveMcpServerId({
      name: normalizedString(params.name),
      url,
      command,
    });
    if (!baseServerId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_connect_bad_name",
        "Could not derive a valid server id; pass a `name` with letters/digits.",
      );
    }
    const headers = sanitizeStringMap(params.headers);
    const environment = sanitizeStringMap(params.env);
    const ownerAppId = normalizedString(params.ownerAppId);

    // Server ids derive from the URL host (or the given name), so two DIFFERENT
    // servers on the same host — or two explicit same-name connects — would
    // otherwise silently overwrite each other. For standalone (non-app) connects,
    // if the derived id is already taken by a DIFFERENT target, add a numeric
    // suffix so both coexist; the SAME target reuses the id (an idempotent
    // reconnect / config update in place). App-owned servers keep managing their
    // own ids (app lifecycle re-registers under a stable id on purpose).
    let serverId = baseServerId;
    let renamedFrom = "";
    if (!ownerAppId) {
      const existingServers = listWorkspaceMcpRegistryServers(
        this.store.workspaceDir(params.workspaceId),
      );
      const collision = existingServers.find((entry) => entry.id === baseServerId);
      if (collision && !sameMcpTarget(collision, transport, url, command)) {
        let suffix = 2;
        while (
          existingServers.some((entry) => entry.id === `${baseServerId}_${suffix}`)
        ) {
          suffix += 1;
        }
        serverId = `${baseServerId}_${suffix}`;
        renamedFrom = baseServerId;
      }
    }
    const renameNote = renamedFrom
      ? ` (a different MCP server is already registered as '${renamedFrom}', so this one was added as '${serverId}' to avoid overwriting it)`
      : "";

    // Probe a remote endpoint BEFORE writing config. Reachability is independent
    // of any saved token: server ids are derived from the URL HOST, so a token
    // (or config) from a prior CORRECT url (…/mcp/v1/) must not mask a NEW wrong
    // one (…/mcp/vl/) under the same id — and a URL that clearly isn't an MCP
    // endpoint must not overwrite a working server. Skip the probe only when a
    // static auth header is set (a bare probe would 401 uninformatively). The
    // saved token still suppresses the auth PROMPT (we don't re-ask when already
    // signed in — stale-token re-prompts happen at next-turn discovery).
    let probe: McpEndpointProbe | null = null;
    let hasToken = false;
    if (transport === "remote" && url) {
      const hasAuthHeader = headers
        ? Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
        : false;
      hasToken = Boolean(
        readMcpOAuthAccessToken(this.store.workspaceDir(params.workspaceId), serverId),
      );
      if (!hasAuthHeader) {
        probe = await probeMcpEndpoint(url);
      }
    }
    const statusHint = probe && probe.status > 0 ? ` (HTTP ${probe.status})` : "";

    // A definitive "not an MCP endpoint here" (404/405/410) means the URL is
    // wrong. Do NOT write config — refuse to clobber any existing server for this
    // id — and tell the agent nothing connected.
    const wrongUrl = Boolean(
      probe && (probe.status === 404 || probe.status === 405 || probe.status === 410),
    );
    if (wrongUrl) {
      return {
        server_id: serverId,
        transport,
        saved: false,
        reachable: false,
        auth_required: false,
        ...(url ? { url } : { command }),
        note: `The URL for '${serverId}' did NOT respond as an MCP endpoint${statusHint} — it is almost certainly wrong (a very common slip is the digit '1' vs the letter 'l', e.g. '/mcp/v1/' vs '/mcp/vl/'). Nothing was changed. Ask the user to confirm the exact endpoint URL and try again. Do NOT claim it connected.`,
      };
    }

    upsertWorkspaceMcpServerEntry(this.store.workspaceDir(params.workspaceId), {
      serverId,
      transport,
      ...(url ? { url } : {}),
      ...(command.length > 0 ? { command } : {}),
      ...(headers ? { headers } : {}),
      ...(environment ? { environment } : {}),
      ...(ownerAppId ? { ownerAppId } : {}),
    });
    // Persist whether this server needs OAuth so the per-turn harness can skip
    // discovering it while unauthorized (else it grinds the 401 for ~12s every
    // turn). Cleared when the probe says it's reachable without auth.
    writeMcpAuthRequiredMarker(
      this.store.workspaceDir(params.workspaceId),
      serverId,
      Boolean(probe && probe.authRequired),
    );

    // Show the Authorize card THIS turn when the server needs OAuth and we don't
    // already hold a token. Any 5xx / network failure (reachable:false but not a
    // definitive wrong-URL) is a soft "couldn't verify" — config is saved so a
    // retry works once the server is up.
    const authRequired = Boolean(probe && probe.authRequired && !hasToken);
    const softUnreachable = Boolean(probe && !probe.reachable);
    return {
      server_id: serverId,
      transport,
      saved: true,
      auth_required: authRequired,
      reachable: probe ? probe.reachable : true,
      ...(url ? { url } : { command }),
      ...(renamedFrom ? { renamed_from: renamedFrom } : {}),
      note: softUnreachable
        ? `MCP server '${serverId}' was saved, but the endpoint did not respond${statusHint} — it may be temporarily down or the URL may be wrong. Ask the user to verify the URL and try again; do NOT claim its tools are ready.${renameNote}`
        : authRequired
          ? `MCP server '${serverId}' connected, but it requires sign-in (OAuth) before ANY of its tools work. An "Authorize" button is now shown inline in the chat — ask the user to click it and complete the browser sign-in. After they authorize, its tools apply on the next message. Do NOT claim its tools are ready until then.${renameNote}`
          : transport === "remote"
            ? `MCP server '${serverId}' connected. Its tools become available on your NEXT turn — ask the user to send one more message, then call them. NOTE: if this remote server turns out to require sign-in (OAuth) an "Authorize" button appears inline in the chat (or use Settings → MCP). Do NOT claim its tools are ready until they actually appear.${renameNote}`
            : `MCP server '${serverId}' connected. Its tools become available on your NEXT turn — ask the user to send one more message, then call them.${renameNote}`,
      ...buildSessionRefreshFields([serverId]),
    };
  }

  /**
   * Force re-discovery of the tools exposed by the workspace's already-connected
   * MCP servers. The pi tool cache is a single per-workspace file keyed by a
   * hash of ALL server configs + tool refs, so this invalidates it wholesale;
   * every connected server is re-discovered on the next turn. No server target
   * arg (the cache isn't per-server). Ends the turn via requires_session_refresh
   * so the fresh tools apply from the next message — note that
   * buildSessionRefreshFields is for NEW servers (empty here) and returns {}, so
   * the flag is set directly.
   *
   * This ALSO drops the Composio inline tool listing. Composio integrations are
   * not MCP servers (composio-tool-registry removes any legacy entry), so they
   * are cached separately; clearing only the pi cache made this tool a no-op for
   * exactly the case an agent reaches for it — a just-connected integration whose
   * tools are missing. The agent would end the turn, the next turn would re-read
   * the same stale listing, and the loop repeated until the 15 min TTL expired.
   */
  refreshMcpTools(params: { workspaceId: string }): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const workspaceDir = this.store.workspaceDir(params.workspaceId);
    const cacheCleared = clearPiMcpToolCache(workspaceDir);
    const integrationsCleared = invalidateComposioInlineToolCache(this.store);
    const servers = [...readWorkspaceMcpRegistryServerNames(workspaceDir)];
    return {
      refreshed: true,
      cache_cleared: cacheCleared,
      // Counts cache FILES removed, which is 0 when nothing had been cached yet —
      // that is a no-op, not a failure. Named so the model doesn't read a 0 as
      // "the refresh didn't work" and tell the user so.
      integration_cache_files_removed: integrationsCleared,
      servers,
      note: "MCP tool cache and integration tool listing cleared for this workspace. Connected MCP servers and integrations are re-discovered on your NEXT turn — ask the user to send one more message.",
      requires_session_refresh: true,
      session_refresh_note:
        "The MCP tool and integration caches were invalidated; re-discovered tools apply from the next user message. End this turn now.",
    };
  }

  /**
   * Run the interactive OAuth flow for a user-connected REMOTE MCP server so a
   * token gets persisted for the per-turn harness to replay. This blocks on
   * human browser consent (out of any chat turn), so it's spawned as the
   * harness-host `authorize-mcp` subcommand. On success the pi MCP tool cache is
   * invalidated so the next turn re-discovers the server's tools with the token.
   */
  async authorizeMcpServer(params: {
    workspaceId: string;
    serverId: string;
    timeoutMs?: number;
    /** Re-auth / switch account: wipe the current token first, force fresh consent. */
    reauthorize?: boolean;
  }): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    const serverId = normalizedString(params.serverId);
    if (!serverId) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_authorize_missing_server",
        "server_id is required",
      );
    }
    const workspaceDir = this.store.workspaceDir(params.workspaceId);
    const server = listWorkspaceMcpRegistryServers(workspaceDir).find(
      (entry) => entry.id === serverId,
    );
    if (!server) {
      throw new RuntimeAgentToolsServiceError(
        404,
        "mcp_server_not_found",
        `MCP server '${serverId}' is not registered in this workspace.`,
      );
    }
    if (server.transport !== "remote" || !server.url) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_authorize_not_remote",
        `MCP server '${serverId}' is not a remote (URL) server; OAuth authorization applies only to remote servers.`,
      );
    }
    const result = await authorizeMcpServerViaHost({
      workspaceDir,
      serverId,
      url: server.url,
      timeoutMs: params.timeoutMs,
      reauthorize: params.reauthorize,
    });
    if (result.ok) {
      // Bust the tool cache so the next turn takes the cold path and re-discovers
      // this server's tools with the freshly-persisted bearer token.
      clearPiMcpToolCache(workspaceDir);
    }
    return {
      ok: result.ok,
      server_id: serverId,
      tool_count: result.tool_count,
      detail: result.detail,
      ...(result.ok
        ? {
            requires_session_refresh: true,
            session_refresh_note:
              "MCP server authorized; its tools apply from the next user message.",
          }
        : {}),
    };
  }

  /**
   * Surface an inline "Re-authorize" card for a connected remote MCP server so
   * the user can switch OAuth accounts. This does NOT run OAuth (that would block
   * the turn on the browser) — it only resolves the server the user meant and
   * returns the card trigger; the interactive flow runs when the user clicks the
   * card (→ authorizeMcpServer with reauthorize).
   */
  prepareMcpReauthorize(params: { workspaceId: string; server: string }): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const query = normalizedString(params.server);
    if (!query) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "mcp_reauthorize_missing_server",
        "server is required",
      );
    }
    const workspaceDir = this.store.workspaceDir(params.workspaceId);
    const servers = listWorkspaceMcpRegistryServers(workspaceDir).filter(
      (entry) => !entry.appManaged && entry.transport === "remote",
    );
    const lc = query.toLowerCase();
    let match = servers.find((entry) => entry.id.toLowerCase() === lc);
    if (!match) {
      const partial = servers.filter((entry) => entry.id.toLowerCase().includes(lc));
      if (partial.length === 1) {
        match = partial[0];
      }
    }
    if (!match) {
      const available = servers.map((entry) => entry.id);
      return {
        ok: false,
        server_query: query,
        available,
        detail: `No connected remote MCP server matches '${query}'. Connected remote servers: ${available.join(", ") || "(none)"}.`,
      };
    }
    return {
      ok: true,
      server_id: match.id,
      auth_required: true,
      reauthorize: true,
      note: `A "Re-authorize" button for '${match.id}' is now shown inline in the chat — tell the user to click it to open the browser and sign in with a different account. (To land on a DIFFERENT account they may need to sign out of the service in their browser first.) Nothing has changed yet.`,
    };
  }

  /**
   * Is a remote MCP server currently authorized (has a persisted OAuth token)?
   * Lets the inline Authorize card self-correct: a stale card from an earlier
   * session shows "Authorized" instead of a live Authorize button once the
   * server is connected. Token-exists is a good-enough proxy — an expired token
   * re-surfaces its own auth_required card on the next discovery.
   */
  isMcpServerAuthorized(params: { workspaceId: string; serverId: string }): JsonObject {
    this.requireWorkspace(params.workspaceId);
    const serverId = normalizedString(params.serverId);
    if (!serverId) {
      return { authorized: false, registered: false };
    }
    const workspaceDir = this.store.workspaceDir(params.workspaceId);
    // Also report whether the server still exists in this workspace — a card
    // from a session before the server was uninstalled must show "removed", not
    // an Authorize button that errors with "not registered".
    const registered = listWorkspaceMcpRegistryServers(workspaceDir).some(
      (entry) => entry.id === serverId,
    );
    const token = readMcpOAuthAccessToken(workspaceDir, serverId);
    return { authorized: Boolean(token), registered, server_id: serverId };
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
          smoke_tests_declared: resolvedRuntime.resolvedApp.smokeTests?.map((smokeTest) => ({
            name: smokeTest.name,
            kind: smokeTest.kind,
            path: smokeTest.path,
            timeout_s: smokeTest.timeoutS,
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_scaffold",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_register",
    });
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
    const providerEffectManifestViolations = findProviderEffectManifestViolations(
      appDir,
      parsed.integrations?.map((integration) => integration.provider) ?? [],
    );
    if (providerEffectManifestViolations.length > 0) {
      throw new RuntimeAgentToolsServiceError(
        400,
        "workspace_app_provider_effect_integration_missing",
        formatProviderEffectManifestLintError(providerEffectManifestViolations),
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_build",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_get_status",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_get_ports",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_ensure_running",
    });
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
    const smokeTests = await this.runWorkspaceAppSmokeTests({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      appIds: targetAppIds,
      workspaceDir,
      pendingIntegrations,
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
    // polish-only input as a fresh turn after the current one ends. If
    // the caller is the App Builder subagent itself, queue the follow-up
    // onto that same child session so the polish stays inside the same
    // build task. Otherwise fall back to the user-facing main session.
    // Idempotency is keyed by (target session, app) so repeat ensure-
    // running calls during the build do not re-trigger.
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
      const polishTarget = resolvePolishQueueTarget({
        store: this.store,
        workspaceId: params.workspaceId,
        callerSessionId: polishCallerSessionId,
      });
      for (const appId of targetAppIds) {
        if (!appIsDashboardShape(workspaceDir, appId)) continue;
        const existingSignatures = readWorkspaceSignatures(workspaceDir, appId);
        const idempotencyKey = `polish-pass:${polishTarget.sessionId}:${appId}`;
        try {
          const input = this.store.enqueueInput({
            workspaceId: params.workspaceId,
            sessionId: polishTarget.sessionId,
            idempotencyKey,
            payload: {
              text: buildPolishPassPrompt(appId, existingSignatures),
              image_urls: [],
              context: {
                source: "runtime_auto_queue",
                source_type: "post_build_polish_pass",
                app_id: appId,
                caller_session_id: polishCallerSessionId,
                ...(polishTarget.continueSubagentRun
                  ? { continue_subagent_run: true }
                  : {}),
              },
            },
          });
          polishPassQueued.push({
            app_id: appId,
            input_id: input.inputId,
            session_id: polishTarget.sessionId,
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
      ...(smokeTests.length > 0 ? { smoke_tests: smokeTests } : {}),
      ...buildSessionRefreshFields(newMcpServers),
      ...(pendingIntegrations.length > 0 ? { pending_integrations: pendingIntegrations } : {}),
      ...(polishPassQueued.length > 0
        ? { polish_pass_queued: polishPassQueued }
        : {}),
    };
  }

  /**
   * Polish-pass queueing for dashboard apps whose required integrations
   * have just become bound (typically called from integrations.ts's
   * onConnectionActive hook after a connection becomes active).
   *
   * Forensic context: ensureWorkspaceAppsRunning defers polish when
   * pending_integrations is non-empty (polish needs a real UI to
   * screenshot, not the integration_not_bound empty state). After the
   * user binds, nothing else explicitly re-evaluates polish — the
   * agent's session is idle by then and won't call ensure-running
   * again on its own. This method bridges the gap: iterate registered
   * dashboard apps in the workspace, and for each one whose pending
   * integrations are now empty, queue the polish input to the most
   * recently active main session.
   */
  queuePolishForCompletedBindings(workspaceId: string): JsonObject[] {
    let workspaceDir: string;
    try {
      this.requireWorkspace(workspaceId);
      workspaceDir = path.join(this.options.workspaceRoot, workspaceId);
    } catch {
      return [];
    }

    const sessionId = this.latestMainSessionId(workspaceId);
    if (!sessionId) return [];

    const apps = this.listRegisteredWorkspaceAppEntries(workspaceId)
      .map((entry) => (typeof entry.app_id === "string" ? entry.app_id : ""))
      .filter((appId) => appId.length > 0 && appIsDashboardShape(workspaceDir, appId));
    if (apps.length === 0) return [];

    const queued: JsonObject[] = [];
    for (const appId of apps) {
      const pending = pendingIntegrationsFromAppManifests({
        workspaceDir,
        appIds: [appId],
        store: this.store,
        workspaceId,
      });
      if (pending.length > 0) continue;

      const existingSignatures = readWorkspaceSignatures(workspaceDir, appId);
      const idempotencyKey = `polish-pass:${sessionId}:${appId}`;
      try {
        const input = this.store.enqueueInput({
          workspaceId,
          sessionId,
          idempotencyKey,
          payload: {
            text: buildPolishPassPrompt(appId, existingSignatures),
            image_urls: [],
            context: {
              source: "runtime_auto_queue",
              source_type: "post_binding_polish_pass",
              app_id: appId,
            },
          },
        });
        queued.push({ app_id: appId, input_id: input.inputId, session_id: sessionId });
      } catch {
        // best-effort
      }
    }
    return queued;
  }

  /** Return the most recently updated non-archived main session in the
   *  workspace, or null when no main session exists yet. */
  private latestMainSessionId(workspaceId: string): string | null {
    try {
      const sessions = this.store.listSessions({
        workspaceId,
        includeArchived: false,
        limit: 50,
      });
      const main = sessions.find((s) => s.kind === "main_session");
      return main?.sessionId ?? null;
    } catch {
      return null;
    }
  }

  private resolveIssueExecutionRouting(params: {
    workspace: WorkspaceRecord;
    issue: IssueRecord;
    explicitParentSessionId?: string | null;
    explicitOriginMainSessionId?: string | null;
    explicitOwnerMainSessionId?: string | null;
  }): {
    parentSessionId: string;
    originMainSessionId: string;
    ownerMainSessionId: string;
  } {
    const explicitOwnerMainSessionId =
      normalizedString(params.explicitOwnerMainSessionId) || null;
    const explicitOriginMainSessionId =
      normalizedString(params.explicitOriginMainSessionId) || null;
    const explicitParentSessionId =
      normalizedString(params.explicitParentSessionId) || null;
    const issueSession = this.store.getSession({
      workspaceId: params.workspace.id,
      sessionId: params.issue.sessionId,
    });
    const linkedRunId =
      normalizedString(params.issue.activeSubagentId) ||
      normalizedString(params.issue.latestSubagentId);
    const linkedRun = linkedRunId
      ? this.store.getSubagentRun({
          workspaceId: params.workspace.id,
          subagentId: linkedRunId,
        })
      : null;
    const sharedCoordinatorCandidates = [
      issueSession?.parentSessionId,
      linkedRun?.ownerMainSessionId,
      linkedRun?.originMainSessionId,
      linkedRun?.parentSessionId,
    ];
    const ownerMainSessionId =
      preferredCoordinatorSessionId({
        store: this.store,
        workspace: params.workspace,
        preferredSessionIds: [
          explicitOwnerMainSessionId,
          ...sharedCoordinatorCandidates,
        ],
      }) ??
      preferredCoordinatorSessionId({
        store: this.store,
        workspace: params.workspace,
        preferredSessionIds: [
          explicitOriginMainSessionId,
          explicitParentSessionId,
          ...sharedCoordinatorCandidates,
        ],
      }) ??
      explicitOwnerMainSessionId ??
      explicitOriginMainSessionId ??
      explicitParentSessionId ??
      params.issue.sessionId;
    const originMainSessionId =
      preferredCoordinatorSessionId({
        store: this.store,
        workspace: params.workspace,
        preferredSessionIds: [
          explicitOriginMainSessionId,
          ownerMainSessionId,
          ...sharedCoordinatorCandidates,
        ],
      }) ?? ownerMainSessionId;
    const parentSessionId =
      preferredCoordinatorSessionId({
        store: this.store,
        workspace: params.workspace,
        preferredSessionIds: [
          explicitParentSessionId,
          ownerMainSessionId,
          ...sharedCoordinatorCandidates,
        ],
      }) ?? ownerMainSessionId;
    return {
      parentSessionId,
      originMainSessionId,
      ownerMainSessionId,
    };
  }

  private resolveIssueRunSourceType(params: {
    workspaceId: string;
    issue: IssueRecord;
    explicitSourceType?: string | null;
  }): string {
    const explicitSourceType = normalizedString(params.explicitSourceType);
    if (explicitSourceType) {
      return explicitSourceType;
    }
    const issueSourceType = normalizedString(params.issue.sourceType);
    if (issueSourceType) {
      return issueSourceType;
    }
    const linkedRunId =
      normalizedString(params.issue.latestSubagentId) ||
      normalizedString(params.issue.activeSubagentId);
    if (!linkedRunId) {
      return "issue";
    }
    const linkedRun = this.store.getSubagentRun({
      workspaceId: params.workspaceId,
      subagentId: linkedRunId,
    });
    return normalizedString(linkedRun?.sourceType) || "issue";
  }

  private upsertIssueExecutionRun(params: {
    workspaceId: string;
    issue: IssueRecord;
    session: AgentSessionRecord;
    routing: {
      parentSessionId: string;
      originMainSessionId: string;
      ownerMainSessionId: string;
    };
    requestedModel: string | null;
    effectiveModel: string;
    toolProfile: Record<string, unknown>;
    sourceType: string;
    sourceId: string;
    parentInputId: string | null;
    runContext?: Record<string, unknown> | null;
    childSessionKind?: string | null;
  }): SubagentRunRecord {
    const goal = normalizedString(params.issue.description) || params.issue.title;
    const existingRunByChildSession = this.store.getSubagentRunByChildSession({
      workspaceId: params.workspaceId,
      childSessionId: params.session.sessionId,
    });
    const linkedRunId =
      normalizedString(params.issue.latestSubagentId) ||
      normalizedString(params.issue.activeSubagentId);
    const linkedRun = linkedRunId
      ? this.store.getSubagentRun({
          workspaceId: params.workspaceId,
          subagentId: linkedRunId,
        })
      : null;
    const existingRun = existingRunByChildSession ?? linkedRun;
    const serializedRunContext = params.runContext
      ? JSON.stringify(params.runContext)
      : null;
    if (!existingRun) {
      return this.store.createSubagentRun({
        workspaceId: params.workspaceId,
        parentSessionId: params.routing.parentSessionId,
        parentInputId: params.parentInputId,
        originMainSessionId: params.routing.originMainSessionId,
        ownerMainSessionId: params.routing.ownerMainSessionId,
        childSessionId: params.session.sessionId,
        childSessionKind: params.childSessionKind ?? null,
        title: params.issue.title,
        goal,
        context: serializedRunContext,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        issueId: params.issue.issueId,
        toolProfile: params.toolProfile,
        requestedModel: params.requestedModel,
        effectiveModel: params.effectiveModel,
        status: "queued",
      });
    }

    const runWithResolvedOwner =
      existingRun.ownerMainSessionId !== params.routing.ownerMainSessionId
        ? (this.store.transferSubagentOwnership({
            workspaceId: params.workspaceId,
            subagentId: existingRun.subagentId,
            ownerMainSessionId: params.routing.ownerMainSessionId,
          }) ?? existingRun)
        : existingRun;

    return (
      this.store.updateSubagentRun({
        workspaceId: params.workspaceId,
        subagentId: runWithResolvedOwner.subagentId,
        fields: {
          parentSessionId: params.routing.parentSessionId,
          parentInputId: params.parentInputId,
          originMainSessionId: params.routing.originMainSessionId,
          ownerMainSessionId: params.routing.ownerMainSessionId,
          childSessionId: params.session.sessionId,
          title: params.issue.title,
          goal,
          context: serializedRunContext,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          issueId: params.issue.issueId,
          toolProfile: params.toolProfile,
          requestedModel: params.requestedModel,
          effectiveModel: params.effectiveModel,
          status: "queued",
          summary: null,
          latestProgressPayload: null,
          blockingPayload: null,
          resultPayload: null,
          errorPayload: null,
          lastEventAt: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
        },
      }) ?? runWithResolvedOwner
    );
  }

  async restartWorkspaceApp(
    params: RuntimeAgentToolsRestartWorkspaceAppParams,
  ): Promise<JsonObject> {
    this.requireWorkspace(params.workspaceId);
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_restart",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_restart_and_wait_ready",
    });
    const appId = sanitizeWorkspaceAppId(params.appId);
    await this.restartWorkspaceApp({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      appId,
    });
    const waited = await this.waitUntilWorkspaceAppReady({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_wait_until_ready",
    });
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
    this.requireAppBuilderRuntimeToolSession({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "workspace_apps_probe_endpoints",
    });
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

}

function sqliteValueToJson(value: unknown): JsonValue {
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
    return value.map((entry) => sqliteValueToJson(entry));
  }
  if (typeof value === "object" && value !== null) {
    const objectValue: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      objectValue[key] = sqliteValueToJson(entry);
    }
    return objectValue;
  }
  return String(value);
}
