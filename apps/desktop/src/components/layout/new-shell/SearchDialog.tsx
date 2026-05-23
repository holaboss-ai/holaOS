import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom } from "jotai";
import {
  AppWindow,
  Check,
  CornerDownLeft,
  FileText,
  Globe,
  Inbox,
  LayoutDashboard,
  Package,
  Plus,
  Settings,
  Store,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  automationsOpenAtom,
  chatPanelViewAtom,
  createWorkspaceOpenAtom,
  marketplaceOpenAtom,
  newTabOpenAtom,
  searchOpenAtom,
  settingsOpenAtom,
  sidebarSectionAtom,
} from "./state/ui";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function SearchDialog() {
  const [open, setOpen] = useAtom(searchOpenAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "var(--duration-snappy)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[18%] left-1/2 z-[100] w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "var(--duration-base)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        >
          {open ? <SearchContent onSelect={() => setOpen(false)} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SearchContent({ onSelect }: { onSelect: () => void }) {
  const { workspaces, selectedWorkspace } = useWorkspaceDesktop();
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const { browserState: userBrowser } = useWorkspaceBrowser("user");
  const setNewTabOpen = useSetAtom(newTabOpenAtom);
  const setSidebarSection = useSetAtom(sidebarSectionAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setMarketplaceOpen = useSetAtom(marketplaceOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);

  const close = onSelect;
  const wrap = (action: () => void) => () => {
    close();
    action();
  };

  const agentTabCount = userBrowser.tabCounts.agent;

  return (
    <Command className="bg-transparent">
      <CommandInput placeholder="Search tabs, workspaces, actions..." />
      <CommandList className="max-h-[460px] px-1.5 pt-1 pb-2">
        <CommandEmpty>No matches.</CommandEmpty>

        {userBrowser.tabs.length > 0 ? (
          <CommandGroup heading="Tabs">
            {userBrowser.tabs.map((tab) => (
              <TabRow
                key={`user-${tab.id}`}
                tab={tab}
                onSelect={wrap(async () => {
                  if (selectedWorkspaceId) {
                    await window.electronAPI.browser.setActiveWorkspace(
                      selectedWorkspaceId,
                      "user",
                    );
                  }
                  await window.electronAPI.browser.setActiveTab(tab.id);
                })}
              />
            ))}
          </CommandGroup>
        ) : null}

        {agentTabCount > 0 ? (
          <AgentTabsGroup
            onClose={close}
            workspaceId={selectedWorkspaceId || null}
          />
        ) : null}

        {workspaces.length > 1 ? (
          <CommandGroup heading="Workspaces">
            {workspaces.map((w) => (
              <CommandItem
                key={`ws-${w.id}`}
                value={`workspace:${w.id} ${w.name}`}
                onSelect={wrap(() => setSelectedWorkspaceId(w.id))}
                className="group/cmd-item gap-2.5 py-1.5"
              >
                <WorkspaceIcon
                  workspace={w}
                  size="xs"
                  className="ring-1 ring-foreground/10"
                />
                <span className="flex-1 truncate text-sm">{w.name}</span>
                {w.id === selectedWorkspace?.id ? (
                  <Check className="size-3.5 text-foreground/40" />
                ) : (
                  <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Actions">
          <ActionItem
            label="New tab"
            shortcut="⌘T"
            icon={<Plus />}
            onSelect={wrap(() => setNewTabOpen(true))}
          />
          <ActionItem
            label="Open Inbox"
            icon={<Inbox />}
            onSelect={wrap(() => setSidebarSection("inbox"))}
          />
          <ActionItem
            label="Open Artifacts"
            icon={<Package />}
            onSelect={wrap(() => setSidebarSection("artifacts"))}
          />
          <ActionItem
            label="Open Automations"
            icon={<LayoutDashboard />}
            onSelect={wrap(() => setAutomationsOpen(true))}
          />
          <ActionItem
            label="Open Sessions"
            icon={<FileText />}
            onSelect={wrap(() => setChatPanelView("sessions"))}
          />
          <ActionItem
            label="Open Marketplace"
            icon={<Store />}
            onSelect={wrap(() => setMarketplaceOpen(true))}
          />
          <ActionItem
            label="Open Settings"
            shortcut="⌘,"
            icon={<Settings />}
            onSelect={wrap(() => setSettingsOpen(true))}
          />
          <ActionItem
            label="Create new workspace"
            icon={<Plus />}
            onSelect={wrap(() => setCreateWorkspaceOpen(true))}
          />
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between border-t border-border bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/40">
        <span className="flex items-center gap-1.5">
          <span className="inline-flex gap-0.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          open
          <span className="mx-1 text-foreground/20">·</span>
          <Kbd>esc</Kbd>
          close
        </span>
      </div>
    </Command>
  );
}

function AgentTabsGroup({
  onClose,
  workspaceId,
}: {
  onClose: () => void;
  workspaceId: string | null;
}) {
  const { browserState } = useWorkspaceBrowser("agent");
  if (browserState.tabs.length === 0) return null;
  return (
    <CommandGroup heading="Agent tabs">
      {browserState.tabs.map((tab) => (
        <TabRow
          key={`agent-${tab.id}`}
          tab={tab}
          driverLabel="agent"
          onSelect={async () => {
            onClose();
            if (workspaceId) {
              await window.electronAPI.browser.setActiveWorkspace(
                workspaceId,
                "agent",
              );
            }
            await window.electronAPI.browser.setActiveTab(tab.id);
          }}
        />
      ))}
    </CommandGroup>
  );
}

function isLocalHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function TabFavicon({
  faviconUrl,
  url,
}: {
  faviconUrl: string | null | undefined;
  url: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [faviconUrl]);

  const Fallback = isLocalHost(url) ? AppWindow : Globe;
  if (!faviconUrl || failed) {
    return <Fallback />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-[2px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function TabRow({
  tab,
  driverLabel,
  onSelect,
}: {
  tab: BrowserStatePayload;
  driverLabel?: "agent";
  onSelect: () => void;
}) {
  const title = tab.title || hostFromUrl(tab.url) || "New Tab";
  const host = hostFromUrl(tab.url) || tab.url;
  return (
    <CommandItem
      value={`${driverLabel ?? "user"}-tab:${tab.id} ${title} ${host}`}
      onSelect={() => void onSelect()}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5 [&_svg]:size-3"
      >
        <TabFavicon faviconUrl={tab.faviconUrl} url={tab.url} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-xs text-foreground/40">{host}</span>
      </span>
      {driverLabel === "agent" ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          title="Agent driving"
        />
      ) : null}
      <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
    </CommandItem>
  );
}

function ActionItem({
  label,
  shortcut,
  icon,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`action ${label}`}
      onSelect={onSelect}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5 [&_svg]:size-3"
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-sm">{label}</span>
      {shortcut ? (
        <span className="text-xs text-foreground/40">{shortcut}</span>
      ) : null}
      <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
    </CommandItem>
  );
}
