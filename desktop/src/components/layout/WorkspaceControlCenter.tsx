import {
  ArrowUpRight,
  GripVertical,
  Loader2,
  SendHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
} from "react";
import {
  ArtifactBrowserModal,
  chatMessagesFromSessionState,
  ConversationTurns,
  type ArtifactBrowserFilter,
  historyMessagesInDisplayOrder,
  inputIdFromMessageId,
  turnInputIdsFromHistoryMessages,
  type ChatMessage,
} from "@/components/panes/ChatPane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { cn } from "@/lib/utils";

const PREVIEW_HISTORY_LIMIT = 18;
const PREVIEW_MESSAGE_LIMIT = 12;
const PREVIEW_OUTPUT_LIMIT = 80;
const WORKSPACE_CARD_MIN_WIDTH = 320;
const CONTROL_CENTER_TERMINAL_REFRESH_DELAYS_MS = [150, 500, 1_500, 3_000];
const CONTROL_CENTER_IDLE_RECONCILE_INTERVAL_MS = 2500;
const CONTROL_CENTER_RUNTIME_POLL_INTERVAL_MS = 750;
const CARD_VISIBILITY_THRESHOLD = 0.5;

type PreviewChatMessage = ChatMessage & {
  optimistic?: boolean;
};

type RuntimeCardState = "idle" | "queued" | "working" | "waiting" | "error";

interface WorkspaceControlCenterProps {
  workspaces: WorkspaceRecordPayload[];
  selectedWorkspaceId: string | null;
  cardsPerRow: number;
  composerModel: string | null;
  orderedWorkspaceIds: readonly string[];
  highlightedWorkspaceIds: readonly string[];
  onSelectWorkspace: (workspaceId: string) => void;
  onEnterWorkspace: (workspaceId: string) => void;
  onOpenOutput: (
    workspaceId: string,
    output: WorkspaceOutputRecordPayload,
  ) => void;
  onWorkspaceOrderChange: (workspaceIds: string[]) => void;
  onVisibleWorkspaceIdsChange: (workspaceIds: string[]) => void;
  onCardComposerSubmit: (workspaceId: string) => void;
  onWorkspaceCompletion: (workspaceId: string) => void;
}

interface WorkspaceCardProps {
  workspace: WorkspaceRecordPayload;
  isSelected: boolean;
  isDragging: boolean;
  isDragTarget: boolean;
  hasUnreadCompletionHighlight: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onEnterWorkspace: (workspaceId: string) => void;
  onOpenOutput: (
    workspaceId: string,
    output: WorkspaceOutputRecordPayload,
  ) => void;
  onDragStartWorkspace: (
    event: ReactDragEvent<HTMLButtonElement>,
    workspaceId: string,
  ) => void;
  onDragEnterWorkspace: (workspaceId: string) => void;
  onDragOverWorkspace: (event: ReactDragEvent<HTMLElement>) => void;
  onDropWorkspace: (event: ReactDragEvent<HTMLElement>, workspaceId: string) => void;
  onDragEndWorkspace: () => void;
  onWorkspaceCompletion: (workspaceId: string) => void;
  onRuntimeStateChange: (
    workspaceId: string,
    state: RuntimeCardState,
  ) => void;
}

function runtimeStateStatus(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function runtimeStateEffectiveStatus(
  runtimeState:
    | Pick<SessionRuntimeRecordPayload, "status" | "effective_state">
    | null
    | undefined,
): string {
  return runtimeStateStatus(
    runtimeState?.effective_state ?? runtimeState?.status,
  );
}

function trimPreviewMessages(messages: PreviewChatMessage[]) {
  return messages.slice(-PREVIEW_MESSAGE_LIMIT);
}

function latestPreviewMessageId(messages: PreviewChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageId = messages[index]?.id?.trim() || "";
    if (messageId) {
      return messageId;
    }
  }
  return "";
}

function compareTimestampsDescending(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftValue = Date.parse(left || "") || 0;
  const rightValue = Date.parse(right || "") || 0;
  return rightValue - leftValue;
}

function fallbackWorkspaceActivityAt(workspace: WorkspaceRecordPayload) {
  return workspace.updated_at || workspace.created_at || null;
}

function lastActivityFromSnapshot(params: {
  fallbackActivityAt: string | null;
  messages: PreviewChatMessage[];
}) {
  const lastMessageAt =
    [...params.messages]
      .reverse()
      .find((message) => Boolean(message.createdAt))?.createdAt ?? null;
  return lastMessageAt || params.fallbackActivityAt;
}

function mergeWorkspaceOrder(
  sortedWorkspaces: WorkspaceRecordPayload[],
  orderedWorkspaceIds: readonly string[],
) {
  const workspaceById = new Map(
    sortedWorkspaces.map((workspace) => [workspace.id.trim(), workspace]),
  );
  const merged: WorkspaceRecordPayload[] = [];
  const seenWorkspaceIds = new Set<string>();

  for (const workspaceId of orderedWorkspaceIds) {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId || seenWorkspaceIds.has(normalizedWorkspaceId)) {
      continue;
    }
    const workspace = workspaceById.get(normalizedWorkspaceId);
    if (!workspace) {
      continue;
    }
    seenWorkspaceIds.add(normalizedWorkspaceId);
    merged.push(workspace);
  }

  for (const workspace of sortedWorkspaces) {
    const normalizedWorkspaceId = workspace.id.trim();
    if (!normalizedWorkspaceId || seenWorkspaceIds.has(normalizedWorkspaceId)) {
      continue;
    }
    seenWorkspaceIds.add(normalizedWorkspaceId);
    merged.push(workspace);
  }

  return merged;
}

function previewStatusFromRuntimeState(
  runtimeState: SessionRuntimeRecordPayload | null,
): RuntimeCardState {
  const status = runtimeStateEffectiveStatus(runtimeState);
  if (status === "ERROR" || status === "FAILED") {
    return "error";
  }
  if (status === "BUSY") {
    return "working";
  }
  if (status === "QUEUED") {
    return "queued";
  }
  if (status === "WAITING_USER" || status === "PAUSED") {
    return "waiting";
  }
  return "idle";
}

function previewStatusLabel(state: RuntimeCardState) {
  switch (state) {
    case "error":
      return "Needs attention";
    case "queued":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "working":
      return "Working";
    default:
      return "Ready";
  }
}

function previewStatusVariant(state: RuntimeCardState) {
  switch (state) {
    case "error":
      return "destructive";
    case "queued":
    case "waiting":
      return "secondary";
    case "working":
      return "default";
    default:
      return "outline";
  }
}

function statusAccentClassName(state: RuntimeCardState) {
  switch (state) {
    case "error":
      return "bg-destructive";
    case "queued":
    case "waiting":
      return "bg-warning";
    case "working":
      return "bg-primary animate-pulse";
    default:
      return "bg-success";
  }
}

function statusStripeClassName(state: RuntimeCardState) {
  switch (state) {
    case "error":
      return "bg-destructive";
    case "queued":
    case "waiting":
      return "bg-warning";
    case "working":
      return "bg-primary";
    default:
      return "bg-transparent";
  }
}

/** Bucket recent message timestamps into `slotCount` equal time slices
 *  spanning the most-recent ~30 minutes, returning each slice's
 *  intensity normalised against the busiest slice. Powers the tiny
 *  activity-density bar in each tile's footer — Grafana-flavoured
 *  signal that something is alive without spelling out exact counts. */
function buildRecentEventDensity(
  messages: PreviewChatMessage[],
  slotCount: number,
): number[] {
  if (slotCount <= 0) {
    return [];
  }
  const windowMs = 30 * 60 * 1000;
  const now = Date.now();
  const buckets = new Array<number>(slotCount).fill(0);
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt || "");
    if (!Number.isFinite(timestamp)) continue;
    const ageMs = now - timestamp;
    if (ageMs < 0 || ageMs > windowMs) continue;
    const slotIndex = Math.min(
      slotCount - 1,
      slotCount - 1 - Math.floor((ageMs / windowMs) * slotCount),
    );
    if (slotIndex < 0) continue;
    buckets[slotIndex] += 1;
  }
  const peak = Math.max(...buckets, 0);
  if (peak === 0) {
    return buckets;
  }
  return buckets.map((value) => value / peak);
}

function isNearBottom(container: HTMLDivElement) {
  const remaining =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return remaining <= 28;
}

function runFailedDetail(payload: Record<string, unknown>) {
  const directFields = [
    payload.error,
    payload.detail,
    payload.message,
    payload.reason,
  ];
  for (const value of directFields) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "The workspace run failed.";
}

function formatLastActivityLabel(value: string | null | undefined) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return "Waiting for first chat";
  }
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const WorkspaceControlCenterCard = memo(function WorkspaceControlCenterCard({
  workspace,
  isSelected,
  isDragging,
  isDragTarget,
  hasUnreadCompletionHighlight,
  onSelectWorkspace,
  onEnterWorkspace,
  onOpenOutput,
  onDragStartWorkspace,
  onDragEnterWorkspace,
  onDragOverWorkspace,
  onDropWorkspace,
  onDragEndWorkspace,
  onWorkspaceCompletion,
  onRuntimeStateChange,
}: WorkspaceCardProps) {
  const workspaceId = workspace.id;
  const workspaceFallbackActivityAt = fallbackWorkspaceActivityAt(workspace);
  const [mainSession, setMainSession] = useState<AgentSessionRecordPayload | null>(
    null,
  );
  const [messages, setMessages] = useState<PreviewChatMessage[]>([]);
  const [runtimeState, setRuntimeState] =
    useState<SessionRuntimeRecordPayload | null>(null);
  const [runtimeCardState, setRuntimeCardState] =
    useState<RuntimeCardState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isResponding, setIsResponding] = useState(false);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [liveAgentStatus, setLiveAgentStatus] = useState("");
  const [artifactBrowserOpen, setArtifactBrowserOpen] = useState(false);
  const [artifactBrowserFilter, setArtifactBrowserFilter] =
    useState<ArtifactBrowserFilter>("all");
  const [artifactBrowserOutputs, setArtifactBrowserOutputs] = useState<
    WorkspaceOutputRecordPayload[]
  >([]);
  const previewScrollerRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<PreviewChatMessage[]>([]);
  const shouldStickToBottomRef = useRef(true);
  const activeStreamIdRef = useRef<string | null>(null);
  const pendingInputIdRef = useRef<string>("");
  const pendingCommittedAssistantMessageRef =
    useRef<PreviewChatMessage | null>(null);
  const liveAssistantTextRef = useRef("");
  const terminalRefreshTimerIdsRef = useRef<number[]>([]);
  const hasHydratedSnapshotRef = useRef(false);
  const latestAssistantMessageIdRef = useRef("");
  const lastSignaledCompletionKeyRef = useRef("");
  const lastTerminalRunOutcomeRef = useRef<"completed" | "failed" | null>(null);
  const disposedRef = useRef(false);

  const workspaceUnavailable = workspace.folder_state === "missing";
  const handleEnterWorkspace = useCallback(() => {
    onSelectWorkspace(workspaceId);
    onEnterWorkspace(workspaceId);
  }, [onEnterWorkspace, onSelectWorkspace, workspaceId]);
  const handleOpenExternalUrl = useCallback((url: string) => {
    void window.electronAPI.ui.openExternalUrl(url);
  }, []);
  const handleOpenArtifacts = useCallback(
    (outputs: WorkspaceOutputRecordPayload[]) => {
      if (outputs.length === 0) {
        return;
      }
      onSelectWorkspace(workspaceId);
      setArtifactBrowserFilter("all");
      setArtifactBrowserOutputs(outputs);
      setArtifactBrowserOpen(true);
    },
    [onSelectWorkspace, workspaceId],
  );
  const lastActivityAt = useMemo(
    () =>
      lastActivityFromSnapshot({
        fallbackActivityAt: workspaceFallbackActivityAt,
        messages,
      }),
    [messages, workspaceFallbackActivityAt],
  );

  // Bubble runtime state changes up so the parent can compute the
  // aggregate strip ("3 working · 1 needs attention …") without
  // re-fetching every workspace's runtime state itself.
  useEffect(() => {
    onRuntimeStateChange(workspaceId, runtimeCardState);
  }, [onRuntimeStateChange, runtimeCardState, workspaceId]);

  const closeActiveStream = useCallback(async (reason: string) => {
    const streamId = activeStreamIdRef.current;
    activeStreamIdRef.current = null;
    pendingInputIdRef.current = "";
    if (!streamId) {
      return;
    }
    await window.electronAPI.workspace
      .closeSessionOutputStream(streamId, reason)
      .catch(() => undefined);
  }, []);

  const clearScheduledTerminalRefreshes = useCallback(() => {
    for (const timerId of terminalRefreshTimerIdsRef.current) {
      window.clearTimeout(timerId);
    }
    terminalRefreshTimerIdsRef.current = [];
  }, []);

  const signalWorkspaceCompletion = useCallback(
    (completionKey?: string | null) => {
      const normalizedCompletionKey = (completionKey || "").trim();
      if (
        normalizedCompletionKey &&
        lastSignaledCompletionKeyRef.current === normalizedCompletionKey
      ) {
        return;
      }
      if (normalizedCompletionKey) {
        lastSignaledCompletionKeyRef.current = normalizedCompletionKey;
      }
      onWorkspaceCompletion(workspaceId);
    },
    [onWorkspaceCompletion, workspaceId],
  );

  const openLiveStream = useCallback(
    async (params: {
      sessionId: string;
      inputId?: string | null;
      includeHistory?: boolean;
    }) => {
      if (activeStreamIdRef.current) {
        await closeActiveStream("control_center_replace_stream");
      }
      const stream = await window.electronAPI.workspace.openSessionOutputStream(
        {
          sessionId: params.sessionId,
          workspaceId,
          inputId: params.inputId ?? undefined,
          includeHistory: params.includeHistory ?? Boolean(params.inputId),
          stopOnTerminal: true,
        },
      );
      if (disposedRef.current) {
        await window.electronAPI.workspace
          .closeSessionOutputStream(
            stream.streamId,
            "control_center_disposed_after_open",
          )
          .catch(() => undefined);
        return;
      }
      activeStreamIdRef.current = stream.streamId;
      pendingInputIdRef.current = (params.inputId || "").trim();
      lastTerminalRunOutcomeRef.current = null;
    },
    [closeActiveStream, workspaceId],
  );

  const refreshSnapshot = useCallback(
    async (options?: { attachStream?: boolean; showLoading?: boolean }) => {
      if (options?.showLoading) {
        setIsLoading(true);
      }
      const ensured = await window.electronAPI.workspace.ensureMainSession(
        workspaceId,
      );
      const session = ensured.session;
      const sessionId = session.session_id.trim();
      const [history, runtimeStates] = await Promise.all([
        window.electronAPI.workspace.getSessionHistory({
          workspaceId,
          sessionId,
          limit: PREVIEW_HISTORY_LIMIT,
          offset: 0,
          order: "desc",
        }),
        window.electronAPI.workspace.listRuntimeStates(workspaceId),
      ]);
      if (disposedRef.current) {
        return;
      }

      const historyMessages = historyMessagesInDisplayOrder(
        history.messages,
        "desc",
      );
      const previewInputIds = turnInputIdsFromHistoryMessages(historyMessages);
      const previewArtifacts =
        previewInputIds.length > 0
          ? await Promise.all(
              previewInputIds.map(async (inputId) => {
                const [
                  outputEventsResult,
                  outputListResult,
                  memoryProposalListResult,
                ] = await Promise.allSettled([
                  window.electronAPI.workspace.getSessionOutputEvents({
                    workspaceId,
                    sessionId,
                    inputId,
                  }),
                  window.electronAPI.workspace.listOutputs({
                    workspaceId,
                    sessionId,
                    inputId,
                    limit: PREVIEW_OUTPUT_LIMIT,
                  }),
                  window.electronAPI.workspace.listMemoryUpdateProposals({
                    workspaceId,
                    sessionId,
                    inputId,
                    limit: PREVIEW_OUTPUT_LIMIT,
                  }),
                ]);
                return {
                  outputEvents:
                    outputEventsResult.status === "fulfilled"
                      ? outputEventsResult.value.items
                      : [],
                  outputs:
                    outputListResult.status === "fulfilled"
                      ? outputListResult.value.items
                      : [],
                  memoryProposals:
                    memoryProposalListResult.status === "fulfilled"
                      ? memoryProposalListResult.value.proposals
                      : [],
                };
              }),
            )
          : [];
      if (disposedRef.current) {
        return;
      }
      const nextMessages = trimPreviewMessages(
        chatMessagesFromSessionState({
          historyMessages,
          outputEvents: previewArtifacts.flatMap((entry) => entry.outputEvents),
          outputs: previewArtifacts.flatMap((entry) => entry.outputs),
          memoryProposals: previewArtifacts.flatMap(
            (entry) => entry.memoryProposals,
          ),
          showExecutionInternals: false,
        }) as PreviewChatMessage[],
      );
      const nextRuntimeState =
        runtimeStates.items.find((item) => item.session_id === sessionId) ??
        null;
      const nextRuntimeCardState = previewStatusFromRuntimeState(nextRuntimeState);
      const currentRuntimeInputId = (
        nextRuntimeState?.current_input_id || ""
      ).trim();
      const shouldAttachLiveRunStream =
        options?.attachStream !== false &&
        (nextRuntimeCardState === "queued" || nextRuntimeCardState === "working");
      const renderedMessagesForDisplay =
        shouldAttachLiveRunStream && currentRuntimeInputId
          ? nextMessages.filter(
              (message) =>
                message.role !== "assistant" ||
                inputIdFromMessageId(message.id, "assistant") !==
                  currentRuntimeInputId,
            )
          : nextMessages;
      const pendingCommittedAssistantMessage =
        pendingCommittedAssistantMessageRef.current;
      const nextRenderedMessages =
        pendingCommittedAssistantMessage &&
        !renderedMessagesForDisplay.some(
          (message) => message.id === pendingCommittedAssistantMessage.id,
        )
          ? trimPreviewMessages([
              ...renderedMessagesForDisplay,
              pendingCommittedAssistantMessage,
            ])
          : renderedMessagesForDisplay;
      if (
        pendingCommittedAssistantMessage &&
        renderedMessagesForDisplay.some(
          (message) => message.id === pendingCommittedAssistantMessage.id,
        )
      ) {
        pendingCommittedAssistantMessageRef.current = null;
      }

      const latestAssistantMessageId =
        [...nextRenderedMessages]
          .reverse()
          .find((message) => message.role === "assistant")
          ?.id?.trim() || "";
      const shouldSignalSnapshotCompletion =
        hasHydratedSnapshotRef.current &&
        !shouldAttachLiveRunStream &&
        Boolean(latestAssistantMessageId) &&
        latestAssistantMessageId !== latestAssistantMessageIdRef.current;
      latestAssistantMessageIdRef.current = latestAssistantMessageId;
      hasHydratedSnapshotRef.current = true;

      setMainSession(session);
      setMessages(nextRenderedMessages);
      setRuntimeState(nextRuntimeState);
      setRuntimeCardState(nextRuntimeCardState);
      setIsResponding(
        nextRuntimeCardState === "queued" || nextRuntimeCardState === "working",
      );
      setLiveAssistantText("");
      setLiveAgentStatus(
        nextRuntimeCardState === "queued"
          ? "Queued"
          : nextRuntimeCardState === "working"
            ? "Working"
            : "",
      );
      setErrorMessage("");

      if (shouldAttachLiveRunStream) {
        await openLiveStream({
          sessionId,
          inputId: currentRuntimeInputId || undefined,
          includeHistory: Boolean(currentRuntimeInputId),
        }).catch((error) => {
          if (disposedRef.current) {
            return;
          }
          setErrorMessage(
            error instanceof Error ? error.message : "Could not attach stream.",
          );
        });
      } else if (activeStreamIdRef.current) {
        await closeActiveStream("control_center_snapshot_idle");
      }

      if (shouldSignalSnapshotCompletion) {
        signalWorkspaceCompletion(latestAssistantMessageId);
      }

      setIsLoading(false);
    },
    [closeActiveStream, openLiveStream, signalWorkspaceCompletion, workspaceId],
  );

  const scheduleTerminalRefresh = useCallback(() => {
    clearScheduledTerminalRefreshes();
    for (const delayMs of CONTROL_CENTER_TERMINAL_REFRESH_DELAYS_MS) {
      const timerId = window.setTimeout(() => {
        terminalRefreshTimerIdsRef.current =
          terminalRefreshTimerIdsRef.current.filter((id) => id !== timerId);
        if (disposedRef.current) {
          return;
        }
        void refreshSnapshot({ attachStream: false }).catch(() => undefined);
      }, delayMs);
      terminalRefreshTimerIdsRef.current.push(timerId);
    }
  }, [clearScheduledTerminalRefreshes, refreshSnapshot]);

  useEffect(() => {
    disposedRef.current = false;
    void refreshSnapshot({ attachStream: true, showLoading: true }).catch(
      (error) => {
        if (disposedRef.current) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Could not load workspace preview.",
        );
        setIsLoading(false);
      },
    );

    return () => {
      disposedRef.current = true;
      clearScheduledTerminalRefreshes();
      void closeActiveStream("control_center_card_unmounted");
    };
  }, [clearScheduledTerminalRefreshes, closeActiveStream, refreshSnapshot]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    liveAssistantTextRef.current = liveAssistantText;
  }, [liveAssistantText]);

  const commitLiveAssistantPreviewMessage = useCallback(
    (inputId?: string | null) => {
      const text = liveAssistantTextRef.current;
      if (!text.trim()) {
        return false;
      }
      const normalizedInputId = (inputId || pendingInputIdRef.current || "").trim();
      const nextMessage: PreviewChatMessage = {
        id: normalizedInputId
          ? `assistant-${normalizedInputId}`
          : `assistant-preview-${Date.now()}`,
        role: "assistant",
        text,
        tone: "default",
        createdAt: new Date().toISOString(),
      };
      pendingCommittedAssistantMessageRef.current = nextMessage;
      setMessages((current) => {
        if (current.some((message) => message.id === nextMessage.id)) {
          return current;
        }
        return trimPreviewMessages([...current, nextMessage]);
      });
      setLiveAssistantText("");
      setLiveAgentStatus("");
      return true;
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI.workspace.onSessionStreamEvent(
      (payload) => {
        const currentStreamId = activeStreamIdRef.current;
        if (!currentStreamId || payload.streamId !== currentStreamId) {
          return;
        }

        if (payload.type === "error") {
          lastTerminalRunOutcomeRef.current = "failed";
          setErrorMessage(payload.error || "The workspace stream failed.");
          setIsResponding(false);
          setRuntimeCardState("error");
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = "";
          return;
        }

        if (payload.type === "done") {
          const finishedInputId = pendingInputIdRef.current;
          const lastTerminalRunOutcome = lastTerminalRunOutcomeRef.current;
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = "";
          const committed = commitLiveAssistantPreviewMessage(finishedInputId);
          if (
            committed ||
            (lastTerminalRunOutcome !== "failed" && Boolean(finishedInputId))
          ) {
            signalWorkspaceCompletion(
              finishedInputId ? `assistant-${finishedInputId}` : null,
            );
          }
          lastTerminalRunOutcomeRef.current = null;
          setIsResponding(false);
          void refreshSnapshot({ attachStream: false }).catch(() => undefined);
          scheduleTerminalRefresh();
          return;
        }

        const eventData = payload.event?.data;
        if (!eventData || typeof eventData !== "object" || Array.isArray(eventData)) {
          return;
        }

        const typedEvent = eventData as {
          event_type?: string;
          input_id?: string;
          payload?: Record<string, unknown>;
        };
        const eventType = (typedEvent.event_type || payload.event?.event || "")
          .trim()
          .toLowerCase();
        const inputId = (typedEvent.input_id || "").trim();
        const eventPayload = typedEvent.payload ?? {};

        if (
          eventType === "run_claimed" ||
          eventType === "run_started" ||
          eventType === "compaction_restored"
        ) {
          clearScheduledTerminalRefreshes();
          setIsResponding(true);
          setRuntimeCardState("working");
          setLiveAssistantText("");
          setLiveAgentStatus("Checking workspace context");
          return;
        }

        if (eventType === "output_delta") {
          const delta =
            typeof eventPayload.delta === "string" ? eventPayload.delta : "";
          if (!delta) {
            return;
          }
          setIsResponding(true);
          setRuntimeCardState("working");
          setLiveAgentStatus("");
          setErrorMessage("");
          setLiveAssistantText((current) => `${current}${delta}`);
          return;
        }

        if (eventType === "run_failed") {
          lastTerminalRunOutcomeRef.current = "failed";
          const failedInputId = inputId || pendingInputIdRef.current;
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = "";
          commitLiveAssistantPreviewMessage(failedInputId);
          setIsResponding(false);
          setRuntimeCardState("error");
          setLiveAgentStatus("");
          setErrorMessage(runFailedDetail(eventPayload));
          void refreshSnapshot({ attachStream: false }).catch(() => undefined);
          scheduleTerminalRefresh();
          return;
        }

        if (eventType === "run_completed") {
          lastTerminalRunOutcomeRef.current = "completed";
          const completedInputId = inputId || pendingInputIdRef.current;
          activeStreamIdRef.current = null;
          pendingInputIdRef.current = "";
          const committed = commitLiveAssistantPreviewMessage(completedInputId);
          if (committed || Boolean(completedInputId)) {
            signalWorkspaceCompletion(
              completedInputId ? `assistant-${completedInputId}` : null,
            );
          }
          setIsResponding(false);
          setRuntimeCardState("idle");
          setLiveAgentStatus("");
          void refreshSnapshot({ attachStream: false }).catch(() => undefined);
          scheduleTerminalRefresh();
        }
      },
    );

    return () => {
      unsubscribe();
    };
  }, [
    clearScheduledTerminalRefreshes,
    commitLiveAssistantPreviewMessage,
    refreshSnapshot,
    scheduleTerminalRefresh,
    signalWorkspaceCompletion,
  ]);

  useEffect(() => {
    if (!isResponding || !mainSession?.session_id) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const pollRuntimeState = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response =
          await window.electronAPI.workspace.listRuntimeStates(workspaceId);
        if (cancelled || disposedRef.current) {
          return;
        }
        const nextRuntimeState =
          response.items.find(
            (item) => item.session_id === mainSession.session_id,
          ) ?? null;
        setRuntimeState(nextRuntimeState);
        const nextRuntimeCardState =
          previewStatusFromRuntimeState(nextRuntimeState);
        setRuntimeCardState(nextRuntimeCardState);
        if (
          nextRuntimeCardState === "queued" ||
          nextRuntimeCardState === "working"
        ) {
          return;
        }
        if (activeStreamIdRef.current) {
          await closeActiveStream("control_center_runtime_terminal");
        }
        const completedInputId = (nextRuntimeState?.current_input_id || "").trim();
        const committed = commitLiveAssistantPreviewMessage(completedInputId);
        const lastTurnCompletedAt = (
          nextRuntimeState?.last_turn_completed_at || ""
        ).trim();
        if (committed || Boolean(lastTurnCompletedAt)) {
          signalWorkspaceCompletion(
            completedInputId
              ? `assistant-${completedInputId}`
              : lastTurnCompletedAt || null,
          );
        }
        setIsResponding(false);
        setLiveAgentStatus("");
        void refreshSnapshot({ attachStream: false }).catch(() => undefined);
        scheduleTerminalRefresh();
      } catch {
        // Ignore poll failures; the stream remains the primary signal.
      } finally {
        inFlight = false;
      }
    };

    void pollRuntimeState();
    const timer = window.setInterval(() => {
      void pollRuntimeState();
    }, CONTROL_CENTER_RUNTIME_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    closeActiveStream,
    commitLiveAssistantPreviewMessage,
    isResponding,
    mainSession,
    refreshSnapshot,
    scheduleTerminalRefresh,
    signalWorkspaceCompletion,
    workspaceId,
  ]);

  useEffect(() => {
    const sessionId = (mainSession?.session_id || "").trim();
    if (!sessionId || isLoading || isResponding || workspaceUnavailable) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const reconcileIdleMainSessionActivity = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") {
        return;
      }

      inFlight = true;
      try {
        const runtimeStates =
          await window.electronAPI.workspace.listRuntimeStates(workspaceId);
        if (cancelled || disposedRef.current) {
          return;
        }

        const currentRuntimeState =
          runtimeStates.items.find((item) => item.session_id === sessionId) ?? null;
        const currentRuntimeStatus =
          runtimeStateEffectiveStatus(currentRuntimeState);
        const currentRuntimeInputId = (
          currentRuntimeState?.current_input_id || ""
        ).trim();
        const shouldAttachAutonomousRun =
          !activeStreamIdRef.current &&
          !pendingInputIdRef.current &&
          Boolean(currentRuntimeInputId) &&
          ["BUSY", "QUEUED"].includes(currentRuntimeStatus);
        if (shouldAttachAutonomousRun) {
          await refreshSnapshot({ attachStream: true });
          return;
        }

        const latestHistory = await window.electronAPI.workspace.getSessionHistory({
          workspaceId,
          sessionId,
          limit: 1,
          offset: 0,
          order: "desc",
        });
        if (cancelled || disposedRef.current) {
          return;
        }

        const latestHistoryMessageId =
          historyMessagesInDisplayOrder(latestHistory.messages, "desc")[0]
            ?.id?.trim() || "";
        const latestDisplayedMessageId = latestPreviewMessageId(messagesRef.current);
        if (
          !latestHistoryMessageId ||
          latestHistoryMessageId === latestDisplayedMessageId
        ) {
          return;
        }

        await refreshSnapshot({ attachStream: false });
      } catch {
        // Ignore passive refresh failures; focus/visibility and subsequent polls will retry.
      } finally {
        inFlight = false;
      }
    };

    void reconcileIdleMainSessionActivity();
    const intervalId = window.setInterval(() => {
      void reconcileIdleMainSessionActivity();
    }, CONTROL_CENTER_IDLE_RECONCILE_INTERVAL_MS);
    const refreshVisibleMainSession = () => {
      void reconcileIdleMainSessionActivity();
    };
    window.addEventListener("focus", refreshVisibleMainSession);
    document.addEventListener("visibilitychange", refreshVisibleMainSession);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleMainSession);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleMainSession,
      );
    };
  }, [
    isLoading,
    isResponding,
    mainSession?.session_id,
    refreshSnapshot,
    workspaceId,
    workspaceUnavailable,
  ]);

  useEffect(() => {
    const scroller = previewScrollerRef.current;
    if (!scroller || !shouldStickToBottomRef.current) {
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }, [liveAssistantText, messages]);

  const handlePreviewScroll = () => {
    const scroller = previewScrollerRef.current;
    if (!scroller) {
      return;
    }
    shouldStickToBottomRef.current = isNearBottom(scroller);
  };

  const liveAssistantTurn =
    isResponding || Boolean(liveAssistantText.trim())
      ? {
          text: liveAssistantText,
          tone: "default" as const,
          segments: [],
          executionItems: [],
          status: liveAgentStatus || (isResponding ? "Working" : ""),
        }
      : null;
  const showPreviewConversation =
    messages.length > 0 || Boolean(liveAssistantTurn);

  const userMessageCount = useMemo(
    () => messages.filter((message) => message.role === "user").length,
    [messages],
  );
  const recentEventDensity = useMemo(
    () => buildRecentEventDensity(messages, 8),
    [messages],
  );

  return (
    <Card
      size="sm"
      onPointerDownCapture={() => onSelectWorkspace(workspaceId)}
      onFocusCapture={() => onSelectWorkspace(workspaceId)}
      onDragEnter={() => onDragEnterWorkspace(workspaceId)}
      onDragOver={onDragOverWorkspace}
      onDrop={(event) => onDropWorkspace(event, workspaceId)}
      className={cn(
        "relative h-full min-h-0 min-w-0 gap-0 overflow-hidden bg-card py-0 transition-colors",
        isDragging && "cursor-grabbing opacity-70",
        isDragTarget && "ring-2 ring-primary ring-inset",
        // Selected tile gets a primary ring (binds visually to the
        // floating composer at the bottom). Unread-completion highlight
        // only applies when the tile is *not* selected, so the two
        // signals don't fight.
        isSelected
          ? "ring-1 ring-primary/50 ring-inset"
          : hasUnreadCompletionHighlight
            ? "ring-1 ring-primary/40 ring-inset"
            : "ring-1 ring-border ring-inset",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 h-[2px] transition-colors",
          statusStripeClassName(runtimeCardState),
          runtimeCardState === "working" && "hb-tile-stripe-working",
        )}
      />
      <CardHeader className="gap-0 border-b border-border px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            draggable
            aria-label={`Reorder ${workspace.name}`}
            onDragStart={(event) => onDragStartWorkspace(event, workspaceId)}
            onDragEnd={onDragEndWorkspace}
            className="h-5 w-5 shrink-0 cursor-grab rounded text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </Button>
          <WorkspaceIcon workspace={workspace} size="sm" />
          <CardTitle className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {workspace.name}
          </CardTitle>
          <Badge
            variant={previewStatusVariant(runtimeCardState)}
            className="h-4 shrink-0 gap-1 rounded-full px-1.5 text-[10px] font-medium uppercase tracking-wide"
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-1.5 w-1.5 rounded-full",
                statusAccentClassName(runtimeCardState),
              )}
            />
            {previewStatusLabel(runtimeCardState)}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Enter ${workspace.name}`}
            onClick={handleEnterWorkspace}
            className="h-5 w-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
        {workspace.folder_state === "missing" ? (
          <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-warning">
            <TriangleAlert className="size-3" />
            Folder missing
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="relative flex min-h-0 flex-1 flex-col gap-0 px-0 pb-0 pt-0">
        <div
          ref={previewScrollerRef}
          onScroll={handlePreviewScroll}
          className="relative min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5"
          style={{
            maskImage:
              "linear-gradient(to bottom, transparent 0, black 12px, black calc(100% - 16px), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0, black 12px, black calc(100% - 16px), transparent 100%)",
          }}
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 className="mr-1.5 size-3 animate-spin" />
              Loading
            </div>
          ) : showPreviewConversation ? (
            <div className="space-y-1.5 text-[12px]">
              <ConversationTurns
                messages={messages}
                assistantLabel={workspace.name}
                assistantMode="control_center_preview"
                showExecutionInternals={false}
                assistantFitToContent
                workspaceId={workspaceId}
                onOpenOutput={(output) => onOpenOutput(workspaceId, output)}
                onOpenAllArtifacts={handleOpenArtifacts}
                collapsedTraceByStepId={{}}
                onToggleTraceStep={(_stepId) => undefined}
                onLinkClick={handleOpenExternalUrl}
                memoryProposalAction={null}
                editingMemoryProposalId={null}
                memoryProposalDrafts={{}}
                onEditMemoryProposal={(_message, _proposalId) => undefined}
                onMemoryProposalDraftChange={(_proposalId, _value) =>
                  undefined
                }
                onAcceptMemoryProposal={(_proposal) => undefined}
                onDismissMemoryProposal={(_proposal) => undefined}
                getMessageWrapperClassName={(message) =>
                  cn(message.optimistic ? "opacity-80" : "")
                }
                liveAssistantTurn={liveAssistantTurn}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div
                aria-hidden="true"
                className="relative grid size-12 place-items-center text-muted-foreground/50"
              >
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle, var(--color-fg-12) 1px, transparent 1px)",
                    backgroundSize: "6px 6px",
                    maskImage:
                      "radial-gradient(circle at center, transparent 0, transparent 35%, black 100%)",
                    WebkitMaskImage:
                      "radial-gradient(circle at center, transparent 0, transparent 35%, black 100%)",
                  }}
                />
                <WorkspaceIcon workspace={workspace} size="md" />
              </div>
            </div>
          )}
        </div>

        {errorMessage ? (
          <div className="mx-2.5 mb-1.5 line-clamp-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-fg-2 px-2.5 py-1 text-[10px] tabular-nums text-muted-foreground">
          <span className="truncate">
            {userMessageCount > 0
              ? `${userMessageCount} ${userMessageCount === 1 ? "msg" : "msgs"}`
              : "no msgs"}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            {formatLastActivityLabel(lastActivityAt)}
          </span>
          <span
            aria-hidden="true"
            className="flex shrink-0 items-end gap-[2px]"
            title="Recent activity"
          >
            {recentEventDensity.map((intensity, index) => {
              const lit = [
                intensity >= 0.05,
                intensity >= 0.4,
                intensity >= 0.75,
              ];
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional column
                  key={index}
                  className="flex flex-col-reverse gap-[1.5px]"
                >
                  {lit.map((isLit, dotIndex) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional dot
                      key={dotIndex}
                      className={cn(
                        "block size-[2px] rounded-full",
                        isLit ? "bg-foreground/55" : "bg-foreground/10",
                      )}
                    />
                  ))}
                </span>
              );
            })}
          </span>
        </div>
      </CardContent>
      <ArtifactBrowserModal
        open={artifactBrowserOpen}
        filter={artifactBrowserFilter}
        outputs={artifactBrowserOutputs}
        scope="reply"
        layout="card"
        onClose={() => setArtifactBrowserOpen(false)}
        onFilterChange={setArtifactBrowserFilter}
        onOpenOutput={(output) => onOpenOutput(workspaceId, output)}
      />
    </Card>
  );
});

interface WorkspaceCommandBarProps {
  selectedWorkspace: WorkspaceRecordPayload | null;
  composerModel: string | null;
  onSubmitted: (workspaceId: string) => void;
  onDismiss: () => void;
}

function WorkspaceCommandBar({
  selectedWorkspace,
  composerModel,
  onSubmitted,
  onDismiss,
}: WorkspaceCommandBarProps) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Clear errors when the user switches to a different workspace —
  // the previous error was about the previous target.
  useEffect(() => {
    setErrorMessage("");
  }, [selectedWorkspace?.id]);

  // Auto-focus when the floating composer mounts or the target
  // workspace changes — clicking a tile shouldn't require a second
  // click into the textarea.
  useEffect(() => {
    if (!selectedWorkspace) return;
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [selectedWorkspace?.id, selectedWorkspace]);

  const workspaceId = selectedWorkspace?.id ?? null;
  const workspaceUnavailable =
    selectedWorkspace?.folder_state === "missing";
  const disabled =
    !workspaceId || workspaceUnavailable || isSubmitting;

  const handleSubmit = async () => {
    if (!workspaceId || workspaceUnavailable || isSubmitting) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const ensured =
        await window.electronAPI.workspace.ensureMainSession(workspaceId);
      const queued = await window.electronAPI.workspace.queueSessionInput({
        text: trimmed,
        workspace_id: workspaceId,
        image_urls: null,
        attachments: null,
        session_id: ensured.session.session_id,
        priority: 0,
        model: composerModel,
      });
      void queued;
      setText("");
      onSubmitted(workspaceId);
      // Re-focus so the user can immediately fire another command at
      // the same workspace without re-clicking the input.
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not send message.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void handleSubmit();
  };

  const placeholder = !workspaceId
    ? "Select a workspace card above to message it…"
    : workspaceUnavailable
      ? "Workspace folder is missing."
      : `Message ${selectedWorkspace?.name ?? "workspace"}…`;

  return (
    <div
      role="dialog"
      aria-label={
        selectedWorkspace
          ? `Send a message to ${selectedWorkspace.name}`
          : "Send a message"
      }
      className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4"
    >
      <div className="pointer-events-auto w-full max-w-3xl animate-in fade-in-0 slide-in-from-bottom-4 rounded-xl border border-border bg-card shadow-lg duration-200 ease-out">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted-foreground">
            <span>Sending to</span>
            {selectedWorkspace ? (
              <>
                <WorkspaceIcon workspace={selectedWorkspace} size="sm" />
                <span className="truncate font-medium text-foreground">
                  {selectedWorkspace.name}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
            <kbd className="rounded border border-border bg-fg-2 px-1.5 py-[1px] font-mono text-[10px] tabular-nums">
              esc
            </kbd>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Dismiss command bar"
              onClick={onDismiss}
              className="h-5 w-5 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </Button>
          </div>
        </div>
        {errorMessage ? (
          <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}
        <div className="flex items-end gap-2 p-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={placeholder}
            className="min-h-[40px] max-h-[160px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={disabled || !text.trim()}
            className="h-10 shrink-0 rounded-md px-3"
          >
            {isSubmitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <SendHorizontal className="size-3.5" />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function statusToneColor(state: RuntimeCardState | "total") {
  switch (state) {
    case "error":
      return "bg-destructive";
    case "queued":
    case "waiting":
      return "bg-warning";
    case "working":
      return "bg-primary";
    case "idle":
      return "bg-success";
    default:
      return "bg-muted-foreground";
  }
}

interface AggregateCounts {
  total: number;
  working: number;
  queued: number;
  waiting: number;
  idle: number;
  error: number;
}

function AggregateStrip({ counts }: { counts: AggregateCounts }) {
  const segments: Array<{
    state: RuntimeCardState | "total";
    count: number;
    label: string;
  }> = [
    { state: "total", count: counts.total, label: "workspaces" },
    { state: "working", count: counts.working, label: "working" },
    { state: "queued", count: counts.queued, label: "queued" },
    { state: "waiting", count: counts.waiting, label: "waiting" },
    { state: "error", count: counts.error, label: "needs attention" },
  ];
  const visible = segments.filter(
    (segment) => segment.state === "total" || segment.count > 0,
  );

  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {visible.map((segment, index) => (
          <span
            key={segment.state}
            className="inline-flex items-center gap-1.5"
          >
            {index > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            ) : null}
            {segment.state !== "total" ? (
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex h-1.5 w-1.5 rounded-full",
                  statusToneColor(segment.state),
                )}
              />
            ) : null}
            <span className="tabular-nums text-foreground">{segment.count}</span>
            <span>{segment.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceControlCenter({
  workspaces,
  selectedWorkspaceId,
  cardsPerRow,
  composerModel,
  orderedWorkspaceIds,
  highlightedWorkspaceIds,
  onSelectWorkspace,
  onEnterWorkspace,
  onOpenOutput,
  onWorkspaceOrderChange,
  onVisibleWorkspaceIdsChange,
  onCardComposerSubmit,
  onWorkspaceCompletion,
}: WorkspaceControlCenterProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cardNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleIdsRef = useRef<Set<string>>(new Set());
  const previousHighlightIdsRef = useRef<Set<string>>(new Set());
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState("");
  const [dragTargetWorkspaceId, setDragTargetWorkspaceId] = useState("");
  const [runtimeStateByWorkspaceId, setRuntimeStateByWorkspaceId] = useState<
    Record<string, RuntimeCardState>
  >({});
  // Composer visibility is intent-driven: clicking any tile opens it
  // (even re-clicking the already-selected tile re-opens after a
  // dismissal); Esc / ✕ / click-on-the-gallery-gutter closes it.
  // Track this locally so dismissal doesn't have to clear the parent's
  // selectedWorkspaceId — selection itself is independent.
  const [composerOpen, setComposerOpen] = useState(false);

  const handleSelectWorkspaceWithComposer = useCallback(
    (workspaceId: string) => {
      setComposerOpen(true);
      onSelectWorkspace(workspaceId);
    },
    [onSelectWorkspace],
  );

  const handleDismissComposer = useCallback(() => {
    setComposerOpen(false);
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setComposerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composerOpen]);

  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((left, right) => {
      const activityComparison = compareTimestampsDescending(
        fallbackWorkspaceActivityAt(left),
        fallbackWorkspaceActivityAt(right),
      );
      if (activityComparison !== 0) {
        return activityComparison;
      }
      return left.name.localeCompare(right.name);
    });
  }, [workspaces]);
  const orderedWorkspaces = useMemo(
    () => mergeWorkspaceOrder(sortedWorkspaces, orderedWorkspaceIds),
    [orderedWorkspaceIds, sortedWorkspaces],
  );

  const selectedWorkspace = useMemo(() => {
    const id = (selectedWorkspaceId || "").trim();
    if (!id) {
      return null;
    }
    return (
      orderedWorkspaces.find((workspace) => workspace.id.trim() === id) ?? null
    );
  }, [orderedWorkspaces, selectedWorkspaceId]);

  const aggregateCounts = useMemo<AggregateCounts>(() => {
    const counts: AggregateCounts = {
      total: orderedWorkspaces.length,
      working: 0,
      queued: 0,
      waiting: 0,
      idle: 0,
      error: 0,
    };
    for (const workspace of orderedWorkspaces) {
      const id = workspace.id.trim();
      const state: RuntimeCardState =
        runtimeStateByWorkspaceId[id] ?? "idle";
      counts[state] += 1;
    }
    return counts;
  }, [orderedWorkspaces, runtimeStateByWorkspaceId]);

  const handleRuntimeStateChange = useCallback(
    (workspaceId: string, state: RuntimeCardState) => {
      setRuntimeStateByWorkspaceId((current) => {
        const id = workspaceId.trim();
        if (!id) {
          return current;
        }
        if (current[id] === state) {
          return current;
        }
        return { ...current, [id]: state };
      });
    },
    [],
  );

  const highlightedWorkspaceIdSet = useMemo(
    () =>
      new Set(
        highlightedWorkspaceIds
          .map((workspaceId) => workspaceId.trim())
          .filter(Boolean),
      ),
    [highlightedWorkspaceIds],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.workspaceId;
          if (!id) {
            continue;
          }
          const wasVisible = visibleIdsRef.current.has(id);
          if (entry.isIntersecting && !wasVisible) {
            visibleIdsRef.current.add(id);
            changed = true;
          } else if (!entry.isIntersecting && wasVisible) {
            visibleIdsRef.current.delete(id);
            changed = true;
          }
        }
        if (changed) {
          onVisibleWorkspaceIdsChange(Array.from(visibleIdsRef.current));
        }
      },
      { root: viewport, threshold: CARD_VISIBILITY_THRESHOLD },
    );
    observerRef.current = observer;
    for (const node of cardNodesRef.current.values()) {
      observer.observe(node);
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [onVisibleWorkspaceIdsChange]);

  useEffect(() => {
    return () => {
      visibleIdsRef.current.clear();
      onVisibleWorkspaceIdsChange([]);
    };
  }, [onVisibleWorkspaceIdsChange]);

  useEffect(() => {
    const previous = previousHighlightIdsRef.current;
    const newlyHighlighted: string[] = [];
    for (const id of highlightedWorkspaceIdSet) {
      if (!previous.has(id)) {
        newlyHighlighted.push(id);
      }
    }
    previousHighlightIdsRef.current = new Set(highlightedWorkspaceIdSet);
    if (newlyHighlighted.length === 0) {
      return;
    }
    const targetId = newlyHighlighted[newlyHighlighted.length - 1];
    if (!targetId) {
      return;
    }
    const node = cardNodesRef.current.get(targetId);
    if (node) {
      node.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [highlightedWorkspaceIdSet]);

  const attachCardNode = useCallback(
    (workspaceId: string, node: HTMLDivElement | null) => {
      const id = workspaceId.trim();
      if (!id) {
        return;
      }
      const previous = cardNodesRef.current.get(id);
      if (previous && previous !== node) {
        observerRef.current?.unobserve(previous);
      }
      if (node) {
        cardNodesRef.current.set(id, node);
        observerRef.current?.observe(node);
      } else {
        cardNodesRef.current.delete(id);
      }
    },
    [],
  );

  const handleDragStartWorkspace = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>, workspaceId: string) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", normalizedWorkspaceId);
      setDraggedWorkspaceId(normalizedWorkspaceId);
      setDragTargetWorkspaceId("");
    },
    [],
  );

  const handleDragEnterWorkspace = useCallback((workspaceId: string) => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!draggedWorkspaceId || !normalizedWorkspaceId) {
      return;
    }
    setDragTargetWorkspaceId(normalizedWorkspaceId);
  }, [draggedWorkspaceId]);

  const handleDragOverWorkspace = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!draggedWorkspaceId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [draggedWorkspaceId],
  );

  const handleDragEndWorkspace = useCallback(() => {
    setDraggedWorkspaceId("");
    setDragTargetWorkspaceId("");
  }, []);

  const handleDropWorkspace = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetWorkspaceId: string) => {
      if (!draggedWorkspaceId) {
        return;
      }
      event.preventDefault();
      const normalizedTargetWorkspaceId = targetWorkspaceId.trim();
      if (
        !normalizedTargetWorkspaceId ||
        normalizedTargetWorkspaceId === draggedWorkspaceId
      ) {
        setDraggedWorkspaceId("");
        setDragTargetWorkspaceId("");
        return;
      }
      const nextOrderedWorkspaceIds = orderedWorkspaces.map((workspace) =>
        workspace.id.trim(),
      );
      const fromIndex = nextOrderedWorkspaceIds.indexOf(draggedWorkspaceId);
      const targetIndex = nextOrderedWorkspaceIds.indexOf(normalizedTargetWorkspaceId);
      if (fromIndex < 0 || targetIndex < 0) {
        setDraggedWorkspaceId("");
        setDragTargetWorkspaceId("");
        return;
      }
      const [draggedId] = nextOrderedWorkspaceIds.splice(fromIndex, 1);
      nextOrderedWorkspaceIds.splice(targetIndex, 0, draggedId);
      onWorkspaceOrderChange(nextOrderedWorkspaceIds);
      setDraggedWorkspaceId("");
      setDragTargetWorkspaceId("");
    },
    [draggedWorkspaceId, onWorkspaceOrderChange, orderedWorkspaces],
  );

  // Honor `cardsPerRow` when explicitly set (>0); otherwise fall back
  // to a responsive auto-fill grid based on a target tile width. The
  // gallery view stays dense at narrow widths and breathes at wide
  // ones without forcing a fixed column count.
  const gridStyle =
    cardsPerRow > 0
      ? { gridTemplateColumns: `repeat(${cardsPerRow}, minmax(0, 1fr))` }
      : {
          gridTemplateColumns: `repeat(auto-fill, minmax(${WORKSPACE_CARD_MIN_WIDTH}px, 1fr))`,
        };

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <AggregateStrip counts={aggregateCounts} />
      <div
        ref={viewportRef}
        onClick={(event) => {
          // Click on the gallery gutter (not on a tile) dismisses the
          // floating composer. Tile clicks bubble up but with a child
          // as event.target, so the strict identity check filters them
          // out.
          if (event.target === event.currentTarget) {
            handleDismissComposer();
          }
        }}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
      >
        <div
          className="grid auto-rows-[300px] gap-2.5"
          style={gridStyle}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              handleDismissComposer();
            }
          }}
        >
          {orderedWorkspaces.map((workspace) => {
            const id = workspace.id.trim();
            return (
              <div
                key={workspace.id}
                ref={(node) => attachCardNode(id, node)}
                data-workspace-id={id}
                className="group/control-tile min-h-0 min-w-0"
              >
                <WorkspaceControlCenterCard
                  workspace={workspace}
                  isSelected={id === (selectedWorkspaceId || "").trim()}
                  isDragging={draggedWorkspaceId === id}
                  isDragTarget={
                    Boolean(draggedWorkspaceId) &&
                    dragTargetWorkspaceId === id &&
                    draggedWorkspaceId !== id
                  }
                  hasUnreadCompletionHighlight={highlightedWorkspaceIdSet.has(id)}
                  onSelectWorkspace={handleSelectWorkspaceWithComposer}
                  onEnterWorkspace={onEnterWorkspace}
                  onOpenOutput={onOpenOutput}
                  onDragStartWorkspace={handleDragStartWorkspace}
                  onDragEnterWorkspace={handleDragEnterWorkspace}
                  onDragOverWorkspace={handleDragOverWorkspace}
                  onDropWorkspace={handleDropWorkspace}
                  onDragEndWorkspace={handleDragEndWorkspace}
                  onWorkspaceCompletion={onWorkspaceCompletion}
                  onRuntimeStateChange={handleRuntimeStateChange}
                />
              </div>
            );
          })}
        </div>
      </div>
      {composerOpen && selectedWorkspace ? (
        <WorkspaceCommandBar
          selectedWorkspace={selectedWorkspace}
          composerModel={composerModel}
          onSubmitted={onCardComposerSubmit}
          onDismiss={handleDismissComposer}
        />
      ) : null}
    </section>
  );
}
