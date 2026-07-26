import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createFindTool,
  DEFAULT_MAX_BYTES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureTool } from "../node_modules/@mariozechner/pi-coding-agent/dist/utils/tools-manager.js";
import { resolveToCwd } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import { truncateHead } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";

const FIND_DEFAULT_LIMIT = 200;
const FIND_MAX_LIMIT = 200;
const FIND_INTERNAL_LIMIT = 1000;
const FIND_DEFAULT_TIMEOUT_MS = 5000;
const FIND_MIN_TIMEOUT_MS = 500;
const FIND_MAX_TIMEOUT_MS = 60_000;

type FindToolParams = {
  paths?: unknown;
  pattern?: unknown;
  path?: unknown;
  hidden?: unknown;
  gitignore?: unknown;
  limit?: unknown;
  timeout?: unknown;
};

type ParsedFindPattern = {
  basePath: string;
  globPattern: string;
  hasGlob: boolean;
};

type FindCandidate =
  | { kind: "exact"; absolutePath: string }
  | { kind: "search"; searchPath: string; globPattern: string };

type FindEntry = {
  absolutePath: string;
  displayPath: string;
  mtimeMs: number;
};

function stripOuterDoubleQuotes(value: string): string {
  return value.startsWith("\"") && value.endsWith("\"") && value.length > 1
    ? value.slice(1, -1)
    : value;
}

function normalizePathLikeInput(value: string): string {
  return stripOuterDoubleQuotes(value.trim()).replace(/\\/g, "/");
}

function hasGlobPathChars(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function containsTopLevelComma(entry: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index];
    if (char === "\\" && index + 1 < entry.length) {
      index += 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }
    if (char === "," && braceDepth === 0) {
      return true;
    }
  }
  return false;
}

function validateFindPathInputs(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new Error("Provide at least one entry in `paths`.");
  }
  for (const entry of paths) {
    if (!entry) {
      throw new Error("Find paths must not be empty.");
    }
    if (containsTopLevelComma(entry)) {
      throw new Error(`paths is an array; pass [\"a\", \"b\"] not [\"a,b\"] (got ${JSON.stringify(entry)})`);
    }
  }
}

function parseFindPattern(pattern: string): ParsedFindPattern {
  const segments = pattern.split("/");
  let firstGlobIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (hasGlobPathChars(segments[index] ?? "")) {
      firstGlobIndex = index;
      break;
    }
  }

  if (firstGlobIndex === -1) {
    return { basePath: pattern, globPattern: "**/*", hasGlob: false };
  }

  if (firstGlobIndex === 0) {
    const needsRecursive = !pattern.startsWith("**/");
    return {
      basePath: ".",
      globPattern: needsRecursive ? `**/${pattern}` : pattern,
      hasGlob: true,
    };
  }

  return {
    basePath: segments.slice(0, firstGlobIndex).join("/"),
    globPattern: segments.slice(firstGlobIndex).join("/"),
    hasGlob: true,
  };
}

function formatDisplayPath(cwd: string, absolutePath: string, isDirectory: boolean): string {
  const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
  const displayPath = relativePath === "" ? "." : (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    ? relativePath
    : absolutePath.split(path.sep).join("/");
  if (isDirectory && displayPath !== "." && !displayPath.endsWith("/")) {
    return `${displayPath}/`;
  }
  return displayPath;
}

function formatFindGroupedOutput(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const groups = new Map<string, string[]>();
  for (const entry of paths) {
    const hasTrailingSlash = entry.endsWith("/");
    const trimmed = hasTrailingSlash ? entry.slice(0, -1) : entry;
    const slash = trimmed.lastIndexOf("/");
    const directory = slash === -1 ? "" : trimmed.slice(0, slash);
    const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);
    const label = hasTrailingSlash ? `${base}/` : base;
    const bucket = groups.get(directory) ?? [];
    bucket.push(label);
    groups.set(directory, bucket);
  }

  const lines: string[] = [];
  for (const [directory, entries] of groups) {
    if (directory.length === 0) {
      lines.push(entries.join("\n"));
      continue;
    }
    lines.push(`# ${directory}/\n${entries.join("\n")}`);
  }
  return lines.join("\n\n");
}

function normalizeLegacyPatternInput(pattern: string, searchPath?: string): string {
  const normalizedPattern = normalizePathLikeInput(pattern);
  const normalizedPath = typeof searchPath === "string" ? normalizePathLikeInput(searchPath) : "";
  if (!normalizedPath || normalizedPath === ".") {
    return normalizedPattern;
  }
  const base = normalizedPath.replace(/\/+$/, "");
  const suffix = normalizedPattern.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function parseFindPathInputs(params: FindToolParams): string[] {
  const pathList = Array.isArray(params.paths)
    ? params.paths.filter((entry): entry is string => typeof entry === "string").map(normalizePathLikeInput)
    : [];
  if (pathList.length > 0) {
    return pathList;
  }
  const legacyPattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
  if (!legacyPattern) {
    throw new Error("Provide `paths` or the legacy `pattern` argument for find.");
  }
  return [normalizeLegacyPatternInput(legacyPattern, typeof params.path === "string" ? params.path : undefined)];
}

async function planFindCandidates(
  rawPaths: readonly string[],
  cwd: string,
): Promise<{ candidates: FindCandidate[]; missingPaths: string[] }> {
  const candidates: FindCandidate[] = [];
  const missingPaths: string[] = [];

  for (const rawPath of rawPaths) {
    const parsed = parseFindPattern(rawPath);
    const searchPath = resolveToCwd(parsed.basePath, cwd);

    try {
      const stats = await fs.stat(searchPath);
      if (!parsed.hasGlob && stats.isFile()) {
        candidates.push({ kind: "exact", absolutePath: searchPath });
        continue;
      }
      if (!stats.isDirectory()) {
        missingPaths.push(rawPath);
        continue;
      }
      candidates.push({
        kind: "search",
        searchPath,
        globPattern: parsed.globPattern,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        missingPaths.push(rawPath);
        continue;
      }
      throw error;
    }
  }

  return { candidates, missingPaths };
}

async function runFdFindJob(params: {
  fdPath: string;
  searchPath: string;
  globPattern: string;
  includeHidden: boolean;
  useGitignore: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ absolutePaths: string[]; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--glob",
      "--color=never",
      "--absolute-path",
      "--max-results",
      String(FIND_INTERNAL_LIMIT),
    ];
    if (params.includeHidden) {
      args.push("--hidden");
    }
    if (!params.useGitignore) {
      args.push("--no-ignore", "--no-ignore-parent", "--no-ignore-vcs");
    }
    // `--` terminates fd flag parsing so a glob pattern / search path that
    // begins with a dash can't be interpreted as an fd option.
    args.push("--", params.globPattern, params.searchPath);

    const child = spawn(params.fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const collectedPaths: string[] = [];
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let buffered = "";

    const flushBuffered = () => {
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "").trim();
        if (trimmed) {
          collectedPaths.push(trimmed);
        }
      }
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (!child.killed) {
        child.kill();
      }
    }, params.timeoutMs);

    const onAbort = () => {
      aborted = true;
      if (!child.killed) {
        child.kill();
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", onAbort);
    };

    params.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      buffered += chunk.toString();
      flushBuffered();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      cleanup();
      reject(new Error(`Failed to run fd: ${error.message}`));
    });

    child.on("close", (code) => {
      cleanup();
      if (buffered.trim()) {
        collectedPaths.push(buffered.replace(/\r$/, "").trim());
      }
      if (aborted && !timedOut) {
        reject(new Error("Operation aborted"));
        return;
      }
      if (timedOut) {
        resolve({ absolutePaths: collectedPaths, timedOut: true });
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `fd exited with code ${code}`));
        return;
      }
      resolve({ absolutePaths: collectedPaths, timedOut: false });
    });
  });
}

async function buildFindEntries(
  cwd: string,
  absolutePaths: readonly string[],
): Promise<FindEntry[]> {
  const canonicalCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const uniqueEntries = new Map<string, FindEntry>();
  for (const absolutePath of absolutePaths) {
    if (uniqueEntries.has(absolutePath)) {
      continue;
    }
    try {
      const stats = await fs.stat(absolutePath);
      const canonicalAbsolutePath = await fs.realpath(absolutePath).catch(() => path.resolve(absolutePath));
      uniqueEntries.set(absolutePath, {
        absolutePath,
        displayPath: formatDisplayPath(canonicalCwd, canonicalAbsolutePath, stats.isDirectory()),
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return [...uniqueEntries.values()].sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.displayPath.localeCompare(right.displayPath, undefined, { numeric: true, sensitivity: "base" })
  );
}

export function createPiFindToolDefinition(cwd: string) {
  const baseTool = createFindTool(cwd);
  const parameters = Type.Object(
    {
      paths: Type.Optional(Type.Array(Type.String({
        description: "File, directory, or glob including an optional search path.",
      }), {
        minItems: 1,
        description: "File, directory, or glob entries to search. Prefer this over the legacy pattern/path pair.",
      })),
      pattern: Type.Optional(Type.String({
        description: "Legacy compatibility alias for a single glob pattern.",
      })),
      path: Type.Optional(Type.String({
        description: "Legacy compatibility search root used with `pattern`.",
      })),
      hidden: Type.Optional(Type.Boolean({ description: "Include hidden files. Defaults to true." })),
      gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore files. Defaults to true." })),
      limit: Type.Optional(Type.Number({
        description: `Maximum results to return. Clamped to 1-${FIND_MAX_LIMIT}. Defaults to ${FIND_DEFAULT_LIMIT}.`,
      })),
      timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds. Returns partial results on timeout.",
      })),
    },
    { additionalProperties: false },
  );

  return {
    ...baseTool,
    parameters,
    description:
      `Find files and directories from one or more file, directory, or glob inputs. Use this tool for filename lookup instead of shelling out to \`find\`, \`fd\`, or \`ls\`. Results are grouped by directory, sorted by most recent modification time, and truncated to ${FIND_MAX_LIMIT} results or ${formatSize(DEFAULT_MAX_BYTES)} of output.`,
    promptSnippet: "Find files and directories from file, directory, or glob inputs",
    promptGuidelines: [
      "Use find for filename and path discovery instead of shelling out to `find`, `fd`, `locate`, or `ls`.",
      "Pass multiple search scopes as separate entries in `paths`, not one comma-joined string.",
      "Keep `gitignore` enabled unless you intentionally need ignored files such as `.env`, logs, or build artifacts.",
      "Use `timeout` only when searching very large scopes; if results are truncated, narrow the glob before raising limits.",
      "Use read or search after find to inspect file contents; do not treat path hits as content evidence.",
    ],
    async execute(_toolCallId: string, rawParams: FindToolParams, signal?: AbortSignal) {
      const params = rawParams as FindToolParams;
      const normalizedPaths = parseFindPathInputs(params);
      validateFindPathInputs(normalizedPaths);

      const requestedLimit = typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : FIND_DEFAULT_LIMIT;
      if (requestedLimit <= 0) {
        throw new Error("Limit must be a positive number.");
      }
      const effectiveLimit = Math.min(FIND_MAX_LIMIT, Math.max(1, requestedLimit));
      const requestedTimeoutMs = typeof params.timeout === "number" && Number.isFinite(params.timeout)
        ? Math.round(params.timeout * 1000)
        : FIND_DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(FIND_MAX_TIMEOUT_MS, Math.max(FIND_MIN_TIMEOUT_MS, requestedTimeoutMs));
      const includeHidden = params.hidden !== false;
      const useGitignore = params.gitignore !== false;

      const { candidates, missingPaths } = await planFindCandidates(normalizedPaths, cwd);
      if (candidates.length === 0) {
        throw new Error(`Path not found: ${missingPaths.join(", ")}`);
      }

      const fdPath = await ensureTool("fd", true);
      if (!fdPath) {
        throw new Error("fd is not available and could not be downloaded");
      }

      const deadline = Date.now() + timeoutMs;
      const absolutePaths: string[] = [];
      let timedOut = false;

      for (const candidate of candidates) {
        if (candidate.kind === "exact") {
          absolutePaths.push(candidate.absolutePath);
          continue;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }

        const result = await runFdFindJob({
          fdPath,
          searchPath: candidate.searchPath,
          globPattern: candidate.globPattern,
          includeHidden,
          useGitignore,
          timeoutMs: remainingMs,
          signal,
        });
        absolutePaths.push(...result.absolutePaths);
        if (result.timedOut) {
          timedOut = true;
          break;
        }
      }

      const entries = await buildFindEntries(cwd, absolutePaths);
      const limitedEntries = entries.slice(0, effectiveLimit);
      const groupedOutput = formatFindGroupedOutput(limitedEntries.map((entry) => entry.displayPath));
      const notes: string[] = [];

      if (entries.length === 0) {
        notes.push("No files found matching pattern");
      }
      if (timedOut) {
        const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
        notes.push(`find timed out after ${seconds}s; returning ${limitedEntries.length} partial matches`);
      }
      if (missingPaths.length > 0) {
        notes.push(`Skipped missing paths: ${missingPaths.join(", ")}`);
      }

      const baseOutput = groupedOutput.length > 0 ? groupedOutput : notes.shift() ?? "No files found matching pattern";
      const rawOutput = notes.length > 0 ? `${baseOutput}\n\n${notes.join("\n")}` : baseOutput;
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, unknown> = {
        file_count: limitedEntries.length,
      };
      const notices: string[] = [];

      if (entries.length > effectiveLimit) {
        notices.push(`${effectiveLimit} results limit reached`);
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (timedOut) {
        details.timed_out = true;
      }
      if (missingPaths.length > 0) {
        details.missing_paths = [...missingPaths];
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text" as const, text: output }],
        details,
      };
    },
  };
}
