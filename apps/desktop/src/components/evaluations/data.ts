import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import {
  type EvaluationDetail,
  type EvaluationRecord,
  hasActiveRuns,
  isRecord,
} from "./format";

const ACTIVE_RUN_POLL_MS = 2000;
const SESSION_REFRESH_DEBOUNCE_MS = 600;
const SESSION_REFRESH_EVENTS = new Set([
  "tool_completed",
  "run_completed",
  "run_failed",
]);

export function useEvaluationDetail(evalId: string) {
  return useQuery(
    remoteApiQuery.evals.get.queryOptions({
      input: { evalId },
      enabled: Boolean(evalId),
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: (query) =>
        hasActiveRuns(query.state.data?.runs) ? ACTIVE_RUN_POLL_MS : false,
    }),
  );
}

export function useEvaluationTargets(enabled = true) {
  return useQuery(
    remoteApiQuery.evals.targets.queryOptions({
      input: {},
      enabled,
      staleTime: 10_000,
    }),
  );
}

export function useInvalidateEvaluation(evalId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (update?: {
      detail?: EvaluationDetail;
      evaluation?: EvaluationRecord;
    }) => {
      const getKey = remoteApiQuery.evals.get.queryKey({ input: { evalId } });
      if (update?.detail) {
        queryClient.setQueryData(getKey, update.detail);
      } else if (update?.evaluation) {
        const evaluation = update.evaluation;
        queryClient.setQueryData(getKey, (previous) =>
          previous ? { ...previous, evaluation } : previous,
        );
      }
      await Promise.all([
        update?.detail
          ? Promise.resolve()
          : queryClient.invalidateQueries({
              queryKey: remoteApiQuery.evals.get.key({ input: { evalId } }),
            }),
        queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.report.key({ input: { evalId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        }),
      ]);
    },
    [evalId, queryClient],
  );
}

// The agent edits the evaluation through tool calls in its bound session.
export function useRefreshOnSessionActivity(
  sessionId: string | null,
  onActivity: () => void,
) {
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  useEffect(() => {
    const normalized = sessionId?.trim();
    const subscribe = window.electronAPI?.workspace?.onSessionStreamEvent;
    if (!normalized || typeof subscribe !== "function") {
      return;
    }
    let timer: number | null = null;
    const unsubscribe = subscribe((payload) => {
      if (payload.type !== "event") {
        return;
      }
      const data = payload.event?.data;
      if (!isRecord(data)) {
        return;
      }
      if (data.session_id !== normalized) {
        return;
      }
      const eventType =
        typeof data.event_type === "string"
          ? data.event_type
          : (payload.event?.event ?? "");
      if (!SESSION_REFRESH_EVENTS.has(eventType)) {
        return;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = null;
        onActivityRef.current();
      }, SESSION_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [sessionId]);
}
