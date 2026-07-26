import { StatusDot } from "@holaboss/ui"

type Props = {
  state: "ready" | "needs_connect" | "needs_reauth" | "checking"
  handle?: string
}

const COPY: Record<Props["state"], { label: string; tone: "success" | "warning" | "muted" }> = {
  ready: { label: "Connected", tone: "success" },
  needs_connect: { label: "Not connected", tone: "warning" },
  needs_reauth: { label: "Reauth required", tone: "warning" },
  checking: { label: "Checking…", tone: "muted" },
}

export function ConnectionPill({ state, handle }: Props) {
  const { label, tone } = COPY[state]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-64">
      <StatusDot variant={tone} size="sm" />
      <span className="text-fg-80">{label}</span>
      {handle ? <span className="text-fg-48">· {handle}</span> : null}
    </span>
  )
}
