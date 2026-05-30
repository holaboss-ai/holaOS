import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { newestMtime, resolveRuntimeBundleState } from "./runtime-bundle-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("resolveRuntimeBundleState watches shared runtime contracts", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const runtimeBundleState = resolveRuntimeBundleState(desktopRoot);

  assert.ok(runtimeBundleState.runtimeSourceInputs.includes(path.join(runtimeBundleState.repoRoot, "shared")));
});

test("newestMtime ignores ordinary markdown but includes embedded skill assets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-bundle-state-"));
  const ordinaryDocsDir = path.join(root, "docs");
  const embeddedSkillDir = path.join(root, "runtime", "harnesses", "src", "embedded-skills", "create-teammate");
  fs.mkdirSync(ordinaryDocsDir, { recursive: true });
  fs.mkdirSync(embeddedSkillDir, { recursive: true });

  const ordinaryMarkdownPath = path.join(ordinaryDocsDir, "notes.md");
  const skillMarkdownPath = path.join(embeddedSkillDir, "SKILL.md");
  fs.writeFileSync(ordinaryMarkdownPath, "# Notes\n");
  fs.writeFileSync(skillMarkdownPath, "---\nname: create-teammate\ndescription: Test skill.\n---\n");

  const ordinaryMarkdownTime = new Date("2026-05-28T12:00:00.000Z");
  const skillMarkdownTime = new Date("2026-05-28T12:30:00.000Z");
  const rootTime = new Date("2026-05-28T11:00:00.000Z");
  fs.utimesSync(ordinaryMarkdownPath, ordinaryMarkdownTime, ordinaryMarkdownTime);
  fs.utimesSync(skillMarkdownPath, skillMarkdownTime, skillMarkdownTime);
  fs.utimesSync(ordinaryDocsDir, rootTime, rootTime);
  fs.utimesSync(path.join(root, "runtime"), rootTime, rootTime);
  fs.utimesSync(path.join(root, "runtime", "harnesses"), rootTime, rootTime);
  fs.utimesSync(path.join(root, "runtime", "harnesses", "src"), rootTime, rootTime);
  fs.utimesSync(path.join(root, "runtime", "harnesses", "src", "embedded-skills"), rootTime, rootTime);
  fs.utimesSync(embeddedSkillDir, rootTime, rootTime);
  fs.utimesSync(root, rootTime, rootTime);

  const observedNewest = await newestMtime(root);
  assert.equal(observedNewest, skillMarkdownTime.getTime());
});
