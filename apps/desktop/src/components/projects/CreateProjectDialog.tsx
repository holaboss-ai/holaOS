import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronRight, FolderPlus, Folder, ArrowLeft } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Two-step create-project modal (Scene 4 in docs/sidebar-wireframe.txt).
 * Step 1: pick "Start from scratch" or "Use an existing folder".
 * Step 2: a mode-specific form. Submitting calls onConfirm with the inputs;
 * the caller is responsible for the actual `createProject` IPC call.
 *
 * The two modes treat name vs. folder differently on purpose:
 *   scratch  → name IS the new folder; user only chooses the root/parent.
 *   existing → folder is fixed on disk; name is an editable display label.
 */

const DEFAULT_PROJECTS_DIR_HOME_RELATIVE = "Documents/Holaboss";

type Origin = "scratch" | "existing";

export interface CreateProjectFormResult {
  name: string;
  projectPath: string;
  createIfMissing: boolean;
}

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: CreateProjectFormResult) => Promise<void> | void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onConfirm,
}: CreateProjectDialogProps) {
  const defaultBaseDir = useMemo(() => defaultProjectsBaseDir(), []);

  const [step, setStep] = useState<"origin" | "form">("origin");
  const [origin, setOrigin] = useState<Origin>("scratch");
  const [name, setName] = useState("");
  const [rootDir, setRootDir] = useState(defaultBaseDir);
  const [folderPath, setFolderPath] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every time the dialog opens.
  useEffect(() => {
    if (open) {
      setStep("origin");
      setOrigin("scratch");
      setName("");
      setRootDir(defaultBaseDir);
      setFolderPath("");
      setNameTouched(false);
      setSubmitting(false);
      setError(null);
    }
  }, [open, defaultBaseDir]);

  const handlePickRoot = async () => {
    try {
      const chosen = await window.electronAPI.workspace.pickProjectFolder();
      if (chosen) {
        setRootDir(chosen);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pick folder");
    }
  };

  const handlePickFolder = async () => {
    try {
      const chosen = await window.electronAPI.workspace.pickProjectFolder();
      if (chosen) {
        setFolderPath(chosen);
        if (!nameTouched) {
          setName(basename(chosen));
        }
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pick folder");
    }
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    let projectPath: string;
    if (origin === "scratch") {
      if (!trimmedName) {
        setError("Name is required");
        return;
      }
      if (!rootDir.trim()) {
        setError("Choose a root folder");
        return;
      }
      projectPath = joinPath(rootDir, trimmedName);
    } else {
      if (!folderPath.trim()) {
        setError("Choose a folder");
        return;
      }
      if (!trimmedName) {
        setError("Name is required");
        return;
      }
      projectPath = folderPath;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        name: trimmedName,
        projectPath,
        createIfMissing: origin === "scratch",
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[18%] left-1/2 z-[100] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover p-6 shadow-2xl outline-none ease-out-expo data-open:duration-stride data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-open:slide-in-from-top-2 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          {step === "origin" ? (
            <OriginStep
              onPick={(next) => {
                setOrigin(next);
                setName("");
                setNameTouched(false);
                setFolderPath("");
                setRootDir(defaultBaseDir);
                setError(null);
                setStep("form");
              }}
            />
          ) : (
            <FormStep
              origin={origin}
              name={name}
              rootDir={rootDir}
              folderPath={folderPath}
              error={error}
              submitting={submitting}
              onBack={() => setStep("origin")}
              onNameChange={(value) => {
                setName(value);
                setNameTouched(true);
                setError(null);
              }}
              onPickRoot={handlePickRoot}
              onPickFolder={handlePickFolder}
              onCancel={() => onOpenChange(false)}
              onSubmit={() => void handleSubmit()}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function OriginStep({
  onPick,
}: {
  onPick: (origin: Origin) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <DialogPrimitive.Title className="text-lg font-semibold text-foreground">
          Create a new project
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
          A dedicated place for ongoing work, where context builds over time.
          Files stay in a folder on your computer.
        </DialogPrimitive.Description>
      </div>
      <button
        type="button"
        onClick={() => onPick("scratch")}
        className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:bg-foreground/4"
      >
        <span className="grid size-9 place-items-center rounded-lg bg-foreground/6 text-muted-foreground">
          <FolderPlus className="size-4" />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-medium text-foreground">
            Start from scratch
          </span>
          <span className="block text-xs text-muted-foreground">
            Set up a new folder for this project.
          </span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
      <button
        type="button"
        onClick={() => onPick("existing")}
        className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:bg-foreground/4"
      >
        <span className="grid size-9 place-items-center rounded-lg bg-foreground/6 text-muted-foreground">
          <Folder className="size-4" />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-medium text-foreground">
            Use an existing folder
          </span>
          <span className="block text-xs text-muted-foreground">
            Give Hola a folder you already work from.
          </span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
    </div>
  );
}

function FormStep({
  origin,
  name,
  rootDir,
  folderPath,
  error,
  submitting,
  onBack,
  onNameChange,
  onPickRoot,
  onPickFolder,
  onCancel,
  onSubmit,
}: {
  origin: Origin;
  name: string;
  rootDir: string;
  folderPath: string;
  error: string | null;
  submitting: boolean;
  onBack: () => void;
  onNameChange: (value: string) => void;
  onPickRoot: () => void;
  onPickFolder: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const isScratch = origin === "scratch";
  const canSubmit = isScratch
    ? Boolean(name.trim() && rootDir.trim())
    : Boolean(folderPath.trim() && name.trim());

  const nameField = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-foreground" htmlFor="project-name">
        Name {isScratch ? <span className="text-destructive">*</span> : null}
      </label>
      <Input
        id="project-name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder={isScratch ? "Project name" : "Display name"}
        autoFocus={isScratch}
        autoComplete="off"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onBack}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <DialogPrimitive.Title className="text-lg font-semibold text-foreground">
          {isScratch ? "Start a new project" : "Use an existing folder"}
        </DialogPrimitive.Title>
      </div>

      {isScratch ? (
        <>
          {nameField}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">
              Root folder
            </label>
            <PathPicker
              path={rootDir}
              placeholder="Choose a root folder…"
              actionLabel="Change…"
              onPick={onPickRoot}
            />
            <p className="truncate text-xs text-muted-foreground">
              Creates{" "}
              <span className="font-mono text-foreground/70">
                {joinPath(rootDir, name.trim() || "Untitled project")}
              </span>
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">
              Folder <span className="text-destructive">*</span>
            </label>
            <PathPicker
              path={folderPath}
              placeholder="Choose a folder…"
              actionLabel="Browse…"
              onPick={onPickFolder}
            />
          </div>
          {nameField}
        </>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={submitting || !canSubmit}
          onClick={onSubmit}
        >
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function PathPicker({
  path,
  placeholder,
  actionLabel,
  onPick,
}: {
  path: string;
  placeholder: string;
  actionLabel: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "group flex h-10 items-center gap-2 rounded-md border border-border bg-background/40 pr-1.5 pl-3 text-left text-sm transition-colors hover:bg-foreground/4",
        !path && "text-muted-foreground",
      )}
    >
      <Folder className="size-4 text-muted-foreground" />
      <span className="flex-1 truncate font-mono text-xs">
        {path || placeholder}
      </span>
      <span className="shrink-0 rounded-md border border-border bg-foreground/5 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover:bg-foreground/8 group-hover:text-foreground">
        {actionLabel}
      </span>
    </button>
  );
}

function joinPath(root: string, leaf: string): string {
  return `${root.replace(/\/+$/, "")}/${leaf}`;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last ?? p;
}

function defaultProjectsBaseDir(): string {
  // Prefer process.env.HOME (electron renderer has it via the preload bridge
  // when Node integration is on). Fall back to "~" if unavailable; the
  // runtime expands ~ when creating the directory.
  const home =
    typeof process !== "undefined" && process.env?.HOME
      ? process.env.HOME
      : "~";
  return `${home}/${DEFAULT_PROJECTS_DIR_HOME_RELATIVE}`;
}
