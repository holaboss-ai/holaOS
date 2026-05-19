import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";
import * as workspacePackager from "./workspace-packager.ts";

/** Stub automations fetcher that returns zero automations */
const zeroAutomationsFetcher = async () => ({
  yaml: "version: 1\nautomations: []\n",
  count: 0,
});

test("packageWorkspace resolves for a minimal workspace", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );

  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "README.md"), "# Test\n", "utf8");

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("packageWorkspace timed out")), 1000);
  });

  const result = await Promise.race([
    workspacePackager.packageWorkspace({
      workspaceDir,
      apps: [],
      manifest: { name: "Test template", version: "1.0.0" },
      runtimeBaseUrl: "http://127.0.0.1:8080",
      workspaceId: "test-workspace-id",
      automationsFetcher: zeroAutomationsFetcher,
    }),
    timeout,
  ]);

  assert.ok(result.archiveSizeBytes > 0);
  assert.ok(Buffer.isBuffer(result.archiveBuffer));
});

test("buildPresignedUploadHeaders omits content-type when the presigned URL does not sign it", async () => {
  const headers = workspacePackager.buildPresignedUploadHeaders(
    "https://storage.example/upload?X-Amz-SignedHeaders=host",
    Buffer.byteLength("archive"),
  );

  assert.equal(headers["Content-Type"], undefined);
  assert.equal(headers["Content-Length"], String(Buffer.byteLength("archive")));
});

test("buildPresignedUploadError includes the response body and signed headers", async () => {
  const message = workspacePackager.buildPresignedUploadError(
    "https://storage.example/upload?X-Amz-SignedHeaders=host%3Bcontent-type",
    403,
    "<Error><Code>SignatureDoesNotMatch</Code></Error>",
  );

  assert.match(message, /403/);
  assert.match(message, /SignatureDoesNotMatch/);
  assert.match(message, /host, content-type/);
  assert.match(message, /storage\.example/);
});

test("packageWorkspace includes automations.yaml and sets automations_count: 0 when empty", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );
  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");

  const result = await workspacePackager.packageWorkspace({
    workspaceDir,
    apps: [],
    manifest: { name: "Test template", version: "1.0.0" },
    runtimeBaseUrl: "http://127.0.0.1:8080",
    workspaceId: "test-workspace-id",
    automationsFetcher: zeroAutomationsFetcher,
  });

  const zip = await JSZip.loadAsync(result.archiveBuffer);

  // automations.yaml must be present
  const yamlFile = zip.file("automations.yaml");
  assert.ok(yamlFile !== null, "automations.yaml should be in archive");
  const yamlStr = await yamlFile.async("string");
  assert.match(yamlStr, /automations/);

  // manifest.json must have automations_count: 0
  const manifestFile = zip.file("manifest.json");
  assert.ok(manifestFile !== null, "manifest.json should be in archive");
  const manifest = JSON.parse(await manifestFile.async("string"));
  assert.equal(manifest.automations_count, 0);
});

test("fetchAndSerializeAutomations strips runtime-only fields and preserves user-authored fields", async () => {
  const fakeFetch = async (_url) => ({
    ok: true,
    json: async () => ({
      jobs: [
        {
          id: "job-1",
          workspace_id: "ws-abc",
          initiated_by: "user",
          name: "Morning briefing",
          cron: "0 8 * * *",
          description: "Summarize overnight activity",
          instruction: "Summarize my inbox",
          enabled: true,
          delivery: { mode: "announce", channel: "system_notification", to: null },
          metadata: { author_tags: ["daily"] },
          last_run_at: "2026-04-17T08:00:00Z",
          next_run_at: "2026-04-18T08:00:00Z",
          run_count: 5,
          last_status: "success",
          last_error: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-04-17T08:00:00Z",
        },
        {
          id: "job-2",
          workspace_id: "ws-abc",
          initiated_by: "user",
          name: "Weekly recap",
          cron: "0 9 * * 1",
          description: "Weekly summary",
          instruction: "Send weekly recap",
          enabled: false,
          delivery: { mode: "announce", channel: "system_notification", to: null },
          metadata: {},
          last_run_at: null,
          next_run_at: null,
          run_count: 0,
          last_status: null,
          last_error: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      count: 2,
    }),
  });

  const result = await workspacePackager.fetchAndSerializeAutomations(
    "http://127.0.0.1:8080",
    "ws-abc",
    fakeFetch,
  );

  assert.equal(result.count, 2);

  // Parse the YAML and verify only user-authored fields are present
  const { parse: yamlParse } = await import("yaml");
  const parsed = yamlParse(result.yaml);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.automations.length, 2);

  const job = parsed.automations[0];
  // User-authored fields must be present
  assert.equal(job.name, "Morning briefing");
  assert.equal(job.cron, "0 8 * * *");
  assert.equal(job.description, "Summarize overnight activity");
  assert.equal(job.instruction, "Summarize my inbox");
  assert.equal(job.enabled, true);
  assert.deepEqual(job.delivery, { mode: "announce", channel: "system_notification", to: null });
  assert.deepEqual(job.metadata, { author_tags: ["daily"] });

  // Runtime-only fields must NOT be present
  assert.equal(job.id, undefined);
  assert.equal(job.workspace_id, undefined);
  assert.equal(job.last_run_at, undefined);
  assert.equal(job.next_run_at, undefined);
  assert.equal(job.run_count, undefined);
  assert.equal(job.last_status, undefined);
  assert.equal(job.created_at, undefined);
  assert.equal(job.updated_at, undefined);
  assert.equal(job.initiated_by, undefined);
});

test("fetchAndSerializeAutomations rejects with fetch cronjobs failed when fetch throws", async () => {
  const failingFetch = async (_url) => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    () =>
      workspacePackager.fetchAndSerializeAutomations(
        "http://127.0.0.1:8080",
        "ws-abc",
        failingFetch,
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /fetch cronjobs failed/);
      return true;
    },
  );
});

test("packageWorkspace honors forceExcludePaths for individual files", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );
  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "README.md"), "# Test\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "secret.md"), "secret\n", "utf8");

  const result = await workspacePackager.packageWorkspace({
    workspaceDir,
    apps: [],
    manifest: { name: "Test", version: "1.0.0" },
    runtimeBaseUrl: "http://127.0.0.1:8080",
    workspaceId: "test-workspace-id",
    forceExcludePaths: ["secret.md"],
    automationsFetcher: zeroAutomationsFetcher,
  });

  const zip = await JSZip.loadAsync(result.archiveBuffer);
  assert.ok(zip.file("README.md"), "README.md should be bundled");
  assert.equal(zip.file("secret.md"), null, "secret.md should be excluded");
});

test("packageWorkspace honors forceExcludePaths as a directory prefix", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );
  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");
  await fs.mkdir(path.join(workspaceDir, "skills", "alpha"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "skills", "alpha", "SKILL.md"),
    "skill\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "skills", "beta.md"),
    "skill\n",
    "utf8",
  );
  await fs.writeFile(path.join(workspaceDir, "README.md"), "ok\n", "utf8");

  const result = await workspacePackager.packageWorkspace({
    workspaceDir,
    apps: [],
    manifest: { name: "Test", version: "1.0.0" },
    runtimeBaseUrl: "http://127.0.0.1:8080",
    workspaceId: "test-workspace-id",
    forceExcludePaths: ["skills"],
    automationsFetcher: zeroAutomationsFetcher,
  });

  const zip = await JSZip.loadAsync(result.archiveBuffer);
  assert.ok(zip.file("README.md"), "files outside the prefix stay bundled");
  assert.equal(
    zip.file("skills/beta.md"),
    null,
    "files directly under the prefix should be excluded",
  );
  assert.equal(
    zip.file("skills/alpha/SKILL.md"),
    null,
    "files in nested subdirs under the prefix should be excluded",
  );
});

test("forceExcludePaths cannot bypass the sensitive-file blocker", async () => {
  // The user might list a credential path in forceExcludePaths thinking
  // they're opting-in (UI never offers that path because it's not a
  // candidate). Make sure listing it as exclude doesn't suddenly include
  // it — the safety nets remain authoritative.
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );
  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "secret.pem"), "key\n", "utf8");

  const preview = await workspacePackager.previewBundle(workspaceDir, [], [
    "secret.pem",
  ]);
  // .pem matches isSensitive — should be classified credential, not user_excluded.
  const entry = preview.excluded.find((e) => e.path === "secret.pem");
  assert.ok(entry, "secret.pem must appear in excluded list");
  assert.equal(entry.reason, "credential");
});

test("previewBundle classifies user opt-outs as user_excluded", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-packager-"),
  );
  await fs.writeFile(path.join(workspaceDir, "workspace.yaml"), "name: test\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "drop-me.md"), "x\n", "utf8");

  const preview = await workspacePackager.previewBundle(workspaceDir, [], [
    "drop-me.md",
  ]);
  const entry = preview.excluded.find((e) => e.path === "drop-me.md");
  assert.ok(entry);
  assert.equal(entry.reason, "user_excluded");
  assert.ok(
    !preview.included.some((i) => i.path === "drop-me.md"),
    "user-excluded files must not appear in included",
  );
});
