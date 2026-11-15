import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deployDir, "../..");

function writeFile(targetPath, contents) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents);
}

test("runtime Dockerfile only copies paths present in a clean checkout", () => {
  const dockerfile = fs.readFileSync(path.join(deployDir, "Dockerfile"), "utf8");
  const buildScript = fs.readFileSync(path.join(deployDir, "build_runtime_root.sh"), "utf8");
  const copySources = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));

  assert.ok(copySources.length > 0);
  assert.doesNotMatch(dockerfile, /package-lock\.json|\bnpm\b/);
  assert.doesNotMatch(buildScript, /package-lock\.json|\bnpm\b/);
  for (const sourcePath of copySources) {
    assert.ok(fs.existsSync(path.join(repoRoot, sourcePath)), `missing Docker COPY source: ${sourcePath}`);
  }
});

test("runtime root stages packages with frozen Bun workspace installs", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-runtime-bun-build-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDeployDir = path.join(fixtureRoot, "runtime", "deploy");
  const outputRoot = path.join(fixtureRoot, "out", "runtime-root");
  const binDir = path.join(fixtureRoot, "bin");
  const bunLogPath = path.join(fixtureRoot, "bun.log");

  fs.mkdirSync(fixtureDeployDir, { recursive: true });
  fs.copyFileSync(path.join(deployDir, "build_runtime_root.sh"), path.join(fixtureDeployDir, "build_runtime_root.sh"));
  writeFile(path.join(fixtureRoot, "package.json"), '{"private":true,"workspaces":["runtime/*","packages/*"]}\n');
  writeFile(path.join(fixtureRoot, "bun.lock"), "fixture-lockfile\n");

  for (const packageName of ["harness-host", "state-store", "api-server", "channel-gateway"]) {
    const packageDir = path.join(fixtureRoot, "runtime", packageName);
    writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: `@holaboss/runtime-${packageName}`, version: "0.1.0", scripts: { build: "fixture-build" } })}\n`,
    );
    writeFile(path.join(packageDir, "tsconfig.json"), "{}\n");
    writeFile(path.join(packageDir, "tsup.config.ts"), "export default {};\n");
    writeFile(path.join(packageDir, "src", "index.ts"), "export {};\n");
  }

  writeFile(
    path.join(fixtureRoot, "packages", "remote-api", "package.json"),
    '{"name":"@holaboss/remote-api","version":"0.1.0","scripts":{"build":"fixture-build"}}\n',
  );
  writeFile(path.join(fixtureRoot, "packages", "remote-api", "src", "index.ts"), "export {};\n");
  writeFile(path.join(fixtureRoot, "runtime", "harnesses", "package.json"), '{"name":"@holaboss/runtime-harnesses"}\n');
  writeFile(path.join(fixtureRoot, "runtime", "harnesses", "src", "index.ts"), "export {};\n");
  writeFile(path.join(fixtureDeployDir, "bootstrap", "linux.sh"), "#!/usr/bin/env bash\n");

  writeFile(
    path.join(binDir, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "\${PWD}" "$*" >> "\${BUN_LOG}"
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then
  mkdir -p dist
  printf 'built\n' > dist/index.mjs
fi
if [ "\${1:-}" = "install" ] && [[ " $* " = *" --production "* ]]; then
  for package_dir in runtime/harness-host runtime/state-store runtime/api-server; do
    mkdir -p "\${PWD}/\${package_dir}/node_modules"
    printf 'production\n' > "\${PWD}/\${package_dir}/node_modules/runtime-dependency.txt"
  done
fi
`,
  );
  fs.chmodSync(path.join(binDir, "bun"), 0o755);

  const result = spawnSync("bash", [path.join(fixtureDeployDir, "build_runtime_root.sh"), outputRoot], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: { ...process.env, BUN_LOG: bunLogPath, PATH: `${binDir}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bunLog = fs.readFileSync(bunLogPath, "utf8");
  assert.match(bunLog, /install --frozen-lockfile --linker=isolated/);
  assert.match(bunLog, /install --production --frozen-lockfile --linker=isolated/);
  assert.doesNotMatch(bunLog, /\bnpm\b/);

  for (const packageName of ["harness-host", "state-store", "api-server"]) {
    const stagedPackageDir = path.join(outputRoot, packageName);
    assert.equal(fs.readFileSync(path.join(stagedPackageDir, "dist", "index.mjs"), "utf8"), "built\n");
    assert.equal(
      fs.readFileSync(path.join(stagedPackageDir, "node_modules", "runtime-dependency.txt"), "utf8"),
      "production\n",
    );
    assert.equal(fs.existsSync(path.join(stagedPackageDir, "src")), false);
    assert.equal(fs.existsSync(path.join(stagedPackageDir, "tsconfig.json")), false);
    assert.equal(fs.existsSync(path.join(stagedPackageDir, "tsup.config.ts")), false);
  }
});
