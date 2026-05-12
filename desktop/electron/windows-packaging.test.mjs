import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DESKTOP_PACKAGE_PATH = new URL("../package.json", import.meta.url);
const BUILDER_CONFIG_PATH = new URL("../electron-builder.config.cjs", import.meta.url);
const RUN_ELECTRON_BUILDER_PATH = new URL("../scripts/run-electron-builder.mjs", import.meta.url);
const CI_WORKFLOW_PATH = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("windows packaging scripts prepare the packaged config before building installers", async () => {
  const packageJson = JSON.parse(await readFile(DESKTOP_PACKAGE_PATH, "utf8"));

  assert.match(packageJson.scripts["dist:win"], /prepare:packaged-config/);
  assert.match(packageJson.scripts["dist:win:local"], /prepare:packaged-config/);
});

test("desktop packaging does not publish standalone Windows runtime tar artifacts", async () => {
  const [workflowSource, packagedConfigSource] = await Promise.all([
    readFile(CI_WORKFLOW_PATH, "utf8"),
    readFile(new URL("../scripts/write-packaged-config.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workflowSource, /No staged Windows runtime bundle was produced under desktop\/out\/runtime-windows\./);
  assert.doesNotMatch(workflowSource, /RUNTIME_ASSET_NAME: holaboss-runtime-windows\.tar\.gz/);
  assert.doesNotMatch(workflowSource, /runtime_asset_path=/);
  assert.doesNotMatch(workflowSource, /desktop\/out\/\$\{\{ env\.RUNTIME_ASSET_NAME \}\}/);
  assert.doesNotMatch(workflowSource, /TOOLCHAIN_ASSET_NAME: holaboss-toolchain-windows\.tar\.gz/);
  assert.doesNotMatch(workflowSource, /toolchain_asset_path=/);
  assert.doesNotMatch(workflowSource, /desktop\/out\/\$\{\{ env\.TOOLCHAIN_ASSET_NAME \}\}/);
  assert.doesNotMatch(packagedConfigSource, /toolchainManifest,/);
});

test("windows packaging config and CI workflow support optional signing and NSIS installer publishing", async () => {
  const [builderConfigSource, runElectronBuilderSource, workflowSource] = await Promise.all([
    readFile(BUILDER_CONFIG_PATH, "utf8"),
    readFile(RUN_ELECTRON_BUILDER_PATH, "utf8"),
    readFile(CI_WORKFLOW_PATH, "utf8"),
  ]);

  assert.match(builderConfigSource, /const windowsSigningConfigured = Boolean\(/);
  assert.match(builderConfigSource, /process\.env\.WIN_CSC_LINK \|\| process\.env\.CSC_LINK/);
  assert.match(builderConfigSource, /signAndEditExecutable: windowsSigningConfigured,/);

  assert.match(runElectronBuilderSource, /const electronBuilderCli = path\.join\(/);
  assert.match(runElectronBuilderSource, /"node_modules",\s*"electron-builder",\s*"cli\.js"/);
  assert.match(runElectronBuilderSource, /const match = trimmed\.match\(\/\(\\d\+\\\.\\d\+\\\.\\d\+\)\$\/\);/);
  assert.match(runElectronBuilderSource, /spawn\(process\.execPath, \[electronBuilderCli, \.\.\.builderArgs\], \{/);

  assert.match(workflowSource, /^name: CI$/m);
  assert.match(workflowSource, /release-windows-desktop:/);
  assert.match(workflowSource, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.release_windows \}\}/);
  assert.match(workflowSource, /runs-on: windows-latest/);
  assert.match(workflowSource, /release_tag must match holaOS-YYYY\.MDD\.R/);
  assert.match(workflowSource, /DESKTOP_RELEASE_ASSET_NAME: holaOS-windows-x64-setup\.exe/);
  assert.match(workflowSource, /- name: Prepare desktop \(build SDK \+ install desktop deps\)\n\s+env:\n\s+ELECTRON_SKIP_BINARY_DOWNLOAD: "1"\n\s+run: npm run desktop:prepare/);
  assert.match(workflowSource, /CSC_LINK: \$\{\{ env\.WINDOWS_CERTIFICATE \}\}/);
  assert.match(workflowSource, /npm run dist:win:local/);
  assert.match(workflowSource, /generated_installer_path=/);
  assert.match(workflowSource, /\$manifestName = if \(\$primaryChannel -eq "beta"\) \{ "beta\.yml" \} else \{ "latest\.yml" \}/);
  assert.match(workflowSource, /\$manifestName was not generated/);
  assert.match(workflowSource, /Get-ChildItem -Path desktop\/out\/release -File -Filter \*\.blockmap/);
  assert.match(workflowSource, /uses: actions\/upload-artifact@v7/);
  assert.match(workflowSource, /name: \$\{\{ env\.DESKTOP_ASSET_PREFIX \}\}-\$\{\{ inputs\.release_tag \}\}/);
});
