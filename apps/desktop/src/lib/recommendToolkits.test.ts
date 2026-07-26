import assert from "node:assert/strict";
import test from "node:test";

import type { ComposioToolkitMetadata } from "./workspaceDesktop.js";
import { recommendToolkits } from "./recommendToolkits.js";

function kit(
  slug: string,
  overrides: Partial<ComposioToolkitMetadata> = {},
): ComposioToolkitMetadata {
  return {
    slug,
    name: overrides.name ?? slug,
    description: overrides.description ?? "",
    logo: overrides.logo ?? null,
    categories: overrides.categories ?? [],
  };
}

test("returns empty when toolkit list is empty", () => {
  const out = recommendToolkits({
    toolkits: [],
    connectedSlugs: new Set(),
  });
  assert.deepEqual(out, []);
});

test("filters out already-connected toolkits", () => {
  const toolkits = [kit("gmail"), kit("github"), kit("notion")];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(["github"]),
  });
  assert.equal(
    out.find((k) => k.slug === "github"),
    undefined,
  );
  assert.equal(out.length, 2);
});

test("starter pack ordering is honored", () => {
  const toolkits = [
    kit("notion"),
    kit("github"),
    kit("gmail"),
    kit("twitter"),
  ];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
  });
  assert.deepEqual(
    out.map((k) => k.slug),
    ["gmail", "github", "notion", "twitter"],
  );
});

test("workspace hint boosts matching toolkit via alias map", () => {
  // "email triage" should pull gmail to the top via HINT_ALIASES even
  // though github would otherwise come second.
  const toolkits = [
    kit("github", { description: "Read repos and pull requests." }),
    kit("notion"),
    kit("gmail", { description: "Send and triage email." }),
  ];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
    workspaceHint: "email triage workspace",
  });
  assert.equal(out[0]?.slug, "gmail");
});

test("workspace hint scores against categories + description", () => {
  // No alias for "newsletter" — the hint should land via the description
  // haystack on twitter.
  const toolkits = [
    kit("github", { description: "Repos." }),
    kit("twitter", {
      description: "Run social and newsletter promotion campaigns.",
      categories: ["marketing"],
    }),
  ];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
    workspaceHint: "weekly newsletter workspace",
  });
  assert.equal(out[0]?.slug, "twitter");
});

test("fills remaining slots from non-starter toolkits", () => {
  const toolkits = [
    kit("gmail"),
    kit("custom-one", { name: "Custom One" }),
    kit("custom-two", { name: "Custom Two" }),
  ];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
    limit: 3,
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]?.slug, "gmail");
  assert.equal(out[1]?.slug, "custom-one");
  assert.equal(out[2]?.slug, "custom-two");
});

test("respects the limit cap", () => {
  const toolkits = Array.from({ length: 20 }, (_, i) => kit(`custom-${i}`));
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
    limit: 4,
  });
  assert.equal(out.length, 4);
});

test("short hint tokens are ignored", () => {
  const toolkits = [kit("gmail"), kit("github")];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(),
    workspaceHint: "an to my",
  });
  assert.deepEqual(
    out.map((k) => k.slug),
    ["gmail", "github"],
  );
});

test("connectedSlugs comparison is case-insensitive on the catalog side", () => {
  const toolkits = [
    kit("Gmail", { name: "Gmail" }),
    kit("github", { name: "GitHub" }),
  ];
  const out = recommendToolkits({
    toolkits,
    connectedSlugs: new Set(["gmail"]),
  });
  // Gmail (slug "Gmail" but lowercases to "gmail") should be filtered out.
  assert.equal(out.length, 1);
  assert.equal(out[0]?.slug, "github");
});
