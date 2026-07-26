import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  Clock,
  FolderOpen,
  Inbox as InboxIcon,
  Loader2,
  Pause,
  X,
  Clock3,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";

export type OperationsDrawerTab = "inbox" | "running";

export interface OperationsInboxPaneProps {
  hasWorkspace: boolean;
}

interface OperationsDrawerProps {
  activeTab: OperationsDrawerTab;
  onTabChange: (tab: OperationsDrawerTab) => void;
  onOpenRunningSession: (sessionId: string) => void;
  onCreateSession: () => void;
  activeRunningSessionId: string | null;
  hasWorkspace: boolean;
  selectedWorkspaceId: string | null;
}

interface RunningSessionEntry {
  sessionId: string;
  status: string;
  stateLabel: string;
  stateTimestamp: string;
  stateDetail: string;
  title: string;
  kind: string;
  updatedAt: string;
  lastError: string | null;
}

const RUNNING_SESSIONS_POLL_INTERVAL_MS = 1000;

export function OperationsDrawer({
  activeTab,
  onTabChange,
  onOpenRunningSession,
  onCreateSession,
  activeRunningSessionId,
  hasWorkspace,
  selectedWorkspaceId,
}: OperationsDrawerProps) {
  const [runningSessions, setRunningSessions] = useState<RunningSessionEntry[]>(
    [],
  );
  const [isLoadingRunningSessions, setIsLoadingRunningSessions] =
    useState(false);
  const [runningSessionsError, setRunningSessionsError] = useState("");

  useEffect(() => {
    if (activeTab !== "running") {
      return;
    }
    if (!selectedWorkspaceId) {
      setRunningSessions([]);
      setRunningSessionsError("");
      return;
    }

    let cancelled = false;
    let requestInFlight = false;

    const loadRunningSessions = async (options?: { showLoading?: boolean }) => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      if (options?.showLoading) {
        setIsLoadingRunningSessions(true);
      }
      try {
        const [runtimeStatesResponse, sessionsResponse] = await Promise.all([
          window.electronAPI.workspace.listRuntimeStates(selectedWorkspaceId),
          window.electronAPI.workspace.listAgentSessions(selectedWorkspaceId),
        ]);
        if (cancelled) {
          return;
        }

        const sessionById = new Map(
          sessionsResponse.items.map((session) => [
            session.session_id,
            session,
          ]),
        );
        const nextEntries = runtimeStatesResponse.items
          .filter((state) => Boolean(state.session_id.trim()))
          .map((state) => {
            const session = sessionById.get(state.session_id);
            const stateLabel = runningSessionState(state);
            return {
              sessionId: state.session_id,
              status: stateLabel,
              stateLabel,
              stateTimestamp: runningSessionStateTimestamp(state),
              stateDetail: runningSessionStateDetail(stateLabel),
              title:
                session?.title?.trim() ||
                defaultSessionTitle(session?.kind, state.session_id),
              kind: session?.kind?.trim() || "session",
              updatedAt: state.updated_at,
              lastError: runtimeStateErrorMessage(state.last_error),
            };
          })
          .sort(compareRunningSessionEntries);

        setRunningSessions(nextEntries);
        setRunningSessionsError("");
      } catch (error) {
        if (!cancelled) {
          setRunningSessionsError(normalizeOperationError(error));
        }
      } finally {
        requestInFlight = false;
        if (!cancelled && options?.showLoading) {
          setIsLoadingRunningSessions(false);
        }
      }
    };

    const refreshRunningSessions = () => {
      void loadRunningSessions();
    };
    const refreshVisibleRunningSessions = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      refreshRunningSessions();
    };

    void loadRunningSessions({ showLoading: true });
    const intervalId = window.setInterval(() => {
      refreshVisibleRunningSessions();
    }, RUNNING_SESSIONS_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshRunningSessions);
    document.addEventListener(
      "visibilitychange",
      refreshVisibleRunningSessions,
    );

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshRunningSessions);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleRunningSessions,
      );
    };
  }, [activeTab, selectedWorkspaceId]);

  return (
    <aside className="relative flex h-full min-h-0 min-w-[296px] max-w-[336px] flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <DrawerTabButton
            active={activeTab === "inbox"}
            icon={<InboxIcon size={14} />}
            label="Inbox"
            onClick={() => onTabChange("inbox")}
          />
          <DrawerTabButton
            active={activeTab === "running"}
            icon={<Clock3 size={14} />}
            label="Sessions"
            onClick={() => onTabChange("running")}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "inbox" ? (
          <OperationsInboxPane
            hasWorkspace={hasWorkspace}
          />
        ) : null}

        {activeTab === "running" ? (
          <RunningPanel
            hasWorkspace={hasWorkspace}
            isLoading={isLoadingRunningSessions}
            sessions={runningSessions}
            errorMessage={runningSessionsError}
            onOpenSession={onOpenRunningSession}
            onCreateSession={onCreateSession}
            activeSessionId={activeRunningSessionId}
          />
        ) : null}
      </div>
    </aside>
  );
}

export function OperationsInboxPane({
  hasWorkspace,
}: OperationsInboxPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <EmptyState
          icon={InboxIcon}
          title={hasWorkspace ? "Inbox is empty for now" : "Choose a workspace"}
          description={
            hasWorkspace
              ? "Issue-first v1 does not surface proposal review here."
              : "Select a workspace to view its sessions and issue inbox."
          }
        />
      </div>
    </div>
  );
}

function normalizeOperationError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function runtimeStateErrorMessage(
  value: Record<string, unknown> | null,
): string | null {
  if (!value) {
    return null;
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
  return rawMessage || null;
}

function defaultSessionTitle(
  kind: string | null | undefined,
  sessionId: string,
): string {
  const normalizedKind = (kind ?? "").trim().toLowerCase();
  if (normalizedKind === "cronjob") {
    return "Scheduled automation run";
  }
  if (normalizedKind === "subagent") {
    return "Subagent run";
  }
  return `Session ${sessionId.slice(0, 8)}`;
}

function normalizeTurnResultStatus(status: string | null | undefined): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function runningSessionRuntimeStatus(entry: {
  status: string;
  effective_state?: string | null;
}): string {
  return (entry.effective_state || entry.status || "").trim().toUpperCase();
}

function runningSessionState(entry: {
  status: string;
  effective_state?: string | null;
  last_turn_status: string | null;
}): string {
  const runtimeStatus = runningSessionRuntimeStatus(entry);
  if (runtimeStatus === "BUSY") {
    return "RUNNING";
  }
  if (runtimeStatus === "QUEUED") {
    return "QUEUED";
  }
  if (runtimeStatus === "WAITING_USER") {
    return "WAITING";
  }
  if (runtimeStatus === "PAUSED") {
    return "PAUSED";
  }
  if (runtimeStatus === "ERROR") {
    return "ERROR";
  }

  const lastTurnStatus = normalizeTurnResultStatus(entry.last_turn_status);
  if (lastTurnStatus === "completed") {
    return "COMPLETED";
  }
  if (lastTurnStatus === "waiting_user") {
    return "WAITING";
  }
  if (lastTurnStatus === "paused") {
    return "PAUSED";
  }
  if (lastTurnStatus === "failed" || lastTurnStatus === "error") {
    return "ERROR";
  }
  return "IDLE";
}

function runningSessionStateTimestamp(entry: {
  status: string;
  effective_state?: string | null;
  updated_at: string;
  last_turn_completed_at: string | null;
}): string {
  const runtimeStatus = runningSessionRuntimeStatus(entry);
  if (
    runtimeStatus === "BUSY" ||
    runtimeStatus === "QUEUED" ||
    runtimeStatus === "WAITING_USER" ||
    runtimeStatus === "PAUSED" ||
    runtimeStatus === "ERROR"
  ) {
    return entry.updated_at;
  }
  return entry.last_turn_completed_at?.trim() || entry.updated_at;
}

function runningSessionStateDetail(stateLabel: string): string {
  switch (stateLabel) {
    case "RUNNING":
      return "Active";
    case "QUEUED":
      return "Queued";
    case "WAITING":
      return "Waiting for input";
    case "PAUSED":
      return "Paused";
    case "ERROR":
      return "Failed";
    case "COMPLETED":
      return "Completed";
    default:
      return "Idle";
  }
}

function runningSessionStatusRank(status: string): number {
  switch (status) {
    case "RUNNING":
      return 0;
    case "QUEUED":
      return 1;
    case "WAITING":
      return 2;
    case "PAUSED":
      return 3;
    case "ERROR":
      return 4;
    case "COMPLETED":
      return 5;
    case "IDLE":
      return 6;
    default:
      return 7;
  }
}

function compareRunningSessionEntries(
  left: RunningSessionEntry,
  right: RunningSessionEntry,
): number {
  const statusDiff =
    runningSessionStatusRank(left.status) -
    runningSessionStatusRank(right.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function runningSessionStatusIndicator(status: string): {
  className: string;
  icon: ReactNode;
  label: string;
} {
  switch (status) {
    case "RUNNING":
      return {
        className: "text-primary",
        icon: <Loader2 size={14} className="animate-spin" />,
        label: "Running",
      };
    case "QUEUED":
      return {
        className: "text-info",
        icon: <Clock3 size={14} />,
        label: "Queued",
      };
    case "WAITING":
      return {
        className: "text-warning",
        icon: <Clock size={14} />,
        label: "Waiting for input",
      };
    case "PAUSED":
      return {
        className: "text-warning",
        icon: <Pause size={14} />,
        label: "Paused",
      };
    case "ERROR":
      return {
        className: "text-destructive",
        icon: <X size={14} />,
        label: "Failed",
      };
    case "COMPLETED":
      return {
        className: "text-success",
        icon: <Check size={14} />,
        label: "Completed",
      };
    default:
      return {
        className: "text-muted-foreground",
        icon: <Clock3 size={14} />,
        label: "Idle",
      };
  }
}

function DrawerTabButton({
  active,
  icon,
  label,
  showIndicator = false,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  showIndicator?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      size="sm"
      variant={active ? "default" : "ghost"}
      className={`gap-2 rounded-2xl px-3 ${
        active
          ? "bg-primary/10 text-primary hover:bg-primary/14 hover:text-primary"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      <span className="relative">
        {icon}
        {showIndicator ? (
          <StatusDot
            variant="destructive"
            size="lg"
            withRing
            className="absolute -right-0.5 -top-0.5"
          />
        ) : null}
      </span>
      <span>{label}</span>
    </Button>
  );
}

function RunningPanel({
  hasWorkspace,
  isLoading,
  sessions,
  errorMessage,
  onOpenSession,
  onCreateSession,
  activeSessionId,
}: {
  hasWorkspace: boolean;
  isLoading: boolean;
  sessions: RunningSessionEntry[];
  errorMessage: string;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: () => void;
  activeSessionId: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Sessions
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCreateSession}
          disabled={!hasWorkspace}
          className="rounded-full border border-border px-3 text-xs"
        >
          <span>New Session</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!hasWorkspace ? (
          <EmptyNotice
            icon={<FolderOpen size={24} strokeWidth={1.5} />}
            message="Choose a workspace to inspect sessions."
          />
        ) : errorMessage ? (
          <EmptyNotice
            icon={
              <X size={24} strokeWidth={1.5} className="text-destructive" />
            }
            message={errorMessage}
          />
        ) : isLoading && sessions.length === 0 ? (
          <EmptyNotice
            icon={
              <Loader2 size={24} strokeWidth={1.5} className="animate-spin" />
            }
            message="Loading sessions..."
          />
        ) : sessions.length === 0 ? (
          <EmptyNotice
            icon={<Clock size={24} strokeWidth={1.5} />}
            message="No sessions yet."
          />
        ) : (
          <div className="divide-y divide-border">
            {sessions.map((session) => {
              const statusIndicator = runningSessionStatusIndicator(
                session.status,
              );
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onOpenSession(session.sessionId)}
                  aria-label={`Open session ${session.title}`}
                  className={`w-full cursor-pointer px-3 py-3 text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted ${
                    activeSessionId === session.sessionId
                      ? "border-l-2 border-l-primary bg-muted"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {session.title}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {session.stateDetail}{" "}
                        {relativeTime(session.stateTimestamp)}
                      </div>
                      {session.lastError ? (
                        <div className="mt-1.5 truncate text-xs text-destructive">
                          {session.lastError}
                        </div>
                      ) : null}
                    </div>
                    <div
                      role="img"
                      aria-label={`${statusIndicator.label} status`}
                      title={statusIndicator.label}
                      className={`shrink-0 self-center ${statusIndicator.className}`}
                    >
                      {statusIndicator.icon}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyNotice({ icon, message }: { icon: ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      {icon}
      <span className="text-sm">{message}</span>
    </div>
  );
}

function relativeTime(value: string): string {
  const ms = Date.now() - Date.parse(value);
  if (Number.isNaN(ms)) {
    return value;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
