import { StatusDot } from "@holaboss/ui"
import type { PostStatus } from "../lib/sample-data"

const MAP: Record<
  PostStatus,
  { label: string; dot: "success" | "warning" | "destructive" | "muted" | "info" }
> = {
  live: { label: "Live", dot: "success" },
  boosted: { label: "Boosted", dot: "info" },
  underperforming: { label: "Under target", dot: "warning" },
  archived: { label: "Archived", dot: "muted" },
}

export function StatusBadge({ status }: { status: PostStatus }) {
  const { label, dot } = MAP[status]
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-fg-64">
      <StatusDot variant={dot} size="sm" />
      {label}
    </span>
  )
}
