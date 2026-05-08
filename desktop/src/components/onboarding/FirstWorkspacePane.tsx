import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { firstWorkspacePaneSectionClassName } from "@/components/layout/firstWorkspacePaneLayout";
import { Button } from "@/components/ui/button";
import { KitDetail } from "@/components/marketplace/KitDetail";
import { MarketplaceGallery } from "@/components/marketplace/MarketplaceGallery";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { BrowserProfileStep } from "./BrowserProfileStep";
import { ConfigureStep } from "./ConfigureStep";
import { ConnectIntegrationsStep } from "./ConnectIntegrationsStep";
import { CreatingView } from "./CreatingView";
import { OnboardingUserButton } from "./OnboardingUserButton";
import { PROVIDER_DISPLAY_NAMES } from "./constants";
import { SelectAppsStep } from "./SelectAppsStep";

type OnboardingStep =
  | "gallery"
  | "detail"
  | "select_apps"
  | "configure"
  | "browser_profile"
  | "connect_integrations";

const IMPORT_PROFILE_LIST_HANDLER_MISSING_MESSAGE =
  "No handler registered for 'workspace:listImportBrowserProfiles'";

interface FirstWorkspacePaneProps {
  variant?: "full" | "panel";
  onClose?: () => void;
}

/**
 * Wizard-step ordering. Marketplace flows with optional apps add a
 * `select_apps` step at the front; everything else starts on `configure`.
 * `connect_integrations` is a side path off `configure` and shares the final
 * step slot when surfaced.
 */
function buildWizardSteps(
  hasOptionalApps: boolean,
): Array<"select_apps" | "configure" | "browser_profile"> {
  return hasOptionalApps
    ? ["select_apps", "configure", "browser_profile"]
    : ["configure", "browser_profile"];
}

export function FirstWorkspacePane({
  variant = "full",
  onClose,
}: FirstWorkspacePaneProps) {
  const {
    templateSourceMode,
    setTemplateSourceMode,
    selectedTemplateFolder,
    marketplaceTemplates,
    selectedMarketplaceTemplate,
    selectMarketplaceTemplate,
    workspaces,
    newWorkspaceName,
    setNewWorkspaceName,
    browserBootstrapMode,
    setBrowserBootstrapMode,
    browserBootstrapSourceWorkspaceId,
    setBrowserBootstrapSourceWorkspaceId,
    browserImportSource,
    setBrowserImportSource,
    browserImportProfileDir,
    setBrowserImportProfileDir,
    workspaceCreatePhase,
    isCreatingWorkspace,
    isLoadingMarketplaceTemplates,
    canUseMarketplaceTemplates,
    marketplaceTemplatesError,
    retryMarketplaceTemplates,
    workspaceErrorMessage,
    chooseTemplateFolder,
    selectedWorkspaceFolder,
    chooseWorkspaceFolder,
    clearSelectedWorkspaceFolder,
    runtimeStatus,
    createWorkspace,
    selectedApps,
    setSelectedApps,
    pendingIntegrations,
    isResolvingIntegrations,
    resolveIntegrationsBeforeCreate,
    clearPendingIntegrations,
  } = useWorkspaceDesktop();

  const [step, setStep] = useState<OnboardingStep>("gallery");
  const [connectingProvider, setConnectingProvider] = useState<string | null>(
    null,
  );
  const [connectStatus, setConnectStatus] = useState("");
  const [detailKit, setDetailKit] = useState<TemplateMetadataPayload | null>(
    null,
  );
  const [importProfiles, setImportProfiles] = useState<
    BrowserImportProfileOptionPayload[]
  >([]);
  const [importProfilesLoading, setImportProfilesLoading] = useState(false);
  const [importProfilesError, setImportProfilesError] = useState("");

  const isPanelVariant = variant === "panel";

  const configureStepActive = step === "configure";
  const prevConfigureRef = useRef(false);
  useEffect(() => {
    if (configureStepActive && !prevConfigureRef.current) {
      void resolveIntegrationsBeforeCreate();
    }
    prevConfigureRef.current = configureStepActive;
  }, [configureStepActive, resolveIntegrationsBeforeCreate]);

  useEffect(() => {
    if (browserBootstrapMode !== "import_browser") {
      setImportProfiles([]);
      setImportProfilesLoading(false);
      setImportProfilesError("");
      return;
    }

    if (browserImportSource === "safari") {
      setImportProfiles([]);
      setImportProfilesLoading(false);
      setImportProfilesError("");
      setBrowserImportProfileDir("");
      return;
    }

    if (step !== "browser_profile") {
      return;
    }

    let cancelled = false;
    setImportProfilesLoading(true);
    setImportProfilesError("");
    void window.electronAPI.workspace
      .listImportBrowserProfiles(browserImportSource)
      .then((profiles) => {
        if (cancelled) {
          return;
        }
        setImportProfiles(profiles);
        if (
          profiles.length > 0 &&
          !profiles.some(
            (profile) => profile.profileDir === browserImportProfileDir,
          )
        ) {
          setBrowserImportProfileDir(profiles[0]?.profileDir ?? "");
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(IMPORT_PROFILE_LIST_HANDLER_MISSING_MESSAGE)) {
          setImportProfiles([]);
          setImportProfilesError(
            "Profile list is unavailable in this desktop session. Continue to create the workspace and choose the profile in the import dialog.",
          );
          return;
        }
        setImportProfiles([]);
        setImportProfilesError(
          error instanceof Error
            ? error.message
            : "Could not load browser profiles.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setImportProfilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [step, browserBootstrapMode, browserImportSource]);

  const hasUnconnectedIntegrations = pendingIntegrations
    ? pendingIntegrations.missing_providers.length > 0
    : false;

  async function handleConnectProvider(provider: string) {
    setConnectingProvider(provider);
    setConnectStatus("Complete authorization in your browser…");
    try {
      const runtimeConfig = await window.electronAPI.runtime.getConfig();
      const userId = runtimeConfig.userId ?? "local";
      let beforeIds = new Set<string>();
      try {
        const before =
          await window.electronAPI.workspace.composioListConnections();
        beforeIds = new Set(before.connections.map((c) => c.id));
      } catch {
        // tolerate snapshot failure
      }

      const link = await window.electronAPI.workspace.composioConnect({
        provider,
        owner_user_id: userId,
      });
      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20;
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 3000));
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
            c.toolkitSlug.toLowerCase() === provider.toLowerCase(),
        );
        if (newConnection) {
          await window.electronAPI.workspace.composioFinalize({
            connected_account_id: newConnection.id,
            provider,
            owner_user_id: userId,
            account_label: `${PROVIDER_DISPLAY_NAMES[provider] ?? provider} (Managed)`,
          });
          setConnectStatus("");
          setConnectingProvider(null);
          void resolveIntegrationsBeforeCreate();
          return;
        }
      }
      setConnectStatus("Connection timed out. Please try again.");
    } catch (error) {
      setConnectStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectingProvider(null);
    }
  }

  const sectionClassName = firstWorkspacePaneSectionClassName(step);
  const creatingViaMarketplace =
    templateSourceMode === "marketplace" && canUseMarketplaceTemplates;

  const openAuthPopup = () => {
    void window.electronAPI.auth.requestAuth();
  };

  function handleSelectKitFromGallery(template: TemplateMetadataPayload) {
    setDetailKit(template);
    setStep("detail");
  }

  function handleUseKit(template: TemplateMetadataPayload) {
    selectMarketplaceTemplate(template.name);
    setTemplateSourceMode("marketplace");
    if (!newWorkspaceName.trim()) {
      setNewWorkspaceName(template.name);
    }
    const hasOptional = template.apps.some((a) => !a.required);
    setStep(hasOptional ? "select_apps" : "configure");
  }

  function handleStartFromScratch() {
    setTemplateSourceMode("empty");
    setStep("configure");
  }

  function handleUseLocalTemplate() {
    void chooseTemplateFolder().then(() => {
      setStep("configure");
    });
  }

  // Wizard step counter — derived per render so the indicator stays correct
  // when the user backs out and switches templates.
  const hasOptionalApps =
    templateSourceMode === "marketplace" && selectedMarketplaceTemplate
      ? selectedMarketplaceTemplate.apps.some((a) => !a.required)
      : false;
  const wizardSteps = useMemo(
    () => buildWizardSteps(hasOptionalApps),
    [hasOptionalApps],
  );
  const wizardStepTotal = wizardSteps.length;
  const wizardStepIndex = (id: "select_apps" | "configure" | "browser_profile") =>
    Math.max(1, wizardSteps.indexOf(id) + 1);

  const configureContinueDisabled =
    !newWorkspaceName.trim() ||
    (templateSourceMode === "marketplace" &&
      (!canUseMarketplaceTemplates || !selectedMarketplaceTemplate));

  const browserStepCreateDisabled =
    !newWorkspaceName.trim() ||
    hasUnconnectedIntegrations ||
    isResolvingIntegrations ||
    connectingProvider !== null ||
    (browserBootstrapMode === "copy_workspace" &&
      !browserBootstrapSourceWorkspaceId.trim()) ||
    (browserBootstrapMode === "import_browser" &&
      browserImportSource !== "safari" &&
      !browserImportProfileDir.trim() &&
      !importProfilesError.includes("Profile list is unavailable")) ||
    (templateSourceMode === "marketplace" &&
      (!canUseMarketplaceTemplates || !selectedMarketplaceTemplate));

  // KitDetail surfaces its own "Back to templates" link, and wizard steps own
  // their action bar back button — so the slim header just carries workspace
  // identity (matches PublishScreen).
  const stepLabel = (() => {
    if (isCreatingWorkspace) {
      return "Creating workspace";
    }
    if (step === "gallery") {
      return "Pick a template";
    }
    if (step === "detail") {
      return "Template detail";
    }
    if (step === "connect_integrations") {
      return "Connect integrations";
    }
    return `New workspace`;
  })();

  const isWide = step === "gallery" || step === "detail";

  const content = isCreatingWorkspace ? (
    <CreatingView
      browserBootstrapMode={browserBootstrapMode}
      creatingViaMarketplace={creatingViaMarketplace}
      panelVariant={isPanelVariant}
      sectionClassName={sectionClassName}
      showUserButton={!isPanelVariant}
      workspaceCreatePhase={workspaceCreatePhase}
    />
  ) : (
    <section className={sectionClassName}>
      {isWide ? (
        // Gallery + detail keep their own width; the canvas just provides
        // padding and scroll.
        <div className="mx-auto w-full max-w-6xl flex-1 px-5 pb-8">
          <div className="rounded-2xl bg-background px-7 py-7 shadow-xs sm:px-9 sm:py-8">
            {step === "gallery" ? (
              <MarketplaceGallery
                authenticated={canUseMarketplaceTemplates}
                error={marketplaceTemplatesError || undefined}
                isLoading={isLoadingMarketplaceTemplates}
                mode="pick"
                onRetry={retryMarketplaceTemplates}
                onSelectKit={handleSelectKitFromGallery}
                onSignIn={openAuthPopup}
                onStartFromScratch={handleStartFromScratch}
                onUseLocalTemplate={handleUseLocalTemplate}
                templates={marketplaceTemplates}
              />
            ) : step === "detail" && detailKit ? (
              <KitDetail
                onBack={() => setStep("gallery")}
                onSelect={handleUseKit}
                onSignIn={openAuthPopup}
                selectDisabled={!canUseMarketplaceTemplates}
                selectDisabledReason="Sign in required"
                template={detailKit}
              />
            ) : null}
          </div>
        </div>
      ) : step === "select_apps" && selectedMarketplaceTemplate ? (
        <SelectAppsStep
          onBack={() => setStep("detail")}
          onContinue={() => setStep("configure")}
          onToggleApp={(appName) => {
            const app = selectedMarketplaceTemplate.apps.find(
              (a) => a.name === appName,
            );
            if (app?.required) {
              return;
            }
            setSelectedApps((prev) => {
              const next = new Set(prev);
              if (next.has(appName)) {
                next.delete(appName);
              } else {
                next.add(appName);
              }
              return next;
            });
          }}
          selectedApps={selectedApps}
          stepIndex={wizardStepIndex("select_apps")}
          stepTotal={wizardStepTotal}
          template={selectedMarketplaceTemplate}
        />
      ) : step === "configure" ? (
        <ConfigureStep
          connectStatus={connectStatus}
          connectingProvider={connectingProvider}
          continueDisabled={configureContinueDisabled}
          defaultWorkspaceRoot={runtimeStatus?.sandboxRoot ?? null}
          hasUnconnectedIntegrations={hasUnconnectedIntegrations}
          isResolvingIntegrations={isResolvingIntegrations}
          newWorkspaceName={newWorkspaceName}
          onCancel={() => setStep("gallery")}
          onChangeFolder={() => void chooseTemplateFolder()}
          onChangeKit={() => setStep("gallery")}
          onChooseWorkspaceFolder={() => void chooseWorkspaceFolder()}
          onClearWorkspaceFolder={clearSelectedWorkspaceFolder}
          onConnect={(provider) => void handleConnectProvider(provider)}
          onContinue={() => setStep("browser_profile")}
          pendingIntegrations={pendingIntegrations}
          selectedMarketplaceTemplate={selectedMarketplaceTemplate}
          selectedTemplateFolder={selectedTemplateFolder}
          selectedWorkspaceFolder={selectedWorkspaceFolder}
          setNewWorkspaceName={setNewWorkspaceName}
          stepIndex={wizardStepIndex("configure")}
          stepTotal={wizardStepTotal}
          templateSourceMode={templateSourceMode}
          workspaceErrorMessage={workspaceErrorMessage}
        />
      ) : step === "browser_profile" ? (
        <BrowserProfileStep
          browserBootstrapMode={browserBootstrapMode}
          browserBootstrapSourceWorkspaceId={browserBootstrapSourceWorkspaceId}
          browserImportProfileDir={browserImportProfileDir}
          browserImportSource={browserImportSource}
          copySourceWorkspaces={workspaces}
          createDisabled={browserStepCreateDisabled}
          importProfiles={importProfiles}
          importProfilesError={importProfilesError}
          importProfilesLoading={importProfilesLoading}
          onBack={() => setStep("configure")}
          onCancel={() => setStep("gallery")}
          onCreate={() => void createWorkspace()}
          setBrowserBootstrapMode={setBrowserBootstrapMode}
          setBrowserBootstrapSourceWorkspaceId={
            setBrowserBootstrapSourceWorkspaceId
          }
          setBrowserImportProfileDir={setBrowserImportProfileDir}
          setBrowserImportSource={setBrowserImportSource}
          stepIndex={wizardStepIndex("browser_profile")}
          stepTotal={wizardStepTotal}
          workspaceErrorMessage={workspaceErrorMessage}
        />
      ) : step === "connect_integrations" && pendingIntegrations ? (
        <ConnectIntegrationsStep
          connectStatus={connectStatus}
          connectingProvider={connectingProvider}
          onBack={() => {
            clearPendingIntegrations();
            setStep("configure");
          }}
          onConnect={(provider) => void handleConnectProvider(provider)}
          pendingIntegrations={pendingIntegrations}
          stepIndex={wizardStepIndex("configure")}
          stepTotal={wizardStepTotal}
        />
      ) : null}
    </section>
  );

  // ---------------------------------------------------------------------------
  // Outer chrome: full-screen bg-fg-2 canvas with macOS title bar + slim header.
  // ---------------------------------------------------------------------------
  const shellInner = (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="titlebar-drag-region pointer-events-none fixed top-0 right-0 left-0 z-10 h-[38px]" />

      <header className="relative z-20 flex shrink-0 items-center justify-between gap-3 px-5 pt-[44px] pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {stepLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isPanelVariant ? (
            <Button
              aria-label="Close create workspace"
              onClick={onClose}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          ) : (
            <OnboardingUserButton />
          )}
        </div>
      </header>

      {content}
    </div>
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
        <div className="pointer-events-auto absolute inset-0 flex min-h-0 flex-col bg-fg-2">
          {shellInner}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex min-h-0 flex-col bg-fg-2">
      {shellInner}
    </div>
  );
}
