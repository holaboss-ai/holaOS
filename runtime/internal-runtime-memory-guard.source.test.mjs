import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptSourcePath = path.join(__dirname, "api-server", "src", "agent-runtime-prompt.ts");

test("resume-context prompt summarizes internal runtime memory instead of exposing raw runtime paths", async () => {
  const source = await readFile(promptSourcePath, "utf8");

  assert.match(source, /function isInternalRuntimeMemoryPath\(value: string\): boolean \{/);
  assert.match(source, /const internalRuntimeMemoryPaths = restoredMemoryPaths\.filter\(\(value\) =>[\s\S]*isInternalRuntimeMemoryPath\(value\),/);
  assert.match(
    source,
    /Internal runtime memory was restored from \$\{internalRuntimeMemoryPaths\.length\} runtime-managed record/,
  );
  assert.match(
    source,
    /These runtime-managed records are continuity metadata, not workspace files or folders for you to create, rename, or edit\./,
  );
  assert.match(
    source,
    /Do not create or modify a `runtime\/` directory in the workspace unless the user explicitly asks for that exact directory\./,
  );
  assert.match(source, /if \(isInternalRuntimeMemoryPath\(sessionMemoryPath\)\) \{/);
  assert.match(source, /lines\.push\("- Source: internal runtime-managed session memory\."\);/);
});
