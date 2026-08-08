import { type ReactNode, memo, useMemo, useState } from "react";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { HarnessAvatar } from "@/components/harness/HarnessAvatar";
import { ErrorSegment } from "./ErrorSegment";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { chatMessageTimeLabel } from "../helpers";
import { useOpenDiscover } from "@/components/layout/shell/useOpenDiscover";
import { useShareToHolahub } from "@/components/layout/shell/useShareToHolahub";
import { useAtomValue } from "jotai";
import {
  enrichOutputs,
  gatherQuotedToolItems,
  gatherShareAttributionItems,
  resolveOutputModel,
  gatherShareImages,
  mergeOutputsByPath,
  gatherShareVideos,
  isShareableMediaOutput,
  outputRecordsForTurns,
  turnsForOutputs,
} from "./shareCapture";
import { shareContextAtom } from "./shareContext";
import type {
  ChatAssistantSegment,
  ChatBackgroundTaskReference,
  ChatExecutionTimelineItem,
  ChatMessage,
  ChatPublishedHubPost,
} from "../types";
import { AssistantTurnActionsMenu } from "./ActionsMenu";
import { AssistantTurnOutputs } from "./Outputs";
import {
  AssistantTurnIntegrationConnects,
  type AssistantTurnPendingIntegration,
} from "./IntegrationConnectCard";
import {
  AssistantTurnIntegrationProposals,
  type AssistantTurnProposedIntegration,
} from "./IntegrationProposalCard";
import { AssistantTurnMcpAuthorizations } from "./McpAuthorizeCard";
import type { ChatMcpAuthorization } from "../types";
import { TraceStepGroup } from "./TraceStepGroup";
import { resolveTurnStatus } from "./turnStatus";
import {
  ArrowUpRight,
  CircleAlert,
  CompassFilled,
  Loader2,
  Task,
} from "@/components/ui/icons";

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

// "View on HolaHub" cards for posts the agent published this turn — clicking
// opens our own Discover surface deep-linked to the thread.
function PublishedHubPostCards({ posts }: { posts: ChatPublishedHubPost[] }) {
  const openDiscover = useOpenDiscover();
  if (posts.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {posts.map((post) => (
        <button
          className="group flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-card py-2.5 pr-3 pl-2.5 text-left transition-colors hover:bg-accent"
          key={post.postId}
          onClick={() => openDiscover(`/threads/${post.postId}`)}
          type="button"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CompassFilled className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-sm leading-tight">
              {post.title || "Your HolaHub post"}
            </span>
            <span className="mt-0.5 block truncate text-muted-foreground text-xs">
              Published to HolaHub · View on Discover
            </span>
          </span>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>
      ))}
    </div>
  );
}

export const AssistantTurn = memo(AssistantTurnComponent, (prev, next) =>
  prev.label === next.label &&
  prev.mode === next.mode &&
  prev.showExecutionInternals === next.showExecutionInternals &&
  prev.text === next.text &&
  prev.tone === next.tone &&
  prev.segments === next.segments &&
  prev.executionItems === next.executionItems &&
  prev.outputs === next.outputs &&
  prev.pendingIntegrations === next.pendingIntegrations &&
  prev.proposedIntegrations === next.proposedIntegrations &&
  prev.mcpAuthorizations === next.mcpAuthorizations &&
  prev.publishedPosts === next.publishedPosts &&
  prev.collapsedTraceByStepId === next.collapsedTraceByStepId &&
  prev.live === next.live &&
  prev.workedMs === next.workedMs &&
  prev.status === next.status &&
  prev.statusAccessory === next.statusAccessory &&
  prev.footerAccessory === next.footerAccessory &&
  prev.backgroundTaskReferences === next.backgroundTaskReferences &&
  prev.onOpenBackgroundTaskReference === next.onOpenBackgroundTaskReference &&
  prev.harnessId === next.harnessId,
);

function AssistantTurnComponent({
  label,
  mode,
  showExecutionInternals = true,
  text,
  tone = "default",
  segments,
  executionItems,
  outputs,
  pendingIntegrations = [],
  proposedIntegrations = [],
  mcpAuthorizations = [],
  publishedPosts = [],
  onAfterIntegrationBind,
  onAfterIntegrationProposalConnected,
  onAfterMcpAuthorized,
  onOpenOutput,
  collapsedTraceByStepId,
  onToggleTraceStep,
  onLinkClick,
  onLocalLinkClick,
  showAvatar = false,
  workspaceId = null,
  harnessId = null,
  assistantAvatar = null,
  assistantAvatarPreset = false,
  createdAt,
  workedMs,
  status = "",
  live = false,
  statusAccessory = null,
  footerAccessory = null,
  backgroundTaskReferences = [],
  onOpenBackgroundTaskReference,
}: {
  label: string;
  mode: string;
  showExecutionInternals?: boolean;
  text: string;
  tone?: ChatMessage["tone"];
  segments: ChatAssistantSegment[];
  executionItems: ChatExecutionTimelineItem[];
  outputs: WorkspaceOutputRecordPayload[];
  pendingIntegrations?: AssistantTurnPendingIntegration[];
  proposedIntegrations?: AssistantTurnProposedIntegration[];
  mcpAuthorizations?: ChatMcpAuthorization[];
  publishedPosts?: ChatPublishedHubPost[];
  onAfterIntegrationBind?: () => void;
  onAfterIntegrationProposalConnected?: (toolkitSlug: string) => void;
  onAfterMcpAuthorized?: (serverId: string) => void;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  collapsedTraceByStepId: Record<string, boolean>;
  onToggleTraceStep: (stepId: string) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  showAvatar?: boolean;
  workspaceId?: string | null;
  harnessId?: string | null;
  /** When set (e.g. a HolaEmployee chat), render this identity avatar instead of the
   *  harness-branded, workspace-seeded one. */
  assistantAvatar?: { color: string; emoji: string } | null;
  /** True for the preset "Hola" employee — render the canonical Hola mascot. */
  assistantAvatarPreset?: boolean;
  createdAt?: string;
  workedMs?: number;
  status?: string;
  live?: boolean;
  statusAccessory?: ReactNode;
  footerAccessory?: ReactNode;
  backgroundTaskReferences?: ChatBackgroundTaskReference[];
  onOpenBackgroundTaskReference?: (
    reference: ChatBackgroundTaskReference,
  ) => void;
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
  const lastSegment =
    renderedSegments.length > 0
      ? renderedSegments[renderedSegments.length - 1]
      : null;
  const lastSegmentIsOutput = lastSegment?.kind === "output";
  const showStreamingCursor = live && lastSegmentIsOutput;
  const statusFallback =
    normalizedStatus.toLowerCase() === "checking workspace context"
      ? "Working"
      : normalizedStatus;
  const turnStatus = resolveTurnStatus(renderedSegments, {
    live,
    workedMs,
    statusFallback,
  });

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
  const shareToHolahub = useShareToHolahub();
  const shareContext = useAtomValue(shareContextAtom);
  const hasShareMediaOutput = outputs.some(isShareableMediaOutput);
  const turnStatusAnchor = turnStatus ? (
    <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3">
      <div
        className={`flex min-w-0 items-center gap-1.5 text-xs leading-5 ${
          turnStatus.tone === "error"
            ? "font-medium text-destructive"
            : "text-muted-foreground"
        }`}
      >
        {turnStatus.spinning ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : turnStatus.tone === "error" ? (
          <CircleAlert className="size-3.5 shrink-0" strokeWidth={2} />
        ) : null}
        <span className="min-w-0 truncate">{turnStatus.label}</span>
      </div>
      {statusAccessory ? <div className="shrink-0">{statusAccessory}</div> : null}
    </div>
  ) : null;

  const timeLabel = chatMessageTimeLabel(createdAt);

  return (
    <div
      className="group/assistant-turn relative flex min-w-0 flex-col items-start gap-1 animate-in fade-in-0 slide-in-from-bottom-1 duration-snappy ease-out-expo"
    >
      {showAvatar && assistantAvatarPreset ? (
        <div className="mb-0.5 flex items-center">
          <AgentAvatar className="size-6 rounded-full" />
        </div>
      ) : showAvatar && assistantAvatar ? (
        <div className="mb-0.5 flex items-center">
          <span
            aria-hidden
            className="grid size-6 shrink-0 place-items-center rounded-full text-[13px] leading-none"
            style={{ backgroundColor: assistantAvatar.color }}
          >
            {assistantAvatar.emoji}
          </span>
        </div>
      ) : showAvatar && workspaceId ? (
        <div className="mb-0.5 flex items-center">
          <HarnessAvatar harnessId={harnessId} seed={workspaceId} size="sm" />
        </div>
      ) : null}
      <div className="flex min-w-0 w-full flex-col">
        {turnStatusAnchor}

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
            <ErrorSegment key={`output-${index}`} text={segment.text} />
          ) : (
            <SimpleMarkdown
              key={`output-${index}`}
              className={`chat-markdown chat-assistant-markdown mt-2.5 first:mt-0 max-w-full text-foreground${
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

        {footerAccessory ? (
          <div className="mt-2 flex justify-start">{footerAccessory}</div>
        ) : null}

        {outputs.length > 0 ? (
          <AssistantTurnOutputs
            outputs={outputs}
            onOpenOutput={onOpenOutput}
            turnText={copyText}
            workspaceId={workspaceId}
          />
        ) : null}

        <PublishedHubPostCards posts={publishedPosts} />

        {pendingIntegrations.length > 0 ? (
          <AssistantTurnIntegrationConnects
            pendingIntegrations={pendingIntegrations}
            onAfterBind={onAfterIntegrationBind}
          />
        ) : null}

        {proposedIntegrations.length > 0 ? (
          <AssistantTurnIntegrationProposals
            onAfterConnect={onAfterIntegrationProposalConnected}
            proposals={proposedIntegrations}
            workspaceId={workspaceId}
          />
        ) : null}

        {mcpAuthorizations.length > 0 ? (
          <AssistantTurnMcpAuthorizations
            mcpAuthorizations={mcpAuthorizations}
            workspaceId={workspaceId}
            createdAt={createdAt}
            onAfterAuthorize={onAfterMcpAuthorized}
          />
        ) : null}

        {onOpenBackgroundTaskReference && backgroundTaskReferences.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {backgroundTaskReferences.map((reference, refIndex) => (
              <button
                key={`taskref-${refIndex}`}
                type="button"
                onClick={() => onOpenBackgroundTaskReference(reference)}
                className="group/taskref inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted py-1 pl-1.5 pr-2.5 text-[12px] transition-colors hover:bg-fg-2"
              >
                <span className="grid size-4 shrink-0 place-items-center rounded-md bg-fg-6 text-foreground/60">
                  <Task className="size-2.5" />
                </span>
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-foreground/40">
                  Task
                </span>
                <span className="max-w-[240px] truncate font-medium text-foreground/75">
                  {reference.title?.trim() || "Untitled task"}
                </span>
                <ArrowUpRight className="size-3 shrink-0 text-foreground/35 transition-transform group-hover/taskref:translate-x-0.5" />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {showActionsMenu || (showAvatar && timeLabel) ? (
        <div className="mt-1 flex h-6 items-center gap-2">
          {showAvatar && timeLabel ? (
            <span className="select-none text-xs leading-none text-muted-foreground tabular-nums">
              {timeLabel}
            </span>
          ) : null}
          {showActionsMenu ? (
            <div className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover/assistant-turn:pointer-events-auto group-hover/assistant-turn:opacity-100 group-focus-within/assistant-turn:pointer-events-auto group-focus-within/assistant-turn:opacity-100">
              <AssistantTurnActionsMenu
                copyText={copyText}
                hasFileEdits={hasFileEdits}
                onShareToHolahub={
                  hasShareMediaOutput
                    ? async () => {
                        const ready = enrichOutputs(
                          mergeOutputsByPath(outputs),
                          await outputRecordsForTurns(workspaceId, outputs)
                        );
                        const [images, videos] = await Promise.all([
                          gatherShareImages(ready, workspaceId),
                          gatherShareVideos(ready, workspaceId),
                        ]);
                        await shareToHolahub({
                          sourceText: copyText,
                          images,
                          videos,
                          items: [
                            ...gatherQuotedToolItems(
                              turnsForOutputs(ready, shareContext.messages),
                              shareContext.toolNames
                            ),
                            ...gatherShareAttributionItems(ready),
                          ],
                          form: "output",
                          recipe: {
                            prompt: "",
                            model: "",
                            outputModel: resolveOutputModel(ready),
                          },
                        });
                      }
                    : undefined
                }
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
