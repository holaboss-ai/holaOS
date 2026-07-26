import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");

export function resolveDesktopEnvPaths({ includeProduction = false } = {}) {
  const preferredEnvPath = path.join(desktopRoot, ".env");
  const preferredProductionEnvPath = path.join(desktopRoot, ".env.production");
  const legacyEnvPath = path.join(repoRoot, "desktop", ".env");
  const legacyProductionEnvPath = path.join(repoRoot, "desktop", ".env.production");
  const envPaths = [
    legacyEnvPath,
    ...(includeProduction ? [legacyProductionEnvPath] : []),
    preferredEnvPath,
    ...(includeProduction ? [preferredProductionEnvPath] : []),
  ];

  return {
    desktopRoot,
    repoRoot,
    preferredEnvPath,
    legacyEnvPath,
    preferredProductionEnvPath,
    legacyProductionEnvPath,
    envPaths,
  };
}

export function loadDesktopEnv(options) {
  const { envPaths } = resolveDesktopEnvPaths(options);
  const explicitEnvKeys = new Set(Object.keys(process.env));
  const mergedEnv = {};
  const loadedPaths = [];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    Object.assign(mergedEnv, dotenv.parse(fs.readFileSync(envPath, "utf8")));
    loadedPaths.push(envPath);
  }
  for (const [name, value] of Object.entries(mergedEnv)) {
    if (explicitEnvKeys.has(name)) {
      continue;
    }
    process.env[name] = value;
  }
  return loadedPaths;
}
