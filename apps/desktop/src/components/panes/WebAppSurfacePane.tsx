// Hosts a web HolaApp (need-review et al.) as its own center-column pane. The
// page is a remote web app served from `<WEB_APP_BASE_URL>/apps/<holaAppId>`,
// rendered in a native Electron BrowserView managed by the main process — NOT
// an iframe — so the host bridge (window.__holabossHost) is available to it.
//
// This pane is the renderer half: a thin header (title + close) plus a viewport
// the native surface is positioned over (mirroring BrowserPane). The native
// view paints on top of this DOM, so only the header + an error fallback render
// here (the fallback shows when the surface is detached, i.e. bounds = 0).

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  activeWebAppSurfaceAtom,
  centerFullscreenAtom,
  sidebarCollapsedAtom,
} from "@/components/layout/shell/state/ui";
import { Loader2, RefreshCw, X } from "@/components/ui/icons";
import { useStoplightCompensation } from "@/lib/StoplightContext";

interface WebAppSurfacePaneProps {
  holaAppId: string;
  title: string;
  /** Optional URL suffix appended verbatim (leading `/` or `?`), e.g.
   * `?record=<id>` for a deep-link. */
  path?: string;
  /** Absolute URL for third-party apps (e.g. Notion); when omitted the surface
   * derives `<WEB_APP_BASE_URL>/apps/<holaAppId>`. */
  url?: string;
  /** When a renderer overlay/dialog is open, collapse the native view to 0×0
   * so it doesn't paint over the overlay (mirrors BrowserPane). */
  suspendNativeView?: boolean;
  /** Dismiss the pane (clears the active web-app-surface atom). */
  onClose: () => void;
  /** Drop the surface header (title + refresh + close). Used by first-class
   * native overlays like Home that keep the sidebar as their exit — the
   * app-chrome header is reserved for HolaApps opened in the center. */
  chromeless?: boolean;
  /** The page reads its `?query`/`#hash` client-side (React Router
   * useSearchParams). When only `path` changes (same holaAppId + url), switch
   * the warm surface via client-side history.pushState instead of a reload —
   * instant, no "Opening…" flash. Used by the Cloud rail's ?section= nav. */
  queryDriven?: boolean;
}

export function WebAppSurfacePane({
  holaAppId,
  title,
  path,
  url,
  suspendNativeView = false,
  onClose,
  chromeless = false,
  queryDriven = false,
}: WebAppSurfacePaneProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Identity = which app/page (holaAppId + absolute url). A change here is a real
  // cold load (spinner). A path-only change on a query-driven surface is a warm
  // client-side swap — no spinner, keep the current pixels.
  const prevIdentityRef = useRef<string | null>(null);
  const setActiveSurface = useSetAtom(activeWebAppSurfaceAtom);
  const reserveStoplightGutter = useStoplightCompensation();
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const centerFullscreen = useAtomValue(centerFullscreenAtom);
  const [error, setError] = useState("");
  // True while the native surface is loading the page. The native BrowserView
  // paints on top of this DOM, so we collapse it to 0×0 while loading (see the
  // bounds effect) to reveal the loading screen, then expand it once the page
  // is ready — avoiding a blank/white flash and any stale prior content.
  const [loading, setLoading] = useState(true);

  // Refresh = re-navigate the surface to the same URL. The web HolaApp view is
  // keyed by a namespaced surface key (not the raw holaAppId), so the generic
  // appSurface.reload(appId) would miss it — navigateWebApp targets it correctly
  // and reloads the page.
  const handleRefresh = () => {
    setError("");
    setLoading(true);
    window.electronAPI.appSurface
      // forceReload: Refresh must re-load even if the view is already on this URL
      // (the warm-reopen short-circuit in main would otherwise skip it).
      .navigateWebApp(holaAppId, path, url, true)
      .then(() => setLoading(false))
      .catch((err: unknown) => {
        setLoading(false);
        setError(
          err instanceof Error ? err.message : "Failed to refresh this HolaApp."
        );
      });
  };

  // Load the page into the native surface whenever the target changes. A real
  // identity change (holaAppId / url) is a cold load, so show the spinner. A
  // query-only change on a query-driven surface (the Cloud rail switching
  // ?section=) soft-navigates the warm page client-side — keep the current
  // pixels, no spinner / 0×0 collapse.
  useEffect(() => {
    let cancelled = false;
    const identity = `${holaAppId} ${url ?? ""}`;
    const identityChanged = prevIdentityRef.current !== identity;
    prevIdentityRef.current = identity;
    setError("");
    if (identityChanged || !queryDriven) {
      setLoading(true);
    }
    window.electronAPI.appSurface
      .navigateWebApp(holaAppId, path, url, false, queryDriven)
      .then(() => {
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoading(false);
          setError(
            err instanceof Error ? err.message : "Failed to open this HolaApp."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [holaAppId, path, url, queryDriven]);

  // Keep the native surface aligned to the viewport rect. When suspended,
  // loading, or errored, collapse it to 0×0 so the DOM (loading screen / error)
  // shows through.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    if (suspendNativeView || error || loading) {
      window.electronAPI.appSurface.setBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
      return;
    }

    let rafId = 0;
    const syncBounds = () => {
      const rect = viewport.getBoundingClientRect();
      window.electronAPI.appSurface.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    const queueSync = () => {
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(syncBounds);
    };

    queueSync();
    const observer = new ResizeObserver(queueSync);
    observer.observe(viewport);
    window.addEventListener("resize", queueSync);
    // Re-sync after the chat-collapse animation settles (mirrors BrowserPane).
    window.setTimeout(queueSync, 100);
    window.setTimeout(queueSync, 400);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", queueSync);
      window.cancelAnimationFrame(rafId);
    };
    // Re-sync when the sidebar collapse state changes: collapsing/expanding it
    // shifts the surface's left edge + width, so the native bounds must follow.
  }, [suspendNativeView, error, loading, sidebarCollapsed, centerFullscreen]);

  // Track the surface's live location (current page URL + title) into the active
  // surface atom, so the chat copilot's context reflects the page the user is
  // actually viewing — including SPA navigation inside third-party apps (Notion).
  // Only updates this surface's entry, and only when the value actually changed.
  useEffect(() => {
    const off = window.electronAPI.appSurface.onLocationChanged((payload) => {
      if (payload.appId !== holaAppId) {
        return;
      }
      setActiveSurface((prev) => {
        if (!prev || prev.holaAppId !== holaAppId) {
          return prev;
        }
        if (prev.currentUrl === payload.url && prev.currentTitle === payload.title) {
          return prev;
        }
        return { ...prev, currentUrl: payload.url, currentTitle: payload.title };
      });
    });
    return off;
  }, [holaAppId, setActiveSurface]);

  // Detach the native surface when this pane unmounts (switched away / closed).
  useEffect(() => {
    return () => {
      window.electronAPI.appSurface.hide();
    };
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {chromeless ? (
        // Chromeless surfaces (Home) drop the app header for an immersive
        // full-width web surface, but keep a slim top strip as (a) a stable
        // window-drag handle over the native view and (b) a clear gutter for the
        // macOS stoplights + AppShell's floating sidebar-expand button, which both
        // sit at the window's top-left. The native BrowserView paints above all
        // renderer DOM, so without this strip it occludes that expand button when
        // the sidebar is collapsed. Persistent (not collapse-gated) so toggling
        // the sidebar doesn't shift the surface vertically.
        <div className="window-drag h-9 shrink-0 bg-background" />
      ) : (
        <div
          className="window-drag flex h-9 shrink-0 items-center gap-2 border-neutral-200 border-b pr-3 transition-[padding-left] duration-stride ease-out-expo dark:border-neutral-800"
          style={{
            // Clear the macOS stoplights + the floating sidebar-expand button that
            // sit at the window's top-left while the sidebar is collapsed (opening a
            // HolaApp collapses it) — otherwise the app name hides behind them.
            // Mirrors TopChrome's gutter math.
            paddingLeft: centerFullscreen
              ? reserveStoplightGutter
                ? "5rem"
                : "0.5rem"
              : sidebarCollapsed
                ? reserveStoplightGutter
                  ? "7.25rem"
                  : "2.75rem"
                : "0.75rem",
          }}
        >
          <span className="truncate font-medium text-neutral-700 text-sm dark:text-neutral-200">
            {title}
          </span>
          <button
            aria-label="Refresh HolaApp"
            className="window-no-drag ml-auto grid size-6 place-items-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            onClick={handleRefresh}
            type="button"
          >
            <RefreshCw className="size-4" />
          </button>
          {/* Close returns to the chat/workspace view. Without it — now that
              opening a HolaApp also hides the chat toolbar toggle and collapses
              the sidebar — the surface has no on-screen exit back to chat. */}
          <button
            aria-label="Close HolaApp"
            className="window-no-drag grid size-6 place-items-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1" ref={viewportRef}>
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <div className="max-w-sm text-neutral-500 text-sm">{error}</div>
          </div>
        ) : loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background">
            <Loader2 className="size-7 animate-spin text-muted-foreground/70" />
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-medium text-foreground text-sm">
                {title}
              </span>
              <span className="text-muted-foreground text-xs">Opening…</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
