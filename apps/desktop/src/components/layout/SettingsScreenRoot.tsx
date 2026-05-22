import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  CreditCard,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  Globe,
  Info,
  Loader2,
  Plug,
  RotateCcw,
  Send,
  Settings2,
  User2,
  Waypoints,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AuthPanel } from "@/components/auth/AuthPanel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BillingSettingsPanel } from "@/components/billing/BillingSettingsPanel";
import { IntegrationsPane } from "@/components/panes/IntegrationsPane";
import { MemoryPane } from "@/components/panes/MemoryPane";
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useIsDarkTheme } from "@/lib/themeAttr";
import {
  loadWorkspaceOnboardingPreference,
  persistWorkspaceOnboardingPreference,
  type WorkspaceOnboardingPreference,
} from "@/features/workspace-onboarding/preferences";
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
  "holaos-dark": ["#1a1814", "#e8853a", "#2e2920"],
  "holaos-light": ["#ffffff", "#e8853a", "#fef5ec"],
  "catppuccin-dark": ["#1e1e2e", "#f5c2e7", "#313244"],
  "catppuccin-light": ["#eff1f5", "#ea76cb", "#e1e3e8"],
  "rose-pine-dark": ["#191724", "#c4a7e7", "#26233a"],
  "rose-pine-light": ["#faf4ed", "#907aa9", "#f2e9de"],
  "solarized-dark": ["#002b36", "#268bd2", "#073642"],
  "solarized-light": ["#fdf6e3", "#268bd2", "#eee8d5"],
  "nord-dark": ["#2e3440", "#88c0d0", "#3b4252"],
  "nord-light": ["#eceff4", "#5e81ac", "#d8dee9"],
  "one-dark-pro-dark": ["#282c34", "#61afef", "#3a3f4b"],
  "one-dark-pro-light": ["#fafafa", "#4078f2", "#eaeaeb"],
  "gruvbox-dark": ["#282828", "#fabd2f", "#3c3836"],
  "gruvbox-light": ["#fbf1c7", "#d79921", "#ebdbb2"],
  "vitesse-dark": ["#121212", "#4d9375", "#1c1c1c"],
  "vitesse-light": ["#ffffff", "#1e754f", "#f0f0f0"],
};

const THEME_VARIANT_LABELS: Record<ThemeVariant, string> = {
  holaos: "holaOS",
  catppuccin: "Catppuccin",
  "rose-pine": "Rosé Pine",
  solarized: "Solarized",
  nord: "Nord",
  "one-dark-pro": "One Dark Pro",
  gruvbox: "Gruvbox",
  vitesse: "Vitesse",
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
  { id: "providers", label: "Providers", icon: Waypoints },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "memory", label: "Memory", icon: FolderOpen },
  { id: "submissions", label: "Submissions", icon: Send },
  { id: "experimental", label: "Experimental", icon: FlaskConical },
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
      return "Providers";
    case "integrations":
      return "Integrations";
    case "memory":
      return "Memory";
    case "submissions":
      return "Submissions";
    case "experimental":
      return "Experimental 🧪";
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
      return "Your toolkit pool. Connect once, use across workspaces.";
    case "memory":
      return "Browse the current workspace memory filesystem.";
    case "submissions":
      return "Review templates and apps you've submitted for marketplace listing.";
    case "experimental":
      return "Opt into in-progress features. Behavior may change and bugs are expected.";
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
  desktopNotificationsEnabled: boolean;
  onDesktopNotificationsChange: (enabled: boolean) => void;
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
  desktopNotificationsEnabled,
  onDesktopNotificationsChange,
  onOpenExternalUrl,
  submissionsFocusId = null,
}: SettingsScreenRootProps) {
  const displayAppVersion = appVersion.trim() || "Unavailable";
  const isDarkTheme = useIsDarkTheme();
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
  const [diagnosticsPathCopied, setDiagnosticsPathCopied] = useState(false);
  const [diagnosticsMenuOpen, setDiagnosticsMenuOpen] = useState(false);
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

  // Observe in-app update status while the settings screen is mounted.
  // The Electron main process owns checks/downloads so this route can unmount
  // without changing updater behavior.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.appUpdate.getStatus().then((status) => {
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

  async function handleExportDiagnosticsBundle(workspaceId: string) {
    const trimmed = workspaceId.trim();
    if (!trimmed) {
      return;
    }
    const workspace =
      workspaces.find((w) => w.id === trimmed) ??
      (selectedWorkspace?.id === trimmed ? selectedWorkspace : null);

    setDiagnosticsPathCopied(false);
    setDiagnosticsExportState((prev) => ({
      ...prev,
      status: "exporting",
      message: "",
    }));
    try {
      const result = await window.electronAPI.diagnostics.exportBundle({
        workspaceId: trimmed,
      });
      setDiagnosticsExportState({
        status: "success",
        message: "",
        bundlePath: result.bundlePath,
        sizeBytes: result.archiveSizeBytes,
        workspaceName: result.workspaceName ?? workspace?.name ?? "",
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
      railFooter={
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {ABOUT_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Tooltip key={link.id}>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onOpenExternalUrl(link.href)}
                      aria-label={link.label}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Icon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>{link.label}</TooltipContent>
              </Tooltip>
            );
          })}
          <span className="ml-auto font-mono tabular-nums">
            v{displayAppVersion}
          </span>
        </div>
      }
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

        {activeSection === "memory" ? <MemoryPane embedded /> : null}

        {activeSection === "submissions" ? (
          <SubmissionsPanel initialFocusedId={submissionsFocusId} />
        ) : null}

        {activeSection === "experimental" ? <ExperimentalPanel /> : null}

        {activeSection === "settings" ? (
          <>
            <SettingsSection title="App">
              <SettingsCard>
                <SettingsRow label="holaOS Desktop" description="Version">
                  <Badge
                    variant="outline"
                    className="border-border bg-fg-2 font-mono text-[11px] text-foreground"
                  >
                    v{displayAppVersion}
                  </Badge>
                </SettingsRow>

                {/* Desktop updates row stays a custom layout — it carries
                    a progress bar + dynamic install button that doesn't fit
                    the simple SettingsRow shape. Padding/spacing match the
                    surrounding rows. */}
                <div aria-live="polite" className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <span>Desktop updates</span>
                        <Badge
                          variant="outline"
                          className={`border-border bg-fg-2 text-[11px] ${
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
                    <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-fg-8">
                      <div
                        className={`h-full rounded-full transition-[width] ${
                          appUpdateState.error
                            ? "bg-destructive"
                            : "bg-primary"
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
                        className="border-border bg-fg-2 text-[11px] text-muted-foreground"
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

            <SettingsSection title="Notifications">
              <SettingsCard>
                <SettingsToggle
                  label="Desktop notifications"
                  description="Get system alerts when reminders fire and tasks complete. Click an alert to jump to the workspace."
                  checked={desktopNotificationsEnabled}
                  onCheckedChange={onDesktopNotificationsChange}
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
                    const preferredKey = isDarkTheme
                      ? `${variant}-dark`
                      : `${variant}-light`;
                    const fallbackKey = isDarkTheme
                      ? `${variant}-light`
                      : `${variant}-dark`;
                    const swatch =
                      THEME_SWATCHES[preferredKey]?.[1] ??
                      THEME_SWATCHES[fallbackKey]?.[1] ??
                      "#808080";
                    return {
                      value: variant,
                      label: (
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-3.5 shrink-0 rounded-full"
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

            <SettingsSection title="Diagnostics">
              <SettingsCard>
                <SettingsRow
                  label="Diagnostics bundle"
                  description="Logs, a workspace-scoped database snapshot, and a redacted config. Stays on your device."
                >
                  <Popover
                    open={diagnosticsMenuOpen}
                    onOpenChange={setDiagnosticsMenuOpen}
                  >
                    <PopoverTrigger
                      disabled={
                        diagnosticsExportState.status === "exporting" ||
                        diagnosticsWorkspaceOptions.length === 0
                      }
                      render={
                        <Button type="button" variant="outline" size="sm">
                          {diagnosticsExportState.status === "exporting" ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Exporting…
                            </>
                          ) : (
                            <>
                              {diagnosticsExportState.status === "success"
                                ? "Re-export"
                                : "Export"}
                              <ChevronDown className="size-3.5 text-muted-foreground" />
                            </>
                          )}
                        </Button>
                      }
                    />
                    <PopoverContent
                      align="end"
                      className="w-72 p-0"
                    >
                      <Command>
                        {diagnosticsWorkspaceOptions.length > 8 ? (
                          <CommandInput placeholder="Search workspaces…" />
                        ) : null}
                        <CommandList>
                          <CommandEmpty>
                            {hasHydratedWorkspaceList
                              ? "No workspaces available."
                              : "Loading workspaces…"}
                          </CommandEmpty>
                          <CommandGroup
                            className="p-1"
                            heading="Export bundle for"
                          >
                            {diagnosticsWorkspaceOptions.map((option) => (
                              <CommandItem
                                key={option.value}
                                value={option.value}
                                keywords={option.keywords}
                                onSelect={(workspaceId) => {
                                  setDiagnosticsMenuOpen(false);
                                  void handleExportDiagnosticsBundle(
                                    workspaceId,
                                  );
                                }}
                              >
                                {option.label}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
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

const NEW_SHELL_STORAGE_KEY = "holaboss-new-layout-shell-v1";

function ExperimentalPanel() {
  const [newShellEnabled, setNewShellEnabled] = useState(() => {
    try {
      return localStorage.getItem(NEW_SHELL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [workspaceOnboardingPreference, setWorkspaceOnboardingPreference] =
    useState<WorkspaceOnboardingPreference>(
      loadWorkspaceOnboardingPreference,
    );
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);

  const apply = (next: boolean) => {
    try {
      localStorage.setItem(NEW_SHELL_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* localStorage unavailable — fall through to reload anyway */
    }
    setNewShellEnabled(next);
    // Reload so App.tsx picks the right shell at boot. The renderer
    // holds quite a bit of in-flight state between the two shells; a
    // hard reload is the safe path.
    window.location.reload();
  };

  return (
    <>
      <SettingsCard>
        <SettingsToggle
          leading={<FlaskConical className="size-4 text-foreground/60" />}
          label="New layout shell"
          description="Adopt the redesigned desktop shell (sidebar collapse, tab-based files, inline apps). The app will reload to apply your choice."
          checked={newShellEnabled}
          onCheckedChange={(next) => {
            if (next) {
              setConfirmEnableOpen(true);
            } else {
              apply(false);
            }
          }}
        />
        <SettingsMenuSelectRow
          label="Workspace onboarding mode"
          description="Controls what Start onboarding uses for new empty workspaces. Deterministic is the default release path; agentic stays opt-in while under construction."
          value={workspaceOnboardingPreference}
          onValueChange={(value) => {
            const nextValue =
              value === "agentic" ? "agentic" : "deterministic";
            persistWorkspaceOnboardingPreference(nextValue);
            setWorkspaceOnboardingPreference(nextValue);
          }}
          options={[
            {
              value: "deterministic",
              label: "Deterministic",
              description: "Centered intro card with a lightweight continue flow.",
            },
            {
              value: "agentic",
              label: "Agentic",
              description: "Lab-backed conversational onboarding still under active construction.",
            },
          ]}
        />
      </SettingsCard>
      <ConfirmDialog
        open={confirmEnableOpen}
        onOpenChange={setConfirmEnableOpen}
        title="Enable the new layout shell?"
        description="This UI is in active development and may contain bugs. You can switch back from this same page anytime — the app will reload when you do."
        confirmLabel="Enable and reload"
        cancelLabel="Not yet"
        onConfirm={() => apply(true)}
      />
    </>
  );
}
