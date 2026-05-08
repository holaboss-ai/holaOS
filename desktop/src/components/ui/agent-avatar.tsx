import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * AgentAvatar — small circular avatar for the agent ("Hola") shown
 * next to assistant messages. Sourced from Dicebear's `fun-emoji`
 * style, seeded by workspace id so each workspace has its own
 * persistent face. Placeholder until first-class agent identity
 * (custom image / emoji picker) lands.
 *
 * Convention: rendered on the LAST message of a consecutive agent
 * group (closest to the next user message), iMessage-style. The
 * caller reserves a fixed-width slot for every assistant turn so
 * non-avatar messages stay aligned with the avatar column above.
 */
const agentAvatarVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-fg-6 ring-1 ring-border",
  {
    variants: {
      size: {
        sm: "size-5",
        md: "size-6",
        lg: "size-7",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface AgentAvatarProps
  extends Omit<ComponentProps<"img">, "src" | "alt">,
    VariantProps<typeof agentAvatarVariants> {
  /** Stable identifier driving the avatar variant. Workspace id
   *  is the obvious choice — same workspace, same face. */
  seed: string;
  /** Accessible label; defaults to a generic agent name. */
  alt?: string;
}

const DICEBEAR_BASE = "https://api.dicebear.com/9.x/fun-emoji/svg";

function buildAvatarUrl(seed: string): string {
  const encoded = encodeURIComponent(seed.trim() || "default");
  return `${DICEBEAR_BASE}?seed=${encoded}`;
}

export function AgentAvatar({
  seed,
  size,
  alt = "Agent avatar",
  className,
  ...props
}: AgentAvatarProps) {
  return (
    <img
      data-slot="agent-avatar"
      src={buildAvatarUrl(seed)}
      alt={alt}
      // Lazy + decoded async because these load over the network and
      // we don't want them blocking the chat thread paint.
      loading="lazy"
      decoding="async"
      className={cn(agentAvatarVariants({ size }), className)}
      {...props}
    />
  );
}
