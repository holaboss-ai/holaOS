import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const workspaceDesktopSourcePath = path.join(
  __dirname,
  "..",
  "src",
  "lib",
  "workspaceDesktop.tsx",
);

test("desktop directory listing hides dot-prefixed files and folders from normal browsing", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function listDirectory[\s\S]*for \(const dirEntry of dirEntries\) \{\s*if \(dirEntry\.name\.startsWith\("\."\)\) \{\s*continue;\s*\}/,
  );
});

test("workspace creation keeps the creating view through the selection handoff", async () => {
  const source = await readFile(workspaceDesktopSourcePath, "utf8");

  assert.match(
    source,
    /setSelectedWorkspaceId\(createdWorkspaceId\);[\s\S]*window\.setTimeout\(resolve, 0\)/,
  );
  assert.match(source, /setWorkspaceCreatePhase\("creating_workspace"\);/);
  assert.match(source, /setWorkspaceCreatePhase\("finalizing"\);/);
});
