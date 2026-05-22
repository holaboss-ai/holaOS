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
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Wand2,
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
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { EntityChip } from "@/components/ui/entity-chip";
import { EntityMention } from "@/components/ui/entity-mention";
import {
  MENTION_URL_SCHEME,
  SimpleMarkdown,
} from "@/components/marketplace/SimpleMarkdown";
import {
  EXPLORER_ATTACHMENT_DRAG_TYPE,
  type ExplorerAttachmentDragPayload,
  parseExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "@/lib/attachmentDrag";
import { getExplorerAttachmentClipboardEntry } from "@/lib/appClipboard";
import { CHAT_LAYOUT, chatScrollMaskImage } from "@/lib/chatLayout";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { trackUmamiEvent } from "@/lib/analytics/umami";
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
import {
  listWorkspaceFiles,
  type WorkspaceFileEntry,
} from "@/lib/workspaceFiles";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import * as modelCatalog from "../../../../shared/model-catalog.js";
import {
  type ChatAttachment,
  type ChatPaneVariant,
  type ChatAssistantSegment,
  type ChatMessage,
  type QueuedSessionInputStatus,
  type QueuedSessionInput,
  type QueuedSessionInputPreviewDescriptor,
  type ComposerInputRecallSnapshot,
  type PendingOptimisticUserMessage,
  type ChatSerializedQuotedSkillBlock,
  type ChatTraceStepStatus,
  type ChatTraceStep,
  type ChatExecutionTimelineItem,
  type ChatPendingIntegration,
  type ChatProposedIntegration,
  type PendingLocalAttachmentFile,
  type PendingExplorerAttachmentFile,
  type PendingAttachment,
  type AttachmentListItem,
  type ImageAttachmentPreviewState,
  type ChatModelOption,
  type ChatModelOptionGroup,
  type ChatComposerSlashCommandOption,
  type ChatComposerQuotedSkillItem,
  type ChatComposerMentionItem,
  type StreamTelemetryEntry,
  type ArtifactBrowserFilter,
} from "./types";
import {
  MAIN_SESSION_EVENT_BATCH_HEADER,
  BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE,
  EMPTY_ATTACHMENTS,
  EMPTY_SEGMENTS,
  EMPTY_EXECUTION_ITEMS,
  EMPTY_OUTPUTS,
  STREAM_ATTACH_PENDING,
  STREAM_TELEMETRY_LIMIT,
  TOOL_TRACE_TERMINAL_PHASES,
  CHAT_AUTO_SCROLL_THRESHOLD_PX,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX,
  SKELETON_MIN_DISPLAY_MS,
  COMPOSER_FOOTER_GAP_PX,
  COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX,
  COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX,
  COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX,
  COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX,
  COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
  COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX,
  CHAT_MODEL_STORAGE_KEY,
  CHAT_THINKING_STORAGE_KEY,
  CHAT_MODEL_USE_RUNTIME_DEFAULT,
  CHAT_SERIALIZED_SKILL_COMMAND_PATTERN,
  QUEUED_MESSAGES_PREVIEW_EVENT,
  LEGACY_UNAVAILABLE_CHAT_MODELS,
  DEPRECATED_CHAT_MODELS,
  CHAT_MODEL_PRESETS,
  RUNTIME_MODEL_CAPABILITY_ALIASES,
  MENTION_TOKEN_PATTERN,
} from "./constants";
import {
  initialBrowserState,
  attachmentLooksLikeImage,
  pendingAttachmentIsImage,
  supportsImageInput,
  imageInputUnsupportedMessage,
  parseSerializedQuotedSkillPrompt,
  appendComposerPrefillText,
  buildComposerSlashCommandOptions,
  findActiveSlashCommandRange,
  removeSlashCommandText,
  findActiveMentionRange,
  replaceMentionText,
  injectMentionLinks,
  displayModelLabel,
  compactComposerModelLabel,
  chatMessageTimeLabel,
  inputIdFromMessageId,
  inputIdFromHistoryMessage,
  historyMessagesInDisplayOrder,
  turnInputIdsFromHistoryMessages,
} from "./helpers";
import {
  HistoryRestoreSkeleton,
  IntegrationErrorBanner,
} from "./skeletons";
import {
  AttachmentList,
  formatAttachmentSize,
} from "./AttachmentList";
import { ImageAttachmentPreviewModal } from "./ImageAttachmentPreviewModal";
import {
  ArtifactBrowserModal,
  OutputArtifactIcon,
  outputBrowserFilterForOutput,
  outputChangeLabel,
  outputKindLabel,
  outputMetadataNumber,
  outputMetadataString,
  outputSecondaryLabel,
  sortOutputs,
  sortOutputsLatestFirst,
  dedupeOutputsForDisplay,
} from "./ArtifactBrowserModal";
import { ChatHeader } from "./ChatHeader";
import { QueuedSessionInputRail } from "./QueuedSessionInputRail";
import { AssistantTurn } from "./AssistantTurn";
import { Composer } from "./Composer";
import { UserTurn } from "./UserTurn";
import { ConversationTurns } from "./ConversationTurns";

export type {
  ChatAssistantSegment,
  ChatMessage,
  ChatComposerMentionItem,
  ArtifactBrowserFilter,
};
export {
  inputIdFromMessageId,
  historyMessagesInDisplayOrder,
  turnInputIdsFromHistoryMessages,
  ArtifactBrowserModal,
  sortOutputs,
  AssistantTurn,
  UserTurn,
  ConversationTurns,
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

const ONBOARDING_REPORT_FIELD_LABELS: Record<string, string> = {
  apps_to_install: "Apps to install",
  apps_to_create: "Apps to create",
  cronjobs: "Cronjobs",
  workspace_structure: "Workspace structure",
  skills: "Skills",
  ai_manager_behavior: "AI manager behavior",
  implementation_plan: "Implementation plan",
  open_questions: "Open questions",
  implemented_changes: "Implemented changes",
  verification_checks: "Verification checks",
  known_gaps: "Known gaps",
  user_visible_results: "User-visible results",
  follow_up_recommendations: "Follow-up recommendations",
};

function onboardingReportFieldLabel(key: string) {
  const normalized = key.trim().toLowerCase();
  if (ONBOARDING_REPORT_FIELD_LABELS[normalized]) {
    return ONBOARDING_REPORT_FIELD_LABELS[normalized];
  }
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const ONBOARDING_REPORT_SUMMARY_KEYS = [
  "title",
  "name",
  "label",
  "summary",
  "description",
  "cron",
  "path",
  "goal",
  "status",
  "purpose",
] as const;
const ONBOARDING_REPORT_SUMMARY_KEY_SET = new Set<string>(
  ONBOARDING_REPORT_SUMMARY_KEYS,
);
const ONBOARDING_REPORT_MARKDOWN_KEYS = [
  "markdown",
  "report_markdown",
  "body_markdown",
] as const;
const ONBOARDING_REPORT_HIDDEN_DETAIL_KEYS = new Set<string>([
  "summary",
  "requested_by",
  ...ONBOARDING_REPORT_MARKDOWN_KEYS,
]);

function onboardingReportInlineValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function onboardingReportObjectSummary(value: Record<string, unknown>): string {
  return ONBOARDING_REPORT_SUMMARY_KEYS.map((key) =>
    onboardingReportInlineValue(value[key]),
  )
    .filter(Boolean)
    .join(" · ");
}

function onboardingReportObjectDetailLines(
  value: Record<string, unknown>,
  depth = 0,
  skipSummaryKeys = false,
): string[] {
  const indent = "  ".repeat(depth);
  return Object.entries(value).flatMap(([key, entryValue]) => {
    if (skipSummaryKeys && ONBOARDING_REPORT_SUMMARY_KEY_SET.has(key.trim().toLowerCase())) {
      return [];
    }
    const label = onboardingReportFieldLabel(key);
    const inlineValue = onboardingReportInlineValue(entryValue);
    if (inlineValue) {
      return [`${indent}${label}: ${inlineValue}`];
    }
    if (Array.isArray(entryValue)) {
      const nestedLines = onboardingReportValueLines(entryValue, depth + 1);
      return nestedLines.length > 0
        ? [`${indent}${label}:`, ...nestedLines]
        : [];
    }
    if (isRecord(entryValue)) {
      const summary = onboardingReportObjectSummary(entryValue);
      const nestedLines = onboardingReportObjectDetailLines(
        entryValue,
        depth + 1,
        Boolean(summary),
      );
      if (summary && nestedLines.length === 0) {
        return [`${indent}${label}: ${summary}`];
      }
      if (summary) {
        return [`${indent}${label}: ${summary}`, ...nestedLines];
      }
      return nestedLines.length > 0 ? [`${indent}${label}:`, ...nestedLines] : [];
    }
    return [];
  });
}

function onboardingReportValueLines(value: unknown, depth = 0): string[] {
  const inlineValue = onboardingReportInlineValue(value);
  if (inlineValue) {
    return [`${"  ".repeat(depth)}${inlineValue}`];
  }
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const inlineEntry = onboardingReportInlineValue(entry);
      if (inlineEntry) {
        return [`${indent}• ${inlineEntry}`];
      }
      if (isRecord(entry)) {
        const summary = onboardingReportObjectSummary(entry);
        const detailLines = onboardingReportObjectDetailLines(
          entry,
          depth + 1,
          Boolean(summary),
        );
        if (summary) {
          return [`${indent}• ${summary}`, ...detailLines];
        }
        if (detailLines.length > 0) {
          const [firstLine, ...rest] = detailLines;
          return [`${indent}• ${firstLine.trim()}`, ...rest];
        }
      }
      return onboardingReportValueLines(entry, depth + 1);
    });
  }
  if (isRecord(value)) {
    const detailLines = onboardingReportObjectDetailLines(value, depth);
    if (detailLines.length > 0) {
      return detailLines;
    }
    const summary = onboardingReportObjectSummary(value);
    if (summary) {
      return [`${indent}${summary}`];
    }
  }
  return [];
}

function onboardingReportMarkdown(
  report: Record<string, unknown> | null,
): string {
  if (!report) {
    return "";
  }
  for (const key of ONBOARDING_REPORT_MARKDOWN_KEYS) {
    const candidate = report[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const summary =
    typeof report.summary === "string" ? report.summary.trim() : "";
  const sections = onboardingReportEntries(report)
    .map((entry) => {
      const body = entry.lines
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return "";
          }
          const depth = Math.max(Math.floor((line.length - line.trimStart().length) / 2), 0);
          const normalized = trimmed.startsWith("• ")
            ? `- ${trimmed.slice(2)}`
            : `- ${trimmed}`;
          return `${"  ".repeat(depth)}${normalized}`;
        })
        .filter(Boolean)
        .join("\n");
      return body ? `## ${entry.label}\n${body}` : "";
    })
    .filter(Boolean);
  return [summary, ...sections].filter(Boolean).join("\n\n").trim();
}

function onboardingReportEntries(report: Record<string, unknown> | null): Array<{
  key: string;
  label: string;
  lines: string[];
}> {
  if (!report) {
    return [];
  }
  return Object.entries(report)
    .filter(([key]) => !ONBOARDING_REPORT_HIDDEN_DETAIL_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      label: onboardingReportFieldLabel(key),
      lines: onboardingReportValueLines(value),
    }))
    .filter((entry) => entry.lines.length > 0);
}

type OnboardingAlignmentQuestionOption = {
  id: string;
  label: string;
  description: string;
  answerText: string;
  recommended: boolean;
};

type OnboardingAlignmentQuestionCard = {
  id: string;
  title: string;
  prompt: string;
  details: string;
  allowNotes: boolean;
  notesPlaceholder: string;
  allowFreeform: boolean;
  freeformPlaceholder: string;
  options: OnboardingAlignmentQuestionOption[];
};

type OnboardingAlignmentQuestion = {
  title: string;
  details: string;
  questions: OnboardingAlignmentQuestionCard[];
};

type OnboardingAlignmentQuestionDraft = {
  optionId: string;
  responseText: string;
  notes: string;
};

function emptyOnboardingAlignmentQuestionDraft(): OnboardingAlignmentQuestionDraft {
  return {
    optionId: "",
    responseText: "",
    notes: "",
  };
}

function onboardingAlignmentQuestionIsAnswered(
  draft: OnboardingAlignmentQuestionDraft | undefined,
) {
  if (!draft) {
    return false;
  }
  return Boolean(draft.optionId.trim() || draft.responseText.trim());
}

function parseOnboardingAlignmentQuestion(
  value: unknown,
): OnboardingAlignmentQuestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const rootTitle = typeof value.title === "string" ? value.title.trim() : "";
  const rootDetails =
    typeof value.details === "string" ? value.details.trim() : "";
  const sourceQuestions =
    Array.isArray(value.questions) && value.questions.length > 0
      ? value.questions
      : [value];
  const questions = sourceQuestions
    .map((item, index) => {
      if (!isRecord(item)) {
        return null;
      }
      const prompt =
        typeof item.prompt === "string" ? item.prompt.trim() : "";
      if (!prompt || !Array.isArray(item.options) || item.options.length < 2) {
        return null;
      }
      const options = item.options
        .map((optionItem, optionIndex) => {
          if (!isRecord(optionItem)) {
            return null;
          }
          const label =
            typeof optionItem.label === "string"
              ? optionItem.label.trim()
              : "";
          if (!label) {
            return null;
          }
          const id =
            typeof optionItem.id === "string" && optionItem.id.trim()
              ? optionItem.id.trim()
              : `option_${optionIndex + 1}`;
          return {
            id,
            label,
            description:
              typeof optionItem.description === "string"
                ? optionItem.description.trim()
                : "",
            answerText:
              typeof optionItem.answer_text === "string" &&
              optionItem.answer_text.trim()
                ? optionItem.answer_text.trim()
                : label,
            recommended: optionItem.recommended === true,
          } satisfies OnboardingAlignmentQuestionOption;
        })
        .filter(
          (option): option is OnboardingAlignmentQuestionOption =>
            option !== null,
        );
      if (options.length < 2) {
        return null;
      }
      return {
        id:
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : `question_${index + 1}`,
        title:
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : sourceQuestions.length === 1
              ? rootTitle
              : `Question ${index + 1}`,
        prompt,
        details:
          typeof item.details === "string" && item.details.trim()
            ? item.details.trim()
            : "",
        allowNotes: item.allow_notes === true,
        notesPlaceholder:
          typeof item.notes_placeholder === "string" &&
          item.notes_placeholder.trim()
            ? item.notes_placeholder.trim()
            : "Additional context for the onboarding agent",
        allowFreeform: item.allow_freeform !== false,
        freeformPlaceholder:
          typeof item.freeform_placeholder === "string" &&
          item.freeform_placeholder.trim()
            ? item.freeform_placeholder.trim()
            : "Answer in your own words",
        options,
      } satisfies OnboardingAlignmentQuestionCard;
    })
    .filter(
      (question): question is OnboardingAlignmentQuestionCard =>
        question !== null,
    );
  if (questions.length === 0) {
    return null;
  }
  return {
    title: rootTitle,
    details: sourceQuestions.length > 1 ? rootDetails : "",
    questions,
  };
}

function optionalHistoryLoadErrorMessage(label: string, error: unknown) {
  return `${label} unavailable: ${normalizeErrorMessage(error)}`;
}

function serializedOnboardingQuestionKey(value: unknown) {
  try {
    return JSON.stringify(value ?? null) || "null";
  } catch {
    return "null";
  }
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
    (message.outputs?.length ?? 0) > 0
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
  knownAssistantInputIds?: Set<string>;
  showExecutionInternals: boolean;
  showBootstrapPhaseTrace?: boolean;
}): ChatMessage[] {
  const outputEventsByInputId = new Map<
    string,
    SessionOutputEventPayload[]
  >();
  const outputsByInputId = new Map<string, WorkspaceOutputRecordPayload[]>();
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
            {
              showBootstrapPhaseTrace: params.showBootstrapPhaseTrace,
            },
          );
          const turnOutputs = sortOutputs(outputsByInputId.get(inputId) ?? []);
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
          if (turnOutputs.length > 0) {
            nextMessage.outputs = turnOutputs;
          }
          if (restoredAssistantState.pendingIntegrations) {
            nextMessage.pendingIntegrations = restoredAssistantState.pendingIntegrations;
          }
          if (restoredAssistantState.proposedIntegrations) {
            nextMessage.proposedIntegrations = restoredAssistantState.proposedIntegrations;
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
          {
            showBootstrapPhaseTrace: params.showBootstrapPhaseTrace,
          },
        );
        const turnOutputs = sortOutputs(outputsByInputId.get(userInputId) ?? []);
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
          pendingIntegrations: restoredAssistantState.pendingIntegrations,
          proposedIntegrations: restoredAssistantState.proposedIntegrations,
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

function isBootstrapPhaseTraceStepId(stepId: string) {
  return (
    stepId === "phase:run-claimed" || stepId === "phase:run-started"
  );
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

function parsePendingIntegrationWhoamiField(
  value: unknown,
): PendingIntegrationWhoamiField | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const candidates = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return candidates.length > 0 ? candidates : undefined;
  }
  return undefined;
}

function parsePendingIntegrationWhoami(
  value: unknown,
): PendingIntegrationWhoami | null {
  if (!isRecord(value)) return null;
  const endpoint =
    typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  if (!endpoint) return null;
  const fallbacks = Array.isArray(value.fallback_endpoints)
    ? value.fallback_endpoints
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  const rawFields = isRecord(value.fields) ? value.fields : {};
  const fields: PendingIntegrationWhoami["fields"] = {};
  const handle = parsePendingIntegrationWhoamiField(rawFields.handle);
  if (handle !== undefined) fields.handle = handle;
  const displayName = parsePendingIntegrationWhoamiField(rawFields.display_name);
  if (displayName !== undefined) fields.display_name = displayName;
  const avatarUrl = parsePendingIntegrationWhoamiField(rawFields.avatar_url);
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl;
  const email = parsePendingIntegrationWhoamiField(rawFields.email);
  if (email !== undefined) fields.email = email;
  return {
    endpoint,
    ...(fallbacks.length > 0 ? { fallback_endpoints: fallbacks } : {}),
    fields,
  };
}

function parsePendingIntegrationsList(value: unknown): ChatPendingIntegration[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ChatPendingIntegration | null => {
      if (!isRecord(entry)) return null;
      const appId = typeof entry.app_id === "string" ? entry.app_id.trim() : "";
      const provider = typeof entry.provider_id === "string" ? entry.provider_id.trim() : "";
      if (!appId || !provider) return null;
      return {
        app_id: appId,
        provider_id: provider,
        credential_source:
          typeof entry.credential_source === "string"
            ? entry.credential_source
            : null,
        whoami: parsePendingIntegrationWhoami(entry.whoami),
      };
    })
    .filter((entry): entry is ChatPendingIntegration => Boolean(entry));
}

function pendingIntegrationsFromSubagentLifecycle(
  payload: Record<string, unknown>,
): ChatPendingIntegration[] {
  const subagentPayload = isRecord(payload.subagent_payload)
    ? payload.subagent_payload
    : null;
  if (!subagentPayload) return [];
  return parsePendingIntegrationsList(subagentPayload.pending_integrations);
}

const PENDING_INTEGRATION_TOOL_NAMES = new Set([
  "workspace_apps_install",
  "workspace_apps_ensure_running",
  "workspace_apps_restart",
  "workspace_apps_restart_and_wait_ready",
  "delegate_task",
  "resume_subagent",
  "continue_subagent",
  "get_subagent",
]);

function parseProposedIntegration(value: unknown): ChatProposedIntegration | null {
  if (!isRecord(value)) return null;
  const slug =
    typeof value.toolkit_slug === "string" ? value.toolkit_slug.trim() : "";
  if (!slug) return null;
  const tier = value.tier === "hero" || value.tier === "supported" ? value.tier : undefined;
  const category = typeof value.category === "string" ? value.category : undefined;
  const reason = typeof value.reason === "string" ? value.reason : null;
  return { toolkit_slug: slug, tier, category, reason };
}

function proposedIntegrationsFromToolResult(
  payload: Record<string, unknown>,
): ChatProposedIntegration[] {
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (toolName !== "holaboss_workspace_integrations_propose_connect") return [];
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) return [];
  const result = isRecord(payload.result) ? payload.result : null;
  if (!result) return [];
  const direct = parseProposedIntegration(result.proposed_integration);
  if (direct) return [direct];
  if (isRecord(result.details)) {
    const detail = parseProposedIntegration(result.details.proposed_integration);
    if (detail) return [detail];
    if (isRecord(result.details.raw)) {
      const raw = parseProposedIntegration(result.details.raw.proposed_integration);
      if (raw) return [raw];
    }
  }
  // Capability client only sets `details.raw` when the payload was
  // compacted; for small payloads the original JSON lives inside
  // `content[0].text` instead. Walk every text part.
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes("proposed_integration")
      ) {
        try {
          const parsed = JSON.parse(part.text) as unknown;
          if (isRecord(parsed)) {
            const fromText = parseProposedIntegration(parsed.proposed_integration);
            if (fromText) return [fromText];
          }
        } catch {
          /* text wasn't JSON; ignore */
        }
      }
    }
  }
  return [];
}

function pendingIntegrationsFromToolResult(
  payload: Record<string, unknown>,
): ChatPendingIntegration[] {
  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (!PENDING_INTEGRATION_TOOL_NAMES.has(toolName)) {
    return [];
  }
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) {
    return [];
  }
  const result = isRecord(payload.result) ? payload.result : null;
  if (!result) {
    return [];
  }
  const direct = parsePendingIntegrationsList(result.pending_integrations);
  if (direct.length > 0) return direct;
  if (isRecord(result.details)) {
    const detailsDirect = parsePendingIntegrationsList(result.details.pending_integrations);
    if (detailsDirect.length > 0) return detailsDirect;
    if (isRecord(result.details.raw)) {
      const fromRaw = parsePendingIntegrationsList(result.details.raw.pending_integrations);
      if (fromRaw.length > 0) return fromRaw;
    }
  }
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes("pending_integrations")
      ) {
        const fromText = pendingIntegrationsFromTextBlob(part.text);
        if (fromText.length > 0) return fromText;
      }
    }
  }
  return [];
}

function pendingIntegrationsFromTextBlob(text: string): ChatPendingIntegration[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return [];
    const direct = parsePendingIntegrationsList(parsed.pending_integrations);
    if (direct.length > 0) return direct;
    // Subagent metadata wraps the lifecycle payload under various nesting
    // keys depending on which orchestration tool returned it. Walk a few
    // known shells before giving up.
    const candidates = [
      parsed.result_payload,
      parsed.blocking_payload,
      parsed.error_payload,
      parsed.latest_progress_payload,
      ...(Array.isArray(parsed.tasks) ? parsed.tasks : []),
    ];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const list = parsePendingIntegrationsList(candidate.pending_integrations);
      if (list.length > 0) return list;
    }
  } catch {
    // not JSON — caller decides whether to try other content parts
  }
  return [];
}

function assistantHistoryStateFromOutputEvents(
  outputEvents: SessionOutputEventPayload[],
  options?: {
    showBootstrapPhaseTrace?: boolean;
  },
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
  const pendingIntegrations: ChatPendingIntegration[] = [];
  const proposedIntegrations: ChatProposedIntegration[] = [];

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

  const hasAssistantOutput = () =>
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
      if (
        isBootstrapPhaseTraceStepId(phaseStep.id) &&
        options?.showBootstrapPhaseTrace !== true
      ) {
        continue;
      }
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

    if (event.event_type === "tool_call") {
      for (const integration of pendingIntegrationsFromToolResult(eventPayload)) {
        const key = integration.provider_id.trim().toLowerCase();
        if (!pendingIntegrations.some((existing) => existing.provider_id.trim().toLowerCase() === key)) {
          pendingIntegrations.push(integration);
        }
      }
      for (const proposal of proposedIntegrationsFromToolResult(eventPayload)) {
        const key = proposal.toolkit_slug.trim().toLowerCase();
        if (!proposedIntegrations.some((existing) => existing.toolkit_slug.trim().toLowerCase() === key)) {
          proposedIntegrations.push(proposal);
        }
      }
    }

    if (event.event_type === "subagent_lifecycle_update") {
      for (const integration of pendingIntegrationsFromSubagentLifecycle(eventPayload)) {
        const key = integration.provider_id.trim().toLowerCase();
        if (!pendingIntegrations.some((existing) => existing.provider_id.trim().toLowerCase() === key)) {
          pendingIntegrations.push(integration);
        }
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
      if (!hasAssistantOutput()) {
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
    pendingIntegrations: pendingIntegrations.length > 0 ? pendingIntegrations : undefined,
    proposedIntegrations: proposedIntegrations.length > 0 ? proposedIntegrations : undefined,
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

function ChatScheduleEditContextCard({
  job,
  onDismiss,
}: {
  job: CronjobRecordPayload;
  onDismiss?: () => void;
}) {
  const title = job.name?.trim() || job.description?.trim() || "Schedule";
  const instruction = job.instruction?.trim() ?? "";
  return (
    <div className="flex items-start gap-2 rounded-xl bg-fg-2/60 px-3 py-2 text-sm">
      <Clock3 className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">Editing</span>
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {!job.enabled ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              · paused
            </span>
          ) : null}
        </div>
        {instruction ? (
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
            {instruction}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss schedule context"
          onClick={onDismiss}
          className="-mr-1 -mt-0.5 size-5 text-muted-foreground/60 hover:text-foreground"
        >
          <X size={12} />
        </Button>
      ) : null}
    </div>
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
  /** When provided, image-attachment clicks delegate to the shell instead
   *  of opening the in-pane modal. Used by the new shell to route into a
   *  center-pane tab so the native BrowserView naturally suspends. */
  onPreviewImageAttachment?: (attachment: AttachmentListItem) => void;
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
  onOpenMeetingMode?: () => void;
  meetingModeBusy?: boolean;
  meetingModeError?: string;
  onOpenInbox?: () => void;
  inboxUnreadCount?: number;
  onOpenAutomations?: () => void;
  onOpenArtifacts?: () => void;
  composerDraftText?: string;
  onComposerDraftTextChange?: (text: string) => void;
  /** Schedule the user is currently editing — when set, ChatPane shows a
   *  context card above the composer with the schedule's full details
   *  (cron, instruction, description). Cleared on send / dismiss. */
  scheduleEditContext?: CronjobRecordPayload | null;
  onScheduleEditContextDismiss?: () => void;
  /** True while the outer pane is mid-width-transition. When set,
   *  ChatPane freezes its inner content column to its pre-transition
   *  width so message text doesn't re-wrap during the animation —
   *  re-wrap is the source of the "messages drift up" motion. */
  isPaneAnimating?: boolean;
}

export function ChatPane({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  onPreviewImageAttachment,
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
  onOpenArtifacts,
  composerDraftText = "",
  onComposerDraftTextChange,
  scheduleEditContext = null,
  onScheduleEditContextDismiss,
  isPaneAnimating = false,
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
    workspaceErrorMessage,
    refreshWorkspaceData,
    installedApps,
  } = useWorkspaceDesktop();

  // Recursive list of workspace files for the `@` picker. The walk
  // (and its limits) live in `@/lib/workspaceFiles` so other surfaces
  // can reuse it.
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>(
    [],
  );
  useEffect(() => {
    const workspaceId = selectedWorkspace?.id;
    if (!workspaceId) {
      setWorkspaceFiles([]);
      return;
    }
    const controller = new AbortController();
    void listWorkspaceFiles(workspaceId, { signal: controller.signal })
      .then((entries) => {
        if (!controller.signal.aborted) setWorkspaceFiles(entries);
      })
      .catch(() => {
        if (!controller.signal.aborted) setWorkspaceFiles([]);
      });
    return () => {
      controller.abort();
    };
  }, [selectedWorkspace?.id]);

  // `@` references content WITHIN the current workspace — files at
  // any depth + installed apps. Future kinds (sessions, memories,
  // skills) plug into the same array. Cross-workspace navigation is
  // a different affordance (the workspace switcher in TopTabsBar).
  const composerMentionableItems = useMemo<ChatComposerMentionItem[]>(() => {
    const items: ChatComposerMentionItem[] = [];

    // Files first — typically the more frequent reference target.
    for (const entry of workspaceFiles) {
      // Slugify each path segment so the inserted token round-trips
      // through findActiveMentionRange. Unicode letters / digits are
      // preserved so CJK-named files (e.g. `产品方案.md`) survive
      // round-trip; only true non-letter characters get stripped.
      const handle = entry.relativePath
        .split("/")
        .map((segment) =>
          segment
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\p{L}\p{N}_.\-]/gu, ""),
        )
        .filter(Boolean)
        .join("/");
      if (!handle) continue;
      items.push({
        id: `file:${entry.relativePath}`,
        handle,
        label: entry.relativePath,
        kindIcon: <FileIcon className="size-3.5" />,
        keywords: [entry.name, entry.relativePath, handle],
      });
    }

    // Apps next.
    if (Array.isArray(installedApps)) {
      for (const app of installedApps) {
        const trimmedLabel = app.label.trim() || app.id;
        const handle = app.id.toLowerCase().replace(/[^a-z0-9_.\-]/g, "");
        items.push({
          id: `app:${app.id}`,
          handle: handle || app.id,
          label: trimmedLabel,
          keywords: [trimmedLabel, app.id, handle].filter(Boolean),
        });
      }
    }

    return items;
  }, [installedApps, workspaceFiles]);

  // handle → workspace-file entry map. Built from the same slug logic
  // as composerMentionableItems above so a `@<handle>` typed by the
  // user resolves cleanly to the file's absolute path at send time.
  // Used for the auto-attach-on-send pipeline below — without this,
  // mention tokens flow to the agent as plain text that may or may
  // not be picked up by file-read tools.
  const mentionableFilesByHandle = useMemo(() => {
    const byHandle = new Map<string, WorkspaceFileEntry>();
    for (const entry of workspaceFiles) {
      const handle = entry.relativePath
        .split("/")
        .map((segment) =>
          segment
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\p{L}\p{N}_.\-]/gu, ""),
        )
        .filter(Boolean)
        .join("/");
      if (!handle) continue;
      byHandle.set(handle, entry);
    }
    return byHandle;
  }, [workspaceFiles]);

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
  const [pendingIntegrationsWait, setPendingIntegrationsWait] = useState<
    { unresolvedSlugs: string[] } | null
  >(null);
  const [backgroundDeliveryStatusMessage, setBackgroundDeliveryStatusMessage] =
    useState("");
  const [attachmentGateMessage, setAttachmentGateMessage] = useState("");
  const [onboardingReviewAction, setOnboardingReviewAction] = useState<
    | "approve_alignment"
    | "revise_alignment"
    | "accept_verification"
    | "revise_verification"
    | null
  >(null);
  const [onboardingReviewActionError, setOnboardingReviewActionError] =
    useState("");
  const [onboardingQuestionAction, setOnboardingQuestionAction] = useState<
    string | null
  >(null);
  const [onboardingQuestionError, setOnboardingQuestionError] = useState("");
  const [onboardingQuestionSlideIndex, setOnboardingQuestionSlideIndex] =
    useState(0);
  const [onboardingQuestionDrafts, setOnboardingQuestionDrafts] = useState<
    Record<string, OnboardingAlignmentQuestionDraft>
  >({});
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
  const [queuedSessionInputs, setQueuedSessionInputs] = useState<
    QueuedSessionInput[]
  >([]);
  const [pendingOptimisticUserMessages, setPendingOptimisticUserMessages] =
    useState<PendingOptimisticUserMessage[]>([]);
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
  const onboardingQuestionTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerBlockRef = useRef<HTMLDivElement>(null);
  // When the outer pane is mid-width-transition, freeze the inner
  // content column to its pre-transition pixel width so message text
  // doesn't re-wrap mid-animation. Re-wrap is what makes messages
  // appear to drift up as content height shrinks under a wider column.
  const [frozenColumnWidth, setFrozenColumnWidth] = useState<number | null>(
    null,
  );
  const composerIsComposingRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  // When a prefill arrives (e.g. routing back from Automations), the
  // session may still be loading history. We can't scroll to bottom
  // immediately because scrollHeight is wrong. Mark the scroll as
  // pending and consume it once history settles + messages render.
  const pendingPrefillBottomScrollRef = useRef(false);
  const pendingPrefillFrame1Ref = useRef(0);
  const pendingPrefillFrame2Ref = useRef(0);
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
  const isEmbeddedVariant = variant === "embedded";
  const pendingFocusRequestKeyRef = useRef<number | null>(focusRequestKey);
  const pendingOnboardingComposerFocusRef = useRef(false);
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
  const skeletonMinDisplayTimeoutRef = useRef<number | null>(null);
  const skeletonStartedAtRef = useRef(0);
  const skeletonGenerationRef = useRef(0);
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

  function beginHistoryLoadSkeleton(): number {
    if (skeletonMinDisplayTimeoutRef.current !== null) {
      clearTimeout(skeletonMinDisplayTimeoutRef.current);
      skeletonMinDisplayTimeoutRef.current = null;
    }
    skeletonGenerationRef.current += 1;
    const generation = skeletonGenerationRef.current;
    skeletonStartedAtRef.current = performance.now();
    setIsLoadingHistory(true);
    return generation;
  }

  function endHistoryLoadSkeleton(generation: number) {
    if (generation !== skeletonGenerationRef.current) {
      return;
    }
    const elapsed = performance.now() - skeletonStartedAtRef.current;
    const remaining = SKELETON_MIN_DISPLAY_MS - elapsed;
    if (remaining <= 0) {
      setIsLoadingHistory(false);
      return;
    }
    skeletonMinDisplayTimeoutRef.current = window.setTimeout(() => {
      skeletonMinDisplayTimeoutRef.current = null;
      if (generation === skeletonGenerationRef.current) {
        setIsLoadingHistory(false);
      }
    }, remaining);
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
    knownAssistantInputIds: Set<string> = new Set(),
  ): ChatMessage[] {
    return chatMessagesFromSessionState({
      historyMessages,
      outputEvents,
      outputs,
      knownAssistantInputIds,
      showExecutionInternals:
        shouldShowExecutionInternalsForSession(sessionId),
      showBootstrapPhaseTrace:
        shouldShowBootstrapPhaseTraceForSession(sessionId),
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
        renderedMessages: historyMessagesFromSessionState(
          params.sessionId,
          historyMessages,
          [],
          [],
          options?.knownAssistantInputIds,
        ),
      };
    }

    const auxiliaryHistoryWarnings: string[] = [];
    const artifactResponses = await Promise.all(
      assistantInputIds.map(async (inputId) => {
        const [outputEventsResult, outputListResult] = await Promise.allSettled([
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
        return {
          outputEvents:
            outputEventsResult.status === "fulfilled"
              ? outputEventsResult.value.items
              : [],
          outputs:
            outputListResult.status === "fulfilled"
              ? outputListResult.value.items
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

    return {
      history,
      historyMessages,
      warnings: auxiliaryHistoryWarnings,
      outputEvents,
      outputs,
      renderedMessages: historyMessagesFromSessionState(
        params.sessionId,
        historyMessages,
        outputEvents,
        outputs,
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
    void sessionId;
    return true;
  }

  function shouldShowBootstrapPhaseTraceForSession(
    sessionId: string | null | undefined,
  ) {
    void sessionId;
    return false;
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

  useEffect(
    () => () => {
      if (skeletonMinDisplayTimeoutRef.current !== null) {
        clearTimeout(skeletonMinDisplayTimeoutRef.current);
        skeletonMinDisplayTimeoutRef.current = null;
      }
    },
    [],
  );

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
      // While a prefill bottom-scroll is in flight ChatPane has
      // remounted with scrollTop=0 (cold mount from a sibling
      // agentView), so any smooth animation toward the moving target
      // gets interrupted by late renders and strands the list midway.
      // Force instant snaps until the prefill consumer clears.
      behavior:
        isResponding ||
        isHistoryViewportPending ||
        pendingPrefillBottomScrollRef.current
          ? "auto"
          : "smooth",
    });
  }, [
    isHistoryViewportPending,
    isResponding,
    liveAssistantSegments,
    liveAssistantText,
    liveExecutionItems,
    messages,
  ]);

  // Consume the pending-prefill bottom-scroll once history has settled.
  // ChatPane mounts cold from a sibling agentView (Automations / Inbox /
  // Sessions) with scrollTop=0; without an explicit snap the user sees
  // the list animate from top toward the latest turn and stop wherever
  // a late render interrupted it. Snap on the load-settled transition
  // and retry across a couple frames in case sessionOutputs /
  // executionItems land after isLoadingHistory has flipped false.
  useEffect(() => {
    if (!pendingPrefillBottomScrollRef.current || isLoadingHistory) {
      return;
    }
    const snap = () => {
      const target = messagesRef.current;
      if (!target || hasActiveChatSelection(target)) {
        return;
      }
      target.scrollTo({ top: target.scrollHeight, behavior: "auto" });
    };
    snap();
    const f1 = requestAnimationFrame(() => {
      snap();
      const f2 = requestAnimationFrame(snap);
      pendingPrefillFrame2Ref.current = f2;
    });
    pendingPrefillFrame1Ref.current = f1;
    const settleTimer = window.setTimeout(() => {
      snap();
      pendingPrefillBottomScrollRef.current = false;
    }, 240);
    return () => {
      cancelAnimationFrame(pendingPrefillFrame1Ref.current);
      cancelAnimationFrame(pendingPrefillFrame2Ref.current);
      window.clearTimeout(settleTimer);
    };
  }, [isLoadingHistory, messages]);

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
    // Routing back into chat (e.g. clicking Edit on a schedule)
    // doesn't change `messages` so the existing autoscroll effect
    // never fires. History may also still be loading when this
    // effect runs, so a synchronous scrollTo would target an
    // incomplete container. Mark the scroll as pending; the
    // effect below consumes it once isLoadingHistory settles and
    // messages have rendered.
    shouldAutoScrollRef.current = true;
    pendingPrefillBottomScrollRef.current = true;
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

  const selectedWorkspaceAlignmentQuestionKey =
    serializedOnboardingQuestionKey(selectedWorkspace?.alignment_question);

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
      const skeletonGeneration = beginHistoryLoadSkeleton();
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

        const workspaceOnboardingSessionId = (
          selectedWorkspace?.onboarding_session_id || ""
        ).trim();
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
          (isOnboardingVariant ? workspaceOnboardingSessionId : "") ||
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
          endHistoryLoadSkeleton(skeletonGeneration);
        }
      }
    }

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [
    isOnboardingVariant,
    selectedWorkspaceAlignmentQuestionKey,
    selectedWorkspace?.onboarding_state,
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
      const skeletonGeneration = beginHistoryLoadSkeleton();
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
          endHistoryLoadSkeleton(skeletonGeneration);
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

        if (eventType === "waiting_on_pending_integrations") {
          const rawUnresolved = eventPayload.unresolved_slugs;
          const unresolvedSlugs = Array.isArray(rawUnresolved)
            ? rawUnresolved.filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0)
            : [];
          setPendingIntegrationsWait({ unresolvedSlugs });
          setIsResponding(false);
          return;
        }
        if (eventType === "run_started" || eventType === "assistant_text") {
          // Agent picked the input back up — clear the paused banner.
          setPendingIntegrationsWait(null);
        }

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
          if (
            !isBootstrapPhaseTraceStepId(phaseStep.id) ||
            shouldShowBootstrapPhaseTraceForSession(eventSessionId)
          ) {
            upsertLiveTraceStep(phaseStep);
          }
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
          if (fileDisplayTarget && !activeSessionReadOnlyRef.current) {
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
        workspaceBlockingReason ||
          workspaceErrorMessage ||
          "Workspace apps are still starting.",
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
        trackUmamiEvent("agent_session_started", {
          workspace_id: selectedWorkspace.id,
        });
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
    trackUmamiEvent("agent_message_sent", {
      workspace_id: selectedWorkspace?.id ?? null,
      has_attachments: pendingAttachments.length > 0,
      attachment_count: pendingAttachments.length,
      message_length: trimmed.length,
      queued_onto_active_run: queueOntoActiveRun,
    });

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
      const stagedExplicitAttachments = attachmentEntries.map((entry) => {
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

      // Auto-attach mentioned workspace files. Without this the agent
      // only sees the plain `@<handle>` token in the message text and
      // has to guess whether to read the file with its own tools.
      // Scan the user's text for mention handles, resolve each to a
      // workspace file we already know about, dedupe against any
      // explicit attachments, and stage as workspace-file attachments.
      const explicitAbsolutePaths = new Set(
        explorerFiles.map((entry) => entry.absolutePath),
      );
      const mentionedFileEntries: WorkspaceFileEntry[] = [];
      const seenHandles = new Set<string>();
      for (const match of trimmed.matchAll(MENTION_TOKEN_PATTERN)) {
        const handle = match[2];
        if (!handle || seenHandles.has(handle)) continue;
        seenHandles.add(handle);
        const fileEntry = mentionableFilesByHandle.get(handle);
        if (!fileEntry) continue;
        if (explicitAbsolutePaths.has(fileEntry.absolutePath)) continue;
        mentionedFileEntries.push(fileEntry);
      }
      const stagedMentionAttachments =
        mentionedFileEntries.length > 0
          ? (
              await window.electronAPI.workspace.stageSessionAttachmentPaths({
                workspace_id: selectedWorkspace.id,
                files: mentionedFileEntries.map((entry) => ({
                  absolute_path: entry.absolutePath,
                  name: entry.name,
                  mime_type: null,
                  kind: "file" as const,
                })),
              })
            ).attachments
          : [];

      const stagedAttachments = [
        ...stagedExplicitAttachments,
        ...stagedMentionAttachments,
      ];

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
        setLiveAgentStatus("Working");
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

  async function handleAfterIntegrationBind() {
    const sessionId = activeSessionIdRef.current || activeSessionId;
    if (!selectedWorkspaceId || !sessionId) return;
    try {
      await window.electronAPI.workspace.queueSessionInput({
        workspace_id: selectedWorkspaceId,
        session_id: sessionId,
        text: "continue",
        image_urls: null,
        attachments: [],
        priority: 0,
        model: resolvedChatModel || null,
        thinking_value: effectiveThinkingValue,
      });
    } catch {
      /* non-fatal */
    }
  }

  async function handleAfterIntegrationProposalConnected(toolkitSlug: string) {
    const sessionId = activeSessionIdRef.current || activeSessionId;
    if (!selectedWorkspaceId || !sessionId) return;
    // Refresh the composio-mcp host so the toolkit's `<toolkit>_*` tools
    // become callable on the next turn. Best-effort; runtime also calls
    // this on the next ensure-running.
    try {
      await window.electronAPI.workspace.composioMcpEnsureRunning(selectedWorkspaceId);
    } catch {
      /* non-fatal */
    }
    try {
      await window.electronAPI.workspace.queueSessionInput({
        workspace_id: selectedWorkspaceId,
        session_id: sessionId,
        text: `[system] ${toolkitSlug} is now connected. You can call its tools.`,
        image_urls: null,
        attachments: [],
        priority: 0,
        model: resolvedChatModel || null,
        thinking_value: effectiveThinkingValue,
      });
    } catch {
      /* non-fatal */
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

  async function cancelQueuedSessionInputItem(item: QueuedSessionInput) {
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
      const updatedEntries = currentEntries.filter(
        (_entry, index) => index !== previewIndex,
      );
      setQueuedSessionInputPreviewState(updatedEntries);
      return;
    }

    if (item.status !== "queued") {
      throw new Error("Only queued messages can be cancelled.");
    }

    await window.electronAPI.workspace.cancelQueuedSessionInput({
      workspace_id: item.workspaceId,
      session_id: item.sessionId,
      input_id: item.inputId,
    });

    setQueuedSessionInputs((current) =>
      current.filter(
        (currentItem) =>
          !(
            currentItem.inputId === item.inputId &&
            currentItem.sessionId === item.sessionId &&
            currentItem.workspaceId === item.workspaceId
          ),
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
    // Schedule-edit context is one-shot: keep it visible while the user is
    // composing the edit, but clear it once they actually send so the next
    // message in the same session isn't anchored to a stale schedule.
    if (scheduleEditContext) {
      onScheduleEditContextDismiss?.();
    }
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
  const showSessionExecutionInternals = shouldShowExecutionInternalsForSession(
    activeSessionId,
  );
  const renderedLiveAssistantSegments = liveAssistantSegmentsForRender(
    liveAssistantSegments,
    liveExecutionItems,
    liveAssistantText,
  );
  const hasVisibleLiveAssistantContent =
    renderedLiveAssistantSegments.length > 0;
  const showLiveAssistantTurn = isResponding || hasVisibleLiveAssistantContent;
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

    if (onPreviewImageAttachment) {
      onPreviewImageAttachment(attachment);
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
        workspaceErrorMessage ||
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
  const runtimeDefaultModel =
    runtimeConfig?.defaultModel?.trim() || DEFAULT_RUNTIME_MODEL;
  const requiresModelProviderSetup =
    !hasConfiguredProviderCatalog && !holabossProxyModelsAvailable;
  const runtimeDefaultModelAvailable =
    !requiresModelProviderSetup &&
    (hasConfiguredProviderCatalog
      ? visibleConfiguredProviderModelGroups.some((providerGroup) =>
          providerGroup.models.some(
            (model) => model.token.trim() === runtimeDefaultModel,
          ),
        )
      : holabossProxyModelsAvailable ||
        !isHolabossProxyModel(runtimeDefaultModel));
  const availableChatModelOptionGroups: ChatModelOptionGroup[] =
    hasConfiguredProviderCatalog
      ? visibleConfiguredProviderModelGroups.map((providerGroup) => ({
          label: providerGroup.providerLabel,
          options: providerGroup.models.map((model) => {
            const modelLabel = runtimeModelDisplayLabel(model);
            return {
              value: model.token,
              label: modelLabel,
              selectedLabel: modelLabel,
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
    ? normalizedModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : normalizedModelPreference.length > 0 &&
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
    ? effectiveChatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
        ? runtimeDefaultModel
        : availableChatModelOptions[0]?.value || ""
      : effectiveChatModelPreference
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
  const onboardingFlowState = isOnboardingVariant
    ? (selectedWorkspace?.onboarding_state || "").trim().toLowerCase()
    : "";
  const alignmentQuestion = parseOnboardingAlignmentQuestion(
    selectedWorkspace?.alignment_question,
  );
  const alignmentQuestionItems = alignmentQuestion?.questions ?? [];
  const alignmentQuestionCount = alignmentQuestionItems.length;
  const safeOnboardingQuestionSlideIndex =
    alignmentQuestionCount > 0
      ? Math.min(onboardingQuestionSlideIndex, alignmentQuestionCount - 1)
      : 0;
  const activeAlignmentQuestion =
    alignmentQuestionItems[safeOnboardingQuestionSlideIndex] ?? null;
  const activeAlignmentQuestionDraft = activeAlignmentQuestion
    ? onboardingQuestionDrafts[activeAlignmentQuestion.id] ??
      emptyOnboardingAlignmentQuestionDraft()
    : emptyOnboardingAlignmentQuestionDraft();
  const answeredAlignmentQuestionCount = alignmentQuestionItems.filter((question) =>
    onboardingAlignmentQuestionIsAnswered(onboardingQuestionDrafts[question.id]),
  ).length;
  const unansweredAlignmentQuestionCount = Math.max(
    alignmentQuestionCount - answeredAlignmentQuestionCount,
    0,
  );
  const alignmentQuestionSignature = alignmentQuestionItems
    .map((question) => question.id)
    .join("|");
  const alignmentReport = isRecord(selectedWorkspace?.alignment_report)
    ? selectedWorkspace.alignment_report
    : null;
  const verificationReport = isRecord(selectedWorkspace?.verification_report)
    ? selectedWorkspace.verification_report
    : null;
  const alignmentReportSummary =
    typeof alignmentReport?.summary === "string"
      ? alignmentReport.summary.trim()
      : "";
  const alignmentReportMarkdown = useMemo(
    () => onboardingReportMarkdown(alignmentReport),
    [alignmentReport],
  );
  const verificationReportSummary =
    typeof verificationReport?.summary === "string"
      ? verificationReport.summary.trim()
      : "";
  const verificationReportMarkdown = useMemo(
    () => onboardingReportMarkdown(verificationReport),
    [verificationReport],
  );
  const alignmentReportDetails = useMemo(
    () => onboardingReportEntries(alignmentReport),
    [alignmentReport],
  );
  const verificationReportDetails = useMemo(
    () => onboardingReportEntries(verificationReport),
    [verificationReport],
  );
  const onboardingImplementingDisabledReason =
    onboardingFlowState === "implementing"
      ? "Onboarding is implementing the approved alignment. Wait for verification before sending another message."
      : "";
  const onboardingReviewDisabledReason =
    onboardingFlowState === "aligning" && alignmentQuestion
      ? "Answer the inline alignment question before sending another message."
      : onboardingFlowState === "awaiting_alignment_approval"
        ? "Review the alignment report and use the inline actions before sending another message."
        : onboardingFlowState === "awaiting_verification_acceptance"
          ? "Review the verification report and use the inline actions before sending another message."
          : "";
  const readOnlyInspectionDisabledReason = isReadOnlyInspectionSession
    ? isOnboardingVariant
      ? "Inspection sessions are read-only. Return to the onboarding session to continue the conversation."
      : "Inspection sessions are read-only. Return to the main session to continue the conversation."
    : "";
  const composerBaseDisabledReason =
    readOnlyInspectionDisabledReason ||
    baseComposerDisabledReason ||
    onboardingReviewDisabledReason ||
    onboardingImplementingDisabledReason ||
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
  const creditWarningSeverity = showOutOfCreditsWarning
    ? "out"
    : showLowBalanceWarning
      ? "low"
      : null;
  const onboardingQuestionActionsDisabled =
    isReadOnlyInspectionSession || onboardingQuestionAction !== null;
  const onboardingReviewActionsDisabled =
    isReadOnlyInspectionSession || onboardingReviewAction !== null;
  const alignmentReviewCardVisible =
    isOnboardingVariant &&
    onboardingFlowState === "awaiting_alignment_approval" &&
    alignmentReport !== null;
  const alignmentQuestionCardVisible =
    isOnboardingVariant &&
    onboardingFlowState === "aligning" &&
    alignmentQuestion !== null;
  const verificationReviewCardVisible =
    isOnboardingVariant &&
    onboardingFlowState === "awaiting_verification_acceptance" &&
    verificationReport !== null;
  const onboardingComposerTakeoverVisible =
    alignmentQuestionCardVisible ||
    alignmentReviewCardVisible ||
    verificationReviewCardVisible;
  const runOnboardingReviewAction = useCallback(
    async (
      action:
        | "approve_alignment"
        | "revise_alignment"
        | "accept_verification"
        | "revise_verification",
    ) => {
      const workspaceId = (selectedWorkspace?.id || "").trim();
      if (!workspaceId) {
        return;
      }
      setOnboardingReviewAction(action);
      setOnboardingReviewActionError("");
      let mutated = false;
      try {
        if (action === "approve_alignment") {
          await window.electronAPI.workspace.approveOnboardingAlignment(
            workspaceId,
          );
        } else if (action === "revise_alignment") {
          await window.electronAPI.workspace.requestOnboardingAlignmentRevision(
            workspaceId,
          );
        } else if (action === "revise_verification") {
          await window.electronAPI.workspace.requestOnboardingVerificationRevision(
            workspaceId,
          );
        } else {
          await window.electronAPI.workspace.completeOnboarding(workspaceId, {
            summary:
              verificationReportSummary ||
              "Workspace onboarding accepted by the user.",
            requestedBy: "workspace_user",
          });
        }
        mutated = true;
      } catch (error) {
        setOnboardingReviewActionError(normalizeErrorMessage(error));
      } finally {
        setOnboardingReviewAction(null);
        if (mutated) {
          if (
            action === "revise_alignment" ||
            action === "revise_verification"
          ) {
            pendingOnboardingComposerFocusRef.current = true;
          }
          void refreshWorkspaceData().catch(() => undefined);
        }
      }
    },
    [refreshWorkspaceData, selectedWorkspace?.id, verificationReportSummary],
  );
  const answerOnboardingAlignmentQuestion = useCallback(
    async () => {
      const workspaceId = (selectedWorkspace?.id || "").trim();
      if (!workspaceId || alignmentQuestionItems.length === 0) {
        return;
      }
      const isLastAlignmentQuestion =
        safeOnboardingQuestionSlideIndex >= alignmentQuestionCount - 1;
      const currentAnswerPresent = Boolean(
        activeAlignmentQuestionDraft.optionId.trim() ||
          activeAlignmentQuestionDraft.responseText.trim(),
      );
      if (!isLastAlignmentQuestion) {
        if (!currentAnswerPresent) {
          setOnboardingQuestionError(
            "Answer this alignment question before continuing.",
          );
          return;
        }
        setOnboardingQuestionError("");
        setOnboardingQuestionSlideIndex((current) =>
          Math.min(current + 1, alignmentQuestionCount - 1),
        );
        return;
      }
      const answers = alignmentQuestionItems.map((question) => {
        const draft =
          onboardingQuestionDrafts[question.id] ??
          emptyOnboardingAlignmentQuestionDraft();
        return {
          questionId: question.id,
          optionId: draft.optionId.trim() || null,
          responseText: draft.responseText.trim() || null,
          notes: draft.notes.trim() || null,
        };
      });
      const firstUnansweredIndex = answers.findIndex(
        (answer) =>
          !((answer.optionId || "").trim() || (answer.responseText || "").trim()),
      );
      if (firstUnansweredIndex >= 0) {
        setOnboardingQuestionError("Answer each alignment question before submitting.");
        setOnboardingQuestionSlideIndex(firstUnansweredIndex);
        return;
      }
      setOnboardingQuestionAction("submit");
      setOnboardingQuestionError("");
      let mutated = false;
      try {
        await window.electronAPI.workspace.answerOnboardingAlignmentQuestion(
          workspaceId,
          {
            model: resolvedChatModel || null,
            thinkingValue: effectiveThinkingValue,
            answers,
          },
        );
        mutated = true;
      } catch (error) {
        setOnboardingQuestionError(normalizeErrorMessage(error));
      } finally {
        setOnboardingQuestionAction(null);
        if (mutated) {
          setOnboardingQuestionDrafts({});
          setOnboardingQuestionSlideIndex(0);
          void refreshWorkspaceData().catch(() => undefined);
        }
      }
    },
    [
      activeAlignmentQuestionDraft.optionId,
      activeAlignmentQuestionDraft.responseText,
      alignmentQuestionCount,
      alignmentQuestionItems,
      onboardingQuestionDrafts,
      refreshWorkspaceData,
      resolvedChatModel,
      safeOnboardingQuestionSlideIndex,
      selectedWorkspace?.id,
      effectiveThinkingValue,
    ],
  );
  useEffect(() => {
    setOnboardingReviewActionError("");
    setOnboardingReviewAction(null);
    setOnboardingQuestionAction(null);
    setOnboardingQuestionError("");
    setOnboardingQuestionSlideIndex(0);
    setOnboardingQuestionDrafts({});
  }, [selectedWorkspaceId, onboardingFlowState, alignmentQuestionSignature]);
  const setOnboardingQuestionDraft = useCallback(
    (
      questionId: string,
      updater: (
        current: OnboardingAlignmentQuestionDraft,
      ) => OnboardingAlignmentQuestionDraft,
    ) => {
      setOnboardingQuestionDrafts((current) => {
        const previous =
          current[questionId] ?? emptyOnboardingAlignmentQuestionDraft();
        return {
          ...current,
          [questionId]: updater(previous),
        };
      });
    },
    [],
  );
  const selectOnboardingQuestionOption = useCallback(
    (
      question: OnboardingAlignmentQuestionCard,
      option: OnboardingAlignmentQuestionOption,
    ) => {
      setOnboardingQuestionError("");
      onboardingQuestionTextareaRef.current?.blur();
      setOnboardingQuestionDraft(question.id, (current) => {
        return {
          ...current,
          optionId: option.id,
          responseText: "",
        };
      });
    },
    [setOnboardingQuestionDraft],
  );
  useEffect(() => {
    if (!pendingOnboardingComposerFocusRef.current) {
      return;
    }
    if (!selectedWorkspaceId) {
      return;
    }
    if (!selectedWorkspace || isLoadingBootstrap || isLoadingHistory) {
      return;
    }
    if (onboardingComposerTakeoverVisible || composerDisabled) {
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
      pendingOnboardingComposerFocusRef.current = false;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    composerDisabled,
    isLoadingBootstrap,
    isLoadingHistory,
    onboardingComposerTakeoverVisible,
    selectedWorkspace,
    selectedWorkspaceId,
  ]);
  const onboardingReviewCardScrollable =
    alignmentReviewCardVisible || verificationReviewCardVisible;
  const onboardingComposerTakeoverPanel = onboardingComposerTakeoverVisible ? (
    <div
      className={`w-full rounded-[28px] border border-border bg-background shadow-[0_18px_44px_rgba(15,23,42,0.08)] ${
        onboardingReviewCardScrollable
          ? "chat-scrollbar-thin max-h-[76vh] overflow-y-auto"
          : ""
      }`}
    >
      {alignmentQuestionCardVisible && activeAlignmentQuestion ? (
        <div className="space-y-5 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {`Question ${safeOnboardingQuestionSlideIndex + 1}/${alignmentQuestionCount} (${unansweredAlignmentQuestionCount} unanswered)`}
              </div>
              {activeAlignmentQuestion.title || alignmentQuestion?.title ? (
                <div className="mt-1 text-[1.45rem] font-medium leading-tight text-foreground">
                  {activeAlignmentQuestion.title || alignmentQuestion?.title}
                </div>
              ) : null}
            </div>
          </div>
          <div className="space-y-2.5">
            {activeAlignmentQuestion.options.map((option) => {
              const selected = activeAlignmentQuestionDraft.optionId === option.id;
              return (
              <button
                key={option.id}
                type="button"
                className={`w-full rounded-2xl border px-4 py-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? "border-primary bg-primary/8 shadow-[0_10px_30px_rgba(15,23,42,0.05)]"
                    : "border-border bg-background/70 hover:border-primary/40 hover:bg-primary/5"
                }`}
                disabled={onboardingQuestionActionsDisabled}
                onClick={() => {
                  selectOnboardingQuestionOption(activeAlignmentQuestion, option);
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {option.label}
                    </div>
                    {option.description ? (
                      <div className="mt-1 text-sm leading-6 text-muted-foreground">
                        {option.description}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {option.recommended ? (
                      <div className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
                        Recommended
                      </div>
                    ) : null}
                    {selected ? (
                      <div className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-4" />
                      </div>
                    ) : (
                      <ArrowRight className="size-4 text-muted-foreground" />
                    )}
                  </div>
                </div>
              </button>
              );
            })}
          </div>
          {activeAlignmentQuestion.allowFreeform ? (
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Natural language response
              </div>
              <textarea
                ref={onboardingQuestionTextareaRef}
                value={activeAlignmentQuestionDraft.responseText}
                onFocus={() => {
                  setOnboardingQuestionError("");
                  setOnboardingQuestionDraft(
                    activeAlignmentQuestion.id,
                    (current) =>
                      current.optionId
                        ? {
                            ...current,
                            optionId: "",
                          }
                        : current,
                  );
                }}
                onChange={(event) => {
                  const nextResponseText = event.target.value;
                  setOnboardingQuestionError("");
                  setOnboardingQuestionDraft(
                    activeAlignmentQuestion.id,
                    (current) => ({
                      ...current,
                      optionId: nextResponseText.trim() ? "" : current.optionId,
                      responseText: nextResponseText,
                    }),
                  );
                }}
                disabled={onboardingQuestionActionsDisabled}
                placeholder={activeAlignmentQuestion.freeformPlaceholder}
                className="min-h-[120px] w-full resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          ) : null}
          {onboardingQuestionError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {onboardingQuestionError}
            </div>
          ) : null}
          {isReadOnlyInspectionSession ? (
            <div className="text-xs text-muted-foreground">
              Return to the onboarding session to answer this alignment question.
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              {alignmentQuestionCount > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    onboardingQuestionActionsDisabled ||
                    safeOnboardingQuestionSlideIndex === 0
                  }
                  onClick={() => {
                    setOnboardingQuestionError("");
                    setOnboardingQuestionSlideIndex((current) =>
                      Math.max(current - 1, 0),
                    );
                  }}
                >
                  Previous
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={onboardingQuestionActionsDisabled}
                onClick={() => {
                  void answerOnboardingAlignmentQuestion();
                }}
              >
                {onboardingQuestionAction === "submit" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {safeOnboardingQuestionSlideIndex >= alignmentQuestionCount - 1
                  ? alignmentQuestionCount > 1
                    ? "Submit answers"
                    : "Submit answer"
                  : "Submit answer"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {alignmentReviewCardVisible ? (
        <div className="space-y-4 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Alignment report
              </div>
              <div className="mt-1 text-sm font-medium text-foreground">
                Review before implementation starts
              </div>
            </div>
            <div className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
              Awaiting review
            </div>
          </div>
          {alignmentReportMarkdown ? (
            <SimpleMarkdown
              className="chat-markdown chat-assistant-markdown max-w-full text-foreground"
              onLinkClick={onOpenLinkInBrowser}
            >
              {alignmentReportMarkdown}
            </SimpleMarkdown>
          ) : (
            <>
              <div className="text-sm leading-6 text-foreground">
                {alignmentReportSummary ||
                  "The onboarding agent has converged the current workspace alignment for approval."}
              </div>
              {alignmentReportDetails.length > 0 ? (
                <div className="space-y-3">
                  {alignmentReportDetails.map((entry) => (
                    <div key={entry.key}>
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        {entry.label}
                      </div>
                      <div className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">
                        {entry.lines.map((line, index) => (
                          <div
                            key={`${entry.key}-${index}`}
                            className="whitespace-pre-wrap break-words"
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {onboardingReviewActionError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {onboardingReviewActionError}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="rounded-full"
              disabled={onboardingReviewActionsDisabled}
              onClick={() => {
                void runOnboardingReviewAction("approve_alignment");
              }}
            >
              {onboardingReviewAction === "approve_alignment" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Approve alignment
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={onboardingReviewActionsDisabled}
              onClick={() => {
                void runOnboardingReviewAction("revise_alignment");
              }}
            >
              {onboardingReviewAction === "revise_alignment" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PencilLine className="size-4" />
              )}
              Request changes
            </Button>
          </div>
          {isReadOnlyInspectionSession ? (
            <div className="text-xs text-muted-foreground">
              Return to the onboarding session to review or revise this alignment.
            </div>
          ) : null}
        </div>
      ) : null}
      {verificationReviewCardVisible ? (
        <div className="space-y-4 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Verification report
              </div>
              <div className="mt-1 text-sm font-medium text-foreground">
                Review before final merge
              </div>
            </div>
            <div className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
              Awaiting acceptance
            </div>
          </div>
          {verificationReportMarkdown ? (
            <SimpleMarkdown
              className="chat-markdown chat-assistant-markdown max-w-full text-foreground"
              onLinkClick={onOpenLinkInBrowser}
            >
              {verificationReportMarkdown}
            </SimpleMarkdown>
          ) : (
            <>
              <div className="text-sm leading-6 text-foreground">
                {verificationReportSummary ||
                  "Implementation is complete. Review the verification report before merging the lab."}
              </div>
              {verificationReportDetails.length > 0 ? (
                <div className="space-y-3">
                  {verificationReportDetails.map((entry) => (
                    <div key={entry.key}>
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        {entry.label}
                      </div>
                      <div className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">
                        {entry.lines.map((line, index) => (
                          <div
                            key={`${entry.key}-${index}`}
                            className="whitespace-pre-wrap break-words"
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {onboardingReviewActionError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {onboardingReviewActionError}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="rounded-full"
              disabled={onboardingReviewActionsDisabled}
              onClick={() => {
                void runOnboardingReviewAction("accept_verification");
              }}
            >
              {onboardingReviewAction === "accept_verification" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Accept and merge
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={onboardingReviewActionsDisabled}
              onClick={() => {
                void runOnboardingReviewAction("revise_verification");
              }}
            >
              {onboardingReviewAction === "revise_verification" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PencilLine className="size-4" />
              )}
              Request changes
            </Button>
          </div>
          {isReadOnlyInspectionSession ? (
            <div className="text-xs text-muted-foreground">
              Return to the onboarding session to accept or revise this verification.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;
  useEffect(() => {
    if (creditWarningSeverity) {
      trackUmamiEvent("credit_warning_shown", {
        severity: creditWarningSeverity,
      });
    }
  }, [creditWarningSeverity]);
  const chatPaneSentryState = useMemo(
    () => ({
      workspace_id: selectedWorkspaceId || null,
      session_id: activeSessionId || null,
      variant,
      signed_in: isSignedIn,
      workspace_ready: Boolean(selectedWorkspace) && workspaceAppsReady,
      workspace_blocking_reason: workspaceBlockingReason || null,
      workspace_error_message: workspaceErrorMessage || null,
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
      workspaceErrorMessage,
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

  // Sample the current column width synchronously when the outer pane
  // starts animating, hold that value as inline width while the
  // animation runs, then release. Reading bounding rect once per
  // transition (not per frame) keeps the freeze cheap.
  useLayoutEffect(() => {
    if (!isPaneAnimating) {
      setFrozenColumnWidth(null);
      return;
    }
    const source = messagesContentRef.current ?? composerBlockRef.current;
    if (!source) return;
    const width = Math.round(source.getBoundingClientRect().width);
    if (width > 0) {
      setFrozenColumnWidth(width);
    }
  }, [isPaneAnimating]);

  const frozenColumnStyle = useMemo(
    () =>
      frozenColumnWidth !== null
        ? ({ width: `${frozenColumnWidth}px`, maxWidth: "none" } as const)
        : undefined,
    [frozenColumnWidth],
  );

  useEffect(() => {
    if (!hasMessages) {
      setComposerBlockHeight(0);
      return;
    }

    const composerBlock = composerBlockRef.current;
    if (!composerBlock) {
      return;
    }

    // Coalesce observations into one rAF-bucketed update and bail on
    // identical heights. Outer-pane width transitions fire this observer
    // every frame; without dedup we re-render the entire chat tree
    // ~12 times per 200ms, which is the main source of jank during the
    // ChatPane ↔ WorkPane expand/collapse animation.
    let frame: number | null = null;
    const flush = (next: number) => {
      setComposerBlockHeight((prev) => (prev === next ? prev : next));
    };

    const initialHeight = Math.round(
      composerBlock.getBoundingClientRect().height,
    );
    flush(initialHeight);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentRect comes from the observer's cached layout — reading
      // it doesn't force a sync reflow the way getBoundingClientRect()
      // does inside the listener.
      const next = Math.round(entry.contentRect.height);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        flush(next);
      });
    });
    resizeObserver.observe(composerBlock);
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
    };
  }, [hasMessages]);

  const innerContent = (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      <div className="theme-chat-composer-glow pointer-events-none absolute inset-x-8 bottom-0 h-44 rounded-full blur-2xl" />

        {!isOnboardingVariant ? (
          <div className="shrink-0 px-4 py-2 sm:px-5">
            <ChatHeader
              agentName={isViewingBoundMainSession ? "Hola" : assistantLabel}
              workspace={selectedWorkspace}
              subtitle={
                isViewingBoundMainSession ? undefined : activeSessionTitle
              }
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
              onOpenArtifacts={onOpenArtifacts}
            />
          </div>
        ) : null}

        {!isOnboardingVariant && isReadOnlyInspectionSession ? (
          <div className="shrink-0 px-4 pt-2 sm:px-5">
            <div className="flex items-center justify-between gap-2 rounded-md bg-fg-4 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                Inspecting{" "}
                <span className="font-medium text-foreground">
                  {activeSessionTitle}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  void openMainSession();
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3" />
                Main session
              </Button>
            </div>
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
                  onClick={() => {
                    trackUmamiEvent("credit_topup_clicked", {
                      location: "chat_warning",
                      severity: creditWarningSeverity,
                    });
                    openExternalUrl(billingLinks?.addCreditsUrl);
                  }}
                  className="rounded-full border-primary bg-primary/10 text-primary hover:bg-primary/16"
                >
                  Add credits
                </Button>
                {showOutOfCreditsWarning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      trackUmamiEvent("billing_page_clicked", {
                        location: "chat_warning",
                      });
                      openExternalUrl(billingLinks?.billingPageUrl);
                    }}
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
        pendingIntegrationsWait ||
        verboseTelemetryEnabled ? (
          <div className="shrink-0 px-4 pt-3 sm:px-5">
            {chatErrorMessage ? (
              <div className="theme-chat-system-bubble rounded-xl border px-3 py-2 text-xs">
                {chatErrorMessage}
              </div>
            ) : null}

            {pendingIntegrationsWait ? (
              <div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">
                <span className="font-medium">Waiting for you to connect:</span>
                {" "}
                {pendingIntegrationsWait.unresolvedSlugs.length > 0
                  ? pendingIntegrationsWait.unresolvedSlugs.join(", ")
                  : "the integrations the agent proposed above"}
                . The next message resumes automatically once all are connected.
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
            <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
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
              className="chat-scrollbar-thin h-full min-h-0 overflow-x-hidden overflow-y-auto"
            >
              {hasMessages ? (
                <div
                  ref={messagesContentRef}
                  className={`mx-auto flex min-w-0 w-full ${CHAT_LAYOUT.contentMaxWidth} flex-col gap-2 pl-4 pr-7 pb-3 pt-5 ${
                    showHistoryRestoreScreen ? "invisible" : ""
                  }`}
                  style={frozenColumnStyle}
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
                    workspaceId={selectedWorkspace?.id ?? null}
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
                    onAfterIntegrationBind={handleAfterIntegrationBind}
                    onAfterIntegrationProposalConnected={
                      handleAfterIntegrationProposalConnected
                    }
                  />
                </div>
              ) : (
                <div
                  className={`mx-auto flex min-h-full w-full ${CHAT_LAYOUT.contentMaxWidth} flex-col justify-center px-4 pb-10 pt-10 sm:px-5 ${
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
                  {onboardingComposerTakeoverPanel ? (
                    <div className="w-full">{onboardingComposerTakeoverPanel}</div>
                  ) : (
                    <form onSubmit={onSubmit} className="w-full">
                      <div className="space-y-3">
                        {scheduleEditContext ? (
                          <ChatScheduleEditContextCard
                            job={scheduleEditContext}
                            onDismiss={onScheduleEditContextDismiss}
                          />
                        ) : null}
                        <QueuedSessionInputRail
                          items={displayedQueuedSessionInputs}
                          onEditItem={
                            isReadOnlyInspectionSession
                              ? undefined
                              : updateQueuedSessionInputText
                          }
                          onCancelItem={
                            isReadOnlyInspectionSession
                              ? undefined
                              : cancelQueuedSessionInputItem
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
                            mentionableItems={composerMentionableItems}
                            onRemoveQuotedSkill={removeQuotedSkill}
                            onRemoveAttachment={removePendingAttachment}
                            onPreviewAttachment={openImageAttachmentPreview}
                          />
                        </QueuedSessionInputRail>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>

            {hasMessages && isAwayFromChatBottom ? (
              <button
                aria-label="Jump to latest message"
                className="absolute bottom-3 left-1/2 z-30 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-foreground shadow-xs transition-colors hover:bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
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
              style={frozenColumnStyle}
            >
              {onboardingComposerTakeoverPanel ? (
                onboardingComposerTakeoverPanel
              ) : (
                <form onSubmit={onSubmit} className="w-full">
                  <div className="space-y-3">
                    {scheduleEditContext ? (
                      <ChatScheduleEditContextCard
                        job={scheduleEditContext}
                        onDismiss={onScheduleEditContextDismiss}
                      />
                    ) : null}
                    <QueuedSessionInputRail
                      items={displayedQueuedSessionInputs}
                      onEditItem={
                        isReadOnlyInspectionSession
                          ? undefined
                          : updateQueuedSessionInputText
                      }
                      onCancelItem={
                        isReadOnlyInspectionSession
                          ? undefined
                          : cancelQueuedSessionInputItem
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
                        mentionableItems={composerMentionableItems}
                        onRemoveQuotedSkill={removeQuotedSkill}
                        onRemoveAttachment={removePendingAttachment}
                        onPreviewAttachment={openImageAttachmentPreview}
                      />
                    </QueuedSessionInputRail>
                  </div>
                </form>
              )}
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
  );

  if (isEmbeddedVariant) {
    return (
      <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden">
        {innerContent}
      </div>
    );
  }

  return (
    <PaneCard
      className={isOnboardingVariant ? "w-full border-primary/20" : "w-full"}
    >
      {innerContent}
    </PaneCard>
  );
}
