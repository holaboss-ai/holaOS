import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OutputRecord, RuntimeStateStore, TurnResultRecord } from "@holaboss/runtime-state-store";
import type ExcelJSNamespace from "exceljs";
import JSZip from "jszip";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

import {
  appendDurableMemoryRelatedSections,
  canonicalizeDurableMemoryRelatedInfo,
  extractDurableMemoryRelatedInfo,
  parseDurableMemoryRelatedInfo,
  stripDurableMemoryRelatedSections,
  type DurableMemoryRelatedInfo,
} from "./memory-related-entities.js";
import type { DurableMemoryArtifactContext } from "./memory-artifact-context.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import {
  queryMemoryModelEmbedding,
  queryMemoryModelVisionJson,
} from "./memory-model-client.js";
import type { TurnInputAttachment, TurnIntegrationToolEvidenceEntry } from "./turn-semantic-artifacts.js";
import {
  attachmentPreviewText,
  inputAttachmentsForTurn,
  integrationToolEvidenceEntriesFromTurnArtifacts,
} from "./turn-semantic-artifacts.js";
import {
  buildWorkspaceRelatedEntityResolver,
  type WorkspaceRelatedEntityResolver,
} from "./workspace-related-entity-resolver.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";
import {
  canonicalAttachmentArtifactEntityKey,
  canonicalImageUrlArtifactEntityKey,
  canonicalOutputArtifactEntityKey,
  canonicalToolResultArtifactEntityKey,
  legacyRelatedEntityKey,
} from "./workspace-related-entity-keys.js";

export const ATTACHMENT_DOCUMENT_NODE_KIND = "attachment_document";
export const ATTACHMENT_CHUNK_NODE_KIND = "attachment_chunk";
export const TOOL_RESULT_DOCUMENT_NODE_KIND = "tool_result_document";
export const TOOL_RESULT_CHUNK_NODE_KIND = "tool_result_chunk";
export const OUTPUT_DOCUMENT_NODE_KIND = "output_document";
export const OUTPUT_CHUNK_NODE_KIND = "output_chunk";
export const IMAGE_URL_DOCUMENT_NODE_KIND = "image_url_document";
export const IMAGE_URL_CHUNK_NODE_KIND = "image_url_chunk";
const WORKSPACE_ARTIFACT_RELATION_BACKFILL_KEY = "workspace_artifact_relation_backfill_v1_complete";
const WORKSPACE_ARTIFACT_RELATION_BACKFILL_V2_KEY = "workspace_artifact_relation_backfill_v2_complete";
const WORKSPACE_ARTIFACT_SOURCE_TURN_INPUT_POSITION_BACKFILL_KEY =
  "workspace_artifact_source_turn_input_position_backfill_v1_complete";
const WORKSPACE_TOOL_RESULT_ARTIFACT_TREE_BACKFILL_KEY = "workspace_tool_result_artifact_tree_backfill_v1_complete";
const WORKSPACE_ATTACHMENT_ARTIFACT_TREE_BACKFILL_KEY = "workspace_attachment_artifact_tree_backfill_v1_complete";
const WORKSPACE_IMAGE_URL_ARTIFACT_TREE_BACKFILL_KEY = "workspace_image_url_artifact_tree_backfill_v1_complete";

type ExcelJSWorkbook = ExcelJSNamespace.Workbook;
type ExcelJSWorksheet = ExcelJSNamespace.Worksheet;
type ExcelJSCell = ExcelJSNamespace.Cell;

interface ExcelJSModule {
  Workbook: new () => ExcelJSWorkbook;
}

const nodeRequire = createRequire(import.meta.url);
const ExcelJS = nodeRequire("exceljs") as ExcelJSModule;

const MACOS_VISION_OCR_SWIFT_SOURCE = String.raw`
import Foundation
import ImageIO
import Vision

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)
var recognized: [String] = []

let request = VNRecognizeTextRequest { request, error in
  if let error {
    fputs("error: \(error)\n", stderr)
    return
  }
  let observations = request.results as? [VNRecognizedTextObservation] ?? []
  for observation in observations {
    if let candidate = observation.topCandidates(1).first {
      let value = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if !value.isEmpty {
        recognized.append(value)
      }
    }
  }
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(url: imageURL, orientation: .up, options: [:])
try handler.perform([request])
print(recognized.joined(separator: "\n"))
`;
const WORKSPACE_OUTPUT_ARTIFACT_TREE_BACKFILL_KEY = "workspace_output_artifact_tree_backfill_v1_complete";

export function workspaceArtifactBackfillStateToken(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): string | null {
  if (typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function") {
    return null;
  }
  const readFlag = (key: string): "1" | "0" =>
    params.store.getWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key,
    }) === "true"
      ? "1"
      : "0";
  return [
    `relations:${readFlag(WORKSPACE_ARTIFACT_RELATION_BACKFILL_V2_KEY)}`,
    `source_positions:${readFlag(WORKSPACE_ARTIFACT_SOURCE_TURN_INPUT_POSITION_BACKFILL_KEY)}`,
    `tool_results:${readFlag(WORKSPACE_TOOL_RESULT_ARTIFACT_TREE_BACKFILL_KEY)}`,
    `attachments:${readFlag(WORKSPACE_ATTACHMENT_ARTIFACT_TREE_BACKFILL_KEY)}`,
    `image_urls:${readFlag(WORKSPACE_IMAGE_URL_ARTIFACT_TREE_BACKFILL_KEY)}`,
    `outputs:${readFlag(WORKSPACE_OUTPUT_ARTIFACT_TREE_BACKFILL_KEY)}`,
  ].join("|");
}

type AttachmentChunk = {
  index: number;
  content: string;
  summary: string;
};

export interface WorkspaceAttachmentDocumentTreeDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  attachmentId: string;
  kind: "file" | "image" | "folder";
  mimeType: string;
  workspacePath: string;
  observedAt: string;
  path: string;
  sourceTurnInputId: string | null;
  sourceTurnInputPosition: number | null;
}

export interface WorkspaceToolResultDocumentTreeDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  providerId: string;
  accountNamespace: string;
  connectionId: string | null;
  toolName: string;
  toolId: string | null;
  callId: string | null;
  outputEventId: number | null;
  observedAt: string;
  path: string;
  sourceSessionId: string | null;
  sourceTurnInputId: string | null;
}

export interface WorkspaceOutputDocumentTreeDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  outputId: string;
  outputType: string;
  filePath: string | null;
  artifactId: string | null;
  platform: string | null;
  moduleId: string | null;
  moduleResourceId: string | null;
  forwardedOutputId: string | null;
  originType: string | null;
  sourceEventId: string | null;
  sourceSubagentId: string | null;
  observedAt: string;
  path: string;
  sourceTurnInputId: string | null;
}

export interface WorkspaceImageUrlDocumentTreeDescriptor {
  treeId: string;
  rootNodeId: string;
  title: string;
  imageUrl: string;
  mimeType: string | null;
  observedAt: string;
  path: string;
  sourceTurnInputId: string | null;
  sourceTurnInputPosition: number | null;
}

function workspaceRelatedEntityResolver(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  attachmentDescriptors?: WorkspaceAttachmentDocumentTreeDescriptor[];
  imageUrlDescriptors?: WorkspaceImageUrlDocumentTreeDescriptor[];
  toolResultDescriptors?: WorkspaceToolResultDocumentTreeDescriptor[];
  outputDescriptors?: WorkspaceOutputDocumentTreeDescriptor[];
}): WorkspaceRelatedEntityResolver {
  return buildWorkspaceRelatedEntityResolver({
    interactionEntities: params.store.listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    }),
    attachmentTargets: params.attachmentDescriptors
      ?? listWorkspaceAttachmentDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }),
    imageUrlTargets: params.imageUrlDescriptors
      ?? listWorkspaceImageUrlDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }),
    toolResultTargets: params.toolResultDescriptors
      ?? listWorkspaceToolResultDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }),
    outputTargets: params.outputDescriptors
      ?? listWorkspaceOutputDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }),
  });
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function artifactContextPriority(sourceKind: DurableMemoryArtifactContext["sourceKind"]): number {
  switch (sourceKind) {
    case "output_artifact":
      return 0;
    case "tool_result":
      return 1;
    case "attachment":
      return 2;
    case "image_url":
      return 3;
    default:
      return 4;
  }
}

function outputArtifactContextDescriptorPriority(descriptor: WorkspaceOutputDocumentTreeDescriptor): number {
  if (descriptor.originType === "forwarded_subagent") {
    return 0;
  }
  return 1;
}

function compareOutputArtifactContextDescriptors(
  left: WorkspaceOutputDocumentTreeDescriptor,
  right: WorkspaceOutputDocumentTreeDescriptor,
): number {
  return outputArtifactContextDescriptorPriority(left) - outputArtifactContextDescriptorPriority(right)
    || right.observedAt.localeCompare(left.observedAt)
    || left.title.localeCompare(right.title)
    || (left.filePath ?? "").localeCompare(right.filePath ?? "")
    || left.treeId.localeCompare(right.treeId);
}

function compareToolResultArtifactContextDescriptors(
  left: WorkspaceToolResultDocumentTreeDescriptor,
  right: WorkspaceToolResultDocumentTreeDescriptor,
): number {
  const leftEvent = left.outputEventId ?? Number.NEGATIVE_INFINITY;
  const rightEvent = right.outputEventId ?? Number.NEGATIVE_INFINITY;
  return rightEvent - leftEvent
    || right.observedAt.localeCompare(left.observedAt)
    || (right.callId ?? "").localeCompare(left.callId ?? "")
    || left.toolName.localeCompare(right.toolName)
    || left.accountNamespace.localeCompare(right.accountNamespace)
    || left.treeId.localeCompare(right.treeId);
}

function compareAttachmentArtifactContextDescriptors(
  left: WorkspaceAttachmentDocumentTreeDescriptor,
  right: WorkspaceAttachmentDocumentTreeDescriptor,
): number {
  return (left.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY)
      - (right.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY)
    || right.observedAt.localeCompare(left.observedAt)
    || left.title.localeCompare(right.title)
    || left.workspacePath.localeCompare(right.workspacePath)
    || left.treeId.localeCompare(right.treeId);
}

function compareImageUrlArtifactContextDescriptors(
  left: WorkspaceImageUrlDocumentTreeDescriptor,
  right: WorkspaceImageUrlDocumentTreeDescriptor,
): number {
  return (left.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY)
      - (right.sourceTurnInputPosition ?? Number.POSITIVE_INFINITY)
    || right.observedAt.localeCompare(left.observedAt)
    || left.title.localeCompare(right.title)
    || left.imageUrl.localeCompare(right.imageUrl)
    || left.treeId.localeCompare(right.treeId);
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

function stripHtmlLikeText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyRelatedInfo(): DurableMemoryRelatedInfo {
  return {
    relatedEntities: [],
    relations: [],
  };
}

function artifactRelatedExtractionContent(params: {
  rootBody: string;
  extractedText?: string | null;
}): string {
  const extractedText = (params.extractedText ?? "").trim();
  if (!extractedText) {
    return params.rootBody;
  }
  return [
    params.rootBody.trim(),
    "",
    "## Extracted Content",
    "",
    extractedText.slice(0, 6_000),
    "",
  ].join("\n");
}

async function extractArtifactDocumentRelatedInfo(params: {
  modelClient?: MemoryModelClientConfig | null;
  subjectKey: string;
  title: string;
  summary: string;
  content: string;
  tags?: string[] | null;
  resolver?: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): Promise<DurableMemoryRelatedInfo> {
  if (!params.modelClient) {
    return emptyRelatedInfo();
  }
  return await extractDurableMemoryRelatedInfo({
    modelClient: params.modelClient,
    memoryType: "artifact_document",
    subjectKey: params.subjectKey,
    title: params.title,
    summary: params.summary,
    content: params.content,
    tags: params.tags ?? [],
    artifactContexts: params.artifactContexts ?? null,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
  });
}

function artifactDocumentRelations(params: {
  workspaceId: string;
  treeId: string;
  rootNodeId: string;
  relatedInfo: DurableMemoryRelatedInfo;
  resolver?: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): Array<{
  workspaceId: string;
  category: "workspace";
  treeId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
}> {
  const normalizedRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: params.relatedInfo,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  const entityByKey = new Map(
    normalizedRelatedInfo.relatedEntities.map((entity) => [entity.entityKey, entity] as const),
  );
  return normalizedRelatedInfo.relations.flatMap((relation) => {
    const entity = entityByKey.get(relation.entityKey);
    if (!entity) {
      return [];
    }
    const resolved = params.resolver?.resolve({
      entityType: entity.entityType,
      entityKey: entity.entityKey,
      label: entity.label,
      sourceTurnInputId: params.sourceTurnInputId ?? null,
    }) ?? null;
    return [{
      workspaceId: params.workspaceId,
      category: "workspace" as const,
      treeId: params.treeId,
      fromNodeId: params.rootNodeId,
      toNodeId: resolved?.targetNodeId ?? `semantic:related:${entity.entityKey}`,
      relationType: relation.relationType,
      metadata: {
        entity_key: resolved?.entityKey ?? entity.entityKey,
        entity_label: resolved?.label ?? entity.label,
        entity_type: resolved?.entityType ?? entity.entityType,
        target_tree_id: resolved?.targetTreeId ?? null,
        target_node_id: resolved?.targetNodeId ?? null,
        resolved_target_kind: resolved?.targetTreeId && resolved?.targetNodeId ? "resolved" : "synthetic",
      },
    }];
  });
}

function artifactDocumentRelationsFromStoredPath(params: {
  store: RuntimeStateStore;
  workspaceDir: string;
  workspaceId: string;
  treeId: string;
  rootNodeId: string;
  path: string;
  observedAt?: string | null;
  resolver?: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): Array<{
  workspaceId: string;
  category: "workspace";
  treeId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}> {
  const relatedInfo = syncStoredArtifactRootDocument({
    store: params.store,
    workspaceDir: params.workspaceDir,
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    rootNodeId: params.rootNodeId,
    path: params.path,
    observedAt: params.observedAt ?? null,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  const observedAt = params.observedAt ?? new Date().toISOString();
  return artifactDocumentRelations({
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    rootNodeId: params.rootNodeId,
    relatedInfo,
    artifactContexts: params.artifactContexts ?? null,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
  }).map((relation) => ({
    ...relation,
    createdAt: observedAt,
    updatedAt: observedAt,
  }));
}

function syncStoredArtifactRootDocument(params: {
  store: RuntimeStateStore;
  workspaceDir: string;
  workspaceId: string;
  treeId: string;
  rootNodeId: string;
  path: string;
  observedAt?: string | null;
  resolver?: WorkspaceRelatedEntityResolver | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): DurableMemoryRelatedInfo {
  const absolutePath = absolutePathForRelative(params.workspaceDir, params.path);
  if (!fs.existsSync(absolutePath)) {
    return emptyRelatedInfo();
  }
  const originalBody = fs.readFileSync(absolutePath, "utf8");
  const parsedRelatedInfo = parseDurableMemoryRelatedInfo(originalBody);
  const canonicalRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: parsedRelatedInfo,
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  const strippedBody = stripDurableMemoryRelatedSections(originalBody).trimEnd();
  const nextBody = canonicalRelatedInfo.relatedEntities.length > 0 || canonicalRelatedInfo.relations.length > 0
    ? appendDurableMemoryRelatedSections(strippedBody, canonicalRelatedInfo)
    : `${strippedBody}\n`;
  if (nextBody !== originalBody) {
    writeFileIfChanged(absolutePath, nextBody);
  }
  const rootNode = params.store.getSemanticMemoryNode({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    nodeId: params.rootNodeId,
  });
  if (rootNode) {
    const rootMetadata = rootNode.metadata && typeof rootNode.metadata === "object" && !Array.isArray(rootNode.metadata)
      ? { ...rootNode.metadata as Record<string, unknown> }
      : {};
    rootMetadata.related_entity_keys = canonicalRelatedInfo.relatedEntities.map((entity) => entity.entityKey);
    rootMetadata.relation_types = [...new Set(canonicalRelatedInfo.relations.map((relation) => relation.relationType))];
    params.store.upsertSemanticMemoryNode({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      nodeId: rootNode.nodeId,
      nodeClass: rootNode.nodeClass,
      nodeKind: rootNode.nodeKind,
      sourceLeafId: rootNode.sourceLeafId,
      path: rootNode.path,
      title: rootNode.title,
      summary: rootNode.summary,
      bodySha256: sha256(nextBody),
      childCount: rootNode.childCount,
      observedAt: params.observedAt ?? rootNode.observedAt ?? rootNode.updatedAt,
      status: rootNode.status,
      isMaterialized: rootNode.isMaterialized,
      metadata: rootMetadata,
      createdAt: rootNode.createdAt,
      updatedAt: params.observedAt ?? rootNode.updatedAt,
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      docs: [
        {
          nodeId: rootNode.nodeId,
          nodeClass: rootNode.nodeClass,
          nodeKind: rootNode.nodeKind,
          path: rootNode.path,
          childCount: rootNode.childCount,
          title: rootNode.title,
          summary: rootNode.summary,
          bodyText: [
            rootNode.title,
            rootNode.summary,
            stripDurableMemoryRelatedSections(nextBody),
            ...canonicalRelatedInfo.relatedEntities.map((entity) => entity.label),
            ...canonicalRelatedInfo.relations.map((relation) => relation.relationType),
          ].filter(Boolean).join("\n"),
          excerpt: compactWhitespace(stripDurableMemoryRelatedSections(nextBody)).slice(0, 320) || rootNode.summary,
          observedAt: params.observedAt ?? rootNode.observedAt ?? rootNode.updatedAt,
          status: rootNode.status,
          updatedAt: params.observedAt ?? rootNode.updatedAt,
        },
        ...params.store.listSemanticMemorySearchDocs({
          category: "workspace",
          workspaceId: params.workspaceId,
          treeId: params.treeId,
          limit: 10_000,
          offset: 0,
        }).filter((doc) => doc.nodeId !== rootNode.nodeId),
      ],
    });
  }
  return canonicalRelatedInfo;
}

function chunkExcerptsForArtifactTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): string[] {
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 2);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 900);
  return params.store.listSemanticMemorySearchDocs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    nodeClass: "leaf",
    status: "active",
    limit: maxChunksPerDocument,
    offset: 0,
  })
    .map((chunk) => compactWhitespace(chunk.bodyText || chunk.excerpt || "").slice(0, maxCharsPerChunk))
    .filter(Boolean);
}

function absolutePathForRelative(workspaceDir: string, relativePath: string): string {
  const prefix = "workspace/";
  const normalized = relativePath.replaceAll("\\", "/");
  const trimmed = normalized.startsWith(prefix)
    ? normalized.split("/").slice(2).join("/")
    : normalized;
  return path.join(workspaceMemoryDir(workspaceDir), trimmed);
}

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  fs.writeFileSync(filePath, content, "utf8");
}

function removeObsoleteFiles(rootDir: string, keepAbsolutePaths: Set<string>): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const walk = (currentPath: string): void => {
    for (const childName of fs.readdirSync(currentPath)) {
      const childPath = path.join(currentPath, childName);
      const stats = fs.lstatSync(childPath);
      if (stats.isDirectory()) {
        walk(childPath);
        if (fs.existsSync(childPath) && fs.readdirSync(childPath).length === 0) {
          fs.rmdirSync(childPath);
        }
        continue;
      }
      if (!keepAbsolutePaths.has(path.resolve(childPath))) {
        fs.rmSync(childPath, { force: true });
      }
    }
  };
  walk(rootDir);
  if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
    fs.rmdirSync(rootDir);
  }
}

function attachmentTreeId(inputId: string, attachmentId: string): string {
  return `attachment:${inputId}:${attachmentId}`;
}

export function attachmentDocumentRootNodeId(treeId: string): string {
  return `attachment-root:${treeId}`;
}

function attachmentDocumentChunkNodeId(treeId: string, index: number): string {
  return `attachment-chunk:${treeId}:${String(index + 1).padStart(3, "0")}`;
}

function toolResultTreeId(inputId: string, callId: string | null, outputEventId: number): string {
  return `tool-result:${inputId}:${callId?.trim() || `event-${outputEventId}`}`;
}

function toolResultDocumentRootNodeId(treeId: string): string {
  return `tool-result-root:${treeId}`;
}

function toolResultDocumentChunkNodeId(treeId: string, index: number): string {
  return `tool-result-chunk:${treeId}:${String(index + 1).padStart(3, "0")}`;
}

function outputDocumentTreeId(outputId: string): string {
  return `output-artifact:${outputId}`;
}

function outputDocumentRootNodeId(treeId: string): string {
  return `output-root:${treeId}`;
}

function outputDocumentChunkNodeId(treeId: string, index: number): string {
  return `output-chunk:${treeId}:${String(index + 1).padStart(3, "0")}`;
}

function imageUrlDocumentTreeId(inputId: string, imageUrl: string): string {
  return `image-url:${inputId}:${sha256(imageUrl).slice(0, 16)}`;
}

function imageUrlDocumentRootNodeId(treeId: string): string {
  return `image-url-root:${treeId}`;
}

function imageUrlDocumentChunkNodeId(treeId: string, index: number): string {
  return `image-url-chunk:${treeId}:${String(index + 1).padStart(3, "0")}`;
}

function attachmentDocumentSlug(params: {
  inputId: string;
  attachment: TurnInputAttachment;
}): string {
  const { attachment, inputId } = params;
  const inputSuffix = safePathSegment(inputId.slice(0, 8) || "input", "input");
  const baseName = path.basename(attachment.name, path.extname(attachment.name));
  const suffix = attachment.id.slice(0, 8) || "attachment";
  return safePathSegment(`${baseName}-${suffix}-${inputSuffix}`, "attachment");
}

function toolResultDocumentSlug(entry: TurnIntegrationToolEvidenceEntry): string {
  const callSuffix = entry.callId?.slice(-12) || `event-${entry.outputEventId}`;
  return safePathSegment(
    `${entry.providerId}-${entry.toolName}-${entry.accountNamespace}-${callSuffix}`,
    "tool-result",
  );
}

function outputDocumentSlug(output: OutputRecord): string {
  const baseName = path.basename(output.title || output.filePath || output.id, path.extname(output.title || output.filePath || output.id));
  const suffix = output.id.slice(0, 8) || "output";
  return safePathSegment(`${baseName}-${suffix}`, "output");
}

function imageUrlDocumentSlug(params: {
  inputId: string;
  imageUrl: string;
  title: string;
}): string {
  const inputSuffix = safePathSegment(params.inputId.slice(0, 8) || "input", "input");
  return safePathSegment(
    `${path.basename(params.title, path.extname(params.title))}-${sha256(params.imageUrl).slice(0, 8)}-${inputSuffix}`,
    "referenced-image",
  );
}

function imageExtensionForMimeType(value: string | null | undefined): string {
  switch ((value ?? "").trim().toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return "";
  }
}

function imageMimeTypeFromPath(value: string): string | null {
  switch (path.extname(value).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

function detectInlineImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function isPdfMimeType(value: string): boolean {
  return /^application\/pdf$/i.test(value.trim());
}

function isPdfPath(value: string): boolean {
  return path.extname(value).toLowerCase() === ".pdf";
}

function isDocxMimeType(value: string): boolean {
  return /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i.test(value.trim());
}

function isDocxPath(value: string): boolean {
  return path.extname(value).toLowerCase() === ".docx";
}

function isPptxMimeType(value: string): boolean {
  return /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/i.test(value.trim());
}

function isPptxPath(value: string): boolean {
  return path.extname(value).toLowerCase() === ".pptx";
}

function isSpreadsheetMimeType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || normalized === "application/vnd.ms-excel";
}

function isSpreadsheetPath(value: string): boolean {
  const ext = path.extname(value).toLowerCase();
  return ext === ".xlsx" || ext === ".xls";
}

function isVisionOcrImageMimeType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "image/png"
    || normalized === "image/jpeg"
    || normalized === "image/jpg"
    || normalized === "image/webp"
    || normalized === "image/heic"
    || normalized === "image/heif"
    || normalized === "image/tiff"
    || normalized === "image/bmp"
    || normalized === "image/gif";
}

function isVisionOcrImagePath(value: string): boolean {
  const ext = path.extname(value).toLowerCase();
  return ext === ".png"
    || ext === ".jpg"
    || ext === ".jpeg"
    || ext === ".webp"
    || ext === ".heic"
    || ext === ".heif"
    || ext === ".tif"
    || ext === ".tiff"
    || ext === ".bmp"
    || ext === ".gif";
}

function hasExtractableAttachmentContent(attachment: TurnInputAttachment): boolean {
  if (attachment.kind === "folder") {
    return false;
  }
  if (isVisionOcrImageMimeType(attachment.mimeType) || isVisionOcrImagePath(attachment.workspacePath)) {
    return true;
  }
  if (
    isPdfMimeType(attachment.mimeType)
    || isPdfPath(attachment.workspacePath)
    || isDocxMimeType(attachment.mimeType)
    || isDocxPath(attachment.workspacePath)
    || isPptxMimeType(attachment.mimeType)
    || isPptxPath(attachment.workspacePath)
    || isSpreadsheetMimeType(attachment.mimeType)
    || isSpreadsheetPath(attachment.workspacePath)
  ) {
    return true;
  }
  if (
    /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-typescript)|application\/x-sh$)/i.test(
      attachment.mimeType,
    )
  ) {
    return true;
  }
  const ext = path.extname(attachment.workspacePath).toLowerCase();
  return new Set([
    ".txt",
    ".md",
    ".html",
    ".htm",
    ".json",
    ".xml",
    ".csv",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".rb",
    ".java",
    ".go",
    ".rs",
    ".css",
    ".scss",
    ".sql",
    ".yml",
    ".yaml",
    ".sh",
  ]).has(ext);
}

function normalizeAttachmentTextContent(rawText: string, attachment: TurnInputAttachment): string {
  if (/text\/html|application\/xhtml\+xml/i.test(attachment.mimeType)) {
    return stripHtmlLikeText(rawText);
  }
  return rawText.replace(/\r\n/g, "\n").trim();
}

function hasExtractableOutputContent(output: OutputRecord): boolean {
  if (output.htmlContent) {
    return true;
  }
  if (isVisionOcrImagePath(output.filePath ?? output.title)) {
    return true;
  }
  if (
    isPdfPath(output.filePath ?? output.title)
    || isDocxPath(output.filePath ?? output.title)
    || isPptxPath(output.filePath ?? output.title)
    || isSpreadsheetPath(output.filePath ?? output.title)
  ) {
    return true;
  }
  const ext = path.extname(output.filePath ?? output.title).toLowerCase();
  return new Set([
    ".txt",
    ".md",
    ".html",
    ".htm",
    ".json",
    ".xml",
    ".csv",
    ".tsv",
    ".yml",
    ".yaml",
    ".log",
    ".sql",
  ]).has(ext);
}

function inputImageUrlsForTurn(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): string[] {
  const imageUrls = store.getInput({
    workspaceId: turnResult.workspaceId,
    inputId: turnResult.inputId,
  })?.payload.image_urls;
  if (!Array.isArray(imageUrls)) {
    return [];
  }
  return imageUrls
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function sourceTurnInputAttachmentPosition(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  inputId: string;
  attachmentId: string;
}): number | null {
  const attachments = params.store.getInput({
    workspaceId: params.workspaceId,
    inputId: params.inputId,
  })?.payload.attachments;
  if (!Array.isArray(attachments)) {
    return null;
  }
  for (const [index, item] of attachments.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const attachmentId = typeof item.id === "string" ? item.id.trim() : "";
    if (attachmentId && attachmentId === params.attachmentId) {
      return index;
    }
  }
  return null;
}

function sourceTurnInputImageUrlPosition(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  inputId: string;
  imageUrl: string;
}): number | null {
  const imageUrls = params.store.getInput({
    workspaceId: params.workspaceId,
    inputId: params.inputId,
  })?.payload.image_urls;
  if (!Array.isArray(imageUrls)) {
    return null;
  }
  for (const [index, item] of imageUrls.entries()) {
    const imageUrl = typeof item === "string" ? item.trim() : "";
    if (imageUrl && imageUrl === params.imageUrl) {
      return index;
    }
  }
  return null;
}

type ResolvedImageUrlSource = {
  imageUrl: string;
  title: string;
  mimeType: string | null;
  absolutePath: string | null;
  bytes: Buffer | null;
  suggestedExtension: string;
};

function imageUrlDisplayTitle(imageUrl: string): string {
  if (/^data:/i.test(imageUrl)) {
    const mimeMatch = /^data:([^;,]+)/i.exec(imageUrl);
    const ext = imageExtensionForMimeType(mimeMatch?.[1] ?? null) || ".img";
    return `inline-image-${sha256(imageUrl).slice(0, 8)}${ext}`;
  }
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol === "file:") {
      const filePath = fileURLToPath(parsed);
      const baseName = path.basename(filePath);
      return baseName || `referenced-image-${sha256(imageUrl).slice(0, 8)}`;
    }
    const baseName = path.basename(parsed.pathname);
    if (baseName) {
      return baseName;
    }
    return `${parsed.hostname || "referenced-image"}-${sha256(imageUrl).slice(0, 8)}`;
  } catch {
    return `referenced-image-${sha256(imageUrl).slice(0, 8)}`;
  }
}

function dataUrlImageBytes(imageUrl: string): { bytes: Buffer; mimeType: string; suggestedExtension: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(imageUrl);
  if (!match) {
    return null;
  }
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  try {
    const bytes = Buffer.from(match[2] ?? "", "base64");
    if (bytes.length === 0) {
      return null;
    }
    const detectedMimeType = detectInlineImageMimeType(bytes) ?? mimeType;
    return {
      bytes,
      mimeType: detectedMimeType,
      suggestedExtension: imageExtensionForMimeType(detectedMimeType) || imageExtensionForMimeType(mimeType) || ".img",
    };
  } catch {
    return null;
  }
}

function fileUrlImageSource(workspaceDir: string, imageUrl: string): ResolvedImageUrlSource | null {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") {
    return null;
  }
  let absolutePath = "";
  try {
    absolutePath = path.resolve(fileURLToPath(parsed));
  } catch {
    return null;
  }
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (
    !relativePath
    || relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
    || !fs.existsSync(absolutePath)
    || !fs.statSync(absolutePath).isFile()
  ) {
    return null;
  }
  const title = imageUrlDisplayTitle(imageUrl);
  const mimeType = imageMimeTypeFromPath(absolutePath);
  return {
    imageUrl,
    title,
    mimeType,
    absolutePath,
    bytes: null,
    suggestedExtension: imageExtensionForMimeType(mimeType) || path.extname(absolutePath).toLowerCase() || ".img",
  };
}

async function remoteImageUrlSource(imageUrl: string): Promise<ResolvedImageUrlSource | null> {
  if (!/^https?:\/\//i.test(imageUrl) || typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const headerMimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!headerMimeType.startsWith("image/")) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
      return null;
    }
    const detectedMimeType = detectInlineImageMimeType(bytes) ?? headerMimeType;
    return {
      imageUrl,
      title: imageUrlDisplayTitle(imageUrl),
      mimeType: detectedMimeType,
      absolutePath: null,
      bytes,
      suggestedExtension: imageExtensionForMimeType(detectedMimeType) || imageExtensionForMimeType(headerMimeType) || ".img",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveReferencedImageUrlSource(params: {
  workspaceDir: string;
  imageUrl: string;
}): Promise<ResolvedImageUrlSource> {
  const title = imageUrlDisplayTitle(params.imageUrl);
  const dataUrl = dataUrlImageBytes(params.imageUrl);
  if (dataUrl) {
    return {
      imageUrl: params.imageUrl,
      title,
      mimeType: dataUrl.mimeType,
      absolutePath: null,
      bytes: dataUrl.bytes,
      suggestedExtension: dataUrl.suggestedExtension,
    };
  }
  const fileUrl = fileUrlImageSource(params.workspaceDir, params.imageUrl);
  if (fileUrl) {
    return fileUrl;
  }
  const remote = await remoteImageUrlSource(params.imageUrl);
  if (remote) {
    return remote;
  }
  return {
    imageUrl: params.imageUrl,
    title,
    mimeType: null,
    absolutePath: null,
    bytes: null,
    suggestedExtension: ".img",
  };
}

function resolveReferencedImageUrlSourceSync(params: {
  workspaceDir: string;
  imageUrl: string;
}): ResolvedImageUrlSource {
  const title = imageUrlDisplayTitle(params.imageUrl);
  const dataUrl = dataUrlImageBytes(params.imageUrl);
  if (dataUrl) {
    return {
      imageUrl: params.imageUrl,
      title,
      mimeType: dataUrl.mimeType,
      absolutePath: null,
      bytes: dataUrl.bytes,
      suggestedExtension: dataUrl.suggestedExtension,
    };
  }
  const fileUrl = fileUrlImageSource(params.workspaceDir, params.imageUrl);
  if (fileUrl) {
    return fileUrl;
  }
  return {
    imageUrl: params.imageUrl,
    title,
    mimeType: null,
    absolutePath: null,
    bytes: null,
    suggestedExtension: ".img",
  };
}

function normalizeOutputTextContent(rawText: string, output: OutputRecord): string {
  const ext = path.extname(output.filePath ?? output.title).toLowerCase();
  if (output.outputType === "html" || ext === ".html" || ext === ".htm") {
    return stripHtmlLikeText(rawText);
  }
  return rawText.replace(/\r\n/g, "\n").trim();
}

function macOsVisionOcrBinaryPath(): string | null {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/swiftc")) {
    return null;
  }
  const cacheDir = path.join(os.tmpdir(), "holaboss-memory-image-ocr");
  const version = sha256(MACOS_VISION_OCR_SWIFT_SOURCE).slice(0, 16);
  const sourcePath = path.join(cacheDir, `vision-ocr-${version}.swift`);
  const binaryPath = path.join(cacheDir, `vision-ocr-${version}`);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeFileIfChanged(sourcePath, MACOS_VISION_OCR_SWIFT_SOURCE);
    if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile()) {
      return binaryPath;
    }
    const compile = spawnSync("/usr/bin/swiftc", [sourcePath, "-o", binaryPath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (compile.error || compile.status !== 0) {
      return null;
    }
    return fs.existsSync(binaryPath) ? binaryPath : null;
  } catch {
    return null;
  }
}

function extractImageTextContentWithMacOsVision(absolutePath: string): string | null {
  const binaryPath = macOsVisionOcrBinaryPath();
  if (!binaryPath) {
    return null;
  }
  try {
    const result = spawnSync(binaryPath, [absolutePath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const text = normalizeExtractedDocumentText(result.stdout ?? "");
    return text || null;
  } catch {
    return null;
  }
}

function extractImageTextContentWithMacOsVisionBytes(params: {
  bytes: Buffer;
  suggestedExtension: string;
}): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-memory-image-url-ocr-"));
  const filePath = path.join(stageDir, `image${params.suggestedExtension || ".img"}`);
  try {
    fs.writeFileSync(filePath, params.bytes);
    return extractImageTextContentWithMacOsVision(filePath);
  } catch {
    return null;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function normalizeImageVisionModelText(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }
  const extractedText = normalizeExtractedDocumentText(
    firstNonEmptyString(
      payload.extracted_text,
      payload.extractedText,
      payload.text,
      payload.ocr_text,
    ),
  );
  const summary = normalizeExtractedDocumentText(
    firstNonEmptyString(
      payload.summary,
      payload.visual_summary,
      payload.description,
      payload.caption,
    ),
  );
  if (!extractedText && !summary) {
    return null;
  }
  if (!summary) {
    return extractedText || null;
  }
  if (!extractedText) {
    return `<image_summary>\n${summary}\n</image_summary>`;
  }
  return [
    "<image_vision>",
    "<extracted_text>",
    extractedText,
    "</extracted_text>",
    "<image_summary>",
    summary,
    "</image_summary>",
    "</image_vision>",
  ].join("\n");
}

function visionCapableImageMimeType(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }
  if (normalized.startsWith("image/")) {
    return normalized;
  }
  return null;
}

async function extractImageTextContentWithModel(params: {
  modelClient?: MemoryModelClientConfig | null;
  bytes: Buffer;
  mimeType: string | null;
  title: string;
  sourceLabel: string;
}): Promise<string | null> {
  if (!params.modelClient) {
    return null;
  }
  const modelMimeType = visionCapableImageMimeType(params.mimeType);
  if (!modelMimeType) {
    return null;
  }
  const payload = await queryMemoryModelVisionJson(params.modelClient, {
    systemPrompt: [
      "Extract durable, factual indexing text from a single image for workspace memory.",
      "Return a JSON object with keys extracted_text and summary.",
      "extracted_text must contain only visible text from the image in reading order when legible, otherwise an empty string.",
      "summary must be a concise factual description of the image's durable informational content, not style commentary.",
      "Do not invent unreadable text.",
    ].join(" "),
    userPrompt: [
      `Source label: ${params.sourceLabel}`,
      `Title: ${params.title}`,
      `MIME type: ${modelMimeType}`,
      "Return JSON only.",
    ].join("\n"),
    images: [
      {
        mimeType: modelMimeType,
        bytes: params.bytes,
        detail: "high",
      },
    ],
    timeoutMs: 20_000,
    agentRole: "memory-vision",
  });
  return normalizeImageVisionModelText(payload);
}

async function extractImageTextContent(params: {
  absolutePath?: string | null;
  bytes: Buffer;
  mimeType: string | null;
  suggestedExtension: string;
  title: string;
  sourceLabel: string;
  visionModelClient?: MemoryModelClientConfig | null;
}): Promise<string | null> {
  const localText = params.absolutePath
    ? extractImageTextContentWithMacOsVision(params.absolutePath)
    : extractImageTextContentWithMacOsVisionBytes({
        bytes: params.bytes,
        suggestedExtension: params.suggestedExtension,
      });
  if (localText) {
    return localText;
  }
  return await extractImageTextContentWithModel({
    modelClient: params.visionModelClient ?? null,
    bytes: params.bytes,
    mimeType: params.mimeType,
    title: params.title,
    sourceLabel: params.sourceLabel,
  });
}

function normalizePdfTextContent(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeExtractedDocumentText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWorkbookCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.hyperlink === "string" && typeof obj.text === "string") {
      return obj.text;
    }
    if ("formula" in obj || "sharedFormula" in obj) {
      if (obj.result !== undefined && obj.result !== null) {
        return normalizeWorkbookCellText(obj.result);
      }
      return "";
    }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((segment) => {
          if (segment && typeof segment === "object" && "text" in segment) {
            const segmentText = (segment as { text?: unknown }).text;
            return typeof segmentText === "string" ? segmentText : "";
          }
          return "";
        })
        .join("");
    }
    if ("error" in obj) {
      return typeof obj.error === "string" ? obj.error : "";
    }
    if (typeof obj.text === "string") {
      return obj.text;
    }
  }
  return String(value);
}

function readWorksheetCellText(cell: ExcelJSCell): string {
  const value = cell.value;
  if (value === null || value === undefined) {
    return "";
  }
  const fromValue = normalizeWorkbookCellText(value);
  if (fromValue.length > 0) {
    return fromValue;
  }
  if (typeof cell.text === "string" && cell.text.length > 0) {
    return cell.text;
  }
  return fromValue;
}

function workbookRowsFromWorksheet(worksheet: ExcelJSWorksheet): string[][] {
  const rowCount = worksheet.rowCount;
  const columnCount = worksheet.columnCount;
  if (rowCount <= 0 || columnCount <= 0) {
    return [];
  }
  const rows: string[][] = [];
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const cells: string[] = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      cells.push(readWorksheetCellText(row.getCell(columnIndex)));
    }
    rows.push(cells);
  }
  return rows;
}

async function extractPdfTextContent(buffer: Uint8Array): Promise<string | null> {
  try {
    const pdf = await getDocumentProxy(buffer);
    const result = await extractPdfText(pdf, { mergePages: false });
    const pages = result.text
      .map((pageText) => normalizePdfTextContent(pageText))
      .filter((pageText) => pageText.length > 0);
    if (pages.length === 0) {
      return null;
    }
    return pages
      .map((pageText, index) => `Page ${index + 1}\n${pageText}`)
      .join("\n\n");
  } catch {
    return null;
  }
}

async function extractDocxTextContent(buffer: Buffer, fileName: string): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    if (!documentXml) {
      return null;
    }
    const paragraphs = documentXml.match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
    const lines = paragraphs
      .map((paragraph) => {
        const matches = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
        return decodeXmlEntities(matches.map((match) => match[1] ?? "").join("")).trim();
      })
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return null;
    }
    return normalizeExtractedDocumentText(
      `<docx filename="${fileName}">\n<page number="1">\n${lines.join("\n")}\n</page>\n</docx>`,
    );
  } catch {
    return null;
  }
}

async function extractPptxTextContent(buffer: Buffer, fileName: string): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const sections: string[] = [];
    for (let index = 0; index < slideFiles.length; index += 1) {
      const slideFile = zip.file(slideFiles[index]);
      if (!slideFile) {
        continue;
      }
      const slideXml = await slideFile.async("text");
      const matches = [...slideXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
      const slideText = matches.map((match) => decodeXmlEntities(match[1] ?? "").trim()).filter(Boolean).join("\n");
      if (!slideText) {
        continue;
      }
      sections.push(`<slide number="${index + 1}">\n${slideText}\n</slide>`);
    }
    if (sections.length === 0) {
      return null;
    }
    return normalizeExtractedDocumentText(
      `<pptx filename="${fileName}">\n${sections.join("\n")}\n</pptx>`,
    );
  } catch {
    return null;
  }
}

async function extractSpreadsheetTextContent(buffer: Buffer, fileName: string): Promise<string | null> {
  try {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx.load as unknown as (data: Uint8Array) => Promise<ExcelJSWorkbook>)(buffer);
    const sections: string[] = [];
    workbook.worksheets.forEach((worksheet, index) => {
      const worksheetRows = workbookRowsFromWorksheet(worksheet);
      const csvRows: string[] = [];
      for (const row of worksheetRows) {
        const cells = [...row];
        let lastNonEmptyIndex = cells.length - 1;
        while (lastNonEmptyIndex >= 0 && cells[lastNonEmptyIndex] === "") {
          lastNonEmptyIndex -= 1;
        }
        const normalized = cells.slice(0, lastNonEmptyIndex + 1);
        if (normalized.length > 0) {
          csvRows.push(
            normalized
              .map((raw) => (
                /[",\n\r]/.test(raw)
                  ? `"${raw.replace(/"/g, "\"\"")}"`
                  : raw
              ))
              .join(","),
          );
        }
      }
      sections.push(
        `<sheet name="${worksheet.name}" index="${index}">\n${csvRows.join("\n").trim()}\n</sheet>`,
      );
    });
    if (sections.every((section) => /<sheet[^>]*>\s*<\/sheet>$/m.test(section))) {
      return null;
    }
    return normalizeExtractedDocumentText(
      `<excel filename="${fileName}">\n${sections.join("\n")}\n</excel>`,
    );
  } catch {
    return null;
  }
}

async function readAttachmentTextContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  attachment: TurnInputAttachment;
  visionModelClient?: MemoryModelClientConfig | null;
}): Promise<string | null> {
  if (!hasExtractableAttachmentContent(params.attachment)) {
    return null;
  }
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const absolutePath = path.join(workspaceDir, params.attachment.workspacePath);
  try {
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return null;
    }
    const fileBuffer = fs.readFileSync(absolutePath);
    if (isPdfMimeType(params.attachment.mimeType) || isPdfPath(params.attachment.workspacePath)) {
      return await extractPdfTextContent(new Uint8Array(fileBuffer));
    }
    if (isDocxMimeType(params.attachment.mimeType) || isDocxPath(params.attachment.workspacePath)) {
      return await extractDocxTextContent(fileBuffer, params.attachment.name);
    }
    if (isPptxMimeType(params.attachment.mimeType) || isPptxPath(params.attachment.workspacePath)) {
      return await extractPptxTextContent(fileBuffer, params.attachment.name);
    }
    if (isSpreadsheetMimeType(params.attachment.mimeType) || isSpreadsheetPath(params.attachment.workspacePath)) {
      return await extractSpreadsheetTextContent(fileBuffer, params.attachment.name);
    }
    if (isVisionOcrImageMimeType(params.attachment.mimeType) || isVisionOcrImagePath(params.attachment.workspacePath)) {
      return await extractImageTextContent({
        absolutePath,
        bytes: fileBuffer,
        mimeType: params.attachment.mimeType,
        suggestedExtension: path.extname(params.attachment.workspacePath).toLowerCase() || ".img",
        title: params.attachment.name,
        sourceLabel: `attachment:${params.attachment.id}`,
        visionModelClient: params.visionModelClient ?? null,
      });
    }
    return normalizeAttachmentTextContent(
      fileBuffer.toString("utf8"),
      params.attachment,
    );
  } catch {
    return null;
  }
}

async function readOutputTextContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  output: OutputRecord;
  visionModelClient?: MemoryModelClientConfig | null;
}): Promise<string | null> {
  if (params.output.htmlContent) {
    return normalizeOutputTextContent(params.output.htmlContent, params.output);
  }
  if (!params.output.filePath || !hasExtractableOutputContent(params.output)) {
    return null;
  }
  // Project-bound outputs live under the project's directory; General
  // outputs live under the workspace runtime dir. resolveOutputAbsolutePath
  // picks the right root from output.projectId so this call is correct for
  // either kind.
  const absolutePath = params.store.resolveOutputAbsolutePath(params.output);
  if (!absolutePath) {
    return null;
  }
  try {
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return null;
    }
    const fileBuffer = fs.readFileSync(absolutePath);
    if (isPdfPath(params.output.filePath)) {
      return await extractPdfTextContent(new Uint8Array(fileBuffer));
    }
    if (isDocxPath(params.output.filePath)) {
      return await extractDocxTextContent(fileBuffer, params.output.title || params.output.filePath || params.output.id);
    }
    if (isPptxPath(params.output.filePath)) {
      return await extractPptxTextContent(fileBuffer, params.output.title || params.output.filePath || params.output.id);
    }
    if (isSpreadsheetPath(params.output.filePath)) {
      return await extractSpreadsheetTextContent(fileBuffer, params.output.title || params.output.filePath || params.output.id);
    }
    if (isVisionOcrImagePath(params.output.filePath)) {
      return await extractImageTextContent({
        absolutePath,
        bytes: fileBuffer,
        mimeType: null,
        suggestedExtension: path.extname(params.output.filePath).toLowerCase() || ".img",
        title: params.output.title || params.output.filePath || params.output.id,
        sourceLabel: `output:${params.output.id}`,
        visionModelClient: params.visionModelClient ?? null,
      });
    }
    return normalizeOutputTextContent(
      fileBuffer.toString("utf8"),
      params.output,
    );
  } catch {
    return null;
  }
}

function readOutputTextContentForBackfill(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  output: OutputRecord;
}): string | null {
  if (params.output.htmlContent) {
    return normalizeOutputTextContent(params.output.htmlContent, params.output);
  }
  if (!params.output.filePath || !hasExtractableOutputContent(params.output)) {
    return null;
  }
  if (
    isPdfPath(params.output.filePath)
    || isDocxPath(params.output.filePath)
    || isPptxPath(params.output.filePath)
    || isSpreadsheetPath(params.output.filePath)
    || isVisionOcrImagePath(params.output.filePath)
  ) {
    return null;
  }
  const absolutePath = params.store.resolveOutputAbsolutePath(params.output);
  if (!absolutePath) {
    return null;
  }
  try {
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return null;
    }
    return normalizeOutputTextContent(fs.readFileSync(absolutePath, "utf8"), params.output);
  } catch {
    return null;
  }
}

async function readReferencedImageUrlTextContent(params: {
  workspaceDir: string;
  imageUrl: string;
  visionModelClient?: MemoryModelClientConfig | null;
}): Promise<ResolvedImageUrlSource & { extractedText: string | null }> {
  const resolved = await resolveReferencedImageUrlSource(params);
  const imageBytes = resolved.bytes
    ?? (resolved.absolutePath && fs.existsSync(resolved.absolutePath)
      ? fs.readFileSync(resolved.absolutePath)
      : null);
  const extractedText = imageBytes
    ? await extractImageTextContent({
        absolutePath: resolved.absolutePath,
        bytes: imageBytes,
        mimeType: resolved.mimeType,
        suggestedExtension: resolved.suggestedExtension,
        title: resolved.title,
        sourceLabel: `image_url:${params.imageUrl}`,
        visionModelClient: params.visionModelClient ?? null,
      })
    : null;
  return {
    ...resolved,
    extractedText,
  };
}

/**
 * Hard ceiling on how many chunks ONE document contributes to semantic memory.
 *
 * This splitter is the single choke point for every ingestion path (outputs,
 * attachments, image URLs, tool results), and it previously had no upper bound:
 * chunk count scaled linearly with file size. One AdsPower screenshot — a 2.1MB
 * JSON carrying a base64 PNG — became "document output with 4960 searchable
 * chunks", i.e. 4,960 nodes + search docs + evidence refs + edges from a single
 * tool call. Excluding tool results removes today's worst offender, but any
 * large attachment could reproduce it, so the bound belongs here.
 *
 * 200 chunks is ~320KB of indexed text per document, far past what retrieval
 * uses (maxChunksPerDocument is 2-4). Memory is a recall substrate, not storage:
 * the full file stays on disk and remains retrievable by path, and the root node
 * records the true chunk count so truncation is visible rather than silent.
 */
const MAX_DOCUMENT_CHUNKS = 200;

export function splitAttachmentTextIntoChunks(value: string): AttachmentChunk[] {
  const normalized = value.trim();
  if (!normalized) {
    return [];
  }
  const paragraphLike = normalized
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: AttachmentChunk[] = [];
  let current = "";
  const atCap = () => chunks.length >= MAX_DOCUMENT_CHUNKS;
  const flush = () => {
    if (!current.trim() || atCap()) {
      current = "";
      return;
    }
    const next = current.trim();
    chunks.push({
      index: chunks.length,
      content: next,
      summary: compactWhitespace(next).slice(0, 220),
    });
    current = "";
  };
  for (const block of paragraphLike.length > 0 ? paragraphLike : [normalized]) {
    if (atCap()) {
      break;
    }
    if ((current.length + block.length + 2) <= 1600) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    if (current) {
      flush();
    }
    if (block.length <= 1600) {
      current = block;
      continue;
    }
    let start = 0;
    while (start < block.length) {
      if (atCap()) {
        break;
      }
      const end = Math.min(block.length, start + 1600);
      const slice = block.slice(start, end).trim();
      if (slice) {
        chunks.push({
          index: chunks.length,
          content: slice,
          summary: compactWhitespace(slice).slice(0, 220),
        });
      }
      if (end >= block.length) {
        break;
      }
      start = Math.max(start + 1200, end - 200);
    }
  }
  flush();
  return chunks;
}

function attachmentDocumentRootBody(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  attachment: TurnInputAttachment;
  chunkCount: number;
  indexedAt: string;
  extractedText: string | null;
}): string {
  const lines = [
    `# ${params.attachment.name}`,
    "",
    `- Scope: \`workspace\``,
    `- Type: \`attachment_document\``,
    `- Workspace ID: \`${params.workspaceId}\``,
    `- Session ID: \`${params.sessionId}\``,
    `- Input ID: \`${params.inputId}\``,
    `- Attachment ID: \`${params.attachment.id}\``,
    `- Kind: \`${params.attachment.kind}\``,
    `- MIME Type: \`${params.attachment.mimeType}\``,
    `- Workspace path: \`${params.attachment.workspacePath}\``,
    `- Size bytes: ${params.attachment.sizeBytes}`,
    `- Indexed at: ${params.indexedAt}`,
    "",
    "## Summary",
    "",
    params.chunkCount > 0
      ? `Input attachment indexed as a first-class document with ${params.chunkCount} searchable chunk${params.chunkCount === 1 ? "" : "s"}.`
      : "Input attachment indexed as a first-class document. No text chunks were extracted from this attachment.",
  ];
  if (params.extractedText) {
    lines.push(
      "",
      "## Preview",
      "",
      compactWhitespace(params.extractedText).slice(0, 700),
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function attachmentDocumentChunkBody(params: {
  attachment: TurnInputAttachment;
  chunk: AttachmentChunk;
  chunkCount: number;
}): string {
  return [
    `# ${params.attachment.name} chunk ${params.chunk.index + 1}`,
    "",
    `- Attachment ID: \`${params.attachment.id}\``,
    `- Workspace path: \`${params.attachment.workspacePath}\``,
    `- MIME Type: \`${params.attachment.mimeType}\``,
    `- Chunk: ${params.chunk.index + 1}/${params.chunkCount}`,
    "",
    "## Content",
    "",
    params.chunk.content,
    "",
  ].join("\n");
}

function toolResultDocumentRootBody(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  entry: TurnIntegrationToolEvidenceEntry;
  chunkCount: number;
  indexedAt: string;
}): string {
  const lines = [
    `# ${params.entry.toolName} result`,
    "",
    `- Scope: \`workspace\``,
    `- Type: \`tool_result_document\``,
    `- Workspace ID: \`${params.workspaceId}\``,
    `- Session ID: \`${params.sessionId}\``,
    `- Input ID: \`${params.inputId}\``,
    `- Provider: \`${params.entry.providerId}\``,
    `- Account namespace: \`${params.entry.accountNamespace}\``,
    `- Connection ID: \`${params.entry.connectionId ?? "unknown"}\``,
    `- Tool name: \`${params.entry.toolName}\``,
    `- Tool ID: \`${params.entry.toolId ?? params.entry.toolName}\``,
    `- Call ID: \`${params.entry.callId ?? "unknown"}\``,
    `- Output event ID: ${params.entry.outputEventId}`,
    `- Indexed at: ${params.indexedAt}`,
    "",
    "## Summary",
    "",
    params.chunkCount > 0
      ? `Integration tool result indexed as a first-class document with ${params.chunkCount} searchable chunk${params.chunkCount === 1 ? "" : "s"}.`
      : "Integration tool result indexed as a first-class document. No text chunks were extracted from this tool result.",
  ];
  if (params.entry.resultSummary) {
    lines.push(
      "",
      "## Preview",
      "",
      params.entry.resultSummary,
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function toolResultDocumentChunkBody(params: {
  entry: TurnIntegrationToolEvidenceEntry;
  chunk: AttachmentChunk;
  chunkCount: number;
}): string {
  return [
    `# ${params.entry.toolName} result chunk ${params.chunk.index + 1}`,
    "",
    `- Provider: \`${params.entry.providerId}\``,
    `- Account namespace: \`${params.entry.accountNamespace}\``,
    `- Tool name: \`${params.entry.toolName}\``,
    `- Tool ID: \`${params.entry.toolId ?? params.entry.toolName}\``,
    `- Call ID: \`${params.entry.callId ?? "unknown"}\``,
    `- Chunk: ${params.chunk.index + 1}/${params.chunkCount}`,
    "",
    "## Content",
    "",
    params.chunk.content,
    "",
  ].join("\n");
}

function outputDocumentRootBody(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  output: OutputRecord;
  chunkCount: number;
  indexedAt: string;
  extractedText: string | null;
}): string {
  const lines = [
    `# ${params.output.title || params.output.filePath || params.output.id}`,
    "",
    `- Scope: \`workspace\``,
    `- Type: \`output_document\``,
    `- Workspace ID: \`${params.workspaceId}\``,
    `- Session ID: \`${params.sessionId}\``,
    `- Input ID: \`${params.inputId}\``,
    `- Output ID: \`${params.output.id}\``,
    `- Output type: \`${params.output.outputType}\``,
    `- Artifact ID: \`${params.output.artifactId ?? "unknown"}\``,
    `- File path: \`${params.output.filePath ?? "inline"}\``,
    `- Platform: \`${params.output.platform ?? "unknown"}\``,
    `- Module ID: \`${params.output.moduleId ?? "unknown"}\``,
    `- Module resource ID: \`${params.output.moduleResourceId ?? "unknown"}\``,
    `- Indexed at: ${params.indexedAt}`,
    "",
    "## Summary",
    "",
    params.chunkCount > 0
      ? `Workspace output indexed as a first-class document with ${params.chunkCount} searchable chunk${params.chunkCount === 1 ? "" : "s"}.`
      : "Workspace output indexed as a first-class document. No text chunks were extracted from this output.",
  ];
  if (params.extractedText) {
    lines.push(
      "",
      "## Preview",
      "",
      compactWhitespace(params.extractedText).slice(0, 700),
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function outputDocumentChunkBody(params: {
  output: OutputRecord;
  chunk: AttachmentChunk;
  chunkCount: number;
}): string {
  return [
    `# ${(params.output.title || params.output.filePath || params.output.id)} chunk ${params.chunk.index + 1}`,
    "",
    `- Output ID: \`${params.output.id}\``,
    `- Output type: \`${params.output.outputType}\``,
    `- File path: \`${params.output.filePath ?? "inline"}\``,
    `- Chunk: ${params.chunk.index + 1}/${params.chunkCount}`,
    "",
    "## Content",
    "",
    params.chunk.content,
    "",
  ].join("\n");
}

function imageUrlDocumentRootBody(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  imageUrl: string;
  title: string;
  mimeType: string | null;
  chunkCount: number;
  indexedAt: string;
  extractedText: string | null;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Scope: \`workspace\``,
    `- Type: \`image_url_document\``,
    `- Workspace ID: \`${params.workspaceId}\``,
    `- Session ID: \`${params.sessionId}\``,
    `- Input ID: \`${params.inputId}\``,
    `- Source URL: \`${params.imageUrl}\``,
    `- MIME Type: \`${params.mimeType ?? "unknown"}\``,
    `- Indexed at: ${params.indexedAt}`,
    "",
    "## Summary",
    "",
    params.chunkCount > 0
      ? `Referenced image URL indexed as a first-class document with ${params.chunkCount} searchable chunk${params.chunkCount === 1 ? "" : "s"}.`
      : "Referenced image URL indexed as a first-class document. No text chunks were extracted from this image.",
  ];
  if (params.extractedText) {
    lines.push(
      "",
      "## Preview",
      "",
      compactWhitespace(params.extractedText).slice(0, 700),
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function imageUrlDocumentChunkBody(params: {
  title: string;
  imageUrl: string;
  mimeType: string | null;
  chunk: AttachmentChunk;
  chunkCount: number;
}): string {
  return [
    `# ${params.title} chunk ${params.chunk.index + 1}`,
    "",
    `- Source URL: \`${params.imageUrl}\``,
    `- MIME Type: \`${params.mimeType ?? "unknown"}\``,
    `- Chunk: ${params.chunk.index + 1}/${params.chunkCount}`,
    "",
    "## Content",
    "",
    params.chunk.content,
    "",
  ].join("\n");
}

function attachmentEmbeddingText(params: {
  attachment: TurnInputAttachment;
  title: string;
  summary: string;
  body: string;
  nodeKind: "summary" | "leaf";
}): string {
  const excerpt = compactWhitespace(params.body).slice(0, 900);
  return [
    params.title,
    params.summary,
    params.attachment.name,
    params.attachment.mimeType,
    params.attachment.workspacePath,
    params.nodeKind,
    excerpt,
  ].filter(Boolean).join("\n");
}

async function syncAttachmentNodeEmbedding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  nodeId: string;
  nodeKind: "summary" | "leaf";
  attachment: TurnInputAttachment;
  title: string;
  summary: string;
  body: string;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<void> {
  if (!params.embeddingClient) {
    return;
  }
  const embeddingText = attachmentEmbeddingText({
    attachment: params.attachment,
    title: params.title,
    summary: params.summary,
    body: params.body,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  // workspace-removal Piece 5.7: the integration embedding graph is
  // control-plane-only; the store ignores any workspaceId, so it is not threaded.
  const existing = params.store.getIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing?.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    purpose: "document",
    input: embeddingText,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
  });
  if (!embedding) {
    return;
  }
  params.store.upsertIntegrationNodeEmbedding({
    treeId: params.treeId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

function toolResultEmbeddingText(params: {
  entry: TurnIntegrationToolEvidenceEntry;
  title: string;
  summary: string;
  body: string;
  nodeKind: "summary" | "leaf";
}): string {
  const excerpt = compactWhitespace(params.body).slice(0, 900);
  return [
    params.title,
    params.summary,
    params.entry.providerId,
    params.entry.accountNamespace,
    params.entry.toolName,
    params.entry.toolId ?? "",
    params.entry.callId ?? "",
    params.nodeKind,
    excerpt,
  ].filter(Boolean).join("\n");
}

function imageUrlEmbeddingText(params: {
  title: string;
  imageUrl: string;
  mimeType: string | null;
  summary: string;
  body: string;
  nodeKind: "summary" | "leaf";
}): string {
  const excerpt = compactWhitespace(params.body).slice(0, 900);
  return [
    params.title,
    params.imageUrl,
    params.mimeType ?? "",
    params.summary,
    params.nodeKind,
    excerpt,
  ].filter(Boolean).join("\n");
}

async function syncToolResultNodeEmbedding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  nodeId: string;
  nodeKind: "summary" | "leaf";
  entry: TurnIntegrationToolEvidenceEntry;
  title: string;
  summary: string;
  body: string;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<void> {
  if (!params.embeddingClient) {
    return;
  }
  const embeddingText = toolResultEmbeddingText({
    entry: params.entry,
    title: params.title,
    summary: params.summary,
    body: params.body,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  // workspace-removal Piece 5.7: the integration embedding graph is
  // control-plane-only; the store ignores any workspaceId, so it is not threaded.
  const existing = params.store.getIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing?.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    purpose: "document",
    input: embeddingText,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
  });
  if (!embedding) {
    return;
  }
  params.store.upsertIntegrationNodeEmbedding({
    treeId: params.treeId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

async function syncImageUrlNodeEmbedding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  nodeId: string;
  nodeKind: "summary" | "leaf";
  title: string;
  imageUrl: string;
  mimeType: string | null;
  summary: string;
  body: string;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<void> {
  if (!params.embeddingClient) {
    return;
  }
  const embeddingText = imageUrlEmbeddingText({
    title: params.title,
    imageUrl: params.imageUrl,
    mimeType: params.mimeType,
    summary: params.summary,
    body: params.body,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  // workspace-removal Piece 5.7: the integration embedding graph is
  // control-plane-only; the store ignores any workspaceId, so it is not threaded.
  const existing = params.store.getIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing?.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    purpose: "document",
    input: embeddingText,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
  });
  if (!embedding) {
    return;
  }
  params.store.upsertIntegrationNodeEmbedding({
    treeId: params.treeId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

function outputEmbeddingText(params: {
  output: OutputRecord;
  title: string;
  summary: string;
  body: string;
  nodeKind: "summary" | "leaf";
}): string {
  const excerpt = compactWhitespace(params.body).slice(0, 900);
  return [
    params.title,
    params.summary,
    params.output.outputType,
    params.output.filePath ?? "",
    params.output.artifactId ?? "",
    params.output.platform ?? "",
    params.output.moduleId ?? "",
    params.nodeKind,
    excerpt,
  ].filter(Boolean).join("\n");
}

async function syncOutputNodeEmbedding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  nodeId: string;
  nodeKind: "summary" | "leaf";
  output: OutputRecord;
  title: string;
  summary: string;
  body: string;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<void> {
  if (!params.embeddingClient) {
    return;
  }
  const embeddingText = outputEmbeddingText({
    output: params.output,
    title: params.title,
    summary: params.summary,
    body: params.body,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  // workspace-removal Piece 5.7: the integration embedding graph is
  // control-plane-only; the store ignores any workspaceId, so it is not threaded.
  const existing = params.store.getIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing?.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    purpose: "document",
    input: embeddingText,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
  });
  if (!embedding) {
    return;
  }
  params.store.upsertIntegrationNodeEmbedding({
    treeId: params.treeId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

function attachmentDescriptorFromRootNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): WorkspaceAttachmentDocumentTreeDescriptor | null {
  const metadata = node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
    ? node.metadata as Record<string, unknown>
    : {};
  const attachmentId = typeof metadata.attachment_id === "string" ? metadata.attachment_id.trim() : "";
  const workspacePath = typeof metadata.workspace_path === "string" ? metadata.workspace_path.trim() : "";
  const mimeType = typeof metadata.mime_type === "string" ? metadata.mime_type.trim() : "";
  const sourceTurnInputId = typeof metadata.source_turn_input_id === "string"
    ? metadata.source_turn_input_id.trim()
    : null;
  const sourceTurnInputPosition =
    typeof metadata.source_turn_input_position === "number" && Number.isInteger(metadata.source_turn_input_position)
      ? metadata.source_turn_input_position
      : null;
  const kind = metadata.kind === "image"
    ? "image"
    : metadata.kind === "folder"
      ? "folder"
      : "file";
  if (!attachmentId || !workspacePath || !mimeType) {
    return null;
  }
  return {
    treeId: node.treeId,
    rootNodeId: node.nodeId,
    title: node.title,
    attachmentId,
    kind,
    mimeType,
    workspacePath,
    observedAt: node.observedAt ?? node.updatedAt,
    path: node.path,
    sourceTurnInputId,
    sourceTurnInputPosition,
  };
}

function toolResultDescriptorFromRootNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): WorkspaceToolResultDocumentTreeDescriptor | null {
  const metadata = node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
    ? node.metadata as Record<string, unknown>
    : {};
  const providerId = typeof metadata.provider_id === "string" ? metadata.provider_id.trim() : "";
  const accountNamespace = typeof metadata.account_namespace === "string" ? metadata.account_namespace.trim() : "";
  const toolName = typeof metadata.tool_name === "string" ? metadata.tool_name.trim() : "";
  const sourceTurnInputId = typeof metadata.source_turn_input_id === "string"
    ? metadata.source_turn_input_id.trim()
    : null;
  const outputEventId = typeof metadata.output_event_id === "number" && Number.isFinite(metadata.output_event_id)
    ? metadata.output_event_id
    : null;
  if (!providerId || !accountNamespace || !toolName) {
    return null;
  }
  return {
    treeId: node.treeId,
    rootNodeId: node.nodeId,
    title: node.title,
    providerId,
    accountNamespace,
    connectionId: typeof metadata.connection_id === "string" ? metadata.connection_id.trim() : null,
    toolName,
    toolId: typeof metadata.tool_id === "string" ? metadata.tool_id.trim() : null,
    callId: typeof metadata.call_id === "string" ? metadata.call_id.trim() : null,
    outputEventId,
    observedAt: node.observedAt ?? node.updatedAt,
    path: node.path,
    sourceSessionId: typeof metadata.source_session_id === "string"
      ? metadata.source_session_id.trim()
      : null,
    sourceTurnInputId,
  };
}

function outputDescriptorFromRootNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): WorkspaceOutputDocumentTreeDescriptor | null {
  const metadata = node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
    ? node.metadata as Record<string, unknown>
    : {};
  const outputId = typeof metadata.output_id === "string" ? metadata.output_id.trim() : "";
  const outputType = typeof metadata.output_type === "string" ? metadata.output_type.trim() : "";
  const sourceTurnInputId = typeof metadata.source_turn_input_id === "string"
    ? metadata.source_turn_input_id.trim()
    : null;
  if (!outputId || !outputType) {
    return null;
  }
  return {
    treeId: node.treeId,
    rootNodeId: node.nodeId,
    title: node.title,
    outputId,
    outputType,
    filePath: typeof metadata.file_path === "string" ? metadata.file_path.trim() : null,
    artifactId: typeof metadata.artifact_id === "string" ? metadata.artifact_id.trim() : null,
    platform: typeof metadata.platform === "string" ? metadata.platform.trim() : null,
    moduleId: typeof metadata.module_id === "string" ? metadata.module_id.trim() : null,
    moduleResourceId: typeof metadata.module_resource_id === "string" ? metadata.module_resource_id.trim() : null,
    forwardedOutputId: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id.trim() : null,
    originType: typeof metadata.origin_type === "string" ? metadata.origin_type.trim() : null,
    sourceEventId: typeof metadata.source_event_id === "string" ? metadata.source_event_id.trim() : null,
    sourceSubagentId: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id.trim() : null,
    observedAt: node.observedAt ?? node.updatedAt,
    path: node.path,
    sourceTurnInputId,
  };
}

function outputArtifactSourceContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  descriptor: WorkspaceOutputDocumentTreeDescriptor;
}): {
  forwardedOutputId: string | null;
  sourceEventId: string | null;
  sourceSubagentId: string | null;
} {
  const output = typeof (params.store as { getOutput?: unknown }).getOutput === "function"
    ? params.store.getOutput({
      workspaceId: params.workspaceId,
      outputId: params.descriptor.outputId,
    })
    : null;
  const metadata = output?.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)
    ? output.metadata as Record<string, unknown>
    : {};
  const forwardedOutputId = firstNonEmptyString(
    params.descriptor.forwardedOutputId,
    typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : "",
  ) || null;
  const sourceEventId = firstNonEmptyString(
    params.descriptor.sourceEventId,
    typeof metadata.source_event_id === "string" ? metadata.source_event_id : "",
  ) || null;
  const sourceSubagentId = firstNonEmptyString(
    params.descriptor.sourceSubagentId,
    typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : "",
    sourceEventId && typeof (params.store as { getMainSessionEvent?: unknown }).getMainSessionEvent === "function"
      ? params.store.getMainSessionEvent({
        workspaceId: params.workspaceId,
        eventId: sourceEventId,
      })?.subagentId ?? ""
      : "",
  ) || null;
  return {
    forwardedOutputId,
    sourceEventId,
    sourceSubagentId,
  };
}

function imageUrlDescriptorFromRootNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): WorkspaceImageUrlDocumentTreeDescriptor | null {
  const metadata = node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
    ? node.metadata as Record<string, unknown>
    : {};
  const imageUrl = typeof metadata.image_url === "string" ? metadata.image_url.trim() : "";
  const sourceTurnInputId = typeof metadata.source_turn_input_id === "string"
    ? metadata.source_turn_input_id.trim()
    : null;
  const sourceTurnInputPosition =
    typeof metadata.source_turn_input_position === "number" && Number.isInteger(metadata.source_turn_input_position)
      ? metadata.source_turn_input_position
      : null;
  if (!imageUrl) {
    return null;
  }
  return {
    treeId: node.treeId,
    rootNodeId: node.nodeId,
    title: node.title,
    imageUrl,
    mimeType: typeof metadata.mime_type === "string" ? metadata.mime_type.trim() : null,
    observedAt: node.observedAt ?? node.updatedAt,
    path: node.path,
    sourceTurnInputId,
    sourceTurnInputPosition,
  };
}

function forwardedOutputRelationTarget(params: {
  descriptor: WorkspaceOutputDocumentTreeDescriptor;
  descriptors: WorkspaceOutputDocumentTreeDescriptor[];
  forwardedOutputId?: string | null;
}): WorkspaceOutputDocumentTreeDescriptor | null {
  const forwardedOutputId = params.forwardedOutputId ?? params.descriptor.forwardedOutputId;
  if (forwardedOutputId) {
    return params.descriptors.find((candidate) =>
      candidate.treeId !== params.descriptor.treeId
      && candidate.outputId === forwardedOutputId
    ) ?? null;
  }
  if (params.descriptor.originType !== "forwarded_subagent" || !params.descriptor.artifactId) {
    return null;
  }
  return params.descriptors.find((candidate) =>
    candidate.treeId !== params.descriptor.treeId
    && candidate.artifactId === params.descriptor.artifactId
    && candidate.outputId !== params.descriptor.outputId
  ) ?? null;
}

export interface WorkspaceArtifactRelationTargetDescriptor {
  treeId: string;
  nodeId: string;
  title: string;
  sourceTurnInputId?: string | null;
  outputId?: string | null;
  attachmentId?: string | null;
  imageUrl?: string | null;
  providerId?: string | null;
  callId?: string | null;
  outputEventId?: number | null;
}

export function resolveWorkspaceArtifactRelationIdentity(params: {
  artifact: WorkspaceArtifactRelationTargetDescriptor;
  relationType: string;
  resolver: WorkspaceRelatedEntityResolver;
}): {
  entityKey: string;
  resolvedTargetKind: "resolved" | "synthetic";
} {
  if (
    params.relationType === "forwarded_from"
    && typeof params.artifact.outputId === "string"
    && params.artifact.outputId.trim().length > 0
  ) {
    return {
      entityKey: canonicalOutputArtifactEntityKey(params.artifact.outputId),
      resolvedTargetKind: "resolved",
    };
  }
  if (typeof params.artifact.attachmentId === "string" && params.artifact.attachmentId.trim().length > 0) {
    return {
      entityKey: canonicalAttachmentArtifactEntityKey(params.artifact.attachmentId),
      resolvedTargetKind: "resolved",
    };
  }
  if (typeof params.artifact.imageUrl === "string" && params.artifact.imageUrl.trim().length > 0) {
    return {
      entityKey: canonicalImageUrlArtifactEntityKey(params.artifact.imageUrl),
      resolvedTargetKind: "resolved",
    };
  }
  if (typeof params.artifact.providerId === "string" && params.artifact.providerId.trim().length > 0) {
    return {
      entityKey: canonicalToolResultArtifactEntityKey({
        providerId: params.artifact.providerId,
        callId: typeof params.artifact.callId === "string" ? params.artifact.callId : null,
        outputEventId: typeof params.artifact.outputEventId === "number" ? params.artifact.outputEventId : null,
        treeId: params.artifact.treeId,
      }),
      resolvedTargetKind: "resolved",
    };
  }
  const resolved = params.resolver.resolve({
    entityType: "artifact",
    label: params.artifact.title,
    entityKey: legacyRelatedEntityKey("artifact", params.artifact.title),
    sourceTurnInputId: params.artifact.sourceTurnInputId ?? null,
  });
  if (
    resolved
    && resolved.targetTreeId === params.artifact.treeId
    && resolved.targetNodeId === params.artifact.nodeId
  ) {
    return {
      entityKey: resolved.entityKey,
      resolvedTargetKind: "resolved",
    };
  }
  return {
    entityKey: legacyRelatedEntityKey("artifact", params.artifact.title),
    resolvedTargetKind: "synthetic",
  };
}

function outputArtifactRelationsForDescriptor(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  workspaceDir: string;
  descriptor: WorkspaceOutputDocumentTreeDescriptor;
  descriptors: WorkspaceOutputDocumentTreeDescriptor[];
  attachmentDescriptors: WorkspaceAttachmentDocumentTreeDescriptor[];
  imageUrlDescriptors: WorkspaceImageUrlDocumentTreeDescriptor[];
  toolResultDescriptors: WorkspaceToolResultDocumentTreeDescriptor[];
  resolver: WorkspaceRelatedEntityResolver;
}): Array<{
  workspaceId: string;
  category: "workspace";
  treeId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}> {
  const relations: Array<{
    workspaceId: string;
    category: "workspace";
    treeId: string;
    fromNodeId: string;
    toNodeId: string;
    relationType: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [];
  relations.push(
    ...artifactDocumentRelationsFromStoredPath({
      store: params.store,
      workspaceDir: params.workspaceDir,
      workspaceId: params.workspaceId,
      treeId: params.descriptor.treeId,
      rootNodeId: params.descriptor.rootNodeId,
      path: params.descriptor.path,
      observedAt: params.descriptor.observedAt,
      resolver: params.resolver,
      sourceTurnInputId: params.descriptor.sourceTurnInputId,
      artifactContexts: [
        {
          sourceKind: "output_artifact",
          treeId: params.descriptor.treeId,
          title: params.descriptor.title,
          provider: null,
          accountNamespace: null,
          canonicalEntityKey: canonicalOutputArtifactEntityKey(params.descriptor.outputId),
          excerpts: [],
        },
      ],
    }),
  );
  const seenTargets = new Set<string>();
  const pushArtifactRelation = (relationType: string, artifact: {
    treeId: string;
    nodeId: string;
    title: string;
    sourceTurnInputId?: string | null;
    outputId?: string | null;
    attachmentId?: string | null;
    imageUrl?: string | null;
    providerId?: string | null;
    callId?: string | null;
    outputEventId?: number | null;
  }, metadata: Record<string, unknown>): void => {
    if (artifact.treeId === params.descriptor.treeId) {
      return;
    }
    const targetKey = `${relationType}:${artifact.treeId}:${artifact.nodeId}`;
    if (seenTargets.has(targetKey)) {
      return;
    }
    seenTargets.add(targetKey);
    const resolvedIdentity = resolveWorkspaceArtifactRelationIdentity({
      artifact,
      relationType,
      resolver: params.resolver,
    });
    relations.push({
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId: params.descriptor.treeId,
      fromNodeId: params.descriptor.rootNodeId,
      toNodeId: artifact.nodeId,
      relationType,
      metadata: {
        entity_key: resolvedIdentity.entityKey,
        entity_label: artifact.title,
        entity_type: "artifact",
        target_tree_id: artifact.treeId,
        target_node_id: artifact.nodeId,
        resolved_target_kind: resolvedIdentity.resolvedTargetKind,
        ...metadata,
      },
      createdAt: params.descriptor.observedAt,
      updatedAt: params.descriptor.observedAt,
    });
  };
  const sourceContext = outputArtifactSourceContext({
    store: params.store,
    workspaceId: params.workspaceId,
    descriptor: params.descriptor,
  });
  const target = forwardedOutputRelationTarget({
    ...params,
    forwardedOutputId: sourceContext.forwardedOutputId,
  });
  if (target) {
    pushArtifactRelation("forwarded_from", {
      treeId: target.treeId,
      nodeId: target.rootNodeId,
      title: target.title,
      sourceTurnInputId: target.sourceTurnInputId,
      outputId: target.outputId,
    }, {
      artifact_id: target.artifactId,
      output_id: target.outputId,
      origin_type: params.descriptor.originType,
      source_subagent_id: sourceContext.sourceSubagentId,
      source_event_id: sourceContext.sourceEventId,
    });
  }

  const sourceTurnInputId = params.descriptor.sourceTurnInputId?.trim() ?? "";
  const sameTurnArtifacts = sourceTurnInputId
    ? [
      ...params.attachmentDescriptors
      .filter((artifact) => artifact.sourceTurnInputId === sourceTurnInputId)
      .map((artifact) => ({
        treeId: artifact.treeId,
        nodeId: artifact.rootNodeId,
        title: artifact.title,
        sourceTurnInputId: artifact.sourceTurnInputId,
        attachmentId: artifact.attachmentId,
      })),
      ...params.imageUrlDescriptors
      .filter((artifact) => artifact.sourceTurnInputId === sourceTurnInputId)
      .map((artifact) => ({
        treeId: artifact.treeId,
        nodeId: artifact.rootNodeId,
        title: artifact.title,
        sourceTurnInputId: artifact.sourceTurnInputId,
        imageUrl: artifact.imageUrl,
      })),
      ...params.toolResultDescriptors
      .filter((artifact) => artifact.sourceTurnInputId === sourceTurnInputId)
      .map((artifact) => ({
        treeId: artifact.treeId,
        nodeId: artifact.rootNodeId,
        title: artifact.title,
        sourceTurnInputId: artifact.sourceTurnInputId,
        providerId: artifact.providerId,
        callId: artifact.callId,
        outputEventId: artifact.outputEventId,
      })),
    ]
    : [];

  for (const artifact of sameTurnArtifacts) {
    pushArtifactRelation("derived_from", artifact, {
      source_turn_input_id: sourceTurnInputId,
    });
  }

  const sourceSubagentId = sourceContext.sourceSubagentId?.trim() ?? "";
  const sourceSubagentRun = sourceSubagentId
    ? params.store.getSubagentRun({
      workspaceId: params.workspaceId,
      subagentId: sourceSubagentId,
    })
    : null;
  const sourceChildSessionId = sourceSubagentRun?.childSessionId?.trim() ?? "";
  if (sourceChildSessionId) {
    for (const artifact of params.toolResultDescriptors
      .filter((item) => item.sourceSessionId === sourceChildSessionId)
      .map((item) => ({
        treeId: item.treeId,
        nodeId: item.rootNodeId,
        title: item.title,
        sourceTurnInputId: item.sourceTurnInputId,
        providerId: item.providerId,
        callId: item.callId,
        outputEventId: item.outputEventId,
      }))) {
      pushArtifactRelation("derived_from", artifact, {
        source_subagent_id: sourceSubagentId,
        source_child_session_id: sourceChildSessionId,
      });
    }
  }

  return relations;
}

function syncWorkspaceOutputArtifactRelations(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const descriptors = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const attachmentDescriptors = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const imageUrlDescriptors = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const toolResultDescriptors = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.workspaceId,
    attachmentDescriptors,
    imageUrlDescriptors,
    toolResultDescriptors,
    outputDescriptors: descriptors,
  });
  for (const descriptor of descriptors) {
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      relations: outputArtifactRelationsForDescriptor({
        store: params.store,
        workspaceId: params.workspaceId,
        workspaceDir,
        descriptor,
        descriptors,
        attachmentDescriptors,
        imageUrlDescriptors,
        toolResultDescriptors,
        resolver: relatedEntityResolver,
      }),
    });
  }
}

function syncStandaloneArtifactDocumentRelations(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const attachmentDescriptors = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const imageUrlDescriptors = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const toolResultDescriptors = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const outputDescriptors = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.workspaceId,
    attachmentDescriptors,
    imageUrlDescriptors,
    toolResultDescriptors,
    outputDescriptors,
  });
  for (const descriptor of attachmentDescriptors) {
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      relations: artifactDocumentRelationsFromStoredPath({
        store: params.store,
        workspaceDir,
        workspaceId: params.workspaceId,
        treeId: descriptor.treeId,
        rootNodeId: descriptor.rootNodeId,
        path: descriptor.path,
        observedAt: descriptor.observedAt,
        resolver: relatedEntityResolver,
        sourceTurnInputId: descriptor.sourceTurnInputId,
        artifactContexts: [
          {
            sourceKind: "attachment",
            treeId: descriptor.treeId,
            title: descriptor.title,
            provider: null,
            accountNamespace: null,
            canonicalEntityKey: canonicalAttachmentArtifactEntityKey(descriptor.attachmentId),
            excerpts: [],
          },
        ],
      }),
    });
  }
  for (const descriptor of imageUrlDescriptors) {
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      relations: artifactDocumentRelationsFromStoredPath({
        store: params.store,
        workspaceDir,
        workspaceId: params.workspaceId,
        treeId: descriptor.treeId,
        rootNodeId: descriptor.rootNodeId,
        path: descriptor.path,
        observedAt: descriptor.observedAt,
        resolver: relatedEntityResolver,
        sourceTurnInputId: descriptor.sourceTurnInputId,
        artifactContexts: [
          {
            sourceKind: "image_url",
            treeId: descriptor.treeId,
            title: descriptor.title,
            provider: null,
            accountNamespace: null,
            canonicalEntityKey: canonicalImageUrlArtifactEntityKey(descriptor.imageUrl),
            excerpts: [],
          },
        ],
      }),
    });
  }
  for (const descriptor of toolResultDescriptors) {
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      relations: artifactDocumentRelationsFromStoredPath({
        store: params.store,
        workspaceDir,
        workspaceId: params.workspaceId,
        treeId: descriptor.treeId,
        rootNodeId: descriptor.rootNodeId,
        path: descriptor.path,
        observedAt: descriptor.observedAt,
        resolver: relatedEntityResolver,
        sourceTurnInputId: descriptor.sourceTurnInputId,
        artifactContexts: [
          {
            sourceKind: "tool_result",
            treeId: descriptor.treeId,
            title: descriptor.title,
            provider: descriptor.providerId,
            accountNamespace: descriptor.accountNamespace,
            canonicalEntityKey: canonicalToolResultArtifactEntityKey({
              providerId: descriptor.providerId,
              callId: descriptor.callId,
              outputEventId: descriptor.outputEventId,
              treeId: descriptor.treeId,
            }),
            excerpts: [],
          },
        ],
      }),
    });
  }
}

export function syncWorkspaceArtifactRelations(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  syncStandaloneArtifactDocumentRelations(params);
  syncWorkspaceOutputArtifactRelations(params);
}

function listAllWorkspaceOutputs(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): OutputRecord[] {
  if (typeof (params.store as { listOutputs?: unknown }).listOutputs !== "function") {
    return [];
  }
  const outputs: OutputRecord[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = params.store.listOutputs({
      workspaceId: params.workspaceId,
      limit: pageSize,
      offset,
    }).filter((output) => output.status !== "deleted");
    outputs.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return outputs;
}

function listAllWorkspaceCompletedTurnResults(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): TurnResultRecord[] {
  if (typeof (params.store as { listWorkspaceTurnResults?: unknown }).listWorkspaceTurnResults !== "function") {
    return [];
  }
  const turns: TurnResultRecord[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = params.store.listWorkspaceTurnResults({
      workspaceId: params.workspaceId,
      status: "completed",
      order: "asc",
      limit: pageSize,
      offset,
    });
    turns.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return turns;
}

function persistWorkspaceOutputDocumentTreeFromOutput(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  output: OutputRecord;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const treeId = outputDocumentTreeId(params.output.id);
  const rootNodeId = outputDocumentRootNodeId(treeId);
  const slug = outputDocumentSlug(params.output);
  const baseDir = `semantic/workspace/artifacts/outputs/${slug}`;
  const rootPath = `${baseDir}/content.md`;
  const extractedText = readOutputTextContentForBackfill({
    store: params.store,
    workspaceId: params.workspaceId,
    output: params.output,
  });
  const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
  const indexedAt = params.output.updatedAt ?? params.output.createdAt ?? new Date().toISOString();
  const rootBody = outputDocumentRootBody({
    workspaceId: params.workspaceId,
    sessionId: params.output.sessionId ?? "unknown",
    inputId: params.output.inputId ?? "unknown",
    output: params.output,
    chunkCount: chunks.length,
    indexedAt,
    extractedText,
  });
  const rootSummary = chunks.length > 0
    ? `${params.output.outputType} output with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
    : `${params.output.outputType} output indexed as a first-class document.`;
  const metadata = params.output.metadata && typeof params.output.metadata === "object" && !Array.isArray(params.output.metadata)
    ? params.output.metadata as Record<string, unknown>
    : {};
  const nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId?: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: "active";
    isMaterialized?: boolean;
    metadata?: Record<string, unknown>;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: OUTPUT_DOCUMENT_NODE_KIND,
      path: rootPath,
      title: params.output.title || params.output.filePath || params.output.id,
      summary: rootSummary,
      bodySha256: sha256(rootBody),
      childCount: chunks.length,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        output_id: params.output.id,
        output_type: params.output.outputType,
        file_path: params.output.filePath,
        artifact_id: params.output.artifactId,
        platform: params.output.platform,
        module_id: params.output.moduleId,
        module_resource_id: params.output.moduleResourceId,
        source_turn_input_id: params.output.inputId,
        source_session_id: params.output.sessionId,
        origin_type: typeof metadata.origin_type === "string" ? metadata.origin_type : null,
        forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
        source_event_id: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
        source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
        related_entity_keys: [],
        relation_types: [],
      },
    },
  ];
  const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
  const bodiesByPath = new Map<string, string>([[rootPath, rootBody]]);
  const sourceTurnInputId = params.output.inputId ?? "unknown";
  const evidenceRefs: Array<{
    workspaceId: string;
    category: "workspace";
    treeId: string;
    nodeId: string;
    refId: string;
    provider: string | null;
    accountNamespace: string | null;
    connectionId: string | null;
    externalObjectId: string | null;
    externalObjectType: string | null;
    sourceType: string | null;
    sourceEventId: string | null;
    sourceMessageId: null;
    sourceTurnInputId: string;
    observedAt: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId: rootNodeId,
      refId: `output:${params.output.id}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.output.id,
      externalObjectType: "workspace_output_artifact",
      sourceType: typeof metadata.origin_type === "string" ? metadata.origin_type : "output",
      sourceEventId: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
      sourceMessageId: null,
      sourceTurnInputId,
      observedAt: indexedAt,
      metadata: {
        artifact_id: params.output.artifactId,
        output_type: params.output.outputType,
        file_path: params.output.filePath,
        platform: params.output.platform,
        module_id: params.output.moduleId,
        module_resource_id: params.output.moduleResourceId,
        evidence_kind: "workspace_output_document",
        source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
        forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    },
  ];
  const searchDocs: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    path: string;
    childCount?: number;
    title: string;
    summary: string;
    bodyText: string;
    excerpt?: string | null;
    observedAt?: string | null;
    status?: "active";
    updatedAt?: string;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: OUTPUT_DOCUMENT_NODE_KIND,
      path: rootPath,
      childCount: chunks.length,
      title: params.output.title || params.output.filePath || params.output.id,
      summary: rootSummary,
      bodyText: [
        params.output.title,
        params.output.filePath ?? "",
        params.output.outputType,
        params.output.platform ?? "",
        params.output.moduleId ?? "",
        extractedText ?? "",
      ].filter(Boolean).join("\n"),
      excerpt: extractedText ? compactWhitespace(extractedText).slice(0, 320) : rootSummary,
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    },
  ];

  for (const chunk of chunks) {
    const nodeId = outputDocumentChunkNodeId(treeId, chunk.index);
    const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
    const chunkBody = outputDocumentChunkBody({
      output: params.output,
      chunk,
      chunkCount: chunks.length,
    });
    nodes.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: OUTPUT_CHUNK_NODE_KIND,
      sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
      path: chunkPath,
      title: `${params.output.title || params.output.filePath || params.output.id} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodySha256: sha256(chunkBody),
      childCount: 0,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        output_id: params.output.id,
        output_type: params.output.outputType,
        file_path: params.output.filePath,
        artifact_id: params.output.artifactId,
        chunk_index: chunk.index + 1,
        chunk_count: chunks.length,
        forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
        source_event_id: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
        source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
      },
    });
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: nodeId,
      position: chunk.index + 1,
    });
    bodiesByPath.set(chunkPath, chunkBody);
    evidenceRefs.push({
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId,
      refId: `output:${params.output.id}:chunk:${chunk.index + 1}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.output.id,
      externalObjectType: "workspace_output_artifact",
      sourceType: typeof metadata.origin_type === "string" ? metadata.origin_type : "output",
      sourceEventId: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
      sourceMessageId: null,
      sourceTurnInputId,
      observedAt: indexedAt,
      metadata: {
        artifact_id: params.output.artifactId,
        output_type: params.output.outputType,
        file_path: params.output.filePath,
        chunk_index: chunk.index + 1,
        evidence_kind: "workspace_output_document_chunk",
        forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    });
    searchDocs.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: OUTPUT_CHUNK_NODE_KIND,
      path: chunkPath,
      childCount: 0,
      title: `${params.output.title || params.output.filePath || params.output.id} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodyText: chunk.content,
      excerpt: compactWhitespace(chunk.content).slice(0, 320),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    });
  }

  for (const [relativePath, body] of bodiesByPath) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
  }
  removeObsoleteFiles(
    absolutePathForRelative(workspaceDir, baseDir),
    new Set(
      [...bodiesByPath.keys()].map((relativePath) =>
        path.resolve(absolutePathForRelative(workspaceDir, relativePath))
      ),
    ),
  );

  params.store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    nodes,
    edges,
  });
  params.store.replaceSemanticMemoryEvidenceRefs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    refs: evidenceRefs,
  });
  params.store.syncSemanticMemorySearchDocs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    docs: searchDocs,
  });
}

function persistWorkspaceToolResultDocumentTreeFromEntry(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  turnResult: TurnResultRecord;
  entry: TurnIntegrationToolEvidenceEntry;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const treeId = toolResultTreeId(params.turnResult.inputId, params.entry.callId, params.entry.outputEventId);
  const rootNodeId = toolResultDocumentRootNodeId(treeId);
  const slug = toolResultDocumentSlug(params.entry);
  const baseDir = `semantic/workspace/artifacts/tool-results/${slug}`;
  const rootPath = `${baseDir}/content.md`;
  const extractedText = params.entry.resultBodyText;
  const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
  const indexedAt = params.entry.observedAt || params.turnResult.completedAt || params.turnResult.updatedAt;
  const rootBody = toolResultDocumentRootBody({
    workspaceId: params.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    entry: params.entry,
    chunkCount: chunks.length,
    indexedAt,
  });
  const rootSummary = chunks.length > 0
    ? `${params.entry.providerId} ${params.entry.toolName} result with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
    : `${params.entry.providerId} ${params.entry.toolName} result indexed as a first-class document.`;
  const nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId?: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: "active";
    isMaterialized?: boolean;
    metadata?: Record<string, unknown>;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: TOOL_RESULT_DOCUMENT_NODE_KIND,
      path: rootPath,
      title: `${params.entry.toolName} result`,
      summary: rootSummary,
      bodySha256: sha256(rootBody),
      childCount: chunks.length,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        provider_id: params.entry.providerId,
        account_namespace: params.entry.accountNamespace,
        connection_id: params.entry.connectionId,
        tool_name: params.entry.toolName,
        tool_id: params.entry.toolId,
        call_id: params.entry.callId,
        output_event_id: params.entry.outputEventId,
        source_turn_input_id: params.turnResult.inputId,
        source_session_id: params.turnResult.sessionId,
        related_entity_keys: [],
        relation_types: [],
      },
    },
  ];
  const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
  const bodiesByPath = new Map<string, string>([[rootPath, rootBody]]);
  const evidenceRefs: Array<{
    workspaceId: string;
    category: "workspace";
    treeId: string;
    nodeId: string;
    refId: string;
    provider: string;
    accountNamespace: string;
    connectionId: string | null;
    externalObjectId: string;
    externalObjectType: string;
    sourceType: string;
    sourceEventId: string | null;
    sourceMessageId: null;
    sourceTurnInputId: string;
    observedAt: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId: rootNodeId,
      refId: params.entry.callId ? `tool-result:${params.entry.callId}` : `tool-result:event:${params.entry.outputEventId}`,
      provider: params.entry.providerId,
      accountNamespace: params.entry.accountNamespace,
      connectionId: params.entry.connectionId,
      externalObjectId: params.entry.callId ?? String(params.entry.outputEventId),
      externalObjectType: "integration_tool_result",
      sourceType: "tool_call",
      sourceEventId: params.entry.callId ?? null,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        tool_name: params.entry.toolName,
        tool_id: params.entry.toolId,
        output_event_id: params.entry.outputEventId,
        evidence_kind: "integration_tool_result_document",
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    },
  ];
  const searchDocs: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    path: string;
    childCount?: number;
    title: string;
    summary: string;
    bodyText: string;
    excerpt?: string | null;
    observedAt?: string | null;
    status?: "active";
    updatedAt?: string;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: TOOL_RESULT_DOCUMENT_NODE_KIND,
      path: rootPath,
      childCount: chunks.length,
      title: `${params.entry.toolName} result`,
      summary: rootSummary,
      bodyText: [
        params.entry.providerId,
        params.entry.accountNamespace,
        params.entry.toolName,
        params.entry.toolId ?? "",
        params.entry.resultBodyText ?? params.entry.resultSummary ?? "",
      ].filter(Boolean).join("\n"),
      excerpt: params.entry.resultSummary ?? (params.entry.resultBodyText ? compactWhitespace(params.entry.resultBodyText).slice(0, 320) : null),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    },
  ];

  for (const chunk of chunks) {
    const nodeId = toolResultDocumentChunkNodeId(treeId, chunk.index);
    const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
    const chunkBody = toolResultDocumentChunkBody({
      entry: params.entry,
      chunk,
      chunkCount: chunks.length,
    });
    nodes.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: TOOL_RESULT_CHUNK_NODE_KIND,
      sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
      path: chunkPath,
      title: `${params.entry.toolName} result chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodySha256: sha256(chunkBody),
      childCount: 0,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        provider_id: params.entry.providerId,
        account_namespace: params.entry.accountNamespace,
        tool_name: params.entry.toolName,
        tool_id: params.entry.toolId,
        call_id: params.entry.callId,
        output_event_id: params.entry.outputEventId,
        chunk_index: chunk.index + 1,
        chunk_count: chunks.length,
      },
    });
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: nodeId,
      position: chunk.index + 1,
    });
    bodiesByPath.set(chunkPath, chunkBody);
    evidenceRefs.push({
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId,
      refId: params.entry.callId
        ? `tool-result:${params.entry.callId}:chunk:${chunk.index + 1}`
        : `tool-result:event:${params.entry.outputEventId}:chunk:${chunk.index + 1}`,
      provider: params.entry.providerId,
      accountNamespace: params.entry.accountNamespace,
      connectionId: params.entry.connectionId,
      externalObjectId: params.entry.callId ?? String(params.entry.outputEventId),
      externalObjectType: "integration_tool_result",
      sourceType: "tool_call",
      sourceEventId: params.entry.callId ?? null,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        tool_name: params.entry.toolName,
        tool_id: params.entry.toolId,
        output_event_id: params.entry.outputEventId,
        chunk_index: chunk.index + 1,
        evidence_kind: "integration_tool_result_document_chunk",
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    });
    searchDocs.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: TOOL_RESULT_CHUNK_NODE_KIND,
      path: chunkPath,
      childCount: 0,
      title: `${params.entry.toolName} result chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodyText: chunk.content,
      excerpt: compactWhitespace(chunk.content).slice(0, 320),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    });
  }

  for (const [relativePath, body] of bodiesByPath) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
  }
  removeObsoleteFiles(
    absolutePathForRelative(workspaceDir, baseDir),
    new Set(
      [...bodiesByPath.keys()].map((relativePath) =>
        path.resolve(absolutePathForRelative(workspaceDir, relativePath))
      ),
    ),
  );

  params.store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    nodes,
    edges,
  });
  params.store.replaceSemanticMemoryEvidenceRefs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    refs: evidenceRefs,
  });
  params.store.syncSemanticMemorySearchDocs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    docs: searchDocs,
  });
}

function persistWorkspaceAttachmentDocumentTreeFromAttachment(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  turnResult: TurnResultRecord;
  attachment: TurnInputAttachment;
  sourceTurnInputPosition?: number | null;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const treeId = attachmentTreeId(params.turnResult.inputId, params.attachment.id);
  const rootNodeId = attachmentDocumentRootNodeId(treeId);
  const slug = attachmentDocumentSlug({
    inputId: params.turnResult.inputId,
    attachment: params.attachment,
  });
  const baseDir = `semantic/workspace/artifacts/${slug}`;
  const rootPath = `${baseDir}/content.md`;
  const extractedText = attachmentPreviewText({
    store: params.store,
    workspaceId: params.workspaceId,
    attachment: params.attachment,
  });
  const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
  const indexedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
  const rootBody = attachmentDocumentRootBody({
    workspaceId: params.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    attachment: params.attachment,
    chunkCount: chunks.length,
    indexedAt,
    extractedText,
  });
  const rootSummary = chunks.length > 0
    ? `${params.attachment.mimeType} attachment with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
    : `${params.attachment.mimeType} attachment indexed as a first-class document.`;
  const nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId?: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: "active";
    isMaterialized?: boolean;
    metadata?: Record<string, unknown>;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: ATTACHMENT_DOCUMENT_NODE_KIND,
      path: rootPath,
      title: params.attachment.name,
      summary: rootSummary,
      bodySha256: sha256(rootBody),
      childCount: chunks.length,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        attachment_id: params.attachment.id,
        kind: params.attachment.kind,
        mime_type: params.attachment.mimeType,
        size_bytes: params.attachment.sizeBytes,
        workspace_path: params.attachment.workspacePath,
        source_turn_input_id: params.turnResult.inputId,
        source_turn_input_position: params.sourceTurnInputPosition ?? null,
        source_session_id: params.turnResult.sessionId,
        related_entity_keys: [],
        relation_types: [],
      },
    },
  ];
  const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
  const bodiesByPath = new Map<string, string>([[rootPath, rootBody]]);
  const evidenceRefs: Array<{
    workspaceId: string;
    category: "workspace";
    treeId: string;
    nodeId: string;
    refId: string;
    provider: null;
    accountNamespace: null;
    connectionId: null;
    externalObjectId: string;
    externalObjectType: string;
    sourceType: string;
    sourceEventId: string | null;
    sourceMessageId: null;
    sourceTurnInputId: string;
    observedAt: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId: rootNodeId,
      refId: `attachment:${params.attachment.id}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.attachment.id,
      externalObjectType: "input_attachment",
      sourceType: "attachment",
      sourceEventId: params.turnResult.inputId,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        kind: params.attachment.kind,
        mime_type: params.attachment.mimeType,
        size_bytes: params.attachment.sizeBytes,
        workspace_path: params.attachment.workspacePath,
        attachment_name: params.attachment.name,
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    },
  ];
  const searchDocs: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    path: string;
    childCount?: number;
    title: string;
    summary: string;
    bodyText: string;
    excerpt?: string | null;
    observedAt?: string | null;
    status?: "active";
    updatedAt?: string;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: ATTACHMENT_DOCUMENT_NODE_KIND,
      path: rootPath,
      childCount: chunks.length,
      title: params.attachment.name,
      summary: rootSummary,
      bodyText: [
        params.attachment.name,
        params.attachment.mimeType,
        params.attachment.workspacePath,
        extractedText ?? "",
      ].filter(Boolean).join("\n"),
      excerpt: extractedText ? compactWhitespace(extractedText).slice(0, 320) : null,
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    },
  ];

  for (const chunk of chunks) {
    const nodeId = attachmentDocumentChunkNodeId(treeId, chunk.index);
    const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
    const chunkBody = attachmentDocumentChunkBody({
      attachment: params.attachment,
      chunk,
      chunkCount: chunks.length,
    });
    nodes.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: ATTACHMENT_CHUNK_NODE_KIND,
      sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
      path: chunkPath,
      title: `${params.attachment.name} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodySha256: sha256(chunkBody),
      childCount: 0,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        attachment_id: params.attachment.id,
        chunk_index: chunk.index + 1,
        chunk_count: chunks.length,
        workspace_path: params.attachment.workspacePath,
      },
    });
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: nodeId,
      position: chunk.index + 1,
    });
    bodiesByPath.set(chunkPath, chunkBody);
    evidenceRefs.push({
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId,
      refId: `attachment:${params.attachment.id}:chunk:${chunk.index + 1}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.attachment.id,
      externalObjectType: "input_attachment",
      sourceType: "attachment",
      sourceEventId: params.turnResult.inputId,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        kind: params.attachment.kind,
        mime_type: params.attachment.mimeType,
        size_bytes: params.attachment.sizeBytes,
        workspace_path: params.attachment.workspacePath,
        attachment_name: params.attachment.name,
        chunk_index: chunk.index + 1,
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    });
    searchDocs.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: ATTACHMENT_CHUNK_NODE_KIND,
      path: chunkPath,
      childCount: 0,
      title: `${params.attachment.name} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodyText: chunk.content,
      excerpt: compactWhitespace(chunk.content).slice(0, 320),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    });
  }

  for (const [relativePath, body] of bodiesByPath) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
  }
  removeObsoleteFiles(
    absolutePathForRelative(workspaceDir, baseDir),
    new Set(
      [...bodiesByPath.keys()].map((relativePath) =>
        path.resolve(absolutePathForRelative(workspaceDir, relativePath))
      ),
    ),
  );

  params.store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    nodes,
    edges,
  });
  params.store.replaceSemanticMemoryEvidenceRefs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    refs: evidenceRefs,
  });
  params.store.syncSemanticMemorySearchDocs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    docs: searchDocs,
  });
}

function persistWorkspaceImageUrlDocumentTreeFromUrl(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  turnResult: TurnResultRecord;
  imageUrl: string;
  sourceTurnInputPosition?: number | null;
}): void {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const resolved = resolveReferencedImageUrlSourceSync({
    workspaceDir,
    imageUrl: params.imageUrl,
  });
  const extractedText = resolved.absolutePath
    ? extractImageTextContentWithMacOsVision(resolved.absolutePath)
    : resolved.bytes
      ? extractImageTextContentWithMacOsVisionBytes({
          bytes: resolved.bytes,
          suggestedExtension: resolved.suggestedExtension,
        })
      : null;
  const treeId = imageUrlDocumentTreeId(params.turnResult.inputId, params.imageUrl);
  const rootNodeId = imageUrlDocumentRootNodeId(treeId);
  const slug = imageUrlDocumentSlug({
    inputId: params.turnResult.inputId,
    imageUrl: params.imageUrl,
    title: resolved.title,
  });
  const baseDir = `semantic/workspace/artifacts/referenced-images/${slug}`;
  const rootPath = `${baseDir}/content.md`;
  const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
  const indexedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
  const rootBody = imageUrlDocumentRootBody({
    workspaceId: params.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    imageUrl: params.imageUrl,
    title: resolved.title,
    mimeType: resolved.mimeType,
    chunkCount: chunks.length,
    indexedAt,
    extractedText,
  });
  const rootSummary = chunks.length > 0
    ? `${resolved.mimeType ?? "image"} referenced image with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
    : `${resolved.mimeType ?? "image"} referenced image indexed as a first-class document.`;
  const nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId?: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: "active";
    isMaterialized?: boolean;
    metadata?: Record<string, unknown>;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: IMAGE_URL_DOCUMENT_NODE_KIND,
      path: rootPath,
      title: resolved.title,
      summary: rootSummary,
      bodySha256: sha256(rootBody),
      childCount: chunks.length,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        image_url: params.imageUrl,
        mime_type: resolved.mimeType,
        source_turn_input_id: params.turnResult.inputId,
        source_turn_input_position: params.sourceTurnInputPosition ?? null,
        source_session_id: params.turnResult.sessionId,
        related_entity_keys: [],
        relation_types: [],
      },
    },
  ];
  const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
  const evidenceRefs: Array<{
    workspaceId: string;
    category: "workspace";
    treeId: string;
    nodeId: string;
    refId: string;
    provider: string | null;
    accountNamespace: string | null;
    connectionId: string | null;
    externalObjectId: string;
    externalObjectType: string;
    sourceType: string;
    sourceEventId: string | null;
    sourceMessageId: string | null;
    sourceTurnInputId: string | null;
    observedAt: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId: rootNodeId,
      refId: `image-url:${sha256(params.imageUrl).slice(0, 16)}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.imageUrl,
      externalObjectType: "referenced_image_url",
      sourceType: "image_url",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        mime_type: resolved.mimeType,
        title: resolved.title,
        evidence_kind: "image_url_document",
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    },
  ];
  const searchDocs: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    path: string;
    childCount?: number;
    title: string;
    summary: string;
    bodyText: string;
    excerpt?: string | null;
    observedAt?: string | null;
    status?: "active";
    updatedAt?: string;
  }> = [
    {
      nodeId: rootNodeId,
      nodeClass: "semantic",
      nodeKind: IMAGE_URL_DOCUMENT_NODE_KIND,
      path: rootPath,
      childCount: chunks.length,
      title: resolved.title,
      summary: rootSummary,
      bodyText: [
        resolved.title,
        params.imageUrl,
        resolved.mimeType ?? "",
        extractedText ?? "",
      ].filter(Boolean).join("\n"),
      excerpt: extractedText ? compactWhitespace(extractedText).slice(0, 320) : compactWhitespace(params.imageUrl).slice(0, 320),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    },
  ];
  const bodiesByPath = new Map<string, string>([[rootPath, rootBody]]);

  for (const chunk of chunks) {
    const nodeId = imageUrlDocumentChunkNodeId(treeId, chunk.index);
    const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
    const chunkBody = imageUrlDocumentChunkBody({
      title: resolved.title,
      imageUrl: params.imageUrl,
      mimeType: resolved.mimeType,
      chunk,
      chunkCount: chunks.length,
    });
    nodes.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: IMAGE_URL_CHUNK_NODE_KIND,
      sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
      path: chunkPath,
      title: `${resolved.title} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodySha256: sha256(chunkBody),
      childCount: 0,
      observedAt: indexedAt,
      status: "active",
      isMaterialized: false,
      metadata: {
        image_url: params.imageUrl,
        mime_type: resolved.mimeType,
        chunk_index: chunk.index + 1,
        chunk_count: chunks.length,
      },
    });
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: nodeId,
      position: chunk.index + 1,
    });
    evidenceRefs.push({
      workspaceId: params.workspaceId,
      category: "workspace",
      treeId,
      nodeId,
      refId: `image-url:${sha256(params.imageUrl).slice(0, 16)}:chunk:${chunk.index + 1}`,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: params.imageUrl,
      externalObjectType: "referenced_image_url",
      sourceType: "image_url",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: params.turnResult.inputId,
      observedAt: indexedAt,
      metadata: {
        mime_type: resolved.mimeType,
        title: resolved.title,
        chunk_index: chunk.index + 1,
        evidence_kind: "image_url_document_chunk",
      },
      createdAt: indexedAt,
      updatedAt: indexedAt,
    });
    searchDocs.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: IMAGE_URL_CHUNK_NODE_KIND,
      path: chunkPath,
      childCount: 0,
      title: `${resolved.title} chunk ${chunk.index + 1}`,
      summary: chunk.summary,
      bodyText: chunk.content,
      excerpt: compactWhitespace(chunk.content).slice(0, 320),
      observedAt: indexedAt,
      status: "active",
      updatedAt: indexedAt,
    });
    bodiesByPath.set(chunkPath, chunkBody);
  }

  for (const [relativePath, body] of bodiesByPath) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
  }
  removeObsoleteFiles(
    absolutePathForRelative(workspaceDir, baseDir),
    new Set(
      [...bodiesByPath.keys()].map((relativePath) =>
        path.resolve(absolutePathForRelative(workspaceDir, relativePath))
      ),
    ),
  );

  params.store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    nodes,
    edges,
  });
  params.store.replaceSemanticMemoryEvidenceRefs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    refs: evidenceRefs,
  });
  params.store.syncSemanticMemorySearchDocs({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId,
    docs: searchDocs,
  });
}

function ensureWorkspaceToolResultArtifactTreesBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { syncSemanticMemoryRelations?: unknown }).syncSemanticMemoryRelations !== "function"
  ) {
    return;
  }
  if (params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_TOOL_RESULT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true") {
    return;
  }
  const existingTreeIds = new Set(
    listWorkspaceToolResultDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }).map((descriptor) => descriptor.treeId),
  );
  for (const turnResult of listAllWorkspaceCompletedTurnResults(params)) {
    for (const entry of integrationToolEvidenceEntriesFromTurnArtifacts(params.store, turnResult)
      .filter((item) => Boolean(item.resultBodyText || item.resultSummary))) {
      const treeId = toolResultTreeId(turnResult.inputId, entry.callId, entry.outputEventId);
      if (existingTreeIds.has(treeId)) {
        continue;
      }
      persistWorkspaceToolResultDocumentTreeFromEntry({
        store: params.store,
        workspaceId: params.workspaceId,
        turnResult,
        entry,
      });
      existingTreeIds.add(treeId);
    }
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_TOOL_RESULT_ARTIFACT_TREE_BACKFILL_KEY,
    value: "true",
  });
}

function ensureWorkspaceAttachmentArtifactTreesBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  if (params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ATTACHMENT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true") {
    return;
  }
  const existingTreeIds = new Set(
    listWorkspaceAttachmentDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }).map((descriptor) => descriptor.treeId),
  );
  for (const turnResult of listAllWorkspaceCompletedTurnResults(params)) {
    for (const [index, attachment] of inputAttachmentsForTurn(params.store, turnResult).entries()) {
      const treeId = attachmentTreeId(turnResult.inputId, attachment.id);
      if (existingTreeIds.has(treeId)) {
        continue;
      }
      persistWorkspaceAttachmentDocumentTreeFromAttachment({
        store: params.store,
        workspaceId: params.workspaceId,
        turnResult,
        attachment,
        sourceTurnInputPosition: index,
      });
      existingTreeIds.add(treeId);
    }
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ATTACHMENT_ARTIFACT_TREE_BACKFILL_KEY,
    value: "true",
  });
}

function ensureWorkspaceImageUrlArtifactTreesBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  if (params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_IMAGE_URL_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true") {
    return;
  }
  const existingTreeIds = new Set(
    listWorkspaceImageUrlDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }).map((descriptor) => descriptor.treeId),
  );
  for (const turnResult of listAllWorkspaceCompletedTurnResults(params)) {
    for (const [index, imageUrl] of inputImageUrlsForTurn(params.store, turnResult).entries()) {
      const treeId = imageUrlDocumentTreeId(turnResult.inputId, imageUrl);
      if (existingTreeIds.has(treeId)) {
        continue;
      }
      persistWorkspaceImageUrlDocumentTreeFromUrl({
        store: params.store,
        workspaceId: params.workspaceId,
        turnResult,
        imageUrl,
        sourceTurnInputPosition: index,
      });
      existingTreeIds.add(treeId);
    }
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_IMAGE_URL_ARTIFACT_TREE_BACKFILL_KEY,
    value: "true",
  });
}

function ensureWorkspaceArtifactSourceTurnInputPositionsBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  if (params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ARTIFACT_SOURCE_TURN_INPUT_POSITION_BACKFILL_KEY,
  }) === "true") {
    return;
  }

  const repairRootNodeMetadata = (paramsForNode: {
    treeId: string;
    rootNodeId: string;
    sourceTurnInputPosition: number;
  }): void => {
    const rootNode = params.store.getSemanticMemoryNode({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: paramsForNode.treeId,
      nodeId: paramsForNode.rootNodeId,
    });
    if (!rootNode) {
      return;
    }
    const metadata = rootNode.metadata && typeof rootNode.metadata === "object" && !Array.isArray(rootNode.metadata)
      ? { ...rootNode.metadata as Record<string, unknown> }
      : {};
    if (metadata.source_turn_input_position === paramsForNode.sourceTurnInputPosition) {
      return;
    }
    metadata.source_turn_input_position = paramsForNode.sourceTurnInputPosition;
    params.store.upsertSemanticMemoryNode({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: rootNode.treeId,
      nodeId: rootNode.nodeId,
      nodeClass: rootNode.nodeClass,
      nodeKind: rootNode.nodeKind,
      sourceLeafId: rootNode.sourceLeafId,
      path: rootNode.path,
      title: rootNode.title,
      summary: rootNode.summary,
      bodySha256: rootNode.bodySha256,
      childCount: rootNode.childCount,
      observedAt: rootNode.observedAt,
      status: rootNode.status,
      isMaterialized: rootNode.isMaterialized,
      metadata,
      createdAt: rootNode.createdAt,
      updatedAt: rootNode.updatedAt,
    });
  };

  for (const descriptor of listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  })) {
    if (descriptor.sourceTurnInputPosition === null) {
      continue;
    }
    repairRootNodeMetadata({
      treeId: descriptor.treeId,
      rootNodeId: descriptor.rootNodeId,
      sourceTurnInputPosition: descriptor.sourceTurnInputPosition,
    });
  }

  for (const descriptor of listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  })) {
    if (descriptor.sourceTurnInputPosition === null) {
      continue;
    }
    repairRootNodeMetadata({
      treeId: descriptor.treeId,
      rootNodeId: descriptor.rootNodeId,
      sourceTurnInputPosition: descriptor.sourceTurnInputPosition,
    });
  }

  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ARTIFACT_SOURCE_TURN_INPUT_POSITION_BACKFILL_KEY,
    value: "true",
  });
}

function ensureWorkspaceOutputArtifactTreesBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  if (params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_OUTPUT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true") {
    return;
  }
  const existingOutputIds = new Set(
    listWorkspaceOutputDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }).map((descriptor) => descriptor.outputId),
  );
  for (const output of listAllWorkspaceOutputs(params)) {
    if (existingOutputIds.has(output.id)) {
      continue;
    }
    // Same exclusion as the per-turn path: without it this one-shot backfill
    // would re-index every historical tool result on a fresh install, exactly
    // the flood the per-turn filter exists to prevent.
    if (isToolResultOutput(output)) {
      continue;
    }
    persistWorkspaceOutputDocumentTreeFromOutput({
      store: params.store,
      workspaceId: params.workspaceId,
      output,
    });
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_OUTPUT_ARTIFACT_TREE_BACKFILL_KEY,
    value: "true",
  });
}

export function ensureWorkspaceArtifactRelationsBackfilled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): void {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  const relationsBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ARTIFACT_RELATION_BACKFILL_V2_KEY,
  }) === "true";
  const sourceTurnInputPositionsBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ARTIFACT_SOURCE_TURN_INPUT_POSITION_BACKFILL_KEY,
  }) === "true";
  const toolResultTreesBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_TOOL_RESULT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true";
  const attachmentTreesBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_ATTACHMENT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true";
  const outputTreesBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_OUTPUT_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true";
  const imageUrlTreesBackfilled = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_IMAGE_URL_ARTIFACT_TREE_BACKFILL_KEY,
  }) === "true";
  const needsRelationSync = !relationsBackfilled
    || !toolResultTreesBackfilled
    || !attachmentTreesBackfilled
    || !outputTreesBackfilled
    || !imageUrlTreesBackfilled;
  if (
    relationsBackfilled
    && sourceTurnInputPositionsBackfilled
    && toolResultTreesBackfilled
    && attachmentTreesBackfilled
    && outputTreesBackfilled
    && imageUrlTreesBackfilled
  ) {
    return;
  }
  ensureWorkspaceToolResultArtifactTreesBackfilled(params);
  ensureWorkspaceAttachmentArtifactTreesBackfilled(params);
  ensureWorkspaceImageUrlArtifactTreesBackfilled(params);
  ensureWorkspaceOutputArtifactTreesBackfilled(params);
  ensureWorkspaceArtifactSourceTurnInputPositionsBackfilled(params);
  if (needsRelationSync) {
    syncWorkspaceArtifactRelations(params);
    params.store.setWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: WORKSPACE_ARTIFACT_RELATION_BACKFILL_KEY,
      value: "true",
    });
    params.store.setWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: WORKSPACE_ARTIFACT_RELATION_BACKFILL_V2_KEY,
      value: "true",
    });
  }
}

export function listWorkspaceAttachmentDocumentTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds?: ReadonlySet<string>;
}): WorkspaceAttachmentDocumentTreeDescriptor[] {
  const roots = params.store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: params.workspaceId,
    nodeKind: ATTACHMENT_DOCUMENT_NODE_KIND,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  const allowedTreeIds = params.allowedTreeIds ?? new Set<string>();
  return roots
    .map((node) => attachmentDescriptorFromRootNode(node))
    .map((descriptor) => {
      if (!descriptor || descriptor.sourceTurnInputPosition !== null || !descriptor.sourceTurnInputId) {
        return descriptor;
      }
      return {
        ...descriptor,
        sourceTurnInputPosition: sourceTurnInputAttachmentPosition({
          store: params.store,
          workspaceId: params.workspaceId,
          inputId: descriptor.sourceTurnInputId,
          attachmentId: descriptor.attachmentId,
        }),
      };
    })
    .filter((descriptor): descriptor is WorkspaceAttachmentDocumentTreeDescriptor => Boolean(descriptor))
    .filter((descriptor) => allowedTreeIds.size === 0 || allowedTreeIds.has(descriptor.treeId))
    .sort((left, right) =>
      left.title.localeCompare(right.title)
      || left.workspacePath.localeCompare(right.workspacePath)
      || left.treeId.localeCompare(right.treeId),
    );
}

export function listWorkspaceToolResultDocumentTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds?: ReadonlySet<string>;
}): WorkspaceToolResultDocumentTreeDescriptor[] {
  const roots = params.store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: params.workspaceId,
    nodeKind: TOOL_RESULT_DOCUMENT_NODE_KIND,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  const allowedTreeIds = params.allowedTreeIds ?? new Set<string>();
  return roots
    .map((node) => toolResultDescriptorFromRootNode(node))
    .filter((descriptor): descriptor is WorkspaceToolResultDocumentTreeDescriptor => Boolean(descriptor))
    .filter((descriptor) => allowedTreeIds.size === 0 || allowedTreeIds.has(descriptor.treeId))
    .sort((left, right) =>
      left.toolName.localeCompare(right.toolName)
      || left.accountNamespace.localeCompare(right.accountNamespace)
      || left.treeId.localeCompare(right.treeId),
    );
}

export function listWorkspaceOutputDocumentTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds?: ReadonlySet<string>;
}): WorkspaceOutputDocumentTreeDescriptor[] {
  const roots = params.store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: params.workspaceId,
    nodeKind: OUTPUT_DOCUMENT_NODE_KIND,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  const allowedTreeIds = params.allowedTreeIds ?? new Set<string>();
  return roots
    .map((node) => outputDescriptorFromRootNode(node))
    .filter((descriptor): descriptor is WorkspaceOutputDocumentTreeDescriptor => Boolean(descriptor))
    .filter((descriptor) => allowedTreeIds.size === 0 || allowedTreeIds.has(descriptor.treeId))
    .sort((left, right) =>
      left.title.localeCompare(right.title)
      || (left.filePath ?? "").localeCompare(right.filePath ?? "")
      || left.treeId.localeCompare(right.treeId),
    );
}

export function listWorkspaceImageUrlDocumentTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds?: ReadonlySet<string>;
}): WorkspaceImageUrlDocumentTreeDescriptor[] {
  const roots = params.store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: params.workspaceId,
    nodeKind: IMAGE_URL_DOCUMENT_NODE_KIND,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  const allowedTreeIds = params.allowedTreeIds ?? new Set<string>();
  return roots
    .map((node) => imageUrlDescriptorFromRootNode(node))
    .map((descriptor) => {
      if (!descriptor || descriptor.sourceTurnInputPosition !== null || !descriptor.sourceTurnInputId) {
        return descriptor;
      }
      return {
        ...descriptor,
        sourceTurnInputPosition: sourceTurnInputImageUrlPosition({
          store: params.store,
          workspaceId: params.workspaceId,
          inputId: descriptor.sourceTurnInputId,
          imageUrl: descriptor.imageUrl,
        }),
      };
    })
    .filter((descriptor): descriptor is WorkspaceImageUrlDocumentTreeDescriptor => Boolean(descriptor))
    .filter((descriptor) => allowedTreeIds.size === 0 || allowedTreeIds.has(descriptor.treeId))
    .sort((left, right) =>
      left.title.localeCompare(right.title)
      || left.imageUrl.localeCompare(right.imageUrl)
      || left.treeId.localeCompare(right.treeId),
    );
}

export function toolResultArtifactEvidenceFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): string[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 2);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 900);
  const descriptors = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .slice(0, maxDocuments);
  const evidence: string[] = [];
  for (const descriptor of descriptors) {
    const chunkDocs = params.store.listSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId: descriptor.treeId,
      nodeClass: "leaf",
      status: "active",
      limit: maxChunksPerDocument,
      offset: 0,
    });
    if (chunkDocs.length === 0) {
      continue;
    }
    for (const chunk of chunkDocs) {
      const excerpt = compactWhitespace(chunk.bodyText || chunk.excerpt || "").slice(0, maxCharsPerChunk);
      if (!excerpt) {
        continue;
      }
      evidence.push(compactWhitespace(
        `[tool_result ${descriptor.providerId} ${descriptor.accountNamespace}] ${descriptor.toolName} => ${excerpt}`,
      ));
    }
  }
  return evidence;
}

export function toolResultArtifactContextsFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): DurableMemoryArtifactContext[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  return listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .sort(compareToolResultArtifactContextDescriptors)
    .slice(0, maxDocuments)
    .map((descriptor) => ({
      sourceKind: "tool_result" as const,
      treeId: descriptor.treeId,
      title: descriptor.title,
      provider: descriptor.providerId,
      accountNamespace: descriptor.accountNamespace,
      canonicalEntityKey: canonicalToolResultArtifactEntityKey({
        providerId: descriptor.providerId,
        callId: descriptor.callId,
        outputEventId: descriptor.outputEventId,
        treeId: descriptor.treeId,
      }),
      excerpts: chunkExcerptsForArtifactTree({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId: descriptor.treeId,
        maxChunksPerDocument: params.maxChunksPerDocument,
        maxCharsPerChunk: params.maxCharsPerChunk,
      }),
    }));
}

export function artifactContextsForSourceTurnInput(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sourceTurnInputId: string;
  maxDocumentsPerKind?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): DurableMemoryArtifactContext[] {
  const sourceTurnInputId = params.sourceTurnInputId.trim();
  if (!sourceTurnInputId) {
    return [];
  }
  const maxDocumentsPerKind = Math.max(1, params.maxDocumentsPerKind ?? 6);
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 4);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 1_600);
  return [
    ...listWorkspaceToolResultDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    })
      .filter((descriptor) => descriptor.sourceTurnInputId === sourceTurnInputId)
      .sort(compareToolResultArtifactContextDescriptors)
      .slice(0, maxDocumentsPerKind)
      .map((descriptor) => ({
        sourceKind: "tool_result" as const,
        treeId: descriptor.treeId,
        title: descriptor.title,
        provider: descriptor.providerId,
        accountNamespace: descriptor.accountNamespace,
        canonicalEntityKey: canonicalToolResultArtifactEntityKey({
          providerId: descriptor.providerId,
          callId: descriptor.callId,
          outputEventId: descriptor.outputEventId,
          treeId: descriptor.treeId,
        }),
        excerpts: chunkExcerptsForArtifactTree({
          store: params.store,
          workspaceId: params.workspaceId,
          treeId: descriptor.treeId,
          maxChunksPerDocument,
          maxCharsPerChunk,
        }),
      })),
    ...listWorkspaceOutputDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    })
      .filter((descriptor) => descriptor.sourceTurnInputId === sourceTurnInputId)
      .sort(compareOutputArtifactContextDescriptors)
      .slice(0, maxDocumentsPerKind)
      .map((descriptor) => ({
        sourceKind: "output_artifact" as const,
        treeId: descriptor.treeId,
        title: descriptor.title,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalOutputArtifactEntityKey(descriptor.outputId),
        excerpts: chunkExcerptsForArtifactTree({
          store: params.store,
          workspaceId: params.workspaceId,
          treeId: descriptor.treeId,
          maxChunksPerDocument,
          maxCharsPerChunk,
        }),
      })),
    ...listWorkspaceImageUrlDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    })
      .filter((descriptor) => descriptor.sourceTurnInputId === sourceTurnInputId)
      .sort(compareImageUrlArtifactContextDescriptors)
      .slice(0, maxDocumentsPerKind)
      .map((descriptor) => ({
        sourceKind: "image_url" as const,
        treeId: descriptor.treeId,
        title: descriptor.title,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalImageUrlArtifactEntityKey(descriptor.imageUrl),
        excerpts: chunkExcerptsForArtifactTree({
          store: params.store,
          workspaceId: params.workspaceId,
          treeId: descriptor.treeId,
          maxChunksPerDocument,
          maxCharsPerChunk,
        }),
      })),
    ...listWorkspaceAttachmentDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    })
      .filter((descriptor) => descriptor.sourceTurnInputId === sourceTurnInputId)
      .sort(compareAttachmentArtifactContextDescriptors)
      .slice(0, maxDocumentsPerKind)
      .map((descriptor) => ({
        sourceKind: "attachment" as const,
        treeId: descriptor.treeId,
        title: descriptor.title,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalAttachmentArtifactEntityKey(descriptor.attachmentId),
        excerpts: chunkExcerptsForArtifactTree({
          store: params.store,
          workspaceId: params.workspaceId,
          treeId: descriptor.treeId,
          maxChunksPerDocument,
          maxCharsPerChunk,
        }),
      })),
  ]
    .map((context, index) => ({ context, index }))
    .sort((left, right) =>
      artifactContextPriority(left.context.sourceKind) - artifactContextPriority(right.context.sourceKind)
      || left.index - right.index,
    )
    .map(({ context }) => context);
}

export function attachmentArtifactEvidenceFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): string[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 2);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 900);
  const descriptors = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .slice(0, maxDocuments);
  const evidence: string[] = [];
  for (const descriptor of descriptors) {
    const chunkDocs = params.store.listSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId: descriptor.treeId,
      nodeClass: "leaf",
      status: "active",
      limit: maxChunksPerDocument,
      offset: 0,
    });
    if (chunkDocs.length === 0) {
      continue;
    }
    for (const chunk of chunkDocs) {
      const excerpt = compactWhitespace(chunk.bodyText || chunk.excerpt || "").slice(0, maxCharsPerChunk);
      if (!excerpt) {
        continue;
      }
      evidence.push(compactWhitespace(
        `[attachment_artifact ${descriptor.mimeType}] ${descriptor.title} => ${excerpt}`,
      ));
    }
  }
  return evidence;
}

export function attachmentArtifactContextsFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): DurableMemoryArtifactContext[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  return listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .sort(compareAttachmentArtifactContextDescriptors)
    .slice(0, maxDocuments)
    .map((descriptor) => ({
      sourceKind: "attachment" as const,
      treeId: descriptor.treeId,
      title: descriptor.title,
      provider: null,
      accountNamespace: null,
      canonicalEntityKey: canonicalAttachmentArtifactEntityKey(descriptor.attachmentId),
      excerpts: chunkExcerptsForArtifactTree({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId: descriptor.treeId,
        maxChunksPerDocument: params.maxChunksPerDocument,
        maxCharsPerChunk: params.maxCharsPerChunk,
      }),
    }));
}

export function outputArtifactEvidenceFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): string[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 2);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 900);
  const descriptors = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .slice(0, maxDocuments);
  const evidence: string[] = [];
  for (const descriptor of descriptors) {
    const chunkDocs = params.store.listSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId: descriptor.treeId,
      nodeClass: "leaf",
      status: "active",
      limit: maxChunksPerDocument,
      offset: 0,
    });
    if (chunkDocs.length === 0) {
      continue;
    }
    for (const chunk of chunkDocs) {
      const excerpt = compactWhitespace(chunk.bodyText || chunk.excerpt || "").slice(0, maxCharsPerChunk);
      if (!excerpt) {
        continue;
      }
      evidence.push(compactWhitespace(
        `[output_artifact ${descriptor.outputType}] ${descriptor.title} => ${excerpt}`,
      ));
    }
  }
  return evidence;
}

export function outputArtifactContextsFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): DurableMemoryArtifactContext[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  return listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .sort(compareOutputArtifactContextDescriptors)
    .slice(0, maxDocuments)
    .map((descriptor) => ({
      sourceKind: "output_artifact" as const,
      treeId: descriptor.treeId,
      title: descriptor.title,
      provider: null,
      accountNamespace: null,
      canonicalEntityKey: canonicalOutputArtifactEntityKey(descriptor.outputId),
      excerpts: chunkExcerptsForArtifactTree({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId: descriptor.treeId,
        maxChunksPerDocument: params.maxChunksPerDocument,
        maxCharsPerChunk: params.maxCharsPerChunk,
      }),
    }));
}

export function imageUrlArtifactEvidenceFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): string[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  const maxChunksPerDocument = Math.max(1, params.maxChunksPerDocument ?? 2);
  const maxCharsPerChunk = Math.max(120, params.maxCharsPerChunk ?? 900);
  const descriptors = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .slice(0, maxDocuments);
  const evidence: string[] = [];
  for (const descriptor of descriptors) {
    const chunkDocs = params.store.listSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId: descriptor.treeId,
      nodeClass: "leaf",
      status: "active",
      limit: maxChunksPerDocument,
      offset: 0,
    });
    if (chunkDocs.length === 0) {
      continue;
    }
    for (const chunk of chunkDocs) {
      const excerpt = compactWhitespace(chunk.bodyText || chunk.excerpt || "").slice(0, maxCharsPerChunk);
      if (!excerpt) {
        continue;
      }
      evidence.push(compactWhitespace(
        `[image_url_artifact ${descriptor.mimeType ?? "image"}] ${descriptor.title} => ${excerpt}`,
      ));
    }
  }
  return evidence;
}

export function imageUrlArtifactContextsFromTurnDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxCharsPerChunk?: number;
}): DurableMemoryArtifactContext[] {
  const maxDocuments = Math.max(1, params.maxDocuments ?? 2);
  return listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  })
    .filter((descriptor) => descriptor.sourceTurnInputId === params.turnResult.inputId)
    .sort(compareImageUrlArtifactContextDescriptors)
    .slice(0, maxDocuments)
    .map((descriptor) => ({
      sourceKind: "image_url" as const,
      treeId: descriptor.treeId,
      title: descriptor.title,
      provider: null,
      accountNamespace: null,
      canonicalEntityKey: canonicalImageUrlArtifactEntityKey(descriptor.imageUrl),
      excerpts: chunkExcerptsForArtifactTree({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId: descriptor.treeId,
        maxChunksPerDocument: params.maxChunksPerDocument,
        maxCharsPerChunk: params.maxCharsPerChunk,
      }),
    }));
}

export async function persistTurnInputAttachmentsAsDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  embeddingClient?: MemoryModelClientConfig | null;
  visionModelClient?: MemoryModelClientConfig | null;
  relatedInfoModelClient?: MemoryModelClientConfig | null;
}): Promise<string[]> {
  const attachments = inputAttachmentsForTurn(params.store, params.turnResult);
  if (attachments.length === 0) {
    return [];
  }
  const workspaceDir = params.store.workspaceDir(params.turnResult.workspaceId);
  const treeIds: string[] = [];
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  });

  for (const [attachmentIndex, attachment] of attachments.entries()) {
    const treeId = attachmentTreeId(params.turnResult.inputId, attachment.id);
    const rootNodeId = attachmentDocumentRootNodeId(treeId);
    const slug = attachmentDocumentSlug({
      inputId: params.turnResult.inputId,
      attachment,
    });
    const baseDir = `semantic/workspace/artifacts/${slug}`;
    const rootPath = `${baseDir}/content.md`;
    const extractedText = await readAttachmentTextContent({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      attachment,
      visionModelClient: params.visionModelClient ?? null,
    });
    const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
    const indexedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
    const rootBody = attachmentDocumentRootBody({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
      attachment,
      chunkCount: chunks.length,
      indexedAt,
      extractedText,
    });
    const rootSummary = chunks.length > 0
      ? `${attachment.mimeType} attachment with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
      : `${attachment.mimeType} attachment indexed as a first-class document.`;
    const artifactContexts: DurableMemoryArtifactContext[] = [
      {
        sourceKind: "attachment",
        treeId,
        title: attachment.name,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalAttachmentArtifactEntityKey(attachment.id),
        excerpts: [],
      },
    ];
    const relatedInfo = await extractArtifactDocumentRelatedInfo({
      modelClient: params.relatedInfoModelClient ?? null,
      subjectKey: `attachment:${attachment.id}`,
      title: attachment.name,
      summary: rootSummary,
      content: artifactRelatedExtractionContent({
        rootBody,
        extractedText,
      }),
      tags: ["artifact", "attachment", attachment.mimeType],
      artifactContexts,
      resolver: relatedEntityResolver,
      sourceTurnInputId: params.turnResult.inputId,
    });
    const rootBodyWithRelations =
      relatedInfo.relatedEntities.length > 0 || relatedInfo.relations.length > 0
        ? appendDurableMemoryRelatedSections(rootBody, relatedInfo)
        : rootBody;

    const nodes: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown>;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: ATTACHMENT_DOCUMENT_NODE_KIND,
        path: rootPath,
        title: attachment.name,
        summary: rootSummary,
        bodySha256: sha256(rootBodyWithRelations),
        childCount: chunks.length,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          attachment_id: attachment.id,
          kind: attachment.kind,
          mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        workspace_path: attachment.workspacePath,
        source_turn_input_id: params.turnResult.inputId,
        source_turn_input_position: attachmentIndex,
        source_session_id: params.turnResult.sessionId,
        related_entity_keys: relatedInfo.relatedEntities.map((entity) => entity.entityKey),
        relation_types: [...new Set(relatedInfo.relations.map((relation) => relation.relationType))],
        },
      },
    ];
    const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
    const bodiesByPath = new Map<string, string>([[rootPath, rootBodyWithRelations]]);
    const evidenceRefs: Array<{
      workspaceId: string;
      category: "workspace";
      treeId: string;
      nodeId: string;
      refId: string;
      provider: null;
      accountNamespace: null;
      connectionId: null;
      externalObjectId: string;
      externalObjectType: string;
      sourceType: string;
      sourceEventId: string | null;
      sourceMessageId: null;
      sourceTurnInputId: string;
      observedAt: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }> = [
      {
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId: rootNodeId,
        refId: `attachment:${attachment.id}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: attachment.id,
        externalObjectType: "input_attachment",
        sourceType: "attachment",
        sourceEventId: params.turnResult.inputId,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          kind: attachment.kind,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          workspace_path: attachment.workspacePath,
          attachment_name: attachment.name,
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      },
    ];
    const searchDocs: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: "active";
      updatedAt?: string;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: ATTACHMENT_DOCUMENT_NODE_KIND,
        path: rootPath,
        childCount: chunks.length,
        title: attachment.name,
        summary: rootSummary,
        bodyText: [
          attachment.name,
          attachment.mimeType,
          attachment.workspacePath,
          extractedText ?? "",
        ].filter(Boolean).join("\n"),
        excerpt: extractedText ? compactWhitespace(extractedText).slice(0, 320) : null,
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      },
    ];

    for (const chunk of chunks) {
      const nodeId = attachmentDocumentChunkNodeId(treeId, chunk.index);
      const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
      const chunkBody = attachmentDocumentChunkBody({
        attachment,
        chunk,
        chunkCount: chunks.length,
      });
      nodes.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: ATTACHMENT_CHUNK_NODE_KIND,
        sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
        path: chunkPath,
        title: `${attachment.name} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodySha256: sha256(chunkBody),
        childCount: 0,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          attachment_id: attachment.id,
          chunk_index: chunk.index + 1,
          chunk_count: chunks.length,
          workspace_path: attachment.workspacePath,
        },
      });
      edges.push({
        parentNodeId: rootNodeId,
        childNodeId: nodeId,
        position: chunk.index + 1,
      });
      bodiesByPath.set(chunkPath, chunkBody);
      evidenceRefs.push({
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId,
        refId: `attachment:${attachment.id}:chunk:${chunk.index + 1}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: attachment.id,
        externalObjectType: "input_attachment",
        sourceType: "attachment",
        sourceEventId: params.turnResult.inputId,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          kind: attachment.kind,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          workspace_path: attachment.workspacePath,
          attachment_name: attachment.name,
          chunk_index: chunk.index + 1,
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      });
      searchDocs.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: ATTACHMENT_CHUNK_NODE_KIND,
        path: chunkPath,
        childCount: 0,
        title: `${attachment.name} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodyText: chunk.content,
        excerpt: compactWhitespace(chunk.content).slice(0, 320),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      });
    }

    for (const [relativePath, body] of bodiesByPath) {
      writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
    }
    removeObsoleteFiles(
      absolutePathForRelative(workspaceDir, baseDir),
      new Set(
        [...bodiesByPath.keys()].map((relativePath) =>
          path.resolve(absolutePathForRelative(workspaceDir, relativePath))
        ),
      ),
    );

    params.store.syncSemanticMemoryTree({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodes,
      edges,
    });
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      relations: artifactDocumentRelations({
        workspaceId: params.turnResult.workspaceId,
        treeId,
        rootNodeId,
        relatedInfo,
        artifactContexts,
        resolver: relatedEntityResolver,
        sourceTurnInputId: params.turnResult.inputId,
      }),
    });
    params.store.replaceSemanticMemoryEvidenceRefs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      refs: evidenceRefs,
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      docs: searchDocs,
    });
    await syncAttachmentNodeEmbedding({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodeId: rootNodeId,
      nodeKind: "summary",
      attachment,
      title: attachment.name,
      summary: rootSummary,
      body: rootBody,
      embeddingClient: params.embeddingClient ?? null,
    });
    for (const chunk of chunks) {
      const nodeId = attachmentDocumentChunkNodeId(treeId, chunk.index);
      await syncAttachmentNodeEmbedding({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId,
        nodeId,
        nodeKind: "leaf",
        attachment,
        title: `${attachment.name} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        body: chunk.content,
        embeddingClient: params.embeddingClient ?? null,
      });
    }
    treeIds.push(treeId);
  }

  return treeIds;
}

/**
 * Path segment the harness offloads capped tool results to
 * (`tmp/.tool-results/<tool>-<call_id>.json`, TOOL_OUTPUT_OVERFLOW_DIR in
 * harness-host/pi.ts). Kept as a literal rather than imported: api-server does
 * not depend on harness-host, and this is a stable on-disk layout.
 */
const TOOL_RESULT_OUTPUT_DIR_SEGMENTS = [
  "tmp/.tool-results/",
  // Pre-existing workspaces still have spills under outputs/; keep excluding
  // them from semantic memory or an upgrade would re-import old junk.
  "outputs/.tool-results/",
];

/**
 * Tool results are transcript/evidence, not durable semantic knowledge — the
 * same rationale already applied to integration tool results in
 * turn-memory-writeback. They are high-volume, machine-generated, and often
 * binary: a screenshot arrives as JSON carrying a base64 PNG, so the mime guard
 * treats it as prose and one call chunks into ~5k nodes.
 *
 * Measured on a real workspace before this filter: tool-result artifacts were
 * 99.5% of semantic memory (69,146 of 69,463 nodes) and 512 of 603 trees, of
 * which 56% was base64 screenshot data. That flooded the single global graph
 * every context recalls from, and made per-tree retrieval scale with junk.
 *
 * Durable capture is the agent-invoked `remember` tool. The files stay on disk
 * and remain fully retrievable by path — only the memory indexing is skipped.
 */
function isToolResultOutput(output: { filePath?: string | null }): boolean {
  const normalized = (output.filePath ?? "").replace(/\\/g, "/");
  return TOOL_RESULT_OUTPUT_DIR_SEGMENTS.some((segment) =>
    normalized.includes(segment),
  );
}

export async function persistTurnOutputArtifactsAsDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  embeddingClient?: MemoryModelClientConfig | null;
  visionModelClient?: MemoryModelClientConfig | null;
  relatedInfoModelClient?: MemoryModelClientConfig | null;
}): Promise<string[]> {
  const outputs = params.store.listOutputs({
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    limit: 10_000,
    offset: 0,
  }).filter((output) => output.status !== "deleted" && !isToolResultOutput(output));
  if (outputs.length === 0) {
    return [];
  }
  const workspaceDir = params.store.workspaceDir(params.turnResult.workspaceId);
  const treeIds: string[] = [];
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  });

  for (const output of outputs) {
    const treeId = outputDocumentTreeId(output.id);
    const rootNodeId = outputDocumentRootNodeId(treeId);
    const slug = outputDocumentSlug(output);
    const baseDir = `semantic/workspace/artifacts/outputs/${slug}`;
    const rootPath = `${baseDir}/content.md`;
    const extractedText = await readOutputTextContent({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      output,
      visionModelClient: params.visionModelClient ?? null,
    });
    const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
    const indexedAt = output.updatedAt ?? output.createdAt ?? params.turnResult.completedAt ?? params.turnResult.updatedAt;
    const rootBody = outputDocumentRootBody({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
      output,
      chunkCount: chunks.length,
      indexedAt,
      extractedText,
    });
    const rootSummary = chunks.length > 0
      ? `${output.outputType} output with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
      : `${output.outputType} output indexed as a first-class document.`;
    const metadata = output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)
      ? output.metadata as Record<string, unknown>
      : {};
    const artifactContexts: DurableMemoryArtifactContext[] = [
      {
        sourceKind: "output_artifact",
        treeId,
        title: output.title || output.filePath || output.id,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalOutputArtifactEntityKey(output.id),
        excerpts: [],
      },
    ];
    const relatedInfo = await extractArtifactDocumentRelatedInfo({
      modelClient: params.relatedInfoModelClient ?? null,
      subjectKey: `output:${output.id}`,
      title: output.title || output.filePath || output.id,
      summary: rootSummary,
      content: artifactRelatedExtractionContent({
        rootBody,
        extractedText,
      }),
      tags: ["artifact", "output", output.outputType, output.platform ?? ""].filter(Boolean),
      artifactContexts,
      resolver: relatedEntityResolver,
      sourceTurnInputId: params.turnResult.inputId,
    });
    const rootBodyWithRelations =
      relatedInfo.relatedEntities.length > 0 || relatedInfo.relations.length > 0
        ? appendDurableMemoryRelatedSections(rootBody, relatedInfo)
        : rootBody;

    const nodes: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown>;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: OUTPUT_DOCUMENT_NODE_KIND,
        path: rootPath,
        title: output.title || output.filePath || output.id,
        summary: rootSummary,
        bodySha256: sha256(rootBodyWithRelations),
        childCount: chunks.length,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          output_id: output.id,
          output_type: output.outputType,
          file_path: output.filePath,
          artifact_id: output.artifactId,
          platform: output.platform,
          module_id: output.moduleId,
          module_resource_id: output.moduleResourceId,
          source_turn_input_id: params.turnResult.inputId,
          source_session_id: params.turnResult.sessionId,
          origin_type: typeof metadata.origin_type === "string" ? metadata.origin_type : null,
          forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
          source_event_id: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
          source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
          related_entity_keys: relatedInfo.relatedEntities.map((entity) => entity.entityKey),
          relation_types: [...new Set(relatedInfo.relations.map((relation) => relation.relationType))],
        },
      },
    ];
    const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
    const bodiesByPath = new Map<string, string>([[rootPath, rootBodyWithRelations]]);
    const evidenceRefs: Array<{
      workspaceId: string;
      category: "workspace";
      treeId: string;
      nodeId: string;
      refId: string;
      provider: string | null;
      accountNamespace: string | null;
      connectionId: string | null;
      externalObjectId: string | null;
      externalObjectType: string | null;
      sourceType: string | null;
      sourceEventId: string | null;
      sourceMessageId: null;
      sourceTurnInputId: string;
      observedAt: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }> = [
      {
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId: rootNodeId,
        refId: `output:${output.id}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: output.id,
        externalObjectType: "workspace_output_artifact",
        sourceType: typeof metadata.origin_type === "string" ? metadata.origin_type : "output",
        sourceEventId: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          artifact_id: output.artifactId,
          output_type: output.outputType,
          file_path: output.filePath,
          platform: output.platform,
          module_id: output.moduleId,
          module_resource_id: output.moduleResourceId,
          evidence_kind: "workspace_output_document",
          source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
          forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      },
    ];
    const searchDocs: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: "active";
      updatedAt?: string;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: OUTPUT_DOCUMENT_NODE_KIND,
        path: rootPath,
        childCount: chunks.length,
        title: output.title || output.filePath || output.id,
        summary: rootSummary,
        bodyText: [
          output.title,
          output.filePath ?? "",
          output.outputType,
          output.platform ?? "",
          output.moduleId ?? "",
          extractedText ?? "",
        ].filter(Boolean).join("\n"),
        excerpt: extractedText ? compactWhitespace(extractedText).slice(0, 320) : rootSummary,
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      },
    ];

    for (const chunk of chunks) {
      const nodeId = outputDocumentChunkNodeId(treeId, chunk.index);
      const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
      const chunkBody = outputDocumentChunkBody({
        output,
        chunk,
        chunkCount: chunks.length,
      });
      nodes.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: OUTPUT_CHUNK_NODE_KIND,
        sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
        path: chunkPath,
        title: `${output.title || output.filePath || output.id} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodySha256: sha256(chunkBody),
        childCount: 0,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          output_id: output.id,
          output_type: output.outputType,
          file_path: output.filePath,
          artifact_id: output.artifactId,
          chunk_index: chunk.index + 1,
          chunk_count: chunks.length,
          forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
          source_event_id: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
          source_subagent_id: typeof metadata.source_subagent_id === "string" ? metadata.source_subagent_id : null,
        },
      });
      edges.push({
        parentNodeId: rootNodeId,
        childNodeId: nodeId,
        position: chunk.index + 1,
      });
      bodiesByPath.set(chunkPath, chunkBody);
      evidenceRefs.push({
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId,
        refId: `output:${output.id}:chunk:${chunk.index + 1}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: output.id,
        externalObjectType: "workspace_output_artifact",
        sourceType: typeof metadata.origin_type === "string" ? metadata.origin_type : "output",
        sourceEventId: typeof metadata.source_event_id === "string" ? metadata.source_event_id : null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          artifact_id: output.artifactId,
          output_type: output.outputType,
          file_path: output.filePath,
          chunk_index: chunk.index + 1,
          evidence_kind: "workspace_output_document_chunk",
          forwarded_output_id: typeof metadata.forwarded_output_id === "string" ? metadata.forwarded_output_id : null,
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      });
      searchDocs.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: OUTPUT_CHUNK_NODE_KIND,
        path: chunkPath,
        childCount: 0,
        title: `${output.title || output.filePath || output.id} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodyText: chunk.content,
        excerpt: compactWhitespace(chunk.content).slice(0, 320),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      });
    }

    for (const [relativePath, body] of bodiesByPath) {
      writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
    }
    removeObsoleteFiles(
      absolutePathForRelative(workspaceDir, baseDir),
      new Set(
        [...bodiesByPath.keys()].map((relativePath) =>
          path.resolve(absolutePathForRelative(workspaceDir, relativePath))
        ),
      ),
    );

    params.store.syncSemanticMemoryTree({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodes,
      edges,
    });
    params.store.replaceSemanticMemoryEvidenceRefs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      refs: evidenceRefs,
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      docs: searchDocs,
    });
    await syncOutputNodeEmbedding({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodeId: rootNodeId,
      nodeKind: "summary",
      output,
      title: output.title || output.filePath || output.id,
      summary: rootSummary,
      body: rootBodyWithRelations,
      embeddingClient: params.embeddingClient ?? null,
    });
    for (const chunk of chunks) {
      const nodeId = outputDocumentChunkNodeId(treeId, chunk.index);
      await syncOutputNodeEmbedding({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId,
        nodeId,
        nodeKind: "leaf",
        output,
        title: `${output.title || output.filePath || output.id} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        body: chunk.content,
        embeddingClient: params.embeddingClient ?? null,
      });
    }
    treeIds.push(treeId);
  }

  syncWorkspaceOutputArtifactRelations({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  });

  return treeIds;
}

export async function persistTurnReferencedImageUrlsAsDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  embeddingClient?: MemoryModelClientConfig | null;
  visionModelClient?: MemoryModelClientConfig | null;
  relatedInfoModelClient?: MemoryModelClientConfig | null;
}): Promise<string[]> {
  const imageUrls = inputImageUrlsForTurn(params.store, params.turnResult);
  if (imageUrls.length === 0) {
    return [];
  }
  const workspaceDir = params.store.workspaceDir(params.turnResult.workspaceId);
  const treeIds: string[] = [];
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  });

  for (const [imageUrlIndex, imageUrl] of imageUrls.entries()) {
    const resolved = await readReferencedImageUrlTextContent({
      workspaceDir,
      imageUrl,
      visionModelClient: params.visionModelClient ?? null,
    });
    const treeId = imageUrlDocumentTreeId(params.turnResult.inputId, imageUrl);
    const rootNodeId = imageUrlDocumentRootNodeId(treeId);
    const slug = imageUrlDocumentSlug({
      inputId: params.turnResult.inputId,
      imageUrl,
      title: resolved.title,
    });
    const baseDir = `semantic/workspace/artifacts/referenced-images/${slug}`;
    const rootPath = `${baseDir}/content.md`;
    const chunks = resolved.extractedText ? splitAttachmentTextIntoChunks(resolved.extractedText) : [];
    const indexedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
    const rootBody = imageUrlDocumentRootBody({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
      imageUrl,
      title: resolved.title,
      mimeType: resolved.mimeType,
      chunkCount: chunks.length,
      indexedAt,
      extractedText: resolved.extractedText,
    });
    const rootSummary = chunks.length > 0
      ? `${resolved.mimeType ?? "image"} referenced image with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
      : `${resolved.mimeType ?? "image"} referenced image indexed as a first-class document.`;
    const artifactContexts: DurableMemoryArtifactContext[] = [
      {
        sourceKind: "image_url",
        treeId,
        title: resolved.title,
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: canonicalImageUrlArtifactEntityKey(imageUrl),
        excerpts: [],
      },
    ];
    const relatedInfo = await extractArtifactDocumentRelatedInfo({
      modelClient: params.relatedInfoModelClient ?? null,
      subjectKey: `image_url:${sha256(imageUrl).slice(0, 16)}`,
      title: resolved.title,
      summary: rootSummary,
      content: artifactRelatedExtractionContent({
        rootBody,
        extractedText: resolved.extractedText,
      }),
      tags: ["artifact", "image_url", resolved.mimeType ?? "image"],
      artifactContexts,
      resolver: relatedEntityResolver,
      sourceTurnInputId: params.turnResult.inputId,
    });
    const rootBodyWithRelations =
      relatedInfo.relatedEntities.length > 0 || relatedInfo.relations.length > 0
        ? appendDurableMemoryRelatedSections(rootBody, relatedInfo)
        : rootBody;

    const nodes: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount: number;
      observedAt: string;
      status: "active";
      isMaterialized: boolean;
      metadata: Record<string, unknown>;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: IMAGE_URL_DOCUMENT_NODE_KIND,
        path: rootPath,
        title: resolved.title,
        summary: rootSummary,
        bodySha256: sha256(rootBodyWithRelations),
        childCount: chunks.length,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          image_url: imageUrl,
          mime_type: resolved.mimeType,
          source_turn_input_id: params.turnResult.inputId,
          source_turn_input_position: imageUrlIndex,
          source_session_id: params.turnResult.sessionId,
          related_entity_keys: relatedInfo.relatedEntities.map((entity) => entity.entityKey),
          relation_types: [...new Set(relatedInfo.relations.map((relation) => relation.relationType))],
        },
      },
    ];
    const edges: Array<{
      parentNodeId: string;
      childNodeId: string;
      position: number;
    }> = [];
    const evidenceRefs: Array<{
      workspaceId: string;
      category: "workspace";
      treeId: string;
      nodeId: string;
      refId: string;
      provider: string | null;
      accountNamespace: string | null;
      connectionId: string | null;
      externalObjectId: string;
      externalObjectType: string;
      sourceType: string;
      sourceEventId: string | null;
      sourceMessageId: string | null;
      sourceTurnInputId: string | null;
      observedAt: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }> = [
      {
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId: rootNodeId,
        refId: `image-url:${sha256(imageUrl).slice(0, 16)}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: imageUrl,
        externalObjectType: "referenced_image_url",
        sourceType: "image_url",
        sourceEventId: null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          mime_type: resolved.mimeType,
          title: resolved.title,
          evidence_kind: "image_url_document",
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      },
    ];
    const searchDocs: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      childCount: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt: string | null;
      observedAt: string;
      status: "active";
      updatedAt: string;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: IMAGE_URL_DOCUMENT_NODE_KIND,
        path: rootPath,
        childCount: chunks.length,
        title: resolved.title,
        summary: rootSummary,
        bodyText: [
          resolved.title,
          imageUrl,
          resolved.mimeType ?? "",
          resolved.extractedText ?? "",
        ].filter(Boolean).join("\n"),
        excerpt: resolved.extractedText ? compactWhitespace(resolved.extractedText).slice(0, 320) : compactWhitespace(imageUrl).slice(0, 320),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      },
    ];
    const bodiesByPath = new Map<string, string>([
      [rootPath, rootBodyWithRelations],
    ]);

    for (const chunk of chunks) {
      const nodeId = imageUrlDocumentChunkNodeId(treeId, chunk.index);
      const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
      const chunkBody = imageUrlDocumentChunkBody({
        title: resolved.title,
        imageUrl,
        mimeType: resolved.mimeType,
        chunk,
        chunkCount: chunks.length,
      });
      nodes.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: IMAGE_URL_CHUNK_NODE_KIND,
        sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
        path: chunkPath,
        title: `${resolved.title} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodySha256: sha256(chunkBody),
        childCount: 0,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          image_url: imageUrl,
          mime_type: resolved.mimeType,
          chunk_index: chunk.index + 1,
          chunk_count: chunks.length,
        },
      });
      edges.push({
        parentNodeId: rootNodeId,
        childNodeId: nodeId,
        position: chunk.index + 1,
      });
      evidenceRefs.push({
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId,
        refId: `image-url:${sha256(imageUrl).slice(0, 16)}:chunk:${chunk.index + 1}`,
        provider: null,
        accountNamespace: null,
        connectionId: null,
        externalObjectId: imageUrl,
        externalObjectType: "referenced_image_url",
        sourceType: "image_url",
        sourceEventId: null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          mime_type: resolved.mimeType,
          title: resolved.title,
          chunk_index: chunk.index + 1,
          evidence_kind: "image_url_document_chunk",
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      });
      searchDocs.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: IMAGE_URL_CHUNK_NODE_KIND,
        path: chunkPath,
        childCount: 0,
        title: `${resolved.title} chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodyText: chunk.content,
        excerpt: compactWhitespace(chunk.content).slice(0, 320),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      });
      bodiesByPath.set(chunkPath, chunkBody);
    }

    for (const [relativePath, body] of bodiesByPath) {
      writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
    }
    removeObsoleteFiles(
      absolutePathForRelative(workspaceDir, baseDir),
      new Set(
        [...bodiesByPath.keys()].map((relativePath) =>
          path.resolve(absolutePathForRelative(workspaceDir, relativePath))
        ),
      ),
    );

    params.store.syncSemanticMemoryTree({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodes,
      edges,
    });
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      relations: artifactDocumentRelations({
        workspaceId: params.turnResult.workspaceId,
        treeId,
        rootNodeId,
        relatedInfo,
        artifactContexts,
        resolver: relatedEntityResolver,
        sourceTurnInputId: params.turnResult.inputId,
      }),
    });
    params.store.replaceSemanticMemoryEvidenceRefs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      refs: evidenceRefs,
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      docs: searchDocs,
    });
    await syncImageUrlNodeEmbedding({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodeId: rootNodeId,
      nodeKind: "summary",
      title: resolved.title,
      imageUrl,
      mimeType: resolved.mimeType,
      summary: rootSummary,
      body: rootBodyWithRelations,
      embeddingClient: params.embeddingClient ?? null,
    });
    for (const chunk of chunks) {
      const nodeId = imageUrlDocumentChunkNodeId(treeId, chunk.index);
      await syncImageUrlNodeEmbedding({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId,
        nodeId,
        nodeKind: "leaf",
        title: `${resolved.title} chunk ${chunk.index + 1}`,
        imageUrl,
        mimeType: resolved.mimeType,
        summary: chunk.summary,
        body: chunk.content,
        embeddingClient: params.embeddingClient ?? null,
      });
    }
    treeIds.push(treeId);
  }

  return treeIds;
}

export async function persistTurnIntegrationToolResultsAsDocuments(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  embeddingClient?: MemoryModelClientConfig | null;
  relatedInfoModelClient?: MemoryModelClientConfig | null;
}): Promise<string[]> {
  const entries = integrationToolEvidenceEntriesFromTurnArtifacts(params.store, params.turnResult)
    .filter((entry) => Boolean(entry.resultBodyText || entry.resultSummary));
  if (entries.length === 0) {
    return [];
  }
  const workspaceDir = params.store.workspaceDir(params.turnResult.workspaceId);
  const treeIds: string[] = [];
  const relatedEntityResolver = workspaceRelatedEntityResolver({
    store: params.store,
    workspaceId: params.turnResult.workspaceId,
  });

  for (const entry of entries) {
    const treeId = toolResultTreeId(params.turnResult.inputId, entry.callId, entry.outputEventId);
    const rootNodeId = toolResultDocumentRootNodeId(treeId);
    const slug = toolResultDocumentSlug(entry);
    const baseDir = `semantic/workspace/artifacts/tool-results/${slug}`;
    const rootPath = `${baseDir}/content.md`;
    const extractedText = entry.resultBodyText;
    const chunks = extractedText ? splitAttachmentTextIntoChunks(extractedText) : [];
    const indexedAt = entry.observedAt || params.turnResult.completedAt || params.turnResult.updatedAt;
    const rootBody = toolResultDocumentRootBody({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
      entry,
      chunkCount: chunks.length,
      indexedAt,
    });
    const rootSummary = chunks.length > 0
      ? `${entry.providerId} ${entry.toolName} result with ${chunks.length} searchable chunk${chunks.length === 1 ? "" : "s"}.`
      : `${entry.providerId} ${entry.toolName} result indexed as a first-class document.`;
    const artifactContexts: DurableMemoryArtifactContext[] = [
      {
        sourceKind: "tool_result",
        treeId,
        title: `${entry.toolName} result`,
        provider: entry.providerId,
        accountNamespace: entry.accountNamespace,
        canonicalEntityKey: canonicalToolResultArtifactEntityKey({
          providerId: entry.providerId,
          callId: entry.callId,
          outputEventId: entry.outputEventId,
          treeId,
        }),
        excerpts: [],
      },
    ];
    const relatedInfo = await extractArtifactDocumentRelatedInfo({
      modelClient: params.relatedInfoModelClient ?? null,
      subjectKey: `tool_result:${entry.callId ?? entry.outputEventId ?? treeId}`,
      title: `${entry.toolName} result`,
      summary: rootSummary,
      content: artifactRelatedExtractionContent({
        rootBody,
        extractedText,
      }),
      tags: [
        "artifact",
        "tool_result",
        entry.providerId,
        entry.toolName,
        entry.accountNamespace,
      ].filter(Boolean),
      artifactContexts,
      resolver: relatedEntityResolver,
      sourceTurnInputId: params.turnResult.inputId,
    });
    const rootBodyWithRelations =
      relatedInfo.relatedEntities.length > 0 || relatedInfo.relations.length > 0
        ? appendDurableMemoryRelatedSections(rootBody, relatedInfo)
        : rootBody;

    const nodes: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      sourceLeafId?: string | null;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown>;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: TOOL_RESULT_DOCUMENT_NODE_KIND,
        path: rootPath,
        title: `${entry.toolName} result`,
        summary: rootSummary,
        bodySha256: sha256(rootBodyWithRelations),
        childCount: chunks.length,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          provider_id: entry.providerId,
          account_namespace: entry.accountNamespace,
          connection_id: entry.connectionId,
          tool_name: entry.toolName,
          tool_id: entry.toolId,
          call_id: entry.callId,
          output_event_id: entry.outputEventId,
          source_turn_input_id: params.turnResult.inputId,
          source_session_id: params.turnResult.sessionId,
          related_entity_keys: relatedInfo.relatedEntities.map((entity) => entity.entityKey),
          relation_types: [...new Set(relatedInfo.relations.map((relation) => relation.relationType))],
        },
      },
    ];
    const edges: Array<{ parentNodeId: string; childNodeId: string; position: number }> = [];
    const bodiesByPath = new Map<string, string>([[rootPath, rootBodyWithRelations]]);
    const evidenceRefs: Array<{
      workspaceId: string;
      category: "workspace";
      treeId: string;
      nodeId: string;
      refId: string;
      provider: string;
      accountNamespace: string;
      connectionId: string | null;
      externalObjectId: string;
      externalObjectType: string;
      sourceType: string;
      sourceEventId: string | null;
      sourceMessageId: null;
      sourceTurnInputId: string;
      observedAt: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }> = [
      {
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId: rootNodeId,
        refId: entry.callId ? `tool-result:${entry.callId}` : `tool-result:event:${entry.outputEventId}`,
        provider: entry.providerId,
        accountNamespace: entry.accountNamespace,
        connectionId: entry.connectionId,
        externalObjectId: entry.callId ?? String(entry.outputEventId),
        externalObjectType: "integration_tool_result",
        sourceType: "tool_call",
        sourceEventId: entry.callId ?? null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          tool_name: entry.toolName,
          tool_id: entry.toolId,
          output_event_id: entry.outputEventId,
          evidence_kind: "integration_tool_result_document",
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      },
    ];
    const searchDocs: Array<{
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      childCount?: number;
      title: string;
      summary: string;
      bodyText: string;
      excerpt?: string | null;
      observedAt?: string | null;
      status?: "active";
      updatedAt?: string;
    }> = [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: TOOL_RESULT_DOCUMENT_NODE_KIND,
        path: rootPath,
        childCount: chunks.length,
        title: `${entry.toolName} result`,
        summary: rootSummary,
        bodyText: [
          entry.providerId,
          entry.accountNamespace,
          entry.toolName,
          entry.toolId ?? "",
          entry.resultBodyText ?? entry.resultSummary ?? "",
        ].filter(Boolean).join("\n"),
        excerpt: entry.resultSummary ?? (entry.resultBodyText ? compactWhitespace(entry.resultBodyText).slice(0, 320) : null),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      },
    ];

    for (const chunk of chunks) {
      const nodeId = toolResultDocumentChunkNodeId(treeId, chunk.index);
      const chunkPath = `${baseDir}/chunks/chunk-${String(chunk.index + 1).padStart(3, "0")}/content.md`;
      const chunkBody = toolResultDocumentChunkBody({
        entry,
        chunk,
        chunkCount: chunks.length,
      });
      nodes.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: TOOL_RESULT_CHUNK_NODE_KIND,
        sourceLeafId: `${treeId}:chunk:${chunk.index + 1}`,
        path: chunkPath,
        title: `${entry.toolName} result chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodySha256: sha256(chunkBody),
        childCount: 0,
        observedAt: indexedAt,
        status: "active",
        isMaterialized: false,
        metadata: {
          provider_id: entry.providerId,
          account_namespace: entry.accountNamespace,
          tool_name: entry.toolName,
          tool_id: entry.toolId,
          call_id: entry.callId,
          output_event_id: entry.outputEventId,
          chunk_index: chunk.index + 1,
          chunk_count: chunks.length,
        },
      });
      edges.push({
        parentNodeId: rootNodeId,
        childNodeId: nodeId,
        position: chunk.index + 1,
      });
      bodiesByPath.set(chunkPath, chunkBody);
      evidenceRefs.push({
        workspaceId: params.turnResult.workspaceId,
        category: "workspace",
        treeId,
        nodeId,
        refId: entry.callId
          ? `tool-result:${entry.callId}:chunk:${chunk.index + 1}`
          : `tool-result:event:${entry.outputEventId}:chunk:${chunk.index + 1}`,
        provider: entry.providerId,
        accountNamespace: entry.accountNamespace,
        connectionId: entry.connectionId,
        externalObjectId: entry.callId ?? String(entry.outputEventId),
        externalObjectType: "integration_tool_result",
        sourceType: "tool_call",
        sourceEventId: entry.callId ?? null,
        sourceMessageId: null,
        sourceTurnInputId: params.turnResult.inputId,
        observedAt: indexedAt,
        metadata: {
          tool_name: entry.toolName,
          tool_id: entry.toolId,
          output_event_id: entry.outputEventId,
          chunk_index: chunk.index + 1,
          evidence_kind: "integration_tool_result_document_chunk",
        },
        createdAt: indexedAt,
        updatedAt: indexedAt,
      });
      searchDocs.push({
        nodeId,
        nodeClass: "leaf",
        nodeKind: TOOL_RESULT_CHUNK_NODE_KIND,
        path: chunkPath,
        childCount: 0,
        title: `${entry.toolName} result chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        bodyText: chunk.content,
        excerpt: compactWhitespace(chunk.content).slice(0, 320),
        observedAt: indexedAt,
        status: "active",
        updatedAt: indexedAt,
      });
    }

    for (const [relativePath, body] of bodiesByPath) {
      writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
    }
    removeObsoleteFiles(
      absolutePathForRelative(workspaceDir, baseDir),
      new Set(
        [...bodiesByPath.keys()].map((relativePath) =>
          path.resolve(absolutePathForRelative(workspaceDir, relativePath))
        ),
      ),
    );

    params.store.syncSemanticMemoryTree({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodes,
      edges,
    });
    params.store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      relations: artifactDocumentRelations({
        workspaceId: params.turnResult.workspaceId,
        treeId,
        rootNodeId,
        relatedInfo,
        artifactContexts,
        resolver: relatedEntityResolver,
        sourceTurnInputId: params.turnResult.inputId,
      }),
    });
    params.store.replaceSemanticMemoryEvidenceRefs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      refs: evidenceRefs,
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: params.turnResult.workspaceId,
      treeId,
      docs: searchDocs,
    });
    await syncToolResultNodeEmbedding({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      treeId,
      nodeId: rootNodeId,
      nodeKind: "summary",
      entry,
      title: `${entry.toolName} result`,
      summary: rootSummary,
      body: rootBodyWithRelations,
      embeddingClient: params.embeddingClient ?? null,
    });
    for (const chunk of chunks) {
      const nodeId = toolResultDocumentChunkNodeId(treeId, chunk.index);
      await syncToolResultNodeEmbedding({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        treeId,
        nodeId,
        nodeKind: "leaf",
        entry,
        title: `${entry.toolName} result chunk ${chunk.index + 1}`,
        summary: chunk.summary,
        body: chunk.content,
        embeddingClient: params.embeddingClient ?? null,
      });
    }
    treeIds.push(treeId);
  }

  return treeIds;
}
