import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  TeammateRecord,
  TeammateSkillRecord,
} from "@holaboss/runtime-state-store";
import yaml from "js-yaml";

import { resolveWorkspaceSkills } from "./workspace-skills.js";

const TEAMMATES_DIR = "teammates";
const SKILLS_DIR = "skills";

export interface ResolvedTeammateSkillRecord extends TeammateSkillRecord {
  storageOrigin: "filesystem";
  sourceDir: string | null;
  filePath: string | null;
  hasSidecarAssets: boolean;
  skillMarkdown: string;
  grantedTools: string[];
  grantedCommands: string[];
  sidecarFiles: ResolvedTeammateSkillSidecarFileRecord[];
  sidecarDirectories: string[];
}

export interface ResolvedTeammateSkillSidecarFileRecord {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export interface TeammateSkillSidecarFileInput {
  path: string;
  content: string;
}

export interface TeammateSkillInput {
  skillId?: string | null;
  name?: string | null;
  content?: string | null;
  skillMarkdown?: string | null;
  grantedTools?: string[] | null;
  grantedCommands?: string[] | null;
  sidecarFiles?: TeammateSkillSidecarFileInput[] | null;
  directories?: string[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface NormalizedDesiredSkill {
  skillId: string;
  name: string | null;
  content: string | null;
  skillMarkdown: string | null;
  grantedTools?: string[];
  grantedCommands?: string[];
  sidecarFiles?: TeammateSkillSidecarFileInput[];
  directories?: string[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stripMarkdownFrontmatter(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return normalized;
  }
  return normalized.slice(match[0].length);
}

function parseSkillFrontmatter(value: string): Record<string, unknown> | null {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }
  try {
    const parsed = yaml.load(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function teammatePathSegment(value: string, fieldName: string): string {
  const trimmed = nonEmptyString(value);
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error(`${fieldName} must be a non-empty path segment`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`${fieldName} must not contain path separators`);
  }
  return trimmed;
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function slugifiedSkillId(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug.length > 0 ? slug : null;
}

function canonicalSkillId(params: {
  teammateId: string;
  input: TeammateSkillInput;
  index: number;
}): string {
  const explicitSkillId = nonEmptyString(params.input.skillId);
  if (explicitSkillId) {
    return teammatePathSegment(explicitSkillId.toLowerCase(), `skills[${params.index}].skill_id`);
  }
  const markdownFrontmatter = nonEmptyString(params.input.skillMarkdown)
    ? parseSkillFrontmatter(params.input.skillMarkdown ?? "")
    : null;
  const frontmatterSkillId = nonEmptyString(markdownFrontmatter?.name);
  if (frontmatterSkillId) {
    return teammatePathSegment(frontmatterSkillId.toLowerCase(), `skills[${params.index}].skill_id`);
  }
  const derived = slugifiedSkillId(nonEmptyString(params.input.name) ?? "");
  if (!derived) {
    throw new Error(
      `skills[${params.index}] requires skill_id or a valid frontmatter name when the display name cannot be slugified`,
    );
  }
  return teammatePathSegment(derived, `skills[${params.index}].skill_id`);
}

function teammateSkillsRoot(workspaceDir: string, teammateId: string): string {
  return path.join(
    workspaceDir,
    TEAMMATES_DIR,
    teammatePathSegment(teammateId, "teammate_id"),
    SKILLS_DIR,
  );
}

function teammateSkillDir(workspaceDir: string, teammateId: string, skillId: string): string {
  return path.join(
    teammateSkillsRoot(workspaceDir, teammateId),
    teammatePathSegment(skillId, "skill_id"),
  );
}

function normalizedRelativeBundlePath(value: string, fieldName: string): string {
  const trimmed = nonEmptyString(value);
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty relative path`);
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    throw new Error(`${fieldName} must be a workspace-relative path`);
  }
  const segments = trimmed
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error(`${fieldName} must be a non-empty relative path`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\0")) {
      throw new Error(`${fieldName} contains an invalid path segment`);
    }
  }
  return segments.join("/");
}

function skillMarkdownFromExistingFile(skillDir: string): string | null {
  try {
    return fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

function stripGrantAliases(frontmatter: Record<string, unknown>): void {
  for (const key of [
    "holaboss_granted_tools",
    "holaboss-granted-tools",
    "holaboss_tools",
    "holaboss-tools",
    "capability_grants",
    "capability-grants",
    "holaboss_granted_commands",
    "holaboss-granted-commands",
    "holaboss_commands",
    "holaboss-commands",
    "command_grants",
    "command-grants",
  ]) {
    delete frontmatter[key];
  }
}

function teammateSkillMarkdown(params: {
  skillId: string;
  input: NormalizedDesiredSkill;
  existingSkillMarkdown?: string | null;
}): string {
  const explicitMarkdown = nonEmptyString(params.input.skillMarkdown);
  const baseFrontmatter = (() => {
    if (explicitMarkdown) {
      return parseSkillFrontmatter(explicitMarkdown) ?? {};
    }
    const existingFrontmatter = nonEmptyString(params.existingSkillMarkdown)
      ? parseSkillFrontmatter(params.existingSkillMarkdown ?? "")
      : null;
    return existingFrontmatter ?? {};
  })();
  const body = explicitMarkdown
    ? stripMarkdownFrontmatter(explicitMarkdown).trim()
    : nonEmptyString(params.input.content) ?? "";
  if (!body) {
    throw new Error(`skills.${params.skillId} requires non-empty SKILL.md body content`);
  }

  const frontmatter: Record<string, unknown> = {
    ...baseFrontmatter,
    name: params.skillId,
    description:
      nonEmptyString(params.input.name) ??
      nonEmptyString(baseFrontmatter.description) ??
      nonEmptyString(baseFrontmatter.name) ??
      params.skillId,
  };
  stripGrantAliases(frontmatter);

  const existingHolaboss = isRecord(frontmatter.holaboss)
    ? { ...frontmatter.holaboss }
    : {};
  if (params.input.grantedTools !== undefined) {
    if (params.input.grantedTools.length > 0) {
      existingHolaboss.granted_tools = [...params.input.grantedTools];
    } else {
      delete existingHolaboss.granted_tools;
      delete existingHolaboss["granted-tools"];
      delete existingHolaboss.tools;
    }
  }
  if (params.input.grantedCommands !== undefined) {
    if (params.input.grantedCommands.length > 0) {
      existingHolaboss.granted_commands = [...params.input.grantedCommands];
    } else {
      delete existingHolaboss.granted_commands;
      delete existingHolaboss["granted-commands"];
      delete existingHolaboss.commands;
    }
  }
  if (Object.keys(existingHolaboss).length > 0) {
    frontmatter.holaboss = existingHolaboss;
  } else {
    delete frontmatter.holaboss;
  }

  const dumpedFrontmatter = yaml
    .dump(frontmatter, { lineWidth: -1 })
    .trimEnd();
  return ["---", dumpedFrontmatter, "---", "", body, ""].join("\n");
}

function isoTimestampFromStat(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function collectSkillSidecars(sourceDir: string): {
  directories: string[];
  files: ResolvedTeammateSkillSidecarFileRecord[];
} {
  const directories: string[] = [];
  const files: ResolvedTeammateSkillSidecarFileRecord[] = [];
  const visit = (currentDir: string, relativeDir: string): void => {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        directories.push(relativePath);
        visit(path.join(currentDir, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (relativePath === "SKILL.md") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const content = fs.readFileSync(fullPath, "utf8");
      files.push({
        relativePath,
        content,
        sizeBytes: Buffer.byteLength(content),
      });
    }
  };
  visit(sourceDir, "");
  return { directories, files };
}

function clearExplicitSidecars(skillDir: string): void {
  const entries = fs.readdirSync(skillDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "SKILL.md") {
      continue;
    }
    fs.rmSync(path.join(skillDir, entry.name), { recursive: true, force: true });
  }
}

function desiredSkillSpec(params: {
  teammateId: string;
  input: TeammateSkillInput;
  index: number;
}): NormalizedDesiredSkill {
  const skillId = canonicalSkillId(params);
  const explicitMarkdown = nonEmptyString(params.input.skillMarkdown) ?? null;
  const sidecarFiles =
    params.input.sidecarFiles === undefined || params.input.sidecarFiles === null
      ? undefined
      : params.input.sidecarFiles.map((file, fileIndex) => {
          const relativePath = normalizedRelativeBundlePath(
            file.path,
            `skills[${params.index}].sidecar_files[${fileIndex}].path`,
          );
          if (relativePath.toLowerCase() === "skill.md") {
            throw new Error(
              `skills[${params.index}].sidecar_files[${fileIndex}].path cannot target root SKILL.md`,
            );
          }
          const content = nonEmptyString(file.content);
          if (!content) {
            throw new Error(
              `skills[${params.index}].sidecar_files[${fileIndex}].content must be non-empty`,
            );
          }
          return { path: relativePath, content };
        });
  const directories =
    params.input.directories === undefined || params.input.directories === null
      ? undefined
      : params.input.directories.map((directory, dirIndex) =>
          normalizedRelativeBundlePath(
            directory,
            `skills[${params.index}].directories[${dirIndex}]`,
          ),
        );
  if (!explicitMarkdown) {
    const name = nonEmptyString(params.input.name);
    const content = nonEmptyString(params.input.content);
    if (!name || !content) {
      throw new Error(
        `skills[${params.index}] requires either skill_markdown or both name and content`,
      );
    }
  }
  return {
    skillId,
    name: nonEmptyString(params.input.name),
    content: nonEmptyString(params.input.content),
    skillMarkdown: explicitMarkdown,
    grantedTools:
      params.input.grantedTools === undefined
        ? undefined
        : normalizedStringList(params.input.grantedTools),
    grantedCommands:
      params.input.grantedCommands === undefined
        ? undefined
        : normalizedStringList(params.input.grantedCommands),
    sidecarFiles,
    directories:
      directories === undefined
        ? undefined
        : [...new Set(directories)],
  };
}

function materializeTeammateSkill(params: {
  workspaceDir: string;
  teammateId: string;
  skill: NormalizedDesiredSkill;
}): void {
  const skillDir = teammateSkillDir(
    params.workspaceDir,
    params.teammateId,
    params.skill.skillId,
  );
  fs.mkdirSync(skillDir, { recursive: true });
  const existingSkillMarkdown = skillMarkdownFromExistingFile(skillDir);
  const hasExplicitBundleLayout =
    params.skill.sidecarFiles !== undefined ||
    params.skill.directories !== undefined;
  if (hasExplicitBundleLayout) {
    clearExplicitSidecars(skillDir);
  }
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    teammateSkillMarkdown({
      skillId: params.skill.skillId,
      input: params.skill,
      existingSkillMarkdown,
    }),
    "utf8",
  );
  if (params.skill.directories) {
    for (const relativeDirectory of params.skill.directories) {
      fs.mkdirSync(path.join(skillDir, ...relativeDirectory.split("/")), {
        recursive: true,
      });
    }
  }
  if (params.skill.sidecarFiles) {
    const seenSidecarFiles = new Set<string>();
    for (const sidecar of params.skill.sidecarFiles) {
      if (seenSidecarFiles.has(sidecar.path)) {
        throw new Error(
          `duplicate teammate sidecar file path for skill ${params.skill.skillId}: ${sidecar.path}`,
        );
      }
      seenSidecarFiles.add(sidecar.path);
      const sidecarPath = path.join(skillDir, ...sidecar.path.split("/"));
      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.writeFileSync(sidecarPath, sidecar.content, "utf8");
    }
  }
}

export function loadTeammateFilesystemSkills(params: {
  workspaceDir: string;
  teammateId: string;
}): ResolvedTeammateSkillRecord[] {
  const mapped: Array<ResolvedTeammateSkillRecord | null> = resolveWorkspaceSkills(params.workspaceDir, {
    teammateId: params.teammateId,
  })
    .filter(
      (skill) =>
        skill.origin === "teammate" &&
        skill.owner_teammate_id === params.teammateId,
    )
    .map((skill): ResolvedTeammateSkillRecord | null => {
      try {
        const raw = fs.readFileSync(skill.file_path, "utf8");
        const frontmatter = parseSkillFrontmatter(raw);
        const name =
          nonEmptyString(frontmatter?.description) ??
          nonEmptyString(frontmatter?.name) ??
          skill.skill_name;
        const stat = fs.statSync(skill.file_path);
        const sidecars = collectSkillSidecars(skill.source_dir);
        return {
          skillId: skill.skill_id,
          name: name ?? skill.skill_id,
          content: stripMarkdownFrontmatter(raw).trim(),
          createdAt: isoTimestampFromStat(stat.birthtime),
          updatedAt: isoTimestampFromStat(stat.mtime),
          storageOrigin: "filesystem",
          sourceDir: skill.source_dir,
          filePath: skill.file_path,
          hasSidecarAssets:
            sidecars.directories.length > 0 || sidecars.files.length > 0,
          skillMarkdown: raw,
          grantedTools: [...skill.granted_tools],
          grantedCommands: [...skill.granted_commands],
          sidecarFiles: sidecars.files,
          sidecarDirectories: sidecars.directories,
        };
      } catch {
        return null;
      }
    });
  return mapped.filter(
    (skill): skill is ResolvedTeammateSkillRecord => skill !== null,
  );
}

export function resolvedTeammateSkillsForRecord(params: {
  workspaceDir: string;
  teammate: TeammateRecord;
}): ResolvedTeammateSkillRecord[] {
  const teammateId = nonEmptyString(params.teammate.teammateId);
  if (!teammateId) {
    return [];
  }
  return loadTeammateFilesystemSkills({
    workspaceDir: params.workspaceDir,
    teammateId,
  });
}

export function writeTeammateSkills(params: {
  workspaceDir: string;
  teammateId: string;
  skills: TeammateSkillInput[];
}): ResolvedTeammateSkillRecord[] {
  const teammateId = teammatePathSegment(params.teammateId, "teammate_id");
  const rootDir = teammateSkillsRoot(params.workspaceDir, teammateId);
  const desiredSkills = params.skills.map((skill, index) =>
    desiredSkillSpec({
      teammateId,
      input: skill,
      index,
    }),
  );
  const seenSkillIds = new Set<string>();
  for (const skill of desiredSkills) {
    if (seenSkillIds.has(skill.skillId)) {
      throw new Error(`duplicate teammate skill_id: ${skill.skillId}`);
    }
    seenSkillIds.add(skill.skillId);
  }

  if (desiredSkills.length === 0) {
    fs.rmSync(rootDir, { recursive: true, force: true });
    return [];
  }

  fs.mkdirSync(rootDir, { recursive: true });
  for (const skill of desiredSkills) {
    materializeTeammateSkill({
      workspaceDir: params.workspaceDir,
      teammateId,
      skill,
    });
  }

  const existingEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of existingEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const existingSkillId = teammatePathSegment(entry.name, "skill_id");
    if (seenSkillIds.has(existingSkillId)) {
      continue;
    }
    fs.rmSync(path.join(rootDir, entry.name), { recursive: true, force: true });
  }

  return loadTeammateFilesystemSkills({
    workspaceDir: params.workspaceDir,
    teammateId,
  });
}

export function upsertTeammateSkill(params: {
  workspaceDir: string;
  teammateId: string;
  skill: TeammateSkillInput;
}): ResolvedTeammateSkillRecord {
  const teammateId = teammatePathSegment(params.teammateId, "teammate_id");
  const desiredSkill = desiredSkillSpec({
    teammateId,
    input: params.skill,
    index: 0,
  });
  fs.mkdirSync(teammateSkillsRoot(params.workspaceDir, teammateId), {
    recursive: true,
  });
  materializeTeammateSkill({
    workspaceDir: params.workspaceDir,
    teammateId,
    skill: desiredSkill,
  });
  const resolved = loadTeammateFilesystemSkills({
    workspaceDir: params.workspaceDir,
    teammateId,
  }).find((entry) => entry.skillId === desiredSkill.skillId);
  if (!resolved) {
    throw new Error(`teammate skill ${desiredSkill.skillId} not found after write`);
  }
  return resolved;
}

export function deleteTeammateSkill(params: {
  workspaceDir: string;
  teammateId: string;
  skillId: string;
}): boolean {
  const teammateId = teammatePathSegment(params.teammateId, "teammate_id");
  const skillId = teammatePathSegment(params.skillId, "skill_id");
  const rootDir = teammateSkillsRoot(params.workspaceDir, teammateId);
  const skillDir = teammateSkillDir(params.workspaceDir, teammateId, skillId);
  if (!fs.existsSync(skillDir)) {
    return false;
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
  if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
  return true;
}

export function teammateSkillRelativeFilePath(params: {
  teammateId: string;
  skillId: string;
}): string {
  return path
    .join(
      TEAMMATES_DIR,
      teammatePathSegment(params.teammateId, "teammate_id"),
      SKILLS_DIR,
      teammatePathSegment(params.skillId, "skill_id"),
      "SKILL.md",
    )
    .split(path.sep)
    .join("/");
}

export function teammateSkillRelativeSourceDir(params: {
  teammateId: string;
  skillId: string;
}): string {
  return path
    .join(
      TEAMMATES_DIR,
      teammatePathSegment(params.teammateId, "teammate_id"),
      SKILLS_DIR,
      teammatePathSegment(params.skillId, "skill_id"),
    )
    .split(path.sep)
    .join("/");
}

export function createTeammateIdForFilesystem(): string {
  return randomUUID();
}
