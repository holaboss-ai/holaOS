import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("macOS development builds use a mock Chromium keychain to avoid Safe Storage prompts", async () => {
  const mainSource = await readFile(mainSourcePath, "utf8");

  assert.match(
    mainSource,
    /function initialDesktopAppName\(\): string \{[\s\S]*return "Holaboss Dev";[\s\S]*return "Holaboss";[\s\S]*\}\s*\n\s*electronApp\.setName\(initialDesktopAppName\(\)\);/,
  );
  assert.match(
    mainSource,
    /function shouldUseMacMockKeychain\(\): boolean \{[\s\S]*process\.platform !== "darwin"[\s\S]*HOLABOSS_MAC_USE_MOCK_KEYCHAIN[\s\S]*!app\.isPackaged \|\| process\.env\.HOLABOSS_INTERNAL_DEV\?\.trim\(\) === "1"[\s\S]*\}/,
  );
  assert.match(
    mainSource,
    /function configureMacKeychainPolicy\(\) \{[\s\S]*app\.commandLine\.appendSwitch\("use-mock-keychain"\);[\s\S]*\}/,
  );
  assert.match(
    mainSource,
    /function configuredMacAppMenuProductLabel\(\): string \{[\s\S]*MAC_DEV_APP_MENU_PRODUCT_LABEL[\s\S]*MAC_APP_MENU_PRODUCT_LABEL[\s\S]*\}/,
  );
  assert.match(
    mainSource,
    /configureChromiumLoggingPolicy\(\);\s*configureMacKeychainPolicy\(\);/,
  );
});
