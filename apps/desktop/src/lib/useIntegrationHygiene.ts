import { useCallback, useEffect, useRef, useState } from "react";
import {
  invalidateIntegrationAccountCache,
  useIntegrationAccountMetadata,
} from "./integrationAccountStore";
import {
  invalidateAllIntegrationConnections,
  listAllIntegrationConnections,
} from "./listAllIntegrationConnections";
import {
  isComposioConnectInFlight,
  listPendingComposioConnects,
  removePendingComposioConnect,
} from "./pendingComposioConnects";

// Background integration hygiene, lifted out of IntegrationsPane so it keeps
// running once that pane is retired. Three sweeps, behaviour-identical to the
// originals:
//   1. Pending-connect reconcile — delete the upstream Composio account left by
//      a connect abandoned via app-kill (recorded durably at connect-start).
//   2. Duplicate-account dedup/merge — for local bot-token rows that predate the
//      dedupe-on-finalize fix, group by (provider, identity), keep the oldest,
//      backfill identity, merge + drop the rest.
//   3. Zombie sweep — delete a local bot-token row whose whoami came back
//      "missing" (the upstream account is gone).
// Composio rows are remote-managed, so dedup/zombie only touch bot-token rows;
// the Composio side is covered by sweep #1. Mount this once on a persistent
// surface (the store).

const norm = (value: string | null | undefined): string => (value || "").trim();

export function useIntegrationHygiene(): void {
  const [connections, setConnections] = useState<IntegrationConnectionPayload[]>(
    [],
  );
  const metadata = useIntegrationAccountMetadata(connections);

  const reload = useCallback(async (): Promise<void> => {
    invalidateAllIntegrationConnections();
    try {
      const result = await listAllIntegrationConnections();
      setConnections(result.connections);
    } catch {
      // Keep the prior snapshot; a later sweep re-fetches.
    }
  }, []);

  const reconcilePending = useCallback(async (): Promise<void> => {
    const pendings = listPendingComposioConnects();
    for (const pending of pendings) {
      // Never touch a connect still mid-OAuth this session — its account reads
      // as UNKNOWN (indistinguishable from abandoned by status alone).
      if (isComposioConnectInFlight(pending.id)) {
        continue;
      }
      let isActive = false;
      try {
        const status = await window.electronAPI.workspace.composioAccountStatus(
          pending.id,
          pending.provider,
        );
        isActive = norm(status?.status).toUpperCase() === "ACTIVE";
      } catch {
        // Status unreadable — treat as abandoned and clean it up.
      }
      if (isActive) {
        removePendingComposioConnect(pending.id);
        continue;
      }
      await window.electronAPI.workspace
        .composioDeleteUpstream(pending.id)
        .catch(() => {});
      removePendingComposioConnect(pending.id);
    }
  }, []);

  // Initial load + pending-connect reconcile (once per mount).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await listAllIntegrationConnections();
        if (!cancelled) {
          setConnections(result.connections);
        }
      } catch {
        // ignore — the reconcile + reload below still run
      }
      await reconcilePending();
      if (!cancelled) {
        await reload();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reconcilePending, reload]);

  // Duplicate-account dedup/merge (bot-token rows only). Ported verbatim from
  // IntegrationsPane; `reload` stands in for the pane's `loadData`.
  const reconcileInFlightRef = useRef(false);
  const reconciledGroupKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (reconcileInFlightRef.current) {
      return;
    }
    if (connections.length < 2) {
      return;
    }
    if (metadata.size === 0) {
      return;
    }

    const probeable = connections.filter(
      (c) =>
        norm(c.auth_mode).toLowerCase() !== "composio" &&
        typeof c.account_external_id === "string" &&
        c.account_external_id.length > 0,
    );
    const haveAllProbeResultsOrPersistedIdentity = probeable.every(
      (c) =>
        metadata.has(c.connection_id) ||
        Boolean(c.account_handle) ||
        Boolean(c.account_email),
    );
    if (!haveAllProbeResultsOrPersistedIdentity) {
      return;
    }

    const groupKey = (
      provider: string,
      owner: string,
      handle: string | null,
      email: string | null,
    ): string | null => {
      const provNorm = provider.trim().toLowerCase();
      const ownerNorm = owner.trim().toLowerCase();
      if (!(provNorm && ownerNorm)) {
        return null;
      }
      const handleNorm = (handle ?? "").trim().toLowerCase();
      const emailNorm = (email ?? "").trim().toLowerCase();
      if (!(handleNorm || emailNorm)) {
        return null;
      }
      const idPart = handleNorm ? `h:${handleNorm}` : `e:${emailNorm}`;
      return `${provNorm}|o:${ownerNorm}|${idPart}`;
    };

    const groups = new Map<string, IntegrationConnectionPayload[]>();
    for (const conn of connections) {
      if (conn.status !== "active") {
        continue;
      }
      if (norm(conn.auth_mode).toLowerCase() === "composio") {
        continue;
      }
      const meta = metadata.get(conn.connection_id) ?? null;
      const handle = conn.account_handle ?? meta?.handle ?? null;
      const email = conn.account_email ?? meta?.email ?? null;
      const key = groupKey(conn.provider_id, conn.owner_user_id, handle, email);
      if (!key) {
        continue;
      }
      const list = groups.get(key);
      if (list) {
        list.push(conn);
      } else {
        groups.set(key, [conn]);
      }
    }

    const duplicateGroups = Array.from(groups.entries()).filter(
      ([, list]) => list.length >= 2,
    );
    const pendingGroups = duplicateGroups.filter(
      ([key]) => !reconciledGroupKeysRef.current.has(key),
    );
    if (pendingGroups.length === 0) {
      return;
    }

    reconcileInFlightRef.current = true;
    let cancelled = false;
    void (async () => {
      let didChange = false;
      try {
        for (const [key, group] of pendingGroups) {
          if (cancelled) {
            return;
          }
          reconciledGroupKeysRef.current.add(key);
          const sorted = group
            .slice()
            .sort((a, b) =>
              (a.created_at ?? "").localeCompare(b.created_at ?? ""),
            );
          const [keep, ...remove] = sorted;
          if (!keep || remove.length === 0) {
            continue;
          }

          for (const conn of [keep, ...remove]) {
            if (cancelled) {
              return;
            }
            if (conn.account_handle || conn.account_email) {
              continue;
            }
            const meta = metadata.get(conn.connection_id);
            const handle = meta?.handle ?? null;
            const email = meta?.email ?? null;
            if (!(handle || email)) {
              continue;
            }
            try {
              await window.electronAPI.workspace.updateIntegrationConnection(
                conn.connection_id,
                { account_handle: handle, account_email: email },
              );
            } catch {
              // Tolerate per-row backfill failure — merge passes ids explicitly.
            }
          }

          if (cancelled) {
            return;
          }
          try {
            await window.electronAPI.workspace.mergeIntegrationConnections(
              keep.connection_id,
              remove.map((r) => r.connection_id),
            );
            invalidateIntegrationAccountCache(
              remove.map((r) => r.connection_id),
            );
            didChange = true;
          } catch {
            // Merge failed — group stays marked attempted so it won't retry.
          }
        }
        if (!cancelled && didChange) {
          await reload();
        }
      } finally {
        reconcileInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connections, metadata]);

  // Zombie sweep: a local bot-token row whose whoami came back "missing" — the
  // upstream account is gone, so delete the local row.
  const zombieSweepInFlightRef = useRef(false);
  useEffect(() => {
    if (zombieSweepInFlightRef.current) {
      return;
    }
    if (connections.length === 0) {
      return;
    }
    const zombies = connections.filter(
      (c) =>
        norm(c.auth_mode).toLowerCase() !== "composio" &&
        metadata.get(c.connection_id)?.status === "missing",
    );
    if (zombies.length === 0) {
      return;
    }
    zombieSweepInFlightRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        for (const zombie of zombies) {
          if (cancelled) {
            return;
          }
          try {
            await window.electronAPI.workspace.deleteIntegrationConnection(
              zombie.connection_id,
            );
          } catch {
            // Per-row failure is fine — next mount retries.
          }
        }
        if (!cancelled) {
          invalidateIntegrationAccountCache(
            zombies.map((z) => z.connection_id),
          );
          await reload();
        }
      } finally {
        zombieSweepInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connections, metadata]);
}
