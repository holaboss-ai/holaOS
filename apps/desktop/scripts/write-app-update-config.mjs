import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const require = createRequire(import.meta.url);
const { sanitizeFileName } = require("builder-util/out/filename");
const builderConfig = require("../electron-builder.config.cjs");
const packageJson = require("../package.json");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

function resolveAppUpdatePublishConfig() {
  const publishConfig = Array.isArray(builderConfig.publish)
    ? builderConfig.publish[0] ?? null
    : builderConfig.publish ?? null;
  if (!publishConfig || publishConfig.provider !== "github") {
    throw new Error(
      "The packaged app updater requires a GitHub publish config in electron-builder.config.cjs.",
    );
  }
  if (
    typeof publishConfig.owner !== "string" ||
    !publishConfig.owner.trim() ||
    typeof publishConfig.repo !== "string" ||
    !publishConfig.repo.trim()
  ) {
    throw new Error(
      "The packaged app updater requires explicit GitHub owner and repo values.",
    );
  }
  return publishConfig;
}

function resolveUpdaterCacheDirName() {
  if (typeof packageJson.name !== "string" || !packageJson.name.trim()) {
    throw new Error("desktop/package.json must define a package name.");
  }
  return `${sanitizeFileName(packageJson.name).toLowerCase()}-updater`;
}

export async function writeAppUpdateConfig(appBundlePath) {
  if (!appBundlePath?.trim()) {
    throw new Error("A macOS app bundle path is required.");
  }
  const publishConfig = resolveAppUpdatePublishConfig();
  const updaterConfig = {
    ...publishConfig,
    updaterCacheDirName: resolveUpdaterCacheDirName(),
  };

  const outputPath = path.join(
    appBundlePath,
    "Contents",
    "Resources",
    "app-update.yml",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, YAML.stringify(updaterConfig), "utf8");
  process.stdout.write(`[app-update-config] wrote ${path.relative(desktopRoot, outputPath)}\n`);
}

async function main() {
  const appBundlePath = process.argv[2]?.trim();
  if (!appBundlePath) {
    throw new Error(
      "Usage: node scripts/write-app-update-config.mjs <path-to-app-bundle>",
    );
  }
  await writeAppUpdateConfig(appBundlePath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
