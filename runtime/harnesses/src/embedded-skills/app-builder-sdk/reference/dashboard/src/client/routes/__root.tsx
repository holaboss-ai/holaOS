// Dashboard root — mounts the holaOS tokens so every @holaboss/ui
// primitive renders with workspace-canonical colors, radii, spacing.
//
// MUST be the first imports in the dashboard tree. Without these the
// CSS variables fall back to defaults and the pane looks alien.

import "@holaboss/ui/tokens.css";
import "@holaboss/ui/themes/holaos.css";

import type { ReactNode } from "react";

export function Root({ children }: { children: ReactNode }) {
  return <div className="h-full bg-background text-foreground">{children}</div>;
}
