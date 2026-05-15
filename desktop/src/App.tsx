import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { NewAppShell } from "@/components/layout/new-shell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

const NEW_SHELL_STORAGE_KEY = "holaboss-new-layout-shell-v1";
import {
  identifyUmamiUser,
  trackUmamiEvent,
} from "@/lib/analytics/umami";
import { installRendererAuthCacheListeners } from "@/lib/app-sdk-client";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { TooltipProvider } from "./components/ui/tooltip";

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
  // (which itself shows WorkspaceBootstrapPane during workspace
  // hydration) is on screen by the time the static splash disappears —
  // no flash.
  useLayoutEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  // Keep the renderer-side Better-Auth cookie cache fresh as the user signs
  // in / out / their session rotates. Without this the SDK adapter would
  // hold a stale Cookie and start 401-ing post-rotation.
  useEffect(() => {
    return installRendererAuthCacheListeners();
  }, []);

  // Side-by-side layout redesign. VITE_NEW_LAYOUT_SHELL=1 forces the new
  // shell at boot; otherwise the toggle button persists user choice in
  // localStorage. See holaOS/docs/plans/2026-05-14-layout-redesign-audit.md.
  const [useNewShell, setUseNewShell] = useState(() => {
    if (import.meta.env.VITE_NEW_LAYOUT_SHELL === "1") return true;
    try {
      return localStorage.getItem(NEW_SHELL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(NEW_SHELL_STORAGE_KEY, useNewShell ? "1" : "0");
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [useNewShell]);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <UmamiIdentity />
          {useNewShell ? <NewAppShell /> : <AppShell />}
          <ShellToggle
            useNewShell={useNewShell}
            onToggle={() => setUseNewShell((v) => !v)}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

function ShellToggle({
  useNewShell,
  onToggle,
}: {
  useNewShell: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="fixed right-3 bottom-3 z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
      title="Toggle layout shell (dev preview)"
    >
      <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      Layout: {useNewShell ? "new" : "current"}
    </button>
  );
}

export default App;
