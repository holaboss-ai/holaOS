import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const packagedConfigScriptPath = path.join(
  __dirname,
  "..",
  "scripts",
  "write-packaged-config.mjs",
);
const macEntitlementsPath = path.join(
  __dirname,
  "..",
  "resources",
  "entitlements.mac.plist",
);

test("macOS browser builds configure Electron WebAuthn from packaged config", async () => {
  const [mainSource, packagedConfigSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(packagedConfigScriptPath, "utf8"),
  ]);

  assert.match(
    mainSource,
    /interface PackagedDesktopConfig \{[\s\S]*macWebAuthnKeychainAccessGroup\?: string;/,
  );
  assert.match(
    mainSource,
    /function configuredMacWebAuthnKeychainAccessGroup\(\): string \{[\s\S]*HOLABOSS_MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP[\s\S]*packagedDesktopConfig\.macWebAuthnKeychainAccessGroup[\s\S]*\}/,
  );
  assert.match(
    mainSource,
    /function configureMacWebAuthnPlatformAuthenticator\(\): void \{[\s\S]*process\.platform !== "darwin"[\s\S]*configureWebAuthn[\s\S]*touchID:\s*\{[\s\S]*keychainAccessGroup[\s\S]*\}\s*\}\);[\s\S]*\}/,
  );
  assert.match(
    mainSource,
    /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*configureMacWebAuthnPlatformAuthenticator\(\);/,
  );
  assert.match(
    packagedConfigSource,
    /function resolveMacWebAuthnKeychainAccessGroup\(\) \{[\s\S]*return resolveEnvValue\([\s\S]*HOLABOSS_MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP[\s\S]*\);[\s\S]*\}/,
  );
  assert.match(
    packagedConfigSource,
    /\.\.\.\(macWebAuthnKeychainAccessGroup\s*\?\s*\{\s*macWebAuthnKeychainAccessGroup\s*\}\s*:\s*\{\}\),/,
  );
});

test("default macOS entitlements stay free of restricted keychain access groups", async () => {
  const entitlements = await readFile(macEntitlementsPath, "utf8");

  assert.doesNotMatch(entitlements, /<key>keychain-access-groups<\/key>/);
});
