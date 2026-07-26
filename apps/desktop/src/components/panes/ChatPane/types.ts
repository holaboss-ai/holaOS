import type { ReactNode } from "react";

export type ChatAttachment = SessionInputAttachmentPayload;
export type ChatPaneVariant = "default" | "embedded";

export interface ChatBackgroundTaskReference {
  workspaceId: string;
  sourceType: string | null;
  sourceId: string | null;
  issueId: string | null;
  title: string | null;
  status: string | null;
}

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
  backgroundTaskReferences?: ChatBackgroundTaskReference[];
  pendingIntegrations?: ChatPendingIntegration[];
  // Proposals emitted by `holaboss_workspace_integrations_propose_connect`. Same
  // visual treatment as pendingIntegrations but no app_id (the agent is
  // asking to add to the account-level integration pool so it can call
  // the toolkit's tools directly — no app wrapping).
  proposedIntegrations?: ChatProposedIntegration[];
  // HolaHub posts the agent published this turn (via the holahub create_post
  // tool). Surfaced as a "View on HolaHub" card that deep-links into Discover.
  publishedPosts?: ChatPublishedHubPost[];
  // Remote MCP servers that reported `auth_required` during discovery this turn
  // (an mcp_server_unavailable event). Surfaced as an inline "Authorize" card so
  // the user can run the OAuth flow without leaving the chat for Settings → MCP.
  mcpAuthorizations?: ChatMcpAuthorization[];
}

// A remote MCP server that needs an interactive OAuth authorize before its
// tools can be discovered (e.g. HeyGen). Rendered as an inline Authorize card.
export interface ChatMcpAuthorization {
  serverId: string;
  // True when this is a re-authorization (switch account) rather than a
  // first-time sign-in — the card wipes the existing token and relabels.
  reauthorize?: boolean;
}

// A HolaHub post an agent published — enough to link into `/threads/<postId>`.
export interface ChatPublishedHubPost {
  postId: string;
  title: string;
}

export interface ChatPendingIntegration {
  workspace_id?: string | null;
  app_id: string;
  provider_id: string;
  credential_source?: string | null;
  // Per-yaml whoami descriptor forwarded by the runtime; pass-through to
  // Hono via composioConnect. Validated at parse time in
  // parsePendingIntegrationsList.
  whoami?: PendingIntegrationWhoami | null;
}

export interface ChatProposedIntegration {
  toolkit_slug: string;
  tier?: "hero" | "supported";
  category?: string;
  reason?: string | null;
}

export type QueuedSessionInputStatus = "queued" | "sending";

export interface QueuedSessionInput {
  inputId: string;
  sessionId: string;
  workspaceId: string;
  text: string;
  createdAt: string;
  attachments: ChatAttachment[];
  status: QueuedSessionInputStatus;
}

export interface QueuedSessionInputPreviewDescriptor {
  text: string;
  createdAt?: string;
  attachments?: ChatAttachment[];
  status: QueuedSessionInputStatus;
}

export interface ComposerInputRecallSnapshot {
  workspaceId: string;
  text: string;
  at: number;
}

export interface PendingOptimisticUserMessage {
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

export interface ChatSerializedQuotedSkillBlock {
  skillIds: string[];
  integrationSlugs: string[];
  body: string;
}

export type ChatTraceStepStatus = "running" | "completed" | "error" | "waiting";

export interface ChatTraceStep {
  id: string;
  kind: "phase" | "tool";
  title: string;
  status: ChatTraceStepStatus;
  details: string[];
  order: number;
  /** An errored phase the agent recovers from (e.g. an MCP server going
   *  unavailable mid-run). The step still renders its own error, but the
   *  turn isn't a failure, so it must not mark the whole group. */
  recoverable?: boolean;
}

export type ChatExecutionTimelineItem =
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

export interface PendingLocalAttachmentFile {
  id: string;
  source: "local-file";
  file: File;
}

export interface PendingExplorerAttachmentFile {
  id: string;
  source: "explorer-path";
  absolutePath: string;
  name: string;
  mime_type?: string | null;
  size_bytes: number;
  kind: "image" | "file" | "folder";
}

// A generic "app context" pill (e.g. a need-review record handed over by the
// Discuss host op). Not a file — it carries pre-serialized context text that is
// appended to the message on send (refs + an MCP hint + an optional snapshot).
export interface PendingAppContextAttachment {
  id: string;
  source: "app-context";
  /** Display label, e.g. "Need Review". */
  appName: string;
  /** Display title, e.g. the record title. */
  title: string;
  /** Folded into the outgoing message text on send. */
  contextText: string;
}

export type PendingAttachment =
  | PendingLocalAttachmentFile
  | PendingExplorerAttachmentFile
  | PendingAppContextAttachment;

export interface AttachmentListItem {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  size_bytes: number;
  workspace_path?: string;
  file?: File;
}

export interface ImageAttachmentPreviewState {
  attachment: AttachmentListItem;
  dataUrl: string;
  isLoading: boolean;
  errorMessage: string;
}

export interface ChatModelOption {
  value: string;
  label: string;
  selectedLabel?: string;
  searchText?: string;
  disabled?: boolean;
  statusLabel?: string;
}

export interface ChatModelOptionGroup {
  label: string;
  options: ChatModelOption[];
}

interface ChatComposerSlashCommandOptionBase {
  key: string;
  command: string;
  label: string;
  description: string;
  searchText: string;
}

export interface ChatComposerSkillSlashCommandOption
  extends ChatComposerSlashCommandOptionBase {
  kind: "skill";
  skillId: string;
}

export interface ChatComposerCapabilitySlashCommandOption
  extends ChatComposerSlashCommandOptionBase {
  kind: "capability";
  capabilityId: string;
  installedSkillIds: string[];
  integrationProviders: string[];
}

export type ChatComposerSlashCommandOption =
  | ChatComposerSkillSlashCommandOption
  | ChatComposerCapabilitySlashCommandOption;

export interface ChatComposerQuotedSkillItem {
  skillId: string;
  title: string;
}

export interface ChatComposerQuotedIntegrationItem {
  slug: string;
  name: string;
  logo: string | null;
}

export interface ChatComposerMentionItem {
  id: string;
  /** What gets inserted into the text — without the leading `@`. */
  handle: string;
  /** Visible label in the picker. Single-line; descriptions are
   *  intentionally not part of this shape — quick pickers stay tight. */
  label: ReactNode;
  /** Tiny kind glyph (e.g. file/app icon) shown left of the label
   *  so mixed-kind menus stay readable. */
  kindIcon?: ReactNode;
  /** Plain-text aliases for fuzzy match. */
  keywords?: string[];
}

export interface StreamTelemetryEntry {
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
