import type { InteractionEntityRecord, InteractionEntityType } from "@holaboss/runtime-state-store";

import type { DurableMemoryRelatedEntityType } from "./memory-related-entities.js";
import {
  basenameAliasFromPath,
  canonicalAttachmentArtifactEntityKey,
  canonicalImageUrlArtifactEntityKey,
  canonicalInteractionEntityKey,
  canonicalOutputArtifactEntityKey,
  canonicalToolResultArtifactEntityKey,
  isGenericRelatedEntityLabel,
  legacyRelatedEntityKey,
  parseCanonicalWorkspaceEntityKey,
  relatedAliasLookupKeys,
  type WorkspaceResolvedTargetKind,
} from "./workspace-related-entity-keys.js";

export interface WorkspaceAttachmentResolverDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  attachmentId: string;
  workspacePath: string;
  sourceTurnInputId: string | null;
  sourceTurnInputPosition?: number | null;
  observedAt: string;
}

export interface WorkspaceToolResultResolverDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  providerId: string;
  accountNamespace: string;
  toolName: string;
  toolId: string | null;
  callId: string | null;
  outputEventId: number | null;
  sourceTurnInputId: string | null;
  observedAt: string;
}

export interface WorkspaceOutputResolverDescriptor {
  treeId: string | null;
  rootNodeId: string | null;
  title: string;
  outputId: string;
  outputType: string;
  filePath: string | null;
  artifactId: string | null;
  sourceTurnInputId: string | null;
  observedAt: string;
}

export interface WorkspaceImageUrlResolverDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  imageUrl: string;
  sourceTurnInputId: string | null;
  sourceTurnInputPosition?: number | null;
  observedAt: string;
}

export interface ResolvedWorkspaceRelatedEntity {
  entityType: DurableMemoryRelatedEntityType;
  entityKey: string;
  label: string;
  resolutionKind: WorkspaceResolvedTargetKind;
  targetTreeId: string | null;
  targetNodeId: string | null;
  sourceTurnInputId: string | null;
  sourceTurnInputPosition: number | null;
  aliasTexts: string[];
  observedAt: string;
}

export interface WorkspaceRelatedEntityResolver {
  resolve(params: {
    entityType: DurableMemoryRelatedEntityType;
    label: string;
    entityKey?: string | null;
    sourceTurnInputId?: string | null;
  }): ResolvedWorkspaceRelatedEntity | null;
  artifactTargetsForTurnInput(inputId: string): ResolvedWorkspaceRelatedEntity[];
  ownerTargetForEntityId(entityId: string): ResolvedWorkspaceRelatedEntity | null;
}

type AliasTarget = ResolvedWorkspaceRelatedEntity;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function searchEntityTypes(entityType: DurableMemoryRelatedEntityType): DurableMemoryRelatedEntityType[] {
  switch (entityType) {
    case "customer":
      return ["customer", "organization"];
    case "organization":
      return ["organization", "customer"];
    case "issue":
      return ["issue", "topic"];
    case "topic":
      return ["topic", "issue"];
    default:
      return [entityType];
  }
}

function canonicalRelatedEntityTypeForInteractionEntity(
  entityType: InteractionEntityType,
): DurableMemoryRelatedEntityType | null {
  switch (entityType) {
    case "person":
    case "identity":
      return "person";
    case "customer":
      return "organization";
    case "project":
      return "project";
    case "workflow":
      return "workflow";
    case "system":
      return "system";
    case "topic":
    case "misc":
      return "topic";
    default:
      return null;
  }
}

function secondarySearchEntityTypesForInteractionEntity(
  entityType: InteractionEntityType,
): DurableMemoryRelatedEntityType[] {
  switch (entityType) {
    case "customer":
      return ["customer"];
    case "topic":
    case "misc":
      return ["issue"];
    default:
      return [];
  }
}

function addAliasTexts(set: Set<string>, values: Array<string | null | undefined>): void {
  for (const value of values) {
    const normalized = typeof value === "string" ? compactWhitespace(value) : "";
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
}

function observedAtSortValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildInteractionTargets(
  entities: InteractionEntityRecord[],
): ResolvedWorkspaceRelatedEntity[] {
  const targets: ResolvedWorkspaceRelatedEntity[] = [];
  for (const entity of entities) {
    const canonicalType = canonicalRelatedEntityTypeForInteractionEntity(entity.entityType);
    if (!canonicalType) {
      continue;
    }
    const aliasTexts = new Set<string>();
    addAliasTexts(aliasTexts, [entity.canonicalName, ...entity.aliases]);
    const target: ResolvedWorkspaceRelatedEntity = {
      entityType: canonicalType,
      entityKey: canonicalInteractionEntityKey(canonicalType, entity.entityId),
      label: entity.canonicalName,
      resolutionKind: "interaction_entity",
      targetTreeId: entity.entityId,
      targetNodeId: `semantic:interaction:${entity.entityId}:tree`,
      sourceTurnInputId: null,
      sourceTurnInputPosition: null,
      aliasTexts: [...aliasTexts],
      observedAt: entity.updatedAt,
    };
    targets.push(target);
    for (const secondaryType of secondarySearchEntityTypesForInteractionEntity(entity.entityType)) {
      targets.push({
        ...target,
        entityType: secondaryType,
      });
    }
  }
  return targets;
}

function buildAttachmentTargets(
  descriptors: WorkspaceAttachmentResolverDescriptor[],
): ResolvedWorkspaceRelatedEntity[] {
  return descriptors.map((descriptor) => {
    const aliasTexts = new Set<string>();
    addAliasTexts(aliasTexts, [
      descriptor.title,
      descriptor.workspacePath,
      basenameAliasFromPath(descriptor.workspacePath),
      legacyRelatedEntityKey("artifact", descriptor.title),
    ]);
    return {
      entityType: "artifact" as const,
      entityKey: canonicalAttachmentArtifactEntityKey(descriptor.attachmentId),
      label: descriptor.title,
      resolutionKind: "attachment" as const,
      targetTreeId: descriptor.treeId,
      targetNodeId: descriptor.rootNodeId,
      sourceTurnInputId: descriptor.sourceTurnInputId,
      sourceTurnInputPosition: descriptor.sourceTurnInputPosition ?? null,
      aliasTexts: [...aliasTexts],
      observedAt: descriptor.observedAt,
    };
  });
}

function buildImageUrlTargets(
  descriptors: WorkspaceImageUrlResolverDescriptor[],
): ResolvedWorkspaceRelatedEntity[] {
  return descriptors.map((descriptor) => {
    const aliasTexts = new Set<string>();
    addAliasTexts(aliasTexts, [
      descriptor.title,
      descriptor.imageUrl,
      basenameAliasFromPath(descriptor.imageUrl),
      legacyRelatedEntityKey("artifact", descriptor.title),
    ]);
    return {
      entityType: "artifact" as const,
      entityKey: canonicalImageUrlArtifactEntityKey(descriptor.imageUrl),
      label: descriptor.title,
      resolutionKind: "image_url" as const,
      targetTreeId: descriptor.treeId,
      targetNodeId: descriptor.rootNodeId,
      sourceTurnInputId: descriptor.sourceTurnInputId,
      sourceTurnInputPosition: descriptor.sourceTurnInputPosition ?? null,
      aliasTexts: [...aliasTexts],
      observedAt: descriptor.observedAt,
    };
  });
}

function buildOutputTargets(
  descriptors: WorkspaceOutputResolverDescriptor[],
): ResolvedWorkspaceRelatedEntity[] {
  return descriptors.map((descriptor) => {
    const aliasTexts = new Set<string>();
    addAliasTexts(aliasTexts, [
      descriptor.title,
      descriptor.filePath,
      basenameAliasFromPath(descriptor.filePath),
      descriptor.artifactId,
      descriptor.outputId,
      legacyRelatedEntityKey("artifact", descriptor.title),
      descriptor.filePath ? legacyRelatedEntityKey("artifact", basenameAliasFromPath(descriptor.filePath) ?? descriptor.title) : null,
    ]);
    return {
      entityType: "artifact" as const,
      entityKey: canonicalOutputArtifactEntityKey(descriptor.outputId),
      label: descriptor.title,
      resolutionKind: "output_artifact" as const,
      targetTreeId: descriptor.treeId,
      targetNodeId: descriptor.rootNodeId,
      sourceTurnInputId: descriptor.sourceTurnInputId,
      sourceTurnInputPosition: null,
      aliasTexts: [...aliasTexts],
      observedAt: descriptor.observedAt,
    };
  });
}

function buildToolResultTargets(
  descriptors: WorkspaceToolResultResolverDescriptor[],
): ResolvedWorkspaceRelatedEntity[] {
  return descriptors.map((descriptor) => {
    const aliasTexts = new Set<string>();
    addAliasTexts(aliasTexts, [
      descriptor.title,
      descriptor.toolName,
      `${descriptor.toolName} result`,
      descriptor.toolId,
      descriptor.callId,
      descriptor.accountNamespace,
      descriptor.outputEventId !== null ? `event-${descriptor.outputEventId}` : null,
      legacyRelatedEntityKey("artifact", descriptor.title),
    ]);
    return {
      entityType: "artifact" as const,
      entityKey: canonicalToolResultArtifactEntityKey({
        providerId: descriptor.providerId,
        callId: descriptor.callId,
        outputEventId: descriptor.outputEventId,
        treeId: descriptor.treeId,
      }),
      label: descriptor.title,
      resolutionKind: "tool_result" as const,
      targetTreeId: descriptor.treeId,
      targetNodeId: descriptor.rootNodeId,
      sourceTurnInputId: descriptor.sourceTurnInputId,
      sourceTurnInputPosition: null,
      aliasTexts: [...aliasTexts],
      observedAt: descriptor.observedAt,
    };
  });
}

export function buildWorkspaceRelatedEntityResolver(params: {
  interactionEntities: InteractionEntityRecord[];
  attachmentTargets?: WorkspaceAttachmentResolverDescriptor[];
  imageUrlTargets?: WorkspaceImageUrlResolverDescriptor[];
  toolResultTargets?: WorkspaceToolResultResolverDescriptor[];
  outputTargets?: WorkspaceOutputResolverDescriptor[];
}): WorkspaceRelatedEntityResolver {
  const targets = [
    ...buildInteractionTargets(params.interactionEntities),
    ...buildAttachmentTargets(params.attachmentTargets ?? []),
    ...buildImageUrlTargets(params.imageUrlTargets ?? []),
    ...buildToolResultTargets(params.toolResultTargets ?? []),
    ...buildOutputTargets(params.outputTargets ?? []),
  ];

  const targetsByCanonicalKey = new Map<string, AliasTarget>();
  const targetsByEntityId = new Map<string, AliasTarget>();
  const aliasIndex = new Map<string, AliasTarget[]>();

  const registerAlias = (entityType: DurableMemoryRelatedEntityType, aliasText: string, target: AliasTarget): void => {
    for (const lookupKey of relatedAliasLookupKeys(aliasText)) {
      const key = `${entityType}|${lookupKey}`;
      const bucket = aliasIndex.get(key);
      if (bucket) {
        bucket.push(target);
      } else {
        aliasIndex.set(key, [target]);
      }
    }
  };

  for (const target of targets) {
    targetsByCanonicalKey.set(target.entityKey, target);
    const parsed = parseCanonicalWorkspaceEntityKey(target.entityKey);
    if (parsed?.kind === "interaction_entity") {
      targetsByEntityId.set(parsed.targetId, target);
    }
    for (const aliasText of [...target.aliasTexts, target.entityKey, target.label]) {
      for (const entityType of searchEntityTypes(target.entityType)) {
        registerAlias(entityType, aliasText, target);
      }
    }
  }

  const dedupeTargets = (items: AliasTarget[]): AliasTarget[] => {
    const seen = new Set<string>();
    const deduped: AliasTarget[] = [];
    for (const item of items) {
      if (seen.has(item.entityKey)) {
        continue;
      }
      seen.add(item.entityKey);
      deduped.push(item);
    }
    return deduped;
  };

  const sortTargets = (items: AliasTarget[], sourceTurnInputId: string | null): AliasTarget[] =>
    [...items].sort((left, right) => {
      const leftSameTurn = sourceTurnInputId && left.sourceTurnInputId === sourceTurnInputId ? 1 : 0;
      const rightSameTurn = sourceTurnInputId && right.sourceTurnInputId === sourceTurnInputId ? 1 : 0;
      if (leftSameTurn !== rightSameTurn) {
        return rightSameTurn - leftSameTurn;
      }
      if (leftSameTurn && rightSameTurn) {
        const leftPosition = left.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY;
        const rightPosition = right.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY;
        if (leftPosition !== rightPosition) {
          return leftPosition - rightPosition;
        }
      }
      return observedAtSortValue(right.observedAt) - observedAtSortValue(left.observedAt)
        || left.entityKey.localeCompare(right.entityKey);
    });

  return {
    resolve(params): ResolvedWorkspaceRelatedEntity | null {
      const directKey = params.entityKey?.trim() ?? "";
      if (directKey) {
        const directTarget = targetsByCanonicalKey.get(directKey);
        if (directTarget) {
          return directTarget;
        }
        const parsed = parseCanonicalWorkspaceEntityKey(directKey);
        if (parsed?.kind === "interaction_entity") {
          const entityTarget = targetsByEntityId.get(parsed.targetId);
          if (entityTarget) {
            return entityTarget;
          }
        }
      }

      const label = compactWhitespace(params.label);
      if (!label) {
        return null;
      }
      const aliasCandidates: AliasTarget[] = [];
      const seenKeys = new Set<string>();
      for (const token of [label, directKey]) {
        for (const lookupKey of relatedAliasLookupKeys(token)) {
          for (const entityType of searchEntityTypes(params.entityType)) {
            const key = `${entityType}|${lookupKey}`;
            if (seenKeys.has(key)) {
              continue;
            }
            seenKeys.add(key);
            const bucket = aliasIndex.get(key);
            if (bucket) {
              aliasCandidates.push(...bucket);
            }
          }
        }
      }
      const deduped = dedupeTargets(aliasCandidates);
      if (deduped.length > 0) {
        return sortTargets(deduped, params.sourceTurnInputId?.trim() || null)[0] ?? null;
      }
      if (isGenericRelatedEntityLabel(label)) {
        return null;
      }
      return null;
    },

    artifactTargetsForTurnInput(inputId: string): ResolvedWorkspaceRelatedEntity[] {
      const normalized = inputId.trim();
      if (!normalized) {
        return [];
      }
      return targets
        .filter((target) => target.entityType === "artifact" && target.sourceTurnInputId === normalized)
        .sort((left, right) => left.entityKey.localeCompare(right.entityKey));
    },

    ownerTargetForEntityId(entityId: string): ResolvedWorkspaceRelatedEntity | null {
      return targetsByEntityId.get(entityId.trim()) ?? null;
    },
  };
}
