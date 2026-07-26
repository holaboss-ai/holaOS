import { Button, StatusDot } from "@holaboss/ui"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"

type Props = {
  title: string
  subtitle?: string
  rightSlot?: ReactNode
  onCompose?: () => void
}

export function HeaderBar({ title, subtitle, rightSlot, onCompose }: Props) {
  return (
    <header className="px-10 pt-12 pb-8">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1
            className="font-serif text-[22px] leading-none text-foreground"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
          >
            {title}
          </h1>
          <StatusDot variant="success" size="sm" pulse />
        </div>
        {rightSlot}
        <Button
          variant="ghost"
          size="sm"
          onClick={onCompose}
          className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
        >
          <Plus className="size-3" />
          Add draft
        </Button>
      </div>
      {subtitle ? (
        <p className="mt-2 truncate text-xs text-fg-48">{subtitle}</p>
      ) : null}
    </header>
  )
}
