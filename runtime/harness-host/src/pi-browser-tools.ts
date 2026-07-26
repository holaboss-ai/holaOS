import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import {
  createHarnessDesktopBrowserToolDefinition,
  createHarnessDesktopBrowserToolDefinitions,
  resolveHarnessDesktopBrowserToolDefinitions,
  type HarnessDesktopBrowserToolOptions,
} from "../../harnesses/src/browser-capability-tools.js";
import type { DesktopBrowserToolDefinition } from "../../harnesses/src/desktop-browser-tools.js";

export type PiDesktopBrowserToolOptions = HarnessDesktopBrowserToolOptions;

export function createPiDesktopBrowserToolDefinition(
  definition: DesktopBrowserToolDefinition,
  options: PiDesktopBrowserToolOptions,
): ToolDefinition {
  return createHarnessDesktopBrowserToolDefinition(definition, options) as unknown as ToolDefinition;
}

export function createPiDesktopBrowserToolDefinitions(
  options: PiDesktopBrowserToolOptions,
): ToolDefinition[] {
  return createHarnessDesktopBrowserToolDefinitions(options) as unknown as ToolDefinition[];
}

export async function resolvePiDesktopBrowserToolDefinitions(
  options: {
    runtimeApiBaseUrl?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    space?: "agent" | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ToolDefinition[]> {
  return (await resolveHarnessDesktopBrowserToolDefinitions(options)) as unknown as ToolDefinition[];
}
