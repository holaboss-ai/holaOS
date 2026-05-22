import { randomUUID } from "node:crypto";

import {
  type IntegrationConnectionRecord,
  type RuntimeStateStore,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import {
  type IntegrationContextFetchProgressSnapshot,
  type IntegrationContextFetchResult,
  supportsIntegrationContextFetchProvider,
} from "./integration-context-fetch.js";

export interface IntegrationContextFetchStatusPayload {
  connection_id: string;
  provider_id: string;
  run_id: string;
  supported: boolean;
  status: "running" | "completed" | "failed" | "unsupported";
  account_key: string | null;
  account_label: string | null;
  tree_id: string | null;
  current_chunk_label: string | null;
  chunks_total: number;
  chunks_completed: number;
  messages_seen: number;
  messages_persisted: number;
  leaves_created: number;
  leaves_superseding: number;
  leaves_unchanged: number;
  summary_nodes: number;
  actions: string[];
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  fetched_at: string | null;
  error_message: string | null;
  reason: string | null;
}

export interface IntegrationContextFetchStartResponsePayload {
  ok: true;
  started: boolean;
  deduped: boolean;
  status: IntegrationContextFetchStatusPayload;
}

export interface IntegrationContextFetchStatusListResponsePayload {
  ok: true;
  statuses: IntegrationContextFetchStatusPayload[];
}

export type IntegrationContextFetchRunner = (params: {
  store: RuntimeStateStore;
  connectionId: string;
  onProgress?: ((snapshot: IntegrationContextFetchProgressSnapshot) => void) | null;
}) => Promise<IntegrationContextFetchResult>;

interface IntegrationContextFetchLogger {
  warn: (meta: Record<string, unknown>, message: string) => void;
}

function cloneStatus(
  status: IntegrationContextFetchStatusPayload,
): IntegrationContextFetchStatusPayload {
  return {
    ...status,
    actions: [...status.actions],
  };
}

function connectionAccountKey(
  connection: IntegrationConnectionRecord,
): string | null {
  const candidates = [
    connection.accountHandle,
    connection.accountEmail,
    connection.accountExternalId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = candidate.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function baseStatusForConnection(params: {
  connection: IntegrationConnectionRecord;
  providerId: string;
  runId: string;
  supported: boolean;
  status: IntegrationContextFetchStatusPayload["status"];
  now: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  reason?: string | null;
}): IntegrationContextFetchStatusPayload {
  return {
    connection_id: params.connection.connectionId,
    provider_id: params.providerId,
    run_id: params.runId,
    supported: params.supported,
    status: params.status,
    account_key: connectionAccountKey(params.connection),
    account_label: params.connection.accountLabel || null,
    tree_id: null,
    current_chunk_label: null,
    chunks_total: 0,
    chunks_completed: 0,
    messages_seen: 0,
    messages_persisted: 0,
    leaves_created: 0,
    leaves_superseding: 0,
    leaves_unchanged: 0,
    summary_nodes: 0,
    actions: [],
    started_at: params.startedAt ?? null,
    updated_at: params.now,
    completed_at: params.completedAt ?? null,
    fetched_at: null,
    error_message: params.errorMessage ?? null,
    reason: params.reason ?? null,
  };
}

export function createIntegrationContextFetchManager(params: {
  store: RuntimeStateStore;
  runFetch: IntegrationContextFetchRunner;
  logger?: IntegrationContextFetchLogger | null;
}) {
  const inFlight = new Map<string, Promise<void>>();
  const statusByConnectionId = new Map<
    string,
    IntegrationContextFetchStatusPayload
  >();

  function setStatus(
    connectionId: string,
    next: Partial<IntegrationContextFetchStatusPayload>,
  ): IntegrationContextFetchStatusPayload | null {
    const existing = statusByConnectionId.get(connectionId);
    if (!existing) {
      return null;
    }
    const updatedAt = next.updated_at ?? utcNowIso();
    const merged: IntegrationContextFetchStatusPayload = {
      ...existing,
      ...next,
      updated_at: updatedAt,
      actions: next.actions ? [...next.actions] : existing.actions,
    };
    statusByConnectionId.set(connectionId, merged);
    return cloneStatus(merged);
  }

  function persistConnectionFetchState(
    connection: IntegrationConnectionRecord,
    updates: {
      lastContextFetchAttemptedAt?: string | null;
      lastContextFetchCompletedAt?: string | null;
      lastContextFetchStatus?: string | null;
    },
  ): void {
    const latestConnection =
      params.store.getIntegrationConnection(connection.connectionId) ?? connection;
    params.store.upsertIntegrationConnection({
      connectionId: latestConnection.connectionId,
      providerId: latestConnection.providerId,
      ownerUserId: latestConnection.ownerUserId,
      accountLabel: latestConnection.accountLabel,
      accountExternalId: latestConnection.accountExternalId,
      accountHandle: latestConnection.accountHandle,
      accountEmail: latestConnection.accountEmail,
      contextCronAutoFetchEnabled:
        latestConnection.contextCronAutoFetchEnabled,
      lastContextFetchAttemptedAt:
        updates.lastContextFetchAttemptedAt !== undefined
          ? updates.lastContextFetchAttemptedAt
          : latestConnection.lastContextFetchAttemptedAt,
      lastContextFetchCompletedAt:
        updates.lastContextFetchCompletedAt !== undefined
          ? updates.lastContextFetchCompletedAt
          : latestConnection.lastContextFetchCompletedAt,
      lastContextFetchStatus:
        updates.lastContextFetchStatus !== undefined
          ? updates.lastContextFetchStatus
          : latestConnection.lastContextFetchStatus,
      authMode: latestConnection.authMode,
      grantedScopes: latestConnection.grantedScopes,
      status: latestConnection.status,
      secretRef: latestConnection.secretRef,
    });
  }

  async function start(paramsForStart: {
    connectionId: string;
  }): Promise<IntegrationContextFetchStartResponsePayload> {
    const connection = params.store.getIntegrationConnection(
      paramsForStart.connectionId,
    );
    if (!connection) {
      throw new Error(
        `integration connection ${paramsForStart.connectionId} not found`,
      );
    }
    const connectionId = connection.connectionId;
    const providerId = connection.providerId.trim().toLowerCase();
    const existingTask = inFlight.get(connectionId);
    if (existingTask) {
      const existingStatus = statusByConnectionId.get(connectionId);
      if (!existingStatus) {
        throw new Error(
          `integration context fetch status missing for ${connectionId}`,
        );
      }
      return {
        ok: true,
        started: false,
        deduped: true,
        status: cloneStatus(existingStatus),
      };
    }

    const now = utcNowIso();
    if (!supportsIntegrationContextFetchProvider(providerId)) {
      persistConnectionFetchState(connection, {
        lastContextFetchAttemptedAt: now,
        lastContextFetchCompletedAt: now,
        lastContextFetchStatus: "unsupported",
      });
      const unsupportedStatus = baseStatusForConnection({
        connection,
        providerId,
        runId: randomUUID(),
        supported: false,
        status: "unsupported",
        now,
        completedAt: now,
        reason: `Context fetch is not implemented for ${providerId}.`,
      });
      statusByConnectionId.set(connectionId, unsupportedStatus);
      return {
        ok: true,
        started: false,
        deduped: false,
        status: cloneStatus(unsupportedStatus),
      };
    }

    const initialStatus = baseStatusForConnection({
      connection,
      providerId,
      runId: randomUUID(),
      supported: true,
      status: "running",
      now,
      startedAt: now,
    });
    statusByConnectionId.set(connectionId, initialStatus);
    persistConnectionFetchState(connection, {
      lastContextFetchAttemptedAt: now,
      lastContextFetchStatus: "running",
    });

    const task = (async () => {
      try {
        const result = await params.runFetch({
          store: params.store,
          connectionId,
          onProgress: (snapshot) => {
            setStatus(connectionId, {
              supported: true,
              status: "running",
              account_key: snapshot.account_key,
              account_label: snapshot.account_label,
              tree_id: snapshot.tree_id,
              current_chunk_label: snapshot.current_chunk_label,
              chunks_total: snapshot.chunks_total,
              chunks_completed: snapshot.chunks_completed,
              messages_seen: snapshot.messages_seen,
              messages_persisted: snapshot.messages_persisted,
              leaves_created: snapshot.leaves_created,
              leaves_superseding: snapshot.leaves_superseding,
              leaves_unchanged: snapshot.leaves_unchanged,
              summary_nodes: snapshot.summary_nodes,
              actions: snapshot.actions,
              error_message: null,
              reason: null,
            });
          },
        });
        const completedAt = utcNowIso();
        setStatus(connectionId, {
          supported: result.supported,
          status: result.supported ? "completed" : "unsupported",
          provider_id: result.provider_id,
          account_key: result.account_key,
          account_label: result.account_label,
          tree_id: result.tree_id,
          chunks_completed: Math.max(
            statusByConnectionId.get(connectionId)?.chunks_completed ?? 0,
            statusByConnectionId.get(connectionId)?.chunks_total ?? 0,
          ),
          leaves_created: result.leaves_created,
          leaves_superseding: result.leaves_superseding,
          leaves_unchanged: result.leaves_unchanged,
          messages_seen: result.messages_seen,
          messages_persisted: result.messages_persisted,
          summary_nodes: result.summary_nodes,
          actions: result.actions,
          fetched_at: result.fetched_at,
          completed_at: completedAt,
          current_chunk_label: result.supported
            ? `Fetched ${result.provider_id} context`
            : `Context fetch unavailable for ${result.provider_id}`,
          error_message: null,
          reason: result.reason ?? null,
        });
        persistConnectionFetchState(connection, {
          lastContextFetchAttemptedAt: now,
          lastContextFetchCompletedAt: completedAt,
          lastContextFetchStatus: result.supported ? "completed" : "unsupported",
        });
      } catch (error) {
        const completedAt = utcNowIso();
        const message = error instanceof Error ? error.message : String(error);
        setStatus(connectionId, {
          status: "failed",
          completed_at: completedAt,
          current_chunk_label: `Context fetch failed for ${providerId}`,
          error_message: message,
        });
        params.logger?.warn(
          {
            connectionId,
            providerId,
          error: message,
          },
          "integration context fetch failed",
        );
        persistConnectionFetchState(connection, {
          lastContextFetchAttemptedAt: now,
          lastContextFetchStatus: "failed",
        });
      } finally {
        inFlight.delete(connectionId);
      }
    })();
    inFlight.set(connectionId, task);

    return {
      ok: true,
      started: true,
      deduped: false,
      status: cloneStatus(statusByConnectionId.get(connectionId)!),
    };
  }

  function list(paramsForList: {
    connectionIds?: string[] | null;
  } = {}): IntegrationContextFetchStatusListResponsePayload {
    if (paramsForList.connectionIds && paramsForList.connectionIds.length > 0) {
      return {
        ok: true,
        statuses: paramsForList.connectionIds
          .map((connectionId) => statusByConnectionId.get(connectionId))
          .filter(
            (
              status,
            ): status is IntegrationContextFetchStatusPayload => Boolean(status),
          )
          .map((status) => cloneStatus(status)),
      };
    }
    return {
      ok: true,
      statuses: Array.from(statusByConnectionId.values())
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map((status) => cloneStatus(status)),
    };
  }

  return {
    list,
    start,
  };
}
