import { HARNESS_DEFINITIONS, type HarnessHostPlugin } from "../../harnesses/src/index.js";
import {
  decodeHarnessHostClaudeCodeRequestBase64,
  decodeHarnessHostCodexRequestBase64,
  decodeHarnessHostPiRequestBase64,
} from "./contracts.js";
import { runClaudeCode } from "./claude-code.js";
import { runCodex } from "./codex.js";
import { runPi } from "./pi.js";

const HARNESS_HOST_IMPLEMENTATIONS = {
  pi: {
    decodeRequestBase64: (encoded: string) => decodeHarnessHostPiRequestBase64(encoded),
    run: async (request: unknown) => await runPi(request as Parameters<typeof runPi>[0]),
  },
  "claude-code": {
    decodeRequestBase64: (encoded: string) => decodeHarnessHostClaudeCodeRequestBase64(encoded),
    run: async (request: unknown) => await runClaudeCode(request as Parameters<typeof runClaudeCode>[0]),
  },
  codex: {
    decodeRequestBase64: (encoded: string) => decodeHarnessHostCodexRequestBase64(encoded),
    run: async (request: unknown) => await runCodex(request as Parameters<typeof runCodex>[0]),
  },
} as const;

const HARNESS_HOST_PLUGINS: readonly HarnessHostPlugin[] = HARNESS_DEFINITIONS.map((definition) => {
  const implementation = HARNESS_HOST_IMPLEMENTATIONS[definition.id as keyof typeof HARNESS_HOST_IMPLEMENTATIONS];
  if (!implementation) {
    throw new Error(`missing harness host implementation for ${definition.id}`);
  }
  return definition.bindHostPlugin(implementation);
});

function normalizeHarnessHostCommand(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function listHarnessHostPlugins(): readonly HarnessHostPlugin[] {
  return HARNESS_HOST_PLUGINS;
}

export function resolveHarnessHostPluginByCommand(command: unknown): HarnessHostPlugin | null {
  const normalized = normalizeHarnessHostCommand(command);
  if (!normalized) {
    return null;
  }
  return HARNESS_HOST_PLUGINS.find((plugin) => plugin.command === normalized) ?? null;
}

export function requireHarnessHostPluginByCommand(command: unknown): HarnessHostPlugin {
  const plugin = resolveHarnessHostPluginByCommand(command);
  if (plugin) {
    return plugin;
  }
  // Graceful fallback for legacy invocations still targeting a harness that has
  // been removed from the registry:
  // run the built-in pi harness instead of crashing with `unsupported command`.
  const fallback = HARNESS_HOST_PLUGINS.find((entry) => entry.id === "pi");
  if (!fallback) {
    throw new Error(`unsupported command: ${normalizeHarnessHostCommand(command)}`);
  }
  const requested = normalizeHarnessHostCommand(command);
  if (requested !== fallback.command) {
    console.warn(
      `[harness-host] command "${requested}" is not registered; falling back to "${fallback.command}"`,
    );
  }
  return fallback;
}
