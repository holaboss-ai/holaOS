import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  createImageGenerationModelClient,
  resolveImageGenerationModelSelection,
} from "./image-generation-model.js";

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

test("image generation model selection honors explicit selected image models over runtime.image_generation", () => {
  const root = makeTempDir("hb-image-model-selected-");
  writeRuntimeConfig(root, {
    runtime: {
      image_generation: {
        provider: "openai_direct",
        model: "gpt-image-2",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
      },
    },
    models: {
      "openai_direct/gpt-image-1-mini": {
        provider_id: "openai_direct",
        model_id: "gpt-image-1-mini",
        capabilities: ["image_generation"],
      },
    },
  });

  const selection = resolveImageGenerationModelSelection({
    selectedModel: "openai_direct/gpt-image-1-mini",
    defaultProviderId: "openai_direct",
  });

  assert.deepEqual(selection, {
    providerId: "openai_direct",
    modelId: "gpt-image-1-mini",
    source: "selected",
  });
});

test("image generation model selection still prefers runtime.image_generation for chat models", () => {
  const root = makeTempDir("hb-image-model-selection-");
  writeRuntimeConfig(root, {
    runtime: {
      image_generation: {
        provider: "openai_direct",
        model: "gpt-image-2",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
      },
    },
    models: {
      "openai_direct/gpt-5.4": {
        provider_id: "openai_direct",
        model_id: "gpt-5.4",
        capabilities: ["chat"],
      },
    },
  });

  const selection = resolveImageGenerationModelSelection({
    selectedModel: "openai_direct/gpt-5.4",
    defaultProviderId: "openai_direct",
  });

  assert.deepEqual(selection, {
    providerId: "openai_direct",
    modelId: "gpt-image-2",
    source: "configured",
  });
});

test("image generation model selection disables explicit provider without a model", () => {
  const root = makeTempDir("hb-image-model-disabled-");
  writeRuntimeConfig(root, {
    runtime: {
      image_generation: {
        provider: "gemini_direct",
        model: null,
      },
    },
    providers: {
      gemini_direct: {
        kind: "openai_compatible",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api_key: "gemini-key",
      },
    },
  });

  const selection = resolveImageGenerationModelSelection({
    selectedModel: "gemini_direct/gemini-2.5-pro",
    defaultProviderId: "gemini_direct",
  });

  assert.deepEqual(selection, {
    providerId: "gemini_direct",
    modelId: null,
    source: "disabled",
  });
});

test("image generation model selection falls back to legacy provider image model fields", () => {
  const root = makeTempDir("hb-image-model-legacy-");
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
        image_model: "gpt-image-2",
      },
    },
  });

  const selection = resolveImageGenerationModelSelection({
    selectedModel: "openai_direct/gpt-5.4",
    defaultProviderId: "openai_direct",
  });

  assert.deepEqual(selection, {
    providerId: "openai_direct",
    modelId: "gpt-image-2",
    source: "configured",
  });
});

test("image generation model client resolves Gemini direct providers with native Google image calls", () => {
  const root = makeTempDir("hb-image-model-gemini-");
  writeRuntimeConfig(root, {
    runtime: {
      image_generation: {
        provider: "gemini_direct",
        model: "imagen-4.0-generate-001",
      },
    },
    providers: {
      gemini_direct: {
        kind: "openai_compatible",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api_key: "gemini-key",
      },
    },
  });

  const client = createImageGenerationModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "gemini_direct/gemini-2.5-pro",
    defaultProviderId: "gemini_direct",
  });

  assert.deepEqual(client, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gemini-key",
    defaultHeaders: null,
    modelId: "gemini-3.1-flash-image",
    apiStyle: "google_native",
  });
});

test("image generation model client resolves OpenRouter image providers with OpenRouter chat image calls", () => {
  const root = makeTempDir("hb-image-model-openrouter-");
  writeRuntimeConfig(root, {
    runtime: {
      image_generation: {
        provider: "openrouter_direct",
        model: "google/gemini-3.1-flash-image",
      },
    },
    providers: {
      openrouter_direct: {
        kind: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        api_key: "sk-or-test",
      },
    },
  });

  const client = createImageGenerationModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "openrouter_direct/openai/gpt-5.4",
    defaultProviderId: "openrouter_direct",
  });

  assert.deepEqual(client, {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-test",
    defaultHeaders: {
      "HTTP-Referer": "https://holaboss.ai",
      "X-OpenRouter-Title": "holaOS",
      "X-OpenRouter-Categories": "personal-agent,general-chat",
    },
    modelId: "google/gemini-3.1-flash-image",
    apiStyle: "openrouter_image",
  });
});

test("image generation model client routes managed Holaboss Gemini image models to the Google proxy path", () => {
  const root = makeTempDir("hb-image-model-holaboss-google-");
  writeRuntimeConfig(root, {
    // A resolved user is required on the proxy path (see the fail-closed test
    // below); include one so this routing test exercises a valid client.
    user_id: "user-xyz",
    providers: {
      holaboss_model_proxy: {
        kind: "holaboss_proxy",
        base_url: "https://runtime.example/api/v1/model-proxy",
        api_key: "hb-token",
      },
    },
    models: {
      "holaboss_model_proxy/gemini-3.1-flash-image": {
        provider_id: "holaboss_model_proxy",
        model_id: "gemini-3.1-flash-image",
        capabilities: ["image_generation"],
      },
    },
  });

  const client = createImageGenerationModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "holaboss_model_proxy/gemini-3.1-flash-image",
    defaultProviderId: "holaboss_model_proxy",
  });

  assert.deepEqual(client, {
    baseUrl: "https://runtime.example/api/v1/model-proxy/google/v1",
    apiKey: "hb-token",
    defaultHeaders: {
      "X-Holaboss-User-Id": "user-xyz",
      // Added so desktop image spend is attributed in the usage log's Entity
      // column; without it that column is blank.
      "X-Holaboss-Requester-Id": "desktop:user-xyz",
    },
    modelId: "gemini-3.1-flash-image",
    apiStyle: "openai_compatible",
  });
});

test("image generation model client attaches metering identity headers for the Holaboss proxy", () => {
  const root = makeTempDir("hb-image-model-holaboss-metering-");
  writeRuntimeConfig(root, {
    user_id: "user-xyz",
    sandbox_id: "sbx-1",
    providers: {
      holaboss_model_proxy: {
        kind: "holaboss_proxy",
        base_url: "https://runtime.example/api/v1/model-proxy",
        api_key: "hb-token",
      },
    },
    models: {
      "holaboss_model_proxy/gemini-3.1-flash-image": {
        provider_id: "holaboss_model_proxy",
        model_id: "gemini-3.1-flash-image",
        capabilities: ["image_generation"],
      },
    },
  });

  const client = createImageGenerationModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "holaboss_model_proxy/gemini-3.1-flash-image",
    defaultProviderId: "holaboss_model_proxy",
  });

  // Without these the backend meters nothing (submit_usage no-ops on an empty user id).
  assert.equal(client?.defaultHeaders?.["X-Holaboss-User-Id"], "user-xyz");
  assert.equal(client?.defaultHeaders?.["X-Holaboss-Sandbox-Id"], "sbx-1");
});

test("image generation model client fails closed for the Holaboss proxy when no user is resolved", () => {
  const root = makeTempDir("hb-image-model-holaboss-no-user-");
  // Same as the metering config above, but with no user_id. The backend now rejects
  // OpenRouter-bound proxy calls without X-Holaboss-User-Id (unattributed + unmetered),
  // so we must skip image generation rather than build a doomed request.
  writeRuntimeConfig(root, {
    sandbox_id: "sbx-1",
    providers: {
      holaboss_model_proxy: {
        kind: "holaboss_proxy",
        base_url: "https://runtime.example/api/v1/model-proxy",
        api_key: "hb-token",
      },
    },
    models: {
      "holaboss_model_proxy/gemini-3.1-flash-image": {
        provider_id: "holaboss_model_proxy",
        model_id: "gemini-3.1-flash-image",
        capabilities: ["image_generation"],
      },
    },
  });

  const client = createImageGenerationModelClient({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    selectedModel: "holaboss_model_proxy/gemini-3.1-flash-image",
    defaultProviderId: "holaboss_model_proxy",
  });

  assert.equal(client, null);
});
