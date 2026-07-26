import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime port is derived from the resolved userData path with an explicit override", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const RUNTIME_API_PORT_FALLBACK = 5160;/);
  assert.match(source, /const RUNTIME_API_PORT_RANGE_START = 39160;/);
  assert.match(source, /const RUNTIME_API_PORT_RANGE_SIZE = 2000;/);
  assert.match(source, /let resolvedRuntimeApiPort = RUNTIME_API_PORT_FALLBACK;/);
  assert.match(source, /function parseRuntimeApiPort\(value: string\): number \| null \{/);
  assert.match(source, /if \(parsed === 5060\) \{\s*return null;\s*\}/);
  assert.match(
    source,
    /function runtimeApiPortForUserDataPath\(userDataPath: string\): number \{[\s\S]*createHash\("sha256"\)[\s\S]*update\(path\.resolve\(userDataPath\), "utf8"\)[\s\S]*RUNTIME_API_PORT_RANGE_START \+ \(hash % RUNTIME_API_PORT_RANGE_SIZE\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /function resolveRuntimeApiPort\(\): number \{[\s\S]*process\.env\.HOLABOSS_RUNTIME_API_PORT\?\.trim\(\) \|\| ""[\s\S]*return runtimeApiPortForUserDataPath\(app\.getPath\("userData"\)\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /configureStableUserDataPath\(\);\s*resolvedRuntimeApiPort = resolveRuntimeApiPort\(\);\s*persistDevLaunchContext\(\);/,
  );
  assert.match(
    source,
    /function runtimeBaseUrl\(\) \{\s*return `http:\/\/127\.0\.0\.1:\$\{runtimeApiPort\(\)\}`;\s*\}/,
  );
  assert.match(source, /SANDBOX_AGENT_BIND_PORT: String\(runtimeApiPort\(\)\),/);
});
