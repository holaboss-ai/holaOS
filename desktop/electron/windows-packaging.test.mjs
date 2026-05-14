import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DESKTOP_PACKAGE_PATH = new URL("../package.json", import.meta.url);
const BUILDER_CONFIG_PATH = new URL("../electron-builder.config.cjs", import.meta.url);
const RUN_ELECTRON_BUILDER_PATH = new URL("../scripts/run-electron-builder.mjs", import.meta.url);
const NPM_RUNNER_PATH = new URL("../scripts/npm-runner.mjs", import.meta.url);
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

  assert.match(builderConfigSource, /const windowsCertificateSigningConfigured = Boolean\(/);
  assert.match(builderConfigSource, /readEnv\("WIN_CSC_LINK"\) \|\| readEnv\("CSC_LINK"\)/);
  assert.match(builderConfigSource, /const windowsAzureSigningEnv = \{/);
  assert.match(builderConfigSource, /WINDOWS_SIGNING_CERTIFICATE_PROFILE_NAME/);
  assert.match(builderConfigSource, /azureSignOptions: windowsAzureSigningConfig/);
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
  assert.match(workflowSource, /- name: Validate Azure Trusted Signing credentials/);
  assert.match(workflowSource, /https:\/\/login\.microsoftonline\.com\/\$env:AZURE_TENANT_ID\/oauth2\/v2\.0\/token/);
  assert.match(workflowSource, /scope = "https:\/\/codesigning\.azure\.net\/\.default"/);
  assert.match(workflowSource, /Update AZURE_CLIENT_SECRET to the client secret Value from Microsoft Entra, not the Secret ID/);
  assert.match(workflowSource, /- name: Prepare desktop \(build SDK \+ install desktop deps\)\n\s+env:\n\s+ELECTRON_SKIP_BINARY_DOWNLOAD: "1"\n\s+run: npm run desktop:prepare/);
  assert.match(workflowSource, /WINDOWS_SIGNING_ENDPOINT: \$\{\{ vars\.WINDOWS_SIGNING_ENDPOINT \}\}/);
  assert.match(workflowSource, /WINDOWS_SIGNING_ACCOUNT_NAME: \$\{\{ vars\.WINDOWS_SIGNING_ACCOUNT_NAME \}\}/);
  assert.match(workflowSource, /WINDOWS_SIGNING_CERTIFICATE_PROFILE_NAME: \$\{\{ vars\.WINDOWS_SIGNING_CERTIFICATE_PROFILE_NAME \}\}/);
  assert.match(workflowSource, /WINDOWS_SIGNING_PUBLISHER_NAME: \$\{\{ vars\.WINDOWS_SIGNING_PUBLISHER_NAME \}\}/);
  assert.match(workflowSource, /AZURE_TENANT_ID: \$\{\{ secrets\.AZURE_TENANT_ID \}\}/);
  assert.match(workflowSource, /AZURE_CLIENT_ID: \$\{\{ secrets\.AZURE_CLIENT_ID \}\}/);
  assert.match(workflowSource, /AZURE_CLIENT_SECRET: \$\{\{ secrets\.AZURE_CLIENT_SECRET \}\}/);
  assert.match(workflowSource, /Get-AuthenticodeSignature -FilePath \$stablePath/);
  assert.doesNotMatch(workflowSource, /WINDOWS_CERTIFICATE:/);
  assert.match(workflowSource, /npm run dist:win:local/);
  assert.match(workflowSource, /if \(\$LASTEXITCODE -ne 0\) \{/);
  assert.match(workflowSource, /npm run dist:win:local failed with exit code \$LASTEXITCODE/);
  assert.match(workflowSource, /Contents of desktop\/out\/release:/);
  assert.match(workflowSource, /generated_installer_path=/);
  assert.match(workflowSource, /\$manifestName = if \(\$primaryChannel -eq "beta"\) \{ "beta\.yml" \} else \{ "latest\.yml" \}/);
  assert.match(workflowSource, /\$manifestName was not generated/);
  assert.match(workflowSource, /Get-ChildItem -Path desktop\/out\/release -File -Filter \*\.blockmap/);
  assert.match(workflowSource, /uses: actions\/upload-artifact@v7/);
  assert.match(workflowSource, /name: \$\{\{ env\.DESKTOP_ASSET_PREFIX \}\}-\$\{\{ inputs\.release_tag \}\}/);
});

test("desktop helper scripts invoke npm through the Windows-safe runner", async () => {
  const [
    npmRunnerSource,
    ensureAppSdkSource,
    ensureRuntimeClientSource,
    ensureEditorSource,
    ensureRuntimeBundleSource,
  ] = await Promise.all([
    readFile(NPM_RUNNER_PATH, "utf8"),
    readFile(new URL("../scripts/ensure-app-sdk.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/ensure-runtime-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/ensure-editor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/ensure-runtime-bundle.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(npmRunnerSource, /process\.platform === "win32"/);
  assert.match(npmRunnerSource, /process\.env\.npm_execpath/);
  assert.match(npmRunnerSource, /command: process\.execPath/);
  assert.match(npmRunnerSource, /command: "npm\.cmd"/);
  assert.match(npmRunnerSource, /failed to spawn \$\{command\}/);

  for (const source of [
    ensureAppSdkSource,
    ensureRuntimeClientSource,
    ensureEditorSource,
    ensureRuntimeBundleSource,
  ]) {
    assert.match(source, /import \{ runNpm \} from "\.\/npm-runner\.mjs";/);
    assert.doesNotMatch(source, /spawnSync\("npm"/);
  }
});
