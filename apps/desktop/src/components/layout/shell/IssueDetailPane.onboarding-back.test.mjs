import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./IssueDetailPane.tsx", import.meta.url);

test("issue detail pane supports an onboarding-specific back action override", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /export function IssueDetailPane\(\{[\s\S]*onBack,[\s\S]*backLabel = "Back to board",/,
  );
  assert.match(source, /onBack\?: \(\) => void;/);
  assert.match(source, /backLabel\?: string;/);
  assert.match(
    source,
    /const handleBackToBoard = useCallback\(\(\) => \{[\s\S]*if \(onBack\) \{\s*onBack\(\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /aria-label=\{backLabel\}/,
  );
  assert.match(
    source,
    /title=\{backLabel\}/,
  );
});
