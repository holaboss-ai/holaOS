import { FileText, Globe, LayoutDashboard, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "./shared";

export function Center() {
  return (
    <main className="flex min-w-[480px] flex-1 flex-col overflow-hidden">
      <NewTabLanding />
    </main>
  );
}

function NewTabLanding() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 pt-24">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3">
        <Search className="size-4 text-foreground/40" />
        <Input
          placeholder="Search or enter URL"
          aria-label="Search or enter URL"
          className="h-10 flex-1 border-0 bg-transparent text-sm focus-visible:ring-0"
        />
        <span className="text-xs text-foreground/40">↗</span>
      </div>

      <div className="flex flex-col gap-1">
        <SectionLabel className="pb-1">Recently closed</SectionLabel>
        <RecentRow icon={<Globe className="size-3.5" />} title="linkedin.com/in/x" when="2h" />
        <RecentRow
          icon={<LayoutDashboard className="size-3.5" />}
          title="Engagement"
          when="1d"
        />
        <RecentRow
          icon={<FileText className="size-3.5" />}
          title="launch brief"
          when="3d"
        />
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>New</SectionLabel>
        <div className="flex flex-wrap gap-2 px-2">
          <Button variant="outline" size="sm">
            <FileText className="size-3.5" /> Doc
          </Button>
          <Button variant="outline" size="sm">
            <LayoutDashboard className="size-3.5" /> Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecentRow({
  icon,
  title,
  when,
}: {
  icon: React.ReactNode;
  title: string;
  when: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 justify-start gap-2 px-2 text-sm font-normal hover:bg-foreground/[0.04]"
    >
      <span className="text-foreground/60">{icon}</span>
      <span className="flex-1 truncate text-left">{title}</span>
      <span className="text-xs text-foreground/40">{when}</span>
    </Button>
  );
}
