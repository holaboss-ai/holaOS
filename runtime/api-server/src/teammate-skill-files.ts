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
}

export interface TeammateSkillInput {
  skillId?: string | null;
  name: string;
  content: string;
  createdAt?: string | null;
  updatedAt?: string | null;
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
  const derived = slugifiedSkillId(params.input.name);
  if (!derived) {
    throw new Error(
      `skills[${params.index}] requires skill_id when the name cannot be slugified`,
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

function teammateSkillMarkdown(params: {
  skillId: string;
  name: string;
  content: string;
}): string {
  const frontmatter = yaml
    .dump(
      {
        name: params.skillId,
        description: params.name.trim(),
      },
      { lineWidth: -1 },
    )
    .trimEnd();
  const body = params.content.trim();
  return ["---", frontmatter, "---", "", body, ""].join("\n");
}

function isoTimestampFromStat(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
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
        const sidecarEntries = fs
          .readdirSync(skill.source_dir, { withFileTypes: true })
          .filter((entry) => entry.name !== "SKILL.md");
        return {
          skillId: skill.skill_id,
          name: name ?? skill.skill_id,
          content: stripMarkdownFrontmatter(raw).trim(),
          createdAt: isoTimestampFromStat(stat.birthtime),
          updatedAt: isoTimestampFromStat(stat.mtime),
          storageOrigin: "filesystem",
          sourceDir: skill.source_dir,
          filePath: skill.file_path,
          hasSidecarAssets: sidecarEntries.length > 0,
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
  const desiredSkills = params.skills.map((skill, index) => {
    const name = nonEmptyString(skill.name);
    const content = nonEmptyString(skill.content);
    if (!name || !content) {
      throw new Error(`skills[${index}] requires both name and content`);
    }
    const skillId = canonicalSkillId({
      teammateId,
      input: skill,
      index,
    });
    return {
      skillId,
      name,
      content,
    };
  });
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
    const skillDir = teammateSkillDir(params.workspaceDir, teammateId, skill.skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      teammateSkillMarkdown(skill),
      "utf8",
    );
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
