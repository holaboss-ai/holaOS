import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * AgentAvatar — circular avatar for the agent. Uses the canonical
 * Hola image. The optional `seed` prop is reserved for future
 * per-agent avatar variants and is currently a no-op.
 */
const HOLA_AVATAR_URL = "https://assets.holaboss.ai/images/hola.webp";

const agentAvatarVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center overflow-hidden bg-fg-6",
  {
    variants: {
      size: {
        sm: "size-5 rounded",
        md: "size-6 rounded-md",
        lg: "size-7 rounded-md",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface AgentAvatarProps
  extends Omit<ComponentProps<"img">, "src" | "alt">,
    VariantProps<typeof agentAvatarVariants> {
  seed?: string;
  alt?: string;
}

export function AgentAvatar({
  seed: _seed,
  size,
  alt = "Hola",
  className,
  ...props
}: AgentAvatarProps) {
  return (
    <img
      data-slot="agent-avatar"
      src={HOLA_AVATAR_URL}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={cn(agentAvatarVariants({ size }), className)}
      {...props}
    />
  );
}
