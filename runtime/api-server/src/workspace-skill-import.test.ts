import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import * as tar from "tar";

import {
  importSkillFromGithub,
  mapSkillFrontmatter,
  parseGithubSkillRef,
  SkillImportError,
  slugifySkillId,
} from "./workspace-skill-import.js";

// ─── parseGithubSkillRef ──────────────────────────────────────────────

test("parseGithubSkillRef: tree URL yields owner/repo/ref/subPath", () => {
  const ref = parseGithubSkillRef("https://github.com/anthropics/skills/tree/main/document-skills/pdf");
  assert.deepEqual(ref, { owner: "anthropics", repo: "skills", ref: "main", subPath: "document-skills/pdf" });
});

test("parseGithubSkillRef: blob URL drops the SKILL.md filename to the folder", () => {
  const ref = parseGithubSkillRef("https://github.com/anthropics/skills/blob/main/document-skills/pdf/SKILL.md");
  assert.equal(ref.subPath, "document-skills/pdf");
});

test("parseGithubSkillRef: bare repo defaults ref to HEAD with empty subPath", () => {
  const ref = parseGithubSkillRef("https://github.com/acme/my-skill");
  assert.deepEqual(ref, { owner: "acme", repo: "my-skill", ref: "HEAD", subPath: "" });
});

test("parseGithubSkillRef: refOverride wins over the URL ref", () => {
  const ref = parseGithubSkillRef("https://github.com/acme/repo/tree/main/s", "release/2026.630");
  assert.equal(ref.ref, "release/2026.630");
});

test("parseGithubSkillRef: rejects non-github URLs", () => {
  assert.throws(() => parseGithubSkillRef("https://gitlab.com/a/b"), SkillImportError);
});

test("parseGithubSkillRef: rejects path traversal", () => {
  assert.throws(() => parseGithubSkillRef("https://github.com/a/b/tree/main/../../etc"), SkillImportError);
});

// ─── slugifySkillId ───────────────────────────────────────────────────

test("slugifySkillId: normalizes spaces and case", () => {
  assert.equal(slugifySkillId("PDF Form Filler"), "pdf-form-filler");
});

test("slugifySkillId: throws on names that reduce to nothing", () => {
  assert.throws(() => slugifySkillId("!!!"), SkillImportError);
});

// ─── mapSkillFrontmatter ──────────────────────────────────────────────

test("mapSkillFrontmatter: keeps body verbatim when name matches and no allowed-tools", () => {
  const raw = "---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n\nbody\n";
  const mapped = mapSkillFrontmatter(raw, "pdf");
  assert.equal(mapped.content, raw);
  assert.equal(mapped.name, "pdf");
  assert.equal(mapped.description, "Work with PDFs.");
});

test("mapSkillFrontmatter: maps allowed-tools to holaboss_granted_tools", () => {
  const raw = "---\nname: pdf\ndescription: Work with PDFs.\nallowed-tools: bash, python\n---\n# PDF\nbody\n";
  const mapped = mapSkillFrontmatter(raw, "pdf");
  assert.deepEqual(mapped.grantedTools, ["bash", "python"]);
  assert.match(mapped.content, /holaboss_granted_tools/);
  assert.doesNotMatch(mapped.content, /allowed-tools/);
});

test("mapSkillFrontmatter: forces frontmatter name to the installed id", () => {
  const raw = "---\nname: Some Skill\ndescription: Does things.\n---\nbody\n";
  const mapped = mapSkillFrontmatter(raw, "some-skill");
  assert.match(mapped.content, /name: some-skill/);
});

test("mapSkillFrontmatter: throws when description is missing", () => {
  const raw = "---\nname: pdf\n---\nbody\n";
  assert.throws(() => mapSkillFrontmatter(raw, "pdf"), SkillImportError);
});

// ─── importSkillFromGithub (full path, stubbed fetch) ─────────────────

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function buildRepoTarball(): Promise<Buffer> {
  const src = mkTmp("hb-skill-src-");
  const skillDir = path.join(src, "repo-main", "skills", "pdf");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: pdf\ndescription: Use when working with PDF files.\nallowed-tools: bash, python\n---\n# PDF\n\nExtract text.\n",
  );
  const scriptPath = path.join(skillDir, "scripts", "run.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
  fs.chmodSync(scriptPath, 0o755);

  const tarPath = path.join(src, "archive.tgz");
  await tar.c({ gzip: true, cwd: src, file: tarPath }, ["repo-main"]);
  return fs.readFileSync(tarPath);
}

test("importSkillFromGithub: extracts folder, maps frontmatter, writes all files", async () => {
  const tarball = await buildRepoTarball();
  globalThis.fetch = (async () => new Response(new Uint8Array(tarball), { status: 200 })) as typeof fetch;

  const workspaceDir = mkTmp("hb-skill-ws-");
  const result = await importSkillFromGithub({
    workspaceDir,
    url: "https://github.com/acme/repo/tree/main/skills/pdf",
  });

  assert.equal(result.id, "pdf");
  assert.equal(result.replaced, false);
  assert.deepEqual(result.granted_tools, ["bash", "python"]);

  const skillMd = fs.readFileSync(path.join(workspaceDir, "skills", "pdf", "SKILL.md"), "utf8");
  assert.match(skillMd, /name: pdf/);
  assert.match(skillMd, /holaboss_granted_tools/);
  assert.doesNotMatch(skillMd, /allowed-tools/);

  const script = path.join(workspaceDir, "skills", "pdf", "scripts", "run.sh");
  assert.ok(fs.existsSync(script), "bundled script should be materialized");
  assert.ok((fs.statSync(script).mode & 0o111) !== 0, "executable bit should be preserved");
});

test("importSkillFromGithub: re-import reports replaced=true", async () => {
  const tarball = await buildRepoTarball();
  globalThis.fetch = (async () => new Response(new Uint8Array(tarball), { status: 200 })) as typeof fetch;

  const workspaceDir = mkTmp("hb-skill-ws-");
  const url = "https://github.com/acme/repo/tree/main/skills/pdf";
  await importSkillFromGithub({ workspaceDir, url });
  const second = await importSkillFromGithub({ workspaceDir, url });
  assert.equal(second.replaced, true);
});
