import { StatusDot } from "@holaboss/ui"
import type { ThreadStatus } from "../lib/sample-data"

const MAP: Record<
  ThreadStatus,
  { label: string; dot: "success" | "warning" | "destructive" | "muted" | "info" }
> = {
  unread: { label: "Unread", dot: "info" },
  replying: { label: "Replying", dot: "warning" },
  replied: { label: "Replied", dot: "success" },
  resolved: { label: "Resolved", dot: "muted" },
  escalated: { label: "Escalated", dot: "destructive" },
}

export function StatusBadge({ status }: { status: ThreadStatus }) {
  const { label, dot } = MAP[status]
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-fg-64">
      <StatusDot variant={dot} size="sm" />
      {label}
    </span>
  )
}
