import { Loader2, Square } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";

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
): Array<{ key: string; label: string; value: number }> {
  const days = windowDayKeys(DAY_WINDOW);
  const grouped = new Map<string, number>();
  for (const result of results) {
    const key = dayKey(turnResultTimestamp(result));
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return days.map((key, index) => ({
    key,
    label:
      index === 0 ||
      index === Math.floor(days.length / 2) ||
      index === days.length - 1
        ? dayLabel(key)
        : "",
    value: grouped.get(key) ?? 0,
  }));
}

/**
 * Map an issue status to one of the project's semantic tokens so the
 * stacked board-mix bar and the StatusDot across the app share the same
 * palette. Brand orange (`bg-primary`) means "active work" — only used
 * for in_progress.
 */
function statusSegmentBg(status: IssueStatusPayload): string {
  switch (status) {
    case "done":
      return "bg-success";
    case "in_progress":
      return "bg-primary";
    case "in_review":
      return "bg-info";
    case "blocked":
      return "bg-warning";
    case "todo":
    default:
      return "bg-muted-foreground/45";
  }
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
    let completedThisWeek = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const issue of visibleIssues) {
      statusCounts[issue.status] += 1;
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
      completedThisWeek,
      statusCounts,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }, [recentIssueTurnResults, teammates.length, visibleIssues]);

  const runActivityBars = useMemo(
    () => buildDailyBars(recentIssueTurnResults),
    [recentIssueTurnResults],
  );
  const totalRecentRuns = useMemo(
    () => runActivityBars.reduce((sum, bar) => sum + bar.value, 0),
    [runActivityBars],
  );
  const peakRunDay = useMemo(
    () => runActivityBars.reduce((max, bar) => Math.max(max, bar.value), 0),
    [runActivityBars],
  );

  // Live "now" band — issues with an active subagent right this moment,
  // grouped with their assignee teammate so the dashboard opens with
  // *who is doing what*, not "Agents enabled: N".
  const activeIssues = useMemo(() => {
    return visibleIssues
      .filter((issue) => Boolean(issue.active_subagent_id))
      .map((issue) => ({
        issue,
        teammateName: issue.assignee_teammate_id
          ? teammatesById[issue.assignee_teammate_id]?.name ?? "Teammate"
          : "Teammate",
      }));
  }, [teammatesById, visibleIssues]);

  const [stoppingIssueId, setStoppingIssueId] = useState("");
  const handleStopIssueRun = useCallback(
    async (issue: IssueRecordPayload) => {
      if (!issue.active_subagent_id) return;
      if (!window.confirm(`Stop ${issue.issue_id}?`)) return;
      setStoppingIssueId(issue.issue_id);
      try {
        await window.electronAPI.workspace.stopIssueRun(
          workspaceId,
          issue.issue_id,
        );
      } finally {
        setStoppingIssueId("");
      }
    },
    [workspaceId],
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
      {/* Compact top bar — eyebrow on the left, time window on the right.
          Keeps chrome out of the way; the page itself does the talking. */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Dashboard
        </div>
        <div className="text-xs text-muted-foreground">Last 14 days</div>
      </header>

      {dashboardStatusMessage ? (
        <div className="border-b border-border bg-card/40 px-6 py-2 text-sm text-muted-foreground">
          {dashboardStatusMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-fg-4">
        {isLoadingIssues && visibleIssues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1180px] space-y-5 px-6 py-6">
            {/* NOW band — live agent activity. The single brand-orange
                pulse on the dashboard sits here, because this is the
                only thing on the page that's actually moving. */}
            <Card>
              <CardHeader
                eyebrow="Now"
                meta={
                  activeIssues.length === 0
                    ? "Idle"
                    : `${activeIssues.length} ${activeIssues.length === 1 ? "teammate" : "teammates"} working`
                }
              />
              {activeIssues.length > 0 ? (
                <ul className="divide-y divide-border">
                  {activeIssues.map(({ issue, teammateName }) => (
                    <li key={issue.issue_id}>
                      <div className="group flex w-full items-center gap-3 px-5 py-3 transition-colors hover:bg-foreground/[0.025]">
                        <button
                          type="button"
                          onClick={() =>
                            void openIssueDetailTab({
                              workspaceId,
                              issueId: issue.issue_id,
                              title: issue.title,
                            })
                          }
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <div className="relative grid size-8 shrink-0 place-items-center rounded-full bg-fg-8 text-sm font-semibold text-foreground">
                            {teammateName.trim().slice(0, 1).toUpperCase() ||
                              "?"}
                            <span
                              aria-hidden
                              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-base">
                              <span className="font-semibold text-foreground">
                                {teammateName}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {issue.issue_id}
                              </span>
                            </div>
                            <div className="truncate text-sm text-muted-foreground">
                              {issue.title || "Untitled issue"}
                            </div>
                          </div>
                          <div className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground md:flex">
                            <StatusDot variant="primary" pulse size="md" />
                            <span className="tabular-nums">
                              Working · {issueRelativeTime(issue.updated_at)}
                            </span>
                          </div>
                        </button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => void handleStopIssueRun(issue)}
                          disabled={stoppingIssueId === issue.issue_id}
                          aria-label={`Stop ${issue.issue_id}`}
                        >
                          {stoppingIssueId === issue.issue_id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Square className="size-3" />
                          )}
                          Stop
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex items-center gap-2.5 px-5 py-4 text-sm text-muted-foreground">
                  <StatusDot variant="muted" size="md" />
                  <span>
                    Nothing running right now. Move an issue to Todo with an
                    assignee to kick off work.
                  </span>
                </div>
              )}
            </Card>

            {/* Metric strip — 4 numbers + token row in one card. Internal
                divide-x line gives them column structure without
                fragmenting into 4 islands. */}
            <Card>
              <div className="grid grid-cols-2 divide-x divide-border md:grid-cols-4">
                <Stat
                  label="In progress"
                  value={summary.inProgressCount}
                  hint={
                    summary.inProgressCount === 0
                      ? "Idle"
                      : `Across ${summary.activeTeammates} teammate${summary.activeTeammates === 1 ? "" : "s"}`
                  }
                />
                <Stat
                  label="In review"
                  value={summary.reviewCount}
                  hint={
                    summary.reviewCount === 0
                      ? "Nothing waiting"
                      : "Awaiting your call"
                  }
                />
                <Stat
                  label="Blocked"
                  value={summary.blockedCount}
                  tone={summary.blockedCount > 0 ? "warning" : "default"}
                  hint={
                    summary.blockedCount === 0
                      ? "Clear"
                      : "Needs your input"
                  }
                />
                <Stat
                  label="Done this week"
                  value={summary.completedThisWeek}
                  tone={summary.completedThisWeek > 0 ? "success" : "default"}
                  hint={
                    summary.completedThisWeek === 0
                      ? "Nothing shipped yet"
                      : `${summary.totalIssues} total on the board`
                  }
                />
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border px-5 py-2.5 text-xs">
                <span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatCompactNumber(summary.totalTokens)}
                  </span>
                  <span className="ml-1 text-muted-foreground">
                    tokens · last 14 days
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCompactNumber(summary.inputTokens)} in ·{" "}
                  {formatCompactNumber(summary.outputTokens)} out
                </span>
              </div>
            </Card>

            {/* Run activity chart + Board mix — side by side at xl,
                stacked below. Both feel like the same "analytics row". */}
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Card>
                <CardHeader
                  eyebrow="Run activity"
                  meta={
                    totalRecentRuns > 0
                      ? `${totalRecentRuns} run${totalRecentRuns === 1 ? "" : "s"} · peak ${peakRunDay}/day`
                      : "No runs yet"
                  }
                />
                <div className="px-5 pb-5 pt-2">
                  <RunActivityChart
                    bars={runActivityBars}
                    peak={peakRunDay}
                  />
                </div>
              </Card>
              <Card>
                <CardHeader
                  eyebrow="Board mix"
                  meta={`${summary.totalIssues} issue${summary.totalIssues === 1 ? "" : "s"}`}
                />
                <div className="px-5 pb-5 pt-3">
                  <StatusSegmentBar
                    statusCounts={summary.statusCounts}
                    total={summary.totalIssues}
                  />
                </div>
              </Card>
            </div>

            {/* Two recent line lists — divide-y rows inside each card.
                Mirrors the sub-issues list in IssueDetailPane so the
                product reads as one piece of software, not three. */}
            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <CardHeader eyebrow="Recent activity" />
                {recentActivity.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {recentActivity.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() =>
                            void openIssueDetailTab({
                              workspaceId,
                              issueId: entry.issueId,
                              title: entry.issueTitle,
                            })
                          }
                          className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-foreground/[0.025]"
                        >
                          <StatusDot
                            variant={entry.tone}
                            size="md"
                            className="mt-1.5"
                          />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="truncate text-base text-foreground">
                              {entry.label}
                            </div>
                            <div className="truncate text-sm text-muted-foreground">
                              {entry.issueTitle}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {issueRelativeTime(entry.timestamp)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyRow label="No recent activity yet" />
                )}
              </Card>

              <Card>
                <CardHeader eyebrow="Recent issues" />
                {recentTasks.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {recentTasks.map((issue) => (
                      <li key={issue.issue_id}>
                        <button
                          type="button"
                          onClick={() =>
                            void openIssueDetailTab({
                              workspaceId: issue.workspace_id,
                              issueId: issue.issue_id,
                              title: issue.title,
                            })
                          }
                          className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-foreground/[0.025]"
                        >
                          <StatusDot
                            variant={issueStatusVariant(issue.status)}
                            pulse={issue.status === "in_progress"}
                            size="md"
                          />
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {issue.issue_id}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-base text-foreground">
                            {issue.title || "Untitled issue"}
                          </span>
                          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                            {issue.assignee_teammate_id
                              ? teammatesById[issue.assignee_teammate_id]
                                  ?.name ?? "Assigned"
                              : "Unassigned"}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {issueRelativeTime(issue.updated_at)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyRow label="No issues yet" />
                )}
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Card surface for dashboard sections. Uses `bg-card` + `shadow-xs`,
 * which (per tokens.css) bakes a 0-0-0-0.5px hairline ring into the
 * shadow stack and reads as "barely lifted" — sm is reserved for
 * buttons/popovers. We deliberately omit a separate `border` so the
 * ring doesn't double.
 */
function Card({ children }: { children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-xs">
      {children}
    </section>
  );
}

function CardHeader({
  eyebrow,
  meta,
}: {
  eyebrow: string;
  meta?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border px-5 py-3">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {eyebrow}
      </h2>
      {meta ? (
        <span className="text-xs tabular-nums text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "default" | "warning" | "success";
}) {
  return (
    <div className="space-y-1.5 px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "text-4xl font-semibold leading-none tracking-tight tabular-nums",
          tone === "warning"
            ? "text-warning"
            : tone === "success"
              ? "text-success"
              : "text-foreground",
        )}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-xs text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

function RunActivityChart({
  bars,
  peak,
}: {
  bars: Array<{ key: string; label: string; value: number }>;
  peak: number;
}) {
  const denominator = Math.max(1, peak);
  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {bars.map((bar) => {
          const isPeak = bar.value > 0 && bar.value === peak;
          const heightPct =
            bar.value === 0
              ? 5
              : Math.max(10, Math.round((bar.value / denominator) * 100));
          return (
            <div
              key={bar.key}
              className="flex min-w-0 flex-1 flex-col items-center justify-end"
              title={`${bar.label || bar.key}: ${bar.value} run${bar.value === 1 ? "" : "s"}`}
            >
              <div
                className={cn(
                  "w-full max-w-[16px] rounded-t-[3px] transition-colors",
                  bar.value === 0
                    ? "bg-fg-6"
                    : isPeak
                      ? "bg-primary"
                      : "bg-fg-32",
                )}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
        {bars.map((bar) => (
          <span
            key={bar.key}
            className="flex-1 text-center"
            aria-hidden={!bar.label}
          >
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusSegmentBar({
  statusCounts,
  total,
}: {
  statusCounts: Record<IssueStatusPayload, number>;
  total: number;
}) {
  return (
    <div className="space-y-4">
      {total > 0 ? (
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-fg-6"
          role="img"
          aria-label={`Issue status mix: ${STATUS_ORDER.map(
            (status) => `${issueStatusLabel(status)} ${statusCounts[status]}`,
          ).join(", ")}`}
        >
          {STATUS_ORDER.map((status) => {
            const count = statusCounts[status];
            if (count === 0) return null;
            const percent = (count / total) * 100;
            return (
              <div
                key={status}
                className={cn("h-full", statusSegmentBg(status))}
                style={{ width: `${percent}%` }}
                title={`${issueStatusLabel(status)}: ${count}`}
              />
            );
          })}
        </div>
      ) : (
        <div className="h-2.5 w-full rounded-full bg-fg-6" />
      )}
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
        {STATUS_ORDER.map((status) => (
          <li
            key={status}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  statusSegmentBg(status),
                )}
              />
              <span className="truncate text-muted-foreground">
                {issueStatusLabel(status)}
              </span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">
              {statusCounts[status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="px-5 py-4 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

