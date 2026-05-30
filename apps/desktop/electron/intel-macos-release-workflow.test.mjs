import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WORKFLOW_PATH = new URL("../../../.github/workflows/publish-macos-intel-desktop.yml", import.meta.url);
const BUILDER_CONFIG_PATH = new URL("../electron-builder.config.cjs", import.meta.url);

function extractNamedStep(source, stepName) {
  const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`- name: ${escapedStepName}[\\s\\S]*?(?=\\n {6}- name:|$)`),
  );
  return match?.[0] || "";
}

test("intel macOS desktop workflow publishes a notarized x64 DMG without mac updater manifests", async () => {
  const [workflowSource, builderConfigSource] = await Promise.all([
    readFile(WORKFLOW_PATH, "utf8"),
    readFile(BUILDER_CONFIG_PATH, "utf8"),
  ]);
  const uploadArtifactStep = extractNamedStep(
    workflowSource,
    "Upload Intel macOS release artifacts",
  );
  const uploadReleaseStep = extractNamedStep(
    workflowSource,
    "Upload Intel macOS release asset",
  );

  assert.match(workflowSource, /^name: Publish Intel macOS Desktop$/m);
  assert.match(workflowSource, /workflow_call:\n\s+inputs:\n\s+ref:/);
  assert.match(workflowSource, /artifact_only:\n\s+required: false\n\s+type: boolean/);
  assert.match(workflowSource, /workflow_dispatch:\n\s+inputs:\n\s+ref:/);
  assert.match(workflowSource, /release_tag:\n\s+description: Existing or new GitHub release tag in holaOS-releases/);
  assert.match(workflowSource, /release_channel:\n\s+description: Desktop release channel metadata baked into the packaged config/);
  assert.match(workflowSource, /permissions:\n\s+contents: write/);
  assert.match(workflowSource, /RELEASE_GH_REPO: holaboss-ai\/holaOS-releases/);
  assert.match(workflowSource, /DESKTOP_RELEASE_ASSET_NAME: holaOS-macos-x64\.dmg/);
  assert.match(workflowSource, /runs-on: macos-13/);
  assert.match(workflowSource, /publish-macos-intel-desktop requires an x64 runner; got \$\(uname -m\)/);
  assert.match(workflowSource, /Build macOS runtime bundle/);
  assert.match(workflowSource, /bash runtime\/deploy\/package_macos_runtime\.sh out\/runtime-macos/);
  assert.match(workflowSource, /HOLABOSS_ENABLE_APP_UPDATES: "0"/);
  assert.match(workflowSource, /HOLABOSS_WRITE_APP_UPDATE_CONFIG: "0"/);
  assert.match(workflowSource, /--mac dir \\\n\s+--x64 \\/);
  assert.match(workflowSource, /Intel mac release must not embed app-update\.yml because mac updater manifests remain arm64-only/);
  assert.match(workflowSource, /--prepackaged "\$\{app_path\}" \\\n\s+--mac dmg \\\n\s+--x64 \\/);
  assert.match(workflowSource, /Intel macOS release artifacts must not emit zip, blockmap, or \*-mac\.yml updater files/);
  assert.match(workflowSource, /name: \$\{\{ env\.DESKTOP_ASSET_PREFIX \}\}-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(workflowSource, /path: apps\/desktop\/out\/release\/\$\{\{ env\.DESKTOP_RELEASE_ASSET_NAME \}\}/);
  assert.match(workflowSource, /Intel macOS x64 desktop build for `\$\{\{ steps\.release_meta\.outputs\.release_tag \}\}`\./);
  assert.match(workflowSource, /updater: disabled in this build; the shared `latest-mac\.yml` \/ `beta-mac\.yml` manifests remain Apple Silicon only/);
  assert.match(workflowSource, /Intel macOS release publishing to \$\{RELEASE_GH_REPO\} requires HOLABOSS_RELEASES_REPO_TOKEN/);
  assert.ok(
    uploadArtifactStep.includes("path: apps/desktop/out/release/${{ env.DESKTOP_RELEASE_ASSET_NAME }}"),
  );
  assert.doesNotMatch(uploadArtifactStep, /\.zip/);
  assert.doesNotMatch(uploadArtifactStep, /\.blockmap/);
  assert.doesNotMatch(uploadArtifactStep, /-mac\.yml/);
  assert.ok(
    uploadReleaseStep.includes('gh release upload "${{ steps.release_meta.outputs.release_tag }}" \\'),
  );
  assert.ok(
    uploadReleaseStep.includes('"apps/desktop/out/release/${DESKTOP_RELEASE_ASSET_NAME}" \\'),
  );
  assert.doesNotMatch(uploadReleaseStep, /\.zip/);
  assert.doesNotMatch(uploadReleaseStep, /\.blockmap/);
  assert.doesNotMatch(uploadReleaseStep, /-mac\.yml/);

  assert.match(builderConfigSource, /const configuredAppUpdateConfigBehavior = \(/);
  assert.match(builderConfigSource, /process\.env\.HOLABOSS_WRITE_APP_UPDATE_CONFIG \|\| ""/);
  assert.match(builderConfigSource, /if \(!writeAppUpdateConfigEnabled\) \{\s*return;\s*\}/);
});
