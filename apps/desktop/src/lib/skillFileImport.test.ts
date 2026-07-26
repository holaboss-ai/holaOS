import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillMarkdown } from "./skillFileImport";

test("accepts a file declaring name and description", () => {
  const result = parseSkillMarkdown(
    `---\nname: Weekly Report\ndescription: Pulls the numbers.\n---\n\nDo it.`,
    "weekly.md",
  );
  assert.equal(result.ok, true);
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
    `---\r\nname: "Quoted"\r\ndescription: 'single'\r\n---\r\nbody`,
    "a.md",
  );
  assert.equal(result.ok, true);
});

test("accepts title/summary as aliases", () => {
  const result = parseSkillMarkdown(`---\ntitle: T\nsummary: S\n---\nb`, "a.md");
  assert.equal(result.ok, true);
});
