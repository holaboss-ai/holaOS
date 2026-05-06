import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildRuntimeSentryDiagnostics,
  redactRuntimeSentryText,
  redactRuntimeSentryValue,
} from "./runtime-sentry.js";

const tempDirs: string[] = [];
const ENV_KEYS = [
  "HOLABOSS_HOST_STATE_DB_PATH",
  "HOLABOSS_RUNTIME_DB_PATH",
  "HOLABOSS_RUNTIME_LOG_PATH",
  "HOLABOSS_RUNTIME_CONFIG_PATH",
  "HOLABOSS_RUNTIME_VERSION",
  "HOLABOSS_DESKTOP_LAUNCH_ID",
];

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("runtime sentry diagnostics redact config and log attachments", () => {
  const root = makeTempDir("hb-runtime-sentry-");
  const hostStateDbPath = path.join(root, "host-state.db");
  const runtimeLogPath = path.join(root, "runtime.log");
  const runtimeConfigPath = path.join(root, "runtime-config.json");

  fs.writeFileSync(hostStateDbPath, "");
  fs.writeFileSync(
    runtimeLogPath,
    'token=abc123\ncookie=session-secret\nnormal line\n',
    "utf8",
  );
  fs.writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      runtime: {
        auth_token: "secret-token",
      },
      providers: {
        openai: {
          api_key: "sk-live",
        },
      },
    }),
    "utf8",
  );

  process.env.HOLABOSS_HOST_STATE_DB_PATH = hostStateDbPath;
  process.env.HOLABOSS_RUNTIME_LOG_PATH = runtimeLogPath;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = runtimeConfigPath;
  process.env.HOLABOSS_RUNTIME_VERSION = "holaboss-desktop-2026.420.1";
  process.env.HOLABOSS_DESKTOP_LAUNCH_ID = "launch-123";

  const diagnostics = buildRuntimeSentryDiagnostics();
  const configAttachment = diagnostics.attachments.find(
    (attachment) => attachment.filename === "runtime-config.redacted.json",
  );
  const logAttachment = diagnostics.attachments.find(
    (attachment) => attachment.filename === "runtime-log-tail.txt",
  );
  const snapshotAttachment = diagnostics.attachments.find(
    (attachment) => attachment.filename === "runtime-diagnostics.json",
  );

  assert.ok(configAttachment);
  assert.equal(configAttachment?.contentType, "application/json");
  assert.match(String(configAttachment?.data ?? ""), /\[REDACTED\]/);
  assert.doesNotMatch(String(configAttachment?.data ?? ""), /secret-token|sk-live/);

  assert.ok(logAttachment);
  assert.match(String(logAttachment?.data ?? ""), /\[REDACTED\]/);
  assert.doesNotMatch(String(logAttachment?.data ?? ""), /abc123|session-secret/);

  assert.ok(snapshotAttachment);
  assert.match(String(snapshotAttachment?.data ?? ""), /launch-123/);
  assert.equal(
    diagnostics.contexts.runtime_process?.desktop_launch_id,
    "launch-123",
  );
});

test("runtime sentry redaction helpers scrub secret-shaped values", () => {
  assert.equal(
    redactRuntimeSentryText("authorization=Bearer super-secret"),
    "authorization=[REDACTED]",
  );
  assert.deepEqual(
    redactRuntimeSentryValue({
      access_token: "secret",
      nested: {
        refresh_token: "secret-2",
      },
    }),
    {
      access_token: "[REDACTED]",
      nested: {
        refresh_token: "[REDACTED]",
      },
    },
  );
});
