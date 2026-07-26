import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runRuntimeConfigCli } from "./runtime-config-cli.js";

const tempDirs: string[] = [];
const envNames = [
  "HB_SANDBOX_ROOT",
  "HOLABOSS_RUNTIME_CONFIG_PATH",
  "HOLABOSS_SANDBOX_AUTH_TOKEN",
  "HOLABOSS_USER_ID",
  "HOLABOSS_MODEL_PROXY_BASE_URL",
  "HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT",
  "HOLABOSS_DEFAULT_MODEL"
] as const;

const envSnapshot = new Map<string, string | undefined>();

for (const name of envNames) {
  envSnapshot.set(name, process.env[name]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const name of envNames) {
    const value = envSnapshot.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("runRuntimeConfigCli resolves runtime config into a product payload", async () => {
  const root = makeTempDir("hb-runtime-config-cli-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "env-token";
  process.env.HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT = "https://runtime.example/api/v1/model-proxy";

  let stdout = "";
  let stderr = "";
  const exitCode = await runRuntimeConfigCli(
    [
      "resolve",
      "--request-base64",
      Buffer.from(
        JSON.stringify({
          require_auth: false,
          require_user: false,
          require_base_url: true,
          include_default_base_url: true
        }),
        "utf8"
      ).toString("base64")
    ],
    {
      io: {
        stdout: { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WritableStream,
        stderr: { write(chunk: string) { stderr += chunk; return true; } } as unknown as NodeJS.WritableStream
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    auth_token: "env-token",
    user_id: "",
    sandbox_id: "",
    model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
    default_model: "gpt-5.4",
    subagent_model: "",
    runtime_mode: "oss",
    default_provider: "",
    holaboss_enabled: false,
    desktop_browser_enabled: false,
    desktop_browser_url: "",
    desktop_browser_auth_token: "",
    config_path: path.join(root, "state", "runtime-config.json"),
    loaded_from_file: false
  });
});

test("runRuntimeConfigCli updates runtime config and returns status payloads", async () => {
  const root = makeTempDir("hb-runtime-config-cli-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");

  let stdout = "";
  let stderr = "";
  let exitCode = await runRuntimeConfigCli(
    [
      "update",
      "--request-base64",
      Buffer.from(
        JSON.stringify({
          auth_token: "token-1",
          user_id: "user-1",
          sandbox_id: "sandbox-1",
          model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
          default_model: "gpt-5.4",
          desktop_browser_enabled: true,
          desktop_browser_url: "http://127.0.0.1:8787/api/v1/browser"
        }),
        "utf8"
      ).toString("base64")
    ],
    {
      io: {
        stdout: { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WritableStream,
        stderr: { write(chunk: string) { stderr += chunk; return true; } } as unknown as NodeJS.WritableStream
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).user_id, "user-1");

  stdout = "";
  stderr = "";
  exitCode = await runRuntimeConfigCli(["status"], {
    io: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WritableStream,
      stderr: { write(chunk: string) { stderr += chunk; return true; } } as unknown as NodeJS.WritableStream
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    config_path: path.join(root, "state", "runtime-config.json"),
    loaded_from_file: true,
    auth_token_present: true,
    user_id: "user-1",
    sandbox_id: "sandbox-1",
    model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
    default_model: "gpt-5.4",
    subagent_model: null,
    runtime_mode: "oss",
    default_provider: "holaboss_model_proxy",
    holaboss_enabled: true,
    desktop_browser_enabled: true,
    desktop_browser_url: "http://127.0.0.1:8787/api/v1/browser"
  });
});
