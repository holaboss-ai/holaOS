import { Loader2, Square, UserRound } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";

type VisibleBoardStatus = Exclude<IssueStatusPayload, "backlog">;

function isVisibleBoardStatus(
  status: IssueStatusPayload,
): status is VisibleBoardStatus {
  return status !== "backlog";
}

const BOARD_STATUS_ORDER: VisibleBoardStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

const BOARD_COLUMN_CHROME: Record<
  VisibleBoardStatus,
  {
    shellClass: string;
    headerClass: string;
    emptyClass: string;
  }
> = {
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
  const [pendingIssueId, setPendingIssueId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.status !== "backlog"),
    [issues],
  );

  const issuesByStatus = useMemo(() => {
    const groups = Object.fromEntries(
      BOARD_STATUS_ORDER.map((status) => [status, [] as IssueRecordPayload[]]),
    ) as Record<VisibleBoardStatus, IssueRecordPayload[]>;
    for (const issue of visibleIssues) {
      if (isVisibleBoardStatus(issue.status)) {
        groups[issue.status].push(issue);
      }
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
  }, [visibleIssues]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          <span>Issues</span>
        </div>
      </div>

      {errorMessage || statusMessage ? (
        <div className="border-b border-border px-6 py-3">
          <div className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
            {errorMessage || statusMessage}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-6 py-4">
        {isLoading && visibleIssues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-foreground/35" />
          </div>
        ) : (
          <div className="flex h-full min-h-full min-w-full items-stretch gap-5 pb-3">
            {BOARD_STATUS_ORDER.map((status) => {
              const tone = BOARD_COLUMN_CHROME[status];
              const columnIssues = issuesByStatus[status];
              const isCollapsed = columnIssues.length === 0;
              return (
                <section
                  key={status}
                  className={cn(
                    "flex h-full min-h-0 min-w-0 self-stretch flex-col overflow-hidden rounded-2xl border transition-[flex-grow,flex-basis,background-color,border-color] duration-200",
                    isCollapsed
                      ? "min-w-[128px] flex-[1_1_0%]"
                      : "min-w-[320px] flex-[3_1_0%]",
                    tone.shellClass,
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center border-b py-3",
                      isCollapsed
                        ? "justify-start px-4"
                        : "justify-between gap-3 px-4",
                      tone.headerClass,
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusDot
                        variant={issueStatusVariant(status)}
                        pulse={status === "in_progress"}
                      />
                      {isCollapsed ? (
                        <div className="flex min-w-0 items-baseline gap-2">
                          <h2
                            className="truncate text-[14px] font-semibold text-foreground"
                            title={issueStatusLabel(status)}
                          >
                            {issueStatusLabel(status)}
                          </h2>
                          <span className="shrink-0 text-xs text-foreground/45">
                            {columnIssues.length}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-baseline gap-2">
                          <h2 className="text-[15px] font-semibold text-foreground">
                            {issueStatusLabel(status)}
                          </h2>
                          <span className="text-xs text-foreground/45">
                            {columnIssues.length}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "flex min-h-0 flex-1 overflow-y-auto",
                      isCollapsed ? "px-2 py-2.5" : "flex-col gap-3 px-3 py-3",
                    )}
                  >
                    {columnIssues.length === 0 ? (
                      <div
                        className={cn(
                          "min-h-[220px] flex-1 rounded-xl border",
                          tone.emptyClass,
                        )}
                        aria-label={`${issueStatusLabel(status)} column empty`}
                      />
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
                            className={cn(
                              "group rounded-xl border border-border/80 bg-background/92 px-3.5 py-3 shadow-sm transition duration-snappy hover:border-foreground/10 hover:bg-background",
                              running && "ring-1 ring-primary/30",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2.5">
                              <button
                                type="button"
                                onClick={() => openIssueDetail(issue)}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="flex flex-wrap items-center gap-2 text-[11px] text-foreground/40">
                                  <span className="font-medium uppercase tracking-[0.14em]">
                                    {issue.issue_id}
                                  </span>
                                  {issue.priority ? (
                                    <span
                                      className={cn(
                                        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                        issuePriorityBadgeClass(issue.priority),
                                      )}
                                    >
                                      {issuePriorityLabel(issue.priority)}
                                    </span>
                                  ) : null}
                                  {running ? (
                                    <span className="rounded-full border border-primary/16 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                      Working
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-2 line-clamp-1 text-[15px] font-semibold leading-5 text-foreground">
                                  {issue.title || "Untitled issue"}
                                </div>
                                {issue.parent_issue_id ? (
                                  <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-foreground/38">
                                    Sub-issue of {issue.parent_issue_id}
                                  </div>
                                ) : null}
                                {issue.description ? (
                                  <div className="mt-1.5 line-clamp-1 text-[13px] leading-5 text-foreground/52">
                                    {issue.description}
                                  </div>
                                ) : null}
                                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/45">
                                  <span className="inline-flex min-w-0 items-center gap-1.5">
                                    <UserRound className="size-3" />
                                    <span className="truncate">{assigneeName}</span>
                                  </span>
                                  <span>Updated {issueRelativeTime(issue.updated_at)}</span>
                                </div>
                              </button>
                              {running ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 rounded-full border-border bg-background/70 px-2.5 text-[11px] hover:bg-background"
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
