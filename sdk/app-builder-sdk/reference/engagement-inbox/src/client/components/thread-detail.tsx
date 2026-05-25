import { Button } from "@holaboss/ui"
import {
  AtSign,
  Check,
  CornerUpLeft,
  ExternalLink,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Sparkles,
  Star,
} from "lucide-react"
import type { ThreadKind, ThreadRow } from "../lib/sample-data"
import { StatusBadge } from "./status-badge"

type Props = {
  row: ThreadRow
}

// Mid-sized avatar for the detail header. Slightly larger than the table avatar
// (32px vs 24px) — the detail pane treats the person as the primary subject.
function DetailAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-medium text-fg-80">
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
    <span className="inline-flex items-center gap-1 rounded-sm bg-muted/70 px-1.5 py-0.5 text-[11px] text-fg-80">
      <Icon className="size-3 text-fg-48" />
      {channel}
    </span>
  )
}

// Detail pane = CRM-style record drawer.
//
//   ┌──────────────────────────────────────────────────┐
//   │ AV  Lena Park   @lenacodes        [↗] [⋯]        │  ← person card
//   │     Engineering Lead · Loop                       │
//   │     [✕ twitter] · ● Unread · 4 prior touches      │
//   ├──────────────────────────────────────────────────┤
//   │  ┌──────────────────────────────────────────┐    │
//   │  │ REPLYING TO                               │    │  ← context callout
//   │  │ Pricing page launch                       │    │
//   │  └──────────────────────────────────────────┘    │
//   │                                                   │
//   │  Tried the new pricing page — the 'team' tier    │  ← body
//   │  copy is a little confusing. Is per-seat the     │
//   │  same as per-editor?                              │
//   ├──────────────────────────────────────────────────┤
//   │  ┌──────────────────────────────────────────┐    │
//   │  │ Write a reply…                            │    │  ← composer
//   │  │ [✨ Suggest] [⋯]      [✓ Resolve] [Reply] │    │
//   │  └──────────────────────────────────────────┘    │
//   └──────────────────────────────────────────────────┘
export function ThreadDetail({ row }: Props) {
  return (
    <article className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-start gap-3">
          <DetailAvatar name={row.authorName} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-medium text-foreground">
                {row.authorName}
              </h2>
              <span className="text-[12px] text-fg-48">{row.authorHandle}</span>
            </div>
            {row.role ? (
              <div className="mt-0.5 text-[12px] text-fg-64">{row.role}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-48">
              <SourceChip channel={row.channel} kind={row.kind} />
              <span aria-hidden>·</span>
              <StatusBadge status={row.status} />
              <span aria-hidden>·</span>
              <span>
                {row.priorTouches} prior{" "}
                {row.priorTouches === 1 ? "touch" : "touches"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] text-fg-64 hover:text-foreground"
            >
              <ExternalLink className="size-3" />
              Open in {row.channel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 p-1 text-fg-64 hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="rounded-md bg-muted/60 px-3.5 py-2.5">
          <div className="text-[10px] tracking-[0.06em] text-fg-48 uppercase">
            Replying to
          </div>
          <p className="mt-0.5 text-[12px] text-fg-80">{row.contextLabel}</p>
        </div>
        <p className="mt-6 text-[14px] leading-relaxed text-foreground">
          {row.body}
        </p>
      </div>

      <footer className="px-6 py-4">
        <div className="rounded-xl border border-border bg-card transition-colors focus-within:border-fg-48">
          <textarea
            rows={2}
            placeholder="Write a reply, or press Suggest to draft one with the agent"
            className="block w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground placeholder:text-fg-48 focus:outline-none"
          />
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
            >
              <Sparkles className="size-3" />
              Suggest
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
            >
              <MoreHorizontal className="size-3" />
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
            >
              <Check className="size-3" />
              Resolve
            </Button>
            <Button variant="default" size="sm" className="h-7 gap-1.5 px-3 text-xs">
              <CornerUpLeft className="size-3" />
              Reply
            </Button>
          </div>
        </div>
      </footer>
    </article>
  )
}

export function ThreadDetailEmpty() {
  return (
    <div className="flex h-full items-center justify-center px-8 py-12">
      <div className="max-w-xs text-center">
        <p className="text-[13px] text-fg-64">Select a row to open the thread.</p>
        <p className="mt-1 text-[11px] text-fg-48">
          The agent triages new mentions every 5 min. Unread rows rise to the top.
        </p>
      </div>
    </div>
  )
}
