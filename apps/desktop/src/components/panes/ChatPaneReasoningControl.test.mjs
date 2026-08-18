import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The compact reasoning control now spans three modules: the width
// constants, the selector that hides its label, and the composer that
// computes the width.
const constantsPath = path.join(__dirname, "ChatPane", "constants.ts");
const selectPath = path.join(
  __dirname,
  "ChatPane",
  "Composer",
  "ThinkingValueSelect.tsx",
);
const composerPath = path.join(__dirname, "ChatPane", "Composer", "index.tsx");

test("chat composer compact reasoning control minimizes to icon-only", async () => {
  const [constants, select, composer] = await Promise.all([
    readFile(constantsPath, "utf8"),
    readFile(selectPath, "utf8"),
    readFile(composerPath, "utf8"),
  ]);

  assert.match(
    constants,
    /export const COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX = \d+;/,
  );
  assert.match(
    constants,
    /export const COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX = \d+;/,
  );
  assert.match(
    select,
    /const showCompactLabel = !compact \|\| typeof compactWidth !== "number";/,
  );
  assert.match(
    composer,
    /const compactThinkingControlWidth = showThinkingValueSelector[\s\S]*Math\.min\(\s*COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX,\s*compactFooterControlWidth - compactModelControlWidth,\s*\)/,
  );
});
