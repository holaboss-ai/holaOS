import { useCallback, useRef } from "react";
import { useSetAtom } from "jotai";
import { NotificationToastStack } from "@/components/layout/NotificationToastStack";
import {
  activeWebAppSurfaceAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
} from "./state/ui";
import { useShellNotifications } from "./useShellNotifications";

/**
 * New-shell binding of the shared NotificationToastStack to runtime
 * notifications. Activating a session-bound notification routes the user to
 * the matching workspace; URL-bound notifications open externally; everything
 * else just switches workspaces so the click is at least visible.
 */
export function NotificationStack() {
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setChatSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const { notifications, dismiss, activate } = useShellNotifications();
  const sessionRequestKeyRef = useRef(0);

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
      if (target.sessionId) {
        sessionRequestKeyRef.current += 1;
        setChatPanelView("chat");
        // Navigating to a notification's session leaves any HolaApp surface —
        // clear it so its API-key gate doesn't leak onto this session.
        setActiveWebAppSurface(null);
        setChatSessionOpenRequest({
          sessionId: target.sessionId,
          requestKey: sessionRequestKeyRef.current,
          mode: "session",
        });
      }
      if (target.actionUrl && !target.sessionId) {
        try {
          // Content link → the Default profile's browser window, not the OS browser.
          await window.electronAPI.profiles.launch(
            "bprofile_default",
            target.actionUrl,
          );
        } catch {
          // Transient open failures are not surfaced.
        }
      }
    },
    [
      activate,
      setActiveWebAppSurface,
      setChatPanelView,
      setChatSessionOpenRequest,
    ],
  );

  return (
    <NotificationToastStack
      notifications={notifications}
      onCloseToast={handleClose}
      onActivateNotification={handleActivate}
    />
  );
}
