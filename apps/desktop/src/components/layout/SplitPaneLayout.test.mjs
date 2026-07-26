import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./SplitPaneLayout.tsx", import.meta.url);

test("split pane layout uses pointer capture so resize drag always releases", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(source, /event\.currentTarget\.setPointerCapture\(event\.pointerId\);/);
  assert.match(source, /event\.currentTarget\.releasePointerCapture\(event\.pointerId\);/);
  assert.match(source, /onLostPointerCapture=\{onLostPointerCapture\}/);
  assert.match(source, /window\.addEventListener\("blur", stopDragging\);/);
  assert.doesNotMatch(source, /window\.addEventListener\("pointermove", onPointerMove\);/);
  assert.doesNotMatch(source, /window\.addEventListener\("pointerup", onPointerUp\);/);
});
