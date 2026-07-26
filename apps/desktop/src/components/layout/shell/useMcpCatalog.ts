import { atom, useAtom } from "jotai";
import { useCallback } from "react";
import {
  installMcp,
  listMcpCatalog,
  type McpCatalogEntry,
  syncInstalledMcps,
  uninstallMcp,
} from "@/lib/mcpMarketplace";

// Shared MCP-server catalog: the available servers plus this machine's local install
// state. Mirrors useHolaAppCatalog, but MCP install state (and credentials) live ONLY in
// localStorage — never on the backend — so the catalog's `installed` flag is derived
// locally and refresh re-syncs the resolved configs to the Electron main process.
const mcpCatalogAtom = atom<McpCatalogEntry[]>([]);

export function useMcpCatalog() {
  const [catalog, setCatalog] = useAtom(mcpCatalogAtom);

  const refresh = useCallback(async () => {
    const next = await listMcpCatalog();
    setCatalog(next);
    // Keep main in sync with what's installed (covers app restart) so its per-turn
    // re-attach refreshes the Holaboss session bearer for hosted servers.
    await syncInstalledMcps(next);
  }, [setCatalog]);

  const install = useCallback(
    async (
      entry: McpCatalogEntry,
      values: Record<string, string>,
      ownerAppId?: string,
    ) => {
      await installMcp(entry, values, ownerAppId);
      await refresh();
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (id: string) => {
      await uninstallMcp(id);
      await refresh();
    },
    [refresh],
  );

  return { catalog, refresh, install, uninstall };
}
