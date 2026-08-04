import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addBrowserProfile,
  assignBrowserProfileDebugPort,
  BROWSER_PROFILE_DEBUG_PORT_MIN,
  BROWSER_PROFILE_DEBUG_PORT_SPAN,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_NAME,
  emptyBrowserProfileIndex,
  ensureDefaultBrowserProfile,
  ensureProfileFingerprint,
  getBrowserProfile,
  LEGACY_DEFAULT_BROWSER_PROFILE_NAME,
  normalizeBrowserProfileIndex,
  preferredBrowserProfileDebugPort,
  removeBrowserProfile,
  renameBrowserProfile,
  resolveDefaultBrowserProfileId,
  setDefaultBrowserProfile,
} from "./profile-store.js";
import {
  BROWSER_PROFILE_ID_PREFIX,
  browserProfilePartition,
  browserProfileStatePath,
  browserProfileStorageDir,
  isBrowserProfileId,
} from "./utils.js";

const NOW = "2026-07-06T00:00:00.000Z";
const idA = `${BROWSER_PROFILE_ID_PREFIX}aaaa`;
const idB = `${BROWSER_PROFILE_ID_PREFIX}bbbb`;

test("isBrowserProfileId only matches the bprofile_ prefix", () => {
  assert.equal(isBrowserProfileId(idA), true);
  assert.equal(isBrowserProfileId(DEFAULT_BROWSER_PROFILE_ID), true);
  assert.equal(isBrowserProfileId("root"), false);
  assert.equal(isBrowserProfileId("workspace-123"), false);
  assert.equal(isBrowserProfileId(null), false);
  assert.equal(isBrowserProfileId(undefined), false);
});

test("profile partition + paths are profile-namespaced and stable", () => {
  const partition = browserProfilePartition(idA);
  assert.match(partition, /^persist:holaboss-profile-/);
  // Distinct from the workspace partition namespace.
  assert.doesNotMatch(partition, /holaboss-browser-/);
  // Stable across calls.
  assert.equal(browserProfilePartition(idA), partition);
  // Distinct ids → distinct partitions.
  assert.notEqual(browserProfilePartition(idB), partition);

  const dir = browserProfileStorageDir("/data", idA);
  assert.match(dir, /browser-profiles/);
  assert.equal(
    browserProfileStatePath("/data", idA),
    `${dir}/browser-state.json`,
  );
});

test("addBrowserProfile appends a normalized record and dedupes by id", () => {
  let index = emptyBrowserProfileIndex();

  const first = addBrowserProfile(index, {
    id: idA,
    name: "  Work  ",
    now: NOW,
  });
  index = first.index;
  assert.equal(first.profile.name, "Work");
  assert.equal(first.profile.source, "created");
  assert.equal(first.profile.createdAt, NOW);
  assert.equal(index.profiles.length, 1);

  // Re-adding the same id replaces, not duplicates.
  index = addBrowserProfile(index, {
    id: idA,
    name: "Work 2",
    now: NOW,
    source: "imported",
    importedFrom: "Chrome — Default",
  }).index;
  assert.equal(index.profiles.length, 1);
  assert.equal(index.profiles[0].name, "Work 2");
  assert.equal(index.profiles[0].source, "imported");
  assert.equal(index.profiles[0].importedFrom, "Chrome — Default");
});

test("addBrowserProfile rejects non-profile ids", () => {
  assert.throws(() =>
    addBrowserProfile(emptyBrowserProfileIndex(), {
      id: "not-a-profile",
      name: "x",
      now: NOW,
    }),
  );
});

test("rename ignores blank names; remove drops by id", () => {
  let index = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;

  index = renameBrowserProfile(index, idA, "   ");
  assert.equal(getBrowserProfile(index, idA)?.name, "A");

  index = renameBrowserProfile(index, idA, "Renamed");
  assert.equal(getBrowserProfile(index, idA)?.name, "Renamed");

  index = removeBrowserProfile(index, idA);
  assert.equal(getBrowserProfile(index, idA), null);
  assert.equal(index.profiles.length, 0);
});

test("ensureDefaultBrowserProfile adds Default once and prepends it", () => {
  const withOther = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;

  const seeded = ensureDefaultBrowserProfile(withOther, NOW);
  assert.equal(seeded.profiles[0].id, DEFAULT_BROWSER_PROFILE_ID);
  assert.equal(seeded.profiles.length, 2);

  // Idempotent.
  const again = ensureDefaultBrowserProfile(seeded, NOW);
  assert.equal(
    again.profiles.filter((p) => p.id === DEFAULT_BROWSER_PROFILE_ID).length,
    1,
  );
});

test("normalizeBrowserProfileIndex keeps valid entries and drops junk", () => {
  const normalized = normalizeBrowserProfileIndex({
    profiles: [
      { id: idA, name: "A", createdAt: NOW, source: "created" },
      { id: "bad-id", name: "nope" }, // wrong id namespace → dropped
      { id: idA, name: "dupe" }, // duplicate id → dropped
      { id: idB, source: "weird" }, // missing/blank name + bad source → defaulted
      "garbage",
      null,
    ],
  });
  assert.equal(normalized.profiles.length, 2);
  const a = getBrowserProfile(normalized, idA);
  const b = getBrowserProfile(normalized, idB);
  assert.equal(a?.name, "A");
  assert.equal(b?.name, "Untitled profile");
  assert.equal(b?.source, "created");
});

test("normalizeBrowserProfileIndex tolerates malformed roots", () => {
  assert.deepEqual(normalizeBrowserProfileIndex(null), { profiles: [] });
  assert.deepEqual(normalizeBrowserProfileIndex("x"), { profiles: [] });
  assert.deepEqual(normalizeBrowserProfileIndex({}), { profiles: [] });
});

const inRange = (port: number): boolean =>
  port >= BROWSER_PROFILE_DEBUG_PORT_MIN &&
  port < BROWSER_PROFILE_DEBUG_PORT_MIN + BROWSER_PROFILE_DEBUG_PORT_SPAN;

test("preferredBrowserProfileDebugPort is stable and within the range", () => {
  const port = preferredBrowserProfileDebugPort(idA);
  assert.equal(preferredBrowserProfileDebugPort(idA), port);
  assert.equal(inRange(port), true);
});

test("assignBrowserProfileDebugPort uses the preferred port when free and persists it", () => {
  const index = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;
  const result = assignBrowserProfileDebugPort(index, idA);
  assert.equal(result.port, preferredBrowserProfileDebugPort(idA));
  assert.equal(getBrowserProfile(result.index, idA)?.debugPort, result.port);
});

test("assignBrowserProfileDebugPort is idempotent once a port is stored", () => {
  const index = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;
  const first = assignBrowserProfileDebugPort(index, idA);
  const second = assignBrowserProfileDebugPort(first.index, idA);
  assert.equal(second.port, first.port);
  assert.equal(getBrowserProfile(second.index, idA)?.debugPort, first.port);
});

test("assignBrowserProfileDebugPort probes past a port another profile already holds", () => {
  const taken = preferredBrowserProfileDebugPort(idA);
  // idB squats on idA's preferred port → idA must land on a different one.
  const index = normalizeBrowserProfileIndex({
    profiles: [
      { id: idB, name: "B", createdAt: NOW, source: "created", debugPort: taken },
      { id: idA, name: "A", createdAt: NOW, source: "created" },
    ],
  });
  const result = assignBrowserProfileDebugPort(index, idA);
  assert.notEqual(result.port, taken);
  assert.equal(inRange(result.port), true);
  assert.equal(getBrowserProfile(result.index, idA)?.debugPort, result.port);
});

test("assignBrowserProfileDebugPort never hands two profiles the same port", () => {
  let index = emptyBrowserProfileIndex();
  const ids = Array.from(
    { length: 25 },
    (_unused, i) => `${BROWSER_PROFILE_ID_PREFIX}p${i}`,
  );
  for (const id of ids) {
    index = addBrowserProfile(index, { id, name: id, now: NOW }).index;
  }
  const ports = new Set<number>();
  for (const id of ids) {
    const result = assignBrowserProfileDebugPort(index, id);
    index = result.index;
    assert.equal(ports.has(result.port), false, `duplicate port ${result.port}`);
    assert.equal(inRange(result.port), true);
    ports.add(result.port);
  }
  assert.equal(ports.size, ids.length);
});

test("normalizeBrowserProfileIndex preserves a numeric debugPort and drops junk", () => {
  const normalized = normalizeBrowserProfileIndex({
    profiles: [
      { id: idA, name: "A", createdAt: NOW, source: "created", debugPort: 9412 },
      { id: idB, name: "B", createdAt: NOW, source: "created", debugPort: "9412" },
    ],
  });
  assert.equal(getBrowserProfile(normalized, idA)?.debugPort, 9412);
  assert.equal(getBrowserProfile(normalized, idB)?.debugPort, undefined);
});

test("normalizeBrowserProfileIndex preserves engine/fingerprint/proxy and sanitizes them", () => {
  const normalized = normalizeBrowserProfileIndex({
    profiles: [
      {
        id: idA,
        name: "Cloak",
        createdAt: NOW,
        source: "created",
        engine: "cloak",
        fingerprint: {
          seed: 42069,
          platform: "windows",
          brand: "Chrome",
          gpuVendor: "--evil", // dropped by the sanitizer
        },
        proxy: { server: "socks5://host:1080", geoip: true },
      },
    ],
  });
  const p = getBrowserProfile(normalized, idA);
  // The legacy CloakBrowser-era "cloak" value migrates to "fingerprint" on load.
  assert.equal(p?.engine, "fingerprint");
  assert.equal(p?.fingerprint?.seed, 42069);
  assert.equal(p?.fingerprint?.brand, "Chrome");
  assert.equal(p?.fingerprint?.gpuVendor, undefined); // sanitized out
  assert.equal(p?.proxy?.server, "socks5://host:1080");
  assert.equal(p?.proxy?.geoip, true);
});

test("normalizeBrowserProfileIndex drops an identity-less fingerprint and a bad proxy", () => {
  const normalized = normalizeBrowserProfileIndex({
    profiles: [
      {
        id: idA,
        name: "X",
        createdAt: NOW,
        source: "created",
        engine: "bogus", // not an engine → dropped
        fingerprint: { brand: "Chrome" }, // no seed/platform → dropped
        proxy: { server: "http://has space" }, // invalid → dropped
      },
    ],
  });
  const p = getBrowserProfile(normalized, idA);
  assert.equal(p?.engine, undefined);
  assert.equal(p?.fingerprint, undefined);
  assert.equal(p?.proxy, undefined);
});

test("setDefaultBrowserProfile pins a known id and ignores unknown ids", () => {
  let index = ensureDefaultBrowserProfile(
    addBrowserProfile(emptyBrowserProfileIndex(), { id: idA, name: "A", now: NOW })
      .index,
    NOW,
  );
  // Seeded pin is the permanent profile.
  assert.equal(index.defaultProfileId, DEFAULT_BROWSER_PROFILE_ID);

  index = setDefaultBrowserProfile(index, idA);
  assert.equal(index.defaultProfileId, idA);

  // Unknown ids leave the pin untouched.
  const unchanged = setDefaultBrowserProfile(index, idB);
  assert.equal(unchanged.defaultProfileId, idA);
});

test("resolveDefaultBrowserProfileId prefers the pin, then permanent, then first", () => {
  // Pin honoured when it still exists.
  const pinned = setDefaultBrowserProfile(
    ensureDefaultBrowserProfile(
      addBrowserProfile(emptyBrowserProfileIndex(), {
        id: idA,
        name: "A",
        now: NOW,
      }).index,
      NOW,
    ),
    idA,
  );
  assert.equal(resolveDefaultBrowserProfileId(pinned), idA);

  // Stale pin (profile gone) → permanent profile.
  const stalePin = ensureDefaultBrowserProfile(emptyBrowserProfileIndex(), NOW);
  assert.equal(
    resolveDefaultBrowserProfileId({ ...stalePin, defaultProfileId: idB }),
    DEFAULT_BROWSER_PROFILE_ID,
  );

  // No pin, no permanent → the first profile.
  const bare = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;
  assert.equal(resolveDefaultBrowserProfileId(bare), idA);

  // Empty index → null.
  assert.equal(resolveDefaultBrowserProfileId(emptyBrowserProfileIndex()), null);
});

test("removeBrowserProfile clears the pin when the pinned profile is deleted", () => {
  let index = ensureDefaultBrowserProfile(
    addBrowserProfile(emptyBrowserProfileIndex(), { id: idA, name: "A", now: NOW })
      .index,
    NOW,
  );
  index = setDefaultBrowserProfile(index, idA);
  assert.equal(index.defaultProfileId, idA);

  index = removeBrowserProfile(index, idA);
  assert.equal(index.defaultProfileId, undefined);
  // Resolution falls back to the permanent profile.
  assert.equal(resolveDefaultBrowserProfileId(index), DEFAULT_BROWSER_PROFILE_ID);
});

test("mutations preserve a still-valid pin", () => {
  let index = setDefaultBrowserProfile(
    ensureDefaultBrowserProfile(
      addBrowserProfile(emptyBrowserProfileIndex(), {
        id: idA,
        name: "A",
        now: NOW,
      }).index,
      NOW,
    ),
    idA,
  );

  index = renameBrowserProfile(index, idA, "Renamed");
  assert.equal(index.defaultProfileId, idA);

  index = addBrowserProfile(index, { id: idB, name: "B", now: NOW }).index;
  assert.equal(index.defaultProfileId, idA);

  index = assignBrowserProfileDebugPort(index, idA).index;
  assert.equal(index.defaultProfileId, idA);

  index = ensureProfileFingerprint(index, idA, 123, "windows");
  assert.equal(index.defaultProfileId, idA);
});

test("ensureDefaultBrowserProfile migrates the legacy name and seeds the pin", () => {
  // A pre-rename install: the permanent profile still labelled "Default".
  const legacy = normalizeBrowserProfileIndex({
    profiles: [
      {
        id: DEFAULT_BROWSER_PROFILE_ID,
        name: LEGACY_DEFAULT_BROWSER_PROFILE_NAME,
        createdAt: NOW,
        source: "created",
      },
    ],
  });
  const migrated = ensureDefaultBrowserProfile(legacy, NOW);
  assert.equal(
    getBrowserProfile(migrated, DEFAULT_BROWSER_PROFILE_ID)?.name,
    DEFAULT_BROWSER_PROFILE_NAME,
  );
  assert.equal(migrated.defaultProfileId, DEFAULT_BROWSER_PROFILE_ID);

  // A user's own rename of the permanent profile is left alone.
  const kept = ensureDefaultBrowserProfile(
    normalizeBrowserProfileIndex({
      profiles: [
        {
          id: DEFAULT_BROWSER_PROFILE_ID,
          name: "My browser",
          createdAt: NOW,
          source: "created",
        },
      ],
    }),
    NOW,
  );
  assert.equal(
    getBrowserProfile(kept, DEFAULT_BROWSER_PROFILE_ID)?.name,
    "My browser",
  );
});

test("normalizeBrowserProfileIndex carries a valid defaultProfileId and drops junk", () => {
  assert.equal(
    normalizeBrowserProfileIndex({
      profiles: [{ id: idA, name: "A", createdAt: NOW, source: "created" }],
      defaultProfileId: idA,
    }).defaultProfileId,
    idA,
  );
  assert.equal(
    normalizeBrowserProfileIndex({
      profiles: [{ id: idA, name: "A", createdAt: NOW, source: "created" }],
      defaultProfileId: "not-a-profile",
    }).defaultProfileId,
    undefined,
  );
});

test("ensureProfileFingerprint seeds once and is idempotent", () => {
  let index = addBrowserProfile(emptyBrowserProfileIndex(), {
    id: idA,
    name: "A",
    now: NOW,
  }).index;

  index = ensureProfileFingerprint(index, idA, 55555, "windows");
  assert.equal(getBrowserProfile(index, idA)?.fingerprint?.seed, 55555);
  assert.equal(getBrowserProfile(index, idA)?.fingerprint?.platform, "windows");

  // Idempotent — a second call with a different seed leaves the identity intact.
  index = ensureProfileFingerprint(index, idA, 99999, "macos");
  assert.equal(getBrowserProfile(index, idA)?.fingerprint?.seed, 55555);
  assert.equal(getBrowserProfile(index, idA)?.fingerprint?.platform, "windows");
});
