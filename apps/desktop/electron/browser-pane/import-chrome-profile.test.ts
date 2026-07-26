import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  copyChromiumProfileIntoUserDataDir,
  shouldSkipChromeProfileEntry,
} from "./import-chrome-profile.js";

test("shouldSkipChromeProfileEntry skips caches, keeps identity data", () => {
  assert.equal(shouldSkipChromeProfileEntry("Cache"), true);
  assert.equal(shouldSkipChromeProfileEntry("Code Cache"), true);
  assert.equal(shouldSkipChromeProfileEntry("Service Worker"), true);
  assert.equal(shouldSkipChromeProfileEntry("Cookies"), false);
  assert.equal(shouldSkipChromeProfileEntry("Login Data"), false);
  assert.equal(shouldSkipChromeProfileEntry("Local Storage"), false);
  assert.equal(shouldSkipChromeProfileEntry("Bookmarks"), false);
});

test("copyChromiumProfileIntoUserDataDir seeds Default + Local State, skips caches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hb-import-"));
  try {
    // Fake source user-data-dir: Local State at root, a profile dir with
    // identity data + a cache subtree that must NOT be copied.
    const sourceRoot = path.join(root, "src", "Chrome");
    const sourceProfile = path.join(sourceRoot, "Default");
    await fs.mkdir(path.join(sourceProfile, "Cache"), { recursive: true });
    await fs.mkdir(path.join(sourceProfile, "Local Storage"), {
      recursive: true,
    });
    await fs.writeFile(path.join(sourceRoot, "Local State"), "{}");
    await fs.writeFile(path.join(sourceProfile, "Cookies"), "cookie-db");
    await fs.writeFile(path.join(sourceProfile, "Bookmarks"), "{}");
    await fs.writeFile(path.join(sourceProfile, "Cache", "data_0"), "junk");
    await fs.writeFile(
      path.join(sourceProfile, "Local Storage", "leveldb.log"),
      "ls",
    );

    const targetUserDataDir = path.join(root, "target", "chrome");
    const result = await copyChromiumProfileIntoUserDataDir({
      sourceProfileDir: sourceProfile,
      targetUserDataDir,
    });

    assert.equal(result.copiedLocalState, true);
    // Nothing locked in a fixture copy → clean result.
    assert.deepEqual(result.skippedLockedFiles, []);
    assert.ok(existsSync(path.join(targetUserDataDir, "Local State")));
    assert.ok(existsSync(path.join(targetUserDataDir, "Default", "Cookies")));
    assert.ok(existsSync(path.join(targetUserDataDir, "Default", "Bookmarks")));
    assert.ok(
      existsSync(
        path.join(targetUserDataDir, "Default", "Local Storage", "leveldb.log"),
      ),
    );
    // Cache subtree skipped.
    assert.equal(
      existsSync(path.join(targetUserDataDir, "Default", "Cache")),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("copyChromiumProfileIntoUserDataDir rejects a missing source", async () => {
  await assert.rejects(
    copyChromiumProfileIntoUserDataDir({
      sourceProfileDir: path.join(os.tmpdir(), "hb-does-not-exist-xyz"),
      targetUserDataDir: path.join(os.tmpdir(), "hb-target-xyz"),
    }),
    /no longer exists/,
  );
});
