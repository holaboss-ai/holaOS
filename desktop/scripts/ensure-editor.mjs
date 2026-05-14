import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./npm-runner.mjs";

const desktopRoot = process.cwd();
const editorRoot = path.resolve(desktopRoot, "..", "packages", "editor");
const editorPackageJsonPath = path.join(editorRoot, "package.json");
const editorPackageLockPath = path.join(editorRoot, "package-lock.json");
const editorNodeModulesPath = path.join(editorRoot, "node_modules");
const editorInstallStampPath = path.join(editorNodeModulesPath, ".package-lock.json");
const editorSourceInputs = [
  editorPackageJsonPath,
  editorPackageLockPath,
  path.join(editorRoot, "tsup.config.ts"),
  path.join(editorRoot, "src"),
];
const editorRequiredOutputs = [
  path.join(editorRoot, "dist", "index.js"),
  path.join(editorRoot, "dist", "index.cjs"),
  path.join(editorRoot, "dist", "index.d.ts"),
  path.join(editorRoot, "dist", "styles.css"),
];

function newestExistingMtime(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath)) {
    newest = Math.max(
      newest,
      newestExistingMtime(path.join(targetPath, entry)),
    );
  }
  return newest;
}

function allOutputsExist() {
  return editorRequiredOutputs.every((targetPath) => fs.existsSync(targetPath));
}

function nodeModulesPathForPackage(packageName) {
  return path.join(editorNodeModulesPath, ...packageName.split("/"));
}

function missingDirectDependencies() {
  if (!fs.existsSync(editorNodeModulesPath)) {
    return [];
  }

  const manifest = JSON.parse(fs.readFileSync(editorPackageJsonPath, "utf8"));
  const directDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];

  return directDependencies.filter(
    (packageName) => !fs.existsSync(nodeModulesPathForPackage(packageName)),
  );
}

const newestManifestStamp = Math.max(
  newestExistingMtime(editorPackageJsonPath),
  newestExistingMtime(editorPackageLockPath),
);
const installStamp = fs.existsSync(editorInstallStampPath)
  ? newestExistingMtime(editorInstallStampPath)
  : newestExistingMtime(editorNodeModulesPath);
const missingPackages = missingDirectDependencies();
const needsInstall =
  !fs.existsSync(editorNodeModulesPath) ||
  missingPackages.length > 0 ||
  newestManifestStamp > installStamp;

if (needsInstall) {
  const installReason = !fs.existsSync(editorNodeModulesPath)
    ? "node_modules missing"
    : missingPackages.length > 0
      ? `missing direct dependencies: ${missingPackages.join(", ")}`
      : "package manifests changed since last install";
  console.log(
    `[ensure-editor] installing packages/editor dependencies for local desktop usage (${installReason}).`,
  );
  runNpm(["install"], {
    cwd: editorRoot,
    stdio: "inherit",
    env: process.env,
  });
}

const outputsExist = allOutputsExist();
const newestSourceStamp = Math.max(
  ...editorSourceInputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const newestOutputStamp = Math.max(
  ...editorRequiredOutputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const outputsStale = outputsExist && newestSourceStamp > newestOutputStamp;

if (!outputsExist || outputsStale) {
  console.log(
    outputsExist
      ? "[ensure-editor] packages/editor build is stale; rebuilding."
      : "[ensure-editor] packages/editor build output missing; building.",
  );
  runNpm(["run", "build"], {
    cwd: editorRoot,
    stdio: "inherit",
    env: process.env,
  });
}
