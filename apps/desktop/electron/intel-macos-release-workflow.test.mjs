import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WORKFLOW_PATH = new URL("../../../.github/workflows/publish-macos-intel-desktop.yml", import.meta.url);
function extractNamedStep(source, stepName) {
  const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`- name: ${escapedStepName}[\\s\\S]*?(?=\\n {6}- name:|$)`),
  );
  return match?.[0] || "";
}

test("intel macOS desktop workflow publishes a notarized x64 DMG and updater assets", async () => {
  const workflowSource = await readFile(WORKFLOW_PATH, "utf8");
  const uploadArtifactStep = extractNamedStep(
    workflowSource,
    "Upload Intel macOS release artifacts",
  );
  const uploadReleaseStep = extractNamedStep(
    workflowSource,
    "Upload Intel macOS release assets",
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
  assert.match(workflowSource, /runs-on: macos-15-intel/);
  assert.match(workflowSource, /publish-macos-intel-desktop requires an x64 runner; got \$\(uname -m\)/);
  assert.match(workflowSource, /Build macOS runtime bundle/);
  assert.match(workflowSource, /bash runtime\/deploy\/package_macos_runtime\.sh out\/runtime-macos/);
  assert.match(workflowSource, /Build signed Intel macOS app bundle[\s\S]*HOLABOSS_RELEASE_CHANNEL: \$\{\{ steps\.release_meta\.outputs\.release_channel \}\}/);
  assert.match(workflowSource, /--mac dir \\\n\s+--x64 \\/);
  assert.match(workflowSource, /app-update\.yml is missing from signed Intel macOS app bundle/);
  assert.match(workflowSource, /Build Intel macOS desktop release artifacts from notarized app bundle/);
  assert.match(workflowSource, /--prepackaged "\$\{app_path\}" \\\n\s+--mac dmg zip \\\n\s+--x64 \\/);
  assert.match(workflowSource, /Validate Intel macOS auto-update artifacts/);
  assert.match(workflowSource, /primary_manifest_name="beta-mac\.yml"/);
  assert.match(workflowSource, /primary_manifest_name="latest-mac\.yml"/);
  assert.match(workflowSource, /beta-mac\.yml was not generated for stable-channel Intel macOS compatibility/);
  assert.match(workflowSource, /Intel macOS zip does not contain holaOS\.app as the root app bundle/);
  assert.match(workflowSource, /app-update\.yml is missing from final Intel macOS zip/);
  assert.match(workflowSource, /extract_dir="\$\{RUNNER_TEMP\}\/intel-mac-zip-signature-verify"/);
  assert.match(workflowSource, /holaOS\.app was not extracted from the final Intel macOS zip/);
  assert.match(workflowSource, /codesign --verify --deep --strict --verbose=2 "\$\{extracted_app\}"/);
  assert.match(workflowSource, /spctl -a -vv -t exec "\$\{extracted_app\}"/);
  assert.match(workflowSource, /xcrun stapler validate "\$\{extracted_app\}"/);
  assert.match(workflowSource, /name: \$\{\{ env\.DESKTOP_ASSET_PREFIX \}\}-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(workflowSource, /apps\/desktop\/out\/release\/\$\{\{ env\.DESKTOP_RELEASE_ASSET_NAME \}\}/);
  assert.match(workflowSource, /apps\/desktop\/out\/release\/\*\.zip/);
  assert.match(workflowSource, /apps\/desktop\/out\/release\/\*\.zip\.blockmap/);
  assert.match(workflowSource, /apps\/desktop\/out\/release\/\*-mac\.yml/);
  assert.match(workflowSource, /Intel macOS x64 desktop build for `\$\{\{ steps\.release_meta\.outputs\.release_tag \}\}`\./);
  assert.match(workflowSource, /shared `latest-mac\.yml` \/ `beta-mac\.yml` manifests include both Apple Silicon and Intel macOS ZIP assets/);
  assert.match(workflowSource, /Intel macOS release publishing to \$\{RELEASE_GH_REPO\} requires HOLABOSS_RELEASES_REPO_TOKEN/);
  assert.match(workflowSource, /Intel macOS updater publishing requires an existing \$\{RELEASE_GH_REPO\} release/);
  assert.match(workflowSource, /Download shared macOS updater manifests/);
  assert.match(workflowSource, /gh release download "\$\{\{ steps\.release_meta\.outputs\.release_tag \}\}" \\\n\s+--repo "\$\{RELEASE_GH_REPO\}" \\\n\s+--pattern '\*-mac\.yml'/);
  assert.match(workflowSource, /Merge Intel macOS updater manifests with existing release manifests/);
  assert.match(workflowSource, /ruby apps\/desktop\/scripts\/merge-mac-update-manifests\.rb \\/);
  assert.match(workflowSource, /shared macOS updater manifest is missing from \$\{RELEASE_GH_REPO\}/);
  assert.ok(
    uploadArtifactStep.includes("apps/desktop/out/release/${{ env.DESKTOP_RELEASE_ASSET_NAME }}"),
  );
  assert.match(uploadArtifactStep, /apps\/desktop\/out\/release\/\*\.zip/);
  assert.match(uploadArtifactStep, /apps\/desktop\/out\/release\/\*\.zip\.blockmap/);
  assert.match(uploadArtifactStep, /apps\/desktop\/out\/release\/\*-mac\.yml/);
  assert.ok(
    uploadReleaseStep.includes('gh release upload "${{ steps.release_meta.outputs.release_tag }}" \\'),
  );
  assert.ok(
    uploadReleaseStep.includes('"apps/desktop/out/release/${DESKTOP_RELEASE_ASSET_NAME}" \\'),
  );
  assert.match(uploadReleaseStep, /apps\/desktop\/out\/release\/\*\.zip \\/);
  assert.match(uploadReleaseStep, /apps\/desktop\/out\/release\/\*\.zip\.blockmap \\/);
  assert.match(uploadReleaseStep, /apps\/desktop\/out\/release\/\*-mac\.yml \\/);
});
