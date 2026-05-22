import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

export type ResolvedSkillOrigin = "workspace" | "embedded";

export interface ResolvedWorkspaceSkill {
  skill_id: string;
  skill_name: string;
  description: string;
  source_dir: string;
  file_path: string;
  origin: ResolvedSkillOrigin;
  granted_tools: string[];
  granted_commands: string[];
}

export interface PreparedQuotedWorkspaceSkills {
  body: string;
  quoted_skill_blocks: string[];
  missing_quoted_skill_ids: string[];
}

export interface WorkspaceSkillInvocationResult {
  text: string;
  skill_block: string;
  requested_name: string;
  skill_id: string;
  skill_name: string;
  skill_file_path: string;
  skill_base_dir: string;
  granted_tools: string[];
  granted_commands: string[];
  args: string | null;
}

const EMBEDDED_SKILLS_DIR_ENV = "HOLABOSS_EMBEDDED_SKILLS_DIR";
const WORKSPACE_SKILLS_RELATIVE_PATH = "skills";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSkillId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const skillId = value.trim();
  if (!skillId || skillId === "." || skillId === "..") {
    return null;
  }
  if (skillId.includes("/") || skillId.includes("\\") || skillId.includes("\0")) {
    return null;
  }
  return skillId;
}

function runtimeRootDir(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function directoryExists(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function embeddedSkillsRoot(): string {
  const override = (process.env[EMBEDDED_SKILLS_DIR_ENV] ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  const runtimeRoot = runtimeRootDir();
  const candidates = [
    path.join(runtimeRoot, "harnesses", "src", "embedded-skills"),
    path.join(runtimeRoot, "runtime", "harnesses", "src", "embedded-skills"),
  ];
  for (const candidate of candidates) {
    if (directoryExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? path.join(runtimeRoot, "harnesses", "src", "embedded-skills");
}

function skillFrontmatter(content: string): Record<string, unknown> | null {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }
  try {
    const parsed = yaml.load(match[1] ?? "");
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedFrontmatterString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedLowercaseString(value: unknown): string | null {
  const normalized = normalizedFrontmatterString(value)?.toLowerCase() ?? null;
  return normalized && normalized.length > 0 ? normalized : null;
}

function stripMarkdownFrontmatter(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return normalized;
  }
  return normalized.slice(match[0].length);
}

function normalizedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => normalizedLowercaseString(item)).filter((item): item is string => Boolean(item)))];
  }
  const single = normalizedFrontmatterString(value);
  if (!single) {
    return [];
  }
  return [
    ...new Set(
      single
        .replace(/^\[([\s\S]*?)\]$/u, "$1")
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .map((item) => normalizedLowercaseString(item))
        .filter((item): item is string => Boolean(item))
    ),
  ];
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function grantedToolsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const directKeys = [
    "holaboss_granted_tools",
    "holaboss-granted-tools",
    "holaboss_tools",
    "holaboss-tools",
    "capability_grants",
    "capability-grants",
  ];
  for (const key of directKeys) {
    const normalized = normalizedStringList(frontmatter[key]);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  const holaboss = nestedRecord(frontmatter, "holaboss");
  if (!holaboss) {
    return [];
  }
  for (const key of ["granted_tools", "granted-tools", "tools"]) {
    const normalized = normalizedStringList(holaboss[key]);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

function grantedCommandsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const directKeys = [
    "holaboss_granted_commands",
    "holaboss-granted-commands",
    "holaboss_commands",
    "holaboss-commands",
    "command_grants",
    "command-grants",
  ];
  for (const key of directKeys) {
    const normalized = normalizedStringList(frontmatter[key]);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  const holaboss = nestedRecord(frontmatter, "holaboss");
  if (!holaboss) {
    return [];
  }
  for (const key of ["granted_commands", "granted-commands", "commands"]) {
    const normalized = normalizedStringList(holaboss[key]);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

function normalizeSkillLookupToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseQuotedSkillInstruction(value: string): {
  skillIds: string[];
  body: string;
} {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const skillIds: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }
    const match = /^\/([A-Za-z0-9_-]+)$/.exec(line);
    if (!match) {
      return { skillIds: [], body: normalized.trim() };
    }
    skillIds.push(match[1] ?? "");
    index += 1;
  }

  if (skillIds.length === 0) {
    return { skillIds: [], body: normalized.trim() };
  }

  if (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    return { skillIds: [], body: normalized.trim() };
  }

  while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
    index += 1;
  }

  return {
    skillIds: [...new Set(skillIds)],
    body: lines.slice(index).join("\n").trim(),
  };
}

export function quotedSkillBlock(skill: ResolvedWorkspaceSkill): string | null {
  const skillFilePath = skill.file_path;
  let raw: string;
  try {
    raw = fs.readFileSync(skillFilePath, "utf8");
  } catch {
    return null;
  }
  const body = stripMarkdownFrontmatter(raw).trim();
  return `<skill name="${skill.skill_id}" location="${skillFilePath}">\nReferences are relative to ${skill.source_dir}.\n\n${body}\n</skill>`;
}

function hasValidSkillFormat(params: { skillId: string; skillFilePath: string }): boolean {
  let content: string;
  try {
    content = fs.readFileSync(params.skillFilePath, "utf8");
  } catch {
    return false;
  }
  const frontmatter = skillFrontmatter(content);
  if (!frontmatter) {
    return false;
  }
  const frontmatterName = normalizeSkillId(normalizedFrontmatterString(frontmatter.name));
  if (!frontmatterName || frontmatterName !== params.skillId) {
    return false;
  }
  const description = normalizedFrontmatterString(frontmatter.description);
  if (!description) {
    return false;
  }
  return true;
}

function readSkillMetadata(params: {
  skillId: string;
  skillFilePath: string;
  sourceDir: string;
  origin: ResolvedSkillOrigin;
}): ResolvedWorkspaceSkill | null {
  let content: string;
  try {
    content = fs.readFileSync(params.skillFilePath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = skillFrontmatter(content);
  if (!frontmatter) {
    return null;
  }
  const skillName = normalizeSkillId(normalizedFrontmatterString(frontmatter.name));
  const description = normalizedFrontmatterString(frontmatter.description);
  if (!skillName || skillName !== params.skillId || !description) {
    return null;
  }
  return {
    skill_id: params.skillId,
    skill_name: skillName,
    description,
    source_dir: params.sourceDir,
    file_path: params.skillFilePath,
    origin: params.origin,
    granted_tools: grantedToolsFromFrontmatter(frontmatter),
    granted_commands: grantedCommandsFromFrontmatter(frontmatter),
  };
}

function listSkillsInRoot(skillRoot: string, origin: ResolvedSkillOrigin): ResolvedWorkspaceSkill[] {
  const skillRootPath = path.resolve(skillRoot);
  const stats = fs.statSync(skillRootPath, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) {
    return [];
  }

  return fs
    .readdirSync(skillRootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillId = normalizeSkillId(entry.name);
      if (!skillId) {
        return null;
      }
      const sourceDir = path.join(skillRootPath, entry.name);
      let sourceRealPath: string;
      try {
        sourceRealPath = fs.realpathSync(sourceDir);
      } catch {
        return null;
      }
      const skillFilePath = path.join(sourceRealPath, "SKILL.md");
      if (!fs.existsSync(skillFilePath)) {
        return null;
      }
      if (!hasValidSkillFormat({ skillId, skillFilePath })) {
        return null;
      }
      return readSkillMetadata({
        skillId,
        skillFilePath,
        sourceDir: sourceRealPath,
        origin,
      });
    })
    .filter((skill): skill is ResolvedWorkspaceSkill => Boolean(skill))
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

function resolveWorkspaceLocalSkills(workspaceDirInput: string): ResolvedWorkspaceSkill[] {
  const workspaceDir = path.resolve(workspaceDirInput);
  let workspaceRealRoot: string;
  try {
    workspaceRealRoot = fs.realpathSync(workspaceDir);
  } catch {
    return [];
  }

  const skillsPath = path.resolve(workspaceDir, WORKSPACE_SKILLS_RELATIVE_PATH);
  let skillsRealPath: string;
  try {
    skillsRealPath = fs.realpathSync(skillsPath);
  } catch {
    return [];
  }
  const relativeSkillsPath = path.relative(workspaceRealRoot, skillsRealPath);
  if (relativeSkillsPath.startsWith("..") || path.isAbsolute(relativeSkillsPath)) {
    return [];
  }

  return listSkillsInRoot(skillsRealPath, "workspace").filter((skill) => {
    const relativeSourcePath = path.relative(workspaceRealRoot, skill.source_dir);
    return !(relativeSourcePath.startsWith("..") || path.isAbsolute(relativeSourcePath));
  });
}

export function resolveWorkspaceSkills(workspaceDirInput: string): ResolvedWorkspaceSkill[] {
  const embeddedSkills = listSkillsInRoot(embeddedSkillsRoot(), "embedded");
  const workspaceSkills = resolveWorkspaceLocalSkills(workspaceDirInput);

  const resolvedById = new Map<string, ResolvedWorkspaceSkill>();
  for (const skill of workspaceSkills) {
    resolvedById.set(skill.skill_id, skill);
  }
  for (const skill of embeddedSkills) {
    resolvedById.set(skill.skill_id, skill);
  }

  const orderedSkillIds = (() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const skill of [...embeddedSkills, ...workspaceSkills]) {
      if (seen.has(skill.skill_id)) {
        continue;
      }
      seen.add(skill.skill_id);
      ordered.push(skill.skill_id);
    }
    return ordered;
  })();

  return orderedSkillIds
    .map((skillId) => {
      const normalizedSkillId = normalizeSkillId(skillId);
      return normalizedSkillId ? resolvedById.get(normalizedSkillId) ?? null : null;
    })
    .filter((skill): skill is ResolvedWorkspaceSkill => Boolean(skill));
}

export function resolveWorkspaceSkillByLookupToken(params: {
  workspaceSkills: ResolvedWorkspaceSkill[];
  requestedName: string;
}): ResolvedWorkspaceSkill | null {
  const requested = normalizeSkillLookupToken(params.requestedName);
  if (!requested) {
    return null;
  }
  for (const skill of params.workspaceSkills) {
    if (
      normalizeSkillLookupToken(skill.skill_id) === requested ||
      normalizeSkillLookupToken(skill.skill_name) === requested
    ) {
      return skill;
    }
  }
  return null;
}

export function invokeWorkspaceSkill(params: {
  requestedName: string;
  args?: string | null;
  workspaceSkills: ResolvedWorkspaceSkill[];
}): WorkspaceSkillInvocationResult {
  const requestedName = normalizedFrontmatterString(params.requestedName);
  if (!requestedName) {
    throw new Error("Skill invocation requires a non-empty `name` argument");
  }
  const resolvedSkill = resolveWorkspaceSkillByLookupToken({
    workspaceSkills: params.workspaceSkills,
    requestedName,
  });
  if (!resolvedSkill) {
    const availableSkills = [...new Set(params.workspaceSkills.map((skill) => skill.skill_id))]
      .filter((value) => value.trim().length > 0)
      .sort((left, right) => left.localeCompare(right));
    throw new Error(
      availableSkills.length > 0
        ? `Skill "${requestedName}" was not found. Available skills: ${availableSkills.join(", ")}`
        : `Skill "${requestedName}" was not found. No skills are currently available.`
    );
  }
  const skillBlock = quotedSkillBlock(resolvedSkill);
  if (!skillBlock) {
    throw new Error(
      `Failed to load skill "${resolvedSkill.skill_id}" from ${resolvedSkill.file_path}: file read failed`
    );
  }
  const args = normalizedFrontmatterString(params.args) ?? null;
  return {
    text: args ? `${skillBlock}\n\n${args}` : skillBlock,
    skill_block: skillBlock,
    requested_name: requestedName,
    skill_id: resolvedSkill.skill_id,
    skill_name: resolvedSkill.skill_name,
    skill_file_path: resolvedSkill.file_path,
    skill_base_dir: resolvedSkill.source_dir,
    granted_tools: [...resolvedSkill.granted_tools],
    granted_commands: [...resolvedSkill.granted_commands],
    args,
  };
}

export function prepareInstructionWithQuotedWorkspaceSkills(params: {
  instruction: string;
  workspaceSkills: ResolvedWorkspaceSkill[];
}): PreparedQuotedWorkspaceSkills {
  const parsed = parseQuotedSkillInstruction(params.instruction);
  if (parsed.skillIds.length === 0) {
    return {
      body: parsed.body,
      quoted_skill_blocks: [],
      missing_quoted_skill_ids: [],
    };
  }

  const skillsById = new Map(
    params.workspaceSkills.map((skill) => [skill.skill_id, skill] as const),
  );
  const quotedSkillBlocks: string[] = [];
  const missingQuotedSkillIds: string[] = [];

  for (const skillId of parsed.skillIds) {
    const skill = skillsById.get(skillId);
    if (!skill) {
      missingQuotedSkillIds.push(skillId);
      continue;
    }
    const block = quotedSkillBlock(skill);
    if (!block) {
      missingQuotedSkillIds.push(skillId);
      continue;
    }
    quotedSkillBlocks.push(block);
  }

  return {
    body: parsed.body,
    quoted_skill_blocks: quotedSkillBlocks,
    missing_quoted_skill_ids: missingQuotedSkillIds,
  };
}
