import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillMarkdown } from "./skillFileImport";

const good = `---
name: Weekly Report
description: Pulls last week's numbers and drafts the summary.
---

Do the thing.`;

test("reads name and description out of the frontmatter", () => {
  const result = parseSkillMarkdown(good, "weekly.md");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "Weekly Report");
  assert.equal(
    result.skill.description,
    "Pulls last week's numbers and drafts the summary.",
  );
});

test("derives the id from the name, not the filename", () => {
  const result = parseSkillMarkdown(good, "Untitled-3.md");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.skillId, "weekly-report");
});

test("falls back to the filename when the name has nothing to slugify", () => {
  const result = parseSkillMarkdown(
    `---\nname: "…"\ndescription: x\n---\nbody`,
    "my-skill.md",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.skillId, "my-skill");
});

test("rejects a file with no frontmatter", () => {
  const result = parseSkillMarkdown("# Just a heading\n", "a.md");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /frontmatter/);
});

test("rejects frontmatter missing name or description", () => {
  const noName = parseSkillMarkdown(`---\ndescription: x\n---\nb`, "a.md");
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.match(noName.error, /name/);

  const noDesc = parseSkillMarkdown(`---\nname: X\n---\nb`, "a.md");
  assert.equal(noDesc.ok, false);
  if (!noDesc.ok) assert.match(noDesc.error, /description/);
});

test("handles CRLF files and quoted values", () => {
  const result = parseSkillMarkdown(
    `---\r\nname: "Quoted Name"\r\ndescription: 'single'\r\n---\r\nbody`,
    "a.md",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "Quoted Name");
  assert.equal(result.skill.description, "single");
});

test("accepts title/summary as aliases", () => {
  const result = parseSkillMarkdown(`---\ntitle: T\nsummary: S\n---\nb`, "a.md");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "T");
  assert.equal(result.skill.description, "S");
});
