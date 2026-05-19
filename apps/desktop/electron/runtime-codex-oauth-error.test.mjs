import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("OpenAI Codex OAuth error handling tolerates non-string payload fields", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const errorMessageFunction =
    source.match(
      /function openAiCodexErrorMessage\([\s\S]*?\n}\n\nasync function updateDesktopBrowserCapabilityConfig/,
    )?.[0] ?? "";
  const firstNonEmptyStringFunction =
    source.match(
      /function runtimeFirstNonEmptyString\([\s\S]*?\n}\n\nfunction canonicalRuntimeProviderId/,
    )?.[0] ?? "";

  assert.match(
    errorMessageFunction,
    /const errorPayload = runtimeConfigObject\(payload\.error\);/,
  );
  assert.match(errorMessageFunction, /errorPayload\.message,/);
  assert.match(firstNonEmptyStringFunction, /\.\.\.values: unknown\[\]/);
  assert.match(
    firstNonEmptyStringFunction,
    /if \(typeof value !== "string"\) \{\s*continue;\s*}/,
  );
});
