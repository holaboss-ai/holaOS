import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./npm-runner.mjs";

const desktopRoot = process.cwd();
const appSdkRoot = path.resolve(desktopRoot, "..", "sdk", "app-sdk");
const appSdkNodeModulesPath = path.join(appSdkRoot, "node_modules");
const appSdkSourceInputs = [
  path.join(appSdkRoot, "package.json"),
  path.join(appSdkRoot, "tsdown.config.ts"),
  path.join(appSdkRoot, "src"),
];
const appSdkRequiredOutputs = [
  path.join(appSdkRoot, "dist", "index.js"),
  path.join(appSdkRoot, "dist", "index.d.ts"),
  path.join(appSdkRoot, "dist", "core.js"),
  path.join(appSdkRoot, "dist", "core.d.ts"),
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
  return appSdkRequiredOutputs.every((targetPath) => fs.existsSync(targetPath));
}

const outputsExist = allOutputsExist();
const newestSourceStamp = Math.max(
  ...appSdkSourceInputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const newestOutputStamp = Math.max(
  ...appSdkRequiredOutputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const outputsStale = outputsExist && newestSourceStamp > newestOutputStamp;

if (!outputsExist || outputsStale) {
  if (!fs.existsSync(appSdkNodeModulesPath)) {
    console.log(
      "[ensure-app-sdk] installing sdk/app-sdk dependencies for local desktop usage.",
    );
    runNpm(["install"], {
      cwd: appSdkRoot,
      stdio: "inherit",
      env: process.env,
    });
  }

  console.log(
    outputsExist
      ? "[ensure-app-sdk] sdk/app-sdk build is stale; rebuilding."
      : "[ensure-app-sdk] sdk/app-sdk build output missing; building.",
  );
  runNpm(["run", "build"], {
    cwd: appSdkRoot,
    stdio: "inherit",
    env: process.env,
  });
}
