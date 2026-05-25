import { StatusDot } from "@holaboss/ui"
import type { PostStatus } from "../lib/sample-data"

const MAP: Record<
  PostStatus,
  { label: string; dot: "success" | "warning" | "destructive" | "muted" | "info" }
> = {
  draft: { label: "Draft", dot: "muted" },
  scheduled: { label: "Scheduled", dot: "info" },
  publishing: { label: "Publishing", dot: "warning" },
  published: { label: "Published", dot: "success" },
  failed: { label: "Failed", dot: "destructive" },
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
