import { createHash } from "node:crypto";
import path from "node:path";

import type { DurableMemoryRelatedEntityType } from "./memory-related-entities.js";

export type WorkspaceResolvedTargetKind =
  | "interaction_entity"
  | "output_artifact"
  | "attachment"
  | "tool_result"
  | "image_url";

const GENERIC_RELATED_LABELS = new Set([
  "artifact",
  "document",
  "issue",
  "page",
  "report",
  "system",
  "topic",
]);

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function legacyRelatedEntityKey(entityType: DurableMemoryRelatedEntityType, label: string): string {
  const compacted = compactWhitespace(label);
  const normalized = safePathSegment(compacted, "");
  if (normalized) {
    return `${entityType}:${normalized}`;
  }
  if (!compacted) {
    return `${entityType}:${entityType}`;
  }
  const hash = createHash("sha256").update(compacted).digest("hex").slice(0, 12);
  return `${entityType}:label-${hash}`;
}

export function normalizeRelatedAliasKey(value: string): string {
  const compacted = compactWhitespace(value);
  const normalizedPath = compacted.replace(/^(\.{1,2}[\\/])+/, "");
  return safePathSegment(normalizedPath, "");
}

export function relatedAliasLookupKeys(value: string): string[] {
  const compacted = compactWhitespace(value);
  if (!compacted) {
    return [];
  }
  const normalizedPath = compacted.replace(/^(\.{1,2}[\\/])+/, "");
  const rawKey = normalizedPath.trim().toLowerCase();
  const slugKey = safePathSegment(normalizedPath, "");
  const keys = new Set<string>();
  if (slugKey) {
    keys.add(slugKey);
  }
  if (rawKey) {
    keys.add(rawKey);
  }
  return [...keys];
}

export function isGenericRelatedEntityLabel(value: string): boolean {
  const normalized = normalizeRelatedAliasKey(value);
  return normalized.length > 0 && GENERIC_RELATED_LABELS.has(normalized);
}

export function isGenericRelatedEntityKey(entityKey: string): boolean {
  const separatorIndex = entityKey.indexOf(":");
  if (separatorIndex < 0 || separatorIndex >= entityKey.length - 1) {
    return false;
  }
  return isGenericRelatedEntityLabel(entityKey.slice(separatorIndex + 1));
}

export function canonicalInteractionEntityKey(
  entityType: DurableMemoryRelatedEntityType,
  entityId: string,
): string {
  return `${entityType}:entity:${entityId}`;
}

export function canonicalOutputArtifactEntityKey(outputId: string): string {
  return `artifact:output:${outputId.trim()}`;
}

export function canonicalAttachmentArtifactEntityKey(attachmentId: string): string {
  return `artifact:attachment:${attachmentId.trim()}`;
}

export function canonicalToolResultArtifactEntityKey(params: {
  providerId: string;
  callId?: string | null;
  outputEventId?: number | null;
  treeId?: string | null;
}): string {
  const suffix = params.callId?.trim()
    || (typeof params.outputEventId === "number" && Number.isFinite(params.outputEventId)
      ? `event-${params.outputEventId}`
      : params.treeId?.trim()
        || "unknown");
  return `artifact:tool-result:${params.providerId.trim()}:${suffix}`;
}

export function canonicalImageUrlArtifactEntityKey(imageUrl: string): string {
  const hash = createHash("sha256").update(imageUrl).digest("hex").slice(0, 24);
  return `artifact:image-url:${hash}`;
}

export function basenameAliasFromPath(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return null;
  }
  const base = path.basename(normalized);
  return base.trim() || null;
}

export function parseCanonicalWorkspaceEntityKey(entityKey: string): {
  entityType: DurableMemoryRelatedEntityType;
  kind: WorkspaceResolvedTargetKind;
  targetId: string;
  providerId?: string;
} | null {
  const parts = entityKey.split(":");
  if (parts.length < 3) {
    return null;
  }
  const [entityTypeToken, kindToken, ...rest] = parts;
  const entityType = entityTypeToken as DurableMemoryRelatedEntityType;
  if (entityType !== "artifact") {
    if (kindToken !== "entity" || rest.length === 0) {
      return null;
    }
    return {
      entityType,
      kind: "interaction_entity",
      targetId: rest.join(":"),
    };
  }
  if (kindToken === "output" && rest.length > 0) {
    return {
      entityType,
      kind: "output_artifact",
      targetId: rest.join(":"),
    };
  }
  if (kindToken === "attachment" && rest.length > 0) {
    return {
      entityType,
      kind: "attachment",
      targetId: rest.join(":"),
    };
  }
  if (kindToken === "tool-result" && rest.length > 1) {
    return {
      entityType,
      kind: "tool_result",
      providerId: rest[0],
      targetId: rest.slice(1).join(":"),
    };
  }
  if (kindToken === "image-url" && rest.length > 0) {
    return {
      entityType,
      kind: "image_url",
      targetId: rest.join(":"),
    };
  }
  return null;
}
