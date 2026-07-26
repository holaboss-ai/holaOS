  import { Fragment, type ReactNode } from "react";
import { AssistantTurn } from "./AssistantTurn";
import { UserTurn } from "./UserTurn";
import type {
  AttachmentListItem,
  ChatAssistantSegment,
  ChatBackgroundTaskReference,
  ChatExecutionTimelineItem,
  ChatMessage,
} from "./types";

// Consecutive assistant messages stay in one avatar group, but a later
// delivery (e.g. a follow-up after a subagent finishes) should read as newly
// arrived — so break the group and re-show the avatar + timestamp once the gap
// from the previous message crosses this threshold.
const ASSISTANT_GROUP_BREAK_MS = 60_000;

export function ConversationTurns<Message extends ChatMessage>({
  messages,
  assistantLabel,
  assistantMode,
  showExecutionInternals,
  /** Drives the agent avatar's seed so each workspace has its own
   *  persistent face. */
  workspaceId,
  /** Brands the assistant avatar by the session's harness (Claude/Codex
   *  show their own mark; pi keeps the Hola monogram). */
  harnessId = null,
  /** When set (a HolaEmployee chat), render this identity avatar instead of the
   *  harness/workspace-seeded one. */
  assistantAvatar = null,
  /** True for the preset "Hola" employee — render the canonical Hola mascot for
   *  every assistant turn instead of the color+emoji identity avatar. */
  assistantAvatarPreset = false,
  onPreviewAttachment,
  onOpenOutput,
  collapsedTraceByStepId,
  onToggleTraceStep,
  onLinkClick,
  onLocalLinkClick,
  assistantFooterAccessoryMessageId = null,
  assistantFooterAccessory = null,
  getMessageWrapperClassName,
  liveAssistantTurn = null,
  onAfterIntegrationBind,
  onAfterIntegrationProposalConnected,
  onAfterMcpAuthorized,
  onOpenBackgroundTaskReference,
}: {
  messages: Message[];
  assistantLabel: string;
  assistantMode: string;
  showExecutionInternals: boolean;
  workspaceId?: string | null;
  harnessId?: string | null;
  assistantAvatar?: { color: string; emoji: string } | null;
  assistantAvatarPreset?: boolean;
  onPreviewAttachment?: (attachment: AttachmentListItem) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  assistantFooterAccessoryMessageId?: string | null;
  assistantFooterAccessory?: ReactNode;
  getMessageWrapperClassName?: (message: Message) => string | undefined;
  liveAssistantTurn?: {
    /** The id the turn will carry once committed to `messages`
     *  (`assistant-${inputId}`). Keying the live turn with it lets React
     *  reconcile live→committed as the same node instead of remounting — the
     *  remount otherwise replays AssistantTurn's entrance animation on every
     *  completion, reading as a flicker. */
    id?: string;
    text: string;
    tone?: ChatMessage["tone"];
    segments: ChatAssistantSegment[];
    executionItems: ChatExecutionTimelineItem[];
    status?: string;
    statusAccessory?: ReactNode;
    footerAccessory?: ReactNode;
  } | null;
  onAfterIntegrationBind?: () => void;
  onAfterIntegrationProposalConnected?: (toolkitSlug: string) => void;
  onAfterMcpAuthorized?: (serverId: string) => void;
  /** When provided, an assistant message that spawned a background task shows a
   *  subtle inline "open task" chip — the only in-chat entry back into a task's
   *  detail once it's dropped off the composer strip. Omitted (e.g. inside the
   *  task detail itself) → no chip. */
  onOpenBackgroundTaskReference?: (
    reference: ChatBackgroundTaskReference,
  ) => void;
}) {
  // Cross-turn dedup of pending-integration cards. A long-running build
  // session re-emits `pending_integrations` on every workspace_apps_*
  // tool call, so the same `(provider, app_id)` pair appears across
  // many assistant turns. Without dedup, the chat ends up with stacks
  // of stale Connect / Pick-account cards from earlier turns even
  // after the user has already authorized — exactly the failure mode
  // in the duplicate-Connect-card report. Only the latest assistant
  // turn that introduced a given `(provider, app_id)` should keep the
  // interactive card; earlier turns drop that entry.
  const latestPendingIntegrationIndexByKey = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    for (const entry of m.pendingIntegrations ?? []) {
      const key = `${entry.provider_id.trim().toLowerCase()}|${entry.app_id.trim().toLowerCase()}`;
      if (!key) continue;
      latestPendingIntegrationIndexByKey.set(key, i);
    }
  }
  const renderedTurns = messages.map((message, index) => {
    const wrapperClassName = getMessageWrapperClassName?.(message)?.trim();
    const previousMessage = messages[index - 1];
    // A turn's "worked" time spans from the message that triggered it (the
    // previous message) to its own completion — what "Worked for Ns" means.
    const prevCreatedAt = previousMessage?.createdAt;
    const workedMs =
      message.role === "assistant" && prevCreatedAt && message.createdAt
        ? (() => {
            const start = Date.parse(prevCreatedAt);
            const end = Date.parse(message.createdAt);
            return Number.isNaN(start) || Number.isNaN(end) || end <= start
              ? undefined
              : end - start;
          })()
        : undefined;
    // Avatar + time render as a header above the first message of an
    // assistant group; later messages in the same group stay headerless —
    // unless a meaningful gap separates this delivery from the previous one,
    // in which case it reads as a fresh arrival and gets its own header.
    const assistantGapMs =
      previousMessage?.role === "assistant" &&
      prevCreatedAt &&
      message.createdAt
        ? (() => {
            const start = Date.parse(prevCreatedAt);
            const end = Date.parse(message.createdAt);
            return Number.isNaN(start) || Number.isNaN(end)
              ? 0
              : end - start;
          })()
        : 0;
    const isFirstInAssistantGroup =
      message.role === "assistant" &&
      (!previousMessage ||
        previousMessage.role === "user" ||
        assistantGapMs > ASSISTANT_GROUP_BREAK_MS);
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
          text={message.text}
          tone={message.tone ?? "default"}
          segments={message.segments ?? []}
          executionItems={message.executionItems ?? []}
          outputs={message.outputs ?? []}
          pendingIntegrations={(message.pendingIntegrations ?? []).filter(
            (entry) => {
              const key = `${entry.provider_id.trim().toLowerCase()}|${entry.app_id.trim().toLowerCase()}`;
              return latestPendingIntegrationIndexByKey.get(key) === index;
            },
          )}
          proposedIntegrations={message.proposedIntegrations ?? []}
          mcpAuthorizations={message.mcpAuthorizations ?? []}
          publishedPosts={message.publishedPosts ?? []}
          onAfterIntegrationBind={onAfterIntegrationBind}
          onAfterIntegrationProposalConnected={onAfterIntegrationProposalConnected}
          onAfterMcpAuthorized={onAfterMcpAuthorized}
          onOpenOutput={onOpenOutput}
          collapsedTraceByStepId={collapsedTraceByStepId}
          onToggleTraceStep={onToggleTraceStep}
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
          showAvatar={isFirstInAssistantGroup}
          workspaceId={workspaceId ?? null}
          harnessId={harnessId}
          assistantAvatar={assistantAvatar}
          assistantAvatarPreset={assistantAvatarPreset}
          createdAt={message.createdAt}
          workedMs={workedMs}
          footerAccessory={
            message.id === assistantFooterAccessoryMessageId
              ? assistantFooterAccessory
              : null
          }
          backgroundTaskReferences={message.backgroundTaskReferences ?? []}
          onOpenBackgroundTaskReference={onOpenBackgroundTaskReference}
        />
      );

    // Grouped assistant follow-ups keep the tight base gap; every other
    // boundary is between two independent messages, so give it a touch more
    // breathing room than the uniform column gap.
    const isGroupedContinuation =
      message.role === "assistant" &&
      previousMessage?.role === "assistant" &&
      !isFirstInAssistantGroup;
    const spacingClassName =
      index > 0 && !isGroupedContinuation ? "mt-2" : "";
    const combinedClassName = [wrapperClassName, spacingClassName]
      .filter(Boolean)
      .join(" ");

    // Every turn gets a wrapper carrying its message id so features like
    // in-conversation search can locate and scroll to it in the DOM.
    return (
      <div
        key={message.id}
        data-message-id={message.id}
        className={combinedClassName || undefined}
      >
        {turn}
      </div>
    );
  });

  if (liveAssistantTurn) {
    renderedTurns.push(
      // Same key the turn will carry once committed, so React reconciles the
      // live node into the committed one instead of unmount+remount (which
      // replays the entrance animation — the completion "flicker").
      <Fragment key={liveAssistantTurn.id ?? "__live_assistant_turn__"}>
        <AssistantTurn
          label={assistantLabel}
          mode={assistantMode}
          showExecutionInternals={showExecutionInternals}
          text={liveAssistantTurn.text}
          tone={liveAssistantTurn.tone ?? "default"}
          segments={liveAssistantTurn.segments}
          executionItems={liveAssistantTurn.executionItems}
          outputs={[]}
          onOpenOutput={onOpenOutput}
          collapsedTraceByStepId={collapsedTraceByStepId}
          onToggleTraceStep={onToggleTraceStep}
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
          showAvatar={
            messages.length === 0 ||
            messages[messages.length - 1]?.role === "user"
          }
          workspaceId={workspaceId ?? null}
          harnessId={harnessId}
          assistantAvatar={assistantAvatar}
          assistantAvatarPreset={assistantAvatarPreset}
          live
          statusAccessory={liveAssistantTurn.statusAccessory ?? null}
          status={liveAssistantTurn.status ?? ""}
          footerAccessory={liveAssistantTurn.footerAccessory ?? null}
        />
      </Fragment>,
    );
  }

  return <>{renderedTurns}</>;
}
