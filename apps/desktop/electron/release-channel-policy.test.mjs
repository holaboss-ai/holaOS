import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const electronBuilderConfigPath = path.join(__dirname, "..", "electron-builder.config.cjs");
const packagedConfigScriptPath = path.join(
  __dirname,
  "..",
  "scripts",
  "write-packaged-config.mjs",
);
const stageRuntimeBundlePath = path.join(
  __dirname,
  "..",
  "scripts",
  "stage-runtime-bundle.mjs",
);
const ciWorkflowPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "ci.yml",
);
const docsWorkflowPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "deploy-docs.yml",
);

test("desktop updater uses electron-updater and exposes install-now state", async () => {
  const [source, packagedConfigSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(packagedConfigScriptPath, "utf8"),
  ]);

  assert.match(source, /import \{[\s\S]*autoUpdater,[\s\S]*\} from "electron-updater";/);
  assert.match(source, /const APP_UPDATE_SUPPORTED_PLATFORMS = new Set\(\["darwin", "win32"\]\);/);
  assert.match(source, /const GITHUB_RELEASES_REPO = "holaOS-releases";/);
  assert.match(source, /const DEFAULT_APP_UPDATE_CHANNEL =/);
  assert.match(source, /function preferredAppUpdateChannel\(\): AppUpdateChannel \| null \{/);
  assert.match(source, /function effectiveAppUpdateChannel\(\): AppUpdateChannel \{/);
  assert.match(source, /function applyAutoUpdaterChannelConfiguration\(\) \{/);
  assert.match(source, /autoUpdater\.autoDownload = true;/);
  assert.match(source, /autoUpdater\.autoInstallOnAppQuit = process\.platform !== "win32";/);
  assert.match(source, /electronAutoUpdater\.on\("before-quit-for-update", \(\) => \{/);
  assert.match(source, /appUpdateInstallInProgress =\s*process\.platform === "win32" \|\| appQuitCleanupFinished;/);
  assert.match(source, /autoUpdater\.allowPrerelease = channel === "beta";/);
  assert.match(source, /autoUpdater\.channel = channel;/);
  assert.match(source, /autoUpdater\.on\("update-available"/);
  assert.match(source, /autoUpdater\.on\("download-progress"/);
  assert.match(source, /autoUpdater\.on\("update-downloaded"/);
  assert.match(source, /let appUpdateDownloadPromise: Promise<Array<string>> \| null = null;/);
  assert.match(source, /function trackAppUpdateDownload\(/);
  assert.match(source, /if \(appUpdateDownloadPromise\) \{\s*return appUpdateStatus;\s*\}/);
  assert.match(source, /const result = await autoUpdater\.checkForUpdates\(\);/);
  assert.match(source, /trackAppUpdateDownload\(result\?\.downloadPromise\);/);
  assert.match(source, /handleTrustedIpc\(\s*"appUpdate:setChannel",\s*\["main"\],\s*async \(_event, channel: AppUpdateChannel\) => setAppUpdateChannel\(channel\),/);
  assert.match(source, /handleTrustedIpc\(\s*"appUpdate:installNow",\s*\["main"\],\s*async \(\) => installAppUpdateNow\(\),\s*\);/);
  assert.match(source, /await ensureAppQuitCleanup\(\);/);
  assert.match(source, /if \(process\.platform === "win32"\) \{\s*autoUpdater\.quitAndInstall\(false, false\);[\s\S]*return;\s*\}/);
  assert.match(source, /autoUpdater\.quitAndInstall\(true, true\);/);
  assert.match(source, /if \(!app\.isPackaged \|\| !APP_UPDATE_SUPPORTED_PLATFORMS\.has\(process\.platform\)\) \{\s*return false;\s*\}/);
  assert.match(source, /if \(typeof packagedDesktopConfig\.appUpdateEnabled === "boolean"\) \{\s*return packagedDesktopConfig\.appUpdateEnabled;\s*\}/);
  assert.match(source, /return isReleaseStyleAppVersion\(currentAppVersion\(\)\);/);
  assert.match(packagedConfigSource, /function resolveUpdateChannel\(\)/);
  assert.match(packagedConfigSource, /function resolveAppUpdateEnabled\(\)/);
  assert.match(packagedConfigSource, /const appUpdateEnabled = resolveAppUpdateEnabled\(\);/);
  assert.match(packagedConfigSource, /appUpdateEnabled,/);
  assert.match(packagedConfigSource, /\.\.\.\(updateChannel === "beta" \? \{ updateChannel \} : \{\}\),/);
});

test("runtime staging accepts explicit runtime sources and falls back to a locally prepared runtime bundle", async () => {
  const source = await readFile(stageRuntimeBundlePath, "utf8");

  assert.match(source, /const runtimeDir = process\.env\.HOLABOSS_RUNTIME_DIR\?\.trim\(\);/);
  assert.match(source, /const runtimeTarball = process\.env\.HOLABOSS_RUNTIME_TARBALL\?\.trim\(\);/);
  assert.match(source, /const runtimeBundleUrl = process\.env\.HOLABOSS_RUNTIME_BUNDLE_URL\?\.trim\(\);/);
  assert.match(source, /if \(runtimeDir\) \{/);
  assert.match(source, /if \(runtimeTarball\) \{/);
  assert.match(source, /if \(runtimeBundleUrl\) \{/);
  assert.match(source, /if \(existsSync\(defaultLocalRuntimeDir\)\) \{/);
  assert.match(source, /copying fallback runtime directory from \$\{defaultLocalRuntimeDir\}/);
  assert.match(
    source,
    /No runtime bundle source found\. Set HOLABOSS_RUNTIME_DIR, HOLABOSS_RUNTIME_TARBALL, or HOLABOSS_RUNTIME_BUNDLE_URL, or run npm run prepare:runtime:local first\./,
  );
  assert.doesNotMatch(source, /HOLABOSS_RUNTIME_SOURCE_REPO/);
  assert.doesNotMatch(source, /HOLABOSS_RUNTIME_RELEASE_TAG/);
  assert.doesNotMatch(source, /holaboss-ai\/holaOS-releases/);
  assert.doesNotMatch(source, /latest eligible release asset/);
});

test("manual CI workflow publishes desktop installers without standalone runtime tar assets", async () => {
  const [source, builderConfig] = await Promise.all([
    readFile(ciWorkflowPath, "utf8"),
    readFile(electronBuilderConfigPath, "utf8"),
  ]);

  assert.match(source, /^name: CI$/m);
  assert.match(source, /HOLABOSS_RELEASES_REPO: holaboss-ai\/holaOS-releases/);
  assert.match(source, /workflow_dispatch:\n\s+inputs:\n\s+ref:/);
  assert.match(source, /release_tag:\n\s+description: GitHub release tag to create in holaOS-releases/);
  assert.match(source, /release_title:\n\s+description: Optional GitHub release title \(defaults to Holaboss <version>\)/);
  assert.match(source, /prerelease:\n\s+description: Mark the GitHub release as a prerelease/);
  assert.match(source, /release_channel:\n\s+description: Auto-update channel to publish for desktop clients/);
  assert.match(source, /default: latest/);
  assert.match(source, /type: choice/);
  assert.match(source, /options:\n\s+- latest\n\s+- beta/);
  assert.match(source, /release_tag must match Holaboss-YYYY\.MDD\.R/);
  assert.match(source, /release_version="\$\{release_tag#Holaboss-\}"/);
  assert.match(source, /release_title="Holaboss \$\{release_version\}"/);
  assert.match(source, /release_channel="\$\{\{ inputs\.release_channel \}\}"/);
  assert.match(source, /beta channel releases must be marked as prerelease/);
  assert.match(source, /latest channel releases must not be marked as prerelease/);
  assert.match(source, /Ensure release tag is available/);
  assert.match(source, /manual release publishing to \$\{RELEASE_GH_REPO\} requires HOLABOSS_RELEASES_REPO_TOKEN/);
  assert.match(source, /release tag \$\{RELEASE_TAG\} already exists in \$\{RELEASE_GH_REPO\}/);
  assert.match(source, /release \$\{RELEASE_TAG\} already exists in \$\{RELEASE_GH_REPO\}/);
  assert.doesNotMatch(source, /gh release create "\$\{RELEASE_TAG\}" \\\n\s+--title "\$\{RELEASE_TITLE\}" \\\n\s+--notes-file "\$\{notes_path\}" \\\n\s+--draft/);
  assert.doesNotMatch(source, /gh release edit "\$\{RELEASE_TAG\}" \\\n\s+--title "\$\{RELEASE_TITLE\}" \\\n\s+--notes-file "\$\{notes_path\}" \\\n\s+--draft/);
  assert.match(source, /HOLABOSS_RUNTIME_DIR: \$\{\{ github\.workspace \}\}\/out\/runtime-macos/);
  assert.doesNotMatch(source, /HOLABOSS_RUNTIME_TARBALL:/);
  assert.doesNotMatch(source, /RUNTIME_ASSET_NAME: holaboss-runtime-linux\.tar\.gz/);
  assert.doesNotMatch(source, /RUNTIME_ASSET_NAME: holaboss-runtime-macos\.tar\.gz/);
  assert.doesNotMatch(source, /RUNTIME_ASSET_NAME: holaboss-runtime-windows\.tar\.gz/);
  assert.doesNotMatch(source, /gh release upload "\$\{RELEASE_TAG\}"/);
  assert.match(source, /Build desktop code for macOS release/);
  assert.match(source, /- name: Install workspace dependencies \(covers desktop\)\n\s+env:\n\s+ELECTRON_SKIP_BINARY_DOWNLOAD: "1"\n\s+run: bun install --frozen-lockfile/);
  assert.match(source, /Build signed macOS app bundle/);
  assert.match(source, /app-update\.yml is missing from signed app bundle/);
  assert.match(source, /packaged_app="\$\{RUNNER_TEMP\}\/Holaboss\.app"/);
  assert.doesNotMatch(source, /node scripts\/write-app-update-config\.mjs "\$\{prepackaged_app\}"/);
  assert.doesNotMatch(source, /app-update\.yml is missing from prepackaged macOS app bundle/);
  // dmg + zip are built as separate electron-builder calls inside the helper
  // script to work around a packing bug that stripped the Electron Framework
  // main binary from the DMG (see holaOS-2026.608.2). The workflow must call
  // the helper with the arm64 arch flag rather than running electron-builder
  // directly here.
  assert.match(source, /bash scripts\/build-mac-release-artifacts\.sh "\$\{app_path\}" --arm64/);
  assert.doesNotMatch(source, /--prepackaged "\$\{app_path\}" \\\n\s+--mac dmg zip \\/);
  assert.match(source, /primary_manifest_name="beta-mac\.yml"/);
  assert.match(source, /primary_manifest_name="latest-mac\.yml"/);
  assert.match(source, /beta-mac\.yml was not generated for stable-channel compatibility/);
  assert.match(source, /files: is missing a \.zip entry/);
  assert.match(source, /files: is missing a \.dmg entry/);
  assert.match(source, /macOS zip does not contain Holaboss\.app as the root app bundle/);
  assert.match(source, /app-update\.yml is missing from final macOS zip/);
  assert.match(source, /extract_dir="\$\{RUNNER_TEMP\}\/mac-zip-signature-verify"/);
  assert.match(source, /Holaboss\.app was not extracted from the final macOS zip/);
  assert.match(source, /codesign --verify --deep --strict --verbose=2 "\$\{extracted_app\}"/);
  assert.match(source, /spctl -a -vv -t exec "\$\{extracted_app\}"/);
  assert.match(source, /xcrun stapler validate "\$\{extracted_app\}"/);
  assert.match(source, /Validate macOS DMG bundle signing/);
  assert.match(source, /hdiutil attach -nobrowse -readonly -mountroot "\$\{mount_dir\}" "\$\{dmg_path\}"/);
  assert.match(source, /Electron Framework main binary is missing from DMG/);
  assert.match(source, /codesign --verify --deep --strict --verbose=2 "\$\{mounted_app\}"/);
  assert.match(source, /spctl -a -vv -t exec "\$\{mounted_app\}"/);
  assert.match(source, /xcrun stapler validate "\$\{mounted_app\}"/);
  assert.match(source, /release-macos-intel-desktop:/);
  assert.match(source, /uses: \.\/\.github\/workflows\/publish-macos-intel-desktop\.yml/);
  assert.match(source, /artifact_only: true/);
  assert.doesNotMatch(source, /Verify published macOS release assets from GitHub/);
  assert.doesNotMatch(source, /gh release download "\$\{RELEASE_TAG\}"/);
  assert.doesNotMatch(source, /published macOS zip is missing Holaboss\.app\/Contents\/Resources\/app-update\.yml/);
  assert.doesNotMatch(source, /raise "latest-mac\.yml path does not match uploaded zip"/);
  assert.doesNotMatch(source, /raise "beta-mac\.yml path does not match uploaded zip"/);
  assert.match(source, /publish-release:/);
  assert.match(source, /needs\.release-macos-intel-desktop\.result == 'success'/);
  assert.match(source, /needs:\n\s+- ensure-release\n\s+- release-linux-runtime\n\s+- release-macos-desktop\n\s+- release-macos-intel-desktop\n\s+- release-windows-desktop/);
  assert.match(source, /Download macOS desktop release artifacts/);
  assert.match(source, /name: holaboss-desktop-macos-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(source, /Download Intel macOS desktop release artifacts/);
  assert.match(source, /name: holaboss-desktop-macos-intel-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(source, /Download Windows desktop release artifacts/);
  assert.match(source, /name: holaboss-desktop-windows-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(source, /Checkout release repository helpers/);
  assert.match(source, /ref: \$\{\{ needs\.ensure-release\.outputs\.release_sha \}\}/);
  assert.match(source, /Merge shared macOS updater manifests/);
  assert.match(source, /ruby apps\/desktop\/scripts\/merge-mac-update-manifests\.rb \\/);
  assert.match(source, /merged macOS updater manifest is missing an arm64 ZIP/);
  assert.match(source, /merged macOS updater manifest is missing an Intel ZIP/);
  assert.match(source, /SOURCE_GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(source, /RELEASE_GH_REPO: holaboss-ai\/holaOS-releases/);
  assert.match(source, /SOURCE_GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(source, /GH_TOKEN="\$\{SOURCE_GH_TOKEN\}" gh api "repos\/\$\{SOURCE_GH_REPO\}\/releases\/generate-notes"/);
  assert.match(source, /sed -i\.bak \\/);
  assert.match(source, /-e '\/\^\\\*\\\*Full Changelog\\\*\\\*:\/d' \\/);
  assert.match(source, /-e '\/\^Full Changelog:\/d' \\/);
  assert.match(source, /rm -f "\$\{notes_path\}\.bak"/);
  assert.match(source, /tag_name=\$\{RELEASE_TAG\}/);
  assert.match(source, /target_commitish=\$\{RELEASE_SHA\}/);
  assert.match(source, /mac_dmg_asset="release-assets\/macos-desktop\/Holaboss-macos-arm64\.dmg"/);
  assert.match(source, /mac_zip_asset="\$\(find release-assets\/macos-desktop -maxdepth 1 -name '\*\.zip' ! -name '\*\.blockmap' -print -quit\)"/);
  assert.match(source, /mac_zip_blockmap_asset="\$\{mac_zip_asset\}\.blockmap"/);
  assert.match(source, /mac_intel_dmg_asset="release-assets\/macos-intel-desktop\/Holaboss-macos-x64\.dmg"/);
  assert.match(source, /mac_intel_zip_asset="\$\(find release-assets\/macos-intel-desktop -maxdepth 1 -name '\*\.zip' ! -name '\*\.blockmap' -print -quit\)"/);
  assert.match(source, /mac_intel_zip_blockmap_asset="\$\{mac_intel_zip_asset\}\.blockmap"/);
  assert.match(source, /missing Intel macOS DMG release asset/);
  assert.match(source, /missing Intel macOS zip release asset/);
  assert.match(source, /missing Intel macOS zip blockmap release asset/);
  assert.match(source, /mac_manifest_dir="release-assets\/macos-updates"/);
  assert.match(source, /missing merged macOS updater manifests/);
  assert.match(source, /upload_paths=\(\)/);
  assert.match(source, /declare -A upload_asset_names=\(\)/);
  assert.match(source, /duplicate release asset name would be uploaded/);
  assert.match(source, /append_upload_path "\$\{mac_intel_dmg_asset\}"/);
  assert.match(source, /append_upload_path "\$\{mac_intel_zip_asset\}"/);
  assert.match(source, /append_upload_path "\$\{mac_intel_zip_blockmap_asset\}"/);
  assert.match(source, /while IFS= read -r manifest_path; do\s+append_upload_path "\$\{manifest_path\}"/);
  assert.match(source, /windows_installer_asset="\$\{windows_release_dir\}\/Holaboss-windows-x64-setup\.exe"/);
  assert.match(source, /missing Windows installer release asset/);
  assert.match(source, /missing Windows installer blockmap release asset/);
  assert.match(source, /does not reference Holaboss-windows-x64-setup\.exe/);
  assert.match(source, /missing Windows auto-update manifest release asset/);
  assert.match(source, /append_upload_path "\$\{windows_installer_asset\}"/);
  assert.match(source, /append_upload_path "\$\{windows_blockmap_asset\}"/);
  assert.match(source, /append_upload_path "\$\{windows_manifest_asset\}"/);
  assert.doesNotMatch(source, /holaboss-runtime-windows\.tar\.gz/);
  assert.match(source, /prerelease_flag=\(\)/);
  assert.match(source, /if \[ "\$\{PRERELEASE\}" = "true" \]; then\s+prerelease_flag\+=\(--prerelease\)/);
  assert.match(
    source,
    /gh release create "\$\{RELEASE_TAG\}" \\\n\s+--repo "\$\{RELEASE_GH_REPO\}" \\\n\s+--title "\$\{RELEASE_TITLE\}" \\\n\s+--notes-file "\$\{notes_path\}" \\\n\s+"\$\{prerelease_flag\[@\]\}" \\\n\s+"\$\{upload_paths\[@\]\}"/,
  );
  assert.doesNotMatch(source, /gh release edit "\$\{RELEASE_TAG\}" \\\n\s+--draft=false/);
  assert.match(source, /\$manifestName = if \(\$primaryChannel -eq "beta"\) \{ "beta\.yml" \} else \{ "latest\.yml" \}/);
  assert.match(source, /beta\.yml was not generated for stable-channel compatibility/);
  assert.match(builderConfig, /repo: githubReleasesRepo/);
  assert.match(builderConfig, /generateUpdatesFilesForAllChannels: true/);
  assert.match(builderConfig, /\.\.\.\(releaseChannel === "beta" \? \{ channel: releaseChannel \} : \{\}\)/);
  assert.match(builderConfig, /"node-runtime\/\*\*\/\*"/);
  assert.match(builderConfig, /"python-runtime\/\*\*\/\*"/);
  assert.doesNotMatch(builderConfig, /HOLABOSS_BUNDLE_TOOLCHAIN_SEED/);
  assert.doesNotMatch(builderConfig, /HOLABOSS_TOOLCHAIN_TARBALL/);
  assert.match(builderConfig, /afterPack: async \(context\) => \{/);
  assert.match(builderConfig, /if \(context\.electronPlatformName !== "darwin"\) \{/);
  assert.match(builderConfig, /const \{ writeAppUpdateConfig \} = await import\(/);
  assert.match(builderConfig, /scripts", "write-app-update-config\.mjs"/);
  assert.match(builderConfig, /await writeAppUpdateConfig\(appBundlePath\);/);
  assert.match(source, /Desktop typecheck/);
  assert.match(source, /Runtime harness host tests/);
});

test("mac release helper runs zip + dmg in separate electron-builder passes and merges their manifests", async () => {
  const helperPath = path.join(
    __dirname,
    "..",
    "scripts",
    "build-mac-release-artifacts.sh",
  );
  const source = await readFile(helperPath, "utf8");

  // Two electron-builder invocations — never combined — to dodge the
  // 2026.608.2 packing bug where `--mac dmg zip` shipped a DMG with a
  // stripped Electron Framework binary.
  assert.match(source, /--mac zip \\\n\s+"\$\{arch_flag\}" \\/);
  assert.match(source, /--mac dmg \\\n\s+"\$\{arch_flag\}" \\/);
  // Use \\\n to avoid matching the historical reference in the file header.
  assert.doesNotMatch(source, /--mac dmg zip \\\n/);
  // Save the zip-pass manifests so the dmg pass doesn't drop the zip entry
  // from files:, then merge them back via the existing Ruby merge script
  // with the zip pass as primary (so files[0] / top-level path stay the zip).
  assert.match(source, /zip_manifest_backup_dir="\$\(mktemp -d\)"/);
  assert.match(source, /zip pass did not produce any \*-mac\.yml updater manifests/);
  assert.match(
    source,
    /ruby "\$\{scripts_dir\}\/merge-mac-update-manifests\.rb" \\\n\s+"\$\{merged_tmp\}" \\\n\s+"\$\{zip_manifest_path\}" \\\n\s+"\$\{dmg_manifest_path\}"/,
  );
});

test("docs workflow remains independent and CI ignores docs-only changes", async () => {
  const ciSource = await readFile(ciWorkflowPath, "utf8");

  await assert.rejects(readFile(docsWorkflowPath, "utf8"), /ENOENT/);
  assert.match(ciSource, /paths-ignore:\n\s+- apps\/docs\/\*\*/);
});
