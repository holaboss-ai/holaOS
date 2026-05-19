import { existsSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  localRuntimePackagerFileNames,
  resolveRuntimePlatform,
  runtimeBundleDirName,
  runtimeBundleRequiredPathGroups,
} from "./runtime-bundle.mjs";

export function resolveRuntimeBundleState(desktopRoot = process.cwd()) {
  const repoRoot = path.resolve(desktopRoot, "..", "..");
  const runtimePlatform = resolveRuntimePlatform();
  const runtimeRoot = path.join(
    desktopRoot,
    "out",
    runtimeBundleDirName(runtimePlatform),
  );
  const requiredRuntimePathGroups = runtimeBundleRequiredPathGroups(
    runtimePlatform,
  ).map((relativePaths) =>
    relativePaths.map((relativePath) => path.join(runtimeRoot, relativePath)),
  );
  const localPackagerPath =
    localRuntimePackagerFileNames(runtimePlatform)
      .map((fileName) =>
        path.join(repoRoot, "runtime", "deploy", fileName),
      )
      .find((candidatePath) => existsSync(candidatePath)) ?? null;

  return {
    desktopRoot,
    repoRoot,
    runtimePlatform,
    runtimeRoot,
    requiredRuntimePathGroups,
    runtimeSourceInputs: [
      path.join(repoRoot, "runtime", "api-server", "src"),
      path.join(repoRoot, "runtime", "api-server", "package.json"),
      path.join(repoRoot, "runtime", "api-server", "package-lock.json"),
      path.join(repoRoot, "runtime", "api-server", "tsconfig.json"),
      path.join(repoRoot, "runtime", "api-server", "tsup.config.ts"),
      path.join(repoRoot, "runtime", "state-store", "src"),
      path.join(repoRoot, "runtime", "state-store", "package.json"),
      path.join(repoRoot, "runtime", "state-store", "package-lock.json"),
      path.join(repoRoot, "runtime", "state-store", "tsconfig.json"),
      path.join(repoRoot, "runtime", "state-store", "tsup.config.ts"),
      path.join(repoRoot, "runtime", "harness-host", "src"),
      path.join(repoRoot, "runtime", "harness-host", "package.json"),
      path.join(repoRoot, "runtime", "harness-host", "package-lock.json"),
      path.join(repoRoot, "runtime", "harness-host", "tsconfig.json"),
      path.join(repoRoot, "runtime", "harness-host", "tsup.config.ts"),
      path.join(repoRoot, "runtime", "harnesses", "src"),
      path.join(repoRoot, "runtime", "harnesses", "package.json"),
      path.join(repoRoot, "runtime", "deploy", "bootstrap"),
      path.join(repoRoot, "runtime", "deploy", "build_runtime_root.mjs"),
      path.join(repoRoot, "runtime", "deploy", "build_runtime_root.sh"),
      path.join(repoRoot, "runtime", "deploy", "prune_packaged_tree.mjs"),
      path.join(repoRoot, "runtime", "deploy", "prune_packaged_tree.sh"),
      path.join(repoRoot, "runtime", "deploy", "stage_python_runtime.mjs"),
      localPackagerPath,
    ],
    canPrepareLocalRuntime: Boolean(localPackagerPath),
  };
}

export async function firstAccessiblePath(paths) {
  for (const targetPath of paths) {
    try {
      await access(targetPath);
      return targetPath;
    } catch {
      // Continue looking for a valid path in the requirement group.
    }
  }
  return null;
}

export async function runtimeBundleExists(requiredRuntimePathGroups) {
  for (const requiredPaths of requiredRuntimePathGroups) {
    if (!(await firstAccessiblePath(requiredPaths))) {
      return false;
    }
  }
  return true;
}

export async function newestMtime(targetPath) {
  const details = await stat(targetPath);
  if (!details.isDirectory()) {
    return details.mtimeMs;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  let newest = details.mtimeMs;
  for (const entry of entries) {
    newest = Math.max(newest, await newestMtime(path.join(targetPath, entry.name)));
  }
  return newest;
}

export async function newestExistingMtime(paths) {
  let newest = 0;
  for (const targetPath of paths) {
    if (!targetPath) {
      continue;
    }
    try {
      newest = Math.max(newest, await newestMtime(targetPath));
    } catch {
      // Ignore optional or missing inputs.
    }
  }
  return newest;
}

export async function runtimeBundleIsStale(params) {
  const bundleStamp = await newestMtime(
    path.join(params.runtimeRoot, "package-metadata.json"),
  );
  const sourceStamp = await newestExistingMtime(params.runtimeSourceInputs);
  return sourceStamp > bundleStamp;
}
