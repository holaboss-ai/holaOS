import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeCodeHarnessDefinition } from "./claude-code.js";

/**
 * The Claude Code harness's model list is the ONLY thing its picker shows.
 *
 * Unlike codex, this harness sets no `dynamicModelDiscovery`, so nothing reads
 * a live catalogue from the CLI — the static list is not a fallback, it is the
 * whole source. It had already drifted: Opus 5 and Sonnet 5 were missing while
 * the CLI itself offered them, so the newest models were unreachable from the
 * app with no error to explain why.
 *
 * These guards cannot know which models exist tomorrow. They pin the things
 * that made the drift silent and hard to spot.
 */

const adapter = claudeCodeHarnessDefinition.runtimeAdapter;
const models = adapter.supportedModels;

test("model ids are unique and non-empty", () => {
  const ids = models.map((m) => m.id);
  assert.deepEqual(
    ids.filter((id) => !id.trim()),
    [],
    "an empty id would be forwarded as `claude --model ''`",
  );
  assert.equal(new Set(ids).size, ids.length, "duplicate model ids");
});

test("exactly one model is the default", () => {
  // The desktop picker uses this when a session has no override. Zero defaults
  // silently falls back to whatever the picker orders first; two is ambiguous.
  const defaults = models.filter((m) => m.default);
  assert.equal(defaults.length, 1, `expected one default, found ${defaults.length}`);
});

test("every model is labelled for the picker", () => {
  // The picker renders labels, not ids. A missing label shows an empty row.
  for (const model of models) {
    assert.ok(model.label?.trim(), `model ${model.id} has no label`);
  }
});

test("the list still carries the current generation", () => {
  // The drift that prompted these tests. Not a claim about what is newest
  // forever — a floor, so the list cannot silently lose the models it has been
  // caught missing before.
  const ids = new Set(models.map((m) => m.id));
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
    assert.ok(ids.has(id), `${id} missing from the Claude Code picker`);
  }
});

test("the default is a current-generation model", () => {
  // A default left on a retired model is the failure this replaced: every new
  // session silently started on it, and it stayed the picker's preselection
  // long after newer models shipped.
  const fallback = models.find((m) => m.default);
  assert.equal(fallback?.id, "claude-sonnet-5");
});

test("the retired 4.6 series is gone", () => {
  // Deprecated deliberately, not dropped by accident. Safe for sessions already
  // on them: the desktop adopts a session's stored model only while it is still
  // a legal id for the harness, and otherwise runs the default-snap — so those
  // sessions move to the default rather than showing an unofferable model.
  const ids = new Set(models.map((m) => m.id));
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    assert.ok(!ids.has(id), `${id} was deprecated and should not be listed`);
  }
});

test("this harness has no live discovery, which is why the list must be maintained", () => {
  // If someone later adds dynamicModelDiscovery, the static list becomes a real
  // fallback and the floor above stops being load-bearing. Fail here so that
  // change is a deliberate one rather than a silent shift in what this file is.
  assert.notEqual(
    adapter.dynamicModelDiscovery,
    true,
    "claude-code now discovers models live — revisit the static list's role",
  );
});
