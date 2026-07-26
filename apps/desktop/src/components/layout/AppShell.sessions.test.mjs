import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);

test("legacy app shell routes cronjob session rows back to their parent session", async () => {
  const source = await readFile(APP_SHELL_PATH, "utf8");

  assert.match(
    source,
    /<SubagentSessionsPane[\s\S]*variant="full"[\s\S]*onOpenSession=\{\(session\) =>[\s\S]*handleOpenRunningSession\([\s\S]*session\.parent_session_id\?\.trim\(\) \|\| session\.session_id,/,
  );
});
