import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_SOURCE_PATH = new URL("./main.ts", import.meta.url);

test("desktop auth session cleanup clears persisted Better Auth cookie and local cache", async () => {
  const source = await readFile(MAIN_SOURCE_PATH, "utf8");

  assert.match(source, /function clearPersistedAuthCookie\(\) \{/);
  assert.match(source, /if \("cookie" in betterAuth\) \{/);
  assert.match(source, /delete betterAuth\.cookie;/);
  assert.match(source, /if \("local_cache" in betterAuth\) \{/);
  assert.match(source, /delete betterAuth\.local_cache;/);
});

test("desktop sign-out clears persisted auth state before broadcasting the signed-out user", async () => {
  const source = await readFile(MAIN_SOURCE_PATH, "utf8");

  assert.match(
    source,
    /handleTrustedIpc\("auth:signOut", \["main", "auth-popup"], async \(\) => \{[\s\S]*try \{\s*await requireAuthClient\(\)\.signOut\(\);\s*} finally \{\s*clearPersistedAuthCookie\(\);\s*}[\s\S]*await clearManagedHolabossDefaultSelection\("auth_sign_out"\);[\s\S]*if \(\s*runtimeConfigIsControlPlaneManaged\(runtimeConfig\) &&[\s\S]*await clearRuntimeBindingSecrets\("auth_sign_out"\);[\s\S]*pendingAuthError = null;[\s\S]*emitAuthUserUpdated\(null\);[\s\S]*}\);/,
  );
});

test("desktop managed-default cleanup clears persisted default and subagent models when they point at Holaboss", async () => {
  const source = await readFile(MAIN_SOURCE_PATH, "utf8");

  assert.match(
    source,
    /async function clearManagedHolabossDefaultSelection\([\s\S]*const clearDefaultProvider = isHolabossProviderAlias\(defaultProviderId\);/,
  );
  assert.match(
    source,
    /const clearDefaultModel =[\s\S]*clearDefaultProvider[\s\S]*configuredProviderIdForRuntimeModelToken\(defaultModelToken\)[\s\S]*holabossGroupHasModelToken\(defaultModelToken\);/,
  );
  assert.match(
    source,
    /const clearSubagentModel =[\s\S]*clearDefaultProvider[\s\S]*configuredProviderIdForRuntimeModelToken\(subagentModelToken\)[\s\S]*holabossGroupHasModelToken\(subagentModelToken\);/,
  );
  assert.match(
    source,
    /await writeRuntimeConfigFile\(\{\s*\.\.\.\(clearDefaultProvider \? \{ defaultProvider: null } : \{\}\),\s*\.\.\.\(clearDefaultModel \? \{ defaultModel: null } : \{\}\),\s*\.\.\.\(clearSubagentModel \? \{ subagentModel: null } : \{\}\),\s*}\);/,
  );
});
