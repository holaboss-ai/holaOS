import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane", "index.tsx");

test("chat pane preserves message history when auxiliary session history fetches fail", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const warnings: string\[\] = \[\];/);
  assert.match(source, /await Promise\.allSettled\(\[/);
  assert.match(
    source,
    /if \(outputEventsResult\.status !== "fulfilled"\) \{\s*warnings\.push\(/,
  );
  assert.match(
    source,
    /const outputEvents =\s*outputEventsResult\.status === "fulfilled"\s*\? outputEventsResult\.value\.items\.filter\([\s\S]*?\)\s*: \[\];/,
  );
  assert.match(
    source,
    /warnings\.push\(\s*optionalHistoryLoadErrorMessage\(\s*"Execution history",\s*outputEventsResult\.reason,\s*\),\s*\);/,
  );
  assert.match(
    source,
    /\s+warnings,\n/,
  );
  assert.match(
    source,
    /if \(artifacts\.warnings\.length > 0\) \{\s*setChatErrorMessage\(\[\.\.\.new Set\(artifacts\.warnings\)\]\.join\(" "\)\);\s*\}/,
  );
});
