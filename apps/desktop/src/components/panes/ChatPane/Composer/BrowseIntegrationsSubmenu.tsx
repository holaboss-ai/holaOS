import { useOpenDiscover } from "@/components/layout/shell/useOpenDiscover";
import { AppIcon } from "@/components/marketplace/AppIcon";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Check, Store } from "@/components/ui/icons";
import { listAllIntegrationConnections } from "@/lib/listAllIntegrationConnections";
import { recommendToolkits } from "@/lib/recommendToolkits";
import {
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { useCallback, useEffect, useMemo, useState } from "react";

const SUBMENU_LIMIT = 6;

// Compact override for menu items in this surface — base DropdownMenuItem
// is `rounded-xl px-3 py-2 gap-2.5`, which reads as oversized for a quick
// quick-connect catalog. tailwind-merge lets the later utilities win.
const COMPACT_ITEM_CLASS = "rounded-md gap-2 px-2 py-1.5 text-[13px]";

interface BrowseIntegrationsSubmenuProps {
  /** Drop an integration mention chip into the composer when clicked. */
  onSelectIntegration: (slug: string, name: string) => void;
}

/**
 * Contents of the "Browse integrations" cascading submenu off the
 * composer's `+` button. Lists up to SUBMENU_LIMIT toolkits — connected
 * ones first, then recommended.
 *
 * Clicking a row drops an integration mention chip into the composer
 * (closes the menu via default item behavior). Already-connected rows show
 * a trailing Check as an informational marker. Connecting a new toolkit
 * happens in the Marketplace via "Browse integrations" at the bottom.
 */
export function BrowseIntegrationsSubmenu({
  onSelectIntegration,
}: BrowseIntegrationsSubmenuProps) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const openDiscover = useOpenDiscover();

  const [connections, setConnections] = useState<
    IntegrationConnectionPayload[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result =
          await listAllIntegrationConnections();
        if (!cancelled) {
          setConnections(result.connections);
        }
      } catch {
        if (!cancelled) {
          setConnections([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connectedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.status === "active") {
        set.add(composioToolkitSlugForProvider(c.provider_id));
      }
    }
    return set;
  }, [connections]);

  const toolkitList = useMemo(
    () => Object.values(composioToolkitsByProvider),
    [composioToolkitsByProvider],
  );

  const items = useMemo(() => {
    const connectedToolkits = Array.from(connectedSlugs)
      .map((slug) => composioToolkitsByProvider[slug])
      .filter((t): t is (typeof toolkitList)[number] => Boolean(t));

    const recommendations = recommendToolkits({
      toolkits: toolkitList,
      connectedSlugs,
      limit: SUBMENU_LIMIT,
    });

    const seen = new Set<string>();
    const combined: typeof toolkitList = [];
    for (const t of [...connectedToolkits, ...recommendations]) {
      if (seen.has(t.slug)) continue;
      seen.add(t.slug);
      combined.push(t);
      if (combined.length >= SUBMENU_LIMIT) break;
    }
    return combined;
  }, [connectedSlugs, toolkitList, composioToolkitsByProvider]);

  const openBrowse = useCallback(() => {
    openDiscover("/marketplace?type=integration");
  }, [openDiscover]);

  if (toolkitList.length === 0) {
    return (
      <DropdownMenuItem className={COMPACT_ITEM_CLASS} onClick={openBrowse}>
        <Store className="size-4" />
        Browse integrations
      </DropdownMenuItem>
    );
  }

  return (
    <>
      {items.map((toolkit) => {
        const isConnected = connectedSlugs.has(toolkit.slug);
        return (
          <DropdownMenuItem
            className={COMPACT_ITEM_CLASS}
            key={toolkit.slug}
            onClick={() => onSelectIntegration(toolkit.slug, toolkit.name)}
          >
            <AppIcon
              appId={toolkit.slug}
              iconUrl={toolkit.logo}
              label={toolkit.name}
              providerId={toolkit.slug}
              size="row"
            />
            <span className="flex-1 truncate">{toolkit.name}</span>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator className="my-1" />
      <DropdownMenuItem className={COMPACT_ITEM_CLASS} onClick={openBrowse}>
        <Store className="size-4" />
        Browse integrations
      </DropdownMenuItem>
    </>
  );
}
