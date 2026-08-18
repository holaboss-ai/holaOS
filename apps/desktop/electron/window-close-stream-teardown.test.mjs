import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * Session and employee-chat SSE requests are opened with `timeout: 0` because
 * they are long-lived by design. Their only consumer is the main window's
 * renderer, and on macOS ⌘W leaves the app running — so a window close that
 * does not abort them strands a never-timing-out socket to the runtime, plus
 * its reader closure, for the rest of the process's life. Every reopen adds
 * another.
 */

test("closing the main window tears down its SSE streams", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  const index = source.indexOf('win.once("closed", () => {');
  assert.notEqual(index, -1, "the main-window closed handler was not found");
  const handler = source.slice(index, source.indexOf("\n  });", index));

  assert.match(
    handler,
    /closeSessionOutputStream\(/,
    "session output streams are no longer closed on window close",
  );
  assert.match(
    handler,
    /employeeChatStreams/,
    "employee chat streams are no longer closed on window close",
  );
});

test("the long-lived streams still opt out of a request timeout", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // The counterpart to the teardown above: these are deliberately unbounded,
  // which is exactly why closing the window has to abort them explicitly.
  // If this ever gains a timeout, the teardown stops being load-bearing and
  // this pair should be revisited together.
  assert.match(
    source,
    /Session output uses a long-lived SSE connection[\s\S]{0,400}?timeout: 0/,
    "the session output stream no longer documents its unbounded timeout",
  );
});
