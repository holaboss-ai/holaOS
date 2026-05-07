import {
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  Fragment,
  FormEvent,
  KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  CornerDownLeft,
  Copy,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  Globe,
  Image as ImageIcon,
  Inbox,
  Bot,
  LayoutDashboard,
  Lightbulb,
  Link2,
  Loader2,
  ListTree,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Zap,
  Square,
  Waypoints,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { PaneCard } from "@/components/ui/PaneCard";
import { BackgroundTasksPane } from "@/components/panes/BackgroundTasksPane";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import {
  EXPLORER_ATTACHMENT_DRAG_TYPE,
  type ExplorerAttachmentDragPayload,
  parseExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "@/lib/attachmentDrag";
import { getExplorerAttachmentClipboardEntry } from "@/lib/appClipboard";
import { CHAT_LAYOUT, chatScrollMaskImage } from "@/lib/chatLayout";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import {
  DEFAULT_RUNTIME_MODEL,
  useDesktopAuthSession,
} from "@/lib/auth/authClient";
import { useDesktopBilling } from "@/lib/billing/useDesktopBilling";
import {
  pushRendererSentryActivity,
  useRendererSentrySection,
} from "@/lib/rendererSentry";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import * as modelCatalog from "../../../shared/model-catalog.js";

type ChatAttachment = SessionInputAttachmentPayload;
type ChatPaneVariant = "default" | "onboarding";
const MAIN_SESSION_EVENT_BATCH_HEADER =
  "[Holaboss Main Session Event Batch v1]";
const BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE =
  "Background update delayed. Retrying automatically.";

export type ChatAssistantSegment =
  | {
      kind: "execution";
      items: ChatExecutionTimelineItem[];
    }
  | {
      kind: "output";
      text: string;
      tone?: "default" | "error";
    };

const EMPTY_ATTACHMENTS: ChatAttachment[] = [];
const EMPTY_SEGMENTS: ChatAssistantSegment[] = [];
const EMPTY_EXECUTION_ITEMS: ChatExecutionTimelineItem[] = [];
const EMPTY_OUTPUTS: WorkspaceOutputRecordPayload[] = [];
const EMPTY_MEMORY_PROPOSALS: MemoryUpdateProposalRecordPayload[] = [];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tone?: "default" | "error";
  createdAt?: string;
  attachments?: ChatAttachment[];
  segments?: ChatAssistantSegment[];
  executionItems?: ChatExecutionTimelineItem[];
  outputs?: WorkspaceOutputRecordPayload[];
  memoryProposals?: MemoryUpdateProposalRecordPayload[];
}

type QueuedSessionInputStatus = "queued" | "sending";

interface QueuedSessionInput {
  inputId: string;
  sessionId: string;
  workspaceId: string;
  text: string;
  createdAt: string;
  attachments: ChatAttachment[];
  status: QueuedSessionInputStatus;
}

interface QueuedSessionInputPreviewDescriptor {
  text: string;
  createdAt?: string;
  attachments?: ChatAttachment[];
  status: QueuedSessionInputStatus;
}

interface ComposerInputRecallSnapshot {
  workspaceId: string;
  text: string;
  at: number;
}

interface PendingOptimisticUserMessage {
  localMessageId: string;
  inputId?: string | null;
  sessionId: string;
  workspaceId: string;
  message: ChatMessage;
}

declare global {
  interface Window {
    __holabossQueuedMessagesPreviewState?: QueuedSessionInputPreviewDescriptor[];
    __holabossDevQueuedMessagesPreview?: {
      single: (text?: string) => void;
      multiple: () => void;
      clear: () => void;
      set: (
        entries:
          | string
          | Array<string | Partial<QueuedSessionInputPreviewDescriptor>>,
      ) => void;
      get: () => QueuedSessionInputPreviewDescriptor[];
    };
  }
}

interface ChatSerializedQuotedSkillBlock {
  skillIds: string[];
  body: string;
}

function initialBrowserState(space: BrowserSpaceId): BrowserTabListPayload {
  return {
    space,
    activeTabId: "",
    tabs: [],
    tabCounts: {
      user: 0,
      agent: 0,
    },
    sessionId: null,
    lifecycleState: null,
    controlMode: "none",
    controlSessionId: null,
  };
}

type ChatTraceStepStatus = "running" | "completed" | "error" | "waiting";

interface ChatTraceStep {
  id: string;
  kind: "phase" | "tool";
  title: string;
  status: ChatTraceStepStatus;
  details: string[];
  order: number;
}

type ChatExecutionTimelineItem =
  | {
      id: string;
      kind: "thinking";
      text: string;
      order: number;
    }
  | {
      id: string;
      kind: "trace_step";
      step: ChatTraceStep;
      order: number;
    };

interface PendingLocalAttachmentFile {
  id: string;
  source: "local-file";
  file: File;
}

interface PendingExplorerAttachmentFile {
  id: string;
  source: "explorer-path";
  absolutePath: string;
  name: string;
  mime_type?: string | null;
  size_bytes: number;
  kind: "image" | "file" | "folder";
}

type PendingAttachment =
  | PendingLocalAttachmentFile
  | PendingExplorerAttachmentFile;

interface AttachmentListItem {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  size_bytes: number;
  workspace_path?: string;
  file?: File;
}

interface ImageAttachmentPreviewState {
  attachment: AttachmentListItem;
  browserSnapshot: BrowserVisibleSnapshotPayload | null;
  dataUrl: string;
  isLoading: boolean;
  errorMessage: string;
}

function attachmentLooksLikeImage(
  name: string,
  mimeType?: string | null,
): boolean {
  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return true;
  }
  return /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp)$/i.test(
    name.trim(),
  );
}

function pendingAttachmentIsImage(attachment: PendingAttachment): boolean {
  if (attachment.source === "local-file") {
    return attachmentLooksLikeImage(attachment.file.name, attachment.file.type);
  }
  return (
    attachment.kind === "image" ||
    attachmentLooksLikeImage(attachment.name, attachment.mime_type)
  );
}

function supportsImageInput(
  inputModalities?: readonly string[] | null,
): boolean {
  if (!Array.isArray(inputModalities) || inputModalities.length === 0) {
    return true;
  }
  return inputModalities.includes("image");
}

function imageInputUnsupportedMessage(modelLabel: string): string {
  const normalizedModelLabel = modelLabel.trim();
  if (!normalizedModelLabel) {
    return "The selected model doesn't support image inputs.";
  }
  return `${normalizedModelLabel} doesn't support image inputs.`;
}

interface ChatModelOption {
  value: string;
  label: string;
  selectedLabel?: string;
  searchText?: string;
  disabled?: boolean;
  statusLabel?: string;
}

interface ChatModelOptionGroup {
  label: string;
  options: ChatModelOption[];
}

interface ChatComposerSlashCommandOption {
  key: string;
  kind: "skill";
  command: string;
  label: string;
  description: string;
  searchText: string;
  skillId: string;
}

interface ChatComposerQuotedSkillItem {
  skillId: string;
  title: string;
}

interface StreamTelemetryEntry {
  id: string;
  at: string;
  streamId: string;
  transportType: string;
  eventName: string;
  eventType: string;
  inputId: string;
  sessionId: string;
  action: string;
  detail: string;
}

export type ArtifactBrowserFilter =
  | "all"
  | "documents"
  | "images"
  | "code"
  | "links"
  | "apps";

const STREAM_ATTACH_PENDING = "__stream_attach_pending__";
const STREAM_TELEMETRY_LIMIT = 240;
const TOOL_TRACE_TERMINAL_PHASES = new Set(["completed", "failed", "error"]);
const CHAT_AUTO_SCROLL_THRESHOLD_PX = 72;
// Drives both the initial session-open fetch and each "load earlier" pull.
// Was 10 originally — small enough that scroll-restoration after a prepend
// often left the user still inside the 96px top threshold, immediately
// triggering the next load. The runtime caps `limit` at 1000 (default 200);
// 50 keeps the per-call work bounded while making any single load earn
// enough vertical content (~25 turns) to push the user well past the
// re-trigger threshold.
const CHAT_HISTORY_PAGE_SIZE = 50;
const CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX = 96;
const COMPOSER_FOOTER_GAP_PX = 8;
const COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX = 240;
const COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX = 88;
const COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX = 320;
const COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX = 168;
const COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX = 56;
const COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX = 124;
const CHAT_MODEL_STORAGE_KEY = "holaboss-chat-model-v1";
const CHAT_THINKING_STORAGE_KEY = "holaboss-chat-thinking-v1";
const CHAT_MODEL_USE_RUNTIME_DEFAULT = "__runtime_default__";
const CHAT_SERIALIZED_SKILL_COMMAND_PATTERN = /^\/([A-Za-z0-9_-]+)$/;
const QUEUED_MESSAGES_PREVIEW_EVENT = "holaboss:queued-messages-preview-change";
const LEGACY_UNAVAILABLE_CHAT_MODELS = new Set(["openai/gpt-5.2-mini"]);
const DEPRECATED_CHAT_MODELS = new Set([
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
]);
const CHAT_MODEL_PRESETS = [
  "openai/gpt-5.1",
  "openai/gpt-5",
  "openai/gpt-5.2",
] as const;
const RUNTIME_MODEL_CAPABILITY_ALIASES: Record<string, string> = {
  chat: "chat",
  text: "chat",
  completion: "chat",
  completions: "chat",
  responses: "chat",
  image: "image_generation",
  images: "image_generation",
  image_generation: "image_generation",
  image_gen: "image_generation",
};

function sessionUserId(
  session: { user?: { id?: string | null } | null } | null | undefined,
): string {
  return session?.user?.id?.trim() || "";
}

function isHolabossProxyModel(model: string) {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("openai/") ||
    normalized.startsWith("google/") ||
    normalized.startsWith("anthropic/") ||
    normalized.startsWith("gpt-") ||
    normalized.startsWith("claude-") ||
    normalized.startsWith("gemini-")
  );
}

function isHolabossProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return (
    normalized === "holaboss_model_proxy" ||
    normalized === "holaboss" ||
    normalized.includes("holaboss")
  );
}

function isDeprecatedChatModel(model: string) {
  return DEPRECATED_CHAT_MODELS.has(model.trim().toLowerCase());
}

function normalizeRuntimeModelCapability(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  return RUNTIME_MODEL_CAPABILITY_ALIASES[normalized] ?? normalized;
}

function runtimeModelCapabilities(model: RuntimeProviderModelPayload) {
  if (!Array.isArray(model.capabilities)) {
    return [];
  }
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const value of model.capabilities) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeRuntimeModelCapability(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    capabilities.push(normalized);
  }
  return capabilities;
}

function runtimeModelHasChatCapability(model: RuntimeProviderModelPayload) {
  const capabilities = runtimeModelCapabilities(model);
  return capabilities.length === 0 || capabilities.includes("chat");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function optionalHistoryLoadErrorMessage(label: string, error: unknown) {
  return `${label} unavailable: ${normalizeErrorMessage(error)}`;
}

function openExternalUrl(url: string | null | undefined) {
  const normalizedUrl = (url ?? "").trim();
  if (!normalizedUrl) {
    return;
  }
  void window.electronAPI.ui.openExternalUrl(normalizedUrl);
}

function normalizeStoredChatModelPreference(value: string | null | undefined) {
  const stored = value?.trim();
  if (!stored) {
    return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  }
  if (LEGACY_UNAVAILABLE_CHAT_MODELS.has(stored.toLowerCase())) {
    return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  }
  return stored;
}

function loadStoredChatModelPreference() {
  try {
    return normalizeStoredChatModelPreference(
      localStorage.getItem(CHAT_MODEL_STORAGE_KEY),
    );
  } catch {
    return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  }
}

function normalizeStoredChatThinkingPreferences(
  value: string | null | undefined,
): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
        .map(([key, rawValue]) => [key.trim(), rawValue.trim()])
        .filter(([key, rawValue]) => Boolean(key) && Boolean(rawValue)),
    );
  } catch {
    return {};
  }
}

function loadStoredChatThinkingPreferences() {
  try {
    return normalizeStoredChatThinkingPreferences(
      localStorage.getItem(CHAT_THINKING_STORAGE_KEY),
    );
  } catch {
    return {};
  }
}

function runtimeModelThinkingValues(model: RuntimeProviderModelPayload) {
  if (!Array.isArray(model.thinkingValues)) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of model.thinkingValues) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function serializeQuotedSkillPrompt(
  input: string,
  quotedSkillIds: string[],
): string {
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

function parseSerializedQuotedSkillPrompt(
  value: string,
): ChatSerializedQuotedSkillBlock {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const skillIds: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }
    const match = CHAT_SERIALIZED_SKILL_COMMAND_PATTERN.exec(line);
    if (!match) {
      return {
        skillIds: [],
        body: normalized.trim(),
      };
    }
    skillIds.push(match[1] ?? "");
    index += 1;
  }

  if (skillIds.length === 0) {
    return {
      skillIds: [],
      body: normalized.trim(),
    };
  }

  if (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    return {
      skillIds: [],
      body: normalized.trim(),
    };
  }

  while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
    index += 1;
  }

  return {
    skillIds: [...new Set(skillIds)],
    body: lines.slice(index).join("\n").trim(),
  };
}

function appendComposerPrefillText(currentInput: string, text: string) {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return currentInput;
  }
  if (!currentInput.trim()) {
    return normalizedText;
  }
  return /[\s(]$/.test(currentInput)
    ? `${currentInput}${normalizedText}`
    : `${currentInput} ${normalizedText}`;
}

function buildComposerSlashCommandOptions(
  skills: WorkspaceSkillRecordPayload[],
): ChatComposerSlashCommandOption[] {
  return skills
    .map((skill) => ({
      key: `skill:${skill.skill_id}`,
      kind: "skill" as const,
      command: `/${skill.skill_id}`,
      label: skill.title,
      description: skill.summary,
      searchText:
        `${skill.skill_id} ${skill.title} ${skill.summary}`.toLowerCase(),
      skillId: skill.skill_id,
    }))
    .sort((left, right) => left.command.localeCompare(right.command));
}

function findActiveSlashCommandRange(
  value: string,
  caretIndex: number,
): { start: number; end: number; query: string } | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }
  const prefix = value.slice(0, caretIndex);
  const whitespaceBoundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\t"),
  );
  const start = whitespaceBoundary + 1;
  const rawToken = prefix.slice(start);
  if (!rawToken.startsWith("/") || rawToken.length === 0) {
    return null;
  }
  if (!/^\/[A-Za-z0-9_-]*$/.test(rawToken)) {
    return null;
  }
  return {
    start,
    end: caretIndex,
    query: rawToken.slice(1).toLowerCase(),
  };
}

function removeSlashCommandText(
  value: string,
  range: { start: number; end: number },
): { value: string; caretIndex: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const nextValue =
    before.endsWith(" ") && after.startsWith(" ")
      ? `${before}${after.slice(1)}`
      : `${before}${after}`;
  return {
    value: nextValue,
    caretIndex: before.length,
  };
}

function displayModelLabel(model: string) {
  const trimmed = model.trim();
  if (!trimmed) {
    return "Unknown model";
  }

  const withoutProvider = trimmed.replace(/^(openai|anthropic)\//i, "");
  const sonnetModelMatch = withoutProvider.match(
    /^claude-sonnet-(\d+)-(\d+)$/i,
  );
  if (sonnetModelMatch) {
    return `Claude Sonnet ${sonnetModelMatch[1]}.${sonnetModelMatch[2]}`;
  }

  if (/^gpt-/i.test(withoutProvider)) {
    return withoutProvider
      .replace(/^gpt-/i, "GPT-")
      .replace(/-mini\b/gi, " Mini")
      .replace(/-codex\b/gi, " Codex")
      .replace(/-max\b/gi, " Max")
      .replace(/-spark\b/gi, " Spark");
  }

  return withoutProvider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      /^\d+(\.\d+)?$/.test(part)
        ? part
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function compactComposerModelLabel(label: string) {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) {
    return "Model";
  }

  const autoMatch = normalizedLabel.match(/^Auto \((.+)\)$/i);
  if (autoMatch?.[1]) {
    return autoMatch[1].trim();
  }

  const segments = normalizedLabel
    .split("·")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] ?? normalizedLabel;
}

function displayThinkingValueLabel(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return "Thinking";
  }

  if (normalizedValue === "xhigh") {
    return "Extra High";
  }
  if (
    normalizedValue === "none" ||
    normalizedValue === "minimal" ||
    normalizedValue === "low" ||
    normalizedValue === "medium" ||
    normalizedValue === "high" ||
    normalizedValue === "max"
  ) {
    return `${normalizedValue[0]?.toUpperCase() ?? ""}${normalizedValue.slice(1)}`;
  }
  if (/^-?\d+$/.test(normalizedValue)) {
    return Number(normalizedValue).toLocaleString();
  }
  return normalizedValue
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function runtimeModelDisplayLabel(model: RuntimeProviderModelPayload) {
  return model.label?.trim() || displayModelLabel(model.modelId || model.token);
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mimeType =
    typeof value.mime_type === "string" ? value.mime_type.trim() : "";
  const workspacePath =
    typeof value.workspace_path === "string" ? value.workspace_path.trim() : "";
  const sizeBytes =
    typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes)
      ? value.size_bytes
      : 0;
  const kind =
    value.kind === "image"
      ? "image"
      : value.kind === "folder"
        ? "folder"
        : value.kind === "file"
          ? "file"
          : mimeType.startsWith("image/")
            ? "image"
            : "file";

  if (!id || !name || !mimeType || !workspacePath) {
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

export function attachmentsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ChatAttachment[] {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => normalizeChatAttachment(item))
    .filter((item): item is ChatAttachment => Boolean(item));
}

function hasRenderableMessageContent(
  text: string,
  attachments: ChatAttachment[],
) {
  return Boolean(text.trim()) || attachments.length > 0;
}

function isMainSessionEventBatchInstructionPreview(
  value: string | null | undefined,
) {
  return (value || "").trim().startsWith(MAIN_SESSION_EVENT_BATCH_HEADER);
}

function hasRenderableAssistantTurn(
  message: ChatMessage,
  options?: { showExecutionInternals?: boolean },
) {
  const showExecutionInternals = options?.showExecutionInternals ?? true;
  const hasVisibleOutputSegment =
    message.segments?.some(
      (segment) =>
        segment.kind === "output" && Boolean(segment.text.trim()),
    ) ?? false;
  const hasExecutionOnlyContent =
    (message.segments?.some(
      (segment) => segment.kind === "execution" && segment.items.length > 0,
    ) ??
      false) ||
    (message.executionItems?.length ?? 0) > 0;
  return (
    hasRenderableMessageContent(message.text, message.attachments ?? []) ||
    hasVisibleOutputSegment ||
    (showExecutionInternals && hasExecutionOnlyContent) ||
    (message.outputs?.length ?? 0) > 0 ||
    (message.memoryProposals?.length ?? 0) > 0
  );
}

function appendAssistantOutputSegment(
  segments: ChatAssistantSegment[],
  text: string,
  tone: ChatMessage["tone"] = "default",
): ChatAssistantSegment[] {
  if (!text) {
    return segments;
  }
  const next = [...segments];
  const previous = next[next.length - 1];
  if (previous?.kind === "output" && (previous.tone ?? "default") === tone) {
    next[next.length - 1] = {
      ...previous,
      text: `${previous.text}${text}`,
    };
    return next;
  }
  next.push({
    kind: "output",
    text,
    tone,
  });
  return next;
}

function appendAssistantExecutionSegment(
  segments: ChatAssistantSegment[],
  items: ChatExecutionTimelineItem[],
): ChatAssistantSegment[] {
  if (items.length === 0) {
    return segments;
  }
  return [
    ...segments,
    {
      kind: "execution",
      items,
    },
  ];
}

function upsertAssistantExecutionTraceStep(
  segments: ChatAssistantSegment[],
  step: ChatTraceStep,
): ChatAssistantSegment[] | null {
  const existingSegmentIndex = [...segments]
    .reverse()
    .findIndex(
      (segment) =>
        segment.kind === "execution" &&
        segment.items.some(
          (item) => item.kind === "trace_step" && item.step.id === step.id,
        ),
    );
  if (existingSegmentIndex < 0) {
    return null;
  }

  const targetIndex = segments.length - existingSegmentIndex - 1;
  return segments.map((segment, index) =>
    index === targetIndex && segment.kind === "execution"
      ? {
          ...segment,
          items: upsertExecutionTimelineTraceItem(segment.items, step),
        }
      : segment,
  );
}

function finalizeAssistantExecutionSegments(
  segments: ChatAssistantSegment[],
  status: Extract<ChatTraceStepStatus, "completed" | "error" | "waiting">,
): ChatAssistantSegment[] {
  return segments.map((segment) =>
    segment.kind === "execution"
      ? {
          ...segment,
          items: finalizeExecutionTimelineTraceItems(segment.items, status),
        }
      : segment,
  );
}

function liveAssistantSegmentsForRender(
  segments: ChatAssistantSegment[],
  executionItems: ChatExecutionTimelineItem[],
  text: string,
) {
  let next = segments;
  if (executionItems.length > 0) {
    next = appendAssistantExecutionSegment(next, executionItems);
  }
  if (text) {
    next = appendAssistantOutputSegment(next, text, "default");
  }
  return next;
}

function assistantSegmentsIncludeOutput(segments: ChatAssistantSegment[]) {
  return segments.some(
    (segment) => segment.kind === "output" && Boolean(segment.text.trim()),
  );
}

export function chatMessagesFromSessionState(params: {
  historyMessages: SessionHistoryMessagePayload[];
  outputEvents: SessionOutputEventPayload[];
  outputs: WorkspaceOutputRecordPayload[];
  memoryProposals: MemoryUpdateProposalRecordPayload[];
  knownAssistantInputIds?: Set<string>;
  showExecutionInternals: boolean;
}): ChatMessage[] {
  const outputEventsByInputId = new Map<
    string,
    SessionOutputEventPayload[]
  >();
  const outputsByInputId = new Map<string, WorkspaceOutputRecordPayload[]>();
  const memoryProposalsByInputId = new Map<
    string,
    MemoryUpdateProposalRecordPayload[]
  >();
  for (const event of params.outputEvents) {
    const inputId = event.input_id.trim();
    if (!inputId) {
      continue;
    }
    const existing = outputEventsByInputId.get(inputId);
    if (existing) {
      existing.push(event);
    } else {
      outputEventsByInputId.set(inputId, [event]);
    }
  }
  for (const output of params.outputs) {
    const inputId = (output.input_id || "").trim();
    if (!inputId) {
      continue;
    }
    const existing = outputsByInputId.get(inputId);
    if (existing) {
      existing.push(output);
    } else {
      outputsByInputId.set(inputId, [output]);
    }
  }
  for (const proposal of params.memoryProposals) {
    const inputId = proposal.input_id.trim();
    if (!inputId) {
      continue;
    }
    const existing = memoryProposalsByInputId.get(inputId);
    if (existing) {
      existing.push(proposal);
    } else {
      memoryProposalsByInputId.set(inputId, [proposal]);
    }
  }

  const assistantHistoryInputIds = new Set(params.knownAssistantInputIds ?? []);
  for (const message of params.historyMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    const inputId = inputIdFromMessageId(message.id, "assistant");
    if (inputId) {
      assistantHistoryInputIds.add(inputId);
    }
  }

  return params.historyMessages
    .flatMap((message) => {
      const attachments = attachmentsFromMetadata(message.metadata);
      const nextMessage: ChatMessage = {
        id: message.id || `history-${message.created_at ?? crypto.randomUUID()}`,
        role: message.role as ChatMessage["role"],
        text: message.text,
        createdAt: message.created_at || undefined,
        attachments,
      };
      const renderedMessages: ChatMessage[] = [nextMessage];

      if (nextMessage.role === "assistant") {
        const inputId = inputIdFromMessageId(nextMessage.id, "assistant");
        if (inputId) {
          const restoredAssistantState = assistantHistoryStateFromOutputEvents(
            outputEventsByInputId.get(inputId) ?? [],
          );
          const turnOutputs = sortOutputs(outputsByInputId.get(inputId) ?? []);
          const turnMemoryProposals = sortMemoryUpdateProposals(
            memoryProposalsByInputId.get(inputId) ?? [],
          );
          if (restoredAssistantState.segments) {
            nextMessage.segments = restoredAssistantState.segments;
            nextMessage.text = "";
            nextMessage.executionItems = undefined;
          } else if (restoredAssistantState.executionItems) {
            nextMessage.executionItems = restoredAssistantState.executionItems;
          }
          if (
            !nextMessage.text &&
            !nextMessage.segments &&
            restoredAssistantState.failureText
          ) {
            nextMessage.text = restoredAssistantState.failureText;
            nextMessage.tone = "error";
          }
          if (turnMemoryProposals.length > 0) {
            nextMessage.memoryProposals = turnMemoryProposals;
          }
          if (turnOutputs.length > 0) {
            nextMessage.outputs = turnOutputs;
          }
        }
      }

      const userInputId =
        nextMessage.role === "user"
          ? inputIdFromMessageId(nextMessage.id, "user")
          : "";
      if (
        nextMessage.role === "user" &&
        userInputId &&
        !assistantHistoryInputIds.has(userInputId)
      ) {
        const restoredAssistantState = assistantHistoryStateFromOutputEvents(
          outputEventsByInputId.get(userInputId) ?? [],
        );
        const turnOutputs = sortOutputs(outputsByInputId.get(userInputId) ?? []);
        const turnMemoryProposals = sortMemoryUpdateProposals(
          memoryProposalsByInputId.get(userInputId) ?? [],
        );
        const syntheticAssistantMessage: ChatMessage = {
          id: `assistant-${userInputId}`,
          role: "assistant",
          text:
            restoredAssistantState.segments ||
            !restoredAssistantState.failureText
              ? ""
              : restoredAssistantState.failureText,
          tone:
            restoredAssistantState.segments ||
            !restoredAssistantState.failureText
              ? "default"
              : "error",
          createdAt:
            restoredAssistantState.terminalCreatedAt || nextMessage.createdAt,
          segments: restoredAssistantState.segments,
          executionItems: restoredAssistantState.segments
            ? undefined
            : restoredAssistantState.executionItems,
          outputs: turnOutputs.length > 0 ? turnOutputs : undefined,
          memoryProposals:
            turnMemoryProposals.length > 0 ? turnMemoryProposals : undefined,
        };
        if (
          hasRenderableAssistantTurn(syntheticAssistantMessage, {
            showExecutionInternals: params.showExecutionInternals,
          })
        ) {
          renderedMessages.push(syntheticAssistantMessage);
        }
      }

      return renderedMessages;
    })
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        (message.role === "assistant"
          ? hasRenderableAssistantTurn(message, {
              showExecutionInternals: params.showExecutionInternals,
            })
          : hasRenderableMessageContent(message.text, message.attachments ?? [])),
    );
}

function formatAttachmentSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function outputMetadataString(
  output: WorkspaceOutputRecordPayload,
  key: string,
) {
  const value = output.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function outputMetadataNumber(
  output: WorkspaceOutputRecordPayload,
  key: string,
) {
  const value = output.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function outputBrowserFilterForOutput(
  output: WorkspaceOutputRecordPayload,
): ArtifactBrowserFilter {
  if (
    outputMetadataString(output, "origin_type") === "app" ||
    output.module_id
  ) {
    return "apps";
  }
  const category = outputMetadataString(output, "category");
  if (category === "image") {
    return "images";
  }
  if (category === "code") {
    return "code";
  }
  if (category === "link") {
    return "links";
  }
  return "documents";
}

function outputKindLabel(output: WorkspaceOutputRecordPayload) {
  // .dashboard files outrank generic origin/category labels — they're
  // a first-class artifact type with their own renderer.
  const ext = outputFileExtensionFromTitle(output);
  if (ext === "dashboard") {
    return "Dashboard";
  }
  if (
    outputMetadataString(output, "origin_type") === "app" ||
    output.module_id
  ) {
    const artifactType = outputMetadataString(output, "artifact_type");
    if (artifactType) {
      return artifactType.charAt(0).toUpperCase() + artifactType.slice(1);
    }
    return "Artifact";
  }
  const category = outputMetadataString(output, "category");
  if (category === "image") {
    return "Image";
  }
  if (category === "code") {
    return "Code file";
  }
  if (category === "link") {
    return "Link";
  }
  if (category === "spreadsheet") {
    return "Spreadsheet";
  }
  if (category === "document") {
    return "Document";
  }
  return output.output_type === "document" ? "Document" : "File";
}

// Lightweight extension lookup that doesn't depend on the metadata
// envelope (which agent-authored files often skip). Reads the title
// suffix only — used inside outputKindLabel before metadata parsing.
function outputFileExtensionFromTitle(
  output: WorkspaceOutputRecordPayload,
): string {
  const fromTitle = output.title?.trim() ?? "";
  const dotIndex = fromTitle.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fromTitle.length - 1) {
    return fromTitle.slice(dotIndex + 1).toLowerCase();
  }
  const path = outputMetadataString(output, "file_path") ?? output.file_path ?? "";
  const pathDot = path.lastIndexOf(".");
  if (pathDot > 0 && pathDot < path.length - 1) {
    return path.slice(pathDot + 1).toLowerCase();
  }
  return "";
}

function outputChangeLabel(output: WorkspaceOutputRecordPayload) {
  const changeType = outputMetadataString(output, "change_type");
  if (changeType === "created") {
    return "Created";
  }
  if (changeType === "modified") {
    return "Updated";
  }
  return "";
}

function outputSecondaryLabel(output: WorkspaceOutputRecordPayload) {
  const parts = [outputKindLabel(output)];
  const sizeLabel = formatAttachmentSize(
    outputMetadataNumber(output, "size_bytes") ?? 0,
  );
  if (sizeLabel) {
    parts.push(sizeLabel);
  }
  const timeLabel = chatMessageTimeLabel(output.created_at);
  if (timeLabel) {
    parts.push(timeLabel);
  }
  return parts.join(" · ");
}

export function sortOutputs(outputs: WorkspaceOutputRecordPayload[]) {
  return [...dedupeOutputsForDisplay(outputs)].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.title.localeCompare(right.title);
  });
}

function sortOutputsLatestFirst(outputs: WorkspaceOutputRecordPayload[]) {
  return [...dedupeOutputsForDisplay(outputs)].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.title.localeCompare(right.title);
  });
}

function outputDisplayDedupeKey(output: WorkspaceOutputRecordPayload) {
  const filePath = output.file_path?.trim() ?? "";
  if (filePath) {
    return `path:${filePath}`;
  }
  const artifactId = output.artifact_id?.trim() ?? "";
  if (artifactId) {
    return `artifact:${artifactId}`;
  }
  const title = output.title?.trim().toLowerCase() ?? "";
  if (title) {
    return `title:${title}`;
  }
  return `id:${output.id}`;
}

function outputDisplayPriority(output: WorkspaceOutputRecordPayload) {
  let score = 0;
  const originType = outputMetadataString(output, "origin_type");
  if (originType === "forwarded_subagent") {
    score += 40;
  } else if (originType === "runtime_tool") {
    score += 35;
  } else if (originType === "app") {
    score += 30;
  }

  if (outputMetadataString(output, "artifact_type") === "report") {
    score += 20;
  }
  if (!/\.[A-Za-z0-9]+$/.test(output.title?.trim() ?? "")) {
    score += 5;
  }
  return score;
}

function shouldPreferOutputForDisplay(
  candidate: WorkspaceOutputRecordPayload,
  current: WorkspaceOutputRecordPayload,
) {
  const candidatePriority = outputDisplayPriority(candidate);
  const currentPriority = outputDisplayPriority(current);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }
  const candidateCreatedAt = Date.parse(candidate.created_at || "") || 0;
  const currentCreatedAt = Date.parse(current.created_at || "") || 0;
  if (candidateCreatedAt !== currentCreatedAt) {
    return candidateCreatedAt > currentCreatedAt;
  }
  return candidate.title.localeCompare(current.title) < 0;
}

function dedupeOutputsForDisplay(outputs: WorkspaceOutputRecordPayload[]) {
  const preferredByKey = new Map<string, WorkspaceOutputRecordPayload>();
  for (const output of outputs) {
    const key = outputDisplayDedupeKey(output);
    const current = preferredByKey.get(key);
    if (!current || shouldPreferOutputForDisplay(output, current)) {
      preferredByKey.set(key, output);
    }
  }
  return [...preferredByKey.values()];
}

function sortMemoryUpdateProposals(
  proposals: MemoryUpdateProposalRecordPayload[],
) {
  return [...proposals].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.title.localeCompare(right.title);
  });
}

function attachmentButtonLabel(attachment: {
  name: string;
  size_bytes: number;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size_bytes);
  return sizeLabel ? `${attachment.name} (${sizeLabel})` : attachment.name;
}

function attachmentUploadPayload(
  file: File,
): Promise<StageSessionAttachmentFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve({
        name: file.name,
        mime_type: file.type || null,
        content_base64: separator >= 0 ? result.slice(separator + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function attachmentFileExtension(mimeType?: string | null): string {
  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (!normalizedMimeType.includes("/")) {
    return "bin";
  }
  const subtype = normalizedMimeType.split("/")[1]?.split("+")[0]?.trim() || "";
  if (!subtype) {
    return "bin";
  }
  if (subtype === "jpeg") {
    return "jpg";
  }
  if (subtype === "svg") {
    return "svg";
  }
  return subtype;
}

function normalizeClipboardAttachmentFile(file: File, index: number): File {
  if (file.name.trim()) {
    return file;
  }

  const extension = attachmentFileExtension(file.type);
  const baseName = file.type.startsWith("image/")
    ? `pasted-image-${index + 1}`
    : `pasted-file-${index + 1}`;
  return new File([file], `${baseName}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}

function clipboardFilesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) {
    return [];
  }

  const clipboardFiles =
    dataTransfer.files.length > 0
      ? Array.from(dataTransfer.files)
      : Array.from(dataTransfer.items ?? []).flatMap((item) => {
          if (item.kind !== "file") {
            return [];
          }
          const file = item.getAsFile();
          return file ? [file] : [];
        });

  return clipboardFiles.map((file, index) =>
    normalizeClipboardAttachmentFile(file, index),
  );
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function fileFromClipboardImagePayload(
  payload: ClipboardImagePayload | null,
): File | null {
  const contentBase64 = payload?.content_base64?.trim() ?? "";
  if (!payload || !contentBase64) {
    return null;
  }

  try {
    return new File([base64ToArrayBuffer(contentBase64)], payload.name, {
      type: payload.mime_type || "image/png",
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

async function clipboardImageFileFromElectronClipboard(): Promise<File | null> {
  const payload = await window.electronAPI.clipboard.readImage();
  return fileFromClipboardImagePayload(payload);
}

function explorerAttachmentFilesFromClipboardText(
  clipboardText: string,
): ExplorerAttachmentDragPayload[] {
  const entry = getExplorerAttachmentClipboardEntry();
  if (!entry) {
    return [];
  }

  if (clipboardText.trim() !== entry.text) {
    return [];
  }

  return [entry.payload];
}

function pendingAttachmentId(seed: string) {
  return `${seed}-${crypto.randomUUID()}`;
}

function runtimeStateStatus(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function runtimeStateEffectiveStatus(
  runtimeState:
    | Pick<SessionRuntimeRecordPayload, "status" | "effective_state">
    | null
    | undefined,
): string {
  return runtimeStateStatus(
    runtimeState?.effective_state ?? runtimeState?.status,
  );
}

type BrowserAudioContextConstructor = new (
  contextOptions?: AudioContextOptions,
) => AudioContext;

let mainSessionCompletionChimeContext: AudioContext | null = null;

function getMainSessionCompletionChimeContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const AudioContextCtor: BrowserAudioContextConstructor | undefined =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: BrowserAudioContextConstructor })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  try {
    mainSessionCompletionChimeContext ??= new AudioContextCtor();
    return mainSessionCompletionChimeContext;
  } catch {
    return null;
  }
}

function playMainSessionCompletionChime() {
  const context = getMainSessionCompletionChimeContext();
  if (!context) {
    return;
  }

  const play = () => {
    const startAt = context.currentTime + 0.015;
    const tones = [
      { frequency: 659.25, offset: 0, duration: 0.13, volume: 0.034 },
      { frequency: 987.77, offset: 0.12, duration: 0.17, volume: 0.026 },
    ];
    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = startAt + tone.offset;
      const toneEnd = toneStart + tone.duration;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(tone.volume, toneStart + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.02);
    }
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => undefined);
    return;
  }
  play();
}

function defaultWorkspaceSessionTitle(
  kind: string | null | undefined,
  sessionId: string,
): string {
  const normalizedKind = (kind || "").trim().toLowerCase();
  if (normalizedKind === "cronjob") {
    return "Cronjob run";
  }
  if (normalizedKind === "subagent") {
    return "Subagent run";
  }
  if (normalizedKind === "task_proposal") {
    return "Task proposal run";
  }
  return `Session ${sessionId.slice(0, 8)}`;
}

type InspectableSessionCategory =
  | "subagent"
  | "cronjob"
  | "task_proposal"
  | "session";

function inspectableSessionCategory(
  session:
    | Pick<
        AgentSessionRecordPayload,
        | "kind"
        | "source_type"
        | "cronjob_id"
        | "proposal_id"
        | "source_proposal_id"
      >
    | null
    | undefined,
): InspectableSessionCategory {
  const sourceType = (session?.source_type ?? "").trim().toLowerCase();
  const kind = (session?.kind ?? "").trim().toLowerCase();
  if (sourceType === "cronjob" || Boolean((session?.cronjob_id ?? "").trim())) {
    return "cronjob";
  }
  if (
    kind === "task_proposal" ||
    sourceType === "task_proposal" ||
    Boolean((session?.proposal_id ?? "").trim()) ||
    Boolean((session?.source_proposal_id ?? "").trim())
  ) {
    return "task_proposal";
  }
  if (kind === "subagent") {
    return "subagent";
  }
  return "session";
}

function inspectableSessionLabel(
  session:
    | Pick<
        AgentSessionRecordPayload,
        | "kind"
        | "source_type"
        | "cronjob_id"
        | "proposal_id"
        | "source_proposal_id"
      >
    | null
    | undefined,
): string {
  const category = inspectableSessionCategory(session);
  if (category === "cronjob") {
    return "Cronjob run";
  }
  if (category === "task_proposal") {
    return "Task proposal run";
  }
  if (category === "subagent") {
    return "Subagent run";
  }
  return "Session";
}

function runtimeStateErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const payload = value as Record<string, unknown>;
    const message = payload.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    const error = payload.error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }
  return "The run failed.";
}

function onboardingStatusLabel(value: string | null | undefined) {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "awaiting_confirmation") {
    return "Awaiting confirmation";
  }
  if (normalized === "in_progress") {
    return "In progress";
  }
  if (normalized === "completed") {
    return "Completed";
  }
  return "Pending";
}

function onboardingStatusTone(value: string | null | undefined) {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "awaiting_confirmation") {
    return "border-warning/22 bg-warning/10 text-warning";
  }
  if (normalized === "in_progress") {
    return "border-primary bg-primary/10 text-primary";
  }
  if (normalized === "completed") {
    return "border-success/22 bg-success/8 text-success";
  }
  return "border-destructive/22 bg-destructive/8 text-destructive";
}

function startCase(value: string) {
  const normalized = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeUnknown(value: unknown, maxLength = 140): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
      : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const rendered = value
      .slice(0, 4)
      .map((item) => summarizeUnknown(item, 48))
      .filter(Boolean)
      .join(", ");
    return value.length > 4 ? `${rendered}, ...` : rendered;
  }
  if (isRecord(value)) {
    const rendered = Object.entries(value)
      .slice(0, 4)
      .map(
        ([key, entryValue]) =>
          `${startCase(key)}: ${summarizeUnknown(entryValue, 36)}`,
      )
      .join(" | ");
    return Object.keys(value).length > 4 ? `${rendered} | ...` : rendered;
  }
  if (value == null) {
    return "";
  }
  return String(value);
}

function runFailedContextLabel(payload: Record<string, unknown>): string {
  const provider =
    typeof payload.provider === "string" ? payload.provider.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return provider || model;
}

function runFailedDetail(payload: Record<string, unknown>): string {
  const detail =
    typeof payload.error === "string"
      ? payload.error.trim()
      : typeof payload.message === "string"
        ? payload.message.trim()
        : "";
  const contextLabel = runFailedContextLabel(payload);
  if (!contextLabel) {
    return detail || "The run failed.";
  }
  if (!detail) {
    return `${contextLabel} failed.`;
  }
  return detail.startsWith(contextLabel)
    ? detail
    : `${contextLabel}: ${detail}`;
}

function assistantMetaLabel(
  harness: string | null | undefined,
  model: string | null | undefined,
) {
  const harnessLabel = harness ? startCase(harness) : "";
  if (harnessLabel) {
    return harnessLabel;
  }

  const modelLabel = (model || "").trim();
  return modelLabel || "Local runtime";
}

function toolTraceStepId(payload: Record<string, unknown>) {
  const callId =
    typeof payload.call_id === "string" ? payload.call_id.trim() : "";
  const toolId =
    typeof payload.tool_id === "string" ? payload.tool_id.trim() : "";
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  return callId || toolId || toolName
    ? `tool:${callId || toolId || toolName}`
    : "";
}

export function inputIdFromMessageId(
  messageId: string,
  role: "user" | "assistant",
) {
  const prefix = `${role}-`;
  return messageId.startsWith(prefix) ? messageId.slice(prefix.length) : "";
}

export function inputIdFromHistoryMessage(
  message: SessionHistoryMessagePayload,
) {
  if (message.role === "user" || message.role === "assistant") {
    return inputIdFromMessageId(message.id, message.role);
  }
  return "";
}

export function historyMessagesInDisplayOrder(
  messages: SessionHistoryMessagePayload[],
  order: "asc" | "desc",
) {
  return order === "desc" ? [...messages].reverse() : messages;
}

export function turnInputIdsFromHistoryMessages(
  messages: SessionHistoryMessagePayload[],
) {
  const seen = new Set<string>();
  const inputIds: string[] = [];
  for (const message of messages) {
    const inputId = inputIdFromHistoryMessage(message);
    if (!inputId || seen.has(inputId)) {
      continue;
    }
    seen.add(inputId);
    inputIds.push(inputId);
  }
  return inputIds;
}

function assistantInputIdsFromChatMessages(messages: ChatMessage[]) {
  const inputIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const inputId = inputIdFromMessageId(message.id, "assistant");
    if (inputId) {
      inputIds.add(inputId);
    }
  }
  return inputIds;
}

function uniqueChatMessagesInDisplayOrder(messages: ChatMessage[]) {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

function prependUniqueChatMessages(
  prependedMessages: ChatMessage[],
  currentMessages: ChatMessage[],
) {
  const seen = new Set(currentMessages.map((message) => message.id));
  const uniquePrependedMessages = prependedMessages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
  return [...uniquePrependedMessages, ...currentMessages];
}

function reconcileQueuedSessionInputs(
  queuedInputs: QueuedSessionInput[],
  params: {
    workspaceId: string;
    sessionId: string;
    persistedInputIds: Set<string>;
    activeInputId?: string | null;
    activeStatus?: string | null;
  },
): QueuedSessionInput[] {
  const activeInputId = (params.activeInputId || "").trim();
  const activeStatus = runtimeStateStatus(params.activeStatus);
  return queuedInputs
    .filter((item) => {
      if (
        item.workspaceId !== params.workspaceId ||
        item.sessionId !== params.sessionId
      ) {
        return true;
      }
      return !params.persistedInputIds.has(item.inputId);
    })
    .map((item) => {
      if (
        item.workspaceId !== params.workspaceId ||
        item.sessionId !== params.sessionId
      ) {
        return item;
      }
      if (!activeInputId || item.inputId !== activeInputId) {
        return item;
      }
      const status: QueuedSessionInputStatus =
        activeStatus === "BUSY" ? "sending" : "queued";
      return {
        ...item,
        status,
      };
    });
}

function reconcilePendingOptimisticUserMessages(
  pendingMessages: PendingOptimisticUserMessage[],
  params: {
    workspaceId: string;
    sessionId: string;
    persistedInputIds: Set<string>;
  },
): PendingOptimisticUserMessage[] {
  return pendingMessages.filter((item) => {
    if (
      item.workspaceId !== params.workspaceId ||
      item.sessionId !== params.sessionId
    ) {
      return true;
    }
    const inputId = (item.inputId || "").trim();
    if (!inputId) {
      return true;
    }
    return !params.persistedInputIds.has(inputId);
  });
}

function mergePendingOptimisticUserMessages(
  renderedMessages: ChatMessage[],
  pendingMessages: PendingOptimisticUserMessage[],
  params: {
    workspaceId: string;
    sessionId: string;
  },
): ChatMessage[] {
  const matchingPendingMessages = pendingMessages
    .filter(
      (item) =>
        item.workspaceId === params.workspaceId &&
        item.sessionId === params.sessionId,
    )
    .map((item) => item.message);
  return uniqueChatMessagesInDisplayOrder([
    ...renderedMessages,
    ...matchingPendingMessages,
  ]);
}

function defaultQueuedSessionInputPreviewEntries(
  mode: "single" | "multiple",
): QueuedSessionInputPreviewDescriptor[] {
  const now = Date.now();
  if (mode === "single") {
    return [
      {
        text: "Draft a concise follow-up after the current run finishes.",
        createdAt: new Date(now).toISOString(),
        status: "queued",
        attachments: [],
      },
    ];
  }
  return [
    {
      text: serializeQuotedSkillPrompt(
        "Pull the latest renewal risk notes before replying.",
        ["customer_lookup"],
      ),
      createdAt: new Date(now - 2 * 60_000).toISOString(),
      status: "sending",
      attachments: [],
    },
    {
      text: "Draft a tighter follow-up once the risk notes land.",
      createdAt: new Date(now - 60_000).toISOString(),
      status: "queued",
      attachments: [],
    },
    {
      text: "Prepare a brief handoff summary for the account manager.",
      createdAt: new Date(now).toISOString(),
      status: "queued",
      attachments: [],
    },
  ];
}

function normalizeQueuedSessionInputPreviewEntries(
  entries: unknown,
): QueuedSessionInputPreviewDescriptor[] {
  const rawEntries =
    typeof entries === "string"
      ? [entries]
      : Array.isArray(entries)
        ? entries
        : [];
  const normalized: QueuedSessionInputPreviewDescriptor[] = [];
  rawEntries.forEach((entry, index) => {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (!text) {
        return;
      }
      normalized.push({
        text,
        createdAt: new Date(Date.now() - index * 60_000).toISOString(),
        status: "queued",
        attachments: [],
      });
      return;
    }
    if (!entry || typeof entry !== "object") {
      return;
    }
    const payload = entry as Partial<QueuedSessionInputPreviewDescriptor>;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return;
    }
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
          .map((attachment) => normalizeChatAttachment(attachment))
          .filter((attachment): attachment is ChatAttachment =>
            Boolean(attachment),
          )
      : [];
    normalized.push({
      text,
      createdAt:
        typeof payload.createdAt === "string" && payload.createdAt.trim()
          ? payload.createdAt
          : new Date(Date.now() - index * 60_000).toISOString(),
      status: payload.status === "sending" ? "sending" : "queued",
      attachments,
    });
  });
  return normalized;
}

function setQueuedSessionInputPreviewState(entries: unknown) {
  window.__holabossQueuedMessagesPreviewState =
    normalizeQueuedSessionInputPreviewEntries(entries);
  window.dispatchEvent(new CustomEvent(QUEUED_MESSAGES_PREVIEW_EVENT));
}

function useQueuedSessionInputPreview(params: {
  workspaceId?: string | null;
  sessionId?: string | null;
}) {
  const workspaceId = (params.workspaceId || "").trim();
  const sessionId = (params.sessionId || "").trim();
  const [previewItems, setPreviewItems] = useState<QueuedSessionInput[]>([]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const applyCurrentState = () => {
      const items = window.__holabossQueuedMessagesPreviewState ?? [];
      setPreviewItems(
        items.map((item, index) => ({
          inputId: `preview-queued-${index + 1}`,
          sessionId,
          workspaceId,
          text: item.text,
          createdAt: item.createdAt || new Date().toISOString(),
          attachments: item.attachments ?? [],
          status: item.status,
        })),
      );
    };

    const handlePreviewChange = () => {
      applyCurrentState();
    };

    applyCurrentState();
    window.addEventListener(
      QUEUED_MESSAGES_PREVIEW_EVENT,
      handlePreviewChange as EventListener,
    );
    window.__holabossDevQueuedMessagesPreview = {
      single: (
        text = "Draft a concise follow-up after the current run finishes.",
      ) =>
        setQueuedSessionInputPreviewState([
          {
            text,
            status: "queued",
            attachments: [],
          },
        ]),
      multiple: () =>
        setQueuedSessionInputPreviewState(
          defaultQueuedSessionInputPreviewEntries("multiple"),
        ),
      clear: () => setQueuedSessionInputPreviewState([]),
      set: (entries) => setQueuedSessionInputPreviewState(entries),
      get: () => window.__holabossQueuedMessagesPreviewState ?? [],
    };

    return () => {
      window.removeEventListener(
        QUEUED_MESSAGES_PREVIEW_EVENT,
        handlePreviewChange as EventListener,
      );
      delete window.__holabossDevQueuedMessagesPreview;
    };
  }, [sessionId, workspaceId]);

  return previewItems;
}

function mergeUniqueByKey<T>(
  existing: T[],
  incoming: T[],
  keyForItem: (item: T) => string,
) {
  const merged = new Map<string, T>();
  for (const item of [...existing, ...incoming]) {
    const key = keyForItem(item);
    if (!key) {
      continue;
    }
    merged.set(key, item);
  }
  return Array.from(merged.values());
}

function mergeSessionOutputEvents(
  existing: SessionOutputEventPayload[],
  incoming: SessionOutputEventPayload[],
) {
  return mergeUniqueByKey(existing, incoming, (event) => String(event.id));
}

function mergeSessionOutputs(
  existing: WorkspaceOutputRecordPayload[],
  incoming: WorkspaceOutputRecordPayload[],
) {
  return sortOutputs(
    mergeUniqueByKey(existing, incoming, (output) => output.id),
  );
}

function mergeMemoryUpdateProposals(
  existing: MemoryUpdateProposalRecordPayload[],
  incoming: MemoryUpdateProposalRecordPayload[],
) {
  return sortMemoryUpdateProposals(
    mergeUniqueByKey(existing, incoming, (proposal) => proposal.proposal_id),
  );
}

function normalizeWorkspaceFileSyncPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!normalized) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    return null;
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith("/..") ||
    normalized.endsWith("\\..")
  ) {
    return null;
  }
  return normalized;
}

function syncableWorkspacePathFromRecord(
  value: unknown,
  preferredKeys: string[],
): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of preferredKeys) {
    const match = normalizeWorkspaceFileSyncPath(value[key]);
    if (match) {
      return match;
    }
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !/(?:^|_)(?:path|file|filepath|filename|target|destination)$/i.test(key)
    ) {
      continue;
    }
    const match = normalizeWorkspaceFileSyncPath(candidate);
    if (match) {
      return match;
    }
  }
  return null;
}

function fileDisplaySyncTargetFromToolPayload(
  payload: Record<string, unknown>,
): string | null {
  const toolName =
    typeof payload.tool_name === "string"
      ? payload.tool_name.trim().toLowerCase()
      : "";
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (!toolName || payload.error === true) {
    return null;
  }

  if (toolName === "write_report" || toolName === "image_generate") {
    if (phase !== "completed") {
      return null;
    }
    return syncableWorkspacePathFromRecord(payload.result, [
      "file_path",
      "path",
    ]);
  }

  if (toolName === "cp" || toolName === "mv") {
    if (phase !== "completed") {
      return null;
    }
    return syncableWorkspacePathFromRecord(payload.tool_args, [
      "destination_path",
      "destination",
      "to_path",
      "to",
      "target_path",
      "target",
      "file_path",
      "path",
    ]);
  }

  if (toolName === "write") {
    if (phase !== "completed") {
      return null;
    }
    return syncableWorkspacePathFromRecord(payload.tool_args, [
      "file_path",
      "path",
      "target_path",
      "target",
      "filename",
      "file",
    ]);
  }

  if (toolName === "edit") {
    if (phase !== "started" && phase !== "completed") {
      return null;
    }
    return syncableWorkspacePathFromRecord(payload.tool_args, [
      "file_path",
      "path",
      "target_path",
      "target",
      "filename",
      "file",
    ]);
  }

  return null;
}

function extractMcpErrorText(result: unknown): string {
  if (!isRecord(result) || result.isError !== true) {
    return "";
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      const text = part.text.trim();
      if (text) {
        return text.length > 200 ? `${text.slice(0, 197).trimEnd()}...` : text;
      }
    }
  }
  return "";
}

function extractToolResultText(result: unknown, maxLength = 200): string {
  if (!isRecord(result)) {
    return "";
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      const text = part.text.trim();
      if (text) {
        return summarizeUnknown(text, maxLength);
      }
    }
  }
  return "";
}

function extractToolErrorText(payload: Record<string, unknown>): string {
  const mcpErrorText = extractMcpErrorText(payload.result);
  if (mcpErrorText) {
    return mcpErrorText;
  }

  const resultText = extractToolResultText(payload.result);
  if (resultText) {
    return resultText;
  }

  if (typeof payload.error === "string") {
    const text = payload.error.trim();
    if (text) {
      return summarizeUnknown(text, 200);
    }
  }

  const resultSummary = summarizeUnknown(payload.result, 200);
  if (resultSummary && resultSummary !== "true" && resultSummary !== "false") {
    return resultSummary;
  }

  return "";
}

function isIntegrationError(
  text: string,
): { provider: string; action: string } | null {
  const patterns: Array<{ pattern: RegExp; provider: string }> = [
    { pattern: /no\s+google\s+token/i, provider: "Google" },
    { pattern: /no\s+github\s+token/i, provider: "GitHub" },
    { pattern: /no\s+reddit\s+token/i, provider: "Reddit" },
    { pattern: /no\s+twitter\s+token/i, provider: "Twitter" },
    { pattern: /no\s+linkedin\s+token/i, provider: "LinkedIn" },
    { pattern: /PLATFORM_INTEGRATION_TOKEN/i, provider: "" },
    { pattern: /integration.*not.*connected/i, provider: "" },
    { pattern: /integration.*not.*bound/i, provider: "" },
    { pattern: /connect\s+via\s+(settings|integrations)/i, provider: "" },
  ];
  for (const { pattern, provider } of patterns) {
    if (pattern.test(text)) {
      const resolved = provider || "this provider";
      return {
        provider: resolved,
        action: `Connect ${resolved} in the Integrations tab`,
      };
    }
  }
  return null;
}

function toolTraceStepFromPayload(
  payload: Record<string, unknown>,
  order: number,
): ChatTraceStep | null {
  const stepId = toolTraceStepId(payload);
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  const toolId =
    typeof payload.tool_id === "string" ? payload.tool_id.trim() : "";
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  const label = startCase(toolName || toolId);
  if (!stepId || !label) {
    return null;
  }

  const isError = payload.error === true || phase === "error";
  const details: string[] = [];
  const argsSummary = summarizeUnknown(payload.tool_args);
  const resultSummary = summarizeUnknown(payload.result);
  const errorSummary = summarizeUnknown(payload.error);
  const toolErrorText = extractToolErrorText(payload);

  if (phase === "started") {
    if (argsSummary) {
      details.push(argsSummary);
    }
  } else if (TOOL_TRACE_TERMINAL_PHASES.has(phase)) {
    if (isError && toolErrorText) {
      details.push(toolErrorText);
    } else if (isError) {
      if (errorSummary && errorSummary !== "true" && errorSummary !== "false") {
        details.push(errorSummary);
      } else {
        details.push("Error");
      }
    } else if (argsSummary) {
      details.push(argsSummary);
    }
    if (!isError && resultSummary) {
      details.push(resultSummary);
    }
  } else if (argsSummary) {
    details.push(argsSummary);
  }

  return {
    id: stepId,
    kind: "tool",
    title: label,
    status: isError
      ? "error"
      : TOOL_TRACE_TERMINAL_PHASES.has(phase)
        ? "completed"
        : "running",
    details,
    order,
  };
}

function toolTraceStepFromEvent(
  eventType: string,
  payload: Record<string, unknown>,
  order: number,
): ChatTraceStep | null {
  if (
    eventType !== "tool_call" &&
    eventType !== "tool_call_started" &&
    eventType !== "tool_started" &&
    eventType !== "tool_completed"
  ) {
    return null;
  }

  return toolTraceStepFromPayload(
    eventType === "tool_call"
      ? payload
      : {
          ...payload,
          phase:
            eventType === "tool_completed"
              ? "completed"
              : eventType === "tool_call_started" ||
                  eventType === "tool_started"
                ? "started"
                : payload.phase,
        },
    order,
  );
}

function contextBudgetDetails(
  payload: Record<string, unknown>,
): string[] {
  const decisions = isRecord(payload.context_budget_decisions)
    ? payload.context_budget_decisions
    : null;
  if (!decisions) {
    return [];
  }
  const pressureStage =
    typeof decisions.pressure_stage === "string"
      ? decisions.pressure_stage.trim().toLowerCase()
      : "";
  const details: string[] = [];
  if (pressureStage === "trim_prompt_lanes") {
    details.push("Prompt lanes trimmed");
  }
  if (
    decisions.retrieval_clipped === true ||
    pressureStage === "retrieval_only"
  ) {
    details.push("Retrieval-only continuity mode");
  }
  if (
    decisions.checkpoint_queued === true ||
    pressureStage === "queue_checkpoint"
  ) {
    details.push("Checkpoint compaction queued");
  }
  return details;
}

function phaseTraceStepFromEvent(
  eventType: string,
  payload: Record<string, unknown>,
  order: number,
): ChatTraceStep | null {
  const phase = typeof payload.phase === "string" ? payload.phase.trim() : "";
  const instructionPreview =
    typeof payload.instruction_preview === "string"
      ? payload.instruction_preview.trim()
      : "";
  const details: string[] = [];

  if (eventType === "run_claimed") {
    return {
      id: "phase:run-claimed",
      kind: "phase",
      title: "Checking workspace context",
      status: "running",
      details: ["The run was picked up and is preparing the active workspace context."],
      order,
    };
  }

  if (eventType === "run_started") {
    return {
      id: "phase:run-started",
      kind: "phase",
      title: "Running",
      status: "running",
      details: ["The agent started the turn and is working on the request."],
      order,
    };
  }

  if (eventType === "auto_compaction_start") {
    const reason =
      typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (reason) {
      details.push(`Reason: ${reason}`);
    }
    return {
      id: "phase:auto-compaction",
      kind: "phase",
      title: "Compacting context",
      status: "running",
      details:
        details.length > 0
          ? details
          : ["The agent is compacting older context to continue the run."],
      order,
    };
  }

  if (eventType === "mcp_server_unavailable") {
    const serverId =
      typeof payload.server_id === "string" ? payload.server_id.trim() : "";
    const reason =
      typeof payload.reason === "string" ? payload.reason.trim() : "";
    const missingToolIds = Array.isArray(payload.missing_tool_ids)
      ? payload.missing_tool_ids.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];
    if (reason) {
      details.push(reason);
    }
    if (missingToolIds.length > 0) {
      const preview = missingToolIds.slice(0, 5).join(", ");
      const suffix =
        missingToolIds.length > 5
          ? ` (+${missingToolIds.length - 5} more)`
          : "";
      details.push(`Skipped tools: ${preview}${suffix}`);
    }
    return {
      id: `phase:mcp-unavailable:${serverId || `seq-${order}`}`,
      kind: "phase",
      title: serverId
        ? `MCP server unavailable: ${serverId}`
        : "MCP server unavailable",
      status: "error",
      details:
        details.length > 0
          ? details
          : ["The agent will continue without this server's tools."],
      order,
    };
  }

  if (eventType === "auto_compaction_end") {
    const result = isRecord(payload.result) ? payload.result : null;
    const summary =
      result && typeof result.summary === "string" ? result.summary.trim() : "";
    const tokensBefore =
      result && typeof result.tokensBefore === "number"
        ? result.tokensBefore
        : null;
    const errorMessage =
      typeof payload.error_message === "string"
        ? payload.error_message.trim()
        : "";
    const aborted = payload.aborted === true;
    const willRetry = payload.will_retry === true;
    if (summary) {
      details.push(`Summary: ${summarizeUnknown(summary, 160)}`);
    }
    if (tokensBefore !== null) {
      details.push(`Tokens before compaction: ${tokensBefore}`);
    }
    if (aborted) {
      details.push("Compaction was aborted.");
    } else {
      details.push("Compaction completed.");
    }
    if (willRetry) {
      details.push("The agent will retry after compaction.");
    }
    if (errorMessage) {
      details.push(`Error: ${summarizeUnknown(errorMessage, 120)}`);
    }
    return {
      id: "phase:auto-compaction",
      kind: "phase",
      title: aborted ? "Context compaction interrupted" : "Context compacted",
      status: aborted || errorMessage ? "error" : "completed",
      details,
      order,
    };
  }

  if (eventType === "compaction_start") {
    const source =
      typeof payload.source === "string" ? payload.source.trim() : "";
    if (source) {
      details.push(`Source: ${source}`);
    }
    return {
      id: "phase:post-turn-compaction",
      kind: "phase",
      title: "Finalizing run context",
      status: "running",
      details:
        details.length > 0
          ? details
          : ["Persisting post-turn continuity and memory artifacts."],
      order,
    };
  }

  if (eventType === "compaction_boundary_written") {
    const boundaryId =
      typeof payload.boundary_id === "string" ? payload.boundary_id.trim() : "";
    const boundaryType =
      typeof payload.boundary_type === "string"
        ? payload.boundary_type.trim()
        : "";
    const restoredMemoryPathCount =
      typeof payload.restored_memory_path_count === "number"
        ? payload.restored_memory_path_count
        : null;
    if (boundaryId) {
      details.push(`Boundary: ${boundaryId}`);
    }
    if (boundaryType) {
      details.push(`Boundary type: ${boundaryType}`);
    }
    if (restoredMemoryPathCount !== null) {
      details.push(`Restored memory paths: ${restoredMemoryPathCount}`);
    }
    return {
      id: "phase:post-turn-compaction",
      kind: "phase",
      title: "Compaction boundary saved",
      status: "running",
      details: details.length > 0 ? details : ["Compaction boundary written."],
      order,
    };
  }

  if (eventType === "compaction_end") {
    const status =
      typeof payload.status === "string"
        ? payload.status.trim().toLowerCase()
        : "";
    const durationMs =
      typeof payload.duration_ms === "number" ? payload.duration_ms : null;
    const boundaryId =
      typeof payload.boundary_id === "string" ? payload.boundary_id.trim() : "";
    const errorMessage =
      typeof payload.error_message === "string"
        ? payload.error_message.trim()
        : "";
    if (boundaryId) {
      details.push(`Boundary: ${boundaryId}`);
    }
    if (durationMs !== null) {
      details.push(`Duration: ${durationMs} ms`);
    }
    if (errorMessage) {
      details.push(`Error: ${summarizeUnknown(errorMessage, 120)}`);
    }
    return {
      id: "phase:post-turn-compaction",
      kind: "phase",
      title:
        status === "failed" ? "Compaction failed" : "Run context finalized",
      status: status === "failed" ? "error" : "completed",
      details,
      order,
    };
  }

  if (eventType === "run_waiting_user" || eventType === "awaiting_user_input") {
    return {
      id: "phase:awaiting-user",
      kind: "phase",
      title: "Waiting for your input",
      status: "waiting",
      details: [
        "The agent needs a follow-up answer before it can continue.",
        ...contextBudgetDetails(payload),
      ],
      order,
    };
  }

  if (eventType === "run_completed") {
    const status =
      typeof payload.status === "string"
        ? payload.status.trim().toLowerCase()
        : "";
    const budgetDetails = contextBudgetDetails(payload);
    if (status === "waiting_user") {
      return {
        id: "phase:awaiting-user",
        kind: "phase",
        title: "Waiting for your input",
        status: "waiting",
        details: [
          "The agent needs a follow-up answer before it can continue.",
          ...budgetDetails,
        ],
        order,
      };
    }
    if (status === "paused") {
      return {
        id: "phase:user-paused",
        kind: "phase",
        title: "Run paused",
        status: "waiting",
        details: [
          "The run was paused before completion and can be continued in a later turn.",
          ...budgetDetails,
        ],
        order,
      };
    }
    if (budgetDetails.length > 0) {
      return {
        id: "phase:context-budget",
        kind: "phase",
        title: "Context budget",
        status: "completed",
        details: budgetDetails,
        order,
      };
    }
  }

  if (eventType === "run_failed") {
    details.push(...contextBudgetDetails(payload));
    const errorText = runFailedDetail(payload);
    if (errorText) {
      details.push(`Error: ${summarizeUnknown(errorText, 120)}`);
    }
    return {
      id: "phase:run-failed",
      kind: "phase",
      title: "Run failed",
      status: "error",
      details,
      order,
    };
  }

  return null;
}

function upsertTraceStep(previous: ChatTraceStep[], step: ChatTraceStep) {
  const existingIndex = previous.findIndex((entry) => entry.id === step.id);
  if (existingIndex < 0) {
    return [...previous, step].sort((left, right) => left.order - right.order);
  }

  return previous
    .map((entry, index) =>
      index === existingIndex
        ? {
            ...entry,
            ...step,
            order: Math.min(entry.order, step.order),
            details: step.details.length > 0 ? step.details : entry.details,
          }
        : entry,
    )
    .sort((left, right) => left.order - right.order);
}

function finalizeTraceSteps(
  previous: ChatTraceStep[],
  status: Extract<ChatTraceStepStatus, "completed" | "error" | "waiting">,
) {
  return previous.map((step) =>
    step.status === "running"
      ? {
          ...step,
          status,
        }
      : step,
  );
}

function traceStepStatusRank(status: ChatTraceStepStatus) {
  switch (status) {
    case "error":
      return 3;
    case "completed":
      return 2;
    case "waiting":
      return 1;
    default:
      return 0;
  }
}

function mergeTraceStep(
  existing: ChatTraceStep,
  incoming: ChatTraceStep,
): ChatTraceStep {
  const incomingIsNewer =
    incoming.order > existing.order ||
    (incoming.order === existing.order &&
      traceStepStatusRank(incoming.status) >=
        traceStepStatusRank(existing.status));
  const preferred = incomingIsNewer ? incoming : existing;
  const fallback = incomingIsNewer ? existing : incoming;

  return {
    ...fallback,
    ...preferred,
    order: Math.min(existing.order, incoming.order),
    details:
      preferred.details.length > 0 ? preferred.details : fallback.details,
  };
}

function appendExecutionTimelineThinkingDelta(
  previous: ChatExecutionTimelineItem[],
  delta: string,
  order: number,
) {
  if (!delta) {
    return previous;
  }

  const lastItem = previous[previous.length - 1];
  if (lastItem?.kind === "thinking") {
    const nextItem: ChatExecutionTimelineItem = {
      ...lastItem,
      text: `${lastItem.text}${delta}`,
    };
    return [...previous.slice(0, -1), nextItem];
  }

  const nextItem: ChatExecutionTimelineItem = {
    id: `thinking:${order}`,
    kind: "thinking",
    text: delta,
    order,
  };
  return [...previous, nextItem];
}

function upsertExecutionTimelineTraceItem(
  previous: ChatExecutionTimelineItem[],
  step: ChatTraceStep,
) {
  const existingIndex = previous.findIndex(
    (item) => item.kind === "trace_step" && item.step.id === step.id,
  );
  if (existingIndex < 0) {
    const nextItem: ChatExecutionTimelineItem = {
      id: `trace:${step.id}`,
      kind: "trace_step",
      step,
      order: step.order,
    };
    return [...previous, nextItem].sort(
      (left, right) => left.order - right.order,
    );
  }

  return previous.map((item, index) =>
    index === existingIndex && item.kind === "trace_step"
      ? ({
          ...item,
          step: mergeTraceStep(item.step, step),
        } satisfies ChatExecutionTimelineItem)
      : item,
  );
}

function finalizeExecutionTimelineTraceItems(
  previous: ChatExecutionTimelineItem[],
  status: Extract<ChatTraceStepStatus, "completed" | "error" | "waiting">,
) {
  return previous.map((item) =>
    item.kind === "trace_step" && item.step.status === "running"
      ? {
          ...item,
          step: {
            ...item.step,
            status,
          },
        }
      : item,
  );
}

function traceStepsFromExecutionItems(items: ChatExecutionTimelineItem[]) {
  return items
    .filter(
      (
        item,
      ): item is Extract<ChatExecutionTimelineItem, { kind: "trace_step" }> =>
        item.kind === "trace_step",
    )
    .map((item) => item.step);
}

function isTerminalSessionOutputEventType(eventType: string) {
  return eventType === "run_completed" || eventType === "run_failed";
}

function assistantHistoryStateFromOutputEvents(
  outputEvents: SessionOutputEventPayload[],
) {
  const orderedEvents = [...outputEvents].sort(
    (left, right) => left.sequence - right.sequence || left.id - right.id,
  );
  let segments: ChatAssistantSegment[] = [];
  let executionItems: ChatExecutionTimelineItem[] = [];
  let outputText = "";
  let outputTone: ChatMessage["tone"] = "default";
  let encounteredTerminalEvent = false;
  let failureText = "";
  let terminalCreatedAt = "";

  const flushExecutionSegment = () => {
    if (executionItems.length === 0) {
      return;
    }
    segments = appendAssistantExecutionSegment(segments, executionItems);
    executionItems = [];
  };

  const flushOutputSegment = () => {
    if (!outputText) {
      return;
    }
    segments = appendAssistantOutputSegment(segments, outputText, outputTone);
    outputText = "";
    outputTone = "default";
  };

  const hasAssistantOutput =
    outputText.trim().length > 0 ||
    segments.some(
      (segment) => segment.kind === "output" && segment.text.trim().length > 0,
    );

  for (const event of orderedEvents) {
    if (encounteredTerminalEvent) {
      continue;
    }
    const eventPayload = isRecord(event.payload) ? event.payload : {};

    if (event.event_type === "thinking_delta") {
      flushOutputSegment();
      const delta =
        typeof eventPayload.delta === "string" ? eventPayload.delta : "";
      executionItems = appendExecutionTimelineThinkingDelta(
        executionItems,
        delta,
        event.sequence,
      );
    }

    const phaseStep = phaseTraceStepFromEvent(
      event.event_type,
      eventPayload,
      event.sequence,
    );
    if (phaseStep) {
      flushOutputSegment();
      const nextSegments = upsertAssistantExecutionTraceStep(
        segments,
        phaseStep,
      );
      if (nextSegments) {
        segments = nextSegments;
      } else {
        executionItems = upsertExecutionTimelineTraceItem(
          executionItems,
          phaseStep,
        );
      }
    }

    const toolStep = toolTraceStepFromEvent(
      event.event_type,
      eventPayload,
      event.sequence,
    );
    if (toolStep) {
      flushOutputSegment();
      const nextSegments = upsertAssistantExecutionTraceStep(
        segments,
        toolStep,
      );
      if (nextSegments) {
        segments = nextSegments;
      } else {
        executionItems = upsertExecutionTimelineTraceItem(
          executionItems,
          toolStep,
        );
      }
    }

    if (event.event_type === "output_delta") {
      flushExecutionSegment();
      const delta =
        typeof eventPayload.delta === "string" ? eventPayload.delta : "";
      outputText = `${outputText}${delta}`;
    }

    if (event.event_type === "run_completed") {
      const completedStatus =
        typeof eventPayload.status === "string"
          ? eventPayload.status.trim().toLowerCase()
          : "";
      segments = finalizeAssistantExecutionSegments(
        segments,
        completedStatus === "paused" || completedStatus === "waiting_user"
          ? "waiting"
          : "completed",
      );
      executionItems = finalizeExecutionTimelineTraceItems(
        executionItems,
        completedStatus === "paused" || completedStatus === "waiting_user"
          ? "waiting"
          : "completed",
      );
    } else if (event.event_type === "run_failed") {
      segments = finalizeAssistantExecutionSegments(segments, "error");
      executionItems = finalizeExecutionTimelineTraceItems(
        executionItems,
        "error",
      );
      failureText = runFailedDetail(eventPayload);
      terminalCreatedAt = event.created_at;
      if (!hasAssistantOutput) {
        flushExecutionSegment();
        outputText = failureText;
        outputTone = "error";
      }
    }

    if (isTerminalSessionOutputEventType(event.event_type)) {
      encounteredTerminalEvent = true;
    }
  }

  flushOutputSegment();
  flushExecutionSegment();

  return {
    segments: segments.length > 0 ? segments : undefined,
    executionItems: executionItems.length > 0 ? executionItems : undefined,
    failureText: failureText || undefined,
    terminalCreatedAt: terminalCreatedAt || undefined,
  };
}

function isNearChatBottom(container: HTMLDivElement) {
  const remaining =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
}

function latestVisibleChatMessageId(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageId = messages[index]?.id?.trim() || "";
    if (messageId) {
      return messageId;
    }
  }
  return "";
}

function chatMessageTimeLabel(value: string | null | undefined): string {
  const timestamp = Date.parse(value || "");
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

async function copyTextToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
}

function hasActiveChatSelection(container: HTMLDivElement | null) {
  if (!container || typeof window === "undefined") {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }

  return (
    container.contains(selection.anchorNode) ||
    container.contains(selection.focusNode)
  );
}

interface ChatPaneSessionOpenRequest {
  sessionId: string;
  requestKey: number;
  mode?: "session" | "draft";
  parentSessionId?: string | null;
  readOnly?: boolean;
}

interface PendingSessionTarget {
  requestKey: number;
  mode: "session" | "draft";
  sessionId: string | null;
  parentSessionId: string | null;
}

interface ChatPaneComposerPrefillRequest {
  text: string;
  requestKey: number;
  mode?: "replace" | "append";
}

interface ChatPaneExplorerAttachmentRequest {
  files: ExplorerAttachmentDragPayload[];
  requestKey: number;
}

interface ChatPaneBrowserJumpRequest {
  sessionId: string;
  requestKey: number;
}

interface ChatPaneArtifactBrowserRequest {
  workspaceId: string;
  outputs: WorkspaceOutputRecordPayload[];
  requestKey: number;
  scope?: "reply" | "session";
}

interface ChatPaneProps {
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onSyncFileDisplayFromAgentOperation?: (path: string) => void;
  onImageAttachmentPreviewOpenChange?: (open: boolean) => void;
  focusRequestKey?: number;
  variant?: ChatPaneVariant;
  onOpenLinkInBrowser?: (url: string) => void;
  onOpenLocalLink?: (href: string) => void;
  sessionJumpSessionId?: string | null;
  sessionJumpRequestKey?: number;
  sessionOpenRequest?: ChatPaneSessionOpenRequest | null;
  onSessionOpenRequestConsumed?: (requestKey: number) => void;
  composerPrefillRequest?: ChatPaneComposerPrefillRequest | null;
  onComposerPrefillConsumed?: (requestKey: number) => void;
  explorerAttachmentRequest?: ChatPaneExplorerAttachmentRequest | null;
  onExplorerAttachmentRequestConsumed?: (requestKey: number) => void;
  artifactBrowserRequest?: ChatPaneArtifactBrowserRequest | null;
  onArtifactBrowserRequestConsumed?: (requestKey: number) => void;
  onActiveSessionIdChange?: (sessionId: string | null) => void;
  browserJumpRequest?: ChatPaneBrowserJumpRequest | null;
  onBrowserJumpRequestConsumed?: (
    sessionId: string,
    requestKey: number,
  ) => void;
  onJumpToSessionBrowser?: (sessionId: string, requestKey: number) => void;
  onOpenSessions?: () => void;
  onOpenInbox?: () => void;
  inboxUnreadCount?: number;
  onOpenAutomations?: () => void;
  composerDraftText?: string;
  onComposerDraftTextChange?: (text: string) => void;
}

export function ChatPane({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  focusRequestKey = 0,
  variant = "default",
  onOpenLinkInBrowser,
  onOpenLocalLink,
  sessionJumpSessionId = null,
  sessionJumpRequestKey = 0,
  sessionOpenRequest = null,
  onSessionOpenRequestConsumed,
  composerPrefillRequest = null,
  onComposerPrefillConsumed,
  explorerAttachmentRequest = null,
  onExplorerAttachmentRequestConsumed,
  artifactBrowserRequest = null,
  onArtifactBrowserRequestConsumed,
  onActiveSessionIdChange,
  browserJumpRequest = null,
  onBrowserJumpRequestConsumed,
  onJumpToSessionBrowser,
  onOpenSessions,
  onOpenInbox,
  inboxUnreadCount = 0,
  onOpenAutomations,
  composerDraftText = "",
  onComposerDraftTextChange,
}: ChatPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const authSessionState = useDesktopAuthSession();
  const {
    hasHostedBillingAccount,
    isLowBalance,
    isOutOfCredits,
    links: billingLinks,
    refresh: refreshBillingState,
  } = useDesktopBilling();
  const {
    runtimeConfig,
    selectedWorkspace,
    isLoadingBootstrap,
    isActivatingWorkspace,
    workspaceAppsReady,
    workspaceBlockingReason,
    refreshWorkspaceData,
  } = useWorkspaceDesktop();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionOutputs, setSessionOutputs] = useState<
    WorkspaceOutputRecordPayload[]
  >([]);
  const [liveAssistantSegments, setLiveAssistantSegments] = useState<
    ChatAssistantSegment[]
  >([]);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [liveAgentStatus, setLiveAgentStatus] = useState("");
  const [liveExecutionItems, setLiveExecutionItems] = useState<
    ChatExecutionTimelineItem[]
  >([]);
  const [collapsedTraceByStepId, setCollapsedTraceByStepId] = useState<
    Record<string, boolean>
  >({});
  const [input, setInput] = useState(() => composerDraftText);
  const [quotedSkillIds, setQuotedSkillIds] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [availableWorkspaceSkills, setAvailableWorkspaceSkills] = useState<
    WorkspaceSkillRecordPayload[]
  >([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);
  const [loadedHistoryMessageCount, setLoadedHistoryMessageCount] = useState(0);
  const [totalHistoryMessageCount, setTotalHistoryMessageCount] = useState(0);
  const [isResponding, setIsResponding] = useState(false);
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false);
  const [isPausePending, setIsPausePending] = useState(false);
  const [chatErrorMessage, setChatErrorMessage] = useState("");
  const [backgroundDeliveryStatusMessage, setBackgroundDeliveryStatusMessage] =
    useState("");
  const [attachmentGateMessage, setAttachmentGateMessage] = useState("");
  const [verboseTelemetryEnabled, setVerboseTelemetryEnabled] = useState(false);
  const [composerBlockHeight, setComposerBlockHeight] = useState(0);
  const [chatModelPreference, setChatModelPreference] = useState(
    loadStoredChatModelPreference,
  );
  const [chatThinkingPreferences, setChatThinkingPreferences] = useState(
    loadStoredChatThinkingPreferences,
  );
  const [isHistoryViewportPending, setIsHistoryViewportPending] =
    useState(false);
  const [
    historyViewportRestoreGeneration,
    setHistoryViewportRestoreGeneration,
  ] = useState(0);
  const [streamTelemetry, setStreamTelemetry] = useState<
    StreamTelemetryEntry[]
  >([]);
  const streamTelemetryRingRef = useRef<StreamTelemetryEntry[]>([]);
  const streamTelemetryFlushTimerRef = useRef<number | null>(null);
  const [artifactBrowserOpen, setArtifactBrowserOpen] = useState(false);
  const [artifactBrowserFilter, setArtifactBrowserFilter] =
    useState<ArtifactBrowserFilter>("all");
  const [artifactBrowserScopedOutputs, setArtifactBrowserScopedOutputs] =
    useState<WorkspaceOutputRecordPayload[] | null>(null);
  const [artifactBrowserScope, setArtifactBrowserScope] = useState<
    "session" | "reply"
  >("session");
  const [imageAttachmentPreview, setImageAttachmentPreview] =
    useState<ImageAttachmentPreviewState | null>(null);
  const [memoryProposalAction, setMemoryProposalAction] = useState<{
    proposalId: string;
    action: "accept" | "dismiss";
  } | null>(null);
  const [queuedSessionInputs, setQueuedSessionInputs] = useState<
    QueuedSessionInput[]
  >([]);
  const [pendingOptimisticUserMessages, setPendingOptimisticUserMessages] =
    useState<PendingOptimisticUserMessage[]>([]);
  const [editingMemoryProposalId, setEditingMemoryProposalId] = useState<
    string | null
  >(null);
  const [memoryProposalDrafts, setMemoryProposalDrafts] = useState<
    Record<string, string>
  >({});
  const [desktopMainSession, setDesktopMainSession] =
    useState<AgentSessionRecordPayload | null>(null);
  const [sessionRecordOverrides, setSessionRecordOverrides] = useState<
    Record<string, AgentSessionRecordPayload>
  >({});
  const [activeSessionReadOnly, setActiveSessionReadOnly] = useState(false);
  const [localSessionOpenRequest, setLocalSessionOpenRequest] =
    useState<ChatPaneSessionOpenRequest | null>(null);
  const [visibleBrowserState, setVisibleBrowserState] =
    useState<BrowserTabListPayload>(() => initialBrowserState("user"));
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerBlockRef = useRef<HTMLDivElement>(null);
  const composerIsComposingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const [isAwayFromChatBottom, setIsAwayFromChatBottom] = useState(false);
  const pendingOptimisticUserMessagesRef = useRef<
    PendingOptimisticUserMessage[]
  >([]);
  const lastChatScrollTopRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const activeSessionReadOnlyRef = useRef(false);
  const imageAttachmentPreviewObjectUrlRef = useRef<string | null>(null);
  const imageAttachmentPreviewRequestIdRef = useRef(0);
  const terminalEventTypeByInputIdRef = useRef<
    Map<string, "run_completed" | "run_failed">
  >(new Map());
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const lastSyncedAgentOperationFileKeyRef = useRef("");
  const pendingInputIdRef = useRef<string | null>(null);
  const loadedHistoryOutputEventsRef = useRef<SessionOutputEventPayload[]>([]);
  const pendingHistoryPrependRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const lastSubmittedComposerInputRef =
    useRef<ComposerInputRecallSnapshot | null>(null);
  const lastCancelledComposerInputRef =
    useRef<ComposerInputRecallSnapshot | null>(null);
  const isLoadingOlderHistoryRef = useRef(false);
  const seenMainDebugKeysRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<WorkspaceRecordPayload | null>(null);
  const desktopMainSessionIdRef = useRef("");
  const playedMainSessionCompletionChimeKeysRef = useRef<Set<string>>(
    new Set(),
  );
  const isOnboardingVariant = variant === "onboarding";
  const pendingFocusRequestKeyRef = useRef<number | null>(focusRequestKey);
  const lastHandledSessionJumpRequestKeyRef = useRef(0);
  const lastHandledExternalSessionOpenRequestKeyRef = useRef(0);
  const lastHandledLocalSessionOpenRequestKeyRef = useRef(0);
  const lastHandledComposerPrefillRequestKeyRef = useRef(0);
  const lastHandledExplorerAttachmentRequestKeyRef = useRef(0);
  const lastHandledArtifactBrowserRequestKeyRef = useRef(0);
  const consumedSessionOpenRequestKeysRef = useRef<Set<number>>(new Set());
  const localSessionOpenRequestRef = useRef<ChatPaneSessionOpenRequest | null>(
    null,
  );
  const previousSelectedWorkspaceIdRef = useRef(
    (selectedWorkspaceId || "").trim(),
  );
  const mainSessionEventBatchInputIdsRef = useRef<Set<string>>(new Set());
  const draftParentSessionIdRef = useRef<string | null>(null);
  const draftHydrationWorkspaceIdRef = useRef(
    (selectedWorkspaceId || "").trim(),
  );
  const skipNextComposerDraftPublishRef = useRef(false);
  const liveAssistantSegmentsRef = useRef<ChatAssistantSegment[]>([]);
  const liveAssistantTextRef = useRef("");
  const liveAssistantFlushFrameRef = useRef<number | null>(null);
  const liveExecutionItemsRef = useRef<ChatExecutionTimelineItem[]>([]);
  const historyViewportGenerationRef = useRef(0);
  const [activeSessionId, setActiveSessionId] = useState("");
  const effectiveSessionOpenRequest =
    sessionOpenRequest ?? localSessionOpenRequest;
  localSessionOpenRequestRef.current = localSessionOpenRequest;
  const isExternalSessionOpenRequest = sessionOpenRequest !== null;

  function appendStreamTelemetry(
    entry: Omit<StreamTelemetryEntry, "id" | "at">,
  ) {
    if (!verboseTelemetryEnabled) {
      return;
    }
    const at = new Date().toISOString().slice(11, 23);
    const next: StreamTelemetryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at,
      ...entry,
    };
    const ring = streamTelemetryRingRef.current;
    ring.push(next);
    if (ring.length > STREAM_TELEMETRY_LIMIT) {
      ring.splice(0, ring.length - STREAM_TELEMETRY_LIMIT);
    }
    if (streamTelemetryFlushTimerRef.current === null) {
      streamTelemetryFlushTimerRef.current = window.setTimeout(() => {
        streamTelemetryFlushTimerRef.current = null;
        setStreamTelemetry(streamTelemetryRingRef.current.slice());
      }, 250);
    }
  }

  useEffect(
    () => () => {
      if (streamTelemetryFlushTimerRef.current !== null) {
        window.clearTimeout(streamTelemetryFlushTimerRef.current);
      }
    },
    [],
  );

  async function closeStreamWithReason(streamId: string, reason: string) {
    appendStreamTelemetry({
      streamId,
      transportType: "client",
      eventName: "closeSessionOutputStream",
      eventType: "close_request",
      inputId: pendingInputIdRef.current || "",
      sessionId: activeSessionIdRef.current || "",
      action: "close_requested",
      detail: reason,
    });
    await window.electronAPI.workspace.closeSessionOutputStream(
      streamId,
      reason,
    );
  }

  function rememberSubmittedComposerInput(text: string, workspaceId: string) {
    if (!text.trim() || !workspaceId.trim()) {
      return;
    }
    lastSubmittedComposerInputRef.current = {
      workspaceId: workspaceId.trim(),
      text,
      at: Date.now(),
    };
  }

  function cancelComposerDraftFromKeyboard() {
    const workspaceId = (selectedWorkspaceId || "").trim();
    const hasDraftState =
      input.trim().length > 0 ||
      quotedSkillIds.length > 0 ||
      pendingAttachments.length > 0;
    if (!hasDraftState) {
      return false;
    }
    if (input.trim().length > 0 && workspaceId) {
      lastCancelledComposerInputRef.current = {
        workspaceId,
        text: input,
        at: Date.now(),
      };
    }
    setInput("");
    setQuotedSkillIds([]);
    setPendingAttachments([]);
    setAttachmentGateMessage("");
    return true;
  }

  function recallLatestComposerInput() {
    const workspaceId = (selectedWorkspaceId || "").trim();
    if (!workspaceId) {
      return false;
    }
    const recallableInput = [
      lastSubmittedComposerInputRef.current,
      lastCancelledComposerInputRef.current,
    ]
      .filter(
        (entry): entry is ComposerInputRecallSnapshot =>
          Boolean(entry && entry.workspaceId === workspaceId && entry.text.trim()),
      )
      .sort((left, right) => right.at - left.at)[0];
    if (!recallableInput) {
      return false;
    }
    setInput(recallableInput.text);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const cursorPosition = textarea.value.length;
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    });
    return true;
  }

  function setActiveSession(sessionId: string | null) {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId ?? "");
    onActiveSessionIdChange?.(sessionId);
  }

  function setLocalSessionOpenRequestState(
    next:
      | ChatPaneSessionOpenRequest
      | null
      | ((
          current: ChatPaneSessionOpenRequest | null,
        ) => ChatPaneSessionOpenRequest | null),
  ) {
    setLocalSessionOpenRequest((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      localSessionOpenRequestRef.current = resolved;
      return resolved;
    });
  }

  function markSessionOpenRequestConsumed(requestKey: number) {
    if (!Number.isFinite(requestKey) || requestKey <= 0) {
      return;
    }
    const consumedKeys = consumedSessionOpenRequestKeysRef.current;
    consumedKeys.add(requestKey);
    while (consumedKeys.size > 32) {
      const oldestKey = consumedKeys.values().next().value;
      if (typeof oldestKey !== "number") {
        break;
      }
      consumedKeys.delete(oldestKey);
    }
  }

  function isSessionOpenRequestConsumed(requestKey: number): boolean {
    if (!Number.isFinite(requestKey) || requestKey <= 0) {
      return false;
    }
    return consumedSessionOpenRequestKeysRef.current.has(requestKey);
  }

  function consumeSessionOpenRequest(requestKey: number) {
    markSessionOpenRequestConsumed(requestKey);
    if (isExternalSessionOpenRequest) {
      onSessionOpenRequestConsumed?.(requestKey);
      return;
    }
    setLocalSessionOpenRequestState((current) =>
      current?.requestKey === requestKey ? null : current,
    );
  }

  function pendingSessionTargetForSend(): PendingSessionTarget | null {
    const currentSessionOpenRequest =
      sessionOpenRequest ?? localSessionOpenRequestRef.current;
    const requestKey = currentSessionOpenRequest?.requestKey ?? 0;
    if (requestKey <= 0) {
      return null;
    }
    const requestMode = currentSessionOpenRequest?.mode ?? "session";
    const requestedSessionId = (
      currentSessionOpenRequest?.sessionId || ""
    ).trim();
    const requestedParentSessionId =
      currentSessionOpenRequest?.parentSessionId?.trim() || null;

    if (requestMode === "draft") {
      return {
        requestKey,
        mode: "draft",
        sessionId: null,
        parentSessionId: requestedParentSessionId,
      };
    }

    if (
      requestedSessionId &&
      requestedSessionId !== activeSessionIdRef.current
    ) {
      return {
        requestKey,
        mode: "session",
        sessionId: requestedSessionId,
        parentSessionId: null,
      };
    }

    return null;
  }

  function beginHistoryViewportRestore() {
    historyViewportGenerationRef.current += 1;
    shouldAutoScrollRef.current = true;
    setIsHistoryViewportPending(true);
  }

  function requestHistoryViewportRestore() {
    setHistoryViewportRestoreGeneration(historyViewportGenerationRef.current);
  }

  function cancelHistoryViewportRestore() {
    historyViewportGenerationRef.current += 1;
    setIsHistoryViewportPending(false);
  }

  function setIsLoadingOlderHistoryState(nextValue: boolean) {
    isLoadingOlderHistoryRef.current = nextValue;
    setIsLoadingOlderHistory(nextValue);
  }

  function updatePendingOptimisticUserMessagesState(
    nextValue:
      | PendingOptimisticUserMessage[]
      | ((
          current: PendingOptimisticUserMessage[],
        ) => PendingOptimisticUserMessage[]),
  ) {
    const next =
      typeof nextValue === "function"
        ? nextValue(pendingOptimisticUserMessagesRef.current)
        : nextValue;
    pendingOptimisticUserMessagesRef.current = next;
    setPendingOptimisticUserMessages(next);
  }

  function resetLiveTurn() {
    cancelLiveAssistantFlush();
    liveAssistantSegmentsRef.current = [];
    liveAssistantTextRef.current = "";
    liveExecutionItemsRef.current = [];
    activeAssistantMessageIdRef.current = null;
    lastSyncedAgentOperationFileKeyRef.current = "";
    setLiveAssistantSegments([]);
    setLiveAssistantText("");
    setLiveAgentStatus("");
    setLiveExecutionItems([]);
  }

  function rememberMainSessionEventBatchInput(
    inputId: string,
    payload: Record<string, unknown>,
  ) {
    const instructionPreview =
      typeof payload.instruction_preview === "string"
        ? payload.instruction_preview
        : "";
    if (
      !inputId ||
      !isMainSessionEventBatchInstructionPreview(instructionPreview)
    ) {
      return false;
    }
    mainSessionEventBatchInputIdsRef.current.add(inputId);
    return true;
  }

  function isRememberedMainSessionEventBatchInput(inputId: string) {
    return Boolean(
      inputId && mainSessionEventBatchInputIdsRef.current.has(inputId),
    );
  }

  function forgetMainSessionEventBatchInput(inputId: string) {
    if (!inputId) {
      return;
    }
    mainSessionEventBatchInputIdsRef.current.delete(inputId);
  }

  function liveAssistantHasVisibleOutput() {
    return (
      Boolean(liveAssistantTextRef.current.trim()) ||
      assistantSegmentsIncludeOutput(liveAssistantSegmentsRef.current)
    );
  }

  function clearSessionView() {
    setMessages([]);
    setSessionOutputs([]);
    setLoadedHistoryMessageCount(0);
    setTotalHistoryMessageCount(0);
    setIsLoadingOlderHistoryState(false);
    setArtifactBrowserOpen(false);
    setArtifactBrowserFilter("all");
    setArtifactBrowserScopedOutputs(null);
    setArtifactBrowserScope("session");
    setBackgroundDeliveryStatusMessage("");
    setMemoryProposalAction(null);
    setEditingMemoryProposalId(null);
    setMemoryProposalDrafts({});
    loadedHistoryOutputEventsRef.current = [];
    mainSessionEventBatchInputIdsRef.current.clear();
    pendingHistoryPrependRestoreRef.current = null;
    resetLiveTurn();
    setCollapsedTraceByStepId({});
    terminalEventTypeByInputIdRef.current.clear();
    shouldAutoScrollRef.current = true;
  }

  function upsertSessionRecordOverride(record: AgentSessionRecordPayload) {
    const sessionId = record.session_id.trim();
    if (!sessionId) {
      return;
    }
    setSessionRecordOverrides((current) => ({
      ...current,
      [sessionId]: record,
    }));
  }

  function isSessionHistoryTargetActive(
    sessionId: string,
    workspaceId: string,
  ) {
    return (
      activeSessionIdRef.current === sessionId &&
      (selectedWorkspaceRef.current?.id || "").trim() === workspaceId
    );
  }

  function recordTerminalEventForInput(
    inputId: string,
    eventType: "run_completed" | "run_failed",
  ) {
    const normalizedInputId = inputId.trim();
    if (!normalizedInputId) {
      return null;
    }
    const priorEventType =
      terminalEventTypeByInputIdRef.current.get(normalizedInputId) ?? null;
    if (priorEventType) {
      return priorEventType;
    }
    terminalEventTypeByInputIdRef.current.set(normalizedInputId, eventType);
    while (terminalEventTypeByInputIdRef.current.size > 64) {
      const oldestInputId = terminalEventTypeByInputIdRef.current
        .keys()
        .next().value;
      if (typeof oldestInputId !== "string") {
        break;
      }
      terminalEventTypeByInputIdRef.current.delete(oldestInputId);
    }
    return null;
  }

  function historyMessagesFromSessionState(
    sessionId: string,
    historyMessages: SessionHistoryMessagePayload[],
    outputEvents: SessionOutputEventPayload[],
    outputs: WorkspaceOutputRecordPayload[],
    memoryProposals: MemoryUpdateProposalRecordPayload[],
    knownAssistantInputIds: Set<string> = new Set(),
  ): ChatMessage[] {
    return chatMessagesFromSessionState({
      historyMessages,
      outputEvents,
      outputs,
      memoryProposals,
      knownAssistantInputIds,
      showExecutionInternals:
        shouldShowExecutionInternalsForSession(sessionId),
    });
  }

  async function loadSessionHistoryPage(
    params: {
      sessionId: string;
      workspaceId: string;
      limit: number;
      offset: number;
      order: "asc" | "desc";
    },
    options?: {
      cancelled?: () => boolean;
      knownAssistantInputIds?: Set<string>;
    },
  ) {
    const cancelled = options?.cancelled ?? (() => false);
    const history = await window.electronAPI.workspace.getSessionHistory({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      limit: params.limit,
      offset: params.offset,
      order: params.order,
    });
    if (cancelled()) {
      return null;
    }

    const historyMessages = historyMessagesInDisplayOrder(
      history.messages,
      params.order,
    );
    const assistantInputIds = turnInputIdsFromHistoryMessages(historyMessages);
    if (assistantInputIds.length === 0) {
      return {
        history,
        historyMessages,
        warnings: [] as string[],
        outputEvents: [] as SessionOutputEventPayload[],
        outputs: [] as WorkspaceOutputRecordPayload[],
        memoryProposals: [] as MemoryUpdateProposalRecordPayload[],
        renderedMessages: historyMessagesFromSessionState(
          params.sessionId,
          historyMessages,
          [],
          [],
          [],
          options?.knownAssistantInputIds,
        ),
      };
    }

    const auxiliaryHistoryWarnings: string[] = [];
    const artifactResponses = await Promise.all(
      assistantInputIds.map(async (inputId) => {
        const [outputEventsResult, outputListResult, memoryProposalListResult] =
          await Promise.allSettled([
            window.electronAPI.workspace.getSessionOutputEvents({
              workspaceId: params.workspaceId,
              sessionId: params.sessionId,
              inputId,
            }),
            window.electronAPI.workspace.listOutputs({
              workspaceId: params.workspaceId,
              sessionId: params.sessionId,
              inputId,
              limit: 200,
            }),
            window.electronAPI.workspace.listMemoryUpdateProposals({
              workspaceId: params.workspaceId,
              sessionId: params.sessionId,
              inputId,
              limit: 200,
            }),
          ]);
        if (outputEventsResult.status !== "fulfilled") {
          auxiliaryHistoryWarnings.push(
            optionalHistoryLoadErrorMessage(
              "Execution history",
              outputEventsResult.reason,
            ),
          );
        }
        if (outputListResult.status !== "fulfilled") {
          auxiliaryHistoryWarnings.push(
            optionalHistoryLoadErrorMessage(
              "Artifacts",
              outputListResult.reason,
            ),
          );
        }
        if (memoryProposalListResult.status !== "fulfilled") {
          auxiliaryHistoryWarnings.push(
            optionalHistoryLoadErrorMessage(
              "Memory proposals",
              memoryProposalListResult.reason,
            ),
          );
        }
        return {
          outputEvents:
            outputEventsResult.status === "fulfilled"
              ? outputEventsResult.value.items
              : [],
          outputs:
            outputListResult.status === "fulfilled"
              ? outputListResult.value.items
              : [],
          memoryProposals:
            memoryProposalListResult.status === "fulfilled"
              ? memoryProposalListResult.value.proposals
              : [],
        };
      }),
    );
    if (cancelled()) {
      return null;
    }

    const outputEvents = mergeSessionOutputEvents(
      [],
      artifactResponses.flatMap((entry) => entry.outputEvents),
    );
    const outputs = mergeSessionOutputs(
      [],
      artifactResponses.flatMap((entry) => entry.outputs),
    );
    const memoryProposals = mergeMemoryUpdateProposals(
      [],
      artifactResponses.flatMap((entry) => entry.memoryProposals),
    );

    return {
      history,
      historyMessages,
      warnings: auxiliaryHistoryWarnings,
      outputEvents,
      outputs,
      memoryProposals,
      renderedMessages: historyMessagesFromSessionState(
        params.sessionId,
        historyMessages,
        outputEvents,
        outputs,
        memoryProposals,
        options?.knownAssistantInputIds,
      ),
    };
  }

  async function loadSessionConversation(
    nextSessionId: string | null,
    workspaceId: string,
    runtimeStates: SessionRuntimeRecordPayload[],
    options?: {
      cancelled?: () => boolean;
      readOnly?: boolean;
    },
  ) {
    const cancelled = options?.cancelled ?? (() => false);
    if (typeof options?.readOnly === "boolean") {
      setActiveSessionReadOnly(options.readOnly);
    }

    if (activeSessionIdRef.current !== nextSessionId) {
      clearSessionView();
    }
    setActiveSession(nextSessionId);
    if (!nextSessionId) {
      requestHistoryViewportRestore();
      return;
    }

    const page = await loadSessionHistoryPage(
      {
        sessionId: nextSessionId,
        workspaceId,
        limit: CHAT_HISTORY_PAGE_SIZE,
        offset: 0,
        order: "desc",
      },
      { cancelled },
    );
    if (!page || cancelled()) {
      return;
    }

    loadedHistoryOutputEventsRef.current = page.outputEvents;
    setSessionOutputs(page.outputs);
    setLoadedHistoryMessageCount(page.history.count);
    setTotalHistoryMessageCount(page.history.total);
    setIsLoadingOlderHistoryState(false);
    pendingHistoryPrependRestoreRef.current = null;
    setChatErrorMessage(page.warnings.join(" "));
    const shouldPreservePendingPlaceholder =
      pendingInputIdRef.current === STREAM_ATTACH_PENDING;
    if (!shouldPreservePendingPlaceholder) {
      resetLiveTurn();
    }
    requestHistoryViewportRestore();

    const onboardingSessionId = (
      selectedWorkspaceRef.current?.onboarding_session_id || ""
    ).trim();
    const currentRuntimeState = runtimeStates.find(
      (item) => item.session_id === nextSessionId,
    );
    const currentRuntimeStatus =
      runtimeStateEffectiveStatus(currentRuntimeState);
    const currentRuntimeInputId = (
      currentRuntimeState?.current_input_id || ""
    ).trim();
    const persistedInputIds = new Set(
      turnInputIdsFromHistoryMessages(page.history.messages),
    );
    const shouldAttachLiveRunStream =
      !activeStreamIdRef.current &&
      !pendingInputIdRef.current &&
      ["BUSY", "QUEUED"].includes(currentRuntimeStatus);
    const renderedMessagesForDisplay =
      shouldAttachLiveRunStream && currentRuntimeInputId
        ? page.renderedMessages.filter(
            (message) =>
              message.role !== "assistant" ||
              inputIdFromMessageId(message.id, "assistant") !==
                currentRuntimeInputId,
          )
        : page.renderedMessages;
    const reconciledPendingOptimisticUserMessages =
      reconcilePendingOptimisticUserMessages(
        pendingOptimisticUserMessagesRef.current,
        {
          workspaceId,
          sessionId: nextSessionId,
          persistedInputIds,
        },
      );
    updatePendingOptimisticUserMessagesState(
      reconciledPendingOptimisticUserMessages,
    );
    setMessages(
      mergePendingOptimisticUserMessages(
        renderedMessagesForDisplay,
        reconciledPendingOptimisticUserMessages,
        {
          workspaceId,
          sessionId: nextSessionId,
        },
      ),
    );
    setQueuedSessionInputs((current) =>
      reconcileQueuedSessionInputs(current, {
        workspaceId,
        sessionId: nextSessionId,
        persistedInputIds,
        activeInputId: currentRuntimeInputId,
        activeStatus: currentRuntimeStatus,
      }),
    );
    const hasAssistantMessage = renderedMessagesForDisplay.some(
      (message) => message.role === "assistant",
    );
    const shouldAttachOnboardingBootstrapStream =
      shouldAttachLiveRunStream &&
      isOnboardingVariant &&
      nextSessionId === onboardingSessionId &&
      !hasAssistantMessage &&
      currentRuntimeStatus === "BUSY";

    if (shouldAttachLiveRunStream) {
      setIsResponding(true);
      setLiveAgentStatus(
        shouldAttachOnboardingBootstrapStream
          ? "Preparing first question"
          : currentRuntimeStatus === "QUEUED"
            ? "Queued"
            : "Working",
      );
      setChatErrorMessage("");
      const stream = await window.electronAPI.workspace.openSessionOutputStream(
        {
          sessionId: nextSessionId,
          workspaceId,
          inputId: currentRuntimeInputId || undefined,
          includeHistory: Boolean(currentRuntimeInputId),
          stopOnTerminal: true,
        },
      );
      if (cancelled()) {
        await closeStreamWithReason(
          stream.streamId,
          "load_history_cancelled",
        ).catch(() => undefined);
        return;
      }
      activeStreamIdRef.current = stream.streamId;
      appendStreamTelemetry({
        streamId: stream.streamId,
        transportType: "client",
        eventName: "openSessionOutputStream",
        eventType: shouldAttachOnboardingBootstrapStream
          ? "stream_open_onboarding_bootstrap"
          : "stream_open_existing_run",
        inputId: "",
        sessionId: nextSessionId,
        action: shouldAttachOnboardingBootstrapStream
          ? "stream_requested_onboarding_bootstrap"
          : "stream_requested_existing_run",
        detail: shouldAttachOnboardingBootstrapStream
          ? `attached to in-flight onboarding opener input=${currentRuntimeInputId || "latest"}`
          : `attached to in-flight session run input=${currentRuntimeInputId || "latest"}`,
      });
    } else if (!activeStreamIdRef.current && !pendingInputIdRef.current) {
      setIsResponding(false);
    }
  }

  async function createWorkspaceSession(
    workspaceId: string,
    parentSessionId?: string | null,
  ): Promise<string | null> {
    const created = await window.electronAPI.workspace.createAgentSession({
      workspace_id: workspaceId,
      kind: "workspace_session",
      parent_session_id: parentSessionId?.trim() || null,
      created_by: "workspace_user",
    });
    const sessionId = created.session.session_id.trim();
    return sessionId || null;
  }

  async function loadOlderSessionHistory() {
    const sessionId = (activeSessionIdRef.current || "").trim();
    const workspaceId = (selectedWorkspaceRef.current?.id || "").trim();
    if (
      !sessionId ||
      !workspaceId ||
      isLoadingHistory ||
      isLoadingOlderHistoryRef.current ||
      pendingHistoryPrependRestoreRef.current ||
      loadedHistoryMessageCount >= totalHistoryMessageCount
    ) {
      return;
    }

    const container = messagesRef.current;
    if (container) {
      pendingHistoryPrependRestoreRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }
    shouldAutoScrollRef.current = false;
    setIsLoadingOlderHistoryState(true);

    try {
      const page = await loadSessionHistoryPage(
        {
          sessionId,
          workspaceId,
          limit: CHAT_HISTORY_PAGE_SIZE,
          offset: loadedHistoryMessageCount,
          order: "desc",
        },
        {
          knownAssistantInputIds: assistantInputIdsFromChatMessages(messages),
        },
      );
      if (!page || !isSessionHistoryTargetActive(sessionId, workspaceId)) {
        pendingHistoryPrependRestoreRef.current = null;
        return;
      }

      loadedHistoryOutputEventsRef.current = mergeSessionOutputEvents(
        loadedHistoryOutputEventsRef.current,
        page.outputEvents,
      );
      setSessionOutputs((prev) => mergeSessionOutputs(prev, page.outputs));
      setLoadedHistoryMessageCount((current) =>
        Math.max(current, page.history.offset + page.history.count),
      );
      setTotalHistoryMessageCount(page.history.total);
      if (page.renderedMessages.length === 0) {
        pendingHistoryPrependRestoreRef.current = null;
        return;
      }
      setMessages((prev) =>
        prependUniqueChatMessages(page.renderedMessages, prev),
      );
    } catch (error) {
      if (isSessionHistoryTargetActive(sessionId, workspaceId)) {
        pendingHistoryPrependRestoreRef.current = null;
        setChatErrorMessage(normalizeErrorMessage(error));
      }
    } finally {
      if (isSessionHistoryTargetActive(sessionId, workspaceId)) {
        setIsLoadingOlderHistoryState(false);
        return;
      }
      isLoadingOlderHistoryRef.current = false;
    }
  }

  function setLiveAssistantSegmentsState(nextSegments: ChatAssistantSegment[]) {
    liveAssistantSegmentsRef.current = nextSegments;
    setLiveAssistantSegments(nextSegments);
  }

  function shouldShowExecutionInternalsForSession(
    sessionId: string | null | undefined,
  ) {
    if (isOnboardingVariant) {
      return true;
    }
    const normalizedSessionId = (sessionId || "").trim();
    const mainSessionId = desktopMainSessionIdRef.current.trim();
    return Boolean(normalizedSessionId && normalizedSessionId !== mainSessionId);
  }

  function maybePlayMainSessionCompletionChime(params: {
    sessionId: string | null | undefined;
    inputId?: string | null;
    completedAt?: string | null;
    terminalStatus?: string | null;
  }) {
    if (isOnboardingVariant || activeSessionReadOnlyRef.current) {
      return;
    }
    const sessionId = (params.sessionId || "").trim();
    const mainSessionId = desktopMainSessionIdRef.current.trim();
    if (!sessionId || sessionId !== mainSessionId) {
      return;
    }
    if ((params.terminalStatus || "").trim().toLowerCase() === "paused") {
      return;
    }

    const uniqueToken =
      (params.inputId || "").trim() || (params.completedAt || "").trim();
    if (uniqueToken) {
      const chimeKey = `${selectedWorkspaceId || ""}:${sessionId}:${uniqueToken}`;
      const playedKeys = playedMainSessionCompletionChimeKeysRef.current;
      if (playedKeys.has(chimeKey)) {
        return;
      }
      if (playedKeys.size > 200) {
        playedKeys.clear();
      }
      playedKeys.add(chimeKey);
    }

    playMainSessionCompletionChime();
  }

  function flushLiveAssistantOutputSegment(
    tone: ChatMessage["tone"] = "default",
  ) {
    if (!liveAssistantTextRef.current) {
      return;
    }
    cancelLiveAssistantFlush();
    flushSync(() => {
      setLiveAssistantSegmentsState(
        appendAssistantOutputSegment(
          liveAssistantSegmentsRef.current,
          liveAssistantTextRef.current,
          tone,
        ),
      );
      liveAssistantTextRef.current = "";
      setLiveAssistantText("");
    });
  }

  function flushLiveExecutionSegment() {
    if (liveExecutionItemsRef.current.length === 0) {
      return;
    }
    flushSync(() => {
      setLiveAssistantSegmentsState(
        appendAssistantExecutionSegment(
          liveAssistantSegmentsRef.current,
          liveExecutionItemsRef.current,
        ),
      );
      liveExecutionItemsRef.current = [];
      setLiveExecutionItems([]);
    });
  }

  function cancelLiveAssistantFlush() {
    if (liveAssistantFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(liveAssistantFlushFrameRef.current);
      liveAssistantFlushFrameRef.current = null;
    }
  }

  function scheduleLiveAssistantFlush() {
    if (liveAssistantFlushFrameRef.current !== null) return;
    liveAssistantFlushFrameRef.current = window.requestAnimationFrame(() => {
      liveAssistantFlushFrameRef.current = null;
      setLiveAssistantText(liveAssistantTextRef.current);
    });
  }

  function appendLiveAssistantDelta(delta: string) {
    flushLiveExecutionSegment();
    liveAssistantTextRef.current = `${liveAssistantTextRef.current}${delta}`;
    scheduleLiveAssistantFlush();
  }

  function appendLiveThinkingDelta(delta: string, order: number) {
    flushLiveAssistantOutputSegment();
    flushSync(() => {
      setLiveExecutionItems((prev) => {
        const next = appendExecutionTimelineThinkingDelta(prev, delta, order);
        liveExecutionItemsRef.current = next;
        return next;
      });
    });
  }

  function commitLiveAssistantMessage(options?: {
    fallbackText?: string;
    tone?: ChatMessage["tone"];
  }) {
    const messageId =
      activeAssistantMessageIdRef.current ?? `assistant-${Date.now()}`;
    let nextSegments = liveAssistantSegmentsRef.current;

    if (liveExecutionItemsRef.current.length > 0) {
      nextSegments = appendAssistantExecutionSegment(
        nextSegments,
        liveExecutionItemsRef.current,
      );
    }

    if (liveAssistantTextRef.current) {
      nextSegments = appendAssistantOutputSegment(
        nextSegments,
        liveAssistantTextRef.current,
        "default",
      );
    }

    const hasOutputSegment = nextSegments.some(
      (segment) => segment.kind === "output" && Boolean(segment.text.trim()),
    );
    if (options?.fallbackText && !hasOutputSegment) {
      nextSegments = appendAssistantOutputSegment(
        nextSegments,
        options.fallbackText,
        options.tone ?? "default",
      );
    }

    if (nextSegments.length === 0) {
      resetLiveTurn();
      return false;
    }

    const nextMessage: ChatMessage = {
      id: messageId,
      role: "assistant",
      text: "",
      tone: "default",
      segments: nextSegments,
    };
    if (
      !hasRenderableAssistantTurn(nextMessage, {
        showExecutionInternals: shouldShowExecutionInternalsForSession(
          activeSessionIdRef.current,
        ),
      })
    ) {
      resetLiveTurn();
      return false;
    }

    setMessages((prev) => [...prev, nextMessage]);
    resetLiveTurn();
    return true;
  }

  function scheduleConversationRefresh(
    sessionId: string | null,
    workspaceId: string | null | undefined,
  ) {
    const normalizedSessionId = (sessionId || "").trim();
    const normalizedWorkspaceId = (workspaceId || "").trim();
    if (!normalizedSessionId || !normalizedWorkspaceId) {
      return;
    }

    const delays = [150, 500, 1_500, 3_000];
    for (const delayMs of delays) {
      window.setTimeout(() => {
        if (
          activeSessionIdRef.current !== normalizedSessionId ||
          selectedWorkspaceId !== normalizedWorkspaceId
        ) {
          return;
        }
        void window.electronAPI.workspace
          .listRuntimeStates(normalizedWorkspaceId)
          .then((runtimeStates) =>
            loadSessionConversation(
              normalizedSessionId,
              normalizedWorkspaceId,
              runtimeStates.items,
              {
                cancelled: () =>
                  activeSessionIdRef.current !== normalizedSessionId ||
                  selectedWorkspaceId !== normalizedWorkspaceId,
              },
            ),
          )
          .catch(() => undefined);
      }, delayMs);
    }
  }

  async function reconcileAutonomousMainSessionActivity(params: {
    workspaceId: string;
    mainSessionId: string;
    currentMessages: ChatMessage[];
    cancelled?: () => boolean;
  }) {
    const workspaceId = params.workspaceId.trim();
    const mainSessionId = params.mainSessionId.trim();
    const cancelled = params.cancelled ?? (() => false);
    if (
      !workspaceId ||
      !mainSessionId ||
      cancelled() ||
      (activeSessionIdRef.current || "").trim() !== mainSessionId
    ) {
      return false;
    }

    const runtimeStates =
      await window.electronAPI.workspace.listRuntimeStates(workspaceId);
    if (cancelled() || (activeSessionIdRef.current || "").trim() !== mainSessionId) {
      return false;
    }

    const currentRuntimeState = runtimeStates.items.find(
      (item) => item.session_id === mainSessionId,
    );
    const currentRuntimeStatus =
      runtimeStateEffectiveStatus(currentRuntimeState);
    const currentRuntimeInputId = (
      currentRuntimeState?.current_input_id || ""
    ).trim();
    const shouldAttachAutonomousRun =
      !activeStreamIdRef.current &&
      !pendingInputIdRef.current &&
      Boolean(currentRuntimeInputId) &&
      ["BUSY", "QUEUED"].includes(currentRuntimeStatus);
    if (shouldAttachAutonomousRun) {
      await loadSessionConversation(mainSessionId, workspaceId, runtimeStates.items, {
        cancelled,
        readOnly: false,
      });
      return true;
    }

    const latestHistory = await window.electronAPI.workspace.getSessionHistory({
      sessionId: mainSessionId,
      workspaceId,
      limit: 1,
      offset: 0,
      order: "desc",
    });
    if (cancelled() || (activeSessionIdRef.current || "").trim() !== mainSessionId) {
      return false;
    }

    const latestHistoryMessageId =
      historyMessagesInDisplayOrder(latestHistory.messages, "desc")[0]?.id?.trim() ||
      "";
    const latestDisplayedMessageId = latestVisibleChatMessageId(
      params.currentMessages,
    );
    if (
      !latestHistoryMessageId ||
      latestHistoryMessageId === latestDisplayedMessageId
    ) {
      return false;
    }

    await loadSessionConversation(mainSessionId, workspaceId, runtimeStates.items, {
      cancelled,
      readOnly: false,
    });
    return true;
  }

  const updateMemoryProposalDraft = useCallback(
    (proposalId: string, value: string) => {
      setMemoryProposalDrafts((prev) => ({
        ...prev,
        [proposalId]: value,
      }));
    },
    [],
  );

  async function handleAcceptMemoryProposal(
    proposal: MemoryUpdateProposalRecordPayload,
  ) {
    if (!selectedWorkspaceId) {
      return;
    }
    const nextSummary = (
      memoryProposalDrafts[proposal.proposal_id] ?? proposal.summary
    ).trim();
    if (!nextSummary) {
      setChatErrorMessage("Memory proposal summary cannot be empty.");
      return;
    }
    setMemoryProposalAction({
      proposalId: proposal.proposal_id,
      action: "accept",
    });
    try {
      await window.electronAPI.workspace.acceptMemoryUpdateProposal({
        proposalId: proposal.proposal_id,
        workspaceId: proposal.workspace_id,
        summary: nextSummary,
      });
      setEditingMemoryProposalId((current) =>
        current === proposal.proposal_id ? null : current,
      );
      scheduleConversationRefresh(proposal.session_id, selectedWorkspaceId);
    } catch (error) {
      setChatErrorMessage(normalizeErrorMessage(error));
    } finally {
      setMemoryProposalAction((current) =>
        current?.proposalId === proposal.proposal_id ? null : current,
      );
    }
  }

  async function handleDismissMemoryProposal(
    proposal: MemoryUpdateProposalRecordPayload,
  ) {
    if (!selectedWorkspaceId) {
      return;
    }
    setMemoryProposalAction({
      proposalId: proposal.proposal_id,
      action: "dismiss",
    });
    try {
      await window.electronAPI.workspace.dismissMemoryUpdateProposal(
        proposal.workspace_id,
        proposal.proposal_id,
      );
      setEditingMemoryProposalId((current) =>
        current === proposal.proposal_id ? null : current,
      );
      scheduleConversationRefresh(proposal.session_id, selectedWorkspaceId);
    } catch (error) {
      setChatErrorMessage(normalizeErrorMessage(error));
    } finally {
      setMemoryProposalAction((current) =>
        current?.proposalId === proposal.proposal_id ? null : current,
      );
    }
  }

  const toggleTraceStep = useCallback((stepId: string) => {
    setCollapsedTraceByStepId((prev) => ({
      ...prev,
      [stepId]: !(prev[stepId] ?? true),
    }));
  }, []);

  function setLiveExecutionItemsState(nextItems: ChatExecutionTimelineItem[]) {
    liveExecutionItemsRef.current = nextItems;
    setLiveExecutionItems(nextItems);
  }

  function upsertLiveTraceStep(step: ChatTraceStep) {
    flushLiveAssistantOutputSegment();
    const nextSegments = upsertAssistantExecutionTraceStep(
      liveAssistantSegmentsRef.current,
      step,
    );
    if (nextSegments) {
      setLiveAssistantSegmentsState(nextSegments);
      return;
    }
    const next = upsertExecutionTimelineTraceItem(
      liveExecutionItemsRef.current,
      step,
    );
    setLiveExecutionItemsState(next);
  }

  function finalizeLiveTraceSteps(
    status: Extract<ChatTraceStepStatus, "completed" | "error" | "waiting">,
  ) {
    setLiveAssistantSegmentsState(
      finalizeAssistantExecutionSegments(
        liveAssistantSegmentsRef.current,
        status,
      ),
    );
    const next = finalizeExecutionTimelineTraceItems(
      liveExecutionItemsRef.current,
      status,
    );
    setLiveExecutionItemsState(next);
  }

  useEffect(() => {
    const container = messagesRef.current;
    if (
      !container ||
      !shouldAutoScrollRef.current ||
      hasActiveChatSelection(container)
    ) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: isResponding || isHistoryViewportPending ? "auto" : "smooth",
    });
  }, [
    isHistoryViewportPending,
    isResponding,
    liveAssistantSegments,
    liveAssistantText,
    liveExecutionItems,
    messages,
  ]);

  useLayoutEffect(() => {
    const pendingRestore = pendingHistoryPrependRestoreRef.current;
    const container = messagesRef.current;
    if (!pendingRestore || !container) {
      return;
    }

    pendingHistoryPrependRestoreRef.current = null;
    const scrollHeightDelta =
      container.scrollHeight - pendingRestore.scrollHeight;
    container.scrollTop = pendingRestore.scrollTop + scrollHeightDelta;
    lastChatScrollTopRef.current = container.scrollTop;
  }, [messages]);

  useLayoutEffect(() => {
    if (!isHistoryViewportPending || historyViewportRestoreGeneration <= 0) {
      return;
    }

    const container = messagesRef.current;
    if (!container) {
      return;
    }

    const restoreGeneration = historyViewportRestoreGeneration;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "auto",
    });
    lastChatScrollTopRef.current = container.scrollTop;

    const frameId = window.requestAnimationFrame(() => {
      if (historyViewportGenerationRef.current !== restoreGeneration) {
        return;
      }
      setIsHistoryViewportPending(false);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [historyViewportRestoreGeneration, isHistoryViewportPending]);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    activeSessionReadOnlyRef.current = activeSessionReadOnly;
  }, [activeSessionReadOnly]);

  useEffect(() => {
    desktopMainSessionIdRef.current = (desktopMainSession?.session_id || "")
      .trim();
  }, [desktopMainSession?.session_id]);

  useEffect(() => {
    setSessionRecordOverrides({});
    setActiveSessionReadOnly(false);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!isResponding) {
      setIsPausePending(false);
    }
  }, [isResponding]);

  useEffect(() => {
    setPendingAttachments([]);
    setQuotedSkillIds([]);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAvailableWorkspaceSkills([]);
      setQuotedSkillIds([]);
      return;
    }

    let cancelled = false;
    let requestInFlight = false;

    const loadAvailableWorkspaceSkills = async () => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        const result =
          await window.electronAPI.workspace.listSkills(selectedWorkspaceId);
        if (cancelled) {
          return;
        }
        setAvailableWorkspaceSkills(result.skills);
        setQuotedSkillIds((current) =>
          current.filter((skillId) =>
            result.skills.some((skill) => skill.skill_id === skillId),
          ),
        );
      } catch {
        if (!cancelled) {
          setAvailableWorkspaceSkills([]);
          setQuotedSkillIds([]);
        }
      } finally {
        requestInFlight = false;
      }
    };

    const refreshVisibleWorkspaceSkills = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadAvailableWorkspaceSkills();
    };

    void loadAvailableWorkspaceSkills();
    const intervalId = window.setInterval(() => {
      refreshVisibleWorkspaceSkills();
    }, 1200);
    window.addEventListener("focus", refreshVisibleWorkspaceSkills);
    document.addEventListener(
      "visibilitychange",
      refreshVisibleWorkspaceSkills,
    );

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleWorkspaceSkills);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleWorkspaceSkills,
      );
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const normalizedWorkspaceId = (selectedWorkspaceId || "").trim();
    if (draftHydrationWorkspaceIdRef.current === normalizedWorkspaceId) {
      return;
    }
    draftHydrationWorkspaceIdRef.current = normalizedWorkspaceId;
    skipNextComposerDraftPublishRef.current = true;
    setInput((current) =>
      current === composerDraftText ? current : composerDraftText,
    );
  }, [composerDraftText, selectedWorkspaceId]);

  useEffect(() => {
    if (skipNextComposerDraftPublishRef.current) {
      skipNextComposerDraftPublishRef.current = false;
      return;
    }
    onComposerDraftTextChange?.(input);
  }, [input, onComposerDraftTextChange]);

  useEffect(() => {
    const requestKey = composerPrefillRequest?.requestKey ?? 0;
    if (
      requestKey <= 0 ||
      requestKey === lastHandledComposerPrefillRequestKeyRef.current
    ) {
      return;
    }

    lastHandledComposerPrefillRequestKeyRef.current = requestKey;
    const prefillMode = composerPrefillRequest?.mode ?? "replace";
    if (prefillMode === "append") {
      setInput((current) =>
        appendComposerPrefillText(current, composerPrefillRequest?.text ?? ""),
      );
    } else {
      const parsedPrefill = parseSerializedQuotedSkillPrompt(
        composerPrefillRequest?.text ?? "",
      );
      setInput(parsedPrefill.body);
      setQuotedSkillIds(parsedPrefill.skillIds);
      setPendingAttachments([]);
    }
    onComposerPrefillConsumed?.(requestKey);
  }, [
    composerPrefillRequest?.mode,
    composerPrefillRequest?.requestKey,
    composerPrefillRequest?.text,
    onComposerPrefillConsumed,
  ]);

  useEffect(() => {
    const normalizedPreference =
      normalizeStoredChatModelPreference(chatModelPreference);
    if (normalizedPreference !== chatModelPreference) {
      setChatModelPreference(normalizedPreference);
    }
  }, [chatModelPreference]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_MODEL_STORAGE_KEY, chatModelPreference);
    } catch {
      // ignore persistence failures
    }
  }, [chatModelPreference]);

  useEffect(() => {
    try {
      localStorage.setItem(
        CHAT_THINKING_STORAGE_KEY,
        JSON.stringify(chatThinkingPreferences),
      );
    } catch {
      // ignore persistence failures
    }
  }, [chatThinkingPreferences]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [input]);

  useEffect(() => {
    pendingFocusRequestKeyRef.current = focusRequestKey;
  }, [focusRequestKey]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }
    if (!selectedWorkspace || isLoadingBootstrap || isLoadingHistory) {
      return;
    }
    if (pendingFocusRequestKeyRef.current !== focusRequestKey) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const activeTextarea = textareaRef.current;
      if (!activeTextarea || activeTextarea.disabled) {
        return;
      }
      activeTextarea.click();
      activeTextarea.focus({ preventScroll: true });
      const cursorPosition = activeTextarea.value.length;
      activeTextarea.setSelectionRange(cursorPosition, cursorPosition);
      pendingFocusRequestKeyRef.current = null;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    focusRequestKey,
    isLoadingBootstrap,
    isLoadingHistory,
    selectedWorkspace,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      cancelHistoryViewportRestore();
      clearSessionView();
      setPendingAttachments([]);
      setActiveSession(null);
      setActiveSessionReadOnly(false);
      setDesktopMainSession(null);
      setSessionRecordOverrides({});
      pendingInputIdRef.current = null;
      lastHandledSessionJumpRequestKeyRef.current = 0;
      lastHandledExternalSessionOpenRequestKeyRef.current = 0;
      lastHandledLocalSessionOpenRequestKeyRef.current = 0;
      draftParentSessionIdRef.current = null;
      return;
    }

    let cancelled = false;

    async function loadHistory() {
      let historyLoaded = false;
      beginHistoryViewportRestore();
      setIsLoadingHistory(true);
      setChatErrorMessage("");

      try {
        const requestedSessionId = (sessionJumpSessionId || "").trim();
        const hasSessionJumpRequest =
          Boolean(requestedSessionId) &&
          sessionJumpRequestKey > 0 &&
          sessionJumpRequestKey !== lastHandledSessionJumpRequestKeyRef.current;
        if (hasSessionJumpRequest) {
          lastHandledSessionJumpRequestKeyRef.current = sessionJumpRequestKey;
          pendingInputIdRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setIsResponding(false);
          resetLiveTurn();

          const activeStreamId = activeStreamIdRef.current;
          activeStreamIdRef.current = null;
          if (activeStreamId) {
            await closeStreamWithReason(
              activeStreamId,
              "chatpane_session_jump_requested",
            ).catch(() => undefined);
          }
        }

        const [runtimeStates, mainSessionResponse] = await Promise.all([
          window.electronAPI.workspace.listRuntimeStates(selectedWorkspaceId),
          window.electronAPI.workspace.ensureMainSession(selectedWorkspaceId),
        ]);
        if (cancelled) {
          return;
        }
        setDesktopMainSession(mainSessionResponse.session ?? null);

        const nextSessionId =
          (hasSessionJumpRequest && requestedSessionId
            ? requestedSessionId
            : null) ||
          mainSessionResponse.session?.session_id?.trim() ||
          null;
        const resolvedSessionId = nextSessionId || null;
        draftParentSessionIdRef.current = null;
        await loadSessionConversation(
          resolvedSessionId,
          selectedWorkspaceId,
          runtimeStates.items,
          {
            cancelled: () => cancelled,
            readOnly: false,
          },
        );
        historyLoaded = true;
      } catch (error) {
        if (!cancelled) {
          setChatErrorMessage(normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          if (!historyLoaded) {
            cancelHistoryViewportRestore();
          }
          setIsLoadingHistory(false);
        }
      }
    }

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [
    isOnboardingVariant,
    sessionJumpRequestKey,
    sessionJumpSessionId,
    selectedWorkspaceId,
    selectedWorkspace?.onboarding_session_id,
    selectedWorkspace?.onboarding_status,
  ]);

  useEffect(() => {
    const requestedSessionId = (
      effectiveSessionOpenRequest?.sessionId || ""
    ).trim();
    const requestKey = effectiveSessionOpenRequest?.requestKey ?? 0;
    const requestMode = effectiveSessionOpenRequest?.mode ?? "session";
    const requestedParentSessionId =
      effectiveSessionOpenRequest?.parentSessionId?.trim() || null;
    const requestedReadOnly = effectiveSessionOpenRequest?.readOnly === true;
    const lastHandledSessionOpenRequestKeyRef = isExternalSessionOpenRequest
      ? lastHandledExternalSessionOpenRequestKeyRef
      : lastHandledLocalSessionOpenRequestKeyRef;
    if (!selectedWorkspaceId || requestKey <= 0) {
      return;
    }
    if (isSessionOpenRequestConsumed(requestKey)) {
      consumeSessionOpenRequest(requestKey);
      return;
    }
    if (requestKey === lastHandledSessionOpenRequestKeyRef.current) {
      return;
    }

    let cancelled = false;

    async function openRequestedSession() {
      lastHandledSessionOpenRequestKeyRef.current = requestKey;

      let historyLoaded = false;
      beginHistoryViewportRestore();
      setIsLoadingHistory(true);
      setChatErrorMessage("");
      pendingInputIdRef.current = null;
      activeAssistantMessageIdRef.current = null;
      setIsResponding(false);

      const activeStreamId = activeStreamIdRef.current;
      activeStreamIdRef.current = null;
      if (activeStreamId) {
        await closeStreamWithReason(
          activeStreamId,
          "chatpane_open_requested_session",
        ).catch(() => undefined);
      }

      try {
        if (cancelled || isSessionOpenRequestConsumed(requestKey)) {
          historyLoaded = true;
          return;
        }

        if (requestMode === "draft") {
          setActiveSessionReadOnly(false);
          draftParentSessionIdRef.current = requestedParentSessionId;
          clearSessionView();
          setActiveSession(null);
          requestHistoryViewportRestore();
          historyLoaded = true;
          return;
        }

        if (!requestedSessionId) {
          historyLoaded = true;
          return;
        }

        draftParentSessionIdRef.current = null;
        setActiveSessionReadOnly(requestedReadOnly);
        if (activeSessionIdRef.current === requestedSessionId) {
          requestHistoryViewportRestore();
          historyLoaded = true;
          return;
        }

        const runtimeStates =
          await window.electronAPI.workspace.listRuntimeStates(
            selectedWorkspaceId,
          );
        if (cancelled || isSessionOpenRequestConsumed(requestKey)) {
          historyLoaded = true;
          return;
        }
        await loadSessionConversation(
          requestedSessionId,
          selectedWorkspaceId,
          runtimeStates.items,
          {
            cancelled: () => cancelled,
            readOnly: requestedReadOnly,
          },
        );
        historyLoaded = true;
      } catch (error) {
        if (!cancelled) {
          setChatErrorMessage(normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          if (!historyLoaded) {
            cancelHistoryViewportRestore();
          }
          setIsLoadingHistory(false);
          consumeSessionOpenRequest(requestKey);
        }
      }
    }

    void openRequestedSession();
    return () => {
      cancelled = true;
    };
  }, [
    onSessionOpenRequestConsumed,
    isExternalSessionOpenRequest,
    selectedWorkspaceId,
    effectiveSessionOpenRequest?.requestKey,
    effectiveSessionOpenRequest?.sessionId,
    effectiveSessionOpenRequest?.mode,
    effectiveSessionOpenRequest?.parentSessionId,
    effectiveSessionOpenRequest?.readOnly,
    sessionOpenRequest?.requestKey,
  ]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.workspace
      .isVerboseTelemetryEnabled()
      .then((enabled) => {
        if (!cancelled) {
          setVerboseTelemetryEnabled(enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!verboseTelemetryEnabled) {
      setStreamTelemetry([]);
      seenMainDebugKeysRef.current = new Set();
      return;
    }
    setStreamTelemetry([]);
    seenMainDebugKeysRef.current = new Set();
  }, [selectedWorkspaceId, verboseTelemetryEnabled]);

  useEffect(() => {
    if (!verboseTelemetryEnabled) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      void window.electronAPI.workspace
        .getSessionStreamDebug()
        .then((entries) => {
          if (cancelled) {
            return;
          }
          for (const entry of entries) {
            const key = `${entry.at}|${entry.streamId}|${entry.phase}|${entry.detail}`;
            if (seenMainDebugKeysRef.current.has(key)) {
              continue;
            }
            seenMainDebugKeysRef.current.add(key);
            appendStreamTelemetry({
              streamId: entry.streamId,
              transportType: "main",
              eventName: entry.phase,
              eventType: entry.phase,
              inputId: "",
              sessionId: "",
              action: `main_${entry.phase}`,
              detail: entry.detail,
            });
          }
          if (seenMainDebugKeysRef.current.size > 4000) {
            const trimmed = new Set(
              Array.from(seenMainDebugKeysRef.current).slice(-2000),
            );
            seenMainDebugKeysRef.current = trimmed;
          }
        })
        .catch(() => undefined);
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [verboseTelemetryEnabled]);

  useEffect(() => {
    const normalizedWorkspaceId = (selectedWorkspaceId || "").trim();
    const previousWorkspaceId = previousSelectedWorkspaceIdRef.current;
    if (previousWorkspaceId === normalizedWorkspaceId) {
      return;
    }
    previousSelectedWorkspaceIdRef.current = normalizedWorkspaceId;

    const activeStreamId = activeStreamIdRef.current;
    activeStreamIdRef.current = null;
    pendingInputIdRef.current = null;
    activeAssistantMessageIdRef.current = null;
    draftParentSessionIdRef.current = null;
    setIsResponding(false);
    setQueuedSessionInputs([]);
    setDesktopMainSession(null);
    setActiveSession(null);
    clearSessionView();

    if (activeStreamId) {
      void closeStreamWithReason(activeStreamId, "selected_workspace_changed");
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.workspace.onSessionStreamEvent(
      (payload) => {
        const currentStreamId = activeStreamIdRef.current;
        const pendingInputId = pendingInputIdRef.current || "";
        const hasPendingStreamAttach = Boolean(pendingInputId);
        const rawEventData =
          payload.type === "event" ? payload.event?.data : null;
        const typedEvent =
          rawEventData &&
          typeof rawEventData === "object" &&
          !Array.isArray(rawEventData)
            ? (rawEventData as {
                event_type?: string;
                payload?: Record<string, unknown>;
                input_id?: string;
                session_id?: string;
                sequence?: number;
              })
            : null;
        const eventName =
          payload.type === "event"
            ? (payload.event?.event ?? "message")
            : payload.type;
        const eventType = typedEvent?.event_type ?? eventName;
        const eventPayload = typedEvent?.payload ?? {};
        const eventInputId =
          typeof typedEvent?.input_id === "string" ? typedEvent.input_id : "";
        const eventSessionId =
          typeof typedEvent?.session_id === "string"
            ? typedEvent.session_id
            : "";
        const eventSequence =
          typeof typedEvent?.sequence === "number" &&
          Number.isFinite(typedEvent.sequence)
            ? typedEvent.sequence
            : Number.MAX_SAFE_INTEGER;
        const trackedMainSessionEventBatchInput =
          (eventType === "run_claimed" || eventType === "run_started") &&
          rememberMainSessionEventBatchInput(eventInputId, eventPayload);
        const isMainSessionEventBatchInput =
          trackedMainSessionEventBatchInput ||
          isRememberedMainSessionEventBatchInput(eventInputId);

        appendStreamTelemetry({
          streamId: payload.streamId,
          transportType: payload.type,
          eventName,
          eventType,
          inputId: eventInputId,
          sessionId: eventSessionId,
          action: "received",
          detail: `active=${currentStreamId || "-"} pending=${pendingInputId || "-"}`,
        });

        if (payload.type === "error") {
          if (!currentStreamId || payload.streamId !== currentStreamId) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "drop_error_unmatched_stream",
              detail: `active=${currentStreamId || "-"} pending=${pendingInputId || "-"}`,
            });
            return;
          }
          setChatErrorMessage(payload.error || "The agent stream failed.");
          setIsResponding(false);
          activeAssistantMessageIdRef.current = null;
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = null;
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_error",
            detail: payload.error || "stream error",
          });
          return;
        }

        if (payload.type === "done") {
          if (!currentStreamId || payload.streamId !== currentStreamId) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "drop_done_unmatched_stream",
              detail: `active=${currentStreamId || "-"} pending=${pendingInputId || "-"}`,
            });
            return;
          }
          const refreshSessionId = activeSessionIdRef.current;
          setIsResponding(false);
          activeAssistantMessageIdRef.current = null;
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = null;
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_done",
            detail: "stream done",
          });
          if (refreshSessionId && selectedWorkspaceId) {
            scheduleConversationRefresh(refreshSessionId, selectedWorkspaceId);
          }
          return;
        }

        const eventData = payload.event?.data;
        if (!eventData || typeof eventData !== "object") {
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "drop_event_invalid_data",
            detail: `data_type=${typeof eventData}`,
          });
          return;
        }

        const streamMatches = Boolean(
          currentStreamId && payload.streamId === currentStreamId,
        );
        const inputMatchesPending = Boolean(
          pendingInputId && eventInputId && eventInputId === pendingInputId,
        );
        const canAdoptStream = !streamMatches && inputMatchesPending;

        if (!streamMatches && !canAdoptStream) {
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "drop_unmatched_event",
            detail: `active=${currentStreamId || "-"} pending=${pendingInputId || "-"} input_match=${String(inputMatchesPending)}`,
          });
          return;
        }
        if (canAdoptStream) {
          activeStreamIdRef.current = payload.streamId;
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "adopt_stream_for_event",
            detail: `pending_input=${pendingInputId}`,
          });
        }

        if (
          eventSessionId &&
          eventInputId &&
          (eventType === "run_claimed" || eventType === "run_started")
        ) {
          setQueuedSessionInputs((current) =>
            current.map((item) =>
              item.workspaceId === (selectedWorkspaceId || "").trim() &&
              item.sessionId === eventSessionId &&
              item.inputId === eventInputId
                ? {
                    ...item,
                    status: "sending",
                  }
                : item,
            ),
          );
        }

        if (
          eventType === "run_claimed" ||
          eventType === "compaction_restored" ||
          eventType === "run_started"
        ) {
          setLiveAgentStatus("Checking workspace context");
        }

        const phaseStep = phaseTraceStepFromEvent(
          eventType,
          eventPayload,
          eventSequence,
        );
        if (phaseStep) {
          upsertLiveTraceStep(phaseStep);
        }

        const toolStep = toolTraceStepFromEvent(
          eventType,
          eventPayload,
          eventSequence,
        );
        if (toolStep) {
          upsertLiveTraceStep(toolStep);
        }

        if (eventType === "tool_call") {
          const fileDisplayTarget =
            fileDisplaySyncTargetFromToolPayload(eventPayload);
          if (fileDisplayTarget) {
            const callId =
              typeof eventPayload.call_id === "string"
                ? eventPayload.call_id.trim()
                : "";
            const syncKey = callId
              ? `${callId}:${fileDisplayTarget}`
              : fileDisplayTarget;
            if (lastSyncedAgentOperationFileKeyRef.current !== syncKey) {
              lastSyncedAgentOperationFileKeyRef.current = syncKey;
              onSyncFileDisplayFromAgentOperation?.(fileDisplayTarget);
            }
          }
        }

        if (eventType === "output_delta") {
          const delta =
            typeof eventPayload.delta === "string" ? eventPayload.delta : "";
          if (!delta) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "skip_empty_delta",
              detail: "delta missing/empty",
            });
            return;
          }

          const assistantMessageId =
            activeAssistantMessageIdRef.current ??
            (eventInputId
              ? `assistant-${eventInputId}`
              : `assistant-${Date.now()}`);
          activeAssistantMessageIdRef.current = assistantMessageId;
          if (isMainSessionEventBatchInput) {
            setBackgroundDeliveryStatusMessage("");
          }
          appendLiveAssistantDelta(delta);
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_output_delta",
            detail: `delta_len=${delta.length}`,
          });
          return;
        }

        if (eventType === "thinking_delta") {
          const delta =
            typeof eventPayload.delta === "string" ? eventPayload.delta : "";
          if (!delta) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "skip_empty_thinking_delta",
              detail: "delta missing/empty",
            });
            return;
          }
          appendLiveThinkingDelta(delta, eventSequence);
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_thinking_delta",
            detail: `delta_len=${delta.length}`,
          });
          return;
        }

        if (eventType === "run_failed") {
          const priorTerminalEventType = recordTerminalEventForInput(
            eventInputId,
            "run_failed",
          );
          if (priorTerminalEventType) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "skip_terminal_after_terminal",
              detail: `prior=${priorTerminalEventType}`,
            });
            return;
          }
          const detail = runFailedDetail(eventPayload);
          const shouldPersistFailureText = !liveAssistantHasVisibleOutput();
          if (isMainSessionEventBatchInput && shouldPersistFailureText) {
            forgetMainSessionEventBatchInput(eventInputId);
            resetLiveTurn();
            setBackgroundDeliveryStatusMessage(
              BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE,
            );
            setIsResponding(false);
            activeStreamIdRef.current = null;
            pendingInputIdRef.current = null;
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "suppress_background_delivery_failure",
              detail,
            });
            scheduleConversationRefresh(eventSessionId, selectedWorkspaceId);
            return;
          }
          forgetMainSessionEventBatchInput(eventInputId);
          finalizeLiveTraceSteps("error");
          const committedFailureMessage = commitLiveAssistantMessage({
            fallbackText: shouldPersistFailureText ? detail : undefined,
            tone: shouldPersistFailureText ? "error" : "default",
          });
          setChatErrorMessage(
            committedFailureMessage && shouldPersistFailureText ? "" : detail,
          );
          setIsResponding(false);
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = null;
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_run_failed",
            detail,
          });
          scheduleConversationRefresh(eventSessionId, selectedWorkspaceId);
          return;
        }

        if (eventType === "run_completed") {
          const priorTerminalEventType = recordTerminalEventForInput(
            eventInputId,
            "run_completed",
          );
          if (priorTerminalEventType) {
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "skip_terminal_after_terminal",
              detail: `prior=${priorTerminalEventType}`,
            });
            return;
          }
          const completedStatus =
            typeof eventPayload.status === "string"
              ? eventPayload.status.trim().toLowerCase()
              : "";
          const suppressBackgroundDeliveryCompletion =
            isMainSessionEventBatchInput &&
            completedStatus === "paused" &&
            !liveAssistantHasVisibleOutput();
          if (suppressBackgroundDeliveryCompletion) {
            forgetMainSessionEventBatchInput(eventInputId);
            resetLiveTurn();
            setBackgroundDeliveryStatusMessage(
              BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE,
            );
            setIsResponding(false);
            activeStreamIdRef.current = null;
            pendingInputIdRef.current = null;
            appendStreamTelemetry({
              streamId: payload.streamId,
              transportType: payload.type,
              eventName,
              eventType,
              inputId: eventInputId,
              sessionId: eventSessionId,
              action: "suppress_background_delivery_completion",
              detail: `status=${completedStatus || "unknown"}`,
            });
            scheduleConversationRefresh(eventSessionId, selectedWorkspaceId);
            void refreshWorkspaceData().catch(() => undefined);
            return;
          }
          finalizeLiveTraceSteps(
            completedStatus === "paused" ? "waiting" : "completed",
          );
          const committedAssistantMessage = commitLiveAssistantMessage();
          if (isMainSessionEventBatchInput && committedAssistantMessage) {
            setBackgroundDeliveryStatusMessage("");
          }
          forgetMainSessionEventBatchInput(eventInputId);
          maybePlayMainSessionCompletionChime({
            sessionId: eventSessionId,
            inputId: eventInputId,
            terminalStatus: completedStatus,
          });
          setIsResponding(false);
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = null;
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "applied_run_completed",
            detail: "run completed",
          });
          scheduleConversationRefresh(eventSessionId, selectedWorkspaceId);
          void refreshWorkspaceData().catch(() => undefined);
        }
      },
    );

    return () => {
      unsubscribe();
    };
  }, [
    onSyncFileDisplayFromAgentOperation,
    refreshWorkspaceData,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (!isResponding || !selectedWorkspaceId || !activeSessionId) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response =
          await window.electronAPI.workspace.listRuntimeStates(
            selectedWorkspaceId,
          );
        if (cancelled) {
          return;
        }
        const currentSessionId = activeSessionIdRef.current;
        const currentState = response.items.find(
          (item) => item.session_id === currentSessionId,
        );
        if (!currentState) {
          return;
        }
        const normalizedCurrentSessionId = (currentSessionId || "").trim();
        if (!normalizedCurrentSessionId) {
          return;
        }
        const status = runtimeStateEffectiveStatus(currentState);
        const currentRuntimeInputId = (
          currentState.current_input_id || ""
        ).trim();
        const activeStreamId = activeStreamIdRef.current;
        const pendingInputId = pendingInputIdRef.current || "";
        const attachPendingWithoutStream = Boolean(
          pendingInputId && !activeStreamId,
        );
        if (attachPendingWithoutStream) {
          return;
        }
        if (status === "BUSY" || status === "QUEUED") {
          return;
        }

        if (activeStreamId) {
          await closeStreamWithReason(
            activeStreamId,
            "runtime_poll_terminal_state",
          );
          activeStreamIdRef.current = null;
        }
        setIsResponding(false);

        if (status === "ERROR") {
          const detail = runtimeStateErrorDetail(currentState.last_error);
          finalizeLiveTraceSteps("error");
          const shouldPersistFailureText =
            !liveAssistantTextRef.current &&
            !assistantSegmentsIncludeOutput(liveAssistantSegmentsRef.current);
          const committedFailureMessage = commitLiveAssistantMessage({
            fallbackText: shouldPersistFailureText ? detail : undefined,
            tone: shouldPersistFailureText ? "error" : "default",
          });
          setChatErrorMessage(
            committedFailureMessage && shouldPersistFailureText ? "" : detail,
          );
        } else {
          finalizeLiveTraceSteps(
            status === "WAITING_USER" || status === "PAUSED"
              ? "waiting"
              : "completed",
          );
          commitLiveAssistantMessage();
          maybePlayMainSessionCompletionChime({
            sessionId: normalizedCurrentSessionId,
            inputId: currentRuntimeInputId,
            completedAt: currentState.last_turn_completed_at,
            terminalStatus: currentState.last_turn_status ?? status,
          });
        }
        activeAssistantMessageIdRef.current = null;
        pendingInputIdRef.current = null;
        scheduleConversationRefresh(normalizedCurrentSessionId, selectedWorkspaceId);
      } catch {
        // Ignore poll failures; stream events remain the primary signal.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isResponding, selectedWorkspaceId, activeSessionId]);

  useEffect(() => {
    const workspaceId = (selectedWorkspaceId || "").trim();
    const mainSessionId = (desktopMainSession?.session_id || "").trim();
    const currentSessionId =
      (activeSessionIdRef.current || activeSessionId || "").trim();
    if (
      !workspaceId ||
      !mainSessionId ||
      currentSessionId !== mainSessionId ||
      activeSessionReadOnly ||
      isLoadingHistory ||
      isResponding
    ) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const pollForAutonomousMainSessionReply = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") {
        return;
      }
      const currentContainer = messagesRef.current;
      if (currentContainer && !isNearChatBottom(currentContainer)) {
        return;
      }
      if ((activeSessionIdRef.current || "").trim() !== mainSessionId) {
        return;
      }

      inFlight = true;
      try {
        await reconcileAutonomousMainSessionActivity({
          workspaceId,
          mainSessionId,
          currentMessages: messages,
          cancelled: () =>
            cancelled || (activeSessionIdRef.current || "").trim() !== mainSessionId,
        });
      } catch {
        // Ignore passive refresh failures; manual interaction or background polling will retry.
      } finally {
        inFlight = false;
      }
    };

    void pollForAutonomousMainSessionReply();
    const intervalId = window.setInterval(() => {
      void pollForAutonomousMainSessionReply();
    }, 2500);
    const refreshVisibleMainSession = () => {
      void pollForAutonomousMainSessionReply();
    };
    window.addEventListener("focus", refreshVisibleMainSession);
    document.addEventListener("visibilitychange", refreshVisibleMainSession);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleMainSession);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleMainSession,
      );
    };
  }, [
    activeSessionId,
    activeSessionReadOnly,
    desktopMainSession?.session_id,
    isLoadingHistory,
    isResponding,
    messages,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    return () => {
      cancelLiveAssistantFlush();
      const activeStreamId = activeStreamIdRef.current;
      if (activeStreamId) {
        void closeStreamWithReason(activeStreamId, "chatpane_unmount");
      }
    };
  }, []);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (
      (!trimmed &&
        pendingAttachments.length === 0 &&
        quotedSkillIds.length === 0) ||
      isSubmittingMessage
    ) {
      return;
    }
    if (
      browserJumpRequest &&
      activeSessionIdRef.current &&
      browserJumpRequest.sessionId === activeSessionIdRef.current
    ) {
      onBrowserJumpRequestConsumed?.(
        browserJumpRequest.sessionId,
        browserJumpRequest.requestKey,
      );
    }
    if (usesHostedManagedCredits) {
      if (isOutOfCredits) {
        setChatErrorMessage("You're out of credits for managed usage.");
        return;
      }
      void refreshBillingState().catch(() => undefined);
    }
    if (!selectedWorkspace) {
      setChatErrorMessage("Create or select a workspace first.");
      return;
    }
    if (!isOnboardingVariant && !workspaceAppsReady) {
      setChatErrorMessage(
        workspaceBlockingReason || "Workspace apps are still starting.",
      );
      return;
    }
    if (!isOnboardingVariant && !resolvedChatModel) {
      setChatErrorMessage(
        modelSelectionUnavailableReason || "No models available.",
      );
      return;
    }
    if (pendingImageInputUnsupportedMessage) {
      return;
    }
    const pendingSessionTarget = pendingSessionTargetForSend();
    let targetSessionId =
      pendingSessionTarget?.mode === "session"
        ? pendingSessionTarget.sessionId
        : activeSessionIdRef.current;

    if (pendingSessionTarget) {
      consumeSessionOpenRequest(pendingSessionTarget.requestKey);
      clearSessionView();
      if (pendingSessionTarget.mode === "session") {
        setActiveSession(pendingSessionTarget.sessionId);
      } else {
        draftParentSessionIdRef.current = pendingSessionTarget.parentSessionId;
        setActiveSession(null);
      }
    }

    if (!targetSessionId && selectedWorkspace) {
      targetSessionId = await createWorkspaceSession(
        selectedWorkspace.id,
        pendingSessionTarget?.mode === "draft"
          ? pendingSessionTarget.parentSessionId
          : draftParentSessionIdRef.current,
      );
      if (targetSessionId) {
        draftParentSessionIdRef.current = null;
        setActiveSession(targetSessionId);
      }
    }
    if (!targetSessionId) {
      setChatErrorMessage("No active session found for this workspace.");
      return;
    }
    const mainSessionIdForWorkspace = (
      desktopMainSessionIdRef.current || desktopMainSession?.session_id || ""
    ).trim();
    if (
      !pendingSessionTarget &&
      selectedWorkspace &&
      targetSessionId === mainSessionIdForWorkspace &&
      (activeSessionIdRef.current || "").trim() === mainSessionIdForWorkspace
    ) {
      await reconcileAutonomousMainSessionActivity({
        workspaceId: selectedWorkspace.id,
        mainSessionId: mainSessionIdForWorkspace,
        currentMessages: messages,
      });
    }
    const queueOntoActiveRun =
      (isResponding ||
        Boolean(activeStreamIdRef.current) ||
        Boolean(pendingInputIdRef.current)) &&
      !pendingSessionTarget &&
      targetSessionId === activeSessionIdRef.current;
    let optimisticUserMessageId = "";

    setIsSubmittingMessage(true);

    appendStreamTelemetry({
      streamId: activeStreamIdRef.current || "-",
      transportType: "client",
      eventName: "sendMessage",
      eventType: "send_start",
      inputId: "",
      sessionId: targetSessionId,
      action: "queue_begin",
      detail: `workspace=${selectedWorkspace.id}`,
    });

    try {
      const missingQuotedSkillIds = quotedSkillIds.filter(
        (skillId) => !availableWorkspaceSkillMap.has(skillId),
      );
      if (missingQuotedSkillIds.length > 0) {
        throw new Error(
          `Quoted skills are no longer available: ${missingQuotedSkillIds.join(", ")}`,
        );
      }

      const attachmentEntries = pendingAttachments;
      const localFiles = attachmentEntries.filter(
        (entry): entry is PendingLocalAttachmentFile =>
          entry.source === "local-file",
      );
      const explorerFiles = attachmentEntries.filter(
        (entry): entry is PendingExplorerAttachmentFile =>
          entry.source === "explorer-path",
      );

      const [stagedLocalAttachments, stagedExplorerAttachments] =
        await Promise.all([
          localFiles.length > 0
            ? window.electronAPI.workspace.stageSessionAttachments({
                workspace_id: selectedWorkspace.id,
                files: await Promise.all(
                  localFiles.map((entry) =>
                    attachmentUploadPayload(entry.file),
                  ),
                ),
              })
            : Promise.resolve({ attachments: [] }),
          explorerFiles.length > 0
            ? window.electronAPI.workspace.stageSessionAttachmentPaths({
                workspace_id: selectedWorkspace.id,
                files: explorerFiles.map((entry) => ({
                  absolute_path: entry.absolutePath,
                  name: entry.name,
                  mime_type: entry.mime_type ?? null,
                  kind: entry.kind,
                })),
              })
            : Promise.resolve({ attachments: [] }),
        ]);

      let localAttachmentIndex = 0;
      let explorerAttachmentIndex = 0;
      const stagedAttachments = attachmentEntries.map((entry) => {
        if (entry.source === "local-file") {
          const attachment =
            stagedLocalAttachments.attachments[localAttachmentIndex];
          localAttachmentIndex += 1;
          if (!attachment) {
            throw new Error("Failed to stage a dropped file attachment.");
          }
          return attachment;
        }

        const attachment =
          stagedExplorerAttachments.attachments[explorerAttachmentIndex];
        explorerAttachmentIndex += 1;
        if (!attachment) {
          throw new Error("Failed to stage an explorer attachment.");
        }
        return attachment;
      });

      const serializedPrompt = serializeQuotedSkillPrompt(
        trimmed,
        quotedSkillIds,
      );
      const queuedMessageCreatedAt = new Date().toISOString();
      optimisticUserMessageId = `user-${Date.now()}`;
      const userMessage: ChatMessage = {
        id: optimisticUserMessageId,
        role: "user",
        text: serializedPrompt,
        createdAt: queuedMessageCreatedAt,
        attachments: stagedAttachments,
      };

      shouldAutoScrollRef.current = true;
      if (!queueOntoActiveRun) {
        setMessages((prev) => [...prev, userMessage]);
        updatePendingOptimisticUserMessagesState((current) => [
          ...current.filter(
            (item) =>
              !(
                item.localMessageId === optimisticUserMessageId &&
                item.workspaceId === selectedWorkspace.id &&
                item.sessionId === targetSessionId
              ),
          ),
          {
            localMessageId: optimisticUserMessageId,
            inputId: null,
            sessionId: targetSessionId,
            workspaceId: selectedWorkspace.id,
            message: userMessage,
          },
        ]);
      }
      setInput("");
      setQuotedSkillIds([]);
      setPendingAttachments([]);
      setChatErrorMessage("");
      if (!queueOntoActiveRun) {
        const currentStreamId = activeStreamIdRef.current;
        if (currentStreamId) {
          await closeStreamWithReason(
            currentStreamId,
            "send_new_message_close_previous_stream",
          );
          activeStreamIdRef.current = null;
          appendStreamTelemetry({
            streamId: currentStreamId,
            transportType: "client",
            eventName: "sendMessage",
            eventType: "close_prev_stream",
            inputId: "",
            sessionId: targetSessionId || "",
            action: "closed_previous_stream",
            detail: "before new send",
          });
        }

        resetLiveTurn();
        setIsResponding(true);
        setLiveAgentStatus("Thinking");
        activeAssistantMessageIdRef.current = null;
        pendingInputIdRef.current = STREAM_ATTACH_PENDING;
      }

      const queued = await window.electronAPI.workspace.queueSessionInput({
        text: serializedPrompt,
        workspace_id: selectedWorkspace.id,
        image_urls: null,
        attachments: stagedAttachments,
        session_id: targetSessionId,
        priority: 0,
        model: resolvedChatModel || null,
        thinking_value: effectiveThinkingValue,
      });
      rememberSubmittedComposerInput(text, selectedWorkspace.id);
      setActiveSession(queued.session_id);
      appendStreamTelemetry({
        streamId: "-",
        transportType: "client",
        eventName: "queueSessionInput",
        eventType: "queued",
        inputId: queued.input_id,
        sessionId: queued.session_id,
        action: "queued_input",
        detail: queueOntoActiveRun
          ? "queue response received while current run remained attached"
          : "queue response received",
      });
      if (!queueOntoActiveRun) {
        const persistedUserMessageId = `user-${queued.input_id}`;
        const persistedUserMessage: ChatMessage = {
          ...userMessage,
          id: persistedUserMessageId,
        };
        setMessages((prev) =>
          prev.map((message) =>
            message.id === optimisticUserMessageId
              ? persistedUserMessage
              : message,
          ),
        );
        updatePendingOptimisticUserMessagesState((current) =>
          current.map((item) =>
            item.localMessageId === optimisticUserMessageId
              ? {
                  ...item,
                  inputId: queued.input_id,
                  sessionId: queued.session_id,
                  workspaceId: selectedWorkspace.id,
                  message: persistedUserMessage,
                }
              : item,
          ),
        );
        pendingInputIdRef.current = queued.input_id;
        const opened = await window.electronAPI.workspace
          .openSessionOutputStream({
            sessionId: queued.session_id,
            workspaceId: selectedWorkspace.id,
            inputId: queued.input_id,
            includeHistory: true,
            stopOnTerminal: true,
          })
          .catch((error) => {
            pendingInputIdRef.current = null;
            setIsResponding(false);
            throw error;
          });
        activeStreamIdRef.current = opened.streamId;
        appendStreamTelemetry({
          streamId: opened.streamId,
          transportType: "client",
          eventName: "openSessionOutputStream",
          eventType: "stream_open_postqueue",
          inputId: queued.input_id,
          sessionId: queued.session_id,
          action: "stream_requested_postqueue",
          detail: "opened input-specific stream after queue response",
        });
      } else {
        setQueuedSessionInputs((current) => [
          ...current,
          {
            inputId: queued.input_id,
            sessionId: queued.session_id,
            workspaceId: selectedWorkspace.id,
            text: serializedPrompt,
            createdAt: queuedMessageCreatedAt,
            attachments: stagedAttachments,
            status: "queued",
          },
        ]);
        const shouldAttachQueuedRun =
          activeSessionIdRef.current === queued.session_id &&
          !activeStreamIdRef.current &&
          !pendingInputIdRef.current;
        if (shouldAttachQueuedRun) {
          pendingInputIdRef.current = queued.input_id;
          setIsResponding(true);
          setLiveAgentStatus("Queued");
          const resumed = await window.electronAPI.workspace
            .openSessionOutputStream({
              sessionId: queued.session_id,
              workspaceId: selectedWorkspace.id,
              inputId: queued.input_id,
              includeHistory: true,
              stopOnTerminal: true,
            })
            .catch((error) => {
              pendingInputIdRef.current = null;
              setIsResponding(false);
              throw error;
            });
          activeStreamIdRef.current = resumed.streamId;
          setQueuedSessionInputs((current) =>
            current.map((item) =>
              item.inputId === queued.input_id &&
              item.sessionId === queued.session_id &&
              item.workspaceId === selectedWorkspace.id
                ? {
                    ...item,
                    status: "sending",
                  }
                : item,
            ),
          );
          appendStreamTelemetry({
            streamId: resumed.streamId,
            transportType: "client",
            eventName: "openSessionOutputStream",
            eventType: "stream_open_queued_handoff",
            inputId: queued.input_id,
            sessionId: queued.session_id,
            action: "stream_requested_queued_handoff",
            detail: "current run finished before queue response arrived",
          });
        }
      }
      if (!queueOntoActiveRun && queued.session_id !== targetSessionId) {
        const staleStreamId = activeStreamIdRef.current;
        if (staleStreamId) {
          await closeStreamWithReason(staleStreamId, "queue_session_retarget");
          appendStreamTelemetry({
            streamId: staleStreamId,
            transportType: "client",
            eventName: "openSessionOutputStream",
            eventType: "close_stream_retarget",
            inputId: queued.input_id,
            sessionId: targetSessionId,
            action: "stream_retarget_close",
            detail: `queue_session=${queued.session_id}`,
          });
        }
        const retargeted =
          await window.electronAPI.workspace.openSessionOutputStream({
            sessionId: queued.session_id,
            workspaceId: selectedWorkspace.id,
            inputId: queued.input_id,
            includeHistory: true,
            stopOnTerminal: true,
          });
        activeStreamIdRef.current = retargeted.streamId;
        appendStreamTelemetry({
          streamId: retargeted.streamId,
          transportType: "client",
          eventName: "openSessionOutputStream",
          eventType: "stream_open_retarget",
          inputId: queued.input_id,
          sessionId: queued.session_id,
          action: "stream_requested_retarget",
          detail: "session changed after queue",
        });
      }
    } catch (error) {
      if (!queueOntoActiveRun && optimisticUserMessageId) {
        setMessages((prev) =>
          prev.filter((message) => message.id !== optimisticUserMessageId),
        );
        updatePendingOptimisticUserMessagesState((current) =>
          current.filter(
            (item) => item.localMessageId !== optimisticUserMessageId,
          ),
        );
      }
      if (!queueOntoActiveRun) {
        const activeStreamId = activeStreamIdRef.current;
        if (activeStreamId) {
          await closeStreamWithReason(
            activeStreamId,
            "send_message_error",
          ).catch(() => undefined);
        }
      }
      setChatErrorMessage(normalizeErrorMessage(error));
      if (!queueOntoActiveRun) {
        setIsResponding(false);
        activeAssistantMessageIdRef.current = null;
        activeStreamIdRef.current = null;
        pendingInputIdRef.current = null;
      }
      appendStreamTelemetry({
        streamId: "-",
        transportType: "client",
        eventName: "sendMessage",
        eventType: "send_error",
        inputId: "",
        sessionId: targetSessionId || "",
        action: "send_failed",
        detail: normalizeErrorMessage(error),
      });
    } finally {
      setIsSubmittingMessage(false);
    }
  }

  async function pauseCurrentRun() {
    const sessionId = activeSessionIdRef.current || activeSessionId;
    if (!selectedWorkspaceId || !sessionId || isPausePending) {
      return;
    }

    const previousStatus = liveAgentStatus;
    setChatErrorMessage("");
    setLiveAgentStatus("Pausing");
    setIsPausePending(true);

    try {
      await window.electronAPI.workspace.pauseSessionRun({
        workspace_id: selectedWorkspaceId,
        session_id: sessionId,
      });
    } catch (error) {
      setIsPausePending(false);
      setLiveAgentStatus(previousStatus || "Working");
      setChatErrorMessage(normalizeErrorMessage(error));
    }
  }

  async function updateQueuedSessionInputText(
    item: QueuedSessionInput,
    nextText: string,
  ) {
    const parsedQuotedSkills = parseSerializedQuotedSkillPrompt(item.text);
    const skillOnlyPreviewText = parsedQuotedSkills.skillIds.join(" ");
    const normalizedNextText = nextText.trim();
    const serializedText =
      !parsedQuotedSkills.body &&
      parsedQuotedSkills.skillIds.length > 0 &&
      normalizedNextText === skillOnlyPreviewText
        ? item.text.trim()
        : serializeQuotedSkillPrompt(nextText, parsedQuotedSkills.skillIds);
    if (!serializedText.trim() && item.attachments.length === 0) {
      throw new Error("Queued message can't be empty.");
    }

    if (queuedSessionInputPreview.length > 0) {
      const previewIndex =
        Number.parseInt(
          item.inputId.replace("preview-queued-", "").trim(),
          10,
        ) - 1;
      const currentEntries = window.__holabossQueuedMessagesPreviewState ?? [];
      if (previewIndex < 0 || previewIndex >= currentEntries.length) {
        throw new Error("Queued preview item not found.");
      }
      const updatedEntries = currentEntries.map((entry, index) => {
        if (index !== previewIndex) {
          return entry;
        }
        if (typeof entry === "string") {
          return {
            text: serializedText,
            status: item.status,
            attachments: item.attachments,
          };
        }
        return {
          ...entry,
          text: serializedText,
        };
      });
      setQueuedSessionInputPreviewState(updatedEntries);
      return;
    }

    if (item.status !== "queued") {
      throw new Error("Only queued messages can be edited.");
    }

    const updated = await window.electronAPI.workspace.updateQueuedSessionInput(
      {
        workspace_id: item.workspaceId,
        session_id: item.sessionId,
        input_id: item.inputId,
        text: serializedText,
      },
    );

    setQueuedSessionInputs((current) =>
      current.map((currentItem) =>
        currentItem.inputId === item.inputId &&
        currentItem.sessionId === item.sessionId &&
        currentItem.workspaceId === item.workspaceId
          ? {
              ...currentItem,
              text: updated.text,
            }
          : currentItem,
      ),
    );
  }

  function appendPendingLocalFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const acceptedFiles: File[] = [];
    let rejectedImageCount = 0;
    for (const file of files) {
      if (
        !selectedModelSupportsImageInput &&
        attachmentLooksLikeImage(file.name, file.type)
      ) {
        rejectedImageCount += 1;
        continue;
      }
      acceptedFiles.push(file);
    }
    setAttachmentGateMessage(
      rejectedImageCount > 0
        ? `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`
        : "",
    );
    if (acceptedFiles.length === 0) {
      return;
    }

    setPendingAttachments((prev) => [
      ...prev,
      ...acceptedFiles.map((file) => ({
        id: pendingAttachmentId(
          `${file.name}-${file.size}-${file.lastModified}`,
        ),
        source: "local-file" as const,
        file,
      })),
    ]);
  }

  function appendPendingExplorerAttachments(
    files: ExplorerAttachmentDragPayload[],
  ) {
    if (files.length === 0) {
      return;
    }

    const acceptedFiles: ExplorerAttachmentDragPayload[] = [];
    let rejectedImageCount = 0;
    for (const file of files) {
      if (
        !selectedModelSupportsImageInput &&
        resolveExplorerAttachmentKind(file) === "image"
      ) {
        rejectedImageCount += 1;
        continue;
      }
      acceptedFiles.push(file);
    }
    setAttachmentGateMessage(
      rejectedImageCount > 0
        ? `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`
        : "",
    );
    if (acceptedFiles.length === 0) {
      return;
    }

    setPendingAttachments((prev) => [
      ...prev,
      ...acceptedFiles.map((file) => ({
        id: pendingAttachmentId(`${file.absolutePath}-${file.size}`),
        source: "explorer-path" as const,
        absolutePath: file.absolutePath,
        name: file.name,
        mime_type: file.mimeType ?? null,
        size_bytes: file.size,
        kind: resolveExplorerAttachmentKind(file),
      })),
    ]);
  }

  useEffect(() => {
    const requestKey = explorerAttachmentRequest?.requestKey ?? 0;
    if (
      requestKey <= 0 ||
      requestKey === lastHandledExplorerAttachmentRequestKeyRef.current
    ) {
      return;
    }

    lastHandledExplorerAttachmentRequestKeyRef.current = requestKey;
    appendPendingExplorerAttachments(explorerAttachmentRequest?.files ?? []);
    onExplorerAttachmentRequestConsumed?.(requestKey);
  }, [
    explorerAttachmentRequest?.files,
    explorerAttachmentRequest?.requestKey,
    onExplorerAttachmentRequestConsumed,
  ]);

  useEffect(() => {
    const requestKey = artifactBrowserRequest?.requestKey ?? 0;
    const requestWorkspaceId =
      artifactBrowserRequest?.workspaceId?.trim() ?? "";
    const normalizedWorkspaceId = (selectedWorkspaceId || "").trim();
    const mainSessionWorkspaceId =
      (desktopMainSession?.workspace_id || "").trim();
    const mainSessionId = (desktopMainSession?.session_id || "").trim();
    const normalizedActiveSessionId = (activeSessionId || "").trim();
    const requestWorkspaceReady =
      Boolean(requestWorkspaceId) &&
      requestWorkspaceId === normalizedWorkspaceId &&
      requestWorkspaceId === mainSessionWorkspaceId &&
      Boolean(mainSessionId) &&
      normalizedActiveSessionId === mainSessionId &&
      !isLoadingHistory;
    if (
      requestKey <= 0 ||
      requestKey === lastHandledArtifactBrowserRequestKeyRef.current ||
      !requestWorkspaceReady
    ) {
      return;
    }

    lastHandledArtifactBrowserRequestKeyRef.current = requestKey;
    setArtifactBrowserFilter("all");
    setArtifactBrowserScopedOutputs(artifactBrowserRequest?.outputs ?? []);
    setArtifactBrowserScope(artifactBrowserRequest?.scope ?? "reply");
    setArtifactBrowserOpen(true);
    onArtifactBrowserRequestConsumed?.(requestKey);
  }, [
    activeSessionId,
    artifactBrowserRequest?.outputs,
    artifactBrowserRequest?.requestKey,
    artifactBrowserRequest?.scope,
    artifactBrowserRequest?.workspaceId,
    desktopMainSession?.session_id,
    desktopMainSession?.workspace_id,
    isLoadingHistory,
    onArtifactBrowserRequestConsumed,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    let mounted = true;

    const applyVisibleBrowserState = (state: BrowserTabListPayload) => {
      if (mounted) {
        setVisibleBrowserState(state);
      }
    };

    void window.electronAPI.browser.getState().then(applyVisibleBrowserState);
    const unsubscribe = window.electronAPI.browser.onStateChange(
      applyVisibleBrowserState,
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  function onAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    appendPendingLocalFiles(files);
    event.target.value = "";
  }

  function removePendingAttachment(attachmentId: string) {
    setPendingAttachments((prev) =>
      prev.filter((item) => item.id !== attachmentId),
    );
  }

  function addQuotedSkill(skillId: string) {
    setQuotedSkillIds((current) =>
      current.includes(skillId) ? current : [...current, skillId],
    );
  }

  function removeQuotedSkill(skillId: string) {
    setQuotedSkillIds((current) =>
      current.filter((entry) => entry !== skillId),
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const jumpToSessionBrowser = () => {
    if (
      !browserJumpRequest ||
      browserJumpRequest.sessionId !== activeSessionId
    ) {
      return;
    }
    onJumpToSessionBrowser?.(
      browserJumpRequest.sessionId,
      browserJumpRequest.requestKey,
    );
  };

  const openMainSession = async () => {
    let mainSessionId = (desktopMainSession?.session_id || "").trim();
    if (!mainSessionId && selectedWorkspaceId?.trim()) {
      try {
        const ensured = await window.electronAPI.workspace.ensureMainSession(
          selectedWorkspaceId,
        );
        if (ensured.session) {
          setDesktopMainSession(ensured.session);
          mainSessionId = ensured.session.session_id.trim();
        }
      } catch (error) {
        setChatErrorMessage(normalizeErrorMessage(error));
        return;
      }
    }
    if (!mainSessionId) {
      return;
    }
    setLocalSessionOpenRequestState({
      sessionId: mainSessionId,
      requestKey: Date.now(),
      readOnly: false,
    });
  };

  const handleOpenReadOnlyAgentSession = (
    session: AgentSessionRecordPayload,
  ) => {
    const sessionId = session.session_id.trim();
    if (!sessionId) {
      return;
    }
    upsertSessionRecordOverride(session);
    setLocalSessionOpenRequestState({
      sessionId,
      requestKey: Date.now(),
      readOnly: true,
    });
  };

  const handleOpenBackgroundTaskSession = (task: BackgroundTaskRecordPayload) => {
    const childSessionId = task.child_session_id.trim();
    if (!childSessionId) {
      return;
    }
    handleOpenReadOnlyAgentSession({
      workspace_id: task.workspace_id,
      session_id: childSessionId,
      kind: "subagent",
      title: task.title?.trim() || null,
      parent_session_id: task.parent_session_id?.trim() || null,
      source_proposal_id: task.proposal_id?.trim() || null,
      created_by: null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      archived_at: null,
    });
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent =
      event.nativeEvent as KeyboardEvent<HTMLTextAreaElement>["nativeEvent"] & {
        isComposing?: boolean;
        keyCode?: number;
      };
    if (
      composerIsComposingRef.current ||
      nativeEvent.isComposing === true ||
      nativeEvent.keyCode === 229
    ) {
      return;
    }
    if (
      event.key.toLowerCase() === "c" &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      cancelComposerDraftFromKeyboard()
    ) {
      event.preventDefault();
      return;
    }
    if (
      event.key === "ArrowUp" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const selectionStart = event.currentTarget.selectionStart ?? 0;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      if (
        event.currentTarget.value.trim().length === 0 &&
        quotedSkillIds.length === 0 &&
        pendingAttachments.length === 0 &&
        selectionStart === 0 &&
        selectionEnd === 0 &&
        recallLatestComposerInput()
      ) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  };

  const onComposerCompositionStart = (
    _event: CompositionEvent<HTMLTextAreaElement>,
  ) => {
    composerIsComposingRef.current = true;
  };

  const onComposerCompositionEnd = (
    _event: CompositionEvent<HTMLTextAreaElement>,
  ) => {
    composerIsComposingRef.current = false;
  };

  const assistantMode = isOnboardingVariant
    ? "workspace setup"
    : assistantMetaLabel(
        selectedWorkspace?.harness,
        runtimeConfig?.defaultModel,
      );
  const visibleAgentBrowserSessionId =
    visibleBrowserState.space === "agent"
      ? visibleBrowserState.controlSessionId ||
        visibleBrowserState.sessionId ||
        ""
      : "";
  const showSessionBrowserJumpCta = Boolean(
    browserJumpRequest &&
    activeSessionId &&
    browserJumpRequest.sessionId === activeSessionId &&
    (visibleBrowserState.space !== "agent" ||
      visibleAgentBrowserSessionId !== activeSessionId),
  );
  const sessionBrowserJumpCta = showSessionBrowserJumpCta ? (
    <button
      type="button"
      onClick={jumpToSessionBrowser}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground"
    >
      <Globe className="size-3 opacity-80" />
      <span>View in agent browser</span>
      <ArrowUpRight className="size-3 opacity-80" />
    </button>
  ) : null;
  const renderedLiveAssistantSegments = liveAssistantSegmentsForRender(
    liveAssistantSegments,
    liveExecutionItems,
    liveAssistantText,
  );
  const hasVisibleLiveAssistantContent =
    ((!activeSessionId ||
      activeSessionId === (desktopMainSession?.session_id || "").trim())
      ? false
      : !isOnboardingVariant)
      || isOnboardingVariant
    ? renderedLiveAssistantSegments.length > 0
    : renderedLiveAssistantSegments.some(
        (segment) => segment.kind === "output" && Boolean(segment.text.trim()),
      );
  const showLiveAssistantTurn =
    isResponding ||
    hasVisibleLiveAssistantContent;
  const queuedSessionInputPreview = useQueuedSessionInputPreview({
    workspaceId: selectedWorkspaceId,
    sessionId: activeSessionId,
  });
  const activeQueuedSessionInputs = useMemo(
    () =>
      queuedSessionInputs.filter(
        (item) =>
          item.workspaceId === (selectedWorkspaceId || "").trim() &&
          item.sessionId === (activeSessionId || "").trim(),
      ),
    [activeSessionId, queuedSessionInputs, selectedWorkspaceId],
  );
  const displayedQueuedSessionInputs =
    queuedSessionInputPreview.length > 0
      ? queuedSessionInputPreview
      : activeQueuedSessionInputs;
  const streamTelemetryTail = useMemo(
    () => streamTelemetry.slice(-80).reverse(),
    [streamTelemetry],
  );
  const pendingAttachmentItems = useMemo(
    () =>
      pendingAttachments.map((attachment) => ({
        id: attachment.id,
        kind:
          attachment.source === "local-file"
            ? attachmentLooksLikeImage(
                attachment.file.name,
                attachment.file.type,
              )
              ? ("image" as const)
              : ("file" as const)
            : attachment.kind,
        name:
          attachment.source === "local-file"
            ? attachment.file.name
            : attachment.name,
        size_bytes:
          attachment.source === "local-file"
            ? attachment.file.size
            : attachment.size_bytes,
        ...(attachment.source === "local-file"
          ? { file: attachment.file }
          : { workspace_path: attachment.absolutePath }),
      })),
    [pendingAttachments],
  );

  const clearImageAttachmentPreviewObjectUrl = () => {
    if (!imageAttachmentPreviewObjectUrlRef.current) {
      return;
    }
    URL.revokeObjectURL(imageAttachmentPreviewObjectUrlRef.current);
    imageAttachmentPreviewObjectUrlRef.current = null;
  };

  const closeImageAttachmentPreview = () => {
    imageAttachmentPreviewRequestIdRef.current += 1;
    clearImageAttachmentPreviewObjectUrl();
    setImageAttachmentPreview(null);
  };

  useEffect(() => {
    return () => {
      clearImageAttachmentPreviewObjectUrl();
    };
  }, []);

  useEffect(() => {
    onImageAttachmentPreviewOpenChange?.(Boolean(imageAttachmentPreview));
  }, [imageAttachmentPreview, onImageAttachmentPreviewOpenChange]);

  useEffect(() => {
    return () => {
      onImageAttachmentPreviewOpenChange?.(false);
    };
  }, [onImageAttachmentPreviewOpenChange]);

  const openImageAttachmentPreview = async (attachment: AttachmentListItem) => {
    if (attachment.kind !== "image") {
      return;
    }

    const attachmentPath = attachment.workspace_path?.trim() || "";
    if (!attachment.file && !attachmentPath) {
      return;
    }

    imageAttachmentPreviewRequestIdRef.current += 1;
    const requestId = imageAttachmentPreviewRequestIdRef.current;
    clearImageAttachmentPreviewObjectUrl();
    let localObjectUrl = "";
    const browserSnapshotPromise = window.electronAPI.browser
      .captureVisibleSnapshot()
      .catch(() => null);
    const imageDataResultPromise = (async () => {
      try {
        if (attachment.file) {
          localObjectUrl = URL.createObjectURL(attachment.file);
          return { status: "fulfilled" as const, dataUrl: localObjectUrl };
        }

        const preview = await window.electronAPI.fs.readFilePreview(
          attachmentPath,
          selectedWorkspaceId,
        );
        if (preview.kind !== "image" || !preview.dataUrl) {
          throw new Error(
            preview.unsupportedReason ||
              "Image preview is not available for this attachment.",
          );
        }
        return { status: "fulfilled" as const, dataUrl: preview.dataUrl };
      } catch (error) {
        return { status: "rejected" as const, error };
      }
    })();

    const browserSnapshot = await browserSnapshotPromise;
    if (imageAttachmentPreviewRequestIdRef.current !== requestId) {
      if (localObjectUrl) {
        URL.revokeObjectURL(localObjectUrl);
      }
      return;
    }

    setImageAttachmentPreview({
      attachment,
      browserSnapshot,
      dataUrl: "",
      isLoading: true,
      errorMessage: "",
    });

    const imageDataResult = await imageDataResultPromise;
    if (imageAttachmentPreviewRequestIdRef.current !== requestId) {
      if (localObjectUrl) {
        URL.revokeObjectURL(localObjectUrl);
      }
      return;
    }

    if (imageDataResult.status === "rejected") {
      clearImageAttachmentPreviewObjectUrl();
      setImageAttachmentPreview({
        attachment,
        browserSnapshot,
        dataUrl: "",
        isLoading: false,
        errorMessage:
          imageDataResult.error instanceof Error &&
          imageDataResult.error.message.trim()
            ? imageDataResult.error.message
            : "Failed to load image preview.",
      });
      return;
    }

    if (localObjectUrl) {
      imageAttachmentPreviewObjectUrlRef.current = localObjectUrl;
    }

    setImageAttachmentPreview({
      attachment,
      browserSnapshot,
      dataUrl: imageDataResult.dataUrl,
      isLoading: false,
      errorMessage: "",
    });
  };

  useEffect(() => {
    if (
      !browserJumpRequest ||
      !activeSessionId ||
      browserJumpRequest.sessionId !== activeSessionId
    ) {
      return;
    }
    if (
      visibleBrowserState.space === "agent" &&
      visibleAgentBrowserSessionId === activeSessionId
    ) {
      onBrowserJumpRequestConsumed?.(
        activeSessionId,
        browserJumpRequest.requestKey,
      );
    }
  }, [
    activeSessionId,
    browserJumpRequest,
    onBrowserJumpRequestConsumed,
    visibleAgentBrowserSessionId,
    visibleBrowserState.space,
  ]);
  const availableWorkspaceSkillMap = useMemo(
    () =>
      new Map(
        availableWorkspaceSkills.map(
          (skill) => [skill.skill_id, skill] as const,
        ),
      ),
    [availableWorkspaceSkills],
  );
  const quotedSkills = useMemo<ChatComposerQuotedSkillItem[]>(
    () =>
      quotedSkillIds.map((skillId) => {
        const skill = availableWorkspaceSkillMap.get(skillId);
        return {
          skillId,
          title: skill?.title ?? skillId,
        };
      }),
    [availableWorkspaceSkillMap, quotedSkillIds],
  );
  const slashCommandOptions = useMemo(
    () => buildComposerSlashCommandOptions(availableWorkspaceSkills),
    [availableWorkspaceSkills],
  );
  const activeSessionRecord = useMemo(() => {
    const normalizedActiveSessionId = activeSessionId.trim();
    if (!normalizedActiveSessionId) {
      return desktopMainSession;
    }
    if (
      normalizedActiveSessionId ===
      (desktopMainSession?.session_id?.trim() || "")
    ) {
      return desktopMainSession;
    }
    return sessionRecordOverrides[normalizedActiveSessionId] ?? null;
  }, [activeSessionId, desktopMainSession, sessionRecordOverrides]);
  const activeSessionKind = (activeSessionRecord?.kind || "")
    .trim()
    .toLowerCase();
  const isViewingBoundMainSession =
    !activeSessionId ||
    activeSessionId === (desktopMainSession?.session_id || "").trim();
  const isReadOnlyInspectionSession =
    !isViewingBoundMainSession && !isOnboardingVariant;
  const activeSessionTitle = isViewingBoundMainSession
    ? (desktopMainSession?.title?.trim() ||
        selectedWorkspace?.name?.trim() ||
        "Main session")
    : (activeSessionRecord?.title?.trim() ||
        defaultWorkspaceSessionTitle(activeSessionRecord?.kind, activeSessionId));
  const assistantLabel = isViewingBoundMainSession ? "Hola" : activeSessionTitle;
  const activeSessionDetail = isViewingBoundMainSession
    ? "Main session"
    : isReadOnlyInspectionSession
      ? `${inspectableSessionLabel(activeSessionRecord)} · Read-only inspection`
      : "Session view";
  const showSessionExecutionInternals =
    isReadOnlyInspectionSession || isOnboardingVariant;
  const displayMessages = useMemo(
    () =>
      messages.filter((message) =>
        message.role === "assistant"
          ? hasRenderableAssistantTurn(message, {
              showExecutionInternals: showSessionExecutionInternals,
            })
          : hasRenderableMessageContent(
              message.text,
              message.attachments ?? [],
            ),
      ),
    [messages, showSessionExecutionInternals],
  );
  const lastCompletedAssistantMessageId = useMemo(() => {
    if (showLiveAssistantTurn) {
      return null;
    }
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      const candidate = displayMessages[index];
      if (candidate && candidate.role !== "user") {
        return candidate.id;
      }
    }
    return null;
  }, [displayMessages, showLiveAssistantTurn]);
  const hasMessages = displayMessages.length > 0 || showLiveAssistantTurn;
  const hasLoaderHeader =
    isLoadingOlderHistory ||
    loadedHistoryMessageCount < totalHistoryMessageCount;
  const readinessMessage =
    !selectedWorkspace || isOnboardingVariant || workspaceAppsReady
      ? ""
      : workspaceBlockingReason ||
        (isActivatingWorkspace
          ? "Preparing workspace apps..."
          : "Workspace apps are still starting.");
  const baseComposerDisabledReason = !selectedWorkspace
    ? "Select a workspace to start chatting."
    : isLoadingBootstrap || isLoadingHistory
      ? "Loading workspace context..."
      : !isOnboardingVariant && !workspaceAppsReady
        ? readinessMessage || "Workspace apps are still starting."
        : "";
  const isSignedIn = Boolean(sessionUserId(authSessionState.data));
  const holabossProxyModelsAvailable =
    isSignedIn &&
    Boolean(runtimeConfig?.authTokenPresent) &&
    Boolean((runtimeConfig?.modelProxyBaseUrl || "").trim());
  const configuredProviderModelGroups =
    runtimeConfig?.providerModelGroups ?? [];
  const visibleConfiguredProviderModelGroups = configuredProviderModelGroups
    .filter(
      (providerGroup) =>
        isSignedIn || !isHolabossProviderId(providerGroup.providerId),
    )
    .map((providerGroup) => ({
      ...providerGroup,
      pending:
        isSignedIn &&
        isHolabossProviderId(providerGroup.providerId) &&
        !holabossProxyModelsAvailable,
      models: providerGroup.models.filter((model) => {
        const normalizedToken = model.token.trim();
        if (!normalizedToken || isDeprecatedChatModel(normalizedToken)) {
          return false;
        }
        if (!runtimeModelHasChatCapability(model)) {
          return false;
        }
        return true;
      }),
    }))
    .filter((providerGroup) => providerGroup.models.length > 0);
  const hasConfiguredProviderCatalog =
    visibleConfiguredProviderModelGroups.length > 0;
  const hasPendingConfiguredProviderCatalog =
    visibleConfiguredProviderModelGroups.some(
      (providerGroup) => providerGroup.pending,
    );
  const providerModelLabelCounts = new Map<string, number>();
  for (const providerGroup of visibleConfiguredProviderModelGroups) {
    for (const model of providerGroup.models) {
      const modelLabel = runtimeModelDisplayLabel(model);
      providerModelLabelCounts.set(
        modelLabel,
        (providerModelLabelCounts.get(modelLabel) ?? 0) + 1,
      );
    }
  }
  const runtimeDefaultModel =
    runtimeConfig?.defaultModel?.trim() || DEFAULT_RUNTIME_MODEL;
  const requiresModelProviderSetup =
    !hasConfiguredProviderCatalog && !holabossProxyModelsAvailable;
  const runtimeDefaultModelAvailable =
    !requiresModelProviderSetup &&
    !hasConfiguredProviderCatalog &&
    (holabossProxyModelsAvailable ||
      !isHolabossProxyModel(runtimeDefaultModel));
  const availableChatModelOptionGroups: ChatModelOptionGroup[] =
    hasConfiguredProviderCatalog
      ? visibleConfiguredProviderModelGroups.map((providerGroup) => ({
          label: providerGroup.providerLabel,
          options: providerGroup.models.map((model) => {
            const modelLabel = runtimeModelDisplayLabel(model);
            const needsProviderPrefix =
              visibleConfiguredProviderModelGroups.length > 1 &&
              (providerModelLabelCounts.get(modelLabel) ?? 0) > 1;
            return {
              value: model.token,
              label: modelLabel,
              selectedLabel: needsProviderPrefix
                ? `${providerGroup.providerLabel} · ${modelLabel}`
                : modelLabel,
              searchText: `${providerGroup.providerLabel} ${modelLabel} ${model.token}`,
              disabled: providerGroup.pending,
              statusLabel: providerGroup.pending ? "Pending" : undefined,
            };
          }),
        }))
      : [];
  const availableChatModelOptions = hasConfiguredProviderCatalog
    ? availableChatModelOptionGroups.flatMap((group) =>
        group.options.filter((option) => !option.disabled),
      )
    : requiresModelProviderSetup
      ? []
      : Array.from(
          new Set([
            runtimeDefaultModel,
            DEFAULT_RUNTIME_MODEL,
            ...(chatModelPreference !== CHAT_MODEL_USE_RUNTIME_DEFAULT
              ? [chatModelPreference]
              : []),
            ...CHAT_MODEL_PRESETS,
          ]),
        )
          .filter(Boolean)
          .filter((model) => !isDeprecatedChatModel(model))
          .filter(
            (model) =>
              holabossProxyModelsAvailable || !isHolabossProxyModel(model),
          )
          .map((model) => ({
            value: model,
            label: displayModelLabel(model),
          }));
  const normalizedModelPreference = chatModelPreference.trim();
  const modelPreferenceAvailable = hasConfiguredProviderCatalog
    ? normalizedModelPreference.length > 0 &&
      availableChatModelOptions.some(
        (option) => option.value === normalizedModelPreference,
      )
    : chatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : availableChatModelOptions.some(
          (option) => option.value === normalizedModelPreference,
        );
  const effectiveChatModelPreference = hasConfiguredProviderCatalog
    ? modelPreferenceAvailable
      ? normalizedModelPreference
      : availableChatModelOptions[0]?.value || ""
    : modelPreferenceAvailable
      ? chatModelPreference
      : runtimeDefaultModelAvailable
        ? CHAT_MODEL_USE_RUNTIME_DEFAULT
        : availableChatModelOptions[0]?.value || CHAT_MODEL_USE_RUNTIME_DEFAULT;
  const resolvedChatModel = hasConfiguredProviderCatalog
    ? effectiveChatModelPreference
    : effectiveChatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
        ? runtimeDefaultModel
        : ""
      : effectiveChatModelPreference.trim() ||
        (runtimeDefaultModelAvailable ? runtimeDefaultModel : "");
  const selectedConfiguredModel =
    visibleConfiguredProviderModelGroups
      .flatMap((providerGroup) => providerGroup.models)
      .find((model) => model.token === resolvedChatModel) ?? null;
  const selectedManagedProviderGroup =
    visibleConfiguredProviderModelGroups.find((providerGroup) =>
      providerGroup.models.some((model) => model.token === resolvedChatModel),
    );
  const selectedFallbackModelMetadata =
    !selectedConfiguredModel &&
    !hasConfiguredProviderCatalog &&
    holabossProxyModelsAvailable &&
    resolvedChatModel
      ? modelCatalog.catalogMetadataForProviderModel(
          "holaboss_model_proxy",
          resolvedChatModel,
        )
      : null;
  const selectedModelSupportsReasoning = selectedConfiguredModel
    ? selectedConfiguredModel.reasoning === true
    : Boolean(selectedFallbackModelMetadata?.reasoning);
  const selectedInputModalities = selectedConfiguredModel
    ? (selectedConfiguredModel.inputModalities ?? [])
    : (selectedFallbackModelMetadata?.inputModalities ?? []);
  const selectedModelDisplayLabel = selectedConfiguredModel
    ? runtimeModelDisplayLabel(selectedConfiguredModel)
    : selectedFallbackModelMetadata?.label?.trim() ||
      (resolvedChatModel ? displayModelLabel(resolvedChatModel) : "");
  const selectedModelSupportsImageInput = supportsImageInput(
    selectedInputModalities,
  );
  const selectedThinkingValues = selectedConfiguredModel
    ? runtimeModelThinkingValues(selectedConfiguredModel)
    : (selectedFallbackModelMetadata?.thinkingValues ?? []);
  const selectedDefaultThinkingValue = selectedConfiguredModel
    ? selectedConfiguredModel.defaultThinkingValue?.trim() || null
    : (selectedFallbackModelMetadata?.defaultThinkingValue ?? null);
  const selectedStoredThinkingValue = resolvedChatModel
    ? (chatThinkingPreferences[resolvedChatModel] ?? "").trim()
    : "";
  const effectiveThinkingValue =
    !selectedModelSupportsReasoning || selectedThinkingValues.length === 0
      ? null
      : selectedThinkingValues.includes(selectedStoredThinkingValue)
        ? selectedStoredThinkingValue
        : selectedThinkingValues.includes("medium")
          ? "medium"
          : selectedDefaultThinkingValue &&
              selectedThinkingValues.includes(selectedDefaultThinkingValue)
            ? selectedDefaultThinkingValue
            : (selectedThinkingValues[0] ?? null);
  const showThinkingValueSelector =
    !isOnboardingVariant &&
    selectedModelSupportsReasoning &&
    selectedThinkingValues.length > 0;
  const setSelectedThinkingValue = (value: string | null) => {
    if (!resolvedChatModel) {
      return;
    }
    const normalizedValue = value?.trim() ?? "";
    if (!normalizedValue) {
      return;
    }
    setChatThinkingPreferences((current) => ({
      ...current,
      [resolvedChatModel]: normalizedValue,
    }));
  };
  const usesHostedManagedCredits =
    hasHostedBillingAccount &&
    (hasConfiguredProviderCatalog
      ? selectedManagedProviderGroup?.kind === "holaboss_proxy"
      : holabossProxyModelsAvailable && Boolean(resolvedChatModel));
  const modelSelectionUnavailableReason =
    availableChatModelOptions.length > 0
      ? ""
      : hasPendingConfiguredProviderCatalog
        ? "Managed models are finishing setup. Refresh runtime binding or use another provider."
        : "No models available. Configure a provider to start chatting.";
  const composerBaseDisabledReason =
    (isReadOnlyInspectionSession
      ? "Inspection sessions are read-only. Return to the main session to continue the conversation."
      : "") ||
    baseComposerDisabledReason ||
    (usesHostedManagedCredits && isOutOfCredits
      ? "You're out of credits for managed usage."
      : "") ||
    (!isOnboardingVariant && !resolvedChatModel
      ? modelSelectionUnavailableReason
      : "");
  const composerDisabledReason =
    composerBaseDisabledReason ||
    (isSubmittingMessage ? "Submitting message..." : "");
  const composerDisabled = Boolean(composerDisabledReason);
  const pendingImageInputUnsupportedMessage =
    pendingAttachments.some((attachment) =>
      pendingAttachmentIsImage(attachment),
    ) &&
    !selectedModelSupportsImageInput
      ? `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Remove the attached image or switch models.`
      : "";
  const showLowBalanceWarning =
    usesHostedManagedCredits && isLowBalance && !isOutOfCredits;
  const showOutOfCreditsWarning = usesHostedManagedCredits && isOutOfCredits;
  const chatPaneSentryState = useMemo(
    () => ({
      workspace_id: selectedWorkspaceId || null,
      session_id: activeSessionId || null,
      variant,
      signed_in: isSignedIn,
      workspace_ready: Boolean(selectedWorkspace) && workspaceAppsReady,
      workspace_blocking_reason: workspaceBlockingReason || null,
      runtime_default_model: runtimeConfig?.defaultModel ?? null,
      session_metrics: {
        available_session_count: desktopMainSession ? 1 : 0,
        active_queued_input_count: activeQueuedSessionInputs.length,
        message_count: messages.length,
        session_output_count: sessionOutputs.length,
        live_segment_count: liveAssistantSegments.length,
        live_execution_item_count: liveExecutionItems.length,
      },
      composer: {
        input_length: input.length,
        quoted_skill_count: quotedSkillIds.length,
        pending_attachment_count: pendingAttachments.length,
        disabled: composerDisabled,
        disabled_reason: composerDisabledReason || null,
        attachment_gate_message: attachmentGateMessage || null,
        pending_image_input_unsupported_message:
          pendingImageInputUnsupportedMessage || null,
      },
      activity: {
        is_loading_history: isLoadingHistory,
        is_loading_older_history: isLoadingOlderHistory,
        is_history_viewport_pending: isHistoryViewportPending,
        is_responding: isResponding,
        is_submitting_message: isSubmittingMessage,
        is_pause_pending: isPausePending,
        live_agent_status: liveAgentStatus || null,
        chat_error_message: chatErrorMessage || null,
        artifact_browser_open: artifactBrowserOpen,
      },
      model_selection: {
        selected_model: effectiveChatModelPreference || null,
        resolved_model: resolvedChatModel || null,
        selected_model_label: selectedModelDisplayLabel || null,
        thinking_value: effectiveThinkingValue,
        supports_reasoning: selectedModelSupportsReasoning,
        supports_image_input: selectedModelSupportsImageInput,
      },
      browser_state: {
        space: visibleBrowserState.space,
        active_tab_id: visibleBrowserState.activeTabId || null,
        tab_count: visibleBrowserState.tabs.length,
        user_tab_count: visibleBrowserState.tabCounts.user,
        agent_tab_count: visibleBrowserState.tabCounts.agent,
        session_id: visibleBrowserState.sessionId || null,
        control_mode: visibleBrowserState.controlMode,
        control_session_id: visibleBrowserState.controlSessionId || null,
        lifecycle_state: visibleBrowserState.lifecycleState ?? null,
      },
      billing: {
        low_balance: showLowBalanceWarning,
        out_of_credits: showOutOfCreditsWarning,
        uses_hosted_managed_credits: usesHostedManagedCredits,
      },
    }),
    [
      activeQueuedSessionInputs.length,
      activeSessionId,
      artifactBrowserOpen,
      attachmentGateMessage,
      chatErrorMessage,
      composerDisabled,
      composerDisabledReason,
      desktopMainSession,
      effectiveChatModelPreference,
      effectiveThinkingValue,
      input.length,
      isLoadingHistory,
      isLoadingOlderHistory,
      isHistoryViewportPending,
      isPausePending,
      isResponding,
      isSignedIn,
      isSubmittingMessage,
      liveAgentStatus,
      liveAssistantSegments.length,
      liveExecutionItems.length,
      messages.length,
      pendingAttachments.length,
      pendingImageInputUnsupportedMessage,
      quotedSkillIds.length,
      resolvedChatModel,
      runtimeConfig?.defaultModel,
      selectedModelDisplayLabel,
      selectedModelSupportsImageInput,
      selectedModelSupportsReasoning,
      selectedWorkspace,
      selectedWorkspaceId,
      sessionOutputs.length,
      showLowBalanceWarning,
      showOutOfCreditsWarning,
      variant,
      visibleBrowserState,
      usesHostedManagedCredits,
      workspaceAppsReady,
      workspaceBlockingReason,
    ],
  );
  useRendererSentrySection("chat_pane", chatPaneSentryState);

  useEffect(() => {
    pushRendererSentryActivity("chat", "chat session changed", {
      workspace_id: selectedWorkspaceId || null,
      session_id: activeSessionId || null,
    });
  }, [activeSessionId, selectedWorkspaceId]);

  useEffect(() => {
    pushRendererSentryActivity("chat", "chat model selection changed", {
      session_id: activeSessionId || null,
      selected_model: effectiveChatModelPreference || null,
      resolved_model: resolvedChatModel || null,
      thinking_value: effectiveThinkingValue,
    });
  }, [
    activeSessionId,
    effectiveChatModelPreference,
    effectiveThinkingValue,
    resolvedChatModel,
  ]);

  useEffect(() => {
    if (!chatErrorMessage) {
      return;
    }
    pushRendererSentryActivity("chat", "chat error surfaced", {
      session_id: activeSessionId || null,
      workspace_id: selectedWorkspaceId || null,
      message: chatErrorMessage,
    });
  }, [activeSessionId, chatErrorMessage, selectedWorkspaceId]);

  useEffect(() => {
    pushRendererSentryActivity("chat", "chat activity state changed", {
      session_id: activeSessionId || null,
      is_responding: isResponding,
      is_submitting_message: isSubmittingMessage,
      is_pause_pending: isPausePending,
      live_agent_status: liveAgentStatus || null,
    });
  }, [
    activeSessionId,
    isPausePending,
    isResponding,
    isSubmittingMessage,
    liveAgentStatus,
  ]);

  useEffect(() => {
    pushRendererSentryActivity("browser", "chat browser state changed", {
      session_id: activeSessionId || null,
      browser_space: visibleBrowserState.space,
      tab_count: visibleBrowserState.tabs.length,
      control_mode: visibleBrowserState.controlMode,
      browser_session_id: visibleBrowserState.sessionId || null,
      control_session_id: visibleBrowserState.controlSessionId || null,
      lifecycle_state: visibleBrowserState.lifecycleState ?? null,
    });
  }, [
    activeSessionId,
    visibleBrowserState.controlMode,
    visibleBrowserState.controlSessionId,
    visibleBrowserState.lifecycleState,
    visibleBrowserState.sessionId,
    visibleBrowserState.space,
    visibleBrowserState.tabs.length,
  ]);

  useEffect(() => {
    if (!effectiveChatModelPreference) {
      return;
    }
    if (chatModelPreference.trim() === effectiveChatModelPreference) {
      return;
    }
    setChatModelPreference(effectiveChatModelPreference);
  }, [chatModelPreference, effectiveChatModelPreference]);

  useEffect(() => {
    if (!resolvedChatModel || !effectiveThinkingValue) {
      return;
    }
    setChatThinkingPreferences((current) => {
      if ((current[resolvedChatModel] ?? "") === effectiveThinkingValue) {
        return current;
      }
      return {
        ...current,
        [resolvedChatModel]: effectiveThinkingValue,
      };
    });
  }, [effectiveThinkingValue, resolvedChatModel]);

  useEffect(() => {
    setAttachmentGateMessage("");
  }, [resolvedChatModel]);

  const textareaPlaceholder = isOnboardingVariant
    ? "Answer the onboarding prompt or share setup details"
    : "Ask anything";
  const showHistoryRestoreScreen = isLoadingHistory || isHistoryViewportPending;

  useEffect(() => {
    if (!hasMessages) {
      setComposerBlockHeight(0);
      return;
    }

    const composerBlock = composerBlockRef.current;
    if (!composerBlock) {
      return;
    }

    const updateComposerBlockHeight = () => {
      setComposerBlockHeight(
        Math.round(composerBlock.getBoundingClientRect().height),
      );
    };

    updateComposerBlockHeight();
    const resizeObserver = new ResizeObserver(() => {
      updateComposerBlockHeight();
    });
    resizeObserver.observe(composerBlock);
    return () => {
      resizeObserver.disconnect();
    };
  }, [hasMessages]);

  return (
    <PaneCard
      className={isOnboardingVariant ? "w-full border-primary/20" : "w-full"}
    >
      <div className="relative flex h-full min-h-0 min-w-0 flex-col">
        <div className="theme-chat-composer-glow pointer-events-none absolute inset-x-8 bottom-0 h-44 rounded-full blur-2xl" />

        {isOnboardingVariant && selectedWorkspace ? (
          <div className="shrink-0 px-4 pt-4 sm:px-5">
            <div className="bg-muted overflow-hidden rounded-2xl border border-primary/20 shadow-subtle-xs">
              <div className="bg-[radial-gradient(circle_at_top_left,rgba(247,90,84,0.12),transparent_42%),radial-gradient(circle_at_92%_12%,rgba(247,170,126,0.12),transparent_36%)] px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium uppercase text-primary">
                      Workspace onboarding
                    </div>
                    <div className="mt-2 text-lg font-semibold text-foreground">
                      {selectedWorkspace.name.trim() || "Workspace setup"}
                    </div>
                  </div>

                  <div
                    className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-[10px] font-medium uppercase ${onboardingStatusTone(
                      selectedWorkspace.onboarding_status,
                    )}`}
                  >
                    {onboardingStatusLabel(selectedWorkspace.onboarding_status)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!isOnboardingVariant ? (
          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <ChatHeader
              title={activeSessionTitle}
              detail={activeSessionDetail}
              onReturnToMainSession={
                isReadOnlyInspectionSession
                  ? () => {
                      void openMainSession();
                    }
                  : undefined
              }
              onOpenInbox={onOpenInbox}
              inboxUnreadCount={inboxUnreadCount}
              onOpenSessions={onOpenSessions}
              onOpenAutomations={onOpenAutomations}
            />
          </div>
        ) : null}

        {showLowBalanceWarning || showOutOfCreditsWarning ? (
          <div className="shrink-0 px-4 pt-3 sm:px-5">
            <div className="bg-muted flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Hosted credits
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  {showOutOfCreditsWarning
                    ? "You're out of credits for managed usage."
                    : "Credits are running low. Add more on web to avoid interruptions."}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openExternalUrl(billingLinks?.addCreditsUrl)}
                  className="rounded-full border-primary bg-primary/10 text-primary hover:bg-primary/16"
                >
                  Add credits
                </Button>
                {showOutOfCreditsWarning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      openExternalUrl(billingLinks?.billingPageUrl)
                    }
                    className="rounded-full"
                  >
                    Manage on web
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {chatErrorMessage ||
        backgroundDeliveryStatusMessage ||
        attachmentGateMessage ||
        pendingImageInputUnsupportedMessage ||
        verboseTelemetryEnabled ? (
          <div className="shrink-0 px-4 pt-3 sm:px-5">
            {chatErrorMessage ? (
              <div className="theme-chat-system-bubble rounded-xl border px-3 py-2 text-xs">
                {chatErrorMessage}
              </div>
            ) : null}

            {backgroundDeliveryStatusMessage ? (
              <div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">
                {backgroundDeliveryStatusMessage}
              </div>
            ) : null}

            {attachmentGateMessage ? (
              <div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">
                {attachmentGateMessage}
              </div>
            ) : null}

            {!attachmentGateMessage && pendingImageInputUnsupportedMessage ? (
              <div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">
                {pendingImageInputUnsupportedMessage}
              </div>
            ) : null}

            {verboseTelemetryEnabled ? (
              <div className="bg-muted mt-3 rounded-xl border border-border px-3 py-2">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] text-muted-foreground">
                    Stream telemetry ({streamTelemetry.length})
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setStreamTelemetry([])}
                    className="text-[10px]"
                  >
                    Clear
                  </Button>
                </div>
                <div className="bg-muted max-h-36 overflow-y-auto rounded border border-border p-2 font-mono text-[10px] text-muted-foreground">
                  {streamTelemetryTail.length === 0 ? (
                    <div className="text-muted-foreground">
                      No stream events yet.
                    </div>
                  ) : (
                    streamTelemetryTail.map((entry) => (
                      <div
                        key={entry.id}
                        className="whitespace-pre-wrap break-all"
                      >
                        {`${entry.at} ${entry.action} stream=${entry.streamId} transport=${entry.transportType} event=${entry.eventType || entry.eventName} input=${entry.inputId || "-"} session=${entry.sessionId || "-"} detail=${entry.detail || "-"}`}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {!isOnboardingVariant && !isReadOnlyInspectionSession ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <div className="pointer-events-auto">
                <BackgroundTasksPane
                  workspaceId={selectedWorkspaceId}
                  variant="inline"
                  onOpenTaskSession={handleOpenBackgroundTaskSession}
                />
              </div>
            </div>
          ) : null}
          <div
            className="group/chat-scroll relative min-h-0 flex-1 overflow-hidden"
            style={{
              maskImage: chatScrollMaskImage(),
              WebkitMaskImage: chatScrollMaskImage(),
            }}
          >
            <div
              ref={messagesRef}
              onWheelCapture={(event) => {
                if (event.deltaY < 0) {
                  shouldAutoScrollRef.current = false;
                }
              }}
              onScroll={(event) => {
                const { currentTarget } = event;
                const nextScrollTop = currentTarget.scrollTop;
                const scrolledUp = nextScrollTop < lastChatScrollTopRef.current;
                lastChatScrollTopRef.current = nextScrollTop;
                const nearBottom = isNearChatBottom(currentTarget);
                shouldAutoScrollRef.current = scrolledUp ? false : nearBottom;
                setIsAwayFromChatBottom((current) =>
                  current === !nearBottom ? current : !nearBottom,
                );
                if (
                  currentTarget.scrollTop <= CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX
                ) {
                  void loadOlderSessionHistory();
                }
              }}
              className={`chat-scrollbar-thin h-full min-h-0 overflow-x-hidden overflow-y-auto ${hasMessages ? "" : "flex items-center justify-center"}`}
            >
              {hasMessages ? (
                <div
                  ref={messagesContentRef}
                  className={`flex min-w-0 w-full flex-col gap-4 pl-4 pr-7 pb-3 pt-5 ${
                    showHistoryRestoreScreen ? "invisible" : ""
                  }`}
                >
                  {hasLoaderHeader ? (
                    <div className="flex justify-center">
                      <div className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
                        {isLoadingOlderHistory
                          ? "Loading earlier messages..."
                          : "Scroll up for earlier messages"}
                      </div>
                    </div>
                  ) : null}
                  <ConversationTurns
                    messages={displayMessages}
                    assistantLabel={assistantLabel}
                    assistantMode={assistantMode}
                    showExecutionInternals={showSessionExecutionInternals}
                    onPreviewAttachment={openImageAttachmentPreview}
                    onOpenOutput={onOpenOutput}
                    onOpenAllArtifacts={(outputs) => {
                      setArtifactBrowserFilter("all");
                      setArtifactBrowserScopedOutputs(outputs);
                      setArtifactBrowserScope("reply");
                      setArtifactBrowserOpen(true);
                    }}
                    collapsedTraceByStepId={collapsedTraceByStepId}
                    onToggleTraceStep={toggleTraceStep}
                    onLinkClick={onOpenLinkInBrowser}
                    onLocalLinkClick={onOpenLocalLink}
                    memoryProposalAction={memoryProposalAction}
                    editingMemoryProposalId={editingMemoryProposalId}
                    memoryProposalDrafts={memoryProposalDrafts}
                    onEditMemoryProposal={(message, proposalId) => {
                      setEditingMemoryProposalId((current) => {
                        const next =
                          current === proposalId ? null : proposalId;
                        if (next === proposalId) {
                          const proposal = (
                            message.memoryProposals ?? []
                          ).find((item) => item.proposal_id === proposalId);
                          if (proposal) {
                            setMemoryProposalDrafts((prev) => ({
                              ...prev,
                              [proposalId]:
                                prev[proposalId] ?? proposal.summary,
                            }));
                          }
                        }
                        return next;
                      });
                    }}
                    onMemoryProposalDraftChange={updateMemoryProposalDraft}
                    onAcceptMemoryProposal={handleAcceptMemoryProposal}
                    onDismissMemoryProposal={handleDismissMemoryProposal}
                    assistantFooterAccessoryMessageId={
                      lastCompletedAssistantMessageId
                    }
                    assistantFooterAccessory={sessionBrowserJumpCta}
                    liveAssistantTurn={
                      showLiveAssistantTurn
                        ? {
                            text: liveAssistantText,
                            tone: "default",
                            segments: renderedLiveAssistantSegments,
                            executionItems: liveExecutionItems,
                            status:
                              liveAgentStatus || (isResponding ? "Working" : ""),
                            statusAccessory: sessionBrowserJumpCta,
                          }
                        : null
                    }
                  />
                </div>
              ) : (
                <div
                  className={`w-full px-4 pb-10 pt-10 sm:px-5 ${
                    showHistoryRestoreScreen ? "invisible" : ""
                  }`}
                >
                  <div className="mx-auto mb-8 flex max-w-[520px] flex-col items-center text-center">
                    <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                      {isLoadingBootstrap || isLoadingHistory
                        ? "Loading workspace context"
                        : isOnboardingVariant
                          ? "Complete workspace onboarding"
                          : "What can I help with?"}
                    </h2>
                    {(() => {
                      const hint = !selectedWorkspace
                        ? "Pick a template, create a workspace, then send the first instruction."
                        : isOnboardingVariant
                          ? "I'll ask a few setup questions and remember your answers."
                          : readinessMessage;
                      return hint ? (
                        <p className="mt-3 text-sm leading-6 text-muted-foreground">
                          {hint}
                        </p>
                      ) : null;
                    })()}
                  </div>
                  <form onSubmit={onSubmit} className="w-full">
                    <div className="space-y-3">
                    <QueuedSessionInputRail
                      items={displayedQueuedSessionInputs}
                      onEditItem={
                        isReadOnlyInspectionSession
                          ? undefined
                          : updateQueuedSessionInputText
                      }
                    >
                        <Composer
                          input={input}
                          quotedSkills={quotedSkills}
                          slashCommands={slashCommandOptions}
                          attachments={pendingAttachmentItems}
                          isResponding={isResponding}
                          pausePending={isPausePending}
                          pauseDisabled={isSubmittingMessage}
                          disabled={composerDisabled}
                          disabledReason={composerDisabledReason}
                          selectedModel={effectiveChatModelPreference}
                          resolvedModelLabel={
                            resolvedChatModel || modelSelectionUnavailableReason
                          }
                          runtimeDefaultModelLabel={runtimeDefaultModel}
                          modelOptions={availableChatModelOptions}
                          modelOptionGroups={availableChatModelOptionGroups}
                          runtimeDefaultModelAvailable={
                            runtimeDefaultModelAvailable
                          }
                          selectedThinkingValue={effectiveThinkingValue}
                          thinkingValues={selectedThinkingValues}
                          showThinkingValueSelector={showThinkingValueSelector}
                          modelSelectionUnavailableReason={
                            modelSelectionUnavailableReason
                          }
                          submitDisabled={Boolean(
                            pendingImageInputUnsupportedMessage,
                          )}
                          placeholder={textareaPlaceholder}
                          showModelSelector={!isOnboardingVariant}
                          onModelChange={setChatModelPreference}
                          onThinkingValueChange={setSelectedThinkingValue}
                          onOpenModelProviders={() =>
                            void window.electronAPI.ui.openSettingsPane(
                              "providers",
                            )
                          }
                          textareaRef={textareaRef}
                          fileInputRef={fileInputRef}
                          onChange={setInput}
                          onKeyDown={onComposerKeyDown}
                          onCompositionStart={onComposerCompositionStart}
                          onCompositionEnd={onComposerCompositionEnd}
                          onAttachmentInputChange={onAttachmentInputChange}
                          onPause={pauseCurrentRun}
                          onAddDroppedFiles={appendPendingLocalFiles}
                          onAddExplorerAttachments={
                            appendPendingExplorerAttachments
                          }
                          onSelectSlashCommand={(command) => {
                            if (command.kind === "skill") {
                              addQuotedSkill(command.skillId);
                            }
                          }}
                          onRemoveQuotedSkill={removeQuotedSkill}
                          onRemoveAttachment={removePendingAttachment}
                          onPreviewAttachment={openImageAttachmentPreview}
                        />
                      </QueuedSessionInputRail>
                    </div>
                  </form>
                </div>
              )}
            </div>

            {hasMessages && isAwayFromChatBottom ? (
              <button
                aria-label="Jump to latest message"
                className="absolute bottom-3 left-1/2 z-30 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-foreground shadow-subtle-sm transition-colors hover:bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
                onClick={() => {
                  const container = messagesRef.current;
                  if (!container) return;
                  shouldAutoScrollRef.current = true;
                  container.scrollTo({
                    top: container.scrollHeight,
                    behavior: "smooth",
                  });
                }}
                type="button"
              >
                <ChevronDown className="size-4" />
              </button>
            ) : null}
          </div>

          {hasMessages ? (
            <div
              ref={composerBlockRef}
              className={`mx-auto w-full shrink-0 ${CHAT_LAYOUT.contentMaxWidth} ${CHAT_LAYOUT.contentPaddingX} pb-6 pt-3 ${
                showHistoryRestoreScreen ? "invisible" : ""
              }`}
            >
              <form onSubmit={onSubmit} className="w-full">
                <div className="space-y-3">
                  <QueuedSessionInputRail
                    items={displayedQueuedSessionInputs}
                    onEditItem={
                      isReadOnlyInspectionSession
                        ? undefined
                        : updateQueuedSessionInputText
                    }
                  >
                    <Composer
                      input={input}
                      quotedSkills={quotedSkills}
                      slashCommands={slashCommandOptions}
                      attachments={pendingAttachmentItems}
                      isResponding={isResponding}
                      pausePending={isPausePending}
                      pauseDisabled={isSubmittingMessage}
                      disabled={composerDisabled}
                      disabledReason={composerDisabledReason}
                      selectedModel={effectiveChatModelPreference}
                      resolvedModelLabel={
                        resolvedChatModel || modelSelectionUnavailableReason
                      }
                      runtimeDefaultModelLabel={runtimeDefaultModel}
                      modelOptions={availableChatModelOptions}
                      modelOptionGroups={availableChatModelOptionGroups}
                      runtimeDefaultModelAvailable={
                        runtimeDefaultModelAvailable
                      }
                      selectedThinkingValue={effectiveThinkingValue}
                      thinkingValues={selectedThinkingValues}
                      showThinkingValueSelector={showThinkingValueSelector}
                      modelSelectionUnavailableReason={
                        modelSelectionUnavailableReason
                      }
                      submitDisabled={Boolean(
                        pendingImageInputUnsupportedMessage,
                      )}
                      placeholder={textareaPlaceholder}
                      showModelSelector={!isOnboardingVariant}
                      onModelChange={setChatModelPreference}
                      onThinkingValueChange={setSelectedThinkingValue}
                      onOpenModelProviders={() =>
                        void window.electronAPI.ui.openSettingsPane("providers")
                      }
                      textareaRef={textareaRef}
                      fileInputRef={fileInputRef}
                      onChange={setInput}
                      onKeyDown={onComposerKeyDown}
                      onCompositionStart={onComposerCompositionStart}
                      onCompositionEnd={onComposerCompositionEnd}
                      onAttachmentInputChange={onAttachmentInputChange}
                      onPause={pauseCurrentRun}
                      onAddDroppedFiles={appendPendingLocalFiles}
                      onAddExplorerAttachments={
                        appendPendingExplorerAttachments
                      }
                      onSelectSlashCommand={(command) => {
                        if (command.kind === "skill") {
                          addQuotedSkill(command.skillId);
                        }
                      }}
                      onRemoveQuotedSkill={removeQuotedSkill}
                      onRemoveAttachment={removePendingAttachment}
                      onPreviewAttachment={openImageAttachmentPreview}
                    />
                  </QueuedSessionInputRail>
                </div>
              </form>
            </div>
          ) : null}

          {showHistoryRestoreScreen ? <HistoryRestoreSkeleton /> : null}

          <ArtifactBrowserModal
            open={artifactBrowserOpen}
            filter={artifactBrowserFilter}
            outputs={artifactBrowserScopedOutputs ?? sessionOutputs}
            scope={artifactBrowserScope}
            onClose={() => {
              setArtifactBrowserOpen(false);
              setArtifactBrowserScopedOutputs(null);
              setArtifactBrowserScope("session");
            }}
            onFilterChange={setArtifactBrowserFilter}
            onOpenOutput={onOpenOutput}
          />
          <ImageAttachmentPreviewModal
            open={Boolean(imageAttachmentPreview)}
            preview={imageAttachmentPreview}
            onClose={closeImageAttachmentPreview}
          />
        </div>
      </div>
    </PaneCard>
  );
}

interface ChatHeaderProps {
  title: string;
  detail: string;
  onReturnToMainSession?: () => void;
  onOpenSessions?: () => void;
  onOpenInbox?: () => void;
  inboxUnreadCount: number;
  onOpenAutomations?: () => void;
}

function ChatHeader({
  title,
  detail,
  onReturnToMainSession,
  onOpenSessions,
  onOpenInbox,
  inboxUnreadCount,
  onOpenAutomations,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {title}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {detail}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {onReturnToMainSession ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onReturnToMainSession()}
            aria-label="Return to main session"
            className="h-7 rounded-full px-2.5 text-[11px]"
          >
            <ArrowLeft className="mr-1 size-3.5" />
            Main
          </Button>
        ) : null}

        {onOpenSessions ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenSessions()}
                  aria-label="Show sessions"
                  className="rounded-lg text-muted-foreground hover:text-foreground"
                />
              }
            >
              <Bot className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="py-1">
              Sessions
            </TooltipContent>
          </Tooltip>
        ) : null}

        {onOpenInbox ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenInbox()}
                  aria-label="Show inbox"
                  className="relative rounded-lg text-muted-foreground hover:text-foreground"
                />
              }
            >
              <Inbox className="size-4" />
              {inboxUnreadCount > 0 ? (
                <StatusDot
                  variant="destructive"
                  size="md"
                  className="absolute right-1.5 top-1.5 border border-card"
                />
              ) : null}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="py-1">
              Inbox
            </TooltipContent>
          </Tooltip>
        ) : null}

        {onOpenAutomations ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenAutomations()}
                  aria-label="Show automations"
                  className="rounded-lg text-muted-foreground hover:text-foreground"
                />
              }
            >
              <Clock3 className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="py-1">
              Automations
            </TooltipContent>
          </Tooltip>
        ) : null}

      </div>
    </div>
  );
}

interface ComposerProps {
  input: string;
  quotedSkills: ChatComposerQuotedSkillItem[];
  slashCommands: ChatComposerSlashCommandOption[];
  attachments: AttachmentListItem[];
  isResponding: boolean;
  pausePending: boolean;
  pauseDisabled: boolean;
  disabled: boolean;
  disabledReason?: string;
  selectedModel: string;
  resolvedModelLabel: string;
  runtimeDefaultModelLabel: string;
  modelOptions: ChatModelOption[];
  modelOptionGroups: ChatModelOptionGroup[];
  runtimeDefaultModelAvailable: boolean;
  selectedThinkingValue: string | null;
  thinkingValues: string[];
  showThinkingValueSelector: boolean;
  modelSelectionUnavailableReason: string;
  submitDisabled?: boolean;
  placeholder: string;
  showModelSelector: boolean;
  onModelChange: (value: string) => void;
  onThinkingValueChange: (value: string | null) => void;
  onOpenModelProviders: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPause: () => void;
  onAddDroppedFiles: (files: File[]) => void;
  onAddExplorerAttachments: (files: ExplorerAttachmentDragPayload[]) => void;
  onSelectSlashCommand: (command: ChatComposerSlashCommandOption) => void;
  onRemoveQuotedSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewAttachment: (attachment: AttachmentListItem) => void;
}

export const UserTurn = memo(UserTurnComponent, (prev, next) =>
  prev.text === next.text &&
  prev.createdAt === next.createdAt &&
  prev.attachments === next.attachments,
);

function UserTurnComponent({
  text,
  createdAt,
  attachments,
  onPreviewAttachment,
  onLinkClick,
  onLocalLinkClick,
}: {
  text: string;
  createdAt?: string;
  attachments: ChatAttachment[];
  onPreviewAttachment?: (attachment: AttachmentListItem) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
}) {
  const [copyFeedbackVisible, setCopyFeedbackVisible] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const timeLabel = chatMessageTimeLabel(createdAt);
  const canCopy = text.trim().length > 0;
  const showHoverFooter = canCopy || Boolean(timeLabel);
  const parsedQuotedSkills = useMemo(
    () => parseSerializedQuotedSkillPrompt(text),
    [text],
  );
  const userBubbleText = parsedQuotedSkills.body || text.trim();

  const bubbleContentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showExpandButton, setShowExpandButton] = useState(false);

  useEffect(() => {
    const node = bubbleContentRef.current;
    if (!node) {
      return;
    }
    // 180px ~= 6–7 lines of chat-user-markdown at 0.875rem / 1.6 leading.
    setShowExpandButton(node.scrollHeight > 188);
  }, [userBubbleText]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (!canCopy) {
      return;
    }

    try {
      await copyTextToClipboard(text);
    } catch {
      return;
    }
    setCopyFeedbackVisible(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyFeedbackVisible(false);
      copyResetTimerRef.current = null;
    }, 1600);
  };

  return (
    <div className="group/user-turn flex min-w-0 justify-end">
      <div
        className={`relative z-0 flex min-w-0 max-w-[80%] flex-col items-end gap-2 group-hover/user-turn:z-10 group-focus-within/user-turn:z-10 ${showHoverFooter ? "pb-7" : ""}`.trim()}
      >
        {parsedQuotedSkills.skillIds.length > 0 ? (
          <div className="flex max-w-full flex-wrap justify-end gap-2">
            {parsedQuotedSkills.skillIds.map((skillId) => (
              <div
                key={skillId}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/8 px-3 py-1 text-xs font-medium text-foreground"
              >
                <Sparkles className="size-3 text-primary" />
                <span className="truncate">/{skillId}</span>
              </div>
            ))}
          </div>
        ) : null}
        {userBubbleText ? (
          <div className="theme-chat-user-bubble inline-flex min-w-0 max-w-full flex-col items-stretch rounded-lg px-3 py-1.5 text-foreground">
            <div
              ref={bubbleContentRef}
              className="relative overflow-hidden transition-[max-height] duration-300 ease-out"
              style={{
                maxHeight: showExpandButton && !isExpanded ? 180 : undefined,
              }}
            >
              <SimpleMarkdown
                className="chat-markdown chat-user-markdown max-w-full"
                onLinkClick={onLinkClick}
                onLocalLinkClick={onLocalLinkClick}
              >
                {userBubbleText}
              </SimpleMarkdown>
              {showExpandButton && !isExpanded ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10"
                  style={{
                    background:
                      "linear-gradient(to bottom, transparent, color-mix(in oklch, var(--muted) 85%, var(--foreground) 4%))",
                  }}
                />
              ) : null}
            </div>
            {showExpandButton ? (
              <button
                type="button"
                onClick={() => setIsExpanded((value) => !value)}
                className="mt-1.5 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {isExpanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <AttachmentList
            attachments={attachments}
            className="justify-end"
            onPreview={onPreviewAttachment}
          />
        ) : null}
        {showHoverFooter ? (
          <div className="absolute bottom-0 right-1 flex w-max min-w-max max-w-none items-center gap-2 whitespace-nowrap text-xs text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-150 group-hover/user-turn:opacity-100 group-hover/user-turn:pointer-events-auto group-focus-within/user-turn:opacity-100 group-focus-within/user-turn:pointer-events-auto">
            {canCopy ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={
                  copyFeedbackVisible
                    ? "Copied user message"
                    : "Copy user message"
                }
                onClick={() => {
                  void handleCopy();
                }}
                className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
              >
                {copyFeedbackVisible ? (
                  <Check className="size-3.5" strokeWidth={1.9} />
                ) : (
                  <Copy className="size-3.5" strokeWidth={1.9} />
                )}
              </Button>
            ) : null}
            {timeLabel ? (
              <span className="select-none whitespace-nowrap tabular-nums">
                {timeLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function queuedSessionInputPreviewText(item: QueuedSessionInput) {
  const parsedQuotedSkills = parseSerializedQuotedSkillPrompt(item.text);
  const previewText =
    parsedQuotedSkills.body ||
    parsedQuotedSkills.skillIds.map((skillId) => `/${skillId}`).join(" ");
  return previewText.replace(/\s+/g, " ").trim();
}

function QueuedSessionInputRail({
  items,
  onEditItem,
  children,
}: {
  items: QueuedSessionInput[];
  onEditItem?: (item: QueuedSessionInput, nextText: string) => Promise<void>;
  children: ReactNode;
}) {
  const [editingInputId, setEditingInputId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [editingError, setEditingError] = useState("");
  const [savingInputId, setSavingInputId] = useState("");
  const panelInsetPx = 18;
  const panelHeightPx = 112;
  const overlapPx = 28;
  const queueViewportHeightPx = 50;
  const reservedTopPx = 94;

  useEffect(() => {
    if (!editingInputId) {
      return;
    }
    const activeItem = items.find((item) => item.inputId === editingInputId);
    if (!activeItem || activeItem.status !== "queued") {
      setEditingInputId("");
      setEditingDraft("");
      setEditingError("");
      setSavingInputId("");
    }
  }, [editingInputId, items]);

  const cancelEditing = () => {
    setEditingInputId("");
    setEditingDraft("");
    setEditingError("");
    setSavingInputId("");
  };

  const saveEditingItem = async (item: QueuedSessionInput) => {
    if (!onEditItem || savingInputId || item.status !== "queued") {
      return;
    }
    setEditingError("");
    setSavingInputId(item.inputId);
    try {
      await onEditItem(item, editingDraft);
      cancelEditing();
    } catch (error) {
      setEditingError(normalizeErrorMessage(error));
    } finally {
      setSavingInputId("");
    }
  };

  if (items.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="relative" style={{ paddingTop: `${reservedTopPx}px` }}>
      <div className="pointer-events-none absolute inset-x-0 top-0">
        <div
          className="pointer-events-auto absolute inset-x-0 overflow-hidden rounded-3xl bg-background shadow-md"
          style={{
            left: `${panelInsetPx}px`,
            right: `${panelInsetPx}px`,
            height: `${panelHeightPx}px`,
          }}
        >
          <div className="px-4 pt-4">
            <div
              className="overflow-y-auto pr-1.5"
              style={{ maxHeight: `${queueViewportHeightPx}px` }}
            >
              <div className="space-y-1.5">
                {items.map((item) => {
                  const previewText = queuedSessionInputPreviewText(item);
                  const isEditing = editingInputId === item.inputId;
                  const isSaving = savingInputId === item.inputId;
                  return (
                    <div
                      key={item.inputId}
                      className="rounded-xl px-1 text-sm leading-7 text-foreground"
                    >
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                            <Input
                              value={editingDraft}
                              onChange={(event) =>
                                setEditingDraft(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void saveEditingItem(item);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelEditing();
                                }
                              }}
                              disabled={isSaving}
                              autoFocus
                              className="h-8 min-w-0 flex-1 rounded-lg border-border bg-background px-2.5 text-sm"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isSaving}
                              onClick={() => {
                                void saveEditingItem(item);
                              }}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Save queued message edit"
                            >
                              {isSaving ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isSaving}
                              onClick={cancelEditing}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Cancel queued message edit"
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                          {editingError ? (
                            <div className="pl-6 text-xs leading-5 text-destructive">
                              {editingError}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1 truncate">
                            {previewText || "Queued message"}
                          </div>
                          {onEditItem && item.status === "queued" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => {
                                setEditingInputId(item.inputId);
                                setEditingDraft(previewText);
                                setEditingError("");
                              }}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Edit queued message"
                            >
                              <PencilLine className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className="relative z-10 rounded-3xl bg-background"
        style={{ marginTop: `${-overlapPx}px` }}
      >
        {children}
      </div>
    </div>
  );
}

function executionItemsHaveFileEdits(
  items: ChatExecutionTimelineItem[],
): boolean {
  if (items.length === 0) {
    return false;
  }
  return items.some((item) => {
    if (item.kind !== "trace_step" || item.step.kind !== "tool") {
      return false;
    }
    const title = item.step.title.toLowerCase();
    return (
      title.startsWith("edit") ||
      title.startsWith("write") ||
      title.startsWith("patch") ||
      title.startsWith("replace") ||
      title.startsWith("multiedit") ||
      title.startsWith("apply") ||
      title.startsWith("create file")
    );
  });
}

interface AssistantTurnActionsMenuProps {
  copyText: string;
  onViewTurnDetails?: () => void;
  onViewFileChanges?: () => void;
  hasFileEdits?: boolean;
}

function AssistantTurnActionsMenu({
  copyText,
  onViewTurnDetails,
  onViewFileChanges,
  hasFileEdits,
}: AssistantTurnActionsMenuProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!copyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  const showFileChanges = Boolean(onViewFileChanges) && Boolean(hasFileEdits);
  const canCopy = copyText.trim().length > 0;

  if (!canCopy && !onViewTurnDetails && !showFileChanges) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Turn actions"
            className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="size-3.5" strokeWidth={1.9} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-44" sideOffset={4}>
        {canCopy ? (
          <DropdownMenuItem onClick={() => void handleCopy()}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy message"}
          </DropdownMenuItem>
        ) : null}
        {onViewTurnDetails ? (
          <DropdownMenuItem onClick={onViewTurnDetails}>
            <ListTree />
            View turn details
          </DropdownMenuItem>
        ) : null}
        {showFileChanges ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onViewFileChanges}>
              <FileCode2 />
              View file changes
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const AssistantTurn = memo(AssistantTurnComponent, (prev, next) =>
  prev.label === next.label &&
  prev.mode === next.mode &&
  prev.showExecutionInternals === next.showExecutionInternals &&
  prev.text === next.text &&
  prev.tone === next.tone &&
  prev.segments === next.segments &&
  prev.executionItems === next.executionItems &&
  prev.memoryProposals === next.memoryProposals &&
  prev.outputs === next.outputs &&
  prev.memoryProposalAction === next.memoryProposalAction &&
  prev.editingMemoryProposalId === next.editingMemoryProposalId &&
  prev.memoryProposalDrafts === next.memoryProposalDrafts &&
  prev.collapsedTraceByStepId === next.collapsedTraceByStepId &&
  prev.live === next.live &&
  prev.status === next.status &&
  prev.statusAccessory === next.statusAccessory &&
  prev.footerAccessory === next.footerAccessory,
);

function AssistantTurnComponent({
  label,
  mode,
  showExecutionInternals = true,
  fitToContent = false,
  text,
  tone = "default",
  segments,
  executionItems,
  memoryProposals,
  outputs,
  memoryProposalAction,
  editingMemoryProposalId,
  memoryProposalDrafts,
  onEditMemoryProposal,
  onMemoryProposalDraftChange,
  onAcceptMemoryProposal,
  onDismissMemoryProposal,
  onOpenOutput,
  onOpenAllArtifacts,
  collapsedTraceByStepId,
  onToggleTraceStep,
  onLinkClick,
  onLocalLinkClick,
  status = "",
  live = false,
  statusAccessory = null,
  footerAccessory = null,
}: {
  label: string;
  mode: string;
  showExecutionInternals?: boolean;
  fitToContent?: boolean;
  text: string;
  tone?: ChatMessage["tone"];
  segments: ChatAssistantSegment[];
  executionItems: ChatExecutionTimelineItem[];
  memoryProposals: MemoryUpdateProposalRecordPayload[];
  outputs: WorkspaceOutputRecordPayload[];
  memoryProposalAction: {
    proposalId: string;
    action: "accept" | "dismiss";
  } | null;
  editingMemoryProposalId: string | null;
  memoryProposalDrafts: Record<string, string>;
  onEditMemoryProposal: (proposalId: string) => void;
  onMemoryProposalDraftChange: (proposalId: string, value: string) => void;
  onAcceptMemoryProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
  onDismissMemoryProposal: (
    proposal: MemoryUpdateProposalRecordPayload,
  ) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  status?: string;
  live?: boolean;
  statusAccessory?: ReactNode;
  footerAccessory?: ReactNode;
}) {
  const normalizedStatus = (
    showExecutionInternals ? status : status ? "Working" : ""
  )
    .replace(/\.+$/, "")
    .trim();
  const visibleSegments = showExecutionInternals
    ? segments
    : segments.filter(
        (segment): segment is Extract<ChatAssistantSegment, { kind: "output" }> =>
          segment.kind === "output",
      );
  const visibleExecutionItems = showExecutionInternals ? executionItems : [];
  const renderedSegments =
    visibleSegments.length > 0
      ? visibleSegments
      : visibleExecutionItems.length > 0 || Boolean(text)
        ? [
            ...(visibleExecutionItems.length > 0
              ? ([
                  {
                    kind: "execution",
                    items: visibleExecutionItems,
                  },
                ] as ChatAssistantSegment[])
              : []),
            ...(text
              ? ([
                  {
                    kind: "output",
                    text,
                    tone,
                  },
                ] as ChatAssistantSegment[])
              : []),
          ]
        : [];
  const showStatusPlaceholder =
    live && Boolean(normalizedStatus) && renderedSegments.length === 0;
  const lastSegmentIsOutput =
    renderedSegments.length > 0 &&
    renderedSegments[renderedSegments.length - 1]?.kind === "output";
  const showWorkingStatusLine =
    live &&
    showExecutionInternals &&
    renderedSegments.length > 0 &&
    !lastSegmentIsOutput;
  const showStreamingCursor = live && lastSegmentIsOutput;

  const [forceExpandToken, setForceExpandToken] = useState(0);
  const hasFileEdits = useMemo(
    () => executionItemsHaveFileEdits(executionItems),
    [executionItems],
  );
  const copyText = useMemo(
    () =>
      renderedSegments
        .filter(
          (segment): segment is Extract<ChatAssistantSegment, { kind: "output" }> =>
            segment.kind === "output",
        )
        .map((segment) => segment.text)
        .join("\n\n")
        .trim() || text.trim(),
    [renderedSegments, text],
  );
  const hasAnyContent = renderedSegments.length > 0;
  const showActionsMenu = hasAnyContent && !live;
  const renderStatusLine = (nextLabel: string, className = "") => {
    const resolvedLabel = nextLabel.trim() || "Working";
    if (!statusAccessory) {
      return <LiveStatusLine label={resolvedLabel} className={className} />;
    }
    return (
      <div
        className={`flex min-w-0 items-center justify-between gap-3 ${className}`.trim()}
      >
        <LiveStatusLine label={resolvedLabel} className="min-w-0" />
        <div className="shrink-0">{statusAccessory}</div>
      </div>
    );
  };

  return (
    <div
      className="group/assistant-turn relative flex min-w-0 justify-start"
    >
      <article
        className={
          fitToContent
            ? "min-w-0 inline-flex w-fit max-w-full flex-col rounded-lg bg-muted/60 px-3 py-2"
            : "min-w-0 w-full max-w-4xl rounded-lg bg-muted/60 px-3 py-2"
        }
      >
        {showStatusPlaceholder ? renderStatusLine(normalizedStatus) : null}

        {renderedSegments.map((segment, index) =>
          segment.kind === "execution" ? (
            <TraceStepGroup
              key={`execution-${index}`}
              items={segment.items}
              collapsedByStepId={collapsedTraceByStepId}
              onToggleStep={onToggleTraceStep}
              live={live}
              liveOutputStarted={
                live &&
                renderedSegments
                  .slice(index + 1)
                  .some((nextSegment) => nextSegment.kind === "output")
              }
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
              forceExpandToken={forceExpandToken}
            />
          ) : segment.tone === "error" ? (
            <div
              key={`output-${index}`}
              className="theme-chat-system-bubble mt-2 first:mt-0 rounded-xl border px-3 py-2.5 text-xs text-foreground"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                <SimpleMarkdown
                  className="chat-markdown max-w-full text-foreground"
                  onLinkClick={onLinkClick}
                  onLocalLinkClick={onLocalLinkClick}
                >
                  {segment.text}
                </SimpleMarkdown>
              </div>
            </div>
          ) : (
            <SimpleMarkdown
              key={`output-${index}`}
              className="chat-markdown chat-assistant-markdown mt-2 first:mt-0 max-w-full text-foreground"
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
            >
              {segment.text}
            </SimpleMarkdown>
          ),
        )}

        {showWorkingStatusLine
          ? renderStatusLine(
              "Working",
              renderedSegments.some((segment) => segment.kind === "execution")
                ? ""
                : "",
            )
          : null}

        {showStreamingCursor ? <StreamingCursor /> : null}

        {footerAccessory ? (
          <div className="mt-2 flex justify-start">{footerAccessory}</div>
        ) : null}

        {memoryProposals.length > 0 ? (
          <AssistantTurnMemoryProposals
            proposals={memoryProposals}
            proposalAction={memoryProposalAction}
            editingProposalId={editingMemoryProposalId}
            drafts={memoryProposalDrafts}
            onEditProposal={onEditMemoryProposal}
            onDraftChange={onMemoryProposalDraftChange}
            onAcceptProposal={onAcceptMemoryProposal}
            onDismissProposal={onDismissMemoryProposal}
          />
        ) : null}

        {outputs.length > 0 ? (
          <AssistantTurnOutputs
            outputs={outputs}
            onOpenOutput={onOpenOutput}
            onOpenAllArtifacts={onOpenAllArtifacts}
          />
        ) : null}
      </article>

      {showActionsMenu ? (
        <div className="pointer-events-none absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-150 group-hover/assistant-turn:pointer-events-auto group-hover/assistant-turn:opacity-100 group-focus-within/assistant-turn:pointer-events-auto group-focus-within/assistant-turn:opacity-100">
          <AssistantTurnActionsMenu
            copyText={copyText}
            hasFileEdits={hasFileEdits}
            onViewFileChanges={
              hasFileEdits
                ? () => setForceExpandToken((token) => token + 1)
                : undefined
            }
            onViewTurnDetails={
              executionItems.length > 0
                ? () => setForceExpandToken((token) => token + 1)
                : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}

type OutputVisualKind =
  | "spreadsheet"
  | "document"
  | "pdf"
  | "code"
  | "image"
  | "link"
  | "app"
  | "dashboard"
  | "file";

const DASHBOARD_EXTENSIONS = new Set(["dashboard"]);

const SPREADSHEET_EXTENSIONS = new Set([
  "xlsx",
  "xls",
  "xlsm",
  "xlsb",
  "ods",
  "csv",
  "tsv",
]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "php",
  "swift",
  "kt",
  "sh",
  "json",
  "yml",
  "yaml",
  "toml",
  "xml",
  "sql",
  "css",
  "scss",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "doc",
  "docx",
  "rtf",
  "odt",
  "html",
  "htm",
]);

function outputFileExtension(output: WorkspaceOutputRecordPayload): string {
  const metadataExt = outputMetadataString(output, "extension");
  if (metadataExt) {
    return metadataExt.replace(/^\./, "").toLowerCase();
  }
  const fromTitle = output.title?.trim() ?? "";
  const dotIndex = fromTitle.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fromTitle.length - 1) {
    return fromTitle.slice(dotIndex + 1).toLowerCase();
  }
  return "";
}

function outputVisualKind(
  output: WorkspaceOutputRecordPayload,
): OutputVisualKind {
  const filter = outputBrowserFilterForOutput(output);
  if (filter === "apps") {
    return "app";
  }
  if (filter === "images") {
    return "image";
  }
  if (filter === "links") {
    return "link";
  }

  const extension = outputFileExtension(output);
  if (extension) {
    if (DASHBOARD_EXTENSIONS.has(extension)) {
      return "dashboard";
    }
    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      return "spreadsheet";
    }
    if (PDF_EXTENSIONS.has(extension)) {
      return "pdf";
    }
    if (CODE_EXTENSIONS.has(extension)) {
      return "code";
    }
    if (DOCUMENT_EXTENSIONS.has(extension)) {
      return "document";
    }
  }

  if (filter === "code") {
    return "code";
  }
  const category = outputMetadataString(output, "category");
  if (category === "spreadsheet") {
    return "spreadsheet";
  }
  if (category === "document") {
    return "document";
  }
  return "file";
}

function outputVisualTheme(kind: OutputVisualKind): {
  Icon: typeof FileText;
  tileClass: string;
  iconClass: string;
} {
  switch (kind) {
    case "spreadsheet":
      return {
        Icon: FileSpreadsheet,
        tileClass: "bg-success/12 ring-1 ring-inset ring-success/20",
        iconClass: "text-success",
      };
    case "pdf":
      return {
        Icon: FileType,
        tileClass: "bg-destructive/12 ring-1 ring-inset ring-destructive/20",
        iconClass: "text-destructive",
      };
    case "document":
      return {
        Icon: FileText,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "code":
      return {
        Icon: FileCode2,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "image":
      return {
        Icon: ImageIcon,
        tileClass: "bg-warning/12 ring-1 ring-inset ring-warning/20",
        iconClass: "text-warning",
      };
    case "link":
      return {
        Icon: Link2,
        tileClass: "bg-info/12 ring-1 ring-inset ring-info/20",
        iconClass: "text-info",
      };
    case "app":
      return {
        Icon: Waypoints,
        tileClass: "bg-primary/12 ring-1 ring-inset ring-primary/20",
        iconClass: "text-primary",
      };
    case "dashboard":
      return {
        Icon: LayoutDashboard,
        tileClass: "bg-primary/12 ring-1 ring-inset ring-primary/20",
        iconClass: "text-primary",
      };
    default:
      return {
        Icon: FileIcon,
        tileClass: "bg-muted ring-1 ring-inset ring-border",
        iconClass: "text-muted-foreground",
      };
  }
}

function OutputArtifactIcon({
  output,
  size = "md",
}: {
  output: WorkspaceOutputRecordPayload;
  size?: "sm" | "md";
}) {
  const kind = outputVisualKind(output);
  const { Icon, tileClass, iconClass } = outputVisualTheme(kind);
  const tileSize = size === "sm" ? "size-7" : "size-9";
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <div
      className={`grid ${tileSize} shrink-0 place-items-center rounded-lg ${tileClass}`}
    >
      <Icon size={iconSize} className={iconClass} />
    </div>
  );
}

function HistoryRestoreSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="absolute inset-0 z-30 overflow-hidden px-6 pb-5 pt-5"
    >
      <div className="flex h-full flex-col">
        <div className="animate-pulse space-y-6">
          <div className="flex items-start justify-between gap-6">
            <div className="h-5 w-28 rounded-md bg-muted" />
            <div className="h-11 w-52 rounded-2xl bg-muted" />
          </div>
          <div className="space-y-3 px-3">
            <div className="flex items-center gap-2">
              <div className="h-5 w-6 rounded-md bg-muted" />
              <div className="h-5 w-14 rounded-md bg-muted" />
            </div>
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-[42%] rounded-md bg-muted" />
          </div>
        </div>

        <div className="mt-auto">
          <div className="rounded-2xl border border-border bg-muted p-4">
            <div className="animate-pulse space-y-3">
              <div className="h-6 w-full rounded-lg bg-muted" />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantTurnOutputs({
  outputs,
  onOpenOutput,
  onOpenAllArtifacts,
}: {
  outputs: WorkspaceOutputRecordPayload[];
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
}) {
  const displayOutputs =
    outputs.length > 1 ? dedupeOutputsForDisplay(outputs) : outputs;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {displayOutputs.map((output) => (
        <button
          key={output.id}
          type="button"
          onClick={() => onOpenOutput?.(output)}
          className="group flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/50 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-card"
          disabled={!onOpenOutput}
        >
          <OutputArtifactIcon output={output} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {output.title || "Untitled artifact"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {outputSecondaryLabel(output)}
            </div>
          </div>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
        </button>
      ))}

      {displayOutputs.length > 1 ? (
        <button
          type="button"
          onClick={() => onOpenAllArtifacts(displayOutputs)}
          className="flex max-w-[380px] items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-left text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
        >
          <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Folder className="size-3.5" />
          </div>
          <span className="text-xs">
            View artifacts in this reply ({displayOutputs.length})
          </span>
        </button>
      ) : null}
    </div>
  );
}

function memoryProposalStateLabel(state: MemoryUpdateProposalState) {
  switch (state) {
    case "accepted":
      return "Saved";
    case "dismissed":
      return "Dismissed";
    default:
      return "Review";
  }
}

function AssistantTurnMemoryProposals({
  proposals,
  proposalAction,
  editingProposalId,
  drafts,
  onEditProposal,
  onDraftChange,
  onAcceptProposal,
  onDismissProposal,
}: {
  proposals: MemoryUpdateProposalRecordPayload[];
  proposalAction: { proposalId: string; action: "accept" | "dismiss" } | null;
  editingProposalId: string | null;
  drafts: Record<string, string>;
  onEditProposal: (proposalId: string) => void;
  onDraftChange: (proposalId: string, value: string) => void;
  onAcceptProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
  onDismissProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
}) {
  return (
    <div className="mt-4 grid gap-3">
      {proposals.map((proposal) => {
        const isPending = proposal.state === "pending";
        const isEditing = editingProposalId === proposal.proposal_id;
        const isActing = proposalAction?.proposalId === proposal.proposal_id;
        const draftValue = drafts[proposal.proposal_id] ?? proposal.summary;

        return (
          <article
            key={proposal.proposal_id}
            className="bg-card rounded-2xl border border-border px-4 py-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Lightbulb className="size-4 shrink-0 text-primary" />
                  <span>{proposal.title}</span>
                </div>
                {isEditing ? (
                  <textarea
                    value={draftValue}
                    onChange={(event) =>
                      onDraftChange(proposal.proposal_id, event.target.value)
                    }
                    className="bg-muted mt-3 min-h-[86px] w-full rounded-xl border border-border px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary"
                  />
                ) : (
                  <div className="mt-3 text-sm leading-6 text-muted-foreground">
                    {proposal.summary}
                  </div>
                )}
                {proposal.evidence ? (
                  <div className="mt-3 text-xs leading-5 text-muted-foreground">
                    {proposal.evidence}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-start gap-2">
                <Badge variant="outline" className="uppercase">
                  {memoryProposalStateLabel(proposal.state)}
                </Badge>
                {isPending ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => onEditProposal(proposal.proposal_id)}
                    className="rounded-xl"
                    aria-label="Edit memory proposal"
                  >
                    <PencilLine className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>

            {isPending ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => onDismissProposal(proposal)}
                  disabled={isActing}
                  className="rounded-2xl"
                >
                  {isActing && proposalAction?.action === "dismiss" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <X className="size-3" />
                  )}
                  <span>Dismiss</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => onAcceptProposal(proposal)}
                  disabled={isActing}
                  className="rounded-2xl border-primary bg-primary/10 text-primary hover:bg-primary/14"
                >
                  {isActing && proposalAction?.action === "accept" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  <span>Accept</span>
                </Button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function ConversationTurns<Message extends ChatMessage>({
  messages,
  assistantLabel,
  assistantMode,
  showExecutionInternals,
  assistantFitToContent = false,
  onPreviewAttachment,
  onOpenOutput,
  onOpenAllArtifacts,
  collapsedTraceByStepId,
  onToggleTraceStep,
  onLinkClick,
  onLocalLinkClick,
  memoryProposalAction,
  editingMemoryProposalId,
  memoryProposalDrafts,
  onEditMemoryProposal,
  onMemoryProposalDraftChange,
  onAcceptMemoryProposal,
  onDismissMemoryProposal,
  assistantFooterAccessoryMessageId = null,
  assistantFooterAccessory = null,
  getMessageWrapperClassName,
  liveAssistantTurn = null,
}: {
  messages: Message[];
  assistantLabel: string;
  assistantMode: string;
  showExecutionInternals: boolean;
  assistantFitToContent?: boolean;
  onPreviewAttachment?: (attachment: AttachmentListItem) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  memoryProposalAction: {
    proposalId: string;
    action: "accept" | "dismiss";
  } | null;
  editingMemoryProposalId: string | null;
  memoryProposalDrafts: Record<string, string>;
  onEditMemoryProposal: (message: Message, proposalId: string) => void;
  onMemoryProposalDraftChange: (proposalId: string, value: string) => void;
  onAcceptMemoryProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
  onDismissMemoryProposal: (
    proposal: MemoryUpdateProposalRecordPayload,
  ) => void;
  assistantFooterAccessoryMessageId?: string | null;
  assistantFooterAccessory?: ReactNode;
  getMessageWrapperClassName?: (message: Message) => string | undefined;
  liveAssistantTurn?: {
    text: string;
    tone?: ChatMessage["tone"];
    segments: ChatAssistantSegment[];
    executionItems: ChatExecutionTimelineItem[];
    status?: string;
    statusAccessory?: ReactNode;
    footerAccessory?: ReactNode;
  } | null;
}) {
  return (
    <>
      {messages.map((message, index) => {
        const wrapperClassName = getMessageWrapperClassName?.(message)?.trim();
        const turn =
          message.role === "user" ? (
            <UserTurn
              text={message.text}
              createdAt={message.createdAt}
              attachments={message.attachments ?? []}
              onPreviewAttachment={onPreviewAttachment}
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
            />
          ) : (
            <AssistantTurn
              label={assistantLabel}
              mode={assistantMode}
              showExecutionInternals={showExecutionInternals}
              fitToContent={assistantFitToContent}
              text={message.text}
              tone={message.tone ?? "default"}
              segments={message.segments ?? []}
              executionItems={message.executionItems ?? []}
              memoryProposals={message.memoryProposals ?? []}
              outputs={message.outputs ?? []}
              memoryProposalAction={memoryProposalAction}
              editingMemoryProposalId={editingMemoryProposalId}
              memoryProposalDrafts={memoryProposalDrafts}
              onEditMemoryProposal={(proposalId) =>
                onEditMemoryProposal(message, proposalId)
              }
              onMemoryProposalDraftChange={onMemoryProposalDraftChange}
              onAcceptMemoryProposal={onAcceptMemoryProposal}
              onDismissMemoryProposal={onDismissMemoryProposal}
              onOpenOutput={onOpenOutput}
              onOpenAllArtifacts={onOpenAllArtifacts}
              collapsedTraceByStepId={collapsedTraceByStepId}
              onToggleTraceStep={onToggleTraceStep}
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
              footerAccessory={
                message.id === assistantFooterAccessoryMessageId
                  ? assistantFooterAccessory
                  : null
              }
            />
          );

        if (wrapperClassName) {
          return (
            <div key={message.id} className={wrapperClassName}>
              {turn}
            </div>
          );
        }
        return <Fragment key={message.id}>{turn}</Fragment>;
      })}

      {liveAssistantTurn ? (
        <AssistantTurn
          label={assistantLabel}
          mode={assistantMode}
          showExecutionInternals={showExecutionInternals}
          fitToContent={assistantFitToContent}
          text={liveAssistantTurn.text}
          tone={liveAssistantTurn.tone ?? "default"}
          segments={liveAssistantTurn.segments}
          executionItems={liveAssistantTurn.executionItems}
          memoryProposals={[]}
          outputs={[]}
          memoryProposalAction={memoryProposalAction}
          editingMemoryProposalId={editingMemoryProposalId}
          memoryProposalDrafts={memoryProposalDrafts}
          onEditMemoryProposal={() => undefined}
          onMemoryProposalDraftChange={onMemoryProposalDraftChange}
          onAcceptMemoryProposal={onAcceptMemoryProposal}
          onDismissMemoryProposal={onDismissMemoryProposal}
          onOpenOutput={onOpenOutput}
          onOpenAllArtifacts={onOpenAllArtifacts}
          collapsedTraceByStepId={collapsedTraceByStepId}
          onToggleTraceStep={onToggleTraceStep}
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
          live
          statusAccessory={liveAssistantTurn.statusAccessory ?? null}
          status={liveAssistantTurn.status ?? ""}
          footerAccessory={liveAssistantTurn.footerAccessory ?? null}
        />
      ) : null}
    </>
  );
}

export function ArtifactBrowserModal({
  open,
  filter,
  outputs,
  scope,
  onClose,
  onFilterChange,
  onOpenOutput,
  layout = "page",
}: {
  open: boolean;
  filter: ArtifactBrowserFilter;
  outputs: WorkspaceOutputRecordPayload[];
  scope: "session" | "reply";
  onClose: () => void;
  onFilterChange: (nextFilter: ArtifactBrowserFilter) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  layout?: "page" | "card";
}) {
  if (!open) {
    return null;
  }

  const filterLabels: Array<{ id: ArtifactBrowserFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "documents", label: "Documents" },
    { id: "images", label: "Images" },
    { id: "code", label: "Code files" },
    { id: "links", label: "Links" },
    { id: "apps", label: "Apps" },
  ];
  const allDisplayOutputs =
    outputs.length > 1 ? dedupeOutputsForDisplay(outputs) : outputs;
  const filteredOutputs = sortOutputsLatestFirst(
    filter === "all"
      ? allDisplayOutputs
      : allDisplayOutputs.filter(
          (output) => outputBrowserFilterForOutput(output) === filter,
        ),
  );
  const overlayClassName =
    layout === "card"
      ? "absolute inset-0 z-30 flex items-stretch justify-stretch bg-background/88 p-2 backdrop-blur-[2px]"
      : "absolute inset-0 z-30 flex items-center justify-center bg-black/40 px-6 py-8 backdrop-blur-[2px]";
  const panelClassName =
    layout === "card"
      ? "flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl"
      : "flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl";

  return (
    <div
      className={overlayClassName}
      data-control-center-swipe-ignore={layout === "card" ? "true" : undefined}
    >
      <div className={panelClassName}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Artifacts
            </div>
            <div className="text-xs text-muted-foreground">
              {allDisplayOutputs.length} item
              {allDisplayOutputs.length === 1 ? "" : "s"}{" "}
              {scope === "reply"
                ? "attached to this reply"
                : "in this session"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">
          {filterLabels.map((item) => {
            const active = filter === item.id;
            return (
              <Button
                key={item.id}
                variant={active ? "secondary" : "ghost"}
                size="xs"
                onClick={() => onFilterChange(item.id)}
              >
                {item.label}
              </Button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {filteredOutputs.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No artifacts match this filter.
            </div>
          ) : (
            <div className="grid gap-2">
              {filteredOutputs.map((output) => {
                const kindLabel = outputKindLabel(output);
                const changeLabel = outputChangeLabel(output);
                return (
                  <button
                    key={output.id}
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenOutput?.(output);
                    }}
                    disabled={!onOpenOutput}
                    className="group flex w-full min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left ring-border transition-colors hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-card"
                  >
                    <OutputArtifactIcon output={output} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {kindLabel}
                      </div>
                      <div className="truncate text-sm font-medium text-foreground">
                        {output.title || "Untitled artifact"}
                      </div>
                    </div>
                    {changeLabel ? (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] uppercase"
                      >
                        {changeLabel}
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function traceStatusLabel(status: ChatTraceStepStatus) {
  if (status === "completed") {
    return "Completed";
  }
  if (status === "error") {
    return "Error";
  }
  if (status === "waiting") {
    return "Waiting";
  }
  return "In progress";
}

function isTraceStepCollapsed(
  step: ChatTraceStep,
  collapsedTraceByStepId: Record<string, boolean>,
) {
  return collapsedTraceByStepId[step.id] ?? true;
}

function IntegrationErrorBanner({ details }: { details: string[] }) {
  const errorText = details.join(" ");
  const integrationError = isIntegrationError(errorText);
  if (!integrationError) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-1.5 text-xs text-warning">
      <Cable className="size-3 shrink-0" />
      <span>{integrationError.action}</span>
    </div>
  );
}

function LiveStatusEllipsis() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center text-muted-foreground"
    >
      <DotmSquare3 dotSize={1} size={10} />
    </span>
  );
}

function StreamingCursor() {
  return (
    <>
      <style>{`
        @keyframes streaming-cursor-blink {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
      `}</style>
      <span
        aria-hidden="true"
        className="ml-0.5 inline-block h-[1em] w-[2px] -mb-[2px] translate-y-[3px] rounded-[1px] bg-foreground/65"
        style={{ animation: "streaming-cursor-blink 1100ms steps(1) infinite" }}
      />
    </>
  );
}

function LiveStatusLine({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  const normalizedLabel = label.replace(/\.+$/, "").trim();
  if (!normalizedLabel) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      key={normalizedLabel}
      className={`flex w-fit items-center gap-1.5 text-xs leading-none text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 ease-out ${className}`.trim()}
    >
      <LiveStatusEllipsis />
      <span>{normalizedLabel}</span>
    </div>
  );
}

function summarizeThinking(text: string) {
  const firstContentLine =
    text
      .split("\n")
      .map((line) => line.replace(/[*_`#>-]/g, "").trim())
      .find(Boolean) || "Reasoning available";

  return firstContentLine.length > 88
    ? `${firstContentLine.slice(0, 85).trimEnd()}...`
    : firstContentLine;
}

function TraceTimelineStepEntry({
  step,
  collapsedByStepId,
  onToggleStep,
}: {
  step: ChatTraceStep;
  collapsedByStepId: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
}) {
  const expanded = !(collapsedByStepId[step.id] ?? true);

  return (
    <div>
      <button
        type="button"
        onClick={() => step.details.length > 0 && onToggleStep(step.id)}
        className={`flex w-full items-start gap-2 rounded-md px-2.5 -ml-2.5 py-1 text-left text-xs transition-colors ${step.details.length > 0 ? "hover:bg-muted cursor-pointer" : "cursor-default"}`}
      >
        <span className="mt-0.5 shrink-0">
          {step.status === "completed" ? (
            <Check className="size-3 text-success" />
          ) : step.status === "error" ? (
            <AlertTriangle className="size-3 text-destructive" />
          ) : step.status === "running" ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <Clock3 className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">{step.title}</span>
          {step.details.length > 0 ? (
            <span className="ml-1.5 text-muted-foreground">
              {step.details[0]}
            </span>
          ) : null}
        </span>
        {step.details.length > 1 ? (
          <ChevronDown
            className={`size-3 mt-0.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {expanded && step.details.length > 1 ? (
        <div className="ml-6 mt-0.5 mb-1 rounded-md border border-border bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
          {step.details.slice(1).join("\n")}
        </div>
      ) : null}
      {step.status === "error" ? (
        <IntegrationErrorBanner details={step.details} />
      ) : null}
    </div>
  );
}

function ExecutionTimelineThinkingEntry({
  text,
  onLinkClick,
  onLocalLinkClick,
}: {
  text: string;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
}) {
  return (
    <div className="py-1">
      <div className="-ml-2.5 w-[calc(100%+0.625rem)] rounded-xl border border-border bg-muted px-3.5 py-3">
        <SimpleMarkdown
          className="chat-markdown chat-thinking-markdown max-w-full text-foreground"
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
        >
          {text}
        </SimpleMarkdown>
      </div>
    </div>
  );
}

function TraceStepGroup({
  items,
  collapsedByStepId,
  onToggleStep,
  live = false,
  liveOutputStarted = false,
  onLinkClick,
  onLocalLinkClick,
  forceExpandToken = 0,
}: {
  items: ChatExecutionTimelineItem[];
  collapsedByStepId: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
  live?: boolean;
  liveOutputStarted?: boolean;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  forceExpandToken?: number;
}) {
  const steps = traceStepsFromExecutionItems(items);
  const [groupExpanded, setGroupExpanded] = useState(
    live && !liveOutputStarted,
  );
  const previousLiveRef = useRef(live);
  const previousLiveOutputStartedRef = useRef(liveOutputStarted);
  const previousForceExpandTokenRef = useRef(forceExpandToken);

  useEffect(() => {
    if (forceExpandToken !== previousForceExpandTokenRef.current) {
      previousForceExpandTokenRef.current = forceExpandToken;
      if (forceExpandToken > 0) {
        setGroupExpanded(true);
      }
    }
  }, [forceExpandToken]);

  useEffect(() => {
    if (live && !previousLiveRef.current) {
      setGroupExpanded(!liveOutputStarted);
    }
    if (live && liveOutputStarted && !previousLiveOutputStartedRef.current) {
      setGroupExpanded(false);
    }
    previousLiveRef.current = live;
    previousLiveOutputStartedRef.current = liveOutputStarted;
  }, [live, liveOutputStarted]);
  const runningCount = steps.filter((s) => s.status === "running").length;
  const terminalErrorCount = steps.filter(
    (step) => step.kind === "phase" && step.status === "error",
  ).length;
  const groupHasTerminalError = terminalErrorCount > 0;
  const stepCount = steps.length;
  const stepLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const activeStep =
    [...steps]
      .reverse()
      .find((step) => step.status === "running" || step.status === "waiting") ??
    null;
  const groupIsLive = live && activeStep !== null && !groupHasTerminalError;
  const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const latestThinkingItem =
    [...items]
      .reverse()
      .find(
        (
          item,
        ): item is Extract<ChatExecutionTimelineItem, { kind: "thinking" }> =>
          item.kind === "thinking",
      ) ?? null;
  const summaryStep = activeStep ?? (groupIsLive ? latestStep : null);
  const summarySuffix = groupHasTerminalError
    ? ` (${terminalErrorCount} failed)`
    : "";
  const showLiveSummarySpinner =
    (groupIsLive || runningCount > 0) && !groupExpanded;
  const summaryLabel = summaryStep
    ? summaryStep === activeStep || summaryStep.status === "waiting"
      ? `${traceStatusLabel(summaryStep.status)}: ${summaryStep.title}`
      : groupIsLive
        ? summaryStep.title
        : `${traceStatusLabel(summaryStep.status)}: ${summaryStep.title}`
    : groupIsLive
      ? latestThinkingItem
        ? summarizeThinking(latestThinkingItem.text)
        : stepCount > 0
          ? `Working through ${stepLabel}...`
          : "Thinking..."
      : runningCount > 0
        ? `Running ${stepLabel}...`
        : latestThinkingItem
          ? summarizeThinking(latestThinkingItem.text)
          : stepCount > 0 && latestStep
            ? latestStep.title
            : "Execution trace";

  return (
    <div className="mt-3 first:mt-0">
      <button
        type="button"
        onClick={() => setGroupExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 -ml-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        {groupHasTerminalError ? (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : showLiveSummarySpinner ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : groupIsLive || runningCount > 0 ? (
          <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1 truncate leading-5">
          {summaryLabel}
          {summarySuffix}
        </span>
        {stepCount > 0 && !groupIsLive && !groupHasTerminalError ? (
          <span
            aria-hidden
            className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums text-muted-foreground"
          >
            {stepCount}
          </span>
        ) : null}
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${groupExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {groupExpanded ? (
        <div className="mt-1 ml-1 space-y-0.5">
          {items.map((item) =>
            item.kind === "thinking" ? (
              <ExecutionTimelineThinkingEntry
                key={item.id}
                text={item.text}
                onLinkClick={onLinkClick}
                onLocalLinkClick={onLocalLinkClick}
              />
            ) : (
              <TraceTimelineStepEntry
                key={item.id}
                step={item.step}
                collapsedByStepId={collapsedByStepId}
                onToggleStep={onToggleStep}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentImageThumb({ file }: { file: File }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (loadFailed || !objectUrl) {
    return <ImageIcon className="size-4 shrink-0 text-primary" />;
  }
  return (
    <img
      alt=""
      className="size-7 shrink-0 rounded-md object-cover"
      onError={() => setLoadFailed(true)}
      src={objectUrl}
    />
  );
}

function AttachmentList({
  attachments,
  onRemove,
  onPreview,
  className = "",
}: {
  attachments: AttachmentListItem[];
  onRemove?: (attachmentId: string) => void;
  onPreview?: (attachment: AttachmentListItem) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {attachments.map((attachment) => {
        const isImagePreviewable =
          attachment.kind === "image" &&
          Boolean(onPreview) &&
          Boolean(
            attachment.file ||
            (typeof attachment.workspace_path === "string" &&
              attachment.workspace_path.trim()),
          );

        const icon =
          attachment.kind === "image" && attachment.file ? (
            <AttachmentImageThumb file={attachment.file} />
          ) : attachment.kind === "image" ? (
            <ImageIcon className="size-4 shrink-0 text-primary" />
          ) : attachment.kind === "folder" ? (
            <Folder className="size-3.5 shrink-0 text-primary" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-primary" />
          );

        const labelClassName = "truncate";
        const isImageThumb = attachment.kind === "image" && Boolean(attachment.file);

        const content = (
          <>
            {icon}
            <span className={labelClassName}>
              {attachmentButtonLabel(attachment)}
            </span>
          </>
        );

        return (
          <div
            className="group/attachment bg-muted relative inline-flex max-w-full items-center gap-2 rounded-lg border border-border pr-2 text-xs text-foreground"
            key={attachment.id}
            style={{
              paddingLeft: isImageThumb ? "4px" : "10px",
              paddingTop: isImageThumb ? "4px" : "5px",
              paddingBottom: isImageThumb ? "4px" : "5px",
            }}
          >
            {isImagePreviewable ? (
              <button
                aria-label={`Preview ${attachment.name}`}
                className="flex min-w-0 items-center gap-2 rounded-md text-left transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                onClick={() => onPreview?.(attachment)}
                title={`Preview ${attachment.name}`}
                type="button"
              >
                {content}
              </button>
            ) : (
              content
            )}
            {onRemove ? (
              <button
                aria-label={`Remove ${attachment.name}`}
                className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition group-hover/attachment:opacity-100 hover:text-foreground"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ImageAttachmentPreviewModal({
  open,
  preview,
  onClose,
}: {
  open: boolean;
  preview: ImageAttachmentPreviewState | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !preview) {
    return null;
  }

  const sizeLabel = formatAttachmentSize(preview.attachment.size_bytes);
  const showImage = !preview.isLoading && !preview.errorMessage;
  const modalContent = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center px-6 py-8"
      onClick={onClose}
    >
      {preview.browserSnapshot ? (
        <img
          aria-hidden="true"
          src={preview.browserSnapshot.dataUrl}
          alt=""
          className="pointer-events-none absolute object-fill"
          style={{
            left: `${preview.browserSnapshot.bounds.x}px`,
            top: `${preview.browserSnapshot.bounds.y}px`,
            width: `${preview.browserSnapshot.bounds.width}px`,
            height: `${preview.browserSnapshot.bounds.height}px`,
          }}
        />
      ) : null}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${preview.attachment.name}`}
        className="relative z-10 flex max-h-[calc(100vh-64px)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl"
        style={{ maxWidth: "92vw" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {preview.attachment.name}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {sizeLabel || "Image attachment"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div
          className={`overflow-auto px-4 py-4 ${
            showImage
              ? "bg-transparent"
              : "min-h-[240px] min-w-[320px] bg-muted/20"
          }`}
        >
          {preview.isLoading ? (
            <div className="flex h-full min-h-[208px] items-center justify-center gap-2 text-sm text-foreground/80">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading preview...</span>
            </div>
          ) : preview.errorMessage ? (
            <div className="flex h-full min-h-[208px] flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-5 text-warning" />
              <p className="max-w-md text-sm text-foreground/80">
                {preview.errorMessage}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center">
              <img
                src={preview.dataUrl}
                alt={preview.attachment.name}
                className="block h-auto w-auto rounded-lg ring-1 ring-black/8"
                style={{
                  maxWidth: "calc(92vw - 32px)",
                  maxHeight: "calc(88vh - 128px)",
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

function ModelCombobox({
  selectedModel,
  selectedModelLabel,
  runtimeDefaultModelLabel,
  runtimeDefaultModelAvailable,
  modelOptions,
  modelOptionGroups,
  disabled,
  compact = false,
  onModelChange,
}: {
  selectedModel: string;
  selectedModelLabel: string;
  runtimeDefaultModelLabel: string;
  runtimeDefaultModelAvailable: boolean;
  modelOptions: ChatModelOption[];
  modelOptionGroups: ChatModelOptionGroup[];
  disabled: boolean;
  compact?: boolean;
  onModelChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const autoOption = useMemo(
    () =>
      runtimeDefaultModelAvailable
        ? ({
            value: CHAT_MODEL_USE_RUNTIME_DEFAULT,
            label: `Auto (${runtimeDefaultModelLabel})`,
          } satisfies ChatModelOption)
        : null,
    [runtimeDefaultModelAvailable, runtimeDefaultModelLabel],
  );

  const filteredAutoOption = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!autoOption) {
      return null;
    }
    if (!q) {
      return autoOption;
    }
    return autoOption.label.toLowerCase().includes(q) ||
      autoOption.value.toLowerCase().includes(q)
      ? autoOption
      : null;
  }, [autoOption, query]);

  const filteredOptionGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sourceGroups =
      modelOptionGroups.length > 0
        ? modelOptionGroups
        : [{ label: "", options: modelOptions }];
    return sourceGroups
      .map((group) => ({
        ...group,
        options: q
          ? group.options.filter((option) => {
              const haystack = [
                option.label,
                option.selectedLabel,
                option.searchText,
                option.value,
                group.label,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(q);
            })
          : group.options,
      }))
      .filter((group) => group.options.length > 0);
  }, [modelOptionGroups, modelOptions, query]);

  const displayLabel =
    selectedModel === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? `Auto (${runtimeDefaultModelLabel})`
      : selectedModelLabel || "Select model";
  const compactLabel = compactComposerModelLabel(displayLabel);

  const hasFilteredOptions =
    Boolean(filteredAutoOption) ||
    filteredOptionGroups.some((group) => group.options.length > 0);

  const renderOption = (option: ChatModelOption) => {
    const active = option.value === selectedModel;
    const optionDisabled = Boolean(option.disabled);
    // Auto/runtime-default doesn't represent a single model — keep its
    // icon empty rather than guessing (the chosen runtime default still
    // ends up rendering with its real brand mark in the trigger).
    const isRuntimeDefault = option.value === CHAT_MODEL_USE_RUNTIME_DEFAULT;
    return (
      <button
        key={option.value}
        type="button"
        disabled={optionDisabled}
        aria-current={active ? "true" : undefined}
        onClick={() => {
          if (optionDisabled) {
            return;
          }
          onModelChange(option.value);
          setOpen(false);
          setQuery("");
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
          active
            ? "bg-accent text-foreground"
            : optionDisabled
              ? "cursor-not-allowed text-muted-foreground"
              : "text-foreground hover:bg-accent"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {isRuntimeDefault ? (
            <span className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ProviderBrandIcon
              modelToken={option.value}
              className="size-3.5 shrink-0"
            />
          )}
          <span className="truncate">{option.label}</span>
        </span>
        {!active && option.statusLabel ? (
          <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
            {option.statusLabel}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={`gap-1.5 rounded-md text-xs font-medium ${
              compact ? "w-full justify-between px-2.5" : "px-2"
            }`}
          >
            {compact ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ProviderBrandIcon
                    modelToken={selectedModel}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{compactLabel}</span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            ) : (
              <>
                <ProviderBrandIcon
                  modelToken={selectedModel}
                  className="size-3.5 shrink-0"
                />
                <span className="whitespace-nowrap">{displayLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="p-0 gap-0"
      >
        <div className="border-b border-border p-1.5">
          <div className="relative flex h-7 items-center rounded-md border border-border bg-background px-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="embedded-input h-full w-full bg-transparent pl-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {!hasFilteredOptions ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No models found
            </div>
          ) : (
            <>
              {filteredAutoOption ? (
                <div className="pb-1">{renderOption(filteredAutoOption)}</div>
              ) : null}
              {filteredOptionGroups.map((group, idx) => (
                <div
                  key={group.label || "models"}
                  className={idx > 0 ? "mt-2" : ""}
                >
                  {group.label ? (
                    <div className="px-2.5 pb-1 text-[10px] font-medium uppercase text-muted-foreground">
                      {group.label}
                    </div>
                  ) : null}
                  {group.options.map((option) => renderOption(option))}
                </div>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThinkingValueSelect({
  selectedThinkingValue,
  thinkingValues,
  disabled,
  compact = false,
  compactWidth,
  onThinkingValueChange,
}: {
  selectedThinkingValue: string | null;
  thinkingValues: string[];
  disabled: boolean;
  compact?: boolean;
  compactWidth?: number;
  onThinkingValueChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  if (thinkingValues.length === 0 || !selectedThinkingValue) {
    return null;
  }
  const selectedThinkingLabel = displayThinkingValueLabel(
    selectedThinkingValue,
  );
  const showCompactLabel = !compact || typeof compactWidth !== "number";

  const renderOption = (value: string) => {
    const active = value === selectedThinkingValue;
    return (
      <button
        key={value}
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          onThinkingValueChange(value);
          setOpen(false);
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
          active
            ? "bg-accent text-foreground"
            : "text-foreground hover:bg-accent"
        }`}
      >
        <span className="truncate">{displayThinkingValueLabel(value)}</span>
      </button>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={
              compact ? `Reasoning effort: ${selectedThinkingLabel}` : undefined
            }
            className={`gap-1.5 rounded-md text-xs font-medium ${
              compact
                ? showCompactLabel
                  ? "w-full min-w-0 justify-between px-2.5"
                  : "w-full min-w-0 justify-center px-2.5"
                : "px-2"
            }`}
          >
            {compact ? (
              showCompactLabel ? (
                <>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{selectedThinkingLabel}</span>
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" />
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </span>
              )
            ) : (
              <>
                <span className="whitespace-nowrap">
                  {selectedThinkingLabel}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="max-w-40 gap-0 rounded-lg p-1 shadow-subtle-sm ring-0"
      >
        <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase text-muted-foreground">
          Reasoning effort
        </div>
        {thinkingValues.map((value) => renderOption(value))}
      </PopoverContent>
    </Popover>
  );
}

function Composer({
  input,
  quotedSkills,
  slashCommands,
  attachments,
  isResponding,
  pausePending,
  pauseDisabled,
  disabled,
  disabledReason = "",
  selectedModel,
  resolvedModelLabel,
  runtimeDefaultModelLabel,
  modelOptions,
  modelOptionGroups,
  runtimeDefaultModelAvailable,
  selectedThinkingValue,
  thinkingValues,
  showThinkingValueSelector,
  modelSelectionUnavailableReason,
  submitDisabled = false,
  placeholder,
  showModelSelector,
  onModelChange,
  onThinkingValueChange,
  onOpenModelProviders,
  textareaRef,
  fileInputRef,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onAttachmentInputChange,
  onPause,
  onAddDroppedFiles,
  onAddExplorerAttachments,
  onSelectSlashCommand,
  onRemoveQuotedSkill,
  onRemoveAttachment,
  onPreviewAttachment,
}: ComposerProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [composerActionsMenuOpen, setComposerActionsMenuOpen] = useState(false);
  const [composerActionsView, setComposerActionsView] = useState<
    "menu" | "skills"
  >("menu");
  const [skillPickerQuery, setSkillPickerQuery] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const [dismissedSlashCommandKey, setDismissedSlashCommandKey] = useState("");
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const composerFooterRef = useRef<HTMLDivElement | null>(null);
  const composerActionsRef = useRef<HTMLDivElement | null>(null);
  const composerFooterLayoutSyncFrameRef = useRef<number | null>(null);
  const slashCommandMenuRef = useRef<HTMLDivElement | null>(null);
  const [composerFooterLayout, setComposerFooterLayout] = useState({
    width: 0,
    actionsWidth: 0,
  });
  const noAvailableModels =
    !runtimeDefaultModelAvailable &&
    modelOptions.length === 0 &&
    modelOptionGroups.length === 0;
  const inputDisabled = disabled;
  const activeSlashRange = useMemo(
    () => findActiveSlashCommandRange(input, caretIndex),
    [caretIndex, input],
  );
  const activeSlashCommandKey = activeSlashRange
    ? `${activeSlashRange.start}:${activeSlashRange.end}:${activeSlashRange.query}`
    : "";
  const showSlashCommandMenu =
    !inputDisabled &&
    activeSlashRange !== null &&
    activeSlashCommandKey !== dismissedSlashCommandKey;
  const filteredSlashCommands = useMemo(() => {
    if (inputDisabled || !activeSlashRange) {
      return [];
    }
    const query = activeSlashRange.query.trim().toLowerCase();
    if (!query) {
      return slashCommands;
    }
    return slashCommands.filter(
      (command) =>
        command.command.toLowerCase().includes(query) ||
        command.searchText.includes(query),
    );
  }, [activeSlashRange, inputDisabled, slashCommands]);
  const filteredSkillCommands = useMemo(() => {
    const query = skillPickerQuery.trim().toLowerCase();
    if (!query) {
      return slashCommands;
    }
    return slashCommands.filter(
      (command) =>
        command.command.toLowerCase().includes(query) ||
        command.searchText.includes(query),
    );
  }, [skillPickerQuery, slashCommands]);
  const quotedSkillIdSet = useMemo(
    () => new Set(quotedSkills.map((skill) => skill.skillId)),
    [quotedSkills],
  );
  const visibleModelOptions = modelOptionGroups.flatMap(
    (group) => group.options,
  );
  const selectedModelOptionLabel =
    visibleModelOptions.find((option) => option.value === selectedModel)
      ?.selectedLabel ??
    visibleModelOptions.find((option) => option.value === selectedModel)
      ?.label ??
    modelOptions.find((option) => option.value === selectedModel)
      ?.selectedLabel ??
    modelOptions.find((option) => option.value === selectedModel)?.label ??
    resolvedModelLabel;
  const cancelComposerFooterLayoutSync = () => {
    if (composerFooterLayoutSyncFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(composerFooterLayoutSyncFrameRef.current);
    composerFooterLayoutSyncFrameRef.current = null;
  };
  const syncComposerFooterLayout = () => {
    const footer = composerFooterRef.current;
    if (!footer) {
      return;
    }
    const footerStyle = window.getComputedStyle(footer);
    const horizontalPadding =
      Number.parseFloat(footerStyle.paddingLeft || "0") +
      Number.parseFloat(footerStyle.paddingRight || "0");
    const width = Math.max(
      0,
      Math.round(footer.clientWidth - horizontalPadding),
    );
    const actionsWidth = Math.round(
      composerActionsRef.current?.getBoundingClientRect().width ?? 0,
    );
    setComposerFooterLayout((current) =>
      current.width === width && current.actionsWidth === actionsWidth
        ? current
        : { width, actionsWidth },
    );
  };
  // Coalesce ResizeObserver bursts so compact/full footer transitions do not
  // synchronously re-enter render while the DOM is still settling.
  const scheduleComposerFooterLayoutSync = () => {
    if (composerFooterLayoutSyncFrameRef.current !== null) {
      return;
    }
    composerFooterLayoutSyncFrameRef.current = window.requestAnimationFrame(
      () => {
        composerFooterLayoutSyncFrameRef.current = null;
        syncComposerFooterLayout();
      },
    );
  };
  useLayoutEffect(() => {
    const footer = composerFooterRef.current;
    if (!footer) {
      return;
    }

    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      scheduleComposerFooterLayoutSync();
    });
    resizeObserver.observe(footer);
    if (composerActionsRef.current) {
      resizeObserver.observe(composerActionsRef.current);
    }
    return () => {
      resizeObserver.disconnect();
      cancelComposerFooterLayoutSync();
    };
  }, []);
  useEffect(() => {
    setHighlightedSlashIndex(0);
  }, [activeSlashRange?.query, filteredSlashCommands.length]);
  useEffect(() => {
    if (!dismissedSlashCommandKey) {
      return;
    }
    if (!activeSlashCommandKey) {
      setDismissedSlashCommandKey("");
      return;
    }
    if (dismissedSlashCommandKey !== activeSlashCommandKey) {
      setDismissedSlashCommandKey("");
    }
  }, [activeSlashCommandKey, dismissedSlashCommandKey]);
  useEffect(() => {
    if (inputDisabled) {
      setComposerActionsMenuOpen(false);
      setComposerActionsView("menu");
      setSkillPickerQuery("");
      setDismissedSlashCommandKey("");
    }
  }, [inputDisabled]);
  useEffect(() => {
    if (!showSlashCommandMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const menu = slashCommandMenuRef.current;
      const target = event.target;
      if (!menu || !(target instanceof Node) || menu.contains(target)) {
        return;
      }
      setDismissedSlashCommandKey(activeSlashCommandKey);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [activeSlashCommandKey, showSlashCommandMenu]);
  const visibleFooterControlCount = 1 + (showThinkingValueSelector ? 1 : 0) + 1;
  const fullPrimaryControlWidth = showModelSelector
    ? noAvailableModels
      ? COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX
      : COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX
    : 0;
  const fullFooterControlWidth =
    fullPrimaryControlWidth +
    (showThinkingValueSelector ? COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX : 0) +
    composerFooterLayout.actionsWidth +
    Math.max(0, visibleFooterControlCount - 1) * COMPOSER_FOOTER_GAP_PX;
  const compactFooterControlWidth = Math.max(
    0,
    composerFooterLayout.width -
      composerFooterLayout.actionsWidth -
      Math.max(0, visibleFooterControlCount - 1) * COMPOSER_FOOTER_GAP_PX,
  );
  const compactComposerControls =
    showModelSelector &&
    composerFooterLayout.width > 0 &&
    composerFooterLayout.actionsWidth > 0 &&
    composerFooterLayout.width < fullFooterControlWidth;
  const compactModelControlWidth = compactComposerControls
    ? Math.min(
        COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX,
        Math.max(
          0,
          compactFooterControlWidth -
            (showThinkingValueSelector
              ? Math.min(
                  COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
                  compactFooterControlWidth,
                )
              : 0),
        ),
      )
    : 0;
  const compactThinkingControlWidth = showThinkingValueSelector
    ? Math.max(
        Math.min(
          COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX,
          compactFooterControlWidth - compactModelControlWidth,
        ),
        Math.min(
          COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
          compactFooterControlWidth,
        ),
      )
    : 0;

  const syncCaretFromTextarea = (target: HTMLTextAreaElement | null) => {
    if (!target) {
      return;
    }
    setCaretIndex(target.selectionStart ?? target.value.length);
  };

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
    syncCaretFromTextarea(event.target);
  };

  const applySlashCommand = (command: ChatComposerSlashCommandOption) => {
    onSelectSlashCommand(command);
    if (!activeSlashRange) {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        syncCaretFromTextarea(textarea);
      });
      return;
    }
    const nextInput = removeSlashCommandText(input, activeSlashRange);
    onChange(nextInput.value);
    setCaretIndex(nextInput.caretIndex);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextInput.caretIndex, nextInput.caretIndex);
    });
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashCommandMenu) {
      if (event.key === "ArrowDown" && filteredSlashCommands.length > 0) {
        event.preventDefault();
        setHighlightedSlashIndex(
          (current) => (current + 1) % filteredSlashCommands.length,
        );
        return;
      }
      if (event.key === "ArrowUp" && filteredSlashCommands.length > 0) {
        event.preventDefault();
        setHighlightedSlashIndex(
          (current) =>
            (current - 1 + filteredSlashCommands.length) %
            filteredSlashCommands.length,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        filteredSlashCommands.length > 0
      ) {
        event.preventDefault();
        applySlashCommand(
          filteredSlashCommands[
            Math.min(highlightedSlashIndex, filteredSlashCommands.length - 1)
          ]!,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCaretIndex(-1);
        return;
      }
    }
    onKeyDown(event);
  };

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = clipboardFilesFromDataTransfer(event.clipboardData);
    if (pastedFiles.length === 0) {
      const clipboardText =
        event.clipboardData?.getData("text/plain")?.trim() ?? "";
      const explorerFiles =
        explorerAttachmentFilesFromClipboardText(clipboardText);
      if (explorerFiles.length > 0) {
        event.preventDefault();
        onAddExplorerAttachments(explorerFiles);
        return;
      }

      const clipboardTypes = Array.from(event.clipboardData?.types ?? []);
      const hasClipboardImageType = clipboardTypes.some(
        (type) => type === "Files" || type.startsWith("image/"),
      );
      if (
        clipboardText ||
        (clipboardTypes.includes("text/html") && !hasClipboardImageType)
      ) {
        return;
      }

      event.preventDefault();
      void clipboardImageFileFromElectronClipboard()
        .then((file) => {
          if (file) {
            onAddDroppedFiles([file]);
          }
        })
        .catch(() => undefined);
      return;
    }

    event.preventDefault();
    onAddDroppedFiles(pastedFiles);
  };

  const openSkillPickerFromComposerMenu = () => {
    setComposerActionsView("skills");
    setSkillPickerQuery("");
  };

  const closeComposerActionsMenu = () => {
    setComposerActionsMenuOpen(false);
    setComposerActionsView("menu");
    setSkillPickerQuery("");
  };

  const selectSkillFromPicker = (command: ChatComposerSlashCommandOption) => {
    const alreadyQuoted = quotedSkills.some(
      (skill) => skill.skillId === command.skillId,
    );
    if (alreadyQuoted) {
      onRemoveQuotedSkill(command.skillId);
      return;
    }
    onSelectSlashCommand(command);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      syncCaretFromTextarea(textarea);
    });
  };

  const allowAttachmentDrop = (dataTransfer: DataTransfer | null) => {
    if (!dataTransfer || disabled) {
      return false;
    }

    const types = Array.from(dataTransfer.types ?? []);
    if (types.includes(EXPLORER_ATTACHMENT_DRAG_TYPE)) {
      return true;
    }

    if ((dataTransfer.files?.length ?? 0) > 0) {
      return true;
    }

    return Array.from(dataTransfer.items ?? []).some(
      (item) => item.kind === "file",
    );
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!allowAttachmentDrop(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragActive) {
      setIsDragActive(true);
    }
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!allowAttachmentDrop(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsDragActive(false);

    const explorerFiles: ExplorerAttachmentDragPayload[] = [];
    const rawExplorerPayload = event.dataTransfer.getData(
      EXPLORER_ATTACHMENT_DRAG_TYPE,
    );
    const parsedExplorerPayload =
      parseExplorerAttachmentDragPayload(rawExplorerPayload);
    if (parsedExplorerPayload) {
      explorerFiles.push(parsedExplorerPayload);
    }

    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (explorerFiles.length > 0) {
      onAddExplorerAttachments(explorerFiles);
    }
    if (droppedFiles.length > 0) {
      onAddDroppedFiles(droppedFiles);
    }
  };

  return (
    <div className="relative">
      {showSlashCommandMenu ? (
        <div className="pointer-events-none absolute left-3 right-3 top-4 z-20 -translate-y-[calc(100%+2px)]">
          <div
            ref={slashCommandMenuRef}
            className="pointer-events-auto overflow-hidden rounded-3xl border border-border bg-popover shadow-2xl ring-1 ring-border"
          >
            {filteredSlashCommands.length > 0 ? (
              <div className="max-h-[280px] overflow-y-auto py-1.5">
                {filteredSlashCommands.map((command, index) => (
                  <button
                    key={command.key}
                    type="button"
                    onClick={() => applySlashCommand(command)}
                    className={`flex w-full items-start gap-3 px-4 py-2.5 text-left text-xs transition-colors ${
                      index === highlightedSlashIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <Sparkles className="size-3.5 mt-0.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {command.label}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-4 py-4 text-xs text-muted-foreground">
                No slash commands match.
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative overflow-hidden rounded-2xl bg-background shadow-md"
      >
        {isDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border border-dashed border-primary/50 bg-background/85 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-1.5 text-primary">
              <Paperclip className="size-5" />
              <span className="text-xs font-medium">
                Drop files to attach
              </span>
            </div>
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onAttachmentInputChange}
        />
        {attachments.length > 0 ? (
          <div className="border-b border-border px-4 py-3">
            <AttachmentList
              attachments={attachments}
              onPreview={onPreviewAttachment}
              onRemove={onRemoveAttachment}
            />
          </div>
        ) : null}
        {quotedSkills.length > 0 ? (
          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {quotedSkills.map((skill) => (
                <div
                  key={skill.skillId}
                  className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary bg-primary/8 px-3 py-1.5 text-xs text-foreground"
                >
                  <Sparkles className="size-3 text-primary" />
                  <span className="truncate">{skill.title}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveQuotedSkill(skill.skillId)}
                    className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground transition hover:text-foreground"
                    aria-label={`Remove quoted skill ${skill.title}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="px-5 pb-2 pt-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handleTextareaPaste}
            onSelect={(event) => syncCaretFromTextarea(event.currentTarget)}
            onClick={(event) => syncCaretFromTextarea(event.currentTarget)}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            rows={1}
            disabled={inputDisabled}
            placeholder={
              inputDisabled
                ? disabledReason || "Chat unavailable right now"
                : placeholder
            }
            className="composer-input block max-h-[220px] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-55"
          />
        </div>

        <div
          ref={composerFooterRef}
          className={`px-3 pb-3 text-muted-foreground ${
            compactComposerControls
              ? "flex items-center gap-1.5 overflow-hidden"
              : "flex flex-wrap items-center gap-1.5"
          }`}
        >
          {showModelSelector ? (
            <div
              className={
                compactComposerControls
                  ? "min-w-0 shrink-0"
                  : noAvailableModels
                    ? "min-w-0 flex flex-1 basis-full flex-wrap items-center gap-2"
                    : "min-w-0 shrink-0"
              }
            >
              {noAvailableModels ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={onOpenModelProviders}
                    className={`shrink-0 justify-between rounded-lg bg-card text-xs font-semibold hover:border-primary hover:bg-card ${
                      compactComposerControls ? "px-2.5" : ""
                    }`}
                    aria-label="Configure model providers"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Waypoints className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {compactComposerControls
                          ? "Providers"
                          : "Set up providers"}
                      </span>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                  <div
                    className={`min-w-0 text-[10px] leading-5 text-muted-foreground ${
                      compactComposerControls ? "hidden" : ""
                    }`}
                  >
                    Open provider settings to connect a model.
                  </div>
                </>
              ) : (
                <ModelCombobox
                  selectedModel={selectedModel}
                  selectedModelLabel={selectedModelOptionLabel}
                  runtimeDefaultModelLabel={runtimeDefaultModelLabel}
                  runtimeDefaultModelAvailable={runtimeDefaultModelAvailable}
                  modelOptions={modelOptions}
                  modelOptionGroups={modelOptionGroups}
                  disabled={disabled}
                  compact={compactComposerControls}
                  onModelChange={onModelChange}
                />
              )}
            </div>
          ) : (
            <div className="min-w-0 flex-1 text-xs leading-6 text-muted-foreground">
              Responses here stay in the workspace onboarding thread.
            </div>
          )}

          {showThinkingValueSelector ? (
            <div className="shrink-0">
              <ThinkingValueSelect
                selectedThinkingValue={selectedThinkingValue}
                thinkingValues={thinkingValues}
                disabled={disabled}
                compact={compactComposerControls}
                compactWidth={
                  compactComposerControls
                    ? compactThinkingControlWidth
                    : undefined
                }
                onThinkingValueChange={onThinkingValueChange}
              />
            </div>
          ) : null}

          <div
            ref={composerActionsRef}
            className="ml-auto flex shrink-0 items-center gap-1.5"
          >
            <Popover
              open={composerActionsMenuOpen}
              onOpenChange={(nextOpen) => {
                setComposerActionsMenuOpen(nextOpen);
                if (!nextOpen) {
                  setComposerActionsView("menu");
                  setSkillPickerQuery("");
                }
              }}
            >
              <PopoverTrigger
                disabled={inputDisabled}
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Open composer actions"
                    className="rounded-lg"
                  />
                }
              >
                <Plus className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                sideOffset={8}
                className={`gap-0 rounded-xl border border-border bg-popover p-0 shadow-subtle-sm ring-0 ${
                  composerActionsView === "skills" ? "w-[320px]" : "w-[224px]"
                }`}
              >
                {composerActionsView === "skills" ? (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setComposerActionsView("menu");
                          setSkillPickerQuery("");
                        }}
                        aria-label="Back to actions"
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ArrowLeft className="size-3.5" />
                      </button>
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                      <input
                        value={skillPickerQuery}
                        onChange={(event) =>
                          setSkillPickerQuery(event.target.value)
                        }
                        placeholder="Search skills"
                        className="embedded-input h-7 w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                        autoFocus
                      />
                      {quotedSkillIdSet.size > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {quotedSkillIdSet.size}
                        </span>
                      ) : null}
                    </div>
                    {filteredSkillCommands.length > 0 ? (
                      <div className="max-h-[288px] overflow-y-auto p-1">
                        {filteredSkillCommands.map((command) => {
                          const isSelected = quotedSkillIdSet.has(
                            command.skillId,
                          );
                          return (
                            <button
                              key={command.key}
                              type="button"
                              onClick={() => selectSkillFromPicker(command)}
                              aria-pressed={isSelected}
                              className={`group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                                isSelected
                                  ? "bg-accent text-foreground"
                                  : "text-foreground hover:bg-accent"
                              }`}
                            >
                              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                                {isSelected ? (
                                  <Check className="size-3.5 text-primary" />
                                ) : (
                                  <Sparkles className="size-3.5 text-muted-foreground" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-foreground">
                                  {command.label}
                                </span>
                                {command.description ? (
                                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                                    {command.description}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
                        <Sparkles className="size-4 text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground">
                          No matching skills
                        </span>
                        <span className="text-[11px] leading-4 text-muted-foreground">
                          Try a different search term.
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        closeComposerActionsMenu();
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        Attach a file
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={openSkillPickerFromComposerMenu}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      <Zap className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        Use Skills
                      </span>
                      {quotedSkillIdSet.size > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {quotedSkillIdSet.size}
                        </span>
                      ) : null}
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {isResponding ? (
              <Button
                type="button"
                size="icon-sm"
                aria-label="Pause"
                disabled={pausePending || pauseDisabled || disabled}
                onClick={onPause}
                className="rounded-lg"
              >
                {pausePending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send message"
                disabled={
                  (!input.trim() &&
                    attachments.length === 0 &&
                    quotedSkills.length === 0) ||
                  disabled ||
                  submitDisabled
                }
                render={<button type="submit" />}
                className="rounded-lg"
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
