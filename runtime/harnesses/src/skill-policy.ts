export interface HarnessSkillMetadata {
  skillId: string;
  skillName: string;
  filePath: string;
  baseDir: string;
  grantedTools: string[];
  grantedCommands: string[];
}

export interface HarnessSkillWideningState {
  scope: "run";
  managedToolNames: Set<string>;
  grantedToolNames: Set<string>;
  skillIdsByManagedTool: ReadonlyMap<string, ReadonlySet<string>>;
  managedCommandIds: Set<string>;
  grantedCommandIds: Set<string>;
  skillIdsByManagedCommand: ReadonlyMap<string, ReadonlySet<string>>;
}

export function normalizeHarnessSkillLookupToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function sortedUniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function uniqueHarnessSkillMetadata(
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>,
): HarnessSkillMetadata[] {
  const bySkillId = new Map<string, HarnessSkillMetadata>();
  for (const metadata of skillMetadataByAlias.values()) {
    if (!bySkillId.has(metadata.skillId)) {
      bySkillId.set(metadata.skillId, metadata);
    }
  }
  return [...bySkillId.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
}

export function resolveHarnessSkillMetadata(
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>,
  requestedName: unknown,
): HarnessSkillMetadata | null {
  const normalizedName = normalizeHarnessSkillLookupToken(requestedName);
  if (!normalizedName) {
    return null;
  }
  return skillMetadataByAlias.get(normalizedName) ?? null;
}

export function uniqueHarnessSkillIds(
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>,
): string[] {
  return [...new Set([...skillMetadataByAlias.values()].map((metadata) => metadata.skillId))]
    .filter((value) => value.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function createHarnessSkillWideningState(
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>,
  availableToolNames: string[],
  availableCommandIds: string[],
): HarnessSkillWideningState {
  const availableTools = new Set(sortedUniqueNormalized(availableToolNames));
  const availableCommands = new Set(sortedUniqueNormalized(availableCommandIds));
  const skillIdsByManagedToolMutable = new Map<string, Set<string>>();
  const skillIdsByManagedCommandMutable = new Map<string, Set<string>>();

  for (const metadata of uniqueHarnessSkillMetadata(skillMetadataByAlias)) {
    for (const toolName of metadata.grantedTools) {
      const normalizedToolName = normalizeHarnessSkillLookupToken(toolName);
      if (!normalizedToolName || normalizedToolName === "skill" || !availableTools.has(normalizedToolName)) {
        continue;
      }
      const skillIds = skillIdsByManagedToolMutable.get(normalizedToolName) ?? new Set<string>();
      skillIds.add(metadata.skillId);
      skillIdsByManagedToolMutable.set(normalizedToolName, skillIds);
    }

    for (const commandId of metadata.grantedCommands) {
      const normalizedCommandId = normalizeHarnessSkillLookupToken(commandId);
      if (!normalizedCommandId || !availableCommands.has(normalizedCommandId)) {
        continue;
      }
      const skillIds = skillIdsByManagedCommandMutable.get(normalizedCommandId) ?? new Set<string>();
      skillIds.add(metadata.skillId);
      skillIdsByManagedCommandMutable.set(normalizedCommandId, skillIds);
    }
  }

  return {
    scope: "run",
    managedToolNames: new Set(skillIdsByManagedToolMutable.keys()),
    grantedToolNames: new Set(),
    skillIdsByManagedTool: new Map(
      [...skillIdsByManagedToolMutable.entries()].map(([toolName, skillIds]) => [toolName, new Set(skillIds)]),
    ),
    managedCommandIds: new Set(skillIdsByManagedCommandMutable.keys()),
    grantedCommandIds: new Set(),
    skillIdsByManagedCommand: new Map(
      [...skillIdsByManagedCommandMutable.entries()].map(([commandId, skillIds]) => [commandId, new Set(skillIds)]),
    ),
  };
}

export function requiredHarnessSkillIdsForTool(
  state: HarnessSkillWideningState,
  toolName: string,
): string[] {
  const normalizedToolName = normalizeHarnessSkillLookupToken(toolName);
  return [...(state.skillIdsByManagedTool.get(normalizedToolName) ?? new Set<string>())].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function applyHarnessSkillWideningGrants(
  state: HarnessSkillWideningState,
  skillMetadata: HarnessSkillMetadata,
): { grantedTools: string[]; grantedCommands: string[] } {
  const newlyGrantedTools: string[] = [];
  const newlyGrantedCommands: string[] = [];

  for (const toolName of skillMetadata.grantedTools) {
    const normalizedToolName = normalizeHarnessSkillLookupToken(toolName);
    if (!state.managedToolNames.has(normalizedToolName)) {
      continue;
    }
    if (!state.grantedToolNames.has(normalizedToolName)) {
      newlyGrantedTools.push(normalizedToolName);
    }
    state.grantedToolNames.add(normalizedToolName);
  }

  for (const commandId of skillMetadata.grantedCommands) {
    const normalizedCommandId = normalizeHarnessSkillLookupToken(commandId);
    if (!state.managedCommandIds.has(normalizedCommandId)) {
      continue;
    }
    if (!state.grantedCommandIds.has(normalizedCommandId)) {
      newlyGrantedCommands.push(normalizedCommandId);
    }
    state.grantedCommandIds.add(normalizedCommandId);
  }

  return {
    grantedTools: newlyGrantedTools.sort((left, right) => left.localeCompare(right)),
    grantedCommands: newlyGrantedCommands.sort((left, right) => left.localeCompare(right)),
  };
}

export function activeHarnessGrantedTools(state: HarnessSkillWideningState): string[] {
  return [...state.grantedToolNames].sort((left, right) => left.localeCompare(right));
}

export function activeHarnessGrantedCommands(state: HarnessSkillWideningState): string[] {
  return [...state.grantedCommandIds].sort((left, right) => left.localeCompare(right));
}
