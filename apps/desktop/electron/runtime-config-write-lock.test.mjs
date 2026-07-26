import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime config mutations are serialized and written atomically", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /let runtimeConfigMutationPromise: Promise<void> \| null = null;/,
  );
  assert.match(
    source,
    /async function withRuntimeConfigMutationLock<T>\(\s*work: \(\) => Promise<T>,\s*\): Promise<T> \{/,
  );
  assert.match(
    source,
    /while \(runtimeConfigMutationPromise\) \{\s*await runtimeConfigMutationPromise;\s*\}/,
  );
  assert.match(
    source,
    /async function writeRuntimeConfigTextAtomically\(\s*nextText: string,\s*\): Promise<void> \{/,
  );
  assert.match(
    source,
    /const tempPath = `\$\{configPath\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.tmp`;/,
  );
  assert.match(
    source,
    /await fs\.writeFile\(tempPath, nextText, "utf-8"\);/,
  );
  assert.match(
    source,
    /await fs\.rename\(tempPath, configPath\);/,
  );
});

test("desktop runtime config writers use the shared mutation lock", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const writeRuntimeConfigSection =
    source.match(
      /async function writeRuntimeConfigFile\(update: RuntimeConfigUpdatePayload\) \{[\s\S]*?\n}\n\nfunction runtimeConfigField/,
    )?.[0] ?? "";
  const browserCapabilitySection =
    source.match(
      /async function updateDesktopBrowserCapabilityConfig\(update: \{[\s\S]*?\n}\n\nfunction desktopBrowserServiceTokenFromRequest/,
    )?.[0] ?? "";
  const setRuntimeConfigDocumentSection =
    source.match(
      /async function setRuntimeConfigDocument\([\s\S]*?\n}\n\nfunction runtimeUserProfileNameSourceFromApi/,
    )?.[0] ?? "";

  assert.match(
    writeRuntimeConfigSection,
    /const next = await withRuntimeConfigMutationLock\(async \(\) => \{/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /await writeRuntimeConfigTextAtomically\(/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /await syncDesktopBrowserCapabilityConfig\(\);\s*return next;/,
  );
  assert.match(
    browserCapabilitySection,
    /await withRuntimeConfigMutationLock\(async \(\) => \{/,
  );
  assert.match(
    browserCapabilitySection,
    /await writeRuntimeConfigTextAtomically\(/,
  );
  assert.match(
    setRuntimeConfigDocumentSection,
    /await withRuntimeConfigMutationLock\(async \(\) => \{/,
  );
  assert.match(
    setRuntimeConfigDocumentSection,
    /await writeRuntimeConfigTextAtomically\(nextText\);/,
  );
  assert.match(
    setRuntimeConfigDocumentSection,
    /await syncDesktopBrowserCapabilityConfig\(\);/,
  );
});

test("desktop runtime propagates the live browser capability into queued runs and embedded runtime env", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const queueSessionInputSection =
    source.match(
      /async function queueSessionInput\([\s\S]*?\n}\n\nasync function pauseSessionRun/,
    )?.[0] ?? "";
  const startEmbeddedRuntimeSection =
    source.match(
      /async function startEmbeddedRuntime\(\) \{[\s\S]*?\n}\n\nfunction persistFileBookmarks/,
    )?.[0] ?? "";

  assert.match(
    queueSessionInputSection,
    /await syncDesktopBrowserCapabilityConfig\(\);\s*const currentConfig = await readRuntimeConfigFile\(\);/,
  );
  assert.match(
    startEmbeddedRuntimeSection,
    /HOLABOSS_DESKTOP_BROWSER_ENABLED: currentDesktopBrowserCapabilityConfig\(\)\s*[\s\S]*?\.enabled\s*[\s\S]*?\?\s*"true"\s*:\s*"false"/,
  );
  assert.match(
    startEmbeddedRuntimeSection,
    /HOLABOSS_DESKTOP_BROWSER_URL: desktopBrowserServiceUrl,/,
  );
  assert.match(
    startEmbeddedRuntimeSection,
    /HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN:\s*desktopBrowserServiceAuthToken,/,
  );
});
