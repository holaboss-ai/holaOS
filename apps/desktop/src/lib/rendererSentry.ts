import * as Sentry from "@sentry/electron/renderer";
import { useEffect } from "react";

const MAX_RENDERER_SENTRY_ACTIVITY = 40;
const RENDERER_SENTRY_REDACTED_VALUE = "[REDACTED]";
const RENDERER_SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^authorization$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
];
const RENDERER_SENSITIVE_TEXT_ASSIGNMENT_PATTERN =
  /((?:token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|refresh[_-]?token|access[_-]?token)[^:=\n\r]{0,64}[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const RENDERER_AUTHORIZATION_BEARER_PATTERN =
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+(?:\s+[^\s,;]+)?/gi;

interface RendererSentryActivity {
  at: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const rendererSentrySections = new Map<string, Record<string, unknown>>();
const rendererSentryActivity: RendererSentryActivity[] = [];

function shouldRedactRendererSentryKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  return RENDERER_SENSITIVE_KEY_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function redactRendererSentryValue(
  value: unknown,
  keyName = "",
): unknown {
  if (shouldRedactRendererSentryKey(keyName)) {
    if (value === null || value === undefined) {
      return value;
    }
    return RENDERER_SENTRY_REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactRendererSentryValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactRendererSentryValue(entry, key),
      ]),
    );
  }

  if (typeof value === "string") {
    return value
      .replace(
        RENDERER_AUTHORIZATION_BEARER_PATTERN,
        `$1${RENDERER_SENTRY_REDACTED_VALUE}`,
      )
      .replace(
        RENDERER_SENSITIVE_TEXT_ASSIGNMENT_PATTERN,
        `$1${RENDERER_SENTRY_REDACTED_VALUE}`,
      );
  }

  return value;
}

function rendererLocationSnapshot(): Record<string, unknown> {
  return {
    href: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    title: document.title,
    visibility_state: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
    user_agent: navigator.userAgent,
    language: navigator.language,
  };
}

function buildRendererSentrySnapshot(): Record<string, unknown> {
  return {
    captured_at: new Date().toISOString(),
    location: rendererLocationSnapshot(),
    sections: Object.fromEntries(rendererSentrySections.entries()),
    recent_activity: [...rendererSentryActivity],
  };
}

function addRendererSentryHintAttachment(
  hint: Sentry.EventHint | undefined,
  attachment: NonNullable<Sentry.EventHint["attachments"]>[number] | null,
) {
  if (!hint || !attachment) {
    return;
  }
  hint.attachments = [...(hint.attachments ?? []), attachment];
}

function normalizeRendererTagValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function setRendererSentrySection(
  name: string,
  value: Record<string, unknown> | null | undefined,
): void {
  if (!value) {
    rendererSentrySections.delete(name);
    return;
  }
  rendererSentrySections.set(
    name,
    redactRendererSentryValue(value) as Record<string, unknown>,
  );
}

export function clearRendererSentrySection(name: string): void {
  rendererSentrySections.delete(name);
}

export function useRendererSentrySection(
  name: string,
  value: Record<string, unknown> | null | undefined,
): void {
  useEffect(() => {
    setRendererSentrySection(name, value);
    return () => {
      clearRendererSentrySection(name);
    };
  }, [name, value]);
}

export function pushRendererSentryActivity(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const sanitizedData = data
    ? (redactRendererSentryValue(data) as Record<string, unknown>)
    : undefined;
  rendererSentryActivity.push({
    at: new Date().toISOString(),
    category,
    message,
    data: sanitizedData,
  });
  if (rendererSentryActivity.length > MAX_RENDERER_SENTRY_ACTIVITY) {
    rendererSentryActivity.splice(
      0,
      rendererSentryActivity.length - MAX_RENDERER_SENTRY_ACTIVITY,
    );
  }
  Sentry.addBreadcrumb({
    category: `renderer.${category}`,
    message,
    level: "info",
    data: sanitizedData,
  });
}

export function enrichRendererSentryEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint | undefined,
): Sentry.ErrorEvent {
  const snapshot = buildRendererSentrySnapshot();
  addRendererSentryHintAttachment(hint, {
    filename: "renderer-diagnostics.json",
    data: `${JSON.stringify(snapshot, null, 2)}\n`,
    contentType: "application/json",
  });

  const appShellState =
    (snapshot.sections as Record<string, Record<string, unknown> | undefined>)
      .app_shell ?? null;
  const chatPaneState =
    (snapshot.sections as Record<string, Record<string, unknown> | undefined>)
      .chat_pane ?? null;
  const selectedWorkspaceId =
    normalizeRendererTagValue(appShellState?.selected_workspace_id) ??
    normalizeRendererTagValue(chatPaneState?.workspace_id);
  const activeSessionId = normalizeRendererTagValue(chatPaneState?.session_id);

  event.tags = {
    ...(event.tags ?? {}),
    process_kind: "electron_renderer",
    ...(selectedWorkspaceId
      ? { selected_workspace_id: selectedWorkspaceId }
      : {}),
    ...(activeSessionId ? { active_session_id: activeSessionId } : {}),
  };
  event.contexts = {
    ...(event.contexts ?? {}),
    renderer_location:
      (snapshot.location as Record<string, unknown> | undefined) ?? {},
    renderer_state: {
      sections: snapshot.sections,
      recent_activity: snapshot.recent_activity,
    },
  };
  return event;
}
