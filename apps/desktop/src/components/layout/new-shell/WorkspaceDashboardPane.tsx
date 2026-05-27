import { Loader2, MoveRight, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
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

function percent(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(6, Math.round((count / total) * 100))}%`;
}

export function WorkspaceDashboardPane({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { issues, teammatesById, isLoading, statusMessage } =
    useIssueWorkspaceData(workspaceId);

  const teammates = useMemo(
    () => Object.values(teammatesById).sort((left, right) => left.name.localeCompare(right.name)),
    [teammatesById],
  );
  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.status !== "backlog"),
    [issues],
  );

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
    };
  }, [teammates.length, visibleIssues]);

  const recentIssues = useMemo(
    () =>
      [...visibleIssues]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 8),
    [visibleIssues],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
          <span>Dashboard</span>
        </div>
      </div>

      {statusMessage ? (
        <div className="border-b border-border px-6 py-3">
          <div className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
            {statusMessage}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading && issues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-foreground/35" />
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Teammates enabled"
                value={summary.activeTeammates}
                detail={`${summary.totalIssues} total issues`}
              />
              <MetricCard
                label="Tasks in progress"
                value={summary.inProgressCount}
                detail={`${summary.todoAssignedCount} assigned todo, ${summary.todoIdleCount} idle todo`}
              />
              <MetricCard
                label="Blocked"
                value={summary.blockedCount}
                detail={`${summary.reviewCount} waiting review`}
                tone="warning"
              />
              <MetricCard
                label="Done this week"
                value={summary.completedThisWeek}
                detail={`${summary.statusCounts.done} done overall`}
                tone="success"
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
              <DistributionCard
                title="Issues by priority"
                emptyLabel="No priorities set yet"
                rows={PRIORITY_ORDER.map((priority) => ({
                  key: priority,
                  label: issuePriorityLabel(priority),
                  count: summary.priorityCounts[priority],
                  total: summary.totalIssues,
                  tone:
                    priority === "critical"
                      ? "bg-red-400/80"
                      : priority === "high"
                        ? "bg-orange-400/80"
                        : priority === "medium"
                          ? "bg-amber-300/80"
                          : "bg-slate-400/80",
                }))}
              />
              <DistributionCard
                title="Issues by status"
                emptyLabel="No issue states yet"
                rows={STATUS_ORDER.map((status) => ({
                  key: status,
                  label: issueStatusLabel(status),
                  count: summary.statusCounts[status],
                  total: summary.totalIssues,
                  tone:
                    status === "done"
                      ? "bg-emerald-400/80"
                      : status === "blocked"
                        ? "bg-amber-300/80"
                        : status === "in_progress"
                          ? "bg-sky-400/80"
                          : status === "in_review"
                            ? "bg-violet-300/80"
                            : "bg-slate-400/80",
                }))}
              />
              <ActivityCard
                title="Teammate roster"
                emptyLabel="No teammates enabled yet"
              >
                {teammates.length > 0 ? (
                  teammates.map((teammate) => {
                    const activeCount = visibleIssues.filter(
                      (issue) => issue.assignee_teammate_id === teammate.teammate_id,
                    ).length;
                    return (
                      <div
                        key={teammate.teammate_id}
                        className="flex items-center justify-between rounded-xl border border-border bg-background/65 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">
                            {teammate.name}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-foreground/45">
                            {teammate.kind === "system"
                              ? "System teammate"
                              : `${teammate.skills.length} skill${teammate.skills.length === 1 ? "" : "s"}`}
                          </div>
                        </div>
                        <span className="rounded-full bg-foreground/[0.06] px-2 py-1 text-[11px] text-foreground/60">
                          {activeCount} assigned
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState label="No teammates enabled yet" />
                )}
              </ActivityCard>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <ActivityCard
                title="Recently updated"
                emptyLabel="No issue activity yet"
              >
                {recentIssues.length > 0 ? (
                  recentIssues.map((issue) => (
                    <div
                      key={issue.issue_id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-border bg-background/65 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-foreground/40">
                          <span>{issue.issue_id}</span>
                          <span aria-hidden>•</span>
                          <span>{issueRelativeTime(issue.updated_at)}</span>
                        </div>
                        <div className="mt-1 truncate text-sm font-medium text-foreground">
                          {issue.title || "Untitled issue"}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/52">
                          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-1.5 py-0.5">
                            <StatusDot
                              variant={issueStatusVariant(issue.status)}
                              pulse={issue.status === "in_progress"}
                            />
                            {issueStatusLabel(issue.status)}
                          </span>
                          <span>
                            {issue.assignee_teammate_id
                              ? teammatesById[issue.assignee_teammate_id]?.name ??
                                "Assigned"
                              : "Unassigned"}
                          </span>
                        </div>
                      </div>
                      <MoveRight className="mt-1 size-3.5 shrink-0 text-foreground/25" />
                    </div>
                  ))
                ) : (
                  <EmptyState label="No issue activity yet" />
                )}
              </ActivityCard>

              <ActivityCard
                title="Attention needed"
                emptyLabel="Nothing needs attention right now"
              >
                {summary.blockedCount > 0 || summary.reviewCount > 0 || summary.todoIdleCount > 0 ? (
                  <div className="grid gap-3">
                    <AttentionRow
                      label="Blocked issues"
                      value={summary.blockedCount}
                      detail="Require a blocker reply or manual intervention"
                      tone="warning"
                    />
                    <AttentionRow
                      label="In review"
                      value={summary.reviewCount}
                      detail="Waiting for explicit human review in the thread"
                      tone="info"
                    />
                    <AttentionRow
                      label="Unassigned todo"
                      value={summary.todoIdleCount}
                      detail="Todo issues without an assignee stay idle"
                      tone="muted"
                    />
                  </div>
                ) : (
                  <EmptyState label="Nothing needs attention right now" />
                )}
              </ActivityCard>
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
  value: number;
  detail: string;
  tone?: "default" | "warning" | "success";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm",
        tone === "warning" && "bg-amber-500/6",
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

function DistributionCard({
  title,
  emptyLabel,
  rows,
}: {
  title: string;
  emptyLabel: string;
  rows: Array<{
    key: string;
    label: string;
    count: number;
    total: number;
    tone: string;
  }>;
}) {
  const hasAny = rows.some((row) => row.count > 0);

  return (
    <div className="rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-4 space-y-3">
        {hasAny ? (
          rows.map((row) => (
            <div key={row.key}>
              <div className="mb-1.5 flex items-center justify-between text-xs text-foreground/55">
                <span>{row.label}</span>
                <span>{row.count}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-foreground/[0.05]">
                <div
                  className={cn("h-full rounded-full", row.tone)}
                  style={{ width: percent(row.count, row.total) }}
                />
              </div>
            </div>
          ))
        ) : (
          <EmptyState label={emptyLabel} />
        )}
      </div>
    </div>
  );
}

function ActivityCard({
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
      <div className="mb-4 text-sm font-medium text-foreground">{title}</div>
      <div className="grid gap-3">{children || <EmptyState label={emptyLabel} />}</div>
    </div>
  );
}

function AttentionRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone: "warning" | "info" | "muted";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-background/65 px-3 py-3",
        tone === "warning" && "border-amber-400/20 bg-amber-500/8",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TriangleAlert
            className={cn(
              "size-4",
              tone === "warning"
                ? "text-amber-300"
                : tone === "info"
                  ? "text-sky-300"
                  : "text-foreground/35",
            )}
          />
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <span className="text-lg font-semibold text-foreground">{value}</span>
      </div>
      <div className="mt-2 text-xs leading-5 text-foreground/52">{detail}</div>
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
