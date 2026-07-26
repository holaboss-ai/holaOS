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
    /export interface ChatComposerPrefill \{\s*text: string;\s*requestKey: number;\s*mode\?: "replace" \| "append";\s*sessionMode\?: "preserve" \| "draft";\s*autoSubmit\?: boolean;\s*\}/,
  );
  assert.match(
    uiStateSource,
    /export interface ChatLocalAttachmentRequest \{\s*files: File\[];\s*requestKey: number;\s*\}/,
  );
  assert.match(
    chatPanelSource,
    /if \(\(composerPrefill\.sessionMode \?\? "preserve"\) === "draft"\) \{/,
  );
  assert.match(
    chatPanelSource,
    /setSessionOpenRequest\(\{\s*sessionId: "",\s*requestKey: sessionRequestKeyRef\.current,\s*mode: "draft",\s*\}\);/,
  );
  // The prefill must be cleared once ChatPane consumes it; otherwise a
  // remounted ChatPane re-processes the lingering request and an autoSubmit
  // prefill re-fires the send, minting duplicate sessions.
  assert.match(
    chatPanelSource,
    /onComposerPrefillConsumed=\{handleComposerPrefillConsumed\}/,
  );
  assert.match(
    chatPanelSource,
    /setComposerPrefill\(\(current\) =>\s*current\?\.requestKey === requestKey \? null : current,\s*\);/,
  );
  assert.match(chatPanelSource, /chatLocalAttachmentRequestAtom/);
  assert.match(chatPanelSource, /localAttachmentRequest=\{localAttachmentRequest\}/);
  assert.match(
    chatPanelSource,
    /onLocalAttachmentRequestConsumed=\{handleLocalAttachmentRequestConsumed\}/,
  );
  // "New issue" no longer goes through the composer-prefill pipeline; it
  // opens NewIssueDialog directly, and "New chat" now opens a draft via
  // chatSessionOpenRequestAtom. The remaining composer-prefill consumers are
  // schedule helpers, `@` actions, and Outputs.
  assert.doesNotMatch(sidebarSource, /chatComposerPrefillAtom/);
  assert.doesNotMatch(overlaysSource, /chatSessionOpenRequestAtom/);
  assert.doesNotMatch(overlaysSource, /chatPanelViewAtom/);
});
