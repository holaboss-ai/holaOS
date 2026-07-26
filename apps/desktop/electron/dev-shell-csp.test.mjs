import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("dev shell CSP allows local app iframe origins", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /"frame-src 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* https:"/,
  );
});
