import { AppsGallery } from "@/components/marketplace/AppsGallery";
import { KitDetail } from "@/components/marketplace/KitDetail";
import { KitEmoji } from "@/components/marketplace/KitEmoji";
import { MarketplaceGallery } from "@/components/marketplace/MarketplaceGallery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  composioToolkitMatchesProvider,
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";

type View = "gallery" | "detail" | "creating" | "connect_integrations";

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  reddit: "Reddit",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  hubspot: "HubSpot",
  attio: "Attio",
  calcom: "Cal.com",
  apollo: "Apollo.io",
  instantly: "Instantly",
  zoominfo: "ZoomInfo",
};

function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

interface MarketplacePaneProps {
  initialTab?: "templates" | "apps";
  /**
   * When true, the outer card chrome (bg-muted, border, rounded-xl,
   * shadow-xs) is dropped so the pane embeds cleanly inside an
   * already-bordered surface such as the new-shell PaneOverlay.
   */
  variant?: "default" | "embedded";
}

export function MarketplacePane({
  initialTab = "templates",
  variant = "default",
}: MarketplacePaneProps = {}) {
  const {
    marketplaceTemplates,
    isLoadingMarketplaceTemplates,
    marketplaceTemplatesError,
    canUseMarketplaceTemplates,
    retryMarketplaceTemplates,
    selectMarketplaceTemplate,
    setTemplateSourceMode,
    newWorkspaceName,
    setNewWorkspaceName,
    isCreatingWorkspace,
    workspaceErrorMessage,
    createWorkspace,
    pendingIntegrations,
    isResolvingIntegrations,
    resolveIntegrationsBeforeCreate,
    clearPendingIntegrations,
  } = useWorkspaceDesktop();

  const [view, setView] = useState<View>("gallery");
  const [detailTemplate, setDetailTemplate] =
    useState<TemplateMetadataPayload | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(
    null,
  );
  const [connectStatus, setConnectStatus] = useState("");
  const cancelConnectRef = useRef<(() => void) | null>(null);

  function cancelActiveConnect() {
    cancelConnectRef.current?.();
  }

  function handleSelectKit(template: TemplateMetadataPayload) {
    setDetailTemplate(template);
    setView("detail");
  }

  function handleUseKit(template: TemplateMetadataPayload) {
    selectMarketplaceTemplate(template.name);
    setTemplateSourceMode("marketplace");
    if (!newWorkspaceName.trim()) {
      setNewWorkspaceName(template.name);
    }
    setView("creating");
  }

  async function handleCreate() {
    const pending = await resolveIntegrationsBeforeCreate();
    if (pending && pending.missing_providers.length > 0) {
      setView("connect_integrations");
      return;
    }
    void createWorkspace();
  }

  async function handleConnectProvider(provider: string) {
    let cancelled = false;
    cancelConnectRef.current = () => {
      cancelled = true;
    };

    setConnectingProvider(provider);
    setConnectStatus("Complete authorization in your browser...");
    try {
      const runtimeConfig = await window.electronAPI.runtime.getConfig();
      const userId = runtimeConfig.userId ?? "local";

      // Snapshot existing connection ids before initiating — same
      // rationale as IntegrationsPane: poll the list, find a new id,
      // ignore the id returned by /link.
      let beforeIds = new Set<string>();
      try {
        const before =
          await window.electronAPI.workspace.composioListConnections();
        beforeIds = new Set(before.connections.map((c) => c.id));
      } catch {
        // tolerate snapshot failure
      }

      if (cancelled) {
        return;
      }
      const toolkitSlug = composioToolkitSlugForProvider(provider);
      const link = await window.electronAPI.workspace.composioConnect({
        provider: toolkitSlug,
        owner_user_id: userId,
      });

      if (cancelled) {
        return;
      }

      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) {
          return;
        }
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
            composioToolkitMatchesProvider(c.toolkitSlug, provider),
        );
        if (newConnection) {
          // Composio creates the row at /connect time in INITIATED state —
          // its presence does NOT mean the user finished OAuth. Query the
          // account's real status before treating it as authorized.
          let accountStatus;
          try {
            accountStatus =
              await window.electronAPI.workspace.composioAccountStatus(
                newConnection.id,
                provider,
              );
          } catch {
            continue;
          }
          if (cancelled) {
            return;
          }
          const status = (accountStatus.status ?? "").toUpperCase();
          if (
            status === "FAILED" ||
            status === "EXPIRED" ||
            status === "INACTIVE"
          ) {
            throw new Error(
              `Authorization for ${provider} ${status.toLowerCase()}. Please try again.`,
            );
          }
          if (status !== "ACTIVE") {
            continue;
          }
          await window.electronAPI.workspace.composioFinalize({
            connected_account_id: newConnection.id,
            provider,
            owner_user_id: userId,
            account_label: `${provider} (Managed)`,
          });
          if (cancelled) {
            return;
          }
          setConnectStatus("");

          const updated = await resolveIntegrationsBeforeCreate();
          if (cancelled) {
            return;
          }
          if (!updated || updated.missing_providers.length === 0) {
            clearPendingIntegrations();
            setView("creating");
            void createWorkspace();
          }
          return;
        }
      }
      if (!cancelled) {
        setConnectStatus("Connection timed out. Please try again.");
      }
    } catch (error) {
      if (!cancelled) {
        setConnectStatus(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (cancelled) {
        setConnectStatus("");
      }
      cancelConnectRef.current = null;
      setConnectingProvider(null);
    }
  }

  return (
    <Tabs
      defaultValue={initialTab}
      className={
        variant === "embedded"
          ? "flex h-full min-h-0 p-6 min-w-0 flex-col overflow-hidden"
          : "flex h-full min-h-0 p-6 min-w-0 flex-col overflow-hidden bg-muted shadow-xs border border-border rounded-xl"
      }
    >
      <div className="max-w-4xl mx-auto w-full">
        <TabsList>
          <TabsTrigger value="templates" className="h-9 min-w-40">
            Templates
          </TabsTrigger>
          <TabsTrigger value="apps" className="h-9 min-w-40">
            Apps
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="templates"
        className="min-h-0 flex-1 overflow-auto px-5 py-4"
      >
        <div className="mx-auto max-w-4xl">
          {view === "gallery" ? (
            <MarketplaceGallery
              mode="browse"
              templates={marketplaceTemplates}
              isLoading={isLoadingMarketplaceTemplates}
              authenticated={canUseMarketplaceTemplates}
              error={marketplaceTemplatesError || undefined}
              onSelectKit={handleSelectKit}
              onRetry={retryMarketplaceTemplates}
              onSignIn={() => void window.electronAPI.auth.requestAuth()}
            />
          ) : view === "detail" && detailTemplate ? (
            <KitDetail
              template={detailTemplate}
              onBack={() => setView("gallery")}
              onSelect={handleUseKit}
              selectDisabled={!canUseMarketplaceTemplates}
              selectDisabledReason="Sign in required"
              onSignIn={() => void window.electronAPI.auth.requestAuth()}
            />
          ) : view === "creating" ? (
            <div className="flex h-full min-h-0 flex-col">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setView("detail")}
                className="mb-4 self-start text-muted-foreground"
              >
                &larr; Back
              </Button>

              {isCreatingWorkspace ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <Loader2
                      size={16}
                      className="mx-auto animate-spin text-muted-foreground"
                    />
                    <div className="mt-2 text-sm text-muted-foreground">
                      Creating workspace…
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mx-auto w-full max-w-sm">
                  {detailTemplate ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2.5">
                      <KitEmoji emoji={detailTemplate.emoji} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {detailTemplate.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {detailTemplate.apps.map((a) => a.name).join(", ")}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={() => setView("gallery")}
                        className="shrink-0 text-muted-foreground"
                      >
                        Change
                      </Button>
                    </div>
                  ) : null}

                  <label className="mt-4 block">
                    <span className="text-xs font-medium text-muted-foreground">
                      Workspace name
                    </span>
                    <Input
                      value={newWorkspaceName}
                      onChange={(e) => setNewWorkspaceName(e.target.value)}
                      placeholder="My workspace"
                      className="mt-1.5 h-9"
                    />
                  </label>

                  {workspaceErrorMessage ? (
                    <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      {workspaceErrorMessage}
                    </div>
                  ) : null}

                  <Button
                    type="button"
                    size="lg"
                    disabled={
                      !newWorkspaceName.trim() || isResolvingIntegrations
                    }
                    onClick={handleCreate}
                    className="mt-4 w-full"
                  >
                    {isResolvingIntegrations
                      ? "Checking integrations…"
                      : "Create workspace"}
                  </Button>
                </div>
              )}
            </div>
          ) : view === "connect_integrations" && pendingIntegrations ? (
            <div className="flex h-full min-h-0 flex-col">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  cancelActiveConnect();
                  clearPendingIntegrations();
                  setView("creating");
                }}
                className="mb-4 self-start text-muted-foreground"
              >
                &larr; Back
              </Button>
              <div className="mx-auto w-full max-w-sm">
                <h3 className="text-base font-semibold text-foreground">
                  Connect accounts
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  This workspace needs access to the following services.
                </p>
                <div className="mt-4 space-y-2">
                  {pendingIntegrations.missing_providers.map((provider) => (
                    <div
                      key={provider}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {providerDisplayName(provider)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          connectingProvider === provider
                            ? "outline"
                            : "default"
                        }
                        disabled={
                          connectingProvider !== null &&
                          connectingProvider !== provider
                        }
                        onClick={() => {
                          if (connectingProvider === provider) {
                            cancelActiveConnect();
                          } else {
                            void handleConnectProvider(provider);
                          }
                        }}
                      >
                        {connectingProvider === provider ? "Cancel" : "Connect"}
                      </Button>
                    </div>
                  ))}
                </div>
                {connectStatus ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {connectStatus}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </TabsContent>

      <TabsContent
        value="apps"
        className="min-h-0 flex-1 overflow-auto px-5 py-4"
      >
        <div className="mx-auto max-w-4xl">
          <AppsGallery />
        </div>
      </TabsContent>
    </Tabs>
  );
}
