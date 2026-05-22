import { Fragment, type ReactNode } from "react";
import { AssistantTurn } from "./AssistantTurn";
import { UserTurn } from "./UserTurn";
import type {
  AttachmentListItem,
  ChatAssistantSegment,
  ChatExecutionTimelineItem,
  ChatMessage,
} from "./types";

export function ConversationTurns<Message extends ChatMessage>({
  messages,
  assistantLabel,
  assistantMode,
  showExecutionInternals,
  assistantFitToContent = true,
  /** Drives the agent avatar's seed so each workspace has its own
   *  persistent face. */
  workspaceId,
  onPreviewAttachment,
  onOpenOutput,
  onOpenAllArtifacts,
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
}: {
  messages: Message[];
  assistantLabel: string;
  assistantMode: string;
  showExecutionInternals: boolean;
  assistantFitToContent?: boolean;
  workspaceId?: string | null;
  onPreviewAttachment?: (attachment: AttachmentListItem) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
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
  onAfterIntegrationBind?: () => void;
  onAfterIntegrationProposalConnected?: (toolkitSlug: string) => void;
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
  return (
    <>
      {messages.map((message, index) => {
        const wrapperClassName = getMessageWrapperClassName?.(message)?.trim();
        const next = messages[index + 1];
        const isLastInAssistantGroup =
          message.role === "assistant" &&
          (!next || next.role === "user") &&
          // Suppress only when the live turn continues this same group
          // (no user message has rolled in to break it). When `next` is
          // a user turn the live turn is a new group and this assistant
          // message keeps its avatar.
          !(liveAssistantTurn && !next);
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
              outputs={message.outputs ?? []}
              pendingIntegrations={(message.pendingIntegrations ?? []).filter(
                (entry) => {
                  const key = `${entry.provider_id.trim().toLowerCase()}|${entry.app_id.trim().toLowerCase()}`;
                  return latestPendingIntegrationIndexByKey.get(key) === index;
                },
              )}
              proposedIntegrations={message.proposedIntegrations ?? []}
              onAfterIntegrationBind={onAfterIntegrationBind}
              onAfterIntegrationProposalConnected={onAfterIntegrationProposalConnected}
              onOpenOutput={onOpenOutput}
              onOpenAllArtifacts={onOpenAllArtifacts}
              collapsedTraceByStepId={collapsedTraceByStepId}
              onToggleTraceStep={onToggleTraceStep}
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
              showAvatar={isLastInAssistantGroup}
              workspaceId={workspaceId ?? null}
              createdAt={message.createdAt}
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
          outputs={[]}
          onOpenOutput={onOpenOutput}
          onOpenAllArtifacts={onOpenAllArtifacts}
          collapsedTraceByStepId={collapsedTraceByStepId}
          onToggleTraceStep={onToggleTraceStep}
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
          showAvatar
          workspaceId={workspaceId ?? null}
          live
          statusAccessory={liveAssistantTurn.statusAccessory ?? null}
          status={liveAssistantTurn.status ?? ""}
          footerAccessory={liveAssistantTurn.footerAccessory ?? null}
        />
      ) : null}
    </>
  );
}
