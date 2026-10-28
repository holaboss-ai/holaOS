import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { syncLocalModelProviders } from "./local-model-autodetect.js";
import type { LocalModelDiscoveryEntry } from "./local-model-discovery.js";
import { localModelAutoDetectEnabled, readLocalModelProviders } from "./runtime-config.js";

const tempDirs: string[] = [];
const envNames = ["HOLABOSS_RUNTIME_CONFIG_PATH", "HOLABOSS_LOCAL_MODEL_AUTODETECT"] as const;
const envSnapshot = new Map(envNames.map((name) => [name, process.env[name]]));

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

function useConfig(document: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-local-autodetect-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "runtime-config.json");
  fs.writeFileSync(configPath, JSON.stringify(document), "utf8");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  return configPath;
}

function lmstudio(models: string[]): LocalModelDiscoveryEntry {
  return {
    base_url: "http://127.0.0.1:1234/v1",
    engine: "lmstudio",
    models: models.map((id) => ({ id, context_window: 32768 })),
  };
}

test("a newly found server is registered and keeps the rest of the config", async () => {
  const configPath = useConfig({ providers: { holaboss_model_proxy: { kind: "holaboss_proxy" } }, runtime: { default_model: "x" } });
  const changed = await syncLocalModelProviders({ discover: async () => [lmstudio(["qwen/qwen3-8b"])] });
  assert.deepEqual(changed.map((provider) => provider.provider_id), ["local_lmstudio"]);
  const document = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(document.providers.holaboss_model_proxy);
  assert.equal(document.runtime.default_model, "x");
  assert.equal(document.models["local_lmstudio/qwen/qwen3-8b"].context_window, 32768);
});

test("an unchanged server is left alone and the config is not rewritten", async () => {
  const configPath = useConfig({});
  await syncLocalModelProviders({ discover: async () => [lmstudio(["a", "b"])] });
  const before = fs.statSync(configPath).mtimeMs;
  let registerCalls = 0;
  const changed = await syncLocalModelProviders({
    discover: async () => [lmstudio(["b", "a"])],
    register: () => {
      registerCalls += 1;
      throw new Error("should not register");
    },
  });
  assert.deepEqual(changed, []);
  assert.equal(registerCalls, 0);
  assert.equal(fs.statSync(configPath).mtimeMs, before);
});

test("a changed model list replaces the provider's models", async () => {
  useConfig({});
  await syncLocalModelProviders({ discover: async () => [lmstudio(["old-model"])] });
  await syncLocalModelProviders({ discover: async () => [lmstudio(["new-model"])] });
  const [provider] = readLocalModelProviders();
  assert.deepEqual(provider?.model_ids, ["new-model"]);
});

test("servers with no chat models and probe errors are skipped", async () => {
  useConfig({});
  const changed = await syncLocalModelProviders({
    discover: async () => [lmstudio([]), { base_url: "http://127.0.0.1:9/v1", error: "unreachable" }],
  });
  assert.deepEqual(changed, []);
  assert.deepEqual(readLocalModelProviders(), []);
});

test("auto-detect can be turned off in runtime-config.json or by env", async () => {
  useConfig({ local_models: { auto_detect: false } });
  assert.equal(localModelAutoDetectEnabled(), false);
  let discoverCalls = 0;
  const changed = await syncLocalModelProviders({
    discover: async () => {
      discoverCalls += 1;
      return [lmstudio(["a"])];
    },
  });
  assert.deepEqual(changed, []);
  assert.equal(discoverCalls, 0);

  useConfig({});
  assert.equal(localModelAutoDetectEnabled(), true);
  process.env.HOLABOSS_LOCAL_MODEL_AUTODETECT = "0";
  assert.equal(localModelAutoDetectEnabled(), false);
});
