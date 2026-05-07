import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SPACE_APPLICATIONS_EXPLORER_PANE_PATH = new URL(
  "./SpaceApplicationsExplorerPane.tsx",
  import.meta.url,
);

test("space applications explorer puts Add application as the first list row", async () => {
  const source = await readFile(SPACE_APPLICATIONS_EXPLORER_PANE_PATH, "utf8");

  assert.match(source, /onAddApp: \(\) => void;/);

  // No bordered header row anymore — the add action lives inline above
  // the app list in the same scrollable region, like + New tab in the
  // browser pane.
  assert.doesNotMatch(
    source,
    /border-b border-border[\s\S]{0,80}onClick=\{onAddApp\}/,
  );

  assert.match(source, /onClick=\{onAddApp\}/);
  assert.match(source, /Add application/);
});

test("app list rows stay single-line with tooltip descriptions", async () => {
  const source = await readFile(SPACE_APPLICATIONS_EXPLORER_PANE_PATH, "utf8");

  // Row no longer renders a two-line name + truncated summary stack.
  assert.doesNotMatch(source, /line-clamp-1/);
  assert.doesNotMatch(source, />\{app\.summary\}</);
  // Hover tooltip surfaces summary instead. `label` is the resolved
  // display name (Composio toolkit when available, falling back to the
  // manifest's app.label) — summary still wins when set.
  assert.match(source, /title=\{app\.summary \|\| label\}/);
});

test("status dot is suppressed for ready apps, visible for non-ready", async () => {
  const source = await readFile(SPACE_APPLICATIONS_EXPLORER_PANE_PATH, "utf8");

  // Ready case no longer returns a bg-success dot class.
  assert.doesNotMatch(source, /tone === "ready"[\s\S]{0,40}return "bg-success"/);
  // Only non-ready tones render the pip.
  assert.match(source, /showStatus = tone !== "ready"/);
  assert.match(source, /\{showStatus \?/);
});

test("no primary-stripe active marker on app rows", async () => {
  const source = await readFile(SPACE_APPLICATIONS_EXPLORER_PANE_PATH, "utf8");

  // The old absolute-positioned bg-primary left stripe is gone.
  assert.doesNotMatch(source, /absolute left-0[\s\S]{0,80}bg-primary/);
  // Active state uses bg-accent, no stripe.
  assert.match(source, /isActive[\s\S]{0,40}"bg-accent text-foreground"/);
});
