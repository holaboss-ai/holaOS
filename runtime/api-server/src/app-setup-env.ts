import fs from "node:fs";
import path from "node:path";

export function appLocalNpmCacheDir(appDir: string): string {
  return path.join(appDir, ".npm-cache");
}

export function buildAppSetupEnv(appDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cacheDir = appLocalNpmCacheDir(appDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  return {
    ...baseEnv,
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir
  };
}
