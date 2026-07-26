import { Icon as IconifyIcon } from "@iconify/react";
import { getSkillIcon } from "@/lib/skillVisual";
import { cn } from "@/lib/utils";

// Prominent Manus-style creation entry points shown above the empty-state
// "Try first" suggestions. Picking one seeds the composer with its skill (Image
// also flips the composer into image mode) so the user just describes what they
// want and the agent produces it — the same intent-first flow as the "+" menu,
// only surfaced up front.
export interface CreationType {
  skillId: string;
  label: string;
  /** Flip the composer into image mode (model / quality / aspect controls). */
  imageMode?: boolean;
  /** Flip the composer into video mode (model / resolution / aspect / duration).
   *  Video generation is a runtime tool, so no skill is quoted. */
  videoMode?: boolean;
  /** Seeded into the composer when skillId isn't installed in this workspace,
   *  so the chip still hands the user a usable starting point instead of
   *  quoting a skill that would fail the pre-send guard. */
  examplePrompt?: string;
}

const CREATION_TYPES: CreationType[] = [
  {
    skillId: "image-generator",
    label: "Image",
    imageMode: true,
    examplePrompt: "Create a bold, modern hero image for a product launch.",
  },
  {
    skillId: "pptx",
    label: "Slides",
    examplePrompt: "Create a slide deck outlining a go-to-market plan.",
  },
  { skillId: "short-video-scripter", label: "Video", videoMode: true },
  {
    skillId: "doc-coauthoring",
    label: "Doc",
    examplePrompt: "Draft a one-page brief for an upcoming marketing campaign.",
  },
  {
    skillId: "xlsx",
    label: "Sheet",
    examplePrompt:
      "Create a spreadsheet to track weekly content performance by platform.",
  },
  {
    skillId: "performance-reporter",
    label: "Report",
    examplePrompt:
      "Put together a performance report summarizing last month's key metrics.",
  },
];

export function CreationChips({
  onPick,
  className,
}: {
  onPick: (type: CreationType) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {CREATION_TYPES.map((type) => (
        <button
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 font-medium text-[13px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          key={type.skillId}
          onClick={() => onPick(type)}
          type="button"
        >
          <IconifyIcon className="size-3.5" icon={getSkillIcon(type.skillId)} />
          {type.label}
        </button>
      ))}
    </div>
  );
}
