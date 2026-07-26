// Thin selector over the persistent employee-chat store (chatStore.ts). All the
// streaming/accumulation lives in the store + the app-level EmployeeChatStreamManager,
// so a turn survives this pane unmounting (navigate away) and resumes on return.

import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import type {
  AttachmentListItem,
  ChatExecutionTimelineItem,
} from "@/components/panes/ChatPane/types";
import {
  type EmployeeArtifact,
  type EmployeeChatMessage,
  EMPTY_THREAD_STATE,
  employeeChatThreadsAtom,
  ensureThreadLoaded,
  type OutboundAttachment,
  sendEmployeeMessage,
  stopEmployeeStream,
  threadKey,
} from "./chatStore";

export type {
  EmployeeArtifact,
  EmployeeChatMessage,
  OutboundAttachment,
} from "./chatStore";

export interface UseEmployeeChat {
  messages: EmployeeChatMessage[];
  isLoadingHistory: boolean;
  liveText: string | null;
  liveExecutionItems: ChatExecutionTimelineItem[];
  lastArtifacts: EmployeeArtifact[];
  lastArtifactMessageId: string | null;
  isStreaming: boolean;
  error: string | null;
  send: (
    text: string,
    attachments?: OutboundAttachment[],
    displayAttachments?: AttachmentListItem[],
  ) => void;
  /** Stop the in-progress turn (keeps whatever streamed so far). */
  stop: () => void;
}

export function useEmployeeChat(
  employeeId: string,
  threadId: string,
  isNew = false,
): UseEmployeeChat {
  const key = threadKey(employeeId, threadId);
  const threads = useAtomValue(employeeChatThreadsAtom);
  const state = threads[key] ?? EMPTY_THREAD_STATE;

  useEffect(() => {
    void ensureThreadLoaded(employeeId, threadId, isNew);
  }, [employeeId, threadId, isNew]);

  const send = useCallback(
    (
      text: string,
      attachments?: OutboundAttachment[],
      displayAttachments?: AttachmentListItem[],
    ) =>
      sendEmployeeMessage(
        employeeId,
        threadId,
        text,
        attachments,
        displayAttachments,
      ),
    [employeeId, threadId],
  );
  const stop = useCallback(
    () => stopEmployeeStream(employeeId, threadId),
    [employeeId, threadId],
  );

  return useMemo(
    () => ({
      messages: state.messages,
      isLoadingHistory: state.isLoadingHistory,
      liveText: state.liveText,
      liveExecutionItems: state.liveExecutionItems,
      lastArtifacts: state.lastArtifacts,
      lastArtifactMessageId: state.lastArtifactMessageId,
      isStreaming: state.isStreaming,
      error: state.error,
      send,
      stop,
    }),
    [state, send, stop],
  );
}
