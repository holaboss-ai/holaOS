import { atom, useAtom } from "jotai";
import { useCallback } from "react";
import { type AppCatalogEntry, marketplace } from "@/lib/holaAppMarketplace";

// Shared HolaApp catalog: the available apps plus this user's install state. The launcher
// and the marketplace dialog both read + refresh this atom, so an install/uninstall in the
// dialog immediately reflects in the sidebar (and vice-versa). Backed by the marketplace
// client adapter — today a local stub, later the server.
const holaAppCatalogAtom = atom<AppCatalogEntry[]>([]);

export function useHolaAppCatalog() {
  const [catalog, setCatalog] = useAtom(holaAppCatalogAtom);

  const refresh = useCallback(async () => {
    setCatalog(await marketplace.listCatalog());
  }, [setCatalog]);

  const install = useCallback(
    async (holaAppId: string) => {
      await marketplace.install(holaAppId);
      await refresh();
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (holaAppId: string) => {
      await marketplace.uninstall(holaAppId);
      await refresh();
    },
    [refresh],
  );

  return {
    catalog,
    installed: catalog.filter((app) => app.installed),
    refresh,
    install,
    uninstall,
  };
}
