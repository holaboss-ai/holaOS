import fs from "node:fs";
import path from "node:path";

import { runNpm } from "./npm-runner.mjs";

const desktopRoot = process.cwd();
const remoteApiRoot = path.resolve(desktopRoot, "..", "..", "packages", "remote-api");
const remoteApiSourceInputs = [
  path.join(remoteApiRoot, "package.json"),
  path.join(remoteApiRoot, "tsdown.config.ts"),
  path.join(remoteApiRoot, "src"),
];
const remoteApiRequiredOutputs = [
  path.join(remoteApiRoot, "dist", "index.js"),
  path.join(remoteApiRoot, "dist", "index.d.ts"),
  path.join(remoteApiRoot, "dist", "client.js"),
  path.join(remoteApiRoot, "dist", "client.d.ts"),
  path.join(remoteApiRoot, "dist", "server.js"),
  path.join(remoteApiRoot, "dist", "server.d.ts"),
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
    newest = Math.max(newest, newestExistingMtime(path.join(targetPath, entry)));
  }
  return newest;
}

function allOutputsExist() {
  return remoteApiRequiredOutputs.every((targetPath) => fs.existsSync(targetPath));
}

const outputsExist = allOutputsExist();
const newestSourceStamp = Math.max(
  ...remoteApiSourceInputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const newestOutputStamp = Math.max(
  ...remoteApiRequiredOutputs.map((targetPath) => newestExistingMtime(targetPath)),
);
const outputsStale = outputsExist && newestSourceStamp > newestOutputStamp;

if (!outputsExist || outputsStale) {
  console.log(
    outputsExist
      ? "[ensure-remote-api] packages/remote-api build is stale; rebuilding."
      : "[ensure-remote-api] packages/remote-api build output missing; building.",
  );
  runNpm(["run", "build"], {
    cwd: remoteApiRoot,
    stdio: "inherit",
    env: process.env,
  });
}
