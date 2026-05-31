import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANEL_PATH = new URL("./ChatPanel.tsx", import.meta.url);
const OVERLAYS_PATH = new URL("./Overlays.tsx", import.meta.url);
const SIDEBAR_PATH = new URL("./Sidebar.tsx", import.meta.url);
const UI_STATE_PATH = new URL("./state/ui.ts", import.meta.url);

test("new shell composer prefills can preserve the active session or request a fresh draft explicitly", async () => {
  const [chatPanelSource, overlaysSource, sidebarSource, uiStateSource] =
    await Promise.all([
      readFile(CHAT_PANEL_PATH, "utf8"),
      readFile(OVERLAYS_PATH, "utf8"),
      readFile(SIDEBAR_PATH, "utf8"),
      readFile(UI_STATE_PATH, "utf8"),
    ]);

  assert.match(
    uiStateSource,
    /export interface ChatComposerPrefill \{\s*text: string;\s*requestKey: number;\s*mode\?: "replace" \| "append";\s*sessionMode\?: "preserve" \| "draft";\s*\}/,
  );
  assert.match(
    chatPanelSource,
    /if \(\(composerPrefill\.sessionMode \?\? "preserve"\) === "draft"\) \{/,
  );
  assert.match(
    chatPanelSource,
    /setSessionOpenRequest\(\{\s*sessionId: "",\s*requestKey: sessionRequestKeyRef\.current,\s*mode: "draft",\s*\}\);/,
  );
  assert.match(sidebarSource, /text: "New issue: ",/);
  assert.match(sidebarSource, /sessionMode: "preserve",/);
  assert.match(sidebarSource, /text: "Create a schedule for ",/);
  assert.match(sidebarSource, /sessionMode: "draft",/);
  assert.match(overlaysSource, /sessionMode: "draft",/);
});
