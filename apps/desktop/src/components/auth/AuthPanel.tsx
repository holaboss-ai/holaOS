import { useEffect, useState } from "react";
import { getDefaultStore } from "jotai";
import { onboardingDismissedAtom } from "@/components/panes/ChatPane/onboarding/state";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogOut,
  RefreshCw,
} from "@/components/ui/icons";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { Badge } from "@/components/ui/badge";
import * as modelCatalog from "../../../shared/model-catalog.js";
import { BillingSummaryCard } from "@/components/billing/BillingSummaryCard";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDesktopAuthSession, type AuthSession } from "@/lib/auth/authClient";
import { useDesktopBilling } from "@/lib/billing/useDesktopBilling";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import {
  SettingsCard,
  SettingsMenuSelectRow,
  SettingsSection,
  SettingsStatusBadge,
  type SettingsMenuOption,
} from "@/components/settings";

const AUTH_BROWSER_SIGN_IN_MESSAGE =
  "Sign-in opened in the browser. Complete the flow on the holaOS sign-in page.";

// How long to wait for the runtime binding to land before we stop showing an
// open-ended spinner and surface an explicit, recoverable "connection failed"
// state. Provisioning is a couple of API calls; anything past this is a hang.
const RUNTIME_SETUP_TIMEOUT_MS = 45_000;

type RuntimeCatalogModelCapability =
  | "chat"
  | "image_generation"
  | "video_generation"
  | "embedding";
const RUNTIME_MODEL_CAPABILITY_ALIASES: Record<
  string,
  RuntimeCatalogModelCapability
> = {
  chat: "chat",
  text: "chat",
  completion: "chat",
  completions: "chat",
  responses: "chat",
  embedding: "embedding",
  embeddings: "embedding",
  image: "image_generation",
  images: "image_generation",
  image_generation: "image_generation",
  image_gen: "image_generation",
  video: "video_generation",
  videos: "video_generation",
  video_generation: "video_generation",
  video_gen: "video_generation",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function parseRuntimeConfigDocument(rawText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Build the option list for the "Default chat model" selector.
 *
 * Aggregates chat-capable models across every provider group in the
 * runtime catalog. Each option is identified by its full provider-
 * prefixed token (e.g. "openai/gpt-5.4"), which is exactly what
 * `runtimeConfig.defaultModel` stores — so persistence is a one-line
 * `runtime.setConfig({ defaultModel: token })`.
 *
 * Groups for unconfigured providers don't appear in providerModelGroups
 * at all, so the option list naturally filters to "stuff the user can
 * actually pick"; an empty result means "connect a provider first".
 */
function normalizeConfiguredProviderModelId(
  providerId: string,
  modelId: string,
): string {
  const normalizedModelId = modelId.trim();
  return normalizedModelId;
}

function normalizeRuntimeCatalogModelCapability(
  value: string,
): RuntimeCatalogModelCapability | "" {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  return RUNTIME_MODEL_CAPABILITY_ALIASES[normalized] ?? "";
}

function runtimeCatalogModelCapabilities(
  model: RuntimeProviderModelPayload,
): RuntimeCatalogModelCapability[] {
  if (!Array.isArray(model.capabilities)) {
    return [];
  }
  const seen = new Set<RuntimeCatalogModelCapability>();
  const capabilities: RuntimeCatalogModelCapability[] = [];
  for (const value of model.capabilities) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeRuntimeCatalogModelCapability(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    capabilities.push(normalized);
  }
  return capabilities;
}

function runtimeCatalogModelSupportsCapability(
  model: RuntimeProviderModelPayload,
  capability: RuntimeCatalogModelCapability,
): boolean {
  const capabilities = runtimeCatalogModelCapabilities(model);
  if (capabilities.length === 0) {
    return capability === "chat";
  }
  return capabilities.includes(capability);
}

/**
 * Pick a migration target for a persisted model that's no longer in the managed
 * catalog: prefer the current default when it's still valid, else the first
 * catalogued model. Returns null when nothing needs to change — an empty or
 * still-valid pick, an unloaded/empty catalog, or no usable fallback — so the
 * caller leaves the selection alone.
 */
function sessionUserId(session: AuthSession | null): string {
  if (!session || typeof session !== "object") {
    return "";
  }

  const maybeUser = "user" in session ? session.user : null;
  if (!maybeUser || typeof maybeUser !== "object") {
    return "";
  }

  return typeof maybeUser.id === "string" ? maybeUser.id : "";
}

function sessionEmail(session: AuthSession | null): string {
  if (!session || typeof session !== "object") {
    return "";
  }

  const maybeUser = "user" in session ? session.user : null;
  if (!maybeUser || typeof maybeUser !== "object") {
    return "";
  }

  return typeof maybeUser.email === "string" ? maybeUser.email : "";
}

function sessionDisplayName(session: AuthSession | null): string {
  if (!session || typeof session !== "object") {
    return "";
  }

  const maybeUser = "user" in session ? session.user : null;
  if (!maybeUser || typeof maybeUser !== "object") {
    return "";
  }

  return typeof maybeUser.name === "string" ? maybeUser.name.trim() : "";
}

function sessionAvatarUser(session: AuthSession | null): {
  id?: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
} | null {
  if (!session || typeof session !== "object" || !("user" in session)) {
    return null;
  }
  const maybeUser = session.user;
  if (!maybeUser || typeof maybeUser !== "object") {
    return null;
  }
  const u = maybeUser as Record<string, unknown>;
  return {
    id: typeof u.id === "string" ? u.id : undefined,
    email: typeof u.email === "string" ? u.email : null,
    name: typeof u.name === "string" ? u.name : null,
    image: typeof u.image === "string" ? u.image : null,
  };
}

function sessionInitials(session: AuthSession | null): string {
  const name = sessionDisplayName(session);
  if (name) {
    const initials = name
      .split(/\s+/)
      .map((part) => part[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    if (initials) {
      return initials;
    }
  }

  const email = sessionEmail(session);
  return (email[0] ?? "H").toUpperCase();
}

export function AuthPanel() {
  const sessionState = useDesktopAuthSession();
  const billingState = useDesktopBilling();
  const { runtimeConfig: sharedRuntimeConfig } = useWorkspaceDesktop();
  const session = sessionState.data;
  const [runtimeConfig, setRuntimeConfig] =
    useState<RuntimeConfigPayload | null>(null);
  const [runtimeConfigDocument, setRuntimeConfigDocument] = useState("");
  const [hasLoadedRuntimeConfigDocument, setHasLoadedRuntimeConfigDocument] =
    useState(false);
  const [sandboxId, setSandboxId] = useState("");
  const [authError, setAuthError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [isStartingSignIn, setIsStartingSignIn] = useState(false);
  const [isExchangingRuntimeBinding, setIsExchangingRuntimeBinding] =
    useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);
  const effectiveRuntimeConfig = sharedRuntimeConfig ?? runtimeConfig;

  async function refreshRuntimeConfig() {
    if (!window.electronAPI) {
      return;
    }
    const [config, document] = await Promise.all([
      window.electronAPI.runtime.getConfig(),
      window.electronAPI.runtime.getConfigDocument(),
    ]);
    setRuntimeConfig(config);
    setRuntimeConfigDocument(document);
    setHasLoadedRuntimeConfigDocument(true);
    setSandboxId(config.sandboxId ?? `desktop:${crypto.randomUUID()}`);
  }

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    let cancelled = false;
    void Promise.all([
      window.electronAPI.runtime.getConfig(),
      window.electronAPI.runtime.getConfigDocument(),
    ]).then(([config, document]) => {
      if (cancelled) {
        return;
      }
      setRuntimeConfig(config);
      setRuntimeConfigDocument(document);
      setHasLoadedRuntimeConfigDocument(true);
      setSandboxId(config.sandboxId ?? `desktop:${crypto.randomUUID()}`);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const unsubscribe = window.electronAPI.runtime.onConfigChange((config) => {
      setRuntimeConfig(config);
      setSandboxId(config.sandboxId ?? `desktop:${crypto.randomUUID()}`);
      setAuthError("");
      void window.electronAPI.runtime.getConfigDocument().then((document) => {
        setRuntimeConfigDocument(document);
        setHasLoadedRuntimeConfigDocument(true);
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }
    void refreshRuntimeConfig();
  }, [session]);

  useEffect(() => {
    if (sessionState.error) {
      setAuthError(sessionState.error.message);
    }
  }, [sessionState.error]);

  const isSignedIn = Boolean(sessionUserId(session));

  // Auto-pick a sensible default chat model the first time a signed-in
  // user lands on this panel. Holaboss-managed gpt-5.4 is the house
  // recommendation — it's available the moment the runtime binding
  // resolves, no API key setup required. If the catalog doesn't have
  // gpt-5.4 (renamed, deprecated, region-gated), fall back to the first
  // chat-capable model the holaboss proxy exposes. We never overwrite an
  // existing defaultModel — that's the user's choice.
  useEffect(() => {
    if (!window.electronAPI) return;
    if (!isSignedIn) return;
    if (!runtimeConfig) return;
    if ((runtimeConfig.defaultModel ?? "").trim()) return;

    const holabossGroup = runtimeConfig.providerModelGroups.find(
      (group) => group.providerId === "holaboss_model_proxy",
    );
    if (!holabossGroup) return;

    const chatModels = holabossGroup.models.filter((model) =>
      runtimeCatalogModelSupportsCapability(model, "chat"),
    );
    const preferred =
      chatModels.find((model) => model.modelId === "gpt-5.4") ?? chatModels[0];
    if (!preferred?.token) return;

    void window.electronAPI.runtime
      .setConfig({ defaultModel: preferred.token })
      .catch(() => {
        // Non-fatal — user can pick manually from the Defaults selector.
      });
  }, [isSignedIn, runtimeConfig]);

  const runtimeBindingReady =
    Boolean(effectiveRuntimeConfig?.authTokenPresent) &&
    Boolean((effectiveRuntimeConfig?.sandboxId || "").trim()) &&
    Boolean((effectiveRuntimeConfig?.modelProxyBaseUrl || "").trim());
  const runtimeSetupPending = isSignedIn && !runtimeBindingReady;
  // A binding-provisioning failure surfaces as an auth error whose message the
  // main process tags ("Signed in, but runtime binding provisioning failed").
  // The user is signed in — this is a runtime connection failure, not a
  // sign-in failure — so it gets the recovery panel, not a bare red line.
  const isRuntimeBindingError =
    Boolean(authError) && /runtime binding/i.test(authError);
  const runtimeSetupFailed =
    runtimeSetupPending && (setupTimedOut || isRuntimeBindingError);
  const isRuntimeSetupPending = runtimeSetupPending && !authError;
  const showsSetupLoadingState = isRuntimeSetupPending && !runtimeSetupFailed;
  const showsSetupPanel = showsSetupLoadingState || runtimeSetupFailed;

  useEffect(() => {
    if (!runtimeSetupPending) {
      setSetupTimedOut(false);
      return;
    }
    if (setupTimedOut || authError) {
      return;
    }
    const timer = setTimeout(
      () => setSetupTimedOut(true),
      RUNTIME_SETUP_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [runtimeSetupPending, setupTimedOut, authError]);

  const statusTone = authError
    ? "error"
    : runtimeBindingReady
      ? "ready"
      : isRuntimeSetupPending
        ? "syncing"
        : "idle";

  const statusBadgeLabel = sessionState.isPending
    ? "Checking session"
    : authError
      ? "Needs attention"
      : runtimeBindingReady
        ? "Connected"
        : isSignedIn
          ? "Connecting"
          : "Signed out";

  const badgeClassName =
    statusTone === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : statusTone === "ready"
        ? "border-success/30 bg-success/10 text-success"
        : statusTone === "syncing"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-muted text-muted-foreground";

  useEffect(() => {
    if (
      authMessage === AUTH_BROWSER_SIGN_IN_MESSAGE &&
      isSignedIn &&
      !showsSetupLoadingState
    ) {
      setAuthMessage("");
    }
  }, [authMessage, isSignedIn, showsSetupLoadingState]);

  const setupLoadingPanel = (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-muted px-5 py-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-primary bg-primary/10 text-primary">
        <Loader2 size={18} className="animate-spin" />
      </div>
      <div className="text-base font-medium text-foreground">
        {isExchangingRuntimeBinding
          ? "Refreshing desktop connection..."
          : "Connecting your account..."}
      </div>
      <div className="max-w-[520px] text-sm leading-6 text-muted-foreground">
        Finalizing your desktop session and runtime binding. This should only
        take a moment.
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRefreshSession()}
          disabled={sessionState.isPending}
        >
          {sessionState.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>Refresh session</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSignOut()}
        >
          Sign out
        </Button>
      </div>
    </div>
  );

  const setupRecoveryPanel = (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-warning/30 bg-warning/5 px-5 py-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-warning bg-warning/10 text-warning">
        <AlertTriangle size={18} />
      </div>
      <div className="text-base font-medium text-foreground">
        Couldn't connect this desktop
      </div>
      <div className="max-w-[520px] text-sm leading-6 text-muted-foreground">
        You're signed in, but the runtime binding didn't come through. This is
        usually a temporary network or service hiccup — retry the connection, or
        sign out and back in.
      </div>
      {isRuntimeBindingError ? (
        <div className="max-w-[520px] break-words text-xs leading-5 text-muted-foreground/80">
          {authError}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button
          size="sm"
          onClick={() => void handleExchangeRuntimeBinding()}
          disabled={isExchangingRuntimeBinding}
        >
          {isExchangingRuntimeBinding ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>Retry connection</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSignOut()}
        >
          Sign out
        </Button>
      </div>
    </div>
  );

  const setupPanel = runtimeSetupFailed ? setupRecoveryPanel : setupLoadingPanel;

  async function handleStartSignIn() {
    setIsStartingSignIn(true);
    setAuthError("");
    setAuthMessage("");
    try {
      await sessionState.requestAuth();
      setAuthMessage(AUTH_BROWSER_SIGN_IN_MESSAGE);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to start sign-in.",
      );
    } finally {
      setIsStartingSignIn(false);
    }
  }

  async function handleRefreshSession() {
    setAuthError("");
    await sessionState.refetch();
  }

  async function handleSignOut() {
    setAuthError("");
    setAuthMessage("");
    try {
      await sessionState.signOut();
      // Re-arm first-run onboarding so the next account on this machine
      // isn't silently skipped past it.
      getDefaultStore().set(onboardingDismissedAtom, false);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to sign out.",
      );
    }
  }

  async function handleExchangeRuntimeBinding() {
    if (!window.electronAPI) {
      return;
    }
    if (!isSignedIn) {
      setAuthError("Sign in first.");
      setAuthMessage("");
      return;
    }

    const resolvedSandboxId =
      sandboxId.trim() || `desktop:${crypto.randomUUID()}`;
    setIsExchangingRuntimeBinding(true);
    setSetupTimedOut(false);
    setAuthError("");
    setAuthMessage("");
    try {
      const nextConfig =
        await window.electronAPI.runtime.exchangeBinding(resolvedSandboxId);
      setRuntimeConfig(nextConfig);
      setSandboxId(nextConfig.sandboxId ?? resolvedSandboxId);
      const nextDocument = await window.electronAPI.runtime.getConfigDocument();
      setRuntimeConfigDocument(nextDocument);
      setAuthMessage(
        "Runtime binding refreshed and local runtime config updated.",
      );
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Failed to exchange runtime binding.",
      );
    } finally {
      setIsExchangingRuntimeBinding(false);
    }
  }

    if (showsSetupPanel) {
      return (
        <section className="grid w-full gap-5">
          {setupPanel}
        </section>
      );
    }

    return (
      <section className="grid w-full gap-6">
        <SettingsCard>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground ring-1 ring-border">
                  <UserAvatar user={sessionAvatarUser(session)} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="truncate text-sm font-medium text-foreground">
                    {isSignedIn
                      ? sessionDisplayName(session) ||
                        sessionEmail(session).split("@")[0] ||
                        "Your account"
                      : "Your account"}
                  </div>
                  {isSignedIn && sessionEmail(session) ? (
                    <div className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
                      {sessionEmail(session)}
                    </div>
                  ) : !isSignedIn ? (
                    <div className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
                      Not connected
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {isSignedIn ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Badge
                            variant="outline"
                            className={`gap-1 text-[11px] ${badgeClassName}`}
                          >
                            <StatusDot
                              variant={
                                statusTone === "error"
                                  ? "destructive"
                                  : statusTone === "ready"
                                    ? "success"
                                    : statusTone === "syncing"
                                      ? "warning"
                                      : "muted"
                              }
                            />
                            <span>{statusBadgeLabel}</span>
                          </Badge>
                        }
                      />
                      <TooltipContent>
                        <div className="grid gap-0.5 text-xs">
                          <div>
                            <span className="text-muted-foreground">
                              Account ·{" "}
                            </span>
                            {sessionState.isPending
                              ? "Checking…"
                              : authError
                                ? "Error"
                                : "Signed in"}
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              Runtime ·{" "}
                            </span>
                            {runtimeBindingReady
                              ? "Ready on this desktop"
                              : "Setup in progress"}
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Refresh session"
                      onClick={() => void handleRefreshSession()}
                      disabled={sessionState.isPending}
                    >
                      {sessionState.isPending ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Sign out"
                      onClick={() => void handleSignOut()}
                    >
                      <LogOut size={14} />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void handleStartSignIn()}
                    disabled={isStartingSignIn}
                  >
                    {isStartingSignIn ? "Opening sign-in..." : "Sign in"}
                  </Button>
                )}
              </div>
            </div>

            {(authMessage || authError) && (
              <div className="flex items-start gap-2 px-4 py-3 text-xs leading-5">
                {authError ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                )}
                <div
                  className={`min-w-0 flex-1 ${authError ? "text-destructive" : "text-foreground"}`}
                >
                  {authError || authMessage}
                </div>
              </div>
            )}
          </SettingsCard>

        <BillingSummaryCard
          overview={billingState.overview}
          usage={billingState.usage}
          links={billingState.links}
          isLoading={billingState.isLoading}
          error={billingState.error}
        />
      </section>
    );
}
