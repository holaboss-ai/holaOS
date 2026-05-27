import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as Sentry from "@sentry/node";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createFindTool,
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
} from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ResourceDiagnostic } from "@mariozechner/pi-coding-agent";
import { APIError as OpenAIApiError } from "openai";
import { createCallResult, createRuntime, type Runtime as McporterRuntime, type ServerDefinition } from "mcporter";
import { MODELS } from "../node_modules/@mariozechner/pi-ai/dist/models.generated.js";
import {
  DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
  buildHarnessAttachmentFallbackPromptLine,
  buildHarnessAttachmentPromptPath,
  inlineHarnessDocumentAttachmentSection,
  inlineHarnessImageAttachment,
  isHarnessFolderAttachment,
} from "../../harnesses/src/attachment-content.js";
import {
  buildHarnessTodoResumeInstruction,
  applyHarnessTodoResumeInstruction,
  buildHarnessSkillMetadataByAlias,
  buildHarnessMcpServerBindings,
  buildHarnessMcpToolName,
  createHarnessWorkspaceBoundaryPolicy,
  blockActiveHarnessTodoTask,
  createHarnessSkillToolDefinition,
  createHarnessTodoToolDefinitions,
  discoverHarnessMcpTools,
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
  resolveHarnessModelProfile,
  resolveHarnessRuntimeToolDefinitions,
  resolveHarnessRunStatus,
  summarizeHarnessQuestionPrompt,
  buildHarnessSkillInvocationEndPayload,
  buildHarnessSkillInvocationStartPayload,
  createHarnessSkillWideningState,
  wrapToolWithHarnessSkillWidening,
  workspaceBoundaryOverrideRequested as workspaceBoundaryOverrideRequestedFromHarness,
  workspaceBoundaryViolationForToolCall as workspaceBoundaryViolationForHarnessToolCall,
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
  type HarnessGenAiUsageMetrics,
} from "./harness-ai-monitoring.js";
import { resolvePiWebSearchToolDefinitions } from "./pi-web-search.js";

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
};

export interface PiSessionHandle {
  session: AgentSession;
  sessionFile: string;
  mcpToolMetadata: Map<string, PiMcpToolMetadata>;
  skillMetadataByAlias: Map<string, PiSkillMetadata>;
  unavailableMcpServers?: PiMcpServerUnavailableInfo[];
  dispose: () => Promise<void>;
}

export interface PiDeps {
  createSession: (request: HarnessHostPiRequest) => Promise<PiSessionHandle>;
}

const EMBEDDED_SKILLS_DIR_ENV = "HOLABOSS_EMBEDDED_SKILLS_DIR";

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
const PI_REQUEST_TOOL_NAME_ALIASES: Record<string, string> = {
  find: "glob",
  ls: "list",
};
const PI_MCP_DISCOVERY_RETRY_INTERVAL_MS = 250;
const PI_FALLBACK_CONTEXT_WINDOW = 65_536;
const PI_FALLBACK_MAX_TOKENS = 8_192;
const PI_COMPACTION_USAGE_THRESHOLD_RATIO = 0.7;
const PI_WORKSPACE_SKILLS_RELATIVE_PATH = "skills";

const PI_MODEL_CATALOG = MODELS as Record<string, Record<string, HarnessCatalogModelEntry>>;
const PI_MCP_DISCOVERY_MAX_WAIT_MS = 10000;
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

function resolveAttachmentAbsolutePath(request: HarnessHostPiRequest, attachment: PiAttachment): string {
  const policy = createWorkspaceBoundaryPolicy(request.workspace_dir, false);
  const resolved = resolvePathWithinHarnessWorkspace(policy, attachment.workspace_path);
  if (!resolved) {
    throw new Error(
      `Attachment '${attachment.name}' resolves outside workspace boundary: ${attachment.workspace_path}`
    );
  }
  return resolved;
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

const IMAGE_URL_FETCH_TIMEOUT_MS = 15_000;
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
        createWorkspaceBoundaryPolicy(request.workspace_dir, false),
        fileURLToPath(parsed),
      );
      if (resolvedPath) {
        const relativePath = path.relative(request.workspace_dir, resolvedPath).replace(/\\/g, "/");
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
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
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
    createWorkspaceBoundaryPolicy(request.workspace_dir, false),
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
  const relativePath = path.relative(request.workspace_dir, absolutePath).replace(/\\/g, "/");
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
    return {
      type: "image",
      data: bytes.toString("base64"),
      mimeType,
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

  const todoResumeInstruction = buildHarnessTodoResumeInstruction({
    hasRequestedSessionFile: Boolean(resolveRequestedSessionFile(request)),
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
      const image = inlineHarnessImageAttachment({
        attachment,
        absolutePath,
      });
      if (image) {
        images.push(image);
        imageLines.push(`- ${attachment.name} (${attachment.mime_type}) at ${promptPath}`);
        continue;
      }
    }

    const textSection = await inlineHarnessDocumentAttachmentSection({
      attachment,
      absolutePath,
      promptPath,
    });
    if (textSection) {
      sections.push(textSection);
      continue;
    }

    fallbackLines.push(buildHarnessAttachmentFallbackPromptLine(attachment, promptPath));
  }

  for (const [index, imageUrl] of imageUrls.entries()) {
    const promptLabel = imageUrlPromptLabel(imageUrl, index, request);
    const image = await inlineImageUrlInput(request, imageUrl);
    if (image) {
      images.push(image);
      imageUrlLines.push(`- ${promptLabel}`);
      continue;
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
      const packageEntry = require.resolve("@mariozechner/pi-coding-agent");
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

function directoryExists(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function piRuntimeRootDir(): string {
  const configured = optionalTrimmedString(process.env.HOLABOSS_RUNTIME_ROOT);
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function resolveEmbeddedPiSkillDirs(): string[] {
  const override = optionalTrimmedString(process.env[EMBEDDED_SKILLS_DIR_ENV]);
  const candidateRoots = override
    ? [path.resolve(override)]
    : [
        path.join(piRuntimeRootDir(), "harnesses", "src", "embedded-skills"),
        path.join(piRuntimeRootDir(), "runtime", "harnesses", "src", "embedded-skills"),
      ];
  const discoveredSkillDirs: string[] = [];

  for (const candidateRoot of candidateRoots) {
    if (!directoryExists(candidateRoot)) {
      continue;
    }
    const entries = fs
      .readdirSync(candidateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(candidateRoot, entry.name))
      .map((skillDir) => {
        try {
          return fs.realpathSync(skillDir);
        } catch {
          return null;
        }
      })
      .filter((skillDir): skillDir is string => Boolean(skillDir))
      .filter((skillDir) => fs.existsSync(path.join(skillDir, "SKILL.md")))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
    discoveredSkillDirs.push(...entries);
  }

  return resolveHarnessWorkspaceSkillDirs(discoveredSkillDirs);
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
    ...resolveEmbeddedPiSkillDirs(),
    ...resolveWorkspaceLocalPiSkillDirs(request.workspace_dir),
    ...request.workspace_skill_dirs,
  ]);
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

function effectiveSystemPromptForRequest(request: HarnessHostPiRequest): string {
  return applyHarnessTodoResumeInstruction(request.system_prompt, {
    hasRequestedSessionFile: Boolean(resolveRequestedSessionFile(request)),
    stateDir: resolvePiStateDir(request.workspace_dir),
    sessionId: request.session_id,
  });
}

function summarizeQuestionPrompt(args: JsonValue | null, result: unknown): string | null {
  return summarizeHarnessQuestionPrompt(args, result);
}

export function createPiTodoToolDefinitions(params: { stateDir: string; sessionId: string }): ToolDefinition[] {
  return createHarnessTodoToolDefinitions(params) as unknown as ToolDefinition[];
}

function resolvePathWithinWorkspace(
  policy: Pick<PiWorkspaceBoundaryPolicy, "workspaceDir" | "workspaceRealDir">,
  candidate: string
): string | null {
  return resolvePathWithinHarnessWorkspace(policy, candidate);
}

export function workspaceBoundaryOverrideRequested(instruction: string): boolean {
  return workspaceBoundaryOverrideRequestedFromHarness(instruction);
}

function createWorkspaceBoundaryPolicy(workspaceDir: string, overrideRequested: boolean): PiWorkspaceBoundaryPolicy {
  return createHarnessWorkspaceBoundaryPolicy(workspaceDir, overrideRequested);
}


export function workspaceBoundaryViolationForToolCall(params: {
  toolName: string;
  toolParams: unknown;
  policy: PiWorkspaceBoundaryPolicy;
}): string | null {
  return workspaceBoundaryViolationForHarnessToolCall(params);
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

function wrapToolWithWorkspaceBoundary<TTool extends { name: string; execute: (...args: any[]) => Promise<any> }>(
  tool: TTool,
  policy: PiWorkspaceBoundaryPolicy
): TTool {
  const originalExecute = tool.execute.bind(tool);
  const wrapped: TTool = {
    ...tool,
    execute: (async (...args: any[]) => {
      const toolParams = args[1];
      const violation = workspaceBoundaryViolationForToolCall({
        toolName: tool.name,
        toolParams,
        policy,
      });
      if (violation) {
        throw new Error(
          `permission denied by workspace boundary policy: ${violation}. Ask the user to explicitly insist if outside-workspace access is required.`
        );
      }
      return await originalExecute(...args);
    }) as TTool["execute"],
  };
  return wrapped;
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
  const bindings = buildPiMcpServerBindings(request);
  if (bindings.length === 0) {
    return {
      runtime: null,
      customTools: [],
      mcpToolMetadata: new Map(),
      unavailableServers: [],
    };
  }

  const runtime = await createRuntime({
    servers: bindings.map((binding) => binding.definition),
    rootDir: request.workspace_dir,
    clientInfo: {
      name: PI_HARNESS_CLIENT_NAME,
      version: PI_HARNESS_CLIENT_VERSION,
    },
  });
  try {
    const customTools = await createPiMcpCustomTools(request, runtime, bindings);
    return {
      runtime,
      customTools: customTools.customTools,
      mcpToolMetadata: customTools.mcpToolMetadata,
      unavailableServers: customTools.unavailableServers,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

export async function createPiMcpCustomTools(
  request: HarnessHostPiRequest,
  runtime: McporterRuntime,
  bindings: PiMcpServerBinding[] = buildPiMcpServerBindings(request)
): Promise<Omit<PiMcpToolset, "runtime">> {
  const customTools: ToolDefinition[] = [];
  const mcpToolMetadata = new Map<string, PiMcpToolMetadata>();

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
    customTools.push(
      createPiMcpToolDefinition({
        runtime,
        binding,
        tool: {
          toolName: tool.toolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          timeoutMs: tool.timeoutMs,
        },
        metadata,
      }),
    );
    mcpToolMetadata.set(metadata.piToolName, metadata);
  }

  return {
    customTools,
    mcpToolMetadata,
    unavailableServers: failures.map((failure) => ({
      serverId: failure.serverId,
      reason: failure.reason,
      missingToolIds: failure.missingToolIds,
    })),
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
    modelCatalog: PI_MODEL_CATALOG,
    fallbackBudget: {
      contextWindow: PI_FALLBACK_CONTEXT_WINDOW,
      maxTokens: PI_FALLBACK_MAX_TOKENS,
    },
  });
}

function configurePiPromptCacheRetention(request: HarnessHostPiRequest): () => void {
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

export function buildPiProviderConfig(request: HarnessHostPiRequest) {
  const profile = resolvePiModelProfile(request);

  return {
    baseUrl: profile.baseUrl,
    apiKey: request.model_client.api_key,
    api: profile.api,
    headers: profile.headers,
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
  const alias = PI_REQUEST_TOOL_NAME_ALIASES[normalizedToolName];
  return alias ? requestedTools[alias] === true : false;
}

export function filterPiToolDefinitionsForRequest<TTool extends { name: string }>(
  request: Pick<HarnessHostPiRequest, "tools">,
  tools: readonly TTool[],
): TTool[] {
  return tools.filter((tool) => toolEnabledForPiRequest(request, tool.name));
}

async function defaultCreateSession(request: HarnessHostPiRequest): Promise<PiSessionHandle> {
  const stateDir = resolvePiStateDir(request.workspace_dir);
  const sessionDir = resolvePiSessionDir(request.workspace_dir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

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
    ...(requestedThinkingBudgets
      ? { thinkingBudgets: requestedThinkingBudgets }
      : {}),
  });
  const skillDirs = resolvePiSkillDirs(request);
  const loadedSkills = loadPiSkills(skillDirs);
  const skillMetadataByAlias = buildPiSkillMetadataByAlias(loadedSkills.skills);
  const todoTools = filterPiToolDefinitionsForRequest(request, createPiTodoToolDefinitions({
    stateDir,
    sessionId: request.session_id,
  }));
  const browserTools = request.browser_tools_enabled
    ? filterPiToolDefinitionsForRequest(
        request,
        await resolveHarnessDesktopBrowserToolDefinitions({
          runtimeApiBaseUrl: request.runtime_api_base_url,
          workspaceId: request.workspace_id,
          sessionId: request.session_id,
          inputId: request.input_id,
          space: request.browser_space ?? undefined,
        })
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
    skillsOverride: () => loadedSkills,
    systemPromptOverride: () => effectiveSystemPromptForRequest(request),
  });
  await resourceLoader.reload();

  const persistedSessionFile = resolveRequestedSessionFile(request);
  const sessionManager = persistedSessionFile
    ? SessionManager.open(persistedSessionFile)
    : SessionManager.create(request.workspace_dir, sessionDir);
  const mcpToolset = await createPiMcpToolset(request);
  const runtimeTools = filterPiToolDefinitionsForRequest(
    request,
    await resolveHarnessRuntimeToolDefinitions({
      runtimeApiBaseUrl: request.runtime_api_base_url,
      workspaceId: request.workspace_id,
      sessionId: request.session_id,
      inputId: request.input_id,
      selectedModel: `${request.provider_id}/${request.model_id}`,
    })
  );
  const webSearchTools = toolEnabledForPiRequest(request, "web_search")
    ? await resolvePiWebSearchToolDefinitions()
    : [];
  const baseTools = filterPiToolDefinitionsForRequest(request, [
    ...createCodingTools(request.workspace_dir),
    createGrepTool(request.workspace_dir),
    createFindTool(request.workspace_dir),
    createLsTool(request.workspace_dir),
  ]);
  const nonSkillCustomTools: ToolDefinition[] = [
    ...todoTools,
    ...(browserTools as unknown as ToolDefinition[]),
    ...(runtimeTools as unknown as ToolDefinition[]),
    ...webSearchTools,
    ...filterPiToolDefinitionsForRequest(request, mcpToolset.customTools),
  ];
  const availableToolNames = [...baseTools, ...nonSkillCustomTools].map((tool) => tool.name);
  const availableCommandIds = workspaceCommandIdsFromRunStartedPayload(request.run_started_payload);
  const workspaceBoundaryPolicy = createWorkspaceBoundaryPolicy(
    request.workspace_dir,
    workspaceBoundaryOverrideRequested(request.instruction)
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
  const tools = baseTools.map((tool) =>
    wrapToolWithWorkspaceBoundary(wrapToolWithSkillWidening(tool, skillWideningState), workspaceBoundaryPolicy)
  );
  const customTools = [
    ...nonSkillCustomTools.map((tool) =>
      wrapToolWithWorkspaceBoundary(wrapToolWithSkillWidening(tool, skillWideningState), workspaceBoundaryPolicy)
    ),
    ...skillTools.map((tool) => wrapToolWithWorkspaceBoundary(tool, workspaceBoundaryPolicy)),
  ];

  const restorePromptCacheRetention = configurePiPromptCacheRetention(request);
  let session: AgentSession;
  try {
    ({ session } = await createAgentSession({
      cwd: request.workspace_dir,
      agentDir: stateDir,
      authStorage,
      modelRegistry,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      tools,
      customTools,
    }));
  } catch (error) {
    restorePromptCacheRetention();
    await mcpToolset.runtime?.close();
    throw error;
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
  state.terminalState = "failed";
  const failureMessage = normalizeAssistantFailureMessage(message.errorMessage, message.content, stopReason);
  return [
    {
      event_type: "run_failed",
      payload: {
        type: stopReason === "aborted" ? "AbortError" : "ProviderError",
        message: failureMessage,
        stop_reason: stopReason,
        provider: optionalTrimmedString(message.provider) ?? null,
        model: optionalTrimmedString(message.model) ?? null,
        event: event.type,
        source: "pi",
        harness_session_id: sessionFile,
      },
    },
  ];
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
  };
}

export function mapPiSessionEvent(event: AgentSessionEvent, sessionFile: string, state: PiEventMapperState): PiMappedEvent[] {
  return mapPiEvent(event, sessionFile, state);
}

function defaultPiDeps(): PiDeps {
  return {
    createSession: defaultCreateSession,
  };
}

function suppressPiPostRunAutoCompaction(session: AgentSession): void {
  const internalSession = session as unknown as PiInternalCompactionSession;
  const originalCheckCompaction = internalSession._checkCompaction;
  if (typeof originalCheckCompaction !== "function") {
    return;
  }

  internalSession._checkCompaction = async function (
    assistantMessage: unknown,
    skipAbortedCheck = true,
  ): Promise<void> {
    // PI uses `_checkCompaction(msg)` after `agent_end` and `_checkCompaction(msg, false)`
    // before the next prompt submission. We suppress only the post-run maintenance path and
    // keep the pre-prompt safety check intact so the next run can still recover if needed.
    if (skipAbortedCheck !== false) {
      return;
    }
    await originalCheckCompaction.call(this, assistantMessage, skipAbortedCheck);
  };
}

export async function runPi(request: HarnessHostPiRequest, deps: PiDeps = defaultPiDeps()): Promise<number> {
  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };

  const handle = await deps.createSession(request);
  suppressPiPostRunAutoCompaction(handle.session);
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
  const state = createPiEventMapperState(handle.mcpToolMetadata, handle.skillMetadataByAlias);
  const shouldEmitWaitingUser = () =>
    resolveHarnessRunStatus({
      waitingForUser: state.waitingForUser,
      blockedOnUser: hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
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
        mapped.payload.tool_name.trim().toLowerCase() === "question"
      ) {
        const questionText = summarizeQuestionPrompt(
          (mapped.payload.tool_args as JsonValue | null) ?? null,
          mapped.payload.result
        );
        const detail = questionText
          ? `Blocked waiting for user input: ${questionText}`
          : "Blocked waiting for user input.";
        blockActiveHarnessTodoTask({
          stateDir,
          sessionId: request.session_id,
          detail,
        });
      }
      if (mapped.event_type === "run_completed" || mapped.event_type === "run_failed") {
        terminalEmitted = true;
      }
      emitRunnerEvent(request, nextSequence(), mapped.event_type, mapped.payload);
    }
  });

  emitRunnerEvent(request, nextSequence(), "run_started", {
    ...request.run_started_payload,
    harness_session_id: handle.sessionFile,
  });

  for (const unavailable of handle.unavailableMcpServers ?? []) {
    emitRunnerEvent(request, nextSequence(), "mcp_server_unavailable", {
      server_id: unavailable.serverId,
      reason: unavailable.reason,
      missing_tool_ids: unavailable.missingToolIds,
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

  return await Sentry.startSpan(
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
        await handle.session.sendUserMessage(await promptContentForRequest(request));
        if (!terminalEmitted) {
          const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
          emitRunnerEvent(request, nextSequence(), "run_completed", {
            status: resolveHarnessRunStatus({
              waitingForUser: state.waitingForUser,
              blockedOnUser: hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
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
            blockedOnUser: hasBlockedPersistedHarnessTodoState(stateDir, request.session_id),
          });
          span.setAttribute("holaboss.run_status", runStatus);
          span.setStatus({ code: 1, message: "ok" });
        }
        return 0;
      } catch (error) {
        if (!terminalEmitted) {
          const message = timedOut
            ? `Pi session timed out after ${request.timeout_seconds} seconds`
            : sdkErrorMessage(error, "Pi session failed");
          const usagePayload = tokenUsagePayloadFromHarnessUsage(aggregatedUsage);
          emitRunnerEvent(request, nextSequence(), "run_failed", {
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
  return await Sentry.startSpan(
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
