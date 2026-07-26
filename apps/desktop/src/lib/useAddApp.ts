import { useCallback } from "react";
import {
  type AddAppOutcome,
  addApp,
  type ConnectableEntry,
} from "./addApp";
import { bindConnectionToWorkspace } from "./bindConnectionToWorkspace";
import { marketplace } from "./holaAppMarketplace";
import { useIntegrationConnect } from "./useIntegrationConnect";
import { useWorkspaceDesktop } from "./workspaceDesktop";

/**
 * The one "add this App" verb for the renderer. Wires {@link addApp}'s pure
 * orchestration to the real deps — OAuth via {@link useIntegrationConnect}, bind
 * via {@link bindConnectionToWorkspace}, MCP-ensure over the workspace bridge,
 * and module/hosted install through the marketplace source.
 *
 * It re-exposes the connect hook's reactive `status` / `cancel` so a caller can
 * still render Connecting / Cancel / Done / Error while `add(...)` runs — the
 * OAuth drives that state exactly as a bare `useIntegrationConnect` would.
 */
export function useAddApp() {
  const { selectedWorkspace } = useWorkspaceDesktop();
  const workspaceId = selectedWorkspace?.id ?? null;
  const { connect, status, isConnecting, cancel, reset } =
    useIntegrationConnect();

  const add = useCallback(
    (entry: ConnectableEntry): Promise<AddAppOutcome> =>
      addApp(entry, {
        workspaceId,
        connect,
        bind: bindConnectionToWorkspace,
        ensureComposioMcp: async (id) => {
          await window.electronAPI.workspace.composioMcpEnsureRunning(id);
        },
        installApp: async (id) => {
          await marketplace.install(id);
        },
      }),
    [workspaceId, connect],
  );

  return { add, status, isConnecting, cancel, reset };
}
