import { useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import {
  type AppCatalogEntry,
  appKind,
  catalogEntryToOpenParams,
  marketplace,
} from "@/lib/holaAppMarketplace";
import { pendingHubAppDetailAtom, workspaceOverlayAtom } from "./state/ui";
import { useHolaAppCatalog } from "./useHolaAppCatalog";
import { useOpenHolaApp } from "./useOpenHolaApp";

/**
 * Bridges the host op `window.__holabossHost.item.open` (for a holaapp) into the
 * shell. Main emits `host:openApp` with the item's catalog ref; here we resolve
 * the full app definition from the catalog by `holaAppId` and open it. A normal
 * app opens its web surface; a connection-tier App has no surface, so it opens
 * its native manage detail (the store's ConnectionAppDetail) instead — that's the
 * "Manage" jump from HolaHub. (skill/mcp/capability opens are handled in main via
 * the chat flow and never reach here.) Mount once at the shell root.
 */
export function useHostOpenApp(): void {
  const openHolaApp = useOpenHolaApp();
  const { catalog } = useHolaAppCatalog();
  const setPendingHubAppDetail = useSetAtom(pendingHubAppDetailAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);

  const openEntry = useCallback(
    (entry: AppCatalogEntry) => {
      if (appKind(entry) === "connection") {
        // No app surface to open — focus it in the native store, which renders
        // its ConnectionAppDetail (connected accounts, refresh, disconnect).
        setPendingHubAppDetail(entry.holaAppId);
        setWorkspaceOverlay("apps");
        return;
      }
      openHolaApp(catalogEntryToOpenParams(entry));
    },
    [openHolaApp, setPendingHubAppDetail, setWorkspaceOverlay]
  );

  useEffect(() => {
    const off = window.electronAPI.host.onOpenApp(({ ref }) => {
      const target = typeof ref === "string" ? ref.trim() : "";
      if (!target) {
        return;
      }
      const found = catalog.find((entry) => entry.holaAppId === target);
      if (found) {
        openEntry(found);
        return;
      }
      // Local catalog is stale (e.g. installed on another surface) — refetch and
      // open once resolved. No-op if the ref still isn't a known app.
      void marketplace.listCatalog().then((fresh) => {
        const entry = fresh.find((e) => e.holaAppId === target);
        if (entry) {
          openEntry(entry);
        }
      });
    });
    return off;
  }, [catalog, openEntry]);
}
