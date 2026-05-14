import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
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

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <UmamiIdentity />
          <AppShell />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
