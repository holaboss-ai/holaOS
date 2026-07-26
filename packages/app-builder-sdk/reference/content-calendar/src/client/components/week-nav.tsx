import { Button } from "@holaboss/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"

type Props = {
  rangeLabel: string
  /** Counts shown next to the range, e.g. "11 posts · 3 drafts" */
  meta?: string
  onPrev?: () => void
  onNext?: () => void
  onToday?: () => void
}

// Week navigator sits BELOW the page header as its own thin band.
// Kept separate from HeaderBar so that the title region stays stable
// across the three canonical references — the calendar-specific
// week-stepper is additive, not a header rewrite.
export function WeekNav({ rangeLabel, meta, onPrev, onNext, onToday }: Props) {
  return (
    <div className="flex items-center gap-2 px-10 pb-4">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrev}
          className="h-7 w-7 p-0 text-fg-64 hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNext}
          className="h-7 w-7 p-0 text-fg-64 hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToday}
          className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
        >
          Today
        </Button>
      </div>
      <span className="text-[13px] text-foreground">{rangeLabel}</span>
      {meta ? <span className="text-[11px] text-fg-48">· {meta}</span> : null}
    </div>
  )
}
