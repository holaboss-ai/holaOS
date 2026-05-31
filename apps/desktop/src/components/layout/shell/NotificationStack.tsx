import { useCallback } from "react";
import { NotificationToastStack } from "@/components/layout/NotificationToastStack";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { useShellNotifications } from "./useShellNotifications";

/**
 * New-shell binding of the shared NotificationToastStack to runtime
 * notifications. Activating a session-bound notification routes the user to
 * the matching workspace; URL-bound notifications open externally; everything
 * else just switches workspaces so the click is at least visible.
 */
export function NotificationStack() {
  const { setSelectedWorkspaceId } = useWorkspaceSelection();
  const { notifications, dismiss, activate } = useShellNotifications();

  const handleClose = useCallback(
    (notificationId: string) => {
      void dismiss(notificationId);
    },
    [dismiss],
  );

  const handleActivate = useCallback(
    async (notificationId: string) => {
      const target = await activate(notificationId);
      if (!target) return;
      if (target.workspaceId) {
        setSelectedWorkspaceId(target.workspaceId);
      }
      if (target.actionUrl && !target.sessionId) {
        try {
          await window.electronAPI.ui.openExternalUrl(target.actionUrl);
        } catch {
          // Transient open-external failures are not surfaced.
        }
      }
    },
    [activate, setSelectedWorkspaceId],
  );

  return (
    <NotificationToastStack
      notifications={notifications}
      onCloseToast={handleClose}
      onActivateNotification={handleActivate}
    />
  );
}
