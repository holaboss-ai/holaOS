import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Unplug,
} from "lucide-react";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { accountDisplayLabel } from "@/lib/integrationDisplay";
import {
  invalidateIntegrationAccountCache,
  useIntegrationAccountMetadata,
} from "@/lib/integrationAccountStore";

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
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [connectingProviderId, setConnectingProviderId] = useState<
    string | null
  >(null);
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<
    string | null
  >(null);
  const [refreshingConnectionId, setRefreshingConnectionId] = useState<
    string | null
  >(null);
  const [statusMessage, setStatusMessage] = useState("");
  const accountMetadata = useIntegrationAccountMetadata(connections);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [catalogResult, connectionResult, toolkitResult] =
        await Promise.all([
          window.electronAPI.workspace.listIntegrationCatalog(),
          window.electronAPI.workspace.listIntegrationConnections(),
          window.electronAPI.workspace
            .composioListToolkits()
            .catch(() => ({ toolkits: [] as ComposioToolkit[] })),
        ]);
      setIntegrations(
        mergeIntegrationCards(catalogResult.providers, toolkitResult.toolkits),
      );
      setConnections(connectionResult.connections);
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

  const categories = useMemo(() => {
    const items = new Set<string>();
    for (const integration of integrations) {
      for (const category of integration.categories) {
        if (category) {
          items.add(category);
        }
      }
    }
    return Array.from(items).sort();
  }, [integrations]);

  const connectedIntegrations = useMemo(
    () =>
      integrations.filter((integration) =>
        connectedProviderIds.has(integration.providerId),
      ),
    [connectedProviderIds, integrations],
  );

  const filteredIntegrations = useMemo(() => {
    let items = integrations.filter(
      (integration) => !connectedProviderIds.has(integration.providerId),
    );
    if (query.trim()) {
      const normalizedQuery = query.trim().toLowerCase();
      items = items.filter((integration) =>
        [
          integration.providerId,
          integration.name,
          integration.description,
        ].some((value) => value.toLowerCase().includes(normalizedQuery)),
      );
    }
    if (categoryFilter !== "all") {
      items = items.filter((integration) =>
        integration.categories.includes(categoryFilter),
      );
    }
    return items;
  }, [categoryFilter, connectedProviderIds, integrations, query]);

  const groupedIntegrations = useMemo(() => {
    const groups: Record<string, IntegrationCard[]> = {};
    for (const integration of filteredIntegrations) {
      const category = integration.categories[0] || "other";
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(integration);
    }
    return Object.entries(groups).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [filteredIntegrations]);

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

      // Snapshot existing connection ids BEFORE initiating connect. The
      // id Composio returns from /link is, in practice, not queryable
      // via /connected_accounts/{id} until well after OAuth completes
      // — so instead of polling that id, we poll the user's connections
      // list and look for any *new* id that wasn't there before.
      let beforeIds = new Set<string>();
      try {
        const before =
          await window.electronAPI.workspace.composioListConnections();
        beforeIds = new Set(before.connections.map((c) => c.id));
      } catch {
        // If snapshot fails, continue with empty set; any new id matching
        // the toolkit is still detectable.
      }

      const link = await window.electronAPI.workspace.composioConnect({
        provider: integration.providerId,
        owner_user_id: userId,
      });

      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        let current;
        try {
          current =
            await window.electronAPI.workspace.composioListConnections();
          consecutiveErrors = 0;
        } catch (pollError) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw pollError;
          }
          continue;
        }

        const newConnection = current.connections.find(
          (c) =>
            !beforeIds.has(c.id) &&
            c.toolkitSlug.toLowerCase() ===
              integration.providerId.toLowerCase(),
        );
        if (newConnection) {
          await window.electronAPI.workspace.composioFinalize({
            connected_account_id: newConnection.id,
            provider: integration.providerId,
            owner_user_id: userId,
            account_label: `${integration.name} (Managed)`,
          });
          setStatusMessage("");
          void loadData();
          return;
        }
      }

      setStatusMessage("Connection timed out.");
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
    } finally {
      setConnectingProviderId(null);
    }
  }

  async function handleDisconnect(connectionId: string) {
    setDisconnectingConnectionId(connectionId);
    setStatusMessage("");
    try {
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
      return (
        <div>
          <p className="text-sm text-muted-foreground">
            Connect your accounts to use them in workspaces.
          </p>
          {embeddedSkeleton}
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

      {/* Search + Filter */}
      <div className="mt-5 flex items-center gap-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations..."
            className="h-9 pl-8"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm text-foreground outline-none"
        >
          <option value="all">All</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Connected — one card per provider, multiple account rows inside */}
      {connectedIntegrations.length > 0 ? (
        <div className="mt-6">
          <h2 className="text-xs font-medium uppercase text-muted-foreground">
            Connected
          </h2>
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
                  void handleDisconnect(connectionId)
                }
                onRefresh={(connectionId) =>
                  void handleRefresh(connectionId)
                }
                refreshingConnectionId={refreshingConnectionId}
              />
            ))}
          </div>
        </div>
      ) : null}

      {statusMessage ? (
        <p className="mt-4 text-sm text-muted-foreground">{statusMessage}</p>
      ) : null}

      {/* Available — grouped by category */}
      {groupedIntegrations.map(([category, items]) => (
        <div key={category} className="mt-6">
          <h2 className="text-xs font-medium uppercase text-muted-foreground">
            {category.charAt(0).toUpperCase() + category.slice(1)}
          </h2>
          <div className="mt-3 divide-y divide-border border-y border-border">
            {items.map((integration) => (
              <IntegrationRow
                key={integration.slug}
                integration={integration}
                connected={false}
                canConnect={isSignedIn && integration.supportsManaged}
                connectDisabledReason={
                  integration.supportsManaged
                    ? "Sign in first to connect managed integrations."
                    : "Managed sign-in is not supported for this provider."
                }
                onConnect={() => void handleConnect(integration)}
                onDisconnect={() => {}}
                connecting={connectingProviderId === integration.providerId}
                disconnecting={false}
                actionMode={
                  !integration.supportsManaged
                    ? "unavailable"
                    : isSignedIn
                      ? "connect"
                      : "disabled"
                }
              />
            ))}
          </div>
        </div>
      ))}

      {filteredIntegrations.length === 0 &&
      connectedIntegrations.length === 0 ? (
        <p className="mt-12 text-center text-sm text-muted-foreground">
          No integrations found.
        </p>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <div className="grid gap-6">
        <p className="text-sm text-muted-foreground">
          Connect your accounts to use them in workspaces.
        </p>

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

        {/* Search + filter toolbar */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search integrations..."
              className="h-9 pl-8"
            />
          </div>
          <Select
            value={categoryFilter}
            onValueChange={(value) => setCategoryFilter(value ?? "all")}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-[96px] justify-end gap-1.5 border-transparent bg-transparent px-2 text-xs font-medium hover:bg-accent dark:bg-transparent dark:hover:bg-accent"
            >
              <SelectValue>
                {(value: string) =>
                  value === "all"
                    ? "All"
                    : value.charAt(0).toUpperCase() + value.slice(1)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="end"
              alignItemWithTrigger={false}
              className="min-w-[140px] gap-0 rounded-lg p-1 shadow-xs ring-0"
            >
              <SelectItem
                value="all"
                className="rounded-md px-2.5 py-1.5 text-xs"
              >
                All
              </SelectItem>
              {categories.map((category) => (
                <SelectItem
                  key={category}
                  value={category}
                  className="rounded-md px-2.5 py-1.5 text-xs"
                >
                  {category.charAt(0).toUpperCase() + category.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {statusMessage ? (
          <p className="-mt-4 text-sm text-muted-foreground">{statusMessage}</p>
        ) : null}

        {/* Connected section — one card per provider, multiple account rows */}
        {connectedIntegrations.length > 0 ? (
          <SettingsSection title="Connected">
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
                    void handleDisconnect(connectionId)
                  }
                  onRefresh={(connectionId) =>
                    void handleRefresh(connectionId)
                  }
                  refreshingConnectionId={refreshingConnectionId}
                />
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {/* Available — grouped by category */}
        {groupedIntegrations.map(([category, items]) => (
          <SettingsSection
            key={category}
            title={category.charAt(0).toUpperCase() + category.slice(1)}
          >
            <div className="divide-y divide-border">
              {items.map((integration) => (
                <IntegrationEmbeddedCard
                  key={integration.slug}
                  integration={integration}
                  connected={false}
                  canConnect={isSignedIn && integration.supportsManaged}
                  connectDisabledReason={
                    integration.supportsManaged
                      ? "Sign in first to connect managed integrations."
                      : "Managed sign-in is not supported for this provider."
                  }
                  onConnect={() => void handleConnect(integration)}
                  onDisconnect={() => {}}
                  connecting={connectingProviderId === integration.providerId}
                  disconnecting={false}
                  actionMode={
                    !integration.supportsManaged
                      ? "unavailable"
                      : isSignedIn
                        ? "connect"
                        : "disabled"
                  }
                />
              ))}
            </div>
          </SettingsSection>
        ))}

        {filteredIntegrations.length === 0 &&
        connectedIntegrations.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            No integrations found.
          </p>
        ) : null}
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
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your accounts to use them in workspaces.
          </p>
          {integrationContent}
        </div>
      </div>
    </section>
  );
}

function IntegrationRow({
  integration,
  connected,
  canConnect,
  connectDisabledReason,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
  actionMode,
}: {
  integration: IntegrationCard;
  connected: boolean;
  canConnect: boolean;
  connectDisabledReason: string;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
  actionMode: "connected" | "connect" | "disabled" | "unavailable";
}) {
  const muted = actionMode === "disabled";
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 transition-colors ${
        muted ? "opacity-50" : "hover:bg-fg-2"
      }`}
    >
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
        {integration.logo ? (
          <img
            src={integration.logo}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <span className="text-sm font-semibold text-muted-foreground">
            {integration.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {integration.name}
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {integration.description}
        </div>
      </div>

      {connected ? (
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="border-primary text-primary">
            <Check size={10} />
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disconnecting}
            onClick={onDisconnect}
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Disconnect ${integration.name}`}
          >
            {disconnecting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Unplug size={13} />
            )}
          </Button>
        </div>
      ) : actionMode === "unavailable" ? (
        <Badge variant="secondary" title={connectDisabledReason}>
          Unavailable
        </Badge>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={connecting || !canConnect}
          onClick={onConnect}
          title={
            canConnect ? `Connect ${integration.name}` : connectDisabledReason
          }
        >
          {connecting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : !canConnect ? (
            <LogIn size={14} />
          ) : (
            <Plus size={14} />
          )}
        </Button>
      )}
    </div>
  );
}

function IntegrationEmbeddedCard({
  integration,
  connected,
  canConnect,
  connectDisabledReason,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
  actionMode,
}: {
  integration: IntegrationCard;
  connected: boolean;
  canConnect: boolean;
  connectDisabledReason: string;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
  actionMode: "connected" | "connect" | "disabled" | "unavailable";
}) {
  const muted = actionMode === "disabled";
  return (
    <div
      className={`group flex min-w-0 gap-3 px-3 py-2.5 transition-colors ${muted ? "opacity-60" : "hover:bg-fg-2"}`}
    >
      <div
        className={
          integration.logo
            ? "flex size-9 shrink-0 items-center justify-center"
            : "flex size-9 shrink-0 items-center justify-center rounded-md bg-muted ring-1 ring-border"
        }
      >
        {integration.logo ? (
          <img
            src={integration.logo}
            alt=""
            className="size-full object-contain"
          />
        ) : (
          <span className="text-sm font-semibold text-muted-foreground">
            {integration.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {integration.name}
          </div>
          <div className="-mr-1 -mt-1 shrink-0">
            {connected ? (
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={disconnecting}
                onClick={onDisconnect}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Disconnect ${integration.name}`}
              >
                {disconnecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Unplug className="size-3.5" />
                )}
              </Button>
            ) : actionMode === "unavailable" ? (
              <Badge
                variant="outline"
                className="border-border bg-background/60 text-[11px] text-muted-foreground"
                title={connectDisabledReason}
              >
                Unavailable
              </Badge>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={connecting || !canConnect}
                onClick={onConnect}
                title={
                  canConnect
                    ? `Connect ${integration.name}`
                    : connectDisabledReason
                }
                aria-label={`Connect ${integration.name}`}
              >
                {connecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {integration.description}
        </div>

        {connected ? (
          <div className="mt-auto flex pt-2">
            <Badge
              variant="outline"
              className="border-success/40 bg-success/10 text-[11px] text-success"
            >
              <Check className="size-3" />
              Connected
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConnectedProviderCard({
  integration,
  connections,
  canConnect,
  connectDisabledReason,
  onConnect,
  onDisconnect,
  onRefresh,
  refreshingConnectionId,
  connecting,
  disconnectingConnectionId,
  metadata,
  compact,
}: {
  integration: IntegrationCard;
  connections: IntegrationConnectionPayload[];
  canConnect: boolean;
  connectDisabledReason: string;
  onConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  onRefresh: (connectionId: string) => void;
  refreshingConnectionId: string | null;
  connecting: boolean;
  disconnectingConnectionId: string | null;
  metadata: Map<string, ComposioAccountStatus>;
  compact: boolean;
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
          return (
            <div
              className="flex items-center gap-2 py-1"
              key={conn.connection_id}
            >
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
          );
        })}
      </div>
    </div>
  );
}

