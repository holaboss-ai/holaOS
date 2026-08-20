import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createGrepTool,
  createLsTool,
  DefaultResourceLoader,
  loadSkillsFromDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadSkillsResult,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { APIError as OpenAIApiError } from "openai";
import { createCallResult, createRuntime, type Runtime as McporterRuntime, type ServerDefinition } from "mcporter";
import {
  piMcpServersForceRefresh,
  piMcpToolCacheKey,
  readPiMcpToolCache,
  writePiMcpToolCache,
} from "./pi-mcp-tool-cache.js";
import {
  type ActiveToolController,
  buildDeferredToolGateway,
  type DeferredToolTarget,
} from "./deferred-tool-gateway.js";
import { MODELS } from "../node_modules/@earendil-works/pi-ai/dist/models.generated.js";
import {
  DEFAULT_HARNESS_MAX_EXCERPT_LINES,
  DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
  buildHarnessDocumentAttachmentSection,
  buildHarnessAttachmentFallbackPromptLine,
  buildHarnessAttachmentPromptPath,
  detectHarnessInlineImageMimeType,
  inlineHarnessImageAttachment,
  isHarnessFolderAttachment,
} from "../../harnesses/src/attachment-content.js";
import {
  buildHarnessTodoResumeInstruction,
  applyHarnessTodoResumeInstruction,
  buildHarnessSkillMetadataByAlias,
  buildHarnessMcpServerBindings,
  buildHarnessMcpToolName,
  harnessMcpToolNameAliases,
  createHarnessWorkspaceBoundaryPolicy,
  blockActiveHarnessTodoTask,
  createHarnessSkillToolDefinition,
  createHarnessTodoToolDefinitions,
  discoverHarnessMcpTools,
  type HarnessDiscoveredMcpTool,
  mcpServerNeedsAuthWithoutToken,
  writeMcpAuthRequiredMarker,
  hasBlockedPersistedHarnessTodoState,
  normalizeHarnessMcpToolParametersSchema,
  normalizeHarnessModelId,
  noteHarnessWaitingForUserOnToolCompletion,
  resolveHarnessQuotedSkillSectionsFromWorkspace,
  resolveHarnessWorkspaceSkillDirs,
  requestedHarnessThinkingBudgets,
  requestedHarnessThinkingConfig,
  requestedHarnessThinkingLevel,
  loadHarnessWorkspaceSkills,
  resolveHarnessDesktopBrowserToolDefinitions,
  resolvePathWithinHarnessWorkspace,
  runtimeConfigModelCatalog,
  mergeHarnessModelCatalogs,
  resolveComposioInlineTools,
  resolveHarnessModelProfile,
  resolveHarnessRuntimeToolDefinitions,
  resolveHarnessRunStatus,
  summarizeHarnessQuestionPrompt,
  buildHarnessSkillInvocationEndPayload,
  buildHarnessSkillInvocationStartPayload,
  createHarnessSkillWideningState,
  wrapToolWithHarnessSkillWidening,
  workspaceBoundaryOverrideRequested as workspaceBoundaryOverrideRequestedFromHarness,
  type HarnessCatalogModelEntry,
  type HarnessInputAttachmentPayload,
  type HarnessMcpServerBinding,
  type HarnessPreparedMcpServerConfig,
  type HarnessRequestedThinkingLevel,
  type HarnessSkillMetadata,
  type HarnessSkillWideningState,
  type HarnessThinkingBudgetLevel,
  type HarnessThinkingLevel,
  type HarnessThinkingSelection,
  type HarnessWorkspaceBoundaryPolicy,
} from "../../harnesses/src/index.js";

import type {
  HarnessHostPiRequest,
  JsonObject,
  JsonValue,
  RunnerEventType,
  RunnerOutputEventPayload,
} from "./contracts.js";
import {
  applyHarnessGenAiUsageMetrics,
  harnessGenAiSpanAttributes,
  runGenAiSpan,
  type HarnessGenAiUsageMetrics,
} from "./harness-ai-monitoring.js";
import { createPiFindToolDefinition } from "./pi-find-tool.js";
import { createPiDocumentReadToolDefinitions } from "./pi-document-read-tool.js";
import { downscaleInlineImage } from "./image-downscale.js";
import { wrapToolWithImageCap } from "./tool-image-cap.js";
import { createPiSearchToolDefinition } from "./pi-search-tool.js";
import { consolidateRuntimeToolFamilies } from "./consolidate-tool-family.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";
import {
  type CapturedUpstreamError,
  extractDeepProviderMessage,
  installUpstreamErrorCapture,
  peekLatestUpstreamError,
} from "./upstream-error-capture.js";
import { resolvePiWebSearchToolDefinitions } from "./pi-web-search.js";
import {
  collectInvalidSchemaPropertyKeys,
  countUnionTypeSiblings,
  normalizeUnionTypeSiblings,
  sanitizeInvalidSchemaPropertyKeys,
} from "./tool-schema-validation.js";

function sanitizeToolSchemas<T extends { name: string; parameters: unknown }>(
  group: string,
  tools: T[],
): T[] {
  return tools.map((tool) => {
    let parameters = tool.parameters;

    const invalidKeys = collectInvalidSchemaPropertyKeys(parameters);
    if (invalidKeys.length > 0) {
      process.stderr.write(
        `pi.tools.schema event=tool_schema_sanitized outcome=sanitized group=${group} tool=${tool.name} invalid_keys=${invalidKeys.join(",")}\n`,
      );
      parameters = sanitizeInvalidSchemaPropertyKeys(parameters);
    }

    // A node with both a union (anyOf/oneOf) and a sibling `type` is valid JSON
    // Schema but breaks Moonshot/Kimi's flavored validator; normalize it so one
    // such tool can't 400 the whole request on those providers.
    const unionSiblings = countUnionTypeSiblings(parameters);
    if (unionSiblings > 0) {
      process.stderr.write(
        `pi.tools.schema event=tool_schema_union_type_normalized outcome=sanitized group=${group} tool=${tool.name} nodes=${unionSiblings}\n`,
      );
      parameters = normalizeUnionTypeSiblings(parameters);
    }

    if (parameters === tool.parameters) {
      return tool;
    }
    return { ...tool, parameters };
  });
}

export type PiMappedEvent = {
  event_type: RunnerEventType;
  payload: JsonObject;
};

export interface PiCompactionCommandResult {
  compacted: boolean;
  session_file: string;
  result?: JsonObject | null;
  reason?: string | null;
  diagnostics?: JsonObject | null;
  error?: JsonObject | null;
}

export type PiEventMapperState = {
  toolArgsByCallId: Map<string, JsonValue>;
  mcpToolMetadata: ReadonlyMap<string, PiMcpToolMetadata>;
  skillMetadataByAlias: ReadonlyMap<string, PiSkillMetadata>;
  terminalState: "completed" | "failed" | null;
  waitingForUser: boolean;
  /** A retryable OR context-overflow assistant error that pi will attempt
   *  to recover from (a transient retry scheduled via setTimeout, or inline
   *  auto-compaction). Held back from emission until pi confirms outcome
   *  (auto_retry_end success=false → promote; successful subsequent
   *  message_end → clear; sendUserMessage settling with it still pending →
   *  fallback promote). */
  pendingRetryableFailure: PendingRetryableFailure | null;
};

export type PendingRetryableFailure = {
  message: string;
  stopReason: string;
  provider: string | null;
  model: string | null;
  event: string;
};

export interface PiSessionHandle {
  session: AgentSession;
  sessionFile: string;
  mcpToolMetadata: Map<string, PiMcpToolMetadata>;
  skillMetadataByAlias: Map<string, PiSkillMetadata>;
  unavailableMcpServers?: PiMcpServerUnavailableInfo[];
  /** Toolkits whose inline Composio tools could not be resolved this turn. The
   *  MCP path has surfaced its unavailable servers for a while; this is the
   *  equivalent for integrations, which previously failed invisibly. */
  unavailableComposioToolkits?: Array<{ toolkit_slug: string; reason: string }>;
  /** Per-step durations of the (currently serial) session-setup awaits —
   *  mcp_connect, composio_inline, runtime_tools, browser_tools, web_search,
   *  resource_reload, create_agent_session. Surfaced in run_started so the TTFT
   *  dissection can attribute the harness_boot window. */
  setupTimingsMs?: Record<string, number>;
  dispose: () => Promise<void>;
}

export function runtimeToolSelectedModelForPiRequest(
  request: Pick<HarnessHostPiRequest, "selected_model" | "provider_id" | "model_id">,
): string {
  const selectedModel =
    typeof request.selected_model === "string" ? request.selected_model.trim() : "";
  return selectedModel.length > 0
    ? selectedModel
    : `${request.provider_id}/${request.model_id}`;
}

// The `mcp__<server>__<tool>` name aliases (see harnessMcpToolNameAliases) are a
// compat shim ONLY for models that mimic the Claude-Agent-SDK namespacing when
// they emit an MCP tool call while keeping the original (kebab) tool spelling —
// GLM / Zhipu (chatGLM) are the known offenders; without the alias their call
// comes back "Tool not found". EVERY other model (Claude, GPT/OpenAI, Gemini,
// DeepSeek, Qwen, Kimi, MiniMax, Doubao, …) calls MCP tools by the exact
// registered name, so registering the aliases just DOUBLES a kebab-named server's
// tool schemas in the list the model sees (e.g. AdsPower shows every tool twice,
// ~4k tokens each) — pure prompt bloat that floods the model and degrades tool
// selection. So the shim is opt-IN by model family, not a default-on safety net:
// only namespacing models get aliases; a new offender is one line here.
const MCP_NAMESPACING_MODEL = /(?:glm|zhipu|chatglm|z-ai|z\.ai|thudm)/i;

export function mcpToolNameAliasesNeededForModel(model: string): boolean {
  return MCP_NAMESPACING_MODEL.test(model);
}

export interface PiDeps {
  createSession: (request: HarnessHostPiRequest) => Promise<PiSessionHandle>;
  emitEvent?: (
    request: HarnessHostPiRequest,
    sequence: number,
    eventType: RunnerEventType,
    payload: JsonObject,
  ) => void;
}


type PiInternalCompactionSession = {
  _checkCompaction?: (assistantMessage: unknown, skipAbortedCheck?: boolean) => Promise<void>;
};

type PiCompactionDiagnosticsSession = {
  sessionManager?: {
    getBranch?: () => unknown[];
    getLeafId?: () => string | null;
  };
  settingsManager?: {
    getCompactionSettings?: () => unknown;
  };
  model?: {
    provider?: unknown;
    id?: unknown;
    contextWindow?: unknown;
  };
  getContextUsage?: () => unknown;
  subscribe?: (listener: (event: AgentSessionEvent) => void) => (() => void) | void;
};

type PiSnapshotPostRunCompactionSession = PiCompactionDiagnosticsSession &
  PiInternalCompactionSession & {
    agent?: {
      continue?: () => Promise<void>;
      hasQueuedMessages?: () => boolean;
    };
    messages?: unknown[];
  };

type PiPrepareCompactionResult = {
  firstKeptEntryId?: unknown;
  messagesToSummarize?: unknown;
  turnPrefixMessages?: unknown;
  isSplitTurn?: unknown;
  tokensBefore?: unknown;
  previousSummary?: unknown;
  settings?: unknown;
} | null;

type PiThinkingLevel =
  HarnessThinkingLevel;
type PiRequestedThinkingLevel = HarnessRequestedThinkingLevel;
type PiThinkingBudgetLevel = HarnessThinkingBudgetLevel;
type PiThinkingSelection = HarnessThinkingSelection;

const PI_AGENT_STATE_DIR = ".holaboss/pi-agent";
const PI_SESSION_DIR = ".holaboss/pi-sessions";
const PI_HARNESS_CLIENT_NAME = "holaboss-pi-harness";
const PI_HARNESS_CLIENT_VERSION = "0.1.0";
const PI_REQUEST_TOOL_NAME_ALIASES: Record<string, string[]> = {
  ls: ["list"],
};
// The host provides local implementations for these public tool names. If the
// runtime capability surface also returns them, OpenAI-compatible providers see
// duplicate function names and can reject the request before generation starts.
const PI_HOST_NATIVE_TOOL_NAMES = new Set([
  "skill",
  "todoread",
  "todowrite",
  "web_search",
]);
const PI_MCP_DISCOVERY_RETRY_INTERVAL_MS = 250;
const PI_FALLBACK_CONTEXT_WINDOW = 500_000;
const PI_FALLBACK_MAX_TOKENS = 128_000;
// Compaction fires once a session's real usage crosses this fraction of the model
// context window (threshold = contextWindow * ratio). 0.5 ⇒ ~500k on the 1M-window
// models we run (sonnet/opus/gemini), proportionally lower for smaller windows.
const PI_COMPACTION_USAGE_THRESHOLD_RATIO = 0.5;
const PI_WORKSPACE_SKILLS_RELATIVE_PATH = "skills";

const PI_MODEL_CATALOG = MODELS as Record<string, Record<string, HarnessCatalogModelEntry>>;
const PI_MCP_DISCOVERY_MAX_WAIT_MS = 10000;
// Ceiling for the initial mcporter `createRuntime` transport open. An installed
// app whose process is alive but whose MCP endpoint never responds (e.g. a
// dashboard-only app whose lifecycle reports healthy but never serves MCP)
// otherwise wedges the harness-host indefinitely between `run_claimed` and
// `run_started`. On timeout we treat every server as unavailable and let the
// run proceed without MCP rather than hang forever.
const PI_MCP_RUNTIME_OPEN_MAX_WAIT_MS = 15000;
// pi auto-retries a *retryable* model failure (connection error, 5xx, overload,
// rate limit — see `_isRetryableError` in pi's agent-session) with exponential
// backoff, then emits `auto_retry_end{success:false}` → we map that to
// `run_failed`. pi's defaults are 3 attempts at 2s/4s/8s, i.e. one request gets
// ~23s to recover. That is tuned for an interactive chat with a human waiting;
// an unattended scheduled run has usually already claimed external state (a
// holapool profile lease, a launched browser) by then, so dying on a
// twenty-second provider blip is expensive.
//
// pi computes `baseDelayMs * 2 ** (attempt - 1)` with NO ceiling, so raising the
// attempt count alone explodes the tail (10 attempts at the 2000ms default would
// sleep ~34min — longer than the 15min scheduled-run cadence). Dropping the base
// to 500ms keeps 10 attempts bounded at ~8.5min total (0.5s → 256s), while
// covering the first ~16s in 5 attempts instead of 3. The backoff sleep is
// abortable, so an interactive user can still cancel out of the long tail.
export const PI_AUTO_RETRY_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  baseDelayMs: 500,
} as const;
const require = createRequire(import.meta.url);
let cachedPrepareCompactionFnPromise:
  | Promise<((entries: unknown[], settings: unknown) => PiPrepareCompactionResult) | null>
  | null = null;

export interface PiMcpToolMetadata {
  piToolName: string;
  serverId: string;
  toolId: string;
  toolName: string;
}

export type PiSkillMetadata = HarnessSkillMetadata;
export type PiSkillWideningState = HarnessSkillWideningState;
export type PiWorkspaceBoundaryPolicy = HarnessWorkspaceBoundaryPolicy;

export type PiMcpServerBinding = {
  serverId: string;
  timeoutMs: number;
  definition: ServerDefinition;
};

export type PiMcpServerUnavailableInfo = {
  serverId: string;
  reason: string;
  missingToolIds: string[];
  /** The server rejected us for auth reasons — it needs an OAuth Authorize. */
  authRequired?: boolean;
};

export type PiMcpToolset = {
  runtime: McporterRuntime | null;
  customTools: ToolDefinition[];
  mcpToolMetadata: Map<string, PiMcpToolMetadata>;
  unavailableServers: PiMcpServerUnavailableInfo[];
};

export interface PiPromptPayload {
  text: string;
  images: ImageContent[];
}

type PiAttachment = HarnessInputAttachmentPayload;

/**
 * Resolve the agent's effective cwd for this request. Mirrors the
 * resolution in `defaultCreateSession` so request-time helpers (attachment
 * paths, image URL validation) use the same boundary root as the session
 * itself — otherwise an attachment that resolves under the project dir gets
 * rejected because the early policy was workspace-rooted while the agent
 * runs from the project, or vice versa.
 */
function resolveRequestAgentCwd(request: HarnessHostPiRequest): string {
  if (
    typeof request.agent_cwd === "string" &&
    request.agent_cwd.trim().length > 0
  ) {
    return request.agent_cwd.trim();
  }
  return request.workspace_dir;
}

/**
 * Boundary policy for request-time file lookups (attachments, file:// image
 * URLs, etc.). Roots the agent at `agent_cwd` and lists `workspace_dir` as
 * an allowed external dir when they differ, matching the session-time
 * policy built by `defaultCreateSession`. Without this match the early
 * helpers would reject paths the session itself would have accepted (and
 * vice versa).
 */
function createRequestAttachmentBoundaryPolicy(request: HarnessHostPiRequest) {
  const agentCwd = resolveRequestAgentCwd(request);
  const allowedExternalDirs =
    agentCwd === request.workspace_dir ? [] : [request.workspace_dir];
  return createWorkspaceBoundaryPolicy(agentCwd, false, allowedExternalDirs);
}

function resolveAttachmentAbsolutePath(request: HarnessHostPiRequest, attachment: PiAttachment): string {
  // Staged attachments (screenshots, dropped files, records) are written
  // relative to workspace_dir (under <workspace_dir>/.holaboss/input-attachments/),
  // whereas @-mention attachments may live under the agent cwd (the project
  // folder, or HOME for General chats). For a General session those roots
  // differ — workspace_dir is the sandbox dir, agent cwd is HOME — so resolving
  // the relative path against agent cwd alone misses staged attachments and
  // fails with ENOENT. Try each candidate root (workspace_dir first, since that
  // is where staging writes) and prefer the one that exists on disk.
  const agentCwd = resolveRequestAgentCwd(request);
  const roots = [...new Set([request.workspace_dir, agentCwd].filter(Boolean))];
  let firstResolved: string | null = null;
  for (const root of roots) {
    const policy = createWorkspaceBoundaryPolicy(
      root,
      false,
      roots.filter((other) => other !== root),
    );
    const resolved = resolvePathWithinHarnessWorkspace(
      policy,
      attachment.workspace_path,
    );
    if (!resolved) {
      continue;
    }
    if (firstResolved === null) {
      firstResolved = resolved;
    }
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  if (firstResolved !== null) {
    // Nothing on disk yet under either root — return the workspace_dir-rooted
    // resolution so the downstream read surfaces a real ENOENT, not a boundary
    // error.
    return firstResolved;
  }
  throw new Error(
    `Attachment '${attachment.name}' resolves outside workspace boundary: ${attachment.workspace_path}`,
  );
}

function runtimeContextMessagesBlock(request: HarnessHostPiRequest): string {
  const messages = Array.isArray(request.context_messages)
    ? request.context_messages.map((message) => message.trim()).filter(Boolean)
    : [];
  if (messages.length === 0) {
    return "";
  }
  return [
    "Runtime context:",
    ...messages.map((message, index) =>
      [`[Runtime Context ${index + 1}]`, message, `[/Runtime Context ${index + 1}]`].join("\n")
    ),
  ].join("\n\n");
}

function resumedSessionTurnInstruction(request: HarnessHostPiRequest): string {
  if (!resolveRequestedSessionFile(request)) {
    return "";
  }
  return [
    "Resumed session turn note:",
    "A persisted conversation already exists for this session.",
    "Treat the user's newest message as the primary instruction for this turn.",
    "Do not continue, apologize for, or revise the previous answer unless the user's newest message clearly asks for that continuation or correction.",
    "Use prior turns only as supporting context. If they conflict with the newest message, follow the newest message.",
    "When the newest message points to a report, attachment, repo, or other artifact, inspect that artifact directly instead of answering from prior-turn memory alone.",
  ].join("\n");
}

const IMAGE_URL_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_CHARS = 12_000;
const DEFAULT_HARNESS_MAX_TOTAL_INLINE_ATTACHMENT_TEXT_CHARS = 24_000;
const DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_LINES = DEFAULT_HARNESS_MAX_EXCERPT_LINES;
const IMAGE_MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function imageUrlPromptLabel(imageUrl: string, index: number, request: HarnessHostPiRequest): string {
  if (/^data:/i.test(imageUrl)) {
    return `[Image URL ${index + 1}] data URL`;
  }
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol === "file:") {
      const resolvedPath = resolvePathWithinHarnessWorkspace(
        createRequestAttachmentBoundaryPolicy(request),
        fileURLToPath(parsed),
      );
      if (resolvedPath) {
        // Display path is relative to the AGENT's cwd, not the workspace
        // metadata root: a file under the project should render as
        // `./poem.txt`, not `../../../Holaboss/Projects/test8/poem.txt`.
        const relativeRoot = resolveRequestAgentCwd(request);
        const relativePath = path
          .relative(relativeRoot, resolvedPath)
          .replace(/\\/g, "/");
        return `[Image URL ${index + 1}] ./${relativePath}`;
      }
    }
    return `[Image URL ${index + 1}] ${parsed.toString()}`;
  } catch {
    return `[Image URL ${index + 1}] ${imageUrl}`;
  }
}

function imageContentFromDataUrl(
  imageUrl: string,
  maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
): ImageContent | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(imageUrl);
  if (!match) {
    return null;
  }
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  try {
    const buffer = Buffer.from(match[2] ?? "", "base64");
    if (buffer.length === 0 || buffer.length > maxInlineImageBytes) {
      return null;
    }
    const detectedMimeType = detectHarnessInlineImageMimeType(buffer);
    if (!detectedMimeType) {
      return null;
    }
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType: detectedMimeType,
    };
  } catch {
    return null;
  }
}

function inlineWorkspaceImageUrl(
  request: HarnessHostPiRequest,
  imageUrl: string,
  maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
): ImageContent | null {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") {
    return null;
  }
  const absolutePath = resolvePathWithinHarnessWorkspace(
    createRequestAttachmentBoundaryPolicy(request),
    fileURLToPath(parsed),
  );
  if (!absolutePath) {
    return null;
  }
  const mimeType = IMAGE_MIME_TYPES_BY_EXTENSION.get(path.extname(absolutePath).toLowerCase()) ?? "";
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return null;
  }
  // Workspace_path on the attachment is for the agent's display; the agent
  // sees paths relative to its own cwd, not the workspace runtime dir.
  const relativePath = path
    .relative(resolveRequestAgentCwd(request), absolutePath)
    .replace(/\\/g, "/");
  return inlineHarnessImageAttachment({
    attachment: {
      id: absolutePath,
      kind: "image",
      name: path.basename(absolutePath),
      mime_type: mimeType,
      size_bytes: stat.size,
      workspace_path: relativePath,
    },
    absolutePath,
    maxInlineImageBytes,
  });
}

async function inlineRemoteImageUrl(
  imageUrl: string,
  maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
): Promise<ImageContent | null> {
  if (!/^https?:\/\//i.test(imageUrl) || typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_URL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!mimeType.startsWith("image/")) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxInlineImageBytes) {
      return null;
    }
    const detectedMimeType = detectHarnessInlineImageMimeType(bytes);
    if (!detectedMimeType) {
      return null;
    }
    return {
      type: "image",
      data: bytes.toString("base64"),
      mimeType: detectedMimeType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function inlineImageUrlInput(request: HarnessHostPiRequest, imageUrl: string): Promise<ImageContent | null> {
  return (
    imageContentFromDataUrl(imageUrl) ??
    inlineWorkspaceImageUrl(request, imageUrl) ??
    await inlineRemoteImageUrl(imageUrl)
  );
}

function piModelSupportsImageInputs(request: HarnessHostPiRequest): boolean {
  return resolvePiModelProfile(request).input.includes("image");
}

export async function buildPiPromptPayload(request: HarnessHostPiRequest): Promise<PiPromptPayload> {
  const sections: string[] = [];
  const imageLines: string[] = [];
  const folderLines: string[] = [];
  const fallbackLines: string[] = [];
  const imageUrlLines: string[] = [];
  const imageUrlFallbackLines: string[] = [];
  const images: ImageContent[] = [];
  const attachments = request.attachments ?? [];
  const imageUrls = request.image_urls ?? [];
  const canInlineImageInputs = piModelSupportsImageInputs(request);
  const documentAttachmentCount = attachments.filter((attachment) =>
    !isHarnessFolderAttachment(attachment) &&
    attachment.kind !== "image" &&
    !attachment.mime_type.startsWith("image/")
  ).length;
  let processedDocumentAttachments = 0;
  let remainingInlineAttachmentTextChars =
    DEFAULT_HARNESS_MAX_TOTAL_INLINE_ATTACHMENT_TEXT_CHARS;
  let omittedInlineImagesForCapability = false;
  const resumedSessionInstruction = resumedSessionTurnInstruction(request);
  const hasRequestedSessionFile = Boolean(resolveRequestedSessionFile(request));
  if (resumedSessionInstruction) {
    sections.push(resumedSessionInstruction);
  }

  const todoResumeInstruction = buildHarnessTodoResumeInstruction({
    hasRequestedSessionFile,
    stateDir: resolvePiStateDir(request.workspace_dir),
    sessionId: request.session_id,
  });
  if (todoResumeInstruction) {
    sections.push(todoResumeInstruction);
  }

  const quotedSkills = resolveQuotedSkillSections(request.instruction, resolvePiSkillDirs(request));
  if (quotedSkills.blocks.length > 0) {
    sections.push(["Quoted workspace skills:", ...quotedSkills.blocks].join("\n\n"));
  }
  if (quotedSkills.missing.length > 0) {
    sections.push(
      `Quoted workspace skills not found in this workspace: ${quotedSkills.missing.join(", ")}`
    );
  }

  const instruction = quotedSkills.body.trim();
  if (instruction) {
    sections.push(instruction);
  }

  const runtimeContextBlock = runtimeContextMessagesBlock(request);
  if (runtimeContextBlock) {
    sections.push(runtimeContextBlock);
  }

  for (const attachment of attachments) {
    const promptPath = buildHarnessAttachmentPromptPath(attachment);
    if (isHarnessFolderAttachment(attachment)) {
      folderLines.push(buildHarnessAttachmentFallbackPromptLine(attachment, promptPath));
      continue;
    }
    const absolutePath = resolveAttachmentAbsolutePath(request, attachment);
    if (attachment.kind === "image" || attachment.mime_type.startsWith("image/")) {
      if (canInlineImageInputs) {
        const image = inlineHarnessImageAttachment({
          attachment,
          absolutePath,
        });
        if (image) {
          images.push(image);
          imageLines.push(`- ${attachment.name} (${image.mimeType}) at ${promptPath}`);
          continue;
        }
      } else {
        omittedInlineImagesForCapability = true;
      }
      fallbackLines.push(buildHarnessAttachmentFallbackPromptLine(attachment, promptPath));
      continue;
    }

    if (!attachment.mime_type.startsWith("image/")) {
      const remainingDocumentAttachments =
        documentAttachmentCount - processedDocumentAttachments;
      const maxExtractedTextChars =
        remainingDocumentAttachments > 0
          ? Math.max(0, Math.min(
            DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_CHARS,
            Math.floor(
              remainingInlineAttachmentTextChars /
                remainingDocumentAttachments,
            ),
          ))
          : 0;
      processedDocumentAttachments += 1;
      const textSection = maxExtractedTextChars > 0
        ? await buildHarnessDocumentAttachmentSection({
          attachment,
          absolutePath,
          promptPath,
          maxExtractedTextChars,
          maxInlineTextBytes: DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_BYTES,
          maxExcerptLines: DEFAULT_HARNESS_MAX_INLINE_ATTACHMENT_TEXT_LINES,
        })
        : null;
      if (textSection) {
        sections.push(textSection.section);
        remainingInlineAttachmentTextChars = Math.max(
          0,
          remainingInlineAttachmentTextChars - textSection.extractedTextChars,
        );
        continue;
      }
    }

    fallbackLines.push(buildHarnessAttachmentFallbackPromptLine(attachment, promptPath));
  }

  for (const [index, imageUrl] of imageUrls.entries()) {
    const promptLabel = imageUrlPromptLabel(imageUrl, index, request);
    if (canInlineImageInputs) {
      const image = await inlineImageUrlInput(request, imageUrl);
      if (image) {
        images.push(image);
        imageUrlLines.push(`- ${promptLabel}`);
        continue;
      }
    } else {
      omittedInlineImagesForCapability = true;
    }
    imageUrlFallbackLines.push(`- ${promptLabel}`);
  }

  if (imageLines.length > 0) {
    sections.push(["Attached images:", ...imageLines].join("\n"));
  }
  if (imageUrlLines.length > 0) {
    sections.push(["Referenced image URLs:", ...imageUrlLines].join("\n"));
  }
  if (folderLines.length > 0) {
    sections.push(
      [
        "Attached folders:",
        ...folderLines,
        "Treat attached folders as scoped workspace context. Inspect relevant files inside them when needed; their contents are not inlined automatically.",
      ].join("\n")
    );
  }
  if (omittedInlineImagesForCapability) {
    sections.push(
      "Selected model only accepts text inputs for this run. Image attachments and image URLs are referenced as staged files or URLs instead of inline vision inputs."
    );
  }
  if (fallbackLines.length > 0) {
    sections.push(
      [
        "Other attachments are staged in the workspace and should be inspected from these paths:",
        ...fallbackLines,
      ].join("\n")
    );
  }
  if (imageUrlFallbackLines.length > 0) {
    sections.push(
      [
        "Image URLs not inlined as image inputs:",
        ...imageUrlFallbackLines,
      ].join("\n")
    );
  }

  const text = sections.join("\n\n").trim() || "Review the attached files.";
  return { text, images };
}

export async function promptTextForRequest(request: HarnessHostPiRequest): Promise<string> {
  return (await buildPiPromptPayload(request)).text;
}

export async function promptImagesForRequest(request: HarnessHostPiRequest): Promise<ImageContent[]> {
  return (await buildPiPromptPayload(request)).images;
}

export async function promptContentForRequest(request: HarnessHostPiRequest): Promise<Array<TextContent | ImageContent>> {
  const prompt = await buildPiPromptPayload(request);
  return [{ type: "text", text: prompt.text }, ...prompt.images];
}

function emitRunnerEvent(
  request: HarnessHostPiRequest,
  sequence: number,
  eventType: RunnerEventType,
  payload: JsonObject
): void {
  const event: RunnerOutputEventPayload = {
    session_id: request.session_id,
    input_id: request.input_id,
    sequence,
    event_type: eventType,
    payload,
  };
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOpenAiCompatErrorResponse(errorResponse: unknown): Object | undefined {
  if (isRecord(errorResponse)) {
    return errorResponse;
  }
  if (!Array.isArray(errorResponse)) {
    return undefined;
  }
  for (const item of errorResponse) {
    if (isRecord(item) && isRecord(item.error)) {
      return item;
    }
  }
  return undefined;
}

let openAiApiErrorGeneratePatched = false;

function patchOpenAiApiErrorGenerate(): void {
  if (openAiApiErrorGeneratePatched) {
    return;
  }
  const originalGenerate = OpenAIApiError.generate.bind(OpenAIApiError);
  OpenAIApiError.generate = ((status, errorResponse, message, headers) =>
    originalGenerate(status, normalizeOpenAiCompatErrorResponse(errorResponse), message, headers)) as typeof OpenAIApiError.generate;
  openAiApiErrorGeneratePatched = true;
}

patchOpenAiApiErrorGenerate();

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item));
  }
  if (value && typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      return String(value);
    }
  }
  return value === undefined ? null : String(value);
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumFiniteNumbers(...values: Array<number | null | undefined>): number | null {
  const present = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (present.length === 0) {
    return null;
  }
  return present.reduce((total, value) => total + value, 0);
}

function piUsageMetricsFromAssistantMessage(
  message: unknown,
): HarnessGenAiUsageMetrics | null {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) {
    return null;
  }
  const usage = message.usage;
  const uncachedInputTokens = finiteNumberOrNull(usage.input) ?? 0;
  const cachedInputTokens = finiteNumberOrNull(usage.cacheRead) ?? 0;
  const cacheWriteInputTokens = finiteNumberOrNull(usage.cacheWrite) ?? 0;
  const outputTokens = finiteNumberOrNull(usage.output) ?? 0;
  const inputCostUsd =
    isRecord(usage.cost) ? finiteNumberOrNull(usage.cost.input) : null;
  const outputCostUsd =
    isRecord(usage.cost) ? finiteNumberOrNull(usage.cost.output) : null;
  const totalCostUsd =
    (isRecord(usage.cost) ? finiteNumberOrNull(usage.cost.total) : null) ??
    sumFiniteNumbers(
      inputCostUsd,
      outputCostUsd,
      isRecord(usage.cost) ? finiteNumberOrNull(usage.cost.cacheRead) : null,
      isRecord(usage.cost) ? finiteNumberOrNull(usage.cost.cacheWrite) : null,
    );
  return {
    inputTokens: uncachedInputTokens + cachedInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens:
      finiteNumberOrNull(usage.totalTokens) ??
      uncachedInputTokens +
        cachedInputTokens +
        cacheWriteInputTokens +
        outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd,
  };
}

function mergeHarnessUsageMetrics(
  current: HarnessGenAiUsageMetrics | null,
  next: HarnessGenAiUsageMetrics | null,
): HarnessGenAiUsageMetrics | null {
  if (!next) {
    return current;
  }
  if (!current) {
    return { ...next };
  }
  return {
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cachedInputTokens:
      (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheWriteInputTokens:
      (current.cacheWriteInputTokens ?? 0) +
      (next.cacheWriteInputTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    inputCostUsd: sumFiniteNumbers(current.inputCostUsd, next.inputCostUsd),
    outputCostUsd: sumFiniteNumbers(
      current.outputCostUsd,
      next.outputCostUsd,
    ),
    totalCostUsd: sumFiniteNumbers(current.totalCostUsd, next.totalCostUsd),
  };
}

function tokenUsagePayloadFromHarnessUsage(
  usage: HarnessGenAiUsageMetrics | null,
): JsonObject | null {
  if (!usage) {
    return null;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens =
    usage.totalTokens ??
    inputTokens + cacheWriteInputTokens + outputTokens;
  const payload: Record<string, JsonValue> = {
    input_tokens: inputTokens,
    uncached_input_tokens: Math.max(0, inputTokens - cachedInputTokens),
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens,
    total_tokens: totalTokens,
  };
  if (usage.inputCostUsd !== null && usage.inputCostUsd !== undefined) {
    payload.cost_input_usd = usage.inputCostUsd;
  }
  if (usage.outputCostUsd !== null && usage.outputCostUsd !== undefined) {
    payload.cost_output_usd = usage.outputCostUsd;
  }
  if (usage.totalCostUsd !== null && usage.totalCostUsd !== undefined) {
    payload.estimated_cost_usd = usage.totalCostUsd;
  }
  return jsonObject(payload);
}

function requestDefaultHeaderValue(
  request: Pick<HarnessHostPiRequest, "model_client">,
  headerName: string,
): string | null {
  if (!isRecord(request.model_client.default_headers)) {
    return null;
  }
  const expected = headerName.trim().toLowerCase();
  for (const [key, value] of Object.entries(request.model_client.default_headers)) {
    if (key.trim().toLowerCase() === expected && typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || null;
    }
  }
  return null;
}

function summarizeCompactionBranchEntry(entry: unknown): JsonObject | null {
  if (!isRecord(entry)) {
    return null;
  }
  const message = isRecord(entry.message) ? entry.message : null;
  return {
    id: optionalTrimmedString(entry.id),
    parent_id: optionalTrimmedString(entry.parentId),
    type: optionalTrimmedString(entry.type),
    timestamp: optionalTrimmedString(entry.timestamp),
    role: optionalTrimmedString(message?.role),
    custom_type: optionalTrimmedString(entry.customType),
    first_kept_entry_id: optionalTrimmedString(entry.firstKeptEntryId),
  };
}

function latestCompactionBranchEntry(branch: unknown[]): Record<string, unknown> | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isRecord(entry) && entry.type === "compaction") {
      return entry;
    }
  }
  return null;
}

async function loadPrepareCompactionFn():
  Promise<((entries: unknown[], settings: unknown) => PiPrepareCompactionResult) | null> {
  if (cachedPrepareCompactionFnPromise) {
    return cachedPrepareCompactionFnPromise;
  }
  cachedPrepareCompactionFnPromise = (async () => {
    try {
      const packageEntry = require.resolve("@earendil-works/pi-coding-agent");
      const modulePath = path.join(
        path.dirname(packageEntry),
        "core",
        "compaction",
        "compaction.js",
      );
      const module = (await import(pathToFileURL(modulePath).href)) as {
        prepareCompaction?: (entries: unknown[], settings: unknown) => PiPrepareCompactionResult;
      };
      return typeof module.prepareCompaction === "function"
        ? module.prepareCompaction
        : null;
    } catch {
      return null;
    }
  })();
  return cachedPrepareCompactionFnPromise;
}

function summarizeCompactionPreparation(
  preparation: PiPrepareCompactionResult,
  branch: unknown[],
): JsonObject {
  if (!preparation || !isRecord(preparation)) {
    return {
      status: "none",
    };
  }
  const firstKeptEntryId = optionalTrimmedString(preparation.firstKeptEntryId);
  const firstKeptEntryIndex = firstKeptEntryId
    ? branch.findIndex(
        (entry) => isRecord(entry) && optionalTrimmedString(entry.id) === firstKeptEntryId,
      )
    : -1;
  const firstKeptEntry =
    firstKeptEntryIndex >= 0 ? summarizeCompactionBranchEntry(branch[firstKeptEntryIndex]) : null;
  const previousEntry =
    firstKeptEntryIndex > 0
      ? summarizeCompactionBranchEntry(branch[firstKeptEntryIndex - 1])
      : null;
  return {
    status: "ready",
    first_kept_entry_id: firstKeptEntryId,
    first_kept_entry_index: firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : null,
    first_kept_entry: firstKeptEntry,
    previous_entry: previousEntry,
    is_split_turn:
      typeof preparation.isSplitTurn === "boolean" ? preparation.isSplitTurn : null,
    tokens_before: finiteNumberOrNull(preparation.tokensBefore),
    messages_to_summarize_count: Array.isArray(preparation.messagesToSummarize)
      ? preparation.messagesToSummarize.length
      : null,
    turn_prefix_message_count: Array.isArray(preparation.turnPrefixMessages)
      ? preparation.turnPrefixMessages.length
      : null,
    previous_summary_length:
      typeof preparation.previousSummary === "string"
        ? preparation.previousSummary.length
        : null,
    settings: isRecord(preparation.settings)
      ? jsonObject(preparation.settings)
      : null,
  };
}

async function collectPiCompactionDiagnostics(
  session: PiCompactionDiagnosticsSession,
): Promise<JsonObject | null> {
  const branch = session.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) {
    return null;
  }
  const latestCompaction = latestCompactionBranchEntry(branch);
  const diagnostics: Record<string, unknown> = {
    branch_entry_count: branch.length,
    leaf_id: session.sessionManager?.getLeafId?.() ?? null,
    branch_tail: branch.slice(-6).map((entry) => summarizeCompactionBranchEntry(entry)),
    latest_compaction: latestCompaction
      ? {
          id: optionalTrimmedString(latestCompaction.id),
          first_kept_entry_id: optionalTrimmedString(latestCompaction.firstKeptEntryId),
          timestamp: optionalTrimmedString(latestCompaction.timestamp),
        }
      : null,
    model: session.model
      ? {
          provider: optionalTrimmedString(session.model.provider),
          id: optionalTrimmedString(session.model.id),
          context_window: finiteNumberOrNull(session.model.contextWindow),
        }
      : null,
    context_usage: jsonValue(session.getContextUsage?.() ?? null),
  };

  const settings = session.settingsManager?.getCompactionSettings?.();
  if (isRecord(settings)) {
    diagnostics.compaction_settings = jsonObject(settings);
  }

  const prepareCompaction = await loadPrepareCompactionFn();
  if (!prepareCompaction || !settings) {
    diagnostics.preparation = {
      status: prepareCompaction ? "unavailable_settings" : "unavailable_helper",
    };
    return jsonObject(diagnostics);
  }

  try {
    diagnostics.preparation = summarizeCompactionPreparation(
      prepareCompaction(branch, settings),
      branch,
    );
  } catch (error) {
    diagnostics.preparation = {
      status: "error",
      message: sdkErrorMessage(error, "Failed to compute compaction preparation"),
    };
  }
  return jsonObject(diagnostics);
}

function summarizeCompactionEventResult(value: unknown): JsonObject | null {
  if (!isRecord(value)) {
    return null;
  }
  const summary = optionalTrimmedString(value.summary);
  return {
    first_kept_entry_id: optionalTrimmedString(value.firstKeptEntryId),
    tokens_before: finiteNumberOrNull(value.tokensBefore),
    summary_length: summary ? summary.length : null,
    details: isRecord(value.details) ? jsonObject(value.details) : jsonValue(value.details),
  };
}

function summarizeCompactionEvent(event: AgentSessionEvent): JsonObject | null {
  if (event.type === "compaction_start") {
    return {
      type: "compaction_start",
      reason: optionalTrimmedString(event.reason),
    };
  }
  if (event.type === "compaction_end") {
    return {
      type: "compaction_end",
      reason: optionalTrimmedString(event.reason),
      aborted: typeof event.aborted === "boolean" ? event.aborted : null,
      will_retry: typeof event.willRetry === "boolean" ? event.willRetry : null,
      error_message: optionalTrimmedString(event.errorMessage),
      result: summarizeCompactionEventResult(event.result),
    };
  }
  return null;
}

function withCompactionEventDiagnostics(
  diagnostics: JsonObject | null,
  compactionStart: JsonObject | null,
  compactionEnd: JsonObject | null,
): JsonObject | null {
  if (!diagnostics && !compactionStart && !compactionEnd) {
    return null;
  }
  const next: Record<string, unknown> = diagnostics ? { ...diagnostics } : {};
  if (compactionStart) {
    next.compaction_start = compactionStart;
  }
  if (compactionEnd) {
    next.compaction_end = compactionEnd;
  }
  return jsonObject(next);
}

function summarizePiCompactionError(
  error: unknown,
  compactionEnd: JsonObject | null,
): JsonObject {
  const record = isRecord(error) ? error : null;
  return {
    name:
      (error instanceof Error && error.name.trim()) ||
      optionalTrimmedString(record?.name) ||
      "Error",
    message: sdkErrorMessage(error, "Pi compaction failed"),
    provider_message:
      extractProviderErrorMessage(record?.error ?? record?.body ?? record?.cause ?? error) ??
      sdkErrorMessage(error, "Pi compaction failed"),
    status_code:
      finiteNumberOrNull(record?.status) ?? finiteNumberOrNull(record?.statusCode),
    code:
      optionalTrimmedString(record?.code) ??
      optionalTrimmedString(record?.error && isRecord(record.error) ? record.error.code : null),
    type:
      optionalTrimmedString(record?.type) ??
      optionalTrimmedString(record?.error && isRecord(record.error) ? record.error.type : null),
    param:
      optionalTrimmedString(record?.param) ??
      optionalTrimmedString(record?.error && isRecord(record.error) ? record.error.param : null),
    request_id:
      optionalTrimmedString(record?.request_id) ??
      optionalTrimmedString(record?.requestId),
    headers: isRecord(record?.headers) ? jsonObject(stringRecord(record.headers)) : null,
    error: isRecord(record?.error) ? jsonObject(record.error) : jsonValue(record?.error),
    body: isRecord(record?.body) ? jsonObject(record.body) : jsonValue(record?.body),
    cause: isRecord(record?.cause) ? jsonObject(record.cause) : jsonValue(record?.cause),
    stack_preview:
      error instanceof Error && typeof error.stack === "string"
        ? error.stack.split("\n").slice(0, 8).join("\n")
        : null,
    compaction_end: compactionEnd,
  };
}

function latestCompactionId(session: PiCompactionDiagnosticsSession): string | null {
  const branch = session.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) {
    return null;
  }
  return optionalTrimmedString(latestCompactionBranchEntry(branch)?.id);
}

function compactionResultFromBranchEntry(entry: Record<string, unknown> | null): JsonObject | null {
  if (!entry) {
    return null;
  }
  const summary = optionalTrimmedString(entry.summary);
  const firstKeptEntryId = optionalTrimmedString(entry.firstKeptEntryId);
  const tokensBefore = finiteNumberOrNull(entry.tokensBefore);
  if (!summary || !firstKeptEntryId || tokensBefore === null) {
    return null;
  }
  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: isRecord(entry.details) ? jsonObject(entry.details) : jsonValue(entry.details),
  };
}

function findLastAssistantMessage(session: PiSnapshotPostRunCompactionSession): unknown | null {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      return message;
    }
  }
  return null;
}

function suppressSnapshotCompactionContinuation(session: PiSnapshotPostRunCompactionSession): void {
  if (!session.agent) {
    return;
  }
  session.agent.continue = async () => {};
  session.agent.hasQueuedMessages = () => false;
}

type SnapshotPostRunMaintenanceOutcome =
  | { kind: "unsupported" }
  | { kind: "compacted"; result: JsonObject }
  | { kind: "not_compacted"; reason: string | null }
  | { kind: "error"; error: unknown };

async function runSnapshotPostRunMaintenanceCompaction(
  session: PiSnapshotPostRunCompactionSession,
): Promise<SnapshotPostRunMaintenanceOutcome> {
  if (typeof session._checkCompaction !== "function") {
    return { kind: "unsupported" };
  }
  const lastAssistant = findLastAssistantMessage(session);
  if (!lastAssistant) {
    return { kind: "not_compacted", reason: "not_needed" };
  }
  const beforeCompactionId = latestCompactionId(session);
  suppressSnapshotCompactionContinuation(session);
  try {
    await session._checkCompaction.call(session, lastAssistant);
  } catch (error) {
    return { kind: "error", error };
  }
  const branch = session.sessionManager?.getBranch?.();
  const latestCompaction = Array.isArray(branch) ? latestCompactionBranchEntry(branch) : null;
  const afterCompactionId = optionalTrimmedString(latestCompaction?.id);
  if (!afterCompactionId || afterCompactionId === beforeCompactionId) {
    return { kind: "not_compacted", reason: "not_needed" };
  }
  const result = compactionResultFromBranchEntry(latestCompaction);
  if (!result) {
    return {
      kind: "error",
      error: new Error("Snapshot post-run compaction appended an invalid compaction entry"),
    };
  }
  return { kind: "compacted", result };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function sdkErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function resolvePiStateDir(workspaceDir: string): string {
  return path.join(workspaceDir, PI_AGENT_STATE_DIR);
}

function resolvePiSessionDir(workspaceDir: string): string {
  return path.join(workspaceDir, PI_SESSION_DIR);
}

function resolveWorkspaceLocalPiSkillDirs(workspaceDir: string): string[] {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  let workspaceRealPath: string;
  try {
    workspaceRealPath = fs.realpathSync(resolvedWorkspaceDir);
  } catch {
    return [];
  }
  const workspaceSkillsDir = path.join(resolvedWorkspaceDir, PI_WORKSPACE_SKILLS_RELATIVE_PATH);
  let workspaceSkillsRealPath: string;
  try {
    workspaceSkillsRealPath = fs.realpathSync(workspaceSkillsDir);
  } catch {
    return [];
  }
  const relativeSkillsPath = path.relative(workspaceRealPath, workspaceSkillsRealPath);
  if (relativeSkillsPath.startsWith("..") || path.isAbsolute(relativeSkillsPath)) {
    return [];
  }

  return fs
    .readdirSync(workspaceSkillsRealPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceSkillsRealPath, entry.name))
    .map((skillDir) => {
      try {
        return fs.realpathSync(skillDir);
      } catch {
        return null;
      }
    })
    .filter((skillDir): skillDir is string => Boolean(skillDir))
    .filter((skillDir) => {
      const relativeSkillDir = path.relative(workspaceRealPath, skillDir);
      if (relativeSkillDir.startsWith("..") || path.isAbsolute(relativeSkillDir)) {
        return false;
      }
      return fs.existsSync(path.join(skillDir, "SKILL.md"));
    })
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

export function resolvePiSkillDirs(request: HarnessHostPiRequest): string[] {
  return resolveHarnessWorkspaceSkillDirs([
    ...resolveWorkspaceLocalPiSkillDirs(request.workspace_dir),
    ...request.workspace_skill_dirs,
  ]);
}

/** One line per skill: `- name — description`. Descriptions are capped so one
 *  verbose SKILL.md cannot dominate the catalogue. */
const PI_SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 180;

/**
 * Compact replacement for pi's `<available_skills>` block.
 *
 * pi emits `<name>/<description>/<location>` per skill plus a preamble telling
 * the model to `read` the skill file. Measured on a real workspace that was
 * ~4,860 tokens for 41 skills, ~1,312 of it absolute SKILL.md paths. holaOS
 * loads skills BY NAME via its own `skill` tool — which supplies the base dir
 * when it renders the block — so the path is never needed, and pointing the
 * model at `read` competes with the tool it should actually use.
 *
 * Returns "" when there are no model-invocable skills, so nothing is appended.
 */
export function renderPiSkillCatalog(
  skills: ReadonlyArray<{ name: string; description?: string }>,
): string {
  const lines = skills
    .filter((skill) => skill.name)
    .map((skill) => {
      const description = (skill.description ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PI_SKILL_CATALOG_DESCRIPTION_MAX_CHARS);
      return description ? `- ${skill.name} — ${description}` : `- ${skill.name}`;
    });
  if (lines.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "Available skills (invoke with the `skill` tool by name — do not read the files directly):",
    ...lines,
  ].join("\n");
}

function loadPiSkills(skillDirs: readonly string[]): LoadSkillsResult {
  return loadHarnessWorkspaceSkills<Skill, ResourceDiagnostic>({
    skillDirs,
    loadSkillsFromDir: (dir) =>
      loadSkillsFromDir({
        dir,
        source: "holaboss",
      }),
  });
}

function resolveQuotedSkillSections(
  instruction: string,
  workspaceSkillDirs: string[]
): { blocks: string[]; missing: string[]; body: string } {
  return resolveHarnessQuotedSkillSectionsFromWorkspace<Skill, ResourceDiagnostic>({
    instruction,
    workspaceSkillDirs,
    loadSkillsFromDir: (dir) =>
      loadSkillsFromDir({
        dir,
        source: "holaboss",
      }),
  });
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Appended to the system prompt whenever the native browser tools are active, so
 * the model prefers them over a third-party browser-automation MCP (e.g. AdsPower)
 * for the user's built-in Browser Profiles. Tool-description steering alone loses
 * to a competing "browser" MCP on weaker models; a system-prompt rule ranks
 * higher. Scoped so DELIBERATE use of such an MCP (when the user names the
 * product) is still allowed. See docs/cdp/migration-to-real-chrome.md.
 */
const BROWSER_TOOL_PREFERENCE_INSTRUCTION = `

# Browser
The user's browsers are the built-in Browser Profiles, driven by the native browser_* tools (browser_list_profiles, browser_navigate, browser_open_tab, browser_use_profile, browser_launch_profile). When the user refers to "my"/"our"/"the" browser, asks to open or drive a browser, or names a browser by its name or number (e.g. "the asd browser", "profile #1"), you MUST use these browser_* tools — NEVER a third-party browser-automation MCP or tool (e.g. AdsPower, Multilogin, GoLogin, Dolphin, BitBrowser) for that. browser_navigate and browser_open_tab take an optional browser_profile (a name, a number like #1, or an id from browser_list_profiles). If the user names or clearly implies a specific browser, pass that one. If they do NOT specify a browser, omit browser_profile to drive the user's default browser (the one they pinned as default, shown as "— default" in browser_list_profiles) — EXCEPT when more than one profile exists AND the task depends on which logged-in identity is used (their email/calendar, an account's private data, posting/acting as someone): then call browser_list_profiles and either pick the profile whose name best fits the task, or ask the user which browser to use, rather than assuming the default. Only use a third-party browser MCP when the user explicitly names that product.`;

function effectiveSystemPromptForRequest(request: HarnessHostPiRequest): string {
  const base = applyHarnessTodoResumeInstruction(request.system_prompt, {
    hasRequestedSessionFile: Boolean(resolveRequestedSessionFile(request)),
    stateDir: resolvePiStateDir(request.workspace_dir),
    sessionId: request.session_id,
  });
  return request.browser_tools_enabled
    ? `${base}${BROWSER_TOOL_PREFERENCE_INSTRUCTION}`
    : base;
}

function summarizeQuestionPrompt(args: JsonValue | null, result: unknown): string | null {
  return summarizeHarnessQuestionPrompt(args, result);
}

export function createPiTodoToolDefinitions(params: {
  stateDir: string;
  sessionId: string;
  allowBlockedStatus?: boolean;
}): ToolDefinition[] {
  return createHarnessTodoToolDefinitions(params) as unknown as ToolDefinition[];
}

function resolvePathWithinWorkspace(
  policy: Pick<
    PiWorkspaceBoundaryPolicy,
    "workspaceDir" | "workspaceRealDir" | "allowedExternalDirs"
  >,
  candidate: string
): string | null {
  return resolvePathWithinHarnessWorkspace(policy, candidate);
}

export function workspaceBoundaryOverrideRequested(instruction: string): boolean {
  return workspaceBoundaryOverrideRequestedFromHarness(instruction);
}

function createWorkspaceBoundaryPolicy(
  workspaceDir: string,
  overrideRequested: boolean,
  allowedExternalDirs: readonly string[] = [],
): PiWorkspaceBoundaryPolicy {
  return createHarnessWorkspaceBoundaryPolicy(workspaceDir, overrideRequested, {
    allowedExternalDirs,
  });
}

function normalizeWorkspaceCommandId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function workspaceCommandIdsFromRunStartedPayload(payload: JsonObject): string[] {
  const raw = Array.isArray(payload.workspace_command_ids) ? payload.workspace_command_ids : [];
  return [...new Set(raw.map((commandId) => normalizeWorkspaceCommandId(commandId)).filter((commandId): commandId is string => Boolean(commandId)))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function createPiSkillWideningState(
  skillMetadataByAlias: ReadonlyMap<string, PiSkillMetadata>,
  availableToolNames: string[],
  availableCommandIds: string[]
): PiSkillWideningState {
  return createHarnessSkillWideningState(skillMetadataByAlias, availableToolNames, availableCommandIds);
}

function buildPiSkillMetadataByAlias(skills: Skill[]): Map<string, PiSkillMetadata> {
  return buildHarnessSkillMetadataByAlias(skills);
}

function replacePiSkillMetadataByAlias(
  target: Map<string, PiSkillMetadata>,
  source: ReadonlyMap<string, PiSkillMetadata>,
): void {
  target.clear();
  for (const [alias, metadata] of source.entries()) {
    target.set(alias, metadata);
  }
}

function replacePiStringSet(target: Set<string>, source: Iterable<string>): void {
  target.clear();
  for (const value of source) {
    target.add(value);
  }
}

function replacePiSkillIdMap(
  target: Map<string, ReadonlySet<string>>,
  source: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  target.clear();
  for (const [key, value] of source.entries()) {
    target.set(key, new Set(value));
  }
}

export function refreshPiSkillCatalog(params: {
  skillDirs: readonly string[];
  skillMetadataByAlias: Map<string, PiSkillMetadata>;
  skillWideningState: PiSkillWideningState;
  availableToolNames: string[];
  availableCommandIds: string[];
}): void {
  const loadedSkills = loadPiSkills(params.skillDirs);
  const nextSkillMetadataByAlias = buildPiSkillMetadataByAlias(loadedSkills.skills);
  replacePiSkillMetadataByAlias(params.skillMetadataByAlias, nextSkillMetadataByAlias);

  const nextSkillWideningState = createPiSkillWideningState(
    params.skillMetadataByAlias,
    params.availableToolNames,
    params.availableCommandIds,
  );
  const preservedGrantedTools = [...params.skillWideningState.grantedToolNames]
    .filter((toolName) => nextSkillWideningState.managedToolNames.has(toolName))
    .sort((left, right) => left.localeCompare(right));
  const preservedGrantedCommands = [...params.skillWideningState.grantedCommandIds]
    .filter((commandId) => nextSkillWideningState.managedCommandIds.has(commandId))
    .sort((left, right) => left.localeCompare(right));

  replacePiStringSet(
    params.skillWideningState.managedToolNames,
    nextSkillWideningState.managedToolNames,
  );
  replacePiStringSet(
    params.skillWideningState.grantedToolNames,
    preservedGrantedTools,
  );
  replacePiSkillIdMap(
    params.skillWideningState.skillIdsByManagedTool as Map<string, ReadonlySet<string>>,
    nextSkillWideningState.skillIdsByManagedTool,
  );
  replacePiStringSet(
    params.skillWideningState.managedCommandIds,
    nextSkillWideningState.managedCommandIds,
  );
  replacePiStringSet(
    params.skillWideningState.grantedCommandIds,
    preservedGrantedCommands,
  );
  replacePiSkillIdMap(
    params.skillWideningState.skillIdsByManagedCommand as Map<string, ReadonlySet<string>>,
    nextSkillWideningState.skillIdsByManagedCommand,
  );
}

export function createPiSkillToolDefinition(
  skillMetadataByAlias: Map<string, PiSkillMetadata>,
  skillWideningState: PiSkillWideningState,
  workspaceBoundaryOverrideRequested: boolean,
  options?: {
    refreshCatalog?: () => void | Promise<void>;
  }
): ToolDefinition {
  const baseTool = createHarnessSkillToolDefinition({
    skillMetadataByAlias,
    skillWideningState,
    workspaceBoundaryOverrideRequested,
  }) as unknown as ToolDefinition;
  if (!options?.refreshCatalog) {
    return baseTool;
  }
  return {
    ...baseTool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      await options.refreshCatalog?.();
      return await baseTool.execute(...args);
    },
  };
}

function wrapToolWithSkillWidening<TTool extends { name: string; execute: (...args: any[]) => Promise<any> }>(
  tool: TTool,
  state: PiSkillWideningState
): TTool {
  return wrapToolWithHarnessSkillWidening(tool, state);
}

const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50 * 1024; // 50KB — matches pi-coding-agent's read tool default.
// Under tmp/, NOT outputs/. Anything under outputs/ is a workspace artifact and
// surfaces as a card in the conversation — so a capped tool result showed up
// beside the answer as "composio_execute_tool-call_86….TXT", which is scratch
// space presented as a deliverable. It is still fully readable by the agent at
// the path named in the truncation notice; it just is not a result the user
// asked for.
const TOOL_OUTPUT_OVERFLOW_DIR = path.join("tmp", ".tool-results");
const SAFE_TOOL_NAME_PART_REGEXP = /[^a-zA-Z0-9._-]+/g;

// Once a run has already inlined this many bytes of tool output, the per-call
// cap tightens so further large results offload to disk instead of piling onto
// the context. Defends long browser/tool sessions against slow accumulation of
// many *sub*-cap results (e.g. 14× ~20KB page-text reads) that the per-call cap
// alone can't catch and that bloat the model context past what it works well
// with (a real session grew to ~194K tokens this way).
const DEFAULT_SESSION_TOOL_OUTPUT_BUDGET_BYTES = 256 * 1024; // 256KB inlined
const DEFAULT_TIGHTENED_TOOL_OUTPUT_BYTES = 12 * 1024; // per-call cap once over budget

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxToolOutputBytes(): number {
  return envBytes("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", DEFAULT_MAX_TOOL_OUTPUT_BYTES);
}

/**
 * Per-run accumulator of tool-output bytes actually inlined into the model
 * context. Shared across every tool wrapped in a single runPi so the cap can
 * tighten based on the *session's* accumulated tool output, not just one call.
 */
export interface ToolOutputCapState {
  inlinedBytes: number;
}

export function createToolOutputCapState(): ToolOutputCapState {
  return { inlinedBytes: 0 };
}

/**
 * Per-call output ceiling. Starts at the full per-call cap; once the run has
 * already inlined more than the session budget, it tightens so further large
 * results are offloaded (to tmp/.tool-results — fully retrievable via
 * `read`) rather than accumulated. Recent/early reads stay verbatim; nothing is
 * discarded, only relocated once the context is already carrying a lot.
 */
function effectiveMaxToolOutputBytes(state: ToolOutputCapState): number {
  const perCall = maxToolOutputBytes();
  const sessionBudget = envBytes(
    "HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES",
    DEFAULT_SESSION_TOOL_OUTPUT_BUDGET_BYTES,
  );
  if (state.inlinedBytes < sessionBudget) {
    return perCall;
  }
  const tightened = envBytes(
    "HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES",
    DEFAULT_TIGHTENED_TOOL_OUTPUT_BYTES,
  );
  return Math.min(perCall, tightened);
}

function measureToolContentBytes(result: unknown): number {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return 0;
  }
  let total = 0;
  for (const part of result.content) {
    if (isRecord(part) && typeof part.text === "string") {
      total += Buffer.byteLength(part.text, "utf8");
    }
  }
  return total;
}

const DEFAULT_SESSION_IMAGE_CONTEXT_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * Evict the oldest inline images from the live transcript once their cumulative
 * base64 size exceeds the budget. pi retains every screenshot and read-image at
 * full resolution for the life of the session, so a browser-heavy run accumulates
 * 100MB+ of base64 image data. That pushes the provider request past its hard
 * ~30MB request-size ceiling (413 request_too_large) — and, worse, makes
 * auto-compaction fail too, because the summary request carries the same
 * oversized history (compaction cannot compress a payload it cannot transmit). We
 * keep the most RECENT images (the ones the current turn is most likely to need)
 * and swap older ones for a short text placeholder so every request stays
 * sendable. Reads and writes go through the supported `session.state.messages`
 * accessor; the swap is idempotent, so it can run before every turn cheaply.
 * Returns the number of images elided (0 = nothing changed).
 */
export function capSessionImageContext(
  session: unknown,
  budgetBytes: number = envBytes(
    "HOLABOSS_SESSION_IMAGE_CONTEXT_BUDGET_BYTES",
    DEFAULT_SESSION_IMAGE_CONTEXT_BUDGET_BYTES,
  ),
): number {
  const state = isRecord(session) ? (session as { state?: unknown }).state : undefined;
  if (!isRecord(state)) {
    return 0;
  }
  let messages: unknown;
  try {
    messages = (state as { messages?: unknown }).messages;
  } catch {
    return 0;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }
  let cumulativeBytes = 0;
  let elided = 0;
  // Walk newest -> oldest so the freshest images fill the budget first and
  // survive; the images swapped out are always the older ones.
  const next = messages.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      continue;
    }
    let changed = false;
    const newContent = content.map((block) => {
      if (
        !isRecord(block) ||
        block.type !== "image" ||
        typeof block.data !== "string"
      ) {
        return block;
      }
      const bytes = block.data.length;
      if (cumulativeBytes + bytes <= budgetBytes) {
        cumulativeBytes += bytes;
        return block;
      }
      changed = true;
      elided += 1;
      const placeholder: TextContent = {
        type: "text",
        text: `[image omitted — ~${Math.round(bytes / 1024)}KB elided to keep the conversation within the model's request-size limit]`,
      };
      return placeholder;
    });
    if (changed) {
      next[i] = { ...(message as Record<string, unknown>), content: newContent };
    }
  }
  if (elided > 0) {
    try {
      (state as { messages: unknown }).messages = next;
    } catch {
      return 0;
    }
  }
  return elided;
}

function safeToolFilenamePart(value: string): string {
  return value.replace(SAFE_TOOL_NAME_PART_REGEXP, "_").slice(0, 80) || "tool";
}

function writeToolOverflowFile(params: {
  /**
   * Root dir under which `tmp/.tool-results/<file>.json` is written.
   * Must be the agent's cwd, NOT the workspace runtime dir — the stub the
   * agent sees in its tool output is a `./tmp/.tool-results/<file>`
   * relative path, and the agent resolves it from its cwd. Writing to
   * workspace_dir would mean project-bound agents see a stub path that
   * doesn't exist from their actual cwd.
   */
  rootDir: string;
  toolName: string;
  toolCallId: string;
  result: unknown;
}): { relativePath: string; absolutePath: string } | null {
  try {
    const overflowDir = path.join(params.rootDir, TOOL_OUTPUT_OVERFLOW_DIR);
    fs.mkdirSync(overflowDir, { recursive: true });
    const safeTool = safeToolFilenamePart(params.toolName);
    const safeCallId = safeToolFilenamePart(params.toolCallId || `unknown-${Date.now()}`);
    // Write the tool's TEXT payload verbatim when there is one, rather than the
    // `{content:[{text}],details:{}}` envelope. A real turn lost four `bash`
    // round-trips to python-parsing that envelope just to find where the payload
    // lived; a plain .txt is directly usable by `read` with offset/limit.
    const payloadText = toolResultText(params.result);
    const filename = payloadText
      ? `${safeTool}-${safeCallId}.txt`
      : `${safeTool}-${safeCallId}.json`;
    const absolutePath = path.join(overflowDir, filename);
    fs.writeFileSync(
      absolutePath,
      payloadText ?? JSON.stringify(params.result, null, 2),
    );
    return {
      relativePath: path.join(TOOL_OUTPUT_OVERFLOW_DIR, filename),
      absolutePath,
    };
  } catch {
    return null;
  }
}

/** Concatenated text payload of a tool result, or null when it carries none. */
function toolResultText(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  const parts: string[] = [];
  for (const part of result.content) {
    if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
/**
 * Downscale any inline images a tool returns BEFORE they enter the model context.
 * Screenshots (browser tools) and read-in images (document-read) arrive at full
 * resolution — a handful in a single turn pushes the request past the provider's
 * ~30MB size ceiling (413 request_too_large) mid-loop, which no end-of-turn
 * pruning can prevent. Running at the tool-result source protects the within-turn
 * LLM calls too, and unlike eviction it keeps the image usable (just smaller), so
 * it is safe to apply to the current turn's own screenshots. Best-effort per
 * image: a decode/encode failure leaves that image untouched.
 */
export function wrapToolWithImageDownscale<
  TTool extends { name: string; execute: (...args: any[]) => Promise<any> },
>(tool: TTool): TTool {
  const originalExecute = tool.execute.bind(tool);
  const wrapped: TTool = {
    ...tool,
    execute: (async (...args: any[]) => {
      const result = await originalExecute(...args);
      if (!isRecord(result) || !Array.isArray(result.content)) {
        return result;
      }
      let changed = false;
      const content = await Promise.all(
        result.content.map(async (block: unknown) => {
          if (
            !isRecord(block) ||
            block.type !== "image" ||
            typeof block.data !== "string"
          ) {
            return block;
          }
          const downscaled = await downscaleInlineImage(block.data);
          if (!downscaled) {
            return block;
          }
          changed = true;
          return { ...block, data: downscaled.data, mimeType: downscaled.mimeType };
        }),
      );
      if (!changed) {
        return result;
      }
      return { ...result, content };
    }) as TTool["execute"],
  };
  return wrapped;
}

/**
 * Cap any single tool result that exceeds maxToolOutputBytes(). The full result
 * is written to tmp/.tool-results/<tool>-<call_id>.json (relative to the
 * workspace) and the inline content is replaced with a short stub pointing the
 * agent at that file. Defends the conversation context against any tool —
 * including third-party MCP integrations — that returns unexpectedly large
 * payloads (e.g. Gmail fetch_emails with include_payload=true was observed
 * returning 1.3MB per call).
 */
export function wrapToolWithOutputCap<TTool extends { name: string; execute: (...args: any[]) => Promise<any> }>(
  tool: TTool,
  /**
   * The agent's cwd. Overflow files are written under this root so the
   * relative-path stub the agent sees in its tool output resolves from its
   * own pwd. Was `workspaceDir` — that worked only when agent_cwd ==
   * workspace_dir; project-bound and HOME-rooted General agents would see a
   * stub path that resolved nowhere.
   */
  rootDir: string,
  /**
   * Shared per-run accumulator. Pass one instance to every tool wrapped in a
   * runPi so the cap tightens on the session's total inlined tool output. When
   * omitted, each wrapper accumulates independently (the per-call cap still
   * applies) — used by tests and any single-tool caller.
   */
  capState: ToolOutputCapState = createToolOutputCapState(),
): TTool {
  const originalExecute = tool.execute.bind(tool);
  const wrapped: TTool = {
    ...tool,
    execute: (async (...args: any[]) => {
      const result = await originalExecute(...args);
      const maxBytes = effectiveMaxToolOutputBytes(capState);
      const measured = measureToolContentBytes(result);
      if (measured <= maxBytes) {
        // Count only what actually enters the context; offloaded results below
        // don't add to the running total (they live on disk, not in context).
        capState.inlinedBytes += measured;
        return result;
      }
      const toolCallId = typeof args[0] === "string" ? args[0] : "";
      const written = writeToolOverflowFile({
        rootDir,
        toolName: tool.name,
        toolCallId,
        result,
      });
      const sizeLabel = `${(measured / 1024).toFixed(1)}KB`;
      const capLabel = `${(maxBytes / 1024).toFixed(0)}KB`;
      // Hand back the HEAD of the payload, not just a pointer. Returning only a
      // file path forces the agent to open the file blind and rediscover its
      // shape — a real turn burned four `bash` calls doing exactly that before it
      // could answer. For list-shaped results the head usually answers the
      // question outright, and when it doesn't the agent now knows the format and
      // can `read` with a targeted offset.
      const preview = toolResultText(result);
      const previewBudget = Math.max(1024, Math.min(8 * 1024, Math.floor(maxBytes / 4)));
      const head = preview ? preview.slice(0, previewBudget) : null;
      const headNote =
        head && preview
          ? `\n\n--- first ${(Buffer.byteLength(head, "utf8") / 1024).toFixed(1)}KB of ${sizeLabel} ---\n${head}\n--- end of preview ---`
          : "";
      const text = written
        ? `[Tool output truncated: ${sizeLabel} exceeded the ${capLabel} per-call cap. The full result is saved verbatim at ${written.relativePath} — \`read\` it (with offset/limit) only if the preview below is not enough.]${headNote}`
        : `[Tool output truncated: ${sizeLabel} exceeded the ${capLabel} per-call cap. Full result could not be persisted — adjust tool arguments (e.g. lower limits, narrower filters) and retry.]${headNote}`;
      // The preview DOES enter the context, so it counts against the run budget.
      capState.inlinedBytes += Buffer.byteLength(text, "utf8");
      return {
        content: [{ type: "text", text }],
      };
    }) as TTool["execute"],
  };
  return wrapped;
}

// Git-for-Windows bash (what pi's `bash` tool spawns on Windows) receives its
// command as a single `bash -c "<command>"` argv string, which Windows silently
// truncates at ~8191 chars — and the tool still exits 0, corrupting the result.
// A real session lost the tail of an ~11KB heredoc writing a report (the closing
// `EOF` was chopped off → "here-document delimited by end-of-file"), then thrashed
// for minutes as every retry (python heredoc, `node -e`, `python -c`) hit the same
// wall with a different downstream symptom. Threshold chosen well below 8191 to
// leave room for the `bash.exe -c ` prefix and Node's argv quote-escaping, which
// both inflate the effective command line.
const DEFAULT_WINDOWS_BASH_INLINE_LIMIT_BYTES = 6 * 1024;

function windowsBashInlineLimitBytes(): number {
  return envBytes(
    "HOLABOSS_WINDOWS_BASH_INLINE_LIMIT_BYTES",
    DEFAULT_WINDOWS_BASH_INLINE_LIMIT_BYTES,
  );
}

/**
 * Embed a Windows path as a single-quoted token in a bash command string: bash
 * treats backslashes as escapes, so use forward slashes (Git bash accepts
 * `C:/…`). Temp names are random hex, so no embedded single quote can occur.
 */
function bashRunScriptCommand(scriptPath: string): string {
  return `bash '${scriptPath.replace(/\\/g, "/")}'`;
}

/**
 * Guard pi's `bash` tool against the Windows argv-length truncation above. When
 * a command exceeds the inline limit, write it to a temp `.sh` and run
 * `bash <file>` instead — the script is read from disk, so no argv limit applies
 * and heredocs/quotes execute verbatim. Never truncates silently: if the temp
 * script can't be written, it returns a clear error telling the model to split
 * the command or use the `write` tool. A no-op off Windows and for non-bash
 * tools, so it is safe to map over every base tool.
 *
 * Ordered INNERMOST (closest to the real tool) at the call site so skill-widening
 * and output-cap layers still observe the original command; only the actual spawn
 * sees the `bash <file>` rewrite.
 */
export function wrapBashToolForWindowsCommandLimit<
  TTool extends { name: string; execute: (...args: any[]) => Promise<any> },
>(tool: TTool, platform: NodeJS.Platform = process.platform): TTool {
  if (platform !== "win32" || tool.name !== "bash") {
    return tool;
  }
  const originalExecute = tool.execute.bind(tool);
  const wrapped: TTool = {
    ...tool,
    // Signature mirrors the SDK bash tool: (toolCallId, { command, timeout }, signal, onUpdate, ctx).
    execute: (async (...args: any[]) => {
      const params = args[1];
      const command =
        isRecord(params) && typeof params["command"] === "string"
          ? (params["command"] as string)
          : null;
      const limit = windowsBashInlineLimitBytes();
      if (command === null || command.length <= limit) {
        return originalExecute(...args);
      }
      let scriptPath: string;
      try {
        const dir = path.join(os.tmpdir(), "holaboss-bash");
        fs.mkdirSync(dir, { recursive: true });
        scriptPath = path.join(dir, `cmd-${randomBytes(8).toString("hex")}.sh`);
        // LF only: Git bash reads the file directly, and a stray \r on a heredoc
        // delimiter would re-break termination.
        fs.writeFileSync(scriptPath, command.replace(/\r\n/g, "\n"), "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const sizeKb = (command.length / 1024).toFixed(1);
        const limitKb = (limit / 1024).toFixed(0);
        return {
          content: [
            {
              type: "text",
              text: `[bash: command is ${sizeKb}KB, over the ${limitKb}KB limit that Git bash silently truncates on Windows. The temp-script fallback could not be written (${reason}). Split the command into smaller steps, or write file content with the \`write\` tool instead of a shell heredoc.]`,
            },
          ],
        };
      }
      const rewritten = [...args];
      rewritten[1] = { ...(params as Record<string, unknown>), command: bashRunScriptCommand(scriptPath) };
      try {
        return await originalExecute(...rewritten);
      } finally {
        try {
          fs.rmSync(scriptPath, { force: true });
        } catch {
          // Best-effort cleanup; a leftover temp script is harmless.
        }
      }
    }) as TTool["execute"],
  };
  return wrapped;
}

// Per-call wall-clock ceiling for the `bash` tool. A shell command that runs
// longer than this is almost always a runaway (a real session hung ~12 min on a
// whole-disk `find /`) — and because a tool call that never returns never yields
// a turn checkpoint, an unbounded command freezes the ENTIRE session until the
// run's hard timeout (hours), and a user pause can't even land. 10 min is well
// clear of normal shell work while still bounding a hang. The model can also
// pass the SDK bash tool's own `timeout`; this is the backstop when it doesn't.
const DEFAULT_BASH_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

// Parse an env var as a non-negative number of SECONDS → milliseconds. Unlike
// envBytes, 0 is a valid, meaningful value here (0 = disabled / unbounded).
function envSecondsAsMs(name: string, fallbackMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallbackMs;
  }
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

// Resolve the per-call timeout (ms) for a tool. `bash` is bounded by default;
// every other tool is opt-in (0 = off) so a legitimately long tool — video
// generation, a large download, a browser wait — isn't cut off unless an
// operator sets a global backstop. 0 means "no timeout".
export function toolCallTimeoutMs(toolName: string): number {
  if (toolName === "bash") {
    return envSecondsAsMs("HOLABOSS_BASH_TOOL_TIMEOUT_S", DEFAULT_BASH_TOOL_TIMEOUT_MS);
  }
  return envSecondsAsMs("HOLABOSS_TOOL_CALL_TIMEOUT_S", 0);
}

const TOOL_TIMEOUT_SENTINEL = Symbol("tool-call-timeout");

/**
 * Bound a single tool call's wall-clock time. `resolveTimeoutMs(toolName)`
 * returns the per-tool budget in ms (0 => unbounded, wrapper is a passthrough).
 *
 * On expiry the wrapper:
 *   1. aborts a controller whose signal is handed to the tool IN PLACE OF the
 *      incoming one, so a signal-aware tool (e.g. the SDK bash tool) tears down
 *      its subprocess; and
 *   2. resolves the call with a clear timeout error via Promise.race — so the
 *      turn advances even if the tool ignores the abort. That turns "session
 *      frozen for hours on one runaway command" into "the command times out and
 *      the model moves on" (and a pending pause can then land).
 *
 * The incoming signal (turn abort / user pause) is chained into the same
 * controller, so an external abort still reaches the tool.
 *
 * Ordered OUTERMOST at the call site so the whole tool-call chain (skill
 * widening, output cap, the real spawn) is under the one deadline.
 */
export function wrapToolWithTimeout<
  TTool extends { name: string; execute: (...args: any[]) => Promise<any> },
>(
  tool: TTool,
  resolveTimeoutMs: (toolName: string) => number = toolCallTimeoutMs,
): TTool {
  const originalExecute = tool.execute.bind(tool);
  const wrapped: TTool = {
    ...tool,
    // Signature mirrors the SDK tool: (toolCallId, params, signal, onUpdate, ctx).
    execute: (async (...args: any[]) => {
      const timeoutMs = resolveTimeoutMs(tool.name);
      if (!(timeoutMs > 0)) {
        return originalExecute(...args);
      }
      const incomingSignal =
        args[2] instanceof AbortSignal ? (args[2] as AbortSignal) : undefined;
      const controller = new AbortController();
      const linkIncomingAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(incomingSignal?.reason ?? "aborted");
        }
      };
      if (incomingSignal?.aborted) {
        linkIncomingAbort();
      } else {
        incomingSignal?.addEventListener("abort", linkIncomingAbort, { once: true });
      }
      const forwardedArgs = [...args];
      forwardedArgs[2] = controller.signal;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof TOOL_TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => {
          if (!controller.signal.aborted) {
            controller.abort(
              `tool '${tool.name}' timed out after ${Math.round(timeoutMs / 1000)}s`,
            );
          }
          resolve(TOOL_TIMEOUT_SENTINEL);
        }, timeoutMs);
      });

      const execPromise = originalExecute(...forwardedArgs);
      // If the tool rejects AFTER we've already returned the timeout result
      // (e.g. it rejects from the abort we triggered), swallow it so it isn't an
      // unhandledRejection. Promise.race below still observes the real rejection
      // when the tool loses to nothing.
      execPromise.catch(() => {});

      try {
        const result = await Promise.race([execPromise, timeoutPromise]);
        if (result === TOOL_TIMEOUT_SENTINEL) {
          const seconds = Math.round(timeoutMs / 1000);
          return {
            content: [
              {
                type: "text",
                text: `[Tool \`${tool.name}\` was aborted after ${seconds}s (per-call timeout). The command ran too long — it likely hit an unbounded operation (e.g. a whole-filesystem \`find /\`, a command waiting on stdin, or a hung network call). Narrow the scope (a specific path, \`-maxdepth\`, a filter, or an explicit \`timeout\`) and try again.]`,
              },
            ],
          };
        }
        return result;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        incomingSignal?.removeEventListener("abort", linkIncomingAbort);
      }
    }) as TTool["execute"],
  };
  return wrapped;
}

const REPAIRED_CONTENT_PLACEHOLDER: ReadonlyArray<{ type: "text"; text: string }> = [
  { type: "text", text: "(empty result — sanitized after runtime upgrade)" },
];

/** Walk a pi-coding-agent JSONL session file and replace any assistant /
 *  toolResult message whose `content` is missing, null, or non-array with a
 *  single-text placeholder. pi-coding-agent's compaction and pi-ai's provider
 *  adapters all iterate `message.content` unguarded; one corrupt entry kills
 *  the whole run. Idempotent — sanitized entries already have valid arrays.
 *  Logs an `event` line on stderr per repair for grep-ability. */
export function repairPiSessionFileInPlace(sessionFile: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  let repaired = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;
    const role = message["role"];
    if (role !== "toolResult" && role !== "assistant") continue;
    if (Array.isArray(message["content"])) continue;
    if (typeof message["content"] === "string") continue;
    message["content"] = [...REPAIRED_CONTENT_PLACEHOLDER];
    lines[i] = JSON.stringify(entry);
    repaired += 1;
  }
  if (repaired === 0) return;
  try {
    fs.writeFileSync(sessionFile, lines.join("\n"));
    process.stderr.write(
      `pi.session.repair event=session_content_repaired outcome=success path=${sessionFile} repaired=${repaired}\n`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `pi.session.repair event=session_content_repair_failed outcome=error path=${sessionFile} reason=${reason}\n`,
    );
  }
}

function resolveRequestedSessionFile(request: HarnessHostPiRequest): string | null {
  const requestedSessionId = firstNonEmptyString(request.harness_session_id);
  if (requestedSessionId) {
    const resolved = path.resolve(requestedSessionId);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const persistedSessionId = firstNonEmptyString(request.persisted_harness_session_id);
  if (persistedSessionId) {
    const resolved = path.resolve(persistedSessionId);
    return fs.existsSync(resolved) ? resolved : null;
  }
  return null;
}

export function buildPiMcpToolName(serverId: string, toolName: string): string {
  return buildHarnessMcpToolName(serverId, toolName);
}

function resolveMcpToolTextResult(raw: unknown): string {
  const callResult = createCallResult(raw);
  return (
    callResult.markdown() ??
    callResult.text() ??
    JSON.stringify(jsonValue(callResult.structuredContent() ?? raw), null, 2)
  );
}

export function buildPiMcpServerBindings(request: HarnessHostPiRequest): PiMcpServerBinding[] {
  return buildHarnessMcpServerBindings({
    servers: request.mcp_servers as unknown as HarnessPreparedMcpServerConfig[],
    workspaceDir: request.workspace_dir,
  }).map((binding) => ({
    serverId: binding.serverId,
    timeoutMs: binding.timeoutMs,
    definition: toMcporterServerDefinition(binding),
  }));
}

function toMcporterServerDefinition(binding: HarnessMcpServerBinding): ServerDefinition {
  if (binding.transport.kind === "stdio") {
    return {
      name: binding.serverId,
      description: binding.description,
      command: {
        kind: "stdio",
        command: binding.transport.command,
        args: binding.transport.args,
        cwd: binding.transport.cwd,
      },
      env: binding.transport.env,
    };
  }

  return {
    name: binding.serverId,
    description: binding.description,
    command: {
      kind: "http",
      url: new URL(binding.transport.url),
      headers: binding.transport.headers,
    },
  };
}

function createPiMcpToolDefinition(params: {
  runtime: McporterRuntime;
  binding: PiMcpServerBinding;
  tool: {
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    timeoutMs: number;
  };
  metadata: PiMcpToolMetadata;
}): ToolDefinition {
  return {
    name: params.metadata.piToolName,
    label: `${params.binding.serverId}:${params.tool.toolName}`,
    description: params.tool.description,
    parameters: normalizeHarnessMcpToolParametersSchema(params.tool.inputSchema) as never,
    execute: async (_toolCallId, toolParams, signal) => {
      if (signal?.aborted) {
        throw new Error(`MCP tool call aborted before execution: ${params.binding.serverId}.${params.tool.toolName}`);
      }
      const raw = await params.runtime.callTool(params.binding.serverId, params.tool.toolName, {
        args: isRecord(toolParams) ? toolParams : {},
        timeoutMs: params.tool.timeoutMs,
      });
      const text = resolveMcpToolTextResult(raw);
      return {
        content: [{ type: "text", text }],
        details: {
          server_id: params.binding.serverId,
          tool_id: params.metadata.toolId,
          tool_name: params.tool.toolName,
          raw: jsonValue(raw),
        },
      };
    },
  };
}

export async function createPiMcpToolset(request: HarnessHostPiRequest): Promise<PiMcpToolset> {
  const allBindings = buildPiMcpServerBindings(request);
  const registerNameAliases = mcpToolNameAliasesNeededForModel(
    runtimeToolSelectedModelForPiRequest(request),
  );

  // Skip discovering remote servers that need OAuth but hold no token yet.
  // Otherwise an unauthorized server (e.g. HeyGen) makes EVERY turn's bootstrap
  // grind its 401 + StreamableHTTP→SSE fallback for ~12s. Surface them as
  // authRequired immediately; the moment they're authorized (token present)
  // they're discovered normally with the replayed bearer header.
  const skippedAuthServers: PiMcpServerUnavailableInfo[] = [];
  const bindings = allBindings.filter((binding) => {
    if (mcpServerNeedsAuthWithoutToken(request.workspace_dir, binding.serverId)) {
      skippedAuthServers.push({
        serverId: binding.serverId,
        reason: "Authorization required — sign in to use this server's tools.",
        missingToolIds: [],
        authRequired: true,
      });
      return false;
    }
    return true;
  });

  if (bindings.length === 0) {
    return {
      runtime: null,
      customTools: [],
      mcpToolMetadata: new Map(),
      unavailableServers: skippedAuthServers,
    };
  }

  let runtime: McporterRuntime;
  try {
    runtime = await raceMcpRuntimeOpenAgainstDeadline(
      createRuntime({
        servers: bindings.map((binding) => binding.definition),
        rootDir: request.workspace_dir,
        clientInfo: {
          name: PI_HARNESS_CLIENT_NAME,
          version: PI_HARNESS_CLIENT_VERSION,
        },
      }),
      PI_MCP_RUNTIME_OPEN_MAX_WAIT_MS,
    );
  } catch (error) {
    // Transport open did not complete in time (or threw). We don't know which
    // single server caused it — mcporter opens them together — so surface all
    // of them as unavailable and let the run start without MCP. Without this
    // fallback the harness-host blocks here forever and `run_started` never
    // fires, which presents in the UI as a permanent "Checking workspace
    // context".
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `MCP toolset open failed; proceeding without MCP servers: ${reason}\n`,
    );
    return {
      runtime: null,
      customTools: [],
      mcpToolMetadata: new Map(),
      unavailableServers: [
        ...skippedAuthServers,
        ...bindings.map((binding) => ({
          serverId: binding.serverId,
          reason,
          missingToolIds: [],
        })),
      ],
    };
  }

  try {
    // Fast path: a cross-turn cache keyed by the server configs + allowlist
    // lets us build the tool list WITHOUT a live `listTools` handshake against
    // every server. Transports (incl. remote ones) then connect lazily on the
    // first `callTool` — mcporter memoizes per server — so a turn no longer
    // blocks startup on remote MCP round-trips. Bypassed on
    // `_holaboss_force_refresh` (a restarted app sidecar may have changed its
    // tool set).
    const cacheKey = piMcpToolCacheKey(
      request.mcp_servers,
      request.mcp_tool_refs,
    );
    if (!piMcpServersForceRefresh(request.mcp_servers)) {
      const cachedTools = readPiMcpToolCache(request.workspace_dir, cacheKey);
      if (cachedTools) {
        const { customTools, mcpToolMetadata } =
          buildPiMcpCustomToolsFromDiscovered(runtime, bindings, cachedTools, registerNameAliases);
        return { runtime, customTools, mcpToolMetadata, unavailableServers: skippedAuthServers };
      }
    }

    // Cold path: one live discovery (a handshake per server), then cache the
    // result so the next turn takes the fast path above.
    const discovered = await createPiMcpCustomTools(request, runtime, bindings);
    writePiMcpToolCache(request.workspace_dir, cacheKey, discovered.discovered);
    // Self-heal: any server that failed discovery with authRequired gets marked
    // so the NEXT turn skips it (fast) rather than re-grinding its 401. Covers
    // servers connected before the connect-time probe existed.
    for (const unavailable of discovered.unavailableServers) {
      if (unavailable.authRequired) {
        writeMcpAuthRequiredMarker(request.workspace_dir, unavailable.serverId, true);
      }
    }
    return {
      runtime,
      customTools: discovered.customTools,
      mcpToolMetadata: discovered.mcpToolMetadata,
      unavailableServers: [...skippedAuthServers, ...discovered.unavailableServers],
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

export async function raceMcpRuntimeOpenAgainstDeadline(
  open: Promise<McporterRuntime>,
  timeoutMs: number,
): Promise<McporterRuntime> {
  let settled = false;
  return await new Promise<McporterRuntime>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `MCP toolset open timed out after ${timeoutMs}ms — one or more workspace MCP servers (likely a resolved-application server) failed to handshake`,
        ),
      );
    }, timeoutMs);
    open.then(
      (runtime) => {
        if (settled) {
          // The timeout already won. Close the late-arriving runtime so any
          // open transports/processes are released instead of leaking.
          void runtime.close().catch(() => undefined);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(runtime);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Build pi tool definitions from a list of discovered (or cached) MCP tools.
 * Shared by the live-discovery path and the cache fast-path so both produce
 * identical `customTools` — the only difference is where the tool metadata
 * came from. The tool's `execute` lazily connects its server via
 * `runtime.callTool` on first invocation, so cached tools work without any
 * prior handshake.
 */
function buildPiMcpCustomToolsFromDiscovered(
  runtime: McporterRuntime,
  bindings: PiMcpServerBinding[],
  discoveredTools: HarnessDiscoveredMcpTool[],
  registerNameAliases = true,
): { customTools: ToolDefinition[]; mcpToolMetadata: Map<string, PiMcpToolMetadata> } {
  const customTools: ToolDefinition[] = [];
  const mcpToolMetadata = new Map<string, PiMcpToolMetadata>();
  for (const tool of discoveredTools) {
    const binding = bindings.find((entry) => entry.serverId === tool.serverId);
    if (!binding) {
      continue;
    }
    const metadata: PiMcpToolMetadata = {
      piToolName: tool.harnessToolName,
      serverId: tool.serverId,
      toolId: tool.toolId,
      toolName: tool.toolName,
    };
    const toolDefinition = createPiMcpToolDefinition({
      runtime,
      binding,
      tool: {
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        timeoutMs: tool.timeoutMs,
      },
      metadata,
    });
    customTools.push(toolDefinition);
    mcpToolMetadata.set(metadata.piToolName, metadata);
    // Register the same tool under the Claude-Agent-SDK-style
    // `mcp__<server>__<tool>` names as well. Pi exposes MCP tools under their
    // BARE names, but some models (e.g. GLM) namespace MCP calls with that
    // convention regardless — so a bare-named tool comes back "Tool not found".
    // Aliasing (same execute; the SDK resolves by exact name) makes either
    // spelling work without changing what the schema teaches. Skipped for models
    // that call by the exact registered name (Claude/GPT/…): there the aliases
    // are dead weight that DOUBLES a kebab-named server's tool count in the list
    // the model sees (e.g. AdsPower), flooding it and hurting tool selection.
    if (registerNameAliases) {
      for (const aliasName of harnessMcpToolNameAliases(
        tool.serverId,
        tool.toolName,
      )) {
        if (aliasName !== toolDefinition.name) {
          customTools.push({ ...toolDefinition, name: aliasName });
        }
      }
    }
  }
  return { customTools, mcpToolMetadata };
}

export async function createPiMcpCustomTools(
  request: HarnessHostPiRequest,
  runtime: McporterRuntime,
  bindings: PiMcpServerBinding[] = buildPiMcpServerBindings(request)
): Promise<Omit<PiMcpToolset, "runtime"> & { discovered: HarnessDiscoveredMcpTool[] }> {
  const { tools: discoveredTools, failures } = await discoverHarnessMcpTools({
    bindings: buildHarnessMcpServerBindings({
      servers: request.mcp_servers as unknown as HarnessPreparedMcpServerConfig[],
      workspaceDir: request.workspace_dir,
    }),
    runtime,
    toolRefs: request.mcp_tool_refs,
    retryIntervalMs: PI_MCP_DISCOVERY_RETRY_INTERVAL_MS,
    maxWaitMs: PI_MCP_DISCOVERY_MAX_WAIT_MS,
  });

  const { customTools, mcpToolMetadata } = buildPiMcpCustomToolsFromDiscovered(
    runtime,
    bindings,
    discoveredTools,
    mcpToolNameAliasesNeededForModel(runtimeToolSelectedModelForPiRequest(request)),
  );

  return {
    customTools,
    mcpToolMetadata,
    unavailableServers: failures.map((failure) => ({
      serverId: failure.serverId,
      reason: failure.reason,
      missingToolIds: failure.missingToolIds,
      authRequired: failure.authRequired,
    })),
    discovered: discoveredTools,
  };
}

function resolvePiModel(request: HarnessHostPiRequest, modelRegistry: ModelRegistry) {
  const direct = modelRegistry.find(request.provider_id, request.model_id);
  if (direct) {
    return direct;
  }

  const prefixed = modelRegistry.find(request.provider_id, `${request.provider_id}/${request.model_id}`);
  if (prefixed) {
    return prefixed;
  }

  const fallback = modelRegistry
    .getAll()
    .find(
      (model) =>
        (model.provider === request.provider_id && model.id === request.model_id) ||
        (model.provider === request.provider_id && model.id === `${request.provider_id}/${request.model_id}`) ||
        `${model.provider}/${model.id}` === request.model_id
    );
  if (fallback) {
    return fallback;
  }

  throw new Error(`Pi model not found for provider=${request.provider_id} model=${request.model_id}`);
}

function normalizedPiModelId(request: Pick<HarnessHostPiRequest, "model_id">): string {
  return normalizeHarnessModelId(request.model_id);
}

function resolvePiModelProfile(request: HarnessHostPiRequest) {
  return resolveHarnessModelProfile(request, {
    modelCatalog: mergeHarnessModelCatalogs(
      PI_MODEL_CATALOG,
      runtimeConfigModelCatalog(),
    ),
    fallbackBudget: {
      contextWindow: PI_FALLBACK_CONTEXT_WINDOW,
      maxTokens: PI_FALLBACK_MAX_TOKENS,
    },
  });
}

export function configurePiPromptCacheRetention(request: HarnessHostPiRequest): () => void {
  if (resolvePiModelProfile(request).api !== "openai-responses") {
    return () => {};
  }
  const previousValue = process.env.PI_CACHE_RETENTION;
  // Keep the override scoped to the harness session so PI's internal
  // compaction/summarization requests inherit long cache retention.
  process.env.PI_CACHE_RETENTION = "long";
  return () => {
    if (previousValue === undefined) {
      delete process.env.PI_CACHE_RETENTION;
      return;
    }
    process.env.PI_CACHE_RETENTION = previousValue;
  };
}

export function requestedPiThinkingLevel(
  request: Pick<HarnessHostPiRequest, "thinking_value">,
): PiRequestedThinkingLevel | null {
  return requestedHarnessThinkingLevel(request);
}

export function requestedPiThinkingBudgets(
  request: Pick<HarnessHostPiRequest, "thinking_value">,
): Partial<Record<PiThinkingBudgetLevel, number>> | undefined {
  return requestedHarnessThinkingBudgets(request);
}

export function requestedPiThinkingConfig(
  request: Pick<HarnessHostPiRequest, "thinking_value">,
): PiThinkingSelection {
  return requestedHarnessThinkingConfig(request);
}

/** Why a compaction attempt did or did not happen. Returned rather than logged
 *  so the decision is assertable: every one of these branches is a silent
 *  no-op in production, and "compaction never ran" and "compaction ran and
 *  failed" look identical from outside. */
export type CompactionOutcome =
  | { status: "compacted" }
  | { status: "failed"; error: string }
  | {
      status: "skipped";
      reason:
        | "unsupported"
        | "already-compacting"
        | "usage-unavailable"
        | "under-threshold";
    };

type CompactableSession = {
  getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | null;
  compact?: (customInstructions?: string) => Promise<unknown>;
  isCompacting?: boolean;
};

/**
 * End-of-turn compaction: summarize the session once it crosses
 * `PI_COMPACTION_USAGE_THRESHOLD_RATIO` of the model's context window.
 *
 * Extracted from `runPi` so it can be driven directly. In place it was a
 * closure over a live `AgentSession`, reachable only by running a real model
 * turn long enough to cross the threshold — which is why it had never been
 * exercised except by hand, and why a failure here was invisible: the catch
 * wrote to `console.warn`, and in-process that lands in ts-runner's stderr,
 * which is buffered and surfaced only when a run FAILS. A compaction failure
 * does not fail the run, so the warning was written to a stream nobody reads.
 *
 * The caller still logs; what changed is that the outcome is now a value, so
 * both "did it run" and "did it work" can be asserted.
 */
export async function compactSessionOverThreshold(
  rawSession: unknown,
): Promise<CompactionOutcome> {
  const session = rawSession as CompactableSession;
  if (typeof session?.compact !== "function") {
    return { status: "skipped", reason: "unsupported" };
  }
  if (session.isCompacting) {
    return { status: "skipped", reason: "already-compacting" };
  }
  const usage = session.getContextUsage?.();
  const tokens = typeof usage?.tokens === "number" ? usage.tokens : null;
  const contextWindow =
    typeof usage?.contextWindow === "number" ? usage.contextWindow : 0;
  if (tokens === null || contextWindow <= 0) {
    return { status: "skipped", reason: "usage-unavailable" };
  }
  if (tokens <= contextWindow - piCompactionReserveTokens(contextWindow)) {
    return { status: "skipped", reason: "under-threshold" };
  }
  try {
    // Compaction sends the full history to be summarized, so an image-bloated
    // transcript would 413 the compaction request just like the turn did. Prune
    // oversized inline images first so the summary request stays sendable.
    capSessionImageContext(session);
    await session.compact();
    return { status: "compacted" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function piCompactionReserveTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return 0;
  }
  return Math.max(
    0,
    contextWindow -
      Math.floor(contextWindow * PI_COMPACTION_USAGE_THRESHOLD_RATIO),
  );
}

const AGENT_ROLE_HEADER_NAME = "X-Holaboss-Agent-Role";

function mergeAgentRoleHeader(
  headers: Record<string, string> | undefined,
  agentRole: string | null | undefined,
): Record<string, string> | undefined {
  const normalized = typeof agentRole === "string" ? agentRole.trim() : "";
  if (!normalized) {
    return headers;
  }
  const existing = headers ?? {};
  const alreadyPresent = Object.keys(existing).some(
    (key) => key.trim().toLowerCase() === AGENT_ROLE_HEADER_NAME.toLowerCase(),
  );
  if (alreadyPresent) {
    return existing;
  }
  return { ...existing, [AGENT_ROLE_HEADER_NAME]: normalized };
}

export function buildPiProviderConfig(request: HarnessHostPiRequest) {
  const profile = resolvePiModelProfile(request);
  const headers = mergeAgentRoleHeader(profile.headers, request.agent_role);

  return {
    baseUrl: profile.baseUrl,
    apiKey: request.model_client.api_key,
    api: profile.api,
    headers,
    authHeader: profile.authHeader,
    models: [
      {
        id: request.model_id,
        name: request.model_id,
        api: profile.api,
        reasoning: profile.reasoning,
        input: profile.input,
        cost: profile.cost,
        contextWindow: profile.budget.contextWindow,
        maxTokens: profile.budget.maxTokens,
        ...(profile.compat ? { compat: profile.compat } : {}),
      },
    ],
  };
}

export function toolEnabledForPiRequest(
  request: Pick<HarnessHostPiRequest, "tools">,
  toolName: string,
): boolean {
  const requestedTools = request.tools ?? {};
  if (Object.keys(requestedTools).length === 0) {
    return true;
  }
  const normalizedToolName = toolName.trim().toLowerCase();
  if (requestedTools[normalizedToolName] === true) {
    return true;
  }
  const aliases = PI_REQUEST_TOOL_NAME_ALIASES[normalizedToolName] ?? [];
  return aliases.some((alias) => requestedTools[alias] === true);
}

export function filterPiToolDefinitionsForRequest<TTool extends { name: string }>(
  request: Pick<HarnessHostPiRequest, "tools">,
  tools: readonly TTool[],
): TTool[] {
  return tools.filter((tool) => toolEnabledForPiRequest(request, tool.name));
}

export function filterPiRuntimeToolDefinitionsForHost<TTool extends { name: string }>(
  tools: readonly TTool[],
): TTool[] {
  return tools.filter((tool) => !PI_HOST_NATIVE_TOOL_NAMES.has(tool.name.trim().toLowerCase()));
}

async function defaultCreateSession(request: HarnessHostPiRequest): Promise<PiSessionHandle> {
  const stateDir = resolvePiStateDir(request.workspace_dir);
  const sessionDir = resolvePiSessionDir(request.workspace_dir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  // Resolve the agent's cwd EARLY so SessionManager.create below receives it
  // — otherwise the pi-session JSONL records cwd=workspace_dir and the SDK's
  // system prompt ("Current working directory: <cwd>") reports the workspace
  // runtime dir even after we set the right cwd on createAgentSession.
  const agentCwd =
    typeof request.agent_cwd === "string" &&
    request.agent_cwd.trim().length > 0
      ? request.agent_cwd.trim()
      : request.workspace_dir;

  const authStorage = AuthStorage.create(path.join(stateDir, "auth.json"));
  authStorage.setRuntimeApiKey(request.provider_id, request.model_client.api_key);

  const modelRegistry = ModelRegistry.create(
    authStorage,
    path.join(stateDir, "models.json"),
  );
  modelRegistry.registerProvider(request.provider_id, buildPiProviderConfig(request));

  const model = resolvePiModel(request, modelRegistry);
  const compactionReserveTokens = piCompactionReserveTokens(model.contextWindow);
  const requestedThinking = requestedPiThinkingLevel(request) ?? "off";
  const requestedThinkingBudgets = requestedPiThinkingBudgets(request);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: request.provider_id,
    defaultModel: request.model_id,
    defaultThinkingLevel: requestedThinking,
    compaction: {
      reserveTokens: compactionReserveTokens,
    },
    retry: PI_AUTO_RETRY_SETTINGS,
    ...(requestedThinkingBudgets
      ? { thinkingBudgets: requestedThinkingBudgets }
      : {}),
  });
  // TTFT dissection: time each session-setup await. These run serially today, so
  // their sum is the harness_boot "session setup" cost — the per-step map shows
  // which one dominates (e.g. an MCP connect or a composio fetch on cold start).
  const setupTimingsMs: Record<string, number> = {};
  const timedSetup = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      setupTimingsMs[key] = Date.now() - startedAt;
    }
  };
  const skillDirs = resolvePiSkillDirs(request);
  const loadedSkills = loadPiSkills(skillDirs);
  const skillMetadataByAlias = buildPiSkillMetadataByAlias(loadedSkills.skills);
  // todowrite/todoread are no longer injected into the per-turn tool set: their
  // schemas were ~6KB of EVERY request (even a bare "hi") for little practical
  // value. createPiTodoToolDefinitions stays exported for tests / other callers.
  const browserTools = request.browser_tools_enabled
    ? filterPiToolDefinitionsForRequest(
        request,
        await timedSetup("browser_tools", () =>
          resolveHarnessDesktopBrowserToolDefinitions({
            runtimeApiBaseUrl: request.runtime_api_base_url,
            workspaceId: request.workspace_id,
            sessionId: request.session_id,
            inputId: request.input_id,
            space: request.browser_space ?? undefined,
            browserProfileId: request.browser_profile_id ?? undefined,
          })
        )
      )
    : [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.workspace_dir,
    agentDir: stateDir,
    settingsManager,
    extensionFactories: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // Suppress pi's own `<available_skills>` block and emit our own compact
    // catalogue instead (see renderPiSkillCatalog). pi's block cost ~4,860 tokens
    // for 41 skills — over half of them the absolute `<location>` SKILL.md path
    // of every skill, plus a preamble telling the model to `read` that file.
    // holaOS resolves skills BY NAME through its own `skill` tool (which already
    // states the skill's base dir when it renders the block), so the paths are
    // dead weight and the `read` instruction actively competes with that tool.
    //
    // `disableModelInvocation` is what filters a skill out of pi's prompt block
    // (skills.js) while LEAVING it in getSkills() — which matters, because pi
    // still resolves `/skill <name>` slash-expansion through that list and reads
    // skill.filePath from it. So the path stays on the objects, just not in the
    // prompt.
    skillsOverride: () => ({
      ...loadedSkills,
      skills: loadedSkills.skills.map((skill) => ({
        ...skill,
        disableModelInvocation: true,
      })),
    }),
    systemPromptOverride: () =>
      `${effectiveSystemPromptForRequest(request)}${renderPiSkillCatalog(loadedSkills.skills)}`,
  });
  await timedSetup("resource_reload", () => resourceLoader.reload());

  const persistedSessionFile = resolveRequestedSessionFile(request);
  if (persistedSessionFile) {
    repairPiSessionFileInPlace(persistedSessionFile);
  }
  // Pass `agentCwd` as the SDK's `cwdOverride` on .open(), otherwise the SDK
  // reads `cwd` from the JSONL header. Snapshots created before the executor
  // started threading agentCwd into createPiSessionFile baked workspace_dir
  // into that header, so without the override the agent would still see the
  // workspace runtime dir as its cwd on any resumed/inherited session — even
  // though the boundary policy and tool roots are already wired to agentCwd.
  const sessionManager = persistedSessionFile
    ? SessionManager.open(persistedSessionFile, undefined, agentCwd)
    : SessionManager.create(agentCwd, sessionDir);
  // These four are independent — none consumes another's result — but they ran
  // strictly one after another, so session_setup cost their SUM rather than
  // their max. Each is network-ish (MCP discovery, the runtime tool catalogue,
  // composio's inline listing, web-search definitions), and that time is paid
  // before the model is contacted on every turn.
  //
  // Their timedSetup entries now overlap, so the per-stage numbers in
  // `setup=[…]` will add up to more than the elapsed wall clock. That is the
  // point; the individual durations are still what you want when deciding
  // which one to attack next.
  const [mcpToolset, resolvedRuntimeTools, composioInline, webSearchTools] =
    await Promise.all([
      timedSetup("mcp_connect", () => createPiMcpToolset(request)),
      timedSetup("runtime_tools", () =>
        resolveHarnessRuntimeToolDefinitions({
          runtimeApiBaseUrl: request.runtime_api_base_url,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          selectedModel: runtimeToolSelectedModelForPiRequest(request),
        }),
      ),
      timedSetup("composio_inline", () =>
        resolveComposioInlineTools({
          workspaceDir: request.workspace_dir,
          runtimeApiBaseUrl: request.runtime_api_base_url ?? null,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          selectedModel: runtimeToolSelectedModelForPiRequest(request) ?? null,
        }),
      ),
      toolEnabledForPiRequest(request, "web_search")
        ? timedSetup("web_search", () => resolvePiWebSearchToolDefinitions())
        : Promise.resolve([]),
    ]);
  const runtimeTools = filterPiToolDefinitionsForRequest(
    request,
    resolvedRuntimeTools,
  );
  const runtimeToolsForHost = consolidateRuntimeToolFamilies(
    filterPiRuntimeToolDefinitionsForHost(runtimeTools),
  );
  // agentCwd resolved at the top of this function. All agent-facing tools
  // (Bash via createCodingTools, Ls, find, search, document-read) get
  // wired to agentCwd as their root. workspace_dir keeps feeding the
  // resource loader so workspace.yaml and workspace-level skills stay
  // loadable; the boundary policy lists workspace_dir as an allowed
  // external dir for reads from the agent.
  const documentReadTools = filterPiToolDefinitionsForRequest(
    request,
    createPiDocumentReadToolDefinitions(agentCwd),
  );
  const baseTools = sanitizeToolSchemas(
    "base",
    filterPiToolDefinitionsForRequest(request, [
      ...createCodingTools(agentCwd).filter((tool) => tool.name !== "read"),
      createPiSearchToolDefinition(agentCwd),
      createPiFindToolDefinition(agentCwd),
      createLsTool(agentCwd),
    ]),
  );
  // Deferred tool gateway: the bulky, occasionally-used tool families — Composio
  // integrations, the browser family, and MCP servers — stay REGISTERED but are
  // deactivated after session creation, so their schemas stay OUT of every turn's
  // prompt. A measured desktop "hi" carried 131 tools / ~46k tokens of schemas, of
  // which composio ~25.7k + browser ~9.6k + mcp ~1.4k were deferrable. The model
  // reaches them via call_tool/describe_tool, and the first call to a family
  // promotes that whole family to native for later turns (see
  // deferred-tool-gateway.ts). HB_DEFERRED_TOOLS=0 restores fully-native tools.
  const deferredSessionRef: { current: ActiveToolController | null } = {
    current: null,
  };
  const asDeferredTarget = (
    tool: { name: string; description?: string; execute: unknown },
    group: string,
    bareName?: string,
  ): DeferredToolTarget => ({
    name: tool.name,
    group,
    description: tool.description,
    parameters: (tool as { parameters?: unknown }).parameters,
    ...(bareName ? { bareName } : {}),
    execute: tool.execute as DeferredToolTarget["execute"],
  });
  // Administration tools: setup/repair actions that essentially never fire on a
  // normal turn, yet cost ~4.1k tokens of schema in every single request. Gating
  // them trades a one-call round-trip on the rare admin turn for that budget back
  // on every other turn. Grouped so promoting one brings its siblings (an MCP
  // repair needs connect+refresh+reauthorize together).
  //
  // Deliberately NOT here: workspace_integrations_list_catalog,
  // composio_search_tools and composio_execute_tool. Those are the discovery and
  // long-tail-execution path — gating composio_search_tools cost a real turn
  // ("Tool not found", then two steps rediscovering it via describe_tool).
  //
  // Also NOT here, for the same reason one step further along the same chain:
  // holaboss_workspace_integrations_propose_connect. It is the ACTION at the end
  // of that discovery path — "can you use my notion?" runs list_catalog (native)
  // -> composio_search_tools (native) -> propose_connect — and deferring only the
  // last hop is what makes the sequence expensive. Observed live: with no schema
  // in the prompt the model called it without the required toolkit_slug, got
  // "toolkit_slug is required", and had to retry, while the user watched.
  //
  // It is also a UI-affordance tool: its result is what renders the Connect card
  // on the canvas. Tools the interface depends on belong in the prompt — they
  // fire on exactly the interactive turns where a wasted round trip is most
  // visible, and their schemas are small (this whole admin group is ~4.1k tokens
  // across ten tools, against composio's ~25.7k).
  //
  // mcp_connect and mcp_reauthorize are native for the same reason: their
  // results render the Authorize card (see the desktop's
  // mcpAuthorizationsFromToolResult, which keys on exactly those two names).
  // mcp_refresh stays deferred — it renders nothing, and if a repair needs it
  // the gateway reaches it fine.
  const DEFERRABLE_ADMIN_TOOLS: Readonly<Record<string, string>> = {
    mcp_refresh: "mcp_admin",
    capability_install: "workspace_admin",
    open_macos_settings: "workspace_admin",
    update_workspace_instructions: "workspace_admin",
    holaboss_workspace_integrations_set_default_account: "integration_setup",
    cronjobs: "scheduling",
    terminal_session: "terminal",
  };
  const adminGroupFor = (name: string): string | null =>
    DEFERRABLE_ADMIN_TOOLS[name] ?? null;
  // A composio tool is deferrable unless it is one of the meta tools above; the
  // admin map still wins for the setup-only integration tools.
  const isIntegrationMetaTool = (name: string): boolean =>
    !adminGroupFor(name) &&
    (name.includes("workspace_integrations") || name.startsWith("composio_"));
  const composioDeferrable = (composioInline.tools as unknown as ToolDefinition[]).filter(
    (tool) => !isIntegrationMetaTool(tool.name),
  );
  // Admin tools live among the runtime tools (and occasionally the composio meta
  // set); pick them up by name from wherever they were built.
  const adminDeferrable = [
    ...(runtimeToolsForHost as unknown as ToolDefinition[]),
    ...(composioInline.tools as unknown as ToolDefinition[]),
  ]
    .filter((tool) => adminGroupFor(tool.name) !== null)
    // Both source arrays are scanned, so dedupe by name — a duplicate target
    // would list the tool twice in the catalogue.
    .filter(
      (tool, index, all) => all.findIndex((other) => other.name === tool.name) === index,
    );
  const deferredGateway = buildDeferredToolGateway({
    sessionRef: deferredSessionRef,
    targets: [
      ...(browserTools as unknown as ToolDefinition[]).map((tool) =>
        asDeferredTarget(tool, "browser"),
      ),
      // Composio tool names are `<toolkit>_<action>` (github_create_a_commit), so
      // the toolkit prefix is the family the model activates.
      ...composioDeferrable
        .filter((tool) => adminGroupFor(tool.name) === null)
        .map((tool) => asDeferredTarget(tool, tool.name.split("_")[0] || "integration")),
      ...adminDeferrable.map((tool) =>
        asDeferredTarget(tool, adminGroupFor(tool.name) ?? "workspace_admin"),
      ),
      ...mcpToolset.customTools.map((tool) => {
        const meta = mcpToolset.mcpToolMetadata.get(tool.name);
        return asDeferredTarget(tool, meta?.serverId ?? "mcp", meta?.toolName);
      }),
    ],
  });
  const nonSkillCustomTools: ToolDefinition[] = sanitizeToolSchemas("custom", [
    ...documentReadTools,
    ...(browserTools as unknown as ToolDefinition[]),
    ...(runtimeToolsForHost as unknown as ToolDefinition[]),
    ...(composioInline.tools as unknown as ToolDefinition[]),
    ...webSearchTools,
    ...(deferredGateway
      ? (deferredGateway.gatewayTools as unknown as ToolDefinition[])
      : []),
    // MCP tools are NOT re-gated by the request.tools enable-map. Their scope is
    // already authoritative at discovery (`discoverHarnessMcpTools` in
    // runtime/harnesses/src/mcp.ts): a server WITH allowlist refs yields only
    // those tools; a server WITHOUT refs yields all of them. The enable-map is
    // built from the capability manifest + mcp_tool_refs, so it only ever lists
    // tools from servers that ARE in the allowlist — re-filtering here silently
    // dropped every tool of a connected-but-unlisted server (e.g. a workspace.yaml
    // MCP server added without a matching allowlist entry). The server access
    // boundary is `request.mcp_servers` (which drives discovery and is zeroed for
    // tool_node sessions), not this builtin enable-map — same as composioInline
    // tools above, which already flow through ungated.
    ...mcpToolset.customTools,
  ]);
  const availableToolNames = [...baseTools, ...nonSkillCustomTools].map((tool) => tool.name);
  const availableCommandIds = workspaceCommandIdsFromRunStartedPayload(request.run_started_payload);
  const sessionSkillDirs = resolvePiSkillDirs(request);
  // Boundary root is the AGENT's cwd (agentCwd resolved above). workspace_dir
  // is added as an allowed external dir so the agent can still read
  // workspace.yaml, skills, and other workspace metadata even when its run
  // directory is somewhere else.
  const allowedExternalDirs =
    agentCwd === request.workspace_dir
      ? [...sessionSkillDirs]
      : [request.workspace_dir, ...sessionSkillDirs];
  const workspaceBoundaryPolicy = createWorkspaceBoundaryPolicy(
    agentCwd,
    workspaceBoundaryOverrideRequested(request.instruction),
    allowedExternalDirs,
  );
  const skillWideningState = createPiSkillWideningState(
    skillMetadataByAlias,
    [...availableToolNames, "skill"],
    availableCommandIds
  );
  const refreshPiSkillCatalogForSession = () =>
    refreshPiSkillCatalog({
      skillDirs: resolvePiSkillDirs(request),
      skillMetadataByAlias,
      skillWideningState,
      availableToolNames: [...availableToolNames, "skill"],
      availableCommandIds,
    });
  const skillTools =
    toolEnabledForPiRequest(request, "skill")
      ? [
          createPiSkillToolDefinition(
            skillMetadataByAlias,
            skillWideningState,
            workspaceBoundaryPolicy.overrideRequested,
            {
              refreshCatalog: refreshPiSkillCatalogForSession,
            },
          ),
        ]
      : [];
  // One accumulator shared by every tool this run: once the run's inlined tool
  // output crosses the session budget, further large results offload instead of
  // piling onto the context (bounds long browser/tool-heavy sessions).
  const toolOutputCapState = createToolOutputCapState();
  const tools = baseTools.map((tool) =>
    // Outermost: downscale any inline images the tool returns (in-process via
    // @napi-rs/canvas) before they reach the model, so an image-heavy turn stays
    // under the provider request-size limit. A cumulative backstop lives in
    // capSessionImageContext, which evicts older images once the session's image
    // bytes exceed the budget.
    wrapToolWithImageCap(
      // One wall-clock deadline over the whole tool-call chain, so a runaway
      // `bash` (e.g. `find /`) can't freeze the session for hours.
      wrapToolWithTimeout(
        wrapToolWithOutputCap(
          wrapToolWithSkillWidening(
            // Innermost: only the real spawn sees the temp-script rewrite; the
            // skill-widening and output-cap layers above still see the original command.
            wrapBashToolForWindowsCommandLimit(tool),
            skillWideningState,
          ),
          agentCwd,
          toolOutputCapState,
        )
      )
    )
  );
  const customTools = [
    ...nonSkillCustomTools.map((tool) =>
      // Browser screenshots + read-in images flow through here — downscale at
      // the source so the within-turn requests stay sendable.
      wrapToolWithImageCap(
        wrapToolWithTimeout(
          wrapToolWithOutputCap(
            wrapToolWithSkillWidening(tool, skillWideningState),
            agentCwd,
            toolOutputCapState,
          )
        )
      )
    ),
    ...skillTools.map((tool) =>
      wrapToolWithImageCap(
        wrapToolWithTimeout(
          wrapToolWithOutputCap(
            tool,
            agentCwd,
            toolOutputCapState,
          )
        )
      )
    ),
  ];

  const restorePromptCacheRetention = configurePiPromptCacheRetention(request);
  let session: AgentSession;
  try {
    ({ session } = await timedSetup("create_agent_session", () =>
      createAgentSession({
        // Agent runs from agentCwd (project_path / HOME / fallback to
        // workspace_dir). workspace_dir below in resourceLoader stays the
        // workspace metadata root.
        cwd: agentCwd,
        agentDir: stateDir,
        authStorage,
        modelRegistry,
        model,
        resourceLoader,
        sessionManager,
        settingsManager,
        // pi 0.80: `tools` is a name ALLOWLIST, not tool definitions. Disable pi's
        // builtin read/bash/edit/write with `noTools: "builtin"` and pass ALL our
        // tools — our own wrapped coding tools (createCodingTools minus read) plus
        // the custom tools — through `customTools`. (0.66 → 0.80 break.)
        noTools: "builtin",
        customTools: [...tools, ...customTools],
      })
    ));
  } catch (error) {
    restorePromptCacheRetention();
    await mcpToolset.runtime?.close();
    throw error;
  }

  // The session now exists: wire the gateway to it and DEACTIVATE the deferred
  // families so only the compact catalogue (not their schemas) rides in the
  // prompt. They stay in the registry so a family can be promoted back to active
  // on first use; setActiveToolsByName rebuilds the base system prompt from the
  // active set and takes effect on the first agent turn.
  if (deferredGateway) {
    deferredSessionRef.current = session;
    const activeToolNames = session
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !deferredGateway.gatedNames.has(name));
    session.setActiveToolsByName(activeToolNames);
  }

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    try {
      session.dispose();
    } finally {
      try {
        await mcpToolset.runtime?.close();
      } finally {
        restorePromptCacheRetention();
      }
    }
    throw new Error("Pi session manager did not provide a persisted session file");
  }

  return {
    session,
    sessionFile,
    mcpToolMetadata: mcpToolset.mcpToolMetadata,
    skillMetadataByAlias,
    unavailableMcpServers: mcpToolset.unavailableServers,
    unavailableComposioToolkits: composioInline.unavailable,
    setupTimingsMs,
    dispose: async () => {
      try {
        session.dispose();
      } finally {
        try {
          await mcpToolset.runtime?.close();
        } finally {
          restorePromptCacheRetention();
        }
      }
    },
  };
}

function toolCallId(event: AgentSessionEvent): string {
  if ("toolCallId" in event && typeof event.toolCallId === "string") {
    return event.toolCallId;
  }
  return "";
}

function maybeMapSkillInvocationStart(event: AgentSessionEvent, state: PiEventMapperState): PiMappedEvent | null {
  const payload = buildHarnessSkillInvocationStartPayload({
    toolName: event.type === "tool_execution_start" ? event.toolName : null,
    toolCallId: event.type === "tool_execution_start" ? event.toolCallId : "",
    args: event.type === "tool_execution_start" ? event.args : null,
    skillMetadataByAlias: state.skillMetadataByAlias,
  });
  if (!payload) {
    return null;
  }
  return {
    event_type: "skill_invocation",
    payload: {
      source: "pi",
      ...jsonObject(payload),
    },
  };
}

function maybeMapSkillInvocationEnd(
  event: AgentSessionEvent,
  toolArgs: JsonValue | null,
  state: PiEventMapperState
): PiMappedEvent | null {
  const payload = buildHarnessSkillInvocationEndPayload({
    toolName: event.type === "tool_execution_end" ? event.toolName : null,
    toolCallId: toolCallId(event),
    toolArgs,
    result: event.type === "tool_execution_end" ? event.result : null,
    isError: event.type === "tool_execution_end" ? Boolean(event.isError) : false,
    skillMetadataByAlias: state.skillMetadataByAlias,
  });
  if (!payload) {
    return null;
  }
  return {
    event_type: "skill_invocation",
    payload: {
      source: "pi",
      ...jsonObject(payload),
    },
  };
}

function assistantMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text;
    })
    .join("")
    .trim();
}

function parseJsonIfPossible(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractProviderErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = parseJsonIfPossible(trimmed);
    if (parsed !== null) {
      const nested = extractProviderErrorMessage(parsed, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractProviderErrorMessage(item, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["error", "errors", "message", "detail", "details", "error_message", "body", "cause"] as const) {
    const nested = extractProviderErrorMessage(value[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function normalizeAssistantFailureMessage(errorMessage: unknown, content: unknown, stopReason: string): string {
  return (
    extractProviderErrorMessage(errorMessage) ??
    firstNonEmptyString(
      typeof errorMessage === "string" ? errorMessage : undefined,
      assistantMessageText(content),
      `Assistant message ended with stop reason ${stopReason}`
    ) ??
    `Assistant message ended with stop reason ${stopReason}`
  );
}

function maybeMapAssistantTerminalFailure(
  event: AgentSessionEvent,
  sessionFile: string,
  state: PiEventMapperState
): PiMappedEvent[] | null {
  if (event.type !== "message_end" && event.type !== "turn_end") {
    return null;
  }
  if (state.terminalState === "failed") {
    return [];
  }
  const message = isRecord(event.message) ? event.message : null;
  if (!message || message.role !== "assistant") {
    return [];
  }
  const stopReason = optionalTrimmedString(message.stopReason);
  if (stopReason !== "error" && stopReason !== "aborted") {
    return [];
  }
  const baseFailureMessage = normalizeAssistantFailureMessage(message.errorMessage, message.content, stopReason);
  const provider = optionalTrimmedString(message.provider) ?? null;
  const model = optionalTrimmedString(message.model) ?? null;
  const upstream = stopReason === "error" ? peekLatestUpstreamError({ withinMs: 60_000 }) : null;
  const failureMessage = enrichFailureMessageWithUpstream(baseFailureMessage, upstream);

  // An ABORT is unambiguously terminal — the user cancelled and pi will not
  // recover — so fail it eagerly, preserving the AbortError type. (The deferred
  // path below always types failures as ProviderError via
  // buildPendingFailureRunFailed, so an abort must not flow through it.)
  if (stopReason === "aborted") {
    state.terminalState = "failed";
    return [
      {
        event_type: "run_failed",
        payload: {
          type: "AbortError",
          message: failureMessage,
          stop_reason: stopReason,
          provider,
          model,
          event: event.type,
          source: "pi",
          harness_session_id: sessionFile,
          ...providerHttpPayloadFromCapture(upstream),
        },
      },
    ];
  }

  // Every ERROR is deferred — we do NOT try to predict whether pi will recover.
  // pi's own loop is the single source of truth for the verdict; we stash the
  // failure and let pi's ACTUAL outcome resolve it:
  //   - a successful subsequent assistant message_end → clear (recovered).
  //     Covers pi's transient retry (setTimeout agent.continue) AND its inline
  //     overflow compaction (_runAutoCompaction("overflow") → agent.continue).
  //   - auto_retry_end{success:false} → run_failed (retries exhausted).
  //   - the sendUserMessage promise settling with the failure still pending →
  //     run_failed. This is the guaranteed backstop for EVERY terminal error —
  //     a plain non-retryable error, or an exhausted overflow (pi emits
  //     compaction_end{willRetry:false} and ends the loop) — since none of
  //     those produce a success message_end to clear the pending failure. The
  //     settle path (buildPendingFailureRunFailed) carries the full metadata.
  //
  // This retired the hand-copied isPiRetryableErrorMessage regex, which
  // mirrored pi's private _isRetryableError and repeatedly drifted (it missed
  // "stream ended before message_stop" after the @earendil 0.80.2 migration,
  // then every context-overflow pattern). By observing pi's outcome instead of
  // predicting it, the desktop harness now resolves terminal state the same way
  // the backend agent operator does — from pi's real result, not a mirror.
  state.pendingRetryableFailure = {
    message: failureMessage,
    stopReason,
    provider,
    model,
    event: event.type,
  };
  return [];
}

function buildPendingFailureRunFailed(
  pending: PendingRetryableFailure,
  sessionFile: string,
  triggerEvent: string,
  retryExhausted: boolean
): PiMappedEvent {
  // The capture from pi's last retry attempt is the most actionable thing
  // to attach here — every retry hit the same upstream and replaced the
  // ring buffer entry, so the latest one is the structural cause that
  // exhausted the retries.
  const upstream = peekLatestUpstreamError({ withinMs: 5 * 60_000 });
  const enrichedMessage = enrichFailureMessageWithUpstream(pending.message, upstream);
  return {
    event_type: "run_failed",
    payload: {
      type: "ProviderError",
      message: enrichedMessage,
      stop_reason: pending.stopReason,
      provider: pending.provider,
      model: pending.model,
      event: triggerEvent,
      source: "pi",
      harness_session_id: sessionFile,
      ...providerHttpPayloadFromCapture(upstream),
      ...(retryExhausted ? { retry_exhausted: true } : {}),
    },
  };
}

function providerHttpPayloadFromCapture(
  capture: CapturedUpstreamError | null,
): { provider_http?: JsonObject } {
  if (!capture) return {};
  const parsed = capture.parsed_body;
  return {
    provider_http: {
      status: capture.status,
      status_text: capture.status_text,
      url: capture.url,
      method: capture.method,
      content_type: capture.content_type,
      duration_ms: Math.round(capture.duration_ms),
      body: capture.body,
      body_truncated: capture.body_truncated,
      parsed_body: parsed === undefined ? null : (parsed as JsonValue),
    },
  };
}

function enrichFailureMessageWithUpstream(
  base: string,
  capture: CapturedUpstreamError | null,
): string {
  if (!capture) return base;
  const deep = extractDeepProviderMessage(capture.parsed_body ?? capture.body);
  if (!deep) return base;
  // Skip when the SDK has already surfaced the same string (avoids
  // "400 Provider returned error: 400 Provider returned error").
  if (base.toLowerCase().includes(deep.toLowerCase())) return base;
  return `${base}: ${deep}`;
}

function mapNativePiEvent(event: AgentSessionEvent, sessionFile: string): PiMappedEvent {
  const nativeEventPayload =
    event.type === "message_update"
      ? jsonValue({
          type: event.type,
          assistantMessageEvent: Object.fromEntries(
            Object.entries(isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : {}).filter(
              ([key]) => key !== "partial"
            )
          ),
        })
      : jsonValue(event);
  return {
    event_type: "pi_native_event",
    payload: {
      native_type: event.type,
      native_event: nativeEventPayload,
      event: event.type,
      source: "pi",
      harness_session_id: sessionFile,
    },
  };
}

function mapPiEvent(
  event: AgentSessionEvent,
  sessionFile: string,
  state: PiEventMapperState,
  options: {
    contextUsage?: JsonValue | null;
  } = {}
): PiMappedEvent[] {
  const nativeEvent = mapNativePiEvent(event, sessionFile);
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        return [
          nativeEvent,
          {
            event_type: "output_delta",
            payload: {
              delta: event.assistantMessageEvent.delta,
              event: "message_update",
              source: "pi",
              content_index: event.assistantMessageEvent.contentIndex,
              delta_kind: "output",
            },
          },
        ];
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return [
          nativeEvent,
          {
            event_type: "thinking_delta",
            payload: {
              delta: event.assistantMessageEvent.delta,
              event: "message_update",
              source: "pi",
              content_index: event.assistantMessageEvent.contentIndex,
              delta_kind: "thinking",
            },
          },
        ];
      }
      return [nativeEvent];
    case "message_end":
    case "turn_end": {
      // A successful assistant message following a stashed retryable
      // failure means pi's internal retry recovered. Clear the pending
      // failure so the eventual agent_end emits run_completed.
      const settledMessage = isRecord(event.message) ? event.message : null;
      if (
        settledMessage?.role === "assistant" &&
        settledMessage.stopReason !== "error" &&
        settledMessage.stopReason !== "aborted"
      ) {
        state.pendingRetryableFailure = null;
      }
      const terminalFailure = maybeMapAssistantTerminalFailure(event, sessionFile, state);
      return terminalFailure == null ? [nativeEvent] : [nativeEvent, ...terminalFailure];
    }
    case "tool_execution_start": {
      state.toolArgsByCallId.set(event.toolCallId, jsonValue(event.args));
      const metadata = state.mcpToolMetadata.get(event.toolName);
      const mapped: PiMappedEvent[] = [
        nativeEvent,
        {
          event_type: "tool_call",
          payload: {
            phase: "started",
            tool_name: metadata?.toolName ?? event.toolName,
            tool_args: jsonValue(event.args),
            result: null,
            error: false,
            event: "tool_execution_start",
            source: "pi",
            call_id: event.toolCallId,
            ...(metadata
              ? {
                  pi_tool_name: metadata.piToolName,
                  mcp_server_id: metadata.serverId,
                  tool_id: metadata.toolId,
                }
              : {}),
          },
        },
      ];
      const skillMapped = maybeMapSkillInvocationStart(event, state);
      if (skillMapped) {
        mapped.push(skillMapped);
      }
      return mapped;
    }
    case "tool_execution_end": {
      const callId = toolCallId(event);
      const args = state.toolArgsByCallId.get(callId) ?? null;
      state.toolArgsByCallId.delete(callId);
      const metadata = state.mcpToolMetadata.get(event.toolName);
      const toolName = metadata?.toolName ?? event.toolName;
      const mapped: PiMappedEvent[] = [
        nativeEvent,
        {
          event_type: "tool_call",
          payload: {
            phase: "completed",
            tool_name: toolName,
            tool_args: args,
            result: jsonValue(event.result),
            error: Boolean(event.isError),
            event: "tool_execution_end",
            source: "pi",
            call_id: callId,
            ...(metadata
              ? {
                  pi_tool_name: metadata.piToolName,
                  mcp_server_id: metadata.serverId,
                  tool_id: metadata.toolId,
                }
              : {}),
          },
        },
      ];
      noteHarnessWaitingForUserOnToolCompletion({
        toolName,
        isError: Boolean(event.isError),
        state,
        result: event.result,
      });
      const skillMapped = maybeMapSkillInvocationEnd(event, args, state);
      if (skillMapped) {
        mapped.push(skillMapped);
      }
      return mapped;
    }
    case "compaction_start":
      return [
        nativeEvent,
        {
          event_type: "auto_compaction_start",
          payload: {
            reason: event.reason,
            event: "auto_compaction_start",
            source: "pi",
          },
        },
      ];
    case "compaction_end":
      return [
        nativeEvent,
        {
          event_type: "auto_compaction_end",
          payload: {
            result: jsonValue(event.result ?? null),
            aborted: event.aborted,
            will_retry: event.willRetry,
            error_message: typeof event.errorMessage === "string" ? event.errorMessage : null,
            event: "auto_compaction_end",
            source: "pi",
          },
        },
      ];
    case "agent_end":
      if (state.terminalState === "failed") {
        return [nativeEvent];
      }
      // PI can emit `agent_end` before `auto_retry_start` for retryable
      // stream failures. Do not promote the pending failure here; the
      // outer run loop resolves whether PI actually retried after
      // sendUserMessage settles.
      if (state.pendingRetryableFailure) {
        return [nativeEvent];
      }
      state.terminalState = "completed";
      return [
        nativeEvent,
        {
          event_type: "run_completed",
          payload: {
            status: resolveHarnessRunStatus({ waitingForUser: state.waitingForUser }),
            event: "agent_end",
            source: "pi",
            harness_session_id: sessionFile,
            context_usage:
              isRecord(options.contextUsage) || options.contextUsage === null
                ? options.contextUsage
                : null,
          },
        },
      ];
    case "auto_retry_start":
      // A dedicated (mapped) signal that pi is retrying the failed last message
      // in-turn — it has removed that message from its own state (slice(0, -1))
      // and will re-stream it. Consumers that accumulate the live delta stream
      // (the desktop renderer, the api-server executor) key off this to discard
      // the failed attempt's partial output so the retried stream doesn't
      // concatenate onto the truncated one ("The answer is 4" + "The answer is
      // 42."). Mirrors how compaction is surfaced as auto_compaction_start; it
      // does NOT touch terminal state (the pending failure still resolves via a
      // successful message_end / auto_retry_end / the settle fallback).
      return [
        nativeEvent,
        {
          event_type: "auto_retry_start",
          payload: {
            attempt: typeof event.attempt === "number" ? event.attempt : null,
            max_attempts:
              typeof event.maxAttempts === "number" ? event.maxAttempts : null,
            delay_ms: typeof event.delayMs === "number" ? event.delayMs : null,
            error_message:
              typeof event.errorMessage === "string" ? event.errorMessage : null,
            event: "auto_retry_start",
            source: "pi",
          },
        },
      ];
    case "auto_retry_end": {
      // pi emits auto_retry_end ONLY when retries are exhausted
      // (success=false). If a stashed pending failure exists, promote
      // it now. The success=true branch is defensive — pi doesn't
      // currently emit it, but if it did we'd clear the pending state.
      if (event.success === true) {
        state.pendingRetryableFailure = null;
        return [nativeEvent];
      }
      if (state.terminalState === "failed") {
        return [nativeEvent];
      }
      const pending = state.pendingRetryableFailure;
      state.pendingRetryableFailure = null;
      state.terminalState = "failed";
      const fallbackError = optionalTrimmedString(event.finalError) ?? "Provider error after retries exhausted";
      const resolved: PendingRetryableFailure = pending ?? {
        message: fallbackError,
        stopReason: "error",
        provider: null,
        model: null,
        event: "auto_retry_end",
      };
      return [nativeEvent, buildPendingFailureRunFailed(resolved, sessionFile, "auto_retry_end", true)];
    }
    default:
      return [nativeEvent];
  }
}

export function createPiEventMapperState(
  mcpToolMetadata: ReadonlyMap<string, PiMcpToolMetadata> = new Map(),
  skillMetadataByAlias: ReadonlyMap<string, PiSkillMetadata> = new Map()
): PiEventMapperState {
  return {
    toolArgsByCallId: new Map(),
    mcpToolMetadata,
    skillMetadataByAlias,
    terminalState: null,
    waitingForUser: false,
    pendingRetryableFailure: null,
  };
}

export function mapPiSessionEvent(event: AgentSessionEvent, sessionFile: string, state: PiEventMapperState): PiMappedEvent[] {
  return mapPiEvent(event, sessionFile, state);
}

export function defaultPiDeps(): PiDeps {
  return {
    createSession: defaultCreateSession,
  };
}

export async function runPi(request: HarnessHostPiRequest, deps: PiDeps = defaultPiDeps()): Promise<number> {
  installBenignStdioEpipeGuard();
  installUpstreamErrorCapture();
  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  const emitEvent = deps.emitEvent ?? emitRunnerEvent;

  // createSession is the one heavy await before run_started (pi session + the
  // serial MCP/composio/runtime/browser tool setup). Time it so the TTFT
  // dissection can split harness_boot into cold-load vs session setup.
  const createSessionStartedMs = Date.now();
  const handle = await deps.createSession(request);
  const sessionSetupMs = Date.now() - createSessionStartedMs;
  // pi's native compaction is left fully enabled: `_checkCompaction` runs both
  // after `agent_end` (threshold + in-turn overflow recovery) and before the next
  // prompt. The runtime no longer owns compaction — see
  // docs/plans/2026-07-12-pi-native-compaction-migration.md.
  const requestedThinking = requestedPiThinkingLevel(request) ?? "off";
  (
    handle.session as AgentSession & {
      setThinkingLevel?: (level: PiThinkingLevel) => void;
    }
  ).setThinkingLevel?.(requestedThinking);
  const currentContextUsage = (): JsonValue | null =>
    jsonValue(
      (
        handle.session as AgentSession & {
          getContextUsage?: () => unknown;
        }
      ).getContextUsage?.() ?? null,
    );
  // Drive pi's compaction explicitly at end-of-turn. pi's own auto-compaction is
  // fire-and-forget on a detached, un-awaited event queue (`_agentEventQueue`),
  // which a per-turn harness process exits before draining — so it never runs for
  // us. The SDK-preferred pattern for a one-shot integration is to compact
  // deterministically via the public `compact()` using pi's real context
  // accounting (`getContextUsage()`), matching pi's own `shouldCompact` threshold
  // (`tokens > contextWindow - reserveTokens`). Best-effort: a compaction failure
  // must never fail the turn (pi emits its own compaction_end diagnostics).
  const maybeCompactSessionOverThreshold = async (): Promise<void> => {
    const outcome = await compactSessionOverThreshold(handle.session);
    if (outcome.status === "failed") {
      console.warn("pi end-of-turn compaction failed (non-fatal)", {
        error: outcome.error,
      });
    }
  };
  const state = createPiEventMapperState(handle.mcpToolMetadata, handle.skillMetadataByAlias);
  const blockedTodoShouldPause = request.workflow_owned_subagent !== true;
  const shouldEmitWaitingUser = () =>
    resolveHarnessRunStatus({
      waitingForUser: state.waitingForUser,
      blockedOnUser:
        blockedTodoShouldPause &&
        hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
    }) === "waiting_user";
  let terminalEmitted = false;
  let aggregatedUsage: HarnessGenAiUsageMetrics | null = null;
  const stateDir = resolvePiStateDir(request.workspace_dir);
  const unsubscribe = handle.session.subscribe((event) => {
    if (event.type === "message_end") {
      aggregatedUsage = mergeHarnessUsageMetrics(
        aggregatedUsage,
        piUsageMetricsFromAssistantMessage(event.message),
      );
    }
    for (const mapped of mapPiEvent(event, handle.sessionFile, state, {
      contextUsage: event.type === "agent_end" ? currentContextUsage() : null,
    })) {
      if (mapped.event_type === "run_completed" || mapped.event_type === "run_failed") {
        const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
        if (usagePayload && !isRecord(mapped.payload.usage) && !isRecord(mapped.payload.token_usage)) {
          mapped.payload.usage = usagePayload;
        }
      }
      if (
        mapped.event_type === "run_completed" &&
        typeof mapped.payload.status === "string" &&
        mapped.payload.status.trim().toLowerCase() !== "waiting_user" &&
        shouldEmitWaitingUser()
      ) {
        mapped.payload.status = resolveHarnessRunStatus({
          waitingForUser: state.waitingForUser,
          blockedOnUser: true,
        });
      }
      if (
        mapped.event_type === "tool_call" &&
        mapped.payload.phase === "completed" &&
        mapped.payload.error !== true &&
        typeof mapped.payload.tool_name === "string" &&
        mapped.payload.tool_name.trim().toLowerCase() === "ask_user_question"
      ) {
        const questionText = summarizeQuestionPrompt(
          (mapped.payload.tool_args as JsonValue | null) ?? null,
          mapped.payload.result
        );
        const detail = questionText
          ? `Blocked waiting for user input: ${questionText}`
          : "Blocked waiting for user input.";
        if (blockedTodoShouldPause) {
          blockActiveHarnessTodoTask({
            stateDir,
            sessionId: request.session_id,
            detail,
          });
        }
      }
      if (mapped.event_type === "run_completed" || mapped.event_type === "run_failed") {
        terminalEmitted = true;
      }
      emitEvent(request, nextSequence(), mapped.event_type, mapped.payload);
    }
  });

  emitEvent(request, nextSequence(), "run_started", {
    ...request.run_started_payload,
    harness_session_id: handle.sessionFile,
    session_setup_ms: sessionSetupMs,
    session_setup_timings_ms: handle.setupTimingsMs ?? {},
  });

  for (const unavailable of handle.unavailableMcpServers ?? []) {
    emitEvent(request, nextSequence(), "mcp_server_unavailable", {
      server_id: unavailable.serverId,
      reason: unavailable.reason,
      missing_tool_ids: unavailable.missingToolIds,
      auth_required: unavailable.authRequired ?? false,
    });
  }

  // The integration equivalent of the loop above. resolveComposioInlineTools has
  // always returned which toolkits it could not resolve, but nothing consumed it,
  // so a failed toolkit was indistinguishable from one the user never connected:
  // the tools were simply absent and no event, log or prompt line said why. That
  // is how a connected integration ends up explained to the user as "still
  // loading" — the agent had no signal and guessed.
  for (const unavailable of handle.unavailableComposioToolkits ?? []) {
    emitEvent(request, nextSequence(), "composio_toolkit_unavailable", {
      toolkit_slug: unavailable.toolkit_slug,
      reason: unavailable.reason,
    });
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;
  if (request.timeout_seconds > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void handle.session.abort().catch(() => {});
    }, request.timeout_seconds * 1000);
  }

  return await runGenAiSpan(
    {
      name: `invoke_agent ${normalizedPiModelId(request) || request.model_id}`,
      op: "gen_ai.invoke_agent",
      attributes: harnessGenAiSpanAttributes({
        operationName: "invoke_agent",
        model: normalizedPiModelId(request) || request.model_id,
        providerId: request.provider_id,
        workspaceId: request.workspace_id,
        sessionId: request.session_id,
        inputId: request.input_id,
        userId: requestDefaultHeaderValue(request, "x-holaboss-user-id"),
        sandboxId: requestDefaultHeaderValue(
          request,
          "x-holaboss-sandbox-id",
        ),
        agentName: "PI Agent",
        thinkingValue: request.thinking_value ?? null,
      }),
    },
    async (span) => {
      try {
        // A resumed session can already be over the provider request-size limit
        // (a browser-heavy run accumulates 100MB+ of full-res screenshots). Prune
        // oversized inline images BEFORE the first request of the turn, so an
        // already-bloated session doesn't 413 on send — and so pi's own overflow
        // compaction, if it fires, has a sendable payload to summarize.
        // LOAD-BEARING — do not remove. The persisted session is never rewritten
        // (append-only JSONL; the finally-path cap below only slims in-memory state,
        // which is discarded when this per-turn process exits), so a resumed turn
        // reloads the original full-res images from disk. This pre-turn re-elision
        // is the only thing that keeps an image-bloated session under the ceiling on
        // every resume; dropping it silently reintroduces the 413 / stuck hang.
        const elidedBeforeTurn = capSessionImageContext(handle.session);
        if (elidedBeforeTurn > 0) {
          console.warn(
            `[pi] elided ${elidedBeforeTurn} oversized inline image(s) from the transcript before this turn to stay under the provider request-size limit`,
          );
        }
        await handle.session.sendUserMessage(await promptContentForRequest(request));
        const retryable = handle.session as unknown as {
          isRetrying?: boolean;
          waitForRetry?: () => Promise<void>;
        };
        const waitForPiRetry = async () => {
          if (retryable.isRetrying && typeof retryable.waitForRetry === "function") {
            try {
              await retryable.waitForRetry();
            } catch {
              // waitForRetry errors are surfaced via the next agent
              // event; nothing to do here.
            }
          }
        };
        // pi-coding-agent's `_handleRetryableError` schedules retries
        // via `setTimeout(agent.continue, 0)` AFTER emitting the
        // current agent_end event. sendUserMessage's promise can
        // resolve before that setTimeout fires, which would tear down
        // the harness mid-retry. Wait for any in-flight retry so the
        // mapper sees the retry's outcome (success → run_completed,
        // auto_retry_end success=false → run_failed). Cast guards the
        // pi version that doesn't expose these (older releases): the
        // optional methods are absent, the if-branch is skipped, and
        // behavior reverts to pre-fix.
        // `waitForRetry` is exposed as a public method on AgentSession
        // but typed `private` in `pi-coding-agent`'s d.ts (declaration
        // bug — the runtime allows access). Cast via unknown to reach
        // it without triggering the visibility check.
        await waitForPiRetry();
        if (!terminalEmitted && state.pendingRetryableFailure) {
          // PI queues retries with setTimeout(..., 0), so give one
          // macrotask turn for `auto_retry_start` / `isRetrying` to
          // materialize before concluding the retry never happened.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          await waitForPiRetry();
        }
        if (!terminalEmitted && state.pendingRetryableFailure) {
          const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
          const pending = state.pendingRetryableFailure;
          state.pendingRetryableFailure = null;
          state.terminalState = "failed";
          terminalEmitted = true;
          emitEvent(request, nextSequence(), "run_failed", {
            ...buildPendingFailureRunFailed(
              pending,
              handle.sessionFile,
              "send_user_message_resolved",
              false,
            ).payload,
            ...(usagePayload ? { usage: usagePayload } : {}),
          });
        }
        if (!terminalEmitted) {
          const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
          emitEvent(request, nextSequence(), "run_completed", {
            status: resolveHarnessRunStatus({
              waitingForUser: state.waitingForUser,
              blockedOnUser:
                blockedTodoShouldPause &&
                hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
            }),
            source: "pi",
            event: "send_user_message_resolved",
            harness_session_id: handle.sessionFile,
            context_usage: currentContextUsage(),
            ...(usagePayload ? { usage: usagePayload } : {}),
          });
        }
        applyHarnessGenAiUsageMetrics(span, aggregatedUsage);
        if (state.terminalState === "failed") {
          span.setAttribute("holaboss.run_status", "failed");
          span.setStatus({ code: 2, message: "internal_error" });
        } else {
          const runStatus = resolveHarnessRunStatus({
            waitingForUser: state.waitingForUser,
            blockedOnUser:
              blockedTodoShouldPause &&
              hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
          });
          span.setAttribute("holaboss.run_status", runStatus);
          span.setStatus({ code: 1, message: "ok" });
        }
        if (state.terminalState !== "failed") {
          // Drive pi's compaction deterministically at end-of-turn. pi's native
          // auto-compaction is fire-and-forget on a queue this per-turn process
          // exits before draining, so we compact explicitly here. Runs after the
          // terminal event; the compacted branch is persisted before we return so
          // the next turn resumes from a smaller session.
          await maybeCompactSessionOverThreshold();
        }
        return 0;
      } catch (error) {
        if (!terminalEmitted) {
          const message = timedOut
            ? `Pi session timed out after ${request.timeout_seconds} seconds`
            : sdkErrorMessage(error, "Pi session failed");
          const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
          emitEvent(request, nextSequence(), "run_failed", {
            type:
              timedOut
                ? "TimeoutError"
                : error instanceof Error && error.name
                  ? error.name
                  : "Error",
            message,
            source: "pi",
            harness_session_id: handle.sessionFile,
            ...(usagePayload ? { usage: usagePayload } : {}),
          });
        }
        applyHarnessGenAiUsageMetrics(span, aggregatedUsage);
        span.setAttribute("holaboss.run_status", "failed");
        span.setStatus({
          code: 2,
          message: timedOut
            ? "deadline_exceeded"
            : error instanceof Error && error.name
              ? error.name
              : "internal_error",
        });
        return 1;
      } finally {
        // Prune oversized inline images on every exit path — including a turn that
        // failed on an oversized request (413). NOTE: this only slims THIS process's
        // in-memory transcript (state.messages) — it does NOT shrink the persisted
        // session. Persistence is append-only (the library never rewrites the JSONL),
        // dispose() does not write state back to disk, and a resumed turn rebuilds
        // state.messages from the persisted JSONL, which still holds the original
        // full-res images. So this call is harmless in-process cleanup only; the
        // durable protection comes from the pre-turn cap above (see line ~3848),
        // which re-elides the reloaded full-res images at the start of every resumed
        // turn. Best-effort; must never throw here.
        try {
          capSessionImageContext(handle.session);
        } catch {
          // cleanup must not mask the turn's real outcome
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        unsubscribe();
        await handle.dispose();
      }
    },
  );
}

function compactionNoOpReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Nothing to compact")) {
    return "nothing_to_compact";
  }
  if (message.includes("Already compacted")) {
    return "already_compacted";
  }
  return null;
}

export async function compactPiSession(
  request: HarnessHostPiRequest,
  deps: PiDeps = defaultPiDeps(),
): Promise<PiCompactionCommandResult> {
  const handle = await deps.createSession(request);
  const session = handle.session as unknown as PiSnapshotPostRunCompactionSession;
  const forceCompaction = request.force_compaction === true;
  const diagnostics = await collectPiCompactionDiagnostics(session);
  let compactionStart: JsonObject | null = null;
  let compactionEnd: JsonObject | null = null;
  let aggregatedUsage: HarnessGenAiUsageMetrics | null = null;
  const unsubscribe = session.subscribe?.((event: AgentSessionEvent) => {
    if (event.type === "message_end") {
      aggregatedUsage = mergeHarnessUsageMetrics(
        aggregatedUsage,
        piUsageMetricsFromAssistantMessage(event.message),
      );
    }
    if (event.type === "compaction_start") {
      compactionStart = summarizeCompactionEvent(event);
      return;
    }
    if (event.type === "compaction_end") {
      compactionEnd = summarizeCompactionEvent(event);
    }
  });
  return await runGenAiSpan(
    {
      name: `compaction ${normalizedPiModelId(request) || request.model_id}`,
      op: "gen_ai.request",
      attributes: harnessGenAiSpanAttributes({
        operationName: "compaction",
        model: normalizedPiModelId(request) || request.model_id,
        providerId: request.provider_id,
        workspaceId: request.workspace_id,
        sessionId: request.session_id,
        inputId: request.input_id,
        userId: requestDefaultHeaderValue(request, "x-holaboss-user-id"),
        sandboxId: requestDefaultHeaderValue(
          request,
          "x-holaboss-sandbox-id",
        ),
        agentName: "PI Compaction",
      }),
    },
    async (span) => {
      try {
        if (!forceCompaction) {
          const maintenanceResult =
            await runSnapshotPostRunMaintenanceCompaction(session);
          applyHarnessGenAiUsageMetrics(span, aggregatedUsage);
          if (maintenanceResult.kind === "compacted") {
            span.setAttribute("holaboss.compaction_result", "compacted");
            span.setStatus({ code: 1, message: "ok" });
            return {
              compacted: true,
              session_file: handle.sessionFile,
              result: maintenanceResult.result,
              reason: null,
              diagnostics: withCompactionEventDiagnostics(
                diagnostics,
                compactionStart,
                compactionEnd,
              ),
              error: null,
            };
          }
          if (maintenanceResult.kind === "not_compacted") {
            const compactionErrorMessage = compactionEnd
              ? optionalTrimmedString(compactionEnd["error_message"])
              : null;
            if (compactionErrorMessage) {
              const error = new Error(compactionErrorMessage);
              error.name = "PiSnapshotCompactionError";
              span.setAttribute("holaboss.compaction_result", "error");
              span.setStatus({ code: 2, message: error.name });
              return {
                compacted: false,
                session_file: handle.sessionFile,
                result: null,
                reason: null,
                diagnostics: withCompactionEventDiagnostics(
                  diagnostics,
                  compactionStart,
                  compactionEnd,
                ),
                error: summarizePiCompactionError(error, compactionEnd),
              };
            }
            span.setAttribute(
              "holaboss.compaction_result",
              maintenanceResult.reason ?? "not_compacted",
            );
            span.setStatus({ code: 1, message: "ok" });
            return {
              compacted: false,
              session_file: handle.sessionFile,
              result: null,
              reason: maintenanceResult.reason,
              diagnostics: withCompactionEventDiagnostics(
                diagnostics,
                compactionStart,
                compactionEnd,
              ),
              error: null,
            };
          }
          if (maintenanceResult.kind === "error") {
            span.setAttribute("holaboss.compaction_result", "error");
            span.setStatus({ code: 2, message: "internal_error" });
            return {
              compacted: false,
              session_file: handle.sessionFile,
              result: null,
              reason: null,
              diagnostics: withCompactionEventDiagnostics(
                diagnostics,
                compactionStart,
                compactionEnd,
              ),
              error: summarizePiCompactionError(
                maintenanceResult.error,
                compactionEnd,
              ),
            };
          }
        }
        const result = await handle.session.compact();
        applyHarnessGenAiUsageMetrics(span, aggregatedUsage);
        span.setAttribute("holaboss.compaction_result", "compacted");
        span.setStatus({ code: 1, message: "ok" });
        return {
          compacted: true,
          session_file: handle.sessionFile,
          result: jsonObject(JSON.parse(JSON.stringify(result)) as Record<string, unknown>),
          reason: null,
          diagnostics: withCompactionEventDiagnostics(
            diagnostics,
            compactionStart,
            compactionEnd,
          ),
          error: null,
        };
      } catch (error) {
        applyHarnessGenAiUsageMetrics(span, aggregatedUsage);
        const reason = compactionNoOpReason(error);
        if (reason) {
          span.setAttribute("holaboss.compaction_result", reason);
          span.setStatus({ code: 1, message: "ok" });
          return {
            compacted: false,
            session_file: handle.sessionFile,
            result: null,
            reason,
            diagnostics: withCompactionEventDiagnostics(
              diagnostics,
              compactionStart,
              compactionEnd,
            ),
            error: null,
          };
        }
        span.setAttribute("holaboss.compaction_result", "error");
        span.setStatus({
          code: 2,
          message: error instanceof Error && error.name ? error.name : "internal_error",
        });
        return {
          compacted: false,
          session_file: handle.sessionFile,
          result: null,
          reason: null,
          diagnostics: withCompactionEventDiagnostics(
            diagnostics,
            compactionStart,
            compactionEnd,
          ),
          error: summarizePiCompactionError(error, compactionEnd),
        };
      } finally {
        unsubscribe?.();
        await handle.dispose();
      }
    },
  );
}
