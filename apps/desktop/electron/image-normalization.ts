import fs from "node:fs/promises";

import sharp from "sharp";

export const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_INLINE_IMAGE_MAX_WIDTH = 2_000;
export const DEFAULT_INLINE_IMAGE_MAX_HEIGHT = 2_000;
export const DEFAULT_INLINE_IMAGE_JPEG_QUALITY_STEPS = [85, 75, 65] as const;
export const DEFAULT_INLINE_IMAGE_WEBP_QUALITY_STEPS = [90, 80, 70] as const;

const INLINE_SAFE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const NORMALIZABLE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type InlineImageMaterializationResult =
  | {
      action: "copy";
      mimeType: string;
      sizeBytes: number;
    }
  | {
      action: "write";
      mimeType: string;
      outputExtension: string;
      bytes: Buffer;
    }
  | {
      action: "downgrade";
      mimeType: string;
      reason: string;
    };

export interface NormalizeInlineImageParams {
  sourceMimeType: string;
  sourcePath?: string;
  sourceBytes?: Buffer;
  maxEncodedBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  jpegQualitySteps?: readonly number[];
  webpQualitySteps?: readonly number[];
}

function normalizedMimeType(value: string): string {
  return value.trim().toLowerCase();
}

function outputExtensionForMimeType(mimeType: string): string {
  switch (normalizedMimeType(mimeType)) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

function sourceInputForSharp(params: NormalizeInlineImageParams): string | Buffer {
  if (params.sourceBytes) {
    return params.sourceBytes;
  }
  if (params.sourcePath) {
    return params.sourcePath;
  }
  throw new Error("sourceBytes or sourcePath is required");
}

async function sourceByteLength(params: NormalizeInlineImageParams): Promise<number> {
  if (params.sourceBytes) {
    return params.sourceBytes.length;
  }
  if (params.sourcePath) {
    return (await fs.stat(params.sourcePath)).size;
  }
  throw new Error("sourceBytes or sourcePath is required");
}

async function encodedWithinBudget(
  bytes: Buffer,
  maxEncodedBytes: number,
): Promise<boolean> {
  return bytes.length > 0 && bytes.length <= maxEncodedBytes;
}

async function tryWebpCandidates(params: {
  input: string | Buffer;
  maxWidth: number;
  maxHeight: number;
  maxEncodedBytes: number;
  qualitySteps: readonly number[];
}): Promise<Buffer | null> {
  for (const quality of params.qualitySteps) {
    const bytes = await sharp(params.input)
      .rotate()
      .resize({
        width: params.maxWidth,
        height: params.maxHeight,
        fit: sharp.fit.inside,
        withoutEnlargement: true,
      })
      .webp({
        quality,
        alphaQuality: quality,
        effort: 5,
      })
      .toBuffer();
    if (await encodedWithinBudget(bytes, params.maxEncodedBytes)) {
      return bytes;
    }
  }
  return null;
}

async function tryJpegCandidates(params: {
  input: string | Buffer;
  maxWidth: number;
  maxHeight: number;
  maxEncodedBytes: number;
  qualitySteps: readonly number[];
}): Promise<Buffer | null> {
  for (const quality of params.qualitySteps) {
    const bytes = await sharp(params.input)
      .rotate()
      .resize({
        width: params.maxWidth,
        height: params.maxHeight,
        fit: sharp.fit.inside,
        withoutEnlargement: true,
      })
      .jpeg({
        quality,
        mozjpeg: true,
      })
      .toBuffer();
    if (await encodedWithinBudget(bytes, params.maxEncodedBytes)) {
      return bytes;
    }
  }
  return null;
}

export async function normalizeInlineImageMaterialization(
  params: NormalizeInlineImageParams,
): Promise<InlineImageMaterializationResult> {
  const sourceMimeType = normalizedMimeType(params.sourceMimeType);
  const maxEncodedBytes =
    params.maxEncodedBytes ?? DEFAULT_INLINE_IMAGE_MAX_BYTES;
  const maxWidth = params.maxWidth ?? DEFAULT_INLINE_IMAGE_MAX_WIDTH;
  const maxHeight = params.maxHeight ?? DEFAULT_INLINE_IMAGE_MAX_HEIGHT;
  const jpegQualitySteps =
    params.jpegQualitySteps ?? DEFAULT_INLINE_IMAGE_JPEG_QUALITY_STEPS;
  const webpQualitySteps =
    params.webpQualitySteps ?? DEFAULT_INLINE_IMAGE_WEBP_QUALITY_STEPS;
  if (!NORMALIZABLE_IMAGE_MIME_TYPES.has(sourceMimeType)) {
    return {
      action: "downgrade",
      mimeType: sourceMimeType,
      reason: `Image format ${sourceMimeType} is not eligible for inline normalization`,
    };
  }

  try {
    const input = sourceInputForSharp(params);
    const [sizeBytes, metadata] = await Promise.all([
      sourceByteLength(params),
      sharp(input, { animated: true }).metadata(),
    ]);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const pages = metadata.pages ?? 1;
    const hasAlpha = metadata.hasAlpha === true;
    const inlineSafe = INLINE_SAFE_IMAGE_MIME_TYPES.has(sourceMimeType);
    const needsResize = width > maxWidth || height > maxHeight;
    const needsByteReduction = sizeBytes > maxEncodedBytes;
    const needsFormatNormalization = !inlineSafe || sourceMimeType === "image/bmp" || sourceMimeType === "image/avif";

    if (
      inlineSafe &&
      !needsResize &&
      !needsByteReduction &&
      !needsFormatNormalization
    ) {
      return {
        action: "copy",
        mimeType: sourceMimeType,
        sizeBytes,
      };
    }

    if (pages > 1) {
      return {
        action: "downgrade",
        mimeType: sourceMimeType,
        reason: "Animated images are staged as files when they exceed inline normalization limits",
      };
    }

    const normalizedBytes = hasAlpha
      ? await tryWebpCandidates({
          input,
          maxWidth,
          maxHeight,
          maxEncodedBytes,
          qualitySteps: webpQualitySteps,
        })
      : await tryJpegCandidates({
          input,
          maxWidth,
          maxHeight,
          maxEncodedBytes,
          qualitySteps: jpegQualitySteps,
        });
    if (!normalizedBytes) {
      return {
        action: "downgrade",
        mimeType: sourceMimeType,
        reason: "Image could not be reduced under the inline size budget",
      };
    }
    const mimeType = hasAlpha ? "image/webp" : "image/jpeg";
    return {
      action: "write",
      mimeType,
      outputExtension: outputExtensionForMimeType(mimeType),
      bytes: normalizedBytes,
    };
  } catch (error) {
    return {
      action: "downgrade",
      mimeType: sourceMimeType,
      reason: error instanceof Error ? error.message : "image normalization failed",
    };
  }
}
