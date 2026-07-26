import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeHarnessImageDataUrl,
  renderHarnessCliAttachments,
  resolveHarnessAttachmentAbsolutePath,
} from "../../harnesses/src/attachment-content.js";

// Detection keys off the magic bytes, not full validity, so the PNG signature
// plus a couple padding bytes is enough to be inlined as image/png.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function withWorkspace<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "harness-attach-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function imageAttachment(name: string) {
  return {
    id: name,
    kind: "image" as const,
    name,
    mime_type: "image/png",
    size_bytes: PNG_MAGIC.length,
    workspace_path: name,
  };
}

test("resolveHarnessAttachmentAbsolutePath finds in-bounds files and rejects traversal", () => {
  withWorkspace((dir) => {
    writeFileSync(join(dir, "a.png"), PNG_MAGIC);
    assert.equal(resolveHarnessAttachmentAbsolutePath([dir], "a.png"), join(dir, "a.png"));
    assert.equal(resolveHarnessAttachmentAbsolutePath([dir], "../../etc/passwd"), null);
  });
});

test("decodeHarnessImageDataUrl decodes image data URLs and rejects the rest", () => {
  const img = decodeHarnessImageDataUrl(`data:image/png;base64,${PNG_MAGIC.toString("base64")}`);
  assert.ok(img);
  assert.equal(img.mimeType, "image/png");
  assert.equal(decodeHarnessImageDataUrl("data:text/plain;base64,aGVsbG8="), null);
  assert.equal(decodeHarnessImageDataUrl("not-a-data-url"), null);
});

test("renderHarnessCliAttachments inlines images when inlineImages=true", async () => {
  await withWorkspace(async (dir) => {
    writeFileSync(join(dir, "shot.png"), PNG_MAGIC);
    const out = await renderHarnessCliAttachments({
      attachments: [imageAttachment("shot.png")],
      imageUrls: [],
      roots: [dir],
      inlineImages: true,
    });
    assert.equal(out.images.length, 1);
    const first = out.images[0];
    assert.ok(first);
    assert.equal(first.mimeType, "image/png");
    assert.equal(out.textLines.length, 0);
  });
});

test("renderHarnessCliAttachments references images by path when inlineImages=false", async () => {
  await withWorkspace(async (dir) => {
    writeFileSync(join(dir, "shot.png"), PNG_MAGIC);
    const out = await renderHarnessCliAttachments({
      attachments: [imageAttachment("shot.png")],
      imageUrls: [],
      roots: [dir],
      inlineImages: false,
    });
    assert.equal(out.images.length, 0);
    assert.equal(out.textLines.length, 1);
    assert.match(out.textLines[0] ?? "", /\.\/shot\.png/);
  });
});

test("renderHarnessCliAttachments extracts text-file excerpts and references folders", async () => {
  await withWorkspace(async (dir) => {
    writeFileSync(join(dir, "notes.txt"), "hello world from attachment");
    mkdirSync(join(dir, "stuff"));
    const out = await renderHarnessCliAttachments({
      attachments: [
        { id: "1", kind: "file", name: "notes.txt", mime_type: "text/plain", size_bytes: 5, workspace_path: "notes.txt" },
        { id: "2", kind: "folder", name: "stuff", mime_type: "inode/directory", size_bytes: 0, workspace_path: "stuff" },
      ],
      imageUrls: [],
      roots: [dir],
      inlineImages: true,
    });
    assert.equal(out.images.length, 0);
    assert.ok(out.textLines.some((line) => line.includes("hello world from attachment")));
    assert.ok(out.textLines.some((line) => /folder/.test(line) && line.includes("./stuff")));
  });
});

test("renderHarnessCliAttachments handles image URLs by mode", async () => {
  const dataUrl = `data:image/png;base64,${PNG_MAGIC.toString("base64")}`;
  const inlined = await renderHarnessCliAttachments({
    attachments: [],
    imageUrls: [dataUrl, "https://example.com/a.png"],
    roots: [],
    inlineImages: true,
  });
  assert.equal(inlined.images.length, 1);
  assert.deepEqual(inlined.remoteImageUrls, ["https://example.com/a.png"]);
  assert.equal(inlined.textLines.length, 0);

  const labeled = await renderHarnessCliAttachments({
    attachments: [],
    imageUrls: [dataUrl, "https://example.com/a.png"],
    roots: [],
    inlineImages: false,
  });
  assert.equal(labeled.images.length, 0);
  assert.equal(labeled.remoteImageUrls.length, 0);
  assert.equal(labeled.textLines.length, 2);
});

test("renderHarnessCliAttachments references missing / escaping attachments without throwing", async () => {
  await withWorkspace(async (dir) => {
    const out = await renderHarnessCliAttachments({
      attachments: [
        { id: "1", kind: "file", name: "passwd", mime_type: "text/plain", size_bytes: 0, workspace_path: "../../etc/passwd" },
      ],
      imageUrls: [],
      roots: [dir],
      inlineImages: true,
    });
    assert.equal(out.images.length, 0);
    assert.equal(out.textLines.length, 1); // fallback reference line, no crash
  });
});
