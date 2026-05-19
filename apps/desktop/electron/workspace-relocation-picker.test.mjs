import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("workspace relocation picker accepts both current and legacy identity marker paths", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /for \(const identityFilePath of \[\s*path\.join\(rootPath, "\.holaboss", "state", "workspace_id"\),\s*path\.join\(rootPath, "\.holaboss", "workspace_id"\),/s,
  );
});
