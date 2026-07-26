import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { listAllIntegrationConnections } from "@/lib/listAllIntegrationConnections";
import { ChevronRight, Plug, Search } from "@/components/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OutputArtifactIcon } from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { FileTypeIcon } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { SkillsPane } from "@/components/panes/SkillsPane";
import { FilePreviewPane } from "./FilePreviewPane";
import { useStartChatDraft } from "./useStartChatDraft";
import { useStartSkillCreation } from "./useStartSkillCreation";
import { IssueDetailPane } from "./IssueDetailPane";
import { modifierKeyLabel } from "./keyboardShortcuts";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import { recentFilesAtom } from "./state/recentFiles";
import { searchOpenAtom } from "./state/ui";
import { useOpenDiscover } from "./useOpenDiscover";
import { useWorkspaceArtifacts } from "./useWorkspaceLists";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

export function Center() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [activeInternalTabId, setActiveInternalTabId] = useAtom(
    activeInternalTabIdAtom,
  );
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const activeInternal = activeInternalTabId
    ? internalTabs.find((t) => t.id === activeInternalTabId) ?? null
    : null;
  const fallbackWorkspaceId = selectedWorkspaceId?.trim() || "";
  const resolvedActiveWorkspaceId =
    activeInternal && "workspaceId" in activeInternal
      ? activeInternal.workspaceId.trim() || fallbackWorkspaceId
      : fallbackWorkspaceId;

  // Land on the most recent internal (file/image/…) tab when none is active,
  // so the center column shows a tab rather than the landing while tabs exist.
  useEffect(() => {
    if (activeInternalTabId === null && internalTabs.length > 0) {
      const fallback = internalTabs[internalTabs.length - 1];
      setActiveInternalTabId(fallback.id);
    }
  }, [activeInternalTabId, internalTabs, setActiveInternalTabId]);

  const closeActiveInternalTab = useCallback(() => {
    if (!activeInternalTabId) return;
    setInternalTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeInternalTabId);
      const next = prev.filter((t) => t.id !== activeInternalTabId);
      const fallback = next[idx - 1] ?? next[0] ?? null;
      setActiveInternalTabId(fallback?.id ?? null);
      return next;
    });
  }, [activeInternalTabId, setActiveInternalTabId, setInternalTabs]);

  return (
    <main className="flex min-w-[480px] flex-1 flex-col overflow-hidden">
      {activeInternal ? (
        activeInternal.kind === "image" ? (
          <EphemeralImagePane
            dataUrl={activeInternal.dataUrl}
            name={activeInternal.label}
          />
        ) : activeInternal.kind === "file" ? (
          <FilePreviewPane
            filePath={activeInternal.filePath}
            onClose={closeActiveInternalTab}
          />
        ) : activeInternal.kind === "issue_detail" ? (
          <IssueDetailPane
            workspaceId={resolvedActiveWorkspaceId}
            issueId={activeInternal.issueId}
          />
        ) : activeInternal.kind === "automations" ? (
          <AutomationsSurface workspaceId={activeInternal.workspaceId} />
        ) : activeInternal.kind === "skills" ? (
          <SkillsTab workspaceId={activeInternal.workspaceId} />
        ) : (
          <NewTabLanding />
        )
      ) : (
        <NewTabLanding />
      )}
    </main>
  );
}

export function SkillsTab({ workspaceId }: { workspaceId: string }) {
  const startSkillCreation = useStartSkillCreation();
  const startChatDraft = useStartChatDraft();

  return (
    <SkillsPane
      fullSurface
      onCreateSkill={startSkillCreation}
      onTryWithAgent={(skillId) =>
        startChatDraft(`/${skillId}\n`, { returnTo: "skills" })
      }
      workspaceId={workspaceId || null}
    />
  );
}

function EphemeralImagePane({
  dataUrl,
  name,
}: {
  dataUrl: string;
  name: string;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
      <img
        src={dataUrl}
        alt={name}
        className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
      />
    </div>
  );
}

interface WorkspaceLandingStats {
  apps: number;
  /** null while loading or on IPC error — never zero-fallback. */
  integrations: number | null;
}

// Lazy-fetch the two counts the landing page displays. Kept local
// because useWorkspaceDesktop doesn't expose live connection
// state and dragging it into the global provider just to power one
// muted line of text isn't worth the coupling.
function useWorkspaceLandingStats(
  workspaceId: string | null,
): WorkspaceLandingStats {
  const { installedApps } = useWorkspaceDesktop();
  const [integrationCount, setIntegrationCount] = useState<number | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void listAllIntegrationConnections()
      .then((r) => {
        if (!cancelled) {
          setIntegrationCount(
            r.connections.filter((c) => c.status === "active").length,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setIntegrationCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return {
    apps: installedApps.length,
    integrations: integrationCount,
  };
}

function NewTabLanding() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { workspaces } = useWorkspaceDesktop();
  const openSearch = useSetAtom(searchOpenAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const openDiscover = useOpenDiscover();
  const recentFiles = useAtomValue(recentFilesAtom);

  const workspaceName = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? "",
    [selectedWorkspaceId, workspaces],
  );

  const stats = useWorkspaceLandingStats(selectedWorkspaceId);

  const workspaceRecentFiles = useMemo(() => {
    return recentFiles
      .filter((f) => f.workspaceId === selectedWorkspaceId)
      .slice(0, 5);
  }, [recentFiles, selectedWorkspaceId]);

  const workspaceOutputs = useWorkspaceArtifacts(
    selectedWorkspaceId || null,
    { limit: 50 },
  );
  const recentActivity = useMemo(() => {
    return [...workspaceOutputs]
      .sort((a, b) => {
        const aTime = Date.parse(a.created_at) || 0;
        const bTime = Date.parse(b.created_at) || 0;
        return bTime - aTime;
      })
      .slice(0, 5);
  }, [workspaceOutputs]);
  const { openOutput } = useOpenWorkspaceOutput();

  const openFileTab = useCallback(
    (filePath: string, label: string) => {
      const tab = {
        id: makeInternalTabId(),
        kind: "file" as const,
        filePath,
        label,
      };
      setInternalTabs((prev) => {
        const existing = prev.find((t) => t.kind === "file" && t.filePath === filePath);
        if (existing) {
          setActiveInternalTabId(existing.id);
          return prev;
        }
        setActiveInternalTabId(tab.id);
        return [...prev, tab];
      });
    },
    [setActiveInternalTabId, setInternalTabs],
  );

  const handleConnectIntegration = useCallback(() => {
    openDiscover("/marketplace?type=integration");
  }, [openDiscover]);

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-auto">
      <div className="flex w-full max-w-xl flex-col gap-12 px-8 pt-[14vh] pb-16">
        {/* Identity — eyebrow + workspace name + minimal stats. The stats
            line stays hidden until at least one count is positive, so a
            fresh workspace breathes instead of advertising its emptiness. */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase text-foreground/40">
            Workspace
          </div>
          <div className="truncate text-xl font-medium text-foreground">
            {workspaceName || "Untitled workspace"}
          </div>
          <WorkspaceStatsLine stats={stats} />
        </div>

        {/* Quick actions — compact, browser-native muscle memory. */}
        <div className="space-y-2.5">
          <SectionLabel>Quick actions</SectionLabel>
          <ActionTile
            icon={<Search className="size-3.5" strokeWidth={1.75} />}
            label="Search"
            hint={`${modifierKeyLabel()}K`}
            onClick={() => openSearch(true)}
          />
        </div>

        {/* Build your workspace — the onboarding moment. Each card opens
            the right path: prefilled chat for app/workflow execution,
            or a direct settings jump for integrations. */}
        <div className="space-y-2.5">
          <SectionLabel>Build your workspace</SectionLabel>
          <div className="space-y-1.5">
            <BuildCard
              icon={<Plug className="size-4" strokeWidth={1.75} />}
              label="Connect an integration"
              description="Give the agent access to your tools."
              tone="violet"
              onClick={handleConnectIntegration}
            />
          </div>
        </div>

        {recentActivity.length > 0 || workspaceRecentFiles.length > 0 ? (
          <div className="space-y-6">
            {recentActivity.length > 0 ? (
              <RecentSection title="Recent activity">
                {recentActivity.map((output) => (
                  <RecentRow
                    key={output.id}
                    icon={
                      <OutputArtifactIcon
                        output={output}
                        size="sm"
                        variant="bare"
                      />
                    }
                    primary={
                      output.title?.trim() ||
                      (output.file_path
                        ? fileNameFromPath(output.file_path)
                        : "Untitled output")
                    }
                    secondary={relativeTimeShort(output.created_at)}
                    onClick={() => {
                      void openOutput(output);
                    }}
                  />
                ))}
              </RecentSection>
            ) : null}

            {workspaceRecentFiles.length > 0 ? (
              <RecentSection title="Recent files">
                {workspaceRecentFiles.map((file) => (
                  <RecentRow
                    key={file.id}
                    icon={
                      <FileTypeIcon
                        filePath={file.filePath}
                        size={14}
                        className="shrink-0 text-foreground/55"
                      />
                    }
                    primary={file.label || fileNameFromPath(file.filePath)}
                    secondary={file.filePath}
                    onClick={() =>
                      openFileTab(
                        file.filePath,
                        file.label || fileNameFromPath(file.filePath),
                      )
                    }
                  />
                ))}
              </RecentSection>
            ) : null}

          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionTile({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-2.5 rounded-md border border-border/70 bg-background px-3 py-2.5 text-left transition-colors duration-snappy ease-out-expo",
        "hover:border-border hover:bg-foreground/[0.025]",
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-foreground/65 transition-colors group-hover:bg-foreground/[0.09] group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
        {label}
      </span>
      {hint ? (
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-foreground/35">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

type BuildCardTone = "amber" | "emerald" | "violet";

const BUILD_CARD_TONE_STYLES: Record<
  BuildCardTone,
  { wrap: string; icon: string }
> = {
  amber: {
    wrap: "bg-amber-500/10 group-hover:bg-amber-500/15",
    icon: "text-amber-600 dark:text-amber-400",
  },
  emerald: {
    wrap: "bg-emerald-500/10 group-hover:bg-emerald-500/15",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  violet: {
    wrap: "bg-violet-500/10 group-hover:bg-violet-500/15",
    icon: "text-violet-600 dark:text-violet-400",
  },
};

function BuildCard({
  icon,
  label,
  description,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  tone: BuildCardTone;
  onClick: () => void;
}) {
  const toneStyles = BUILD_CARD_TONE_STYLES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-left transition-colors duration-snappy ease-out-expo",
        "hover:border-border hover:bg-foreground/[0.025]",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md transition-colors",
          toneStyles.wrap,
          toneStyles.icon,
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="truncate text-[11px] text-foreground/50">
          {description}
        </span>
      </span>
      <ChevronRight
        className="size-3.5 shrink-0 text-foreground/30 opacity-0 transition-opacity duration-snappy ease-out-expo group-hover:opacity-100 group-focus-visible:opacity-100"
        strokeWidth={1.75}
      />
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 text-[10px] font-medium uppercase text-foreground/40">
      {children}
    </div>
  );
}

function WorkspaceStatsLine({ stats }: { stats: WorkspaceLandingStats }) {
  // Only render slices we know about (non-null) AND that count > 0. A
  // fresh workspace renders nothing here — the breathing room flows the
  // eye down to the Build section, which is the real CTA.
  const parts: string[] = [];
  if (stats.apps > 0) {
    parts.push(pluralize(stats.apps, "app", "apps"));
  }
  if (stats.integrations !== null && stats.integrations > 0) {
    parts.push(pluralize(stats.integrations, "integration", "integrations"));
  }
  if (parts.length === 0) return null;
  return (
    <div className="text-[11px] text-foreground/45">{parts.join(" · ")}</div>
  );
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function RecentSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="px-1 text-[10px] font-medium uppercase text-foreground/40">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function RecentRow({
  icon,
  primary,
  secondary,
  onClick,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-snappy ease-out-expo hover:bg-foreground/[0.04]"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
        {primary}
      </span>
      <span className="hidden shrink-0 truncate text-[11px] text-foreground/40 sm:inline-block sm:max-w-[40%]">
        {secondary}
      </span>
    </button>
  );
}

function relativeTimeShort(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "";
  const ms = Date.now() - Date.parse(normalized);
  if (Number.isNaN(ms)) return "";
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(normalized).toLocaleDateString();
}

// Wraps AutomationsPane with the Create / Edit schedule → chat-composer
// prefill loop: a fresh requestKey per fire so back-to-back prefills
// re-trigger, mode "replace" since the user is starting a fresh refine
// turn, sessionMode "preserve" so the schedule intent threads into the
// active conversation instead of forking a new draft.
export function AutomationsSurface({ workspaceId }: { workspaceId: string }) {
  // Automation creation lives entirely in AutomationsPane's "New automation"
  // menu: "Create with Hola" opens a guided chat draft
  // (useStartAutomationCreation) and "Set up manually" opens the form dialog.
  return <AutomationsPane workspaceId={workspaceId} />;
}
