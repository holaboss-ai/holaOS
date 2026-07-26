import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import {
  createHarnessNativeWebSearchToolDefinition,
  resolveHarnessNativeWebSearchToolDefinitions,
  type HarnessNativeWebSearchToolOptions,
} from "../../harnesses/src/native-web-search.js";
import {
  type NativeWebSearchToolId,
} from "../../harnesses/src/native-web-search-tools.js";

export type PiWebSearchToolOptions = HarnessNativeWebSearchToolOptions;

export function createPiWebSearchToolDefinition(
  toolId: NativeWebSearchToolId,
  options: PiWebSearchToolOptions = {}
): ToolDefinition {
  return createHarnessNativeWebSearchToolDefinition(toolId, options) as unknown as ToolDefinition;
}

export async function resolvePiWebSearchToolDefinitions(
  options: PiWebSearchToolOptions = {}
): Promise<ToolDefinition[]> {
  return (await resolveHarnessNativeWebSearchToolDefinitions(options)) as unknown as ToolDefinition[];
}
