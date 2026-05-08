import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * WorkspaceIcon — visual identity for a workspace. Single uppercase
 * letter on a quiet neutral background. Forward-compatible: when
 * `workspace.icon` schema lands, this component should pick the
 * stored emoji / Lucide / uploaded image first and fall through to
 * the monogram only when none exists.
 *
 * Same primitive applies to any "named-thing" identity (apps,
 * sessions, skills) — pass any `{ id, name }`-shaped record.
 */
const workspaceIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center bg-fg-12 font-medium leading-none text-muted-foreground select-none",
  {
    variants: {
      size: {
        xs: "size-4 rounded text-[8px]",
        sm: "size-5 rounded text-[9px]",
        md: "size-6 rounded-md text-[10px]",
        lg: "size-8 rounded-md text-xs",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

interface WorkspaceLike {
  id: string;
  name: string;
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
  ...props
}: WorkspaceIconProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="workspace-icon"
      className={cn(workspaceIconVariants({ size }), className)}
      {...props}
    >
      {deriveMonogram(workspace.name)}
    </span>
  );
}
