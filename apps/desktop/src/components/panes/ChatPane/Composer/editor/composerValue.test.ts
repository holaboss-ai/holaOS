import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComposerDoc,
  CAPABILITY_MENTION_NAME,
  extractComposerValue,
  type ProseMirrorNode,
  SKILL_MENTION_NAME,
} from "./composerValue";

const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});
const skill = (skillId: string, title = skillId): ProseMirrorNode => ({
  type: SKILL_MENTION_NAME,
  attrs: { skillId, title },
});
const capability = (
  capabilityId: string,
  title = capabilityId,
): ProseMirrorNode => ({
  type: CAPABILITY_MENTION_NAME,
  attrs: { capabilityId, title },
});
const text = (value: string): ProseMirrorNode => ({ type: "text", text: value });

test("extracts body text with mentions contributing nothing", () => {
  const value = extractComposerValue(
    para(skill("plugin-creator", "Plugin Creator"), text("Help me create a plugin")),
  );
  assert.equal(value.text, "Help me create a plugin");
  assert.deepEqual(value.skillIds, ["plugin-creator"]);
});

test("collects skill ids in document order, de-duplicated", () => {
  const value = extractComposerValue(
    para(skill("a"), text("x "), skill("b"), text(" y "), skill("a")),
  );
  assert.deepEqual(value.skillIds, ["a", "b"]);
  assert.equal(value.text, "x  y ");
});

test("empty body when only chips are present", () => {
  const value = extractComposerValue(para(skill("a"), skill("b")));
  assert.equal(value.text, "");
  assert.deepEqual(value.skillIds, ["a", "b"]);
});

test("hard breaks become newlines", () => {
  const value = extractComposerValue(
    para(text("line one"), { type: "hardBreak" }, text("line two")),
  );
  assert.equal(value.text, "line one\nline two");
});

test("buildComposerDoc round-trips through extractComposerValue", () => {
  const original = {
    text: "do the thing\nplease",
    skillIds: ["a", "b"],
    capabilityIds: [],
  };
  const doc = buildComposerDoc(original, (id) => id.toUpperCase());
  assert.deepEqual(extractComposerValue(doc), original);
});

test("buildComposerDoc places chips before body", () => {
  const doc = buildComposerDoc(
    { text: "hi", skillIds: ["a"], capabilityIds: [] },
    (id) => id,
  );
  const content = doc.content?.[0]?.content ?? [];
  assert.equal(content[0]?.type, SKILL_MENTION_NAME);
  assert.equal(content[content.length - 1]?.type, "text");
});

test("collects capability ids in document order, de-duplicated", () => {
  const value = extractComposerValue(
    para(
      capability("social-suite"),
      text("post this "),
      capability("crm"),
      capability("social-suite"),
    ),
  );
  assert.deepEqual(value.capabilityIds, ["social-suite", "crm"]);
  assert.deepEqual(value.skillIds, []);
  assert.equal(value.text, "post this ");
});

test("buildComposerDoc round-trips capability chips", () => {
  const original = {
    text: "go",
    skillIds: ["a"],
    capabilityIds: ["social-suite"],
  };
  const doc = buildComposerDoc(original, (id) => id);
  const value = extractComposerValue(doc);
  assert.deepEqual(value.capabilityIds, ["social-suite"]);
  assert.deepEqual(value.skillIds, ["a"]);
  assert.equal(value.text, "go");
});

// Parity with ChatPane.serializeQuotedPrompt (kept in sync intentionally):
// skill ids prepend as `/id` lines, blank line, then trimmed body.
function serializeQuotedPrompt(text: string, skillIds: string[]): string {
  const body = text.trim();
  const lines = skillIds.map((id) => `/${id}`);
  if (lines.length === 0) return body;
  if (!body) return lines.join("\n");
  return [...lines, "", body].join("\n");
}

test("editor value serializes to the same wire format as before", () => {
  const value = extractComposerValue(
    para(skill("plugin-creator"), text("Help me create a plugin")),
  );
  assert.equal(
    serializeQuotedPrompt(value.text, value.skillIds),
    "/plugin-creator\n\nHelp me create a plugin",
  );
});
