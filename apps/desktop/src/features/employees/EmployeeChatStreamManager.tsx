// Mounted ONCE (in AppShell). Owns the single global HolaEmployee SSE subscription
// and routes every event into the persistent chat store — so employee turns keep
// streaming even when no chat pane is mounted (you navigated away). Renders nothing.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { handleEmployeeStreamEvent } from "./chatStore";

export function EmployeeChatStreamManager() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const off = window.electronAPI.holaemployee.onChatStreamEvent((payload) =>
      handleEmployeeStreamEvent(payload, queryClient),
    );
    return off;
  }, [queryClient]);
  return null;
}
