import {
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  ImagePlus,
  Loader2,
  Pencil,
  Sparkles,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AppIcon } from "@/components/marketplace/AppIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { cn } from "@/lib/utils";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";

import { BundleFileTree } from "./BundleFileTree";
import { LivePreviewPanel } from "./LivePreviewPanel";
import { useNameCheck } from "./useNameCheck";
import {
  clearDraft,
  loadDraft,
  useDraftRestore,
  usePublishDraftAutosave,
} from "./usePublishDraft";
import { usePublishFlow } from "./usePublishFlow";

export interface PublishScreenProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Deep link callback — opens the Submissions panel filtered to this id. */
  onViewSubmission?: (submissionId: string) => void;
}

type StepId = "about" | "bundle" | "docs";

interface StepDef {
  id: StepId;
  title: string;
}

const STEPS: StepDef[] = [
  { id: "about", title: "Tell us about your template" },
  { id: "bundle", title: "Choose what to bundle" },
  { id: "docs", title: "Add docs (optional)" },
];

const CATEGORIES = [
  { id: "marketing", label: "Marketing" },
  { id: "growth", label: "Growth" },
  { id: "operations", label: "Operations" },
  { id: "general", label: "General" },
];

function formatBytes(n: number): string {
  if (!n) {
    return "0 B";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelative(ms: number | null): string {
  if (ms === null) {
    return "";
  }
  const ago = Math.floor(ms / 1000);
  if (ago < 60) {
    return "just now";
  }
  if (ago < 3600) {
    return `${Math.floor(ago / 60)}m ago`;
  }
  if (ago < 86_400) {
    return `${Math.floor(ago / 3600)}h ago`;
  }
  return `${Math.floor(ago / 86_400)}d ago`;
}

export function PublishScreen({
  open,
  onOpenChange,
  workspaceId,
  onViewSubmission,
}: PublishScreenProps) {
  const { data: session } = useDesktopAuthSession();
  const { installedApps, selectedWorkspace } = useWorkspaceDesktop();

  const userId = session?.user.id ?? "";
  const userName = session?.user.name ?? "";
  const userEmail = session?.user.email ?? "";
  // Display handle: prefer real name, fall back to email's local-part. Never
  // both, never the full email — just enough for the user to know "yes, this
  // is the account I'm publishing under" at a glance.
  const userHandle = userName.trim() || userEmail.split("@")[0] || "";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [step, setStep] = useState<StepId>("about");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("marketing");
  const [tagsInput, setTagsInput] = useState("");
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [appsInitialized, setAppsInitialized] = useState(false);
  const [onboardingMd, setOnboardingMd] = useState("");
  const [readmeMd, setReadmeMd] = useState("");
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  // Workspace-relative paths the user has opted out of bundling. Stored as a
  // sorted string[] (rather than Set) so it serializes cleanly into draft JSON
  // and the IPC payload. UI uses an in-memory Set derived from this array.
  const [forceExcludePaths, setForceExcludePaths] = useState<string[]>([]);

  const [isGeneratingOnboarding, setIsGeneratingOnboarding] = useState(false);
  const [isGeneratingReadme, setIsGeneratingReadme] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [pendingGenerated, setPendingGenerated] = useState<{
    target: "onboarding" | "readme";
    content: string;
  } | null>(null);

  const tags = useMemo(
    () =>
      tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    [tagsInput],
  );

  const nameCheck = useNameCheck(name);
  const flow = usePublishFlow();

  // ---------------------------------------------------------------------------
  // Draft autosave + restore
  // ---------------------------------------------------------------------------
  const draftPayload = useMemo(
    () => ({
      name,
      description,
      category,
      tags: tagsInput,
      selectedApps,
      onboardingMd,
      readmeMd,
      coverImageDataUrl: coverImage,
      screenshotsDataUrls: screenshots,
      forceExcludePaths,
    }),
    [
      name,
      description,
      category,
      tagsInput,
      selectedApps,
      onboardingMd,
      readmeMd,
      coverImage,
      screenshots,
      forceExcludePaths,
    ],
  );

  const isDraftDirty = useMemo(
    () =>
      name.trim().length > 0 ||
      description.trim().length > 0 ||
      onboardingMd.trim().length > 0 ||
      readmeMd.trim().length > 0 ||
      coverImage !== null ||
      screenshots.length > 0 ||
      tagsInput.trim().length > 0,
    [
      name,
      description,
      onboardingMd,
      readmeMd,
      coverImage,
      screenshots,
      tagsInput,
    ],
  );

  const savedAt = usePublishDraftAutosave(
    workspaceId,
    draftPayload,
    open && isDraftDirty,
  );
  const draftRestore = useDraftRestore(workspaceId);
  const [restorePromptDismissed, setRestorePromptDismissed] = useState(false);

  // Pre-select all installed apps on first open.
  useEffect(() => {
    if (
      !appsInitialized &&
      installedApps.length > 0 &&
      selectedApps.length === 0
    ) {
      setSelectedApps(installedApps.map((a) => a.id));
      setAppsInitialized(true);
    }
  }, [installedApps, appsInitialized, selectedApps.length]);

  // Reset state when dialog closes.
  useEffect(() => {
    if (!open) {
      setStep("about");
      setName("");
      setDescription("");
      setCategory("marketing");
      setTagsInput("");
      setSelectedApps([]);
      setAppsInitialized(false);
      setOnboardingMd("");
      setReadmeMd("");
      setCoverImage(null);
      setScreenshots([]);
      setForceExcludePaths([]);
      setGenerationError(null);
      setPendingGenerated(null);
      setRestorePromptDismissed(false);
      flow.reset();
      document.body.style.overflow = "";
      return;
    }
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc key closes when idle.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && flow.phase.status === "idle") {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onOpenChange, flow.phase.status]);

  // ---------------------------------------------------------------------------
  // Validation + flow control
  // ---------------------------------------------------------------------------
  const aboutValid =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    nameCheck.status !== "taken";
  const inFlight =
    flow.phase.status === "creating" ||
    flow.phase.status === "packaging" ||
    flow.phase.status === "uploading" ||
    flow.phase.status === "finalizing";
  const canPublish = aboutValid && !inFlight;

  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const isLastStep = stepIdx === STEPS.length - 1;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const restoreDraft = () => {
    const existing = draftRestore.restore();
    if (!existing) {
      return;
    }
    setName(existing.name);
    setDescription(existing.description);
    setCategory(existing.category);
    setTagsInput(existing.tags);
    setSelectedApps(existing.selectedApps);
    setAppsInitialized(true);
    setOnboardingMd(existing.onboardingMd);
    setReadmeMd(existing.readmeMd);
    setCoverImage(existing.coverImageDataUrl);
    setScreenshots(existing.screenshotsDataUrls);
    setForceExcludePaths(existing.forceExcludePaths ?? []);
    setRestorePromptDismissed(true);
  };

  const handleGenerate = async (
    target: "onboarding" | "readme",
    mode: "from_scratch" | "improve",
  ) => {
    const setter =
      target === "onboarding"
        ? setIsGeneratingOnboarding
        : setIsGeneratingReadme;
    const existingContent = target === "onboarding" ? onboardingMd : readmeMd;
    setter(true);
    setGenerationError(null);
    try {
      const result = await window.electronAPI.workspace.generateTemplateContent(
        {
          contentType: target,
          name,
          description,
          category,
          tags,
          apps: selectedApps,
        },
      );
      if (mode === "improve" && existingContent.trim().length > 0) {
        setPendingGenerated({ target, content: result.content });
      } else if (target === "onboarding") {
        setOnboardingMd(result.content);
      } else {
        setReadmeMd(result.content);
      }
    } catch (err) {
      setGenerationError(
        err instanceof Error ? err.message : "Generation failed",
      );
    } finally {
      setter(false);
    }
  };

  const acceptGenerated = () => {
    if (!pendingGenerated) {
      return;
    }
    if (pendingGenerated.target === "onboarding") {
      setOnboardingMd(pendingGenerated.content);
    } else {
      setReadmeMd(pendingGenerated.content);
    }
    setPendingGenerated(null);
  };

  const handlePublish = async () => {
    if (!(canPublish && userId)) {
      return;
    }
    await flow.start({
      workspaceId,
      name,
      description,
      authorName: userName,
      category,
      tags,
      apps: selectedApps,
      onboardingMd: onboardingMd.trim() ? onboardingMd : null,
      readmeMd: readmeMd.trim() ? readmeMd : null,
      userId,
      forceExcludePaths,
    });
  };

  const handleRetry = async () => {
    if (flow.phase.status !== "error") {
      return;
    }
    const failed = flow.phase;
    await flow.retry({
      workspaceId,
      name,
      description,
      authorName: userName,
      category,
      tags,
      apps: selectedApps,
      onboardingMd: onboardingMd.trim() ? onboardingMd : null,
      readmeMd: readmeMd.trim() ? readmeMd : null,
      userId,
      forceExcludePaths,
      resume:
        failed.failedAt === "creating"
          ? undefined
          : failed.submissionId && failed.uploadUrl && failed.templateId
            ? {
                submissionId: failed.submissionId,
                templateId: failed.templateId,
                uploadUrl: failed.uploadUrl,
              }
            : undefined,
    });
  };

  const handleDoneAfterSuccess = () => {
    if (workspaceId) {
      clearDraft(workspaceId);
    }
    onOpenChange(false);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (!open) {
    return null;
  }

  const phase = flow.phase;
  const showRestorePrompt =
    open &&
    !restorePromptDismissed &&
    draftRestore.hasDraft &&
    !isDraftDirty &&
    loadDraft(workspaceId)?.savedAt !== savedAt;

  const previewData = {
    name,
    description,
    category,
    tags,
    authorName: userName,
    apps: installedApps
      .filter((a) => selectedApps.includes(a.id))
      .map((a) => ({ id: a.id, label: a.label })),
    coverImage,
    screenshots,
    readmeMd,
    onboardingMd,
  };

  const content = (
    <div
      aria-labelledby="publish-screen-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-fg-2"
      role="dialog"
    >
      {/* macOS draggable title-bar region */}
      <div className="titlebar-drag-region pointer-events-none fixed top-0 right-0 left-0 z-10 h-[38px]" />

      {/* Top chrome */}
      <header className="relative z-20 flex shrink-0 items-center justify-between px-5 pt-[44px] pb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{selectedWorkspace?.name ?? "Workspace"}</span>
          {savedAt !== null && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-fg-4 px-1.5 py-0.5 text-xs">
              <StatusDot variant="success" />
              Saved {formatRelative(Date.now() - savedAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {userHandle && (
            <span
              className="text-xs text-muted-foreground"
              title={userEmail || userName}
            >
              as{" "}
              <span className="font-medium text-foreground">{userHandle}</span>
            </span>
          )}
          {phase.status !== "success" && (
            <Button
              aria-label="Close"
              disabled={inFlight}
              onClick={() => onOpenChange(false)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </header>

      {/* Restore prompt */}
      {showRestorePrompt && (
        <div className="mx-auto mb-1 flex w-full max-w-6xl items-center justify-between gap-3 rounded-md bg-info/8 px-3 py-1.5 text-xs">
          <p className="truncate">
            <span className="font-medium">Resume your draft?</span>{" "}
            <span className="text-muted-foreground">
              From {formatRelative(draftRestore.draftAge)}.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              className="h-6 px-2 text-xs"
              onClick={restoreDraft}
              size="xs"
              type="button"
              variant="default"
            >
              Restore
            </Button>
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => {
                draftRestore.discard();
                setRestorePromptDismissed(true);
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {/* Body */}
      {phase.status === "success" ? (
        <PublishSuccessView
          archiveSizeBytes={phase.archiveSizeBytes}
          onDone={handleDoneAfterSuccess}
          onPublishAnother={() => {
            clearDraft(workspaceId);
            flow.reset();
            setName("");
            setDescription("");
            setOnboardingMd("");
            setReadmeMd("");
            setCoverImage(null);
            setScreenshots([]);
            setStep("about");
          }}
          onViewSubmission={() => {
            if (onViewSubmission) {
              onViewSubmission(phase.submissionId);
            }
            onOpenChange(false);
          }}
          submissionId={phase.submissionId}
          templateId={phase.templateId}
        />
      ) : (
        <main className="flex min-h-0 flex-1 items-start justify-center px-5 pb-5">
          <div className="grid h-full min-h-0 w-full max-w-6xl grid-cols-1 grid-rows-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* Left: form column */}
            <section className="flex min-h-0 flex-col overflow-y-auto rounded-2xl bg-background shadow-xs">
              <div className="flex min-h-full flex-col px-10 pt-10 pb-12">
                {/* Step counter + big title — re-keyed so the title fades + slides on step change */}
                <div
                  className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out"
                  key={`title-${step}`}
                >
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {stepIdx + 1}/{STEPS.length}
                  </p>
                  <h1
                    className="mt-2 text-2xl font-semibold tracking-tight"
                    id="publish-screen-title"
                  >
                    {STEPS[stepIdx]!.title}
                  </h1>
                </div>

                {/* Form body — keyed by step so each switch re-mounts and
                    the tw-animate-css enter classes fire. */}
                <div
                  className="mt-7 flex-1 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out"
                  key={`form-${step}`}
                >
                  {step === "about" && (
                    <AboutForm
                      category={category}
                      coverImage={coverImage}
                      description={description}
                      name={name}
                      nameCheck={nameCheck}
                      onCategoryChange={setCategory}
                      onCoverImageChange={setCoverImage}
                      onDescriptionChange={setDescription}
                      onNameChange={setName}
                      onScreenshotsChange={setScreenshots}
                      onTagsChange={setTagsInput}
                      screenshots={screenshots}
                      tagsInput={tagsInput}
                    />
                  )}
                  {step === "bundle" && (
                    <div className="space-y-7">
                      <BundleForm
                        apps={installedApps}
                        onSelectedAppsChange={setSelectedApps}
                        selectedApps={selectedApps}
                      />
                      <BundleFileTree
                        forceExcludePaths={forceExcludePaths}
                        onForceExcludePathsChange={setForceExcludePaths}
                        workspaceId={workspaceId}
                      />
                    </div>
                  )}
                  {step === "docs" && (
                    <DocsForm
                      generationError={generationError}
                      isGeneratingOnboarding={isGeneratingOnboarding}
                      isGeneratingReadme={isGeneratingReadme}
                      name={name}
                      onAcceptGenerated={acceptGenerated}
                      onDiscardGenerated={() => setPendingGenerated(null)}
                      onGenerate={handleGenerate}
                      onOnboardingChange={setOnboardingMd}
                      onReadmeChange={setReadmeMd}
                      onboardingMd={onboardingMd}
                      pendingGenerated={pendingGenerated}
                      readmeMd={readmeMd}
                    />
                  )}
                </div>

                {/* Phase strip & error */}
                {(phase.status === "creating" ||
                  phase.status === "packaging" ||
                  phase.status === "uploading" ||
                  phase.status === "finalizing") && (
                  <div className="mt-6 rounded-lg bg-fg-2 px-4 py-3 shadow-2xs">
                    <PhaseStrip phase={phase} />
                  </div>
                )}
                {phase.status === "error" && (
                  <div className="mt-6 flex items-start gap-3 rounded-lg bg-destructive/8 px-3 py-2.5">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-destructive">
                        Publish failed at {phase.failedAt}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {phase.message}
                      </p>
                    </div>
                    <Button
                      onClick={handleRetry}
                      size="sm"
                      type="button"
                      variant="default"
                    >
                      Retry
                    </Button>
                  </div>
                )}

                {/* Action bar */}
                <div className="mt-auto space-y-3 pt-8">
                  <div className="flex items-center gap-2.5">
                    {stepIdx > 0 ? (
                      <Button
                        className="flex-1"
                        disabled={inFlight}
                        onClick={() => setStep(STEPS[stepIdx - 1]!.id)}
                        size="lg"
                        type="button"
                        variant="bordered"
                      >
                        Back
                      </Button>
                    ) : null}
                    {isLastStep ? (
                      <Button
                        className="flex-1"
                        disabled={!canPublish || inFlight}
                        onClick={handlePublish}
                        size="lg"
                        type="button"
                      >
                        {inFlight ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Publishing…
                          </>
                        ) : (
                          <>
                            <Upload className="size-3.5" />
                            Publish to Store
                          </>
                        )}
                      </Button>
                    ) : (
                      <Button
                        className="flex-1 mb-10"
                        disabled={inFlight || (step === "about" && !aboutValid)}
                        onClick={() => setStep(STEPS[stepIdx + 1]!.id)}
                        size="lg"
                        type="button"
                      >
                        Continue
                        <ArrowRight className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Right: live preview — slides in from the right on first mount,
                then the inner content fades on step change (keyed below). */}
            <section className="hidden min-h-0 overflow-hidden rounded-2xl bg-fg-2 ring-1 ring-border/35 animate-in fade-in-0 slide-in-from-right-2 duration-300 ease-out lg:block">
              <LivePreviewPanel
                data={previewData}
                forceExcludePaths={forceExcludePaths}
                step={step}
                workspaceId={workspaceId}
              />
            </section>
          </div>
        </main>
      )}
    </div>
  );

  return createPortal(content, document.body);
}

// ---------------------------------------------------------------------------
// Step 1: About — name, description, category, tags, cover, screenshots
// ---------------------------------------------------------------------------
interface AboutFormProps {
  name: string;
  description: string;
  category: string;
  tagsInput: string;
  coverImage: string | null;
  screenshots: string[];
  nameCheck: ReturnType<typeof useNameCheck>;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onTagsChange: (v: string) => void;
  onCoverImageChange: (v: string | null) => void;
  onScreenshotsChange: (v: string[]) => void;
}

function AboutForm({
  name,
  description,
  category,
  tagsInput,
  coverImage,
  screenshots,
  nameCheck,
  onNameChange,
  onDescriptionChange,
  onCategoryChange,
  onTagsChange,
  onCoverImageChange,
  onScreenshotsChange,
}: AboutFormProps) {
  return (
    <div className="space-y-5">
      <Field
        help={
          nameCheck.status === "available" && nameCheck.reason === "checked"
            ? `Will publish as ${nameCheck.slug}`
            : nameCheck.status === "available"
              ? `Will publish as ${nameCheck.slug} · server check skipped`
              : nameCheck.status === "taken" && nameCheck.conflict === "yours"
                ? "You already own this name — this becomes a new version"
                : nameCheck.status === "invalid"
                  ? "Use letters or numbers"
                  : null
        }
        htmlFor="pub-name"
        label="Name"
        required
      >
        <div className="relative">
          <Input
            autoFocus
            className="pr-9"
            id="pub-name"
            maxLength={64}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="My Template Name"
            value={name}
          />
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <NameCheckPill state={nameCheck} />
          </span>
        </div>
      </Field>

      <Field
        counter={`${description.length}/500`}
        help="The first sentence shows in the marketplace grid."
        htmlFor="pub-desc"
        label="Description"
        required
      >
        <textarea
          className="flex min-h-[88px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          id="pub-desc"
          maxLength={500}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What does this template do, and who is it for?"
          rows={3}
          value={description}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field htmlFor="pub-cat" label="Category">
          <Select
            onValueChange={(v) => v && onCategoryChange(v)}
            value={category}
          >
            <SelectTrigger className="w-full" id="pub-cat">
              <SelectValue placeholder="Select a category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          help="Press enter or comma to add"
          htmlFor="pub-tags"
          label={
            <>
              Tags <Tags className="size-3.5 text-muted-foreground" />
            </>
          }
        >
          <TagsChipInput onChange={onTagsChange} value={tagsInput} />
        </Field>
      </div>

      <Field
        htmlFor=""
        label={
          <>
            Cover{" "}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              Recommended
            </span>
          </>
        }
      >
        <CoverUploader onChange={onCoverImageChange} value={coverImage} />
      </Field>

      <Field
        htmlFor=""
        label={
          <>
            Screenshots{" "}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              Up to 5
            </span>
          </>
        }
      >
        <ScreenshotsUploader
          onChange={onScreenshotsChange}
          value={screenshots}
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Bundle — pick apps. The schematic illustration lives on the right.
// ---------------------------------------------------------------------------
interface BundleFormProps {
  apps: { id: string; label?: string; summary?: string }[];
  selectedApps: string[];
  onSelectedAppsChange: (next: string[]) => void;
}

function BundleForm({
  apps,
  selectedApps,
  onSelectedAppsChange,
}: BundleFormProps) {
  const { appCatalog, composioToolkitsByProvider } = useWorkspaceDesktop();
  const allSelected = apps.length > 0 && selectedApps.length === apps.length;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Select which apps install with the template. The right panel shows what
        ends up in the archive — personal data is stripped automatically.
      </p>

      {apps.length === 0 ? (
        <div className="rounded-xl bg-fg-2 px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No apps installed in this workspace.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Templates can be published without apps — fine for skill- or
            doc-only templates.
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>
              Apps in this template{" "}
              <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                {selectedApps.length}/{apps.length}
              </span>
            </Label>
            <button
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() =>
                onSelectedAppsChange(allSelected ? [] : apps.map((a) => a.id))
              }
              type="button"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="overflow-hidden rounded-lg ring-1 ring-border">
            <ul className="max-h-[336px] divide-y divide-border/60 overflow-y-auto">
              {apps.map((app) => {
                const checked = selectedApps.includes(app.id);
                return (
                  <li key={app.id}>
                    <button
                      className={cn(
                        "flex w-full items-center gap-3 bg-background px-3 py-2.5 text-left transition-colors",
                        checked ? "bg-primary/[0.04]" : "hover:bg-fg-2",
                      )}
                      onClick={() =>
                        onSelectedAppsChange(
                          checked
                            ? selectedApps.filter((id) => id !== app.id)
                            : [...selectedApps, app.id],
                        )
                      }
                      type="button"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input",
                        )}
                      >
                        {checked && <Check className="size-3" />}
                      </span>
                      {(() => {
                        const catalogEntry = appCatalog.find(
                          (e) => e.app_id === app.id,
                        );
                        const providerId = catalogEntry?.provider_id ?? null;
                        const display = resolveAppDisplay(
                          providerId,
                          composioToolkitsByProvider,
                        );
                        const resolvedLabel =
                          display.name ?? app.label ?? app.id;
                        return (
                          <>
                            <AppIcon
                              iconUrl={display.logo}
                              appId={app.id}
                              providerId={providerId}
                              label={resolvedLabel}
                              size="row"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {resolvedLabel}
                              </span>
                              {app.summary && (
                                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                                  {app.summary}
                                </span>
                              )}
                            </span>
                          </>
                        );
                      })()}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Docs — README + onboarding (with prominent AI generate)
// ---------------------------------------------------------------------------
interface DocsFormProps {
  name: string;
  onboardingMd: string;
  readmeMd: string;
  isGeneratingOnboarding: boolean;
  isGeneratingReadme: boolean;
  generationError: string | null;
  pendingGenerated: { target: "onboarding" | "readme"; content: string } | null;
  onOnboardingChange: (v: string) => void;
  onReadmeChange: (v: string) => void;
  onGenerate: (
    target: "onboarding" | "readme",
    mode: "from_scratch" | "improve",
  ) => void;
  onAcceptGenerated: () => void;
  onDiscardGenerated: () => void;
}

function DocsForm({
  name,
  onboardingMd,
  readmeMd,
  isGeneratingOnboarding,
  isGeneratingReadme,
  generationError,
  pendingGenerated,
  onOnboardingChange,
  onReadmeChange,
  onGenerate,
  onAcceptGenerated,
  onDiscardGenerated,
}: DocsFormProps) {
  const bothEmpty =
    readmeMd.trim().length === 0 && onboardingMd.trim().length === 0;
  const anyGenerating = isGeneratingOnboarding || isGeneratingReadme;
  return (
    <div className="space-y-6">
      {bothEmpty && (
        <button
          className="group inline-flex items-center gap-2 rounded-md bg-fg-2 px-3 py-1.5 text-sm transition-colors hover:bg-fg-4 disabled:cursor-wait disabled:opacity-70"
          disabled={anyGenerating}
          onClick={() => {
            onGenerate("readme", "from_scratch");
            onGenerate("onboarding", "from_scratch");
          }}
          type="button"
        >
          {anyGenerating ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium">
            {anyGenerating ? "Drafting…" : "Draft both with AI"}
          </span>
          <span className="text-xs text-muted-foreground">
            from your title and description
          </span>
          {!anyGenerating && (
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          )}
        </button>
      )}

      <DocEditor
        existingContent={readmeMd}
        isGenerating={isGeneratingReadme}
        label="README"
        onAcceptGenerated={onAcceptGenerated}
        onChange={onReadmeChange}
        onDiscardGenerated={onDiscardGenerated}
        onGenerate={(mode) => onGenerate("readme", mode)}
        pendingGenerated={
          pendingGenerated?.target === "readme"
            ? pendingGenerated.content
            : null
        }
        placeholder={`# ${name || "Template"}\n\n## Overview\n\n## Getting started`}
      />

      <DocEditor
        existingContent={onboardingMd}
        isGenerating={isGeneratingOnboarding}
        label="First-run onboarding"
        onAcceptGenerated={onAcceptGenerated}
        onChange={onOnboardingChange}
        onDiscardGenerated={onDiscardGenerated}
        onGenerate={(mode) => onGenerate("onboarding", mode)}
        pendingGenerated={
          pendingGenerated?.target === "onboarding"
            ? pendingGenerated.content
            : null
        }
        placeholder={`# Welcome\n\n1. Connect your accounts\n2. Configure ...`}
      />

      {generationError && (
        <p className="text-xs text-destructive">{generationError}</p>
      )}
    </div>
  );
}

interface DocEditorProps {
  label: string;
  existingContent: string;
  isGenerating: boolean;
  pendingGenerated: string | null;
  placeholder: string;
  onChange: (v: string) => void;
  onGenerate: (mode: "from_scratch" | "improve") => void;
  onAcceptGenerated: () => void;
  onDiscardGenerated: () => void;
}

function DocEditor({
  label,
  existingContent,
  isGenerating,
  pendingGenerated,
  placeholder,
  onChange,
  onGenerate,
  onAcceptGenerated,
  onDiscardGenerated,
}: DocEditorProps) {
  const hasContent = existingContent.trim().length > 0;
  const [showImproveMenu, setShowImproveMenu] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between">
        <Label>{label}</Label>
        {hasContent ? (
          <div className="relative">
            <Tooltip>
              <TooltipTrigger
                className="inline-flex h-6 items-center gap-1.5 rounded-md bg-fg-4 px-1.5 text-xs text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isGenerating}
                onClick={() => setShowImproveMenu((v) => !v)}
                type="button"
              >
                {isGenerating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                AI
              </TooltipTrigger>
              <TooltipContent side="bottom">
                AI improve or regenerate
              </TooltipContent>
            </Tooltip>
            {showImproveMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg bg-popover p-1 shadow-xs ring-1 ring-border/50">
                <button
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-fg-4"
                  onClick={() => {
                    setShowImproveMenu(false);
                    onGenerate("improve");
                  }}
                  type="button"
                >
                  <Pencil className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block font-medium">Improve existing</span>
                    <span className="text-xs text-muted-foreground">
                      Refine what you wrote
                    </span>
                  </span>
                </button>
                <button
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-fg-4"
                  onClick={() => {
                    setShowImproveMenu(false);
                    onGenerate("from_scratch");
                  }}
                  type="button"
                >
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block font-medium">
                      Replace with new draft
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Discard and regenerate
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {pendingGenerated && (
        <div className="mb-2 rounded-lg bg-info/8 px-3 py-2.5 text-sm">
          <p className="mb-2 font-medium text-info">
            AI generated a new version
          </p>
          <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs">
            {pendingGenerated.slice(0, 600)}
            {pendingGenerated.length > 600 ? "…" : ""}
          </pre>
          <div className="flex gap-2">
            <Button onClick={onAcceptGenerated} size="sm" type="button">
              Use new version
            </Button>
            <Button
              onClick={onDiscardGenerated}
              size="sm"
              type="button"
              variant="ghost"
            >
              Keep mine
            </Button>
          </div>
        </div>
      )}

      <textarea
        className="w-full resize-y rounded-lg bg-background px-3 py-2 font-mono text-sm ring-1 ring-border outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={8}
        value={existingContent}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field row (Attio-style: label above, control below, help below that)
// ---------------------------------------------------------------------------
function Field({
  htmlFor,
  label,
  required,
  help,
  counter,
  children,
}: {
  htmlFor: string;
  label: React.ReactNode;
  required?: boolean;
  help?: string | null;
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between gap-2">
        <Label
          className="flex items-center gap-1 text-sm font-medium"
          htmlFor={htmlFor}
        >
          {label}
          {required && <span className="text-destructive">*</span>}
        </Label>
        {counter && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {counter}
          </span>
        )}
      </div>
      {children}
      {help && <p className="mt-1.5 text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function NameCheckPill({ state }: { state: ReturnType<typeof useNameCheck> }) {
  if (state.status === "idle") {
    return <span className="pr-2" />;
  }
  if (state.status === "checking") {
    return (
      <span className="mr-2 flex shrink-0 items-center text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  }
  if (state.status === "available") {
    return (
      <span className="mr-2 flex shrink-0 items-center text-success">
        <Check className="size-3.5" />
      </span>
    );
  }
  if (state.status === "taken" && state.conflict === "yours") {
    return (
      <span className="mr-2 flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info">
        new version
      </span>
    );
  }
  if (state.status === "taken") {
    return (
      <span className="mr-2 flex shrink-0 items-center text-destructive">
        <CircleAlert className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="mr-2 flex shrink-0 items-center text-warning">
      <CircleAlert className="size-3.5" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tags chip input
// ---------------------------------------------------------------------------
function TagsChipInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const tags = useMemo(
    () =>
      value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    [value],
  );

  const commit = (next: string[]) => onChange(next.join(", "));
  const addCandidate = (raw: string) => {
    const candidate = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (!candidate || tags.includes(candidate)) {
      return;
    }
    commit([...tags, candidate]);
  };

  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors focus-within:border-ring dark:bg-input/30">
      {tags.map((tag) => (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-fg-6 px-1.5 py-0.5 text-xs font-medium"
          key={tag}
        >
          {tag}
          <button
            aria-label={`Remove tag ${tag}`}
            className="text-muted-foreground transition-colors hover:text-foreground focus-visible:[box-shadow:none!important] focus:[box-shadow:none!important]"
            onClick={() => commit(tags.filter((t) => t !== tag))}
            type="button"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-20 flex-1 bg-transparent outline-none placeholder:text-muted-foreground focus-visible:[box-shadow:none!important] focus:[box-shadow:none!important]"
        onBlur={() => {
          if (draft.trim()) {
            addCandidate(draft);
            setDraft("");
          }
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            if (draft.trim()) {
              addCandidate(draft);
              setDraft("");
            }
          } else if (
            e.key === "Backspace" &&
            draft.length === 0 &&
            tags.length > 0
          ) {
            commit(tags.slice(0, -1));
          }
        }}
        placeholder={tags.length === 0 ? "social-media…" : "Add tag"}
        value={draft}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cover image — full-width 16:9 drop zone (the marketplace banner)
// ---------------------------------------------------------------------------
function CoverUploader({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const pickFile = () => inputRef.current?.click();

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Image only");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Up to 2 MB");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <input
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            handleFile(f);
          }
          e.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      {value ? (
        <div className="group relative aspect-[1200/630] w-full overflow-hidden rounded-lg ring-1 ring-border">
          <img alt="" className="h-full w-full object-cover" src={value} />
          {/* Hover-revealed action layer */}
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-foreground/0 opacity-0 transition-[opacity,background-color] duration-150 group-hover:bg-foreground/35 group-hover:opacity-100">
            <Button
              onClick={pickFile}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Upload className="size-3.5" />
              Replace
            </Button>
            <Button
              aria-label="Remove cover"
              onClick={() => onChange(null)}
              size="icon-sm"
              type="button"
              variant="secondary"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <button
          aria-label="Add cover image"
          className={cn(
            "flex aspect-[1200/630] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-fg-2 transition-colors focus-visible:[box-shadow:none!important]",
            dragOver
              ? "border-ring bg-fg-4"
              : "border-input hover:border-fg-32 hover:bg-fg-4",
          )}
          onClick={pickFile}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) {
              await handleFile(f);
            }
          }}
          type="button"
        >
          <ImagePlus className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">Add cover image</p>
          <p className="text-xs text-muted-foreground">
            1200 × 630 · PNG, JPG, or WebP · up to 2 MB
          </p>
        </button>
      )}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screenshots — horizontal strip up to 5 thumbnails + an Add tile.
// On its own row so the strip can breathe across the full form column.
// ---------------------------------------------------------------------------
function ScreenshotsUploader({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList) => {
    const remaining = 5 - value.length;
    if (remaining <= 0) {
      setError("Up to 5");
      return;
    }
    const valid: string[] = [];
    for (const f of [...files].slice(0, remaining)) {
      if (!f.type.startsWith("image/")) {
        continue;
      }
      if (f.size > 4 * 1024 * 1024) {
        setError("Each up to 4 MB");
        continue;
      }
      valid.push(
        await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result ?? ""));
          r.readAsDataURL(f);
        }),
      );
    }
    if (valid.length > 0) {
      setError(null);
      onChange([...value, ...valid]);
    }
  };

  const triggerPick = () => inputRef.current?.click();

  return (
    <div>
      <input
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        multiple
        onChange={(e) => {
          if (e.target.files) {
            handleFiles(e.target.files);
          }
          e.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />

      {/* Empty: a single full-width drop zone, shorter than the cover so it
          doesn't dominate. Filled: a horizontal strip of 16:9 thumbs. */}
      {value.length === 0 ? (
        <button
          aria-label="Add screenshots"
          className="flex h-[112px] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-input bg-fg-2 transition-colors hover:border-fg-32 hover:bg-fg-4 focus-visible:[box-shadow:none!important]"
          onClick={triggerPick}
          type="button"
        >
          <ImagePlus className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">Add screenshots</p>
          <p className="text-xs text-muted-foreground">
            16:9 · up to 5 · 4 MB each
          </p>
        </button>
      ) : (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {value.map((url, idx) => (
            <div
              className="group relative aspect-video w-[126px] shrink-0 overflow-hidden rounded-md ring-1 ring-border"
              key={`${idx}-${url.slice(-10)}`}
            >
              <img alt="" className="h-full w-full object-cover" src={url} />
              <button
                aria-label={`Remove screenshot ${idx + 1}`}
                className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-foreground/85 text-background opacity-0 shadow-xs transition-opacity hover:bg-foreground group-hover:opacity-100 focus-visible:[box-shadow:none!important]"
                onClick={() => {
                  const next = [...value];
                  next.splice(idx, 1);
                  onChange(next);
                }}
                type="button"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
          {value.length < 5 && (
            <button
              aria-label="Add screenshot"
              className="flex aspect-video w-[126px] shrink-0 items-center justify-center rounded-md border border-dashed border-input bg-fg-2 transition-colors hover:border-fg-32 hover:bg-fg-4 focus-visible:[box-shadow:none!important]"
              onClick={triggerPick}
              type="button"
            >
              <ImagePlus className="size-4 text-muted-foreground" />
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : value.length === 0 ? (
            "Click or drop image files to add"
          ) : (
            "16:9 · 4 MB each"
          )}
        </span>
        <span className="tabular-nums">{value.length}/5</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase strip (during publish)
// ---------------------------------------------------------------------------
function PhaseStrip({
  phase,
}: {
  phase: ReturnType<typeof usePublishFlow>["phase"];
}) {
  if (
    phase.status === "idle" ||
    phase.status === "error" ||
    phase.status === "success"
  ) {
    return null;
  }
  const pct =
    phase.status === "uploading" && phase.totalBytes > 0
      ? Math.round((phase.uploadedBytes / phase.totalBytes) * 100)
      : null;
  const eta =
    phase.status === "uploading" &&
    phase.totalBytes > 0 &&
    phase.uploadedBytes > 0
      ? estimateEta(phase.uploadedBytes, phase.totalBytes, phase.startedAt)
      : null;
  const heading =
    phase.status === "creating"
      ? "Creating submission"
      : phase.status === "packaging"
        ? "Packaging workspace"
        : phase.status === "uploading"
          ? "Uploading archive"
          : "Finalizing submission";
  const sub =
    phase.status === "uploading"
      ? `${formatBytes(phase.uploadedBytes)} of ${formatBytes(phase.totalBytes)}${eta ? ` · ${eta}` : ""}`
      : phase.status === "packaging"
        ? "Compressing files…"
        : phase.status === "creating"
          ? "Reserving template ID and upload URL"
          : "Switching status to pending review";
  const barPct =
    phase.status === "creating"
      ? 8
      : phase.status === "packaging"
        ? 30
        : phase.status === "uploading"
          ? 30 + Math.round(((pct ?? 0) / 100) * 60)
          : 95;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          <p className="truncate text-sm font-medium">{heading}</p>
        </div>
        {pct !== null && (
          <p className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {pct}%
          </p>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg-6">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${barPct}%` }}
        />
      </div>
      <p className="mt-1.5 truncate text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function estimateEta(
  uploaded: number,
  total: number,
  startedAt: number,
): string | null {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < 1 || uploaded < 1024) {
    return null;
  }
  const rate = uploaded / elapsed;
  const remaining = (total - uploaded) / rate;
  if (!isFinite(remaining) || remaining < 1) {
    return null;
  }
  if (remaining < 60) {
    return `${Math.ceil(remaining)}s left`;
  }
  return `${Math.ceil(remaining / 60)}m left`;
}

// ---------------------------------------------------------------------------
// Success view — stays clean and centered
// ---------------------------------------------------------------------------
interface PublishSuccessViewProps {
  submissionId: string;
  templateId: string;
  archiveSizeBytes: number;
  onDone: () => void;
  onPublishAnother: () => void;
  onViewSubmission: () => void;
}

function PublishSuccessView({
  submissionId: _submissionId,
  templateId,
  archiveSizeBytes,
  onDone,
  onPublishAnother,
  onViewSubmission,
}: PublishSuccessViewProps) {
  const [copied, setCopied] = useState(false);

  const copyTemplateId = () => {
    navigator.clipboard.writeText(templateId).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
      <div className="w-full max-w-[420px] rounded-2xl bg-background px-10 pt-12 pb-8 shadow-xs ring-1 ring-border/35">
        {/* Soft halo success ring */}
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/10 text-success ring-[6px] ring-success/[0.04]">
          <Check className="size-5" strokeWidth={2.5} />
        </div>

        {/* Title + body */}
        <h2 className="mt-6 text-center text-xl font-semibold tracking-tight">
          Submitted for review
        </h2>
        <p className="mx-auto mt-2 max-w-[300px] text-center text-sm leading-relaxed text-muted-foreground">
          Your archive ({formatBytes(archiveSizeBytes)}) is uploaded. Reviews
          take a few business days — we'll notify you when it goes live.
        </p>

        {/* Single template-id card with inline copy */}
        <div className="mt-7 flex items-center justify-between gap-3 rounded-lg bg-fg-2 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Template ID</p>
            <p className="mt-0.5 truncate font-mono text-sm">{templateId}</p>
          </div>
          <button
            aria-label="Copy template ID"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-background px-2 py-1.5 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-fg-2 focus-visible:[box-shadow:none!important]"
            onClick={copyTemplateId}
            type="button"
          >
            {copied ? (
              <>
                <Check className="size-3 text-success" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="size-3" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        {/* Stacked actions — primary (dark) on top, secondary (subtle) below.
            Matches the wizard's bottom-button pattern so success doesn't feel
            like a different visual language. */}
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={onViewSubmission} size="lg" type="button">
            <ExternalLink className="size-3.5" />
            View submission
          </Button>
          <Button
            onClick={onPublishAnother}
            size="lg"
            type="button"
            variant="bordered"
          >
            Publish another
          </Button>
        </div>

        {/* Tiny ghost close link */}
        <div className="mt-5 text-center">
          <button
            className="text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:[box-shadow:none!important]"
            onClick={onDone}
            type="button"
          >
            Done
          </button>
        </div>
      </div>
    </main>
  );
}
