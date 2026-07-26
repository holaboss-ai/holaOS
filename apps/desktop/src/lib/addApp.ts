// One "add this App" verb across every App tier — the Step 2 orchestrator of the
// integrations↔HolaApp merge (docs/plans/2026-07-12-integrations-holaapp-merge.md).
//
// A connection-tier App (former "integration") is added by running the Composio
// OAuth, binding the connection to the workspace, and ensuring the shared Composio
// MCP server — no process. A module/hosted App is installed through the marketplace
// source, after connecting any integrations it requires. The connect step is the
// shared sub-process both branches run, so a required-integration connect and a
// bare integration connect are literally the same code path.
//
// Pure + dependency-injected: every side effect (OAuth, bind, ensure, install) is a
// passed-in dep, so the branching is unit-testable without React or the IPC bridge.
// The renderer wires the real deps (useIntegrationConnect.connect,
// bindConnectionToWorkspace, composioMcpEnsureRunning, marketplace.install) in Step 3.

import { type AppCatalogEntry, appKind } from "./holaAppMarketplace";
import type { IntegrationConnectOutcome } from "./useIntegrationConnect";

export type AddAppOutcome =
  | { kind: "connected"; connectionId: string }
  | { kind: "installed" }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

export interface AddAppDeps {
  /** The active workspace. When null (no workspace yet) a connection is still
   * established, but the workspace-scoped bind + MCP-ensure are skipped. */
  workspaceId: string | null;
  /** Run the Composio OAuth for a provider; resolves the finalized connection id.
   * Mirrors {@link useIntegrationConnect}'s `connect` outcome. */
  connect: (params: {
    provider: string;
    whoami?: PendingIntegrationWhoami | null;
  }) => Promise<IntegrationConnectOutcome>;
  /** Set the workspace-default account (if unset) + rebind app-scoped bindings. */
  bind: (params: {
    workspaceId: string;
    providerSlug: string;
    connectionId: string;
  }) => Promise<void>;
  /** Ensure the shared Composio MCP server is registered for the workspace. */
  ensureComposioMcp: (workspaceId: string) => Promise<void>;
  /** Install a module/hosted App through the marketplace source. */
  installApp: (holaAppId: string) => Promise<void>;
  /** Providers the workspace already holds an active connection for — a required
   * integration in this set is not re-OAuth'd. Absent ⇒ connect every required
   * one. */
  connectedProviders?: ReadonlySet<string>;
}

export type ConnectableEntry = Pick<
  AppCatalogEntry,
  "holaAppId" | "kind" | "surface" | "integrations"
>;

/** A minimal connection-tier entry for callers that hold only a provider slug
 * (a chat proposal card, an onboarding tile) — enough for {@link addApp} to run
 * the connect → bind → ensure flow. */
export function connectionAppEntry(slug: string): ConnectableEntry {
  return {
    holaAppId: slug,
    kind: "connection",
    surface: { type: "none" },
    integrations: [{ provider: slug, required: true }],
  };
}

/** The Composio provider slug a connection-tier App binds to: its first declared
 * integration, falling back to the app id (which, for a synthesized connection, IS
 * the slug). */
export function connectionProviderSlug(entry: ConnectableEntry): string {
  return entry.integrations?.[0]?.provider ?? entry.holaAppId;
}

/** Connect one provider and, when a workspace is active, bind + ensure MCP. The
 * sub-process shared by both the connection and the module/hosted branches. */
async function connectProvider(
  provider: string,
  whoami: PendingIntegrationWhoami | null | undefined,
  deps: AddAppDeps,
): Promise<
  { kind: "done"; connectionId: string } | { kind: "cancelled" } | { kind: "error"; error: unknown }
> {
  const outcome = await deps.connect({ provider, ...(whoami ? { whoami } : {}) });
  if (outcome.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  if (outcome.kind === "error") {
    return { kind: "error", error: outcome.error };
  }
  if (deps.workspaceId) {
    // Best-effort, exactly as IntegrationsPane.handleConnect: a failed default-set,
    // rebind, or ensure-run is recovered on the next workspace reload / tool call —
    // it must not fail the whole add.
    try {
      await deps.bind({
        workspaceId: deps.workspaceId,
        providerSlug: provider,
        connectionId: outcome.connectionId,
      });
    } catch {
      // recovered on next reload
    }
    try {
      await deps.ensureComposioMcp(deps.workspaceId);
    } catch {
      // runtime re-ensures on next tool invocation
    }
  }
  return { kind: "done", connectionId: outcome.connectionId };
}

/** Add an App to the active workspace, branching on its tier. */
export async function addApp(
  entry: ConnectableEntry,
  deps: AddAppDeps,
): Promise<AddAppOutcome> {
  if (appKind(entry) === "connection") {
    const result = await connectProvider(
      connectionProviderSlug(entry),
      entry.integrations?.[0]?.whoami,
      deps,
    );
    if (result.kind === "done") {
      return { kind: "connected", connectionId: result.connectionId };
    }
    return result;
  }

  // module / hosted: connect every required integration not already connected,
  // then install. A cancel or error on any required connect aborts the install.
  const required = (entry.integrations ?? []).filter((i) => i.required);
  for (const integration of required) {
    if (deps.connectedProviders?.has(integration.provider)) {
      continue;
    }
    const result = await connectProvider(
      integration.provider,
      integration.whoami,
      deps,
    );
    if (result.kind !== "done") {
      return result;
    }
  }

  try {
    await deps.installApp(entry.holaAppId);
    return { kind: "installed" };
  } catch (error) {
    return { kind: "error", error };
  }
}
