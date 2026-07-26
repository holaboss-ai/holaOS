import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  materializeClaudeSkills,
  parseClaudeStreamDelta,
  splitShellWords,
} from "./claude-code.js";

test("parseClaudeStreamDelta extracts text/thinking token deltas, ignores the rest", () => {
  assert.deepEqual(
    parseClaudeStreamDelta({
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    }),
    { kind: "text", text: "Hel" },
  );
  assert.deepEqual(
    parseClaudeStreamDelta({
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    }),
    { kind: "thinking", text: "hmm" },
  );
  // Non-delta frames + empty deltas → null (no spurious emits).
  assert.equal(
    parseClaudeStreamDelta({ event: { type: "content_block_start" } }),
    null,
  );
  assert.equal(
    parseClaudeStreamDelta({
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
    }),
    null,
  );
  assert.equal(parseClaudeStreamDelta({}), null);
});

test("splitShellWords splits plain, quoted, and escaped tokens", () => {
  assert.deepEqual(splitShellWords(undefined), []);
  assert.deepEqual(splitShellWords("   "), []);
  assert.deepEqual(splitShellWords("--model claude-opus-4-8"), [
    "--model",
    "claude-opus-4-8",
  ]);
  assert.deepEqual(splitShellWords('--add-dir "/opt/my dir" --foo'), [
    "--add-dir",
    "/opt/my dir",
    "--foo",
  ]);
  assert.deepEqual(splitShellWords("--x 'a b' c"), ["--x", "a b", "c"]);
});

test("materializeClaudeSkills returns null for empty/undefined input", () => {
  assert.equal(materializeClaudeSkills(undefined), null);
  assert.equal(materializeClaudeSkills([]), null);
  assert.equal(materializeClaudeSkills(["", "   "]), null);
});

test("materializeClaudeSkills stages SKILL.md dirs under .claude/skills, skips the rest", () => {
  const good = mkdtempSync(join(tmpdir(), "cskill-good-"));
  const bad = mkdtempSync(join(tmpdir(), "cskill-bad-"));
  writeFileSync(join(good, "SKILL.md"), "# good skill");
  try {
    const mat = materializeClaudeSkills([good, bad]);
    assert.ok(mat, "expected a materialization for a dir with SKILL.md");
    assert.ok(
      existsSync(join(mat.dir, ".claude", "skills", basename(good), "SKILL.md")),
    );
    assert.equal(
      existsSync(join(mat.dir, ".claude", "skills", basename(bad))),
      false,
    );
    mat.cleanup();
    assert.equal(existsSync(mat.dir), false);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test("materializeClaudeSkills returns null when no dir has a SKILL.md", () => {
  const bad = mkdtempSync(join(tmpdir(), "cskill-none-"));
  try {
    assert.equal(materializeClaudeSkills([bad]), null);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});
