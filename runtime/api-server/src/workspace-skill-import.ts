import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import * as tar from "tar";

/**
 * Import an open-source skill (a folder containing SKILL.md, optionally with
 * bundled scripts/ and references/) straight from a public GitHub repo into a
 * workspace's skills/ dir, where the runtime auto-discovers it. This is the
 * folder-aware sibling of `materializeSkill`, which only lands a single body.
 *
 * Foreign SKILL.md files (Anthropic / Claude Code format) are accepted as-is;
 * `allowed-tools` is mapped to `holaboss_granted_tools` and the frontmatter
 * `name` is aligned to the installed skill id. Unknown fields are preserved.
 */

const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 300;

export class SkillImportError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SkillImportError";
    this.statusCode = statusCode;
  }
}

export interface GithubSkillRef {
  owner: string;
  repo: string;
  ref: string;
  subPath: string;
}

export interface SkillImportFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface SkillImportPreview {
  id: string;
  name: string;
  description: string;
  granted_tools: string[];
  files: SkillImportFile[];
  body_preview: string;
  source_url: string;
  ref: string;
}

export interface SkillImportResult {
  id: string;
  name: string;
  description: string;
  granted_tools: string[];
  files: SkillImportFile[];
  source_url: string;
  ref: string;
  replaced: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function slugifySkillId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-+/g, "-");
  if (!slug || slug === "." || slug === "..") {
    throw new SkillImportError(422, `cannot derive a valid skill id from name "${name}"`);
  }
  return slug;
}

/**
 * Parse a github.com URL into repo coordinates + the sub-path of the skill
 * folder. Accepts a bare repo, a `tree/<ref>/<path>` folder, or a
 * `blob/<ref>/<path>/SKILL.md` file (the file's folder is used). The ref is a
 * single URL segment; pass `refOverride` for branches whose name has a slash.
 */
export function parseGithubSkillRef(rawUrl: string, refOverride?: string): GithubSkillRef {
  const url = rawUrl.trim();
  const withoutProto = url.replace(/^https?:\/\/github\.com\//, "");
  if (withoutProto === url) {
    throw new SkillImportError(
      400,
      "not a github.com URL (expected https://github.com/owner/repo/tree/<ref>/<path>)",
    );
  }
  const parts = withoutProto.replace(/\/+$/, "").split("/");
  const owner = parts[0];
  const repo = (parts[1] ?? "").replace(/\.git$/, "");
  if (!owner || !repo) {
    throw new SkillImportError(400, "github URL is missing owner/repo");
  }

  const kind = parts[2];
  const refInUrl = parts[3];
  let subPath = parts.slice(4).join("/");
  if (kind === "blob") {
    subPath = subPath.replace(/\/?SKILL\.md$/i, "");
    if (/\.[a-z0-9]+$/i.test(subPath)) {
      subPath = subPath.replace(/\/[^/]+$/, "");
    }
  } else if (kind && kind !== "tree") {
    throw new SkillImportError(400, `unsupported github URL segment "${kind}" (use /tree/ or /blob/)`);
  }

  const ref = (refOverride?.trim() || refInUrl || "HEAD").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new SkillImportError(400, `invalid git ref "${ref}"`);
  }
  subPath = subPath.replace(/^\/+|\/+$/g, "");
  if (subPath.split("/").includes("..")) {
    throw new SkillImportError(400, "path traversal not allowed in skill path");
  }
  return { owner, repo, ref, subPath };
}

interface MappedSkill {
  content: string;
  name: string;
  description: string;
  grantedTools: string[];
}

interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
  name: string;
  description: string;
}

function parseSkillMarkdown(raw: string): ParsedSkill {
  if (!raw.startsWith("---")) {
    throw new SkillImportError(422, "SKILL.md must start with YAML frontmatter (--- ... ---)");
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    throw new SkillImportError(422, "SKILL.md frontmatter is not terminated by a closing ---");
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw.slice(3, end));
  } catch (error) {
    throw new SkillImportError(422, `invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : error}`);
  }
  const frontmatter = isRecord(parsed) ? parsed : {};
  return {
    frontmatter,
    body: raw.slice(end + 4).replace(/^\r?\n/, ""),
    name: typeof frontmatter.name === "string" ? frontmatter.name.trim() : "",
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
  };
}

/**
 * Normalize a foreign SKILL.md so the runtime loader accepts it: the
 * frontmatter `name` is forced to the installed `id`, and `allowed-tools` is
 * folded into `holaboss_granted_tools`. When nothing needs changing the raw
 * body is kept verbatim to preserve fidelity.
 */
export function mapSkillFrontmatter(raw: string, id: string): MappedSkill {
  const { frontmatter, body, name, description } = parseSkillMarkdown(raw);
  if (!description) {
    throw new SkillImportError(422, "SKILL.md frontmatter must include a non-empty 'description'");
  }
  const grantedTools = toStringArray(frontmatter.holaboss_granted_tools ?? frontmatter["allowed-tools"]);

  const needsRewrite = name !== id || "allowed-tools" in frontmatter;
  if (!needsRewrite) {
    return { content: raw, name, description, grantedTools };
  }

  const next: Record<string, unknown> = { ...frontmatter, name: id };
  if ("allowed-tools" in next) {
    if (next.holaboss_granted_tools === undefined && grantedTools.length > 0) {
      next.holaboss_granted_tools = grantedTools;
    }
    delete next["allowed-tools"];
  }
  const nextFrontmatter = yaml.dump(next, { lineWidth: -1 }).trimEnd();
  const content = `---\n${nextFrontmatter}\n---\n${body}`;
  return { content, name: id, description, grantedTools };
}

function bodyPreview(content: string): string {
  const end = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
  const body = end === -1 ? content : content.slice(end + 4);
  return body.replace(/^\r?\n/, "").slice(0, 1500);
}

async function downloadTarball(ref: GithubSkillRef): Promise<Buffer> {
  const url = `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${ref.ref}`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new SkillImportError(502, `failed to reach GitHub: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 404) {
    throw new SkillImportError(404, `repo or ref not found: ${ref.owner}/${ref.repo}@${ref.ref}`);
  }
  if (!response.ok) {
    throw new SkillImportError(502, `GitHub returned HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_TARBALL_BYTES) {
    throw new SkillImportError(400, `tarball too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
  }
  return buffer;
}

interface ExtractedSkill {
  tmpRoot: string;
  skillSrc: string;
}

async function extractSkillFolder(buffer: Buffer, ref: GithubSkillRef): Promise<ExtractedSkill> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-skill-import-"));
  try {
    const tarPath = path.join(tmpRoot, "archive.tgz");
    fs.writeFileSync(tarPath, buffer);
    const outDir = path.join(tmpRoot, "x");
    fs.mkdirSync(outDir);
    await tar.x({ file: tarPath, cwd: outDir });

    const roots = fs.readdirSync(outDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (roots.length !== 1) {
      throw new SkillImportError(502, "unexpected tarball layout from GitHub");
    }
    const repoRoot = path.join(outDir, roots[0].name);
    const skillSrc = ref.subPath ? path.resolve(repoRoot, ref.subPath) : repoRoot;
    if (skillSrc !== repoRoot && !skillSrc.startsWith(`${repoRoot}${path.sep}`)) {
      throw new SkillImportError(400, "resolved skill path escapes the repository");
    }
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) {
      const where = ref.subPath ? `"${ref.subPath}"` : "the repository root";
      throw new SkillImportError(404, `no SKILL.md found at ${where}; point the URL at the skill folder`);
    }
    return { tmpRoot, skillSrc };
  } catch (error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw error;
  }
}

function collectFiles(root: string): SkillImportFile[] {
  const files: SkillImportFile[] = [];
  let totalBytes = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const stats = fs.lstatSync(abs);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      if (files.length >= MAX_FILES) {
        throw new SkillImportError(400, `skill has too many files (>${MAX_FILES})`);
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new SkillImportError(400, `skill is too large (>${Math.round(MAX_SKILL_BYTES / 1024 / 1024)} MB)`);
      }
      files.push({
        path: path.relative(root, abs).split(path.sep).join("/"),
        size: stats.size,
        executable: (stats.mode & 0o111) !== 0,
      });
    }
  };
  walk(root);
  return files;
}

function readSkill(skillSrc: string): { id: string; mapped: MappedSkill; files: SkillImportFile[] } {
  const raw = fs.readFileSync(path.join(skillSrc, "SKILL.md"), "utf8");
  const head = parseSkillMarkdown(raw);
  const id = slugifySkillId(head.name || head.description.slice(0, 40));
  const mapped = mapSkillFrontmatter(raw, id);
  return { id, mapped, files: collectFiles(skillSrc) };
}

export async function previewSkillFromGithub(params: { url: string; ref?: string }): Promise<SkillImportPreview> {
  const ref = parseGithubSkillRef(params.url, params.ref);
  const buffer = await downloadTarball(ref);
  const { tmpRoot, skillSrc } = await extractSkillFolder(buffer, ref);
  try {
    const { id, mapped, files } = readSkill(skillSrc);
    return {
      id,
      name: mapped.name,
      description: mapped.description,
      granted_tools: mapped.grantedTools,
      files,
      body_preview: bodyPreview(mapped.content),
      source_url: params.url.trim(),
      ref: ref.ref,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function importSkillFromGithub(params: {
  workspaceDir: string;
  url: string;
  ref?: string;
}): Promise<SkillImportResult> {
  const ref = parseGithubSkillRef(params.url, params.ref);
  const buffer = await downloadTarball(ref);
  const { tmpRoot, skillSrc } = await extractSkillFolder(buffer, ref);
  try {
    const { id, mapped, files } = readSkill(skillSrc);
    const skillDir = path.resolve(params.workspaceDir, "skills", id);
    const skillsRoot = path.resolve(params.workspaceDir, "skills");
    if (skillDir !== path.join(skillsRoot, id)) {
      throw new SkillImportError(400, "resolved skill id is not a safe directory name");
    }
    const replaced = fs.existsSync(skillDir);
    if (replaced) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    for (const file of files) {
      const dest = path.resolve(skillDir, file.path);
      if (dest !== skillDir && !dest.startsWith(`${skillDir}${path.sep}`)) {
        throw new SkillImportError(400, `path traversal not allowed: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (file.path === "SKILL.md") {
        fs.writeFileSync(dest, mapped.content, "utf8");
      } else {
        fs.copyFileSync(path.join(skillSrc, file.path), dest);
      }
      if (file.executable) {
        fs.chmodSync(dest, fs.statSync(dest).mode | 0o111);
      }
    }

    return {
      id,
      name: mapped.name,
      description: mapped.description,
      granted_tools: mapped.grantedTools,
      files,
      source_url: params.url.trim(),
      ref: ref.ref,
      replaced,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
