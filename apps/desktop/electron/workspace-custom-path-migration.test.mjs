import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop workspace migration preserves legacy workspace_path values", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /function migrateLocalWorkspacesTable\(database: Database\.Database\) \{/,
  );
  assert.match(
    source,
    /CREATE TABLE workspaces \(\s*id TEXT PRIMARY KEY,\s*workspace_path TEXT NOT NULL UNIQUE,/s,
  );
  assert.match(
    source,
    /columns\.has\("workspace_path"\) \? "workspace_path," : ""/,
  );
  assert.match(
    source,
    /const rawWorkspacePath =\s*typeof row\.workspace_path === "string" \? row\.workspace_path\.trim\(\) : "";/s,
  );
  assert.match(
    source,
    /const workspacePath = rawWorkspacePath\s*\?\s*rawWorkspacePath\.startsWith\("__deleted__\/"\)\s*\?\s*rawWorkspacePath\s*:\s*path\.resolve\(rawWorkspacePath\)\s*:\s*workspaceDirectoryPath\(String\(row\.id \?\? ""\)\);/s,
  );
  assert.match(
    source,
    /INSERT INTO workspaces \(\s*id,\s*workspace_path,\s*name,/s,
  );
});

test("desktop workspace migration preserves deleted-workspace tombstones verbatim", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /rawWorkspacePath\.startsWith\("__deleted__\/"\)\s*\?\s*rawWorkspacePath\s*:\s*path\.resolve\(rawWorkspacePath\)/s,
  );
});

test("desktop runtime bootstrap keeps workspace_path in the legacy host-state schema", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /CREATE TABLE IF NOT EXISTS workspaces \(\s*id TEXT PRIMARY KEY,\s*workspace_path TEXT NOT NULL UNIQUE,/s,
  );
});
