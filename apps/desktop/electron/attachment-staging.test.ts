import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAttachmentMimeTypeFromBytes,
  resolveStagedAttachmentMimeType,
  stagedAttachmentKind,
} from "./attachment-staging";

test("resolveStagedAttachmentMimeType corrects mislabeled staged image bytes", () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  assert.equal(
    resolveStagedAttachmentMimeType({
      name: "diagram.png",
      declaredMimeType: "image/png",
      bytes: jpegBytes,
    }),
    "image/jpeg",
  );
  assert.equal(stagedAttachmentKind("image/jpeg"), "image");
});

test("resolveStagedAttachmentMimeType downgrades unsupported staged image bytes", () => {
  const heicBytes = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00,
  ]);

  assert.equal(detectAttachmentMimeTypeFromBytes(heicBytes), "image/heic");
  assert.equal(
    resolveStagedAttachmentMimeType({
      name: "phone-export.png",
      declaredMimeType: "image/png",
      bytes: heicBytes,
    }),
    "image/heic",
  );
  assert.equal(stagedAttachmentKind("image/heic"), "file");
});
