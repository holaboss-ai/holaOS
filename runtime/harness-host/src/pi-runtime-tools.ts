import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import {
  createHarnessRuntimeToolDefinition,
  resolveHarnessRuntimeToolDefinitions,
  type HarnessRuntimeToolOptions,
  RUNTIME_AGENT_TOOL_IDS,
} from "../../harnesses/src/runtime-capability-tools.js";
import type { RuntimeAgentToolId } from "../../harnesses/src/runtime-agent-tools.js";

export type PiRuntimeToolOptions = HarnessRuntimeToolOptions;

export function createPiRuntimeToolDefinition(
  toolId: RuntimeAgentToolId,
  description: string,
  options: PiRuntimeToolOptions,
): ToolDefinition {
  return createHarnessRuntimeToolDefinition(toolId, description, options) as unknown as ToolDefinition;
}

export async function resolvePiRuntimeToolDefinitions(
  options: {
    runtimeApiBaseUrl?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    selectedModel?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ToolDefinition[]> {
  return (await resolveHarnessRuntimeToolDefinitions(options)) as unknown as ToolDefinition[];
}

export { RUNTIME_AGENT_TOOL_IDS };
