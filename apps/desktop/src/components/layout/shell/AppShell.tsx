import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { EmployeeChatPane } from "@/features/employees/EmployeeChatPane";
import { EmployeeChatStreamManager } from "@/features/employees/EmployeeChatStreamManager";
import { selectedEmployeeAtom } from "./state/employees";
import { PanelLeftOpen } from "@/components/ui/icons";
import { useEffect, useRef } from "react";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
import {
  StoplightProvider,
  useStoplightCompensation,
} from "@/lib/StoplightContext";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import {
  useWorkspaceDesktop,
  WorkspaceDesktopProvider,
} from "@/lib/workspaceDesktop";
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
} from "@/lib/workspaceSelection";
import { BootSplash } from "@/components/layout/BootSplash";
import { BootGate } from "./BootGate";
import { AutomationsSurface, Center, SkillsTab } from "./Center";
import { ChannelsPane } from "@/components/panes/ChannelsPane";
import { CustomizePane } from "@/components/panes/CustomizePane";
import { SharePreviewPane } from "@/components/panes/ChatPane/SharePreviewPane";
import { ProfilesPane } from "@/components/panes/ProfilesPane";
import { RewardsPane } from "@/components/panes/RewardsPane";
import { ChatReturnBanner } from "./ChatReturnBanner";
import { WebAppSurfacePane } from "@/components/panes/WebAppSurfacePane";
import { ChatPanel } from "./ChatPanel";
import { ProjectsOverlay } from "@/components/projects/ProjectsOverlay";
import { OnboardingFlow } from "@/components/panes/ChatPane/onboarding/OnboardingFlow";
import { onboardingDismissedAtom } from "@/components/panes/ChatPane/onboarding/state";
import { OrgMembersPane } from "@/components/panes/OrgMembersPane";
import { NewIssueDialog } from "./NewIssueDialog";
import { NotificationStack } from "./NotificationStack";
import { HolaAppMarketplacePane } from "./HolaAppMarketplacePane";
import { Overlays } from "./Overlays";
import { SearchDialog } from "./SearchDialog";
import { Sidebar } from "./Sidebar";
import { UpdateReadyButton } from "./UpdateReadyButton";
import { modifierKeyLabel } from "./keyboardShortcuts";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
  makeIssueDetailTabId,
  workspaceSurfaceTab,
} from "./state/internalTabs";
import {
  chatPanelHiddenAtom,
  activeWebAppSurfaceAtom,
  browserViewSuspendedAtom,
  centerFullscreenAtom,
  DEFAULT_MAIN_VIEW_MODE_STORAGE_KEY,
  defaultMainViewModeAtom,
  collapseSidebarForAppSurfaceAtom,
  cloudSectionAtom,
  focusModeAtom,
  holahubPendingPathAtom,
  LEGACY_WORKSPACE_MAIN_VIEW_MODE_MAP_STORAGE_KEY,
  orgSwitchingAtom,
  projectViewAtom,
  publishOpenAtom,
  searchOpenAtom,
  selectedSessionIdAtom,
  shortcutsHelpOpenAtom,
  sidebarCollapsedAtom,
  effectiveSidebarModeAtom,
  workspaceOverlayAtom,
  type WorkspaceMainViewMode,
} from "./state/ui";
import { useOpenHolaAppClose } from "./useOpenHolaAppClose";
import { useStartNewChat } from "./useStartNewChat";
import { useWorkspaceCronjobs } from "./useWorkspaceLists";
import { HeadlessInstaller, InstallStatusResponder } from "./HeadlessInstaller";
import { IntegrationCredentialDialog } from "./IntegrationCredentialDialog";
import { useHostEmployeesChanged } from "./useHostEmployeesChanged";
import { useHostOpenApp } from "./useHostOpenApp";
import { useHostOpenChat } from "./useHostOpenChat";
import { useNotificationActivated } from "./useNotificationActivated";
import { TopChrome } from "./TopChrome";
import { type ChatLayout, useChatLayout } from "./useChatLayout";

export function AppShell() {
  return (
    <WorkspaceSelectionProvider>
      <WorkspaceDesktopProvider>
        <BootGate>
          <DesktopBillingProvider>
            <StoplightProvider value={true}>
              <AppShellContent />
            </StoplightProvider>
          </DesktopBillingProvider>
        </BootGate>
      </WorkspaceDesktopProvider>
    </WorkspaceSelectionProvider>
  );
}

// Keeps the workspace-overlay data warm from the always-mounted shell so
// opening Automations / Channels renders with data on the first frame instead
// of flashing a loading state. Projects + sessions are already kept warm by the
// sidebar (which renders them); cronjobs + channels have no such natural
// subscriber, so we mount lightweight ones here. Renders nothing.
function WorkspaceDataWarmers({ workspaceId }: { workspaceId: string | null }) {
  useWorkspaceCronjobs(workspaceId);
  useQuery(
    remoteApiQuery.channels.list.queryOptions({
      input: {},
      enabled: Boolean(workspaceId),
    }),
  );
  return null;
}

// Window during which post-focus tab-count growth is treated as hydration,
// not user action. 800ms is generous enough to absorb a couple of tab-state
// round-trips without being long enough that a quick ⌘T gets swallowed.
const AUTO_EXIT_GRACE_MS = 800;

function AppShellContent() {
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const collapseSidebarForAppSurface = useSetAtom(
    collapseSidebarForAppSurfaceAtom,
  );
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const reserveStoplightGutter = useStoplightCompensation();
  // Receive host-bridge chat.start requests from hosted web HolaApp surfaces.
  useHostOpenChat();
  // Receive host-bridge item.open requests (open an installed holaapp's surface).
  useHostOpenApp();
  // Refetch the sidebar employee roster when the /employees surface signals it
  // created/renamed/archived an employee (host-bridge employees.changed).
  useHostEmployeesChanged();
  // Clicking a native OS notification opens its specific session, not just Home.
  useNotificationActivated();
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { startNewChat } = useStartNewChat(selectedWorkspaceId);
  const { workspaces, hasHydratedWorkspaceList } = useWorkspaceDesktop();
  const [publishOpen, setPublishOpen] = useAtom(publishOpenAtom);
  const hasWorkspaces = workspaces.length > 0;
  const onboardingDismissed = useAtomValue(onboardingDismissedAtom);
  const layout = useChatLayout();
  const projectView = useAtomValue(projectViewAtom);
  const workspaceOverlay = useAtomValue(workspaceOverlayAtom);
  // Reads the EFFECTIVE mode, not the persisted one. Cloud mode is gone from the
  // UI, but sidebarModeAtom is persisted — a user who tried it still has
  // "employee" on disk, and acting on that here would point Home at the employee
  // surface while the sidebar shows Local, with no switcher to escape.
  const sidebarMode = useAtomValue(effectiveSidebarModeAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  // The sidebar mode persists across launches but the workspace overlay always
  // defaults to Home = "holahub" (Local's Home). If we relaunched into Employee
  // mode, that leaves the sidebar on Employee while the main area shows Local's
  // HolaHub Home. "holahub" is never a valid overlay in Employee mode, so point
  // Home at the employee surface whenever we observe that mismatch (also covers
  // async mode-atom hydration). Cleared to null the moment a chat/session opens,
  // so this only fixes the initial screen.
  useEffect(() => {
    if (sidebarMode === "employee") {
      setWorkspaceOverlay((current) =>
        current === "holahub" ? "holaemployee" : current,
      );
    }
  }, [sidebarMode, setWorkspaceOverlay]);
  const [focusMode, setFocusMode] = useAtom(focusModeAtom);
  const [defaultMainViewMode, setDefaultMainViewMode] = useAtom(
    defaultMainViewModeAtom,
  );
  const internalTabs = useAtomValue(internalTabsAtom);
  const activeInternalTabId = useAtomValue(activeInternalTabIdAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  // The in-app browser is retired; the center column now hosts only internal
  // (file/image/…) tabs and the app-surface.
  const totalTabs = internalTabs.length;
  const activeWebAppSurface = useAtomValue(activeWebAppSurfaceAtom);
  // The middle column only exists to host open content. With nothing open
  // there — no tabs, no app surface — collapse straight to chat instead of a
  // workspace welcome screen. (Overlays like Projects/Automations short-circuit
  // ShellMainArea earlier, so they're unaffected.)
  const hasCenterContent = totalTabs > 0 || Boolean(activeWebAppSurface);
  const [centerFullscreen, setCenterFullscreen] = useAtom(centerFullscreenAtom);
  // Fullscreen only makes sense while the middle column has something to show.
  useEffect(() => {
    if (centerFullscreen && !hasCenterContent) {
      setCenterFullscreen(false);
    }
  }, [centerFullscreen, hasCenterContent, setCenterFullscreen]);
  // A HolaApp surface takes over the center column, so collapse the sidebar on
  // open to give the app the room. Fires only on the transition TO a HolaApp
  // (opening one, or switching between apps) — not while one stays open, and
  // not on close — so if the user re-expands the sidebar it stays put. The
  // floating expand affordance keeps it one click away. This collapse is
  // transient (not persisted), so quitting with an app open never leaves the
  // sidebar hidden on the next launch — the app surface isn't restored.
  const prevWebAppIdRef = useRef<string | null>(
    activeWebAppSurface?.holaAppId ?? null,
  );
  useEffect(() => {
    const currentWebAppId = activeWebAppSurface?.holaAppId ?? null;
    const openedWebApp =
      currentWebAppId !== null && currentWebAppId !== prevWebAppIdRef.current;
    prevWebAppIdRef.current = currentWebAppId;
    if (openedWebApp) {
      collapseSidebarForAppSurface();
    }
  }, [activeWebAppSurface, collapseSidebarForAppSurface]);
  const prevTotalTabsRef = useRef(totalTabs);
  const prevFocusModeRef = useRef(focusMode);
  // Timestamp of the most recent focusMode false → true transition. Used as
  // a grace window inside the auto-exit-focus effect so async tab hydration
  // immediately after entering focus doesn't get misread as a "user opened
  // a tab" signal.
  const focusEnteredAtRef = useRef<number | null>(
    focusMode ? Date.now() : null,
  );
  const seededMainViewWorkspaceIdRef = useRef<string | null>(null);
  const prevSelectedWorkspaceIdRef = useRef<string | null>(selectedWorkspaceId);

  // Seed focusMode from the workspace's stored main-view preference whenever
  // the user switches to a workspace we haven't seeded yet this session.
  // Re-seeding on every activation would clobber the in-session focus
  // toggle, so we track which workspace id we've already applied. The
  // choice is now a single user-level preference (defaultMainViewMode)
  // — every workspace opens to the same default; the in-session focus
  // toggle still wins until the user navigates away and back.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (seededMainViewWorkspaceIdRef.current === selectedWorkspaceId) return;
    seededMainViewWorkspaceIdRef.current = selectedWorkspaceId;
    if (defaultMainViewMode === "chat" && !focusMode) {
      setFocusMode(true);
    } else if (defaultMainViewMode === "workspace" && focusMode) {
      setFocusMode(false);
    }
  }, [selectedWorkspaceId, defaultMainViewMode, focusMode, setFocusMode]);

  // One-shot migration: if the new user-level key isn't in localStorage
  // but the legacy per-workspace map has entries, pick the majority
  // mode and write it as the new default. Runs once on mount; ties go
  // to "chat" (the atom's default). After this, the legacy atom is
  // unused — slated for removal in a follow-up.
  useEffect(() => {
    try {
      if (localStorage.getItem(DEFAULT_MAIN_VIEW_MODE_STORAGE_KEY) !== null) {
        return;
      }
      const raw = localStorage.getItem(
        LEGACY_WORKSPACE_MAIN_VIEW_MODE_MAP_STORAGE_KEY,
      );
      if (!raw) return;
      const oldMap = JSON.parse(raw) as Record<string, unknown>;
      let chat = 0;
      let workspace = 0;
      for (const value of Object.values(oldMap)) {
        if (value === "chat") chat += 1;
        else if (value === "workspace") workspace += 1;
      }
      if (chat === 0 && workspace === 0) return;
      const winner: WorkspaceMainViewMode =
        workspace > chat ? "workspace" : "chat";
      setDefaultMainViewMode(winner);
    } catch {
      // Malformed legacy data — leave the new atom at its default.
    }
  }, [setDefaultMainViewMode]);

  // Open tabs are now scoped to the active session (see internalTabsAtom), so
  // switching workspace/session automatically shows that session's own tabs
  // and restores them on return — no manual clear needed.

  useEffect(() => {
    const normalizedSelectedWorkspaceId = selectedWorkspaceId?.trim() || "";
    if (!normalizedSelectedWorkspaceId || internalTabs.length === 0) {
      return;
    }

    let didRepairTab = false;
    let nextActiveInternalTabId = activeInternalTabId;
    const repairedTabs: typeof internalTabs = [];

    for (const tab of internalTabs) {
      let nextTab = tab;
      if ("workspaceId" in tab && !tab.workspaceId.trim()) {
        didRepairTab = true;
        nextTab =
          tab.kind === "issue_detail"
            ? {
                ...tab,
                id: makeIssueDetailTabId(
                  normalizedSelectedWorkspaceId,
                  tab.issueId,
                ),
                workspaceId: normalizedSelectedWorkspaceId,
              }
            : tab.kind === "automations" || tab.kind === "skills"
              ? workspaceSurfaceTab(tab.kind, normalizedSelectedWorkspaceId)
              : workspaceSurfaceTab(
                  "automations",
                  normalizedSelectedWorkspaceId,
                );
        if (tab.id === activeInternalTabId) {
          nextActiveInternalTabId = nextTab.id;
        }
      }
      if (!repairedTabs.some((entry) => entry.id === nextTab.id)) {
        repairedTabs.push(nextTab);
      }
    }

    if (!didRepairTab) {
      return;
    }

    setInternalTabs(repairedTabs);
    if (nextActiveInternalTabId !== activeInternalTabId) {
      setActiveInternalTabId(nextActiveInternalTabId);
    }
  }, [
    activeInternalTabId,
    internalTabs,
    selectedWorkspaceId,
    setActiveInternalTabId,
    setInternalTabs,
  ]);

  // Auto-exit focus when a new tab appears (⌘T, chat link, sidebar app).
  // Opening a tab is an explicit "show me this" signal; staying hidden
  // would be confusing.
  //
  // Rebase triggers + grace window:
  // 1. Workspace switch — a cross-workspace tab-count comparison would
  //    falsely trip auto-exit on any newly-created chat-mode workspace
  //    whose tab list differs from the previous one.
  // 2. focusMode false → true edge — the moment focus is *entered* is the
  //    correct baseline for "did a tab appear after I entered focus?".
  // 3. AUTO_EXIT_GRACE_MS after a focus-entry, any totalTabs increase is
  //    treated as residual hydration (the runtime pushing default-opened
  //    internal tabs, etc.) rather
  //    than a user action. Without this, picking Chat Mode during workspace
  //    creation gets clobbered the moment an async tab settles in, because
  //    the post-rebase baseline was captured before hydration had any
  //    chance to flush.
  useEffect(() => {
    const workspaceSwitched =
      prevSelectedWorkspaceIdRef.current !== selectedWorkspaceId;
    const focusModeEntered =
      prevFocusModeRef.current === false && focusMode === true;
    if (workspaceSwitched || focusModeEntered) {
      if (focusMode) {
        focusEnteredAtRef.current = Date.now();
      }
      prevSelectedWorkspaceIdRef.current = selectedWorkspaceId;
      prevTotalTabsRef.current = totalTabs;
      prevFocusModeRef.current = focusMode;
      return;
    }
    const inGraceWindow =
      focusEnteredAtRef.current !== null &&
      Date.now() - focusEnteredAtRef.current < AUTO_EXIT_GRACE_MS;
    if (
      focusMode &&
      !inGraceWindow &&
      totalTabs > prevTotalTabsRef.current
    ) {
      setFocusMode(false);
    }
    prevTotalTabsRef.current = totalTabs;
    prevFocusModeRef.current = focusMode;
  }, [focusMode, totalTabs, selectedWorkspaceId, setFocusMode]);

  const setShortcutsHelpOpen = useSetAtom(shortcutsHelpOpenAtom);
  const setChatPanelHidden = useSetAtom(chatPanelHiddenAtom);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const centerFullscreenRef = useRef(centerFullscreen);
  centerFullscreenRef.current = centerFullscreen;
  const startNewChatRef = useRef(startNewChat);
  startNewChatRef.current = startNewChat;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        centerFullscreenRef.current &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        setCenterFullscreen(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void startNewChatRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.code === "Period"
      ) {
        // ⌘⇧. hides / reveals the chat panel in split mode. Gated to split
        // so it can't hide both columns at once (focus mode IS chat-only).
        e.preventDefault();
        if (!focusModeRef.current) {
          setChatPanelHidden((prev) => !prev);
        }
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === ".") {
        // ⌘. toggles chat-only / split layout. We picked period (not ⌘T,
        // which is New tab) so the binding doesn't collide with the
        // dominant tab-strip shortcut.
        e.preventDefault();
        setFocusMode((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        // ⌘/ opens the keyboard shortcuts cheatsheet — Slack / Notion
        // / VS Code convention. We initially tried bare "?" (GitHub
        // pattern) but the chat composer's textarea is almost always
        // focused inside the workspace, which made the editable-target
        // guard swallow the keystroke 100% of the time. ⌘/ works
        // regardless of focus.
        e.preventDefault();
        setShortcutsHelpOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    setFocusMode,
    setSearchOpen,
    setSidebarCollapsed,
    setShortcutsHelpOpen,
    setChatPanelHidden,
    setCenterFullscreen,
  ]);

  if (hasHydratedWorkspaceList && !onboardingDismissed) {
    // Full-window takeover for true first-launch. OnboardingFlow owns
    // its own brand chrome + sign-out, so this is just the mount point.
    // Must precede the "no workspaces" gate below because stage 2 of
    // onboarding is what creates the first workspace.
    return <OnboardingFlow />;
  }

  if (hasHydratedWorkspaceList && !hasWorkspaces) {
    // Single-workspace world: the server lazily provisions a workspace
    // on the first GET /api/v1/workspaces, so a hydrated-but-empty list
    // is only ever transient (or a degenerate failure case if the
    // server fallback caught a path/permission error). Show a quiet
    // "setting up" placeholder rather than a folder/name form — in the
    // single-tenant model the user is never asked to create a workspace.
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground antialiased">
        <div className="text-sm text-muted-foreground">
          Setting up your workspace…
        </div>
      </div>
    );
  }

  const effectiveLayout: ChatLayout =
    layout === "focus" || !hasCenterContent ? "focus" : "split";
  const showMiddle = effectiveLayout === "split" || centerFullscreen;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden text-foreground antialiased">
      {centerFullscreen ? null : <Sidebar />}
      <ShellMainArea
        layout={effectiveLayout}
        showMiddle={showMiddle}
        centerFullscreen={centerFullscreen}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {sidebarCollapsed && !centerFullscreen ? (
        <div
          className={cn(
            "absolute top-0 z-40 flex h-10 items-center gap-1",
            reserveStoplightGutter ? "left-20" : "left-2",
          )}
        >
          <UpdateReadyButton />
          <button
            type="button"
            aria-label="Expand sidebar"
            title={`Expand sidebar (${modifierKeyLabel()}\\)`}
            onClick={() => setSidebarCollapsed(false)}
            className="window-no-drag grid size-7 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <PanelLeftOpen className="size-3.5" />
          </button>
        </div>
      ) : null}
      <WorkspaceDataWarmers workspaceId={selectedWorkspaceId || null} />
      {/* Smooth HolaHub install: install keyless items in place, route keyed
          ones to the native connect surface, reply to the invoking hub page. */}
      <HeadlessInstaller workspaceId={selectedWorkspaceId || null} />
      {/* Answers the host `install.status` op so hub pages can show "Installed". */}
      <InstallStatusResponder workspaceId={selectedWorkspaceId || null} />
      {/* Collects the user's own key for toolkits Composio has no managed auth
          for, whichever surface started the connect. */}
      <IntegrationCredentialDialog />
      <EmployeeChatStreamManager />
      <NewIssueDialog />
      <SearchDialog />
      <Overlays />
      <NotificationStack />
      {selectedWorkspaceId ? (
        <PublishScreen
          open={publishOpen}
          onOpenChange={setPublishOpen}
          onViewSubmission={() => {
            // Settings flow not wired in new shell yet; deferred to a
            // later step when SettingsScreenRoot is shared between shells.
          }}
          workspaceId={selectedWorkspaceId}
        />
      ) : null}
      <OrgSwitchOverlay />
    </div>
  );
}

// Full-screen loading page shown while the active organization is switched, so
// the app re-scopes behind one clear transition. Covers the whole DOM; the
// switch handler also drops any open web-app surface first (a DOM overlay can't
// paint over a native BrowserView).
function OrgSwitchOverlay() {
  const switching = useAtomValue(orgSwitchingAtom);
  if (!switching) {
    return null;
  }
  const message = switching.toPersonal
    ? "Returning to your personal workspace…"
    : `Switching to ${switching.orgName ?? "your organization"}…`;
  return <BootSplash message={message} />;
}

/**
 * Right-of-sidebar content. Normally renders the center pane (TopChrome +
 * Center) plus the right ChatPanel. When `projectViewAtom` or
 * `workspaceOverlayAtom` is set, the entire window is replaced by the
 * corresponding overlay (sidebar included) — opening Projects / Automations /
 * Customize is a full-window takeover with its own back affordance.
 */
function ShellMainArea({
  layout,
  showMiddle,
  centerFullscreen,
  selectedWorkspaceId,
}: {
  layout: ChatLayout;
  showMiddle: boolean;
  centerFullscreen: boolean;
  selectedWorkspaceId: string;
}) {
  const projectView = useAtomValue(projectViewAtom);
  const [workspaceOverlay, setWorkspaceOverlay] = useAtom(workspaceOverlayAtom);
  const holahubPendingPath = useAtomValue(holahubPendingPathAtom);
  const cloudSection = useAtomValue(cloudSectionAtom);
  const activeWebAppSurface = useAtomValue(activeWebAppSurfaceAtom);
  const closeHolaApp = useOpenHolaAppClose();
  const browserViewSuspended = useAtomValue(browserViewSuspendedAtom);
  const selectedEmployee = useAtomValue(selectedEmployeeAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);
  // Employee chat and the other primary surfaces are mutually exclusive: opening
  // an overlay / project view / HolaApp surface drops the selected employee (the
  // sidebar clears these when selecting an employee — this is the reverse).
  useEffect(() => {
    if (
      selectedEmployee &&
      (projectView || workspaceOverlay || activeWebAppSurface)
    ) {
      setSelectedEmployee(null);
    }
  }, [
    selectedEmployee,
    projectView,
    workspaceOverlay,
    activeWebAppSurface,
    setSelectedEmployee,
  ]);
  // Picking a runtime session (a General session, "New chat", a host-opened
  // chat) also leaves the employee chat. selectedSessionId is always truthy, so
  // detect a CHANGE rather than presence.
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const prevSelectedSessionIdRef = useRef(selectedSessionId);
  useEffect(() => {
    const changed = prevSelectedSessionIdRef.current !== selectedSessionId;
    prevSelectedSessionIdRef.current = selectedSessionId;
    if (changed && selectedEmployee) {
      setSelectedEmployee(null);
    }
  }, [selectedSessionId, selectedEmployee, setSelectedEmployee]);
  if (projectView) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <ProjectsOverlay workspaceId={selectedWorkspaceId || null} />
      </div>
    );
  }
  if (workspaceOverlay && selectedWorkspaceId) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {workspaceOverlay === "automations" ? (
          <AutomationsSurface workspaceId={selectedWorkspaceId} />
        ) : workspaceOverlay === "channels" ? (
          <ChannelsPane />
        ) : workspaceOverlay === "customize" ? (
          <CustomizePane workspaceId={selectedWorkspaceId} />
        ) : workspaceOverlay === "skills" ? (
          <SkillsTab workspaceId={selectedWorkspaceId} />
        ) : workspaceOverlay === "profiles" ? (
          <ProfilesPane />
        ) : workspaceOverlay === "apps" ? (
          <HolaAppMarketplacePane />
        ) : workspaceOverlay === "members" ? (
          <OrgMembersPane />
        ) : workspaceOverlay === "holaemployee" ? (
          // HolaEmployee is a first-class surface, not a HolaApp: same native
          // BrowserView web surface, but chromeless + full-width with the sidebar
          // as its exit (exactly like Home) rather than the center-column app
          // chrome (header/refresh/close + a side chat panel). Keeps holaAppId
          // "holaemployee" so the main process routes it to /employees as before.
          <WebAppSurfacePane
            chromeless
            holaAppId="holaemployee"
            onClose={() => setWorkspaceOverlay(null)}
            // The desktop Cloud rail drives the web Cloud Home's section via a
            // ?section= suffix (Home = the default /employees, no suffix). The web
            // page hides its own left nav in the desktop, so this is the only nav.
            // "catalog" is a distinct route (/employees/catalog), not a section —
            // pass it as a path suffix (a real navigation, not a query swap).
            path={
              cloudSection === "home"
                ? undefined
                : cloudSection === "catalog"
                  ? "/catalog"
                  : `?section=${cloudSection}`
            }
            // The Cloud Home reads ?section= client-side (useSearchParams), so
            // switch sections via history.pushState on the warm surface instead of
            // reloading — instant, no flash.
            queryDriven
            suspendNativeView={browserViewSuspended}
            title="HolaEmployee"
          />
        ) : workspaceOverlay === "rewards" ? (
          <RewardsPane />
        ) : workspaceOverlay === "holahub" ? (
          // HolaHub is a hosted web surface on its own subdomain (hub.holaos.ai /
          // hub.imerchstaging.com — the main process routes the "holahub" surface
          // to HUB_APP_BASE_URL). As a workspace overlay it takes the whole main
          // area (sidebar kept, no chat panel) — like Customize/Browsers —
          // hosting the same native BrowserView web HolaApps use, so the
          // Better-Auth session carries in.
          <WebAppSurfacePane
            chromeless
            holaAppId="holahub"
            onClose={() => setWorkspaceOverlay(null)}
            path={holahubPendingPath ?? undefined}
            // HolaHub is a single SPA: navigate its routes (a share → /compose,
            // an agent deep-link → /threads/:id) client-side instead of cold-
            // reloading the BrowserView, so re-shares don't flash "Opening…".
            queryDriven
            suspendNativeView={browserViewSuspended}
            title="Discover"
          />
        ) : workspaceOverlay === "holahub-share" ? (
          <SharePreviewPane />
        ) : null}
      </div>
    );
  }
  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-col bg-background",
          showMiddle ? "flex-1" : "hidden",
        )}
      >
        {activeWebAppSurface ? (
          <WebAppSurfacePane
            holaAppId={activeWebAppSurface.holaAppId}
            onClose={closeHolaApp}
            path={activeWebAppSurface.path}
            suspendNativeView={browserViewSuspended}
            title={activeWebAppSurface.title}
            url={activeWebAppSurface.url}
          />
        ) : (
          <>
            <ChatReturnBanner />
            <TopChrome />
            <Center />
          </>
        )}
      </div>
      {centerFullscreen ? null : selectedEmployee ? (
        <div className="flex min-w-0 flex-1 flex-col border-l">
          <EmployeeChatPane
            employeeId={selectedEmployee.employeeId}
            employeeName={selectedEmployee.name}
            isNew={selectedEmployee.isNew}
            threadId={selectedEmployee.threadId}
          />
        </div>
      ) : (
        <ChatPanel layout={layout} />
      )}
    </>
  );
}

