import { Mail, MoreHorizontal } from "lucide-react"
import {
  METRIC_META,
  type DigestEntry,
  type MetricKey,
} from "../lib/sample-data"

function formatBig(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toString()
}

type Props = {
  digests: DigestEntry[]
  /** Total checkpoints, used to render the next-digest hint. */
  nextInLabel: string
}

// Right rail — history log of agent-sent Gmail digests, each tied to a
// checkpoint marker on the chart to the left. This is the surface that
// makes the email automation *tangible* — without it, the agent's cron is
// invisible to the marketer.
//
//   ┌───────────────────────────┐
//   │ DIGESTS                ⋯  │   ← rail header
//   │ Next in 4h                 │
//   ├───────────────────────────┤
//   │ ✉  Today · 18:00           │   ← latest sent first
//   │    8 posts · 44.1K ◐ 2.0K  │
//   │    285 ◯                   │
//   │    [↗ Open in Gmail]       │
//   ├───────────────────────────┤
//   │ ✉  Yesterday · 06:00       │
//   │    7 posts · 28.4K …       │
//   │    [↗ Open in Gmail]       │
//   ├───────────────────────────┤
//   │ …                          │
//   └───────────────────────────┘
//
// Each entry shows the digest's metric summary, formatted the same way as
// the KPI strip totals (formatBig). The first entry doubles as "next
// digest in Xh" hint via the header.
export function DigestRail({ digests, nextInLabel }: Props) {
  return (
    <aside className="flex h-full flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[10px] tracking-[0.08em] text-fg-48 uppercase">
            Digests
          </h2>
          <p className="mt-0.5 text-[11px] text-fg-64">{nextInLabel}</p>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-fg-48 transition-colors hover:bg-muted/40 hover:text-foreground"
          aria-label="Digest settings"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {digests.map((d, idx) => (
          <li
            key={d.id}
            className={[
              "flex flex-col gap-2 px-4 py-3",
              idx > 0 ? "border-t border-border" : "",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 text-[11px] text-fg-48">
              <Mail className="size-3 text-fg-32" />
              <span className="font-mono tabular-nums text-fg-80">{d.sentAt}</span>
              <span aria-hidden>·</span>
              <span>{d.postCount} posts</span>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-64">
              {(Object.keys(METRIC_META) as MetricKey[]).map((key) => {
                const meta = METRIC_META[key]
                return (
                  <span key={key} className="inline-flex items-center gap-1 tabular-nums">
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: meta.stroke }}
                    />
                    {formatBig(d.totals[key])}
                  </span>
                )
              })}
            </div>

            <a
              href={d.gmailUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 text-[11px] text-fg-64 transition-colors hover:text-foreground"
            >
              Open in Gmail ↗
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}
