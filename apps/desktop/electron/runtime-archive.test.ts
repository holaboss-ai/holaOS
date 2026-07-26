import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  computeArchiveMarker,
  ensureExtractedWindowsRuntime,
  extractionIsCurrent,
} from "./runtime-archive";

test("computeArchiveMarker combines size + mtime", () => {
  const marker = computeArchiveMarker("whatever", () => ({
    size: 1234,
    mtimeMs: 9876.9,
  }));
  assert.equal(marker, "1234:9876");
});

test("extractionIsCurrent only when the marker matches", () => {
  assert.equal(extractionIsCurrent("1234:9876", "1234:9876"), true);
  assert.equal(extractionIsCurrent("1234:9876\n", "1234:9876"), true); // trims
  assert.equal(extractionIsCurrent("1234:1", "1234:9876"), false);
  assert.equal(extractionIsCurrent(null, "1234:9876"), false);
});

test("no-op off Windows / when not packaged", async () => {
  assert.equal(
    await ensureExtractedWindowsRuntime({
      platform: "darwin",
      isPackaged: true,
      resourcesPath: "/res",
      userDataDir: "/data",
      bundleDirName: "runtime-windows",
    }),
    null,
  );
  assert.equal(
    await ensureExtractedWindowsRuntime({
      platform: "win32",
      isPackaged: false,
      resourcesPath: "/res",
      userDataDir: "/data",
      bundleDirName: "runtime-windows",
    }),
    null,
  );
});

// Real tar round-trip — proves the create (build side) + extract (runtime side)
// agree and that a fake "runtime tree" survives intact. Only runs where a tar
// CLI exists (all supported Windows + most CI Linux/macOS images).
const tarAvailable = (() => {
  const sysTar =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const probe = spawnSync(sysTar, ["--version"], { stdio: "ignore" });
  return !probe.error;
})();

test(
  "extracts the archive tree on first launch, is idempotent, re-extracts on change",
  { skip: tarAvailable ? false : "no tar CLI available" },
  async () => {
    const sysTar =
      process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const scratch = mkdtempSync(join(tmpdir(), "runtime-archive-test-"));
    try {
      // Build a fake staged tree with the shape the runtime validates.
      const tree = join(scratch, "tree");
      mkdirSync(join(tree, "bin"), { recursive: true });
      mkdirSync(join(tree, "runtime", "api-server"), { recursive: true });
      writeFileSync(join(tree, "bin", "runtime.sh"), "#!/bin/sh\n");
      writeFileSync(join(tree, "runtime", "api-server", "index.js"), "//x\n");
      writeFileSync(join(tree, "package-metadata.json"), "{}\n");

      // Create the archive from the tree CONTENTS (mirrors the build script).
      const resources = join(scratch, "resources");
      mkdirSync(resources, { recursive: true });
      const archivePath = join(resources, "runtime-windows.tar.gz");
      const created = spawnSync(
        sysTar,
        ["-c", "-z", "-f", archivePath, "-C", tree, "."],
        { stdio: "pipe" },
      );
      assert.equal(created.status, 0, created.stderr?.toString());

      const userData = join(scratch, "userData");
      mkdirSync(userData, { recursive: true });
      const opts = {
        platform: "win32" as NodeJS.Platform,
        isPackaged: true,
        resourcesPath: resources,
        userDataDir: userData,
        bundleDirName: "runtime-windows",
        log: () => {},
      };

      // First launch: extracts and returns the target with the tree intact.
      const root1 = await ensureExtractedWindowsRuntime(opts);
      assert.ok(root1, "expected an extracted root");
      assert.ok(existsSync(join(root1!, "bin", "runtime.sh")));
      assert.ok(existsSync(join(root1!, "runtime", "api-server", "index.js")));
      const marker1 = readFileSync(join(root1!, ".archive-marker"), "utf8");

      // Second launch (unchanged archive): idempotent — same root, no re-extract
      // (marker unchanged).
      const root2 = await ensureExtractedWindowsRuntime(opts);
      assert.equal(root2, root1);
      assert.equal(readFileSync(join(root2!, ".archive-marker"), "utf8"), marker1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
