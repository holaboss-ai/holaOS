import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHAT_PANEL_PATH = new URL("./ChatPanel.tsx", import.meta.url);

test("new shell sessions view routes cronjob rows back to their parent session", async () => {
  const source = await readFile(CHAT_PANEL_PATH, "utf8");

  assert.doesNotMatch(source, /onOpenSessions=\{handleOpenSessionsView\}/);
  assert.match(
    source,
    /<SubagentSessionsPane[\s\S]*variant="full"[\s\S]*onOpenSession=\{\(session\) =>[\s\S]*onOpenSession\(session\.parent_session_id\?\.trim\(\) \|\| session\.session_id\)/,
  );
});
