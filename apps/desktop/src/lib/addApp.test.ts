import assert from "node:assert/strict";
import test from "node:test";

import { type AddAppDeps, addApp, connectionProviderSlug } from "./addApp.js";
import type { AppCatalogEntry } from "./holaAppMarketplace.js";
import type { IntegrationConnectOutcome } from "./useIntegrationConnect.js";

type Calls = {
  connect: string[];
  bind: string[];
  ensure: string[];
  install: string[];
};

function makeDeps(
  overrides: Partial<AddAppDeps> & {
    connectResult?: (provider: string) => IntegrationConnectOutcome;
  } = {},
): { deps: AddAppDeps; calls: Calls } {
  const calls: Calls = { connect: [], bind: [], ensure: [], install: [] };
  const connectResult =
    overrides.connectResult ??
    ((provider: string) => ({ kind: "done", connectionId: `conn-${provider}` }));
  const deps: AddAppDeps = {
    workspaceId: overrides.workspaceId === undefined ? "ws-1" : overrides.workspaceId,
    connect: async ({ provider }) => {
      calls.connect.push(provider);
      return connectResult(provider);
    },
    bind: async ({ providerSlug, connectionId }) => {
      calls.bind.push(`${providerSlug}:${connectionId}`);
    },
    ensureComposioMcp: async (workspaceId) => {
      calls.ensure.push(workspaceId);
    },
    installApp: async (holaAppId) => {
      calls.install.push(holaAppId);
    },
    ...(overrides.connectedProviders
      ? { connectedProviders: overrides.connectedProviders }
      : {}),
  };
  return { deps, calls };
}

function connectionEntry(slug: string): AppCatalogEntry {
  return {
    holaAppId: slug,
    title: slug,
    kind: "connection",
    version: "0.0.0",
    installed: false,
    surface: { type: "none" },
    integrations: [{ provider: slug, required: true }],
  };
}

// ── connection tier ──────────────────────────────────────────────────────────

test("connection: connects, binds, ensures MCP — no install", async () => {
  const { deps, calls } = makeDeps();
  const outcome = await addApp(connectionEntry("hubspot"), deps);
  assert.deepEqual(outcome, { kind: "connected", connectionId: "conn-hubspot" });
  assert.deepEqual(calls.connect, ["hubspot"]);
  assert.deepEqual(calls.bind, ["hubspot:conn-hubspot"]);
  assert.deepEqual(calls.ensure, ["ws-1"]);
  assert.deepEqual(calls.install, []); // connections are never "installed"
});

test("connection: no workspace ⇒ connect only, skip bind + ensure", async () => {
  const { deps, calls } = makeDeps({ workspaceId: null });
  const outcome = await addApp(connectionEntry("figma"), deps);
  assert.deepEqual(outcome, { kind: "connected", connectionId: "conn-figma" });
  assert.deepEqual(calls.bind, []);
  assert.deepEqual(calls.ensure, []);
});

test("connection: cancelled OAuth returns cancelled, binds nothing", async () => {
  const { deps, calls } = makeDeps({ connectResult: () => ({ kind: "cancelled" }) });
  const outcome = await addApp(connectionEntry("hubspot"), deps);
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.deepEqual(calls.bind, []);
  assert.deepEqual(calls.ensure, []);
});

test("connection: OAuth error is surfaced", async () => {
  const boom = new Error("oauth failed");
  const { deps } = makeDeps({ connectResult: () => ({ kind: "error", error: boom }) });
  const outcome = await addApp(connectionEntry("hubspot"), deps);
  assert.deepEqual(outcome, { kind: "error", error: boom });
});

test("connection: a failing bind is best-effort (still connected)", async () => {
  const { deps, calls } = makeDeps();
  deps.bind = async () => {
    throw new Error("rebind restart failed");
  };
  const outcome = await addApp(connectionEntry("hubspot"), deps);
  assert.deepEqual(outcome, { kind: "connected", connectionId: "conn-hubspot" });
  // ensure still runs even though bind threw
  assert.deepEqual(calls.ensure, ["ws-1"]);
});

// ── module / hosted tier ─────────────────────────────────────────────────────

const NOTION_MODULE: AppCatalogEntry = {
  holaAppId: "notion",
  title: "Notion",
  kind: "module",
  version: "0.0.0",
  installed: false,
  surface: { type: "local", port: 18080 },
  integrations: [{ provider: "notion", required: true }],
};

test("module: connects a required integration, then installs", async () => {
  const { deps, calls } = makeDeps();
  const outcome = await addApp(NOTION_MODULE, deps);
  assert.deepEqual(outcome, { kind: "installed" });
  assert.deepEqual(calls.connect, ["notion"]); // shared connect sub-process
  assert.deepEqual(calls.install, ["notion"]);
});

test("module: an already-connected required integration is not re-OAuth'd", async () => {
  const { deps, calls } = makeDeps({
    connectedProviders: new Set(["notion"]),
  });
  const outcome = await addApp(NOTION_MODULE, deps);
  assert.deepEqual(outcome, { kind: "installed" });
  assert.deepEqual(calls.connect, []); // skipped
  assert.deepEqual(calls.install, ["notion"]);
});

test("module: a cancelled required connect aborts the install", async () => {
  const { deps, calls } = makeDeps({ connectResult: () => ({ kind: "cancelled" }) });
  const outcome = await addApp(NOTION_MODULE, deps);
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.deepEqual(calls.install, []); // gated — never installed
});

test("hosted: no integrations ⇒ installs directly", async () => {
  const { deps, calls } = makeDeps();
  const hosted: AppCatalogEntry = {
    holaAppId: "need-review",
    title: "Need Review",
    version: "0.0.0",
    installed: false,
    surface: { type: "hosted", path: "/apps/need-review" },
  };
  const outcome = await addApp(hosted, deps);
  assert.deepEqual(outcome, { kind: "installed" });
  assert.deepEqual(calls.connect, []);
  assert.deepEqual(calls.install, ["need-review"]);
});

test("module: install failure surfaces the error", async () => {
  const boom = new Error("install 500");
  const { deps } = makeDeps({ connectedProviders: new Set(["notion"]) });
  deps.installApp = async () => {
    throw boom;
  };
  const outcome = await addApp(NOTION_MODULE, deps);
  assert.deepEqual(outcome, { kind: "error", error: boom });
});

// ── slug resolution ──────────────────────────────────────────────────────────

test("connectionProviderSlug: integration provider wins, else the app id", () => {
  assert.equal(
    connectionProviderSlug({
      holaAppId: "x",
      surface: { type: "none" },
      integrations: [{ provider: "twitter", required: true }],
    }),
    "twitter",
  );
  assert.equal(
    connectionProviderSlug({ holaAppId: "hubspot", surface: { type: "none" } }),
    "hubspot",
  );
});
