import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CREDITS_PILL_PATH = new URL("./CreditsPill.tsx", import.meta.url);

test("credits pill uses the shared compact top bar control height", async () => {
  const source = await readFile(CREDITS_PILL_PATH, "utf8");

  assert.match(source, /className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border\/55 px-1\.5"/);
  assert.match(source, /size="xs"/);
  assert.match(source, /className=\{`inline-flex h-6 shrink-0 tracking-tight items-center rounded-md border px-1\.5 text-\[11px\] transition \$\{/);
  assert.doesNotMatch(source, /h-7/);
  assert.doesNotMatch(source, /h-8/);
  assert.doesNotMatch(source, /h-9/);
});
