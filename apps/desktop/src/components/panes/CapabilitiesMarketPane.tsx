import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  ArrowUpRight,
  Boxes,
  Feather,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Unplug,
} from "@/components/ui/icons";
import { Icon as IconifyIcon } from "@iconify/react";
import { CapabilityGlyph } from "@/components/marketplace/CapabilityGlyph";
import { CapabilityDetailView } from "@/components/panes/CapabilityDetailView";
import { useConnectedToolkitSlugs } from "@/components/panes/ChatPane/useWorkspaceIntegrationItems";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewTransition } from "@/components/ui/view-transition";
import { getCapabilityIcon } from "@/lib/capabilityGlyph";
import {
  type DirectoryMcpRequiredKeyDto,
  fetchDirectoryCapabilities,
  fetchDirectorySkillBody,
} from "@/lib/directoryClient";
import { readInstalledMcpIds } from "@/lib/localMcpKeys";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { composioToolkitSlugForProvider } from "@/lib/workspaceDesktop";

// A capability's skills/integrations arrive as string[] from the backend
// directory, or as {ref|path}/{provider} objects from the runtime catalog.
export function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        if (typeof record.ref === "string") {
          return record.ref;
        }
        if (typeof record.provider === "string") {
          return record.provider;
        }
        if (typeof record.path === "string") {
          return record.path;
        }
      }
      return "";
    })
    .filter(Boolean);
}

// Provider slugs that gate install (must be connected before installing).
// Default: every integration is required — a bare slug string counts as
// required, and an object only escapes the gate with an explicit
// `required: false` (once the directory DTO carries the object shape).
export function toRequiredProviders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        if (record.required === false) {
          return "";
        }
        if (typeof record.provider === "string") {
          return record.provider;
        }
      }
      return "";
    })
    .filter(Boolean);
}

export type MarketItemMcp = {
  id: string;
  name: string;
  url: string;
  tools: string[];
  requiresKeys: boolean;
  requiredKeys: DirectoryMcpRequiredKeyDto[];
  required: boolean;
};

export type MarketItem = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
  skills: string[];
  integrations: string[];
  requiredProviders: string[];
  mcps: MarketItemMcp[];
};

// Provider slugs that don't title-case cleanly. Everything else falls back to
// splitting on separators and capitalizing — good enough for a chip label.
const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gmail: "Gmail",
  googledrive: "Google Drive",
  googlecalendar: "Google Calendar",
  googlesheets: "Google Sheets",
  googledocs: "Google Docs",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  hackernews: "Hacker News",
  x: "X",
};

const ACRONYMS = new Set([
  "seo",
  "ai",
  "aeo",
  "geo",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "prd",
  "crm",
  "kpi",
]);

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) =>
      ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(" ");
}

function prettifyProvider(slug: string): string {
  const key = slug.trim().toLowerCase();
  if (PROVIDER_LABELS[key]) {
    return PROVIDER_LABELS[key];
  }
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A capability's connection signature: the real brand logos of the tools it
 *  wires up — the one thing a plain skill never has. A skill card stays a
 *  glyph + text; a capability card shows what it's plugged into. Renders
 *  nothing when there are no integrations (no "Skill bundle" filler). */
function IntegrationLogos({
  providers,
  className,
}: {
  providers: string[];
  className?: string;
}) {
  const shown = providers.slice(0, 4);
  const extra = providers.length - shown.length;
  if (shown.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {shown.map((provider) => (
        <IntegrationLogo key={provider} provider={provider} />
      ))}
      {extra > 0 ? (
        <span className="pl-0.5 text-[11px] text-muted-foreground/70 tabular-nums">
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

function IntegrationLogo({ provider }: { provider: string }) {
  const [failed, setFailed] = useState(false);
  const slug = provider.trim().toLowerCase();
  if (failed || !slug) {
    return null;
  }
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm object-contain"
      onError={() => setFailed(true)}
      src={`https://logos.composio.dev/api/${slug}`}
      title={prettifyProvider(provider)}
    />
  );
}

/**
 * Browse-first capabilities marketplace: a searchable card grid with per-card
 * one-click install. Shares the Directory tab's dual-source read (central
 * registry, runtime catalog fallback) and two-branch install (embedded
 * built-ins via the runtime path; registry capabilities by materializing each
 * referenced skill then recording the capability).
 */
export function CapabilitiesMarketPane({
  installedIds,
  installedCount,
  onManage,
  onNew,
  onChanged,
  openDetailRef,
  onDetailOpened,
  workspaceId,
  manageOnly = false,
  onBrowseMarketplace,
}: {
  installedIds: Set<string>;
  installedCount: number;
  onManage: () => void;
  onNew: () => void;
  onChanged: () => void;
  /** A capability id to auto-open in the detail view (HolaHub install hand-off). */
  openDetailRef?: string | null;
  onDetailOpened?: () => void;
  workspaceId: string | null;
  /** Manage-first mode: show Installed + Recommended only; full browsing lives
   *  in the HolaHub Marketplace, so the search box, category chips and browse grid
   *  are hidden. */
  manageOnly?: boolean;
  /** Open the HolaHub Marketplace (the full browse surface). Renders a link in the
   *  Recommended header. */
  onBrowseMarketplace?: () => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { connectedSlugs } = useConnectedToolkitSlugs();
  const installedMcpIds = useMemo(() => new Set(readInstalledMcpIds()), []);
  // A silent one-click Add is fine only when no REQUIRED integration AND no
  // REQUIRED keyed MCP is unconnected; otherwise route to the detail view's
  // gated connect step (keyless MCPs attach silently, so they never gate).
  const needsConnect = useCallback(
    (item: MarketItem) =>
      item.requiredProviders.some(
        (provider) =>
          !connectedSlugs.has(composioToolkitSlugForProvider(provider)),
      ) ||
      item.mcps.some(
        (mcp) =>
          mcp.requiresKeys && mcp.required && !installedMcpIds.has(mcp.id),
      ),
    [connectedSlugs, installedMcpIds],
  );

  const centralQuery = useQuery({
    queryKey: ["directory-central", "capabilities"],
    queryFn: fetchDirectoryCapabilities,
    retry: 2,
    staleTime: 60_000,
  });
  const runtimeQuery = useQuery(
    remoteApiQuery.capabilities.catalog.queryOptions({ input: {} }),
  );
  const installMutation = useMutation(
    remoteApiQuery.capabilities.install.mutationOptions(),
  );
  const installedQuery = useQuery(
    remoteApiQuery.capabilities.listInstalled.queryOptions({
      input: {},
      enabled: Boolean(workspaceId),
    }),
  );
  const installedById = useMemo(
    () =>
      new Map(
        (installedQuery.data?.capabilities ?? []).map((c) => [
          c.capabilityId,
          c,
        ]),
      ),
    [installedQuery.data],
  );
  const skillInstall = useMutation(
    remoteApiQuery.skills.install.mutationOptions(),
  );
  const capabilityCreate = useMutation(
    remoteApiQuery.capabilities.create.mutationOptions(),
  );

  // The list is sourced from the central registry only — the runtime's local
  // embedded catalog is used solely to route installs (below), never shown, so
  // a stale/local entry can't leak into the grid before the registry loads.
  const items: MarketItem[] = (centralQuery.data?.capabilities ?? []).map(
    (entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      icon: entry.icon ?? undefined,
      category:
        "category" in entry && typeof entry.category === "string"
          ? entry.category
          : undefined,
      skills: toIdList(entry.skills),
      integrations: toIdList(entry.integrations),
      requiredProviders: toRequiredProviders(entry.integrations),
      mcps: ("mcps" in entry ? (entry.mcps ?? []) : []).map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        tools: m.tools,
        requiresKeys: m.requiresKeys,
        requiredKeys: m.requiredKeys ?? [],
        required: m.required,
      })),
    }),
  );
  // Built-ins live in the runtime's embedded catalog and install via the
  // runtime path; registry capabilities are ref-based.
  const embeddedIds = new Set(
    (runtimeQuery.data?.capabilities ?? []).map((c) => c.id),
  );

  const normalized = query.trim().toLowerCase();
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.category) {
        set.add(item.category);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);
  const filtered = useMemo(() => {
    const matched = items.filter((item) => {
      if (activeCategory && item.category !== activeCategory) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return [item.name, item.description].some((field) =>
        field?.toLowerCase().includes(normalized),
      );
    });
    // Integration-backed capabilities lead; connection-less ones sink to the
    // bottom — a capability with no real access is barely more than a skill.
    return [
      ...matched.filter((item) => item.integrations.length > 0),
      ...matched.filter((item) => item.integrations.length === 0),
    ];
  }, [items, normalized, activeCategory]);

  // Installed preview — the first few installed capabilities inline, with a
  // "See … N more" link into the full Installed view (via onManage), replacing
  // a persistent Store/Installed toggle.
  const INSTALLED_PREVIEW = 6;
  const installedItems = useMemo(
    () => items.filter((item) => installedIds.has(item.id)),
    [items, installedIds],
  );
  const installedPreview = installedItems.slice(0, INSTALLED_PREVIEW);
  const hiddenInstalledCount = installedCount - installedPreview.length;
  const namedHidden = installedItems
    .slice(INSTALLED_PREVIEW, INSTALLED_PREVIEW + 2)
    .map((item) => item.name);
  const seeMoreLabel =
    namedHidden.length > 0
      ? `See ${namedHidden.join(", ")}${
          hiddenInstalledCount - namedHidden.length > 0
            ? `, and ${hiddenInstalledCount - namedHidden.length} more`
            : ""
        }`
      : `See all ${installedCount} installed`;

  const isLoading = centralQuery.isLoading;

  const handleAdd = async (item: MarketItem) => {
    setPendingId(item.id);
    const skippedSkills: string[] = [];
    try {
      if (embeddedIds.has(item.id)) {
        await installMutation.mutateAsync({ capabilityId: item.id });
      } else {
        const installedSkillIds: string[] = [];
        for (const skillId of item.skills) {
          try {
            const resolved = await fetchDirectorySkillBody(skillId);
            await skillInstall.mutateAsync({ skillId, content: resolved.body });
            installedSkillIds.push(skillId);
          } catch (skillError) {
            // A skill whose body can't be resolved (e.g. a community skill
            // whose external source is unreachable) shouldn't sink the whole
            // capability — install what resolves and flag the rest.
            console.error(
              `Skill "${skillId}" for ${item.name} couldn't be resolved`,
              skillError,
            );
            skippedSkills.push(skillId);
          }
        }
        await capabilityCreate.mutateAsync({
          name: item.name,
          description: item.description,
          icon: item.icon,
          skillIds: installedSkillIds,
          integrationProviders: item.integrations,
          // Keyless MCPs attach on install; keyed ones are gated in the UI
          // (needsConnect) and excluded here.
          mcps: item.mcps
            .filter((m) => !m.requiresKeys)
            .map((m) => ({ id: m.id, url: m.url, tools: m.tools })),
        });
      }
      queryClient.invalidateQueries({
        queryKey: remoteApiQuery.capabilities.key(),
      });
      queryClient.invalidateQueries({ queryKey: remoteApiQuery.skills.key() });
      onChanged();
      if (skippedSkills.length > 0) {
        toast.warning(
          `${item.name} added — ${skippedSkills.length} skill${skippedSkills.length === 1 ? "" : "s"} unavailable`,
        );
      } else {
        toast.success(`${item.name} added`);
      }
    } catch (error) {
      console.error(`Couldn't add ${item.name}`, error);
      toast.error(`Couldn't add ${item.name}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingId(null);
    }
  };

  // HolaHub "Install" hand-off: auto-install the target capability once the
  // directory loads — keyless installs straight away (no second click); a
  // capability that needs a connect (required integration / keyed MCP) opens its
  // detail so the user can connect first.
  useEffect(() => {
    if (!openDetailRef) {
      return;
    }
    const item = items.find((entry) => entry.id === openDetailRef);
    if (!item) {
      return; // directory not loaded yet — a later render will handle it
    }
    onDetailOpened?.();
    if (needsConnect(item)) {
      setDetailId(item.id);
    } else {
      void handleAdd(item);
    }
  }, [openDetailRef, items, needsConnect, handleAdd, onDetailOpened]);


  const detailItem = detailId
    ? (items.find((entry) => entry.id === detailId) ?? null)
    : null;
  const detailRecord = detailItem
    ? (installedById.get(detailItem.id) ?? null)
    : null;

  const renderGrid = (list: MarketItem[]) => (
    <div
      key={activeCategory ?? "all"}
      className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-4 gap-y-2 duration-200 animate-in fade-in-0 slide-in-from-bottom-1 sm:grid-cols-2"
    >
      {list.map((item) => (
        <CapabilityCard
          installed={installedIds.has(item.id)}
          item={item}
          key={item.id}
          onAdd={() =>
            needsConnect(item) ? setDetailId(item.id) : handleAdd(item)
          }
          onOpen={() => setDetailId(item.id)}
          pending={pendingId === item.id}
        />
      ))}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {manageOnly ? null : (
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-3 px-6 py-2.5">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search combos"
              className="h-8 w-full rounded-md pl-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search combos"
              value={query}
            />
          </div>
          <Button
            className="ml-auto h-8 shrink-0 gap-1.5"
            onClick={onNew}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            New combo
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable_both-edges]">
        {isLoading ? (
          <CardGridSkeleton />
        ) : centralQuery.isError ? (
          <MarketLoadError
            label="combos"
            onRetry={() => void centralQuery.refetch()}
          />
        ) : (
          <ViewTransition
            transitionKey={detailItem ? `detail:${detailItem.id}` : "list"}
          >
            {detailItem ? (
              <div className="mx-auto w-full max-w-5xl px-6">
                {detailRecord ? (
                  <CapabilityDetailView
                    backLabel="All combos"
                    capabilityId={detailRecord.capabilityId}
                    category={detailItem.category}
                    connectorProviders={Object.keys(
                      detailRecord.integrationStatus ?? {},
                    )}
                    description={detailRecord.description}
                    icon={detailItem.icon}
                    installed
                    name={detailRecord.name}
                    onBack={() => setDetailId(null)}
                    onUninstalled={() => {
                      onChanged();
                      setDetailId(null);
                    }}
                    skillIds={detailRecord.installedSkillIds}
                    status={detailRecord.status}
                    workspaceId={workspaceId ?? ""}
                  />
                ) : (
                  <CapabilityDetailView
                    backLabel="All combos"
                    capabilityId={detailItem.id}
                    category={detailItem.category}
                    connectorProviders={detailItem.integrations}
                    description={detailItem.description}
                    icon={detailItem.icon}
                    installed={false}
                    mcps={detailItem.mcps}
                    requiredProviders={detailItem.requiredProviders}
                    installing={pendingId === detailItem.id}
                    name={detailItem.name}
                    onBack={() => setDetailId(null)}
                    onInstall={() => handleAdd(detailItem)}
                    skillIds={detailItem.skills}
                    workspaceId={workspaceId ?? ""}
                  />
                )}
              </div>
            ) : items.length === 0 ? (
              <div className="flex min-h-[280px] items-center justify-center p-6">
                <EmptyState
                  action={
                    onBrowseMarketplace ? (
                      <Button
                        onClick={onBrowseMarketplace}
                        size="sm"
                        type="button"
                      >
                        Browse the Marketplace
                        <ArrowUpRight className="size-3.5" />
                      </Button>
                    ) : null
                  }
                  decorated
                  description="Combos bundle related skills and connections into one install. Add your first from the Marketplace."
                  icon={Boxes}
                  size="md"
                  title="No combos yet"
                />
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6">
            {manageOnly || installedPreview.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium text-foreground text-sm">
                    Installed
                  </h3>
                  {manageOnly ? (
                    <Button
                      className="h-8 shrink-0 gap-1.5"
                      onClick={onNew}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Plus className="size-3.5" />
                      New combo
                    </Button>
                  ) : null}
                </div>
                {installedPreview.length > 0 ? (
                  <>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      {installedPreview.map((item) => (
                        <CapabilityCard
                          compact
                          installed
                          item={item}
                          key={item.id}
                          onAdd={() =>
                            needsConnect(item)
                              ? setDetailId(item.id)
                              : handleAdd(item)
                          }
                          onOpen={() => setDetailId(item.id)}
                          pending={pendingId === item.id}
                        />
                      ))}
                    </div>
                    {hiddenInstalledCount > 0 ? (
                      <button
                        className="self-start text-muted-foreground text-sm transition-colors hover:text-foreground"
                        onClick={onManage}
                        type="button"
                      >
                        {seeMoreLabel}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <EmptyState
                    action={
                      onBrowseMarketplace ? (
                        <Button
                          onClick={onBrowseMarketplace}
                          size="sm"
                          type="button"
                        >
                          Browse the Marketplace
                          <ArrowUpRight className="size-3.5" />
                        </Button>
                      ) : null
                    }
                    decorated
                    description="Bundle skills and integrations into a combo — install one from the Marketplace, or build your own."
                    icon={Sparkles}
                    size="md"
                    title="No combos installed yet"
                  />
                )}
              </section>
            ) : null}

            {manageOnly ? null : (
              <>
                {categories.length > 0 ? (
                  <div className="-mx-1 flex flex-wrap items-center gap-1 px-1">
                    <CategoryChip
                      active={activeCategory === null}
                      label="All"
                      onClick={() => setActiveCategory(null)}
                    />
                    {categories.map((category) => (
                      <CategoryChip
                        active={activeCategory === category}
                        key={category}
                        label={titleCase(category)}
                        onClick={() => setActiveCategory(category)}
                      />
                    ))}
                  </div>
                ) : null}

                {filtered.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No capabilities match your search.
                  </p>
                ) : (
                  renderGrid(filtered)
                )}
              </>
            )}
              </div>
            )}
          </ViewTransition>
        )}
      </div>
    </div>
  );
}

export function CategoryChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "rounded-md px-2.5 py-1 text-sm transition-colors",
        active
          ? "bg-fg-6 font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function CapabilityCard({
  item,
  installed,
  pending,
  onAdd,
  onOpen,
  compact = false,
}: {
  item: MarketItem;
  installed: boolean;
  pending: boolean;
  onAdd: () => void;
  onOpen: () => void;
  /** Drop the description for a tighter row — used in the Installed preview. */
  compact?: boolean;
}) {
  // A capability is a bundled "does-it-for-you" agent, not a single tool — so
  // its card carries more than a skill row: a two-line description and the
  // brand logos of the tools it wires up, with an "Add" action.
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-3.5 transition-colors hover:bg-accent">
      <div className="flex items-start gap-3">
        <button
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          onClick={onOpen}
          type="button"
        >
          <CapabilityGlyph
            category={item.category}
            icon={item.icon}
            id={item.id}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-[15px] text-foreground leading-tight">
              {item.name}
            </p>
            <IntegrationLogos
              className="mt-1.5"
              providers={item.integrations}
            />
          </div>
        </button>
        {installed ? (
          <span className="shrink-0 pt-1 text-muted-foreground text-xs">
            Added
          </span>
        ) : (
          <Button
            className="h-7 shrink-0"
            disabled={pending}
            onClick={onAdd}
            size="sm"
            type="button"
            variant="outline"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
          </Button>
        )}
      </div>
      {!compact && item.description ? (
        <p className="line-clamp-2 text-[13px] text-muted-foreground leading-5">
          {item.description}
        </p>
      ) : null}
    </div>
  );
}

/** Shared load-error state for the marketplace surfaces — a recoverable
 *  EmptyState with a Try-again that refetches, so a transient blip doesn't
 *  strand the user on a dead-end message. */
export function MarketLoadError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <RefreshCw className="size-3.5" />
            Try again
          </Button>
        }
        description="Something went wrong reaching the marketplace. Check your connection."
        icon={Unplug}
        size="md"
        title={`Couldn't load ${label}`}
      />
    </div>
  );
}

/** Detail back link — shared by the capability and skill detail views. */
export function DetailBackLink({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <button
      className="-mx-2 mb-6 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-fg-2 hover:text-foreground"
      onClick={onBack}
      type="button"
    >
      <ArrowLeft className="size-4" />
      {label}
    </button>
  );
}

/** Prominent install CTA for a detail page — filled, sized up from the browse
 *  cards so the primary action reads as the commit. */
export function DetailInstallButton({
  installed,
  pending,
  onAdd,
  onRemove,
}: {
  installed: boolean;
  pending: boolean;
  onAdd: () => void;
  onRemove?: () => void;
}) {
  if (installed) {
    if (!onRemove) {
      return (
        <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-fg-4 px-3 font-medium text-muted-foreground text-xs">
          <Check className="size-3.5" />
          Installed
        </span>
      );
    }
    return (
      <Button
        className="h-8 shrink-0 gap-1.5"
        disabled={pending}
        onClick={onRemove}
        size="sm"
        type="button"
        variant="outline"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Unplug className="size-3.5" />
        )}
        Uninstall
      </Button>
    );
  }
  return (
    <Button
      className="h-8 shrink-0 gap-1.5"
      disabled={pending}
      onClick={onAdd}
      size="sm"
      type="button"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Plus className="size-3.5" />
      )}
      Install
    </Button>
  );
}

/** Full detail for a marketplace capability, styled to the store: a product
 *  hero (large logo, name, description, prominent Install) over a two-column
 *  breakdown of the skills it bundles and the connectors it touches — each
 *  connector shown with its real brand logo. */
function CapabilityDetail({
  item,
  installed,
  pending,
  onBack,
  onAdd,
  onRemove,
}: {
  item: MarketItem;
  installed: boolean;
  pending: boolean;
  onBack: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const hasSkills = item.skills.length > 0;
  const hasConnectors = item.integrations.length > 0;
  return (
    <div className="flex flex-col">
      <DetailBackLink label="All combos" onBack={onBack} />

      <div className="flex items-start gap-5">
        <CapabilityGlyph
          category={item.category}
          className="size-16"
          icon={item.icon}
          iconClassName="size-8"
          id={item.id}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          {item.category ? (
            <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wide">
              {titleCase(item.category)}
            </p>
          ) : null}
          <h2 className="mt-0.5 font-semibold text-2xl text-foreground leading-tight">
            {item.name}
          </h2>
          {item.description ? (
            <p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
              {item.description}
            </p>
          ) : null}
        </div>
        <DetailInstallButton
          installed={installed}
          onAdd={onAdd}
          onRemove={onRemove}
          pending={pending}
        />
      </div>

      {hasSkills || hasConnectors ? (
        <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-8 border-border/60 border-t pt-6 sm:grid-cols-2">
          {hasSkills ? (
            <section>
              <h3 className="font-medium text-foreground text-sm">
                Included skills
              </h3>
              <ul className="mt-3 flex flex-col gap-1.5">
                {item.skills.map((skillId) => (
                  <li className="flex items-center gap-2.5" key={skillId}>
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted">
                      <Feather className="size-4 text-muted-foreground" />
                    </span>
                    <span className="truncate text-[13px] text-foreground">
                      {titleCase(skillId)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {hasConnectors ? (
            <section>
              <h3 className="font-medium text-foreground text-sm">Connectors</h3>
              <ul className="mt-3 flex flex-col gap-1.5">
                {item.integrations.map((provider) => (
                  <li className="flex items-center gap-2.5" key={provider}>
                    <CapabilityIcon
                      className="size-8 rounded-lg"
                      integrations={[provider]}
                    />
                    <span className="truncate text-[13px] text-foreground">
                      {prettifyProvider(provider)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Brand-forward capability icon for the Recommended hero cards: the primary
 *  integration's Composio logo (color), falling back to the monochrome glyph
 *  when there's no integration or the logo fails to load. */
export function CapabilityIcon({
  icon,
  integrations,
  id,
  category,
  className,
}: {
  icon?: string;
  integrations: string[];
  id?: string;
  category?: string;
  className?: string;
}) {
  const iconUrl = icon && /^(https?:|\/|data:)/.test(icon) ? icon : null;
  const cdnSlug = integrations[0]?.trim().toLowerCase() ?? "";
  const [stage, setStage] = useState<"url" | "cdn" | "glyph">(
    iconUrl ? "url" : cdnSlug ? "cdn" : "glyph",
  );

  // Brand logos are already complete app icons (own fill + rounding), so they
  // render bare — no tile, no border. Only the monochrome glyph fallback needs
  // the neutral container.
  const imageWrap = cn("shrink-0 overflow-hidden rounded-2xl", className);
  const glyphTile = cn(
    "grid shrink-0 place-items-center rounded-2xl border border-border bg-muted text-muted-foreground",
    className,
  );

  if (stage === "url" && iconUrl) {
    return (
      <span className={imageWrap}>
        <img
          alt=""
          className="size-full object-contain p-1.5"
          onError={() => setStage(cdnSlug ? "cdn" : "glyph")}
          src={iconUrl}
        />
      </span>
    );
  }

  if (stage === "cdn" && cdnSlug) {
    return (
      <span className={imageWrap}>
        <img
          alt=""
          className="size-full object-contain p-1.5"
          onError={() => setStage("glyph")}
          src={`https://logos.composio.dev/api/${cdnSlug}`}
        />
      </span>
    );
  }

  return (
    <span className={glyphTile}>
      <IconifyIcon
        className="size-[55%]"
        icon={getCapabilityIcon(id ?? "", category)}
      />
    </span>
  );
}

function CardGridSkeleton() {
  const widths = [
    "w-2/3",
    "w-1/2",
    "w-3/5",
    "w-2/3",
    "w-1/2",
    "w-3/5",
    "w-1/2",
    "w-2/3",
  ];
  return (
    <div
      aria-busy="true"
      aria-label="Loading combos"
      className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-8 gap-y-1 px-6 sm:grid-cols-2"
      role="status"
    >
      {widths.map((width, index) => (
        <div
          className="flex items-center gap-3 px-2 py-2"
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
          key={index}
        >
          <Skeleton className="size-12 shrink-0 rounded-2xl" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="h-3 w-full" />
          </div>
          <Skeleton className="h-7 w-16 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}
