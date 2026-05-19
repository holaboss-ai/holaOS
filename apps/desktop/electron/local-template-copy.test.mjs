import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop local-template copy ignores workspace runtime artifacts", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /const LOCAL_TEMPLATE_IGNORE_NAMES = new Set\(\[[\s\S]*"\.holaboss",[\s\S]*"\.opencode",[\s\S]*"workspace\.json",[\s\S]*\]\);/,
  );
  assert.match(
    source,
    /function shouldSkipMaterializedWorkspacePath\(relativePath: string\)[\s\S]*rootSegment === "\.holaboss"[\s\S]*rootSegment === "\.opencode"[\s\S]*rootSegment === "workspace\.json"/,
  );
});

test("desktop template application preserves destination workspace runtime state", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function applyMaterializedTemplateToWorkspace[\s\S]*\.filter\(\(entry\) => !shouldPreserveWorkspaceRuntimeEntry\(entry\.name\)\)/,
  );
  assert.match(
    source,
    /async function applyMaterializedTemplateToWorkspace[\s\S]*if \(shouldSkipMaterializedWorkspacePath\(item\.path\)\) \{\s*continue;\s*\}/,
  );
});
