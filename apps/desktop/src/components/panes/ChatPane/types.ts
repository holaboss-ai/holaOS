import type { ReactNode } from "react";

export type ChatAttachment = SessionInputAttachmentPayload;
export type ChatPaneVariant = "default" | "onboarding" | "embedded";

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
  pendingIntegrations?: ChatPendingIntegration[];
  // Proposals emitted by `holaboss_workspace_integrations_propose_connect`. Same
  // visual treatment as pendingIntegrations but no app_id (the agent is
  // asking to add to the account-level integration pool so it can call
  // the toolkit's tools directly — no app wrapping).
  proposedIntegrations?: ChatProposedIntegration[];
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

export type PendingAttachment =
  | PendingLocalAttachmentFile
  | PendingExplorerAttachmentFile;

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
  browserSnapshot: BrowserVisibleSnapshotPayload | null;
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

export interface ChatComposerSlashCommandOption {
  key: string;
  kind: "skill";
  command: string;
  label: string;
  description: string;
  searchText: string;
  skillId: string;
}

export interface ChatComposerQuotedSkillItem {
  skillId: string;
  title: string;
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
