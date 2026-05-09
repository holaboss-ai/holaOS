import fs from "node:fs";
import path from "node:path";

import {
  activeHarnessGrantedCommands,
  activeHarnessGrantedTools,
  applyHarnessSkillWideningGrants,
  normalizeHarnessSkillLookupToken,
  requiredHarnessSkillIdsForTool,
  resolveHarnessSkillMetadata,
  uniqueHarnessSkillIds,
  type HarnessSkillMetadata,
  type HarnessSkillWideningState,
} from "./skill-policy.js";

export interface HarnessWorkspaceSkillSource {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface HarnessQuotedSkillSections {
  blocks: string[];
  missing: string[];
  body: string;
}

export interface HarnessSkillToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
}

export interface HarnessWorkspaceSkillLoadResult<TSkill extends { filePath: string }, TDiagnostic = unknown> {
  skills: TSkill[];
  diagnostics: TDiagnostic[];
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function directoryExists(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function skillIdFromFilePath(filePath: string): string {
  const parsed = path.parse(filePath);
  if (parsed.base.toLowerCase() === "skill.md") {
    return path.basename(path.dirname(filePath));
  }
  return parsed.name;
}

function markdownFrontmatterBlock(value: string): string | null {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function normalizeGrantedToolName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parseInlineStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  const bracketMatch = trimmed.match(/^\[([\s\S]*?)\]$/);
  const body = bracketMatch ? bracketMatch[1] ?? "" : trimmed;
  return body
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .map((item) => normalizeGrantedToolName(item))
    .filter((item): item is string => Boolean(item));
}

function parseFrontmatterStringList(frontmatter: string, keyName: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const match = current.match(keyPattern);
    if (!match) {
      continue;
    }
    const inlineValue = (match[1] ?? "").trim();
    if (inlineValue.length > 0) {
      return parseInlineStringList(inlineValue);
    }
    const collected: string[] = [];
    for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
      const candidate = lines[lookahead] ?? "";
      if (!candidate.trim()) {
        if (collected.length > 0) {
          break;
        }
        continue;
      }
      const itemMatch = candidate.match(/^\s*-\s*(.+?)\s*$/);
      if (!itemMatch) {
        break;
      }
      const normalized = normalizeGrantedToolName(itemMatch[1]?.replace(/^['"]|['"]$/g, ""));
      if (normalized) {
        collected.push(normalized);
      }
    }
    return collected;
  }
  return [];
}

function parseHolabossNestedStringList(frontmatter: string, nestedKeyNames: string[]): string[] {
  const lines = frontmatter.split(/\r?\n/);
  let holabossStart = -1;
  let holabossIndent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(\s*)holaboss\s*:\s*$/i);
    if (!match) {
      continue;
    }
    holabossStart = index + 1;
    holabossIndent = match[1]?.length ?? 0;
    break;
  }
  if (holabossStart < 0) {
    return [];
  }

  const nestedLines: string[] = [];
  for (let index = holabossStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      nestedLines.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
    if (indent <= holabossIndent) {
      break;
    }
    nestedLines.push(line.slice(holabossIndent + 2));
  }

  const nestedFrontmatter = nestedLines.join("\n");
  for (const nestedKey of nestedKeyNames) {
    const parsed = parseFrontmatterStringList(nestedFrontmatter, nestedKey);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

function normalizeWorkspaceCommandId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function resolveHarnessWorkspaceSkillDirs(skillDirs: readonly string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const rawDir of skillDirs) {
    const resolvedDir = path.resolve(rawDir);
    if (!directoryExists(resolvedDir)) {
      continue;
    }
    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(resolvedDir);
    } catch {
      canonicalDir = resolvedDir;
    }
    if (seen.has(canonicalDir)) {
      continue;
    }
    seen.add(canonicalDir);
    ordered.push(canonicalDir);
  }
  return ordered;
}

export function loadHarnessWorkspaceSkills<TSkill extends { filePath: string }, TDiagnostic = unknown>(params: {
  skillDirs: readonly string[];
  loadSkillsFromDir: (dir: string) => HarnessWorkspaceSkillLoadResult<TSkill, TDiagnostic>;
}): HarnessWorkspaceSkillLoadResult<TSkill, TDiagnostic> {
  const skills: TSkill[] = [];
  const diagnostics: TDiagnostic[] = [];
  const seenFilePaths = new Set<string>();

  for (const skillDir of params.skillDirs) {
    const result = params.loadSkillsFromDir(skillDir);
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      if (seenFilePaths.has(skill.filePath)) {
        continue;
      }
      seenFilePaths.add(skill.filePath);
      skills.push(skill);
    }
  }

  return { skills, diagnostics };
}

function addSkillAlias(aliasMap: Map<string, HarnessSkillMetadata>, alias: unknown, metadata: HarnessSkillMetadata): void {
  const normalized = normalizeHarnessSkillLookupToken(alias);
  if (!normalized || aliasMap.has(normalized)) {
    return;
  }
  aliasMap.set(normalized, metadata);
}

function skillToolParametersSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill id or skill name to invoke.",
      },
      args: {
        type: "string",
        description: "Optional follow-up instructions appended after the invoked skill content.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
}

export function stripHarnessMarkdownFrontmatter(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return normalized;
  }
  return normalized.slice(match[0].length);
}

export function parseHarnessQuotedSkillInstruction(value: string): { skillIds: string[]; body: string } {
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

export function parseHarnessGrantedToolsFromSkillFrontmatter(frontmatter: string | null): string[] {
  if (!frontmatter) {
    return [];
  }
  const directKeys = [
    "holaboss_granted_tools",
    "holaboss-granted-tools",
    "holaboss_tools",
    "holaboss-tools",
    "capability_grants",
    "capability-grants",
  ];
  for (const key of directKeys) {
    const parsed = parseFrontmatterStringList(frontmatter, key);
    if (parsed.length > 0) {
      return [...new Set(parsed)];
    }
  }
  const nested = parseHolabossNestedStringList(frontmatter, ["granted_tools", "granted-tools", "tools"]);
  if (nested.length > 0) {
    return [...new Set(nested)];
  }
  return [];
}

export function parseHarnessGrantedCommandsFromSkillFrontmatter(frontmatter: string | null): string[] {
  if (!frontmatter) {
    return [];
  }
  const directKeys = [
    "holaboss_granted_commands",
    "holaboss-granted-commands",
    "holaboss_commands",
    "holaboss-commands",
    "command_grants",
    "command-grants",
  ];
  for (const key of directKeys) {
    const parsed = parseFrontmatterStringList(frontmatter, key)
      .map((commandId) => normalizeWorkspaceCommandId(commandId))
      .filter((commandId): commandId is string => Boolean(commandId));
    if (parsed.length > 0) {
      return [...new Set(parsed)];
    }
  }
  const nested = parseHolabossNestedStringList(frontmatter, ["granted_commands", "granted-commands", "commands"])
    .map((commandId) => normalizeWorkspaceCommandId(commandId))
    .filter((commandId): commandId is string => Boolean(commandId));
  if (nested.length > 0) {
    return [...new Set(nested)];
  }
  return [];
}

export function buildHarnessSkillMetadataByAlias(
  skills: HarnessWorkspaceSkillSource[],
  readFile: (filePath: string) => string = readUtf8,
): Map<string, HarnessSkillMetadata> {
  const aliasMap = new Map<string, HarnessSkillMetadata>();
  for (const skill of skills) {
    const rawSkillFile = readFile(skill.filePath);
    const frontmatter = markdownFrontmatterBlock(rawSkillFile);
    const metadata: HarnessSkillMetadata = {
      skillId: skillIdFromFilePath(skill.filePath),
      skillName: skill.name,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      grantedTools: parseHarnessGrantedToolsFromSkillFrontmatter(frontmatter),
      grantedCommands: parseHarnessGrantedCommandsFromSkillFrontmatter(frontmatter),
    };
    addSkillAlias(aliasMap, metadata.skillId, metadata);
    addSkillAlias(aliasMap, skill.name, metadata);
  }
  return aliasMap;
}

export function renderHarnessSkillBlock(
  metadata: HarnessSkillMetadata,
  readFile: (filePath: string) => string = readUtf8,
): string {
  const body = stripHarnessMarkdownFrontmatter(readFile(metadata.filePath)).trim();
  return `<skill name="${metadata.skillName}" location="${metadata.filePath}">\nReferences are relative to ${metadata.baseDir}.\n\n${body}\n</skill>`;
}

export function resolveHarnessQuotedSkillSections(params: {
  instruction: string;
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>;
  readFile?: (filePath: string) => string;
}): HarnessQuotedSkillSections {
  const parsed = parseHarnessQuotedSkillInstruction(params.instruction);
  if (parsed.skillIds.length === 0) {
    return {
      blocks: [],
      missing: [],
      body: parsed.body,
    };
  }

  const blocks: string[] = [];
  const missing: string[] = [];
  for (const skillId of parsed.skillIds) {
    const metadata = resolveHarnessSkillMetadata(params.skillMetadataByAlias, skillId);
    if (!metadata) {
      missing.push(skillId);
      continue;
    }
    try {
      blocks.push(renderHarnessSkillBlock(metadata, params.readFile));
    } catch {
      missing.push(skillId);
    }
  }

  return {
    blocks,
    missing,
    body: parsed.body,
  };
}

export function resolveHarnessQuotedSkillSectionsFromWorkspace<TSkill extends HarnessWorkspaceSkillSource, TDiagnostic = unknown>(params: {
  instruction: string;
  workspaceSkillDirs: readonly string[];
  loadSkillsFromDir: (dir: string) => HarnessWorkspaceSkillLoadResult<TSkill, TDiagnostic>;
  readFile?: (filePath: string) => string;
}): HarnessQuotedSkillSections {
  const loadedSkills = loadHarnessWorkspaceSkills({
    skillDirs: resolveHarnessWorkspaceSkillDirs(params.workspaceSkillDirs),
    loadSkillsFromDir: params.loadSkillsFromDir,
  });
  return resolveHarnessQuotedSkillSections({
    instruction: params.instruction,
    skillMetadataByAlias: buildHarnessSkillMetadataByAlias(loadedSkills.skills, params.readFile),
    readFile: params.readFile,
  });
}

export function createHarnessSkillToolDefinition(params: {
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>;
  skillWideningState: HarnessSkillWideningState;
  workspaceBoundaryOverrideRequested: boolean;
  readFile?: (filePath: string) => string;
}): HarnessSkillToolDefinitionLike {
  return {
    name: "skill",
    label: "Skill",
    description: "Load a workspace skill by id or name and return its canonical skill block.",
    parameters: skillToolParametersSchema(),
    execute: async (_toolCallId, toolParams, signal) => {
      if (signal?.aborted) {
        throw new Error("Skill invocation aborted before execution");
      }
      const paramsObject =
        toolParams && typeof toolParams === "object" && !Array.isArray(toolParams)
          ? (toolParams as Record<string, unknown>)
          : {};
      const requestedName = optionalTrimmedString(paramsObject.name);
      if (!requestedName) {
        throw new Error("Skill invocation requires a non-empty `name` argument");
      }

      const resolvedSkill = resolveHarnessSkillMetadata(params.skillMetadataByAlias, requestedName);
      if (!resolvedSkill) {
        const availableSkills = uniqueHarnessSkillIds(params.skillMetadataByAlias);
        throw new Error(
          availableSkills.length > 0
            ? `Skill "${requestedName}" was not found. Available skills: ${availableSkills.join(", ")}`
            : `Skill "${requestedName}" was not found. No skills are currently available.`,
        );
      }

      let skillBlock: string;
      try {
        skillBlock = renderHarnessSkillBlock(resolvedSkill, params.readFile);
      } catch (error) {
        const message = error instanceof Error && error.message.trim() ? error.message : "file read failed";
        throw new Error(`Failed to load skill "${resolvedSkill.skillId}" from ${resolvedSkill.filePath}: ${message}`);
      }

      const args = optionalTrimmedString(paramsObject.args);
      const wideningGrant = applyHarnessSkillWideningGrants(params.skillWideningState, resolvedSkill);
      return {
        content: [{ type: "text", text: args ? `${skillBlock}\n\n${args}` : skillBlock }],
        details: {
          invocation_type: "skill",
          requested_name: requestedName,
          skill_id: resolvedSkill.skillId,
          skill_name: resolvedSkill.skillName,
          skill_file_path: resolvedSkill.filePath,
          skill_base_dir: resolvedSkill.baseDir,
          args: args ?? null,
          policy_widening: {
            scope: params.skillWideningState.scope,
            managed_tools: [...params.skillWideningState.managedToolNames].sort((left, right) =>
              left.localeCompare(right),
            ),
            granted_tools: wideningGrant.grantedTools,
            active_granted_tools: activeHarnessGrantedTools(params.skillWideningState),
            managed_commands: [...params.skillWideningState.managedCommandIds].sort((left, right) =>
              left.localeCompare(right),
            ),
            granted_commands: wideningGrant.grantedCommands,
            active_granted_commands: activeHarnessGrantedCommands(params.skillWideningState),
            workspace_boundary_override: params.workspaceBoundaryOverrideRequested,
          },
        },
      };
    },
  };
}

export function wrapToolWithHarnessSkillWidening<TTool extends { name: string; execute: (...args: any[]) => Promise<any> }>(
  tool: TTool,
  state: HarnessSkillWideningState,
): TTool {
  const normalizedName = normalizeHarnessSkillLookupToken(tool.name);
  if (!state.managedToolNames.has(normalizedName)) {
    return tool;
  }

  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (async (...args: any[]) => {
      if (!state.grantedToolNames.has(normalizedName)) {
        const requiredSkills = requiredHarnessSkillIdsForTool(state, normalizedName);
        const requiredSegment = requiredSkills.length > 0 ? ` by invoking one of: ${requiredSkills.join(", ")}` : "";
        throw new Error(
          `permission denied by skill policy: tool "${tool.name}" is gated and must be widened${requiredSegment}`,
        );
      }
      return await originalExecute(...args);
    }) as TTool["execute"],
  };
}
