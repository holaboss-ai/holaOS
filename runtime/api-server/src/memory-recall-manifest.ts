import fs from "node:fs";
import path from "node:path";

import type {
  MemoryEmbeddingIndexRecord,
  MemoryEntryRecord,
  MemoryEntryScope,
  MemoryEntryType,
  MemoryVerificationPolicy,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";
import yaml from "js-yaml";
import { resolveMemoryFilePath } from "./workspace-bundle-paths.js";

import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import { governanceRuleForMemoryType, assessMemoryFreshness } from "./memory-governance.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import {
  normalizedStringArray,
  queryMemoryModelEmbedding,
  queryMemoryModelJson,
} from "./memory-model-client.js";
import { RECALL_EMBEDDING_DIM } from "./memory-embedding-index.js";

const MAX_FRONTMATTER_LINES = 40;
const MAX_MEMORY_SNIPPET_CHARS = 360;
const MAX_SCOPE_SAMPLE_TITLES = 6;
const MAX_INDEX_ENTRIES = 200;
const MAX_PRIMARY_PATHS = 8;
const MAX_RESERVE_PATHS = 4;
const VECTOR_WORKSPACE_LIMIT = 12;
const VECTOR_USER_LIMIT = 8;
const VECTOR_PRIMARY_PATHS = 8;
const VECTOR_RESERVE_PATHS = 4;
const PLAN_AND_CANDIDATE_TIMEOUT_MS = 7000;
const FINALIZE_TIMEOUT_MS = 7000;

type RecallScope = "workspace" | "preference" | "identity";

type RecallStatus = "sufficient" | "expand_once" | "none";

interface IndexFileRecord {
  path: string;
  absPath: string;
  scope: RecallScope | "root";
  exists: boolean;
}

interface ParsedIndexLinkRecord {
  indexPath: string;
  scope: RecallScope;
  leafPath: string;
  title: string;
  summary: string;
}

interface IndexedMemoryRecord {
  indexPath: string;
  scope: RecallScope;
  path: string;
  title: string;
  summary: string;
  memoryType: MemoryEntryType;
  tags: string[];
  verificationPolicy: MemoryVerificationPolicy;
  updatedAt: string;
}

interface LeafMemoryRecord {
  path: string;
  absPath: string;
  scope: MemoryEntryScope;
  memoryType: MemoryEntryType;
  title: string;
  summary: string;
  updatedAt: string;
  excerpt: string;
}

interface RecallPlan {
  shouldRecall: boolean;
  rewrittenQuery: string;
  scopes: RecallScope[];
  memoryTypes: MemoryEntryType[];
  reason: string;
}

interface PlannedCandidateSelection extends RecallPlan {
  primaryPaths: string[];
  reservePaths: string[];
  reasonByPath: Map<string, string>;
}

interface FinalizedSelection {
  status: RecallStatus;
  finalPaths: string[];
  expansionPaths: string[];
  reasonByPath: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeRelPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveMemoryAbsolutePath(params: {
  workspaceRoot: string;
  workspaceId: string;
  relPath: string;
}): string {
  return resolveMemoryFilePath({
    workspaceRoot: params.workspaceRoot,
    workspaceDir: path.join(params.workspaceRoot, params.workspaceId),
    workspaceId: params.workspaceId,
    relPath: params.relPath,
  });
}

function frontmatterBlock(value: string): string | null {
  const normalized = value.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return typeof match?.[1] === "string" ? match[1] : null;
}

function contentWithoutFrontmatter(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "");
  return normalized.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function frontmatterMetadata(rawFrontmatter: string | null): {
  title: string;
  summary: string;
  memoryType: MemoryEntryType | null;
  scope: MemoryEntryScope | null;
  tags: string[];
} {
  if (!rawFrontmatter) {
    return {
      title: "",
      summary: "",
      memoryType: null,
      scope: null,
      tags: [],
    };
  }

  const bounded = rawFrontmatter
    .split(/\r?\n/)
    .slice(0, MAX_FRONTMATTER_LINES)
    .join("\n");
  let parsed: unknown;
  try {
    parsed = yaml.load(bounded);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    return {
      title: "",
      summary: "",
      memoryType: null,
      scope: null,
      tags: [],
    };
  }

  const title = firstNonEmptyString(parsed.title, parsed.name);
  const summary = firstNonEmptyString(parsed.summary, parsed.description);
  const typeToken = firstNonEmptyString(parsed.memory_type, parsed.type).toLowerCase();
  const scopeToken = firstNonEmptyString(parsed.scope).toLowerCase();
  const memoryType =
    typeToken === "preference" ||
    typeToken === "identity" ||
    typeToken === "fact" ||
    typeToken === "procedure" ||
    typeToken === "blocker" ||
    typeToken === "reference"
      ? (typeToken as MemoryEntryType)
      : null;
  const scope =
    scopeToken === "workspace" || scopeToken === "session" || scopeToken === "user" || scopeToken === "ephemeral"
      ? (scopeToken as MemoryEntryScope)
      : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    title,
    summary,
    memoryType,
    scope,
    tags,
  };
}

function firstHeading(content: string): string {
  const match = content.match(/^\s*#\s+(.+?)\s*$/m);
  return match ? compactWhitespace(match[1]) : "";
}

function firstSummaryLine(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("- "));
  return lines[0] ? clipText(lines[0], 180) : "";
}

function snippetFromContent(content: string): string {
  return clipText(content, MAX_MEMORY_SNIPPET_CHARS);
}

function scopeFromPath(relPath: string, workspaceId: string): MemoryEntryScope {
  if (relPath.startsWith(`workspace/${workspaceId}/`)) {
    return "workspace";
  }
  if (relPath.startsWith("preference/") || relPath.startsWith("identity/")) {
    return "user";
  }
  if (relPath.includes("/runtime/")) {
    return "session";
  }
  return "workspace";
}

function recallScopeFromPath(relPath: string, workspaceId: string): RecallScope | null {
  if (relPath.startsWith(`workspace/${workspaceId}/`) && !relPath.includes("/runtime/")) {
    return "workspace";
  }
  if (relPath.startsWith("preference/")) {
    return "preference";
  }
  if (relPath.startsWith("identity/")) {
    return "identity";
  }
  return null;
}

function typeFromPath(relPath: string): MemoryEntryType {
  if (relPath.startsWith("preference/")) {
    return "preference";
  }
  if (relPath.startsWith("identity/")) {
    return "identity";
  }
  if (relPath.includes("/procedures/")) {
    return "procedure";
  }
  if (relPath.includes("/blockers/")) {
    return "blocker";
  }
  if (relPath.includes("/references/") || relPath.includes("/reference/")) {
    return "reference";
  }
  return "fact";
}

function indexedMemorySort(records: IndexedMemoryRecord[]): IndexedMemoryRecord[] {
  return [...records].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDiff !== 0 && Number.isFinite(updatedDiff)) {
      return updatedDiff;
    }
    return left.path.localeCompare(right.path);
  });
}

function rootMemoryIndexPath(): string {
  return "MEMORY.md";
}

function workspaceMemoryIndexPath(workspaceId: string): string {
  return `workspace/${workspaceId}/MEMORY.md`;
}

function preferenceMemoryIndexPath(): string {
  return "preference/MEMORY.md";
}

function identityMemoryIndexPath(): string {
  return "identity/MEMORY.md";
}

function indexFiles(workspaceRoot: string, workspaceId: string): IndexFileRecord[] {
  const records: Array<{ path: string; scope: RecallScope | "root" }> = [
    { path: rootMemoryIndexPath(), scope: "root" },
    { path: workspaceMemoryIndexPath(workspaceId), scope: "workspace" },
    { path: preferenceMemoryIndexPath(), scope: "preference" },
    { path: identityMemoryIndexPath(), scope: "identity" },
  ];
  return records.map((record) => {
    const absPath = resolveMemoryAbsolutePath({
      workspaceRoot,
      workspaceId,
      relPath: record.path,
    });
    return {
      path: record.path,
      absPath,
      scope: record.scope,
      exists: fs.existsSync(absPath) && fs.statSync(absPath, { throwIfNoEntry: false })?.isFile() === true,
    };
  });
}

function parseScopedIndexLinks(params: {
  content: string;
  indexPath: string;
  scope: RecallScope;
  workspaceId: string;
}): ParsedIndexLinkRecord[] {
  const results: ParsedIndexLinkRecord[] = [];
  const indexDir = path.posix.dirname(params.indexPath);
  const seen = new Set<string>();
  for (const rawLine of params.content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) {
      continue;
    }
    const match = line.match(/\[([^\]]+)\]\(([^)]+)\)(.*)$/);
    if (!match) {
      continue;
    }
    const title = compactWhitespace(match[1]);
    const target = firstNonEmptyString(match[2]);
    if (!title || !target) {
      continue;
    }
    const resolvedPath = normalizeRelPath(path.posix.normalize(path.posix.join(indexDir, target)));
    if (!resolvedPath || resolvedPath.endsWith("/MEMORY.md") || resolvedPath === "MEMORY.md") {
      continue;
    }
    if (resolvedPath.includes("/runtime/")) {
      continue;
    }
    if (recallScopeFromPath(resolvedPath, params.workspaceId) !== params.scope) {
      continue;
    }
    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);
    const trailing = compactWhitespace(match[3]);
    const summary = trailing.includes(" - ")
      ? compactWhitespace(trailing.slice(trailing.indexOf(" - ") + 3))
      : compactWhitespace(trailing.replace(/^[-–—]\s*/, ""));
    results.push({
      indexPath: params.indexPath,
      scope: params.scope,
      leafPath: resolvedPath,
      title,
      summary,
    });
  }
  return results;
}

function normalizeMemoryType(value: unknown): MemoryEntryType | null {
  const token = firstNonEmptyString(value).toLowerCase();
  return token === "preference" ||
    token === "identity" ||
    token === "fact" ||
    token === "procedure" ||
    token === "blocker" ||
    token === "reference"
    ? (token as MemoryEntryType)
    : null;
}

function normalizeRecallScope(value: unknown): RecallScope | null {
  const token = firstNonEmptyString(value).toLowerCase();
  return token === "workspace" || token === "preference" || token === "identity"
    ? (token as RecallScope)
    : null;
}

function pathScopedEntries(params: {
  entries: MemoryEntryRecord[];
  workspaceId: string;
}): MemoryEntryRecord[] {
  return params.entries.filter((entry) => entry.scope === "user" || entry.workspaceId === params.workspaceId);
}

function entryByPath(entries: MemoryEntryRecord[]): Map<string, MemoryEntryRecord> {
  const map = new Map<string, MemoryEntryRecord>();
  for (const entry of entries) {
    if (!map.has(entry.path)) {
      map.set(entry.path, entry);
    }
  }
  return map;
}

function eligibleVectorEntries(params: {
  entries: MemoryEntryRecord[];
  workspaceId: string;
}): MemoryEntryRecord[] {
  return params.entries.filter((entry) => {
    if (entry.status !== "active") {
      return false;
    }
    return recallScopeFromPath(entry.path, params.workspaceId) != null;
  });
}

function hasCompleteVectorCoverage(params: {
  eligibleEntries: MemoryEntryRecord[];
  indexes: MemoryEmbeddingIndexRecord[];
  embeddingModelId: string;
}): boolean {
  if (params.eligibleEntries.length === 0) {
    return false;
  }
  if (params.indexes.length !== params.eligibleEntries.length) {
    return false;
  }
  const covered = new Set<string>();
  for (const index of params.indexes) {
    if (index.embeddingModel !== params.embeddingModelId || index.embeddingDim !== RECALL_EMBEDDING_DIM) {
      return false;
    }
    covered.add(index.memoryId);
  }
  return params.eligibleEntries.every((entry) => covered.has(entry.memoryId));
}

async function planRecallFromVectorIndex(params: {
  query: string;
  store: RuntimeStateStore;
  workspaceId: string;
  entries: MemoryEntryRecord[];
  embeddingClient: MemoryModelClientConfig;
}): Promise<PlannedCandidateSelection | null> {
  if (!params.store.supportsVectorIndex()) {
    return null;
  }
  const eligibleEntries = eligibleVectorEntries({
    entries: params.entries,
    workspaceId: params.workspaceId,
  });
  if (eligibleEntries.length === 0) {
    return null;
  }
  const embeddingIndexes = params.store.listMemoryEmbeddingIndexes({
    memoryIds: eligibleEntries.map((entry) => entry.memoryId),
    limit: eligibleEntries.length + 8,
    offset: 0,
  });
  if (!hasCompleteVectorCoverage({
    eligibleEntries,
    indexes: embeddingIndexes,
    embeddingModelId: params.embeddingClient.modelId,
  })) {
    return null;
  }
  const queryEmbedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    input: params.query,
    timeoutMs: 5000,
  });
  if (!queryEmbedding || queryEmbedding.length !== RECALL_EMBEDDING_DIM) {
    return null;
  }
  const workspaceMatches = params.store.searchWorkspaceMemoryRecallVectors({
    workspaceId: params.workspaceId,
    embedding: queryEmbedding,
    limit: VECTOR_WORKSPACE_LIMIT,
  });
  const userMatches = params.store.searchUserMemoryRecallVectors({
    embedding: queryEmbedding,
    limit: VECTOR_USER_LIMIT,
  });
  const eligibleByPath = new Map(eligibleEntries.map((entry) => [entry.path, entry]));
  const mergedByPath = new Map<string, { path: string; distance: number; scope: RecallScope; memoryType: MemoryEntryType }>();
  for (const match of [...workspaceMatches, ...userMatches]) {
    const entry = eligibleByPath.get(match.path);
    if (!entry) {
      continue;
    }
    const scope = recallScopeFromPath(entry.path, params.workspaceId);
    if (!scope) {
      continue;
    }
    const existing = mergedByPath.get(match.path);
    if (!existing || match.distance < existing.distance) {
      mergedByPath.set(match.path, {
        path: match.path,
        distance: match.distance,
        scope,
        memoryType: entry.memoryType,
      });
    }
  }
  const ranked = [...mergedByPath.values()].sort((left, right) => left.distance - right.distance);
  if (ranked.length === 0) {
    return null;
  }
  const primaryPaths = ranked.slice(0, VECTOR_PRIMARY_PATHS).map((entry) => entry.path);
  const reservePaths = ranked
    .slice(VECTOR_PRIMARY_PATHS, VECTOR_PRIMARY_PATHS + VECTOR_RESERVE_PATHS)
    .map((entry) => entry.path);
  const reasonByPath = new Map<string, string>();
  for (const entry of ranked.slice(0, VECTOR_PRIMARY_PATHS + VECTOR_RESERVE_PATHS)) {
    reasonByPath.set(entry.path, `vector_distance:${entry.distance.toFixed(6)}`);
  }
  return {
    shouldRecall: true,
    rewrittenQuery: params.query,
    scopes: [...new Set(ranked.slice(0, VECTOR_PRIMARY_PATHS + VECTOR_RESERVE_PATHS).map((entry) => entry.scope))],
    memoryTypes: [...new Set(ranked.slice(0, VECTOR_PRIMARY_PATHS + VECTOR_RESERVE_PATHS).map((entry) => entry.memoryType))],
    reason: "vector_candidate_retrieval",
    primaryPaths,
    reservePaths,
    reasonByPath,
  };
}

function collectIndexedMemoryRecords(params: {
  workspaceRoot: string;
  workspaceId: string;
  entriesByPath: Map<string, MemoryEntryRecord>;
}): { indexes: IndexFileRecord[]; records: IndexedMemoryRecord[] } {
  const indexes = indexFiles(params.workspaceRoot, params.workspaceId);
  const recordsByPath = new Map<string, IndexedMemoryRecord>();
  for (const indexFile of indexes) {
    if (!indexFile.exists || indexFile.scope === "root") {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(indexFile.absPath, "utf8");
    } catch {
      continue;
    }
    const parsedLinks = parseScopedIndexLinks({
      content: raw,
      indexPath: indexFile.path,
      scope: indexFile.scope,
      workspaceId: params.workspaceId,
    });
    for (const parsedLink of parsedLinks) {
      const persisted = params.entriesByPath.get(parsedLink.leafPath) ?? null;
      const inferredType = typeFromPath(parsedLink.leafPath);
      const inferredGovernance = governanceRuleForMemoryType(persisted?.memoryType ?? inferredType);
      const record: IndexedMemoryRecord = {
        indexPath: parsedLink.indexPath,
        scope: parsedLink.scope,
        path: parsedLink.leafPath,
        title: firstNonEmptyString(parsedLink.title, persisted?.title, path.basename(parsedLink.leafPath, ".md")),
        summary: firstNonEmptyString(parsedLink.summary, persisted?.summary, "No summary available."),
        memoryType: persisted?.memoryType ?? inferredType,
        tags: persisted?.tags ?? [],
        verificationPolicy: persisted?.verificationPolicy ?? inferredGovernance.verificationPolicy,
        updatedAt: persisted?.updatedAt ?? new Date(0).toISOString(),
      };
      const existing = recordsByPath.get(record.path);
      if (!existing) {
        recordsByPath.set(record.path, record);
        continue;
      }
      const existingTime = Date.parse(existing.updatedAt);
      const nextTime = Date.parse(record.updatedAt);
      if (Number.isFinite(nextTime) && (!Number.isFinite(existingTime) || nextTime > existingTime)) {
        recordsByPath.set(record.path, record);
      }
    }
  }
  return {
    indexes,
    records: indexedMemorySort([...recordsByPath.values()]).slice(0, MAX_INDEX_ENTRIES),
  };
}

function scopeSummaries(records: IndexedMemoryRecord[], indexes: IndexFileRecord[]): Array<Record<string, unknown>> {
  return ["workspace", "preference", "identity"].map((scopeToken) => {
    const scope = scopeToken as RecallScope;
    const scoped = records.filter((record) => record.scope === scope);
    const countsByType: Record<string, number> = {};
    for (const record of scoped) {
      countsByType[record.memoryType] = (countsByType[record.memoryType] ?? 0) + 1;
    }
    const indexRecord = indexes.find((entry) => entry.scope === scope) ?? null;
    return {
      scope,
      index_path: indexRecord?.path ?? null,
      index_exists: indexRecord?.exists ?? false,
      entry_count: scoped.length,
      counts_by_type: countsByType,
      sample_titles: scoped.slice(0, MAX_SCOPE_SAMPLE_TITLES).map((record) => record.title),
    };
  });
}

async function planRecallAndSelectCandidates(params: {
  query: string;
  indexes: IndexFileRecord[];
  records: IndexedMemoryRecord[];
  modelClient: MemoryModelClientConfig;
}): Promise<PlannedCandidateSelection | null> {
  if (params.records.length === 0) {
    return null;
  }
  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt:
      "Plan durable memory recall and nominate candidate leaf files from the provided index entries. Return strict JSON only: " +
      '{"should_recall":true,"rewritten_query":"string","scopes":["workspace|preference|identity"],"memory_types":["preference|identity|fact|procedure|blocker|reference"],"reason":"string","primary_paths":["path"],"reserve_paths":["path"],"reason_by_path":{"path":"reason"}}. ' +
      `Choose at most ${MAX_PRIMARY_PATHS} primary paths and at most ${MAX_RESERVE_PATHS} reserve paths. Only return paths from the provided entries. Only include scopes that exist in the provided summaries.`,
    userPrompt: [
      JSON.stringify(
        {
          request: params.query,
          available_scopes: scopeSummaries(params.records, params.indexes),
        },
        null,
        2
      ),
      "",
      "Index entries (JSONL):",
      ...params.records.map((record) =>
        JSON.stringify({
          path: record.path,
          index_path: record.indexPath,
          scope: record.scope,
          memory_type: record.memoryType,
          title: record.title,
          summary: record.summary,
          tags: record.tags,
          verification_policy: record.verificationPolicy,
          updated_at: record.updatedAt,
        })
      ),
    ].join("\n"),
    timeoutMs: PLAN_AND_CANDIDATE_TIMEOUT_MS,
  });
  if (!payload) {
    return null;
  }

  const shouldRecall = payload.should_recall !== false;
  const rewrittenQuery = firstNonEmptyString(payload.rewritten_query, params.query);
  const scopes = normalizedStringArray(payload.scopes)
    .map((value) => normalizeRecallScope(value))
    .filter((value): value is RecallScope => value != null);
  const memoryTypes = normalizedStringArray(payload.memory_types)
    .map((value) => normalizeMemoryType(value))
    .filter((value): value is MemoryEntryType => value != null);
  const scopedRecords = params.records.filter((record) =>
    (scopes.length === 0 || scopes.includes(record.scope)) &&
    (memoryTypes.length === 0 || memoryTypes.includes(record.memoryType))
  );
  const candidateRecords = scopedRecords.length > 0 ? scopedRecords : params.records;
  const allowedPaths = new Set(candidateRecords.map((record) => record.path));
  const reasonByPath = new Map<string, string>();
  const primaryPaths: string[] = [];
  const reservePaths: string[] = [];
  const reasonPayload = isRecord(payload.reason_by_path) ? payload.reason_by_path : {};

  for (const candidate of normalizedStringArray(payload.primary_paths)) {
    if (!allowedPaths.has(candidate) || primaryPaths.includes(candidate)) {
      continue;
    }
    primaryPaths.push(candidate);
    reasonByPath.set(candidate, firstNonEmptyString(reasonPayload[candidate], "selected_from_index"));
    if (primaryPaths.length >= MAX_PRIMARY_PATHS) {
      break;
    }
  }

  for (const candidate of normalizedStringArray(payload.reserve_paths)) {
    if (!allowedPaths.has(candidate) || primaryPaths.includes(candidate) || reservePaths.includes(candidate)) {
      continue;
    }
    reservePaths.push(candidate);
    reasonByPath.set(candidate, firstNonEmptyString(reasonPayload[candidate], "selected_as_reserve"));
    if (reservePaths.length >= MAX_RESERVE_PATHS) {
      break;
    }
  }

  if (shouldRecall && primaryPaths.length === 0) {
    return null;
  }

  return {
    shouldRecall,
    rewrittenQuery,
    scopes,
    memoryTypes,
    reason: firstNonEmptyString(
      payload.reason,
      shouldRecall ? "durable_memory_recall_needed" : "durable_memory_recall_not_needed"
    ),
    primaryPaths,
    reservePaths,
    reasonByPath,
  };
}

function readLeafMemoryRecord(params: {
  workspaceRoot: string;
  workspaceId: string;
  relPath: string;
}): LeafMemoryRecord | null {
  const recallScope = recallScopeFromPath(params.relPath, params.workspaceId);
  if (!recallScope) {
    return null;
  }
  const absPath = resolveMemoryAbsolutePath({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
    relPath: params.relPath,
  });
  if (!fs.existsSync(absPath)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = frontmatterMetadata(frontmatterBlock(raw));
  const content = contentWithoutFrontmatter(raw);
  const stat = fs.statSync(absPath, { throwIfNoEntry: false });
  const updatedAt = stat?.mtime?.toISOString?.() ?? new Date().toISOString();
  const title = firstNonEmptyString(frontmatter.title, firstHeading(content), path.basename(params.relPath, ".md"));
  const summary = firstNonEmptyString(frontmatter.summary, firstSummaryLine(content), "No summary available.");
  return {
    path: params.relPath,
    absPath,
    scope: frontmatter.scope ?? scopeFromPath(params.relPath, params.workspaceId),
    memoryType: frontmatter.memoryType ?? typeFromPath(params.relPath),
    title,
    summary,
    updatedAt,
    excerpt: snippetFromContent(content),
  };
}

function readLeafMemoryRecords(params: {
  workspaceRoot: string;
  workspaceId: string;
  paths: string[];
}): LeafMemoryRecord[] {
  const records: LeafMemoryRecord[] = [];
  const seen = new Set<string>();
  for (const relPath of params.paths) {
    if (seen.has(relPath)) {
      continue;
    }
    seen.add(relPath);
    const record = readLeafMemoryRecord({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      relPath,
    });
    if (record) {
      records.push(record);
    }
  }
  return records;
}

async function finalizeSelection(params: {
  query: string;
  plan: RecallPlan;
  openedLeaves: LeafMemoryRecord[];
  reserveRecords: IndexedMemoryRecord[];
  modelClient: MemoryModelClientConfig;
  allowExpand: boolean;
  maxEntries: number;
}): Promise<FinalizedSelection | null> {
  if (params.openedLeaves.length === 0) {
    return null;
  }
  const openedPaths = new Set(params.openedLeaves.map((record) => record.path));
  const reservePaths = new Set(params.reserveRecords.map((record) => record.path));
  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt:
      "Finalize durable memory recall from the opened leaf files. Return strict JSON only: " +
      '{"status":"sufficient|expand_once|none","final_paths":["path"],"expansion_paths":["path"],"reason_by_path":{"path":"reason"}}. ' +
      `Only return opened paths in final_paths. Only return reserve candidate paths in expansion_paths. Select at most ${Math.max(1, params.maxEntries)} final paths. ` +
      (params.allowExpand ? "Use expand_once only if the opened leaves are insufficient and reserve candidates are needed." : "Expansion is not allowed in this pass."),
    userPrompt: JSON.stringify(
      {
        request: params.query,
        rewritten_query: params.plan.rewrittenQuery,
        plan_reason: params.plan.reason,
        opened_leaves: params.openedLeaves.map((record) => ({
          path: record.path,
          scope: record.scope,
          memory_type: record.memoryType,
          title: record.title,
          summary: record.summary,
          updated_at: record.updatedAt,
          excerpt: record.excerpt,
        })),
        reserve_candidates: params.reserveRecords.map((record) => ({
          path: record.path,
          scope: record.scope,
          memory_type: record.memoryType,
          title: record.title,
          summary: record.summary,
        })),
        allow_expand: params.allowExpand,
      },
      null,
      2
    ),
    timeoutMs: FINALIZE_TIMEOUT_MS,
  });
  if (!payload) {
    return null;
  }

  const statusToken = firstNonEmptyString(payload.status).toLowerCase();
  const status: RecallStatus =
    statusToken === "expand_once" ? "expand_once" : statusToken === "none" ? "none" : "sufficient";
  const reasonPayload = isRecord(payload.reason_by_path) ? payload.reason_by_path : {};
  const finalPaths: string[] = [];
  const expansionPaths: string[] = [];
  const reasonByPath = new Map<string, string>();

  for (const candidate of normalizedStringArray(payload.final_paths)) {
    if (!openedPaths.has(candidate) || finalPaths.includes(candidate)) {
      continue;
    }
    finalPaths.push(candidate);
    reasonByPath.set(candidate, firstNonEmptyString(reasonPayload[candidate], "selected_after_leaf_review"));
    if (finalPaths.length >= Math.max(1, params.maxEntries)) {
      break;
    }
  }

  for (const candidate of normalizedStringArray(payload.expansion_paths)) {
    if (!reservePaths.has(candidate) || expansionPaths.includes(candidate)) {
      continue;
    }
    expansionPaths.push(candidate);
    reasonByPath.set(candidate, firstNonEmptyString(reasonPayload[candidate], "expand_from_reserve"));
    if (expansionPaths.length >= MAX_RESERVE_PATHS) {
      break;
    }
  }

  if (status === "expand_once" && (!params.allowExpand || expansionPaths.length === 0)) {
    return null;
  }

  return {
    status,
    finalPaths,
    expansionPaths,
    reasonByPath,
  };
}

export async function recalledMemoryContextFromManifest(params: {
  query: string;
  workspaceRoot: string;
  workspaceId: string;
  entries: MemoryEntryRecord[];
  store?: RuntimeStateStore | null;
  maxEntries?: number;
  nowIso?: string | null;
  modelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<AgentRecalledMemoryContext | null> {
  const maxEntries = Math.max(1, params.maxEntries ?? 5);
  if (!params.modelClient) {
    return null;
  }

  const scopedEntries = pathScopedEntries({
    entries: params.entries.filter((entry) => entry.status === "active"),
    workspaceId: params.workspaceId,
  });
  const entriesByPath = entryByPath(scopedEntries);
  const vectorPlanAndCandidates =
    params.store && params.embeddingClient
      ? await planRecallFromVectorIndex({
          query: params.query,
          store: params.store,
          workspaceId: params.workspaceId,
          entries: scopedEntries,
          embeddingClient: params.embeddingClient,
        })
      : null;
  if (vectorPlanAndCandidates) {
    const openedLeaves = readLeafMemoryRecords({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      paths: vectorPlanAndCandidates.primaryPaths,
    });
    if (openedLeaves.length > 0) {
      const reserveRecords = vectorPlanAndCandidates.reservePaths
        .map((pathValue) => {
          const persisted = entriesByPath.get(pathValue);
          if (!persisted) {
            return null;
          }
          const inferredGovernance = governanceRuleForMemoryType(persisted.memoryType);
          return {
            indexPath: "vector_index",
            scope: recallScopeFromPath(pathValue, params.workspaceId) ?? "workspace",
            path: pathValue,
            title: persisted.title,
            summary: persisted.summary,
            memoryType: persisted.memoryType,
            tags: persisted.tags,
            verificationPolicy: persisted.verificationPolicy ?? inferredGovernance.verificationPolicy,
            updatedAt: persisted.updatedAt,
          } satisfies IndexedMemoryRecord;
        })
        .filter((record): record is IndexedMemoryRecord => record != null);
      let finalSelection = await finalizeSelection({
        query: params.query,
        plan: vectorPlanAndCandidates,
        openedLeaves,
        reserveRecords,
        modelClient: params.modelClient,
        allowExpand: reserveRecords.length > 0,
        maxEntries,
      });
      let combinedLeaves = openedLeaves;
      if (finalSelection?.status === "expand_once" && finalSelection.expansionPaths.length > 0) {
        const expandedLeaves = readLeafMemoryRecords({
          workspaceRoot: params.workspaceRoot,
          workspaceId: params.workspaceId,
          paths: finalSelection.expansionPaths,
        });
        if (expandedLeaves.length > 0) {
          const byPath = new Map<string, LeafMemoryRecord>();
          for (const record of [...openedLeaves, ...expandedLeaves]) {
            byPath.set(record.path, record);
          }
          combinedLeaves = [...byPath.values()];
          finalSelection = await finalizeSelection({
            query: params.query,
            plan: vectorPlanAndCandidates,
            openedLeaves: combinedLeaves,
            reserveRecords: [],
            modelClient: params.modelClient,
            allowExpand: false,
            maxEntries,
          });
        }
      }
      if (finalSelection && finalSelection.status !== "none" && finalSelection.finalPaths.length > 0) {
        const leafByPath = new Map(combinedLeaves.map((record) => [record.path, record]));
        const entries: NonNullable<AgentRecalledMemoryContext["entries"]> = [];
        const traces: NonNullable<AgentRecalledMemoryContext["selection_trace"]> = [];
        for (const [index, selectedPath] of finalSelection.finalPaths.slice(0, maxEntries).entries()) {
          const leaf = leafByPath.get(selectedPath);
          if (!leaf) {
            continue;
          }
          const persisted = entriesByPath.get(selectedPath) ?? null;
          const inferredGovernance = governanceRuleForMemoryType(persisted?.memoryType ?? leaf.memoryType);
          const freshness = assessMemoryFreshness(
            {
              memoryType: persisted?.memoryType ?? leaf.memoryType,
              verificationPolicy: persisted?.verificationPolicy ?? inferredGovernance.verificationPolicy,
              stalenessPolicy: persisted?.stalenessPolicy ?? inferredGovernance.stalenessPolicy,
              staleAfterSeconds: persisted?.staleAfterSeconds ?? inferredGovernance.staleAfterSeconds,
              updatedAt: persisted?.updatedAt ?? leaf.updatedAt,
            },
            params.nowIso ?? null
          );
          entries.push({
            scope: persisted?.scope ?? leaf.scope,
            memory_type: persisted?.memoryType ?? leaf.memoryType,
            title: firstNonEmptyString(persisted?.title, leaf.title, selectedPath),
            summary: firstNonEmptyString(persisted?.summary, leaf.summary, "No summary available."),
            path: selectedPath,
            verification_policy: persisted?.verificationPolicy ?? inferredGovernance.verificationPolicy,
            staleness_policy: persisted?.stalenessPolicy ?? inferredGovernance.stalenessPolicy,
            freshness_state: freshness.state,
            freshness_note: freshness.note,
            source_type: persisted?.sourceType ?? null,
            observed_at: persisted?.observedAt ?? null,
            last_verified_at: persisted?.lastVerifiedAt ?? null,
            confidence: persisted?.confidence ?? null,
            updated_at: persisted?.updatedAt ?? leaf.updatedAt,
            excerpt: leaf.excerpt || null,
          });
          traces.push({
            memory_id: persisted?.memoryId ?? `memory:${selectedPath}`,
            score: Math.max(0.1, 1 - index * 0.1),
            freshness_state: freshness.state,
            matched_tokens: [],
            reasons: [
              `plan:${vectorPlanAndCandidates.reason}`,
              `candidate:${vectorPlanAndCandidates.reasonByPath.get(selectedPath) ?? "vector_candidate_retrieval"}`,
              `final:${finalSelection.reasonByPath.get(selectedPath) ?? "selected_after_leaf_review"}`,
            ],
            source_type: persisted?.sourceType ?? "manual",
          });
        }
        if (entries.length > 0) {
          return {
            entries,
            selection_trace: traces,
          };
        }
      }
    }
  }

  const { indexes, records } = collectIndexedMemoryRecords({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
    entriesByPath,
  });
  if (records.length === 0) {
    return null;
  }

  const planAndCandidates = await planRecallAndSelectCandidates({
    query: params.query,
    indexes,
    records,
    modelClient: params.modelClient,
  });
  if (!planAndCandidates || !planAndCandidates.shouldRecall) {
    return null;
  }

  if (planAndCandidates.primaryPaths.length === 0) {
    return null;
  }

  const openedLeaves = readLeafMemoryRecords({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
    paths: planAndCandidates.primaryPaths,
  });
  if (openedLeaves.length === 0) {
    return null;
  }

  const reserveRecords = records.filter((record) => planAndCandidates.reservePaths.includes(record.path));
  let finalSelection = await finalizeSelection({
    query: params.query,
    plan: planAndCandidates,
    openedLeaves,
    reserveRecords,
    modelClient: params.modelClient,
    allowExpand: reserveRecords.length > 0,
    maxEntries,
  });
  let combinedLeaves = openedLeaves;

  if (finalSelection?.status === "expand_once" && finalSelection.expansionPaths.length > 0) {
    const expandedLeaves = readLeafMemoryRecords({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      paths: finalSelection.expansionPaths,
    });
    if (expandedLeaves.length === 0) {
      return null;
    }
    const byPath = new Map<string, LeafMemoryRecord>();
    for (const record of [...openedLeaves, ...expandedLeaves]) {
      byPath.set(record.path, record);
    }
    combinedLeaves = [...byPath.values()];
    finalSelection = await finalizeSelection({
      query: params.query,
      plan: planAndCandidates,
      openedLeaves: combinedLeaves,
      reserveRecords: [],
      modelClient: params.modelClient,
      allowExpand: false,
      maxEntries,
    });
  }

  if (!finalSelection || finalSelection.status === "none" || finalSelection.finalPaths.length === 0) {
    return null;
  }

  const leafByPath = new Map(combinedLeaves.map((record) => [record.path, record]));
  const candidateReasons = planAndCandidates.reasonByPath;
  const finalReasons = finalSelection.reasonByPath;
  const entries: NonNullable<AgentRecalledMemoryContext["entries"]> = [];
  const traces: NonNullable<AgentRecalledMemoryContext["selection_trace"]> = [];

  for (const [index, selectedPath] of finalSelection.finalPaths.slice(0, maxEntries).entries()) {
    const leaf = leafByPath.get(selectedPath);
    if (!leaf) {
      continue;
    }
    const persisted = entriesByPath.get(selectedPath) ?? null;
    const inferredGovernance = governanceRuleForMemoryType(persisted?.memoryType ?? leaf.memoryType);
    const freshness = assessMemoryFreshness(
      {
        memoryType: persisted?.memoryType ?? leaf.memoryType,
        verificationPolicy: persisted?.verificationPolicy ?? inferredGovernance.verificationPolicy,
        stalenessPolicy: persisted?.stalenessPolicy ?? inferredGovernance.stalenessPolicy,
        staleAfterSeconds: persisted?.staleAfterSeconds ?? inferredGovernance.staleAfterSeconds,
        updatedAt: persisted?.updatedAt ?? leaf.updatedAt,
      },
      params.nowIso ?? null
    );
    entries.push({
      scope: persisted?.scope ?? leaf.scope,
      memory_type: persisted?.memoryType ?? leaf.memoryType,
      title: firstNonEmptyString(persisted?.title, leaf.title, selectedPath),
      summary: firstNonEmptyString(persisted?.summary, leaf.summary, "No summary available."),
      path: selectedPath,
      verification_policy: persisted?.verificationPolicy ?? inferredGovernance.verificationPolicy,
      staleness_policy: persisted?.stalenessPolicy ?? inferredGovernance.stalenessPolicy,
      freshness_state: freshness.state,
      freshness_note: freshness.note,
      source_type: persisted?.sourceType ?? null,
      observed_at: persisted?.observedAt ?? null,
      last_verified_at: persisted?.lastVerifiedAt ?? null,
      confidence: persisted?.confidence ?? null,
      updated_at: persisted?.updatedAt ?? leaf.updatedAt,
      excerpt: leaf.excerpt || null,
    });
    traces.push({
      memory_id: persisted?.memoryId ?? `memory:${selectedPath}`,
      score: Math.max(0.1, 1 - index * 0.1),
      freshness_state: freshness.state,
      matched_tokens: [],
      reasons: [
        `plan:${planAndCandidates.reason}`,
        `candidate:${candidateReasons.get(selectedPath) ?? "selected_from_index"}`,
        `final:${finalReasons.get(selectedPath) ?? "selected_after_leaf_review"}`,
      ],
      source_type: persisted?.sourceType ?? "manual",
    });
  }

  if (entries.length === 0) {
    return null;
  }

  return {
    entries,
    selection_trace: traces,
  };
}
