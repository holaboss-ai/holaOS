import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import {
  CategoryChip,
  DetailBackLink,
  DetailInstallButton,
  MarketLoadError,
  titleCase,
} from "@/components/panes/CapabilitiesMarketPane";
import { SkillsPane } from "@/components/panes/SkillsPane";
import { ViewTransition } from "@/components/ui/view-transition";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ArrowUpRight,
  ChevronLeft,
  Feather,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type DirectorySkillDto,
  fetchDirectorySkillBody,
  fetchDirectorySkills,
} from "@/lib/directoryClient";
import { Icon as IconifyIcon } from "@iconify/react";
import { getSkillIcon } from "@/lib/skillVisual";
import { withSkillDisplayTitle } from "@/lib/skillDisplayTitle";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import {
  useWorkspaceSkills,
  workspaceSkillsKey,
} from "@/lib/useWorkspaceSkills";
import {
  importOrgSkillFromUrl,
  listOrgSkills,
  type OrgSkill,
} from "@/lib/orgSkillsClient";
import { RenameDialog } from "@/components/ui/rename-dialog";

/**
 * Browse-first skills store — the same shape as the capabilities marketplace:
 * a Recommended carousel, category filter chips, and frameless Install rows,
 * with an Installed entry that opens the management view. Skills have no
 * integrations, so rows carry no tool tags.
 */
export function SkillsStorePane({
  workspaceId,
  onCreateSkill,
  onTryWithAgent,
  installRef,
  onInstallHandled,
  manageOnly = false,
  onBrowseMarketplace,
}: {
  workspaceId: string | null;
  onCreateSkill: () => void;
  onTryWithAgent: (skillId: string, title: string) => void;
  /** A skill id to auto-open in the detail view (HolaHub install hand-off). */
  installRef?: string | null;
  onInstallHandled?: () => void;
  /** Manage-first mode: Installed + a short Recommended shelf only; the search
   *  box, category chips and full browse grid are hidden (browsing lives in the
   *  HolaHub Marketplace). */
  manageOnly?: boolean;
  /** Open the HolaHub Marketplace — renders a link in the Recommended header. */
  onBrowseMarketplace?: () => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"market" | "installed">("market");
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<DirectorySkillDto | null>(
    null,
  );
  const [removingId, setRemovingId] = useState<string | null>(null);
  // The user's org skill library (backend, shared with the web platform) + import dialog.
  const [principal, setPrincipal] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const marketQuery = useQuery({
    queryKey: ["directory-central", "skills"],
    queryFn: fetchDirectorySkills,
    retry: 2,
    staleTime: 60_000,
  });
  const installMutation = useMutation(
    remoteApiQuery.skills.install.mutationOptions(),
  );

  const installedQuery = useWorkspaceSkills(workspaceId);
  const installedIds = useMemo(
    () =>
      new Set((installedQuery.data?.skills ?? []).map((s) => s.skill_id)),
    [installedQuery.data],
  );

  const refreshInstalled = () => {
    if (!workspaceId) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: workspaceSkillsKey(workspaceId),
    });
  };

  // The org principal (user id) — the path param for the org-scoped library, matching how
  // the web platform scopes it (org scoping itself is via the BFF's active-org header).
  useEffect(() => {
    void window.electronAPI?.auth
      ?.getUser?.()
      .then((u) => setPrincipal(u?.id ?? null))
      .catch(() => setPrincipal(null));
  }, []);

  const orgQuery = useQuery({
    queryKey: ["org-skills", principal],
    queryFn: () => listOrgSkills(principal as string),
    enabled: Boolean(principal),
    staleTime: 60_000,
  });
  const orgSkills = orgQuery.data ?? [];

  const entries = marketQuery.data?.skills ?? [];
  const installedCount = installedIds.size;
  // Installed preview — the first few installed skills shown inline, with a
  // "See … N more" link into the full Installed view (replacing a persistent
  // Store/Installed toggle). Sourced from the market entries so each carries a
  // name + description + glyph.
  const INSTALLED_PREVIEW = 6;
  const installedEntries = useMemo(
    () => entries.filter((entry) => installedIds.has(entry.id)),
    [entries, installedIds],
  );
  const installedPreview = installedEntries.slice(0, INSTALLED_PREVIEW);
  const hiddenInstalledCount = installedCount - installedPreview.length;
  const namedHidden = installedEntries
    .slice(INSTALLED_PREVIEW, INSTALLED_PREVIEW + 2)
    .map((entry) => entry.name);
  const seeMoreLabel =
    namedHidden.length > 0
      ? `See ${namedHidden.join(", ")}${
          hiddenInstalledCount - namedHidden.length > 0
            ? `, and ${hiddenInstalledCount - namedHidden.length} more`
            : ""
        }`
      : `See all ${installedCount} installed`;
  const normalized = query.trim().toLowerCase();
  const filteredOrg = useMemo(
    () =>
      orgSkills.filter(
        (s) =>
          !normalized ||
          [s.name, s.description].some((f) =>
            f?.toLowerCase().includes(normalized),
          ),
      ),
    [orgSkills, normalized],
  );
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      if (entry.category) {
        set.add(entry.category);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);
  const filtered = useMemo(
    () =>
      entries
        .filter((entry) => {
          if (activeCategory && entry.category !== activeCategory) {
            return false;
          }
          if (!normalized) {
            return true;
          }
          return [entry.name, entry.description].some((field) =>
            field?.toLowerCase().includes(normalized),
          );
        })
        // Featured skills lead; stable sort keeps each group's original order.
        .sort(
          (a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0),
        ),
    [entries, normalized, activeCategory],
  );
  const detailEntry = detailId
    ? (entries.find((entry) => entry.id === detailId) ?? null)
    : null;

  const addSkill = (entry: DirectorySkillDto) => {
    setPendingId(entry.id);
    void fetchDirectorySkillBody(entry.id)
      .then((resolved) =>
        installMutation.mutateAsync({
          skillId: entry.id,
          content: withSkillDisplayTitle(resolved.body, entry.name),
        }),
      )
      .then(() => {
        refreshInstalled();
        toast.success(`${entry.name} added`);
      })
      .catch(() => toast.error(`Couldn't add ${entry.name}`))
      .finally(() => setPendingId(null));
  };

  // Install an org-library skill = materialize its body locally so the desktop agent can
  // run it (the backend record already carries the SKILL.md content — no extra fetch).
  const addOrgSkill = (skill: OrgSkill) => {
    setPendingId(skill.id);
    void installMutation
      .mutateAsync({
        skillId: skill.id,
        content: withSkillDisplayTitle(skill.content, skill.name),
      })
      .then(() => {
        refreshInstalled();
        toast.success(`${skill.name} added`);
      })
      .catch(() => toast.error(`Couldn't add ${skill.name}`))
      .finally(() => setPendingId(null));
  };

  // "Add your own" = import a SKILL.md URL into the shared org store, then materialize it
  // locally. It also appears on the web employee platform (same backend store).
  const importOrgSkill = (url: string) => {
    if (!principal) {
      return;
    }
    setImporting(true);
    void importOrgSkillFromUrl(principal, url)
      .then((skill) => {
        setImportOpen(false);
        void orgQuery.refetch();
        addOrgSkill(skill);
      })
      .catch(() =>
        toast.error(
          "Couldn't import that skill — the URL must point to a raw, public SKILL.md.",
        ),
      )
      .finally(() => setImporting(false));
  };

  // HolaHub "Install" hand-off: auto-install the target skill once the directory
  // loads (skills are keyless — no second click). Skips an already-installed one.
  useEffect(() => {
    if (!installRef) {
      return;
    }
    const entry = entries.find((e) => e.id === installRef);
    if (!entry) {
      return; // directory not loaded yet — a later render will handle it
    }
    onInstallHandled?.();
    if (!installedIds.has(entry.id)) {
      addSkill(entry);
    }
  }, [installRef, entries, installedIds, addSkill, onInstallHandled]);

  // Removal mirrors the Installed view's delete (SkillsPane → workspace:deleteSkill),
  // so an installed skill can be removed from its marketplace detail too.
  const removeSkill = (entry: DirectorySkillDto) => {
    if (!workspaceId) {
      return;
    }
    setRemovingId(entry.id);
    void window.electronAPI?.workspace
      ?.deleteSkill?.({ workspaceId, skillId: entry.id })
      .then(() => {
        refreshInstalled();
        toast.success(`${entry.name} removed`);
      })
      .catch(() => toast.error(`Couldn't remove ${entry.name}`))
      .finally(() => {
        setRemovingId(null);
        setPendingRemove(null);
      });
  };

  if (view === "installed") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-2 px-6 py-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setView("market")}
            type="button"
          >
            <ChevronLeft className="size-3.5" />
            Marketplace
          </button>
          <span className="text-muted-foreground text-sm">·</span>
          <span className="font-medium text-foreground text-sm">Installed</span>
          <Button
            className="ml-auto h-7 gap-1.5"
            onClick={onCreateSkill}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            New skill
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SkillsPane
            hideTitle
            layout="grid"
            onCreateSkill={onCreateSkill}
            onTryWithAgent={onTryWithAgent}
            workspaceId={workspaceId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {manageOnly ? null : (
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-3 px-6 py-2.5">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search skills"
              className="h-8 w-full rounded-md pl-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills"
              value={query}
            />
          </div>
          <Button
            className="ml-auto h-8 shrink-0 gap-1.5"
            onClick={onCreateSkill}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            New skill
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable_both-edges]">
        {marketQuery.isLoading ? (
          <RowGridSkeleton />
        ) : marketQuery.isError ? (
          <MarketLoadError
            label="skills"
            onRetry={() => void marketQuery.refetch()}
          />
        ) : (
          <ViewTransition
            transitionKey={detailEntry ? `detail:${detailEntry.id}` : "list"}
          >
            {detailEntry ? (
              <div className="mx-auto w-full max-w-5xl px-6">
                <SkillDetail
                  entry={detailEntry}
                  installed={installedIds.has(detailEntry.id)}
                  onAdd={() => addSkill(detailEntry)}
                  onBack={() => setDetailId(null)}
                  onRemove={() => setPendingRemove(detailEntry)}
                  pending={pendingId === detailEntry.id}
                  removing={removingId === detailEntry.id}
                />
              </div>
            ) : entries.length === 0 ? (
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
                  description="Skills are focused recipes your agent can run — install one from the Marketplace, or create your own."
                  icon={Feather}
                  size="md"
                  title="No skills yet"
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
                      onClick={onCreateSkill}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Plus className="size-3.5" />
                      New skill
                    </Button>
                  ) : null}
                </div>
                {installedPreview.length > 0 ? (
                  <>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      {installedPreview.map((entry) => (
                        <SkillRow
                          compact
                          entry={entry}
                          installed
                          key={entry.id}
                          onAdd={() => addSkill(entry)}
                          onOpen={() => setDetailId(entry.id)}
                          pending={pendingId === entry.id}
                        />
                      ))}
                    </div>
                    {hiddenInstalledCount > 0 ? (
                      <button
                        className="self-start text-muted-foreground text-sm transition-colors hover:text-foreground"
                        onClick={() => setView("installed")}
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
                    description="Skills are focused recipes your agent can run — install one from the Marketplace, or create your own."
                    icon={Feather}
                    size="md"
                    title="No skills installed yet"
                  />
                )}
              </section>
            ) : null}

                <YourSkillsSection
                  installedIds={installedIds}
                  loading={orgQuery.isLoading}
                  onAdd={addOrgSkill}
                  onImport={() => setImportOpen(true)}
                  pendingId={pendingId}
                  skills={filteredOrg}
                />

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
                    No skills match your search.
                  </p>
                ) : (
                  <div
                    key={activeCategory ?? "all"}
                    className="grid grid-cols-1 gap-x-4 gap-y-2 duration-200 animate-in fade-in-0 slide-in-from-bottom-1 sm:grid-cols-2"
                  >
                    {filtered.map((entry) => (
                      <SkillRow
                        entry={entry}
                        featured={entry.featured}
                        installed={installedIds.has(entry.id)}
                        key={entry.id}
                        onAdd={() => addSkill(entry)}
                        onOpen={() => setDetailId(entry.id)}
                        pending={pendingId === entry.id}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
              </div>
            )}
          </ViewTransition>
        )}
      </div>
      <RenameDialog
        confirmLabel={importing ? "Importing…" : "Import"}
        initial=""
        onConfirm={importOrgSkill}
        onOpenChange={(o) => {
          if (!importing) {
            setImportOpen(o);
          }
        }}
        open={importOpen}
        placeholder="https://raw.githubusercontent.com/…/SKILL.md"
        title="Add your own skill"
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removingId) setPendingRemove(null);
        }}
        title="Remove this skill?"
        description={
          pendingRemove
            ? `"${pendingRemove.name}" and its files will be permanently removed from this workspace.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (pendingRemove) removeSkill(pendingRemove);
        }}
      />
    </div>
  );
}

// The user's org skill library (backend, shared with the web platform) as a store
// section — always present so importing is discoverable. Rows install by materializing
// the backend SKILL.md body locally so the desktop agent can run them.
function YourSkillsSection({
  skills,
  installedIds,
  pendingId,
  loading,
  onAdd,
  onImport,
}: {
  skills: OrgSkill[];
  installedIds: Set<string>;
  pendingId: string | null;
  loading: boolean;
  onAdd: (skill: OrgSkill) => void;
  onImport: () => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-foreground text-sm">Your skills</h3>
        <Button
          className="h-8 shrink-0 gap-1.5"
          onClick={onImport}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus className="size-3.5" />
          Import from URL
        </Button>
      </div>
      {loading ? (
        <p className="text-muted-foreground text-xs">Loading your library…</p>
      ) : skills.length === 0 ? (
        <p className="max-w-2xl text-muted-foreground text-xs">
          Skills you add on the web platform — or import here — land in your org
          library. Install one to use it on this desktop.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {skills.map((skill) => (
            <OrgSkillRow
              installed={installedIds.has(skill.id)}
              key={skill.id}
              onAdd={() => onAdd(skill)}
              pending={pendingId === skill.id}
              skill={skill}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OrgSkillRow({
  skill,
  installed,
  pending,
  onAdd,
}: {
  skill: OrgSkill;
  installed: boolean;
  pending: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex h-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
      <SkillIcon id={skill.id} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate font-semibold text-[15px] text-foreground leading-tight">
            {skill.name}
          </p>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
            Yours
          </span>
        </div>
        {skill.description ? (
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground leading-5">
            {skill.description}
          </p>
        ) : null}
      </div>
      <SkillInstallControl installed={installed} onAdd={onAdd} pending={pending} />
    </div>
  );
}

/** Per-skill glyph in its category color — a varied, scannable tile instead of
 *  a uniform feather. A distinct solid glyph per skill in a simple neutral
 *  tile — the shape carries the variety, no colored fill. */
function SkillIcon({
  id,
  category,
  icon,
  className,
  iconClassName = "size-6",
}: {
  id: string;
  category?: string;
  icon?: string;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        "grid size-12 shrink-0 place-items-center rounded-2xl border border-border bg-muted text-foreground/70",
        className,
      )}
    >
      <IconifyIcon
        className={iconClassName}
        icon={getSkillIcon(id, category, icon)}
      />
    </span>
  );
}

function stripFrontmatter(source: string): string {
  const match = source.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? source.slice(match[0].length).trim() : source.trim();
}

/** Full detail for a marketplace skill, styled to the store: a product hero
 *  (large glyph, name, description, prominent Install) over the rendered
 *  SKILL.md body so the reader sees exactly what the skill does. */
function SkillDetail({
  entry,
  installed,
  pending,
  removing,
  onBack,
  onAdd,
  onRemove,
}: {
  entry: DirectorySkillDto;
  installed: boolean;
  pending: boolean;
  removing: boolean;
  onBack: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const bodyQuery = useQuery({
    queryKey: ["directory-skill-body", entry.id],
    queryFn: () => fetchDirectorySkillBody(entry.id),
    retry: false,
    staleTime: 60_000,
  });
  return (
    <div className="flex flex-col">
      <DetailBackLink label="All skills" onBack={onBack} />

      <div className="flex items-start gap-5">
        <SkillIcon
          category={entry.category}
          className="size-16"
          icon={entry.icon}
          iconClassName="size-7"
          id={entry.id}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wide">
            {entry.category ? titleCase(entry.category) : "Skill"}
          </p>
          <h2 className="mt-0.5 font-semibold text-2xl text-foreground leading-tight">
            {entry.name}
          </h2>
          {entry.description ? (
            <p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
              {entry.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DetailInstallButton
            installed={installed}
            onAdd={onAdd}
            pending={pending}
          />
          {installed ? (
            <Button
              className="h-7 gap-1 text-muted-foreground hover:text-destructive"
              disabled={removing}
              onClick={onRemove}
              size="sm"
              type="button"
              variant="ghost"
            >
              {removing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-8 border-border/60 border-t pt-6">
        <h3 className="font-medium text-foreground text-sm">What it does</h3>
        <div className="mt-3 max-w-3xl">
          {bodyQuery.isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : bodyQuery.data?.body ? (
            <SimpleMarkdown className="md-body">
              {stripFrontmatter(bodyQuery.data.body)}
            </SimpleMarkdown>
          ) : (
            <p className="text-muted-foreground text-sm">Preview unavailable.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillRow({
  entry,
  installed,
  pending,
  onAdd,
  onOpen,
  compact = false,
  featured = false,
}: {
  entry: DirectorySkillDto;
  installed: boolean;
  pending: boolean;
  onAdd: () => void;
  onOpen: () => void;
  /** Drop the description for a tighter row — used in the Installed preview. */
  compact?: boolean;
  /** Backend-curated skill — badged in the grid (no separate shelf). */
  featured?: boolean;
}) {
  return (
    <div className="flex h-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
        type="button"
      >
        <SkillIcon category={entry.category} icon={entry.icon} id={entry.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate font-semibold text-[15px] text-foreground leading-tight">
              {entry.name}
            </p>
            {featured ? (
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-400">
                Featured
              </span>
            ) : null}
          </div>
          {!compact && entry.description ? (
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground leading-5">
              {entry.description}
            </p>
          ) : null}
        </div>
      </button>
      <SkillInstallControl
        installed={installed}
        onAdd={onAdd}
        pending={pending}
      />
    </div>
  );
}

function SkillInstallControl({
  installed,
  pending,
  onAdd,
  withLabel = false,
}: {
  installed: boolean;
  pending: boolean;
  onAdd: () => void;
  withLabel?: boolean;
}) {
  if (installed) {
    return (
      <span className="shrink-0 text-muted-foreground text-xs">Installed</span>
    );
  }
  return (
    <Button
      className={withLabel ? "h-7 shrink-0 gap-1" : "h-7 shrink-0"}
      disabled={pending}
      onClick={onAdd}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : withLabel ? (
        <>
          <Plus className="size-3.5" />
          Install
        </>
      ) : (
        "Install"
      )}
    </Button>
  );
}

function RowGridSkeleton() {
  const widths = ["w-2/3", "w-1/2", "w-3/5", "w-2/3", "w-1/2", "w-3/5"];
  return (
    <div
      aria-busy="true"
      aria-label="Loading skills"
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
