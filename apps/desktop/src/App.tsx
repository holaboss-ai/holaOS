import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { AppShell } from "@/components/layout/shell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import {
  identifyUmamiUser,
  trackUmamiEvent,
} from "@/lib/analytics/umami";
import { installRendererAuthCacheListeners } from "@/lib/app-sdk-client";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { TooltipProvider } from "./components/ui/tooltip";

// localStorage key the old shell-toggle used to write to. Cleaned up
// on boot so it doesn't sit forever as dead bytes — the toggle is gone
// and the new shell is the only shell.
const LEGACY_SHELL_TOGGLE_STORAGE_KEY = "holaboss-new-layout-shell-v1";

function UmamiIdentity() {
  const { data } = useDesktopAuthSession();
  const userId = data?.user?.id ?? null;
  const previousUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    identifyUmamiUser(userId);
    if (userId && previousUserIdRef.current === null) {
      trackUmamiEvent("signin_completed", { user_id: userId });
    }
    previousUserIdRef.current = userId;
  }, [userId]);
  return null;
}

function createDesktopQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Renderer fetches Hono BFF directly — most data is workspace-scoped
        // and tolerates a brief stale window. Avoid noisy refetches on every
        // focus to keep the desktop UI quiet.
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
    },
  });
}

function App() {
  // One QueryClient instance for the lifetime of the renderer. Created with
  // useState so HMR doesn't churn cache.
  const [queryClient] = useState(createDesktopQueryClient);

  // Remove the pre-React splash element from index.html now that React
  // has committed its first render. useLayoutEffect runs synchronously
  // after the commit and before the browser paints, so the React tree
  // (which itself renders BootSplash while the session IPC resolves) is
  // on screen by the time the static splash disappears — no flash.
  useLayoutEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  // Keep the renderer-side Better-Auth cookie cache fresh as the user signs
  // in / out / their session rotates. Without this the SDK adapter would
  // hold a stale Cookie and start 401-ing post-rotation.
  useEffect(() => {
    return installRendererAuthCacheListeners();
  }, []);

  // One-shot cleanup of the retired shell-toggle key. Runs once on mount;
  // missing key / disabled storage are both fine to ignore.
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_SHELL_TOGGLE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RequireAuth>
            <UmamiIdentity />
            <AppShell />
          </RequireAuth>
        </TooltipProvider>
        {/*
          Sonner mounts its toast container inline (no React portal), so
          a `position: fixed` ancestor with `transform`, `filter`, or
          `will-change` would trap the container in that ancestor's
          stacking context and bury toasts under any dialog portaled to
          document.body (Settings overlay, AppIntegrationsDialog, etc.).
          Explicitly portal the Toaster to document.body so it always
          sits at the root stacking context where its `z-index:
          999999999` actually wins. Without this, an inert refactor
          upstream (animating a parent with `transform-gpu`, for
          example) would silently hide every error toast behind the
          Settings dialog.
        */}
        {createPortal(
          <Toaster
            // top-center on purpose: the right and right-bottom areas
            // often sit underneath a BrowserView (workspace browser
            // pane) which is an OS-level overlay above the HTML
            // renderer — anything sonner draws there gets visually
            // clipped or hidden behind it, and z-index can't beat a
            // BrowserView. Top-center is always pure HTML, can't be
            // covered.
            position="top-center"
            richColors
            theme="dark"
          />,
          document.body,
        )}
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
