import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Inbox,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import {
  InstructionInlineEditor,
  ScheduleEditor,
} from "@/components/panes/AutomationsPaneInlineEditors";

interface CompletedAutomationRun {
  sessionId: string;
  title: string;
  completedAt: string;
  status: string;
  errorDetail: string;
}

interface AutomationsPaneProps {
  workspaceId?: string | null;
  composerModel?: string | null;
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
  composerModel,
  emptyWorkspaceMessage = "Switch from the top bar to view its automations.",
  onOpenRunSession,
  onRunNow,
  onCreateSchedule,
  onEditSchedule,
}: AutomationsPaneProps) {
  const [activeTab, setActiveTab] = useState<"scheduled" | "completed">(
    "scheduled",
  );
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
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
      ? "border-b border-success/20 bg-success/8 text-success"
      : statusTone === "error"
        ? "border-b border-destructive/20 bg-destructive/5 text-destructive"
        : "border-b border-border bg-fg-2 text-muted-foreground";

  const setInfoMessage = (message: string) => {
    setStatusTone("info");
    setStatusMessage(message);
  };

  // Auto-dismiss success messages after a moment so the banner doesn't
  // linger forever after a save. Errors stay until the user replaces them
  // (or another action overwrites) — they need acknowledgement. Info
  // also persists since it's used for "open in chat" affordance hints.
  useEffect(() => {
    if (statusTone !== "success" || !statusMessage) return;
    const timeoutId = window.setTimeout(() => {
      setStatusMessage("");
    }, 3500);
    return () => window.clearTimeout(timeoutId);
  }, [statusMessage, statusTone]);

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

  const handleUpdateCronjobField = useCallback(
    async (
      job: CronjobRecordPayload,
      payload: CronjobUpdatePayload,
      successMessage: string,
    ) => {
      setBusyJobId(job.id);
      setStatusMessage("");
      try {
        const updated = await window.electronAPI.workspace.updateCronjob(
          job.workspace_id,
          job.id,
          payload,
        );
        setCronjobs((previous) =>
          previous.map((item) => (item.id === updated.id ? updated : item)),
        );
        setStatusTone("success");
        setStatusMessage(successMessage);
        void refreshData({
          preserveStatusMessage: true,
          suppressErrors: true,
        });
      } catch (error) {
        setStatusTone("error");
        setStatusMessage(normalizeErrorMessage(error));
        // Re-throw so the inline editor can keep edit mode open and let
        // the user retry without losing their draft.
        throw error;
      } finally {
        setBusyJobId(null);
      }
    },
    [refreshData],
  );

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
      const response = await window.electronAPI.workspace.runCronjobNow(
        job.workspace_id,
        job.id,
        composerModel ? { model: composerModel } : undefined,
      );
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
      <div className="shrink-0 px-4 py-2 sm:px-5">
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
            variant="outline"
            size="sm"
            onClick={handleNewSchedule}
          >
            <Plus className="size-3.5" />
            New schedule
          </Button>
        </div>
      </div>

      {statusMessage ? (
        <div
          key={`${statusTone}:${statusMessage}`}
          className={cn(
            "flex shrink-0 items-center gap-1.5 px-4 py-1.5 text-xs duration-200 ease-out animate-in fade-in-0 sm:px-5",
            statusBarClassName,
          )}
        >
          {statusTone === "success" ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : statusTone === "error" ? (
            <AlertTriangle className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{statusMessage}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!activeWorkspaceId ? (
          <EmptyState
            icon={CalendarClock}
            size="md"
            decorated
            title="No workspace selected"
            description={emptyWorkspaceMessage}
          />
        ) : isLoading &&
          scheduledJobs.length === 0 &&
          completedRuns.length === 0 ? (
          <SkeletonList />
        ) : activeTab === "scheduled" ? (
          scheduledJobs.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              size="md"
              decorated
              title="Nothing scheduled"
              description="Schedules run automatically at the time you set."
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleNewSchedule}
                >
                  <Plus className="size-3.5" />
                  New schedule
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {scheduledJobs.map((job) => {
                const isBusy = busyJobId === job.id;
                const kindLabel = jobKindLabel(job);
                const isExpanded = expandedJobId === job.id;
                const trimmedInstruction = job.instruction?.trim() ?? "";
                const trimmedDescription = job.description?.trim() ?? "";
                // Always expandable now that the row exposes inline edit
                // for instruction + schedule. Falling back to the prior
                // signal-based check would hide the editor on a fresh job.
                const hasExpandableDetails =
                  Boolean(trimmedInstruction) ||
                  Boolean(trimmedDescription) ||
                  Boolean(job.last_run_at) ||
                  Boolean(job.next_run_at) ||
                  Boolean(job.cron);
                return (
                  <li
                    key={job.id}
                    className={`group relative ${isBusy ? "opacity-60" : ""}`}
                  >
                    <div
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-fg-2 sm:px-5"
                    >
                      {hasExpandableDetails ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedJobId((current) =>
                              current === job.id ? null : job.id,
                            )
                          }
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? `Hide details for ${jobTitle(job)}`
                              : `Show details for ${jobTitle(job)}`
                          }
                          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-fg-4 hover:text-foreground"
                        >
                          <ChevronRight
                            className={`size-3.5 transition-transform ${
                              isExpanded ? "rotate-90" : ""
                            }`}
                          />
                        </button>
                      ) : (
                        <Clock3 className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-foreground">
                            {jobTitle(job)}
                          </span>
                          {kindLabel !== "Automation" ? (
                            <Badge
                              variant="outline"
                              className="border-border bg-fg-2 px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground"
                            >
                              {kindLabel}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          <span className="truncate">{scheduleAtLabel(job)}</span>
                          {!job.enabled ? (
                            <Badge
                              variant="outline"
                              className="border-border bg-fg-2 px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground"
                            >
                              Paused
                            </Badge>
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
                            Edit
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
                    </div>
                    {isExpanded && hasExpandableDetails ? (
                      <div className="border-t border-border bg-fg-2/40 px-4 pb-4 pt-3 sm:px-5">
                        <div className="ml-8 grid gap-3">
                          {trimmedInstruction ? (
                            <InstructionInlineEditor
                              value={trimmedInstruction}
                              saving={isBusy}
                              disabled={isBusy && busyJobId !== job.id}
                              onSave={(next) =>
                                handleUpdateCronjobField(
                                  job,
                                  { instruction: next },
                                  `Updated instruction for "${jobTitle(job)}".`,
                                )
                              }
                            />
                          ) : null}
                          {trimmedDescription &&
                          trimmedDescription !== trimmedInstruction ? (
                            <div className="grid gap-1">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Description
                              </div>
                              <div className="text-xs leading-5 text-muted-foreground">
                                {trimmedDescription}
                              </div>
                            </div>
                          ) : null}
                          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            {job.next_run_at ? (
                              <>
                                <span>Next run</span>
                                <span className="text-foreground">
                                  {formatRelativeTimestamp(job.next_run_at)}
                                </span>
                              </>
                            ) : null}
                            {job.last_run_at ? (
                              <>
                                <span>Last run</span>
                                <span className="text-foreground">
                                  {formatRelativeTimestamp(job.last_run_at)}
                                  {job.run_count > 0
                                    ? ` · ${job.run_count} total`
                                    : ""}
                                </span>
                              </>
                            ) : null}
                            <span>Schedule</span>
                            <ScheduleEditor
                              cron={job.cron}
                              saving={isBusy}
                              disabled={isBusy && busyJobId !== job.id}
                              onSave={(next) =>
                                handleUpdateCronjobField(
                                  job,
                                  { cron: next },
                                  `Updated schedule for "${jobTitle(job)}".`,
                                )
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : completedRuns.length === 0 ? (
          <EmptyState
            icon={Inbox}
            size="md"
            decorated
            title="No runs yet"
            description="Completed runs appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {completedRuns.map((run) => {
              const failed = isFailedStatus(run.status);
              return (
                <li key={run.sessionId}>
                  <button
                    type="button"
                    disabled={!onOpenRunSession}
                    onClick={() => onOpenRunSession?.(run.sessionId)}
                    className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fg-2 disabled:cursor-default disabled:hover:bg-transparent sm:px-5"
                  >
                    {failed ? (
                      <AlertTriangle className="size-4 shrink-0 text-destructive" />
                    ) : (
                      <Clock3 className="size-4 shrink-0 text-muted-foreground" />
                    )}
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

function SkeletonList() {
  const rows = ["w-32", "w-44", "w-36", "w-40"];
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading automations"
      className="divide-y divide-border"
    >
      {rows.map((titleW, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <li
          key={index}
          className="flex items-center gap-3 px-4 py-3 sm:px-5"
        >
          <div className="size-4 shrink-0 animate-pulse rounded bg-fg-8" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className={`h-3.5 ${titleW} animate-pulse rounded bg-fg-8`} />
            <div className="h-2.5 w-24 animate-pulse rounded bg-fg-6" />
          </div>
          <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-fg-6" />
        </li>
      ))}
    </ul>
  );
}
