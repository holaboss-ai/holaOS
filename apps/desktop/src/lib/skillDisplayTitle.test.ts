import assert from "node:assert/strict";
import { test } from "node:test";
import { withSkillDisplayTitle } from "./skillDisplayTitle";

/** Mirrors electron/main.ts extractSkillMetadata: prefer the frontmatter title,
 *  falling back to the body H1. Kept here to assert the write→read round-trip. */
function readTitle(markdown: string, fallbackH1: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  let remaining = normalized;
  let frontmatterTitle = "";
  const fm = normalized.match(/^---\n([\s\S]*?)\n---\s*/);
  if (fm) {
    const titleMatch = fm[1].match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      const raw = titleMatch[1].replace(/\s+#.*$/, "").trim();
      frontmatterTitle =
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1).trim()
          : raw;
    }
    remaining = normalized.slice(fm[0].length).trim();
  }
  const h1 = remaining.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return frontmatterTitle || h1 || fallbackH1;
}

test("injects title into existing frontmatter and wins over the H1", () => {
  const md = `---\nname: pdf\ndescription: do pdf things\n---\n\n# PDF Processing Guide\n\nbody`;
  const out = withSkillDisplayTitle(md, "PDF Toolkit");
  assert.match(out, /^---\ntitle: "PDF Toolkit"\nname: pdf\n/);
  assert.equal(readTitle(out, "pdf"), "PDF Toolkit");
});

test("replaces an existing frontmatter title", () => {
  const md = `---\ntitle: "Old Name"\nname: pdf\n---\n\n# Heading`;
  const out = withSkillDisplayTitle(md, "PDF Toolkit");
  assert.equal(readTitle(out, "pdf"), "PDF Toolkit");
  assert.doesNotMatch(out, /Old Name/);
});

test("adds frontmatter when the document has none", () => {
  const md = `# PDF Processing Guide\n\nbody`;
  const out = withSkillDisplayTitle(md, "PDF Toolkit");
  assert.match(out, /^---\ntitle: "PDF Toolkit"\n---\n/);
  assert.equal(readTitle(out, "pdf"), "PDF Toolkit");
});

test("empty or whitespace display name leaves content untouched", () => {
  const md = `---\nname: pdf\n---\n# Heading`;
  assert.equal(withSkillDisplayTitle(md, "   "), md);
});

test("escapes quotes so the emitted YAML scalar stays valid", () => {
  const md = `---\nname: pdf\n---\n# Heading`;
  const out = withSkillDisplayTitle(md, 'The "Best" PDF');
  assert.match(out, /title: "The \\"Best\\" PDF"/);
  assert.equal(readTitle(out, "pdf"), 'The \\"Best\\" PDF');
});

test("preserves the body after the frontmatter", () => {
  const md = `---\nname: pdf\n---\n\n# Heading\n\nfirst paragraph\n\nsecond`;
  const out = withSkillDisplayTitle(md, "PDF Toolkit");
  assert.match(out, /# Heading\n\nfirst paragraph\n\nsecond$/);
});
