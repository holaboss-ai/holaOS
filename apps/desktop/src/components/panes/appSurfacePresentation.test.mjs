import test from "node:test";
import assert from "node:assert/strict";
import { hydrateInstalledWorkspaceApps } from "../../lib/workspaceApps";
import { buildAppSurfacePresentation } from "./appSurfacePresentation";

test("hydrateInstalledWorkspaceApps prefers yaml `name`, falls back to title-cased app id", () => {
  const hydrated = hydrateInstalledWorkspaceApps([
    {
      app_id: "discord-sdk",
      name: "Discord (SDK)",
      config_path: "apps/discord-sdk/app.runtime.yaml",
      lifecycle: null,
      ready: true,
      error: null,
    },
    {
      app_id: "stripe-billing",
      // no `name` — should fall back
      config_path: "apps/stripe-billing/app.runtime.yaml",
      lifecycle: null,
      ready: false,
      error: null,
    },
  ]);

  assert.equal(hydrated[0].label, "Discord (SDK)");
  assert.equal(hydrated[1].label, "Stripe Billing");
  // No more accent / summary fields on the definition.
  assert.equal(("accentClassName" in hydrated[0]), false);
  assert.equal(("summary" in hydrated[0]), false);
});

test("app surface presentation prefers a contained split-stage layout", () => {
  const presentation = buildAppSurfacePresentation({
    appId: "gmail",
    label: "Gmail",
    summary: "Email drafts and sending. Use the agent to search threads, draft replies, and keep context in one place.",
    resourceId: "draft-42",
    view: "thread",
  });

  assert.equal(presentation.layout, "split-stage");
  assert.equal(presentation.stageMode, "contained");
  assert.equal(presentation.focusLabel, "Thread draft-42");
  assert.deepEqual(presentation.highlights, [
    "Contained workspace stage",
    "Focused thread context",
    "Agent-assisted follow-up",
  ]);
});
