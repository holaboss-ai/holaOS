import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSIO_SCHEMA_TTL_MS,
  ComposioSchemaCache,
  ComposioSchemaCacheError,
  primeComposioSchemaCache,
} from "./composio-schema-cache.js";
import type { ComposioUpstreamTool } from "./composio-tool-registry.js";
import type { IntegrationConnectionRecord } from "@holaboss/runtime-state-store";

function makeStoreStub() {
  const rows = new Map<string, { schemasJson: string; fetchedAt: string }>();
  return {
    getComposioToolSchemas: (slug: string) => rows.get(slug.trim().toLowerCase()) ?? null,
    upsertComposioToolSchemas: (params: {
      toolkitSlug: string;
      schemasJson: string;
      fetchedAt?: string;
    }) => {
      const key = params.toolkitSlug.trim().toLowerCase();
      rows.set(key, {
        schemasJson: params.schemasJson,
        fetchedAt: params.fetchedAt ?? "1970-01-01T00:00:00.000Z",
      });
    },
    deleteComposioToolSchemas: (slug: string) => rows.delete(slug.trim().toLowerCase()),
    raw: rows,
  };
}

function gmailTools(): ComposioUpstreamTool[] {
  return [
    {
      slug: "GMAIL_GET_PROFILE",
      name: "Get profile",
      description: "Read the authenticated user's Gmail profile.",
      input_schema: { type: "object", properties: {} },
      read_only: true,
    },
    {
      slug: "GMAIL_FETCH_EMAILS",
      name: "Fetch emails",
      description: "Read recent emails.",
      input_schema: { type: "object", properties: {} },
      read_only: true,
    },
  ];
}

test("ComposioSchemaCache.get fetches from upstream on cache miss and persists", async () => {
  const store = makeStoreStub();
  let fetchCalls = 0;
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => {
      fetchCalls += 1;
      return gmailTools();
    },
  });

  const entries = await cache.get("gmail", "ca_user");
  assert.equal(fetchCalls, 1);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.toolkit_slug === "gmail"));
  assert.ok(entries.every((entry) => entry.connected_account_id === "ca_user"));
  assert.ok(store.raw.has("gmail"), "schemas should be persisted");
});

test("ComposioSchemaCache.get rehydrates from cache on fresh hit without re-fetching", async () => {
  const store = makeStoreStub();
  let fetchCalls = 0;
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => {
      fetchCalls += 1;
      return gmailTools();
    },
  });

  await cache.get("gmail", "ca_user_a");
  const second = await cache.get("gmail", "ca_user_b");

  assert.equal(fetchCalls, 1, "second call should hit cache, not refetch");
  assert.ok(second.every((entry) => entry.connected_account_id === "ca_user_b"));
});

test("ComposioSchemaCache.get re-fetches when the cached row is older than the TTL", async () => {
  const store = makeStoreStub();
  let fetchCalls = 0;
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => {
      fetchCalls += 1;
      return gmailTools();
    },
    clock: () => clockMs,
  });

  await cache.get("gmail", "ca_user");
  clockMs += COMPOSIO_SCHEMA_TTL_MS + 1;
  await cache.get("gmail", "ca_user");

  assert.equal(fetchCalls, 2, "post-TTL call should refetch");
});

test("ComposioSchemaCache.refresh throws when upstream returns 0 tools and does not persist", async () => {
  const store = makeStoreStub();
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => [],
  });

  await assert.rejects(
    () => cache.refresh("brandnew", "ca_user"),
    (error) =>
      error instanceof ComposioSchemaCacheError && /0 tools/.test(error.message),
  );
  assert.equal(store.raw.size, 0, "empty result should not be cached");
});

test("ComposioSchemaCache.refresh surfaces upstream fetch errors", async () => {
  const store = makeStoreStub();
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => {
      throw new Error("hono unreachable");
    },
  });

  await assert.rejects(
    () => cache.refresh("gmail", "ca_user"),
    (error) =>
      error instanceof ComposioSchemaCacheError && /hono unreachable/.test(error.message),
  );
  assert.equal(store.raw.size, 0);
});

test("ComposioSchemaCache.peek reports stale flag based on TTL", async () => {
  const store = makeStoreStub();
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => gmailTools(),
    clock: () => clockMs,
  });

  assert.equal(cache.peek("gmail"), null, "peek with no row returns null");
  await cache.get("gmail", "ca_user");
  assert.equal(cache.peek("gmail")?.stale, false);
  clockMs += COMPOSIO_SCHEMA_TTL_MS + 1;
  assert.equal(cache.peek("gmail")?.stale, true);
});

test("ComposioSchemaCache.forget removes a cached row", async () => {
  const store = makeStoreStub();
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => gmailTools(),
  });
  await cache.get("gmail", "ca_user");
  assert.equal(cache.forget("gmail"), true);
  assert.equal(cache.forget("gmail"), false, "second forget is a no-op");
  assert.equal(store.raw.size, 0);
});

function makeConnectionRecord(
  overrides: Partial<IntegrationConnectionRecord>,
): IntegrationConnectionRecord {
  return {
    connectionId: "conn",
    providerId: "notion",
    ownerUserId: "user-1",
    accountLabel: "Notion",
    accountExternalId: "ca_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "oauth_app",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    contextCronAutoFetchEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("primeComposioSchemaCache refreshes stale toolkits in parallel and skips fresh ones", async () => {
  const store = makeStoreStub();
  // Pre-seed gmail as fresh — should be skipped.
  store.upsertComposioToolSchemas({
    toolkitSlug: "gmail",
    schemasJson: JSON.stringify([
      {
        name: "gmail_get_profile",
        tool_slug: "GMAIL_GET_PROFILE",
        description: "x",
        input_schema: {},
        annotations: null,
      },
    ]),
    fetchedAt: new Date().toISOString(),
  });
  const fetchCalls: string[] = [];
  const fetchTools = async (slug: string) => {
    fetchCalls.push(slug);
    return gmailTools();
  };
  const cache = new ComposioSchemaCache({ store, fetchTools });
  const result = await primeComposioSchemaCache({
    cache,
    store: {
      listIntegrationConnections: () => [
        makeConnectionRecord({
          connectionId: "c1",
          providerId: "notion",
          accountExternalId: "ca_notion",
        }),
        makeConnectionRecord({
          connectionId: "c2",
          providerId: "gmail",
          accountExternalId: "ca_gmail",
        }),
      ],
    },
    isInCatalog: () => true,
  });
  assert.equal(result.attempted, 1, "notion stale, gmail fresh → only notion attempted");
  assert.equal(result.primed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped_already_fresh, 1);
  assert.deepEqual(fetchCalls, ["notion"]);
});

test("primeComposioSchemaCache reports failures without crashing the whole prime", async () => {
  const store = makeStoreStub();
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async (slug) => {
      if (slug === "notion") throw new Error("notion is sad");
      return gmailTools();
    },
  });
  const result = await primeComposioSchemaCache({
    cache,
    store: {
      listIntegrationConnections: () => [
        makeConnectionRecord({
          connectionId: "c1",
          providerId: "notion",
          accountExternalId: "ca_notion",
        }),
        makeConnectionRecord({
          connectionId: "c2",
          providerId: "gmail",
          accountExternalId: "ca_gmail",
        }),
      ],
    },
    isInCatalog: () => true,
  });
  assert.equal(result.attempted, 2);
  assert.equal(result.primed, 1);
  assert.equal(result.failed, 1);
});

test("primeComposioSchemaCache skips non-active connections + connections missing external IDs + non-catalog toolkits", async () => {
  const store = makeStoreStub();
  const fetchCalls: string[] = [];
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async (slug) => {
      fetchCalls.push(slug);
      return gmailTools();
    },
  });
  const result = await primeComposioSchemaCache({
    cache,
    store: {
      listIntegrationConnections: () => [
        makeConnectionRecord({
          connectionId: "c-expired",
          providerId: "notion",
          accountExternalId: "ca_notion",
          status: "expired",
        }),
        makeConnectionRecord({
          connectionId: "c-no-ext",
          providerId: "gmail",
          accountExternalId: null,
        }),
        makeConnectionRecord({
          connectionId: "c-not-catalog",
          providerId: "obscureapp",
          accountExternalId: "ca_obscure",
        }),
        makeConnectionRecord({
          connectionId: "c-ok",
          providerId: "twitter",
          accountExternalId: "ca_tw",
        }),
      ],
    },
    isInCatalog: (slug) => slug !== "obscureapp",
  });
  assert.equal(result.attempted, 1);
  assert.deepEqual(fetchCalls, ["twitter"]);
});

test("primeComposioSchemaCache is a no-op when there are no active connections", async () => {
  const store = makeStoreStub();
  const cache = new ComposioSchemaCache({
    store,
    fetchTools: async () => gmailTools(),
  });
  const result = await primeComposioSchemaCache({
    cache,
    store: { listIntegrationConnections: () => [] },
    isInCatalog: () => true,
  });
  assert.equal(result.attempted, 0);
  assert.equal(result.primed, 0);
});
