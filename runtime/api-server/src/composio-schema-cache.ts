import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import { listConnectionsMerged } from "./integration-connections-merged.js";

import {
  buildToolkitCatalogFromUpstream,
  type ComposioMcpToolEntry,
  type ComposioUpstreamTool,
} from "./composio-tool-registry.js";

// One hour: catalogs are stable enough that hourly refetches are cheap, and
// upstream catalog fixes propagate the same day instead of after a 24h wait.
export const COMPOSIO_SCHEMA_TTL_MS = 60 * 60 * 1000;

type FetchTools = (slug: string) => Promise<ComposioUpstreamTool[]>;

interface SchemaCacheDeps {
  store: Pick<
    RuntimeStateStore,
    "getComposioToolSchemas" | "upsertComposioToolSchemas" | "deleteComposioToolSchemas"
  >;
  fetchTools: FetchTools;
  ttlMs?: number;
  clock?: () => number;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class ComposioSchemaCacheError extends Error {
  constructor(public readonly toolkitSlug: string, message: string) {
    super(message);
    this.name = "ComposioSchemaCacheError";
  }
}

export class ComposioSchemaCache {
  private readonly store: SchemaCacheDeps["store"];
  private readonly fetchTools: FetchTools;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly logger: NonNullable<SchemaCacheDeps["logger"]>;

  constructor(deps: SchemaCacheDeps) {
    this.store = deps.store;
    this.fetchTools = deps.fetchTools;
    this.ttlMs = deps.ttlMs ?? COMPOSIO_SCHEMA_TTL_MS;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? {
      info: () => {},
      warn: () => {},
    };
  }

  async get(
    toolkitSlug: string,
    connectedAccountId: string,
  ): Promise<ComposioMcpToolEntry[]> {
    const slug = normalizeSlug(toolkitSlug);
    if (!slug) {
      throw new ComposioSchemaCacheError(toolkitSlug, "toolkit slug is required");
    }
    const cached = this.readFresh(slug);
    if (cached) {
      return rehydrate(cached, slug, connectedAccountId);
    }
    return await this.refresh(slug, connectedAccountId);
  }

  async refresh(
    toolkitSlug: string,
    connectedAccountId: string,
  ): Promise<ComposioMcpToolEntry[]> {
    const slug = normalizeSlug(toolkitSlug);
    if (!slug) {
      throw new ComposioSchemaCacheError(toolkitSlug, "toolkit slug is required");
    }
    const startedAt = this.clock();
    let upstream: ComposioUpstreamTool[];
    try {
      upstream = await this.fetchTools(slug);
    } catch (error) {
      this.logger.warn("composio schema cache: fetch failed", {
        event: "composio_inline.schema_fetch.failure",
        toolkitSlug: slug,
        durationMs: this.clock() - startedAt,
        err: error instanceof Error ? error.message : String(error),
      });
      throw new ComposioSchemaCacheError(
        slug,
        error instanceof Error ? error.message : String(error),
      );
    }
    const catalog = buildToolkitCatalogFromUpstream(slug, connectedAccountId, upstream);
    if (catalog.length === 0) {
      this.logger.warn("composio schema cache: 0 tools, not caching", {
        event: "composio_inline.schema_fetch.empty",
        toolkitSlug: slug,
        durationMs: this.clock() - startedAt,
      });
      throw new ComposioSchemaCacheError(
        slug,
        "Composio returned 0 tools for this toolkit; not caching",
      );
    }
    const stable = stableSchemaSnapshot(catalog);
    this.store.upsertComposioToolSchemas({
      toolkitSlug: slug,
      schemasJson: JSON.stringify(stable),
      fetchedAt: new Date(this.clock()).toISOString(),
    });
    this.logger.info("composio schema cache: refreshed", {
      event: "composio_inline.schema_fetch.success",
      toolkitSlug: slug,
      toolCount: catalog.length,
      durationMs: this.clock() - startedAt,
    });
    return catalog;
  }

  peek(toolkitSlug: string): { stale: boolean; fetchedAt: string } | null {
    const slug = normalizeSlug(toolkitSlug);
    if (!slug) return null;
    const row = this.store.getComposioToolSchemas(slug);
    if (!row) return null;
    return {
      stale: this.isStale(row.fetchedAt),
      fetchedAt: row.fetchedAt,
    };
  }

  forget(toolkitSlug: string): boolean {
    const slug = normalizeSlug(toolkitSlug);
    if (!slug) return false;
    return this.store.deleteComposioToolSchemas(slug);
  }

  private readFresh(slug: string): StableSchema[] | null {
    const row = this.store.getComposioToolSchemas(slug);
    if (!row) return null;
    if (this.isStale(row.fetchedAt)) return null;
    try {
      const parsed = JSON.parse(row.schemasJson) as unknown;
      if (!Array.isArray(parsed)) return null;
      return parsed as StableSchema[];
    } catch {
      return null;
    }
  }

  private isStale(fetchedAtIso: string): boolean {
    const fetchedAt = Date.parse(fetchedAtIso);
    if (Number.isNaN(fetchedAt)) return true;
    return this.clock() - fetchedAt > this.ttlMs;
  }
}

interface StableSchema {
  name: string;
  tool_slug: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
}

function stableSchemaSnapshot(catalog: ComposioMcpToolEntry[]): StableSchema[] {
  return catalog.map((entry) => ({
    name: entry.name,
    tool_slug: entry.tool_slug,
    description: entry.description,
    input_schema: entry.input_schema,
    output_schema: entry.output_schema,
    annotations: entry.annotations ?? null,
  }));
}

function rehydrate(
  snapshot: StableSchema[],
  toolkitSlug: string,
  connectedAccountId: string,
): ComposioMcpToolEntry[] {
  return snapshot.map((entry) => ({
    name: entry.name,
    tool_slug: entry.tool_slug,
    description: entry.description,
    input_schema: entry.input_schema,
    output_schema: entry.output_schema,
    annotations: entry.annotations ?? undefined,
    toolkit_slug: toolkitSlug,
    connected_account_id: connectedAccountId,
  }));
}

function normalizeSlug(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export interface PrimeComposioSchemaCacheParams {
  cache: ComposioSchemaCache;
  store: Pick<RuntimeStateStore, "listIntegrationConnections">;
  isInCatalog: (toolkitSlug: string) => boolean;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface PrimeComposioSchemaCacheResult {
  attempted: number;
  primed: number;
  failed: number;
  skipped_already_fresh: number;
  duration_ms: number;
}

/** Walk active integration connections, pick one connected_account_id per
 *  toolkit, and refresh any schema that isn't already fresh in the cache —
 *  all in parallel. Designed to run fire-and-forget right after startup so
 *  the very first agent turn doesn't pay the cold-start fan-out. */
export async function primeComposioSchemaCache(
  params: PrimeComposioSchemaCacheParams,
): Promise<PrimeComposioSchemaCacheResult> {
  const startedAt = Date.now();
  const logger = params.logger ?? { info: () => {}, warn: () => {} };
  const oneAccountPerToolkit = pickFirstActiveAccountPerToolkit(
    await listConnectionsMerged(params.store, {}),
    params.isInCatalog,
  );
  const targets: Array<{ slug: string; accountId: string }> = [];
  let skippedAlreadyFresh = 0;
  for (const [slug, accountId] of oneAccountPerToolkit) {
    const peek = params.cache.peek(slug);
    if (peek && !peek.stale) {
      skippedAlreadyFresh += 1;
      continue;
    }
    targets.push({ slug, accountId });
  }
  if (targets.length === 0) {
    logger.info("composio schema cache: prime skipped (no stale targets)", {
      event: "composio_inline.prime.noop",
      activeToolkits: oneAccountPerToolkit.size,
      skippedAlreadyFresh,
    });
    return {
      attempted: 0,
      primed: 0,
      failed: 0,
      skipped_already_fresh: skippedAlreadyFresh,
      duration_ms: Date.now() - startedAt,
    };
  }
  logger.info("composio schema cache: prime starting", {
    event: "composio_inline.prime.start",
    targets: targets.map(({ slug }) => slug),
    skippedAlreadyFresh,
  });
  const settled = await Promise.allSettled(
    targets.map(({ slug, accountId }) => params.cache.refresh(slug, accountId)),
  );
  let primed = 0;
  let failed = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      primed += 1;
    } else {
      failed += 1;
    }
  }
  const durationMs = Date.now() - startedAt;
  logger.info("composio schema cache: prime complete", {
    event: "composio_inline.prime.done",
    attempted: targets.length,
    primed,
    failed,
    skippedAlreadyFresh,
    durationMs,
  });
  return {
    attempted: targets.length,
    primed,
    failed,
    skipped_already_fresh: skippedAlreadyFresh,
    duration_ms: durationMs,
  };
}

function pickFirstActiveAccountPerToolkit(
  connections: IntegrationConnectionRecord[],
  isInCatalog: (slug: string) => boolean,
): Map<string, string> {
  const byToolkit = new Map<string, string>();
  for (const connection of connections) {
    if (connection.status.trim().toLowerCase() !== "active") continue;
    const externalId = (connection.accountExternalId ?? "").trim();
    if (!externalId) continue;
    const slug = connection.providerId.trim().toLowerCase();
    if (!slug) continue;
    if (!isInCatalog(slug)) continue;
    if (byToolkit.has(slug)) continue;
    byToolkit.set(slug, externalId);
  }
  return byToolkit;
}
