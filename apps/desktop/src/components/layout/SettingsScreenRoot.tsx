import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Check,
  CircleHelp,
  Copy,
  CreditCard,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Send,
  RefreshCw,
  RotateCcw,
  Settings2,
  User2,
} from "@/components/ui/icons";
import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";

import { AuthPanel } from "@/components/auth/AuthPanel";
import {
  bossmanExperimentalEnabledAtom,
  cloudModeEnabledAtom,
  discoverEnabledAtom,
} from "@/components/layout/shell/state/ui";
import { BillingSettingsPanel } from "@/components/billing/BillingSettingsPanel";
import { ChannelsPane } from "@/components/panes/ChannelsPane";
import { MemoryPane } from "@/components/panes/MemoryPane";
import { MediaGenerationSettings } from "@/components/settings/MediaGenerationSettings";
import {
  AgentsSettingsPanel,
  BYOKSettingsPanel,
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
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ViewTransition } from "@/components/ui/view-transition";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import {
  KEYBOARD_SHORTCUT_GROUPS,
  modifierKeyLabel,
  shortcutKeyLabel,
} from "@/components/layout/shell/keyboardShortcuts";
import { cn } from "@/lib/utils";

import type {
  ColorScheme,
  FontFamily,
} from "@/components/layout/themes";

const FONT_FAMILY_LABELS: Record<FontFamily, string> = {
  inter: "Inter",
  system: "System",
  jakarta: "Plus Jakarta Sans",
  plex: "IBM Plex Sans",
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
  { id: "agents", label: "Agents", icon: Bot },
  { id: "byok", label: "Model Providers", icon: KeyRound },
  { id: "channels", label: "Channels", icon: Send },
  { id: "memory", label: "Memory", icon: BrainCircuit },
  { id: "experimental", label: "Experimental", icon: FlaskConical },
];

const ABOUT_LINKS = [
  {
    id: "home",
    label: "Homepage",
    icon: Globe,
    href: "https://www.holaos.ai",
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
    case "agents":
      return "Agents";
    case "integrations":
      return "Integrations";
    case "channels":
      return "Channels";
    case "memory":
      return "Memory";
    case "submissions":
      return "Submissions";
    case "experimental":
      return "Experimental";
    default:
      return "General";
  }
}

function pageDescription(_section: UiSettingsPaneSection): string | undefined {
  return undefined;
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
  colorScheme: ColorScheme;
  onColorSchemeChange: (scheme: ColorScheme) => void;
  fontFamily: FontFamily;
  fontFamilies: readonly FontFamily[];
  onFontFamilyChange: (font: FontFamily) => void;
  desktopNotificationsEnabled: boolean;
  onDesktopNotificationsChange: (enabled: boolean) => void;
  keepAwakeEnabled: boolean;
  onKeepAwakeChange: (enabled: boolean) => void;
  onOpenExternalUrl: (url: string) => void;
  /** When set, opens Submissions panel pre-expanded on this submission. */
  submissionsFocusId?: string | null;
}

export function SettingsScreenRoot({
  activeSection,
  appVersion,
  onSectionChange,
  colorScheme,
  onColorSchemeChange,
  fontFamily,
  fontFamilies,
  onFontFamilyChange,
  desktopNotificationsEnabled,
  onDesktopNotificationsChange,
  keepAwakeEnabled,
  onKeepAwakeChange,
  onOpenExternalUrl,
  submissionsFocusId = null,
}: SettingsScreenRootProps) {
  const displayAppVersion = appVersion.trim() || "Unavailable";
  const [diagnosticsExportState, setDiagnosticsExportState] = useState<{
    status: "idle" | "exporting" | "success" | "error";
    message: string;
    bundlePath: string;
    sizeBytes: number;
  }>({
    status: "idle",
    message: "",
    bundlePath: "",
    sizeBytes: 0,
  });
  const [diagnosticsPathCopied, setDiagnosticsPathCopied] = useState(false);
  const [appUpdateStatus, setAppUpdateStatus] =
    useState<AppUpdateStatusPayload | null>(null);
  const [appUpdateChannelPending, setAppUpdateChannelPending] = useState(false);
  const [appUpdateInstallPending, setAppUpdateInstallPending] = useState(false);
  const [appUpdateCheckPending, setAppUpdateCheckPending] = useState(false);

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

  async function handleExportDiagnosticsBundle() {
    if (diagnosticsExportState.status === "exporting") {
      return;
    }
    setDiagnosticsPathCopied(false);
    setDiagnosticsExportState((prev) => ({
      ...prev,
      status: "exporting",
      message: "",
    }));
    try {
      const result = await window.electronAPI.diagnostics.exportBundle();
      setDiagnosticsExportState({
        status: "success",
        message: "",
        bundlePath: result.bundlePath,
        sizeBytes: result.archiveSizeBytes,
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

  async function handleCheckForUpdatesNow() {
    if (appUpdateCheckPending) {
      return;
    }
    setAppUpdateCheckPending(true);
    try {
      const status = await window.electronAPI.appUpdate.checkNow();
      setAppUpdateStatus(status);
    } catch (error) {
      console.error("Failed to check for desktop updates.", error);
    } finally {
      setAppUpdateCheckPending(false);
    }
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
        <ViewTransition
          className="grid gap-6"
          transitionKey={activeSection}
          variant="slide"
        >
        {activeSection === "account" ? <AuthPanel /> : null}

        {activeSection === "billing" ? <BillingSettingsPanel /> : null}

        {activeSection === "agents" ? (
          <div className="grid gap-6">
            <AgentsSettingsPanel />
            <MediaGenerationSettings />
          </div>
        ) : null}

        {activeSection === "byok" ? <BYOKSettingsPanel /> : null}

        {activeSection === "channels" ? <ChannelsPane embedded /> : null}

        {activeSection === "memory" ? <MemoryPane embedded /> : null}

        {activeSection === "submissions" ? (
          <SubmissionsPanel initialFocusedId={submissionsFocusId} />
        ) : null}

        {activeSection === "experimental" ? <ExperimentalPanel /> : null}

        {activeSection === "settings" ? (
          <>
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
                  label="Font"
                  description="The typeface used across the app."
                  value={fontFamily}
                  onValueChange={(value) =>
                    onFontFamilyChange(value as FontFamily)
                  }
                  options={fontFamilies.map((font) => ({
                    value: font,
                    label: FONT_FAMILY_LABELS[font],
                  }))}
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

            <SettingsSection title="Power">
              <SettingsCard>
                <SettingsToggle
                  label="Keep computer awake"
                  description="Automations and channels only run while your computer is awake."
                  checked={keepAwakeEnabled}
                  onCheckedChange={onKeepAwakeChange}
                />
              </SettingsCard>
            </SettingsSection>

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

                    <div className="flex shrink-0 items-center gap-2">
                      {appUpdateState.progressPercent !== null ? (
                        <div className="text-xs font-medium tabular-nums text-foreground">
                          {appUpdateState.progressPercent}%
                        </div>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Check for updates"
                              onClick={() => void handleCheckForUpdatesNow()}
                              disabled={
                                !appUpdateStatus?.supported ||
                                appUpdateCheckPending ||
                                Boolean(appUpdateStatus?.checking) ||
                                appUpdateState.progressPercent !== null ||
                                appUpdateState.readyToInstall
                              }
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <RefreshCw
                                className={cn(
                                  "size-3.5",
                                  (appUpdateCheckPending ||
                                    appUpdateStatus?.checking) &&
                                    "animate-spin",
                                )}
                              />
                            </Button>
                          }
                        />
                        <TooltipContent>Check for updates</TooltipContent>
                      </Tooltip>
                    </div>
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

            <SettingsSection
              title="Keyboard shortcuts"
              description={
                <span className="flex items-center gap-1.5">
                  <span>Press</span>
                  <Kbd>{modifierKeyLabel()}</Kbd>
                  <Kbd>/</Kbd>
                  <span>anywhere in the app to pop this list up.</span>
                </span>
              }
            >
              <SettingsCard>
                {KEYBOARD_SHORTCUT_GROUPS.map((group, groupIdx) => (
                  <div key={group.heading}>
                    <div
                      className={cn(
                        "flex items-center px-4 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-foreground/40",
                        groupIdx === 0 ? "pt-3" : "pt-4",
                      )}
                    >
                      {group.heading}
                    </div>
                    <div className="flex flex-col">
                      {group.items.map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center gap-3 px-4 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
                            {item.label}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {item.keys.map((k, i) => (
                              <Kbd key={`${item.label}:${i}:${k}`}>
                                {shortcutKeyLabel(k)}
                              </Kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Diagnostics">
              <SettingsCard>
                <SettingsRow
                  label="Diagnostics bundle"
                  description="Logs, a snapshot of the runtime databases, and a redacted config. Stays on your device."
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={diagnosticsExportState.status === "exporting"}
                    onClick={() => void handleExportDiagnosticsBundle()}
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

            <SettingsSection
              title="Workspace config"
              description="The raw workspace.yaml the runtime compiles into the agent's MCP servers, skills, and tools — handy for confirming an installed HolaApp wrote its mcp_registry entry."
            >
              <WorkspaceConfigDiagnosticsCard />
            </SettingsSection>
          </>
        ) : null}
        </ViewTransition>
      </SettingsPage>
    </SettingsScreen>
  );
}

/**
 * Read-only viewer for the active workspace's workspace.yaml. Pulls the
 * file verbatim from the runtime so Settings → Diagnostics can show the
 * ground truth the runner compiles from — e.g. whether a HolaApp's
 * mcp_registry entry is actually present.
 */
function WorkspaceConfigDiagnosticsCard() {
  const { selectedWorkspace } = useWorkspaceDesktop();
  const workspaceId = selectedWorkspace?.id?.trim() || "";
  const [state, setState] = useState<{
    status: "idle" | "loading" | "loaded" | "error";
    path: string;
    content: string;
    exists: boolean;
    message: string;
  }>({ status: "idle", path: "", content: "", exists: false, message: "" });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({
        status: "error",
        path: "",
        content: "",
        exists: false,
        message: "No active workspace.",
      });
      return;
    }
    setState((prev) => ({ ...prev, status: "loading", message: "" }));
    try {
      const result =
        await window.electronAPI.workspace.getConfigYaml(workspaceId);
      setState({
        status: "loaded",
        path: result.path,
        content: result.content,
        exists: result.exists,
        message: "",
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to read workspace.yaml.",
      }));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCopy() {
    if (!state.content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(state.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SettingsCard>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            workspace.yaml
          </div>
          {state.path ? (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {state.path}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={state.status === "loading"}
            onClick={() => void load()}
          >
            {state.status === "loading" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!state.content}
            onClick={() => void handleCopy()}
          >
            {copied ? (
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
      {state.status === "error" ? (
        <div className="flex items-start gap-2 px-4 pb-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{state.message}</span>
        </div>
      ) : state.status === "loaded" && !state.exists ? (
        <div className="px-4 pb-3 text-xs text-muted-foreground">
          No workspace.yaml on disk yet.
        </div>
      ) : state.content ? (
        <pre className="max-h-96 overflow-auto whitespace-pre border-t border-border bg-fg-2 px-4 py-3 font-mono text-[11px] leading-5 text-foreground">
          {state.content}
        </pre>
      ) : state.status === "loading" ? (
        <div className="px-4 pb-3 text-xs text-muted-foreground">Loading…</div>
      ) : null}
    </SettingsCard>
  );
}

function ExperimentalPanel() {
  const [bossmanEnabled, setBossmanEnabled] = useAtom(
    bossmanExperimentalEnabledAtom,
  );
  const [cloudModeEnabled, setCloudModeEnabled] = useAtom(cloudModeEnabledAtom);
  const [discoverEnabled, setDiscoverEnabled] = useAtom(discoverEnabledAtom);
  return (
    <SettingsCard>
      <SettingsToggle
        label="HolaHub community"
        description="Show the HolaHub community — the Discover feed plus posting and sharing. When off, HolaHub opens straight to the Marketplace for installing skills, apps, MCPs, and combos. Off by default."
        checked={discoverEnabled}
        onCheckedChange={setDiscoverEnabled}
      />
      <SettingsToggle
        label="Bossman agent"
        description="Add the experimental Bossman harness to the harness picker. It runs any model through the holaOS proxy. Off by default."
        checked={bossmanEnabled}
        onCheckedChange={setBossmanEnabled}
      />
      <SettingsToggle
        label="Cloud mode"
        description="Show the Local/Cloud switcher in the sidebar. When off, the switcher is hidden and the sidebar stays in Local mode. Off by default."
        checked={cloudModeEnabled}
        onCheckedChange={setCloudModeEnabled}
      />
    </SettingsCard>
  );
}
