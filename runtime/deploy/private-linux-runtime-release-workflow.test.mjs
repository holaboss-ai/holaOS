import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, "..", "..", ".github", "workflows", "publish-linux-runtime.yml");

test("private Linux runtime workflow publishes backend-compatible release assets", async () => {
  const source = await readFile(workflowPath, "utf8");

  assert.match(source, /^name: Publish Private Linux Runtime$/m);
  assert.match(source, /workflow_call:\n\s+inputs:\n\s+ref:/);
  assert.match(source, /artifact_only:\n\s+required: false\n\s+type: boolean/);
  assert.match(source, /workflow_dispatch:\n\s+inputs:\n\s+ref:/);
  assert.match(source, /release_tag:\n\s+description: GitHub release tag to create or update/);
  assert.match(source, /release_channel:\n\s+description: Runtime release channel consumed by sandbox-runtime/);
  assert.match(source, /permissions:\n\s+contents: write/);
  assert.match(source, /RUNTIME_RELEASE_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(source, /Setup Bun/);
  assert.match(source, /RUNTIME_ASSET_NAME: holaboss-runtime-linux-x64\.tar\.gz/);
  assert.match(source, /RUNTIME_MANIFEST_NAME: holaboss-runtime-linux-x64\.json/);
  assert.match(source, /RUNTIME_CHECKSUM_ASSET_NAME: holaboss-runtime-linux-x64\.tar\.gz\.sha256/);
  assert.match(source, /release_tag must match holaOS-YYYY\.MDD\.R/);
  assert.match(source, /beta channel releases must be marked as prerelease/);
  assert.match(source, /latest channel releases must not be marked as prerelease/);
  assert.match(source, /Setup Node 24/);
  assert.match(source, /Build Linux runtime bundle/);
  assert.match(source, /bash runtime\/deploy\/package_linux_runtime\.sh out\/runtime-linux/);
  assert.match(source, /tar -C out\/runtime-linux -czf "out\/\$\{RUNTIME_ASSET_NAME\}" \./);
  assert.match(source, /"platform": "linux"/);
  assert.match(source, /"arch": "x64"/);
  assert.match(source, /"asset_name": "\$\{RUNTIME_ASSET_NAME\}"/);
  assert.match(source, /"sha256_asset_name": "\$\{RUNTIME_CHECKSUM_ASSET_NAME\}"/);
  assert.match(source, /archive_listing_path="\$\{RUNNER_TEMP\}\/linux-runtime-archive-listing\.txt"/);
  assert.match(source, /tar -tzf "out\/\$\{RUNTIME_ASSET_NAME\}" > "\$\{archive_listing_path\}"/);
  assert.match(source, /grep -Eq '\^\(\\\.\/\)\?bin\/sandbox-runtime\$' "\$\{archive_listing_path\}"/);
  assert.match(source, /Upload Linux runtime build artifacts/);
  assert.match(source, /if: \$\{\{ inputs\.artifact_only \}\}/);
  assert.match(source, /name: holaboss-runtime-linux-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(source, /if: \$\{\{ !inputs\.artifact_only \}\}/);
  assert.match(source, /cat > "\$\{notes_path\}" <<'EOF'/);
  assert.match(source, /gh release create "\$\{\{ steps\.release_meta\.outputs\.release_tag \}\}"/);
  assert.match(source, /--repo "\$\{RUNTIME_RELEASE_REPO\}"/);
  assert.match(source, /gh release upload "\$\{\{ steps\.release_meta\.outputs\.release_tag \}\}"/);
  assert.match(source, /"out\/\$\{RUNTIME_ASSET_NAME\}"/);
  assert.match(source, /"out\/\$\{RUNTIME_CHECKSUM_ASSET_NAME\}"/);
  assert.match(source, /"out\/\$\{RUNTIME_MANIFEST_NAME\}"/);
  assert.match(source, /--clobber/);
  assert.doesNotMatch(source, /holaboss-ai\/holaOS-releases/);
});

test("manual CI release dispatch invokes the Linux runtime publish workflow", async () => {
  const ciWorkflowPath = path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml");
  const source = await readFile(ciWorkflowPath, "utf8");

  assert.match(source, /release-linux-runtime:/);
  assert.match(source, /uses: \.\/\.github\/workflows\/publish-linux-runtime\.yml/);
  assert.match(source, /release-linux-runtime\.result == 'success'/);
  assert.match(source, /release_tag: \$\{\{ needs\.ensure-release\.outputs\.release_tag \}\}/);
  assert.match(source, /release_channel: \$\{\{ needs\.ensure-release\.outputs\.release_channel \}\}/);
  assert.match(source, /artifact_only: true/);
  assert.match(source, /Download Linux runtime release artifacts/);
  assert.match(source, /name: holaboss-runtime-linux-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(source, /linux_runtime_asset="\$\{linux_runtime_dir\}\/holaboss-runtime-linux-x64\.tar\.gz"/);
  assert.match(source, /linux_runtime_checksum_asset="\$\{linux_runtime_dir\}\/holaboss-runtime-linux-x64\.tar\.gz\.sha256"/);
  assert.match(source, /linux_runtime_manifest_asset="\$\{linux_runtime_dir\}\/holaboss-runtime-linux-x64\.json"/);
  assert.match(source, /missing Linux runtime release asset:/);
});
