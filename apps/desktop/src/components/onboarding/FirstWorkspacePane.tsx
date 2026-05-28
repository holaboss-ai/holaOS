import { Folder, FolderOpen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { firstWorkspacePaneSectionClassName } from "@/components/layout/firstWorkspacePaneLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackUmamiEvent } from "@/lib/analytics/umami";
import {
  type FirstWorkspaceStep as SimpleStep,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { cn } from "@/lib/utils";
import { CreatingView } from "./CreatingView";
import { OnboardingShell } from "./OnboardingShell";
import {
  WizardField,
  WorkspaceWizardLayout,
} from "./WorkspaceWizardLayout";

type FolderChoice = "default" | "custom";
type MainViewMode = "workspace" | "chat";

interface FirstWorkspacePaneProps {
  variant?: "full" | "panel";
  onClose?: () => void;
}

const STEP_INDEX: Record<SimpleStep, number> = {
  name: 1,
  folder: 2,
  layout: 3,
};
const TOTAL_STEPS = 3;

/**
 * Simplified workspace creation: name → folder choice → create. Sign-in is
 * gated upstream by RequireAuth, so this pane only runs for authenticated
 * users. Templates and remote-server selection are intentionally skipped —
 * every workspace is local.
 */
export function FirstWorkspacePane({
  variant = "full",
  onClose,
}: FirstWorkspacePaneProps) {
  const {
    newWorkspaceName,
    setNewWorkspaceName,
    setTemplateSourceMode,
    setBrowserBootstrapMode,
    selectedWorkspaceFolder,
    chooseWorkspaceFolder,
    clearSelectedWorkspaceFolder,
    runtimeStatus,
    workspaceCreatePhase,
    isCreatingWorkspace,
    workspaceErrorMessage,
    createWorkspace,
    firstWorkspaceStep,
    setFirstWorkspaceStep,
  } = useWorkspaceDesktop();

  const isPanelVariant = variant === "panel";
  const step = firstWorkspaceStep;
  const setStep = setFirstWorkspaceStep;

  // Panel-variant always reopens at the first step. Full-variant trusts the
  // provider's persisted step so a transient remount doesn't lose progress.
  useLayoutEffect(() => {
    if (!isPanelVariant) {
      return;
    }
    setFirstWorkspaceStep("name");
  }, [isPanelVariant, setFirstWorkspaceStep]);

  const [folderChoice, setFolderChoice] = useState<FolderChoice>(() =>
    selectedWorkspaceFolder?.rootPath ? "custom" : "default",
  );
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("workspace");

  // Pin defaults on mount so any prior session's marketplace/copy state can't
  // leak into the create call. Use plain "empty" — "empty_onboarding" triggers
  // the chat-based ONBOARD.md takeover which has no script to run for an
  // empty workspace and would just throw the agent into a quota error loop.
  useEffect(() => {
    setTemplateSourceMode("empty");
    setBrowserBootstrapMode("fresh");
  }, [setTemplateSourceMode, setBrowserBootstrapMode]);

  useEffect(() => {
    trackUmamiEvent("onboarding_step_viewed", {
      step,
      variant: isPanelVariant ? "panel" : "full",
    });
  }, [step, isPanelVariant]);

  const trimmedName = newWorkspaceName.trim();
  const sectionClassName = firstWorkspacePaneSectionClassName("configure");
  const defaultRoot = runtimeStatus?.sandboxRoot?.trim() || "";
  const customPath = selectedWorkspaceFolder?.rootPath?.trim() || "";

  function handleContinueFromName() {
    if (!trimmedName) {
      return;
    }
    setStep("folder");
  }

  function handleSelectDefault() {
    setFolderChoice("default");
    clearSelectedWorkspaceFolder();
  }

  function handleSelectCustom() {
    setFolderChoice("custom");
    if (!customPath) {
      void chooseWorkspaceFolder();
    }
  }

  function handleContinueFromFolder() {
    if (folderDisabled) {
      return;
    }
    setStep("layout");
  }

  function handleCreateWorkspace() {
    if (createDisabled) {
      return;
    }
    trackUmamiEvent("first_workspace_create_started", {
      folder_choice: folderChoice,
      onboarding_mode: "start",
      main_view_mode: mainViewMode,
    });
    void createWorkspace({
      workspaceOnboardingMode: "start",
      mainViewMode,
    }).then(() => {
      trackUmamiEvent("first_workspace_created", {
        folder_choice: folderChoice,
        onboarding_mode: "start",
        main_view_mode: mainViewMode,
      });
      if (isPanelVariant) {
        onClose?.();
      }
    });
  }

  const folderDisabled =
    !trimmedName || (folderChoice === "custom" && !customPath);
  const createDisabled = folderDisabled;

  const shellOnBack =
    step === "folder"
      ? () => setStep("name")
      : step === "layout"
        ? () => setStep("folder")
        : undefined;
  const showCloseButton = isPanelVariant && step === "name";

  const innerContent = isCreatingWorkspace ? (
    <OnboardingShell onClose={isPanelVariant ? onClose : undefined}>
      <CreatingView
        browserBootstrapMode="fresh"
        creatingViaMarketplace={false}
        panelVariant={isPanelVariant}
        sectionClassName={sectionClassName}
        workspaceCreatePhase={workspaceCreatePhase}
      />
    </OnboardingShell>
  ) : (
    <OnboardingShell
      onBack={shellOnBack}
      onClose={showCloseButton ? onClose : undefined}
    >
      <section className={sectionClassName}>
        {step === "name" ? (
          <WorkspaceWizardLayout
            description="Pick a name for your workspace. You can rename it later from settings."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Continue",
              onClick: handleContinueFromName,
              disabled: !trimmedName,
            }}
            stepIndex={STEP_INDEX.name}
            stepTotal={TOTAL_STEPS}
            tertiary={
              isPanelVariant
                ? { label: "Cancel", onClick: () => onClose?.() }
                : undefined
            }
            title="Name your workspace"
            width="md"
          >
            <WizardField htmlFor="workspace-name" label="Workspace name" required>
              <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
                <Input
                  autoFocus
                  className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
                  id="workspace-name"
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && trimmedName) {
                      e.preventDefault();
                      handleContinueFromName();
                    }
                  }}
                  placeholder="My first workspace"
                  value={newWorkspaceName}
                />
              </div>
            </WizardField>
          </WorkspaceWizardLayout>
        ) : step === "folder" ? (
          <WorkspaceWizardLayout
            description="Files run locally on this machine. Use the default location or pick a folder you control."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Continue",
              onClick: handleContinueFromFolder,
              disabled: folderDisabled,
            }}
            secondary={{
              label: "Back",
              onClick: () => setStep("name"),
            }}
            stepIndex={STEP_INDEX.folder}
            stepTotal={TOTAL_STEPS}
            title="Where should it live?"
            width="md"
          >
            <div className="space-y-3">
              <FolderOption
                active={folderChoice === "default"}
                description={
                  defaultRoot
                    ? `Files live in ${defaultRoot}/workspace/<id>.`
                    : "Holaboss-managed location on this machine."
                }
                icon={<Folder />}
                onSelect={handleSelectDefault}
                title="Use the default folder"
              />

              <FolderOption
                active={folderChoice === "custom"}
                description="Keep the workspace files on a drive or folder you control."
                icon={<FolderOpen />}
                onSelect={handleSelectCustom}
                title="Choose a custom folder"
              />

              {folderChoice === "custom" ? (
                customPath ? (
                  <div className="flex items-center gap-2 rounded-lg bg-fg-2 px-3 py-2 shadow-2xs">
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className="flex-1 truncate font-mono text-[11px]"
                      title={customPath}
                    >
                      {customPath}
                    </span>
                    <Button
                      aria-label="Clear workspace folder"
                      onClick={clearSelectedWorkspaceFolder}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => void chooseWorkspaceFolder()}
                    size="sm"
                    type="button"
                    variant="bordered"
                  >
                    <Folder />
                    Choose folder…
                  </Button>
                )
              ) : null}
            </div>
          </WorkspaceWizardLayout>
        ) : step === "layout" ? (
          <WorkspaceWizardLayout
            description="How you'll work in this workspace. You can still toggle focus on the fly later."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Create workspace",
              onClick: handleCreateWorkspace,
              disabled: createDisabled,
            }}
            secondary={{
              label: "Back",
              onClick: () => setStep("folder"),
            }}
            stepIndex={STEP_INDEX.layout}
            stepTotal={TOTAL_STEPS}
            title="Pick your work mode"
            width="md"
          >
            <div className="grid grid-cols-2 gap-3">
              <WorkModeOption
                active={mainViewMode === "workspace"}
                description="Tabs and chat side by side."
                onSelect={() => setMainViewMode("workspace")}
                preview={<WorkspaceModePreview />}
                title="Workspace mode"
              />
              <WorkModeOption
                active={mainViewMode === "chat"}
                description="Chat fills the canvas, tabs tucked away."
                onSelect={() => setMainViewMode("chat")}
                preview={<ChatModePreview />}
                title="Chat mode"
              />
            </div>
          </WorkspaceWizardLayout>
        ) : null}
      </section>
    </OnboardingShell>
  );

  if (isPanelVariant) {
    return (
      <div className="pointer-events-none fixed inset-0 z-40">
        <button
          aria-label="Close create workspace"
          className="pointer-events-auto absolute inset-0 bg-scrim backdrop-blur-sm"
          onClick={onClose}
          type="button"
        />
        <div className="pointer-events-auto absolute inset-0 flex min-h-0 flex-col">
          {innerContent}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex min-h-0 flex-col">
      {innerContent}
    </div>
  );
}

interface FolderOptionProps {
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

function FolderOption({
  active,
  title,
  description,
  icon,
  onSelect,
}: FolderOptionProps) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors",
        active ? "bg-background shadow-2xs" : "bg-fg-2 hover:bg-fg-4",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-2xs [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

interface WorkModeOptionProps {
  active: boolean;
  title: string;
  description: string;
  preview: React.ReactNode;
  onSelect: () => void;
}

function WorkModeOption({
  active,
  title,
  description,
  preview,
  onSelect,
}: WorkModeOptionProps) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors",
        active
          ? "border-foreground/25 bg-background text-foreground shadow-2xs"
          : "border-transparent bg-fg-2 text-muted-foreground hover:bg-fg-4 hover:text-foreground",
      )}
      onClick={onSelect}
      type="button"
    >
      <div
        className={cn(
          "aspect-[8/5] w-full overflow-hidden rounded-lg transition-colors",
          active ? "bg-fg-2" : "bg-background",
        )}
      >
        {preview}
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

// Both previews share the same outer frame + sidebar so the eye reads the
// difference inside the canvas, not in surrounding chrome. currentColor
// keeps them theme-aware without bringing in design tokens.
function WorkspaceModePreview() {
  return (
    <svg
      viewBox="0 0 96 60"
      className="size-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Outer frame */}
      <rect
        x="0.5"
        y="0.5"
        width="95"
        height="59"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
      />
      {/* Sidebar */}
      <rect x="1" y="1" width="8" height="58" fill="currentColor" fillOpacity="0.08" />
      <line x1="9" y1="1" x2="9" y2="59" stroke="currentColor" strokeOpacity="0.18" />
      {/* Tab strip */}
      <rect x="9" y="1" width="50" height="6" fill="currentColor" fillOpacity="0.05" />
      <rect x="12" y="2.5" width="9" height="3" rx="0.6" fill="currentColor" fillOpacity="0.30" />
      <rect x="23" y="2.5" width="9" height="3" rx="0.6" fill="currentColor" fillOpacity="0.16" />
      <rect x="34" y="2.5" width="9" height="3" rx="0.6" fill="currentColor" fillOpacity="0.16" />
      <line x1="9" y1="7" x2="59" y2="7" stroke="currentColor" strokeOpacity="0.18" />
      {/* Center content */}
      <rect x="12" y="11" width="34" height="2.4" rx="0.6" fill="currentColor" fillOpacity="0.22" />
      <rect x="12" y="16" width="42" height="1.8" rx="0.6" fill="currentColor" fillOpacity="0.12" />
      <rect x="12" y="20" width="38" height="1.8" rx="0.6" fill="currentColor" fillOpacity="0.12" />
      <rect x="12" y="24" width="40" height="1.8" rx="0.6" fill="currentColor" fillOpacity="0.12" />
      <rect x="12" y="28" width="32" height="1.8" rx="0.6" fill="currentColor" fillOpacity="0.12" />
      {/* Chat divider */}
      <line x1="59" y1="1" x2="59" y2="59" stroke="currentColor" strokeOpacity="0.18" />
      {/* Chat rail */}
      <rect x="59" y="1" width="36" height="58" fill="currentColor" fillOpacity="0.04" />
      <rect x="62" y="36" width="24" height="3" rx="1.5" fill="currentColor" fillOpacity="0.20" />
      <rect x="62" y="42" width="20" height="2.6" rx="1.3" fill="currentColor" fillOpacity="0.14" />
      <rect
        x="62"
        y="51"
        width="30"
        height="5"
        rx="1.25"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
      />
    </svg>
  );
}

function ChatModePreview() {
  return (
    <svg
      viewBox="0 0 96 60"
      className="size-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Outer frame */}
      <rect
        x="0.5"
        y="0.5"
        width="95"
        height="59"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
      />
      {/* Sidebar */}
      <rect x="1" y="1" width="8" height="58" fill="currentColor" fillOpacity="0.08" />
      <line x1="9" y1="1" x2="9" y2="59" stroke="currentColor" strokeOpacity="0.18" />
      {/* Tabs-hidden pill (chip-style indicator) */}
      <rect x="13" y="3" width="14" height="3.5" rx="1.75" fill="currentColor" fillOpacity="0.12" />
      {/* Chat canvas */}
      <rect x="9" y="1" width="86" height="58" fill="currentColor" fillOpacity="0.03" />
      {/* Centered chat content */}
      <rect x="20" y="22" width="48" height="3" rx="1.5" fill="currentColor" fillOpacity="0.22" />
      <rect x="20" y="28" width="40" height="2.6" rx="1.3" fill="currentColor" fillOpacity="0.14" />
      <rect x="36" y="34" width="44" height="2.6" rx="1.3" fill="currentColor" fillOpacity="0.14" />
      <rect x="20" y="40" width="52" height="2.6" rx="1.3" fill="currentColor" fillOpacity="0.14" />
      {/* Composer */}
      <rect
        x="20"
        y="51"
        width="60"
        height="5.4"
        rx="1.35"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
      />
    </svg>
  );
}
