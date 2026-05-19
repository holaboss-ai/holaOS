import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(__dirname, "..");
const writeAppUpdateConfigPath = path.join(
  desktopRoot,
  "scripts",
  "write-app-update-config.mjs",
);

test("write-app-update-config writes the packaged github updater metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "holaboss-app-update-"));
  const appBundlePath = path.join(tempRoot, "holaOS.app");
  const resourcesPath = path.join(appBundlePath, "Contents", "Resources");
  await mkdir(resourcesPath, { recursive: true });

  try {
    await execFileAsync(process.execPath, [writeAppUpdateConfigPath, appBundlePath], {
      cwd: desktopRoot,
    });

    const writtenConfig = await readFile(
      path.join(resourcesPath, "app-update.yml"),
      "utf8",
    );
    const updaterConfig = YAML.parse(writtenConfig);

    assert.equal(updaterConfig.provider, "github");
    assert.equal(updaterConfig.owner, "holaboss-ai");
    assert.equal(updaterConfig.repo, "holaOS-releases");
    assert.equal(updaterConfig.updaterCacheDirName, "holaboss-local-updater");
    assert.equal(updaterConfig.channel, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("write-app-update-config includes the beta channel when requested", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "holaboss-app-update-beta-"));
  const appBundlePath = path.join(tempRoot, "holaOS.app");
  const resourcesPath = path.join(appBundlePath, "Contents", "Resources");
  await mkdir(resourcesPath, { recursive: true });

  try {
    await execFileAsync(process.execPath, [writeAppUpdateConfigPath, appBundlePath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        HOLABOSS_RELEASE_CHANNEL: "beta",
      },
    });

    const writtenConfig = await readFile(
      path.join(resourcesPath, "app-update.yml"),
      "utf8",
    );
    const updaterConfig = YAML.parse(writtenConfig);

    assert.equal(updaterConfig.provider, "github");
    assert.equal(updaterConfig.owner, "holaboss-ai");
    assert.equal(updaterConfig.repo, "holaOS-releases");
    assert.equal(updaterConfig.channel, "beta");
    assert.equal(updaterConfig.updaterCacheDirName, "holaboss-local-updater");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
