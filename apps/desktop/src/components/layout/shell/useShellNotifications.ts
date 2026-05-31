import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

/**
 * Self-contained runtime-notification polling for the new shell. Mirrors the
 * subset of AppShell's `refreshNotifications` flow that the toast stack needs:
 * pull every 3 s, route each unread item by window focus + active workspace,
 * and expose dismiss / activate handlers.
 *
 * Routing rules (parallels AppShell's classifiers):
 *  - Window minimized / blurred → fire native OS notification, mark dismissed.
 *  - Window focused AND notification's workspace is the active one →
 *    silently dismiss (the user is already looking at it).
 *  - Otherwise (focused but different workspace) → surface as in-app toast.
 */

const POLL_INTERVAL_MS = 3000;
const MAX_TOAST_NOTIFICATIONS = 4;
const NATIVE_NOTIFICATION_RETRY_WINDOW_MS = 15_000;

function notificationMetadataString(
  notification: RuntimeNotificationRecordPayload,
  key: string,
): string | null {
  const raw = notification.metadata[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function notificationTargetSessionId(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "session_id");
}

function notificationActionUrl(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "action_url");
}

function notificationDeliveryChannel(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  const delivery = notification.metadata.delivery;
  if (
    delivery &&
    typeof delivery === "object" &&
    !Array.isArray(delivery) &&
    typeof (delivery as { channel?: unknown }).channel === "string"
  ) {
    return (delivery as { channel: string }).channel.trim() || null;
  }
  return null;
}

function isSystemCronjobNotification(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type === "cronjob" &&
    notificationDeliveryChannel(notification) === "system_notification"
  );
}

function shouldIncludeRuntimeNotificationInShell(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type !== "cronjob" ||
    isSystemCronjobNotification(notification)
  );
}

function notificationBelongsToWorkspace(
  notification: RuntimeNotificationRecordPayload,
  workspaceId: string | null,
): boolean {
  const target = notification.workspace_id.trim();
  const active = workspaceId?.trim() || "";
  return Boolean(target && active && target === active);
}

export interface UseShellNotificationsResult {
  notifications: RuntimeNotificationRecordPayload[];
  dismiss: (notificationId: string) => Promise<void>;
  activate: (notificationId: string) => Promise<{
    workspaceId: string;
    sessionId: string | null;
    actionUrl: string | null;
  } | null>;
}

export function useShellNotifications(): UseShellNotificationsResult {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [notifications, setNotifications] = useState<
    RuntimeNotificationRecordPayload[]
  >([]);
  const byIdRef = useRef(
    new Map<string, RuntimeNotificationRecordPayload>(),
  );
  // Items we've already side-effected (native fired OR silently dismissed)
  // so we don't double-handle them while the runtime is still catching up
  // on the dismissed-state write.
  const handledIdsRef = useRef(new Set<string>());
  const nativeAttemptedAtRef = useRef(new Map<string, number>());

  const [windowFocused, setWindowFocused] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const windowFocusedRef = useRef(windowFocused);
  windowFocusedRef.current = windowFocused;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  selectedWorkspaceIdRef.current = selectedWorkspaceId;

  const handleNotification = useCallback(
    async (
      notification: RuntimeNotificationRecordPayload,
      windowAway: boolean,
      activeWorkspaceId: string | null,
    ): Promise<"toast" | "consumed"> => {
      // Window away → native OS notification + dismiss in store.
      if (windowAway) {
        const lastAttempt =
          nativeAttemptedAtRef.current.get(notification.id) ?? 0;
        if (Date.now() - lastAttempt < NATIVE_NOTIFICATION_RETRY_WINDOW_MS) {
          return "consumed";
        }
        nativeAttemptedAtRef.current.set(notification.id, Date.now());
        try {
          const shown = await window.electronAPI.ui.showNativeNotification({
            title: notification.title,
            body: notification.message,
            workspaceId: notification.workspace_id,
            sessionId: notificationTargetSessionId(notification),
            force: isSystemCronjobNotification(notification),
          });
          if (shown) {
            nativeAttemptedAtRef.current.delete(notification.id);
            try {
              await window.electronAPI.workspace.updateNotification(
                notification.workspace_id,
                notification.id,
                { state: "dismissed" },
              );
            } catch {
              // The seen set prevents duplicate firings even if write fails.
            }
          }
        } catch {
          // Transient native-bridge failure — let the next poll retry.
        }
        return "consumed";
      }

      // Window focused AND notification belongs to the active workspace →
      // silently dismiss; the user is already looking at the source.
      if (
        notificationBelongsToWorkspace(notification, activeWorkspaceId) &&
        !isSystemCronjobNotification(notification)
      ) {
        try {
          await window.electronAPI.workspace.updateNotification(
            notification.workspace_id,
            notification.id,
            { state: "dismissed" },
          );
        } catch {
          // Reconcile on the next poll.
        }
        return "consumed";
      }

      // Window focused, different workspace → surface as in-app toast.
      return "toast";
    },
    [],
  );

  const refresh = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!window.electronAPI) return;
      try {
        const response =
          await window.electronAPI.workspace.listNotifications(null, false, {
            includeCronjobSource: true,
          });
        if (signal.cancelled) return;
        const shellItems = response.items
          .filter(shouldIncludeRuntimeNotificationInShell)
          .filter((item) => item.state === "unread")
          .sort(
            (left, right) =>
              Date.parse(right.created_at) - Date.parse(left.created_at),
          );

        const windowAway = !windowFocusedRef.current;
        const activeWorkspaceId = selectedWorkspaceIdRef.current;

        const toasts: RuntimeNotificationRecordPayload[] = [];
        for (const item of shellItems) {
          if (handledIdsRef.current.has(item.id)) {
            continue;
          }
          const outcome = await handleNotification(
            item,
            windowAway,
            activeWorkspaceId,
          );
          if (signal.cancelled) return;
          if (outcome === "toast") {
            toasts.push(item);
          } else {
            handledIdsRef.current.add(item.id);
          }
        }

        const visible = toasts.slice(0, MAX_TOAST_NOTIFICATIONS);
        byIdRef.current = new Map(visible.map((item) => [item.id, item]));
        setNotifications(visible);
      } catch {
        // Transient API failures are non-fatal — next tick reconciles.
      }
    },
    [handleNotification],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(signal);
    const timer = window.setInterval(() => {
      void refresh(signal);
    }, POLL_INTERVAL_MS);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  // Re-run routing immediately when focus or active workspace changes so a
  // workspace switch instantly clears toasts that now match the active one.
  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [refresh, windowFocused, selectedWorkspaceId]);

  const dismiss = useCallback(
    async (notificationId: string) => {
      const target = byIdRef.current.get(notificationId);
      if (!target) return;
      setNotifications((current) =>
        current.filter((item) => item.id !== notificationId),
      );
      byIdRef.current.delete(notificationId);
      handledIdsRef.current.add(notificationId);
      try {
        await window.electronAPI.workspace.updateNotification(
          target.workspace_id,
          target.id,
          { state: "dismissed" },
        );
      } catch {
        // Reconcile via the next poll.
      }
    },
    [],
  );

  const activate = useCallback(
    async (notificationId: string) => {
      const target = byIdRef.current.get(notificationId);
      if (!target) return null;
      setNotifications((current) =>
        current.filter((item) => item.id !== notificationId),
      );
      byIdRef.current.delete(notificationId);
      handledIdsRef.current.add(notificationId);
      try {
        await window.electronAPI.workspace.updateNotification(
          target.workspace_id,
          target.id,
          { state: "read" },
        );
      } catch {
        // Activation continues even if the state-write fails.
      }
      return {
        workspaceId: target.workspace_id.trim(),
        sessionId: notificationTargetSessionId(target),
        actionUrl: notificationActionUrl(target),
      };
    },
    [],
  );

  return { notifications, dismiss, activate };
}
