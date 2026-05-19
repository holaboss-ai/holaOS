import type {
  ChatAssistantSegment,
  ChatAttachment,
  ChatExecutionTimelineItem,
} from "./types";

export const MAIN_SESSION_EVENT_BATCH_HEADER =
  "[Holaboss Main Session Event Batch v1]";
export const BACKGROUND_DELIVERY_RETRY_STATUS_MESSAGE =
  "Background update delayed. Retrying automatically.";

export const EMPTY_ATTACHMENTS: ChatAttachment[] = [];
export const EMPTY_SEGMENTS: ChatAssistantSegment[] = [];
export const EMPTY_EXECUTION_ITEMS: ChatExecutionTimelineItem[] = [];
export const EMPTY_OUTPUTS: WorkspaceOutputRecordPayload[] = [];

export const STREAM_ATTACH_PENDING = "__stream_attach_pending__";
export const STREAM_TELEMETRY_LIMIT = 240;
export const TOOL_TRACE_TERMINAL_PHASES = new Set([
  "completed",
  "failed",
  "error",
]);
export const CHAT_AUTO_SCROLL_THRESHOLD_PX = 72;
// Drives both the initial session-open fetch and each "load earlier" pull.
// Was 10 originally — small enough that scroll-restoration after a prepend
// often left the user still inside the 96px top threshold, immediately
// triggering the next load. The runtime caps `limit` at 1000 (default 200);
// 50 keeps the per-call work bounded while making any single load earn
// enough vertical content (~25 turns) to push the user well past the
// re-trigger threshold.
export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX = 96;
// Sub-agent / inspection sessions tend to load in <16ms (small history,
// local SQLite). Without a floor the skeleton paints for less than a frame
// and the user perceives the message-mount animations as "replaying" the
// whole turn list. Hold the skeleton long enough that those enter
// animations resolve behind it.
export const SKELETON_MIN_DISPLAY_MS = 250;
export const COMPOSER_FOOTER_GAP_PX = 8;
export const COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX = 240;
export const COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX = 88;
export const COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX = 320;
export const COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX = 168;
export const COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX = 56;
export const COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX = 124;
export const CHAT_MODEL_STORAGE_KEY = "holaboss-chat-model-v1";
export const CHAT_THINKING_STORAGE_KEY = "holaboss-chat-thinking-v1";
export const CHAT_MODEL_USE_RUNTIME_DEFAULT = "__runtime_default__";
export const CHAT_SERIALIZED_SKILL_COMMAND_PATTERN = /^\/([A-Za-z0-9_-]+)$/;
export const QUEUED_MESSAGES_PREVIEW_EVENT =
  "holaboss:queued-messages-preview-change";
export const LEGACY_UNAVAILABLE_CHAT_MODELS = new Set(["openai/gpt-5.2-mini"]);
export const DEPRECATED_CHAT_MODELS = new Set([
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
]);
export const CHAT_MODEL_PRESETS = [
  "openai/gpt-5.1",
  "openai/gpt-5",
  "openai/gpt-5.2",
] as const;
export const RUNTIME_MODEL_CAPABILITY_ALIASES: Record<string, string> = {
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

/** Token shape for `@`-mentions inside body text. Mirrors the rules
 *  in `findActiveMentionRange`: handle is `[A-Za-z0-9_.\-/]+`,
 *  preceded by start-of-string or whitespace. Backtick fences and
 *  inline-code spans are not yet skipped — a `@token` inside a
 *  ``` ``` ``` fence will still get rewritten. Acceptable for v1
 *  since user-submitted code is rare in chat. */
export const MENTION_TOKEN_PATTERN =
  /(^|[\s])@([\p{L}\p{N}_.\-/]+)/gu;
