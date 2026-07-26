import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectAttachmentMimeTypeFromBytes } from "./attachment-staging";
import {
  HEIC_CONVERSION_OUTPUT_MIME_TYPE,
  convertHeicFileToJpeg,
  isHeicAttachmentMimeType,
  replaceAttachmentExtension,
} from "./heic-conversion";

test("replaceAttachmentExtension swaps the filename suffix", () => {
  assert.equal(
    replaceAttachmentExtension("IMG_8564 copy.png", ".jpg"),
    "IMG_8564 copy.jpg",
  );
  assert.equal(
    replaceAttachmentExtension("IMG_8564 copy", "jpg"),
    "IMG_8564 copy.jpg",
  );
  assert.equal(isHeicAttachmentMimeType("image/heic"), true);
  assert.equal(isHeicAttachmentMimeType("image/heif"), true);
  assert.equal(isHeicAttachmentMimeType("image/png"), false);
});

test(
  "convertHeicFileToJpeg rewrites HEIC bytes into a supported inline image",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-heic-test-"));
    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../resources/icon-original.png",
    );
    const heicPath = path.join(tempDir, "source.heic");
    const jpegPath = path.join(tempDir, "converted.jpg");

    try {
      execFileSync("/usr/bin/sips", [
        "-s",
        "format",
        "heic",
        fixturePath,
        "--out",
        heicPath,
      ]);

      await convertHeicFileToJpeg({
        sourcePath: heicPath,
        targetPath: jpegPath,
      });

      const convertedBytes = await fs.readFile(jpegPath);
      assert.equal(HEIC_CONVERSION_OUTPUT_MIME_TYPE, "image/jpeg");
      assert.equal(
        detectAttachmentMimeTypeFromBytes(convertedBytes),
        "image/jpeg",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
