import assert from "node:assert/strict";
import test from "node:test";

import {
  type CatalogEntryBase,
  type InstalledStore,
  type StoreCatalogConnection,
  appKind,
  appTierLabel,
  categoryLabel,
  catalogEntryToOpenParams,
  createStubMarketplaceSource,
  mergeConnectionCatalog,
  storeConnectionToCatalogEntry,
  webHolaAppToCatalogEntry,
} from "./holaAppMarketplace.js";

function memoryStore(initial: string[] | null = null): InstalledStore {
  let value = initial;
  return {
    read: () => (value === null ? null : [...value]),
    write: (ids) => {
      value = [...new Set(ids)];
    },
  };
}

const CATALOG: CatalogEntryBase[] = [
  { holaAppId: "need-review", title: "Need Review", version: "0.0.0", surface: { type: "hosted", path: "/apps/need-review" } },
  { holaAppId: "gofunds", title: "GoFunds", version: "0.0.0", surface: { type: "hosted", path: "/apps/gofunds" } },
  { holaAppId: "notion", title: "Notion", version: "0.0.0", surface: { type: "hosted", url: "https://www.notion.so" } },
];

function source(store: InstalledStore) {
  return createStubMarketplaceSource({ fetchCatalog: async () => CATALOG, store });
}

test("migration: with no stored state, every catalog app is installed", async () => {
  const store = memoryStore(null);
  const catalog = await source(store).listCatalog();
  assert.deepEqual(
    catalog.map((a) => a.holaAppId),
    ["need-review", "gofunds", "notion"],
  );
  assert.ok(catalog.every((a) => a.installed));
  // …and the default was persisted, so it's stable on the next read.
  assert.deepEqual(store.read(), ["need-review", "gofunds", "notion"]);
});

test("install state is honored when present", async () => {
  const catalog = await source(memoryStore(["gofunds"])).listCatalog();
  assert.deepEqual(
    catalog.filter((a) => a.installed).map((a) => a.holaAppId),
    ["gofunds"],
  );
});

test("uninstall removes an app; install adds it back", async () => {
  const store = memoryStore(["need-review", "gofunds", "notion"]);
  const src = source(store);

  await src.uninstall("gofunds");
  let installed = (await src.listCatalog()).filter((a) => a.installed).map((a) => a.holaAppId);
  assert.deepEqual(installed, ["need-review", "notion"]);

  const provisioning = await src.install("gofunds");
  assert.deepEqual(provisioning, { mcp: [], skills: [] }); // stub
  installed = (await src.listCatalog()).filter((a) => a.installed).map((a) => a.holaAppId);
  assert.deepEqual(installed.sort(), ["gofunds", "need-review", "notion"]);
});

test("install is idempotent (no duplicate ids persisted)", async () => {
  const store = memoryStore([]);
  const src = source(store);
  await src.install("need-review");
  await src.install("need-review");
  assert.deepEqual(store.read(), ["need-review"]);
});

test("webHolaAppToCatalogEntry maps hosted path vs third-party url", () => {
  const hosted = webHolaAppToCatalogEntry({ holaAppId: "need-review", title: "Need Review" });
  assert.deepEqual(hosted.surface, { type: "hosted", path: "/apps/need-review" });

  const thirdParty = webHolaAppToCatalogEntry({
    holaAppId: "notion",
    title: "Notion",
    url: "https://www.notion.so",
    iconUrl: "https://www.notion.so/favicon.ico",
  });
  assert.deepEqual(thirdParty.surface, { type: "hosted", url: "https://www.notion.so" });
  assert.equal(thirdParty.iconUrl, "https://www.notion.so/favicon.ico");

  // Promoted apps open their first-class route, not the generic /apps/<id> shell.
  const promoted = webHolaAppToCatalogEntry({ holaAppId: "holaemployee", title: "HolaEmployee" });
  assert.deepEqual(promoted.surface, { type: "hosted", path: "/employees" });
});

test("catalogEntryToOpenParams forwards a third-party url, omits it for derived surfaces", () => {
  assert.deepEqual(
    catalogEntryToOpenParams({ holaAppId: "need-review", title: "Need Review", version: "0.0.0", installed: true, surface: { type: "hosted", path: "/apps/need-review" } }),
    { holaAppId: "need-review", title: "Need Review" },
  );
  assert.deepEqual(
    catalogEntryToOpenParams({ holaAppId: "notion", title: "Notion", version: "0.0.0", installed: true, surface: { type: "hosted", url: "https://www.notion.so" } }),
    { holaAppId: "notion", title: "Notion", url: "https://www.notion.so" },
  );
});

test("catalogEntryToOpenParams forwards declared integrations (soft tool guide)", () => {
  const params = catalogEntryToOpenParams({
    holaAppId: "notion",
    title: "Notion",
    version: "0.1.0",
    installed: true,
    surface: { type: "hosted", url: "https://www.notion.so" },
    integrations: [{ provider: "notion", required: true, whoami: null }],
  });
  // whoami is dropped; only provider + required ride into the surface atom.
  assert.deepEqual(params.integrations, [{ provider: "notion", required: true }]);
});

test("catalogEntryToOpenParams forwards MCP tool names (bundled-MCP apps)", () => {
  const params = catalogEntryToOpenParams({
    holaAppId: "need-review",
    title: "Need Review",
    version: "0.0.0",
    installed: true,
    surface: { type: "hosted", path: "/apps/need-review" },
    mcpTools: ["list_records", "approve_record"],
  });
  assert.deepEqual(params.mcpTools, ["list_records", "approve_record"]);
  // MCP-only apps carry no integrations.
  assert.equal(params.integrations, undefined);
});

// ── connection-tier Apps (former "integrations") ─────────────────────────────

test("storeConnectionToCatalogEntry synthesizes a headless connection card", () => {
  const entry = storeConnectionToCatalogEntry({
    slug: "hubspot",
    tier: "hero",
    category: "crm",
  });
  assert.equal(entry.holaAppId, "hubspot");
  assert.equal(entry.title, "HubSpot"); // resolved via toolkitDisplayName
  assert.equal(entry.kind, "connection");
  assert.deepEqual(entry.surface, { type: "none" });
  // The provider slug is the required integration the connection binds to.
  assert.deepEqual(entry.integrations, [{ provider: "hubspot", required: true }]);
  assert.equal(entry.category, "crm");
  assert.ok(entry.iconUrl && entry.iconUrl.includes("hubspot"));
});

test("storeConnectionToCatalogEntry: connections are never featured", () => {
  // The Featured shelf stays a small curated set — no tier auto-features.
  for (const tier of ["hero", "supported"] as const) {
    const entry = storeConnectionToCatalogEntry({
      slug: "figma",
      tier,
      category: "design",
    });
    assert.equal(entry.featured, undefined);
  }
});

test("mergeConnectionCatalog: authored App wins over a same-slug connection (no dup)", () => {
  // A real Notion module/hosted App already in the catalog…
  const apps: CatalogEntryBase[] = [
    { holaAppId: "notion", title: "Notion", version: "0.0.0", surface: { type: "hosted", url: "https://www.notion.so" } },
  ];
  const store: StoreCatalogConnection[] = [
    { slug: "notion", tier: "hero", category: "productivity" },
    { slug: "hubspot", tier: "hero", category: "crm" },
  ];
  const merged = mergeConnectionCatalog(apps, store);
  // Notion appears exactly once, as the authored entry (not the connection).
  const notion = merged.filter((e) => e.holaAppId === "notion");
  assert.equal(notion.length, 1);
  assert.deepEqual(notion[0]?.surface, { type: "hosted", url: "https://www.notion.so" });
  // HubSpot has no authored App, so it joins as a connection card.
  const hubspot = merged.find((e) => e.holaAppId === "hubspot");
  assert.equal(hubspot?.kind, "connection");
  assert.equal(merged.length, 2);
});

test("mergeConnectionCatalog: dedup is case-insensitive on slug", () => {
  const apps: CatalogEntryBase[] = [
    { holaAppId: "Notion", title: "Notion", version: "0.0.0", surface: { type: "hosted", url: "https://www.notion.so" } },
  ];
  const merged = mergeConnectionCatalog(apps, [
    { slug: "notion", tier: "hero", category: "productivity" },
  ]);
  assert.equal(merged.length, 1);
});

test("mergeConnectionCatalog: an App that REQUIRES a provider suppresses its connection card (even when the App id differs)", () => {
  // The real Notion case: the App's id isn't the provider slug, but it declares
  // the `notion` connection as required — so there must be no bare Notion card.
  const apps: CatalogEntryBase[] = [
    {
      holaAppId: "notion-workspace",
      title: "Notion",
      version: "0.0.0",
      surface: { type: "hosted", url: "https://www.notion.so" },
      integrations: [{ provider: "notion", required: true }],
    },
  ];
  const merged = mergeConnectionCatalog(apps, [
    { slug: "notion", tier: "hero", category: "productivity" },
    { slug: "hubspot", tier: "hero", category: "crm" },
  ]);
  // Notion is the single App entry; the connection card is gone. HubSpot (no App
  // requiring it) still joins as a connection.
  assert.equal(merged.filter((e) => e.title === "Notion").length, 1);
  assert.equal(merged.some((e) => e.holaAppId === "notion" && e.kind === "connection"), false);
  assert.equal(merged.find((e) => e.holaAppId === "hubspot")?.kind, "connection");
  assert.equal(merged.length, 2);
});

test("categoryLabel: humanizes store slugs, passes authored labels through", () => {
  assert.equal(categoryLabel("crm"), "CRM");
  assert.equal(categoryLabel("ci_cloud"), "Cloud");
  assert.equal(categoryLabel("ai_data"), "AI & Data");
  assert.equal(categoryLabel("dev"), "Developer");
  // Authored Title-Case categories are left as-is.
  assert.equal(categoryLabel("Social Media Ops"), "Social Media Ops");
  assert.equal(categoryLabel(undefined), "");
});

test("appTierLabel: Connection vs App", () => {
  assert.equal(appTierLabel({ surface: { type: "none" } }), "Connection");
  assert.equal(appTierLabel({ surface: { type: "local", port: 1 } }), "App");
  assert.equal(appTierLabel({ surface: { type: "hosted", path: "/x" } }), "App");
});

test("appKind: explicit kind wins, else derived from surface", () => {
  assert.equal(appKind({ kind: "connection", surface: { type: "hosted" } }), "connection");
  assert.equal(appKind({ surface: { type: "none" } }), "connection");
  assert.equal(appKind({ surface: { type: "local", port: 1 } }), "module");
  assert.equal(appKind({ surface: { type: "hosted", path: "/apps/x" } }), "hosted");
});
