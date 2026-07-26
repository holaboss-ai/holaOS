import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop output bridge filters workspace-managed instruction artifacts from renderer lists", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /function outputDisplayPathForArtifactFiltering\(/);
  assert.match(
    source,
    /function outputDisplayPathSegmentsForArtifactFiltering\(/,
  );
  assert.match(
    source,
    /function shouldHideWorkspaceManagedArtifactOutput\(/,
  );
  assert.match(
    source,
    /return fileName === "agents\.md" \|\| segments\.includes\("skills"\);/,
  );
  assert.match(
    source,
    /items: response\.items\.filter\(\s*\(item\) => !shouldHideWorkspaceManagedArtifactOutput\(item\),\s*\),/,
  );
});
