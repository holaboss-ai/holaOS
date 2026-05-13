import { Folder, FolderOpen, Plug, Sparkles, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { firstWorkspacePaneSectionClassName } from "@/components/layout/firstWorkspacePaneLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { holabossLogoUrl } from "@/lib/assetPaths";
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
const AUTH_CONTINUE_TIMEOUT_MS = 120_000;

interface FirstWorkspacePaneProps {
  variant?: "full" | "panel";
  onClose?: () => void;
}

// Step index + total are variant-aware: panel variant skips Welcome and so
// the visible flow is 2 steps (name → folder) starting at 1, while the full
// takeover is 3 steps (welcome → name → folder) starting at 1.
const STEP_INDEX_FULL: Record<SimpleStep, number> = {
  welcome: 1,
  name: 2,
  folder: 3,
};
const STEP_INDEX_PANEL: Record<SimpleStep, number> = {
  welcome: 0, // unreachable in panel variant
  name: 1,
  folder: 2,
};

/**
 * Simplified workspace creation: name → folder choice → create. Templates and
 * remote-server selection are intentionally skipped — every workspace is
 * local. Marketplace browsing components remain in the codebase but are no
 * longer reachable from this entry.
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
  const authSessionState = useDesktopAuthSession();

  // Step lives in the provider so a transient remount of this pane (the
  // auth-completion sync flips AppShell's render gates briefly) doesn't
  // snap useState back to "welcome".
  const isPanelVariant = variant === "panel";
  const step: SimpleStep =
    isPanelVariant && firstWorkspaceStep === "welcome"
      ? "name"
      : firstWorkspaceStep;
  const setStep = setFirstWorkspaceStep;
  const signedInUserId = authSessionState.data?.user?.id?.trim() || "";
  const isSignedIn = Boolean(signedInUserId);
  const [isAuthContinuationPending, setIsAuthContinuationPending] =
    useState(false);
  const [authGateError, setAuthGateError] = useState("");

  useEffect(() => {
    if (isPanelVariant && firstWorkspaceStep === "welcome") {
      setFirstWorkspaceStep("name");
    }
  }, [isPanelVariant, firstWorkspaceStep, setFirstWorkspaceStep]);

  useEffect(() => {
    if (!isAuthContinuationPending || !isSignedIn) {
      return;
    }
    setIsAuthContinuationPending(false);
    setAuthGateError("");
    setStep("name");
  }, [isAuthContinuationPending, isSignedIn, setStep]);

  useEffect(() => {
    if (!isAuthContinuationPending || !authSessionState.error) {
      return;
    }
    setIsAuthContinuationPending(false);
    setAuthGateError(authSessionState.error.message || "Sign-in failed.");
  }, [authSessionState.error, isAuthContinuationPending]);

  useEffect(() => {
    if (!isAuthContinuationPending || isSignedIn) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setIsAuthContinuationPending(false);
      setAuthGateError("Sign-in did not finish. Try connecting holaOS again.");
    }, AUTH_CONTINUE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isAuthContinuationPending, isSignedIn]);

  const [folderChoice, setFolderChoice] = useState<FolderChoice>(() =>
    selectedWorkspaceFolder?.rootPath ? "custom" : "default",
  );
  const totalSteps = isPanelVariant ? 2 : 3;
  const stepIndexMap = isPanelVariant ? STEP_INDEX_PANEL : STEP_INDEX_FULL;

  // Pin defaults on mount so any prior session's marketplace/copy state can't
  // leak into the create call. Use plain "empty" — "empty_onboarding" triggers
  // the chat-based ONBOARD.md takeover which has no script to run for an
  // empty workspace and would just throw the agent into a quota error loop.
  useEffect(() => {
    setTemplateSourceMode("empty");
    setBrowserBootstrapMode("fresh");
  }, [setTemplateSourceMode, setBrowserBootstrapMode]);

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

  async function handleSignInThenContinue() {
    setAuthGateError("");
    if (isSignedIn) {
      setStep("name");
      return;
    }

    setIsAuthContinuationPending(true);
    try {
      await authSessionState.requestAuth();
      const user = await window.electronAPI.auth.getUser().catch(() => null);
      if (user?.id?.trim()) {
        setIsAuthContinuationPending(false);
        setAuthGateError("");
        setStep("name");
      }
    } catch (error) {
      setIsAuthContinuationPending(false);
      setAuthGateError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to start sign-in.",
      );
    }
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

  function handleCreate() {
    void createWorkspace().then(() => {
      if (isPanelVariant) {
        onClose?.();
      }
    });
  }

  const createDisabled =
    !trimmedName || (folderChoice === "custom" && !customPath);
  const isAuthGateBusy =
    !isSignedIn && (authSessionState.isPending || isAuthContinuationPending);
  const authGatePrimaryLabel = isSignedIn
    ? "Continue"
    : isAuthGateBusy
      ? "Waiting for sign-in"
      : "Connect holaOS";

  const shellOnBack =
    step === "folder"
      ? () => setStep("name")
      : step === "name" && !isPanelVariant
        ? () => setStep("welcome")
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
        {step === "welcome" ? (
          <WorkspaceWizardLayout
            aboveTitle={<WelcomeHero />}
            description="Local AI workspace. Connect holaOS to sync your workspace."
            primary={{
              label: authGatePrimaryLabel,
              onClick: handleSignInThenContinue,
              loading: isAuthGateBusy,
            }}
            errorMessage={authGateError || null}
            stepIndex={stepIndexMap.welcome}
            stepTotal={totalSteps}
            title="Welcome to holaOS"
            width="md"
          >
            <div className="grid grid-cols-3 gap-3">
              <FeatureCard
                art={<Sparkles strokeWidth={1.25} />}
                caption="Run end-to-end."
                delayMs={120}
                title="Agents"
              />
              <FeatureCard
                art={<Plug strokeWidth={1.25} />}
                caption="Wired in."
                delayMs={220}
                title="Apps"
              />
              <FeatureCard
                art={<Zap strokeWidth={1.25} />}
                caption="Yours forever."
                delayMs={320}
                title="Local"
              />
            </div>
          </WorkspaceWizardLayout>
        ) : step === "name" ? (
          <WorkspaceWizardLayout
            description="Pick a name for your workspace. You can rename it later from settings."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Continue",
              onClick: handleContinueFromName,
              disabled: !trimmedName,
            }}
            stepIndex={stepIndexMap.name}
            stepTotal={totalSteps}
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
        ) : (
          <WorkspaceWizardLayout
            description="Files run locally on this machine. Use the default location or pick a folder you control."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Create workspace",
              onClick: handleCreate,
              disabled: createDisabled,
            }}
            secondary={{
              label: "Back",
              onClick: () => setStep("name"),
            }}
            stepIndex={stepIndexMap.folder}
            stepTotal={totalSteps}
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
        )}
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

/**
 * Brand mark with three static halo rings fading outward. Each ring sits a
 * little further from the logo and at a lower opacity, so the eye reads
 * "ambient brand presence" rather than a literal target. No animation.
 */
function WelcomeHero() {
  return (
    <div className="flex justify-center">
      <div className="relative flex size-16 items-center justify-center">
        {/* Outermost — most faint. */}
        <span
          aria-hidden
          className="absolute inset-0 -m-5 rounded-full border border-primary/8"
        />
        {/* Middle. */}
        <span
          aria-hidden
          className="absolute inset-0 -m-3 rounded-full border border-primary/16"
        />
        {/* Innermost — closest to the logo. */}
        <span
          aria-hidden
          className="absolute inset-0 -m-1 rounded-full border border-primary/26"
        />
        {/* Brand mark. */}
        <img
          alt=""
          aria-hidden
          className="size-12 object-contain"
          src={holabossLogoUrl}
        />
      </div>
    </div>
  );
}

interface FeatureCardProps {
  /** Inline SVG line art. */
  art: React.ReactNode;
  title: string;
  caption: string;
  /** Stagger entrance — animation delay in ms. */
  delayMs?: number;
}

/**
 * Vertical feature card used in the Welcome grid: line-art SVG on top,
 * single-word title, terse caption underneath. Stagger entrance on mount.
 */
function FeatureCard({ art, title, caption, delayMs = 0 }: FeatureCardProps) {
  const animated = delayMs > 0;
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl bg-fg-2 px-3 pt-5 pb-4 text-center",
        animated && "opacity-0 animate-fade-in-once",
      )}
      style={animated ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      <div className="mt-1 mb-1 text-foreground/70 [&>svg]:size-10">{art}</div>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
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
