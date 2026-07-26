import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  DEFAULT_INLINE_IMAGE_MAX_BYTES,
  DEFAULT_INLINE_IMAGE_MAX_HEIGHT,
  DEFAULT_INLINE_IMAGE_MAX_WIDTH,
  normalizeInlineImageMaterialization,
} from "./image-normalization";

test("normalizeInlineImageMaterialization preserves small inline-safe jpeg files", async () => {
  const sourceBytes = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 32, g: 64, b: 96 },
    },
  })
    .jpeg({ quality: 82 })
    .toBuffer();

  const result = await normalizeInlineImageMaterialization({
    sourceBytes,
    sourceMimeType: "image/jpeg",
  });

  assert.deepEqual(result, {
    action: "copy",
    mimeType: "image/jpeg",
    sizeBytes: sourceBytes.length,
  });
});

test("normalizeInlineImageMaterialization resizes oversized raster images into inline-safe jpeg output", async () => {
  const width = 2_600;
  const height = 2_200;
  const sourceBytes = await sharp(randomBytes(width * height * 3), {
    raw: {
      width,
      height,
      channels: 3,
    },
  })
    .png()
    .toBuffer();

  const result = await normalizeInlineImageMaterialization({
    sourceBytes,
    sourceMimeType: "image/png",
  });

  assert.equal(result.action, "write");
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.outputExtension, ".jpg");
  assert.ok(result.bytes.length <= DEFAULT_INLINE_IMAGE_MAX_BYTES);

  const metadata = await sharp(result.bytes).metadata();
  assert.ok((metadata.width ?? 0) <= DEFAULT_INLINE_IMAGE_MAX_WIDTH);
  assert.ok((metadata.height ?? 0) <= DEFAULT_INLINE_IMAGE_MAX_HEIGHT);
});

test("normalizeInlineImageMaterialization keeps alpha images inline by transcoding them to webp", async () => {
  const width = 2_500;
  const height = 2_100;
  const sourceBytes = await sharp(randomBytes(width * height * 4), {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  const result = await normalizeInlineImageMaterialization({
    sourceBytes,
    sourceMimeType: "image/png",
  });

  assert.equal(result.action, "write");
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.outputExtension, ".webp");
  assert.ok(result.bytes.length <= DEFAULT_INLINE_IMAGE_MAX_BYTES);

  const metadata = await sharp(result.bytes).metadata();
  assert.ok((metadata.width ?? 0) <= DEFAULT_INLINE_IMAGE_MAX_WIDTH);
  assert.ok((metadata.height ?? 0) <= DEFAULT_INLINE_IMAGE_MAX_HEIGHT);
  assert.equal(metadata.hasAlpha, true);
});

test("normalizeInlineImageMaterialization downgrades non-normalizable image formats", async () => {
  const result = await normalizeInlineImageMaterialization({
    sourceBytes: Buffer.from("<svg></svg>", "utf8"),
    sourceMimeType: "image/svg+xml",
  });

  assert.equal(result.action, "downgrade");
  assert.equal(result.mimeType, "image/svg+xml");
});
