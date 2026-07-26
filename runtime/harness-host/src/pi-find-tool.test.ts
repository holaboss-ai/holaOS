import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiFindToolDefinition } from "./pi-find-tool.js";

async function setupWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "hb-pi-find-tool-"));
  await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "src", "alpha.ts"), "export const alpha = 1;\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "src", "beta.ts"), "export const beta = 2;\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "docs", "guide.md"), "# Guide\n", "utf-8");
  const now = new Date();
  await fs.utimes(path.join(workspaceDir, "src", "alpha.ts"), now, new Date(now.getTime() - 20_000));
  await fs.utimes(path.join(workspaceDir, "src", "beta.ts"), now, new Date(now.getTime() - 10_000));
  await fs.utimes(path.join(workspaceDir, "docs", "guide.md"), now, new Date(now.getTime() - 1_000));
  return workspaceDir;
}

async function extractText(result: Awaited<ReturnType<ReturnType<typeof createPiFindToolDefinition>["execute"]>>) {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block);
  return block.text;
}

test("find groups results by directory and orders them by recent mtime", async () => {
  const workspaceDir = await setupWorkspace();
  const findTool = createPiFindToolDefinition(workspaceDir);
  const result = await findTool.execute("tool-1", {
    paths: ["src/**/*.ts", "docs/**/*.md"],
  });
  const text = await extractText(result);

  assert.match(text, /^# docs\/\nguide\.md/m);
  assert.match(text, /# src\/\nbeta\.ts\nalpha\.ts/m);
});

test("find tolerates missing paths in a multi-path call", async () => {
  const workspaceDir = await setupWorkspace();
  const findTool = createPiFindToolDefinition(workspaceDir);
  const result = await findTool.execute("tool-2", {
    paths: ["src/**/*.ts", "missing/**/*.ts"],
  });
  const text = await extractText(result);

  assert.match(text, /# src\/\nbeta\.ts\nalpha\.ts/m);
  assert.match(text, /Skipped missing paths: missing\/\*\*\/\*\.ts/);
});

test("find returns an exact file path directly", async () => {
  const workspaceDir = await setupWorkspace();
  const findTool = createPiFindToolDefinition(workspaceDir);
  const result = await findTool.execute("tool-3", {
    paths: ["src/alpha.ts"],
  });
  const text = await extractText(result);

  assert.equal(text.trim(), "# src/\nalpha.ts");
});

test("find keeps legacy pattern/path compatibility while preferring paths", async () => {
  const workspaceDir = await setupWorkspace();
  const findTool = createPiFindToolDefinition(workspaceDir);
  const result = await findTool.execute("tool-4", {
    pattern: "**/*.ts",
    path: "src",
  });
  const text = await extractText(result);

  assert.match(text, /# src\/\nbeta\.ts\nalpha\.ts/m);
});
