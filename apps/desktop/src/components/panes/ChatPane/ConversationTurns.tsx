  import { Fragment, type ReactNode, useMemo } from "react";
import { AssistantTurn } from "./AssistantTurn";
import {
  dedupePendingIntegrationsByIndex,
  NO_PENDING_INTEGRATIONS,
} from "./pendingIntegrationDedupe";
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

/**
 * Shared empty arrays for absent optional message fields.
 *
 * AssistantTurn is memoized on a comparator that compares these props by
 * reference, so a fresh `[]` literal per render defeats the memo for every
 * message that simply does not have that field.
 */
const NO_SEGMENTS: NonNullable<ChatMessage["segments"]> = [];
const NO_EXECUTION_ITEMS: NonNullable<ChatMessage["executionItems"]> = [];
const NO_OUTPUTS: NonNullable<ChatMessage["outputs"]> = [];
const NO_PROPOSED_INTEGRATIONS: NonNullable<ChatMessage["proposedIntegrations"]> = [];
const NO_MCP_AUTHORIZATIONS: NonNullable<ChatMessage["mcpAuthorizations"]> = [];
const NO_PUBLISHED_POSTS: NonNullable<ChatMessage["publishedPosts"]> = [];
const NO_BACKGROUND_TASK_REFERENCES: ChatBackgroundTaskReference[] = [];

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
  // Memoized on `messages` so the arrays handed to AssistantTurn keep their
  // identity between renders. Previously this ran per render and each turn got
  // a fresh `.filter()` result, so the comparator's
  // `prev.pendingIntegrations === next.pendingIntegrations` was never true --
  // AssistantTurn's memo never hit once, and every message in the
  // conversation re-rendered on every ChatPane render.
  const dedupedPendingIntegrationsByIndex = useMemo(
    () => dedupePendingIntegrationsByIndex(messages),
    [messages],
  );
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
          segments={message.segments ?? NO_SEGMENTS}
          executionItems={message.executionItems ?? NO_EXECUTION_ITEMS}
          outputs={message.outputs ?? NO_OUTPUTS}
          pendingIntegrations={
            dedupedPendingIntegrationsByIndex[index] ?? NO_PENDING_INTEGRATIONS
          }
          proposedIntegrations={message.proposedIntegrations ?? NO_PROPOSED_INTEGRATIONS}
          mcpAuthorizations={message.mcpAuthorizations ?? NO_MCP_AUTHORIZATIONS}
          publishedPosts={message.publishedPosts ?? NO_PUBLISHED_POSTS}
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
          backgroundTaskReferences={
            message.backgroundTaskReferences ?? NO_BACKGROUND_TASK_REFERENCES
          }
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
    const liveTurnKey = liveAssistantTurn.id ?? "__live_assistant_turn__";
    // Mirrors the spacing the committed turn will carry. Getting this wrong is
    // a shift of exactly one `mt-2` (8px) at completion — the residual nudge
    // left after the remount was fixed, because the live wrapper had no spacing
    // and the committed one does.
    const livePrevious = messages[messages.length - 1];
    const liveIsFirstInAssistantGroup =
      messages.length === 0 || livePrevious?.role === "user";
    const liveIsGroupedContinuation =
      livePrevious?.role === "assistant" && !liveIsFirstInAssistantGroup;
    const liveSpacingClassName =
      messages.length > 0 && !liveIsGroupedContinuation ? "mt-2" : "";
    renderedTurns.push(
      // Same key AND the same wrapper element the turn will carry once
      // committed, so React reconciles the live node into the committed one
      // instead of unmount+remount.
      //
      // The key alone was not enough, which is why the completion flicker
      // outlived the comment that used to sit here: a keyed Fragment and a
      // keyed <div> are different element TYPES, and React tears down and
      // rebuilds across a type change no matter what the key says. The remount
      // replayed `animate-in fade-in-0 slide-in-from-bottom-1` on the turn —
      // a fade and a slide, which is the "blink + nudge" at the end of a turn.
      //
      // Matching the wrapper is what makes the key do its job.
      <div
        key={liveTurnKey}
        data-message-id={liveAssistantTurn.id ?? undefined}
        // Spacing only. The per-message decorator (search highlight and
        // friends) needs a full Message and does not apply to a live turn, but
        // the SPACING must match what the committed turn will have or the turn
        // moves by 8px the moment it settles.
        className={liveSpacingClassName || undefined}
      >
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
          showAvatar={liveIsFirstInAssistantGroup}
          workspaceId={workspaceId ?? null}
          harnessId={harnessId}
          assistantAvatar={assistantAvatar}
          assistantAvatarPreset={assistantAvatarPreset}
          live
          statusAccessory={liveAssistantTurn.statusAccessory ?? null}
          status={liveAssistantTurn.status ?? ""}
          footerAccessory={liveAssistantTurn.footerAccessory ?? null}
        />
      </div>,
    );
  }

  return <>{renderedTurns}</>;
}
