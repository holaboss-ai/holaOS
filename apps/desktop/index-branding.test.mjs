import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "index.html");

test("desktop shell uses holaOS branding in the initial window title and splash", async () => {
  const source = await readFile(indexPath, "utf8");

  assert.match(source, /<title>holaOS<\/title>/);
  assert.match(source, /<div class="boot-splash-title">holaOS<\/div>/);
  assert.doesNotMatch(source, /<title>Holaboss<\/title>/);
  assert.doesNotMatch(source, /<div class="boot-splash-title">Holaboss<\/div>/);
});
