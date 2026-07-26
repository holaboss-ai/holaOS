import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  createBackgroundTaskMemoryModelClient,
  defaultBackgroundTaskModelForProvider,
  resolveBackgroundTaskModelSelection,
} from "./background-task-model.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRuntimeConfig(root: string, document: Record<string, unknown>): void {
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
}

test("background task model selection prefers explicit runtime.background_tasks settings", () => {
  const root = makeTempDir("hb-background-model-selection-");
  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-5.3-codex",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
      },
    },
  });

  const selection = resolveBackgroundTaskModelSelection({
    selectedModel: "openai_direct/gpt-5.4",
    defaultProviderId: "openai_direct",
  });

  assert.deepEqual(selection, {
    providerId: "openai_direct",
    modelId: "gpt-5.3-codex",
    source: "configured",
  });
});

test("background task model selection disables explicit background provider without a model", () => {
  const root = makeTempDir("hb-background-model-ollama-");
  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "ollama_direct",
        model: null,
      },
    },
    providers: {
      ollama_direct: {
        kind: "openai_compatible",
        base_url: "http://localhost:11434/v1",
        api_key: "ollama",
      },
    },
  });

  const selection = resolveBackgroundTaskModelSelection({
    selectedModel: "ollama_direct/qwen3:8b",
    defaultProviderId: "ollama_direct",
  });

  assert.deepEqual(selection, {
    providerId: "ollama_direct",
    modelId: null,
    source: "disabled",
  });
});

test("background task model selection falls back to legacy provider background model fields", () => {
  const root = makeTempDir("hb-background-model-legacy-");
  writeRuntimeConfig(root, {
    runtime: {
      default_provider: "openai_direct",
      default_model: "openai_direct/gpt-5.4",
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
        background_model: "gpt-5.3-codex",
      },
    },
  });

  const selection = resolveBackgroundTaskModelSelection({
    selectedModel: "openai_direct/gpt-5.4",
    defaultProviderId: "openai_direct",
  });

  assert.deepEqual(selection, {
    providerId: "openai_direct",
    modelId: "gpt-5.3-codex",
    source: "configured",
  });
});

test("background task default model suggestions use GPT-5.4 for managed and direct OpenAI providers", () => {
  assert.equal(defaultBackgroundTaskModelForProvider("holaboss_model_proxy"), "gpt-5.4");
  assert.equal(defaultBackgroundTaskModelForProvider("openai_direct"), "gpt-5.4");
  assert.equal(defaultBackgroundTaskModelForProvider("openrouter_direct"), "openai/gpt-5.4");
});

test("background task model client resolves Anthropic direct providers with anthropic-native calls", () => {
  const root = makeTempDir("hb-background-model-anthropic-");
  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "anthropic_direct",
        model: "claude-sonnet-4-6",
      },
    },
    providers: {
      anthropic_direct: {
        kind: "anthropic_native",
        base_url: "https://api.anthropic.com",
        api_key: "sk-ant-test",
      },
    },
  });

  const client = createBackgroundTaskMemoryModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "anthropic_direct/claude-opus-4-6",
    defaultProviderId: "anthropic_direct",
  });

  assert.deepEqual(client, {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    defaultHeaders: null,
    modelId: "claude-sonnet-4-6",
    apiStyle: "anthropic_native",
  });
});
