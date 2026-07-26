import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

interface LoadDesktopEnvOptions {
  desktopRoot?: string;
  includeProduction?: boolean;
}

interface DesktopEnvPaths {
  desktopRoot: string;
  repoRoot: string;
  preferredEnvPath: string;
  legacyEnvPath: string;
  envPaths: string[];
}

export function resolveDesktopEnvPaths(
  options: LoadDesktopEnvOptions = {},
): DesktopEnvPaths {
  const desktopRoot = options.desktopRoot ?? path.resolve(__dirname, "../..");
  const repoRoot = path.resolve(desktopRoot, "..", "..");
  const preferredEnvPath = path.join(desktopRoot, ".env");
  const preferredProductionEnvPath = path.join(desktopRoot, ".env.production");
  const legacyEnvPath = path.join(repoRoot, "desktop", ".env");
  const legacyProductionEnvPath = path.join(repoRoot, "desktop", ".env.production");
  const envPaths = [
    legacyEnvPath,
    ...(options.includeProduction ? [legacyProductionEnvPath] : []),
    preferredEnvPath,
    ...(options.includeProduction ? [preferredProductionEnvPath] : []),
  ];

  return {
    desktopRoot,
    repoRoot,
    preferredEnvPath,
    legacyEnvPath,
    envPaths,
  };
}

export function loadDesktopEnv(
  options: LoadDesktopEnvOptions = {},
): string[] {
  const { envPaths } = resolveDesktopEnvPaths(options);
  const explicitEnvKeys = new Set(Object.keys(process.env));
  const mergedEnv: Record<string, string> = {};
  const loadedPaths: string[] = [];
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
