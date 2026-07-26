import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createPiSearchToolDefinition } from "./pi-search-tool.js";

async function withTempWorkspace(fn: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-tool-"));
  try {
    await fn(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

function firstTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block?.text);
  return block.text;
}

async function createZipBuffer(entries: Array<{ path: string; content: string | Uint8Array }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

test("search groups matches by directory and file", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.mkdir(path.join(workspaceDir, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "index.ts"), "const marker = 'needle';\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "src", "lib", "util.ts"), "export const helper = 'needle';\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "README.md"), "needle in docs\n", "utf-8");

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const result = await searchTool.execute(
      "call-1",
      { pattern: "needle", paths: ["src", "README.md"] },
      undefined,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^# src\/$/m);
    assert.match(text, /^## index\.ts$/m);
    assert.match(text, /^\*1:const marker = 'needle';$/m);
    assert.match(text, /^## util\.ts$/m);
    assert.match(text, /^\*1:export const helper = 'needle';$/m);
    assert.match(text, /^# README\.md$/m);
    assert.match(text, /^\*1:needle in docs$/m);
  });
});

test("search respects file line selectors", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "notes.txt"),
      "needle top\nmiddle\nneedle bottom\n",
      "utf-8",
    );

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const result = await searchTool.execute(
      "call-1",
      { pattern: "needle", path: "notes.txt:3-3" },
      undefined,
    );
    const text = firstTextBlock(result);

    assert.doesNotMatch(text, /\*1:needle top/);
    assert.match(text, /^\*3:needle bottom$/m);
  });
});

test("search includes surrounding context lines and elides gaps", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "context.ts");
    await fs.writeFile(
      filePath,
      [
        "const a = 1;",
        "const targetOne = 'needle';",
        "const c = 3;",
        "const d = 4;",
        "const e = 5;",
        "const f = 6;",
        "const g = 7;",
        "const targetTwo = 'needle';",
        "const i = 9;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const result = await searchTool.execute(
      "call-1",
      { pattern: "needle", path: "context.ts" },
      undefined,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^# context\.ts$/m);
    assert.match(text, /^ 1:const a = 1;$/m);
    assert.match(text, /^\*2:const targetOne = 'needle';$/m);
    assert.match(text, /^ 3:const c = 3;$/m);
    assert.match(text, /^ 4:const d = 4;$/m);
    assert.match(text, /^ 5:const e = 5;$/m);
    assert.match(text, /^\.\.\.$/m);
    assert.match(text, /^ 7:const g = 7;$/m);
    assert.match(text, /^\*8:const targetTwo = 'needle';$/m);
    assert.match(text, /^ 9:const i = 9;$/m);
  });
});

test("search paginates by file window with skip", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.mkdir(path.join(workspaceDir, "hits"), { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      await fs.writeFile(
        path.join(workspaceDir, "hits", `match-${String(index).padStart(2, "0")}.txt`),
        `needle ${index}\n`,
        "utf-8",
      );
    }

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const firstPage = firstTextBlock(await searchTool.execute(
      "call-1",
      { pattern: "needle", path: "hits" },
      undefined,
    ));
    assert.match(firstPage, /Use skip=20 for the next page\./);
    assert.match(firstPage, /^## match-00\.txt$/m);
    assert.doesNotMatch(firstPage, /^## match-20\.txt$/m);

    const secondPage = firstTextBlock(await searchTool.execute(
      "call-2",
      { pattern: "needle", path: "hits", skip: 20 },
      undefined,
    ));
    assert.match(secondPage, /^## match-20\.txt$/m);
    assert.match(secondPage, /^\*1:needle 20$/m);
  });
});

test("search finds matches inside archive members", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "bundle.zip"),
      await createZipBuffer([
        { path: "src/index.ts", content: "const marker = 'needle';\n" },
        { path: "README.md", content: "needle in docs\n" },
      ]),
    );

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const result = await searchTool.execute(
      "call-1",
      { pattern: "needle", path: "bundle.zip" },
      undefined,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^# bundle\.zip:README\.md$/m);
    assert.match(text, /^\*1:needle in docs$/m);
    assert.match(text, /^# bundle\.zip:src\/$/m);
    assert.match(text, /^## index\.ts$/m);
    assert.match(text, /^\*1:const marker = 'needle';$/m);
  });
});

test("search respects archive member line selectors", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "bundle.zip"),
      await createZipBuffer([
        {
          path: "src/index.ts",
          content: "needle top\nmiddle\nneedle bottom\n",
        },
      ]),
    );

    const searchTool = createPiSearchToolDefinition(workspaceDir);
    const result = await searchTool.execute(
      "call-1",
      { pattern: "needle", path: "bundle.zip:src/index.ts:3-3" },
      undefined,
    );
    const text = firstTextBlock(result);

    assert.doesNotMatch(text, /\*1:needle top/);
    assert.match(text, /^# bundle\.zip:src\/$/m);
    assert.match(text, /^## index\.ts$/m);
    assert.match(text, /^\*3:needle bottom$/m);
  });
});
