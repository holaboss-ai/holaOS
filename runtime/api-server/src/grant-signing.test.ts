import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignedGrant, validateSignedGrant } from "./grant-signing.js";

test("createSignedGrant produces a valid signed grant", () => {
  const grant = createSignedGrant("workspace-1", "gmail");
  assert.ok(grant.startsWith("grant:workspace-1:gmail:"));
  assert.ok(grant.split(":").length >= 6);
});

test("validateSignedGrant accepts a valid grant", () => {
  const grant = createSignedGrant("workspace-1", "gmail");
  const result = validateSignedGrant(grant);
  assert.ok(result);
  assert.equal(result.workspaceId, "workspace-1");
  assert.equal(result.appId, "gmail");
});

test("validateSignedGrant rejects a tampered grant", () => {
  const grant = createSignedGrant("workspace-1", "gmail");
  assert.equal(validateSignedGrant(grant.replace("workspace-1", "workspace-2")), null);
});

test("validateSignedGrant rejects malformed strings", () => {
  assert.equal(validateSignedGrant(""), null);
  assert.equal(validateSignedGrant("not-a-grant"), null);
  assert.equal(validateSignedGrant("grant:a:b"), null);
});
