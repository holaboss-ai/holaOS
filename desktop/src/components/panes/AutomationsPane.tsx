import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

interface CompletedAutomationRun {
  sessionId: string;
  title: string;
  completedAt: string;
  status: string;
  errorDetail: string;
}

interface AutomationsPaneProps {
  workspaceId?: string | null;
  emptyWorkspaceMessage?: string;
  onOpenRunSession?: (sessionId: string) => void;
  onRunNow?: (job: CronjobRecordPayload) => void;
  onCreateSchedule?: () => void;
  onEditSchedule?: (job: CronjobRecordPayload) => void;
}

interface RefreshDataOptions {
  preserveStatusMessage?: boolean;
  suppressErrors?: boolean;
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function formatRelativeTimestamp(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  const diffMs = Date.now() - parsed;
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 1) {
    return "just now";
  }
  if (Math.abs(diffMin) < 60) {
    return `${diffMin > 0 ? `${diffMin}m ago` : `in ${-diffMin}m`}`;
  }
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) {
    return `${diffHr > 0 ? `${diffHr}h ago` : `in ${-diffHr}h`}`;
  }
  const date = new Date(parsed);
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart}, ${timePart}`;
}

function formatDailyCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }
  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    return null;
  }
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    return null;
  }
  return `Daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function scheduleAtLabel(job: CronjobRecordPayload): string {
  return formatDailyCron(job.cron) ?? formatRelativeTimestamp(job.next_run_at);
}

function jobTitle(job: CronjobRecordPayload): string {
  return job.name?.trim() || job.description?.trim() || "Untitled schedule";
}

function jobDeliveryChannel(job: CronjobRecordPayload): string {
  return job.delivery?.channel?.trim().toLowerCase() || "";
}

function jobKindLabel(job: CronjobRecordPayload): string {
  const channel = jobDeliveryChannel(job);
  if (channel === "system_notification") {
    return "Notification";
  }
  if (channel === "session_run") {
    return "Task run";
  }
  return "Automation";
}

function runtimeStateErrorMessage(
  value: Record<string, unknown> | null | undefined,
): string {
  if (!value) {
    return "";
  }

  const message =
    typeof value.message === "string" && value.message.trim()
      ? value.message.trim()
      : "";
  if (message) {
    return message;
  }

  const rawMessage =
    typeof value.raw_message === "string" && value.raw_message.trim()
      ? value.raw_message.trim()
      : "";
  return rawMessage;
}

function isTerminalRunStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return (
    normalized === "IDLE" ||
    normalized === "ERROR" ||
    normalized === "FAILED" ||
    normalized === "COMPLETED"
  );
}

function isFailedStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return normalized === "ERROR" || normalized === "FAILED";
}

export function AutomationsPane({
  workspaceId,
  emptyWorkspaceMessage = "Choose a workspace from the top bar to view and manage automations.",
  onOpenRunSession,
  onRunNow,
  onCreateSchedule,
  onEditSchedule,
}: AutomationsPaneProps) {
  const [activeTab, setActiveTab] = useState<"scheduled" | "completed">(
    "scheduled",
  );
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const activeWorkspaceId = workspaceId ?? selectedWorkspaceId;
  const [cronjobs, setCronjobs] = useState<CronjobRecordPayload[]>([]);
  const [completedRuns, setCompletedRuns] = useState<CompletedAutomationRun[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<"info" | "success" | "error">(
    "info",
  );

  const scheduledJobs = useMemo(
    () =>
      [...cronjobs].sort((left, right) => {
        const leftRaw = Date.parse(left.next_run_at ?? left.updated_at);
        const rightRaw = Date.parse(right.next_run_at ?? right.updated_at);
        const leftTs = Number.isNaN(leftRaw) ? 0 : leftRaw;
        const rightTs = Number.isNaN(rightRaw) ? 0 : rightRaw;
        return leftTs - rightTs;
      }),
    [cronjobs],
  );

  const statusBarClassName =
    statusTone === "success"
      ? "border-b border-primary/20 bg-primary/5 text-foreground"
      : statusTone === "error"
        ? "border-b border-destructive/20 bg-destructive/5 text-destructive"
        : "border-b border-border bg-muted/40 text-muted-foreground";

  const setInfoMessage = (message: string) => {
    setStatusTone("info");
    setStatusMessage(message);
  };

  const refreshData = useCallback(
    async (options?: RefreshDataOptions) => {
      const preserveStatusMessage = options?.preserveStatusMessage ?? false;
      const suppressErrors = options?.suppressErrors ?? false;

      if (!activeWorkspaceId) {
        setCronjobs([]);
        setCompletedRuns([]);
        return;
      }

      setIsLoading(true);
      try {
        const [cronjobsResponse, sessionsResponse, runtimeStatesResponse] =
          await Promise.all([
            window.electronAPI.workspace.listCronjobs(activeWorkspaceId),
            window.electronAPI.workspace.listAgentSessions(activeWorkspaceId),
            window.electronAPI.workspace.listRuntimeStates(activeWorkspaceId),
          ]);

        setCronjobs(cronjobsResponse.jobs);

        const runtimeStateBySessionId = new Map(
          runtimeStatesResponse.items.map((item) => [item.session_id, item]),
        );

        const nextCompletedRuns = sessionsResponse.items
          .filter((session) => session.kind.trim().toLowerCase() === "cronjob")
          .map((session) => {
            const runtimeState = runtimeStateBySessionId.get(
              session.session_id,
            );
            const status = (runtimeState?.status || "IDLE")
              .trim()
              .toUpperCase();
            const completedAt =
              runtimeState?.updated_at ||
              session.updated_at ||
              session.created_at;
            return {
              sessionId: session.session_id,
              title: session.title?.trim() || "Cronjob run",
              completedAt,
              status,
              errorDetail: runtimeStateErrorMessage(runtimeState?.last_error),
            };
          })
          .filter((run) => isTerminalRunStatus(run.status))
          .sort((left, right) => {
            const leftRaw = Date.parse(left.completedAt);
            const rightRaw = Date.parse(right.completedAt);
            const leftTs = Number.isNaN(leftRaw) ? 0 : leftRaw;
            const rightTs = Number.isNaN(rightRaw) ? 0 : rightRaw;
            return rightTs - leftTs;
          });

        setCompletedRuns(nextCompletedRuns);
        if (!preserveStatusMessage) {
          setStatusMessage("");
        }
      } catch (error) {
        if (!suppressErrors) {
          setStatusTone("error");
          setStatusMessage(normalizeErrorMessage(error));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [activeWorkspaceId],
  );

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const handleDelete = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    setStatusMessage("");
    try {
      await window.electronAPI.workspace.deleteCronjob(job.workspace_id, job.id);
      setCronjobs((previous) => previous.filter((item) => item.id !== job.id));
      setStatusTone("success");
      setStatusMessage(`Deleted "${jobTitle(job)}".`);
      void refreshData({
        preserveStatusMessage: true,
        suppressErrors: true,
      });
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleToggleEnabled = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    setStatusMessage("");
    try {
      const updated = await window.electronAPI.workspace.updateCronjob(job.workspace_id, job.id, {
        enabled: !job.enabled,
      });
      setCronjobs((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      setStatusTone("success");
      setStatusMessage(
        `${updated.enabled ? "Enabled" : "Paused"} "${jobTitle(updated)}".`,
      );
      void refreshData({
        preserveStatusMessage: true,
        suppressErrors: true,
      });
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRunNow = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    setStatusMessage("");
    try {
      const response = await window.electronAPI.workspace.runCronjobNow(job.workspace_id, job.id);
      setCronjobs((previous) =>
        previous.map((item) =>
          item.id === response.cronjob.id ? response.cronjob : item,
        ),
      );
      setStatusTone("success");
      setStatusMessage(`Running "${jobTitle(response.cronjob)}" now.`);
      if (onRunNow) {
        onRunNow(response.cronjob);
        return;
      }
      void refreshData({
        preserveStatusMessage: true,
        suppressErrors: true,
      });
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleNewSchedule = () => {
    if (onCreateSchedule) {
      onCreateSchedule();
      return;
    }
    setInfoMessage(
      "Schedule creation is wired through the agent — try asking in chat.",
    );
  };

  const handleEdit = (job: CronjobRecordPayload) => {
    if (onEditSchedule) {
      onEditSchedule(job);
      return;
    }
    setInfoMessage("Open the schedule in chat to edit it.");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "scheduled" | "completed")}
          >
            <TabsList>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleNewSchedule}
            aria-label="New schedule"
            className="rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      {statusMessage ? (
        <div
          className={`shrink-0 px-4 py-1.5 text-xs sm:px-5 ${statusBarClassName}`}
        >
          {statusMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!activeWorkspaceId ? (
          <EmptyState
            icon={<Clock3 className="size-5 text-muted-foreground" />}
            title="No workspace selected"
            description={emptyWorkspaceMessage}
          />
        ) : isLoading &&
          scheduledJobs.length === 0 &&
          completedRuns.length === 0 ? (
          <SkeletonList />
        ) : activeTab === "scheduled" ? (
          scheduledJobs.length === 0 ? (
            <EmptyScheduled onCreate={handleNewSchedule} />
          ) : (
            <ul>
              {scheduledJobs.map((job, index) => {
                const isBusy = busyJobId === job.id;
                const kindLabel = jobKindLabel(job);
                return (
                  <li
                    key={job.id}
                    className={`group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent sm:px-5 ${
                      index > 0 ? "border-t border-border" : ""
                    } ${isBusy ? "opacity-60" : ""}`}
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Clock3 className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {jobTitle(job)}
                        </span>
                        {kindLabel !== "Automation" ? (
                          <Badge
                            variant="outline"
                            className="border-border bg-background/60 px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground"
                          >
                            {kindLabel}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {scheduleAtLabel(job)}
                        {!job.enabled ? (
                          <span className="ml-1.5 text-muted-foreground/70">
                            · paused
                          </span>
                        ) : null}
                      </div>
                      {job.last_error ? (
                        <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          <span className="truncate">{job.last_error}</span>
                        </div>
                      ) : null}
                    </div>
                    <Switch
                      checked={job.enabled}
                      onCheckedChange={() => void handleToggleEnabled(job)}
                      disabled={isBusy}
                      aria-label={
                        job.enabled ? "Pause schedule" : "Enable schedule"
                      }
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${jobTitle(job)}`}
                            className="rounded-lg text-muted-foreground hover:text-foreground"
                          />
                        }
                      >
                        <MoreHorizontal size={14} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="w-44"
                      >
                        <DropdownMenuItem
                          onClick={() => void handleRunNow(job)}
                          disabled={isBusy}
                        >
                          <Play size={14} />
                          Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleEdit(job)}
                          disabled={isBusy}
                        >
                          <Pencil size={14} />
                          Edit in chat
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void handleDelete(job)}
                          disabled={isBusy}
                          variant="destructive"
                        >
                          <Trash2 size={14} />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )
        ) : completedRuns.length === 0 ? (
          <EmptyState
            icon={<Clock3 className="size-5 text-muted-foreground" />}
            title="No runs yet"
            description="Once a scheduled task fires, its history will show up here."
          />
        ) : (
          <ul>
            {completedRuns.map((run, index) => {
              const failed = isFailedStatus(run.status);
              return (
                <li key={run.sessionId}>
                  <button
                    type="button"
                    disabled={!onOpenRunSession}
                    onClick={() => onOpenRunSession?.(run.sessionId)}
                    className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent sm:px-5 ${
                      index > 0 ? "border-t border-border" : ""
                    }`}
                  >
                    <div
                      className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
                        failed
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {failed ? (
                        <AlertTriangle className="size-3.5" />
                      ) : (
                        <Clock3 className="size-3.5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {run.title}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {failed ? "Failed" : "Completed"}
                        <span className="mx-1.5">·</span>
                        {formatRelativeTimestamp(run.completedAt)}
                      </div>
                      {run.errorDetail ? (
                        <div className="mt-1 truncate text-xs text-destructive">
                          {run.errorDetail}
                        </div>
                      ) : null}
                    </div>
                    {onOpenRunSession ? (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-muted">
        {icon}
      </div>
      <div className="mt-3 text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function EmptyScheduled({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Clock3 className="size-5" />
      </div>
      <div className="mt-3 text-sm font-medium text-foreground">
        No schedules yet
      </div>
      <p className="mt-1 max-w-[260px] text-xs leading-5 text-muted-foreground">
        Ask the agent to set one up — try{" "}
        <span className="text-foreground/80">
          &ldquo;post a LinkedIn update every Monday at 9am&rdquo;
        </span>
        .
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCreate}
        className="mt-4 gap-1.5"
      >
        <Sparkles className="size-3.5" />
        Ask the agent
      </Button>
    </div>
  );
}

function SkeletonList() {
  const rows = ["w-32", "w-44", "w-36", "w-40"];
  return (
    <ul role="status" aria-busy="true" aria-label="Loading automations">
      {rows.map((titleW, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <li
          key={index}
          className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${
            index > 0 ? "border-t border-border" : ""
          }`}
        >
          <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted-foreground/15" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div
              className={`h-3.5 ${titleW} animate-pulse rounded bg-muted-foreground/20`}
            />
            <div className="h-2.5 w-24 animate-pulse rounded bg-muted-foreground/15" />
          </div>
          <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted-foreground/15" />
        </li>
      ))}
    </ul>
  );
}
