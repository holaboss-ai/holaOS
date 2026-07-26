import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  clearPendingImportedCookies,
  pendingImportedCookiesPath,
  readPendingImportedCookies,
  toTransferableCookies,
  writePendingImportedCookies,
  type PlaywrightCookieLike,
} from "./cdp-cookie-transfer.js";

const NOW = 1_800_000_000; // fixed "now" in unix seconds

test("toTransferableCookies keeps session + future cookies and drops expired", () => {
  const cookies: PlaywrightCookieLike[] = [
    // Session cookie (Playwright uses -1) — the live login; must be KEPT.
    { name: "sid", value: "s", domain: ".reddit.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    // Future persistent cookie — kept, expires carried through.
    { name: "token", value: "t", domain: ".reddit.com", path: "/", expires: NOW + 1000, secure: true },
    // Already expired — dropped.
    { name: "old", value: "x", domain: ".reddit.com", path: "/", expires: NOW - 1 },
    // No name / no domain — dropped.
    { name: "", value: "y", domain: ".reddit.com", path: "/", expires: -1 },
    { name: "z", value: "y", domain: "", path: "/", expires: -1 },
  ];
  const out = toTransferableCookies(cookies, NOW);
  assert.deepEqual(
    out.map((c) => c.name),
    ["sid", "token"],
  );
  // Session cookie: no `expires` field.
  assert.equal("expires" in out[0], false);
  assert.equal(out[0].sameSite, "Lax");
  assert.equal(out[0].httpOnly, true);
  // Persistent cookie: `expires` carried through.
  assert.equal(out[1].expires, NOW + 1000);
  // Path defaults to "/".
  assert.equal(out[0].path, "/");
});

test("toTransferableCookies defaults a blank path to '/'", () => {
  const out = toTransferableCookies(
    [{ name: "a", value: "b", domain: ".x.com", path: "", expires: -1 }],
    NOW,
  );
  assert.equal(out[0].path, "/");
});

test("pending-cookie store round-trips and clears", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-pending-cookies-"));
  const targetUserDataDir = path.join(root, "profile", "chrome");
  // Sidecar lives beside the chrome/ user-data-dir, not inside it.
  assert.equal(
    pendingImportedCookiesPath(targetUserDataDir),
    path.join(root, "profile", "pending-imported-cookies.json"),
  );

  assert.deepEqual(await readPendingImportedCookies(targetUserDataDir), []);

  const cookies = [
    { name: "sid", value: "s", domain: ".reddit.com", path: "/", httpOnly: true, secure: true },
  ];
  await writePendingImportedCookies(targetUserDataDir, cookies);
  const read = await readPendingImportedCookies(targetUserDataDir);
  assert.equal(read.length, 1);
  assert.equal(read[0].name, "sid");

  await clearPendingImportedCookies(targetUserDataDir);
  assert.deepEqual(await readPendingImportedCookies(targetUserDataDir), []);
});

test("writePendingImportedCookies with no cookies writes nothing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-pending-cookies-empty-"));
  const targetUserDataDir = path.join(root, "profile", "chrome");
  await writePendingImportedCookies(targetUserDataDir, []);
  assert.deepEqual(await readPendingImportedCookies(targetUserDataDir), []);
});
