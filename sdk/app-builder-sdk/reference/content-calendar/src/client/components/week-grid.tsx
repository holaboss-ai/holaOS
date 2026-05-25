import { Plus } from "lucide-react"
import {
  SAMPLE_WEEK_DATES,
  WEEK_DAYS,
  type PostCard as PostCardData,
} from "../lib/sample-data"
import { PostCard } from "./post-card"

type Props = {
  posts: PostCardData[]
  /** Column index of "today" — gets a subtle highlight in the header. */
  todayIndex?: number
  /** Day cells with fewer than this many posts get an "underbooked"
   *  whisper at the bottom. Set to 0 to suppress. */
  underbookedBelow?: number
}

// Day-cell column header — date + density count + (optional) today marker.
function DayHeader({
  day,
  date,
  count,
  isToday,
}: {
  day: string
  date: string
  count: number
  isToday: boolean
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border px-2 pt-2 pb-2">
      <div className="flex items-baseline gap-2">
        <span
          className={[
            "text-[10px] tracking-[0.08em] uppercase",
            isToday ? "text-primary" : "text-fg-48",
          ].join(" ")}
        >
          {day}
        </span>
        <span
          className={[
            "text-[12px] tabular-nums",
            isToday ? "font-medium text-foreground" : "text-fg-80",
          ].join(" ")}
        >
          {date}
        </span>
      </div>
      <span className="font-mono text-[10px] text-fg-32 tabular-nums">
        {count.toString().padStart(2, "0")}
      </span>
    </div>
  )
}

function DayCellEmpty() {
  return (
    <button
      type="button"
      className="group flex h-12 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-fg-32/40 text-[10px] text-fg-32 transition-colors hover:border-fg-48 hover:bg-muted/30 hover:text-fg-64"
    >
      <Plus className="size-3" />
      <span className="tracking-[0.04em] uppercase opacity-0 transition-opacity group-hover:opacity-100">
        open slot
      </span>
    </button>
  )
}

function UnderbookedWhisper() {
  return (
    <div className="pt-0.5 pl-2 text-[10px] text-fg-32 tracking-[0.04em]">
      · underbooked
    </div>
  )
}

// The 7-column weekly grid. This is the load-bearing shape change vs.
// the messaging-dashboard reference: we trade vertical scroll-density
// for horizontal spatial reasoning. The eye should be able to spot
// "Thu is empty" and "Tue is stacked" in one glance — that's what the
// density count + the underbooked whisper exist for.
export function WeekGrid({ posts, todayIndex, underbookedBelow = 2 }: Props) {
  const byDay = new Map<number, PostCardData[]>()
  for (const post of posts) {
    const arr = byDay.get(post.dayIndex) ?? []
    arr.push(post)
    byDay.set(post.dayIndex, arr)
  }
  for (const arr of byDay.values()) {
    arr.sort((a, b) => a.timeLabel.localeCompare(b.timeLabel))
  }

  return (
    <div className="grid grid-cols-7 items-start gap-2 px-10 pb-12">
      {WEEK_DAYS.map((day, i) => {
        const cellPosts = byDay.get(i) ?? []
        const isToday = i === todayIndex
        const isUnderbooked =
          underbookedBelow > 0 && cellPosts.length < underbookedBelow
        return (
          <div key={day} className="flex flex-col">
            <DayHeader
              day={day}
              date={SAMPLE_WEEK_DATES[i] ?? ""}
              count={cellPosts.length}
              isToday={isToday}
            />
            <div className="flex flex-col gap-1.5 pt-2">
              {cellPosts.length === 0 ? (
                <DayCellEmpty />
              ) : (
                <>
                  {cellPosts.map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))}
                  {isUnderbooked ? <UnderbookedWhisper /> : null}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
