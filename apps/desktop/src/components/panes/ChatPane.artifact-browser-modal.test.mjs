import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modalSourcePath = path.join(
  __dirname,
  "ChatPane",
  "ArtifactBrowserModal.tsx",
);
const outputsSourcePath = path.join(
  __dirname,
  "ChatPane",
  "AssistantTurn",
  "Outputs.tsx",
);

test("artifact browser modal keeps header, filters, and results inside one modal shell", async () => {
  const source = await readFile(modalSourcePath, "utf8");

  assert.match(source, /export function ArtifactBrowserModal\(/);
  assert.match(source, /function shouldHideOutputFromArtifactDisplay\(/);
  assert.match(
    source,
    /return fileName === "agents\.md" \|\| segments\.includes\("skills"\);/,
  );
  assert.match(source, /const allDisplayOutputs = dedupeOutputsForDisplay\(outputs\);/);
  assert.match(source, /layout = "page",/);
  assert.match(
    source,
    /const overlayClassName =\s*layout === "card"\s*\?\s*"absolute inset-0 z-30 flex items-stretch justify-stretch bg-background\/88 p-2 backdrop-blur-\[2px\]"\s*:\s*"absolute inset-0 z-30 flex items-center justify-center bg-black\/40 px-6 py-8 backdrop-blur-\[2px\]";/,
  );
  assert.match(
    source,
    /const panelClassName =\s*layout === "card"\s*\?\s*"flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl"\s*:\s*"flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl";/,
  );
  assert.match(
    source,
    /<div[\s\S]*className=\{overlayClassName\}[\s\S]*data-control-center-swipe-ignore=\{layout === "card" \? "true" : undefined\}[\s\S]*>\s*<div className=\{panelClassName\}>/,
  );
  assert.match(
    source,
    /<div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">[\s\S]*\{filterLabels\.map/,
  );
  assert.match(
    source,
    /<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">[\s\S]*\{filteredOutputs\.length === 0 \?/,
  );
});

test("inline artifact rows reuse the filtered display output list", async () => {
  const source = await readFile(outputsSourcePath, "utf8");

  assert.match(source, /const displayOutputs = dedupeOutputsForDisplay\(outputs\);/);
  assert.match(
    source,
    /if \(displayOutputs\.length === 0\) \{\s*return null;\s*\}/,
  );
});
