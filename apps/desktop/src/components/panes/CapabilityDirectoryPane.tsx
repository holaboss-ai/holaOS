import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  SettingsScreen,
  type SettingsScreenNavEntry,
} from "@/components/settings";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import {
  ArrowLeft,
  Boxes,
  Check,
  Feather,
  Loader2,
  Plug,
  Search,
  X,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewTransition } from "@/components/ui/view-transition";
import {
  fetchDirectoryCapabilities,
  fetchDirectorySkillBody,
  fetchDirectorySkills,
} from "@/lib/directoryClient";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";

export type DirectoryTab = "capabilities" | "skills";

const DIRECTORY_NAV: ReadonlyArray<SettingsScreenNavEntry<DirectoryTab>> = [
  { id: "capabilities", label: "Combos", icon: Boxes },
  { id: "skills", label: "Skills", icon: Feather },
];

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "available", label: "Not installed" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

// Shared installed/not-installed filter, used by both the Skills and
// Capabilities tabs so the directory reads consistently.
function StatusFilterBar({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  return (
    <div className="mb-3 flex shrink-0 items-center gap-0.5 self-start rounded-lg bg-fg-4 p-0.5">
      {STATUS_FILTERS.map((option) => (
        <button
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            value === option.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CapabilityDirectoryPane({
  installedIds,
  workspaceId,
  initialTab = "capabilities",
  onClose,
}: {
  installedIds: Set<string>;
  workspaceId: string;
  initialTab?: DirectoryTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DirectoryTab>(initialTab);
  const [query, setQuery] = useState("");

  return (
    <DialogPrimitive.Root
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-[100] flex h-[82vh] max-h-[82vh] w-[88vw] max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl outline-none data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0">
          <header className="flex shrink-0 items-center justify-between border-border/60 border-b px-5 py-3">
            <DialogPrimitive.Title className="font-semibold text-base text-foreground tracking-tight">
              Directory
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1">
            <SettingsScreen
              activeSection={tab}
              onSectionChange={(next) => {
                setTab(next);
                setQuery("");
              }}
              sections={DIRECTORY_NAV}
            >
              <div className="flex min-h-0 flex-col px-6 py-5">
                <div className="relative mb-4 shrink-0">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="Search the directory"
                    className="h-10 w-full rounded-lg pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`Search ${tab}…`}
                    value={query}
                  />
                </div>
                <ViewTransition
                  className="flex min-h-0 flex-1 flex-col"
                  transitionKey={tab}
                  variant="slide"
                >
                  {tab === "capabilities" ? (
                    <CapabilitiesTab installedIds={installedIds} query={query} />
                  ) : (
                    <SkillsTab query={query} workspaceId={workspaceId} />
                  )}
                </ViewTransition>
              </div>
            </SettingsScreen>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>;
}

function Empty({ text }: { text: string }) {
  return <p className="text-muted-foreground text-xs">{text}</p>;
}

// A capability's skills/integrations arrive as string[] from the backend
// directory, or as {ref|path}/{provider} objects from the runtime catalog.
function toIdList(value: unknown): string[] {
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

function CardSkeletonGrid() {
  const titleWidths = ["w-2/3", "w-1/2", "w-3/5", "w-2/3"];
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      role="status"
    >
      {titleWidths.map((titleWidth, index) => (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-3.5"
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
          key={index}
        >
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
            <Skeleton className={`h-3.5 ${titleWidth}`} />
            <Skeleton className="h-3 w-full" />
          </div>
          <Skeleton className="h-6 w-12 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function CapabilitiesTab({
  installedIds,
  query,
}: {
  installedIds: Set<string>;
  query: string;
}) {
  const queryClient = useQueryClient();
  // Prefer the central directory; fall back to the local runtime catalog when
  // it is unavailable (offline / signed out) so browsing never hard-fails.
  const centralQuery = useQuery({
    queryKey: ["directory-central", "capabilities"],
    queryFn: fetchDirectoryCapabilities,
    retry: false,
    staleTime: 60_000,
  });
  const runtimeQuery = useQuery(
    remoteApiQuery.capabilities.catalog.queryOptions({ input: {} }),
  );
  const installMutation = useMutation(
    remoteApiQuery.capabilities.install.mutationOptions(),
  );
  const skillInstall = useMutation(remoteApiQuery.skills.install.mutationOptions());
  const capabilityCreate = useMutation(
    remoteApiQuery.capabilities.create.mutationOptions(),
  );
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const source =
    centralQuery.data?.capabilities ?? runtimeQuery.data?.capabilities;
  const items = (source ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon ?? undefined,
    skills: toIdList(entry.skills),
    integrations: toIdList(entry.integrations),
  }));
  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (status === "installed" && !installedIds.has(item.id)) {
          return false;
        }
        if (status === "available" && installedIds.has(item.id)) {
          return false;
        }
        if (!normalized) {
          return true;
        }
        return [item.name, item.description].some((field) =>
          field?.toLowerCase().includes(normalized),
        );
      }),
    [items, normalized, status, installedIds],
  );
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: remoteApiQuery.capabilities.key() });

  // Legacy built-ins live in the runtime's embedded catalog and install via the
  // runtime path. Backend registry capabilities are ref-based, so we materialize
  // each referenced skill (like a single skill install) then record the
  // capability from its definition.
  const embeddedIds = new Set(
    (runtimeQuery.data?.capabilities ?? []).map((c) => c.id),
  );

  const handleAdd = async (item: {
    id: string;
    name: string;
    description: string;
    icon?: string;
    skills: string[];
    integrations: string[];
  }) => {
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
            // Skip a skill whose body can't be resolved rather than failing
            // the whole capability install.
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
        });
      }
      invalidate();
      queryClient.invalidateQueries({ queryKey: remoteApiQuery.skills.key() });
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

  const detailItem = detailId
    ? (items.find((entry) => entry.id === detailId) ?? null)
    : null;

  const body =
    source === undefined &&
    (centralQuery.isLoading || runtimeQuery.isLoading) ? (
      <CardSkeletonGrid />
    ) : filtered.length === 0 ? (
      <Empty text="No combos found." />
    ) : (
      <Grid>
        {filtered.map((item) => (
          <Card
            added={installedIds.has(item.id)}
            description={item.description}
            icon={item.icon}
            key={item.id}
            onAdd={() => void handleAdd(item)}
            onOpen={() => setDetailId(item.id)}
            pending={pendingId === item.id}
            title={item.name}
          />
        ))}
      </Grid>
    );

  return (
    <ViewTransition
      className="flex min-h-0 flex-1 flex-col"
      transitionKey={detailItem ? `detail:${detailItem.id}` : "list"}
    >
      {detailItem ? (
        <DirectoryCapabilityDetail
          capability={detailItem}
          installed={installedIds.has(detailItem.id)}
          onAdd={() => void handleAdd(detailItem)}
          onBack={() => setDetailId(null)}
          pending={pendingId === detailItem.id}
        />
      ) : (
        <>
          <StatusFilterBar onChange={setStatus} value={status} />
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        </>
      )}
    </ViewTransition>
  );
}

function SkillsTab({ query, workspaceId }: { query: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<StatusFilter>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  // Skills come live from the marketplace registry (the single source of truth)
  // via the directory gateway — there is no local runtime catalog fallback.
  const centralQuery = useQuery({
    queryKey: ["directory-central", "skills"],
    queryFn: fetchDirectorySkills,
    retry: false,
    staleTime: 60_000,
  });
  const installMutation = useMutation(remoteApiQuery.skills.install.mutationOptions());

  const refreshInstalled = () => {
    if (!workspaceId) {
      return;
    }
    void window.electronAPI?.workspace
      ?.listSkills?.(workspaceId)
      .then((result) =>
        setInstalledSkillIds(new Set((result?.skills ?? []).map((s) => s.skill_id))),
      )
      .catch(() => undefined);
  };
  useEffect(refreshInstalled, [workspaceId]);

  const source = centralQuery.data?.skills;
  const entries = source ?? [];
  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (status === "installed" && !installedSkillIds.has(entry.id)) {
          return false;
        }
        if (status === "available" && installedSkillIds.has(entry.id)) {
          return false;
        }
        if (!normalized) {
          return true;
        }
        return [entry.name, entry.description].some((field) =>
          field?.toLowerCase().includes(normalized),
        );
      }),
    [entries, normalized, status, installedSkillIds],
  );

  const addSkill = (entry: { id: string; name: string }) => {
    // Resolve the SKILL.md body from the marketplace, then hand it to the
    // runtime to materialize into the workspace skills/ dir.
    void fetchDirectorySkillBody(entry.id)
      .then((resolved) =>
        installMutation.mutate(
          { skillId: entry.id, content: resolved.body },
          {
            onSuccess: () => {
              refreshInstalled();
              queryClient.invalidateQueries({
                queryKey: remoteApiQuery.skills.key(),
              });
              toast.success(`${entry.name} added`);
            },
            onError: () => toast.error(`Couldn't add ${entry.name}`),
          },
        ),
      )
      .catch(() => toast.error(`Couldn't add ${entry.name}`));
  };

  const detailEntry = detailId
    ? (entries.find((item) => item.id === detailId) ?? null)
    : null;

  const body =
    source === undefined && centralQuery.isLoading ? (
      <CardSkeletonGrid />
    ) : filtered.length === 0 ? (
      <Empty text="No skills found." />
    ) : (
      <Grid>
        {filtered.map((entry) => (
          <Card
            added={installedSkillIds.has(entry.id)}
            description={entry.description}
            icon={<Feather className="size-4 text-muted-foreground" />}
            key={entry.id}
            onAdd={() => addSkill(entry)}
            onOpen={() => setDetailId(entry.id)}
            pending={installMutation.isPending}
            title={entry.name}
          />
        ))}
      </Grid>
    );

  return (
    <ViewTransition
      className="flex min-h-0 flex-1 flex-col"
      transitionKey={detailEntry ? `detail:${detailEntry.id}` : "list"}
    >
      {detailEntry ? (
        <DirectorySkillDetail
          installed={installedSkillIds.has(detailEntry.id)}
          onAdd={() => addSkill(detailEntry)}
          onBack={() => setDetailId(null)}
          pending={installMutation.isPending}
          skill={detailEntry}
        />
      ) : (
        <>
          <StatusFilterBar onChange={setStatus} value={status} />
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        </>
      )}
    </ViewTransition>
  );
}

function stripFrontmatter(source: string): string {
  if (!source.startsWith("---")) {
    return source;
  }
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? source.slice(match[0].length).replace(/^\s+/, "") : source;
}

function DetailBackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      className="-mx-2 mb-3 flex w-fit shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
      onClick={onBack}
      type="button"
    >
      <ArrowLeft className="size-4" /> {label}
    </button>
  );
}

function DetailAddButton({
  added,
  pending,
  onAdd,
}: {
  added: boolean;
  pending: boolean;
  onAdd: () => void;
}) {
  if (added) {
    return (
      <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground text-xs">
        <Check className="size-3.5" /> Added
      </span>
    );
  }
  return (
    <button
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent disabled:opacity-50"
      disabled={pending}
      onClick={onAdd}
      type="button"
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Add
    </button>
  );
}

function DirectorySkillDetail({
  skill,
  installed,
  pending,
  onBack,
  onAdd,
}: {
  skill: { id: string; name: string; description: string };
  installed: boolean;
  pending: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  const bodyQuery = useQuery({
    queryKey: ["directory-skill-body", skill.id],
    queryFn: () => fetchDirectorySkillBody(skill.id),
    retry: false,
    staleTime: 60_000,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailBackButton label="All skills" onBack={onBack} />
      <div className="flex shrink-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted">
          <Feather className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-base text-foreground">
            {skill.name}
          </h2>
          {skill.description ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground leading-5">
              {skill.description}
            </p>
          ) : null}
        </div>
        <DetailAddButton added={installed} onAdd={onAdd} pending={pending} />
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-4">
        {bodyQuery.isLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : bodyQuery.data?.body ? (
          <SimpleMarkdown className="md-body">
            {stripFrontmatter(bodyQuery.data.body)}
          </SimpleMarkdown>
        ) : (
          <p className="text-muted-foreground text-xs">Preview unavailable.</p>
        )}
      </div>
    </div>
  );
}

function DirectoryCapabilityDetail({
  capability,
  installed,
  pending,
  onBack,
  onAdd,
}: {
  capability: {
    id: string;
    name: string;
    description: string;
    icon?: string;
    category?: string;
    skills: string[];
    integrations: string[];
  };
  installed: boolean;
  pending: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <DetailBackButton label="All combos" onBack={onBack} />
      <div className="flex shrink-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-lg">
          {capability.icon ?? <Boxes className="size-4 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate font-semibold text-base text-foreground">
              {capability.name}
            </h2>
            {capability.category ? (
              <span className="shrink-0 rounded-full bg-fg-6 px-2 py-0.5 text-muted-foreground text-xs capitalize">
                {capability.category}
              </span>
            ) : null}
          </div>
          {capability.description ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground leading-5">
              {capability.description}
            </p>
          ) : null}
        </div>
        <DetailAddButton added={installed} onAdd={onAdd} pending={pending} />
      </div>

      {capability.skills.length > 0 ? (
        <section className="mt-5">
          <h3 className="font-medium text-foreground text-sm">
            Includes {capability.skills.length} skills
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {capability.skills.map((skillId) => (
              <li
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
                key={skillId}
              >
                <Feather className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{skillId}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {capability.integrations.length > 0 ? (
        <section className="mt-5">
          <h3 className="font-medium text-foreground text-sm">Connectors</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {capability.integrations.map((provider) => (
              <li
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground text-xs capitalize"
                key={provider}
              >
                <Plug className="size-3.5 text-muted-foreground" />
                {provider}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Card({
  title,
  description,
  icon,
  added,
  addedLabel = "Added",
  addLabel = "Add",
  pending,
  onAdd,
  onOpen,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  added: boolean;
  addedLabel?: string;
  addLabel?: string;
  pending?: boolean;
  onAdd: () => void;
  onOpen?: () => void;
}) {
  const interactive = Boolean(onOpen);
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-border bg-card p-3.5 transition-colors hover:bg-accent/40",
        interactive && "cursor-pointer",
      )}
      onClick={onOpen}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted text-lg">
        {typeof icon === "string" || icon ? (
          icon
        ) : (
          <Boxes className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground text-sm">{title}</p>
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground leading-5">
            {description}
          </p>
        ) : null}
      </div>
      {added ? (
        <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground text-xs">
          <Check className="size-3.5" />
          {addedLabel}
        </span>
      ) : (
        <button
          className="shrink-0 rounded-md border border-border px-2.5 py-1 font-medium text-foreground text-xs transition-colors hover:bg-accent disabled:opacity-50"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
          type="button"
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}
