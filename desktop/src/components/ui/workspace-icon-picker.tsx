import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import {
  WORKSPACE_ICON_COLOR_KEYS,
  WORKSPACE_ICON_COLORS,
  WORKSPACE_ICON_KEYS,
  WORKSPACE_ICONS,
  resolveWorkspaceIconColorKey,
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
   * Called whenever the user picks an icon or color. The handler is
   * responsible for persisting the change and refreshing local state —
   * the picker only emits intent.
   */
  onChange: (next: { icon: WorkspaceIconKey; iconColor: WorkspaceIconColorKey }) => void;
  /** Disables the picker; the trigger renders the icon as plain. */
  disabled?: boolean;
  className?: string;
}

/**
 * WorkspaceIconPicker — Notion-style identity picker. The trigger is the
 * WorkspaceIcon itself; clicking it opens a popover with a row of color
 * tints and a grid of curated lucide glyphs.
 *
 * Selection is persisted by the consumer's `onChange`. The picker holds
 * no draft state — every click commits an update so the icon you see in
 * the surrounding chrome reflects the chosen value immediately.
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
  const currentColor = resolveWorkspaceIconColorKey(
    workspace.id,
    workspace.iconColor,
  );

  function commit(next: { icon: WorkspaceIconKey; iconColor: WorkspaceIconColorKey }) {
    onChange(next);
  }

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
        className="w-[280px] gap-3 p-3"
        positionerClassName="z-[90]"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          className="flex items-center gap-1.5"
          role="radiogroup"
          aria-label="Color"
        >
          {WORKSPACE_ICON_COLOR_KEYS.map((colorKey) => {
            const tint = WORKSPACE_ICON_COLORS[colorKey];
            const selected = colorKey === currentColor;
            return (
              <button
                key={colorKey}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={colorKey}
                onClick={() => commit({ icon: currentIcon, iconColor: colorKey })}
                className={cn(
                  "relative grid size-6 place-items-center rounded-full ring-1 ring-border transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  selected && "ring-2 ring-foreground/40",
                )}
                style={{ backgroundColor: tint.bg }}
              >
                {selected ? (
                  <Check
                    className="size-3"
                    strokeWidth={2.5}
                    style={{ color: tint.fg }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <div
          className="grid max-h-[220px] grid-cols-6 gap-1 overflow-y-auto"
          role="radiogroup"
          aria-label="Icon"
        >
          {WORKSPACE_ICON_KEYS.map((iconKey) => {
            const Glyph = WORKSPACE_ICONS[iconKey];
            const selected = iconKey === currentIcon;
            const tint = WORKSPACE_ICON_COLORS[currentColor];
            return (
              <button
                key={iconKey}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={iconKey}
                onClick={() => commit({ icon: iconKey, iconColor: currentColor })}
                className={cn(
                  "grid size-9 place-items-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  selected && "bg-accent",
                )}
                style={selected ? { color: tint.fg } : undefined}
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
