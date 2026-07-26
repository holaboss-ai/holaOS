import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type WorkspaceMcpCatalogEntry = {
  tool_id: string;
  tool_name: string;
  module_path: string;
  symbol_name: string;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type WorkspaceMcpToolCallResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

type WorkspaceToolModule = Record<string, unknown> & {
  default?: Record<string, unknown>;
};

type WorkspaceToolBridgeErrorPayload = {
  code: string;
  path: string;
  message: string;
  hint?: string;
};

type LoadedWorkspaceTool = {
  definition: WorkspaceMcpToolDefinition;
  invoke: (args: Record<string, unknown>) => Promise<WorkspaceMcpToolCallResult>;
};

const NODE_WORKSPACE_TOOL_EXTENSIONS = [".mjs", ".js", ".cjs"] as const;

class WorkspaceToolBridgeError extends Error {
  readonly code: string;
  readonly path: string;
  readonly hint?: string;

  constructor(payload: WorkspaceToolBridgeErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.path = payload.path;
    this.hint = payload.hint;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function err(payload: WorkspaceToolBridgeErrorPayload): never {
  throw new WorkspaceToolBridgeError(payload);
}

function ensureWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    err({
      code: "workspace_tool_bridge_failed",
      path: "workspace_dir",
      message: `workspace directory does not exist: ${resolved}`
    });
  }
  if (!stat.isDirectory()) {
    err({
      code: "workspace_tool_bridge_failed",
      path: "workspace_dir",
      message: `workspace directory does not exist: ${resolved}`
    });
  }
  return resolved;
}

function validateModulePath(modulePath: string, toolId: string): string[] {
  if (!modulePath.startsWith("tools.")) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${toolId}.module_path`,
      message: "workspace local tool modules must be under 'tools.'"
    });
  }
  const parts = modulePath.split(".");
  if (!parts.every((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part))) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${toolId}.module_path`,
      message: `module path '${modulePath}' is not a valid dotted module`
    });
  }
  return parts;
}

function ensurePathInsideWorkspace(workspaceDir: string, candidatePath: string, toolId: string): string {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(candidatePath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${toolId}.module_path`,
      message: `module resolves outside workspace root`
    });
  }
  return resolvedPath;
}

function nodeWorkspaceToolCandidates(workspaceDir: string, modulePath: string, toolId: string): string[] {
  const parts = validateModulePath(modulePath, toolId);
  const basePath = ensurePathInsideWorkspace(workspaceDir, path.join(workspaceDir, ...parts), toolId);
  const candidates: string[] = [];
  for (const extension of NODE_WORKSPACE_TOOL_EXTENSIONS) {
    candidates.push(`${basePath}${extension}`);
  }
  for (const extension of NODE_WORKSPACE_TOOL_EXTENSIONS) {
    candidates.push(path.join(basePath, `index${extension}`));
  }
  return candidates.map((candidate) => ensurePathInsideWorkspace(workspaceDir, candidate, toolId));
}

function resolveNodeWorkspaceToolFile(workspaceDir: string, entry: WorkspaceMcpCatalogEntry): string | null {
  const workspaceRoot = ensureWorkspaceDir(workspaceDir);
  for (const candidate of nodeWorkspaceToolCandidates(workspaceRoot, entry.module_path, entry.tool_id)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  }
  return null;
}

function isCallableClass(value: unknown): boolean {
  return typeof value === "function" && /^class\s/.test(Function.prototype.toString.call(value));
}

function resolveToolSymbol(moduleNamespace: WorkspaceToolModule, entry: WorkspaceMcpCatalogEntry): unknown {
  const direct = moduleNamespace[entry.symbol_name];
  if (direct !== undefined) {
    return direct;
  }
  const fallback = moduleNamespace.default?.[entry.symbol_name];
  if (fallback !== undefined) {
    return fallback;
  }
  err({
    code: "workspace_mcp_catalog_entry_invalid",
    path: `mcp_registry.catalog.${entry.tool_id}.symbol`,
    message: `module '${entry.module_path}' has no symbol '${entry.symbol_name}'`
  });
}

function ensureCallableSymbol(symbol: unknown, entry: WorkspaceMcpCatalogEntry): ((...args: unknown[]) => unknown) & Record<string, unknown> {
  if (isCallableClass(symbol)) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${entry.tool_id}.symbol`,
      message: `symbol '${entry.module_path}.${entry.symbol_name}' must be callable, not a class`
    });
  }
  if (typeof symbol !== "function") {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${entry.tool_id}.symbol`,
      message: `symbol '${entry.module_path}.${entry.symbol_name}' is not callable`
    });
  }
  return symbol as ((...args: unknown[]) => unknown) & Record<string, unknown>;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toolDefinitionFromSymbol(symbol: Record<string, unknown>, entry: WorkspaceMcpCatalogEntry): WorkspaceMcpToolDefinition {
  return {
    name: entry.tool_name,
    title: typeof symbol.title === "string" ? symbol.title : undefined,
    description: typeof symbol.description === "string" ? symbol.description : undefined,
    inputSchema: metadataRecord(symbol.inputSchema) ?? { type: "object", additionalProperties: true },
    outputSchema: metadataRecord(symbol.outputSchema),
    annotations: metadataRecord(symbol.annotations),
    _meta: metadataRecord(symbol._meta)
  };
}

function textContent(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function callResultPayload(result: unknown): WorkspaceMcpToolCallResult {
  if (isRecord(result) && Array.isArray(result.content)) {
    return {
      content: result.content as Array<Record<string, unknown>>,
      structuredContent: isRecord(result.structuredContent) ? result.structuredContent : undefined,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      _meta: isRecord(result._meta) ? result._meta : undefined
    };
  }

  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return {
      content: result[0] as Array<Record<string, unknown>>,
      structuredContent: isRecord(result[1]) ? result[1] : undefined
    };
  }

  if (typeof result === "string") {
    return {
      content: [textContent(result)],
      structuredContent: { result }
    };
  }

  if (Array.isArray(result) && result.every((item) => typeof item === "string")) {
    return {
      content: result.map((item) => textContent(item)),
      structuredContent: { result }
    };
  }

  if (result === undefined) {
    return { content: [] };
  }

  if (result === null || typeof result === "number" || typeof result === "boolean") {
    return {
      content: [textContent(JSON.stringify(result))],
      structuredContent: { result }
    };
  }

  if (isRecord(result)) {
    return {
      content: [textContent(JSON.stringify(result, null, 2))],
      structuredContent: result
    };
  }

  if (Array.isArray(result)) {
    return {
      content: [textContent(JSON.stringify(result, null, 2))],
      structuredContent: { result }
    };
  }

  return {
    content: [textContent(String(result))],
    structuredContent: { result: String(result) }
  };
}

async function importWorkspaceToolModule(moduleFile: string, entry: WorkspaceMcpCatalogEntry): Promise<WorkspaceToolModule> {
  try {
    return (await import(`${pathToFileURL(moduleFile).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`)) as WorkspaceToolModule;
  } catch (error) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${entry.tool_id}`,
      message: `failed to import module '${entry.module_path}': ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

export function formatWorkspaceToolBridgeError(error: unknown): string {
  if (!(error instanceof WorkspaceToolBridgeError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const prefix = `${error.code} at ${error.path}: ${error.message}`;
  return error.hint ? `${prefix} (hint: ${error.hint})` : prefix;
}

export function decodeWorkspaceMcpCatalog(encoded: string): WorkspaceMcpCatalogEntry[] {
  let raw: string;
  let parsed: unknown;
  try {
    raw = Buffer.from(encoded, "base64").toString("utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    err({
      code: "workspace_tool_bridge_failed",
      path: "catalog_json_base64",
      message: `invalid bridge catalog payload: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  if (!Array.isArray(parsed)) {
    err({
      code: "workspace_tool_bridge_failed",
      path: "catalog_json_base64",
      message: "catalog payload must decode to a list"
    });
  }
  return parsed.map((item) => {
    if (!isRecord(item)) {
      err({
        code: "workspace_tool_bridge_failed",
        path: "catalog_json_base64",
        message: "catalog entries must be objects"
      });
    }
    return {
      tool_id: String(item.tool_id ?? ""),
      tool_name: String(item.tool_name ?? ""),
      module_path: String(item.module_path ?? ""),
      symbol_name: String(item.symbol_name ?? "")
    };
  });
}

export function isNodeWorkspaceToolEntry(workspaceDir: string, entry: WorkspaceMcpCatalogEntry): boolean {
  return resolveNodeWorkspaceToolFile(workspaceDir, entry) !== null;
}

export async function loadNodeWorkspaceTool(
  workspaceDir: string,
  entry: WorkspaceMcpCatalogEntry
): Promise<LoadedWorkspaceTool> {
  const workspaceRoot = ensureWorkspaceDir(workspaceDir);
  const moduleFile = resolveNodeWorkspaceToolFile(workspaceRoot, entry);
  if (!moduleFile) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: `mcp_registry.catalog.${entry.tool_id}.module_path`,
      message: `module '${entry.module_path}' could not be resolved under the workspace root`
    });
  }

  const moduleNamespace = await importWorkspaceToolModule(moduleFile, entry);
  const typedSymbol = ensureCallableSymbol(resolveToolSymbol(moduleNamespace, entry), entry);

  return {
    definition: toolDefinitionFromSymbol(typedSymbol, entry),
    invoke: async (args) => {
      try {
        return callResultPayload(await typedSymbol(args));
      } catch (error) {
        return {
          content: [textContent(error instanceof Error ? error.message : String(error))],
          isError: true
        };
      }
    }
  };
}
