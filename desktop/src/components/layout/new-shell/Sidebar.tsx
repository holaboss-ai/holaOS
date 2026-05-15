import {
  ChevronDown,
  Globe,
  Inbox,
  LayoutDashboard,
  Package,
  Search,
  Settings,
  Sparkles,
  Store,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/ui/UserAvatar";
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
  return (
    <div className="window-drag flex h-10 shrink-0 items-center px-2 pl-20">
      <Button
        variant="ghost"
        size="sm"
        className="window-no-drag flex h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-left"
      >
        <span
          className="grid size-4 shrink-0 place-items-center rounded-full bg-primary/15 text-primary ring-1 ring-foreground/10"
          aria-hidden
        >
          <Sparkles className="size-2.5" />
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate font-sans text-base font-medium">
          SocialMedia
        </span>
        <ChevronDown className="size-3 shrink-0 text-foreground/40" />
      </Button>
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
