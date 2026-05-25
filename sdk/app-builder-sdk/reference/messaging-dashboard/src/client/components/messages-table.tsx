import { Button } from "@holaboss/ui"
import { Pencil, RotateCw } from "lucide-react"
import type { MessageRow } from "../lib/sample-data"
import { StatusBadge } from "./status-badge"

type QueueRowProps = {
  row: MessageRow
  isNext: boolean
}

function QueueRow({ row, isNext }: QueueRowProps) {
  return (
    <li className="group relative grid grid-cols-[64px_16px_1fr_auto] items-baseline gap-x-3 py-3 transition-colors hover:bg-muted/40">
      <span
        className={[
          "font-mono text-[11px] leading-tight tabular-nums",
          isNext ? "text-foreground" : "text-fg-64",
        ].join(" ")}
      >
        {row.timeLabel}
      </span>
      <span className="relative inline-block h-full" aria-hidden>
        {isNext ? (
          <>
            <span className="absolute top-[1px] left-1/2 size-3.5 -translate-x-1/2 rounded-full bg-primary/15 animate-pulse" />
            <span className="absolute top-[5px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary ring-[3px] ring-background" />
          </>
        ) : (
          <span className="absolute top-[7px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-fg-48 ring-[3px] ring-background" />
        )}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-foreground">#{row.channel}</span>
          <StatusBadge status={row.status} />
          <span className="text-fg-48">{row.authorHandle}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-fg-80">
          {row.text}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-start pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
        >
          <Pencil className="size-3" />
          Edit
        </Button>
      </div>
    </li>
  )
}

// "Now" marker — a small horizontal tick + label that sits on the rail,
// indicating where the current clock falls relative to scheduled items.
// Renders ONLY in today's section, above the first row whose time is in
// the future. Reinforces that the rail is a literal day clock, not a
// generic list ornament.
function NowMarker({ label }: { label: string }) {
  return (
    <li className="relative flex items-center gap-3 py-1.5" aria-hidden>
      <span className="font-mono text-[10px] text-primary tabular-nums uppercase">
        now · {label}
      </span>
      <span className="h-px flex-1 bg-primary/50" />
    </li>
  )
}

type Props = {
  rows: MessageRow[]
  nextIndex?: number
  /** When set, renders a "now" marker just above row[nextIndex]. */
  nowLabel?: string
}

export function MessageList({ rows, nextIndex, nowLabel }: Props) {
  return (
    <ul className="relative">
      <span
        aria-hidden
        className="absolute top-3 bottom-3 w-px bg-fg-32"
        style={{ left: 83 }}
      />
      {rows.flatMap((row, idx) => {
        const elements = []
        if (nowLabel != null && idx === nextIndex) {
          elements.push(<NowMarker key={`now-${row.id}`} label={nowLabel} />)
        }
        elements.push(<QueueRow key={row.id} row={row} isNext={idx === nextIndex} />)
        return elements
      })}
    </ul>
  )
}

type AttentionProps = {
  rows: MessageRow[]
}

export function AttentionList({ rows }: AttentionProps) {
  if (rows.length === 0) return null
  return (
    <ul className="overflow-hidden rounded-lg border border-warning/30 bg-warning/[0.06]">
      {rows.map((row, idx) => (
        <li
          key={row.id}
          className={[
            "grid grid-cols-[1fr_auto] gap-x-4 px-4 py-3",
            idx > 0 ? "border-t border-warning/20" : "",
          ].join(" ")}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium text-foreground">#{row.channel}</span>
              <StatusBadge status={row.status} />
              <span className="text-fg-48 tabular-nums">{row.timeLabel}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-fg-80">
              {row.text}
            </p>
            {row.errorReason ? (
              <p className="mt-1.5 font-mono text-[11px] text-warning-text">
                {row.errorReason}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 self-start pt-0.5">
            <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
              <RotateCw className="size-3" />
              Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
            >
              <Pencil className="size-3" />
              Edit
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}
