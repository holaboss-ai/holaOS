import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { localRuntimePackagerFileNames, resolveRuntimePlatform } from "./runtime-bundle.mjs";

function hasPackagerAtRoot(rootPath, fileNames) {
  return fileNames.some((fileName) =>
    existsSync(path.join(rootPath, "runtime", "deploy", fileName))
  );
}

const repoRoot = process.cwd();
const runtimePlatform = resolveRuntimePlatform();
const explicitRuntimeRepoRoot = process.env.HOLABOSS_OSS_ROOT || process.env.HOLABOSS_RUNTIME_REPO_ROOT;
const localRuntimeRepoRoot = repoRoot;
const monorepoRuntimeRepoRoot = path.resolve(repoRoot, "..", "..");
const legacySiblingRuntimeRepoRoot = path.resolve(repoRoot, "..", "..", "..", "hola-boss-oss");
const packagerFileNames = localRuntimePackagerFileNames(runtimePlatform);
const inferredRuntimeRepoRoot = hasPackagerAtRoot(localRuntimeRepoRoot, packagerFileNames)
  ? localRuntimeRepoRoot
  : hasPackagerAtRoot(monorepoRuntimeRepoRoot, packagerFileNames)
    ? monorepoRuntimeRepoRoot
    : legacySiblingRuntimeRepoRoot;
const runtimeRepoRoot = path.resolve(repoRoot, explicitRuntimeRepoRoot || inferredRuntimeRepoRoot);
const runtimeOutDir = path.resolve(
  runtimeRepoRoot,
  process.env.HOLABOSS_RUNTIME_OUT_DIR || `out/runtime-${runtimePlatform}`
);
const packagerPath = packagerFileNames
  .map((fileName) => path.join(runtimeRepoRoot, "runtime", "deploy", fileName))
  .find((candidatePath) => existsSync(candidatePath));

if (!packagerPath) {
  console.error(
    `[prepare-runtime:local] package script not found for ${runtimePlatform}: ${packagerFileNames.join(", ")}`
  );
  console.error(
    `[prepare-runtime:local] local runtime packaging is not implemented for ${runtimePlatform}. Set HOLABOSS_OSS_ROOT if the script lives in another checkout.`
  );
  process.exit(1);
}

console.log(`[prepare-runtime:local] platform: ${runtimePlatform}`);
console.log(`[prepare-runtime:local] runtime repo root: ${runtimeRepoRoot}`);
console.log(`[prepare-runtime:local] runtime out: ${runtimeOutDir}`);

const buildRuntime =
  packagerPath.endsWith(".mjs")
    ? spawnSync(process.execPath, [packagerPath, runtimeOutDir], {
        stdio: "inherit",
        env: process.env
      })
    : spawnSync("bash", [packagerPath, runtimeOutDir], {
        stdio: "inherit",
        env: process.env
      });

if ((buildRuntime.status ?? 1) !== 0) {
  process.exit(buildRuntime.status ?? 1);
}

const stageRuntime = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "stage-runtime-bundle.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOLABOSS_RUNTIME_PLATFORM: runtimePlatform,
    HOLABOSS_RUNTIME_DIR: runtimeOutDir
  }
});

if ((stageRuntime.status ?? 1) !== 0) {
  process.exit(stageRuntime.status ?? 1);
}

console.log(`[prepare-runtime:local] staged local runtime into out/runtime-${runtimePlatform}`);
