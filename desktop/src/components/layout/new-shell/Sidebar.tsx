import {
  Check,
  ChevronDown,
  Globe,
  Inbox,
  LayoutDashboard,
  Package,
  Search,
  Settings,
  Store,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./shared";

export function Sidebar() {
  return (
    <aside
      data-pane-card="true"
      className="flex w-[260px] shrink-0 flex-col border-r border-border bg-card backdrop-blur-sm"
    >
      <WorkspaceSwitcher />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <SidebarGroup>
          <NavItem icon={<Search />}>Search</NavItem>
          <NavItem icon={<Inbox />} badge={2}>
            Inbox
          </NavItem>
          <NavItem icon={<Package />}>Artifacts</NavItem>
        </SidebarGroup>

        <SidebarGroup>
          <SectionLabel>Recents</SectionLabel>
          <NavItem indent>LinkedIn launch</NavItem>
          <NavItem indent>brand voice memo</NavItem>
          <NavItem indent>weekly digest</NavItem>
        </SidebarGroup>

        <SidebarGroup>
          <SectionLabel>Pinned</SectionLabel>
          <NavItem indent icon={<LayoutDashboard />}>
            Engagement
          </NavItem>
          <NavItem indent icon={<Globe />}>
            Competitor X
          </NavItem>
        </SidebarGroup>

        <SidebarGroup>
          <SectionLabel>
            Skills
            <span className="ml-auto text-foreground/30">12</span>
          </SectionLabel>
          <SectionLabel>
            Automations
            <span className="ml-auto text-foreground/30">4</span>
          </SectionLabel>
        </SidebarGroup>

        <div className="mt-auto" />

        <SidebarGroup>
          <NavItem icon={<Wrench />}>Apps</NavItem>
          <NavItem icon={<Store />}>Marketplace</NavItem>
          <NavItem icon={<Settings />}>Settings</NavItem>
        </SidebarGroup>
      </div>
      <AccountFoot />
    </aside>
  );
}

function WorkspaceSwitcher() {
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const { workspaces, selectedWorkspace } = useWorkspaceDesktop();

  return (
    <div className="window-drag flex h-10 shrink-0 items-center px-2 pl-20">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="window-no-drag flex h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-left"
            >
              {selectedWorkspace ? (
                <WorkspaceIcon
                  workspace={selectedWorkspace}
                  size="xs"
                  className="ring-1 ring-foreground/10"
                />
              ) : (
                <span
                  className="size-4 shrink-0 rounded bg-foreground/10"
                  aria-hidden
                />
              )}
              <span className="ml-1 min-w-0 flex-1 truncate font-sans text-base font-medium">
                {selectedWorkspace?.name ?? "Select workspace"}
              </span>
              <ChevronDown className="size-3 shrink-0 text-foreground/40" />
            </Button>
          }
        />
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[260px] gap-0 p-1"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          {workspaces.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-foreground/40">
              No workspaces yet.
            </div>
          ) : (
            workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setSelectedWorkspaceId(w.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
              >
                <WorkspaceIcon
                  workspace={w}
                  size="xs"
                  className="ring-1 ring-foreground/10"
                />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.id === selectedWorkspaceId ? (
                  <Check className="size-3.5 shrink-0 text-foreground/60" />
                ) : null}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SidebarGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 pt-3.5 first:pt-0">{children}</div>
  );
}

function NavItem({
  icon,
  badge,
  indent,
  active,
  children,
}: {
  icon?: React.ReactNode;
  badge?: number;
  indent?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto justify-start gap-2 px-2 py-[5px] text-sm font-normal text-foreground",
        active && "bg-foreground/[0.07] text-foreground",
        !active && "hover:bg-foreground/[0.04]",
        indent && "pl-7",
      )}
    >
      {icon ? (
        <span
          className="grid size-3.5 shrink-0 place-items-center text-foreground/60 [&_svg]:size-3.5"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <span className="flex-1 truncate text-left">{children}</span>
      {badge ? (
        <Badge className="h-4 px-1.5 text-[10px]">{badge}</Badge>
      ) : null}
    </Button>
  );
}

function AccountFoot() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-3">
      <div className="size-5 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-foreground/10">
        <UserAvatar user={{ id: "joshua", name: "Joshua" }} />
      </div>
      <span className="flex-1 truncate text-sm">Joshua</span>
    </div>
  );
}
