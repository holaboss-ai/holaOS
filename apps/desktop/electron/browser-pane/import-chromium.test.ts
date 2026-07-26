import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  chromiumFamilyDisplayName,
  chromiumFamilyUserDataRootCandidates,
} from "./import-chromium.js";

test("chromiumFamilyDisplayName covers every supported family", () => {
  assert.equal(chromiumFamilyDisplayName("chrome"), "Chrome");
  assert.equal(chromiumFamilyDisplayName("chromium"), "Chromium");
  assert.equal(chromiumFamilyDisplayName("arc"), "Arc");
  assert.equal(chromiumFamilyDisplayName("edge"), "Microsoft Edge");
  assert.equal(chromiumFamilyDisplayName("brave"), "Brave");
  assert.equal(chromiumFamilyDisplayName("dia"), "Dia");
});

// The whole import bug was a family→data-dir/binary mismatch, so pin the macOS
// data-dir roots for the newly-supported families (guarded to darwin, where the
// paths are asserted concretely).
test("chromiumFamilyUserDataRootCandidates maps the new families on macOS", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const appSupport = (...parts: string[]) =>
    path.join(os.homedir(), "Library", "Application Support", ...parts);

  assert.deepEqual(chromiumFamilyUserDataRootCandidates("edge"), [
    appSupport("Microsoft Edge"),
  ]);
  assert.deepEqual(chromiumFamilyUserDataRootCandidates("brave"), [
    appSupport("BraveSoftware", "Brave-Browser"),
  ]);
  // Dia (Arc's sibling) prefers the chromium-style `User Data` subfolder.
  assert.deepEqual(chromiumFamilyUserDataRootCandidates("dia"), [
    appSupport("Dia", "User Data"),
    appSupport("Dia"),
  ]);
  // Chrome (the default arm) is unchanged.
  assert.deepEqual(chromiumFamilyUserDataRootCandidates("chrome"), [
    appSupport("Google", "Chrome"),
  ]);
});
