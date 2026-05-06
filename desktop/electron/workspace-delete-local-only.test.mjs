import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("workspace deletion is handled locally without calling the control plane", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  // Extract deleteWorkspace function body — ends at the next async function declaration.
  const deleteWorkspaceFunction =
    source.match(
      /async function deleteWorkspace\([\s\S]*?\n}\n\nasync function /,
    )?.[0] ?? "";

  assert.match(
    deleteWorkspaceFunction,
    /runtimeClient\.workspaces\.delete\(\s*safeWorkspaceId,\s*keepFiles !== undefined \? \{ keepFiles \} : undefined,\s*\)/,
  );
  assert.match(deleteWorkspaceFunction, /forgetWorkspaceDir\(safeWorkspaceId\)/);
  assert.doesNotMatch(deleteWorkspaceFunction, /requestControlPlaneJson/);
  assert.doesNotMatch(deleteWorkspaceFunction, /controlPlaneWorkspaceUserId/);
  assert.doesNotMatch(deleteWorkspaceFunction, /projects\/workspaces/);
});
