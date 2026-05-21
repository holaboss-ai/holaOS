// Dashboard root — mounts the holaOS styles so every @holaboss/ui
// primitive renders with workspace-canonical colors, radii, spacing.
//
// MUST be the first import in the dashboard tree. The bundled
// styles.css carries the tokens, the default theme, and every
// Tailwind utility class the primitives + layouts use, so this single
// import is all that's needed.

import "@holaboss/ui/styles.css";

import type { ReactNode } from "react";

export function Root({ children }: { children: ReactNode }) {
  return <div className="h-full bg-background text-foreground">{children}</div>;
}
