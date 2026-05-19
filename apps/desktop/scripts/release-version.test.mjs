import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "release-version.mjs");

function runReleaseVersion(...args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  }).trim();
}

test("release version helper prints YYYY.MDD.R for a specific day", () => {
  assert.equal(runReleaseVersion("--date", "2026-04-10"), "2026.410.1");
  assert.equal(runReleaseVersion("2", "--date", "2026-04-10"), "2026.410.2");
  assert.equal(runReleaseVersion("3", "--date", "2026-11-13"), "2026.1113.3");
});

test("release version helper can print the full desktop release tag", () => {
  assert.equal(
    runReleaseVersion("--tag", "--date", "2026-04-10"),
    "holaOS-2026.410.1",
  );
  assert.equal(
    runReleaseVersion("--tag", "2", "--date", "2026-04-10"),
    "holaOS-2026.410.2",
  );
});

test("release version helper rejects invalid release numbers", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [scriptPath, "0"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Invalid release number: 0/,
  );
});

test("release version helper rejects malformed dates", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [scriptPath, "--date", "2026-04-31"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Invalid --date value: 2026-04-31/,
  );
});
