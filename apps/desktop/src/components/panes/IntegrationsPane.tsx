import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  ShieldAlert,
  Unplug,
} from "lucide-react";
import { AddIntegrationDialog } from "@/components/panes/AddIntegrationDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { accountDisplayLabel } from "@/lib/integrationDisplay";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import {
  invalidateIntegrationAccountCache,
  useIntegrationAccountMetadata,
} from "@/lib/integrationAccountStore";
import {
  composioToolkitMatchesProvider,
  composioToolkitSlugForProvider,
} from "@/lib/workspaceDesktop";

interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  auth_schemes: string[];
  categories: string[];
}

interface IntegrationCard {
  slug: string;
  providerId: string;
  name: string;
  description: string;
  logo: string | null;
  authSchemes: string[];
  categories: string[];
  supportsManaged: boolean;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function normalizedText(value: string | null | undefined): string {
  return (value || "").trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function providerIdForToolkit(slug: string): string {
  return slug.trim().toLowerCase();
}

const CONTEXT_FETCH_SUPPORTED_PROVIDERS = new Set([
  "gmail",
  "github",
  "notion",
  "slack",
]);
const CONTEXT_FETCH_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "unsupported",
]);

function supportsContextFetchProvider(providerId: string | null | undefined): boolean {
  return CONTEXT_FETCH_SUPPORTED_PROVIDERS.has(normalizedText(providerId).toLowerCase());
}

function contextFetchChunkTotal(status: IntegrationContextFetchStatusPayload) {
  if (status.chunks_total > 0) {
    return status.chunks_total;
  }
  if (status.status === "completed") {
    return Math.max(status.chunks_completed, 1);
  }
  return 0;
}

function contextFetchProgressPercent(
  status: IntegrationContextFetchStatusPayload,
) {
  const total = contextFetchChunkTotal(status);
  if (total <= 0) {
    return status.status === "completed" ? 100 : 0;
  }
  return Math.max(
    0,
    Math.min(100, Math.round((status.chunks_completed / total) * 100)),
  );
}

function contextFetchDisplayMessage(
  status: IntegrationContextFetchStatusPayload,
) {
  if (!status.supported) {
    return status.reason || `${status.provider_id} context fetch is not implemented yet.`;
  }
  if (status.status === "failed") {
    return status.error_message || `${status.provider_id} context fetch failed.`;
  }
  const label = status.account_label || status.account_key || status.provider_id;
  if (status.status === "completed") {
    return `Fetched ${status.provider_id} context for ${label}: ${status.messages_seen} messages scanned, ${status.leaves_created} new leaves, ${status.leaves_superseding} updated, ${status.leaves_unchanged} unchanged.`;
  }
  const chunkTotal = contextFetchChunkTotal(status);
  const chunkPrefix =
    chunkTotal > 0
      ? `${Math.min(status.chunks_completed, chunkTotal)}/${chunkTotal} chunks`
      : "Starting import";
  return `${label}: ${chunkPrefix}${status.current_chunk_label ? ` - ${status.current_chunk_label}` : ""}`;
}

// Composio publishes a stable logo CDN keyed by toolkit slug — usable as
// a fallback when our local toolkit lookup misses (e.g., the toolkit got
// filtered by `composio_managed_auth_schemes` requirements, or the
// catalog uses a slug that doesn't show up in toolkitByProvider after
// the gmail/sheets→google remap collapse).
function composioFallbackLogo(slug: string): string | null {
  const cleaned = slug.trim().toLowerCase();
  if (!cleaned) {
    return null;
  }
  return `https://logos.composio.dev/api/${cleaned}`;
}

function mergeIntegrationCards(
  catalogProviders: IntegrationCatalogProviderPayload[],
  toolkits: ComposioToolkit[],
): IntegrationCard[] {
  const toolkitByProvider = new Map<string, ComposioToolkit>();
  for (const toolkit of toolkits) {
    const providerId = providerIdForToolkit(toolkit.slug);
    if (!toolkitByProvider.has(providerId)) {
      toolkitByProvider.set(providerId, toolkit);
    }
  }

  const cards: IntegrationCard[] = [];
  const seenProviderIds = new Set<string>();

  for (const provider of catalogProviders) {
    const providerId = normalizedText(provider.provider_id).toLowerCase();
    if (!providerId) {
      continue;
    }
    seenProviderIds.add(providerId);
    const toolkit = toolkitByProvider.get(providerId);
    const toolkitCategories = uniqueStrings(toolkit?.categories || []);

    cards.push({
      slug: providerId,
      providerId,
      name:
        normalizedText(provider.display_name) ||
        normalizedText(toolkit?.name) ||
        providerId,
      description:
        normalizedText(toolkit?.description) ||
        normalizedText(provider.description) ||
        normalizedText(provider.display_name) ||
        providerId,
      logo: toolkit?.logo ?? composioFallbackLogo(providerId),
      authSchemes: uniqueStrings([
        ...(toolkit?.auth_schemes || []),
        ...(provider.auth_modes || []),
      ]),
      categories: toolkitCategories.length > 0 ? toolkitCategories : ["other"],
      supportsManaged: provider.supports_managed !== false,
    });
  }

  for (const [providerId, toolkit] of toolkitByProvider.entries()) {
    if (seenProviderIds.has(providerId)) {
      continue;
    }
    const toolkitCategories = uniqueStrings(toolkit.categories || []);
    cards.push({
      slug: providerId,
      providerId,
      name: normalizedText(toolkit.name) || providerId,
      description: normalizedText(toolkit.description) || providerId,
      logo: toolkit.logo,
      authSchemes: uniqueStrings(toolkit.auth_schemes || []),
      categories: toolkitCategories.length > 0 ? toolkitCategories : ["other"],
      supportsManaged: true,
    });
  }

  return cards.sort((left, right) => left.name.localeCompare(right.name));
}

export function IntegrationsPane({ embedded }: { embedded?: boolean } = {}) {
  const authSessionState = useDesktopAuthSession();
  const isSignedIn = Boolean(authSessionState.data?.user?.id?.trim());
  const [integrations, setIntegrations] = useState<IntegrationCard[]>([]);
  const [connections, setConnections] = useState<
    IntegrationConnectionPayload[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectingProviderId, setConnectingProviderId] = useState<
    string | null
  >(null);
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<
    string | null
  >(null);
  const [refreshingConnectionId, setRefreshingConnectionId] = useState<
    string | null
  >(null);
  const [togglingContextAutoFetchConnectionId, setTogglingContextAutoFetchConnectionId] =
    useState<string | null>(null);
  const [contextFetchStatusByConnectionId, setContextFetchStatusByConnectionId] =
    useState<Record<string, IntegrationContextFetchStatusPayload>>({});
  const [statusMessage, setStatusMessage] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [workspaceUsageByConnection, setWorkspaceUsageByConnection] = useState<
    Map<string, ConnectionWorkspaceUsageEntry["workspaces"]>
  >(new Map());
  const [capabilitiesByToolkit, setCapabilitiesByToolkit] = useState<
    Record<string, ComposioToolkitCapability[]>
  >({});
  const [storeCatalog, setStoreCatalog] = useState<
    Map<string, IntegrationStoreCatalogEntry>
  >(new Map());
  const [overridesByToolkit, setOverridesByToolkit] = useState<
    Map<string, Map<string, AllWorkspaceIntegrationOverridesPayload["overrides"][number]>>
  >(new Map());
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [mutatingOverrideKey, setMutatingOverrideKey] = useState<string | null>(null);
  const { workspaces } = useWorkspaceDesktop();
  const accountMetadata = useIntegrationAccountMetadata(connections);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [
        catalogResult,
        connectionResult,
        toolkitResult,
        usageResult,
        capabilitiesResult,
        storeCatalogResult,
        overridesResult,
      ] = await Promise.all([
        window.electronAPI.workspace.listIntegrationCatalog(),
        window.electronAPI.workspace.listIntegrationConnections(),
        window.electronAPI.workspace
          .composioListToolkits()
          .catch(() => ({ toolkits: [] as ComposioToolkit[] })),
        window.electronAPI.workspace
          .listConnectionWorkspaceUsage()
          .catch(() => ({ usage: [] as ConnectionWorkspaceUsageEntry[] })),
        window.electronAPI.workspace
          .listComposioToolkitCapabilities()
          .catch(() => ({ toolkits: {} as Record<string, ComposioToolkitCapability[]> })),
        window.electronAPI.workspace
          .listIntegrationStoreCatalog()
          .catch(() => ({ entries: [] as IntegrationStoreCatalogEntry[] })),
        window.electronAPI.workspace
          .listAllWorkspaceIntegrationOverrides()
          .catch(() => ({
            overrides: [] as AllWorkspaceIntegrationOverridesPayload["overrides"],
          })),
      ]);
      setIntegrations(
        mergeIntegrationCards(catalogResult.providers, toolkitResult.toolkits),
      );
      setConnections(connectionResult.connections);
      const usageMap = new Map<string, ConnectionWorkspaceUsageEntry["workspaces"]>();
      for (const entry of usageResult.usage) {
        usageMap.set(entry.connection_id, entry.workspaces);
      }
      setWorkspaceUsageByConnection(usageMap);
      setCapabilitiesByToolkit(capabilitiesResult.toolkits ?? {});
      const storeMap = new Map<string, IntegrationStoreCatalogEntry>();
      for (const entry of storeCatalogResult.entries) {
        storeMap.set(entry.slug.trim().toLowerCase(), entry);
      }
      setStoreCatalog(storeMap);
      const ovMap = new Map<
        string,
        Map<string, AllWorkspaceIntegrationOverridesPayload["overrides"][number]>
      >();
      for (const o of overridesResult.overrides) {
        const key = o.toolkit_slug.toLowerCase();
        let inner = ovMap.get(key);
        if (!inner) {
          inner = new Map();
          ovMap.set(key, inner);
        }
        inner.set(o.workspace_id, o);
      }
      setOverridesByToolkit(ovMap);
    } catch (error) {
      setIntegrations([]);
      setConnections([]);
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [isSignedIn, loadData]);

  const runningContextFetchConnectionIds = useMemo(
    () =>
      Object.values(contextFetchStatusByConnectionId)
        .filter((status) => status.status === "running")
        .map((status) => status.connection_id)
        .sort(),
    [contextFetchStatusByConnectionId],
  );
  const runningContextFetchConnectionIdsKey =
    runningContextFetchConnectionIds.join("|");

  useEffect(() => {
    if (runningContextFetchConnectionIds.length === 0) {
      return;
    }
    let cancelled = false;
    async function pollStatuses() {
      try {
        const response =
          await window.electronAPI.workspace.listIntegrationContextFetchStatuses(
            runningContextFetchConnectionIds,
          );
        if (cancelled) {
          return;
        }
        let completionMessage = "";
        setContextFetchStatusByConnectionId((prev) => {
          const next = { ...prev };
          for (const status of response.statuses) {
            const previous = prev[status.connection_id];
            next[status.connection_id] = status;
            if (
              previous?.status === "running" &&
              CONTEXT_FETCH_TERMINAL_STATUSES.has(status.status)
            ) {
              completionMessage = contextFetchDisplayMessage(status);
            }
          }
          return next;
        });
        if (completionMessage) {
          void loadData();
          setStatusMessage(completionMessage);
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(normalizeErrorMessage(error));
        }
      }
    }
    void pollStatuses();
    const intervalId = window.setInterval(() => {
      void pollStatuses();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadData, runningContextFetchConnectionIds, runningContextFetchConnectionIdsKey]);

  // Auto-reconcile duplicates that pre-date the dedupe-on-finalize fix.
  // When the same real account got connected twice (each Composio re-auth
  // mints a new connected_account_id, and pre-fix rows had no handle/
  // email persisted to match against), users see two rows for one
  // identity — exactly the screenshot bug.
  //
  // After whoami enrichment populates accountMetadata, we group active
  // connections by (provider, resolved-identity). For any group with ≥ 2
  // rows, keep the oldest as canonical, backfill identity on rows that
  // don't have it persisted, then call merge to repoint bindings + drop
  // the duplicates. The reconcile-in-flight ref guards against re-entry
  // while loadData() refreshes.
  const reconcileInFlightRef = useRef(false);
  useEffect(() => {
    if (reconcileInFlightRef.current) return;
    if (connections.length < 2) return;
    if (accountMetadata.size === 0) return;

    // Defer until enrichment has had a chance to probe every connection
    // that *could* be probed (i.e. the ones with an external_id). Without
    // this guard the effect can fire mid-enrichment, miss a still-loading
    // duplicate, and then re-fire as more probe results stream in. With
    // the guard we run at most once per fully-populated metadata snapshot.
    const probeable = connections.filter(
      (c) => typeof c.account_external_id === "string" && c.account_external_id.length > 0,
    );
    const haveAllProbeResultsOrPersistedIdentity = probeable.every(
      (c) =>
        accountMetadata.has(c.connection_id) ||
        Boolean(c.account_handle) ||
        Boolean(c.account_email),
    );
    if (!haveAllProbeResultsOrPersistedIdentity) return;

    type IdentityKey = string;
    const groupKey = (
      provider: string,
      handle: string | null,
      email: string | null,
    ): IdentityKey | null => {
      const provNorm = provider.trim().toLowerCase();
      if (!provNorm) return null;
      const handleNorm = (handle ?? "").trim().toLowerCase();
      const emailNorm = (email ?? "").trim().toLowerCase();
      if (!handleNorm && !emailNorm) return null;
      // Prefer handle as the dedupe key — emails can occasionally vary
      // (gmail+aliases) where handles don't.
      return handleNorm
        ? `${provNorm}|h:${handleNorm}`
        : `${provNorm}|e:${emailNorm}`;
    };

    const groups = new Map<IdentityKey, IntegrationConnectionPayload[]>();
    for (const conn of connections) {
      if (conn.status !== "active") continue;
      const meta = accountMetadata.get(conn.connection_id) ?? null;
      const handle = conn.account_handle ?? meta?.handle ?? null;
      const email = conn.account_email ?? meta?.email ?? null;
      const key = groupKey(conn.provider_id, handle, email);
      if (!key) continue;
      const list = groups.get(key);
      if (list) list.push(conn);
      else groups.set(key, [conn]);
    }

    const duplicateGroups = Array.from(groups.values()).filter(
      (list) => list.length >= 2,
    );
    if (duplicateGroups.length === 0) return;

    reconcileInFlightRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        for (const group of duplicateGroups) {
          if (cancelled) return;
          // Sort oldest → newest by created_at; oldest wins so existing
          // bindings on it survive the merge with no repoint churn.
          const sorted = group
            .slice()
            .sort((a, b) =>
              (a.created_at ?? "").localeCompare(b.created_at ?? ""),
            );
          const [keep, ...remove] = sorted;
          if (!keep || remove.length === 0) continue;

          // Backfill identity on any row that doesn't have it persisted —
          // including the keep row, so future finalize calls deduplicate
          // against it cleanly.
          for (const conn of [keep, ...remove]) {
            if (cancelled) return;
            if (conn.account_handle || conn.account_email) continue;
            const meta = accountMetadata.get(conn.connection_id);
            const handle = meta?.handle ?? null;
            const email = meta?.email ?? null;
            if (!handle && !email) continue;
            try {
              await window.electronAPI.workspace.updateIntegrationConnection(
                conn.connection_id,
                { account_handle: handle, account_email: email },
              );
            } catch {
              // Tolerate per-row backfill failure — the merge still
              // works because we pass connection ids explicitly.
            }
          }

          if (cancelled) return;
          try {
            await window.electronAPI.workspace.mergeIntegrationConnections(
              keep.connection_id,
              remove.map((r) => r.connection_id),
            );
            // Drop cache entries for the removed connections so other
            // panes (AppSurfacePane picker, AppCatalogCard) don't keep
            // showing stale rows after the merge.
            invalidateIntegrationAccountCache(remove.map((r) => r.connection_id));
          } catch {
            // Surface via reload — listConnections will re-render
            // current state including any partial merges.
          }
        }
        if (!cancelled) {
          await loadData();
        }
      } finally {
        reconcileInFlightRef.current = false;
      }
    })();
    return () => {
      // Component unmount or deps changed mid-flight: stop the async
      // chain at the next checkpoint so we don't fire setState (via
      // loadData) on an unmounted tree.
      cancelled = true;
    };
    // We intentionally exclude loadData from deps — it's a stable
    // useCallback in this component, and including it would re-run the
    // effect on every successful loadData (which is what we trigger
    // here, leading to a tight loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, accountMetadata]);

  // Zombie sweep: when enrichment returns a tombstone (status: "missing")
  // for a row, the upstream Composio account is gone. Delete the local
  // row so the user isn't stuck with a "Gmail (Managed)" entry that can't
  // be refreshed, won't dedupe, and survives a normal Disconnect on
  // pre-rename builds.
  const zombieSweepInFlightRef = useRef(false);
  useEffect(() => {
    if (zombieSweepInFlightRef.current) return;
    if (connections.length === 0) return;
    const zombies = connections.filter(
      (c) => accountMetadata.get(c.connection_id)?.status === "missing",
    );
    if (zombies.length === 0) return;
    zombieSweepInFlightRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        for (const zombie of zombies) {
          if (cancelled) return;
          try {
            await window.electronAPI.workspace.deleteIntegrationConnection(
              zombie.connection_id,
            );
          } catch {
            // Per-row failure is fine — next mount will retry.
          }
        }
        if (!cancelled) {
          invalidateIntegrationAccountCache(zombies.map((z) => z.connection_id));
          await loadData();
        }
      } finally {
        zombieSweepInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, accountMetadata]);


  // Map providerId → all active connections. A user can have multiple accounts
  // per provider (e.g., personal + work Twitter); each connection is its own
  // row in the Connected section, each with its own delete button.
  const connectionsByProviderId = useMemo(() => {
    const map = new Map<string, IntegrationConnectionPayload[]>();
    for (const conn of connections) {
      if (normalizedText(conn.status).toLowerCase() !== "active") {
        continue;
      }
      const key = normalizedText(conn.provider_id).toLowerCase();
      const list = map.get(key);
      if (list) {
        list.push(conn);
      } else {
        map.set(key, [conn]);
      }
    }
    return map;
  }, [connections]);

  const connectedProviderIds = useMemo(
    () => new Set(connectionsByProviderId.keys()),
    [connectionsByProviderId],
  );

  const connectedIntegrations = useMemo(
    () =>
      integrations.filter((integration) =>
        connectedProviderIds.has(integration.providerId),
      ),
    [connectedProviderIds, integrations],
  );

  const dialogIntegrations = useMemo(
    () =>
      integrations
        .filter(
          (integration) =>
            storeCatalog.size === 0 || storeCatalog.has(integration.providerId),
        )
        .map((integration) => ({
          slug: integration.slug,
          providerId: integration.providerId,
          name: integration.name,
          description: integration.description,
          logo: integration.logo,
          categories: integration.categories,
          supportsManaged: integration.supportsManaged,
          tier: storeCatalog.get(integration.providerId)?.tier,
        })),
    [integrations, storeCatalog],
  );


  async function handleConnect(integration: IntegrationCard) {
    if (!isSignedIn) {
      void authSessionState.requestAuth();
      return;
    }
    if (!integration.supportsManaged) {
      setStatusMessage(
        `${integration.name} does not support managed sign-in in this runtime.`,
      );
      return;
    }

    setConnectingProviderId(integration.providerId);
    setStatusMessage("Complete authorization in your browser...");
    try {
      const runtimeConfig = await window.electronAPI.runtime.getConfig();
      const userId =
        runtimeConfig.userId ||
        authSessionState.data?.user?.id?.trim() ||
        "local";

      const toolkitSlug = composioToolkitSlugForProvider(integration.providerId);
      const link = await window.electronAPI.workspace.composioConnect({
        provider: toolkitSlug,
        owner_user_id: userId,
      });

      const connectedAccountId = link.connected_account_id;
      if (!connectedAccountId) {
        setStatusMessage(
          `${integration.name} did not return a connected account id. Please try again.`,
        );
        return;
      }

      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        let accountStatus;
        try {
          accountStatus =
            await window.electronAPI.workspace.composioAccountStatus(
              connectedAccountId,
              integration.providerId,
            );
          consecutiveErrors = 0;
        } catch (pollError) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw pollError;
          }
          continue;
        }

        const status = (accountStatus.status ?? "").toUpperCase();
        if (
          status === "FAILED" ||
          status === "EXPIRED" ||
          status === "INACTIVE" ||
          status === "MISSING"
        ) {
          setStatusMessage(
            `Authorization for ${integration.name} ${status.toLowerCase()}. Please try again.`,
          );
          return;
        }
        if (status !== "ACTIVE") {
          continue;
        }
        await window.electronAPI.workspace.composioFinalize({
          connected_account_id: connectedAccountId,
          provider: integration.providerId,
          owner_user_id: userId,
          account_label: `${integration.name} (Managed)`,
        });
        setStatusMessage("");
        void loadData();
        return;
      }

      setStatusMessage("Connection timed out.");
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setConnectingProviderId(null);
    }
  }

  const [pendingDisconnect, setPendingDisconnect] = useState<{
    connectionId: string;
    label: string;
    workspaceCount: number;
  } | null>(null);

  function handleDisconnect(connectionId: string) {
    const target = connections.find((c) => c.connection_id === connectionId);
    if (!target) return;
    const usage = workspaceUsageByConnection.get(connectionId) ?? [];
    const workspaceCount = new Set(usage.map((u) => u.workspace_id)).size;
    if (workspaceCount > 0) {
      setPendingDisconnect({
        connectionId,
        label: target.account_label || target.provider_id,
        workspaceCount,
      });
      return;
    }
    void performDisconnect(connectionId);
  }

  async function performDisconnect(connectionId: string) {
    setDisconnectingConnectionId(connectionId);
    setStatusMessage("");
    try {
      const target = connections.find(
        (c) => c.connection_id === connectionId,
      );
      const externalId = target?.account_external_id?.trim();
      // Revoke upstream first so the user's intent ("disconnect Gmail")
      // actually severs the Composio connected_account — otherwise a stale
      // upstream row keeps the OAuth grant alive and clutters the picker.
      // Composio 404 ⇒ already gone; treat as success and proceed locally.
      if (externalId) {
        try {
          await window.electronAPI.workspace.composioDeleteUpstream(
            externalId,
          );
        } catch (upstreamError) {
          setStatusMessage(normalizeErrorMessage(upstreamError));
          return;
        }
      }
      await window.electronAPI.workspace.deleteIntegrationConnection(
        connectionId,
      );
      invalidateIntegrationAccountCache([connectionId]);
      void loadData();
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setDisconnectingConnectionId(null);
    }
  }

  const setWorkspaceToolkitEnabled = useCallback(
    async (workspaceId: string, toolkitSlug: string, enabled: boolean) => {
      const key = `${workspaceId}:${toolkitSlug}`;
      setMutatingOverrideKey(key);
      setStatusMessage("");
      try {
        if (enabled) {
          await window.electronAPI.workspace.clearWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
          );
        } else {
          await window.electronAPI.workspace.setWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
            { state: "disabled" },
          );
        }
        await loadData();
      } catch (error) {
        setStatusMessage(normalizeErrorMessage(error));
      } finally {
        setMutatingOverrideKey(null);
      }
    },
    [loadData],
  );

  const setWorkspaceToolkitPin = useCallback(
    async (
      workspaceId: string,
      toolkitSlug: string,
      connectionId: string | "auto",
    ) => {
      const key = `${workspaceId}:${toolkitSlug}`;
      setMutatingOverrideKey(key);
      setStatusMessage("");
      try {
        if (connectionId === "auto") {
          await window.electronAPI.workspace.clearWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
          );
        } else {
          await window.electronAPI.workspace.setWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
            { state: "pinned", pinned_connection_id: connectionId },
          );
        }
        await loadData();
      } catch (error) {
        setStatusMessage(normalizeErrorMessage(error));
      } finally {
        setMutatingOverrideKey(null);
      }
    },
    [loadData],
  );

  async function handleRefresh(connectionId: string) {
    setRefreshingConnectionId(connectionId);
    setStatusMessage("");
    try {
      const result =
        await window.electronAPI.workspace.composioRefreshConnection(
          connectionId,
        );
      // Drop the cached whoami so other surfaces re-probe with the fresh
      // identity once the persisted handle/email come through loadData.
      invalidateIntegrationAccountCache([connectionId]);
      await loadData();
      if (result.changed) {
        setStatusMessage("Identity refreshed.");
      } else if (result.reason === "account_missing") {
        setStatusMessage(
          "Upstream account no longer exists — disconnect and reconnect to recover.",
        );
      } else if (result.reason === "no_external_id") {
        setStatusMessage("Connection has no external account to probe.");
      } else {
        setStatusMessage(
          "Provider didn't return a new handle or email — check dev console for proxy whoami details.",
        );
      }
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setRefreshingConnectionId(null);
    }
  }

  async function handleFetchContext(connectionId: string) {
    setStatusMessage("");
    try {
      const result = await window.electronAPI.workspace.fetchIntegrationContext(
        connectionId,
      );
      setContextFetchStatusByConnectionId((prev) => ({
        ...prev,
        [connectionId]: result.status,
      }));
      if (result.status.status === "completed") {
        await loadData();
      }
      setStatusMessage(contextFetchDisplayMessage(result.status));
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    }
  }

  async function handleToggleContextAutoFetch(
    connectionId: string,
    enabled: boolean,
  ) {
    setTogglingContextAutoFetchConnectionId(connectionId);
    setStatusMessage("");
    try {
      const updated = await window.electronAPI.workspace.updateIntegrationConnection(
        connectionId,
        { context_cron_auto_fetch_enabled: enabled },
      );
      setConnections((prev) =>
        prev.map((connection) =>
          connection.connection_id === connectionId ? updated : connection,
        ),
      );
      setStatusMessage(
        enabled
          ? "Background context fetch scheduled every 30 minutes."
          : "Background context fetch disabled for this account.",
      );
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setTogglingContextAutoFetchConnectionId(null);
    }
  }

  if (isLoading) {
    const skeletonCards = ["w-24", "w-20", "w-28", "w-16", "w-24", "w-20"];
    const skeletonGrid = (
      <div role="status" aria-busy="true" aria-label="Loading integrations">
        {/* Skeleton search bar */}
        <div className="mt-5 flex items-center gap-3">
          <div className="h-9 flex-1 animate-pulse rounded-lg bg-muted-foreground/20" />
          <div className="h-9 w-20 animate-pulse rounded-lg bg-muted-foreground/20" />
        </div>
        {/* Skeleton section label */}
        <div className="mt-6 h-3 w-24 animate-pulse rounded bg-muted-foreground/20" />
        {/* Skeleton cards */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {skeletonCards.map((descWidth, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
              key={index}
              className="flex items-center gap-3 rounded-xl border border-border px-3 py-3"
            >
              {/* Icon placeholder */}
              <div className="size-9 shrink-0 animate-pulse rounded-md bg-muted-foreground/20" />
              {/* Name + description */}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-16 animate-pulse rounded bg-muted-foreground/20" />
                <div
                  className={`h-2.5 animate-pulse rounded bg-muted-foreground/20 ${descWidth}`}
                />
              </div>
              {/* Button placeholder */}
              <div className="size-7 shrink-0 animate-pulse rounded-md bg-muted-foreground/20" />
            </div>
          ))}
        </div>
      </div>
    );

    const embeddedSkeleton = (
      <div role="status" aria-busy="true" aria-label="Loading integrations">
        <div className="mt-5 flex items-center gap-3">
          <div className="h-9 flex-1 animate-pulse rounded-lg bg-muted-foreground/20" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted-foreground/20" />
        </div>
        <div className="mt-6 h-4 w-28 animate-pulse rounded bg-muted-foreground/20" />
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {skeletonCards.slice(0, 4).map((descWidth, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
            <div
              key={index}
              className="flex items-start gap-3 rounded-xl bg-card p-3 ring-1 ring-border"
            >
              <div className="size-9 shrink-0 animate-pulse rounded-md bg-muted-foreground/20" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-24 animate-pulse rounded bg-muted-foreground/20" />
                <div
                  className={`h-2.5 animate-pulse rounded bg-muted-foreground/20 ${descWidth}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    );

    if (embedded) {
      return <div>{embeddedSkeleton}</div>;
    }

    return (
      <section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm">
        <div className="relative min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl px-6 py-6">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Integrations
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your accounts to use them in workspaces.
            </p>
            {skeletonGrid}
          </div>
        </div>
      </section>
    );
  }

  const integrationContent = (
    <>
      {/* Auth gate */}
      {!authSessionState.isPending && !isSignedIn ? (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-destructive">
              <ShieldAlert size={13} />
              <span>Sign-In Required</span>
            </div>
            <p className="mt-1 text-sm font-medium text-foreground">
              Managed integrations are unavailable until you sign in.
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              You can browse the catalog below, but connecting requires an
              authenticated session.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void authSessionState.requestAuth()}
          >
            <LogIn size={14} />
            Sign in
          </Button>
        </div>
      ) : null}

      {/* Connected — one card per provider, multiple account rows inside */}
      {connectedIntegrations.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase text-muted-foreground">
              Your integrations
            </h2>
            <Button
              onClick={() => setAddDialogOpen(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus className="mr-1.5 size-3.5" />
              Add integration
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {connectedIntegrations.map((integration) => (
              <ConnectedProviderCard
                canConnect={isSignedIn && integration.supportsManaged}
                compact={false}
                connectDisabledReason={
                  integration.supportsManaged
                    ? "Sign in first to connect another account."
                    : "Managed sign-in is not supported for this provider."
                }
                connecting={connectingProviderId === integration.providerId}
                connections={
                  connectionsByProviderId.get(integration.providerId) ?? []
                }
                disconnectingConnectionId={disconnectingConnectionId}
                integration={integration}
                key={integration.slug}
                metadata={accountMetadata}
                onConnect={() => void handleConnect(integration)}
                onDisconnect={(connectionId) =>
                  handleDisconnect(connectionId)
                }
                onRefresh={(connectionId) =>
                  void handleRefresh(connectionId)
                }
                onFetchContext={(connectionId) =>
                  void handleFetchContext(connectionId)
                }
                onToggleContextAutoFetch={(connectionId, enabled) =>
                  void handleToggleContextAutoFetch(connectionId, enabled)
                }
                expanded={expandedProviderId === integration.providerId}
                mutatingOverrideKey={mutatingOverrideKey}
                onSetWorkspaceEnabled={(workspaceId, enabled) =>
                  void setWorkspaceToolkitEnabled(
                    workspaceId,
                    integration.providerId,
                    enabled,
                  )
                }
                onToggleExpanded={() =>
                  setExpandedProviderId((prev) =>
                    prev === integration.providerId ? null : integration.providerId,
                  )
                }
                refreshingConnectionId={refreshingConnectionId}
                togglingContextAutoFetchConnectionId={
                  togglingContextAutoFetchConnectionId
                }
                contextFetchStatusByConnectionId={
                  contextFetchStatusByConnectionId
                }
                toolkitCapabilities={capabilitiesByToolkit[integration.providerId] ?? []}
                toolkitOverrides={
                  overridesByToolkit.get(integration.providerId) ?? new Map()
                }
                workspaceUsageByConnection={workspaceUsageByConnection}
                workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
              />
            ))}
          </div>
        </div>
      ) : null}

      {statusMessage ? (
        <p className="mt-4 text-sm text-muted-foreground">{statusMessage}</p>
      ) : null}

      {connectedIntegrations.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-10 text-center">
          <p className="text-sm text-foreground">No integrations yet.</p>
          <p className="max-w-xs text-xs leading-5 text-muted-foreground">
            Connect Gmail, Slack, Linear, and others so the agent can use them
            in your workspaces.
          </p>
          <Button
            disabled={!isSignedIn}
            onClick={() => setAddDialogOpen(true)}
            size="sm"
            type="button"
            variant="default"
          >
            <Plus className="mr-1.5 size-3.5" />
            Add integration
          </Button>
        </div>
      ) : null}

      <AddIntegrationDialog
        canConnect={isSignedIn}
        connectDisabledReason={
          isSignedIn
            ? "Managed sign-in is not supported for this provider."
            : "Sign in first to connect integrations."
        }
        connectedProviderIds={connectedProviderIds}
        connectingProviderId={connectingProviderId}
        integrations={dialogIntegrations}
        onConnect={(integration) => {
          setAddDialogOpen(false);
          void handleConnect({
            slug: integration.slug,
            providerId: integration.providerId,
            name: integration.name,
            description: integration.description,
            logo: integration.logo,
            authSchemes: [],
            categories: integration.categories,
            supportsManaged: integration.supportsManaged,
          });
        }}
        onOpenChange={setAddDialogOpen}
        open={addDialogOpen}
      />

      <ConfirmDialog
        confirmLabel="Disconnect"
        description={
          pendingDisconnect
            ? `${pendingDisconnect.label} is bound in ${pendingDisconnect.workspaceCount} workspace${pendingDisconnect.workspaceCount === 1 ? "" : "s"}. Disconnecting drops every binding and revokes the Composio account. Apps in those workspaces will lose access until you reconnect.`
            : ""
        }
        destructive
        onConfirm={() => {
          if (pendingDisconnect) {
            void performDisconnect(pendingDisconnect.connectionId);
            setPendingDisconnect(null);
          }
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
        open={Boolean(pendingDisconnect)}
        title="Disconnect this account?"
      />
    </>
  );

  if (embedded) {
    return (
      <div className="grid gap-6">
        {/* Auth gate */}
        {!authSessionState.isPending && !isSignedIn ? (
          <SettingsCard>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ShieldAlert size={13} className="text-destructive" />
                  <span>Sign-in required</span>
                </div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Managed integrations are unavailable until you sign in. You
                  can browse the catalog below, but connecting requires an
                  authenticated session.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void authSessionState.requestAuth()}
              >
                <LogIn size={14} />
                Sign in
              </Button>
            </div>
          </SettingsCard>
        ) : null}

        {statusMessage ? (
          <p className="text-sm text-muted-foreground">{statusMessage}</p>
        ) : null}

        {/* Connected section — one card per provider, multiple account rows */}
        {connectedIntegrations.length > 0 ? (
          <SettingsSection
            action={
              <Button
                disabled={!isSignedIn}
                onClick={() => setAddDialogOpen(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Plus className="mr-1.5 size-3.5" />
                Add integration
              </Button>
            }
            title="Your integrations"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {connectedIntegrations.map((integration) => (
                <ConnectedProviderCard
                  canConnect={isSignedIn && integration.supportsManaged}
                  compact
                  connectDisabledReason={
                    integration.supportsManaged
                      ? "Sign in first to connect another account."
                      : "Managed sign-in is not supported for this provider."
                  }
                  connecting={
                    connectingProviderId === integration.providerId
                  }
                  connections={
                    connectionsByProviderId.get(integration.providerId) ?? []
                  }
                  disconnectingConnectionId={disconnectingConnectionId}
                  integration={integration}
                  key={integration.slug}
                  metadata={accountMetadata}
                  onConnect={() => void handleConnect(integration)}
                  onDisconnect={(connectionId) =>
                    handleDisconnect(connectionId)
                  }
                  onRefresh={(connectionId) =>
                    void handleRefresh(connectionId)
                  }
                  onFetchContext={(connectionId) =>
                    void handleFetchContext(connectionId)
                  }
                  onToggleContextAutoFetch={(connectionId, enabled) =>
                    void handleToggleContextAutoFetch(connectionId, enabled)
                  }
                  expanded={expandedProviderId === integration.providerId}
                  mutatingOverrideKey={mutatingOverrideKey}
                  onSetWorkspaceEnabled={(workspaceId, enabled) =>
                    void setWorkspaceToolkitEnabled(
                      workspaceId,
                      integration.providerId,
                      enabled,
                    )
                  }
                  onToggleExpanded={() =>
                    setExpandedProviderId((prev) =>
                      prev === integration.providerId ? null : integration.providerId,
                    )
                  }
                  refreshingConnectionId={refreshingConnectionId}
                  togglingContextAutoFetchConnectionId={
                    togglingContextAutoFetchConnectionId
                  }
                  contextFetchStatusByConnectionId={
                    contextFetchStatusByConnectionId
                  }
                  toolkitCapabilities={capabilitiesByToolkit[integration.providerId] ?? []}
                  toolkitOverrides={
                    overridesByToolkit.get(integration.providerId) ?? new Map()
                  }
                  workspaceUsageByConnection={workspaceUsageByConnection}
                  workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
                />
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {connectedIntegrations.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-10 text-center">
            <p className="text-sm text-foreground">No integrations yet.</p>
            <p className="max-w-xs text-xs leading-5 text-muted-foreground">
              Connect Gmail, Slack, Linear, and others so the agent can use
              them in your workspaces.
            </p>
            <Button
              disabled={!isSignedIn}
              onClick={() => setAddDialogOpen(true)}
              size="sm"
              type="button"
              variant="default"
            >
              <Plus className="mr-1.5 size-3.5" />
              Add integration
            </Button>
          </div>
        ) : null}

        <AddIntegrationDialog
          canConnect={isSignedIn}
          connectDisabledReason={
            isSignedIn
              ? "Managed sign-in is not supported for this provider."
              : "Sign in first to connect integrations."
          }
          connectedProviderIds={connectedProviderIds}
          connectingProviderId={connectingProviderId}
          integrations={dialogIntegrations}
          onConnect={(integration) => {
            setAddDialogOpen(false);
            void handleConnect({
              slug: integration.slug,
              providerId: integration.providerId,
              name: integration.name,
              description: integration.description,
              logo: integration.logo,
              authSchemes: [],
              categories: integration.categories,
              supportsManaged: integration.supportsManaged,
            });
          }}
          onOpenChange={setAddDialogOpen}
          open={addDialogOpen}
        />

        <ConfirmDialog
          confirmLabel="Disconnect"
          description={
            pendingDisconnect
              ? `${pendingDisconnect.label} is bound in ${pendingDisconnect.workspaceCount} workspace${pendingDisconnect.workspaceCount === 1 ? "" : "s"}. Disconnecting drops every binding and revokes the Composio account. Apps in those workspaces will lose access until you reconnect.`
              : ""
          }
          destructive
          onConfirm={() => {
            if (pendingDisconnect) {
              void performDisconnect(pendingDisconnect.connectionId);
              setPendingDisconnect(null);
            }
          }}
          onOpenChange={(open) => {
            if (!open) setPendingDisconnect(null);
          }}
          open={Boolean(pendingDisconnect)}
          title="Disconnect this account?"
        />
        <ComposioRuntimeDebugRow />
      </div>
    );
  }

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm">
      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Integrations
          </h1>
          {integrationContent}
        </div>
      </div>
    </section>
  );
}


interface WorkspaceOverrideDescriptor {
  workspace_id: string;
  toolkit_slug: string;
  state: "disabled" | "pinned";
  pinned_connection_id: string | null;
}

interface WorkspaceSummary {
  id: string;
  name: string;
}

function ConnectedProviderCard({
  integration,
  connections,
  canConnect,
  connectDisabledReason,
  onConnect,
  onDisconnect,
  onRefresh,
  onFetchContext,
  onToggleContextAutoFetch,
  refreshingConnectionId,
  togglingContextAutoFetchConnectionId,
  contextFetchStatusByConnectionId,
  connecting,
  disconnectingConnectionId,
  metadata,
  compact,
  workspaceUsageByConnection,
  toolkitCapabilities,
  workspaces,
  toolkitOverrides,
  expanded,
  onToggleExpanded,
  onSetWorkspaceEnabled,
  mutatingOverrideKey,
}: {
  integration: IntegrationCard;
  connections: IntegrationConnectionPayload[];
  canConnect: boolean;
  connectDisabledReason: string;
  onConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  onRefresh: (connectionId: string) => void;
  onFetchContext: (connectionId: string) => void;
  onToggleContextAutoFetch: (
    connectionId: string,
    enabled: boolean,
  ) => void;
  refreshingConnectionId: string | null;
  togglingContextAutoFetchConnectionId: string | null;
  contextFetchStatusByConnectionId: Record<
    string,
    IntegrationContextFetchStatusPayload
  >;
  connecting: boolean;
  disconnectingConnectionId: string | null;
  metadata: Map<string, ComposioAccountStatus>;
  compact: boolean;
  workspaceUsageByConnection: Map<string, ConnectionWorkspaceUsageEntry["workspaces"]>;
  toolkitCapabilities: ComposioToolkitCapability[];
  workspaces: WorkspaceSummary[];
  toolkitOverrides: Map<string, WorkspaceOverrideDescriptor>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSetWorkspaceEnabled: (workspaceId: string, enabled: boolean) => void;
  mutatingOverrideKey: string | null;
}) {
  const containerClass = compact
    ? "flex flex-col gap-1 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border"
    : "flex flex-col gap-1 rounded-xl border border-border px-3 py-2.5";
  // Track avatars that 404 / refuse to load so we degrade to the lettered
  // placeholder instead of the broken-image icon. Provider CDNs can be
  // flaky (Twitter rate limits, LinkedIn auth requirements) so this is
  // worth the small bookkeeping.
  const [failedAvatars, setFailedAvatars] = useState<Set<string>>(new Set());
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(integration.logo) && !logoFailed;

  return (
    <div className={containerClass}>
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-background">
          {showLogo && integration.logo ? (
            <img
              alt=""
              className="size-full object-contain"
              onError={() => setLogoFailed(true)}
              referrerPolicy="no-referrer"
              src={integration.logo}
            />
          ) : (
            <span className="text-[10px] font-semibold text-muted-foreground">
              {integration.name.charAt(0)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {integration.name}
        </div>
        <Button
          aria-label={`Connect another ${integration.name} account`}
          className="text-muted-foreground hover:text-foreground"
          disabled={connecting || !canConnect}
          onClick={onConnect}
          size="icon-xs"
          title={
            canConnect
              ? `Connect another ${integration.name} account`
              : connectDisabledReason
          }
          type="button"
          variant="ghost"
        >
          {connecting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
        </Button>
      </div>

      <div className="flex flex-col">
        {connections.map((conn, index) => {
          const meta = metadata.get(conn.connection_id);
          const label = accountDisplayLabel(conn, meta, index);
          const avatarUrl = meta?.avatarUrl?.trim();
          const fallbackChar =
            label.replace(/^@/, "").charAt(0).toUpperCase() || "?";
          const failedAvatar = failedAvatars.has(conn.connection_id);
          const showAvatar = Boolean(avatarUrl) && !failedAvatar;
          const disconnecting =
            disconnectingConnectionId === conn.connection_id;
          const contextFetchStatus =
            contextFetchStatusByConnectionId[conn.connection_id] ?? null;
          const fetchingContext = contextFetchStatus?.status === "running";
          const contextFetchSupported = supportsContextFetchProvider(conn.provider_id);
          const togglingContextAutoFetch =
            togglingContextAutoFetchConnectionId === conn.connection_id;
          const fetchProgressPercent = contextFetchStatus
            ? contextFetchProgressPercent(contextFetchStatus)
            : 0;
          const fetchChunkTotal = contextFetchStatus
            ? contextFetchChunkTotal(contextFetchStatus)
            : 0;
          const usage = workspaceUsageByConnection.get(conn.connection_id) ?? [];
          const workspaceCount = new Set(usage.map((u) => u.workspace_id)).size;
          return (
            <div
              className="py-1"
              key={conn.connection_id}
            >
              <div className="flex items-center gap-2">
                {showAvatar ? (
                  <img
                    alt=""
                    className="size-3.5 shrink-0 rounded-full bg-muted object-cover"
                    onError={() =>
                      setFailedAvatars((prev) => {
                        if (prev.has(conn.connection_id)) {
                          return prev;
                        }
                        const next = new Set(prev);
                        next.add(conn.connection_id);
                        return next;
                      })
                    }
                    // Google's lh3.googleusercontent.com CDN rejects requests
                    // with a localhost / app referrer; this header strips it.
                    referrerPolicy="no-referrer"
                    src={avatarUrl}
                  />
                ) : (
                  <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground">
                    {fallbackChar}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {label}
                </span>
                {workspaceCount > 0 ? (
                  <span
                    className="shrink-0 text-[10px] text-muted-foreground"
                    title={`Bound in ${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`}
                  >
                    {workspaceCount}w
                  </span>
                ) : null}
                <Button
                  aria-label={`Fetch ${label} context`}
                  className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  disabled={
                    disconnecting ||
                    fetchingContext ||
                    !contextFetchSupported
                  }
                  onClick={() => onFetchContext(conn.connection_id)}
                  title={
                    contextFetchSupported
                      ? "Fetch integration context into the memory tree"
                      : "Context fetch is not implemented for this provider yet."
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {fetchingContext ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    "Fetch"
                  )}
                </Button>
                <Button
                  aria-label={`Refresh ${label} identity`}
                  title="Refetch handle, email, and avatar from the provider"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={
                    disconnecting ||
                    refreshingConnectionId === conn.connection_id
                  }
                  onClick={() => onRefresh(conn.connection_id)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  {refreshingConnectionId === conn.connection_id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                </Button>
                <Button
                  aria-label={`Disconnect ${label}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={disconnecting}
                  onClick={() => onDisconnect(conn.connection_id)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  {disconnecting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Unplug className="size-3" />
                  )}
                </Button>
              </div>
              {contextFetchSupported ? (
                <div className="ml-[22px] mt-1.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      Auto-fetch every 30 min
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Runs in the background for this account.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {togglingContextAutoFetch ? (
                      <Loader2 className="size-3 animate-spin text-muted-foreground" />
                    ) : null}
                    <Switch
                      aria-label={`Auto-fetch ${label} context every 30 minutes`}
                      checked={conn.context_cron_auto_fetch_enabled !== false}
                      disabled={disconnecting || togglingContextAutoFetch}
                      onCheckedChange={(checked) =>
                        onToggleContextAutoFetch(conn.connection_id, checked)
                      }
                    />
                  </div>
                </div>
              ) : null}
              {contextFetchStatus ? (
                <div className="ml-[22px] mt-2 rounded-lg border border-border/60 bg-background/70 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {contextFetchStatus.current_chunk_label ||
                        contextFetchDisplayMessage(contextFetchStatus)}
                    </p>
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {contextFetchStatus.status}
                    </span>
                  </div>
                  {contextFetchStatus.supported ? (
                    <>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground transition-[width] duration-300"
                          style={{ width: `${fetchProgressPercent}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                        {fetchChunkTotal > 0
                          ? `${Math.min(contextFetchStatus.chunks_completed, fetchChunkTotal)}/${fetchChunkTotal} chunks`
                          : "Waiting for chunk progress"}
                        {contextFetchStatus.error_message
                          ? ` - ${contextFetchStatus.error_message}`
                          : ""}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                      {contextFetchStatus.reason ||
                        "Context fetch is not available yet for this provider."}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        <WorkspaceScopeSection
          capabilities={toolkitCapabilities}
          expanded={expanded}
          mutatingOverrideKey={mutatingOverrideKey}
          onSetWorkspaceEnabled={onSetWorkspaceEnabled}
          onToggleExpanded={onToggleExpanded}
          toolkitOverrides={toolkitOverrides}
          toolkitSlug={integration.providerId}
          workspaces={workspaces}
        />
      </div>
    </div>
  );
}

function WorkspaceScopeSection({
  workspaces,
  toolkitOverrides,
  toolkitSlug,
  capabilities,
  expanded,
  onToggleExpanded,
  onSetWorkspaceEnabled,
  mutatingOverrideKey,
}: {
  workspaces: WorkspaceSummary[];
  toolkitOverrides: Map<string, WorkspaceOverrideDescriptor>;
  toolkitSlug: string;
  capabilities: ComposioToolkitCapability[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onSetWorkspaceEnabled: (workspaceId: string, enabled: boolean) => void;
  mutatingOverrideKey: string | null;
}) {
  const disabledWorkspaceIds: string[] = [];
  for (const ws of workspaces) {
    if (toolkitOverrides.get(ws.id)?.state === "disabled") {
      disabledWorkspaceIds.push(ws.id);
    }
  }
  const disabledNames = disabledWorkspaceIds
    .map((id) => workspaces.find((w) => w.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  const summary =
    disabledNames.length === 0
      ? "Active in all workspaces"
      : disabledNames.length === workspaces.length
        ? "Disabled in all workspaces"
        : `Disabled in: ${disabledNames.join(", ")}`;
  const toolCount = capabilities.length;
  return (
    <div className="mt-1 border-border border-t pt-2">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={onToggleExpanded}
        type="button"
      >
        <span className="truncate text-left">
          {summary}
          {toolCount > 0
            ? ` · ${toolCount} agent ${toolCount === 1 ? "tool" : "tools"}`
            : ""}
        </span>
        <span className="shrink-0">{expanded ? "Hide" : "Manage"}</span>
      </button>
      {expanded ? (
        <div className="mt-3 grid gap-3">
          {workspaces.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No workspaces yet. Create one to scope this integration.
            </p>
          ) : (
            <ul className="grid gap-2">
              {workspaces.map((ws) => {
                const override = toolkitOverrides.get(ws.id);
                const enabled = override?.state !== "disabled";
                const key = `${ws.id}:${toolkitSlug}`;
                const mutating = mutatingOverrideKey === key;
                return (
                  <li
                    className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-2.5 py-1.5"
                    key={ws.id}
                  >
                    <span className="truncate text-xs text-foreground">
                      {ws.name || ws.id}
                    </span>
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                      {mutating ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : null}
                      <input
                        checked={enabled}
                        className="size-3.5 cursor-pointer accent-foreground"
                        disabled={mutating}
                        onChange={(e) =>
                          onSetWorkspaceEnabled(ws.id, e.currentTarget.checked)
                        }
                        type="checkbox"
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {capabilities.length > 0 ? (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Agent can
              </div>
              <ul className="mt-1.5 space-y-1">
                {capabilities.map((cap) => (
                  <li className="text-[11px]" key={cap.tool_slug}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">{cap.name}</span>
                      {cap.read_only ? (
                        <Badge
                          className="border-border bg-background/60 text-[9px] text-muted-foreground"
                          variant="outline"
                        >
                          read-only
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-[11px] leading-5 text-muted-foreground">
                      {cap.description}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Temporary diagnostic — hits runtime POST /api/v1/debug/composio-
// runtime-test, which uses ComposioApiClient end-to-end (env-injected
// HOLABOSS_AUTH_BEARER_TOKEN → Hono /internal/tools/execute → Composio).
// Exposes a one-click "fetch 5 Gmail messages via runtime" probe so we
// can confirm the full server-side path is alive before any product
// feature lands. Editable provider + tool slug + args via small inputs;
// defaults are the canonical Gmail fetch case. Safe to delete alongside
// the runtime endpoint once a real consumer is in product.
function ComposioRuntimeDebugRow() {
  const [providerSlug, setProviderSlug] = useState("gmail");
  const [toolSlug, setToolSlug] = useState("GMAIL_FETCH_EMAILS");
  const [argsText, setArgsText] = useState(
    JSON.stringify({ max_results: 5 }, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleRun() {
    setBusy(true);
    setErrorMessage("");
    setResult(null);
    let parsedArgs: Record<string, unknown> = {};
    try {
      const raw = argsText.trim();
      parsedArgs = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (parseError) {
      setBusy(false);
      setErrorMessage(
        `arguments must be valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
      return;
    }
    try {
      const response = await window.electronAPI.workspace.debugComposioRuntimeTest(
        {
          providerSlug: providerSlug.trim() || undefined,
          toolSlug: toolSlug.trim() || undefined,
          arguments: parsedArgs,
        },
      );
      setResult(response);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            Debug — runtime → Composio via ComposioApiClient
          </div>
          <div className="text-muted-foreground">
            Hits <code>POST /api/v1/debug/composio-runtime-test</code> on
            the embedded runtime. Exercises the full path: env-injected
            bearer token → ComposioApiClient → Hono{" "}
            <code>/internal/tools/execute</code> → Composio. Defaults
            fetch your 5 most recent Gmail messages.
          </div>
        </div>
        <Button
          className="h-7 px-3 text-xs"
          disabled={busy}
          onClick={() => void handleRun()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? "Running…" : "Run probe"}
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            provider_slug
          </span>
          <Input
            className="h-7 text-xs"
            onChange={(e) => setProviderSlug(e.target.value)}
            value={providerSlug}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">tool_slug</span>
          <Input
            className="h-7 text-xs"
            onChange={(e) => setToolSlug(e.target.value)}
            value={toolSlug}
          />
        </label>
      </div>
      <label className="mt-2 flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">
          arguments (JSON)
        </span>
        <textarea
          className="h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] leading-4 text-foreground focus:outline-none"
          onChange={(e) => setArgsText(e.target.value)}
          value={argsText}
        />
      </label>
      {errorMessage ? (
        <div className="mt-3 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {errorMessage}
        </div>
      ) : null}
      {result !== null ? (
        <pre className="mt-3 max-h-80 w-full max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-background px-2 py-1.5 text-[11px] leading-5 text-foreground">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
