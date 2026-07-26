import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { importSkillFromUpload } from "./workspace-skill-import.js";

const SKILL_MD = `---
name: Weekly Report
description: Pulls last week's numbers.
allowed-tools: Bash, Read
---

Do the thing.`;

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hb-skill-upload-test-"));
}

test("a bare SKILL.md installs as a skill folder", async () => {
  const dir = workspace();
  const result = await importSkillFromUpload({
    workspaceDir: dir,
    fileName: "SKILL.md",
    data: Buffer.from(SKILL_MD, "utf8"),
  });
  assert.equal(result.id, "weekly-report");
  // mapSkillFrontmatter aligns the frontmatter name to the installed id, same as
  // the GitHub import — the human-readable label rides in `title`, not `name`.
  assert.equal(result.name, "weekly-report");
  const landed = path.join(dir, "skills", "weekly-report", "SKILL.md");
  assert.ok(fs.existsSync(landed));
});

test("Anthropic allowed-tools is mapped to holaboss_granted_tools", async () => {
  const dir = workspace();
  const result = await importSkillFromUpload({
    workspaceDir: dir,
    fileName: "SKILL.md",
    data: Buffer.from(SKILL_MD, "utf8"),
  });
  assert.deepEqual(result.granted_tools, ["Bash", "Read"]);
  const written = fs.readFileSync(
    path.join(dir, "skills", "weekly-report", "SKILL.md"),
    "utf8",
  );
  assert.match(written, /holaboss_granted_tools/);
  assert.doesNotMatch(written, /allowed-tools/);
});

test("a zip with SKILL.md at the root keeps its bundled files", async () => {
  const zip = new JSZip();
  zip.file("SKILL.md", SKILL_MD);
  zip.file("scripts/run.sh", "#!/bin/sh\necho hi\n");
  zip.file("references/notes.md", "notes");
  const data = await zip.generateAsync({ type: "nodebuffer" });

  const dir = workspace();
  const result = await importSkillFromUpload({
    workspaceDir: dir,
    fileName: "weekly.zip",
    data,
  });
  const paths = result.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["SKILL.md", "references/notes.md", "scripts/run.sh"]);
  assert.ok(
    fs.existsSync(path.join(dir, "skills", "weekly-report", "scripts", "run.sh")),
  );
});

test("a zip nesting everything in one top-level folder is unwrapped", async () => {
  const zip = new JSZip();
  zip.file("weekly-report/SKILL.md", SKILL_MD);
  zip.file("weekly-report/scripts/run.sh", "#!/bin/sh\n");
  const data = await zip.generateAsync({ type: "nodebuffer" });

  const dir = workspace();
  const result = await importSkillFromUpload({
    workspaceDir: dir,
    fileName: "weekly.zip",
    data,
  });
  assert.deepEqual(
    result.files.map((f) => f.path).sort(),
    ["SKILL.md", "scripts/run.sh"],
  );
});

test("a zip with no SKILL.md anywhere is rejected", async () => {
  const zip = new JSZip();
  zip.file("readme.md", "nope");
  const data = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () =>
      importSkillFromUpload({
        workspaceDir: workspace(),
        fileName: "x.zip",
        data,
      }),
    /no SKILL.md found/,
  );
});

test("a forged traversal entry cannot write outside the skill folder", async () => {
  // JSZip normalises "../" away when it writes, so forge one: build with a
  // same-length placeholder and patch the bytes (the name lives in both the
  // local header and the central directory).
  const zip = new JSZip();
  zip.file("SKILL.md", SKILL_MD);
  zip.file("AA/escape.txt", "pwned");
  const clean = await zip.generateAsync({ type: "nodebuffer" });
  const data = Buffer.from(
    clean.toString("binary").split("AA/escape.txt").join("../escape.txt"),
    "binary",
  );
  assert.ok(data.includes(Buffer.from("../escape.txt")), "forge failed");

  // JSZip strips the traversal again on load, so this installs rather than
  // throwing. What matters is where the bytes land: inside the skill dir.
  const dir = workspace();
  await importSkillFromUpload({ workspaceDir: dir, fileName: "x.zip", data });
  assert.ok(!fs.existsSync(path.join(dir, "escape.txt")));
  assert.ok(!fs.existsSync(path.join(dir, "skills", "escape.txt")));
  assert.ok(
    fs.existsSync(path.join(dir, "skills", "weekly-report", "escape.txt")),
    "the entry should be contained, not dropped",
  );
});

test("an unsupported extension is refused", async () => {
  await assert.rejects(
    () =>
      importSkillFromUpload({
        workspaceDir: workspace(),
        fileName: "skill.tar.gz",
        data: Buffer.from("x"),
      }),
    /\.md, \.zip or \.skill/,
  );
});

test("an oversized upload is refused before unpacking", async () => {
  await assert.rejects(
    () =>
      importSkillFromUpload({
        workspaceDir: workspace(),
        fileName: "big.zip",
        data: Buffer.alloc(7 * 1024 * 1024),
      }),
    /too large/,
  );
});
