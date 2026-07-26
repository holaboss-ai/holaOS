import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  FileRuntimeConfigService,
  resolveProductRuntimeConfig,
  runtimeConfigHeaders,
} from "./runtime-config.js";

const tempDirs: string[] = [];
const envNames = [
  "HB_SANDBOX_ROOT",
  "HOLABOSS_RUNTIME_CONFIG_PATH",
  "HOLABOSS_SANDBOX_AUTH_TOKEN",
  "HOLABOSS_USER_ID",
  "HOLABOSS_MODEL_PROXY_BASE_URL",
  "HOLABOSS_DEFAULT_MODEL",
  "HOLABOSS_DESKTOP_BROWSER_ENABLED",
  "HOLABOSS_DESKTOP_BROWSER_URL",
  "HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN",
  "HOLABOSS_DESKTOP_BROWSER_ALLOWED_DOMAINS",
  "HOLABOSS_DESKTOP_BROWSER_BLOCKED_ACTIONS",
  "HOLABOSS_DESKTOP_BROWSER_CONFIRM_ACTIONS",
  "HOLABOSS_DESKTOP_BROWSER_UNTRUSTED_BOUNDARIES",
  "SANDBOX_AGENT_HARNESS"
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

/**
 * Structural assertion for the `harnesses` inventory in /runtime/status.
 *
 * We don't pin the exact contents because CI runners may or may not
 * have `claude`/`codex` on PATH (which would flip per-entry
 * `available` + `detection`). The shape we guarantee:
 *   • at minimum the `pi` (Hola) entry, always available
 *   • every entry carries id + display_name + capabilities +
 *     available (bool) + detection (string) + supported_models (array)
 */
function assertHarnessesInventory(harnesses: unknown): void {
  assert.ok(Array.isArray(harnesses), "expected harnesses to be an array");
  const arr = harnesses as Array<Record<string, unknown>>;
  assert.ok(arr.length >= 1, "expected at least one harness in the inventory");
  const pi = arr.find((entry) => entry.id === "pi");
  assert.ok(pi, "expected the pi (Hola) harness to be present");
  assert.equal(pi.available, true);
  for (const entry of arr) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.display_name, "string");
    assert.equal(typeof entry.available, "boolean");
    assert.equal(typeof entry.detection, "string");
    assert.ok(
      Array.isArray(entry.supported_models),
      `expected supported_models on harness ${entry.id}`,
    );
    assert.ok(
      entry.capabilities && typeof entry.capabilities === "object",
      `expected capabilities object on harness ${entry.id}`,
    );
  }
}

test("file runtime config service updates runtime config without writing harness bootstrap config", async () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");
  process.env.SANDBOX_AGENT_HARNESS = "pi";

  let ensureCalls = 0;
  const service = new FileRuntimeConfigService({
    ensureSelectedHarnessReady: async () => {
      ensureCalls += 1;
    }
  });

  const updated = await service.updateConfig({
    auth_token: "token-1",
    user_id: "user-1",
    sandbox_id: "sandbox-1",
    model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
    default_model: "openai/gpt-5.4",
    desktop_browser_enabled: true,
    desktop_browser_url: "http://127.0.0.1:8787/api/v1/browser",
    desktop_browser_auth_token: "browser-token"
  });

  assert.deepEqual(updated, {
    config_path: path.join(root, "state", "runtime-config.json"),
    loaded_from_file: true,
    auth_token_present: true,
    user_id: "user-1",
    sandbox_id: "sandbox-1",
    model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
    default_model: "openai/gpt-5.4",
    subagent_model: null,
    runtime_mode: "oss",
    default_provider: "holaboss_model_proxy",
    holaboss_enabled: true,
    desktop_browser_enabled: true,
    desktop_browser_url: "http://127.0.0.1:8787/api/v1/browser"
  });
  assert.equal(ensureCalls, 0);

  const configDocument = JSON.parse(fs.readFileSync(path.join(root, "state", "runtime-config.json"), "utf8"));
  assert.equal(configDocument.runtime.sandbox_id, "sandbox-1");
  assert.equal(configDocument.runtime.default_model, "openai/gpt-5.4");
  assert.equal(configDocument.providers.holaboss_model_proxy.api_key, "token-1");
  assert.equal(configDocument.providers.holaboss_model_proxy.base_url, "https://runtime.example/api/v1/model-proxy");
  assert.equal(configDocument.integrations.holaboss.auth_token, "token-1");
  assert.equal(configDocument.integrations.holaboss.sandbox_id, "sandbox-1");
  assert.equal(configDocument.integrations.holaboss.user_id, "user-1");
  assert.equal(configDocument.capabilities.desktop_browser.url, "http://127.0.0.1:8787/api/v1/browser");
  assert.equal(configDocument.capabilities.desktop_browser.auth_token, "browser-token");
  assert.equal(fs.existsSync(path.join(root, "workspace")), false);
});

test("file runtime config service returns harness and browser readiness state", async () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");
  process.env.SANDBOX_AGENT_HARNESS = "pi";

  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "runtime-config.json"),
    `${JSON.stringify({
      runtime: {
        default_model: "openai/gpt-5.4",
        sandbox_id: "sandbox-1",
        default_provider: "holaboss_model_proxy"
      },
      providers: {
        holaboss_model_proxy: {
          kind: "openai_compatible",
          base_url: "https://runtime.example/api/v1/model-proxy",
          api_key: "token-1"
        }
      },
      integrations: {
        holaboss: {
          enabled: true,
          sandbox_id: "sandbox-1",
          user_id: "user-1",
          auth_token: "token-1"
        }
      },
      capabilities: {
        desktop_browser: {
          enabled: true,
          url: "http://127.0.0.1:8787/api/v1/browser"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const service = new FileRuntimeConfigService({
    fetchImpl: async () =>
      new Response("", {
        status: 200
      })
  });

  const status = await service.getStatus();

  // The status payload also carries a `harnesses: [{id, …}]` inventory
  // for the multi-harness picker; its membership is sensitive to the
  // CI runner's PATH (presence of `claude`, `codex`), so we strip it
  // and assert structurally below instead of pinning the exact set.
  const { harnesses, ...rest } = status as Record<string, unknown> & {
    harnesses?: unknown;
  };
  assert.deepEqual(rest, {
    harness: "pi",
    config_loaded: true,
    config_path: path.join(root, "state", "runtime-config.json"),
    backend_config_present: false,
    harness_ready: true,
    harness_state: "ready",
    browser_available: true,
    browser_state: "available",
    browser_url: "http://127.0.0.1:8787/api/v1/browser"
  });
  assertHarnessesInventory(harnesses);
});

test("file runtime config service treats pi harness as ready without extra harness bootstrap", async () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");
  process.env.SANDBOX_AGENT_HARNESS = "pi";

  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "runtime-config.json"),
    `${JSON.stringify({
      runtime: {
        default_model: "openai/gpt-5.4",
        sandbox_id: "sandbox-1",
        default_provider: "holaboss_model_proxy"
      },
      providers: {
        holaboss_model_proxy: {
          kind: "openai_compatible",
          base_url: "https://runtime.example/api/v1/model-proxy",
          api_key: "token-1"
        }
      },
      integrations: {
        holaboss: {
          enabled: true,
          sandbox_id: "sandbox-1",
          user_id: "user-1",
          auth_token: "token-1"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const service = new FileRuntimeConfigService();
  const status = await service.getStatus();

  const { harnesses, ...rest } = status as Record<string, unknown> & {
    harnesses?: unknown;
  };
  assert.deepEqual(rest, {
    harness: "pi",
    config_loaded: true,
    config_path: path.join(root, "state", "runtime-config.json"),
    backend_config_present: false,
    harness_ready: true,
    harness_state: "ready",
    browser_available: false,
    browser_state: "unavailable",
    browser_url: null
  });
  assertHarnessesInventory(harnesses);
});

test("runtime config prefers live embedded desktop browser capability env over stale file state", () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");
  process.env.HOLABOSS_DESKTOP_BROWSER_ENABLED = "true";
  process.env.HOLABOSS_DESKTOP_BROWSER_URL = "http://127.0.0.1:8787/api/v1/browser";
  process.env.HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN = "browser-token";

  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "runtime-config.json"),
    `${JSON.stringify({
      capabilities: {
        desktop_browser: {
          enabled: false
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const config = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false
  });

  assert.equal(config.desktopBrowserEnabled, true);
  assert.equal(config.desktopBrowserUrl, "http://127.0.0.1:8787/api/v1/browser");
  assert.equal(config.desktopBrowserAuthToken, "browser-token");
});

test("runtime config headers reuse the shared runtime config parser", () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");

  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "runtime-config.json"),
    `${JSON.stringify({
      runtime: {
        sandbox_id: "sandbox-1"
      },
      providers: {
        holaboss_model_proxy: {
          api_key: "token-1"
        }
      },
      integrations: {
        holaboss: {
          user_id: "user-1"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  assert.deepEqual(runtimeConfigHeaders({ requireAuth: true, requireUser: false }), {
    "X-API-Key": "token-1",
    "X-Holaboss-User-Id": "user-1",
    "X-Holaboss-Sandbox-Id": "sandbox-1"
  });
});

test("runtime config headers prefer the bound Holaboss sandbox id when runtime sandbox state is stale", () => {
  const root = makeTempDir("hb-runtime-config-");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(root, "state", "runtime-config.json");

  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "runtime-config.json"),
    `${JSON.stringify({
      runtime: {
        sandbox_id: "sandbox-stale"
      },
      providers: {
        holaboss_model_proxy: {
          api_key: "token-1"
        }
      },
      integrations: {
        holaboss: {
          auth_token: "token-1",
          user_id: "user-1",
          sandbox_id: "sandbox-bound"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  assert.deepEqual(runtimeConfigHeaders({ requireAuth: true, requireUser: false }), {
    "X-API-Key": "token-1",
    "X-Holaboss-User-Id": "user-1",
    "X-Holaboss-Sandbox-Id": "sandbox-bound"
  });
});
