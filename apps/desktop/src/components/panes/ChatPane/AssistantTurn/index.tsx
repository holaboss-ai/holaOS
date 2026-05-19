import { type ReactNode, memo, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { chatMessageTimeLabel } from "../helpers";
import type {
  ChatAssistantSegment,
  ChatExecutionTimelineItem,
  ChatMessage,
} from "../types";
import { AssistantTurnActionsMenu } from "./ActionsMenu";
import { AssistantTurnMemoryProposals } from "./MemoryProposals";
import { AssistantTurnOutputs } from "./Outputs";
import {
  AssistantTurnIntegrationConnects,
  type AssistantTurnPendingIntegration,
} from "./IntegrationConnectCard";
import { TraceStepGroup } from "./TraceStepGroup";
import { LiveStatusLine } from "./status";

function executionItemsHaveFileEdits(
  items: ChatExecutionTimelineItem[],
): boolean {
  if (items.length === 0) {
    return false;
  }
  return items.some((item) => {
    if (item.kind !== "trace_step" || item.step.kind !== "tool") {
      return false;
    }
    const title = item.step.title.toLowerCase();
    return (
      title.startsWith("edit") ||
      title.startsWith("write") ||
      title.startsWith("patch") ||
      title.startsWith("replace") ||
      title.startsWith("multiedit") ||
      title.startsWith("apply") ||
      title.startsWith("create file")
    );
  });
}

export const AssistantTurn = memo(AssistantTurnComponent, (prev, next) =>
  prev.label === next.label &&
  prev.mode === next.mode &&
  prev.showExecutionInternals === next.showExecutionInternals &&
  prev.text === next.text &&
  prev.tone === next.tone &&
  prev.segments === next.segments &&
  prev.executionItems === next.executionItems &&
  prev.memoryProposals === next.memoryProposals &&
  prev.outputs === next.outputs &&
  prev.pendingIntegrations === next.pendingIntegrations &&
  prev.memoryProposalAction === next.memoryProposalAction &&
  prev.editingMemoryProposalId === next.editingMemoryProposalId &&
  prev.memoryProposalDrafts === next.memoryProposalDrafts &&
  prev.collapsedTraceByStepId === next.collapsedTraceByStepId &&
  prev.live === next.live &&
  prev.status === next.status &&
  prev.statusAccessory === next.statusAccessory &&
  prev.footerAccessory === next.footerAccessory,
);

function AssistantTurnComponent({
  label,
  mode,
  showExecutionInternals = true,
  fitToContent = true,
  text,
  tone = "default",
  segments,
  executionItems,
  memoryProposals,
  outputs,
  pendingIntegrations = [],
  onAfterIntegrationBind,
  memoryProposalAction,
  editingMemoryProposalId,
  memoryProposalDrafts,
  onEditMemoryProposal,
  onMemoryProposalDraftChange,
  onAcceptMemoryProposal,
  onDismissMemoryProposal,
  onOpenOutput,
  onOpenAllArtifacts,
  collapsedTraceByStepId,
  onToggleTraceStep,
  onLinkClick,
  onLocalLinkClick,
  showAvatar = false,
  workspaceId = null,
  createdAt,
  status = "",
  live = false,
  statusAccessory = null,
  footerAccessory = null,
}: {
  label: string;
  mode: string;
  showExecutionInternals?: boolean;
  fitToContent?: boolean;
  text: string;
  tone?: ChatMessage["tone"];
  segments: ChatAssistantSegment[];
  executionItems: ChatExecutionTimelineItem[];
  memoryProposals: MemoryUpdateProposalRecordPayload[];
  outputs: WorkspaceOutputRecordPayload[];
  pendingIntegrations?: AssistantTurnPendingIntegration[];
  onAfterIntegrationBind?: () => void;
  memoryProposalAction: {
    proposalId: string;
    action: "accept" | "dismiss";
  } | null;
  editingMemoryProposalId: string | null;
  memoryProposalDrafts: Record<string, string>;
  onEditMemoryProposal: (proposalId: string) => void;
  onMemoryProposalDraftChange: (proposalId: string, value: string) => void;
  onAcceptMemoryProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
  onDismissMemoryProposal: (
    proposal: MemoryUpdateProposalRecordPayload,
  ) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  showAvatar?: boolean;
  workspaceId?: string | null;
  createdAt?: string;
  status?: string;
  live?: boolean;
  statusAccessory?: ReactNode;
  footerAccessory?: ReactNode;
}) {
  const normalizedStatus = (
    showExecutionInternals ? status : status ? "Working" : ""
  )
    .replace(/\.+$/, "")
    .trim();
  const visibleSegments = showExecutionInternals
    ? segments
    : segments.filter(
        (segment): segment is Extract<ChatAssistantSegment, { kind: "output" }> =>
          segment.kind === "output",
      );
  const visibleExecutionItems = showExecutionInternals ? executionItems : [];
  const renderedSegments =
    visibleSegments.length > 0
      ? visibleSegments
      : visibleExecutionItems.length > 0 || Boolean(text)
        ? [
            ...(visibleExecutionItems.length > 0
              ? ([
                  {
                    kind: "execution",
                    items: visibleExecutionItems,
                  },
                ] as ChatAssistantSegment[])
              : []),
            ...(text
              ? ([
                  {
                    kind: "output",
                    text,
                    tone,
                  },
                ] as ChatAssistantSegment[])
              : []),
          ]
        : [];
  const statusPlaceholderLabel =
    showExecutionInternals &&
    renderedSegments.length === 0 &&
    normalizedStatus.toLowerCase() === "checking workspace context"
      ? "Working"
      : normalizedStatus;
  const showStatusPlaceholder =
    live && Boolean(statusPlaceholderLabel) && renderedSegments.length === 0;
  const lastSegmentIsOutput =
    renderedSegments.length > 0 &&
    renderedSegments[renderedSegments.length - 1]?.kind === "output";
  const showWorkingStatusLine =
    live &&
    showExecutionInternals &&
    renderedSegments.length > 0 &&
    !lastSegmentIsOutput;
  const showStreamingCursor = live && lastSegmentIsOutput;

  const [forceExpandToken, setForceExpandToken] = useState(0);
  const hasFileEdits = useMemo(
    () => executionItemsHaveFileEdits(executionItems),
    [executionItems],
  );
  const copyText = useMemo(
    () =>
      renderedSegments
        .filter(
          (segment): segment is Extract<ChatAssistantSegment, { kind: "output" }> =>
            segment.kind === "output",
        )
        .map((segment) => segment.text)
        .join("\n\n")
        .trim() || text.trim(),
    [renderedSegments, text],
  );
  const hasAnyContent = renderedSegments.length > 0;
  const showActionsMenu = hasAnyContent && !live;
  const renderStatusLine = (nextLabel: string, className = "") => {
    const resolvedLabel = nextLabel.trim() || "Working";
    if (!statusAccessory) {
      return <LiveStatusLine label={resolvedLabel} className={className} />;
    }
    return (
      <div
        className={`flex min-w-0 items-center justify-between gap-3 ${className}`.trim()}
      >
        <LiveStatusLine label={resolvedLabel} className="min-w-0" />
        <div className="shrink-0">{statusAccessory}</div>
      </div>
    );
  };

  const timeLabel = chatMessageTimeLabel(createdAt);

  return (
    <div
      className="group/assistant-turn relative flex min-w-0 flex-col items-start animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
    >
      <div className="flex w-full min-w-0 items-end gap-2">
        <div className="w-5 shrink-0">
          {showAvatar && workspaceId ? (
            <AgentAvatar seed={workspaceId} size="sm" />
          ) : null}
        </div>
      <article
        className={
          fitToContent
            ? "min-w-0 inline-flex w-fit max-w-full flex-col rounded-lg bg-fg-6 dark:bg-card px-3 py-2"
            : "min-w-0 w-full max-w-4xl rounded-lg bg-fg-6 dark:bg-card px-3 py-2"
        }
      >
        {showStatusPlaceholder
          ? renderStatusLine(statusPlaceholderLabel)
          : null}

        {renderedSegments.map((segment, index) =>
          segment.kind === "execution" ? (
            <TraceStepGroup
              key={`execution-${index}`}
              items={segment.items}
              collapsedByStepId={collapsedTraceByStepId}
              onToggleStep={onToggleTraceStep}
              live={live}
              liveOutputStarted={
                live &&
                renderedSegments
                  .slice(index + 1)
                  .some((nextSegment) => nextSegment.kind === "output")
              }
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
              forceExpandToken={forceExpandToken}
            />
          ) : segment.tone === "error" ? (
            <div
              key={`output-${index}`}
              className="theme-chat-system-bubble mt-2 first:mt-0 rounded-xl border px-3 py-2.5 text-xs text-foreground"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                <SimpleMarkdown
                  className="chat-markdown max-w-full text-foreground"
                  onLinkClick={onLinkClick}
                  onLocalLinkClick={onLocalLinkClick}
                >
                  {segment.text}
                </SimpleMarkdown>
              </div>
            </div>
          ) : (
            <SimpleMarkdown
              key={`output-${index}`}
              className={`chat-markdown chat-assistant-markdown mt-2 first:mt-0 max-w-full text-foreground${
                showStreamingCursor && index === renderedSegments.length - 1
                  ? " is-live"
                  : ""
              }`}
              onLinkClick={onLinkClick}
              onLocalLinkClick={onLocalLinkClick}
            >
              {segment.text}
            </SimpleMarkdown>
          ),
        )}

        {showWorkingStatusLine
          ? renderStatusLine(
              "Working",
              renderedSegments.some((segment) => segment.kind === "execution")
                ? ""
                : "",
            )
          : null}

        {footerAccessory ? (
          <div className="mt-2 flex justify-start">{footerAccessory}</div>
        ) : null}

        {memoryProposals.length > 0 ? (
          <AssistantTurnMemoryProposals
            proposals={memoryProposals}
            proposalAction={memoryProposalAction}
            editingProposalId={editingMemoryProposalId}
            drafts={memoryProposalDrafts}
            onEditProposal={onEditMemoryProposal}
            onDraftChange={onMemoryProposalDraftChange}
            onAcceptProposal={onAcceptMemoryProposal}
            onDismissProposal={onDismissMemoryProposal}
          />
        ) : null}

        {outputs.length > 0 ? (
          <AssistantTurnOutputs
            outputs={outputs}
            onOpenOutput={onOpenOutput}
            onOpenAllArtifacts={onOpenAllArtifacts}
          />
        ) : null}

        {pendingIntegrations.length > 0 ? (
          <AssistantTurnIntegrationConnects
            pendingIntegrations={pendingIntegrations}
            onAfterBind={onAfterIntegrationBind}
          />
        ) : null}
      </article>

      </div>
      {showActionsMenu || (showAvatar && timeLabel) ? (
        <div className="flex h-6 items-center gap-2 pl-9">
          {showAvatar && timeLabel ? (
            <span className="select-none text-[10px] leading-none text-muted-foreground tabular-nums">
              {timeLabel}
            </span>
          ) : null}
          {showActionsMenu ? (
            <div className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover/assistant-turn:pointer-events-auto group-hover/assistant-turn:opacity-100 group-focus-within/assistant-turn:pointer-events-auto group-focus-within/assistant-turn:opacity-100">
              <AssistantTurnActionsMenu
                copyText={copyText}
                hasFileEdits={hasFileEdits}
                onViewFileChanges={
                  hasFileEdits
                    ? () => setForceExpandToken((token) => token + 1)
                    : undefined
                }
                onViewTurnDetails={
                  executionItems.length > 0
                    ? () => setForceExpandToken((token) => token + 1)
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
