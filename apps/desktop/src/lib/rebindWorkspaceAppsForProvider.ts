import { composioToolkitMatchesProvider } from "@/lib/workspaceDesktop";

/**
 * After a fresh OAuth grant, migrate every app-scoped binding in the
 * workspace that matches this provider over to the new connection_id and
 * restart each affected app so it re-captures HOLABOSS_APP_GRANT at boot.
 * The agent's direct Composio path resolves on every call so it's already
 * current, but apps cache the grant at start time and would otherwise keep
 * using a stale (or absent) connection until next workspace reload.
 *
 * Best-effort: per-binding failures are swallowed so partial success still
 * helps the user, who already saw a "connected" confirmation upstream.
 */
export async function rebindWorkspaceAppsForProvider(params: {
  workspaceId: string;
  provider: string;
  connectionId: string;
}): Promise<void> {
  const { workspaceId, provider, connectionId } = params;
  let bindings: IntegrationBindingPayload[];
  try {
    const result =
      await window.electronAPI.workspace.listIntegrationBindings(workspaceId);
    bindings = result.bindings ?? [];
  } catch {
    return;
  }
  const matches = bindings.filter(
    (b) =>
      b.target_type === "app" &&
      composioToolkitMatchesProvider(b.integration_key, provider),
  );
  for (const binding of matches) {
    if (binding.connection_id === connectionId) continue;
    try {
      await window.electronAPI.workspace.upsertIntegrationBinding(
        workspaceId,
        "app",
        binding.target_id,
        binding.integration_key,
        { connection_id: connectionId },
      );
    } catch {
      continue;
    }
    try {
      await window.electronAPI.workspace.restartApp(
        workspaceId,
        binding.target_id,
      );
    } catch {
      // App may not be running — next agent run will pick up the fresh
      // grant on its first boot.
    }
  }
}
