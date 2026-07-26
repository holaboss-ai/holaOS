import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { cn } from "@/lib/utils";
import { useWorkspaceProjects } from "@/components/layout/shell/useWorkspaceLists";
import { projectViewAtom } from "@/components/layout/shell/state/ui";

import { CreateProjectDialog } from "./CreateProjectDialog";

type SortKey = "updated" | "name";

interface ProjectsIndexProps {
  workspaceId: string | null;
}

export function ProjectsIndex({ workspaceId }: ProjectsIndexProps) {
  const { projects, hasLoaded, setProjects } =
    useWorkspaceProjects(workspaceId);
  const setProjectView = useSetAtom(projectViewAtom);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [renameTarget, setRenameTarget] = useState<{
    projectId: string;
    initial: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    projectId: string;
    name: string;
  } | null>(null);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const filteredList = trimmed
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(trimmed) ||
            p.project_path.toLowerCase().includes(trimmed),
        )
      : projects;
    if (sort === "name") {
      return [...filteredList].sort((a, b) => a.name.localeCompare(b.name));
    }
    return filteredList; // already updated_at DESC from server
  }, [projects, query, sort]);

  const handleCreate = useCallback(
    async ({
      name,
      projectPath,
      createIfMissing,
    }: {
      name: string;
      projectPath: string;
      createIfMissing: boolean;
    }) => {
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const response = await window.electronAPI.workspace.createProject(
        workspaceId,
        {
          name,
          project_path: projectPath,
          create_if_missing: createIfMissing,
        },
      );
      setProjects((current) => [response.project, ...current]);
    },
    [workspaceId, setProjects],
  );

  const handleRename = useCallback(
    async (projectId: string, nextName: string) => {
      if (!workspaceId) return;
      const trimmed = nextName.trim();
      if (!trimmed) return;
      const response = await window.electronAPI.workspace.updateProject(
        workspaceId,
        projectId,
        { name: trimmed },
      );
      setProjects((current) =>
        current.map((p) =>
          p.project_id === projectId ? response.project : p,
        ),
      );
    },
    [workspaceId, setProjects],
  );

  const handleDelete = useCallback(
    async (projectId: string) => {
      if (!workspaceId) return;
      await window.electronAPI.workspace.deleteProject(workspaceId, projectId);
      setProjects((current) =>
        current.filter((p) => p.project_id !== projectId),
      );
    },
    [workspaceId, setProjects],
  );

  if (!workspaceId) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        Select a workspace to view its projects.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader
        actions={
          <>
            <SortMenu sort={sort} onSortChange={setSort} />
            {/* When there are no projects yet, only the centered empty-state
                CTA is shown so the page reads as a single call-to-action. */}
            {projects.length > 0 ? (
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                type="button"
              >
                <Plus className="size-3.5" />
                New project
              </Button>
            ) : null}
          </>
        }
        title="Projects"
      />
      <div className="mx-auto w-full max-w-5xl px-6 pb-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="h-10 pl-9"
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-5xl min-h-0 flex-1 overflow-y-auto px-6 pb-12">
        {!hasLoaded && projects.length === 0 ? (
          <ProjectsSkeletonGrid />
        ) : filtered.length === 0 ? (
          <ProjectsEmptyState
            isLoading={!hasLoaded}
            hasQuery={query.trim().length > 0}
            onCreate={() => setCreateOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((project) => (
              <ProjectCard
                key={project.project_id}
                project={project}
                onOpen={() =>
                  setProjectView({
                    mode: "landing",
                    projectId: project.project_id,
                  })
                }
                onRename={() =>
                  setRenameTarget({
                    projectId: project.project_id,
                    initial: project.name,
                  })
                }
                onDelete={() =>
                  setDeleteTarget({
                    projectId: project.project_id,
                    name: project.name,
                  })
                }
              />
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onConfirm={handleCreate}
      />

      <RenameDialog
        target={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onConfirm={async (next) => {
          if (!renameTarget) return;
          await handleRename(renameTarget.projectId, next);
          setRenameTarget(null);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete project '${deleteTarget?.name ?? ""}'?`}
        description="Sessions in this project move to General. The folder on disk is left untouched."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) {
            void handleDelete(deleteTarget.projectId);
          }
        }}
      />
    </div>
  );
}

const SKELETON_CARD_KEYS = ["a", "b", "c", "d", "e", "f"];

function ProjectsSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SKELETON_CARD_KEYS.map((key) => (
        <div
          className="flex animate-pulse flex-col gap-3 rounded-2xl border border-border bg-card p-4"
          key={key}
        >
          <div className="h-4 w-28 rounded bg-muted" />
          <div className="h-3 w-full max-w-44 rounded bg-muted" />
          <div className="h-3 w-20 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function SortMenu({
  sort,
  onSortChange,
}: {
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="gap-1.5 text-muted-foreground"
            size="sm"
            type="button"
            variant="ghost"
          >
            <span>Sort by</span>
            <span className="font-medium text-foreground">
              {sort === "updated" ? "Last updated" : "Name"}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSortChange("updated")}>
          Last updated
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSortChange("name")}>
          Name
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectCard({
  project,
  onOpen,
  onRename,
  onDelete,
}: {
  project: WorkspaceProjectRecordPayload;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const handleRevealInFinder = useCallback(() => {
    void window.electronAPI.fs?.revealInFolder?.(project.project_path);
  }, [project.project_path]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 p-4",
        "cursor-pointer transition-colors hover:bg-foreground/4",
      )}
    >
      <div className="flex items-start gap-3">
        <WorkspaceIcon
          workspace={{
            id: project.project_id,
            name: project.name,
            icon: project.icon,
            icon_color: project.icon_color,
          }}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {project.name}
            </span>
            {/* Folder-missing dot is computed in a later phase via fs.pathExists.
                For now the spec only requires the card to render — the run-time
                error surfaces if the folder really is gone. */}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Updated {relativeTime(project.updated_at)}
          </p>
        </div>
        <CardOverflow
          onRename={onRename}
          onRevealInFinder={handleRevealInFinder}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function CardOverflow({
  onRename,
  onRevealInFinder,
  onDelete,
}: {
  onRename: () => void;
  onRevealInFinder: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Project actions"
            onClick={(e) => e.stopPropagation()}
            className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground group-hover:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
        >
          <Pencil className="size-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onRevealInFinder();
          }}
        >
          <FolderPlus className="size-3.5" />
          Reveal in Finder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          variant="destructive"
        >
          <Trash2 className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectsEmptyState({
  isLoading,
  hasQuery,
  onCreate,
}: {
  isLoading: boolean;
  hasQuery: boolean;
  onCreate: () => void;
}) {
  if (hasQuery) {
    return (
      <div className="grid place-items-center py-24 text-center">
        <StatusDot variant="muted" />
        <p className="mt-3 text-sm text-muted-foreground">
          No projects match your search.
        </p>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="grid place-items-center py-24 text-sm text-muted-foreground">
        Loading projects…
      </div>
    );
  }
  return (
    <EmptyState
      icon={FolderPlus}
      size="md"
      decorated
      title="No projects yet"
      description="Create a project to give a chat its own folder on disk and a place for ongoing work to build up context."
      action={
        <Button type="button" size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          New project
        </Button>
      }
    />
  );
}

function RenameDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  target: { projectId: string; initial: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (next: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const open = !!target;
  useEffect(() => {
    if (target) {
      setValue(target.initial);
    }
  }, [target]);

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    void onConfirm(next);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[25%] left-1/2 z-[100] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          <DialogPrimitive.Title className="text-base font-semibold text-foreground">
            Rename project
          </DialogPrimitive.Title>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Project name"
            className="mt-3"
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!value.trim()}
              onClick={submit}
            >
              Rename
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
