import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane", "index.tsx");

test("chat pane only replays terminal failure copy when restored assistant output is still empty", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /assistantHistoryStateFromOutputEvents[\s\S]*const hasAssistantOutput = \(\) =>[\s\S]*outputText\.trim\(\)\.length > 0[\s\S]*segments\.some/,
  );
  assert.match(
    source,
    /assistantHistoryStateFromOutputEvents[\s\S]*event\.event_type === "output_delta"[\s\S]*outputText = `\$\{outputText\}\$\{delta\}`;/,
  );
  assert.match(
    source,
    /assistantHistoryStateFromOutputEvents[\s\S]*event\.event_type === "run_failed"[\s\S]*if \(!hasAssistantOutput\(\)\) \{\s*flushExecutionSegment\(\);[\s\S]*outputText = failureText;/,
  );
});
