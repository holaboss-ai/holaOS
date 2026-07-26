import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const INTERNAL_TABS_PATH = new URL("./state/internalTabs.ts", import.meta.url);
const CENTER_PATH = new URL("./Center.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);
const OVERLAYS_PATH = new URL("./Overlays.tsx", import.meta.url);
const UI_STATE_PATH = new URL("./state/ui.ts", import.meta.url);

test("automations surface is wired through tab kind, center, sidebar, and shell repair", async () => {
  const [internalTabs, center, sidebar, appShell, overlays, uiState] =
    await Promise.all([
      readFile(INTERNAL_TABS_PATH, "utf8"),
      readFile(CENTER_PATH, "utf8"),
      readFile(SIDEBAR_PATH, "utf8"),
      readFile(APP_SHELL_PATH, "utf8"),
      readFile(OVERLAYS_PATH, "utf8"),
      readFile(UI_STATE_PATH, "utf8"),
    ]);

  // Tab kind union + label.
  assert.match(internalTabs, /"automations"/);
  assert.match(internalTabs, /return "Automations";/);

  // Center routes the new kind to AutomationsSurface.
  assert.match(
    center,
    /activeInternal\.kind === "automations" \? \(\s*\n\s*<AutomationsSurface/,
  );

  // The workflow-run "Completed" tab was removed with the workflow bundle,
  // so AutomationsSurface no longer wires completed-run drill-in
  // (onOpenRunIssue) or onOpenRunSession into AutomationsPane.
  assert.doesNotMatch(center, /onOpenRunIssue=/);
  assert.doesNotMatch(center, /onOpenRunSession=/);

  // Sidebar exposes a workspace-scoped Automations entry.
  assert.match(sidebar, /label="Automations"/);
  assert.match(sidebar, /enterWorkspaceOverlay\("automations"\)/);

  // AppShell workspaceId repair keeps automations tabs as automations.
  assert.match(appShell, /tab\.kind === "automations"/);

  // The dead overlay path is gone — sidebar entry is the only way in.
  assert.doesNotMatch(overlays, /AutomationsOverlay/);
  assert.doesNotMatch(overlays, /automationsOpenAtom/);
  assert.doesNotMatch(uiState, /automationsOpenAtom/);
});
