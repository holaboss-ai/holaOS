import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pickFallbackBrowserProfile,
  resolveBrowserProfileSelector,
} from "./browser-capability-tools.js";

const PROFILES = [
  { id: "bprofile_default", name: "Default", index: 1 },
  { id: "bprofile_work", name: "Work", index: 2 },
  { id: "bprofile_shopping", name: "Shopping Alt", index: 3 },
];

test("resolves by number, with or without a leading #", () => {
  assert.equal(resolveBrowserProfileSelector("1", PROFILES)?.id, "bprofile_default");
  assert.equal(resolveBrowserProfileSelector("#2", PROFILES)?.id, "bprofile_work");
  assert.equal(resolveBrowserProfileSelector(" 3 ", PROFILES)?.id, "bprofile_shopping");
});

test("resolves by exact name (case-insensitive) and unique partial", () => {
  assert.equal(resolveBrowserProfileSelector("work", PROFILES)?.id, "bprofile_work");
  assert.equal(resolveBrowserProfileSelector("shopping", PROFILES)?.id, "bprofile_shopping");
});

test("resolves by raw profile id", () => {
  assert.equal(
    resolveBrowserProfileSelector("bprofile_work", PROFILES)?.id,
    "bprofile_work",
  );
});

test("returns null for out-of-range numbers, unknown names, and blanks", () => {
  assert.equal(resolveBrowserProfileSelector("9", PROFILES), null);
  assert.equal(resolveBrowserProfileSelector("nonsense", PROFILES), null);
  assert.equal(resolveBrowserProfileSelector("   ", PROFILES), null);
});

test("an ambiguous partial name (multiple matches) does not guess", () => {
  const profiles = [
    { id: "bprofile_a", name: "Work Main", index: 1 },
    { id: "bprofile_b", name: "Work Alt", index: 2 },
  ];
  assert.equal(resolveBrowserProfileSelector("work", profiles), null);
});

test("pickFallbackBrowserProfile prefers the pinned default, then a running profile, then the first", () => {
  // The user's pinned default wins even over a currently-open (running) profile:
  // the auto-created "Main" profile is often sticky-running, and must NOT hijack
  // a no-name browse when the user has pinned a different default.
  assert.equal(
    pickFallbackBrowserProfile([
      { id: "bprofile_default", name: "Main", index: 1, running: true },
      { id: "bprofile_work", name: "Work", index: 2, isDefault: true },
    ])?.id,
    "bprofile_work",
  );
  // The pinned default wins even when it isn't first and nothing is running.
  assert.equal(
    pickFallbackBrowserProfile([
      { id: "bprofile_default", name: "Main", index: 1 },
      { id: "bprofile_work", name: "Work", index: 2, isDefault: true },
    ])?.id,
    "bprofile_work",
  );
  // No pin → a currently-open (running) profile wins even when it isn't first.
  assert.equal(
    pickFallbackBrowserProfile([
      { id: "bprofile_default", name: "Main", index: 1 },
      { id: "bprofile_work", name: "Work", index: 2, running: true },
    ])?.id,
    "bprofile_work",
  );
  // No pin, nothing running → fall back to the first profile.
  assert.equal(
    pickFallbackBrowserProfile([
      { id: "bprofile_default", name: "Main", index: 1 },
      { id: "bprofile_work", name: "Work", index: 2 },
    ])?.id,
    "bprofile_default",
  );
  // Empty list → null.
  assert.equal(pickFallbackBrowserProfile([]), null);
});
