import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptSourcePath = path.join(__dirname, "harness-host", "src", "pi.ts");
const promptTestPath = path.join(__dirname, "harness-host", "src", "pi.test.ts");

test("Pi prompt builder does not inject empty attachment or image-input sentinel text", async () => {
  const source = await readFile(promptSourcePath, "utf8");

  assert.match(source, /const attachments = request\.attachments \?\? \[\];/);
  assert.doesNotMatch(source, /Attachments: none\./);
  assert.doesNotMatch(source, /Image inputs: none\./);
});

test("Pi prompt tests cover omission of empty attachment and image-input sentinel text", async () => {
  const source = await readFile(promptTestPath, "utf8");

  assert.match(
    source,
    /test\("buildPiPromptPayload omits empty attachment and image-input sentinel text", async \(\) => \{/,
  );
  assert.match(source, /assert\.equal\(prompt\.text, "List the files"\);/);
});
