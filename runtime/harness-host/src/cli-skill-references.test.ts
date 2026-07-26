import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expandCliHarnessSkillReferences } from "./cli-skill-references.js";

function makeWorkspaceWithSkill(): { workspaceDir: string; cleanup: () => void } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "hb-cli-skill-"));
  const skillDir = join(workspaceDir, "skills", "content-writer");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: content-writer",
      "description: Writes marketing copy.",
      "---",
      "",
      "# Content Writer",
      "",
      "Write clear, on-brand copy.",
    ].join("\n"),
    "utf8",
  );
  return { workspaceDir, cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }) };
}

test("expandCliHarnessSkillReferences inlines a quoted workspace skill and strips the slash line", () => {
  const { workspaceDir, cleanup } = makeWorkspaceWithSkill();
  try {
    const out = expandCliHarnessSkillReferences({
      instruction: "/content-writer\n\nwrite me something",
      workspaceDir,
      workspaceSkillDirs: [],
    });
    // The raw `/content-writer` slash line is gone (no "Unknown command").
    assert.ok(!/^\/content-writer$/m.test(out), "slash line should be stripped");
    // The skill body is inlined as a <skill> block, frontmatter stripped.
    assert.match(out, /<skill name="content-writer"/);
    assert.match(out, /Write clear, on-brand copy\./);
    assert.doesNotMatch(out, /description: Writes marketing copy/);
    // The user's actual request survives.
    assert.match(out, /write me something/);
  } finally {
    cleanup();
  }
});

test("expandCliHarnessSkillReferences resolves skills from workspaceSkillDirs too", () => {
  const { workspaceDir, cleanup } = makeWorkspaceWithSkill();
  try {
    // Point workspaceSkillDirs at the individual skill dir (as claude-code stages).
    const skillDir = join(workspaceDir, "skills", "content-writer");
    const out = expandCliHarnessSkillReferences({
      instruction: "/content-writer\n\nhello",
      workspaceDir: join(tmpdir(), "hb-cli-skill-nonexistent"),
      workspaceSkillDirs: [skillDir],
    });
    assert.match(out, /<skill name="content-writer"/);
    assert.match(out, /hello/);
  } finally {
    cleanup();
  }
});

test("expandCliHarnessSkillReferences is a no-op when there are no leading skill refs", () => {
  const instruction = "just write me something, no slash here";
  assert.equal(
    expandCliHarnessSkillReferences({
      instruction,
      workspaceDir: "/nonexistent",
      workspaceSkillDirs: [],
    }),
    instruction,
  );
  // A slash mid-message is not a leading skill ref → untouched.
  const midSlash = "use the /content-writer style please";
  assert.equal(
    expandCliHarnessSkillReferences({ instruction: midSlash, workspaceDir: "/nonexistent", workspaceSkillDirs: [] }),
    midSlash,
  );
});

test("expandCliHarnessSkillReferences notes an unresolved skill instead of dropping it", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "hb-cli-skill-empty-"));
  try {
    const out = expandCliHarnessSkillReferences({
      instruction: "/no-such-skill\n\ndo the thing",
      workspaceDir,
      workspaceSkillDirs: [],
    });
    assert.match(out, /not found in this workspace: no-such-skill/);
    assert.match(out, /do the thing/);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
