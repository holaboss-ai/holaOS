import { Search } from "lucide-react"
import { METRIC_META, type MetricKey } from "../lib/sample-data"

type RangeKey = "24h" | "7d" | "30d"

type Props = {
  metric: MetricKey
  onMetricChange: (m: MetricKey) => void
  range: RangeKey
  onRangeChange: (r: RangeKey) => void
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
]

// Toolbar — selects which metric the big chart shows + the time range +
// surfaces the ⌘K search hint. Lives directly under the page header.
// Two segmented-control chip groups (metric / range) on the left, search
// hint pinned right.
export function AnalyticsToolbar({
  metric,
  onMetricChange,
  range,
  onRangeChange,
}: Props) {
  return (
    <div className="flex items-center gap-1.5 border-t border-border px-6 py-1.5">
      {(Object.keys(METRIC_META) as MetricKey[]).map((key) => {
        const isActive = key === metric
        const meta = METRIC_META[key]
        return (
          <button
            key={key}
            type="button"
            onClick={() => onMetricChange(key)}
            className={[
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-fg-64 hover:bg-muted/40 hover:text-foreground",
            ].join(" ")}
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ backgroundColor: meta.stroke }}
            />
            {meta.label}
          </button>
        )
      })}

      <span aria-hidden className="mx-2 h-3 w-px bg-border" />

      {RANGES.map((r) => {
        const isActive = r.key === range
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onRangeChange(r.key)}
            className={[
              "inline-flex items-center rounded-md px-2 py-1 text-[11px] transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-fg-64 hover:bg-muted/40 hover:text-foreground",
            ].join(" ")}
          >
            {r.label}
          </button>
        )
      })}

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
