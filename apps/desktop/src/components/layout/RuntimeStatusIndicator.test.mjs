import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RUNTIME_STATUS_INDICATOR_PATH = new URL(
  "./RuntimeStatusIndicator.tsx",
  import.meta.url,
);

test("runtime status indicator uses compact top bar control sizing", async () => {
  const source = await readFile(RUNTIME_STATUS_INDICATOR_PATH, "utf8");

  assert.match(source, /className="relative flex size-6 shrink-0 items-center justify-center rounded-md/);
  assert.match(source, /<Server className="size-3" strokeWidth=\{1\.8\} \/>/);
  assert.match(source, /absolute -right-0\.5 -top-0\.5 size-1\.5 rounded-full ring-2 ring-background/);
  assert.doesNotMatch(source, /size-7/);
});
