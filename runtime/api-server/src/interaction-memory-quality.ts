import type { InteractionEntityType } from "@holaboss/runtime-state-store";

import type {
  DurableMemoryRelatedEntity,
  DurableMemoryRelatedEntityType,
  DurableMemoryRelatedInfo,
} from "./memory-related-entities.js";
import {
  canonicalInteractionEntityKey,
  isGenericRelatedEntityLabel,
} from "./workspace-related-entity-keys.js";

export interface InteractionLeafArtifactDescriptor {
  entityKey: string;
  title: string;
  sourceTurnInputId: string | null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeRequestSignal(value: string): string {
  return compactWhitespace(value)
    .replace(/^#+\s*/g, "")
    .replace(/^[-*]\s*/g, "");
}

export function isRequestShapedInteractionLeaf(params: {
  title: string;
  summary: string;
  body: string;
  subjectKey?: string | null;
}): boolean {
  const candidates = [
    params.title,
    params.summary,
    params.subjectKey ?? "",
    params.body.split(/\r?\n/, 8).join(" "),
  ]
    .map(normalizeRequestSignal)
    .filter(Boolean);
  return candidates.some((value) =>
    /^(?:the\s+)?user\s+(?:asked|requested)\s+to\b/i.test(value),
  );
}

function sectionBody(markdown: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`(?:^|\\n)${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  const body = typeof match?.[1] === "string" ? match[1].trim() : "";
  return body || null;
}

function sectionPrefix(markdown: string): string {
  const match = markdown.match(/^([\s\S]*?)(?=\n## Summary\n|$)/);
  return typeof match?.[1] === "string" ? match[1].trimEnd() : markdown.trimEnd();
}

function hasClippedEllipsis(value: string): boolean {
  const normalized = compactWhitespace(value);
  return /\.\.\./.test(normalized);
}

function relatedInfoHasGenericPlaceholder(params: {
  relatedInfo: DurableMemoryRelatedInfo;
}): boolean {
  const hasPlaceholderEntity = params.relatedInfo.relatedEntities.some((entity) =>
    isGenericRelatedEntityLabel(entity.label)
    || isGenericRelatedEntityLabel(entity.entityKey.split(":").at(-1) ?? ""),
  );
  if (hasPlaceholderEntity) {
    return true;
  }
  return params.relatedInfo.relations.some((relation) =>
    isGenericRelatedEntityLabel(relation.entityKey.split(":").at(-1) ?? ""),
  );
}

function hasMissingArtifactDerivedFromRelation(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  artifactDescriptors: InteractionLeafArtifactDescriptor[];
}): boolean {
  if (params.artifactDescriptors.length === 0) {
    return false;
  }
  const derivedFromKeys = new Set(
    params.relatedInfo.relations
      .filter((relation) => relation.relationType === "derived_from")
      .map((relation) => relation.entityKey),
  );
  return params.artifactDescriptors.some((descriptor) => !derivedFromKeys.has(descriptor.entityKey));
}

function uniqueEvidenceLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines) {
    const next = compactWhitespace(line);
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function canonicalRelatedEntityTypeForInteractionOwner(
  entityType: InteractionEntityType,
): DurableMemoryRelatedEntityType {
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
    case "preference":
    case "topic":
    case "misc":
      return "topic";
    default:
      return "topic";
  }
}

function hasUsefulSemanticRelation(relatedInfo: DurableMemoryRelatedInfo): boolean {
  return relatedInfo.relations.some((relation) =>
    relation.relationType !== "mentions" && relation.relationType !== "derived_from",
  );
}

export function restoreInteractionLeafContentFromSourceEvidence(params: {
  title: string;
  memoryType: string;
  body: string;
  summary: string;
  assistantText?: string | null;
  evidenceLines: string[];
}): { content: string; summary: string; changed: boolean } {
  const existingSummary = sectionBody(params.body, "## Summary") ?? compactWhitespace(params.summary);
  const existingEvidence = sectionBody(params.body, "## Evidence");
  const summaryNeedsRepair = hasClippedEllipsis(existingSummary) || hasClippedEllipsis(params.summary);
  const evidenceNeedsRepair = hasClippedEllipsis(existingEvidence ?? "") || params.evidenceLines.length > 0;
  if (!summaryNeedsRepair && !evidenceNeedsRepair) {
    return {
      content: params.body,
      summary: params.summary,
      changed: false,
    };
  }

  const recoveredEvidenceLines = uniqueEvidenceLines([
    ...(existingEvidence && !hasClippedEllipsis(existingEvidence)
      ? existingEvidence.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : []),
    ...params.evidenceLines,
  ]);
  const recoveredSummarySource = compactWhitespace(
    params.assistantText
    || recoveredEvidenceLines[0]
    || "",
  );
  if (summaryNeedsRepair && !recoveredSummarySource) {
    return {
      content: params.body,
      summary: params.summary,
      changed: false,
    };
  }
  if (recoveredEvidenceLines.length === 0 && !summaryNeedsRepair) {
    return {
      content: params.body,
      summary: params.summary,
      changed: false,
    };
  }

  const nextSummary = summaryNeedsRepair
    ? compactWhitespace(
        recoveredSummarySource
        || existingSummary
        || params.title,
      )
    : compactWhitespace(existingSummary || params.summary || params.title);
  const prefix = sectionPrefix(params.body) || `# ${params.title}\n\n- Type: \`${params.memoryType}\``;
  const lines = [
    prefix,
    "",
    "## Summary",
    "",
    nextSummary || params.title,
  ];
  if (recoveredEvidenceLines.length > 0) {
    lines.push(
      "",
      "## Evidence",
      "",
      ...recoveredEvidenceLines,
    );
  }
  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    summary: nextSummary || params.summary || params.title,
    changed: true,
  };
}

export function interactionLeafNeedsQualityRepair(params: {
  title: string;
  summary: string;
  body: string;
  subjectKey?: string | null;
  relatedInfo: DurableMemoryRelatedInfo;
  artifactDescriptors: InteractionLeafArtifactDescriptor[];
}): boolean {
  if (isRequestShapedInteractionLeaf(params)) {
    return true;
  }
  if (hasClippedEllipsis(params.summary) || hasClippedEllipsis(params.body)) {
    return true;
  }
  if (params.relatedInfo.relations.length === 0) {
    return true;
  }
  if (relatedInfoHasGenericPlaceholder({
    relatedInfo: params.relatedInfo,
  })) {
    return true;
  }
  if (hasMissingArtifactDerivedFromRelation({
    relatedInfo: params.relatedInfo,
    artifactDescriptors: params.artifactDescriptors,
  })) {
    return true;
  }
  return needsModelAssistedInteractionLeafRelationRepair({
    relatedInfo: params.relatedInfo,
    hasProcessedMarker: false,
  });
}

export function relatedInfoNeedsCanonicalRewrite(params: {
  original: DurableMemoryRelatedInfo;
  canonical: DurableMemoryRelatedInfo;
}): boolean {
  if (params.original.relatedEntities.length !== params.canonical.relatedEntities.length) {
    return true;
  }
  if (params.original.relations.length !== params.canonical.relations.length) {
    return true;
  }
  for (let index = 0; index < params.original.relatedEntities.length; index += 1) {
    const original = params.original.relatedEntities[index];
    const canonical = params.canonical.relatedEntities[index];
    if (
      original?.entityType !== canonical?.entityType
      || original?.entityKey !== canonical?.entityKey
      || original?.label !== canonical?.label
    ) {
      return true;
    }
  }
  for (let index = 0; index < params.original.relations.length; index += 1) {
    const original = params.original.relations[index];
    const canonical = params.canonical.relations[index];
    if (
      original?.relationType !== canonical?.relationType
      || original?.entityKey !== canonical?.entityKey
    ) {
      return true;
    }
  }
  return false;
}

export function ensureMinimumSemanticOwnerRelatedInfo(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  ownerEntityType: InteractionEntityType;
  ownerEntityId: string;
  ownerLabel: string;
}): DurableMemoryRelatedInfo {
  if (hasUsefulSemanticRelation(params.relatedInfo)) {
    return params.relatedInfo;
  }
  const entityType = canonicalRelatedEntityTypeForInteractionOwner(params.ownerEntityType);
  const ownerEntity: DurableMemoryRelatedEntity = {
    entityType,
    entityKey: canonicalInteractionEntityKey(entityType, params.ownerEntityId),
    label: compactWhitespace(params.ownerLabel) || params.ownerEntityId,
  };
  const entities = new Map(
    params.relatedInfo.relatedEntities.map((entity) => [entity.entityKey, entity] as const),
  );
  entities.set(ownerEntity.entityKey, ownerEntity);
  const relations = new Map(
    params.relatedInfo.relations.map((relation) => [`${relation.relationType}|${relation.entityKey}`, relation] as const),
  );
  relations.set(`about|${ownerEntity.entityKey}`, {
    relationType: "about",
    entityKey: ownerEntity.entityKey,
  });
  return {
    relatedEntities: [...entities.values()].sort((left, right) =>
      left.entityKey.localeCompare(right.entityKey) || left.label.localeCompare(right.label),
    ),
    relations: [...relations.values()].sort((left, right) =>
      left.relationType.localeCompare(right.relationType) || left.entityKey.localeCompare(right.entityKey),
    ),
  };
}

export function needsModelAssistedInteractionLeafRelationRepair(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  hasProcessedMarker: boolean;
}): boolean {
  if (params.hasProcessedMarker) {
    return false;
  }
  if (params.relatedInfo.relatedEntities.length === 0 && params.relatedInfo.relations.length === 0) {
    return true;
  }
  const concreteNonArtifactEntityCount = params.relatedInfo.relatedEntities.filter((entity) => entity.entityType !== "artifact").length;
  const strongSemanticRelationExists = params.relatedInfo.relations.some((relation) =>
    relation.relationType !== "derived_from"
    && relation.relationType !== "mentions"
    && relation.relationType !== "about",
  );
  if (strongSemanticRelationExists) {
    return false;
  }
  return concreteNonArtifactEntityCount <= 1;
}

export function shouldForceModelInteractionLeafRelationRepair(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  hasProcessedMarker: boolean;
  strippedStaleRelatedInfo: boolean;
}): boolean {
  return needsModelAssistedInteractionLeafRelationRepair({
    relatedInfo: params.relatedInfo,
    hasProcessedMarker: false,
  }) && (!params.hasProcessedMarker || params.strippedStaleRelatedInfo);
}

export function buildInteractionLeafArtifactRelatedInfo(params: {
  sourceTurnInputId: string | null;
  artifactDescriptors: InteractionLeafArtifactDescriptor[];
}): DurableMemoryRelatedInfo {
  const sourceTurnInputId = params.sourceTurnInputId?.trim() ?? "";
  if (!sourceTurnInputId) {
    return {
      relatedEntities: [],
      relations: [],
    };
  }
  const matchingDescriptors = params.artifactDescriptors
    .filter((descriptor) => (descriptor.sourceTurnInputId?.trim() ?? "") === sourceTurnInputId)
    .filter((descriptor) => descriptor.entityKey.trim().length > 0);
  const relatedEntities = new Map<string, {
    entityType: "artifact";
    entityKey: string;
    label: string;
  }>();
  const relations = new Map<string, {
    relationType: string;
    entityKey: string;
  }>();
  for (const descriptor of matchingDescriptors) {
    const entityKey = descriptor.entityKey.trim();
    if (!relatedEntities.has(entityKey)) {
      relatedEntities.set(entityKey, {
        entityType: "artifact",
        entityKey,
        label: compactWhitespace(descriptor.title) || entityKey,
      });
    }
    relations.set(`derived_from|${entityKey}`, {
      relationType: "derived_from",
      entityKey,
    });
    relations.set(`mentions|${entityKey}`, {
      relationType: "mentions",
      entityKey,
    });
  }
  return {
    relatedEntities: [...relatedEntities.values()].sort((left, right) =>
      left.entityKey.localeCompare(right.entityKey) || left.label.localeCompare(right.label),
    ),
    relations: [...relations.values()].sort((left, right) =>
      left.relationType.localeCompare(right.relationType) || left.entityKey.localeCompare(right.entityKey),
    ),
  };
}
