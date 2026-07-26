/**
 * The platform-agnostic contract every IM connector implements.
 *
 * A connector owns ONE messaging platform's transport. It normalizes inbound
 * platform events into {@link IncomingMessage} and hands each to the gateway via
 * {@link ChannelConnector.onMessage}; it sends agent output back via the outbound
 * primitives. Everything that differs between platforms — whether messages can be
 * edited in place, reactions, typing, markdown dialect, length limits, threads — is
 * declared as data on {@link ChannelCapabilities} so the egress orchestrator can
 * adapt its streaming/ack strategy without per-platform branching.
 *
 * A small platform-adapter base: a tiny mandatory surface
 * (start/stop/onMessage/format/sendText) with the rest optional and
 * capability-gated.
 */

/**
 * Known platforms plus an escape hatch for plugin connectors. The `(string & {})`
 * member keeps autocomplete for the known ids while still accepting any string.
 */
export type ChannelPlatform =
  | "telegram"
  | "slack"
  | "discord"
  | "whatsapp"
  | "signal"
  | "imessage"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** How a conversation is scoped on the platform. Drives session keying. */
export type ChatType = "dm" | "group" | "channel" | "thread";

/** Markdown dialect a platform renders; selects the connector's `format()` behavior. */
export type MarkdownDialect =
  | "none"
  | "markdown" // generic CommonMark (e.g. WeCom replyStream renders it natively)
  | "markdown_v2"
  | "mrkdwn"
  | "discord"
  | "whatsapp"
  | "feishu"
  | "dingtalk"
  | "html";

/** Which media kinds a platform can receive as native attachments. */
export interface ChannelMediaCapabilities {
  image: boolean;
  document: boolean;
  voice: boolean;
  video: boolean;
}

/**
 * The per-platform compatibility surface. The egress orchestrator reads this to
 * decide HOW to stream, acknowledge, format, and split — never the connector class.
 */
export interface ChannelCapabilities {
  /**
   * Can a previously-sent message be edited in place? `true` → live edit-in-place
   * token streaming (Strategy A). `false` → buffer the answer and send it on
   * completion (Strategy B). This is the single most important capability.
   */
  editMessages: boolean;
  /**
   * When the platform can edit but can't render the final rich answer by editing the
   * streaming message, send the finished answer as a fresh message instead. Reflects
   * the platform's edit-finalize requirement.
   */
  finalizeByResend: boolean;
  /** Supports message reactions — used for 👀 received / ✅ done / ❌ failed acks. */
  reactions: boolean;
  /** Supports a typing indicator. */
  typing: boolean;
  /** Typing-indicator refresh cadence in ms (0 = one-shot, no heartbeat needed). */
  typingRefreshMs: number;
  /** Markdown dialect the platform renders; drives `format()`. */
  markdown: MarkdownDialect;
  /** Maximum length of a single outbound message. */
  maxMessageLength: number;
  /**
   * Unit `maxMessageLength` is measured in. Telegram counts UTF-16 code units
   * (an emoji costs 2), most others count Unicode codepoints.
   */
  lengthUnit: "codepoints" | "utf16";
  /** Supports tappable buttons / interactive components. */
  interactiveButtons: boolean;
  /** Native thread / topic addressing (vs. plain reply context). */
  threads: boolean;
  /** Native media-send support per kind. */
  media: ChannelMediaCapabilities;
}

/** An inbound attachment the connector downloaded to a local temp file. */
export interface IncomingAttachment {
  kind: "image" | "file" | "voice" | "video";
  /**
   * Absolute path to the connector's downloaded copy on local disk. The runtime
   * port consumes it — images become `data:` URIs (vision), other files are copied
   * into the workspace — and then removes this temp file.
   */
  sourcePath: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * A normalized inbound message. Connectors produce this from raw platform events;
 * the gateway is platform-agnostic from here on.
 */
export interface IncomingMessage {
  platform: ChannelPlatform;
  /** Which configured connection produced this (a workspace may have several). */
  connectionId: string;
  /** The workspace this connection is bound to. */
  workspaceId: string;
  chatId: string;
  chatType: ChatType;
  threadId?: string;
  /** Human-friendly chat name, when the platform exposes one (used as session title). */
  chatTitle?: string;
  userId: string;
  userName?: string;
  text: string;
  messageId?: string;
  /**
   * Monotonic transport-level update id when available (Telegram `update_id`).
   * Used to build the idempotency key so poll retries don't double-fire.
   */
  updateId?: string | number;
  replyToMessageId?: string;
  attachments: IncomingAttachment[];
  /** Raw platform payload for connector-specific needs. Never persisted. */
  raw?: unknown;
}

/** Where to send an outbound message. */
export interface OutgoingTarget {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
}

/** A local file to send as a native attachment. */
export interface OutgoingMedia {
  kind: "image" | "document" | "voice" | "video";
  path: string;
  name?: string;
  mimeType?: string;
}

/** Result of an outbound send. */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  /** Ids of additional messages created when a long payload was split. */
  splitMessageIds?: string[];
  error?: string;
}

/** The inbound funnel: connectors deliver every normalized message here. */
export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * One platform's connector. Mandatory members: `start`, `stop`, `onMessage`,
 * `format`, `sendText`. All other methods are optional and only invoked when the
 * matching {@link ChannelCapabilities} flag is set.
 */
export interface ChannelConnector {
  readonly platform: ChannelPlatform;
  readonly connectionId: string;
  /** Stable key identifying this connection across config refreshes. */
  readonly key: string;
  readonly capabilities: ChannelCapabilities;

  /**
   * Emojis used for lifecycle reaction acks (received → done/failed). Platform-
   * specific because each platform allows a different reaction set. Omit when the
   * platform has no reactions; only read when `capabilities.reactions` is true.
   */
  readonly ackEmojis?: { received: string; done: string; failed: string };

  /**
   * Brief "I'm on it" message sent as text when the run starts, for platforms
   * that have NO reactions and NO typing indicator (e.g. QQ) — otherwise the user
   * gets zero feedback until the final reply. Only sent when
   * `capabilities.reactions` is false. Omit on platforms that ack via reactions.
   */
  readonly workingText?: string;

  /**
   * Hash of the connection config. The manager restarts the connector when this
   * changes between config refreshes via fingerprint diffing.
   */
  fingerprint(): string;

  /** Begin listening (e.g. start long-polling). Resolves once connected. */
  start(): Promise<void>;
  /** Stop listening and release all resources/background tasks. */
  stop(): Promise<void>;

  /** Register the inbound funnel. Called once before `start()`. */
  onMessage(handler: IncomingMessageHandler): void;

  /** Convert agent markdown into this platform's dialect (escaping included). */
  format(text: string): string;

  /** Send a text message. The only mandatory outbound primitive. */
  sendText(target: OutgoingTarget, text: string): Promise<SendResult>;

  /** Edit a previously-sent message in place (only if `capabilities.editMessages`). */
  editText?(
    target: OutgoingTarget,
    messageId: string,
    text: string,
    options?: { finalize?: boolean },
  ): Promise<SendResult>;

  /**
   * Create the message that an edit-in-place stream will update, for platforms
   * whose stream message is not a plain text send — e.g. a DingTalk AI Card,
   * which must be created + delivered before it can stream. Returns the id
   * (`out_track_id`) that subsequent `editText` calls update. Only used when
   * `capabilities.editMessages`; when absent, egress creates the stream message
   * with `sendText` (the Telegram path).
   */
  createStreamMessage?(target: OutgoingTarget, text: string): Promise<SendResult>;

  /** Show a one-shot typing indicator (only if `capabilities.typing`). */
  sendTyping?(chatId: string, threadId?: string): Promise<void>;

  /** Add a reaction to a message (only if `capabilities.reactions`). */
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Remove a reaction from a message (only if `capabilities.reactions`). */
  unreact?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /** Send a local file as a native attachment (only if the matching `media` flag). */
  sendMedia?(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult>;
}
