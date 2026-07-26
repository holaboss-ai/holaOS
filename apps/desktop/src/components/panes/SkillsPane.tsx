import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceSkills } from "@/lib/useWorkspaceSkills";
import {
  ChevronLeft,
  ChevronRight,
  Feather,
  FileText,
  FolderOpen,
  Info,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Store,
  Trash2,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { useShellSurfaceLeftInset } from "@/components/layout/shell/useShellSurfaceLeftInset";
import { cn } from "@/lib/utils";

interface SkillsPaneProps {
  workspaceId: string | null;
  onCreateSkill?: () => void;
  /** Opens the Directory on the Skills tab. */
  onBrowse?: () => void;
  /** Hands the skill off to a fresh draft chat with the composer seeded. */
  onTryWithAgent?: (skillId: string, title: string) => void;
  /** Hide the rail's "Skills" title when an outer surface already labels the
   * section (e.g. Customize's segmented control). */
  hideTitle?: boolean;
  /** True when rendered as a full-window overlay (the Skills tab) rather than
   * embedded in another surface. Reserves the macOS stoplight / floating
   * expand-button gutter on the rail header when the sidebar is collapsed. */
  fullSurface?: boolean;
  /** "master-detail" (default) is the persistent left rail + detail — right for
   * the full-window overlay. "grid" mirrors the marketplace: a card grid that
   * drills into a full-width detail, so the embedded Customize view aligns with
   * the centered PageHeader column instead of a full-bleed two-pane. */
  layout?: "master-detail" | "grid";
}

function formatRelative(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const diffMin = Math.round((Date.now() - parsed) / 60_000);
  if (Math.abs(diffMin) < 1) return "just now";
  if (Math.abs(diffMin) < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// SKILL.md ships with YAML frontmatter (name / description). ReactMarkdown
// has no frontmatter awareness, so a leading `---\n...\n---` block gets
// parsed as a setext heading underline and the metadata renders as a giant
// H1 above the real body. Strip it — the same fields already drive the
// title + Description block in the detail pane.
function stripFrontmatter(source: string): string {
  if (!source.startsWith("---")) return source;
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? source.slice(match[0].length).replace(/^\s+/, "") : source;
}

export function SkillsPane({
  workspaceId,
  onCreateSkill,
  onBrowse,
  onTryWithAgent,
  hideTitle = false,
  fullSurface = false,
  layout = "master-detail",
}: SkillsPaneProps) {
  const isGrid = layout === "grid";
  const skillsQuery = useWorkspaceSkills(workspaceId);
  const data = skillsQuery.data ?? null;
  const loading = skillsQuery.isFetching;
  const [actionError, setActionError] = useState<string | null>(null);
  const error =
    actionError ??
    (skillsQuery.error
      ? skillsQuery.error instanceof Error
        ? skillsQuery.error.message
        : "Failed to load skills."
      : null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillBodies, setSkillBodies] = useState<Record<string, string | null>>(
    {},
  );
  const [pendingDelete, setPendingDelete] =
    useState<WorkspaceSkillRecordPayload | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const skills = data?.skills ?? [];
  const trimmedQuery = query.trim().toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!trimmedQuery) return skills;
    return skills.filter((s) => {
      const haystack = [s.title, s.summary, s.skill_id, s.skill_file_path]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [skills, trimmedQuery]);

  // Default selection: first skill once data loads. Re-anchor when the
  // selected skill drops out of the filter so the right pane never
  // displays a stale ghost. Grid mode opens on the card grid (no selection),
  // so it opts out — selection there means "drilled into a detail".
  useEffect(() => {
    if (isGrid) return;
    if (filteredSkills.length === 0) {
      if (selectedSkillId !== null) setSelectedSkillId(null);
      return;
    }
    const stillVisible = filteredSkills.some(
      (s) => s.skill_id === selectedSkillId,
    );
    if (!stillVisible) {
      setSelectedSkillId(filteredSkills[0].skill_id);
    }
  }, [filteredSkills, selectedSkillId, isGrid]);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.skill_id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  );

  const handleRevealSkill = useCallback(
    (sourceDir: string) => {
      void window.electronAPI?.fs?.revealInFolder?.(sourceDir, workspaceId);
    },
    [workspaceId],
  );

  // Lazy-load the SKILL.md body for the currently selected skill.
  useEffect(() => {
    if (!workspaceId || !selectedSkill) return;
    const key = selectedSkill.skill_id;
    if (key in skillBodies) return;
    setSkillBodies((prev) => ({ ...prev, [key]: null }));
    void window.electronAPI?.fs
      ?.readFilePreview?.(selectedSkill.skill_file_path, workspaceId)
      .then((response) => {
        const content =
          response?.kind === "text" ? response.content ?? "" : "";
        setSkillBodies((prev) => ({ ...prev, [key]: content }));
      })
      .catch(() => {
        setSkillBodies((prev) => ({ ...prev, [key]: "" }));
      });
  }, [selectedSkill, workspaceId, skillBodies]);

  // Refreshing the skill list should also drop the cached trees/bodies
  // so a renamed / re-edited skill picks up new content on next view.
  const handleRefresh = useCallback(async () => {
    setSkillBodies({});
    setActionError(null);
    await skillsQuery.refetch();
  }, [skillsQuery]);

  const handleSelectSkill = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!workspaceId || !pendingDelete) return;
    const skillId = pendingDelete.skill_id;
    setDeleting(true);
    try {
      await window.electronAPI?.workspace?.deleteSkill?.({
        workspaceId,
        skillId,
      });
      setSkillBodies((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });
      setActionError(null);
      await skillsQuery.refetch();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to delete skill.",
      );
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }, [workspaceId, pendingDelete, skillsQuery]);

  const handleToggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      const next = !prev;
      if (!next) {
        setQuery("");
      } else {
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      return next;
    });
  }, []);

  // Rail header sits at x=0 when this is the full-window Skills overlay and the
  // sidebar is collapsed; reserve the stoplight / expand-button gutter then.
  const railHeaderPaddingLeft = useShellSurfaceLeftInset(
    hideTitle ? "0.75rem" : "1rem",
  );

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={Feather}
          title="No workspace selected"
          description="Open a workspace to manage its skills."
          size="md"
        />
      </div>
    );
  }

  const hasAnySkills = skills.length > 0;

  // Grid layout: a marketplace-style card grid that drills into a full-width
  // detail. Aligns with the centered PageHeader column instead of the
  // full-bleed rail+detail the overlay uses.
  if (isGrid) {
    if (selectedSkill) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
            <SkillDetail
              body={skillBodies[selectedSkill.skill_id] ?? null}
              onBack={() => setSelectedSkillId(null)}
              onDelete={() => setPendingDelete(selectedSkill)}
              onRefresh={handleRefresh}
              onReveal={() => handleRevealSkill(selectedSkill.source_dir)}
              onTryWithAgent={
                onTryWithAgent
                  ? () =>
                      onTryWithAgent(
                        selectedSkill.skill_id,
                        selectedSkill.title || selectedSkill.skill_id,
                      )
                  : undefined
              }
              refreshing={loading}
              skill={selectedSkill}
            />
          </div>
          <ConfirmDialog
            confirmLabel="Delete"
            description={`This removes "${pendingDelete?.title ?? pendingDelete?.skill_id}" from the workspace.`}
            destructive
            onConfirm={handleConfirmDelete}
            onOpenChange={(open) => {
              if (!open) setPendingDelete(null);
            }}
            open={pendingDelete !== null}
            title="Delete skill?"
          />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-3 px-6 py-2.5">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search skills"
              className="h-8 w-full rounded-md pl-8 text-sm"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              value={query}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable_both-edges]">
          {error ? (
            <div className="mx-auto max-w-5xl px-6">
              <EmptyState
                description={error}
                icon={Feather}
                size="sm"
                title="Couldn't load skills"
              />
            </div>
          ) : loading && skills.length === 0 ? (
            <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-4 gap-y-2 px-6 sm:grid-cols-2">
              {["a", "b", "c", "d"].map((key) => (
                <div
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                  key={key}
                >
                  <Skeleton className="size-9 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="mt-1.5 h-3 w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="mx-auto max-w-5xl px-6">
              <EmptyState
                description={
                  <>
                    Skills live in{" "}
                    <code className="font-mono text-xs">skills/</code> inside the
                    workspace.
                  </>
                }
                icon={Feather}
                size="md"
                title="No skills yet"
              />
            </div>
          ) : filteredSkills.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">
              No skills match “{query.trim()}”.
            </p>
          ) : (
            <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-4 gap-y-2 px-6 sm:grid-cols-2">
              {filteredSkills.map((skill) => (
                <InstalledSkillCard
                  key={skill.skill_id}
                  onOpen={() => handleSelectSkill(skill.skill_id)}
                  skill={skill}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail — skill index */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-background">
        <header
          className={cn(
            "flex h-12 shrink-0 items-center border-b border-border",
            hideTitle ? "gap-1.5" : "gap-1",
            fullSurface
              ? "pr-3 transition-[padding-left] duration-stride ease-out-expo"
              : hideTitle
                ? "px-3"
                : "px-4",
          )}
          style={
            fullSurface ? { paddingLeft: railHeaderPaddingLeft } : undefined
          }
        >
          {hideTitle ? (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search skills"
                className="embedded-input h-7 w-full rounded-md pl-7 text-xs focus-visible:ring-0"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                value={query}
              />
            </div>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                Skills
              </span>
              {hasAnySkills ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleToggleSearch}
                  aria-label={searchOpen ? "Close search" : "Search skills"}
                  aria-pressed={searchOpen}
                  className={cn(searchOpen && "bg-foreground/[0.06]")}
                >
                  <Search className="size-3.5" />
                </Button>
              ) : null}
            </>
          )}
          {onCreateSkill || onBrowse ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Add a skill"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none data-[popup-open]:bg-accent"
              >
                <Plus className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onBrowse ? (
                  <DropdownMenuItem onClick={onBrowse}>
                    <Store className="text-muted-foreground" />
                    Browse skills
                  </DropdownMenuItem>
                ) : null}
                {onCreateSkill ? (
                  <DropdownMenuItem onClick={onCreateSkill}>
                    <Sparkles className="text-muted-foreground" />
                    Create with agent
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>

        {!hideTitle && searchOpen ? (
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="embedded-input h-7 w-full rounded-md pl-7 text-xs focus-visible:ring-0"
              />
            </div>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="p-4">
              <EmptyState
                icon={Feather}
                title="Couldn't load skills"
                description={error}
                size="sm"
              />
            </div>
          ) : loading && skills.length === 0 ? (
            <ul
              aria-busy="true"
              aria-label="Loading skills"
              className="flex flex-col gap-0.5 px-2 py-2"
              role="status"
            >
              {["w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2"].map(
                (width, index) => (
                  <li
                    className="flex h-7 items-center rounded-md px-2"
                    // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
                    key={index}
                  >
                    <Skeleton className={`h-3 ${width}`} />
                  </li>
                ),
              )}
            </ul>
          ) : skills.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={Feather}
                title="No skills yet"
                description={
                  <>
                    Skills live in{" "}
                    <code className="font-mono text-xs">skills/</code>{" "}
                    inside the workspace.
                  </>
                }
                size="sm"
              />
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No skills match “{query.trim()}”.
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5 px-2 py-2">
              {filteredSkills.map((skill) => (
                <li key={skill.skill_id}>
                  <SkillRow
                    label={skill.title || skill.skill_id}
                    selected={selectedSkillId === skill.skill_id}
                    onSelect={() => handleSelectSkill(skill.skill_id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Right pane — selected skill detail */}
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        {selectedSkill ? (
          <SkillDetail
            skill={selectedSkill}
            body={skillBodies[selectedSkill.skill_id] ?? null}
            onRefresh={handleRefresh}
            onReveal={() => handleRevealSkill(selectedSkill.source_dir)}
            onDelete={() => setPendingDelete(selectedSkill)}
            onTryWithAgent={
              onTryWithAgent
                ? () =>
                    onTryWithAgent(
                      selectedSkill.skill_id,
                      selectedSkill.title || selectedSkill.skill_id,
                    )
                : undefined
            }
            refreshing={loading}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={Feather}
              title="Select a skill"
              description="Choose a skill from the left to preview its instructions and files."
              size="md"
            />
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
        title="Delete this skill?"
        description={
          pendingDelete
            ? `"${pendingDelete.title || pendingDelete.skill_id}" and its files will be permanently removed from this workspace.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}

function SkillRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
        selected
          ? "bg-foreground/[0.06] text-foreground"
          : "text-foreground/85 hover:bg-foreground/[0.04]",
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          selected ? "font-medium" : "",
        )}
      >
        {label}
      </span>
    </button>
  );
}

// Grid-layout card for one installed skill — mirrors the marketplace SkillRow
// so the Installed view reads as the same surface. Drills into SkillDetail.
function InstalledSkillCard({
  skill,
  onOpen,
}: {
  skill: WorkspaceSkillRecordPayload;
  onOpen: () => void;
}) {
  const summary = skill.summary?.trim() ?? "";
  return (
    <button
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
      onClick={onOpen}
      type="button"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <Feather className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-[15px] text-foreground leading-tight">
          {skill.title || skill.skill_id}
        </p>
        {summary ? (
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground leading-5">
            {summary}
          </p>
        ) : null}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function SkillDetail({
  skill,
  body,
  onRefresh,
  onReveal,
  onDelete,
  onTryWithAgent,
  onBack,
  refreshing,
}: {
  skill: WorkspaceSkillRecordPayload;
  body: string | null;
  onRefresh: () => void | Promise<void>;
  onReveal: () => void;
  onDelete?: () => void;
  onTryWithAgent?: () => void;
  /** Back to the grid — only set in grid layout, renders a leading back link. */
  onBack?: () => void;
  refreshing: boolean;
}) {
  const description = skill.summary?.trim() ?? "";
  const updated = formatRelative(skill.modified_at);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6">
        {onBack ? (
          <button
            className="-ml-2 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
            onClick={onBack}
            type="button"
          >
            <ChevronLeft className="size-3.5" />
            Installed
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {skill.title || skill.skill_id}
        </span>
        {onTryWithAgent ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onTryWithAgent}
          >
            <Sparkles className="size-3.5" />
            Try with agent
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Skill actions"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-48">
            <DropdownMenuItem
              onClick={() => void onRefresh()}
              disabled={refreshing}
            >
              <RotateCw
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
              Refresh
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReveal}>
              <FolderOpen className="size-3.5" />
              Reveal skill folder
            </DropdownMenuItem>
            {onDelete ? (
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-3.5" />
                Delete skill
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1 text-[12px]">
          <dt className="text-muted-foreground">Skill ID</dt>
          <dt className="text-muted-foreground">Updated</dt>
          <dd className="font-mono text-foreground/85">{skill.skill_id}</dd>
          <dd className="text-foreground/85">{updated}</dd>
        </dl>

        <div className="mt-5">
          <div className="mb-1.5 flex items-center gap-1 text-[12px] text-muted-foreground">
            Description
            <Info className="size-3" strokeWidth={1.75} />
          </div>
          {description ? (
            <p className="text-[13px] leading-relaxed text-foreground/85">
              {description}
            </p>
          ) : (
            <p className="text-[12px] italic text-muted-foreground">
              No description in SKILL.md frontmatter.
            </p>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-border bg-background px-5 py-4">
          {body === null ? (
            <div className="text-[12px] text-muted-foreground">
              Loading SKILL.md…
            </div>
          ) : (() => {
              const renderable = stripFrontmatter(body);
              if (renderable.trim().length === 0) {
                return (
                  <div className="text-[12px] text-muted-foreground">
                    SKILL.md has no body beyond its frontmatter.
                  </div>
                );
              }
              return (
                <SimpleMarkdown className="md-body">{renderable}</SimpleMarkdown>
              );
            })()}
        </div>
      </div>
    </div>
  );
}
