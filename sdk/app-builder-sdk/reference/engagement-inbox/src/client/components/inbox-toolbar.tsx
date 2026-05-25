import { Button } from "@holaboss/ui"
import { ArrowDownUp, Filter, Search } from "lucide-react"
import type { ThreadKind } from "../lib/sample-data"

type FilterKey = "all" | ThreadKind

type Props = {
  active: FilterKey
  onChange: (key: FilterKey) => void
  counts: Record<FilterKey, number>
}

const VIEWS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mention", label: "Mentions" },
  { key: "comment", label: "Comments" },
  { key: "dm", label: "DMs" },
  { key: "review", label: "Reviews" },
]

// Attio-style table chrome — saved views, secondary filter/sort, search hint.
// Sits between the page header and the table.
//   [All 7] [Mentions 2] [Comments 2] [DMs 2] [Reviews 1] │ [⌃ Filter] [↕ Sort]                ⌘K Search
export function InboxToolbar({ active, onChange, counts }: Props) {
  return (
    <div className="flex items-center gap-1 border-t border-border px-6 py-1.5">
      {VIEWS.map((view) => {
        const isActive = view.key === active
        const count = counts[view.key] ?? 0
        return (
          <button
            key={view.key}
            type="button"
            onClick={() => onChange(view.key)}
            className={[
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-fg-64 hover:bg-muted/40 hover:text-foreground",
            ].join(" ")}
          >
            <span>{view.label}</span>
            {count > 0 ? (
              <span
                className={[
                  "font-mono text-[10px] tabular-nums",
                  isActive ? "text-fg-80" : "text-fg-32",
                ].join(" ")}
              >
                {count}
              </span>
            ) : null}
          </button>
        )
      })}

      <span aria-hidden className="mx-2 h-3 w-px bg-border" />

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[11px] text-fg-64 hover:text-foreground"
      >
        <Filter className="size-3" />
        Filter
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[11px] text-fg-64 hover:text-foreground"
      >
        <ArrowDownUp className="size-3" />
        Sort
      </Button>

      <div className="flex-1" />

      <div className="inline-flex items-center gap-1.5 text-[11px] text-fg-48">
        <Search className="size-3" />
        <span>Search</span>
        <kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-[10px] leading-tight text-fg-64">
          ⌘K
        </kbd>
      </div>
    </div>
  )
}
