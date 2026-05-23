#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(runtimeRoot, "..");

function resolveWindowsNpmCliPath() {
  const explicitCliPath = process.env.HOLABOSS_RUNTIME_BUILD_NPM_CLI?.trim();
  if (explicitCliPath && existsSync(explicitCliPath)) {
    return explicitCliPath;
  }

  const envExecPath = process.env.npm_execpath?.trim();
  if (envExecPath && existsSync(envExecPath)) {
    return envExecPath;
  }

  const bundledCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledCliPath)) {
    return bundledCliPath;
  }

  const siblingCliPath = path.join(
    path.dirname(process.execPath),
    "..",
    "..",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(siblingCliPath)) {
    return siblingCliPath;
  }

  throw new Error("failed to resolve npm CLI entrypoint on Windows");
}

function npmInvocation() {
  if (process.platform === "win32") {
    return {
      command: process.execPath,
      argsPrefix: [resolveWindowsNpmCliPath()]
    };
  }

  return {
    command: "npm",
    argsPrefix: []
  };
}

function copyIfPresent(sourcePath, destinationPath) {
  if (!existsSync(sourcePath)) {
    return;
  }
  cpSync(sourcePath, destinationPath, { recursive: true });
}

export function runCommand(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options
  });
}

function runNpmCommand(args, options = {}) {
  const { command, argsPrefix } = npmInvocation();
  runCommand(command, [...argsPrefix, ...args], options);
}

function runBunCommand(args, options = {}) {
  runCommand("bun", args, options);
}

function materializeAbsoluteSymlinks(rootPath) {
  if (!existsSync(rootPath)) {
    return;
  }

  const details = lstatSync(rootPath);
  if (details.isSymbolicLink()) {
    materializeAbsoluteSymlink(rootPath);
    const replacementDetails = lstatSync(rootPath);
    if (!replacementDetails.isDirectory()) {
      return;
    }
  } else if (!details.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(rootPath)) {
    materializeAbsoluteSymlinks(path.join(rootPath, entry));
  }
}

function materializeAbsoluteSymlink(linkPath) {
  const rawTargetPath = readlinkSync(linkPath);
  if (!path.isAbsolute(rawTargetPath)) {
    return;
  }

  const resolvedTargetPath = realpathSync(linkPath);
  const targetDetails = lstatSync(resolvedTargetPath);
  rmSync(linkPath, { recursive: true, force: true });

  if (targetDetails.isDirectory()) {
    cpSync(resolvedTargetPath, linkPath, { recursive: true, verbatimSymlinks: true });
    return;
  }

  cpSync(resolvedTargetPath, linkPath);
  chmodSync(linkPath, targetDetails.mode & 0o777);
}

export { materializeAbsoluteSymlinks };

// Sibling-staged workspace packages — when the source declares
// `"@holaboss/runtime-state-store": "workspace:*"` and we stage
// state-store as a sibling dir in the output root, rewrite the dep
// to file:../state-store so `bun install` in the staged dir resolves
// it without needing the outer workspace.
const WORKSPACE_SIBLING_REWRITES = {
  "@holaboss/runtime-state-store": "file:../state-store",
};

// Postinstall lifecycle scripts only run for packages listed here
// under Bun's untrusted-by-default security model. Mirrors the root
// trustedDependencies so native rebuilds (better-sqlite3 et al.)
// happen inside the staged package too.
const STAGED_TRUSTED_DEPENDENCIES = [
  "better-sqlite3",
  "@napi-rs/canvas",
];

function rewriteStagedPackageJson(targetPackageJsonPath) {
  if (!existsSync(targetPackageJsonPath)) {
    return;
  }
  const pkg = JSON.parse(readFileSync(targetPackageJsonPath, "utf8"));
  let mutated = false;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = pkg[section];
    if (!block || typeof block !== "object") continue;
    for (const [name, version] of Object.entries(block)) {
      if (typeof version !== "string") continue;
      if (version === "workspace:*" || version.startsWith("workspace:")) {
        const rewrite = WORKSPACE_SIBLING_REWRITES[name];
        if (rewrite) {
          block[name] = rewrite;
          mutated = true;
        }
      }
    }
  }
  const trusted = new Set(pkg.trustedDependencies ?? []);
  for (const dep of STAGED_TRUSTED_DEPENDENCIES) {
    if (!trusted.has(dep)) {
      trusted.add(dep);
      mutated = true;
    }
  }
  if (mutated) {
    pkg.trustedDependencies = [...trusted].sort();
    writeFileSync(targetPackageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

export function resolveRuntimeVersion() {
  const packageJsonPath = path.join(runtimeRoot, "api-server", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!version) {
    throw new Error("failed to resolve runtime version from runtime/api-server/package.json");
  }
  return version;
}

function resolveGitSha() {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

// Two-build pattern (bun-based):
//   1. Source-only stage (copy package.json + src + tsconfig + scripts)
//   2. Devbuild stage: bun install (full deps) + bun run build → dist/
//   3. Production prune: rewrite to omit-dev list + bun install --production
//   4. Drop src/, tsconfig.json, tsup.config.ts — what ships is dist/ + prod node_modules
//
// Why bun: roughly 5-10× faster than `npm ci` for the same cold-install,
// and unlike npm ci it doesn't require a package-lock.json (we deleted
// all per-package lockfiles when the monorepo moved to a single root
// bun.lock during the Step 1/2 migration).
function stageNodePackage(outputRoot, packageDir, outputName) {
  if (!existsSync(path.join(packageDir, "package.json"))) {
    return;
  }

  const targetDir = path.join(outputRoot, outputName);
  mkdirSync(targetDir, { recursive: true });
  copyIfPresent(path.join(packageDir, "package.json"), path.join(targetDir, "package.json"));
  copyIfPresent(path.join(packageDir, "tsconfig.json"), path.join(targetDir, "tsconfig.json"));
  copyIfPresent(path.join(packageDir, "tsup.config.ts"), path.join(targetDir, "tsup.config.ts"));
  copyIfPresent(path.join(packageDir, "scripts"), path.join(targetDir, "scripts"));
  copyIfPresent(path.join(packageDir, "src"), path.join(targetDir, "src"));

  // Rewrite workspace:* refs to file:../<sibling> so bun install can
  // resolve them inside the staged tree, and inject trustedDependencies
  // so postinstall scripts (native rebuilds) actually run.
  rewriteStagedPackageJson(path.join(targetDir, "package.json"));

  // Full install (devDeps included) to get the build toolchain (tsup, tsx,
  // typescript) available for the build step.
  runBunCommand(["install"], { cwd: targetDir });
  runBunCommand(["run", "build"], { cwd: targetDir });
  // Production prune: blow away node_modules and re-install with --production
  // so devDeps stop shipping. Cheaper than `npm prune --omit=dev` because
  // bun's resolver doesn't have to figure out what's transitive-dev.
  rmSync(path.join(targetDir, "node_modules"), { recursive: true, force: true });
  runBunCommand(["install", "--production"], { cwd: targetDir });
  // Bun materializes file: sibling deps as absolute symlinks; those break
  // macOS bundle verification once the runtime is embedded inside a .app.
  materializeAbsoluteSymlinks(targetDir);

  rmSync(path.join(targetDir, "src"), { recursive: true, force: true });
  rmSync(path.join(targetDir, "tsconfig.json"), { force: true });
  rmSync(path.join(targetDir, "tsup.config.ts"), { force: true });
}

function stageSourcePackage(outputRoot, packageDir, outputName) {
  if (!existsSync(path.join(packageDir, "package.json"))) {
    return;
  }

  const targetDir = path.join(outputRoot, outputName);
  mkdirSync(targetDir, { recursive: true });
  copyIfPresent(path.join(packageDir, "package.json"), path.join(targetDir, "package.json"));
  copyIfPresent(path.join(packageDir, "src"), path.join(targetDir, "src"));

  rewriteStagedPackageJson(path.join(targetDir, "package.json"));

  const packageJson = JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8"));
  const hasDependencies =
    packageJson &&
    typeof packageJson === "object" &&
    packageJson.dependencies &&
    typeof packageJson.dependencies === "object" &&
    Object.keys(packageJson.dependencies).length > 0;
  if (hasDependencies) {
    runBunCommand(["install", "--production"], { cwd: targetDir });
    materializeAbsoluteSymlinks(targetDir);
  }
}

export function buildRuntimeRoot(outputRootArg = path.join(repoRoot, "out", "runtime-root")) {
  const outputRoot = path.resolve(outputRootArg);
  const runtimeVersion = resolveRuntimeVersion();
  const metadata = {
    runtime_version: runtimeVersion,
    runtime_schema_version: process.env.HOLABOSS_RUNTIME_SCHEMA_VERSION?.trim() || "1",
    git_sha: resolveGitSha(),
    build_id: process.env.HOLABOSS_RUNTIME_BUILD_ID?.trim() || "local",
    built_at_utc: new Date().toISOString(),
    source_path: "runtime"
  };

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  stageSourcePackage(outputRoot, path.join(runtimeRoot, "harnesses"), "harnesses");
  stageNodePackage(outputRoot, path.join(runtimeRoot, "harness-host"), "harness-host");
  stageNodePackage(outputRoot, path.join(runtimeRoot, "state-store"), "state-store");
  stageNodePackage(outputRoot, path.join(runtimeRoot, "api-server"), "api-server");
  copyIfPresent(path.join(scriptDir, "bootstrap"), path.join(outputRoot, "bootstrap"));

  writeFileSync(path.join(outputRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.error(`assembled runtime root at ${outputRoot}`);
  return outputRoot;
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  buildRuntimeRoot(process.argv[2]);
}
