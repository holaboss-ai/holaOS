import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  resolveSubagentExecutionModel,
  resolveSubagentExecutionProfile,
} from "./subagent-model.js";

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

test("subagent execution model prefers the configured runtime.subagents.model", () => {
  const root = makeTempDir("hb-subagent-model-configured-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
      subagents: {
        model: "anthropic_direct/claude-sonnet-4-6",
      },
    },
  });

  assert.equal(
    resolveSubagentExecutionModel(),
    "anthropic_direct/claude-sonnet-4-6",
  );
  assert.deepEqual(resolveSubagentExecutionProfile(), {
    model: "anthropic_direct/claude-sonnet-4-6",
    thinkingValue: "medium",
  });
});

test("subagent execution model falls back to the current selected composer model when unset", () => {
  const root = makeTempDir("hb-subagent-model-default-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_direct/gpt-5.4",
    },
  });

  assert.equal(
    resolveSubagentExecutionModel({
      selectedModel: "anthropic_direct/claude-sonnet-4-6",
    }),
    "anthropic_direct/claude-sonnet-4-6",
  );
  assert.deepEqual(
    resolveSubagentExecutionProfile({
      selectedModel: "anthropic_direct/claude-sonnet-4-6",
      selectedThinkingValue: "high",
    }),
    {
      model: "anthropic_direct/claude-sonnet-4-6",
      thinkingValue: "high",
    },
  );
});

test("subagent execution model falls back to the runtime default model when no selected composer model is available", () => {
  const root = makeTempDir("hb-subagent-model-runtime-default-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_direct/gpt-5.4",
    },
  });

  assert.equal(resolveSubagentExecutionModel(), "openai_direct/gpt-5.4");
  assert.deepEqual(resolveSubagentExecutionProfile(), {
    model: "openai_direct/gpt-5.4",
    thinkingValue: "medium",
  });
});

test("configured subagent model takes precedence over composer thinking and uses the model default", () => {
  const root = makeTempDir("hb-subagent-model-configured-thinking-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_direct/gpt-5.4",
      subagents: {
        model: "openai/gpt-5.5",
      },
    },
  });

  assert.deepEqual(
    resolveSubagentExecutionProfile({
      selectedModel: "anthropic_direct/claude-sonnet-4-6",
      selectedThinkingValue: "high",
    }),
    {
      model: "openai/gpt-5.5",
      thinkingValue: "medium",
    },
  );
});

test("cronjob follow-composer mode ignores the configured subagent model", () => {
  const root = makeTempDir("hb-subagent-model-ignore-configured-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_direct/gpt-5.4",
      subagents: {
        model: "anthropic_direct/claude-sonnet-4-6",
      },
    },
  });

  assert.equal(
    resolveSubagentExecutionModel({
      selectedModel: "openai_codex/gpt-5.4",
      ignoreConfiguredSubagentModel: true,
    }),
    "openai_codex/gpt-5.4",
  );
  assert.deepEqual(
    resolveSubagentExecutionProfile({
      selectedModel: "openai_codex/gpt-5.4",
      selectedThinkingValue: "xhigh",
      ignoreConfiguredSubagentModel: true,
    }),
    {
      model: "openai_codex/gpt-5.4",
      thinkingValue: "xhigh",
    },
  );
});
