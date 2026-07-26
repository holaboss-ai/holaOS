import assert from "node:assert/strict";
import test from "node:test";

import { appUpdateReady } from "./appUpdateReady.js";

function status(
  overrides: Partial<AppUpdateStatusPayload> = {},
): AppUpdateStatusPayload {
  return {
    supported: true,
    checking: false,
    available: true,
    downloaded: true,
    downloadProgressPercent: 100,
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    releaseName: null,
    publishedAt: null,
    dismissedVersion: null,
    lastCheckedAt: null,
    error: "",
    channel: "latest",
    preferredChannel: null,
    ...overrides,
  };
}

test("ready payload carries the downloaded version", () => {
  const ready = appUpdateReady(status());
  assert.equal(ready?.version, "0.2.0");
  assert.match(ready?.tooltip ?? "", /v0\.2\.0/);
});

test("not ready until the update finishes downloading", () => {
  assert.equal(appUpdateReady(status({ downloaded: false })), null);
});

test("not ready on unsupported builds", () => {
  assert.equal(appUpdateReady(status({ supported: false })), null);
});

test("not ready while an error is present", () => {
  assert.equal(appUpdateReady(status({ error: "download failed" })), null);
});

test("not ready without a status payload", () => {
  assert.equal(appUpdateReady(null), null);
});

test("missing version falls back to a generic tooltip", () => {
  const ready = appUpdateReady(status({ latestVersion: null }));
  assert.equal(ready?.version, null);
  assert.match(ready?.tooltip ?? "", /Update ready/);
});
