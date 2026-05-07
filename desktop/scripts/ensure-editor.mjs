import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const desktopRoot = process.cwd();
const editorRoot = path.resolve(desktopRoot, "..", "packages", "editor");
const editorNodeModulesPath = path.join(editorRoot, "node_modules");
const editorSourceInputs = [
  path.join(editorRoot, "package.json"),
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

function runNpm(args) {
  const result = spawnSync("npm", args, {
    cwd: editorRoot,
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
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
  if (!fs.existsSync(editorNodeModulesPath)) {
    console.log(
      "[ensure-editor] installing packages/editor dependencies for local desktop usage.",
    );
    runNpm(["install"]);
  }

  console.log(
    outputsExist
      ? "[ensure-editor] packages/editor build is stale; rebuilding."
      : "[ensure-editor] packages/editor build output missing; building.",
  );
  runNpm(["run", "build"]);
}
