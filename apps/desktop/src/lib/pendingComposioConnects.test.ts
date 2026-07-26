import test from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
};

import {
  addPendingComposioConnect,
  clearComposioConnectInFlight,
  isComposioConnectInFlight,
  listPendingComposioConnects,
  markComposioConnectInFlight,
  removePendingComposioConnect,
} from "./pendingComposioConnects.js";

test("add then list returns the pending connect", () => {
  store.clear();
  addPendingComposioConnect({ id: "ca_1", provider: "github" });
  assert.deepEqual(listPendingComposioConnects(), [
    { id: "ca_1", provider: "github" },
  ]);
});

test("persists across a fresh read (survives restart)", () => {
  store.clear();
  addPendingComposioConnect({ id: "ca_1", provider: "github" });
  // A new "session" reads the same localStorage-backed store.
  assert.equal(listPendingComposioConnects()[0]?.id, "ca_1");
});

test("adding the same id twice does not duplicate", () => {
  store.clear();
  addPendingComposioConnect({ id: "ca_1", provider: "github" });
  addPendingComposioConnect({ id: "ca_1", provider: "github" });
  assert.equal(listPendingComposioConnects().length, 1);
});

test("remove drops the matching entry only", () => {
  store.clear();
  addPendingComposioConnect({ id: "ca_1", provider: "github" });
  addPendingComposioConnect({ id: "ca_2", provider: "gmail" });
  removePendingComposioConnect("ca_1");
  assert.deepEqual(
    listPendingComposioConnects().map((e) => e.id),
    ["ca_2"],
  );
});

test("tolerates corrupt storage", () => {
  store.clear();
  store.set("holaboss.pending-composio-connects", "not json{");
  assert.deepEqual(listPendingComposioConnects(), []);
});

test("in-flight guard tracks the active connect and is independent of the durable store", () => {
  assert.equal(isComposioConnectInFlight("ca_1"), false);
  markComposioConnectInFlight("ca_1");
  assert.equal(isComposioConnectInFlight("ca_1"), true);
  // Durable removal must NOT clear the in-flight guard, and vice versa.
  removePendingComposioConnect("ca_1");
  assert.equal(isComposioConnectInFlight("ca_1"), true);
  clearComposioConnectInFlight("ca_1");
  assert.equal(isComposioConnectInFlight("ca_1"), false);
});
