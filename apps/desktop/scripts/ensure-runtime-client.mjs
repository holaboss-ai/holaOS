import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./npm-runner.mjs";

const desktopRoot = process.cwd();
const sdkRoot = path.resolve(desktopRoot, "..", "..", "sdk", "runtime-client");
const sdkSourceInputs = [
  path.join(sdkRoot, "package.json"),
  path.join(sdkRoot, "tsdown.config.ts"),
  path.join(sdkRoot, "src"),
];
const sdkRequiredOutputs = [
  path.join(sdkRoot, "dist", "index.js"),
  path.join(sdkRoot, "dist", "index.d.ts"),
  path.join(sdkRoot, "dist", "core.js"),
  path.join(sdkRoot, "dist", "core.d.ts"),
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
  return sdkRequiredOutputs.every((targetPath) => fs.existsSync(targetPath));
}

const outputsExist = allOutputsExist();
const newestSourceStamp = Math.max(
  ...sdkSourceInputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const newestOutputStamp = Math.max(
  ...sdkRequiredOutputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const outputsStale = outputsExist && newestSourceStamp > newestOutputStamp;

if (!outputsExist || outputsStale) {
  console.log(
    outputsExist
      ? "[ensure-runtime-client] sdk/runtime-client build is stale; rebuilding."
      : "[ensure-runtime-client] sdk/runtime-client build output missing; building.",
  );
  runNpm(["run", "build"], {
    cwd: sdkRoot,
    stdio: "inherit",
    env: process.env,
  });
}
