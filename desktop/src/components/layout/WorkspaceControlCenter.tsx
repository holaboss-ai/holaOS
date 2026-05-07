import {
  ArrowUpRight,
  GripVertical,
  Loader2,
  SendHorizontal,
  TriangleAlert,
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
const WORKSPACE_CARD_MIN_WIDTH = 360;
const CONTROL_CENTER_TERMINAL_REFRESH_DELAYS_MS = [150, 500, 1_500, 3_000];
const CONTROL_CENTER_IDLE_RECONCILE_INTERVAL_MS = 2500;
const CONTROL_CENTER_RUNTIME_POLL_INTERVAL_MS = 750;
const CARD_VISIBILITY_THRESHOLD = 0.5;

type PreviewChatMessage = ChatMessage & {
  optimistic?: boolean;
};

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
  composerModel: string | null;
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
  onCardComposerSubmit: (workspaceId: string) => void;
  onWorkspaceCompletion: (workspaceId: string) => void;
}

type RuntimeCardState = "idle" | "queued" | "working" | "waiting" | "error";

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
  composerModel,
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
  onCardComposerSubmit,
  onWorkspaceCompletion,
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
  const [composerText, setComposerText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const handleSubmit = async () => {
    const text = composerText.trim();
    const sessionId = mainSession?.session_id?.trim() || "";
    if (!text || !sessionId || isSubmitting || isResponding || workspaceUnavailable) {
      return;
    }

    const optimisticInputId = `user-preview-${crypto.randomUUID()}`;
    shouldStickToBottomRef.current = true;
    setErrorMessage("");
    setIsSubmitting(true);
    setComposerText("");
    setLiveAssistantText("");
    setLiveAgentStatus("");
    clearScheduledTerminalRefreshes();
    onSelectWorkspace(workspaceId);
    setMessages((current) =>
      trimPreviewMessages([
        ...current,
        {
          id: optimisticInputId,
          role: "user",
          text,
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      ]),
    );

    try {
      const queued = await window.electronAPI.workspace.queueSessionInput({
        text,
        workspace_id: workspaceId,
        image_urls: null,
        attachments: null,
        session_id: sessionId,
        priority: 0,
        model: composerModel,
      });
      if (disposedRef.current) {
        return;
      }
      clearScheduledTerminalRefreshes();
      pendingInputIdRef.current = queued.input_id;
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticInputId
            ? {
                ...message,
                id: `user-${queued.input_id}`,
                optimistic: false,
              }
            : message,
        ),
      );
      setIsResponding(true);
      setLiveAssistantText("");
      setLiveAgentStatus(
        queued.status.trim().toUpperCase() === "QUEUED" ? "Queued" : "Working",
      );
      setRuntimeCardState(
        queued.status.trim().toUpperCase() === "QUEUED" ? "queued" : "working",
      );
      onCardComposerSubmit(workspaceId);
      await openLiveStream({
        sessionId: queued.session_id,
        inputId: queued.input_id,
        includeHistory: true,
      });
    } catch (error) {
      if (disposedRef.current) {
        return;
      }
      setComposerText(text);
      setMessages((current) =>
        current.filter((message) => message.id !== optimisticInputId),
      );
      setErrorMessage(
        error instanceof Error ? error.message : "Could not send message.",
      );
      setIsResponding(false);
    } finally {
      if (!disposedRef.current) {
        setIsSubmitting(false);
      }
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void handleSubmit();
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

  return (
    <Card
      size="sm"
      onPointerDownCapture={() => onSelectWorkspace(workspaceId)}
      onFocusCapture={() => onSelectWorkspace(workspaceId)}
      onDragEnter={() => onDragEnterWorkspace(workspaceId)}
      onDragOver={onDragOverWorkspace}
      onDrop={(event) => onDropWorkspace(event, workspaceId)}
      className={cn(
        "relative h-full min-h-0 min-w-0 gap-0 bg-card py-0 transition-colors",
        isDragging && "cursor-grabbing opacity-70",
        isDragTarget && "ring-2 ring-primary ring-inset",
        hasUnreadCompletionHighlight
          ? "ring-1 ring-primary/40 ring-inset"
          : isSelected && "ring-1 ring-border ring-inset",
      )}
    >
      <CardHeader className="gap-0 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              draggable
              aria-label={`Reorder ${workspace.name}`}
              onDragStart={(event) => onDragStartWorkspace(event, workspaceId)}
              onDragEnd={onDragEndWorkspace}
              className="h-6 w-6 shrink-0 cursor-grab rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" />
            </Button>
            <WorkspaceIcon workspace={workspace} size="md" />
            <span className="truncate">{workspace.name}</span>
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-2 w-2 shrink-0 rounded-full",
                statusAccentClassName(runtimeCardState),
              )}
            />
            {workspace.folder_state === "missing" ? (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <TriangleAlert className="size-3.5" />
                Missing folder
              </span>
            ) : null}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {formatLastActivityLabel(lastActivityAt)}
            </span>
            {runtimeCardState === "waiting" || runtimeCardState === "error" ? (
              <Badge
                variant={previewStatusVariant(runtimeCardState)}
                className="h-6 rounded-full px-2 text-xs"
              >
                {previewStatusLabel(runtimeCardState)}
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleEnterWorkspace}
              className="h-6 rounded-full px-2.5 text-xs hover:bg-accent"
            >
              Enter
              <ArrowUpRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 px-0 pb-0 pt-0">
        <div
          ref={previewScrollerRef}
          onScroll={handlePreviewScroll}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-3.5 animate-spin" />
              Loading main session
            </div>
          ) : showPreviewConversation ? (
            <div className="space-y-2.5">
              <ConversationTurns
                messages={messages}
                assistantLabel={workspace.name}
                assistantMode="control_center_preview"
                showExecutionInternals={false}
                assistantFitToContent
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
            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
              Start the main session from here. Replies will stay inside this
              card until you enter the workspace.
            </div>
          )}
        </div>

        {errorMessage ? (
          <div className="theme-chat-system-bubble mx-3 rounded-md border px-3 py-2 text-xs">
            {errorMessage}
          </div>
        ) : null}

        <div className="border-t border-border bg-fg-2 px-3 py-2">
          <div className="flex items-end gap-2">
            <textarea
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onFocus={() => onSelectWorkspace(workspaceId)}
              rows={1}
              disabled={isSubmitting || isResponding || workspaceUnavailable}
              placeholder={
                workspaceUnavailable
                  ? "Workspace folder is missing."
                  : isResponding
                    ? "Wait for the current run to finish."
                    : "Message this workspace directly..."
              }
              className="min-h-[36px] max-h-[84px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={
                !composerText.trim() ||
                isSubmitting ||
                isResponding ||
                workspaceUnavailable
              }
              className="h-9 shrink-0 rounded-md px-3"
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
  void cardsPerRow;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cardNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleIdsRef = useRef<Set<string>>(new Set());
  const previousHighlightIdsRef = useRef<Set<string>>(new Set());
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState("");
  const [dragTargetWorkspaceId, setDragTargetWorkspaceId] = useState("");

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

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div
        ref={viewportRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-4 py-3"
      >
        <div
          className="flex h-full gap-3"
          style={{ minWidth: "min-content" }}
        >
          {orderedWorkspaces.map((workspace) => {
            const id = workspace.id.trim();
            return (
              <div
                key={workspace.id}
                ref={(node) => attachCardNode(id, node)}
                data-workspace-id={id}
                className="h-full min-w-0 shrink-0 grow"
                style={{
                  flexBasis: 0,
                  minWidth: WORKSPACE_CARD_MIN_WIDTH,
                }}
              >
                <WorkspaceControlCenterCard
                  workspace={workspace}
                  isSelected={id === (selectedWorkspaceId || "").trim()}
                  composerModel={composerModel}
                  isDragging={draggedWorkspaceId === id}
                  isDragTarget={
                    Boolean(draggedWorkspaceId) &&
                    dragTargetWorkspaceId === id &&
                    draggedWorkspaceId !== id
                  }
                  hasUnreadCompletionHighlight={highlightedWorkspaceIdSet.has(id)}
                  onSelectWorkspace={onSelectWorkspace}
                  onEnterWorkspace={onEnterWorkspace}
                  onOpenOutput={onOpenOutput}
                  onDragStartWorkspace={handleDragStartWorkspace}
                  onDragEnterWorkspace={handleDragEnterWorkspace}
                  onDragOverWorkspace={handleDragOverWorkspace}
                  onDropWorkspace={handleDropWorkspace}
                  onDragEndWorkspace={handleDragEndWorkspace}
                  onCardComposerSubmit={onCardComposerSubmit}
                  onWorkspaceCompletion={onWorkspaceCompletion}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
