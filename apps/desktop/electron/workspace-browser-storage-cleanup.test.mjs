import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("local workspace deletion purges persisted browser workspace storage", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const deleteLocalWorkspaceFunction =
    source.match(
      /async function deleteLocalWorkspace\([\s\S]*?\n}\n\nasync function /,
    )?.[0] ?? "";
  const cleanupFunction =
    source.match(
      /async function cleanupDeletedWorkspaceBrowserStorage\([\s\S]*?\n}\n\nasync function /,
    )?.[0] ?? "";

  assert.match(
    deleteLocalWorkspaceFunction,
    /await cleanupDeletedWorkspaceBrowserStorage\(safeWorkspaceId\);/,
  );
  assert.match(
    cleanupFunction,
    /if \(activeBrowserWorkspaceId === safeWorkspaceId\) \{\s*await setActiveBrowserWorkspace\(\"\"\);/s,
  );
  assert.match(cleanupFunction, /destroyBrowserWorkspace\(safeWorkspaceId\);/);
  assert.match(
    cleanupFunction,
    /session\.fromPartition\(\s*browserWorkspacePartition\(safeWorkspaceId\),\s*\)/,
  );
  assert.match(cleanupFunction, /await browserSession\.clearData\(\);/);
  assert.match(
    cleanupFunction,
    /await fs\.rm\(browserWorkspaceStorageDir\(safeWorkspaceId\), \{\s*recursive: true,\s*force: true,\s*\}\);/s,
  );
});
