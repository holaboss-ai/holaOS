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
  workspaceId?: string | null;
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
