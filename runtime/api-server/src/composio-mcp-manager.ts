import fs from "node:fs";
import path from "node:path";

import type {
  RuntimeStateStore,
  WorkspaceIntegrationOverrideRecord,
} from "@holaboss/runtime-state-store";

import {
  bootstrapComposioMcpForWorkspace,
  buildToolkitCatalogAsync,
  type BootstrapComposioMcpResult,
} from "./composio-tool-registry.js";
import { isInStoreCatalog } from "./integration-store-catalog.js";
import {
  ComposioService,
  type ComposioConnectionSummary,
} from "./composio-service.js";
import {
  WORKSPACE_DEFAULT_TARGET_TYPE,
} from "./active-account-resolver.js";

type ComposioMcpManagerStore = Pick<
  RuntimeStateStore,
  | "listWorkspaceIntegrationOverrides"
  | "getIntegrationBindingByTarget"
>;

export interface ComposioMcpManagerDeps {
  composio: ComposioService;
  workspaceRoot: string;
  store?: ComposioMcpManagerStore | null;
  logger?: Pick<typeof console, "info" | "warn" | "error">;
}

export interface ComposioMcpEnsureResult {
  status: "started" | "reused" | "skipped";
  reason?: string;
  url?: string;
  tool_names?: string[];
  toolkit_slug?: string;
  connected_account_id?: string;
}

/**
 * Lifecycle-aware wrapper around bootstrapComposioMcpForWorkspace.
 *
 * - `ensureRunning(workspaceId)` is idempotent: subsequent calls return the
 *    cached BootstrapResult instead of starting a second host (which would
 *    occupy a fresh port and overwrite the registry url to one that no MCP
 *    client connected to yet).
 * - `stopAll()` runs at runtime shutdown so hosts don't leak.
 * - If the runtime has no ComposioService configured (no auth cookie / no
 *    Hono base url), every call short-circuits with status: "skipped".
 */
export class ComposioMcpManager {
  private readonly composio: ComposioService;
  private readonly workspaceRoot: string;
  private readonly store: ComposioMcpManagerDeps["store"];
  private readonly logger: NonNullable<ComposioMcpManagerDeps["logger"]>;
  private readonly cache = new Map<string, BootstrapComposioMcpResult>();
  private readonly inFlight = new Map<string, Promise<ComposioMcpEnsureResult>>();

  constructor(deps: ComposioMcpManagerDeps) {
    this.composio = deps.composio;
    this.workspaceRoot = deps.workspaceRoot;
    this.store = deps.store ?? null;
    this.logger = deps.logger ?? console;
  }

  async ensureRunning(workspaceId: string): Promise<ComposioMcpEnsureResult> {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      return {
        status: "reused",
        url: cached.url,
        tool_names: cached.toolNames,
      };
    }
    const pending = this.inFlight.get(workspaceId);
    if (pending) {
      return await pending;
    }

    const task = this.startUnsafe(workspaceId).finally(() => {
      this.inFlight.delete(workspaceId);
    });
    this.inFlight.set(workspaceId, task);
    return await task;
  }

  private async startUnsafe(workspaceId: string): Promise<ComposioMcpEnsureResult> {
    const workspaceDir = path.join(this.workspaceRoot, workspaceId);
    if (!fs.existsSync(workspaceDir)) {
      return { status: "skipped", reason: "workspace_not_found" };
    }

    let connections: ComposioConnectionSummary[];
    try {
      connections = await this.composio.listConnections();
    } catch (error) {
      this.logger.warn(
        "composio-mcp manager: listConnections failed, skipping bootstrap",
        error,
      );
      return { status: "skipped", reason: "list_connections_failed" };
    }

    const active = connections.filter(
      (conn) => conn.status === "ACTIVE" && isInStoreCatalog(conn.toolkitSlug),
    );
    if (active.length === 0) {
      return { status: "skipped", reason: "no_active_connection" };
    }

    const overrides = this.readOverrides(workspaceId);
    const overrideFiltered = applyOverrides(active, overrides);
    if (overrideFiltered.length === 0) {
      return { status: "skipped", reason: "all_toolkits_disabled_in_workspace" };
    }
    // When a workspace has multiple active accounts for the same toolkit
    // (e.g. two gmail accounts), the host can only register one set of
    // tools per toolkit — registering both produces duplicate tool names
    // and the second silently overwrites the first. Pick one connection
    // per toolkit using the active-account resolver (which honors the
    // workspace_default binding when set, else falls back to first
    // active). Resolver is the same one composio.execute / the runtime
    // tool layer uses, so direct-call and MCP-routed paths land on the
    // same default.
    const selected = this.pickOnePerToolkit(workspaceId, overrideFiltered);
    const fetchTools = (slug: string) => this.composio.listToolkitTools(slug);
    const catalogPerConn = await Promise.all(
      selected.map((conn) => buildToolkitCatalogAsync(conn.toolkitSlug, conn.id, fetchTools)),
    );
    const catalog = catalogPerConn.flat();
    if (catalog.length === 0) {
      return { status: "skipped", reason: "no_tools_resolved" };
    }
    const pick = selected[0]!;

    let result: BootstrapComposioMcpResult;
    try {
      result = await bootstrapComposioMcpForWorkspace({
        workspaceDir,
        honoBaseUrl: this.composio.honoBaseUrl,
        authCookie: this.composio.authCookie,
        catalog,
        composioService: this.composio,
      });
    } catch (error) {
      this.logger.error(
        "composio-mcp manager: bootstrap failed",
        { workspaceId, toolkit: pick.toolkitSlug, err: error },
      );
      return { status: "skipped", reason: "bootstrap_failed" };
    }

    this.cache.set(workspaceId, result);
    this.logger.info(
      "composio-mcp manager: started",
      {
        workspaceId,
        toolkit: pick.toolkitSlug,
        connectedAccountId: pick.id,
        url: result.url,
        toolNames: result.toolNames,
      },
    );

    return {
      status: "started",
      url: result.url,
      tool_names: result.toolNames,
      toolkit_slug: pick.toolkitSlug,
      connected_account_id: pick.id,
    };
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.cache.entries());
    this.cache.clear();
    await Promise.all(
      entries.map(async ([workspaceId, result]) => {
        try {
          await result.close();
        } catch (error) {
          this.logger.warn(
            "composio-mcp manager: close failed",
            { workspaceId, err: error },
          );
        }
      }),
    );
  }

  /**
   * Tear down the workspace's host and bootstrap a fresh one. Called when
   * workspace integration overrides change so the next agent run sees the
   * updated tool list without waiting for a runtime restart.
   */
  async restart(workspaceId: string): Promise<ComposioMcpEnsureResult> {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      this.cache.delete(workspaceId);
      try {
        await cached.close();
      } catch (error) {
        this.logger.warn(
          "composio-mcp manager: close-before-restart failed",
          { workspaceId, err: error },
        );
      }
    }
    return await this.ensureRunning(workspaceId);
  }

  /** Currently running hosts. Exposed for tests + debug endpoints. */
  inspectRunning(): Array<{ workspace_id: string; url: string; tool_names: string[] }> {
    return Array.from(this.cache.entries()).map(([workspaceId, result]) => ({
      workspace_id: workspaceId,
      url: result.url,
      tool_names: result.toolNames,
    }));
  }

  private readOverrides(workspaceId: string): WorkspaceIntegrationOverrideRecord[] {
    if (!this.store) return [];
    try {
      return this.store.listWorkspaceIntegrationOverrides({ workspaceId });
    } catch (error) {
      this.logger.warn(
        "composio-mcp manager: listWorkspaceIntegrationOverrides failed",
        { workspaceId, err: error },
      );
      return [];
    }
  }

  /** Group connections by toolkit slug and pick a single representative
   *  per toolkit. When the workspace has set a `workspace_default`
   *  binding for the toolkit, use that connection; otherwise use the
   *  first active connection (lexicographic on connection_id for
   *  deterministic ordering). The picked connection is what the
   *  composio-mcp host registers tools against. */
  private pickOnePerToolkit(
    workspaceId: string,
    connections: ComposioConnectionSummary[],
  ): ComposioConnectionSummary[] {
    const byToolkit = new Map<string, ComposioConnectionSummary[]>();
    for (const conn of connections) {
      const slug = conn.toolkitSlug.trim().toLowerCase();
      if (!slug) continue;
      const list = byToolkit.get(slug) ?? [];
      list.push(conn);
      byToolkit.set(slug, list);
    }
    const picked: ComposioConnectionSummary[] = [];
    for (const [slug, candidates] of byToolkit) {
      if (candidates.length === 0) continue;
      if (candidates.length === 1) {
        picked.push(candidates[0]!);
        continue;
      }
      const defaultConnectionId = this.store
        ? this.workspaceDefaultConnectionId(workspaceId, slug)
        : null;
      const match = defaultConnectionId
        ? candidates.find((conn) => conn.id === defaultConnectionId)
        : null;
      picked.push(match ?? candidates[0]!);
    }
    return picked;
  }

  private workspaceDefaultConnectionId(
    workspaceId: string,
    providerId: string,
  ): string | null {
    if (!this.store) return null;
    try {
      const binding = this.store.getIntegrationBindingByTarget({
        workspaceId,
        targetType: WORKSPACE_DEFAULT_TARGET_TYPE,
        targetId: workspaceId,
        integrationKey: providerId,
      });
      return binding?.connectionId ?? null;
    } catch (error) {
      this.logger.warn(
        "composio-mcp manager: workspace_default lookup failed",
        { workspaceId, providerId, err: error },
      );
      return null;
    }
  }
}

/**
 * Apply workspace overrides to the candidate active connections.
 * - 'disabled' toolkit → drop every connection for that toolkit.
 * - 'pinned'   toolkit → keep only the pinned ca_id (and only if still
 *                        present in candidates; otherwise drop the toolkit
 *                        rather than silently fall back to a different
 *                        account the user didn't choose).
 * - no override → keep the first ACTIVE per toolkit (current default).
 *
 * Exported for unit testing.
 */
export function applyOverrides(
  candidates: ComposioConnectionSummary[],
  overrides: WorkspaceIntegrationOverrideRecord[],
): ComposioConnectionSummary[] {
  const byToolkit = new Map<string, WorkspaceIntegrationOverrideRecord>();
  for (const o of overrides) byToolkit.set(o.toolkitSlug, o);

  const grouped = new Map<string, ComposioConnectionSummary[]>();
  for (const conn of candidates) {
    const list = grouped.get(conn.toolkitSlug);
    if (list) list.push(conn);
    else grouped.set(conn.toolkitSlug, [conn]);
  }

  const result: ComposioConnectionSummary[] = [];
  for (const [toolkitSlug, conns] of grouped) {
    const override = byToolkit.get(toolkitSlug);
    if (override?.state === "disabled") {
      continue;
    }
    if (override?.state === "pinned") {
      const pinned = override.pinnedConnectionId
        ? conns.find((c) => c.id === override.pinnedConnectionId)
        : null;
      if (pinned) result.push(pinned);
      continue;
    }
    if (conns[0]) result.push(conns[0]);
  }
  return result;
}
