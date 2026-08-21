import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  Fragment,
  FormEvent,
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
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  CornerDownLeft,
  Copy,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
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
  RotateCcw,
  Search,
  Sparkles,
  Wand2,
  Zap,
  Square,
  Waypoints,
  X,
} from "@/components/ui/icons";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { RuntimeContextBar } from "@/components/harness/RuntimeContextBar";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PaneCard } from "@/components/ui/PaneCard";
import { BackgroundTasksPane } from "@/components/panes/BackgroundTasksPane";
import type { InstalledCapability } from "@/components/panes/CapabilityDetailView";
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
import { useQueryClient } from "@tanstack/react-query";
import { getExplorerAttachmentClipboardEntry } from "@/lib/appClipboard";
import { billingRpcFetch } from "@/lib/app-sdk-client";
import { declineIntegrationProposals, remoteApi } from "@/lib/remoteApiClient";
import { useAtomValue, useSetAtom } from "jotai";
import { publishSkillTitlesAtom } from "./Composer/editor/skillTitles";
import { shareContextAtom } from "./AssistantTurn/shareContext";
import { recentFilesAtom } from "@/components/layout/shell/state/recentFiles";
import {
  type ActiveWebAppSurface,
  activeWebAppSurfaceAtom,
  apiKeyConnectedAppsAtom,
  chatSessionOpenRequestAtom,
  selectedSessionIdAtom,
} from "@/components/layout/shell/state/ui";
import { CHAT_LAYOUT, chatScrollMaskImage } from "@/lib/chatLayout";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { trackUmamiEvent } from "@/lib/analytics/umami";
import {
  DEFAULT_RUNTIME_MODEL,
  useDesktopAuthSession,
} from "@/lib/auth/authClient";
import { useDesktopBilling } from "@/lib/billing/useDesktopBilling";
import {
  composioToolkitMatchesProvider,
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import {
  listWorkspaceFiles,
  type WorkspaceFileEntry,
} from "@/lib/workspaceFiles";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import * as modelCatalog from "../../../../shared/model-catalog.js";
import {
  type ChatAttachment,
  type ChatBackgroundTaskReference,
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
  type ChatMcpAuthorization,
  type ChatPendingIntegration,
  type ChatProposedIntegration,
  type ChatPublishedHubPost,
  type PendingLocalAttachmentFile,
  type PendingExplorerAttachmentFile,
  type PendingAppContextAttachment,
  type PendingAttachment,
  type AttachmentListItem,
  type ImageAttachmentPreviewState,
  type ChatModelOption,
  type ChatModelOptionGroup,
  type ChatComposerSlashCommandOption,
  type ChatComposerQuotedSkillItem,
  type ChatComposerQuotedIntegrationItem,
  type ChatComposerMentionItem,
  type StreamTelemetryEntry,
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
  DEFAULT_STALL_THRESHOLD_MS,
  formatGap,
  groupStreamTelemetry,
} from "./streamTelemetryView";
import {
  attachmentLooksLikeImage,
  pendingAttachmentIsImage,
  supportsImageInput,
  imageInputUnsupportedMessage,
  parseSerializedQuotedSkillPrompt,
  appendComposerPrefillText,
  buildComposerSlashCommandOptions,
  slugifyFilePathForMention,
  injectMentionLinks,
  displayModelLabel,
  compactComposerModelLabel,
  chatMessageTimeLabel,
  inputIdFromMessageId,
  inputIdFromHistoryMessage,
  historyMessagesInDisplayOrder,
  normalizeErrorMessage,
  turnInputIdsFromHistoryMessages,
} from "./helpers";
import { bareRuntimeToolName, effectiveToolName } from "./toolNames";
import {
  preserveCommittedAssistantTurns,
  settleCommittedAssistantTurns,
} from "./preserveCommittedAssistantTurns";
import { preserveMessageIdentity } from "./preserveMessageIdentity";
import { HistoryRestoreSkeleton } from "./skeletons";
import { ApiKeyInstallGate } from "./ApiKeyInstallGate";
import { AttachmentList, formatAttachmentSize } from "./AttachmentList";
import { ImageAttachmentPreviewModal } from "./ImageAttachmentPreviewModal";
import { IssueThreadControls } from "./IssueThreadControls";
import {
  OutputArtifactIcon,
  outputKindLabel,
  outputMetadataNumber,
  outputMetadataString,
  outputSecondaryLabel,
  sortOutputs,
  sortOutputsLatestFirst,
  dedupeOutputsForDisplay,
} from "./ArtifactBrowserModal";
import { ChatHeader, ChatSharePublisher } from "./ChatHeader";
import {
  isShareableDocOutput,
  isShareableMediaOutput,
} from "./AssistantTurn/shareCapture";
import { QueuedSessionInputRail } from "./QueuedSessionInputRail";
import { AssistantTurn } from "./AssistantTurn";
import { turnHasDisplayableOutputs } from "./turnResultCards";
import { preserveDisplayedTurnOutputs } from "./preserveDisplayedTurnOutputs";
import { Composer } from "./Composer";
import {
  imageComposerModeAtom,
  imageGenParamsAtom,
  imageSettingsSuffix,
} from "./Composer/imageMode";
import {
  videoComposerModeAtom,
  videoGenParamsAtom,
  videoSettingsSuffix,
} from "./Composer/videoMode";
import type { ComposerEditorHandle } from "./Composer/editor/ComposerEditor";
import type { ComposerValue } from "./Composer/editor/composerValue";
import { UserTurn } from "./UserTurn";
import { UserQuestionCard } from "./AssistantTurn/UserQuestionCard";
import {
  type ActiveUserQuestionAnswer,
  parseActiveUserQuestion,
} from "./userQuestion";
import { ConversationTurns } from "./ConversationTurns";
import { PersonalizedSuggestions } from "./PersonalizedSuggestions";
import { CreationChips, type CreationType } from "./CreationChips";
import {
  ModelErrorRecoveryCard,
  parseModelError,
  type ParsedModelError,
} from "./ModelErrorRecovery";
import {
  notifyMainSessionsChanged,
  useWorkspaceProjects,
} from "@/components/layout/shell/useWorkspaceLists";
import { useHolaAppCatalog } from "@/components/layout/shell/useHolaAppCatalog";
import { useOpenIssueDetailTab } from "@/components/layout/shell/useOpenIssueDetailTab";
import { AppLandingSuggestions } from "./AppLandingSuggestions";

export type {
  ChatAssistantSegment,
  ChatMessage,
  ChatComposerMentionItem,
};
export {
  inputIdFromMessageId,
  historyMessagesInDisplayOrder,
  turnInputIdsFromHistoryMessages,
  sortOutputs,
  AssistantTurn,
  UserTurn,
  ConversationTurns,
};

/** A model's identity without the provider that serves it. Only the leading
 *  segment goes: `holaboss_model_proxy/qwen/qwen3.7-plus` is the qwen3.7-plus of
 *  the qwen family, and dropping more than the provider would merge two models
 *  that only share a suffix. */
function modelIdentity(token: string): string {
  const trimmed = token.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return trimmed;
  }
  return trimmed.slice(slash + 1);
}

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

// True when the DataTransfer carries something the chat composer would
// accept as an attachment — either a real File or the explorer's custom
// drag payload. Used by the pane-wide dropzone to avoid flashing the
// drop overlay for text-only drags (e.g. selected URLs from the
// address bar).
function hasFileLikeDragItems(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.types.includes(EXPLORER_ATTACHMENT_DRAG_TYPE)) {
    return true;
  }
  const items = Array.from(dataTransfer.items ?? []);
  if (items.some((item) => item.kind === "file")) return true;
  return (dataTransfer.files?.length ?? 0) > 0;
}

function issueBackgroundTaskSourceType(sourceType: string | null | undefined) {
  const normalized = (sourceType ?? "").trim().toLowerCase();
  return normalized === "issue" || normalized === "delegate_task";
}

function backgroundTaskReferenceIdentity(
  reference: ChatBackgroundTaskReference,
) {
  return [
    reference.workspaceId.trim(),
    (reference.sourceType ?? "").trim().toLowerCase(),
    reference.issueId?.trim() || "",
    reference.sourceId?.trim() || "",
  ].join("|");
}

function dedupeBackgroundTaskReferences(
  references: ChatBackgroundTaskReference[],
) {
  const seen = new Set<string>();
  const next: ChatBackgroundTaskReference[] = [];
  for (const reference of references) {
    const key = backgroundTaskReferenceIdentity(reference);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(reference);
  }
  return next;
}

function backgroundTaskUpdatedAtTime(task: BackgroundTaskRecordPayload) {
  return Date.parse(task.updated_at || "") || 0;
}

function optionalHistoryLoadErrorMessage(label: string, error: unknown) {
  return `${label} unavailable: ${normalizeErrorMessage(error)}`;
}

/**
 * Walks the assistant turn history newest-to-oldest and returns the first
 * non-empty `pendingIntegrations` array. That's the set we treat as the
 * "frontier" — older turns either resolved their pending set or were
 * superseded by a fresher emit. Returns [] when no turn has surfaced any.
 */
function findFrontierPendingIntegrations(
  messages: ChatMessage[],
): ChatPendingIntegration[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const pending = message?.pendingIntegrations;
    if (pending && pending.length > 0) {
      return pending;
    }
  }
  return [];
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

function serializeQuotedPrompt(
  input: string,
  quotedSkillIds: string[],
  quotedIntegrationSlugs: string[] = [],
): string {
  const normalizedBody = input.trim();
  const lines = [
    ...quotedSkillIds.map((skillId) => `/${skillId}`),
    ...quotedIntegrationSlugs.map((slug) => `@${slug}`),
  ];
  if (lines.length === 0) {
    return normalizedBody;
  }
  if (!normalizedBody) {
    return lines.join("\n");
  }
  return [...lines, "", normalizedBody].join("\n");
}

/** Fan a referenced capability out into the wire tokens the runtime already
 *  understands: its bundled skills become `/skill` refs and its integrations
 *  become `@provider` refs, merged into any explicitly-quoted ones (dedup,
 *  order-preserving). The runtime has no `/capability` concept — this is where
 *  a capability reference resolves, entirely on the desktop side. */
function expandCapabilitiesIntoQuoted(params: {
  skillIds: string[];
  integrationSlugs: string[];
  capabilityIds: string[];
  capabilities: InstalledCapability[];
  slugForProvider: (provider: string) => string;
}): { skillIds: string[]; integrationSlugs: string[] } {
  const byId = new Map(
    params.capabilities.map((capability) => [
      capability.capabilityId,
      capability,
    ]),
  );
  const skillIds = [...params.skillIds];
  const integrationSlugs = [...params.integrationSlugs];
  const skillSeen = new Set(skillIds);
  const slugSeen = new Set(integrationSlugs);
  for (const capabilityId of params.capabilityIds) {
    const capability = byId.get(capabilityId);
    if (!capability) {
      continue;
    }
    for (const skillId of capability.installedSkillIds) {
      if (skillId && !skillSeen.has(skillId)) {
        skillSeen.add(skillId);
        skillIds.push(skillId);
      }
    }
    for (const provider of Object.keys(capability.integrationStatus)) {
      const slug = params.slugForProvider(provider);
      if (slug && !slugSeen.has(slug)) {
        slugSeen.add(slug);
        integrationSlugs.push(slug);
      }
    }
  }
  return { skillIds, integrationSlugs };
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

export function hasRenderableAssistantTurn(
  message: ChatMessage,
  options?: { showExecutionInternals?: boolean },
) {
  const showExecutionInternals = options?.showExecutionInternals ?? true;
  const hasVisibleOutputSegment =
    message.segments?.some(
      (segment) => segment.kind === "output" && Boolean(segment.text.trim()),
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
    turnHasDisplayableOutputs(message.outputs ?? []) ||
    // An authorize card alone (a remote MCP reported auth_required) is enough to
    // render the turn — otherwise the inline Authorize affordance never shows.
    (message.mcpAuthorizations?.length ?? 0) > 0
  );
}

export function appendAssistantOutputSegment(
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

export function appendAssistantExecutionSegment(
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

export function upsertAssistantExecutionTraceStep(
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

export function finalizeAssistantExecutionSegments(
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

export function liveAssistantSegmentsForRender(
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

export function assistantSegmentsIncludeOutput(
  segments: ChatAssistantSegment[],
) {
  return segments.some(
    (segment) => segment.kind === "output" && Boolean(segment.text.trim()),
  );
}

function syntheticAssistantMessageFromSessionTurn(params: {
  inputId: string;
  outputEvents: SessionOutputEventPayload[];
  outputs: WorkspaceOutputRecordPayload[];
  fallbackCreatedAt?: string;
  showBootstrapPhaseTrace?: boolean;
}): ChatMessage {
  const restoredAssistantState = assistantHistoryStateFromOutputEvents(
    params.outputEvents,
    {
      showBootstrapPhaseTrace: params.showBootstrapPhaseTrace,
    },
  );
  const turnOutputs = sortOutputs(params.outputs);
  const orderedEvents = [...params.outputEvents].sort(
    (left, right) => left.sequence - right.sequence || left.id - right.id,
  );
  const firstEventCreatedAt = orderedEvents[0]?.created_at || "";
  const createdAt =
    restoredAssistantState.terminalCreatedAt ||
    firstEventCreatedAt ||
    turnOutputs[0]?.created_at ||
    turnOutputs[0]?.updated_at ||
    params.fallbackCreatedAt;
  return {
    id: `assistant-${params.inputId}`,
    role: "assistant",
    text:
      restoredAssistantState.segments || !restoredAssistantState.failureText
        ? ""
        : restoredAssistantState.failureText,
    tone:
      restoredAssistantState.segments || !restoredAssistantState.failureText
        ? "default"
        : "error",
    createdAt,
    segments: restoredAssistantState.segments,
    executionItems: restoredAssistantState.segments
      ? undefined
      : restoredAssistantState.executionItems,
    outputs: turnOutputs.length > 0 ? turnOutputs : undefined,
    backgroundTaskReferences: restoredAssistantState.backgroundTaskReferences,
    pendingIntegrations: restoredAssistantState.pendingIntegrations,
    proposedIntegrations: restoredAssistantState.proposedIntegrations,
    mcpAuthorizations: restoredAssistantState.mcpAuthorizations,
    publishedPosts: restoredAssistantState.publishedPosts,
  };
}

export function chatMessagesFromSessionState(params: {
  historyMessages: SessionHistoryMessagePayload[];
  outputEvents: SessionOutputEventPayload[];
  outputs: WorkspaceOutputRecordPayload[];
  knownAssistantInputIds?: Set<string>;
  showExecutionInternals: boolean;
  showBootstrapPhaseTrace?: boolean;
  showContextBudgetDiagnostics?: boolean;
}): ChatMessage[] {
  const outputEventsByInputId = new Map<string, SessionOutputEventPayload[]>();
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
  const historyTurnInputIds = new Set<string>();
  for (const message of params.historyMessages) {
    const assistantInputId =
      message.role === "assistant"
        ? inputIdFromMessageId(message.id, "assistant")
        : "";
    if (assistantInputId) {
      assistantHistoryInputIds.add(assistantInputId);
      historyTurnInputIds.add(assistantInputId);
    }
    const userInputId =
      message.role === "user" ? inputIdFromMessageId(message.id, "user") : "";
    if (userInputId) {
      historyTurnInputIds.add(userInputId);
    }
  }

  const renderedMessages = params.historyMessages
    .flatMap((message) => {
      const attachments = attachmentsFromMetadata(message.metadata);
      const nextMessage: ChatMessage = {
        id:
          message.id || `history-${message.created_at ?? crypto.randomUUID()}`,
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
              showContextBudgetDiagnostics: params.showContextBudgetDiagnostics,
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
          if (restoredAssistantState.backgroundTaskReferences) {
            nextMessage.backgroundTaskReferences =
              restoredAssistantState.backgroundTaskReferences;
          }
          if (restoredAssistantState.pendingIntegrations) {
            nextMessage.pendingIntegrations =
              restoredAssistantState.pendingIntegrations;
          }
          if (restoredAssistantState.proposedIntegrations) {
            nextMessage.proposedIntegrations =
              restoredAssistantState.proposedIntegrations;
          }
          if (restoredAssistantState.mcpAuthorizations) {
            nextMessage.mcpAuthorizations =
              restoredAssistantState.mcpAuthorizations;
          }
          if (restoredAssistantState.publishedPosts) {
            nextMessage.publishedPosts =
              restoredAssistantState.publishedPosts;
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
            showContextBudgetDiagnostics: params.showContextBudgetDiagnostics,
          },
        );
        const turnOutputs = sortOutputs(
          outputsByInputId.get(userInputId) ?? [],
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
          backgroundTaskReferences:
            restoredAssistantState.backgroundTaskReferences,
          pendingIntegrations: restoredAssistantState.pendingIntegrations,
          proposedIntegrations: restoredAssistantState.proposedIntegrations,
          mcpAuthorizations: restoredAssistantState.mcpAuthorizations,
          publishedPosts: restoredAssistantState.publishedPosts,
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
    .concat(
      Array.from(
        new Set([...outputEventsByInputId.keys(), ...outputsByInputId.keys()]),
      )
        .filter((inputId) => inputId && !historyTurnInputIds.has(inputId))
        .map((inputId) =>
          syntheticAssistantMessageFromSessionTurn({
            inputId,
            outputEvents: outputEventsByInputId.get(inputId) ?? [],
            outputs: outputsByInputId.get(inputId) ?? [],
            showBootstrapPhaseTrace: params.showBootstrapPhaseTrace,
          }),
        ),
    )
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        (message.role === "assistant"
          ? hasRenderableAssistantTurn(message, {
              showExecutionInternals: params.showExecutionInternals,
            })
          : hasRenderableMessageContent(
              message.text,
              message.attachments ?? [],
            )),
    )
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.message.createdAt || "");
      const rightAt = Date.parse(right.message.createdAt || "");
      const leftHasDate = Number.isFinite(leftAt);
      const rightHasDate = Number.isFinite(rightAt);
      if (leftHasDate && rightHasDate && leftAt !== rightAt) {
        return leftAt - rightAt;
      }
      if (leftHasDate !== rightHasDate) {
        return leftHasDate ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ message }) => message);

  return renderedMessages;
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
    void context
      .resume()
      .then(play)
      .catch(() => undefined);
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
  return `Session ${sessionId.slice(0, 8)}`;
}

type InspectableSessionCategory = "subagent" | "cronjob" | "session";

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
    kind === "subagent" ||
    sourceType === "subagent" ||
    sourceType === "task_proposal" ||
    Boolean((session?.proposal_id ?? "").trim()) ||
    Boolean((session?.source_proposal_id ?? "").trim())
  ) {
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

/**
 * The two runtime MCP servers Holaboss injects into every external harness
 * (see runtime `harnesses/src/harness-mcp.ts`). Their tools arrive namespaced
 * with the server name, and each harness client uses a different separator —
 * so match these by exact name to strip the prefix reliably.
 */
const HOLABOSS_MCP_SERVER_NAMES = [
  // Longest first: `holaboss_runtime_tools` is a prefix-superstring of
  // `holaboss_runtime`, so it must be tried before it.
  "holaboss_runtime_tools",
  "holaboss_runtime",
] as const;

/**
 * Tools an external harness reaches over our runtime MCP servers arrive
 * namespaced with the server name, but each client does it differently:
 *   • Claude Code: `mcp__<server>__<tool>` (e.g. `mcp__holaboss_runtime_tools__web_search`)
 *   • codex:       `<server>__<tool>`      (e.g. `holaboss_runtime_tools__web_search`)
 * Since separator conventions vary between clients, the only reliable anchor is
 * the known server name. Drop an optional `mcp__`, then a known Holaboss server
 * name across any separator, so a trace step reads "Web Search", not "Holaboss
 * Runtime Tools Web Search". Fall back to the generic `<server>__` strip for
 * other (non-Holaboss) MCP servers. Bare tool names (pi wires these in-process)
 * pass through untouched.
 */
function stripMcpServerPrefix(toolName: string): string {
  const withoutMcp = toolName.replace(/^mcp__/, "");
  for (const server of HOLABOSS_MCP_SERVER_NAMES) {
    if (withoutMcp.startsWith(server)) {
      const rest = withoutMcp.slice(server.length).replace(/^[._-]+/, "");
      if (rest) {
        return rest;
      }
    }
  }
  return withoutMcp.replace(/^.+?__/, "");
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

export function runFailedDetail(payload: Record<string, unknown>): string {
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
      text: serializeQuotedPrompt(
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

const HASHLINE_SECTION_HEADER_PATTERN = /^¶(.+?)(?:#([0-9A-Fa-f]{3}))?$/;

function hashlineSectionPathsFromEditInput(input: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const match = HASHLINE_SECTION_HEADER_PATTERN.exec(rawLine.trim());
    if (!match) {
      continue;
    }
    const rawPath = (match[1] ?? "").trim();
    if (!rawPath) {
      continue;
    }
    const unquotedPath =
      rawPath.length >= 2 &&
      ((rawPath.startsWith('"') && rawPath.endsWith('"')) ||
        (rawPath.startsWith("'") && rawPath.endsWith("'")))
        ? rawPath.slice(1, -1)
        : rawPath;
    const normalizedPath = normalizeWorkspaceFileSyncPath(unquotedPath);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    paths.push(normalizedPath);
  }
  return paths;
}

function hashlineEditSyncTargetFromToolArgs(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const input =
    typeof value.input === "string"
      ? value.input
      : typeof value._input === "string"
        ? value._input
        : "";
  return hashlineSectionPathsFromEditInput(input)[0] ?? null;
}

function summarizeWorkspacePathList(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  if (paths.length === 1) {
    return `File: ${paths[0]}`;
  }
  const preview = paths.slice(0, 3).join(", ");
  return paths.length > 3
    ? `Files: ${preview}, +${paths.length - 3} more`
    : `Files: ${preview}`;
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

// The desktop posts through the agent's module tools, not a "publish" button, so
// `first_post_published` has no server-side trigger here. When a posting tool
// completes we report it to the product server, which emits the reward for the
// signed-in user. Guarded + idempotent (a once-quest), so replays are no-ops.
let firstPostReportAttempted = false;

function isPublishPostTool(toolName: string): boolean {
  // Matches a "create/publish a post" tool ending in `_post` — including
  // platform names between the verb and "post" (e.g.
  // linkedin_create_linked_in_post, twitter_creation_of_a_post,
  // reddit_create_post). Excludes comments/replies, which aren't a "first post".
  if (/comment|repl(?:y|ies)/.test(toolName)) {
    return false;
  }
  return /(?:create|publish|submit|creation_of)(?:_[a-z0-9]+)*_post$/.test(
    toolName,
  );
}

function reportFirstPostPublishedOnce(onGranted?: () => void): void {
  if (firstPostReportAttempted) {
    return;
  }
  firstPostReportAttempted = true;
  void billingRpcFetch("/rpc/rewards/reportFirstPost")
    .then(() => onGranted?.())
    .catch(() => {
      firstPostReportAttempted = false;
    });
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
    return (
      syncableWorkspacePathFromRecord(payload.tool_args, [
        "file_path",
        "path",
        "target_path",
        "target",
        "filename",
        "file",
      ]) ?? hashlineEditSyncTargetFromToolArgs(payload.tool_args)
    );
  }

  return null;
}

function editToolWorkspacePathsFromPayload(
  payload: Record<string, unknown>,
): string[] {
  const toolArgs = isRecord(payload.tool_args) ? payload.tool_args : null;
  const directPath = syncableWorkspacePathFromRecord(toolArgs, [
    "file_path",
    "path",
    "target_path",
    "target",
    "filename",
    "file",
  ]);
  if (directPath) {
    return [directPath];
  }
  const hashlinePath = hashlineEditSyncTargetFromToolArgs(toolArgs);
  return hashlinePath ? [hashlinePath] : [];
}

function extractToolTraceArgsSummary(
  toolName: string,
  payload: Record<string, unknown>,
): string {
  if (toolName.toLowerCase() === "edit") {
    const editPaths = editToolWorkspacePathsFromPayload(payload);
    const pathSummary = summarizeWorkspacePathList(editPaths);
    if (pathSummary) {
      return pathSummary;
    }
  }
  return summarizeUnknown(payload.tool_args);
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
  const label = startCase(stripMcpServerPrefix(toolName || toolId));
  if (!stepId || !label) {
    return null;
  }

  const isError = payload.error === true || phase === "error";
  const details: string[] = [];
  const argsSummary = extractToolTraceArgsSummary(toolName, payload);
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

export function toolTraceStepFromEvent(
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

function contextBudgetDetails(payload: Record<string, unknown>): string[] {
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

export function phaseTraceStepFromEvent(
  eventType: string,
  payload: Record<string, unknown>,
  order: number,
  options?: {
    showContextBudgetDiagnostics?: boolean;
  },
): ChatTraceStep | null {
  const phase = typeof payload.phase === "string" ? payload.phase.trim() : "";
  const instructionPreview =
    typeof payload.instruction_preview === "string"
      ? payload.instruction_preview.trim()
      : "";
  const details: string[] = [];
  const budgetDetails =
    options?.showContextBudgetDiagnostics === true
      ? contextBudgetDetails(payload)
      : [];

  if (eventType === "run_claimed") {
    return {
      id: "phase:run-claimed",
      kind: "phase",
      title: "Checking workspace context",
      status: "running",
      details: [
        "The run was picked up and is preparing the active workspace context.",
      ],
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

  if (
    eventType === "mcp_server_unavailable" ||
    eventType === "composio_toolkit_unavailable"
  ) {
    // Don't surface this in the transcript at all. It's a recoverable notice —
    // the run continues without the server's tools (e.g. an OAuth connector never
    // signed into) — but rendering it every turn read as a failure and was pure
    // noise. The actionable paths live elsewhere: the inline authorize card
    // (mcpAuthorizations, collected in a separate pass) and Customize → MCPs →
    // Custom apps (sign in / remove). So emit no step.
    //
    // composio_toolkit_unavailable is the integration equivalent and gets the
    // same treatment: it exists so a failed toolkit is diagnosable in the run
    // trace, not so it becomes per-turn chrome.
    return null;
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
        ...budgetDetails,
      ],
      order,
    };
  }

  if (eventType === "run_completed") {
    const status =
      typeof payload.status === "string"
        ? payload.status.trim().toLowerCase()
        : "";
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
    details.push(...budgetDetails);
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
  return stepId === "phase:run-claimed" || stepId === "phase:run-started";
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

export function appendExecutionTimelineThinkingDelta(
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

export function upsertExecutionTimelineTraceItem(
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

export function finalizeExecutionTimelineTraceItems(
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
  const displayName = parsePendingIntegrationWhoamiField(
    rawFields.display_name,
  );
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

function parsePendingIntegrationsList(
  value: unknown,
): ChatPendingIntegration[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ChatPendingIntegration | null => {
      if (!isRecord(entry)) return null;
      const appId = typeof entry.app_id === "string" ? entry.app_id.trim() : "";
      const provider =
        typeof entry.provider_id === "string" ? entry.provider_id.trim() : "";
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

function parseBackgroundTaskReference(
  value: unknown,
): ChatBackgroundTaskReference | null {
  if (!isRecord(value)) {
    return null;
  }
  const workspaceId =
    typeof value.workspace_id === "string" ? value.workspace_id.trim() : "";
  if (!workspaceId) {
    return null;
  }
  const sourceType =
    typeof value.source_type === "string" ? value.source_type.trim() : "";
  const sourceId =
    typeof value.source_id === "string" ? value.source_id.trim() : "";
  const issueId =
    typeof value.issue_id === "string" ? value.issue_id.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const status =
    typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  const normalizedSourceType = sourceType.toLowerCase();
  const targetId = issueId || sourceId;
  if (
    normalizedSourceType !== "issue" &&
    normalizedSourceType !== "delegate_task" &&
    normalizedSourceType !== "cronjob"
  ) {
    return null;
  }
  if (normalizedSourceType !== "cronjob" && !targetId) {
    return null;
  }
  return {
    workspaceId,
    sourceType: sourceType || null,
    sourceId: sourceId || issueId || null,
    issueId:
      normalizedSourceType === "issue" ||
      normalizedSourceType === "delegate_task"
        ? issueId || sourceId || null
        : null,
    title: title || null,
    status: status || null,
  };
}

function backgroundTaskReferencesFromSubagentLifecycle(
  payload: Record<string, unknown>,
): ChatBackgroundTaskReference[] {
  const subagentPayload = isRecord(payload.subagent_payload)
    ? payload.subagent_payload
    : null;
  if (!subagentPayload) {
    return [];
  }
  const reference = parseBackgroundTaskReference(subagentPayload);
  return reference ? [reference] : [];
}

function backgroundTaskReferenceKey(reference: ChatBackgroundTaskReference) {
  return [
    reference.workspaceId,
    reference.sourceType ?? "",
    reference.issueId ?? "",
    reference.sourceId ?? "",
    reference.title ?? "",
  ].join("|");
}

const PENDING_INTEGRATION_TOOL_NAMES = new Set([
  "workspace_apps_install",
  "workspace_apps_ensure_running",
  "workspace_apps_restart",
  "workspace_apps_restart_and_wait_ready",
  "delegate_task",
]);

/**
 * The bare runtime-tool id, with any MCP namespacing stripped. The in-process
 * pi/Hola harness emits the bare id (e.g.
 * `holaboss_workspace_integrations_propose_connect`), but external harnesses
 * (Claude Code, Codex, …) reach the same runtime tools over MCP, which exposes
 * them as `mcp__<server>__<tool>`. Tool-name checks below must match either
 * form, else features like the Connect card silently break for those harnesses.
 */


/**
 * Deep-search a tool-call result for the first item an `extract` fn accepts.
 *
 * A propose_connect / pending-integration payload arrives at different nesting
 * depths depending on the harness: the in-process path returns the tool's JSON
 * object directly; an MCP harness wraps it as a content array
 * (`[{ type: "text", text }]`) whose `text` is the JSON string — and because
 * the runtime tool has its own `{ content: [...] }` envelope, that parsed JSON
 * holds ANOTHER stringified `{ content: [...] }` before the real object. Rather
 * than hand-unwrap each layer, walk the structure: descend arrays/objects and
 * JSON.parse any string that still contains `marker`, returning the first
 * non-null `extract` result. Bounded depth guards against pathological nesting.
 */
function deepFindInToolResult<T>(
  value: unknown,
  marker: string,
  extract: (record: Record<string, unknown>) => T | null,
  depth = 0,
): T | null {
  if (depth > 8 || value == null) {
    return null;
  }
  if (typeof value === "string") {
    if (!value.includes(marker)) {
      return null;
    }
    try {
      return deepFindInToolResult(JSON.parse(value), marker, extract, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindInToolResult(item, marker, extract, depth + 1);
      if (found != null) {
        return found;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    const direct = extract(value);
    if (direct != null) {
      return direct;
    }
    for (const nested of Object.values(value)) {
      const found = deepFindInToolResult(nested, marker, extract, depth + 1);
      if (found != null) {
        return found;
      }
    }
    return null;
  }
  return null;
}

function parseProposedIntegration(
  value: unknown,
): ChatProposedIntegration | null {
  if (!isRecord(value)) return null;
  const slug =
    typeof value.toolkit_slug === "string" ? value.toolkit_slug.trim() : "";
  if (!slug) return null;
  const tier =
    value.tier === "hero" || value.tier === "supported"
      ? value.tier
      : undefined;
  const category =
    typeof value.category === "string" ? value.category : undefined;
  const reason = typeof value.reason === "string" ? value.reason : null;
  return { toolkit_slug: slug, tier, category, reason };
}

function proposedIntegrationsFromToolResult(
  payload: Record<string, unknown>,
): ChatProposedIntegration[] {
  const toolName = effectiveToolName(payload);
  if (toolName !== "holaboss_workspace_integrations_propose_connect") return [];
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) return [];
  const found = deepFindInToolResult(
    payload.result,
    "proposed_integration",
    (record) => parseProposedIntegration(record.proposed_integration),
  );
  return found ? [found] : [];
}

// A completed `mcp_connect` returns `auth_required: true` + `server_id` when the
// remote server it just connected demands OAuth. Surface it so the Authorize
// card can appear on THIS turn (the connect turn) instead of waiting for the
// next turn's tool discovery to report the same thing.
function mcpAuthorizationsFromToolResult(
  payload: Record<string, unknown>,
): ChatMcpAuthorization[] {
  const toolName = effectiveToolName(payload);
  // mcp_connect surfaces a first-time Authorize card; mcp_reauthorize surfaces a
  // "switch account" card. Both carry `auth_required` + `server_id`; the latter
  // also sets `reauthorize`.
  if (toolName !== "mcp_connect" && toolName !== "mcp_reauthorize") return [];
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) return [];
  const found = deepFindInToolResult(
    payload.result,
    "auth_required",
    (record) => {
      if (record.auth_required !== true) return null;
      const serverId =
        typeof record.server_id === "string" ? record.server_id.trim() : "";
      if (!serverId) return null;
      return record.reauthorize === true
        ? { serverId, reauthorize: true }
        : { serverId };
    },
  );
  return found ? [found] : [];
}

// A completed HolaHub `create_post` returns `{ postId }` — the one posting tool
// that does. Surface it so the turn can offer a jump into Discover.
function publishedHubPostFromToolResult(
  payload: Record<string, unknown>,
): ChatPublishedHubPost | null {
  // Same wrapper unwrapping as the other card parsers — a post published via
  // `call_tool` would otherwise never offer the jump into Discover.
  const toolName = effectiveToolName(payload).toLowerCase();
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) {
    return null;
  }
  if (!isPublishPostTool(toolName)) {
    return null;
  }
  return deepFindInToolResult(payload.result, "postId", (record) => {
    const postId =
      typeof record.postId === "string" ? record.postId.trim() : "";
    if (!postId) {
      return null;
    }
    const title = typeof record.title === "string" ? record.title.trim() : "";
    return { postId, title };
  });
}

function pendingIntegrationsFromToolResult(
  payload: Record<string, unknown>,
): ChatPendingIntegration[] {
  const toolName = effectiveToolName(payload);
  if (!PENDING_INTEGRATION_TOOL_NAMES.has(toolName)) {
    return [];
  }
  const phase =
    typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  if (phase !== "completed" || payload.error === true) {
    return [];
  }
  // The list can sit behind the same MCP double-wrapping as propose_connect,
  // and behind subagent-lifecycle shells (result_payload / blocking_payload /
  // tasks[] / …). The deep walk descends every array/object and stringified
  // layer, so it finds the first non-empty pending_integrations list wherever
  // it lives.
  const found = deepFindInToolResult(
    payload.result,
    "pending_integrations",
    (record) => {
      const list = parsePendingIntegrationsList(record.pending_integrations);
      return list.length > 0 ? list : null;
    },
  );
  return found ?? [];
}

function assistantHistoryStateFromOutputEvents(
  outputEvents: SessionOutputEventPayload[],
  options?: {
    showBootstrapPhaseTrace?: boolean;
    showContextBudgetDiagnostics?: boolean;
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
  const mcpAuthorizations: ChatMcpAuthorization[] = [];
  const publishedHubPosts: ChatPublishedHubPost[] = [];
  const backgroundTaskReferencesByKey = new Map<
    string,
    ChatBackgroundTaskReference
  >();

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

  // Suppress the synthetic "Waiting for your input" phase step when
  // it sits right after an ask_user_question completion — the rich
  // card on the session already serves that affordance. The flag
  // resets on any new tool_call so an unrelated subsequent
  // waiting-user pause still gets the step.
  let askUserQuestionPending = false;

  for (const event of orderedEvents) {
    if (encounteredTerminalEvent) {
      continue;
    }
    const eventPayload = isRecord(event.payload) ? event.payload : {};

    if (event.event_type === "tool_call" || event.event_type === "tool_completed") {
      const toolName =
        typeof eventPayload.tool_name === "string"
          ? eventPayload.tool_name.trim().toLowerCase()
          : "";
      const toolPhase =
        typeof eventPayload.phase === "string"
          ? eventPayload.phase.trim().toLowerCase()
          : "";
      const isCompletion =
        event.event_type === "tool_completed" || toolPhase === "completed";
      if (
        toolName === "ask_user_question" &&
        isCompletion &&
        eventPayload.error !== true
      ) {
        askUserQuestionPending = true;
      } else if (isCompletion) {
        askUserQuestionPending = false;
      }
    }

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
      {
        showContextBudgetDiagnostics: options?.showContextBudgetDiagnostics,
      },
    );
    if (phaseStep) {
      if (
        isBootstrapPhaseTraceStepId(phaseStep.id) &&
        options?.showBootstrapPhaseTrace !== true
      ) {
        continue;
      }
      if (
        phaseStep.id === "phase:awaiting-user" &&
        askUserQuestionPending
      ) {
        askUserQuestionPending = false;
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
      for (const integration of pendingIntegrationsFromToolResult(
        eventPayload,
      )) {
        const key = integration.provider_id.trim().toLowerCase();
        if (
          !pendingIntegrations.some(
            (existing) => existing.provider_id.trim().toLowerCase() === key,
          )
        ) {
          pendingIntegrations.push(integration);
        }
      }
      for (const proposal of proposedIntegrationsFromToolResult(eventPayload)) {
        const key = proposal.toolkit_slug.trim().toLowerCase();
        if (
          !proposedIntegrations.some(
            (existing) => existing.toolkit_slug.trim().toLowerCase() === key,
          )
        ) {
          proposedIntegrations.push(proposal);
        }
      }
      for (const authz of mcpAuthorizationsFromToolResult(eventPayload)) {
        if (
          !mcpAuthorizations.some((entry) => entry.serverId === authz.serverId)
        ) {
          mcpAuthorizations.push(authz);
        }
      }
      const publishedPost = publishedHubPostFromToolResult(eventPayload);
      if (
        publishedPost &&
        !publishedHubPosts.some((p) => p.postId === publishedPost.postId)
      ) {
        publishedHubPosts.push(publishedPost);
      }
    }

    if (
      event.event_type === "mcp_server_unavailable" &&
      eventPayload.auth_required === true
    ) {
      const serverId =
        typeof eventPayload.server_id === "string"
          ? eventPayload.server_id.trim()
          : "";
      if (
        serverId &&
        !mcpAuthorizations.some((entry) => entry.serverId === serverId)
      ) {
        mcpAuthorizations.push({ serverId });
      }
    }

    if (event.event_type === "subagent_lifecycle_update") {
      for (const integration of pendingIntegrationsFromSubagentLifecycle(
        eventPayload,
      )) {
        const key = integration.provider_id.trim().toLowerCase();
        if (
          !pendingIntegrations.some(
            (existing) => existing.provider_id.trim().toLowerCase() === key,
          )
        ) {
          pendingIntegrations.push(integration);
        }
      }
      for (const reference of backgroundTaskReferencesFromSubagentLifecycle(
        eventPayload,
      )) {
        backgroundTaskReferencesByKey.set(
          backgroundTaskReferenceKey(reference),
          reference,
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
    pendingIntegrations:
      pendingIntegrations.length > 0 ? pendingIntegrations : undefined,
    proposedIntegrations:
      proposedIntegrations.length > 0 ? proposedIntegrations : undefined,
    mcpAuthorizations:
      mcpAuthorizations.length > 0 ? mcpAuthorizations : undefined,
    publishedPosts:
      publishedHubPosts.length > 0 ? publishedHubPosts : undefined,
    backgroundTaskReferences:
      backgroundTaskReferencesByKey.size > 0
        ? Array.from(backgroundTaskReferencesByKey.values())
        : undefined,
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
  clearComposer?: boolean;
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
  autoSubmit?: boolean;
}

interface ChatPaneLocalAttachmentRequest {
  files: File[];
  requestKey: number;
}

interface ChatPaneExplorerAttachmentRequest {
  files: ExplorerAttachmentDragPayload[];
  requestKey: number;
}

interface ChatPaneAppContextAttachmentRequest {
  items: { appName: string; title: string; contextText: string }[];
  requestKey: number;
}

// Stable id for the auto-generated composer attachment that surfaces the open
// HolaApp page as context. Derived from the active-surface atom (NOT a real
// pending attachment), so it persists while the surface is open instead of
// being consumed on send; removing it dismisses the context for that page.
const SURFACE_CONTEXT_ATTACHMENT_ID = "surface-context";

/** "notion" → "Notion", "google_calendar" → "Google Calendar". */
function prettyProviderName(provider: string): string {
  return provider
    .trim()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * A passive context line for whatever HolaApp surface is currently open, folded
 * into the user's message so the agent copilots them in that app. Third-party
 * bundles (e.g. Notion) render their own site in the surface and can't push
 * context through the host bridge (the way need-review/gofunds do via
 * `chat.start`), so the shell supplies "the user is here" on their behalf. It
 * also names the app's declared integrations as a SOFT guide toward the tools
 * the agent might want — never a requirement.
 */
function activeSurfaceContextText(surface: ActiveWebAppSurface): string {
  const lines = [
    `Context — the user currently has the "${surface.title}" app open in holaOS.`,
  ];
  // Prefer the live location (the page they actually navigated to inside the
  // surface, e.g. a specific Notion page) over the app's base url.
  const pageTitle = surface.currentTitle?.trim();
  const pageUrl = surface.currentUrl?.trim() || surface.url?.trim();
  if (pageTitle && pageUrl) {
    lines.push(`They are currently viewing "${pageTitle}" (${pageUrl}).`);
  } else if (pageTitle) {
    lines.push(`They are currently viewing "${pageTitle}".`);
  } else if (pageUrl) {
    lines.push(`They are currently viewing ${pageUrl}.`);
  }
  lines.push("Help them with what they're working on there.");
  // Soft hint toward the tools this app works with — a guide, not a mandate — so
  // the agent knows what's likely relevant without being forced. An app surfaces
  // its capability either via a Composio integration (e.g. Notion) OR its own
  // bundled MCP server (e.g. need-review); name whichever it declares.
  const providers = (surface.integrations ?? [])
    .map((integration) => prettyProviderName(integration.provider))
    .filter(Boolean);
  const mcpTools = (surface.mcpTools ?? []).filter((tool) => tool.trim());
  if (providers.length > 0) {
    const plural = providers.length > 1;
    lines.push(
      `This app works with the ${joinWithAnd(providers)} integration${plural ? "s" : ""} — those tools are likely the most useful here, but use them only if relevant (a guide, not a requirement).`,
    );
  } else if (mcpTools.length > 0) {
    // Cap the listed names so the hint stays short for the prompt.
    const shown = mcpTools.slice(0, 6);
    const suffix = mcpTools.length > shown.length ? ", and others" : "";
    lines.push(
      `This app provides its own tools (${shown.join(", ")}${suffix}) — those are likely the most useful here, but use them only if relevant (a guide, not a requirement).`,
    );
  } else {
    lines.push("Use this app's connected tools when relevant.");
  }
  return lines.join(" ");
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
  chatModelRequest?: { model: string; requestKey: number } | null;
  onChatModelRequestConsumed?: (requestKey: number) => void;
  localAttachmentRequest?: ChatPaneLocalAttachmentRequest | null;
  onLocalAttachmentRequestConsumed?: (requestKey: number) => void;
  explorerAttachmentRequest?: ChatPaneExplorerAttachmentRequest | null;
  onExplorerAttachmentRequestConsumed?: (requestKey: number) => void;
  appContextAttachmentRequest?: ChatPaneAppContextAttachmentRequest | null;
  onAppContextAttachmentRequestConsumed?: (requestKey: number) => void;
  onActiveSessionIdChange?: (sessionId: string | null) => void;
  onOpenBackgroundTask?: (task: BackgroundTaskRecordPayload) => boolean;
  onOpenArtifacts?: () => void;
  /** Shows a "new outputs" dot on the header's Outputs button. */
  outputsHasNew?: boolean;
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
  /** Right-side context column (Outputs/Sources card) docked inside the
   *  messages scroll area so the scrollbar reaches the panel's far edge.
   *  Sticks to the top while the conversation scrolls. */
  contextSlot?: React.ReactNode;
  /** CSS padding-left for the header row, reserving the macOS traffic-light
   *  gutter when the collapsed sidebar leaves the chat flush against the
   *  window's left edge. Undefined keeps the default padding. */
  headerStoplightGutter?: string;
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
  chatModelRequest = null,
  onChatModelRequestConsumed,
  localAttachmentRequest = null,
  onLocalAttachmentRequestConsumed,
  explorerAttachmentRequest = null,
  onExplorerAttachmentRequestConsumed,
  appContextAttachmentRequest = null,
  onAppContextAttachmentRequestConsumed,
  onActiveSessionIdChange,
  onOpenBackgroundTask,
  onOpenArtifacts,
  outputsHasNew = false,
  composerDraftText = "",
  onComposerDraftTextChange,
  scheduleEditContext = null,
  onScheduleEditContextDismiss,
  isPaneAnimating = false,
  contextSlot = null,
  headerStoplightGutter,
}: ChatPaneProps) {
  const {
    selectedWorkspaceId,
    setSelectedSessionForWorkspace,
  } = useWorkspaceSelection();
  const setGlobalChatSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
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
    isIntegrationConnectInFlight,
    inFlightIntegrationProviderNames,
    composioToolkitsByProvider,
  } = useWorkspaceDesktop();
  const queryClient = useQueryClient();

  // Recursive list of workspace files for the `@` picker. The walk
  // (and its limits) live in `@/lib/workspaceFiles` so other surfaces
  // can reuse it.
  //
  // For project-bound sessions, the walk's root is the project's directory
  // so `@` surfaces the project's files instead of workspace files. The
  // active session is fetched from the runtime inside the effect (so we
  // don't depend on desktopMainSession, which is declared later in this
  // component). For General sessions (no project_id), rootAbsolutePath
  // stays null and the walk uses the workspace root.
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>(
    [],
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedChatProjectId, setSelectedChatProjectId] = useState<
    string | null
  >(null);
  const { projects: workspaceProjects } = useWorkspaceProjects(
    selectedWorkspace?.id ?? null,
  );
  // Re-run the project lookup whenever the sidebar's selected session
  // changes — the new session may belong to a different project (or no
  // project at all), which flips the @ picker's search root.
  const sidebarSelectedSessionId = useAtomValue(selectedSessionIdAtom);
  // Which API-key apps are keyed/connected — drives the SURFACE-based install
  // gate below (paired with activeWebAppSurface).
  const apiKeyConnectedApps = useAtomValue(apiKeyConnectedAppsAtom);
  // The HolaApp surface (if any) open beside the chat — shown as a composer
  // attachment + folded into each message as context so the agent copilots the
  // user in that app. The chip is dismissable per page; navigating to a new page
  // (key change) brings it back.
  const activeWebAppSurface = useAtomValue(activeWebAppSurfaceAtom);
  // Truthiness only (stable across in-app navigation, which mutates the surface
  // object's currentUrl): a HolaApp surface owns its chat session — opening the
  // app resumes the app's own session (or a fresh draft) via
  // useOpenHolaAppDraftChat, so the workspace main-session fallback must never
  // load over it.
  const hasActiveWebAppSurface = activeWebAppSurface !== null;
  // A session opened UNDER a HolaApp gets an app-tailored empty state (greeting +
  // starter prompts), served on the catalogue entry (`landing`). Look it up by
  // the active surface's app id; absent, the greeting falls back to a tailored
  // "in <App>" headline and the suggestions are hidden.
  const { catalog: holaAppCatalog } = useHolaAppCatalog();
  const activeAppEntry = activeWebAppSurface
    ? (holaAppCatalog.find(
        (entry) => entry.holaAppId === activeWebAppSurface.holaAppId,
      ) ?? null)
    : null;
  const activeAppLanding = activeAppEntry?.landing ?? null;
  const [dismissedSurfaceContextKey, setDismissedSurfaceContextKey] = useState<
    string | null
  >(null);
  const activeSurfaceContextKey = activeWebAppSurface
    ? `${activeWebAppSurface.holaAppId}::${activeWebAppSurface.currentUrl ?? activeWebAppSurface.url ?? ""}`
    : null;
  const showSurfaceContext =
    Boolean(activeWebAppSurface) &&
    activeSurfaceContextKey !== dismissedSurfaceContextKey;
  const setSidebarSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  useEffect(() => {
    const workspaceId = selectedWorkspace?.id;
    if (!workspaceId) {
      setWorkspaceFiles([]);
      setActiveProjectId(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let rootAbsolutePath: string | null = null;
      let resolvedProjectId: string | null = null;
      try {
        const sessions =
          await window.electronAPI.workspace.listMainSessions(workspaceId);
        if (controller.signal.aborted) return;
        const active = sessions.sessions?.find((s) => s.is_active);
        resolvedProjectId = active?.project_id?.trim() || null;
        if (resolvedProjectId) {
          const response =
            await window.electronAPI.workspace.listProjects(workspaceId);
          if (controller.signal.aborted) return;
          const project = response.items?.find(
            (p) => p.project_id === resolvedProjectId,
          );
          rootAbsolutePath = project?.project_path ?? null;
        }
      } catch {
        // Fall through to workspace root if the lookup fails; the
        // @ picker still needs to function.
      }
      setActiveProjectId(resolvedProjectId);
      try {
        const entries = await listWorkspaceFiles(workspaceId, {
          signal: controller.signal,
          rootAbsolutePath,
        });
        if (!controller.signal.aborted) setWorkspaceFiles(entries);
      } catch {
        if (!controller.signal.aborted) setWorkspaceFiles([]);
      }
    })();
    return () => {
      controller.abort();
    };
    // Re-run when the workspace changes or when the sidebar's selected
    // session changes (sidebarSelectedSessionId) — the latter changes
    // which session.project_id we should follow.
  }, [selectedWorkspace?.id, sidebarSelectedSessionId]);
  const activeProject = activeProjectId
    ? (workspaceProjects.find((p) => p.project_id === activeProjectId) ?? null)
    : null;

  // Recent file opens (renderer-side log persisted by file tabs). Drives
  // the "recent" boost in the @ picker below — recently-opened files
  // float to the top so users don't have to scroll past the alphabetical
  // workspace tree to re-mention a file they just had open.
  const allRecentFiles = useAtomValue(recentFilesAtom);
  // Composer image mode — its quality/aspect ride along on the sent message.
  const imageComposerMode = useAtomValue(imageComposerModeAtom);
  const setImageComposerMode = useSetAtom(imageComposerModeAtom);
  const imageGenParams = useAtomValue(imageGenParamsAtom);
  const videoComposerMode = useAtomValue(videoComposerModeAtom);
  const setVideoComposerMode = useSetAtom(videoComposerModeAtom);
  const videoGenParams = useAtomValue(videoGenParamsAtom);
  // Recent files as WorkspaceFileEntry-shaped rows, in most-recent-first
  // order. Prefer the rich entry from the bounded workspace walk when
  // available; otherwise synthesize one from filePath + label so files
  // that listWorkspaceFiles skips (dotdirs like .holaboss, paths deeper
  // than maxDepth=4, anything past the maxFiles=500 cap) still surface
  // in the @ picker instead of vanishing silently.
  const recentFileEntriesForWorkspace = useMemo<WorkspaceFileEntry[]>(() => {
    const workspaceId = selectedWorkspace?.id ?? null;
    if (!workspaceId) return [];

    const byAbsolutePath = new Map<string, WorkspaceFileEntry>();
    for (const entry of workspaceFiles) {
      byAbsolutePath.set(entry.absolutePath, entry);
    }

    const rawWorkspacePath = selectedWorkspace?.workspace_path?.trim() ?? "";
    const workspacePathPrefix = rawWorkspacePath
      ? `${rawWorkspacePath.replace(/[\\/]+$/, "")}/`
      : "";

    const entries: WorkspaceFileEntry[] = [];
    const seenAbsolutePaths = new Set<string>();
    for (const recent of allRecentFiles) {
      if (recent.workspaceId !== workspaceId) continue;
      if (!recent.filePath || seenAbsolutePaths.has(recent.filePath)) continue;
      seenAbsolutePaths.add(recent.filePath);

      const fromWalk = byAbsolutePath.get(recent.filePath);
      if (fromWalk) {
        entries.push(fromWalk);
        continue;
      }
      const relativePath =
        workspacePathPrefix && recent.filePath.startsWith(workspacePathPrefix)
          ? recent.filePath.slice(workspacePathPrefix.length)
          : recent.label;
      if (!relativePath) continue;
      entries.push({
        name: recent.label,
        relativePath,
        absolutePath: recent.filePath,
      });
    }
    return entries;
  }, [
    allRecentFiles,
    selectedWorkspace?.id,
    selectedWorkspace?.workspace_path,
    workspaceFiles,
  ]);

  // `@` references content WITHIN the current workspace — files at
  // any depth + installed apps. Future kinds (sessions, memories,
  // skills) plug into the same array. Cross-workspace navigation is
  // a different affordance (the workspace switcher in TopTabsBar).
  const composerMentionableItems = useMemo<ChatComposerMentionItem[]>(() => {
    const items: ChatComposerMentionItem[] = [];

    const fileEntryToItem = (
      entry: WorkspaceFileEntry,
    ): ChatComposerMentionItem | null => {
      const handle = slugifyFilePathForMention(entry.relativePath);
      if (!handle) return null;
      return {
        id: `file:${entry.relativePath}`,
        handle,
        label: entry.relativePath,
        kindIcon: <FileIcon className="size-3.5" />,
        keywords: [entry.name, entry.relativePath, handle],
      };
    };

    // Recent files first, in most-recent-first order — when the user
    // types `@` with no query, this is what shows up at the top. The
    // dedupe set guards against duplicate items when we fall through
    // to the alphabetical workspace listing below.
    const emittedRelativePaths = new Set<string>();
    for (const entry of recentFileEntriesForWorkspace) {
      const item = fileEntryToItem(entry);
      if (!item) continue;
      items.push(item);
      emittedRelativePaths.add(entry.relativePath);
    }

    // Remaining files — alphabetical (as listWorkspaceFiles sorts), skip
    // anything already emitted via the recents boost.
    for (const entry of workspaceFiles) {
      if (emittedRelativePaths.has(entry.relativePath)) continue;
      const item = fileEntryToItem(entry);
      if (!item) continue;
      items.push(item);
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
  }, [installedApps, recentFileEntriesForWorkspace, workspaceFiles]);

  // handle → workspace-file entry map. Built from the same slug logic
  // as composerMentionableItems above so a `@<handle>` typed by the
  // user resolves cleanly to the file's absolute path at send time.
  // Used for the auto-attach-on-send pipeline below — without this,
  // mention tokens flow to the agent as plain text that may or may
  // not be picked up by file-read tools.
  const mentionableFilesByHandle = useMemo(() => {
    const byHandle = new Map<string, WorkspaceFileEntry>();
    for (const entry of workspaceFiles) {
      const handle = slugifyFilePathForMention(entry.relativePath);
      if (!handle) continue;
      byHandle.set(handle, entry);
    }
    // Synthesized recent entries (those not in the bounded walk) also
    // need a handle so `@<file>` send-time staging can resolve them.
    for (const entry of recentFileEntriesForWorkspace) {
      const handle = slugifyFilePathForMention(entry.relativePath);
      if (!handle) continue;
      if (byHandle.has(handle)) continue;
      byHandle.set(handle, entry);
    }
    return byHandle;
  }, [recentFileEntriesForWorkspace, workspaceFiles]);

  const [isPaneDragActive, setIsPaneDragActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Assistant turns committed locally that the server has not returned yet.
   *  The assistant-side counterpart of pendingOptimisticUserMessagesRef. */
  const pendingCommittedAssistantTurnsRef = useRef<ChatMessage[]>([]);
  // Set when a send has deferred blanking the canvas because it intends to
  // replace the conversation with its own first message. Cleared by that swap,
  // or by settlePendingSessionSwap if the send never gets that far.
  const pendingSessionSwapRef = useRef(false);
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
  const [quotedCapabilityIds, setQuotedCapabilityIds] = useState<string[]>([]);
  // Seeds the composer editor on (re)mount from the live input so a host prefill
  // survives the editor instance being swapped for an async session switch.
  const composerInitialValue = useMemo<ComposerValue>(
    () => ({
      text: input,
      skillIds: quotedSkillIds,
      capabilityIds: quotedCapabilityIds,
    }),
    [input, quotedSkillIds, quotedCapabilityIds],
  );
  const [quotedIntegrationSlugs, setQuotedIntegrationSlugs] = useState<
    string[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [availableWorkspaceSkills, setAvailableWorkspaceSkills] = useState<
    WorkspaceSkillRecordPayload[]
  >([]);
  const [availableWorkspaceCapabilities, setAvailableWorkspaceCapabilities] =
    useState<InstalledCapability[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);
  const [loadedHistoryMessageCount, setLoadedHistoryMessageCount] = useState(0);
  const [totalHistoryMessageCount, setTotalHistoryMessageCount] = useState(0);
  const [isResponding, setIsResponding] = useState(false);
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false);
  const [autoSubmitNonce, setAutoSubmitNonce] = useState(0);
  const [isPausePending, setIsPausePending] = useState(false);
  const [chatErrorMessage, setChatErrorMessage] = useState("");
  const [pendingIntegrationsWait, setPendingIntegrationsWait] = useState<{
    unresolvedSlugs: string[];
    sessionId: string;
  } | null>(null);
  const [backgroundDeliveryStatusMessage, setBackgroundDeliveryStatusMessage] =
    useState("");
  const [attachmentGateMessage, setAttachmentGateMessage] = useState("");
  const [dismissedModelErrorKey, setDismissedModelErrorKey] = useState<
    string | null
  >(null);
  const [isRetryingModelError, setIsRetryingModelError] = useState(false);
  const [verboseTelemetryEnabled, setVerboseTelemetryEnabled] = useState(false);
  const [composerBlockHeight, setComposerBlockHeight] = useState(0);
  const [chatModelPreference, setChatModelPreference] = useState(
    loadStoredChatModelPreference,
  );
  // Per-session model override. `chatModelPreference` above is the GLOBAL
  // default that seeds NEW chats; when the composer is bound to an existing
  // session it instead reflects THAT session's own model, and changing the
  // model there writes here (keyed by session id) — never back into the global
  // default. Automation replies land here too, so a one-off manual model change
  // never re-pins the schedule.
  const [perSessionModelOverride, setPerSessionModelOverride] = useState<
    Record<string, string>
  >({});
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
  const [streamTelemetryRawView, setStreamTelemetryRawView] = useState(false);
  const [streamTelemetryExpanded, setStreamTelemetryExpanded] = useState<
    Record<string, boolean>
  >({});
  const streamTelemetryRingRef = useRef<StreamTelemetryEntry[]>([]);
  const streamTelemetryFlushTimerRef = useRef<number | null>(null);
  const [imageAttachmentPreview, setImageAttachmentPreview] =
    useState<ImageAttachmentPreviewState | null>(null);
  const [queuedSessionInputs, setQueuedSessionInputs] = useState<
    QueuedSessionInput[]
  >([]);
  const [pendingOptimisticUserMessages, setPendingOptimisticUserMessages] =
    useState<PendingOptimisticUserMessage[]>([]);
  const [desktopMainSession, setDesktopMainSession] =
    useState<AgentSessionRecordPayload | null>(null);
  // Per-harness model + thinking selection for CLI harnesses
  // (claude-code, codex). The Holaboss `chatModelPreference` state
  // machine is tightly coupled to the provider catalogue — re-routing
  // it for harness-namespaced ids (claude-opus-4-7, gpt-5.1-codex)
  // would change semantics for every existing call site. Sibling
  // overrides here let the Composer write harness-appropriate values
  // without disturbing the pi catalogue logic. Thinking defaults to
  // "medium" because both Claude --effort and Codex
  // model_reasoning_effort accept that token.
  const [harnessChatModelOverride, setHarnessChatModelOverride] = useState<
    string | null
  >(null);
  const [harnessThinkingOverride, setHarnessThinkingOverride] = useState<
    string
  >("medium");
  // Harness chosen on the empty-composer picker for the *next* chat. This
  // is a deferred intent: we never mutate the resumed session's harness
  // (it's immutable once the session has run a turn). Instead, on send we
  // mint a fresh main session bound to this id (see sendMessage). Null =
  // "use whatever the current session is already bound to".
  const [pendingHarnessId, setPendingHarnessId] = useState<string | null>(
    null,
  );
  const [workspaceIssues, setWorkspaceIssues] = useState<IssueRecordPayload[]>(
    [],
  );
  const [issueMutationErrorMessage, setIssueMutationErrorMessage] =
    useState("");
  const [isIssueMutationPending, setIsIssueMutationPending] = useState(false);
  const [sessionRecordOverrides, setSessionRecordOverrides] = useState<
    Record<string, AgentSessionRecordPayload>
  >({});
  const [activeSessionReadOnly, setActiveSessionReadOnly] = useState(false);
  const [localSessionOpenRequest, setLocalSessionOpenRequest] =
    useState<ChatPaneSessionOpenRequest | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerBlockRef = useRef<HTMLDivElement>(null);
  // When the outer pane is mid-width-transition, freeze the inner
  // content column to its pre-transition pixel width so message text
  // doesn't re-wrap mid-animation. Re-wrap is what makes messages
  // appear to drift up as content height shrinks under a wider column.
  const [frozenColumnWidth, setFrozenColumnWidth] = useState<number | null>(
    null,
  );
  // Set when ask_user_question fires; consumed (and reset) by the
  // run_completed handler so we suppress the synthetic
  // "Waiting for your input" phase step — the rich question card
  // already serves that role.
  const askUserQuestionPendingRef = useRef(false);
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
  // Per-session cache of fully-loaded execution traces + outputs so re-opening
  // a session paints its traces instantly while we revalidate in the
  // background. Bounded; oldest entries evicted in the loader.
  const sessionArtifactCacheRef = useRef<
    Map<
      string,
      {
        outputEvents: SessionOutputEventPayload[];
        outputs: WorkspaceOutputRecordPayload[];
      }
    >
  >(new Map());
  const pendingHistoryPrependRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const lastSubmittedComposerInputRef =
    useRef<ComposerInputRecallSnapshot | null>(null);
  const lastCancelledComposerInputRef =
    useRef<ComposerInputRecallSnapshot | null>(null);
  const isLoadingOlderHistoryRef = useRef(false);
  const conversationRefreshInFlightRef = useRef(false);
  const conversationRefreshPendingRef = useRef(false);
  const seenMainDebugKeysRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<WorkspaceRecordPayload | null>(null);
  const desktopMainSessionIdRef = useRef("");
  const playedMainSessionCompletionChimeKeysRef = useRef<Set<string>>(
    new Set(),
  );
  const isOnboardingVariant = false;
  const isEmbeddedVariant = variant === "embedded";
  const pendingFocusRequestKeyRef = useRef<number | null>(focusRequestKey);
  const lastHandledSessionJumpRequestKeyRef = useRef(0);
  const lastHandledExternalSessionOpenRequestKeyRef = useRef(0);
  const lastHandledLocalSessionOpenRequestKeyRef = useRef(0);
  const lastHandledComposerPrefillRequestKeyRef = useRef(0);
  const autoSubmitBodyRef = useRef<string | null>(null);
  const lastHandledLocalAttachmentRequestKeyRef = useRef(0);
  const lastHandledExplorerAttachmentRequestKeyRef = useRef(0);
  const lastHandledAppContextAttachmentRequestKeyRef = useRef(0);
  const consumedSessionOpenRequestKeysRef = useRef<Set<number>>(new Set());
  const localSessionOpenRequestRef = useRef<ChatPaneSessionOpenRequest | null>(
    null,
  );
  const previousSelectedWorkspaceIdRef = useRef(
    (selectedWorkspaceId || "").trim(),
  );
  const mainSessionEventBatchInputIdsRef = useRef<Set<string>>(new Set());
  const draftParentSessionIdRef = useRef<string | null>(null);
  // Suppresses the main-session fallback while a blank "New chat" draft shows,
  // so a prior session's history can't load over it before the user sends.
  const blankDraftActiveRef = useRef(false);
  const draftHydrationWorkspaceIdRef = useRef(
    (selectedWorkspaceId || "").trim(),
  );
  // Tracks which workspace's session view we are currently showing. When
  // the selected workspace changes, we synchronously clear the old view so
  // the previous workspace's messages don't flash through during the async
  // history load.
  const loadedSessionViewWorkspaceIdRef = useRef(
    (selectedWorkspaceId || "").trim(),
  );
  const skipNextComposerDraftPublishRef = useRef(false);
  const liveAssistantSegmentsRef = useRef<ChatAssistantSegment[]>([]);
  const liveAssistantTextRef = useRef("");
  const liveAssistantFlushFrameRef = useRef<number | null>(null);
  // Reveal-pacing buffer for live assistant text. Providers stream in chunky
  // bursts (a big text_delta, then a gap); we hold the received text in
  // liveAssistantTextRef and reveal it on screen at a smoothed, time-based rate
  // so it reads as a steady typewriter rather than mirroring the burst/gap
  // cadence. The display trails arrival slightly — that trailing buffer is what
  // absorbs the bursts. Commit/segment-flush snap to the full received text.
  const liveAssistantRevealedRef = useRef(0); // chars currently shown
  const liveRevealLastFrameRef = useRef(0); // timestamp of the last reveal frame (0 = idle)
  const liveRevealRateRef = useRef(0); // smoothed reveal speed, chars/ms
  // Aim to drain the CURRENT backlog over ~this long. Larger = smoother but more
  // trailing lag / slower reveal; smaller = faster reveal + less lag, at the
  // cost of being likelier to empty and stall between provider chunks. The
  // sustained rate self-limits near the model's generation rate regardless.
  const LIVE_REVEAL_TARGET_WINDOW_MS = 120;
  // Floor on reveal speed so short backlogs and slow generation still read
  // briskly (chars/sec). Above this, the window-based rate takes over.
  const LIVE_REVEAL_MIN_CHARS_PER_SEC = 260;
  // EMA factor for the reveal SPEED (not position): a fresh chunk raises the
  // target speed, but we ramp toward it gradually so the chunk eases in instead
  // of dumping in a few frames. Lower = steadier.
  const LIVE_REVEAL_RATE_SMOOTHING = 0.3;
  // Clamp a frame's dt after a tab-away / GC stall so we don't reveal a huge
  // jump on the first frame back.
  const LIVE_REVEAL_MAX_FRAME_MS = 100;
  // Snap through very large backlogs (resume replay / paste / huge burst)
  // instead of animating through thousands of chars.
  const LIVE_REVEAL_JUMP_THRESHOLD = 600;
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
    entry: Omit<StreamTelemetryEntry, "id" | "at"> & { at?: string },
  ) {
    if (!verboseTelemetryEnabled) {
      return;
    }
    // `at` is overridable because main-process entries arrive in batches long
    // after they happened. Stamping those on arrival gave every one of them the
    // same fabricated time — a whole burst reading 12.585 — which makes the
    // main-side rows look simultaneous and invents a causal order that never
    // existed. When the origin knows the real time, it wins.
    const at = entry.at ?? new Date().toISOString().slice(11, 23);
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
    setQuotedCapabilityIds([]);
    composerEditorRef.current?.clear();
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
      .filter((entry): entry is ComposerInputRecallSnapshot =>
        Boolean(
          entry && entry.workspaceId === workspaceId && entry.text.trim(),
        ),
      )
      .sort((left, right) => right.at - left.at)[0];
    if (!recallableInput) {
      return false;
    }
    setInput(recallableInput.text);
    composerEditorRef.current?.setContent({
      text: recallableInput.text,
      skillIds: [],
      capabilityIds: [],
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
    liveAssistantRevealedRef.current = 0;
    stopLiveReveal();
    liveExecutionItemsRef.current = [];
    activeAssistantMessageIdRef.current = null;
    lastSyncedAgentOperationFileKeyRef.current = "";
    setLiveAssistantSegments([]);
    setLiveAssistantText("");
    setLiveAgentStatus("");
    setLiveExecutionItems([]);
  }

  // Reset only the in-progress streamed text for a pi in-turn retry
  // (auto_retry_start): pi dropped the failed last message from its own state
  // (slice(0, -1)) and will re-stream it, so discard that attempt's unflushed
  // partial text. Already-flushed segments from prior messages and the active
  // message id are kept, so the retried deltas land fresh in the same bubble
  // instead of concatenating onto the truncated attempt ("The answer is 4" +
  // "The answer is 42.").
  function resetLiveOutputForRetry() {
    cancelLiveAssistantFlush();
    liveAssistantTextRef.current = "";
    liveAssistantRevealedRef.current = 0;
    stopLiveReveal();
    setLiveAssistantText("");
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

  /**
   * `keepMessages` leaves the visible list alone while resetting everything
   * else. Used when we are about to REPLACE the conversation rather than merely
   * leave it: blanking here and then awaiting session creation left the canvas
   * empty across an IPC round trip, which is the flash when you send into a new
   * session. The caller swaps the list in one step instead, once it has the
   * first message to show.
   *
   * Every other caller still blanks, because they genuinely have nothing to put
   * in its place (workspace switch, blank draft, session delete).
   */
  /** Blank a conversation that was held over for a swap that never happened. */
  function settlePendingSessionSwap() {
    if (!pendingSessionSwapRef.current) {
      return;
    }
    pendingSessionSwapRef.current = false;
    setMessages([]);
  }

  function clearSessionView(options: { keepMessages?: boolean } = {}) {
    if (!options.keepMessages) {
      setMessages([]);
    }
    // Scoped to the session it was committed in — leaving it set would splice a
    // turn from the previous conversation into the next one.
    pendingCommittedAssistantTurnsRef.current = [];
    setSessionOutputs([]);
    setLoadedHistoryMessageCount(0);
    setTotalHistoryMessageCount(0);
    setIsLoadingOlderHistoryState(false);
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
      showExecutionInternals: shouldShowExecutionInternalsForSession(sessionId),
      showBootstrapPhaseTrace:
        shouldShowBootstrapPhaseTraceForSession(sessionId),
      showContextBudgetDiagnostics: verboseTelemetryEnabled,
    });
  }

  async function fetchSessionArtifacts(
    params: { sessionId: string; workspaceId: string; inputIds: string[] },
    options?: { cancelled?: () => boolean },
  ): Promise<{
    outputEvents: SessionOutputEventPayload[];
    outputs: WorkspaceOutputRecordPayload[];
    warnings: string[];
  } | null> {
    const cancelled = options?.cancelled ?? (() => false);
    const warnings: string[] = [];
    const inputIds = new Set(params.inputIds);
    // One session-scoped request each, then filter to the requested turns —
    // avoids a per-turn fan-out that serializes on the runtime's single thread.
    const [outputEventsResult, outputListResult] = await Promise.allSettled([
      window.electronAPI.workspace.getSessionOutputEvents({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      }),
      remoteApi.outputs.list({
        sessionId: params.sessionId,
        limit: 1000,
      }),
    ]);
    if (outputEventsResult.status !== "fulfilled") {
      warnings.push(
        optionalHistoryLoadErrorMessage(
          "Execution history",
          outputEventsResult.reason,
        ),
      );
    }
    if (outputListResult.status !== "fulfilled") {
      warnings.push(
        optionalHistoryLoadErrorMessage("Artifacts", outputListResult.reason),
      );
    }
    if (cancelled()) {
      return null;
    }
    const outputEvents =
      outputEventsResult.status === "fulfilled"
        ? outputEventsResult.value.items.filter((event) =>
            inputIds.has(event.input_id),
          )
        : [];
    const outputs =
      outputListResult.status === "fulfilled"
        ? outputListResult.value.items.filter(
            (output) => output.input_id != null && inputIds.has(output.input_id),
          )
        : [];
    return {
      outputEvents: mergeSessionOutputEvents([], outputEvents),
      outputs: mergeSessionOutputs([], outputs),
      warnings,
    };
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
      skipArtifacts?: boolean;
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

    // Fast path: render the conversation text now and let the caller fetch the
    // per-turn execution traces + artifacts in the background. Also covers the
    // no-traces case where there is nothing to fetch.
    if (options?.skipArtifacts || assistantInputIds.length === 0) {
      return {
        history,
        historyMessages,
        assistantInputIds,
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

    const artifacts = await fetchSessionArtifacts(
      {
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        inputIds: assistantInputIds,
      },
      { cancelled },
    );
    if (!artifacts || cancelled()) {
      return null;
    }

    return {
      history,
      historyMessages,
      assistantInputIds,
      warnings: artifacts.warnings,
      outputEvents: artifacts.outputEvents,
      outputs: artifacts.outputs,
      renderedMessages: historyMessagesFromSessionState(
        params.sessionId,
        historyMessages,
        artifacts.outputEvents,
        artifacts.outputs,
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
      { cancelled, skipArtifacts: true },
    );
    if (!page || cancelled()) {
      return;
    }

    setLoadedHistoryMessageCount(page.history.count);
    setTotalHistoryMessageCount(page.history.total);
    setIsLoadingOlderHistoryState(false);
    pendingHistoryPrependRestoreRef.current = null;
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
    // The runtime's status LAGS the stream's terminal frame: at the 150ms
    // refresh rung its agent_runs row is frequently still BUSY for a run whose
    // run_completed we already applied. And both refs being null is exactly what
    // "we just finished" looks like — they are cleared by the terminal handler.
    //
    // So without a memory of which inputs have terminated, this predicate reads
    // a just-finished turn as an unattached live run and re-opens the stream with
    // includeHistory: true. The runtime then replays every event of the turn from
    // sequence 1, and the renderer drops all of them as unmatched
    // (input_match=false) because pendingInputIdRef was cleared. That is a full
    // wasted replay on every single turn — a hundred-odd events produced,
    // shipped over IPC and discarded.
    //
    // The terminal-event map already records this; it just was not consulted.
    const runtimeInputAlreadyTerminated = Boolean(
      currentRuntimeInputId &&
        terminalEventTypeByInputIdRef.current.has(currentRuntimeInputId),
    );
    const shouldAttachLiveRunStream =
      !activeStreamIdRef.current &&
      !pendingInputIdRef.current &&
      !runtimeInputAlreadyTerminated &&
      ["BUSY", "QUEUED"].includes(currentRuntimeStatus);

    // Render the conversation from whatever traces/outputs we have: empty (or
    // cached) on the fast first paint, full once the background artifact fetch
    // lands. Returns the displayed messages for the live-stream attach below.
    const applyRenderedHistory = (
      outputEvents: SessionOutputEventPayload[],
      outputs: WorkspaceOutputRecordPayload[],
    ): ChatMessage[] => {
      loadedHistoryOutputEventsRef.current = outputEvents;
      setSessionOutputs(outputs);
      const rendered = historyMessagesFromSessionState(
        nextSessionId,
        page.historyMessages,
        outputEvents,
        outputs,
      );
      const renderedForDisplay =
        shouldAttachLiveRunStream && currentRuntimeInputId
          ? rendered.filter(
              (message) =>
                message.role !== "assistant" ||
                inputIdFromMessageId(message.id, "assistant") !==
                  currentRuntimeInputId,
            )
          : rendered;
      const reconciled = reconcilePendingOptimisticUserMessages(
        pendingOptimisticUserMessagesRef.current,
        { workspaceId, sessionId: nextSessionId, persistedInputIds },
      );
      updatePendingOptimisticUserMessagesState(reconciled);
      // A turn the server has caught up on is no longer pending — its copy is
      // authoritative from here.
      pendingCommittedAssistantTurnsRef.current = settleCommittedAssistantTurns(
        pendingCommittedAssistantTurnsRef.current,
        renderedForDisplay,
      );
      setMessages((prev) =>
        // Outermost: everything below rebuilds objects, so identity is restored
        // last, once the final content is settled.
        preserveMessageIdentity(
          preserveDisplayedTurnOutputs(
            preserveCommittedAssistantTurns(
              mergePendingOptimisticUserMessages(renderedForDisplay, reconciled, {
                workspaceId,
                sessionId: nextSessionId,
              }),
              pendingCommittedAssistantTurnsRef.current,
            ),
            prev,
          ),
          prev,
        ),
      );
      return renderedForDisplay;
    };

    // First paint: use cached traces when we have them, otherwise empty — the
    // chat shows immediately and the skeleton lifts without waiting on the
    // per-turn artifact fan-out.
    const artifactCacheKey = `${workspaceId}:${nextSessionId}`;
    const cachedArtifacts =
      sessionArtifactCacheRef.current.get(artifactCacheKey) ?? null;
    setChatErrorMessage("");
    const renderedMessagesForDisplay = applyRenderedHistory(
      cachedArtifacts?.outputEvents ?? [],
      cachedArtifacts?.outputs ?? [],
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

    // Background: fetch per-turn execution traces + artifacts without blocking
    // the reveal, then re-render. Bails if the user navigated away or a live
    // run took over the view; refreshes the cache for instant re-opens.
    if (page.assistantInputIds.length > 0) {
      void (async () => {
        const artifacts = await fetchSessionArtifacts(
          {
            sessionId: nextSessionId,
            workspaceId,
            inputIds: page.assistantInputIds,
          },
          { cancelled },
        );
        if (
          !artifacts ||
          cancelled() ||
          activeSessionIdRef.current !== nextSessionId
        ) {
          return;
        }
        const cache = sessionArtifactCacheRef.current;
        cache.delete(artifactCacheKey);
        cache.set(artifactCacheKey, {
          outputEvents: artifacts.outputEvents,
          outputs: artifacts.outputs,
        });
        while (cache.size > 24) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey === undefined) {
            break;
          }
          cache.delete(oldestKey);
        }
        if (activeStreamIdRef.current || pendingInputIdRef.current) {
          // A live or just-sent run is driving the view; keep traces available
          // for the next render but don't clobber the stream / optimistic turn.
          loadedHistoryOutputEventsRef.current = artifacts.outputEvents;
          setSessionOutputs(artifacts.outputs);
          return;
        }
        if (artifacts.warnings.length > 0) {
          setChatErrorMessage([...new Set(artifacts.warnings)].join(" "));
        }
        applyRenderedHistory(artifacts.outputEvents, artifacts.outputs);
      })();
    }
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
    projectId?: string | null,
    owningAppId?: string | null,
    firstUserText?: string | null,
  ): Promise<string | null> {
    const created = await window.electronAPI.workspace.createAgentSession({
      workspace_id: workspaceId,
      kind: "workspace_session",
      parent_session_id: parentSessionId?.trim() || null,
      project_id: projectId ?? null,
      created_by: "workspace_user",
      app_id: owningAppId ?? null,
      // Titles the session at creation. The sidebar hides titleless sessions as
      // empty placeholders, and the title used to be written only when the
      // input was queued — so the row appeared not when the session was created
      // but whenever the send finished assembling, seconds later. The runtime
      // derives it, so the rules for attachments and image-only sends stay in
      // one place.
      first_user_text: firstUserText?.trim() || null,
    });
    const sessionId = created.session.session_id.trim();
    if (sessionId) {
      // The sidebar lists poll every 5s. Without this the session the user just
      // started has no row anywhere on screen until the next tick.
      notifyMainSessionsChanged();
    }
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
          // The full received text (not the revealed slice) — the committed
          // segment snaps to complete, so pacing never drops trailing chars.
          liveAssistantTextRef.current,
          tone,
        ),
      );
      liveAssistantTextRef.current = "";
      liveAssistantRevealedRef.current = 0;
      stopLiveReveal();
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

  function stopLiveReveal() {
    liveRevealLastFrameRef.current = 0;
    liveRevealRateRef.current = 0;
  }

  function scheduleLiveAssistantFlush() {
    if (liveAssistantFlushFrameRef.current !== null) return;
    const step = (now: number): void => {
      liveAssistantFlushFrameRef.current = null;
      const target = liveAssistantTextRef.current.length;
      let revealed = liveAssistantRevealedRef.current;
      if (revealed >= target) {
        // Caught up; the loop restarts (fresh timing) when the next delta lands.
        stopLiveReveal();
        return;
      }
      const backlog = target - revealed;
      if (backlog > LIVE_REVEAL_JUMP_THRESHOLD) {
        liveAssistantRevealedRef.current = target;
        setLiveAssistantText(liveAssistantTextRef.current);
        stopLiveReveal();
        return;
      }
      const last = liveRevealLastFrameRef.current;
      const dt =
        last === 0 ? 16 : Math.min(now - last, LIVE_REVEAL_MAX_FRAME_MS);
      liveRevealLastFrameRef.current = now;
      // Speed (chars/ms) that would clear the current backlog over the target
      // window, EMA-smoothed so a big incoming chunk ramps the speed up
      // gradually rather than dumping — the smoothing is what turns burst/gap
      // arrival into steady motion.
      const desiredRate = backlog / LIVE_REVEAL_TARGET_WINDOW_MS;
      const prevRate = liveRevealRateRef.current;
      const rate =
        prevRate === 0
          ? desiredRate
          : prevRate + (desiredRate - prevRate) * LIVE_REVEAL_RATE_SMOOTHING;
      liveRevealRateRef.current = rate;
      // Reveal at max(window-based smoothed rate, the min floor), never more than
      // what's buffered, and ≥1 char/frame so there's always visible motion.
      const minCharsThisFrame = (LIVE_REVEAL_MIN_CHARS_PER_SEC / 1000) * dt;
      const advance = Math.min(
        backlog,
        Math.max(1, Math.round(Math.max(rate * dt, minCharsThisFrame))),
      );
      revealed += advance;
      liveAssistantRevealedRef.current = revealed;
      setLiveAssistantText(liveAssistantTextRef.current.slice(0, revealed));
      // Re-read the ref: deltas that landed during this frame extend the target,
      // so keep animating until we've caught up to the latest text.
      if (revealed < liveAssistantTextRef.current.length) {
        liveAssistantFlushFrameRef.current = window.requestAnimationFrame(step);
      } else {
        stopLiveReveal();
      }
    };
    liveAssistantFlushFrameRef.current = window.requestAnimationFrame(step);
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

  /** Returns the committed message id, or null when there was nothing to
   *  commit. Callers that only need "did it commit?" still read it as a
   *  boolean; the id lets the refresh ladder name the turn it is waiting for. */
  function commitLiveAssistantMessage(options?: {
    fallbackText?: string;
    tone?: ChatMessage["tone"];
  }): string | null {
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
      return null;
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
      return null;
    }

    setMessages((prev) => [...prev, nextMessage]);
    // Hold it against the refresh ladder below: the runtime persists this turn
    // asynchronously, so the 150ms refresh usually cannot see it yet and would
    // otherwise drop it until the 500ms one — the end-of-response flicker.
    pendingCommittedAssistantTurnsRef.current = [
      ...pendingCommittedAssistantTurnsRef.current,
      nextMessage,
    ];
    resetLiveTurn();
    return messageId;
  }

  // Coalesce overlapping refreshes: at most one load runs at a time, with a
  // single trailing run so the final settled runtime state is still captured.
  async function runConversationRefresh(sessionId: string, workspaceId: string) {
    if (
      activeSessionIdRef.current !== sessionId ||
      selectedWorkspaceId !== workspaceId
    ) {
      return;
    }
    if (conversationRefreshInFlightRef.current) {
      conversationRefreshPendingRef.current = true;
      return;
    }
    conversationRefreshInFlightRef.current = true;
    try {
      const runtimeStates =
        await window.electronAPI.workspace.listRuntimeStates(workspaceId);
      await loadSessionConversation(sessionId, workspaceId, runtimeStates.items, {
        cancelled: () =>
          activeSessionIdRef.current !== sessionId ||
          selectedWorkspaceId !== workspaceId,
      });
    } catch {
      // best-effort convergence; a later refresh will retry
    } finally {
      conversationRefreshInFlightRef.current = false;
      if (conversationRefreshPendingRef.current) {
        conversationRefreshPendingRef.current = false;
        void runConversationRefresh(sessionId, workspaceId);
      }
    }
  }

  function scheduleConversationRefresh(
    sessionId: string | null,
    workspaceId: string | null | undefined,
    options?: {
      /** The turn this ladder is waiting for the runtime to persist. Once it
       *  lands, the remaining refreshes have nothing left to converge on. */
      awaitAssistantMessageId?: string | null;
    },
  ) {
    const normalizedSessionId = (sessionId || "").trim();
    const normalizedWorkspaceId = (workspaceId || "").trim();
    if (!normalizedSessionId || !normalizedWorkspaceId) {
      return;
    }

    // The ladder covers an unknown persistence delay, so it retries on a curve
    // rather than once. But every rung re-derives the WHOLE conversation, so
    // running all four unconditionally costs three full rebuilds of every
    // message after the data has already converged — the bulk of the
    // end-of-turn stutter on a long chat.
    //
    // When the caller names the turn it is waiting for, stop as soon as that
    // turn lands. Callers that name nothing keep the old behaviour exactly.
    const delays = [150, 500, 1_500, 3_000];
    const timers: number[] = [];
    const awaited = (options?.awaitAssistantMessageId ?? "").trim();
    const cancelRemaining = () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      timers.length = 0;
    };
    for (const delayMs of delays) {
      timers.push(
        window.setTimeout(() => {
          void runConversationRefresh(
            normalizedSessionId,
            normalizedWorkspaceId,
          ).then(() => {
            if (!awaited) {
              return;
            }
            // Settled by the refresh itself (see settleCommittedAssistantTurns)
            // the moment the server returns the turn.
            const stillPending =
              pendingCommittedAssistantTurnsRef.current.some(
                (message) => message.id === awaited,
              );
            if (!stillPending) {
              cancelRemaining();
            }
          });
        }, delayMs),
      );
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
    if (
      cancelled() ||
      (activeSessionIdRef.current || "").trim() !== mainSessionId
    ) {
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
      await loadSessionConversation(
        mainSessionId,
        workspaceId,
        runtimeStates.items,
        {
          cancelled,
          readOnly: false,
        },
      );
      return true;
    }

    const latestHistory = await window.electronAPI.workspace.getSessionHistory({
      sessionId: mainSessionId,
      workspaceId,
      limit: 1,
      offset: 0,
      order: "desc",
    });
    if (
      cancelled() ||
      (activeSessionIdRef.current || "").trim() !== mainSessionId
    ) {
      return false;
    }

    const latestHistoryMessageId =
      historyMessagesInDisplayOrder(
        latestHistory.messages,
        "desc",
      )[0]?.id?.trim() || "";
    const latestDisplayedMessageId = latestVisibleChatMessageId(
      params.currentMessages,
    );
    if (
      !latestHistoryMessageId ||
      latestHistoryMessageId === latestDisplayedMessageId
    ) {
      return false;
    }

    await loadSessionConversation(
      mainSessionId,
      workspaceId,
      runtimeStates.items,
      {
        cancelled,
        readOnly: false,
      },
    );
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
    desktopMainSessionIdRef.current = (
      desktopMainSession?.session_id || ""
    ).trim();
  }, [desktopMainSession?.session_id]);

  // Drop any deferred harness pick when the active main session changes
  // (switched sessions, or a send just minted a fresh harness-bound one).
  // Keeps the empty-composer picker from leaking a stale choice across
  // sessions.
  useEffect(() => {
    setPendingHarnessId(null);
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
    setQuotedCapabilityIds([]);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAvailableWorkspaceSkills([]);
      setAvailableWorkspaceCapabilities([]);
      setQuotedSkillIds([]);
      setQuotedCapabilityIds([]);
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
        const [skillsResult, capabilitiesResult] = await Promise.all([
          window.electronAPI.workspace.listSkills(selectedWorkspaceId),
          remoteApi.capabilities.listInstalled({}),
        ]);
        if (cancelled) {
          return;
        }
        const activeCapabilities = capabilitiesResult.capabilities.filter(
          (capability) => capability.status === "active",
        );
        setAvailableWorkspaceSkills(skillsResult.skills);
        setAvailableWorkspaceCapabilities(activeCapabilities);
        setQuotedSkillIds((current) =>
          current.filter((skillId) =>
            skillsResult.skills.some((skill) => skill.skill_id === skillId),
          ),
        );
        setQuotedCapabilityIds((current) =>
          current.filter((capabilityId) =>
            activeCapabilities.some(
              (capability) => capability.capabilityId === capabilityId,
            ),
          ),
        );
      } catch {
        if (!cancelled) {
          setAvailableWorkspaceSkills([]);
          setAvailableWorkspaceCapabilities([]);
          setQuotedSkillIds([]);
          setQuotedCapabilityIds([]);
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
    composerEditorRef.current?.setContent({
      text: composerDraftText,
      skillIds: [],
      capabilityIds: [],
    });
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
      const current = composerEditorRef.current?.getValue() ?? {
        text: input,
        skillIds: quotedSkillIds,
        capabilityIds: quotedCapabilityIds,
      };
      const nextText = appendComposerPrefillText(
        current.text,
        composerPrefillRequest?.text ?? "",
      );
      setInput(nextText);
      composerEditorRef.current?.setContent({
        text: nextText,
        skillIds: current.skillIds,
        capabilityIds: current.capabilityIds,
      });
    } else {
      const parsedPrefill = parseSerializedQuotedSkillPrompt(
        composerPrefillRequest?.text ?? "",
      );
      setInput(parsedPrefill.body);
      setQuotedSkillIds(parsedPrefill.skillIds);
      composerEditorRef.current?.setContent({
        text: parsedPrefill.body,
        skillIds: parsedPrefill.skillIds,
        capabilityIds: [],
      });
      setPendingAttachments([]);
      if (composerPrefillRequest?.autoSubmit) {
        autoSubmitBodyRef.current = parsedPrefill.body;
        setAutoSubmitNonce((n) => n + 1);
      }
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
    composerPrefillRequest?.autoSubmit,
    composerPrefillRequest?.mode,
    composerPrefillRequest?.requestKey,
    composerPrefillRequest?.text,
    onComposerPrefillConsumed,
  ]);

  useEffect(() => {
    if (autoSubmitNonce === 0) {
      return;
    }
    const body = autoSubmitBodyRef.current;
    autoSubmitBodyRef.current = null;
    if (body != null) {
      void sendMessage(body);
    }
  }, [autoSubmitNonce]);

  useEffect(() => {
    const requestKey = localAttachmentRequest?.requestKey ?? 0;
    if (
      requestKey <= 0 ||
      requestKey === lastHandledLocalAttachmentRequestKeyRef.current
    ) {
      return;
    }

    lastHandledLocalAttachmentRequestKeyRef.current = requestKey;
    appendPendingLocalFiles(localAttachmentRequest?.files ?? []);
    onLocalAttachmentRequestConsumed?.(requestKey);
  }, [
    localAttachmentRequest?.files,
    localAttachmentRequest?.requestKey,
    onLocalAttachmentRequestConsumed,
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
    const frameId = window.requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
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
      blankDraftActiveRef.current = false;
      loadedSessionViewWorkspaceIdRef.current = "";
      return;
    }

    const normalizedWorkspaceId = selectedWorkspaceId.trim();
    if (loadedSessionViewWorkspaceIdRef.current !== normalizedWorkspaceId) {
      // Drop the previous workspace's messages, outputs, live turn etc.
      // synchronously before kicking off the async history load. Without
      // this, the chat pane shows the old workspace's last conversation
      // for a frame or two while the new history is in flight.
      cancelHistoryViewportRestore();
      clearSessionView();
      setActiveSession(null);
      setActiveSessionReadOnly(false);
      setDesktopMainSession(null);
      pendingInputIdRef.current = null;
      draftParentSessionIdRef.current = null;
      blankDraftActiveRef.current = false;
      loadedSessionViewWorkspaceIdRef.current = normalizedWorkspaceId;
    }

    if (hasActiveWebAppSurface) {
      // A HolaApp surface owns its chat: opening the app resumed the app's own
      // session (or a fresh draft) via useOpenHolaAppDraftChat. Once that
      // request is consumed, isExternalSessionOpenRequest flips back to false
      // and re-runs this effect — without this guard it would load the
      // workspace main session over the just-resumed app session.
      return;
    }

    if (isEmbeddedVariant && isExternalSessionOpenRequest) {
      // When the embedded variant is driven by an external `sessionOpenRequest`
      // (e.g. AddPluginDialog hosting the plugin onboarding chat), the
      // dedicated effect below loads the requested session. Skip the
      // main-session fallback so it doesn't race with the requested-session
      // load. The regular workspace ChatPanel also
      // uses `variant="embedded"` but passes a null request until the user
      // jumps somewhere, so it must still fall through to the main session.
      return;
    }

    if (blankDraftActiveRef.current) {
      // A blank "New chat" draft is showing — don't load the workspace main
      // session over it. The draft clears on send or when a session opens.
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

        const [runtimeStates, mainSessionResponse] = await Promise.all([
          window.electronAPI.workspace.listRuntimeStates(selectedWorkspaceId),
          // Resolve-only: don't create a placeholder on entry. When the
          // workspace has no chat yet, open a lazy draft (created on first
          // send) rather than persisting an empty "Untitled" session row.
          window.electronAPI.workspace.ensureMainSession(selectedWorkspaceId, {
            create: false,
          }),
        ]);
        if (cancelled) {
          return;
        }
        setDesktopMainSession(mainSessionResponse.session ?? null);

        const resolvedSessionId =
          (hasSessionJumpRequest && requestedSessionId
            ? requestedSessionId
            : null) ||
          mainSessionResponse.session?.session_id?.trim() ||
          null;

        if (!resolvedSessionId) {
          // Nothing to resume → blank draft. The session is created on the
          // first sent message (same path as the "New chat" button), so no
          // empty row exists until the user actually writes something.
          setActiveSessionReadOnly(false);
          blankDraftActiveRef.current = true;
          draftParentSessionIdRef.current = null;
          pendingInputIdRef.current = null;
          clearSessionView();
          setActiveSession(null);
          requestHistoryViewportRestore();
          historyLoaded = true;
          return;
        }

        blankDraftActiveRef.current = false;
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
    hasActiveWebAppSurface,
    isEmbeddedVariant,
    isExternalSessionOpenRequest,
    sessionJumpRequestKey,
    sessionJumpSessionId,
    selectedWorkspaceId,
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
    const requestedClearComposer =
      effectiveSessionOpenRequest?.clearComposer === true;
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

      // Same-session open request: this happens when an external surface
      // (e.g. the @ button on a record dashboard) stages an entity into
      // the currently active session. The attachment + composer prefill
      // arrive via their own atoms; the session itself is already loaded
      // and may have an in-flight assistant stream. Skip the destructive
      // reset path below so we don't abort the stream or wipe composer
      // state for a "navigation" the user didn't make.
      if (
        requestMode === "session" &&
        requestedSessionId &&
        activeSessionIdRef.current === requestedSessionId
      ) {
        setActiveSessionReadOnly(requestedReadOnly);
        consumeSessionOpenRequest(requestKey);
        return;
      }

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
          blankDraftActiveRef.current = true;
          clearSessionView();
          setActiveSession(null);
          pendingInputIdRef.current = null;
          // A blank "+ New chat" starts clean — never carry the previous
          // conversation's unsent draft or paused-run input into it. A
          // prefill-driven draft (e.g. schedule edit) keeps its seeded content.
          if (requestedClearComposer) {
            setInput("");
            setQuotedSkillIds([]);
            setQuotedCapabilityIds([]);
            setQuotedIntegrationSlugs([]);
            composerEditorRef.current?.clear();
            setPendingAttachments([]);
            setAttachmentGateMessage("");
            setChatErrorMessage("");
          }
          requestHistoryViewportRestore();
          historyLoaded = true;
          return;
        }

        blankDraftActiveRef.current = false;

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
              // The main process's own timestamp, not the moment we merged it.
              at: entry.at.slice(11, 23),
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

  const refreshWorkspaceIssues = useCallback(
    async (workspaceId: string, signal?: { cancelled: boolean }) => {
      try {
        const response =
          await window.electronAPI.workspace.listIssues(workspaceId);
        if (!signal?.cancelled) {
          setWorkspaceIssues(response.issues);
        }
      } catch {
        if (!signal?.cancelled) {
          setWorkspaceIssues([]);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setWorkspaceIssues([]);
      return () => {
        // no-op cleanup for symmetry with the subscribed branch below
      };
    }
    const signal = { cancelled: false };
    void refreshWorkspaceIssues(selectedWorkspaceId, signal);
    const timer = window.setInterval(() => {
      void refreshWorkspaceIssues(selectedWorkspaceId, signal);
    }, 5000);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshWorkspaceIssues, selectedWorkspaceId]);

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
            ? rawUnresolved.filter(
                (slug): slug is string =>
                  typeof slug === "string" && slug.trim().length > 0,
              )
            : [];
          setPendingIntegrationsWait({
            unresolvedSlugs,
            sessionId: eventSessionId,
          });
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
          // Commit the live turn here, exactly as the run_completed path does.
          // Without this the turn is still only live state when the 150ms
          // refresh lands, and that refresh both replaces `messages` with the
          // server's list (which has not persisted the turn yet) AND calls
          // resetLiveTurn() — so the turn belongs to neither and vanishes for
          // ~350ms until the 500ms rung. That is the end-of-response flicker:
          // preserveCommittedAssistantTurns cannot hold what was never
          // committed, so the earlier fix only ever covered the run_completed
          // path. Whichever terminal signal arrives first now commits.
          //
          // MUST run before activeAssistantMessageIdRef is cleared: the commit
          // derives the message id from it, and that id has to equal the
          // server's `assistant-${inputId}` or the held copy never settles and
          // shows up as a duplicate instead of a flicker.
          //
          // Safe to have both paths commit: commitLiveAssistantMessage resets
          // the live refs, so the second call finds no segments and no-ops.
          const committedAssistantMessage = commitLiveAssistantMessage();
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
            scheduleConversationRefresh(refreshSessionId, selectedWorkspaceId, {
              awaitAssistantMessageId: committedAssistantMessage,
            });
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
          {
            showContextBudgetDiagnostics: verboseTelemetryEnabled,
          },
        );
        if (phaseStep) {
          const suppressAwaitingUser =
            phaseStep.id === "phase:awaiting-user" &&
            askUserQuestionPendingRef.current;
          if (phaseStep.id === "phase:awaiting-user") {
            askUserQuestionPendingRef.current = false;
          }
          if (
            !suppressAwaitingUser &&
            (!isBootstrapPhaseTraceStepId(phaseStep.id) ||
              shouldShowBootstrapPhaseTraceForSession(eventSessionId))
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
        if (
          eventType === "tool_call" ||
          eventType === "tool_completed"
        ) {
          const toolName =
            typeof eventPayload.tool_name === "string"
              ? eventPayload.tool_name.trim().toLowerCase()
              : "";
          const toolPhase =
            typeof eventPayload.phase === "string"
              ? eventPayload.phase.trim().toLowerCase()
              : "";
          const isCompletion =
            eventType === "tool_completed" || toolPhase === "completed";
          if (
            isCompletion &&
            eventPayload.error !== true &&
            isPublishPostTool(toolName)
          ) {
            reportFirstPostPublishedOnce(() =>
              queryClient.invalidateQueries({ queryKey: ["rewards"] }),
            );
          }
          if (
            toolName === "ask_user_question" &&
            isCompletion &&
            eventPayload.error !== true &&
            selectedWorkspaceId
          ) {
            askUserQuestionPendingRef.current = true;
            const targetSessionId = eventSessionId.trim();
            const boundMainSessionId = (
              desktopMainSession?.session_id || ""
            ).trim();
            if (
              !targetSessionId ||
              targetSessionId === boundMainSessionId
            ) {
              void window.electronAPI.workspace
                .ensureMainSession(selectedWorkspaceId, { create: false })
                .then((ensured) => {
                  if (ensured?.session) {
                    setDesktopMainSession(ensured.session);
                  }
                })
                .catch(() => undefined);
            } else {
              // Externally-driven session (e.g. plugin onboarding chat
              // in AddPluginDialog): refresh that session's record so
              // its `active_user_question` reaches the alignment card.
              void window.electronAPI.workspace
                .listAgentSessions({
                  workspaceId: selectedWorkspaceId,
                  includeArchived: true,
                })
                .then((response) => {
                  const match = response.items.find(
                    (item) => item.session_id === targetSessionId,
                  );
                  if (match) {
                    upsertSessionRecordOverride(match);
                  }
                })
                .catch(() => undefined);
            }
          }
        }

        if (eventType === "auto_retry_start") {
          // pi is retrying the failed last message in-turn (it dropped that
          // message from its own state and will re-stream it). Discard the
          // failed attempt's in-progress streamed text so the retried deltas
          // don't concatenate onto the truncated partial in the same bubble.
          resetLiveOutputForRetry();
          appendStreamTelemetry({
            streamId: payload.streamId,
            transportType: payload.type,
            eventName,
            eventType,
            inputId: eventInputId,
            sessionId: eventSessionId,
            action: "reset_live_output_on_retry",
            detail: "auto_retry_start",
          });
          return;
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
          if (selectedWorkspaceId) {
            void window.electronAPI.workspace
              .ensureMainSession(selectedWorkspaceId, { create: false })
              .then((ensured) => {
                if (ensured?.session) {
                  setDesktopMainSession(ensured.session);
                }
              })
              .catch(() => undefined);
          }
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
          scheduleConversationRefresh(eventSessionId, selectedWorkspaceId, {
            awaitAssistantMessageId: committedAssistantMessage,
          });
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
    verboseTelemetryEnabled,
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
        scheduleConversationRefresh(
          normalizedCurrentSessionId,
          selectedWorkspaceId,
        );
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
    const currentSessionId = (
      activeSessionIdRef.current ||
      activeSessionId ||
      ""
    ).trim();
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
            cancelled ||
            (activeSessionIdRef.current || "").trim() !== mainSessionId,
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
        quotedSkillIds.length === 0 &&
        quotedIntegrationSlugs.length === 0) ||
      isSubmittingMessage
    ) {
      return;
    }
    // Time-to-first-token has to be measured from the user's action, not from
    // the stream open — everything before the open (queueing the input, the
    // round trip that returns an input_id) is time they are staring at an empty
    // canvas. Without this milestone the timeline silently starts late and the
    // slowest phase can hide in front of it. The input id is unknown here, so
    // this is stamped bare and stitched to the turn by arrival order.
    appendStreamTelemetry({
      streamId: "",
      transportType: "user",
      eventName: "submit",
      eventType: "submit",
      inputId: "",
      sessionId: activeSessionIdRef.current ?? "",
      action: "submit",
      detail: `chars=${trimmed.length}`,
    });
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
    // App readiness never blocks chat: the agent is how a stuck or failing app
    // gets fixed or removed, so the composer must stay reachable while apps
    // initialize in the background. Readiness surfaces as a non-blocking banner.
    if (!isOnboardingVariant && !resolvedChatModel) {
      setChatErrorMessage(
        modelSelectionUnavailableReason || "No models available.",
      );
      return;
    }
    if (pendingImageInputUnsupportedMessage) {
      return;
    }
    // Typing a normal message while an ask_user_question card is open answers it
    // by superseding it — the user chose to reply in prose instead of picking an
    // option. Clear the pending question locally so its card unmounts at once;
    // the runtime clears the stored question when this input is enqueued. Mirrors
    // handleAnswerUserQuestion's local clear.
    const supersededQuestionRecord = activeSessionRecord;
    if (supersededQuestionRecord?.active_user_question) {
      const cleared = {
        ...supersededQuestionRecord,
        active_user_question: null,
      };
      if (
        cleared.session_id.trim() ===
        (desktopMainSession?.session_id || "").trim()
      ) {
        setDesktopMainSession(cleared);
      } else {
        upsertSessionRecordOverride(cleared);
      }
    }
    const pendingSessionTarget = pendingSessionTargetForSend();
    let targetSessionId =
      pendingSessionTarget?.mode === "session"
        ? pendingSessionTarget.sessionId
        : activeSessionIdRef.current;

    if (pendingSessionTarget) {
      consumeSessionOpenRequest(pendingSessionTarget.requestKey);
      // Hold the outgoing conversation on screen until this send has its own
      // first message to replace it with. Creating the session is an IPC round
      // trip, and blanking before it leaves the canvas empty for the whole of
      // it. The swap happens where the optimistic user message is appended.
      pendingSessionSwapRef.current = true;
      clearSessionView({ keepMessages: true });
      if (pendingSessionTarget.mode === "session") {
        setActiveSession(pendingSessionTarget.sessionId);
      } else {
        draftParentSessionIdRef.current = pendingSessionTarget.parentSessionId;
        setActiveSession(null);
      }
    }

    // Bind a freshly-started chat to the harness the composer is SHOWING.
    // Rather than mutate a resumed session's harness (immutable once it has run
    // a turn — the source of the "input(s) already queued" 409), mint a fresh
    // main session bound to the chosen harness and send into that. Two cases:
    //   1. New top-level chat (blank "New chat" draft / empty composer). The
    //      picker shows currentSessionHarnessId = pendingHarnessId (explicit
    //      pick) ?? the harness carried over from the last session ?? "pi", so
    //      the created session must resolve the harness the same way. Previously
    //      this only fired on an explicit pick that DIFFERED from the lingering
    //      session, so a carried-over codex (still shown because a blank draft
    //      never clears desktopMainSession) silently became the default Hola
    //      session — and even re-picking codex failed the "differs" check. We
    //      skip the mint only when the effective harness is the default "pi",
    //      since the plain createWorkspaceSession path below already yields one.
    //   2. Switching harness on a resumed session: an explicit pick differing
    //      from the running session's harness.
    // Never hijacks an explicit session/draft jump.
    // A draft persisted while a HolaApp surface is open belongs to that app: it's
    // stamped owning_app_id and is NOT promoted to the workspace's active main
    // session (closing the app restores the workspace session instead).
    const owningAppId = activeWebAppSurface?.holaAppId ?? null;
    const startingFreshTopLevelChat =
      !pendingSessionTarget &&
      !targetSessionId &&
      !draftParentSessionIdRef.current?.trim();
    const harnessForFreshChat =
      pendingHarnessId ?? desktopMainSession?.harness_id ?? "pi";
    let harnessForNewSession: string | null = null;
    if (!pendingSessionTarget && selectedWorkspace) {
      if (startingFreshTopLevelChat) {
        harnessForNewSession =
          harnessForFreshChat === "pi" ? null : harnessForFreshChat;
      } else if (
        pendingHarnessId &&
        pendingHarnessId !== (desktopMainSession?.harness_id ?? "pi")
      ) {
        harnessForNewSession = pendingHarnessId;
      }
    }
    if (harnessForNewSession && selectedWorkspace) {
      try {
        const created = await window.electronAPI.workspace.createMainSession(
          selectedWorkspace.id,
          startingFreshTopLevelChat
            ? {
                harness_id: harnessForNewSession,
                project_id: selectedChatProjectId ?? null,
                app_id: owningAppId ?? undefined,
              }
            : { harness_id: harnessForNewSession, app_id: owningAppId ?? undefined },
        );
        if (created.session) {
          targetSessionId = created.session.session_id;
          draftParentSessionIdRef.current = null;
          // An app session is not the workspace's main session, so don't adopt
          // it as the desktop main.
          if (!owningAppId) {
            setDesktopMainSession(created.session);
          }
          notifyMainSessionsChanged();
          setActiveSession(targetSessionId);
          setSidebarSelectedSessionId(targetSessionId);
          setSelectedSessionForWorkspace(
            selectedWorkspace.id,
            targetSessionId,
          );
          trackUmamiEvent("agent_session_started", {
            workspace_id: selectedWorkspace.id,
          });
        }
      } catch (error) {
        setChatErrorMessage(normalizeErrorMessage(error));
        // The swap never happened, so the held-over conversation belongs to a
        // session we are no longer in. Blank it now rather than leave it under
        // the wrong session.
        settlePendingSessionSwap();
        return;
      }
    }
    setPendingHarnessId(null);

    if (!targetSessionId && selectedWorkspace) {
      const draftParentSessionId =
        pendingSessionTarget?.mode === "draft"
          ? pendingSessionTarget.parentSessionId
          : draftParentSessionIdRef.current;
      targetSessionId = await createWorkspaceSession(
        selectedWorkspace.id,
        draftParentSessionId,
        selectedChatProjectId,
        owningAppId,
        text,
      );
      if (targetSessionId) {
        draftParentSessionIdRef.current = null;
        setActiveSession(targetSessionId);
        setSidebarSelectedSessionId(targetSessionId);
        trackUmamiEvent("agent_session_started", {
          workspace_id: selectedWorkspace.id,
        });
        // Promote a top-level draft to the active main session so reloads
        // (ensure-main-session) resume here, not the previously-bound session.
        // App sessions are exempt — they belong to the app, not the workspace.
        if (!draftParentSessionId?.trim() && !owningAppId) {
          try {
            const activated =
              await window.electronAPI.workspace.activateMainSession(
                selectedWorkspace.id,
                targetSessionId,
              );
            if (activated.session) {
              setDesktopMainSession(activated.session);
            }
            setSelectedSessionForWorkspace(
              selectedWorkspace.id,
              targetSessionId,
            );
          } catch {
            // non-fatal — the session exists and is selected client-side
          }
        }
      }
    }
    if (!targetSessionId) {
      setChatErrorMessage("No active session found for this workspace.");
      settlePendingSessionSwap();
      return;
    }
    blankDraftActiveRef.current = false;
    const mainSessionIdForWorkspace = (
      desktopMainSessionIdRef.current ||
      desktopMainSession?.session_id ||
      ""
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

    // Captured before the composer is cleared below. The clear happens
    // optimistically, ahead of the network call, so without this a failed send
    // destroyed whatever the user had typed and staged.
    const composerSnapshot = {
      text,
      skillIds: quotedSkillIds,
      capabilityIds: quotedCapabilityIds,
      integrationSlugs: quotedIntegrationSlugs,
      attachments: pendingAttachments,
    };
    // Once the runtime has accepted the input the turn exists and will run, so
    // the composer must NOT be repopulated — that would invite a duplicate send.
    let queueAccepted = false;

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
      // app-context entries aren't files — they fold into the message text
      // below, so only the file entries get staged here.
      const fileEntries = attachmentEntries.filter(
        (
          entry,
        ): entry is PendingLocalAttachmentFile | PendingExplorerAttachmentFile =>
          entry.source === "local-file" || entry.source === "explorer-path",
      );
      const stagedExplicitAttachments = fileEntries.map((entry) => {
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

      // app-context pills carry pre-serialized context (refs + MCP hint +
      // optional snapshot). It's sent to the AGENT — the runtime folds it into
      // the turn instruction (instructionWithAppContext) — but kept OUT of the
      // visible + persisted user message via `app_context_text` below, because
      // it's ambient, not something the user typed.
      const appContextEntries = attachmentEntries.filter(
        (entry): entry is PendingAppContextAttachment =>
          entry.source === "app-context",
      );
      const expandedQuoted = expandCapabilitiesIntoQuoted({
        skillIds: quotedSkillIds,
        integrationSlugs: quotedIntegrationSlugs,
        capabilityIds: quotedCapabilityIds,
        capabilities: availableWorkspaceCapabilities,
        slugForProvider: composioToolkitSlugForProvider,
      });
      const serializedPrompt = serializeQuotedPrompt(
        trimmed,
        expandedQuoted.skillIds,
        expandedQuoted.integrationSlugs,
      );
      const appContextBlocks = appContextEntries
        .map((entry) => entry.contextText.trim())
        .filter(Boolean);
      // When no app-context pill grounds the turn but a HolaApp surface is open
      // (e.g. a third-party bundle like Notion that can't push a card), the shell
      // supplies the open-surface context on its behalf — same agent-only,
      // hidden-from-bubble treatment.
      if (
        appContextBlocks.length === 0 &&
        showSurfaceContext &&
        activeWebAppSurface
      ) {
        const surfaceContext = activeSurfaceContextText(
          activeWebAppSurface,
        ).trim();
        if (surfaceContext) {
          appContextBlocks.push(surfaceContext);
        }
      }
      const appContextText = appContextBlocks.join("\n\n");
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
      // A pending swap means the list still holds the PREVIOUS session's
      // conversation, kept there so the canvas never went blank. Consumed
      // unconditionally: queueing onto an active run takes the branch below
      // that adds no message, and a flag left set would make the NEXT send
      // replace a conversation it should have appended to.
      const swapping = pendingSessionSwapRef.current;
      pendingSessionSwapRef.current = false;
      if (!queueOntoActiveRun) {
        setMessages((prev) => (swapping ? [userMessage] : [...prev, userMessage]));
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
      setQuotedCapabilityIds([]);
      composerEditorRef.current?.clear();
      setQuotedIntegrationSlugs([]);
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
        app_context_text: appContextText || null,
        workspace_id: selectedWorkspace.id,
        image_urls: null,
        attachments: stagedAttachments,
        session_id: targetSessionId,
        priority: 0,
        model: dispatchedChatModel,
        thinking_value: dispatchedThinkingValue,
      });
      queueAccepted = true;
      rememberSubmittedComposerInput(text, selectedWorkspace.id);
      setActiveSession(queued.session_id);
      // The sidebar hides sessions with no title — a titleless session is an
      // empty placeholder there — and the title is derived server-side from
      // this first user message, by the queue-input route we just called. So
      // broadcasting at creation was a step too early: the reload came back
      // with the session still untitled and the sidebar rightly filtered it
      // out, leaving the row to wait for the next 5s poll anyway. This is the
      // first moment the row can actually render.
      notifyMainSessionsChanged();
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
      if (!queueAccepted) {
        // Nothing was queued, so put the user's message back rather than
        // making them retype it and re-attach their files.
        //
        // But the composer was cleared optimistically and this failure can
        // land seconds later — long enough for someone watching a hung send
        // to start typing again. Overwriting THAT is the same data loss in
        // the other direction, so the live draft wins and the failed text
        // becomes recallable (⌥↑) instead of being restored over it.
        const composerStillEmpty =
          composerEditorRef.current?.isEmpty() !== false;
        if (composerStillEmpty) {
          setInput(composerSnapshot.text);
          setQuotedSkillIds(composerSnapshot.skillIds);
          setQuotedCapabilityIds(composerSnapshot.capabilityIds);
          setQuotedIntegrationSlugs(composerSnapshot.integrationSlugs);
          composerEditorRef.current?.setContent({
            text: composerSnapshot.text,
            skillIds: composerSnapshot.skillIds,
            capabilityIds: composerSnapshot.capabilityIds,
          });
        } else {
          rememberSubmittedComposerInput(
            composerSnapshot.text,
            selectedWorkspace.id,
          );
        }
        // Attachments restore independently of the text: re-staging files
        // cannot overwrite anything typed, and dropping them would mean
        // re-dragging every one.
        setPendingAttachments((current) =>
          current.length === 0 ? composerSnapshot.attachments : current,
        );
      }
      // Only retract the optimistic bubble when nothing was queued. Past that
      // point the runtime has the input and the turn will run, so removing it
      // showed the user their message vanishing from a conversation the agent
      // was already answering -- and invited them to send it twice.
      if (!queueAccepted && !queueOntoActiveRun && optimisticUserMessageId) {
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

    // Don't dispatch "continue" until EVERY (app, provider) the agent
    // surfaced this turn has a matching app binding. Otherwise binding the
    // first card immediately resumes the agent, which then hits a missing-
    // grant error on the still-unbound providers (e.g. user clicks Twitter
    // → continue → agent tries Gmail → "no Gmail token"). The frontier set
    // is the most recent assistant message that emitted pending entries —
    // older messages were already resolved or superseded.
    const frontier = findFrontierPendingIntegrations(messages);
    if (frontier.length > 0) {
      try {
        const { bindings } =
          await window.electronAPI.workspace.listIntegrationBindings(
            selectedWorkspaceId,
          );
        const stillUnbound = frontier.filter((entry) => {
          const entryApp = entry.app_id.trim().toLowerCase();
          const entryProvider = entry.provider_id.trim().toLowerCase();
          return !bindings.some(
            (b) =>
              b.target_type === "app" &&
              b.target_id.trim().toLowerCase() === entryApp &&
              composioToolkitMatchesProvider(b.integration_key, entryProvider),
          );
        });
        if (stillUnbound.length > 0) {
          // More cards to go — leave the assistant turn paused so the user
          // can complete the remaining ones. The next onAfterBind will
          // re-evaluate.
          return;
        }
      } catch {
        // Treat the listing failure as "best-effort continue" — better to
        // run the agent and surface a real error than to wedge here.
      }
    }

    try {
      await window.electronAPI.workspace.queueSessionInput({
        workspace_id: selectedWorkspaceId,
        session_id: sessionId,
        text: "continue",
        image_urls: null,
        attachments: [],
        priority: 0,
        model: dispatchedChatModel,
        thinking_value: dispatchedThinkingValue,
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
      await window.electronAPI.workspace.composioMcpEnsureRunning(
        selectedWorkspaceId,
      );
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
        model: dispatchedChatModel,
        thinking_value: dispatchedThinkingValue,
      });
    } catch {
      /* non-fatal */
    }
  }

  // After the user authorizes a remote MCP server from the inline card, auto-
  // continue the turn (like the integration Connect cards) so its tools get
  // discovered and the agent proceeds — instead of the user having to send a
  // throwaway message. The authorize flow already busted the tool cache, so the
  // queued turn re-discovers with the fresh token.
  async function handleAfterMcpAuthorized(serverId: string) {
    const sessionId = activeSessionIdRef.current || activeSessionId;
    if (!selectedWorkspaceId || !sessionId) {
      return;
    }
    try {
      await window.electronAPI.workspace.queueSessionInput({
        workspace_id: selectedWorkspaceId,
        session_id: sessionId,
        text: `[system] The '${serverId}' MCP server is now authorized and its tools are available — you can call them now.`,
        image_urls: null,
        attachments: [],
        priority: 0,
        model: dispatchedChatModel,
        thinking_value: dispatchedThinkingValue,
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
        : serializeQuotedPrompt(nextText, parsedQuotedSkills.skillIds);
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

    const maxAttachmentBytes = 100 * 1024 * 1024;
    const maxAttachmentCount = 50;
    const acceptedFiles: File[] = [];
    let rejectedImageCount = 0;
    let oversizedCount = 0;
    for (const file of files) {
      if (
        !selectedModelSupportsImageInput &&
        attachmentLooksLikeImage(file.name, file.type)
      ) {
        rejectedImageCount += 1;
        continue;
      }
      if (file.size > maxAttachmentBytes) {
        oversizedCount += 1;
        continue;
      }
      acceptedFiles.push(file);
    }

    const remainingSlots = Math.max(
      0,
      maxAttachmentCount - pendingAttachments.length,
    );
    const filesToAdd = acceptedFiles.slice(0, remainingSlots);
    const overflowCount = acceptedFiles.length - filesToAdd.length;

    const gateParts: string[] = [];
    if (rejectedImageCount > 0) {
      gateParts.push(
        `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`,
      );
    }
    if (oversizedCount > 0) {
      gateParts.push(
        `Skipped ${oversizedCount} file${oversizedCount === 1 ? "" : "s"} over 100MB.`,
      );
    }
    if (overflowCount > 0) {
      gateParts.push(
        `Limit ${maxAttachmentCount} attachments — skipped ${overflowCount}.`,
      );
    }
    setAttachmentGateMessage(gateParts.join(" "));

    if (filesToAdd.length === 0) {
      return;
    }

    setPendingAttachments((prev) => [
      ...prev,
      ...filesToAdd.map((file) => ({
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

  function appendPendingAppContextAttachments(
    items: { appName: string; title: string; contextText: string }[],
  ) {
    const accepted = items.filter((item) => item.contextText.trim().length > 0);
    if (accepted.length === 0) {
      return;
    }
    setPendingAttachments((prev) => [
      ...prev,
      ...accepted.map((item) => ({
        id: pendingAttachmentId(`app-context-${item.appName}-${item.title}`),
        source: "app-context" as const,
        appName: item.appName,
        title: item.title,
        contextText: item.contextText,
      })),
    ]);
  }

  // App-context pills are bound to the chat they were handed into (the host
  // openChat / "Discuss" flow). Any OTHER navigation — a sidebar session switch
  // or a blank "New chat" — must not carry them over, so drop them whenever the
  // selected session changes. A genuine handoff sets a fresh
  // appContextAttachmentRequest in the SAME render batch, and the effect just
  // below (defined after this one, so it runs second) re-adds the pill for the
  // session it opened.
  useEffect(() => {
    setPendingAttachments((prev) =>
      prev.some((attachment) => attachment.source === "app-context")
        ? prev.filter((attachment) => attachment.source !== "app-context")
        : prev,
    );
  }, [sidebarSelectedSessionId]);

  useEffect(() => {
    const requestKey = appContextAttachmentRequest?.requestKey ?? 0;
    if (
      requestKey <= 0 ||
      requestKey === lastHandledAppContextAttachmentRequestKeyRef.current
    ) {
      return;
    }

    lastHandledAppContextAttachmentRequestKeyRef.current = requestKey;
    appendPendingAppContextAttachments(appContextAttachmentRequest?.items ?? []);
    onAppContextAttachmentRequestConsumed?.(requestKey);
  }, [
    appContextAttachmentRequest?.items,
    appContextAttachmentRequest?.requestKey,
    onAppContextAttachmentRequestConsumed,
  ]);

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

  // Removing the surface-context chip dismisses it for the current page (it
  // reappears on navigation); other ids are real pending attachments.
  function removeComposerAttachment(attachmentId: string) {
    if (attachmentId === SURFACE_CONTEXT_ATTACHMENT_ID) {
      setDismissedSurfaceContextKey(activeSurfaceContextKey);
      return;
    }
    removePendingAttachment(attachmentId);
  }

  function addQuotedIntegration(slug: string) {
    setQuotedIntegrationSlugs((current) =>
      current.includes(slug) ? current : [...current, slug],
    );
  }

  function removeQuotedIntegration(slug: string) {
    setQuotedIntegrationSlugs((current) =>
      current.filter((entry) => entry !== slug),
    );
  }

  const handleComposerValueChange = (value: ComposerValue) => {
    setInput(value.text);
    setQuotedSkillIds(value.skillIds);
    setQuotedCapabilityIds(value.capabilityIds);
  };

  // Image/Video modes are mutually exclusive; append the active mode's
  // settings so the media tool honors the chosen params.
  const decorateForMediaMode = (value: string) => {
    if (imageComposerMode) {
      return value + imageSettingsSuffix(imageGenParams);
    }
    if (videoComposerMode) {
      return value + videoSettingsSuffix(videoGenParams);
    }
    return value;
  };

  // Escape hatch for the pending-integration wait: tell the runtime the user
  // skipped these proposals so the gate stops blocking and the deferred turn
  // resumes. Clears the banner optimistically.
  const handleSkipPendingIntegrations = () => {
    const wait = pendingIntegrationsWait;
    const workspaceId = selectedWorkspace?.id;
    if (!wait || !workspaceId || wait.unresolvedSlugs.length === 0) {
      return;
    }
    setPendingIntegrationsWait(null);
    void declineIntegrationProposals({
      workspaceId,
      sessionId: wait.sessionId,
      slugs: wait.unresolvedSlugs,
    }).catch(() => {
      // Best-effort: a later waiting event will re-surface the banner to retry.
    });
  };

  const submitComposer = () => {
    void sendMessage(decorateForMediaMode(input));
    if (scheduleEditContext) {
      onScheduleEditContextDismiss?.();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(decorateForMediaMode(input));
    // Schedule-edit context is one-shot: keep it visible while the user is
    // composing the edit, but clear it once they actually send so the next
    // message in the same session isn't anchored to a stale schedule.
    if (scheduleEditContext) {
      onScheduleEditContextDismiss?.();
    }
  };

  const openMainSession = async () => {
    let mainSessionId = (desktopMainSession?.session_id || "").trim();
    if (!mainSessionId && selectedWorkspaceId?.trim()) {
      try {
        // Resolve-only — never create an empty session just to open the pane.
        const ensured =
          await window.electronAPI.workspace.ensureMainSession(
            selectedWorkspaceId,
            { create: false },
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
      // No persisted chat yet → open a blank draft (created on first send)
      // rather than materializing an "Untitled" session row.
      setDesktopMainSession(null);
      setActiveSessionReadOnly(false);
      blankDraftActiveRef.current = true;
      draftParentSessionIdRef.current = null;
      pendingInputIdRef.current = null;
      clearSessionView();
      setActiveSession(null);
      return;
    }
    setLocalSessionOpenRequestState({
      sessionId: mainSessionId,
      requestKey: Date.now(),
      readOnly: false,
    });
  };

  const dispatchSessionOpenRequest = (
    request: ChatPaneSessionOpenRequest,
  ) => {
    // The new shell (ChatPanel) listens to chatSessionOpenRequestAtom and
    // forwards it via the sessionOpenRequest prop. Legacy standalone
    // mounts ignore the atom and read localSessionOpenRequest instead.
    // Fire both so the picker works in either layout — `effectiveSessionOpenRequest`
    // prefers the external (atom-driven) one when present.
    setGlobalChatSessionOpenRequest({
      sessionId: request.sessionId,
      requestKey: request.requestKey,
      mode: request.mode ?? "session",
      parentSessionId: request.parentSessionId ?? null,
      readOnly: request.readOnly ?? false,
    });
    setLocalSessionOpenRequestState(request);
  };

  const handleSwitchMainSession = async (sessionId: string) => {
    const workspaceId = (selectedWorkspaceId || "").trim();
    const targetId = sessionId.trim();
    if (!workspaceId || !targetId) {
      return;
    }
    try {
      const response =
        await window.electronAPI.workspace.activateMainSession(
          workspaceId,
          targetId,
        );
      if (response.session) {
        setDesktopMainSession(response.session);
      }
      setSelectedSessionForWorkspace(workspaceId, targetId);
      dispatchSessionOpenRequest({
        sessionId: targetId,
        requestKey: Date.now(),
        readOnly: false,
      });
    } catch (error) {
      setChatErrorMessage(normalizeErrorMessage(error));
    }
  };

  // Surfaces a small picker before creating the new chat so the
  // harness_id is bound from the first row write — same rationale as
  // Sidebar's "+ New chat" dropdown: the runtime treats harness_id as
  // immutable once an input is queued, so post-create rebinding is
  // brittle. When the harness inventory hasn't loaded the helper just
  // falls through with `harness_id: undefined` and the runtime picks
  // the workspace default.
  const handleCreateMainSession = async (harnessId?: string) => {
    const workspaceId = (selectedWorkspaceId || "").trim();
    if (!workspaceId) {
      return;
    }
    try {
      const response =
        await window.electronAPI.workspace.createMainSession(workspaceId, {
          ...(harnessId ? { harness_id: harnessId } : {}),
        });
      const created = response.session;
      if (!created) {
        return;
      }
      setDesktopMainSession(created);
      setSelectedSessionForWorkspace(workspaceId, created.session_id);
      dispatchSessionOpenRequest({
        sessionId: created.session_id,
        requestKey: Date.now(),
        readOnly: false,
      });
    } catch (error) {
      setChatErrorMessage(normalizeErrorMessage(error));
    }
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

  const openIssueDetailTab = useOpenIssueDetailTab();
  // Subtle in-chat entry back into a spawned task's detail (its issue tab).
  // The message reference carries the issue id, not session ids — so open the
  // detail directly rather than routing through a synthetic task record.
  const handleOpenBackgroundTaskReference = useCallback(
    (reference: ChatBackgroundTaskReference) => {
      const issueId =
        reference.issueId?.trim() || reference.sourceId?.trim() || "";
      const targetWorkspaceId =
        reference.workspaceId?.trim() || selectedWorkspaceId || "";
      if (!issueId || !targetWorkspaceId) {
        return;
      }
      openIssueDetailTab({
        workspaceId: targetWorkspaceId,
        issueId,
        title: reference.title,
      });
    },
    [openIssueDetailTab, selectedWorkspaceId],
  );

  const handleOpenBackgroundTaskSession = (
    task: BackgroundTaskRecordPayload,
  ) => {
    if (onOpenBackgroundTask?.(task) === true) {
      return;
    }

    const taskMainSessionId =
      task.parent_session_id?.trim() || task.owner_main_session_id.trim() || "";
    if (taskMainSessionId) {
      setLocalSessionOpenRequestState({
        sessionId: taskMainSessionId,
        requestKey: Date.now(),
        readOnly: false,
      });
      return;
    }

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
      source_type: task.source_type?.trim() || null,
      cronjob_id: task.cronjob_id?.trim() || null,
      proposal_id: task.proposal_id?.trim() || null,
      created_by: null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      archived_at: null,
    });
  };

  const assistantMode = assistantMetaLabel(
    selectedWorkspace?.harness,
    runtimeConfig?.defaultModel,
  );
  const showSessionExecutionInternals =
    shouldShowExecutionInternalsForSession(activeSessionId);
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
  // Grouped view. Derived from the same ring the raw view uses, and only ever
  // recomputed when the ring flushes (every 250ms), so the diagnostic cannot
  // become part of the jank it is meant to measure.
  const streamTelemetryTurns = useMemo(
    () => groupStreamTelemetry(streamTelemetry.slice(-400)),
    [streamTelemetry],
  );
  const pendingAttachmentItems = useMemo<AttachmentListItem[]>(
    () =>
      pendingAttachments.map((attachment): AttachmentListItem => {
        if (attachment.source === "local-file") {
          return {
            id: attachment.id,
            kind: attachmentLooksLikeImage(
              attachment.file.name,
              attachment.file.type,
            )
              ? "image"
              : "file",
            name: attachment.file.name,
            size_bytes: attachment.file.size,
            file: attachment.file,
          };
        }
        if (attachment.source === "app-context") {
          // size 0 → no "(N KB)" suffix; the label is just "<app> · <title>".
          return {
            id: attachment.id,
            kind: "file",
            name: `${attachment.appName} · ${attachment.title}`,
            size_bytes: 0,
          };
        }
        return {
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          size_bytes: attachment.size_bytes,
          workspace_path: attachment.absolutePath,
        };
      }),
    [pendingAttachments],
  );

  // Prepend the open HolaApp page as a (derived, non-consumed) attachment chip so
  // the user can see — and remove — the page context the agent receives. Mirrors
  // the Discuss app-context chip look; updates live as the user navigates the app.
  const composerAttachmentItems = useMemo<AttachmentListItem[]>(() => {
    // An explicit Discuss app-context card already grounds the turn (and wins the
    // fold), so don't also show the ambient surface chip — it'd be redundant.
    const hasDiscussContext = pendingAttachments.some(
      (attachment) => attachment.source === "app-context",
    );
    if (!showSurfaceContext || !activeWebAppSurface || hasDiscussContext) {
      return pendingAttachmentItems;
    }
    const pageLabel = activeWebAppSurface.currentTitle?.trim();
    return [
      {
        id: SURFACE_CONTEXT_ATTACHMENT_ID,
        kind: "file",
        name: pageLabel
          ? `${activeWebAppSurface.title} · ${pageLabel}`
          : activeWebAppSurface.title,
        size_bytes: 0,
      },
      ...pendingAttachmentItems,
    ];
  }, [
    showSurfaceContext,
    activeWebAppSurface,
    pendingAttachmentItems,
    pendingAttachments,
  ]);

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

    if (imageAttachmentPreviewRequestIdRef.current !== requestId) {
      if (localObjectUrl) {
        URL.revokeObjectURL(localObjectUrl);
      }
      return;
    }

    setImageAttachmentPreview({
      attachment,
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
      dataUrl: imageDataResult.dataUrl,
      isLoading: false,
      errorMessage: "",
    });
  };

  const availableWorkspaceSkillMap = useMemo(
    () =>
      new Map(
        availableWorkspaceSkills.map(
          (skill) => [skill.skill_id, skill] as const,
        ),
      ),
    [availableWorkspaceSkills],
  );
  // Publish the titles so a skill chip can resolve its own label later — one
  // inserted the instant a skill was installed has only the raw id to show.
  const publishSkillTitles = useSetAtom(publishSkillTitlesAtom);
  useEffect(() => {
    const titles: Record<string, string> = {};
    for (const [skillId, skill] of availableWorkspaceSkillMap) {
      if (skill?.title) {
        titles[skillId] = skill.title;
      }
    }
    publishSkillTitles(titles);
  }, [availableWorkspaceSkillMap, publishSkillTitles]);

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
  const quotedIntegrations = useMemo<ChatComposerQuotedIntegrationItem[]>(
    () =>
      quotedIntegrationSlugs.map((slug) => {
        const toolkit = composioToolkitsByProvider[slug];
        return {
          slug,
          name: toolkit?.name ?? slug,
          logo: toolkit?.logo ?? null,
        };
      }),
    [composioToolkitsByProvider, quotedIntegrationSlugs],
  );
  const slashCommandOptions = useMemo(
    () =>
      buildComposerSlashCommandOptions(
        availableWorkspaceSkills,
        availableWorkspaceCapabilities,
      ),
    [availableWorkspaceSkills, availableWorkspaceCapabilities],
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
  // Hydrate the active session's full record (incl. its harness_id) whenever we
  // only hold its id. Opening a HolaApp surface resumes an app-owned session by
  // id — `useOpenHolaAppDraftChat` keeps only `session_id` from
  // `listMainSessions` and drops the record — so it never lands in
  // `sessionRecordOverrides` and `activeSessionRecord` stays null. That makes
  // the harness avatar/header silently fall back to the Hola ("pi") face
  // (`activeSessionRecord?.harness_id ?? "pi"`) even when the session actually
  // runs on claude-code / codex. Fetching the app's sessions and caching the
  // match keeps the shown harness truthful.
  useEffect(() => {
    const sessionId = activeSessionId.trim();
    const workspaceId = (selectedWorkspaceId || "").trim();
    if (!sessionId || !workspaceId) {
      return;
    }
    if (sessionId === (desktopMainSession?.session_id?.trim() || "")) {
      return;
    }
    if (sessionRecordOverrides[sessionId]) {
      return;
    }
    const appId = activeWebAppSurface?.holaAppId ?? null;
    let cancelled = false;
    void window.electronAPI.workspace
      .listMainSessions(workspaceId, appId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const match = response.sessions?.find(
          (session) => session.session_id.trim() === sessionId,
        );
        if (match) {
          upsertSessionRecordOverride(match);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    selectedWorkspaceId,
    desktopMainSession?.session_id,
    sessionRecordOverrides,
    activeWebAppSurface?.holaAppId,
  ]);
  const activeSessionKind = (activeSessionRecord?.kind || "")
    .trim()
    .toLowerCase();
  const activeUserQuestion = useMemo(
    () => parseActiveUserQuestion(activeSessionRecord?.active_user_question),
    [activeSessionRecord?.active_user_question],
  );
  useEffect(() => {
    if (!activeSessionId.trim()) {
      setSelectedChatProjectId(null);
      return;
    }
    setSelectedChatProjectId(activeSessionRecord?.project_id?.trim() || null);
  }, [activeSessionId, activeSessionRecord?.project_id]);
  const activeIssue = useMemo(() => {
    const normalizedActiveSessionId = activeSessionId.trim();
    if (!normalizedActiveSessionId) {
      return null;
    }
    return (
      workspaceIssues.find(
        (issue) => issue.session_id.trim() === normalizedActiveSessionId,
      ) ?? null
    );
  }, [activeSessionId, workspaceIssues]);
  const isViewingBoundMainSession =
    !activeSessionId ||
    activeSessionId === (desktopMainSession?.session_id || "").trim();
  // Only flag a session as read-only inspection when the caller explicitly
  // opened it that way (handleOpenReadOnlyAgentSession sets
  // sessionOpenRequest.readOnly=true → activeSessionReadOnly=true).
  const isReadOnlyInspectionSession =
    !isViewingBoundMainSession &&
    !isOnboardingVariant &&
    activeSessionReadOnly &&
    !activeIssue;
  const activeSessionTitle = isViewingBoundMainSession
    ? desktopMainSession?.title?.trim() ||
      selectedWorkspace?.name?.trim() ||
      "Main session"
    : activeSessionRecord?.title?.trim() ||
      defaultWorkspaceSessionTitle(activeSessionRecord?.kind, activeSessionId);
  const assistantLabel = activeIssue
    ? "Background agent"
    : isViewingBoundMainSession
      ? "Hola"
      : activeSessionTitle;
  const activeSessionDetail = isViewingBoundMainSession
    ? "Main session"
    : activeIssue
      ? `${activeIssue.status.replace(/_/g, " ")} issue thread`
      : isReadOnlyInspectionSession
        ? `${inspectableSessionLabel(activeSessionRecord)} · Read-only inspection`
        : undefined;
  // The header identity block answers "who am I talking to". For the bound main
  // session AND a live conversation inside a HolaApp (its own resumed session),
  // that's the agent (Hola) — the session's topic already lives in the session
  // switcher above, so repeating it here as the label reads as a confusing
  // "Session f355a03f / Session f355a03f". Only a genuine read-only inspection
  // (or issue thread) labels the block with the session it's inspecting.
  const showsAgentIdentity =
    isViewingBoundMainSession ||
    (hasActiveWebAppSurface && !isReadOnlyInspectionSession && !activeIssue);
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

  const setShareContext = useSetAtom(shareContextAtom);
  useEffect(() => {
    setShareContext({
      messages: displayMessages,
      toolNames: {
        skills: Object.fromEntries(
          [...availableWorkspaceSkillMap.entries()].map(([id, skill]) => [
            id,
            skill?.title ?? id,
          ]),
        ),
        integrations: Object.fromEntries(
          Object.entries(composioToolkitsByProvider).map(([slug, toolkit]) => [
            slug,
            toolkit?.name ?? slug,
          ]),
        ),
      },
    });
  }, [
    displayMessages,
    availableWorkspaceSkillMap,
    composioToolkitsByProvider,
    setShareContext,
  ]);

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
  // Anchor the composer's model on the session being viewed. An EXISTING
  // session (has messages) shows its own committed model — an explicit
  // per-session override, else the runtime's `selected_model` for that session.
  // A fresh/new composer has no bound session, so it falls back to the global
  // `chatModelPreference` that seeds new chats. This is what stops the picker
  // being "universal": opening a scheduled GLM automation now shows GLM, not
  // whatever you last picked elsewhere.
  const activeSessionModelKey = (activeSessionId || "").trim();
  const sessionModelAnchor = hasMessages
    ? perSessionModelOverride[activeSessionModelKey]?.trim() ||
      activeSessionRecord?.selected_model?.trim() ||
      null
    : null;
  const composerModelAnchor = sessionModelAnchor ?? chatModelPreference;
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
            ...(composerModelAnchor !== CHAT_MODEL_USE_RUNTIME_DEFAULT
              ? [composerModelAnchor]
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
  const normalizedModelPreference = composerModelAnchor.trim();
  const modelPreferenceAvailable = hasConfiguredProviderCatalog
    ? normalizedModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : normalizedModelPreference.length > 0 &&
        availableChatModelOptions.some(
          (option) => option.value === normalizedModelPreference,
        )
    : composerModelAnchor === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : availableChatModelOptions.some(
          (option) => option.value === normalizedModelPreference,
        );
  const effectiveChatModelPreference = hasConfiguredProviderCatalog
    ? modelPreferenceAvailable
      ? normalizedModelPreference
      : availableChatModelOptions[0]?.value || ""
    : modelPreferenceAvailable
      ? composerModelAnchor
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
  // The Holaboss model catalogue applies only to pi/Hola, which
  // dispatches through the model proxy. Non-pi harnesses (claude-code,
  // codex) carry their own namespace + reasoning controls:
  //   • Claude:  --effort {low|medium|high}
  //   • Codex:   config.model_reasoning_effort
  // Both accept the same low/medium/high tokens, so the thinking
  // selector stays visible — we just swap its option set.
  // On the empty-composer landing the harness in effect is the user's
  // deferred pick (`pendingHarnessId`), so the model catalogue + dispatch
  // follow it before any session is bound. Once a session is bound the harness
  // is whatever THAT session committed to — read it from the ACTIVE session
  // (which includes an app-owned session), NOT desktopMainSession. An app
  // conversation can run a different harness than the workspace main session,
  // so keying this off the main session showed the wrong catalogue: e.g. a
  // claude-code app session got the Hola model list and let a GPT model the
  // harness can't run be picked, which then fails at dispatch with "issue with
  // the selected model". desktopMainSession stays the final fallback for the
  // main session itself.
  const currentSessionHarnessId =
    (hasMessages ? null : pendingHarnessId) ??
    activeSessionRecord?.harness_id ??
    desktopMainSession?.harness_id ??
    "pi";
  // pi (Hola) uses the runtime's dynamic model catalogue (empty
  // supportedModels) + the Hola thinking values, so it uses the ModelCombobox
  // + reasoning-effort path.
  const harnessUsesHolaModelCatalog = currentSessionHarnessId === "pi";
  // Pull the harness's static catalogue once so both Composer call
  // sites can render the same dropdown without re-fetching. The hook
  // is cached on the renderer side; this call piggybacks on whatever
  // EmptyComposerHarnessPicker already triggered.
  const { harnesses: availableHarnessesForComposer } = useAvailableHarnesses(
    selectedWorkspace?.id ?? null,
  );
  const currentSessionHarnessEntry = availableHarnessesForComposer.find(
    (h) => h.id === currentSessionHarnessId,
  );
  const currentSessionHarnessSupportedModels =
    currentSessionHarnessEntry?.supported_models ?? [];
  // Anchor the CLI-harness model picker on the VIEWED session's committed
  // model. `harnessChatModelOverride` is composer-scoped state that does NOT
  // reset when you switch sessions, so without this a claude-code session
  // started on Fable 5 re-opened showing the harness DEFAULT (Sonnet): the
  // EmptyComposerHarnessPicker below snaps a null/foreign override to the
  // default, and nothing ever re-seeds it from the session. We seed once per
  // session (ref-guarded) so we never stomp an explicit in-composer pick the
  // user makes before sending. Mirrors the Hola-catalogue `sessionModelAnchor`,
  // which derives from the same `selected_model` field; Hola ignores this
  // state entirely and reads that anchor instead.
  const harnessModelSeededSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (harnessUsesHolaModelCatalog) {
      return;
    }
    const sid = activeSessionId.trim();
    if (!sid) {
      return;
    }
    const committed = activeSessionRecord?.selected_model?.trim();
    if (!committed) {
      return;
    }
    if (harnessModelSeededSessionRef.current === sid) {
      return;
    }
    // Only adopt it when it's a legal id for this harness (or the supported
    // list hasn't loaded yet); otherwise leave the default-snap to run.
    const ids = currentSessionHarnessSupportedModels.map((m) => m.id);
    if (ids.length > 0 && !ids.includes(committed)) {
      return;
    }
    harnessModelSeededSessionRef.current = sid;
    setHarnessChatModelOverride((current) =>
      current === committed ? current : committed,
    );
  }, [
    activeSessionId,
    harnessUsesHolaModelCatalog,
    activeSessionRecord?.selected_model,
    currentSessionHarnessSupportedModels,
  ]);
  // Display name shown in the ChatHeader top-left so the user can see
  // at a glance which harness is driving the current session. Falls
  // back to "Hola" when the harness inventory hasn't loaded yet (the
  // header used to be hardcoded to that string anyway).
  const currentSessionHarnessDisplayName =
    currentSessionHarnessEntry?.display_name ?? "Hola";
  // Display name for the ACTIVE (possibly app-owned) session's harness, matched
  // to the avatar's harnessId — so an app conversation labels its identity block
  // with the right agent name (e.g. "Hola") instead of the session-id fallback.
  const activeSessionHarnessDisplayName =
    availableHarnessesForComposer.find(
      (h) => h.id === (activeSessionRecord?.harness_id ?? "pi"),
    )?.display_name ?? "Hola";
  const NON_PI_HARNESS_THINKING_VALUES: string[] = ["low", "medium", "high"];
  const composerThinkingValues = harnessUsesHolaModelCatalog
    ? selectedThinkingValues
    : NON_PI_HARNESS_THINKING_VALUES;
  const showThinkingValueSelector =
    !isOnboardingVariant &&
    (harnessUsesHolaModelCatalog
      ? selectedModelSupportsReasoning && selectedThinkingValues.length > 0
      : true);
  // For non-Hola harnesses, dispatch the per-harness selection from
  // HarnessModelPicker (claude-opus-4-7, gpt-5.1-codex, etc.). The host
  // runner forwards this as --model on Claude and model_reasoning_effort
  // on Codex. Thinking value still maps cleanly (both CLIs accept
  // low/medium/high). Null means "use the CLI's own default".
  const dispatchedChatModel = harnessUsesHolaModelCatalog
    ? resolvedChatModel || null
    : harnessChatModelOverride;
  const dispatchedThinkingValue = harnessUsesHolaModelCatalog
    ? effectiveThinkingValue
    : harnessThinkingOverride;

  const handleAnswerUserQuestion = async (
    answers: ActiveUserQuestionAnswer[],
  ) => {
    const workspaceId = selectedWorkspace?.id?.trim();
    const record = activeSessionRecord;
    const sessionId = (record?.session_id || activeSessionId || "").trim();
    if (!workspaceId || !sessionId) {
      throw new Error("The session isn't ready yet — please try again.");
    }
    const response = await window.electronAPI.workspace.answerUserQuestion({
      workspace_id: workspaceId,
      session_id: sessionId,
      answers,
      model: dispatchedChatModel,
      thinking_value: dispatchedThinkingValue,
    });
    // The runtime cleared the question and enqueued the reply server-side.
    // Clear it locally too so the card unmounts at once, then prime the live
    // turn exactly like a normal send so the follow-up run streams in.
    if (record) {
      const cleared = { ...record, active_user_question: null };
      if (
        cleared.session_id.trim() ===
        (desktopMainSession?.session_id || "").trim()
      ) {
        setDesktopMainSession(cleared);
      } else {
        upsertSessionRecordOverride(cleared);
      }
    }
    resetLiveTurn();
    setActiveSession(sessionId);
    setIsResponding(true);
    setLiveAgentStatus("Working");
    activeAssistantMessageIdRef.current = null;

    // Attach an input-specific output stream to the enqueued reply — without
    // this the turn shows "Working" but receives no live events until a slow
    // background reconcile catches up. Mirrors the post-queue send path.
    if (activeStreamIdRef.current) {
      void window.electronAPI.workspace
        .closeSessionOutputStream(activeStreamIdRef.current, "answer-user-question")
        .catch(() => undefined);
      activeStreamIdRef.current = null;
    }
    const inputId = response.input_id?.trim();
    if (inputId) {
      pendingInputIdRef.current = inputId;
      const opened = await window.electronAPI.workspace
        .openSessionOutputStream({
          sessionId,
          workspaceId,
          inputId,
          includeHistory: true,
          stopOnTerminal: true,
        })
        .catch((streamError) => {
          pendingInputIdRef.current = null;
          setIsResponding(false);
          throw streamError;
        });
      activeStreamIdRef.current = opened.streamId;
    } else {
      pendingInputIdRef.current = STREAM_ATTACH_PENDING;
    }
  };
  // What the Composer's thinking dropdown reads/writes. For pi we wire
  // it straight into the existing chatThinkingPreferences map; for
  // non-pi we use the local override so the Hola state stays clean.
  const composerSelectedThinkingValue = harnessUsesHolaModelCatalog
    ? effectiveThinkingValue
    : harnessThinkingOverride;
  const composerOnThinkingValueChange = (value: string | null): void => {
    if (harnessUsesHolaModelCatalog) {
      setSelectedThinkingValue(value);
      return;
    }
    setHarnessThinkingOverride(value ?? "medium");
  };
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
  const readOnlyInspectionDisabledReason = isReadOnlyInspectionSession
    ? "Inspection sessions are read-only. Return to the main session to continue the conversation."
    : "";
  // API-key install gate (OmniSocials, Publora): SURFACE-based. The chat is
  // blocked whenever an API-key app's surface is open and its key isn't
  // connected yet — no per-session bookkeeping. Opening the app shows a fresh
  // draft chat that this gate covers until the key is entered.
  const apiKeyGate =
    activeWebAppSurface?.apiKeyInstall &&
    apiKeyConnectedApps[activeWebAppSurface.holaAppId] !== true
      ? {
          holaAppId: activeWebAppSurface.holaAppId,
          title: activeWebAppSurface.title,
          ...activeWebAppSurface.apiKeyInstall,
        }
      : null;
  const apiKeyGateDisabledReason = apiKeyGate
    ? `Enter your ${apiKeyGate.title} API key above to start chatting.`
    : "";
  const issueComposerDisabledReason = !activeIssue
    ? ""
    : activeIssue.status === "backlog"
      ? "Move this issue to Todo before replying in the issue thread."
      : isResponding
        ? "This issue is actively running. Wait for the current run to finish before replying."
        : "";
  const integrationConnectingDisabledReason = isIntegrationConnectInFlight
    ? inFlightIntegrationProviderNames.length === 1
      ? `Finish connecting ${inFlightIntegrationProviderNames[0]} in your browser before sending another message.`
      : `Finish connecting ${inFlightIntegrationProviderNames.join(", ")} in your browser before sending another message.`
    : "";
  const composerBaseDisabledReason =
    apiKeyGateDisabledReason ||
    readOnlyInspectionDisabledReason ||
    issueComposerDisabledReason ||
    baseComposerDisabledReason ||
    integrationConnectingDisabledReason ||
    (usesHostedManagedCredits && isOutOfCredits
      ? "You're out of credits for managed usage."
      : "") ||
    (!resolvedChatModel ? modelSelectionUnavailableReason : "");
  const latestModelError = useMemo<{
    parsed: ParsedModelError;
    key: string;
  } | null>(() => {
    const scanItems = (items: ChatExecutionTimelineItem[]) => {
      const parts: string[] = [];
      for (const item of items) {
        if (item.kind === "trace_step") {
          parts.push(item.step.title, ...item.step.details);
        }
      }
      return parts.join("\n");
    };
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || message.role !== "assistant") continue;
      const segmentParts: string[] = [];
      for (const segment of message.segments ?? []) {
        if (segment.kind === "execution") {
          segmentParts.push(scanItems(segment.items));
        } else if (segment.kind === "output") {
          segmentParts.push(segment.text);
        }
      }
      const text = [
        message.text ?? "",
        scanItems(message.executionItems ?? []),
        ...segmentParts,
      ].join("\n");
      const parsed = parseModelError(text);
      if (parsed) {
        return { parsed, key: `msg:${message.id}` };
      }
      break;
    }
    const liveText = (() => {
      const parts: string[] = [];
      for (const item of liveExecutionItems) {
        if (item.kind === "trace_step") {
          parts.push(item.step.title, ...item.step.details);
        }
      }
      return parts.join("\n");
    })();
    const liveParsed = parseModelError(liveText);
    if (liveParsed) {
      return { parsed: liveParsed, key: `live:${activeSessionId ?? ""}` };
    }
    return null;
  }, [messages, liveExecutionItems, activeSessionId]);

  const modelErrorVisible =
    Boolean(latestModelError) &&
    latestModelError?.key !== dismissedModelErrorKey;

  const recommendedFallbackModelToken = useMemo(() => {
    const current = resolvedChatModel;
    if (
      runtimeDefaultModel &&
      runtimeDefaultModelAvailable &&
      runtimeDefaultModel !== current
    ) {
      return runtimeDefaultModel;
    }
    const alt = availableChatModelOptions.find(
      (option) =>
        option.value !== current && !("disabled" in option && option.disabled),
    );
    return alt?.value ?? null;
  }, [
    resolvedChatModel,
    runtimeDefaultModel,
    runtimeDefaultModelAvailable,
    availableChatModelOptions,
  ]);

  const labelForChatModelToken = useCallback(
    (token: string | null): string | null => {
      if (!token) return null;
      const option = availableChatModelOptions.find(
        (entry) => entry.value === token,
      );
      return option?.label ?? token;
    },
    [availableChatModelOptions],
  );

  useEffect(() => {
    if (!latestModelError) {
      setDismissedModelErrorKey(null);
    }
  }, [latestModelError]);

  useEffect(() => {
    if (!modelErrorVisible) {
      setIsRetryingModelError(false);
    }
  }, [modelErrorVisible]);

  const runIssueMutation = useCallback(
    async (action: () => Promise<unknown>, fallbackMessage: string) => {
      if (!selectedWorkspaceId || !activeIssue) {
        return false;
      }
      setIsIssueMutationPending(true);
      setIssueMutationErrorMessage("");
      try {
        await action();
        await refreshWorkspaceIssues(selectedWorkspaceId);
        scheduleConversationRefresh(
          activeIssue.session_id,
          selectedWorkspaceId,
        );
        return true;
      } catch (error) {
        setIssueMutationErrorMessage(
          error instanceof Error ? error.message : fallbackMessage,
        );
        return false;
      } finally {
        setIsIssueMutationPending(false);
      }
    },
    [activeIssue, refreshWorkspaceIssues, selectedWorkspaceId],
  );
  const handleIssueStatusChange = useCallback(
    async (nextStatus: IssueStatusPayload) => {
      if (!selectedWorkspaceId || !activeIssue) {
        return;
      }
      if (nextStatus === activeIssue.status) {
        return;
      }
      let blockerReason: string | null | undefined = undefined;
      if (nextStatus === "blocked") {
        const response = window.prompt(
          "Why is this issue blocked?",
          activeIssue.blocker_reason ?? "",
        );
        if (response == null) {
          return;
        }
        const trimmed = response.trim();
        if (!trimmed) {
          setIssueMutationErrorMessage("Waiting issues need a blocker reason.");
          return;
        }
        blockerReason = trimmed;
      } else if (activeIssue.blocker_reason) {
        blockerReason = null;
      }
      await runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(
            selectedWorkspaceId,
            activeIssue.issue_id,
            {
              workspace_id: selectedWorkspaceId,
              status: nextStatus,
              blocker_reason: blockerReason,
            },
          ),
        "Failed to update issue status",
      );
    },
    [activeIssue, runIssueMutation, selectedWorkspaceId],
  );
  const handleIssuePriorityChange = useCallback(
    async (priority: IssuePriorityPayload | null) => {
      if (!selectedWorkspaceId || !activeIssue) {
        return;
      }
      if ((activeIssue.priority ?? null) === priority) {
        return;
      }
      await runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(
            selectedWorkspaceId,
            activeIssue.issue_id,
            {
              workspace_id: selectedWorkspaceId,
              priority,
            },
          ),
        "Failed to update issue priority",
      );
    },
    [activeIssue, runIssueMutation, selectedWorkspaceId],
  );
  const handleIssueDetailsSave = useCallback(
    async (fields: {
      title: string;
      description: string | null;
      blockerReason: string | null;
    }) => {
      if (!selectedWorkspaceId || !activeIssue) {
        return false;
      }
      return runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(
            selectedWorkspaceId,
            activeIssue.issue_id,
            {
              workspace_id: selectedWorkspaceId,
              title: fields.title,
              description: fields.description,
              blocker_reason: fields.blockerReason,
            },
          ),
        "Failed to update issue details",
      );
    },
    [activeIssue, runIssueMutation, selectedWorkspaceId],
  );
  const handleStopActiveIssueRun = useCallback(async () => {
    if (!selectedWorkspaceId || !activeIssue?.active_subagent_id) {
      return;
    }
    if (!window.confirm(`Stop ${activeIssue.issue_id}?`)) {
      return;
    }
    await runIssueMutation(
      () =>
        window.electronAPI.workspace.stopIssueRun(
          selectedWorkspaceId,
          activeIssue.issue_id,
        ),
      "Failed to stop issue run",
    );
  }, [activeIssue, runIssueMutation, selectedWorkspaceId]);
  useEffect(() => {
    setIssueMutationErrorMessage("");
    setIsIssueMutationPending(false);
  }, [activeIssue?.issue_id]);
  const composerDisabledReason =
    composerBaseDisabledReason ||
    (isSubmittingMessage ? "Submitting message..." : "");
  const composerDisabled = Boolean(composerDisabledReason);
  const pendingImageInputUnsupportedMessage =
    pendingAttachments.some((attachment) =>
      pendingAttachmentIsImage(attachment),
    ) && !selectedModelSupportsImageInput
      ? `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Remove the attached image or switch models.`
      : "";
  // Composer-scoped, non-blocking feedback (a model that can't read an image).
  // A quiet amber strip that hugs the composer in both empty and thread views
  // — dismissible for the past-tense "skipped" notice, and it clears itself
  // once a vision-capable model is picked (pendingImageInputUnsupportedMessage
  // is derived; attachmentGateMessage is cleared on the next attach/model swap).
  const composerAttachmentNotice =
    attachmentGateMessage || pendingImageInputUnsupportedMessage ? (
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} />
        <span className="min-w-0 flex-1 leading-relaxed">
          {attachmentGateMessage || pendingImageInputUnsupportedMessage}
        </span>
        {attachmentGateMessage ? (
          <button
            type="button"
            onClick={() => setAttachmentGateMessage("")}
            aria-label="Dismiss"
            className="-mr-0.5 shrink-0 rounded p-0.5 text-amber-700/60 transition-colors hover:bg-amber-500/15 hover:text-amber-700 dark:text-amber-300/60 dark:hover:text-amber-300"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    ) : null;
  const showLowBalanceWarning =
    usesHostedManagedCredits && isLowBalance && !isOutOfCredits;
  const showOutOfCreditsWarning = usesHostedManagedCredits && isOutOfCredits;
  const creditWarningSeverity = showOutOfCreditsWarning
    ? "out"
    : showLowBalanceWarning
      ? "low"
      : null;
  const effectiveContentMaxWidth = CHAT_LAYOUT.contentMaxWidth;
  // Route a model pick to the right scope: an existing session (has messages)
  // gets a per-session override so its model — and any one-off manual reply in
  // an automation thread — never rewrites the global default; a fresh composer
  // updates the global default that seeds new chats.
  const applyComposerModelSelection = useCallback(
    (modelToken: string) => {
      if (!modelToken) return;
      const sid = (activeSessionIdRef.current || activeSessionId || "").trim();
      if (hasMessages && sid) {
        setPerSessionModelOverride((prev) => ({ ...prev, [sid]: modelToken }));
      } else {
        setChatModelPreference(modelToken);
      }
    },
    [activeSessionId, hasMessages],
  );
  // A host hand-off (Reproduce) asking to open on the model the shared Output was
  // made with. Applied through the same path as the composer's own picker, and
  // ignored when this install has no such model — never block the hand-off.
  const lastModelRequestKeyRef = useRef(0);
  useEffect(() => {
    if (!chatModelRequest || chatModelRequest.requestKey === lastModelRequestKeyRef.current) {
      return;
    }
    lastModelRequestKeyRef.current = chatModelRequest.requestKey;
    const wanted = chatModelRequest.model.trim();
    if (!wanted) {
      onChatModelRequestConsumed?.(chatModelRequest.requestKey);
      return;
    }
    const exact = availableChatModelOptions.find((o) => o.value === wanted);
    // Same model, different route: a sharer on OpenAI natively writes
    // `openai/gpt-5.4-mini` where a reader holding it through the proxy has
    // `holaboss_model_proxy/gpt-5.4-mini`. Falling through to the default would
    // reproduce the post on a different model entirely.
    const sameModel =
      exact ??
      availableChatModelOptions.find(
        (o) => modelIdentity(o.value) === modelIdentity(wanted),
      );
    if (sameModel) {
      applyComposerModelSelection(sameModel.value);
    } else {
      // Falling back silently would let someone believe they reproduced
      // something on the model it was made with.
      toast.info(`Original used ${displayModelLabel(wanted)}`, {
        description: "You don't have that model — using your default instead.",
      });
    }
    onChatModelRequestConsumed?.(chatModelRequest.requestKey);
  }, [
    chatModelRequest,
    availableChatModelOptions,
    applyComposerModelSelection,
    onChatModelRequestConsumed,
  ]);
  const handleSwitchModelFromError = useCallback(
    (modelToken: string) => {
      applyComposerModelSelection(modelToken);
    },
    [applyComposerModelSelection],
  );
  const handleSwitchAndRetryModel = useCallback(
    async (modelToken: string) => {
      if (!modelToken) return;
      const sessionId = activeSessionIdRef.current || activeSessionId;
      applyComposerModelSelection(modelToken);
      setIsRetryingModelError(true);
      try {
        if (selectedWorkspaceId && sessionId) {
          await window.electronAPI.workspace.queueSessionInput({
            workspace_id: selectedWorkspaceId,
            session_id: sessionId,
            text: "Retry the previous task with the newly selected model.",
            image_urls: null,
            attachments: [],
            priority: 0,
            model: modelToken,
            thinking_value: effectiveThinkingValue,
          });
        }
      } finally {
        setIsRetryingModelError(false);
        setDismissedModelErrorKey(latestModelError?.key ?? null);
      }
    },
    [
      activeSessionId,
      selectedWorkspaceId,
      effectiveThinkingValue,
      latestModelError,
      applyComposerModelSelection,
    ],
  );
  useEffect(() => {
    if (creditWarningSeverity) {
      trackUmamiEvent("credit_warning_shown", {
        severity: creditWarningSeverity,
      });
    }
  }, [creditWarningSeverity]);

  useEffect(() => {
    // Don't auto-rewrite the saved preference while runtimeConfig hasn't
    // finished loading. During the brief window between mount and the
    // runtime/getConfig() resolution, effectiveChatModelPreference falls
    // back to runtime default (e.g. GPT-5.5) because the provider catalog
    // hasn't arrived yet — without this guard we overwrite the user's
    // actual choice in localStorage with __runtime_default__ on every
    // launch, which is exactly the "always reverts to GPT-5.5 after a
    // restart" bug. Once runtimeConfig is non-null the auto-sync resumes
    // its original role of fixing genuinely-stale preferences.
    if (!runtimeConfig) return;
    // Never sync a session-scoped model back into the global preference — the
    // global value seeds NEW chats only. While the composer shows an existing
    // session's own model (sessionModelAnchor set), leave the global default
    // untouched, otherwise opening e.g. the GLM automation would overwrite it.
    if (sessionModelAnchor) return;
    if (!effectiveChatModelPreference) {
      return;
    }
    if (chatModelPreference.trim() === effectiveChatModelPreference) {
      return;
    }
    setChatModelPreference(effectiveChatModelPreference);
  }, [
    chatModelPreference,
    effectiveChatModelPreference,
    runtimeConfig,
    sessionModelAnchor,
  ]);

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

  let textareaPlaceholder = "Ask anything";
  if (imageComposerMode) {
    textareaPlaceholder = "Describe an image";
  } else if (videoComposerMode) {
    textareaPlaceholder = "Describe a video";
  }
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

  // Pane-wide dropzone — accept file drops anywhere in the chat pane
  // (history, header, etc.) and route them to the composer's attachment
  // pipeline. The composer has its own onDrop too; we skip when the
  // event has already been default-prevented so we don't double-attach.
  const onPaneDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (!hasFileLikeDragItems(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isPaneDragActive) setIsPaneDragActive(true);
  };
  const onPaneDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsPaneDragActive(false);
  };
  const onPaneDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsPaneDragActive(false);
    if (event.defaultPrevented) return;
    if (!hasFileLikeDragItems(event.dataTransfer)) return;
    event.preventDefault();
    const explorerPayload = parseExplorerAttachmentDragPayload(
      event.dataTransfer.getData(EXPLORER_ATTACHMENT_DRAG_TYPE),
    );
    if (explorerPayload) {
      appendPendingExplorerAttachments([explorerPayload]);
    }
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length > 0) appendPendingLocalFiles(droppedFiles);
  };

  const innerContent = (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
    >
      {isPaneDragActive ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border border-dashed border-primary/45 bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-1.5 text-primary">
            <Paperclip className="size-5" strokeWidth={1.75} />
            <span className="text-xs font-medium">Drop to attach</span>
          </div>
        </div>
      ) : null}
      {!isOnboardingVariant ? (
        <div
          className="shrink-0 px-4 py-2.5 sm:px-5"
          style={
            headerStoplightGutter
              ? { paddingLeft: headerStoplightGutter }
              : undefined
          }
        >
          <ChatHeader
            agentName={
              isViewingBoundMainSession
                ? currentSessionHarnessDisplayName
                : showsAgentIdentity
                  ? activeSessionHarnessDisplayName
                  : assistantLabel
            }
            harnessId={
              isViewingBoundMainSession
                ? currentSessionHarnessId
                : (activeSessionRecord?.harness_id ?? "pi")
            }
            project={
              isViewingBoundMainSession && activeProject
                ? {
                    id: activeProject.project_id,
                    name: activeProject.name,
                    icon: activeProject.icon,
                    icon_color: activeProject.icon_color,
                  }
                : null
            }
            subtitle={showsAgentIdentity ? undefined : activeSessionDetail}
            onReturnToMainSession={
              isReadOnlyInspectionSession
                ? () => {
                    void openMainSession();
                  }
                : undefined
            }
            onOpenArtifacts={onOpenArtifacts}
            outputsHasNew={outputsHasNew}
            showAgentLabel={hasMessages}
          />
          <ChatSharePublisher
            buildPayload={() => ({
              messages: displayMessages,
              workspaceId: (selectedWorkspaceId || "").trim() || null,
              model: selectedModelDisplayLabel,
              modelId: resolvedChatModel,
              skillNames: Object.fromEntries(
                [...availableWorkspaceSkillMap.entries()].map(([id, skill]) => [
                  id,
                  skill?.title ?? id,
                ]),
              ),
              integrationNames: Object.fromEntries(
                Object.entries(composioToolkitsByProvider).map(
                  ([slug, toolkit]) => [slug, toolkit?.name ?? slug],
                ),
              ),
              label: assistantLabel,
              mode: assistantMode,
              harnessId: activeSessionRecord?.harness_id ?? "pi",
              showExecutionInternals: showSessionExecutionInternals,
            })}
            enabled={hasMessages}
            hasOutputs={displayMessages.some((m) =>
              (m.outputs ?? []).some(
                (o) => isShareableMediaOutput(o) || isShareableDocOutput(o)
              )
            )}
          />
        </div>
      ) : null}

        {!isOnboardingVariant && activeIssue ? (
          <div className="shrink-0 px-4 pt-2 sm:px-5">
            <IssueThreadControls
              issue={activeIssue}
              isPending={isIssueMutationPending}
              errorMessage={issueMutationErrorMessage}
              onChangeStatus={handleIssueStatusChange}
              onChangePriority={handleIssuePriorityChange}
              onSaveDetails={handleIssueDetailsSave}
              onStopIssueRun={handleStopActiveIssueRun}
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
      pendingIntegrationsWait ||
      verboseTelemetryEnabled ? (
        <div className="shrink-0 px-4 pt-3 sm:px-5">
          {chatErrorMessage ? (
            <div
              role="alert"
              className="theme-chat-system-bubble rounded-xl border px-3 py-2 text-xs"
            >
              {chatErrorMessage}
            </div>
          ) : null}

          {pendingIntegrationsWait ? (
            <div className="theme-chat-system-bubble mt-3 flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-xs">
              <div className="min-w-0">
                <span className="font-medium">Waiting for you to connect:</span>{" "}
                {pendingIntegrationsWait.unresolvedSlugs.length > 0
                  ? pendingIntegrationsWait.unresolvedSlugs.join(", ")
                  : "the connections the agent proposed above"}
                . The next message resumes automatically once all are connected.
              </div>
              {pendingIntegrationsWait.unresolvedSlugs.length > 0 ? (
                <button
                  className="shrink-0 rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                  onClick={handleSkipPendingIntegrations}
                  type="button"
                >
                  Skip
                </button>
              ) : null}
            </div>
          ) : null}

          {backgroundDeliveryStatusMessage ? (
            <div className="theme-chat-system-bubble mt-3 rounded-xl border px-3 py-2 text-xs">
              {backgroundDeliveryStatusMessage}
            </div>
          ) : null}

          {/* attachment/image-input feedback now renders inline on the
              composer (composerAttachmentNotice) — it belongs next to the
              model picker and the attachment, not at the pane top. */}

          {verboseTelemetryEnabled ? (
            <div className="bg-muted mt-3 rounded-xl border border-border px-3 py-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[10px] text-muted-foreground">
                  Stream telemetry ({streamTelemetry.length})
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setStreamTelemetryRawView((raw) => !raw)}
                    className="text-[10px]"
                  >
                    {streamTelemetryRawView ? "Grouped" : "Raw"}
                  </Button>
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
              </div>
              <div className="bg-muted max-h-36 overflow-y-auto rounded border border-border p-2 font-mono text-[10px] text-muted-foreground">
                {streamTelemetry.length === 0 ? (
                  <div className="text-muted-foreground">
                    No stream events yet.
                  </div>
                ) : streamTelemetryRawView ? (
                  streamTelemetryTail.map((entry) => (
                    <div
                      key={entry.id}
                      className="whitespace-pre-wrap break-all"
                    >
                      {`${entry.at} ${entry.action} stream=${entry.streamId} transport=${entry.transportType} event=${entry.eventType || entry.eventName} input=${entry.inputId || "-"} session=${entry.sessionId || "-"} detail=${entry.detail || "-"}`}
                    </div>
                  ))
                ) : (
                  streamTelemetryTurns.map((turn) => {
                    const turnKey = turn.inputId || turn.startedAt;
                    const rowsExpanded = streamTelemetryExpanded[turnKey] === true;
                    const visibleRows = rowsExpanded
                      ? turn.rows
                      : turn.rows.filter((row) => row.origin !== "main");
                    return (
                    <div key={turnKey} className="mb-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-foreground">
                        <span className="font-semibold">
                          turn {turn.shortInputId}
                        </span>
                        <span className="text-muted-foreground">
                          {turn.startedAt}
                        </span>
                        {turn.latency.toFirstTokenMs !== null ? (
                          <span className="font-semibold">
                            {turn.latency.startsAtStreamOpen ? "≥" : ""}
                            {(turn.latency.toFirstTokenMs / 1_000).toFixed(2)}s to
                            first {turn.latency.firstTokenKind === "output" ? "output" : "token"}
                          </span>
                        ) : null}
                        {turn.stalls > 0 ? (
                          <span className="text-warning">
                            {turn.stalls} stall{turn.stalls === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            setStreamTelemetryExpanded((current) => ({
                              ...current,
                              [turnKey]: !rowsExpanded,
                            }))
                          }
                          className="text-[10px] underline decoration-dotted"
                        >
                          {rowsExpanded ? "hide events" : `${turn.rows.length} events`}
                        </button>
                      </div>

                      {/* The waterfall: where the wait actually went. Each phase
                          blames exactly one component, so the widest bar is the
                          thing to go fix. */}
                      {turn.latency.phases.length > 0 ? (
                        <div className="mt-1 mb-1 grid gap-0.5 pl-3">
                          {turn.latency.phases.map((phase) => (
                            <div
                              key={phase.label}
                              className="flex items-center gap-2"
                              title={phase.blames}
                            >
                              <span className="w-24 shrink-0 truncate text-muted-foreground">
                                {phase.label}
                              </span>
                              <span className="w-16 shrink-0 text-right tabular-nums">
                                {phase.durationMs < 1000
                                  ? `${phase.durationMs}ms`
                                  : `${(phase.durationMs / 1000).toFixed(2)}s`}
                              </span>
                              <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-foreground/8">
                                <span
                                  className={`absolute inset-y-0 left-0 rounded-sm ${
                                    phase.dominant ? "bg-warning" : "bg-foreground/35"
                                  }`}
                                  style={{
                                    width: `${Math.max(1, phase.share * 100)}%`,
                                  }}
                                />
                              </span>
                              {phase.dominant ? (
                                <span className="shrink-0 truncate text-muted-foreground">
                                  {phase.blames}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {visibleRows.map((row) => (
                        <div
                          key={row.key}
                          className={`flex flex-wrap items-baseline gap-x-2 whitespace-pre-wrap break-all pl-3 ${
                            row.stalled ? "text-warning" : ""
                          }`}
                        >
                          <span className="w-16 shrink-0 text-right tabular-nums">
                            {formatGap(row.deltaMs)}
                          </span>
                          <span className={row.origin === "main" ? "opacity-60" : ""}>
                            {row.origin === "main" ? "main·" : ""}
                            {row.label}
                            {row.count > 1 ? ` ×${row.count}` : ""}
                          </span>
                          {row.chars !== null ? (
                            <span className="text-muted-foreground">
                              {row.chars} chars
                            </span>
                          ) : null}
                          {/* The apply lag is the renderer's own cost — shown only
                              when it is the interesting number, so a normal row
                              stays short. */}
                          {row.applyLagMs !== null && row.applyLagMs > 0 ? (
                            <span
                              className={
                                row.applyLagMs >= DEFAULT_STALL_THRESHOLD_MS
                                  ? "font-semibold"
                                  : "text-muted-foreground"
                              }
                            >
                              apply {formatGap(row.applyLagMs)}
                            </span>
                          ) : null}
                          {row.outcome && row.outcome !== "applied" ? (
                            <span className="font-semibold">{row.outcome}</span>
                          ) : null}
                          {row.detail && row.detail !== "-" ? (
                            <span className="text-muted-foreground">
                              {row.detail}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {apiKeyGate ? <ApiKeyInstallGate gate={apiKeyGate} /> : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
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
                  const scrolledUp =
                    nextScrollTop < lastChatScrollTopRef.current;
                  lastChatScrollTopRef.current = nextScrollTop;
                  const nearBottom = isNearChatBottom(currentTarget);
                  shouldAutoScrollRef.current = scrolledUp ? false : nearBottom;
                  setIsAwayFromChatBottom((current) =>
                    current === !nearBottom ? current : !nearBottom,
                  );
                  if (
                    currentTarget.scrollTop <=
                    CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX
                  ) {
                    void loadOlderSessionHistory();
                  }
                }}
                className="chat-scrollbar-thin h-full min-h-0 overflow-x-hidden overflow-y-auto"
              >
                {hasMessages ? (
                  <div className="flex w-full">
                    <div className="min-w-0 flex-1">
                  <div
                    ref={messagesContentRef}
                    className={`mx-auto flex min-w-0 w-full ${effectiveContentMaxWidth} flex-col gap-2 px-4 sm:px-5 pb-3 pt-5 ${
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
                    harnessId={activeSessionRecord?.harness_id ?? "pi"}
                    onPreviewAttachment={openImageAttachmentPreview}
                    onOpenOutput={onOpenOutput}
                    collapsedTraceByStepId={collapsedTraceByStepId}
                    onToggleTraceStep={toggleTraceStep}
                    onLinkClick={onOpenLinkInBrowser}
                    onLocalLinkClick={onOpenLocalLink}
                    liveAssistantTurn={
                      showLiveAssistantTurn
                        ? {
                            // The committed turn's id is `assistant-${inputId}`.
                            // Before the first delta sets
                            // `activeAssistantMessageIdRef`, fall back to the
                            // already-known pending input id so the key stays
                            // stable from send through commit.
                            id:
                              activeAssistantMessageIdRef.current ??
                              (pendingInputIdRef.current &&
                              pendingInputIdRef.current !== STREAM_ATTACH_PENDING
                                ? `assistant-${pendingInputIdRef.current}`
                                : undefined),
                            text: liveAssistantText,
                            tone: "default",
                            segments: renderedLiveAssistantSegments,
                            executionItems: liveExecutionItems,
                            status:
                              liveAgentStatus || (isResponding ? "Working" : ""),
                          }
                        : null
                    }
                    onAfterIntegrationBind={handleAfterIntegrationBind}
                    onAfterIntegrationProposalConnected={
                      handleAfterIntegrationProposalConnected
                    }
                    onAfterMcpAuthorized={handleAfterMcpAuthorized}
                    onOpenBackgroundTaskReference={
                      handleOpenBackgroundTaskReference
                    }
                    />
                    {activeUserQuestion && !isReadOnlyInspectionSession ? (
                      <UserQuestionCard
                        key={activeUserQuestion.questions
                          .map((questionItem) => questionItem.id)
                          .join("|")}
                        question={activeUserQuestion}
                        onSubmit={handleAnswerUserQuestion}
                      />
                    ) : null}
                  </div>
                    </div>
                    {contextSlot ? (
                      <aside className="sticky top-3 z-10 shrink-0 self-start pr-3 pl-2">
                        {contextSlot}
                      </aside>
                    ) : null}
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
                            : activeWebAppSurface
                              ? (activeAppLanding?.greeting ??
                                `What can I help with in ${activeWebAppSurface.title}?`)
                              : "What can I help with?"}
                      </h2>
                      {(() => {
                        const hint = !selectedWorkspace
                          ? "Pick a template, create a workspace, then send the first instruction."
                          : isOnboardingVariant
                            ? "I'll ask a few setup questions and remember your answers."
                            : activeWebAppSurface
                              ? (activeAppLanding?.subtitle ?? null)
                              : readinessMessage;
                        return hint ? (
                          <p className="mt-3 text-sm leading-6 text-muted-foreground">
                            {hint}
                          </p>
                        ) : null;
                      })()}
                    </div>
                    {(
                      <form onSubmit={onSubmit} className="w-full">
                        <div className="space-y-3">
                          {scheduleEditContext ? (
                            <ChatScheduleEditContextCard
                              job={scheduleEditContext}
                              onDismiss={onScheduleEditContextDismiss}
                            />
                          ) : null}
                          {composerAttachmentNotice}
                          <div
                            className={
                              selectedWorkspace &&
                              !isOnboardingVariant &&
                              !isLoadingHistory
                                ? "overflow-hidden rounded-2xl bg-muted"
                                : undefined
                            }
                          >
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
                                quotedIntegrations={quotedIntegrations}
                                slashCommands={slashCommandOptions}
                                attachments={composerAttachmentItems}
                                isResponding={isResponding}
                                pausePending={isPausePending}
                                pauseDisabled={isSubmittingMessage}
                                disabled={composerDisabled}
                                disabledReason={composerDisabledReason}
                                selectedModel={effectiveChatModelPreference}
                                resolvedModelLabel={
                                  resolvedChatModel ||
                                  modelSelectionUnavailableReason
                                }
                                runtimeDefaultModelLabel={runtimeDefaultModel}
                                modelOptions={availableChatModelOptions}
                                modelOptionGroups={
                                  availableChatModelOptionGroups
                                }
                                runtimeDefaultModelAvailable={
                                  runtimeDefaultModelAvailable
                                }
                                selectedThinkingValue={composerSelectedThinkingValue}
                                thinkingValues={composerThinkingValues}
                                showThinkingValueSelector={
                                  showThinkingValueSelector
                                }
                                modelSelectionUnavailableReason={
                                  modelSelectionUnavailableReason
                                }
                                submitDisabled={Boolean(
                                  pendingImageInputUnsupportedMessage,
                                )}
                                placeholder={textareaPlaceholder}
                                showModelSelector={harnessUsesHolaModelCatalog}
                                harnessSupportedModels={
                                  harnessUsesHolaModelCatalog
                                    ? undefined
                                    : currentSessionHarnessSupportedModels
                                }
                                harnessSelectedModel={harnessChatModelOverride}
                                onHarnessModelChange={setHarnessChatModelOverride}
                                showAccessoryControls={true}
                                plusMenuSide="bottom"
                                selectedProjectId={selectedChatProjectId}
                                projectOptions={workspaceProjects}
                                showProjectPicker={true}
                                onProjectChange={setSelectedChatProjectId}
                                onModelChange={applyComposerModelSelection}
                                onThinkingValueChange={composerOnThinkingValueChange}
                                onOpenModelProviders={() =>
                                  void window.electronAPI.ui.openSettingsPane(
                                    "byok",
                                  )
                                }
                                fileInputRef={fileInputRef}
                                onAttachmentInputChange={
                                  onAttachmentInputChange
                                }
                                onPause={pauseCurrentRun}
                                onAddDroppedFiles={appendPendingLocalFiles}
                                onAddExplorerAttachments={
                                  appendPendingExplorerAttachments
                                }
                                mentionableItems={composerMentionableItems}
                                onRemoveQuotedIntegration={
                                  removeQuotedIntegration
                                }
                                onSelectIntegration={addQuotedIntegration}
                                onRemoveAttachment={removeComposerAttachment}
                                onPreviewAttachment={openImageAttachmentPreview}
                                composerEditorRef={composerEditorRef}
                                composerInitialValue={composerInitialValue}
                                onValueChange={handleComposerValueChange}
                                onSubmit={submitComposer}
                                onRecallLatest={recallLatestComposerInput}
                                onCancelDraft={cancelComposerDraftFromKeyboard}
                              />
                            </QueuedSessionInputRail>
                            {selectedWorkspace &&
                            !isOnboardingVariant &&
                            !isLoadingHistory ? (
                              <EmptyComposerHarnessPicker
                                workspaceId={selectedWorkspace?.id ?? null}
                                selectedHarnessId={currentSessionHarnessId}
                                onHarnessSelect={setPendingHarnessId}
                                harnessChatModelOverride={
                                  harnessChatModelOverride
                                }
                                onHarnessChatModelChange={
                                  setHarnessChatModelOverride
                                }
                                workspaceHint={[
                                  selectedWorkspace.name,
                                  selectedWorkspace.lab_purpose,
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              />
                            ) : null}
                          </div>
                          {selectedWorkspace &&
                          !isOnboardingVariant &&
                          !isLoadingHistory ? (
                            activeWebAppSurface ? (
                              activeAppLanding?.prompts &&
                              activeAppLanding.prompts.length > 0 ? (
                                <AppLandingSuggestions
                                  appIconUrl={activeAppEntry?.iconUrl}
                                  appTitle={activeWebAppSurface.title}
                                  className="w-full px-1 pt-3"
                                  onSelect={(prompt) => void sendMessage(prompt)}
                                  prompts={activeAppLanding.prompts}
                                />
                              ) : null
                            ) : (
                              <div className="flex w-full flex-col gap-3 pt-3">
                                <CreationChips
                                  className="justify-center px-1"
                                  onPick={(type: CreationType) => {
                                    const editor = composerEditorRef.current;
                                    if (!editor) {
                                      return;
                                    }
                                    if (type.videoMode) {
                                      setImageComposerMode(false);
                                      setVideoComposerMode(true);
                                    }
                                    if (type.imageMode) {
                                      setVideoComposerMode(false);
                                      setImageComposerMode(true);
                                    }
                                    // Quote the skill only when it's actually
                                    // installed here; otherwise seed the example
                                    // prompt so the chip never fails on send.
                                    if (
                                      availableWorkspaceSkillMap.has(
                                        type.skillId,
                                      )
                                    ) {
                                      editor.insertSkill(
                                        type.skillId,
                                        type.label,
                                      );
                                    } else if (type.examplePrompt) {
                                      editor.setContent({
                                        text: type.examplePrompt,
                                        skillIds: [],
                                        capabilityIds: [],
                                      });
                                    } else {
                                      editor.insertSkill(
                                        type.skillId,
                                        type.label,
                                      );
                                    }
                                    editor.focus();
                                  }}
                                />
                                <PersonalizedSuggestions
                                  className="w-full px-1"
                                  onSelect={(prompt) => void sendMessage(prompt)}
                                />
                              </div>
                            )
                          ) : null}
                          {isOnboardingVariant ? (
                            <p className="text-center text-[11px] leading-4 text-muted-foreground">
                              Responses here stay in the workspace onboarding
                              thread.
                            </p>
                          ) : null}
                        </div>
                      </form>
                    )}
                  </div>
                )}
              </div>

              {hasMessages && isAwayFromChatBottom ? (
                <button
                  type="button"
                  aria-label={
                    isResponding
                      ? "Resume following live response"
                      : "Jump to latest message"
                  }
                  onClick={() => {
                    const container = messagesRef.current;
                    if (!container) return;
                    shouldAutoScrollRef.current = true;
                    container.scrollTo({
                      top: container.scrollHeight,
                      behavior: "smooth",
                    });
                  }}
                  className="absolute bottom-3 left-1/2 -ml-3.5 z-30 grid size-7 place-items-center rounded-full border border-border bg-popover text-foreground shadow-sm transition-colors hover:bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
                >
                  <ChevronDown className="size-4" strokeWidth={2} />
                </button>
              ) : null}
            </div>

            {hasMessages ? (
              <div className="flex w-full">
                <div className="min-w-0 flex-1">
              <div
                ref={composerBlockRef}
                className={`mx-auto w-full shrink-0 ${effectiveContentMaxWidth} pl-4 pr-7 pb-6 pt-3 ${
                  showHistoryRestoreScreen ? "invisible" : ""
                }`}
                style={frozenColumnStyle}
              >
                {modelErrorVisible && latestModelError ? (
                  <div className="mb-3">
                    <ModelErrorRecoveryCard
                      error={latestModelError.parsed}
                      selectedModel={effectiveChatModelPreference}
                      selectedModelLabel={
                        labelForChatModelToken(effectiveChatModelPreference) ??
                        effectiveChatModelPreference
                      }
                      fallbackModelToken={recommendedFallbackModelToken}
                      fallbackModelLabel={labelForChatModelToken(
                        recommendedFallbackModelToken,
                      )}
                      runtimeDefaultModelLabel={runtimeDefaultModel}
                      runtimeDefaultModelAvailable={
                        runtimeDefaultModelAvailable
                      }
                      modelOptions={availableChatModelOptions}
                      modelOptionGroups={availableChatModelOptionGroups}
                      onModelChange={handleSwitchModelFromError}
                      onSwitchAndRetry={handleSwitchAndRetryModel}
                      isRetrying={isRetryingModelError}
                      retryDisabled={
                        !selectedWorkspaceId || isReadOnlyInspectionSession
                      }
                      retryDisabledReason={
                        isReadOnlyInspectionSession
                          ? "Return to the live session to retry."
                          : null
                      }
                      onDismiss={() =>
                        setDismissedModelErrorKey(latestModelError.key)
                      }
                    />
                  </div>
                ) : null}
                {!isOnboardingVariant && isViewingBoundMainSession ? (
                  <div className="mb-3 empty:hidden">
                    <BackgroundTasksPane
                      workspaceId={selectedWorkspaceId}
                      ownerMainSessionId={desktopMainSession?.session_id ?? null}
                      variant="inline"
                      onOpenTaskSession={handleOpenBackgroundTaskSession}
                    />
                  </div>
                ) : null}
                {(
                  <form onSubmit={onSubmit} className="w-full">
                    <div className="space-y-3">
                      {scheduleEditContext ? (
                        <ChatScheduleEditContextCard
                          job={scheduleEditContext}
                          onDismiss={onScheduleEditContextDismiss}
                        />
                      ) : null}
                      {composerAttachmentNotice}
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
                          quotedIntegrations={quotedIntegrations}
                          slashCommands={slashCommandOptions}
                          attachments={composerAttachmentItems}
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
                          selectedThinkingValue={composerSelectedThinkingValue}
                          thinkingValues={composerThinkingValues}
                          showThinkingValueSelector={showThinkingValueSelector}
                          modelSelectionUnavailableReason={
                            modelSelectionUnavailableReason
                          }
                          submitDisabled={Boolean(
                            pendingImageInputUnsupportedMessage,
                          )}
                          placeholder={textareaPlaceholder}
                          showModelSelector={harnessUsesHolaModelCatalog}
                          harnessSupportedModels={
                            harnessUsesHolaModelCatalog
                              ? undefined
                              : currentSessionHarnessSupportedModels
                          }
                          harnessSelectedModel={harnessChatModelOverride}
                          onHarnessModelChange={setHarnessChatModelOverride}
                          showAccessoryControls={true}
                          selectedProjectId={selectedChatProjectId}
                          projectOptions={workspaceProjects}
                          showProjectPicker={true}
                          onProjectChange={setSelectedChatProjectId}
                          onModelChange={applyComposerModelSelection}
                          onThinkingValueChange={composerOnThinkingValueChange}
                          onOpenModelProviders={() =>
                            void window.electronAPI.ui.openSettingsPane(
                              "byok",
                            )
                          }
                          fileInputRef={fileInputRef}
                          onAttachmentInputChange={onAttachmentInputChange}
                          onPause={pauseCurrentRun}
                          onAddDroppedFiles={appendPendingLocalFiles}
                          onAddExplorerAttachments={
                            appendPendingExplorerAttachments
                          }
                          mentionableItems={composerMentionableItems}
                          onRemoveQuotedIntegration={removeQuotedIntegration}
                          onSelectIntegration={addQuotedIntegration}
                          onRemoveAttachment={removeComposerAttachment}
                          onPreviewAttachment={openImageAttachmentPreview}
                          composerEditorRef={composerEditorRef}
                          composerInitialValue={composerInitialValue}
                          onValueChange={handleComposerValueChange}
                          onSubmit={submitComposer}
                          onRecallLatest={recallLatestComposerInput}
                          onCancelDraft={cancelComposerDraftFromKeyboard}
                        />
                      </QueuedSessionInputRail>
                    </div>
                  </form>
                )}
              </div>
                </div>
                {contextSlot ? (
                  <div aria-hidden className="shrink-0 self-start pl-2 pr-3">
                    <div className="w-80" />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

      {showHistoryRestoreScreen ? <HistoryRestoreSkeleton /> : null}

      <ImageAttachmentPreviewModal
        open={Boolean(imageAttachmentPreview)}
        preview={imageAttachmentPreview}
        onClose={closeImageAttachmentPreview}
      />
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

/**
 * Inline picker rendered in the new-chat empty-composer. The session is
 * already created at this point (Sidebar "+ New chat" provisions it on
 * click), but the harness binding remains mutable until the first input
 * is queued — the runtime enforces that on the PATCH endpoint.
 *
 * Layout: harness picker + (for non-pi harnesses) a model picker scoped
 * to the harness's supported_models. The model selection lives in
 * parent ChatPane state via `harnessChatModelOverride` so the dispatch
 * code can read it without going through the Holaboss catalogue.
 */
function EmptyComposerHarnessPicker({
  workspaceId,
  selectedHarnessId,
  onHarnessSelect,
  harnessChatModelOverride,
  onHarnessChatModelChange,
  workspaceHint,
}: {
  workspaceId: string | null;
  selectedHarnessId: string;
  onHarnessSelect: (harnessId: string | null) => void;
  harnessChatModelOverride: string | null;
  onHarnessChatModelChange: (modelId: string | null) => void;
  workspaceHint?: string | null;
}) {
  const { harnesses, isLoading } = useAvailableHarnesses(workspaceId);
  const currentHarnessEntry = harnesses.find(
    (h) => h.id === selectedHarnessId,
  );
  const supportedModels = currentHarnessEntry?.supported_models ?? [];
  // Seed the parent's chat-model override whenever the supported list
  // for the selected harness changes — drop it on pi (Hola catalogue
  // takes over) or snap to the default / first entry on non-pi. The
  // model picker itself now lives in the Composer footer, so this
  // component just keeps the parent state in sync; the picker reads
  // from it directly.
  useEffect(() => {
    if (supportedModels.length === 0) {
      if (harnessChatModelOverride !== null) {
        onHarnessChatModelChange(null);
      }
      return;
    }
    const ids = supportedModels.map((m) => m.id);
    if (!harnessChatModelOverride || !ids.includes(harnessChatModelOverride)) {
      const defaultModel =
        supportedModels.find((m) => m.default) ?? supportedModels[0];
      onHarnessChatModelChange(defaultModel?.id ?? null);
    }
  }, [
    harnessChatModelOverride,
    onHarnessChatModelChange,
    supportedModels,
  ]);
  if (!workspaceId) {
    return null;
  }
  // Deferred intent: record the choice in parent state only. We never
  // PATCH the resumed session's harness here — that's immutable once the
  // session has run a turn, and mutating it is exactly the bug this picker
  // used to hit. The harness is actually bound when the user sends, by
  // minting a fresh main session for it (see sendMessage). Picking the
  // session's existing harness is a no-op on send: the create-on-send
  // guard skips when the pick equals the current session's harness.
  const handleHarnessChange = (next: string) => {
    if (next === selectedHarnessId) {
      return;
    }
    onHarnessSelect(next);
    // Snap the parent's model override to the new harness's default (or
    // first entry) so the Composer's model dropdown lands on a legal id
    // without the user having to open it.
    const nextEntry = harnesses.find((h) => h.id === next);
    const nextDefault =
      nextEntry?.supported_models?.find((m) => m.default) ??
      nextEntry?.supported_models?.[0];
    onHarnessChatModelChange(nextDefault?.id ?? null);
  };
  return (
    <RuntimeContextBar
      harnesses={harnesses}
      harnessesLoading={isLoading}
      onHarnessChange={handleHarnessChange}
      selectedHarnessId={selectedHarnessId}
      workspaceHint={workspaceHint}
    />
  );
}
