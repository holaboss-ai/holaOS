#!/usr/bin/env node

/**
 * Patches the dev-mode Electron.app Info.plist to include the
 * ai.holaboss.app custom URL scheme so that macOS can route auth
 * callbacks back to the running Electron process.
 *
 * This is only needed in development — packaged builds already
 * declare the scheme via electron-builder config.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const plistPath = path.resolve(
  __dirname,
  "../node_modules/electron/dist/Electron.app/Contents/Info.plist"
);

if (!existsSync(plistPath)) {
  console.log("[patch-electron-plist] Electron.app not found, skipping.");
  process.exit(0);
}

const SCHEME = "ai.holaboss.app";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

function run(args) {
  try {
    execFileSync(PLIST_BUDDY, ["-c", args, plistPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Patch app identity so dev launches present as holaOS in macOS chrome.
const APP_NAME = "holaOS";
const BUNDLE_ID = "com.holaboss.workspace";

run(`Set :CFBundleName ${APP_NAME}`);
run(`Set :CFBundleDisplayName ${APP_NAME}`);
run(`Set :CFBundleIdentifier ${BUNDLE_ID}`);

let urlSchemeAlreadyPatched = false;
try {
  const out = execFileSync(
    PLIST_BUDDY,
    ["-c", "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0", plistPath],
    {
      stdio: "pipe",
      encoding: "utf8",
    }
  ).trim();
  urlSchemeAlreadyPatched = out === SCHEME;
} catch {
  urlSchemeAlreadyPatched = false;
}

if (!urlSchemeAlreadyPatched) {
  run("Add :CFBundleURLTypes array");
  run("Add :CFBundleURLTypes:0 dict");
  run("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
  run(`Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${SCHEME}`);
}
run(`Set :CFBundleURLTypes:0:CFBundleURLName 'holaOS Auth Callback'`);

// Re-register with LaunchServices
const electronApp = path.resolve(__dirname, "../node_modules/electron/dist/Electron.app");
try {
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
    ["-f", electronApp],
    { stdio: "pipe" }
  );
} catch {
  // lsregister failure is non-fatal
}

console.log(
  urlSchemeAlreadyPatched
    ? `[patch-electron-plist] Refreshed ${APP_NAME} metadata for Electron.app`
    : `[patch-electron-plist] Patched ${SCHEME} URL scheme into Electron.app`,
);
