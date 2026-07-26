import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("workspace deletion is handled locally without calling the control plane", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const deleteWorkspaceFunction =
    source.match(
      /async function deleteWorkspace\([\s\S]*?\n}\n\nasync function /,
    )?.[0] ?? "";
  const deleteLocalWorkspaceFunction =
    source.match(
      /async function deleteLocalWorkspace\([\s\S]*?\n}\n\nasync function /,
    )?.[0] ?? "";

  assert.match(
    deleteWorkspaceFunction,
    /return deleteLocalWorkspace\(safeWorkspaceId, keepFiles\);/,
  );
  assert.match(
    deleteLocalWorkspaceFunction,
    /runtimeClient\.workspaces\.delete\(\s*safeWorkspaceId,\s*keepFiles !== undefined \? \{ keepFiles \} : undefined,\s*\)/,
  );
  assert.match(deleteLocalWorkspaceFunction, /forgetWorkspaceDir\(safeWorkspaceId\)/);
  assert.doesNotMatch(deleteLocalWorkspaceFunction, /requestControlPlaneJson/);
  assert.doesNotMatch(deleteLocalWorkspaceFunction, /controlPlaneWorkspaceUserId/);
  assert.doesNotMatch(deleteLocalWorkspaceFunction, /projects\/workspaces/);
  assert.doesNotMatch(deleteWorkspaceFunction, /requestControlPlaneJson/);
  assert.doesNotMatch(deleteWorkspaceFunction, /controlPlaneWorkspaceUserId/);
  assert.doesNotMatch(deleteWorkspaceFunction, /projects\/workspaces/);
});
