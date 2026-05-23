import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeAbsoluteSymlinks } from "./build_runtime_root.mjs";

test("materializeAbsoluteSymlinks replaces absolute package links while preserving relative shims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-root-links-"));
  const stateStoreDistDir = path.join(root, "runtime", "state-store", "dist");
  const linkedDistDir = path.join(
    root,
    "runtime",
    "api-server",
    "node_modules",
    "@holaboss",
    "runtime-state-store",
    "dist",
  );
  const binDir = path.join(root, "runtime", "api-server", "node_modules", ".bin");
  const targetModulePath = path.join(stateStoreDistDir, "debug-cli.mjs");
  const linkedModulePath = path.join(linkedDistDir, "debug-cli.mjs");
  const linkedShimPath = path.join(binDir, "holaboss-runtime");

  try {
    fs.mkdirSync(stateStoreDistDir, { recursive: true });
    fs.mkdirSync(linkedDistDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(targetModulePath, "#!/usr/bin/env node\nconsole.log('ok');\n", "utf8");
    fs.chmodSync(targetModulePath, 0o755);
    fs.symlinkSync(targetModulePath, linkedModulePath);
    fs.symlinkSync("../@holaboss/runtime-state-store/dist/debug-cli.mjs", linkedShimPath);

    materializeAbsoluteSymlinks(path.join(root, "runtime"));

    assert.equal(fs.lstatSync(linkedModulePath).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(linkedModulePath, "utf8"), fs.readFileSync(targetModulePath, "utf8"));
    assert.equal(fs.statSync(linkedModulePath).mode & 0o111, 0o111);
    assert.equal(fs.lstatSync(linkedShimPath).isSymbolicLink(), true);
    assert.equal(
      fs.readFileSync(path.join(binDir, fs.readlinkSync(linkedShimPath)), "utf8"),
      fs.readFileSync(targetModulePath, "utf8"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
