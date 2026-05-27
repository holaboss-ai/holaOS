import {
  type AgentSessionRecord,
  type RuntimeStateStore,
  type WorkspaceRecord,
} from "@holaboss/runtime-state-store";

const DESKTOP_MAIN_SESSION_CHANNEL = "desktop";
const MAIN_SESSION_CONVERSATION_KEY = "main_session";
const MAIN_SESSION_ROLE = "main_session";

function normalizedSessionId(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizedCoordinatorSessionKind(
  kind: string | null | undefined,
): string {
  const normalized = (kind ?? "").trim().toLowerCase() || "main_session";
  switch (normalized) {
    case "workspace_session":
    case "main":
      return "main_session";
    case "onboarding":
      return "workspace_onboarding";
    default:
      return normalized;
  }
}

export function isCoordinatorSessionKind(
  kind: string | null | undefined,
): boolean {
  const normalized = normalizedCoordinatorSessionKind(kind);
  return (
    normalized === "main_session" ||
    normalized === "workspace_onboarding" ||
    normalized === "meeting_mode"
  );
}

function isActiveCoordinatorSession(
  session: AgentSessionRecord | null | undefined,
): session is AgentSessionRecord {
  if (!session) {
    return false;
  }
  return !session.archivedAt && isCoordinatorSessionKind(session.kind);
}

export function preferredCoordinatorSessionId(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  preferredSessionIds?: Array<string | null | undefined>;
}): string | null {
  const seen = new Set<string>();
  for (const candidate of params.preferredSessionIds ?? []) {
    const sessionId = normalizedSessionId(candidate);
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    const session = params.store.getSession({
      workspaceId: params.workspace.id,
      sessionId,
    });
    if (isActiveCoordinatorSession(session)) {
      return session.sessionId;
    }
  }

  const desktopBinding = params.store.getConversationBindingByConversation({
    workspaceId: params.workspace.id,
    channel: DESKTOP_MAIN_SESSION_CHANNEL,
    conversationKey: MAIN_SESSION_CONVERSATION_KEY,
    role: MAIN_SESSION_ROLE,
  });
  const desktopSessionId = normalizedSessionId(desktopBinding?.sessionId);
  if (desktopSessionId && !seen.has(desktopSessionId)) {
    const session = params.store.getSession({
      workspaceId: params.workspace.id,
      sessionId: desktopSessionId,
    });
    if (isActiveCoordinatorSession(session)) {
      return session.sessionId;
    }
  }

  const sessions = params.store.listSessions({
    workspaceId: params.workspace.id,
    includeArchived: false,
    limit: 200,
    offset: 0,
  });
  const preferredMainSession = sessions.find(
    (session) =>
      isActiveCoordinatorSession(session) &&
      normalizedCoordinatorSessionKind(session.kind) === "main_session",
  );
  if (preferredMainSession) {
    return preferredMainSession.sessionId;
  }

  return (
    sessions.find((session) => isActiveCoordinatorSession(session))?.sessionId ??
    null
  );
}
