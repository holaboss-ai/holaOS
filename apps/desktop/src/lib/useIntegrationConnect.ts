import { useCallback, useEffect, useRef, useState } from "react";
import {
  IntegrationConnectCancelled,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";

export type IntegrationConnectStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown }
  | { kind: "done"; connectionId: string };

export type IntegrationConnectOutcome =
  | { kind: "done"; connectionId: string }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

interface UseIntegrationConnectOptions {
  /** Fires once the OAuth poll loop returns a finalized connection_id.
   *  Useful for triggering follow-ups (rebind workspace apps, kick off
   *  context fetch) without waiting on the consumer to inspect status. */
  onDone?: (connectionId: string) => void | Promise<void>;
}

interface UseIntegrationConnectResult {
  status: IntegrationConnectStatus;
  isConnecting: boolean;
  /** Initiates OAuth + polling. Aborts any prior in-flight attempt — a
   *  retry click should not race with the abandoned one. */
  connect: (params: {
    provider: string;
    accountLabel?: string | null;
    whoami?: PendingIntegrationWhoami | null;
  }) => Promise<IntegrationConnectOutcome>;
  /** User-initiated cancel — aborts the AbortController so the
   *  workspaceDesktop poll loop's `throwIfAborted` short-circuits the
   *  ~5-minute timeout immediately. Safe to call when idle. */
  cancel: () => void;
  /** Reset to idle. Useful after handling a terminal error / cancellation
   *  so the caller can re-arm the flow without re-instantiating the hook. */
  reset: () => void;
}

/**
 * Reusable OAuth connect flow with cancel + lifecycle abort.
 *
 * The native `connectIntegrationProvider` is a poll loop that can hang
 * for ~5 minutes after the user closes the OAuth browser without
 * authorizing. This hook wraps it with:
 *   - AbortController per attempt so Cancel resolves instantly
 *   - lifecycle abort on unmount so closed cards don't leak running polls
 *   - tagged status state so the UI can render Connecting / Cancel / Done
 *     / Error without ad-hoc boolean toggles
 *
 * Per-instance state — mount one hook per connect surface. Multi-toolkit
 * parents that share a connect button across rows should still keep their
 * own per-row controllers (this hook is single-flight).
 */
export function useIntegrationConnect(
  options: UseIntegrationConnectOptions = {},
): UseIntegrationConnectResult {
  const { connectIntegrationProvider } = useWorkspaceDesktop();
  const abortControllerRef = useRef<AbortController | null>(null);
  const onDoneRef = useRef(options.onDone);
  const [status, setStatus] = useState<IntegrationConnectStatus>({
    kind: "idle",
  });

  // Keep callback ref fresh without re-creating `connect` on every render.
  useEffect(() => {
    onDoneRef.current = options.onDone;
  }, [options.onDone]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  const connect = useCallback<UseIntegrationConnectResult["connect"]>(
    async (params) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStatus({ kind: "connecting" });
      try {
        const result = await connectIntegrationProvider({
          ...params,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          setStatus({ kind: "cancelled" });
          return { kind: "cancelled" };
        }
        await onDoneRef.current?.(result.connectionId);
        setStatus({ kind: "done", connectionId: result.connectionId });
        return { kind: "done", connectionId: result.connectionId };
      } catch (error) {
        if (
          error instanceof IntegrationConnectCancelled ||
          controller.signal.aborted
        ) {
          setStatus({ kind: "cancelled" });
          return { kind: "cancelled" };
        }
        setStatus({ kind: "error", error });
        return { kind: "error", error };
      }
    },
    [connectIntegrationProvider],
  );

  return {
    status,
    isConnecting: status.kind === "connecting",
    connect,
    cancel,
    reset,
  };
}
