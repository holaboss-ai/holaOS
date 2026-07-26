import { Button, StatusDot } from "@holaboss/ui"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"

type Props = {
  title: string
  subtitle?: string
  rightSlot?: ReactNode
  onPrimary?: () => void
  primaryLabel?: string
}

export function HeaderBar({
  title,
  subtitle,
  rightSlot,
  onPrimary,
  primaryLabel = "Mark all read",
}: Props) {
  return (
    <header className="px-6 pt-10 pb-6">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1 className="text-[20px] font-medium leading-none tracking-tight text-foreground">
            {title}
          </h1>
          <StatusDot variant="info" size="sm" pulse />
        </div>
        {rightSlot}
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrimary}
          className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
        >
          <Plus className="size-3" />
          {primaryLabel}
        </Button>
      </div>
      {subtitle ? (
        <p className="mt-2 truncate text-xs text-fg-48">{subtitle}</p>
      ) : null}
    </header>
  )
}
