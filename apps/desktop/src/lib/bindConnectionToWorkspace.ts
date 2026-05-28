import { rebindWorkspaceAppsForProvider } from "@/lib/rebindWorkspaceAppsForProvider";

/**
 * "I just chose this connection to power this provider in this workspace."
 * Used by three flows that all need the same two-step write:
 *   - Settings → Integrations → connect (IntegrationsPane.handleConnect)
 *   - Agent chat → propose_connect card (IntegrationProposalCard)
 *   - Onboarding → hero integration tile
 *
 * Two steps:
 *   1. Set this connection as the workspace's default account for the
 *      provider — but ONLY if no default is set yet. Won't clobber a
 *      user's previous "I want work-gmail for this workspace" choice.
 *   2. Rebind any app-scoped bindings that already point at a different
 *      connection for the same provider, and restart those apps. No-op
 *      for fresh workspaces (no apps installed yet).
 *
 * Best-effort throughout — partial success still helps the user; the
 * caller has already shown them a "connected" confirmation by this point.
 */
export async function bindConnectionToWorkspace(params: {
  workspaceId: string;
  providerSlug: string;
  connectionId: string;
}): Promise<void> {
  const { workspaceId, providerSlug, connectionId } = params;

  // Set workspace-default only if unset. Composio resolves
  // workspace-default at app-runtime when there's no app-scoped binding,
  // so this is what makes the integration "just work" in a fresh
  // workspace where no apps are bound yet.
  try {
    const existing =
      await window.electronAPI.workspace.getWorkspaceDefaultAccount(
        workspaceId,
        providerSlug,
      );
    if (!existing.connection_id) {
      await window.electronAPI.workspace.setWorkspaceDefaultAccount(
        workspaceId,
        providerSlug,
        connectionId,
      );
    }
  } catch {
    // Default-set is a convenience; failure shouldn't block.
  }

  // App-scoped rebind. No-op on fresh workspaces (no apps installed).
  await rebindWorkspaceAppsForProvider({
    workspaceId,
    provider: providerSlug,
    connectionId,
  });
}
