import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop workspace skill discovery uses fixed skills folder", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const skillsPath = path\.resolve\(workspaceRoot, "skills"\);/);
  assert.doesNotMatch(source, /scope === "skills\.path"/);
});

test("desktop empty workspace scaffold omits skills.path config", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  const emptyScaffoldMatch = source.match(
    /function renderEmptyWorkspaceYaml\(\) \{[\s\S]*?return \[[\s\S]*?\]\.join\("\\n"\);\n\}/,
  );
  assert.ok(emptyScaffoldMatch, "renderEmptyWorkspaceYaml block should exist");
  assert.ok(emptyScaffoldMatch[0].includes('"agents:"'));
  assert.ok(!emptyScaffoldMatch[0].includes("path: skills"));
});
