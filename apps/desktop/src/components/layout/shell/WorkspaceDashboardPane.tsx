import { Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";

const PRIORITY_ORDER: IssuePriorityPayload[] = [
  "critical",
  "high",
  "medium",
  "low",
];

const STATUS_ORDER: IssueStatusPayload[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

const DAY_WINDOW = 14;

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

function issuePriorityLabel(priority: IssuePriorityPayload): string {
  return priority.slice(0, 1).toUpperCase() + priority.slice(1);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenUsageNumber(
  usage: Record<string, unknown> | null | undefined,
  keys: string[],
): number {
  if (!usage) {
    return 0;
  }
  for (const key of keys) {
    const direct = finiteNumber(usage[key]);
    if (direct !== null) {
      return direct;
    }
  }
  return 0;
}

function turnResultTimestamp(result: SessionTurnResultPayload): string {
  return (
    result.completed_at?.trim() ||
    result.started_at?.trim() ||
    result.updated_at?.trim() ||
    result.created_at
  );
}

function toMillis(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isSuccessfulTurn(status: string): boolean {
  return status.trim().toLowerCase() === "completed";
}

function isFailedTurn(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function formatCompactNumber(value: number): string {
  if (value === 0) {
    return "0";
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value < 100 ? 1 : 0,
  }).format(value);
}

function dayKey(value: string): string {
  return value.slice(0, 10);
}

function dayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function windowDayKeys(days: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let index = days - 1; index >= 0; index -= 1) {
    const current = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    current.setUTCDate(current.getUTCDate() - index);
    keys.push(current.toISOString().slice(0, 10));
  }
  return keys;
}

function buildDailyBars(
  results: SessionTurnResultPayload[],
  options: {
    valueForDay: (items: SessionTurnResultPayload[]) => number;
    color: string;
  },
) {
  const days = windowDayKeys(DAY_WINDOW);
  const grouped = new Map<string, SessionTurnResultPayload[]>();
  for (const result of results) {
    const key = dayKey(turnResultTimestamp(result));
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(result);
    } else {
      grouped.set(key, [result]);
    }
  }
  return days.map((key, index) => ({
    key,
    label:
      index === 0 || index === Math.floor(days.length / 2) || index === days.length - 1
        ? dayLabel(key)
        : "",
    value: options.valueForDay(grouped.get(key) ?? []),
    color: options.color,
  }));
}

function shortIssueId(issueId: string): string {
  const normalized = issueId.trim();
  return normalized || "Issue";
}

function activityTone(
  status: string,
): "success" | "warning" | "primary" | "muted" {
  if (isSuccessfulTurn(status)) {
    return "success";
  }
  if (isFailedTurn(status)) {
    return "warning";
  }
  const normalized = status.trim().toLowerCase();
  if (normalized === "waiting_user" || normalized === "paused") {
    return "primary";
  }
  return "muted";
}

function activityLabel(
  status: string,
  teammateName: string,
  issueId: string,
): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed") {
    return `${teammateName} completed ${issueId}`;
  }
  if (normalized === "failed" || normalized === "error") {
    return `${teammateName} failed ${issueId}`;
  }
  if (normalized === "waiting_user") {
    return `${teammateName} is waiting on ${issueId}`;
  }
  if (normalized === "paused") {
    return `${teammateName} paused ${issueId}`;
  }
  return `${teammateName} updated ${issueId}`;
}

function useWorkspaceIssueTurnResults(
  workspaceId: string,
  sessionIds: string[],
) {
  const [turnResults, setTurnResults] = useState<SessionTurnResultPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const normalizedSessionIds = useMemo(
    () => [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))],
    [sessionIds],
  );
  const sessionKey = normalizedSessionIds.join("|");

  const refresh = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!workspaceId || normalizedSessionIds.length === 0) {
        if (!signal.cancelled) {
          setTurnResults([]);
          setStatusMessage("");
          setIsLoading(false);
        }
        return;
      }

      try {
        const responses = await Promise.allSettled(
          normalizedSessionIds.map((sessionId) =>
            window.electronAPI.workspace.listTurnResults({
              workspaceId,
              sessionId,
              limit: 200,
              offset: 0,
              order: "desc",
            }),
          ),
        );
        if (signal.cancelled) {
          return;
        }
        const nextResults = responses.flatMap((response) =>
          response.status === "fulfilled" ? response.value.items : [],
        );
        nextResults.sort(
          (left, right) =>
            toMillis(turnResultTimestamp(right)) -
            toMillis(turnResultTimestamp(left)),
        );
        setTurnResults(nextResults);
        const rejected = responses.find(
          (response) => response.status === "rejected",
        );
        setStatusMessage(
          rejected && rejected.reason instanceof Error
            ? rejected.reason.message
            : "",
        );
      } catch (error) {
        if (!signal.cancelled) {
          setStatusMessage(
            error instanceof Error ? error.message : "Failed to load usage",
          );
        }
      } finally {
        if (!signal.cancelled) {
          setIsLoading(false);
        }
      }
    },
    [normalizedSessionIds, workspaceId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    setIsLoading(true);
    void refresh(signal);
    const timer = window.setInterval(() => {
      setIsLoading(true);
      void refresh(signal);
    }, 15000);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh, sessionKey, workspaceId]);

  return {
    turnResults,
    isLoading,
    statusMessage,
  };
}

export function WorkspaceDashboardPane({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const openIssueDetailTab = useOpenIssueDetailTab();
  const {
    issues,
    teammatesById,
    isLoading: isLoadingIssues,
    statusMessage: issueStatusMessage,
  } = useIssueWorkspaceData(workspaceId);

  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.status !== "backlog"),
    [issues],
  );
  const teammates = useMemo(
    () =>
      Object.values(teammatesById)
        .filter((teammate) => teammate.status === "active")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [teammatesById],
  );
  const issueSessionIds = useMemo(
    () => visibleIssues.map((issue) => issue.session_id),
    [visibleIssues],
  );
  const {
    turnResults,
    statusMessage: turnResultsStatusMessage,
  } = useWorkspaceIssueTurnResults(workspaceId, issueSessionIds);

  const recentIssueTurnResults = useMemo(() => {
    const cutoff = Date.now() - DAY_WINDOW * 24 * 60 * 60 * 1000;
    return turnResults.filter(
      (result) => toMillis(turnResultTimestamp(result)) >= cutoff,
    );
  }, [turnResults]);

  const summary = useMemo(() => {
    const statusCounts = Object.fromEntries(
      STATUS_ORDER.map((status) => [status, 0]),
    ) as Record<IssueStatusPayload, number>;
    const priorityCounts = Object.fromEntries(
      PRIORITY_ORDER.map((priority) => [priority, 0]),
    ) as Record<IssuePriorityPayload, number>;
    let todoAssignedCount = 0;
    let todoIdleCount = 0;
    let completedThisWeek = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const issue of visibleIssues) {
      statusCounts[issue.status] += 1;
      if (issue.priority) {
        priorityCounts[issue.priority] += 1;
      }
      if (issue.status === "todo") {
        if (issue.assignee_teammate_id) {
          todoAssignedCount += 1;
        } else {
          todoIdleCount += 1;
        }
      }
      if (issue.status === "done" && issue.completed_at) {
        const completedAtMs = Date.parse(issue.completed_at);
        if (!Number.isNaN(completedAtMs) && completedAtMs >= weekAgo) {
          completedThisWeek += 1;
        }
      }
    }

    for (const result of recentIssueTurnResults) {
      const usage = result.token_usage;
      const directTotal = tokenUsageNumber(usage, ["total_tokens"]);
      const directInput = tokenUsageNumber(usage, [
        "input_tokens",
        "prompt_tokens",
      ]);
      const directOutput = tokenUsageNumber(usage, [
        "output_tokens",
        "completion_tokens",
      ]);
      inputTokens += directInput;
      outputTokens += directOutput;
      totalTokens += directTotal > 0 ? directTotal : directInput + directOutput;
    }

    return {
      totalIssues: visibleIssues.length,
      activeTeammates: teammates.length,
      inProgressCount: statusCounts.in_progress,
      blockedCount: statusCounts.blocked,
      reviewCount: statusCounts.in_review,
      todoAssignedCount,
      todoIdleCount,
      completedThisWeek,
      statusCounts,
      priorityCounts,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }, [recentIssueTurnResults, teammates.length, visibleIssues]);

  const runActivityBars = useMemo(
    () =>
      buildDailyBars(recentIssueTurnResults, {
        valueForDay: (items) => items.length,
        color: "bg-emerald-400/85",
      }),
    [recentIssueTurnResults],
  );

  const priorityBars = useMemo(
    () =>
      PRIORITY_ORDER.map((priority) => ({
        key: priority,
        label:
          priority === "critical"
            ? "Critical"
            : priority === "high"
              ? "High"
              : priority === "medium"
                ? "Medium"
                : "Low",
        value: summary.priorityCounts[priority],
        color:
          priority === "critical"
            ? "bg-red-400/85"
            : priority === "high"
              ? "bg-orange-400/85"
              : priority === "medium"
                ? "bg-amber-300/85"
                : "bg-slate-400/85",
      })),
    [summary.priorityCounts],
  );

  const statusBars = useMemo(
    () =>
      STATUS_ORDER.map((status) => ({
        key: status,
        label:
          status === "in_progress"
            ? "WIP"
            : status === "in_review"
              ? "Review"
              : status === "blocked"
                ? "Blocked"
                : status === "done"
                  ? "Done"
                  : "Todo",
        value: summary.statusCounts[status],
        color:
          status === "done"
            ? "bg-emerald-400/85"
            : status === "blocked"
              ? "bg-amber-300/85"
              : status === "in_progress"
                ? "bg-violet-400/85"
                : status === "in_review"
                  ? "bg-sky-400/85"
                  : "bg-slate-400/85",
      })),
    [summary.statusCounts],
  );

  const recentTasks = useMemo(
    () =>
      [...visibleIssues]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 10),
    [visibleIssues],
  );

  const recentActivity = useMemo(() => {
    const issueBySessionId = new Map(
      visibleIssues.map((issue) => [issue.session_id, issue]),
    );
    const items = turnResults
      .map((result) => {
        const issue = issueBySessionId.get(result.session_id);
        if (!issue) {
          return null;
        }
        const teammateName = issue.assignee_teammate_id
          ? teammatesById[issue.assignee_teammate_id]?.name ?? "Teammate"
          : "Teammate";
        return {
          id: `${result.session_id}:${result.input_id}:${result.status}`,
          issueId: issue.issue_id,
          issueTitle: issue.title || "Untitled issue",
          label: activityLabel(result.status, teammateName, issue.issue_id),
          detail: result.assistant_text.trim() || issue.title || "No detail",
          timestamp: turnResultTimestamp(result),
          tone: activityTone(result.status),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 10);

    if (items.length > 0) {
      return items;
    }

    return recentTasks.slice(0, 10).map((issue) => ({
      id: issue.issue_id,
      issueId: issue.issue_id,
      issueTitle: issue.title || "Untitled issue",
      label: `Updated ${issue.issue_id}`,
      detail: issue.title || "Untitled issue",
      timestamp: issue.updated_at,
      tone: activityTone(issue.status),
    }));
  }, [recentTasks, teammatesById, turnResults, visibleIssues]);

  const dashboardStatusMessage = issueStatusMessage || turnResultsStatusMessage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          <span>Dashboard</span>
        </div>
      </div>

      {dashboardStatusMessage ? (
        <div className="border-b border-border px-6 py-3">
          <div className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
            {dashboardStatusMessage}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoadingIssues && visibleIssues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-foreground/35" />
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Agents Enabled"
                value={summary.activeTeammates}
                detail={`${summary.completedThisWeek} done this week`}
              />
              <MetricCard
                label="Tasks In Progress"
                value={summary.inProgressCount}
                detail={`${summary.blockedCount} blocked, ${summary.todoAssignedCount + summary.todoIdleCount} todo`}
              />
              <MetricCard
                label="Token Consumption"
                value={formatCompactNumber(summary.totalTokens)}
                detail={`${formatCompactNumber(summary.inputTokens)} in / ${formatCompactNumber(summary.outputTokens)} out · last 14 days`}
              />
              <MetricCard
                label="Waiting for Review"
                value={summary.reviewCount}
                detail={
                  summary.reviewCount === 0
                    ? "Nothing waiting right now"
                    : `${summary.reviewCount} task${summary.reviewCount === 1 ? "" : "s"} need review`
                }
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <MiniBarChartCard
                title="Run Activity"
                subtitle="Last 14 days"
                bars={runActivityBars}
                legend={[
                  { label: "Completed and terminal runs", color: "bg-emerald-400/85" },
                ]}
              />
              <MiniBarChartCard
                title="Issues by Priority"
                subtitle="Current board mix"
                bars={priorityBars}
                legend={PRIORITY_ORDER.map((priority, index) => ({
                  label: issuePriorityLabel(priority),
                  color: priorityBars[index]?.color ?? "bg-slate-400/85",
                }))}
              />
              <MiniBarChartCard
                title="Issues by Status"
                subtitle="Current board mix"
                bars={statusBars}
                legend={STATUS_ORDER.map((status, index) => ({
                  label: issueStatusLabel(status),
                  color: statusBars[index]?.color ?? "bg-slate-400/85",
                }))}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
              <ActivityListCard
                title="Recent Activity"
                emptyLabel="No recent activity yet"
              >
                {recentActivity.length > 0 ? (
                  recentActivity.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() =>
                        void openIssueDetailTab({
                          workspaceId,
                          issueId: entry.issueId,
                        })
                      }
                      className="flex w-full items-start justify-between gap-4 rounded-xl border border-border bg-card/70 px-4 py-3 text-left transition hover:border-foreground/15 hover:bg-card"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <StatusDot variant={entry.tone} />
                          <span className="truncate">{entry.label}</span>
                        </div>
                        <div className="mt-1 truncate text-sm text-foreground/55">
                          {entry.issueTitle}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-foreground/40">
                        {issueRelativeTime(entry.timestamp)}
                      </span>
                    </button>
                  ))
                ) : (
                  <EmptyState label="No recent activity yet" />
                )}
              </ActivityListCard>

              <ActivityListCard
                title="Recent Tasks"
                emptyLabel="No tasks yet"
              >
                {recentTasks.length > 0 ? (
                  recentTasks.map((issue) => (
                    <button
                      key={issue.issue_id}
                      type="button"
                      onClick={() =>
                        void openIssueDetailTab({
                          workspaceId: issue.workspace_id,
                          issueId: issue.issue_id,
                        })
                      }
                      className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-card/70 px-4 py-3 text-left transition hover:border-foreground/15 hover:bg-card"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-foreground/42">
                          <span>{shortIssueId(issue.issue_id)}</span>
                          {issue.assignee_teammate_id ? (
                            <span>
                              {teammatesById[issue.assignee_teammate_id]?.name ??
                                "Assigned"}
                            </span>
                          ) : (
                            <span>Unassigned</span>
                          )}
                          <span>{issueRelativeTime(issue.updated_at)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-sm font-medium text-foreground">
                          <StatusDot
                            variant={issueStatusVariant(issue.status)}
                            pulse={issue.status === "in_progress"}
                          />
                          <span className="truncate">
                            {issue.title || "Untitled issue"}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <EmptyState label="No tasks yet" />
                )}
              </ActivityListCard>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: number | string;
  detail: string;
  tone?: "default" | "success";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm",
        tone === "success" && "bg-emerald-500/6",
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-foreground/42">
        {label}
      </div>
      <div className="mt-3 text-4xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      <div className="mt-2 text-sm text-foreground/55">{detail}</div>
    </div>
  );
}

function MiniBarChartCard({
  title,
  subtitle,
  bars,
  legend,
  valueSuffix = "",
}: {
  title: string;
  subtitle: string;
  bars: Array<{ key: string; label: string; value: number; color: string }>;
  legend: Array<{ label: string; color: string }>;
  valueSuffix?: string;
}) {
  const maxValue = Math.max(1, ...bars.map((bar) => bar.value));
  const hasAny = bars.some((bar) => bar.value > 0);

  return (
    <div className="rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm">
      <div className="text-lg font-medium text-foreground">{title}</div>
      <div className="mt-1 text-sm text-foreground/45">{subtitle}</div>
      {hasAny ? (
        <>
          <div className="mt-6 flex h-44 items-end gap-3">
            {bars.map((bar) => (
              <div
                key={bar.key}
                className="flex min-w-0 flex-1 flex-col items-center gap-2"
              >
                <div className="flex h-32 w-full items-end justify-center">
                  <div
                    className={cn("w-full max-w-9 rounded-t-sm", bar.color)}
                    style={{
                      height: `${Math.max(4, Math.round((bar.value / maxValue) * 100))}%`,
                    }}
                    title={`${bar.value}${valueSuffix}`}
                  />
                </div>
                <div className="h-4 text-center text-[11px] text-foreground/42">
                  {bar.label}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-foreground/52">
            {legend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-2">
                <span className={cn("size-2 rounded-full", item.color)} />
                {item.label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-6">
          <EmptyState label="No chart data yet" />
        </div>
      )}
    </div>
  );
}

function ActivityListCard({
  title,
  emptyLabel,
  children,
}: {
  title: string;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm">
      <div className="mb-4 text-lg font-medium text-foreground">{title}</div>
      <div className="grid gap-3">{children || <EmptyState label={emptyLabel} />}</div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-background/35 px-3 py-6 text-center text-sm text-foreground/48">
      {label}
    </div>
  );
}
