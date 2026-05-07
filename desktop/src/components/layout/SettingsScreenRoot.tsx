import {
  AlertTriangle,
  Check,
  CircleHelp,
  Copy,
  CreditCard,
  ExternalLink,
  FolderOpen,
  Globe,
  Info,
  Loader2,
  Package,
  Plug,
  RotateCcw,
  Send,
  Settings2,
  User2,
  Waypoints,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AuthPanel } from "@/components/auth/AuthPanel";
import { BillingSettingsPanel } from "@/components/billing/BillingSettingsPanel";
import { IntegrationsPane } from "@/components/panes/IntegrationsPane";
import {
  SettingsCard,
  SettingsMenuSelectRow,
  SettingsPage,
  SettingsRow,
  SettingsScreen,
  type SettingsScreenNavEntry,
  SettingsSection,
  SettingsToggle,
  SubmissionsPanel,
} from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

import type {
  ColorScheme,
  ControlCenterCardsPerRow,
  ThemeVariant,
} from "@/components/layout/AppShell";

/**
 * Theme swatches mirror the SettingsDialog's previous mapping. They're
 * kept as small color squares in the Theme select dropdown.
 */
const THEME_SWATCHES: Record<string, [string, string, string]> = {
  "amber-minimal-dark": ["#1a1814", "#e8853a", "#2e2920"],
  "amber-minimal-light": ["#ffffff", "#e8853a", "#fef5ec"],
  "cosmic-night-dark": ["#1a1035", "#a78bfa", "#352a5c"],
  "cosmic-night-light": ["#f5f3ff", "#7c3aed", "#e4dff7"],
  "sepia-dark": ["#2c2520", "#c0825a", "#3d332e"],
  "sepia-light": ["#faf6ef", "#c0825a", "#ebe3d2"],
  "clean-slate-dark": ["#1a1d25", "#6d8cf5", "#2d3340"],
  "clean-slate-light": ["#f8f9fc", "#5b72e0", "#e4e7f0"],
  "bold-tech-dark": ["#0f0b1a", "#a855f7", "#261e3d"],
  "bold-tech-light": ["#ffffff", "#8b5cf6", "#f0ecfb"],
  "catppuccin-dark": ["#1e1e2e", "#cba6f7", "#313244"],
  "catppuccin-light": ["#eff1f5", "#8839ef", "#ccd0da"],
  "bubblegum-dark": ["#1f2937", "#f9a8d4", "#374151"],
  "bubblegum-light": ["#fef2f8", "#ec4899", "#fce7f3"],
};

const THEME_VARIANT_LABELS: Record<ThemeVariant, string> = {
  "amber-minimal": "Holaos",
  "cosmic-night": "Cosmic Night",
  sepia: "Sepia",
  "clean-slate": "Clean Slate",
  "bold-tech": "Bold Tech",
  catppuccin: "Catppuccin",
  bubblegum: "Bubblegum",
};

const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Section order mirrors the reference — General first (the most common
 * destination) then identity, billing, integrations, then read-only
 * inspect surfaces (submissions, about) at the bottom. The section ids
 * stay the legacy `UiSettingsPaneSection` strings so the IPC
 * `onOpenSettingsPane(section)` channel keeps working unchanged.
 */
const SETTINGS_NAV: ReadonlyArray<SettingsScreenNavEntry<UiSettingsPaneSection>> = [
  { id: "settings", label: "General", icon: Settings2 },
  { id: "account", label: "Account", icon: User2 },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "providers", label: "AI", icon: Waypoints },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "submissions", label: "Submissions", icon: Send },
  { id: "about", label: "About", icon: Info },
];

const ABOUT_LINKS = [
  {
    id: "home",
    label: "Homepage",
    icon: Globe,
    href: "https://www.holaboss.ai",
  },
  {
    id: "docs",
    label: "Docs",
    icon: Info,
    href: "https://github.com/holaboss-ai/holaOS-releases",
  },
  {
    id: "help",
    label: "Get help",
    icon: CircleHelp,
    href: "https://github.com/holaboss-ai/holaOS-releases/issues",
  },
] as const;

function pageTitle(section: UiSettingsPaneSection): string {
  switch (section) {
    case "account":
      return "Account";
    case "billing":
      return "Billing";
    case "providers":
      return "AI";
    case "integrations":
      return "Integrations";
    case "submissions":
      return "Submissions";
    case "about":
      return "About";
    default:
      return "General";
  }
}

function pageDescription(section: UiSettingsPaneSection): string | undefined {
  switch (section) {
    case "settings":
      return "App-level preferences, appearance, and updates.";
    case "account":
      return "Sign-in, identity, and runtime binding for this desktop.";
    case "billing":
      return "Plan, usage, and invoices for your Holaboss account.";
    case "providers":
      return "Default models, providers, and per-workspace overrides.";
    case "integrations":
      return "Manage connections to third-party services your apps depend on.";
    case "submissions":
      return "Review templates and apps you've submitted for marketplace listing.";
    case "about":
      return undefined;
    default:
      return undefined;
  }
}

function formatBundleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded =
    value >= 10 || unitIndex === 0
      ? Math.round(value)
      : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

interface AppUpdateVisualState {
  badge: string;
  message: string;
  progressPercent: number | null;
  error: boolean;
  readyToInstall: boolean;
}

function aboutAppUpdateState(
  status: AppUpdateStatusPayload | null,
): AppUpdateVisualState {
  if (!status) {
    return {
      badge: "Loading",
      message: "Loading desktop update status.",
      progressPercent: null,
      error: false,
      readyToInstall: false,
    };
  }

  const latestVersion = status.latestVersion?.trim()
    ? `v${status.latestVersion.trim()}`
    : "the latest release";
  const channelLabel = status.channel === "beta" ? "beta" : "stable";

  if (!status.supported) {
    return {
      badge: "Unavailable",
      message: "In-app desktop updates are unavailable on this build.",
      progressPercent: null,
      error: false,
      readyToInstall: false,
    };
  }

  if (status.error) {
    return {
      badge: "Error",
      message: status.error,
      progressPercent: null,
      error: true,
      readyToInstall: false,
    };
  }

  if (status.downloaded) {
    return {
      badge: "Ready",
      message: `${latestVersion} has finished downloading and is ready to install.`,
      progressPercent: null,
      error: false,
      readyToInstall: true,
    };
  }

  if (status.available) {
    const progressPercent =
      typeof status.downloadProgressPercent === "number"
        ? Math.max(0, Math.min(100, Math.round(status.downloadProgressPercent)))
        : 0;
    return {
      badge: "Downloading",
      message: `Downloading ${latestVersion} in the background.`,
      progressPercent,
      error: false,
      readyToInstall: false,
    };
  }

  if (status.checking) {
    return {
      badge: "Checking",
      message: `Checking for the latest ${channelLabel} desktop release.`,
      progressPercent: null,
      error: false,
      readyToInstall: false,
    };
  }

  return {
    badge: "Current",
    message: `This device is up to date on the ${channelLabel} channel.`,
    progressPercent: null,
    error: false,
    readyToInstall: false,
  };
}

export interface SettingsScreenRootProps {
  activeSection: UiSettingsPaneSection;
  appVersion: string;
  onSectionChange: (section: UiSettingsPaneSection) => void;
  onBackToApp: () => void;
  colorScheme: ColorScheme;
  onColorSchemeChange: (scheme: ColorScheme) => void;
  themeVariant: ThemeVariant;
  themeVariants: readonly ThemeVariant[];
  onThemeVariantChange: (variant: ThemeVariant) => void;
  workspaceCardsPerRow: ControlCenterCardsPerRow;
  onWorkspaceCardsPerRowChange: (value: ControlCenterCardsPerRow) => void;
  onOpenExternalUrl: (url: string) => void;
  /** When set, opens Submissions panel pre-expanded on this submission. */
  submissionsFocusId?: string | null;
}

export function SettingsScreenRoot({
  activeSection,
  appVersion,
  onSectionChange,
  onBackToApp,
  colorScheme,
  onColorSchemeChange,
  themeVariant,
  themeVariants,
  onThemeVariantChange,
  workspaceCardsPerRow,
  onWorkspaceCardsPerRowChange,
  onOpenExternalUrl,
  submissionsFocusId = null,
}: SettingsScreenRootProps) {
  const displayAppVersion = appVersion.trim() || "Unavailable";
  const { hasHydratedWorkspaceList, selectedWorkspace, workspaces } =
    useWorkspaceDesktop();
  const [diagnosticsExportState, setDiagnosticsExportState] = useState<{
    status: "idle" | "exporting" | "success" | "error";
    message: string;
    bundlePath: string;
    sizeBytes: number;
    workspaceName: string;
  }>({
    status: "idle",
    message: "",
    bundlePath: "",
    sizeBytes: 0,
    workspaceName: "",
  });
  const [diagnosticsWorkspaceId, setDiagnosticsWorkspaceId] = useState("");
  const [diagnosticsPathCopied, setDiagnosticsPathCopied] = useState(false);
  const [appUpdateStatus, setAppUpdateStatus] =
    useState<AppUpdateStatusPayload | null>(null);
  const [appUpdateChannelPending, setAppUpdateChannelPending] = useState(false);
  const [appUpdateInstallPending, setAppUpdateInstallPending] = useState(false);

  const diagnosticsWorkspaceOptions = useMemo(() => {
    const byId = new Map<string, WorkspaceRecordPayload>();
    if (selectedWorkspace) {
      byId.set(selectedWorkspace.id, selectedWorkspace);
    }
    for (const workspace of workspaces) {
      byId.set(workspace.id, workspace);
    }
    return Array.from(byId.values()).map((workspace) => {
      const trimmedName = workspace.name.trim() || "Untitled workspace";
      return {
        value: workspace.id,
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceIcon workspace={workspace} size="sm" />
            <span className="truncate">{trimmedName}</span>
          </span>
        ),
        description: workspace.id,
        keywords: [trimmedName, workspace.id],
      };
    });
  }, [selectedWorkspace, workspaces]);

  const diagnosticsSelectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === diagnosticsWorkspaceId) ??
      (selectedWorkspace?.id === diagnosticsWorkspaceId
        ? selectedWorkspace
        : null),
    [diagnosticsWorkspaceId, selectedWorkspace, workspaces],
  );

  // Reset diagnostics workspace selection when the active workspace
  // changes or when the rail is first mounted.
  useEffect(() => {
    const selectedId = selectedWorkspace?.id ?? "";
    const fallbackId = selectedId || diagnosticsWorkspaceOptions[0]?.value || "";
    setDiagnosticsWorkspaceId((current) => {
      if (
        current &&
        diagnosticsWorkspaceOptions.some((option) => option.value === current)
      ) {
        return current;
      }
      return fallbackId;
    });
  }, [diagnosticsWorkspaceOptions, selectedWorkspace?.id]);

  // Subscribe to in-app update status while the settings screen is mounted.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.appUpdate.getStatus().then((status) => {
      if (!cancelled) {
        setAppUpdateStatus(status);
      }
    });
    void window.electronAPI.appUpdate.checkNow().then((status) => {
      if (!cancelled) {
        setAppUpdateStatus(status);
      }
    });
    const unsubscribe = window.electronAPI.appUpdate.onStateChange((status) => {
      if (!cancelled) {
        setAppUpdateStatus(status);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!appUpdateStatus?.downloaded) {
      setAppUpdateInstallPending(false);
    }
  }, [appUpdateStatus?.downloaded]);

  async function handleExportDiagnosticsBundle() {
    const workspaceId = diagnosticsWorkspaceId.trim();
    if (!workspaceId) {
      setDiagnosticsExportState((prev) => ({
        ...prev,
        status: "error",
        message: "Choose a workspace before exporting diagnostics.",
      }));
      return;
    }

    setDiagnosticsPathCopied(false);
    setDiagnosticsExportState((prev) => ({
      ...prev,
      status: "exporting",
      message: "",
    }));
    try {
      const result = await window.electronAPI.diagnostics.exportBundle({
        workspaceId,
      });
      setDiagnosticsExportState({
        status: "success",
        message: "",
        bundlePath: result.bundlePath,
        sizeBytes: result.archiveSizeBytes,
        workspaceName:
          result.workspaceName ?? diagnosticsSelectedWorkspace?.name ?? "",
      });
    } catch (error) {
      setDiagnosticsExportState((prev) => ({
        ...prev,
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to export diagnostics bundle.",
      }));
    }
  }

  async function handleRevealDiagnosticsBundle() {
    if (!diagnosticsExportState.bundlePath) {
      return;
    }
    await window.electronAPI.diagnostics.revealBundle(
      diagnosticsExportState.bundlePath,
    );
  }

  async function handleCopyDiagnosticsPath() {
    if (!diagnosticsExportState.bundlePath) {
      return;
    }
    try {
      await navigator.clipboard.writeText(diagnosticsExportState.bundlePath);
      setDiagnosticsPathCopied(true);
      window.setTimeout(() => setDiagnosticsPathCopied(false), 1500);
    } catch {
      setDiagnosticsPathCopied(false);
    }
  }

  async function handleSetBetaChannel(checked: boolean) {
    setAppUpdateChannelPending(true);
    try {
      const status = await window.electronAPI.appUpdate.setChannel(
        checked ? "beta" : "latest",
      );
      setAppUpdateStatus(status);
    } finally {
      setAppUpdateChannelPending(false);
    }
  }

  function handleInstallAppUpdateNow() {
    if (appUpdateInstallPending) {
      return;
    }

    setAppUpdateInstallPending(true);
    void window.electronAPI.appUpdate.installNow().catch((error) => {
      console.error("Failed to install the downloaded desktop update.", error);
      setAppUpdateInstallPending(false);
    });
  }

  const betaChannelEnabled = appUpdateStatus?.channel === "beta";
  const appUpdateChannelUnavailable = appUpdateStatus
    ? !appUpdateStatus.supported
    : true;
  const appUpdateState = aboutAppUpdateState(appUpdateStatus);

  return (
    <SettingsScreen
      sections={SETTINGS_NAV}
      activeSection={activeSection}
      onSectionChange={onSectionChange}
      onBackToApp={onBackToApp}
    >
      <SettingsPage
        title={pageTitle(activeSection)}
        description={pageDescription(activeSection)}
      >
        {activeSection === "account" ? <AuthPanel view="account" /> : null}

        {activeSection === "billing" ? <BillingSettingsPanel /> : null}

        {activeSection === "providers" ? <AuthPanel view="runtime" /> : null}

        {activeSection === "integrations" ? (
          <IntegrationsPane embedded />
        ) : null}

        {activeSection === "submissions" ? (
          <SubmissionsPanel initialFocusedId={submissionsFocusId} />
        ) : null}

        {activeSection === "settings" ? (
          <>
            <SettingsSection title="App">
              <SettingsCard>
                <SettingsRow label="holaOS Desktop" description="Version">
                  <Badge
                    variant="outline"
                    className="border-border bg-background/60 font-mono text-[11px] text-foreground"
                  >
                    v{displayAppVersion}
                  </Badge>
                </SettingsRow>

                {/* Desktop updates row stays a custom layout — it carries
                    a progress bar + dynamic install button that doesn't fit
                    the simple SettingsRow shape. Padding/spacing match the
                    surrounding rows. */}
                <div aria-live="polite" className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <span>Desktop updates</span>
                        <Badge
                          variant="outline"
                          className={`border-border bg-background/60 text-[11px] ${
                            appUpdateState.error
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          {appUpdateState.badge}
                        </Badge>
                      </div>
                      <div
                        className={`mt-0.5 text-xs leading-5 ${
                          appUpdateState.error
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {appUpdateState.message}
                      </div>
                    </div>

                    {appUpdateState.progressPercent !== null ? (
                      <div className="shrink-0 text-xs font-medium tabular-nums text-foreground">
                        {appUpdateState.progressPercent}%
                      </div>
                    ) : null}
                  </div>

                  {appUpdateState.progressPercent !== null ? (
                    <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-border/60">
                      <div
                        className={`h-full rounded-full transition-[width] ${
                          appUpdateState.error
                            ? "bg-destructive"
                            : "bg-primary/80"
                        }`}
                        style={{
                          width: `${appUpdateState.progressPercent}%`,
                        }}
                      />
                    </div>
                  ) : null}

                  {appUpdateState.readyToInstall ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleInstallAppUpdateNow}
                        disabled={appUpdateInstallPending}
                      >
                        {appUpdateInstallPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                        {appUpdateInstallPending
                          ? "Restarting..."
                          : "Update and Restart Now"}
                      </Button>
                    </div>
                  ) : null}
                </div>

                <SettingsToggle
                  label={
                    <span className="flex items-center gap-2">
                      Beta updates
                      <Badge
                        variant="outline"
                        className="border-border bg-background/60 text-[11px] text-muted-foreground"
                      >
                        {betaChannelEnabled ? "Beta" : "Latest"}
                      </Badge>
                    </span>
                  }
                  description={
                    appUpdateChannelUnavailable
                      ? "In-app update channels are unavailable on this build."
                      : "Opt into beta desktop releases before they reach the stable channel."
                  }
                  checked={betaChannelEnabled}
                  onCheckedChange={(checked) => {
                    void handleSetBetaChannel(checked);
                  }}
                  disabled={appUpdateChannelPending || appUpdateChannelUnavailable}
                />
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Appearance">
              <SettingsCard>
                <SettingsMenuSelectRow
                  label="Color scheme"
                  description="System, light, or dark."
                  value={colorScheme}
                  onValueChange={(value) =>
                    onColorSchemeChange(value as ColorScheme)
                  }
                  options={(["system", "light", "dark"] as const).map((scheme) => ({
                    value: scheme,
                    label: COLOR_SCHEME_LABELS[scheme],
                  }))}
                />
                <SettingsMenuSelectRow
                  label="Theme"
                  description="Pick a colour palette for the app."
                  value={themeVariant}
                  onValueChange={(value) =>
                    onThemeVariantChange(value as ThemeVariant)
                  }
                  options={themeVariants.map((variant) => {
                    const swatch =
                      THEME_SWATCHES[`${variant}-light`]?.[1] ??
                      THEME_SWATCHES[`${variant}-dark`]?.[1] ??
                      "#808080";
                    return {
                      value: variant,
                      label: (
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-3 shrink-0 rounded-sm border border-border"
                            style={{ background: swatch }}
                          />
                          {THEME_VARIANT_LABELS[variant]}
                        </span>
                      ),
                    };
                  })}
                />
                <SettingsMenuSelectRow
                  label="Workspace cards per row"
                  description="Choose how many control center cards to fit on each row when the window is wide enough."
                  value={String(workspaceCardsPerRow)}
                  onValueChange={(value) =>
                    onWorkspaceCardsPerRowChange(
                      Number(value) as ControlCenterCardsPerRow,
                    )
                  }
                  options={[
                    {
                      value: "2",
                      label: "2",
                      description: "Comfortable, larger previews.",
                    },
                    {
                      value: "3",
                      label: "3",
                      description: "Balanced density.",
                    },
                    {
                      value: "4",
                      label: "4",
                      description: "Dense, smaller cards.",
                    },
                  ]}
                />
              </SettingsCard>
            </SettingsSection>
          </>
        ) : null}

        {activeSection === "about" ? (
          <>
            <SettingsSection title="Links">
              <SettingsCard>
                {ABOUT_LINKS.map(({ id, label, icon: Icon, href }) => (
                  <SettingsRow
                    key={id}
                    label={label}
                    leading={<Icon className="size-4 text-muted-foreground" />}
                    interactive
                    onClick={() => onOpenExternalUrl(href)}
                  >
                    <ExternalLink className="size-4 text-muted-foreground" />
                  </SettingsRow>
                ))}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Diagnostics">
              <SettingsCard>
                <SettingsMenuSelectRow
                  label="Workspace"
                  description={
                    diagnosticsWorkspaceOptions.length > 0
                      ? "Choose the workspace to include in the diagnostics bundle."
                      : hasHydratedWorkspaceList
                        ? "No workspace is available to export."
                        : "Loading workspaces."
                  }
                  leading={
                    <FolderOpen className="size-4 text-muted-foreground" />
                  }
                  value={diagnosticsWorkspaceId}
                  onValueChange={setDiagnosticsWorkspaceId}
                  options={diagnosticsWorkspaceOptions}
                  disabled={
                    diagnosticsExportState.status === "exporting" ||
                    diagnosticsWorkspaceOptions.length === 0
                  }
                  placeholder={
                    hasHydratedWorkspaceList ? "No workspace" : "Loading"
                  }
                />
                <SettingsRow
                  label="Diagnostics bundle"
                  description="Logs, a workspace-scoped database snapshot, and a redacted config. Stays on your device."
                  leading={<Package className="size-4 text-muted-foreground" />}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleExportDiagnosticsBundle()}
                    disabled={
                      diagnosticsExportState.status === "exporting" ||
                      !diagnosticsWorkspaceId
                    }
                  >
                    {diagnosticsExportState.status === "exporting" ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Exporting…
                      </>
                    ) : diagnosticsExportState.status === "success" ? (
                      "Re-export"
                    ) : (
                      "Export"
                    )}
                  </Button>
                </SettingsRow>
                {diagnosticsExportState.status === "success" &&
                diagnosticsExportState.bundlePath ? (
                  <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
                    <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
                    <span className="truncate font-mono text-muted-foreground">
                      {diagnosticsExportState.bundlePath}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      · {formatBundleBytes(diagnosticsExportState.sizeBytes)}
                    </span>
                    {diagnosticsExportState.workspaceName ? (
                      <span className="max-w-[160px] shrink truncate text-muted-foreground">
                        · {diagnosticsExportState.workspaceName}
                      </span>
                    ) : null}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleRevealDiagnosticsBundle()}
                      >
                        <FolderOpen className="size-3" />
                        Reveal
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleCopyDiagnosticsPath()}
                      >
                        {diagnosticsPathCopied ? (
                          <>
                            <Check className="size-3" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="size-3" />
                            Copy
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {diagnosticsExportState.status === "error" &&
                diagnosticsExportState.message ? (
                  <div className="flex items-start gap-2 px-4 py-2.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="wrap-break-word">
                      {diagnosticsExportState.message}
                    </span>
                  </div>
                ) : null}
              </SettingsCard>
            </SettingsSection>
          </>
        ) : null}
      </SettingsPage>
    </SettingsScreen>
  );
}
