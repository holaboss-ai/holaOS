import { Card, CardContent } from "@/components/ui/card";
import {
  Boxes,
  Cable,
  ChevronRight,
  Sparkles,
  Wrench,
} from "@/components/ui/icons";

export function CapabilitiesPane({
  onNavigate,
  onCreate,
}: {
  onNavigate?: (tab: "skills" | "integrations") => void;
  onCreate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-8">
      <div className="flex w-full max-w-lg flex-col items-center gap-6 text-center">
        <Wrench className="size-12 text-muted-foreground" strokeWidth={1.25} />
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Set up your agent
          </h2>
          <p className="text-sm text-muted-foreground">
            A capability bundles the skills and connections your agent uses for a
            kind of work.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 text-left">
          <SuggestionCard
            description="Let agents read and write to the tools you already use."
            icon={Cable}
            onClick={() => onNavigate?.("integrations")}
            title="Connect your apps"
          />
          <SuggestionCard
            description="Teach your agent your processes and expertise."
            icon={Sparkles}
            onClick={() => onNavigate?.("skills")}
            title="Create new skills"
          />
          <SuggestionCard
            description="Bundle skills and integrations into a reusable combo."
            icon={Boxes}
            onClick={onCreate}
            title="Create a combo"
          />
        </div>
      </div>
    </div>
  );
}

function SuggestionCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof Boxes;
  title: string;
  description: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="group w-full rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      type="button"
    >
      <Card className="bg-card py-0 transition-colors hover:bg-accent">
        <CardContent className="flex items-center gap-4 px-4 py-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{title}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              {description}
            </p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </CardContent>
      </Card>
    </button>
  );
}
