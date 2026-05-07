import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const desktopPackageJsonPath = path.join(__dirname, "..", "package.json");

test("desktop user-data dir honors configured env before the dev fallback", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.ok(
    source.includes(
      'const configuredDesktopUserDataDir =\n  process.env.HOLABOSS_DESKTOP_USER_DATA_DIR?.trim() || "";',
    ),
  );
  assert.ok(
    source.includes(
      'const DESKTOP_USER_DATA_DIR = (\n  configuredDesktopUserDataDir ||\n  (isDev ? "holaboss-local-dev" : "holaboss-local")\n).replace(/[\\\\/]+/g, "_");',
    ),
  );
});

test("desktop dev script does not override HOLABOSS_DESKTOP_USER_DATA_DIR", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackageJsonPath, "utf8"));

  assert.ok(packageJson.scripts);
  assert.equal(
    packageJson.scripts.dev.includes("HOLABOSS_DESKTOP_USER_DATA_DIR="),
    false,
  );
  assert.match(packageJson.scripts.dev, /^concurrently -k /);
});
