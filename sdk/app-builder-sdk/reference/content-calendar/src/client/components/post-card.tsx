import { CHANNEL_META, type PostCard as PostCardData } from "../lib/sample-data"
import { StatusBadge } from "./status-badge"

type Props = {
  post: PostCardData
}

// One scheduled post inside a day cell. Visual rules:
//   - Left edge: 2px channel-tint stripe (THE color cue for which platform)
//   - Top line: time (mono, prominent) + channel monogram + status
//   - Body: title clamped to 2 lines
//   - Hover: subtle bg shift + ring lift, no translate / shadow lift
//
// Deliberately compact (~64px tall) so that ~4 cards fit a day cell
// without scroll on a 1280×800 viewport.
export function PostCard({ post }: Props) {
  const meta = CHANNEL_META[post.channel]
  return (
    <article
      className={[
        "group relative cursor-pointer overflow-hidden rounded-md bg-card pl-2.5 pr-2 py-1.5",
        "ring-1 ring-border transition-colors hover:bg-muted/60 hover:ring-fg-32",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "absolute top-0 bottom-0 left-0 w-[2px]",
          meta.tint,
        ].join(" ")}
      />
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] tabular-nums text-foreground">
          {post.timeLabel}
        </span>
        <span
          className={[
            "inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-sm px-1 font-mono text-[9px] leading-none text-fg-80 ring-1",
            meta.ring,
          ].join(" ")}
          aria-label={meta.label}
        >
          {meta.letter}
        </span>
        <span className="ml-auto">
          <StatusBadge status={post.status} />
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-fg-80 group-hover:text-foreground">
        {post.title}
      </p>
    </article>
  )
}
