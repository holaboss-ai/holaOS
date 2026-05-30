import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  ArrowLeft,
  CircleDot,
  Loader2,
  MessageSquareText,
  Paperclip,
  PenLine,
  Play,
  Plus,
  Send,
  Square,
} from "lucide-react";
import { AttachmentList } from "@/components/panes/ChatPane/AttachmentList";
import { ConversationTurns } from "@/components/panes/ChatPane/ConversationTurns";
import {
  appendAssistantExecutionSegment,
  appendAssistantOutputSegment,
  appendExecutionTimelineThinkingDelta,
  chatMessagesFromSessionState,
  finalizeAssistantExecutionSegments,
  finalizeExecutionTimelineTraceItems,
  liveAssistantSegmentsForRender,
  phaseTraceStepFromEvent,
  runFailedDetail,
  toolTraceStepFromEvent,
  upsertAssistantExecutionTraceStep,
  upsertExecutionTimelineTraceItem,
} from "@/components/panes/ChatPane/index";
import type {
  AttachmentListItem,
  ChatAssistantSegment,
  ChatExecutionTimelineItem,
  ChatMessage,
  ChatTraceStepStatus,
} from "@/components/panes/ChatPane/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
  makeIssueDetailTabId,
  pendingIssueComposerFocusAtom,
  upsertInternalTab,
  workspaceSurfaceTab,
} from "./state/internalTabs";

function issueStatusLabel(status: IssueStatusPayload): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "in_review":
      return "In review";
    default:
      return status
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function issueStatusVariant(
  status: IssueStatusPayload,
): "success" | "warning" | "info" | "primary" | "muted" {
  switch (status) {
    case "done":
      return "success";
    case "blocked":
      return "warning";
    case "in_progress":
      return "primary";
    case "in_review":
      return "info";
    case "backlog":
      return "muted";
    case "todo":
    default:
      return "info";
  }
}

function formatRelativeTime(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return "";
  }
  const ms = Date.now() - Date.parse(normalized);
  if (Number.isNaN(ms)) {
    return normalized;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCalendarLabel(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return "—";
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return normalized;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function attachmentUploadPayload(
  file: File,
): Promise<StageSessionAttachmentFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve({
        name: file.name,
        mime_type: file.type || null,
        content_base64: separator >= 0 ? result.slice(separator + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function dedupeFiles(current: File[], incoming: File[]): File[] {
  const seen = new Set(
    current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
  );
  const next = [...current];
  for (const file of incoming) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

function issueAttachmentsToListItems(
  attachments: Array<
    SessionInputAttachmentPayload | IssueAttachmentPayload
  >,
): Array<AttachmentListItem & { mime_type: string }> {
  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    size_bytes: attachment.size_bytes,
    mime_type: attachment.mime_type,
    workspace_path: attachment.workspace_path,
  }));
}

function issueAttachmentInputPayload(
  attachment: AttachmentListItem & { mime_type?: string },
): SessionInputAttachmentPayload {
  const workspacePath = attachment.workspace_path?.trim() || "";
  const mimeType = attachment.mime_type?.trim() || "";
  if (!workspacePath || !mimeType) {
    throw new Error("Existing issue attachments are missing required file metadata.");
  }
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime_type: mimeType,
    size_bytes: attachment.size_bytes,
    workspace_path: workspacePath,
  };
}

function issueReplyDisabledReason(issue: IssueRecordPayload | null): string {
  if (!issue) {
    return "";
  }
  if (issue.status === "backlog") {
    return "Move this issue to Todo before replying in the issue thread.";
  }
  if (!issue.assignee_teammate_id) {
    return "Assign a teammate before replying in the issue thread.";
  }
  if (issue.active_subagent_id) {
    return "This issue is actively running. Wait for the current run to finish before replying.";
  }
  return "";
}

function issueActivityLabel(issue: IssueRecordPayload): string {
  if (issue.active_subagent_id) {
    return "Working";
  }
  return issueStatusLabel(issue.status);
}

function shortSessionLabel(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    return "—";
  }
  return normalized.length <= 16 ? normalized : `${normalized.slice(0, 16)}…`;
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

export function IssueDetailPane({
  workspaceId,
  issueId,
}: {
  workspaceId: string;
  issueId: string;
}) {
  const { setSelectedWorkspaceId } = useWorkspaceSelection();
  const { selectedWorkspace } = useWorkspaceDesktop();
  const openIssueDetailTab = useOpenIssueDetailTab();
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const { issues, teammatesById, isLoading, statusMessage, refresh } =
    useIssueWorkspaceData(workspaceId);
  const { openOutput, openFileInInternalTab, openUrlInBrowserTab } =
    useOpenWorkspaceOutput();

  const issue = useMemo(
    () => issues.find((entry) => entry.issue_id === issueId) ?? null,
    [issueId, issues],
  );
  const teammates = useMemo(
    () =>
      Object.values(teammatesById)
        .filter((teammate) => teammate.status === "active")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [teammatesById],
  );
  const assignee = issue?.assignee_teammate_id
    ? teammatesById[issue.assignee_teammate_id] ?? null
    : null;
  const parentIssue = useMemo(
    () =>
      issue?.parent_issue_id
        ? issues.find((entry) => entry.issue_id === issue.parent_issue_id) ?? null
        : null,
    [issue?.parent_issue_id, issues],
  );
  const childIssues = useMemo(
    () =>
      issues
        .filter((entry) => entry.parent_issue_id === issue?.issue_id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    [issue?.issue_id, issues],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [threadRefreshToken, setThreadRefreshToken] = useState(0);
  const [collapsedTraceByStepId, setCollapsedTraceByStepId] = useState<
    Record<string, boolean>
  >({});
  const [runtimeState, setRuntimeState] =
    useState<SessionRuntimeRecordPayload | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [liveAgentStatus, setLiveAgentStatus] = useState("");
  const [liveAssistantSegments, setLiveAssistantSegments] = useState<
    ChatAssistantSegment[]
  >([]);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [liveExecutionItems, setLiveExecutionItems] = useState<
    ChatExecutionTimelineItem[]
  >([]);
  const activeStreamIdRef = useRef<string | null>(null);
  const liveAssistantSegmentsRef = useRef<ChatAssistantSegment[]>([]);
  const liveAssistantTextRef = useRef("");
  const liveExecutionItemsRef = useRef<ChatExecutionTimelineItem[]>([]);
  const liveAssistantFlushFrameRef = useRef<number | null>(null);
  const activeStreamInputIdRef = useRef<string | null>(null);
  const issueSessionIdRef = useRef("");
  const terminalEventTypeByInputIdRef = useRef<
    Map<string, "run_completed" | "run_failed">
  >(new Map());

  const [isMutationPending, setIsMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState("");

  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftBlockerReason, setDraftBlockerReason] = useState("");
  const [draftIssueAttachments, setDraftIssueAttachments] = useState<
    Array<AttachmentListItem & { mime_type: string }>
  >([]);

  const [replyInput, setReplyInput] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<File[]>([]);
  const [isReplySubmitting, setIsReplySubmitting] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [isCreatingSubIssue, setIsCreatingSubIssue] = useState(false);
  const [subIssueTitle, setSubIssueTitle] = useState("");
  const [subIssueDescription, setSubIssueDescription] = useState("");
  const [subIssueAssigneeTeammateId, setSubIssueAssigneeTeammateId] = useState("");
  const [subIssuePriority, setSubIssuePriority] = useState<IssuePriorityPayload | "">("");
  const [isSubIssueSubmitting, setIsSubIssueSubmitting] = useState(false);
  const [subIssueError, setSubIssueError] = useState("");
  const issueFileInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [pendingComposerFocus, setPendingComposerFocus] = useAtom(
    pendingIssueComposerFocusAtom,
  );

  // One-shot composer focus when the user opened this tab via "Reply" on a
  // blocked board card. Waits for the issue record to load so the textarea
  // is actually in the DOM and not still in the loading placeholder.
  useEffect(() => {
    if (!issue || isLoading) return;
    const tabId = makeIssueDetailTabId(workspaceId, issueId);
    if (!pendingComposerFocus.has(tabId)) return;
    const textarea = replyTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.scrollIntoView({ block: "center", behavior: "smooth" });
    setPendingComposerFocus((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }, [
    issue,
    isLoading,
    issueId,
    pendingComposerFocus,
    setPendingComposerFocus,
    workspaceId,
  ]);

  const replyDisabledReason = issueReplyDisabledReason(issue);
  const issueAttachmentItems = useMemo(
    () => draftIssueAttachments,
    [draftIssueAttachments],
  );
  const replyAttachmentItems = useMemo<AttachmentListItem[]>(
    () =>
      replyAttachments.map((file) => ({
        id: `${file.name}:${file.size}:${file.lastModified}`,
        kind: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        size_bytes: file.size,
        file,
      })),
    [replyAttachments],
  );
  const renderedLiveAssistantSegments = useMemo(
    () =>
      liveAssistantSegmentsForRender(
        liveAssistantSegments,
        liveExecutionItems,
        liveAssistantText,
      ),
    [liveAssistantSegments, liveExecutionItems, liveAssistantText],
  );
  const showLiveAssistantTurn =
    isResponding || renderedLiveAssistantSegments.length > 0;

  function setLiveAssistantSegmentsState(nextSegments: ChatAssistantSegment[]) {
    liveAssistantSegmentsRef.current = nextSegments;
    setLiveAssistantSegments(nextSegments);
  }

  function setLiveExecutionItemsState(nextItems: ChatExecutionTimelineItem[]) {
    liveExecutionItemsRef.current = nextItems;
    setLiveExecutionItems(nextItems);
  }

  function cancelLiveAssistantFlush() {
    if (liveAssistantFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(liveAssistantFlushFrameRef.current);
      liveAssistantFlushFrameRef.current = null;
    }
  }

  function resetLiveTurn() {
    cancelLiveAssistantFlush();
    liveAssistantSegmentsRef.current = [];
    liveAssistantTextRef.current = "";
    liveExecutionItemsRef.current = [];
    setLiveAssistantSegments([]);
    setLiveAssistantText("");
    setLiveExecutionItems([]);
    setLiveAgentStatus("");
  }

  function scheduleLiveAssistantFlush() {
    if (liveAssistantFlushFrameRef.current !== null) {
      return;
    }
    liveAssistantFlushFrameRef.current = window.requestAnimationFrame(() => {
      liveAssistantFlushFrameRef.current = null;
      setLiveAssistantText(liveAssistantTextRef.current);
    });
  }

  function flushLiveAssistantOutputSegment(
    tone: ChatMessage["tone"] = "default",
  ) {
    if (!liveAssistantTextRef.current) {
      return;
    }
    cancelLiveAssistantFlush();
    const nextSegments = appendAssistantOutputSegment(
      liveAssistantSegmentsRef.current,
      liveAssistantTextRef.current,
      tone,
    );
    setLiveAssistantSegmentsState(nextSegments);
    liveAssistantTextRef.current = "";
    setLiveAssistantText("");
  }

  function flushLiveExecutionSegment() {
    if (liveExecutionItemsRef.current.length === 0) {
      return;
    }
    const nextSegments = appendAssistantExecutionSegment(
      liveAssistantSegmentsRef.current,
      liveExecutionItemsRef.current,
    );
    setLiveAssistantSegmentsState(nextSegments);
    liveExecutionItemsRef.current = [];
    setLiveExecutionItems([]);
  }

  function appendLiveAssistantDelta(delta: string) {
    if (!delta) {
      return;
    }
    flushLiveExecutionSegment();
    liveAssistantTextRef.current = `${liveAssistantTextRef.current}${delta}`;
    scheduleLiveAssistantFlush();
  }

  function appendLiveThinkingDelta(delta: string, order: number) {
    if (!delta) {
      return;
    }
    flushLiveAssistantOutputSegment();
    const nextItems = appendExecutionTimelineThinkingDelta(
      liveExecutionItemsRef.current,
      delta,
      order,
    );
    setLiveExecutionItemsState(nextItems);
  }

  function upsertLiveTraceStep(step: ReturnType<typeof phaseTraceStepFromEvent>) {
    if (!step) {
      return;
    }
    flushLiveAssistantOutputSegment();
    const nextSegments = upsertAssistantExecutionTraceStep(
      liveAssistantSegmentsRef.current,
      step,
    );
    if (nextSegments) {
      setLiveAssistantSegmentsState(nextSegments);
      return;
    }
    const nextItems = upsertExecutionTimelineTraceItem(
      liveExecutionItemsRef.current,
      step,
    );
    setLiveExecutionItemsState(nextItems);
  }

  function finalizeLiveTraceSteps(
    status: Extract<ChatTraceStepStatus, "completed" | "error" | "waiting">,
  ) {
    setLiveAssistantSegmentsState(
      finalizeAssistantExecutionSegments(
        liveAssistantSegmentsRef.current,
        status,
      ),
    );
    setLiveExecutionItemsState(
      finalizeExecutionTimelineTraceItems(
        liveExecutionItemsRef.current,
        status,
      ),
    );
  }

  function liveAssistantHasVisibleOutput() {
    return (
      Boolean(liveAssistantTextRef.current.trim()) ||
      liveAssistantSegments.some(
        (segment) =>
          segment.kind === "output" && Boolean(segment.text.trim()),
      )
    );
  }

  function persistLiveFailureOutput(detail: string) {
    if (!detail.trim()) {
      return;
    }
    flushLiveExecutionSegment();
    if (
      liveAssistantTextRef.current.trim() ||
      liveAssistantSegmentsRef.current.some(
        (segment) =>
          segment.kind === "output" && Boolean(segment.text.trim()),
      )
    ) {
      return;
    }
    setLiveAssistantSegmentsState(
      appendAssistantOutputSegment(
        liveAssistantSegmentsRef.current,
        detail,
        "error",
      ),
    );
  }

  function rememberTerminalEvent(
    inputId: string,
    eventType: "run_completed" | "run_failed",
  ) {
    const normalizedInputId = inputId.trim();
    if (!normalizedInputId) {
      return null;
    }
    const priorEventType =
      terminalEventTypeByInputIdRef.current.get(normalizedInputId) ?? null;
    if (priorEventType) {
      return priorEventType;
    }
    terminalEventTypeByInputIdRef.current.set(normalizedInputId, eventType);
    while (terminalEventTypeByInputIdRef.current.size > 64) {
      const oldestInputId = terminalEventTypeByInputIdRef.current.keys().next()
        .value;
      if (typeof oldestInputId !== "string") {
        break;
      }
      terminalEventTypeByInputIdRef.current.delete(oldestInputId);
    }
    return null;
  }

  useEffect(() => {
    if (!issue) {
      return;
    }
    setDraftTitle(issue.title);
    setDraftDescription(issue.description ?? "");
    setDraftBlockerReason(issue.blocker_reason ?? "");
    setDraftIssueAttachments(issueAttachmentsToListItems(issue.attachments ?? []));
    setIsEditingDetails(false);
    setMutationError("");
    setIsCreatingSubIssue(false);
    setSubIssueTitle("");
    setSubIssueDescription("");
    setSubIssueAssigneeTeammateId(issue.assignee_teammate_id ?? "");
    setSubIssuePriority(issue.priority ?? "");
    setSubIssueError("");
  }, [
    issue?.assignee_teammate_id,
    issue?.attachments,
    issue?.blocker_reason,
    issue?.description,
    issue?.issue_id,
    issue?.priority,
    issue?.title,
  ]);

  useEffect(() => {
    issueSessionIdRef.current = issue?.session_id?.trim() || "";
  }, [issue?.session_id]);

  useEffect(() => {
    const priorStreamId = activeStreamIdRef.current;
    activeStreamIdRef.current = null;
    activeStreamInputIdRef.current = null;
    terminalEventTypeByInputIdRef.current.clear();
    setIsResponding(false);
    resetLiveTurn();
    if (priorStreamId) {
      void window.electronAPI.workspace
        .closeSessionOutputStream(priorStreamId, "issue_detail_session_changed")
        .catch(() => undefined);
    }
  }, [issue?.session_id]);

  useEffect(
    () => () => {
      cancelLiveAssistantFlush();
      const activeStreamId = activeStreamIdRef.current;
      activeStreamIdRef.current = null;
      if (activeStreamId) {
        void window.electronAPI.workspace
          .closeSessionOutputStream(activeStreamId, "issue_detail_unmounted")
          .catch(() => undefined);
      }
    },
    [],
  );

  const refreshThread = useCallback(() => {
    setThreadRefreshToken((value) => value + 1);
  }, []);

  const handleBackToBoard = useCallback(() => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }
    setSelectedWorkspaceId(normalizedWorkspaceId);
    const tab = workspaceSurfaceTab("issues_board", normalizedWorkspaceId);
    setInternalTabs((prev) => upsertInternalTab(prev, tab));
    setActiveInternalTabId(tab.id);
  }, [
    setActiveInternalTabId,
    setInternalTabs,
    setSelectedWorkspaceId,
    workspaceId,
  ]);

  const openRelatedIssue = useCallback(
    (targetIssue: IssueRecordPayload) => {
      setSelectedWorkspaceId(workspaceId);
      void openIssueDetailTab({
        workspaceId: targetIssue.workspace_id,
        issueId: targetIssue.issue_id,
        title: targetIssue.title,
      });
    },
    [openIssueDetailTab, setSelectedWorkspaceId, workspaceId],
  );

  useEffect(() => {
    if (!issue) {
      setMessages([]);
      setRuntimeState(null);
      setHistoryError("");
      setIsHistoryLoading(false);
      setIsResponding(false);
      resetLiveTurn();
      return;
    }

    let cancelled = false;
    const sessionId = issue.session_id.trim();

    const loadThread = async () => {
      setIsHistoryLoading(true);
      try {
        const [history, outputEvents, outputs, runtimeStates] = await Promise.all([
          window.electronAPI.workspace.getSessionHistory({
            workspaceId,
            sessionId: issue.session_id,
            limit: 200,
            offset: 0,
            order: "asc",
          }),
          window.electronAPI.workspace.getSessionOutputEvents({
            workspaceId,
            sessionId: issue.session_id,
          }),
          window.electronAPI.workspace.listOutputs({
            workspaceId,
            sessionId: issue.session_id,
            limit: 200,
            offset: 0,
          }),
          window.electronAPI.workspace.listRuntimeStates(workspaceId),
        ]);
        if (cancelled) {
          return;
        }
        const nextRuntimeState =
          runtimeStates.items.find(
            (item) => item.session_id.trim() === sessionId,
          ) ?? null;
        const currentRuntimeStatus = runtimeStateEffectiveStatus(nextRuntimeState);
        const currentRuntimeInputId = (
          nextRuntimeState?.current_input_id || ""
        ).trim();
        const liveInputId =
          activeStreamInputIdRef.current?.trim() || currentRuntimeInputId;
        const shouldAttachLiveRunStream =
          Boolean(liveInputId) &&
          ["BUSY", "QUEUED"].includes(currentRuntimeStatus);
        const nextMessages = chatMessagesFromSessionState({
          historyMessages: history.messages,
          outputEvents: outputEvents.items,
          outputs: outputs.items,
          showExecutionInternals: true,
          showBootstrapPhaseTrace: false,
        });
        setMessages(
          shouldAttachLiveRunStream
            ? nextMessages.filter(
                (message) =>
                  message.role !== "assistant" ||
                  !message.id.endsWith(liveInputId),
              )
            : nextMessages,
        );
        setRuntimeState(nextRuntimeState);
        if (!shouldAttachLiveRunStream && activeStreamIdRef.current === null) {
          setIsResponding(false);
          resetLiveTurn();
        }
        setHistoryError("");
      } catch (error) {
        if (!cancelled) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Failed to load issue activity",
          );
        }
      } finally {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      }
    };

    void loadThread();
    const timer = window.setInterval(() => {
      void loadThread();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [issue, threadRefreshToken, workspaceId]);

  const scheduleConversationRefresh = useCallback(() => {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedSessionId = issueSessionIdRef.current;
    if (!normalizedWorkspaceId || !normalizedSessionId) {
      return;
    }
    const delays = [150, 500, 1_500, 3_000];
    for (const delayMs of delays) {
      window.setTimeout(() => {
        if (
          issueSessionIdRef.current !== normalizedSessionId ||
          workspaceId.trim() !== normalizedWorkspaceId
        ) {
          return;
        }
        void refresh().catch(() => undefined);
        refreshThread();
      }, delayMs);
    }
  }, [refresh, refreshThread, workspaceId]);

  useEffect(() => {
    const normalizedSessionId = issue?.session_id?.trim() || "";
    if (!normalizedSessionId) {
      return;
    }
    const normalizedWorkspaceId = workspaceId.trim();
    const currentRuntimeStatus = runtimeStateEffectiveStatus(runtimeState);
    const currentRuntimeInputId = (runtimeState?.current_input_id || "").trim();
    const shouldAttachLiveRunStream =
      Boolean(currentRuntimeInputId) &&
      ["BUSY", "QUEUED"].includes(currentRuntimeStatus);
    if (!shouldAttachLiveRunStream || activeStreamIdRef.current) {
      return;
    }

    let cancelled = false;
    resetLiveTurn();
    setIsResponding(true);
    setLiveAgentStatus(
      currentRuntimeStatus === "QUEUED" ? "Queued" : "Working",
    );

    void window.electronAPI.workspace
      .openSessionOutputStream({
        sessionId: normalizedSessionId,
        workspaceId: normalizedWorkspaceId,
        inputId: currentRuntimeInputId || undefined,
        includeHistory: Boolean(currentRuntimeInputId),
        stopOnTerminal: true,
      })
      .then((stream) => {
        if (cancelled) {
          return window.electronAPI.workspace
            .closeSessionOutputStream(stream.streamId, "issue_detail_attach_cancelled")
            .catch(() => undefined);
        }
        activeStreamIdRef.current = stream.streamId;
        activeStreamInputIdRef.current = currentRuntimeInputId || null;
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Failed to attach to the live issue run",
          );
          setIsResponding(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [issue?.session_id, runtimeState, workspaceId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.workspace.onSessionStreamEvent(
      (payload) => {
        const activeStreamId = activeStreamIdRef.current;
        if (!activeStreamId || payload.streamId !== activeStreamId) {
          return;
        }

        const rawEventData =
          payload.type === "event" ? payload.event?.data : null;
        const typedEvent =
          rawEventData &&
          typeof rawEventData === "object" &&
          !Array.isArray(rawEventData)
            ? (rawEventData as {
                event_type?: string;
                payload?: Record<string, unknown>;
                input_id?: string;
                session_id?: string;
                sequence?: number;
              })
            : null;
        const eventType = typedEvent?.event_type ?? payload.type;
        const eventPayload = typedEvent?.payload ?? {};
        const eventInputId =
          typeof typedEvent?.input_id === "string" ? typedEvent.input_id : "";
        const eventSessionId =
          typeof typedEvent?.session_id === "string"
            ? typedEvent.session_id
            : "";
        const eventSequence =
          typeof typedEvent?.sequence === "number" &&
          Number.isFinite(typedEvent.sequence)
            ? typedEvent.sequence
            : Number.MAX_SAFE_INTEGER;

        if (
          eventSessionId &&
          eventSessionId.trim() !== issueSessionIdRef.current
        ) {
          return;
        }

        if (payload.type === "error") {
          setHistoryError(payload.error || "The issue run stream failed.");
          setIsResponding(false);
          activeStreamIdRef.current = null;
          activeStreamInputIdRef.current = null;
          scheduleConversationRefresh();
          return;
        }

        if (payload.type === "done") {
          setIsResponding(false);
          activeStreamIdRef.current = null;
          activeStreamInputIdRef.current = null;
          scheduleConversationRefresh();
          return;
        }

        if (eventType === "run_claimed" || eventType === "run_started") {
          setIsResponding(true);
          setLiveAgentStatus("Checking workspace context");
        }

        const phaseStep = phaseTraceStepFromEvent(
          eventType,
          eventPayload,
          eventSequence,
        );
        if (phaseStep) {
          upsertLiveTraceStep(phaseStep);
        }

        const toolStep = toolTraceStepFromEvent(
          eventType,
          eventPayload,
          eventSequence,
        );
        if (toolStep) {
          upsertLiveTraceStep(toolStep);
        }

        if (eventType === "output_delta") {
          const delta =
            typeof eventPayload.delta === "string" ? eventPayload.delta : "";
          appendLiveAssistantDelta(delta);
          return;
        }

        if (eventType === "thinking_delta") {
          const delta =
            typeof eventPayload.delta === "string" ? eventPayload.delta : "";
          appendLiveThinkingDelta(delta, eventSequence);
          return;
        }

        if (eventType === "run_failed") {
          if (rememberTerminalEvent(eventInputId, "run_failed")) {
            return;
          }
          finalizeLiveTraceSteps("error");
          if (!liveAssistantHasVisibleOutput()) {
            persistLiveFailureOutput(runFailedDetail(eventPayload));
          }
          setIsResponding(false);
          setLiveAgentStatus("");
          activeStreamIdRef.current = null;
          activeStreamInputIdRef.current = null;
          scheduleConversationRefresh();
          return;
        }

        if (eventType === "run_completed") {
          if (rememberTerminalEvent(eventInputId, "run_completed")) {
            return;
          }
          const completedStatus =
            typeof eventPayload.status === "string"
              ? eventPayload.status.trim().toLowerCase()
              : "";
          finalizeLiveTraceSteps(
            completedStatus === "paused" || completedStatus === "waiting_user"
              ? "waiting"
              : "completed",
          );
          setIsResponding(false);
          setLiveAgentStatus("");
          activeStreamIdRef.current = null;
          activeStreamInputIdRef.current = null;
          scheduleConversationRefresh();
        }
      },
    );

    return () => {
      unsubscribe();
    };
  }, [scheduleConversationRefresh]);

  useEffect(() => {
    if (!isResponding || !issue?.session_id) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedSessionId = issue.session_id.trim();

    const poll = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response =
          await window.electronAPI.workspace.listRuntimeStates(
            normalizedWorkspaceId,
          );
        if (cancelled) {
          return;
        }
        const currentState =
          response.items.find(
            (item) => item.session_id.trim() === normalizedSessionId,
          ) ?? null;
        setRuntimeState(currentState);
        const status = runtimeStateEffectiveStatus(currentState);
        if (status === "BUSY" || status === "QUEUED") {
          return;
        }
        const activeStreamId = activeStreamIdRef.current;
        if (activeStreamId) {
          await window.electronAPI.workspace
            .closeSessionOutputStream(activeStreamId, "issue_runtime_terminal")
            .catch(() => undefined);
          activeStreamIdRef.current = null;
        }
        finalizeLiveTraceSteps(
          status === "WAITING_USER" || status === "PAUSED"
            ? "waiting"
            : status === "ERROR"
              ? "error"
              : "completed",
        );
        if (
          status === "ERROR" &&
          !liveAssistantHasVisibleOutput() &&
          currentState?.last_error
        ) {
          persistLiveFailureOutput(runFailedDetail(currentState.last_error));
        }
        setIsResponding(false);
        setLiveAgentStatus("");
        activeStreamInputIdRef.current = null;
        scheduleConversationRefresh();
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isResponding, issue?.session_id, scheduleConversationRefresh, workspaceId]);

  const runIssueMutation = useCallback(
    async (action: () => Promise<unknown>, fallbackMessage: string) => {
      if (!issue) {
        return false;
      }
      setIsMutationPending(true);
      setMutationError("");
      try {
        await action();
        await refresh();
        refreshThread();
        return true;
      } catch (error) {
        setMutationError(
          error instanceof Error ? error.message : fallbackMessage,
        );
        return false;
      } finally {
        setIsMutationPending(false);
      }
    },
    [issue, refresh, refreshThread],
  );

  const handleSaveDetails = useCallback(async () => {
    if (!issue) {
      return;
    }
    const normalizedTitle = draftTitle.trim();
    if (!normalizedTitle) {
      setMutationError("Issue title is required.");
      return;
    }
    const normalizedBlockerReason = draftBlockerReason.trim();
    if (issue.status === "blocked" && !normalizedBlockerReason) {
      setMutationError("Blocked issues need a blocker reason.");
      return;
    }
    const newAttachmentFiles = draftIssueAttachments
      .map((attachment) => attachment.file)
      .filter((file): file is File => Boolean(file));
    const saved = await runIssueMutation(
      async () => {
        const stagedAttachments =
          newAttachmentFiles.length > 0
            ? await window.electronAPI.workspace.stageSessionAttachments({
                workspace_id: workspaceId,
                files: await Promise.all(
                  newAttachmentFiles.map((file) => attachmentUploadPayload(file)),
                ),
              })
            : { attachments: [] };
        let stagedIndex = 0;
        const nextIssueAttachments = draftIssueAttachments.map((attachment) => {
          if (attachment.file) {
            const staged = stagedAttachments.attachments[stagedIndex];
            stagedIndex += 1;
            if (!staged) {
              throw new Error("Failed to stage one of the issue attachments.");
            }
            return staged;
          }
          return issueAttachmentInputPayload(attachment);
        });
        return window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
          workspace_id: workspaceId,
          title: normalizedTitle,
          description: draftDescription.trim() || null,
          blocker_reason:
            issue.status === "blocked" ? normalizedBlockerReason : null,
          attachments: nextIssueAttachments,
        });
      },
      "Failed to update issue details",
    );
    if (saved) {
      setIsEditingDetails(false);
    }
  }, [
    draftBlockerReason,
    draftDescription,
    draftTitle,
    issue,
    runIssueMutation,
    workspaceId,
  ]);

  const handleCreateSubIssue = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!issue) {
        return;
      }
      const normalizedTitle = subIssueTitle.trim();
      if (!normalizedTitle) {
        setSubIssueError("Sub-issue title is required.");
        return;
      }
      setIsSubIssueSubmitting(true);
      setSubIssueError("");
      try {
        const created = await window.electronAPI.workspace.createIssue({
          workspace_id: workspaceId,
          parent_issue_id: issue.issue_id,
          title: normalizedTitle,
          description: subIssueDescription.trim() || null,
          status: "todo",
          priority: subIssuePriority || null,
          assignee_teammate_id: subIssueAssigneeTeammateId || null,
          blocker_reason: null,
          attachments: [],
        });
        setIsCreatingSubIssue(false);
        setSubIssueTitle("");
        setSubIssueDescription("");
        await refresh();
        void openIssueDetailTab({
          workspaceId,
          issueId: created.issue.issue_id,
          title: created.issue.title,
        });
      } catch (error) {
        setSubIssueError(
          error instanceof Error ? error.message : "Failed to create sub-issue",
        );
      } finally {
        setIsSubIssueSubmitting(false);
      }
    },
    [
      issue,
      openIssueDetailTab,
      refresh,
      subIssueAssigneeTeammateId,
      subIssueDescription,
      subIssuePriority,
      subIssueTitle,
      workspaceId,
    ],
  );

  const handleIssueAttachmentChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextFiles = Array.from(event.target.files ?? []);
      if (nextFiles.length === 0) {
        return;
      }
      setDraftIssueAttachments((current) => {
        const seen = new Set(
          current
            .map((attachment) =>
              attachment.file
                ? `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`
                : null,
            )
            .filter((entry): entry is string => Boolean(entry)),
        );
        const incoming = nextFiles
          .filter((file) => {
            const key = `${file.name}:${file.size}:${file.lastModified}`;
            if (seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          })
          .map((file) => ({
            id: `${file.name}:${file.size}:${file.lastModified}`,
            kind: file.type.startsWith("image/") ? ("image" as const) : ("file" as const),
            name: file.name,
            size_bytes: file.size,
            mime_type: file.type || "application/octet-stream",
            file,
          }));
        return [...current, ...incoming];
      });
      event.target.value = "";
    },
    [],
  );

  const handleStopIssueRun = useCallback(async () => {
    if (!issue?.active_subagent_id) {
      return;
    }
    if (!window.confirm(`Stop ${issue.issue_id}?`)) {
      return;
    }
    await runIssueMutation(
      () => window.electronAPI.workspace.stopIssueRun(workspaceId, issue.issue_id),
      "Failed to stop issue run",
    );
  }, [issue, runIssueMutation, workspaceId]);

  // Mirror of IssuesBoardPane resume: flip status back to todo so the
  // runtime auto-dispatches a fresh subagent on the existing session. Only
  // exposed when blocker_reason indicates a recoverable run (cancelled /
  // failed) — agent-driven `waiting_on_user` needs a typed reply instead.
  const handleResumeIssueRun = useCallback(async () => {
    if (!issue) return;
    await runIssueMutation(
      () =>
        window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
          workspace_id: workspaceId,
          status: "todo",
        }),
      "Failed to resume issue",
    );
  }, [issue, runIssueMutation, workspaceId]);

  const isResumableBlocker = useMemo(() => {
    if (!issue || issue.status !== "blocked") return false;
    const reason = (issue.blocker_reason ?? "").trim();
    return reason.startsWith("Run cancelled") || reason.startsWith("Run failed");
  }, [issue]);

  const startEditingDetails = useCallback(() => {
    if (!issue) return;
    setDraftTitle(issue.title);
    setDraftDescription(issue.description ?? "");
    setDraftBlockerReason(issue.blocker_reason ?? "");
    setDraftIssueAttachments(
      issueAttachmentsToListItems(issue.attachments ?? []),
    );
    setMutationError("");
    setIsEditingDetails(true);
  }, [issue]);

  const cancelEditingDetails = useCallback(() => {
    if (!issue) return;
    setDraftTitle(issue.title);
    setDraftDescription(issue.description ?? "");
    setDraftBlockerReason(issue.blocker_reason ?? "");
    setDraftIssueAttachments(
      issueAttachmentsToListItems(issue.attachments ?? []),
    );
    setMutationError("");
    setIsEditingDetails(false);
  }, [issue]);

  const handleReplyAttachmentChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextFiles = Array.from(event.target.files ?? []);
      if (nextFiles.length === 0) {
        return;
      }
      setReplyAttachments((current) => dedupeFiles(current, nextFiles));
      event.target.value = "";
    },
    [],
  );

  const handleSubmitReply = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!issue || !workspaceId) {
        return;
      }
      const text = replyInput.trim();
      if (!text && replyAttachments.length === 0) {
        return;
      }
      if (replyDisabledReason) {
        setReplyError(replyDisabledReason);
        return;
      }
      setIsReplySubmitting(true);
      setReplyError("");
      try {
        const stagedAttachments =
          replyAttachments.length > 0
            ? await window.electronAPI.workspace.stageSessionAttachments({
                workspace_id: workspaceId,
                files: await Promise.all(
                  replyAttachments.map((file) => attachmentUploadPayload(file)),
                ),
              })
            : { attachments: [] };
        const queued = await window.electronAPI.workspace.queueSessionInput({
          workspace_id: workspaceId,
          session_id: issue.session_id,
          text,
          image_urls: [],
          attachments: stagedAttachments.attachments,
        });
        setMessages((current) => [
          ...current,
          {
            id: `user-${queued.input_id}`,
            role: "user",
            text,
            createdAt: new Date().toISOString(),
            attachments: stagedAttachments.attachments,
          },
        ]);
        resetLiveTurn();
        setIsResponding(true);
        setLiveAgentStatus(
          runtimeStateStatus(queued.effective_state ?? queued.runtime_status) ===
            "QUEUED"
            ? "Queued"
            : "Working",
        );
        activeStreamInputIdRef.current = queued.input_id;
        const stream = await window.electronAPI.workspace.openSessionOutputStream({
          sessionId: issue.session_id,
          workspaceId,
          inputId: queued.input_id,
          includeHistory: true,
          stopOnTerminal: true,
        });
        activeStreamIdRef.current = stream.streamId;
        setReplyInput("");
        setReplyAttachments([]);
        await refresh();
        refreshThread();
      } catch (error) {
        setReplyError(
          error instanceof Error ? error.message : "Failed to queue reply",
        );
      } finally {
        setIsReplySubmitting(false);
      }
    },
    [
      issue,
      refresh,
      refreshThread,
      replyAttachments,
      replyDisabledReason,
      replyInput,
      workspaceId,
    ],
  );

  const handleToggleTraceStep = useCallback((stepId: string) => {
    setCollapsedTraceByStepId((current) => ({
      ...current,
      [stepId]: !current[stepId],
    }));
  }, []);

  const handlePreviewAttachment = useCallback(
    (attachment: AttachmentListItem) => {
      const workspacePath = attachment.workspace_path?.trim() || "";
      if (workspacePath) {
        openFileInInternalTab(workspacePath);
      }
    },
    [openFileInInternalTab],
  );

  const handleOpenAllArtifacts = useCallback(
    (outputs: WorkspaceOutputRecordPayload[]) => {
      if (outputs[0]) {
        void openOutput(outputs[0]);
      }
    },
    [openOutput],
  );

  if (isLoading && !issue) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-foreground/35" />
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="grid h-full place-items-center">
        <div className="rounded-2xl border border-border bg-card/70 px-6 py-5 text-center">
          <div className="text-lg font-medium text-foreground">Issue not found</div>
          <div className="mt-1 text-sm text-foreground/55">
            This issue may have been removed or is not available in this workspace.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top bar — single 44px row, breadcrumb + actions */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          type="button"
          onClick={handleBackToBoard}
          className="window-no-drag grid size-7 shrink-0 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          aria-label="Back to board"
          title="Back to board"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
          <span className="truncate text-foreground/55">
            {selectedWorkspace?.name || "Workspace"}
          </span>
          <span className="shrink-0 text-foreground/25">/</span>
          <span className="shrink-0 font-mono text-[12px] text-foreground/68">
            {issue.issue_id}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isEditingDetails ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={cancelEditingDetails}
                disabled={isMutationPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveDetails()}
                disabled={isMutationPending}
              >
                {isMutationPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Save
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={startEditingDetails}
              disabled={Boolean(issue.active_subagent_id)}
              title={
                issue.active_subagent_id
                  ? "Stop the active run before editing this issue."
                  : "Edit issue"
              }
            >
              <PenLine className="size-3.5" />
              Edit
            </Button>
          )}
        </div>
      </header>

      {mutationError || statusMessage ? (
        <div className="border-b border-border bg-card/40 px-4 py-2 text-[12px] text-foreground/72">
          {mutationError || statusMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-8 py-8 xl:grid-cols-[minmax(0,1fr)_240px]">
          <article className="min-w-0 space-y-8">
            {isEditingDetails ? (
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Issue title"
                className="h-auto rounded-none border-0 bg-transparent px-0 py-0 text-[28px] font-semibold leading-tight tracking-tight shadow-none focus-visible:border-0 focus-visible:ring-0"
                autoFocus
              />
            ) : (
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-foreground">
                {issue.title || issue.issue_id}
              </h1>
            )}

            {isEditingDetails ? (
              <Textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Add description..."
                className="min-h-[120px] max-w-3xl resize-y bg-background/45 text-[14px] leading-7"
              />
            ) : issue.description ? (
              <div className="max-w-3xl whitespace-pre-wrap text-[14px] leading-7 text-foreground/78">
                {issue.description}
              </div>
            ) : null}

            {issue.blocker_reason && !isEditingDetails ? (
              <div className="flex max-w-3xl items-start gap-3 rounded-md border-l-2 border-amber-500/45 bg-amber-500/[0.05] py-2.5 pl-3 pr-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700/85 dark:text-amber-200/75">
                    Blocker
                  </div>
                  <div className="whitespace-pre-wrap text-[13px] leading-6 text-amber-900 dark:text-amber-100/85">
                    {issue.blocker_reason}
                  </div>
                </div>
                {isResumableBlocker ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-100 dark:hover:text-amber-100"
                    onClick={() => void handleResumeIssueRun()}
                    disabled={isMutationPending}
                  >
                    <Play className="size-3.5" />
                    Resume
                  </Button>
                ) : null}
              </div>
            ) : null}

            {isEditingDetails && issue.status === "blocked" ? (
              <div className="max-w-3xl space-y-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                  Blocker reason
                </div>
                <Textarea
                  value={draftBlockerReason}
                  onChange={(event) =>
                    setDraftBlockerReason(event.target.value)
                  }
                  placeholder="Why is this issue blocked?"
                  className="min-h-[80px] resize-y bg-background/45"
                />
              </div>
            ) : null}

            {!isEditingDetails && issueAttachmentItems.length > 0 ? (
              <div className="max-w-3xl space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                  Attachments
                </div>
                <div className="flex flex-wrap gap-2">
                  {issueAttachmentItems.map((attachment) => (
                    <button
                      key={attachment.id}
                      type="button"
                      onClick={() => handlePreviewAttachment(attachment)}
                      className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-background/55 px-2.5 py-1.5 text-[12px] text-foreground/75 transition-colors hover:bg-background"
                    >
                      <Paperclip className="size-3.5 shrink-0 text-foreground/45" />
                      <span className="truncate">{attachment.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {isEditingDetails ? (
              <div className="max-w-3xl space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                  Attachments
                </div>
                {issueAttachmentItems.length > 0 ? (
                  <AttachmentList
                    attachments={issueAttachmentItems}
                    onPreview={handlePreviewAttachment}
                    onRemove={(attachmentId) => {
                      setDraftIssueAttachments((current) =>
                        current.filter(
                          (attachment) => attachment.id !== attachmentId,
                        ),
                      );
                    }}
                  />
                ) : (
                  <div className="rounded-md border border-dashed border-border bg-background/35 px-3 py-2.5 text-[12px] text-foreground/48">
                    No attachments
                  </div>
                )}
                <input
                  ref={issueFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleIssueAttachmentChange}
                />
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => issueFileInputRef.current?.click()}
                  >
                    <Paperclip className="size-3.5" />
                    Add attachments
                  </Button>
                </div>
              </div>
            ) : null}

            {!isEditingDetails ? (
              <div className="max-w-3xl space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Sub-issues
                    {childIssues.length > 0 ? (
                      <span className="text-foreground/35 normal-case tracking-normal">
                        {childIssues.length}
                      </span>
                    ) : null}
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-mr-1.5 h-7 gap-1 px-1.5 text-[12px] text-foreground/55 hover:text-foreground"
                    onClick={() => {
                      setIsCreatingSubIssue((current) => !current);
                      setSubIssueError("");
                    }}
                  >
                    <Plus className="size-3.5" />
                    {isCreatingSubIssue ? "Close" : "Add"}
                  </Button>
                </div>
                {childIssues.length > 0 ? (
                  <ul className="-mx-1.5 divide-y divide-border/45 border-y border-border/45">
                    {childIssues.map((childIssue) => {
                      const childAssignee = childIssue.assignee_teammate_id
                        ? teammatesById[childIssue.assignee_teammate_id] ?? null
                        : null;
                      return (
                        <li key={childIssue.issue_id}>
                          <button
                            type="button"
                            onClick={() => openRelatedIssue(childIssue)}
                            className="flex w-full items-center gap-3 rounded-md px-1.5 py-2 text-left transition-colors hover:bg-foreground/[0.025]"
                          >
                            <StatusDot
                              variant={issueStatusVariant(childIssue.status)}
                            />
                            <span className="shrink-0 font-mono text-[11px] text-foreground/45">
                              {childIssue.issue_id}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                              {childIssue.title}
                            </span>
                            <span className="hidden shrink-0 text-[11px] text-foreground/40 md:inline">
                              {childAssignee?.name || "Unassigned"}
                            </span>
                            <span className="hidden shrink-0 text-[11px] text-foreground/35 md:inline">
                              {formatRelativeTime(childIssue.updated_at)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {isCreatingSubIssue ? (
                  <form
                    onSubmit={handleCreateSubIssue}
                    className="space-y-2 pt-1"
                  >
                    <Input
                      value={subIssueTitle}
                      onChange={(event) => setSubIssueTitle(event.target.value)}
                      placeholder="Sub-issue title"
                      className="h-9 bg-background/45"
                      autoFocus
                    />
                    <Textarea
                      value={subIssueDescription}
                      onChange={(event) =>
                        setSubIssueDescription(event.target.value)
                      }
                      placeholder="What should this sub-issue cover? (optional)"
                      className="min-h-[80px] resize-y bg-background/45 text-[13px]"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={subIssueAssigneeTeammateId}
                        onChange={(event) =>
                          setSubIssueAssigneeTeammateId(event.target.value)
                        }
                        className="h-8 rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none transition-colors focus:border-primary"
                        aria-label="Assignee"
                      >
                        <option value="">Unassigned</option>
                        {teammates.map((teammate) => (
                          <option
                            key={teammate.teammate_id}
                            value={teammate.teammate_id}
                          >
                            {teammate.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={subIssuePriority}
                        onChange={(event) =>
                          setSubIssuePriority(
                            event.target.value as IssuePriorityPayload | "",
                          )
                        }
                        className="h-8 rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none transition-colors focus:border-primary"
                        aria-label="Priority"
                      >
                        <option value="">No priority</option>
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setIsCreatingSubIssue(false);
                            setSubIssueError("");
                          }}
                          disabled={isSubIssueSubmitting}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={isSubIssueSubmitting}
                        >
                          {isSubIssueSubmitting ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : null}
                          Create
                        </Button>
                      </div>
                    </div>
                    {subIssueError ? (
                      <div className="text-[12px] text-destructive">
                        {subIssueError}
                      </div>
                    ) : null}
                  </form>
                ) : null}
              </div>
            ) : null}

            <div className="max-w-3xl space-y-4">
              <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                <span>Activity</span>
                <div className="h-px flex-1 bg-border/55" />
              </div>

              <div className="flex items-center gap-2 text-[11px] text-foreground/40">
                <CircleDot className="size-3 shrink-0" />
                <span className="truncate">
                  {`${(issue.created_by || "Workspace user").trim() || "Workspace user"} created this issue`}
                </span>
                <span className="shrink-0">
                  {formatRelativeTime(issue.created_at)}
                </span>
              </div>

              {historyError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-[12px] text-destructive">
                  {historyError}
                </div>
              ) : null}

              {isHistoryLoading &&
              messages.length === 0 &&
              !showLiveAssistantTurn ? (
                <div className="grid h-20 place-items-center rounded-md border border-border/55 bg-background/35">
                  <Loader2 className="size-5 animate-spin text-foreground/35" />
                </div>
              ) : messages.length > 0 || showLiveAssistantTurn ? (
                <ConversationTurns
                  messages={messages}
                  assistantLabel={assignee?.name || "Assigned teammate"}
                  assistantMode="issue"
                  showExecutionInternals
                  workspaceId={workspaceId}
                  onPreviewAttachment={handlePreviewAttachment}
                  onOpenOutput={openOutput}
                  onOpenAllArtifacts={handleOpenAllArtifacts}
                  collapsedTraceByStepId={collapsedTraceByStepId}
                  onToggleTraceStep={handleToggleTraceStep}
                  onLinkClick={(url) => {
                    void openUrlInBrowserTab(url, { dedupBy: "exact" });
                  }}
                  onLocalLinkClick={(href) => {
                    openFileInInternalTab(href);
                  }}
                  liveAssistantTurn={
                    showLiveAssistantTurn
                      ? {
                          text: liveAssistantText,
                          tone: "default",
                          segments: renderedLiveAssistantSegments,
                          executionItems: liveExecutionItems,
                          status:
                            liveAgentStatus ||
                            (isResponding ? "Working" : ""),
                        }
                      : null
                  }
                />
              ) : (
                <div className="rounded-md border border-dashed border-border/55 bg-background/35 px-4 py-5 text-[12px] text-foreground/48">
                  No activity yet. Run traces and replies will appear here.
                </div>
              )}
            </div>

            <div className="max-w-3xl space-y-2">
              <form onSubmit={handleSubmitReply} className="space-y-2">
                {replyAttachmentItems.length > 0 ? (
                  <AttachmentList
                    attachments={replyAttachmentItems}
                    onPreview={handlePreviewAttachment}
                    onRemove={(attachmentId) => {
                      setReplyAttachments((current) =>
                        current.filter(
                          (file) =>
                            `${file.name}:${file.size}:${file.lastModified}` !==
                            attachmentId,
                        ),
                      );
                    }}
                  />
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleReplyAttachmentChange}
                />
                <div className="rounded-lg border border-border bg-background/55 transition-colors focus-within:border-foreground/20">
                  <Textarea
                    ref={replyTextareaRef}
                    value={replyInput}
                    onChange={(event) => setReplyInput(event.target.value)}
                    placeholder={replyDisabledReason || "Reply…"}
                    disabled={
                      Boolean(replyDisabledReason) || isReplySubmitting
                    }
                    className="min-h-[80px] resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] shadow-none focus-visible:ring-0"
                  />
                  <div className="flex items-center justify-between gap-3 border-t border-border/55 px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-foreground/40">
                      <MessageSquareText className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {replyDisabledReason ||
                          "Continues the same issue thread"}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Attach files"
                        disabled={
                          Boolean(replyDisabledReason) || isReplySubmitting
                        }
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Paperclip className="size-3.5" />
                      </Button>
                      <Button
                        type="submit"
                        size="icon-sm"
                        aria-label="Send reply"
                        disabled={
                          Boolean(replyDisabledReason) ||
                          isReplySubmitting ||
                          (!replyInput.trim() &&
                            replyAttachments.length === 0)
                        }
                      >
                        {isReplySubmitting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Send className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
                {replyError ? (
                  <div className="text-[12px] text-destructive">
                    {replyError}
                  </div>
                ) : null}
              </form>
            </div>
          </article>

          <aside className="space-y-5 xl:sticky xl:top-0 xl:self-start xl:border-l xl:border-border/55 xl:pl-6">
            <Field label="Status">
              <div className="flex items-center gap-2.5">
                <StatusDot
                  variant={issueStatusVariant(issue.status)}
                  pulse={Boolean(issue.active_subagent_id)}
                />
                <span className="truncate text-foreground/85">
                  {issueActivityLabel(issue)}
                </span>
                {issue.active_subagent_id ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => void handleStopIssueRun()}
                    disabled={isMutationPending}
                  >
                    <Square className="size-3" />
                    Stop
                  </Button>
                ) : isResumableBlocker ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 border-amber-500/30 bg-amber-500/10 px-2 text-[11px] text-amber-800 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-100 dark:hover:text-amber-100"
                    onClick={() => void handleResumeIssueRun()}
                    disabled={isMutationPending}
                  >
                    <Play className="size-3" />
                    Resume
                  </Button>
                ) : null}
              </div>
            </Field>

            <Field label="Priority">
              {issue.priority ? (
                <span className="text-foreground/85">
                  {issue.priority.slice(0, 1).toUpperCase() +
                    issue.priority.slice(1)}
                </span>
              ) : (
                <span className="text-foreground/35">None</span>
              )}
            </Field>

            <Field label="Assignee">
              <div className="flex items-center gap-2">
                <div className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-[10px] font-semibold text-foreground/55">
                  {(assignee?.name || "?").trim().slice(0, 1).toUpperCase()}
                </div>
                <span className="min-w-0 truncate text-foreground/85">
                  {assignee?.name || (
                    <span className="text-foreground/35">Unassigned</span>
                  )}
                </span>
              </div>
            </Field>

            {parentIssue ? (
              <Field label="Parent">
                <button
                  type="button"
                  onClick={() => openRelatedIssue(parentIssue)}
                  className="inline-flex min-w-0 items-center gap-1.5 text-foreground/85 transition-colors hover:text-foreground"
                  title={parentIssue.title}
                >
                  <span className="shrink-0 font-mono text-[11px] text-foreground/50">
                    {parentIssue.issue_id}
                  </span>
                  <span className="truncate">{parentIssue.title}</span>
                </button>
              </Field>
            ) : null}

            {childIssues.length > 0 ? (
              <Field label="Sub-issues">
                <span className="text-foreground/85">{childIssues.length}</span>
              </Field>
            ) : null}

            <Field label="Created">
              <span title={formatCalendarLabel(issue.created_at)}>
                {formatRelativeTime(issue.created_at)}
              </span>
            </Field>
            <Field label="Updated">
              <span title={formatCalendarLabel(issue.updated_at)}>
                {formatRelativeTime(issue.updated_at)}
              </span>
            </Field>
            {issue.completed_at ? (
              <Field label="Completed">
                <span title={formatCalendarLabel(issue.completed_at)}>
                  {formatRelativeTime(issue.completed_at)}
                </span>
              </Field>
            ) : null}

            <Field label="Session">
              <span className="font-mono text-[12px] text-foreground/65">
                {shortSessionLabel(issue.session_id)}
              </span>
            </Field>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 text-[12px]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/40">
        {label}
      </div>
      <div className="min-w-0 text-foreground/75">{children}</div>
    </div>
  );
}

