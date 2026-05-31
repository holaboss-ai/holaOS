import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mergeScriptPath = path.join(
  __dirname,
  "..",
  "scripts",
  "merge-mac-update-manifests.rb",
);

test("merge-mac-update-manifests preserves the primary manifest and appends Intel mac files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "holaboss-mac-manifest-"));
  const primaryManifestPath = path.join(tempRoot, "latest-mac.yml");
  const intelManifestPath = path.join(tempRoot, "latest-mac-intel.yml");
  const outputManifestPath = path.join(tempRoot, "merged", "latest-mac.yml");

  try {
    await writeFile(
      primaryManifestPath,
      YAML.stringify({
        version: "2026.531.2",
        releaseDate: "2026-05-31T00:00:00.000Z",
        path: "holaOS-2026.531.2-arm64-mac.zip",
        sha512: "arm64-zip-sha",
        files: [
          {
            url: "holaOS-2026.531.2-arm64-mac.zip",
            sha512: "arm64-zip-sha",
          },
          {
            url: "holaOS-2026.531.2-arm64.dmg",
            sha512: "arm64-dmg-sha",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      intelManifestPath,
      YAML.stringify({
        version: "2026.531.2",
        releaseDate: "2026-05-31T00:00:00.000Z",
        path: "holaOS-2026.531.2-x64-mac.zip",
        sha512: "intel-zip-sha",
        files: [
          {
            url: "holaOS-2026.531.2-x64-mac.zip",
            sha512: "intel-zip-sha",
          },
          {
            url: "holaOS-2026.531.2-x64.dmg",
            sha512: "intel-dmg-sha",
          },
        ],
      }),
      "utf8",
    );

    await execFileAsync("ruby", [
      mergeScriptPath,
      outputManifestPath,
      primaryManifestPath,
      intelManifestPath,
    ]);

    const mergedManifestSource = await readFile(outputManifestPath, "utf8");
    const mergedManifest = YAML.parse(mergedManifestSource);

    assert.equal(mergedManifest.version, "2026.531.2");
    assert.equal(mergedManifest.path, "holaOS-2026.531.2-arm64-mac.zip");
    assert.equal(mergedManifest.sha512, "arm64-zip-sha");
    assert.deepEqual(
      mergedManifest.files.map((entry) => entry.url),
      [
        "holaOS-2026.531.2-arm64-mac.zip",
        "holaOS-2026.531.2-arm64.dmg",
        "holaOS-2026.531.2-x64-mac.zip",
        "holaOS-2026.531.2-x64.dmg",
      ],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
