import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "useWorkspaceBrowser.ts");

test("workspace browser session polling tolerates transient runtime errors and only refreshes while visible", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /} catch \{\s*\/\/ Keep the last successful browser session snapshot during transient\s*\/\/ runtime hiccups instead of surfacing an unhandled rejection\.\s*\}/s,
  );
  assert.match(
    source,
    /const refreshVisibleSessionState = \(\) => \{\s*if \(document\.visibilityState !== "visible"\) \{\s*return;\s*\}\s*void loadSessionState\(\);\s*\};/s,
  );
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleSessionState\);/);
  assert.match(
    source,
    /document\.addEventListener\("visibilitychange", refreshVisibleSessionState\);/,
  );
  assert.match(
    source,
    /window\.removeEventListener\("focus", refreshVisibleSessionState\);/,
  );
  assert.match(
    source,
    /document\.removeEventListener\("visibilitychange", refreshVisibleSessionState\);/,
  );
});
