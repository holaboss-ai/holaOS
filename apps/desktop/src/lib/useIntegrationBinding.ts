import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

// Shared state machine for the "connect/bind a provider account to an app"
// interaction. Same logic used by:
//   - The chat-side `IntegrationConnectCard` (pending_integrations emit)
//   - The App Surface header bind control (per-installed-app, persistent)
//
// Layout/markup stays in each consumer — this hook owns only:
//   * fetch (connections + bindings)
//   * derive the state-machine kind
//   * three actions: connect (OAuth + bind + restart), bind (select existing
//     connection), refresh (re-read after external change)
//   * busy/error mutex per action

export type IntegrationBindingState =
  | { kind: "loading" }
  | { kind: "no_workspace" }
  | { kind: "no_connection" }
  | { kind: "needs_binding"; candidates: IntegrationConnectionPayload[] }
  | {
      kind: "bound";
      activeConnection: IntegrationConnectionPayload;
      otherActiveConnections: IntegrationConnectionPayload[];
    };

export type IntegrationBindingBusy = "connecting" | "binding" | null;

export interface UseIntegrationBindingResult {
  state: IntegrationBindingState;
  busy: IntegrationBindingBusy;
  errorMessage: string;
  refresh: () => Promise<void>;
  connect: () => Promise<void>;
  bind: (connectionId: string) => Promise<void>;
  // Abort the in-flight `connect()` flow. No-op when nothing is running.
  // Used by the UI when the user closes the OAuth window or explicitly
  // clicks the Cancel affordance — without it, a rejected OAuth leaves
  // the poll loop spinning for the full 5-minute timeout.
  cancel: () => void;
}

export interface UseIntegrationBindingArgs {
  appId: string;
  // Composio toolkit slug == binding integration_key == OAuth provider id.
  provider: string;
  whoami?: PendingIntegrationWhoami | null;
  // Optional callback fired after a successful connect or bind, so callers
  // can refresh sibling state (e.g. integrationContext mirror in AppSurfacePane).
  onAfterBind?: () => void;
  // When true, treat a workspace-default binding for this provider as
  // "bound" even if no app-level binding exists. The App Surface uses this
  // so a previously-connected gmail (workspace-default) shows as bound for
  // every gmail-shaped app without per-app re-bind. The chat-side Connect
  // card leaves this false on purpose — it wants the user to explicitly
  // bind to the new app the agent just built.
  considerWorkspaceDefault?: boolean;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown error";
}

export function useIntegrationBinding({
  appId,
  provider,
  whoami,
  onAfterBind,
  considerWorkspaceDefault = false,
}: UseIntegrationBindingArgs): UseIntegrationBindingResult {
  const { connectIntegrationProvider } = useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const [state, setState] = useState<IntegrationBindingState>({ kind: "loading" });
  const [busy, setBusy] = useState<IntegrationBindingBusy>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const connectAbortRef = useRef<AbortController | null>(null);

  // Abort any in-flight connect when the component unmounts so a poll
  // loop doesn't outlive the surface that started it.
  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort();
      connectAbortRef.current = null;
    };
  }, []);

  const trimmedProvider = provider.trim();
  const providerKey = trimmedProvider.toLowerCase();
  const trimmedAppId = appId.trim();

  const refresh = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setState({ kind: "no_workspace" });
      return;
    }
    if (!trimmedProvider || !trimmedAppId) {
      setState({ kind: "no_connection" });
      return;
    }
    try {
      const [connectionsResp, bindingsResp] = await Promise.all([
        window.electronAPI.workspace.listIntegrationConnections(),
        window.electronAPI.workspace.listIntegrationBindings(selectedWorkspaceId),
      ]);
      const activeConnections = connectionsResp.connections.filter(
        (c) =>
          c.provider_id.toLowerCase() === providerKey && c.status === "active",
      );
      if (activeConnections.length === 0) {
        setState({ kind: "no_connection" });
        return;
      }
      const appBinding = bindingsResp.bindings.find(
        (b) =>
          b.target_type === "app" &&
          b.target_id === trimmedAppId &&
          b.integration_key.toLowerCase() === providerKey,
      );
      const workspaceDefaultBinding = considerWorkspaceDefault
        ? bindingsResp.bindings.find(
            (b) =>
              b.target_type === "workspace" &&
              b.target_id === "default" &&
              b.integration_key.toLowerCase() === providerKey,
          )
        : undefined;
      const effectiveBinding = appBinding ?? workspaceDefaultBinding;
      if (effectiveBinding) {
        const active = activeConnections.find(
          (c) => c.connection_id === effectiveBinding.connection_id,
        );
        if (active) {
          setState({
            kind: "bound",
            activeConnection: active,
            otherActiveConnections: activeConnections.filter(
              (c) => c.connection_id !== active.connection_id,
            ),
          });
          return;
        }
      }
      setState({ kind: "needs_binding", candidates: activeConnections });
    } catch (error) {
      setErrorMessage(normalizeErrorMessage(error));
      setState({ kind: "no_connection" });
    }
  }, [
    selectedWorkspaceId,
    providerKey,
    trimmedAppId,
    trimmedProvider,
    considerWorkspaceDefault,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Bindings can change from outside this hook — agent-driven binds (chat
  // → runtime → main → state-store) and Settings-driven binds don't go
  // through `connect()` / `bind()` here, so the sidebar's status dot
  // would otherwise stay stuck on its mount-time value forever. Poll every
  // 8s as a low-cost catchall: two IPC reads per AppRow per integration,
  // negligible at typical scale. The 8s cadence is fast enough that a
  // user finishing a chat-side connect sees the dot flip "ready" before
  // they look back at the sidebar.
  useEffect(() => {
    if (!selectedWorkspaceId || !trimmedProvider || !trimmedAppId) return;
    const id = setInterval(() => {
      void refresh();
    }, 8000);
    return () => clearInterval(id);
  }, [selectedWorkspaceId, trimmedProvider, trimmedAppId, refresh]);

  // The running app captured HOLABOSS_APP_GRANT at boot in its bridge
  // transport. Any bind change is invisible until the app process cycles —
  // unconditional restart is cheaper than diffing.
  const rebootAppAfterBindChange = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    try {
      await window.electronAPI.workspace.restartApp(selectedWorkspaceId, trimmedAppId);
    } catch {
      // Bind succeeded; restart can fail when the app isn't running yet
      // (initial connect before first start) or lifecycle is unavailable.
      // Next agent call surfaces the real error if grant is genuinely stale.
    }
  }, [selectedWorkspaceId, trimmedAppId]);

  const cancel = useCallback(() => {
    const controller = connectAbortRef.current;
    if (!controller) return;
    connectAbortRef.current = null;
    controller.abort();
  }, []);

  const connect = useCallback(async () => {
    if (!selectedWorkspaceId || !trimmedProvider || !trimmedAppId) return;
    // Cancel any prior in-flight connect — the user clicked Connect again
    // while an earlier attempt was still polling. Don't leak two parallel
    // poll loops.
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;

    setBusy("connecting");
    setErrorMessage("");
    try {
      const { connectionId } = await connectIntegrationProvider({
        provider: trimmedProvider,
        appId: trimmedAppId,
        whoami: whoami ?? null,
        signal: controller.signal,
      });
      // If the user clicked Cancel between OAuth success and bind, skip
      // the bind too — the connection record still exists in Composio
      // but the user no longer wants it wired into this app.
      if (controller.signal.aborted) return;
      // Bind the freshly-issued connection. Prefer the explicit id from
      // connectIntegrationProvider over a re-list match because brand-new
      // accounts can race the listIntegrationConnections cache.
      await window.electronAPI.workspace.upsertIntegrationBinding(
        selectedWorkspaceId,
        "app",
        trimmedAppId,
        trimmedProvider,
        { connection_id: connectionId },
      );
      await rebootAppAfterBindChange();
      await refresh();
      onAfterBind?.();
    } catch (error) {
      // User-driven cancellation (Cancel button or the workspace's
      // internal IntegrationConnectCancelled sentinel from
      // workspaceDesktop.tsx). Silent — re-rendering the Connect button
      // is signal enough; an error banner would be noise.
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "IntegrationConnectCancelled");
      if (!aborted) {
        setErrorMessage(normalizeErrorMessage(error));
      }
    } finally {
      if (connectAbortRef.current === controller) {
        connectAbortRef.current = null;
      }
      setBusy(null);
    }
  }, [
    selectedWorkspaceId,
    trimmedProvider,
    trimmedAppId,
    whoami,
    connectIntegrationProvider,
    rebootAppAfterBindChange,
    refresh,
    onAfterBind,
  ]);

  const bind = useCallback(
    async (connectionId: string) => {
      if (!selectedWorkspaceId || !trimmedProvider || !trimmedAppId) return;
      setBusy("binding");
      setErrorMessage("");
      try {
        await window.electronAPI.workspace.upsertIntegrationBinding(
          selectedWorkspaceId,
          "app",
          trimmedAppId,
          trimmedProvider,
          { connection_id: connectionId },
        );
        await rebootAppAfterBindChange();
        await refresh();
        onAfterBind?.();
      } catch (error) {
        setErrorMessage(normalizeErrorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [
      selectedWorkspaceId,
      trimmedProvider,
      trimmedAppId,
      rebootAppAfterBindChange,
      refresh,
      onAfterBind,
    ],
  );

  return { state, busy, errorMessage, refresh, connect, bind, cancel };
}
