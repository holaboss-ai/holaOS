import { AtSign, Mail, MessageSquare, Star } from "lucide-react"
import type { ThreadKind, ThreadRow } from "../lib/sample-data"
import { StatusBadge } from "./status-badge"

// Single source of truth for the table column template — header and rows
// MUST share this string or columns drift out of alignment.
//   [4px unread dot] [Person] [Source chip] [Replying-to + snippet] [Status] [Time]
const COLS =
  "grid-cols-[4px_minmax(160px,1.6fr)_minmax(96px,1fr)_minmax(160px,2.2fr)_minmax(80px,0.9fr)_50px]"

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
  return (
    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium text-fg-80">
      {initials || "·"}
    </span>
  )
}

function SourceChip({ channel, kind }: { channel: string; kind: ThreadKind }) {
  const Icon =
    kind === "mention"
      ? AtSign
      : kind === "dm"
        ? Mail
        : kind === "review"
          ? Star
          : MessageSquare
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted/70 px-1.5 py-0.5 text-[11px] text-fg-80">
      <Icon className="size-3 shrink-0 text-fg-48" />
      <span className="truncate">{channel}</span>
    </span>
  )
}

function TableHeader() {
  return (
    <div
      className={`grid ${COLS} sticky top-0 z-10 items-center gap-x-4 border-b border-border bg-background px-6 py-2 text-[10px] font-medium tracking-[0.06em] text-fg-48 uppercase`}
    >
      <span />
      <span>Person</span>
      <span>Source</span>
      <span>Re · Last message</span>
      <span>Status</span>
      <span className="text-right">Time</span>
    </div>
  )
}

type RowProps = {
  row: ThreadRow
  isActive: boolean
  onSelect: (id: string) => void
}

function TableRow({ row, isActive, onSelect }: RowProps) {
  const isUnread = row.status === "unread"
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      className={[
        "group relative grid",
        COLS,
        "w-full items-center gap-x-4 border-b border-border px-6 py-2 text-left transition-colors",
        isActive
          ? "bg-muted before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-primary"
          : "hover:bg-muted/40",
      ].join(" ")}
    >
      {isUnread ? (
        <span aria-hidden className="size-1.5 rounded-full bg-info" />
      ) : (
        <span aria-hidden />
      )}

      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={row.authorName} />
        <div className="min-w-0">
          <div
            className={[
              "truncate text-[12px]",
              isUnread ? "font-medium text-foreground" : "text-fg-80",
            ].join(" ")}
          >
            {row.authorName}
          </div>
          <div className="truncate text-[11px] text-fg-48">
            {row.role ?? row.authorHandle}
          </div>
        </div>
      </div>

      <div className="min-w-0">
        <SourceChip channel={row.channel} kind={row.kind} />
      </div>

      <div className="min-w-0">
        <div className="truncate text-[11px] text-fg-48">{row.contextLabel}</div>
        <div
          className={[
            "truncate text-[12px]",
            isUnread ? "text-foreground" : "text-fg-80",
          ].join(" ")}
        >
          {row.body}
        </div>
      </div>

      <div className="min-w-0">
        <StatusBadge status={row.status} />
      </div>

      <span className="text-right font-mono text-[11px] text-fg-48 tabular-nums">
        {row.timeLabel}
      </span>
    </button>
  )
}

type Props = {
  rows: ThreadRow[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function InboxTable({ rows, activeId, onSelect }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TableHeader />
      <div>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            row={row}
            isActive={row.id === activeId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
