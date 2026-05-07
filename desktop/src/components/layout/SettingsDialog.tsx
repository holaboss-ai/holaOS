import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
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
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { BillingSettingsPanel } from "@/components/billing/BillingSettingsPanel";
import { IntegrationsPane } from "@/components/panes/IntegrationsPane";
import {
  SettingsCard,
  SettingsMenuSelectRow,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
  SubmissionsPanel,
} from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

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

import type {
  ColorScheme,
  ControlCenterCardsPerRow,
  ThemeVariant,
} from "@/components/layout/AppShell";

interface SettingsDialogProps {
  open: boolean;
  activeSection: UiSettingsPaneSection;
  appVersion: string;
  onSectionChange: (section: UiSettingsPaneSection) => void;
  onClose: () => void;
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

const SETTINGS_SECTIONS: Array<{
  id: UiSettingsPaneSection;
  label: string;
  icon: typeof User2;
}> = [
  { id: "account", label: "Account", icon: User2 },
  { id: "settings", label: "Settings", icon: Settings2 },
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

function titleForSection(section: UiSettingsPaneSection): string {
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
      return "Settings";
  }
}

function aboutAppUpdateState(status: AppUpdateStatusPayload | null): {
  badge: string;
  message: string;
  progressPercent: number | null;
  error: boolean;
  readyToInstall: boolean;
} {
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

export function SettingsDialog({
  open,
  activeSection,
  appVersion,
  onSectionChange,
  onClose,
  colorScheme,
  onColorSchemeChange,
  themeVariant,
  themeVariants,
  onThemeVariantChange,
  workspaceCardsPerRow,
  onWorkspaceCardsPerRowChange,
  onOpenExternalUrl,
  submissionsFocusId = null,
}: SettingsDialogProps) {
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

  // ESC key handling moved to Base UI Dialog (built-in).
  // The previous manual document-level keydown listener fought with
  // other ESC consumers; Dialog scopes it correctly to the open dialog.

  const diagnosticsWorkspaceOptions = useMemo(() => {
    const byId = new Map<string, WorkspaceRecordPayload>();
    if (selectedWorkspace) {
      byId.set(selectedWorkspace.id, selectedWorkspace);
    }
    for (const workspace of workspaces) {
      byId.set(workspace.id, workspace);
    }
    return Array.from(byId.values()).map((workspace) => ({
      value: workspace.id,
      label: workspace.name.trim() || "Untitled workspace",
      description: workspace.id,
    }));
  }, [selectedWorkspace, workspaces]);

  const diagnosticsSelectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === diagnosticsWorkspaceId) ??
      (selectedWorkspace?.id === diagnosticsWorkspaceId
        ? selectedWorkspace
        : null),
    [diagnosticsWorkspaceId, selectedWorkspace, workspaces],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
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
  }, [diagnosticsWorkspaceOptions, open, selectedWorkspace?.id]);

  useEffect(() => {
    if (!open) {
      return;
    }

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
  }, [open]);

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

  // Mount/exit lifecycle is now owned by Base UI Dialog (Portal renders
  // the popup only while open, with built-in starting/ending-style hooks
  // for entrance/exit transitions). Removed the manual three-phase state
  // machine that was previously needed when the dialog was a hand-rolled
  // div modal.
  const betaChannelEnabled = appUpdateStatus?.channel === "beta";
  const appUpdateChannelUnavailable = appUpdateStatus
    ? !appUpdateStatus.supported
    : true;
  const appUpdateState = aboutAppUpdateState(appUpdateStatus);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-background/60 backdrop-blur-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-200"
        />
        <DialogPrimitive.Popup
          aria-label="Settings"
          className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 grid h-[min(780px,calc(100vh-32px))] w-[min(980px,calc(100vw-24px))] min-w-0 overflow-hidden rounded-2xl bg-background/85 backdrop-blur-2xl backdrop-saturate-150 shadow-xl grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] duration-200 ease-out"
        >
        <aside className="border-b border-sidebar-border bg-sidebar p-4 text-sidebar-foreground lg:border-b-0 lg:border-r">
          <nav className="mt-4 grid gap-1">
            {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
              const active = id === activeSection;

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSectionChange(id)}
                  className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 font-medium">{label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
            <div className="text-lg font-semibold text-foreground">
              {titleForSection(activeSection)}
            </div>

            <Button
              variant="outline"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X size={16} />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
            {activeSection === "account" ? (
              <div className="w-full">
                <AuthPanel view="account" />
              </div>
            ) : null}

            {activeSection === "billing" ? <BillingSettingsPanel /> : null}

            {activeSection === "providers" ? (
              <div className="grid gap-6">
                <section className="max-w-[920px]">
                  <AuthPanel view="runtime" />
                </section>
              </div>
            ) : null}

            {activeSection === "integrations" ? (
              <IntegrationsPane embedded />
            ) : null}

            {activeSection === "submissions" ? (
              <SubmissionsPanel initialFocusedId={submissionsFocusId} />
            ) : null}

            {activeSection === "settings" ? (
              <div className="grid gap-6">
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
                        a progress bar + dynamic install button that don't
                        fit the simple SettingsRow shape. Padding/spacing
                        match the surrounding rows. */}
                    <div aria-live="polite" className="px-4 py-3">
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
                      disabled={
                        appUpdateChannelPending || appUpdateChannelUnavailable
                      }
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
                      options={(["system", "light", "dark"] as const).map(
                        (scheme) => ({
                          value: scheme,
                          label: COLOR_SCHEME_LABELS[scheme],
                        }),
                      )}
                      triggerWidth="w-[140px]"
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
                      triggerWidth="w-[180px]"
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
                      triggerWidth="w-[140px]"
                    />
                  </SettingsCard>
                </SettingsSection>
              </div>
            ) : null}

            {activeSection === "about" ? (
              <div className="grid gap-6">
                <SettingsSection title="Links">
                  <SettingsCard>
                    {ABOUT_LINKS.map(({ id, label, icon: Icon, href }) => (
                      <SettingsRow
                        key={id}
                        label={label}
                        leading={
                          <Icon className="size-4 text-muted-foreground" />
                        }
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
                      triggerWidth="w-[240px]"
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
                      leading={
                        <Package className="size-4 text-muted-foreground" />
                      }
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
                          ·{" "}
                          {formatBundleBytes(
                            diagnosticsExportState.sizeBytes,
                          )}
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
              </div>
            ) : null}
          </div>
        </section>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
