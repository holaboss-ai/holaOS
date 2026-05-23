import fs from "node:fs";
import path from "node:path";
import type { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { rebuildAllIntegrationTrees } from "./integration-memory.js";
import { rebuildAllInteractionTrees } from "./interaction-memory.js";
import {
  globalMemoryDirForWorkspaceRoot,
  migrateLegacyWorkspaceMemoryIfNeeded,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import { visibleIntegrationTreesForWorkspace } from "./workspace-integration-visibility.js";

const MEMORY_BACKEND_ENV = "MEMORY_BACKEND";
const MEMORY_ROOT_DIR_ENV = "MEMORY_ROOT_DIR";
const MEMORY_ALLOWED_PATHS_MESSAGE =
  "allowed memory paths: MEMORY.md, workspace/<workspace_id>/*, preference/*, identity/*";

type StringMap = Record<string, unknown>;

export interface MemoryServiceLike {
  search(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  get(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  upsert(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  sync(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class MemoryServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type ResolvedMemoryBackend = {
  requestedProvider: string | null;
  fallbackReason: string | null;
};

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryServiceError(400, `${fieldName} is required`);
  }
  return value.trim();
}

function optionalInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function optionalNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function optionalBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function normalizeRelPath(value: string): string {
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw) {
    throw new MemoryServiceError(400, "path is required");
  }
  if (raw.startsWith("/")) {
    throw new MemoryServiceError(400, "absolute paths are not allowed");
  }
  const parts = raw.split("/");
  if (parts.includes("..")) {
    throw new MemoryServiceError(400, "parent path segments are not allowed");
  }
  return parts.filter((part) => part.length > 0).join("/");
}

function workspaceScopePrefix(workspaceId: string): string {
  const token = workspaceId.trim();
  if (!token) {
    throw new MemoryServiceError(400, "workspace_id is required");
  }
  const normalized = normalizeRelPath(`workspace/${token}`);
  const parts = normalized.split("/");
  if (parts.length !== 2 || parts[0] !== "workspace") {
    throw new MemoryServiceError(400, "workspace_id must be a single path token");
  }
  return `${normalized}/`;
}

function isMemoryPath(relPath: string, workspaceId: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (normalized === "MEMORY.md") {
    return true;
  }
  if (normalized.startsWith(workspaceScopePrefix(workspaceId))) {
    return true;
  }
  if (normalized.startsWith("preference/")) {
    return normalized.length > "preference/".length;
  }
  if (normalized.startsWith("identity/")) {
    return normalized.length > "identity/".length;
  }
  return false;
}

function workspaceDirForWorkspaceId(workspaceRoot: string, workspaceId: string): string {
  const token = workspaceId.trim();
  if (!token) {
    throw new MemoryServiceError(400, "workspace_id is required");
  }
  const workspaceDir = path.resolve(workspaceRoot, token);
  fs.mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile() && path.extname(root).toLowerCase() === ".md") {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function readLineWindow(text: string, fromLine?: number | null, lines?: number | null): string {
  if (fromLine == null && lines == null) {
    return text;
  }
  const split = text.split(/\r?\n/);
  const start = fromLine == null ? 1 : Math.max(1, fromLine);
  const maxLines = lines == null ? split.length : Math.max(0, lines);
  if (maxLines === 0) {
    return "";
  }
  return split.slice(start - 1, start - 1 + maxLines).join("\n");
}

function tokenizeQuery(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  if (!matches) {
    return [];
  }
  return matches.map((token) => token.toLowerCase());
}

function scoreText(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let score = 0;
  if (haystack.includes(normalizedQuery)) {
    score += 1;
  }
  const tokens = [...new Set(tokenizeQuery(normalizedQuery))];
  if (tokens.length === 0) {
    return score;
  }
  let hitCount = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hitCount += 1;
    }
  }
  return score + hitCount / Math.max(1, tokens.length);
}

function snippetForMatch(text: string, query: string, maxChars = 700): {
  snippet: string;
  startLine: number;
  endLine: number;
} {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return { snippet: "", startLine: 1, endLine: 1 };
  }
  const normalizedQuery = query.trim().toLowerCase();
  let targetIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizedQuery && lines[index].toLowerCase().includes(normalizedQuery)) {
      targetIndex = index;
      break;
    }
  }
  const startIndex = Math.max(0, targetIndex - 2);
  const endIndex = Math.min(lines.length, targetIndex + 3);
  let snippet = lines.slice(startIndex, endIndex).join("\n").trim();
  if (snippet.length > maxChars) {
    snippet = snippet.slice(0, maxChars).trimEnd();
  }
  return {
    snippet,
    startLine: startIndex + 1,
    endLine: Math.max(startIndex + 1, endIndex)
  };
}

function resolveMemoryBackend(): ResolvedMemoryBackend {
  const requested = (process.env[MEMORY_BACKEND_ENV] ?? "").trim().toLowerCase();
  if (!requested || requested === "builtin" || requested === "filesystem") {
    return {
      requestedProvider: null,
      fallbackReason: null
    };
  }
  return {
    requestedProvider: requested,
    fallbackReason: "ts runtime only supports the builtin filesystem memory backend"
  };
}

function workspaceMemoryFiles(workspaceMemoryRootDir: string): string[] {
  return listMarkdownFiles(workspaceMemoryRootDir);
}

function globalMemoryFiles(globalMemoryRootDir: string): string[] {
  const files: string[] = [];
  const rootEntrypoint = path.join(globalMemoryRootDir, "MEMORY.md");
  if (fs.existsSync(rootEntrypoint) && fs.statSync(rootEntrypoint).isFile()) {
    files.push(rootEntrypoint);
  }
  if (fs.existsSync(globalMemoryRootDir) && fs.statSync(globalMemoryRootDir).isDirectory()) {
    const entries = fs.readdirSync(globalMemoryRootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "workspace") {
        continue;
      }
      files.push(...listMarkdownFiles(path.join(globalMemoryRootDir, entry.name)));
    }
  }
  return files;
}

type ResolvedMemoryRoots = {
  workspaceDir: string;
  workspaceMemoryRootDir: string;
  globalMemoryRootDir: string;
  migratedWorkspaceMemory: boolean;
};

function resolveMemoryRoots(params: {
  workspaceRoot: string;
  workspaceId: string;
  resolveWorkspaceDir?: ((workspaceId: string) => string) | null;
}): ResolvedMemoryRoots {
  const workspaceDir = params.resolveWorkspaceDir?.(params.workspaceId)
    ?? workspaceDirForWorkspaceId(params.workspaceRoot, params.workspaceId);
  const migration = migrateLegacyWorkspaceMemoryIfNeeded({
    workspaceRoot: params.workspaceRoot,
    workspaceDir,
    workspaceId: params.workspaceId,
  });
  return {
    workspaceDir,
    workspaceMemoryRootDir: workspaceMemoryDir(workspaceDir),
    globalMemoryRootDir: globalMemoryDirForWorkspaceRoot(params.workspaceRoot),
    migratedWorkspaceMemory: migration.migrated,
  };
}

function workspaceScopedRelativePath(relPath: string, workspaceId: string): string | null {
  const prefix = workspaceScopePrefix(workspaceId);
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : null;
}

function resolveMemoryTargetPath(params: {
  normalizedPath: string;
  workspaceId: string;
  workspaceMemoryRootDir: string;
  globalMemoryRootDir: string;
}): { storageRoot: string; absolutePath: string } {
  const workspaceRelativePath = workspaceScopedRelativePath(params.normalizedPath, params.workspaceId);
  if (workspaceRelativePath !== null) {
    return {
      storageRoot: params.workspaceMemoryRootDir,
      absolutePath: path.resolve(params.workspaceMemoryRootDir, workspaceRelativePath),
    };
  }
  return {
    storageRoot: params.globalMemoryRootDir,
    absolutePath: path.resolve(params.globalMemoryRootDir, params.normalizedPath),
  };
}

function relativePosixPath(root: string, targetPath: string): string {
  return path.relative(root, targetPath).split(path.sep).join("/");
}

function statusPayload(params: {
  workspaceDir: string;
  workspaceId: string;
  workspaceMemoryRootDir: string;
  globalMemoryRootDir: string;
  migratedWorkspaceMemory?: boolean;
}): Record<string, unknown> {
  const backend = resolveMemoryBackend();
  const files = [
    ...workspaceMemoryFiles(params.workspaceMemoryRootDir),
    ...globalMemoryFiles(params.globalMemoryRootDir),
  ];
  const payload: Record<string, unknown> = {
    backend: "builtin",
    provider: "filesystem",
    model: null,
    requested_provider: backend.requestedProvider,
    files: files.length,
    chunks: files.length,
    dirty: null,
    workspace_dir: params.workspaceDir,
    db_path: null,
    extra_paths: [],
    sources: ["memory"],
    fallback: null,
    custom: {
      workspace_memory_root_dir: params.workspaceMemoryRootDir,
      global_memory_root_dir: params.globalMemoryRootDir,
      workspace_scope: workspaceScopePrefix(params.workspaceId).replace(/\/$/, ""),
      migrated_workspace_memory: Boolean(params.migratedWorkspaceMemory),
    }
  };
  if (backend.requestedProvider && backend.fallbackReason) {
    payload.fallback = {
      from: backend.requestedProvider,
      reason: backend.fallbackReason
    };
  }
  return payload;
}

export interface FilesystemMemoryServiceOptions {
  workspaceRoot: string;
  resolveWorkspaceDir?: ((workspaceId: string) => string) | null;
  store?: RuntimeStateStore | null;
}

export class FilesystemMemoryService implements MemoryServiceLike {
  readonly #workspaceRoot: string;
  readonly #resolveWorkspaceDir: ((workspaceId: string) => string) | null;
  readonly #store: RuntimeStateStore | null;

  constructor(options: FilesystemMemoryServiceOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#resolveWorkspaceDir = options.resolveWorkspaceDir ?? null;
    this.#store = options.store ?? null;
  }

  async search(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceId = requiredString(payload.workspace_id, "workspace_id");
    const query = requiredString(payload.query, "query");
    const maxResults = optionalInteger(payload.max_results, 6);
    const minScore = optionalNumber(payload.min_score, 0.0);
    const roots = resolveMemoryRoots({
      workspaceRoot: this.#workspaceRoot,
      workspaceId,
      resolveWorkspaceDir: this.#resolveWorkspaceDir,
    });
    const results: Array<Record<string, unknown>> = [];

    for (const filePath of workspaceMemoryFiles(roots.workspaceMemoryRootDir)) {
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const score = scoreText(query, text);
      if (score < minScore) {
        continue;
      }
      const snippet = snippetForMatch(text, query);
      results.push({
        path: path.posix.join(
          workspaceScopePrefix(workspaceId).replace(/\/$/, ""),
          relativePosixPath(roots.workspaceMemoryRootDir, filePath),
        ),
        start_line: snippet.startLine,
        end_line: snippet.endLine,
        score,
        snippet: snippet.snippet,
        source: "memory",
        citation: null
      });
    }

    for (const filePath of globalMemoryFiles(roots.globalMemoryRootDir)) {
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const score = scoreText(query, text);
      if (score < minScore) {
        continue;
      }
      const snippet = snippetForMatch(text, query);
      results.push({
        path: relativePosixPath(roots.globalMemoryRootDir, filePath),
        start_line: snippet.startLine,
        end_line: snippet.endLine,
        score,
        snippet: snippet.snippet,
        source: "memory",
        citation: null
      });
    }

    results.sort((left, right) => {
      const scoreDiff = Number(right.score) - Number(left.score);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      const pathDiff = String(left.path).localeCompare(String(right.path));
      if (pathDiff !== 0) {
        return pathDiff;
      }
      return Number(left.start_line) - Number(right.start_line);
    });

    return {
      results: results.slice(0, Math.max(1, maxResults)),
      status: await this.status({ workspace_id: workspaceId })
    };
  }

  async get(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceId = requiredString(payload.workspace_id, "workspace_id");
    const relPath = requiredString(payload.path, "path");
    const normalized = normalizeRelPath(relPath);
    if (!isMemoryPath(normalized, workspaceId)) {
      throw new MemoryServiceError(400, MEMORY_ALLOWED_PATHS_MESSAGE);
    }
    const roots = resolveMemoryRoots({
      workspaceRoot: this.#workspaceRoot,
      workspaceId,
      resolveWorkspaceDir: this.#resolveWorkspaceDir,
    });
    const resolvedTarget = resolveMemoryTargetPath({
      normalizedPath: normalized,
      workspaceId,
      workspaceMemoryRootDir: roots.workspaceMemoryRootDir,
      globalMemoryRootDir: roots.globalMemoryRootDir,
    });
    if (
      resolvedTarget.absolutePath !== resolvedTarget.storageRoot &&
      !resolvedTarget.absolutePath.startsWith(`${resolvedTarget.storageRoot}${path.sep}`)
    ) {
      throw new MemoryServiceError(400, "path escapes memory root");
    }
    if (!fs.existsSync(resolvedTarget.absolutePath) || !fs.statSync(resolvedTarget.absolutePath).isFile()) {
      return { path: normalized, text: "" };
    }
    const text = fs.readFileSync(resolvedTarget.absolutePath, "utf8");
    return {
      path: normalized,
      text: readLineWindow(
        text,
        payload.from_line == null ? null : optionalInteger(payload.from_line, 1),
        payload.lines == null ? null : optionalInteger(payload.lines, 0)
      )
    };
  }

  async upsert(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceId = requiredString(payload.workspace_id, "workspace_id");
    const relPath = requiredString(payload.path, "path");
    const normalized = normalizeRelPath(relPath);
    if (!isMemoryPath(normalized, workspaceId)) {
      throw new MemoryServiceError(400, MEMORY_ALLOWED_PATHS_MESSAGE);
    }
    const content = typeof payload.content === "string" ? payload.content : "";
    const append = optionalBoolean(payload.append, false);
    const roots = resolveMemoryRoots({
      workspaceRoot: this.#workspaceRoot,
      workspaceId,
      resolveWorkspaceDir: this.#resolveWorkspaceDir,
    });
    const resolvedTarget = resolveMemoryTargetPath({
      normalizedPath: normalized,
      workspaceId,
      workspaceMemoryRootDir: roots.workspaceMemoryRootDir,
      globalMemoryRootDir: roots.globalMemoryRootDir,
    });
    if (
      resolvedTarget.absolutePath !== resolvedTarget.storageRoot &&
      !resolvedTarget.absolutePath.startsWith(`${resolvedTarget.storageRoot}${path.sep}`)
    ) {
      throw new MemoryServiceError(400, "path escapes memory root");
    }
    fs.mkdirSync(path.dirname(resolvedTarget.absolutePath), { recursive: true });

    if (append && fs.existsSync(resolvedTarget.absolutePath)) {
      const existing = fs.readFileSync(resolvedTarget.absolutePath, "utf8");
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(resolvedTarget.absolutePath, `${existing}${prefix}${content}`, "utf8");
    } else {
      fs.writeFileSync(resolvedTarget.absolutePath, content, "utf8");
    }
    return {
      path: normalized,
      text: fs.readFileSync(resolvedTarget.absolutePath, "utf8")
    };
  }

  async status(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceId = requiredString(payload.workspace_id, "workspace_id");
    const roots = resolveMemoryRoots({
      workspaceRoot: this.#workspaceRoot,
      workspaceId,
      resolveWorkspaceDir: this.#resolveWorkspaceDir,
    });
    const status = statusPayload({
      workspaceDir: roots.workspaceDir,
      workspaceId,
      workspaceMemoryRootDir: roots.workspaceMemoryRootDir,
      globalMemoryRootDir: roots.globalMemoryRootDir,
      migratedWorkspaceMemory: roots.migratedWorkspaceMemory,
    });
    if (this.#store) {
      const store = this.#store;
      const entities = store.listInteractionEntities({
        workspaceId,
        status: "active",
        includeSystem: true,
        limit: 10_000,
        offset: 0,
      });
      const leaves = store.listInteractionLeaves({
        workspaceId,
        status: "active",
        limit: 10_000,
        offset: 0,
      });
      const summaries = store.listInteractionSummaryNodes({
        workspaceId,
        status: "active",
        limit: 10_000,
        offset: 0,
      });
      const interactionCanonicalNodes = store.listInteractionMemoryNodes({
        workspaceId,
        status: "active",
        limit: 10_000,
        offset: 0,
      });
      const interactionCanonicalEdges = entities.reduce(
        (count, entity) =>
          count + store.listInteractionMemoryChildren({
            workspaceId,
            parentNodeId: `tree:interaction:${entity.entityId}`,
          }).length,
        0,
      ) + interactionCanonicalNodes
        .filter((node) => node.nodeKind !== "leaf")
        .reduce(
          (count, node) =>
            count + store.listInteractionMemoryChildren({
              workspaceId,
              parentNodeId: node.nodeId,
            }).length,
          0,
        );
      const integrationTrees = visibleIntegrationTreesForWorkspace({
        store,
        workspaceId,
      });
      const integrationLeaves = integrationTrees.flatMap((tree) =>
        store.listIntegrationLeaves({
          treeId: tree.treeId,
          status: "active",
          limit: 10_000,
          offset: 0,
        }),
      );
      const integrationSummaries = integrationTrees.flatMap((tree) =>
        store.listIntegrationSummaryNodes({
          treeId: tree.treeId,
          status: "active",
          limit: 10_000,
          offset: 0,
        }),
      );
      const integrationCanonicalNodes = integrationTrees.flatMap((tree) =>
        store.listIntegrationMemoryNodes({
          treeId: tree.treeId,
          status: "active",
          limit: 10_000,
          offset: 0,
        }),
      );
      const integrationCanonicalEdges = integrationTrees.reduce(
        (count, tree) =>
          count + store.listIntegrationMemoryChildren({
            treeId: tree.treeId,
            parentNodeId: `tree:integration:${tree.treeId}`,
          }).length
          + store.listIntegrationMemoryNodes({
            treeId: tree.treeId,
            status: "active",
            limit: 10_000,
            offset: 0,
          })
            .filter((node) => node.nodeKind !== "leaf")
            .reduce(
              (subtotal, node) =>
                subtotal + store.listIntegrationMemoryChildren({
                  treeId: tree.treeId,
                  parentNodeId: node.nodeId,
                }).length,
              0,
            ),
        0,
      );
      status.provider = "interaction_tree";
      status.custom = {
        ...(status.custom as Record<string, unknown>),
        interaction_entities: entities.length,
        interaction_leaves: leaves.length,
        interaction_summary_nodes: summaries.length,
        interaction_canonical_nodes: interactionCanonicalNodes.length,
        interaction_canonical_edges: interactionCanonicalEdges,
        integration_trees: integrationTrees.length,
        integration_leaves: integrationLeaves.length,
        integration_summary_nodes: integrationSummaries.length,
        integration_canonical_nodes: integrationCanonicalNodes.length,
        integration_canonical_edges: integrationCanonicalEdges,
      };
    }
    return status;
  }

  async sync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspaceId = requiredString(payload.workspace_id, "workspace_id");
    const roots = resolveMemoryRoots({
      workspaceRoot: this.#workspaceRoot,
      workspaceId,
      resolveWorkspaceDir: this.#resolveWorkspaceDir,
    });
    let rebuilt: Record<string, unknown> | null = null;
    if (this.#store) {
      const store = this.#store;
      const interaction = await rebuildAllInteractionTrees({
        store,
        workspaceId,
      });
      const integration = await rebuildAllIntegrationTrees({
        store,
        workspaceId,
      });
      rebuilt = {
        interaction,
        integration,
      };
    }
    return {
      success: true,
      rebuilt,
      status: await this.status({ workspace_id: workspaceId })
    };
  }
}
