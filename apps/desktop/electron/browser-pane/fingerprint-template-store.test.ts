import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  FingerprintTemplate,
  ProfileFingerprint,
} from "../../shared/browser-pane-protocol.js";
import {
  addFingerprintTemplate,
  applyTemplateToFingerprint,
  emptyFingerprintTemplateIndex,
  FINGERPRINT_TEMPLATE_ID_PREFIX,
  getFingerprintTemplate,
  isFingerprintTemplateId,
  normalizeFingerprintTemplate,
  normalizeFingerprintTemplateIndex,
  removeFingerprintTemplate,
  renameFingerprintTemplate,
} from "./fingerprint-template-store.js";

const NOW = "2026-07-08T00:00:00.000Z";
const idA = `${FINGERPRINT_TEMPLATE_ID_PREFIX}aaaa`;
const idB = `${FINGERPRINT_TEMPLATE_ID_PREFIX}bbbb`;

test("isFingerprintTemplateId matches only the ftpl_ prefix", () => {
  assert.equal(isFingerprintTemplateId(idA), true);
  assert.equal(isFingerprintTemplateId("bprofile_x"), false);
  assert.equal(isFingerprintTemplateId(null), false);
});

test("normalizeFingerprintTemplate sanitizes an imported template and defaults platform", () => {
  const { template, warnings } = normalizeFingerprintTemplate(
    {
      name: "  From AdsPower  ",
      fingerprint: {
        brand: "Chrome",
        hardwareConcurrency: 8,
        gpuVendor: "--evil", // injection attempt → dropped
        deviceMemory: 9999, // out of range → dropped
      },
    },
    idA,
    NOW,
  );
  assert.ok(template);
  assert.equal(template?.name, "From AdsPower");
  assert.equal(template?.source, "imported");
  assert.equal(template?.fingerprint.platform, "windows"); // default
  assert.equal(template?.fingerprint.brand, "Chrome");
  assert.equal(template?.fingerprint.hardwareConcurrency, 8);
  assert.equal(template?.fingerprint.gpuVendor, undefined);
  assert.equal(template?.fingerprint.deviceMemory, undefined);
  assert.equal(warnings.length, 2);
});

test("normalizeFingerprintTemplate accepts a bare fingerprint object and bad id throws", () => {
  const { template } = normalizeFingerprintTemplate(
    { platform: "macos", brand: "Chrome" },
    idB,
    NOW,
  );
  assert.equal(template?.fingerprint.platform, "macos");
  assert.equal(template?.fingerprint.brand, "Chrome");
  assert.equal(template?.name, "Imported fingerprint"); // default name

  assert.throws(() => normalizeFingerprintTemplate({}, "not-an-ftpl-id", NOW));
});

test("add dedupes by id; rename ignores blank; remove + get", () => {
  let index = emptyFingerprintTemplateIndex();
  const mk = (id: string, name: string): FingerprintTemplate => ({
    id,
    name,
    createdAt: NOW,
    source: "user",
    fingerprint: { platform: "windows" },
  });

  index = addFingerprintTemplate(index, mk(idA, "A"));
  index = addFingerprintTemplate(index, mk(idA, "A2")); // same id → replace
  assert.equal(index.templates.length, 1);
  assert.equal(getFingerprintTemplate(index, idA)?.name, "A2");

  index = renameFingerprintTemplate(index, idA, "   ");
  assert.equal(getFingerprintTemplate(index, idA)?.name, "A2");
  index = renameFingerprintTemplate(index, idA, "Renamed");
  assert.equal(getFingerprintTemplate(index, idA)?.name, "Renamed");

  index = removeFingerprintTemplate(index, idA);
  assert.equal(getFingerprintTemplate(index, idA), null);
});

test("normalizeFingerprintTemplateIndex keeps valid, drops junk/dupes/bad ids", () => {
  const index = normalizeFingerprintTemplateIndex({
    templates: [
      { id: idA, name: "A", createdAt: NOW, source: "user", fingerprint: { platform: "macos" } },
      { id: "nope", name: "bad id" }, // wrong prefix → dropped
      { id: idA, name: "dupe" }, // duplicate → dropped
      "garbage",
      null,
    ],
  });
  assert.equal(index.templates.length, 1);
  assert.equal(getFingerprintTemplate(index, idA)?.fingerprint.platform, "macos");
});

test("applyTemplateToFingerprint keeps the profile's seed unless the template pins one", () => {
  const current: ProfileFingerprint = { seed: 111, platform: "macos" };
  const base: FingerprintTemplate = {
    id: idA,
    name: "Win Chrome",
    createdAt: NOW,
    source: "builtin",
    fingerprint: { platform: "windows", brand: "Chrome" },
  };

  // No pinned seed → profile keeps its returning identity, template overlays the rest.
  const applied = applyTemplateToFingerprint(current, base);
  assert.equal(applied.seed, 111);
  assert.equal(applied.platform, "windows");
  assert.equal(applied.brand, "Chrome");

  // Pinned seed (a clone / captured device) → exact identity reproduced.
  const pinned = applyTemplateToFingerprint(current, {
    ...base,
    fingerprint: { ...base.fingerprint, seed: 222 },
  });
  assert.equal(pinned.seed, 222);
});
