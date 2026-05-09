import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prunePackagedTree } from "./prune_packaged_tree.mjs";

test("prunePackagedTree preserves skill markdown while pruning other markdown files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-prune-packaged-tree-"));
  const skillDir = path.join(root, "runtime", "harnesses", "src", "embedded-skills", "skill-creator");
  const docsDir = path.join(root, "runtime", "docs");
  const readmePath = path.join(root, "runtime", "README.md");
  const skillPath = path.join(skillDir, "SKILL.md");
  const docsPath = path.join(docsDir, "guide.md");

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(skillPath, "---\nname: skill-creator\ndescription: Skill creator\n---\n", "utf8");
    fs.writeFileSync(readmePath, "# Runtime\n", "utf8");
    fs.writeFileSync(docsPath, "# Guide\n", "utf8");

    prunePackagedTree(root, "macos");

    assert.equal(fs.existsSync(skillPath), true);
    assert.equal(fs.existsSync(readmePath), false);
    assert.equal(fs.existsSync(docsPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
