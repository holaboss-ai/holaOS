export type ParsedRelatedEntity = {
  entityKey: string;
  label: string;
};

export type ParsedRelatedRelation = {
  relationType: string;
  entityKey: string;
  label: string | null;
};

export type RelatedTargetResolution = {
  entityKeyToTarget: Map<string, ResolvedRelatedGraphTarget>;
  relationKeyToTarget: Map<string, ResolvedRelatedGraphTarget>;
  labelToTarget: Map<string, ResolvedRelatedGraphTarget>;
  blockedEntityKeys: Set<string>;
  blockedRelationKeys: Set<string>;
};

export type ResolvedRelatedGraphTarget = {
  nodeId: string | null;
  targetResolutionKind: MemoryBrowserNodeRelationPayload["target_resolution_kind"] | null;
};

export type ResolvedParsedRelatedEntity = ParsedRelatedEntity &
  ResolvedRelatedGraphTarget & {
    navigable: boolean;
    stableKey: string;
  };

export type ResolvedParsedRelatedRelation = ParsedRelatedRelation &
  ResolvedRelatedGraphTarget & {
    displayLabel: string;
    navigable: boolean;
    stableKey: string;
  };

export function isNavigableMemoryRelationTarget(
  kind: MemoryBrowserNodeRelationPayload["target_resolution_kind"] | null,
): boolean {
  return kind === "resolved" || kind === "synthetic";
}

export function parseMemoryRelatedSections(content: string): {
  entities: ParsedRelatedEntity[];
  relations: ParsedRelatedRelation[];
} {
  const entities: ParsedRelatedEntity[] = [];
  const relations: ParsedRelatedRelation[] = [];
  const entitySectionMatch = content.match(
    /(?:^|\n)## Related Entities\n([\s\S]*?)(?=\n## |$)/,
  );
  if (entitySectionMatch?.[1]) {
    for (const line of entitySectionMatch[1]
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = line.match(/^- `([^`]+)` \| (.+)$/);
      if (!match) {
        continue;
      }
      entities.push({
        entityKey: match[1] ?? "",
        label: match[2] ?? "",
      });
    }
  }
  const relationSectionMatch = content.match(
    /(?:^|\n)## Relations\n([\s\S]*?)(?=\n## |$)/,
  );
  if (relationSectionMatch?.[1]) {
    for (const line of relationSectionMatch[1]
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = line.match(/^- `([^`]+)` -> `([^`]+)`(?: \| (.+))?$/);
      if (!match) {
        continue;
      }
      relations.push({
        relationType: match[1] ?? "",
        entityKey: match[2] ?? "",
        label: match[3] ?? null,
      });
    }
  }
  return { entities, relations };
}

export function normalizeRelatedLookupLabel(
  value: string | null | undefined,
): string {
  return (value ?? "").trim().toLowerCase();
}

export function buildRelatedTargetResolution(params: {
  graphNodes: MemoryBrowserGraphNodePayload[] | null | undefined;
  outgoingRelations:
    | MemoryBrowserNodeRelationPayload[]
    | null
    | undefined;
}): RelatedTargetResolution {
  const entityKeyToTarget = new Map<string, ResolvedRelatedGraphTarget>();
  const relationKeyToTarget = new Map<string, ResolvedRelatedGraphTarget>();
  const labelToTarget = new Map<string, ResolvedRelatedGraphTarget>();
  const blockedEntityKeys = new Set<string>();
  const blockedRelationKeys = new Set<string>();
  for (const relation of params.outgoingRelations ?? []) {
    const relationKey = relation.target_entity_key
      ? `${relation.relation_type}:${relation.target_entity_key}`
      : null;
    if (!isNavigableMemoryRelationTarget(relation.target_resolution_kind)) {
      if (relation.target_entity_key) {
        blockedEntityKeys.add(relation.target_entity_key);
      }
      if (relationKey) {
        blockedRelationKeys.add(relationKey);
      }
      continue;
    }
    if (
      relation.target_entity_key &&
      !entityKeyToTarget.has(relation.target_entity_key)
    ) {
      entityKeyToTarget.set(
        relation.target_entity_key,
        {
          nodeId: relation.target_node_id,
          targetResolutionKind: relation.target_resolution_kind,
        },
      );
    }
    if (relation.target_entity_key) {
      const resolvedRelationKey = `${relation.relation_type}:${relation.target_entity_key}`;
      if (!relationKeyToTarget.has(resolvedRelationKey)) {
        relationKeyToTarget.set(resolvedRelationKey, {
          nodeId: relation.target_node_id,
          targetResolutionKind: relation.target_resolution_kind,
        });
      }
    }
    const targetLabel = normalizeRelatedLookupLabel(
      relation.target_label ??
        relation.target_entity_key ??
        relation.target_node_id,
    );
    if (targetLabel && !labelToTarget.has(targetLabel)) {
      labelToTarget.set(targetLabel, {
        nodeId: relation.target_node_id,
        targetResolutionKind: relation.target_resolution_kind,
      });
    }
  }
  for (const node of params.graphNodes ?? []) {
    const label = normalizeRelatedLookupLabel(node.label);
    if (label && !labelToTarget.has(label)) {
      labelToTarget.set(label, {
        nodeId: node.id,
        targetResolutionKind: "synthetic",
      });
    }
  }
  return {
    entityKeyToTarget,
    relationKeyToTarget,
    labelToTarget,
    blockedEntityKeys,
    blockedRelationKeys,
  };
}

export function resolveRelatedGraphTarget(
  resolution: RelatedTargetResolution,
  entityKey: string,
  label: string | null,
  relationType?: string | null,
): ResolvedRelatedGraphTarget {
  if (relationType) {
    const relationKey = `${relationType}:${entityKey}`;
    if (resolution.blockedRelationKeys.has(relationKey)) {
      return {
        nodeId: null,
        targetResolutionKind: "missing",
      };
    }
    const relationTarget = resolution.relationKeyToTarget.get(
      relationKey,
    );
    if (relationTarget) {
      return relationTarget;
    }
  }
  if (resolution.blockedEntityKeys.has(entityKey)) {
    return {
      nodeId: null,
      targetResolutionKind: "missing",
    };
  }
  const entityTarget = resolution.entityKeyToTarget.get(entityKey);
  if (entityTarget) {
    return entityTarget;
  }
  const labelTarget = resolution.labelToTarget.get(
    normalizeRelatedLookupLabel(label ?? entityKey),
  );
  return labelTarget ?? {
    nodeId: null,
    targetResolutionKind: null,
  };
}

export function resolveRelatedGraphNodeId(
  resolution: RelatedTargetResolution,
  entityKey: string,
  label: string | null,
  relationType?: string | null,
): string | null {
  return resolveRelatedGraphTarget(
    resolution,
    entityKey,
    label,
    relationType,
  ).nodeId;
}

export function resolveParsedRelatedEntities(
  resolution: RelatedTargetResolution,
  entities: ParsedRelatedEntity[],
): ResolvedParsedRelatedEntity[] {
  return entities.map((entity) => {
    const target = resolveRelatedGraphTarget(
      resolution,
      entity.entityKey,
      entity.label,
    );
    return {
      ...entity,
      nodeId: target.nodeId,
      targetResolutionKind: target.targetResolutionKind,
      navigable: Boolean(
        target.nodeId
          && target.targetResolutionKind
          && isNavigableMemoryRelationTarget(target.targetResolutionKind),
      ),
      stableKey: entity.entityKey,
    };
  });
}

export function resolveParsedRelatedRelations(
  resolution: RelatedTargetResolution,
  relations: ParsedRelatedRelation[],
): ResolvedParsedRelatedRelation[] {
  return relations.map((relation) => {
    const target = resolveRelatedGraphTarget(
      resolution,
      relation.entityKey,
      relation.label,
      relation.relationType,
    );
    return {
      ...relation,
      nodeId: target.nodeId,
      targetResolutionKind: target.targetResolutionKind,
      displayLabel: relation.label ?? relation.entityKey,
      navigable: Boolean(
        target.nodeId
          && target.targetResolutionKind
          && isNavigableMemoryRelationTarget(target.targetResolutionKind),
      ),
      stableKey: `${relation.relationType}:${relation.entityKey}`,
    };
  });
}

export function findGraphNodeForPath(
  graphNodes: MemoryBrowserGraphNodePayload[] | null | undefined,
  targetPath: string,
): MemoryBrowserGraphNodePayload | null {
  return (
    graphNodes?.find((candidate) => candidate.path === targetPath) ?? null
  );
}
