import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import {
  WORKSPACE_ICON_KEYS,
  WORKSPACE_ICONS,
  resolveWorkspaceIconKey,
  type WorkspaceIconColorKey,
  type WorkspaceIconKey,
} from "@/components/ui/workspace-icon-catalog";

type WorkspaceIconSize = NonNullable<ComponentProps<typeof WorkspaceIcon>["size"]>;

interface WorkspaceLike {
  id: string;
  name: string;
  icon?: string | null;
  iconColor?: string | null;
}

interface WorkspaceIconPickerProps {
  workspace: WorkspaceLike;
  size?: WorkspaceIconSize;
  /** Optional render override for the trigger (defaults to the WorkspaceIcon). */
  renderTrigger?: (props: { workspace: WorkspaceLike }) => ReactNode;
  /**
   * Called whenever the user picks an icon. The handler is responsible for
   * persisting the change and refreshing local state — the picker only
   * emits intent. `iconColor` is always the neutral tint; we keep it in
   * the payload so existing storage contracts stay unchanged.
   */
  onChange: (next: { icon: WorkspaceIconKey; iconColor: WorkspaceIconColorKey }) => void;
  /** Disables the picker; the trigger renders the icon as plain. */
  disabled?: boolean;
  className?: string;
}

/**
 * WorkspaceIconPicker — Notion-style identity picker. The trigger is the
 * WorkspaceIcon itself; clicking it opens a popover with a grid of curated
 * lucide glyphs. Tint is fixed (neutral gray) so the gallery stays calm —
 * the glyph carries identity, not color.
 */
export function WorkspaceIconPicker({
  workspace,
  size = "sm",
  renderTrigger,
  onChange,
  disabled,
  className,
}: WorkspaceIconPickerProps) {
  const [open, setOpen] = useState(false);
  const currentIcon = resolveWorkspaceIconKey(workspace.id, workspace.icon);

  if (disabled) {
    return <WorkspaceIcon workspace={workspace} size={size} className={className} />;
  }

  const trigger = renderTrigger ? (
    renderTrigger({ workspace })
  ) : (
    <WorkspaceIcon
      workspace={workspace}
      size={size}
      className={cn(
        "cursor-pointer transition-opacity hover:opacity-80",
        className,
      )}
    />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change workspace icon"
            className="inline-flex items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {trigger}
          </button>
        }
      />
      <PopoverContent
        align="start"
        className="w-[280px] p-3"
        positionerClassName="z-[90]"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          className="grid max-h-[260px] grid-cols-6 gap-1 overflow-y-auto"
          role="radiogroup"
          aria-label="Icon"
        >
          {WORKSPACE_ICON_KEYS.map((iconKey) => {
            const Glyph = WORKSPACE_ICONS[iconKey];
            const selected = iconKey === currentIcon;
            return (
              <button
                key={iconKey}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={iconKey}
                onClick={() => onChange({ icon: iconKey, iconColor: "gray" })}
                className={cn(
                  "grid size-9 place-items-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  selected && "bg-accent text-foreground",
                )}
              >
                <Glyph className="size-4" strokeWidth={1.8} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
