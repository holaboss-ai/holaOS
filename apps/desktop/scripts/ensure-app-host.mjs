import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./npm-runner.mjs";

const desktopRoot = process.cwd();
const appHostRoot = path.resolve(
  desktopRoot,
  "..",
  "..",
  "packages",
  "app-host",
);
const appHostSourceInputs = [
  path.join(appHostRoot, "package.json"),
  path.join(appHostRoot, "tsdown.config.ts"),
  path.join(appHostRoot, "src"),
];
const appHostRequiredOutputs = [
  path.join(appHostRoot, "dist", "index.js"),
  path.join(appHostRoot, "dist", "index.d.ts"),
  path.join(appHostRoot, "dist", "protocol.js"),
  path.join(appHostRoot, "dist", "protocol.d.ts"),
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
  return appHostRequiredOutputs.every((targetPath) =>
    fs.existsSync(targetPath),
  );
}

const outputsExist = allOutputsExist();
const newestSourceStamp = Math.max(
  ...appHostSourceInputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const newestOutputStamp = Math.max(
  ...appHostRequiredOutputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const outputsStale = outputsExist && newestSourceStamp > newestOutputStamp;

if (!outputsExist || outputsStale) {
  console.log(
    outputsExist
      ? "[ensure-app-host] packages/app-host build is stale; rebuilding."
      : "[ensure-app-host] packages/app-host build output missing; building.",
  );
  runNpm(["run", "build"], {
    cwd: appHostRoot,
    stdio: "inherit",
    env: process.env,
  });
}
