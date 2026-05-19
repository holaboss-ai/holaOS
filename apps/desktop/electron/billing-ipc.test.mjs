import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const ELECTRON_TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop billing IPC handlers are removed from electron main (Stream C)", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // Renderer-direct BFF cleanup: billing now goes through Hono directly via
  // the renderer-side `billingRpcFetch`. Main no longer registers any
  // `billing:*` IPC channel and no longer carries a `billingFetch` helper.
  assert.doesNotMatch(source, /handleTrustedIpc\("billing:getOverview"/);
  assert.doesNotMatch(source, /handleTrustedIpc\("billing:getUsage"/);
  assert.doesNotMatch(source, /handleTrustedIpc\("billing:getLinks"/);
  assert.doesNotMatch(source, /async function billingFetch</);
  assert.doesNotMatch(source, /buildDesktopBillingLinks/);
  assert.doesNotMatch(source, /getDesktopBillingOverview/);
  assert.doesNotMatch(source, /getDesktopBillingUsage/);
});

test("renderer-side auth helpers expose cookie + base URL for direct BFF calls", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // The renderer-direct path requires the Better-Auth Cookie header and the
  // Hono API base URL. Both are surfaced through new IPC channels in main.
  // Use indexOf — the handler registrations span multiple lines after Prettier.
  assert.ok(source.includes('"auth:getCookieHeader"'));
  assert.ok(source.includes('"auth:getApiBaseUrl"'));
  assert.ok(source.includes('"auth:getMarketplaceBaseUrl"'));
});

test("preload no longer exposes billing IPC; auth helpers are present", async () => {
  const source = await readFile(PRELOAD_PATH, "utf8");

  assert.doesNotMatch(source, /billing:\s*\{/);
  assert.doesNotMatch(source, /"billing:getOverview"/);
  assert.doesNotMatch(source, /"billing:getUsage"/);
  assert.doesNotMatch(source, /"billing:getLinks"/);

  assert.match(source, /getCookieHeader:\s*\(\)/);
  assert.match(source, /getApiBaseUrl:\s*\(\)/);
  assert.match(source, /getMarketplaceBaseUrl:\s*\(\)/);
});

test("desktop billing payload types remain declared for the renderer-side hook", async () => {
  const source = await readFile(ELECTRON_TYPES_PATH, "utf8");

  // Hook output shape is unchanged (renderer just produces it directly now).
  assert.match(source, /interface DesktopBillingOverviewPayload/);
  assert.match(source, /interface DesktopBillingUsageItemPayload/);
  assert.match(source, /interface DesktopBillingLinksPayload/);
  // No more billing IPC declaration in the global Window type.
  assert.doesNotMatch(source, /billing:\s*\{[^}]*getOverview/);
});
