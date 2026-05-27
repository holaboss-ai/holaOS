import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CircleDot,
  Loader2,
  MessageSquareText,
  Paperclip,
  PencilLine,
  Send,
  Square,
  UserRound,
} from "lucide-react";
import { AttachmentList } from "@/components/panes/ChatPane/AttachmentList";
import { ConversationTurns } from "@/components/panes/ChatPane/ConversationTurns";
import {
  chatMessagesFromSessionState,
} from "@/components/panes/ChatPane/index";
import type {
  AttachmentListItem,
  ChatMessage,
} from "@/components/panes/ChatPane/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useIssueWorkspaceData } from "./useIssues";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

const ISSUE_STATUS_OPTIONS: Array<{
  value: IssueStatusPayload;
  label: string;
  disabled?: boolean;
}> = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress", disabled: true },
  { value: "in_review", label: "In review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ISSUE_PRIORITY_OPTIONS: Array<{
  value: IssuePriorityPayload;
  label: string;
}> = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

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

export function IssueDetailPane({
  workspaceId,
  issueId,
}: {
  workspaceId: string;
  issueId: string;
}) {
  const { selectedWorkspace } = useWorkspaceDesktop();
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

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [threadRefreshToken, setThreadRefreshToken] = useState(0);
  const [collapsedTraceByStepId, setCollapsedTraceByStepId] = useState<
    Record<string, boolean>
  >({});
  const [runtimeState, setRuntimeState] =
    useState<SessionRuntimeRecordPayload | null>(null);

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
  const issueFileInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  }, [
    issue?.attachments,
    issue?.blocker_reason,
    issue?.description,
    issue?.issue_id,
    issue?.title,
  ]);

  const refreshThread = useCallback(() => {
    setThreadRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!issue) {
      setMessages([]);
      setRuntimeState(null);
      setHistoryError("");
      setIsHistoryLoading(false);
      return;
    }

    let cancelled = false;

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
        setMessages(
          chatMessagesFromSessionState({
            historyMessages: history.messages,
            outputEvents: outputEvents.items,
            outputs: outputs.items,
            showExecutionInternals: false,
            showBootstrapPhaseTrace: false,
          }),
        );
        setRuntimeState(
          runtimeStates.items.find(
            (item) => item.session_id.trim() === issue.session_id.trim(),
          ) ?? null,
        );
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

  const handleStatusChange = useCallback(
    async (nextStatus: IssueStatusPayload) => {
      if (!issue || nextStatus === issue.status) {
        return;
      }
      let blockerReason: string | null | undefined = undefined;
      if (nextStatus === "blocked") {
        const response = window.prompt(
          "Why is this issue blocked?",
          issue.blocker_reason ?? "",
        );
        if (response == null) {
          return;
        }
        const trimmed = response.trim();
        if (!trimmed) {
          setMutationError("Blocked issues need a blocker reason.");
          return;
        }
        blockerReason = trimmed;
      } else if (issue.blocker_reason) {
        blockerReason = null;
      }
      await runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
            workspace_id: workspaceId,
            status: nextStatus,
            blocker_reason: blockerReason,
          }),
        "Failed to update issue status",
      );
    },
    [issue, runIssueMutation, workspaceId],
  );

  const handleAssigneeChange = useCallback(
    async (nextTeammateId: string | null) => {
      if (!issue || (issue.assignee_teammate_id ?? null) === nextTeammateId) {
        return;
      }
      await runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
            workspace_id: workspaceId,
            assignee_teammate_id: nextTeammateId,
          }),
        "Failed to update issue assignee",
      );
    },
    [issue, runIssueMutation, workspaceId],
  );

  const handlePriorityChange = useCallback(
    async (nextPriority: IssuePriorityPayload | null) => {
      if (!issue || (issue.priority ?? null) === nextPriority) {
        return;
      }
      await runIssueMutation(
        () =>
          window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
            workspace_id: workspaceId,
            priority: nextPriority,
          }),
        "Failed to update issue priority",
      );
    },
    [issue, runIssueMutation, workspaceId],
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
        await window.electronAPI.workspace.queueSessionInput({
          workspace_id: workspaceId,
          session_id: issue.session_id,
          text,
          image_urls: [],
          attachments: stagedAttachments.attachments,
        });
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
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(245,118,66,0.06),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_32%)]">
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid gap-5">
            <Card className="bg-card/85">
              <CardHeader className="border-b">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 place-items-center rounded-2xl border border-border bg-background/75 shadow-sm">
                    <CircleDot className="size-5 text-foreground/65" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
                      {selectedWorkspace?.name || "Workspace"} / {issue.issue_id}
                    </div>
                    <CardTitle className="mt-2 text-[30px] font-semibold tracking-tight text-foreground">
                      {issue.title || issue.issue_id}
                    </CardTitle>
                    {!isEditingDetails && issue.description ? (
                      <CardDescription className="mt-2 max-w-3xl whitespace-pre-wrap text-base leading-7 text-foreground/68">
                        {issue.description}
                      </CardDescription>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="bg-background/70">
                        {issue.issue_id}
                      </Badge>
                      <Badge variant="outline" className="bg-background/70">
                        <StatusDot
                          variant={issueStatusVariant(issue.status)}
                          pulse={Boolean(issue.active_subagent_id)}
                        />
                        {issueStatusLabel(issue.status)}
                      </Badge>
                      <Badge variant="outline" className="bg-background/70">
                        <UserRound className="size-3.5" />
                        {assignee?.name || "Unassigned"}
                      </Badge>
                      {issue.priority ? (
                        <Badge variant="outline" className="bg-background/70">
                          {issue.priority.slice(0, 1).toUpperCase() +
                            issue.priority.slice(1)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
                <CardAction>
                  <div className="flex items-center gap-2">
                    {!isEditingDetails ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setMutationError("");
                          setIsEditingDetails(true);
                        }}
                        disabled={Boolean(issue.active_subagent_id) || isMutationPending}
                      >
                        <PencilLine className="size-4" />
                        Edit details
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setDraftTitle(issue.title);
                            setDraftDescription(issue.description ?? "");
                            setDraftBlockerReason(issue.blocker_reason ?? "");
                            setDraftIssueAttachments(
                              issueAttachmentsToListItems(issue.attachments ?? []),
                            );
                            setMutationError("");
                            setIsEditingDetails(false);
                          }}
                          disabled={isMutationPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          onClick={() => void handleSaveDetails()}
                          disabled={isMutationPending}
                        >
                          {isMutationPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          Save
                        </Button>
                      </>
                    )}
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                {isEditingDetails ? (
                  <div className="grid gap-3">
                    <Input
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="Issue title"
                      className="h-11 max-w-3xl bg-background/75"
                    />
                    <Textarea
                      value={draftDescription}
                      onChange={(event) => setDraftDescription(event.target.value)}
                      placeholder="Add description..."
                      className="min-h-[140px] max-w-3xl resize-y bg-background/75"
                    />
                    {issue.status === "blocked" ? (
                      <Textarea
                        value={draftBlockerReason}
                        onChange={(event) =>
                          setDraftBlockerReason(event.target.value)
                        }
                        placeholder="Why is this issue blocked?"
                        className="min-h-[96px] max-w-3xl resize-y bg-background/75"
                      />
                    ) : null}
                    <div className="max-w-3xl">
                      <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
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
                        <div className="rounded-xl border border-dashed border-border bg-background/45 px-4 py-6 text-sm text-foreground/48">
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
                      <div className="mt-3">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => issueFileInputRef.current?.click()}
                        >
                          <Paperclip className="size-4" />
                          Add attachments
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : issueAttachmentItems.length > 0 ? (
                  <div className="flex max-w-3xl flex-wrap gap-2">
                    {issueAttachmentItems.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        onClick={() =>
                          attachment.workspace_path
                            ? openFileInInternalTab(attachment.workspace_path)
                            : undefined
                        }
                        className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1.5 text-sm text-foreground/72 transition-colors hover:bg-background"
                      >
                        <Paperclip className="size-3.5 shrink-0 text-foreground/45" />
                        <span className="truncate">{attachment.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {statusMessage || mutationError ? (
                  <div className="rounded-xl border border-border bg-background/65 px-3 py-2 text-xs text-foreground/62">
                    {mutationError || statusMessage}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {issue.active_subagent_id ? (
              <Card className="bg-card/85">
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-sky-500/18 bg-sky-500/[0.06] px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-8 place-items-center rounded-full bg-sky-500/12 text-sky-600 dark:text-sky-200">
                        <Loader2 className="size-4 animate-spin" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {(assignee?.name || "Assigned teammate")} is working
                        </div>
                        <div className="mt-0.5 text-xs text-foreground/55">
                          {formatRelativeTime(runtimeState?.updated_at || issue.updated_at)}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleStopIssueRun()}
                      disabled={isMutationPending}
                    >
                      {isMutationPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Square className="size-4" />
                      )}
                      Stop
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle className="text-[24px] font-semibold tracking-tight text-foreground">
                  Activity
                </CardTitle>
                <CardDescription>
                  The full issue thread stays in this page and continues across reruns.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border border-border bg-background/65 px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="grid size-8 place-items-center rounded-full bg-foreground/[0.06] text-foreground/55">
                      <CircleDot className="size-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {(issue.created_by || "Workspace user").trim() || "Workspace user"} created this issue
                      </div>
                      <div className="mt-1 text-xs text-foreground/45">
                        {formatRelativeTime(issue.created_at)}
                      </div>
                    </div>
                  </div>
                </div>

                {historyError ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/[0.05] px-4 py-3 text-sm text-destructive">
                    {historyError}
                  </div>
                ) : null}

                {isHistoryLoading && messages.length === 0 ? (
                  <div className="grid h-24 place-items-center">
                    <Loader2 className="size-5 animate-spin text-foreground/35" />
                  </div>
                ) : messages.length > 0 ? (
                  <ConversationTurns
                    messages={messages}
                    assistantLabel={assignee?.name || "Assigned teammate"}
                    assistantMode="issue"
                    showExecutionInternals={false}
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
                  />
                ) : (
                  <div className="rounded-xl border border-dashed border-border bg-background/45 px-6 py-8 text-center">
                    <div className="text-sm font-medium text-foreground">
                      No replies yet
                    </div>
                    <div className="mt-1 text-sm text-foreground/52">
                      The issue thread will appear here once the assigned teammate or user responds.
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle className="text-base text-foreground">Reply</CardTitle>
                <CardDescription>
                  Replies here continue the same issue thread.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <form onSubmit={handleSubmitReply} className="space-y-3">
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
                  <div className="rounded-xl border border-border bg-background/65 px-4 py-3">
                    <Textarea
                      value={replyInput}
                      onChange={(event) => setReplyInput(event.target.value)}
                      placeholder={replyDisabledReason || "Leave a comment..."}
                      disabled={Boolean(replyDisabledReason) || isReplySubmitting}
                      className="min-h-[112px] resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                      <div className="flex min-w-0 items-center gap-2 text-xs text-foreground/45">
                        <span className="inline-flex items-center gap-1.5">
                          <MessageSquareText className="size-3.5" />
                          Replies here continue the same issue thread.
                        </span>
                        {replyDisabledReason ? (
                          <span className="truncate text-destructive">
                            {replyDisabledReason}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          aria-label="Attach files"
                          disabled={Boolean(replyDisabledReason) || isReplySubmitting}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip className="size-4" />
                        </Button>
                        <Button
                          type="submit"
                          size="icon-sm"
                          aria-label="Send reply"
                          disabled={
                            Boolean(replyDisabledReason) ||
                            isReplySubmitting ||
                            (!replyInput.trim() && replyAttachments.length === 0)
                          }
                        >
                          {isReplySubmitting ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                  {replyError ? (
                    <div className="text-sm text-destructive">{replyError}</div>
                  ) : null}
                </form>
              </CardContent>
            </Card>
          </div>

          <aside className="grid content-start gap-5 xl:sticky xl:top-0">
            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle>Properties</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <PropertyRow label="Status">
                  <Select
                    value={issue.status}
                    onValueChange={(value) => {
                      if (!value) return;
                      void handleStatusChange(value as IssueStatusPayload);
                    }}
                    disabled={Boolean(issue.active_subagent_id) || isMutationPending}
                  >
                    <SelectTrigger className="h-10 w-full bg-background text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {ISSUE_STATUS_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          disabled={option.disabled}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </PropertyRow>

                <PropertyRow label="Assignee">
                  <Select
                    value={issue.assignee_teammate_id ?? "__unassigned__"}
                    onValueChange={(value) => {
                      if (!value) return;
                      void handleAssigneeChange(
                        value === "__unassigned__" ? null : value,
                      );
                    }}
                    disabled={Boolean(issue.active_subagent_id) || isMutationPending}
                  >
                    <SelectTrigger className="h-10 w-full bg-background text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="__unassigned__">Unassigned</SelectItem>
                      {teammates.map((teammate) => (
                        <SelectItem
                          key={teammate.teammate_id}
                          value={teammate.teammate_id}
                        >
                          {teammate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </PropertyRow>

                <PropertyRow label="Priority">
                  <Select
                    value={issue.priority ?? "__none__"}
                    onValueChange={(value) => {
                      if (!value) return;
                      void handlePriorityChange(
                        value === "__none__"
                          ? null
                          : (value as IssuePriorityPayload),
                      );
                    }}
                    disabled={Boolean(issue.active_subagent_id) || isMutationPending}
                  >
                    <SelectTrigger className="h-10 w-full bg-background text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="__none__">No priority</SelectItem>
                      {ISSUE_PRIORITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </PropertyRow>
              </CardContent>
            </Card>

            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-foreground/62">
                <DetailLine
                  label="Created by"
                  value={(issue.created_by || "Workspace user").trim() || "Workspace user"}
                />
                <DetailLine
                  label="Created"
                  value={formatCalendarLabel(issue.created_at)}
                />
                <DetailLine
                  label="Updated"
                  value={formatCalendarLabel(issue.updated_at)}
                />
                <DetailLine
                  label="Completed"
                  value={formatCalendarLabel(issue.completed_at)}
                />
              </CardContent>
            </Card>

            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle>Execution log</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-xl border border-border bg-background/70 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <StatusDot
                          variant={issueStatusVariant(issue.status)}
                          pulse={Boolean(issue.active_subagent_id)}
                        />
                        <span className="truncate">{issueActivityLabel(issue)}</span>
                      </div>
                      <div className="mt-1 text-xs text-foreground/45">
                        {issue.active_subagent_id
                          ? `${assignee?.name || "Assigned teammate"} is working`
                          : issue.completed_at
                            ? `Last completed ${formatRelativeTime(issue.completed_at)}`
                            : `Updated ${formatRelativeTime(issue.updated_at)}`}
                      </div>
                    </div>
                    {issue.active_subagent_id ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleStopIssueRun()}
                        disabled={isMutationPending}
                      >
                        Stop
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card/85">
              <CardHeader>
                <CardTitle>Session</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-foreground/58">
                  <div className="flex items-center gap-2">
                    <UserRound className="size-4 text-foreground/45" />
                    <span className="truncate">{assignee?.name || "Unassigned"}</span>
                  </div>
                  <div className="mt-2 text-xs text-foreground/42">
                    Session {issue.session_id.slice(0, 12)}
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-foreground/38">
        {label}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function DetailLine({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-foreground/42">{label}</span>
      <span className="text-right text-foreground/75">{value || "—"}</span>
    </div>
  );
}
