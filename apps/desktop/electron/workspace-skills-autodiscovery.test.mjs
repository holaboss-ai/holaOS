import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop workspace skill discovery comes directly from the fixed skills folder without workspace.yaml skill allowlists", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /async function readSkillCatalogFromRoot\(params: \{\s*skillsRoot: string;\s*\}\)/);
  assert.match(source, /summary: metadata\.summary,[\s\S]*modified_at: stats\.mtime\.toISOString\(\),/);
  assert.match(source, /const skills = \[\.\.\.workspaceSkills\]\.sort/);
  assert.doesNotMatch(source, /parseWorkspaceSkillsConfig/);
  assert.doesNotMatch(source, /enabled_skill_ids/);
});
