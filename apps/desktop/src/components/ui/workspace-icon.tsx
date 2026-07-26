import { Icon as IconifyIcon } from "@iconify/react";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";

import { cn } from "@/lib/utils";
import {
  WORKSPACE_ICON_COLORS,
  WORKSPACE_ICONS,
  resolveWorkspaceIconColorKey,
  resolveWorkspaceIconKey,
} from "@/components/ui/workspace-icon-catalog";

/**
 * WorkspaceIcon — visual identity for a workspace. Renders, in order of
 * preference: a stored lucide glyph (Notion-style picker), a deterministic
 * fallback derived from `workspace.id` (so workspaces with no explicit
 * choice still feel intentional), and finally a one-letter monogram when
 * the id is missing. Background tint follows the same priority chain.
 *
 * Same primitive applies to any "named-thing" identity (apps, sessions,
 * skills) — pass any `{ id, name }`-shaped record. For records that don't
 * carry icon/iconColor, the deterministic fallback still produces a stable
 * tinted glyph keyed by `id`.
 */
const workspaceIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-medium leading-none select-none",
  {
    variants: {
      size: {
        xs: "size-4 rounded text-[8px]",
        sm: "size-5 rounded text-[9px]",
        md: "size-6 rounded-md text-[10px]",
        lg: "size-8 rounded-md text-xs",
        xl: "size-14 rounded-xl text-lg",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

const iconGlyphSize = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
  xl: "size-7",
} as const;

interface WorkspaceLike {
  id: string;
  name: string;
  icon?: string | null;
  // The runtime wire shape uses snake_case (`WorkspaceRecordPayload.icon_color`);
  // camelCase is accepted too so synthetic / test records can pass either.
  // Snake wins when both are set.
  icon_color?: string | null;
  iconColor?: string | null;
}

export type WorkspaceIconProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof workspaceIconVariants> & {
    workspace: WorkspaceLike;
  };

function deriveMonogram(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function WorkspaceIcon({
  workspace,
  size,
  className,
  style,
  ...props
}: WorkspaceIconProps) {
  const sizeKey = size ?? "sm";
  const storedIconColor = workspace.icon_color ?? workspace.iconColor;
  const iconKey = workspace.id
    ? resolveWorkspaceIconKey(workspace.id, workspace.icon)
    : null;
  const colorKey = workspace.id
    ? resolveWorkspaceIconColorKey(workspace.id, storedIconColor)
    : null;
  const iconName = iconKey ? WORKSPACE_ICONS[iconKey] : null;
  const tint = colorKey ? WORKSPACE_ICON_COLORS[colorKey] : null;

  const tintStyle: CSSProperties = tint
    ? { backgroundColor: tint.bg, color: tint.fg }
    : {};

  return (
    <span
      aria-hidden="true"
      data-slot="workspace-icon"
      className={cn(
        workspaceIconVariants({ size }),
        // When no tint resolves (records without an id) fall back to the
        // existing neutral chip so legacy callers keep working.
        tint ? null : "bg-fg-12 text-muted-foreground",
        className,
      )}
      style={{ ...tintStyle, ...style }}
      {...props}
    >
      {iconName ? (
        <IconifyIcon
          icon={iconName}
          className={iconGlyphSize[sizeKey]}
        />
      ) : (
        deriveMonogram(workspace.name)
      )}
    </span>
  );
}
