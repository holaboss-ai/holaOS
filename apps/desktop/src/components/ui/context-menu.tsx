import { useMemo } from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@/lib/utils";

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  align,
  alignOffset,
  side,
  sideOffset = 2,
  collisionAvoidance,
  collisionBoundary,
  collisionPadding,
  boundarySelector,
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "collisionAvoidance"
    | "collisionBoundary"
    | "collisionPadding"
  > & {
    /** Confine the menu to the bounds of the closest element matching
     *  the given selector. Use for menus inside a fixed column (e.g. the
     *  sidebar) so the menu never overflows into adjacent panes where a
     *  native BrowserView would occlude it. Resolved at portal render
     *  time. `collisionBoundary` takes precedence if both are set. */
    boundarySelector?: string;
  }) {
  const resolvedBoundary = useMemo(() => {
    if (collisionBoundary) return collisionBoundary;
    if (!boundarySelector || typeof document === "undefined") return undefined;
    return document.querySelector(boundarySelector) ?? undefined;
  }, [collisionBoundary, boundarySelector]);

  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        collisionBoundary={resolvedBoundary}
        collisionPadding={collisionPadding}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "dark z-50 max-h-(--available-height) max-w-(--available-width) min-w-44 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-md ring-1 ring-border ease-emphasized outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:duration-fast data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-fast data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95 relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:not-data-[variant=destructive]:focus:bg-foreground/10 **:data-[slot$=-item]:not-data-[variant=destructive]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2.5 py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
