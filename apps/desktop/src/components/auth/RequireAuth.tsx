import type { ReactNode } from "react";

import { SignInScreen } from "@/components/auth/SignInScreen";
import { BootSplash } from "@/components/layout/BootSplash";
import { useDesktopAuthSession } from "@/lib/auth/authClient";

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Render gate for the renderer. Three states:
 *   - First IPC for the cached session hasn't resolved → BootSplash.
 *   - Resolved with no user (cold install, sign-out, expired) → SignInScreen.
 *   - Resolved with a user → children.
 *
 * Sign-out propagates here automatically: `auth:userUpdated(null)` from the
 * main process clears `data` in `useDesktopAuthSession`, which unmounts the
 * authed subtree and remounts the sign-in screen.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { data, error, isPending } = useDesktopAuthSession();

  if (isPending && !data && !error) {
    return <BootSplash />;
  }

  if (!data) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}
