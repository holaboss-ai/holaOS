import { useSetAtom } from "jotai";
import { Loader2, Plus, RotateCw, Square, UserRound } from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { newIssueOpenAtom } from "./state/ui";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";

const BOARD_STATUS_ORDER: IssueStatusPayload[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

const BOARD_COLUMN_CHROME: Record<
  IssueStatusPayload,
  {
    shellClass: string;
    headerClass: string;
    emptyClass: string;
  }
> = {
  backlog: {
    shellClass: "border-border bg-card/88 shadow-sm backdrop-blur-sm",
    headerClass: "border-border bg-background/60",
    emptyClass: "border-border/80 bg-background/40 text-foreground/48",
  },
  todo: {
    shellClass: "border-sky-500/16 bg-sky-500/[0.04] shadow-sm backdrop-blur-sm",
    headerClass: "border-sky-500/14 bg-sky-500/[0.06]",
    emptyClass: "border-sky-500/16 bg-background/45 text-foreground/48",
  },
  in_progress: {
    shellClass: "border-amber-500/18 bg-amber-500/[0.06] shadow-sm backdrop-blur-sm",
    headerClass: "border-amber-500/18 bg-amber-500/[0.11]",
    emptyClass:
      "border-amber-500/18 bg-background/45 text-amber-700/78 dark:text-amber-200/70",
  },
  in_review: {
    shellClass:
      "border-emerald-500/18 bg-emerald-500/[0.055] shadow-sm backdrop-blur-sm",
    headerClass: "border-emerald-500/18 bg-emerald-500/[0.1]",
    emptyClass:
      "border-emerald-500/18 bg-background/45 text-emerald-700/78 dark:text-emerald-200/70",
  },
  blocked: {
    shellClass:
      "border-orange-500/18 bg-orange-500/[0.055] shadow-sm backdrop-blur-sm",
    headerClass: "border-orange-500/18 bg-orange-500/[0.1]",
    emptyClass:
      "border-orange-500/18 bg-background/45 text-orange-700/78 dark:text-orange-200/70",
  },
  done: {
    shellClass: "border-sky-500/18 bg-sky-500/[0.055] shadow-sm backdrop-blur-sm",
    headerClass: "border-sky-500/18 bg-sky-500/[0.1]",
    emptyClass:
      "border-sky-500/18 bg-background/45 text-sky-700/78 dark:text-sky-200/70",
  },
};

function issueRelativeTime(value: string): string {
  const ms = Date.now() - Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function issueStatusLabel(status: IssueStatusPayload): string {
  switch (status) {
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
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

function issuePriorityLabel(priority: IssuePriorityPayload | null): string {
  if (!priority) return "None";
  return priority.slice(0, 1).toUpperCase() + priority.slice(1);
}

function issuePriorityRank(priority: IssuePriorityPayload | null): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function issuePriorityBadgeClass(priority: IssuePriorityPayload | null): string {
  switch (priority) {
    case "critical":
      return "border-red-500/18 bg-red-500/10 text-red-700 dark:text-red-200";
    case "high":
      return "border-orange-500/18 bg-orange-500/10 text-orange-700 dark:text-orange-200";
    case "medium":
      return "border-amber-500/18 bg-amber-500/10 text-amber-800 dark:text-amber-200";
    case "low":
      return "border-slate-500/18 bg-slate-500/10 text-slate-700 dark:text-slate-300";
    default:
      return "border-border bg-background/70 text-foreground/55";
  }
}

export function IssuesBoardPane({ workspaceId }: { workspaceId: string }) {
  const { setSelectedWorkspaceId } = useWorkspaceSelection();
  const { issues, teammatesById, isLoading, statusMessage, refresh } =
    useIssueWorkspaceData(workspaceId);
  const openIssueDetailTab = useOpenIssueDetailTab();
  const setNewIssueOpen = useSetAtom(newIssueOpenAtom);
  const [pendingIssueId, setPendingIssueId] = useState("");
  const [draggedIssueId, setDraggedIssueId] = useState("");
  const [dropTargetStatus, setDropTargetStatus] =
    useState<IssueStatusPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const workingCount = useMemo(
    () =>
      issues.filter(
        (issue) => issue.status === "in_progress" || Boolean(issue.active_subagent_id),
      ).length,
    [issues],
  );

  const issuesByStatus = useMemo(() => {
    const groups = Object.fromEntries(
      BOARD_STATUS_ORDER.map((status) => [status, [] as IssueRecordPayload[]]),
    ) as Record<IssueStatusPayload, IssueRecordPayload[]>;
    for (const issue of issues) {
      groups[issue.status].push(issue);
    }
    for (const status of BOARD_STATUS_ORDER) {
      groups[status].sort((left, right) => {
        const priorityDelta =
          issuePriorityRank(left.priority) - issuePriorityRank(right.priority);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return right.updated_at.localeCompare(left.updated_at);
      });
    }
    return groups;
  }, [issues]);

  const issuesById = useMemo(
    () => Object.fromEntries(issues.map((issue) => [issue.issue_id, issue])),
    [issues],
  );

  const openIssueDetail = useCallback(
    (issue: IssueRecordPayload) => {
      setSelectedWorkspaceId(workspaceId);
      void openIssueDetailTab({
        workspaceId: issue.workspace_id,
        issueId: issue.issue_id,
        title: issue.title,
      });
    },
    [openIssueDetailTab, setSelectedWorkspaceId, workspaceId],
  );

  const mutateIssue = useCallback(
    async (
      issueId: string,
      action: () => Promise<unknown>,
      fallbackMessage: string,
    ) => {
      setPendingIssueId(issueId);
      setErrorMessage("");
      try {
        await action();
        await refresh();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : fallbackMessage);
      } finally {
        setPendingIssueId("");
      }
    },
    [refresh],
  );

  const handleStatusChange = useCallback(
    async (issue: IssueRecordPayload, nextStatus: string) => {
      if (!nextStatus || nextStatus === issue.status) return;
      if (issue.active_subagent_id) return;
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
          setErrorMessage("Blocked issues need a blocker reason.");
          return;
        }
        blockerReason = trimmed;
      } else if (issue.blocker_reason) {
        blockerReason = null;
      }
      await mutateIssue(
        issue.issue_id,
        () =>
          window.electronAPI.workspace.updateIssue(workspaceId, issue.issue_id, {
            workspace_id: workspaceId,
            status: nextStatus as IssueStatusPayload,
            blocker_reason: blockerReason,
          }),
        "Failed to update issue status",
      );
    },
    [mutateIssue, workspaceId],
  );

  const handleStopIssue = useCallback(
    async (issue: IssueRecordPayload) => {
      if (!issue.active_subagent_id) return;
      if (!window.confirm(`Stop ${issue.issue_id}?`)) {
        return;
      }
      await mutateIssue(
        issue.issue_id,
        () => window.electronAPI.workspace.stopIssueRun(workspaceId, issue.issue_id),
        "Failed to stop issue run",
      );
    },
    [mutateIssue, workspaceId],
  );

  const canDropIssueToStatus = useCallback(
    (issue: IssueRecordPayload | null, nextStatus: IssueStatusPayload) => {
      if (!issue) return false;
      if (issue.active_subagent_id) return false;
      if (pendingIssueId === issue.issue_id) return false;
      if (nextStatus === "in_progress") return false;
      return nextStatus !== issue.status;
    },
    [pendingIssueId],
  );

  const handleCardDragStart = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, issue: IssueRecordPayload) => {
      if (issue.active_subagent_id || pendingIssueId === issue.issue_id) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", issue.issue_id);
      setDraggedIssueId(issue.issue_id);
      setDropTargetStatus(null);
    },
    [pendingIssueId],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggedIssueId("");
    setDropTargetStatus(null);
  }, []);

  const handleColumnDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, status: IssueStatusPayload) => {
      const issueId = draggedIssueId || event.dataTransfer.getData("text/plain");
      const issue = issueId ? issuesById[issueId] ?? null : null;
      if (!canDropIssueToStatus(issue, status)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropTargetStatus !== status) {
        setDropTargetStatus(status);
      }
    },
    [canDropIssueToStatus, draggedIssueId, dropTargetStatus, issuesById],
  );

  const handleColumnDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>, status: IssueStatusPayload) => {
      const issueId = draggedIssueId || event.dataTransfer.getData("text/plain");
      const issue = issueId ? issuesById[issueId] ?? null : null;
      setDropTargetStatus(null);
      setDraggedIssueId("");
      if (!canDropIssueToStatus(issue, status) || !issue) {
        return;
      }
      event.preventDefault();
      await handleStatusChange(issue, status);
    },
    [canDropIssueToStatus, draggedIssueId, handleStatusChange, issuesById],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          <span>Agent Team</span>
          <span className="text-foreground/20">/</span>
          <span>Issues</span>
        </div>
      </div>

      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-xl border border-border bg-card px-4 text-sm font-medium text-foreground shadow-sm"
            >
              All
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground/62 transition-colors hover:bg-card"
            >
              Members
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground/62 transition-colors hover:bg-card"
            >
              Agents
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge variant="outline" className="h-9 rounded-xl bg-background px-3 text-foreground/65">
              {workingCount} working
            </Badge>
            <Badge variant="outline" className="h-9 rounded-xl bg-background px-3 text-foreground/65">
              {issues.length} issues
            </Badge>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl px-3"
              onClick={() => void refresh()}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Refresh
            </Button>
            <Button
              type="button"
              className="h-9 rounded-xl px-4"
              onClick={() => setNewIssueOpen(true)}
            >
              <Plus className="size-4" />
              New issue
            </Button>
          </div>
        </div>
        {errorMessage || statusMessage ? (
          <div className="mt-3 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
            {errorMessage || statusMessage}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-6 py-4">
        {isLoading && issues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-foreground/35" />
          </div>
        ) : (
          <div className="flex min-h-full min-w-max gap-5 pb-3">
            {BOARD_STATUS_ORDER.map((status) => {
              const tone = BOARD_COLUMN_CHROME[status];
              const columnIssues = issuesByStatus[status];
              return (
                <section
                  key={status}
                  className={cn(
                    "flex h-full w-[330px] shrink-0 flex-col overflow-hidden rounded-2xl border transition-colors",
                    tone.shellClass,
                    dropTargetStatus === status &&
                      "ring-2 ring-primary/35 ring-offset-2 ring-offset-background",
                  )}
                  onDragOver={(event) => handleColumnDragOver(event, status)}
                  onDrop={(event) => void handleColumnDrop(event, status)}
                  onDragLeave={(event) => {
                    if (
                      dropTargetStatus === status &&
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      setDropTargetStatus(null);
                    }
                  }}
                >
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 border-b px-4 py-3",
                      tone.headerClass,
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusDot
                        variant={issueStatusVariant(status)}
                        pulse={status === "in_progress"}
                      />
                      <div className="flex items-baseline gap-2">
                        <h2 className="text-[15px] font-semibold text-foreground">
                          {issueStatusLabel(status)}
                        </h2>
                        <span className="text-xs text-foreground/45">
                          {columnIssues.length}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex min-h-[220px] flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
                    {columnIssues.length === 0 ? (
                      <div
                        className={cn(
                          "grid min-h-[148px] place-items-center rounded-xl border border-dashed text-sm",
                          tone.emptyClass,
                        )}
                      >
                        No issues
                      </div>
                    ) : (
                      columnIssues.map((issue) => {
                        const pending = pendingIssueId === issue.issue_id;
                        const running = Boolean(issue.active_subagent_id);
                        const assigneeName =
                          issue.assignee_teammate_id == null
                            ? "Unassigned"
                            : (teammatesById[issue.assignee_teammate_id]?.name ??
                                "Assigned");
                        return (
                          <div
                            key={issue.issue_id}
                            draggable={!running && !pending}
                            onDragStart={(event) => handleCardDragStart(event, issue)}
                            onDragEnd={handleCardDragEnd}
                            className={cn(
                              "group rounded-xl border border-border bg-background/88 p-4 shadow-sm transition duration-snappy hover:border-foreground/12 hover:bg-background",
                              running && "ring-1 ring-primary/30",
                              !running &&
                                !pending &&
                                "cursor-grab active:cursor-grabbing",
                              draggedIssueId === issue.issue_id && "opacity-55",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <button
                                type="button"
                                onClick={() => openIssueDetail(issue)}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="flex flex-wrap items-center gap-2 text-[11px] text-foreground/42">
                                  <span className="font-medium uppercase tracking-[0.16em]">
                                    {issue.issue_id}
                                  </span>
                                  <span
                                    className={cn(
                                      "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                      issuePriorityBadgeClass(issue.priority),
                                    )}
                                  >
                                    {issuePriorityLabel(issue.priority)}
                                  </span>
                                  {running ? (
                                    <span className="rounded-full border border-primary/20 bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary">
                                      Working
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-2 line-clamp-2 text-[16px] font-semibold leading-5 text-foreground">
                                  {issue.title || "Untitled issue"}
                                </div>
                                {issue.description ? (
                                  <div className="mt-3 line-clamp-3 text-sm leading-5 text-foreground/58">
                                    {issue.description}
                                  </div>
                                ) : null}
                                {issue.blocker_reason ? (
                                  <div className="mt-3 rounded-xl border border-orange-500/18 bg-orange-500/[0.1] px-3 py-2 text-xs leading-5 text-orange-800 dark:text-orange-100/85">
                                    {issue.blocker_reason}
                                  </div>
                                ) : null}

                            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-foreground/45">
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-1">
                                <UserRound className="size-3" />
                                {assigneeName}
                              </span>
                              <span className="rounded-full border border-border bg-background/70 px-2.5 py-1">
                                Updated {issueRelativeTime(issue.updated_at)}
                              </span>
                              {!running ? (
                                <span className="rounded-full border border-dashed border-border bg-background/70 px-2.5 py-1 text-foreground/40">
                                  Drag to move
                                </span>
                              ) : null}
                            </div>
                              </button>
                              {running ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8 rounded-full border-border bg-background/70 px-3 hover:bg-background"
                                  onClick={() => void handleStopIssue(issue)}
                                  disabled={pending}
                                >
                                  <Square className="size-3.5" />
                                  Stop
                                </Button>
                              ) : null}
                            </div>

                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
