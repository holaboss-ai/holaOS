import { createHash } from "node:crypto";

import type {
  MemoryEntryRecord,
  MemoryEmbeddingScopeBucket,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { queryMemoryModelEmbedding } from "./memory-model-client.js";
import type { MemoryServiceLike } from "./memory.js";

export const RECALL_EMBEDDING_DIM = 1536;
const MAX_EMBEDDING_EXCERPT_CHARS = 480;

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

function contentWithoutFrontmatter(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "");
  return normalized.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function scopeBucketForEntry(
  entry: MemoryEntryRecord,
  workspaceId: string,
): MemoryEmbeddingScopeBucket | null {
  if (entry.scope === "workspace" && entry.workspaceId === workspaceId) {
    return "workspace";
  }
  if (entry.scope === "user" && entry.memoryType === "preference") {
    return "preference";
  }
  if (entry.scope === "user" && entry.memoryType === "identity") {
    return "identity";
  }
  return null;
}

function excerptFromMarkdown(value: string): string {
  const content = contentWithoutFrontmatter(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));
  return clipText(content.join(" "), MAX_EMBEDDING_EXCERPT_CHARS);
}

async function readMemoryLeafContent(params: {
  memoryService: MemoryServiceLike;
  workspaceId: string;
  path: string;
}): Promise<string | null> {
  const result = await params.memoryService.get({
    workspace_id: params.workspaceId,
    path: params.path,
  });
  return typeof result.text === "string" && result.text.trim() ? result.text : null;
}

export function buildMemoryEmbeddingText(params: {
  title: string;
  summary: string;
  memoryType: string;
  tags: string[];
  excerpt: string;
}): string {
  const tags = params.tags.filter(Boolean).join(", ");
  return [
    `Title: ${params.title.trim()}`,
    `Type: ${params.memoryType.trim()}`,
    `Summary: ${params.summary.trim()}`,
    `Tags: ${tags || "none"}`,
    `Excerpt: ${params.excerpt.trim() || "none"}`,
  ].join("\n");
}

export function memoryEmbeddingFingerprint(params: {
  title: string;
  summary: string;
  memoryType: string;
  tags: string[];
  excerpt: string;
}): string {
  return createHash("sha256")
    .update(buildMemoryEmbeddingText(params))
    .digest("hex");
}

export async function syncDurableMemoryEmbedding(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  entry: MemoryEntryRecord;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<"disabled" | "deleted" | "skipped_unchanged" | "indexed"> {
  if (!params.embeddingClient || !params.store.supportsVectorIndex()) {
    return "disabled";
  }
  const scopeBucket = scopeBucketForEntry(params.entry, params.workspaceId);
  if (!scopeBucket || params.entry.status !== "active") {
    params.store.deleteMemoryEmbeddingIndex(params.entry.memoryId);
    return "deleted";
  }
  const content = await readMemoryLeafContent({
    memoryService: params.memoryService,
    workspaceId: params.workspaceId,
    path: params.entry.path,
  });
  if (!content) {
    params.store.deleteMemoryEmbeddingIndex(params.entry.memoryId);
    return "deleted";
  }
  const excerpt = excerptFromMarkdown(content);
  const contentFingerprint = memoryEmbeddingFingerprint({
    title: params.entry.title,
    summary: params.entry.summary,
    memoryType: params.entry.memoryType,
    tags: params.entry.tags,
    excerpt,
  });
  const existing = params.store.getMemoryEmbeddingIndexByMemoryId({
    memoryId: params.entry.memoryId,
    workspaceId: params.entry.workspaceId,
  });
  if (
    existing &&
    existing.contentFingerprint === contentFingerprint &&
    existing.embeddingModel === params.embeddingClient.modelId &&
    existing.embeddingDim === RECALL_EMBEDDING_DIM
  ) {
    return "skipped_unchanged";
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    input: buildMemoryEmbeddingText({
      title: params.entry.title,
      summary: params.entry.summary,
      memoryType: params.entry.memoryType,
      tags: params.entry.tags,
      excerpt,
    }),
    timeoutMs: 7000,
  });
  if (!embedding || embedding.length !== RECALL_EMBEDDING_DIM) {
    return "disabled";
  }
  const indexRecord = params.store.upsertMemoryEmbeddingIndex({
    memoryId: params.entry.memoryId,
    path: params.entry.path,
    workspaceId: params.entry.workspaceId,
    scopeBucket,
    memoryType: params.entry.memoryType,
    contentFingerprint,
    embeddingModel: params.embeddingClient.modelId,
    embeddingDim: RECALL_EMBEDDING_DIM,
  });
  params.store.replaceMemoryRecallVector({
    vecRowid: indexRecord.vecRowid,
    embedding,
    scopeBucket,
    workspaceId: params.entry.workspaceId,
    memoryType: params.entry.memoryType,
  });
  return "indexed";
}

export async function syncRecallEmbeddingsForEntries(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  entries: MemoryEntryRecord[];
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<{ indexed: number; skipped: number; deleted: number; disabled: number }> {
  const result = {
    indexed: 0,
    skipped: 0,
    deleted: 0,
    disabled: 0,
  };
  for (const entry of params.entries) {
    const status = await syncDurableMemoryEmbedding({
      store: params.store,
      memoryService: params.memoryService,
      workspaceId: params.workspaceId,
      entry,
      embeddingClient: params.embeddingClient,
    });
    if (status === "indexed") {
      result.indexed += 1;
    } else if (status === "skipped_unchanged") {
      result.skipped += 1;
    } else if (status === "deleted") {
      result.deleted += 1;
    } else {
      result.disabled += 1;
    }
  }
  return result;
}
