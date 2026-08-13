import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingExplorerAttachment,
  createPendingLocalAttachment,
  pendingAttachmentsToListItems,
  stagePendingFileAttachments,
} from "./pendingAttachments";
import type { PendingAttachment } from "./types";

function staged(id: string): SessionInputAttachmentPayload {
  return {
    id,
    kind: "file",
    name: `${id}.txt`,
    mime_type: "text/plain",
    size_bytes: 1,
    workspace_path: `/staged/${id}.txt`,
  };
}

test("stages mixed pending files concurrently and preserves composer order", async () => {
  const localFile = {
    name: "local.txt",
    type: "text/plain",
    size: 1,
  } as File;
  const attachments: PendingAttachment[] = [
    {
      id: "explorer-1",
      source: "explorer-path",
      absolutePath: "/workspace/first.txt",
      name: "first.txt",
      size_bytes: 1,
      kind: "file",
    },
    { id: "local-1", source: "local-file", file: localFile },
    {
      id: "context-1",
      source: "app-context",
      appName: "Example",
      title: "Context",
      contextText: "ignored by file staging",
    },
    {
      id: "explorer-2",
      source: "explorer-path",
      absolutePath: "/workspace/last.txt",
      name: "last.txt",
      size_bytes: 1,
      kind: "file",
    },
  ];

  const result = await stagePendingFileAttachments(attachments, {
    stageLocalFiles: async (files) => {
      assert.deepEqual(files.map((entry) => entry.id), ["local-1"]);
      return [staged("staged-local")];
    },
    stageExplorerFiles: async (files) => {
      assert.deepEqual(
        files.map((entry) => entry.id),
        ["explorer-1", "explorer-2"],
      );
      return [staged("staged-first"), staged("staged-last")];
    },
  });

  assert.deepEqual(
    result.map((attachment) => attachment.id),
    ["staged-first", "staged-local", "staged-last"],
  );
});

test("fails closed when a staging response omits an attachment", async () => {
  const attachments: PendingAttachment[] = [
    {
      id: "explorer-1",
      source: "explorer-path",
      absolutePath: "/workspace/file.txt",
      name: "file.txt",
      size_bytes: 1,
      kind: "file",
    },
  ];

  await assert.rejects(
    stagePendingFileAttachments(attachments, {
      stageLocalFiles: async () => [],
      stageExplorerFiles: async () => [],
    }),
    /Failed to stage an explorer attachment/,
  );
});

test("maps pending local and Explorer images to previewable list items", () => {
  const localFile = {
    name: "local.png",
    type: "image/png",
    size: 42,
  } as File;
  const items = pendingAttachmentsToListItems([
    { id: "local", source: "local-file", file: localFile },
    {
      id: "explorer",
      source: "explorer-path",
      absolutePath: "/workspace/image.png",
      name: "image.png",
      size_bytes: 84,
      kind: "image",
    },
  ]);

  assert.deepEqual(items, [
    {
      id: "local",
      kind: "image",
      name: "local.png",
      size_bytes: 42,
      file: localFile,
    },
    {
      id: "explorer",
      kind: "image",
      name: "image.png",
      size_bytes: 84,
      workspace_path: "/workspace/image.png",
    },
  ]);
});

test("creates pending entries with the same fields used by the composer", () => {
  const originalRandomUUID = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => "uuid",
  });
  try {
    const localFile = {
      name: "local.txt",
      type: "text/plain",
      size: 4,
      lastModified: 9,
    } as File;
    assert.deepEqual(createPendingLocalAttachment(localFile), {
      id: "local.txt-4-9-uuid",
      source: "local-file",
      file: localFile,
    });
    assert.deepEqual(
      createPendingExplorerAttachment({
        absolutePath: "/workspace/photo.png",
        name: "photo.png",
        size: 8,
        mimeType: "image/png",
      }),
      {
        id: "/workspace/photo.png-8-uuid",
        source: "explorer-path",
        absolutePath: "/workspace/photo.png",
        name: "photo.png",
        mime_type: "image/png",
        size_bytes: 8,
        kind: "image",
      },
    );
  } finally {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUUID,
    });
  }
});
