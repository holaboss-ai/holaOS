import { listAllIntegrationConnections } from "@/lib/listAllIntegrationConnections";
import { useEffect, useMemo, useState } from "react";
import { recommendToolkits } from "@/lib/recommendToolkits";
import {
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";

export interface WorkspaceIntegrationItem {
  key: string;
  slug: string;
  name: string;
  logo: string | null;
}

export interface WorkspaceIntegrationItems {
  /** False while connections load or before the toolkit catalog surfaces. */
  ready: boolean;
  hasConnections: boolean;
  /** Connected toolkits when `hasConnections`, otherwise recommendations. */
  items: WorkspaceIntegrationItem[];
  hiddenCount: number;
}

/**
 * Shared data for the workspace integrations surfaces: loads the active
 * connections, groups them by toolkit, and falls back to recommended toolkits
 * when nothing is connected yet. Consumed by both the full integrations rail
 * and the compact runtime-context caption.
 */
export function useWorkspaceIntegrationItems(
  workspaceHint: string | null | undefined,
  limit: number,
): WorkspaceIntegrationItems {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();

  const [connections, setConnections] = useState<
    IntegrationConnectionPayload[]
  >([]);
  const [isLoadingConnections, setIsLoadingConnections] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingConnections(true);
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
      } finally {
        if (!cancelled) {
          setIsLoadingConnections(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeConnections = useMemo(
    () => connections.filter((c) => c.status === "active"),
    [connections],
  );

  const providerGroups = useMemo(() => {
    const map = new Map<string, IntegrationConnectionPayload[]>();
    for (const c of activeConnections) {
      const slug = composioToolkitSlugForProvider(c.provider_id);
      const list = map.get(slug) ?? [];
      list.push(c);
      map.set(slug, list);
    }
    return map;
  }, [activeConnections]);

  const connectedSlugs = useMemo(
    () => new Set(providerGroups.keys()),
    [providerGroups],
  );

  const toolkitList = useMemo(
    () => Object.values(composioToolkitsByProvider),
    [composioToolkitsByProvider],
  );

  const recommendations = useMemo(
    () =>
      recommendToolkits({
        toolkits: toolkitList,
        connectedSlugs,
        workspaceHint,
        limit,
      }),
    [toolkitList, connectedSlugs, workspaceHint, limit],
  );

  const hasConnections = providerGroups.size > 0;

  const items: WorkspaceIntegrationItem[] = hasConnections
    ? Array.from(providerGroups.keys())
        .slice(0, limit)
        .map((slug) => {
          const toolkit = composioToolkitsByProvider[slug];
          return {
            key: slug,
            slug,
            name: toolkit?.name ?? slug,
            logo: toolkit?.logo ?? null,
          };
        })
    : recommendations.slice(0, limit).map((toolkit) => ({
        key: toolkit.slug,
        slug: toolkit.slug,
        name: toolkit.name,
        logo: toolkit.logo,
      }));

  const hiddenCount = hasConnections
    ? Math.max(0, providerGroups.size - items.length)
    : 0;

  const ready = !isLoadingConnections && toolkitList.length > 0;

  return { ready, hasConnections, items, hiddenCount };
}

/**
 * The set of toolkit slugs the workspace has a connection for, derived live
 * from the connection list. "Connected" here means a connection record exists
 * (active OR expired) — an expired token still means the user set the
 * integration up; it needs re-auth, not a first-time connect. Use this to
 * reflect real-time state instead of a stale snapshot (e.g. a capability's
 * `integrationStatus`, computed once at install time).
 */
export function useConnectedToolkitSlugs(): {
  ready: boolean;
  connectedSlugs: Set<string>;
} {
  const [connectedSlugs, setConnectedSlugs] = useState<Set<string>>(
    () => new Set(),
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        const result =
          await listAllIntegrationConnections();
        if (cancelled) {
          return;
        }
        const slugs = new Set<string>();
        for (const c of result.connections) {
          if (c.status === "active" || c.status === "expired") {
            slugs.add(composioToolkitSlugForProvider(c.provider_id));
          }
        }
        setConnectedSlugs(slugs);
      } catch {
        if (!cancelled) {
          setConnectedSlugs(new Set());
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { ready, connectedSlugs };
}
