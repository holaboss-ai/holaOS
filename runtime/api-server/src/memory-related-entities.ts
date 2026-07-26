import type { DurableMemoryArtifactContext } from "./memory-artifact-context.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { queryMemoryModelJson } from "./memory-model-client.js";
import {
  isGenericRelatedEntityKey,
  isGenericRelatedEntityLabel,
  legacyRelatedEntityKey,
  relatedAliasLookupKeys,
} from "./workspace-related-entity-keys.js";
import type { WorkspaceRelatedEntityResolver } from "./workspace-related-entity-resolver.js";

export type DurableMemoryRelatedEntityType =
  | "person"
  | "organization"
  | "customer"
  | "system"
  | "project"
  | "workflow"
  | "topic"
  | "artifact"
  | "issue";

export type DurableMemoryRelationType = string;

export interface DurableMemoryRelatedEntity {
  entityType: DurableMemoryRelatedEntityType;
  entityKey: string;
  label: string;
}

export interface DurableMemoryEntityRelation {
  relationType: DurableMemoryRelationType;
  entityKey: string;
}

export interface DurableMemoryRelatedInfo {
  relatedEntities: DurableMemoryRelatedEntity[];
  relations: DurableMemoryEntityRelation[];
}

interface RawRelatedEntity {
  entity_type: unknown;
  label: unknown;
}

interface RawRelation {
  relation_type: unknown;
  entity_type: unknown;
  entity_label: unknown;
}

const RELATED_ENTITY_SECTION_HEADING = "## Related Entities";
const RELATIONS_SECTION_HEADING = "## Relations";
const RELATED_INFO_PROCESSED_MARKER = "<!-- durable-memory-related: processed -->";
const MAX_RELATION_TYPE_LENGTH = 64;
const MAX_RELATION_PROMPT_ARTIFACT_CONTEXTS = 4;
const MAX_RELATION_PROMPT_EXCERPTS_PER_ARTIFACT = 2;
const MAX_RELATION_PROMPT_CHARS_PER_EXCERPT = 420;
const RELATED_ENTITY_TYPES = new Set<DurableMemoryRelatedEntityType>([
  "person",
  "organization",
  "customer",
  "system",
  "project",
  "workflow",
  "topic",
  "artifact",
  "issue",
]);

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownHeadings(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))
    .join(" ");
}

function renderArtifactContext(context: DurableMemoryArtifactContext): string[] {
  const lines = [
    `- Source kind: ${context.sourceKind}`,
    `  Title: ${compactWhitespace(context.title)}`,
  ];
  if (context.provider) {
    lines.push(`  Provider: ${compactWhitespace(context.provider)}`);
  }
  if (context.accountNamespace) {
    lines.push(`  Account namespace: ${compactWhitespace(context.accountNamespace)}`);
  }
  if (context.canonicalEntityKey) {
    lines.push(`  Canonical artifact key: ${compactWhitespace(context.canonicalEntityKey)}`);
  }
  lines.push("  Excerpts:");
  const excerpts = context.excerpts.map((excerpt) => compactWhitespace(excerpt)).filter(Boolean);
  if (excerpts.length === 0) {
    lines.push("  - none");
  } else {
    for (const excerpt of excerpts) {
      lines.push(`  - ${excerpt}`);
    }
  }
  return lines;
}

function artifactContextPromptLines(contexts: DurableMemoryArtifactContext[] | null | undefined): string[] {
  if (!contexts || contexts.length === 0) {
    return [];
  }
  const includedContexts = contexts.slice(0, MAX_RELATION_PROMPT_ARTIFACT_CONTEXTS);
  const omittedContextCount = Math.max(0, contexts.length - includedContexts.length);
  const lines = [
    "",
    "Structured artifact evidence:",
    ...includedContexts.flatMap((context) => {
      const boundedExcerpts = context.excerpts
        .slice(0, MAX_RELATION_PROMPT_EXCERPTS_PER_ARTIFACT)
        .map((excerpt) => compactWhitespace(excerpt).slice(0, MAX_RELATION_PROMPT_CHARS_PER_EXCERPT))
        .filter(Boolean);
      const boundedContextLines = renderArtifactContext({
        ...context,
        excerpts: boundedExcerpts,
      });
      const omittedExcerptCount = Math.max(0, context.excerpts.length - boundedExcerpts.length);
      return omittedExcerptCount > 0
        ? [
            ...boundedContextLines,
            `  - ... ${omittedExcerptCount} more excerpt${omittedExcerptCount === 1 ? "" : "s"} omitted`,
          ]
        : boundedContextLines;
    }),
  ];
  if (omittedContextCount > 0) {
    lines.push(`- ... ${omittedContextCount} more artifact context${omittedContextCount === 1 ? "" : "s"} omitted`);
  }
  return lines;
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeEntityType(value: unknown): DurableMemoryRelatedEntityType | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim().toLowerCase();
  return RELATED_ENTITY_TYPES.has(token as DurableMemoryRelatedEntityType)
    ? token as DurableMemoryRelatedEntityType
    : null;
}

function normalizeRelationType(value: unknown): DurableMemoryRelationType | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, MAX_RELATION_TYPE_LENGTH)
    .replace(/^_+|_+$/g, "");
  return token || null;
}

function stableEntityLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return compactWhitespace(value);
}

export function stableRelatedEntityKey(entityType: DurableMemoryRelatedEntityType, label: string): string {
  return legacyRelatedEntityKey(entityType, label);
}

function relatedEntityComparator(
  left: DurableMemoryRelatedEntity,
  right: DurableMemoryRelatedEntity,
): number {
  return left.entityKey.localeCompare(right.entityKey)
    || left.label.localeCompare(right.label);
}

function relationComparator(
  left: DurableMemoryEntityRelation,
  right: DurableMemoryEntityRelation,
): number {
  return left.relationType.localeCompare(right.relationType)
    || left.entityKey.localeCompare(right.entityKey);
}

function resolvedArtifactEntityFromContexts(params: {
  entity: DurableMemoryRelatedEntity;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): DurableMemoryRelatedEntity | null {
  if (params.entity.entityType !== "artifact") {
    return null;
  }
  const requestedKeys = new Set(
    [params.entity.entityKey, params.entity.label]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .flatMap((value) => relatedAliasLookupKeys(value)),
  );
  if (requestedKeys.size === 0) {
    return null;
  }
  const candidates = (params.artifactContexts ?? [])
    .filter((context) => typeof context.canonicalEntityKey === "string" && context.canonicalEntityKey.trim().length > 0)
    .map((context) => ({
      entityKey: context.canonicalEntityKey!.trim(),
      label: context.title,
      aliasKeys: new Set(
        [
          context.title,
          context.canonicalEntityKey,
          context.provider,
          context.accountNamespace,
          context.provider && context.accountNamespace
            ? `${context.provider} ${context.accountNamespace}`
            : null,
          context.provider
            ? `${context.provider} ${context.title}`
            : null,
          context.accountNamespace
            ? `${context.accountNamespace} ${context.title}`
            : null,
        ]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .flatMap((value) => relatedAliasLookupKeys(value)),
      ),
    }));
  if (candidates.length === 0) {
    return null;
  }
  const directCanonical = candidates.find((candidate) =>
    relatedAliasLookupKeys(candidate.entityKey).some((lookupKey) => requestedKeys.has(lookupKey)),
  );
  if (directCanonical) {
    return {
      entityType: "artifact",
      entityKey: directCanonical.entityKey,
      label: directCanonical.label,
    };
  }
  const matches = candidates.filter((candidate) =>
    [...requestedKeys].some((key) => candidate.aliasKeys.has(key)),
  );
  const uniqueMatches = new Map(matches.map((candidate) => [candidate.entityKey, candidate] as const));
  if (uniqueMatches.size !== 1) {
    return null;
  }
  const resolved = [...uniqueMatches.values()][0];
  return {
    entityType: "artifact",
    entityKey: resolved.entityKey,
    label: resolved.label,
  };
}

export function mergeDurableMemoryRelatedInfo(
  left: DurableMemoryRelatedInfo,
  right: DurableMemoryRelatedInfo,
): DurableMemoryRelatedInfo {
  const entities = new Map<string, DurableMemoryRelatedEntity>();
  for (const entity of [...left.relatedEntities, ...right.relatedEntities]) {
    entities.set(entity.entityKey, entity);
  }
  const relations = new Map<string, DurableMemoryEntityRelation>();
  for (const relation of [...left.relations, ...right.relations]) {
    relations.set(`${relation.relationType}|${relation.entityKey}`, relation);
  }
  return {
    relatedEntities: [...entities.values()].sort(relatedEntityComparator),
    relations: [...relations.values()].sort(relationComparator),
  };
}

export function mergeArtifactDerivedRelations(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  artifactContexts: DurableMemoryArtifactContext[];
}): DurableMemoryRelatedInfo {
  if (params.artifactContexts.length === 0) {
    return params.relatedInfo;
  }
  const artifactRelatedInfo: DurableMemoryRelatedInfo = {
    relatedEntities: params.artifactContexts
      .filter((context) => typeof context.canonicalEntityKey === "string" && context.canonicalEntityKey.trim().length > 0)
      .map((context) => ({
        entityType: "artifact" as const,
        entityKey: context.canonicalEntityKey as string,
        label: context.title,
      })),
    relations: params.artifactContexts
      .filter((context) => typeof context.canonicalEntityKey === "string" && context.canonicalEntityKey.trim().length > 0)
      .flatMap((context) => ([
        {
          relationType: "derived_from",
          entityKey: context.canonicalEntityKey as string,
        },
        {
          relationType: "mentions",
          entityKey: context.canonicalEntityKey as string,
        },
      ])),
  };
  return mergeDurableMemoryRelatedInfo(params.relatedInfo, artifactRelatedInfo);
}

function normalizeRelatedEntities(values: unknown): DurableMemoryRelatedEntity[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const entities = new Map<string, DurableMemoryRelatedEntity>();
  for (const value of values) {
    const candidate = value as RawRelatedEntity;
    const entityType = normalizeEntityType(candidate?.entity_type);
    const label = stableEntityLabel(candidate?.label);
    if (!entityType || !label) {
      continue;
    }
    const entityKey = stableRelatedEntityKey(entityType, label);
    if (!entities.has(entityKey)) {
      entities.set(entityKey, {
        entityType,
        entityKey,
        label,
      });
    }
  }
  return [...entities.values()].sort(relatedEntityComparator);
}

function normalizeRelations(values: unknown, relatedEntities: DurableMemoryRelatedEntity[]): DurableMemoryEntityRelation[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const entityByKey = new Map(relatedEntities.map((entity) => [entity.entityKey, entity]));
  const relations = new Map<string, DurableMemoryEntityRelation>();
  for (const value of values) {
    const candidate = value as RawRelation;
    const relationType = normalizeRelationType(candidate?.relation_type);
    const entityType = normalizeEntityType(candidate?.entity_type);
    const entityLabel = stableEntityLabel(candidate?.entity_label);
    if (!relationType || !entityType || !entityLabel) {
      continue;
    }
    const entityKey = stableRelatedEntityKey(entityType, entityLabel);
    if (!entityByKey.has(entityKey)) {
      entityByKey.set(entityKey, {
        entityType,
        entityKey,
        label: entityLabel,
      });
    }
    const relationKey = `${relationType}|${entityKey}`;
    if (!relations.has(relationKey)) {
      relations.set(relationKey, {
        relationType,
        entityKey,
      });
    }
  }
  return [...relations.values()].sort(relationComparator);
}

export function stripDurableMemoryRelatedSections(markdown: string): string {
  const pattern = new RegExp(
    `\\n{2}(?:${RELATED_ENTITY_SECTION_HEADING.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}|${RELATIONS_SECTION_HEADING.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})\\n[\\s\\S]*$`,
    "m",
  );
  return markdown.replace(pattern, "").replace(new RegExp(`\\n?${RELATED_INFO_PROCESSED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "").trimEnd();
}

export function hasDurableMemoryRelatedProcessedMarker(markdown: string): boolean {
  return markdown.includes(RELATED_INFO_PROCESSED_MARKER);
}

export function markDurableMemoryRelatedProcessed(markdown: string): string {
  const base = stripDurableMemoryRelatedSections(markdown).trimEnd();
  return `${base}\n\n${RELATED_INFO_PROCESSED_MARKER}\n`;
}

function parseSectionLines(markdown: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`(?:^|\\n)${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!match || typeof match[1] !== "string") {
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseDurableMemoryRelatedInfo(markdown: string): DurableMemoryRelatedInfo {
  const entityLines = parseSectionLines(markdown, RELATED_ENTITY_SECTION_HEADING);
  const entities = new Map<string, DurableMemoryRelatedEntity>();
  for (const line of entityLines) {
    const match = line.match(/^- `([^`]+)` \| (.+)$/);
    if (!match) {
      continue;
    }
    const entityKey = compactWhitespace(match[1] ?? "");
    const label = stableEntityLabel(match[2] ?? "");
    const [entityTypeToken] = entityKey.split(":", 1);
    const entityType = normalizeEntityType(entityTypeToken);
    if (!entityType || !entityKey || !label) {
      continue;
    }
    entities.set(entityKey, {
      entityType,
      entityKey,
      label,
    });
  }

  const relationLines = parseSectionLines(markdown, RELATIONS_SECTION_HEADING);
  const relations = new Map<string, DurableMemoryEntityRelation>();
  for (const line of relationLines) {
    const match = line.match(/^- `([^`]+)` -> `([^`]+)`(?: \| (.+))?$/);
    if (!match) {
      continue;
    }
    const relationType = normalizeRelationType(match[1] ?? "");
    const entityKey = compactWhitespace(match[2] ?? "");
    if (!relationType || !entityKey) {
      continue;
    }
    const [entityTypeToken] = entityKey.split(":", 1);
    const entityType = normalizeEntityType(entityTypeToken);
    const label = stableEntityLabel(match[3] ?? "");
    if (entityType && label && !entities.has(entityKey)) {
      entities.set(entityKey, {
        entityType,
        entityKey,
        label,
      });
    }
    relations.set(`${relationType}|${entityKey}`, {
      relationType,
      entityKey,
    });
  }

  return {
    relatedEntities: [...entities.values()].sort(relatedEntityComparator),
    relations: [...relations.values()].sort(relationComparator),
  };
}

export function appendDurableMemoryRelatedSections(
  markdown: string,
  relatedInfo: DurableMemoryRelatedInfo,
): string {
  const normalized = {
    relatedEntities: [...relatedInfo.relatedEntities].sort(relatedEntityComparator),
    relations: [...relatedInfo.relations].sort(relationComparator),
  };
  if (normalized.relatedEntities.length === 0 && normalized.relations.length === 0) {
    return stripDurableMemoryRelatedSections(markdown).trimEnd() + "\n";
  }
  const base = stripDurableMemoryRelatedSections(markdown).trimEnd();
  const entityLabelByKey = new Map(
    normalized.relatedEntities.map((entity) => [entity.entityKey, entity.label] as const),
  );
  const lines = [
    base,
    "",
    RELATED_ENTITY_SECTION_HEADING,
    "",
    ...normalized.relatedEntities.map((entity) => `- \`${entity.entityKey}\` | ${entity.label}`),
    "",
    RELATIONS_SECTION_HEADING,
    "",
    ...normalized.relations.map((relation) => {
      const label = entityLabelByKey.get(relation.entityKey);
      return label
        ? `- \`${relation.relationType}\` -> \`${relation.entityKey}\` | ${label}`
        : `- \`${relation.relationType}\` -> \`${relation.entityKey}\``;
    }),
    "",
    RELATED_INFO_PROCESSED_MARKER,
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeRelatedInfo(payload: unknown): DurableMemoryRelatedInfo {
  const relatedEntities = normalizeRelatedEntities(
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { related_entities?: unknown }).related_entities
      : null,
  );
  const extractedRelations = normalizeRelations(
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { relations?: unknown }).relations
      : null,
    relatedEntities,
  );
  const relations = [...extractedRelations];
  const relationKeys = new Set(relations.map((relation) => `${relation.relationType}|${relation.entityKey}`));
  for (const entity of relatedEntities) {
    const defaultKey = `mentions|${entity.entityKey}`;
    if (!relationKeys.has(defaultKey)) {
      relationKeys.add(defaultKey);
      relations.push({
        relationType: "mentions",
        entityKey: entity.entityKey,
      });
    }
  }
  return {
    relatedEntities: [...relatedEntities].sort(relatedEntityComparator),
    relations: relations.sort(relationComparator),
  };
}

function hasGenericPlaceholderEntities(relatedInfo: DurableMemoryRelatedInfo): boolean {
  return relatedInfo.relatedEntities.some((entity) => isGenericRelatedEntityLabel(entity.label));
}

function hasUsefulResolvedSemanticSignal(relatedInfo: DurableMemoryRelatedInfo): boolean {
  const entityByKey = new Map(
    relatedInfo.relatedEntities.map((entity) => [entity.entityKey, entity] as const),
  );
  return relatedInfo.relatedEntities.some((entity) =>
    !isGenericRelatedEntityLabel(entity.label) && entity.entityType !== "artifact",
  ) || relatedInfo.relations.some((relation) => {
    if (relation.relationType === "mentions") {
      return false;
    }
    const entity = entityByKey.get(relation.entityKey);
    return Boolean(entity && !isGenericRelatedEntityLabel(entity.label));
  });
}

function shouldRetryGenericPlaceholderRepair(params: {
  initialRelatedInfo: DurableMemoryRelatedInfo;
  canonicalizedRelatedInfo: DurableMemoryRelatedInfo;
}): boolean {
  if (params.initialRelatedInfo.relatedEntities.length === 0 && params.initialRelatedInfo.relations.length === 0) {
    return false;
  }
  return hasGenericPlaceholderEntities(params.initialRelatedInfo)
    && !hasUsefulResolvedSemanticSignal(params.canonicalizedRelatedInfo);
}

function stripGenericPlaceholderRelatedInfo(relatedInfo: DurableMemoryRelatedInfo): DurableMemoryRelatedInfo {
  const keptEntities = relatedInfo.relatedEntities.filter((entity) => !isGenericRelatedEntityLabel(entity.label));
  const keptEntityKeys = new Set(keptEntities.map((entity) => entity.entityKey));
  const keptRelations = relatedInfo.relations.filter((relation) => keptEntityKeys.has(relation.entityKey));
  return {
    relatedEntities: keptEntities,
    relations: keptRelations,
  };
}

function relatedEntityExtractionPrompt(params: {
  memoryType: string;
  subjectKey: string;
  title: string;
  summary: string;
  content: string;
  tags?: string[] | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
  repairMode?: "generic_placeholder_repair";
}): {
  systemPrompt: string;
  userPrompt: string;
} {
  const repairInstruction = params.repairMode === "generic_placeholder_repair"
    ? [
        "A previous extraction was too generic.",
        "Retry and return only concrete durable targets that are explicitly named or strongly supported by the memory and structured artifact evidence.",
        "Do not return generic placeholders such as topic, artifact, document, page, report, issue, or system unless they are literal concrete names.",
        "Prefer exact people, organizations, project names, system/account identifiers, and artifact filenames with concrete titles.",
      ]
    : [];
  return {
    systemPrompt: [
      "Extract related durable entities and relations from one stored workspace memory.",
      "Return strict JSON only with this shape:",
      '{"related_entities":[{"entity_type":"person|organization|customer|system|project|workflow|topic|artifact|issue","label":"string"}],"relations":[{"relation_type":"snake_case_string","entity_type":"person|organization|customer|system|project|workflow|topic|artifact|issue","entity_label":"string"}]}',
      "Only include entities explicitly mentioned or strongly implied by the memory itself.",
      "Preserve exact names, IDs, account numbers, organizations, attachment names, and concrete labels when they matter.",
      "Prefer a small, high-signal set of entities that would help retrieval later.",
      "Structured artifact evidence, when present, is authoritative context for related artifacts, providers, account namespaces, and concrete names referenced by this memory.",
      "Do not invent hidden entities, guessed org structure, or speculative relationships.",
      "Exclude the workspace itself.",
      "Use concise snake_case relation types. Reuse common relations like about, mentions, contacted_by, works_at, applies_to, owner, blocks, or related_to when they fit, but you may emit a more precise snake_case relation type when the memory supports it.",
      ...repairInstruction,
    ].join(" "),
    userPrompt: [
      `Memory type: ${params.memoryType}`,
      `Subject key: ${params.subjectKey}`,
      `Title: ${params.title}`,
      `Summary: ${params.summary}`,
      `Tags: ${(params.tags ?? []).join(", ") || "none"}`,
      "",
      "Memory content:",
      stripMarkdownHeadings(stripDurableMemoryRelatedSections(params.content)).slice(0, 6_000),
      ...artifactContextPromptLines(params.artifactContexts),
    ].join("\n"),
  };
}

export function canonicalizeDurableMemoryRelatedInfo(params: {
  relatedInfo: DurableMemoryRelatedInfo;
  resolver: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): DurableMemoryRelatedInfo {
  const rewrittenEntities = new Map<string, DurableMemoryRelatedEntity>();
  const remappedKeys = new Map<string, string>();
  for (const entity of params.relatedInfo.relatedEntities) {
    const artifactContextEntity = resolvedArtifactEntityFromContexts({
      entity,
      artifactContexts: params.artifactContexts ?? null,
    });
    if (artifactContextEntity) {
      rewrittenEntities.set(artifactContextEntity.entityKey, artifactContextEntity);
      remappedKeys.set(entity.entityKey, artifactContextEntity.entityKey);
      continue;
    }
    const resolved = params.resolver?.resolve({
      entityType: entity.entityType,
      entityKey: entity.entityKey,
      label: entity.label,
      sourceTurnInputId: params.sourceTurnInputId ?? null,
    }) ?? null;
    if (resolved) {
      rewrittenEntities.set(resolved.entityKey, {
        entityType: resolved.entityType,
        entityKey: resolved.entityKey,
        label: resolved.label,
      });
      remappedKeys.set(entity.entityKey, resolved.entityKey);
      continue;
    }
    if (isGenericRelatedEntityLabel(entity.label)) {
      continue;
    }
    const fallbackEntityKey = isGenericRelatedEntityKey(entity.entityKey)
      ? stableRelatedEntityKey(entity.entityType, entity.label)
      : entity.entityKey;
    rewrittenEntities.set(fallbackEntityKey, {
      ...entity,
      entityKey: fallbackEntityKey,
    });
    remappedKeys.set(entity.entityKey, fallbackEntityKey);
  }
  const rewrittenRelations = new Map<string, DurableMemoryEntityRelation>();
  for (const relation of params.relatedInfo.relations) {
    const nextEntityKey = remappedKeys.get(relation.entityKey);
    if (!nextEntityKey || !rewrittenEntities.has(nextEntityKey)) {
      continue;
    }
    rewrittenRelations.set(`${relation.relationType}|${nextEntityKey}`, {
      relationType: relation.relationType,
      entityKey: nextEntityKey,
    });
  }
  return {
    relatedEntities: [...rewrittenEntities.values()].sort(relatedEntityComparator),
    relations: [...rewrittenRelations.values()].sort(relationComparator),
  };
}

export async function extractDurableMemoryRelatedInfo(params: {
  modelClient: MemoryModelClientConfig | null;
  memoryType: string;
  subjectKey: string;
  title: string;
  summary: string;
  content: string;
  tags?: string[] | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
  resolver?: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
}): Promise<DurableMemoryRelatedInfo> {
  if (!params.modelClient) {
    return {
      relatedEntities: [],
      relations: [],
    };
  }
  const initialPrompt = relatedEntityExtractionPrompt(params);
  const initialPayload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: initialPrompt.systemPrompt,
    userPrompt: initialPrompt.userPrompt,
    timeoutMs: 7000,
    agentRole: "memory-recall",
  });
  const initialRelatedInfo = normalizeRelatedInfo(initialPayload);
  const canonicalizedInitial = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: initialRelatedInfo,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  if (!shouldRetryGenericPlaceholderRepair({
    initialRelatedInfo,
    canonicalizedRelatedInfo: canonicalizedInitial,
  })) {
    return canonicalizedInitial;
  }
  const repairPrompt = relatedEntityExtractionPrompt({
    ...params,
    repairMode: "generic_placeholder_repair",
  });
  const repairPayload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: repairPrompt.systemPrompt,
    userPrompt: repairPrompt.userPrompt,
    timeoutMs: 7000,
    agentRole: "memory-recall",
  });
  const repairedCanonical = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: normalizeRelatedInfo(repairPayload),
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  return mergeDurableMemoryRelatedInfo(
    stripGenericPlaceholderRelatedInfo(canonicalizedInitial),
    repairedCanonical,
  );
}
