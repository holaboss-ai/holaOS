const ACTIVE_BROWSER_SESSION_STATUSES = new Set(["BUSY", "QUEUED", "PAUSING"]);

function normalizedRuntimeStatus(
  runtimeState: SessionRuntimeRecordPayload | null | undefined,
): string {
  return (
    runtimeState?.effective_state?.trim().toUpperCase() ||
    runtimeState?.status?.trim().toUpperCase() ||
    ""
  );
}

export function browserSessionTitle(
  session: AgentSessionRecordPayload | null | undefined,
  sessionId?: string | null,
): string {
  const explicitTitle = session?.title?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }
  const kind = session?.kind?.trim();
  const suffix = typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim().slice(0, 8)
    : "browser";
  if (kind === "sub_session") {
    return `Sub-session ${suffix}`;
  }
  if (kind === "cronjob") {
    return `Cronjob ${suffix}`;
  }
  return `Session ${suffix}`;
}

export function browserSessionStatusLabel(
  runtimeState: SessionRuntimeRecordPayload | null | undefined,
): string {
  const status = normalizedRuntimeStatus(runtimeState);
  if (ACTIVE_BROWSER_SESSION_STATUSES.has(status)) {
    return "Operating";
  }
  if (status === "WAITING_USER") {
    return "Waiting";
  }
  if (status === "PAUSED") {
    return "Paused";
  }
  if (status === "ERROR") {
    return "Error";
  }
  return "Idle";
}

export function compareBrowserSessionOptions(
  left: AgentSessionRecordPayload,
  right: AgentSessionRecordPayload,
  runtimeStatesBySessionId: Record<string, SessionRuntimeRecordPayload>,
): number {
  const leftPriority = browserSessionPriority(
    runtimeStatesBySessionId[left.session_id] ?? null,
  );
  const rightPriority = browserSessionPriority(
    runtimeStatesBySessionId[right.session_id] ?? null,
  );
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return (
    new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  );
}

function browserSessionPriority(
  runtimeState: SessionRuntimeRecordPayload | null | undefined,
): number {
  const status = normalizedRuntimeStatus(runtimeState);
  if (ACTIVE_BROWSER_SESSION_STATUSES.has(status)) {
    return 0;
  }
  if (status === "WAITING_USER") {
    return 1;
  }
  if (status === "PAUSED") {
    return 2;
  }
  return 3;
}

export function browserSurfaceStatusSummary(params: {
  browserSpace: BrowserSpaceId;
  controlMode: BrowserTabListPayload["controlMode"];
  lifecycleState: BrowserTabListPayload["lifecycleState"];
  runtimeState: SessionRuntimeRecordPayload | null;
}): {
  label: string;
  detail: string;
  tone: "idle" | "active" | "waiting" | "paused" | "error";
  flashing: boolean;
} | null {
  const runtimeStatus = normalizedRuntimeStatus(params.runtimeState);
  const waiting =
    runtimeStatus === "WAITING_USER" ||
    params.runtimeState?.last_turn_status?.trim().toLowerCase() === "waiting_user";
  const paused =
    runtimeStatus === "PAUSED" ||
    params.runtimeState?.last_turn_status?.trim().toLowerCase() === "paused";
  const errored =
    runtimeStatus === "ERROR" ||
    params.runtimeState?.last_turn_status?.trim().toLowerCase() === "error" ||
    params.runtimeState?.last_turn_status?.trim().toLowerCase() === "failed";
  const active = ACTIVE_BROWSER_SESSION_STATUSES.has(runtimeStatus);

  if (active) {
    return {
      label: "Active",
      detail:
        params.browserSpace === "user"
          ? "Your input will ask for confirmation before interrupting this session."
          : "This session currently controls its own browser surface.",
      tone: "active",
      flashing: true,
    };
  }

  if (waiting) {
    return {
      label: "Waiting",
      detail:
        params.browserSpace === "user"
          ? "The shared user browser is still owned by this session until it is interrupted or the lock expires."
          : "The session browser is warm and ready to continue.",
      tone: "waiting",
      flashing: false,
    };
  }

  if (paused) {
    return {
      label: "Paused",
      detail:
        params.browserSpace === "user"
          ? "The session was paused and user takeover is available."
          : "This session browser can be resumed later.",
      tone: "paused",
      flashing: false,
    };
  }

  if (errored) {
    return {
      label: "Error",
      detail:
        params.browserSpace === "user"
          ? "The session encountered an error while controlling the shared browser."
          : "The session browser remains available for inspection.",
      tone: "error",
      flashing: false,
    };
  }

  if (params.lifecycleState === "suspended") {
    return {
      label: "Sleeping",
      detail: "Tabs were serialized and will be rehydrated when this session is reopened.",
      tone: "idle",
      flashing: false,
    };
  }

  if (params.controlMode === "user_locked") {
    return {
      label: "Locked",
      detail:
        "The shared user browser is reserved for one session. Interaction will ask before interrupting it.",
      tone: "waiting",
      flashing: false,
    };
  }

  return null;
}
