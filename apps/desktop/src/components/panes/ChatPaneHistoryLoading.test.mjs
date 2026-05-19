import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane.tsx");

test("chat pane preserves message history when auxiliary session history fetches fail", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const auxiliaryHistoryWarnings: string\[\] = \[\];/);
  assert.match(source, /await Promise\.allSettled\(\[/);
  assert.match(
    source,
    /if \(outputEventsResult\.status !== "fulfilled"\) \{\s*auxiliaryHistoryWarnings\.push\(/,
  );
  assert.match(
    source,
    /outputEvents:\s*outputEventsResult\.status === "fulfilled"[\s\S]*\?\s*outputEventsResult\.value\.items[\s\S]*:\s*\[\],/,
  );
  assert.match(
    source,
    /auxiliaryHistoryWarnings\.push\(\s*optionalHistoryLoadErrorMessage\(\s*"Execution history"/,
  );
  assert.match(
    source,
    /warnings:\s*auxiliaryHistoryWarnings,/,
  );
  assert.match(
    source,
    /setChatErrorMessage\(page\.warnings\.join\(" "\)\);/,
  );
});
